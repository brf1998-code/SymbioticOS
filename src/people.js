// Operator identity: a name and a PIN. Product review of 2026-09-18, build
// order item 2b (Brendan, 2026-09-19: build it before "my requests", so a
// request follows the person across devices from day one).
//
// Two layers, on purpose. The DEVICE is signed in with the company's floor or
// manager password, as before (src/auth.js): that decides what the device may
// do. The PERSON is who is standing at it: picked from the company's list of
// names, proven with a short PIN, kept in a second signed cookie
// (sos_person) for a shift's length. A shared tablet changes hands by tapping
// the name chip on the feedback button. Nothing requires a person: a device
// with nobody signed in works exactly as it did, and says "anonymous".
//
// What a person changes: feedback is filed under their name and id (the
// typed-name box goes away once someone is signed in), and the interaction
// record carries who acted (actor_name, actor_person) on every manager and
// floor action. It is the ground for "my requests", for asking the reporter a
// clarifying question, and for "fixed it or not quite".
//
// The manager keeps the list on /c/<slug>/people: add a name (the platform
// makes the PIN and shows it once), reset a PIN, switch someone off. PINs are
// 4 to 8 digits, stored as scrypt hashes; five wrong tries lock that name for
// five minutes; a reset or a switch-off signs the person out everywhere
// (generation). Names are unique per company, case aside.
const crypto = require("crypto");
const { q } = require("./db");
const auth = require("./auth");

const COOKIE = "sos_person";
const HOURS = Number(process.env.SOS_PERSON_HOURS || 12);
const MAX_TRIES = 5, LOCK_MINUTES = 5;
const ROLES = ["floor", "lead", "manager"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS platform.people (
  id           SERIAL PRIMARY KEY,
  company      TEXT NOT NULL,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'floor',      -- floor | lead | manager (a label for now; the device's login still decides what it may do)
  pin_hash     TEXT,
  active       BOOLEAN NOT NULL DEFAULT true,
  generation   INTEGER NOT NULL DEFAULT 1,
  failed_tries INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS people_company_name ON platform.people (company, lower(name));
ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS person_id INTEGER;
`;
async function init() { await q(SCHEMA); }

const cleanName = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 60);
const validPin = (p) => /^\d{4,8}$/.test(String(p || ""));
// A PIN a person can remember and nobody guesses first: no 0000, 1234, 1111.
function makePin() {
  for (;;) {
    const p = String(crypto.randomInt(0, 10000)).padStart(4, "0");
    if (/^(\d)\1{3}$/.test(p) || "0123456789876543210".includes(p)) continue;
    return p;
  }
}
const publicRow = (p) => ({ id: p.id, name: p.name, role: p.role });
const managerRow = (p) => ({ ...publicRow(p), active: p.active, has_pin: Boolean(p.pin_hash), locked: Boolean(p.locked_until && new Date(p.locked_until) > new Date()), last_seen_at: p.last_seen_at, created_at: p.created_at });

async function list(company, { manage = false } = {}) {
  const rows = (await q(`SELECT * FROM platform.people WHERE company=$1 ${manage ? "" : "AND active AND pin_hash IS NOT NULL"} ORDER BY lower(name)`, [company])).rows;
  return rows.map(manage ? managerRow : publicRow);
}
async function add(company, { name, role, pin }) {
  const n = cleanName(name);
  if (n.length < 2) throw new Error("a name needs at least two letters");
  if (pin != null && pin !== "" && !validPin(pin)) throw new Error("a PIN is 4 to 8 digits");
  if ((await q("SELECT 1 FROM platform.people WHERE company=$1 AND lower(name)=lower($2)", [company, n])).rows.length) throw new Error(`there is already a ${n} on the list; add a last initial to tell them apart`);
  const p = pin ? String(pin) : makePin();
  const r = (await q("INSERT INTO platform.people (company, name, role, pin_hash) VALUES ($1,$2,$3,$4) RETURNING *", [company, n, ROLES.includes(role) ? role : "floor", auth.hashPassword(p)])).rows[0];
  return { person: managerRow(r), pin: p };
}
async function get(company, id) { return (await q("SELECT * FROM platform.people WHERE company=$1 AND id=$2", [company, Number(id)])).rows[0] || null; }
async function resetPin(company, id, pin) {
  const cur = await get(company, id); if (!cur) throw new Error("no such person");
  if (pin != null && pin !== "" && !validPin(pin)) throw new Error("a PIN is 4 to 8 digits");
  const p = pin ? String(pin) : makePin();
  const r = (await q("UPDATE platform.people SET pin_hash=$3, generation=generation+1, failed_tries=0, locked_until=NULL, updated_at=now() WHERE company=$1 AND id=$2 RETURNING *", [company, cur.id, auth.hashPassword(p)])).rows[0];
  gens.delete(cur.id);
  return { person: managerRow(r), pin: p };
}
async function setActive(company, id, active) {
  const cur = await get(company, id); if (!cur) throw new Error("no such person");
  const r = (await q("UPDATE platform.people SET active=$3, generation=generation+1, updated_at=now() WHERE company=$1 AND id=$2 RETURNING *", [company, cur.id, Boolean(active)])).rows[0];
  gens.delete(cur.id);
  return managerRow(r);
}

// ---- the person cookie ------------------------------------------------------------------------
function sign(p) {
  const payload = `p.${p.id}.${p.company}.${p.generation}.${Date.now().toString(36)}`;
  return `${payload}.${auth.hmac(payload)}`;
}
function verify(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 6 || parts[0] !== "p") return null;
  const [, id, company, gen, ts, mac] = parts;
  const expect = auth.hmac(`p.${id}.${company}.${gen}.${ts}`);
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  const age = Date.now() - parseInt(ts, 36);
  if (!Number.isFinite(age) || age < 0 || age > HOURS * 3600e3) return null;
  return { id: Number(id), company, gen: Number(gen) };
}
const gens = new Map();   // id -> { row, at }: ten seconds, so a reset signs a person out almost at once without a query per request
async function current(id) {
  const hit = gens.get(id); if (hit && hit.at > Date.now() - 10e3) return hit.row;
  const row = (await q("SELECT id, company, name, role, active, generation FROM platform.people WHERE id=$1", [id])).rows[0] || null;
  gens.set(id, { row, at: Date.now() }); if (gens.size > 5000) gens.delete(gens.keys().next().value);
  return row;
}
const cookieHeader = (req, value, maxAge) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${(req.headers["x-forwarded-proto"] || req.protocol) === "https" ? "; Secure" : ""}`;

// Middleware, after auth.middleware: who is standing at this device, if anyone.
async function attach(req, _res, next) {
  try {
    const tok = auth.parseCookies(req)[COOKIE];
    const v = tok && verify(tok);
    if (v) {
      const p = await current(v.id);
      // the person belongs to the company this device is signed in to (an admin session may carry any)
      const sessionOk = !req.sosCompany || req.sosCompany === auth.ALL || req.sosCompany === v.company;
      if (p && p.active && p.generation === v.gen && p.company === v.company && sessionOk) { req.sosPerson = p.name; req.sosPersonId = p.id; req.sosPersonCompany = p.company; req.sosPersonRole = p.role; }
    }
  } catch (e) { /* a bad cookie is nobody */ }
  next();
}
// Name and PIN -> the cookie. Wrong tries lock the name for a few minutes.
async function signIn(req, res, company, id, pin) {
  const p = await get(company, id);
  if (!p || !p.active || !p.pin_hash) throw Object.assign(new Error("that name is not on the list"), { status: 404 });
  if (p.locked_until && new Date(p.locked_until) > new Date()) throw Object.assign(new Error(`too many wrong tries: wait ${Math.max(1, Math.ceil((new Date(p.locked_until) - Date.now()) / 60e3))} minute(s), or ask the manager for a new PIN`), { status: 429 });
  if (!validPin(pin) || !auth.checkHash(String(pin), p.pin_hash)) {
    const tries = p.failed_tries + 1;
    await q("UPDATE platform.people SET failed_tries=$2, locked_until=$3 WHERE id=$1", [p.id, tries >= MAX_TRIES ? 0 : tries, tries >= MAX_TRIES ? new Date(Date.now() + LOCK_MINUTES * 60e3) : null]);
    throw Object.assign(new Error(tries >= MAX_TRIES ? `that is ${MAX_TRIES} wrong tries: this name is locked for ${LOCK_MINUTES} minutes` : "wrong PIN"), { status: 401 });
  }
  await q("UPDATE platform.people SET failed_tries=0, locked_until=NULL, last_seen_at=now() WHERE id=$1", [p.id]);
  res.append("Set-Cookie", cookieHeader(req, sign(p), HOURS * 3600));
  return publicRow(p);
}
function signOut(req, res) { res.append("Set-Cookie", cookieHeader(req, "", 0)); }
async function deleteCompany(company) { await q("DELETE FROM platform.people WHERE company=$1", [company]); }

module.exports = { init, SCHEMA, COOKIE, list, add, get, resetPin, setActive, signIn, signOut, attach, sign, verify, makePin, validPin, cleanName, deleteCompany, ROLES };
