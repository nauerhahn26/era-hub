# Drawing — dev note

Specs: `docs/superpowers/specs/2026-09-30-drawing-design.md` + `docs/superpowers/specs/2026-10-02-drawing-modes-design.md`.
Plans: `docs/superpowers/plans/2026-09-30-drawing-plan.md` + `docs/superpowers/plans/2026-10-02-drawing-modes-plan.md`.

## Files
- `public/drawing/index.html` — the two screens + the grown-up's sheet; the Pencil's module shim.
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
- `public/drawing/partner.js` — the tab in the door bar, the sheet, the finger drag.
  + touch wins over a carried item; ink is never dragged. The tab sits LEFT of the 🗑 Trash tile.
- `public/drawing/stickers.json` — the eight stickers (seats, words, zones, scales, sha256 pins) and
  the slot tables. `drawings.js` validates scenes against the same file.
  + `modes`, `crayons`, `backdrops`; slot tables are written against the reference horizon 0.58.
  + `bar` (the door bar's tiles: today only `trash`).
- `drawings.js` (hub) — ids, validation, writes, list, one-day blank cleanup, Done + mail.
  + v2 validation (strokes, crayons, places, people by shape only — a library check made pictures
    unsaveable and protected nothing, review 10/3 #5), 256 KB, `characters()`.
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
tile in the door bar's TOP-RIGHT corner is its third dwell target, and the grown-ups' tab moved left of
it (14 px gap; partner.js inserts the tab before `#trashTile`). It holds HER dwell
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
- Off by itself, silently: Done, 🚪, 💬, a real mode switch, opening a picture or the shelf, the sheet
  opening, pagehide. Undo, a palette tile and the active mode leave it on.
- Ring dwell choices: 14 + the 🗑 = 15, inside `CONTRACT.maxChoices.cap` 16.
- Known shape (dad's whole-line rule): a long diagonal line's box covers much of the picture, and a
  later line lies over earlier items' boxes (topmost wins); Undo is the way back.

## People (the private library)
`<family Drive folder>/characters/{characters.json, <slug>.png}` → mirrored to `<DATA>/characters/` →
`GET /characters/index.json` and `/characters/<slug>.png`. `characters.json` =
`{ "v": 1, "people": [ { "slug", "word", "scale"? } ] }` in display order; an entry shows only with its
PNG. Cut-outs are made and approved in the private pipeline (plan 2026-10-02 "Private pipeline task");
nothing family-specific is ever committed here. With Drive off (the tablet today) People shows black
seats and "No people yet"; pictures holding people still open, save and shelve.

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
