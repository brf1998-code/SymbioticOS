// Close the loop, floor side. Product review of 2026-09-18, build order item 6
// (Brendan, 2026-09-19: floor side first; "not quite" asks what is still off and
// files it as a follow-up linked to the original).
//
// Until this, a request left the floor and nothing came back: the person who
// asked had to notice the change themselves, and the platform never learned
// whether the change fixed anything. Three pieces, all on the feedback button
// the floor already knows:
//
//   My requests    the signed-in person's own requests, each with one plain
//                  line saying where it is (on the board, proposed, being
//                  built, being checked, live, declined).
//   The banner     when a change goes live, the module's pages say what is new
//                  and who asked for it. The person who asked is asked back:
//                  "Did it fix it?"
//   Fixed it /     one tap. "Not quite" asks what is still off and files that
//   not quite      as a new request linked to the original (follow_up_of), so
//                  it goes round the same loop with the manager's gate intact.
//                  The original stays shipped. The proposer is told what was
//                  built before and what the person says is still off.
//
// Who may answer: the person who asked. A request filed with nobody signed in
// may be answered by any signed-in person of that company (the record says
// who). "Fixed" may later become "not quite" (it looked right on day one);
// "not quite" is final, the follow-up carries it from there.
//
// Everything here is reachable from a module page (the page policy opens
// /api/c/<co>/who/), so nothing here may do more than the feedback endpoint
// already lets a page do: read the signed-in person's own requests, file a
// request under their name. Nothing reaches the floor without the manager.
const { q } = require("./db");
const { record } = require("./record");

const SCHEMA = `
ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS follow_up_of INTEGER;
ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS shipped_version INTEGER;
ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;
ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS floor_answer TEXT;            -- fixed | not_quite: the floor's own answer once the change is live
ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS floor_answer_at TIMESTAMPTZ;
ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS floor_answer_person INTEGER;
ALTER TABLE platform.feedback ADD COLUMN IF NOT EXISTS floor_answer_by TEXT;
CREATE INDEX IF NOT EXISTS feedback_person ON platform.feedback (company, person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS feedback_follow_up ON platform.feedback (follow_up_of) WHERE follow_up_of IS NOT NULL;
`;
async function init() { await q(SCHEMA); }

const NEWS_DAYS = 14;
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
const rolledBack = (r) => /^Rolled back/i.test(r.outcome || "");
// "Deployed v5 (batch of 2): the summary" -> "the summary"
const summaryOf = (outcome) => String(outcome || "").replace(/^Deployed v\d+( \(batch of \d+\))?:\s*/i, "").trim();

// ---- pure: where a request is, in one plain line -------------------------------------------
// row: a feedback row plus proposal_status, data_status, run_status, run_step.
function stateOf(r) {
  if (r.status === "declined") {
    const why = r.outcome && !/^declined$/i.test(r.outcome) ? clip(r.outcome, 240) : "";
    return { state: "declined", line: why ? `Declined: ${why}` : "Declined." };
  }
  if (r.status === "done") {
    if (rolledBack(r)) return { state: "rolled_back", line: "It went live, then was taken back off. The manager knows." };
    if (r.floor_answer === "fixed") return { state: "fixed", line: "Live. You said it fixed it." };
    if (r.floor_answer === "not_quite") return { state: "not_quite", line: "Live, and you said not quite. Your follow-up is on the board." };
    return { state: "live", line: "Live. Did it fix it?" };
  }
  if (r.run_status === "waiting" && r.run_step === "await_deploy") return { state: "checking", line: "Built. The manager is checking it before it goes live." };
  if (["queued", "running", "waiting", "failed"].includes(r.run_status)) return { state: "building", line: "Approved. Being built." };
  if (r.proposal_status === "approved") return { state: "building", line: "Approved. Waiting its turn to be built." };
  if (r.proposal_status === "draft") {
    return r.data_status === "waiting"
      ? { state: "waiting_data", line: "Waiting on data from the office before it can be built." }
      : { state: "proposed", line: "The manager has a proposal to decide on." };
  }
  return { state: "new", line: "On the board. The manager has not looked yet." };
}
// pure: may this person answer "fixed it / not quite" on this request?
function mayAnswer(r, personId) {
  if (!personId || r.status !== "done" || rolledBack(r) || r.kind === "module_request") return false;
  if (r.floor_answer === "not_quite") return false;
  return r.person_id ? Number(r.person_id) === Number(personId) : true;
}
// pure: what the proposer is told about a follow-up. The marker sentence is fixed text: the fake agent looks for it.
function followUpContext(original) {
  if (!original) return "";
  const built = summaryOf(original.outcome);
  return `\n\nThis is a follow-up to request #${original.id}. The same need came up before, in these words: "${clip(original.message, 600)}". ` +
    (built ? `What was built for it and is live now${original.shipped_version ? ` (version ${original.shipped_version})` : ""}: ${clip(built, 600)} ` : "") +
    "The person tried it on the floor and says it is not quite right; the feedback above is what is still off. Propose the smallest change that closes that gap. Keep what already works; do not start over.";
}

// ---- reads -----------------------------------------------------------------------------------
const SELECT = `
  SELECT f.id, f.kind, f.module, f.page, f.screen, f.message, f.name, f.person_id, f.status, f.outcome, f.created_at, f.follow_up_of,
         f.shipped_version, f.shipped_at, f.floor_answer, f.floor_answer_at, f.floor_answer_by,
         p.status AS proposal_status, p.data_check->>'status' AS data_status, r.status AS run_status, r.step AS run_step,
         (SELECT c.id FROM platform.feedback c WHERE c.follow_up_of = f.id ORDER BY c.id DESC LIMIT 1) AS follow_up_id
    FROM platform.feedback f
    LEFT JOIN LATERAL (SELECT id, status, data_check FROM platform.proposals WHERE feedback_id = f.id AND status <> 'superseded' ORDER BY id DESC LIMIT 1) p ON true
    LEFT JOIN LATERAL (SELECT status, step FROM platform.build_runs WHERE p.id = ANY(COALESCE(proposal_ids, ARRAY[proposal_id])) AND status <> 'cancelled' ORDER BY id DESC LIMIT 1) r ON true`;

const publicRow = (r, personId) => ({
  id: r.id, module: r.module, screen: r.screen || null, words: clip(r.message, 280), created_at: r.created_at,
  ...stateOf(r), built: r.status === "done" && !rolledBack(r) ? clip(summaryOf(r.outcome), 400) || null : null,
  shipped_at: r.shipped_at || null, follow_up_of: r.follow_up_of || null, follow_up_id: r.follow_up_id || null,
  can_answer: mayAnswer(r, personId),
});

// The signed-in person's own requests, newest first, and how many are waiting on their answer.
async function myRequests(company, personId, { limit = 40 } = {}) {
  if (!personId) return { requests: [], to_answer: 0 };
  const rows = (await q(`${SELECT} WHERE f.company=$1 AND f.person_id=$2 AND f.kind='feedback' ORDER BY f.id DESC LIMIT $3`, [company, personId, Math.min(100, Number(limit) || 40)])).rows;
  const requests = rows.map((r) => publicRow(r, personId));
  return { requests, to_answer: requests.filter((r) => r.state === "live" && r.can_answer).length };
}

// What went live in this module lately, newest version first, with who asked.
// Only versions at or below the live one count (a rollback clears shipped_version).
async function news(company, mod, personId) {
  const live = (await q("SELECT live_version FROM platform.modules WHERE company=$1 AND name=$2", [company, mod])).rows[0];
  if (!live || !live.live_version) return { module: mod, live_version: null, changes: [] };
  const rows = (await q(
    `${SELECT} WHERE f.company=$1 AND f.module=$2 AND f.kind='feedback' AND f.status='done' AND f.shipped_version IS NOT NULL AND f.shipped_version <= $3
        AND f.shipped_at > now() - interval '${NEWS_DAYS} days' ORDER BY f.shipped_version DESC, f.id LIMIT 24`, [company, mod, live.live_version])).rows;
  const byVersion = new Map();
  for (const r of rows) {
    if (!byVersion.has(r.shipped_version)) byVersion.set(r.shipped_version, { version: r.shipped_version, shipped_at: r.shipped_at, summary: clip(summaryOf(r.outcome), 320), asked_by: [], items: [] });
    const v = byVersion.get(r.shipped_version);
    if (r.name && !v.asked_by.includes(r.name)) v.asked_by.push(r.name);
    v.items.push({ id: r.id, words: clip(r.message, 200), asked_by: r.name || null, mine: Boolean(personId && r.person_id && Number(r.person_id) === Number(personId)), can_answer: mayAnswer(r, personId), floor_answer: r.floor_answer || null });
  }
  return { module: mod, live_version: live.live_version, changes: [...byVersion.values()] };
}

// ---- writes ----------------------------------------------------------------------------------
// From pipeline.deploy: these requests are on the floor as of this version.
async function markShipped(feedbackIds, version) {
  if (!feedbackIds || !feedbackIds.length) return;
  await q("UPDATE platform.feedback SET shipped_version=$2, shipped_at=now() WHERE id = ANY($1::int[])", [feedbackIds, version]);
}
// From pipeline.rollbackRun: no longer on the floor, so no banner and nothing to answer.
async function markRolledBack(feedbackIds) {
  if (!feedbackIds || !feedbackIds.length) return;
  await q("UPDATE platform.feedback SET shipped_version=NULL, shipped_at=NULL WHERE id = ANY($1::int[])", [feedbackIds]);
}

const fail = (status, msg) => Object.assign(new Error(msg), { status });
// The floor's answer. person = { id, name, role }; answer = "fixed" | "not_quite"; what = what is still off.
async function answer({ company, feedbackId, person, role, answer: ans, what }) {
  if (!person || !person.id) throw fail(401, "tap your name first, so the answer is yours");
  if (!["fixed", "not_quite"].includes(ans)) throw fail(400, "the answer is fixed or not_quite");
  const fb = (await q("SELECT * FROM platform.feedback WHERE id=$1 AND company=$2", [Number(feedbackId), company])).rows[0];
  if (!fb) throw fail(404, "no such request");
  if (fb.floor_answer === "not_quite") throw fail(409, "you already said not quite; your follow-up is on the board");
  if (fb.floor_answer === ans) throw fail(409, "you already told us, thank you");
  if (!mayAnswer(fb, person.id)) throw fail(fb.status === "done" && !rolledBack(fb) ? 403 : 409, fb.status === "done" && !rolledBack(fb) ? "only the person who asked can answer this one" : "this one is not live, so there is nothing to answer yet");
  const still = String(what || "").trim().slice(0, 2000);
  if (ans === "not_quite" && still.length < 3) throw fail(400, "say what is still off, in a few words");

  const upd = (await q(
    `UPDATE platform.feedback SET floor_answer=$2, floor_answer_at=now(), floor_answer_person=$3, floor_answer_by=$4, updated_at=now()
      WHERE id=$1 AND (floor_answer IS NULL OR (floor_answer='fixed' AND $2='not_quite')) RETURNING *`, [fb.id, ans, person.id, person.name])).rows[0];
  if (!upd) throw fail(409, "already answered");
  const actor = { role: role || "floor", name: person.name, person: person.id };
  if (ans === "fixed") {
    await record("floor_fixed", { company, module: fb.module, actor, feedback_id: fb.id, version: fb.shipped_version || null, after: "fixed it", detail: { asked_by: fb.name || null, changed_mind: false } });
    return { answer: "fixed", request: upd.id };
  }
  // not quite: the words go round the loop as a request of their own, tied to the original
  const follow = (await q(
    `INSERT INTO platform.feedback (company, module, page, screen, target_file, message, name, person_id, follow_up_of)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [company, fb.module, fb.page, fb.screen, fb.target_file, still, person.name, person.id, fb.id])).rows[0];
  await record("floor_not_quite", { company, module: fb.module, actor, feedback_id: fb.id, version: fb.shipped_version || null, before: fb.floor_answer || null, after: still, detail: { follow_up_id: follow.id, asked_by: fb.name || null } });
  await record("feedback_filed", { company, module: fb.module, actor, feedback_id: follow.id, after: still, detail: { screen: fb.screen, page: fb.page, follow_up_of: fb.id } });
  return { answer: "not_quite", request: upd.id, follow_up: { id: follow.id, words: clip(still, 280) } };
}

// For the proposer: the original behind a follow-up, or null.
async function originalOf(fb) {
  if (!fb || !fb.follow_up_of) return null;
  return (await q("SELECT id, message, outcome, shipped_version FROM platform.feedback WHERE id=$1 AND company=$2", [fb.follow_up_of, fb.company])).rows[0] || null;
}

module.exports = { init, SCHEMA, NEWS_DAYS, stateOf, mayAnswer, followUpContext, summaryOf, clip, myRequests, news, markShipped, markRolledBack, answer, originalOf };
