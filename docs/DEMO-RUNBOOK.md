# Paper Airplane Line: facilitator runbook

What the room experiences: they run a real production line, feel its friction,
report it from the tool they are using, and watch the tool change between
shifts. The point is the loop, not the airplanes.

## Setup (10 minutes before)

Materials: letter paper in white, blue and yellow (about 40 sheets each is
plenty), a box of paper clips, tape on the floor as a throw line, a tape
measure or floor marks every 5 feet.

Room: five tables in a row, one per station, plus a "stockroom" table off to
the side with the paper and clips. Station 1 needs only a few sheets of each
color to start (the app starts the line with 4 white, 1 blue, 2 yellow, 3
clips; put exactly that on the station 1 and station 5 tables so the physical
count matches the app).

Devices: everyone opens https://sos.finnoperations.com on their phone, signs
in with the floor password, and picks a station. You (manager) open the same
site on a laptop with the manager password and keep two tabs: the line board
(`/m/paperline/`) on a projector if you have one, and the improvement board
(`/`).

Headcount: 5 stations plus 1 stockroom plus you is the ideal 7. With fewer
people, one person covers two adjacent stations by switching pages. With more,
double up the slow stations (Body Fold and Wings usually) and let the extras
watch the line board and call out what they see.

Before the room arrives, on the line board click **Reset demo** so shift
history and inventory are clean.

## Stations

1. Kit and Crease: take a sheet of the traveler's color, crease it lengthwise.
2. Nose Folds: fold the two top corners to the center.
3. Body Fold: darts get a second corner fold; gliders get the nose folded down.
4. Wings: fold in half and fold the wings down (narrow for darts, wide for gliders).
5. Clip and Test: paper clip where the traveler says, one throw, enter the
   distance, Pass or Scrap.

The station page shows the current traveler (job number, color, a fold code)
and the instruction for that fold type. **Done** sends it on. Station 5 has a
distance box and Pass/Scrap. Station 1 and station 5 will run out of material;
**Request material** sends a request to the stockroom page.

## Running it

**Shift 1 (2 minutes).** Say only: "Start when the timer starts. Do what your
screen says." Click **Start shift**. Ten travelers land on station 1 at once.
Let it run. Things that will happen because the v1 is deliberately imperfect:

- Station 1 gets buried; stations 3 to 5 sit idle for the first 40 seconds.
- Blue paper runs out after one plane. Someone has to figure out the request
  button, and the stockroom person has to notice the request.
- Requests are for one unit at a time. Expect grumbling.
- The fold type is a letter (D or G) with no legend.
- Station 5 cannot see where the clip goes; that information is only on the
  line board.
- Distance has no unit on the box.
- The station page refreshes every 8 seconds, so a sent traveler shows up
  with a lag.
- Scrap is final; there is no rework path back to Wings.

When the timer hits zero, steps stop working ("The shift is not running").
The shift lands in the history table with completed count, average distance,
stockouts, and WIP left, plus per-station throughput and average seconds when
you click the row.

**Between shifts (the actual demo).** Ask each station: "What got in your
way?" Have them tap **Something in the way?** on their own page and type it in
their words, name included. Do not filter or reword for them.

On the improvement board (manager tab):

1. Each item appears under Feedback with the station page it came from.
   If two people report the same thing, use **+1 seen again** instead of a
   second card. Recurrence is the priority signal.
2. Pick one or two. Click **Review with AI**. Read the proposal out loud and
   point at the UI or FUNCTIONALITY tag: a UI change goes straight to build; a
   functionality change makes the AI restate the requirement first and you
   confirm it before anything is built.
3. **Approve build.** Narrate the steps as they light up: agent build, visual
   check or cross-check review, internal tests, then the manager deploy gate.
   A UI change takes roughly one to two minutes; a functionality change a bit
   longer. Run shift 2 while a slow build is in progress if you want to keep
   energy up.
4. When it reaches the gate, open **View staged demo** on the projector. That
   is the change running against a copy of the live data, not the live line.
5. **Deploy to floor.** Tell the stations to reload. The card moves to Done
   with a "You said / we did" line.

Good first picks, in order of how well they land: show the fold type name
instead of a letter (UI, fast), show clip position on station 5 (UI, fast),
request quantity instead of one at a time (functionality, shows the
requirement gate), release travelers in batches instead of all at once
(functionality, changes the shape of the whole line).

**Shift 2 and 3.** Same two minutes. Compare the history rows: completed,
average distance, stockouts, WIP at end. Improvements should show up in the
numbers, and if one does not, that is the conversation.

**Roll back.** If a deployed change made things worse, the Done card has
**Roll back**. One click restores the previous version and its data. Worth
doing once on purpose so the room sees it is cheap.

## Things to say once, then stop saying

- Nothing reaches the line without a human approving it. The AI writes to
  staging only.
- Every station page has the same button. Feedback comes from the place the
  friction happened, not from a meeting.
- The board and the module are the same system. The tool that runs the line
  is the tool that improves the line.

## If something breaks

- A build fails: the card says why in plain language. **Retry** re-runs it.
- Someone got locked out: the floor password is on the whiteboard, not in the app.
- The line is in a weird state: manager can **End shift now** and, at worst,
  **Reset demo** (wipes shifts and travelers, restocks the line).
- The AI cap trips (per-run or monthly): the board says so; the caps are
  Railway env vars (`SOS_MAX_RUN_USD`, `SOS_MONTHLY_CAP_USD`).
- Platform feedback (about the board itself) is not built in-app; it lands in
  the Platform column for Brendan to ship from Cowork.
