// End to end: the manager's close-out on a shipped tile (Done / a little left), and the whole-file module
// context. Runs against a server that is ALREADY UP in fake-agent mode on a fresh database:
//
//   createdb sos_e2e   (user sos / sos, see CLAUDE.md "Deploying")
//   DATABASE_URL=postgres://sos:sos@127.0.0.1:5432/sos_e2e SOS_FAKE_AGENT=1 SOS_FAKE_DELAY_MS=300 PORT=3999 \
//   SOS_FLOOR_PASSWORD=floorpw SOS_MANAGER_PASSWORD=mgrpw SOS_ADMIN_PASSWORD=adminpw SESSION_SECRET=e2e node server.js &
//   node scripts/e2e/closeout.js
//
// Kept in the repo on purpose: the earlier end to end suites lived only in a session's sandbox and could not
// be rerun by the next one (verification pass of 2026-09-19).
const { PW, runner, login, waitFor, rowsOf, board, fbRow } = require("./lib");
const R = runner(), t = R.t;

(async () => {
  const admin = await login(PW.admin, "");
  const mgr = await login(PW.manager, "demo");        // a manager device with Brendan F signed in
  const mgrAnon = await login(PW.manager, "demo");    // a manager device with nobody signed in
  const floor = await login(PW.floor, "demo");        // Maria's tablet
  const floorAnon = await login(PW.floor, "demo");    // a tablet nobody is signed in on
  const made = await admin.post("/api/admin/companies", { slug: "acme", name: "Acme" });
  const acmeMgr = await login(made.json.passwords.manager, "acme");

  const maria = (await mgr.post("/api/c/demo/people", { name: "Maria G", role: "floor" })).json;
  const brendan = (await mgr.post("/api/c/demo/people", { name: "Brendan F", role: "manager" })).json;
  t("setup: Maria signs in on her tablet", (await floor.post("/api/c/demo/who/sign-in", { id: maria.person.id, pin: maria.pin })).status === 200);
  t("setup: Brendan signs in on the manager's screen", (await mgr.post("/api/c/demo/who/sign-in", { id: brendan.person.id, pin: brendan.pin })).status === 200);

  const PAGE = "/c/demo/m/paperline/";
  const file = async (c, message) => (await c.post("/api/feedback", { company: "demo", module: "paperline", page: PAGE, message })).json;
  // seven requests, all look-and-feel so the fake proposer sends them down the UI lane, shipped as one batch
  const words = ["make the station label bigger", "show the shift clock in a bigger font", "make the order number text bold", "show the queue count in a clearer color", "make the fold step text bigger", "show the traveler id in bigger text", "make the clip label text darker"];
  const r = [];
  for (let i = 0; i < words.length; i++) r.push(await file(i === 3 ? floorAnon : floor, words[i]));
  const [R1, R2, R3, R4, R5, R6, R7] = r.map((x) => x.id);
  t("setup: Maria's requests carry her name, the nameless one does not", r[0].person_id === maria.person.id && r[3].person_id === null);

  // ---- nothing to close out before it is live; only a manager of this company may
  t("not live yet: refused in plain words", await (async () => { const x = await mgr.post(`/api/feedback/${R1}/closeout`, { answer: "done" }); return x.status === 409 && /not live/.test(x.json.error); })());
  t("a floor device cannot close out", (await floor.post(`/api/feedback/${R1}/closeout`, { answer: "done" })).status === 403);
  t("another company's manager cannot reach it", (await acmeMgr.post(`/api/feedback/${R1}/closeout`, { answer: "done" })).status === 403);

  // ---- the whole-file context (src/modulesource.js): the proposer's context is the whole module
  const props = [];
  for (const id of [R1, R2, R3, R4, R5, R6, R7]) props.push((await mgr.post(`/api/feedback/${id}/review`)).json);
  t("setup: seven proposals, all UI", props.every((p) => p && p.id && p.class === "ui"), props.map((p) => p && p.class));
  const drafted = (await mgr.get(`/api/c/demo/record?kind=proposal_drafted&feedback_id=${R1}`)).json;
  const rows = rowsOf(drafted);
  const exported = (await mgr.get("/api/c/demo/modules/paperline/export")).json.files;
  const totalChars = Object.values(exported).reduce((s, c) => s + String(c).length, 0);
  t("the proposer was given the whole module: its context is at least every character of every live file, nothing cut", rows[0] && rows[0].detail.context_chars >= totalChars && !rows[0].detail.context_cut, { context_chars: rows[0] && rows[0].detail.context_chars, totalChars });
  t("and that is more than the old cuts allowed (routes.js alone is over 8,000)", exported["routes.js"].length > 8000 && totalChars > 8000 * Object.keys(exported).length / 2, { routes: exported["routes.js"].length, totalChars });

  // ---- ship all seven as one batch
  const run = (await mgr.post("/api/runs/batch", { proposal_ids: props.map((p) => p.id) })).json.run;
  await waitFor("the batch at the deploy gate", async () => { const b = await board(mgr); const x = b.runs.find((y) => y.id === run.id); return x && x.step === "await_deploy" && x.status === "waiting"; });
  t("deploy", (await mgr.post(`/api/runs/${run.id}/deploy`)).status === 200);
  const live = await waitFor("the requests to be live", async () => { const f = await fbRow(mgr, R1); return f && f.status === "done" && f.shipped_version ? f : null; });
  t("setup: shipped and stamped with the version", live.shipped_version > 1);

  // ---- bad input
  t("an answer that is neither is refused", (await mgr.post(`/api/feedback/${R1}/closeout`, { answer: "great" })).status === 400);
  t("a little left needs words", await (async () => { const x = await mgr.post(`/api/feedback/${R1}/closeout`, { answer: "little_left", what: " " }); return x.status === 400 && /what is left/.test(x.json.error); })());
  t("an unknown request is 404", (await mgr.post(`/api/feedback/999999/closeout`, { answer: "done" })).status === 404);
  t("before anyone speaks Maria is asked about all six of hers", (await floor.get("/api/c/demo/who/requests")).json.to_answer === 6);

  // ---- Done
  const done = await mgr.post(`/api/feedback/${R1}/closeout`, { answer: "done" });
  t("Done: one call, says who closed it", done.status === 200 && done.json.answer === "done" && done.json.by === "Brendan F", done.json);
  const f1 = await fbRow(mgr, R1);
  t("Done: the tile's row carries it", f1.manager_answer === "done" && f1.manager_answer_by === "Brendan F" && f1.manager_answer_person === brendan.person.id && Boolean(f1.manager_answer_at) && f1.floor_answer === null && f1.status === "done", f1);
  const mine1 = (await floor.get("/api/c/demo/who/requests")).json;
  const m1 = mine1.requests.find((x) => x.id === R1);
  t("Done: Maria reads a thank-you on her request", m1.state === "thanked" && m1.line === "Brendan F marked it done. Thank you for sending it in.", m1);
  t("Done: she is no longer asked about it, but keeps her say", mine1.to_answer === 5 && m1.can_answer === true, { to_answer: mine1.to_answer, can: m1.can_answer });
  const news1 = (await floor.get("/api/c/demo/who/news?module=paperline")).json;
  t("Done: the news tells the widget, so the Did it fix it? card does not come back for it", news1.changes[0].items.find((i) => i.id === R1).manager_answer === "done");
  const rec1 = (await mgr.get(`/api/c/demo/record?kind=manager_done&feedback_id=${R1}`)).json; const rr1 = rowsOf(rec1)[0];
  t("Done: on the record with who and the version", rr1 && rr1.actor_role === "manager" && rr1.actor_name === "Brendan F" && rr1.actor_person === brendan.person.id && rr1.version === live.shipped_version && rr1.detail.asked_by === "Maria G", rr1);
  t("Done twice is refused", await (async () => { const x = await mgr.post(`/api/feedback/${R1}/closeout`, { answer: "done" }); return x.status === 409 && /already marked done/.test(x.json.error); })());
  t("a little left after Done is refused too", (await mgr.post(`/api/feedback/${R1}/closeout`, { answer: "little_left", what: "the font on the second line" })).status === 409);

  // ---- a little left
  const LEFT = "the label is bigger on station 1 but station 3 still shows the small one";
  const left = await mgr.post(`/api/feedback/${R2}/closeout`, { answer: "little_left", what: LEFT });
  t("a little left: files a follow-up and says its number", left.status === 200 && left.json.answer === "little_left" && left.json.follow_up.id > R7, left.json);
  const FU = left.json.follow_up.id;
  const fu = await fbRow(mgr, FU), f2 = await fbRow(mgr, R2);
  t("the follow-up is a request of its own, tied to the original, same tool and screen, under the manager's name", fu.follow_up_of === R2 && fu.status === "new" && fu.module === "paperline" && fu.page === PAGE && fu.screen === f2.screen && fu.target_file === f2.target_file && fu.message === LEFT && fu.name === "Brendan F" && fu.person_id === brendan.person.id, fu);
  t("the board knows it came from the manager, and shows the first words", fu.follow_up_origin === "little_left" && fu.follow_up_words === words[1]);
  t("the original stays shipped with the answer and the follow-up's number on it", f2.status === "done" && f2.manager_answer === "little_left" && f2.follow_up_id === FU);
  const rec2 = (await mgr.get(`/api/c/demo/record?feedback_id=${R2}&kind=manager_little_left`)).json; const rr2 = rowsOf(rec2)[0];
  t("on the record word for word with the follow-up's id", rr2 && rr2.after === LEFT && rr2.detail.follow_up_id === FU && rr2.actor_name === "Brendan F", rr2);
  const rec2b = (await mgr.get(`/api/c/demo/record?feedback_id=${FU}&kind=feedback_filed`)).json; const rr2b = rowsOf(rec2b)[0];
  t("the follow-up's own filing says it came from the manager", rr2b && rr2b.detail.follow_up_of === R2 && rr2b.detail.by_manager === true && rr2b.actor_role === "manager", rr2b);
  const m2 = (await floor.get("/api/c/demo/who/requests")).json.requests.find((x) => x.id === R2);
  t("Maria reads that a little is left and is not asked about it", m2.state === "little_left" && m2.can_answer === false && m2.follow_up_id === FU && /a little is left/.test(m2.line), m2);
  t("her answer on it is refused in plain words", await (async () => { const x = await floor.post(`/api/c/demo/who/requests/${R2}/answer`, { answer: "not_quite", what: "still small" }); return x.status === 409 && /manager already put/.test(x.json.error); })());
  t("the manager's follow-up is not in Maria's own list", !(await floor.get("/api/c/demo/who/requests")).json.requests.some((x) => x.id === FU));
  const fuProp = (await mgr.post(`/api/feedback/${FU}/review`)).json;
  t("the proposer is told it is a follow-up", /Follow-up context received for request #/.test(fuProp.rationale) && fuProp.rationale.includes(`#${R2}.`), fuProp.rationale);

  // ---- the floor spoke first: the tile already says so
  t("Maria says fixed on R3", (await floor.post(`/api/c/demo/who/requests/${R3}/answer`, { answer: "fixed" })).status === 200);
  t("then the manager's Done is refused: the floor already answered", await (async () => { const x = await mgr.post(`/api/feedback/${R3}/closeout`, { answer: "done" }); return x.status === 409 && /floor already answered/.test(x.json.error); })());

  // ---- a request with no name on it
  const d4 = await mgr.post(`/api/feedback/${R4}/closeout`, { answer: "done" });
  t("a nameless request is closed out the same way", d4.status === 200 && (await fbRow(mgr, R4)).manager_answer === "done");

  // ---- the manager closes it, the floor still has its say
  t("Done on R5", (await mgr.post(`/api/feedback/${R5}/closeout`, { answer: "done" })).status === 200);
  const nq = await floor.post(`/api/c/demo/who/requests/${R5}/answer`, { answer: "not_quite", what: "the text is bigger but it wraps onto two lines now" });
  t("Maria can still say not quite after the manager's Done", nq.status === 200 && nq.json.follow_up.id > FU, nq.json);
  const f5 = await fbRow(mgr, R5);
  t("both are kept on the request, and her follow-up is hers", f5.manager_answer === "done" && f5.floor_answer === "not_quite" && (await fbRow(mgr, nq.json.follow_up.id)).name === "Maria G" && (await fbRow(mgr, nq.json.follow_up.id)).follow_up_origin === "done");
  t("to her it reads as her not quite, not the thank-you", (await floor.get("/api/c/demo/who/requests")).json.requests.find((x) => x.id === R5).state === "not_quite");

  // ---- who closed it, when nobody is signed in on the manager's screen, and the admin
  const d6 = await mgrAnon.post(`/api/feedback/${R6}/closeout`, { answer: "done" });
  t("a manager's screen with nobody signed in: 'The manager'", d6.status === 200 && d6.json.by === "The manager" && (await fbRow(mgr, R6)).manager_answer_person === null, d6.json);
  t("and the thank-you still reads well", (await floor.get("/api/c/demo/who/requests")).json.requests.find((x) => x.id === R6).line === "The manager marked it done. Thank you for sending it in.");
  const d7 = await admin.post(`/api/feedback/${R7}/closeout`, { answer: "done" });
  t("the admin may close out too", d7.status === 200 && d7.json.by === "Anetix", d7.json);
  t("Maria has nothing left to check", (await floor.get("/api/c/demo/who/requests")).json.to_answer === 0);

  // ---- a change that was taken back off is not closed out
  const r8 = await file(floor, "make the stock table text bigger");
  const p8 = (await mgr.post(`/api/feedback/${r8.id}/review`)).json;
  const run8 = (await mgr.post(`/api/proposals/${p8.id}/decide`, { decision: "approve" })).json;
  const run8id = (run8.run || run8).id;
  await waitFor("run 8 at the deploy gate", async () => { const x = (await board(mgr)).runs.find((y) => y.id === run8id); return x && x.step === "await_deploy" && x.status === "waiting"; });
  await mgr.post(`/api/runs/${run8id}/deploy`);
  await waitFor("R8 live", async () => { const f = await fbRow(mgr, r8.id); return f && f.status === "done"; });
  t("roll it back", (await mgr.post(`/api/runs/${run8id}/rollback`)).status === 200);
  await waitFor("R8 rolled back", async () => /^Rolled back/i.test(((await fbRow(mgr, r8.id)) || {}).outcome || ""));
  t("rolled back: nothing to close out", (await mgr.post(`/api/feedback/${r8.id}/closeout`, { answer: "done" })).status === 409);

  // ---- a module page cannot reach the route (the page policy opens /api/feedback exactly, never what is under it)
  const csp = (await mgr.get(PAGE)).headers.get("content-security-policy") || "";
  const connect = (csp.split(";").find((d) => d.trim().startsWith("connect-src")) || "").trim().split(/\s+/);
  t("the page policy opens /api/feedback itself and nothing below it", connect.some((s) => /\/api\/feedback$/.test(s)) && !connect.some((s) => /\/api\/feedback\/$/.test(s) || /\/api\/?$/.test(s)), connect);

  // ---- loop health and the backup
  const h = (await admin.get("/api/admin/health?days=30")).json;
  const a = h.companies.find((c) => c.slug === "demo").answers;
  t("loop health: the manager's taps are counted apart from the floor's", a.manager_done === 5 && a.manager_little_left === 1 && a.fixed === 1 && a.not_quite === 1, a);
  t("loop health: met and missed count each request once", a.met === 5 && a.missed === 2 && a.unanswered === 0, a);
  const bk = (await admin.get("/api/admin/backup")).json;
  const bf = ((bk.platform || bk.tables || {})["feedback"] || (bk.platform || {})["platform.feedback"] || []).find((x) => x.id === R2);
  t("the backup carries the manager's answer", bf && bf.manager_answer === "little_left", Object.keys(bk).slice(0, 8));

  R.done();
})().catch(R.abort);
