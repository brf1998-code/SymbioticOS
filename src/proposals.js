// Proposal engine: feedback item -> AI proposal + UI/functionality classification
// + the file the change lands in (pinned to the screen the feedback came from).
const { q, logEvent } = require("./db");
const { runStructured, haveKey, assertUnderCap, modelFor, guidanceFor } = require("./agent");
const registry = require("./registry");
const { record } = require("./record");
const datacheck = require("./datacheck");
const { sourceText } = require("./modulesource");

// erpLookups: the module's ERP lookup names, when it has an ERP connection.
// Only then is the model asked what ERP data the change needs (src/datacheck.js).
function proposalSchema(files, erpLookups) {
  return {
    type: "object",
    properties: {
      ...(erpLookups && erpLookups.length ? { erp_data: datacheck.schemaFor(erpLookups) } : {}),
      proposal: { type: "string", description: "Plain-language description of the change: what will change, on which screen, and what it will look like. Written for a production manager, not a developer. 2 to 5 sentences." },
      class: { type: "string", enum: ["ui", "functionality"], description: "ui = layout, styling, copy, view arrangement, or displaying a field that the page already receives. functionality = any logic, data, calculation, workflow state, or integration change. When uncertain, choose functionality." },
      target_file: { type: "string", enum: files, description: "The one file the change lands in. Default to the file behind the screen the feedback came from; pick another only when the feedback clearly talks about a different screen." },
      rationale: { type: "string", description: "One or two sentences on why this class, this file, and this approach." },
    },
    required: ["proposal", "class", "target_file", "rationale", ...(erpLookups && erpLookups.length ? ["erp_data"] : [])],
  };
}

// The live module as a model reads it: every file WHOLE (src/modulesource.js). Until 2026-09-19 this cut
// pages at 14,000 characters and everything else at 8,000 in silence, so proposals and system reviews were
// written from under half of routes.js. `first` names the files this reader needs most (the screen the
// feedback came from); it only matters when a module is over the overall budget, and then `cut` says what
// was cut so the caller can put it on the record.
async function moduleContext(company, mod, { first = [] } = {}) {
  const row = await registry.getModule(company, mod);
  if (!row) return { text: "(unknown module)", files: [], screens: [], cut: [] };
  const files = (await registry.versionFiles(company, mod, row.live_version)) || {};
  const manifest = JSON.parse(files["module.json"] || "{}");
  const screens = registry.pageEntries(manifest);
  const src = sourceText(files, { first: first.filter(Boolean) });
  const screenList = screens.map((s) => `- ${s.label}: ${s.file} (route ${s.route})`).join("\n");
  return {
    text: `Module "${row.title}" (${mod}), live version ${row.live_version}.\nScreens in this module:\n${screenList}\n- server logic: routes.js\nSource:\n${src.text}`,
    files: Object.keys(files).filter((f) => f.startsWith("pages/") || f === "routes.js"),
    screens, cut: src.cut, chars: src.chars,
  };
}

async function generateProposal(feedbackId) {
  const fb = (await q("SELECT * FROM platform.feedback WHERE id=$1", [feedbackId])).rows[0];
  if (!fb) throw new Error("feedback not found");
  if (!fb.module || fb.module === "platform") throw new Error("platform feedback is handled outside the AI loop");
  if (fb.kind === "module_request") throw new Error("a module request is answered in its own popout, not reviewed as feedback");

  const ctx = await moduleContext(fb.company, fb.module, { first: [fb.target_file] });
  const screenLine = fb.screen ? `Screen: ${fb.screen} (${fb.target_file})` : `Screen: unknown (page ${fb.page || "?"})`;

  if (!haveKey()) {
    // graceful degradation so the loop is walkable without a key
    const r = await q(
      `INSERT INTO platform.proposals (feedback_id, body, class, target_file, rationale, status)
       VALUES ($1,$2,'functionality',$3,'AI is not configured on this instance; placeholder proposal.','draft') RETURNING *`,
      [feedbackId, `[AI not configured] Manual proposal needed for: "${fb.message}"`, fb.target_file || null]);
    await q("UPDATE platform.feedback SET status='reviewing', updated_at=now() WHERE id=$1", [feedbackId]);
    return r.rows[0];
  }
  await assertUnderCap(fb.company);

  const model = await modelFor(fb.company, "propose");
  const guidance = await guidanceFor(fb.company, fb.module);
  // the data check: a module with an ERP connection is asked what ERP data the change needs
  const erpLookups = Object.keys(await datacheck.erpState(fb.company, fb.module).catch(() => ({})));
  const erpAsk = erpLookups.length ? `\n\nThis module can read the company's ERP through these lookups: ${erpLookups.join(", ")}. ERP-FIELDS.md above lists every field each one can give. List under erp_data every piece of ERP data this change needs, naming the listed field that covers it; when no listed field covers it, leave its field empty and still write the proposal as it will work once the data is there. Do not tell the manager about lookups or fields.\nERP lookups available to this module: ${erpLookups.join(", ")}` : "";
  // a follow-up ("not quite" on something that shipped): the proposer is told what was built before and that this is what is still off
  const closeloop = require("./closeloop");
  const followUp = closeloop.followUpContext(await closeloop.originalOf(fb).catch(() => null));
  const { data, costUsd } = await runStructured({
    model,
    system: "You draft improvement proposals for a factory operations platform. The reader is a production manager with no software background. Be concrete and short. Never mention code internals in the proposal text. Prefer the smallest change that removes the reported friction. The feedback was filed from a specific screen; the change belongs on that screen unless the feedback clearly says otherwise.\n\n" + guidance.text,
    prompt: `Floor feedback (reported by ${fb.name || "anonymous"}, reported ${fb.recurrence} time(s))\n${screenLine}\n\n"${fb.message}"${followUp}\n\nCurrent module for context:\n${ctx.text}\n\nDraft the proposal, classify it, and name the target file.${erpAsk}`,
    schema: proposalSchema(ctx.files.length ? ctx.files : ["routes.js"], erpLookups),
    toolName: "proposal",
  });
  const r = await q(
    `INSERT INTO platform.proposals (feedback_id, body, class, target_file, rationale, model, cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [feedbackId, data.proposal, data.class, data.target_file || fb.target_file || null, data.rationale, model, costUsd || 0]);
  await q("UPDATE platform.feedback SET status='reviewing', updated_at=now() WHERE id=$1", [feedbackId]);
  await logEvent("proposal_generated", feedbackId, { class: data.class, target: data.target_file, model, costUsd });
  if (ctx.cut && ctx.cut.length) { console.error(`[context] ${fb.company}/${fb.module} is over the context budget; cut: ${ctx.cut.map((c) => `${c.name} ${c.shown}/${c.of}`).join(", ")}`); await logEvent("proposal_context_cut", feedbackId, { company: fb.company, module: fb.module, cut: ctx.cut }); }
  await record("proposal_drafted", { company: fb.company, module: fb.module, actor: "agent", feedback_id: feedbackId, proposal_id: r.rows[0].id, after: data.proposal, detail: { class: data.class, target: data.target_file || fb.target_file || null, rationale: data.rationale, model, cost_usd: costUsd || 0, context_chars: ctx.chars || null, ...(ctx.cut && ctx.cut.length ? { context_cut: ctx.cut } : {}) } });
  // can the ERP connection give what this change needs? the platform checks, not the model
  const check = erpLookups.length ? await datacheck.apply(r.rows[0], fb, data.erp_data).catch((e) => { console.error("[datacheck]", e.message); return null; }) : null;
  return { ...r.rows[0], data_check: check };
}

module.exports = { generateProposal, moduleContext };
