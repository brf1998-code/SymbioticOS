// Unit cases for src/modulegate.js. No database, no tokens: node scripts/test-modulegate.js
const fs = require("fs");
const path = require("path");
const gate = require("../src/modulegate");

let pass = 0, fail = 0;
function t(name, cond, detail) { if (cond) { pass++; } else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); } }
const rules = (v) => v.violations.map((f) => f.rule);
const has = (v, rule) => rules(v).includes(rule);
const base = { "module.json": JSON.stringify({ name: "m", title: "M", entry: "routes.js", pages: { "/": { file: "pages/board.html", label: "Board" } }, smoke: ["/api/items"] }), "pages/board.html": "<html><body><div id=board></div><script>fetch('x')</script></body></html>", "tour.json": "{}", "migrations/001.sql": "CREATE TABLE items (id SERIAL PRIMARY KEY);\n" };
const mod = (routes, extra = {}) => ({ ...base, "routes.js": routes, ...extra });
const wrap = (body) => `module.exports = function makeRouter(ctx) {\n  const { express, db } = ctx;\n  const router = express.Router();\n${body}\n  return router;\n};\n`;
const readTree = (dir, rel = "", out = {}) => { for (const n of fs.readdirSync(path.join(dir, rel))) { const r = rel ? `${rel}/${n}` : n; if (fs.statSync(path.join(dir, r)).isDirectory()) readTree(dir, r, out); else out[r] = fs.readFileSync(path.join(dir, r), "utf8"); } return out; };

// 1. the repo's own modules pass untouched
for (const m of fs.readdirSync(path.join(__dirname, "..", "modules"))) {
  const v = gate.check({ files: readTree(path.join(__dirname, "..", "modules", m)) });
  t(`library module ${m} passes`, v.ok, JSON.stringify(v.violations));
}
// 2. the skeleton the platform writes for a new module passes
try {
  const mb = require("../src/modulebuild");
  const files = mb.skeleton({ slug: "tool-crib", title: "Tool Crib", design: { screens: [], reference_md: "" }, answers: {}, startingRows: [] });
  const v = gate.check({ files, lane: "module" });
  t("module skeleton passes", v.ok, JSON.stringify(v.violations));
} catch (e) { t("module skeleton loads", false, e.message); }

// 3. the probe from the 2026-09-18 review
{ const v = gate.check({ files: mod(`const seen = { db: process.env.DATABASE_URL };\nrequire("fs").writeFileSync(__dirname + "/leak.json", JSON.stringify(seen));\n` + wrap("")) });
  t("probe: process refused", has(v, "name-process")); t("probe: require fs refused", has(v, "require-outside")); }

// 4. words that look like trouble and are not
{ const v = gate.check({ files: mod(wrap(`  // the process step, the global view, module notes, require a scan, import the list
  const row = { process: "cutting", global: true, import: 1 };
  const label = "the process is done, fetch the next one; eval later";
  const t2 = \`module \${row.process} of \${[1, 2].map((w) => \`\${w} process\`).join(", ")}\`;
  router.get("/api/items", async (req, res) => res.json({ p: row.process, g: req.body?.global, label, t2 }));`)) });
  t("property names, keys, strings, comments and templates are fine", v.ok, JSON.stringify(v.violations)); }

// 5. a bare name inside a ternary is a use
t("ternary use refused", has(gate.check({ files: mod(wrap(`  const x = true ? process : null;`)) }), "name-process"));

// 6. require rules
t("relative require of a module file is fine", gate.check({ files: mod(`const h = require("./lib/helpers");\n` + wrap(""), { "lib/helpers.js": "module.exports = { a: 1 };\n" }) }).ok);
t("require of a missing file refused", has(gate.check({ files: mod(`const h = require("./lib/helpers");\n` + wrap("")) }), "require-missing"));
t("require going up refused", has(gate.check({ files: mod(`const h = require("./../../src/db");\n` + wrap("")) }), "require-outside"));
t("require of a package refused", has(gate.check({ files: mod(`const pg = require("pg");\n` + wrap("")) }), "require-outside"));
t("require of a variable refused", has(gate.check({ files: mod(`const n = "p" + "g"; const pg = require(n);\n` + wrap("")) }), "require-outside"));
t("require of an html file refused", has(gate.check({ files: mod(`require("./pages/board.html");\n` + wrap("")) }), "require-missing"));
t("require.cache refused", has(gate.check({ files: mod(`const c = require.cache;\n` + wrap("")) }), "require-outside"));
t("module.constructor refused", has(gate.check({ files: mod(`const c = module.constructor;\n` + wrap("")) }), "name-module"));
t("a helper file is held to the same rules", has(gate.check({ files: mod(`const h = require("./lib/h.js");\n` + wrap(""), { "lib/h.js": "module.exports = () => process.env;\n" }) }), "name-process"));

// 7. network, file serving, internals
t("fetch refused", has(gate.check({ files: mod(wrap(`  router.get("/x", async (q, s) => s.json(await (await fetch("https://example.com")).json()));`)) }), "name-fetch"));
t("sendFile refused", has(gate.check({ files: mod(wrap(`  router.get("/x", (q, s) => s.sendFile("/etc/passwd"));`)) }), "call-sendFile"));
t("express.static refused", has(gate.check({ files: mod(wrap(`  router.use(express.static("/"));`)) }), "call-static"));
t(".constructor refused", has(gate.check({ files: mod(wrap(`  const F = (() => {}).constructor;`)) }), "call-constructor"));
t('"constructor" by name refused', has(gate.check({ files: mod(wrap(`  const F = (() => {})["constructor"];`)) }), "name-internals"));
t("dynamic import refused", has(gate.check({ files: mod(wrap(`  const m = await import("fs");`)) }), "name-import"));
t("eval refused", has(gate.check({ files: mod(wrap(`  eval("1");`)) }), "name-eval"));
t("new Function refused", has(gate.check({ files: mod(wrap(`  const f = new Function("return 1");`)) }), "name-Function"));
t("globalThis refused", has(gate.check({ files: mod(wrap(`  const g = globalThis["pro" + "cess"];`)) }), "name-globalThis"));

// 8. SQL
const sql = (q) => gate.check({ files: mod(wrap(`  router.get("/x", async (r, s) => s.json((await db(${JSON.stringify(q)})).rows));`)) });
t("platform tables refused", has(sql("SELECT * FROM platform.companies"), "sql-platform"));
t("another module's schema refused", has(sql("SELECT * FROM mod_demo_paperline.shifts"), "sql-other-module"));
t("run-time CREATE TABLE refused", has(sql("CREATE TABLE IF NOT EXISTS notes (id serial)"), "sql-ddl"));
t("run-time ALTER TABLE refused", has(sql("ALTER TABLE items ADD COLUMN x int"), "sql-ddl"));
t("run-time DROP TABLE refused", has(sql("DROP TABLE items"), "sql-ddl"));
t("COPY FROM PROGRAM refused", has(sql("COPY items FROM PROGRAM 'curl http://x'"), "sql-copy"));
t("search_path refused", has(sql("SET search_path TO platform"), "sql-scope"));
t("pg_read_file refused", has(sql("SELECT pg_read_file('/etc/passwd')"), "sql-server"));
for (const ok of ["UPDATE items SET updated_at = now(), stage = $1 WHERE id = $2", "DELETE FROM items WHERE id = $1", "INSERT INTO items (name) VALUES ($1) RETURNING *", "SELECT count(*) FROM items WHERE created_at > now() - interval '7 days'", "Drop the pallet at dock 4", "Copy the link to your phone", "We grant access to the lead only", "Create the table of contents first", "That platform is full. Pick another.", "SELECT * FROM model_runs m WHERE m.id = $1"])
  t(`fine: ${ok.slice(0, 40)}`, sql(ok).ok, JSON.stringify(sql(ok).violations));

// 9. the scanner: regex literals, divisions, escapes
{ const v = gate.check({ files: mod(wrap(`  const re = /["'\`]/g; const half = 10 / 2 / 1; const s = "a \\"quoted\\" word"; const bad = process.env;`)) });
  t("code after a regex with quotes is still read", has(v, "name-process"), JSON.stringify(v.violations));
  t("and nothing else is invented", v.violations.length === 1, JSON.stringify(v.violations)); }
t("a regex with quotes alone is fine", gate.check({ files: mod(wrap(`  const clean = (x) => String(x).replace(/['"]/g, "").split(/\\s+/).filter(Boolean);`)) }).ok);
t("an unclosed string is refused, not guessed at", has(gate.check({ files: mod(`const s = "never closed;\n` + wrap("")) }), "unreadable"));
t("an unclosed comment is refused", has(gate.check({ files: mod(`/* never closed\n` + wrap("")) }), "unreadable"));

// 10. lanes
const from = mod(wrap(`  router.get("/api/items", async (r, s) => s.json([]));`));
{ const to = { ...from, "pages/board.html": from["pages/board.html"].replace("board", "board2"), "tour.json": '{"steps":[]}' };
  t("ui lane: pages and tour may change", gate.check({ files: to, fromFiles: from, lane: "ui" }).ok); }
{ const to = { ...from, "routes.js": from["routes.js"] + "// touched\n" };
  t("ui lane: routes.js changed is refused", has(gate.check({ files: to, fromFiles: from, lane: "ui" }), "lane-ui-file"));
  t("functionality lane: routes.js may change", gate.check({ files: to, fromFiles: from, lane: "functionality" }).ok); }
{ const m = JSON.parse(from["module.json"]); m.pages["/"].label = "Crib board"; m.title = "Crib";
  t("ui lane: a label change in module.json is fine", gate.check({ files: { ...from, "module.json": JSON.stringify(m, null, 2) }, fromFiles: from, lane: "ui" }).ok);
  m.smoke.push("/api/other");
  t("ui lane: the smoke list changed is refused", has(gate.check({ files: { ...from, "module.json": JSON.stringify(m) }, fromFiles: from, lane: "ui" }), "lane-ui-file")); }
t("ui lane: a new migration is refused", has(gate.check({ files: { ...from, "migrations/002.sql": "ALTER TABLE items ADD COLUMN n TEXT;\n" }, fromFiles: from, lane: "ui" }), "lane-ui-file"));
t("functionality lane: a new migration is fine", gate.check({ files: { ...from, "migrations/002.sql": "ALTER TABLE items ADD COLUMN n TEXT;\n" }, fromFiles: from, lane: "functionality" }).ok);
t("any lane: an existing migration edited is refused", has(gate.check({ files: { ...from, "migrations/001.sql": "CREATE TABLE items (id SERIAL PRIMARY KEY, n TEXT);\n" }, fromFiles: from, lane: "functionality" }), "lane-migration-edited"));
{ const to = { ...from }; delete to["migrations/001.sql"];
  t("any lane: an existing migration removed is refused", has(gate.check({ files: to, fromFiles: from, lane: "functionality" }), "lane-migration-edited")); }

// 11. inherited findings do not stop a build, new ones do
{ const old = mod(`const legacy = process.env.TZ;\n` + wrap(""));
  const same = { ...old, "pages/board.html": old["pages/board.html"] + "<!-- x -->" };
  const v1 = gate.check({ files: same, fromFiles: old, lane: "ui" });
  t("an inherited finding is reported, not blocking", v1.ok && v1.inherited.length === 1, JSON.stringify(v1));
  const worse = { ...old, "routes.js": old["routes.js"] + `const more = process.env.DATABASE_URL;\n` };
  const v2 = gate.check({ files: worse, fromFiles: old, lane: "functionality" });
  t("a new finding beside an inherited one still stops it", !v2.ok && v2.violations.length === 1 && v2.inherited.length === 1, JSON.stringify(v2)); }

// 12. layout
t("package.json refused", has(gate.check({ files: mod(wrap(""), { "package.json": '{"type":"module"}' }) }), "layout-package"));
t("node_modules refused", has(gate.check({ files: mod(wrap(""), { "node_modules/x/index.js": "module.exports = 1;" }) }), "layout-node-modules"));
t("native file refused", has(gate.check({ files: mod(wrap(""), { "lib/x.node": "" }) }), "layout-file-kind"));
{ const m = JSON.parse(base["module.json"]); m.entry = "../../src/db.js";
  t("entry outside the module refused", has(gate.check({ files: mod(wrap(""), { "module.json": JSON.stringify(m) }) }), "layout-entry")); }

// 13. checkDir: links are refused
{ const os = require("os"); const d = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  for (const [r, c] of Object.entries(mod(wrap("")))) { fs.mkdirSync(path.dirname(path.join(d, r)), { recursive: true }); fs.writeFileSync(path.join(d, r), c); }
  t("checkDir: a clean directory passes", gate.checkDir(d, { lane: "module" }).ok);
  fs.symlinkSync("/etc", path.join(d, "etc"));
  t("checkDir: a link is refused", has(gate.checkDir(d, { lane: "module" }), "layout-link"));
  fs.rmSync(d, { recursive: true, force: true }); }

// 13b. the fix round: the platform puts lane-protected files back, and says so
{ const os = require("os"); const d = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  const to = { ...from, "routes.js": from["routes.js"] + "// touched\n", "migrations/002.sql": "ALTER TABLE items ADD COLUMN n TEXT;\n" };
  for (const [r, c] of Object.entries(to)) { fs.mkdirSync(path.dirname(path.join(d, r)), { recursive: true }); fs.writeFileSync(path.join(d, r), c); }
  const v = gate.checkDir(d, { fromFiles: from, lane: "ui" });
  const restored = gate.restoreLaneFiles(d, from, gate.record(v));
  t("fix round: routes.js is put back and the added migration removed", restored.length === 2 && fs.readFileSync(path.join(d, "routes.js"), "utf8") === from["routes.js"] && !fs.existsSync(path.join(d, "migrations/002.sql")), JSON.stringify(restored));
  t("fix round: the draft now passes", gate.checkDir(d, { fromFiles: from, lane: "ui" }).ok);
  const text = gate.forAgent(gate.record(v), restored);
  t("fix round: the agent is told what was put back and what to do", /put these files back/.test(text) && /pages\/ only/.test(text), text);
  t("restore never writes outside the draft", gate.restoreLaneFiles(d, { "../x": "y" }, { violations: [{ rule: "lane-ui-file", file: "../x" }] }).length === 0);
  fs.rmSync(d, { recursive: true, force: true }); }
{ const v = gate.check({ files: mod(`const k = process.env.X;\n` + wrap("")), lane: "functionality", fromFiles: from });
  const text = gate.forAgent(gate.record(v), []);
  t("fix round: a code finding quotes the line for the agent", /Fix exactly these/.test(text) && /process\.env\.X/.test(text), text); }

// 13c. pages, and headers
const page = (html) => gate.check({ files: { ...mod(wrap("")), "pages/board.html": `<html><body><div id="board"></div>${html}</body></html>` } });
t("page naming the platform's controls refused", has(page(`<script>fetch("/api/proposals/4/decide", { method: "POST" })</script>`), "page-platform"));
t("page naming a company API refused", has(page(`<script>fetch("/api/c/demo/board")</script>`), "page-platform"));
t("page calling its own API is fine", page(`<script>const base = location.pathname.match(/^.*?\\/(?:staging\\/)?m\\/[^/]+/)[0]; fetch(base + "/api/runs").then(r => r.json()); fetch(base + "/api/items/4/move", { method: "POST" });</script>`).ok, JSON.stringify(page(`<script>fetch(base + "/api/runs")</script>`).violations));
t("page opening a popup refused", has(page(`<script>window.open("/c/demo/")</script>`), "page-popup"));
t("page with target _blank refused", has(page(`<a href="/x" target="_blank">x</a>`), "page-popup"));
t("page with an iframe refused", has(page(`<iframe src="/c/demo/"></iframe>`), "page-frame"));
t("page registering a service worker refused", has(page(`<script>navigator.serviceWorker.register("sw.js")</script>`), "page-worker"));
t("page loading an outside script refused", has(page(`<script src="https://cdn.example.com/x.js"></script>`), "page-external"));
t("page with an inline data image and a plain link is fine", page(`<img src="data:image/png;base64,AAAA"><a href="https://example.com/help">help</a>`).ok);
t("module code setting the page policy refused", has(gate.check({ files: mod(wrap(`  router.use((q, s, n) => { s.set("Content-Security-Policy", "default-src *"); n(); });`)) }), "header-policy"));
t("module code widening a service worker refused", has(gate.check({ files: mod(wrap(`  router.get("/sw.js", (q, s) => s.set("Service-Worker-Allowed", "/").type("js").send(""));`)) }), "header-policy"));
t("removeHeader refused", has(gate.check({ files: mod(wrap(`  router.use((q, s, n) => { s.removeHeader("X-Anything"); n(); });`)) }), "call-removeHeader"));
t("ordinary headers are fine", gate.check({ files: mod(wrap(`  router.get("/x.csv", (q, s) => s.set("Content-Disposition", "attachment; filename=x.csv").type("csv").send("a,b"));`)) }).ok);
{ const old = { ...from, "pages/board.html": from["pages/board.html"] + `<a href="/x" target="_blank">old</a>` };
  const v = gate.check({ files: { ...old, "tour.json": '{"steps":[1]}' }, fromFiles: old, lane: "ui" });
  t("an inherited page finding is reported, not blocking", v.ok && v.inherited.some((f) => f.rule === "page-popup"), JSON.stringify(v)); }

// 14. wording
{ const v = gate.check({ files: mod(`const k = process.env.ANTHROPIC_API_KEY;\n` + wrap("")) });
  const text = gate.summarize(v);
  t("summary names the file, the line and the reason", /routes\.js, line 1/.test(text) && /settings and passwords/.test(text), text);
  const ui = gate.summarize(gate.check({ files: { ...from, "routes.js": from["routes.js"] + "//x\n" }, fromFiles: from, lane: "ui" }));
  t("a lane finding names the file once", (ui.match(/routes\.js/g) || []).length === 1, ui);
  t("no dashes in anything a manager reads", !/[–—]/.test(text)); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
