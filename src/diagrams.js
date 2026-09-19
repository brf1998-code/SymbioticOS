// Diagrams: after every deploy, a model draws two sets of Mermaid diagrams for
// the new version (data flows and per-role workflows) following
// principles/DIAGRAMS.md. Stored per company/module/version and shown on the
// diagrams page linked from the improvement board.
const fs = require("fs");
const path = require("path");
const { q, logEvent } = require("./db");
const { runStructured, haveKey, fakeMode, guidanceFor, modelFor, modelInfo } = require("./agent");
const registry = require("./registry");
const { sourceText } = require("./modulesource");

const PRINCIPLES_DIR = process.env.PRINCIPLES_DIR || path.join(__dirname, "..", "principles");
function conventions() {
  const p = path.join(PRINCIPLES_DIR, "DIAGRAMS.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

const SCHEMA = {
  type: "object",
  properties: {
    overview: { type: "string", description: "Two to four sentences: what this module is, who uses it, what it records. For someone who has never seen it." },
    data_flows: {
      type: "array", minItems: 1, maxItems: 4,
      items: { type: "object", properties: {
        title: { type: "string" }, mermaid: { type: "string", description: "One Mermaid diagram, no code fences." }, notes: { type: "string", description: "Two to four plain-language sentences." },
      }, required: ["title", "mermaid", "notes"] },
    },
    workflows: {
      type: "array", minItems: 1, maxItems: 6,
      items: { type: "object", properties: {
        title: { type: "string" }, role: { type: "string", description: "Who does this: the role or screen name." },
        mermaid: { type: "string", description: "One Mermaid diagram, no code fences." }, notes: { type: "string" },
      }, required: ["title", "role", "mermaid", "notes"] },
    },
  },
  required: ["overview", "data_flows", "workflows"],
};

function cleanMermaid(src) {
  let s = String(src || "").trim();
  s = s.replace(/^```(?:mermaid)?\s*/i, "").replace(/```\s*$/, "").trim();
  if (!/^(flowchart|graph|sequenceDiagram|erDiagram|stateDiagram)/.test(s)) s = "flowchart TD\n" + s;
  return s;
}

function fakeDiagrams(mod) {
  return {
    overview: `Fake-mode diagrams for ${mod} (SOS_FAKE_AGENT=1). Canned shapes so the page and the deploy hook can be exercised without an API key.`,
    data_flows: [{ title: "Data flow overview", notes: "Screens on the left write through the server into the module's tables on the right.", mermaid:
`flowchart LR
  subgraph Screens
    S1["Station page"]
    S2["Line board"]
    S3["Stockroom page"]
  end
  SRV[[Server]]
  subgraph Records
    T1[(travelers)]
    T2[(shifts)]
    T3[(material_requests)]
    T4[(inventory)]
  end
  S1 -->|"Done, send on"| SRV --> T1
  S1 -->|"material request"| SRV --> T3
  S2 -->|"start shift"| SRV --> T2
  S3 -->|"deliver"| SRV --> T4` }],
    workflows: [{ title: "Station operator", role: "Station page", notes: "What one operator does with each traveler at their station.", mermaid:
`flowchart TD
  A(["Open station page"]) --> B["See next traveler and instruction"]
  B --> C{"Material at the line?"}
  C -->|no| D["Request material"] --> B
  C -->|yes| E["Do the fold"] --> F["Tap Done"] --> G(["Traveler moves to next station"])` }],
  };
}

async function generate(company, mod, version, opts = {}) {
  const row = await registry.getModule(company, mod);
  if (!row) throw new Error(`unknown module ${company}/${mod}`);
  version = version || row.live_version;
  const existing = (await q("SELECT id FROM platform.diagrams WHERE company=$1 AND module=$2 AND version=$3 AND status='done'", [company, mod, version])).rows[0];
  if (existing && !opts.force) return { skipped: true, version };
  if (!haveKey()) return { skipped: true, reason: "no key" };
  const model = opts.model || await modelFor(company, "propose");
  const ins = await q(
    `INSERT INTO platform.diagrams (company, module, version, model, status) VALUES ($1,$2,$3,$4,'running') RETURNING id`,
    [company, mod, version, model]);
  const id = ins.rows[0].id;
  try {
    let data, costUsd = 0;
    if (fakeMode()) data = fakeDiagrams(mod);
    else {
      const files = (await registry.versionFiles(company, mod, version)) || {};
      const manifest = JSON.parse(files["module.json"] || "{}");
      const screens = registry.pageEntries(manifest).map((s) => `- ${s.label}: ${s.file} (route ${s.route})`).join("\n");
      // every file whole (src/modulesource.js): a data-flow drawing made from half of routes.js misses half the flows
      const srcOut = sourceText(files, { first: ["routes.js"] });
      const src = srcOut.text;
      if (srcOut.cut.length) console.error(`[context] diagrams for ${company}/${mod} v${version}: cut ${srcOut.cut.map((c) => `${c.name} ${c.shown}/${c.of}`).join(", ")}`);
      const guidance = await guidanceFor(company, mod);
      const out = await runStructured({
        model,
        system: `You draw diagrams of a factory software module for people who will never read its code. Follow the conventions exactly.\n\n${conventions()}\n\n---\n\n${guidance.text}`,
        prompt: `Module "${row.title}" (${mod}), version ${version}.\nScreens:\n${screens}\n\nSource:\n${src}\n\nProduce the overview, the data flow set, and one workflow per role.`,
        schema: SCHEMA,
        toolName: "diagrams",
        maxTokens: 16000,
      });
      data = out.data; costUsd = out.costUsd || 0;
    }
    // the model sometimes returns one object instead of an array, or a single
    // string; accept those shapes rather than failing the whole drawing
    const asList = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : typeof v === "string" ? [{ title: "Diagram", mermaid: v }] : []);
    const clean = {
      overview: String(data.overview || ""),
      data_flows: asList(data.data_flows).filter((d) => d && d.mermaid).map((d) => ({ ...d, mermaid: cleanMermaid(d.mermaid) })),
      workflows: asList(data.workflows).filter((d) => d && d.mermaid).map((d) => ({ ...d, mermaid: cleanMermaid(d.mermaid) })),
    };
    await q("UPDATE platform.diagrams SET status='done', content=$2, cost_usd=$3, finished_at=now() WHERE id=$1", [id, JSON.stringify(clean), costUsd]);
    await logEvent("diagrams_generated", `${company}/${mod}`, { version, model, costUsd, data: clean.data_flows.length, workflows: clean.workflows.length });
    return { id, version, model, costUsd };
  } catch (e) {
    await q("UPDATE platform.diagrams SET status='failed', content=$2, finished_at=now() WHERE id=$1", [id, JSON.stringify({ error: String(e.message || e) })]);
    throw e;
  }
}

async function latest(company, mod, version) {
  const params = [company, mod];
  let where = "company=$1 AND module=$2 AND status='done'";
  if (version) { params.push(version); where += " AND version=$3"; }
  const row = (await q(`SELECT * FROM platform.diagrams WHERE ${where} ORDER BY version DESC, id DESC LIMIT 1`, params)).rows[0];
  const versions = (await q("SELECT DISTINCT version FROM platform.diagrams WHERE company=$1 AND module=$2 AND status='done' ORDER BY version DESC", [company, mod])).rows.map((r) => r.version);
  const running = (await q("SELECT version FROM platform.diagrams WHERE company=$1 AND module=$2 AND status='running' ORDER BY id DESC LIMIT 1", [company, mod])).rows[0];
  return { current: row || null, versions, running: running ? running.version : null };
}

module.exports = { generate, latest, conventions, modelInfo };
