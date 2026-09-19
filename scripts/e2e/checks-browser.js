// Headless browser pass for build order item 7 on the manager's board: what a stopped build says in plain
// words, retiring a promise, the line at the deploy gate, and "What this tool promises". Same server as
// checks.js (fake agent, passwords on, a browser on the instance), fresh database. Needs playwright.
//   node scripts/e2e/checks-browser.js
const { BASE, PW, sleep, runner, login, person, waitFor, board } = require("./lib");
const { chromium } = require("playwright");
const R = runner(), t = R.t;

(async () => {
  const mgr = await login(PW.manager, "demo"), floor = await login(PW.floor, "demo"), admin = await login(PW.admin, "");
  const brendan = await person(mgr, "demo", "Brendan F", "manager"); await mgr.post("/api/c/demo/who/sign-in", { id: brendan.id, pin: brendan.pin });
  const maria = await person(mgr, "demo", "Maria G", "floor"); await floor.post("/api/c/demo/who/sign-in", { id: maria.id, pin: maria.pin });
  const file = async (msg) => (await floor.post("/api/feedback", { company: "demo", module: "paperline", page: "/c/demo/m/paperline/", message: msg })).json.id;
  const runOf = async (id) => (await board(mgr)).runs.find((r) => r.id === id);
  const start = async (fbId) => { const prop = (await mgr.post(`/api/feedback/${fbId}/review`)).json; const r = (await mgr.post(`/api/proposals/${prop.id}/decide`, { decision: "approve" })).json; return (r.run || r).id; };
  const settle = async (runId) => waitFor(`run ${runId}`, async () => { const x = await runOf(runId); if (x && x.step === "confirm_requirement" && x.status === "waiting") { await mgr.post(`/api/runs/${runId}/confirm`, {}); return null; } return x && (x.status === "failed" || (x.step === "await_deploy" && x.status === "waiting")) ? x : null; }, 90000);

  // a functionality change that leaves a promise behind, shipped
  const F1 = await file("count the scrapped planes per shift and keep the total");
  const r1 = await start(F1); await settle(r1); await mgr.post(`/api/runs/${r1}/deploy`); await waitFor("r1 live", async () => (await runOf(r1)).status === "deployed");
  // then one that breaks it (and the promise the tool came with)
  const F2 = await file("group the travelers by fold type on the server BREAKPROMISE");
  const r2 = await start(F2); const failed = await settle(r2);
  t("setup: the second build was stopped by an earlier promise", failed.status === "failed" && failed.evidence.checks.kind === "promise");

  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, who) => { page.on("pageerror", (e) => errors.push(`${who}: ${e.message}`)); page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${who} console: ${m.text()}`); }); };
  const ctxM = await browser.newContext({ viewport: { width: 1280, height: 1000 } }); await ctxM.addCookies(mgr.cookies());
  const ctxF = await browser.newContext({ viewport: { width: 1024, height: 768 } }); await ctxF.addCookies(floor.cookies());

  const b = await ctxM.newPage(); watch(b, "board");
  await b.goto(BASE + "/c/demo/"); await b.waitForSelector(`[data-key="run:${r2}"] .findings`);
  const card = b.locator(`[data-key="run:${r2}"]`);
  const text = await card.innerText(), all = await card.evaluate((el) => el.textContent);
  t("the card says an earlier promise broke, in the promise's own words", /This change breaks something an earlier change promised\./.test(text) && /The line board shows the stations, the travelers on the line and the room's settings/.test(text) && /The fake change of v\d+ keeps \/api\/state answering/.test(text), text);
  t("and which request that promise came with, and whose", new RegExp(`It came with request #${F1} from Maria G: "count the scrapped planes`).test(text), text);
  t("what the check saw is folded away from the first read, there for whoever wants it", !/GET \/api\/state/.test(text) && /GET \/api\/state: the answer is \["fake broken promise"\], expected an object/.test(all));
  t("the promises lead; everything else the checks found folds under one line", (await card.locator(".findings:visible").count()) === 2 && /and \d more things? the checks found/.test(text), text);
  t("the manager can send it back, retire a promise, retry or cancel; there is no override", (await card.locator("button", { hasText: "Send findings back to the agent" }).count()) === 1 && (await card.locator("[data-retire]").count()) === 2 && (await card.locator("button", { hasText: /Override/ }).count()) === 0 && (await card.locator("button", { hasText: "Retry from scratch" }).count()) === 1);
  t("no dashes in anything the card says", !/[\u2013\u2014]/.test(text));

  const fb = await ctxF.newPage(); watch(fb, "floor board"); await fb.goto(BASE + "/c/demo/"); await fb.waitForSelector(`[data-key="run:${r2}"]`);
  t("a floor device reads the same words and gets no buttons", /earlier change promised/.test(await fb.locator(`[data-key="run:${r2}"]`).innerText()) && (await fb.locator(`[data-key="run:${r2}"] button`).count()) === 0);

  // retire the promise that came with request F1: a confirm, then a reason
  const dialogs = [];
  b.on("dialog", async (d) => { dialogs.push({ type: d.type(), message: d.message() }); if (d.type() === "prompt") await d.accept("the travelers come back grouped now"); else await d.accept(); });
  await card.locator(`[data-retire^="checks/004-"]`).click();
  await waitFor("the retirement to land", async () => ((await mgr.get("/api/c/demo/modules/paperline/checks")).json.retired || []).length === 1);
  t("retiring asks first, in plain words, then asks why", dialogs.length === 2 && dialogs[0].type === "confirm" && /Retire this promise\?/.test(dialogs[0].message) && /no build of this tool is held to it/.test(dialogs[0].message) && /send the build back to the agent, which keeps the promise/.test(dialogs[0].message) && dialogs[1].type === "prompt" && /kept on the record/.test(dialogs[1].message), dialogs);
  await waitFor("the build to be checked again", async () => { const x = await runOf(r2); return x.status === "failed" && x.evidence.checks.acceptance.retired === 1; }, 60000);
  await sleep(4500);
  const text2 = await card.innerText();
  t("checked again at once: the retired promise is gone from the card, the other still stops it", /The line board shows the stations/.test(text2) && !/It came with request/.test(text2) && (await card.locator("[data-retire]").count()) === 1, text2);

  await card.locator("button", { hasText: "Send findings back to the agent" }).click();
  await waitFor("the fix round to reach the gate", async () => { const x = await runOf(r2); return x.step === "await_deploy" && x.status === "waiting"; }, 60000);
  await b.waitForFunction((id) => /checks passed:/.test((document.querySelector(`[data-key="run:${id}"]`) || {}).innerText || ""), r2, { timeout: 15000 });
  const gate = await card.innerText();
  t("at the gate: one quiet line on what was checked", /checks passed: 6 endpoints answer · 4 promises kept \(1 new\) · 4 screens opened/.test(gate) && !/no browser/.test(gate), gate);
  await card.locator("button", { hasText: /Deploy v\d+ to floor/ }).click();
  await waitFor("r2 live", async () => (await runOf(r2)).status === "deployed");

  // what the tool promises, from the Versions panel
  await b.evaluate(() => openVersions("paperline"));   // the same call paperline's Versions button makes
  await b.waitForSelector("#promises");
  await b.locator("#promises > summary").click();
  const pr = await b.locator("#promises").innerText();
  t("the Versions panel lists what the tool promises, and the retired one apart with who and why", /What this tool promises \(4\)/.test(pr) && /Anyone at a station can ask the stockroom/.test(pr) && /retired by Brendan F: the travelers come back grouped now/.test(pr), pr);
  t("the retired promise is struck through", (await b.locator("#promises s").count()) === 1);

  // the other two stops, as the card words them
  const r3 = await start(await file("make the shift clock text bigger BREAKPAGE")); await settle(r3);
  await b.waitForSelector(`[data-key="run:${r3}"] .findings`, { timeout: 15000 });
  const t3 = await b.locator(`[data-key="run:${r3}"]`).innerText();
  t("a broken screen: which screen, and what a person would hit", /The “Line board \(manager view\)” screen breaks when it opens\./.test(t3) && /a script error on the screen: fakeAgentCalledSomethingThatIsNotThere is not defined/.test(t3) && (await b.locator(`[data-key="run:${r3}"] [data-retire]`).count()) === 0, t3);
  await mgr.post(`/api/runs/${r3}/cancel`);
  const r4 = await start(await file("keep a running tally of folds per station BADCHECK")); await settle(r4);
  await b.waitForSelector(`[data-key="run:${r4}"] .findings`, { timeout: 15000 });
  const t4 = await b.locator(`[data-key="run:${r4}"]`).innerText();
  t("its own check: said as not passing YET, with nothing to retire", /The check that came with this change does not pass yet\./.test(t4) && /answered 200, expected 418/.test(await b.locator(`[data-key="run:${r4}"]`).evaluate((el) => el.textContent)) && (await b.locator(`[data-key="run:${r4}"] [data-retire]`).count()) === 0, t4);
  await mgr.post(`/api/runs/${r4}/cancel`);

  // the admin's loop health
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await ctxA.addCookies(admin.cookies());
  const a = await ctxA.newPage(); watch(a, "admin"); await a.goto(BASE + "/admin"); await a.waitForSelector("#h-table tr td", { timeout: 10000 });
  const at = await a.locator("body").innerText();
  t("loop health tells the test stops apart and counts the promises", /tests: .*broke a promise/.test(at) && /own check/.test(at) && /screen/.test(at) && /promises: \d+ added · 1 retired/.test(at), (at.match(/tests:[^\n]*|promises:[^\n]*/g) || []));
  t("the health table still fits its card", await a.evaluate(() => { const tb = document.getElementById("h-table"), c = tb.closest(".card") || tb.parentElement; return tb.getBoundingClientRect().right <= c.getBoundingClientRect().right + 1; }));

  t("no script errors on any page", errors.length === 0, errors);
  await browser.close();
  R.done();
})().catch(R.abort);
