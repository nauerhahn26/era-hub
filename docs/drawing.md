# Drawing — dev note

Specs: `docs/superpowers/specs/2026-09-30-drawing-design.md` + `docs/superpowers/specs/2026-10-02-drawing-modes-design.md`.
Plans: `docs/superpowers/plans/2026-09-30-drawing-plan.md` + `docs/superpowers/plans/2026-10-02-drawing-modes-plan.md`.

## Files
- `public/drawing/index.html` — the two screens; the Pencil's module shim.
- `public/drawing/scene.js` — pure scene logic and THE renderer (`renderScene`): the ring, every
  shelf thumbnail and the mailed PNG all draw through it. node tests import it directly.
  + the pen (`penStart/penMove/penEnd/penRoom`), strokes as one path string, people (`withPeople`),
  horizon-relative slots (`slotY`), hit boxes (`hitBox`), a stroke's trash box (`strokeBounds`).
- `public/drawing/backdrops.js` — the eight places as data (shapes in 1600x900 units) and their two
  painters: `backdropSvg` (ring, thumbnails, the Places tiles) and `paintBackdrop` (the PNG).
- `public/drawing/stickers/mode-*.png` — the mode glyphs (Fluent 3D, MIT, pinned in `stickers.json`
  `modes[]`; ⭐ Stickers reuses `star.png`). `bar-trash.png` — the 🗑 Trash tile's Wastebasket (pinned in
  `bar[]`, same Fluent commit).
- `public/drawing/drawing.js` — the app: boot, router (`#p=<id>`), ring, placing, Undo, autosave,
  park, shelf, Done. `window.Drawing` is its test/partner surface.
  + the mode row, the per-mode palettes (`renderPalette`), the Draw and gaze-move state machines
  (plan 2026-10-02 Definitions), the landing spot. + trash mode (the 🗑 tile, removals, auto-off).
- `public/drawing/partner.js` — the grown-up's finger drag, and nothing else (no tab, no sheet: dad 10/5).
  + touch wins over a carried item; ink is never dragged; with trash on a finger never drags.
- `public/drawing/stickers.json` — the eight stickers (seats, words, zones, scales, sha256 pins) and
  the slot tables. `drawings.js` validates scenes against the same file.
  + `modes`, `crayons`, `backdrops`; slot tables are written against the reference horizon 0.58.
  + `bar` (the door bar's tiles: today only `trash`).
- `public/drawing/people/` — the built-in People library (dad 10/7): `characters.json` + eight generic
  `<slug>.png`; `tools/drawing-default-people.mjs` (`--check`, `--placeholders`).
- `drawings.js` (hub) — ids, validation, writes, list, one-day blank cleanup, Done + mail.
  + v2 validation (strokes, crayons, places, people by shape only — a library check made pictures
    unsaveable and protected nothing, review 10/3 #5), 256 KB, `characters()`.
  + `charactersLibrary()` — the family's library, or the built-in one (dad 10/7).
- `drive.js` — `drawings` in the mirror; `.local`; `mirrorDrawing(id)`.
  + `characters` mirrors like `drawings`.

## Where a picture lives
`<folderPath>/drawings/<id>/{scene.json, picture.png}` when the hub has the family's Drive folder;
otherwise — or when that folder refuses the write (a view-only share, a file Drive holds open) —
`<DATA>/drawings/<id>/` with a `.local` marker, copied up (and unmarked) on the first sync that can.
The shelf and the GET routes read `<DATA>/drawings`.

The `.local` checks in drive.js are not drawings-only: `listTree` and `pruneTree` skip a folder
holding `.local` in EVERY library, and `copyTreeLocal` never brings a `.local` file down nor copies
onto a folder holding one. That is safe because only drawings.js ever writes the marker, and each
check can only prevent a delete or an overwrite, never cause one (review 9/30).
`drawings` is in drive.js's `MIRROR_SUBDIRS`, so "✨ Create it for me" now also makes a `drawings/`
subfolder, the Settings checklist's `content` gains a `drawings` key (its hint and `hasContent` still
name only the five libraries — deliberate: pictures are not "content" to set up), and `adoptLocal`
counts a folder holding only `drawings/` as the family's.

## Modes and gaze-move (spec 2026-10-02)
Row 5: Undo · Draw · People · ■ · Stickers · Places · Done. The side columns are the current mode's
palette in eight fixed seats; the last mode is remembered (`localStorage.drawing_mode`). Her picture
is a dwell target only in Draw mode (to start a line) — while a line is live or something is carried,
the target is a gaze-following landing spot (`#spot`), re-created whenever her gaze leaves it, so only
a real rest ends a line or drops an item (dwell.js counts time on ONE element however the gaze moves
inside it). Placed stickers and people get transparent hit boxes (`#hits > .hit`) of at least
`ceil(90 x innerWidth / 1920) + 1` px — `data-dwell-pad` cannot do this (dwell.js uses it for the halo
of an armed target only, and the contract audit measures the box). Resting on the black rest tile is
watched by the page (the tile itself stays inert). The test-only `&mode=<id>` hash and
`Drawing.__show/__lift` exist only under `window.__testHooks`.

## Trash mode (dad 10/3–10/4)
This AMENDS the bar law "🚪 and 💬 are the bar's only dwell targets" on dad's word (10/4): a 🗑 **Trash**
tile in the door bar's TOP-RIGHT corner (`margin-left:auto`) is its third dwell target. The bar holds
🚪, 💬 and 🗑 — nothing else (the grown-ups' tab is gone, dad 10/5). It holds HER dwell
(`CONTRACT.holds.content`, no `data-dwell-ms` — it never takes her off the screen), is a photo tile laid
on its side (glyph ≥ 4/5 of the tile, plate "Trash"), the bar's inner height like the doors, ≥ 2× as wide
as tall (the bar's audit floor). drawing.js appends it to the bar mount once `stickers.json` lands —
doorbar.js is untouched. The shelf hides it (`.away`, visibility only: zero shift).
- One dwell: trash ON ("Trash on"); a live stroke ends and a carried item goes back first. The next
  dwell: OFF ("Trash off"). Per session — never remembered.
- Unmistakable while on (dad 10/5): the tile is solid orange (`--c-vowel` #DE7B52, the strongest calm
  colour — red stays partner-only) with white "Trash on" (+ the teal `.on` ring), its plate sized for
  "Trash on" either way (a `::after` ghost) so the tile never changes size; her picture wears a 6 px
  dashed orange frame (`#trashFrame`, an SVG rect marching slowly; still under reduced motion), a
  "🗑 Trash is on" plate across its top (`#trashBanner`, ≥ 44 px, the tile's own Wastebasket image as its
  🗑, `pointer-events:none`, never a target — a finger or her gaze reaches the item under it), and every
  hit box is dashed orange. All of it lies inside the picture's box (zero layout shift) and goes when
  trash goes off. Speech unchanged.
- While on, every sticker, person AND stroke has a `.hit` (a stroke's box = its points' bounds plus half
  its line, grown to ≥ F×F about its centre and shifted inside — `strokeBounds` + `hitBox`; whole-line
  deletion, no per-segment work). A dwell removes the item ("Bye, horse"; a person by name; ink "Bye,
  line"), pushes `{t:"remove", i, item}` (Undo splices it back in place) and autosaves. No lifts; Draw's
  `#scene` target is off; the backdrop does nothing (a finger tap there neither). Strokes have NO hit box
  outside trash mode.
- After a removal there are no hit boxes until her gaze leaves the removed item's box (`S.gone`, the
  drop's cool-down rule): what lay under it never goes on the same resting gaze.
- A FINGER (dad 10/5, "anything I touch should disappear"): a tap removes what it lands on — tap parity,
  never a drag (partner.js starts no drag while trash is on; before, a roll of a pixel made the tap a
  "move" and its drag-end swallowed the click). A finger's removal sets no `S.gone`, and where no hit box
  is up (her guard after her own removal) the scene's click removes the topmost item whose trash box
  holds the finger (`itemUnder`). Turning trash on or off clears a drop's cool-down too (`S.cool`): her
  gaze is on the 🗑, so every target is up at once.
- Off by itself, silently: Done, 🚪, 💬, a real mode switch, opening a picture or the shelf, pagehide.
  Undo, a palette tile and the active mode leave it on.
- Ring dwell choices: 14 + the 🗑 = 15, inside `CONTRACT.maxChoices.cap` 16.
- Known shape (dad's whole-line rule): a long diagonal line's box covers much of the picture, and a
  later line lies over earlier items' boxes (topmost wins); Undo is the way back.

## The grown-up's finger (no tab, no sheet — dad 10/5)
Dad: "remove the grown-up settings — no utility". The `⚙ grown-ups` tab and its sheet (dwell tune, Clear
picture, the last Done's mail line, the People hint) are gone, with the freeze that put her targets to
sleep under it. What a grown-up keeps is silent: a FINGER drags a placed sticker or person (one `move`,
undoable, `by: "partner"`), takes an item she carries (touch wins), never drags ink, and never drags at
all while trash is on (its tap removes). Her dwell is set in Settings (`/settings` `dwellMs`); Undo and
trash mode are how a picture gets emptier. Done's mail answer is shown nowhere — never spoken, never
shown; `Drawing.state().lastMail` and the `done` log line keep it.

## People (the family's library, or the built-in one)
`<family Drive folder>/characters/{characters.json, <slug>.png}` → mirrored to `<DATA>/characters/` →
`GET /characters/index.json` and `/characters/<slug>.png`. `characters.json` =
`{ "v": 1, "people": [ { "slug", "word", "scale"? } ] }` in display order; an entry shows only with its
PNG. Cut-outs are made and approved in the private pipeline (plan 2026-10-02 "Private pipeline task");
nothing family-specific is ever committed here.

**The default library (dad 10/7).** A family without a library of its own sees eight built-in GENERIC
characters — Mom, Dad, Girl, Boy, Grandma, Grandpa, Baby, Friend — from `public/drawing/people/`
(`characters.json` in the same format + `<slug>.png`). The art is generic: no real people, no likeness of
anyone in the family. `drawings.charactersLibrary()` decides per request: the FAMILY library when
`<DATA>/characters/characters.json` has at least one entry that shows (its PNG present), else the DEFAULT
one; the same two routes serve whichever it is (the index's `X-Characters-Source: family|default` header
says which; its body is the same list either way), path-jailed to that one flat folder. Never merged: the
family's first shown entry hides every default, and a picture holding a default person then draws it as
nothing (kept, like a person who left the library). So a family overrides the defaults simply by putting
its own `characters/` in its Drive folder. "No people yet" (black seats) now happens only when the
built-in files are missing — a broken install. Pictures holding people always open, save and shelve.

Re-cutting the default art: drop the eight PNGs at `public/drawing/people/<slug>.png` (person-shaped,
transparent, feet on the bottom row — any aspect: a person's box takes the art's shape), tune `scale` in
that `characters.json` if needed, then `node tools/drawing-default-people.mjs --check` (every entry has a
PNG; says which are still synthetic placeholders). `--placeholders` rewrites only placeholders (never a
real cut-out without `--force`). No sha256 pins: these are our files, not vendored ones.

**Drive not running: the hub starts it (10/8).** The school device showed the built-in people because
its family library was absent: Google Drive for Desktop was installed and signed in but had not launched
after two reboots, so there was no mount, every ten-minute pass copied nothing, and `<DATA>/characters`
(and the books and drawings mirrors) went stale with no screen saying why. `drive.js maybeLaunchDrive()`
now starts it, in LOCAL mode only, when ALL hold: Windows (or the test seams set); `detectLocal()` finds
the installed `GoogleDriveFS.exe`; there is no mount root; a digits-only account dir exists under
`%LOCALAPPDATA%\Google\DriveFS` (never signed in = never launched — that is a person's step 2); and
`tasklist` shows no `GoogleDriveFS.exe` (a tasklist failure = unknown = no launch). It spawns the exe
detached with `--startup_mode` (what its own Run entry does), never awaited, riding existing passes only:
the start of each local `sync()` and the unconfigured hub's 60 s adoption poll. Limits: one launch per ten
minutes per process, three per hub lifetime, then one log line "will not stay up — giving up until
restart". It says so: a `[drive] launched Google Drive for Desktop …` console line, `status().driveLaunched`
(ISO time or null) + `driveLaunches` (count), and Settings' Drive checklist step 2 reads "Drive was not
running; started it at HH:MM — waiting for it to mount" until the mount appears. Test seams (read fresh
per call, unset = unchanged): `ERA_DRIVE_FS_EXE` (program to launch; `.js`/`.mjs` runs under node),
`ERA_DRIVE_FS_ACCOUNTS` (the folder to find the account dir in), `ERA_DRIVE_FS_RUNNING` (a file whose
existence means running, in place of tasklist), `ERA_DRIVE_FS_LAUNCH_SPACING_MS`. Suite:
`tests/drive-launch.test.mjs` (hub 8455). The school 10/8 case — family People missing because Drive for
Desktop was not running — is exactly this paragraph's case.

**Shape (dad 10/7).** Cut-outs are tall rectangles (288×768, 600×768). An item's `w` is its box's HEIGHT;
the box is square unless its art is not: then it is the art's own shape — width `w × (naturalW/naturalH) ×
9/16` scene widths, centred on `x`, bottom where the square's was (`scene.js artAspect` + `sceneOps`,
from the loaded images). The ring, the flyer, a carried item, a finger's drag, the shelf, the PNG, the hit
box, the clamp and the landing all use that box; the stored scene is unchanged. Square stickers are v1's
to the bit. The page waits up to 1.5 s at boot for the people's PNGs, and repaints the ring if one lands
later (the shelf keeps square boxes for it — contain draws the figure the same).

## Re-cutting assets
- Stickers (and `modes[]`, `bar[]`): edit a sticker's `source` + `sha256` in `stickers.json`, run
  `node tools/drawing-fetch-stickers.mjs` (network), then `node tools/drawing-fetch-stickers.mjs --check`.
- Icon: `node tools/drawing-icon.mjs` (sharp from `/home/claude/new-era/node_modules`, tool time only).

## Tests and ports
`tests/drawings.test.mjs` (hub 8477, fake Resend 8479), `tests/drawing-ui.test.mjs` (hub 8478),
`tests/drawing-scene.test.mjs` (no hub). `icons` and `invariants` run on the gate's shared hub.
v2 added no suite and no port: `drawing-scene` (geometry), `drawings` (hub), `drive-mirror` (characters),
`drawing-ui` (the app + per-mode audits) and `invariants.mjs` STATES (`#ring-draw/-people/-places/-items/-carried`).
Trash mode added no suite and no port: `drawing-scene` (`strokeBounds`), `drawings` (the pinned glyph),
`drawing-ui` (the tile, removals, auto-off, audits with trash on) and STATES `#ring-trash`.

## Later rungs (spec §10, dad's call)
Resizing or recolouring stickers, stroke widths, an eraser (Undo is the eraser), backgrounds from her
photos, sound effects, a People editor in Settings, printing (spec 2026-10-02 §10); and v1's remaining
rungs (a picture outbox, the TD Snap tile + Drawing.bat, ticking Drawing on devices whose apps.json
predates it).
