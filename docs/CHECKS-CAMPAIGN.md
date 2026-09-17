# Checks campaign: making the functionality check trustworthy

*Started 2026-09-17. Brendan: almost every functionality change was being
stopped, and a pilot cannot run on a check that stops good work. This is the
loop for fixing that with evidence instead of guesses.*

## What "rejected" turned out to mean

A change can stop at five different places, and until today the board showed
them all as a failed card:

| Where it stopped | What it looks like | Who decided |
|---|---|---|
| migration rejected | "Stopped: migration 002.sql rejected: forbidden operation in ..." at the build step | the platform's validator, no model |
| platform checks | a new module missing a file, a page hard-coding its address | the platform, no model |
| reviewer failed it | "Independent review (Fable 5.1) failed it. Findings: ..." | the cross-check model |
| tests failed | "internal tests failed: /api/x returned 500" | the platform, after staging |
| agent died, cost cap, restart | the agent process or the platform | nobody judged the change |

Found on 2026-09-17: the migration validator rejected any statement containing
DROP, DELETE, UPDATE, GRANT, OWNER, COPY, RESET, RULE, TRIGGER, CLUSTER or DO
as a substring, so a column named `updated_at`, `deleted_at`, `owner_name`,
`granted_at`, `reset_count`, `rule_text`, `trigger_level` or `copy_count`, and
any seed text containing "do" or "update", killed the build. Agents put
`updated_at` in nearly every table. Functionality changes are the ones that
add migrations, so they were the ones dying. Fixed: whole-word matching with
string literals blanked out, and a forbidden word directly followed by a column
type is a column definition. Real DROP, UPDATE, DELETE, ALTER ... DROP, DO
blocks and functions are still rejected (`node -e` test in the commit).

Also on 2026-09-17 the cross-check brief was rewritten (see CLAUDE.md,
"Cross-check calibrated"). Whether that was enough is what this campaign
measures.

## First export, 2026-09-17 (demo company, 24 runs)

Nine functionality runs, fourteen UI, one module build. Every reviewer stop
was Opus 5 reviewing a functionality change; the one module build (Roving
Watch Logs) was reviewed by Fable and passed. The five stops:

| Run | What happened | Verdict on the verdict |
|---|---|---|
| #32 | "change the admin password to Brendan1": the agent produced an empty diff | right to stop; now stopped before the reviewer with a plain message |
| #19 | five-change batch, the agent skipped change 5 entirely | right to stop |
| #13 | nine-change batch; the agent removed a timestamp from a card and reworded a line | old brief, strict scope; a manager might call either way |
| #28 | three changes; the agent replaced the older per-station throttle with the new cap; the reviewer could not see the new migration because `diff -ru` prints a new file as "Only in ..." with no body | half wrong: the invisible migration was our bug (`-N` now) |
| #31 | new brief; the reviewer marked two things blocking that the brief calls minor: a guess ("if the underlying bug is...") and a missing `data-changed` mark, citing PRINCIPLES rule 9 because PRINCIPLES.md was in its brief | wrong |

What changed from this: new files show in full in the diff; the reviewer gets
GUARDRAILS.md only, never the builder's craft rules; a mechanical guard
demotes blocking findings that are guesses, housekeeping or cosmetic (the
checks log shows "Demoted to minor by the platform" when it fires); an empty
diff stops before the reviewer; and the instance default review model is
Fable. Lesson for the builder side, separate from the reviewer: batches of
five or more changes are where the agent skips or over-reaches; the board's
"Build by screen" exists for that.

## The log

`/c/<slug>/checks` (manager, linked from the board header as "checks log"):
every build run, why it stopped where it stopped (one of the reasons above,
computed by `src/checks.js reasonFor`), the reviewer's findings with the diff
lines they quote, the change that was asked for, and three buttons: Right,
Wrong, Unsure, with a one-line note. "Right" means the platform was right to
stop it (or to let it through); "Wrong" means it should have gone the other
way. Labels live in `platform.check_labels` and are the ground truth for
tuning. Counts by reason sit at the top; click one to filter.

Rule of thumb when labeling: open the preview if there is one, read what was
asked, and ask "would I have let this on the floor?" The reviewer's job is to
stop things a manager would not have let through, nothing stricter.

## The replay

The quickest loop is on the checks page itself: pick a model in "Replay
with", press Replay on a run (or "Replay every labeled case"), and the new
verdict lands under the old one with "matches your label" or "disagrees",
plus any findings the platform demoted. Each replay is one cross-check call
on the run's original diff with the brief as deployed. The Terminal route
below does the same offline, useful when trying a brief before pushing it.

"Download the checks log" (or "labeled cases only") saves a JSON file with
every case's requirement, lane, screens and the files before and after. Then,
in Terminal, from `sos/`:

```
ANTHROPIC_API_KEY=... node scripts/replay-crosscheck.js ~/Downloads/checks-demo-2026-09-17.json --only labeled
ANTHROPIC_API_KEY=... node scripts/replay-crosscheck.js checks.json --only wrong --model claude-opus-5
ANTHROPIC_API_KEY=... node scripts/replay-crosscheck.js checks.json --ids 28,31 --out replay.json
```

The script rebuilds each diff exactly as the pipeline does and runs the
CURRENT brief from `src/pipeline.js` (`crossCheckCall`) through the real API,
then prints old verdict, new verdict, and whether the new one matches the
label. Edit the brief, run again, compare. One replay of a case costs what
one cross-check costs (roughly 10 to 60 cents on Fable, less on Opus). No
live builds are spent.

## The loop

1. Build normally for a few days. Every stop lands in the log.
2. Label everything that stopped, and a handful that passed, with a note.
3. Export, replay the labeled set on the current brief. The number that
   matters: labeled-wrong cases that now pass, without labeled-right cases
   flipping to pass.
4. Change one thing in the brief (a rule, an example, the model), replay,
   compare. Keep what helps.
5. Ship the brief. The log keeps filling; repeat when the wrong count grows.

Exit criterion for a pilot: over the last 30 functionality changes, at most 2
stopped by the reviewer that the manager labels wrong, and no change the
manager labels "should have been stopped" that the reviewer passed. Until the
check meets that bar, pilots run on Fable for both the build and the review,
which is the setting with the fewest wrong stops so far.

## Where to look next if the wrong count stays high

- The requirement text. The propose model writes "(2) what stays the same"
  as a list; a reviewer may read it as a ban on touching those files. The
  brief now says it describes behavior, not files; if that still trips, drop
  that clause from the requirement instead.
- The diff. Version directories include tour.json and reference.md changes
  the agent is required to make; the brief lists them as housekeeping. If a
  reviewer keeps citing them, exclude them from the diff it sees.
- The reviewer model. Opus 5 and Fable 5.1 read the same brief differently;
  the replay shows which one agrees with the labels more often.
- The builder. Some stops are right: the agent really did change more than
  asked. Those show up as "Right" labels on reviewer stops, and the fix is in
  the build prompt, not the reviewer.
