# Drawing — dev note

Specs: `docs/superpowers/specs/2026-09-30-drawing-design.md` + `docs/superpowers/specs/2026-10-02-drawing-modes-design.md`.
Plans: `docs/superpowers/plans/2026-09-30-drawing-plan.md` + `docs/superpowers/plans/2026-10-02-drawing-modes-plan.md`.

## Files
- `public/drawing/index.html` — the two screens + the grown-up's sheet; the Pencil's module shim.
- `public/drawing/scene.js` — pure scene logic and THE renderer (`renderScene`): the ring, every
  shelf thumbnail and the mailed PNG all draw through it. node tests import it directly.
  + the pen (`penStart/penMove/penEnd/penRoom`), strokes as one path string, people (`withPeople`),
  horizon-relative slots (`slotY`), hit boxes (`hitBox`).
- `public/drawing/backdrops.js` — the eight places as data (shapes in 1600x900 units) and their two
  painters: `backdropSvg` (ring, thumbnails, the Places tiles) and `paintBackdrop` (the PNG).
- `public/drawing/stickers/mode-*.png` — the mode glyphs (Fluent 3D, MIT, pinned in `stickers.json`
  `modes[]`; ⭐ Stickers reuses `star.png`).
- `public/drawing/drawing.js` — the app: boot, router (`#p=<id>`), ring, placing, Undo, autosave,
  park, shelf, Done. `window.Drawing` is its test/partner surface.
  + the mode row, the per-mode palettes (`renderPalette`), the Draw and gaze-move state machines
  (plan 2026-10-02 Definitions), the landing spot.
- `public/drawing/partner.js` — the tab in the door bar, the sheet, the finger drag.
  + touch wins over a carried item; ink is never dragged.
- `public/drawing/stickers.json` — the eight stickers (seats, words, zones, scales, sha256 pins) and
  the slot tables. `drawings.js` validates scenes against the same file.
  + `modes`, `crayons`, `backdrops`; slot tables are written against the reference horizon 0.58.
- `drawings.js` (hub) — ids, validation, writes, list, one-day blank cleanup, Done + mail.
  + v2 validation (strokes, crayons, places, people with grandfathering), 256 KB, `characters()`.
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

## People (the private library)
`<family Drive folder>/characters/{characters.json, <slug>.png}` → mirrored to `<DATA>/characters/` →
`GET /characters/index.json` and `/characters/<slug>.png`. `characters.json` =
`{ "v": 1, "people": [ { "slug", "word", "scale"? } ] }` in display order; an entry shows only with its
PNG. Cut-outs are made and approved in the private pipeline (plan 2026-10-02 "Private pipeline task");
nothing family-specific is ever committed here. With Drive off (the tablet today) People shows black
seats and "No people yet"; pictures holding people still open, save and shelve.

## Re-cutting assets
- Stickers: edit a sticker's `source` + `sha256` in `stickers.json`, run
  `node tools/drawing-fetch-stickers.mjs` (network), then `node tools/drawing-fetch-stickers.mjs --check`.
- Icon: `node tools/drawing-icon.mjs` (sharp from `/home/claude/new-era/node_modules`, tool time only).

## Tests and ports
`tests/drawings.test.mjs` (hub 8477, fake Resend 8479), `tests/drawing-ui.test.mjs` (hub 8478),
`tests/drawing-scene.test.mjs` (no hub). `icons` and `invariants` run on the gate's shared hub.
v2 added no suite and no port: `drawing-scene` (geometry), `drawings` (hub), `drive-mirror` (characters),
`drawing-ui` (the app + per-mode audits) and `invariants.mjs` STATES (`#ring-draw/-people/-places/-items/-carried`).

## Later rungs (spec §10, dad's call)
Resizing or recolouring stickers, stroke widths, an eraser (Undo is the eraser), backgrounds from her
photos, sound effects, a People editor in Settings, printing (spec 2026-10-02 §10); and v1's remaining
rungs (a picture outbox, the TD Snap tile + Drawing.bat, ticking Drawing on devices whose apps.json
predates it).
