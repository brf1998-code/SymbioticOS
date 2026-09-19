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

// the manager's close-out on the shipped tile (Done / a little left)
const shipped = { status: "done", outcome: "Deployed v4: x", module: "paperline", shipped_version: 4, person_id: 7, name: "Maria G" };
t("a shipped request nobody has spoken about can be closed out", c.mayCloseOut(shipped) === true);
t("not before it is live, not once declined, not after a rollback", !c.mayCloseOut({ ...shipped, status: "in_progress" }) && !c.mayCloseOut({ ...shipped, status: "declined" }) && !c.mayCloseOut({ ...shipped, outcome: "Rolled back to v3." }));
t("only what went live through a build: no platform item, no module request, nothing closed by hand", !c.mayCloseOut({ ...shipped, module: "platform" }) && !c.mayCloseOut({ ...shipped, kind: "module_request" }) && !c.mayCloseOut({ ...shipped, shipped_version: null }));
t("once the floor has answered the tile already says so: no manager buttons", !c.mayCloseOut({ ...shipped, floor_answer: "fixed" }) && !c.mayCloseOut({ ...shipped, floor_answer: "not_quite" }));
t("the manager answers once", !c.mayCloseOut({ ...shipped, manager_answer: "done" }) && !c.mayCloseOut({ ...shipped, manager_answer: "little_left" }));
t("done reads as a thank-you to the person who asked, naming who closed it", st({ ...shipped, manager_answer: "done", manager_answer_by: "Brendan F" }) === "thanked" && c.stateOf({ ...shipped, manager_answer: "done", manager_answer_by: "Brendan F" }).line === "Brendan F marked it done. Thank you for sending it in.");
t("done with no name on the manager still thanks", /^The manager marked it done\. Thank you/.test(c.stateOf({ ...shipped, manager_answer: "done" }).line));
t("a little left says it is back on the board", st({ ...shipped, manager_answer: "little_left" }) === "little_left" && /a little is left/.test(c.stateOf({ ...shipped, manager_answer: "little_left" }).line) && /back on the board/.test(c.stateOf({ ...shipped, manager_answer: "little_left" }).line));
t("the floor's own answer outranks the manager's close-out", st({ ...shipped, manager_answer: "done", floor_answer: "not_quite" }) === "not_quite" && st({ ...shipped, manager_answer: "done", floor_answer: "fixed" }) === "fixed");
t("after the manager's done the asker may still say not quite: the manager closes a request, not the floor's mouth", c.mayAnswer({ ...shipped, manager_answer: "done" }, 7) === true && c.mayAnswer({ ...shipped, manager_answer: "done" }, 8) === false);
t("after the manager's a little left the floor is not asked: the follow-up carries it", c.mayAnswer({ ...shipped, manager_answer: "little_left" }, 7) === false);
t("neither new line carries a dash or an ERP word", [{ manager_answer: "done" }, { manager_answer: "little_left" }].every((m) => { const l = c.stateOf({ ...shipped, ...m }).line; return ![8211, 8212].some((code) => l.includes(String.fromCharCode(code))) && !/ERP|BAQ|lookup/i.test(l); }));
const mctx = c.followUpContext({ id: 12, message: "the due column is too small", outcome: "Deployed v5: the due column is wider", shipped_version: 5, manager_answer: "little_left" });
t("the proposer is told a manager's follow-up came from the manager, with the same marker and the same brief", /This is a follow-up to request #12\./.test(mctx) && /The manager checked what went live and says a little is left/.test(mctx) && !/tried it on the floor/.test(mctx) && /Keep what already works/.test(mctx), mctx);

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
