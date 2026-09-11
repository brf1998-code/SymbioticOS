# Symbiotic OS — Workspace Guide (current as of 2026-09-11)

**This file is the single source of truth for how this repo and the live
instance are worked on.** Repo: `brf1998-code/SymbioticOS` (private). Live:
https://sos.finnoperations.com (Railway project `symbiotic-os`, service
`SymbioticOS` + `Postgres`).

## Shape of the instance (since 2026-09-11)

One instance hosts many **companies**. Everything is scoped by company slug:
- `/c/<slug>/` improvement board, `/c/<slug>/agents` model choices and agent
  docs, `/c/<slug>/m/<module>/` live module pages,
  `/c/<slug>/staging/m/<module>/` the preview of a build (amber bar on every
  staged page, reloads/leaves when the staged version changes).
- `/admin` (admin role, `SOS_ADMIN_PASSWORD`; manager password doubles as
  admin when unset) lists companies, their modules, docs, spend, and adds
  companies or library modules to them.
- Module schemas are `mod_<company>_<module>` / `stg_...` / `snap_...`. The
  first boot after this change renamed the old `mod_paperline` schema and
  moved everything under company `demo` (`src/db.js upgradeSingleTenant`).
- Feedback records the **screen** it came from (label + file, resolved from
  the module manifest's `pages` map, which now carries labels). Proposals
  carry `target_file`; the build prompt pins the change to that file; the
  cross-check fails a diff that lands on another screen. The manager can
  change the target in the Adjust form.
- Three model roles per company (propose / build / review), chosen on the
  Agent settings page, with a per-run override in Adjust and in the batch bar.
  `src/agent.js MODELS` is the price table; keep it current with
  platform.claude.com/docs/en/models/overview.
- Agent docs: repo `principles/*.md` are platform-wide and read-only in the
  app; each company has editable docs in `platform.agent_docs` (COMPANY.md
  seeded, module `reference.md` seeded from `principles/module-formats/`).
  Every run records which docs it was guided by (`evidence.docs`).
- Old URLs `/m/<module>` redirect to `/c/demo/m/<module>`.

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
   database (`platform.module_versions.files`). Several proposals can be
   batched into one run (`POST /api/runs/batch`); one run is active per module
   and the rest queue (`build_runs.status = queued`, kicked by `kickQueue`).
   The agent runs with `permissionMode: acceptEdits` and `IS_SANDBOX=1`
   because Railway containers run as root and Claude Code refuses
   `--dangerously-skip-permissions` as root.
2. **Cowork revisions (free).** Brendan asks Claude here; Claude edits the repo
   and pushes; Railway redeploys. This is for platform changes (anything under
   `src/`, `public/`, `server.js`, `principles/`) and for deliberate module
   revisions. Feedback filed about the platform itself lands in the
   "Platform (built by Brendan)" column of the board and is readable from here:
   `GET /api/c/<slug>/feedback/platform` (manager session) or the
   `platform.feedback` table where `module='platform'`. Close them with
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
  `GET https://sos.finnoperations.com/api/c/demo/modules/paperline/export`
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

The Cowork sandbox cannot push to this repo (its git proxy only injects
credentials for repos attached to the session, and the SymbioticOS repo is
not), and the Mac-side Cowork VM has no network. So the push is one command
in Brendan's Terminal:

1. Claude edits files in the mounted folder `sos/` (device_bash / commit_files)
   and says what changed.
2. Brendan runs, in Terminal:
   `cd ~/Documents/Claude/Projects/Symbiotic\ Operating\ System/sos && ./scripts/push.sh "what changed"`
   The script reads the PAT from `../pat.md` (gitignored, bare token or
   `SymbioticOS: <token>`), initializes git on first run, refuses to commit
   `pat.md`/`node_modules`, pushes `main`. Railway auto-deploys.
3. Claude watches the deploy with the Railway MCP (`list-deployments`,
   `get-logs`). Boot log shows `[registry] ...` lines for module imports.

If a future session does have the repo attached as a source, pushing from the
sandbox works the same way (`git push` from a clone) and the Terminal step
goes away.

`node_modules` exists in the mounted folder from an earlier local install; the
sandbox can reuse it (tar without `@anthropic-ai/claude-agent-sdk`, stage,
untar) to run the app locally against the sandbox's Postgres 16
(`pg_ctlcluster 16 main start`, user/db `sos`/`sos`). `SOS_FAKE_AGENT=1` runs
the whole loop with zero API spend. The sandbox has no npm registry access.

## Live instance env vars (Railway service `SymbioticOS`)

`DATABASE_URL` (reference to Postgres), `ANTHROPIC_API_KEY`,
`SOS_FLOOR_PASSWORD`, `SOS_MANAGER_PASSWORD`, `SOS_ADMIN_PASSWORD`,
`SESSION_SECRET`, `SOS_MODEL_PROPOSE` / `SOS_MODEL_BUILD` / `SOS_MODEL_REVIEW`
(instance defaults: claude-sonnet-5 / claude-sonnet-5 / claude-opus-5;
companies override on their Agent settings page), `SOS_MAX_RUN_USD` (per
build run, default 1.50), `SOS_MONTHLY_CAP_USD` (default 25),
`SOS_FAKE_AGENT` (0/1).
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
