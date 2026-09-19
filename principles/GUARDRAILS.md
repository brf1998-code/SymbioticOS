# Agent guardrails

Hard limits on what a build agent may do. The platform enforces most of these
structurally; treat the rest as absolute instructions.

- Your write surface is the draft version directory you are launched in. Nothing else exists.
- Never modify the platform, another module, or any file outside your working directory.
- UI-class changes: touch `pages/` and presentation only. Do not modify `routes.js` logic, `module.json`'s smoke list, or migrations. The platform compares the files after the build: in a UI-class change only `pages/`, `tour.json`, `reference.md` and the labels, title and description in `module.json` may differ from the live version, and the build is stopped otherwise. If the change cannot work without touching `routes.js`, leave it untouched and say so in your summary; the manager will approve it again as a functionality change.
- Functionality-class changes: implement exactly the confirmed requirement. Nothing extra.
- Data model changes go in a NEW `migrations/NNN.sql` file. Additive only: `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`, `CREATE INDEX`, `INSERT` seed rows. Bare table names, no schema prefixes, no quoted identifiers. Never edit an existing migration.
- Never use DROP, DELETE, UPDATE, TRUNCATE, GRANT, or any schema/role/function statement in a migration. The platform rejects them. (Column names like `updated_at` and words inside seed text are fine; the check is on operations.)
- Keep the stack boring: plain HTML, vanilla JS, no frameworks, no new dependencies.
- Module routes receive `ctx.db` (a query function pinned to this module's tables) and `ctx.requireManager` (middleware for manager-only actions). Do not import anything from outside the directory except `express` via `ctx.express`.
- The platform reads every `.js` file in the module before any of it runs, and stops the build if server code reaches past what `ctx` lends it. In `routes.js` and any helper file: `require` only your own files, written as `require("./name.js")`; never `process`, `global`, `globalThis`, `eval`, `new Function`, `import`, `fetch` or any other network call; never `res.sendFile`, `res.download`, `res.render` or `express.static` (the platform serves the pages listed in `module.json`); never `.constructor` or `__proto__`. No `package.json`, no `node_modules`.
- Queries in `routes.js` use bare table names from this module's own migrations. Never `platform.`, another module's schema (read a sibling module with `ctx.peer(name)`), `information_schema`, `pg_` server functions, `search_path`, `SET ROLE`, `COPY` or `GRANT`. Never `CREATE`, `ALTER`, `DROP` or `TRUNCATE` at run time: a change to what the tool keeps is a new migration file. `SELECT`, `INSERT`, `UPDATE` and `DELETE` on your own tables are the normal work of a route.
- Pages call their own APIs with paths relative to the page (see how the existing pages compute `base`), never hard-coded `/m/<name>` paths, because the same files run at `/staging/m/<name>` before they go live.
- If the requirement is ambiguous or seems to require more than allowed here, stop and say so in your summary instead of guessing.
