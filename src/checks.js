// The checks log (docs/CHECKS-CAMPAIGN.md): every build run with the verdict
// the platform gave it, why it stopped when it stopped, and the manager's own
// verdict on that verdict ("the reviewer was right" / "wrong"). The labeled set
// is exported with the diffs and replayed offline by
// scripts/replay-crosscheck.js to tune the cross-check brief without spending
// live builds. Platform code; nothing here touches modules.
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { q } = require("./db");
const registry = require("./registry");
const agent = require("./agent");
const { requireManager } = require("./auth");
const { record, actor } = require("./record");

// Why a run stopped, in one word the campaign can count on.
function reasonFor(run) {
  const ev = run.evidence || {};
  const errs = (run.log || []).filter((l) => l.step === "error").map((l) => String(l.note || ""));
  const last = errs[errs.length - 1] || "";
  const cc = ev.cross_check || {};
  const reviewerFailed = cc.verdict === "fail" && cc.model !== "platform checks";
  if (["deployed", "rolled_back"].includes(run.status)) return reviewerFailed ? "deployed over a reviewer stop" : "deployed";
  if (run.status === "waiting" && run.step === "await_deploy") return reviewerFailed ? "at the gate over a reviewer stop" : "at the gate";
  if (run.status === "cancelled") return reviewerFailed ? "cancelled after a reviewer stop" : /aborted/.test(JSON.stringify(run.log || [])) ? "aborted" : "cancelled";
  if (run.status === "running" || run.status === "queued") return "in flight";
  if (run.status === "waiting") return "waiting on the manager";
  if (cc.verdict === "fail" && cc.model === "platform checks" && ev.gate && ev.gate.ok === false) return "module gate";   // src/modulegate.js: server code or lane rules, before anything ran
  if (cc.verdict === "fail" && cc.model === "platform checks") return "platform checks";
  if (cc.verdict === "fail") return "reviewer failed it";
  if (/migration .* (rejected|failed)/i.test(last) || /migration/i.test(last) && /reject/i.test(last)) return "migration rejected";
  // the platform's tests, told apart since build order item 7 (src/acceptance.js, src/pageload.js)
  if (ev.checks && ev.checks.ok === false && ev.checks.kind) return { promise: "broke an earlier promise", own_check: "its own check failed", page: "a screen broke on opening", smoke: "an endpoint did not answer" }[ev.checks.kind] || "tests failed";
  if (/^internal tests failed/i.test(last) || run.step === "test_run") return "tests failed";
  if (/^visual check failed/i.test(last)) return "visual check failed";
  if (/cost passed|safety budget|monthly AI cap/i.test(last)) return "cost cap";
  if (/build agent failed|agent run ended|API answered with an error/i.test(last)) return "agent died";
  if (/platform restarted/i.test(last)) return "restart";
  if (/staging failed/i.test(last)) return "staging failed";
  return run.status === "failed" ? "other failure" : run.status;
}

// Rebuild a run's diff from the stored versions, exactly as the pipeline
// made it (diff -ruN over two trees), so a replay judges the same text.
async function diffForRun(run) {
  const to = await registry.versionFiles(run.company, run.module, run.to_version);
  if (!to) throw new Error("the built version's files are gone");
  const from = run.from_version ? (await registry.versionFiles(run.company, run.module, run.from_version)) || {} : {};
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sos-replay-"));
  const a = path.join(base, "versions", String(run.from_version || 0)), b = path.join(base, "versions", String(run.to_version));
  for (const [dir, files] of [[a, from], [b, to]]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
  }
  let diff = "";
  try { diff = execFileSync("diff", ["-ruN", a, b], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }); }
  catch (e) { diff = e.stdout || ""; }
  fs.rmSync(base, { recursive: true, force: true });
  return diff;
}

// Run the CURRENT brief against an old run, with a chosen model, and keep the
// result next to the original verdict. This is the campaign's inner loop
// without a Terminal: edit the brief, push, replay, compare to the labels.
async function replayRun(runId, model) {
  const run = (await q("SELECT * FROM platform.build_runs WHERE id=$1", [runId])).rows[0];
  if (!run) throw new Error("run not found");
  if (!run.to_version) throw new Error("this run never built a version, nothing to review");
  const pipeline = require("./pipeline");
  const m = agent.MODELS.some((x) => x.id === model) ? model : await agent.modelFor(run.company, "review");
  const ps = (await q("SELECT target_file FROM platform.proposals WHERE id = ANY($1::int[])", [run.proposal_ids || [run.proposal_id]])).rows;
  const p0 = (await q("SELECT body FROM platform.proposals WHERE id=$1", [run.proposal_id])).rows[0];
  const diff = await diffForRun(run);
  const { data, costUsd } = await pipeline.crossCheckCall({ model: m, lane: run.lane, targets: ps.map((x) => x.target_file).filter(Boolean), requirement: run.requirement || (p0 && p0.body) || "", diff, fromVersion: run.from_version, toVersion: run.to_version });
  const row = (await q(
    "INSERT INTO platform.check_replays (run_id, model, verdict, summary, findings, cost_usd) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [runId, m, data.verdict, data.summary, JSON.stringify(data.findings || []), costUsd || 0])).rows[0];
  await agent.recordUsage(run.company, run.module, "replay", m, costUsd || 0, { run: runId, verdict: data.verdict });
  return row;
}

async function listChecks(company) {
  const replays = (await q("SELECT r.* FROM platform.check_replays r JOIN platform.build_runs b ON b.id = r.run_id WHERE b.company=$1 ORDER BY r.id", [company])).rows;
  const byRun = {};
  for (const r of replays) (byRun[r.run_id] = byRun[r.run_id] || []).push({ id: r.id, model: r.model, verdict: r.verdict, summary: r.summary, findings: r.findings || [], cost_usd: Number(r.cost_usd || 0), created_at: r.created_at });
  const runs = (await q(
    `SELECT r.*, l.label, l.note AS label_note, l.labeled_by, l.updated_at AS labeled_at,
            (SELECT array_agg(p.target_file) FROM platform.proposals p WHERE p.id = ANY(COALESCE(r.proposal_ids, ARRAY[r.proposal_id]))) AS targets,
            (SELECT string_agg(p.body, ' || ') FROM platform.proposals p WHERE p.id = ANY(COALESCE(r.proposal_ids, ARRAY[r.proposal_id]))) AS proposals_text
       FROM platform.build_runs r
       LEFT JOIN platform.check_labels l ON l.run_id = r.id
      WHERE r.company=$1 ORDER BY r.id DESC`, [company])).rows;
  return runs.map((r) => {
    const ev = r.evidence || {};
    const errs = (r.log || []).filter((l) => l.step === "error").map((l) => l.note);
    return {
      id: r.id, module: r.module, lane: r.lane, model: r.model, step: r.step, status: r.status, created_at: r.created_at, updated_at: r.updated_at,
      cost_usd: Number(r.cost_usd || 0), from_version: r.from_version, to_version: r.to_version,
      reason: reasonFor(r), reviewer_failed: Boolean(ev.cross_check && ev.cross_check.verdict === "fail" && ev.cross_check.model !== "platform checks"), error: errs[errs.length - 1] || null, fix_round: ev.fix_round || 0,
      cross_check: ev.cross_check ? { verdict: ev.cross_check.verdict, model: ev.cross_check.model, summary: ev.cross_check.summary, findings: ev.cross_check.findings || [], overridden: Boolean(ev.cross_check.overridden), model_verdict: ev.cross_check.model_verdict } : null,
      test_run: ev.test_run || null, models_seen: ev.models_seen || null, effort: ev.effort || null,
      title: ev.title || null, targets: (r.targets || []).filter(Boolean), proposals_text: r.proposals_text,
      label: r.label || null, label_note: r.label_note || null, labeled_by: r.labeled_by || null, labeled_at: r.labeled_at || null,
      replays: byRun[r.id] || [],
    };
  });
}

// The labeled cases with everything the replay needs: requirement, lane,
// targets, and the files before and after (the replay rebuilds the diff).
async function exportChecks(company, { onlyLabeled = false } = {}) {
  const rows = await listChecks(company);
  const out = [];
  for (const c of rows) {
    if (onlyLabeled && !c.label) continue;
    if (!c.to_version) continue;
    const run = (await q("SELECT requirement FROM platform.build_runs WHERE id=$1", [c.id])).rows[0];
    const to = await registry.versionFiles(company, c.module, c.to_version);
    const from = c.from_version ? await registry.versionFiles(company, c.module, c.from_version) : {};
    if (!to) continue;
    const changed = {};
    for (const f of new Set([...Object.keys(from || {}), ...Object.keys(to)])) if ((from || {})[f] !== to[f]) changed[f] = { from: (from || {})[f] ?? null, to: to[f] ?? null };
    out.push({ ...c, requirement: run ? run.requirement : null, proposals: c.proposals_text, files: changed });
  }
  return { format: "sos-checks-1", company, exported_at: new Date().toISOString(), cases: out };
}

const router = express.Router();
const json = express.json({ limit: "1mb" });

router.get("/api/c/:slug/checks", requireManager, async (req, res) => {
  try {
    const rows = await listChecks(req.params.slug);
    const counts = {};
    for (const r of rows) counts[r.reason] = (counts[r.reason] || 0) + 1;
    const labeled = rows.filter((r) => r.label);
    const wrong = labeled.filter((r) => r.label === "wrong");
    res.json({ runs: rows, counts, labeled: labeled.length, wrong: wrong.length, models: require("./agent").MODELS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/runs/:id/label", requireManager, json, async (req, res) => {
  const { label, note } = req.body || {};
  if (!["right", "wrong", "unsure", ""].includes(String(label || ""))) return res.status(400).json({ error: "label must be right, wrong or unsure" });
  try {
    if (!label) await q("DELETE FROM platform.check_labels WHERE run_id=$1", [Number(req.params.id)]);
    else await q(`INSERT INTO platform.check_labels (run_id, label, note, labeled_by) VALUES ($1,$2,$3,$4)
                  ON CONFLICT (run_id) DO UPDATE SET label=EXCLUDED.label, note=EXCLUDED.note, labeled_by=EXCLUDED.labeled_by, updated_at=now()`,
      [Number(req.params.id), label, String(note || "").slice(0, 1000) || null, req.sosRole]);
    const run = (await q("SELECT company, module, to_version FROM platform.build_runs WHERE id=$1", [Number(req.params.id)])).rows[0];
    if (run) await record("label_set", { company: run.company, module: run.module, actor: actor(req), run_id: Number(req.params.id), version: run.to_version, after: label || null, detail: { note: String(note || "").slice(0, 1000) || null } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/api/runs/:id/replay", requireManager, json, async (req, res) => {
  try { res.json(await replayRun(Number(req.params.id), String((req.body || {}).model || ""))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get("/api/c/:slug/checks/export", requireManager, async (req, res) => {
  try {
    const data = await exportChecks(req.params.slug, { onlyLabeled: req.query.labeled === "1" });
    res.set("Content-Disposition", `attachment; filename="checks-${req.params.slug}-${new Date().toISOString().slice(0, 10)}.json"`).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, listChecks, exportChecks, reasonFor, replayRun, diffForRun };
