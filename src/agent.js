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
// Cost controls (all optional; unset or 0 = no cap):
//   SOS_MAX_RUN_USD      per build run; the run is aborted past this
//   SOS_MAX_BATCH_USD    ceiling for a batch run
//   SOS_MONTHLY_CAP_USD  no new proposals or runs once this month's total crosses it
//
// Reasoning effort for the build agent: SOS_AGENT_EFFORT (default "high";
// low / medium / high / xhigh / max). Decided 2026-09-17: high everywhere.
const fs = require("fs");
const path = require("path");
const { q, getSetting } = require("./db");

const PRINCIPLES_DIR = process.env.PRINCIPLES_DIR || path.join(__dirname, "..", "principles");
// Caps are off unless set (Brendan, 2026-09-17: development mode, spend what
// the work needs). A value of 0 or unset means no cap. Set SOS_MAX_RUN_USD,
// SOS_MAX_BATCH_USD and SOS_MONTHLY_CAP_USD to bring them back.
const capEnv = (name) => { const v = Number(process.env[name] || 0); return Number.isFinite(v) && v > 0 ? v : 0; };
const MAX_RUN_USD = capEnv("SOS_MAX_RUN_USD");
// A batch gets MAX_RUN_USD per change, never more than MAX_BATCH_USD in one run.
const MAX_BATCH_USD = capEnv("SOS_MAX_BATCH_USD");
const runCapUsd = (changes) => {
  if (!MAX_RUN_USD) return 0;
  const usd = MAX_RUN_USD * Math.max(1, changes || 1);
  return MAX_BATCH_USD ? Math.min(usd, MAX_BATCH_USD) : usd;
};
const MONTHLY_CAP_USD = capEnv("SOS_MONTHLY_CAP_USD");

// Current Claude lineup (platform.claude.com/docs/en/models/overview, Sept 2026).
// Prices are USD per million tokens, in / out.
const MODELS = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", in: 1, out: 5, note: "cheapest and fastest; fine for classifying feedback, weak for builds" },
  { id: "claude-sonnet-5", label: "Sonnet 5", in: 2, out: 10, note: "the default: good builds at a low price" },
  { id: "claude-opus-5", label: "Opus 5", in: 5, out: 25, note: "about 2.5x Sonnet 5; stronger on functionality builds and as an independent reviewer" },
  { id: "claude-fable-5-1", label: "Fable 5.1", in: 10, out: 50, note: "about 5x Sonnet 5; most capable, for builds, proposals, system reviews and cross-checks alike" },
];
// Models the build agent (Claude Code) can run: all of them since the Agent SDK
// upgrade of 2026-09-17 (0.1.77 predated Fable and died on it). `agent: false`
// on a MODELS row still keeps a model out of builds, should that ever be needed.
const canBuild = (id) => { const m = MODELS.find((x) => x.id === id); return !m || m.agent !== false; };
// Pick the model for the build agent: the requested one if it can build,
// otherwise the company's build model. Returns { model, substituted }.
async function buildModelFor(company, requested) {
  if (requested && canBuild(requested)) return { model: requested, substituted: null };
  let fallback = await modelFor(company, "build");
  if (!canBuild(fallback)) fallback = "claude-sonnet-5";
  return { model: fallback, substituted: requested || null };
}
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
// The platform STYLE.md is the default look. A company with its own STYLE.md
// (written by the brand step, or by hand) replaces it: the two never sit in
// the same prompt, because an agent given both keeps the platform one.
async function guidanceFor(company, moduleName) {
  const rows = (await q(
    `SELECT module, name, content FROM platform.agent_docs
      WHERE company=$1 AND (module IS NULL OR module=$2) AND content <> ''
      ORDER BY module NULLS FIRST, name`, [company, moduleName])).rows;
  const companyStyle = rows.some((r) => !r.module && r.name === "STYLE.md");
  const docs = platformDocs().filter((d) => !(companyStyle && d.name === "STYLE.md")).map((d) => ({ scope: "platform", ...d }));
  // a module's chat personas (module.json "agents") are not build guidance
  const personas = new Set();
  try {
    const registry = require("./registry");
    const row = await registry.getModule(company, moduleName);
    if (row && row.live_version) for (const a of Object.values(registry.readManifest(company, moduleName, row.live_version).agents || {})) if (a && a.doc) personas.add(a.doc);
  } catch (e) { /* no manifest, nothing to exclude */ }
  for (const r of rows) if (!(r.module && personas.has(r.name))) docs.push({ scope: r.module ? `module ${r.module}` : "company", name: r.name, content: r.content });
  const text = docs.map((d) => `<!-- ${d.scope}: ${d.name} -->\n${d.content}`).join("\n\n---\n\n");
  return { text, names: docs.map((d) => `${d.scope}: ${d.name}`) };
}

// SOS_FAKE_AGENT=1 runs the entire pipeline with a deterministic scripted
// "agent" — no API calls, zero cost. Exists to test the platform machinery and
// to dry-run the loop without a key. Clearly not the real product behavior.
function fakeMode() { return process.env.SOS_FAKE_AGENT === "1"; }
function haveKey() { return Boolean(process.env.ANTHROPIC_API_KEY) || fakeMode(); }

// GATECHECK in the feedback (or in a new module's name) makes the fake agent's
// first attempt trip the module gate (src/modulegate.js): a line that reads the
// server's settings in a functionality or module build, a harmless line in
// routes.js in a UI build (which may not touch that file at all). The fix
// round takes the line out again, so the whole branch walks at zero spend.
function fakeGateLine(dir, prompt, leak) {
  const routesPath = path.join(dir, "routes.js");
  if (!fs.existsSync(routesPath)) return;
  const before = fs.readFileSync(routesPath, "utf8");
  let routes = before.replace(/\n\/\/ FAKE-GATE\n[^\n]*\n/g, "");   // back to the file exactly as it was
  if (/GATECHECK/.test(prompt) && !/independent reviewer looked at your previous attempt|own checks refused the previous attempt/.test(prompt)) {
    routes += leak ? "\n// FAKE-GATE\nconst fakeGateLeak = process.env.DATABASE_URL;\n" : "\n// FAKE-GATE\nconst fakeGateTouched = true;\n";
  }
  if (routes !== before) fs.writeFileSync(routesPath, routes);
}

function fakeRunAgent({ dir, prompt }) {
  if (/^NEW MODULE BUILD/m.test(prompt)) {
    fakeGateLine(dir, prompt, true);
    // the skeleton the platform wrote is already a working module; the fake
    // agent only proves the loop by stamping the first page
    const pages = path.join(dir, "pages");
    for (const f of fs.existsSync(pages) ? fs.readdirSync(pages) : []) {
      const p = path.join(pages, f);
      fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("</body>", `<p data-changed="v1" style="font-size:12px;color:#51606f;margin:8px 0">Built by the fake agent from the design (SOS_FAKE_AGENT=1).</p>\n</body>`));
    }
    return { text: "- Built the first version from the design: one list of the thing, its stages, a move button per item\n- No real AI was involved (SOS_FAKE_AGENT=1)", costUsd: 0 };
  }
  const target = (/Target file: (\S+)/.exec(prompt) || [])[1];
  const pages = path.join(dir, "pages");
  const files = target && fs.existsSync(path.join(dir, target)) ? [path.join(dir, target)]
    : fs.existsSync(pages) ? fs.readdirSync(pages).map((f) => path.join(pages, f)) : [];
  // FAILCHECK in the feedback makes the first attempt fail the fake cross-check; a fix round clears it
  const fixRound = /independent reviewer looked at your previous attempt|own checks refused the previous attempt|platform ran its checks against your previous attempt/.test(prompt);
  const bad = /FAILCHECK/.test(prompt) && !fixRound;
  fakeGateLine(dir, prompt, /functionality-class/i.test(prompt));
  const ver = (/data-changed="(v\d+)"/.exec(prompt) || [])[1] || "v0";
  for (const p of files) {
    let html = fs.readFileSync(p, "utf8").replace(/\n<!-- FAKE-BAD -->\n/g, "");
    const mark = `<p data-changed="${ver}" style="font-size:12px;color:#51606f;margin:8px 0">Revised by the fake agent (${ver}).</p>`;
    html = html.includes("</body>") ? html.replace("</body>", `${mark}\n</body>`) : html + mark;
    fs.writeFileSync(p, html + `\n<!-- revised by fake agent ${new Date().toISOString()} -->\n${bad ? "<!-- FAKE-BAD -->\n" : ""}`);
  }
  // The checks of build order item 7, exercised without a key. Each marker breaks the FIRST attempt one way and
  // a fix round clears it:
  //   BREAKPAGE     a script on the target page throws when the page opens          (the page load stops it)
  //   BREAKSYNTAX   a script on the target page does not parse                       (caught with or without a browser)
  //   BREAKPROMISE  the first /api/ path of the smoke list answers a list, not an     (checks earlier changes
  //                 object: it still answers, so only what was promised about it breaks  left behind stop it)
  //   BADCHECK      the check left behind by this change expects the impossible      (its own check stops it)
  //   BADSMOKE      module.json lists a path to check that is not there               (the endpoints stop it)
  //   EDITCHECK     the build rewrites a check an earlier change left behind           (the module gate stops it)
  //   NOCHECK       a functionality change that leaves no check behind                (passes; the run log says so)
  for (const p of files) {
    let html = fs.readFileSync(p, "utf8").replace(/\n<script data-fake-break>[\s\S]*?<\/script>\n/g, "");
    if (/BREAKPAGE/.test(prompt) && !fixRound) html = html.replace("</body>", `\n<script data-fake-break>fakeAgentCalledSomethingThatIsNotThere();</script>\n</body>`);
    if (/BREAKSYNTAX/.test(prompt) && !fixRound) html = html.replace("</body>", `\n<script data-fake-break>function fakeAgentLeftABraceOpen( {</script>\n</body>`);
    fs.writeFileSync(p, html);
  }
  const manifestFile = path.join(dir, "module.json");
  let manifest = {}; try { manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch (e) { /* no manifest, no api path */ }
  const apiPath = (manifest.smoke || []).find((x) => /^\/api\//.test(x) && !/fake-not-there/.test(x)) || null;
  const routesFile = path.join(dir, "routes.js");
  const FUNC = /functionality-class/i.test(prompt);
  if (FUNC && apiPath && fs.existsSync(routesFile)) {
    const brokenLine = `  router.get("${apiPath}", (req, res) => res.json(["fake broken promise"]));   // FAKE-BREAKPROMISE\n`;
    let js = fs.readFileSync(routesFile, "utf8").split(brokenLine).join("");
    if (/BREAKPROMISE/.test(prompt) && !fixRound) js = js.replace(/(const router = express\.Router\(\);\n)/, `$1${brokenLine}`);
    fs.writeFileSync(routesFile, js);
  }
  if (FUNC && Array.isArray(manifest.smoke)) {
    manifest.smoke = manifest.smoke.filter((x) => x !== "/api/fake-not-there");
    if (/BADSMOKE/.test(prompt) && !fixRound) manifest.smoke.push("/api/fake-not-there");
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  }
  if (FUNC) {
    const migDir = path.join(dir, "migrations");
    fs.mkdirSync(migDir, { recursive: true });
    const next = String(fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).length + 1).padStart(3, "0");
    fs.writeFileSync(path.join(migDir, `${next}.sql`), "ALTER TABLE stations ADD COLUMN IF NOT EXISTS fake_note TEXT;\n");
    const chkDir = path.join(dir, "checks");
    const existing = fs.existsSync(chkDir) ? fs.readdirSync(chkDir).filter((f) => f.endsWith(".json")).sort() : [];
    if (/EDITCHECK/.test(prompt) && !fixRound && existing.length) fs.writeFileSync(path.join(chkDir, existing[0]), JSON.stringify({ title: "The fake agent rewrote a promise it did not make", steps: [{ call: "GET /" }] }, null, 2) + "\n");
    if (!/NOCHECK/.test(prompt) && apiPath) {
      fs.mkdirSync(chkDir, { recursive: true });
      const mine = existing.find((f) => f.endsWith(`-fake-change-${ver}.json`));
      const name = mine || `${String(existing.length + 1).padStart(3, "0")}-fake-change-${ver}.json`;
      fs.writeFileSync(path.join(chkDir, name), JSON.stringify({ title: `The fake change of ${ver} keeps ${apiPath} answering with an object`, steps: [{ call: `GET ${apiPath}`, expect: { status: /BADCHECK/.test(prompt) && !fixRound ? 418 : 200, json: { $type: "object" } } }] }, null, 2) + "\n");
    }
  }
  return { text: `- Fake agent applied a marker change to ${target || "every page"}\n- Added one additive migration and one check (functionality lane only)\n- No real AI was involved (SOS_FAKE_AGENT=1)`, costUsd: 0 };
}

function fakeStructured(toolName, prompt) {
  const quoted = (/\n\n"([^"]{1,500})"\n\n/.exec(prompt) || [])[1] || prompt.slice(0, 200);
  const screenLine = (prompt.split("\n").find((l) => l.startsWith("Screen:")) || "");
  const target = (/\(([^()]+)\)\s*$/.exec(screenLine) || [])[1] || null;
  const canned = {
    proposal: { erp_data: (() => { const need = /ERPNEED:([a-z_0-9]*)/.exec(quoted); const lk = ((/ERP lookups available to this module: ([^\n]+)/.exec(prompt) || [])[1] || "").split(",")[0].trim(); return need && lk ? [{ what: `fake need: ${need[1] || "something the ERP does not give"}`, lookup: lk, field: need[1] }] : []; })(), proposal: "Fake-mode proposal: apply the requested change as described in the feedback. (SOS_FAKE_AGENT=1)", class: /color|copy|text|label|layout|style|bigger|smaller|show|display|legend|see/i.test(quoted) ? "ui" : "functionality", target_file: target, rationale: "Deterministic fake classification for machinery testing." + ((/This is a follow-up to request #(\d+)\./.exec(prompt) || [])[1] ? ` Follow-up context received for request #${/This is a follow-up to request #(\d+)\./.exec(prompt)[1]}.` : "") },
    requirement: {
      bluf: "Fake-mode requirement: the change in the feedback is applied and nothing else moves.",
      items: (prompt.match(/^Change \d+ of \d+/gm) || ["Approved proposal"]).map((h, i) => ({ change: i + 1, summary: `Fake-mode item ${i + 1}: apply that change on its screen, nothing else.` })),
      requirement: "Fake-mode requirement: (1) the change in the feedback will be applied, (2) everything else stays the same, (3) verified by smoke checks on staging. (SOS_FAKE_AGENT=1)",
    },
    brand: { guide_md: "# Visual style: Fake Co (fake mode)\n\nPrimary color #1f3a5f, accent #c2620a, system font. (SOS_FAKE_AGENT=1)", primary: "#1f3a5f", accent: "#c2620a", background: "#f2f4f7", ink: "#1c242e", font_stack: "system-ui, sans-serif", company_name: "Fake Co", tone: "plain" },
    verdict: /FAKE-BAD/.test(prompt)
      ? { verdict: "fail", summary: "Fake-mode cross-check: the diff carries a FAKE-BAD marker, which stands in for a change that does not meet the requirement. (SOS_FAKE_AGENT=1)", findings: [{ severity: "blocking", where: "the page", what: "carries the FAKE-BAD marker", evidence: "<!-- FAKE-BAD -->" }] }
      : { verdict: "pass", summary: "Fake-mode cross-check: diff reviewed, no violations. (SOS_FAKE_AGENT=1)", findings: [] },
    summary: { title: `Fake change to ${target || "the module"}`, what_changed: "Fake-mode summary: a marker was stamped on the page named in the feedback. Nothing else changed. (SOS_FAKE_AGENT=1)" },
  };
  return { data: canned[toolName] || {}, costUsd: 0 };
}

// Environment handed to the Claude Code subprocess. An explicit allow-list, not
// a spread of process.env: the agent reads feedback text typed by floor users,
// so it must never see DATABASE_URL, SESSION_SECRET, the login passwords, or
// the internal token. It only needs the API key, a PATH and HOME, and the
// ANTHROPIC_*/CLAUDE_* knobs (base URL, model overrides).
function agentEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS"].includes(k)) out[k] = v;
    else if (/^(ANTHROPIC_|CLAUDE_)/.test(k)) out[k] = v;
  }
  out.IS_SANDBOX = "1";
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  // The CLI can swap in a fallback model when the chosen one is unavailable.
  // A build must run on the model the manager picked or not at all, so that
  // "built on Fable" (evidence.models_seen) is provable.
  out.CLAUDE_CODE_NO_MODEL_FALLBACK = "1";
  return out;
}

const AGENT_EFFORT = process.env.SOS_AGENT_EFFORT || "high";

// Run an agent turn inside a version directory.
// Returns { text, costUsd, modelsSeen }: modelsSeen is every model id the
// run reported (the init message and each assistant message); a run built on
// the requested model reports exactly one.
async function runAgent({ model, system, dir, prompt, readOnly = false, capUsd, signal, maxTurns }) {
  const cap = capUsd || MAX_RUN_USD;   // 0 = no cap
  if (fakeMode()) {
    // fake builds take a moment so an abort can be exercised without a key
    await new Promise((r) => setTimeout(r, Number(process.env.SOS_FAKE_DELAY_MS || 1500)));
    if (signal && signal.aborted) { const e = new Error("build aborted by the manager"); e.aborted = true; throw e; }
    return { ...fakeRunAgent({ dir, prompt }), modelsSeen: [model] };
  }
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
  let seen = 0, initSeen = false;
  const modelsSeen = new Set();
  // manager abort (the run's Abort button) kills the agent process the same way the cost cap does
  let killed = false;
  const onKill = () => { killed = true; abort.abort(); };
  if (signal) { if (signal.aborted) onKill(); else signal.addEventListener("abort", onKill, { once: true }); }
  const it = query({
    prompt,
    options: {
      cwd: dir,
      model,
      systemPrompt: system,
      // `tools` is the whole tool list the model gets (no Bash, no web, no
      // subagents); `allowedTools` pre-approves them so acceptEdits never
      // has to ask. Verified 2026-09-17: the init message lists only these.
      tools,
      allowedTools: tools,
      // acceptEdits auto-approves file edits inside cwd. We avoid
      // bypassPermissions: the bundled CLI refuses it as root, which is how
      // Railway runs. (Checked again on SDK 0.3.274: acceptEdits as root is fine.)
      permissionMode: "acceptEdits",
      effort: AGENT_EFFORT,
      maxTurns: maxTurns || Number(process.env.SOS_AGENT_MAX_TURNS || 40),
      // Far safety rail only, and only when a cap is set. The working limit is
      // our own estimate below, which aborts at `cap`; this catches a run whose
      // usage messages never arrived. Decided 2026-09-17: no hard kill at the
      // working limit, and no caps at all in development mode.
      ...(cap ? { maxBudgetUsd: cap * 3 } : {}),
      abortController: abort,
      env: agentEnv(),
      stderr: (data) => { stderrTail = (stderrTail + String(data)).slice(-4000); },
    },
  });
  try {
    for await (const msg of it) {
      seen++;
      if (msg.type === "system" && msg.subtype === "init") { initSeen = true; if (msg.model) modelsSeen.add(msg.model); }
      if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
        if (msg.message.model) modelsSeen.add(msg.message.model);
        for (const block of msg.message.content) if (block.type === "text") text += block.text;
        const u = msg.message.usage || {};
        estimate += (u.input_tokens || 0) * price.inTok + (u.output_tokens || 0) * price.outTok
          + (u.cache_read_input_tokens || 0) * price.inTok * 0.1 + (u.cache_creation_input_tokens || 0) * price.inTok * 1.25;
        if (cap && estimate > cap && !aborted && !killed) { aborted = true; abort.abort(); }
      }
      if (msg.type === "result") {
        if (typeof msg.total_cost_usd === "number") costUsd = msg.total_cost_usd;
        // On this SDK a turn that ended on an API error still comes back as
        // subtype "success" with is_error set and the error text in result.
        if (msg.is_error && !aborted && !killed) throw new Error(`the model's API answered with an error: ${String(msg.result || "").slice(0, 300)}`);
        if (msg.result) text = msg.result;
        if (msg.subtype === "error_max_budget_usd" && !aborted && !killed) throw new Error(`build stopped at the safety budget ($${(cap * 3).toFixed(2)})`);
        if (msg.subtype && msg.subtype !== "success" && !aborted) throw new Error(`agent run ended: ${msg.subtype}`);
      }
    }
  } catch (e) {
    if (killed) { const err = new Error("build aborted by the manager"); err.aborted = true; err.costUsd = costUsd || estimate; throw err; }
    if (!aborted) {
      const lines = stderrTail.trim().split("\n").filter(Boolean);
      const detail = lines.slice(-3).join(" | ");
      const stage = !initSeen ? "the agent process died before it started" : seen < 3 ? "the agent process died right after starting" : `after ${seen} messages`;
      const said = text.trim() ? `; the model's last words: "${text.trim().slice(-200)}"` : "";
      const err = new Error(`build agent failed: ${e.message} (${stage}; model ${model}${detail ? `; ${detail}` : "; nothing on stderr"}${said})`);
      err.costUsd = costUsd || estimate;
      err.diag = { model, modelsSeen: [...modelsSeen], effort: AGENT_EFFORT, messages: seen, initSeen, stderr: stderrTail.slice(-4000), lastText: text.slice(-600), promptChars: prompt.length, systemChars: (system || "").length };
      throw err;
    }
  }
  if (signal) signal.removeEventListener("abort", onKill);
  if (killed) { const e = new Error("build aborted by the manager"); e.aborted = true; e.costUsd = costUsd || estimate; throw e; }
  if (aborted) {
    const e = new Error(`build stopped: run cost passed the $${cap.toFixed(2)} cap for this run`);
    e.costUsd = costUsd || estimate;
    throw e;
  }
  return { text: text.trim(), costUsd: costUsd || estimate, modelsSeen: [...modelsSeen] };
}

// One-shot structured call (no file tools) for proposals/classification/verdicts.
// Some models (Fable 5.1 at the time of writing) reject a forced tool_choice
// ("type tool and any are not supported for this model"). For those we ask
// with tool_choice auto plus an explicit instruction, and accept a JSON body
// in plain text as a last resort. The set of models that refused is cached
// for the life of the process so the second call does not pay for the 400.
const noForcedTool = new Set();
// `blocks`: optional content blocks (images, pdf documents, extra text) that
// go in front of the prompt text, for callers that hand the model attachments.
async function runStructured({ model, system, prompt, schema, toolName, maxTokens, blocks }) {
  if (fakeMode()) return fakeStructured(toolName, prompt);
  if (!haveKey()) throw new Error("ANTHROPIC_API_KEY not configured on this instance");
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic();
  const tools = [{ name: toolName, description: `Return the ${toolName}.`, input_schema: schema }];
  const content = (text) => (blocks && blocks.length ? [...blocks, { type: "text", text }] : text);
  const call = (forced) => client.messages.create({
    model,
    max_tokens: maxTokens || 4000,
    system,
    messages: [{ role: "user", content: content(forced ? prompt : `${prompt}\n\nRespond only by calling the ${toolName} tool with the complete result. No prose.`) }],
    tools,
    tool_choice: forced ? { type: "tool", name: toolName } : { type: "auto" },
  });
  let resp;
  if (noForcedTool.has(model)) resp = await call(false);
  else {
    try { resp = await call(true); }
    catch (e) {
      const msg = String(e && e.message || e);
      if (e && e.status === 400 && /tool_choice/i.test(msg)) { noForcedTool.add(model); resp = await call(false); }
      else throw e;
    }
  }
  let data;
  const use = resp.content.find((b) => b.type === "tool_use");
  if (use) data = use.input;
  else {
    const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { data = JSON.parse(m[0]); } catch { /* fall through */ } }
    if (!data) throw new Error(`model did not return structured output (stop_reason ${resp.stop_reason})`);
  }
  const usage = resp.usage || {};
  const price = priceOf(model);
  const costUsd = (usage.input_tokens || 0) * price.inTok + (usage.output_tokens || 0) * price.outTok;
  return { data, costUsd };
}

// Plain chat call (no tools): a module's conversational agent. Returns
// { text, costUsd }. Fake mode answers with a canned line.
async function runChat({ model, system, messages, maxTokens }) {
  if (fakeMode()) {
    const last = [...messages].reverse().find((m) => m.role === "user");
    return { text: `Fake-mode answer to "${String(last && last.content || "").slice(0, 80)}": the data digest was read; nothing else happened. (SOS_FAKE_AGENT=1)`, costUsd: 0 };
  }
  if (!haveKey()) throw new Error("ANTHROPIC_API_KEY not configured on this instance");
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic();
  const resp = await client.messages.create({ model, max_tokens: maxTokens || 1500, system, messages });
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const usage = resp.usage || {};
  const price = priceOf(model);
  const costUsd = (usage.input_tokens || 0) * price.inTok + (usage.output_tokens || 0) * price.outTok;
  return { text, costUsd };
}

// Spend that is not a build run, proposal, review or brand build (chat agents).
async function recordUsage(company, moduleName, kind, model, costUsd, detail) {
  await q("INSERT INTO platform.ai_usage (company, module, kind, model, cost_usd, detail) VALUES ($1,$2,$3,$4,$5,$6)",
    [company, moduleName || null, kind, model || null, Number(costUsd || 0), JSON.stringify(detail || {})]);
}

// Month-to-date AI spend (runs + proposals), optionally per company.
async function monthlySpend(company) {
  const r = (await q(`
    SELECT COALESCE((SELECT SUM(cost_usd) FROM platform.build_runs WHERE created_at >= date_trunc('month', now()) AND ($1::text IS NULL OR company=$1)),0)
         + COALESCE((SELECT SUM(p.cost_usd) FROM platform.proposals p JOIN platform.feedback f ON f.id=p.feedback_id
                      WHERE p.created_at >= date_trunc('month', now()) AND ($1::text IS NULL OR f.company=$1)),0)
         + COALESCE((SELECT SUM(cost_usd) FROM platform.reviews WHERE created_at >= date_trunc('month', now()) AND ($1::text IS NULL OR company=$1)),0)
         + COALESCE((SELECT SUM((brand->>'cost_usd')::numeric) FROM platform.companies WHERE brand IS NOT NULL AND (brand->>'built_at')::timestamptz >= date_trunc('month', now()) AND ($1::text IS NULL OR slug=$1)),0)
         + COALESCE((SELECT SUM(cost_usd) FROM platform.ai_usage WHERE created_at >= date_trunc('month', now()) AND ($1::text IS NULL OR company=$1)),0) AS usd`, [company || null])).rows[0];
  const usd = Number(r.usd || 0);
  // For one company the cap that counts is its own (set on the admin page);
  // the instance-wide cap is only shown when the company has none.
  const own = company ? await companyCap(company) : 0;
  const cap = own || MONTHLY_CAP_USD;
  return { usd, cap, capKind: own ? "company" : MONTHLY_CAP_USD ? "instance" : null, capped: own ? usd >= own : (!company && MONTHLY_CAP_USD > 0 && usd >= MONTHLY_CAP_USD) };
}

// A company's own monthly AI budget (platform.companies.monthly_cap_usd); 0 = none.
async function companyCap(company) {
  if (!company) return 0;
  const row = (await q("SELECT monthly_cap_usd FROM platform.companies WHERE slug=$1", [company])).rows[0];
  const v = row ? Number(row.monthly_cap_usd) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// Two budgets, checked separately: the company's own, against the company's
// own spend, so one company running out never stops another (until
// 2026-09-19 the only cap was instance-wide and did exactly that); and the
// instance-wide one from the environment, when it is set at all.
async function assertUnderCap(company) {
  const own = await companyCap(company);
  if (own) {
    const mine = await monthlySpend(company);
    if (mine.usd >= own) throw new Error(`this company's AI budget for the month is used up ($${mine.usd.toFixed(2)} of $${own.toFixed(2)}). The platform's admin can raise it on the admin page.`);
  }
  if (MONTHLY_CAP_USD > 0) {
    const all = await monthlySpend(null);
    if (all.usd >= MONTHLY_CAP_USD) throw new Error(`monthly AI cap for the whole instance reached ($${all.usd.toFixed(2)} of $${MONTHLY_CAP_USD.toFixed(2)}). Raise SOS_MONTHLY_CAP_USD to continue.`);
  }
}

module.exports = {
  runAgent, runStructured, runChat, recordUsage, haveKey, fakeMode, guidanceFor, platformDocs, modelFor, modelInfo, buildModelFor, canBuild,
  MODELS, DEFAULT_MODELS, MAX_RUN_USD, MAX_BATCH_USD, runCapUsd, MONTHLY_CAP_USD, monthlySpend, assertUnderCap, companyCap, AGENT_EFFORT,
};
