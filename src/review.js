// System review: a frontier model re-baselines a whole module and produces a
// set of recommendations. Each one lands on the board as a held feedback item
// with a ready proposal (class, target screen, text), tagged with the review.
// The manager declines or adjusts individual items, then builds the approved
// set as one batch run (the normal batch machinery), with whichever model.
//
// What the reviewer sees: the guidance docs, every file of the live module
// version, the manifest's screens, the feedback history (what was asked,
// what shipped, what was declined), the build history, and a snapshot of the
// module's live data from its smoke endpoints. Different prompt from the
// per-item proposer: it is asked to look at the whole, not one complaint.
const { q, logEvent } = require("./db");
const { runStructured, haveKey, fakeMode, assertUnderCap, guidanceFor, modelInfo, MODELS } = require("./agent");
const registry = require("./registry");
const { moduleContext } = require("./proposals");

function reviewSchema(files) {
  return {
    type: "object",
    properties: {
      summary: { type: "string", description: "Three to six sentences for the production manager: the state of this module as a whole, what is working, where the friction concentrates, and what the recommendations below add up to." },
      findings: {
        type: "array",
        minItems: 3,
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "One line, plain language, what the floor will notice. This becomes the card title." },
            proposal: { type: "string", description: "The change, written so a build agent can implement it from this text alone: what changes, on which screen, what it looks like, what stays the same. 2 to 6 sentences. No code talk." },
            why: { type: "string", description: "One or two sentences: the evidence (feedback pattern, data, principle violated)." },
            class: { type: "string", enum: ["ui", "functionality"] },
            target_file: { type: "string", enum: files },
            priority: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["title", "proposal", "why", "class", "target_file", "priority"],
        },
      },
    },
    required: ["summary", "findings"],
  };
}

async function historyText(company, mod) {
  const fb = (await q(
    `SELECT f.id, f.screen, f.status, f.message, f.name, f.recurrence, f.outcome, f.created_at, p.class, p.target_file
       FROM platform.feedback f
       LEFT JOIN LATERAL (SELECT * FROM platform.proposals WHERE feedback_id=f.id ORDER BY id DESC LIMIT 1) p ON true
      WHERE f.company=$1 AND f.module=$2 ORDER BY f.id DESC LIMIT 60`, [company, mod])).rows;
  const runs = (await q(
    `SELECT id, lane, status, model, from_version, to_version, cost_usd, created_at, evidence->>'build_summary' AS summary
       FROM platform.build_runs WHERE company=$1 AND module=$2 ORDER BY id DESC LIMIT 25`, [company, mod])).rows;
  const fbText = fb.length ? fb.map((f) =>
    `- #${f.id} [${f.status}${f.recurrence > 1 ? `, seen x${f.recurrence}` : ""}] from "${f.screen || "?"}" by ${f.name || "anonymous"}: "${f.message}"${f.outcome ? ` -> ${f.outcome.slice(0, 160)}` : ""}`
  ).join("\n") : "(no feedback yet)";
  const runText = runs.length ? runs.map((r) =>
    `- run #${r.id} ${r.lane} ${r.status} v${r.from_version}->v${r.to_version || "?"} (${r.model || "?"}, $${Number(r.cost_usd).toFixed(2)})${r.summary ? `: ${r.summary.slice(0, 200).replace(/\n/g, " ")}` : ""}`
  ).join("\n") : "(no builds yet)";
  return `Feedback history (newest first):\n${fbText}\n\nBuild history (newest first):\n${runText}`;
}

// Snapshot of live data through the module's own read endpoints.
async function dataSnapshot(company, mod) {
  const row = await registry.getModule(company, mod);
  const manifest = registry.readManifest(company, mod, row.live_version);
  const base = `http://127.0.0.1:${process.env.PORT || 3000}/c/${company}/m/${mod}`;
  const headers = { "x-sos-internal": process.env.SOS_INTERNAL_TOKEN || "" };
  let out = "";
  for (const t of (manifest.smoke || []).filter((s) => s.startsWith("/api/"))) {
    try {
      const res = await fetch(base + t, { headers });
      const text = await res.text();
      out += `\n--- GET ${t} (${res.status}) ---\n${text.slice(0, 6000)}\n`;
    } catch (e) { out += `\n--- GET ${t} failed: ${e.message}\n`; }
  }
  return out || "(no data endpoints declared)";
}

function fakeFindings(files) {
  const page = files.find((f) => f.includes("station")) || files[0];
  return {
    summary: "Fake-mode review (SOS_FAKE_AGENT=1): three canned recommendations so the review flow can be exercised without an API key.",
    findings: [
      { title: "Show the fold type as a word, not a letter", proposal: "On the station page, replace the single-letter fold code with the full word (Dart or Glider) next to the color.", why: "Reported twice; a code needs a legend, a word does not.", class: "ui", target_file: page, priority: "high" },
      { title: "Show the clip position on the last station", proposal: "On the station page, when the station is the last one, show the traveler's clip position (none, nose, middle) in the spec line.", why: "The last station cannot see where the clip goes; that information is only on the line board.", class: "ui", target_file: page, priority: "high" },
      { title: "Let a station request a quantity", proposal: "Add a quantity field to the material request form on the station page and carry it through to the stockroom request so one request can cover several sheets.", why: "Requests are one unit at a time, which floods the stockroom.", class: "functionality", target_file: files.includes("routes.js") ? "routes.js" : page, priority: "medium" },
    ],
  };
}

// Rough cost estimate before the manager commits to a review.
async function estimate(company, mod, model) {
  const ctx = await moduleContext(company, mod);
  const guidance = await guidanceFor(company, mod);
  const chars = ctx.text.length + guidance.text.length + 12000;
  const tokensIn = Math.round(chars / 3.6) + 3000;
  const m = modelInfo(model);
  return { tokensIn, usd: (tokensIn * m.in + 6000 * m.out) / 1e6 };
}

async function startReview(company, mod, model, requestedBy) {
  if (!MODELS.some((m) => m.id === model)) throw new Error("unknown model");
  const row = await registry.getModule(company, mod);
  if (!row) throw new Error(`unknown module ${company}/${mod}`);
  const running = (await q("SELECT id FROM platform.reviews WHERE company=$1 AND module=$2 AND status='running'", [company, mod])).rows[0];
  if (running) throw new Error(`review #${running.id} is still running`);
  if (!haveKey()) throw new Error("ANTHROPIC_API_KEY not configured on this instance");
  await assertUnderCap(company);
  const r = await q(
    "INSERT INTO platform.reviews (company, module, model, version, requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [company, mod, model, row.live_version, requestedBy || null]);
  const review = r.rows[0];
  runReview(review.id).catch(async (e) => {
    console.error(`review ${review.id} failed:`, e);
    await q("UPDATE platform.reviews SET status='failed', summary=$2, finished_at=now() WHERE id=$1", [review.id, String(e.message || e)]);
  });
  return review;
}

async function runReview(reviewId) {
  const review = (await q("SELECT * FROM platform.reviews WHERE id=$1", [reviewId])).rows[0];
  const { company, module: mod, model } = review;
  const ctx = await moduleContext(company, mod);
  const files = ctx.files.length ? ctx.files : ["routes.js"];
  const guidance = await guidanceFor(company, mod);
  let data, costUsd = 0;
  if (fakeMode()) {
    data = fakeFindings(files);
  } else {
    const history = await historyText(company, mod);
    const snapshot = await dataSnapshot(company, mod);
    const out = await runStructured({
      model,
      system: `You are re-baselining a factory software module as a whole. You are not answering one complaint; you are looking at every screen, the data model, the information flow between roles, the feedback history and what was already shipped or declined, and the live data, and deciding what would most improve how the floor runs. The reader of your summary is the production manager. Each finding must be independent, small enough for one agent build, land on one screen or the server logic, and be written so a build agent can implement it from the proposal text alone. Do not repeat a change that already shipped. Prefer changes that remove friction people reported or that the data shows (waiting, stockouts, scrap, idle stations). Order findings by priority. Never mention code internals in the text the manager reads.\n\n` + guidance.text,
      prompt: `${ctx.text}\n\n${history}\n\nLive data snapshot:\n${snapshot}\n\nReview the module and return the summary and findings.`,
      schema: reviewSchema(files),
      toolName: "review",
      maxTokens: 16000,
    });
    data = out.data; costUsd = out.costUsd || 0;
  }
  const findings = (data.findings || []).slice(0, 12);
  for (const f of findings) {
    // most specific screen for the file (the parameterized route, e.g. /station/:seq)
    const screens = ctx.screens.filter((s) => s.file === f.target_file).sort((a, b) => b.route.length - a.route.length)[0];
    const fb = (await q(
      `INSERT INTO platform.feedback (company, module, page, screen, target_file, message, name, status, review_id)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,'reviewing',$7) RETURNING id`,
      [company, mod, screens ? screens.label : (f.target_file === "routes.js" ? "Server logic" : f.target_file), f.target_file,
       `${f.title}${f.why ? `\n\nWhy: ${f.why}` : ""}`, `System review #${reviewId} (${modelInfo(model).label})`, reviewId])).rows[0];
    await q(
      `INSERT INTO platform.proposals (feedback_id, body, class, target_file, rationale, model, status) VALUES ($1,$2,$3,$4,$5,$6,'draft')`,
      [fb.id, f.proposal, f.class, f.target_file, `Priority ${f.priority}. ${f.why || ""}`.trim(), model]);
  }
  await q(
    "UPDATE platform.reviews SET status='done', summary=$2, item_count=$3, cost_usd=$4, finished_at=now() WHERE id=$1",
    [reviewId, data.summary || "", findings.length, costUsd]);
  await logEvent("review_done", reviewId, { company, module: mod, model, items: findings.length, costUsd });
  await require("./record").record("review_findings", { company, module: mod, actor: "agent", after: data.summary || "", detail: { review_id: reviewId, model, items: findings.map((f) => ({ title: f.title, class: f.class, target: f.target_file, priority: f.priority })), cost_usd: costUsd || 0 } });
}

async function listReviews(company) {
  return (await q("SELECT * FROM platform.reviews WHERE company=$1 ORDER BY id DESC LIMIT 10", [company])).rows;
}

module.exports = { startReview, listReviews, estimate };
