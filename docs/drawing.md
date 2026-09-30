# Drawing — dev note

Spec: `docs/superpowers/specs/2026-09-30-drawing-design.md`. Plan: `docs/superpowers/plans/2026-09-30-drawing-plan.md`.

## Files
- `public/drawing/index.html` — the two screens + the grown-up's sheet; the Pencil's module shim.
- `public/drawing/scene.js` — pure scene logic and THE renderer (`renderScene`): the ring, every
  shelf thumbnail and the mailed PNG all draw through it. node tests import it directly.
- `public/drawing/drawing.js` — the app: boot, router (`#p=<id>`), ring, placing, Undo, autosave,
  park, shelf, Done. `window.Drawing` is its test/partner surface.
- `public/drawing/partner.js` — the tab in the door bar, the sheet, the finger drag.
- `public/drawing/stickers.json` — the eight stickers (seats, words, zones, scales, sha256 pins) and
  the slot tables. `drawings.js` validates scenes against the same file.
- `drawings.js` (hub) — ids, validation, writes, list, one-day blank cleanup, Done + mail.
- `drive.js` — `drawings` in the mirror; `.local`; `mirrorDrawing(id)`.

## Where a picture lives
`<folderPath>/drawings/<id>/{scene.json, picture.png}` when the hub has the family's Drive folder;
otherwise `<DATA>/drawings/<id>/` with a `.local` marker, copied up (and unmarked) on the first sync
after a folder appears. The shelf and the GET routes read `<DATA>/drawings`.
`drawings` is in drive.js's `MIRROR_SUBDIRS`, so "✨ Create it for me" now also makes a `drawings/`
subfolder, the Settings checklist's `content` gains a `drawings` key (its hint and `hasContent` still
name only the five libraries — deliberate: pictures are not "content" to set up), and `adoptLocal`
counts a folder holding only `drawings/` as the family's.

## Re-cutting assets
- Stickers: edit a sticker's `source` + `sha256` in `stickers.json`, run
  `node tools/drawing-fetch-stickers.mjs` (network), then `node tools/drawing-fetch-stickers.mjs --check`.
- Icon: `node tools/drawing-icon.mjs` (sharp from `/home/claude/new-era/node_modules`, tool time only).

## Tests and ports
`tests/drawings.test.mjs` (hub 8477, fake Resend 8479), `tests/drawing-ui.test.mjs` (hub 8478),
`tests/drawing-scene.test.mjs` (no hub). `icons` and `invariants` run on the gate's shared hub.

## Later rungs (spec §10, dad's call)
"Where?" second dwell, her own gaze-move, colour tiles, free strokes (Konva would replace the scene
layer only), more backdrops, family stickers through the private overlay, print, a picture outbox,
the TD Snap tile + `Drawing.bat` launcher, and ticking Drawing on devices whose `apps.json`
predates it (Settings → apps).
