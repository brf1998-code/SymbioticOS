// Proposal engine: feedback item -> AI proposal + UI/functionality classification.
const { q, logEvent } = require("./db");
const { runStructured, haveKey, assertUnderCap } = require("./agent");
const registry = require("./registry");

const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    proposal: { type: "string", description: "Plain-language description of the change: what will change, where, and what it will look like. Written for a production manager, not a developer. 2 to 5 sentences." },
    class: { type: "string", enum: ["ui", "functionality"], description: "ui = layout, styling, copy, view arrangement, or displaying a field that the page already receives. functionality = any logic, data, calculation, workflow state, or integration change. When uncertain, choose functionality." },
    rationale: { type: "string", description: "One or two sentences on why this class and this approach." },
  },
  required: ["proposal", "class", "rationale"],
};

async function moduleContext(mod) {
  if (!mod) return "(no module specified)";
  const row = (await q("SELECT * FROM platform.modules WHERE name=$1", [mod])).rows[0];
  if (!row) return "(unknown module)";
  const files = (await registry.versionFiles(mod, row.live_version)) || {};
  let src = "";
  for (const [name, content] of Object.entries(files)) {
    src += `\n--- ${name} ---\n` + content.slice(0, name.startsWith("pages/") ? 14000 : 8000);
  }
  return `Module "${row.title}" (${mod}), live version ${row.live_version}.\nSource:\n${src}`;
}

async function generateProposal(feedbackId) {
  const fb = (await q("SELECT * FROM platform.feedback WHERE id=$1", [feedbackId])).rows[0];
  if (!fb) throw new Error("feedback not found");
  if (!fb.module || fb.module === "platform") throw new Error("platform feedback is handled outside the AI loop");

  if (!haveKey()) {
    // graceful degradation so the loop is walkable without a key
    const r = await q(
      `INSERT INTO platform.proposals (feedback_id, body, class, rationale, status)
       VALUES ($1,$2,'functionality','AI is not configured on this instance; placeholder proposal.','draft') RETURNING *`,
      [feedbackId, `[AI not configured] Manual proposal needed for: "${fb.message}"`]);
    await q("UPDATE platform.feedback SET status='reviewing', updated_at=now() WHERE id=$1", [feedbackId]);
    return r.rows[0];
  }
  await assertUnderCap();

  const ctx = await moduleContext(fb.module);
  const { data, costUsd } = await runStructured({
    system: "You draft improvement proposals for a factory operations platform. The reader is a production manager with no software background. Be concrete and short. Never mention code internals in the proposal text. Prefer the smallest change that removes the reported friction.",
    prompt: `Floor feedback (from page "${fb.page}" of module "${fb.module}", reported by ${fb.name || "anonymous"}, reported ${fb.recurrence} time(s)):\n\n"${fb.message}"\n\nCurrent module for context:\n${ctx}\n\nDraft the proposal and classify it.`,
    schema: PROPOSAL_SCHEMA,
    toolName: "proposal",
  });
  const r = await q(
    `INSERT INTO platform.proposals (feedback_id, body, class, rationale, cost_usd) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [feedbackId, data.proposal, data.class, data.rationale, costUsd || 0]);
  await q("UPDATE platform.feedback SET status='reviewing', updated_at=now() WHERE id=$1", [feedbackId]);
  await logEvent("proposal_generated", feedbackId, { class: data.class, costUsd });
  return r.rows[0];
}

module.exports = { generateProposal, moduleContext };
