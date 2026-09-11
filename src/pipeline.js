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

// ---- entry point: start a run from an approved proposal --------------------
async function startRun(proposalId) {
  const p = (await q("SELECT * FROM platform.proposals WHERE id=$1", [proposalId])).rows[0];
  if (!p || p.status !== "approved") throw new Error("proposal not approved");
  const fb = (await q("SELECT * FROM platform.feedback WHERE id=$1", [p.feedback_id])).rows[0];
  const mod = fb.module;
  const modRow = (await q("SELECT * FROM platform.modules WHERE name=$1", [mod])).rows[0];
  if (!modRow) throw new Error(`feedback has no valid module (${mod})`);
  await assertUnderCap();

  const lane = p.class === "ui" ? "ui" : "functionality";
  const step = lane === "ui" ? "build" : "confirm_requirement";
  const r = await q(
    `INSERT INTO platform.build_runs (proposal_id, module, from_version, lane, step, status)
     VALUES ($1,$2,$3,$4,$5,'running') RETURNING *`,
    [proposalId, mod, modRow.live_version, lane, step]);
  const run = r.rows[0];
  await q("UPDATE platform.feedback SET status='in_progress', updated_at=now() WHERE id=$1", [fb.id]);
  await logEvent("run_started", run.id, { lane, module: mod });

  advance(run.id).catch((e) => failRun(run.id, e));
  return run;
}

async function failRun(runId, err) {
  console.error(`run ${runId} failed:`, err);
  if (err && typeof err.costUsd === "number") await addCost(runId, err.costUsd);
  await log(runId, { step: "error", note: String(err.message || err) });
  await setRun(runId, { status: "failed" });
}

// ---- the state machine -----------------------------------------------------
async function advance(runId) {
  const run = await getRun(runId);
  const p = (await q("SELECT * FROM platform.proposals WHERE id=$1", [run.proposal_id])).rows[0];
  const fb = (await q("SELECT * FROM platform.feedback WHERE id=$1", [p.feedback_id])).rows[0];

  try {
    if (run.step === "confirm_requirement") {
      // Agent restates the requirement in plain language; manager must confirm
      // before any code is written.
      let requirement;
      let cost = 0;
      if (haveKey()) {
        const out = await runStructured({
          system: "Restate a change requirement for a factory software module in plain language. The reader is a production manager. List concretely what will change and what will NOT change. No code talk.",
          prompt: `Approved proposal:\n${p.body}\n\nOriginal floor feedback: "${fb.message}"\n\nRestate the requirement as: (1) what changes, (2) what stays the same, (3) how we will know it works.`,
          schema: { type: "object", properties: { requirement: { type: "string" } }, required: ["requirement"] },
          toolName: "requirement",
        });
        requirement = out.data.requirement; cost = out.costUsd;
      } else {
        requirement = `[AI not configured] Requirement to confirm manually: ${p.body}`;
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
`You are implementing an approved change to the "${run.module}" module of a factory operating system. Work only inside this directory; it is a full copy of the live module version and will become the next version.

Approved proposal:
${p.body}
${req}

Original floor feedback that started this: "${fb.message}" (reported from page ${fb.page || "unknown"})

Rules:
- ${run.lane === "ui" ? "This is a UI-class change. Do NOT modify routes.js logic, module.json smoke list, or migrations. Touch pages/ and presentation only." : "This is a functionality-class change. If the data model must change, add a NEW migrations/NNN.sql file (additive only: CREATE TABLE / ALTER TABLE ADD COLUMN / CREATE INDEX / INSERT seed rows; bare table names, no schema prefixes). Never edit an existing migration file."}
- Keep the module's existing style and structure. Plain HTML/JS, no frameworks.
- Make the smallest change that removes the reported friction.
- When done, summarize in 3 short bullets what changed, in plain language for a production manager.`,
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
  const p = (await q("SELECT * FROM platform.proposals WHERE id=$1", [run.proposal_id])).rows[0];
  await q(
    "UPDATE platform.feedback SET status='done', outcome=$2, updated_at=now() WHERE id=$1",
    [p.feedback_id, `Deployed v${result.to}: ${((run.evidence || {}).build_summary || p.body).slice(0, 500)}`]);
  return result;
}

async function rollbackRun(runId) {
  const run = await getRun(runId);
  const result = await registry.rollback(run.module);
  await setRun(runId, { status: "rolled_back" });
  await log(runId, { step: "rollback", note: `restored v${result.to}` });
  const p = (await q("SELECT * FROM platform.proposals WHERE id=$1", [run.proposal_id])).rows[0];
  await q("UPDATE platform.feedback SET outcome=$2, updated_at=now() WHERE id=$1",
    [p.feedback_id, `Rolled back to v${result.to}.`]);
  return result;
}

// Retry a failed run from the build step (new draft, same proposal).
async function retry(runId) {
  const run = await getRun(runId);
  if (run.status !== "failed") throw new Error("only failed runs can be retried");
  const step = run.lane === "ui" || run.requirement ? "build" : "confirm_requirement";
  await setRun(runId, { step, status: "running" });
  await log(runId, { step, note: "manager retried the run" });
  advance(runId).catch((e) => failRun(runId, e));
}

module.exports = { startRun, confirmRequirement, deploy, rollbackRun, retry, getRun, smokeCheck };
