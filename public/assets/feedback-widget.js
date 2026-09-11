// Feedback widget — injected into every module page by the runtime, and used by
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
  btn.setAttribute("aria-label", "Something in the way? Send feedback");
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Feedback';
  // !important so a page's own button rules (width:100%, min-height) cannot resize it
  btn.style.cssText = "position:fixed!important;right:12px!important;bottom:12px!important;left:auto!important;top:auto!important;z-index:9999;width:auto!important;min-height:0!important;height:auto!important;margin:0!important;background:#1f3a5f!important;color:#fff!important;border:none!important;border-radius:18px!important;padding:8px 12px!important;font-size:12.5px!important;font-weight:700!important;line-height:1!important;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);font-family:system-ui,sans-serif!important;opacity:.92;";

  const panel = document.createElement("div");
  panel.style.cssText = "position:fixed;right:12px;bottom:52px;z-index:9999;background:#fff;border:1px solid #d5dbe3;border-radius:10px;padding:14px;width:300px;max-width:calc(100vw - 24px);display:none;box-shadow:0 6px 20px rgba(0,0,0,.2);font-family:system-ui,sans-serif;";
  panel.innerHTML =
    '<div style="font-weight:700;font-size:14px;color:#1c242e;margin-bottom:8px">Something in the way?</div>' +
    '<textarea id="fbw-msg" rows="3" placeholder="What is slowing you down?" style="width:100%;border:1px solid #d5dbe3;border-radius:6px;padding:8px;font-size:14px;font-family:inherit;box-sizing:border-box"></textarea>' +
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

  // Staged preview: a bar that never goes away, with a live-version reminder.
  function stagedBar(liveVersion) {
    let bar = document.getElementById("sos-staged-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "sos-staged-bar";
      bar.style.cssText = "position:sticky;top:0;z-index:10001;background:#c2620a;color:#fff;padding:9px 14px;font-size:13.5px;font-weight:700;font-family:system-ui,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.25);";
      document.body.insertBefore(bar, document.body.firstChild);
      document.body.style.borderTop = "4px dashed #c2620a";
    }
    const back = location.pathname.replace("/staging/", "/");
    bar.innerHTML = "PREVIEW of version " + version + " (not on the floor)" + (liveVersion ? " · the floor is on version " + liveVersion : "") +
      ' · <a href="' + back + '" style="color:#fff;text-decoration:underline">open the live page</a>';
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

  document.addEventListener("DOMContentLoaded", init);
  if (document.readyState !== "loading") init();
  function init() {
    if (document.getElementById("fbw-send")) return;
    document.body.appendChild(btn);
    document.body.appendChild(panel);
    watchVersion();
    const nameEl = panel.querySelector("#fbw-name");
    try { nameEl.value = localStorage.getItem("sos.name") || ""; } catch (e) {}
    panel.querySelector("#fbw-send").onclick = async () => {
      const msg = panel.querySelector("#fbw-msg").value.trim();
      if (!msg) return;
      try { localStorage.setItem("sos.name", nameEl.value); } catch (e) {}
      const res = await fetch("/api/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, module: mod, page: location.pathname, message: msg, name: nameEl.value }),
      });
      if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); return; }
      panel.querySelector("#fbw-msg").value = "";
      panel.querySelector("#fbw-done").style.display = "block";
      setTimeout(() => { panel.style.display = "none"; panel.querySelector("#fbw-done").style.display = "none"; }, 1500);
    };
  }
})();
