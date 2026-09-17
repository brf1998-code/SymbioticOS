// Platform database layer.
// One Postgres database per instance. The platform's own tables live in schema
// "platform". Each company's modules get their own schemas:
//   mod_<company>_<module>   live tables
//   stg_<company>_<module>   staging clone used by builds
//   snap_<company>_<module>_<ts>   rollback snapshots
// Module source files also live in the database (platform.module_versions.files)
// so a redeploy of the platform container never loses a version the agent built.
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "postgres://sos:sos@localhost:5432/sos";
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /railway|rlwy\.net|sslmode=require/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
});

async function q(text, params) {
  return pool.query(text, params);
}

// A query function pinned to a module schema. Handed to module routers as ctx.db
// so module code can only conveniently see its own tables. (Hard isolation comes
// later with per-module DB roles; the MVP relies on search_path + review.)
// readOnly: every statement runs inside a READ ONLY transaction, for a module
// reading a sibling module's tables (ctx.peer).
function scopedDb(schema, { readOnly = false } = {}) {
  return async function scopedQuery(text, params) {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schema}, public`);
      if (!readOnly) return await client.query(text, params);
      await client.query("BEGIN READ ONLY");
      try { const r = await client.query(text, params); await client.query("COMMIT"); return r; }
      catch (e) { await client.query("ROLLBACK"); throw e; }
    } finally {
      await client.query("SET search_path TO public");
      client.release();
    }
  };
}

const PLATFORM_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.companies (
  slug          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  model_propose TEXT,
  model_build   TEXT,
  model_review  TEXT,
  brand         JSONB,                             -- { url, status, colors, font, icon (data url), cost_usd, built_at }
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.batches (
  id         SERIAL PRIMARY KEY,
  company    TEXT NOT NULL,
  module     TEXT NOT NULL,
  run_id     INTEGER,                              -- set when the batch was built; NULL = still open
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform.modules (
  company       TEXT NOT NULL DEFAULT 'demo',
  name          TEXT NOT NULL,
  title         TEXT NOT NULL,
  live_version  INTEGER,
  staged_version INTEGER,
  repo_hash     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company, name)
);

CREATE TABLE IF NOT EXISTS platform.module_versions (
  id         SERIAL PRIMARY KEY,
  company    TEXT NOT NULL DEFAULT 'demo',
  module     TEXT NOT NULL,
  version    INTEGER NOT NULL,
  source     TEXT NOT NULL DEFAULT 'repo',        -- 'repo' | 'build'
  notes      TEXT,
  files      JSONB,                                -- { "pages/board.html": "<html>..." }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company, module, version)
);

CREATE TABLE IF NOT EXISTS platform.feedback (
  id         SERIAL PRIMARY KEY,
  company    TEXT NOT NULL DEFAULT 'demo',
  module     TEXT,
  page       TEXT,
  screen     TEXT,                                 -- human label of the screen it came from
  target_file TEXT,                                -- module file behind that screen
  message    TEXT NOT NULL,
  name       TEXT,
  status     TEXT NOT NULL DEFAULT 'new',          -- new|reviewing|in_progress|done|declined
  recurrence INTEGER NOT NULL DEFAULT 1,
  batch_id   INTEGER,                              -- open batch this item sits in (platform.batches)
  outcome    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.proposals (
  id           SERIAL PRIMARY KEY,
  feedback_id  INTEGER NOT NULL REFERENCES platform.feedback(id),
  body         TEXT NOT NULL,
  class        TEXT NOT NULL,                      -- 'ui' | 'functionality'
  target_file  TEXT,                               -- the file the change lands in
  rationale    TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',      -- draft|approved|declined
  manager_note TEXT,
  model        TEXT,
  cost_usd     NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.build_runs (
  id            SERIAL PRIMARY KEY,
  proposal_id   INTEGER NOT NULL REFERENCES platform.proposals(id),
  proposal_ids  INTEGER[],                         -- batch: every proposal built in this run
  company       TEXT NOT NULL DEFAULT 'demo',
  module        TEXT NOT NULL,
  from_version  INTEGER,
  to_version    INTEGER,
  lane          TEXT NOT NULL,                     -- 'ui' | 'functionality'
  step          TEXT NOT NULL,                     -- lane-specific step name
  status        TEXT NOT NULL DEFAULT 'running',   -- queued|running|waiting|failed|cancelled|deployed|rolled_back
  model         TEXT,                              -- build model used for this run
  requirement   TEXT,                              -- agent-restated requirement (functionality lane)
  evidence      JSONB NOT NULL DEFAULT '{}'::jsonb, -- diff summary, test results, cross-check verdict, docs used
  log           JSONB NOT NULL DEFAULT '[]'::jsonb,
  cost_usd      NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.agent_docs (
  id         SERIAL PRIMARY KEY,
  company    TEXT NOT NULL,
  module     TEXT,                                 -- NULL = company-wide doc
  name       TEXT NOT NULL,                        -- e.g. COMPANY.md, reference.md
  content    TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'user',         -- 'repo' seeded | 'user' edited in-app
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company, module, name)
);

CREATE TABLE IF NOT EXISTS platform.reviews (
  id           SERIAL PRIMARY KEY,
  company      TEXT NOT NULL,
  module       TEXT NOT NULL,
  model        TEXT NOT NULL,
  version      INTEGER,                            -- live version reviewed
  status       TEXT NOT NULL DEFAULT 'running',    -- running|done|failed
  summary      TEXT,
  item_count   INTEGER NOT NULL DEFAULT 0,
  cost_usd     NUMERIC(10,4) NOT NULL DEFAULT 0,
  requested_by TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS platform.diagrams (
  id          SERIAL PRIMARY KEY,
  company     TEXT NOT NULL,
  module      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  model       TEXT,
  status      TEXT NOT NULL DEFAULT 'running',     -- running|done|failed
  content     JSONB,                               -- { overview, data_flows:[...], workflows:[...] }
  cost_usd    NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS platform.ai_usage (
  id         SERIAL PRIMARY KEY,
  company    TEXT NOT NULL,
  module     TEXT,
  kind       TEXT NOT NULL,                        -- 'chat' | ...
  model      TEXT,
  cost_usd   NUMERIC(10,4) NOT NULL DEFAULT 0,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.events (
  id         SERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,
  ref        TEXT,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.schema_snapshots (
  id         SERIAL PRIMARY KEY,
  company    TEXT NOT NULL DEFAULT 'demo',
  module     TEXT NOT NULL,
  version    INTEGER,
  file       TEXT NOT NULL,                        -- snapshot schema name (kept as "file" for history)
  taken_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Module creation (docs/MODULE-CREATION.md): one row per intake, behind a
-- feedback card of kind 'module_request'.
CREATE TABLE IF NOT EXISTS platform.module_intakes (
  id          SERIAL PRIMARY KEY,
  company     TEXT NOT NULL,
  feedback_id INTEGER,
  started_by  TEXT,
  status      TEXT NOT NULL DEFAULT 'answering',   -- answering|thinking|design|confirmed|building|paused|done|abandoned|failed
  name        TEXT,
  slug        TEXT,
  answers     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- question id -> value (shape per kind, src/intake-questions.js)
  rounds      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- generated rounds as issued: [{round, questions, enough, why, model, cost_usd}]
  design      JSONB,                               -- the design summary once written (bluf, items, reference_md, ...)
  model       TEXT,
  cost_usd    NUMERIC(10,4) NOT NULL DEFAULT 0,
  error       TEXT,
  run_ids     INTEGER[],
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Checks log (docs/CHECKS-CAMPAIGN.md): the manager's verdict on each
-- automated verdict, the labeled set the cross-check is tuned against.
CREATE TABLE IF NOT EXISTS platform.check_labels (
  run_id     INTEGER PRIMARY KEY,
  label      TEXT NOT NULL,                        -- 'right' | 'wrong' | 'unsure'
  note       TEXT,
  labeled_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.attachments (
  id          SERIAL PRIMARY KEY,
  company     TEXT NOT NULL,
  intake_id   INTEGER,
  question_id TEXT,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  bytes       BYTEA NOT NULL,
  parsed      JSONB,                               -- spreadsheets: { headers, rows (first 200), row_count }
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Columns added after the first release (idempotent).
const UPGRADES = [
  "ALTER TABLE platform.modules ADD COLUMN IF NOT EXISTS company TEXT NOT NULL DEFAULT 'demo'",
  "ALTER TABLE platform.module_versions ADD COLUMN IF NOT EXISTS company TEXT NOT NULL DEFAULT 'demo'",
  "ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS company TEXT NOT NULL DEFAULT 'demo'",
  "ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS screen TEXT",
  "ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS target_file TEXT",
  "ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS review_id INTEGER",
  "ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS batch_id INTEGER",
  "ALTER TABLE platform.companies ADD COLUMN IF NOT EXISTS brand JSONB",
  "ALTER TABLE platform.proposals ADD COLUMN IF NOT EXISTS target_file TEXT",
  "ALTER TABLE platform.proposals ADD COLUMN IF NOT EXISTS model TEXT",
  "ALTER TABLE platform.proposals ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0",
  "ALTER TABLE platform.build_runs ADD COLUMN IF NOT EXISTS proposal_ids INTEGER[]",
  "ALTER TABLE platform.build_runs ADD COLUMN IF NOT EXISTS company TEXT NOT NULL DEFAULT 'demo'",
  "ALTER TABLE platform.build_runs ADD COLUMN IF NOT EXISTS model TEXT",
  "ALTER TABLE platform.schema_snapshots ADD COLUMN IF NOT EXISTS company TEXT NOT NULL DEFAULT 'demo'",
  "ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'feedback'",   // 'feedback' | 'module_request'
  "ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS intake_id INTEGER",
  "INSERT INTO platform.companies (slug, name) VALUES ('demo', 'Demo Company') ON CONFLICT DO NOTHING",
];

async function initPlatformSchema() {
  await q(PLATFORM_SCHEMA);
  for (const u of UPGRADES) await q(u);
  await upgradeSingleTenant();
  await dedupeCompanyDocs();
}

// UNIQUE (company, module, name) never fired for company-wide docs because
// module is NULL there, so every boot seeded another COMPANY.md and every save
// of a company-wide doc added a row. Keep one per (company, name): the newest
// user-edited copy if there is one, else the oldest; then a partial unique
// index stops it happening again.
async function dedupeCompanyDocs() {
  const dups = (await q(`
    SELECT company, name, array_agg(id ORDER BY (source='user') DESC, updated_at DESC, id ASC) AS ids
      FROM platform.agent_docs WHERE module IS NULL GROUP BY company, name HAVING count(*) > 1`)).rows;
  for (const d of dups) {
    await q("DELETE FROM platform.agent_docs WHERE id = ANY($1::int[])", [d.ids.slice(1)]);
    console.log(`[db] removed ${d.ids.length - 1} duplicate ${d.name} for ${d.company}`);
  }
  await q("CREATE UNIQUE INDEX IF NOT EXISTS agent_docs_company_wide ON platform.agent_docs (company, name) WHERE module IS NULL");
  // the brand step used to write BRAND.md next to the platform STYLE.md and the
  // agent kept the platform one; the brand file is now the company's STYLE.md
  const moved = await q(`UPDATE platform.agent_docs b SET name='STYLE.md', updated_at=now()
     WHERE b.module IS NULL AND b.name='BRAND.md'
       AND NOT EXISTS (SELECT 1 FROM platform.agent_docs s WHERE s.company=b.company AND s.module IS NULL AND s.name='STYLE.md')`);
  if (moved.rowCount) console.log(`[db] renamed ${moved.rowCount} BRAND.md to STYLE.md`);
  await q("DELETE FROM platform.agent_docs WHERE module IS NULL AND name='BRAND.md'");
}

// Insert or update one agent doc. seedOnly: leave an existing doc alone.
async function upsertDoc(company, mod, name, content, source, seedOnly) {
  const cur = (await q("SELECT id FROM platform.agent_docs WHERE company=$1 AND module IS NOT DISTINCT FROM $2 AND name=$3", [company, mod || null, name])).rows[0];
  if (cur) {
    if (seedOnly) return cur;
    return (await q("UPDATE platform.agent_docs SET content=$2, source=$3, updated_at=now() WHERE id=$1 RETURNING *", [cur.id, content, source])).rows[0];
  }
  return (await q("INSERT INTO platform.agent_docs (company, module, name, content, source) VALUES ($1,$2,$3,$4,$5) RETURNING *", [company, mod || null, name, content, source])).rows[0];
}

// First boot after the multi-company change: the original release kept
// modules.name as the primary key and module schemas as mod_<module>. Move
// everything under the 'demo' company and rename the schemas.
async function upgradeSingleTenant() {
  const pk = (await q(`SELECT string_agg(a.attname, ',' ORDER BY a.attnum) AS cols
     FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'platform.modules'::regclass AND i.indisprimary`)).rows[0];
  if (pk && pk.cols === "name") {
    await q("ALTER TABLE platform.module_versions DROP CONSTRAINT IF EXISTS module_versions_module_fkey");
    await q("ALTER TABLE platform.modules DROP CONSTRAINT modules_pkey");
    await q("ALTER TABLE platform.modules ADD PRIMARY KEY (company, name)");
    await q("ALTER TABLE platform.module_versions DROP CONSTRAINT IF EXISTS module_versions_module_version_key");
    await q("ALTER TABLE platform.module_versions ADD CONSTRAINT module_versions_company_module_version_key UNIQUE (company, module, version)");
  }
  const schemas = (await q(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'mod\\_%' OR nspname LIKE 'stg\\_%' OR nspname LIKE 'snap\\_%'`)).rows.map((r) => r.nspname);
  const mods = (await q("SELECT name FROM platform.modules")).rows.map((r) => r.name);
  for (const mod of mods) {
    for (const prefix of ["mod", "stg"]) {
      const old = `${prefix}_${mod}`;
      if (schemas.includes(old) && !schemas.includes(`${prefix}_demo_${mod}`)) {
        await q(`ALTER SCHEMA ${old} RENAME TO ${prefix}_demo_${mod}`);
        console.log(`[db] renamed schema ${old} -> ${prefix}_demo_${mod}`);
      }
    }
    for (const s of schemas) {
      if (s.startsWith(`snap_${mod}_`)) {
        const renamed = s.replace(`snap_${mod}_`, `snap_demo_${mod}_`);
        await q(`ALTER SCHEMA ${s} RENAME TO ${renamed}`);
        await q("UPDATE platform.schema_snapshots SET file=$2 WHERE file=$1", [s, renamed]);
      }
    }
  }
}

async function logEvent(kind, ref, detail) {
  await q("INSERT INTO platform.events (kind, ref, detail) VALUES ($1,$2,$3)", [
    kind, ref == null ? null : String(ref), JSON.stringify(detail || {}),
  ]);
}

async function getSetting(key, def) {
  const r = (await q("SELECT value FROM platform.settings WHERE key=$1", [key])).rows[0];
  return r ? r.value : def;
}
async function setSetting(key, value) {
  await q("INSERT INTO platform.settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, String(value)]);
}

module.exports = { pool, q, scopedDb, initPlatformSchema, logEvent, getSetting, setSetting, upsertDoc, DATABASE_URL };
