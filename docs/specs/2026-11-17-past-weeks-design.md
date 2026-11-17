# Past weeks on the This week board — design (2026-11-17)

Dad, 2026-11-17: "We should allow her to access previous weeks content, so when
she goes to this week there should be previous weeks and then each week is
saved so she can go back to bats or something and watch a previous video or
game. They should be sorted by most recent weeks. So quick access to her
current week with ability to navigate back to previous weeks."

Amends `2026-10-12-weekly-suite-design.md` §1 (the root triangle) and §3.3/§5.6
(the way back from a video or a game).

## What already exists

Every week package stays: `<Drive>/this-week/<week_of>/` keeps its
`manifest.json`, the downloaded `<id>.mp4` and thumbnails, and the Drive mirror
copies every week folder to every device (`drive.js` MIRROR_SUBDIRS). A folder
leaves a device only when it is removed in Drive. `this-week.js` reads only the
newest week; `/this-week/<week>/play.json` and `/this-week/<week>/<id>.mp4`
already serve any week. Nothing new is downloaded or stored: this is a board
change on the hub.

## What she sees

1. **The root stays the triangle** (§1 amended 2026-10-25), current week first:
   Watch [1,1], Talk [1,3], Play [2,2], [1,2] black. The fourth door the spec
   reserved, **[2,1] 🗓️ Past weeks**, appears when at least one older week has
   a valid manifest; otherwise that cell stays black.
2. **Past weeks** (`past-1`, `past-2`, …): a 3×4 board in the Talk mould. Back
   [1,1] → the root, More [3,1] → the next page when it overflows, centre
   black, eight weeks a page in the Talk seat order, **newest first**. A tile is
   the week's title ("Shadows and Votes!"), says the title, and carries one
   picture: the week's hero word's glyph, else its first science word's glyph,
   else 🗓️. Weeks older than the newest 52 are not listed.
3. **A past week** (`w-<week_of>`): a 3×3 board, centre black, doors in the
   corners so each has black neighbours — Back [1,1] → the Past weeks page it
   came from, Watch [1,3], Play [3,1] (black when the week fills no engine),
   Talk [3,3]. Its title is the week's title and it says it on load.
4. Behind a past week's doors: the same Watch ring (`w-<week_of>-watch`) and Talk
   pages (`w-<week_of>-talk-N`) the current week has, built by the same code
   from that week's folder; their Back returns to `w-<week_of>`. A video not on
   the device is the same ⏳ "not here yet" tile.
5. **The way back.** Leaving a video or a game returns to the board it came
   from: the current week's Watch ring / root as today, a past week's
   `w-<week_of>-watch` / `w-<week_of>` for a past week.

## Rules kept

- One bad past week never takes the board away: a week whose manifest is
  missing or fails `validate()` is left out of the list, never an error.
- The current week is exactly what `readWeek()` picks today; the download rail
  (`this-week-fetch.js`) still works on the current week only.
- The recipe ETag folds in every listed week (manifest mtime + size + ready
  bits), so a newly mirrored past video refreshes the board. `THIS_WEEK_REV` 4.
- Board laws: fixed seats, centre black, Back [1,1], More [3,1], no scores.

## Not in this design

Deleting old weeks (Drive is the source; remove a folder there), a search, a
calendar view, past weeks' videos downloaded by the rail.
