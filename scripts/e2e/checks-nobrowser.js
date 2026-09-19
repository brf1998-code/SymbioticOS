// End to end: the page load when the instance has no browser, or has one that will not start. Same fake-agent
// server as the other scripts, on a fresh database, but started one of two ways:
//   SOS_BROWSER=off ...node server.js                 then  SOS_E2E_EXPECT=off    node scripts/e2e/checks-nobrowser.js
//   SOS_CHROMIUM_PATH=/bin/false ...node server.js    then  SOS_E2E_EXPECT=broken node scripts/e2e/checks-nobrowser.js
// Either way builds must go on, looked at without a browser, and the run log must say so.
const { PW, runner, login, waitFor, board } = require("./lib");
const R = runner(), t = R.t;
const EXPECT = process.env.SOS_E2E_EXPECT || "off";

(async () => {
  const mgr = await login(PW.manager, "demo"), floor = await login(PW.floor, "demo");
  const file = async (msg) => (await floor.post("/api/feedback", { company: "demo", module: "paperline", page: "/c/demo/m/paperline/", message: msg })).json.id;
  const runOf = async (id) => (await board(mgr)).runs.find((r) => r.id === id);
  const start = async (fbId) => { const prop = (await mgr.post(`/api/feedback/${fbId}/review`)).json; const r = (await mgr.post(`/api/proposals/${prop.id}/decide`, { decision: "approve" })).json; return (r.run || r).id; };
  const settle = async (runId) => waitFor(`run ${runId}`, async () => { const x = await runOf(runId); return x && (x.status === "failed" || (x.step === "await_deploy" && x.status === "waiting")) ? x : null; }, 90000);
  const lastErr = (x) => ((x.log || []).filter((l) => l.step === "error").slice(-1)[0] || {}).note || "";

  const a = await settle(await start(await file("make the station label bigger")));
  const pa = a.evidence.checks.pages;
  t("a build still reaches the gate, its screens looked at without a browser", a.step === "await_deploy" && a.status === "waiting" && pa.mode === "static" && pa.screens === 4 && a.evidence.checks.acceptance.total === 3, lastErr(a) || pa);
  t("the run log says which way it looked", /4 screens opened without a browser/.test((a.log || []).map((l) => l.note).join("\n")));
  if (EXPECT === "broken") t("and why: the browser would not start", /would not start/.test(pa.fell_back || "") && /would not start/.test((a.log || []).map((l) => l.note).join("\n")), pa);
  else t("with the browser switched off nothing is said to have failed", !pa.fell_back);
  t("what a screen shows is skipped with a note, not failed", a.evidence.checks.acceptance.ok === true);
  await mgr.post(`/api/runs/${a.id}/cancel`);

  const b = await settle(await start(await file("make the shift clock text bigger BREAKSYNTAX")));
  t("a script that does not parse is still caught", b.status === "failed" && b.evidence.checks.kind === "page" && /a script on the page does not parse/.test(lastErr(b)), lastErr(b));
  await mgr.post(`/api/runs/${b.id}/fix`);
  const b2 = await settle(b.id);
  t("and the fix round clears it", b2.step === "await_deploy" && b2.status === "waiting", lastErr(b2));
  await mgr.post(`/api/runs/${b.id}/cancel`);

  const c = await settle(await start(await file("make the queue count text bigger BREAKPAGE")));
  t("the known gap, stated: an error that only happens when the script runs gets past a no-browser look", c.step === "await_deploy" && c.status === "waiting");
  await mgr.post(`/api/runs/${c.id}/cancel`);
  R.done();
})().catch(R.abort);
