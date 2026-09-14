// Company brand: a styling guide built from the company's own website.
//
// The admin gives a URL when creating a company (or later). The platform
// fetches the page and its stylesheets (the build agent has no network), pulls
// the raw signals out (title, colors by frequency, CSS variables, fonts, logo,
// icon, nav wording) and asks a model (Fable by default) to write BRAND.md: a
// short guide every agent run reads, plus a few structured values the board
// uses directly (band color, favicon). Then each module the company gets is
// restyled by a normal build run (one UI proposal per screen) that stops at
// the deploy gate like any other change, so the manager sees the branded
// version in the preview before it goes live.
const { q, logEvent, upsertDoc } = require("./db");
const { runStructured, haveKey, fakeMode, MODELS } = require("./agent");
const registry = require("./registry");
const pipeline = require("./pipeline");

const FETCH_MS = 15000;
const MAX_HTML = 1500 * 1024;
const MAX_CSS = 300 * 1024;
const MAX_ICON = 400 * 1024;
// a browser-like agent string: many corporate sites answer 403 to anything that looks like a bot
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

async function getText(url, max) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,text/css,*/*" }, redirect: "follow", signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} from ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { text: buf.slice(0, max).toString("utf8"), type: res.headers.get("content-type") || "", url: res.url || url };
  } finally { clearTimeout(t); }
}

async function getBinary(url, max) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: ctl.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > max) return null;
    const type = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!/^image\//.test(type)) return null;
    return { data: buf, type };
  } catch (e) { return null; } finally { clearTimeout(t); }
}

const attr = (tag, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag); return m ? (m[2] ?? m[3] ?? m[4] ?? "") : ""; };
const tags = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) || [];
const abs = (base, href) => { try { return new URL(href, base).href; } catch (e) { return null; } };
function topCounts(list, n) {
  const c = new Map();
  for (const x of list) c.set(x, (c.get(x) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([v, k]) => `${v} (x${k})`);
}

// Pull the signals out of the page. Regex over HTML is enough here: we want
// hints for a model, not a DOM.
async function readSite(url) {
  const page = await getText(url, MAX_HTML);
  const html = page.text;
  const base = page.url;
  const meta = {};
  for (const t of tags(html, "meta")) {
    const k = (attr(t, "property") || attr(t, "name") || "").toLowerCase();
    if (/^(description|og:site_name|og:title|og:image|theme-color|application-name)$/.test(k)) meta[k] = attr(t, "content");
  }
  const title = ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "").replace(/\s+/g, " ").trim();
  const links = tags(html, "link");
  const icons = links.filter((t) => /icon/i.test(attr(t, "rel"))).map((t) => ({ rel: attr(t, "rel").toLowerCase(), href: abs(base, attr(t, "href")), sizes: attr(t, "sizes") }));
  const sheets = links.filter((t) => /stylesheet/i.test(attr(t, "rel"))).map((t) => abs(base, attr(t, "href"))).filter(Boolean).slice(0, 5);
  let css = (html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) || []).join("\n");
  for (const href of sheets) {
    try { css += "\n" + (await getText(href, MAX_CSS)).text; } catch (e) { /* skip */ }
  }
  const inline = (html.match(/style\s*=\s*"[^"]*"/gi) || []).join("\n");
  const colorSrc = css + "\n" + inline;
  const hex = (colorSrc.match(/#(?:[0-9a-f]{3}){1,2}\b/gi) || []).map((c) => c.toLowerCase());
  const rgb = colorSrc.match(/rgba?\([^)]*\)/gi) || [];
  const vars = (css.match(/--[\w-]+\s*:\s*[^;}]+/g) || []).map((v) => v.replace(/\s+/g, " ").trim()).filter((v) => /#|rgb|hsl|font|sans|serif/i.test(v));
  const fonts = (colorSrc.match(/font-family\s*:\s*[^;}]+/gi) || []).map((f) => f.replace(/font-family\s*:\s*/i, "").replace(/\s+/g, " ").trim());
  const logos = tags(html, "img").filter((t) => /logo/i.test(attr(t, "src") + " " + attr(t, "alt") + " " + attr(t, "class"))).map((t) => ({ src: abs(base, attr(t, "src")), alt: attr(t, "alt") })).slice(0, 4);
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ").trim();
  return {
    url: base, title, meta, icons, logos,
    colors: topCounts(hex, 16), rgbColors: topCounts(rgb.map((c) => c.replace(/\s+/g, "")), 8), cssVars: [...new Set(vars)].slice(0, 40),
    fonts: topCounts(fonts, 8), text: text.slice(0, 2500), stylesheets: sheets.length, cssBytes: css.length,
  };
}

// Best icon: the largest apple-touch-icon, else any declared icon, else /favicon.ico.
async function readIcon(site) {
  const cands = [...site.icons].sort((a, b) => {
    const s = (x) => (/apple/.test(x.rel) ? 1000 : 0) + (parseInt(x.sizes, 10) || 0);
    return s(b) - s(a);
  }).map((i) => i.href).filter(Boolean);
  cands.push(abs(site.url, "/apple-touch-icon.png"), abs(site.url, "/favicon.ico"));
  for (const href of cands) {
    const got = await getBinary(href, MAX_ICON);
    if (got) return { dataUrl: `data:${got.type};base64,${got.data.toString("base64")}`, type: got.type, from: href };
  }
  return null;
}

const GUIDE_SCHEMA = {
  type: "object",
  properties: {
    company_name: { type: "string", description: "How the company writes its own name." },
    primary: { type: "string", description: "Main brand color as 6-digit hex, used for headers and primary actions. Must read well with white text on it." },
    accent: { type: "string", description: "Secondary/attention color as hex." },
    background: { type: "string", description: "Page background hex (light)." },
    ink: { type: "string", description: "Body text hex (dark)." },
    font_stack: { type: "string", description: "CSS font-family stack. If the brand font is not a system font, give the brand font first with a system fallback." },
    tone: { type: "string", description: "Three to eight words on voice: e.g. plain, direct, industrial." },
    guide_md: { type: "string", description: "The BRAND.md guide for build agents, 250 to 500 words of Markdown. Sections: Name and voice; Colors (with hex and where each is used: header band, primary action, attention, danger, background, text); Type (font stack, weights, size guidance for operator screens); Shapes and spacing (radius, borders, density); Logo and icon (text treatment when no image is available; never draw a logo); Do and do not. Written for an agent restyling factory-floor screens: keep every operator-first rule (big touch targets, plain words, high contrast). No em or en dashes." },
  },
  required: ["company_name", "primary", "accent", "background", "ink", "font_stack", "tone", "guide_md"],
};

async function setBrand(slug, patch) {
  const row = (await q("SELECT brand FROM platform.companies WHERE slug=$1", [slug])).rows[0];
  const brand = { ...(row && row.brand || {}), ...patch };
  await q("UPDATE platform.companies SET brand=$2 WHERE slug=$1", [slug, JSON.stringify(brand)]);
  return brand;
}

// Build (or rebuild) the guide. Runs in the background; status lives on
// companies.brand.status: building | done | failed.
async function buildGuide(slug, url, model) {
  model = model && MODELS.some((m) => m.id === model) ? model : "claude-fable-5-1";
  const co = (await q("SELECT * FROM platform.companies WHERE slug=$1", [slug])).rows[0];
  if (!co) throw new Error("unknown company");
  await setBrand(slug, { url, status: "building", model, error: null, started_at: new Date().toISOString() });
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error("URL must start with http:// or https://");
    const site = fakeMode() ? { url, title: "Fake site", meta: {}, icons: [], logos: [], colors: ["#1f3a5f (x9)"], rgbColors: [], cssVars: [], fonts: ["system-ui"], text: "Fake site text", stylesheets: 0, cssBytes: 0 } : await readSite(url);
    const icon = fakeMode() ? null : await readIcon(site);
    if (!haveKey()) throw new Error("ANTHROPIC_API_KEY not configured");
    const { data, costUsd } = await runStructured({
      model,
      maxTokens: 6000,
      system: "You write brand styling guides for software that runs on a factory floor. Input: raw signals scraped from the company's public website. Output: a short, concrete guide a build agent can follow when restyling operator screens, plus the key values as fields. Prefer the colors that repeat most and that look like brand colors (skip greys, pure black and white unless they are clearly the brand). Never invent a logo image; describe a text treatment instead. Plain words. No em or en dashes anywhere.",
      prompt: `Company: ${co.name} (slug ${slug})\nSite: ${site.url}\nTitle: ${site.title}\nMeta: ${JSON.stringify(site.meta)}\nIcons declared: ${site.icons.map((i) => `${i.rel} ${i.href}${i.sizes ? " " + i.sizes : ""}`).join("; ") || "none"}\nLogo images: ${site.logos.map((l) => `${l.src} (alt "${l.alt}")`).join("; ") || "none found"}\nMost frequent hex colors: ${site.colors.join(", ") || "none"}\nrgb() colors: ${site.rgbColors.join(", ") || "none"}\nCSS custom properties (colors/fonts): ${site.cssVars.join("; ") || "none"}\nFont families by frequency: ${site.fonts.join(" | ") || "none"}\nStylesheets read: ${site.stylesheets} (${site.cssBytes} bytes of CSS)\nVisible text (start): ${site.text}\n\nWrite the guide and the fields.`,
      schema: GUIDE_SCHEMA,
      toolName: "brand",
    });
    const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v).toLowerCase() : d);
    const colors = { primary: hex(data.primary, "#1f3a5f"), accent: hex(data.accent, "#c2620a"), background: hex(data.background, "#f2f4f7"), ink: hex(data.ink, "#1c242e") };
    const guide = String(data.guide_md || "").replace(/[–—]/g, ", ");
    await upsertDoc(slug, null, "BRAND.md", `${guide}\n\n<!-- built from ${site.url} on ${new Date().toISOString().slice(0, 10)} by ${model} -->\n`, "user", false);
    const brand = await setBrand(slug, {
      status: "done", built_at: new Date().toISOString(), cost_usd: Number((costUsd || 0).toFixed(4)), model,
      company_name: data.company_name, colors, font: data.font_stack, tone: data.tone,
      icon: icon ? icon.dataUrl : null, icon_type: icon ? icon.type : null, icon_from: icon ? icon.from : null,
      site_title: site.title, logos: site.logos.map((l) => l.src).filter(Boolean),
    });
    await logEvent("brand_built", slug, { url, model, costUsd, colors });
    return brand;
  } catch (e) {
    await setBrand(slug, { status: "failed", error: String(e.message || e), failed_at: new Date().toISOString() });
    await logEvent("brand_failed", slug, { url, error: String(e.message || e) });
    throw e;
  }
}

// Restyle one module to the brand: one approved UI proposal per screen, built
// as one batch run. Stops at the deploy gate.
async function restyleModule(slug, mod, opts = {}) {
  const co = (await q("SELECT * FROM platform.companies WHERE slug=$1", [slug])).rows[0];
  if (!co || !co.brand || co.brand.status !== "done") throw new Error("this company has no finished brand guide yet");
  const row = await registry.getModule(slug, mod);
  if (!row || !row.live_version) throw new Error("module is not live for this company");
  const manifest = registry.readManifest(slug, mod, row.live_version);
  const screens = registry.pageEntries(manifest);
  const files = new Map();
  for (const s of screens) if (!files.has(s.file)) files.set(s.file, s);
  const b = co.brand;
  const ids = [];
  for (const [file, s] of files) {
    const fb = (await q(
      `INSERT INTO platform.feedback (company, module, page, screen, target_file, message, name, status)
       VALUES ($1,$2,$3,$4,$5,$6,'Brand','reviewing') RETURNING id`,
      [slug, mod, s.route, s.label, file, `Restyle the ${s.label} to the ${b.company_name || co.name} brand.`])).rows[0];
    const p = (await q(
      `INSERT INTO platform.proposals (feedback_id, body, class, target_file, rationale, status, model) VALUES ($1,$2,'ui',$3,$4,'approved',$5) RETURNING id`,
      [fb.id,
        `Apply the company brand guide (BRAND.md) to the ${s.label}: header band and primary actions in ${b.colors.primary}, attention in ${b.colors.accent}, page background ${b.colors.background}, text ${b.colors.ink}, font stack ${b.font}. Put the company name "${b.company_name || co.name}" where the module names itself (page title, header). Keep every control, table, layout, wording and behavior exactly as it is; only appearance changes. Keep operator-first rules: big touch targets, high contrast, readable from ten feet.`,
        file, `Brand restyle from ${b.url}.`, b.model || null])).rows[0];
    ids.push(p.id);
  }
  const run = await pipeline.startRun(ids, { model: opts.model });
  await logEvent("brand_restyle_started", `${slug}/${mod}`, { run: run.id, screens: ids.length });
  return run;
}

module.exports = { buildGuide, restyleModule, readSite, readIcon };
