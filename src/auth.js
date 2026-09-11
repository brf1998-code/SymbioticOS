// Password access control, three roles.
//   SOS_FLOOR_PASSWORD   -> "floor":   sees module pages, sends feedback, works stations
//   SOS_MANAGER_PASSWORD -> "manager": floor plus review/approve/deploy/rollback, agent settings
//   SOS_ADMIN_PASSWORD   -> "admin":   manager plus the /admin view across companies
//                           (falls back to the manager password when unset)
// A signed cookie carries the role. If no password is set (local dev), every
// request is treated as admin so the loop stays walkable without setup.
const crypto = require("crypto");

const FLOOR = process.env.SOS_FLOOR_PASSWORD || "";
const MANAGER = process.env.SOS_MANAGER_PASSWORD || "";
const ADMIN = process.env.SOS_ADMIN_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(24).toString("hex");
const COOKIE = "sos_session";
const OPEN = !FLOOR && !MANAGER;
// token for the platform's own internal requests (smoke checks hit the staged
// mount over HTTP); generated per process unless pinned by env
const INTERNAL = process.env.SOS_INTERNAL_TOKEN || crypto.randomBytes(16).toString("hex");
process.env.SOS_INTERNAL_TOKEN = INTERNAL;

function sign(role) {
  const ts = Date.now().toString(36);
  const payload = `${role}.${ts}`;
  const mac = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function verify(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [role, ts, mac] = parts;
  const expect = crypto.createHmac("sha256", SECRET).update(`${role}.${ts}`).digest("base64url");
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  return ["admin", "manager", "floor"].includes(role) ? role : null;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function roleFor(password) {
  if (ADMIN && password === ADMIN) return "admin";
  if (MANAGER && password === MANAGER) return ADMIN ? "manager" : "admin";
  if (FLOOR && password === FLOOR) return "floor";
  return null;
}

// Middleware: attaches req.sosRole; redirects/401s when not logged in.
function middleware(req, res, next) {
  if (OPEN) { req.sosRole = "admin"; return next(); }
  const p = req.path;
  if (p === "/login" || p === "/health" || p.startsWith("/assets/")) return next();
  if (req.headers["x-sos-internal"] === INTERNAL) { req.sosRole = "admin"; return next(); }
  const role = verify(parseCookies(req)[COOKIE]);
  if (!role) {
    if (req.method === "GET" && !p.startsWith("/api/") && !/\/api\//.test(p)) {
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(401).json({ error: "login required" });
  }
  req.sosRole = role;
  next();
}

function requireManager(req, res, next) {
  if (req.sosRole === "manager" || req.sosRole === "admin") return next();
  res.status(403).json({ error: "manager login required" });
}
function requireAdmin(req, res, next) {
  if (req.sosRole === "admin") return next();
  res.status(403).json({ error: "admin login required" });
}

function loginHandler(req, res) {
  const role = roleFor(String((req.body || {}).password || ""));
  if (!role) return res.status(401).json({ error: "wrong password" });
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.set("Set-Cookie", `${COOKIE}=${sign(role)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`);
  res.json({ ok: true, role });
}

function logoutHandler(_req, res) {
  res.set("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.redirect("/login");
}

module.exports = { middleware, requireManager, requireAdmin, loginHandler, logoutHandler, OPEN };
