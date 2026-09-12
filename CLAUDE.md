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
- **System review** (`src/review.js`, `platform.reviews`): a whole-module
  re-baseline by a chosen model (Fable by default). Input: guidance docs, all
  live files, feedback and build history, a live-data snapshot from the
  manifest's `/api/...` smoke endpoints. Output: 3 to 12 findings, each filed
  as a held feedback item (`review_id`, status reviewing) with a draft
  proposal (class, target_file, priority in rationale). Building the approved
  set is the normal batch run. One review per module at a time.
- **Diagrams** (`src/diagrams.js`, `platform.diagrams`): after every deploy
  (`registry.hooks.deployed`) the propose model draws two Mermaid sets for the
  new version, data flows and one workflow per role, following
  `principles/DIAGRAMS.md` (the adjustable conventions file; edit it when the
  drawings are not landing). Shown at `/c/<slug>/diagrams/<module>` with a
  version selector and a manager-only Redraw button (`POST
  /api/c/<slug>/diagrams/<module>/regenerate`). Rendered client-side by
  mermaid from cdnjs; if the CDN is unreachable the page shows the source.
  Boot draws diagrams for any module version that has none.
- **Version jumps** (`registry.goToVersion`, board "Versions" panel per
  module, `GET/POST /api/c/<slug>/modules/<m>/versions|goto`): any version,
  back or forward. Switch keeps today's data (additive migrations make older
  code safe on a newer schema; newer code re-applies missing migrations).
  Restore also puts back the data snapshot taken when that version was last
  live. Every jump snapshots the current state first, so jumps are reversible.
  Snapshot retention `SOS_KEEP_SNAPSHOTS` (default 10). The Done card's Roll
  back is one restore step to the nearest older snapshot.
- **Structured calls** (`agent.runStructured`): forced `tool_choice` is
  rejected by Fable 5.1; the runner falls back to `auto` plus an instruction
  and remembers which models refuse. Review and diagram calls use a 16k
  output budget.
- **Batch tiles**: a run with several proposals renders as ONE card on the
  board (in progress and done), with the changes collapsed under "See the N
  changes", the requirement in full at the confirm step, and one "We did"
  line when deployed. The feedback items in it are folded into the tile
  while the run exists (cancel puts them back as their own cards).
- **Plain summaries** (`pipeline.plainSummary`, Haiku, ~a cent): after every
  build, a title (<= 8 words) and a one-to-three sentence "what changed" go
  into `evidence.title` / `evidence.what_changed`; the title becomes the
  version's `notes` (shown in the Versions panel) and what_changed is the
  feedback outcome and the Done card text. `SOS_MODEL_SUMMARY` overrides.
- **Build-agent models**: `MODELS[].agent === false` marks models the bundled
  Claude Code CLI cannot run as the builder (Fable 5.1: the process exits 1
  after its first reply). `agent.buildModelFor` substitutes the company build
  model and the run log says so; build dropdowns leave those models out.
  Fable stays available for proposals, cross-checks and system reviews.
- **Boot id**: `SOS_BOOT_ID` is set at process start and returned by the
  board API; the board reloads itself when it changes, so an open tab picks
  up a redeploy instead of running old page code against new data.
- **Failed checks**: a build that fails the cross-check, the tests, or the
  visual check keeps its draft staged (preview still opens). The manager can
  `POST /api/runs/:id/fix` (agent revises the SAME draft version with the
  findings; `evidence.fix_round`, max `SOS_MAX_FIX_ROUNDS` = 2),
  `POST /api/runs/:id/override` (cross-check only; runs the tests, then the
  deploy gate; `cross_check.overridden` recorded), retry from scratch, or
  cancel (which now unstages the draft).
- **Cost caps**: `SOS_MAX_RUN_USD` (1.50) is per change; a batch run gets
  that times its change count, never above `SOS_MAX_BATCH_USD` (6). The
  batch bar shows the figure; the run records `evidence.cap_usd`. Monthly
  cap unchanged (`SOS_MONTHLY_CAP_USD`).
- **Pending feedback on the board**: `act()` marks the card (greyed, spinner
  line naming the action) and a header pill until the server answers, then
  reloads. Runs in flight show the pulsing step as before.
- **Run diagnostics**: when the agent process dies, the run log gets a `diag`
  entry (model, message count, whether init was seen, stderr tail, prompt
  sizes) and the error says at what stage it died.
- **Module library and tours** (`/admin` top card, `registry.libraryModules`,
  `registry.tourFor`, `GET /api/c/<slug>/modules/<m>/tour`): the repo's
  `modules/*` listed with description (module.json `description`), screens,
  migrations, where it is live, and a Start tour link
  (`/c/<slug>/m/<m>/?tour=1`). The tour engine lives in
  `public/assets/feedback-widget.js`: steps from the module's `tour.json`
  (the live version's copy if it has one, else the library copy), state in
  sessionStorage so it follows across the module's pages, spotlight ring on
  the target selector, centered card when the target is not on screen.
  PRINCIPLES.md rule 8 tells agents to keep tour.json current.
- **Repo imports no longer supersede agent work**: a changed repo module is
  imported as a new version but deploys automatically only if the live
  version is itself repo-sourced. Otherwise it is held (`module_import_held`
  event, "FROM REPO, NOT LIVE" tag in the Versions panel) and the manager
  can Switch to it. The old "export live first" advice still applies when
  the intent is to carry agent changes into the repo copy.
- **Reviews on the board**: only reviews with held items (or running, or
  failed within the hour) stay above the columns; past ones sit under "Past
  system reviews" in the Versions panel. "Build by screen" starts one queued
  run per target file for a review's held items (`buildReviewByScreen`).
- **Board layout** (`public/index.html`): header band, module strip (Open
  live / Preview vN / Diagrams per module), KPI strip, system review toolbar,
  four columns. Platform feedback (about the tool itself, shipped from Cowork)
  sits in a collapsed "Platform requests" strip under the columns, not a
  column of its own.

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
   "Platform requests" strip of the board and is readable from here:
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
