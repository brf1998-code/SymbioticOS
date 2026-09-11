# Module reference: Paper Airplane Line

What this module is and how changes to it should be shaped.

**Purpose.** A production line of one to five stations that makes paper
airplanes. Each airplane is a job traveler that moves station to station. Work
happens in shifts of a fixed length (default 2 minutes). The line runs for real
with people at the stations; this module is what they look at.

**Demo setup.** The manager answers a few questions on the line board (people,
station count, color mix, fold mix, clips, limited inventory, instructions,
shift length, travelers per shift). The answers live in `settings` and the
`stations` table is rebuilt from a fixed layout per station count (5 down to
1, folds merged as the count drops). `GET /api/state` returns them as
`settings`; `GET /api/station/:seq` returns them as `setup`. Pages must keep
honoring these flags (no instruction text when `show_instructions` is 0, no
material requests when `inventory_limits` is 0, no clip step when `use_clips`
is 0).

**Roles and pages.**
- `/` line board: the manager starts and ends shifts, sees the timer, WIP by
  station, this shift's numbers, and the shift-over-shift history.
- `/station/:seq` station view (phones): the operator sees the next traveler
  at their station, the instruction for that traveler, and one big action
  (Done, or Pass/Scrap with a distance at the last station). Material requests
  go from here.
- `/stock` stockroom: open material requests with a Deliver button, plus
  inventory at the line and in stock.

**Data model.** `stations` (seq, name, instruction per fold type, status),
`shifts` (number, started/ends/ended, results), `travelers` (job_num, color,
fold_type dart|glider, clip_pos none|nose|middle, station_id, state
queued|at_station|done|scrap, distance_ft, qc), `traveler_log` (arrived,
completed, scrapped, stockout events with seconds spent), `inventory` (item ×
location stock|line), `material_requests`, `settings` (shift_seconds,
release_per_shift).

**Rules of the line.**
- Station 1 consumes one sheet of the traveler's color from line inventory.
  The last station consumes one clip when clip_pos is not none. A missing item
  blocks the step with a plain message and logs a stockout. With
  `inventory_limits` off nothing is consumed or blocked.
- Steps only complete while a shift is running. WIP carries over between shifts.
- Shift results are computed when the clock runs out (lazily, on the next request).

**Change guidance.**
- Showing a field the station API already returns (clip position, fold name,
  queue order, wait time) is a UI change.
- Anything about release timing, batch size, rework/return paths, request
  quantities, inventory rules, or new tracked fields is a functionality change
  and usually needs a migration.
- Station pages are used on phones by people who are also folding paper. One
  action per screen, big text, no scrolling to find the button.
- Keep every page's API calls relative to `base` as the existing pages do.
