// The page load: every screen of a staged build is opened before the deploy
// gate, and the build stops on a script error a person would hit. Product
// review of 2026-09-18, item 7: "a headless page load that fails on script
// errors, since that is how a UI build most likely breaks". Until this the
// UI lane's only check past the module gate was "the page answers".
//
// Two ways to look, decided by Brendan 2026-09-19 (a real browser, with a
// fallback):
//
//   browser   headless Chromium through puppeteer-core. Each screen is opened
//             with a MANAGER session for that one company (never the platform's
//             internal token: the page is agent-written), requests to anything
//             but this instance are refused, and what counts is: the screen
//             answers below 400, no uncaught script error or unhandled
//             rejection, none of the module's own calls answers 500 or more.
//             A 4xx on a call and console.error lines are notes, not stops.
//   static    no browser on the instance (or it would not start, or
//             SOS_BROWSER=off): every inline script is parsed for syntax, every
//             screen is asked for over HTTP. Catches the page whose script does
//             not parse and the screen that answers 404; misses errors that only
//             happen when the script runs. The run log says which way it looked.
//
// Either way, when a staged screen shows a problem the same screen is looked at
// on the LIVE version too, and a problem that is already on the floor word for
// word is not held against the build (the same rule as the module gate's "inherited"). The demo line is
// imperfect on purpose; a build must not be blamed for what it did not touch.
//
// Chromium runs with --no-sandbox because Railway containers run as root and
// Chromium refuses a sandbox there. That is agent-written page code in an
// unsandboxed renderer on the platform's host. It is no wider than what is
// already true until trade study option C (agent-written routes.js runs inside
// the platform's own process), but it is one more reason for C.
const fs = require("fs");
const vm = require("vm");
const { execFileSync } = require("child_process");

const SETTLE_MS = Number(process.env.SOS_PAGE_SETTLE_MS || 1500);
const NAV_TIMEOUT_MS = Number(process.env.SOS_PAGE_TIMEOUT_MS || 15000);
const TOTAL_TIMEOUT_MS = Number(process.env.SOS_PAGELOAD_TOTAL_MS || 90000);

// ---- where the browser is ------------------------------------------------------------------------
let cachedPath;
function browserPath() {
  if ((process.env.SOS_BROWSER || "auto").toLowerCase() === "off") return null;
  if (cachedPath !== undefined) return cachedPath;
  const tries = [process.env.SOS_CHROMIUM_PATH, process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_BIN];
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try { tries.push(execFileSync("which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); } catch (e) { /* not on the PATH */ }
  }
  // a playwright download, which is what the development sandbox has
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pw && fs.existsSync(pw)) for (const d of fs.readdirSync(pw).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) tries.push(`${pw}/${d}/chrome-linux/chrome`);
  cachedPath = tries.find((p) => p && fs.existsSync(p)) || null;
  return cachedPath;
}
function resetCache() { cachedPath = undefined; }

// ---- pure: screens to open, and telling a new problem from one already on the floor ----------------
// manifest.pages routes -> concrete paths. A route with a parameter takes its value from a smoke path that
// fits it ("/station/:seq" + smoke "/station/1"), else 1.
function screenPaths(manifest) {
  const smoke = (manifest.smoke || []).map(String);
  const out = [];
  for (const [route, v] of Object.entries(manifest.pages || {})) {
    const file = typeof v === "string" ? v : v && v.file, label = (v && v.label) || route;
    let path = route;
    if (/:[^/]+/.test(route)) {
      const re = new RegExp("^" + route.replace(/:[^/]+/g, "[^/]+") + "/?$");
      path = smoke.find((s) => re.test(s.split("?")[0])) || route.replace(/:[^/]+/g, "1");
    }
    if (!out.some((o) => o.path === path)) out.push({ route, path, file, label });
  }
  return out;
}
// The same problem reads the same on live and on staging once the mount and the numbers that move are taken out.
function normalize(msg) {
  return String(msg || "").replace(/\/staging\/m\//g, "/m/").replace(/https?:\/\/[^/\s]+/g, "").replace(/:\d+:\d+/g, "").replace(/\bv\d+\b/g, "v").replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "").replace(/\s+/g, " ").trim();
}
const keyOf = (p) => `${p.kind}|${p.screen}|${normalize(p.what)}`;
// problems: [{ kind, screen, what }]. Returns { fresh, inherited }.
function againstFloor(problems, floorProblems) {
  const floor = new Set((floorProblems || []).map(keyOf));
  return { fresh: problems.filter((p) => !floor.has(keyOf(p))), inherited: problems.filter((p) => floor.has(keyOf(p))) };
}
// Inline scripts of a page that do not parse. [{ what }]
function syntaxProblems(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  while ((m = re.exec(String(html || "")))) {
    n++;
    const attrs = m[1] || "", code = m[2] || "";
    if (/\bsrc\s*=/.test(attrs) || !code.trim()) continue;
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || "";
    if (type && !/^(text|application)\/(java|ecma)script$/i.test(type) && type !== "module") continue;   // json, templates
    if (type === "module") continue;   // vm.Script cannot parse import/export; the browser check covers these
    try { new vm.Script(code, { filename: `script-${n}` }); }
    catch (e) { out.push({ what: `a script on the page does not parse: ${e.message}${e.stack && /script-\d+:(\d+)/.test(e.stack) ? ` (line ${/script-\d+:(\d+)/.exec(e.stack)[1]} of script ${n})` : ""}` }); }
  }
  return out;
}

// ---- the static way --------------------------------------------------------------------------------
async function staticLook({ base, screens, files, cookie }) {
  const problems = [];
  for (const s of screens) {
    let status = 0;
    try { status = (await fetch(base + s.path, { headers: { Cookie: cookie || "", Accept: "text/html" }, redirect: "manual", signal: AbortSignal.timeout(NAV_TIMEOUT_MS) })).status; } catch (e) { status = 0; }
    if (!status || status >= 400) problems.push({ kind: "screen", screen: s.label, path: s.path, what: `the screen answered ${status || "nothing"}` });
    for (const p of syntaxProblems(files && files[s.file])) problems.push({ kind: "script", screen: s.label, path: s.path, what: p.what });
  }
  return problems;
}

// ---- the browser way --------------------------------------------------------------------------------
async function launch() {
  const exe = browserPath();
  if (!exe) return null;
  const puppeteer = require("puppeteer-core");
  return puppeteer.launch({
    executablePath: exe, headless: true, timeout: 30000,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-sync", "--mute-audio", "--hide-scrollbars"],
  });
}
// A session over one browser: open(url, cookie) -> problems and notes; visit(url, cookie, { visible, selector }).
async function session(origin) {
  const browser = await launch();
  if (!browser) return null;
  const host = new URL(origin).host;
  const openPage = async (cookie) => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    await page.setRequestInterception(true);
    // nothing leaves this instance: no off-platform loads, no label printer on localhost:9100, no file: or data: navigation
    page.on("request", (req) => { let ok = false; try { const u = new URL(req.url()); ok = (u.protocol === "http:" || u.protocol === "https:") && u.host === host; if (u.protocol === "data:" || u.protocol === "blob:") ok = !req.isNavigationRequest(); } catch (e) { ok = false; } (ok ? req.continue() : req.abort("blockedbyclient")).catch(() => {}); });
    for (const part of String(cookie || "").split(";").map((x) => x.trim()).filter(Boolean)) { const i = part.indexOf("="); await ctx.setCookie({ name: part.slice(0, i), value: part.slice(i + 1), domain: new URL(origin).hostname, path: "/", httpOnly: true }); }
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    return { ctx, page };
  };
  return {
    mode: "browser",
    async open(url, cookie, screen) {
      const { ctx, page } = await openPage(cookie);
      const problems = [], notes = [];
      const own = new URL(url).pathname.replace(/\/m\/([^/]+)\/.*$/, "/m/$1/");
      page.on("pageerror", (e) => {
        const msg = String((e && e.message) || e).split("\n")[0].slice(0, 300);
        // an error thrown from the platform's own scripts (the feedback button, the print helper) is ours to fix, not this build's
        if (/\/assets\/[\w.-]+\.js/.test(String((e && e.stack) || ""))) { notes.push(`${screen.label}: a platform script said "${msg}"`); return; }
        problems.push({ kind: "script", screen: screen.label, path: screen.path, what: `a script error on the screen: ${msg}` });
      });
      page.on("response", (res) => { try { const u = new URL(res.url()); const st = res.status(); if (u.pathname.startsWith(own) && !res.request().isNavigationRequest()) { const rel = u.pathname.slice(own.length - 1); if (st >= 500) problems.push({ kind: "call", screen: screen.label, path: screen.path, what: `the screen's own call to ${rel} answered ${st}` }); else if (st >= 400) notes.push(`${screen.label}: its call to ${rel} answered ${st}`); } } catch (e) { /* not a url */ } });
      page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|Content Security Policy|blockedbyclient|ERR_BLOCKED_BY_CLIENT/i.test(m.text())) notes.push(`${screen.label}: the console said "${m.text().slice(0, 200)}"`); });
      try {
        const res = await page.goto(url, { waitUntil: "load" });
        const st = res ? res.status() : 0;
        // sent somewhere else (the login page, most likely: the platform's own session was not taken)? Then nothing
        // was looked at, and saying "no errors" would be a lie. Throw, and the caller looks again without a browser.
        const landed = new URL(page.url()).pathname;
        if (!landed.startsWith(own.replace(/\/$/, ""))) { await ctx.close().catch(() => {}); throw new Error(`the platform's browser was sent to ${landed} instead of the screen`); }
        if (!st || st >= 400) problems.push({ kind: "screen", screen: screen.label, path: screen.path, what: `the screen answered ${st || "nothing"}` });
        await new Promise((r) => setTimeout(r, SETTLE_MS));
      } catch (e) { if (/platform's browser was sent to/.test(e.message)) throw e; problems.push({ kind: "screen", screen: screen.label, path: screen.path, what: /timeout/i.test(e.message) ? `the screen did not finish loading in ${Math.round(NAV_TIMEOUT_MS / 1000)} seconds` : `the screen could not be opened: ${e.message.split("\n")[0].slice(0, 200)}` }); }
      await ctx.close().catch(() => {});
      return { problems, notes };
    },
    async visit(url, cookie, { visible = [], selector = [] } = {}) {
      const { ctx, page } = await openPage(cookie);
      const out = { missingText: [...visible], missingSelector: [...selector] };
      try {
        await page.goto(url, { waitUntil: "load" });
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        const text = await page.evaluate(() => document.body ? document.body.innerText : "");
        out.missingText = visible.filter((v) => !text.includes(v));
        out.missingSelector = [];
        for (const sel of selector) { let n = 0; try { n = await page.$$eval(sel, (els) => els.length); } catch (e) { n = 0; } if (!n) out.missingSelector.push(sel); }
      } catch (e) { /* every expectation stays missing; the step says so */ }
      await ctx.close().catch(() => {});
      return out;
    },
    async close() { await browser.close().catch(() => {}); },
  };
}

// ---- the whole look -------------------------------------------------------------------------------
// origin: "http://127.0.0.1:8080"; mounts: { staged, live } paths like "/c/demo/staging/m/paperline" (live null for a
// module that is not on the floor yet); manifest/files: the staged version's; liveManifest/liveFiles: the floor's;
// cookie: a manager session for this company; browser: an open session() to reuse, or undefined to open one here.
async function look({ origin, mounts, manifest, files, liveManifest = null, liveFiles = null, cookie, browser }) {
  const screens = screenPaths(manifest);
  const floorScreens = liveManifest ? screenPaths(liveManifest) : [];
  let own = false, b = browser, fellBack = null;
  if (b === undefined) { try { b = await session(origin); own = true; } catch (e) { b = null; fellBack = `the browser would not start (${String(e.message).split("\n")[0].slice(0, 160)})`; console.error("[pageload] browser launch failed:", e.message); } }
  const started = Date.now();
  let problems = [], floor = [], notes = [], mode = b ? "browser" : "static";
  try {
    if (b) {
      for (const s of screens) {
        if (Date.now() - started > TOTAL_TIMEOUT_MS) { notes.push(`stopped opening screens after ${Math.round(TOTAL_TIMEOUT_MS / 1000)} seconds; ${s.label} and later were not opened`); break; }
        const r = await b.open(origin + mounts.staged + s.path, cookie, s); problems.push(...r.problems); notes.push(...r.notes);
      }
      // only look at the floor when there is something to compare: it costs the same again
      if (problems.length && mounts.live) for (const s of floorScreens.filter((f) => problems.some((p) => p.screen === f.label))) floor.push(...(await b.open(origin + mounts.live + s.path, cookie, s)).problems);
    } else {
      problems = await staticLook({ base: origin + mounts.staged, screens, files, cookie });
      if (problems.length && mounts.live) floor = await staticLook({ base: origin + mounts.live, screens: floorScreens, files: liveFiles, cookie });
    }
  } catch (e) {
    // a browser that dies halfway must never decide a build: look again without it
    console.error("[pageload] browser look failed, falling back:", e.message);
    fellBack = `the browser stopped (${String(e.message).split("\n")[0].slice(0, 160)})`;
    mode = "static"; notes = [];
    problems = await staticLook({ base: origin + mounts.staged, screens, files, cookie });
    floor = problems.length && mounts.live ? await staticLook({ base: origin + mounts.live, screens: floorScreens, files: liveFiles, cookie }) : [];
  } finally { if (own && b) await b.close(); }
  const { fresh, inherited } = againstFloor(problems, floor);
  return { ok: fresh.length === 0, mode, screens: screens.length, problems: fresh.slice(0, 12), inherited: inherited.length, notes: [...new Set(notes)].slice(0, 12), ...(fellBack ? { fell_back: fellBack } : {}), ms: Date.now() - started };
}

// At boot, once, behind the listen: does the browser this instance has actually start? The deploy log then says
// which way builds will be looked at, instead of the first build finding out.
async function selfTest() {
  const exe = browserPath();
  if (!exe) { console.log(`[pageload] no browser on this instance${(process.env.SOS_BROWSER || "").toLowerCase() === "off" ? " (SOS_BROWSER=off)" : ""}: screens are checked without one (script syntax, the screen answers)`); return { mode: "static" }; }
  try {
    const b = await launch(); const v = await b.version(); await b.close();
    console.log(`[pageload] browser starts: ${v} at ${exe}; every build's screens are opened in it before the deploy gate`);
    return { mode: "browser", version: v };
  } catch (e) {
    console.error(`[pageload] the browser at ${exe} would not start (${String(e.message).split("\n")[0].slice(0, 200)}); screens are checked without one until it does`);
    return { mode: "static", error: e.message };
  }
}

const oneLine = (p) => (p.problems.length ? `${p.problems[0].screen}: ${p.problems[0].what}${p.problems.length > 1 ? ` (and ${p.problems.length - 1} more)` : ""}` : "");
function forAgent(p) {
  return p.problems.map((x) => `- The "${x.screen}" screen (${x.path}): ${x.what}. ${x.kind === "script" ? "A person opening that screen would hit this. Find what your change did to cause it and fix it." : x.kind === "call" ? "The screen asks the server for this when it opens and the server failed." : "The screen has to open."}`).join("\n");
}

module.exports = { look, session, selfTest, staticLook, screenPaths, normalize, againstFloor, syntaxProblems, browserPath, resetCache, oneLine, forAgent };
