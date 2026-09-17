#!/usr/bin/env node
// Replay the cross-check brief against exported cases (docs/CHECKS-CAMPAIGN.md).
//
//   ANTHROPIC_API_KEY=... node scripts/replay-crosscheck.js checks.json [--model claude-fable-5-1] [--only labeled|wrong|fail] [--ids 12,15] [--out replay.json]
//
// checks.json comes from the board: checks log -> "Download the checks log" (or
// labeled cases only). For every case with a before/after the script rebuilds
// the diff exactly the way the pipeline does (diff -ru on two temp trees), runs
// the CURRENT brief in src/pipeline.js through the real API, and prints the
// new verdict next to the old one and the manager's label. Edit the brief,
// run again, compare. No database is touched; the SDK is called directly.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
if (!file) { console.error("usage: node scripts/replay-crosscheck.js checks.json [--model id] [--only labeled|wrong|fail] [--ids 1,2] [--out replay.json]"); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY is needed (the replay calls the API)"); process.exit(1); }

const model = opt("--model", "claude-fable-5-1");
const only = opt("--only", "");
const ids = (opt("--ids", "") || "").split(",").map(Number).filter(Boolean);
const outFile = opt("--out", "");
const { crossCheckCall } = require("../src/pipeline");

function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    if (content == null) continue;
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}
function diffFor(c) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sos-replay-"));
  const from = path.join(base, "versions", String(c.from_version || 0)), to = path.join(base, "versions", String(c.to_version));
  fs.mkdirSync(from, { recursive: true }); fs.mkdirSync(to, { recursive: true });
  writeTree(from, Object.fromEntries(Object.entries(c.files).map(([f, v]) => [f, v.from])));
  writeTree(to, Object.fromEntries(Object.entries(c.files).map(([f, v]) => [f, v.to])));
  let diff = "";
  try { diff = execFileSync("diff", ["-ru", from, to], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }); }
  catch (e) { diff = e.stdout || ""; }
  fs.rmSync(base, { recursive: true, force: true });
  return diff;
}

(async () => {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  let cases = data.cases || [];
  if (ids.length) cases = cases.filter((c) => ids.includes(c.id));
  if (only === "labeled") cases = cases.filter((c) => c.label);
  if (only === "wrong") cases = cases.filter((c) => c.label === "wrong");
  if (only === "fail") cases = cases.filter((c) => c.cross_check && c.cross_check.verdict === "fail");
  cases = cases.filter((c) => c.files && Object.keys(c.files).length && c.requirement);
  console.log(`${cases.length} case(s), model ${model}\n`);
  const results = [];
  let cost = 0, agreeWithLabel = 0, labeled = 0, changed = 0;
  for (const c of cases) {
    const diff = diffFor(c);
    const old = c.cross_check ? c.cross_check.verdict : "(none)";
    let r;
    try {
      r = await crossCheckCall({ model, lane: c.lane, targets: c.targets || [], requirement: c.requirement, diff, fromVersion: c.from_version, toVersion: c.to_version });
    } catch (e) { console.log(`run #${c.id}: ERROR ${e.message}`); continue; }
    cost += r.costUsd || 0;
    const now = r.data.verdict;
    // what the label says the right verdict was: "right" keeps the old verdict, "wrong" flips it
    const expected = c.label === "right" ? old : c.label === "wrong" ? (old === "fail" ? "pass" : "fail") : null;
    if (expected) { labeled++; if (now === expected) agreeWithLabel++; }
    if (now !== old) changed++;
    const blocking = (r.data.findings || []).filter((f) => f.severity === "blocking");
    console.log(`run #${c.id} ${c.lane.padEnd(13)} ${c.module.padEnd(12)} old ${old.padEnd(4)} -> new ${now.padEnd(4)} ${expected ? (now === expected ? "matches label" : "DISAGREES with label") : "(unlabeled)"}${blocking.length ? `\n   blocking: ${blocking.map((f) => `${f.where}: ${f.what}`).join(" | ").slice(0, 300)}` : ""}`);
    results.push({ id: c.id, lane: c.lane, module: c.module, old, now, expected, label: c.label, label_note: c.label_note, summary: r.data.summary, findings: r.data.findings, cost_usd: r.costUsd });
  }
  console.log(`\n${results.length} replayed, ${changed} verdicts changed, ${labeled ? `${agreeWithLabel} of ${labeled} labeled cases match the label (${Math.round(100 * agreeWithLabel / labeled)}%)` : "no labeled cases"}, about $${cost.toFixed(2)}`);
  if (outFile) { fs.writeFileSync(outFile, JSON.stringify({ model, replayed_at: new Date().toISOString(), results }, null, 2)); console.log(`written to ${outFile}`); }
})();
