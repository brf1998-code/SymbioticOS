// Build pipeline: the two lanes.
//
//   UI lane:            build -> visual_check -> await_deploy
//   Functionality lane: confirm_requirement (manager gate) -> build
//                       -> cross_check (independent agent) -> test_run -> await_deploy
//
// State lives in platform.build_runs (step/status). Steps run async; the board
// polls. Failures stop the run in place with a plain-language log entry.
const { q, logEvent } = require("./db");
const { runAgent, runStructured, haveKey, assertUnderCap } = require("./agent");
const registry = require("./registry");

const CROSS_CHECK_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string", description: "What was checked and what was found, in plain language." },
    issues: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "summary"],
};

async function log(runId, entry) {
  await q(
    `UPDATE platform.build_runs SET log = log || $2::jsonb, updated_at=now() WHERE id=$1`,
    [runId, JSON.stringify([{ t: new Date().toISOString(), ...entry }])]);
}
async function setRun(runId, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(", ");
  await q(`UPDATE platform.build_runs SET ${sets}, updated_at=now() WHERE id=$1`,
    [runId, ...keys.map((k) => (typeof fields[k] === "object" ? JSON.stringify(fields[k]) : fields[k]))]);
}
async function addCost(runId, usd) {
  await q("UPDATE platform.build_runs SET cost_usd = cost_usd + $2 WHERE id=$1", [runId, usd || 0]);
}
async function getRun(runId) {
  return (await q("SELECT * FROM platform.build_runs WHERE id=$1", [runId])).rows[0];
}

// ---- entry point: start a run from one or more approved proposals ----------
// A batch = several approved proposals for the same module built together in
// ONE agent run, one staged demo, one deploy. Only one run is active per
// module at a time; further runs queue and start when the active one ends.
async function loadProposals(ids) {
  const rows = (await q("SELECT p.*, f.module, f.message, f.page, f.name FROM platform.proposals p JOIN platform.feedback f ON f.id=p.feedback_id WHERE p.id = ANY($1::int[]) ORDER BY p.id", [ids])).rows;
  if (rows.length !== ids.length) throw new Error("one or more proposals not found");
  return rows;
}

async function activeRun(mod) {
  return (await q(
    "SELECT * FROM platform.build_runs WHERE module=$1 AND status IN ('running','waiting') ORDER BY id LIMIT 1", [mod])).rows[0];
}

async function startRun(proposalIds) {
  const ids = (Array.isArray(proposalIds) ? proposalIds : [proposalIds]).map(Number);
  const ps = await loadProposals(ids);
  for (const p of ps) if (p.status !== "approved") throw new Error(`proposal #${p.id} is not approved`);
  const mod = ps[0].module;
  if (ps.some((p) => p.module !== mod)) throw new Error("a batch must be for one module");
  const modRow = (await q("SELECT * FROM platform.modules WHERE name=$1", [mod])).rows[0];
  if (!modRow) throw new Error(`feedback has no valid module (${mod})`);
  await assertUnderCap();

  const lane = ps.every((p) => p.class === "ui") ? "ui" : "functionality";
  const step = lane === "ui" ? "build" : "confirm_requirement";
  const busy = await activeRun(mod);
  const r = await q(
    `INSERT INTO platform.build_runs (proposal_id, proposal_ids, module, from_version, lane, step, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [ids[0], ids, mod, modRow.live_version, lane, step, busy ? "queued" : "running"]);
  const run = r.rows[0];
  await q("UPDATE platform.feedback SET status='in_progress', updated_at=now() WHERE id = ANY($1::int[])", [ps.map((p) => p.feedback_id)]);
  await logEvent("run_started", run.id, { lane, module: mod, batch: ids, queued: Boolean(busy) });
  if (busy) {
    await log(run.id, { step, note: `queued behind run #${busy.id}` });
    return run;
  }
  advance(run.id).catch((e) => failRun(run.id, e));
  return run;
}

// Start the oldest queued run for a module once the active one has ended.
async function kickQueue(mod) {
  if (await activeRun(mod)) return;
  const next = (await q(
    "SELECT * FROM platform.build_runs WHERE module=$1 AND status='queued' ORDER BY id LIMIT 1", [mod])).rows[0];
  if (!next) return;
  const modRow = (await q("SELECT * FROM platform.modules WHERE name=$1", [mod])).rows[0];
  await setRun(next.id, { status: "running", from_version: modRow.live_version });
  await log(next.id, { step: next.step, note: "started from the queue" });
  advance(next.id).catch((e) => failRun(next.id, e));
}

// Text block describing every proposal in the run, for prompts.
async function proposalsText(run) {
  const ps = await loadProposals(run.proposal_ids || [run.proposal_id]);
  return ps.map((p, i) => `${ps.length > 1 ? `Change ${i + 1} of ${ps.length}` : "Approved proposal"} (${p.class}):\n${p.body}\nOriginal floor feedback: "${p.message}" (from page ${p.page || "unknown"}, by ${p.name || "anonymous"})`).join("\n\n");
}

async function failRun(runId, err) {
  console.error(`run ${runId} failed:`, err);
  if (err && typeof err.costUsd === "number") await addCost(runId, err.costUsd);
  await log(runId, { step: "error", note: String(err.message || err) });
  await setRun(runId, { status: "failed" });
  const run = await getRun(runId);
  if (run) kickQueue(run.module).catch((e) => console.error("queue kick failed:", e));
}

// ---- the state machine -----------------------------------------------------
async function advance(runId) {
  const run = await getRun(runId);
  const p = (await q("SELECT * FROM platform.proposals WHERE id=$1", [run.proposal_id])).rows[0];
  const batch = await proposalsText(run);
  const isBatch = (run.proposal_ids || []).length > 1;

  try {
    if (run.step === "confirm_requirement") {
      // Agent restates the requirement in plain language; manager must confirm
      // before any code is written.
      let requirement;
      let cost = 0;
      if (haveKey()) {
        const out = await runStructured({
          system: "Restate a change requirement for a factory software module in plain language. The reader is a production manager. List concretely what will change and what will NOT change. No code talk.",
          prompt: `${batch}\n\nRestate the requirement${isBatch ? " for the whole batch, change by change," : ""} as: (1) what changes, (2) what stays the same, (3) how we will know it works.`,
          schema: { type: "object", properties: { requirement: { type: "string" } }, required: ["requirement"] },
          toolName: "requirement",
        });
        requirement = out.data.requirement; cost = out.costUsd;
      } else {
        requirement = `[AI not configured] Requirement to confirm manually:\n${batch}`;
      }
      await addCost(runId, cost);
      await setRun(runId, { requirement, status: "waiting" });
      await log(runId, { step: "confirm_requirement", note: "requirement drafted, waiting on manager confirmation" });
      return; // resumes via confirmRequirement()
    }

    if (run.step === "build") {
      await assertUnderCap();
      const draft = await registry.createDraftVersion(run.module);
      await setRun(runId, { to_version: draft.version });
      await log(runId, { step: "build", note: `draft version v${draft.version} created` });
      const req = run.requirement ? `\n\nConfirmed requirement:\n${run.requirement}` : "";
      const { text, costUsd } = await runAgent({
        moduleName: run.module,
        dir: draft.dir,
        prompt:
`You are implementing ${isBatch ? "a batch of approved changes" : "an approved change"} to the "${run.module}" module of a factory operating system. Work only inside this directory; it is a full copy of the live module version and will become the next version.

${batch}
${req}

Rules:
- ${run.lane === "ui" ? "This is a UI-class change. Do NOT modify routes.js logic, module.json smoke list, or migrations. Touch pages/ and presentation only." : "This is a functionality-class change. If the data model must change, add a NEW migrations/NNN.sql file (additive only: CREATE TABLE / ALTER TABLE ADD COLUMN / CREATE INDEX / INSERT seed rows; bare table names, no schema prefixes). Never edit an existing migration file."}
${isBatch ? "- Implement every change in the batch. Keep them independent where you can so one can be understood without the others.\n" : ""}- Keep the module's existing style and structure. Plain HTML/JS, no frameworks.
- Make the smallest change that removes the reported friction.
- When done, summarize what changed in short bullets (one per change), in plain language for a production manager.`,
      });
      await addCost(runId, costUsd);
      await setRun(runId, { evidence: { ...run.evidence, build_summary: text } });
      await log(runId, { step: "build", note: "agent build complete" });
      await registry.stageVersion(run.module, (await getRun(runId)).to_version);
      await log(runId, { step: "stage", note: "staged version mounted at /staging" });
      await setRun(runId, { step: run.lane === "ui" ? "visual_check" : "cross_check" });
      return advance(runId);
    }

    if (run.step === "visual_check") {
      const ok = await smokeCheck(run.module, true);
      if (!ok.ok) throw new Error(`visual check failed: ${ok.detail}`);
      const cur = await getRun(runId);
      await setRun(runId, { step: "await_deploy", status: "waiting", evidence: { ...cur.evidence, visual_check: ok } });
      await log(runId, { step: "visual_check", note: "staged pages render; ready for manager review" });
      return;
    }

    if (run.step === "cross_check") {
      let evidenceUpdate = {};
      if (haveKey()) {
        const cur = await getRun(runId);
        const { data, costUsd } = await runStructuredCrossCheck(run, p, cur);
        await addCost(runId, costUsd);
        evidenceUpdate = { cross_check: data };
        if (data.verdict === "fail") {
          const c2 = await getRun(runId);
          await setRun(runId, { evidence: { ...c2.evidence, cross_check: data } });
          throw new Error(`cross-check failed: ${data.summary}`);
        }
      } else {
        evidenceUpdate = { cross_check: { verdict: "skipped", summary: "AI not configured" } };
      }
      const cur = await getRun(runId);
      await setRun(runId, { step: "test_run", evidence: { ...cur.evidence, ...evidenceUpdate } });
      await log(runId, { step: "cross_check", note: "independent review passed" });
      return advance(runId);
    }

    if (run.step === "test_run") {
      const ok = await smokeCheck(run.module, true);
      const cur = await getRun(runId);
      await setRun(runId, { evidence: { ...cur.evidence, test_run: ok } });
      if (!ok.ok) throw new Error(`internal tests failed: ${ok.detail}`);
      await setRun(runId, { step: "await_deploy", status: "waiting" });
      await log(runId, { step: "test_run", note: `smoke checks passed (${ok.checked.length} endpoints)` });
      return;
    }
  } catch (e) {
    return failRun(runId, e);
  }
}

async function runStructuredCrossCheck(run, proposal, cur) {
  const dir = registry.versionDir(run.module, cur.to_version);
  const fromDir = registry.versionDir(run.module, run.from_version);
  const { execFileSync } = require("child_process");
  let diff = "";
  try {
    diff = execFileSync("diff", ["-ru", fromDir, dir], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch (e) { diff = e.stdout || ""; } // diff exits 1 when files differ
  return runStructured({
    system: "You are an independent reviewer of a code change to a factory software module. You did not write this change. Review it strictly against the confirmed requirement. Fail it if it changes anything beyond the requirement, breaks existing behavior, edits an existing migration, or uses forbidden SQL operations.",
    prompt: `Confirmed requirement:\n${cur.requirement || proposal.body}\n\nUnified diff of the change (v${run.from_version} -> v${cur.to_version}):\n${diff.slice(0, 40000) || "(no textual diff found)"}`,
    schema: CROSS_CHECK_SCHEMA,
    toolName: "verdict",
  });
}

// Hit the module's declared smoke endpoints on the staged (or live) mount.
// Runs as an internal request with a manager session so auth does not block it.
async function smokeCheck(mod, staged) {
  const row = (await q("SELECT * FROM platform.modules WHERE name=$1", [mod])).rows[0];
  const version = staged ? row.staged_version : row.live_version;
  const manifest = registry.readManifest(mod, version);
  const base = `http://127.0.0.1:${process.env.PORT || 3000}${staged ? "/staging" : ""}/m/${mod}`;
  const targets = ["/", ...(manifest.smoke || [])];
  const checked = [];
  const headers = { "x-sos-internal": process.env.SOS_INTERNAL_TOKEN || "" };
  for (const t of targets) {
    const res = await fetch(base + t, { headers }).catch((e) => ({ status: 0, err: e.message }));
    checked.push({ url: t, status: res.status });
    if (!res.status || res.status >= 500) {
      return { ok: false, detail: `${t} returned ${res.status || res.err}`, checked };
    }
  }
  return { ok: true, checked };
}

// ---- manager actions -------------------------------------------------------
async function confirmRequirement(runId, edited) {
  const run = await getRun(runId);
  if (run.step !== "confirm_requirement" || run.status !== "waiting") throw new Error("run is not waiting on requirement confirmation");
  if (edited) await setRun(runId, { requirement: edited });
  await setRun(runId, { step: "build", status: "running" });
  await log(runId, { step: "confirm_requirement", note: "manager confirmed requirement" });
  advance(runId).catch((e) => failRun(runId, e));
}

async function deploy(runId) {
  const run = await getRun(runId);
  if (run.step !== "await_deploy" || run.status !== "waiting") throw new Error("run is not awaiting deploy");
  const result = await registry.deployVersion(run.module, run.to_version);
  await setRun(runId, { status: "deployed" });
  await log(runId, { step: "deploy", note: `v${result.from} -> v${result.to} live` });
  const ps = await loadProposals(run.proposal_ids || [run.proposal_id]);
  const summary = ((run.evidence || {}).build_summary || "").slice(0, 600);
  for (const p of ps) {
    await q(
      "UPDATE platform.feedback SET status='done', outcome=$2, updated_at=now() WHERE id=$1",
      [p.feedback_id, `Deployed v${result.to}${ps.length > 1 ? ` (batch of ${ps.length})` : ""}: ${summary || p.body.slice(0, 500)}`]);
  }
  kickQueue(run.module).catch((e) => console.error("queue kick failed:", e));
  return result;
}

async function rollbackRun(runId) {
  const run = await getRun(runId);
  const result = await registry.rollback(run.module);
  await setRun(runId, { status: "rolled_back" });
  await log(runId, { step: "rollback", note: `restored v${result.to}` });
  const ps = await loadProposals(run.proposal_ids || [run.proposal_id]);
  for (const p of ps) {
    await q("UPDATE platform.feedback SET outcome=$2, updated_at=now() WHERE id=$1", [p.feedback_id, `Rolled back to v${result.to}.`]);
  }
  return result;
}

// Retry a failed run from the build step (new draft, same proposal).
async function retry(runId) {
  const run = await getRun(runId);
  if (run.status !== "failed") throw new Error("only failed runs can be retried");
  const step = run.lane === "ui" || run.requirement ? "build" : "confirm_requirement";
  const busy = await activeRun(run.module);
  const modRow = (await q("SELECT * FROM platform.modules WHERE name=$1", [run.module])).rows[0];
  await setRun(runId, { step, status: busy ? "queued" : "running", from_version: modRow.live_version });
  await log(runId, { step, note: busy ? `manager retried; queued behind run #${busy.id}` : "manager retried the run" });
  if (!busy) advance(runId).catch((e) => failRun(runId, e));
}

// Cancel a queued or failed run: proposals go back to reviewing.
async function cancel(runId) {
  const run = await getRun(runId);
  if (!["queued", "failed"].includes(run.status)) throw new Error("only queued or failed runs can be cancelled");
  await setRun(runId, { status: "cancelled" });
  const ps = await loadProposals(run.proposal_ids || [run.proposal_id]);
  await q("UPDATE platform.proposals SET status='draft' WHERE id = ANY($1::int[])", [ps.map((p) => p.id)]);
  await q("UPDATE platform.feedback SET status='reviewing', updated_at=now() WHERE id = ANY($1::int[])", [ps.map((p) => p.feedback_id)]);
  await log(runId, { step: run.step, note: "cancelled by manager; proposals back to review" });
}

module.exports = { startRun, confirmRequirement, deploy, rollbackRun, retry, cancel, getRun, smokeCheck, kickQueue };
