// Module registry + runtime mounting.
//
// A module version is a set of files:
//   module.json  { name, title, entry, pages: {"/": "pages/board.html" | {file, label}}, smoke: [...] }
//   routes.js    module.exports = (ctx) => express.Router   (ctx: { express, db, moduleName, requireManager })
//   pages/*.html served per the pages map, with the feedback widget auto-injected
//   migrations/NNN.sql   validated + applied by the platform (see migrate.js)
//
// Modules belong to a company. Where versions live:
//   - The DATABASE is the source of truth (platform.module_versions.files). A
//     platform redeploy on Railway wipes the container disk; nothing is lost.
//   - Versions are materialized to MODULES_DIR/<company>/<name>/versions/<n>/ at
//     boot and when created, because require() and the build agent need files.
//   - The REPO ships seed sources at modules/<name>/ (the module library). On
//     boot every repo module is imported for the companies that have it (v1
//     for a new pairing; a changed hash becomes the next version and deploys).
//     Repo modules default to company "demo" (module.json "company" overrides);
//     the admin view can add a library module to any company.
//
// Live version mounts at /c/<company>/m/<name>/... ; staged at /c/<company>/staging/m/<name>/...
// Deploy/rollback = repoint live_version and remount. Git is not involved at
// runtime; version directories are immutable once created.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { q, scopedDb, logEvent } = require("./db");
const migrate = require("./migrate");
const { liveSchema, stagingSchema, applyMigrations, rebuildStagingClone } = migrate;

const REPO_MODULES_DIR = process.env.REPO_MODULES_DIR || path.join(__dirname, "..", "modules");
const MODULES_DIR = process.env.MODULES_DIR || path.join(__dirname, "..", "data", "modules");
const PRINCIPLES_DIR = process.env.PRINCIPLES_DIR || path.join(__dirname, "..", "principles");

// in-memory mount table: "company/name" -> { live: router|null, staged: router|null }
const mounts = new Map();
// hooks.deployed(company, mod, version) runs after every deploy (set by server.js)
const hooks = { deployed: null };
const key = (company, mod) => `${company}/${mod}`;

function versionDir(company, mod, version) {
  return path.join(MODULES_DIR, company, mod, "versions", String(version));
}

// ---- files <-> dir ---------------------------------------------------------
function readTree(dir, rel = "") {
  const out = {};
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    if (ent.isDirectory()) Object.assign(out, readTree(dir, r));
    else out[r] = fs.readFileSync(path.join(dir, r), "utf8");
  }
  return out;
}

function writeTree(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function hashFiles(files) {
  const h = crypto.createHash("sha256");
  for (const k of Object.keys(files).sort()) h.update(k).update("\0").update(files[k]).update("\0");
  return h.digest("hex").slice(0, 16);
}

async function getModule(company, mod) {
  return (await q("SELECT * FROM platform.modules WHERE company=$1 AND name=$2", [company, mod])).rows[0];
}

async function versionFiles(company, mod, version) {
  const row = (await q("SELECT files FROM platform.module_versions WHERE company=$1 AND module=$2 AND version=$3", [company, mod, version])).rows[0];
  return row ? row.files : null;
}

async function materialize(company, mod, version) {
  const dir = versionDir(company, mod, version);
  if (fs.existsSync(path.join(dir, "module.json"))) return dir;
  const files = await versionFiles(company, mod, version);
  if (!files) throw new Error(`no files stored for ${company}/${mod} v${version}`);
  writeTree(dir, files);
  return dir;
}

// Read a version directory back into the database (after an agent build).
async function persistVersion(company, mod, version) {
  const files = readTree(versionDir(company, mod, version));
  await q("UPDATE platform.module_versions SET files=$4 WHERE company=$1 AND module=$2 AND version=$3",
    [company, mod, version, JSON.stringify(files)]);
  return files;
}

function readManifest(company, mod, version) {
  const p = path.join(versionDir(company, mod, version), "module.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ---- screens ---------------------------------------------------------------
// The manifest's pages map names every screen a person can be on. Each entry is
// a file path or { file, label }. Feedback captures the screen it came from so
// proposals and builds target the right file.
function pageEntries(manifest) {
  return Object.entries(manifest.pages || {}).map(([route, v]) => {
    const file = typeof v === "string" ? v : v.file;
    const label = typeof v === "string" || !v.label
      ? path.basename(file, ".html").replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase()) + " page"
      : v.label;
    return { route, file, label };
  });
}

function routeMatches(route, rel) {
  const re = new RegExp("^" + route.replace(/\/$/, "").replace(/:[^/]+/g, "[^/]+") + "/?$");
  return re.test(rel.replace(/\/$/, "") || "/") || (route === "/" && (rel === "" || rel === "/"));
}

// pagePath is what the browser reported (location.pathname). Strip the mount
// prefix, then match the manifest routes.
function screenFor(manifest, pagePath) {
  const rel = String(pagePath || "").replace(/^\/c\/[^/]+\/(staging\/)?m\/[^/]+/, "") || "/";
  const entries = pageEntries(manifest);
  // longest route first so /station/:seq beats /station
  entries.sort((a, b) => b.route.length - a.route.length);
  return entries.find((e) => routeMatches(e.route, rel)) || null;
}

// The widget tag carries the company, version and mount so the page can notice a
// deploy and reload itself, and flag itself when it is the staged preview.
function widgetInject(html, company, mod, version, mount) {
  const tag = `<script src="/assets/feedback-widget.js" data-company="${company}" data-module="${mod}" data-version="${version}" data-mount="${mount}"></script>`;
  return html.includes("</body>") ? html.replace("</body>", `${tag}\n</body>`) : html + tag;
}

function buildRouter(company, mod, version, schema) {
  const mount = schema.startsWith("stg_") ? "staged" : "live";
  const dir = versionDir(company, mod, version);
  const manifest = readManifest(company, mod, version);
  const router = express.Router();

  // pages (feedback widget injected into every page)
  for (const { route, file } of pageEntries(manifest)) {
    router.get(route, (req, res) => {
      const html = fs.readFileSync(path.join(dir, file), "utf8");
      res.set("Cache-Control", "no-cache").type("html").send(widgetInject(html, company, mod, version, mount));
    });
  }

  // module routes
  const entry = path.join(dir, manifest.entry || "routes.js");
  delete require.cache[require.resolve(entry)];
  const makeRouter = require(entry);
  const requireManager = (req, res, next) =>
    ["manager", "admin"].includes(req.sosRole) ? next() : res.status(403).json({ error: "manager login required" });
  router.use(makeRouter({ express, db: scopedDb(schema), moduleName: mod, company, requireManager }));
  return router;
}

async function mountLive(company, mod, version) {
  await materialize(company, mod, version);
  await applyMigrations(liveSchema(company, mod), versionDir(company, mod, version));
  const entry = mounts.get(key(company, mod)) || {};
  entry.live = buildRouter(company, mod, version, liveSchema(company, mod));
  mounts.set(key(company, mod), entry);
}

async function mountStaged(company, mod, version) {
  await materialize(company, mod, version);
  await applyMigrations(stagingSchema(company, mod), versionDir(company, mod, version));
  const entry = mounts.get(key(company, mod)) || {};
  entry.staged = buildRouter(company, mod, version, stagingSchema(company, mod));
  mounts.set(key(company, mod), entry);
}

function unmountStaged(company, mod) {
  const entry = mounts.get(key(company, mod));
  if (entry) entry.staged = null;
}

// ---- lifecycle ------------------------------------------------------------
async function nextVersionNumber(company, mod) {
  return Number((await q(
    "SELECT COALESCE(MAX(version),0)+1 AS v FROM platform.module_versions WHERE company=$1 AND module=$2", [company, mod]
  )).rows[0].v);
}

async function insertVersion(company, mod, version, source, notes, files) {
  await q(
    `INSERT INTO platform.module_versions (company, module, version, source, notes, files) VALUES ($1,$2,$3,$4,$5,$6)`,
    [company, mod, version, source, notes, JSON.stringify(files)]);
  writeTree(versionDir(company, mod, version), files);
}

// Repo module library: every modules/<name>/ with a module.json.
function libraryModules() {
  if (!fs.existsSync(REPO_MODULES_DIR)) return [];
  return fs.readdirSync(REPO_MODULES_DIR)
    .filter((m) => fs.existsSync(path.join(REPO_MODULES_DIR, m, "module.json")))
    .map((m) => ({ name: m, ...JSON.parse(fs.readFileSync(path.join(REPO_MODULES_DIR, m, "module.json"), "utf8")) }));
}

// Seed the module's reference doc into the company's editable agent docs.
async function seedModuleDocs(company, mod) {
  const p = path.join(PRINCIPLES_DIR, "module-formats", `${mod}.md`);
  if (!fs.existsSync(p)) return;
  await q(
    `INSERT INTO platform.agent_docs (company, module, name, content, source) VALUES ($1,$2,'reference.md',$3,'repo')
     ON CONFLICT (company, module, name) DO NOTHING`, [company, mod, fs.readFileSync(p, "utf8")]);
}

// Import the repo's seed source for a module into a company. New pairing -> v1
// live. Changed source -> new version, snapshot, deploy.
async function importFromRepo(company, mod) {
  const srcDir = path.join(REPO_MODULES_DIR, mod);
  if (!fs.existsSync(path.join(srcDir, "module.json"))) throw new Error(`no library module named ${mod}`);
  const files = readTree(srcDir);
  const hash = hashFiles(files);
  const manifest = JSON.parse(files["module.json"]);
  const row = await getModule(company, mod);

  if (!row) {
    await q("INSERT INTO platform.modules (company, name, title, live_version, repo_hash) VALUES ($1,$2,$3,1,$4)",
      [company, mod, manifest.title, hash]);
    await insertVersion(company, mod, 1, "repo", "initial version from repo", files);
    await seedModuleDocs(company, mod);
    await logEvent("module_imported", `${company}/${mod}`, { version: 1, hash });
    console.log(`[registry] imported ${company}/${mod} v1 from repo`);
    return { version: 1, changed: true };
  }
  await seedModuleDocs(company, mod);
  if (row.repo_hash === hash) return { version: row.live_version, changed: false };

  // Repo source changed since last import: bring it in as a new version and
  // deploy it through the normal path (snapshot first, migrations applied).
  const version = await nextVersionNumber(company, mod);
  await insertVersion(company, mod, version, "repo", `imported from repo (${hash})`, files);
  await q("UPDATE platform.modules SET title=$3, repo_hash=$4 WHERE company=$1 AND name=$2", [company, mod, manifest.title, hash]);
  if (row.live_version) {
    try {
      await deployVersion(company, mod, version);
      console.log(`[registry] ${company}/${mod}: repo change imported and deployed as v${version}`);
    } catch (e) {
      console.error(`[registry] ${company}/${mod}: repo import v${version} failed to deploy: ${e.message}`);
      await logEvent("module_import_failed", `${company}/${mod}`, { version, error: e.message });
    }
  }
  return { version, changed: true };
}

// Every company gets an editable COMPANY.md the agents read first.
async function seedCompanyDocs() {
  const rows = (await q("SELECT slug, name FROM platform.companies")).rows;
  for (const c of rows) {
    await q(`INSERT INTO platform.agent_docs (company, module, name, content, source) VALUES ($1,NULL,'COMPANY.md',$2,'repo') ON CONFLICT DO NOTHING`,
      [c.slug, `# ${c.name}\n\nWhat the agents should know about this company: what it makes, who is on the floor, what matters most (safety, throughput, quality), vocabulary the floor uses, anything to avoid.\n`]);
  }
}

async function loadAll() {
  fs.mkdirSync(MODULES_DIR, { recursive: true });
  // seed: library modules go to their default company on first boot
  for (const lib of libraryModules()) {
    const company = lib.company || "demo";
    await q("INSERT INTO platform.companies (slug, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [company, company === "demo" ? "Demo Company" : company]);
    if (!(await getModule(company, lib.name))) await importFromRepo(company, lib.name);
  }
  await seedCompanyDocs();
  // refresh every company/module pairing from the repo when its source changed
  const rows = (await q("SELECT * FROM platform.modules ORDER BY company, name")).rows;
  for (const row of rows) {
    if (fs.existsSync(path.join(REPO_MODULES_DIR, row.name, "module.json"))) {
      try { await importFromRepo(row.company, row.name); }
      catch (e) { console.error(`[registry] import ${row.company}/${row.name} failed:`, e.message); }
    }
  }
  for (const row of (await q("SELECT * FROM platform.modules ORDER BY company, name")).rows) {
    if (row.live_version) {
      try { await mountLive(row.company, row.name, row.live_version); }
      catch (e) { console.error(`live mount failed for ${row.company}/${row.name} v${row.live_version}:`, e.message); }
    }
    if (row.staged_version) {
      try { await mountStaged(row.company, row.name, row.staged_version); }
      catch (e) { console.error(`staged mount failed for ${row.company}/${row.name}:`, e.message); }
    }
  }
}

// Create the next version directory as a copy of the current live version.
// The build agent's write surface is exactly this directory.
async function createDraftVersion(company, mod) {
  const row = await getModule(company, mod);
  if (!row) throw new Error(`unknown module ${company}/${mod}`);
  const next = await nextVersionNumber(company, mod);
  const files = await versionFiles(company, mod, row.live_version);
  await insertVersion(company, mod, next, "build", null, files);
  return { version: next, dir: versionDir(company, mod, next) };
}

async function stageVersion(company, mod, version) {
  await persistVersion(company, mod, version);
  await rebuildStagingClone(company, mod);
  await mountStaged(company, mod, version);
  await q("UPDATE platform.modules SET staged_version=$3 WHERE company=$1 AND name=$2", [company, mod, version]);
  await logEvent("version_staged", `${company}/${mod}`, { version });
}

// Drop a staged version without deploying it (cancel at the deploy gate).
async function unstage(company, mod) {
  unmountStaged(company, mod);
  await q("UPDATE platform.modules SET staged_version=NULL WHERE company=$1 AND name=$2", [company, mod]);
  await logEvent("version_unstaged", `${company}/${mod}`, {});
}

async function deployVersion(company, mod, version) {
  const row = await getModule(company, mod);
  const snap = await migrate.snapshotSchema(company, mod, row.live_version);
  await migrate.recordSnapshot(company, mod, row.live_version, snap);
  await mountLive(company, mod, version); // applies the new migrations to live, then remounts
  await q("UPDATE platform.modules SET live_version=$3, staged_version=NULL WHERE company=$1 AND name=$2", [company, mod, version]);
  unmountStaged(company, mod);
  await logEvent("version_deployed", `${company}/${mod}`, { from: row.live_version, to: version, snapshot: snap });
  if (hooks.deployed) Promise.resolve(hooks.deployed(company, mod, version)).catch((e) => console.error("deploy hook failed:", e.message));
  return { from: row.live_version, to: version };
}

async function rollback(company, mod) {
  const row = await getModule(company, mod);
  const snap = (await q(
    "SELECT * FROM platform.schema_snapshots WHERE company=$1 AND module=$2 ORDER BY id DESC LIMIT 1", [company, mod]
  )).rows[0];
  if (!snap) throw new Error("no snapshot to roll back to");
  await migrate.restoreSnapshot(company, mod, snap.file);
  await materialize(company, mod, snap.version);
  const entry = mounts.get(key(company, mod)) || {};
  entry.live = buildRouter(company, mod, snap.version, liveSchema(company, mod));
  mounts.set(key(company, mod), entry);
  await q("UPDATE platform.modules SET live_version=$3 WHERE company=$1 AND name=$2", [company, mod, snap.version]);
  // the snapshot is consumed; the next rollback goes one step further back
  await q("DELETE FROM platform.schema_snapshots WHERE id=$1", [snap.id]);
  await q(`DROP SCHEMA IF EXISTS ${snap.file} CASCADE`);
  await logEvent("rolled_back", `${company}/${mod}`, { from: row.live_version, to: snap.version });
  return { from: row.live_version, to: snap.version };
}

// ---- express wiring -------------------------------------------------------
function attach(app) {
  app.use("/c/:company/m/:module", (req, res, next) => {
    const entry = mounts.get(key(req.params.company, req.params.module));
    if (!entry || !entry.live) return res.status(404).send("module not found");
    entry.live(req, res, next);
  });
  app.use("/c/:company/staging/m/:module", (req, res, next) => {
    const entry = mounts.get(key(req.params.company, req.params.module));
    if (!entry || !entry.staged) return res.status(404).send("no staged version");
    entry.staged(req, res, next);
  });
  // old single-company URLs
  app.use("/m/:module", (req, res) => res.redirect(`/c/demo/m/${req.params.module}${req.url === "/" ? "/" : req.url}`));
  app.use("/staging/m/:module", (req, res) => res.redirect(`/c/demo/staging/m/${req.params.module}${req.url === "/" ? "/" : req.url}`));
}

module.exports = {
  MODULES_DIR, REPO_MODULES_DIR, versionDir, readManifest, pageEntries, screenFor, loadAll, attach,
  createDraftVersion, stageVersion, deployVersion, rollback, versionFiles, persistVersion, importFromRepo,
  unstage, getModule, libraryModules, mountLiveIfNeeded: mountLive, hooks,
};
