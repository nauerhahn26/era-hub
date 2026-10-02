# Drawing v2 — modes (Draw, People, Stickers, Places) and gaze-move (design, 2026-10-02)

Dad used v0.38.0's Drawing on 10/2: "pretty cool". Two asks, approved the same day:

1. **The bottom row gives her different design options.** Draw (her gaze traces a
   line; the side columns become colours), People (her family from the design
   sheets), Stickers (today's icons), and one more — dad picked **Places**
   (backdrops) as the last option. Undo and Done stay in their corners, the four
   mode tiles sit beside the black square, the current mode glows.
2. **Gaze-move.** "If she looks at an icon she should then be able to move it and
   when she pauses on a new location it drops it there."

Base: v0.38.0 (era-hub e022305), spec `2026-09-30-drawing-design.md` (still the
law for everything not changed here).

## 1. The ring, v2

```
┌🚪────────────────💬────────────────────────┐
│ pal │                            │ pal │   side columns = the mode's palette
│ pal │        her picture         │ pal │   (8 cells; stickers / colours /
│ pal │                            │ pal │    people / places)
│ pal │                            │ pal │
│Undo │ Draw │People│  ■  │Stick.│Places│Done│   row 5: corners unchanged
└────────────────────────────────────────────┘
```

- Row 5 is seven cells: Undo (under the left column), four **mode tiles** and
  the black rest tile under the picture (`[Draw][People][■][Stickers][Places]`,
  equal widths, the rest tile the same width as a mode tile), Done (under the
  right column). Every mode tile is a photo-style tile (glyph ≥4/5 + whole-word
  plate): ✏️ Draw, 👨‍👩‍👧 People, ⭐ Stickers, 🏞️ Places (Fluent 3D PNGs, MIT, vendored
  like the stickers). The active mode carries a teal glow (`--c-teal` border,
  calm palette, never red). At 1920×1080 each row-5 cell is ≈190 px wide; the
  audit floor (90 px / 60 px) holds at both viewports.
- A mode tile is her dwell. Dwelling the active mode does nothing (no toggle,
  no speech). Switching speaks the mode word ("Draw"). The ring remembers the
  last mode in `localStorage` (`drawing_mode`) and opens in **Stickers** the
  first time.
- Positions are fixed forever: the four modes never reorder, and each mode's
  palette has fixed seats (§2–§5). Nothing moves under her gaze.
- Rest tile, park override, door bar, partner tab: unchanged. The partner tab's
  sheet freezes mode tiles like every other `.dwell`.

## 2. Stickers mode

Exactly v1: the eight stickers in their seats, pick-and-it-lands. Plus
gaze-move (§6).

## 3. Draw mode — her gaze traces a line

- **Palette** (fixed seats): left column top→bottom Black, Blue, Green, Yellow;
  right column Red-orange, Purple, Pink, White. Colours from tokens.css where
  they exist (`--c-teal` for Blue, `--c-vowel` for Red-orange, `--c-good-literacy`
  for Green, `--c-confetti-gold` for Yellow) plus `#1b1b1b` Black, `#6a4fb3`
  Purple, `#d96fa6` Pink, `#f7f7f7` White. Partner-red (`#B23A48`) is never a
  crayon. Each tile is a round swatch ≥4/5 of the tile with its word plate. A
  dwell picks the crayon (tile glows) and speaks the colour word. The last
  crayon is remembered per picture (`scene.crayon`); default Blue.
- **The line** (EyeDraw's look-look, adapted): in Draw mode the picture itself
  is ONE dwell target (`#scene` gets `.dwell` only in this mode; items are not
  targets in Draw mode). A dwell on the picture **starts** a stroke at the gaze
  point and speaks nothing. While a stroke is live, the pen follows the gaze
  (`pointermove`, exponential smoothing α=0.35, a point appended every ≥0.6 %
  of scene width moved, ≤400 points per stroke, then it auto-ends), drawn live
  as an SVG `<path>` (round caps/joins, width 1.4 % of scene height). The next
  dwell on the picture **ends** the stroke (the dwell dot is the landing). The
  stroke also ends when her gaze leaves the picture for ≥ `graceMs` + 600 ms,
  on any other dwell (a crayon, a mode, Undo, Done, the doors) and on the rest
  tile. No ink is ever laid without a live stroke, so looking around the ring
  never draws (the Midas-touch law).
- A stroke is an item: `{ "s": "stroke", "c": "#hex", "w": 0.014, "pts": [[x,y],…], "by": "ellie" }`
  in `scene.items` (render order = array order, so a stroke drawn after a
  sticker lies on top). Undo removes the last item, stroke or not. Strokes are
  never move targets (§6) and never partner-draggable; the partner's Clear
  removes them like everything else.
- Thumbnails and the PNG render strokes through the same `renderScene`
  (SVG path in DOM, `lineTo` on canvas).
- Hub validation: `pts` 2–400 pairs in [0,1], `c` one of the eight crayons,
  `w` ∈ [0.005, 0.05]; a stroke counts as one item toward the 200 cap; the
  scene body cap rises to 256 KB (400 points × 200 items would not fit 64 KB).

## 4. People mode — her family from the design sheets

- **Source: a private library in the family's Drive folder**,
  `<folderPath>/characters/`, holding `<slug>.png` (RGBA cut-out, longest side
  ≥512 px, background removed) and `characters.json`:
  `{ "v": 1, "people": [ { "slug": "ellie", "word": "Ellie", "scale": 0.30 }, … ] }`
  in display order (dad's order; the first eight fill the two columns, More at
  the right column's last seat pages through the rest — the Reader's More rule).
  `characters` joins `MIRROR_SUBDIRS`, `MIRROR_DELETES` and `ADOPT_ON_FIRST_SYNC`
  in drive.js exactly like `drawings` (everything under `<DATA>/characters`
  arrives through the mirror). Served by a path-jailed `GET /characters/<file>`
  (`.png`, `.json`), and `GET /characters/index.json` returns the parsed list
  (empty list when the folder or the json is absent or malformed, never 500).
- **Producing the cut-outs is pipeline work, not hub work**, in the private
  ellie-this-week repo: a tool that takes `people/<slug>/sheet.png` (plain
  white, the per-person turnaround) or a dad-chosen render, cuts out the figure
  (the on-device u2netp runtime or fal BiRefNet v2 — whichever gives clean
  alpha), scales to 768 px, and writes `<Drive>/characters/<slug>.png` +
  updates `characters.json`. Dad approves each cut-out before it is written
  (`approved_by_dad`, the character-consistency rule). The roster to start:
  ellie, mom, dad, aidan, saba, savta, jonah, grammy — dad extends by editing
  the json. This spec fixes the file contract only; the tool is its own
  (private) task.
- **Behaviour**: a person is a sticker with `zone: "ground"`, `scale` from the
  json (default 0.30), landing centre-out on the grass like a horse; the word
  spoken is the person's name. `scene.items` stores `{ "s": "person:<slug>", … }`;
  the hub validates `person:` ids against `characters.json` at write time, and
  a slug that has since vanished from the library renders as nothing (the
  picture never errors). No people in the library → the People mode tile is
  shown but its columns hold eight black inert cells and the dwell speaks
  "No people yet" once; the partner sheet shows "Add people: Drive folder →
  characters".
- PNG export and thumbnails draw people from `/characters/<slug>.png` (the
  images come from the hub itself, so the canvas stays exportable).
- Family images never enter the public repo: fixtures use two neutral
  synthetic PNGs (`maya`, `sam`) generated in the test.

## 5. Places mode — backdrops

- Eight backdrops, procedural SVG (no assets, no licences), fixed seats: left
  Meadow (today's), Beach, Night, Snow; right Sunset, Forest, City, Rainbow.
  Each is a `backdrops.js` entry `{ id, word, horizon, svg(w,h), canvas(ctx,w,h) }`
  sharing one geometry so DOM, thumbnail and PNG agree. `horizon` moves the
  ground slot table with it (`base` values are expressed relative to the
  horizon: a backdrop with horizon 0.70 lifts nothing; the sky band and the
  ground band scale between 0 and horizon and horizon and 1).
- A dwell on a place swaps `scene.backdrop`, speaks the word, keeps every item
  where it is (clamping to the new bands is NOT applied — a horse in the sea is
  hers to move), pushes a `backdrop` history event (Undo restores the previous
  backdrop). The active place glows.
- Thumbnails show the backdrop; the shelf and index are unchanged.
- Validation: `backdrop` must be one of the eight ids (unknown → "meadow").

## 6. Gaze-move — look at it, carry it, rest to drop

In Stickers, People and Places modes (not Draw), every placed sticker or
person is a dwell target; the backdrop and strokes are not.

- **Lift**: a dwell on an item speaks its word, lifts it (scale 1.1, a soft
  shadow) and it follows her gaze (pointermove, smoothing α=0.35, lag ≤ 80 ms).
  The item's centre tracks the gaze point clamped to the scene.
- **Drop**: the next dwell **anywhere on the picture** drops it at that point
  (the dwell dot is the landing). While carrying, `#scene` is the dwell target
  and the other items are not (one thing at a time). A `move` history event is
  pushed (`by: "ellie"`), autosave as usual.
- **Put it back**: a dwell on the rest tile, a mode tile, Undo, Done or the
  doors drops the item **where it was** (no history event) and then that
  control acts normally — except Undo, which then undoes the previous event as
  usual, and Done, which proceeds to save.
- **Guards** (Midas touch): an item becomes a target only after the page-settle
  suppression; a lift needs her full dwell; a carried item never leaves the
  scene; no timers — she can carry as long as she likes. Hit area: every item
  target is at least 90 × 90 px at 1920 (60 at 1280): small stickers (a star at
  10 % of scene height ≈ 73 px) get `data-dwell-pad` so their hit box reaches
  the floor, and the invariants audit measures the padded box (the planner
  checks how `tests/invariants.mjs` treats `data-dwell-pad`; if it does not,
  items get a transparent ≥90 px wrapper). Overlapping items: topmost wins
  (array order).
- Partner touch-drag still works in every mode, including on a carried item
  (touch wins: it drops where the finger lets go).

## 7. Data and routes (deltas)

- `scene.json` v1 stays (`v: 1`); new item shapes `stroke` and `person:<slug>`,
  new `crayon` field, `backdrop` ∈ eight ids. Old scenes load unchanged.
- `PUT /drawings/<id>/scene.json` cap 256 KB; validation per §3–§5.
- `GET /characters/index.json`, `GET /characters/<slug>.png` (path-jailed,
  `no-cache`).
- drive.js: `characters` in the three mirror sets; `characters.json` in
  `BYTE_COMPARE`.
- `stickers.json` gains `modes` (the four mode tiles + their seats), `crayons`,
  and `backdrops` (ids + words); zone slot tables become horizon-relative.

## 8. Laws kept

One dwell per user; the doors alone are 2×dwell; no invented holds; black rest
tile inert and in its place; nothing fires on pass-over (ink and lifts need a
dwell; the picture is a target only in Draw mode or while carrying); nothing
times out; voice only, `Speech.stop()` first; never "wrong"; touch parity;
fixed positions; zero shift; dwell choices on the ring = 8 palette + 4 modes +
Undo + Done = 14, inside the contract's 16 cap and above its 12 "comfortable"
line — accepted by dad's 10/2 layout (the modes are coarse, fixed, glyph-only);
if the audit enforces 12 rather than 16, it gets a per-page override for
`/drawing/#p=` citing this spec; family images private;
no red outside partner controls.

## 9. Tests

- `drawing-scene.test.mjs`: strokes (point cap, smoothing determinism, path
  output), backdrop geometry (horizon-relative slots), person items, describe()
  with people and strokes (people are named by their word; strokes are not
  counted in the sentence).
- `drawings.test.mjs`: validation of strokes, crayons, person ids against a
  synthetic characters.json, backdrop ids, 256 KB cap; `/characters/*` routes
  incl. absent library → `[]`.
- `drive-mirror.test.mjs`: `characters` mirrors, prunes only ledger-owned,
  json byte-compared.
- `drawing-ui.test.mjs`: mode row seats and glow; mode switch speaks and
  persists; Draw: a dwell starts, gaze moves, a dwell ends, no ink without a
  live stroke, crayon colour applied, Undo removes the stroke; People: two
  synthetic people land on the grass, More pages, empty library → black cells +
  "No people yet"; Places: swap keeps items, Undo restores; Move: lift → carry →
  drop at the second dwell, put-back on rest/mode/Undo/Done, items not targets
  in Draw mode, partner touch wins; PNG export includes strokes/people/backdrop.
- `invariants`: STATES for each mode (`/drawing/#p=<seeded>&mode=draw|people|places|stickers`
  — a test-only query the page honours only under `__testHooks`), carried-item
  state, both viewports, zero violations; the `maxChoices` override as §8.

## 10. Out of scope

Resizing or recolouring stickers; stroke width choices; eraser (Undo is the
eraser); backgrounds from her photos; sound effects; a People editor in
Settings (dad edits `characters.json`); printing.
