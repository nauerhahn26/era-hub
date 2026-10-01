# Drawing — make a picture with your eyes (design, 2026-09-30)

Dad, 9/30: art time today is hand-over-hand or a partner offering "red or blue?".
Ellie should be able to make a picture herself, with very few coarse eye
movements, and end up with something tangible she made. Not MS-Paint (pick a
colour, then draw — too much motor planning). Stickers she grabs — a house, a
horse, a star, a person, a splat — that land in sensible places by themselves.
Undo. A partner can help by touch. "Keep it super simple and let's see how she
uses it. Definitely don't overbuild." Reuse before building; libraries before
scratch.

Decisions taken in the 9/30 brainstorm (dad's words are law):
- **Build a small app** (option A). Nothing drop-in exists — see §9.
- **The centre is the art.** Ring layout: sticker tiles down both sides, the
  picture fills the middle, one black rest tile bottom-centre, Undo and Done
  beside it. No black corner block.
- **Done saves, shelves AND mails** (option C): the picture appears on a "My
  pictures" shelf in the app, and goes to the family email like a Pencil Send.
- **Pictures live in the family's Drive folder** so every device shows them and
  any device can reopen one and keep adding.
- **Plain DOM on the hub's own kit** (approach 1), no canvas library. Konva can
  replace the scene layer later if free strokes ever arrive, without touching
  the ring.

## 1. What it is

A new core app in era-hub at `public/drawing/` (ships by overlay like reader,
settings, home — no pack), registered in `APPS` as
`{ id: "drawing", title: "Drawing", sub: "make a picture with stickers", path: "/drawing/", pack: null }`.
It rides the Pencil module shim (door bar, contract, dwell.js, speech.js,
celebrate.js) so it looks and behaves like her other apps.

Two screens:

1. **The shelf** (`/drawing/`) — her pictures, newest first. The Reader shelf is
   the model: a rail plus a 3×4 centre-black grid, More at [3,1].
2. **The ring** (`/drawing/#p=<id>`) — one picture being made.

Skill ladder (evidence in §9): v1 is the "pick and it lands" rung. "Pick, then
choose where" (2–3 glowing spots), her own gaze-move of a placed sticker,
colour tiles and free strokes are later rungs and are OUT of this spec.

## 2. The ring (the picture screen)

```
┌🚪────────────────💬────────────────────┐   shared door bar (doorbar.js); the
│ House │                      │  Sun   │   touch-only partner tab lives here
│ Horse │     her picture      │ Cloud  │
│ Tree  │       (inert)        │  Star  │
│Person │                      │ Splat  │
│ ↩ Undo│  ■ rest (black)      │ ✔ Done │
└────────────────────────────────────────┘
```

- **Layout**: CSS grid, 3 columns × 5 rows under the door bar. Columns:
  `[tile] [scene 1fr] [tile]`. Rows 1–4: sticker tiles; row 5: Undo (left),
  the rest tile (centre, one tile wide, pure black `#000` on the page's dark
  background, inert, no `.dwell`), Done (right). The middle of row 5 outside
  the rest tile is inert page background. Zero layout shift: the ring never
  moves; only the scene's contents animate.
- **Sticker tiles** are photo tiles (ux-contract §C: picture ≥4/5, whole-word
  plate 24–46 px, exempt from the 74 px floor): `<button class="cell tile dwell">`
  with `<img>` + `<span class="word">`. Left column top→bottom: House, Horse,
  Tree, Person (ground things). Right column: Sun, Cloud, Star, Splat (sky
  things, then the splat). Positions are fixed forever.
- **Undo / Done** are text tiles: glyph + word, font ≥74 px, `.dwell`.
- **Holds**: every tile is her dwell (`CONTRACT.holds.content`, from
  `/settings`); only 🚪 and 💬 in the bar are 2×dwell (doorbar.js does that).
  No other `data-dwell-ms` anywhere on the page (invariants holdSet).
- **The scene is inert.** No `.dwell`, no `data-dwell-*`. Looking at her
  picture does nothing (EyeDraw's Midas-touch lesson, §9). Its `<img>`
  children are `pointer-events` targets for the partner's touch only.
- **Gaze park**: `<html data-park-override="center">`; on boot, resize and
  resume, POST the rest tile's centre (0–1 coords) to
  `http://127.0.0.1:49155/app/park` exactly as `pencil.js` `tellPark()` does.
  With the override declared, Done may occupy the bottom-right (invariants
  `PARK_TARGET`).
- **Sizes**: at 1920×1080 the side tiles are about 220×186 px; at 1280×720
  everything is ≥60 px (invariants second viewport). Gap ≥14 px. Bar height
  from `--bar-h` (doorbar.js writes it).

### 2.1 Placing a sticker ("pick and it lands")

One dwell on a sticker tile:
1. `Speech.stop()`, then speak the word ("Horse").
2. The sticker appears at the tile and animates (≈450 ms, ease-out) into its
   landing slot in the scene. `prefers-reduced-motion` → appears in place.
3. History pushes the placement; the scene autosaves (§4).

Landing rule (zones and slots, all in scene-relative 0–1 units, in
`stickers.json`):
- The backdrop is a **meadow**: sky over grass, horizon at y≈0.58. Drawn with
  CSS gradients in a calm palette (no asset). Only backdrop in v1.
- `zone: "sky"` (Sun, Cloud, Star): slots along the sky band, filled
  centre-out in a fixed order; `zone: "ground"` (House, Horse, Tree, Person):
  slots whose bottom edge sits on the grass, filled centre-out; `zone: "any"`
  (Splat): a random slot from a fixed list anywhere on the picture.
- Each sticker has a `scale` (fraction of scene height; house ≈0.26, tree
  ≈0.28, horse ≈0.20, person ≈0.22, sun ≈0.16, cloud ≈0.14, star ≈0.10, splat
  0.12–0.18 random). Builder tunes by eye at 1920×1080; two suns are allowed.
- When a zone's slots are all taken, filling starts again from the first slot
  with a +0.04 x/y offset per lap (stacking is fine; nothing is refused).
- **Splat** is procedural: an SVG blob path (8–12 control points, random
  radii), filled with a random colour from the calm palette (tokens.css), no
  asset, no licence.

### 2.2 Undo

One dwell: `Speech.stop()`, speak "Undo", pop the last history event (a
placement OR a partner move), re-render, autosave. On an empty history it does
nothing and says nothing — never "wrong". No confirm. Bounded to 60 events.

### 2.3 Done

One dwell (not irreversible, so no two-stage confirm):
1. Render the picture to a PNG (canvas `drawImage` of backdrop + stickers at
   1600×900; ≈15 lines, no library).
2. `POST /drawings/<id>/done` with the PNG body (§5). The hub saves the PNG,
   mails it if the scene changed since the last mail, and answers
   `{saved, mail}`.
3. Celebrate: confetti (`lib/celebrate.js`) and speak what she DID —
   "You made a picture with a horse, a house and two stars!" (names from the
   items list, counted, joined with commas and "and"; empty picture: "You
   made a picture!"). The mail result is NOT spoken (Pencil truth rule: never
   say "sent" unless the hub mailed it); it shows in the partner tab.
4. Return to the shelf, where the picture is the first cell.

### 2.4 The partner (touch only, never `.dwell`)

- **Touch-drag a placed sticker** to move it: `pointerdown` with
  `pointerType === "touch"` on a scene `<img>`, `touch-action: none`, move
  follows the finger, release commits a `move` history event and autosaves.
  Mouse (= ERAgaze) never drags; a gaze that lands on the scene does nothing.
- **Partner tab** in the door bar, the Pencil's `#partnerTab` pattern: opens a
  sheet that freezes every `.dwell` (remove the class, set
  `data-dwell-disabled`; 🚪 and 💬 stay live — `board-partner.js:53-71`) with:
  - **Dwell tune** (800–3000 clamp, Pencil `tuneDwell` precedent).
  - **Clear picture**: two-stage confirm ("Clear the whole picture?" → "Yes,
    clear"), spoken; clears the items and stays in the ring on the same id. A
    picture left empty is not listed on the shelf (§3).
  - **Mail status** line from the last Done: "Sent to your family" /
    "Saved — no family email set up yet" / "Saved — mail failed, will not
    retry" (v1 has no outbox for pictures; the Pencil's outbox is words-only).
- No red anywhere except partner controls (palette law).

## 3. The shelf ("My pictures")

`/drawing/` opens on the shelf (the Reader opens on its shelf; EyeDraw: "I
want to get to stuff on my own"):

- Rail (TD Snap style, like the Reader): **New picture** tile (dwell → the hub
  allocates an id, `#p=<id>`, the ring opens empty). 🚪 is in the door bar.
- 3×4 centre-black grid: the two centre cells black and inert; the other 10
  cells hold pictures newest first, with **More** at [3,1] paging when there
  are more than 9 (the Reader's `SLOTS` + More rule, `reader.js:488-735`).
- A cell is a **thumbnail rendered from `scene.json`** by the same scene
  renderer at small scale (backdrop + stickers), plus a small date plate
  ("Tue 30 Sep"). No PNG needed to show a picture, so a picture made on the
  tablet shows here the moment its scene.json mirrors in.
- Dwell a picture → the ring opens on it; she keeps adding. Done saves and
  mails again only if it changed.
- Pictures with zero items are not listed (a "New picture" she left blank
  never clutters the shelf; the hub deletes empty pictures older than a day on
  boot).

## 4. Data: where a picture lives

A picture is a folder `drawings/<id>/` holding:
- `scene.json` — the source of truth:
  `{ "v": 1, "id", "created", "device", "backdrop": "meadow", "items": [ { "s": "horse", "x": 0.42, "y": 0.71, "w": 0.2, "by": "ellie" | "partner", "c": "#hex" (splats only), "seed": n (splats only) } ], "mailedHash": "<sha1 of items>" | null }`
- `picture.png` — written at Done (1600×900), for mail and for anyone who opens
  the Drive folder. Never read by the app.

Ids: `<YYYY-MM-DD>-<HHMMSS>-<device-id short>` so two devices never create the
same folder.

**Canonical location = the family's Drive folder mount**, exactly as books:
`<folderPath>/drawings/<id>/`. Google Drive for Windows carries it to the other
devices. `drawings` joins `MIRROR_SUBDIRS`, `MIRROR_DELETES` and
`ADOPT_ON_FIRST_SYNC` in `drive.js` (everything under `<DATA>/drawings` arrives
through the mirror, so the ledger may own it from day one; a parent deleting a
picture folder in Drive removes it everywhere). A narrow `mirrorDrawing(id)`
(the `mirrorBook` shape: one folder, `copyTreeLocal`, ledger merged, no
`sync()`, no `onSynced`) puts an own write onto this device's shelf at once
instead of ten minutes later. `scene.json` is compared by content
(`BYTE_COMPARE` list) — a same-length rewrite must still copy.

Rules (the clothing-log laws, applied):
1. **Own writes go to the mount** when `drive.json` is `mode: "local"` with a
   `folderPath` that exists; `<DATA>/drawings` is the mirror's destination.
   The write is `.part` + rename (`atomically`).
2. **Creating `<folderPath>/drawings/` is allowed** (unlike clothing): nothing
   family-only ever lives under `<DATA>/drawings`, so an empty source can only
   ever remove mirror-owned copies. Builder writes the test that proves it.
3. **No mount** (tablet with Drive off, fresh install, offline mount): write
   to `<DATA>/drawings/<id>/` directly and mark the folder `.local` (a dotfile
   the mirror never prunes). The shelf lists both. When a mount appears later,
   `.local` pictures are copied up on the next sync and the marker removed.
4. **Nothing here throws to her.** A failed write logs one line and the ring
   keeps her picture in memory + `localStorage` (`drawing_scene_<id>`), and
   retries on the next change.

Autosave: every history change PUTs `scene.json` (debounced 800 ms, last write
wins). Two devices editing the same picture at once is a Drive conflict copy;
accepted for v1.

## 5. Hub routes (server.js, a `drawings.js` module)

| Route | Body | Does |
|---|---|---|
| `GET /drawings/index.json` | – | `[ { id, created, device, items: n, scene } ]` newest first, non-empty only (scene inlined so the shelf renders thumbnails in one request) |
| `POST /drawings` | `{}` | allocates an id, creates the folder with an empty scene; `{ id }` |
| `PUT /drawings/<id>/scene.json` | scene JSON (cap 64 KB) | validates shape (known sticker ids, 0–1 coords, ≤200 items), writes canonical, `mirrorDrawing(id)`; `{ ok }` |
| `POST /drawings/<id>/done` | `image/png` via `readBinaryBody` (cap 4 MB) | writes `picture.png`; if `sha1(items) !== mailedHash` and `mailConfigured()`: `resendSend` with an attachment (`attachments: [{ filename: "<id>.png", content: base64 }]`, subject "🎨 <name> made a picture", the Pencil's `from`), then records `mailedHash`; `{ saved: true, mail: "sent" | "no-email" | "unchanged" | "failed", reason? }` |
| `GET /drawings/<id>/picture.png` | – | path-jailed static, for the partner tab and tests |

`resendSend(key, to, subject, html, attachments?)` grows an optional fifth
argument; the Pencil path is unchanged. Mail failures never fail the save.
The gate closes the Resend seam, so tests assert `saved` and `mail:
"no-email"`.

## 6. Assets and licences

- Sticker images: **Microsoft Fluent Emoji, 3D style (MIT)** — house, horse
  (🐎), deciduous tree, a child figure for Person (builder picks the most
  readable at tile size; label is the whole word "Person"), sun, cloud, star.
  Vendored as PNG ≥256 px under `public/drawing/stickers/` with the MIT
  LICENSE file beside them and the source URL in `stickers.json`.
- Splat: procedural SVG (no asset).
- Backdrop: CSS gradients (no asset).
- Not used, and why: ARASAAC and Sclera are non-commercial licences (the
  `/symbol/` cache fetches ARASAAC at runtime for the board; bundling it in a
  public MPL-2.0 repo is a different act); OpenMoji/Twemoji are attribution
  or share-alike; Kenney splats are CC0 but the splat is cheaper procedural.
- `stickers.json` (Tux Paint's sidecar idea, flattened):
  `[{ "id": "horse", "word": "Horse", "src": "stickers/horse.png", "zone": "ground", "scale": 0.20, "source": "<url>" }, …]`.
- Family people as stickers (dad's "we generate all these art images") is a
  later rung through the private overlay; never in the public repo.
- App icon: `public/icons/drawing.ico` + `.png` (icons test), made the way the
  other app icons were.

## 7. Laws this design honours (ux-contract, board rules)

- One dwell per user; 2×dwell only for the doors; no invented holds.
- Black rest tile, inert, fixed spot; park override posted like the Pencil.
- Centre-black 3×4 on the shelf; the ring's centre is the picture (dad 9/30).
- Nothing fires on pass-over; nothing times out; no chime; voice only,
  `Speech.stop()` first; never "wrong"; celebration names what she did.
- Touch parity: every dwell tile is also a tap. Partner controls touch-only.
- Photo-tile plates 24–46 px; text tiles ≥74 px; gap ≥14; ≤12 choices (10
  dwell tiles on the ring, 11 on the shelf incl. More and New picture).
- Zero shift; 250 ms settle suppression after a re-render (dwell.js does it).
- Autosave; short sessions; a picture is never lost.
- No family names, infra terms or IPs in the repo (era-scan).

## 8. Tests (gate suites; names unique across the five repos)

- `tests/drawing-ui.test.mjs` — scratch hub + Playwright (the
  `pencil-ui.test.mjs` / `reader-shelf.test.mjs` pattern, `mkdtemp` data dir,
  seams closed, a free port re-grepped and `ss -ltn`-checked at build time):
  ring renders 8 sticker tiles + Undo + Done + rest; a click on Horse adds one
  item in the ground zone at the first centre-out slot and the tile order is
  fixed; Undo removes it; a touch drag moves a sticker and a mouse drag does
  not; reload restores the scene; Done POSTs a PNG and lands on the shelf
  with the picture first; the scene has no `.dwell`; the rest tile is black
  and not `.dwell`; a blank picture is not listed.
- `tests/drawings.test.mjs` — the module + routes: id shape, validation
  rejects unknown stickers and out-of-range coords, mount vs no-mount write
  paths, `.local` marker, `mirrorDrawing` ledger merge, done writes the PNG
  and answers `mail: "no-email"` with the seam closed, `unchanged` on a second
  Done, empty-picture cleanup.
- `tests/drive-mirror.test.mjs` — extend: `drawings` mirrors, prunes only
  ledger-owned, `scene.json` byte-compared.
- `tests/invariants.mjs` `STATES` — add `/drawing/` (shelf) and
  `/drawing/#p=<seeded id>` (ring); both viewports zero violations.
- `apps`, `home-tiles`, `icons`, `packs`, `shortcuts` suites pick up the new
  app; `settings/index.html:792` id list and `build-payload.sh` cp list gain
  `drawing`.
- No family content in fixtures (neutral scenes).

## 9. Research record (9/30, five recon agents)

Nothing drop-in exists. The exact "look at the sticker, then look where it
goes" interaction lives only in closed Windows products: Smartbox Look to
Learn's scene builders and Monster Factory
(https://hub.thinksmartbox.com/app/uploads/2022/08/Look-to-Learn-Manual_Jan-2023.pdf,
$570, its own 1–2 s dwell would double-fire under ERAgaze) and Boardmaker 7's
Stamping template (subscription). Tux Paint (GPL, C) is the one free mouse
app with one-click stamps and 192 px gaze buttons
(https://tuxpaint.org/docs/en/html/OPTIONS.html) but runs outside the kiosk
with no door, rest spot or partner strip. No open-source web sticker scene
maker for gaze exists. Whole editors were checked too: draw.io (Apache-2.0,
click inserts at the view centre, ~9.8 MB minified, takes no contributions),
Penpot (MPL-2.0 but Docker + Postgres + Clojure), SVG-Edit/Method Draw
(drag-to-size), the Canva clones (React/Vue + bundler or commercial),
KTuberling/GCompris/Kidpix (GPL). None beats ~300 lines of DOM. Libraries:
Konva (MIT, plain script, 57 KB gz, no drag/handles by default) is the fallback
if strokes arrive; tldraw needs a licence key, Excalidraw needs React.

Interaction evidence: EyeDraw (Hornof & Cavender, CHI 2005,
https://ix.cs.uoregon.edu/~hornof/downloads/CHI05_EyeDraw.pdf) — ink flowing
from gaze stalls at scribbling (Midas touch); stamps placed by one dwell were
what children with severe motor disability loved; "meaningful to the user"
beat "recognisable"; a look-without-acting mode is essential; an app outside
her own system was "entirely unacceptable". Drag is the hardest gaze action
(Huang 2024, https://diva-portal.org/smash/get/diva2:1903950/FULLTEXT01.pdf);
the standard fix is two steps, pick then place (Tobii Gaze Selection). Rett
guidance (Bartolotta 2020,
https://www.speechpathology.com/articles/back-to-basics-guidelines-for-20378;
Burkhart, https://lindaburkhart.com/wp-content/uploads/2016/06/Rett_Apraxia_short_handout_12.pdf):
wait time up to a minute, no timing, no wrong answers, motor demand drops as
thinking rises, partner is the hands not the author. Practitioner ladders
(Look to Learn, Sensory Eye FX 2) put "any look paints" at the bottom rung and
"pick a part and it is added for you" at the Choose rung — where she already
works on TD Snap. Assets: Fluent Emoji MIT (https://github.com/microsoft/fluentui-emoji);
ARASAAC BY-NC-SA and Sclera BY-NC stay out of the public repo.

## 10. Out of scope (later rungs, on dad's call)

"Where?" second dwell over 2–3 glowing spots; her own gaze-move; colour tiles
that recolour the last sticker; free strokes (EyeDraw look-look); more
backdrops (partner-chosen); family people stickers via the private overlay;
print; a picture outbox with retry; TD Snap Dashboard tile + `Drawing.bat`
launcher (rollout: a seventh `tile-launchers` .bat, CRLF, scp to devices,
`school-prestep.sh` says "six"); enabling the app on devices whose `apps.json`
predates it (dad ticks it in Settings).
