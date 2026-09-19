// Module creation intake (docs/MODULE-CREATION.md). A manager answers the
// fixed questions, Fable asks up to two more rounds of its own, then writes
// the design summary the manager confirms. Everything here is platform code;
// the in-app build agent never touches it. Confirm hands the design to
// src/modulebuild.js, which builds the first version through the same gates
// as any change.
//
// Statuses: answering (a round is open) -> thinking (Fable is working) ->
// answering (a new round) or design (summary ready) -> confirmed -> building
// -> done. Also abandoned, and failed (a model call died; the card offers
// Try again).
const express = require("express");
const { q, logEvent } = require("./db");
const agent = require("./agent");
const registry = require("./registry");
const attachments = require("./attachments");
const plain = require("./plainwords");
const Q = require("./intake-questions");
const { requireManager } = require("./auth");

const INTAKE_MODEL = agent.MODELS.some((m) => m.id === (process.env.SOS_MODEL_INTAKE || "claude-fable-5-1")) ? (process.env.SOS_MODEL_INTAKE || "claude-fable-5-1") : "claude-fable-5-1";
const REWRITE_MODEL = process.env.SOS_MODEL_SUMMARY || "claude-haiku-4-5-20251001";
const MAX_GENERATED_ROUNDS = 2;           // round 1 is fixed; hard cap three rounds in all
const MAX_QUESTIONS_PER_ROUND = 6;
const RESERVED = new Set(["platform", "admin", "staging", "new", "api", "assets", "login", "logout", "health"]);

// ---- helpers ------------------------------------------------------------------
async function getIntake(id) { return (await q("SELECT * FROM platform.module_intakes WHERE id=$1", [id])).rows[0]; }
async function setIntake(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return getIntake(id);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(", ");
  const vals = keys.map((k) => (["answers", "rounds", "design"].includes(k) && fields[k] != null ? JSON.stringify(fields[k]) : fields[k]));
  return (await q(`UPDATE platform.module_intakes SET ${sets}, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...vals])).rows[0];
}
async function setFeedback(intake, fields) {
  if (!intake.feedback_id) return;
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(", ");
  await q(`UPDATE platform.feedback SET ${sets}, updated_at=now() WHERE id=$1`, [intake.feedback_id, ...keys.map((k) => fields[k])]);
}
async function companyModules(company) {
  return (await q("SELECT name, title FROM platform.modules WHERE company=$1 AND live_version IS NOT NULL ORDER BY name", [company])).rows;
}
function slugify(name) {
  const s = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/g, "");
  return /^[a-z0-9]/.test(s) ? s : "";
}
// A name is taken when its slug or its title matches a module of the company
// (the library module "paperline" is titled "Paper Airplane Line": both
// count) or another live intake.
async function slugTaken(company, slug, exceptIntake, name) {
  if (RESERVED.has(slug)) return true;
  const title = String(name || "").trim().toLowerCase();
  if ((await q("SELECT 1 FROM platform.modules WHERE company=$1 AND (name=$2 OR lower(title)=$3)", [company, slug, title || slug])).rowCount) return true;
  if ((await q("SELECT 1 FROM platform.module_intakes WHERE company=$1 AND (slug=$2 OR lower(name)=$3) AND status <> 'abandoned' AND id <> $4", [company, slug, title || slug, exceptIntake || 0])).rowCount) return true;
  return false;
}

// All questions of an intake in order: the fixed ones for this company, then
// every generated round's, each tagged with its round number.
async function questionsFor(intake) {
  const mods = await companyModules(intake.company);
  const fixed = Q.fixedFor(mods).map((qn) => ({ ...qn, round: 1 }));
  const gen = [];
  for (const r of intake.rounds || []) for (const qn of r.questions || []) gen.push({ ...qn, round: r.round });
  return fixed.concat(gen);
}
// The round the person is answering now, and whether it is complete.
function roundState(questions, answers) {
  const rounds = [...new Set(questions.map((qn) => qn.round))].sort((a, b) => a - b);
  for (const r of rounds) {
    const qs = questions.filter((qn) => qn.round === r);
    const missing = qs.filter((qn) => qn.required && !Q.answered(qn, answers[qn.id]));
    const answered = qs.filter((qn) => Q.answered(qn, answers[qn.id])).length;
    if (missing.length || r === rounds[rounds.length - 1]) return { round: r, questions: qs, missing, answered, total: qs.length, done: !missing.length };
  }
  return { round: 1, questions: [], missing: [], answered: 0, total: 0, done: true };
}

// The public view of an intake (no file bytes), for the popout and the card.
async function view(intake) {
  const questions = await questionsFor(intake);
  const files = await attachments.list(intake.id);
  const state = roundState(questions, intake.answers || {});
  const roundsDone = (intake.rounds || []).length;
  const lastRound = (intake.rounds || [])[roundsDone - 1];
  return {
    id: intake.id, company: intake.company, feedback_id: intake.feedback_id, status: intake.status, name: intake.name, slug: intake.slug,
    answers: intake.answers || {}, questions, attachments: files, design: intake.design || null, model: intake.model || INTAKE_MODEL,
    cost_usd: Number(intake.cost_usd || 0), error: intake.error || null,
    round: state.round, round_answered: state.answered, round_total: state.total, round_done: state.done, missing: state.missing.map((m) => m.id),
    round_why: ((intake.rounds || []).find((r) => r.round === state.round) || {}).why || "",
    rounds_generated: roundsDone, enough: Boolean(lastRound && lastRound.enough), can_ask_more: roundsDone < MAX_GENERATED_ROUNDS && !(lastRound && lastRound.enough),
    created_at: intake.created_at, updated_at: intake.updated_at,
  };
}

// ---- lifecycle ------------------------------------------------------------------
async function create(company, role) {
  const fb = (await q(
    `INSERT INTO platform.feedback (company, module, page, screen, message, name, status, kind) VALUES ($1,NULL,$2,'Module request','New module',$3,'new','module_request') RETURNING id`,
    [company, `/c/${company}/`, role || "manager"])).rows[0];
  const it = (await q(
    `INSERT INTO platform.module_intakes (company, feedback_id, started_by, model) VALUES ($1,$2,$3,$4) RETURNING *`,
    [company, fb.id, role || "manager", INTAKE_MODEL])).rows[0];
  await q("UPDATE platform.feedback SET intake_id=$2 WHERE id=$1", [fb.id, it.id]);
  await logEvent("intake_started", it.id, { company, role });
  return it;
}

const { record } = require("./record");

async function answer(id, qid, value) {
  const it = await getIntake(id);
  if (!it) throw new Error("intake not found");
  if (!["answering", "failed"].includes(it.status)) throw new Error(`answers are closed while the intake is ${it.status}`);
  const questions = await questionsFor(it);
  const qn = questions.find((x) => x.id === qid);
  if (!qn) throw new Error("unknown question");
  const answers = { ...(it.answers || {}) };
  const fields = {};
  if (qid === "name") {
    const name = String(value || "").trim().slice(0, 80);
    const slug = slugify(name) || (name ? `module-${it.id}` : "");
    if (slug && (await slugTaken(it.company, slug, it.id, name))) throw new Error(`"${name}" is already the name of a module here. Pick another.`);
    fields.name = name || null; fields.slug = slug || null;
    answers.name = name;
    await setFeedback(it, { message: name ? `New module: ${name}` : "New module", module: slug || null });
  } else {
    answers[qid] = value;
  }
  fields.answers = answers;
  if (it.status === "failed") { fields.status = "answering"; fields.error = null; }
  const before = (it.answers || {})[qid];
  if (JSON.stringify(before) !== JSON.stringify(qid === "name" ? answers.name : value))
    await record("intake_answered", { company: it.company, module: it.slug || null, actor: "manager", intake_id: id, feedback_id: it.feedback_id, before: before == null ? null : (typeof before === "string" ? before : JSON.stringify(before)), after: typeof value === "string" ? value : JSON.stringify(value), detail: { question: qid, text: qn.text } });
  return setIntake(id, fields);
}

// The person finished the open round: check it, then let Fable think.
async function next(id) {
  const it = await getIntake(id);
  if (!it) throw new Error("intake not found");
  if (!["answering", "failed"].includes(it.status)) throw new Error(`nothing to send while the intake is ${it.status}`);
  const questions = await questionsFor(it);
  const state = roundState(questions, it.answers || {});
  if (!state.done) { const e = new Error("a few answers are still missing"); e.missing = state.missing.map((m) => ({ id: m.id, text: m.text })); throw e; }
  if (!it.name) throw new Error("the module needs a name first");
  await setIntake(id, { status: "thinking", error: null });
  await setFeedback(it, { status: "reviewing" });
  think(id).catch(async (e) => {
    console.error(`intake ${id} think failed:`, e);
    await setIntake(id, { status: "failed", error: String(e.message || e).slice(0, 500) });
  });
  return getIntake(id);
}

// Fable's turn: another round of questions, or the design summary.
async function think(id) {
  let it = await getIntake(id);
  const generated = (it.rounds || []).length;
  const last = (it.rounds || [])[generated - 1];
  const askMore = generated < MAX_GENERATED_ROUNDS && !(last && last.enough);
  if (askMore) {
    const round = await generateRound(it);
    it = await getIntake(id);
    const rounds = [...(it.rounds || []), round];
    if (!round.enough && round.questions.length) {
      await setIntake(id, { rounds, status: "answering", cost_usd: Number(it.cost_usd || 0) + round.cost_usd });
      await setFeedback(it, { status: "new" });
      await logEvent("intake_round", id, { round: round.round, questions: round.questions.length, model: round.model, costUsd: round.cost_usd });
      await record("intake_round", { company: it.company, module: it.slug || null, actor: "agent", intake_id: id, feedback_id: it.feedback_id, after: JSON.stringify(round.questions), detail: { round: round.round, why: round.why || null, model: round.model, cost_usd: round.cost_usd } });
      return;
    }
    it = await setIntake(id, { rounds, cost_usd: Number(it.cost_usd || 0) + round.cost_usd });
  }
  const design = await generateDesign(it, null);
  it = await getIntake(id);
  await setIntake(id, { design, status: "design", cost_usd: Number(it.cost_usd || 0) + design.cost_usd });
  await setFeedback(it, { status: "reviewing" });
  await logEvent("intake_design", id, { model: design.model, costUsd: design.cost_usd, estimate: design.estimate_usd, screens: (design.screens || []).length });
  await record("intake_design", { company: it.company, module: it.slug || null, actor: "agent", intake_id: id, feedback_id: it.feedback_id, after: design.reference_md, detail: { bluf: design.bluf, items: design.items, estimate_usd: design.estimate_usd, model: design.model, cost_usd: design.cost_usd } });
}

// The manager edited the summary text: Fable re-issues the design against it.
async function adjust(id, text) {
  const it = await getIntake(id);
  if (!it || it.status !== "design") throw new Error("there is no design to adjust right now");
  await setIntake(id, { status: "thinking", error: null });
  (async () => {
    try {
      const prev = it.design || {};
      const design = await generateDesign(it, String(text || "").slice(0, 20000));
      design.adjustments = [...(prev.adjustments || []), { at: new Date().toISOString(), text: String(text || "").slice(0, 20000) }];
      const cur = await getIntake(id);
      await setIntake(id, { design, status: "design", cost_usd: Number(cur.cost_usd || 0) + design.cost_usd });
      await record("intake_adjusted", { company: it.company, module: it.slug || null, actor: "manager", intake_id: id, feedback_id: it.feedback_id, before: prev.reference_md || null, after: design.reference_md, detail: { asked: String(text || "").slice(0, 20000), model: design.model, cost_usd: design.cost_usd } });
    } catch (e) {
      console.error(`intake ${id} adjust failed:`, e);
      await setIntake(id, { status: "design", error: String(e.message || e).slice(0, 500) });
    }
  })();
  return getIntake(id);
}

async function confirm(id) {
  const it = await getIntake(id);
  if (!it || it.status !== "design" || !it.design) throw new Error("there is no design to confirm");
  if (await slugTaken(it.company, it.slug, it.id, it.name)) throw new Error(`a module named "${it.name}" now exists; rename this one first`);
  let out = await setIntake(id, { status: "confirmed" });
  await setFeedback(it, { status: "reviewing" });
  await logEvent("intake_confirmed", id, { company: it.company, slug: it.slug, estimate: it.design.estimate_usd });
  await record("intake_confirmed", { company: it.company, module: it.slug || null, actor: "manager", intake_id: id, feedback_id: it.feedback_id, after: it.design.reference_md, detail: { estimate_usd: it.design.estimate_usd, adjustments: (it.design.adjustments || []).length } });
  // confirmed means building: the first version goes straight to the agent,
  // then the same gates as any change (Brendan, 2026-09-17)
  try {
    await require("./modulebuild").startBuild(out);
    out = await getIntake(id);
  } catch (e) {
    console.error(`intake ${id} build start failed:`, e);
    out = await setIntake(id, { error: `the build could not start: ${String(e.message || e).slice(0, 300)}` });
  }
  return out;
}

async function restart(id) {
  const it = await getIntake(id);
  if (!it || ["confirmed", "building", "done"].includes(it.status)) throw new Error("this intake can no longer be restarted");
  const answers = {};
  for (const [k, v] of Object.entries(it.answers || {})) if (!/^r\d+q\d+$/.test(k)) answers[k] = v;   // keep the fixed answers, drop the generated rounds'
  const out = await setIntake(id, { rounds: [], design: null, answers, status: "answering", error: null });
  await setFeedback(it, { status: "new" });
  await logEvent("intake_restarted", id, {});
  return out;
}

async function abandon(id) {
  const it = await getIntake(id);
  if (!it) throw new Error("intake not found");
  if (["building", "done"].includes(it.status)) throw new Error("this module is already being built");
  const out = await setIntake(id, { status: "abandoned" });
  await setFeedback(it, { status: "declined", outcome: "Module request withdrawn." });
  await logEvent("intake_abandoned", id, {});
  await record("intake_abandoned", { company: it.company, module: it.slug || null, actor: "manager", intake_id: id, feedback_id: it.feedback_id, detail: { status_before: it.status } });
  return out;
}

// ---- Fable ------------------------------------------------------------------------
const CONNECTION_KINDS = "files (a spreadsheet or photo they upload), scanners (barcode or QR scanners in keyboard mode: nothing to connect), printer (a label printer, printed from the device on the plant network), erp (their ERP or scheduling system, read only, a short list of named lookups), spreadsheet (one they keep), machine (a machine or PLC: later, through a plant-side helper), scale, other";

function answersText(questions, answers, files) {
  return questions.map((qn) => {
    const att = files.filter((a) => a.question_id === qn.id);
    return `Q (round ${qn.round}, ${qn.id}): ${qn.text}\nA: ${Q.describe(qn, answers[qn.id], att)}`;
  }).join("\n\n");
}
async function contextFor(it) {
  const questions = await questionsFor(it);
  const files = await attachments.list(it.id);
  const mods = await companyModules(it.company);
  const guidance = await agent.guidanceFor(it.company, it.slug || "new-module");
  const allow = Q.systemNames(it.answers || {});
  const blocks = agent.fakeMode() ? [] : await attachments.blocksFor(it.id);
  return {
    questions, files, mods, allow, blocks,
    system: `You are Fable, the assistant inside a factory operating system, helping a production manager design a new module (a small tracker with a few screens) by asking the right questions and then writing its design. The manager knows the operation and nothing about how software is made. Everything you write is read by that manager.\n\n${plain.rules()}\n\n${guidance.text}`,
    answersText: answersText(questions, it.answers || {}, files),
    modulesText: mods.length ? `Modules this company already has: ${mods.map((m) => `${m.title} (${m.name})`).join(", ")}.` : "This company has no other modules yet.",
  };
}
async function rewriteWith(costBox) {
  return async (text, instructions) => {
    const r = await agent.runChat({ model: REWRITE_MODEL, system: instructions, messages: [{ role: "user", content: text }], maxTokens: 6000 });
    costBox.usd += r.costUsd || 0;
    return r.text;
  };
}

const ROUND_SCHEMA = {
  type: "object",
  properties: {
    enough: { type: "boolean", description: "true when the answers so far are enough to write a small first version; then ask nothing." },
    why: { type: "string", description: "One plain sentence for the manager: why you have enough, or what these questions settle." },
    questions: {
      type: "array", maxItems: MAX_QUESTIONS_PER_ROUND,
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "The question, one sentence, plain words, in the company's own names for its systems." },
          hint: { type: "string", description: "One line on why it matters for the design." },
          kind: { type: "string", enum: ["choice", "text", "order", "attach"], description: "choice = suggested answers to pick from (always allow something else); text = free text; order = an ordered list; attach = ask for a file such as a photo of the label or an export." },
          options: { type: "array", items: { type: "string" }, description: "2 to 5 suggested answers for kind choice; empty otherwise." },
          multi: { type: "boolean", description: "choice only: several answers may apply." },
        },
        required: ["text", "hint", "kind", "options", "multi"],
      },
    },
  },
  required: ["enough", "why", "questions"],
};
async function generateRound(it) {
  const roundNo = (it.rounds || []).length + 2;
  const cost = { usd: 0 };
  if (agent.fakeMode()) return fakeRound(roundNo, it);
  await agent.assertUnderCap(it.company);
  const ctx = await contextFor(it);
  const model = it.model || INTAKE_MODEL;
  const { data, costUsd } = await agent.runStructured({
    model, blocks: ctx.blocks, schema: ROUND_SCHEMA, toolName: "intake_round", maxTokens: 4000,
    system: ctx.system,
    prompt: `This is round ${roundNo} of at most 3. Below are the manager's answers so far, and any files they attached are above.\n\n${ctx.answersText}\n\n${ctx.modulesText}\n\nWhat the tool can connect to: ${CONNECTION_KINDS}.\n\nAsk only what still changes the design of a deliberately small first version: who may move the thing from one stage to the next; what happens at capacity or when two people want the same thing; whether things already carry a number or a name and what a scan of one contains; what the one-glance screen shows first; time (due dates, shift boundaries, how long a thing may sit); what "done" means and whether done things stay in view; and for every outside system they ticked, the follow-ups that shape the connection (for a label printer: what is on the label, its size, how many a day, which printer; for an ERP: which few things this needs from it, how fresh, who can get a login; for a spreadsheet: which columns matter, who keeps it; for a scanner: what gets scanned; for a machine: what it reports). Never ask something already answered. Never ask about how the tool is built. At most ${MAX_QUESTIONS_PER_ROUND} questions; fewer is better. If you already have enough for a small first version, say so and ask nothing.`,
  });
  cost.usd += costUsd || 0;
  const rewrite = await rewriteWith(cost);
  const questions = [];
  let n = 0;
  for (const raw of (data.questions || []).slice(0, MAX_QUESTIONS_PER_ROUND)) {
    const text = await plain.scrub(String(raw.text || ""), { allow: ctx.allow, rewrite });
    const hint = await plain.scrub(String(raw.hint || ""), { allow: ctx.allow, rewrite });
    if (text.hits.length || hint.hits.length) continue;   // a question that cannot be said plainly is dropped
    const opts = [];
    for (const o of (raw.options || []).slice(0, 5)) { const s = await plain.scrub(String(o), { allow: ctx.allow, rewrite }); if (!s.hits.length && s.text.trim()) opts.push(s.text.trim()); }
    const kind = ["choice", "text", "order", "attach"].includes(raw.kind) ? raw.kind : "text";
    n++;
    questions.push({
      id: `r${roundNo}q${n}`, round: roundNo, kind: kind === "choice" && opts.length < 2 ? "text" : kind, required: kind !== "attach",
      text: text.text.trim(), hint: hint.text.trim(), multi: Boolean(raw.multi), other: true, attach: kind === "attach",
      options: kind === "choice" ? opts.map((o, i) => ({ id: `o${i + 1}`, label: o })) : [],
      multiline: true, max: 6000, min: 1, maxItems: 10,
    });
  }
  const why = await plain.scrub(String(data.why || ""), { allow: ctx.allow, rewrite });
  await agent.recordUsage(it.company, it.slug, "intake", model, cost.usd, { intake: it.id, round: roundNo, questions: questions.length, enough: Boolean(data.enough) });
  return { round: roundNo, questions, enough: Boolean(data.enough) || !questions.length, why: why.hits.length ? "" : why.text.trim(), model, cost_usd: cost.usd, at: new Date().toISOString() };
}

const DESIGN_SCHEMA = {
  type: "object",
  properties: {
    bluf: { type: "string", description: "One sentence: what this module is and who it is for." },
    items: { type: "array", minItems: 3, maxItems: 8, items: { type: "object", properties: { summary: { type: "string", description: "One sentence the manager ticks to confirm: a screen, a rule, a number, a connection, or what is left out." } }, required: ["summary"] }, description: "The points the manager must read and confirm, one sentence each." },
    reference_md: { type: "string", description: "The module reference in markdown with exactly these headings, in this order: Purpose; Who uses it and where; The thing and its stages; Screens; Rules; Numbers on the board; Connections; Starting data; What Rev 1 leaves out; Change guidance. Plain words throughout. Screens: one per role, each with its single prominent action. Change guidance: which kinds of later change are look-and-feel and which change how it works." },
    screens: { type: "array", items: { type: "object", properties: { role: { type: "string" }, title: { type: "string" }, device: { type: "string" }, prominent_action: { type: "string" } }, required: ["role", "title", "device", "prominent_action"] } },
    connections: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["files", "scanners", "printer", "erp", "spreadsheet", "machine", "scale", "other", "peer"] }, name: { type: "string", description: "What the company calls it." }, what_for: { type: "string" }, tool_does: { type: "string", description: "What the tool connects on its own." }, person_does: { type: "string", description: "What a person has to do, or 'nothing'." } }, required: ["kind", "name", "what_for", "tool_does", "person_does"] } },
    starting_data: { type: "string", description: "What gets loaded from the attachments at first deploy, or 'none'." },
    leaves_out: { type: "array", items: { type: "string" }, description: "What Rev 1 deliberately leaves for later feedback." },
    change_guidance: { type: "string" },
  },
  required: ["bluf", "items", "reference_md", "screens", "connections", "starting_data", "leaves_out", "change_guidance"],
};
function estimateUsd(d) {
  const screens = (d.screens || []).length, conns = (d.connections || []).filter((c) => c.kind !== "files").length;
  const usd = 4 + 2 * screens + 1.5 * conns + (d.starting_data && !/^none/i.test(d.starting_data) ? 1 : 0);
  return Math.round(usd * 2) / 2;
}
async function generateDesign(it, adjustedText) {
  const cost = { usd: 0 };
  if (agent.fakeMode()) return fakeDesign(it, adjustedText);
  await agent.assertUnderCap(it.company);
  const ctx = await contextFor(it);
  const model = it.model || INTAKE_MODEL;
  const { data, costUsd } = await agent.runStructured({
    model, blocks: ctx.blocks, schema: DESIGN_SCHEMA, toolName: "module_design", maxTokens: 12000,
    system: ctx.system,
    prompt: `Write the design summary for this new module, deliberately small: the thing and its stages, one screen per role with its single prominent action, the few rules that must hold, the numbers on the board, the connections it needs, the starting data, and what the first version leaves for later. It will be built as plain screens on top of a list of the thing; nothing here should describe how it is built. The module is called "${it.name}".\n\nThe manager's answers, and any files they attached are above:\n\n${ctx.answersText}\n\n${ctx.modulesText}\n\nWhat the tool can connect to: ${CONNECTION_KINDS}.${adjustedText ? `\n\nThe manager edited an earlier version of the reference text. Their edit is the authority; keep every change they made and re-issue the whole design to match it:\n\n${adjustedText}` : ""}`,
  });
  cost.usd += costUsd || 0;
  const rewrite = await rewriteWith(cost);
  const bluf = await plain.scrub(String(data.bluf || ""), { allow: ctx.allow, rewrite });
  const items = [];
  for (const i of (data.items || []).slice(0, 8)) { const s = await plain.scrub(String(i.summary || ""), { allow: ctx.allow, rewrite }); if (s.text.trim()) items.push({ summary: s.text.trim(), flagged: s.hits }); }
  const ref = await plain.scrub(String(data.reference_md || ""), { allow: ctx.allow, rewrite });
  const flags = [];
  if (bluf.hits.length) flags.push({ where: "the one-line summary", words: bluf.hits });
  for (const [i, s] of items.entries()) if (s.flagged && s.flagged.length) flags.push({ where: `point ${i + 1}`, words: s.flagged });
  if (ref.hits.length) flags.push({ where: "the full reference", words: ref.hits });
  const design = {
    name: it.name, slug: it.slug, bluf: bluf.text.trim(), items: items.map((s) => ({ summary: s.summary })), reference_md: ref.text.trim(),
    screens: data.screens || [], connections: data.connections || [], starting_data: data.starting_data || "none", leaves_out: data.leaves_out || [], change_guidance: data.change_guidance || "",
    flags, model, cost_usd: cost.usd, at: new Date().toISOString(),
  };
  design.estimate_usd = estimateUsd(design);
  await agent.recordUsage(it.company, it.slug, "design", model, cost.usd, { intake: it.id, screens: design.screens.length, connections: design.connections.length, adjusted: Boolean(adjustedText) });
  return design;
}

// ---- fake mode ------------------------------------------------------------------------
function fakeRound(roundNo, it) {
  if (roundNo > 2) return { round: roundNo, questions: [], enough: true, why: "Fake mode: enough after one extra round.", model: "fake", cost_usd: 0, at: new Date().toISOString() };
  const thing = (it.answers && it.answers.thing) || "the thing";
  return {
    round: roundNo, enough: false, why: `Fake mode: three questions that would shape the design of ${thing}.`, model: "fake", cost_usd: 0, at: new Date().toISOString(),
    questions: [
      { id: `r${roundNo}q1`, round: roundNo, kind: "choice", required: true, multi: false, other: true, attach: false, text: `Who is allowed to move ${thing} from one stage to the next?`, hint: "This decides which screen carries the move button.", options: [{ id: "o1", label: "Anyone who can see it" }, { id: "o2", label: "Only leads and managers" }, { id: "o3", label: "Only the person it is assigned to" }], multiline: true, max: 1500, min: 1, maxItems: 10 },
      { id: `r${roundNo}q2`, round: roundNo, kind: "choice", required: true, multi: true, other: true, attach: false, text: `What should the first screen show at a glance?`, hint: "The one thing people look at before anything else.", options: [{ id: "o1", label: "Everything that is late" }, { id: "o2", label: "What is at each stage" }, { id: "o3", label: "What is assigned to me" }, { id: "o4", label: "Today's count" }], multiline: true, max: 1500, min: 1, maxItems: 10 },
      { id: `r${roundNo}q3`, round: roundNo, kind: "text", required: true, multi: false, other: true, attach: false, text: `What does "done" mean for ${thing}, and does a done one stay in view?`, hint: "Some things are gone the moment they are done; some need to be seen for a day.", options: [], multiline: true, max: 1500, min: 1, maxItems: 10 },
    ],
  };
}
function fakeDesign(it, adjustedText) {
  const a = it.answers || {};
  const thing = a.thing || "the thing";
  const stages = Array.isArray(a.stages) && a.stages.length ? a.stages : ["new", "in work", "done"];
  const roles = Object.keys(a.who || {});
  const screens = (roles.length ? roles : ["floor"]).map((r) => ({ role: r, title: `${it.name}: ${r} view`, device: ((a.devices || {})[r] || ["phone"])[0], prominent_action: r === "floor" ? `Move ${thing} to the next stage` : "See what is late" }));
  const picks = ((a.works_with || {}).picks || []).filter((p) => p !== "nothing");
  const connections = picks.map((p) => ({ kind: ["scanners", "printer", "erp", "spreadsheet", "machine", "scale"].includes(p) ? p : "other", name: ((a.works_with || {}).names || {})[p] || p, what_for: `Fake mode: ${p} as ticked at intake`, tool_does: "connects what it can", person_does: p === "scanners" ? "nothing" : "a short setup step" }));
  const reference_md = adjustedText || `# Module reference: ${it.name}\n\n**Purpose.** ${a.purpose || "Fake mode purpose."}\n\n**Who uses it and where.** ${roles.join(", ") || "floor"}.\n\n**The thing and its stages.** ${thing}: ${stages.join(" > ")}.\n\n**Screens.** ${screens.map((s) => `${s.title} (${s.device}): ${s.prominent_action}`).join("; ")}.\n\n**Rules.** ${a.never || "none given"}.\n\n**Numbers on the board.** ${Q.describe(Q.FIXED.find((x) => x.id === "numbers"), a.numbers)}.\n\n**Connections.** ${connections.map((c) => c.name).join(", ") || "none"}.\n\n**Starting data.** none.\n\n**What Rev 1 leaves out.** Reports, history beyond a week, anything not in the stages above.\n\n**Change guidance.** Colors, wording and layout are look-and-feel changes; new stages, rules or connections change how it works.\n\n(SOS_FAKE_AGENT=1)`;
  const design = {
    name: it.name, slug: it.slug, bluf: `${it.name} tracks ${thing} through ${stages.length} stages for ${roles.join(", ") || "the floor"}. (fake mode)`,
    items: [
      { summary: `${thing} moves through: ${stages.join(", ")}.` },
      { summary: `One screen per role: ${screens.map((s) => s.role).join(", ")}.` },
      { summary: `Rule: ${String(a.never || "none").slice(0, 120)}` },
      { summary: `Connections: ${connections.map((c) => c.name).join(", ") || "none"}.` },
      { summary: "Rev 1 leaves out reports and long history; those come through feedback." },
    ],
    reference_md, screens, connections, starting_data: "none", leaves_out: ["reports", "long history"], change_guidance: "Look-and-feel versus how it works.",
    flags: [], model: "fake", cost_usd: 0, at: new Date().toISOString(), adjustments: [],
  };
  design.estimate_usd = estimateUsd(design);
  return design;
}

// ---- board summary --------------------------------------------------------------------
async function boardIntakes(company) {
  const rows = (await q("SELECT * FROM platform.module_intakes WHERE company=$1 AND status <> 'abandoned' ORDER BY id DESC", [company])).rows;
  const out = {};
  for (const it of rows) {
    const questions = await questionsFor(it);
    const st = roundState(questions, it.answers || {});
    const last = (it.rounds || [])[(it.rounds || []).length - 1];
    out[it.id] = {
      id: it.id, feedback_id: it.feedback_id, status: it.status, name: it.name, slug: it.slug, cost_usd: Number(it.cost_usd || 0), error: it.error,
      round: st.round, round_answered: st.answered, round_total: st.total, round_done: st.done, rounds_generated: (it.rounds || []).length,
      why: last ? last.why : "", bluf: it.design ? it.design.bluf : null, estimate_usd: it.design ? it.design.estimate_usd : null, flags: it.design ? (it.design.flags || []).length : 0,
      run_id: (it.run_ids || []).slice(-1)[0] || null,
      updated_at: it.updated_at,
    };
  }
  return out;
}

// ---- routes ----------------------------------------------------------------------------
const router = express.Router();
const json = express.json({ limit: "1mb" });
const bigJson = express.json({ limit: `${Math.ceil(attachments.MAX_BYTES * 1.4 / 1048576) + 1}mb` });
const fail = (res, e, code = 400) => res.status(e.missing ? 409 : code).json({ error: e.message, missing: e.missing });

router.post("/api/c/:slug/intakes", requireManager, json, async (req, res) => {
  try {
    const co = (await q("SELECT slug FROM platform.companies WHERE slug=$1", [req.params.slug])).rows[0];
    if (!co) return res.status(404).json({ error: "unknown company" });
    const it = await create(co.slug, req.sosRole);
    res.json(await view(it));
  } catch (e) { fail(res, e, 500); }
});
router.get("/api/intakes/:id", requireManager, async (req, res) => {
  const it = await getIntake(Number(req.params.id));
  if (!it) return res.status(404).json({ error: "not found" });
  res.json(await view(it));
});
router.post("/api/intakes/:id/answer", requireManager, json, async (req, res) => {
  try { res.json(await view(await answer(Number(req.params.id), String((req.body || {}).id || ""), (req.body || {}).value))); }
  catch (e) { fail(res, e); }
});
router.post("/api/intakes/:id/next", requireManager, json, async (req, res) => {
  try { res.json(await view(await next(Number(req.params.id)))); }
  catch (e) { fail(res, e); }
});
router.post("/api/intakes/:id/adjust", requireManager, json, async (req, res) => {
  try { res.json(await view(await adjust(Number(req.params.id), (req.body || {}).text))); }
  catch (e) { fail(res, e); }
});
router.post("/api/intakes/:id/confirm", requireManager, json, async (req, res) => {
  try { res.json(await view(await confirm(Number(req.params.id)))); }
  catch (e) { fail(res, e); }
});
// A confirmed design whose build never started (an older confirm, or a build
// that was discarded at the gate): start it now.
router.post("/api/intakes/:id/build", requireManager, json, async (req, res) => {
  try {
    const it = await getIntake(Number(req.params.id));
    if (!it) return res.status(404).json({ error: "not found" });
    if (it.status !== "confirmed" || !it.design) return res.status(400).json({ error: `nothing to build while the intake is ${it.status}` });
    if (await slugTaken(it.company, it.slug, it.id, it.name)) return res.status(409).json({ error: `a module named "${it.name}" now exists; rename this one first` });
    await require("./modulebuild").startBuild(it);
    res.json(await view(await getIntake(it.id)));
  } catch (e) { fail(res, e); }
});
router.post("/api/intakes/:id/restart", requireManager, json, async (req, res) => {
  try { res.json(await view(await restart(Number(req.params.id)))); }
  catch (e) { fail(res, e); }
});
router.post("/api/intakes/:id/abandon", requireManager, json, async (req, res) => {
  try { res.json(await view(await abandon(Number(req.params.id)))); }
  catch (e) { fail(res, e); }
});
router.post("/api/intakes/:id/attach", requireManager, bigJson, async (req, res) => {
  try {
    const it = await getIntake(Number(req.params.id));
    if (!it) return res.status(404).json({ error: "not found" });
    if (!["answering", "failed"].includes(it.status)) return res.status(400).json({ error: `files cannot be added while the intake is ${it.status}` });
    const b = req.body || {};
    const a = await attachments.add({ company: it.company, intakeId: it.id, questionId: String(b.question_id || ""), filename: b.filename, mime: b.mime, data: b.data });
    await logEvent("intake_attachment", it.id, { question: b.question_id, filename: a.filename, size: a.size, kind: a.kind });
    res.json({ ok: true, attachment: a, view: await view(await getIntake(it.id)) });
  } catch (e) { fail(res, e); }
});
router.delete("/api/intakes/:id/attach/:aid", requireManager, async (req, res) => {
  try { await attachments.remove(Number(req.params.aid), Number(req.params.id)); const it = await getIntake(Number(req.params.id)); res.json(await view(it)); }
  catch (e) { fail(res, e); }
});
router.get("/api/attachments/:id", requireManager, async (req, res) => {
  const a = await attachments.get(Number(req.params.id));
  if (!a) return res.status(404).end();
  res.set("Content-Type", a.mime).set("Content-Disposition", `inline; filename="${encodeURIComponent(a.filename)}"`).set("Cache-Control", "private, max-age=3600").send(a.bytes);
});

module.exports = { router, create, answer, next, think, adjust, confirm, restart, abandon, view, getIntake, boardIntakes, questionsFor, roundState, INTAKE_MODEL, estimateUsd };
