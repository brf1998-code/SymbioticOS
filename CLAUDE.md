# Symbiotic OS — Workspace Guide (current as of 2026-09-17)

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
- **Build-agent models, Agent SDK 0.3.x (2026-09-17)**: every model in
  `MODELS` can be the builder, Fable 5.1 included. The old "Fable exits 1
  after its first reply" was the Agent SDK pinned at 0.1.77 (January 2026,
  before Fable existed); `package.json` now pins `^0.3.274`, which bundles
  Claude Code 2.1.274 as a native binary per platform (optional dependency
  `@anthropic-ai/claude-agent-sdk-linux-x64` on Railway) and needs
  `@anthropic-ai/sdk` >= 0.93, `zod` 4 and `@modelcontextprotocol/sdk` as
  dependencies. `package-lock.json` must be regenerated in the cloud sandbox
  (the Mac VM has no network) whenever dependencies change. `runAgent` now
  passes `tools` (the whole tool list: Read, Write, Edit, Glob, Grep and
  nothing else; the init message confirms it), `effort` (`SOS_AGENT_EFFORT`,
  default `high`, decided 2026-09-17: high everywhere) and `maxBudgetUsd` at
  three times the run cap as a far safety rail (our own estimate still stops
  the run at the cap). `agentEnv()` sets `CLAUDE_CODE_NO_MODEL_FALLBACK=1` so
  the CLI can never swap models silently, and the run records every model id
  the agent reported (`evidence.models_seen`, plus `evidence.effort`); the
  board shows a check mark after the model name when it matches and a red
  "ran on X" when it does not. A turn that ends on an API error comes back
  from this SDK as subtype `success` with `is_error`; the runner throws on it
  instead of storing the error text as the build summary. `MODELS[].agent
  === false` still works to keep a model out of builds; nothing uses it now.
  Structured calls keep the `tool_choice` fallback (Fable still rejects a
  forced tool).
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
- **Module filter** (2026-09-17, `public/index.html`): with more than one
  module, each module card's title in the strip is a toggle and an "All
  modules" chip sits in front. `SEL` (a Set of module names, null = all) is
  read from `?m=a,b` first, else `localStorage["sos.modules.<slug>"]`, is
  normalized against the company's modules (unknown names dropped, empty or
  every module = all) and always written back to both, so the URL shows the
  pick in force and can be linked. Clicking a title from "all" shows only
  that module; clicking again adds or removes. `visible(module)` gates the
  four columns, the KPI counts, batch tiles, the batch panels, the review
  bars and the system review default (first visible module); spend, build
  model and the Platform requests strip ignore it. `load()` fetches and
  `render()` draws from `DATA`, so a toggle redraws without a fetch.
- **Board layout** (`public/index.html`): header band, module strip (Open
  live / Preview vN / Diagrams per module), KPI strip, system review toolbar,
  four columns. The band's top right holds the company's **board QR code**
  (`GET /api/c/<slug>/qr.svg?px=N`, drawn by `src/qrcode.js`, a dependency-free
  byte-mode encoder at error correction M, versions 1 to 10). It encodes
  `<proto>://<host>/c/<slug>/` from the request headers, so each company's code
  opens that company's board (login first if the scanner has no session).
  Clicking the tile opens a card with a large code, the link, Copy link and
  Print; the print stylesheet prints just that card as a wall sign. The band
  is two columns (title + module strip on the left, the 112px QR tile
  spanning both on the right). Platform feedback (about the tool itself,
  shipped from Cowork) sits in a collapsed "Platform requests" strip under
  the columns, not a column of its own.
- **Batches are server state** (`platform.batches`, `feedback.batch_id`,
  routes `POST /api/c/<slug>/batch/add|remove` with `feedback_ids`,
  `POST /api/c/<slug>/batch/<id>/clear|build`): one open batch per module
  (`run_id IS NULL`). Cards join or leave at the New or Reviewing station
  ("Add to batch" greys to "In batch" plus a Remove link; Approve build and
  Review with AI grey out while the item is in a batch). The panels at the
  top of the Feedback and Reviewing columns carry the actions: "Review the N
  new with AI" (one proposal call per item), "Build the N together" (only
  reviewed items go in; the rest leave the batch), Clear. Build sets
  `batches.run_id`; cancel and deploy clear `batch_id`. The old client-side
  checkbox selection and sticky batch bar are gone. "+1 seen again" is gone
  from cards; new feedback has Decline (`/api/feedback/:id/close`).
- **Requirement gate** (functionality lane): the propose model now returns
  `bluf` (one sentence), `items` (one sentence per change) and the full
  `requirement`; stored in `evidence.req_bluf` / `evidence.req_items`. The
  card shows the BLUF, one check box per change, the full text under "See
  the full requirement", and Confirm stays disabled until every box is
  ticked (ticks live in the page's `CHECKED` set so the 4s reload keeps
  them). "Adjust the requirement" opens the full text for editing before
  confirming (`POST /api/runs/:id/confirm {requirement}`).
- **Abort and orphans**: `POST /api/runs/:id/cancel` now also works on a
  `running` run: the build agent's AbortController (`pipeline.ACTIVE`) is
  fired, the run is marked cancelled before the agent error lands
  (`failRun` leaves a cancelled run alone), a never-staged draft version is
  dropped (`registry.dropDraftVersion`), proposals go back to reviewing.
  Board: "Abort build" on running cards. At boot `pipeline.sweepOrphans`
  marks every `running` row failed ("the platform restarted while this build
  was running") and kicks the queues; that is what a build "paused with no
  way forward" after a redeploy was.
- **Preview highlights**: the build prompt asks the agent to put
  `data-changed="vN"` on every element it adds or visibly changes
  (PRINCIPLES.md rule 9; the cross-check prompt says this is expected). The
  staged bar (`feedback-widget.js`) outlines those elements with a NEW tag,
  and "what changed?" opens a panel with the run's plain summary and the
  screens whose files differ from the floor version, as links
  (`GET /api/c/<slug>/modules/<m>/staged-changes`, a text compare of the two
  versions, no tokens).
- **Rollback asks first** (confirm dialog on every Roll back button;
  Switch/Restore in the Versions panel already did).
- **Company brand** (`src/brand.js`, `companies.brand` JSONB): the admin
  gives a website when creating a company (or later, "Build the brand
  guide" / "Rebuild" on the company card, `POST
  /api/admin/companies/<slug>/brand {url, model}`). The server fetches the
  page plus up to 5 stylesheets (browser UA; the build agent has no
  network), extracts title, meta, icons, logo imgs, hex/rgb colors by
  frequency, CSS custom properties, font stacks, visible text, and asks the
  chosen model (Fable by default) to REWRITE the platform `principles/STYLE.md`
  for the brand (same sections, same specificity) plus structured fields
  (primary/accent/background/ink, font, company_name, tone). The result is
  the company-wide agent doc `STYLE.md` (editable on the Agent settings
  page). `agent.guidanceFor` drops the platform STYLE.md whenever a company
  STYLE.md exists, so an agent never sees two style files (with both in the
  prompt it kept the platform defaults; found 2026-09-14 with a Stanley
  Black and Decker test). Boot renames any leftover BRAND.md to STYLE.md.
  Site fetch: two tries at 30s for the page; when it still fails (bot
  protection: SBD hangs, langmuirsystems.com answers 403) the guide is built
  anyway from the model's knowledge of the brand, `brand.site_read=false`
  and the admin card says so; icons fall back to the DuckDuckGo/Google
  favicon services. The restyle proposal names the default hex values to replace; the icon (largest apple-touch-icon, else favicon, as a
  data URL) is served at `GET /api/c/<slug>/icon` (default SVG mark when
  none) and linked as favicon + apple-touch-icon on the board and on every
  module page (`registry.widgetInject`). The board band takes the primary
  color and the accent (CSS variables `--navy`/`--amber`), shows the icon
  next to the title. Status building/done/failed on the admin card (polls
  while building); cost counts toward monthly spend. **Restyle** (`POST
  /api/admin/companies/<slug>/modules/<m>/restyle`, and automatically when a
  module is added to a company whose guide is done): one approved UI
  proposal per screen (feedback items by "Brand"), built as one batch run
  that waits at the deploy gate, so the manager previews the branded module
  before it goes live. Fake mode returns a canned guide.
- **Company delete** (`POST /api/admin/companies/<slug>/delete
  {confirm_slug, password}`): admin role plus the slug typed back plus the
  admin password checked server-side (`auth.checkAdminPassword`); refused
  while the company has running/queued/waiting runs. Drops the company's
  live and staging schemas and its snapshots, deletes runs, proposals,
  feedback, batches, docs, reviews, diagrams, versions, modules, the row,
  the mounts and the materialized files; logs `company_deleted`. Modal on
  the admin page. Pilot-stage hardening (a second factor) is still to do.
- **Backup and restore** (`src/backup.js`): `GET /api/admin/backup` streams
  one JSON file (`format: sos-backup-1`) with every platform table and every
  `mod_*` schema's rows plus DDL (columns, sequences, constraints, indexes).
  `POST /api/admin/restore {password, backup}` (admin password; refused
  while a build runs; own 300mb body parser) rebuilds the module schemas
  from the DDL, refills the platform tables, resets sequences, then exits
  the process (Railway restarts it; boot re-materializes versions and
  mounts). Admin page: Download backup / Restore from a backup file. Railway's
  own Postgres backups (Backups tab on the Postgres service) are the other
  half; the MCP cannot switch them on.
- **Agent doc duplicates fixed**: `UNIQUE (company, module, name)` never
  fired for company-wide docs (module NULL), so every boot seeded another
  COMPANY.md and every save added a row, and guidance carried them all.
  `db.dedupeCompanyDocs` cleans up at boot and adds a partial unique index;
  all writes go through `db.upsertDoc`.
- **Schema names** are sanitized (`migrate.ident`): a slug with a dash gets
  `_` in `mod_`/`stg_`/`snap_` names, so dashed slugs work.
- **What the platform lends a module** (`registry.moduleServices`, on the
  ctx handed to `routes.js`): `peer(name)` is a READ ONLY query function on
  a sibling module's live tables (null if that module is not live for the
  company), `agentDoc(name)` returns the company's editable copy of a module
  doc, `ai.chat({model, system, messages, maxTokens, kind})` is a plain chat
  call through `agent.runChat` under the monthly cap with the cost written
  to `platform.ai_usage` (counted in `monthlySpend`), `ai.models`,
  `ai.modelFor(role)`, `manifest`. A module declares chat personas in
  module.json `agents: { id: { doc, label } }`; the doc file ships in the
  module, is seeded as an editable module doc (`seedModuleDocs`), and
  `guidanceFor` leaves it out of build prompts.
- **Plant KPIs module** (`modules/kpis/`, company demo by default): the
  manager's eight-week view plus **Jonah**, a chat agent for managers
  (`JONAH.md`, TPS and Theory of Constraints voice: what the data says, what
  it means, where to stand on the floor, one experiment). History is
  seeded deterministically on first request (`routes.js buildSeed`, 40
  working days ending yesterday) with the lean patterns baked in: flat
  demand, lumpy orders, lumpier production orders (bullwhip), Friday push
  and Monday idle, Body Fold as the constraint carrying the WIP and half
  the defects, defects rising on push days, paper bought in 2400 lots, four
  clip stockout days, lead time following WIP, on-time delivery sliding.
  `GET /api/kpis` returns everything the page draws plus computed `flags`
  and `live` (today's real paperline shifts and WIP through `peer`). Chat:
  `GET/POST /api/chats`, manager only; system prompt is JONAH.md plus
  `digest()` (a few thousand characters), default model the company's
  propose model, dropdown to switch; each answer shows its cost. Page is
  plain HTML with inline SVG helpers (line, bar, stacked area, h-bars);
  chart ids `c-bullwhip c-output c-wip c-lead c-quality c-inventory` are
  targets for the tour and the "Ask Jonah about this chart" buttons.
  `POST /api/reseed` (manager) regenerates the eight weeks ending yesterday
  before a demo. Migration files must avoid the word `updated_at` (the
  validator's `UPDATE` check has no trailing word boundary); the chats
  table uses `last_at`.

## What this is

The product version of Brendan's operations methodology: one app per factory
that hosts an improvement board, every module (live and staged versions), and an
agent build service that turns approved floor feedback into deployed changes.
See `docs/ROADMAP.md` for the vision and `README.md` for the run-it map.

First module: **Paper Airplane Line** (`modules/paperline/`). A five-station
line making paper airplanes in 2-minute shifts. It is deliberately a working but
imperfect v1 so participants feel the improvement loop. `docs/DEMO-RUNBOOK.md`
is the facilitator script. Second module: **Plant KPIs** (`modules/kpis/`),
the manager's view of the same line over eight weeks, with Jonah.

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
   `--dangerously-skip-permissions` as root. Its environment is an explicit
   allow-list (`agentEnv()` in src/agent.js): API key, PATH/HOME, and
   `ANTHROPIC_*`/`CLAUDE_*` only. Never spread `process.env` into it; the
   agent reads floor-typed feedback, so it must not see `DATABASE_URL`,
   `SESSION_SECRET`, passwords, or `SOS_INTERNAL_TOKEN`.
2. **Cowork revisions (free).** Brendan asks Claude here; Claude edits the repo
   and pushes; Railway redeploys. This is for platform changes (anything under
   `src/`, `public/`, `server.js`, `principles/`) and for deliberate module
   revisions. Feedback filed about the platform itself lands in the
   "Platform requests" strip of the board and is readable from here:
   `GET /api/c/<slug>/feedback/platform` (manager session) or the
   `platform.feedback` table where `module='platform'`. Close them with
   `POST /api/feedback/:id/close {outcome}` after shipping.

Local smoke test of the whole loop, in the sandbox: `SOS_FAKE_AGENT=1
SOS_FAKE_DELAY_MS=4000 PORT=3999 node server.js` (the delay gives an abort
something to interrupt; the fake agent stamps a visible
`data-changed="vN"` line on the page so the preview highlight shows).

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
   and says what changed. Trap found 2026-09-17: `device_commit_files` with a
   `stagedPath` that was only `cp`'d into the outputs folder can write a STALE
   earlier copy of that path (the board page landed as the previous version
   while the docs beside it were current). Reliable path: `SendUserFile` on
   the file, then commit by `fileUuid`, then `md5sum` on the mount against
   the sandbox copy before telling Brendan to push.
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

The cloud sandbox has npm registry access (through its proxy) and Postgres 16
(`pg_ctlcluster 16 main start`, then create user/db `sos`/`sos`), so the app
runs there from a plain `npm install`: tar the repo without `node_modules`
and `.git` in the mounted folder, stage the tarball, untar, install, boot with
`SOS_FAKE_AGENT=1`. That is also where `package-lock.json` is regenerated
after a dependency change. The `node_modules` in the mounted folder is a stale
local install from before the SDK upgrade; Railway never sees it. The
sandbox can reach api.anthropic.com but has no key, so a real agent run is
tested on the live instance; a launch test with a bogus key (init message,
tool list, 401 from the API) proves the CLI itself starts.

## Live instance env vars (Railway service `SymbioticOS`)

`DATABASE_URL` (reference to Postgres), `ANTHROPIC_API_KEY`,
`SOS_FLOOR_PASSWORD`, `SOS_MANAGER_PASSWORD`, `SOS_ADMIN_PASSWORD`,
`SESSION_SECRET`, `SOS_MODEL_PROPOSE` / `SOS_MODEL_BUILD` / `SOS_MODEL_REVIEW`
(instance defaults: claude-sonnet-5 / claude-sonnet-5 / claude-opus-5;
companies override on their Agent settings page), `SOS_MAX_RUN_USD` (per
build run, default 1.50), `SOS_MONTHLY_CAP_USD` (default 25),
`SOS_FAKE_AGENT` (0/1). Optional: `SOS_AGENT_EFFORT` (build agent reasoning
effort, default `high`), `SOS_SESSION_DAYS` (default 30; sessions
expire server-side, not just via cookie Max-Age), `SOS_LOGIN_MAX_FAILS`
(default 10) and `SOS_LOGIN_WINDOW_MIN` (default 15) for the per-IP login
limiter (in-memory, uses `cf-connecting-ip`).
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
