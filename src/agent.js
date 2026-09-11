// Claude agent runner — the only place AI touches code.
//
// Uses the Claude Agent SDK (the Claude Code harness, headless) with:
//   - cwd  = the draft version directory (the agent's entire write surface)
//   - guidance docs (repo principles + the company's editable docs + the
//     module reference) as system prompt
//   - file tools only; no Bash, no network
//
// Three model roles, each selectable per company (Agent settings page):
//   propose  one structured call that drafts + classifies a proposal (small context)
//   build    the agentic multi-turn run that edits files (most of the spend)
//   review   one structured call that reviews the diff independently
//
// Cost controls:
//   SOS_MAX_RUN_USD      per build run; the run is aborted past this (default 1.50)
//   SOS_MONTHLY_CAP_USD  no new proposals or runs once this month's total
//                        crosses it (default 25)
const fs = require("fs");
const path = require("path");
const { q, getSetting } = require("./db");

const PRINCIPLES_DIR = process.env.PRINCIPLES_DIR || path.join(__dirname, "..", "principles");
const MAX_RUN_USD = Number(process.env.SOS_MAX_RUN_USD || 1.5);
const MONTHLY_CAP_USD = Number(process.env.SOS_MONTHLY_CAP_USD || 25);

// Current Claude lineup (platform.claude.com/docs/en/models/overview, Sept 2026).
// Prices are USD per million tokens, in / out.
const MODELS = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", in: 1, out: 5, note: "cheapest and fastest; fine for classifying feedback, weak for builds" },
  { id: "claude-sonnet-5", label: "Sonnet 5", in: 2, out: 10, note: "the default: good builds at a low price" },
  { id: "claude-opus-5", label: "Opus 5", in: 5, out: 25, note: "about 2.5x Sonnet 5; stronger on functionality builds and as an independent reviewer" },
  { id: "claude-fable-5-1", label: "Fable 5.1", in: 10, out: 50, note: "about 5x Sonnet 5; most capable, for hard changes" },
];
const DEFAULT_MODELS = {
  propose: process.env.SOS_MODEL_PROPOSE || "claude-sonnet-5",
  build: process.env.SOS_MODEL_BUILD || process.env.SOS_MODEL || "claude-sonnet-5",
  review: process.env.SOS_MODEL_REVIEW || "claude-opus-5",
};
function modelInfo(id) { return MODELS.find((m) => m.id === id) || { id, label: id, in: 3, out: 15, note: "" }; }
function priceOf(id) { const m = modelInfo(id); return { inTok: m.in / 1e6, outTok: m.out / 1e6 }; }

// Effective model for a role: company override -> env/default.
async function modelFor(company, role) {
  const row = company ? (await q("SELECT model_propose, model_build, model_review FROM platform.companies WHERE slug=$1", [company])).rows[0] : null;
  const pick = row && row[`model_${role}`];
  return pick && MODELS.some((m) => m.id === pick) ? pick : DEFAULT_MODELS[role];
}

function readIfExists(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

// Platform-wide principles shipped in the repo (read-only in the app).
function platformDocs() {
  return ["PRINCIPLES.md", "GUARDRAILS.md", "STYLE.md"]
    .map((name) => ({ name, content: readIfExists(path.join(PRINCIPLES_DIR, name)) }))
    .filter((d) => d.content);
}

// Everything an agent run is guided by, in order, plus the list of names so a
// run can record which docs shaped it.
async function guidanceFor(company, moduleName) {
  const docs = platformDocs().map((d) => ({ scope: "platform", ...d }));
  const rows = (await q(
    `SELECT module, name, content FROM platform.agent_docs
      WHERE company=$1 AND (module IS NULL OR module=$2) AND content <> ''
      ORDER BY module NULLS FIRST, name`, [company, moduleName])).rows;
  for (const r of rows) docs.push({ scope: r.module ? `module ${r.module}` : "company", name: r.name, content: r.content });
  const text = docs.map((d) => `<!-- ${d.scope}: ${d.name} -->\n${d.content}`).join("\n\n---\n\n");
  return { text, names: docs.map((d) => `${d.scope}: ${d.name}`) };
}

// SOS_FAKE_AGENT=1 runs the entire pipeline with a deterministic scripted
// "agent" — no API calls, zero cost. Exists to test the platform machinery and
// to dry-run the loop without a key. Clearly not the real product behavior.
function fakeMode() { return process.env.SOS_FAKE_AGENT === "1"; }
function haveKey() { return Boolean(process.env.ANTHROPIC_API_KEY) || fakeMode(); }

function fakeRunAgent({ dir, prompt }) {
  const target = (/Target file: (\S+)/.exec(prompt) || [])[1];
  const pages = path.join(dir, "pages");
  const files = target && fs.existsSync(path.join(dir, target)) ? [path.join(dir, target)]
    : fs.existsSync(pages) ? fs.readdirSync(pages).map((f) => path.join(pages, f)) : [];
  for (const p of files) fs.writeFileSync(p, fs.readFileSync(p, "utf8") + `\n<!-- revised by fake agent ${new Date().toISOString()} -->\n`);
  if (/functionality-class/i.test(prompt)) {
    const migDir = path.join(dir, "migrations");
    fs.mkdirSync(migDir, { recursive: true });
    const next = String(fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).length + 1).padStart(3, "0");
    fs.writeFileSync(path.join(migDir, `${next}.sql`), "ALTER TABLE stations ADD COLUMN IF NOT EXISTS fake_note TEXT;\n");
  }
  return { text: `- Fake agent applied a marker change to ${target || "every page"}\n- Added one additive migration (functionality lane only)\n- No real AI was involved (SOS_FAKE_AGENT=1)`, costUsd: 0 };
}

function fakeStructured(toolName, prompt) {
  const quoted = (/\n\n"([^"]{1,500})"\n\n/.exec(prompt) || [])[1] || prompt.slice(0, 200);
  const screenLine = (prompt.split("\n").find((l) => l.startsWith("Screen:")) || "");
  const target = (/\(([^()]+)\)\s*$/.exec(screenLine) || [])[1] || null;
  const canned = {
    proposal: { proposal: "Fake-mode proposal: apply the requested change as described in the feedback. (SOS_FAKE_AGENT=1)", class: /color|copy|text|label|layout|style|bigger|smaller|show|display|legend|see/i.test(quoted) ? "ui" : "functionality", target_file: target, rationale: "Deterministic fake classification for machinery testing." },
    requirement: { requirement: "Fake-mode requirement: (1) the change in the feedback will be applied, (2) everything else stays the same, (3) verified by smoke checks on staging. (SOS_FAKE_AGENT=1)" },
    verdict: { verdict: "pass", summary: "Fake-mode cross-check: diff reviewed, no violations. (SOS_FAKE_AGENT=1)" },
  };
  return { data: canned[toolName] || {}, costUsd: 0 };
}

// Run an agent turn inside a version directory. Returns { text, costUsd }.
async function runAgent({ model, system, dir, prompt, readOnly = false }) {
  if (fakeMode()) return fakeRunAgent({ dir, prompt });
  if (!haveKey()) throw new Error("ANTHROPIC_API_KEY not configured on this instance");
  const { query } = require("@anthropic-ai/claude-agent-sdk");
  const tools = readOnly ? ["Read", "Glob", "Grep"] : ["Read", "Write", "Edit", "Glob", "Grep"];
  const price = priceOf(model);
  const abort = new AbortController();
  let text = "";
  let costUsd = 0;
  let estimate = 0;
  let aborted = false;
  let stderrTail = "";
  const it = query({
    prompt,
    options: {
      cwd: dir,
      model,
      systemPrompt: system,
      allowedTools: tools,
      // acceptEdits auto-approves file edits inside cwd; the listed tools are
      // pre-allowed. We avoid bypassPermissions: the bundled CLI refuses
      // --dangerously-skip-permissions as root, which is how Railway runs.
      permissionMode: "acceptEdits",
      maxTurns: 40,
      abortController: abort,
      env: { ...process.env, IS_SANDBOX: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      stderr: (data) => { stderrTail = (stderrTail + String(data)).slice(-2000); },
    },
  });
  try {
    for await (const msg of it) {
      if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) if (block.type === "text") text += block.text;
        const u = msg.message.usage || {};
        estimate += (u.input_tokens || 0) * price.inTok + (u.output_tokens || 0) * price.outTok
          + (u.cache_read_input_tokens || 0) * price.inTok * 0.1 + (u.cache_creation_input_tokens || 0) * price.inTok * 1.25;
        if (estimate > MAX_RUN_USD && !aborted) { aborted = true; abort.abort(); }
      }
      if (msg.type === "result") {
        if (typeof msg.total_cost_usd === "number") costUsd = msg.total_cost_usd;
        if (msg.result) text = msg.result;
        if (msg.subtype && msg.subtype !== "success" && !aborted) throw new Error(`agent run ended: ${msg.subtype}`);
      }
    }
  } catch (e) {
    if (!aborted) {
      const detail = stderrTail.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
      const err = new Error(`build agent failed: ${e.message}${detail ? ` (${detail})` : ""}`);
      err.costUsd = costUsd || estimate;
      throw err;
    }
  }
  if (aborted) {
    const e = new Error(`build stopped: run cost passed the $${MAX_RUN_USD.toFixed(2)} per-run cap`);
    e.costUsd = costUsd || estimate;
    throw e;
  }
  return { text: text.trim(), costUsd: costUsd || estimate };
}

// One-shot structured call (no file tools) for proposals/classification/verdicts.
async function runStructured({ model, system, prompt, schema, toolName }) {
  if (fakeMode()) return fakeStructured(toolName, prompt);
  if (!haveKey()) throw new Error("ANTHROPIC_API_KEY not configured on this instance");
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic();
  const resp = await client.messages.create({
    model,
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: prompt }],
    tools: [{ name: toolName, description: `Return the ${toolName}.`, input_schema: schema }],
    tool_choice: { type: "tool", name: toolName },
  });
  const use = resp.content.find((b) => b.type === "tool_use");
  if (!use) throw new Error("model did not return structured output");
  const usage = resp.usage || {};
  const price = priceOf(model);
  const costUsd = (usage.input_tokens || 0) * price.inTok + (usage.output_tokens || 0) * price.outTok;
  return { data: use.input, costUsd };
}

// Month-to-date AI spend (runs + proposals), optionally per company.
async function monthlySpend(company) {
  const r = (await q(`
    SELECT COALESCE((SELECT SUM(cost_usd) FROM platform.build_runs WHERE created_at >= date_trunc('month', now()) AND ($1::text IS NULL OR company=$1)),0)
         + COALESCE((SELECT SUM(p.cost_usd) FROM platform.proposals p JOIN platform.feedback f ON f.id=p.feedback_id
                      WHERE p.created_at >= date_trunc('month', now()) AND ($1::text IS NULL OR f.company=$1)),0)
         + COALESCE((SELECT SUM(cost_usd) FROM platform.reviews WHERE created_at >= date_trunc('month', now()) AND ($1::text IS NULL OR company=$1)),0) AS usd`, [company || null])).rows[0];
  const usd = Number(r.usd || 0);
  return { usd, cap: MONTHLY_CAP_USD, capped: usd >= MONTHLY_CAP_USD };
}

async function assertUnderCap() {
  const s = await monthlySpend(null);
  if (s.capped) throw new Error(`monthly AI cap reached ($${s.usd.toFixed(2)} of $${s.cap.toFixed(2)}). Raise SOS_MONTHLY_CAP_USD to continue.`);
}

module.exports = {
  runAgent, runStructured, haveKey, fakeMode, guidanceFor, platformDocs, modelFor, modelInfo,
  MODELS, DEFAULT_MODELS, MAX_RUN_USD, MONTHLY_CAP_USD, monthlySpend, assertUnderCap,
};
