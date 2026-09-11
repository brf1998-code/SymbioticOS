// Platform-mediated module migrations + in-database snapshots.
//
// Modules own real SQL tables, but module code (and build agents) never run DDL
// directly. A module version ships migration files (migrations/NNN.sql). The
// platform:
//   1. VALIDATES each file: additive-only statements, inside the module's own
//      schema, no destructive operations.
//   2. Applies new migrations to the STAGING schema first (stg_<name>), which is
//      a structural+data clone of the live schema made when a build starts.
//   3. On deploy: snapshots the live schema (a clone into snap_<name>_<ts>),
//      then applies the same migrations to the live schema (mod_<name>).
// Rollback restores the snapshot into the live schema in place (data + column
// set + indexes) and repoints the live version. No pg_dump, no disk: the
// database is the only thing that has to persist across a container redeploy.
const fs = require("fs");
const path = require("path");
const { q, pool, logEvent } = require("./db");

const KEEP_SNAPSHOTS = Number(process.env.SOS_KEEP_SNAPSHOTS || 10);

function liveSchema(company, mod) { return `mod_${company}_${mod}`; }
function stagingSchema(company, mod) { return `stg_${company}_${mod}`; }

// ---- validation -----------------------------------------------------------
// Allowed statement shapes (whitespace-insensitive, case-insensitive):
//   CREATE TABLE [IF NOT EXISTS] <ident> ...
//   CREATE [UNIQUE] INDEX [IF NOT EXISTS] <ident> ON <ident> ...
//   ALTER TABLE <ident> ADD COLUMN [IF NOT EXISTS] ...
//   INSERT INTO <ident> ...            (seed data only)
// Anything else is rejected. Table identifiers must be bare names (no schema
// qualification, no quotes) so the platform controls the schema via search_path.
const FORBIDDEN = /\b(DROP|TRUNCATE|DELETE|UPDATE|GRANT|REVOKE|ALTER\s+SCHEMA|CREATE\s+SCHEMA|SECURITY|FUNCTION|TRIGGER|RULE|EXTENSION|COPY|VACUUM|REINDEX|CLUSTER|OWNER|SET\s+ROLE|RESET|DO\b)/i;
const BARE_IDENT = "[a-z_][a-z0-9_]*";
const ALLOWED = [
  new RegExp(`^CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${BARE_IDENT}\\s*\\(`, "i"),
  new RegExp(`^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${BARE_IDENT}\\s+ON\\s+${BARE_IDENT}\\b`, "i"),
  new RegExp(`^ALTER\\s+TABLE\\s+${BARE_IDENT}\\s+ADD\\s+COLUMN\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${BARE_IDENT}\\b`, "i"),
  new RegExp(`^INSERT\\s+INTO\\s+${BARE_IDENT}\\b`, "i"),
];

function splitStatements(sql) {
  // naive split on ";" at line ends. Migration files are agent/platform
  // authored, so we keep the dialect simple on purpose (no functions, no $$).
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/--[^\n]*/g, "").trim())
    .filter(Boolean);
}

function validateMigrationSql(sql) {
  const errors = [];
  const statements = splitStatements(sql);
  if (!statements.length) errors.push("migration file contains no statements");
  for (const st of statements) {
    if (FORBIDDEN.test(st)) {
      errors.push(`forbidden operation in: ${st.slice(0, 80)}`);
      continue;
    }
    if (/\bpublic\s*\.|\bplatform\s*\.|\bmod_|\bstg_|\bsnap_|"/i.test(st)) {
      errors.push(`schema-qualified or quoted identifier not allowed: ${st.slice(0, 80)}`);
      continue;
    }
    if (!ALLOWED.some((re) => re.test(st))) {
      errors.push(`statement shape not allowed (additive-only): ${st.slice(0, 80)}`);
    }
  }
  return { ok: errors.length === 0, errors, count: statements.length };
}

// ---- migration bookkeeping ------------------------------------------------
async function ensureMigrationTable(schema) {
  await q(`CREATE TABLE IF NOT EXISTS ${schema}._migrations (
    file TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}

function migrationFiles(versionDir) {
  const dir = path.join(versionDir, "migrations");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => ({ file: f, sql: fs.readFileSync(path.join(dir, f), "utf8") }));
}

// Apply a version's migrations to a schema (skipping already-applied files).
async function applyMigrations(schema, versionDir) {
  await q(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await ensureMigrationTable(schema);
  const applied = new Set(
    (await q(`SELECT file FROM ${schema}._migrations`)).rows.map((r) => r.file)
  );
  const results = [];
  for (const m of migrationFiles(versionDir)) {
    if (applied.has(m.file)) continue;
    const v = validateMigrationSql(m.sql);
    if (!v.ok) throw new Error(`migration ${m.file} rejected: ${v.errors.join("; ")}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query(m.sql);
      await client.query(`INSERT INTO ${schema}._migrations (file) VALUES ($1)`, [m.file]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${m.file} failed: ${e.message}`);
    } finally {
      client.release();
    }
    results.push(m.file);
  }
  return results;
}

// ---- schema cloning (used for staging and snapshots) ----------------------
async function tablesIn(schema) {
  return (await q(`SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`, [schema]))
    .rows.map((r) => r.tablename);
}

async function cloneSchema(fromSchema, toSchema) {
  await q(`DROP SCHEMA IF EXISTS ${toSchema} CASCADE`);
  await q(`CREATE SCHEMA ${toSchema}`);
  await q(`CREATE SCHEMA IF NOT EXISTS ${fromSchema}`);
  const tables = await tablesIn(fromSchema);
  for (const t of tables) {
    // INCLUDING ALL keeps defaults (so serial columns keep pointing at the live
    // sequence), constraints and indexes. Data is copied row for row.
    await q(`CREATE TABLE ${toSchema}.${t} (LIKE ${fromSchema}.${t} INCLUDING ALL)`);
    await q(`INSERT INTO ${toSchema}.${t} SELECT * FROM ${fromSchema}.${t}`);
  }
  return tables;
}

// Rebuild the staging schema as a clone (structure + data) of the live one.
async function rebuildStagingClone(company, mod) {
  const tables = await cloneSchema(liveSchema(company, mod), stagingSchema(company, mod));
  await logEvent("staging_clone_rebuilt", `${company}/${mod}`, { tables });
  return tables;
}

// ---- snapshots (in-database) ----------------------------------------------
async function snapshotSchema(company, mod, version) {
  const name = `snap_${company}_${mod}_${Date.now()}`;
  await cloneSchema(liveSchema(company, mod), name);
  return name;
}

async function recordSnapshot(company, mod, version, snapName) {
  await q(
    "INSERT INTO platform.schema_snapshots (company, module, version, file) VALUES ($1,$2,$3,$4)",
    [company, mod, version, snapName]
  );
  // retention: keep the newest N per module
  const old = (await q(
    `SELECT id, file FROM platform.schema_snapshots WHERE company=$1 AND module=$2 ORDER BY id DESC OFFSET $3`,
    [company, mod, KEEP_SNAPSHOTS])).rows;
  for (const s of old) {
    await q(`DROP SCHEMA IF EXISTS ${s.file} CASCADE`);
    await q("DELETE FROM platform.schema_snapshots WHERE id=$1", [s.id]);
  }
}

async function columnsOf(schema, table) {
  return (await q(
    `SELECT column_name, column_default FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [schema, table])).rows;
}

// Restore a snapshot INTO the live schema in place. Additive-only migrations
// mean the live schema is a superset of the snapshot: extra tables, columns and
// indexes get dropped, then every table's data is replaced with the snapshot's.
async function restoreSnapshot(company, mod, snapName) {
  const live = liveSchema(company, mod);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const liveTables = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname=$1`, [live])).rows.map((r) => r.tablename);
    const snapTables = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname=$1`, [snapName])).rows.map((r) => r.tablename);

    for (const t of liveTables) {
      if (!snapTables.includes(t)) await client.query(`DROP TABLE ${live}.${t} CASCADE`);
    }
    for (const t of snapTables) {
      if (!liveTables.includes(t)) {
        await client.query(`CREATE TABLE ${live}.${t} (LIKE ${snapName}.${t} INCLUDING ALL)`);
      }
      const liveCols = (await client.query(
        `SELECT column_name, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [live, t])).rows;
      const snapCols = (await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [snapName, t])).rows.map((r) => r.column_name);
      for (const c of liveCols) {
        if (!snapCols.includes(c.column_name)) await client.query(`ALTER TABLE ${live}.${t} DROP COLUMN ${c.column_name}`);
      }
      // indexes added after the snapshot
      const liveIdx = (await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename=$2`, [live, t])).rows.map((r) => r.indexname);
      const snapIdx = (await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename=$2`, [snapName, t])).rows.map((r) => r.indexname);
      for (const i of liveIdx) {
        if (!snapIdx.includes(i) && !/_pkey$/.test(i)) await client.query(`DROP INDEX IF EXISTS ${live}.${i}`);
      }
      const cols = snapCols.join(", ");
      await client.query(`TRUNCATE ${live}.${t}`);
      await client.query(`INSERT INTO ${live}.${t} (${cols}) SELECT ${cols} FROM ${snapName}.${t}`);
      // reset serial sequences to the restored data
      for (const c of liveCols) {
        const m = /nextval\('([^']+)'/.exec(c.column_default || "");
        if (m && snapCols.includes(c.column_name)) {
          await client.query(
            `SELECT setval('${m[1]}', COALESCE((SELECT MAX(${c.column_name}) FROM ${live}.${t}), 0) + 1, false)`);
        }
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  await logEvent("schema_restored", `${company}/${mod}`, { snapshot: snapName });
}

module.exports = {
  liveSchema, stagingSchema, validateMigrationSql, applyMigrations,
  rebuildStagingClone, snapshotSchema, recordSnapshot, restoreSnapshot, tablesIn, columnsOf,
};
