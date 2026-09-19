// Unit cases for src/modulesource.js: what a model is given of a module's
// source. The point of the file: nothing is cut in silence any more.
// No database: node scripts/test-modulesource.js
const fs = require("fs");
const path = require("path");
const { sourceText, rank, MIN_USEFUL } = require("../src/modulesource");
let pass = 0, fail = 0;
function t(name, cond, detail) { if (cond) { pass++; } else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); } }

// read a library module the way registry.versionFiles hands it over: { relative name: text }
function readModule(name) {
  const root = path.join(__dirname, "..", "modules", name), out = {};
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r); else out[r] = fs.readFileSync(p, "utf8");
    }
  })(root, "");
  return out;
}

// the finding this fixes, on the real library modules
for (const mod of ["kpis", "paperline"]) {
  const files = readModule(mod);
  const out = sourceText(files);
  t(`${mod}: nothing is cut`, out.cut.length === 0, JSON.stringify(out.cut));
  t(`${mod}: routes.js is longer than the old 8,000 cut, so this case means something`, files["routes.js"].length > 8000);
  t(`${mod}: routes.js arrives whole, last line included`, out.text.includes(files["routes.js"]) && out.text.includes(files["routes.js"].trimEnd().split("\n").pop()));
  t(`${mod}: every page arrives whole`, Object.keys(files).filter((n) => n.startsWith("pages/")).every((n) => out.text.includes(files[n])));
  t(`${mod}: every file is there under its own header`, Object.keys(files).every((n) => out.text.includes(`\n--- ${n} ---\n`)));
  t(`${mod}: the character count is the whole module`, out.total === Object.values(files).reduce((s, c) => s + c.length, 0) && out.chars >= out.total);
  t(`${mod}: no note when nothing is cut`, !/^NOTE:/.test(out.text));
}

// order: what a reader needs first
t("the named screen outranks everything", rank("pages/station.html", ["pages/station.html"]) === 0 && rank("pages/station.html", []) > rank("routes.js", []));
t("manifest, server file, screens, docs, the rest", rank("module.json", []) < rank("routes.js", []) && rank("routes.js", []) < rank("pages/a.html", []) && rank("pages/a.html", []) < rank("reference.md", []) && rank("reference.md", []) < rank("migrations/001.sql", []) && rank("migrations/001.sql", []) < rank("tour.json", []) && rank("tour.json", []) < rank("labels/x.zpl", []));
const big = { "tour.json": "t".repeat(3000), "pages/a.html": "a".repeat(5000), "pages/b.html": "b".repeat(5000), "routes.js": "r".repeat(9000), "module.json": "{}" };

// over the budget: the cut lands at the end of the order, is marked where it happens, and is reported
const over = sourceText(big, { first: ["pages/b.html"], budget: 16000 });
t("over budget: the named screen and the server file stay whole", over.text.includes("b".repeat(5000)) && over.text.includes("r".repeat(9000)));
t("over budget: the file that did not fit is cut, the one after it is left out", over.cut.length === 2 && over.cut[0].name === "pages/a.html" && over.cut[0].shown === 16000 - 5000 - 2 - 9000 && over.cut[0].of === 5000 && over.cut[1].name === "tour.json" && over.cut[1].shown === 0, JSON.stringify(over.cut));
t("over budget: the cut is marked in the text where it happens", /\[CUT HERE: the first 1998 of 5000 characters of pages\/a\.html are shown/.test(over.text) && /\[LEFT OUT: tour\.json is 3000 characters/.test(over.text));
t("over budget: a note at the top names the cut files and tells the model not to assume", /^NOTE: this module is larger/.test(over.text) && /pages\/a\.html \(1998 of 5000 characters\)/.test(over.text) && /Do not assume/.test(over.text));
t("over budget: never more source than the budget", over.chars <= 16000 + 5 * 40 + 300);
t("a slice too short to be useful is left out instead", (() => { const o = sourceText({ "routes.js": "r".repeat(1000), "pages/a.html": "a".repeat(5000) }, { budget: 1000 + MIN_USEFUL - 1 }); return o.cut.length === 1 && o.cut[0].shown === 0 && !o.text.includes("aaaa"); })());
t("exactly at the budget nothing is cut", sourceText(big, { budget: 22002 }).cut.length === 0);
t("same rank keeps the module's own file order", (() => { const o = sourceText({ "pages/z.html": "z", "pages/a.html": "a" }); return o.text.indexOf("pages/z.html") < o.text.indexOf("pages/a.html"); })());
t("no files, no crash", sourceText({}).text === "" && sourceText(null).cut.length === 0);
t("a non-text entry is skipped, not printed as [object Object]", !sourceText({ "a.bin": { x: 1 }, "routes.js": "ok" }).text.includes("object"));
t("no dash a participant could end up reading", ![8211, 8212].some((c) => over.text.includes(String.fromCharCode(c))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
