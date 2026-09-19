// Acceptance checks that accumulate. Product review of 2026-09-18, build order
// item 7: "Tests do not test behavior." Until this, test_run and visual_check
// asked the staged pages for an answer and failed only on no answer or a 500,
// so a 404 passed and nothing a build promised was ever checked again.
//
// The idea. Every functionality change leaves ONE small file behind in the
// module, checks/NNN-short-name.json: "call this, expect that", written by the
// builder from the confirmed requirement's "how we will know it works". The
// platform runs EVERY check in checks/ against the staged build before the
// deploy gate, and keeps every check forever, so change 200 is as safe as
// change 2 and the pile of checks is the plant's process knowledge in a form
// that runs. A check is a promise an earlier change made:
//
//   the check that came with THIS change fails   -> back to the agent (the
//                                                   change or its check is wrong)
//   a check an EARLIER change left behind fails  -> the manager decides: send it
//                                                   back to keep the promise, or
//                                                   retire the promise because
//                                                   this change is what they want
//                                                   now (Brendan, 2026-09-19: the
//                                                   manager, with a confirm)
//
// A check file is never edited or removed by a build (the module gate holds
// that, like migrations). Retiring lives in a platform table, not in the file,
// so the agent cannot retire a promise by itself.
//
// This file: the format and its validator (pure), the matcher (pure), the
// runner (HTTP against a mount), the wording for the card and for the agent,
// retirements, and where a check came from. The page load is src/pageload.js;
// pipeline.runChecks puts them together.
//
//   {
//     "title": "A material request can ask for more than one sheet",
//     "steps": [
//       { "call": "POST /api/requests", "body": { "station": 1, "item": "paper", "qty": 3 },
//         "expect": { "status": 200, "json": { "ok": true } }, "save": { "id": "request.id" } },
//       { "call": "GET /api/stock", "as": "floor",
//         "expect": { "json": { "requests": { "$contains": { "id": "{id}", "qty": 3 } } } } },
//       { "page": "/stock", "expect": { "contains": ["Requests"], "visible": ["3 sheets"] } }
//     ]
//   }
const { q } = require("./db");
const { record } = require("./record");

const DIR = "checks/";
const FILE = /^checks\/\d{3}-[a-z0-9]+(?:-[a-z0-9]+){0,9}\.json$/;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const MAX_STEPS = 12, MAX_BODY = 8000, STEP_TIMEOUT_MS = Number(process.env.SOS_CHECK_TIMEOUT_MS || 10000);
const OPS = ["$type", "$gte", "$lte", "$gt", "$lt", "$in", "$regex", "$exists", "$length", "$minLength", "$contains", "$every", "$not"];
const DASH = /[\u2013\u2014]/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS platform.check_retirements (
  id             SERIAL PRIMARY KEY,
  company        TEXT NOT NULL,
  module         TEXT NOT NULL,
  file           TEXT NOT NULL,
  title          TEXT,
  reason         TEXT,
  retired_by     TEXT,
  retired_person INTEGER,
  run_id         INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company, module, file)
);`;
async function init() { await q(SCHEMA); }

// ---- the format (pure) -----------------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// A path inside the module: starts with /, never climbs out, never names a host.
function pathProblem(p) {
  if (typeof p !== "string" || !p.startsWith("/")) return "starts with / and stays inside the module";
  if (p.length > 300) return "is too long";
  const bare = p.split("?")[0];
  if (/^\/\//.test(p) || /[\\\s]/.test(bare) || /:\/\//.test(p)) return "is a path inside the module, not an address";
  let decoded = bare; try { decoded = decodeURIComponent(bare); } catch (e) { return "does not decode"; }
  if (decoded.split("/").includes("..") || /\\/.test(decoded)) return "may not climb out of the module";
  return null;
}
function matcherProblems(m, where, out, depth = 0) {
  if (depth > 8) { out.push(`${where}: nested too deep`); return; }
  if (Array.isArray(m)) { m.forEach((x, i) => matcherProblems(x, `${where}[${i}]`, out, depth + 1)); return; }
  if (!isObj(m)) return;
  const keys = Object.keys(m), ops = keys.filter((k) => k.startsWith("$"));
  for (const k of ops) if (!OPS.includes(k)) out.push(`${where}: "${k}" is not something a check can ask (${OPS.join(", ")})`);
  if (ops.length && ops.length !== keys.length) out.push(`${where}: mixes field names with $ rules; put the rules under the field`);
  if (m.$regex != null) { try { new RegExp(String(m.$regex)); if (String(m.$regex).length > 200) out.push(`${where}: $regex is too long`); } catch (e) { out.push(`${where}: $regex does not parse`); } }
  if (m.$type != null && !["string", "number", "boolean", "array", "object", "null"].includes(m.$type)) out.push(`${where}: $type is string, number, boolean, array, object or null`);
  for (const k of keys) if (k === "$contains" || k === "$every" || k === "$not" || !k.startsWith("$")) matcherProblems(m[k], `${where}.${k}`, out, depth + 1);
}
// name: "checks/007-request-quantity.json"; text: the file. Returns { ok, check, problems }.
function parse(name, text) {
  const problems = [];
  if (!FILE.test(name)) problems.push(`the name is checks/NNN-short-name.json (three digits, then lowercase words joined by dashes); got ${name}`);
  let c = null;
  try { c = JSON.parse(text); } catch (e) { return { ok: false, check: null, problems: [...problems, `does not parse as JSON: ${e.message}`] }; }
  if (!isObj(c)) return { ok: false, check: null, problems: [...problems, "is one JSON object with a title and steps"] };
  const title = typeof c.title === "string" ? c.title.trim() : "";
  if (title.length < 8 || title.length > 160) problems.push("title: one plain sentence, 8 to 160 characters, saying what the floor can count on");
  if (DASH.test(title)) problems.push("title: no long dashes; a manager reads this line");
  if (c.why != null && (typeof c.why !== "string" || c.why.length > 300)) problems.push("why: a short sentence, at most 300 characters");
  if (!Array.isArray(c.steps) || !c.steps.length || c.steps.length > MAX_STEPS) problems.push(`steps: 1 to ${MAX_STEPS} steps`);
  (Array.isArray(c.steps) ? c.steps : []).forEach((s, i) => {
    const at = `step ${i + 1}`;
    if (!isObj(s)) { problems.push(`${at}: is an object with "call" or "page"`); return; }
    const unknown = Object.keys(s).filter((k) => !["call", "page", "body", "as", "expect", "save", "note"].includes(k));
    if (unknown.length) problems.push(`${at}: does not know ${unknown.map((k) => `"${k}"`).join(", ")}`);
    if ((s.call == null) === (s.page == null)) { problems.push(`${at}: has exactly one of "call" (METHOD /path) or "page" (/path)`); return; }
    if (s.call != null) {
      const m = /^([A-Z]+) (\S+)$/.exec(String(s.call));
      if (!m || !METHODS.includes(m[1])) problems.push(`${at}: call is "METHOD /path" with ${METHODS.join(", ")}`);
      else { const pp = pathProblem(m[2]); if (pp) problems.push(`${at}: the path ${pp}`); if (m[1] === "GET" && s.body != null) problems.push(`${at}: a GET carries no body`); }
    } else { const pp = pathProblem(s.page); if (pp) problems.push(`${at}: the page path ${pp}`); if (s.body != null || s.save != null) problems.push(`${at}: a page step has no body and saves nothing`); }
    if (s.body != null && (!isObj(s.body) && !Array.isArray(s.body) || JSON.stringify(s.body).length > MAX_BODY)) problems.push(`${at}: body is JSON, at most ${MAX_BODY} characters`);
    if (s.as != null && !["manager", "floor"].includes(s.as)) problems.push(`${at}: as is "manager" or "floor"`);
    const e = s.expect;
    if (e != null && !isObj(e)) problems.push(`${at}: expect is an object`);
    if (isObj(e)) {
      const allowed = s.page != null ? ["status", "contains", "lacks", "visible", "selector"] : ["status", "json", "contains", "lacks"];
      const bad = Object.keys(e).filter((k) => !allowed.includes(k));
      if (bad.length) problems.push(`${at}: expect on a ${s.page != null ? "page" : "call"} knows ${allowed.join(", ")}; not ${bad.join(", ")}`);
      const st = e.status;
      if (st != null && !(Number.isInteger(st) && st >= 100 && st <= 599) && !(Array.isArray(st) && st.length && st.every((x) => Number.isInteger(x) && x >= 100 && x <= 599))) problems.push(`${at}: status is a number or a list of numbers`);
      for (const k of ["contains", "lacks", "visible", "selector"]) if (e[k] != null && !(Array.isArray(e[k]) && e[k].length <= 12 && e[k].every((x) => typeof x === "string" && x.length > 0 && x.length <= 200))) problems.push(`${at}: ${k} is a list of up to 12 short strings`);
      if (e.json !== undefined) matcherProblems(e.json, `${at} json`, problems);
    }
    if (s.save != null) {
      if (!isObj(s.save) || !Object.entries(s.save).every(([k, v]) => /^[a-z][a-z0-9_]{0,30}$/i.test(k) && typeof v === "string" && v.length <= 120)) problems.push(`${at}: save maps a short name to a path into the answer, like { "id": "request.id" }`);
    }
    // a {name} used before anything saved it would go out as the literal text
    const used = [...JSON.stringify([s.call || s.page, s.body || null, e || null]).matchAll(/\{([a-z][a-z0-9_]{0,30})\}/gi)].map((m) => m[1]);
    const savedBefore = new Set(); (c.steps || []).slice(0, i).forEach((p) => isObj(p) && isObj(p.save) && Object.keys(p.save).forEach((k) => savedBefore.add(k)));
    for (const u of new Set(used)) if (!savedBefore.has(u)) problems.push(`${at}: uses {${u}} before any step saved it`);
  });
  const check = { file: name, title, why: typeof c.why === "string" ? c.why : null, steps: Array.isArray(c.steps) ? c.steps : [] };
  return { ok: problems.length === 0, check, problems };
}
// Every check in a version's files, in order. { checks: [...], invalid: [{ file, problems }] }
function collect(files) {
  const checks = [], invalid = [];
  for (const name of Object.keys(files || {}).filter((n) => n.startsWith(DIR)).sort()) {
    const p = parse(name, String(files[name] || ""));
    if (p.ok) checks.push(p.check); else invalid.push({ file: name, problems: p.problems });
  }
  return { checks, invalid };
}
const writes = (check) => check.steps.some((s) => s.call && !/^GET /.test(s.call));

// ---- the matcher (pure) ------------------------------------------------------------------------
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const show = (v) => { const s = JSON.stringify(v); return s === undefined ? "nothing" : s.length > 120 ? s.slice(0, 117) + "..." : s; };
function fill(v, vars) {
  if (typeof v === "string") {
    const whole = /^\{([a-z][a-z0-9_]{0,30})\}$/i.exec(v);
    if (whole && vars[whole[1]] !== undefined) return vars[whole[1]];   // "{id}" alone keeps the saved value's type
    return v.replace(/\{([a-z][a-z0-9_]{0,30})\}/gi, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (isObj(v)) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = fill(x, vars); return o; }
  return v;
}
function pick(obj, path) {
  let cur = obj;
  for (const part of String(path).split(".").filter(Boolean)) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) && /^-?\d+$/.test(part) ? cur[Number(part) < 0 ? cur.length + Number(part) : Number(part)] : cur[part];
  }
  return cur;
}
// Mismatches in plain words; empty = it matches. expected is a subset pattern.
function match(actual, expected, at = "the answer") {
  const out = [];
  if (isObj(expected) && Object.keys(expected).some((k) => k.startsWith("$"))) {
    for (const [op, want] of Object.entries(expected)) {
      if (op === "$exists") { if ((actual !== undefined) !== Boolean(want)) out.push(`${at} ${want ? "is missing" : "should not be there"}`); continue; }
      if (op === "$not") { if (!match(actual, want, at).length) out.push(`${at} is ${show(actual)}, which it should not be`); continue; }
      if (actual === undefined) { out.push(`${at} is missing`); break; }
      if (op === "$type" && typeOf(actual) !== want) out.push(`${at} is ${typeOf(actual) === "array" ? "a list" : `a ${typeOf(actual)}`} (${show(actual)}), expected ${want}`);
      if (op === "$gte" && !(actual >= want)) out.push(`${at} is ${show(actual)}, expected at least ${show(want)}`);
      if (op === "$lte" && !(actual <= want)) out.push(`${at} is ${show(actual)}, expected at most ${show(want)}`);
      if (op === "$gt" && !(actual > want)) out.push(`${at} is ${show(actual)}, expected more than ${show(want)}`);
      if (op === "$lt" && !(actual < want)) out.push(`${at} is ${show(actual)}, expected less than ${show(want)}`);
      if (op === "$in" && !(Array.isArray(want) && want.some((w) => !match(actual, w, at).length))) out.push(`${at} is ${show(actual)}, expected one of ${show(want)}`);
      if (op === "$regex" && !(typeof actual === "string" && new RegExp(String(want)).test(actual))) out.push(`${at} is ${show(actual)}, which does not look like ${want}`);
      if (op === "$length" && !((Array.isArray(actual) || typeof actual === "string") && actual.length === want)) out.push(`${at} has ${actual && actual.length != null ? actual.length : "no"} entries, expected ${want}`);
      if (op === "$minLength" && !((Array.isArray(actual) || typeof actual === "string") && actual.length >= want)) out.push(`${at} has ${actual && actual.length != null ? actual.length : "no"} entries, expected at least ${want}`);
      if (op === "$contains" && !(Array.isArray(actual) && actual.some((el) => !match(el, want, at).length))) out.push(`${at} ${Array.isArray(actual) ? `has ${actual.length} entries and none of them` : "is not a list that"} matches ${show(want)}`);
      if (op === "$every") { if (!Array.isArray(actual)) out.push(`${at} is not a list`); else actual.forEach((el, i) => out.push(...match(el, want, `${at}[${i}]`).slice(0, 1))); }
    }
    return out.slice(0, 6);
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${at} is ${show(actual)}, expected a list`];
    if (actual.length !== expected.length) return [`${at} has ${actual.length} entries, expected ${expected.length}`];
    expected.forEach((e, i) => out.push(...match(actual[i], e, `${at}[${i}]`)));
    return out.slice(0, 6);
  }
  if (isObj(expected)) {
    if (!isObj(actual)) return [`${at} is ${show(actual)}, expected an object with ${Object.keys(expected).join(", ")}`];
    for (const [k, e] of Object.entries(expected)) out.push(...match(actual[k], e, at === "the answer" ? k : `${at}.${k}`));
    return out.slice(0, 6);
  }
  if (actual === undefined) return [`${at} is missing, expected ${show(expected)}`];
  return actual === expected ? [] : [`${at} is ${show(actual)}, expected ${show(expected)}`];
}
function statusProblem(status, want) {
  if (want == null) return status >= 200 && status < 300 ? null : `answered ${status || "nothing"}, expected a 2xx`;
  const list = Array.isArray(want) ? want : [want];
  return list.includes(status) ? null : `answered ${status || "nothing"}, expected ${list.join(" or ")}`;
}

// ---- the runner ----------------------------------------------------------------------------------
// base: "http://127.0.0.1:8080/c/<co>/staging/m/<mod>"; cookies: { manager, floor } Cookie header values;
// browser: optional src/pageload.js session with .visit(url, cookie) for "visible" and "selector".
async function runCheck(check, { base, cookies = {}, browser = null, fetchImpl = fetch }) {
  const vars = {}, steps = [];
  let ok = true;
  for (let i = 0; i < check.steps.length && ok; i++) {
    const s = check.steps[i], e = s.expect || {};
    const label = s.call || `page ${s.page}`;
    const problems = [], notes = [];
    let status = 0;
    try {
      const [method, rawPath] = s.call ? String(s.call).split(" ") : ["GET", s.page];
      const path = fill(rawPath, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, encodeURIComponent(String(v))])));
      const headers = { Cookie: cookies[s.as || "manager"] || cookies.manager || "", Accept: s.page ? "text/html" : "application/json" };
      if (s.body != null) headers["Content-Type"] = "application/json";
      const res = await fetchImpl(base + path, { method, headers, body: s.body != null ? JSON.stringify(fill(s.body, vars)) : undefined, redirect: "manual", signal: AbortSignal.timeout(STEP_TIMEOUT_MS) });
      status = res.status;
      const text = await res.text();
      const sp = statusProblem(status, e.status); if (sp) problems.push(sp);
      let json; try { json = JSON.parse(text); } catch (err) { json = undefined; }
      if (e.json !== undefined) { if (json === undefined) problems.push("did not answer with JSON"); else problems.push(...match(json, fill(e.json, vars))); }
      for (const c of fill(e.contains || [], vars)) if (!text.includes(c)) problems.push(`the ${s.page ? "page" : "answer"} does not contain "${c}"`);
      for (const c of fill(e.lacks || [], vars)) if (text.includes(c)) problems.push(`the ${s.page ? "page" : "answer"} still contains "${c}"`);
      if (s.save && json !== undefined) for (const [k, p] of Object.entries(s.save)) { const v = pick(json, p); if (v === undefined) problems.push(`nothing at "${p}" to carry into the next step`); else vars[k] = v; }
      if (s.page && (e.visible || e.selector) && !problems.length) {
        if (!browser) notes.push("what the screen shows was not looked at: no browser on this instance");
        else {
          const seen = await browser.visit(base + path, cookies[s.as || "manager"] || cookies.manager || "", { visible: fill(e.visible || [], vars), selector: e.selector || [] });
          for (const m of seen.missingText) problems.push(`the screen does not show "${m}"`);
          for (const m of seen.missingSelector) problems.push(`the screen has nothing matching ${m}`);
        }
      }
    } catch (err) { problems.push(err.name === "TimeoutError" ? `no answer within ${Math.round(STEP_TIMEOUT_MS / 1000)} seconds` : `could not be called: ${err.message}`); }
    if (problems.length) ok = false;
    steps.push({ n: i + 1, step: label, as: s.as || "manager", status, ok: !problems.length, problems: problems.slice(0, 6), ...(notes.length ? { notes } : {}) });
  }
  return { file: check.file, title: check.title, ok, wrote: writes(check), steps };
}

// Every active check of a version against a mount. fromFiles tells new from old.
async function runAll({ files, fromFiles = null, retired = new Set(), base, cookies, browser }) {
  const { checks, invalid } = collect(files);
  const results = [];
  for (const c of checks) {
    if (retired.has(c.file)) continue;
    const r = await runCheck(c, { base, cookies, browser });
    r.new = !fromFiles || fromFiles[c.file] == null;
    results.push(r);
  }
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0 && invalid.length === 0, total: results.length, passed: results.length - failed.length,
    added: results.filter((r) => r.new).map((r) => ({ file: r.file, title: r.title })), retired: checks.filter((c) => retired.has(c.file)).length,
    wrote: results.some((r) => r.wrote), failed, invalid,
  };
}

// ---- wording -------------------------------------------------------------------------------------
const firstProblem = (r) => { const s = (r.steps || []).find((x) => !x.ok); return s ? `${s.step}: ${s.problems.join("; ")}` : "did not pass"; };
// One line for the run's error and the card.
function oneLine(a) {
  const old = a.failed.filter((r) => !r.new), fresh = a.failed.filter((r) => r.new);
  if (old.length) return `this change breaks something an earlier change promised: "${old[0].title}"${old.length > 1 ? ` (and ${old.length - 1} more)` : ""}`;
  if (fresh.length) return `the check that came with this change does not pass: "${fresh[0].title}" (${firstProblem(fresh[0])})`;
  if (a.invalid.length) return `a check file is not readable: ${a.invalid[0].file}`;
  return "";
}
// What the agent gets in a fix round. Precise on purpose: it is a new session and sees only this.
function forAgent(a) {
  const lines = [];
  for (const r of a.failed) {
    lines.push(r.new
      ? `- The check you added, ${r.file} ("${r.title}"), does not pass against your build. ${r.steps.filter((s) => !s.ok).map((s) => `Step ${s.n} (${s.step}, as ${s.as}) ${s.problems.join("; ")}.`).join(" ")} Work out which is wrong, the change or the check, and fix that one. You may edit ${r.file}: it is new in this build.`
      : `- ${r.file} ("${r.title}") was left behind by an earlier change and no longer passes. ${r.steps.filter((s) => !s.ok).map((s) => `Step ${s.n} (${s.step}, as ${s.as}) ${s.problems.join("; ")}.`).join(" ")} That file is a promise the floor relies on: do NOT edit or remove it. Change your work so that it passes again while still doing what was asked.`);
  }
  for (const i of a.invalid) lines.push(`- ${i.file} is not a readable check: ${i.problems.join("; ")}.`);
  return lines.join("\n");
}

// ---- retirements and where a check came from ---------------------------------------------------------
async function retiredSet(company, mod) {
  return new Set((await q("SELECT file FROM platform.check_retirements WHERE company=$1 AND module=$2", [company, mod])).rows.map((r) => r.file));
}
// The request a check came from: the first version that carried the file, the run that built it, its requests.
async function originOf(company, mod, file) {
  const v = (await q("SELECT min(version) AS v FROM platform.module_versions WHERE company=$1 AND module=$2 AND files ? $3", [company, mod, file])).rows[0];
  if (!v || v.v == null) return null;
  const run = (await q("SELECT id, proposal_ids, proposal_id FROM platform.build_runs WHERE company=$1 AND module=$2 AND to_version=$3 AND status IN ('deployed','rolled_back') ORDER BY id DESC LIMIT 1", [company, mod, v.v])).rows[0];
  if (!run) return { version: Number(v.v), run_id: null, requests: [] };
  const reqs = (await q("SELECT f.id, f.message, f.name FROM platform.proposals p JOIN platform.feedback f ON f.id=p.feedback_id WHERE p.id = ANY($1::int[]) ORDER BY f.id", [run.proposal_ids || [run.proposal_id]])).rows;
  return { version: Number(v.v), run_id: run.id, requests: reqs.map((r) => ({ id: r.id, words: String(r.message || "").replace(/\s+/g, " ").slice(0, 160), name: r.name || null })) };
}
const fail = (status, msg) => Object.assign(new Error(msg), { status });
// The manager says an earlier promise no longer holds. run: the failed run whose checks named it.
async function retire({ run, file, reason, actor }) {
  const a = run && run.evidence && run.evidence.checks && run.evidence.checks.acceptance;
  const hit = a && (a.failed || []).find((r) => r.file === file && !r.new);
  if (!hit) throw fail(409, "this build did not break that promise, so there is nothing to retire here");
  const why = String(reason || "").trim().slice(0, 500);
  const who = actor || {};
  const ins = (await q(
    `INSERT INTO platform.check_retirements (company, module, file, title, reason, retired_by, retired_person, run_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (company, module, file) DO NOTHING RETURNING id`, [run.company, run.module, file, hit.title, why || null, who.name || (who.role === "admin" ? "Anetix" : "The manager"), who.person || null, run.id])).rows[0];
  if (!ins) throw fail(409, "that promise is already retired");
  await record("promise_retired", { company: run.company, module: run.module, actor: { role: who.role || "manager", name: who.name || null, person: who.person || null }, run_id: run.id, version: run.to_version || null, before: hit.title, after: why || null, detail: { file, origin: hit.origin || null } });
  return { file, title: hit.title };
}
async function deleteCompany(company) { await q("DELETE FROM platform.check_retirements WHERE company=$1", [company]); }
async function listRetired(company, mod) {
  return (await q("SELECT file, title, reason, retired_by, run_id, created_at FROM platform.check_retirements WHERE company=$1 AND ($2::text IS NULL OR module=$2) ORDER BY id", [company, mod || null])).rows;
}

module.exports = { init, SCHEMA, DIR, FILE, parse, collect, writes, match, fill, pick, statusProblem, runCheck, runAll, oneLine, forAgent, firstProblem, retiredSet, originOf, retire, listRetired, deleteCompany, pathProblem };
