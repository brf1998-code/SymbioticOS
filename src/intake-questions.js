// The fixed questions of a module intake (docs/MODULE-CREATION.md, "Round 1").
// Same for every module, in this order, in plain words. The wording here is
// product copy: keep it short, keep it free of the words in
// principles/PLAIN-WORDS.md.
//
// Answer shapes, by kind:
//   text     string
//   choice   { picks: [optionId...], other: "free text", names: { optionId: "what they call it" } }
//   roles    { [groupId]: "headcount as typed" }            (a group is picked when its key exists)
//   devices  { [groupId]: [deviceId...] }                   (groups come from the "who" answer)
//   order    [string...]                                    (stages, in order)
//   items    [string...]                                    (up to `max` short items)
//   attach   { note: string }                               (files live in platform.attachments)
// A question with attach: true takes files as well as its own answer.

const GROUPS = [
  { id: "floor", label: "People on the floor" },
  { id: "leads", label: "Leads or supervisors" },
  { id: "managers", label: "Managers" },
  { id: "office", label: "Office or planning" },
  { id: "outside", label: "People outside the company" },
];
const DEVICES = [
  { id: "phone", label: "A phone" },
  { id: "tablet", label: "A tablet" },
  { id: "wall", label: "A wall screen" },
  { id: "desk", label: "A desk computer" },
  { id: "paper", label: "Paper today" },
];

const FIXED = [
  { id: "name", kind: "text", required: true, multiline: false, max: 80,
    text: "What should we call it?",
    hint: "A short name people on the floor would use. It can change later." },
  { id: "purpose", kind: "text", required: true, multiline: true, max: 8000,
    text: "In a sentence or two, what is it for? Walk me through a normal day with it.",
    hint: "Who picks it up first in the morning, what they do with it, what it looks like at the end of the shift." },
  { id: "who", kind: "roles", required: true, options: GROUPS,
    text: "Who will use it?",
    hint: "Tick each group and give a rough headcount. This decides how many kinds of screen it needs." },
  { id: "devices", kind: "devices", required: true, options: DEVICES, depends_on: "who",
    text: "What does each of those people have in hand when they use it?",
    hint: "A phone in a pocket, a tablet on a cart, a screen on the wall, a computer at a desk. Pick every one that applies." },
  { id: "thing", kind: "text", required: true, multiline: false, max: 120,
    text: "What is the thing being tracked? Give it a name in your own words.",
    hint: "One word or two: the thing that moves through the stages, the thing people ask about." },
  { id: "today", kind: "choice", required: true, multi: true, other: true, attach: true,
    options: [
      { id: "whiteboard", label: "A whiteboard" }, { id: "paper", label: "A clipboard or paper" }, { id: "spreadsheet", label: "A spreadsheet" },
      { id: "program", label: "Another program" }, { id: "head", label: "In someone's head" }, { id: "none", label: "Not tracked at all" },
    ],
    text: "How is it kept track of today? Show me if you can.",
    hint: "A photo of the whiteboard or the paper, or the spreadsheet itself, tells Fable a lot: the names you use, the columns, the stages." },
  { id: "stages", kind: "order", required: true, min: 2, max: 16, item_max: 200,
    text: "What happens to it from start to finish? List the stages in order.",
    hint: "From the moment it first exists to the moment nobody needs to look at it again. Drag or use the arrows to put them in order." },
  { id: "wrong", kind: "items", required: true, min: 1, max: 5, item_max: 500,
    text: "What goes wrong today that this should stop?",
    hint: "Up to five things. The ones that cost time, cause arguments, or get somebody a call at home." },
  { id: "never", kind: "text", required: true, multiline: true, max: 8000,
    text: "What must never happen?",
    hint: "Two people on the same thing, a stage skipped, something leaving before it is checked. These become rules." },
  { id: "numbers", kind: "choice", required: true, multi: true, other: true, note: true,
    options: [
      { id: "how_many", label: "How many" }, { id: "how_long", label: "How long" }, { id: "how_late", label: "How late" },
      { id: "how_often", label: "How often" }, { id: "how_full", label: "How full" },
    ],
    text: "Which numbers would tell you it is working?",
    hint: "What you would check at the end of the week. Say it in your words in the box if the chips do not fit." },
  { id: "works_with", kind: "choice", required: true, multi: true, other: true, names_for: ["erp", "machine", "program"],
    options: [
      { id: "scanners", label: "Barcode or QR scanners" }, { id: "printer", label: "A label printer" }, { id: "spreadsheet", label: "A spreadsheet you keep" },
      { id: "erp", label: "Your ERP or scheduling system" }, { id: "machine", label: "A machine or a PLC" }, { id: "scale", label: "A scale" },
      { id: "program", label: "Another program" }, { id: "nothing", label: "Nothing, it stands alone" },
    ],
    text: "What does this need to work with that you already use?",
    hint: "Fable asks a short follow-up for each one you tick. For a system, tell me what you call it." },
  { id: "starting_list", kind: "attach", required: false,
    text: "Do you have a list to start from?",
    hint: "A spreadsheet of parts, locations, people, equipment, whatever the thing is. It becomes the starting data, after you see it." },
  { id: "peers", kind: "choice", required: false, multi: true, other: false, conditional: "other_modules",
    options: [],  // filled in per company: the live modules plus "no"
    text: "Does it need to know anything from a module you already have?",
    hint: "It can read what another module keeps, for example which orders are open, without changing it." },
];

// The fixed questions for one company: the peers question only when the
// company has other modules to read from.
function fixedFor(modules) {
  return FIXED.filter((qn) => qn.conditional !== "other_modules" || (modules && modules.length)).map((qn) => {
    if (qn.id !== "peers") return qn;
    return { ...qn, options: (modules || []).map((m) => ({ id: m.name, label: m.title })).concat([{ id: "none", label: "No" }]) };
  });
}

// Whether an answer counts as given, by kind.
function answered(qn, v) {
  if (v == null) return false;
  switch (qn.kind) {
    case "text": return String(v).trim().length > 0;
    case "choice": return Boolean(v && ((v.picks && v.picks.length) || (v.other && String(v.other).trim())));
    case "roles": return Boolean(v && Object.keys(v).length);
    case "devices": return Boolean(v && Object.values(v).some((d) => Array.isArray(d) && d.length));
    case "order": return Array.isArray(v) && v.filter((s) => String(s).trim()).length >= (qn.min || 1);
    case "items": return Array.isArray(v) && v.filter((s) => String(s).trim()).length >= (qn.min || 1);
    case "attach": return true;  // optional by nature; files are separate
    default: return Boolean(v);
  }
}

// Render one answer as plain text for the model.
function describe(qn, v, attachments = []) {
  const label = (id) => ((qn.options || []).find((o) => o.id === id) || {}).label || id;
  const files = attachments.length ? ` [attached: ${attachments.map((a) => a.filename).join(", ")}]` : "";
  if (!answered(qn, v)) return `(not answered)${files}`;
  switch (qn.kind) {
    case "text": return String(v).trim() + files;
    case "choice": {
      const parts = (v.picks || []).map((p) => label(p) + (v.names && v.names[p] ? ` (they call it "${v.names[p]}")` : ""));
      if (v.other && String(v.other).trim()) parts.push(`something else: ${String(v.other).trim()}`);
      return parts.join("; ") + (v.note && String(v.note).trim() ? `. In their words: ${String(v.note).trim()}` : "") + files;
    }
    case "roles": return Object.entries(v).map(([g, n]) => `${label(g)}${n ? ` (about ${n})` : ""}`).join("; ");
    case "devices": return Object.entries(v).map(([g, ds]) => `${((GROUPS.find((x) => x.id === g) || {}).label || g)}: ${(ds || []).map((d) => ((DEVICES.find((x) => x.id === d) || {}).label || d).toLowerCase()).join(", ")}`).join("; ");
    case "order": return v.filter((s) => String(s).trim()).map((s, i) => `${i + 1}. ${String(s).trim()}`).join("  ");
    case "items": return v.filter((s) => String(s).trim()).map((s) => `- ${String(s).trim()}`).join("\n");
    case "attach": return ((v && v.note) ? String(v.note).trim() : "(no note)") + files;
    default: return JSON.stringify(v);
  }
}

// Company system names the person gave (allowed through the plain-words guard).
function systemNames(answers) {
  const w = answers && answers.works_with;
  const names = [];
  if (w && w.names) for (const n of Object.values(w.names)) if (n && String(n).trim()) names.push(String(n).trim());
  if (w && w.other && String(w.other).trim()) names.push(String(w.other).trim());
  return names;
}

module.exports = { FIXED, GROUPS, DEVICES, fixedFor, answered, describe, systemNames };
