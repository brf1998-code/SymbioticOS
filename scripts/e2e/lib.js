// Shared by the end to end scripts in this folder. They run against a server that is ALREADY UP in fake-agent
// mode (see the header of closeout.js for the one command). No dependencies beyond node 22's fetch; the
// browser scripts also need playwright (global install is fine: NODE_PATH or `npm i -g playwright`).
const BASE = process.env.SOS_E2E_BASE || "http://127.0.0.1:3999";
const PW = { floor: process.env.SOS_FLOOR_PASSWORD || "floorpw", manager: process.env.SOS_MANAGER_PASSWORD || "mgrpw", admin: process.env.SOS_ADMIN_PASSWORD || "adminpw" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runner() {
  const s = { pass: 0, fail: 0 };
  s.t = (name, cond, detail) => { if (cond) s.pass++; else { s.fail++; console.log(`FAIL  ${name}${detail !== undefined ? "\n      " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 600) : ""}`); } };
  s.done = () => { console.log(`\n${s.pass} passed, ${s.fail} failed`); process.exit(s.fail ? 1 : 0); };
  s.abort = (e) => { console.error("ABORTED:", e); console.log(`\n${s.pass} passed, ${s.fail + 1} failed`); process.exit(1); };
  return s;
}

// a client that keeps EVERY cookie, the way a browser does (session, person, device)
function client() {
  const jar = new Map();
  const call = async (method, path, body) => {
    const res = await fetch(BASE + path, { method, redirect: "manual", headers: { "Content-Type": "application/json", Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) { const [kv] = c.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v) jar.set(k, v); else jar.delete(k); }
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, json, text, headers: res.headers };
  };
  // for a playwright context: the same cookies this client holds
  const cookies = () => [...jar].map(([name, value]) => ({ name, value, url: BASE }));
  return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b || {}), cookies };
}
async function login(password, company) { const c = client(); const r = await c.post("/login", { password, company }); if (r.status !== 200) throw new Error(`login failed for ${company}: ${r.text}`); return c; }
async function waitFor(what, fn, ms = 30000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out waiting for " + what); await sleep(250); } }
const rowsOf = (j) => (Array.isArray(j) ? j : (j && (j.rows || j.record)) || []);

// a person by name: added if new, given a new PIN if already on the list (a PIN is only ever shown once)
async function person(mgr, company, name, role) {
  const list = (await mgr.get(`/api/c/${company}/people`)).json.people || [];
  const had = list.find((p) => p.name === name);
  if (!had) { const made = (await mgr.post(`/api/c/${company}/people`, { name, role })).json; return { id: made.person.id, pin: made.pin }; }
  const re = (await mgr.post(`/api/c/${company}/people/${had.id}/pin`, {})).json;
  return { id: had.id, pin: re.pin };
}
const board = async (c, company = "demo") => (await c.get(`/api/c/${company}/board`)).json;
const fbRow = async (c, id, company = "demo") => (await board(c, company)).feedback.find((f) => f.id === id);
// review, approve and deploy a list of requests; one run (a batch when there are several)
async function ship(mgr, ids, company = "demo") {
  const props = [];
  for (const id of ids) props.push((await mgr.post(`/api/feedback/${id}/review`)).json);
  let runId;
  if (props.length > 1) runId = (await mgr.post("/api/runs/batch", { proposal_ids: props.map((p) => p.id) })).json.run.id;
  else { const r = (await mgr.post(`/api/proposals/${props[0].id}/decide`, { decision: "approve" })).json; runId = (r.run || r).id; }
  await waitFor(`run ${runId} at a gate`, async () => {
    const x = (await board(mgr, company)).runs.find((y) => y.id === runId);
    if (x && x.step === "confirm_requirement" && x.status === "waiting") { await mgr.post(`/api/runs/${runId}/confirm`, {}); return false; }
    return x && x.step === "await_deploy" && x.status === "waiting";
  });
  await mgr.post(`/api/runs/${runId}/deploy`);
  await waitFor(`run ${runId} live`, async () => { const f = await fbRow(mgr, ids[0], company); return f && f.status === "done" && f.shipped_version; });
  return { runId, props };
}

module.exports = { BASE, PW, sleep, runner, client, login, waitFor, rowsOf, person, board, fbRow, ship };
