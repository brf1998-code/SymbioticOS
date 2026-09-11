# Symbiotic Operating System — Product Vision and Roadmap

*Drafted 2026-08-13. Working doc, update aggressively. Decisions from Brendan same day: thin working slice first, one runtime with managed modules, product under Finn Operations for now (rename likely later), simulated factory with the backend and process as the thing being proven.*

---

## 1. What this is

Symbiotic OS is an operating system for factories. It forms around how a company actually runs instead of forcing the company into the mold of an enterprise system. A production manager with process knowledge and no software background selects a module type, describes what the floor needs, and the system builds it. From then on, every point of friction on the floor feeds a continuous improvement loop: feedback comes in, the AI drafts a proposal, the manager reviews and redirects it, the AI builds the revision and shows a demo, and the manager approves deployment. The whole loop lives in one application. No GitHub, no Railway, no accounts to wire together, no git to understand.

The bar for usability: if someone can run their team on Teams, they can run their factory's software on this.

## 2. Why this wins

The Langmuir deployment already proved the method: an operator-grade system built in weeks, adopted by the floor (4.91/5 ease of use, 100% would recommend), at a running cost in the hundreds of dollars per year, with measured value around $220K/yr. The method is replicable by a skilled person. What is not replicable is the delivery machinery, and today that machinery is the expensive part. The Langmuir workspace docs are a catalog of the friction a technical operator has to absorb:

- Pull before every edit or a fix gets silently reverted; two people pushing ten repos
- Per-machine git transport differences (SSH alias vs HTTPS), PATs dropped in gitignored files, clone-and-graft push procedures
- Stale index.lock files from sandboxed git; "never run git from the sandbox"
- A day of work lost editing a retired repo because nothing says which repo serves a feature
- Railway env vars, browser cache masking deploys, Apps Script deployment versioning

Every one of those is a reason a nontechnical production manager cannot run the current stack. Symbiotic OS deletes the entire list by making build, stage, review, deploy, and rollback native operations of one application. The moat is not the AI. It is a delivery loop so well defined that using it is easier than not using it.

This is also the productization of the operator-as-builder hypothesis from the thesis work (Mindell's question: can an operator build their own system?). If the answer is yes, the market expands from "we send a team in" to "we equip the person with process knowledge."

## 3. Product concept

### The CI loop is the spine

The product's home screen is the improvement board, run exactly like the Langmuir CI board's lifecycle, with the AI wired into two of the stages:

| Stage | Who acts | What happens |
|---|---|---|
| **Feedback** | The floor | Friction reports from a widget on every module page, plus manager-entered items. Recurrence counts, not votes. |
| **Reviewing** | AI, then manager | The AI reads the item and drafts a proposal: what it would change, in which module, why, and what it would look like. Manager approves, adjusts, redirects, or declines. Nothing builds without this gate. |
| **In Progress** | AI | The approved proposal gets built against a staged copy of the module. When done, the card shows a description of the change and a live demo link to the staged version. |
| **Deploy approval** | Manager | Manager clicks through the demo, then approves. Deploy is one click; rollback is one click. |
| **Done** | System | The card records the "you said / we did" outcome, visible to the floor. |

Two design rules carried over from what worked at Langmuir: the manager gate before anything reaches production is structural, not procedural (the AI's write surface is staging only), and closing the loop visibly back to the person who reported the friction is what keeps feedback coming.

### Module creation

Same loop, bigger grain. The manager picks a general module type from a library, each type backed by a reference format distilled from builds that already worked:

- Production line board (line status, takt, andon)
- Inventory pull / pick queue / stow
- Receiving and shipping (scan-verified)
- KPI board
- Request board (tooling-style intake and fulfillment)
- CI / support intake (the board itself is a module)
- Blank module (describe it from scratch)

The reference format plays the role DESIGN.md plays in the module playbook: it names the data model, state machine, and pages before code, and the AI walks the manager through the handful of decisions that matter in plain language (who uses it, on what device, what states a thing moves through). Then the module goes through the same propose, build, demo, deploy flow. Rev 1 ships deliberately small and gets iterated through floor feedback, which is the phase arc from MODULE_PLAYBOOK.md with the phases automated.

### Governing principles as files

The product ships with its principles as readable MD files that both the AI and the humans use, mirroring how docs/knowledge/ works at Langmuir:

- PRINCIPLES.md — operator-first rules (one prominent action per role, phone/tablet-first, role-specific views, never make operators navigate)
- Module reference formats (one per module type)
- STYLE.md — one visual language across every module
- GUARDRAILS.md — what the AI may and may not touch, approval gates, cost caps
- Per-factory knowledge files the system accumulates: the decisions and gotchas that are not derivable from the code, written as it builds

These files are the portable form of the methodology. They are also what makes the AI swappable: Claude first because it is proven, but the instructions live in the product, not in the model.

## 4. Architecture direction

Decision: **one runtime, managed modules.** A single application per factory hosts every module. This matches the observed gravity at Langmuir (modules kept migrating into pms) and is the only shape that keeps the Teams-easy bar, because there is exactly one thing to run, back up, and move.

```
┌─────────────────────────────────────────────────────┐
│  Symbiotic OS instance (one per factory)            │
│                                                     │
│  Improvement board  ·  Module library  ·  Admin     │
│                                                     │
│  Module runtime                                     │
│    modules/<name>/<version>/   manifest, routes,    │
│    pages — live version mounted at /<name>,         │
│    staged version at /staging/<name>                │
│                                                     │
│  Build service (sandboxed)                          │
│    Claude via Agent SDK · write surface = staging   │
│    dirs only · cost logging on every run            │
│                                                     │
│  Postgres: module registry, versions, feedback,     │
│  proposals, build runs, audit events                │
└─────────────────────────────────────────────────────┘
```

The pieces:

- **Module registry and version store.** A module is a directory with a manifest, server routes, and pages. Every build produces a new immutable version. Deploy means repointing the live mount; rollback means pointing it back. Git still exists underneath as the version substrate, but no user ever sees it.
- **Staging is a first-class mount, not a second environment.** The staged version runs in the same instance at a staging path, which is what makes "view the demo" a link instead of a deployment.
- **The build service is the only place AI touches code.** It runs the Agent SDK in a sandbox whose write surface is the staged module directory, with the principle files and the module's own knowledge file as context. It cannot write to live versions, the platform core, or the database schema outside its module. Cost is logged per run from day one (playbook lesson).
- **Boring, proven stack.** Node + Express + plain HTML pages + Postgres, the same decision matrix the playbook already settled. No frontend framework unless a real reason appears.
- **Portability by construction.** The whole instance is one container image plus a Postgres database. That is what makes local install, commercial cloud, and GovCloud the same product with a different host, and it keeps the defense story honest: air-gapped-friendly later means the only required external call is the model API, isolated behind one interface so it can be pointed at Claude in GovCloud or at a locally hosted model without touching modules.

What is deliberately deferred: multi-tenancy (one instance per factory is the model for a long time), marketplace/sharing of modules across factories (the cross-ecosystem conduit idea — real, but not v1), and any Epicor/ERP integration (read-only integrations come after the loop is proven, following the integrate-read-only pattern).

## 5. Roadmap

Gates, not dates, per the playbook. Rough effort in parentheses assuming nights-and-weekends pace alongside school.

### Phase 0 — Design docs (now)

This document, plus PRINCIPLES.md, GUARDRAILS.md, and the first module reference format written before any code. Batch the remaining consequential decisions (below, §6) and answer them in one sitting.
**Gate:** docs reviewed, decisions logged.

### Phase 1 — The loop, end to end, on one toy module (the thin slice) (≈3–5 weeks)

The simulated factory: a small fictional shop with plausible parts, orders, and a couple of weeks of seeded activity. One pre-built module (a simple line board). The full loop working: feedback widget on the module page → item on the board → AI proposal card → approve → build runs in the sandbox → staged demo link → deploy click → new version live → rollback click works. Single manager login, one AI provider, ugly is fine everywhere except the board.
**Gate:** a nontechnical person, unassisted, takes one feedback item from submission to deployed change and can explain what happened at each step. This gate is the whole product thesis in miniature, and it is also the demo.

### Phase 2 — Module creation flow (≈3–4 weeks)

The module library with 2–3 reference formats. Plain-language guided intake → generated design summary the manager confirms → Rev 1 built and deployed through the same loop. The simulated factory gains its second and third modules this way, which is itself the transferability rehearsal.
**Gate:** a new module goes from "selected from the library" to live without anyone opening a code editor.

### Phase 3 — Hardening the loop (≈3–4 weeks)

The parts that make it trustworthy rather than impressive: full audit trail of every AI action (agent_events pattern), per-run and monthly cost caps with a visible budget badge, build failure handling that produces a card comment instead of a stuck state, ambiguous feedback getting a clarifying question instead of a guess, version diff summaries in manager language ("adds a priority column to the pick queue"), automated smoke checks on staged versions before the demo link is offered, backup/restore of the whole instance.
**Gate:** an ambiguous, a conflicting, and a malformed feedback item all resolve without a developer touching anything.

### Phase 4 — Showability (≈2 weeks, overlaps 3)

The slice is the demo, so this phase is packaging, not building: a guided tour mode over the simulated factory, a 3-minute recorded loop walkthrough, and a one-pager. Fold into the Finn Operations showroom and materials. This is the "communicate and show what the idea is" deliverable, and it lands after Phase 1 makes it honest, not before.
**Gate:** the demo runs cold in front of a stranger and the loop lands without narration from you.

### Phase 5 — Pilot readiness and portability proof (≈4–6 weeks)

Deploy the same image three ways: hosted cloud, a local machine, and a second cloud region as a GovCloud stand-in. Multi-user auth matched to trust level (PIN for floor actions, real accounts for manager gates). Instance provisioning made repeatable. Then the named-pilot conversation: an LFM portfolio company, DYC, or (post-internship, clean-room boundaries respected) Langmuir. Decide the rename before pilot paperwork, since the pilot's contract, URL, and materials should carry the permanent name.
**Gate:** a fresh instance stands up for a new simulated customer in under an hour, and one real pilot conversation is scheduled with the working slice as the demo.

## 6. Decisions

Made:

| Decision | Call | Why |
|---|---|---|
| First build | Thin working slice | Doubles as demo and foundation; nothing throwaway |
| Module runtime | One runtime, managed modules | Teams-easy requires one thing to run; matches pms gravity |
| Brand | Under Finn Operations for now | Rename likely as it gets real; decide by Phase 5 |
| Environment | Simulated factory | Clean-room safe, demoable to anyone; backend and process are what is being proven |
| AI | Claude / Anthropic first | Known to work; provider isolated behind one interface |
| Stack | Node + Express + plain HTML + Postgres | Settled decision matrix; boring is a feature |
| IP posture | Clean-room build, no Langmuir code or data | Thesis decision 2026-05-05, NDA §8(a) |

To batch for Phase 0 (answer in one sitting, playbook-style):

1. Sandbox mechanics for the build service: container-per-build vs process isolation with a restricted filesystem. Affects local-install story.
2. Module code shape: what exactly a manifest guarantees the runtime (routes, pages, migrations?) and how module-local schema changes are applied and rolled back. The hardest technical problem in the product; deserves its own design doc in Phase 0.
3. Demo artifact on In Progress cards: live staged link only, or link plus auto-captured screenshots/short clip.
4. Where instances run commercially in v1: your Railway account behind the scenes (fastest), or a small orchestrator from the start.
5. Name shortlist and trademark check timing (before pilot paperwork).

## 7. Risks worth naming

- **The module-schema problem.** Letting AI evolve a module's data model safely, with rollback, is genuinely hard, and it is where "one runtime" could get strained. Mitigation: Phase 0 design doc, additive-only migrations at first, the Sheet-as-backend escape hatch the methodology already trusts.
- **AI output quality without a technical reviewer.** The manager gate reviews behavior (the demo), not code. Mitigation: smoke checks before demo links, guardrail files, capped blast radius (staging only, one module per build), and honesty that early deployments have you behind the curtain.
- **Time.** Full-time student until May 2027; the phases above are a school-year of nights and weekends. The thin slice is deliberately the highest-value stopping point: if everything pauses after Phase 1, you still hold the demo that communicates the product.
- **IP boundary.** The product must not contain Langmuir code, data, or branding. Patterns and methodology, per the thesis IP framing, are the transferable layer; keep the TLO conversation ahead of any commercial pilot.
- **Incumbent framing.** "AI builds your factory software" invites the Ignition/Tulip comparison. The positioning answer already exists in the Finn Ops docs: they sell toolkits that require knowing what to build; this sells the loop that turns floor friction into deployed software with the process knowledge the customer already has.

## 8. What to measure from day one

Loop cycle time (feedback submitted → deployed), proposals approved without adjustment vs adjusted vs declined (measures proposal quality), builds that pass demo review first try, AI cost per shipped change, rollbacks, and weekly feedback volume (the health metric of the whole flywheel: if the floor stops reporting friction, the loop is dying regardless of everything else).
