// Symbiotic OS — factory instance server.
// One process serves the improvement board, the platform APIs, and every
// module's live and staged versions.
const path = require("path");
const express = require("express");
const { initPlatformSchema } = require("./src/db");
const registry = require("./src/registry");
const platformApi = require("./src/feedback");
const auth = require("./src/auth");

const PORT = process.env.PORT || 3000;

async function main() {
  await initPlatformSchema();

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  // no-cache on HTML so deploys are visible immediately (playbook lesson)
  app.use((req, res, next) => {
    if (!req.path.startsWith("/assets")) res.set("Cache-Control", "no-cache");
    next();
  });

  app.use("/assets", express.static(path.join(__dirname, "public", "assets")));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/login", (_req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
  app.post("/login", express.json(), auth.loginHandler);
  app.get("/logout", auth.logoutHandler);

  app.use(auth.middleware);  // everything below needs a floor or manager session

  app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
  app.use(platformApi);      // /api/*
  registry.attach(app);      // /m/:module and /staging/m/:module

  await registry.loadAll();

  app.listen(PORT, () => console.log(`Symbiotic OS instance on :${PORT} (auth ${auth.OPEN ? "OPEN: no passwords set" : "on"})`));
}

main().catch((e) => { console.error(e); process.exit(1); });
