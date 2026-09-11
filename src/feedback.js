// Platform APIs: feedback capture + improvement board + pipeline actions.
const express = require("express");
const { q, logEvent } = require("./db");
const { generateProposal } = require("./proposals");
const pipeline = require("./pipeline");
const registry = require("./registry");
const agent = require("./agent");
const { requireManager } = require("./auth");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));

// ---- capture (feedback widget posts here) ---------------------------------
// module "platform" (or none) = feedback about the platform itself. Those items
// are not built by the in-app agent; Brendan picks them up from Cowork via
// GET /api/feedback/platform and ships the change through the repo.
router.post("/api/feedback", async (req, res) => {
  const { module: mod, page, message, name } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: "message required" });
  const r = await q(
    `INSERT INTO platform.feedback (module, page, message, name) VALUES ($1,$2,$3,$4) RETURNING *`,
    [mod || "platform", page || null, message.trim().slice(0, 2000), (name || "").slice(0, 80) || null]);
  await logEvent("feedback_submitted", r.rows[0].id, { module: mod });
  res.json(r.rows[0]);
});

// +1 recurrence on an existing item
router.post("/api/feedback/:id/plusone", async (req, res) => {
  const r = await q(
    "UPDATE platform.feedback SET recurrence = recurrence + 1, updated_at=now() WHERE id=$1 RETURNING *",
    [req.params.id]);
  res.json(r.rows[0]);
});

// Platform-level feedback, for the Cowork revision loop (plain JSON, newest first).
router.get("/api/feedback/platform", requireManager, async (req, res) => {
  const status = req.query.status || "new";
  const rows = (await q(
    `SELECT id, page, message, name, status, recurrence, outcome, created_at
       FROM platform.feedback WHERE module='platform' AND ($1 = 'all' OR status=$1) ORDER BY id DESC`, [status])).rows;
  res.json(rows);
});

// Close a platform item by hand (used after a repo change ships).
router.post("/api/feedback/:id/close", requireManager, async (req, res) => {
  const { outcome, declined } = req.body || {};
  const r = await q(
    "UPDATE platform.feedback SET status=$2, outcome=$3, updated_at=now() WHERE id=$1 RETURNING *",
    [req.params.id, declined ? "declined" : "done", outcome || null]);
  res.json(r.rows[0]);
});

// ---- board data ------------------------------------------------------------
router.get("/api/board", async (req, res) => {
  const feedback = (await q(
    `SELECT f.*, p.id AS proposal_id, p.body AS proposal_body, p.class AS proposal_class,
            p.rationale AS proposal_rationale, p.status AS proposal_status
       FROM platform.feedback f
       LEFT JOIN LATERAL (SELECT * FROM platform.proposals WHERE feedback_id=f.id ORDER BY id DESC LIMIT 1) p ON true
      ORDER BY f.recurrence DESC, f.id DESC`)).rows;
  const runs = (await q(
    `SELECT r.*, p.feedback_id FROM platform.build_runs r
       JOIN platform.proposals p ON p.id = r.proposal_id
      ORDER BY r.id DESC`)).rows;
  const modules = (await q("SELECT * FROM platform.modules ORDER BY name")).rows;
  const spend = await agent.monthlySpend();
  res.json({
    feedback, runs, modules, spend,
    role: req.sosRole,
    aiConfigured: agent.haveKey(),
    fakeAgent: agent.fakeMode(),
    model: agent.MODEL,
    maxRunUsd: agent.MAX_RUN_USD,
  });
});

// ---- lifecycle actions (manager only) --------------------------------------
// New -> Reviewing: generate the AI proposal
router.post("/api/feedback/:id/review", requireManager, async (req, res) => {
  try { res.json(await generateProposal(Number(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Manager decision on a proposal
router.post("/api/proposals/:id/decide", requireManager, async (req, res) => {
  const { decision, note, editedBody, editedClass } = req.body || {}; // approve|decline
  try {
    if (editedBody || editedClass) {
      await q("UPDATE platform.proposals SET body=COALESCE($2,body), class=COALESCE($3,class) WHERE id=$1",
        [req.params.id, editedBody || null, editedClass || null]);
    }
    if (decision === "approve") {
      await q("UPDATE platform.proposals SET status='approved', manager_note=$2 WHERE id=$1", [req.params.id, note || null]);
      const run = await pipeline.startRun(Number(req.params.id));
      return res.json({ ok: true, run });
    }
    if (decision === "decline") {
      const p = (await q("UPDATE platform.proposals SET status='declined', manager_note=$2 WHERE id=$1 RETURNING *", [req.params.id, note || null])).rows[0];
      await q("UPDATE platform.feedback SET status='declined', outcome=$2, updated_at=now() WHERE id=$1", [p.feedback_id, note || "declined"]);
      return res.json({ ok: true });
    }
    res.status(400).json({ error: "decision must be approve or decline" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Functionality lane: manager confirms the restated requirement
router.post("/api/runs/:id/confirm", requireManager, async (req, res) => {
  try { await pipeline.confirmRequirement(Number(req.params.id), (req.body || {}).requirement); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Deploy gate
router.post("/api/runs/:id/deploy", requireManager, async (req, res) => {
  try { res.json(await pipeline.deploy(Number(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Rollback the module a run deployed
router.post("/api/runs/:id/rollback", requireManager, async (req, res) => {
  try { res.json(await pipeline.rollbackRun(Number(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Retry a failed run
router.post("/api/runs/:id/retry", requireManager, async (req, res) => {
  try { await pipeline.retry(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/api/runs/:id", async (req, res) => {
  res.json(await pipeline.getRun(Number(req.params.id)));
});

// ---- admin: module version export (for revising a module from Cowork) -------
router.get("/api/admin/modules", requireManager, async (_req, res) => {
  const modules = (await q("SELECT * FROM platform.modules ORDER BY name")).rows;
  const versions = (await q("SELECT module, version, source, notes, created_at FROM platform.module_versions ORDER BY module, version")).rows;
  res.json({ modules, versions });
});

router.get("/api/admin/modules/:name/export", requireManager, async (req, res) => {
  const row = (await q("SELECT * FROM platform.modules WHERE name=$1", [req.params.name])).rows[0];
  if (!row) return res.status(404).json({ error: "unknown module" });
  const version = req.query.version ? Number(req.query.version) : row.live_version;
  const files = await registry.versionFiles(row.name, version);
  if (!files) return res.status(404).json({ error: "no such version" });
  res.json({ module: row.name, version, live_version: row.live_version, files });
});

router.get("/api/admin/events", requireManager, async (_req, res) => {
  res.json((await q("SELECT * FROM platform.events ORDER BY id DESC LIMIT 200")).rows);
});

module.exports = router;
