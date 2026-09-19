// End to end: build order item 7. Acceptance checks that accumulate (src/acceptance.js), the page load every
// build gets (src/pageload.js), and the manager retiring a promise. Same server as closeout.js (fake agent,
// passwords on, FRESH database: the counts below assume the library modules' own checks and nothing else).
//   node scripts/e2e/checks.js
// The fake agent's markers (src/agent.js): BREAKPAGE, BREAKPROMISE, BADCHECK, BADSMOKE, EDITCHECK, NOCHECK.
const { BASE, PW, runner, client, login, waitFor, rowsOf, person, board, fbRow } = require("./lib");
const R = runner(), t = R.t;
const PAGE = "/c/demo/m/paperline/";

(async () => {
  const admin = await login(PW.admin, ""), mgr = await login(PW.manager, "demo"), floor = await login(PW.floor, "demo");
  const made = await admin.post("/api/admin/companies", { slug: "acme", name: "Acme" });
  const acmeMgr = await login(made.json.passwords.manager, "acme");
  const brendan = await person(mgr, "demo", "Brendan F", "manager"); await mgr.post("/api/c/demo/who/sign-in", { id: brendan.id, pin: brendan.pin });
  const maria = await person(mgr, "demo", "Maria G", "floor"); await floor.post("/api/c/demo/who/sign-in", { id: maria.id, pin: maria.pin });
  const file = async (msg) => (await floor.post("/api/feedback", { company: "demo", module: "paperline", page: PAGE, message: msg })).json.id;
  const runOf = async (id) => (await board(mgr)).runs.find((r) => r.id === id);
  // review and approve one request; returns the run id. A functionality change is confirmed on the way.
  const start = async (fbId) => {
    const prop = (await mgr.post(`/api/feedback/${fbId}/review`)).json;
    const r = (await mgr.post(`/api/proposals/${prop.id}/decide`, { decision: "approve" })).json;
    return { runId: (r.run || r).id, cls: prop.class };
  };
  // wait until the run stops moving: at the deploy gate, or failed. Confirms the requirement when asked.
  const settle = async (runId) => waitFor(`run ${runId} to settle`, async () => {
    const x = await runOf(runId);
    if (x && x.step === "confirm_requirement" && x.status === "waiting") { await mgr.post(`/api/runs/${runId}/confirm`, {}); return null; }
    return x && (x.status === "failed" || (x.step === "await_deploy" && x.status === "waiting")) ? x : null;
  }, 90000);
  const atGate = (x) => x.step === "await_deploy" && x.status === "waiting";
  const lastErr = (x) => ((x.log || []).filter((l) => l.step === "error").slice(-1)[0] || {}).note || "";
  const promises = async (mod = "paperline") => (await mgr.get(`/api/c/demo/modules/${mod}/checks`)).json;

  // ---- the pile a tool starts with
  const p0 = await promises(), k0 = await promises("kpis");
  t("the library modules come with their own promises, in plain words", p0.checks.length === 3 && k0.checks.length === 2 && p0.checks.every((c) => c.title.length > 20 && !/api|json/i.test(c.title)), p0.checks.map((c) => c.title));
  t("a floor device and another company cannot read them", (await floor.get("/api/c/demo/modules/paperline/checks")).status === 403 && (await acmeMgr.get("/api/c/demo/modules/paperline/checks")).status === 403);

  // ---- a look-and-feel change: every promise is checked and every screen opened
  const u1 = await start(await file("make the station label bigger"));
  const g1 = await settle(u1.runId);
  const c1 = g1.evidence.checks;
  t("a UI build reaches the gate with its checks on the run", atGate(g1) && c1 && c1.ok === true && g1.evidence.visual_check.ok === true, lastErr(g1));
  t("the endpoints answered, as this company's manager and not as the platform", c1.smoke.ok && c1.smoke.checked.length === 6 && c1.smoke.checked.every((s) => s.status === 200), c1.smoke);
  t("all three promises were kept, none new in a UI build", c1.acceptance.total === 3 && c1.acceptance.passed === 3 && c1.acceptance.added.length === 0 && c1.acceptance.retired === 0, c1.acceptance);
  t("every screen was opened in a real browser", c1.pages.mode === "browser" && c1.pages.screens === 4 && c1.pages.problems.length === 0, c1.pages);
  t("the run log says all of it in one line", /6 endpoints answered; 3 checks passed; 4 screens opened in a browser with no new script errors/.test((g1.log || []).map((l) => l.note).join("\n")));
  // a check wrote a request into the staged copy; the preview must start from the floor's data again
  const stagedStock = (await mgr.get("/c/demo/staging/m/paperline/api/stock")).json, liveStock = (await mgr.get("/c/demo/m/paperline/api/stock")).json;
  t("rows the checks wrote are gone from the preview, and never touched the floor", !stagedStock.requests.some((r) => r.requested_by === "Check") && !liveStock.requests.some((r) => r.requested_by === "Check"), stagedStock.requests);
  await mgr.post(`/api/runs/${u1.runId}/deploy`);
  await waitFor("u1 live", async () => (await runOf(u1.runId)).status === "deployed");

  // ---- a screen that breaks when it opens (the UI lane's blind spot until now)
  const u2 = await start(await file("make the shift clock text bigger BREAKPAGE"));
  const f2 = await settle(u2.runId);
  const c2 = f2.evidence.checks;
  t("a script error on a screen stops the build before the gate", f2.status === "failed" && f2.step === "visual_check" && c2.kind === "page" && /^visual check failed: Line board \(manager view\): a script error on the screen: .*fakeAgentCalledSomethingThatIsNotThere/.test(lastErr(f2)), lastErr(f2));
  t("it names the screen, and the other screens are fine", c2.pages.problems.length === 1 && c2.pages.problems[0].screen === "Line board (manager view)" && c2.pages.problems[0].kind === "script" && c2.acceptance.ok === true, c2.pages.problems);
  const cl2 = (await mgr.get("/api/c/demo/checks")).json; const row2 = rowsOf(cl2.runs || cl2).find((r) => r.id === u2.runId);
  t("the checks log calls it what it is", row2 && row2.reason === "a screen broke on opening", row2 && row2.reason);
  t("override is for a reviewer's opinion, not for this", (await mgr.post(`/api/runs/${u2.runId}/override`)).status >= 400);
  await mgr.post(`/api/runs/${u2.runId}/fix`);
  const g2 = await settle(u2.runId);
  t("sent back with what a person would hit; the fix round clears it", atGate(g2) && g2.evidence.fix_round === 1 && g2.evidence.checks.ok === true, lastErr(g2));
  t("the agent was told as the platform, not as a reviewer", g2.evidence.findings_from === "checks" && /"Line board \(manager view\)" screen \(\/\)/.test(g2.evidence.findings) && /A person opening that screen would hit this/.test(g2.evidence.findings), g2.evidence.findings);
  await mgr.post(`/api/runs/${u2.runId}/cancel`);

  // ---- a functionality change leaves a check behind
  const F1 = await file("count the scrapped planes per shift and keep the total");
  const n1 = await start(F1);
  const g3 = await settle(n1.runId);
  const c3 = g3.evidence.checks;
  t("a functionality build adds one check and passes all four", n1.cls === "functionality" && atGate(g3) && c3.acceptance.total === 4 && c3.acceptance.added.length === 1 && /^checks\/004-fake-change-v\d+\.json$/.test(c3.acceptance.added[0].file), c3.acceptance);
  t("the run log counts the new one", /4 checks passed \(1 new with this change\)/.test((g3.log || []).map((l) => l.note).join("\n")));
  const added = rowsOf((await mgr.get(`/api/c/demo/record?kind=check_added&run_id=${n1.runId}`)).json);
  t("on the record: check_added with the promise in words", added.length === 1 && added[0].after === c3.acceptance.added[0].title && added[0].detail.file === c3.acceptance.added[0].file && added[0].actor_role === "agent", added[0]);
  await mgr.post(`/api/runs/${n1.runId}/deploy`);
  await waitFor("n1 live", async () => (await runOf(n1.runId)).status === "deployed");
  t("the tool now promises four things", (await promises()).checks.length === 4);

  // ---- a change that leaves none is let through, and the log says so
  const n2 = await start(await file("keep the scrap total when a shift ends NOCHECK"));
  const g4 = await settle(n2.runId);
  t("no check is not a stop; the run log says nothing will hold a later build to it", atGate(g4) && g4.evidence.checks.acceptance.added.length === 0 && /left no check behind/.test((g4.log || []).map((l) => l.note).join("\n")));
  await mgr.post(`/api/runs/${n2.runId}/cancel`);

  // ---- the change's own check does not pass
  const n3 = await start(await file("keep a running tally of folds per station BADCHECK"));
  const f5 = await settle(n3.runId);
  const c5 = f5.evidence.checks;
  t("its own check failing stops it, named as its own", f5.status === "failed" && f5.step === "test_run" && c5.kind === "own_check" && c5.acceptance.failed.length === 1 && c5.acceptance.failed[0].new === true && /the check that came with this change does not pass/.test(lastErr(f5)) && /answered 200, expected 418/.test(lastErr(f5)), lastErr(f5));
  t("a new check is not a promise: there is nothing to retire", await (async () => { const x = await mgr.post(`/api/runs/${n3.runId}/retire-check`, { file: c5.acceptance.failed[0].file, reason: "x" }); return x.status === 409 && /did not break that promise/.test(x.json.error); })());
  await mgr.post(`/api/runs/${n3.runId}/fix`);
  const g5 = await settle(n3.runId);
  t("the agent may edit its own check in the fix round, and the build passes", atGate(g5) && /You may edit checks\//.test(g5.evidence.findings) && g5.evidence.checks.acceptance.total === 5, lastErr(g5));
  await mgr.post(`/api/runs/${n3.runId}/cancel`);

  // ---- module.json lists a path that is not there: a 404 no longer passes
  const n4 = await start(await file("track which station waited longest BADSMOKE"));
  const f6 = await settle(n4.runId);
  t("an endpoint that answers 404 stops the build (it used to pass)", f6.status === "failed" && f6.evidence.checks.kind === "smoke" && /\/api\/fake-not-there answered 404/.test(lastErr(f6)), lastErr(f6));
  await mgr.post(`/api/runs/${n4.runId}/cancel`);

  // ---- a build may not rewrite a promise
  const n5 = await start(await file("record who released each traveler EDITCHECK"));
  const f7 = await settle(n5.runId);
  t("the module gate refuses a build that edited an older check, before anything ran", f7.status === "failed" && f7.step === "cross_check" && f7.evidence.cross_check.model === "platform checks" && (f7.evidence.gate.violations || []).some((v) => v.rule === "lane-check-edited") && /promise an earlier change made/.test(f7.evidence.cross_check.summary), f7.evidence.gate);
  await mgr.post(`/api/runs/${n5.runId}/fix`);
  const g7 = await settle(n5.runId);
  t("the platform puts the check back itself and the fix round passes", atGate(g7) && /the platform put back: checks\/001-the-line-board-answers\.json/.test((g7.log || []).map((l) => l.note).join("\n")), lastErr(g7));
  await mgr.post(`/api/runs/${n5.runId}/cancel`);

  // ---- an earlier promise broken: the manager's call
  const n6 = await start(await file("group the travelers by fold type on the server BREAKPROMISE"));
  t("setup: that request went down the functionality lane", n6.cls === "functionality" && n3.cls === "functionality" && n4.cls === "functionality" && n5.cls === "functionality", [n3.cls, n4.cls, n5.cls, n6.cls]);
  const f8 = await settle(n6.runId);
  const c8 = f8.evidence.checks;
  const broken = c8.acceptance.failed.filter((r) => !r.new).map((r) => r.file);
  t("a build that still answers but breaks what was promised is stopped as a broken promise", f8.status === "failed" && c8.kind === "promise" && c8.smoke.ok === true && broken.length === 2 && broken.includes("checks/001-the-line-board-answers.json") && broken.some((f) => /004-fake-change/.test(f)), { broken, err: lastErr(f8) });
  t("its own new check fails too, but the older promises are what the card leads with", c8.acceptance.failed.filter((r) => r.new).length === 1 && /^internal tests failed: this change breaks something an earlier change promised/.test(lastErr(f8)));
  t("the error names the promise in its own words", /breaks something an earlier change promised: "The line board shows the stations/.test(lastErr(f8)));
  const fromRun = c8.acceptance.failed.find((r) => /004-fake-change/.test(r.file));
  t("a promise knows the request it came from", fromRun.origin && fromRun.origin.run_id === n1.runId && fromRun.origin.requests[0].id === F1 && /scrapped planes/.test(fromRun.origin.requests[0].words) && fromRun.origin.requests[0].name === "Maria G", fromRun.origin);
  t("one that came with the tool says so by having no request", c8.acceptance.failed.find((r) => /001-/.test(r.file)).origin.requests.length === 0);
  t("the checks log: broke an earlier promise", rowsOf(((await mgr.get("/api/c/demo/checks")).json).runs || []).find((r) => r.id === n6.runId).reason === "broke an earlier promise");
  t("a floor device cannot retire a promise", (await floor.post(`/api/runs/${n6.runId}/retire-check`, { file: fromRun.file, reason: "x" })).status === 403);
  t("another company's manager cannot either", (await acmeMgr.post(`/api/runs/${n6.runId}/retire-check`, { file: fromRun.file, reason: "x" })).status === 403);
  t("a promise this build did not break cannot be retired here", (await mgr.post(`/api/runs/${n6.runId}/retire-check`, { file: "checks/002-a-station-asks-the-stockroom.json", reason: "x" })).status === 409);
  const ret = await mgr.post(`/api/runs/${n6.runId}/retire-check`, { file: fromRun.file, reason: "the travelers come back grouped now, the old shape is gone on purpose" });
  t("the manager retires one of the two", ret.status === 200 && ret.json.title === fromRun.title, ret.json);
  const f9 = await settle(n6.runId);
  t("the build is checked again at once, and the promise still standing still stops it", f9.status === "failed" && f9.evidence.checks.kind === "promise" && f9.evidence.checks.acceptance.failed.filter((r) => !r.new).length === 1 && /001-/.test(f9.evidence.checks.acceptance.failed.find((r) => !r.new).file) && f9.evidence.checks.acceptance.retired === 1, f9.evidence.checks.acceptance.failed.map((r) => r.file));
  const rr = rowsOf((await mgr.get(`/api/c/demo/record?kind=promise_retired&run_id=${n6.runId}`)).json)[0];
  t("on the record: who retired which promise and why, word for word", rr && rr.before === fromRun.title && /grouped now/.test(rr.after) && rr.actor_name === "Brendan F" && rr.actor_role === "manager" && rr.detail.file === fromRun.file, rr);
  t("retiring it twice is refused", (await mgr.post(`/api/runs/${n6.runId}/retire-check`, { file: fromRun.file, reason: "again" })).status === 409);
  await mgr.post(`/api/runs/${n6.runId}/fix`);
  const g9 = await settle(n6.runId);
  t("sent back to keep the other promise: the agent is told never to touch it, and the build passes", atGate(g9) && /do NOT edit or remove it/.test(g9.evidence.findings) && g9.evidence.checks.acceptance.retired === 1, lastErr(g9));
  await mgr.post(`/api/runs/${n6.runId}/deploy`);
  await waitFor("n6 live", async () => (await runOf(n6.runId)).status === "deployed");
  const pz = await promises();
  t("what the tool promises now: the retired one is listed apart, with who and why", pz.retired.length === 1 && pz.retired[0].file === fromRun.file && pz.retired[0].retired_by === "Brendan F" && /grouped now/.test(pz.retired[0].reason) && !pz.checks.some((c) => c.file === fromRun.file) && pz.checks.length === 4, pz);

  // ---- a retired promise stays retired for later builds
  const u3 = await start(await file("make the order number text bold"));
  const g10 = await settle(u3.runId);
  t("the next build is not held to the retired promise", atGate(g10) && g10.evidence.checks.acceptance.retired === 1 && g10.evidence.checks.acceptance.total === 4, g10.evidence.checks.acceptance);
  await mgr.post(`/api/runs/${u3.runId}/cancel`);

  // ---- a brand-new module starts with a promise of its own, and is held to it
  const it = (await mgr.post("/api/c/demo/intakes", {})).json;
  const answerFor = (qn) => ({ text: qn.id === "name" ? "Tool crib" : "Check text for the intake", choice: { picks: [((qn.options || [])[0] || {}).id].filter(Boolean), other: "" }, roles: { floor: "6" }, devices: { floor: ["phone"] }, order: ["waiting", "checked out", "back on the shelf"], items: ["tools go missing"], attach: { note: "" } }[qn.kind]);
  let view = it;
  for (let guard = 0; guard < 6 && ["answering", "thinking"].includes(view.status); guard++) {
    for (const qn of view.questions.filter((x) => view.missing.includes(x.id))) await mgr.post(`/api/intakes/${it.id}/answer`, { id: qn.id, value: answerFor(qn) });
    await mgr.post(`/api/intakes/${it.id}/next`, {});
    view = await waitFor("the intake to stop thinking", async () => { const v = (await mgr.get(`/api/intakes/${it.id}`)).json; return v.status !== "thinking" ? v : null; });
  }
  t("setup: the fake intake reaches a design", view.status === "design", view.status + " " + (view.error || ""));
  await mgr.post(`/api/intakes/${it.id}/confirm`, {});
  const modRun = await waitFor("the module build to start", async () => (await board(mgr)).runs.find((r) => r.lane === "module"));
  const gm = await settle(modRun.id);
  const cm = gm.evidence.checks;
  t("a new module's first build passes the promise the platform wrote for it", atGate(gm) && cm.acceptance.total === 1 && cm.acceptance.added[0].file === "checks/001-the-list-answers.json" && cm.pages.mode === "browser" && cm.pages.screens >= 1, lastErr(gm) || cm);
  t("that promise is in plain words about the thing itself", /list answers, a new one can be added and moved/.test(cm.acceptance.added[0].title));
  await mgr.post(`/api/runs/${modRun.id}/cancel`);

  // ---- loop health tells the stops apart; the backup carries the retirements; deleting a company takes its own
  const hb = (await admin.get("/api/admin/health?days=30")).json.companies.find((c) => c.slug === "demo").builds;
  t("loop health: what the tests stopped, told apart", hb.test_stops.page === 1 && hb.test_stops.own_check === 1 && hb.test_stops.smoke === 1 && hb.test_stops.promise === 2 && hb.stops.tests === 5 && hb.stops.gate === 1, hb);
  t("loop health: how the pile of promises moved", hb.checks_added >= 3 && hb.promises_retired === 1, { added: hb.checks_added, retired: hb.promises_retired });
  const bk = (await admin.get("/api/admin/backup")).json;
  t("the backup carries the retirements", ((bk.platform || {}).check_retirements || []).some((r) => r.file === fromRun.file && r.company === "demo"));

  R.done();
})().catch(R.abort);
