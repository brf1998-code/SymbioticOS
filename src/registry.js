// Module registry + runtime mounting.
//
// A module version is a set of files:
//   module.json  { name, title, entry, pages: {"/": "pages/board.html"}, smoke: ["/api/state"] }
//   routes.js    module.exports = (ctx) => express.Router   (ctx: { express, db, moduleName, requireManager })
//   pages/*.html served per the pages map, with the feedback widget auto-injected
//   migrations/NNN.sql   validated + applied by the platform (see migrate.js)
//
// Where versions live:
//   - The DATABASE is the source of truth (platform.module_versions.files). A
//     platform redeploy on Railway wipes the container disk; nothing is lost.
//   - Versions are materialized to MODULES_DIR/<name>/versions/<n>/ at boot and
//     when created, because require() and the build agent need real files.
//   - The REPO ships seed sources at modules/<name>/ (no version number). On
//     boot, a module the DB has never seen is imported as v1. If the repo files
//     change later (Brendan revises a module from Cowork and pushes), the new
//     source is imported as the next version and deployed through the same
//     snapshot + migrate path an agent build uses.
//
// Live version mounts at /m/<name>/... ; staged version at /staging/m/<name>/...
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

// in-memory mount table: name -> { live: router|null, staged: router|null }
const mounts = new Map();

function versionDir(mod, version) {
  return path.join(MODULES_DIR, mod, "versions", String(version));
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

async function versionFiles(mod, version) {
  const row = (await q("SELECT files FROM platform.module_versions WHERE module=$1 AND version=$2", [mod, version])).rows[0];
  return row ? row.files : null;
}

async function materialize(mod, version) {
  const dir = versionDir(mod, version);
  if (fs.existsSync(path.join(dir, "module.json"))) return dir;
  const files = await versionFiles(mod, version);
  if (!files) throw new Error(`no files stored for ${mod} v${version}`);
  writeTree(dir, files);
  return dir;
}

// Read a version directory back into the database (after an agent build).
async function persistVersion(mod, version) {
  const files = readTree(versionDir(mod, version));
  await q("UPDATE platform.module_versions SET files=$3 WHERE module=$1 AND version=$2",
    [mod, version, JSON.stringify(files)]);
  return files;
}

function readManifest(mod, version) {
  const p = path.join(versionDir(mod, version), "module.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function widgetInject(html, mod) {
  const tag = `<script src="/assets/feedback-widget.js" data-module="${mod}"></script>`;
  return html.includes("</body>") ? html.replace("</body>", `${tag}\n</body>`) : html + tag;
}

function buildRouter(mod, version, schema) {
  const dir = versionDir(mod, version);
  const manifest = readManifest(mod, version);
  const router = express.Router();

  // pages (feedback widget injected into every page)
  for (const [route, file] of Object.entries(manifest.pages || {})) {
    router.get(route, (req, res) => {
      const html = fs.readFileSync(path.join(dir, file), "utf8");
      res.set("Cache-Control", "no-cache").type("html").send(widgetInject(html, mod));
    });
  }

  // module routes
  const entry = path.join(dir, manifest.entry || "routes.js");
  delete require.cache[require.resolve(entry)];
  const makeRouter = require(entry);
  const requireManager = (req, res, next) =>
    req.sosRole === "manager" ? next() : res.status(403).json({ error: "manager login required" });
  router.use(makeRouter({ express, db: scopedDb(schema), moduleName: mod, requireManager }));
  return router;
}

async function mountLive(mod, version) {
  await materialize(mod, version);
  await applyMigrations(mod, liveSchema(mod), versionDir(mod, version));
  const entry = mounts.get(mod) || {};
  entry.live = buildRouter(mod, version, liveSchema(mod));
  mounts.set(mod, entry);
}

async function mountStaged(mod, version) {
  await materialize(mod, version);
  await applyMigrations(mod, stagingSchema(mod), versionDir(mod, version));
  const entry = mounts.get(mod) || {};
  entry.staged = buildRouter(mod, version, stagingSchema(mod));
  mounts.set(mod, entry);
}

function unmountStaged(mod) {
  const entry = mounts.get(mod);
  if (entry) entry.staged = null;
}

// ---- lifecycle ------------------------------------------------------------
async function nextVersionNumber(mod) {
  return Number((await q(
    "SELECT COALESCE(MAX(version),0)+1 AS v FROM platform.module_versions WHERE module=$1", [mod]
  )).rows[0].v);
}

async function insertVersion(mod, version, source, notes, files) {
  await q(
    `INSERT INTO platform.module_versions (module, version, source, notes, files) VALUES ($1,$2,$3,$4,$5)`,
    [mod, version, source, notes, JSON.stringify(files)]);
  writeTree(versionDir(mod, version), files);
}

// Import the repo's seed source for a module. New module -> v1 live.
// Changed source -> new version, snapshot, deploy.
async function importFromRepo(mod) {
  const srcDir = path.join(REPO_MODULES_DIR, mod);
  if (!fs.existsSync(path.join(srcDir, "module.json"))) return;
  const files = readTree(srcDir);
  const hash = hashFiles(files);
  const manifest = JSON.parse(files["module.json"]);
  const row = (await q("SELECT * FROM platform.modules WHERE name=$1", [mod])).rows[0];

  if (!row) {
    await q("INSERT INTO platform.modules (name, title, live_version, repo_hash) VALUES ($1,$2,1,$3)",
      [mod, manifest.title, hash]);
    await insertVersion(mod, 1, "repo", "initial version from repo", files);
    await logEvent("module_imported", mod, { version: 1, hash });
    console.log(`[registry] imported ${mod} v1 from repo`);
    return;
  }
  if (row.repo_hash === hash) return;

  // Repo source changed since last import: bring it in as a new version and
  // deploy it through the normal path (snapshot first, migrations applied).
  const version = await nextVersionNumber(mod);
  await insertVersion(mod, version, "repo", `imported from repo (${hash})`, files);
  await q("UPDATE platform.modules SET title=$2, repo_hash=$3 WHERE name=$1", [mod, manifest.title, hash]);
  if (row.live_version) {
    try {
      await deployVersion(mod, version);
      console.log(`[registry] ${mod}: repo change imported and deployed as v${version}`);
    } catch (e) {
      console.error(`[registry] ${mod}: repo import v${version} failed to deploy: ${e.message}`);
      await logEvent("module_import_failed", mod, { version, error: e.message });
    }
  }
}

async function loadAll() {
  fs.mkdirSync(MODULES_DIR, { recursive: true });
  if (fs.existsSync(REPO_MODULES_DIR)) {
    for (const mod of fs.readdirSync(REPO_MODULES_DIR)) await importFromRepo(mod);
  }
  const rows = (await q("SELECT * FROM platform.modules ORDER BY name")).rows;
  for (const row of rows) {
    const mod = row.name;
    if (row.live_version) {
      try { await mountLive(mod, row.live_version); }
      catch (e) { console.error(`live mount failed for ${mod} v${row.live_version}:`, e.message); }
    }
    if (row.staged_version) {
      try { await mountStaged(mod, row.staged_version); }
      catch (e) { console.error(`staged mount failed for ${mod}:`, e.message); }
    }
  }
}

// Create the next version directory as a copy of the current live version.
// The build agent's write surface is exactly this directory.
async function createDraftVersion(mod) {
  const row = (await q("SELECT * FROM platform.modules WHERE name=$1", [mod])).rows[0];
  if (!row) throw new Error(`unknown module ${mod}`);
  const next = await nextVersionNumber(mod);
  const files = await versionFiles(mod, row.live_version);
  await insertVersion(mod, next, "build", null, files);
  return { version: next, dir: versionDir(mod, next) };
}

async function stageVersion(mod, version) {
  await persistVersion(mod, version);
  await rebuildStagingClone(mod);
  await mountStaged(mod, version);
  await q("UPDATE platform.modules SET staged_version=$2 WHERE name=$1", [mod, version]);
  await logEvent("version_staged", mod, { version });
}

async function deployVersion(mod, version) {
  const row = (await q("SELECT * FROM platform.modules WHERE name=$1", [mod])).rows[0];
  const snap = await migrate.snapshotSchema(mod, row.live_version);
  await migrate.recordSnapshot(mod, row.live_version, snap);
  await mountLive(mod, version); // applies the new migrations to live, then remounts
  await q("UPDATE platform.modules SET live_version=$2, staged_version=NULL WHERE name=$1", [mod, version]);
  unmountStaged(mod);
  await logEvent("version_deployed", mod, { from: row.live_version, to: version, snapshot: snap });
  return { from: row.live_version, to: version };
}

async function rollback(mod) {
  const row = (await q("SELECT * FROM platform.modules WHERE name=$1", [mod])).rows[0];
  const snap = (await q(
    "SELECT * FROM platform.schema_snapshots WHERE module=$1 ORDER BY id DESC LIMIT 1", [mod]
  )).rows[0];
  if (!snap) throw new Error("no snapshot to roll back to");
  await migrate.restoreSnapshot(mod, snap.file);
  await materialize(mod, snap.version);
  const entry = mounts.get(mod) || {};
  entry.live = buildRouter(mod, snap.version, liveSchema(mod));
  mounts.set(mod, entry);
  await q("UPDATE platform.modules SET live_version=$2 WHERE name=$1", [mod, snap.version]);
  // the snapshot is consumed; the next rollback goes one step further back
  await q("DELETE FROM platform.schema_snapshots WHERE id=$1", [snap.id]);
  await q(`DROP SCHEMA IF EXISTS ${snap.file} CASCADE`);
  await logEvent("rolled_back", mod, { from: row.live_version, to: snap.version });
  return { from: row.live_version, to: snap.version };
}

// ---- express wiring -------------------------------------------------------
function attach(app) {
  app.use("/m/:module", (req, res, next) => {
    const entry = mounts.get(req.params.module);
    if (!entry || !entry.live) return res.status(404).send("module not found");
    entry.live(req, res, next);
  });
  app.use("/staging/m/:module", (req, res, next) => {
    const entry = mounts.get(req.params.module);
    if (!entry || !entry.staged) return res.status(404).send("no staged version");
    entry.staged(req, res, next);
  });
}

module.exports = {
  MODULES_DIR, REPO_MODULES_DIR, versionDir, readManifest, loadAll, attach,
  createDraftVersion, stageVersion, deployVersion, rollback, versionFiles, persistVersion, importFromRepo,
};
