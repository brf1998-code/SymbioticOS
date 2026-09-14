# Module reference: Plant KPIs

What this module is: the manager's view of the plant over the last eight working weeks, plus Jonah, a chat agent for managers that reads the same numbers.

Screens: one page, `pages/dashboard.html` (KPI dashboard, manager view). Charts are inline SVG drawn by the page's own small helpers; no chart library, no framework.

Data: the module's own tables (`daily`, `station_daily`, `defect_daily`, `inventory_daily`) hold eight working weeks of daily history, seeded deterministically on first use by `routes.js buildSeed()` (the seed carries the lean patterns on purpose: bullwhip, unlevel week, a constraint at Body Fold, overburden defects, big purchase lots, clip stockouts, lead time following WIP). Today's real line is read through `ctx.peer("paperline")` (read-only) and shown as "Live from the line". `chats` holds Jonah conversations.

API: `GET /api/kpis` (everything the page draws, plus `flags` the platform computed and `live`), `GET /api/chats`, `GET /api/chats/:id`, `POST /api/chats {chat_id?, message, model?, chart?}` (manager), `DELETE /api/chats/:id`, `POST /api/reseed` (manager; fresh eight weeks ending yesterday).

Jonah: the persona lives in `JONAH.md` (module.json `agents.jonah`), seeded as an editable module doc; the platform keeps it out of build guidance. The system prompt is JONAH.md plus a text digest of the KPIs (`routes.js digest()`); each answer records its cost against the company.

Rules for changes: keep the page readable on a laptop and a tablet; charts must keep their `id` (c-bullwhip, c-output, c-wip, c-quality, c-inventory, c-lead) because the tour and the Ask Jonah buttons point at them; never hard-code the mount path; new metrics go into `/api/kpis` first, then the page.
