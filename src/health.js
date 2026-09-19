// Loop health: the numbers Brendan watches on /admin, per company and across
// the fleet. Product review of 2026-09-18, build order item 4. These are the
// platform's own KPIs (is the loop turning, how fast, where does it stop),
// not the plant's: the manager's board shows none of this.
//
// Sources, in order of preference. The primary tables carry the whole history
// (feedback, proposals, build_runs with their timestamped log), so every count
// works for runs that predate the interaction record. The record adds what
// only it knows: decision times, and whether the manager edited the proposal.
// Where the record is missing, a decision time falls back to the run's start
// (a run is created the moment a proposal is approved).
//
// compute() is pure: it takes rows and a clock and returns numbers, so the
// unit tests feed it synthetic rows. load() fetches the rows. forAdmin() is
// the one call the admin page makes.
const { q } = require("./db");
const agent = require("./agent");

const HOUR = 3600e3, DAY = 86400e3;
const SAME_SHIFT_HOURS = 8;
const OPEN_FEEDBACK = new Set(["new", "reviewing", "in_progress"]);

const ms = (d) => (d instanceof Date ? d : new Date(d)).getTime();
const hours = (a, b) => (ms(b) - ms(a)) / HOUR;
const round1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
function median(xs) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function p90(xs) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]; }

// What stopped a run, from the error line the run logged. Gate = the
// platform's own checks (no override), reviewer = the model cross-check,
// tests = smoke and visual checks, other = the agent or the platform erred.
function stopKind(note) {
  const n = String(note || "");
  if (/^platform checks failed/.test(n)) return "gate";
  if (/^cross-check failed/.test(n)) return "reviewer";
  if (/^(internal tests|visual check) failed/.test(n)) return "tests";
  return "other";
}

// Timestamps a run's log carries: when it was ready for the deploy gate, when
// it went live, when it was rolled back, and every stop.
function runTimes(run) {
  const log = Array.isArray(run.log) ? run.log : [];
  const find = (pred) => { const e = log.filter(pred).slice(-1)[0]; return e && e.t ? e.t : null; };
  return {
    // the line each lane logs when the build reaches the deploy gate
    ready: find((e) => (e.step === "test_run" && /^smoke checks passed/.test(e.note || "")) || (e.step === "visual_check" && /ready for manager review/.test(e.note || ""))),
    deployed: find((e) => e.step === "deploy"),
    rolledBack: find((e) => e.step === "rollback"),
    stops: log.filter((e) => e.step === "error" && e.t).map((e) => ({ t: e.t, kind: stopKind(e.note) })),
  };
}

// One group's numbers (a company, or the fleet). g carries that group's rows.
function metrics(g, now, windowDays) {
  const inWin = (d) => d != null && (windowDays === 0 || ms(now) - ms(d) <= windowDays * DAY) && ms(d) <= ms(now);
  const feedbackById = new Map(g.feedback.map((f) => [f.id, f]));
  const runsByProposal = new Map();
  for (const r of g.runs) for (const pid of (r.proposal_ids && r.proposal_ids.length ? r.proposal_ids : [r.proposal_id])) {
    if (!runsByProposal.has(pid)) runsByProposal.set(pid, []);
    runsByProposal.get(pid).push(r);
  }
  const rec = (kind) => g.record.filter((r) => r.kind === kind);
  const decisionRows = new Map();
  for (const r of g.record) if ((r.kind === "proposal_approved" || r.kind === "proposal_declined") && r.proposal_id && !decisionRows.has(r.proposal_id)) decisionRows.set(r.proposal_id, r.created_at);
  const editedIds = new Set(rec("proposal_edited").filter((r) => inWin(r.created_at)).map((r) => r.proposal_id));

  // feedback
  const filed = g.feedback.filter((f) => inWin(f.created_at));
  const open = g.feedback.filter((f) => OPEN_FEEDBACK.has(f.status));
  const oldestOpen = open.length ? Math.max(...open.map((f) => hours(f.created_at, now))) : null;

  // decisions
  const decisionTime = (p) => {
    if (decisionRows.has(p.id)) return decisionRows.get(p.id);
    if (p.status === "approved") { const rs = runsByProposal.get(p.id) || []; if (rs.length) return rs.map((r) => r.created_at).sort((a, b) => ms(a) - ms(b))[0]; }
    return null;
  };
  const decided = g.proposals.filter((p) => p.status === "approved" || p.status === "declined").map((p) => ({ p, at: decisionTime(p) || p.created_at, known: Boolean(decisionTime(p)) }));
  const approved = decided.filter((d) => d.p.status === "approved" && inWin(d.at));
  const declined = decided.filter((d) => d.p.status === "declined" && inWin(d.at));
  const decisionWaits = decided.filter((d) => d.known && inWin(d.at)).map((d) => hours(d.p.created_at, d.at)).filter((h) => h >= 0);
  // a draft that waits on ERP data (src/datacheck.js) waits on Anetix, not on the manager
  const openDrafts = g.proposals.filter((p) => p.status === "draft" && OPEN_FEEDBACK.has((feedbackById.get(p.feedback_id) || {}).status));
  const waitingDecision = openDrafts.filter((p) => p.data_status !== "waiting");
  const waitingData = openDrafts.filter((p) => p.data_status === "waiting");
  const oldestWaiting = waitingDecision.length ? Math.max(...waitingDecision.map((p) => hours(p.created_at, now))) : null;
  const oldestWaitingData = waitingData.length ? Math.max(...waitingData.map((p) => hours(p.created_at, now))) : null;

  // runs
  const timed = g.runs.map((r) => ({ r, t: runTimes(r) }));
  const started = timed.filter((x) => inWin(x.r.created_at));
  const shipped = timed.filter((x) => inWin(x.t.deployed));
  const rolledBack = timed.filter((x) => inWin(x.t.rolledBack));
  const stops = { gate: 0, reviewer: 0, tests: 0, other: 0 };
  for (const x of timed) for (const s of x.t.stops) if (inWin(s.t)) stops[s.kind]++;
  const fixRounds = started.reduce((n, x) => n + Number((x.r.evidence || {}).fix_round || 0), 0);
  const overrides = started.filter((x) => ((x.r.evidence || {}).cross_check || {}).overridden).length;
  const cancelled = started.filter((x) => x.r.status === "cancelled").length;
  const inFlight = g.runs.filter((r) => r.status === "queued" || r.status === "running").length;
  const waitingDeploy = g.runs.filter((r) => r.status === "waiting" && r.step === "await_deploy").length;
  const waitingConfirm = g.runs.filter((r) => r.status === "waiting" && r.step === "confirm_requirement").length;

  // time to floor: the earliest feedback in the run's batch to the deploy
  const toFloor = shipped.map((x) => {
    const pids = x.r.proposal_ids && x.r.proposal_ids.length ? x.r.proposal_ids : [x.r.proposal_id];
    const fbs = pids.map((pid) => g.proposals.find((p) => p.id === pid)).filter(Boolean).map((p) => feedbackById.get(p.feedback_id)).filter(Boolean);
    if (!fbs.length) return null;
    const t0 = fbs.map((f) => ms(f.created_at)).sort((a, b) => a - b)[0];
    return (ms(x.t.deployed) - t0) / HOUR;
  }).filter((h) => h != null && h >= 0);
  const deployWaits = shipped.filter((x) => x.t.ready).map((x) => hours(x.t.ready, x.t.deployed)).filter((h) => h >= 0);

  // models the builds ran on
  const models = {};
  for (const x of started) { const m = x.r.model || "unknown"; models[m] = (models[m] || 0) + 1; }

  // the quiet stretch (whole history): days since the last reviewer or test
  // stop, the last gate stop, the last rollback. null = never.
  const last = (pick) => { const ts = timed.flatMap(pick).filter(Boolean).map(ms); return ts.length ? (ms(now) - Math.max(...ts)) / DAY : null; };
  const quiet = {
    check_stop_days: round1(last((x) => x.t.stops.filter((s) => s.kind === "reviewer" || s.kind === "tests").map((s) => s.t))),
    gate_stop_days: round1(last((x) => x.t.stops.filter((s) => s.kind === "gate").map((s) => s.t))),
    rollback_days: round1(last((x) => [x.t.rolledBack])),
    other_stop_days: round1(last((x) => x.t.stops.filter((s) => s.kind === "other").map((s) => s.t))),
  };

  // what the floor said once a change was live (src/closeloop.js): fixed it, or not quite (a miss: the
  // follow-up goes round the loop again). Unanswered = went live in the window, still live, nobody has said.
  const answered = g.feedback.filter((f) => f.floor_answer && inWin(f.floor_answer_at));
  const fixedN = answered.filter((f) => f.floor_answer === "fixed").length, notQuiteN = answered.filter((f) => f.floor_answer === "not_quite").length;
  const wentLive = g.feedback.filter((f) => f.status === "done" && f.shipped_at && inWin(f.shipped_at));
  // the manager's own close-out on the shipped tile (Done / a little left). "Unanswered" means nobody has said
  // anything, floor or manager. A change counts as met or missed once per request: a miss is the floor's not
  // quite or the manager's a little left; met is fixed or done with no miss on it.
  const mgr = g.feedback.filter((f) => f.manager_answer && inWin(f.manager_answer_at));
  const mgrDone = mgr.filter((f) => f.manager_answer === "done").length, mgrLeft = mgr.filter((f) => f.manager_answer === "little_left").length;
  const unanswered = wentLive.filter((f) => !f.floor_answer && !f.manager_answer);
  const spoken = g.feedback.filter((f) => (f.floor_answer && inWin(f.floor_answer_at)) || (f.manager_answer && inWin(f.manager_answer_at)));
  const missed = spoken.filter((f) => f.floor_answer === "not_quite" || f.manager_answer === "little_left").length;
  const followUpsOpen = g.feedback.filter((f) => f.follow_up_of && OPEN_FEEDBACK.has(f.status)).length;

  // intakes (new modules)
  const intakes = g.intakes.filter((i) => inWin(i.created_at));
  const spendWindow = Number(g.spend_window || 0), spendMonth = Number(g.spend_month || 0);

  return {
    feedback: { filed: filed.length, open: open.length, oldest_open_hours: round1(oldestOpen) },
    decisions: {
      approved: approved.length, declined: declined.length,
      edited: approved.filter((d) => editedIds.has(d.p.id)).length,
      waiting: waitingDecision.length, oldest_waiting_hours: round1(oldestWaiting),
      waiting_data: waitingData.length, oldest_waiting_data_hours: round1(oldestWaitingData),
      wait_median_hours: round1(median(decisionWaits)), wait_n: decisionWaits.length,
    },
    builds: {
      started: started.length, shipped: shipped.length, rolled_back: rolledBack.length, cancelled,
      stops, fix_rounds: fixRounds, overrides,
      in_flight: inFlight, waiting_deploy: waitingDeploy, waiting_confirm: waitingConfirm,
      models,
    },
    floor: {
      n: toFloor.length, median_hours: round1(median(toFloor)), p90_hours: round1(p90(toFloor)),
      same_shift: toFloor.filter((h) => h <= SAME_SHIFT_HOURS).length,
      deploy_wait_median_hours: round1(median(deployWaits)), deploy_wait_n: deployWaits.length,
    },
    quiet,
    answers: {
      fixed: fixedN, not_quite: notQuiteN, went_live: wentLive.length, unanswered: unanswered.length,
      unanswered_named: unanswered.filter((f) => f.person_id).length,
      fixed_share: fixedN + notQuiteN ? Math.round((fixedN / (fixedN + notQuiteN)) * 100) / 100 : null,
      follow_ups_open: followUpsOpen,
      manager_done: mgrDone, manager_little_left: mgrLeft,
      met: spoken.length - missed, missed, met_share: spoken.length ? Math.round(((spoken.length - missed) / spoken.length) * 100) / 100 : null,
    },
    intakes: {
      started: intakes.length,
      confirmed: intakes.filter((i) => ["confirmed", "building", "done"].includes(i.status)).length,
      abandoned: intakes.filter((i) => i.status === "abandoned").length,
    },
    spend: {
      window_usd: Math.round(spendWindow * 100) / 100, month_usd: Math.round(spendMonth * 100) / 100,
      cap_usd: g.cap || null,
      per_shipped_usd: shipped.length ? Math.round((spendWindow / shipped.length) * 100) / 100 : null,
    },
  };
}

// Pure: rows in, numbers out. bundle = { companies, feedback, proposals (with
// company), runs, record, intakes, spend: { [slug]: { window, month } },
// instance_cap }.
function compute(bundle, { now = new Date(), windowDays = 30 } = {}) {
  const by = (rows, slug) => rows.filter((r) => r.company === slug);
  const companies = bundle.companies.map((c) => {
    const sp = (bundle.spend || {})[c.slug] || {};
    const g = { feedback: by(bundle.feedback, c.slug), proposals: by(bundle.proposals, c.slug), runs: by(bundle.runs, c.slug), record: by(bundle.record, c.slug), intakes: by(bundle.intakes, c.slug), spend_window: sp.window, spend_month: sp.month, cap: Number(c.monthly_cap_usd) > 0 ? Number(c.monthly_cap_usd) : null };
    return { slug: c.slug, name: c.name, ...metrics(g, now, windowDays) };
  });
  const all = Object.values(bundle.spend || {});
  const fleet = metrics({ feedback: bundle.feedback, proposals: bundle.proposals, runs: bundle.runs, record: bundle.record, intakes: bundle.intakes,
    spend_window: all.reduce((n, s) => n + Number(s.window || 0), 0), spend_month: all.reduce((n, s) => n + Number(s.month || 0), 0), cap: bundle.instance_cap || null }, now, windowDays);
  return { window_days: windowDays, as_of: (now instanceof Date ? now : new Date(now)).toISOString(), same_shift_hours: SAME_SHIFT_HOURS, fleet, companies };
}

// Spend per company since a moment: the same five sources monthlySpend adds
// up, grouped by company.
async function spendSince(since) {
  const rows = (await q(`
    SELECT company, SUM(usd)::numeric AS usd FROM (
      SELECT company, cost_usd AS usd FROM platform.build_runs WHERE created_at >= $1
      UNION ALL SELECT f.company, p.cost_usd FROM platform.proposals p JOIN platform.feedback f ON f.id=p.feedback_id WHERE p.created_at >= $1
      UNION ALL SELECT company, cost_usd FROM platform.reviews WHERE created_at >= $1
      UNION ALL SELECT slug, (brand->>'cost_usd')::numeric FROM platform.companies WHERE brand IS NOT NULL AND (brand->>'built_at')::timestamptz >= $1
      UNION ALL SELECT company, cost_usd FROM platform.ai_usage WHERE created_at >= $1
    ) s GROUP BY company`, [since])).rows;
  const out = {}; for (const r of rows) out[r.company] = Number(r.usd || 0); return out;
}

async function load(windowDays) {
  const now = new Date();
  const since = windowDays === 0 ? new Date(0) : new Date(now.getTime() - windowDays * DAY);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const companies = (await q("SELECT slug, name, monthly_cap_usd FROM platform.companies ORDER BY created_at")).rows;
  const feedback = (await q("SELECT id, company, status, created_at, outcome, person_id, follow_up_of, shipped_at, floor_answer, floor_answer_at, manager_answer, manager_answer_at FROM platform.feedback")).rows;
  const proposals = (await q("SELECT p.id, p.feedback_id, f.company, p.status, p.created_at, p.data_check->>'status' AS data_status FROM platform.proposals p JOIN platform.feedback f ON f.id=p.feedback_id")).rows;
  const runs = (await q("SELECT id, company, module, lane, status, step, model, proposal_id, proposal_ids, created_at, evidence, log FROM platform.build_runs ORDER BY id DESC LIMIT 5000")).rows;
  const record = (await q("SELECT company, kind, proposal_id, created_at FROM platform.record WHERE kind IN ('proposal_edited','proposal_approved','proposal_declined') ORDER BY id")).rows;
  const intakes = (await q("SELECT company, status, created_at FROM platform.module_intakes")).rows;
  const [w, m] = await Promise.all([spendSince(since), spendSince(monthStart)]);
  const spend = {}; for (const c of companies) spend[c.slug] = { window: w[c.slug] || 0, month: m[c.slug] || 0 };
  return { companies, feedback, proposals, runs, record, intakes, spend, instance_cap: agent.MONTHLY_CAP_USD || null, now };
}

async function forAdmin(days) {
  const windowDays = [0, 7, 30, 90, 365].includes(Number(days)) ? Number(days) : 30;
  const bundle = await load(windowDays);
  return compute(bundle, { now: bundle.now, windowDays });
}

module.exports = { compute, metrics, runTimes, stopKind, forAdmin, load, SAME_SHIFT_HOURS };
