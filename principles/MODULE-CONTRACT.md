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
  "smoke": ["/api/items", "/me"]        paths the platform requests after every build; each must answer below 500
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
- No `require` of anything outside the directory. `express` comes from `ctx`.
  No network calls of any kind from routes.js: outside systems are reached
  only through services the platform lends on `ctx` (a first version usually
  has none; the design's Connections section says what a person has to set up).

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

## Scanners and labels (when the design calls for them)

A barcode or QR scanner in keyboard mode needs nothing to connect: give the
page a scan field that keeps focus, treats Enter as the end of a scan, and
looks the code up. A label is a plain HTML block sized for the label, printed
from the page with `window.print()` and a print stylesheet; the platform's
printing helper comes later. Say in the tour what to scan and where to print.

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
