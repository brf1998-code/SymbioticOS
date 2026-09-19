// Unit cases for src/health.js (loop health). No database, no tokens:
// node scripts/test-health.js. Rows are synthetic; the clock is fixed.
const health = require("../src/health");

let pass = 0, fail = 0;
function t(name, cond, detail) { if (cond) { pass++; } else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); } }
const NOW = new Date("2026-09-19T12:00:00Z");
const ago = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();
const j = (x) => JSON.stringify(x);

let ids = 1;
const fb = (company, hoursAgo, status = "done") => ({ id: ids++, company, status, created_at: ago(hoursAgo) });
const prop = (f, hoursAgo, status = "approved") => ({ id: ids++, feedback_id: f.id, company: f.company, status, created_at: ago(hoursAgo) });
// a run's log the way pipeline.js writes it: {t, step, note}
const run = (company, p, hoursAgo, { ready, deployed, rolledBack, stops = [], status = "deployed", step = "deploy", evidence = {}, model = "claude-fable-5-1", proposal_ids } = {}) => ({
  id: ids++, company, module: "paperline", lane: "ui", status, step, model, proposal_id: p.id, proposal_ids: proposal_ids || null, created_at: ago(hoursAgo), evidence,
  log: [
    ...stops.map(([h, note]) => ({ t: ago(h), step: "error", note })),
    ready != null ? { t: ago(ready), step: "test_run", note: "smoke checks passed (3 endpoints)" } : null,
    deployed != null ? { t: ago(deployed), step: "deploy", note: "v1 -> v2 live" } : null,
    rolledBack != null ? { t: ago(rolledBack), step: "rollback", note: "restored v1" } : null,
  ].filter(Boolean),
});
const rec = (company, kind, p, hoursAgo) => ({ company, kind, proposal_id: p.id, created_at: ago(hoursAgo) });
const bundle = (o = {}) => ({ companies: [{ slug: "demo", name: "Demo" }, { slug: "acme", name: "Acme", monthly_cap_usd: 50 }], feedback: [], proposals: [], runs: [], record: [], intakes: [], spend: {}, instance_cap: 0, ...o });
const go = (b, windowDays = 30) => health.compute(b, { now: NOW, windowDays });
const demo = (out) => out.companies.find((c) => c.slug === "demo");

// 1. empty
{
  const out = go(bundle());
  t("empty instance computes without error", out.fleet.feedback.filed === 0 && out.fleet.builds.shipped === 0 && out.fleet.floor.median_hours === null && out.fleet.spend.per_shipped_usd === null, j(out.fleet));
  t("window and the same-shift bar are reported", out.window_days === 30 && out.same_shift_hours === 8);
}

// 2. one loop that predates the record: feedback 30h ago, proposal 28h ago,
//    approved (run starts) 26h ago, ready 25h ago, live 24h ago
{
  const f = fb("demo", 30); const p = prop(f, 28); const r = run("demo", p, 26, { ready: 25, deployed: 24 });
  const d = demo(go(bundle({ feedback: [f], proposals: [p], runs: [r] })));
  t("filed, approved, started, shipped each count one", d.feedback.filed === 1 && d.decisions.approved === 1 && d.builds.started === 1 && d.builds.shipped === 1, j(d));
  t("decision wait falls back to the run's start when the record has no row (2h)", d.decisions.wait_median_hours === 2 && d.decisions.wait_n === 1, j(d.decisions));
  t("time to floor is feedback to live (6h), inside the same shift", d.floor.median_hours === 6 && d.floor.p90_hours === 6 && d.floor.same_shift === 1 && d.floor.n === 1, j(d.floor));
  t("deploy gate wait is ready to live (1h)", d.floor.deploy_wait_median_hours === 1, j(d.floor));
  t("nothing open, nothing waiting", d.feedback.open === 0 && d.decisions.waiting === 0 && d.builds.in_flight === 0 && d.builds.waiting_deploy === 0, j(d));
  t("the model tally names the build model", d.builds.models["claude-fable-5-1"] === 1, j(d.builds.models));
}

// 3. the record's decision row wins over the fallback, and an edit is counted
{
  const f = fb("demo", 30); const p = prop(f, 28); const r = run("demo", p, 26, { deployed: 24 });
  const d = demo(go(bundle({ feedback: [f], proposals: [p], runs: [r], record: [rec("demo", "proposal_edited", p, 27), rec("demo", "proposal_approved", p, 27)] })));
  t("decision wait from the record (1h)", d.decisions.wait_median_hours === 1, j(d.decisions));
  t("edited before approval: 1 of 1", d.decisions.edited === 1 && d.decisions.approved === 1, j(d.decisions));
}

// 4. declines: with a record row it lands by decision time, without it by the proposal's own time
{
  const f1 = fb("demo", 100, "declined"); const p1 = prop(f1, 99, "declined");
  const f2 = fb("demo", 900, "declined"); const p2 = prop(f2, 899, "declined");
  const b = bundle({ feedback: [f1, f2], proposals: [p1, p2], record: [rec("demo", "proposal_declined", p2, 10)] });
  const d = demo(go(b, 7));
  t("a decline recorded 10h ago counts in a 7-day window though the proposal is 5 weeks old; one without a row counts by its own age", d.decisions.declined === 2, j(d.decisions));
  t("30-day window: the 5-week-old proposal counts only through its record row", demo(go(b, 30)).decisions.declined === 2 && demo(go(bundle({ feedback: [f1, f2], proposals: [p1, p2] }), 30)).decisions.declined === 1);
  t("declines without a decision time carry no wait", d.decisions.wait_n === 1, j(d.decisions));
}

// 5. stops by kind, fix rounds, overrides, cancellations
{
  const f = fb("demo", 50, "in_progress"); const p = prop(f, 49);
  const r = run("demo", p, 48, { status: "failed", step: "cross_check", stops: [[47, "platform checks failed: routes.js line 3"], [40, "cross-check failed: the label moved"], [30, "internal tests failed: 500 on /api/items"], [20, "visual check failed: blank"], [10, "agent stopped: boom"]], evidence: { fix_round: 2, cross_check: { overridden: true } } });
  const c = run("demo", prop(fb("demo", 5, "reviewing"), 4), 3, { status: "cancelled", step: "build" });
  const d = demo(go(bundle({ feedback: [f], proposals: [p], runs: [r, c] })));
  t("stops are sorted: gate 1, reviewer 1, tests 2, other 1", j(d.builds.stops) === j({ gate: 1, reviewer: 1, tests: 2, other: 1 }), j(d.builds.stops));
  t("fix rounds and overrides come from the run's evidence", d.builds.fix_rounds === 2 && d.builds.overrides === 1, j(d.builds));
  t("a cancelled run is counted", d.builds.cancelled === 1, j(d.builds));
  t("quiet stretch: last check stop 20h ago (0.8 days), last gate stop 47h ago (2 days), never a rollback", d.quiet.check_stop_days === 0.8 && d.quiet.gate_stop_days === 2 && d.quiet.rollback_days === null && d.quiet.other_stop_days === 0.4, j(d.quiet));
}

// 6. rollback and windowing: a deploy 40 days ago is outside 30 days, inside all time; quiet uses the whole history
{
  const f = fb("demo", 1000); const p = prop(f, 999); const r = run("demo", p, 998, { deployed: 40 * 24, rolledBack: 39 * 24, status: "rolled_back", step: "rollback" });
  const b = bundle({ feedback: [f], proposals: [p], runs: [r] });
  const d30 = demo(go(b, 30)), dAll = demo(go(b, 0));
  t("30 days: nothing filed, shipped or rolled back", d30.feedback.filed === 0 && d30.builds.shipped === 0 && d30.builds.rolled_back === 0, j(d30.builds));
  t("all time: one shipped, one rolled back", dAll.feedback.filed === 1 && dAll.builds.shipped === 1 && dAll.builds.rolled_back === 1, j(dAll.builds));
  t("the rollback is 39 days ago in both windows", d30.quiet.rollback_days === 39 && dAll.quiet.rollback_days === 39, j(d30.quiet));
  t("a 7-day window is reported as such and 0 means all time", go(b, 7).window_days === 7 && go(b, 0).window_days === 0);
}

// 7. same shift, median and p90 over three shipped changes (2h, 7h, 20h)
{
  const rows = [[2], [7], [20]].map(([h]) => { const f = fb("demo", h + 1); const p = prop(f, h + 0.5); return { f, p, r: run("demo", p, h + 0.4, { deployed: 1 }) }; });
  const d = demo(go(bundle({ feedback: rows.map((x) => x.f), proposals: rows.map((x) => x.p), runs: rows.map((x) => x.r) })));
  t("same shift 2 of 3, median 7h, p90 20h", d.floor.same_shift === 2 && d.floor.n === 3 && d.floor.median_hours === 7 && d.floor.p90_hours === 20, j(d.floor));
}

// 8. open feedback and proposals waiting on the manager
{
  const open = [fb("demo", 5, "new"), fb("demo", 30, "reviewing"), fb("demo", 2, "in_progress"), fb("demo", 60, "done"), fb("demo", 70, "declined")];
  const waiting = prop(open[1], 29, "draft"); const notWaiting = prop(open[3], 59, "draft");
  const d = demo(go(bundle({ feedback: open, proposals: [waiting, notWaiting] })));
  t("open = new, reviewing, in progress (3); oldest 30h", d.feedback.open === 3 && d.feedback.oldest_open_hours === 30, j(d.feedback));
  t("waiting on the manager: one draft on open feedback, 29h", d.decisions.waiting === 1 && d.decisions.oldest_waiting_hours === 29, j(d.decisions));
  const onUs = { ...prop(open[0], 4, "draft"), data_status: "waiting" };
  const d2 = demo(go(bundle({ feedback: open, proposals: [waiting, notWaiting, onUs] })));
  t("a draft that waits on ERP data waits on us, not on the manager", d2.decisions.waiting === 1 && d2.decisions.waiting_data === 1 && d2.decisions.oldest_waiting_data_hours === 4, j(d2.decisions));
}

// 9. a batch run: time to floor starts at the oldest feedback in the batch
{
  const fa = fb("demo", 40), fbb = fb("demo", 10); const pa = prop(fa, 39), pb = prop(fbb, 9);
  const r = run("demo", pb, 8, { deployed: 4, proposal_ids: [pa.id, pb.id] });
  const d = demo(go(bundle({ feedback: [fa, fbb], proposals: [pa, pb], runs: [r] })));
  t("batch: 36h from the older item to the floor, one shipped run", d.floor.median_hours === 36 && d.builds.shipped === 1 && d.floor.same_shift === 0, j(d.floor));
  t("both proposals count as approved from the one run", d.decisions.approved === 2, j(d.decisions));
}

// 10. two companies and the fleet
{
  const f1 = fb("demo", 10), f2 = fb("acme", 10), f3 = fb("acme", 4, "new");
  const p1 = prop(f1, 9), p2 = prop(f2, 9);
  const r1 = run("demo", p1, 8, { deployed: 6 }), r2 = run("acme", p2, 8, { deployed: 2, model: "claude-sonnet-5" });
  const out = go(bundle({ feedback: [f1, f2, f3], proposals: [p1, p2], runs: [r1, r2], spend: { demo: { window: 3, month: 4 }, acme: { window: 10, month: 12 } }, intakes: [{ company: "acme", status: "confirmed", created_at: ago(3) }, { company: "acme", status: "abandoned", created_at: ago(2) }], instance_cap: 500 }));
  const d = demo(out), a = out.companies.find((c) => c.slug === "acme");
  t("each company sees only its own rows", d.feedback.filed === 1 && a.feedback.filed === 2 && a.feedback.open === 1 && d.builds.shipped === 1 && a.builds.shipped === 1, j([d.feedback, a.feedback]));
  t("the fleet is the union: 3 filed, 2 shipped, median to floor 6h", out.fleet.feedback.filed === 3 && out.fleet.builds.shipped === 2 && out.fleet.floor.median_hours === 6, j(out.fleet.floor));
  t("spend: acme $10 in the window, $10 for its one shipped change, its own $50 cap; fleet $13, $6.50 a change, and the instance cap", a.spend.window_usd === 10 && a.spend.per_shipped_usd === 10 && out.fleet.spend.per_shipped_usd === 6.5 && a.spend.cap_usd === 50 && out.fleet.spend.window_usd === 13 && out.fleet.spend.month_usd === 16 && out.fleet.spend.cap_usd === 500, j([a.spend, out.fleet.spend]));
  t("demo has no cap of its own", d.spend.cap_usd === null);
  t("models per company and across the fleet", a.builds.models["claude-sonnet-5"] === 1 && out.fleet.builds.models["claude-fable-5-1"] === 1 && out.fleet.builds.models["claude-sonnet-5"] === 1, j(out.fleet.builds.models));
  t("intakes: acme started 2, confirmed 1, abandoned 1; demo none", a.intakes.started === 2 && a.intakes.confirmed === 1 && a.intakes.abandoned === 1 && d.intakes.started === 0, j(a.intakes));
}

// 11. in flight and at the gates (whole history, not the window)
{
  const f = fb("demo", 900, "in_progress"); const p = prop(f, 899);
  const runs = [run("demo", p, 898, { status: "running", step: "build" }), run("demo", p, 898, { status: "waiting", step: "await_deploy" }), run("demo", p, 898, { status: "waiting", step: "confirm_requirement" }), run("demo", p, 898, { status: "queued", step: "build" })];
  const d = demo(go(bundle({ feedback: [f], proposals: [p], runs }), 7));
  t("in flight 2, waiting at the deploy gate 1, waiting on the requirement 1", d.builds.in_flight === 2 && d.builds.waiting_deploy === 1 && d.builds.waiting_confirm === 1, j(d.builds));
}

// 12. the helpers
{
  t("stopKind reads the run's error line", ["platform checks failed: x", "cross-check failed: y", "internal tests failed: z", "visual check failed: w", "boom"].map(health.stopKind).join(",") === "gate,reviewer,tests,tests,other");
  const r = run("demo", { id: 1 }, 5, { ready: 4, deployed: 3, rolledBack: 2, stops: [[4.5, "cross-check failed: q"]] });
  const tm = health.runTimes(r);
  t("runTimes finds ready, deployed, rolled back and the stops", tm.ready === ago(4) && tm.deployed === ago(3) && tm.rolledBack === ago(2) && tm.stops.length === 1 && tm.stops[0].kind === "reviewer", j(tm));
  t("a run with no log has no times", health.runTimes({ log: null }).deployed === null && health.runTimes({}).stops.length === 0);
  const ui = health.runTimes({ log: [{ t: ago(3), step: "visual_check", note: "staged pages render; ready for manager review" }, { t: ago(1), step: "deploy", note: "v2 -> v3 live" }] });
  t("the UI lane's ready line counts too", ui.ready === ago(3) && ui.deployed === ago(1), j(ui));
}

// what the floor said once a change was live (src/closeloop.js)
{
  const live = (hShip, extra = {}) => ({ ...fb("demo", hShip + 10, "done"), shipped_at: ago(hShip), person_id: 7, ...extra });
  const a = live(50, { floor_answer: "fixed", floor_answer_at: ago(40) });
  const b = live(30, { floor_answer: "not_quite", floor_answer_at: ago(20) });
  const c = live(10);                                                             // live, named, nobody has said
  const d = live(5, { person_id: null });                                         // live, filed with no name
  const old = live(24 * 60, { floor_answer: "fixed", floor_answer_at: ago(24 * 59) });   // answered long before the window
  const follow = { ...fb("demo", 20, "new"), follow_up_of: b.id };                // b's follow-up, still open
  const closed = { ...fb("demo", 19, "done"), follow_up_of: a.id };               // a follow-up already shipped is not open
  const other = { ...fb("acme", 12, "done"), shipped_at: ago(6), floor_answer: "not_quite", floor_answer_at: ago(1), person_id: 3 };
  const out = go(bundle({ feedback: [a, b, c, d, old, follow, closed, other] }));
  const x = demo(out).answers;
  t("fixed and not quite count once each, inside the window", x.fixed === 1 && x.not_quite === 1, j(x));
  t("fixed share is fixed over answered", x.fixed_share === 0.5);
  t("went live and unanswered: what shipped in the window and nobody has spoken for", x.went_live === 4 && x.unanswered === 2 && x.unanswered_named === 1, j(x));
  t("an open follow-up is counted as open work", x.follow_ups_open === 1);
  t("another company's answer stays its own, and the fleet adds up", out.companies.find((k) => k.slug === "acme").answers.not_quite === 1 && out.fleet.answers.not_quite === 2 && out.fleet.answers.fixed === 1, j(out.fleet.answers));
  t("with nothing answered the share is null, not zero", go(bundle({ feedback: [c] })).fleet.answers.fixed_share === null);
  t("all time takes the old answer in", demo(go(bundle({ feedback: [a, old] }), 0)).answers.fixed === 2);

  // the manager's close-out on the shipped tile: Done, or a little left
  const e = live(8, { manager_answer: "done", manager_answer_at: ago(7) });                                   // the manager closed it, the floor has not said
  const f = live(9, { manager_answer: "little_left", manager_answer_at: ago(6) });                           // the manager says a little is left
  const g = live(12, { manager_answer: "done", manager_answer_at: ago(11), floor_answer: "not_quite", floor_answer_at: ago(2) });   // closed, then the floor said not quite
  const oldDone = live(24 * 60, { manager_answer: "done", manager_answer_at: ago(24 * 58) });
  const y = demo(go(bundle({ feedback: [a, b, c, d, e, f, g, oldDone] }))).answers;
  t("the manager's done and a little left count once each, inside the window", y.manager_done === 2 && y.manager_little_left === 1, j(y));
  t("a request the manager closed is no longer unanswered", y.went_live === 7 && y.unanswered === 2 && y.unanswered_named === 1, j(y));
  t("the floor's own share is still the floor's: the manager's taps do not move it", y.fixed === 1 && y.not_quite === 2 && y.fixed_share === Math.round((1 / 3) * 100) / 100, j(y));
  t("met and missed count each request once: a done the floor later called not quite is a miss", y.met === 2 && y.missed === 3 && y.met_share === 0.4, j(y));
  t("with nobody having spoken the met share is null", go(bundle({ feedback: [c] })).fleet.answers.met_share === null && go(bundle({ feedback: [c] })).fleet.answers.manager_done === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
