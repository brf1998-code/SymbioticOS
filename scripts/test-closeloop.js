// Unit cases for src/closeloop.js, the pure part: where a request is in plain
// words, who may answer "fixed it / not quite", what the proposer is told
// about a follow-up. No database: node scripts/test-closeloop.js
const c = require("../src/closeloop");
let pass = 0, fail = 0;
function t(name, cond, detail) { if (cond) { pass++; } else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); } }
const st = (r) => c.stateOf(r).state;

// where a request is
t("just filed: on the board", st({ status: "new" }) === "new" && /has not looked yet/.test(c.stateOf({ status: "new" }).line));
t("a draft proposal: the manager has it", st({ status: "reviewing", proposal_status: "draft" }) === "proposed");
t("a draft waiting on ERP data says so without naming the ERP", st({ status: "reviewing", proposal_status: "draft", data_status: "waiting" }) === "waiting_data" && !/ERP|BAQ|lookup|field/i.test(c.stateOf({ status: "reviewing", proposal_status: "draft", data_status: "waiting" }).line));
t("approved with no run yet: waiting its turn", st({ status: "in_progress", proposal_status: "approved" }) === "building" && /its turn/.test(c.stateOf({ status: "in_progress", proposal_status: "approved" }).line));
t("queued, running, confirming and a stopped build are all 'being built' to the floor", ["queued", "running", "waiting", "failed"].every((s) => st({ status: "in_progress", proposal_status: "approved", run_status: s, run_step: "build" }) === "building"));
t("built and waiting on the deploy gate: the manager is checking it", st({ status: "in_progress", proposal_status: "approved", run_status: "waiting", run_step: "await_deploy" }) === "checking");
t("live and unanswered asks the question", st({ status: "done", outcome: "Deployed v4: bigger buttons" }) === "live" && /Did it fix it\?/.test(c.stateOf({ status: "done" }).line));
t("live and fixed", st({ status: "done", floor_answer: "fixed" }) === "fixed");
t("live and not quite points at the follow-up", st({ status: "done", floor_answer: "not_quite" }) === "not_quite" && /follow-up/.test(c.stateOf({ status: "done", floor_answer: "not_quite" }).line));
t("rolled back is said plainly and is not 'live'", st({ status: "done", outcome: "Rolled back to v3." }) === "rolled_back");
t("declined carries the manager's reason", c.stateOf({ status: "declined", outcome: "the label size is set by the customer" }).line === "Declined: the label size is set by the customer");
t("declined with no reason is just declined", c.stateOf({ status: "declined", outcome: "declined" }).line === "Declined." && c.stateOf({ status: "declined" }).line === "Declined.");
t("no line carries a dash a participant would read", ["new", "reviewing", "in_progress", "done", "declined"].every((s) => ![8211, 8212].some((code) => c.stateOf({ status: s }).line.includes(String.fromCharCode(code)))));

// who may answer
const live = { status: "done", outcome: "Deployed v4: x", person_id: 7 };
t("the person who asked may answer", c.mayAnswer(live, 7) === true && c.mayAnswer(live, "7") === true);
t("someone else may not", c.mayAnswer(live, 8) === false);
t("nobody signed in may not", c.mayAnswer(live, null) === false && c.mayAnswer({ ...live, person_id: null }, null) === false);
t("a request filed with no name may be answered by any signed-in person", c.mayAnswer({ ...live, person_id: null }, 8) === true);
t("not live yet, declined, or rolled back: nothing to answer", !c.mayAnswer({ ...live, status: "in_progress" }, 7) && !c.mayAnswer({ ...live, status: "declined" }, 7) && !c.mayAnswer({ ...live, outcome: "Rolled back to v3." }, 7));
t("fixed may still become not quite; not quite is final", c.mayAnswer({ ...live, floor_answer: "fixed" }, 7) === true && c.mayAnswer({ ...live, floor_answer: "not_quite" }, 7) === false);
t("a module request is not asked", c.mayAnswer({ ...live, kind: "module_request" }, 7) === false);

// the words
t("the deploy prefix comes off the summary", c.summaryOf("Deployed v12: the queue is sorted by due date") === "the queue is sorted by due date" && c.summaryOf("Deployed v3 (batch of 2): two things") === "two things" && c.summaryOf(null) === "");
t("clip keeps short text, trims long text to the limit, and flattens whitespace", c.clip("a  b\n c", 50) === "a b c" && c.clip("x".repeat(500), 100).length === 100);
const ctx = c.followUpContext({ id: 12, message: 'the "due" column is too small', outcome: "Deployed v5: the due column is wider", shipped_version: 5 });
t("the proposer is told it is a follow-up, to which request, what was asked, what was built, and to keep what works", /This is a follow-up to request #12\./.test(ctx) && /due" column is too small/.test(ctx) && /version 5/.test(ctx) && /the due column is wider/.test(ctx) && /Keep what already works/.test(ctx), ctx);
t("the context starts on a new paragraph so the quoted feedback still ends cleanly", ctx.startsWith("\n\n"));
t("no original, no context", c.followUpContext(null) === "" && c.followUpContext(undefined) === "");
t("an original with nothing built yet still makes sense", /not quite right/.test(c.followUpContext({ id: 3, message: "m", outcome: null })) && !/What was built/.test(c.followUpContext({ id: 3, message: "m", outcome: null })));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
