// The data check: when the AI reviews floor feedback, does the change need
// data from the company's ERP, and can the ERP connection give it today?
// Brendan, 2026-09-19: the ERP stays on the admin side. A manager never sees
// lookups, fields or BAQs; the agent checks at review time whether it has
// access to the data, and when it does not, that becomes an admin-side data
// request. The manager's card says one plain sentence and has nothing to do.
//
// How it works. For a module with an ERP connection, the proposal model is
// asked to list every piece of ERP data the change needs: what it is in plain
// words, which lookup it would come from, and the published field that covers
// it (from ERP-FIELDS.md), or none. The PLATFORM then verifies each named
// field against the connection's catalog and resolved fields; the model's own
// opinion of availability is never trusted. Anything not covered opens a row
// in platform.data_requests and the proposal waits (proposals.data_check
// status "waiting"). The admin widens the lookup in the ERP, publishes the
// field, and resolves the request: the feedback is proposed again with the
// new field list. A catalog change re-proposes waiting items on its own. If
// the data cannot be had, the admin dismisses the request with a reason and
// the manager sees that sentence.
const { q, logEvent } = require("./db");
const { record } = require("./record");

const SCHEMA = `
ALTER TABLE platform.proposals ADD COLUMN IF NOT EXISTS data_check JSONB;
CREATE TABLE IF NOT EXISTS platform.data_requests (
  id           SERIAL PRIMARY KEY,
  company      TEXT NOT NULL,
  module       TEXT NOT NULL,
  feedback_id  INTEGER,
  proposal_id  INTEGER,
  what         TEXT NOT NULL,            -- plain words: "the date each job is due"
  lookup       TEXT,                     -- the lookup the agent expected it from, if any
  status       TEXT NOT NULL DEFAULT 'open',   -- open | provided | dismissed
  note         TEXT,                     -- the admin's words on resolve or dismiss
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS data_requests_open ON platform.data_requests (company, module) WHERE status='open';
`;
async function init() { await q(SCHEMA); }

// What the proposal model is asked, only for a module that has an ERP connection.
function schemaFor(lookups) {
  return {
    type: "array",
    description: "Every piece of data this change needs from the company's ERP (orders, jobs, parts, stock, dates, customers: anything the module does not already keep itself). Empty when the change needs none. Use ERP-FIELDS.md: name the published field that covers each need; when no listed field covers it, leave field empty. Never invent a field name.",
    items: {
      type: "object",
      properties: {
        what: { type: "string", description: "The data in the manager's words, e.g. 'the date each job is due'." },
        lookup: { type: "string", enum: lookups.length ? lookups : ["none"], description: "The lookup it would come from." },
        field: { type: "string", description: "The plain field name from ERP-FIELDS.md that covers it, or empty when none does." },
      },
      required: ["what", "lookup", "field"],
    },
  };
}

// The module's ERP lookups and what each can give right now.
async function erpState(company, mod) {
  const connections = require("./connections");
  const audit = await connections.fieldAudit(company, mod);
  const lookups = {};
  for (const a of audit) {
    const ok = new Set(a.available);
    for (const [f, how] of Object.entries(a.how)) if (how !== "missing") ok.add(f);
    lookups[a.query] = { defined: a.defined, fields: ok };
  }
  return lookups;
}

// Verify what the model listed. Returns the data_check stored on the proposal.
function verify(needs, lookups) {
  const out = { status: "none", needs: [], missing: [] };
  for (const n of Array.isArray(needs) ? needs : []) {
    const what = String(n && n.what || "").trim().slice(0, 200); if (!what) continue;
    const lookup = lookups[n.lookup] ? n.lookup : null;
    const field = String(n.field || "").trim();
    const available = Boolean(lookup && field && lookups[lookup].defined && lookups[lookup].fields.has(field));
    out.needs.push({ what, lookup, field: field || null, available });
    if (!available) out.missing.push({ what, lookup });
  }
  if (out.needs.length) out.status = out.missing.length ? "waiting" : "ok";
  return out;
}

// After a proposal is drafted: store the check, open requests for what is missing.
async function apply(proposal, fb, needs) {
  const lookups = await erpState(fb.company, fb.module);
  if (!Object.keys(lookups).length) return null;
  const check = verify(needs, lookups);
  await q("UPDATE platform.proposals SET data_check=$2 WHERE id=$1", [proposal.id, JSON.stringify(check)]);
  // requests from an earlier proposal of the same feedback are replaced by this one's
  await q("UPDATE platform.data_requests SET status='provided', resolved_at=now(), note=COALESCE(note,'') || ' (proposed again)' WHERE feedback_id=$1 AND status='open'", [fb.id]);
  for (const m of check.missing) {
    await q("INSERT INTO platform.data_requests (company, module, feedback_id, proposal_id, what, lookup) VALUES ($1,$2,$3,$4,$5,$6)", [fb.company, fb.module, fb.id, proposal.id, m.what, m.lookup]);
  }
  if (check.needs.length) await record("data_check", { company: fb.company, module: fb.module, actor: "platform", feedback_id: fb.id, proposal_id: proposal.id, after: check.status === "ok" ? `every piece of ERP data is available: ${check.needs.map((n) => n.field).join(", ")}` : `waiting on ERP data: ${check.missing.map((m) => m.what).join("; ")}`, detail: check });
  if (check.missing.length) await logEvent("data_request_opened", fb.id, { company: fb.company, module: fb.module, missing: check.missing });
  return check;
}

async function list({ status = "open" } = {}) {
  return (await q(`SELECT r.*, c.name AS company_name, m.title AS module_title, f.message, f.name AS reporter, f.created_at AS filed_at
                     FROM platform.data_requests r
                     LEFT JOIN platform.companies c ON c.slug=r.company
                     LEFT JOIN platform.modules m ON m.company=r.company AND m.name=r.module
                     LEFT JOIN platform.feedback f ON f.id=r.feedback_id
                    WHERE ($1::text IS NULL OR r.status=$1) ORDER BY r.status='open' DESC, r.id DESC LIMIT 200`, [status === "all" ? null : status])).rows;
}

// Propose a waiting feedback item again (the field list has changed, or the admin says the data is there now).
async function reproposeFeedback(feedbackId) {
  const { generateProposal } = require("./proposals");
  const fb = (await q("SELECT id, status FROM platform.feedback WHERE id=$1", [feedbackId])).rows[0];
  if (!fb || fb.status !== "reviewing") return null;
  await q("UPDATE platform.proposals SET status='superseded' WHERE feedback_id=$1 AND status='draft'", [feedbackId]);
  return generateProposal(feedbackId);
}
async function resolve(id, note, actor) {
  const r = (await q("SELECT * FROM platform.data_requests WHERE id=$1", [id])).rows[0];
  if (!r) throw new Error("no such data request");
  if (r.status !== "open") throw new Error(`that request is already ${r.status}`);
  await q("UPDATE platform.data_requests SET status='provided', note=$1, resolved_at=now() WHERE feedback_id=$2 AND status='open'", [String(note || "").slice(0, 500) || null, r.feedback_id]);
  await record("data_request_resolved", { company: r.company, module: r.module, actor: actor || "admin", feedback_id: r.feedback_id, proposal_id: r.proposal_id, before: r.what, after: note || "provided", detail: { request_id: id } });
  const p = await reproposeFeedback(r.feedback_id).catch((e) => ({ error: e.message }));
  return { ok: true, reproposed: p && !p.error ? p.id : null, error: p && p.error || null };
}
async function dismiss(id, note, actor) {
  const r = (await q("SELECT * FROM platform.data_requests WHERE id=$1", [id])).rows[0];
  if (!r) throw new Error("no such data request");
  if (r.status !== "open") throw new Error(`that request is already ${r.status}`);
  const why = String(note || "").trim().slice(0, 500);
  if (!why) throw new Error("say why in a sentence the manager will read");
  await q("UPDATE platform.data_requests SET status='dismissed', note=$2, resolved_at=now() WHERE id=$1", [id, why]);
  // when nothing is open any more for that proposal, it stops waiting and says why
  const open = (await q("SELECT count(*)::int AS n FROM platform.data_requests WHERE proposal_id=$1 AND status='open'", [r.proposal_id])).rows[0].n;
  if (!open) await q("UPDATE platform.proposals SET data_check = jsonb_set(jsonb_set(COALESCE(data_check,'{}'::jsonb), '{status}', '\"unavailable\"'), '{reason}', to_jsonb($2::text)) WHERE id=$1", [r.proposal_id, why]);
  await record("data_request_dismissed", { company: r.company, module: r.module, actor: actor || "admin", feedback_id: r.feedback_id, proposal_id: r.proposal_id, before: r.what, after: why, detail: { request_id: id } });
  return { ok: true };
}
// The connection's field list changed: propose the module's waiting items again.
async function catalogChanged(company, mod) {
  const rows = (await q("SELECT DISTINCT feedback_id FROM platform.data_requests WHERE company=$1 AND module=$2 AND status='open' AND feedback_id IS NOT NULL", [company, mod])).rows;
  const out = [];
  for (const r of rows) { try { const p = await reproposeFeedback(r.feedback_id); if (p) out.push(p.id); } catch (e) { console.error(`[datacheck] repropose #${r.feedback_id}:`, e.message); } }
  return out;
}
async function deleteCompany(company) { await q("DELETE FROM platform.data_requests WHERE company=$1", [company]); }

module.exports = { init, SCHEMA, schemaFor, erpState, verify, apply, list, resolve, dismiss, catalogChanged, reproposeFeedback, deleteCompany };
