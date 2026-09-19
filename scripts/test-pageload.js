// Unit cases for src/pageload.js, the pure part: which screens get opened, how
// a problem already on the floor is told from a new one, and the no-browser
// syntax check. No database, no browser: node scripts/test-pageload.js
const fs = require("fs");
const path = require("path");
const p = require("../src/pageload");
let pass = 0, fail = 0;
function t(name, cond, detail) { if (cond) { pass++; } else { fail++; console.log(`FAIL  ${name}${detail !== undefined ? "\n      " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); } }

// which screens
const paperline = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "modules", "paperline", "module.json"), "utf8"));
const sp = p.screenPaths(paperline);
t("every screen of the manifest is opened once", sp.length === 4 && sp.map((s) => s.path).join() === "/,/station,/station/1,/stock", sp.map((s) => s.path));
t("a route with a parameter takes its value from the smoke list", sp.find((s) => s.route === "/station/:seq").path === "/station/1");
t("with no smoke path that fits, the parameter becomes 1", p.screenPaths({ pages: { "/bed/:id/chart/:day": "pages/chart.html" } })[0].path === "/bed/1/chart/1");
t("the label and the file ride along", sp[0].label === "Line board (manager view)" && sp[0].file === "pages/board.html");
t("two routes landing on one path open once", p.screenPaths({ pages: { "/a/:x": "pages/a.html", "/a/1": "pages/a.html" } }).length === 1);
t("no pages, nothing to open", p.screenPaths({}).length === 0);

// already on the floor, or new
const A = { kind: "script", screen: "Line board", what: "a script error on the screen: x is not defined at http://127.0.0.1:3999/c/demo/staging/m/paperline/:214:7" };
const Afloor = { kind: "script", screen: "Line board", what: "a script error on the screen: x is not defined at http://127.0.0.1:3999/c/demo/m/paperline/:209:3" };
const B = { kind: "script", screen: "Stockroom page", what: "a script error on the screen: y is not a function" };
t("the same error on the floor is not held against the build, whatever the mount and the line number", (() => { const r = p.againstFloor([A, B], [Afloor]); return r.fresh.length === 1 && r.fresh[0] === B && r.inherited.length === 1; })());
t("the same words on another screen are a new problem", p.againstFloor([{ ...A, screen: "Stockroom page" }], [Afloor]).fresh.length === 1);
t("nothing on the floor, everything is new", p.againstFloor([A, B], []).fresh.length === 2 && p.againstFloor([A], null).fresh.length === 1);
t("version numbers and timestamps do not make an old problem look new", p.normalize("failed at v12 on 2026-09-19T14:03:22.120Z") === p.normalize("failed at v9 on 2026-09-18T01:00:00.000Z"));

// the no-browser syntax check
const page = (js, attrs = "") => `<html><body><h1>x</h1><script${attrs}>${js}</script></body></html>`;
t("a script that parses is fine", p.syntaxProblems(page("const a = 1; function f() { return a; }")).length === 0);
t("an unbalanced brace is caught, with the line", (() => { const r = p.syntaxProblems(page("function f() {\n  if (x) {\n    return 1;\n}")); return r.length === 1 && /does not parse/.test(r[0].what); })());
t("a second broken script is reported as its own", p.syntaxProblems(page("let a = ;") + page("let b = ;")).length === 2);
t("scripts loaded by src, data blocks and templates are left alone", p.syntaxProblems(page("", ' src="/assets/x.js"')).length === 0 && p.syntaxProblems(page("{ not: js ", ' type="application/json"')).length === 0 && p.syntaxProblems(page("<div>{{x}}</div>", ' type="text/template"')).length === 0);
t("a module script is left to the browser", p.syntaxProblems(page("import x from './y.js'; let a = ;", ' type="module"')).length === 0);
t("code that parses but would throw when run is NOT caught here (that is what the browser is for)", p.syntaxProblems(page("callSomethingThatIsNotThere();")).length === 0);
t("the library modules' pages all parse", ["paperline", "kpis"].every((m) => fs.readdirSync(path.join(__dirname, "..", "modules", m, "pages")).every((f) => p.syntaxProblems(fs.readFileSync(path.join(__dirname, "..", "modules", m, "pages", f), "utf8")).length === 0)));
t("no html, no crash", p.syntaxProblems(undefined).length === 0 && p.syntaxProblems("").length === 0);

// wording
const look = { problems: [{ kind: "script", screen: "Stockroom page", path: "/stock", what: "a script error on the screen: y is not a function" }, { kind: "call", screen: "Line board", path: "/", what: "the screen's own call to /api/state answered 500" }] };
t("one line for the card names the screen first", /^Stockroom page: a script error on the screen: y is not a function \(and 1 more\)$/.test(p.oneLine(look)), p.oneLine(look));
t("the agent gets the screen, its path and what a person would hit", /"Stockroom page" screen \(\/stock\)/.test(p.forAgent(look)) && /A person opening that screen would hit this/.test(p.forAgent(look)) && /the server failed/.test(p.forAgent(look)));
t("SOS_BROWSER=off means no browser, whatever is installed", (() => { const was = process.env.SOS_BROWSER; process.env.SOS_BROWSER = "off"; p.resetCache(); const r = p.browserPath(); if (was === undefined) delete process.env.SOS_BROWSER; else process.env.SOS_BROWSER = was; p.resetCache(); return r === null; })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
