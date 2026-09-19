// Access control: three roles, and since 2026-09-19 every session belongs to
// one company (tenancy trade study of 2026-09-17, option B).
//
//   floor    sees module pages, sends feedback, works stations   (one company)
//   manager  floor plus review / approve / deploy / rollback      (one company)
//   admin    manager everywhere, plus /admin across companies     (the platform's own people)
//
// Passwords
//   Each company has its own floor and manager passwords, stored as scrypt
//   hashes in platform.company_access and set from the admin page. Nothing in
//   platform.companies carries them, so "SELECT * FROM companies" can never
//   leak one to a page.
//   SOS_ADMIN_PASSWORD is the admin password (the manager password doubles as
//   admin when it is unset, as before).
//   SOS_FLOOR_PASSWORD / SOS_MANAGER_PASSWORD are the old instance-wide
//   passwords. They still open a company only while its access row says
//   legacy_login, which is how companies that existed before this change keep
//   working until the admin gives them their own. A company made after it
//   never accepts them.
//
// Session
//   A signed cookie carries role, company, the company's password generation
//   and issue time. Changing a company's password raises its generation, which
//   signs everyone at that company out (the reason to change one is usually
//   that somebody who knew it should no longer get in). `companyGuard` is the
//   one place that ties a request to a company: a /c/<slug>/ or /api/c/<slug>/
//   path must match the session's company, and a route addressed by id
//   (a feedback item, a proposal, a run, an intake, an attachment) is looked up
//   and must belong to it. Admin passes everywhere. With no passwords set at
//   all (local dev) every request is admin so the loop stays walkable.
const crypto = require("crypto");
const { q } = require("./db");

const FLOOR = process.env.SOS_FLOOR_PASSWORD || "";
const MANAGER = process.env.SOS_MANAGER_PASSWORD || "";
const ADMIN = process.env.SOS_ADMIN_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(24).toString("hex");
const COOKIE = "sos_session";
// sessions expire server-side after this long, regardless of what the browser does with Max-Age
const SESSION_SECONDS = Number(process.env.SOS_SESSION_DAYS || 30) * 24 * 60 * 60;
// failed logins per client IP before /login answers 429 for the rest of the window
const LOGIN_MAX_FAILS = Number(process.env.SOS_LOGIN_MAX_FAILS || 10);
const LOGIN_WINDOW_MS = Number(process.env.SOS_LOGIN_WINDOW_MIN || 15) * 60 * 1000;
const OPEN = !FLOOR && !MANAGER && !ADMIN;
// token for the platform's own internal requests (smoke checks hit the staged
// mount over HTTP); generated per process unless pinned by env
const INTERNAL = process.env.SOS_INTERNAL_TOKEN || crypto.randomBytes(16).toString("hex");
process.env.SOS_INTERNAL_TOKEN = INTERNAL;

const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
const ALL = "*";   // the company of an admin session

// ---- password hashing (scrypt, no dependency) -------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `s1$${salt.toString("base64")}$${hash.toString("base64")}`;
}
function checkHash(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "s1") return false;
  const want = Buffer.from(parts[2], "base64");
  const got = crypto.scryptSync(String(password), Buffer.from(parts[1], "base64"), want.length);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function same(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
// A password a person can read off a card and type on a phone.
function generatePassword() {
  const words = ["amber", "anvil", "birch", "brass", "cedar", "chalk", "cobalt", "copper", "delta", "ember", "flint", "forge", "gauge", "granite", "harbor", "hinge", "iron", "lathe", "maple", "nickel", "oak", "pallet", "quartz", "rivet", "slate", "spindle", "steel", "timber", "torque", "walnut"];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${pick()}-${String(crypto.randomInt(100, 1000))}`;
}

// ---- company access rows ---------------------------------------------------------------
async function accessRow(slug) {
  return (await q("SELECT * FROM platform.company_access WHERE company=$1", [slug])).rows[0] || null;
}
// Set one or both passwords. Giving a company its own passwords ends its use of the shared ones.
async function setPasswords(slug, { floor, manager }) {
  if (!floor && !manager) throw new Error("give at least one password");
  for (const [label, p] of [["floor", floor], ["manager", manager]]) if (p && String(p).length < 8) throw new Error(`the ${label} password needs at least 8 characters`);
  if (floor && manager && String(floor) === String(manager)) throw new Error("the floor and manager passwords must differ: the password is what tells the two apart");
  await q(
    `INSERT INTO platform.company_access (company, floor_hash, manager_hash, legacy_login) VALUES ($1,$2,$3,false)
     ON CONFLICT (company) DO UPDATE SET floor_hash=COALESCE($2, platform.company_access.floor_hash),
       manager_hash=COALESCE($3, platform.company_access.manager_hash), legacy_login=false,
       generation=platform.company_access.generation + 1, updated_at=now()`,
    [slug, floor ? hashPassword(floor) : null, manager ? hashPassword(manager) : null]);
  generations.delete(slug);
}
// The generation a company's sessions must carry, remembered for a few seconds
// so a page full of requests costs one lookup.
const generations = new Map();   // slug -> { gen, at }
async function generationOf(slug) {
  const hit = generations.get(slug);
  if (hit && Date.now() - hit.at < 10000) return hit.gen;
  const row = await accessRow(slug);
  const gen = row ? Number(row.generation || 1) : 0;   // 0: no access row, so no session for it can be current
  generations.set(slug, { gen, at: Date.now() });
  return gen;
}
// Companies that were here before per-company passwords existed keep the shared
// passwords until the admin sets their own. Runs at boot, after the library
// seeding; a company made from the admin page gets its row at creation and is
// never touched here.
async function ensureAccessRows() {
  const r = await q(
    `INSERT INTO platform.company_access (company, legacy_login)
     SELECT slug, true FROM platform.companies c WHERE NOT EXISTS (SELECT 1 FROM platform.company_access a WHERE a.company=c.slug)
     RETURNING company`);
  for (const row of r.rows) console.log(`[auth] ${row.company}: no passwords of its own yet, the shared floor and manager passwords still open it (set its own on the admin page)`);
  return r.rows.length;
}
function accessPublic(row) {
  return { own_floor: Boolean(row && row.floor_hash), own_manager: Boolean(row && row.manager_hash), legacy_login: Boolean(row && row.legacy_login), updated_at: row ? row.updated_at : null };
}

// ---- the session cookie -------------------------------------------------------------------
function sign(role, company, gen) {
  const ts = Date.now().toString(36);
  const payload = `${role}.${company}.${Number(gen) || 0}.${ts}`;
  const mac = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function verify(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 5) return null;   // cookies from before sessions carried a company are no longer accepted
  const [role, company, gen, ts, mac] = parts;
  const expect = crypto.createHmac("sha256", SECRET).update(`${role}.${company}.${gen}.${ts}`).digest("base64url");
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  const issued = parseInt(ts, 36);
  if (!Number.isFinite(issued)) return null;
  const age = Date.now() - issued;
  if (age < 0 || age > SESSION_SECONDS * 1000) return null;  // expired (or forged timestamp)
  if (!["admin", "manager", "floor"].includes(role)) return null;
  if (role === "admin" ? company !== ALL : !SLUG.test(company)) return null;
  return { role, company, gen: Number(gen) || 0 };
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Which company a login is for: the one named, or the only one there is.
async function resolveCompany(named) {
  const slug = String(named || "").trim().toLowerCase();
  if (slug) return SLUG.test(slug) && (await q("SELECT slug FROM platform.companies WHERE slug=$1", [slug])).rows[0] ? slug : null;
  const all = (await q("SELECT slug FROM platform.companies ORDER BY created_at LIMIT 2")).rows;
  return all.length === 1 ? all[0].slug : null;
}

// -> { role, company } or null
async function sessionFor(password, companyNamed) {
  password = String(password || "");
  if (!password) return null;
  if (ADMIN ? same(password, ADMIN) : same(password, MANAGER)) return { role: "admin", company: ALL };
  const company = await resolveCompany(companyNamed);
  if (!company) return null;
  const row = await accessRow(company);
  const gen = row ? Number(row.generation || 1) : 0;
  if (row && row.manager_hash && checkHash(password, row.manager_hash)) return { role: "manager", company, gen };
  if (row && row.floor_hash && checkHash(password, row.floor_hash)) return { role: "floor", company, gen };
  if (row && row.legacy_login) {
    if (!row.manager_hash && ADMIN && same(password, MANAGER)) return { role: "manager", company, gen };
    if (!row.floor_hash && same(password, FLOOR)) return { role: "floor", company, gen };
  }
  return null;
}

// Middleware: attaches req.sosRole and req.sosCompany; redirects/401s when not logged in.
function middleware(req, res, next) {
  if (OPEN) { req.sosRole = "admin"; req.sosCompany = ALL; return next(); }
  const p = req.path;
  if (p === "/login" || p === "/health" || p.startsWith("/assets/")) return next();
  if (req.headers["x-sos-internal"] === INTERNAL) { req.sosRole = "admin"; req.sosCompany = ALL; return next(); }
  const session = verify(parseCookies(req)[COOKIE]);
  if (!session) return toLogin(req, res, 401, "login required");
  const accept = () => { req.sosRole = session.role; req.sosCompany = session.company; next(); };
  if (session.role === "admin") return accept();
  // a company's password changed since this cookie was signed: sign in again
  generationOf(session.company).then((gen) => (gen && gen === session.gen ? accept() : toLogin(req, res, 401, "login required"))).catch(next);
}
function toLogin(req, res, status, error) {
  const p = req.path;
  if (req.method === "GET" && !p.startsWith("/api/") && !/\/api\//.test(p)) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  return res.status(status).json({ error });
}

// ---- one company per session ------------------------------------------------------------------
// Routes addressed by id instead of by /c/<slug>/: where the owning company is kept.
const OWNERS = [
  [/^\/api\/feedback\/(\d+)(?:\/|$)/, "SELECT company FROM platform.feedback WHERE id=$1"],
  [/^\/api\/proposals\/(\d+)(?:\/|$)/, "SELECT f.company FROM platform.proposals p JOIN platform.feedback f ON f.id=p.feedback_id WHERE p.id=$1"],
  [/^\/api\/runs\/(\d+)(?:\/|$)/, "SELECT company FROM platform.build_runs WHERE id=$1"],
  [/^\/api\/intakes\/(\d+)(?:\/|$)/, "SELECT company FROM platform.module_intakes WHERE id=$1"],
  [/^\/api\/attachments\/(\d+)(?:\/|$)/, "SELECT company FROM platform.attachments WHERE id=$1"],
];
async function companyGuard(req, res, next) {
  try {
    if (OPEN || req.sosRole === "admin" || !req.sosRole) return next();   // no role = a public path the middleware let through
    const p = req.path;
    const scoped = /^\/(?:api\/)?c\/([^/]+)(?:\/|$)/.exec(p);
    let owner = scoped ? decodeURIComponent(scoped[1]) : null;
    if (!owner) {
      for (const [re, sql] of OWNERS) {
        const m = re.exec(p);
        if (!m) continue;
        const row = (await q(sql, [Number(m[1])])).rows[0];
        if (!row) return res.status(404).json({ error: "not found" });
        owner = row.company;
        break;
      }
    }
    if (owner && owner !== req.sosCompany) return toLogin(req, res, 403, "this login is for another company");
    next();
  } catch (e) { next(e); }
}
// For the few routes that name their company in the body instead of the path.
function ownsCompany(req, slug) { return OPEN || req.sosRole === "admin" || (slug && slug === req.sosCompany); }

// Second factor for destructive admin actions (delete a company, restore a
// backup): the admin password typed again and checked here, never on the
// client. With no passwords set (local dev) anything passes.
function checkAdminPassword(password) {
  if (OPEN) return true;
  return same(password, ADMIN || MANAGER);
}

function requireManager(req, res, next) {
  if (req.sosRole === "manager" || req.sosRole === "admin") return next();
  res.status(403).json({ error: "manager login required" });
}
function requireAdmin(req, res, next) {
  if (req.sosRole === "admin") return next();
  res.status(403).json({ error: "admin login required" });
}

// Login rate limit: in-memory, per client IP, failures only. Enough to stop a
// password guesser; resets on a successful login. Cloudflare sits in front, so
// prefer its header over X-Forwarded-For (the leftmost XFF entry is
// client-supplied and spoofable).
const loginFails = new Map();  // ip -> { count, first }
function clientIp(req) {
  return String(req.headers["cf-connecting-ip"] || req.ip || req.socket?.remoteAddress || "unknown");
}
function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) { loginFails.delete(ip); return 0; }
  return rec.count >= LOGIN_MAX_FAILS ? Math.ceil((rec.first + LOGIN_WINDOW_MS - Date.now()) / 1000) : 0;
}
function noteLoginFail(ip) {
  const rec = loginFails.get(ip);
  if (rec && Date.now() - rec.first <= LOGIN_WINDOW_MS) rec.count++;
  else loginFails.set(ip, { count: 1, first: Date.now() });
}
setInterval(() => {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  for (const [ip, rec] of loginFails) if (rec.first < cutoff) loginFails.delete(ip);
}, 60 * 1000).unref();

async function loginHandler(req, res) {
  const ip = clientIp(req);
  const wait = loginBlocked(ip);
  if (wait) {
    res.set("Retry-After", String(wait));
    return res.status(429).json({ error: `too many failed logins; try again in ${Math.ceil(wait / 60)} min` });
  }
  try {
    const { password, company } = req.body || {};
    const session = await sessionFor(password, company);
    if (!session) {
      noteLoginFail(ip);
      // say when the missing piece is the company, so the page can ask for it
      const needCompany = !String(company || "").trim() && !(await resolveCompany(""));
      return res.status(401).json({ error: needCompany ? "which company is this login for?" : "wrong password", need_company: needCompany });
    }
    loginFails.delete(ip);
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.set("Set-Cookie", `${COOKIE}=${sign(session.role, session.company, session.gen)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`);
    res.json({ ok: true, role: session.role, company: session.company === ALL ? null : session.company });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

function logoutHandler(_req, res) {
  res.set("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.redirect("/login");
}

module.exports = {
  middleware, companyGuard, ownsCompany, requireManager, requireAdmin, loginHandler, logoutHandler, checkAdminPassword,
  setPasswords, generatePassword, ensureAccessRows, accessRow, accessPublic, hashPassword, checkHash, sign, verify, OPEN, ALL,
};
