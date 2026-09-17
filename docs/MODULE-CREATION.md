# Module creation: concept

*Drafted 2026-09-17 from a scoping conversation with Brendan. Concept stage, not a build spec yet. Decisions taken so far are listed first, the open questions last. Update this file as the concept firms up, the way ROADMAP.md is kept.*

## What it is

A manager creates a new module from inside the app by answering plain-language questions. Fable 5.1 reads the answers, asks a short second (and if needed third) round of its own questions, writes a design summary the manager confirms, then builds the first version through the same staged build, preview, tour, diagrams and deploy gate every change goes through today. From then on the module is improved through floor feedback like any other.

The breadth target is any operational tracker a plant or a site might run: a thing (an order, a request, a place, a piece of equipment, a person's assignment) moving through stages, seen by a few roles on a few kinds of screen, with a handful of rules and a few numbers that say whether it is working. The intake is generic on purpose. It never names a starting type.

Fable 5.1 is the model for every step of this flow: the generated rounds, the design summary, the build, the cross-check. Step zero below is what makes that true for the build.

## Decisions taken 2026-09-17

| Question | Decision |
|---|---|
| Who starts and approves | Manager or admin starts the intake and confirms the design. The floor never sees the flow. The admin can also start it from a company card on /admin. |
| Intake shape | One question per screen (a stepper), each with suggested answers plus a free-text box, progress shown, back button. Generated rounds look identical to the fixed round. |
| Size of Rev 1 | Deliberately small: the thing, its stages, one screen per role, the rules that must hold, the numbers on the board. Everything else arrives through feedback. |
| Starting point | Always blank. No library pick. Fable may recognise a familiar shape and borrow from `principles/module-formats/` without the person choosing one. |
| Builder model | Fable 5.1, on every module-creation build. `agent: false` comes off the MODELS row once step zero is proven. |

## Step zero: make Fable the builder

The "Fable cannot build" note in CLAUDE.md is a stale dependency, not a Fable limit. `@anthropic-ai/claude-agent-sdk` is pinned at 0.1.77, published 2026-01-06, months before Fable existed; its bundled `cli.js` is what exits 1 after the first reply (run 12 on 2026-09-11: init seen, three messages, nothing on stderr). The current SDK is 0.3.274 (2026-09-16), bundling Claude Code 2.1.274 as a native binary, and it carries explicit Fable 5.1 support (a Fable-specific prompt bundle, effort levels up to `max`, entitlement handling).

What the upgrade touches:

- `package.json`: SDK to 0.3.x. The package now ships the CLI as a per-platform optional dependency (`@anthropic-ai/claude-agent-sdk-linux-x64` on Railway) and declares peer dependencies on `@anthropic-ai/sdk` >= 0.93 (we are on 0.30), `zod` 4 and the MCP SDK. Bump `@anthropic-ai/sdk` too; `runStructured` and `runChat` need a pass against the newer client.
- `src/agent.js runAgent`: every option we pass still exists (`model`, `systemPrompt`, `allowedTools`, `permissionMode: "acceptEdits"`, `maxTurns`, `abortController`, `env`, `stderr`, `cwd`). Two additions worth taking: `maxBudgetUsd` (the SDK enforces the cap instead of our token estimate) and `effort` (`max` for module builds, `high` for change builds, settable per company later).
- `agentEnv()`: add `CLAUDE_CODE_NO_MODEL_FALLBACK=1` so the CLI can never silently substitute another model. Record `message.model` from the init message and every assistant message into `evidence.models_seen`; a build claims Fable only if that set is exactly `{claude-fable-5-1}`.
- `MODELS`: drop `agent: false` and the note on the Fable row; `buildModelFor` stops substituting.
- Root user on Railway: keep `acceptEdits`. Re-check the newer CLI still accepts it as root.

Proof: push, run one change build on Sonnet (regression), one on Fable (the proof), read `evidence.models_seen` and the cost. About $1 to $2. The sandbox has no key and the Mac VM has no network, so the proof happens on the live instance.

## The flow

Stations of a module intake, each a status on a `platform.module_intakes` row:

1. **Start.** "New module" on the board's module strip and on the admin company card. Creates the intake (company, who started it, status `answering`). A half-finished intake shows on the board as a card with a Resume link.
2. **Round 1.** The fixed questions below, one per screen. Answers are saved as they are given.
3. **Thinking.** Fable reads round 1 and returns either a round 2 or "I have enough". Same after round 2. Hard cap: three rounds. Every generated question passes the vocabulary guard before it is shown.
4. **Design.** Fable writes the design summary (the module's reference format) with a one-line BLUF and one check item per point. The manager ticks every item, or Adjusts the text (Fable re-issues the summary against the edit), or Starts over. Confirm is disabled until every box is ticked, same as the requirement gate.
5. **Building.** Fable builds Rev 1 into a fresh module directory. The platform validates it, imports it as a staged v1, runs the smoke endpoints, the Fable cross-check and the tests, then waits at the deploy gate with the preview links. Fix rounds, override, retry and cancel work as they do for a change build.
6. **Done.** Deploy makes it live, draws the diagrams, seeds the tour and the reference doc. The intake answers stay attached to the module as its origin record, readable from the Versions panel.

## Round 1: the fixed questions

Same ten for every module, in this order. Wording is the product copy; keep it plain.

| # | Question | Answer shape |
|---|---|---|
| 1 | What should we call it? | Short name. Slug derived; collision with an existing module is caught here. |
| 2 | In a sentence or two, what is it for? Walk me through a normal day with it. | Free text. |
| 3 | Who will use it? | Chips: people on the floor, leads or supervisors, managers, office or planning, people outside the company. Rough headcount per group. |
| 4 | What does each of those people have in hand when they use it? | Per group: phone, tablet, wall screen, desk computer, paper today. |
| 5 | What is the thing being tracked? Give it a name in your own words. | Free text, one noun. Hint text stays generic. |
| 6 | How is it written down today? | Chips: whiteboard, clipboard or paper, spreadsheet, another program, in someone's head, not at all. |
| 7 | What happens to it from start to finish? List the stages in order. | Ordered list: add, remove, drag to reorder. |
| 8 | What goes wrong today that this should stop? | Up to three short items. |
| 9 | What must never happen? | Free text. These become the rules. |
| 10 | Which numbers would tell you it is working? | Free text with chips: how many, how long, how late, how often, how full. |
| 11 | Does it need to know anything from a module you already have? | Chips of the company's live modules plus "no". Read only, through `ctx.peer`. |

Eleven, not ten, because 11 only appears when the company has other modules.

## Rounds 2 and 3: generated

Input to Fable: the round 1 answers, `principles/PRINCIPLES.md`, the plain-words rules, the module contract summary, the list of existing modules. Output, structured:

```
{ enough: false,
  questions: [ { id, text, hint, kind: "choice" | "text" | "order",
                 options: [..], allow_other: true } ] }
```

What Fable is told to ask about, and only this: what still changes the design. Who may move the thing from one stage to the next. What happens at capacity, or when two people want the same thing. Whether things already carry a number or a name. What the one-glance screen shows first. Time: due dates, shift boundaries, how long a thing may sit. What "done" means and whether done things are kept in view.

Rules: at most six questions a round; never ask something already answered; never ask about technology; every question has suggested answers and "something else"; each question carries a one-line hint saying why it matters, in plain words.

## The design summary

Same shape as `principles/module-formats/*.md`, so it drops straight in as the module's `reference.md`, with two more sections: "What Rev 1 leaves out" (named, so the manager sees the small scope is a choice) and "Change guidance" (the UI versus functionality hints the proposal model uses later). Sections: purpose; who uses it and where; the thing and its stages; screens, one per role, each with its single prominent action; rules; numbers on the board; what Rev 1 leaves out; change guidance.

The confirmed summary is both the module's reference doc and the build brief. Every later CI change on the module is guided by it, which is what makes the generic flow hold together over time.

## The build

- Fable, effort `max`, its own cap `SOS_MAX_MODULE_USD` (proposed 25), passed to the SDK as `maxBudgetUsd`.
- A new platform doc, `principles/MODULE-CONTRACT.md`, that tells the agent what a module is: `module.json` fields (`name`, `title`, `description`, `entry`, `pages` with labels, `smoke`, optional `agents`), the `routes.js` signature and the `ctx` services, migrations additive only and the words the validator rejects, pages computing `base` from `location.pathname`, the feedback widget injection, `tour.json` shape, `data-changed` marks, no em or en dashes. Today's build prompt pins changes to an existing module's files; a from-scratch build needs the contract stated.
- Validation before staging, no tokens: manifest parses; every page file exists; migrations pass `migrate.js`; `routes.js` loads in a throwaway require; the smoke endpoints answer on a staging mount over a scratch schema.
- Cross-check by Fable, an independent call: does the module match the confirmed design, PRINCIPLES.md and STYLE.md; do all visible strings pass the plain-words rules; is the tour present.
- Deploy gate as today. Rev 1 goes live as v1 of the module.

## The vocabulary guard

`principles/PLAIN-WORDS.md`: the words that never appear in anything a manager or operator reads during this flow, with the replacement for each. First draft of the banned list: API, database, schema, table, column, field, record, row, endpoint, migration, deploy, JSON, query, backend, frontend, server, integration, sync, token, model (as in AI model), prompt. Replacements are things like screen, list, stage, rule, number on the board, "connects to", "kept", "shown".

Applied to generated questions, the design summary, every visible string in built pages (through the cross-check), and later to proposal copy. Enforcement in three cheap steps: a regex pass; if anything trips, a Haiku rewrite; a second regex pass. A question that still fails is dropped; a summary that still fails is flagged to the manager with the offending line.

## Board: pick the modules you are looking at

Module chips in the module strip. Click toggles, "All" resets. The selection filters all four columns, the KPI strip, the system review default and the batch panels. Platform requests are unaffected. The selection is kept per company in the browser and mirrored in the URL (`?m=a,b`), so a filtered board can be linked, and later printed as its own QR sign.

## Admin page

Company card gains "New module" (the admin runs the same intake, acting for that company), a line per intake in progress with status and Resume, and Abandon. The library card is unchanged; library modules and created modules sit side by side in the company's module list, the created ones marked "made here".

## Data

`platform.module_intakes`: id, company, started_by (role), status (`answering`, `thinking`, `design`, `confirmed`, `building`, `done`, `abandoned`), module name and slug, answers (JSONB by round), generated rounds (JSONB, questions as issued), design (JSONB: bluf, items, reference_md, adjustments), run_id, cost_usd, timestamps. AI spend goes to `platform.ai_usage` as kinds `intake`, `design`, `module_build`, `module_check`, so it counts in `monthlySpend` and shows on the admin card.

## Cost, at Fable prices ($10 in, $50 out per million)

| Step | Rough cost |
|---|---|
| Generated round (up to two) | $0.10 to $0.20 each |
| Design summary | $0.20 to $0.40 |
| Build | $5 to $20, depends on screens and rounds |
| Cross-check | $0.50 to $1 |
| Whole module | roughly $7 to $25 |

A change build on Fable lands around 35 cents to $1.60 against 7 to 32 cents on Sonnet today. The $25 monthly cap is gone after one or two modules; propose raising `SOS_MONTHLY_CAP_USD` to 150 for the build-out period and adding a per-company cap when pilots start paying for their own API use.

## Open questions for Brendan

1. Attachments at question 6: can the manager add a photo of the whiteboard or a spreadsheet? It would seed names and columns and shorten round 2, but it adds vision and file handling. Rev 1 of the flow or later?
2. Peer access: a new module reads other modules through `ctx.peer` today. Should a created module ever write to another module? Recommendation: no, reading only.
3. Half-finished intakes: resume from the board; abandoned automatically after how long? Proposal: 14 days.
4. Should round 2 ever go to the floor (a one-line question sent to an operator's station page)? Proposal: not in v1.
5. Names: slug fixed at Confirm; title editable later from the Versions panel?
6. Keeping the reference doc current: leave it editable and add a PRINCIPLES rule that the build agent updates it with every functionality change (like rule 8 for tour.json)? Or redraw it after every deploy the way diagrams are?
7. Caps: `SOS_MAX_MODULE_USD` at 25 and the monthly cap at 150, or other numbers?
8. Effort: `max` for module builds and `high` for change builds, or `max` everywhere and accept the cost?

## Suggested build order

Five pushes, each testable on its own:

1. SDK upgrade, Fable as builder, `models_seen` evidence, `maxBudgetUsd`, effort. Prove with one Sonnet and one Fable change build.
2. Board module filter and URL mirror. Small, independent, useful immediately.
3. Intake: the `module_intakes` table, the stepper, round 1, generated rounds, the plain-words guard, the design gate. Fake mode returns canned rounds and a canned summary so the whole flow runs at zero spend.
4. Build from a design: MODULE-CONTRACT.md, the from-scratch build prompt, validation, cross-check, import as staged v1, deploy.
5. Admin entry, resume and abandon, origin record in the Versions panel, spend on the admin card.
