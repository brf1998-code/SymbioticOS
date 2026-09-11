// Platform database layer.
// One Postgres database per factory instance. The platform's own tables live in
// schema "platform". Each module's tables live in schema "mod_<name>" (live),
// "stg_<name>" (staging clone used by builds), and "snap_<name>_<ts>" (rollback
// snapshots). Module source files also live in the database
// (platform.module_versions.files) so a redeploy of the platform container never
// loses a version the agent built.
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
function scopedDb(schema) {
  return async function scopedQuery(text, params) {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schema}, public`);
      return await client.query(text, params);
    } finally {
      await client.query("SET search_path TO public");
      client.release();
    }
  };
}

const PLATFORM_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.modules (
  name          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  live_version  INTEGER,
  staged_version INTEGER,
  repo_hash     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE platform.modules ADD COLUMN IF NOT EXISTS repo_hash TEXT;

CREATE TABLE IF NOT EXISTS platform.module_versions (
  id         SERIAL PRIMARY KEY,
  module     TEXT NOT NULL REFERENCES platform.modules(name),
  version    INTEGER NOT NULL,
  source     TEXT NOT NULL DEFAULT 'repo',        -- 'repo' | 'build'
  notes      TEXT,
  files      JSONB,                                -- { "pages/board.html": "<html>..." }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module, version)
);
ALTER TABLE platform.module_versions ADD COLUMN IF NOT EXISTS files JSONB;

CREATE TABLE IF NOT EXISTS platform.feedback (
  id         SERIAL PRIMARY KEY,
  module     TEXT,
  page       TEXT,
  message    TEXT NOT NULL,
  name       TEXT,
  status     TEXT NOT NULL DEFAULT 'new',          -- new|reviewing|in_progress|done|declined
  recurrence INTEGER NOT NULL DEFAULT 1,
  outcome    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.proposals (
  id           SERIAL PRIMARY KEY,
  feedback_id  INTEGER NOT NULL REFERENCES platform.feedback(id),
  body         TEXT NOT NULL,
  class        TEXT NOT NULL,                      -- 'ui' | 'functionality'
  rationale    TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',      -- draft|approved|declined
  manager_note TEXT,
  cost_usd     NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE platform.proposals ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS platform.build_runs (
  id            SERIAL PRIMARY KEY,
  proposal_id   INTEGER NOT NULL REFERENCES platform.proposals(id),
  module        TEXT NOT NULL,
  from_version  INTEGER,
  to_version    INTEGER,
  lane          TEXT NOT NULL,                     -- 'ui' | 'functionality'
  step          TEXT NOT NULL,                     -- lane-specific step name
  status        TEXT NOT NULL DEFAULT 'running',   -- queued|running|waiting|failed|deployed|rolled_back
  requirement   TEXT,                              -- agent-restated requirement (functionality lane)
  evidence      JSONB NOT NULL DEFAULT '{}'::jsonb, -- diff summary, test results, cross-check verdict
  log           JSONB NOT NULL DEFAULT '[]'::jsonb,
  cost_usd      NUMERIC(10,4) NOT NULL DEFAULT 0,
  proposal_ids  INTEGER[],                        -- batch: every proposal built in this run
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE platform.build_runs ADD COLUMN IF NOT EXISTS proposal_ids INTEGER[];

CREATE TABLE IF NOT EXISTS platform.events (
  id         SERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,
  ref        TEXT,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.schema_snapshots (
  id         SERIAL PRIMARY KEY,
  module     TEXT NOT NULL,
  version    INTEGER,
  file       TEXT NOT NULL,                        -- snapshot schema name (kept as "file" for history)
  taken_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function initPlatformSchema() {
  await q(PLATFORM_SCHEMA);
}

async function logEvent(kind, ref, detail) {
  await q("INSERT INTO platform.events (kind, ref, detail) VALUES ($1,$2,$3)", [
    kind, ref == null ? null : String(ref), JSON.stringify(detail || {}),
  ]);
}

module.exports = { pool, q, scopedDb, initPlatformSchema, logEvent, DATABASE_URL };
