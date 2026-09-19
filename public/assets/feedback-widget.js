// Feedback widget: injected into every module page by the runtime, and used by
// the platform's own pages with data-module="platform".
// Posts to /api/feedback with the company, module name and page path (the page
// path is how the platform knows which screen the feedback is about).
// It also watches the module's version: when the manager deploys a new
// version, every open page reloads itself and shows a short "updated" banner.
// On a staged preview it pins an amber bar so nobody mistakes it for the floor.
(function () {
  const script = document.currentScript;
  const mod = script ? script.getAttribute("data-module") : null;
  const version = script ? script.getAttribute("data-version") : null;
  const mount = script ? script.getAttribute("data-mount") : null;
  const company = (script && script.getAttribute("data-company")) || ((/^\/c\/([^/]+)/.exec(location.pathname) || [])[1]) || "demo";
  const staged = mount === "staged";

  // Small pill, bottom right, out of the way of the work. Opens a panel on tap.
  const btn = document.createElement("button");
  btn.id = "sos-fb-btn";
  btn.setAttribute("aria-label", "Something in the way? Send feedback");
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Feedback';
  // !important so a page's own button rules (width:100%, min-height) cannot resize it
  btn.style.cssText = "position:fixed!important;right:12px!important;bottom:12px!important;left:auto!important;top:auto!important;z-index:9999;width:auto!important;min-height:0!important;height:auto!important;margin:0!important;background:#1f3a5f!important;color:#fff!important;border:none!important;border-radius:18px!important;padding:8px 12px!important;font-size:12.5px!important;font-weight:700!important;line-height:1!important;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);font-family:system-ui,sans-serif!important;opacity:.92;";

  const panel = document.createElement("div");
  panel.style.cssText = "position:fixed;right:12px;bottom:52px;z-index:9999;background:#fff;border:1px solid #d5dbe3;border-radius:10px;padding:14px;width:300px;max-width:calc(100vw - 24px);display:none;box-shadow:0 6px 20px rgba(0,0,0,.2);font-family:system-ui,sans-serif;";
  panel.innerHTML =
    '<div style="font-weight:700;font-size:14px;color:#1c242e;margin-bottom:8px">Something in the way?</div>' +
    '<textarea id="fbw-msg" rows="3" placeholder="What is slowing you down?" style="width:100%;border:1px solid #d5dbe3;border-radius:6px;padding:8px;font-size:14px;font-family:inherit;box-sizing:border-box"></textarea>' +
    '<div id="fbw-who" style="display:none;font-size:13px;color:#51606f;margin-top:8px"></div>' +
    '<input id="fbw-name" placeholder="Your name (optional)" style="width:100%;border:1px solid #d5dbe3;border-radius:6px;padding:8px;font-size:14px;margin-top:8px;font-family:inherit;box-sizing:border-box">' +
    '<button id="fbw-send" style="margin:10px 0 0!important;width:100%!important;min-height:0!important;background:#2e7d4f!important;color:#fff!important;border:none!important;border-radius:6px!important;padding:11px!important;font-size:14px!important;font-weight:700!important;cursor:pointer">Send</button>' +
    '<div id="fbw-done" style="display:none;color:#2e7d4f;font-size:13px;margin-top:8px">Sent. It goes straight on the improvement board.</div>';

  btn.onclick = () => { panel.style.display = panel.style.display === "none" ? "block" : "none"; };

  function banner(text, color) {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:10000;background:" + (color || "#2e7d4f") + ";color:#fff;border-radius:20px;padding:10px 18px;font-size:14px;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.25);font-family:system-ui,sans-serif;max-width:calc(100vw - 32px);text-align:center;";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }

  // Staged preview: a bar that never goes away, with a live-version reminder,
  // a "What changed" panel (the run's plain summary plus which screens differ
  // from the floor version, a text compare that costs no tokens), and an
  // outline on every element the build agent marked with data-changed="vN".
  let changes = null, changesOpen = false;
  function stagedBar(liveVersion) {
    let bar = document.getElementById("sos-staged-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "sos-staged-bar";
      bar.style.cssText = "position:sticky;top:0;z-index:10001;background:#c2620a;color:#fff;padding:9px 14px;font-size:13.5px;font-weight:700;font-family:system-ui,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.25);";
      document.body.insertBefore(bar, document.body.firstChild);
      document.body.style.borderTop = "4px dashed #c2620a";
      const st = document.createElement("style");
      st.textContent = '[data-changed="v' + version + '"]{outline:3px solid #f2b134!important;outline-offset:3px;box-shadow:0 0 0 6px rgba(242,177,52,.25)!important;position:relative;}' +
        '[data-changed="v' + version + '"]::after{content:"NEW";position:absolute;top:-10px;right:-6px;background:#f2b134;color:#1c242e;font:800 9px/1 system-ui,sans-serif;padding:3px 5px;border-radius:6px;letter-spacing:.06em;z-index:10000;}' +
        '#sos-changes{display:none;background:#fff;color:#1c242e;text-align:left;font-weight:400;font-size:13px;line-height:1.45;border-radius:10px;padding:10px 12px;margin:8px auto 0;max-width:720px;box-shadow:0 4px 14px rgba(0,0,0,.2);}' +
        '#sos-changes b{display:block;margin-bottom:4px;} #sos-changes .scr{display:inline-block;background:#fbefe0;color:#c2620a;border-radius:10px;padding:2px 8px;font-size:11.5px;font-weight:700;margin:4px 4px 0 0;} #sos-changes .here{background:#f2b134;color:#1c242e;}';
      document.head.appendChild(st);
      fetch("/api/c/" + company + "/modules/" + mod + "/staged-changes", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((j) => { changes = j; renderChanges(); }).catch(() => {});
    }
    const back = location.pathname.replace("/staging/", "/");
    const marked = document.querySelectorAll('[data-changed="v' + version + '"]').length;
    bar.innerHTML = "PREVIEW of version " + version + " (not on the floor)" + (liveVersion ? " · the floor is on version " + liveVersion : "") +
      ' · <a href="#" id="sos-changes-toggle" style="color:#fff;text-decoration:underline">' + (changesOpen ? "hide what changed" : "what changed?") + "</a>" +
      (marked ? ' · <span style="background:#f2b134;color:#1c242e;border-radius:10px;padding:2px 8px;font-size:11.5px">' + marked + " highlighted on this screen</span>" : "") +
      ' · <a href="' + back + '" style="color:#fff;text-decoration:underline">open the live page</a>' +
      '<div id="sos-changes"></div>';
    bar.querySelector("#sos-changes-toggle").onclick = (e) => { e.preventDefault(); changesOpen = !changesOpen; stagedBar(liveVersion); };
    renderChanges();
  }
  function renderChanges() {
    const box = document.getElementById("sos-changes");
    if (!box) return;
    box.style.display = changesOpen ? "block" : "none";
    if (!changesOpen) return;
    if (!changes) { box.innerHTML = "Loading what changed…"; return; }
    const rel = (location.pathname.match(/^\/c\/[^/]+\/staging\/m\/[^/]+(.*)$/) || [])[1] || "/";
    const files = changes.changed || [];
    let h = "<b>" + esc(changes.title || ("Version " + changes.staged_version + " against version " + changes.live_version)) + "</b>";
    h += "<div>" + esc(changes.what_changed || changes.build_summary || "No summary recorded for this build.").replace(/\n/g, "<br>") + "</div>";
    const here = rel.replace(/\/$/, "") || "/";
    const isHere = (route) => route && new RegExp("^" + route.replace(/\/$/, "").replace(/:[^/]+/g, "[^/]+") + "/?$").test(here);
    let onThis = false;
    if (files.length) {
      h += '<div style="margin-top:6px"><span style="color:#51606f;font-size:12px">Screens that differ from the floor version (tap to open):</span><br>' +
        files.map((f) => f.screens.map((sc) => {
          const hit = isHere(sc.route); if (hit) onThis = true;
          const label = esc(sc.label) + (f.added ? " (new)" : f.removed ? " (removed)" : "") + (hit ? " · this screen" : "");
          return sc.route && !hit ? '<a class="scr" style="text-decoration:none" href="' + modBase() + (sc.route === "/" ? "/" : sc.route.replace(/:[^/]+/g, "1")) + '">' + label + "</a>" : '<span class="scr' + (hit ? " here" : "") + '">' + label + "</span>";
        }).join("")).join("") + "</div>";
    } else h += '<div style="color:#51606f;font-size:12px;margin-top:6px">No file differs from the floor version.</div>';
    const marked = document.querySelectorAll('[data-changed="v' + version + '"]').length;
    h += '<div style="color:#51606f;font-size:12px;margin-top:6px">' + (onThis
      ? (marked ? (marked === 1 ? "1 element on this screen carries" : marked + " elements on this screen carry") + " a yellow outline and a NEW tag." : "This screen changed; the agent did not tag which elements, so compare against the live page.")
      : "This screen is the same as on the floor. The change is on the screens above.") + "</div>";
    box.innerHTML = h;
  }

  function watchVersion() {
    if (!mod || !version || mod === "platform") return;
    const key = "sos.updated." + company + "." + mod;
    try {
      const v = sessionStorage.getItem(key);
      if (v) { sessionStorage.removeItem(key); banner("This page was just updated (version " + v + ")"); }
    } catch (e) {}
    const probe = async () => {
      try {
        const r = await fetch("/api/c/" + company + "/modules/" + mod + "/version", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        if (staged) {
          stagedBar(j.live_version);
          if (!j.staged_version) { banner("This preview is gone (deployed or discarded). Opening the live page.", "#51606f"); setTimeout(() => location.href = location.pathname.replace("/staging/", "/"), 2500); }
          else if (String(j.staged_version) !== String(version)) location.reload();
          return;
        }
        if (j.live_version && String(j.live_version) !== String(version)) {
          try { sessionStorage.setItem(key, String(j.live_version)); } catch (e) {}
          location.reload();
        }
      } catch (e) {}
    };
    if (staged) stagedBar(null);
    probe();
    setInterval(probe, 5000);
  }

  // ---- guided tour ----------------------------------------------------------
  // Started with ?tour=1 on any page of the module (the admin library links
  // there). Steps come from the module's tour.json: { path, target, title, body }.
  // The step index lives in sessionStorage so the tour survives moving between
  // the module's pages; a step whose target is not on this page shows centered.
  const TOUR_KEY = "sos.tour." + company + "." + mod;
  function tourState() { try { return JSON.parse(sessionStorage.getItem(TOUR_KEY) || "null"); } catch (e) { return null; } }
  function setTour(st) { try { st ? sessionStorage.setItem(TOUR_KEY, JSON.stringify(st)) : sessionStorage.removeItem(TOUR_KEY); } catch (e) {} }
  function modBase() { return (location.pathname.match(/^\/c\/[^/]+\/(?:staging\/)?m\/[^/]+/) || [""])[0]; }
  function relPath() { return location.pathname.slice(modBase().length) || "/"; }

  async function maybeTour() {
    if (!mod || mod === "platform") return;
    const params = new URLSearchParams(location.search);
    let st = tourState();
    if (params.get("tour")) {
      st = { i: 0 };
      setTour(st);
      history.replaceState(null, "", location.pathname);
    }
    if (!st) return;
    let tour;
    try { const r = await fetch("/api/c/" + company + "/modules/" + mod + "/tour"); tour = r.ok ? await r.json() : null; } catch (e) {}
    if (!tour || !tour.steps || !tour.steps.length) { setTour(null); return; }
    showStep(tour, st.i);
  }

  function showStep(tour, i) {
    const steps = tour.steps;
    if (i < 0) i = 0;
    if (i >= steps.length) { endTour(true); return; }
    const step = steps[i];
    const here = relPath().replace(/\/$/, "") || "/";
    const want = (step.path || "/").replace(/\/$/, "") || "/";
    if (here !== want) { setTour({ i }); location.href = modBase() + (want === "/" ? "/" : want); return; }
    setTour({ i });
    let target = null;
    try { target = step.target ? document.querySelector(step.target) : null; } catch (e) {}
    if (target && target.getClientRects().length === 0) target = null;
    renderTour(tour, i, target);
  }

  let tourEls = [];
  function clearTour() { for (const el of tourEls) el.remove(); tourEls = []; window.removeEventListener("resize", tourReflow); window.removeEventListener("scroll", tourReflow, true); }
  let tourReflow = () => {};
  function renderTour(tour, i, target) {
    clearTour();
    const step = tour.steps[i], n = tour.steps.length;
    const dim = document.createElement("div");
    dim.style.cssText = "position:fixed;inset:0;z-index:10002;background:rgba(15,23,32,.55);";
    const ring = document.createElement("div");
    ring.style.cssText = "position:fixed;z-index:10003;border:3px solid #f2b134;border-radius:10px;box-shadow:0 0 0 9999px rgba(15,23,32,.55);pointer-events:none;display:none;";
    const card = document.createElement("div");
    card.style.cssText = "position:fixed;z-index:10004;background:#fff;color:#1c242e;border-radius:12px;padding:16px 18px;width:340px;max-width:calc(100vw - 24px);box-shadow:0 10px 30px rgba(0,0,0,.35);font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;";
    card.innerHTML =
      '<div style="font-size:11px;color:#51606f;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">' + (i === 0 && tour.title ? tour.title + " · " : "") + "step " + (i + 1) + " of " + n + "</div>" +
      '<div style="font-weight:800;font-size:16px;margin-bottom:6px">' + esc(step.title || "") + "</div>" +
      (i === 0 && tour.intro ? '<div style="color:#51606f;font-size:13px;margin-bottom:8px">' + esc(tour.intro) + "</div>" : "") +
      "<div>" + esc(step.body || "") + "</div>" +
      (target ? "" : '<div style="color:#51606f;font-size:12px;margin-top:6px">(This part is not on the screen right now, for example when there is no shift running.)</div>') +
      '<div style="display:flex;gap:8px;margin-top:14px;align-items:center">' +
      '<button id="sos-tour-back" style="all:unset;cursor:pointer;padding:8px 12px;border-radius:8px;background:#e5e9ee;font-weight:700;font-size:13px;' + (i === 0 ? "opacity:.4;pointer-events:none;" : "") + '">Back</button>' +
      '<button id="sos-tour-next" style="all:unset;cursor:pointer;padding:8px 14px;border-radius:8px;background:#1f3a5f;color:#fff;font-weight:700;font-size:13px">' + (i === n - 1 ? "Finish" : "Next") + "</button>" +
      '<button id="sos-tour-end" style="all:unset;cursor:pointer;margin-left:auto;color:#51606f;font-size:12.5px">End tour</button></div>';
    document.body.appendChild(target ? ring : dim);
    document.body.appendChild(card);
    tourEls = [target ? ring : dim, card];
    tourReflow = () => {
      // pages re-render themselves on a timer, so find the target again each time
      if (target) { try { const t2 = document.querySelector(step.target); if (t2 && t2.getClientRects().length) target = t2; } catch (e) {} }
      if (target) {
        const r = target.getBoundingClientRect();
        ring.style.display = "block";
        ring.style.left = (r.left - 6) + "px"; ring.style.top = (r.top - 6) + "px";
        ring.style.width = (r.width + 12) + "px"; ring.style.height = (r.height + 12) + "px";
        const below = r.bottom + 12 + card.offsetHeight < window.innerHeight;
        card.style.left = Math.max(12, Math.min(r.left, window.innerWidth - card.offsetWidth - 12)) + "px";
        card.style.top = (below ? r.bottom + 12 : Math.max(12, r.top - card.offsetHeight - 12)) + "px";
      } else {
        card.style.left = Math.max(12, (window.innerWidth - card.offsetWidth) / 2) + "px";
        card.style.top = Math.max(12, (window.innerHeight - card.offsetHeight) / 2) + "px";
      }
    };
    if (target) target.scrollIntoView({ block: "center", behavior: "instant" });
    tourReflow();
    window.addEventListener("resize", tourReflow);
    window.addEventListener("scroll", tourReflow, true);
    const tick = setInterval(tourReflow, 1000);
    tourEls.push({ remove: () => clearInterval(tick) });
    card.querySelector("#sos-tour-next").onclick = () => showStep(tour, i + 1);
    card.querySelector("#sos-tour-back").onclick = () => showStep(tour, i - 1);
    card.querySelector("#sos-tour-end").onclick = () => endTour(false);
  }
  function endTour(finished) {
    clearTour(); setTour(null);
    if (finished) banner("End of the tour. This is the live line: try the feedback button.", "#1f3a5f");
  }
  function esc(t) { return String(t == null ? "" : t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---- who is standing here: a name and a PIN (src/people.js) ----------------------------
  // The device stays signed in with the company's password; the person is
  // picked from the company's names and proven with a short PIN. A shared
  // tablet changes hands from the chip in this panel. window.sosPerson lets
  // the platform's own pages (the board) show and switch the same person.
  const who = { people: [], me: null, listeners: [] };
  const peopleApi = (p, opts) => fetch("/api/c/" + encodeURIComponent(company) + "/who" + p, Object.assign({ credentials: "same-origin" }, opts || {}));
  async function loadWho() {
    try { const r = await peopleApi("", { cache: "no-store" }); if (!r.ok) return; const j = await r.json(); who.people = j.people || []; who.me = j.me || null; } catch (e) { /* the list is a nicety; the button works without it */ }
    renderWho(); who.listeners.forEach((f) => { try { f(who.me); } catch (e) {} });
  }
  function renderWho() {
    const el = panel.querySelector("#fbw-who"), nameEl = panel.querySelector("#fbw-name"); if (!el) return;
    if (who.me) { el.style.display = "block"; nameEl.style.display = "none"; el.innerHTML = "Sending as <b>" + esc(who.me.name) + "</b> · <a href=\"#\" id=\"fbw-switch\" style=\"color:#1f3a5f\">not you?</a>"; }
    else if (who.people.length) { el.style.display = "block"; nameEl.style.display = ""; el.innerHTML = "<a href=\"#\" id=\"fbw-switch\" style=\"color:#1f3a5f;font-weight:700\">Tap your name</a> so this comes back to you, or just type it below."; }
    else { el.style.display = "none"; nameEl.style.display = ""; }
    const sw = panel.querySelector("#fbw-switch"); if (sw) sw.onclick = (e) => { e.preventDefault(); openPicker(); };
  }
  let picker = null;
  // the PIN pad listens to the keyboard only while it is open, as a listener of its own:
  // it never touches a handler the page set, and digits typed for the PIN never land in a field behind it
  let keyHandler = null;
  function setKeys(h) { if (keyHandler) document.removeEventListener("keydown", keyHandler, true); keyHandler = h; if (h) document.addEventListener("keydown", h, true); }
  function closePicker() { setKeys(null); if (picker) { picker.remove(); picker = null; } }
  const bigBtn = "display:block;width:100%;text-align:left;margin:6px 0;padding:14px;border:1px solid #d5dbe3;border-radius:10px;background:#f2f4f7;font:700 16px system-ui,sans-serif;color:#1c242e;cursor:pointer;min-height:0";
  function openPicker() {
    closePicker();
    picker = document.createElement("div");
    picker.style.cssText = "position:fixed;inset:0;background:rgba(28,36,46,.55);z-index:10001;display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,sans-serif";
    const card = document.createElement("div");
    card.style.cssText = "background:#fff;color:#1c242e;border-radius:14px;padding:18px;width:100%;max-width:380px;max-height:90vh;overflow:auto";
    picker.appendChild(card); picker.onclick = (e) => { if (e.target === picker) closePicker(); };
    document.body.appendChild(picker);
    names(card);
  }
  function names(card) {
    setKeys(null);
    card.innerHTML = "<div style=\"font-size:18px;font-weight:700;margin-bottom:6px\">Who is this?</div>" + (who.people.length ? "" : "<div style=\"color:#51606f;font-size:14px\">No names yet. A manager adds people from the improvement board.</div>");
    who.people.forEach((p) => { const b = document.createElement("button"); b.style.cssText = bigBtn; b.textContent = p.name; b.onclick = () => pinPad(card, p); card.appendChild(b); });
    const row = document.createElement("div"); row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:8px";
    if (who.me) { const out = document.createElement("button"); out.textContent = "Nobody (sign " + who.me.name + " out)"; out.style.cssText = "padding:10px 12px;border:1px solid #d5dbe3;border-radius:8px;background:#fff;font:14px system-ui,sans-serif;cursor:pointer;min-height:0;width:auto"; out.onclick = async () => { await peopleApi("/sign-out", { method: "POST" }); closePicker(); loadWho(); }; row.appendChild(out); }
    const no = document.createElement("button"); no.textContent = "Cancel"; no.style.cssText = "padding:10px 12px;border:none;border-radius:8px;background:#e5e9ee;font:700 14px system-ui,sans-serif;cursor:pointer;min-height:0;width:auto"; no.onclick = closePicker; row.appendChild(no);
    card.appendChild(row);
  }
  function pinPad(card, p) {
    let pin = "";
    card.innerHTML = "<div style=\"font-size:18px;font-weight:700\">" + esc(p.name) + "</div><div style=\"color:#51606f;font-size:14px;margin:2px 0 10px\">Your PIN</div><div id=\"fbw-dots\" style=\"font-size:30px;letter-spacing:10px;min-height:40px;text-align:center\"></div><div id=\"fbw-pinerr\" style=\"color:#b3261e;font-size:13px;min-height:18px;text-align:center\"></div><div id=\"fbw-pad\" style=\"display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px\"></div>";
    const dots = card.querySelector("#fbw-dots"), err = card.querySelector("#fbw-pinerr"), pad = card.querySelector("#fbw-pad");
    const draw = () => { dots.textContent = "\u2022".repeat(pin.length); };
    const go = async () => {
      if (pin.length < 4) { err.textContent = "A PIN is at least 4 digits."; return; }
      const r = await peopleApi("/sign-in", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id, pin }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { pin = ""; draw(); err.textContent = j.error || "That did not work."; return; }
      closePicker(); await loadWho();
    };
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "back", "0", "OK"].forEach((k) => {
      const b = document.createElement("button"); b.textContent = k === "back" ? "\u232b" : k;
      b.style.cssText = "padding:16px 0;border:1px solid #d5dbe3;border-radius:10px;background:" + (k === "OK" ? "#2e7d4f" : "#f2f4f7") + ";color:" + (k === "OK" ? "#fff" : "#1c242e") + ";font:700 20px system-ui,sans-serif;cursor:pointer;min-height:0;width:auto;margin:0";
      b.onclick = () => { err.textContent = ""; if (k === "back") pin = pin.slice(0, -1); else if (k === "OK") return go(); else if (pin.length < 8) pin += k; draw(); };
      pad.appendChild(b);
    });
    const back = document.createElement("button"); back.textContent = "Someone else"; back.style.cssText = "margin-top:10px;padding:10px 12px;border:none;border-radius:8px;background:#e5e9ee;font:700 14px system-ui,sans-serif;cursor:pointer;min-height:0;width:100%"; back.onclick = () => names(card); card.appendChild(back);
    setKeys((e) => {
      if (!picker) { setKeys(null); return; }
      const k = e.key; if (!/^\d$/.test(k) && !["Backspace", "Enter", "Escape"].includes(k)) return;
      e.preventDefault(); e.stopPropagation(); err.textContent = "";
      if (/^\d$/.test(k)) { if (pin.length < 8) pin += k; draw(); } else if (k === "Backspace") { pin = pin.slice(0, -1); draw(); } else if (k === "Enter") go(); else closePicker();
    });
  }
  window.sosPerson = { me: () => who.me, people: () => who.people, open: openPicker, refresh: loadWho, onChange: (f) => { who.listeners.push(f); } };

  document.addEventListener("DOMContentLoaded", init);
  if (document.readyState !== "loading") init();
  function init() {
    if (document.getElementById("fbw-send")) return;
    document.body.appendChild(btn);
    document.body.appendChild(panel);
    watchVersion();
    loadWho();
    setTimeout(maybeTour, 400); // give the page's own first render a moment so targets exist
    const nameEl = panel.querySelector("#fbw-name");
    try { nameEl.value = localStorage.getItem("sos.name") || ""; } catch (e) {}
    panel.querySelector("#fbw-send").onclick = async () => {
      const msg = panel.querySelector("#fbw-msg").value.trim();
      if (!msg) return;
      try { localStorage.setItem("sos.name", nameEl.value); } catch (e) {}
      const res = await fetch("/api/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, module: mod, page: location.pathname, message: msg, name: who.me ? who.me.name : nameEl.value }),
      });
      if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); return; }
      panel.querySelector("#fbw-msg").value = "";
      panel.querySelector("#fbw-done").style.display = "block";
      setTimeout(() => { panel.style.display = "none"; panel.querySelector("#fbw-done").style.display = "none"; }, 1500);
    };
  }
})();
