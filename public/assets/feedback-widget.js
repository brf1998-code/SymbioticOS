// Feedback widget — injected into every module page by the runtime.
// Posts to the platform's /api/feedback with the module name and page path.
// It also watches the module's version: when the manager deploys a new
// version, every open page reloads itself and shows a short "updated" banner.
(function () {
  const script = document.currentScript;
  const mod = script ? script.getAttribute("data-module") : null;
  const version = script ? script.getAttribute("data-version") : null;
  const mount = script ? script.getAttribute("data-mount") : null;

  function banner(text) {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:10000;background:#2e7d4f;color:#fff;border-radius:20px;padding:10px 18px;font-size:14px;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.25);font-family:system-ui,sans-serif;";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }
  function watchVersion() {
    if (!mod || !version || mod === "platform") return;
    const key = "sos.updated." + mod;
    try {
      const v = sessionStorage.getItem(key);
      if (v) { sessionStorage.removeItem(key); banner("This page was just updated (version " + v + ")"); }
    } catch (e) {}
    setInterval(async () => {
      try {
        const r = await fetch("/api/modules/" + mod + "/version", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        const current = mount === "staged" ? j.staged_version : j.live_version;
        if (current && String(current) !== String(version)) {
          try { sessionStorage.setItem(key, String(current)); } catch (e) {}
          location.reload();
        }
      } catch (e) {}
    }, 5000);
  }

  const btn = document.createElement("button");
  btn.textContent = "Something in the way?";
  btn.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:9999;background:#1f3a5f;color:#fff;border:none;border-radius:22px;padding:12px 18px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);font-family:system-ui,sans-serif;";

  const panel = document.createElement("div");
  panel.style.cssText = "position:fixed;right:16px;bottom:68px;z-index:9999;background:#fff;border:1px solid #d5dbe3;border-radius:10px;padding:14px;width:300px;max-width:calc(100vw - 32px);display:none;box-shadow:0 6px 20px rgba(0,0,0,.2);font-family:system-ui,sans-serif;";
  panel.innerHTML =
    '<div style="font-weight:700;font-size:14px;color:#1c242e;margin-bottom:8px">Report friction</div>' +
    '<textarea id="fbw-msg" rows="3" placeholder="What is slowing you down?" style="width:100%;border:1px solid #d5dbe3;border-radius:6px;padding:8px;font-size:14px;font-family:inherit;box-sizing:border-box"></textarea>' +
    '<input id="fbw-name" placeholder="Your name (optional)" style="width:100%;border:1px solid #d5dbe3;border-radius:6px;padding:8px;font-size:14px;margin-top:8px;font-family:inherit;box-sizing:border-box">' +
    '<button id="fbw-send" style="margin-top:10px;width:100%;background:#2e7d4f;color:#fff;border:none;border-radius:6px;padding:11px;font-size:14px;font-weight:700;cursor:pointer">Send</button>' +
    '<div id="fbw-done" style="display:none;color:#2e7d4f;font-size:13px;margin-top:8px">Sent. It goes straight on the improvement board.</div>';

  btn.onclick = () => { panel.style.display = panel.style.display === "none" ? "block" : "none"; };

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
        body: JSON.stringify({ module: mod, page: location.pathname, message: msg, name: nameEl.value }),
      });
      if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); return; }
      panel.querySelector("#fbw-msg").value = "";
      panel.querySelector("#fbw-done").style.display = "block";
      setTimeout(() => { panel.style.display = "none"; panel.querySelector("#fbw-done").style.display = "none"; }, 1500);
    };
  }
})();
