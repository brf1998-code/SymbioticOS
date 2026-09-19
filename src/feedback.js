// Platform APIs: feedback capture + improvement board + pipeline actions +
// agent settings/docs + admin. Everything is scoped by company (/api/c/:slug/...)
// except run actions, which are addressed by run id.
const express = require("express");
const { q, logEvent, upsertDoc } = require("./db");
const { generateProposal } = require("./proposals");
const pipeline = require("./pipeline");
const registry = require("./registry");
const agent = require("./agent");
const review = require("./review");
const diagrams = require("./diagrams");
const auth = require("./auth");
const { requireManager, requireAdmin, checkAdminPassword } = auth;
const qrcode = require("./qrcode");
const brand = require("./brand");
const backup = require("./backup");
const migrate = require("./migrate");
const intake = require("./intake");
const { record, actor } = require("./record");
const health = require("./health");
const connections = require("./connections");

const router = express.Router();
// the restore route carries a whole backup and parses its own body
router.use((req, res, next) => (req.path === "/api/admin/restore" || /^\/api\/c\/[^/]+\/connections\/[^/]+\/[^/]+\/upload$/.test(req.path) ? next() : express.json({ limit: "1mb" })(req, res, next)));

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
  // a floor or manager session files into its own company, whatever the body says
  const co = req.sosRole === "admin" ? ((await company(slug || "demo")) || (await company("demo"))) : await company(req.sosCompany);
  if (!co) return res.status(404).json({ error: "unknown company" });
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
  await record("feedback_filed", { company: co.slug, module: mod || "platform", actor: actor(req, name), feedback_id: r.rows[0].id, after: message.trim(), detail: { screen, page } });
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
  if (r.rows[0]) await record("feedback_closed", { company: r.rows[0].company, module: r.rows[0].module, actor: actor(req), feedback_id: r.rows[0].id, after: outcome || null, detail: { declined: Boolean(declined) } });
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
  try {
    const out = await registry.goToVersion(req.params.slug, req.params.name, Number(version), { restoreData: !!restore_data });
    await record("version_switched", { company: req.params.slug, module: req.params.name, actor: actor(req), version: out.to, detail: { from: out.from, to: out.to, restored: out.restored } });
    res.json(out);
  }
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

// ---- batches -----------------------------------------------------------------
// A batch is a persistent group of feedback items for one module, open until
// it is built. Items join or leave at any station (new or reviewing); the
// column headers on the board carry the batch actions. One open batch per
// module at a time.
async function openBatch(company, mod, create) {
  let b = (await q("SELECT * FROM platform.batches WHERE company=$1 AND module=$2 AND run_id IS NULL ORDER BY id DESC LIMIT 1", [company, mod])).rows[0];
  if (!b && create) b = (await q("INSERT INTO platform.batches (company, module) VALUES ($1,$2) RETURNING *", [company, mod])).rows[0];
  return b;
}
router.post("/api/c/:slug/batch/add", requireManager, async (req, res) => {
  const ids = ((req.body || {}).feedback_ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: "no feedback ids" });
  const rows = (await q("SELECT id, module, status FROM platform.feedback WHERE company=$1 AND id = ANY($2::int[]) AND status IN ('new','reviewing') AND module <> 'platform' AND kind = 'feedback'", [req.params.slug, ids])).rows;
  for (const f of rows) {
    const b = await openBatch(req.params.slug, f.module, true);
    await q("UPDATE platform.feedback SET batch_id=$2, updated_at=now() WHERE id=$1", [f.id, b.id]);
  }
  res.json({ ok: true, added: rows.length });
});
router.post("/api/c/:slug/batch/remove", requireManager, async (req, res) => {
  const ids = ((req.body || {}).feedback_ids || []).map(Number).filter(Boolean);
  await q("UPDATE platform.feedback SET batch_id=NULL, updated_at=now() WHERE company=$1 AND id = ANY($2::int[])", [req.params.slug, ids]);
  res.json({ ok: true });
});
router.post("/api/c/:slug/batch/:id/clear", requireManager, async (req, res) => {
  await q("UPDATE platform.feedback SET batch_id=NULL, updated_at=now() WHERE company=$1 AND batch_id=$2", [req.params.slug, req.params.id]);
  res.json({ ok: true });
});
// Build the batch: every item that has a proposal goes into one run; items not
// reviewed yet leave the batch (the board says how many) so the run is exactly
// what the manager looked at.
router.post("/api/c/:slug/batch/:id/build", requireManager, async (req, res) => {
  const b = (await q("SELECT * FROM platform.batches WHERE id=$1 AND company=$2 AND run_id IS NULL", [req.params.id, req.params.slug])).rows[0];
  if (!b) return res.status(404).json({ error: "no such open batch" });
  const items = (await q(
    `SELECT f.id, p.id AS proposal_id FROM platform.feedback f
       LEFT JOIN LATERAL (SELECT id FROM platform.proposals WHERE feedback_id=f.id ORDER BY id DESC LIMIT 1) p ON true
      WHERE f.batch_id=$1 AND f.status='reviewing'`, [b.id])).rows;
  const ids = items.map((i) => i.proposal_id).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: "nothing in this batch has a proposal yet; review the items first" });
  try {
    await q("UPDATE platform.proposals SET status='approved' WHERE id = ANY($1::int[]) AND status='draft'", [ids]);
    const run = await pipeline.startRun(ids, { model: (req.body || {}).model });
    for (const it of items) await record("proposal_approved", { company: req.params.slug, module: b.module, actor: actor(req), feedback_id: it.id, proposal_id: it.proposal_id, run_id: run.id, detail: { batch: b.id, model: (req.body || {}).model || null } });
    await q("UPDATE platform.batches SET run_id=$2 WHERE id=$1", [b.id, run.id]);
    await q("UPDATE platform.feedback SET batch_id=NULL, updated_at=now() WHERE batch_id=$1 AND status <> 'in_progress'", [b.id]);
    res.json({ ok: true, run, built: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// What the staged preview changed against the floor version: the files that
// differ (mapped to screens) and the plain summary from the run. Zero extra
// tokens: it is a text compare of the two versions already in the database.
router.get("/api/c/:slug/modules/:name/staged-changes", async (req, res) => {
  const row = await registry.getModule(req.params.slug, req.params.name);
  if (!row || !row.staged_version) return res.status(404).json({ error: "nothing staged" });
  const [from, to] = await Promise.all([registry.versionFiles(row.company, row.name, row.live_version), registry.versionFiles(row.company, row.name, row.staged_version)]);
  const run = (await q("SELECT id, evidence, from_version FROM platform.build_runs WHERE company=$1 AND module=$2 AND to_version=$3 ORDER BY id DESC LIMIT 1", [row.company, row.name, row.staged_version])).rows[0];
  let manifest = {};
  try { manifest = registry.readManifest(row.company, row.name, row.staged_version); } catch (e) { /* none */ }
  const screens = registry.pageEntries(manifest);
  const changed = [];
  for (const f of new Set([...Object.keys(from || {}), ...Object.keys(to || {})])) {
    if ((from || {})[f] === (to || {})[f]) continue;
    const scr = screens.filter((s) => s.file === f).map((s) => ({ label: s.label, route: s.route }));
    changed.push({ file: f, screens: scr.length ? scr : [{ label: f === "routes.js" ? "Server logic" : f, route: null }], added: !(from || {})[f], removed: !(to || {})[f] });
  }
  const ev = run ? run.evidence || {} : {};
  res.set("Cache-Control", "no-store").json({
    live_version: row.live_version, staged_version: row.staged_version, run_id: run ? run.id : null,
    title: ev.title || null, what_changed: ev.what_changed || null, build_summary: ev.build_summary || null, changed,
  });
});

// Company icon for the tab and the phone home screen: the brand icon when the
// guide found one, else the platform's own mark.
const DEFAULT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1f3a5f"/><path d="M20 40c0 5 5 8 12 8s12-3 12-8-5-6-12-7-12-3-12-8 5-8 12-8 12 3 12 8" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>`;
router.get("/api/c/:slug/icon", async (req, res) => {
  const co = await company(req.params.slug);
  const b = co && co.brand;
  res.set("Cache-Control", "no-cache");
  if (b && b.icon && /^data:image\/[\w.+-]+;base64,/.test(b.icon)) {
    const [head, data] = b.icon.split(",", 2);
    return res.type(head.slice(5, head.indexOf(";"))).send(Buffer.from(data, "base64"));
  }
  const primary = b && b.colors && b.colors.primary ? b.colors.primary : "#1f3a5f";
  res.type("image/svg+xml").send(DEFAULT_ICON.replace("#1f3a5f", primary));
});

function brandPublic(b) {
  if (!b) return null;
  const { icon, ...rest } = b;
  return { ...rest, has_icon: Boolean(icon) };
}

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
  const batches = (await q("SELECT * FROM platform.batches WHERE company=$1 AND run_id IS NULL ORDER BY id", [co.slug])).rows;
  const { brand: b, ...coPublic } = co;
  const intakes = req.sosRole === "floor" ? {} : await intake.boardIntakes(co.slug);
  res.json({
    company: coPublic, brand: brandPublic(b), feedback, runs, modules, screens, reviews, batches, intakes,
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
    // the proposal as it stands, before anything the manager typed lands on it
    const was = (await q("SELECT p.*, f.company, f.module FROM platform.proposals p JOIN platform.feedback f ON f.id=p.feedback_id WHERE p.id=$1", [req.params.id])).rows[0];
    if (!was) return res.status(404).json({ error: "not found" });
    const ids = { company: was.company, module: was.module, feedback_id: was.feedback_id, proposal_id: was.id };
    if (editedBody || editedClass || editedTarget) {
      await q("UPDATE platform.proposals SET body=COALESCE($2,body), class=COALESCE($3,class), target_file=COALESCE($4,target_file) WHERE id=$1",
        [req.params.id, editedBody || null, editedClass || null, editedTarget || null]);
      const changed = (editedBody && editedBody !== was.body) || (editedClass && editedClass !== was.class) || (editedTarget && editedTarget !== was.target_file);
      if (changed) await record("proposal_edited", { ...ids, actor: actor(req), before: was.body, after: editedBody || was.body, detail: { class_before: was.class, class_after: editedClass || was.class, target_before: was.target_file, target_after: editedTarget || was.target_file, model_before: was.model } });
    }
    if (decision === "approve") {
      await q("UPDATE platform.proposals SET status='approved', manager_note=$2 WHERE id=$1", [req.params.id, note || null]);
      const run = await pipeline.startRun(Number(req.params.id), { model });
      await record("proposal_approved", { ...ids, actor: actor(req), run_id: run.id, after: note || null, detail: { model: model || null, edited: Boolean(editedBody || editedClass || editedTarget) } });
      return res.json({ ok: true, run });
    }
    if (decision === "decline") {
      const p = (await q("UPDATE platform.proposals SET status='declined', manager_note=$2 WHERE id=$1 RETURNING *", [req.params.id, note || null])).rows[0];
      await q("UPDATE platform.feedback SET status='declined', outcome=$2, updated_at=now() WHERE id=$1", [p.feedback_id, note || "declined"]);
      await record("proposal_declined", { ...ids, actor: actor(req), after: note || null });
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
    // this route names its proposals in the body, so the company guard cannot see them
    const owners = (await q("SELECT DISTINCT f.company FROM platform.proposals p JOIN platform.feedback f ON f.id=p.feedback_id WHERE p.id = ANY($1::int[])", [ids])).rows.map((r) => r.company);
    if (owners.some((c) => !auth.ownsCompany(req, c))) return res.status(403).json({ error: "this login is for another company" });
    await q("UPDATE platform.proposals SET status='approved' WHERE id = ANY($1::int[]) AND status='draft'", [ids]);
    const run = await pipeline.startRun(ids, { model: (req.body || {}).model });
    for (const p of (await q("SELECT p.id, p.feedback_id, f.company, f.module FROM platform.proposals p JOIN platform.feedback f ON f.id=p.feedback_id WHERE p.id = ANY($1::int[])", [ids])).rows)
      await record("proposal_approved", { company: p.company, module: p.module, actor: actor(req), feedback_id: p.feedback_id, proposal_id: p.id, run_id: run.id, detail: { batch: true, model: (req.body || {}).model || null } });
    res.json({ ok: true, run });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// A manager's decision on a run, with who made it, on the record.
async function runIds(id) { const r = await pipeline.getRun(Number(id)); return r ? { run: r, ids: { company: r.company, module: r.module, run_id: r.id, feedback_id: null, proposal_id: r.proposal_id, version: r.to_version || null } } : null; }
router.post("/api/runs/:id/cancel", requireManager, async (req, res) => {
  try { const x = await runIds(req.params.id); await pipeline.cancel(Number(req.params.id)); if (x) await record("run_cancelled", { ...x.ids, actor: actor(req), detail: { step: x.run.step, status_before: x.run.status } }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/runs/:id/confirm", requireManager, async (req, res) => {
  try {
    const x = await runIds(req.params.id); const edited = (req.body || {}).requirement;
    await pipeline.confirmRequirement(Number(req.params.id), edited);
    if (x) await record("requirement_confirmed", { ...x.ids, actor: actor(req), before: x.run.requirement, after: edited || x.run.requirement, detail: { edited: Boolean(edited && edited !== x.run.requirement) } });
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/runs/:id/deploy", requireManager, async (req, res) => {
  try { const x = await runIds(req.params.id); const out = await pipeline.deploy(Number(req.params.id)); if (x) await record("deployed", { ...x.ids, actor: actor(req), version: out.to, detail: { from: out.from, to: out.to, lane: x.run.lane } }); res.json(out); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/runs/:id/fix", requireManager, async (req, res) => {
  try { const x = await runIds(req.params.id); await pipeline.fix(Number(req.params.id)); if (x) await record("run_fixed", { ...x.ids, actor: actor(req), before: ((x.run.evidence || {}).cross_check || {}).summary || null, detail: { round: ((x.run.evidence || {}).fix_round || 0) + 1 } }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post("/api/runs/:id/override", requireManager, async (req, res) => {
  try { const x = await runIds(req.params.id); await pipeline.override(Number(req.params.id)); if (x) await record("run_overridden", { ...x.ids, actor: actor(req), before: ((x.run.evidence || {}).cross_check || {}).summary || null }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post("/api/runs/:id/rollback", requireManager, async (req, res) => {
  try { const x = await runIds(req.params.id); const out = await pipeline.rollbackRun(Number(req.params.id)); if (x) await record("rolled_back", { ...x.ids, actor: actor(req), version: out.to, detail: { to: out.to } }); res.json(out); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/runs/:id/retry", requireManager, async (req, res) => {
  try { const x = await runIds(req.params.id); await pipeline.retry(Number(req.params.id)); if (x) await record("run_retried", { ...x.ids, actor: actor(req), detail: { step: x.run.step } }); res.json({ ok: true }); }
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
  await record("review_started", { company: req.params.slug, module: (req.body || {}).module || null, actor: actor(req), detail: { model: (req.body || {}).model || null } });
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
  const { brand: b, ...coPublic } = co;
  res.json({
    company: coPublic, brand: brandPublic(b),
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
  const wasModels = (await q("SELECT model_propose, model_build, model_review FROM platform.companies WHERE slug=$1", [req.params.slug])).rows[0] || {};
  await q("UPDATE platform.companies SET model_propose=$2, model_build=$3, model_review=$4 WHERE slug=$1",
    [req.params.slug, vals.propose, vals.build, vals.review]);
  await logEvent("models_changed", req.params.slug, vals);
  await record("models_changed", { company: req.params.slug, actor: actor(req), before: JSON.stringify(wasModels), after: JSON.stringify(vals) });
  res.json({ ok: true });
});

router.post("/api/c/:slug/agents/docs", requireManager, async (req, res) => {
  const { module: mod, name, content } = req.body || {};
  if (!name || !/^[A-Za-z0-9_.-]{1,60}$/.test(name)) return res.status(400).json({ error: "name must be a simple filename like NOTES.md" });
  const wasDoc = (await q("SELECT content FROM platform.agent_docs WHERE company=$1 AND module IS NOT DISTINCT FROM $2 AND name=$3 ORDER BY id DESC LIMIT 1", [req.params.slug, mod || null, name])).rows[0];
  const row = await upsertDoc(req.params.slug, mod || null, name, String(content || ""), "user", false);
  await logEvent("agent_doc_saved", req.params.slug, { module: mod || null, name });
  if (!wasDoc || wasDoc.content !== String(content || "")) await record("doc_saved", { company: req.params.slug, module: mod || null, actor: actor(req), before: wasDoc ? wasDoc.content : null, after: String(content || ""), detail: { name } });
  res.json(row);
});

router.delete("/api/c/:slug/agents/docs/:id", requireManager, async (req, res) => {
  const gone = (await q("DELETE FROM platform.agent_docs WHERE company=$1 AND id=$2 RETURNING module, name, content", [req.params.slug, req.params.id])).rows[0];
  if (gone) await record("doc_deleted", { company: req.params.slug, module: gone.module, actor: actor(req), before: gone.content, detail: { name: gone.name } });
  res.json({ ok: true });
});

// ---- the interaction record: the plant's own, readable and exportable by its manager
router.get("/api/c/:slug/record", requireManager, async (req, res) => {
  const { kind, feedback_id, run_id, limit, before_id } = req.query;
  res.set("Cache-Control", "no-store").json({ company: req.params.slug, rows: await require("./record").list(req.params.slug, { kind, feedback_id, run_id, limit, before_id }) });
});
router.get("/api/c/:slug/record/export", requireManager, async (req, res) => {
  const rows = await require("./record").list(req.params.slug, { limit: 5000, before_id: req.query.before_id });
  res.set("Content-Disposition", `attachment; filename="record-${req.params.slug}-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ format: "sos-record-1", company: req.params.slug, taken_at: new Date().toISOString(), count: rows.length, rows });
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
  const access = (await q("SELECT * FROM platform.company_access")).rows;
  res.json({
    companies: companies.map((c) => ({
      ...c,
      models: { propose: c.model_propose || agent.DEFAULT_MODELS.propose, build: c.model_build || agent.DEFAULT_MODELS.build, review: c.model_review || agent.DEFAULT_MODELS.review },
      modules: modules.filter((m) => m.company === c.slug),
      docs: docs.filter((d) => d.company === c.slug),
      feedback: counts.find((x) => x.company === c.slug) || { open: 0, total: 0 },
      runs: runs.find((x) => x.company === c.slug) || { n: 0, deployed: 0 },
      spend_usd: Number((spend.find((x) => x.slug === c.slug) || {}).usd || 0),
      monthly_cap_usd: c.monthly_cap_usd == null ? null : Number(c.monthly_cap_usd),
      access: auth.accessPublic(access.find((a) => a.company === c.slug)),
      brand: brandPublic(c.brand),
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

// Loop health: the platform's own numbers, per company and across the fleet
// (src/health.js). ?days=7|30|90|365|0 (0 = all time), default 30.
router.get("/api/admin/health", requireAdmin, async (req, res) => {
  try { res.json(await health.forAdmin(req.query.days)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- connections: the outside world, owned by the platform (src/connections.js) ----
// The company's connections page (manager): every declared connection of
// every live module, its state, and what a person has to set up.
router.get("/api/c/:slug/connections", requireManager, async (req, res) => {
  try { res.json({ company: req.params.slug, modules: await connections.companyView(req.params.slug) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/c/:slug/connections/:mod/:name/settings", requireManager, async (req, res) => {
  try { res.json({ settings: await connections.setSettings(req.params.slug, req.params.mod, req.params.name, req.body || {}, actor(req)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// files: upload (parse, match the columns, preview), then load (one transaction)
const sheetJson = express.json({ limit: "24mb" });
router.post("/api/c/:slug/connections/:mod/:name/upload", requireManager, sheetJson, async (req, res) => {
  try { res.json(await connections.previewUpload(req.params.slug, req.params.mod, req.params.name, req.body || {}, req.sosRole)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post("/api/c/:slug/connections/:mod/:name/load", requireManager, async (req, res) => {
  try { res.json(await connections.loadUpload(req.params.slug, req.params.mod, req.params.name, Number((req.body || {}).upload_id), actor(req))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// printer: a test label for this device, a preview of the test label, the jobs
router.post("/api/c/:slug/connections/:mod/:name/test", requireManager, async (req, res) => {
  try { res.json(await connections.testLabel(req.params.slug, req.params.mod, req.params.name, req)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get("/api/c/:slug/connections/:mod/:name/preview.png", requireManager, async (req, res) => {
  try {
    const c = await connections.row(req.params.slug, req.params.mod, req.params.name);
    if (!c || c.kind !== "printer") return res.status(404).end();
    const co = (await q("SELECT name FROM platform.companies WHERE slug=$1", [req.params.slug])).rows[0];
    const zpl = connections.renderZpl(connections.TEST_LABEL, { company: co ? co.name : req.params.slug, when: "date and time", code: "TEST000000" });
    const png = await connections.previewPng(zpl, c.settings);
    if (!png) return res.status(503).json({ error: "the label renderer could not be reached" });
    res.set("Cache-Control", "no-cache").type("png").send(png);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get("/api/c/:slug/connections/:mod/:name/jobs", requireManager, async (req, res) => {
  try { res.json({ jobs: await connections.jobs(req.params.slug, req.params.mod, req.params.name, req.query.limit) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// the device side: the platform's print helper on a page asks for the next
// label queued for this device (any signed-in role: a station tablet prints)
router.get("/api/c/:slug/print/next", async (req, res) => {
  try { const job = await connections.nextJob(req.params.slug, connections.deviceOf(req)); res.set("Cache-Control", "no-store").json(job ? { job } : {}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/c/:slug/print/jobs/:id/done", async (req, res) => {
  try { await connections.finishJob(req.params.slug, connections.deviceOf(req), Number(req.params.id), { ok: true, printer: (req.body || {}).printer }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post("/api/c/:slug/print/jobs/:id/failed", async (req, res) => {
  try { await connections.finishJob(req.params.slug, connections.deviceOf(req), Number(req.params.id), { ok: false, printer: (req.body || {}).printer, error: (req.body || {}).error }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post("/api/admin/companies", requireAdmin, async (req, res) => {
  const { slug, name, brand_url, brand_model } = req.body || {};
  if (!SLUG.test(slug || "")) return res.status(400).json({ error: "slug: lowercase letters, digits, dashes" });
  if (!name) return res.status(400).json({ error: "name required" });
  const existed = Boolean(await company(slug));
  // A new company never rides on the shared passwords: it gets its own at
  // birth, the ones given or ones made up here and shown to the admin once.
  let made = null;
  if (!existed) {
    const floor = String((req.body || {}).floor_password || "").trim() || auth.generatePassword();
    let manager = String((req.body || {}).manager_password || "").trim() || auth.generatePassword();
    while (manager === floor) manager = auth.generatePassword();
    try { await q("INSERT INTO platform.companies (slug, name) VALUES ($1,$2)", [slug, name]); await auth.setPasswords(slug, { floor, manager }); }
    catch (e) { await q("DELETE FROM platform.companies WHERE slug=$1", [slug]).catch(() => {}); return res.status(400).json({ error: e.message }); }
    made = { floor, manager };
  }
  await q("INSERT INTO platform.companies (slug, name) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name", [slug, name]);
  if (brand_url && String(brand_url).trim()) {
    const url = String(brand_url).trim();
    await q("UPDATE platform.companies SET brand=$2 WHERE slug=$1", [slug, JSON.stringify({ url, status: "building" })]);
    brand.buildGuide(slug, url, brand_model).catch((e) => console.error(`[brand] ${slug}:`, e.message));
  }
  await upsertDoc(slug, null, "COMPANY.md", `# ${name}\n\nWhat the agents should know about this company: what it makes, who is on the floor, what matters most (safety, throughput, quality), vocabulary the floor uses, anything to avoid.\n`, "repo", true);
  await logEvent(existed ? "company_renamed" : "company_created", slug, { name });
  res.json({ ok: true, passwords: made });
});

// Set or rotate a company's floor and manager passwords. Giving a company its
// own passwords ends its use of the shared ones from the environment.
router.post("/api/admin/companies/:slug/access", requireAdmin, async (req, res) => {
  const co = await company(req.params.slug);
  if (!co) return res.status(404).json({ error: "unknown company" });
  const b = req.body || {};
  const floor = b.generate ? auth.generatePassword() : String(b.floor_password || "").trim();
  let manager = b.generate ? auth.generatePassword() : String(b.manager_password || "").trim();
  while (b.generate && manager === floor) manager = auth.generatePassword();
  try {
    await auth.setPasswords(co.slug, { floor: floor || null, manager: manager || null });
    await logEvent("company_passwords_set", co.slug, { floor: Boolean(floor), manager: Boolean(manager), generated: Boolean(b.generate) });
    res.json({ ok: true, passwords: b.generate ? { floor, manager } : null, access: auth.accessPublic(await auth.accessRow(co.slug)) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// A company's own monthly AI budget; blank or 0 takes it off.
router.post("/api/admin/companies/:slug/cap", requireAdmin, async (req, res) => {
  const co = await company(req.params.slug);
  if (!co) return res.status(404).json({ error: "unknown company" });
  const raw = (req.body || {}).usd;
  const usd = raw === "" || raw == null ? null : Number(raw);
  if (usd != null && (!Number.isFinite(usd) || usd < 0 || usd > 100000)) return res.status(400).json({ error: "give a dollar amount, or leave it blank for no cap" });
  await q("UPDATE platform.companies SET monthly_cap_usd=$2 WHERE slug=$1", [co.slug, usd || null]);
  await logEvent("company_cap_set", co.slug, { usd: usd || null });
  res.json({ ok: true, monthly_cap_usd: usd || null });
});

router.post("/api/admin/companies/:slug/modules", requireAdmin, async (req, res) => {
  const { module: mod } = req.body || {};
  try {
    const co = await company(req.params.slug);
    if (!co) return res.status(404).json({ error: "unknown company" });
    const r = await registry.importFromRepo(co.slug, mod);
    const row = await registry.getModule(co.slug, mod);
    if (row && row.live_version) await registry.mountLiveIfNeeded(co.slug, mod, row.live_version);
    let restyle = null;
    if (co.brand && co.brand.status === "done" && (req.body || {}).restyle !== false) {
      try { restyle = (await brand.restyleModule(co.slug, mod)).id; }
      catch (e) { console.error(`[brand] restyle ${co.slug}/${mod}:`, e.message); }
    }
    res.json({ ok: true, ...r, restyle_run: restyle });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- admin: brand guide from a URL, restyle a module to it ---------------------
router.post("/api/admin/companies/:slug/brand", requireAdmin, async (req, res) => {
  const { url, model } = req.body || {};
  const co = await company(req.params.slug);
  if (!co) return res.status(404).json({ error: "unknown company" });
  if (!url || !/^https?:\/\//i.test(String(url).trim())) return res.status(400).json({ error: "give the site address, starting with https://" });
  if (co.brand && co.brand.status === "building") return res.status(409).json({ error: "the guide is already being built" });
  await q("UPDATE platform.companies SET brand=$2 WHERE slug=$1", [co.slug, JSON.stringify({ ...(co.brand || {}), url: String(url).trim(), status: "building" })]);
  brand.buildGuide(co.slug, String(url).trim(), model).catch((e) => console.error(`[brand] ${co.slug}:`, e.message));
  res.json({ ok: true, status: "building" });
});
router.post("/api/admin/companies/:slug/modules/:module/restyle", requireAdmin, async (req, res) => {
  try { const run = await brand.restyleModule(req.params.slug, req.params.module, { model: (req.body || {}).model }); res.json({ ok: true, run }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- admin: delete a company ----------------------------------------------------
// Two gates: the slug typed back, and the admin password again (checked here).
// Refused while any build of that company is running or queued. Everything the
// company owns goes: module schemas and snapshots, versions, feedback, runs,
// docs, reviews, diagrams, batches, the mounts, the materialized files.
router.post("/api/admin/companies/:slug/delete", requireAdmin, async (req, res) => {
  const { confirm_slug, password } = req.body || {};
  const co = await company(req.params.slug);
  if (!co) return res.status(404).json({ error: "unknown company" });
  if (String(confirm_slug || "") !== co.slug) return res.status(400).json({ error: "type the company slug exactly to confirm" });
  if (!checkAdminPassword(password)) { await logEvent("company_delete_refused", co.slug, { reason: "wrong password" }); return res.status(403).json({ error: "wrong admin password" }); }
  const busy = (await q("SELECT count(*)::int AS n FROM platform.build_runs WHERE company=$1 AND status IN ('running','queued','waiting')", [co.slug])).rows[0].n;
  if (busy) return res.status(409).json({ error: `${busy} build(s) still open on this company; cancel them first` });
  try {
    const mods = (await q("SELECT name FROM platform.modules WHERE company=$1", [co.slug])).rows.map((m) => m.name);
    registry.unmountCompany(co.slug);
    for (const m of mods) {
      await q(`DROP SCHEMA IF EXISTS ${migrate.liveSchema(co.slug, m)} CASCADE`);
      await q(`DROP SCHEMA IF EXISTS ${migrate.stagingSchema(co.slug, m)} CASCADE`);
    }
    for (const sn of (await q("SELECT file FROM platform.schema_snapshots WHERE company=$1", [co.slug])).rows) {
      if (/^snap_[a-z0-9_]+$/i.test(sn.file)) await q(`DROP SCHEMA IF EXISTS ${sn.file} CASCADE`);
    }
    const counts = {};
    const fbIds = (await q("SELECT id FROM platform.feedback WHERE company=$1", [co.slug])).rows.map((r) => r.id);
    counts.runs = (await q("DELETE FROM platform.build_runs WHERE company=$1", [co.slug])).rowCount;
    counts.proposals = (await q("DELETE FROM platform.proposals WHERE feedback_id = ANY($1::int[])", [fbIds])).rowCount;
    counts.feedback = (await q("DELETE FROM platform.feedback WHERE company=$1", [co.slug])).rowCount;
    for (const t of ["batches", "agent_docs", "reviews", "diagrams", "module_versions", "modules", "schema_snapshots", "attachments", "module_intakes", "company_access"]) {
      counts[t] = (await q(`DELETE FROM platform.${t} WHERE company=$1`, [co.slug])).rowCount;
    }
    await connections.deleteCompany(co.slug);
    counts.record = await require("./record").deleteCompany(co.slug);
    await q("DELETE FROM platform.companies WHERE slug=$1", [co.slug]);
    await logEvent("company_deleted", co.slug, { name: co.name, modules: mods, counts });
    res.json({ ok: true, counts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- admin: whole-instance backup and restore ----------------------------------
router.get("/api/admin/backup", requireAdmin, async (_req, res) => {
  try {
    const doc = await backup.dump();
    await logEvent("backup_downloaded", null, { taken_at: doc.taken_at, schemas: Object.keys(doc.schemas).length });
    res.set("Content-Disposition", `attachment; filename="sos-backup-${doc.taken_at.slice(0, 19).replace(/[:T]/g, "-")}.json"`);
    res.type("application/json").send(JSON.stringify(doc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Restore replaces everything and then exits the process (Railway restarts it;
// boot rebuilds versions and mounts from the restored rows).
router.post("/api/admin/restore", requireAdmin, express.json({ limit: "300mb" }), async (req, res) => {
  const { password, backup: doc } = req.body || {};
  if (!checkAdminPassword(password)) return res.status(403).json({ error: "wrong admin password" });
  const busy = (await q("SELECT count(*)::int AS n FROM platform.build_runs WHERE status='running'")).rows[0].n;
  if (busy) return res.status(409).json({ error: "a build is running; abort it first" });
  try {
    await backup.restore(doc);
    await logEvent("backup_restored", null, { taken_at: doc.taken_at });
    res.json({ ok: true, restarting: true });
    console.log("[backup] restored; exiting so the platform reboots on the restored data");
    setTimeout(() => process.exit(1), 800);
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
