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
const { q, scopedDb, logEvent, upsertDoc } = require("./db");
const migrate = require("./migrate");
const gate = require("./modulegate");
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
  // tab and home-screen icon: the company's brand icon when it has one
  const icon = `<link rel="icon" href="/api/c/${company}/icon"><link rel="apple-touch-icon" href="/api/c/${company}/icon">`;
  html = html.includes("</head>") ? html.replace("</head>", `${icon}\n</head>`) : icon + html;
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
  router.use(makeRouter({ express, db: scopedDb(schema), moduleName: mod, company, requireManager, ...moduleServices(company, mod, manifest) }));
  return router;
}

// What the platform lends a module beyond its own tables:
//   peer(name)      read-only query function on a sibling module's LIVE tables
//                   (the same data stream the floor writes to), or null if that
//                   module is not live for this company
//   agentDoc(name)  the company's editable copy of a module doc (agent_docs),
//                   falling back to the file shipped in the module version
//   ai.chat(...)    a plain chat call through the platform's model runner,
//                   under the monthly cap, cost recorded against the company
//   ai.models / ai.modelFor(role)
function moduleServices(company, mod, manifest) {
  const agent = require("./agent");
  return {
    manifest,
    peer(name) {
      const entry = mounts.get(key(company, name));
      if (!entry || !entry.live) return null;
      return scopedDb(liveSchema(company, name), { readOnly: true });
    },
    async agentDoc(name) {
      const r = (await q("SELECT content FROM platform.agent_docs WHERE company=$1 AND module=$2 AND name=$3", [company, mod, name])).rows[0];
      if (r) return r.content;
      const row = await getModule(company, mod);
      const files = row && row.live_version ? await versionFiles(company, mod, row.live_version) : null;
      return files && files[name] ? files[name] : "";
    },
    ai: {
      models: agent.MODELS,
      modelFor: (role) => agent.modelFor(company, role),
      async chat({ model, system, messages, maxTokens, kind, detail }) {
        await agent.assertUnderCap(company);
        const m = model && agent.MODELS.some((x) => x.id === model) ? model : await agent.modelFor(company, "propose");
        const out = await agent.runChat({ model: m, system, messages, maxTokens });
        await agent.recordUsage(company, mod, kind || "chat", m, out.costUsd, detail);
        return { ...out, model: m };
      },
    },
  };
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
    .map((m) => {
      const dir = path.join(REPO_MODULES_DIR, m);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "module.json"), "utf8"));
      const tourPath = path.join(dir, "tour.json");
      const tour = fs.existsSync(tourPath) ? JSON.parse(fs.readFileSync(tourPath, "utf8")) : null;
      const migrations = fs.existsSync(path.join(dir, "migrations")) ? fs.readdirSync(path.join(dir, "migrations")).filter((f) => f.endsWith(".sql")).length : 0;
      return { name: m, ...manifest, screens: pageEntries(manifest), tour, migrations, hash: hashFiles(readTree(dir)) };
    });
}

// The guided tour for a module: tour.json from the version on the floor if it
// has one, else the library copy. Steps: { path, target, title, body }.
async function tourFor(company, mod) {
  const row = company ? await getModule(company, mod) : null;
  if (row && row.live_version) {
    const files = await versionFiles(company, mod, row.live_version);
    if (files && files["tour.json"]) { try { return JSON.parse(files["tour.json"]); } catch (e) { /* fall through */ } }
  }
  const p = path.join(REPO_MODULES_DIR, mod, "tour.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

// Seed the module's reference doc into the company's editable agent docs,
// plus any chat persona the module ships (module.json "agents": { id: { doc,
// label } }; the doc file lives in the module and becomes an editable
// module doc, left out of build guidance).
async function seedModuleDocs(company, mod) {
  const p = path.join(PRINCIPLES_DIR, "module-formats", `${mod}.md`);
  if (fs.existsSync(p)) await upsertDoc(company, mod, "reference.md", fs.readFileSync(p, "utf8"), "repo", true);
  const row = await getModule(company, mod);
  const files = row && row.live_version ? await versionFiles(company, mod, row.live_version) : null;
  if (!files || !files["module.json"]) return;
  let manifest = {};
  try { manifest = JSON.parse(files["module.json"]); } catch (e) { return; }
  for (const a of Object.values(manifest.agents || {})) {
    if (a && a.doc && files[a.doc]) await upsertDoc(company, mod, a.doc, files[a.doc], "repo", true);
  }
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

  // Repo source changed since last import: bring it in as a new version. It
  // deploys on its own only when the floor is still on a repo-sourced version.
  // If the in-app agent has built versions since (the live version's source is
  // "build"), the repo copy is behind that work, so the import waits in the
  // Versions panel for the manager to Switch to it, and nothing is superseded.
  const version = await nextVersionNumber(company, mod);
  await insertVersion(company, mod, version, "repo", `imported from repo (${hash})`, files);
  await q("UPDATE platform.modules SET title=$3, repo_hash=$4 WHERE company=$1 AND name=$2", [company, mod, manifest.title, hash]);
  const live = row.live_version
    ? (await q("SELECT source FROM platform.module_versions WHERE company=$1 AND module=$2 AND version=$3", [company, mod, row.live_version])).rows[0]
    : null;
  if (row.live_version && live && live.source !== "repo") {
    console.log(`[registry] ${company}/${mod}: repo change imported as v${version} but NOT deployed (v${row.live_version} on the floor was built in-app)`);
    await logEvent("module_import_held", `${company}/${mod}`, { version, hash, live_version: row.live_version });
    return { version, changed: true, held: true };
  }
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
    await upsertDoc(c.slug, null, "COMPANY.md", `# ${c.name}\n\nWhat the agents should know about this company: what it makes, who is on the floor, what matters most (safety, throughput, quality), vocabulary the floor uses, anything to avoid.\n`, "repo", true);
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
      // Never refuse what is already on the floor (that would take a module
      // down on a platform deploy); say so loudly instead.
      try {
        const verdict = gate.check({ files: (await versionFiles(row.company, row.name, row.live_version)) || {}, lane: null });
        if (!verdict.ok) console.warn(`[gate] ${row.company}/${row.name} v${row.live_version} is on the floor with code a new build would be refused for: ${gate.oneLine(verdict)}`);
      } catch (e) { console.error(`[gate] could not check ${row.company}/${row.name}:`, e.message); }
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

// Remove a draft version that never reached staging (an aborted build).
async function dropDraftVersion(company, mod, version) {
  const row = await getModule(company, mod);
  if (!row || row.live_version === version || row.staged_version === version) throw new Error("version is in use");
  const v = (await q("SELECT source FROM platform.module_versions WHERE company=$1 AND module=$2 AND version=$3", [company, mod, version])).rows[0];
  if (!v || v.source !== "build") return;
  await q("DELETE FROM platform.module_versions WHERE company=$1 AND module=$2 AND version=$3", [company, mod, version]);
  fs.rmSync(versionDir(company, mod, version), { recursive: true, force: true });
  await logEvent("draft_dropped", `${company}/${mod}`, { version });
}

// Forget every mount of a company (company deletion).
function unmountCompany(company) {
  for (const k of [...mounts.keys()]) if (k.startsWith(`${company}/`)) mounts.delete(k);
  fs.rmSync(path.join(MODULES_DIR, company), { recursive: true, force: true });
}

// ---- the gate at the door ---------------------------------------------------
// Every path that puts a version's code into this process for the first time
// (stage, deploy, switch) asks the module gate first (src/modulegate.js). The
// pipeline runs the gate itself, with the lane rules, right after a build; this
// is the backstop for every other way in: the Versions panel can switch to
// any stored version, including a draft the gate refused and a retry left
// behind. A version that has been on the floor before is let through, so a
// rollback is never refused: whatever it carries was already running.
// Anything else is checked against the version on the floor, which
// grandfathers the findings it inherited.
async function wasEverLive(company, mod, version) {
  const row = await getModule(company, mod);
  if (row && Number(row.live_version) === Number(version)) return true;
  // Three records can show it: the event log (refs were the bare module name
  // before the instance held several companies), a build run that deployed
  // it, or a data snapshot taken while it was live.
  const r = await q(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM platform.events WHERE ref IN ($1, $4) AND (
                (kind IN ('version_deployed','version_switched') AND detail->>'to' = $2)
             OR (kind = 'module_imported' AND detail->>'version' = $2)))
        OR EXISTS (SELECT 1 FROM platform.build_runs WHERE company=$3 AND module=$4 AND to_version=$5 AND status IN ('deployed','rolled_back'))
        OR EXISTS (SELECT 1 FROM platform.schema_snapshots WHERE company=$3 AND module=$4 AND version=$5)`,
    [`${company}/${mod}`, String(version), company, mod, Number(version)]);
  return r.rows.length > 0;
}
async function assertGate(company, mod, version) {
  const files = await versionFiles(company, mod, version);
  if (!files) return;
  if (await wasEverLive(company, mod, version)) return;
  const row = await getModule(company, mod);
  const fromFiles = row && row.live_version && Number(row.live_version) !== Number(version) ? await versionFiles(company, mod, row.live_version) : null;
  const verdict = gate.check({ files, fromFiles, lane: null });
  if (verdict.ok) return;
  await logEvent("gate_refused", `${company}/${mod}`, { version: Number(version), at: "registry", rules: verdict.violations.map((f) => f.rule) });
  const e = new Error(`the platform's own checks refuse version ${version}: ${gate.oneLine(verdict)}`);
  e.gate = verdict;
  throw e;
}

async function stageVersion(company, mod, version) {
  await persistVersion(company, mod, version);
  await assertGate(company, mod, version);
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
  await assertGate(company, mod, version);
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

// One step back with data (the Done card's Roll back button). Same machinery
// as goToVersion, so it is itself reversible.
async function rollback(company, mod) {
  const row = await getModule(company, mod);
  const snap = (await q(
    "SELECT * FROM platform.schema_snapshots WHERE company=$1 AND module=$2 AND version < $3 ORDER BY version DESC, id DESC LIMIT 1", [company, mod, row.live_version]
  )).rows[0];
  if (!snap) throw new Error("no snapshot to roll back to");
  return goToVersion(company, mod, snap.version, { restoreData: true });
}

// Jump to any version, back or forward. Two modes:
//  - keep data (default): the current data stays, the target version's code is
//    mounted. Migrations are additive-only, so an older version simply ignores
//    columns and tables it never knew about, and a newer version re-applies
//    any migrations the schema is missing.
//  - restore data: the data is replaced with the snapshot taken when that
//    version was last live (the state of the line when we left it). Only
//    possible while that snapshot is still within retention.
// Either way the current state is snapshotted first, so the jump itself is
// reversible with restore.
async function versionHistory(company, mod) {
  const row = await getModule(company, mod);
  if (!row) throw new Error("unknown module");
  const versions = (await q(
    `SELECT v.version, v.source, v.notes, v.created_at,
            (SELECT r.evidence->>'build_summary' FROM platform.build_runs r WHERE r.company=v.company AND r.module=v.module AND r.to_version=v.version ORDER BY r.id DESC LIMIT 1) AS summary,
            EXISTS (SELECT 1 FROM platform.schema_snapshots s WHERE s.company=v.company AND s.module=v.module AND s.version=v.version) AS has_snapshot
       FROM platform.module_versions v WHERE v.company=$1 AND v.module=$2 ORDER BY v.version DESC`, [company, mod])).rows;
  // A draft the build agent wrote that never reached the floor was never
  // approved by anyone: it failed a check, was cancelled at the gate, or is
  // still waiting at it. The panel says so and offers no Switch (goToVersion
  // refuses it as well); the way onto the floor is its build's deploy gate.
  for (const v of versions) {
    v.ever_live = await wasEverLive(company, mod, v.version);
    v.never_approved = v.source === "build" && !v.ever_live;
  }
  return { live_version: row.live_version, staged_version: row.staged_version, versions };
}

async function goToVersion(company, mod, version, { restoreData = false } = {}) {
  const row = await getModule(company, mod);
  if (!row) throw new Error("unknown module");
  version = Number(version);
  if (!(await versionFiles(company, mod, version))) throw new Error(`version ${version} does not exist`);
  if (version === row.live_version) throw new Error(`version ${version} is already live`);
  // Switch is for going back, and for a held copy from the library. A draft
  // the build agent wrote that was never on the floor has never been through
  // a manager's deploy gate; switching to it would walk around the review
  // that stopped it (or is still waiting on it).
  const src = (await q("SELECT source FROM platform.module_versions WHERE company=$1 AND module=$2 AND version=$3", [company, mod, version])).rows[0];
  if (src && src.source === "build" && !(await wasEverLive(company, mod, version))) {
    throw new Error(`version ${version} was never approved for the floor; it can only go live through its own build's deploy gate`);
  }
  await assertGate(company, mod, version);
  let target = null;
  if (restoreData) {
    target = (await q(
      "SELECT * FROM platform.schema_snapshots WHERE company=$1 AND module=$2 AND version=$3 ORDER BY id DESC LIMIT 1", [company, mod, version])).rows[0];
    if (!target) throw new Error(`no data snapshot left for version ${version}; switch without restoring data instead`);
  }
  // save where we are so this jump can be undone with restore
  const snap = await migrate.snapshotSchema(company, mod, row.live_version);
  await migrate.recordSnapshot(company, mod, row.live_version, snap);
  await mountLive(company, mod, version); // applies any migrations the schema is missing (no-op going back)
  if (target) {
    await migrate.restoreSnapshot(company, mod, target.file);
    await q("DELETE FROM platform.schema_snapshots WHERE id=$1", [target.id]);
    await q(`DROP SCHEMA IF EXISTS ${target.file} CASCADE`);
  }
  await q("UPDATE platform.modules SET live_version=$3 WHERE company=$1 AND name=$2", [company, mod, version]);
  await logEvent("version_switched", `${company}/${mod}`, { from: row.live_version, to: version, restored: !!target, saved: snap });
  if (hooks.deployed) Promise.resolve(hooks.deployed(company, mod, version)).catch((e) => console.error("deploy hook failed:", e.message));
  return { from: row.live_version, to: version, restored: !!target };
}

// ---- express wiring -------------------------------------------------------
// ---- what a module's pages may do in the browser ----------------------------------
// A module's pages are written by the build agent and open in the manager's
// browser with the manager's session, on the same origin as the board. Left
// alone, a staged preview could call the platform's own controls as the
// manager (approve, deploy) and walk around the structural manager gate. So
// everything served under a module mount, the pages the platform serves AND
// whatever the module's own routes answer, carries a Content-Security-Policy
// that ties the browser to that module: requests and form posts only to the
// module's own live and staged paths plus the three things the feedback widget
// needs; no popups (a popup of the board is same-origin and scriptable), no
// frames, no service workers, nothing loaded from outside. Navigation is not
// restricted: a link to the board leaves the page, and the new page is the
// platform's own. Like the module gate, this narrows what careless or steered
// code can do; the real fix is module pages on an origin of their own.
function modulePagePolicy(req, company, mod) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const safeHost = /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? host : null;
  const at = (p) => (safeHost ? `${safeHost}${p}` : "'self'");
  const own = [`/c/${company}/m/${mod}/`, `/c/${company}/staging/m/${mod}/`];
  const connect = [...own, "/api/feedback", `/api/c/${company}/modules/${mod}/`].map(at);
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    `connect-src ${[...new Set(connect)].join(" ")}`,
    `form-action ${[...new Set(own.map(at))].join(" ")}`,
    "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "object-src 'none'", "base-uri 'none'",
    "frame-ancestors 'self'",
    "sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-downloads",
  ].join("; ");
}
const LOCKED_HEADER = /^(content-security-policy|content-security-policy-report-only|service-worker-allowed)$/i;
function lockDown(req, res) {
  res.setHeader("Content-Security-Policy", modulePagePolicy(req, req.params.company, req.params.module));
  res.setHeader("X-Content-Type-Options", "nosniff");
  // module code answers on this same response object; keep it from dropping or widening the policy
  const set = res.setHeader.bind(res), remove = res.removeHeader.bind(res), head = res.writeHead.bind(res);
  res.setHeader = (name, value) => (LOCKED_HEADER.test(String(name)) ? res : set(name, value));
  res.removeHeader = (name) => (LOCKED_HEADER.test(String(name)) ? undefined : remove(name));
  res.writeHead = (status, ...rest) => {
    for (const h of rest) if (h && typeof h === "object" && !Array.isArray(h)) for (const k of Object.keys(h)) if (LOCKED_HEADER.test(k)) delete h[k];
    return head(status, ...rest);
  };
}

function attach(app) {
  app.use("/c/:company/m/:module", (req, res, next) => {
    const entry = mounts.get(key(req.params.company, req.params.module));
    if (!entry || !entry.live) return res.status(404).send("module not found");
    lockDown(req, res);
    entry.live(req, res, next);
  });
  app.use("/c/:company/staging/m/:module", (req, res, next) => {
    const entry = mounts.get(key(req.params.company, req.params.module));
    if (!entry || !entry.staged) return res.status(404).send("no staged version");
    lockDown(req, res);
    entry.staged(req, res, next);
  });
  // old single-company URLs
  app.use("/m/:module", (req, res) => res.redirect(`/c/demo/m/${req.params.module}${req.url === "/" ? "/" : req.url}`));
  app.use("/staging/m/:module", (req, res) => res.redirect(`/c/demo/staging/m/${req.params.module}${req.url === "/" ? "/" : req.url}`));
}

module.exports = {
  MODULES_DIR, REPO_MODULES_DIR, versionDir, readManifest, pageEntries, screenFor, loadAll, attach,
  createDraftVersion, stageVersion, deployVersion, rollback, goToVersion, versionHistory, versionFiles, persistVersion, importFromRepo,
  unstage, getModule, libraryModules, tourFor, mountLiveIfNeeded: mountLive, hooks, materialize, dropDraftVersion, unmountCompany,
};
