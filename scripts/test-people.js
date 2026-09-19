// Unit cases for src/people.js, the part with no database: names, PINs and the
// signed person cookie. node scripts/test-people.js
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "unit-test-secret";
const p = require("../src/people");
let pass = 0, fail = 0;
function t(name, cond, detail) { if (cond) { pass++; } else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); } }

// names
t("a name is tidied: trimmed, inner spaces collapsed", p.cleanName("  Maria    G \n") === "Maria G");
t("a name is clipped at 60", p.cleanName("x".repeat(200)).length === 60);
t("nothing is an empty name, not a crash", p.cleanName(null) === "" && p.cleanName(undefined) === "");

// PINs
t("a PIN is 4 to 8 digits", p.validPin("1234") && p.validPin("48291375") && p.validPin(4821));
t("shorter, longer, letters, spaces and empty are refused", !p.validPin("123") && !p.validPin("123456789") && !p.validPin("12a4") && !p.validPin("12 34") && !p.validPin("") && !p.validPin(null));
const made = Array.from({ length: 2000 }, () => p.makePin());
t("a made PIN is always four digits", made.every((x) => /^\d{4}$/.test(x)));
t("a made PIN is never one digit four times", !made.some((x) => /^(\d)\1{3}$/.test(x)));
t("a made PIN is never a run up or down", !made.some((x) => "0123456789".includes(x) || "9876543210".includes(x)));
t("made PINs are spread out, not one value", new Set(made).size > 1000);

// the person cookie
const person = { id: 42, company: "demo", generation: 3 };
const tok = p.sign(person);
t("the cookie is p.<id>.<company>.<generation>.<time>.<mac>", /^p\.42\.demo\.3\.[0-9a-z]+\.[^.]+$/.test(tok), tok);
const v = p.verify(tok);
t("a fresh cookie verifies to the same person", v && v.id === 42 && v.company === "demo" && v.gen === 3, JSON.stringify(v));
const parts = tok.split(".");
const swap = (i, val) => parts.map((x, k) => (k === i ? val : x)).join(".");
t("changing the id breaks it", p.verify(swap(1, "43")) === null);
t("changing the company breaks it", p.verify(swap(2, "acme")) === null);
t("changing the generation breaks it", p.verify(swap(3, "4")) === null);
t("changing the time breaks it", p.verify(swap(4, (Date.now() + 1000).toString(36))) === null);
t("a wrong or short mac is nobody, not a crash", p.verify(swap(5, "AAAA")) === null && p.verify(swap(5, "")) === null);
t("junk is nobody", p.verify("") === null && p.verify(null) === null && p.verify("p.1.2") === null && p.verify("s.42.demo.3.x.y") === null);
// an old cookie: signed properly, 13 hours ago
const auth = require("../src/auth");
const oldPayload = `p.42.demo.3.${(Date.now() - 13 * 3600e3).toString(36)}`;
t("a cookie older than a shift is nobody", p.verify(`${oldPayload}.${auth.hmac(oldPayload)}`) === null);
const futurePayload = `p.42.demo.3.${(Date.now() + 3600e3).toString(36)}`;
t("a cookie from the future is nobody", p.verify(`${futurePayload}.${auth.hmac(futurePayload)}`) === null);
const nearPayload = `p.42.demo.3.${(Date.now() - 11 * 3600e3).toString(36)}`;
t("a cookie from earlier in the shift still holds", p.verify(`${nearPayload}.${auth.hmac(nearPayload)}`) !== null);
t("roles are floor, lead, manager", p.ROLES.join(",") === "floor,lead,manager");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
