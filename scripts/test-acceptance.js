// Unit cases for src/acceptance.js, the pure part: the check file format, the
// matcher, carrying values between steps, and the wording for the card and
// the agent. No database, no server: node scripts/test-acceptance.js
const fs = require("fs");
const path = require("path");
const a = require("../src/acceptance");
let pass = 0, fail = 0;
function t(name, cond, detail) { if (cond) { pass++; } else { fail++; console.log(`FAIL  ${name}${detail !== undefined ? "\n      " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); } }
const good = { title: "A material request can ask for more than one sheet", steps: [
  { call: "POST /api/requests", as: "floor", body: { item: "paper_white", qty: 3 }, expect: { json: { id: { $type: "number" }, qty: 3 } }, save: { id: "id" } },
  { call: "GET /api/stock", expect: { json: { requests: { $contains: { id: "{id}", qty: 3 } } } } },
  { page: "/stock", expect: { status: 200, visible: ["3 sheets"], selector: ["#requests"] } } ] };
const P = (obj, name = "checks/004-request-quantity.json") => a.parse(name, JSON.stringify(obj));
const bad = (obj, re, name) => { const r = P(obj, name); return !r.ok && r.problems.some((p) => re.test(p)); };

// the format
t("a well formed check reads", P(good).ok, P(good).problems);
t("the library modules' own checks all read", ["paperline", "kpis"].every((m) => fs.readdirSync(path.join(__dirname, "..", "modules", m, "checks")).every((f) => a.parse(`checks/${f}`, fs.readFileSync(path.join(__dirname, "..", "modules", m, "checks", f), "utf8")).ok)));
t("the name is NNN-words.json", bad(good, /the name is checks\/NNN/, "checks/request.json") && bad(good, /the name/, "checks/04-x.json") && bad(good, /the name/, "checks/004-Request.json") && P(good, "checks/120-a-b-c.json").ok);
t("not JSON is said plainly", !a.parse("checks/001-x.json", "{ title: nope").ok && /does not parse as JSON/.test(a.parse("checks/001-x.json", "{ title: nope").problems.join()));
t("a title is one plain sentence", bad({ ...good, title: "short" }, /title/) && bad({ ...good, title: "x".repeat(200) }, /title/) && bad({ ...good, title: "Requests \u2014 now with a quantity" }, /long dashes/));
t("1 to 12 steps", bad({ ...good, steps: [] }, /1 to 12/) && bad({ ...good, steps: Array(13).fill(good.steps[1]) }, /1 to 12/));
t("a step is a call or a page, never both or neither", bad({ ...good, steps: [{ expect: {} }] }, /exactly one of/) && bad({ ...good, steps: [{ call: "GET /a", page: "/a" }] }, /exactly one of/));
t("a call is METHOD /path with a known method", bad({ ...good, steps: [{ call: "FETCH /api/x" }] }, /METHOD \/path/) && bad({ ...good, steps: [{ call: "get /api/x" }] }, /METHOD \/path/) && bad({ ...good, steps: [{ call: "GET" }] }, /METHOD \/path/));
for (const p of ["/../../api/admin/backup", "/a/%2e%2e/b", "//evil.example/x", "http://evil.example/x", "/a\\b", "api/x", "/x y"])
  t(`a path may not leave the module: ${p}`, bad({ ...good, steps: [{ call: `GET ${p}` }] }, /path|METHOD/) && (p.includes(" ") || a.pathProblem(p) !== null), a.pathProblem(p));
t("a page path is held to the same rule", bad({ ...good, steps: [{ page: "/../admin" }] }, /climb out/));
t("a plain path with a query and a placeholder is fine", a.pathProblem("/api/items/{id}/move?x=1") === null && a.pathProblem("/") === null);
t("a GET carries no body; a page has no body and saves nothing", bad({ ...good, steps: [{ call: "GET /a", body: {} }] }, /GET carries no body/) && bad({ ...good, steps: [{ page: "/a", save: { x: "y" } }] }, /page step/));
t("as is manager or floor", bad({ ...good, steps: [{ call: "GET /a", as: "admin" }] }, /manager.*floor/));
t("expect knows its own words per kind of step", bad({ ...good, steps: [{ call: "GET /a", expect: { visible: ["x"] } }] }, /expect on a call/) && bad({ ...good, steps: [{ page: "/a", expect: { json: {} } }] }, /expect on a page/));
t("status is a number or a list of them", bad({ ...good, steps: [{ call: "GET /a", expect: { status: "200" } }] }, /status/) && P({ ...good, steps: [{ call: "GET /a", expect: { status: [401, 403] } }] }).ok);
t("an unknown $ rule is refused by name, and rules do not mix with fields", bad({ ...good, steps: [{ call: "GET /a", expect: { json: { n: { $around: 3 } } } }] }, /\$around/) && bad({ ...good, steps: [{ call: "GET /a", expect: { json: { n: { $gte: 1, other: 2 } } } }] }, /mixes/));
t("a $regex that does not parse is refused", bad({ ...good, steps: [{ call: "GET /a", expect: { json: { n: { $regex: "(" } } } }] }, /\$regex does not parse/));
t("a {name} nobody saved is caught before it goes out as text", bad({ ...good, steps: [{ call: "GET /api/items/{id}" }] }, /uses \{id\} before/) && bad({ ...good, steps: [good.steps[1]] }, /uses \{id\} before/));
t("an unknown key on a step is named", bad({ ...good, steps: [{ call: "GET /a", expects: {} }] }, /does not know "expects"/));
t("collect sorts by name and keeps unreadable ones apart", (() => { const c = a.collect({ "checks/002-b.json": JSON.stringify({ ...good, steps: [good.steps[0]] }), "checks/001-a.json": "nope", "routes.js": "x", "checks/003-c-d.json": JSON.stringify({ title: "The third thing still holds", steps: [{ call: "GET /a" }] }) }); return c.checks.map((x) => x.file).join() === "checks/002-b.json,checks/003-c-d.json" && c.invalid.length === 1 && c.invalid[0].file === "checks/001-a.json"; })());
t("writes: a check with anything but GETs changes rows", a.writes(P(good).check) === true && a.writes(P({ title: "Reading only, nothing written", steps: [{ call: "GET /a" }, { page: "/" }] }, "checks/001-r.json").check) === false);

// the matcher
const m = (act, exp) => a.match(act, exp);
t("a subset matches: extra keys are ignored", m({ id: 4, qty: 3, note: "x" }, { qty: 3 }).length === 0);
t("a wrong value is said in plain words with both sides", /^qty is 2, expected 3$/.test(m({ qty: 2 }, { qty: 3 })[0]), m({ qty: 2 }, { qty: 3 }));
t("a missing key is said as missing", /^qty is missing, expected 3$/.test(m({}, { qty: 3 })[0]));
t("nested objects name the path", /^request\.station\.seq is 2, expected 1$/.test(m({ request: { station: { seq: 2 } } }, { request: { station: { seq: 1 } } })[0]));
t("$type tells a list from an object from null", !m([], { $type: "array" }).length && !m(null, { $type: "null" }).length && m({}, { $type: "array" }).length === 1 && m("3", { $type: "number" }).length === 1);
t("$gte $lte $gt $lt", !m(5, { $gte: 5, $lte: 5 }).length && m(5, { $gt: 5 }).length === 1 && m(5, { $lt: 5 }).length === 1);
t("$in, $regex, $not", !m("open", { $in: ["open", "delivered"] }).length && m("lost", { $in: ["open"] }).length === 1 && !m("A-12", { $regex: "^[A-Z]-\\d+$" }).length && m("a12", { $regex: "^[A-Z]" }).length === 1 && m("open", { $not: "open" }).length === 1 && !m("open", { $not: "closed" }).length);
t("$exists both ways", !m({ a: 1 }, { a: { $exists: true }, b: { $exists: false } }).length && m({ a: 1 }, { a: { $exists: false } }).length === 1 && m({}, { b: { $exists: true } }).length === 1);
t("$length and $minLength", !m([1, 2], { $length: 2 }).length && m([1], { $minLength: 2 }).length === 1 && /has 1 entries, expected at least 2/.test(m([1], { $minLength: 2 })[0]));
t("$contains: some entry matches the subset", !m([{ id: 1 }, { id: 7, qty: 3 }], { $contains: { id: 7, qty: 3 } }).length && /none of them matches/.test(m([{ id: 1 }], { $contains: { id: 7 } })[0]) && /is not a list/.test(m({ id: 7 }, { $contains: { id: 7 } })[0]));
t("$every: all entries match, the first miss is named", !m([{ s: "a" }, { s: "b" }], { $every: { s: { $type: "string" } } }).length && /\[1\]/.test(m([{ s: "a" }, { s: 2 }], { $every: { s: { $type: "string" } } })[0]));
t("a list written out matches entry for entry", !m(["a", "b"], ["a", "b"]).length && /has 1 entries, expected 2/.test(m(["a"], ["a", "b"])[0]) && m(["a", "c"], ["a", "b"]).length === 1);
t("a rule on a missing value says missing once, not five things", m(undefined, { $type: "number", $gte: 1 }).length === 1);
t("no more than six lines for one answer", m({}, Object.fromEntries("abcdefghij".split("").map((k) => [k, 1]))).length === 6);
t("no dash in what a manager could read", ![8211, 8212].some((c) => m({ qty: 2 }, { qty: 3 }).join().includes(String.fromCharCode(c))));

// carrying values
t("{id} alone keeps the saved value's type, inside text it is text", a.fill("{id}", { id: 7 }) === 7 && a.fill("/api/items/{id}/move", { id: 7 }) === "/api/items/7/move" && JSON.stringify(a.fill({ a: ["{id}", { b: "x{id}" }] }, { id: 7 })) === '{"a":[7,{"b":"x7"}]}');
t("a name nobody saved is left as written", a.fill("{nope}", {}) === "{nope}");
t("pick walks objects and lists, from the end too", a.pick({ r: { items: [{ id: 1 }, { id: 9 }] } }, "r.items.1.id") === 9 && a.pick({ items: [1, 2, 3] }, "items.-1") === 3 && a.pick({}, "a.b") === undefined);
t("status: any 2xx by default, else what was asked", a.statusProblem(204, undefined) === null && /expected a 2xx/.test(a.statusProblem(404, undefined)) && a.statusProblem(403, [401, 403]) === null && /expected 400/.test(a.statusProblem(200, 400)) && /answered nothing/.test(a.statusProblem(0, 200)));

// the wording
const failedOld = { file: "checks/002-a.json", title: "The stockroom sees every request", new: false, steps: [{ n: 2, step: "GET /api/stock", as: "manager", ok: false, problems: ["requests has 0 entries and none of them matches {\"id\":5}"] }] };
const failedNew = { ...failedOld, file: "checks/009-mine.json", title: "A request can carry a quantity", new: true };
t("an old promise comes first on the card's line", /breaks something an earlier change promised: "The stockroom sees every request"/.test(a.oneLine({ failed: [failedNew, failedOld], invalid: [] })));
t("its own check failing says so with the step", /check that came with this change does not pass: "A request can carry a quantity" \(GET \/api\/stock:/.test(a.oneLine({ failed: [failedNew], invalid: [] })));
const forAgent = a.forAgent({ failed: [failedOld, failedNew], invalid: [{ file: "checks/010-x.json", problems: ["title: ..."] }] });
t("the agent is told never to touch an older check, and that it may edit its own", /checks\/002-a\.json.*do NOT edit or remove it/s.test(forAgent) && /checks\/009-mine\.json.*You may edit checks\/009-mine\.json/s.test(forAgent) && /Step 2 \(GET \/api\/stock, as manager\)/.test(forAgent) && /checks\/010-x\.json is not a readable check/.test(forAgent), forAgent);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
