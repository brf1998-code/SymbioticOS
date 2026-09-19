// Headless browser pass for the manager's close-out on a shipped tile. Same server as closeout.js (fake agent,
// passwords on); runs on a fresh database or after closeout.js. Needs playwright (a global install is fine).
//   node scripts/e2e/closeout-browser.js
const { BASE, PW, sleep, runner, login, person, fbRow, ship } = require("./lib");
const { chromium } = require("playwright");
const R = runner(), t = R.t;

(async () => {
  const mgr = await login(PW.manager, "demo"), floor = await login(PW.floor, "demo"), admin = await login(PW.admin, "");
  const maria = await person(mgr, "demo", "Maria G", "floor"), brendan = await person(mgr, "demo", "Brendan F", "manager");
  await floor.post("/api/c/demo/who/sign-in", { id: maria.id, pin: maria.pin });
  await mgr.post("/api/c/demo/who/sign-in", { id: brendan.id, pin: brendan.pin });
  const PAGE = "/c/demo/m/paperline/";
  const file = async (msg) => (await floor.post("/api/feedback", { company: "demo", module: "paperline", page: PAGE, message: msg })).json.id;
  const B1 = await file("make the station title text bigger"), B2 = await file("show the order label in bold text");
  const B3 = await file("make the shift label text darker"), B4 = await file("show the count label bigger"), B5 = await file("make the legend text bigger");
  await ship(mgr, [B1]); await ship(mgr, [B2]); await ship(mgr, [B5]);
  const batch = await ship(mgr, [B3, B4]);

  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, who) => { page.on("pageerror", (e) => errors.push(`${who}: ${e.message}`)); page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|Refused to connect|violates the following Content Security Policy/.test(m.text())) errors.push(`${who} console: ${m.text()}`); }); };
  const ctxM = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await ctxM.addCookies(mgr.cookies());
  const ctxF = await browser.newContext({ viewport: { width: 1024, height: 768 } }); await ctxF.addCookies(floor.cookies());

  // ---- the floor tablet first: Maria is asked about what she asked for (the card from push 10 still works)
  const tab = await ctxF.newPage(); watch(tab, "tablet");
  await tab.goto(BASE + PAGE); await tab.waitForSelector("#sos-ask, #sos-ask-pill", { timeout: 8000 });
  t("before anyone speaks the floor is still asked: Did it fix it?", (await tab.locator("#sos-ask, #sos-ask-pill").count()) === 1);

  // ---- the board as a floor device: no manager buttons
  const fboard = await ctxF.newPage(); watch(fboard, "floor board");
  await fboard.goto(BASE + "/c/demo/"); await fboard.waitForSelector("#col-done .card");
  await fboard.locator("#col-done button", { hasText: "Show the other" }).click().catch(() => {});
  t("a floor device sees no Done button and no link", (await fboard.locator("[data-closeout], [data-left], [data-closeout-all]").count()) === 0);

  // ---- the manager's board
  const b = await ctxM.newPage(); watch(b, "board");
  await b.goto(BASE + "/c/demo/"); await b.waitForSelector("#col-done .card");
  await b.locator("#col-done button", { hasText: "Show the other" }).click().catch(() => {});
  const doneBtn = b.locator(`[data-closeout="${B1}"]`), leftLink = b.locator(`[data-left="${B1}"]`);
  t("a shipped tile carries one small Done button and a quiet link", (await doneBtn.count()) === 1 && (await leftLink.count()) === 1 && /Done/.test(await doneBtn.innerText()) && (await leftLink.innerText()) === "a little left");
  const box = await doneBtn.boundingBox();
  t("the button is small: no taller than 32px, no wider than 90px", box && box.height <= 32 && box.width <= 90, box);
  t("before the tap the tile says Maria has not said yet", /has not said yet/.test(await b.locator(`[data-key="fb:${B1}"]`).innerText()));
  await doneBtn.click();
  await b.waitForSelector(`[data-key="fb:${B1}"] .thanks`, { timeout: 8000 });
  const tile1 = await b.locator(`[data-key="fb:${B1}"]`).innerText();
  t("one tap: a check mark and a thank-you by name on the tile", /Done\. Thank you, Maria G\./.test(tile1) && (await b.locator(`[data-key="fb:${B1}"] .thanks .tick`).count()) === 1, tile1);
  t("and the buttons are gone from that tile, 'has not said yet' too", (await b.locator(`[data-closeout="${B1}"], [data-left="${B1}"]`).count()) === 0 && !/has not said yet/.test(tile1));

  // a little left: the box survives the 4 s redraw, wants words, then files the follow-up
  await b.locator(`[data-left="${B2}"]`).click();
  await b.waitForSelector(`#left-${B2}`);
  await b.fill(`#left-${B2}`, "the bold is there on the board");
  await sleep(5200);   // longer than the board's 4 s reload
  t("the box and what was typed survive the board's reload", (await b.locator(`#left-${B2}`).count()) === 1 && (await b.inputValue(`#left-${B2}`)) === "the bold is there on the board");
  await b.fill(`#left-${B2}`, " ");
  await b.locator(`[data-key="fb:${B2}"] button`, { hasText: "Put it on the board" }).click();
  await sleep(400);
  t("no words, nothing sent", (await fbRow(mgr, B2)).manager_answer === null && (await b.locator(`#left-${B2}`).count()) === 1);
  await b.fill(`#left-${B2}`, "the bold is there on the board but the station page still shows it plain");
  await b.locator(`[data-key="fb:${B2}"] button`, { hasText: "Put it on the board" }).click();
  await b.waitForFunction((id) => /says: a little left/.test((document.querySelector(`[data-key="fb:${id}"]`) || {}).innerText || ""), B2, { timeout: 8000 });
  const f2 = await fbRow(mgr, B2);
  t("the shipped tile says who said it and the follow-up's number", new RegExp(`Brendan F says: a little left\\. The follow-up is #${f2.follow_up_id}\\.`).test(await b.locator(`[data-key="fb:${B2}"]`).innerText()));
  await b.locator("#col-new button", { hasText: "Show the other" }).click().catch(() => {});
  const fuTile = await b.locator(`[data-key="fb:${f2.follow_up_id}"]`).innerText();
  t("the follow-up is a new card in Feedback, marked as the manager's, with the first words", new RegExp(`Follow-up to #${B2}: a little left\\.`).test(fuTile) && /checked what went live/.test(fuTile) && /show the order label in bold text/.test(fuTile) && !/not quite/.test(fuTile), fuTile);

  // the batch tile: one Done for the lot; the list of changes stays open across the redraw
  const tileSel = `[data-key="run:${batch.runId}"]`;
  t("a batch tile offers one Done for everything in it", (await b.locator(`${tileSel} [data-closeout-all]`).count()) === 1 && /Done, all 2/.test(await b.locator(`${tileSel} [data-closeout-all]`).innerText()));
  await b.locator(`${tileSel} details > summary`).click();
  await sleep(4600);
  t("its list of changes stays open across the reload, with a Done and a link per request", (await b.locator(`${tileSel} details[open]`).count()) === 1 && (await b.locator(`${tileSel} [data-closeout="${B3}"]`).count()) === 1 && (await b.locator(`${tileSel} [data-left="${B4}"]`).count()) === 1);
  await b.locator(`${tileSel} [data-closeout-all]`).click();
  await b.waitForFunction((sel) => document.querySelectorAll(`${sel} .thanks`).length === 2, tileSel, { timeout: 10000 });
  t("one tap closed both, each with its thank-you, and the button is gone", (await fbRow(mgr, B3)).manager_answer === "done" && (await fbRow(mgr, B4)).manager_answer === "done" && (await b.locator(`${tileSel} [data-closeout-all]`).count()) === 0);

  // a phone: the pair fits the tile
  const ph = await browser.newContext({ viewport: { width: 390, height: 800 } }); await ph.addCookies(mgr.cookies());
  const p = await ph.newPage(); watch(p, "phone"); await p.goto(BASE + "/c/demo/"); await p.waitForSelector("#col-done .card");
  await p.locator("#col-done button", { hasText: "Show the other" }).click().catch(() => {});
  const over = await p.evaluate((id) => { const c = document.querySelector(`[data-key="fb:${id}"]`), btn = c && c.querySelector("[data-closeout]"), a = c && c.querySelector("[data-left]"); if (!btn || !a) return "missing"; const cr = c.getBoundingClientRect(); return [btn, a].some((e) => e.getBoundingClientRect().right > cr.right + 1) || document.documentElement.scrollWidth > window.innerWidth + 1; }, B5);
  t("on a phone the button and the link stay inside the tile and nothing scrolls sideways", over === false, over);

  // ---- a module page in the MANAGER's browser cannot close a request out (the page policy)
  const mp = await ctxM.newPage(); watch(mp, "module page");
  await mp.goto(BASE + PAGE); await mp.waitForSelector("body");
  const blocked = await mp.evaluate(async (id) => { try { const r = await fetch(`/api/feedback/${id}/closeout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "done" }) }); return "reached " + r.status; } catch (e) { return "blocked"; } }, B5);
  t("agent-written code on a module page, manager's session: the close-out route is blocked by the browser", blocked === "blocked" && (await fbRow(mgr, B5)).manager_answer === null, blocked);

  // ---- back on Maria's tablet: nothing nags, the thank-you is there
  await tab.reload(); await tab.waitForSelector("#fbw-mine-open, #fbw-btn, button", { timeout: 8000 }); await sleep(1500);
  const news = (await floor.get("/api/c/demo/who/news?module=paperline")).json;
  const askable = news.changes.flatMap((c) => c.items).filter((i) => i.mine && i.can_answer && !i.floor_answer && !i.manager_answer).map((i) => i.id);
  t("the question only comes back for the one request nobody has spoken about", askable.length === 1 && askable[0] === B5 && (await tab.locator("#sos-ask, #sos-ask-pill").count()) === 1, askable);
  // open the feedback panel, then My requests
  await tab.evaluate(() => { const c = document.getElementById("sos-ask"); if (c) c.remove(); });
  await tab.locator("button", { hasText: /Feedback/i }).first().click();
  await tab.waitForSelector("#fbw-mine-open");
  const thanked = (await floor.get("/api/c/demo/who/requests")).json.requests.filter((x) => x.state === "thanked").length;   // 3 on a fresh database; more after closeout.js
  t("a quiet green badge says what was marked done, beside the amber one for what is still to check", thanked >= 3 && new RegExp(`${thanked} done`).test(await tab.locator("#fbw-thanked").innerText()) && /1 to check/.test(await tab.locator("#fbw-mine").innerText()), await tab.locator("#fbw-mine").innerText());
  await tab.locator("#fbw-mine-open").click();
  await tab.waitForSelector(`[data-request="${B1}"]`);
  const row1 = tab.locator(`[data-request="${B1}"]`);
  t("My requests: a check mark and the thank-you, naming who closed it", /Brendan F marked it done\. Thank you for sending it in\./.test(await row1.innerText()) && /✓/.test(await row1.locator("[data-line]").innerText()));
  t("My requests: only the quiet way back is offered on it", (await row1.locator('[data-answer="fixed"]').count()) === 0 && (await row1.locator('[data-answer="not_quite"]').innerText()) === "Actually, not quite");
  const row2 = tab.locator(`[data-request="${B2}"]`);
  t("My requests: a little left reads plainly, with the follow-up's number, and asks nothing", /a little is left/.test(await row2.innerText()) && new RegExp(`#${f2.follow_up_id}`).test(await row2.innerText()) && (await row2.locator("[data-answer]").count()) === 0);
  t("My requests: the one nobody has spoken about still has both buttons", (await tab.locator(`[data-request="${B5}"] [data-answer="fixed"]`).count()) === 1);
  await tab.locator("#fbw-mine-close").click();
  t("once seen, the green badge is gone", (await tab.locator("#fbw-thanked").count()) === 0);

  // ---- the admin's loop health shows the manager's taps
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await ctxA.addCookies(admin.cookies());
  const a = await ctxA.newPage(); watch(a, "admin"); await a.goto(BASE + "/admin"); await a.waitForSelector("#h-table tr td", { timeout: 10000 });
  const adminText = await a.locator("body").innerText();
  t("loop health: the tile and the company row name the manager's done and a little left", /manager: \d+ done, \d+ a little left/.test(adminText) && /manager: \d+ done · \d+ a little left/.test(adminText), adminText.match(/manager:[^\n]*/g));
  t("the health table still fits its card", await a.evaluate(() => { const tb = document.getElementById("h-table"), card = tb.closest(".card") || tb.parentElement; return tb.getBoundingClientRect().right <= card.getBoundingClientRect().right + 1; }));

  t("no script errors on any page", errors.length === 0, errors);
  await browser.close();
  R.done();
})().catch(R.abort);
