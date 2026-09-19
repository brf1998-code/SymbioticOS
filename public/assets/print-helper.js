// The platform's print helper (platform code, injected into the pages of a
// module that declares a printer connection, and into the connections page).
// It carries labels from the platform's print queue to the Zebra printer
// chosen on THIS device, through Zebra Browser Print, the small program that
// runs on the PC or tablet and listens on localhost. Module code never
// touches any of this: it calls ctx.connections.<name>.print() on the
// server, the job is queued for the device that asked, this script prints it.
//
//   every 2 seconds while the page is visible: GET /api/c/<co>/print/next
//   a job arrives -> the printer chosen on this device (localStorage), or ask
//   -> POST http://localhost:9100/write { device, data } (Browser Print)
//   -> POST /api/c/<co>/print/jobs/<id>/done or /failed
(function () {
  const me = document.currentScript;
  const company = (me && me.getAttribute("data-company")) || (location.pathname.match(/^\/c\/([^/]+)\//) || [])[1];
  if (!company) return;
  const BP = ["http://localhost:9100", "https://localhost:9101", "http://127.0.0.1:9100"];
  const KEY = "sos_printer_" + company;
  const state = { printers: null, bp: null, busy: false, picker: null };
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; } };
  const save = (p) => { try { p ? localStorage.setItem(KEY, JSON.stringify(p)) : localStorage.removeItem(KEY); } catch (e) {} };

  // ---- a small toast, plain words --------------------------------------------------
  let toastEl = null, toastTimer = null;
  function toast(text, kind) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.setAttribute("style", "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:92vw;background:#1c242e;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:10px 14px;border-radius:10px;z-index:99998;box-shadow:0 6px 24px rgba(0,0,0,.25);display:none");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.background = kind === "bad" ? "#b3261e" : kind === "good" ? "#2e7d4f" : "#1c242e";
    toastEl.style.display = "block";
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.style.display = "none"; }, kind === "bad" ? 9000 : 4000);
  }

  // ---- Browser Print on this device ----------------------------------------------------
  async function bpFetch(path, opts) {
    const order = state.bp ? [state.bp].concat(BP.filter((b) => b !== state.bp)) : BP;
    let lastErr = null;
    for (const base of order) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch(base + path, Object.assign({ signal: ctl.signal }, opts || {}));
        clearTimeout(t);
        state.bp = base;
        return r;
      } catch (e) { lastErr = e; }
    }
    throw new Error("Browser Print is not running on this device" + (lastErr ? "" : ""));
  }
  async function available() {
    const r = await bpFetch("/available");
    const j = await r.json();
    const list = (j && j.printer) || [];
    state.printers = list;
    return list;
  }
  async function send(printer, zpl) {
    const r = await bpFetch("/write", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ device: printer, data: zpl }) });
    if (!r.ok) throw new Error("the printer did not take the label (" + r.status + ")");
    return true;
  }

  // ---- choosing the printer for this device ---------------------------------------------
  function closePicker() { if (state.picker) { state.picker.remove(); state.picker = null; } }
  function pick(list, why) {
    return new Promise((resolve) => {
      closePicker();
      const wrap = document.createElement("div");
      wrap.setAttribute("style", "position:fixed;inset:0;background:rgba(28,36,46,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;font:15px/1.45 system-ui,sans-serif");
      const card = document.createElement("div");
      card.setAttribute("style", "background:#fff;color:#1c242e;border-radius:14px;padding:20px;width:100%;max-width:420px");
      const h = document.createElement("div"); h.setAttribute("style", "font-size:18px;font-weight:700;margin-bottom:6px"); h.textContent = "Which printer does this device print to?"; card.appendChild(h);
      if (why) { const p = document.createElement("div"); p.setAttribute("style", "color:#51606f;font-size:13px;margin-bottom:10px"); p.textContent = why; card.appendChild(p); }
      if (!list.length) { const p = document.createElement("div"); p.setAttribute("style", "margin:8px 0;color:#b3261e"); p.textContent = "Browser Print sees no printer on this device. Plug one in or add it in Browser Print, then try again."; card.appendChild(p); }
      list.forEach((pr) => {
        const b = document.createElement("button");
        b.setAttribute("style", "display:block;width:100%;text-align:left;margin:6px 0;padding:12px;border:1px solid #d5dbe3;border-radius:10px;background:#f2f4f7;font:inherit;font-weight:700;cursor:pointer");
        b.textContent = (pr.name || pr.uid || "printer") + (pr.connection ? "  (" + pr.connection + ")" : "");
        b.onclick = () => { closePicker(); resolve(pr); };
        card.appendChild(b);
      });
      const row = document.createElement("div"); row.setAttribute("style", "margin-top:10px;display:flex;gap:8px;justify-content:flex-end");
      const again = document.createElement("button"); again.textContent = "Look again"; again.setAttribute("style", "padding:9px 12px;border:none;border-radius:8px;background:#e5e9ee;font:inherit;font-weight:700;cursor:pointer");
      again.onclick = async () => { try { const l = await available(); closePicker(); resolve(await pick(l, why)); } catch (e) { toast(e.message, "bad"); } };
      const skip = document.createElement("button"); skip.textContent = "Not now"; skip.setAttribute("style", "padding:9px 12px;border:none;border-radius:8px;background:#fff;border:1px solid #d5dbe3;font:inherit;cursor:pointer");
      skip.onclick = () => { closePicker(); resolve(null); };
      row.appendChild(again); row.appendChild(skip); card.appendChild(row);
      wrap.appendChild(card); document.body.appendChild(wrap); state.picker = wrap;
    });
  }
  const NOT_RUNNING = "Browser Print is not running on this device. Install it from zebra.com, open it, then try again.";
  async function choosePrinter(why) {
    let list;
    state.choiceError = null;
    try { list = await available(); }
    catch (e) { state.choiceError = NOT_RUNNING; toast(NOT_RUNNING, "bad"); return null; }
    const pr = await pick(list, why);
    if (pr) { save(pr); toast("Labels from this device go to " + (pr.name || pr.uid), "good"); }
    else state.choiceError = "no printer chosen on this device";
    return pr;
  }

  // ---- the queue -----------------------------------------------------------------------
  const api = (p, opts) => fetch("/api/c/" + encodeURIComponent(company) + "/print" + p, Object.assign({ credentials: "same-origin" }, opts || {}));
  const report = (id, ok, body) => api("/jobs/" + id + "/" + (ok ? "done" : "failed"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).catch(() => {});
  async function handle(job) {
    let printer = load();
    if (!printer) printer = await choosePrinter("A label is waiting: " + job.template + ".");
    if (!printer) {
      const why = state.choiceError || "no printer chosen on this device";
      await report(job.id, false, { error: why });
      if (why !== NOT_RUNNING) toast("Label not printed: " + why + ".", "bad");
      return;
    }
    try {
      await send(printer, job.zpl);
      await report(job.id, true, { printer: printer.name || printer.uid });
      toast("Printed " + job.template + " on " + (printer.name || printer.uid), "good");
    } catch (e) {
      const msg = String(e && e.message || e);
      await report(job.id, false, { printer: printer.name || printer.uid, error: msg });
      toast("Label not printed: " + msg, "bad");
      if (/not running/.test(msg)) state.bp = null;
    }
  }
  async function poll() {
    if (state.busy || document.visibilityState !== "visible") return;
    state.busy = true;
    try {
      const r = await api("/next", { cache: "no-store" });
      if (r.ok) { const j = await r.json(); if (j && j.job) await handle(j.job); }
    } catch (e) { /* the platform is unreachable for a moment; try again next tick */ }
    finally { state.busy = false; }
  }
  setInterval(poll, 2000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });

  // for the connections page: choose or forget the printer on this device
  window.sosPrint = {
    choose: () => choosePrinter(),
    forget: () => { save(null); toast("This device has no printer chosen now."); },
    current: () => load(),
    available,
  };
})();
