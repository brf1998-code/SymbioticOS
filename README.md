# Symbiotic OS — factory instance

One application per factory. It hosts the improvement board, every module (live
and staged versions), and the agent build service that turns approved floor
feedback into deployed changes. First module: the Paper Airplane Line demo.

`CLAUDE.md` is the working guide (revision paths, deploy procedure, rules).
`docs/DEMO-RUNBOOK.md` is the facilitator script. `docs/ROADMAP.md` is the vision.

## Run locally

Needs Node 20+, Postgres, and (for the AI parts) an Anthropic API key.

```bash
createdb sos                      # or set DATABASE_URL
npm install
SOS_FAKE_AGENT=1 npm start        # whole loop, zero API cost
# or: ANTHROPIC_API_KEY=sk-... npm start
```

Open http://localhost:3000 for the improvement board and
http://localhost:3000/m/paperline/ for the line. Modules under `modules/` are
imported into the database on first boot; no seed step.

With no `SOS_FLOOR_PASSWORD` / `SOS_MANAGER_PASSWORD` set, every request is a
manager (local dev). Set both for anything reachable from the internet.

## Env vars

| var | purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (default `postgres://sos:sos@localhost:5432/sos`) |
| `ANTHROPIC_API_KEY` | enables real proposals and builds |
| `SOS_MODEL` | default `claude-sonnet-4-5` |
| `SOS_FLOOR_PASSWORD`, `SOS_MANAGER_PASSWORD` | two-role access |
| `SESSION_SECRET` | signs the session cookie |
| `SOS_MAX_RUN_USD` | per build run cap (default 1.50); the run is aborted past it |
| `SOS_MONTHLY_CAP_USD` | no new proposals or runs past this (default 25) |
| `SOS_FAKE_AGENT` | `1` = scripted agent, no API calls |
| `PORT` | default 3000 |

## The loop (what to demo)

1. On a module page, hit "Something in the way?" and report friction.
2. On the improvement board the card appears under Feedback. Manager clicks **Review with AI**.
3. The proposal card shows the change and its class (UI or functionality). Approve, adjust, or decline.
4. UI lane: agent builds into a new draft version, visual check runs, staged demo link appears.
   Functionality lane: the agent first restates the requirement and waits for confirmation,
   then builds, then an independent cross-check agent reviews the diff, then smoke tests run on staging.
5. Deploy gate: view the staged demo, then **Deploy to floor**. Rollback is one click on the done card.

Feedback filed from the board itself goes to the Platform column and is shipped
through the repo, not the in-app agent.

## Architecture map

- `server.js` — boot, auth, static, route mounting
- `src/auth.js` — floor/manager passwords, signed cookie
- `src/db.js` — platform schema (modules, versions with files, feedback, proposals, build_runs, events, snapshots)
- `src/registry.js` — module versions in the DB, materialized to disk; repo import; live/staged mounts; deploy/rollback
- `src/migrate.js` — additive-only migration validator, staging clone, in-database snapshots and restore
- `src/proposals.js` — feedback -> proposal + UI/functionality classification
- `src/pipeline.js` — the two lanes as a state machine over build_runs
- `src/agent.js` — Claude Agent SDK runner (cwd = draft version dir, file tools only), cost caps, fake mode
- `principles/` — PRINCIPLES, GUARDRAILS, STYLE + per-module reference formats (fed to every agent run)
- `modules/<name>/` — seed source for each module (manifest, routes, pages, migrations)

## Security posture

Two shared passwords and a signed cookie. Single tenant. Agents write only to a
draft version directory and never run shell commands. Migrations are validated
additive-only. Snapshots before every deploy, rollback restores schema and data.
Real accounts, per-module DB roles, and multi-tenant provisioning are the next
layers.
