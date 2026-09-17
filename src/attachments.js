// Attachments to a module intake: a photo of the whiteboard, the spreadsheet
// they keep, a pdf. Stored in platform.attachments (bytea, never on the
// container disk, which is ephemeral). Spreadsheets are parsed here to rows so
// Fable reads them as text; photos and pdfs go to the model as image and
// document blocks. No new dependencies: csv by hand, xlsx through a small zip
// reader (xlsx is a zip of xml).
const zlib = require("zlib");
const { q } = require("./db");

const MAX_BYTES = Number(process.env.SOS_ATTACHMENT_MAX_MB || 15) * 1024 * 1024;
const MAX_PER_INTAKE = Number(process.env.SOS_ATTACHMENTS_PER_INTAKE || 10);
const KEEP_ROWS = 200;

const KINDS = {
  "image/jpeg": "image", "image/png": "image", "image/webp": "image", "image/gif": "image",
  "application/pdf": "pdf",
  "text/csv": "sheet", "text/tab-separated-values": "sheet", "text/plain": "sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "sheet",
  "application/vnd.ms-excel": "sheet",
};
function kindOf(mime, filename) {
  const k = KINDS[String(mime || "").toLowerCase()];
  if (k) return k;
  const ext = String(filename || "").toLowerCase().split(".").pop();
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["csv", "tsv", "txt", "xlsx", "xls"].includes(ext)) return "sheet";
  return null;
}

// ---- csv --------------------------------------------------------------------
function parseCsv(text) {
  const first = text.split(/\r?\n/, 1)[0] || "";
  const delim = [",", "\t", ";"].map((d) => [d, (first.match(new RegExp(d === "\t" ? "\t" : `\\${d}`, "g")) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim()));
}

// ---- xlsx (a zip of xml) ------------------------------------------------------
function zipEntries(buf) {
  // end of central directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const fn = buf.readUInt16LE(p + 28), ex = buf.readUInt16LE(p + 30), cm = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + fn);
    entries[name] = { method, csize, usize, local };
    p += 46 + fn + ex + cm;
  }
  return {
    read(name) {
      const e = entries[name];
      if (!e) return null;
      const lfn = buf.readUInt16LE(e.local + 26), lex = buf.readUInt16LE(e.local + 28);
      const start = e.local + 30 + lfn + lex;
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return data.toString("utf8");
      if (e.method === 8) return zlib.inflateRawSync(data).toString("utf8");
      throw new Error(`zip method ${e.method} not supported`);
    },
    names: Object.keys(entries),
  };
}
const unxml = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
function colIndex(ref) { let n = 0; for (const ch of ref.replace(/[0-9]/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function parseXlsx(buf) {
  const zip = zipEntries(buf);
  const shared = [];
  const ss = zip.read("xl/sharedStrings.xml");
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const sheetName = zip.names.includes("xl/worksheets/sheet1.xml") ? "xl/worksheets/sheet1.xml" : zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error("no worksheet in this file");
  const xml = zip.read(sheetName);
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] || "";
      const ref = (/r="([A-Z]+)\d+"/.exec(attrs) || [])[1] || "";
      const t = (/t="(\w+)"/.exec(attrs) || [])[1];
      let val = "";
      if (t === "s") { const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1]; val = shared[Number(v)] ?? ""; }
      else if (t === "inlineStr") val = unxml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
      else { const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1]; val = v == null ? "" : unxml(v); }
      const idx = ref ? colIndex(ref) : row.length;
      while (row.length < idx) row.push("");
      row[idx] = val;
    }
    if (row.some((x) => String(x).trim())) rows.push(row);
  }
  return rows;
}

function parseSheet(buf, mime, filename) {
  const ext = String(filename || "").toLowerCase().split(".").pop();
  const rows = (ext === "xlsx" || /spreadsheetml/.test(mime || "")) ? parseXlsx(buf) : parseCsv(buf.toString("utf8").replace(/^﻿/, ""));
  if (!rows.length) return { headers: [], rows: [], row_count: 0 };
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => { const c = r.slice(0, width).map((x) => String(x == null ? "" : x).trim()); while (c.length < width) c.push(""); return c; });
  return { headers: norm[0], rows: norm.slice(1, 1 + KEEP_ROWS), row_count: norm.length - 1 };
}

// ---- storage ----------------------------------------------------------------
async function add({ company, intakeId, questionId, filename, mime, data }) {
  const kind = kindOf(mime, filename);
  if (!kind) throw new Error("That kind of file is not one Fable can read here. A photo, a pdf, a csv or an xlsx spreadsheet works.");
  const buf = Buffer.from(String(data || ""), "base64");
  if (!buf.length) throw new Error("the file was empty");
  if (buf.length > MAX_BYTES) throw new Error(`that file is bigger than ${Math.round(MAX_BYTES / 1048576)} MB`);
  const n = Number((await q("SELECT count(*) FROM platform.attachments WHERE intake_id=$1", [intakeId])).rows[0].count);
  if (n >= MAX_PER_INTAKE) throw new Error(`this intake already has ${MAX_PER_INTAKE} files; remove one first`);
  let parsed = null;
  if (kind === "sheet") {
    try { parsed = parseSheet(buf, mime, filename); }
    catch (e) { throw new Error(`could not read that spreadsheet (${e.message}). Save it as csv and try again.`); }
  }
  const r = await q(
    `INSERT INTO platform.attachments (company, intake_id, question_id, filename, mime, size, bytes, parsed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, question_id, filename, mime, size, parsed, created_at`,
    [company, intakeId, questionId || null, String(filename || "file").slice(0, 200), mime || "application/octet-stream", buf.length, buf, parsed ? JSON.stringify(parsed) : null]);
  return { ...r.rows[0], kind };
}
async function list(intakeId) {
  const rows = (await q("SELECT id, question_id, filename, mime, size, parsed, created_at FROM platform.attachments WHERE intake_id=$1 ORDER BY id", [intakeId])).rows;
  return rows.map((a) => ({ ...a, kind: kindOf(a.mime, a.filename) }));
}
async function get(id) { return (await q("SELECT * FROM platform.attachments WHERE id=$1", [id])).rows[0]; }
async function remove(id, intakeId) { await q("DELETE FROM platform.attachments WHERE id=$1 AND intake_id=$2", [id, intakeId]); }

// Content blocks for the model: images and pdfs as they are, spreadsheets as
// text (headers plus a sample), so the model reads what the person attached.
async function blocksFor(intakeId, { maxImages = 6, sampleRows = 40 } = {}) {
  const rows = (await q("SELECT id, question_id, filename, mime, size, parsed, bytes FROM platform.attachments WHERE intake_id=$1 ORDER BY id", [intakeId])).rows;
  const blocks = [];
  let images = 0;
  for (const a of rows) {
    const kind = kindOf(a.mime, a.filename);
    const head = `Attachment "${a.filename}" (for question ${a.question_id || "?"})`;
    if (kind === "image" && images < maxImages) {
      images++;
      blocks.push({ type: "text", text: head + ", a photo:" });
      blocks.push({ type: "image", source: { type: "base64", media_type: a.mime, data: a.bytes.toString("base64") } });
    } else if (kind === "pdf") {
      blocks.push({ type: "text", text: head + ", a pdf:" });
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.bytes.toString("base64") } });
    } else if (kind === "sheet" && a.parsed) {
      const p = a.parsed;
      const lines = [head + `, a spreadsheet with ${p.row_count} rows. Columns: ${p.headers.join(" | ")}`];
      for (const r of (p.rows || []).slice(0, sampleRows)) lines.push(r.join(" | "));
      if (p.row_count > sampleRows) lines.push(`... ${p.row_count - sampleRows} more rows`);
      blocks.push({ type: "text", text: lines.join("\n") });
    }
  }
  return blocks;
}

module.exports = { add, list, get, remove, blocksFor, kindOf, parseSheet, parseCsv, parseXlsx, MAX_BYTES, MAX_PER_INTAKE };
