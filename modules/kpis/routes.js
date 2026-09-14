// Plant KPIs — module routes.
// ctx.db      this module's tables (eight weeks of daily history, seeded on first use)
// ctx.peer    read-only query on a sibling module's live tables (the line itself)
// ctx.ai.chat a plain chat call through the platform, cost recorded per company
// ctx.agentDoc the company's editable copy of JONAH.md
module.exports = function makeRouter(ctx) {
  const { express, db, requireManager, peer, agentDoc, ai } = ctx;
  const router = express.Router();
  router.use(express.json({ limit: "200kb" }));

  const STATIONS = [[1, "Kit and Crease"], [2, "Nose Folds"], [3, "Body Fold"], [4, "Wings"], [5, "Clip and Test"]];
  const DEFECT_KINDS = ["crease off center", "wing asymmetric", "torn sheet", "clip in wrong place", "wrong color"];
  const ITEMS = ["paper", "clip"];

  // ---- seed: eight working weeks, deterministic ----------------------------
  // The story in the numbers, on purpose:
  //   end demand is flat; orders arrive in weekly lumps; production orders
  //   amplify the lumps (bullwhip); the line pushes hard on Fridays and idles
  //   on Mondays (no leveling); Body Fold is the constraint and work piles up
  //   in front of it; defects climb on the push days (overburden) and come
  //   mostly from Body Fold; paper is bought in big monthly lots and clips
  //   run out three times; lead time follows work in progress; on-time
  //   delivery slides as the pile grows.
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function workingDays(n) {
    const out = [];
    const d = new Date(); d.setUTCHours(12, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - 1);
    while (out.length < n) {
      const wd = d.getUTCDay();
      if (wd >= 1 && wd <= 5) out.unshift({ day: d.toISOString().slice(0, 10), weekday: wd });
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return out;
  }
  function buildSeed() {
    const rand = rng(20260914);
    const days = workingDays(40);
    const rows = [], stationRows = [], defectRows = [], invRows = [];
    let backlog = 30, wip = [12, 18, 45, 10, 8], fg = 20, paper = 2100, clips = 420, orderBook = 0, plan = 0;
    const HOLD = [8, 12, 0, 10, 6]; // units that stay at a station overnight (nothing holds at the constraint; it never stops)
    const CAP = [190, 175, 132, 170, 180]; // units per day each station can do; Body Fold is the constraint
    let clipStockoutDays = new Set([12, 13, 27, 36]);
    days.forEach((d, i) => {
      const week = Math.floor(i / 5), wd = d.weekday;
      const demand = Math.round(118 + i * 0.35 + (rand() - 0.5) * 12);
      // distributor batches its orders: heavy Monday and Thursday
      const share = { 1: 0.42, 2: 0.08, 3: 0.12, 4: 0.30, 5: 0.08 }[wd];
      const customerOrders = Math.max(0, Math.round(demand * 5 * share + (rand() - 0.5) * 30));
      orderBook += customerOrders;
      // planning reacts to yesterday's orders with a safety add and a monthly push
      // ... and only releases work orders on Monday, Wednesday and Friday, in the lump that built up
      const prevOrders = i ? rows[i - 1].customer_orders : 120;
      const monthPush = (i % 20 === 15 || i % 20 === 16) ? 70 : 0;
      plan += prevOrders * 1.3;
      let productionOrders;
      if (wd === 1 || wd === 3 || wd === 5 || monthPush) { productionOrders = Math.round(plan + monthPush + (rand() - 0.5) * 40); plan = 0; }
      else productionOrders = 35 + Math.round(rand() * 15);
      productionOrders = Math.max(30, productionOrders);
      // the line: Monday slow start, Friday push with overtime, constrained by Body Fold
      const dayFactor = { 1: 0.78, 2: 0.98, 3: 1.0, 4: 1.02, 5: 1.22 }[wd];
      const people = wd === 5 ? 7 : 6;
      const overtime = wd === 5 ? 6 + Math.round(rand() * 4) : (productionOrders > 190 ? 2 + Math.round(rand() * 2) : Math.round(rand() * 1.2));
      const clipOut = clipStockoutDays.has(i);
      let released = Math.min(productionOrders, Math.round(CAP[0] * dayFactor));
      // flow through the stations, each capped; WIP accumulates in front of the slow one
      const out = [];
      let feed = released;
      for (let s = 0; s < 5; s++) {
        const cap = Math.round(CAP[s] * dayFactor * (1 + (rand() - 0.5) * 0.08) * (s === 4 && clipOut ? 0.55 : 1));
        const avail = wip[s] + feed;
        const done = Math.min(Math.max(0, avail - HOLD[s] - Math.round(rand() * 5)), cap);
        wip[s] = avail - done;
        out.push(done);
        feed = done;
      }
      const produced = out[4];
      // defects climb with the push and with the pile in front of Body Fold
      const strain = Math.max(0, (produced - 128) / 60) + Math.max(0, (wip[2] - 60) / 200);
      const defectRate = 0.022 + strain * 0.045 + (rand() - 0.5) * 0.006;
      const defects = Math.round(produced * defectRate);
      const good = produced - defects;
      fg += good;
      const shipped = Math.min(fg, orderBook);
      fg -= shipped; orderBook -= shipped;
      backlog = orderBook;
      const wipTotal = wip.reduce((a, b) => a + b, 0);
      const leadTime = wipTotal / Math.max(80, produced);
      const onTime = Math.max(70, Math.min(99, 99 - Math.max(0, leadTime - 0.9) * 14 - (clipOut ? 6 : 0) + (rand() - 0.5) * 2));
      // paper bought in big lots, clips in small late lots
      let purchases = 0;
      if (i === 2 || i === 22) purchases = 2400;
      else if (paper < 400) purchases = 500;
      paper += purchases - released;
      let clipsIn = 0;
      if (clipOut) clips = 0;
      else if (clips < 80) { clipsIn = 300; clips += clipsIn; }
      clips = Math.max(0, clips - produced);
      if (i === 11 || i === 26 || i === 35) clips = Math.min(clips, 25);
      const changeovers = wd === 2 || wd === 3 ? 2 + Math.round(rand() * 2) : 8 + Math.round(rand() * 5);
      rows.push({
        day: d.day, weekday: wd, demand, customer_orders: customerOrders, production_orders: productionOrders,
        produced, shipped, purchases, wip_total: wipTotal, finished_goods: fg, backlog, defects, changeovers,
        overtime_hours: overtime, lead_time_days: Number(leadTime.toFixed(2)), on_time_pct: Number(onTime.toFixed(1)), people,
      });
      // per station: Body Fold carries most of the defects and the slowest cycle
      const defShare = [0.1, 0.15, 0.5, 0.17, 0.08];
      STATIONS.forEach(([seq, name], s) => {
        const sd = Math.round(defects * defShare[s] + (rand() - 0.5));
        stationRows.push({ day: d.day, seq, station: name, wip: wip[s], output: out[s], defects: Math.max(0, sd),
          seconds_per_unit: Number((86400 * 0.28 / (CAP[s] * 1.15) * (1 + (rand() - 0.5) * 0.1) * (s === 2 ? 1.05 : 1)).toFixed(1)) });
      });
      // defect kinds: crease and wing dominate, clip errors spike on clip-out days
      const kindShare = clipOut ? [0.3, 0.25, 0.1, 0.3, 0.05] : [0.4, 0.3, 0.12, 0.1, 0.08];
      DEFECT_KINDS.forEach((kind, k) => {
        const qty = Math.round(defects * kindShare[k]);
        if (qty > 0) defectRows.push({ day: d.day, seq: k === 3 ? 5 : k === 4 ? 1 : 3, kind, qty });
      });
      invRows.push({ day: d.day, item: "paper", on_hand: Math.max(0, paper), received: purchases, stockout: paper <= 0 ? 1 : 0 });
      invRows.push({ day: d.day, item: "clip", on_hand: clips, received: clipsIn, stockout: clipOut ? 1 : 0 });
    });
    return { rows, stationRows, defectRows, invRows };
  }

  async function ensureSeed() {
    const n = Number((await db("SELECT count(*)::int AS n FROM daily")).rows[0].n);
    if (n) return;
    const { rows, stationRows, defectRows, invRows } = buildSeed();
    for (const r of rows) {
      await db(`INSERT INTO daily (day, weekday, demand, customer_orders, production_orders, produced, shipped, purchases, wip_total, finished_goods, backlog, defects, changeovers, overtime_hours, lead_time_days, on_time_pct, people)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [r.day, r.weekday, r.demand, r.customer_orders, r.production_orders, r.produced, r.shipped, r.purchases, r.wip_total, r.finished_goods, r.backlog, r.defects, r.changeovers, r.overtime_hours, r.lead_time_days, r.on_time_pct, r.people]);
    }
    for (const r of stationRows) await db("INSERT INTO station_daily (day, seq, station, wip, output, defects, seconds_per_unit) VALUES ($1,$2,$3,$4,$5,$6,$7)", [r.day, r.seq, r.station, r.wip, r.output, r.defects, r.seconds_per_unit]);
    for (const r of defectRows) await db("INSERT INTO defect_daily (day, seq, kind, qty) VALUES ($1,$2,$3,$4)", [r.day, r.seq, r.kind, r.qty]);
    for (const r of invRows) await db("INSERT INTO inventory_daily (day, item, on_hand, received, stockout) VALUES ($1,$2,$3,$4,$5)", [r.day, r.item, r.on_hand, r.received, r.stockout]);
  }

  // ---- live fold-in: today on the real line ---------------------------------
  async function liveLine() {
    const line = peer && peer("paperline");
    if (!line) return null;
    try {
      const shifts = (await line("SELECT id, number, started_at, ended_at, released, completed, scrapped, avg_distance, stockouts, wip_end FROM shifts WHERE started_at::date = current_date ORDER BY id")).rows;
      const open = shifts.find((s) => !s.ended_at) || null;
      const wip = (await line(`SELECT s.seq, s.name, count(t.id)::int AS wip FROM stations s
        LEFT JOIN travelers t ON t.station_id = s.id AND t.state NOT IN ('done','scrap') GROUP BY s.seq, s.name ORDER BY s.seq`)).rows;
      const done = shifts.reduce((a, s) => a + Number(s.completed || 0), 0);
      const scrap = shifts.reduce((a, s) => a + Number(s.scrapped || 0), 0);
      const stockouts = shifts.reduce((a, s) => a + Number(s.stockouts || 0), 0);
      const openReq = (await line("SELECT count(*)::int AS n FROM material_requests WHERE status='open'")).rows[0].n;
      return { source: "paperline", shifts: shifts.length, running: Boolean(open), completed: done, scrapped: scrap, stockouts, open_requests: openReq,
        avg_distance: shifts.length ? Number((shifts.reduce((a, s) => a + Number(s.avg_distance || 0), 0) / shifts.length).toFixed(1)) : null,
        wip, wip_total: wip.reduce((a, w) => a + w.wip, 0) };
    } catch (e) { return { source: "paperline", error: e.message }; }
  }

  // ---- numbers ---------------------------------------------------------------
  const cv = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length; return m ? Math.sqrt(v) / m : 0; };
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const avg = (xs) => (xs.length ? sum(xs) / xs.length : 0);

  async function kpis() {
    await ensureSeed();
    const D = "to_char(day, 'YYYY-MM-DD') AS day_s";
    const daily = (await db(`SELECT *, ${D} FROM daily ORDER BY day`)).rows.map((r) => ({ ...r, overtime_hours: Number(r.overtime_hours), lead_time_days: Number(r.lead_time_days), on_time_pct: Number(r.on_time_pct), day: r.day_s }));
    const stations = (await db(`SELECT *, ${D} FROM station_daily ORDER BY day, seq`)).rows.map((r) => ({ ...r, seconds_per_unit: Number(r.seconds_per_unit), day: r.day_s }));
    const defects = (await db("SELECT kind, seq, sum(qty)::int AS qty FROM defect_daily GROUP BY kind, seq ORDER BY qty DESC")).rows;
    const inventory = (await db(`SELECT *, ${D} FROM inventory_daily ORDER BY day, item`)).rows.map((r) => ({ ...r, day: r.day_s }));
    const last = daily.slice(-5), prev = daily.slice(-10, -5);
    const rate = (rows) => (sum(rows.map((r) => r.produced)) ? sum(rows.map((r) => r.defects)) / sum(rows.map((r) => r.produced)) : 0);
    const week = (rows) => ({
      output_per_day: avg(rows.map((r) => r.produced)), demand_per_day: avg(rows.map((r) => r.demand)),
      fpy: 1 - rate(rows), lead_time: avg(rows.map((r) => r.lead_time_days)), on_time: avg(rows.map((r) => r.on_time_pct)),
      wip: avg(rows.map((r) => r.wip_total)), overtime: sum(rows.map((r) => r.overtime_hours)), backlog: rows[rows.length - 1].backlog,
      changeovers: avg(rows.map((r) => r.changeovers)),
    });
    const byStation = STATIONS.map(([seq, name]) => {
      const rows = stations.filter((s) => s.seq === seq);
      const recent = rows.slice(-5);
      return { seq, name, wip_avg: avg(rows.map((r) => r.wip)), wip_now: rows[rows.length - 1].wip, output_avg: avg(rows.map((r) => r.output)),
        defects: sum(rows.map((r) => r.defects)), seconds_per_unit: avg(recent.map((r) => r.seconds_per_unit)) };
    });
    const constraint = [...byStation].sort((a, b) => b.wip_avg - a.wip_avg)[0];
    const paper = inventory.filter((i) => i.item === "paper"), clip = inventory.filter((i) => i.item === "clip");
    const flags = [];
    const bull = { demand: cv(daily.map((r) => r.demand)), customer_orders: cv(daily.map((r) => r.customer_orders)), production_orders: cv(daily.map((r) => r.production_orders)), purchases: cv(daily.map((r) => r.purchases)) };
    if (bull.production_orders > bull.demand * 2) flags.push(`Bullwhip: day-to-day swing of production orders is ${(bull.production_orders / bull.demand).toFixed(1)}x the swing of end demand (orders ${(bull.customer_orders / bull.demand).toFixed(1)}x).`);
    const byWd = [1, 2, 3, 4, 5].map((wd) => avg(daily.filter((r) => r.weekday === wd).map((r) => r.produced)));
    if (byWd[4] > byWd[0] * 1.3) flags.push(`Unlevel week: Friday output averages ${byWd[4].toFixed(0)} against ${byWd[0].toFixed(0)} on Monday, with ${avg(daily.filter((r) => r.weekday === 5).map((r) => r.overtime_hours)).toFixed(1)} h overtime on Fridays.`);
    if (constraint) flags.push(`Constraint: ${constraint.name} carries ${constraint.wip_avg.toFixed(0)} units of work in progress on average (next highest ${[...byStation].sort((a, b) => b.wip_avg - a.wip_avg)[1].wip_avg.toFixed(0)}) and ${(constraint.defects / Math.max(1, sum(byStation.map((s) => s.defects))) * 100).toFixed(0)}% of defects.`);
    const hi = daily.filter((r) => r.produced > 140), lo = daily.filter((r) => r.produced <= 140);
    if (hi.length && rate(hi) > rate(lo) * 1.4) flags.push(`Overburden: defect rate is ${(rate(hi) * 100).toFixed(1)}% on days above 140 units against ${(rate(lo) * 100).toFixed(1)}% on the rest.`);
    const clipOuts = clip.filter((i) => i.stockout).length;
    if (clipOuts) flags.push(`Supply: clips ran out on ${clipOuts} days; paper arrives in lots of 2400 against use of about ${avg(daily.map((r) => r.produced)).toFixed(0)} a day (${(2400 / avg(daily.map((r) => r.produced))).toFixed(0)} days of stock per lot).`);
    const w = week(last), p = week(prev);
    if (w.on_time < p.on_time - 1) flags.push(`On-time delivery slid from ${p.on_time.toFixed(0)}% to ${w.on_time.toFixed(0)}% as lead time went from ${p.lead_time.toFixed(1)} to ${w.lead_time.toFixed(1)} days.`);
    return { daily, stations, byStation, defects, inventory: { paper, clip }, thisWeek: w, lastWeek: p, bullwhip: bull, byWeekday: byWd, flags, constraint: constraint ? constraint.name : null, live: await liveLine(), generated_at: new Date().toISOString() };
  }

  router.get("/api/kpis", async (_req, res) => {
    try { res.json(await kpis()); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Jonah -----------------------------------------------------------------
  // The digest is what Jonah reads: weekly table, stations, flags, live line.
  // A few thousand characters, so each answer costs cents, not dollars.
  function digest(k) {
    const weeks = [];
    for (let i = 0; i < k.daily.length; i += 5) {
      const rows = k.daily.slice(i, i + 5);
      const r = (xs) => avg(xs).toFixed(0);
      weeks.push(`W${weeks.length + 1} (${rows[0].day} to ${rows[rows.length - 1].day}): demand ${r(rows.map((x) => x.demand))}/d, cust orders ${r(rows.map((x) => x.customer_orders))}/d, prod orders ${r(rows.map((x) => x.production_orders))}/d, produced ${r(rows.map((x) => x.produced))}/d, shipped ${r(rows.map((x) => x.shipped))}/d, WIP ${r(rows.map((x) => x.wip_total))}, backlog end ${rows[rows.length - 1].backlog}, defects ${(sum(rows.map((x) => x.defects)) / Math.max(1, sum(rows.map((x) => x.produced))) * 100).toFixed(1)}%, lead ${avg(rows.map((x) => x.lead_time_days)).toFixed(2)} d, OTD ${avg(rows.map((x) => x.on_time_pct)).toFixed(0)}%, overtime ${sum(rows.map((x) => x.overtime_hours)).toFixed(0)} h, changeovers ${r(rows.map((x) => x.changeovers))}/d`);
    }
    const last10 = k.daily.slice(-10).map((x) => `${x.day} ${["", "Mon", "Tue", "Wed", "Thu", "Fri"][x.weekday]}: demand ${x.demand}, orders ${x.customer_orders}, prod orders ${x.production_orders}, produced ${x.produced}, shipped ${x.shipped}, WIP ${x.wip_total}, defects ${x.defects}, OT ${x.overtime_hours} h, lead ${x.lead_time_days} d, OTD ${x.on_time_pct}%, changeovers ${x.changeovers}`);
    const st = k.byStation.map((s) => `${s.seq}. ${s.name}: WIP avg ${s.wip_avg.toFixed(0)} (now ${s.wip_now}), output avg ${s.output_avg.toFixed(0)}/d, defects ${s.defects}, ${s.seconds_per_unit.toFixed(0)} s/unit`);
    const def = k.defects.map((d) => `${d.kind} (station ${d.seq}): ${d.qty}`);
    const inv = `paper on hand now ${k.inventory.paper[k.inventory.paper.length - 1].on_hand} sheets, received in lots on ${k.inventory.paper.filter((p) => p.received).map((p) => `${p.day} (${p.received})`).join(", ")}; clip stockout days: ${k.inventory.clip.filter((c) => c.stockout).map((c) => c.day).join(", ") || "none"}`;
    const wd = `average output by weekday Mon..Fri: ${k.byWeekday.map((x) => x.toFixed(0)).join(", ")}`;
    const cvs = `coefficient of variation: demand ${k.bullwhip.demand.toFixed(2)}, customer orders ${k.bullwhip.customer_orders.toFixed(2)}, production orders ${k.bullwhip.production_orders.toFixed(2)}, purchases ${k.bullwhip.purchases.toFixed(2)}`;
    const live = k.live && !k.live.error
      ? `Live from the line today (real data from the Paper Airplane Line module): ${k.live.shifts} shift(s) run, ${k.live.running ? "one running now" : "none running now"}, completed ${k.live.completed}, scrapped ${k.live.scrapped}, stockouts ${k.live.stockouts}, open material requests ${k.live.open_requests}, WIP by station ${k.live.wip.map((w) => `${w.name} ${w.wip}`).join(", ")}`
      : "Live line: not connected today.";
    return `PLANT DATA DIGEST (eight working weeks, units are paper airplanes; 5 stations in sequence; 6 people, 7 on Fridays)\n\nWeekly:\n${weeks.join("\n")}\n\nLast ten days:\n${last10.join("\n")}\n\nStations (in flow order):\n${st.join("\n")}\n\nDefects by kind over the period:\n${def.join("; ")}\n\nInventory: ${inv}\n\n${wd}\n${cvs}\n\nPlatform flags (computed, check them against the numbers):\n${k.flags.map((f) => "- " + f).join("\n")}\n\n${live}`;
  }

  router.get("/api/chats", requireManager, async (_req, res) => {
    const rows = (await db("SELECT id, title, model, cost_usd, created_at, last_at, jsonb_array_length(messages) AS n FROM chats ORDER BY last_at DESC LIMIT 20")).rows;
    res.json({ chats: rows, models: ai.models, defaultModel: await ai.modelFor("propose") });
  });
  router.get("/api/chats/:id", requireManager, async (req, res) => {
    const row = (await db("SELECT * FROM chats WHERE id=$1", [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: "no such chat" });
    res.json(row);
  });
  router.post("/api/chats", requireManager, async (req, res) => {
    const { chat_id, message, model, chart } = req.body || {};
    const text = String(message || "").trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: "say something" });
    try {
      const k = await kpis();
      let row = chat_id ? (await db("SELECT * FROM chats WHERE id=$1", [chat_id])).rows[0] : null;
      const messages = row ? row.messages : [];
      const userText = chart ? `[Looking at the chart "${String(chart).slice(0, 80)}"] ${text}` : text;
      messages.push({ role: "user", content: userText, at: new Date().toISOString() });
      const persona = (await agentDoc("JONAH.md")) || "You are Jonah, an operations advisor.";
      const system = `${persona}\n\n---\n\n${digest(k)}`;
      const out = await ai.chat({
        model, system, maxTokens: 1400, kind: "chat", detail: { agent: "jonah", chat_id: row ? row.id : null },
        messages: messages.slice(-12).map((m) => ({ role: m.role, content: m.content })),
      });
      messages.push({ role: "assistant", content: out.text, at: new Date().toISOString(), model: out.model, cost_usd: Number(out.costUsd.toFixed(4)) });
      if (row) {
        await db("UPDATE chats SET messages=$2, cost_usd=cost_usd+$3, model=$4, last_at=now() WHERE id=$1", [row.id, JSON.stringify(messages), out.costUsd, out.model]);
      } else {
        row = (await db("INSERT INTO chats (title, model, messages, cost_usd) VALUES ($1,$2,$3,$4) RETURNING *", [text.slice(0, 80), out.model, JSON.stringify(messages), out.costUsd])).rows[0];
      }
      res.json({ chat_id: row.id, reply: out.text, model: out.model, cost_usd: Number(out.costUsd.toFixed(4)), messages });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.delete("/api/chats/:id", requireManager, async (req, res) => {
    await db("DELETE FROM chats WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  });

  // reset the seeded history (manager), for demos that want a fresh eight weeks ending yesterday
  router.post("/api/reseed", requireManager, async (_req, res) => {
    for (const t of ["daily", "station_daily", "defect_daily", "inventory_daily"]) await db(`DELETE FROM ${t}`);
    await ensureSeed();
    res.json({ ok: true });
  });

  return router;
};
