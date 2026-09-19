// Connections: the outside world, owned by the platform. Product review of
// 2026-09-18, build order item 5, first push (docs/MODULE-CREATION.md,
// "Connections: the outside world").
//
// The rule: the platform owns every connection, the module only uses it. A
// module DECLARES what it needs in module.json ("connections": { name: {
// kind, label, ... } }); the platform keeps a row per declared connection in
// platform.connections (settings, status, what happened last), sets it up on
// the company's connections page (/c/<slug>/connections, manager), and hands
// the module a small fixed surface as ctx.connections.<name>. The build agent
// sees the surface and the name, never settings, secrets or devices.
//
// Kinds in this push:
//   files    a spreadsheet the company keeps, loaded into one of the module's
//            own tables from the connections page: the platform parses it,
//            matches the columns, shows a preview, then loads it (delete the
//            matching keys, insert the rows, one transaction, nothing partial).
//            Surface: status().
//   printer  Zebra label printing through Browser Print, Zebra's own small
//            program on the PC or tablet that prints. The module keeps its
//            labels as labels/<name>.zpl with {{field}} placeholders and calls
//            print(req, name, data); the platform renders the ZPL, queues a
//            job for the device that asked, and the platform's own helper
//            script on that device (public/assets/print-helper.js) sends it
//            to the printer chosen there. Module code never talks to a
//            printer. Surface: print(req, template, data), preview(template,
//            data), status().
//   erp      the company's ERP, MES or scheduling system, READ ONLY, through a
//            short list of named queries. The module declares the queries it
//            needs (name, params, the fields it expects); the admin defines on
//            the platform how each is fulfilled (base URL, flavor, a path
//            template per query, the ERP field behind each module field, test
//            params) and enters the read-only login, encrypted. The platform
//            runs the query, maps the fields, caches the rows with a freshness
//            per query, and returns stale rows with fresh=false when the ERP
//            is down. Flavors: sap_odata (SAP Gateway / S/4HANA OData v2 or
//            v4; SAP sets the pattern for NEWP), epicor_baq (Epicor Kinetic
//            BAQ REST), json (any read-only JSON endpoint). Transport: direct
//            (the instance calls the ERP over HTTPS); bridge (a plant-side
//            program carries the query, for an ERP the cloud cannot reach) is
//            designed in but not built: settings.transport="bridge" answers
//            "not available yet". Surface: query(name, params), status().
//
// Secrets: the ERP login lives in the secrets column, AES-256-GCM with a key
// that lives only in the platform's env (SOS_CONNECTION_KEY, else derived
// from SESSION_SECRET), never in the agent's allow-list, never in a page.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { q, pool } = require("./db");
const migrate = require("./migrate");
const attachments = require("./attachments");
const { record } = require("./record");

const KINDS = ["files", "printer", "erp"];
const ERP_FLAVORS = ["sap_odata", "epicor_baq", "json"];
const ERP_TRANSPORTS = ["direct", "bridge"];
const ERP_MAX_ROWS = 5000;
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const JOB_TTL_MS = 10 * 60e3;          // an unclaimed print job expires
const PREVIEW_TTL_MS = 10 * 60e3;
const LABELARY = process.env.SOS_LABELARY_URL || "https://api.labelary.com/v1/printers";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS platform.connections (
  id           SERIAL PRIMARY KEY,
  company      TEXT NOT NULL,
  module       TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  settings     JSONB NOT NULL DEFAULT '{}'::jsonb,
  secrets      BYTEA,
  status       TEXT NOT NULL DEFAULT 'not_connected',   -- not_connected | connected | error
  last_checked TIMESTAMPTZ,
  last_error   TEXT,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company, module, name)
);
CREATE TABLE IF NOT EXISTS platform.connection_uploads (
  id          SERIAL PRIMARY KEY,
  company     TEXT NOT NULL,
  module      TEXT NOT NULL,
  connection  TEXT NOT NULL,
  filename    TEXT,
  headers     JSONB NOT NULL DEFAULT '[]'::jsonb,
  rows        JSONB NOT NULL DEFAULT '[]'::jsonb,
  mapping     JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count   INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',          -- pending | loaded | discarded
  loaded_rows INTEGER,
  actor       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  loaded_at   TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS platform.print_jobs (
  id          SERIAL PRIMARY KEY,
  company     TEXT NOT NULL,
  module      TEXT NOT NULL,
  connection  TEXT NOT NULL,
  device      TEXT,
  template    TEXT NOT NULL,
  zpl         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',           -- queued | sent | done | failed | expired
  printer     TEXT,
  error       TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS print_jobs_device ON platform.print_jobs (company, device, status);
CREATE TABLE IF NOT EXISTS platform.erp_cache (
  company     TEXT NOT NULL,
  module      TEXT NOT NULL,
  connection  TEXT NOT NULL,
  query       TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  rows        JSONB NOT NULL DEFAULT '[]'::jsonb,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company, module, connection, query, params_hash)
);
`;
async function init() { await q(SCHEMA); }

// ---- secrets (unused by this push's kinds; ready for erp) ----------------------------
function key() {
  const raw = process.env.SOS_CONNECTION_KEY || process.env.SESSION_SECRET || "";
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw).digest();
}
function encrypt(obj) {
  const k = key(); if (!k) throw new Error("no SOS_CONNECTION_KEY or SESSION_SECRET: secrets cannot be stored");
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
function decrypt(buf) {
  const k = key(); if (!k || !buf) return null;
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", k, iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString("utf8"));
}

// ---- the declaration in module.json ----------------------------------------------------
// Returns { ok, errors, connections: { name: normalized } }. Used by the gate,
// the module validator and the mount.
function declared(manifest) {
  const errors = []; const out = {};
  const c = manifest && manifest.connections;
  if (c == null) return { ok: true, errors, connections: out };
  if (typeof c !== "object" || Array.isArray(c)) return { ok: false, errors: ['module.json "connections" must be an object of name: { kind, ... }'], connections: out };
  for (const [name, v] of Object.entries(c)) {
    if (!NAME.test(name)) { errors.push(`connection "${name}": the name is lowercase letters, digits and underscores, starting with a letter`); continue; }
    const d = v && typeof v === "object" ? v : {};
    if (!KINDS.includes(d.kind)) { errors.push(`connection "${name}": kind must be one of ${KINDS.join(", ")} (it is "${d.kind}")`); continue; }
    const n = { kind: d.kind, label: String(d.label || name).slice(0, 80) };
    if (d.kind === "files") {
      if (!IDENT.test(String(d.table || ""))) errors.push(`connection "${name}": a files connection names the module table it loads ("table")`);
      const keys = Array.isArray(d.key) ? d.key : d.key ? [d.key] : [];
      if (!keys.length || keys.some((k) => !IDENT.test(String(k)))) errors.push(`connection "${name}": "key" names the column (or columns) that identify a row, so a reload replaces rather than duplicates`);
      n.table = d.table; n.key = keys;
      n.columns = {};
      for (const [col, aliases] of Object.entries(d.columns || {})) if (IDENT.test(col)) n.columns[col] = (Array.isArray(aliases) ? aliases : [aliases]).map(String);
    }
    if (d.kind === "printer") {
      const t = Array.isArray(d.templates) ? d.templates : [];
      if (!t.length || t.some((x) => !/^[a-z][a-z0-9_-]{0,39}$/.test(String(x)))) errors.push(`connection "${name}": "templates" lists the label names, each kept as labels/<name>.zpl`);
      n.templates = t.map(String);
    }
    if (d.kind === "erp") {
      const qs = d.queries && typeof d.queries === "object" && !Array.isArray(d.queries) ? d.queries : null;
      if (!qs || !Object.keys(qs).length) errors.push(`connection "${name}": an erp connection lists the named queries it needs ("queries": { name: { params, fields, about } })`);
      n.queries = {};
      for (const [qn, qv] of Object.entries(qs || {})) {
        if (!NAME.test(qn)) { errors.push(`connection "${name}": query "${qn}" is not a plain name`); continue; }
        const qd = qv && typeof qv === "object" ? qv : {};
        const params = Array.isArray(qd.params) ? qd.params.map(String) : [];
        const fields = Array.isArray(qd.fields) ? qd.fields.map(String) : [];
        if (!fields.length) errors.push(`connection "${name}": query "${qn}" names no fields; say which fields the module expects back`);
        if (params.some((x) => !IDENT.test(x)) || fields.some((x) => !IDENT.test(x))) errors.push(`connection "${name}": query "${qn}": params and fields are plain identifiers`);
        n.queries[qn] = { params, fields, about: String(qd.about || "").slice(0, 200) };
      }
      for (const k of ["url", "base_url", "user", "password", "path", "host"]) if (d[k] != null) errors.push(`connection "${name}": a module never carries "${k}"; the admin enters where the ERP is and the login on the platform`);
    }
    out[name] = n;
  }
  return { ok: !errors.length, errors, connections: out };
}

// The rows a company's module has, one per declared connection, created on
// first sight. Settings and status survive redeploys; a connection no longer
// declared keeps its row (a rollback may want it) but is not listed.
async function ensureRows(company, mod, manifest) {
  const { connections } = declared(manifest);
  for (const [name, d] of Object.entries(connections)) {
    await q(`INSERT INTO platform.connections (company, module, name, kind) VALUES ($1,$2,$3,$4)
             ON CONFLICT (company, module, name) DO UPDATE SET kind=EXCLUDED.kind, updated_at=now()`, [company, mod, name, d.kind]);
  }
  return connections;
}
async function row(company, mod, name) {
  return (await q("SELECT * FROM platform.connections WHERE company=$1 AND module=$2 AND name=$3", [company, mod, name])).rows[0] || null;
}
async function setStatus(company, mod, name, status, { error, detail } = {}) {
  await q(`UPDATE platform.connections SET status=$4, last_checked=now(), last_error=$5, detail=detail || $6::jsonb, updated_at=now() WHERE company=$1 AND module=$2 AND name=$3`,
    [company, mod, name, status, error || null, JSON.stringify(detail || {})]);
}

// ---- files: a spreadsheet into one of the module's tables --------------------------------
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
async function tableColumns(schema, table) {
  const r = await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [schema, table]);
  return r.rows.map((c) => ({ name: c.column_name, type: c.data_type, required: c.is_nullable === "NO" && c.column_default == null }));
}
// A cell's text to the column's type. Returns { value } or { problem }.
function coerce(text, type) {
  const s = String(text == null ? "" : text).trim();
  if (s === "") return { value: null };
  if (/^(integer|smallint|bigint)$/.test(type)) { const n = Number(s.replace(/,/g, "")); return Number.isInteger(n) ? { value: n } : { problem: `"${s}" is not a whole number` }; }
  if (/^(numeric|real|double precision|decimal)$/.test(type)) { const n = Number(s.replace(/[,$]/g, "")); return Number.isFinite(n) ? { value: n } : { problem: `"${s}" is not a number` }; }
  if (type === "boolean") { const v = s.toLowerCase(); if (["true", "yes", "y", "1", "x"].includes(v)) return { value: true }; if (["false", "no", "n", "0", ""].includes(v)) return { value: false }; return { problem: `"${s}" is not yes or no` }; }
  if (/^date$/.test(type) || /timestamp/.test(type)) { const d = new Date(s); return Number.isNaN(d.getTime()) ? { problem: `"${s}" is not a date` } : { value: type === "date" ? d.toISOString().slice(0, 10) : d.toISOString() }; }
  if (type === "jsonb" || type === "json") { try { return { value: JSON.parse(s) }; } catch (e) { return { value: s }; } }
  return { value: s };
}
// Match spreadsheet headers to table columns: exact after normalizing, then
// the module's aliases. Returns { mapping: [{ header, index, column, type }], unmatched, missing }.
function matchColumns(headers, columns, aliases) {
  const byNorm = new Map(columns.map((c) => [norm(c.name), c]));
  for (const [col, list] of Object.entries(aliases || {})) for (const a of list) if (!byNorm.has(norm(a))) byNorm.set(norm(a), columns.find((c) => c.name === col));
  const mapping = []; const used = new Set(); const unmatched = [];
  headers.forEach((h, i) => {
    const c = byNorm.get(norm(h));
    if (c && !used.has(c.name) && !["id"].includes(c.name)) { mapping.push({ header: h, index: i, column: c.name, type: c.type }); used.add(c.name); }
    else if (String(h).trim()) unmatched.push(h);
  });
  const missing = columns.filter((c) => !used.has(c.name) && c.name !== "id").map((c) => ({ column: c.name, type: c.type, required: c.required }));
  return { mapping, unmatched, missing };
}
function parseAll(buf, mime, filename) {
  const ext = String(filename || "").toLowerCase().split(".").pop();
  const rows = (ext === "xlsx" || /spreadsheetml/.test(mime || "")) ? attachments.parseXlsx(buf) : attachments.parseCsv(buf.toString("utf8").replace(/^﻿/, ""));
  if (!rows.length) return { headers: [], rows: [] };
  const width = Math.max(...rows.map((r) => r.length));
  const all = rows.map((r) => { const c = r.slice(0, width).map((x) => String(x == null ? "" : x).trim()); while (c.length < width) c.push(""); return c; });
  const body = all.slice(1).filter((r) => r.some((x) => x !== ""));
  return { headers: all[0], rows: body };
}
// Step 1: parse, match, preview. Keeps the parsed rows so step 2 loads exactly
// what was previewed.
async function previewUpload(company, mod, name, { filename, mime, data }, actor) {
  const c = await row(company, mod, name);
  const live = await liveDeclaration(company, mod, name);
  if (!c || !live || live.kind !== "files") throw new Error("no such spreadsheet connection on this module");
  const buf = Buffer.from(String(data || ""), "base64");
  if (!buf.length) throw new Error("the file is empty");
  if (buf.length > attachments.MAX_BYTES) throw new Error(`the file is over ${Math.round(attachments.MAX_BYTES / 1048576)} MB`);
  if (attachments.kindOf(mime, filename) !== "sheet") throw new Error("that is not a spreadsheet: a csv or an xlsx file works");
  let parsed; try { parsed = parseAll(buf, mime, filename); } catch (e) { throw new Error(`could not read that spreadsheet (${e.message}); save it as csv and try again`); }
  if (!parsed.headers.length) throw new Error("the spreadsheet has no header row");
  const schema = migrate.liveSchema(company, mod);
  const columns = await tableColumns(schema, live.table);
  if (!columns.length) throw new Error(`the module has no table named ${live.table} yet`);
  const m = matchColumns(parsed.headers, columns, live.columns);
  const keyMissing = live.key.filter((k) => !m.mapping.some((x) => x.column === k));
  const problems = [];
  const sample = [];
  parsed.rows.forEach((r, i) => {
    const out = {};
    for (const x of m.mapping) { const v = coerce(r[x.index], x.type); if (v.problem) { if (problems.length < 25) problems.push({ row: i + 2, column: x.column, problem: v.problem }); } else out[x.column] = v.value; }
    for (const k of live.key) if (out[k] == null && !keyMissing.length && problems.length < 25 && !problems.some((p) => p.row === i + 2)) problems.push({ row: i + 2, column: k, problem: "the key is empty" });
    if (sample.length < 12) sample.push(out);
  });
  const requiredMissing = m.missing.filter((x) => x.required);
  const up = (await q(`INSERT INTO platform.connection_uploads (company, module, connection, filename, headers, rows, mapping, row_count, actor)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [company, mod, name, String(filename || "file").slice(0, 200), JSON.stringify(parsed.headers), JSON.stringify(parsed.rows), JSON.stringify(m.mapping), parsed.rows.length, actor || null])).rows[0];
  const blockers = [];
  if (keyMissing.length) blockers.push(`the spreadsheet has no column for ${keyMissing.join(", ")}, which identifies a row`);
  if (requiredMissing.length) blockers.push(`the table needs ${requiredMissing.map((x) => x.column).join(", ")} and the spreadsheet has no such column`);
  if (problems.length) blockers.push(`${problems.length}${problems.length >= 25 ? " or more" : ""} cell${problems.length === 1 ? "" : "s"} could not be read`);
  if (!parsed.rows.length) blockers.push("no rows under the header");
  return { upload_id: up.id, filename, table: live.table, key: live.key, row_count: parsed.rows.length, headers: parsed.headers, mapping: m.mapping, unmatched: m.unmatched, missing: m.missing, problems, sample, can_load: !blockers.length, blockers };
}
// Step 2: load. One transaction on the module's live tables: delete the rows
// whose key matches, insert every row. Anything unreadable stops the whole
// load, nothing half applies.
async function loadUpload(company, mod, name, uploadId, actor) {
  const live = await liveDeclaration(company, mod, name);
  if (!live || live.kind !== "files") throw new Error("no such spreadsheet connection on this module");
  const up = (await q("SELECT * FROM platform.connection_uploads WHERE id=$1 AND company=$2 AND module=$3 AND connection=$4", [uploadId, company, mod, name])).rows[0];
  if (!up) throw new Error("that upload is not here any more; upload the file again");
  if (up.status !== "pending") throw new Error(`that upload was already ${up.status}`);
  const schema = migrate.liveSchema(company, mod);
  const columns = await tableColumns(schema, live.table);
  const mapping = (up.mapping || []).filter((x) => columns.some((c) => c.name === x.column));
  const cols = mapping.map((x) => x.column);
  for (const k of live.key) if (!cols.includes(k)) throw new Error(`the upload has no column for ${k}`);
  const rows = []; const problems = [];
  (up.rows || []).forEach((r, i) => {
    const out = {};
    for (const x of mapping) { const v = coerce(r[x.index], x.type); if (v.problem) problems.push(`row ${i + 2}, ${x.column}: ${v.problem}`); else out[x.column] = v.value; }
    for (const k of live.key) if (out[k] == null) problems.push(`row ${i + 2}: ${k} is empty`);
    rows.push(out);
  });
  if (problems.length) throw new Error(`nothing loaded: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` and ${problems.length - 5} more` : ""}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    const T = `"${live.table}"`;
    const keyCols = live.key.map((k) => `"${k}"`);
    // delete the matching keys, in chunks
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const vals = []; const tuples = chunk.map((r) => `(${live.key.map((k) => { vals.push(r[k]); return `$${vals.length}`; }).join(",")})`);
      await client.query(`DELETE FROM ${T} WHERE (${keyCols.join(",")}) IN (${tuples.join(",")})`, vals);
    }
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const vals = []; const tuples = chunk.map((r) => `(${cols.map((c) => { vals.push(r[c] === undefined ? null : r[c]); return `$${vals.length}`; }).join(",")})`);
      await client.query(`INSERT INTO ${T} (${cols.map((c) => `"${c}"`).join(",")}) VALUES ${tuples.join(",")}`, vals);
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw new Error(`nothing loaded: ${e.message}`); }
  finally { await client.query("SET search_path TO public").catch(() => {}); client.release(); }
  await q("UPDATE platform.connection_uploads SET status='loaded', loaded_rows=$2, loaded_at=now(), rows='[]'::jsonb WHERE id=$1", [uploadId, rows.length]);
  await setStatus(company, mod, name, "connected", { detail: { last_file: up.filename, last_rows: rows.length, last_loaded_at: new Date().toISOString(), table: live.table } });
  await record("connection_loaded", { company, module: mod, actor: actor || "manager", after: `${up.filename}: ${rows.length} rows into ${live.table}`, detail: { connection: name, upload_id: uploadId, rows: rows.length, columns: cols } });
  return { loaded: rows.length, table: live.table, columns: cols };
}

// ---- printer: labels through Browser Print on the device -------------------------------
const zplEscape = (v) => String(v == null ? "" : v).replace(/[\^~\\]/g, " ").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
function renderZpl(template, data) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => zplEscape(data && data[k]));
}
const TEST_LABEL = `^XA^CF0,40^FO30,25^FDSymbiotic OS^FS^CF0,28^FO30,80^FD{{company}}: test label^FS^FO30,120^FD{{when}}^FS^BY2,2,60^FO30,170^BCN,60,Y,N,N^FD{{code}}^FS^XZ`;
function printerSettings(c) {
  const s = (c && c.settings) || {};
  return { dpmm: [6, 8, 12, 24].includes(Number(s.dpmm)) ? Number(s.dpmm) : 8, width_in: Number(s.width_in) > 0 ? Number(s.width_in) : 4, height_in: Number(s.height_in) > 0 ? Number(s.height_in) : 2 };
}
async function templateText(company, mod, version, name) {
  const registry = require("./registry");
  const file = path.join(registry.versionDir(company, mod, version), "labels", `${name}.zpl`);
  if (!fs.existsSync(file)) throw new Error(`no label named ${name} (labels/${name}.zpl) in this version`);
  return fs.readFileSync(file, "utf8");
}
async function queueJob({ company, mod, name, device, template, zpl, detail }) {
  const r = await q(`INSERT INTO platform.print_jobs (company, module, connection, device, template, zpl, detail) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [company, mod, name, device || null, template, zpl, JSON.stringify(detail || {})]);
  return r.rows[0];
}
// The device helper asks for the next job queued for this device (the
// sos_device cookie). Claiming marks it sent; stale queued jobs expire.
async function nextJob(company, device) {
  if (!device) return null;
  await q("UPDATE platform.print_jobs SET status='expired', updated_at=now() WHERE company=$1 AND status='queued' AND created_at < now() - interval '10 minutes'", [company]);
  // a job a device took but never reported on (the page closed mid-send)
  await q("UPDATE platform.print_jobs SET status='failed', error='the device took the label but never said whether it printed', updated_at=now() WHERE company=$1 AND status='sent' AND updated_at < now() - interval '10 minutes'", [company]);
  const r = await q(`UPDATE platform.print_jobs SET status='sent', updated_at=now() WHERE id = (
      SELECT id FROM platform.print_jobs WHERE company=$1 AND device=$2 AND status='queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, module, connection, template, zpl, detail`, [company, device]);
  return r.rows[0] || null;
}
async function finishJob(company, device, id, { ok, printer, error }) {
  const j = (await q("SELECT * FROM platform.print_jobs WHERE id=$1 AND company=$2 AND device=$3", [id, company, device])).rows[0];
  if (!j) throw new Error("no such job for this device");
  await q("UPDATE platform.print_jobs SET status=$2, printer=$3, error=$4, updated_at=now() WHERE id=$1", [id, ok ? "done" : "failed", printer || null, ok ? null : String(error || "failed").slice(0, 500)]);
  const c = await row(company, j.module, j.connection);
  if (c) {
    const seen = new Set([...(c.detail && c.detail.printers || [])]); if (printer) seen.add(String(printer).slice(0, 80));
    if (ok) await setStatus(company, j.module, j.connection, "connected", { detail: { printers: [...seen].slice(-10), last_printed_at: new Date().toISOString(), last_printer: printer || null } });
    else await setStatus(company, j.module, j.connection, c.status === "connected" ? "connected" : "error", { error: String(error || "failed").slice(0, 300), detail: { printers: [...seen].slice(-10) } });
  }
  await record(ok ? "label_printed" : "label_failed", { company, module: j.module, actor: "person", after: ok ? `${j.template} on ${printer || "the printer"}` : String(error || "failed").slice(0, 300), detail: { connection: j.connection, job_id: id, template: j.template, printer: printer || null, data: j.detail && j.detail.data } });
  return j;
}
async function jobs(company, mod, name, limit = 20) {
  const r = await q("SELECT id, device, template, status, printer, error, detail, created_at, updated_at FROM platform.print_jobs WHERE company=$1 AND module=$2 AND connection=$3 ORDER BY id DESC LIMIT $4", [company, mod, name, Math.min(200, Math.max(1, Number(limit) || 20))]);
  return r.rows.map((j) => ({ ...j, device: j.device ? j.device.slice(0, 6) : null }));
}
// A PNG of the label, from Labelary's public renderer (the platform reaches
// it, the device never does). null when it cannot be reached; the module
// shows the text of the label instead.
const previews = new Map();
async function previewPng(zpl, settings) {
  const s = printerSettings({ settings });
  const k = crypto.createHash("md5").update(`${s.dpmm}|${s.width_in}|${s.height_in}|${zpl}`).digest("hex");
  const hit = previews.get(k); if (hit && hit.at > Date.now() - PREVIEW_TTL_MS) return hit.png;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(`${LABELARY}/${s.dpmm}dpmm/labels/${s.width_in}x${s.height_in}/0/`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "image/png" }, body: zpl, signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(`renderer answered ${r.status}`);
    const png = Buffer.from(await r.arrayBuffer());
    previews.set(k, { png, at: Date.now() }); if (previews.size > 200) previews.delete(previews.keys().next().value);
    return png;
  } catch (e) { previews.set(k, { png: null, at: Date.now() }); return null; }
}

// ---- erp: read-only named queries ----------------------------------------------------------
const http = require("http"), https = require("https");
function httpGet(url, { headers = {}, timeoutMs = 15000, verifyTls = true } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(new Error("the ERP address is not a valid URL")); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error("the ERP address must start with http:// or https://"));
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, { method: "GET", headers, rejectUnauthorized: verifyTls, timeout: timeoutMs }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > 20 * 1024 * 1024) { req.destroy(new Error("the ERP answered with more than 20 MB")); return; } chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error(`the ERP did not answer within ${Math.round(timeoutMs / 1000)} seconds`)));
    req.on("error", (e) => reject(new Error(e.code === "ENOTFOUND" ? "the ERP address could not be found" : e.code === "ECONNREFUSED" ? "the ERP refused the connection" : /certificate|self.signed|CERT/i.test(e.message) ? `the ERP's certificate is not trusted (${e.message})` : e.message)));
    req.end();
  });
}
// Settings the admin keeps for an erp connection, bounded.
function erpSettings(c) {
  const s = (c && c.settings) || {};
  const out = {
    flavor: ERP_FLAVORS.includes(s.flavor) ? s.flavor : "sap_odata",
    transport: ERP_TRANSPORTS.includes(s.transport) ? s.transport : "direct",
    base_url: String(s.base_url || "").trim().slice(0, 500),
    verify_tls: s.verify_tls !== false,
    freshness_s: Number(s.freshness_s) > 0 ? Math.min(86400, Math.round(Number(s.freshness_s))) : 300,
    sap_client: String(s.sap_client || "").slice(0, 10),
    auth_header: String(s.auth_header || "").slice(0, 60),
    queries: {},
  };
  for (const [qn, qv] of Object.entries(s.queries || {})) {
    if (!NAME.test(qn)) continue;
    const q = qv && typeof qv === "object" ? qv : {};
    const fields = {};
    for (const [mf, ef] of Object.entries(q.fields || {})) if (IDENT.test(mf) && ef != null && String(ef).trim()) fields[mf] = String(ef).trim().slice(0, 120);
    out.queries[qn] = { path: String(q.path || "").trim().slice(0, 1000), fields, test_params: q.test_params && typeof q.test_params === "object" ? q.test_params : {}, freshness_s: Number(q.freshness_s) > 0 ? Math.min(86400, Math.round(Number(q.freshness_s))) : null };
  }
  return out;
}
// {param} in a path template becomes the value, escaped for a URL and, in an
// OData filter, for its single quotes.
function fillPath(template, params) {
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => {
    const v = params && params[k] != null ? String(params[k]) : "";
    return encodeURIComponent(v.replace(/'/g, "''")).replace(/'/g, "%27");
  });
}
// The rows out of an ERP answer, by flavor. SAP OData v2 wraps them in
// d.results, v4 in value; Epicor BAQ in value; a plain JSON endpoint in an
// array or a rows/value/data/results key.
function rowsOf(flavor, body) {
  let j; try { j = JSON.parse(body); } catch (e) { throw new Error("the ERP did not answer with JSON (is the address the OData service itself?)"); }
  if (j && j.error) { const m = j.error.message; throw new Error(`the ERP answered with an error: ${typeof m === "string" ? m : (m && m.value) || JSON.stringify(j.error).slice(0, 200)}`); }
  if (Array.isArray(j)) return j;
  if (j && j.d) { if (Array.isArray(j.d.results)) return j.d.results; if (Array.isArray(j.d)) return j.d; if (typeof j.d === "object") return [j.d]; }
  for (const k of ["value", "rows", "data", "results", "items"]) if (j && Array.isArray(j[k])) return j[k];
  if (j && typeof j === "object" && !Array.isArray(j) && flavor === "json") return [j];
  throw new Error("the ERP answered, but not with a list of rows the platform recognizes");
}
const pick = (row, pathStr) => String(pathStr).split(".").reduce((o, k) => (o == null ? undefined : o[k]), row);
function mapRows(rows, declaredFields, fieldMap) {
  return rows.slice(0, ERP_MAX_ROWS).map((r) => { const o = {}; for (const f of declaredFields) { const src = fieldMap[f]; const v = src ? pick(r, src) : undefined; o[f] = v === undefined ? null : v; } return o; });
}
function authHeaders(settings, secrets) {
  const h = { accept: "application/json" };
  const sec = secrets || {};
  if (sec.user) h.authorization = "Basic " + Buffer.from(`${sec.user}:${sec.password || ""}`).toString("base64");
  if (sec.api_key) { const name = settings.auth_header || (settings.flavor === "epicor_baq" ? "x-api-key" : "authorization"); h[name.toLowerCase()] = name.toLowerCase() === "authorization" && !sec.user ? `Bearer ${sec.api_key}` : sec.api_key; }
  if (settings.flavor === "sap_odata" && settings.sap_client) h["sap-client"] = settings.sap_client;
  return h;
}
// Run one named query against the ERP, no cache. Throws with plain words.
async function erpFetch(company, mod, name, qname, params) {
  const c = await row(company, mod, name);
  const live = await liveDeclaration(company, mod, name);
  if (!c || !live || live.kind !== "erp") throw new Error("no such ERP connection on this module");
  const decl = live.queries[qname];
  if (!decl) throw new Error(`the module has no query named ${qname}`);
  const s = erpSettings(c);
  const def = s.queries[qname];
  if (!s.base_url || !def || !def.path) throw new Error(`${c.label || name} is not connected yet (the query "${qname}" has no definition on the platform)`);
  if (s.transport === "bridge") throw new Error("the plant-side bridge is not available yet; set the transport to direct until it is");
  for (const p of decl.params) if (params == null || params[p] == null || params[p] === "") throw new Error(`the query ${qname} needs ${p}`);
  const url = s.base_url.replace(/\/+$/, "/") + fillPath(def.path, params).replace(/^\/+/, "");
  let secrets = null;
  if (c.secrets) { try { secrets = decrypt(c.secrets); } catch (e) { throw new Error("the stored login cannot be read (the platform's connection key changed); enter the login again"); } }
  const r = await httpGet(url, { headers: authHeaders(s, secrets), verifyTls: s.verify_tls });
  if (r.status === 401 || r.status === 403) throw new Error(`the ERP refused the login (${r.status})`);
  if (r.status === 404) throw new Error("the ERP has no such service or query at that path (404)");
  if (r.status >= 400) throw new Error(`the ERP answered ${r.status}`);
  const raw = rowsOf(s.flavor, r.text);
  return { rows: mapRows(raw, decl.fields, def.fields), raw_count: raw.length, url: url.replace(/\?.*/, "") };
}
const paramsHash = (params) => crypto.createHash("md5").update(JSON.stringify(params || {}, Object.keys(params || {}).sort())).digest("hex");
// What a module calls: fresh rows from the cache, else the ERP, else stale
// rows with fresh=false; and a plain error when nothing is there.
async function erpQuery(company, mod, name, qname, params) {
  const c = await row(company, mod, name);
  const s = erpSettings(c);
  const def = s.queries[qname] || {};
  const fresh_s = def.freshness_s || s.freshness_s;
  const h = paramsHash(params);
  const cached = (await q("SELECT rows, fetched_at FROM platform.erp_cache WHERE company=$1 AND module=$2 AND connection=$3 AND query=$4 AND params_hash=$5", [company, mod, name, qname, h])).rows[0];
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < fresh_s * 1000) return { rows: cached.rows, fetched_at: cached.fetched_at, fresh: true, from_cache: true };
  try {
    const out = await erpFetch(company, mod, name, qname, params);
    await q(`INSERT INTO platform.erp_cache (company, module, connection, query, params_hash, rows, fetched_at) VALUES ($1,$2,$3,$4,$5,$6,now())
             ON CONFLICT (company, module, connection, query, params_hash) DO UPDATE SET rows=EXCLUDED.rows, fetched_at=now()`, [company, mod, name, qname, h, JSON.stringify(out.rows)]);
    if (c && c.status !== "connected") await setStatus(company, mod, name, "connected", { detail: { last_query: qname, last_fetched_at: new Date().toISOString() } });
    else await q("UPDATE platform.connections SET detail = detail || $4::jsonb, last_checked=now() WHERE company=$1 AND module=$2 AND name=$3", [company, mod, name, JSON.stringify({ last_query: qname, last_fetched_at: new Date().toISOString() })]);
    return { rows: out.rows, fetched_at: new Date().toISOString(), fresh: true, from_cache: false };
  } catch (e) {
    if (c && s.base_url) await setStatus(company, mod, name, cached ? "connected" : "error", { error: e.message.slice(0, 300) });
    if (cached) return { rows: cached.rows, fetched_at: cached.fetched_at, fresh: false, from_cache: true, error: e.message };
    throw e;
  }
}
// The admin sets where the ERP is, how each query is fulfilled, and the login.
async function setErp(company, mod, name, { settings, secrets, clear_secrets }, actor) {
  const c = await row(company, mod, name);
  if (!c || c.kind !== "erp") throw new Error("no such ERP connection");
  const before = erpSettings(c);
  const next = erpSettings({ settings: { ...c.settings, ...(settings || {}), queries: { ...(c.settings && c.settings.queries) || {}, ...((settings || {}).queries || {}) } } });
  let enc = c.secrets;
  if (clear_secrets) enc = null;
  else if (secrets && (secrets.user || secrets.api_key)) enc = encrypt({ user: String(secrets.user || "").slice(0, 200), password: String(secrets.password || "").slice(0, 500), api_key: String(secrets.api_key || "").slice(0, 1000) });
  await q("UPDATE platform.connections SET settings=$4, secrets=$5, updated_at=now() WHERE company=$1 AND module=$2 AND name=$3", [company, mod, name, JSON.stringify(next), enc]);
  await q("DELETE FROM platform.erp_cache WHERE company=$1 AND module=$2 AND connection=$3", [company, mod, name]);
  await record("connection_settings", { company, module: mod, actor: actor || "admin", before: JSON.stringify(before), after: JSON.stringify(next), detail: { connection: name, kind: "erp", login: clear_secrets ? "cleared" : secrets && (secrets.user || secrets.api_key) ? "set" : "kept" } });
  return { settings: next, has_login: Boolean(enc) };
}
// The one-button test: every declared query with its test params.
async function testErp(company, mod, name, actor) {
  const c = await row(company, mod, name);
  const live = await liveDeclaration(company, mod, name);
  if (!c || !live || live.kind !== "erp") throw new Error("no such ERP connection");
  const s = erpSettings(c);
  const results = [];
  for (const [qname, decl] of Object.entries(live.queries)) {
    const def = s.queries[qname];
    if (!def || !def.path) { results.push({ query: qname, ok: false, error: "no definition on the platform yet" }); continue; }
    const used = [...def.path.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).filter((p) => !decl.params.includes(p));
    if (used.length) { results.push({ query: qname, ok: false, error: `the path uses {${used[0]}} but the module's query ${qname} has no such param (it has ${decl.params.length ? decl.params.join(", ") : "none"})` }); continue; }
    try {
      const out = await erpFetch(company, mod, name, qname, def.test_params || {});
      const empty = decl.fields.filter((f) => out.rows.length && out.rows.every((r) => r[f] == null));
      results.push({ query: qname, ok: true, rows: out.rows.length, raw_count: out.raw_count, sample: out.rows[0] || null, empty_fields: empty, url: out.url });
    } catch (e) { results.push({ query: qname, ok: false, error: e.message }); }
  }
  const ok = results.every((r) => r.ok);
  await setStatus(company, mod, name, ok ? "connected" : "error", { error: ok ? null : results.find((r) => !r.ok).error, detail: { last_test: results.map((r) => ({ query: r.query, ok: r.ok, rows: r.rows || 0, empty_fields: r.empty_fields || [], error: r.error || null })), last_tested_at: new Date().toISOString() } });
  if (ok) await q("DELETE FROM platform.erp_cache WHERE company=$1 AND module=$2 AND connection=$3", [company, mod, name]);
  await record("connection_tested", { company, module: mod, actor: actor || "manager", after: ok ? `every query answered: ${results.map((r) => `${r.query} ${r.rows} rows`).join(", ")}` : results.filter((r) => !r.ok).map((r) => `${r.query}: ${r.error}`).join("; "), detail: { connection: name, kind: "erp", ok } });
  return { ok, results };
}
// The note to IT, in the words IT uses, for the manager to send. Templated
// for now; a generated walkthrough is a later push.
const FLAVOR_NAME = { sap_odata: "SAP (an OData service through SAP Gateway or S/4HANA)", epicor_baq: "Epicor Kinetic (a BAQ through the REST API)", json: "the system's read-only JSON API" };
async function itNote(company, mod, name) {
  const c = await row(company, mod, name);
  const live = await liveDeclaration(company, mod, name);
  if (!c || !live || live.kind !== "erp") throw new Error("no such ERP connection");
  const co = (await q("SELECT name FROM platform.companies WHERE slug=$1", [company])).rows[0];
  const m = (await q("SELECT title FROM platform.modules WHERE company=$1 AND name=$2", [company, mod])).rows[0];
  const s = erpSettings(c);
  const lines = [];
  lines.push(`Read-only access request: ${co ? co.name : company}, ${m ? m.title : mod}`);
  lines.push("");
  lines.push(`What we are asking for: a technical (service) user with READ-ONLY access to ${FLAVOR_NAME[s.flavor]}, limited to the lookups below. No write access, no other data, no user data.`);
  lines.push("");
  lines.push("The lookups the floor tool needs:");
  for (const [qn, d] of Object.entries(live.queries)) {
    const def = s.queries[qn];
    lines.push(`  ${qn}: ${d.about || "a read-only lookup"}. Fields we read: ${d.fields.join(", ")}${d.params.length ? `. Looked up by: ${d.params.join(", ")}` : ""}${def && def.path ? `. Path: ${def.path}` : ""}`);
  }
  lines.push("");
  lines.push(`Where the calls come from: the Symbiotic OS instance (hosted; we will give you its outbound address if you allow-list by address), over HTTPS${s.base_url ? ` to ${s.base_url}` : " to the service address you give us"}.`);
  lines.push("How often: a few reads a minute at most; results are cached on our side for " + (s.freshness_s >= 60 ? `${Math.round(s.freshness_s / 60)} minute${s.freshness_s >= 120 ? "s" : ""}` : `${s.freshness_s} seconds`) + ".");
  lines.push("How the login is kept: encrypted on the platform, entered by our administrator, never stored on a plant device, never visible on any screen of the tool.");
  lines.push("What we need back from you: the service address (the OData service URL or the BAQ name), the technical user and its password (or an API key), and, for SAP, the client number.");
  return lines.join("\n");
}

// A stand-in ERP for demos: /erp-demo/parts answers like an SAP OData v2
// service (d.results), /erp-demo/orders too. Read only, static, no login.
const DEMO_ROWS = {
  parts: [
    { Material: "paper_white", MaterialDescription: "Copy paper, white, 20 lb", AvailableStock: 480, ReorderPoint: 100, Plant: "1000", BaseUnit: "SH" },
    { Material: "paper_blue", MaterialDescription: "Copy paper, blue, 20 lb", AvailableStock: 35, ReorderPoint: 60, Plant: "1000", BaseUnit: "SH" },
    { Material: "paper_yellow", MaterialDescription: "Copy paper, yellow, 20 lb", AvailableStock: 210, ReorderPoint: 60, Plant: "1000", BaseUnit: "SH" },
    { Material: "clip", MaterialDescription: "Paper clip, #1, steel", AvailableStock: 1200, ReorderPoint: 200, Plant: "1000", BaseUnit: "EA" },
    { Material: "tape", MaterialDescription: "Tape, clear, 3/4 in", AvailableStock: 8, ReorderPoint: 12, Plant: "1000", BaseUnit: "EA" },
  ],
  orders: [
    { SalesOrder: "4500017", Customer: "Northside Schools", Material: "paper_white", OrderQty: 200, DueDate: "2026-09-26", Status: "open" },
    { SalesOrder: "4500018", Customer: "Harbor Camp", Material: "paper_blue", OrderQty: 60, DueDate: "2026-09-24", Status: "open" },
  ],
};
function demoErp(req, res) {
  const rows = DEMO_ROWS[String(req.params.entity || "").toLowerCase()];
  if (!rows) return res.status(404).json({ error: { message: { value: "Resource not found" } } });
  let out = rows;
  const f = String(req.query.$filter || "");
  const m = /^(\w+)\s+eq\s+'([^']*)'$/.exec(f.trim());
  if (m) out = rows.filter((r) => String(r[m[1]]) === m[2]);
  for (const [k, v] of Object.entries(req.query)) if (!k.startsWith("$") && rows[0] && k in rows[0]) out = out.filter((r) => String(r[k]) === String(v));
  const top = Number(req.query.$top); if (top > 0) out = out.slice(0, top);
  res.set("Cache-Control", "no-store").json({ d: { results: out } });
}

// ---- the device cookie ------------------------------------------------------------------
// Every browser that opens a module page or the connections page gets a
// random device id, so a print job goes back to the device that asked for it.
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function deviceOf(req) { const d = cookies(req).sos_device; return d && /^[a-f0-9]{24}$/.test(d) ? d : null; }
function deviceCookie(req, res, next) {
  if (!deviceOf(req) && /^\/(c\/[^/]+\/(m|staging\/m|connections)|api\/c\/[^/]+\/print)/.test(req.path)) {
    const id = crypto.randomBytes(12).toString("hex");
    req.headers.cookie = `${req.headers.cookie ? req.headers.cookie + "; " : ""}sos_device=${id}`;
    const secure = (req.headers["x-forwarded-proto"] || req.protocol) === "https" ? "; Secure" : "";
    res.append("Set-Cookie", `sos_device=${id}; Path=/; Max-Age=34560000; SameSite=Lax${secure}`);
  }
  next();
}

// ---- what a module gets: ctx.connections ------------------------------------------------
async function liveDeclaration(company, mod, name) {
  const registry = require("./registry");
  const m = await registry.getModule(company, mod);
  if (!m || !m.live_version) return null;
  const { connections } = declared(registry.readManifest(company, mod, m.live_version));
  return connections[name] || null;
}
function surfaces(company, mod, version, manifest) {
  const { connections } = declared(manifest);
  const out = {};
  for (const [name, d] of Object.entries(connections)) {
    const status = async () => {
      const c = await row(company, mod, name);
      const det = (c && c.detail) || {};
      if (d.kind === "files") return { kind: "files", connected: Boolean(c && c.status === "connected"), table: d.table, last_loaded_at: det.last_loaded_at || null, rows: det.last_rows || null, filename: det.last_file || null };
      if (d.kind === "erp") { const s = erpSettings(c); const defined = {}; for (const qn of Object.keys(d.queries)) defined[qn] = Boolean(s.queries[qn] && s.queries[qn].path); return { kind: "erp", connected: Boolean(c && c.status === "connected"), queries: defined, last_fetched_at: det.last_fetched_at || null, error: (c && c.last_error) || null }; }
      return { kind: "printer", connected: Boolean(c && c.status === "connected"), printers: det.printers || [], last_printed_at: det.last_printed_at || null, error: (c && c.last_error) || null };
    };
    if (d.kind === "erp") out[name] = {
      kind: "erp", status,
      async query(qname, params) {
        if (!d.queries[qname]) throw new Error(`no query named ${qname} on this connection`);
        return erpQuery(company, mod, name, qname, params || {});
      },
    };
    if (d.kind === "files") out[name] = { kind: "files", status };
    if (d.kind === "printer") out[name] = {
      kind: "printer", status,
      async print(req, template, data) {
        if (!d.templates.includes(template)) throw new Error(`no label named ${template} on this connection`);
        const zpl = renderZpl(await templateText(company, mod, version, template), data || {});
        const device = req && req.headers ? deviceOf(req) : null;
        const job = await queueJob({ company, mod, name, device, template, zpl, detail: { data: data || {} } });
        return { job_id: job.id, queued: true, device: Boolean(device), zpl };
      },
      async preview(template, data) {
        if (!d.templates.includes(template)) throw new Error(`no label named ${template} on this connection`);
        const zpl = renderZpl(await templateText(company, mod, version, template), data || {});
        const c = await row(company, mod, name);
        return { zpl, png: await previewPng(zpl, c && c.settings) };
      },
    };
  }
  return out;
}
// The stand-in the validator loads routes.js against: same names, same
// surfaces, nothing behind them.
function stubs(manifest) {
  const { connections } = declared(manifest);
  const out = {};
  for (const [name, d] of Object.entries(connections)) out[name] = d.kind === "printer"
    ? { kind: "printer", status: async () => ({ kind: "printer", connected: false, printers: [] }), print: async () => ({ job_id: 0, queued: false, device: false, zpl: "" }), preview: async () => ({ zpl: "", png: null }) }
    : d.kind === "erp"
    ? { kind: "erp", status: async () => ({ kind: "erp", connected: false, queries: {} }), query: async () => { throw new Error("not connected yet"); } }
    : { kind: "files", status: async () => ({ kind: "files", connected: false, table: d.table }) };
  return out;
}

// ---- the connections page's view of a company --------------------------------------------
const KIND_TEXT = {
  files: { what: "A spreadsheet the company keeps, loaded into one of the module's tables. Upload it here whenever it changes; matching rows are replaced, the rest are added.", person: "Nothing to install. Keep the header row as it is so the columns match." },
  printer: { what: "Labels printed on a Zebra printer from the PC or tablet that asks for them. The module keeps the label layouts; the platform sends each label to the printer chosen on that device.", person: "On each PC or tablet that prints: install Zebra Browser Print (free, from zebra.com), open this page or a module screen, choose the printer when asked, print a test label." },
  erp: { what: "Read-only lookups in the company's ERP or scheduling system, a short fixed list the module names. The platform runs each lookup, keeps the answer for a few minutes, and shows the last good answer if the system is down. Nothing is ever written back.", person: "Send the note below to IT and get a read-only login. Anetix enters the login and the lookups on the platform; you press Test." },
};
async function companyView(company) {
  const registry = require("./registry");
  const mods = (await q("SELECT name, title, live_version FROM platform.modules WHERE company=$1 ORDER BY name", [company])).rows;
  const out = [];
  for (const m of mods) {
    if (!m.live_version) continue;
    let manifest; try { manifest = registry.readManifest(company, m.name, m.live_version); } catch (e) { continue; }
    const { connections } = declared(manifest);
    if (!Object.keys(connections).length) continue;
    await ensureRows(company, m.name, manifest);
    const list = [];
    for (const [name, d] of Object.entries(connections)) {
      const c = await row(company, m.name, name);
      const item = { name, kind: d.kind, label: d.label, status: c ? c.status : "not_connected", last_checked: c && c.last_checked, last_error: c && c.last_error, detail: (c && c.detail) || {}, text: KIND_TEXT[d.kind] };
      if (d.kind === "files") {
        item.table = d.table; item.key = d.key;
        const cols = await tableColumns(migrate.liveSchema(company, m.name), d.table);
        item.columns = cols.filter((x) => x.name !== "id").map((x) => ({ name: x.name, type: x.type, required: x.required, aliases: d.columns[x.name] || [] }));
        item.uploads = (await q("SELECT id, filename, row_count, status, loaded_rows, actor, created_at, loaded_at FROM platform.connection_uploads WHERE company=$1 AND module=$2 AND connection=$3 AND status='loaded' ORDER BY id DESC LIMIT 5", [company, m.name, name])).rows;
      }
      if (d.kind === "printer") { item.templates = d.templates; item.settings = printerSettings(c); item.jobs = await jobs(company, m.name, name, 10); }
      if (d.kind === "erp") {
        const s = erpSettings(c);
        item.queries = Object.entries(d.queries).map(([qn, qd]) => ({ name: qn, ...qd, defined: Boolean(s.queries[qn] && s.queries[qn].path), definition: s.queries[qn] || null }));
        item.settings = s; item.has_login = Boolean(c && c.secrets);
        item.it_note = await itNote(company, m.name, name);
      }
      list.push(item);
    }
    out.push({ module: m.name, title: m.title, version: m.live_version, connections: list });
  }
  return out;
}
async function setSettings(company, mod, name, settings, actor) {
  const c = await row(company, mod, name);
  if (!c) throw new Error("no such connection");
  const before = c.settings || {};
  const next = c.kind === "printer" ? printerSettings({ settings: { ...before, ...settings } }) : { ...before, ...settings };
  await q("UPDATE platform.connections SET settings=$4, updated_at=now() WHERE company=$1 AND module=$2 AND name=$3", [company, mod, name, JSON.stringify(next)]);
  await record("connection_settings", { company, module: mod, actor: actor || "manager", before: JSON.stringify(before), after: JSON.stringify(next), detail: { connection: name, kind: c.kind } });
  return next;
}
// A test label for the device that asked, from the connections page.
async function testLabel(company, mod, name, req) {
  const c = await row(company, mod, name);
  if (!c || c.kind !== "printer") throw new Error("no such printer connection");
  const device = deviceOf(req);
  if (!device) throw new Error("this browser has no device id yet; reload the page and try again");
  const co = (await q("SELECT name FROM platform.companies WHERE slug=$1", [company])).rows[0];
  const zpl = renderZpl(TEST_LABEL, { company: co ? co.name : company, when: new Date().toISOString().slice(0, 16).replace("T", " "), code: `TEST${Date.now().toString().slice(-6)}` });
  const job = await queueJob({ company, mod, name, device, template: "test", zpl, detail: { test: true } });
  await record("connection_tested", { company, module: mod, actor: "manager", after: `test label queued for device ${device.slice(0, 6)}`, detail: { connection: name, job_id: job.id } });
  return { job_id: job.id, zpl };
}
async function deleteCompany(company) {
  for (const t of ["print_jobs", "connection_uploads", "erp_cache", "connections"]) await q(`DELETE FROM platform.${t} WHERE company=$1`, [company]);
}

module.exports = {
  init, SCHEMA, KINDS, declared, ensureRows, row, surfaces, stubs, companyView, setSettings,
  previewUpload, loadUpload, matchColumns, coerce, parseAll,
  renderZpl, zplEscape, previewPng, printerSettings, TEST_LABEL, queueJob, nextJob, finishJob, jobs, testLabel,
  deviceCookie, deviceOf, cookies, encrypt, decrypt, deleteCompany, KIND_TEXT,
  erpSettings, fillPath, rowsOf, mapRows, authHeaders, erpFetch, erpQuery, setErp, testErp, itNote, httpGet, ERP_FLAVORS, ERP_TRANSPORTS, demoErp, DEMO_ROWS,
};
