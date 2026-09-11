# Diagram conventions

Every deployed module version gets two sets of diagrams, generated from the
module's source and shown on the improvement board. They exist so a production
manager, a new operator, or an outsider can understand what the module does
and what it records without reading code. Adjust this file when the outputs
are not landing; the generator reads it every time.

## Output

Mermaid only. Each diagram is a single Mermaid block, no code fences, no
comments, no `%%{init}` directives. Use `flowchart LR` for data flows and
`flowchart TD` for workflows. Use `sequenceDiagram` only when timing between
two roles is the whole point.

Two sets:

1. **Data flows** (2 to 4 diagrams). What is recorded, where, and who reads it.
   - One overview: every screen on the left, the server in the middle, every
     table on the right. Arrows are labeled with the record that moves
     ("traveler advances", "material request", "shift results").
   - One per major record type that changes state (for example a traveler,
     a request), showing the states it moves through and which screen moves it.
   - Tables are named by their real table name in a note or label (people
     will see them in exports); everything else is plain language.
2. **Workflows** (one per role, 2 to 5 diagrams). What a person at that
   screen does, in order, including the decisions and the dead ends.
   - Start with what they see when they arrive, end with what happens to the
     work when they finish.
   - Show the error paths that exist ("no paper at the line" blocks the step),
     because those are the friction the loop is meant to remove.
   - One diagram per role or screen. Do not merge roles into one drawing.

## Style rules

- Plain language on every node. "Operator taps Done" not "POST /complete".
  The only technical identifiers allowed are table names in the data flow set.
- 6 to 18 nodes per diagram. Split rather than cram.
- Node shapes: `[Screen or action]` rectangles for steps, `{Decision?}` for
  decisions, `[(table_name)]` cylinders for tables, `([Start or end])` stadium
  for entry and exit, `[[Server]]` subroutine shape for the module's logic.
- Group screens and tables with `subgraph` blocks named "Screens", "Server",
  "Records".
- Arrow labels are short verbs or record names, under five words.
- Every diagram has a title line and a two to four sentence note in plain
  language describing what it shows and, when relevant, what changed in this
  version.
- No colors, no styling directives; the platform styles the render.
- IDs must be simple: letters, digits, underscores. Labels go in the brackets.
  Quote a label if it contains parentheses or punctuation: `A["Done (send on)"]`.

## What "good" looks like

A manager who has never seen the module can point at the workflow diagram for
a station and say what the operator will do next. Someone auditing the system
can point at the data flow overview and name every table a screen writes to.
If a diagram needs a paragraph to explain, it is too dense.
