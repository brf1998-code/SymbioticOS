// The module gate: checks the platform runs on a module version's FILES, with
// no tokens and without loading any of its code, before that version is
// staged, deployed or switched to.
//
// Why it exists: the platform loads a module's routes.js into its own process
// (registry.buildRouter). The build agent is fenced (file tools only, an env
// allow-list), but the code it writes runs with everything the server has:
// process.env, the disk, the network, every schema in the database. Until
// module code runs in a process of its own (tenancy trade study, option C),
// this gate is what stands between a build and that process.
//
// What it is NOT: a security boundary. A determined author can get past any
// text check. It stops the careless build and the lazily steered one, and it
// turns the lane rules from a line in a prompt into something the platform
// enforces.
//
// Four rule sets:
//   server files  every .js file in the module. Only relative requires; no
//                 process / global / eval / network / file serving; no SQL
//                 that reaches outside the module's own tables or changes the
//                 data model at run time.
//   pages         every .html file: no naming the platform's own controls, no
//                 popups, frames, workers or anything loaded from outside. The
//                 platform also serves module pages under a browser policy
//                 that enforces this (registry.modulePagePolicy); the rule
//                 here says so at build time.
//   layout        no package.json, node_modules, native or wasm files, links;
//                 module.json "entry" stays a .js file inside the module.
//   lane          ui lane: only pages/, tour.json, reference.md and the labels
//                 in module.json may differ from the version the build started
//                 from. Any lane: a migration that already exists is never
//                 edited or removed.
//
// Grandfathering: a server-file finding that is already present, word for
// word, in the version the build started from is reported as "inherited" and
// does not stop the build. The change did not introduce it, and stopping every
// later build would not remove it from the floor. Boot logs inherited
// findings on live versions so they can be cleaned up deliberately.
//
// No dependency on the registry or the database: this file only reads text.
const fs = require("fs");
const path = require("path");

const SERVER_FILE = /\.(js|cjs)$/i;
const REFUSED_FILE = /\.(node|wasm|so|dylib|dll|mjs|sh|exe)$/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// ---- a small JavaScript scanner ---------------------------------------------
// Blanks comments, string text, template text and regex literals while keeping
// every character position, so an index in `code` is the same index in the
// source. `strings` carries the text that was blanked (quoted strings and the
// literal parts of templates), for the SQL rules.
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const REGEX_AFTER_PUNCT = "(,=:[!&|?{};+-*%<>~^";

function scan(src) {
  const n = src.length;
  const out = src.split("");
  const strings = [];
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== "\n") out[k] = " "; };
  const fail = (problem, at) => ({ ok: false, problem, line: lineOf(src, at), code: out.join(""), strings });
  const modes = [{ t: "code", braces: 0, fromTemplate: false }];
  let i = 0;
  let prev = "";      // last significant character, to tell a regex from a division
  let prevWord = "";  // set when the last token was a word
  while (i < n) {
    const m = modes[modes.length - 1];
    const c = src[i], d = src[i + 1];
    if (m.t === "template") {
      if (c === "\\") { m.buf += src.slice(i, i + 2); blank(i, i + 2); i += 2; continue; }
      if (c === "`") { strings.push({ text: m.buf, index: m.start }); modes.pop(); i++; prev = ")"; prevWord = ""; continue; }
      if (c === "$" && d === "{") {
        strings.push({ text: m.buf, index: m.start }); m.buf = ""; m.start = i;
        modes.push({ t: "code", braces: 0, fromTemplate: true }); i += 2; prev = "{"; prevWord = ""; continue;
      }
      m.buf += c; blank(i, i + 1); i++; continue;
    }
    if (c === "/" && d === "/") { let e = src.indexOf("\n", i); if (e < 0) e = n; blank(i, e); i = e; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); if (e < 0) return fail("a comment is never closed", i); blank(i, e + 2); i = e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, buf = "";
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") { buf += src.slice(j, j + 2); j += 2; continue; }
        if (src[j] === "\n") return fail("a quoted string runs past the end of its line", i);
        buf += src[j]; j++;
      }
      if (j >= n) return fail("a quoted string is never closed", i);
      strings.push({ text: buf, index: i }); blank(i + 1, j); i = j + 1; prev = ")"; prevWord = ""; continue;
    }
    if (c === "`") { modes.push({ t: "template", buf: "", start: i }); i++; continue; }
    if (c === "/") {
      const regexOk = prevWord ? REGEX_AFTER_WORD.has(prevWord) : (prev === "" || REGEX_AFTER_PUNCT.includes(prev));
      if (regexOk) {
        let j = i + 1, inClass = false, closed = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "[") inClass = true;
          else if (src[j] === "]") inClass = false;
          else if (src[j] === "/" && !inClass) { closed = true; break; }
          j++;
        }
        if (closed) {
          j++;
          while (j < n && /[a-z]/i.test(src[j])) j++;
          blank(i, j); i = j; prev = ")"; prevWord = ""; continue;
        }
      }
      prev = "/"; prevWord = ""; i++; continue;
    }
    if (c === "{") { m.braces++; prev = c; prevWord = ""; i++; continue; }
    if (c === "}") {
      if (m.fromTemplate && m.braces === 0) { modes.pop(); i++; continue; }
      m.braces--; prev = c; prevWord = ""; i++; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      prevWord = src.slice(i, j); prev = src[j - 1]; i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      prev = "0"; prevWord = ""; i = j; continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    prev = c; prevWord = ""; i++;
  }
  if (modes.length > 1) return fail("a template string is never closed", modes[modes.length - 1].start || 0);
  return { ok: true, code: out.join(""), strings };
}

function lineOf(src, index) {
  let line = 1;
  for (let k = 0; k < index && k < src.length; k++) if (src[k] === "\n") line++;
  return line;
}
function lineText(src, index) {
  const a = src.lastIndexOf("\n", index - 1) + 1;
  let b = src.indexOf("\n", index); if (b < 0) b = src.length;
  return src.slice(a, b).trim().slice(0, 200);
}

// ---- server-file rules --------------------------------------------------------
// Names module code may not use on their own (a property such as row.process,
// or an object key such as { process: ... }, is fine).
const FORBIDDEN_NAMES = [
  ["process", "reads the platform's own settings and passwords"],
  ["global", "reaches the platform's internals"],
  ["globalThis", "reaches the platform's internals"],
  ["eval", "runs text as code"],
  ["Function", "runs text as code"],
  ["fetch", "reaches the network; outside systems are reached only through the services the platform lends on ctx"],
  ["XMLHttpRequest", "reaches the network"],
  ["WebSocket", "reaches the network"],
  ["EventSource", "reaches the network"],
  ["WebAssembly", "runs code the platform cannot read"],
  ["import", "loads code from outside the module"],
];
// Calls that hand files on the server's disk to a browser.
const FORBIDDEN_CALLS = [
  [/\.\s*(static|sendFile|sendfile|download|render)\s*\(/g, (m) => `.${m[1]}(`, "serves files from the platform's own disk; pages are served by the platform from module.json"],
  [/\.\s*(constructor|__proto__)\b/g, (m) => `.${m[1]}`, "reaches for the language's internals"],
  [/\.\s*(removeHeader|writeHead)\s*\(/g, (m) => `.${m[1]}(`, "rewrites the answer's headers; the platform sets the rules a module's screens run under"],
];
// Headers only the platform sets on a module's answers (registry.lockDown).
const LOCKED_HEADER_TEXT = /content-security-policy|service-worker-allowed/i;
// SQL that leaves the module's own tables or changes the data model at run time.
const SQL_RULES = [
  ["sql-platform", /\bplatform\s*\.\s*\w/i, "reads or writes the platform's own records"],
  ["sql-other-module", /\b(?:mod|stg|snap)_[a-z0-9]+_[a-z0-9_]*\s*\.\s*\w/i, "names another module's tables directly; ctx.peer(name) is the way to read a sibling module"],
  ["sql-server", /\b(?:information_schema|pg_catalog|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_sleep|lo_import|lo_export|dblink|set_config)\b/i, "reaches into the database server itself"],
  ["sql-scope", /\bsearch_path\b|\bSET\s+(?:SESSION\s+|LOCAL\s+)?ROLE\b|\bSET\s+SESSION\s+AUTHORIZATION\b/i, "changes which tables a query can see"],
  ["sql-copy", /\bCOPY\b[\s\S]{0,200}?\b(?:FROM|TO)\s+(?:PROGRAM\b|')/i, "moves data through files or programs on the database server"],
  ["sql-ddl", /\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:TEMP\s+|TEMPORARY\s+|UNIQUE\s+|MATERIALIZED\s+)?(?:TABLE|SCHEMA|INDEX|VIEW|ROLE|USER|DATABASE|EXTENSION|FUNCTION|PROCEDURE|TRIGGER|TYPE|SEQUENCE|POLICY)\b|\bTRUNCATE\s+(?:TABLE\b|[a-z_]+\s*(?:;|$|RESTART\b|CASCADE\b))|\bDO\s+\$/i, "changes what the tool keeps while it is running; that belongs in a new migrations file"],
  ["sql-grant", /\b(?:GRANT|REVOKE)\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE|USAGE|CONNECT|EXECUTE)\b/i, "changes who may read the data"],
];

function nameRegex(name) { return new RegExp(`(^|[^.\\w$])(${name.replace(/\$/g, "\\$")})(?![\\w$])`, "g"); }

// Findings for one server file. `files` is the module's whole file map, for
// resolving relative requires.
function checkServerFile(rel, src, files) {
  const found = [];
  const seenAt = new Set();   // one finding per rule per line, however many times the line does it
  const add = (rule, index, what, why) => {
    const ln = lineOf(src, index);
    if (seenAt.has(`${rule}:${ln}`)) return;
    seenAt.add(`${rule}:${ln}`);
    found.push({ rule, file: rel, line: ln, what, why, evidence: lineText(src, index) });
  };
  const s = scan(src);
  if (!s.ok) { found.push({ rule: "unreadable", file: rel, line: s.line, what: "could not be read reliably", why: s.problem, evidence: "" }); return found; }
  const code = s.code;

  for (const [name, why] of FORBIDDEN_NAMES) {
    const re = nameRegex(name);
    let m;
    while ((m = re.exec(code))) {
      const at = m.index + m[1].length;
      // an object key ({ process: "cutting" }) is not a use; the middle of a ternary (x ? process : y) is
      if (/^\s*:(?!:)/.test(code.slice(at + name.length)) && !/(?<!\?)\?(?![.?])[^:]*$/.test(code.slice(Math.max(0, at - 120), at))) continue;
      add(`name-${name}`, at, `uses \`${name}\``, why);
    }
  }
  // `module` only as module.exports
  { const re = nameRegex("module"); let m;
    while ((m = re.exec(code))) {
      const at = m.index + m[1].length;
      const after = code.slice(at + 6);
      if (/^\s*\.\s*exports\b/.test(after) || /^\s*:(?!:)/.test(after)) continue;
      add("name-module", at, "uses `module` for something other than module.exports", "reaches the platform's internals");
    } }
  // require: a literal path to a .js or .json file inside the module, nothing else
  { const re = nameRegex("require"); let m;
    while ((m = re.exec(code))) {
      const at = m.index + m[1].length;
      if (/^\s*:(?!:)/.test(code.slice(at + 7))) continue;
      const lit = /^require\s*\(\s*(["'])(\.\/[^"'\\]+)\1\s*\)/.exec(src.slice(at, at + 300));
      if (!lit) { add("require-outside", at, "loads code that is not a file inside the module", "module code may only load its own files, written as require(\"./name.js\"); express comes from ctx"); continue; }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), lit[2]));
      if (target.startsWith("..") || path.posix.isAbsolute(target)) { add("require-outside", at, `loads ${lit[2]}, which is outside the module`, "module code may only load its own files"); continue; }
      const hit = [target, `${target}.js`, `${target}.json`, `${target}/index.js`].find((p) => Object.prototype.hasOwnProperty.call(files, p));
      if (!hit || !/\.(js|cjs|json)$/i.test(hit)) add("require-missing", at, `loads ${lit[2]}, which is not a .js or .json file in the module`, "module code may only load its own .js and .json files");
    } }
  for (const [re, label, why] of FORBIDDEN_CALLS) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(code))) add(`call-${m[1]}`, m.index, `calls \`${label(m)}\``, why);
  }
  for (const str of s.strings) {
    if (str.text === "constructor" || str.text === "__proto__" || str.text === "prototype") add("name-internals", str.index, `reaches for \`${str.text}\` by name`, "reaches for the language's internals");
    if (LOCKED_HEADER_TEXT.test(str.text)) add("header-policy", str.index, "sets the rules its own screens run under", "the platform sets those rules for every module; a module cannot loosen them");
    for (const [rule, re, why] of SQL_RULES) if (re.test(str.text)) add(rule, str.index, "a query that leaves the module's own tables or reshapes them", why);
  }
  return found;
}

// ---- page rules ----------------------------------------------------------------------
// A module's screens run in the manager's browser. The platform serves them
// with a policy that ties the browser to the module (registry.modulePagePolicy),
// so these would not work anyway; saying so at build time beats a screen that
// fails quietly on the floor, and a screen that names the platform's own
// controls is worth stopping on sight.
const PAGE_FILE = /\.html?$/i;
const PAGE_RULES = [
  ["page-platform", /\/api\/(?:admin|proposals|intakes|attachments)\b|\/api\/c\//i, "names the platform's own controls", "a screen talks only to its own module, through paths built from its own address (base + \"/api/...\")"],
  ["page-popup", /window\s*\.\s*open\s*\(|target\s*=\s*["']?_blank/i, "opens another window or tab", "screens stay in one window; print with window.print() and a print stylesheet"],
  ["page-frame", /<\s*(?:iframe|frame|object|embed)\b/i, "puts another page inside the screen", "screens do not frame other pages"],
  ["page-worker", /serviceWorker|new\s+(?:Shared)?Worker\s*\(/i, "installs code that keeps running behind the screen", "screens do not install workers"],
  ["page-external", /<\s*(?:script|link|img|video|audio|source)\b[^>]*\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i, "loads something from outside the platform", "everything a screen needs is inline or inside the module; the floor may have no internet"],
];
function checkPageFile(rel, src) {
  const found = [];
  for (const [rule, re, what, why] of PAGE_RULES) {
    const m = re.exec(src);
    if (m) found.push({ rule, file: rel, line: lineOf(src, m.index), what, why, evidence: lineText(src, m.index) });
  }
  return found;
}

// A finding's identity without its line number, to recognise one the build inherited.
const keyOf = (f) => `${f.rule}|${f.file}|${f.evidence.replace(/\s+/g, " ")}`;

// ---- layout rules -----------------------------------------------------------------
function checkLayout(files) {
  const found = [];
  const add = (rule, file, what, why) => found.push({ rule, file, line: 0, what, why, evidence: "" });
  for (const rel of Object.keys(files)) {
    const parts = rel.split("/");
    if (parts.includes("node_modules")) add("layout-node-modules", rel, "brings its own code library", "no new dependencies; module code uses what ctx lends it");
    else if (/^package(-lock)?\.json$/i.test(parts[parts.length - 1])) add("layout-package", rel, "adds a package file", "a module is plain files; it cannot change how its code is loaded");
    else if (REFUSED_FILE.test(rel)) add("layout-file-kind", rel, "is a kind of file the platform does not load", "a module is .js, .json, .sql, .html and .md files");
  }
  // checks/ holds the promises earlier changes made (src/acceptance.js): small "call this, expect that" files the
  // platform runs against every later build. One that does not read is refused here, before anything runs.
  const acceptance = require("./acceptance");
  for (const rel of Object.keys(files).filter((r) => r.startsWith(acceptance.DIR))) {
    const parsed = acceptance.parse(rel, String(files[rel] || ""));
    if (!parsed.ok) add("check-format", rel, "is not a check the platform can run", parsed.problems.slice(0, 4).join("; "));
  }
  let manifest = null;
  if (files["module.json"] != null) { try { manifest = JSON.parse(files["module.json"]); } catch (e) { add("layout-manifest", "module.json", "does not parse", e.message); } }
  else add("layout-manifest", "module.json", "is missing", "every module carries a module.json");
  if (manifest) {
    const entry = String(manifest.entry || "routes.js");
    const norm = path.posix.normalize(entry);
    if (!/^[\w./-]+\.js$/.test(entry) || norm.startsWith("..") || path.posix.isAbsolute(norm)) add("layout-entry", "module.json", `names "${entry}" as its entry`, "the entry is a .js file inside the module");
    // connections: declared by kind the platform supports, each with what
    // that kind needs; a printer's labels are files in labels/
    const decl = require("./connections").declared(manifest);
    for (const e of decl.errors) add("layout-connections", "module.json", e, "a module declares what it needs from outside in module.json and reaches it only through ctx.connections");
    for (const [name, d] of Object.entries(decl.connections)) {
      if (d.kind === "printer") for (const t of d.templates) if (files[`labels/${t}.zpl`] == null) add("layout-connections", "module.json", `connection "${name}" names a label "${t}" but labels/${t}.zpl is not in the module`, "every label a printer connection names is a file in labels/");
    }
  }
  return found;
}

// ---- lane rules ----------------------------------------------------------------------
const UI_MAY_CHANGE = (rel) => rel.startsWith("pages/") || rel.startsWith("labels/") || rel === "tour.json" || rel === "reference.md";
function manifestCore(text) {
  try {
    const m = JSON.parse(text || "{}");
    const pages = {};
    for (const [route, v] of Object.entries(m.pages || {})) pages[route] = typeof v === "string" ? v : (v && v.file) || "";
    return JSON.stringify({ name: m.name || null, entry: m.entry || "routes.js", smoke: m.smoke || [], agents: m.agents || null, connections: m.connections || null, pages });
  } catch (e) { return `unparsed:${text}`; }
}
function describe(rel) {
  if (rel === "routes.js" || SERVER_FILE.test(rel)) return `${rel} (how the tool works)`;
  if (rel.startsWith("migrations/")) return `${rel} (what the tool keeps)`;
  if (rel.startsWith("checks/")) return `${rel} (a promise an earlier change made)`;
  if (rel === "module.json") return "module.json (the tool's screens, entry or checks list)";
  return rel;
}
function checkLane(files, fromFiles, lane) {
  const found = [];
  if (!fromFiles) return found;
  const all = new Set([...Object.keys(files), ...Object.keys(fromFiles)]);
  for (const rel of [...all].sort()) {
    const before = fromFiles[rel], after = files[rel];
    if (before === after) continue;
    if (rel.startsWith("migrations/") && before != null) {
      found.push({ rule: "lane-migration-edited", file: rel, label: describe(rel), line: 0, what: after == null ? "was removed" : "was edited", why: "a migration that already exists is never changed; add the next numbered file instead", evidence: "" });
      continue;
    }
    // a check that is already there is a promise the floor relies on: a build adds the next one, it never edits or
    // removes one (retiring a promise is the manager's call, kept in platform.check_retirements, not in the file)
    if (rel.startsWith("checks/") && before != null) {
      found.push({ rule: "lane-check-edited", file: rel, label: describe(rel), line: 0, what: after == null ? "was removed" : "was edited", why: "a check that already exists is never changed; if your change breaks it, change your work, and add your own check as the next numbered file", evidence: "" });
      continue;
    }
    if (lane !== "ui" || UI_MAY_CHANGE(rel)) continue;
    if (rel === "module.json" && before != null && after != null && manifestCore(before) === manifestCore(after)) continue;   // labels, title, description only
    found.push({ rule: "lane-ui-file", file: rel, label: describe(rel), line: 0, what: `was ${before == null ? "added" : after == null ? "removed" : "changed"}`, why: "this was approved as a look-and-feel change, which may only touch the screens in pages/ and the labels in labels/", evidence: "" });
  }
  return found;
}

// ---- entry points ---------------------------------------------------------------------
// files / fromFiles: { "routes.js": "text", "pages/board.html": "text", ... }
// lane: "ui" | "functionality" | "module" | null (null = server and layout rules only)
function check({ files, fromFiles = null, lane = null }) {
  files = files || {};
  const read = (set) => {
    const out = [];
    for (const [rel, text] of Object.entries(set)) {
      if (SERVER_FILE.test(rel)) out.push(...checkServerFile(rel, String(text || ""), set));
      else if (PAGE_FILE.test(rel)) out.push(...checkPageFile(rel, String(text || "")));
    }
    return out;
  };
  const server = read(files);
  const inheritedKeys = new Set(fromFiles ? read(fromFiles).map(keyOf) : []);
  const inherited = server.filter((f) => inheritedKeys.has(keyOf(f)));
  const violations = [...checkLayout(files), ...server.filter((f) => !inheritedKeys.has(keyOf(f))), ...checkLane(files, fromFiles, lane)];
  return { ok: violations.length === 0, violations, inherited, lane, checked: Object.keys(files).filter((r) => SERVER_FILE.test(r)) };
}

// Read a version directory without following links, then check it.
function checkDir(dir, opts = {}) {
  const files = {};
  const extra = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isSymbolicLink()) { extra.push({ rule: "layout-link", file: r, line: 0, what: "is a link to somewhere else on the disk", why: "a module is plain files inside its own folder", evidence: "" }); continue; }
      if (st.isDirectory()) { walk(r); continue; }
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) { extra.push({ rule: "layout-size", file: r, line: 0, what: `is ${Math.round(st.size / 1024)} KB`, why: "module files stay under 2 MB each", evidence: "" }); continue; }
      files[r] = fs.readFileSync(path.join(dir, r), "utf8");
    }
  };
  walk("");
  const v = check({ files, fromFiles: opts.fromFiles || null, lane: opts.lane || null });
  if (extra.length) { v.violations.unshift(...extra); v.ok = false; }
  return v;
}

// ---- wording ---------------------------------------------------------------------------------
function line(f) { return `${f.label || f.file}${f.line ? `, line ${f.line}` : ""}: ${f.what}. ${capitalize(f.why)}.`; }
function capitalize(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }

// For the card (the board puts "The platform's own checks stopped it" above this).
function summarize(v) {
  const head = v.violations.some((f) => f.rule === "lane-ui-file")
    ? "It was approved as a look-and-feel change, but the build changed more than the screens. Send it back to be fixed, or cancel and approve it again as a functionality change so it gets the full review."
    : v.violations.every((f) => f.rule === "check-format" || f.rule === "lane-check-edited")
      ? "A check is a promise an earlier change made to the floor. A build adds its own check and never changes an older one."
      : "Module code may only work with its own tables and the services the platform lends it.";
  return `${head}\n${v.violations.map((f) => `- ${line(f)}`).join("\n")}`;
}

// A fix round is a new agent session: it cannot know what a file looked like
// before the last attempt touched it. So for the lane rules the platform puts
// the files back itself (from the version the build started from) and tells
// the agent it did. `rec` is the record() stored on the run. Returns the files
// it restored.
function restoreLaneFiles(dir, fromFiles, rec) {
  const restored = [];
  if (!fromFiles || !rec || !Array.isArray(rec.violations)) return restored;
  for (const f of rec.violations) {
    if (f.rule !== "lane-ui-file" && f.rule !== "lane-migration-edited" && f.rule !== "lane-check-edited") continue;
    const rel = path.posix.normalize(String(f.file || ""));
    if (!rel || rel.startsWith("..") || path.posix.isAbsolute(rel)) continue;
    const p = path.join(dir, rel);
    if (fromFiles[rel] == null) { fs.rmSync(p, { force: true }); restored.push(`${rel} (removed)`); }
    else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, fromFiles[rel]); restored.push(rel); }
  }
  return restored;
}
// What the agent is told in the fix round.
function forAgent(rec, restored) {
  const rest = (rec.violations || []).filter((f) => f.rule !== "lane-ui-file" && f.rule !== "lane-migration-edited" && f.rule !== "lane-check-edited");
  let text = "The platform's own checks refused the previous attempt before any of it ran.";
  if (restored && restored.length) text += `\nThe platform has put these files back exactly as they were before that attempt: ${restored.join(", ")}. Do not touch them again. ${rec.lane === "ui" ? "This is a look-and-feel change: make it work in pages/ only. If it cannot work without server logic, change nothing more and say so in your summary." : "A migration or a check that already exists is never edited; put the change in the next numbered file. If an older check no longer passes, change your work so it does."}`;
  if (rest.length) text += `\nFix exactly these, and keep everything else as it is:\n${rest.map((f) => `- ${line(f)}${f.evidence ? ` The line: ${f.evidence}` : ""}`).join("\n")}`;
  return text;
}
function oneLine(v) { return v.violations.slice(0, 3).map(line).join(" ") + (v.violations.length > 3 ? ` (and ${v.violations.length - 3} more)` : ""); }
// As findings in the cross-check shape, so the board, the fix round and the checks log need nothing new.
function asFindings(v) { return v.violations.map((f) => ({ severity: "blocking", where: `${f.file}${f.line ? `, line ${f.line}` : ""}`, what: `${f.what}: ${f.why}`, evidence: f.evidence || "", rule: f.rule })); }
// What goes on the run's evidence.
function record(v) { return { ok: v.ok, lane: v.lane, checked: v.checked, violations: v.violations, inherited: v.inherited }; }

module.exports = { check, checkDir, summarize, oneLine, asFindings, record, restoreLaneFiles, forAgent, scan, checkServerFile, checkPageFile };
