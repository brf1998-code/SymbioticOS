// Unit cases for src/datacheck.js, the pure part: the platform's own check of
// what the proposal model says a change needs from the ERP. No database:
// node scripts/test-datacheck.js
const d = require("../src/datacheck");
let pass = 0, fail = 0;
function t(name, cond, detail) { if (cond) { pass++; } else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); } }
const j = (x) => JSON.stringify(x);
const lookups = { jobs: { defined: true, fields: new Set(["job_num", "req_due_date"]) }, stock: { defined: false, fields: new Set(["on_hand"]) } };

t("nothing needed is status none", d.verify([], lookups).status === "none" && d.verify(null, lookups).status === "none" && d.verify(undefined, lookups).status === "none");
t("a named field the lookup gives is available", j(d.verify([{ what: "the due date", lookup: "jobs", field: "req_due_date" }], lookups)) === j({ status: "ok", needs: [{ what: "the due date", lookup: "jobs", field: "req_due_date", available: true }], missing: [] }));
t("an empty field is missing", d.verify([{ what: "who ran it", lookup: "jobs", field: "" }], lookups).status === "waiting");
t("a field the model invented is missing: the platform decides, not the model", d.verify([{ what: "the customer", lookup: "jobs", field: "customer_name", available: true }], lookups).missing.length === 1);
t("a lookup that is not defined on the platform yet gives nothing", d.verify([{ what: "on hand", lookup: "stock", field: "on_hand" }], lookups).status === "waiting");
t("an unknown lookup is missing and carries no lookup name", j(d.verify([{ what: "x", lookup: "nope", field: "y" }], lookups).missing) === j([{ what: "x", lookup: null }]));
const mixed = d.verify([{ what: "a", lookup: "jobs", field: "job_num" }, { what: "b", lookup: "jobs", field: "zz" }, { what: "  ", lookup: "jobs", field: "job_num" }], lookups);
t("one missing need makes the whole change wait; blank needs are dropped", mixed.status === "waiting" && mixed.needs.length === 2 && mixed.missing.length === 1 && mixed.missing[0].what === "b", j(mixed));
t("long words are clipped", d.verify([{ what: "x".repeat(500), lookup: "jobs", field: "job_num" }], lookups).needs[0].what.length === 200);
const s = d.schemaFor(["jobs", "stock"]);
t("the question put to the model lists the lookups and forbids inventing fields", s.items.properties.lookup.enum.join(",") === "jobs,stock" && /Never invent a field name/.test(s.description) && s.items.required.join(",") === "what,lookup,field");
t("with no lookups the enum is still valid", d.schemaFor([]).items.properties.lookup.enum.length === 1);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
