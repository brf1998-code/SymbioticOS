# Module contract

What a module is to this platform, stated once so an agent can build one from
scratch. A module is a directory. The platform mounts it, applies its
migrations, serves its pages, and injects the feedback widget. The agent
writing a module touches nothing outside the directory it is launched in.

## Files

```
module.json          the manifest (below)
routes.js            module.exports = (ctx) => express.Router
migrations/001.sql   additive SQL, applied once per schema, in file order
pages/*.html         one file per screen, plain HTML and vanilla JS
tour.json            the guided walk through the screens (PRINCIPLES rule 8)
labels/<name>.zpl    label layouts, only when the module prints labels (below)
```

## module.json

```json
{
  "name": "tool-crib",                 the module's slug: given, never change it
  "title": "Tool Crib",                what people call it
  "description": "One or two sentences in plain words.",
  "entry": "routes.js",
  "pages": {
    "/":            { "file": "pages/board.html",   "label": "Crib board (lead view)" },
    "/me":          { "file": "pages/mine.html",    "label": "My tools (operator, on a phone)" },
    "/item/:id":    { "file": "pages/item.html",    "label": "One tool" }
  },
  "smoke": ["/api/items", "/me"],       paths the platform requests after every build; each must answer below 500
  "connections": {                      only what the design's Connections section names (below)
    "stock":  { "kind": "files", "label": "Stock count spreadsheet", "table": "items", "key": "sku",
                "columns": { "qty": ["Qty", "On hand"] } },
    "labels": { "kind": "printer", "label": "Bin labels", "templates": ["bin"] },
    "erp":    { "kind": "erp", "label": "Epicor (read only)",
                "queries": { "part": { "params": ["part_no"], "fields": ["part_no", "description", "on_hand"], "about": "one part and what the ERP says is on hand" } } }
  }
}
```

Routes in `pages` may carry `:params`. The same file can serve several routes.
Labels are what the feedback widget shows as the screen name, so write them
for a manager.

## routes.js

```js
module.exports = function makeRouter(ctx) {
  const { express, db, requireManager } = ctx;
  const router = express.Router();
  router.use(express.json());
  router.get("/api/items", async (req, res) => {
    const rows = (await db("SELECT * FROM items ORDER BY id")).rows;
    res.json(rows);
  });
  router.post("/api/items/:id/move", requireManager, async (req, res) => { ... });
  return router;
};
```

- `db(sql, params)` is a query function pinned to this module's own tables.
  Bare table names; the platform sets the schema. It returns `{ rows }`.
- `requireManager` is middleware for actions only a manager or lead may take.
  Anyone signed in may read; the floor role may do what the design gives the
  floor (moving a thing along its stages is usually a floor action).
- `ctx.peer(name)` is a read-only query function on another module's live
  tables, or null if that module is not live. Reading only.
- `ctx.ai.chat({ system, messages })` is a plain assistant call for a module
  that has a chat persona. Not needed for a first version.
- `ctx.manifest` is the parsed module.json.
- `ctx.connections.<name>` is each connection module.json declares, with a
  small fixed surface per kind (see Connections below). This is the only way
  a module reaches anything outside itself.
- No `require` of anything outside the directory. `express` comes from `ctx`.
  No network calls of any kind from routes.js: outside systems are reached
  only through services the platform lends on `ctx` (a first version usually
  has none; the design's Connections section says what a person has to set up).
- The platform reads every `.js` file before any of it runs and stops the
  build on: a `require` of anything but your own files (`require("./name.js")`);
  `process`, `global`, `globalThis`, `eval`, `new Function`, `import`, `fetch`;
  `res.sendFile`, `res.download`, `res.render`, `express.static`;
  `.constructor` or `__proto__`; a query that names `platform.`, another
  module's schema, `information_schema`, a `pg_` server function,
  `search_path`, `SET ROLE`, `COPY` or `GRANT`; and `CREATE`, `ALTER`, `DROP`
  or `TRUNCATE` at run time (tables are made in migrations, never in
  routes.js). A module is plain files: no `package.json`, no `node_modules`.

## migrations

Files `001.sql`, `002.sql` ... applied once each, in order, inside the
module's schema. Allowed statement shapes, nothing else:

```sql
CREATE TABLE [IF NOT EXISTS] name (...);
CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON table (...);
ALTER TABLE name ADD COLUMN [IF NOT EXISTS] col type ...;
INSERT INTO name (...) VALUES (...);          -- seed rows only
```

Rules the validator enforces: bare table names (no schema prefix, no quotes);
no DROP, DELETE, UPDATE, TRUNCATE, GRANT, functions, triggers, or DO blocks as
operations; each statement ends in `;` at the end of a line. Column names such
as `updated_at` or `deleted_at` and seed text are fine (the check is on whole
words with string literals ignored). Never edit a migration file that already
exists; add the next number.

Starting data from the intake (a spreadsheet of parts, beds, tools) goes in as
`INSERT` seed rows in `001.sql`, after the table that holds it.

## pages

Plain HTML, inline CSS and vanilla JS, no frameworks, no external scripts.
Every page computes its own address and calls its own API relative to it,
because the same files run at `/c/<company>/staging/m/<name>/` before they
go live and at `/c/<company>/m/<name>/` after:

```js
const base = location.pathname.match(/^.*?\/(?:staging\/)?m\/[^/]+/)[0];
const r = await fetch(base + "/api/items");
location.href = base + "/item/" + id;
```

Never hard-code `/m/<name>`. The platform injects the feedback button and the
company icon into every page; do not add them yourself. Follow the platform
STYLE.md (or the company's own STYLE.md when it has one) for colors, type and
spacing. One prominent action per role per screen; phone first for the floor,
large type for a wall screen. Use stable `id` attributes on the elements the
tour points at. Mark every element you add or visibly change with
`data-changed="v1"` on a first version.

Plain words on every visible string: the words in PLAIN-WORDS.md never appear
on a screen. The thing, its stages, the names the company uses.

## Connections (when the design calls for them)

The platform owns every connection; the module only uses it. Declare what the
module needs in module.json under `connections` and reach it only through
`ctx.connections.<name>`. The manager sets each one up once on the company's
connections page (`/c/<company>/connections`) and tests it there; module
pages never ask for settings, printers or files, and a module still works
before a connection is set up (say "not connected yet" where it matters,
`await ctx.connections.<name>.status()` tells you). Kinds:

- `files`: a spreadsheet the company keeps, loaded by the platform into ONE
  of the module's own tables. Declare `table` (the module table), `key` (the
  column, or list of columns, that identifies a row, so a reload replaces
  rather than duplicates) and optionally `columns` (other header names the
  spreadsheet may use for a column). The platform parses the file, matches
  the headers to the table's columns, previews, then loads in one
  transaction. The module just reads its table. Surface: `status()` returns
  `{ connected, table, last_loaded_at, rows, filename }`.
- `printer`: labels on a Zebra printer. Keep each label as `labels/<name>.zpl`
  (ZPL with `{{field}}` placeholders; the platform fills them and strips ZPL
  control characters from the data) and list the names in `templates`. In a
  route, `await ctx.connections.<name>.print(req, "traveler", { job: "S1-01" })`
  renders the label and queues it for the device the request came from; the
  platform's own helper on that device sends it to the printer chosen there.
  Pass the request so the label goes to the screen that asked. It returns
  `{ job_id, queued, device }`; tell the person the label is on its way, and
  when `device` is false, that this browser is not paired with a printer yet.
  `preview(name, data)` returns `{ zpl, png }` (png null when the renderer is
  not reachable) for a "what the label looks like" image. `status()` returns
  `{ connected, printers, last_printed_at, error }`. Never write `^XA` to a
  socket, a file or a fetch: module code cannot reach a printer, only this.
- `erp`: the company's ERP, MES or scheduling system, read only, through a
  short list of named lookups. Declare each query the module needs: its
  `params` (what it is looked up by), the `fields` the module expects back,
  and `about` in plain words. Never write where the system is or any login
  in the module: the platform's administrator enters the address, the path
  behind each query and the read-only login on the platform, and the
  manager tests it there. In a route,
  `const r = await ctx.connections.erp.query("part", { part_no: "A-100" })`
  returns `{ rows, fetched_at, fresh, from_cache }`; each row has exactly the
  declared fields (null where the system had nothing). Answers are cached a
  few minutes; when the system is down the last good rows come back with
  `fresh: false`, so show them with "as of <time>". Until it is set up,
  `query()` throws with a plain reason: catch it and show "not connected
  yet". Nothing is ever written back; a module that needs to write to the
  ERP is out of scope of a first version.

A barcode or QR scanner in keyboard mode needs nothing to connect: give the
page a scan field that keeps focus, treats Enter as the end of a scan, and
looks the code up. Say in the tour what to scan and where labels print.

## tour.json

```json
{
  "title": "Tool Crib in two minutes",
  "intro": "One paragraph on what the screens are for.",
  "steps": [
    { "path": "/", "target": "#board", "title": "What the lead sees", "body": "..." },
    { "path": "/me", "target": "#mine", "title": "Your tools", "body": "..." },
    { "path": "/me", "target": "#sos-fb-btn", "title": "The feedback button", "body": "Something in the way? Say it here, from the screen where it happened." }
  ]
}
```

`path` is a page route from module.json, `target` a CSS selector on that
page. End at the feedback button (`#sos-fb-btn`, injected by the platform).

## What a first version is

Deliberately small: the thing, its stages, one screen per role with its
single prominent action, the rules that must hold, the numbers on the board,
the starting data. What the design lists under "What Rev 1 leaves out" stays
out; it arrives later through floor feedback. Working and small beats
complete and broken.
