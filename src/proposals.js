// Proposal engine: feedback item -> AI proposal + UI/functionality classification
// + the file the change lands in (pinned to the screen the feedback came from).
const { q, logEvent } = require("./db");
const { runStructured, haveKey, assertUnderCap, modelFor, guidanceFor } = require("./agent");
const registry = require("./registry");

function proposalSchema(files) {
  return {
    type: "object",
    properties: {
      proposal: { type: "string", description: "Plain-language description of the change: what will change, on which screen, and what it will look like. Written for a production manager, not a developer. 2 to 5 sentences." },
      class: { type: "string", enum: ["ui", "functionality"], description: "ui = layout, styling, copy, view arrangement, or displaying a field that the page already receives. functionality = any logic, data, calculation, workflow state, or integration change. When uncertain, choose functionality." },
      target_file: { type: "string", enum: files, description: "The one file the change lands in. Default to the file behind the screen the feedback came from; pick another only when the feedback clearly talks about a different screen." },
      rationale: { type: "string", description: "One or two sentences on why this class, this file, and this approach." },
    },
    required: ["proposal", "class", "target_file", "rationale"],
  };
}

async function moduleContext(company, mod) {
  const row = await registry.getModule(company, mod);
  if (!row) return { text: "(unknown module)", files: [], screens: [] };
  const files = (await registry.versionFiles(company, mod, row.live_version)) || {};
  const manifest = JSON.parse(files["module.json"] || "{}");
  const screens = registry.pageEntries(manifest);
  let src = "";
  for (const [name, content] of Object.entries(files)) {
    src += `\n--- ${name} ---\n` + content.slice(0, name.startsWith("pages/") ? 14000 : 8000);
  }
  const screenList = screens.map((s) => `- ${s.label}: ${s.file} (route ${s.route})`).join("\n");
  return {
    text: `Module "${row.title}" (${mod}), live version ${row.live_version}.\nScreens in this module:\n${screenList}\n- server logic: routes.js\nSource:\n${src}`,
    files: Object.keys(files).filter((f) => f.startsWith("pages/") || f === "routes.js"),
    screens,
  };
}

async function generateProposal(feedbackId) {
  const fb = (await q("SELECT * FROM platform.feedback WHERE id=$1", [feedbackId])).rows[0];
  if (!fb) throw new Error("feedback not found");
  if (!fb.module || fb.module === "platform") throw new Error("platform feedback is handled outside the AI loop");
  if (fb.kind === "module_request") throw new Error("a module request is answered in its own popout, not reviewed as feedback");

  const ctx = await moduleContext(fb.company, fb.module);
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
  await assertUnderCap();

  const model = await modelFor(fb.company, "propose");
  const guidance = await guidanceFor(fb.company, fb.module);
  const { data, costUsd } = await runStructured({
    model,
    system: "You draft improvement proposals for a factory operations platform. The reader is a production manager with no software background. Be concrete and short. Never mention code internals in the proposal text. Prefer the smallest change that removes the reported friction. The feedback was filed from a specific screen; the change belongs on that screen unless the feedback clearly says otherwise.\n\n" + guidance.text,
    prompt: `Floor feedback (reported by ${fb.name || "anonymous"}, reported ${fb.recurrence} time(s))\n${screenLine}\n\n"${fb.message}"\n\nCurrent module for context:\n${ctx.text}\n\nDraft the proposal, classify it, and name the target file.`,
    schema: proposalSchema(ctx.files.length ? ctx.files : ["routes.js"]),
    toolName: "proposal",
  });
  const r = await q(
    `INSERT INTO platform.proposals (feedback_id, body, class, target_file, rationale, model, cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [feedbackId, data.proposal, data.class, data.target_file || fb.target_file || null, data.rationale, model, costUsd || 0]);
  await q("UPDATE platform.feedback SET status='reviewing', updated_at=now() WHERE id=$1", [feedbackId]);
  await logEvent("proposal_generated", feedbackId, { class: data.class, target: data.target_file, model, costUsd });
  return r.rows[0];
}

module.exports = { generateProposal, moduleContext };
