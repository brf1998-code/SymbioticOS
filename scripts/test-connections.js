// Unit cases for src/connections.js, the pure parts. No database, no tokens:
// node scripts/test-connections.js
const c = require("../src/connections");

let pass = 0, fail = 0;
function t(name, cond, detail) { if (cond) { pass++; } else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); } }
const j = (x) => JSON.stringify(x);

// declarations
{
  t("no connections is fine", c.declared({}).ok && c.declared({ connections: null }).ok);
  t("a list is not a declaration", !c.declared({ connections: [] }).ok);
  const d = c.declared({ connections: { stock: { kind: "files", table: "inventory", key: ["item", "location"], columns: { qty: ["Qty", "On hand"], item: "Part" } }, labels: { kind: "printer", label: "Traveler labels", templates: ["traveler"] } } });
  t("files and printer declarations normalize", d.ok && d.connections.stock.key.join(",") === "item,location" && d.connections.stock.columns.item[0] === "Part" && d.connections.labels.templates[0] === "traveler" && d.connections.labels.label === "Traveler labels", j(d));
  t("a files connection needs a table and a key", !c.declared({ connections: { a: { kind: "files" } } }).ok && /table/.test(c.declared({ connections: { a: { kind: "files", key: "x" } } }).errors[0]) && /key/.test(c.declared({ connections: { a: { kind: "files", table: "t" } } }).errors[0]));
  t("a printer needs its label names", /templates/.test(c.declared({ connections: { a: { kind: "printer" } } }).errors[0]));
  t("a kind not built yet is refused, and a bad name", /kind must be one of files, printer, erp/.test(c.declared({ connections: { a: { kind: "mes" } } }).errors[0]) && /name/.test(c.declared({ connections: { "Bad Name": { kind: "printer", templates: ["x"] } } }).errors[0]));
  t("a table name that is not an identifier is refused", !c.declared({ connections: { a: { kind: "files", table: "inventory; drop", key: "id" } } }).ok);
}

// column matching
{
  const cols = [{ name: "id", type: "integer" }, { name: "item", type: "text", required: true }, { name: "location", type: "text", required: true }, { name: "qty", type: "integer" }];
  const m = c.matchColumns(["Item", "Where", "On Hand", "Notes", "ID"], cols, { location: ["Where"], qty: ["On hand"] });
  t("headers match loosely and through aliases; id is never loaded; the rest is ignored", m.mapping.map((x) => x.column).join(",") === "item,location,qty" && m.unmatched.join(",") === "Notes,ID", j(m));
  t("missing columns are reported with whether the table needs them", m.missing.length === 0 && c.matchColumns(["Item"], cols, {}).missing.some((x) => x.column === "location" && x.required));
  t("a header used twice matches once", c.matchColumns(["qty", "QTY"], cols, {}).mapping.length === 1);
}

// cell coercion
{
  t("whole numbers", c.coerce("1,250", "integer").value === 1250 && /whole number/.test(c.coerce("12.5", "integer").problem) && /whole number/.test(c.coerce("lots", "bigint").problem));
  t("numbers", c.coerce("$1,250.50", "numeric").value === 1250.5 && c.coerce("abc", "numeric").problem);
  t("yes and no", c.coerce("Yes", "boolean").value === true && c.coerce("0", "boolean").value === false && c.coerce("maybe", "boolean").problem);
  t("dates", c.coerce("2026-09-19", "date").value === "2026-09-19" && c.coerce("not a date", "date").problem && /T/.test(c.coerce("2026-09-19 10:00", "timestamp with time zone").value));
  t("empty is null, text is text", c.coerce("", "integer").value === null && c.coerce("  hi ", "text").value === "hi");
}

// parsing
{
  const p = c.parseAll(Buffer.from("Item,Qty\r\npaper,5\r\n\r\n,\r\nclip,\"1,000\"\r\n"), "text/csv", "x.csv");
  t("csv: header, rows, blank rows dropped, quoted commas kept", p.headers.join("|") === "Item|Qty" && p.rows.length === 2 && p.rows[1][1] === "1,000", j(p));
  const tsv = c.parseAll(Buffer.from("Item\tQty\npaper\t5\n"), "text/tab-separated-values", "x.tsv");
  t("tab separated works", tsv.headers.length === 2 && tsv.rows[0][0] === "paper");
}

// labels
{
  t("placeholders fill in and ZPL control characters in data are stripped", c.renderZpl("^XA^FD{{ job }}^FS^FD{{missing}}^FS^XZ", { job: "S1-01^XZ~JR" }) === "^XA^FDS1-01 XZ JR^FS^FD^FS^XZ", c.renderZpl("^XA^FD{{ job }}^FS^FD{{missing}}^FS^XZ", { job: "S1-01^XZ~JR" }));
  t("long values are clipped", c.zplEscape("x".repeat(500)).length === 200);
  t("the test label renders with company, time and a barcode", /Demo Co: test label/.test(c.renderZpl(c.TEST_LABEL, { company: "Demo Co", when: "now", code: "TEST1" })) && /\^BCN/.test(c.TEST_LABEL));
  t("printer settings are bounded with sane defaults", j(c.printerSettings(null)) === j({ dpmm: 8, width_in: 4, height_in: 2 }) && c.printerSettings({ settings: { dpmm: 99, width_in: -1, height_in: 3 } }).dpmm === 8 && c.printerSettings({ settings: { dpmm: 12, width_in: 4, height_in: 3 } }).height_in === 3);
}

// device cookie
{
  const req = { headers: { cookie: "a=1; sos_device=abcdefabcdefabcdefabcdef; sos=x" } };
  t("the device id is read from the cookie and must be 24 hex", c.deviceOf(req) === "abcdefabcdefabcdefabcdef" && c.deviceOf({ headers: { cookie: "sos_device=nope" } }) === null && c.deviceOf({ headers: {} }) === null);
  let set = null; const res = { append: (k, v) => { set = v; } }; let nexted = false;
  const r2 = { headers: { "x-forwarded-proto": "https" }, path: "/c/demo/m/paperline/station/1", protocol: "http" };
  c.deviceCookie(r2, res, () => { nexted = true; });
  t("a module page visit without one mints a secure device cookie and carries it on the same request", nexted && /^sos_device=[a-f0-9]{24}; Path=\/; Max-Age=\d+; SameSite=Lax; Secure$/.test(set) && c.deviceOf(r2), set);
  set = null; c.deviceCookie({ headers: {}, path: "/c/demo/", protocol: "http" }, res, () => {});
  t("the board does not get one", set === null);
}

// erp declarations and the pure parts of the query path
{
  const d = c.declared({ connections: { erp: { kind: "erp", label: "SAP", queries: { parts: { params: ["part_no"], fields: ["part_no", "on_hand"], about: "stock" }, orders: { fields: ["so"] } } } } });
  t("an erp declaration normalizes its queries", d.ok && d.connections.erp.queries.parts.params[0] === "part_no" && d.connections.erp.queries.orders.params.length === 0 && d.connections.erp.queries.parts.about === "stock", j(d));
  t("no queries, no fields, a bad query name are refused", /lists the named queries/.test(c.declared({ connections: { e: { kind: "erp" } } }).errors[0]) && /names no fields/.test(c.declared({ connections: { e: { kind: "erp", queries: { p: {} } } } }).errors[0]) && /not a plain name/.test(c.declared({ connections: { e: { kind: "erp", queries: { "Bad Q": { fields: ["a"] } } } } }).errors[0]));
  t("a module carrying the address or a login is refused", /never carries "base_url"/.test(c.declared({ connections: { e: { kind: "erp", queries: { p: { fields: ["a"] } }, base_url: "x" } } }).errors[0]) && /never carries "password"/.test(c.declared({ connections: { e: { kind: "erp", queries: { p: { fields: ["a"] } }, password: "x" } } }).errors[0]));
  t("fillPath: url encoding and OData quote doubling, unknown params become empty", c.fillPath("S?$filter=A eq '{a}'&b={b}&c={c}", { a: "x'y", b: "1 2" }) === "S?$filter=A eq 'x%27%27y'&b=1%202&c=");
  t("rowsOf: v2, v4, epicor, array, keyed, single entity", c.rowsOf("sap_odata", '{"d":{"results":[{"a":1}]}}').length === 1 && c.rowsOf("sap_odata", '{"value":[{"a":1},{"a":2}]}').length === 2 && c.rowsOf("epicor_baq", '{"value":[]}').length === 0 && c.rowsOf("json", '[{"a":1}]').length === 1 && c.rowsOf("json", '{"data":[{"a":1}]}').length === 1 && c.rowsOf("sap_odata", '{"d":{"a":1}}')[0].a === 1);
  let e = ""; try { c.rowsOf("json", "nope"); } catch (x) { e = x.message; }
  t("not JSON is named as such", /not answer with JSON/.test(e));
  e = ""; try { c.rowsOf("json", '{"ok":true,"other":1}'); } catch (x) { e = x.message; }
  t("a plain json object is one row for the json flavor", e === "" && c.rowsOf("json", '{"ok":true}')[0].ok === true);
  e = ""; try { c.rowsOf("sap_odata", '{"count":3}'); } catch (x) { e = x.message; }
  t("an object with no rows is refused for SAP", /not with a list of rows/.test(e), e);
  t("mapRows: dotted paths, nulls for what is missing, capped rows", j(c.mapRows([{ a: { b: "x" }, n: 0 }], ["p", "q", "r"], { p: "a.b", q: "n" })) === j([{ p: "x", q: 0, r: null }]) && c.mapRows(new Array(6000).fill({ a: 1 }), ["a"], { a: "a" }).length === 5000);
  const h = c.authHeaders({ flavor: "sap_odata", sap_client: "100" }, { user: "u", password: "p" });
  t("auth headers for SAP basic + client", h.authorization === "Basic dTpw" && h["sap-client"] === "100" && h.accept === "application/json");
  t("auth headers for Epicor api key, json bearer, custom header", c.authHeaders({ flavor: "epicor_baq" }, { api_key: "K" })["x-api-key"] === "K" && c.authHeaders({ flavor: "json" }, { api_key: "K" }).authorization === "Bearer K" && c.authHeaders({ flavor: "json", auth_header: "X-Token" }, { api_key: "K" })["x-token"] === "K");
  const st = c.erpSettings({ settings: { flavor: "sap_odata", base_url: "  https://x/ ", freshness_s: 0, queries: { parts: { path: "P", fields: { item: "Material", "bad name": "x" }, freshness_s: 30 } } } });
  t("erpSettings: trimmed url, default freshness, per-query freshness, bad field names dropped", st.base_url === "https://x/" && st.freshness_s === 300 && st.queries.parts.freshness_s === 30 && !("bad name" in st.queries.parts.fields) && st.transport === "direct" && st.verify_tls === true);
  const bad = c.erpSettings({ settings: { flavor: "oracle", transport: "pigeon", verify_tls: false } });
  t("unknown flavor and transport fall back; verify_tls can be turned off", bad.flavor === "sap_odata" && bad.transport === "direct" && bad.verify_tls === false);
}

// the field catalog: plain names, what a lookup returns, how a declared field resolves, next pages
{
  t("autoNames: the table prefix goes when what is left is unique, humps become underscores", j(c.autoNames(["JobHead_JobNum", "Part_PartDescription", "Calculated_QtyLeft", "MaterialDescription", "OrderHed_PONum"])) === j({ JobHead_JobNum: "job_num", Part_PartDescription: "part_description", Calculated_QtyLeft: "qty_left", MaterialDescription: "material_description", OrderHed_PONum: "po_num" }), j(c.autoNames(["JobHead_JobNum", "Part_PartDescription", "Calculated_QtyLeft", "MaterialDescription", "OrderHed_PONum"])));
  t("autoNames: a collision keeps the prefix, a leading digit gets a letter, names stay unique", j(c.autoNames(["JobHead_PartNum", "JobMtl_PartNum", "Calculated_2ndQty"])) === j({ JobHead_PartNum: "job_head_part_num", JobMtl_PartNum: "job_mtl_part_num", Calculated_2ndQty: "f_2nd_qty" }) && new Set(Object.values(c.autoNames(["A_x", "B_x", "x"]))).size === 3);
  const cols = c.columnsOf([{ JobHead_JobNum: "J1", JobHead_ProdQty: 10, Calculated_Pct: 0.5, JobHead_ReqDueDate: "2026-10-01T00:00:00", JobHead_JobReleased: true, Notes: null, RowIdent: "r", __metadata: {}, "@odata.etag": "x", SysRowID: "g", Nested: { a: 1 } }, { Notes: "late" }]);
  t("columnsOf: types from the first value seen, a later row fills an empty sample, bookkeeping columns are left out", cols.length === 7 && cols.find((x) => x.source === "JobHead_ProdQty").type === "whole number" && cols.find((x) => x.source === "Calculated_Pct").type === "number" && cols.find((x) => x.source === "JobHead_ReqDueDate").type === "date" && cols.find((x) => x.source === "JobHead_JobReleased").type === "yes/no" && cols.find((x) => x.source === "Notes").sample === "late" && cols.find((x) => x.source === "Nested").type === "group" && !cols.some((x) => /RowIdent|__metadata|odata|SysRowID/.test(x.source)), j(cols));
  t("columnsOf: SAP v2 dates read as dates", c.columnsOf([{ D: "/Date(1790000000000)/" }])[0].type === "date");
  const r = c.resolveFields(["a", "b", "job_num", "part_num", "due", "zz"], { fields: { a: "X_A" }, catalog: { b: { source: "Y_B" } } }, [{ source: "JobHead_JobNum" }, { source: "JobHead_PartNum" }, { source: "JobMtl_PartNum" }, { source: "JobHead_ReqDueDate" }]);
  t("resolveFields: hand map, catalog, a unique loose match; an ambiguous or too-short match is missing", j(r.how) === j({ a: "mapped", b: "catalog", job_num: "matched", part_num: "missing", due: "missing", zz: "missing" }) && r.map.job_num === "JobHead_JobNum" && r.map.zz === null, j(r));
  t("resolveFields: an exact name wins even when short", c.resolveFields(["qty"], {}, [{ source: "Qty" }, { source: "OrderQty" }]).map.qty === "Qty");
  t("nextLink: v2 and v4, and nothing when there is none or the body is not JSON", c.nextLink('{"d":{"results":[],"__next":"https://x/n?$skiptoken=2"}}') === "https://x/n?$skiptoken=2" && c.nextLink('{"value":[],"@odata.nextLink":"Parts?$skip=100"}') === "Parts?$skip=100" && c.nextLink('{"value":[]}') === null && c.nextLink("<html>") === null);
  const st = c.erpSettings({ settings: { queries: { q: { path: "p", catalog: { good_name: { source: " Src ", type: "text", about: "x" }, "Bad Name": { source: "y" }, empty: { source: "" } } } } } });
  t("erpSettings keeps a clean catalog: plain identifiers with a source", j(Object.keys(st.queries.q.catalog)) === j(["good_name"]) && st.queries.q.catalog.good_name.source === "Src");
  t("auditLine: nothing to say without an erp connection, a plain sentence either way otherwise", c.auditLine([]) === null && /every field/.test(c.auditLine([{ defined: true, missing: [], query: "jobs" }])) && /not available yet: due_date \(lookup jobs\)/.test(c.auditLine([{ defined: true, missing: ["due_date"], query: "jobs" }])) && /every field/.test(c.auditLine([{ defined: false, missing: ["x"], query: "jobs" }])));
}

// secrets (ready for the erp kind)
{
  process.env.SOS_CONNECTION_KEY = "test-key";
  const enc = c.encrypt({ user: "ro", password: "p@ss" });
  t("secrets round trip through aes-256-gcm and never sit in the clear", Buffer.isBuffer(enc) && !enc.toString("utf8").includes("p@ss") && c.decrypt(enc).password === "p@ss");
  delete process.env.SOS_CONNECTION_KEY;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
