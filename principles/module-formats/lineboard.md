# Module reference: Production Line Board

What this module is and how changes to it should be shaped.

**Purpose.** One glance tells anyone the state of the line: which stations are
running, blocked, or down, and what work is queued where.

**Data model.** `stations` (name, seq, status) and `work_orders` (wo_num, part,
qty, station_id, state: queued | at_station | done). Orders advance station to
station in seq order, then complete.

**Views.** A single board page: station tiles on top (status pill, order count),
work queue table below with an Advance action per order.

**Change guidance.**
- Status vocabulary changes (new statuses, colors) are functionality changes: they touch the allowed values in routes.js and every view of the pill.
- Column additions to the queue that display existing fields are UI changes.
- New tracked fields (due dates, priorities, takt timers) are functionality changes and need a migration adding columns.
- The board is read from a distance; keep contrast high and text large.
