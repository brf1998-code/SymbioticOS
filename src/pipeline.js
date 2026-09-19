// Build pipeline: the two lanes.
//
//   UI lane:            build -> visual_check -> await_deploy
//   Functionality lane: confirm_requirement (manager gate) -> build
//                       -> cross_check (independent agent) -> test_run -> await_deploy
//
// State lives in platform.build_runs (step/status). Steps run async; the board
// polls. Failures stop the run in place with a plain-language log entry.
//
// A batch = several approved proposals for the same module built together in
// ONE agent run, one staged demo, one deploy. Only one run is active per
// module at a time; further runs queue and start when the active one ends.
const { q, logEvent } = require("./db");
const { runAgent, runStructured, haveKey, assertUnderCap, modelFor, buildModelFor, guidanceFor, runCapUsd, MODELS, AGENT_EFFORT } = require("./agent");
const registry = require("./registry");
const gate = require("./modulegate");

const CROSS_CHECK_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"], description: "fail only when at least one finding is blocking." },
    summary: { type: "string", description: "What was checked and what was found, in plain language for a production manager. Two to five sentences." },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocking", "minor"], description: "blocking = the requirement is not met, or the floor would notice something wrong or missing, or a hard rule is broken. minor = worth a note, does not stop the deploy." },
          where: { type: "string", description: "File and place." },
          what: { type: "string", description: "The problem, one or two sentences, plain words." },
          evidence: { type: "string", description: "The diff lines that show it (quote them). Required for a blocking finding." },
        },
        required: ["severity", "where", "what", "evidence"],
      },
    },
  },
  required: ["verdict", "summary", "findings"],
};

async function log(runId, entry) {
  await q(`UPDATE platform.build_runs SET log = log || $2::jsonb, updated_at=now() WHERE id=$1`,
    [runId, JSON.stringify([{ t: new Date().toISOString(), ...entry }])]);
}
async function setRun(runId, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(", ");
  await q(`UPDATE platform.build_runs SET ${sets}, updated_at=now() WHERE id=$1`,
    [runId, ...keys.map((k) => (fields[k] !== null && typeof fields[k] === "object" ? JSON.stringify(fields[k]) : fields[k]))]);
}
async function addCost(runId, usd) {
  await q("UPDATE platform.build_runs SET cost_usd = cost_usd + $2 WHERE id=$1", [runId, usd || 0]);
}
async function getRun(runId) {
  return (await q("SELECT * FROM platform.build_runs WHERE id=$1", [runId])).rows[0];
}
async function loadProposals(ids) {
  const rows = (await q(
    `SELECT p.*, f.company, f.module, f.message, f.page, f.screen, f.name AS reporter
       FROM platform.proposals p JOIN platform.feedback f ON f.id=p.feedback_id
      WHERE p.id = ANY($1::int[]) ORDER BY p.id`, [ids])).rows;
  if (rows.length !== ids.length) throw new Error("one or more proposals not found");
  return rows;
}
async function activeRun(company, mod) {
  return (await q(
    "SELECT * FROM platform.build_runs WHERE company=$1 AND module=$2 AND status IN ('running','waiting') ORDER BY id LIMIT 1", [company, mod])).rows[0];
}

// ---- entry point: start a run from one or more approved proposals ----------
async function startRun(proposalIds, opts = {}) {
  const ids = (Array.isArray(proposalIds) ? proposalIds : [proposalIds]).map(Number);
  const ps = await loadProposals(ids);
  for (const p of ps) if (p.status !== "approved") throw new Error(`proposal #${p.id} is not approved`);
  const { company, module: mod } = ps[0];
  if (ps.some((p) => p.module !== mod || p.company !== company)) throw new Error("a batch must be for one module");
  const modRow = await registry.getModule(company, mod);
  if (!modRow) throw new Error(`feedback has no valid module (${company}/${mod})`);
  await assertUnderCap();

  const lane = ps.every((p) => p.class === "ui") ? "ui" : "functionality";
  const step = lane === "ui" ? "build" : "confirm_requirement";
  const model = opts.model && MODELS.some((m) => m.id === opts.model) ? opts.model : await modelFor(company, "build");
  const busy = await activeRun(company, mod);
  const r = await q(
    `INSERT INTO platform.build_runs (proposal_id, proposal_ids, company, module, from_version, lane, step, status, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [ids[0], ids, company, mod, modRow.live_version, lane, step, busy ? "queued" : "running", model]);
  const run = r.rows[0];
  await q("UPDATE platform.feedback SET status='in_progress', updated_at=now() WHERE id = ANY($1::int[])", [ps.map((p) => p.feedback_id)]);
  await logEvent("run_started", run.id, { lane, company, module: mod, batch: ids, model, queued: Boolean(busy) });
  if (busy) {
    await log(run.id, { step, note: `queued behind run #${busy.id}` });
    return run;
  }
  advance(run.id).catch((e) => failRun(run.id, e));
  return run;
}

// Start the oldest queued run for a module once the active one has ended.
async function kickQueue(company, mod) {
  if (await activeRun(company, mod)) return;
  const next = (await q(
    "SELECT * FROM platform.build_runs WHERE company=$1 AND module=$2 AND status='queued' ORDER BY id LIMIT 1", [company, mod])).rows[0];
  if (!next) return;
  const modRow = await registry.getModule(company, mod);
  await setRun(next.id, { status: "running", from_version: modRow.live_version });
  await log(next.id, { step: next.step, note: "started from the queue" });
  advance(next.id).catch((e) => failRun(next.id, e));
}

// Text block describing every proposal in the run, for prompts.
async function proposalsText(run) {
  const ps = await loadProposals(run.proposal_ids || [run.proposal_id]);
  return ps.map((p, i) =>
    `${ps.length > 1 ? `Change ${i + 1} of ${ps.length}` : "Approved proposal"} (${p.class})\n` +
    `Target file: ${p.target_file || "unspecified"}${p.screen ? ` (the "${p.screen}" screen)` : ""}\n` +
    `${p.body}\n` +
    `Original floor feedback: "${p.message}" (filed from ${p.screen || p.page || "an unknown screen"}, by ${p.reporter || "anonymous"})`
  ).join("\n\n");
}

// Short title (for the version list) and a two-sentence "what changed" for
// operators, from the approved changes and the agent's final message.
async function plainSummary(batch, agentText, isBatch) {
  const { data, costUsd } = await runStructured({
    model: process.env.SOS_MODEL_SUMMARY || "claude-haiku-4-5-20251001",
    system: "You write one-line change notes for people on a factory floor. Plain words, no code talk, no praise, no preamble.",
    prompt: `Approved changes:\n${batch}\n\nWhat the build agent reported:\n${(agentText || "").slice(0, 3000)}\n\nWrite a title of at most 8 words naming what changed${isBatch ? " (it is a batch, so summarize the theme, e.g. 'Station page: fold names, clip position, distance unit')" : ""}, and a what_changed of one to three short sentences an operator would understand, naming the screen.`,
    schema: { type: "object", properties: { title: { type: "string" }, what_changed: { type: "string" } }, required: ["title", "what_changed"] },
    toolName: "summary",
  });
  return { title: String(data.title || "").slice(0, 80), what_changed: String(data.what_changed || "").slice(0, 600), costUsd };
}

// The AbortController of every build agent in flight, by run id, so a manager
// can abort a run that is stuck or wrong instead of waiting on the cost cap.
const ACTIVE = new Map();

async function failRun(runId, err) {
  if (err && typeof err.costUsd === "number") await addCost(runId, err.costUsd);
  const before = await getRun(runId);
  if (before && before.status === "cancelled") {
    // the manager aborted it; cancel() already recorded that
    await log(runId, { step: before.step, note: "agent stopped" });
    return;
  }
  console.error(`run ${runId} failed:`, err);
  if (err && err.diag) await log(runId, { step: "diag", note: JSON.stringify(err.diag) });
  await log(runId, { step: "error", note: String(err.message || err) });
  await setRun(runId, { status: "failed" });
  const run = await getRun(runId);
  if (run) kickQueue(run.company, run.module).catch((e) => console.error("queue kick failed:", e));
}

// ---- the state machine -----------------------------------------------------
async function advance(runId) {
  const run = await getRun(runId);
  if (run.lane === "module") return require("./modulebuild").advance(runId);   // a brand-new module from a confirmed design
  const p = (await q("SELECT * FROM platform.proposals WHERE id=$1", [run.proposal_id])).rows[0];
  const batch = await proposalsText(run);
  const isBatch = (run.proposal_ids || []).length > 1;
  const { company, module: mod } = run;

  try {
    if (run.step === "confirm_requirement") {
      // Agent restates the requirement in plain language; manager must confirm
      // before any code is written.
      // Three layers so the manager actually reads it: one BLUF sentence, one
      // sentence per change (each gets a check box on the board), and the full
      // text behind "see more" (editable before confirming).
      let requirement, bluf = "", items = [];
      let cost = 0;
      const n = (run.proposal_ids || [run.proposal_id]).length;
      if (haveKey()) {
        const out = await runStructured({
          model: await modelFor(company, "propose"),
          system: "Restate a change requirement for a factory software module in plain language. The reader is a production manager who will skim. No code talk. Never use em or en dashes.",
          prompt: `${batch}\n\nProduce three things.\n1. bluf: ONE sentence, at most 25 words, saying what will be different for the floor after this ${isBatch ? "batch" : "change"}.\n2. items: exactly ${n} entries, one per change in order (change 1 first). Each summary is ONE sentence, at most 20 words, naming the screen and what changes on it.\n3. requirement: the full statement: (1) what changes and where, (2) what stays the same, (3) how we will know it works${isBatch ? ", change by change" : ""}.`,
          schema: {
            type: "object",
            properties: {
              bluf: { type: "string" },
              items: { type: "array", items: { type: "object", properties: { change: { type: "integer" }, summary: { type: "string" } }, required: ["change", "summary"] } },
              requirement: { type: "string" },
            },
            required: ["bluf", "items", "requirement"],
          },
          toolName: "requirement",
        });
        requirement = out.data.requirement; bluf = out.data.bluf || ""; items = Array.isArray(out.data.items) ? out.data.items : []; cost = out.costUsd;
      } else {
        requirement = `[AI not configured] Requirement to confirm manually:\n${batch}`;
        bluf = "AI is not configured; read the proposals below and confirm by hand.";
      }
      // one line per change, whatever the model returned
      const ps = await loadProposals(run.proposal_ids || [run.proposal_id]);
      items = ps.map((p, i) => ({ change: i + 1, summary: String((items[i] && items[i].summary) || p.body.split(/(?<=[.!?])\s/)[0]).slice(0, 240) }));
      await addCost(runId, cost);
      const cur0 = await getRun(runId);
      await setRun(runId, { requirement, status: "waiting", evidence: { ...cur0.evidence, req_bluf: bluf.slice(0, 400), req_items: items } });
      await log(runId, { step: "confirm_requirement", note: "requirement drafted, waiting on manager confirmation" });
      return; // resumes via confirmRequirement()
    }

    if (run.step === "build") {
      await assertUnderCap();
      const ev0 = run.evidence || {};
      let draft;
      if (ev0.fix_round && run.to_version) {
        // fix round: keep working in the same draft version
        draft = { version: run.to_version, dir: await registry.materialize(company, mod, run.to_version) };
        await log(runId, { step: "build", note: `fix round ${ev0.fix_round}: agent revises v${draft.version} against the reviewer's findings` });
        // After a stop by the module gate, the platform puts back the files a
        // lane rule says must not change (a new agent session cannot know what
        // they looked like), and the agent gets the gate's own wording.
        if (ev0.gate && ev0.gate.ok === false) {
          const fromFiles0 = run.from_version ? await registry.versionFiles(company, mod, run.from_version) : null;
          const restored = gate.restoreLaneFiles(draft.dir, fromFiles0, ev0.gate);
          if (restored.length) await log(runId, { step: "build", note: `the platform put back: ${restored.join(", ")}` });
          ev0.findings = gate.forAgent(ev0.gate, restored);
        }
      } else {
        draft = await registry.createDraftVersion(company, mod);
        await setRun(runId, { to_version: draft.version });
        await log(runId, { step: "build", note: `draft version v${draft.version} created` });
      }
      const nChanges = (run.proposal_ids || [run.proposal_id]).length;
      const capUsd = runCapUsd(nChanges);
      const req = (run.requirement ? `\n\nConfirmed requirement:\n${run.requirement}` : "")
        + (ev0.fix_round && ev0.findings
          ? (ev0.gate && ev0.gate.ok === false ? `\n\n${ev0.findings}` : `\n\nAn independent reviewer looked at your previous attempt in this directory and found these problems. Fix exactly these, keep everything else as it is:\n${ev0.findings}`)
          : "");
      const guidance = await guidanceFor(company, mod);
      const { model, substituted } = await buildModelFor(company, run.model);
      if (substituted) await log(runId, { step: "build", note: `${substituted} cannot run as the build agent; building with ${model} instead` });
      const ctl = new AbortController();
      ACTIVE.set(runId, ctl);
      let agentOut;
      try {
        agentOut = await runAgent({
        model,
        capUsd,
        signal: ctl.signal,
        system: guidance.text,
        dir: draft.dir,
        prompt:
`You are implementing ${isBatch ? "a batch of approved changes" : "an approved change"} to the "${mod}" module of a factory operating system. Work only inside this directory; it is a full copy of the live module version and will become the next version.

${batch}
${req}

Rules:
- Each change names a Target file, which is the screen the feedback came from. Make the change in that file. Touch another file only if the change cannot work otherwise, and say so in your summary.
- ${run.lane === "ui" ? "This is a UI-class change. Do NOT modify routes.js, the module.json smoke list or entry, or migrations. Touch pages/ and presentation only. The platform compares the files after you finish and stops a UI-class build that changed anything else; if the change cannot work without server logic, leave the server files alone and say so in your summary." : "This is a functionality-class change. If the data model must change, add a NEW migrations/NNN.sql file (additive only: CREATE TABLE / ALTER TABLE ADD COLUMN / CREATE INDEX / INSERT seed rows; bare table names, no schema prefixes). Never edit an existing migration file."}
${isBatch ? "- Implement every change in the batch. Keep them independent where you can so one can be understood without the others.\n" : ""}- Keep the module's existing style and structure. Plain HTML/JS, no frameworks.
- Make the smallest change that removes the reported friction.
- Mark what you touched so the preview can highlight it: put data-changed="v${draft.version}" on every HTML element you add or visibly change (the element itself, not its parent). One attribute per element, nothing else; it costs nothing at runtime and the preview outlines those elements.
- Your final message must be ONLY a short bullet list of what changed (one bullet per change, naming the screen), in plain language for a production manager. No preamble, no headings, no code talk.`,
        });
      } finally { ACTIVE.delete(runId); }
      const { text, costUsd, modelsSeen } = agentOut;
      await addCost(runId, costUsd);
      const cur = await getRun(runId);
      // models_seen is the proof of which model actually built this: every
      // model id the agent process reported. Anything but exactly {model}
      // means the CLI swapped models, which CLAUDE_CODE_NO_MODEL_FALLBACK
      // should make impossible; it is logged loudly rather than hidden.
      const seen = Array.isArray(modelsSeen) ? modelsSeen : [];
      const swapped = seen.length && (seen.length > 1 || seen[0] !== model);
      await setRun(runId, { evidence: { ...cur.evidence, build_summary: text, docs: guidance.names, model, models_seen: seen, effort: AGENT_EFFORT, cap_usd: capUsd } });
      await log(runId, { step: "build", note: swapped
        ? `agent build complete, but the agent reported running on ${seen.join(", ")} instead of ${model}`
        : `agent build complete (${model}, effort ${AGENT_EFFORT}${seen.length ? ", confirmed by the agent" : ""})` });
      // The module gate (src/modulegate.js): no tokens, and BEFORE staging,
      // because staging loads the draft's routes.js into this process. A UI
      // build that touched anything but the screens, server code that reaches
      // past its own tables, an edited migration: all stop here, filed as a
      // failed check by "platform checks" so fix, retry and cancel apply
      // (override does not). The draft's text is kept for the fix round.
      {
        const fromFiles = run.from_version ? await registry.versionFiles(company, mod, run.from_version) : null;
        const verdict = gate.checkDir(draft.dir, { fromFiles, lane: run.lane });
        const c2 = await getRun(runId);
        if (!verdict.ok) {
          await registry.persistVersion(company, mod, draft.version);
          await setRun(runId, { step: "cross_check", evidence: { ...c2.evidence, gate: gate.record(verdict), cross_check: { verdict: "fail", model: "platform checks", summary: gate.summarize(verdict), findings: gate.asFindings(verdict) } } });
          await logEvent("gate_refused", runId, { company, module: mod, version: draft.version, lane: run.lane, rules: verdict.violations.map((f) => f.rule) });
          throw new Error(`platform checks failed: ${gate.oneLine(verdict)}`);
        }
        await setRun(runId, { evidence: { ...c2.evidence, gate: gate.record(verdict) } });
        await log(runId, { step: "build", note: `platform checks passed: module code and lane rules${verdict.inherited.length ? ` (${verdict.inherited.length} older finding(s) already on the floor, not from this change)` : ""}` });
      }
      // Plain-language title and summary for the version list, the Done card
      // and the feedback outcome. Cheap model; the agent's own final text is
      // often chatty despite the instruction.
      try {
        const plain = await plainSummary(batch, text, isBatch);
        await addCost(runId, plain.costUsd);
        const c3 = await getRun(runId);
        await setRun(runId, { evidence: { ...c3.evidence, title: plain.title, what_changed: plain.what_changed } });
        await q("UPDATE platform.module_versions SET notes=$4 WHERE company=$1 AND module=$2 AND version=$3", [company, mod, c3.to_version, plain.title]);
      } catch (e) { await log(runId, { step: "build", note: `summary skipped: ${e.message}` }); }
      await registry.stageVersion(company, mod, (await getRun(runId)).to_version);
      await log(runId, { step: "stage", note: "staged version mounted for preview" });
      await setRun(runId, { step: run.lane === "ui" ? "visual_check" : "cross_check" });
      return advance(runId);
    }

    if (run.step === "visual_check") {
      const ok = await smokeCheck(company, mod, true);
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
        const model = await modelFor(company, "review");
        const { data, costUsd } = await runStructuredCrossCheck(run, p, cur, model);
        await addCost(runId, costUsd);
        evidenceUpdate = { cross_check: { ...data, model } };
        if (data.verdict === "fail") {
          const c2 = await getRun(runId);
          await setRun(runId, { evidence: { ...c2.evidence, cross_check: { ...data, model } } });
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
      const ok = await smokeCheck(company, mod, true);
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

// diffOverride: a caller that has no earlier version to diff against (a brand-new
// module) hands in its own listing in unified-diff shape.
async function runStructuredCrossCheck(run, proposal, cur, model, diffOverride) {
  const dir = registry.versionDir(run.company, run.module, cur.to_version);
  const fromDir = registry.versionDir(run.company, run.module, run.from_version);
  const { execFileSync } = require("child_process");
  let diff = diffOverride || "";
  if (!diff) {
    try {
      // -N: a file the agent ADDED (a new migration, a new page) shows with its
      // whole body instead of "Only in ...: 002.sql", which left the reviewer
      // unable to see new migrations and failing them as unverifiable (run #28)
      diff = execFileSync("diff", ["-ruN", fromDir, dir], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    } catch (e) { diff = e.stdout || ""; } // diff exits 1 when files differ
  }
  if (!diff.trim()) {
    // nothing to review: the agent changed no file. Usually a request the
    // module cannot carry out (run #32 asked it to change a platform password)
    return { data: { verdict: "fail", summary: "The agent changed nothing: no file differs from the version on the floor. Usually that means the request is not something this module can do (a platform setting, an account, another system). Adjust the proposal or decline it.", findings: [{ severity: "blocking", where: "the whole change", what: "no file was changed", evidence: "(empty diff)" }], issues: ["no file was changed"], model_verdict: "fail" }, costUsd: 0 };
  }
  const ps = await loadProposals(run.proposal_ids || [run.proposal_id]).catch(() => []);
  const targets = ps.map((x) => x.target_file).filter(Boolean);
  return crossCheckCall({ model, lane: run.lane, targets, requirement: cur.requirement || proposal.body, diff, fromVersion: run.from_version, toVersion: cur.to_version });
}

// The cross-check as one pure call, so scripts/replay-crosscheck.js can run
// the same brief against exported cases without a database.
function crossCheckPrompt({ lane, targets, requirement, diff, fromVersion, toVersion }) {
  const truncated = diff.length > CROSS_CHECK_DIFF_CHARS;
  const changed = [...diff.matchAll(/^diff -ru \S+ \S+\/versions\/\d+\/(\S+)$/gm)].map((m) => m[1]);
  return `Lane: ${lane === "ui" ? "look-and-feel change (pages only)" : lane === "module" ? "a brand-new module built from a confirmed design" : "functionality change"}.${targets && targets.length ? ` Screen file(s) named by the proposals: ${targets.join(", ")}.` : ""}\nFiles touched: ${changed.length ? changed.join(", ") : "(see diff)"}.\n\nConfirmed requirement:\n${requirement}\n\nUnified diff of the change (v${fromVersion || 0} -> v${toVersion})${truncated ? `, cut at ${CROSS_CHECK_DIFF_CHARS} characters; judge only what you can see and never fail for what was cut` : ""}:\n${diff.slice(0, CROSS_CHECK_DIFF_CHARS) || "(no textual diff found)"}`;
}
async function crossCheckCall({ model, lane, targets, requirement, diff, fromVersion, toVersion }) {
  const out = await runStructured({
    model,
    system: crossCheckSystem(lane),
    prompt: crossCheckPrompt({ lane, targets, requirement, diff, fromVersion, toVersion }),
    schema: CROSS_CHECK_SCHEMA,
    toolName: "verdict",
    maxTokens: 6000,
  });
  // the rule, not the model's mood, decides: fail only on a blocking finding.
  // Findings the brief already calls minor are downgraded here as well, because
  // a reviewer keeps marking them blocking anyway (run #31: a missing
  // data-changed mark and an "if the underlying bug is..." guess).
  const findings = (Array.isArray(out.data.findings) ? out.data.findings : []).map((f) => f && demote(f)).filter(Boolean);
  const blocking = findings.filter((f) => f && f.severity === "blocking");
  const verdict = blocking.length ? "fail" : "pass";
  let summary = String(out.data.summary || "").trim();
  if (blocking.length) summary += "\n\nBlocking:\n" + blocking.map((f) => `- ${f.where}: ${f.what}`).join("\n");
  const minor = findings.filter((f) => f && f.severity === "minor");
  if (minor.length) summary += `\n\nNoted, not blocking:\n` + minor.map((f) => `- ${f.where}: ${f.what}`).join("\n");
  return { data: { verdict, summary, findings, issues: blocking.map((f) => f.what), model_verdict: out.data.verdict }, costUsd: out.costUsd };
}

const CROSS_CHECK_DIFF_CHARS = Number(process.env.SOS_CROSS_CHECK_DIFF_CHARS || 90000);

// Never blocking, whatever the reviewer says: housekeeping the platform asks
// the builder for, and anything the reviewer only suspects. Kept as minor with
// the reason recorded, so the checks log shows what was demoted.
const NEVER_BLOCKING = [
  [/data-changed|tour\.json|reference\.md|principles? rule|rule 8|rule 9|plain[- ]words/i, "housekeeping is never blocking"],
  [/\b(if the underlying|if the real|might|may (?:be|still|not)|presumably|cannot (?:confirm|verify|tell|see)|can't (?:confirm|verify|tell|see)|unverifiable|not (?:shown|visible|included) in the diff|would need to (?:run|test)|worth confirming|assum(?:e|ption))\b/i, "a guess or something unverifiable from the diff is never blocking"],
  [/\b(cosmetic|wording|formatting|whitespace|style only|dead (?:code|logic)|misspell)/i, "cosmetic notes are never blocking"],
];
function demote(f) {
  if (f.severity !== "blocking") return f;
  const text = `${f.where || ""} ${f.what || ""}`;
  for (const [re, why] of NEVER_BLOCKING) if (re.test(text)) return { ...f, severity: "minor", demoted: why, was: "blocking" };
  return f;
}

// The reviewer's brief. Calibrated 2026-09-17 after almost every functionality
// change was being failed: the old brief said "fail anything beyond the
// requirement" and never told the reviewer what a functionality change
// legitimately has to touch, so routes.js edits, new migrations and tour.json
// housekeeping were read as violations. Now the standard is explicit and the
// verdict follows the findings' severity.
function crossCheckSystem(lane) {
  const { platformDocs } = require("./agent");
  // GUARDRAILS only. PRINCIPLES.md is the builder's craft (tours, data-changed
  // marks, plain words); handed to the reviewer it became a list of things to
  // fail builds for (run #31 failed on "rule 9").
  const rules = platformDocs().filter((d) => d.name === "GUARDRAILS.md").map((d) => `<!-- ${d.name} -->\n${d.content}`).join("\n\n");
  return `You are an independent reviewer of a change to a factory software module. You did not write it and you cannot run it; you judge from the diff. Your reader is a production manager, so write findings in plain words.

Mark a finding BLOCKING only when one of these is true:
1. The requirement is not met: something it asks for is missing, wrong, or on the wrong screen when it names a screen.
2. The change alters what people see or what happens on the floor beyond what the requirement asks, in a way a manager would notice. Say what they would notice.
3. A migration file that already existed was edited, or a migration uses DROP, DELETE, UPDATE, TRUNCATE, GRANT, or any schema, role, function or trigger statement.
4. Something that worked would plainly break: a route removed or renamed that a page still calls, a field renamed on one side only, invalid syntax, a page reading a column no migration creates.
5. A hard rule in the guardrails below is broken (writing outside the module, importing outside the directory, new dependencies, a hard-coded /m/<name> path).

Everything else is at most MINOR. In particular these are NOT violations and never block:
- Supporting edits the change needs to work: server logic in routes.js for a functionality change, helper functions, styles, a NEW additive migration file, additions to the module.json smoke list or pages map.
- Housekeeping the platform requires: tour.json steps kept true, reference.md updated, data-changed="vN" attributes on touched elements.
- Small tidy-ups inside lines the change had to touch anyway, and wording changes that keep the meaning.
- The requirement's "what stays the same" describes what the floor sees, not which files may be touched. Touching a file is fine if that behavior is unchanged.
- Anything you cannot verify from the diff. Do not fail for what you cannot see or cannot run.
${lane === "module" ? "\nThis is a brand-new module built from a confirmed design summary. The requirement is that design. Check that every screen, rule, number and connection the design names is there in some form, that visible text is in plain words (no API, database, schema, JSON, deploy, server, sync, token, prompt, backend, frontend), that every outside connection goes through the ctx services the contract allows and nothing reaches the network directly, and that a tour.json exists. A first version is meant to be small: leaving out what the design lists under \"What Rev 1 leaves out\" is correct, not a finding.\n" : ""}
A finding that contains "if", "might", "may", "presumably", "cannot confirm" or "would need to run" is a guess, and a guess is minor by definition. The builder's craft rules (tour steps, data-changed marks, plain words, reference doc) are not yours to enforce; note them as minor at most. A file that appears in full with every line marked + is a NEW file the change adds (a new migration, a new page); read it as such, it is not missing.

When in doubt between blocking and minor, choose minor. A blocking finding must quote the diff lines that show it. The verdict is pass when there is no blocking finding.

${rules}`;
}

// Hit the module's declared smoke endpoints on the staged (or live) mount.
// Runs as an internal request with a manager session so auth does not block it.
async function smokeCheck(company, mod, staged) {
  const row = await registry.getModule(company, mod);
  const version = staged ? row.staged_version : row.live_version;
  const manifest = registry.readManifest(company, mod, version);
  const base = `http://127.0.0.1:${process.env.PORT || 3000}/c/${company}${staged ? "/staging" : ""}/m/${mod}`;
  const targets = ["/", ...(manifest.smoke || [])];
  const checked = [];
  const headers = { "x-sos-internal": process.env.SOS_INTERNAL_TOKEN || "" };
  for (const t of targets) {
    const res = await fetch(base + t, { headers }).catch((e) => ({ status: 0, err: e.message }));
    checked.push({ url: t, status: res.status });
    if (!res.status || res.status >= 500) return { ok: false, detail: `${t} returned ${res.status || res.err}`, checked };
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
  const result = await registry.deployVersion(run.company, run.module, run.to_version);
  await setRun(runId, { status: "deployed" });
  await log(runId, { step: "deploy", note: result.from ? `v${result.from} -> v${result.to} live` : `v${result.to} live: the module is on the floor` });
  const ps = await loadProposals(run.proposal_ids || [run.proposal_id]);
  const ev = run.evidence || {};
  const summary = (ev.what_changed || ev.build_summary || "").slice(0, 600);
  for (const p of ps) {
    await q("UPDATE platform.feedback SET status='done', outcome=$2, batch_id=NULL, updated_at=now() WHERE id=$1",
      [p.feedback_id, `Deployed v${result.to}${ps.length > 1 ? ` (batch of ${ps.length})` : ""}: ${summary || p.body.slice(0, 500)}`]);
  }
  if (run.lane === "module") await require("./modulebuild").afterDeploy(await getRun(runId), result);
  kickQueue(run.company, run.module).catch((e) => console.error("queue kick failed:", e));
  return result;
}

async function rollbackRun(runId) {
  const run = await getRun(runId);
  const result = await registry.rollback(run.company, run.module);
  await setRun(runId, { status: "rolled_back" });
  await log(runId, { step: "rollback", note: `restored v${result.to}` });
  const ps = await loadProposals(run.proposal_ids || [run.proposal_id]);
  for (const p of ps) {
    await q("UPDATE platform.feedback SET outcome=$2, updated_at=now() WHERE id=$1", [p.feedback_id, `Rolled back to v${result.to}.`]);
  }
  return result;
}

// Retry a failed run from the build step (new draft, same proposals).
async function retry(runId) {
  const run = await getRun(runId);
  if (run.status !== "failed") throw new Error("only failed runs can be retried");
  const step = run.lane === "ui" || run.lane === "module" || run.requirement ? "build" : "confirm_requirement";
  const busy = await activeRun(run.company, run.module);
  const modRow = await registry.getModule(run.company, run.module);
  await setRun(runId, { step, status: busy ? "queued" : "running", from_version: modRow.live_version });
  await log(runId, { step, note: busy ? `manager retried; queued behind run #${busy.id}` : "manager retried the run" });
  if (!busy) advance(runId).catch((e) => failRun(runId, e));
}

const MAX_FIX_ROUNDS = Number(process.env.SOS_MAX_FIX_ROUNDS || 2);

// A failed check (cross-check, tests, visual check) can go back to the agent
// with the findings, in the same draft version.
async function fix(runId) {
  const run = await getRun(runId);
  if (run.status !== "failed" || !run.to_version || !["cross_check", "test_run", "visual_check"].includes(run.step)) throw new Error("only a build that failed a check can be sent back for fixes");
  const ev = run.evidence || {};
  const round = (ev.fix_round || 0) + 1;
  if (round > MAX_FIX_ROUNDS) throw new Error(`already tried ${MAX_FIX_ROUNDS} fix rounds; retry from scratch, adjust the proposals, or override`);
  const lastErr = (run.log || []).filter((l) => l.step === "error").slice(-1)[0];
  const findings = (ev.cross_check && ev.cross_check.verdict === "fail" && ev.cross_check.summary) || (lastErr ? lastErr.note : "the previous attempt failed its checks");
  const busy = await activeRun(run.company, run.module);
  await setRun(runId, { step: "build", status: busy ? "queued" : "running", evidence: { ...ev, fix_round: round, findings, cross_check: undefined, test_run: undefined, visual_check: undefined } });
  await log(runId, { step: "build", note: busy ? `fix round ${round} queued behind run #${busy.id}` : `manager sent the reviewer's findings back to the agent (fix round ${round} of ${MAX_FIX_ROUNDS})` });
  if (!busy) advance(runId).catch((e) => failRun(runId, e));
}

// Manager overrides a failed cross-check: the change still has to pass the
// internal tests, then waits at the deploy gate like any other build. The
// override is recorded on the run.
async function override(runId) {
  const run = await getRun(runId);
  if (run.status !== "failed" || run.step !== "cross_check" || !run.to_version) throw new Error("only a build that failed the cross-check can be overridden");
  const ev = run.evidence || {};
  // An override is a manager disagreeing with a reviewer's judgment. The
  // platform's own checks are not a judgment: the draft was never staged, and
  // its code has not been allowed into this process. Fix, retry or cancel.
  if (ev.cross_check && ev.cross_check.model === "platform checks") throw new Error("the platform's own checks cannot be overridden; send the findings back to the agent, retry, or cancel");
  await setRun(runId, { step: "test_run", status: "running", evidence: { ...ev, cross_check: { ...(ev.cross_check || {}), overridden: true } } });
  await log(runId, { step: "cross_check", note: "manager overrode the failed cross-check; findings stay on the record" });
  advance(runId).catch((e) => failRun(runId, e));
}

// Cancel a queued, failed, or gate-waiting run, or ABORT one that is running
// (the agent process is killed; whatever it wrote in the draft is dropped).
// Proposals go back to reviewing; the items leave whatever batch they were in.
async function cancel(runId) {
  const run = await getRun(runId);
  if (!["queued", "failed", "waiting", "running"].includes(run.status)) throw new Error("this run has already ended");
  const wasRunning = run.status === "running";
  await setRun(runId, { status: "cancelled" });
  if (wasRunning) {
    const ctl = ACTIVE.get(runId);
    if (ctl) ctl.abort();
    await log(runId, { step: run.step, note: `aborted by manager during ${run.step}${ctl ? "; agent process stopped" : ""}` });
  }
  const modRow = await registry.getModule(run.company, run.module);
  if (run.to_version && modRow && modRow.staged_version === run.to_version) await registry.unstage(run.company, run.module);
  // a draft that was never staged is a dead version; drop it so the Versions panel stays honest
  if (run.to_version && modRow && modRow.live_version !== run.to_version && modRow.staged_version !== run.to_version) {
    await registry.dropDraftVersion(run.company, run.module, run.to_version).catch((e) => console.error("drop draft failed:", e.message));
  }
  const ps = await loadProposals(run.proposal_ids || [run.proposal_id]);
  await q("UPDATE platform.proposals SET status='draft' WHERE id = ANY($1::int[])", [ps.map((p) => p.id)]);
  await q("UPDATE platform.feedback SET status='reviewing', batch_id=NULL, updated_at=now() WHERE id = ANY($1::int[])", [ps.map((p) => p.feedback_id)]);
  if (!wasRunning) await log(runId, { step: run.step, note: "cancelled by manager; proposals back to review" });
  if (run.lane === "module") await require("./modulebuild").afterCancel(run);
  kickQueue(run.company, run.module).catch((e) => console.error("queue kick failed:", e));
}

// Boot: a run that was "running" when the platform restarted has no process
// behind it any more. Mark it failed so the board offers retry or cancel
// instead of a spinner that never ends, then let the queue move.
async function sweepOrphans() {
  const rows = (await q("SELECT id, company, module, step FROM platform.build_runs WHERE status='running'")).rows;
  for (const r of rows) {
    await log(r.id, { step: "error", note: "the platform restarted while this build was running; nothing was deployed. Retry or cancel." });
    await setRun(r.id, { status: "failed" });
    console.log(`[pipeline] run #${r.id} (${r.company}/${r.module}) was running at restart; marked failed`);
  }
  const mods = (await q("SELECT DISTINCT company, module FROM platform.build_runs WHERE status='queued'")).rows;
  for (const m of mods) kickQueue(m.company, m.module).catch((e) => console.error("queue kick failed:", e));
  return rows.length;
}

module.exports = {
  startRun, confirmRequirement, deploy, rollbackRun, retry, cancel, fix, override, getRun, smokeCheck, kickQueue, sweepOrphans, MAX_FIX_ROUNDS,
  // shared with modulebuild.js (a brand-new module goes through the same runs table and the same gates)
  setRun, log, addCost, failRun, activeRun, runStructuredCrossCheck, plainSummary, ACTIVE, advance,
  // the cross-check brief, for the replay harness
  crossCheckCall, crossCheckPrompt, crossCheckSystem, CROSS_CHECK_SCHEMA, CROSS_CHECK_DIFF_CHARS, demote,
};
