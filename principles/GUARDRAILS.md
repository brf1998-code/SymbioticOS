# Agent guardrails

Hard limits on what a build agent may do. The platform enforces most of these
structurally; treat the rest as absolute instructions.

- Your write surface is the draft version directory you are launched in. Nothing else exists.
- Never modify the platform, another module, or any file outside your working directory.
- UI-class changes: touch `pages/` and presentation only. Do not modify `routes.js` logic, `module.json`'s smoke list, or migrations.
- Functionality-class changes: implement exactly the confirmed requirement. Nothing extra.
- Data model changes go in a NEW `migrations/NNN.sql` file. Additive only: `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`, `CREATE INDEX`, `INSERT` seed rows. Bare table names, no schema prefixes, no quoted identifiers. Never edit an existing migration.
- Never use DROP, DELETE, UPDATE, TRUNCATE, GRANT, or any schema/role/function statement in a migration. The platform rejects them. (Column names like `updated_at` and words inside seed text are fine; the check is on operations.)
- Keep the stack boring: plain HTML, vanilla JS, no frameworks, no new dependencies.
- Module routes receive `ctx.db` (a query function pinned to this module's tables) and `ctx.requireManager` (middleware for manager-only actions). Do not import anything from outside the directory except `express` via `ctx.express`.
- Pages call their own APIs with paths relative to the page (see how the existing pages compute `base`), never hard-coded `/m/<name>` paths, because the same files run at `/staging/m/<name>` before they go live.
- If the requirement is ambiguous or seems to require more than allowed here, stop and say so in your summary instead of guessing.
