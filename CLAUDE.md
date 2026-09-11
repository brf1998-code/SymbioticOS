# Symbiotic OS — Workspace Guide (current as of 2026-09-10)

**This file is the single source of truth for how this repo and the live
instance are worked on.** Repo: `brf1998-code/SymbioticOS` (private). Live:
https://sos.finnoperations.com (Railway project `symbiotic-os`, service
`SymbioticOS` + `Postgres`).

## What this is

The product version of Brendan's operations methodology: one app per factory
that hosts an improvement board, every module (live and staged versions), and an
agent build service that turns approved floor feedback into deployed changes.
See `docs/ROADMAP.md` for the vision and `README.md` for the run-it map.

First module: **Paper Airplane Line** (`modules/paperline/`). A five-station
line making paper airplanes in 2-minute shifts. It is deliberately a working but
imperfect v1 so participants feel the improvement loop. `docs/DEMO-RUNBOOK.md`
is the facilitator script.

## Two revision paths, and which one to use

1. **In-app loop (costs API money, runs on the live instance).** Floor feedback
   on a module page → manager clicks Review with AI → proposal → approve →
   agent builds a new module version into staging → manager deploys. This is
   what participants exercise. It only touches module files stored in the
   database (`platform.module_versions.files`).
2. **Cowork revisions (free).** Brendan asks Claude here; Claude edits the repo
   and pushes; Railway redeploys. This is for platform changes (anything under
   `src/`, `public/`, `server.js`, `principles/`) and for deliberate module
   revisions. Feedback filed about the platform itself lands in the
   "Platform (built by Brendan)" column of the board and is readable from here:
   `GET /api/feedback/platform` (manager session) or the `platform.feedback`
   table where `module='platform'`. Close them with
   `POST /api/feedback/:id/close {outcome}` after shipping.

### How module versions work (read before touching `modules/`)

- The **database is the source of truth** for module versions. Version
  directories on disk (`data/modules/...`) are a cache rebuilt at boot. Railway's
  container disk is ephemeral and that is fine.
- `modules/<name>/` in the repo is the **seed source**. At boot the platform
  hashes it; a new module is imported as v1, and a changed hash is imported as
  the next version and deployed (snapshot first, migrations applied).
- So: to revise a module from Cowork, edit `modules/<name>/`, push, done. But
  if the in-app agent has built versions since the last import, the repo copy
  is behind. **Export the live version first** and edit that:
  `GET https://sos.finnoperations.com/api/admin/modules/paperline/export`
  (manager cookie) returns `{files}`; write them over `modules/paperline/`,
  then make the change. Otherwise the agent's changes get superseded (they
  remain in the DB and are still rollback-able, but not live).
- **Never edit an existing migration file.** Migrations are applied once per
  schema by filename; edits to `001.sql` do nothing on the live database. Add
  `002.sql` etc. Additive only (CREATE TABLE / ADD COLUMN / CREATE INDEX /
  INSERT). The validator rejects DROP/UPDATE/DELETE/etc. and even the bare
  word `do` anywhere in a statement, so mind seed text.
- Migration seed values (starting inventory, settings) only apply to a fresh
  database. To change them on the live instance use the module's API or SQL.

## Deploying

The Cowork sandbox has no npm registry access and cannot run git against the
mounted folder. Procedure:

1. Brendan drops a fine-grained PAT (Contents: read/write on SymbioticOS) in
   `pat.md` at the Symbiotic Operating System folder root as `SymbioticOS: …`.
   Gitignored. Extract with grep; **never print the token**.
2. In the sandbox: `git clone https://<token>@github.com/brf1998-code/SymbioticOS.git /tmp/sos-remote`,
   copy changed files over, inspect `git status` / `git diff --stat` for
   accidental deletions, commit, push to `main`. Railway auto-deploys.
3. Mirror the same files into the mounted folder `sos/` with
   `device_commit_files` so Brendan's local copy matches (the folder is not a
   git checkout; the repo is canonical).
4. Watch the deploy: Railway MCP `list-deployments` / `get-logs`. Boot log
   shows `[registry] ...` lines for module imports.

`node_modules` exists in the mounted folder from an earlier local install; the
sandbox can reuse it (tar without `@anthropic-ai/claude-agent-sdk`, stage,
untar) to run the app locally against the sandbox's Postgres 16
(`pg_ctlcluster 16 main start`, user/db `sos`/`sos`). `SOS_FAKE_AGENT=1` runs
the whole loop with zero API spend.

## Live instance env vars (Railway service `SymbioticOS`)

`DATABASE_URL` (reference to Postgres), `ANTHROPIC_API_KEY`,
`SOS_FLOOR_PASSWORD`, `SOS_MANAGER_PASSWORD`, `SESSION_SECRET`,
`SOS_MODEL` (default claude-sonnet-4-5), `SOS_MAX_RUN_USD` (per build run,
default 1.50), `SOS_MONTHLY_CAP_USD` (default 25), `SOS_FAKE_AGENT` (0/1).
Passwords live only in Railway; never commit them.

## Hard rules

- Repo is private but treat it as clean-room: no Langmuir code, data, names,
  or branding. Nothing from the Finn Operations folder either.
- No em or en dashes in anything a participant reads (pages, proposals copy,
  runbook). Hyphens in compound words are fine.
- Module pages compute `base` from `location.pathname`; never hard-code
  `/m/paperline`, the same files serve at `/staging/m/paperline`.
- The manager gate is structural: nothing reaches a live module without a
  human approval. Do not add auto-deploy paths.
