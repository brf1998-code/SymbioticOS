// Plain-words guard (principles/PLAIN-WORDS.md): the words that never appear
// in anything a manager reads during module creation. Three cheap steps: a
// word check; if anything trips, one rewrite by a small model; the check
// again. The caller decides what to do with a text that still fails (drop a
// question, flag a summary line).
const fs = require("fs");
const path = require("path");

// Whole-word, case-insensitive. Phrases first so "AI model" is caught as a
// phrase (bare "model" is fine: a part model, a model number).
const BANNED = [
  "AI model", "language model", "data table", "data model", "user interface", "stack trace", "error log",
  "API", "APIs", "endpoint", "endpoints", "webhook", "webhooks", "HTTP", "HTTPS", "URL", "URLs",
  "database", "databases", "schema", "schemas", "SQL", "Postgres", "PostgreSQL",
  "query", "queries", "migration", "migrations", "deploy", "deploys", "deployed", "deployment", "deployments",
  "JSON", "config", "configs", "configure", "configured", "configuration", "parameter", "parameters", "variable", "variables", "boolean", "booleans", "null",
  "backend", "back-end", "frontend", "front-end", "server", "servers", "client-side", "server-side",
  "sync", "syncs", "synchronize", "synchronized", "synchronization",
  "token", "tokens", "credential", "credentials", "authenticate", "authentication", "auth",
  "prompt", "prompts", "LLM", "LLMs", "UI", "UX",
  "integration", "integrations", "integrate", "integrated",
  "exception", "exceptions",
];
const PATTERNS = BANNED.map((w) => ({ word: w, re: new RegExp(`(?<![A-Za-z0-9-])${w.replace(/[-\s]/g, (c) => (c === " " ? "\\s+" : "\\-"))}(?![A-Za-z0-9-])`, "i") }));

let rulesCache = null;
function rules() {
  if (rulesCache == null) {
    const p = path.join(process.env.PRINCIPLES_DIR || path.join(__dirname, "..", "principles"), "PLAIN-WORDS.md");
    rulesCache = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  }
  return rulesCache;
}

// The banned words found in a text, minus anything on the allow list (the
// company's own names for its systems, passed in by the caller).
function check(text, allow = []) {
  const t = String(text || "");
  const allowed = new Set(allow.map((a) => String(a || "").toLowerCase()).filter(Boolean));
  const hits = [];
  for (const { word, re } of PATTERNS) {
    if (allowed.has(word.toLowerCase())) continue;
    if (re.test(t)) hits.push(word);
  }
  return hits;
}

// Rewrite a text that tripped the check, with the rules file as the brief.
// `rewrite` is an async (text, instructions) => string handed in by the
// caller (agent.runChat behind it) so this file has no model dependency.
async function scrub(text, { allow = [], rewrite } = {}) {
  let hits = check(text, allow);
  if (!hits.length) return { text, hits: [], rewritten: false };
  if (!rewrite) return { text, hits, rewritten: false };
  let out = text;
  try {
    out = await rewrite(text, `Rewrite the text below so it says the same thing without these words: ${hits.join(", ")}. Keep it the same length or shorter, keep every fact, keep the company's own names for its systems, and change nothing else. Follow these rules:\n\n${rules()}\n\nReturn only the rewritten text.`);
    out = String(out || "").trim() || text;
  } catch (e) { return { text, hits, rewritten: false, error: e.message }; }
  const again = check(out, allow);
  return { text: again.length ? text : out, hits: again, rewritten: !again.length, tried: out };
}

module.exports = { check, scrub, rules, BANNED };
