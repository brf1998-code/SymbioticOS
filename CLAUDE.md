# Symbiotic OS: Workspace Guide (current as of 2026-09-19, evening)

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
- **Cost caps are off by default** (2026-09-17, Brendan: development mode,
  spend what the work needs). `SOS_MAX_RUN_USD`, `SOS_MAX_BATCH_USD` and
  `SOS_MONTHLY_CAP_USD` unset or 0 mean no cap; set them to bring caps back
  (per change, per batch run, per month). With no cap the runner passes no
  `maxBudgetUsd` to the SDK either; `maxTurns` (40 for a change,
  `SOS_MODULE_MAX_TURNS` 150 for a module build) is the only bound. The KPI
  tile says "no caps set", the batch bars drop their "stops itself past"
  note. The live instance had SOS_MAX_RUN_USD=1.50 and SOS_MONTHLY_CAP_USD=25
  as Railway variables; they must be removed or set to 0 AFTER this code is
  deployed (the old code read 0 as a zero-dollar cap).
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
- **Module build from a confirmed design** (2026-09-17, `src/modulebuild.js`,
  lane `module` in `build_runs`): Approve build on the design gate calls
  `modulebuild.startBuild(intake)`: a `platform.modules` row with no live
  version, v1 written from a **skeleton** the platform generates from the
  design (`skeleton()`: one `items` table with the thing's stages, seed rows
  from the first attached spreadsheet, a board screen with a move button per
  item, `/api/items` and `/api/stats`, a four-step tour), the design's
  `reference_md` as the module's `reference.md` doc, an approved proposal on
  the request feedback, and a run (`from_version` NULL, `to_version` 1,
  `requirement` = the reference, `evidence.intake_id`). `pipeline.advance`
  delegates the module lane here; deploy, cancel, retry, fix and override
  are the pipeline's own with two hooks (`afterDeploy`: intake and card
  done; `afterCancel`: a module that never went live is deleted again and
  the intake goes back to `confirmed`, where the card offers "Build it now",
  `POST /api/intakes/:id/build`). Build step: the agent (the intake model,
  Fable) works on the skeleton with `principles/MODULE-CONTRACT.md` (the
  files, manifest, routes signature and ctx services, migration rules and
  their two traps, base computed from location.pathname, tour shape) and
  PLAIN-WORDS.md in the system prompt, the design and the manager's own
  answers and starting rows in the user prompt (`NEW MODULE BUILD` header;
  fake mode leaves the skeleton and stamps the page). Then platform checks
  with no tokens (`validateModule`: manifest name and pages, migrations
  through the validator, routes.js loads and returns a router, tour.json,
  no hard-coded module address, no dashes); a failure is filed as a failed
  cross-check by "platform checks" so fix / retry / cancel apply. Then
  stage, cross-check (Fable, the design as the requirement, the file listing
  in diff shape from `listingAsDiff`), smoke, deploy gate ("Put it on the
  floor" on the request card, which shows `runBlock` like any card). Retry
  rewrites the skeleton; fix keeps the files. The strip shows a module with
  no live version as "being built" with only its Preview link.
- **Checks campaign** (2026-09-17 evening, docs/CHECKS-CAMPAIGN.md): Brendan
  reported functionality changes still stopped almost every time after the
  brief rewrite. Two findings and one tool. (1) The migration validator's
  forbidden-word check was a SUBSTRING match, so `updated_at`, `deleted_at`,
  `owner_name`, `granted_at`, `reset_count`, `rule_text`, `trigger_level`,
  `copy_count` and any seed text with "do" or "update" in it killed the build
  at the build step ("migration rejected"), which is what most functionality
  changes carry. Now whole words with string literals blanked out, and a word
  followed by a column type is a column (`src/migrate.js`, test cases in the
  commit). The `last_at` workaround in the kpis module is no longer needed.
  (2) Stops have five different causes and the board showed them all the
  same; `src/checks.js reasonFor` names them. (3) The checks log at
  `/c/<slug>/checks` (manager; "checks log" in the board header): every run
  with its reason, the reviewer's findings and quoted evidence, and Right /
  Wrong / Unsure labels with a note in `platform.check_labels`; "Download
  the checks log" exports cases with before/after files
  (`GET /api/c/<slug>/checks/export[?labeled=1]`), and
  `scripts/replay-crosscheck.js` rebuilds each diff and runs the CURRENT
  brief (`pipeline.crossCheckCall`, a pure function now) through the API,
  printing old verdict, new verdict and agreement with the label. Tune the
  brief against labeled cases offline, not against live builds. Exit bar for
  a pilot is in the campaign doc.
- **Checks campaign, first export** (2026-09-17, docs/CHECKS-CAMPAIGN.md
  "First export"): five reviewer stops on the demo company, all Opus 5 on
  functionality changes; two right, three wrong or half wrong. Fixes: the
  build diff is `diff -ruN` (a NEW file's whole body shows; `-u` alone
  printed "Only in ...: 002.sql" and the reviewer failed the migration as
  unverifiable, run #28); the reviewer's brief carries GUARDRAILS.md only
  (PRINCIPLES.md made it fail builds for rule 9, run #31); `demote()` in
  pipeline.js turns blocking findings that are guesses ("if the underlying",
  "cannot confirm", "presumably"), housekeeping (data-changed, tour.json,
  reference.md) or cosmetic into minor with `demoted` recorded; an empty
  diff is a plain "the agent changed nothing" stop before the reviewer (run
  #32). Replay from the checks page: `POST /api/runs/:id/replay {model}`
  (`checks.replayRun`, diff rebuilt from stored versions by `diffForRun`,
  result in `platform.check_replays`, spend as ai_usage kind `replay`);
  the page shows each replay under the run with match/disagree against the
  label and "Replay every labeled case". `reasonFor` now says "deployed over
  a reviewer stop" / "cancelled after a reviewer stop" so overridden stops
  still count (`reviewer_failed`). Instance default review model set to
  Fable on Railway (`SOS_MODEL_REVIEW`); companies can still override on
  their Agent settings page.
- **Cross-check calibrated** (2026-09-17, `crossCheckSystem` in pipeline.js):
  the old brief ("fail anything beyond the requirement") never told the
  reviewer what a functionality change legitimately touches, so routes.js
  edits, new migrations and tour.json upkeep were read as violations and
  almost every functionality change failed. The brief now lists the five
  blocking conditions (requirement not met or on the wrong screen; a change
  the floor would notice beyond the ask; an existing migration edited or
  forbidden SQL; something plainly broken; a guardrail broken) and says what
  is never a violation (supporting code, new additive migrations, tour and
  reference upkeep, data-changed marks, tidy-ups, "what stays the same" is
  about behavior not files, anything unverifiable from a diff). The schema
  returns `findings` with severity and quoted evidence; the verdict is
  computed from the findings (fail only on a blocking one), never taken from
  the model's mood. The reviewer sees the lane, the target files and the
  files touched; the diff limit is `SOS_CROSS_CHECK_DIFF_CHARS` (90000) and
  a cut diff is declared as such. PRINCIPLES.md and GUARDRAILS.md ride along.
- **Module gate** (2026-09-18, `src/modulegate.js`, item 1 of the product
  review's build order). Found in the review: `registry.buildRouter` and
  `modulebuild.validateModule` load a module's routes.js into the platform's
  own process, so agent-written code ran with `process.env`, the disk, the
  network and every schema in reach (a probe module passed the platform
  checks while writing DATABASE_URL, SESSION_SECRET and the API key to a
  file), and the UI lane's "do not touch routes.js" was a line in a prompt
  with no reviewer behind it. The gate is a no-token check of a version's
  FILES that runs before anything loads them. Server files (every `.js` in
  the module, read by a small scanner that blanks comments, strings,
  templates and regex literals): only `require("./own-file.js")`; no
  `process`, `global`, `globalThis`, `eval`, `Function`, `import`, `fetch`
  and friends; no `sendFile` / `static` / `download` / `render`; no
  `.constructor` / `__proto__`; no SQL naming `platform.`, another module's
  schema, `information_schema`, `pg_` server functions, `search_path`,
  `SET ROLE`, `COPY`, `GRANT`, or CREATE / ALTER / DROP / TRUNCATE at run
  time. Layout: no package.json, node_modules, native or wasm files, links;
  `entry` stays a .js file inside the module. Lane: in a UI build only
  `pages/`, `tour.json`, `reference.md` and the labels, title and description
  of module.json may differ from the version the build started from; in any
  lane an existing migration is never edited or removed. A finding already
  present word for word in the from-version is "inherited" and does not stop
  the build (`evidence.gate.inherited`). Where it runs: `pipeline.advance`
  right after the agent finishes and BEFORE `stageVersion` (staging executes
  the code); `modulebuild.advance` before `validateModule`, and inside
  `validateModule` itself; and as a backstop in `registry.stageVersion`,
  `deployVersion` and `goToVersion` (`assertGate`), because the Versions
  panel can switch to any stored version, including a refused draft that a
  retry left behind. A version that was ever live (events
  `version_deployed` / `version_switched` / `module_imported`) is let
  through, so a rollback is never refused, and boot never refuses what is on
  the floor: it logs `[gate] ... is on the floor with code a new build would
  be refused for` instead. A stop is filed like the other platform checks
  (`step cross_check`, `cross_check.model = "platform checks"`, plus
  `evidence.gate`), the draft's text is persisted but never staged, the
  board says "The platform's own checks stopped it" with fix, retry and
  cancel and NO override or preview link (`pipeline.override` refuses
  platform checks), and the checks log counts it as "module gate". Fix
  round: the platform itself puts back the files a lane rule protects
  (`gate.restoreLaneFiles`, logged as "the platform put back: ..."), since a
  new agent session cannot know what they looked like, and the agent gets
  `gate.forAgent` wording instead of the reviewer wrapper. GUARDRAILS.md,
  MODULE-CONTRACT.md and the UI build prompt state the rules so builders do
  not trip them. Fake mode: GATECHECK in the feedback (or in a new module's
  name) makes the first attempt trip the gate and the fix round clear it.
  Tests: `node scripts/test-modulegate.js` (no database; also proves the
  library modules and the skeleton pass) and TEST-CAMPAIGN S0-74 to S0-80,
  S3-03a. **It is not a security boundary**: any text check can be got
  around. It stops the careless build and the lazily steered one until
  module code runs in a child process per company with its own database
  role (tenancy trade study of 2026-09-17, option C). Still open from the
  same review, NOT covered by the gate: agent-written PAGES run in the
  manager's browser with the manager's session, so a staged preview could
  call the platform's own APIs (approve, deploy) as the manager; the fix is
  a Content-Security-Policy on module pages (`connect-src` and `form-action`
  limited to the module's own base path and the widget's endpoints). **Built
  2026-09-19, see the next bullet.**
- **Module pages are locked to their own module in the browser** (2026-09-19,
  `registry.lockDown` / `modulePagePolicy`, the page half of the 2026-09-18
  review's item 1). A module's pages are agent-written and open in the
  manager's browser with the manager's session, same origin as the board, so a
  staged preview could call the platform's own controls (approve, deploy) as
  the manager and walk around the structural gate. Everything served under a
  module mount now carries a Content-Security-Policy: `connect-src` and
  `form-action` limited to the module's own live and staged paths plus
  `/api/feedback`, `/api/c/<company>/modules/<module>/` and
  `/api/c/<company>/who` (the widget's endpoints: feedback, tours, the name
  picker); `frame-src`/`worker-src`/`object-src` none; no popups usable as a
  scriptable same-origin window. It is set on BOTH the pages the platform
  serves and whatever the module's routes answer: `lockDown` wraps the
  response so module code cannot drop or widen `Content-Security-Policy` /
  `Service-Worker-Allowed` (and the gate refuses code that tries, rules
  `header-policy`, `call-removeHeader`). The module gate also has page rules
  now (`checkPageFile`, `PAGE_RULES`): a screen naming `/api/admin`,
  `/api/proposals`, `/api/intakes` or `/api/c/`, opening a popup, framing
  another page, installing a worker, or loading anything from off the platform
  is stopped at build time with a plain reason. Proven in a real headless
  browser (`scripts/../browser-csp*.js` in the test run): the paperline and
  kpis pages, their charts, the chat and the staged amber bar all run clean,
  while a page trying to fetch the board, a deploy API, an admin API or a
  service worker is blocked by the browser. Not a wall on its own (a link off
  the page still navigates); the origin-per-module split is the real fix.
- **A never-approved draft cannot be switched onto the floor** (2026-09-19,
  `registry.goToVersion` + `wasEverLive`, the Versions panel). A build draft
  the agent wrote that never reached the floor (a check stopped it, or it was
  cancelled at the gate) can only go live through its own build's deploy gate;
  the panel marks it "NEVER APPROVED" and disables Switch, and `goToVersion`
  refuses it server-side. A version that was ever live (deploy, switch, import
  event, a deployed run, or a data snapshot) is always switchable, so rollback
  is never blocked. This closes the one path left open when the module gate
  went in: the gate stopped switching to a gate-refused draft; this stops
  switching to a reviewer-refused one too.
- **One company per session, per-company passwords** (2026-09-19, `src/auth.js`
  rewrite, trade study option B). Found in the review: the login cookie carried
  a role and no company, so any authenticated login reached every `/c/<slug>/`.
  Now the signed cookie carries role, company, a password generation and the
  issue time. `auth.companyGuard` (mounted in server.js right after
  `auth.middleware`) is the one gate: a `/c/<slug>/` or `/api/c/<slug>/` path
  must match the session's company, and an id-addressed route (`/api/feedback/:id`,
  `/api/proposals/:id`, `/api/runs/:id`, `/api/intakes/:id`,
  `/api/attachments/:id`) is looked up and must belong to it; admin passes
  everywhere; a floor or manager landing on `/` goes to its own board. The two
  body-addressed routes (`/api/feedback`, `/api/runs/batch`) scope themselves.
  Passwords: each company has its own floor and manager passwords, scrypt
  hashes in `platform.company_access` (never in `platform.companies`, which is
  read with SELECT * and handed to pages), set on the admin page (typed, or
  the platform makes up word-word-number ones and shows them once). A company
  made from the admin page gets its own at birth. `SOS_FLOOR_PASSWORD` /
  `SOS_MANAGER_PASSWORD` are now only a fallback: they open a company solely
  while its access row is `legacy_login=true`, which `ensureAccessRows()` sets
  at boot for companies that predate this change, until the admin gives them
  their own. Changing a password raises the company's `generation` and signs
  its people out. `SOS_ADMIN_PASSWORD` is unchanged (manager password doubles
  as admin when unset). Cookies from before this change (no company) are
  rejected, so everyone signs in once after the deploy.
- **Per-company AI budget** (2026-09-19). `assertUnderCap(company)` now checks
  the company's own monthly cap (`platform.companies.monthly_cap_usd`, set on
  the admin page) against that company's own spend AND the instance cap, so one
  company running out never blocks another. Before this, `assertUnderCap` read
  `monthlySpend(null)` (the whole instance), so any company hitting
  `SOS_MONTHLY_CAP_USD` froze builds for all of them. `monthlySpend(company)`
  returns `capKind` ("company"/"instance"/null) and the board KPI shows the
  company's own budget.
- **Backup keeps up with the schema** (2026-09-19, `src/backup.js`
  `PLATFORM_TABLES`). The dump always took every table; the restore list had
  fallen behind it and skipped module intakes, attachments and the checks-log
  labels and replays. It now restores all of them, decodes bytea columns
  (attachment bytes), and includes `company_access`; an older backup with no
  `company_access` brings its companies back on the shared passwords rather
  than locking anyone out. Round-tripped in the test run.
- **The interaction record** (2026-09-19, `src/record.js`, `platform.record`,
  build order item 3). What everyone said and decided, word for word, tied to
  the build it led to and how it turned out. One insert-only table (a trigger,
  `platform.record_guard`, refuses UPDATE and DELETE; the one sanctioned delete
  is a company's own, through `record.deleteCompany`, which sets a
  transaction-local flag the trigger honours). Each row: company, module,
  kind, actor_role (floor / manager / admin / agent / platform / person),
  actor_name (the name typed with feedback; a person once operators have an
  identity), the ids it ties to (feedback, proposal, run, intake, version),
  `before`, `after`, detail JSONB. Kinds: feedback_filed, feedback_closed,
  proposal_drafted (the AI's text), proposal_edited (the AI's text BEFORE,
  the manager's AFTER: until this the edit overwrote the AI's words in place),
  proposal_approved, proposal_declined (until this a decline logged nothing),
  requirement_drafted, requirement_confirmed (before/after, edited flag),
  build_finished, build_summarized, check_verdict (the gate, the tests, or the
  reviewer, with findings), run_fixed, run_overridden, run_retried,
  run_cancelled, deployed, rolled_back, version_switched, review_started,
  review_findings, intake_answered (each answer, before/after), intake_round,
  intake_design, intake_adjusted (before/after plus what was asked),
  intake_confirmed, intake_abandoned, doc_saved (before/after), doc_deleted,
  models_changed, label_set, chat_question, chat_answer. `record()` never
  throws: a failed write logs `[record]` and the loop goes on. Read back:
  `GET /api/c/<slug>/record?kind=&feedback_id=&run_id=&limit=&before_id=`
  (manager) and `GET /api/c/<slug>/record/export` (a JSON download, linked
  as "record" in the board header and "Download the record" on the admin
  card). In `backup.js PLATFORM_TABLES`, so a backup carries it and a restore
  brings it back. Data terms decided 2026-09-18: the plant owns its record,
  Anetix uses it to improve that plant, anonymized cross-plant use is an
  opt-in clause; the cross-plant copy does not exist yet, and defense tenants
  stay out of it. Which person acted is recorded since operator identity
  (`actor_person`, next bullet). Not recorded yet: a proposal's rationale edits. What it feeds next:
  per-plant memory (lessons from adjusted and declined proposals), prompt and
  brief regression, a failure taxonomy, intake tuning, the pattern library.
- **Operator identity: a name and a PIN** (2026-09-19, `src/people.js`,
  `platform.people`, build order item 2b; Brendan: build it before "my
  requests", so a request follows the person across devices from day one).
  Two layers, on purpose. The DEVICE stays signed in with the company's floor
  or manager password (`src/auth.js`) and that alone decides what the device
  may do. The PERSON is who is standing at it: picked from the company's
  names on the feedback button, proven with a PIN (4 to 8 digits, scrypt
  hash, the platform makes a 4 digit one that is never 1111 or a run), kept in
  a second signed cookie `sos_person` = `p.<id>.<company>.<generation>.<time>.
  <mac>` (HttpOnly, 12 h, `SOS_PERSON_HOURS`). `people.attach` (after
  `companyGuard`) sets `req.sosPerson`, `req.sosPersonId`,
  `req.sosPersonRole`, only when the person is active, the generation
  matches and the person's company is the session's company. Nothing requires
  a person: a device with nobody signed in works as before. The role on a
  person (floor / lead / manager) is a label for now; it grants nothing.
  Five wrong tries lock a name for five minutes; a new PIN or a switch-off
  bumps the generation and signs the person out everywhere within ten
  seconds (a small in-memory cache). What it changes: feedback is filed with
  `person_id` and the person's name whatever was typed; `record.actor(req)`
  carries the person, so every manager and floor action in the interaction
  record says who (`actor_name`, `actor_person`). Routes, split on purpose:
  `/api/c/<slug>/who` (GET names + me, POST `/who/sign-in`, `/who/sign-out`)
  is the picker, open to any device of the company; `/api/c/<slug>/people`
  (GET the full list, POST add, `/:id/pin`, `/:id/active`) is the manager's
  list (`requireManager`). A module page's browser policy opens `/who` only,
  so agent-written code running in a manager's browser cannot add a person or
  reset a PIN (proven in a headless browser). Pages: `/c/<slug>/people`
  (manager; a PIN is shown once), the picker inside
  `public/assets/feedback-widget.js` (`window.sosPerson = { me, people, open,
  refresh, onChange }`, a digit pad that works on a tablet; its keyboard
  listener exists only while the pad is open and never touches the page's own
  handlers), the person chip in the board header. Record kinds: person_added,
  person_pin_reset, person_switched_on, person_switched_off,
  person_signed_in. `people` is in `backup.js PLATFORM_TABLES` and in company
  delete. Unit: `node scripts/test-people.js`. Not yet: "my requests", asking
  the reporter a question, fixed it / not quite (the next push, which this is
  the ground for; shipped in the next bullet); handing the person to module
  code on `ctx` (the paperline station still has its own operator box);
  per-person rights.
- **Close the loop, floor side** (2026-09-19, `src/closeloop.js`, build order
  item 6, first half; Brendan: floor side first, and "not quite" asks what is
  still off and files it linked). Until this a request left the floor and
  nothing came back, and the platform never learned whether a change fixed
  anything. Three pieces, all on the feedback button. (1) My requests: the
  signed-in person's own requests, each with one plain line from
  `closeloop.stateOf` (on the board / the manager has a proposal / waiting on
  data from the office / approved, being built / built, the manager is
  checking it / live, did it fix it? / fixed / not quite / declined with the
  manager's reason / taken back off). A stopped build is "being built" to the
  floor; ERP words never appear. (2) What went live: `pipeline.deploy` stamps
  `feedback.shipped_version` and `shipped_at` (`rollbackRun` clears them);
  `GET /api/c/<slug>/who/news?module=` lists the last 14 days of shipped
  requests by version with the plain summary and who asked. The widget turns
  the reload after a deploy into "New here: <summary>. Maria G asked for
  this." (once per device per version, `localStorage sos.seen.<co>.<mod>`; a
  device that was never there is not told old news; a deploy with no request
  behind it keeps the plain "updated" banner). The person who asked gets a
  card instead: their words, what was built, "Did it fix it?" with Fixed it /
  Not quite / Later. The card opens once per sitting; after that, or after
  Later, it is a small amber pill beside the feedback button, so it never
  sits on top of the work, and My requests carries a "1 to check" badge
  until they answer. (3) The answer:
  `POST /api/c/<slug>/who/requests/<id>/answer` `{ answer: fixed | not_quite,
  what }`. Only the person who asked may answer; a request filed with nobody
  signed in may be answered by any signed-in person (the record says who).
  Fixed may later become not quite, once; not quite is final. Not quite needs
  words and files them as a NEW feedback row (`follow_up_of` = the original,
  same module, page, screen, the person's name and id), so it goes round the
  same loop with the manager's gate intact; the original stays shipped with
  `floor_answer`, `floor_answer_at`, `floor_answer_person`, `floor_answer_by`.
  The proposer is told (`closeloop.followUpContext`, added to the prompt in
  `generateProposal`): which request this follows, the first words, what was
  built and is live, and to close the gap without starting over. The board:
  a follow-up card carries an amber "Follow-up to #N: not quite" line with
  the first words; a shipped card says "<name> says: fixed it" / "not quite.
  The follow-up is #N" / "has not said yet" (single cards and inside a batch
  tile). Record kinds: floor_fixed, floor_not_quite (before = "fixed" on a
  change of mind, after = the words, detail.follow_up_id), and the
  follow-up's own feedback_filed carries detail.follow_up_of. Loop health:
  `answers` = fixed, not_quite, went_live, unanswered, unanswered_named,
  fixed_share, follow_ups_open; a tile ("fixed it, says the floor") and a
  line in the Shipped cell on /admin. A not quite is the miss signal; with
  the quiet stretch it is what says a cheaper build model is or is not good
  enough. All three routes sit under `/who/` because the widget calls them
  from module pages; they do no more than `/api/feedback` already lets a page
  do (read the signed-in person's own requests, file a request under their
  name), and nothing they file reaches the floor without the manager. Fake
  mode: the fake proposer's rationale says "Follow-up context received for
  request #N." when the context arrived. Units: `scripts/test-closeloop.js`,
  the `answers` cases in `scripts/test-health.js`. Not yet (manager side of
  item 6): an email when something waits on the manager, a clarifying
  question to the reporter, a manager answering for the floor; also nothing
  proposes a follow-up on arrival (item 8).
- **Connections, first push: spreadsheets and label printers** (2026-09-19,
  `src/connections.js`, `public/connections.html` at `/c/<slug>/connections`
  (manager), `public/assets/print-helper.js`, build order item 5, designed in
  docs/MODULE-CREATION.md "Connections: the outside world"). The rule: the
  platform owns every connection, the module only uses it. A module declares
  what it needs in module.json `connections: { name: { kind, label, ... } }`
  (the gate and `validateModule` refuse a kind the platform does not have, a
  files connection without `table` and `key`, a printer whose
  `labels/<name>.zpl` is missing); the platform keeps one row per declared
  connection in `platform.connections` (settings, status, detail, an
  encrypted `secrets` column ready for the ERP kind, key `SOS_CONNECTION_KEY`
  else derived from SESSION_SECRET, never in the agent env), created at mount;
  the module gets `ctx.connections.<name>` with a small fixed surface. `files`:
  the manager uploads a csv or xlsx on the connections page, the platform
  parses it (attachments.js parsers, every row), matches headers to the
  module table's columns (loosely, plus the module's aliases), previews with
  typed sample rows and problems, then loads in ONE transaction on the live
  schema (delete the matching keys, insert every row; any unreadable cell
  stops the whole load); `platform.connection_uploads` keeps the parsed rows
  until loaded. Surface: `status()`. `printer`: Zebra Browser Print on the
  device. The module keeps `labels/<name>.zpl` with `{{field}}` placeholders
  and calls `print(req, name, data)`; the platform renders (ZPL control
  characters stripped from data), queues a row in `platform.print_jobs` for
  the DEVICE that asked (`sos_device` cookie, minted by
  `connections.deviceCookie` on module pages, the connections page and the
  print API), and the print helper the platform injects into the pages of a
  module with a printer connection polls `GET /api/c/<slug>/print/next`
  every 2 s while visible, asks once which printer this device uses
  (localStorage), POSTs the ZPL to Browser Print on localhost:9100 (9101
  https), reports `.../print/jobs/<id>/done|failed`. Unclaimed jobs expire
  after 10 min; jobs a device took and never reported fail. The page policy
  of such a module adds `localhost:9100/9101` and `/api/c/<slug>/print/` to
  connect-src and nothing else. `preview(name, data)` renders a PNG through
  Labelary (`SOS_LABELARY_URL`, https://api.labelary.com; null when
  unreachable, as in the sandbox); the connections page shows the test label
  and the module can show its own. Test label and printer settings (size and
  dpi, preview only) live on the connections page; the manager pairs each
  printing device there or on the first label. Record kinds:
  connection_loaded, connection_settings, connection_tested, label_printed,
  label_failed. `paperline` declares `stock` (files into `inventory`, key
  item+location) and `labels` (printer, `labels/traveler.zpl`, printed from
  station 1). Backup carries the three tables; company delete removes them.
  Unit: `node scripts/test-connections.js`. Not yet: the generated setup
  walkthrough (the page carries a fixed text per kind for now), uploads from
  a module page (the module links to the connections page instead), the
  scanner kind (needs nothing).
- **Connections, second push: the ERP kind** (2026-09-19, `src/connections.js`
  erp section, the connections page's ERP card with an admin-only setup form,
  `modules/paperline` "erp"). Read only, through named queries. The module
  declares each query it needs (`queries: { name: { params, fields, about } }`);
  the gate refuses a module that carries `base_url`, `url`, `user`,
  `password`, `path` or `host` (the platform holds those). The ADMIN (Brendan,
  during pilots: decided 2026-09-19) enters on the connections page: flavor
  (`sap_odata`: SAP Gateway / S/4HANA OData v2 or v4, `epicor_baq`: Kinetic
  BAQ REST, `json`: any read-only JSON endpoint), base URL, transport
  (`direct`; `bridge` is designed in and answers "not available yet"), answer
  freshness, SAP client, certificate check (off for a self-signed on-prem
  certificate), the login (user and password or an API key, encrypted with
  AES-256-GCM under `SOS_CONNECTION_KEY`, else SESSION_SECRET; SET
  SOS_CONNECTION_KEY ON RAILWAY so a session secret rotation does not lose the
  logins; a login that cannot be decrypted says so and asks for it again), and
  per query: the path after the base URL with `{param}` placeholders (URL
  encoded, OData quotes doubled), the system's field behind each module field
  (dotted paths), test values. `POST /api/admin/connections/:slug/:mod/:name/erp`
  saves it and clears the cache; the login never comes back out of any
  endpoint. The manager's Test button (`.../test`, shared with the printer
  kind) runs every query with its test values and reports rows, a mapped
  sample and fields that came back empty (a wrong field name), plus a path
  that uses a `{param}` the query does not declare. The module's
  `query(name, params)` reads `platform.erp_cache` when fresh, else calls the
  ERP (`httpGet` over http/https with a 15 s timeout, 20 MB cap, plain-words
  errors for refused, not found, certificate, 401/403/404), maps the fields,
  stores the rows, and on failure returns the cached rows with `fresh: false`
  (the connection stays connected with `last_error` set) or throws with the
  reason when nothing is cached. The IT note (`.../it-note.txt`, and on the
  card) is templated in plain words from the declaration and the settings:
  what read-only access, which lookups and fields, where the calls come from,
  how the login is kept, what we need back. A stand-in ERP for the showroom
  answers at `/erp-demo/parts` and `/erp-demo/orders` (public, static rows,
  SAP OData v2 shape, `$filter=Field eq 'x'` and `$top` honoured), so a demo
  company's erp connection can be set up with base URL `<host>/erp-demo/`.
  `paperline` declares `erp` with one query `parts` (fields item, description,
  on_hand, reorder_at) and the stockroom page shows an "ERP says" column with
  "below reorder point" and an as-of line. Backup carries `erp_cache`. Not
  yet: the bridge transport itself, a generated (not templated) walkthrough,
  SAP CSRF-protected writes (never).
- **The ERP is admin side; the data check at review** (2026-09-19, Brendan:
  the manager's view must not carry lookups, fields or BAQs, "otherwise it
  gets much too complicated"; "there should just be a check the agent does
  during reviewing to see if it has access to the data"). `src/datacheck.js`,
  `platform.data_requests`, `proposals.data_check`. (1) Admin only: the ERP
  card on the connections page (`connections.companyView(company, { admin })`
  strips it server side to label + status + `managed: true` for anyone else:
  no settings, address, lookups, columns, samples, audit, drafts or IT note),
  the ERP Test (the shared `.../test` route answers 403 to a manager for an
  erp connection), the IT note, setup, drafts, and platform-written agent docs
  (`source='platform'`, i.e. `ERP-FIELDS.md`, are left out of
  `GET /api/c/:slug/agents` unless the role is admin). Managers keep printers
  and spreadsheets. (2) The check: for a module with an ERP connection,
  `generateProposal` adds `erp_data` to the proposal schema (what, in the
  manager's words; the lookup; the published field that covers it or empty)
  and tells the model to write the proposal as it will work once the data is
  there, never naming lookups or fields to the manager. `datacheck.verify`
  checks each named field against `connections.fieldAudit` (catalog plus
  declared fields that resolve); THE PLATFORM DECIDES, the model's opinion of
  availability is never used. `data_check.status`: none (needs nothing), ok,
  waiting (something missing: a row per missing need in
  `platform.data_requests`), unavailable (the admin dismissed the last open
  request with a reason). The board query sends the manager only
  `proposal_data = { status, reason, missing: [plain words] }`. waiting: one
  amber sentence, no Approve, Decline stays; the decide route, the batch
  build and `/api/runs/batch` all answer 409 in plain words. unavailable: the
  admin's sentence in red; approve only together with an edited proposal
  (the manager changed the ask). (3) Admin: the "Data requests" card on
  /admin (`GET /api/admin/data-requests`, `.../:id/resolve` = "it is there
  now: propose again", `.../:id/dismiss` with a sentence the manager reads).
  A catalog change in `setErp` (the set of published names differs) calls
  `datacheck.catalogChanged`, which proposes the module's waiting items again
  behind the response (old draft -> `superseded`, its requests closed by the
  new proposal's `apply`). Record kinds: data_check, data_request_resolved,
  data_request_dismissed; event data_request_opened. Loop health:
  `decisions.waiting_data` and its oldest age ("waiting on us"), kept apart
  from what waits on a manager. Fake mode: `ERPNEED:<field>` in the feedback
  makes the fake proposer need that field (empty = nothing covers it).
  Same push, from the cross-check: the ERP cache key now includes the
  module's declared fields (a version that reads one more field never gets
  rows cached without it); an answer under an hour stale is served at once
  with `fresh: false, refreshing: true` and refreshed behind it
  (`erpQuery(..., { refresh: true })`), so a floor page only ever waits on the
  ERP for a lookup it has never made; the Test flags a lookup that hit the
  5000-row cap; `erp_cache` and `data_requests` are in the backup.
- **ERP field catalog, paging, lookup drafts** (2026-09-19, third connections
  push; the workflow is docs/ERP-ONBOARDING.md). Why: the ERP hookup is the
  most engineer-heavy thing we do, so a lookup must cost us time ONCE. The
  lookup is built WIDE in the ERP; Test records every column it returns
  (`columnsOf`: name, type, one sample, kept in `connections.detail.columns`,
  bookkeeping columns dropped); "Publish every column" (`setErp` with
  `publish`) gives each a plain name (`autoNames`: `JobHead_JobNum` ->
  `job_num`, the prefix kept on a collision) into
  `settings.queries.<q>.catalog`, where the admin may rename and annotate. A
  declared field resolves through `resolveFields`: the hand map, then the
  catalog, then a unique loose match on the column's own name, else null; the
  Test says how each resolved. `writeFieldsDoc` keeps the module agent doc
  `ERP-FIELDS.md` current (names, types, notes, never values; written at
  mount, on setup and on test), and `agent.guidanceFor` already hands every
  module doc to the proposer, the builder and the reviewer, so a request for
  one more ERP field is an ordinary functionality change that needs nobody
  from Anetix or IT. `fieldAudit` and `auditLine` put one line in the run log
  of every build of a module with an ERP connection ("ERP fields: every field
  the module reads is available" or which are not yet) and the same on the
  card. Paging: Epicor and plain JSON are paged with `$top=500&$skip=n` until
  a page is empty or partial (a page at a round hundred is followed by
  another request, because a server may cap pages at 100; a repeated first
  row stops an endpoint that ignores `$skip`; a path with its own `$top` is
  left alone); SAP follows `d.__next` or `@odata.nextLink`; 5000 rows at most.
  A 401 that mentions an API key says "it wants an API key as well" (Epicor
  REST v2 wants the user, its password AND a key; the form says so now).
  `draftLookups` (`POST /api/admin/connections/:slug/:mod/:name/draft`, admin,
  the company's propose model, spend recorded as `erp_draft`, record kind
  `connection_drafted`) has the model write what IT needs to build each
  lookup, wide on purpose, with a suggested ERP object name (`SOS_...`), the
  path, a field map, the extra fields it included and why, and what it could
  not know about this installation; for Epicor the definition is one
  read-only SELECT for BAQ Designer's SQL import (Kinetic 2024.2 and later; no
  CROSS APPLY, no OPENJSON). Nothing touches the ERP: a person there builds
  it and the Test proves it. "Use its path and field map" fills the form.
  A second stand-in ERP, Epicor shaped, answers at
  `/erp-demo/epicor/BaqSvc/SOS_<anything>/Data` (1230 jobs, `Table_Field`
  columns, 100 rows a page at most, wants `x-api-key` and Basic auth, BAQ
  parameter `JobNum`). Units in `scripts/test-connections.js`.
- **Loop health** (2026-09-19, `src/health.js`, `GET /api/admin/health?days=`,
  the top card on /admin, build order item 4). The platform's own numbers,
  per company and across the fleet, for Brendan (the manager's board shows
  none of this, by design). A window (7, 30, 90, 365 days, or 0 for all
  time; default 30) over: feedback filed; proposals approved (and how many
  the manager edited first), declined, waiting; builds started, shipped,
  rolled back, cancelled; stops by kind (gate = the platform's own checks,
  reviewer = the cross-check, tests = smoke and visual, other), fix rounds,
  overrides; time to floor (feedback filed to deployed, the oldest item of a
  batch; median, p90, and the same-shift share, within 8 hours); manager
  wait (proposal drafted to decided; then ready to deployed); AI spend in
  the window, per shipped change, this month against the cap; build models;
  intakes. As of now, not windowed: open feedback and its oldest, what is
  waiting on a manager (decisions, requirement confirmations, deploys), in
  flight, and the quiet stretch (days since the last reviewer or test stop,
  gate stop, rollback; a long one is the signal to try a cheaper build
  model, per the 2026-09-18 decision). Sources: the primary tables and the
  run log's timestamped lines (`deploy`, `rollback`, `error`, the ready line
  of each lane), so the whole history counts; the record adds decision times
  and edits, and a decision before the record uses the run's start.
  `compute()` is pure and unit tested (`scripts/test-health.js`, synthetic
  rows, fixed clock); `forAdmin()` is the one call the page makes.
- **Board band** (2026-09-19): one title row and one quiet module line
  (`.band`, `.modstrip`, `.modcard`), 70px on a desktop against roughly a
  third of the screen before. Module names are the filter toggles, versions
  and links are small text, the printable QR moved from a permanent tile to a
  "wall sign" link that opens the same card, the filter hint sits at the end
  of the module line only while a filter is in force. Chips wrap on phones.
- **Board tiles fold** (2026-09-17): each of the four columns shows
  `TILES_PER_COLUMN` (3) tiles and a "Show the other N" button; `EXPANDED`
  keeps opened columns across the 4s reload. The header count is the total.
- **Module creation intake** (2026-09-17, push 3 of docs/MODULE-CREATION.md;
  the build from a confirmed design is the bullet above). A manager presses "+ New
  module" on the board strip (or "New module" on an admin company card, which
  lands on the board with `?intake=<id>`). That creates a feedback row of
  `kind='module_request'` (new column; `intake_id` too) and a
  `platform.module_intakes` row; the tile on the board is the status and the
  way in, the popout (`public/assets/intake.js`, one file, its own CSS) is
  where the answering happens. Fixed questions live in
  `src/intake-questions.js` (13, the last one only when the company has other
  modules; answer shapes documented at the top of that file). Answers save
  one at a time (`POST /api/intakes/:id/answer`); `next` checks the open
  round is complete (409 with the missing ids), sets status `thinking` and
  runs `intake.think` in the background: Fable (`SOS_MODEL_INTAKE`, default
  claude-fable-5-1) returns either a round of up to 6 questions (ids
  `r2q1`..., at most two generated rounds, or `enough`) or the design
  (`DESIGN_SCHEMA`: bluf, check items, reference_md in the module-formats
  shape, screens, connections, starting data, leaves_out, change guidance,
  plus `estimate_usd` from `estimateUsd`). Every generated string passes the
  plain-words guard (`src/plainwords.js` over `principles/PLAIN-WORDS.md`: a
  word check, one Haiku rewrite, the check again; a question that still fails
  is dropped, a design line is flagged in `design.flags`; the company's own
  system names from the works_with answer are allowed). Attachments
  (`src/attachments.js`, `platform.attachments`, bytea, 15 MB and 10 per
  intake): photos and pdfs go to Fable as image and document blocks
  (`runStructured` now takes `blocks`), csv and xlsx are parsed to rows with a
  dependency-free reader (xlsx is a zip of xml; unusual files fall back to
  "save it as csv"). Design gate in the popout (a deliberate exception to
  gates-on-the-tile): tick every item, Adjust the text (Fable re-issues the
  design with the edit as the authority, `adjust`), Start over (keeps the
  fixed answers), Approve build (`confirm`, status `confirmed`, then
  `modulebuild.startBuild` at once: status `building`, then `done`). Text
  boxes show "N characters left" from 80% of their limit and say plainly
  when full. Withdraw on the tile (`abandon`, feedback declined). Fake
  mode returns a canned round 2 and a canned design. Module requests are kept
  out of batches and the proposal engine (`kind='feedback'` checks). The
  intake router is mounted before the platform router because the attach
  route parses a bigger JSON body. Spend goes to `ai_usage` as kinds `intake`
  and `design`.
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
  before a demo. (The chats table uses `last_at` from the days when the
  validator rejected `updated_at` as a substring of UPDATE; fixed 2026-09-17.)

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

- `SOS_CONNECTION_KEY`: the key the ERP logins are encrypted under (any long
  random string; `openssl rand -hex 32`). Optional: without it the platform
  derives a key from SESSION_SECRET, so rotating that secret would make every
  stored login unreadable. Set it once and never change it without re-entering
  the logins.

`DATABASE_URL` (reference to Postgres), `ANTHROPIC_API_KEY`,
`SOS_FLOOR_PASSWORD`, `SOS_MANAGER_PASSWORD`, `SOS_ADMIN_PASSWORD`,
`SESSION_SECRET`, `SOS_MODEL_PROPOSE` / `SOS_MODEL_BUILD` / `SOS_MODEL_REVIEW`
(instance defaults: claude-sonnet-5 / claude-sonnet-5 / claude-opus-5;
companies override on their Agent settings page), `SOS_MAX_RUN_USD` (per
build run, default 1.50), `SOS_MONTHLY_CAP_USD` (default 25),
`SOS_FAKE_AGENT` (0/1). `SOS_FLOOR_PASSWORD` and `SOS_MANAGER_PASSWORD` are
now only the fallback for companies created before 2026-09-19 that have not
been given their own passwords (see the "one company per session" bullet);
`SOS_ADMIN_PASSWORD` is still the admin password. `SOS_MONTHLY_CAP_USD` is now
the instance-wide ceiling only; a company's own budget is set on the admin page
and lives in `platform.companies.monthly_cap_usd`. `SOS_PAGE_LOCK` (default
`on`) is the browser policy on module pages: `report` sends it report-only
(violations show in the browser console, nothing breaks), `off` sends none;
the escape hatch if module pages ever stop after a deploy. Optional: `SOS_AGENT_EFFORT` (build agent reasoning
effort, default `high`), `SOS_PERSON_HOURS` (default 12: how long a name and
PIN sign-in lasts on a device), `SOS_SESSION_DAYS` (default 30; sessions
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
- A module's pages run under a Content-Security-Policy the platform sets
  (`registry.modulePagePolicy`), so a screen may only talk to its own module
  plus the feedback endpoint. When a module legitimately needs to reach
  something else, widen the policy there and add it to the gate's page rules;
  never let module code set its own security headers.
  Anything the policy opens is reachable by agent-written code with the
  session of whoever has the page open, a manager included. So a platform
  feature the widget needs on module pages gets routes of its own that are
  safe for any device of the company (`/who`), and its manager routes live on
  a path the policy does not open (`/people`). Never widen the policy to a
  prefix that also holds manager or admin routes.
- Every request below `auth.companyGuard` belongs to one company. A new route
  under `/c/:slug/` is scoped for free; a new route addressed by an id must be
  added to the `OWNERS` table in `src/auth.js` (its owning-company lookup) or
  it will be reachable across companies. A new route that names its company in
  the body scopes itself with `auth.ownsCompany(req, slug)`.
- A new platform table that belongs to a company goes in `backup.js`
  `PLATFORM_TABLES` and, if it holds secrets, stays out of `platform.companies`.
- Module code reaches nothing but `ctx`. The module gate holds agent builds
  and repo imports to the same rule. If a library module needs something new
  (hashing, a clock, an outside system), lend it on `ctx` in
  `registry.moduleServices`; never `require` it inside the module. Run
  `node scripts/test-modulegate.js` before pushing a change to `modules/` or
  to the gate.
- Outside systems are connections (`src/connections.js`): declared in
  module.json, set up on the connections page, lent as
  `ctx.connections.<name>`. A new kind gets a surface there, its settings and
  secrets in `platform.connections` (secrets encrypted), a page policy
  addition only if a device-side program must be reached, and gate rules for
  its declaration. Never let module code hold a credential, a printer address
  or a file the platform did not hand it.
