// A module's source as a model reads it. One place, because three readers use
// it: the proposer, the system review (both through proposals.moduleContext)
// and the diagrams.
//
// Found in the verification pass of 2026-09-19 against the 2026-09-18 product
// review: every reader got pages cut at 14,000 characters and every other file
// at 8,000 (10,000 for diagrams), in silence. On the library modules that was
// 8,000 of 21,603 characters of kpis/routes.js and 8,000 of 19,793 of
// paperline/routes.js, so a functionality proposal, a whole-module review and
// the data-flow drawing were all written from under half of the server file,
// and nothing told the model (or us) that anything was missing.
//
// The rule now: every file whole. There is one overall budget
// (SOS_CONTEXT_CHARS, default 400,000 characters, roughly 100k tokens, far
// above any module we have) so a runaway module cannot blow the model's
// window. When a module is over it, files are kept in order of how much a
// reader needs them (the screen the feedback came from first, then the
// manifest, the server file, the other screens, the docs, the rest), whatever
// does not fit is cut at the END of that order, every cut is marked in the
// text where it happens, a note at the top lists the cut files and tells the
// model not to assume what it cannot see, and the caller gets `cut` back so
// it lands on the record. Pure: no database, no clock.
const BUDGET = Math.max(20000, Number(process.env.SOS_CONTEXT_CHARS) || 400000);
const MIN_USEFUL = 600;   // a slice shorter than this tells a reader nothing; leave the file out and say so

// Lower rank = kept first.
function rank(name, first) {
  if (first.includes(name)) return 0;
  if (name === "module.json") return 1;
  if (name === "routes.js") return 2;
  if (/\.js$/.test(name)) return 3;
  if (name.startsWith("pages/")) return 4;
  if (name === "reference.md") return 5;
  if (name.startsWith("migrations/") || name.startsWith("checks/")) return 6;   // what the tool keeps, and what it has promised
  if (/\.md$/.test(name)) return 7;
  if (name === "tour.json") return 8;
  return 9;
}

// files: { name: text }. first: file names that matter most to this reader (the target screen).
// Returns { text, cut: [{ name, shown, of }], chars, total }.
function sourceText(files, { first = [], budget = BUDGET } = {}) {
  const names = Object.keys(files || {}).filter((n) => typeof files[n] === "string");
  const order = names.map((n, i) => ({ n, i, r: rank(n, first) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.n);
  const total = order.reduce((s, n) => s + files[n].length, 0);
  let left = Math.max(0, Number(budget) || 0);
  const cut = [];
  let body = "";
  for (const name of order) {
    const content = files[name], of = content.length;
    if (of <= left) { body += `\n--- ${name} ---\n${content}`; left -= of; continue; }
    const shown = left >= MIN_USEFUL ? left : 0;
    cut.push({ name, shown, of });
    body += shown
      ? `\n--- ${name} ---\n${content.slice(0, shown)}\n[CUT HERE: the first ${shown} of ${of} characters of ${name} are shown. The rest did not fit.]`
      : `\n--- ${name} ---\n[LEFT OUT: ${name} is ${of} characters and did not fit.]`;
    left -= shown;
  }
  const note = cut.length
    ? `NOTE: this module is larger than what fits here. Cut or left out: ${cut.map((c) => `${c.name} (${c.shown} of ${c.of} characters)`).join(", ")}. Every other file is whole. Do not assume what a cut part contains; if the change depends on it, say so.\n`
    : "";
  return { text: note + body, cut, chars: body.length, total };
}

module.exports = { sourceText, rank, BUDGET, MIN_USEFUL };
