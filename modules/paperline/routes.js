// Paper Airplane Line — module routes.
// ctx.db is a query function pinned to this module's schema.
// ctx.requireManager gates shift controls and settings.
module.exports = function makeRouter(ctx) {
  const { express, db, requireManager } = ctx;
  const router = express.Router();
  router.use(express.json());

  const COLORS = ["white", "blue", "yellow"];
  const FOLDS = ["dart", "glider"];
  const CLIPS = ["none", "nose", "middle"];
  const ITEMS = ["paper_white", "paper_blue", "paper_yellow", "clip"];

  // weighted product mix: mostly white darts with a nose clip, plus enough
  // variety that the line has to think
  function pick(weights) {
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (const [k, w] of Object.entries(weights)) { r -= w; if (r <= 0) return k; }
    return Object.keys(weights)[0];
  }
  const MIX = {
    color: { white: 5, blue: 3, yellow: 2 },
    fold: { dart: 6, glider: 4 },
    clip: { nose: 4, none: 4, middle: 2 },
  };

  async function setting(key, def) {
    const r = (await db("SELECT value FROM settings WHERE key=$1", [key])).rows[0];
    return r ? r.value : def;
  }
  async function stations() {
    return (await db("SELECT * FROM stations ORDER BY seq")).rows;
  }
  async function currentShift() {
    return (await db("SELECT * FROM shifts WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1")).rows[0] || null;
  }

  // Close a shift whose clock ran out. Called lazily on every request, so the
  // board's polling closes it within a few seconds of the end time.
  async function tick() {
    const s = await currentShift();
    if (s && new Date(s.ends_at) <= new Date()) await closeShift(s);
  }

  async function closeShift(s) {
    const done = (await db(
      "SELECT state, distance_ft FROM travelers WHERE done_shift_id=$1", [s.id])).rows;
    const completed = done.filter((t) => t.state === "done");
    const scrapped = done.filter((t) => t.state === "scrap").length;
    const dist = completed.map((t) => Number(t.distance_ft)).filter((n) => !isNaN(n));
    const avg = dist.length ? dist.reduce((a, b) => a + b, 0) / dist.length : null;
    const wip = (await db("SELECT count(*)::int AS n FROM travelers WHERE state IN ('queued','at_station')")).rows[0].n;
    const stockouts = (await db("SELECT count(*)::int AS n FROM traveler_log WHERE shift_id=$1 AND event='stockout'", [s.id])).rows[0].n;
    const perStation = (await db(
      `SELECT st.seq, st.name, count(l.id)::int AS completed, round(avg(l.seconds))::int AS avg_seconds
         FROM stations st LEFT JOIN traveler_log l ON l.station_id=st.id AND l.shift_id=$1 AND l.event='completed'
        GROUP BY st.seq, st.name ORDER BY st.seq`, [s.id])).rows;
    const wipByStation = (await db(
      `SELECT st.seq, count(t.id)::int AS wip FROM stations st
         LEFT JOIN travelers t ON t.station_id=st.id AND t.state='at_station' GROUP BY st.seq ORDER BY st.seq`)).rows;
    const summary = { stations: perStation.map((p) => ({ ...p, wip_end: (wipByStation.find((w) => w.seq === p.seq) || {}).wip || 0 })) };
    await db(
      `UPDATE shifts SET ended_at=now(), completed=$2, scrapped=$3, avg_distance=$4, stockouts=$5, wip_end=$6, summary=$7 WHERE id=$1`,
      [s.id, completed.length, scrapped, avg, stockouts, wip, JSON.stringify(summary)]);
  }

  // ---- overview (manager board) -------------------------------------------
  router.get("/api/state", async (_req, res) => {
    await tick();
    const shift = await currentShift();
    const sts = await stations();
    const travelers = (await db(
      "SELECT * FROM travelers WHERE state IN ('queued','at_station') ORDER BY released_at, id")).rows;
    const shiftStats = shift ? (await db(
      `SELECT count(*) FILTER (WHERE state='done')::int AS completed,
              count(*) FILTER (WHERE state='scrap')::int AS scrapped,
              round(avg(distance_ft) FILTER (WHERE state='done'), 1) AS avg_distance
         FROM travelers WHERE done_shift_id=$1`, [shift.id])).rows[0] : null;
    const history = (await db("SELECT * FROM shifts WHERE ended_at IS NOT NULL ORDER BY number DESC LIMIT 12")).rows;
    const openRequests = (await db("SELECT count(*)::int AS n FROM material_requests WHERE status='open'")).rows[0].n;
    const line = (await db("SELECT item, qty FROM inventory WHERE location='line' ORDER BY id")).rows;
    res.json({
      now: new Date().toISOString(),
      shift, shiftStats, stations: sts, travelers, history, openRequests, line,
      settings: { shift_seconds: Number(await setting("shift_seconds", 120)), release_per_shift: Number(await setting("release_per_shift", 10)) },
    });
  });

  router.post("/api/settings", requireManager, async (req, res) => {
    const { shift_seconds, release_per_shift } = req.body || {};
    if (shift_seconds) await db("UPDATE settings SET value=$2 WHERE key=$1", ["shift_seconds", String(Math.max(30, Number(shift_seconds)))]);
    if (release_per_shift) await db("UPDATE settings SET value=$2 WHERE key=$1", ["release_per_shift", String(Math.max(1, Number(release_per_shift)))]);
    res.json({ ok: true });
  });

  // ---- shifts --------------------------------------------------------------
  router.post("/api/shift/start", requireManager, async (_req, res) => {
    await tick();
    if (await currentShift()) return res.status(409).json({ error: "a shift is already running" });
    const seconds = Number(await setting("shift_seconds", 120));
    const n = Number(await setting("release_per_shift", 10));
    const number = (await db("SELECT COALESCE(MAX(number),0)+1 AS n FROM shifts")).rows[0].n;
    const shift = (await db(
      "INSERT INTO shifts (number, ends_at, released) VALUES ($1, now() + ($2 || ' seconds')::interval, $3) RETURNING *",
      [number, String(seconds), n])).rows[0];
    const first = (await stations())[0];
    // release the whole shift's demand at once onto station 1
    for (let i = 1; i <= n; i++) {
      const job = `S${number}-${String(i).padStart(2, "0")}`;
      const t = (await db(
        `INSERT INTO travelers (job_num, shift_id, color, fold_type, clip_pos, station_id, state, arrived_at)
         VALUES ($1,$2,$3,$4,$5,$6,'at_station',now()) RETURNING id`,
        [job, shift.id, pick(MIX.color), pick(MIX.fold), pick(MIX.clip), first.id])).rows[0];
      await db("INSERT INTO traveler_log (traveler_id, station_id, shift_id, event) VALUES ($1,$2,$3,'arrived')", [t.id, first.id, shift.id]);
    }
    res.json({ ok: true, shift });
  });

  router.post("/api/shift/end", requireManager, async (_req, res) => {
    const s = await currentShift();
    if (!s) return res.status(409).json({ error: "no shift running" });
    await closeShift(s);
    res.json({ ok: true });
  });

  // ---- station view ----------------------------------------------------------
  router.get("/api/station/:seq", async (req, res) => {
    await tick();
    const st = (await db("SELECT * FROM stations WHERE seq=$1", [req.params.seq])).rows[0];
    if (!st) return res.status(404).json({ error: "no such station" });
    const shift = await currentShift();
    const queue = (await db(
      "SELECT * FROM travelers WHERE station_id=$1 AND state='at_station' ORDER BY arrived_at, id", [st.id])).rows;
    const line = (await db("SELECT item, qty FROM inventory WHERE location='line' ORDER BY id")).rows;
    const requests = (await db(
      "SELECT * FROM material_requests WHERE station_id=$1 AND status='open' ORDER BY id", [st.id])).rows;
    const count = (await db("SELECT count(*)::int AS n FROM stations")).rows[0].n;
    res.json({ now: new Date().toISOString(), station: st, isLast: st.seq === count, shift, queue, line, requests });
  });

  router.post("/api/stations/:id/status", async (req, res) => {
    const { status } = req.body || {};
    if (!["running", "blocked", "down"].includes(status)) {
      return res.status(400).json({ error: "status must be running, blocked, or down" });
    }
    const r = await db("UPDATE stations SET status=$2 WHERE id=$1 RETURNING *", [req.params.id, status]);
    res.json(r.rows[0]);
  });

  // Operator finished the step at their station: consume material, move the
  // traveler to the next station, or close it out at the last one.
  router.post("/api/travelers/:id/complete", async (req, res) => {
    await tick();
    const shift = await currentShift();
    if (!shift) return res.status(409).json({ error: "The shift is not running. Wait for the manager to start the next one." });
    const t = (await db("SELECT * FROM travelers WHERE id=$1", [req.params.id])).rows[0];
    if (!t || t.state !== "at_station") return res.status(409).json({ error: "that traveler is not at a station" });
    const sts = await stations();
    const idx = sts.findIndex((s) => s.id === t.station_id);
    const here = sts[idx];
    const operator = String((req.body || {}).operator || "").slice(0, 60) || null;

    async function consume(item, label) {
      const inv = (await db("SELECT * FROM inventory WHERE item=$1 AND location='line'", [item])).rows[0];
      if (!inv || inv.qty <= 0) {
        await db("INSERT INTO traveler_log (traveler_id, station_id, shift_id, event, operator) VALUES ($1,$2,$3,'stockout',$4)", [t.id, here.id, shift.id, operator]);
        return `No ${label} at the line. Request it from the stockroom.`;
      }
      await db("UPDATE inventory SET qty = qty - 1 WHERE id=$1", [inv.id]);
      return null;
    }

    if (idx === 0) {
      const err = await consume(`paper_${t.color}`, `${t.color} paper`);
      if (err) return res.status(409).json({ error: err });
    }
    const seconds = t.arrived_at ? Math.round((Date.now() - new Date(t.arrived_at)) / 1000) : null;

    if (idx === sts.length - 1) {
      const { distance_ft, qc } = req.body || {};
      const d = Number(distance_ft);
      if (!(d >= 0)) return res.status(400).json({ error: "enter the distance first" });
      if (!["pass", "scrap"].includes(qc)) return res.status(400).json({ error: "pass or scrap?" });
      if (t.clip_pos !== "none") {
        const err = await consume("clip", "paper clips");
        if (err) return res.status(409).json({ error: err });
      }
      await db(
        "UPDATE travelers SET state=$2, done_at=now(), done_shift_id=$3, distance_ft=$4, qc=$5 WHERE id=$1",
        [t.id, qc === "pass" ? "done" : "scrap", shift.id, d, qc]);
      await db("INSERT INTO traveler_log (traveler_id, station_id, shift_id, event, operator, seconds) VALUES ($1,$2,$3,$4,$5,$6)",
        [t.id, here.id, shift.id, qc === "pass" ? "completed" : "scrapped", operator, seconds]);
      return res.json({ ok: true, finished: true });
    }

    const next = sts[idx + 1];
    await db("UPDATE travelers SET station_id=$2, arrived_at=now() WHERE id=$1", [t.id, next.id]);
    await db("INSERT INTO traveler_log (traveler_id, station_id, shift_id, event, operator, seconds) VALUES ($1,$2,$3,'completed',$4,$5)",
      [t.id, here.id, shift.id, operator, seconds]);
    await db("INSERT INTO traveler_log (traveler_id, station_id, shift_id, event) VALUES ($1,$2,$3,'arrived')", [t.id, next.id, shift.id]);
    res.json({ ok: true, next: next.name });
  });

  // ---- materials -------------------------------------------------------------
  router.get("/api/stock", async (_req, res) => {
    await tick();
    const inventory = (await db("SELECT * FROM inventory ORDER BY location DESC, id")).rows;
    const requests = (await db(
      `SELECT r.*, s.name AS station_name, s.seq AS station_seq FROM material_requests r
         LEFT JOIN stations s ON s.id=r.station_id
        WHERE r.status='open' ORDER BY r.id DESC`)).rows;
    const delivered = (await db(
      `SELECT r.*, s.name AS station_name FROM material_requests r LEFT JOIN stations s ON s.id=r.station_id
        WHERE r.status='delivered' ORDER BY r.delivered_at DESC LIMIT 15`)).rows;
    res.json({ inventory, requests, delivered });
  });

  router.post("/api/requests", async (req, res) => {
    const { station_id, item, requested_by } = req.body || {};
    if (!ITEMS.includes(item)) return res.status(400).json({ error: "unknown item" });
    const r = await db(
      "INSERT INTO material_requests (station_id, item, qty, requested_by) VALUES ($1,$2,1,$3) RETURNING *",
      [station_id || null, item, (requested_by || "").slice(0, 60) || null]);
    res.json(r.rows[0]);
  });

  router.post("/api/requests/:id/deliver", async (req, res) => {
    const r = (await db("SELECT * FROM material_requests WHERE id=$1 AND status='open'", [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: "request not open" });
    const stock = (await db("SELECT * FROM inventory WHERE item=$1 AND location='stock'", [r.item])).rows[0];
    if (!stock || stock.qty < r.qty) return res.status(409).json({ error: "not enough in the stockroom" });
    await db("UPDATE inventory SET qty = qty - $2 WHERE id=$1", [stock.id, r.qty]);
    await db("UPDATE inventory SET qty = qty + $2 WHERE item=$1 AND location='line'", [r.item, r.qty]);
    await db("UPDATE material_requests SET status='delivered', delivered_at=now() WHERE id=$1", [r.id]);
    res.json({ ok: true });
  });

  // ---- reset (manager): clears travelers, shifts, requests; restocks the line
  router.post("/api/reset", requireManager, async (_req, res) => {
    await db("DELETE FROM traveler_log");
    await db("DELETE FROM travelers");
    await db("DELETE FROM material_requests");
    await db("DELETE FROM shifts");
    await db("UPDATE inventory SET qty = CASE item WHEN 'paper_white' THEN 4 WHEN 'paper_blue' THEN 1 WHEN 'paper_yellow' THEN 2 ELSE 3 END WHERE location='line'");
    await db("UPDATE inventory SET qty = CASE item WHEN 'paper_white' THEN 60 WHEN 'clip' THEN 50 ELSE 40 END WHERE location='stock'");
    res.json({ ok: true });
  });

  return router;
};
