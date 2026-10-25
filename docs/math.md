# Math

Math is a local number exploration app. Open Math from the hub's home screen
or its shortcut. If the computer has an explicit selection of apps, enable
Math in Settings → Apps & navigation. Its files ship with the core payload;
enabling it does not need an additional app download.

The first menu offers Numbers and Number partners. Every action works with
eye gaze or touch. Objects are positioned by the app; dragging and dropping
are unnecessary. The objects, numerals and equations inside the workspace
are for looking at, and do not activate commands.

## Numbers

Numbers explores 0–50. One more adds one object; One fewer removes one. The
numeral, number word and collection change together. Groups of ten make
larger quantities visible without adding more selection targets. Zero has
an empty collection; the bounds never wrap.

Pick a number opens ten stable numeral seats. Other numbers opens a range
choice. Back stays top-left, and Other numbers stays bottom-left. Selecting
a numeral returns to the workspace; Back cancels without changing it.

Count highlights the existing objects one at a time, speaks each number,
then names the total. It adds nothing and requires no response. Any action
can interrupt it. If speech is unavailable, the visual model still works.

## Number partners

Choose a whole from 0–20 and explore two parts of it. Pick a number offers
0–10 on its first page, including ten. Other numbers switches directly to
11–20 and back again. The picker opens on the page containing the current
whole. Each part above ten uses two structured frames so every object remains
visible. Move left moves one
object from the right part to the left; Move right reverses that transfer.
The whole stays unchanged. For example, 3 + 4 = 7 can become 4 + 3 = 7.
Both parts may include zero. A control that cannot move another object
stays in its seat and is unavailable.

Count continues across both parts as one collection. The whole numeral and
equation describe those objects; there is no second collection to count.
Choosing a new whole starts with two parts as evenly divided as possible.
Cancelling the picker keeps the existing partition. Numbers and Number
partners keep their own quantities when switching between them.

## Resting and returning

The black bottom-right corner is inert. All ordinary controls use the
user's dwell setting. Exit and Talk use the shared doors and twice that
dwell. Looking at a command after it fires does not repeat it until gaze
moves away and re-arms.

Talk is available when the hub's communication settings support it. It
stops counting, retains the exploration and blocks background input. On
return, the shared settling pause protects the first gaze. Interrupted
counting does not restart by itself.

Explorations are saved locally on that computer. Reloading restores the
workspace and both quantities, including a picker that was open. A malformed
or unsupported saved state falls back to a fresh menu. If local storage is
unavailable, the current exploration remains usable in memory. These values
do not synchronize across computers.

The app has no score, response deadline or automatic lesson progression.
Action logs distinguish counting demonstrations from selections and leave
unobserved support marked unknown; activity is not treated as mastery.

Design and evidence: [math exploration](specs/2026-10-25-math-design.md).
Implementation receipt: [math plan](plans/2026-10-25-math-plan.md).
