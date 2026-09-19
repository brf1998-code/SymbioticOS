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
  t("a kind not built yet is refused, and a bad name", /erp/.test(c.declared({ connections: { a: { kind: "erp" } } }).errors[0]) && /name/.test(c.declared({ connections: { "Bad Name": { kind: "printer", templates: ["x"] } } }).errors[0]));
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

// secrets (ready for the erp kind)
{
  process.env.SOS_CONNECTION_KEY = "test-key";
  const enc = c.encrypt({ user: "ro", password: "p@ss" });
  t("secrets round trip through aes-256-gcm and never sit in the clear", Buffer.isBuffer(enc) && !enc.toString("utf8").includes("p@ss") && c.decrypt(enc).password === "p@ss");
  delete process.env.SOS_CONNECTION_KEY;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
