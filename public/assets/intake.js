// Module creation popout (docs/MODULE-CREATION.md, "The intake popout").
// One popout serves the fixed questions, Fable's generated rounds and the
// design gate. Opened from the request card on the board. Every answer saves
// as it is given; closing at any point is safe. Platform code: the in-app
// build agent never touches this file.
window.Intake = (() => {
  const SLUG = location.pathname.split("/")[2];
  let ID = null, V = null, IDX = 0, POLL = null, SAVE = null, ROOT = null, ERR = "", MODE = "q", EDITING = false, CHECKS = new Set();

  const CSS = `
  .ik-back { position:fixed; inset:0; background:rgba(28,36,46,.6); z-index:20000; display:flex; align-items:center; justify-content:center; padding:18px; }
  .ik-box { background:#fff; color:var(--ink,#1c242e); border-radius:14px; width:100%; max-width:760px; max-height:calc(100vh - 36px); display:flex; flex-direction:column; box-shadow:0 12px 40px rgba(0,0,0,.35); font-size:14px; }
  .ik-head { display:flex; align-items:center; gap:12px; padding:12px 18px; border-bottom:1px solid var(--line,#d5dbe3); }
  .ik-head .ik-round { font-size:11.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--steel,#51606f); font-weight:800; }
  .ik-head .ik-title { font-weight:800; font-size:15px; flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ik-head .ik-prog { font-size:12.5px; color:var(--steel,#51606f); white-space:nowrap; }
  .ik-head .ik-x { border:1px solid var(--line,#d5dbe3); background:#fff; color:var(--ink,#1c242e); border-radius:8px; padding:6px 10px; font-weight:700; cursor:pointer; margin:0; min-height:0; font-size:12.5px; }
  .ik-bar { height:4px; background:var(--fog,#f2f4f7); } .ik-bar i { display:block; height:4px; background:var(--green,#2e7d4f); transition:width .3s; }
  .ik-body { padding:18px; overflow:auto; flex:1 1 auto; }
  .ik-q { font-size:19px; font-weight:800; line-height:1.3; margin-bottom:6px; }
  .ik-hint { color:var(--steel,#51606f); font-size:13px; line-height:1.45; margin-bottom:14px; }
  .ik-why { background:var(--tealSoft,#e3f2f1); color:var(--teal,#0e8a86); border-radius:8px; padding:8px 10px; font-size:13px; margin-bottom:14px; }
  .ik-chips { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; }
  .ik-chip { border:1.5px solid var(--line,#d5dbe3); background:#fff; color:var(--ink,#1c242e); border-radius:20px; padding:9px 14px; font-size:13.5px; font-weight:600; cursor:pointer; margin:0; min-height:0; }
  .ik-chip.on { background:var(--navy,#1f3a5f); border-color:var(--navy,#1f3a5f); color:#fff; }
  .ik-box textarea, .ik-box input[type=text], .ik-box input[type=number] { width:100%; font-family:inherit; font-size:14px; border:1px solid var(--line,#d5dbe3); border-radius:8px; padding:9px 10px; }
  .ik-box textarea { min-height:96px; }
  .ik-sub { font-size:12.5px; color:var(--steel,#51606f); margin:10px 0 4px; font-weight:700; }
  .ik-row { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
  .ik-row input[type=text] { flex:1 1 auto; }
  .ik-row .ik-n { width:34px; font-weight:800; color:var(--steel,#51606f); text-align:right; }
  .ik-row button { border:1px solid var(--line,#d5dbe3); background:#f6f8fa; color:var(--ink,#1c242e); border-radius:7px; padding:6px 9px; font-size:12px; font-weight:700; cursor:pointer; margin:0; min-height:0; }
  .ik-row button:disabled { opacity:.35; }
  .ik-add { border:1px dashed var(--line,#d5dbe3); background:#fff; color:var(--navy,#1f3a5f); border-radius:8px; padding:8px 12px; font-weight:700; cursor:pointer; margin:0 0 8px; min-height:0; font-size:13px; }
  .ik-grp { border:1px solid var(--line,#d5dbe3); border-radius:10px; padding:10px 12px; margin-bottom:10px; }
  .ik-grp b { display:block; margin-bottom:6px; }
  .ik-grp input[type=number] { width:110px; }
  .ik-files { margin-top:10px; }
  .ik-file { display:flex; gap:10px; align-items:center; border:1px solid var(--line,#d5dbe3); border-radius:8px; padding:6px 10px; margin-bottom:6px; font-size:13px; }
  .ik-file img { width:44px; height:44px; object-fit:cover; border-radius:6px; }
  .ik-file .ik-meta { color:var(--steel,#51606f); font-size:12px; flex:1 1 auto; }
  .ik-file button { border:none; background:none; color:var(--red,#b3261e); font-weight:700; cursor:pointer; margin:0; min-height:0; padding:4px; }
  .ik-attach { display:inline-block; border:1px solid var(--navy,#1f3a5f); color:var(--navy,#1f3a5f); background:#fff; border-radius:8px; padding:8px 12px; font-weight:700; cursor:pointer; font-size:13px; margin:6px 0 0; }
  .ik-attach input { display:none; }
  .ik-count { font-size:11.5px; color:var(--steel,#51606f); text-align:right; margin:3px 0 6px; }
  .ik-count.full { color:var(--red,#b3261e); font-weight:700; }
  .ik-err { background:#fdeceb; color:var(--red,#b3261e); border-radius:8px; padding:8px 10px; margin-top:10px; font-size:13px; }
  .ik-foot { display:flex; gap:8px; align-items:center; padding:12px 18px; border-top:1px solid var(--line,#d5dbe3); flex-wrap:wrap; }
  .ik-foot .ik-sp { flex:1 1 auto; }
  .ik-foot button { margin:0; min-height:38px; }
  .ik-think { text-align:center; padding:40px 10px; }
  .ik-think .ik-spin { width:34px; height:34px; border:4px solid var(--amber,#c2620a); border-right-color:transparent; border-radius:50%; animation:ikspin .9s linear infinite; margin:0 auto 14px; }
  @keyframes ikspin { to { transform:rotate(360deg) } }
  .ik-bluf { font-size:17px; font-weight:800; line-height:1.35; margin-bottom:12px; }
  .ik-item { display:flex; gap:10px; align-items:flex-start; padding:8px 0; border-top:1px solid var(--line,#d5dbe3); line-height:1.4; }
  .ik-item input { width:18px; height:18px; margin-top:2px; flex:none; }
  .ik-est { background:var(--amberSoft,#fbefe0); color:var(--amber,#c2620a); border-radius:8px; padding:8px 10px; font-weight:700; margin:12px 0; font-size:13px; }
  .ik-flag { background:#fdeceb; color:var(--red,#b3261e); border-radius:8px; padding:8px 10px; margin:8px 0; font-size:12.5px; }
  .ik-ref { white-space:pre-wrap; font-size:13.5px; line-height:1.5; background:var(--fog,#f2f4f7); border-radius:10px; padding:14px; }
  .ik-ref textarea { min-height:360px; font-size:13px; }
  .ik-gate { font-size:12.5px; color:var(--steel,#51606f); margin-top:8px; }
  .ik-done { text-align:center; padding:30px 10px; }
  .ik-done b { display:block; font-size:18px; margin-bottom:8px; }
  @media (max-width: 640px) { .ik-back { padding:0; } .ik-box { max-width:none; max-height:none; height:100%; border-radius:0; } .ik-q { font-size:17px; } }`;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const api = async (url, body, method) => {
    const r = await fetch(url, { method: method || (body === undefined ? "GET" : "POST"), headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || "something went wrong"); e.missing = j.missing; throw e; }
    return j;
  };
  const qs = () => V.questions.filter((q) => q.round === V.round);
  const cur = () => qs()[IDX];
  const ans = (id) => (V.answers || {})[id];

  // ---- open, close, refresh ----------------------------------------------------
  async function start() {
    try { const v = await api(`/api/c/${SLUG}/intakes`, {}); await open(v.id); }
    catch (e) { alert(e.message); }
  }
  async function open(id) {
    ID = id; ERR = ""; EDITING = false; CHECKS = new Set();
    if (!document.getElementById("ik-css")) { const s = document.createElement("style"); s.id = "ik-css"; s.textContent = CSS; document.head.appendChild(s); }
    if (!ROOT) {
      ROOT = document.createElement("div"); ROOT.id = "intake-root"; document.body.appendChild(ROOT);
      // every box with a limit says how much room is left once it gets close, and says so plainly when it is full
      ROOT.addEventListener("input", (e) => counter(e.target));
    }
    try { V = await api(`/api/intakes/${id}`); } catch (e) { alert(e.message); return; }
    IDX = firstOpen();
    MODE = modeFor();
    render();
    document.addEventListener("keydown", onKey);
    if (V.status === "thinking") poll();
  }
  function onKey(e) { if (e.key === "Escape") close(); }
  async function close() {
    await flush();
    if (POLL) { clearInterval(POLL); POLL = null; }
    document.removeEventListener("keydown", onKey);
    if (ROOT) ROOT.innerHTML = "";
    ID = null; V = null;
    const u = new URL(location.href); if (u.searchParams.has("intake")) { u.searchParams.delete("intake"); history.replaceState(null, "", u.pathname + u.search); }
    if (typeof window.load === "function") window.load();
  }
  async function refresh() { if (!ID) return; V = await api(`/api/intakes/${ID}`); }
  function modeFor() {
    if (V.status === "thinking") return "think";
    if (V.status === "design") return EDITING ? "edit" : "design";
    if (V.status === "confirmed" || V.status === "building" || V.status === "done") return "confirmed";
    if (V.status === "abandoned") return "gone";
    return "q";
  }
  function firstOpen() {
    const list = qs();
    const i = list.findIndex((q) => (V.missing || []).includes(q.id));
    if (i >= 0) return i;
    return V.round > 1 ? 0 : Math.min(list.length - 1, list.filter((q) => answered(q)).length);
  }
  function answered(q) {
    const v = ans(q.id);
    if (v == null) return false;
    if (q.kind === "text") return String(v).trim().length > 0;
    if (q.kind === "choice") return Boolean((v.picks && v.picks.length) || (v.other && String(v.other).trim()));
    if (q.kind === "roles") return Object.keys(v).length > 0;
    if (q.kind === "devices") return Object.values(v).some((d) => d && d.length);
    if (q.kind === "order" || q.kind === "items") return Array.isArray(v) && v.filter((s) => String(s).trim()).length >= (q.min || 1);
    return true;
  }
  function poll() {
    if (POLL) clearInterval(POLL);
    POLL = setInterval(async () => {
      try { await refresh(); } catch (e) { return; }
      if (V.status !== "thinking") {
        clearInterval(POLL); POLL = null;
        MODE = modeFor(); IDX = V.status === "answering" ? 0 : 0; CHECKS = new Set(); render();
      }
    }, 2000);
  }

  // ---- saving --------------------------------------------------------------------
  const pending = {};
  function stage(qid, value) {
    pending[qid] = value;
    V.answers = { ...(V.answers || {}), [qid]: value };
    if (SAVE) clearTimeout(SAVE);
    SAVE = setTimeout(flush, 700);
  }
  async function flush() {
    if (SAVE) { clearTimeout(SAVE); SAVE = null; }
    const ids = Object.keys(pending);
    for (const qid of ids) {
      const value = pending[qid]; delete pending[qid];
      try { const v = await api(`/api/intakes/${ID}/answer`, { id: qid, value }); if (V) { V.missing = v.missing; V.round_answered = v.round_answered; V.round_total = v.round_total; V.round_done = v.round_done; V.name = v.name; V.slug = v.slug; V.status = v.status; } ERR = ""; }
      catch (e) { ERR = e.message; if (V) render(); return false; }
    }
    if (V && ids.length) { const p = ROOT.querySelector(".ik-prog"); if (p) p.textContent = progressText(); const b = ROOT.querySelector(".ik-bar i"); if (b) b.style.width = progressPct() + "%"; const t = ROOT.querySelector(".ik-title"); if (t) t.textContent = titleText(); }
    return true;
  }

  function counter(el) {
    if (!el || !el.getAttribute || !el.getAttribute("maxlength")) return;
    const max = Number(el.getAttribute("maxlength")), len = (el.value || "").length;
    let c = el.nextElementSibling && el.nextElementSibling.classList && el.nextElementSibling.classList.contains("ik-count") ? el.nextElementSibling : null;
    if (len < max * 0.8) { if (c) c.remove(); return; }
    if (!c) { c = document.createElement("div"); c.className = "ik-count"; el.insertAdjacentElement("afterend", c); }
    c.textContent = len >= max ? `This box is full (${max} characters). Shorten it, or put the rest in the next answer.` : `${max - len} characters left`;
    c.classList.toggle("full", len >= max);
  }

  // ---- rendering -----------------------------------------------------------------
  const roundLabel = () => (MODE === "design" || MODE === "edit" ? "The design" : MODE === "confirmed" ? "Confirmed" : V.round > 1 ? `Fable's questions, round ${V.round}` : "Your answers");
  const titleText = () => (V.name ? `New module: ${V.name}` : "New module");
  const progressText = () => (MODE === "q" ? `${V.round_answered} of ${V.round_total} answered` : MODE === "think" ? "Fable is working" : "");
  const progressPct = () => (MODE === "q" ? Math.round(100 * (V.round_answered / Math.max(1, V.round_total))) : MODE === "think" ? 100 : 100);
  function render() {
    if (!ROOT || !V) return;
    let body = "", foot = "";
    if (MODE === "q") { body = questionHtml(cur()); foot = questionFoot(); }
    else if (MODE === "think") { body = `<div class="ik-think"><div class="ik-spin"></div><b>Fable is reading your answers${V.attachments && V.attachments.length ? " and the files you attached" : ""}.</b><div class="ik-hint" style="margin-top:8px">${V.rounds_generated || V.enough ? "Writing the design summary." : "Deciding whether it needs to ask anything else, or can write the design."} This takes a minute or two. You can close this and come back; the card on the board shows when it is ready.</div></div>`; foot = `<span class="ik-sp"></span><button class="quiet" onclick="Intake.close()">Close for now</button>`; }
    else if (MODE === "design") { body = designHtml(); foot = designFoot(); }
    else if (MODE === "edit") { body = editHtml(); foot = `<button class="quiet" onclick="Intake.cancelEdit()">Cancel</button><span class="ik-sp"></span><button class="go" onclick="Intake.reissue()">Re-issue the design with my edits</button>`; }
    else if (MODE === "confirmed") {
      const msg = V.status === "done" ? `<b>${esc(V.name)} is on the floor.</b><div class="ik-hint">Open it from the module strip. From here it improves through feedback like any other module. What you confirmed is kept as its reference.</div>`
        : V.status === "building" ? `<b>Fable is building ${esc(V.name)}.</b><div class="ik-hint">Watch the card on the board: it shows each step, then a preview and the button that puts it on the floor. Building takes several minutes.</div>`
        : V.error ? `<b>Design confirmed, but the build did not start.</b><div class="ik-hint">${esc(V.error)}. Use "Build it now" on the card to try again.</div>`
        : `<b>Design confirmed.</b><div class="ik-hint">The build starts from the card on the board ("Build it now").</div>`;
      body = `<div class="ik-done">${msg}${refDetails()}</div>`; foot = `<span class="ik-sp"></span><button class="primary" onclick="Intake.close()">Close</button>`;
    }
    else { body = `<div class="ik-done"><b>This request was withdrawn.</b></div>`; foot = `<span class="ik-sp"></span><button class="primary" onclick="Intake.close()">Close</button>`; }
    ROOT.innerHTML = `<div class="ik-back" onclick="if(event.target===this)Intake.close()"><div class="ik-box" role="dialog" aria-modal="true">
      <div class="ik-head"><span class="ik-round">${esc(roundLabel())}</span><span class="ik-title">${esc(titleText())}</span><span class="ik-prog">${esc(progressText())}</span><button class="ik-x" onclick="Intake.close()">Close</button></div>
      <div class="ik-bar"><i style="width:${progressPct()}%"></i></div>
      <div class="ik-body">${body}${ERR ? `<div class="ik-err">${esc(ERR)}</div>` : ""}${V.error && MODE !== "think" ? `<div class="ik-err">Last time Fable was asked, it did not finish: ${esc(V.error)}. Try again below.</div>` : ""}</div>
      <div class="ik-foot">${foot}</div></div></div>`;
    for (const el of ROOT.querySelectorAll("[maxlength]")) counter(el);
    const f = ROOT.querySelector(".ik-body textarea, .ik-body input[type=text]");
    if (f && MODE === "q" && window.innerWidth > 640) f.focus();
  }
  function questionFoot() {
    const list = qs(), last = IDX >= list.length - 1;
    const roundOne = V.round === 1;
    return `<button class="quiet" ${IDX === 0 ? "disabled" : ""} onclick="Intake.prev()">Back</button><span class="ik-sp"></span>`
      + (last ? `<button class="go" onclick="Intake.finishRound()">${roundOne ? "Done with these, ask Fable" : "Done, back to Fable"}</button>` : `<button class="primary" onclick="Intake.next()">Next</button>`);
  }
  function questionHtml(q) {
    if (!q) return `<div class="ik-done"><b>Nothing to answer right now.</b></div>`;
    let h = `<div class="ik-q">${esc(q.text)}</div><div class="ik-hint">${esc(q.hint || "")}</div>`;
    if (IDX === 0 && V.round > 1) { const r = roundWhy(); if (r) h = `<div class="ik-why">${esc(r)}</div>` + h; }
    switch (q.kind) {
      case "text": h += q.multiline === false ? `<input type="text" maxlength="${q.max || 200}" value="${esc(ans(q.id) || "")}" oninput="Intake.setText('${q.id}', this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();Intake.next();}">` : `<textarea maxlength="${q.max || 2000}" oninput="Intake.setText('${q.id}', this.value)">${esc(ans(q.id) || "")}</textarea>`; break;
      case "choice": h += choiceHtml(q); break;
      case "roles": h += rolesHtml(q); break;
      case "devices": h += devicesHtml(q); break;
      case "order": h += listHtml(q, true); break;
      case "items": h += listHtml(q, false); break;
      case "attach": h += `<textarea placeholder="Anything to say about it (optional)" oninput="Intake.setAttachNote('${q.id}', this.value)">${esc((ans(q.id) || {}).note || "")}</textarea>`; break;
      default: h += `<textarea oninput="Intake.setText('${q.id}', this.value)">${esc(ans(q.id) || "")}</textarea>`;
    }
    if (q.attach || q.kind === "attach") h += filesHtml(q);
    return h;
  }
  function roundWhy() { return V.round_why || ""; }
  function choiceHtml(q) {
    const v = ans(q.id) || { picks: [], other: "", names: {}, note: "" };
    const picks = v.picks || [];
    let h = `<div class="ik-chips">${(q.options || []).map((o) => `<button class="ik-chip ${picks.includes(o.id) ? "on" : ""}" onclick="Intake.pick('${q.id}','${o.id}')">${esc(o.label)}</button>`).join("")}${q.other !== false ? `<button class="ik-chip ${v.otherOn || (v.other && v.other.trim()) ? "on" : ""}" onclick="Intake.pickOther('${q.id}')">Something else</button>` : ""}</div>`;
    for (const oid of picks) if ((q.names_for || []).includes(oid)) h += `<div class="ik-sub">What do you call ${esc(((q.options || []).find((o) => o.id === oid) || {}).label || "it").toLowerCase()}?</div><input type="text" value="${esc((v.names || {})[oid] || "")}" oninput="Intake.setName('${q.id}','${oid}', this.value)" placeholder="The name you use for it">`;
    if (v.otherOn || (v.other && v.other.trim())) h += `<div class="ik-sub">Something else</div><input type="text" value="${esc(v.other || "")}" oninput="Intake.setOther('${q.id}', this.value)" placeholder="Say it in your words">`;
    if (q.note) h += `<div class="ik-sub">In your words</div><textarea oninput="Intake.setNote('${q.id}', this.value)">${esc(v.note || "")}</textarea>`;
    return h;
  }
  function rolesHtml(q) {
    const v = ans(q.id) || {};
    let h = `<div class="ik-chips">${q.options.map((o) => `<button class="ik-chip ${o.id in v ? "on" : ""}" onclick="Intake.toggleRole('${q.id}','${o.id}')">${esc(o.label)}</button>`).join("")}</div>`;
    for (const o of q.options) if (o.id in v) h += `<div class="ik-grp"><b>${esc(o.label)}</b>About how many? <input type="number" min="1" max="9999" value="${esc(v[o.id] || "")}" oninput="Intake.setCount('${q.id}','${o.id}', this.value)"></div>`;
    return h;
  }
  function devicesHtml(q) {
    const who = ans("who") || {};
    const groups = (V.questions.find((x) => x.id === "who") || { options: [] }).options.filter((o) => o.id in who);
    if (!groups.length) return `<div class="ik-hint">Pick who uses it on the previous screen first.</div>`;
    const v = ans(q.id) || {};
    return groups.map((g) => `<div class="ik-grp"><b>${esc(g.label)}</b><div class="ik-chips">${q.options.map((d) => `<button class="ik-chip ${(v[g.id] || []).includes(d.id) ? "on" : ""}" onclick="Intake.toggleDevice('${q.id}','${g.id}','${d.id}')">${esc(d.label)}</button>`).join("")}</div></div>`).join("");
  }
  function listHtml(q, ordered) {
    const v = (ans(q.id) || []).slice();
    if (!v.length) v.push("");
    const max = q.max || 12;
    let h = v.map((s, i) => `<div class="ik-row">${ordered ? `<span class="ik-n">${i + 1}.</span>` : ""}<input type="text" maxlength="${q.item_max || 120}" value="${esc(s)}" oninput="Intake.setItem('${q.id}', ${i}, this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();Intake.addItem('${q.id}', ${i + 1});}">${ordered ? `<button ${i === 0 ? "disabled" : ""} onclick="Intake.moveItem('${q.id}', ${i}, -1)" title="Move up">&#8593;</button><button ${i === v.length - 1 ? "disabled" : ""} onclick="Intake.moveItem('${q.id}', ${i}, 1)" title="Move down">&#8595;</button>` : ""}<button onclick="Intake.removeItem('${q.id}', ${i})" title="Remove">&#10005;</button></div>`).join("");
    if (v.length < max) h += `<button class="ik-add" onclick="Intake.addItem('${q.id}')">${ordered ? "Add a stage" : "Add another"}</button>`;
    return h;
  }
  function filesHtml(q) {
    const files = (V.attachments || []).filter((a) => a.question_id === q.id);
    let h = `<div class="ik-files">${files.map((a) => `<div class="ik-file">${a.kind === "image" ? `<img src="/api/attachments/${a.id}" alt="">` : `<span style="font-size:22px">${a.kind === "sheet" ? "&#9638;" : "&#9636;"}</span>`}<span class="ik-meta"><b>${esc(a.filename)}</b><br>${a.kind === "sheet" && a.parsed ? `${a.parsed.row_count} rows: ${esc((a.parsed.headers || []).filter(Boolean).slice(0, 6).join(", "))}` : `${Math.max(1, Math.round(a.size / 1024))} KB`}</span><button onclick="Intake.removeFile(${a.id})" title="Remove">&#10005;</button></div>`).join("")}</div>`;
    h += `<label class="ik-attach">${files.length ? "Add another file" : "Attach a photo or a spreadsheet"}<input type="file" accept="image/*,.pdf,.csv,.xlsx,.tsv,.txt,application/pdf,text/csv" onchange="Intake.addFile('${q.id}', this)"></label> <span class="ik-hint" style="display:inline">A photo, a pdf, a csv or an xlsx. Up to 15 MB each.</span>`;
    return h;
  }
  function refDetails() {
    const d = V.design || {};
    return d.reference_md ? `<details style="text-align:left;margin-top:14px"><summary style="cursor:pointer;font-weight:700;color:var(--navy)">The reference</summary><div class="ik-ref" style="margin-top:8px">${esc(d.reference_md)}</div></details>` : "";
  }
  function designHtml() {
    const d = V.design || {};
    const items = d.items || [];
    const all = items.length && items.every((_, i) => CHECKS.has(i));
    let h = `<div class="ik-bluf">${esc(d.bluf || "")}</div>`;
    h += items.map((it, i) => `<label class="ik-item"><input type="checkbox" ${CHECKS.has(i) ? "checked" : ""} onchange="Intake.tick(${i}, this.checked)"><span>${esc(it.summary)}</span></label>`).join("");
    h += `<div class="ik-gate">${all ? "Every point checked." : "Tick each point to confirm you read it; then the build can be approved."}</div>`;
    if ((d.flags || []).length) h += `<div class="ik-flag">A few lines use words we try to avoid (${esc(d.flags.map((f) => `${f.where}: ${f.words.join(", ")}`).join("; "))}). Adjust the text if you want them changed.</div>`;
    h += `<div class="ik-est">About $${Number(d.estimate_usd || 0).toFixed(2)} to build the first version (${(d.screens || []).length} screens, ${(d.connections || []).length} connections).${V.cost_usd ? ` The questions and this design cost $${Number(V.cost_usd).toFixed(2)} so far.` : ""}</div>`;
    h += `<details><summary style="cursor:pointer;font-weight:700;color:var(--navy)">Read the full reference</summary><div class="ik-ref" style="margin-top:8px">${esc(d.reference_md || "")}</div></details>`;
    return h;
  }
  function designFoot() {
    const items = (V.design || {}).items || [];
    const all = items.length && items.every((_, i) => CHECKS.has(i));
    return `<button class="quiet" onclick="Intake.edit()">Adjust the text</button><button class="quiet" onclick="Intake.restart()">Start over</button><span class="ik-sp"></span><button class="go" id="ik-approve" ${all ? "" : "disabled"} onclick="Intake.approve()">Approve build</button>`;
  }
  function editHtml() {
    return `<div class="ik-q">Adjust the reference</div><div class="ik-hint">Change anything. Fable re-issues the whole design to match what you write here; your edit is the authority.</div><div class="ik-ref"><textarea id="ik-edit">${esc((V.design || {}).reference_md || "")}</textarea></div>`;
  }

  // ---- actions --------------------------------------------------------------------
  function setText(qid, val) { stage(qid, val); }
  function setAttachNote(qid, val) { stage(qid, { ...(ans(qid) || {}), note: val }); }
  function choiceVal(qid) { return { picks: [], other: "", names: {}, note: "", ...(ans(qid) || {}) }; }
  function pick(qid, oid) {
    const q = qs().find((x) => x.id === qid) || V.questions.find((x) => x.id === qid); const v = choiceVal(qid);
    if (q.multi) v.picks = v.picks.includes(oid) ? v.picks.filter((p) => p !== oid) : [...v.picks, oid];
    else v.picks = v.picks.includes(oid) ? [] : [oid];
    if (v.picks.includes("nothing") && v.picks.length > 1) v.picks = oid === "nothing" ? ["nothing"] : v.picks.filter((p) => p !== "nothing");
    if (v.picks.includes("none") && v.picks.length > 1) v.picks = oid === "none" ? ["none"] : v.picks.filter((p) => p !== "none");
    stage(qid, v); render();
  }
  function pickOther(qid) { const v = choiceVal(qid); v.otherOn = !(v.otherOn || (v.other && v.other.trim())); if (!v.otherOn) v.other = ""; stage(qid, v); render(); }
  function setOther(qid, val) { const v = choiceVal(qid); v.other = val; v.otherOn = true; stage(qid, v); }
  function setName(qid, oid, val) { const v = choiceVal(qid); v.names = { ...(v.names || {}), [oid]: val }; stage(qid, v); }
  function setNote(qid, val) { const v = choiceVal(qid); v.note = val; stage(qid, v); }
  function toggleRole(qid, gid) { const v = { ...(ans(qid) || {}) }; if (gid in v) delete v[gid]; else v[gid] = ""; stage(qid, v); render(); }
  function setCount(qid, gid, val) { const v = { ...(ans(qid) || {}) }; v[gid] = val; stage(qid, v); }
  function toggleDevice(qid, gid, did) { const v = { ...(ans(qid) || {}) }; const cur = v[gid] || []; v[gid] = cur.includes(did) ? cur.filter((d) => d !== did) : [...cur, did]; stage(qid, v); render(); }
  function setItem(qid, i, val) { const v = (ans(qid) || []).slice(); while (v.length <= i) v.push(""); v[i] = val; stage(qid, v); }
  function addItem(qid, at) { const q = V.questions.find((x) => x.id === qid); const v = (ans(qid) || []).slice(); if (!v.length) v.push(""); if (v.length >= (q.max || 12)) return; if (at == null || at >= v.length) v.push(""); else v.splice(at, 0, ""); stage(qid, v); render(); const inputs = ROOT.querySelectorAll(".ik-row input[type=text]"); const target = inputs[at == null ? inputs.length - 1 : at]; if (target) target.focus(); }
  function removeItem(qid, i) { const v = (ans(qid) || []).slice(); v.splice(i, 1); stage(qid, v); render(); }
  function moveItem(qid, i, d) { const v = (ans(qid) || []).slice(); const j = i + d; if (j < 0 || j >= v.length) return; [v[i], v[j]] = [v[j], v[i]]; stage(qid, v); render(); }
  async function addFile(qid, input) {
    const f = input.files && input.files[0]; if (!f) return;
    if (f.size > 15 * 1024 * 1024) { ERR = "That file is bigger than 15 MB."; render(); return; }
    ERR = ""; const label = input.parentElement; if (label) label.textContent = "Uploading " + f.name + "...";
    try {
      await flush();
      const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = rej; r.readAsDataURL(f); });
      const j = await api(`/api/intakes/${ID}/attach`, { question_id: qid, filename: f.name, mime: f.type || "", data });
      V.attachments = j.view.attachments;
    } catch (e) { ERR = e.message; }
    render();
  }
  async function removeFile(aid) { try { const v = await api(`/api/intakes/${ID}/attach/${aid}`, undefined, "DELETE"); V.attachments = v.attachments; ERR = ""; } catch (e) { ERR = e.message; } render(); }
  async function next() { if (!(await flush())) return; if (IDX < qs().length - 1) { IDX++; ERR = ""; render(); } }
  async function prev() { await flush(); if (IDX > 0) { IDX--; ERR = ""; render(); } }
  async function finishRound() {
    if (!(await flush())) return;
    try {
      V = await api(`/api/intakes/${ID}/next`, {});
      MODE = "think"; ERR = ""; render(); poll();
    } catch (e) {
      if (e.missing && e.missing.length) { const list = qs(); const i = list.findIndex((q) => q.id === e.missing[0].id); if (i >= 0) IDX = i; ERR = `Still needed: ${e.missing.map((m) => m.text).join(" / ")}`; }
      else ERR = e.message;
      render();
    }
  }
  function tick(i, on) { if (on) CHECKS.add(i); else CHECKS.delete(i); const items = (V.design || {}).items || []; const all = items.every((_, k) => CHECKS.has(k)); const b = document.getElementById("ik-approve"); if (b) b.disabled = !all; const g = ROOT.querySelector(".ik-gate"); if (g) g.textContent = all ? "Every point checked." : "Tick each point to confirm you read it; then the build can be approved."; }
  function edit() { EDITING = true; MODE = "edit"; render(); }
  function cancelEdit() { EDITING = false; MODE = "design"; render(); }
  async function reissue() {
    const ta = document.getElementById("ik-edit"); const text = ta ? ta.value : "";
    try { V = await api(`/api/intakes/${ID}/adjust`, { text }); EDITING = false; CHECKS = new Set(); MODE = "think"; ERR = ""; render(); poll(); }
    catch (e) { ERR = e.message; render(); }
  }
  async function approve() {
    try { V = await api(`/api/intakes/${ID}/confirm`, {}); MODE = "confirmed"; ERR = ""; render(); }
    catch (e) { ERR = e.message; render(); }
  }
  async function restart() {
    if (!confirm("Start over? Your answers to the fixed questions are kept; Fable's questions and the design are dropped.")) return;
    try { V = await api(`/api/intakes/${ID}/restart`, {}); MODE = "q"; IDX = firstOpen(); CHECKS = new Set(); ERR = ""; render(); }
    catch (e) { ERR = e.message; render(); }
  }
  async function tryAgain() { await finishRound(); }

  return { start, open, close, next, prev, finishRound, setText, setAttachNote, pick, pickOther, setOther, setName, setNote, toggleRole, setCount, toggleDevice, setItem, addItem, removeItem, moveItem, addFile, removeFile, tick, edit, cancelEdit, reissue, approve, restart, tryAgain };
})();
