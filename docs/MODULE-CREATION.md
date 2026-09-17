# Module creation: concept

*Drafted 2026-09-17 from a scoping conversation with Brendan, revised the same day with his comments. Concept stage, not a build spec yet. Hard rules and decisions first, open questions last. Update this file as the concept firms up, the way ROADMAP.md is kept.*

## Hard rules (Brendan, 2026-09-17)

1. **Module creation lives inside the CI board.** A new module is a card that moves Feedback, Reviewing, In Progress, Done like any other item. There is no separate area of the app for it. The admin page only creates the card and opens the board.
2. **Nobody working a request touches the board or the platform.** Not the floor, not managers, not the agents building what they asked for. The build agent's write surface is the module's own directory. The platform (`src/`, `public/`, `server.js`, `principles/`), the board, the platform tables, other modules' schemas and every credential are out of reach by construction, not by policy: `cwd` plus `acceptEdits`, an env allow-list with no database URL and no secrets, migrations validated and scoped to the module's schema, outside systems reached only through a fixed service that holds the credentials. The intake screens, the connections page and the walkthrough cards are platform code, built from Cowork, never by the in-app agent.
3. **Plain words for the people using it, their own words for their systems.** Nothing a manager or operator reads explains how the tool is built. Their scanner, their label printer, their ERP by the name they use for it. Technical words only in the parts written for IT.

## What it is

A manager creates a new module from the board by answering plain-language questions. Fable 5.1 reads the answers and any attachments (a photo of the whiteboard, the spreadsheet they keep), asks a short second and if needed third round of its own questions, writes a design summary the manager confirms, then builds the first version through the same staged build, preview, tour, diagrams and deploy gate every change goes through today. Anything the tool cannot connect on its own (a printer, an ERP login) comes with a generated walkthrough. From then on the module is improved through floor feedback like any other.

The breadth target is any operational tracker a plant or a site might run: a thing (an order, a request, a place, a piece of equipment, a person's assignment) moving through stages, seen by a few roles on a few kinds of screen, connected to whatever the operation already uses, with a handful of rules and a few numbers that say whether it is working. The intake is generic on purpose. It never names a starting type.

Fable 5.1 is the model for every step: the generated rounds, the design summary, the build, the cross-check, the walkthrough. Step zero below is what makes that true for the build.

## Decisions taken 2026-09-17

| Question | Decision |
|---|---|
| Who starts and approves | Manager or admin starts the intake and confirms the design. The floor never sees the flow. |
| Where it lives | On the board, as a card. Hard rule 1. |
| Intake shape | A popout opened from the card, not the tile itself: too much real input to manage on a tile. One question per screen (a stepper), each with suggested answers plus a free-text box, progress shown, back button, close any time with everything saved. Generated rounds and the design gate use the same popout. Full screen on a phone or tablet, a large dialog on a desk. |
| Attachments | Yes, from the first version: a photo of the paper or whiteboard, a spreadsheet, an export from another program. Fable reads them and they seed names, stages, columns and starting data. |
| Size of Rev 1 | Deliberately small: the thing, its stages, one screen per role, the rules that must hold, the numbers on the board, the connections it needs. Everything else arrives through feedback. |
| Starting point | Always blank. No library pick. Fable may recognise a familiar shape and borrow from `principles/module-formats/` without the person choosing one. |
| Outside systems | Essential, not optional. Scanners, label printers, spreadsheets, ERP or MES, machines. The tool connects what it can and generates a walkthrough for the rest. See Connections. |
| Builder model and effort | Fable 5.1 on every build, effort `high` everywhere for now (module builds and change builds); revisit later. `agent: false` comes off the MODELS row once step zero is proven. |
| Budget | No run ever ends with money spent and nothing to show. Estimate shown before Confirm, the build staged in steps, a pause and Keep going at the budget line instead of a kill. Cap numbers are for Brendan's awareness during testing, not product constraints. |
| Reference doc | Updated by the build agent after every change to the module, same rule shape as tour.json (PRINCIPLES rule 8). |
| Names | Slug fixed at Confirm; title editable later from the Versions panel. |
| Round 2 on the floor | Not in v1. |
| Two modules in one change | Needed eventually, shape unknown. Read links stay read-only for now; see the experiment note. |

## Step zero: make Fable the builder

*Status 2026-09-17: done. Pushed and proven on the live instance: one UI change built on Sonnet 5 (regression) and one on Fable 5.1, both deployed. Fable is the builder from here on. Push 1 of the build order is complete.*

The "Fable cannot build" note in CLAUDE.md is a stale dependency, not a Fable limit. `@anthropic-ai/claude-agent-sdk` is pinned at 0.1.77, published 2026-01-06, months before Fable existed; its bundled `cli.js` is what exits 1 after the first reply (run 12 on 2026-09-11: init seen, three messages, nothing on stderr). The current SDK is 0.3.274 (2026-09-16), bundling Claude Code 2.1.274 as a native binary, and it carries explicit Fable 5.1 support (a Fable-specific prompt bundle, effort levels, entitlement handling).

What the upgrade touches:

- `package.json`: SDK to 0.3.x. The package now ships the CLI as a per-platform optional dependency (`@anthropic-ai/claude-agent-sdk-linux-x64` on Railway) and declares peer dependencies on `@anthropic-ai/sdk` >= 0.93 (we are on 0.30), `zod` 4 and the MCP SDK. Bump `@anthropic-ai/sdk` too; `runStructured` and `runChat` need a pass against the newer client.
- `src/agent.js runAgent`: every option we pass still exists (`model`, `systemPrompt`, `allowedTools`, `permissionMode: "acceptEdits"`, `maxTurns`, `abortController`, `env`, `stderr`, `cwd`). Added `effort: "high"` (`SOS_AGENT_EFFORT`) and `tools` set to the five file tools, so Bash, web and subagents are not in the model's tool list at all. The SDK's `maxBudgetUsd` is a hard kill, so it is only the far safety rail (three times the run cap), never the working limit; the working limit is ours and pauses instead (see Budget). One trap found in the new SDK: a turn that ends on an API error comes back as subtype `success` with `is_error` set, and the runner now throws on it rather than storing the error text as the build summary.
- `agentEnv()`: add `CLAUDE_CODE_NO_MODEL_FALLBACK=1` so the CLI can never silently substitute another model. Record `message.model` from the init message and every assistant message into `evidence.models_seen`; a build claims Fable only if that set is exactly `{claude-fable-5-1}`.
- `MODELS`: drop `agent: false` and the note on the Fable row; `buildModelFor` stops substituting.
- Root user on Railway: keep `acceptEdits`. Re-check the newer CLI still accepts it as root.

Proof: push, run one change build on Sonnet (regression), one on Fable (the proof), read `evidence.models_seen` and the cost. About $1 to $2. The sandbox has no key and the Mac VM has no network, so the proof happens on the live instance.

## The flow, on the board

*Status 2026-09-17: push 3 built and tested in fake mode end to end (card, popout, all thirteen questions, photo and spreadsheet attachments, a generated round, the design gate with Adjust and Start over, Approve, Withdraw, the admin entry); the card stops at "Design confirmed" until push 4 wires the build. First live test still to do: one real intake on Fable, about $1.*

A module request is a feedback row of kind `module_request` with an intake record behind it. It uses the four columns the way every card does:

| Column | What the card is doing |
|---|---|
| **Feedback** | Created by "New module" on the module strip or the admin company card. The tile shows the name once given, "6 of 12 answered" and a Continue button; the button opens the intake popout, where the fixed questions run one per screen with attachments where they fit. Decline on the tile means abandon. |
| **Reviewing** | This is the Review with AI step for a module. Fable reads the answers and attachments and returns a round 2 or "I have enough"; same again for round 3; hard cap three rounds. The tile says "Fable has 4 more questions" or "Design ready to review", and Continue opens the same popout: the generated questions, then the design summary with a one-line BLUF and one check box per point, the requirement gate the board already has: tick every box, or Adjust the text (Fable re-issues the summary against the edit), or Start over. Confirm is "Approve build" and shows the cost estimate first. |
| **In Progress** | The build, in steps (see The build). The card shows which step is running, the preview link as soon as the first step is staged, the checks, the fix and override and abort actions a change build has, and at the deploy gate the setup walkthrough for anything that still needs a human. Deploy needs the walkthrough's blocking steps ticked or explicitly skipped. |
| **Done** | Live. The "We did" line, the module in the strip with its Open live, Diagrams and tour, the origin record (every answer, attachment and round) readable from the Versions panel. |

Nothing here is new machinery: feedback row, proposal, run, version. The intake record is the extra table.

## The intake popout

The tile is the status and the way in; the popout is where the real input happens (Brendan, 2026-09-17: far too much to manage from one tile). One popout serves the fixed questions, the generated rounds and the design gate, so the person learns it once.

- Opens from Continue on the tile. Full screen on a phone or tablet, a large centered dialog on a desk, the board dimmed behind it.
- One question per screen: the question, a one-line hint, the suggested answers as chips, a free-text box, an Attach button where the question allows one. Next and Back, a progress line ("7 of 12"), and the round named at the top ("Your answers", "Fable's questions", "The design").
- Every answer saves the moment it is given. Close (X or Escape) at any point; the tile shows where it left off and Continue reopens at that screen. Two people in the same intake: last save wins, and the tile names who saved last.
- The design gate is the last screens of the same popout: the BLUF with the check boxes, then the full text (with Adjust turning it into an editor), then the estimate and Approve build. Confirm stays disabled until every box is ticked, as on the requirement gate. This is a deliberate exception (Brendan, 2026-09-17) to the rule that gates live on the tile: change builds keep their requirement gate on the tile, module creation puts it in the popout because the summary is long and the person is already in there. Do not move it back for consistency.
- The setup walkthrough at the deploy gate opens in the same popout style from the In Progress tile: the checklist, Test buttons, the IT note with Copy.
- New UI piece in `public/assets/`, platform code. The existing board panels (Adjust, Versions, the QR card) stay as they are for now; if the popout proves better for the requirement gate too, that is a separate change.

## Round 1: the fixed questions

Same for every module, in this order. Wording is the product copy; keep it plain.

| # | Question | Answer shape |
|---|---|---|
| 1 | What should we call it? | Short name. Slug derived; collision with an existing module caught here. |
| 2 | In a sentence or two, what is it for? Walk me through a normal day with it. | Free text. |
| 3 | Who will use it? | Chips: people on the floor, leads or supervisors, managers, office or planning, people outside the company. Rough headcount per group. |
| 4 | What does each of those people have in hand when they use it? | Per group: phone, tablet, wall screen, desk computer, paper today. |
| 5 | What is the thing being tracked? Give it a name in your own words. | Free text, one noun. Hint text stays generic. |
| 6 | How is it kept track of today? Show me if you can. | Chips: whiteboard, clipboard or paper, spreadsheet, another program, in someone's head, not at all. **Attach**: photo of the board or the paper, the spreadsheet, an export. |
| 7 | What happens to it from start to finish? List the stages in order. | Ordered list: add, remove, drag to reorder. Pre-filled from an attachment when Fable can read stages off it. |
| 8 | What goes wrong today that this should stop? | Up to three short items. |
| 9 | What must never happen? | Free text. These become the rules. |
| 10 | Which numbers would tell you it is working? | Free text with chips: how many, how long, how late, how often, how full. |
| 11 | What does this need to work with that you already use? | Chips: barcode or QR scanners, a label printer, a spreadsheet you keep, your ERP or scheduling system (a box for what you call it), a machine or a PLC, a scale, nothing. Each pick earns a short follow-up in round 2. |
| 12 | Do you have a list to start from? | **Attach**: a spreadsheet of parts, locations, people, equipment, whatever the thing is. Fable maps the columns and asks about anything unclear in round 2. Rows become starting data at first deploy, after a preview. |
| 13 | Does it need to know anything from a module you already have? | Only shown when the company has other modules. Chips of the live modules plus "no". Read only, through `ctx.peer`. |

## Attachments

Accepted at 6 and 12 and on any generated question that asks for one: photos (phone camera or upload), spreadsheets (xlsx, csv), pdf. Stored in `platform.attachments` (bytea, 15 MB each, ten per intake), never on the container disk. Photos go to Fable as images; spreadsheets are parsed to rows and go as text with a sample. What they seed: stage names, column names, the fields on the thing, example values, starting rows. Every seeded value is shown as a pre-filled answer the manager can change, never silently adopted.

## Rounds 2 and 3: generated

Input to Fable: the round 1 answers and attachments, `principles/PRINCIPLES.md`, the plain-words rules, the module contract summary, the connection kinds the platform supports, the list of existing modules. Output, structured:

```
{ enough: false,
  questions: [ { id, text, hint, kind: "choice" | "text" | "order" | "attach",
                 options: [..], allow_other: true } ] }
```

What Fable is told to ask about, and only this: what still changes the design. Who may move the thing from one stage to the next. What happens at capacity, or when two people want the same thing. Whether things already carry a number or a name, and what a scan of one contains. What the one-glance screen shows first. Time: due dates, shift boundaries, how long a thing may sit. What "done" means and whether done things stay in view. And for every outside system picked at 11: the follow-ups that shape the connection, in the company's words. For a label printer: what is on the label, the label size, roughly how many a day, which printer (a photo of it is fine). For an ERP: what they call it, which few things this module needs from it (parts, orders, customers, stock), how fresh it has to be, who in the company can get a login. For a spreadsheet: which columns matter, who keeps it up to date. For a scanner: what gets scanned and what is printed on the code today. For a machine or PLC: what it reports and where that shows up now.

Rules: at most six questions a round; never ask something already answered; never ask about how the tool is built, always ask about the technology in their operation; every question has suggested answers and "something else"; each question carries a one-line hint saying why it matters, in plain words.

## The design summary

Same shape as `principles/module-formats/*.md`, so it drops straight in as the module's `reference.md`, with four more sections: "Connections" (each outside system, what the module does with it, what the tool connects itself, what needs a person), "Starting data" (what gets loaded from the attachments), "What Rev 1 leaves out" (named, so the manager sees the small scope is a choice) and "Change guidance" (the UI versus functionality hints the proposal model uses later). Full section list: purpose; who uses it and where; the thing and its stages; screens, one per role, each with its single prominent action; rules; numbers on the board; connections; starting data; what Rev 1 leaves out; change guidance.

The confirmed summary is both the module's reference doc and the build brief. Every later change on the module is guided by it, and the build agent updates it with every change (PRINCIPLES rule, same shape as rule 8 for tour.json), which is what makes the generic flow hold together over time.

## The build

- Fable, effort `high`. Working limit `SOS_MAX_MODULE_USD` (25 to start), applied as a pause, not a kill. Far safety rail `maxBudgetUsd` at three times the estimate, and even that keeps the draft.
- A new platform doc, `principles/MODULE-CONTRACT.md`, that tells the agent what a module is: `module.json` fields (`name`, `title`, `description`, `entry`, `pages` with labels, `smoke`, optional `agents`, new `connections`), the `routes.js` signature and the `ctx` services including `ctx.connections`, migrations additive only and the words the validator rejects, pages computing `base` from `location.pathname`, the feedback widget injection, `tour.json` shape, `data-changed` marks, the scan-field pattern (a focused text field, Enter ends a scan, prefix and suffix stripped, works with any keyboard-mode scanner), the label template pattern (ZPL kept as a module file, previewed as an image before anything prints), no em or en dashes. Today's build prompt pins changes to an existing module's files; a from-scratch build needs the contract stated.
- **In steps.** Step 1: manifest, migrations, routes, the one-glance screen. Step 2: the remaining screens, one per role. Step 3: rules, numbers, connections, starting data import, tour, reference doc. Each step is its own agent run against the same draft, staged and previewable when it lands, so the card can say "Screens done, wiring the printer" and a stop at any point leaves something to look at.
- Validation before staging, no tokens: manifest parses; every page file exists; migrations pass `migrate.js`; `routes.js` loads in a throwaway require; the smoke endpoints answer on a staging mount over a scratch schema; declared connections exist in the platform's list of kinds.
- Cross-check by Fable, an independent call: does the module match the confirmed design, PRINCIPLES.md and STYLE.md; do all visible strings pass the plain-words rules; is the tour present; does every connection go through `ctx.connections` and nowhere else.
- Deploy gate as today, plus the setup walkthrough. Rev 1 goes live as v1 of the module.

## Budget without throw-away

The failure Brendan named: a company spends $25 and has nothing. So:

- The estimate is shown at Confirm ("about $12, most of it the build"), from the number of screens, connections and rounds, calibrated against real runs as they accumulate.
- The build runs in the three steps above. Money spent on a finished step is never lost.
- When the running total crosses the working limit mid-step, the platform tells the agent to finish the file it is on and write a short note of what is left, then stages the draft and the card shows Preview what is there, Keep going (about $N more) and Stop here. Keep going is one click and one more slice; Stop keeps the draft as a version the manager can build on later through ordinary feedback.
- A step that fails its checks keeps its draft staged, with the fix rounds a change build has today.
- `SOS_MONTHLY_CAP_USD` stays instance-wide for now (150 during build-out), with a per-company cap when pilots start paying for their own use. Both are Brendan's testing awareness numbers, not product limits.

## Connections: the outside world

The rule that lets a module be as complex as the operation needs without the agent ever touching the platform: **the platform owns every connection, the module only uses it.** A connection is a record in `platform.connections` (company, kind, name, settings, encrypted secrets, status, last checked) set up on a platform page by the manager or admin, tested with one button, and handed to modules as `ctx.connections.<name>` with a small fixed surface per kind. The build agent sees the surface and the connection's name, never the settings or the secrets (they are not in its env and not in its cwd).

Kinds for the first version, and where each actually runs, because the instance is in the cloud and the printers and scanners are on the plant network:

| Kind | What the module gets | Runs where | Needs a person for |
|---|---|---|---|
| Files | Spreadsheet, csv and photo upload at intake and from module pages; rows mapped to the module's tables with a preview | In the tool | Nothing |
| Scanners | Nothing to connect: keyboard-mode barcode and QR scanners type into the scan field. Phone camera scanning as the fallback, decoder inline in the page, no CDN | On the device | Nothing, or pairing a Bluetooth scanner to the tablet |
| Label printer | `print(template, data)` that renders the label to an image for preview and sends ZPL to the printer from the device on the plant network, through Zebra's own small local program (Browser Print) that the page talks to | On the device, plant side | Installing Browser Print on the PC or tablet that prints, picking the printer; the walkthrough covers it |
| ERP or MES, read only | `query(name, params)` over a short list of named, pre-approved read-only queries (the Epicor BAQ shape, and the SAP equivalent NEWP will want), results cached with a freshness the intake asked about | In the tool, if the ERP is reachable from the cloud | A read-only login from IT, which the walkthrough asks for in plain words, plus a draft note to IT with the technical part |
| Machines, PLCs, scales, on-prem ERP | Later. The general answer for anything only reachable on the plant LAN is a small bridge program on a plant PC that the instance talks to, which is also the on-prem deployment path from the roadmap | Plant side | Installing the bridge |

The intake's question 11 names what is needed; round 2 shapes it; the design summary's Connections section says what the tool will connect and what it cannot; the build wires the module to the surface; the setup walkthrough gets the person through the rest. A module with an unfinished connection still deploys and shows "not connected yet" in the right places, so the rest of it is useful on day one.

## The setup walkthrough

Generated by Fable at the deploy gate from the module's connections and the intake answers, in two voices: steps for the manager in plain words (go to this page, choose the printer, print the test label), and for anything IT has to do, a ready-to-send note in the words IT uses (what read access, to which tables or queries, for which login). Shown on the In Progress card as a checklist with a Done box per step and a Test button where the platform can check for itself (printer answers, ERP query returns rows). Blocking steps must be ticked or explicitly skipped before Deploy; non-blocking ones follow the module to its Done card and the module page until they are finished. The walkthrough is also kept as a module doc so it can be reopened later and updated when the connection changes.

## Two modules in one change (experiment, later)

Brendan expects module dependencies to come up, with the answer possibly being one change pushed through two modules at once. Not designed yet. The likely shape: a proposal that names two target modules, one run that builds a draft version of each, one preview with both, one deploy that switches both or neither, one rollback that undoes both. Until then, `ctx.peer` stays read-only and shared data goes through the platform, not module to module. To be worked out by trying it on the demo company once the intake exists.

## The vocabulary guard

`principles/PLAIN-WORDS.md`: the words that never appear in anything a manager or operator reads during this flow, with the replacement for each. First draft of the banned list: API, database, schema, table, column, field, record, row, endpoint, migration, deploy, JSON, query, backend, frontend, server, sync, token, model (as in AI model), prompt. Replacements are things like screen, list, stage, rule, number on the board, "connects to", "kept", "shown". Two exceptions, both from hard rule 3: the company's own names for its systems are always allowed (SAP, Epicor, "the Zebra", whatever they said at question 11), and the IT note inside a walkthrough is written for IT and may use the technical words.

Applied to generated questions, the design summary, the manager-facing part of walkthroughs, every visible string in built pages (through the cross-check), and later to proposal copy. Enforcement in three cheap steps: a regex pass; if anything trips, a Haiku rewrite; a second regex pass. A question that still fails is dropped; a summary that still fails is flagged to the manager with the offending line.

## Board: pick the modules you are looking at

*Status 2026-09-17: built (push 2), tested in the sandbox on desktop and phone widths; awaiting the push.*

Module chips in the module strip. Click toggles, "All" resets. The selection filters all four columns, the KPI strip, the system review default and the batch panels. Platform requests are unaffected. The selection is kept per company in the browser and mirrored in the URL (`?m=a,b`), so a filtered board can be linked, and later printed as its own QR sign. A module request card belongs to the module it is creating, so it shows under that chip once the name is given and under All before.

## Admin page

Company card gains "New module", which creates the request card for that company and opens the board on it; a line per intake in progress with status and a link to the card; and the connections page link. The library card is unchanged; library modules and created modules sit side by side in the company's module list, the created ones marked "made here".

## Data

- `platform.module_intakes`: id, company, feedback_id, started_by (role), status (`answering`, `thinking`, `design`, `confirmed`, `building`, `paused`, `done`, `abandoned`), module name and slug, answers (JSONB by round), generated rounds (JSONB, questions as issued), design (JSONB: bluf, items, reference_md, adjustments, estimate_usd), run ids per step, cost_usd, timestamps.
- `platform.attachments`: id, company, intake_id, question_id, filename, mime, bytes, parsed (JSONB for spreadsheets), created_at.
- `platform.connections`: id, company, kind, name, settings (JSONB), secrets (encrypted with a key that lives only in Railway, never in the agent env), status, last_checked, last_error.
- `platform.setup_steps`: id, company, module, run_id, order, text, audience (`manager` | `it`), blocking, test kind, done_at, skipped_at.
- AI spend goes to `platform.ai_usage` as kinds `intake`, `design`, `module_build`, `module_check`, `walkthrough`, so it counts in `monthlySpend` and shows on the admin card.

## Cost, at Fable prices ($10 in, $50 out per million)

| Step | Rough cost |
|---|---|
| Generated round (up to two) | $0.10 to $0.20 each, more with photos |
| Design summary | $0.20 to $0.40 |
| Build, three steps at effort high | $4 to $15, depends on screens and connections |
| Cross-check | $0.50 to $1 |
| Walkthrough | $0.10 to $0.20 |
| Whole module | roughly $6 to $20 |

A change build on Fable lands around 35 cents to $1.60 against 7 to 32 cents on Sonnet today. Brendan's note: these caps and figures are for his awareness during testing; budgets will rise for a solution that is worth it to a company, and the caps will likely be loosened or removed once testing is done.

## Open questions for Brendan

1. Half-finished intakes: abandoned automatically after 14 days, or never (the card just sits in Feedback)?
2. Which ERP first for the read-only kind: SAP (NEWP) or Epicor (known shape from the BAQ integration)? The first one built sets the pattern for the named-query list.
3. Who enters connection settings and secrets: the company's manager, or only the admin (us) during pilots?
4. The plant-side bridge for on-prem systems: design it now as part of Connections, or wait until a pilot actually has an unreachable ERP?
5. Cloud reach at the pilots: does NEWP's SAP expose anything reachable from outside, or is it on-prem only? Decides whether their first module needs the bridge.
6. Attachment limits (15 MB, ten per intake) fine for a phone photo of a whiteboard and a normal spreadsheet?

## Suggested build order

Six pushes, each testable on its own:

1. SDK upgrade, Fable as builder at effort high, `models_seen` evidence, no model fallback, kept drafts at the safety rail. Prove with one Sonnet and one Fable change build.
2. Board module filter and URL mirror. Small, independent, useful immediately.
3. The module request card: intake record, stepper, fixed questions, attachments (files kind of Connections), generated rounds, plain-words guard, design gate with estimate. Fake mode returns canned rounds and a canned summary so the whole flow runs at zero spend.
4. Build from a design: MODULE-CONTRACT.md with the scan-field and label patterns, the from-scratch build prompt, the three steps with pause and Keep going, validation, cross-check, import as staged v1, deploy.
5. Connections and walkthroughs: the connections page, printer kind through Browser Print, read-only ERP kind with named queries, generated walkthroughs with tests and the IT note, "not connected yet" states.
6. Admin entry, origin record in the Versions panel, spend on the admin card, the two-module experiment on the demo company.
