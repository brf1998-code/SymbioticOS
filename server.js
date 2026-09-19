// Symbiotic OS — instance server.
// One process serves every company's improvement board, the platform APIs,
// every module's live and staged versions, the agent settings pages, and the
// admin view across companies.
const path = require("path");
const express = require("express");
process.env.SOS_BOOT_ID = process.env.SOS_BOOT_ID || String(Date.now()); // pages reload themselves when this changes (a redeploy)
const { initPlatformSchema, q } = require("./src/db");
const registry = require("./src/registry");
const platformApi = require("./src/feedback");
const auth = require("./src/auth");
const diagrams = require("./src/diagrams");
const pipeline = require("./src/pipeline");
const intake = require("./src/intake");
const checks = require("./src/checks");
const record = require("./src/record");
const connections = require("./src/connections");
const people = require("./src/people");

const PORT = process.env.PORT || 3000;
const page = (name) => path.join(__dirname, "public", name);

async function main() {
  await initPlatformSchema();
  await record.init();   // the interaction record: insert-only, what everyone said and decided
  await people.init();        // operator identity: names and PINs per company
  await require("./src/closeloop").init();   // close the loop: my requests, what went live, fixed it / not quite
  await require("./src/acceptance").init();   // acceptance checks that accumulate: the promises a manager retired (the checks themselves live in the module's files)
  await connections.init();   // what modules reach outside through: spreadsheets, label printers (src/connections.js)
  await require("./src/datacheck").init();   // the review-time check that a change's ERP data is available, and the admin's data requests

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  // no-cache on HTML so deploys are visible immediately (playbook lesson)
  app.use((req, res, next) => {
    if (!req.path.startsWith("/assets")) res.set("Cache-Control", "no-cache");
    next();
  });

  app.use("/assets", express.static(path.join(__dirname, "public", "assets")));
  app.get("/health", (_req, res) => res.json({ ok: true, boot: process.env.SOS_BOOT_ID }));
  app.get("/login", (_req, res) => res.sendFile(page("login.html")));
  app.post("/login", express.json(), auth.loginHandler);
  app.get("/logout", auth.logoutHandler);
  // A stand-in ERP for the showroom: SAP-shaped OData answers about the paper
  // line's stock, so a demo company's erp connection has something to talk
  // to (base URL <this host>/erp-demo/). Static rows, read only, no login.
  app.get("/erp-demo/epicor/BaqSvc/:baq/Data", connections.demoEpicor);   // the same, Epicor Kinetic REST v2 shaped
  app.get("/erp-demo/:entity", connections.demoErp);

  app.use(auth.middleware);    // everything below needs a floor, manager, or admin session
  app.use(auth.companyGuard);  // and a floor or manager session reaches its own company only
  app.use(people.attach);      // who is standing at this device, if anyone (a name and a PIN, src/people.js)
  app.use(connections.deviceCookie);   // a random device id per browser, so a print job goes back to the screen that asked

  // Landing: admins go to the admin view; everyone else to their company board
  // (the only company, or a chooser when there are several).
  app.get("/", async (req, res) => {
    const companies = (await q("SELECT slug, name FROM platform.companies ORDER BY created_at")).rows;
    if (req.sosRole !== "admin") return res.redirect(`/c/${req.sosCompany}/`);   // a floor or manager login belongs to one company
    if (companies.length !== 1) return res.redirect("/admin");
    if (companies.length === 1) return res.redirect(`/c/${companies[0].slug}/`);
    res.type("html").send(`<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Symbiotic OS</title>
      <body style="font-family:system-ui,sans-serif;background:#f2f4f7;color:#1c242e;padding:24px"><h1 style="font-size:20px">Pick a company</h1>
      ${companies.map((c) => `<p><a style="font-size:18px;color:#1f3a5f" href="/c/${c.slug}/">${c.name}</a></p>`).join("")}</body>`);
  });
  app.get("/c/:slug/", (_req, res) => res.sendFile(page("index.html")));
  app.get("/c/:slug", (req, res) => res.redirect(`/c/${req.params.slug}/`));
  app.get("/c/:slug/agents", (_req, res) => res.sendFile(page("agents.html")));
  app.get("/c/:slug/diagrams/:module", (_req, res) => res.sendFile(page("diagrams.html")));
  app.get("/c/:slug/checks", auth.requireManager, (_req, res) => res.sendFile(page("checks.html")));
  app.get("/c/:slug/connections", auth.requireManager, (_req, res) => res.sendFile(page("connections.html")));
  app.get("/c/:slug/people", auth.requireManager, (_req, res) => res.sendFile(page("people.html")));
  app.get("/admin", auth.requireAdmin, (_req, res) => res.sendFile(page("admin.html")));

  app.use(intake.router);    // /api/c/:slug/intakes, /api/intakes/*, /api/attachments/* (before platformApi: the attach route parses a bigger body)
  app.use(checks.router);    // /api/c/:slug/checks, /api/runs/:id/label
  app.use(platformApi);      // /api/*
  registry.attach(app);      // /c/:slug/m/:module and /c/:slug/staging/m/:module

  // every deploy redraws the module's diagrams for the new version
  registry.hooks.deployed = (company, mod, version) => diagrams.generate(company, mod, version);
  await registry.loadAll();
  // companies from before per-company passwords keep the shared ones until the admin sets their own
  await auth.ensureAccessRows();
  // builds that were running when the previous process died get a failed
  // status (retry/cancel on the board) instead of a spinner forever
  const orphaned = await pipeline.sweepOrphans();
  if (orphaned) console.log(`[pipeline] ${orphaned} orphaned run(s) marked failed`);
  // modules with no diagrams yet (first boot after this feature) get them now
  for (const m of (await q("SELECT company, name, live_version FROM platform.modules WHERE live_version IS NOT NULL")).rows) {
    diagrams.generate(m.company, m.name, m.live_version).catch((e) => console.error(`diagrams ${m.company}/${m.name}:`, e.message));
  }

  app.listen(PORT, () => console.log(`Symbiotic OS instance on :${PORT} (auth ${auth.OPEN ? "OPEN: no passwords set" : "on"})`));
  // does this instance have a browser for the page load every build gets (src/pageload.js)? say so in the deploy log
  require("./src/pageload").selfTest().catch((e) => console.error("[pageload] self test:", e.message));
}

main().catch((e) => { console.error(e); process.exit(1); });
