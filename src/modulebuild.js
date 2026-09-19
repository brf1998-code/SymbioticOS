// Building a brand-new module from a confirmed design (docs/MODULE-CREATION.md,
// "The build"). Runs through the same build_runs table and the same gates as a
// change build, in its own lane ("module"): build -> cross_check -> test_run ->
// await_deploy. The pipeline delegates here for that lane; deploy, cancel,
// retry, fix and override are the pipeline's own, with two small hooks.
//
// The agent starts from a working skeleton the platform writes from the design
// (one table of the thing, its stages, one board screen), so a build that runs
// out of road still leaves a module that boots. Platform checks (no tokens)
// run before staging; a failure there is filed like a failed cross-check so
// the manager gets the same fix / retry / cancel choices.
const fs = require("fs");
const path = require("path");
const { q, logEvent, upsertDoc } = require("./db");
const agent = require("./agent");
const registry = require("./registry");
const migrate = require("./migrate");
const gate = require("./modulegate");
const { record } = require("./record");
const attachments = require("./attachments");
const plain = require("./plainwords");
const Q = require("./intake-questions");

const PRINCIPLES_DIR = process.env.PRINCIPLES_DIR || path.join(__dirname, "..", "principles");
const MODULE_MAX_TURNS = Number(process.env.SOS_MODULE_MAX_TURNS || 150);
const pipe = () => require("./pipeline");
const readDoc = (name) => { const p = path.join(PRINCIPLES_DIR, name); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; };
const sq = (s) => String(s == null ? "" : s).replace(/'/g, "''");

// ---- the skeleton --------------------------------------------------------------------
// A small working module from the design: the thing, its stages, one screen.
function skeleton({ slug, title, design, answers, startingRows }) {
  const thing = String((answers && answers.thing) || "item").trim() || "item";
  const stages = (Array.isArray(answers && answers.stages) ? answers.stages : []).map((s) => String(s).trim()).filter(Boolean);
  const STAGES = stages.length >= 2 ? stages : ["new", "in work", "done"];
  const seed = (startingRows || []).map((r) => (Array.isArray(r) ? r[0] : r)).map((v) => String(v || "").trim()).filter(Boolean).slice(0, 200);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const files = {};
  files["module.json"] = JSON.stringify({
    name: slug, title, description: String((design && design.bluf) || `Tracks each ${thing} through its stages.`).slice(0, 400),
    entry: "routes.js",
    pages: { "/": { file: "pages/board.html", label: `${title} board` } },
    smoke: ["/api/items", "/api/stats"],
  }, null, 2) + "\n";
  files["migrations/001.sql"] = `CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '${sq(STAGES[0])}',
  assigned_to TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  moved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS items_stage ON items (stage);
` + (seed.length ? `INSERT INTO items (name) VALUES\n${seed.map((v) => `  ('${sq(v)}')`).join(",\n")};\n` : "");
  files["routes.js"] = `// ${title}: first version, built from the design. One list of the thing
// (${thing}) moving through its stages. Plain express router; ctx.db is a query
// function pinned to this module's own tables.
const STAGES = ${JSON.stringify(STAGES)};

module.exports = function makeRouter(ctx) {
  const { express, db, requireManager } = ctx;
  const router = express.Router();
  router.use(express.json());

  router.get("/api/items", async (req, res) => {
    const rows = (await db("SELECT * FROM items ORDER BY moved_at DESC, id DESC")).rows;
    res.json({ stages: STAGES, items: rows });
  });

  router.get("/api/stats", async (req, res) => {
    const rows = (await db("SELECT stage, count(*)::int AS n, EXTRACT(EPOCH FROM (now() - min(moved_at)))/3600 AS oldest_hours FROM items GROUP BY stage")).rows;
    const by = {};
    for (const r of rows) by[r.stage] = { count: r.n, oldest_hours: Math.round(Number(r.oldest_hours || 0) * 10) / 10 };
    res.json({ stages: STAGES.map((s) => ({ stage: s, count: (by[s] || {}).count || 0, oldest_hours: (by[s] || {}).oldest_hours || 0 })), total: rows.reduce((a, r) => a + r.n, 0) });
  });

  router.post("/api/items", async (req, res) => {
    const name = String((req.body || {}).name || "").trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: "a name is needed" });
    const note = String((req.body || {}).note || "").trim().slice(0, 500) || null;
    const r = await db("INSERT INTO items (name, note) VALUES ($1, $2) RETURNING *", [name, note]);
    res.json(r.rows[0]);
  });

  router.post("/api/items/:id/move", async (req, res) => {
    const stage = String((req.body || {}).stage || "");
    if (!STAGES.includes(stage)) return res.status(400).json({ error: "not one of the stages" });
    const r = await db("UPDATE items SET stage=$2, moved_at=now() WHERE id=$1 RETURNING *", [Number(req.params.id), stage]);
    if (!r.rows.length) return res.status(404).json({ error: "not found" });
    res.json(r.rows[0]);
  });

  router.post("/api/items/:id/assign", async (req, res) => {
    const who = String((req.body || {}).assigned_to || "").trim().slice(0, 80) || null;
    const r = await db("UPDATE items SET assigned_to=$2, moved_at=moved_at WHERE id=$1 RETURNING *", [Number(req.params.id), who]);
    if (!r.rows.length) return res.status(404).json({ error: "not found" });
    res.json(r.rows[0]);
  });

  return router;
};
`;
  files["pages/board.html"] = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { --ink:#1c242e; --steel:#51606f; --line:#d5dbe3; --fog:#f2f4f7; --navy:#1f3a5f; --amber:#c2620a; --green:#2e7d4f; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:system-ui,sans-serif; background:var(--fog); color:var(--ink); padding:14px; }
  h1 { font-size:20px; margin-bottom:10px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:8px; margin-bottom:12px; }
  .stat { background:#fff; border:1px solid var(--line); border-radius:10px; padding:10px; }
  .stat b { display:block; font-size:22px; } .stat span { font-size:11px; color:var(--steel); text-transform:uppercase; letter-spacing:.05em; }
  form { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
  input { font:inherit; font-size:15px; padding:10px; border:1px solid var(--line); border-radius:8px; flex:1 1 200px; }
  button { font:inherit; font-size:14px; font-weight:700; padding:10px 14px; border:none; border-radius:8px; background:var(--navy); color:#fff; cursor:pointer; min-height:40px; }
  .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px; }
  .col { background:#e9edf2; border-radius:12px; padding:8px; }
  .col h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--steel); margin:4px 4px 8px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:10px; margin-bottom:8px; font-size:14px; }
  .card .who { font-size:12px; color:var(--steel); margin-top:2px; }
  .card .age { font-size:11.5px; color:var(--amber); margin-top:2px; }
  .card button { margin-top:8px; background:var(--green); font-size:13px; padding:8px 12px; }
  .empty { color:var(--steel); font-size:13px; padding:8px 4px; }
</style>
</head>
<body>
  <h1 id="title">${title}</h1>
  <div class="stats" id="stats"></div>
  <form id="add" data-changed="v1">
    <input id="name" placeholder="Add a ${thing}" maxlength="200" required>
    <button type="submit">Add</button>
  </form>
  <div class="cols" id="board" data-changed="v1"></div>
<script>
const base = location.pathname.match(/^.*?\\/(?:staging\\/)?m\\/[^/]+/)[0];
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
let STAGES = [];
async function load() {
  const [items, stats] = await Promise.all([fetch(base + "/api/items").then((r) => r.json()), fetch(base + "/api/stats").then((r) => r.json())]);
  STAGES = items.stages;
  document.getElementById("stats").innerHTML = stats.stages.map((s) => '<div class="stat"><b>' + s.count + '</b><span>' + esc(s.stage) + (s.oldest_hours > 24 ? ' · oldest ' + Math.round(s.oldest_hours / 24) + ' d' : '') + '</span></div>').join("");
  document.getElementById("board").innerHTML = STAGES.map((stage, i) => {
    const next = STAGES[i + 1];
    const rows = items.items.filter((x) => x.stage === stage);
    return '<div class="col"><h2>' + esc(stage) + ' <span>' + rows.length + '</span></h2>' + (rows.length ? rows.map((x) => {
      const hours = Math.round((Date.now() - new Date(x.moved_at).getTime()) / 36e5);
      return '<div class="card" id="item-' + x.id + '"><b>' + esc(x.name) + '</b>' + (x.assigned_to ? '<div class="who">' + esc(x.assigned_to) + '</div>' : '') + (hours >= 1 ? '<div class="age">' + hours + ' h here</div>' : '') + (next ? '<button onclick="move(' + x.id + ',' + JSON.stringify(next).replace(/"/g, '&quot;') + ')">Move to ' + esc(next) + '</button>' : '') + '</div>';
    }).join("") : '<div class="empty">Nothing here.</div>') + '</div>';
  }).join("");
}
async function move(id, stage) {
  await fetch(base + "/api/items/" + id + "/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage }) });
  load();
}
document.getElementById("add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("name").value.trim();
  if (!name) return;
  await fetch(base + "/api/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  document.getElementById("name").value = "";
  load();
});
load();
setInterval(load, 5000);
</script>
</body>
</html>
`;
  files["tour.json"] = JSON.stringify({
    title: `${title} in a minute`,
    intro: `One board for every ${thing}: where each one is, how long it has sat there, and one button to move it along. ${cap(thing)}s go through ${STAGES.join(", then ")}.`,
    steps: [
      { path: "/", target: "#stats", title: "The numbers", body: `How many ${thing}s sit at each stage, and how long the oldest has been waiting.` },
      { path: "/", target: "#board", title: "One column per stage", body: `Each ${thing} is a card. The button moves it to the next stage.` },
      { path: "/", target: "#add", title: `Add a ${thing}`, body: "Type its name and press Add. It starts at the first stage." },
      { path: "/", target: "#sos-fb-btn", title: "The feedback button", body: "Something in the way? Say it here, from the screen where it happened. It goes straight to the improvement board." },
    ],
  }, null, 2) + "\n";
  return files;
}

// ---- start --------------------------------------------------------------------------------
async function startBuild(intake) {
  const design = intake.design;
  if (!design) throw new Error("no design to build from");
  const { company, slug, name: title } = intake;
  if (!slug) throw new Error("the module has no name");
  if (await registry.getModule(company, slug)) throw new Error(`a module named "${slug}" already exists`);
  const model = intake.model || require("./intake").INTAKE_MODEL;
  // starting rows: the first spreadsheet attached to the intake
  const files = await attachments.list(intake.id);
  const sheet = (await Promise.all(files.filter((a) => a.kind === "sheet").map((a) => attachments.get(a.id)))).find((a) => a && a.parsed && a.parsed.rows && a.parsed.rows.length);
  const startingRows = sheet ? sheet.parsed.rows : [];
  await q("INSERT INTO platform.modules (company, name, title, live_version, staged_version) VALUES ($1,$2,$3,NULL,NULL)", [company, slug, title]);
  const seed = skeleton({ slug, title, design, answers: intake.answers || {}, startingRows });
  await q(`INSERT INTO platform.module_versions (company, module, version, source, notes, files) VALUES ($1,$2,1,'build',$3,$4)`,
    [company, slug, `First version of ${title}, built from the design`, JSON.stringify(seed)]);
  await registry.materialize(company, slug, 1);
  await upsertDoc(company, slug, "reference.md", design.reference_md || "", "agent", false);
  const p = (await q(
    `INSERT INTO platform.proposals (feedback_id, body, class, target_file, rationale, status, model) VALUES ($1,$2,'functionality',NULL,'Module creation from a confirmed design','approved',$3) RETURNING id`,
    [intake.feedback_id, String(design.bluf || `Build ${title}`).slice(0, 2000), model])).rows[0];
  const run = (await q(
    `INSERT INTO platform.build_runs (proposal_id, proposal_ids, company, module, from_version, to_version, lane, step, status, model, requirement, evidence)
     VALUES ($1,$2,$3,$4,NULL,1,'module','build','running',$5,$6,$7) RETURNING *`,
    [p.id, [p.id], company, slug, model, design.reference_md || design.bluf || "", JSON.stringify({ intake_id: intake.id, module_title: title, design_bluf: design.bluf, title: `First version of ${title}`, estimate_usd: design.estimate_usd, seed_rows: startingRows.length })])).rows[0];
  await q("UPDATE platform.feedback SET status='in_progress', updated_at=now() WHERE id=$1", [intake.feedback_id]);
  await q("UPDATE platform.module_intakes SET status='building', run_ids=array_append(COALESCE(run_ids, '{}'), $2), updated_at=now() WHERE id=$1", [intake.id, run.id]);
  await logEvent("module_build_started", run.id, { company, module: slug, intake: intake.id, model, seed_rows: startingRows.length });
  pipe().advance(run.id).catch((e) => pipe().failRun(run.id, e));
  return run;
}

// ---- checks that need no tokens --------------------------------------------------------------
function validateModule(dir, slug) {
  const errors = [];
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, "module.json"), "utf8")); }
  catch (e) { errors.push(`module.json does not parse: ${e.message}`); }
  if (manifest) {
    if (manifest.name !== slug) errors.push(`module.json "name" must stay "${slug}" (it is "${manifest.name}")`);
    if (!manifest.title) errors.push('module.json needs a "title"');
    const pages = registry.pageEntries(manifest);
    if (!pages.length) errors.push('module.json "pages" is empty; the module needs at least one screen');
    for (const pg of pages) if (!fs.existsSync(path.join(dir, pg.file))) errors.push(`module.json points at ${pg.file} for ${pg.route}, but that file does not exist`);
    if (!fs.existsSync(path.join(dir, manifest.entry || "routes.js"))) errors.push(`the entry file ${manifest.entry || "routes.js"} is missing`);
    if (manifest.smoke && !Array.isArray(manifest.smoke)) errors.push('module.json "smoke" must be a list of paths');
    for (const e of require("./connections").declared(manifest).errors) errors.push(`module.json connections: ${e}`);
  }
  const migDir = path.join(dir, "migrations");
  const migs = fs.existsSync(migDir) ? fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort() : [];
  if (!migs.length) errors.push("no migrations/001.sql: the module has no tables");
  for (const f of migs) {
    const v = migrate.validateMigrationSql(fs.readFileSync(path.join(migDir, f), "utf8"));
    if (!v.ok) errors.push(`migrations/${f}: ${v.errors.join("; ")}`);
  }
  const entry = path.join(dir, (manifest && manifest.entry) || "routes.js");
  // Loading routes.js runs it inside this process, so its text has to pass
  // the module gate first, whoever calls this function.
  const gated = gate.checkDir(dir, { lane: "module" });
  if (!gated.ok) errors.push(`the module gate refuses it: ${gate.oneLine(gated)}`);
  if (gated.ok && fs.existsSync(entry)) {
    try {
      delete require.cache[require.resolve(entry)];
      const make = require(entry);
      if (typeof make !== "function") errors.push("routes.js must export a function (ctx) => router");
      else {
        const express = require("express");
        const r = make({ express, db: async () => ({ rows: [] }), requireManager: (req, res, next) => next(), peer: () => null, agentDoc: async () => "", ai: { models: [], modelFor: async () => null, chat: async () => ({ text: "" }) }, manifest: manifest || {}, moduleName: slug, company: "check", connections: require("./connections").stubs(manifest || {}) });
        if (!r || typeof r !== "function") errors.push("routes.js did not return an express router");
      }
    } catch (e) { errors.push(`routes.js fails to load: ${e.message}`); }
  }
  const tour = path.join(dir, "tour.json");
  if (fs.existsSync(tour)) { try { const t = JSON.parse(fs.readFileSync(tour, "utf8")); if (!Array.isArray(t.steps) || !t.steps.length) errors.push("tour.json has no steps"); } catch (e) { errors.push(`tour.json does not parse: ${e.message}`); } }
  else errors.push("tour.json is missing (PRINCIPLES rule 8)");
  for (const pg of manifest ? registry.pageEntries(manifest) : []) {
    const p = path.join(dir, pg.file);
    if (!fs.existsSync(p)) continue;
    const html = fs.readFileSync(p, "utf8");
    if (new RegExp(`["'\`]/m/${slug}`).test(html) || new RegExp(`["'\`]/c/[^"'\`]*/m/${slug}`).test(html)) errors.push(`${pg.file} hard-codes the module's address; compute base from location.pathname instead`);
    if (/[–—]/.test(html)) errors.push(`${pg.file} contains an em or en dash; use a comma, a period or a hyphen`);
  }
  return { ok: !errors.length, errors };
}

// A listing of every file in unified-diff shape, for the cross-check of a
// module that has no earlier version.
function listingAsDiff(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const p = path.join(dir, r);
      if (fs.statSync(p).isDirectory()) { walk(r); continue; }
      const text = fs.readFileSync(p, "utf8");
      out.push(`diff -ru /dev/null ${dir}/${r}\n--- /dev/null\n+++ ${r}\n` + text.split("\n").map((l) => "+" + l).join("\n"));
    }
  };
  walk("");
  return out.join("\n");
}

// ---- the state machine for the module lane ---------------------------------------------------
async function advance(runId) {
  const P = pipe();
  const run = await P.getRun(runId);
  const { company, module: slug } = run;
  const ev = run.evidence || {};
  const dir = registry.versionDir(company, slug, 1);
  try {
    if (run.step === "build") {
      const intake = ev.intake_id ? (await q("SELECT * FROM platform.module_intakes WHERE id=$1", [ev.intake_id])).rows[0] : null;
      const design = (intake && intake.design) || {};
      const last = (run.log || []).slice(-1)[0];
      const fresh = !ev.findings || (last && /retried/.test(String(last.note || "")));
      if (fresh) {
        // start again from the skeleton (a retry, or the first attempt)
        const files = await attachments.list(ev.intake_id || 0);
        const sheet = (await Promise.all(files.filter((a) => a.kind === "sheet").map((a) => attachments.get(a.id)))).find((a) => a && a.parsed && a.parsed.rows && a.parsed.rows.length);
        const seed = skeleton({ slug, title: ev.module_title || slug, design, answers: (intake && intake.answers) || {}, startingRows: sheet ? sheet.parsed.rows : [] });
        fs.rmSync(dir, { recursive: true, force: true });
        for (const [f, content] of Object.entries(seed)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), content); }
        if (ev.findings) await P.setRun(runId, { evidence: { ...ev, findings: undefined, fix_round: undefined } });
        await P.log(runId, { step: "build", note: "skeleton written from the design; the agent builds the first version on top of it" });
      }
      const guidance = await agent.guidanceFor(company, slug);
      const answersText = intake ? Object.entries(intake.answers || {}).filter(([k]) => !/^r\d+q\d+$/.test(k)).map(([k, v]) => { const qn = Q.FIXED.find((x) => x.id === k); return qn ? `${qn.text}\n${Q.describe(qn, v)}` : ""; }).filter(Boolean).join("\n\n") : "";
      const files = await attachments.list(ev.intake_id || 0);
      const sheet = (await Promise.all(files.filter((a) => a.kind === "sheet").map((a) => attachments.get(a.id)))).find((a) => a && a.parsed && a.parsed.rows && a.parsed.rows.length);
      const rowsText = sheet ? `Starting data from "${sheet.filename}" (${sheet.parsed.row_count} rows; columns: ${sheet.parsed.headers.join(" | ")}):\n${sheet.parsed.rows.slice(0, 200).map((r) => r.join(" | ")).join("\n")}` : "No starting data was attached.";
      if (ev.fix_round && ev.gate && ev.gate.ok === false) ev.findings = gate.forAgent(ev.gate, []);
      const findings = ev.fix_round && ev.findings
        ? (ev.gate && ev.gate.ok === false ? `\n\n${ev.findings}` : `\n\nAn independent reviewer looked at your previous attempt in this directory and found these problems. Fix exactly these, keep everything else as it is:\n${ev.findings}`)
        : "";
      const ctl = new AbortController();
      P.ACTIVE.set(runId, ctl);
      let out;
      try {
        out = await agent.runAgent({
          model: run.model, capUsd: 0, signal: ctl.signal, maxTurns: MODULE_MAX_TURNS,
          system: guidance.text + "\n\n---\n\n<!-- platform: MODULE-CONTRACT.md -->\n" + readDoc("MODULE-CONTRACT.md") + "\n\n---\n\n<!-- platform: PLAIN-WORDS.md -->\n" + plain.rules(),
          dir,
          prompt: `NEW MODULE BUILD: "${ev.module_title || slug}" (slug "${slug}"), version 1.

This directory holds a small WORKING skeleton the platform wrote from the confirmed design: one table (items) with the thing's stages, one board screen, a tour. Your job is to turn it into the first version the design describes. You may rewrite migrations/001.sql freely in this build (it has never been applied anywhere); after this version it is frozen and changes go in 002.sql and up.

The confirmed design (the manager read and approved every line of this; it is the requirement):
${design.reference_md || run.requirement || ""}

Design details:
- Screens: ${(design.screens || []).map((s) => `${s.title} for ${s.role} on a ${s.device}: prominent action "${s.prominent_action}"`).join("; ") || "one board"}
- Connections: ${(design.connections || []).map((c) => `${c.name} (${c.kind}): ${c.what_for}. Tool does: ${c.tool_does}. Person does: ${c.person_does}`).join("; ") || "none"}
- Starting data: ${design.starting_data || "none"}
- Left out of Rev 1 on purpose: ${(design.leaves_out || []).join("; ") || "nothing named"}

The manager's own words from the intake:
${answersText}

${rowsText}
${findings}

Rules for this build:
- Follow MODULE-CONTRACT.md exactly: module.json (keep "name": "${slug}"), routes.js exporting (ctx) => router, additive migrations, pages computing base from location.pathname, tour.json ending at the feedback button.
- One screen per role the design names, each with its single prominent action, phone first for the floor. Add each screen to module.json "pages" with a label a manager would recognize, and its API to "smoke".
- The rules in the design become checks in routes.js (refuse the action and say why in plain words).
- The numbers on the board come from /api/stats or your own endpoint and show at the top of the lead's or manager's screen.
- Seed the starting data as INSERT rows in migrations/001.sql (mind the validator: no quoted identifiers, no schema prefixes, additive statements only).
- Plain words on every visible string (PLAIN-WORDS.md). No em or en dashes anywhere.
- Keep it small and working. What the design leaves out stays out.
- Put data-changed="v1" on the main container of every screen.
- Your final message must be ONLY a short bullet list of what the module does now, one bullet per screen, in plain language for a production manager. No preamble, no headings, no code talk.`,
        });
      } finally { P.ACTIVE.delete(runId); }
      await P.addCost(runId, out.costUsd);
      const seen = Array.isArray(out.modelsSeen) ? out.modelsSeen : [];
      const swapped = seen.length && (seen.length > 1 || seen[0] !== run.model);
      const cur = await P.getRun(runId);
      await P.setRun(runId, { evidence: { ...cur.evidence, build_summary: out.text, docs: guidance.names.concat(["platform: MODULE-CONTRACT.md", "platform: PLAIN-WORDS.md"]), model: run.model, models_seen: seen, effort: agent.AGENT_EFFORT, cap_usd: 0 } });
      await P.log(runId, { step: "build", note: swapped ? `agent build complete, but the agent reported running on ${seen.join(", ")} instead of ${run.model}` : `agent build complete (${run.model}, effort ${agent.AGENT_EFFORT}${seen.length ? ", confirmed by the agent" : ""})` });
      await record("build_finished", { company, module: slug, actor: "agent", run_id: runId, intake_id: ev.intake_id || null, version: 1, after: out.text, detail: { model: run.model, models_seen: seen, effort: agent.AGENT_EFFORT, cost_usd: out.costUsd || 0, fix_round: ev.fix_round || 0, lane: "module" } });
      // The module gate first (src/modulegate.js): validateModule below loads
      // routes.js into this process to see that it returns a router, so the
      // text has to pass the gate before that happens.
      const verdict = gate.checkDir(dir, { lane: "module" });
      if (!verdict.ok) {
        await registry.persistVersion(company, slug, 1).catch(() => {});
        const c1 = await P.getRun(runId);
        await P.setRun(runId, { step: "cross_check", evidence: { ...c1.evidence, gate: gate.record(verdict), cross_check: { verdict: "fail", model: "platform checks", summary: gate.summarize(verdict), findings: gate.asFindings(verdict) } } });
        await logEvent("gate_refused", runId, { company, module: slug, version: 1, lane: "module", rules: verdict.violations.map((f) => f.rule) });
        await record("check_verdict", { company, module: slug, actor: "platform", run_id: runId, version: 1, after: gate.summarize(verdict), detail: { by: "platform checks", verdict: "fail", rules: verdict.violations.map((f) => f.rule) } });
        throw new Error(`platform checks failed: ${gate.oneLine(verdict)}`);
      }
      { const c1 = await P.getRun(runId); await P.setRun(runId, { evidence: { ...c1.evidence, gate: gate.record(verdict) } }); }
      // platform checks, no tokens
      const v = validateModule(dir, slug);
      if (!v.ok) {
        const summary = "The module did not pass the platform's checks:\n" + v.errors.map((e) => `- ${e}`).join("\n");
        const c2 = await P.getRun(runId);
        await P.setRun(runId, { step: "cross_check", evidence: { ...c2.evidence, cross_check: { verdict: "fail", summary, model: "platform checks", findings: v.errors.map((e) => ({ severity: "blocking", where: "the module", what: e, evidence: "" })) } } });
        throw new Error(`platform checks failed: ${v.errors.join("; ")}`);
      }
      await P.log(runId, { step: "build", note: "platform checks passed: manifest, migrations, routes load, tour" });
      try {
        const summary = await P.plainSummary(`New module "${ev.module_title || slug}": ${design.bluf || ""}`, out.text, false);
        await P.addCost(runId, summary.costUsd);
        const c3 = await P.getRun(runId);
        await P.setRun(runId, { evidence: { ...c3.evidence, title: `First version of ${ev.module_title || slug}`, what_changed: summary.what_changed } });
      } catch (e) { await P.log(runId, { step: "build", note: `summary skipped: ${e.message}` }); }
      try {
        await registry.stageVersion(company, slug, 1);
      } catch (e) {
        const summary = `The module could not be started on the staging copy: ${e.message}`;
        const c4 = await P.getRun(runId);
        await P.setRun(runId, { step: "cross_check", evidence: { ...c4.evidence, cross_check: { verdict: "fail", summary, model: "platform checks", findings: [{ severity: "blocking", where: "starting the module", what: e.message, evidence: "" }] } } });
        throw new Error(`staging failed: ${e.message}`);
      }
      await P.log(runId, { step: "stage", note: "staged version mounted for preview" });
      await P.setRun(runId, { step: "cross_check" });
      return advance(runId);
    }

    if (run.step === "cross_check") {
      const cur = await P.getRun(runId);
      if (agent.haveKey()) {
        const model = run.model;   // Fable reviews Fable's module build; the design is the requirement
        const p = (await q("SELECT * FROM platform.proposals WHERE id=$1", [run.proposal_id])).rows[0];
        const { data, costUsd } = await P.runStructuredCrossCheck(run, p, cur, model, listingAsDiff(dir));
        await P.addCost(runId, costUsd);
        await record("check_verdict", { company, module: slug, actor: "agent", run_id: runId, version: 1, after: data.summary, detail: { by: model, verdict: data.verdict, findings: data.findings, cost_usd: costUsd || 0, lane: "module" } });
        if (data.verdict === "fail") {
          const c2 = await P.getRun(runId);
          await P.setRun(runId, { evidence: { ...c2.evidence, cross_check: { ...data, model } } });
          throw new Error(`cross-check failed: ${data.summary}`);
        }
        await P.setRun(runId, { step: "test_run", evidence: { ...cur.evidence, cross_check: { ...data, model } } });
      } else {
        await P.setRun(runId, { step: "test_run", evidence: { ...cur.evidence, cross_check: { verdict: "skipped", summary: "AI not configured" } } });
      }
      await P.log(runId, { step: "cross_check", note: "independent review passed" });
      return advance(runId);
    }

    if (run.step === "test_run") {
      const ok = await P.smokeCheck(company, slug, true);
      const cur = await P.getRun(runId);
      await P.setRun(runId, { evidence: { ...cur.evidence, test_run: ok } });
      if (!ok.ok) throw new Error(`internal tests failed: ${ok.detail}`);
      await P.setRun(runId, { step: "await_deploy", status: "waiting" });
      await P.log(runId, { step: "test_run", note: `smoke checks passed (${(ok.checked || []).length}); ready for the manager` });
      return;
    }
  } catch (e) {
    await P.failRun(runId, e);
  }
}

// After deploy: the intake is done, the request card closes with the outcome.
async function afterDeploy(run, result) {
  const ev = run.evidence || {};
  if (ev.intake_id) await q("UPDATE platform.module_intakes SET status='done', updated_at=now() WHERE id=$1", [ev.intake_id]);
  await q("UPDATE platform.feedback SET status='done', outcome=$2, updated_at=now() WHERE intake_id=$1",
    [ev.intake_id || 0, `Built and live as v${result.to}: ${(ev.what_changed || ev.build_summary || ev.design_bluf || "").slice(0, 500)}`]);
  await logEvent("module_built", `${run.company}/${run.module}`, { run: run.id, intake: ev.intake_id, cost_usd: Number(run.cost_usd || 0) });
}

// After cancel: a module that never went live is removed again and the
// intake goes back to "confirmed" so the manager can approve the build again.
async function afterCancel(run) {
  const ev = run.evidence || {};
  const row = await registry.getModule(run.company, run.module);
  if (row && !row.live_version) {
    await q("DELETE FROM platform.module_versions WHERE company=$1 AND module=$2", [run.company, run.module]);
    await q("DELETE FROM platform.modules WHERE company=$1 AND name=$2", [run.company, run.module]);
    fs.rmSync(path.join(registry.MODULES_DIR, run.company, run.module), { recursive: true, force: true });
  }
  if (ev.intake_id) {
    await q("UPDATE platform.module_intakes SET status='confirmed', updated_at=now() WHERE id=$1 AND status='building'", [ev.intake_id]);
    await q("UPDATE platform.feedback SET status='reviewing', updated_at=now() WHERE intake_id=$1", [ev.intake_id]);
  }
}

module.exports = { startBuild, advance, afterDeploy, afterCancel, skeleton, validateModule, listingAsDiff };
