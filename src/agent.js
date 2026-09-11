// Claude agent runner — the only place AI touches code.
//
// Uses the Claude Agent SDK (the Claude Code harness, headless) with:
//   - cwd  = the draft version directory (the agent's entire write surface)
//   - principles files + the module reference format prepended as system prompt
//   - file tools only; no Bash, no network
// Requires ANTHROPIC_API_KEY. Every run's cost is captured from SDK usage totals.
//
// Cost controls:
//   SOS_MAX_RUN_USD      per build run; the run is aborted when its running
//                        estimate crosses this (default 1.50)
//   SOS_MONTHLY_CAP_USD  no new proposals or runs once this month's total
//                        crosses it (default 25). Checked in pipeline/proposals.
const fs = require("fs");
const path = require("path");

const PRINCIPLES_DIR = process.env.PRINCIPLES_DIR || path.join(__dirname, "..", "principles");
const MODEL = process.env.SOS_MODEL || "claude-sonnet-4-5";
const MAX_RUN_USD = Number(process.env.SOS_MAX_RUN_USD || 1.5);
const MONTHLY_CAP_USD = Number(process.env.SOS_MONTHLY_CAP_USD || 25);

// rough per-token pricing for the running estimate (USD per token)
const PRICE_IN = Number(process.env.SOS_PRICE_IN || 3 / 1e6);
const PRICE_OUT = Number(process.env.SOS_PRICE_OUT || 15 / 1e6);

function readIfExists(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function principlesPrompt(moduleName) {
  const parts = [
    readIfExists(path.join(PRINCIPLES_DIR, "PRINCIPLES.md")),
    readIfExists(path.join(PRINCIPLES_DIR, "GUARDRAILS.md")),
    readIfExists(path.join(PRINCIPLES_DIR, "STYLE.md")),
    readIfExists(path.join(PRINCIPLES_DIR, "module-formats", `${moduleName}.md`)),
  ].filter(Boolean);
  return parts.join("\n\n---\n\n");
}

// SOS_FAKE_AGENT=1 runs the entire pipeline with a deterministic scripted
// "agent" — no API calls, zero cost. Exists to test the platform machinery
// (versioning, staging clones, migrations, smoke checks, deploy, rollback)
// and to dry-run the loop without a key. Clearly not the real product behavior.
function fakeMode() { return process.env.SOS_FAKE_AGENT === "1"; }
function haveKey() { return Boolean(process.env.ANTHROPIC_API_KEY) || fakeMode(); }

function fakeRunAgent({ dir, prompt }) {
  const pages = path.join(dir, "pages");
  if (fs.existsSync(pages)) {
    for (const f of fs.readdirSync(pages)) {
      const p = path.join(pages, f);
      fs.writeFileSync(p, fs.readFileSync(p, "utf8") + `\n<!-- revised by fake agent ${new Date().toISOString()} -->\n`);
    }
  }
  if (/functionality-class/i.test(prompt)) {
    const migDir = path.join(dir, "migrations");
    fs.mkdirSync(migDir, { recursive: true });
    const next = String(fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).length + 1).padStart(3, "0");
    fs.writeFileSync(path.join(migDir, `${next}.sql`),
      "ALTER TABLE stations ADD COLUMN IF NOT EXISTS fake_note TEXT;\n");
  }
  return { text: "- Fake agent applied a marker change to the page\n- Added one additive migration (functionality lane only)\n- No real AI was involved (SOS_FAKE_AGENT=1)", costUsd: 0 };
}

function fakeStructured(toolName, prompt) {
  // classify on the quoted feedback text only, not the module source that follows it
  const quoted = (/\n\n"([^"]{1,500})"\n\n/.exec(prompt) || [])[1] || prompt.slice(0, 200);
  const canned = {
    proposal: { proposal: "Fake-mode proposal: apply the requested change as described in the feedback. (SOS_FAKE_AGENT=1)", class: /color|copy|text|label|layout|style|bigger|smaller|show|display|legend|see/i.test(quoted) ? "ui" : "functionality", rationale: "Deterministic fake classification for machinery testing." },
    requirement: { requirement: "Fake-mode requirement: (1) the change in the feedback will be applied, (2) everything else stays the same, (3) verified by smoke checks on staging. (SOS_FAKE_AGENT=1)" },
    verdict: { verdict: "pass", summary: "Fake-mode cross-check: diff reviewed, no violations. (SOS_FAKE_AGENT=1)" },
  };
  return { data: canned[toolName] || {}, costUsd: 0 };
}

// Run an agent turn inside a version directory. Returns { text, costUsd }.
async function runAgent({ moduleName, dir, prompt, readOnly = false }) {
  if (fakeMode()) return fakeRunAgent({ dir, prompt });
  if (!haveKey()) throw new Error("ANTHROPIC_API_KEY not configured on this instance");
  const { query } = require("@anthropic-ai/claude-agent-sdk");
  const tools = readOnly ? ["Read", "Glob", "Grep"] : ["Read", "Write", "Edit", "Glob", "Grep"];
  const abort = new AbortController();
  let text = "";
  let costUsd = 0;
  let estimate = 0;
  let aborted = false;
  const it = query({
    prompt,
    options: {
      cwd: dir,
      model: MODEL,
      systemPrompt: principlesPrompt(moduleName),
      allowedTools: tools,
      permissionMode: "bypassPermissions",
      maxTurns: 40,
      abortController: abort,
    },
  });
  for await (const msg of it) {
    if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === "text") text += block.text;
      }
      const u = msg.message.usage || {};
      estimate += (u.input_tokens || 0) * PRICE_IN + (u.output_tokens || 0) * PRICE_OUT
        + (u.cache_read_input_tokens || 0) * PRICE_IN * 0.1 + (u.cache_creation_input_tokens || 0) * PRICE_IN * 1.25;
      if (estimate > MAX_RUN_USD && !aborted) { aborted = true; abort.abort(); }
    }
    if (msg.type === "result") {
      if (typeof msg.total_cost_usd === "number") costUsd = msg.total_cost_usd;
      if (msg.result) text = msg.result;
      if (msg.subtype && msg.subtype !== "success" && !aborted) {
        throw new Error(`agent run ended: ${msg.subtype}`);
      }
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
async function runStructured({ system, prompt, schema, toolName }) {
  if (fakeMode()) return fakeStructured(toolName, prompt);
  if (!haveKey()) throw new Error("ANTHROPIC_API_KEY not configured on this instance");
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: prompt }],
    tools: [{ name: toolName, description: `Return the ${toolName}.`, input_schema: schema }],
    tool_choice: { type: "tool", name: toolName },
  });
  const use = resp.content.find((b) => b.type === "tool_use");
  if (!use) throw new Error("model did not return structured output");
  const usage = resp.usage || {};
  const costUsd = (usage.input_tokens || 0) * PRICE_IN + (usage.output_tokens || 0) * PRICE_OUT;
  return { data: use.input, costUsd };
}

// Month-to-date AI spend (runs + proposals) and whether the cap is hit.
async function monthlySpend() {
  const { q } = require("./db");
  const r = (await q(`
    SELECT COALESCE((SELECT SUM(cost_usd) FROM platform.build_runs WHERE created_at >= date_trunc('month', now())),0)
         + COALESCE((SELECT SUM(cost_usd) FROM platform.proposals WHERE created_at >= date_trunc('month', now())),0) AS usd`)).rows[0];
  const usd = Number(r.usd || 0);
  return { usd, cap: MONTHLY_CAP_USD, capped: usd >= MONTHLY_CAP_USD };
}

async function assertUnderCap() {
  const s = await monthlySpend();
  if (s.capped) throw new Error(`monthly AI cap reached ($${s.usd.toFixed(2)} of $${s.cap.toFixed(2)}). Raise SOS_MONTHLY_CAP_USD to continue.`);
}

module.exports = { runAgent, runStructured, haveKey, fakeMode, principlesPrompt, MODEL, MAX_RUN_USD, MONTHLY_CAP_USD, monthlySpend, assertUnderCap };
