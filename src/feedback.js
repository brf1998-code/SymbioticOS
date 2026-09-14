// Platform APIs: feedback capture + improvement board + pipeline actions +
// agent settings/docs + admin. Everything is scoped by company (/api/c/:slug/...)
// except run actions, which are addressed by run id.
const express = require("express");
const { q, logEvent } = require("./db");
const { generateProposal } = require("./proposals");
const pipeline = require("./pipeline");
const registry = require("./registry");
const agent = require("./agent");
const review = require("./review");
const diagrams = require("./diagrams");
const { requireManager, requireAdmin } = require("./auth");
const qrcode = require("./qrcode");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));

async function company(slug) {
  return (await q("SELECT * FROM platform.companies WHERE slug=$1", [slug])).rows[0];
}
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

// ---- capture (feedback widget posts here) ---------------------------------
// module "platform" (or none) = feedback about the platform itself. Those items
// are not built by the in-app agent; Brendan picks them up from Cowork via
// GET /api/c/:slug/feedback/platform and ships the change through the repo.
router.post("/api/feedback", async (req, res) => {
  const { company: slug, module: mod, page, message, name } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: "message required" });
  const co = (await company(slug || "demo")) || (await company("demo"));
  let screen = null, target = null;
  if (mod && mod !== "platform") {
    const row = await registry.getModule(co.slug, mod);
    if (row && row.live_version) {
      const hit = registry.screenFor(registry.readManifest(co.slug, mod, row.live_version), page);
      if (hit) { screen = hit.label; target = hit.file; }
    }
  } else if (page) {
    screen = /\/agents/.test(page) ? "Agent settings page" : /\/admin/.test(page) ? "Admin page" : "Improvement board";
  }
  const r = await q(
    `INSERT INTO platform.feedback (company, module, page, screen, target_file, message, name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [co.slug, mod || "platform", page || null, screen, target, message.trim().slice(0, 2000), (name || "").slice(0, 80) || null]);
  await logEvent("feedback_submitted", r.rows[0].id, { company: co.slug, module: mod, screen });
  res.json(r.rows[0]);
});

router.post("/api/feedback/:id/plusone", async (req, res) => {
  const r = await q("UPDATE platform.feedback SET recurrence = recurrence + 1, updated_at=now() WHERE id=$1 RETURNING *", [req.params.id]);
  res.json(r.rows[0]);
});

// Platform-level feedback, for the Cowork revision loop (plain JSON, newest first).
router.get("/api/c/:slug/feedback/platform", requireManager, async (req, res) => {
  const status = req.query.status || "new";
  const rows = (await q(
    `SELECT id, page, screen, message, name, status, recurrence, outcome, created_at
       FROM platform.feedback WHERE company=$1 AND module='platform' AND ($2 = 'all' OR status=$2) ORDER BY id DESC`, [req.params.slug, status])).rows;
  res.json(rows);
});

router.post("/api/feedback/:id/close", requireManager, async (req, res) => {
  const { outcome, declined } = req.body || {};
  const r = await q("UPDATE platform.feedback SET status=$2, outcome=$3, updated_at=now() WHERE id=$1 RETURNING *",
    [req.params.id, declined ? "declined" : "done", outcome || null]);
  res.json(r.rows[0]);
});

// Module version probe: module pages poll this and reload when it changes.
router.get("/api/c/:slug/modules/:name/version", async (req, res) => {
  const row = await registry.getModule(req.params.slug, req.params.name);
  if (!row) return res.status(404).json({ error: "unknown module" });
  res.set("Cache-Control", "no-store").json({ live_version: row.live_version, staged_version: row.staged_version });
});

// Guided tour steps for a module (any signed-in role; the widget drives it).
router.get("/api/c/:slug/modules/:name/tour", async (req, res) => {
  try {
    const t = await registry.tourFor(req.params.slug, req.params.name);
    if (!t) return res.status(404).json({ error: "no tour for this module" });
    res.json(t);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Version history and jumps (manager). Back or forward, with or without the
// data as it was when that version was last live.
router.get("/api/c/:slug/modules/:name/versions", requireManager, async (req, res) => {
  try { res.json(await registry.versionHistory(req.params.slug, req.params.name)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post("/api/c/:slug/modules/:name/goto", requireManager, async (req, res) => {
  const { version, restore_data } = req.body || {};
  const row = await registry.getModule(req.params.slug, req.params.name);
  if (!row) return res.status(404).json({ error: "unknown module" });
  const busy = (await q(
    "SELECT id FROM platform.build_runs WHERE company=$1 AND module=$2 AND status='running'", [req.params.slug, req.params.name])).rows[0];
  if (busy) return res.status(409).json({ error: "a build is running on this module; wait for it to reach the gate or cancel it first" });
  try { res.json(await registry.goToVersion(req.params.slug, req.params.name, Number(version), { restoreData: !!restore_data })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- board QR code ---------------------------------------------------------
// The board's own address as a scannable code, shown in the top right of the
// board and printable for the wall. One code per company: it points at
// /c/<slug>/, so whoever scans it lands on that company's board (and at the
// login page first if they have no session).
function boardUrl(req, slug) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}/c/${slug}/`;
}
router.get("/api/c/:slug/qr.svg", async (req, res) => {
  const co = await company(req.params.slug);
  if (!co) return res.status(404).json({ error: "unknown company" });
  const px = Math.min(1200, Math.max(80, Number(req.query.px) || 240));
  try {
    res.type("image/svg+xml").set("Cache-Control", "no-cache").send(qrcode.svg(boardUrl(req, co.slug), { size: px }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- board data ------------------------------------------------------------
router.get("/api/c/:slug/board", async (req, res) => {
  const co = await company(req.params.slug);
  if (!co) return res.status(404).json({ error: "unknown company" });
  const feedback = (await q(
    `SELECT f.*, p.id AS proposal_id, p.body AS proposal_body, p.class AS proposal_class,
            p.target_file AS proposal_target, p.rationale AS proposal_rationale, p.status AS proposal_status, p.model AS proposal_model
       FROM platform.feedback f
       LEFT JOIN LATERAL (SELECT * FROM platform.proposals WHERE feedback_id=f.id ORDER BY id DESC LIMIT 1) p ON true
      WHERE f.company=$1
      ORDER BY f.recurrence DESC, f.id DESC`, [co.slug])).rows;
  const runs = (await q(
    `SELECT r.*, p.feedback_id,
            (SELECT array_agg(feedback_id ORDER BY id) FROM platform.proposals
              WHERE id = ANY(COALESCE(r.proposal_ids, ARRAY[r.proposal_id]))) AS feedback_ids
       FROM platform.build_runs r
       JOIN platform.proposals p ON p.id = r.proposal_id
      WHERE r.company=$1
      ORDER BY r.id DESC`, [co.slug])).rows;
  const modules = (await q("SELECT * FROM platform.modules WHERE company=$1 ORDER BY name", [co.slug])).rows;
  // screens per module, so the adjust form can offer target files
  const screens = {};
  for (const m of modules) {
    try { screens[m.name] = registry.pageEntries(registry.readManifest(co.slug, m.name, m.live_version)).concat([{ route: null, file: "routes.js", label: "Server logic (routes.js)" }]); }
    catch (e) { screens[m.name] = []; }
  }
  const reviews = await review.listReviews(co.slug);
  res.json({
    company: co, feedback, runs, modules, screens, reviews,
    boardUrl: boardUrl(req, co.slug),
    spend: await agent.monthlySpend(co.slug),
    models: { list: agent.MODELS, build: (await agent.buildModelFor(co.slug, await agent.modelFor(co.slug, "build"))).model },
    role: req.sosRole,
    boot: process.env.SOS_BOOT_ID,
    aiConfigured: agent.haveKey(),
    fakeAgent: agent.fakeMode(),
    maxRunUsd: agent.MAX_RUN_USD,
    maxBatchUsd: agent.MAX_BATCH_USD,
    maxFixRounds: pipeline.MAX_FIX_ROUNDS,
  });
});

// ---- lifecycle actions (manager only) --------------------------------------
router.post("/api/feedback/:id/review", requireManager, async (req, res) => {
  try { res.json(await generateProposal(Number(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Manager decision on a proposal (approve/decline, with optional edits)
router.post("/api/proposals/:id/decide", requireManager, async (req, res) => {
  const { decision, note, editedBody, editedClass, editedTarget, model } = req.body || {};
  try {
    if (editedBody || editedClass || editedTarget) {
      await q("UPDATE platform.proposals SET body=COALESCE($2,body), class=COALESCE($3,class), target_file=COALESCE($4,target_file) WHERE id=$1",
        [req.params.id, editedBody || null, editedClass || null, editedTarget || null]);
    }
    if (decision === "approve") {
      await q("UPDATE platform.proposals SET status='approved', manager_note=$2 WHERE id=$1", [req.params.id, note || null]);
      const run = await pipeline.startRun(Number(req.params.id), { model });
      return res.json({ ok: true, run });
    }
    if (decision === "decline") {
      const p = (await q("UPDATE platform.proposals SET status='declined', manager_note=$2 WHERE id=$1 RETURNING *", [req.params.id, note || null])).rows[0];
      await q("UPDATE platform.feedback SET status='declined', outcome=$2, updated_at=now() WHERE id=$1", [p.feedback_id, note || "declined"]);
      return res.json({ ok: true });
    }
    if (decision === "save") return res.json({ ok: true });
    res.status(400).json({ error: "decision must be approve, decline, or save" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Batch: approve several reviewed proposals and build them in one run
router.post("/api/runs/batch", requireManager, async (req, res) => {
  const ids = ((req.body || {}).proposal_ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: "pick at least one proposal" });
  try {
    await q("UPDATE platform.proposals SET status='approved' WHERE id = ANY($1::int[]) AND status='draft'", [ids]);
    const run = await pipeline.startRun(ids, { model: (req.body || {}).model });
    res.json({ ok: true, run });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/api/runs/:id/cancel", requireManager, async (req, res) => {
  try { await pipeline.cancel(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/runs/:id/confirm", requireManager, async (req, res) => {
  try { await pipeline.confirmRequirement(Number(req.params.id), (req.body || {}).requirement); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/runs/:id/deploy", requireManager, async (req, res) => {
  try { res.json(await pipeline.deploy(Number(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/runs/:id/fix", requireManager, async (req, res) => {
  try { await pipeline.fix(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post("/api/runs/:id/override", requireManager, async (req, res) => {
  try { await pipeline.override(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post("/api/runs/:id/rollback", requireManager, async (req, res) => {
  try { res.json(await pipeline.rollbackRun(Number(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/runs/:id/retry", requireManager, async (req, res) => {
  try { await pipeline.retry(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get("/api/runs/:id", async (req, res) => {
  res.json(await pipeline.getRun(Number(req.params.id)));
});

// ---- system review: re-baseline a whole module (manager) --------------------
router.get("/api/c/:slug/reviews/estimate", requireManager, async (req, res) => {
  try { res.json(await review.estimate(req.params.slug, String(req.query.module), String(req.query.model || "claude-fable-5-1"))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/c/:slug/reviews", requireManager, async (req, res) => {
  const { module: mod, model, requested_by } = req.body || {};
  try { res.json(await review.startReview(req.params.slug, mod, model || "claude-fable-5-1", requested_by)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get("/api/c/:slug/reviews", requireManager, async (req, res) => {
  res.json(await review.listReviews(req.params.slug));
});

// ---- diagrams: data flows and workflows per deployed version ---------------
router.get("/api/c/:slug/diagrams/:module", async (req, res) => {
  const row = await registry.getModule(req.params.slug, req.params.module);
  if (!row) return res.status(404).json({ error: "unknown module" });
  const v = req.query.version ? Number(req.query.version) : null;
  const d = await diagrams.latest(req.params.slug, req.params.module, v);
  res.json({ module: row, ...d, conventions: diagrams.conventions(), role: req.sosRole });
});
router.post("/api/c/:slug/diagrams/:module/regenerate", requireManager, async (req, res) => {
  try {
    const row = await registry.getModule(req.params.slug, req.params.module);
    const out = await diagrams.generate(req.params.slug, req.params.module, row.live_version, { force: true, model: (req.body || {}).model });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- agent settings: models per role + guidance docs (manager) --------------
router.get("/api/c/:slug/agents", requireManager, async (req, res) => {
  const co = await company(req.params.slug);
  if (!co) return res.status(404).json({ error: "unknown company" });
  const docs = (await q("SELECT id, module, name, content, source, updated_at FROM platform.agent_docs WHERE company=$1 ORDER BY module NULLS FIRST, name", [co.slug])).rows;
  const modules = (await q("SELECT name, title FROM platform.modules WHERE company=$1 ORDER BY name", [co.slug])).rows;
  res.json({
    company: co,
    models: {
      list: agent.MODELS,
      defaults: agent.DEFAULT_MODELS,
      propose: await agent.modelFor(co.slug, "propose"),
      build: await agent.modelFor(co.slug, "build"),
      review: await agent.modelFor(co.slug, "review"),
    },
    platformDocs: agent.platformDocs(),
    docs, modules,
    role: req.sosRole,
  });
});

router.post("/api/c/:slug/agents/models", requireManager, async (req, res) => {
  const b = req.body || {};
  const ok = (id) => (id === "" || id == null) ? null : (agent.MODELS.some((m) => m.id === id) ? id : undefined);
  const vals = { propose: ok(b.propose), build: ok(b.build), review: ok(b.review) };
  if (Object.values(vals).includes(undefined)) return res.status(400).json({ error: "unknown model id" });
  await q("UPDATE platform.companies SET model_propose=$2, model_build=$3, model_review=$4 WHERE slug=$1",
    [req.params.slug, vals.propose, vals.build, vals.review]);
  await logEvent("models_changed", req.params.slug, vals);
  res.json({ ok: true });
});

router.post("/api/c/:slug/agents/docs", requireManager, async (req, res) => {
  const { module: mod, name, content } = req.body || {};
  if (!name || !/^[A-Za-z0-9_.-]{1,60}$/.test(name)) return res.status(400).json({ error: "name must be a simple filename like NOTES.md" });
  const r = await q(
    `INSERT INTO platform.agent_docs (company, module, name, content, source, updated_at) VALUES ($1,$2,$3,$4,'user',now())
     ON CONFLICT (company, module, name) DO UPDATE SET content=EXCLUDED.content, source='user', updated_at=now() RETURNING *`,
    [req.params.slug, mod || null, name, String(content || "")]);
  await logEvent("agent_doc_saved", req.params.slug, { module: mod || null, name });
  res.json(r.rows[0]);
});

router.delete("/api/c/:slug/agents/docs/:id", requireManager, async (req, res) => {
  await q("DELETE FROM platform.agent_docs WHERE company=$1 AND id=$2", [req.params.slug, req.params.id]);
  res.json({ ok: true });
});

// ---- admin: companies across the instance ------------------------------------
router.get("/api/admin/overview", requireAdmin, async (_req, res) => {
  const companies = (await q("SELECT * FROM platform.companies ORDER BY created_at")).rows;
  const modules = (await q("SELECT company, name, title, live_version, staged_version FROM platform.modules ORDER BY company, name")).rows;
  const docs = (await q("SELECT company, module, name, source, updated_at, length(content) AS bytes FROM platform.agent_docs ORDER BY company, module NULLS FIRST, name")).rows;
  const counts = (await q(`SELECT company, count(*) FILTER (WHERE status='new')::int AS open, count(*)::int AS total FROM platform.feedback GROUP BY company`)).rows;
  const spend = (await q(`
    SELECT c.slug,
      COALESCE((SELECT SUM(cost_usd) FROM platform.build_runs r WHERE r.company=c.slug AND r.created_at >= date_trunc('month', now())),0)
    + COALESCE((SELECT SUM(p.cost_usd) FROM platform.proposals p JOIN platform.feedback f ON f.id=p.feedback_id WHERE f.company=c.slug AND p.created_at >= date_trunc('month', now())),0) AS usd
    FROM platform.companies c`)).rows;
  const runs = (await q("SELECT company, count(*)::int AS n, count(*) FILTER (WHERE status='deployed')::int AS deployed FROM platform.build_runs GROUP BY company")).rows;
  res.json({
    companies: companies.map((c) => ({
      ...c,
      models: { propose: c.model_propose || agent.DEFAULT_MODELS.propose, build: c.model_build || agent.DEFAULT_MODELS.build, review: c.model_review || agent.DEFAULT_MODELS.review },
      modules: modules.filter((m) => m.company === c.slug),
      docs: docs.filter((d) => d.company === c.slug),
      feedback: counts.find((x) => x.company === c.slug) || { open: 0, total: 0 },
      runs: runs.find((x) => x.company === c.slug) || { n: 0, deployed: 0 },
      spend_usd: Number((spend.find((x) => x.slug === c.slug) || {}).usd || 0),
    })),
    library: registry.libraryModules().map((m) => ({
      name: m.name, title: m.title, description: m.description || "", screens: m.screens, migrations: m.migrations,
      tourSteps: m.tour && m.tour.steps ? m.tour.steps.length : 0, tourTitle: m.tour ? m.tour.title : null,
      smoke: (m.smoke || []).length,
      deployed: modules.filter((x) => x.name === m.name).map((x) => ({ company: x.company, live_version: x.live_version })),
    })),
    models: agent.MODELS,
    defaults: agent.DEFAULT_MODELS,
    monthlyCap: agent.MONTHLY_CAP_USD,
    totalSpend: (await agent.monthlySpend(null)).usd,
  });
});

router.post("/api/admin/companies", requireAdmin, async (req, res) => {
  const { slug, name } = req.body || {};
  if (!SLUG.test(slug || "")) return res.status(400).json({ error: "slug: lowercase letters, digits, dashes" });
  if (!name) return res.status(400).json({ error: "name required" });
  await q("INSERT INTO platform.companies (slug, name) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name", [slug, name]);
  await q(`INSERT INTO platform.agent_docs (company, module, name, content, source) VALUES ($1,NULL,'COMPANY.md',$2,'repo') ON CONFLICT DO NOTHING`,
    [slug, `# ${name}\n\nWhat the agents should know about this company: what it makes, who is on the floor, what matters most (safety, throughput, quality), vocabulary the floor uses, anything to avoid.\n`]);
  await logEvent("company_created", slug, { name });
  res.json({ ok: true });
});

router.post("/api/admin/companies/:slug/modules", requireAdmin, async (req, res) => {
  const { module: mod } = req.body || {};
  try {
    const co = await company(req.params.slug);
    if (!co) return res.status(404).json({ error: "unknown company" });
    const r = await registry.importFromRepo(co.slug, mod);
    const row = await registry.getModule(co.slug, mod);
    if (row && row.live_version) await registry.mountLiveIfNeeded(co.slug, mod, row.live_version);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- admin/manager: module version export (for revising a module from Cowork)
router.get("/api/c/:slug/modules/:name/export", requireManager, async (req, res) => {
  const row = await registry.getModule(req.params.slug, req.params.name);
  if (!row) return res.status(404).json({ error: "unknown module" });
  const version = req.query.version ? Number(req.query.version) : row.live_version;
  const files = await registry.versionFiles(row.company, row.name, version);
  if (!files) return res.status(404).json({ error: "no such version" });
  res.json({ company: row.company, module: row.name, version, live_version: row.live_version, files });
});

router.get("/api/admin/events", requireAdmin, async (_req, res) => {
  res.json((await q("SELECT * FROM platform.events ORDER BY id DESC LIMIT 200")).rows);
});

module.exports = router;
