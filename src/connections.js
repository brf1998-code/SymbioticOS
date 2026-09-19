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
//   erp      next push (read-only named queries; SAP first).
//
// Secrets: none of this push's kinds has any; the column and the cipher are
// here so the ERP kind lands without a schema change. The key lives only in
// the platform's env (SOS_CONNECTION_KEY, else derived from SESSION_SECRET),
// never in the agent's allow-list.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { q, pool } = require("./db");
const migrate = require("./migrate");
const attachments = require("./attachments");
const { record } = require("./record");

const KINDS = ["files", "printer"];
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
      return { kind: "printer", connected: Boolean(c && c.status === "connected"), printers: det.printers || [], last_printed_at: det.last_printed_at || null, error: (c && c.last_error) || null };
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
    : { kind: "files", status: async () => ({ kind: "files", connected: false, table: d.table }) };
  return out;
}

// ---- the connections page's view of a company --------------------------------------------
const KIND_TEXT = {
  files: { what: "A spreadsheet the company keeps, loaded into one of the module's tables. Upload it here whenever it changes; matching rows are replaced, the rest are added.", person: "Nothing to install. Keep the header row as it is so the columns match." },
  printer: { what: "Labels printed on a Zebra printer from the PC or tablet that asks for them. The module keeps the label layouts; the platform sends each label to the printer chosen on that device.", person: "On each PC or tablet that prints: install Zebra Browser Print (free, from zebra.com), open this page or a module screen, choose the printer when asked, print a test label." },
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
  for (const t of ["print_jobs", "connection_uploads", "connections"]) await q(`DELETE FROM platform.${t} WHERE company=$1`, [company]);
}

module.exports = {
  init, SCHEMA, KINDS, declared, ensureRows, row, surfaces, stubs, companyView, setSettings,
  previewUpload, loadUpload, matchColumns, coerce, parseAll,
  renderZpl, zplEscape, previewPng, printerSettings, TEST_LABEL, queueJob, nextJob, finishJob, jobs, testLabel,
  deviceCookie, deviceOf, cookies, encrypt, decrypt, deleteCompany, KIND_TEXT,
};
