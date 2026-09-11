# Module reference: Paper Airplane Line

What this module is and how changes to it should be shaped.

**Purpose.** A five-station production line that makes paper airplanes. Each
airplane is a job traveler that moves station to station. Work happens in
shifts of a fixed length (default 2 minutes). The line runs for real with
people at the stations; this module is what they look at.

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
  blocks the step with a plain message and logs a stockout.
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
