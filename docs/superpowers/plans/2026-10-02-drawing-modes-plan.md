# Drawing v2 — modes (Draw, People, Stickers, Places) and gaze-move — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the shipped Drawing ring (v0.38.0) a bottom row of four mode tiles — Draw (her gaze traces a line in one of eight crayons), People (her family as cut-out stickers from a private Drive library), Stickers (v1, unchanged) and Places (eight procedural backdrops) — and let her lift a placed sticker or person with a dwell, carry it with her gaze, and drop it where she rests.

**Architecture:** Everything rides v1's files. `public/drawing/scene.js` stays THE renderer (`renderScene`, one function, DOM + canvas) and gains pure helpers for strokes (`penStart/penMove/penEnd/penRoom/strokePath/strokeSvg`), people (`withPeople/itemWord`), horizon-relative slots (`slotY`) and hit boxes (`hitBox`); a new pure module `public/drawing/backdrops.js` holds the eight places as DATA (shapes in 1600×900 units) painted by one SVG painter and one canvas painter. The hub side stays in `drawings.js` (validation of strokes / crayons / people / backdrops, 256 KB, the characters library) behind thin routes in `server.js`; `drive.js` mirrors `characters/` exactly like `drawings/`. `public/drawing/drawing.js` grows the mode row, the per-mode palettes, the stroke and carry state machines and a gaze-following landing spot; `partner.js` learns hit boxes and "touch wins".

**Tech Stack:** Node 22 (no package.json, no deps in the hub), plain browser JS (classic scripts + the module shim), node:test + Playwright (resolved from `/home/claude/new-era/node_modules`), Microsoft Fluent Emoji 3D PNGs (MIT) for three new mode glyphs.

**Spec:** `docs/superpowers/specs/2026-10-02-drawing-modes-design.md` (commit `02efe4e`, dad-approved 10/2). v1's spec `docs/superpowers/specs/2026-09-30-drawing-design.md` is still the law for everything v2 does not change, and v1's plan `docs/superpowers/plans/2026-09-30-drawing-plan.md` still defines the names this plan does not redefine (ids, routes, mail lines, page hooks, the How-to-run recipe). Executors read the v2 spec and this plan; the spec wins on intent, this plan wins on names and numbers.

**Worktree:** `/home/claude/new-era/era-hub--wt-drawing-modes`, branch `feat/drawing-modes`, base `02efe4e` (= master `e022305` + the spec). Only era-hub changes, so the gate needs no `ERA_WT_SUFFIX`. Never touch the frozen main checkout `/home/claude/new-era/era-hub`, the v1 worktree `/home/claude/new-era/era-hub--wt-drawing`, or any sibling repo.
**Discipline:** TDD every task — the test is written and SEEN to fail, then the code. A fresh-context builder per task; the overseer reviews between tasks. No "while I'm here" changes. STOP and report instead of improvising when: a test outside this plan starts failing, an assertion would have to be weakened to pass, the contract audit (T10) can only be satisfied by moving a tile the spec fixes, or dwell.js would have to change (it is era-core's file, mirrored here — never edit `public/dwell.js`).
**Commits:** house style `drawing: <what> — <why> (spec 2026-10-02 §N)`; add the attribution trailers your own session's system prompt names. `git add` exact paths, never `-A`. The pre-commit hook runs era-scan over the worktree: no family names except Ellie, no infra terms, no IPs other than loopback. Fixtures use the neutral people `maya` / `sam` (spec §4) and device ids like `test-dev`. Never write a family member's name or slug into code, tests or this repo's docs — the private roster lives in the family's Drive and in the private pipeline.

---

## Spec deviations (each is the nearest faithful thing; reason given)

1. **The stroke ends, and a carried item drops, on a gaze-following landing spot (`#spot.dwell`), not on `#scene` as a dwell target.** dwell.js measures a dwell as time spent on ONE ELEMENT, however the gaze moves inside it (`public/dwell.js:252-253` — `el === current` keeps `away=false`; `:190-193` — progress then grows every frame and fires at `holdMs`). With the whole picture as the target, every stroke would end and every carry would drop about one dwell after the 48 px rearm (`:243-248`), so "the pen follows the gaze" and "she can carry as long as she likes" (§3, §6) could not hold. The spot is a ≥ floor-sized circle centred on her gaze that is RE-CREATED (a new element) whenever her gaze leaves its square; dwell.js treats a new element as a new target (`:259`), so only a real REST fires it — exactly "the dwell dot is the landing". Starting a stroke keeps §3's mechanism unchanged: in Draw mode, idle, `#scene` itself is the `.dwell`.
2. **Item hit boxes are transparent `.hit` elements, not `data-dwell-pad`.** dwell.js reads `data-dwell-pad` only for the hysteresis halo of a target that is ALREADY armed (`public/dwell.js:95-99, 159-162`); acquisition is `elementsFromPoint` + `closest(".dwell")` (`:149-158`) and never looks at the pad. `tests/invariants.mjs` measures `getBoundingClientRect()` (`:120-122, 143-162`) and never reads the attribute either. So, as §6 itself prescribes for this case, every sticker/person gets a transparent `.hit.dwell` box ≥ the audit floor, centred on the item and kept inside the picture.
3. **No `maxChoices` override.** `tests/invariants.mjs` counts no choices at all: MEASURE returns only `nTargets` (`:272`) and nothing in the file reads `maxChoices` (`public/lib/contract.js:70-74` defines `{ ideal: 2, comfortable: 12, cap: 16 }`; only `era-core/tests/lib-contract.test.mjs:76` pins those values). There is nothing to override. Instead `drawing-ui` pins the ring's choices — 8 palette + 4 modes + Undo + Done = 14 — at ≤ `CONTRACT.maxChoices.cap` (T5).
4. **People tile glyph = 🫂 People hugging; the Stickers tile reuses the vendored star.** Fluent Emoji has no family ZWJ assets at the pinned commit (`assets/Family*` are 404; the folder listing has no `Family` entry; probed 10/2). People hugging (`assets/People%20hugging/3D/people_hugging_3d.png`, 256×256) is the nearest "people" glyph; Busts in silhouette (`assets/Busts%20in%20silhouette/3D/busts_in_silhouette_3d.png`, sha256 `1169de2f4d600067bc3a135d584cbbfc38ef5212148089dcaff7dedb0dc3d805`) is the alternate if dad prefers. ⭐ Stickers points at `stickers/star.png` (same pin as the Star sticker) — no second copy.
5. **The rest tile "dwell" while a stroke is live or an item is carried is the app's own watch, not a `.dwell`.** The rest tile must stay inert (v1 §2, invariants). drawing.js times continuous gaze inside `#restTile`'s rect for her dwell (`Dwell.config.ms`) and then settles (stroke ends / item goes back). No fill, no class, no `data-dwell-*` on the tile.
6. **Backdrops: words and seats in `stickers.json`, geometry in `backdrops.js`; `svg`/`canvas` are two painters over shared `shapes`.** §5 sketches each entry as `{ id, word, horizon, svg(w,h), canvas(ctx,w,h) }`. Hand-written per-entry painters could drift; here each entry is `{ id, horizon, shapes }` and `backdropMarkup()` / `paintBackdrop()` read the same shapes — DOM, thumbnail and PNG agree by construction. The hub validates ids from `stickers.json` `backdrops[]` (one list the page and the hub share, like the stickers); a test pins that the two id lists are equal.
7. **Horizon-relative slots keep v1's numbers.** `stickers.json` keeps its slot tables and `"horizon": 0.58` as the REFERENCE horizon they are written against; `slotY()` maps them onto a backdrop's horizon `h` (ground `base' = h + (base − 0.58)·(1 − h)/0.42`, sky `y' = y·h/0.58`, `any` unchanged). The spec's "a backdrop with horizon 0.70 lifts nothing" is read as "the reference horizon leaves v1's slots exactly where they were" — so Meadow and Rainbow (h = 0.58) land exactly as v1 and v1's landing tests stay green.
8. **Person ids are validated against the library, with grandfathering.** A PUT whose scene names a `person:<slug>` the library does not have is refused (§4) — unless the hub's CURRENT copy of that picture already holds it. Without that, a picture with a person who later left `characters.json` (or never reached this device) could never be saved again: every PUT would be 400 and the picture would live in localStorage forever. `list()` checks shape only, so another device's picture is never hidden from this shelf.
9. **Unknown crayon → Blue**, normalised like an unknown backdrop → `meadow` (§5), never a 400.
10. **`index.json` thins strokes.** `list()` inlines every scene for the thumbnails; with 256 KB scenes and a 60 s shelf poll that is megabytes a minute. `list()` sends each stroke's points thinned to ≤ 60 (first, last, evenly spaced); `GET /drawings/<id>/scene.json` stays whole.
11. **Points are rounded to 3 decimals and the page keeps an ink budget.** A point costs ≤ 14 bytes of JSON; the page refuses to start, and auto-ends, a stroke so the scene body stays under 240 KB — the hub's 256 KB cap is never hit by her ink (a 413 would leave the picture unsaved). Silent, like v1's 200-item cap.
12. **A palette tile dwelled while carrying puts the item back, then acts.** §6 lists the rest tile, mode tiles, Undo, Done and the doors; a sticker / person / place / More tile follows the same rule (the only consistent reading of "nothing moves under her gaze").
13. **Cool-down after a drop (additive Midas guard).** The item she just dropped sits under her gaze; it is not a lift target again until her gaze has left its hit box once. Otherwise the drop → 48 px drift → re-lift loop would make her picture "grab back".
14. **"No people yet" replaces the mode word** on a switch into People with an empty library (§4 "speaks 'No people yet' once" — once per switch; a dwell on the already-active People tile does nothing, as for every mode).
15. **`describe()` names each person once** ("…with Maya, a horse and Sam!"), however many times she placed them, and skips ids the table does not know (a vanished person, a newer version's sticker) as well as strokes (§4: "strokes are not counted in the sentence").
16. **A live stroke ends / a carried item goes back** also when the grown-up's sheet opens, on route changes (Done → shelf) and on `pagehide` — §3/§6 list the doors; these are the same "leaving the moment" cases.
17. **Only a mouse/pen pointer (= ERAgaze) moves the pen or the carried item.** A finger tap on the picture is touch parity for her dwell (ends the stroke / drops there); finger MOVES never ink — they are the partner's drag.
18. **Canvas strokes are painted from the same path string** (`ctx.stroke(new Path2D(d))`, the splat's way) rather than a separate `lineTo` loop — one geometry for DOM and PNG.
19. **Row-5 cells are ≈ 262 × 181 px at 1920** (spec "≈190 px wide"): the five cells split the picture column (≈ 1365 px) with 14 px gaps. ≈ 167 × 115 at 1280. Both clear the 90/60 floors.

## Preflight (verified 10/2 against `02efe4e`; line numbers are anchors — grep the quoted text if they drifted)

| Fact | Where |
|---|---|
| dwell.js: a target is `closest(".dwell:not([data-dwell-disabled])")` of `elementsFromPoint` | `public/dwell.js:149-158` |
| dwell.js: progress accrues while the gaze stays on the SAME element, however it moves inside it; a different element restarts from 0 | `public/dwell.js:252-262`, `:190-193` |
| dwell.js: `data-dwell-pad` = hysteresis halo only | `public/dwell.js:95-99, 159-162` |
| dwell.js: after a fire nothing re-arms until the gaze is `rearmPx` (48) away | `public/dwell.js:243-248`, `index.html:15-18` |
| dwell.js: the gaze point is NOT exposed (`Dwell.state()` has no x/y); it listens to `mousemove` on `document` (capture). An app that needs the point tracks `pointermove` itself | `public/dwell.js:265, 380-384` |
| dwell.js: a fire is `el.click()` (a synthetic click — `clientX/Y` are 0), so a scene click must read the app's own tracked pointer | `public/dwell.js:224-231` |
| dwell.js injects `.dwell{position:relative;touch-action:none}` AFTER `drawing.css` (its `<style>` is appended when the script runs) — an absolutely positioned `.dwell` needs an id-qualified selector (`#hits > .hit`, `#scene > .spot`) | `public/dwell.js:56-74` |
| `Dwell.suppress(ms)` = page-settle (clears the live dwell); `Dwell.config.ms/graceMs` readable | `public/dwell.js:367-385` |
| Drawing does not set `gazeSpace`, so ERAgaze drives the page through the OS cursor (pointer/mouse events) | `public/drawing/index.html:15-18` |
| invariants: size = `getBoundingClientRect`, floor `90 × vw/1920`; OCCLUDED = centre pixel must resolve to the target; MINGAP = any two targets 1.5–14 px apart; photo tiles (`.photo` or a `.plate`) only need 24 px text | `tests/invariants.mjs:52, 120-171, 173-184, 138-140` |
| invariants: no choice count anywhere; `STATES` are `{id, path, setup?}`, `setup` runs in the page after load (page globals only); `__testHooks` is set before any script | `tests/invariants.mjs:272, 282-315, 324, 334` |
| `CONTRACT.maxChoices = { ideal: 2, comfortable: 12, cap: 16 }` | `public/lib/contract.js:70-74` |
| Ring grid: 3 cols × 5 rows; `#restTile` is grid row 5 col 2, `width:var(--side)`, centred | `public/drawing/drawing.css:38-48` |
| `#scene` is inert today: no `.dwell` anywhere inside; `#scene .item` are pointer targets for the finger only | `public/drawing/index.html:42`, `drawing.css:49-50`, `partner.js:55-83` |
| `route()` accepts only `^#p=([^&]+)$` | `public/drawing/drawing.js:143-148` |
| Autosave: `changed()` → `stash()` + 800 ms debounce → `save()` PUTs the whole scene | `public/drawing/drawing.js:22, 237-256` |
| `renderScene(target, scene, {table, images})`: `typeof target.drawImage === "function"` → canvas, else DOM (`replaceChildren` on the target) | `public/drawing/scene.js` (bottom) |
| `S.images` keyed by item `s`; `exportPng` awaits every image's `decode()` | `public/drawing/drawing.js:136, 438-444` |
| Freeze: every `.dwell` but the doors → `data-dwell-disabled`; `refreeze()` after every render while the sheet is up | `public/drawing/drawing.js:288-304` |
| Hub: `LIMITS.sceneBytes = 64 KB`, the PUT route streams against it (413); `validateScene` refuses any backdrop but meadow and `writeScene` hard-codes `backdrop: "meadow"` | `drawings.js:26, 154-179, 189-199`; `server.js:2503-2530` |
| `serveMediaJail(req,res,jail,rest,exts,avExts,denyDirs,resolveDir,cacheControl)` | `server.js:688` |
| drive.js mirror sets: `MIRROR_SUBDIRS:38`, `MIRROR_DELETES:187`, `ADOPT_ON_FIRST_SYNC:213`, `BYTE_COMPARE:307`; header list `:5-11` | `drive.js` |
| `drive-mirror.test.mjs:202-203` pins `Object.keys(drive.status().content)` | must gain `characters` |
| v1 UI tests that change with v2: ring dwell count 10 (`drawing-ui.test.mjs:134, 164, 367, 372`), `box.firstElementChild` is the splat (`:180`), shelf thumb `bg` linear-gradient (`:525`), "her picture … inert" (`:117-137`); hub: "one backdrop in v1" (`drawings.test.mjs:118`), 66 KB → 413 (`:359-360`) | updated in the task that changes them |
| Fluent 3D, commit `1ffb34c752ecf5d402f04cfb4b392c77f57c54bc`, all 256×256: Pencil `c33b52acc157fe010851709a6ba06ee7b9e107f9e421436c97fd4404c25dec3f`, People hugging `6fa8b93833d8708195dc8e3dfc94c10c80ca838647e27deb0ed53e95e96ab844`, National park `7923efeea75cd3ebfaf5589064b7ea5fd8c89d68d17555c5083f28483300fc48` | fetched 10/2 |
| `zlib.crc32` exists (Node 22.22) — tests can build tiny synthetic PNGs without sharp | `node -v` |
| Ports: v2 adds no suite; it reuses 8477/8479 (`drawings.test`) and 8478 (`drawing-ui.test`); nothing listens on them (`ss -ltn`, 10/2) | v1 plan "Global Constraints" |
| Master gate on `e022305`: `116 passed, 0 failed`; v2 adds no suite file | land line of `e022305` |

## Global Constraints

- Everything in v1's plan "Global Constraints" still holds (holds, park, sizes, speech, autosave, ids, mail, ports, suite names), except: **scene body ≤ 256 KB** (was 64 KB).
- Row 5, left to right: Undo, ✏️ Draw, 🫂 People, ■ rest, ⭐ Stickers, 🏞️ Places, Done. Five equal cells under the picture; the rest tile is pure black, inert, the same size as a mode tile.
- Modes never reorder; palettes have fixed seats: left column rows 1→4 then right column rows 1→4 (`SEATS`).
- First open: Stickers. Remembered in `localStorage` key `drawing_mode`. The page honours `&mode=<id>` in the hash ONLY when `window.__testHooks` is set.
- Active mode, current crayon and current place glow teal (`--c-teal`, `#0F7C8A`); never red. Partner red `#B23A48` is never a crayon, a backdrop colour or anything in her path.
- Crayons (word, hex): Black `#1b1b1b`, Blue `#0F7C8A`, Green `#2E7D5B`, Yellow `#B7822B`, Red-orange `#DE7B52`, Purple `#6a4fb3`, Pink `#d96fa6`, White `#f7f7f7`; default Blue.
- Stroke: smoothing α = 0.35, a point every ≥ 0.006 scene widths, ≤ 400 points, width 0.014 of scene height, round caps/joins; 3-decimal points; the stroke leaves after `graceMs + 600` ms off the picture.
- No ink without a live stroke; no lift without her full dwell; nothing in Draw mode is a move target; strokes are never move targets nor finger-draggable.
- Every dwell target ≥ 90 px at 1920 and ≥ 60 px at 1280 (`F = ceil(90·innerWidth/1920) + 1`); gaps ≥ 14 px; zero layout shift.
- People library: `<DATA>/characters/{characters.json,<slug>.png}` via the mirror; slugs `^[a-z0-9][a-z0-9-]{0,39}$`; never a family image in this repo.
- "Keep it super simple … definitely don't overbuild" (dad 9/30) still applies.

## Review Focus

The five inputs the spec implies but its test list does not exercise, most likely to bite first. Each has its test in the owning task (named there).

1. **Looking around her picture while a stroke is live, then glancing at a crayon and back within a second** — the stroke continues (no new stroke, no lost ink), and the crayon dwell (if it completes) ends the stroke first, then switches colour. → T7 test "a glance off the picture shorter than the grace keeps the stroke; a crayon dwell ends it, then switches".
2. **A partner's finger drag in Draw mode** (on a sticker, over the picture that is a dwell target) — moves the sticker and never starts a stroke. → T9 test "a finger drag in Draw mode moves a sticker and never starts a stroke".
3. **A picture holding a person who has since left the library** — it opens, renders without them, keeps them in `items`, and still saves (hub grandfathering). → T8 test "a person who left the library: drawn as nothing, kept, and the picture still saves".
4. **Ink near the byte cap** — a picture already holding ~240 KB of strokes refuses a new stroke silently and never sends a PUT the hub would 413. → T7 test "ink budget: a nearly full picture refuses a new stroke and never sends a body over the cap".
5. **Drop, then keep looking at the dropped item** — it is not lifted again until her gaze leaves it once. → T9 test "a dropped item is not lifted again until her gaze has left it once".

---
## Definitions (every task uses these names and numbers)

### Files

| Path | Responsibility | Task |
|---|---|---|
| `public/drawing/stickers.json` (modify) | + `modes`, `crayons`, `crayonDefault`, `backdrops`; slot tables stay, written against the reference `horizon` 0.58 | T1 |
| `public/drawing/stickers/mode-draw.png`, `mode-people.png`, `mode-places.png` | vendored Fluent 3D (MIT) mode glyphs | T1 |
| `tools/drawing-fetch-stickers.mjs` (modify) | also fetches/verifies `modes[]` | T1 |
| `public/drawing/backdrops.js` (new) | the eight places as data + `backdropMarkup / backdropSvg / paintBackdrop / backdropById / horizonOf` | T2 |
| `public/drawing/scene.js` (modify) | `slotY`, horizon-aware `landing` (T1); backdrop in `renderScene` (T2); strokes, people, `describe` (T3); `hitBox` (T9) | T1, T2, T3, T9 |
| `drawings.js` (modify) | validation v2, 256 KB, `characters()`, grandfathering, `list()` thinning | T4 |
| `server.js` (modify) | `GET /characters/index.json`, `GET/HEAD /characters/<slug>.png|characters.json` | T4 |
| `drive.js` (modify) | `characters` in `MIRROR_SUBDIRS` / `MIRROR_DELETES` / `ADOPT_ON_FIRST_SYNC`; `characters.json` in `BYTE_COMPARE` | T4 |
| `public/drawing/index.html` (modify) | `#modeRow`, `#art`/`#pen`/`#hits` inside `#scene`, `#pPeople` line, `backdrops.js` on the shim | T5, T8 |
| `public/drawing/drawing.css` (modify) | row 5, glow, palettes, hits, spot, pen, carried | T5–T9 |
| `public/drawing/drawing.js` (modify) | modes, palettes, Places, Draw, People, gaze-move | T5–T9 |
| `public/drawing/partner.js` (modify) | `#pPeople`; finger drag via `.hit`, strokes skipped, "touch wins", click swallow | T8, T9 |
| `tests/drawing-scene.test.mjs` (modify) | pure geometry: slots, backdrops, strokes, people, describe, hit boxes | T1, T2, T3, T9 |
| `tests/drawings.test.mjs` (modify) | assets (T1); hub validation, characters, routes (T4) | T1, T4 |
| `tests/drive-mirror.test.mjs` (modify) | `characters` mirror | T4 |
| `tests/drawing-ui.test.mjs` (modify) | the app in Playwright | T2, T5–T10 |
| `tests/invariants.mjs` (modify) | `STATES` per mode + carried | T10 |
| `docs/drawing.md` (modify) | dev note v2 | T11 |

**THE renderer stays one function:** `renderScene(target, scene, { table, images })` in `scene.js`. Every picture surface — the ring's `#art`, each shelf thumbnail, the New-picture tile, the exported 1600×900 PNG — goes through it. The live pen (`#pen`) and the Places tiles reuse its helpers (`strokeSvg`, `backdropSvg`), exactly as v1's Splat tile reuses `splatSvg`. Hit boxes and the landing spot are input chrome, not rendering, and live in drawing.js.

### The ring v2 (fixed forever)

```
┌🚪───────────────💬─────────────── ⚙ grown-ups┐
│ [1,1] │                            │ [1,3] │   side columns = the mode's palette (SEATS)
│ [2,1] │      #scene (16:9)         │ [2,3] │
│ [3,1] │  #art · #pen · #hits · #spot│ [3,3] │
│ [4,1] │                            │ [4,3] │
│ Undo  │Draw│People│ ■ │Stickers│Places│ Done │   row 5: #btnUndo · #modeRow(5 cols) · #btnDone
└──────────────────────────────────────────────┘
```

- `SEATS = [[1,1],[2,1],[3,1],[4,1],[1,3],[2,3],[3,3],[4,3]]` — palette cell k sits at `SEATS[k]`. Every palette cell carries class `pal` and `data-seat="r,c"`.
- `#modeRow` = grid row 5, column 2, `grid-template-columns: repeat(5, minmax(0,1fr))`, gap 14. Columns: 1 `#mode-draw`, 2 `#mode-people`, 3 `#restTile`, 4 `#mode-stickers`, 5 `#mode-places`.
- Mode tile: `<button class="cell mode photo dwell" id="mode-<id>" data-mode="<id>">` + `<img class="pic">` + `<span class="word plate">Word</span>`; `.on` when active.
- Palette cells by mode (8 per mode, in `SEATS` order):

| Mode | Cell element | id | Seats |
|---|---|---|---|
| stickers | v1's sticker tile `cell tile photo dwell pal` | `tile-<id>` | `stickers[k].at` (= `SEATS[k]`) |
| draw | `cell crayon photo dwell pal`, a round swatch `.pic.swatch` (`--sw: <hex>`) + plate | `crayon-<id>` | `crayons[k].at` |
| places | `cell place photo dwell pal`, `.pic` holding `backdropSvg(id)` + plate | `place-<id>` | `backdrops[k].at` |
| people | `cell person photo dwell pal`, `<img class="pic" src="/characters/<slug>.png">` + plate | `person-<slug>` | display order |
| people, > 8 | the last seat `[4,3]` is `#peopleMore` (`cell text dwell pal`, glyph ▶ + word "More") | `peopleMore` | `[4,3]` |
| any empty seat | `<div class="pal-black" aria-hidden="true">` — black, inert | — | — |

### `stickers.json` additions (exact)

```json
"modes": [
  { "id": "draw",     "word": "Draw",     "seat": 1, "src": "stickers/mode-draw.png",
    "source": "https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/Pencil/3D/pencil_3d.png",
    "sha256": "c33b52acc157fe010851709a6ba06ee7b9e107f9e421436c97fd4404c25dec3f" },
  { "id": "people",   "word": "People",   "seat": 2, "src": "stickers/mode-people.png",
    "source": "https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/People%20hugging/3D/people_hugging_3d.png",
    "sha256": "6fa8b93833d8708195dc8e3dfc94c10c80ca838647e27deb0ed53e95e96ab844" },
  { "id": "stickers", "word": "Stickers", "seat": 4, "src": "stickers/star.png",
    "source": "https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/Star/3D/star_3d.png",
    "sha256": "b935cdf502b69054bc2b08e7ba4e4eaba6499564a2041dd77d6291e21bf8cfe8" },
  { "id": "places",   "word": "Places",   "seat": 5, "src": "stickers/mode-places.png",
    "source": "https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/National%20park/3D/national_park_3d.png",
    "sha256": "7923efeea75cd3ebfaf5589064b7ea5fd8c89d68d17555c5083f28483300fc48" }
],
"crayons": [
  { "id": "black",      "word": "Black",      "hex": "#1b1b1b", "at": [1, 1] },
  { "id": "blue",       "word": "Blue",       "hex": "#0F7C8A", "at": [2, 1] },
  { "id": "green",      "word": "Green",      "hex": "#2E7D5B", "at": [3, 1] },
  { "id": "yellow",     "word": "Yellow",     "hex": "#B7822B", "at": [4, 1] },
  { "id": "red-orange", "word": "Red-orange", "hex": "#DE7B52", "at": [1, 3] },
  { "id": "purple",     "word": "Purple",     "hex": "#6a4fb3", "at": [2, 3] },
  { "id": "pink",       "word": "Pink",       "hex": "#d96fa6", "at": [3, 3] },
  { "id": "white",      "word": "White",      "hex": "#f7f7f7", "at": [4, 3] }
],
"crayonDefault": "#0F7C8A",
"backdrops": [
  { "id": "meadow", "word": "Meadow", "at": [1, 1] }, { "id": "beach",  "word": "Beach",  "at": [2, 1] },
  { "id": "night",  "word": "Night",  "at": [3, 1] }, { "id": "snow",   "word": "Snow",   "at": [4, 1] },
  { "id": "sunset", "word": "Sunset", "at": [1, 3] }, { "id": "forest", "word": "Forest", "at": [2, 3] },
  { "id": "city",   "word": "City",   "at": [3, 3] }, { "id": "rainbow", "word": "Rainbow", "at": [4, 3] }
]
```
Inserted after `"lapOffset": 0.04,`. Everything else in the file is unchanged.

### Backdrops (`backdrops.js`, 1600×900 units; horizon = where the ground band starts)

| id | horizon | look (calm palette, never red) |
|---|---|---|
| meadow | 0.58 | v1's sky over grass |
| beach | 0.66 | sky, sun, sea band 0.48–0.66, sand |
| night | 0.62 | navy sky, moon, six stars, dark grass |
| snow | 0.60 | pale sky, soft white hills, snow |
| sunset | 0.64 | violet→pink→apricot sky, low sun, dark grass |
| forest | 0.70 | sky, two clumps of pines, grass |
| city | 0.72 | sky, two layers of buildings, pavement |
| rainbow | 0.58 | meadow sky, six-band rainbow, grass |

**Horizon-relative slot formula** (`slotY(zone, slot, w, h, ref)`, `ref = stickers.json horizon = 0.58`):
`ground: y = h + (slot.base − ref)·(1 − h)/(1 − ref) − w/2` · `sky: y = slot.y · h / ref` · `any: y = slot.y` — then v1's lap offset, then `clampItem`. At `h = ref` this is v1 exactly.

### Item shapes (`scene.items`, render order = array order)

| Item | Shape (hub-normalised key order) |
|---|---|
| sticker (v1) | `{ "s": "horse", "x", "y", "w", "by" }` (+ `"c", "seed"` on splats) |
| person | `{ "s": "person:<slug>", "x", "y", "w", "by" }` — `w` = the person's `scale` |
| stroke | `{ "s": "stroke", "c": "<crayon hex>", "w": 0.014, "pts": [[x,y], …], "by": "ellie" }` — 2–400 points, each in [0,1], 3 decimals |

Scene gains `"crayon": "<hex>"` (default `#0F7C8A`); `"backdrop"` ∈ the eight ids (unknown → `"meadow"`). `v` stays 1.

### `characters.json` (in the family's Drive folder `characters/`, mirrored to `<DATA>/characters/`)

```json
{ "v": 1, "people": [ { "slug": "maya", "word": "Maya", "scale": 0.30 }, { "slug": "sam", "word": "Sam" } ] }
```
- Display order = array order. `slug` `^[a-z0-9][a-z0-9-]{0,39}$`, unique; `word` 1–24 chars (trimmed); `scale` ∈ [0.1, 0.6], default 0.30. An entry shows only when `<slug>.png` exists beside the json. Anything malformed → that entry is skipped; an unreadable file → `[]`.
- `GET /characters/index.json` → `[ { slug, word, scale } ]` (the shown entries, in order); never 500.

### State machines (drawing.js)

**Draw** (`S.mode === "draw"`):

| State | Targets | Event → effect → next |
|---|---|---|
| **idle** (`S.pen === null`) | `#scene` is `.dwell`; crayons, modes, Undo, Done | dwell/tap on `#scene` → if not paused, < 200 items and `penRoom ≥ 2`: `penStart` at her gaze point (silent), `#pen` shown, `#scene` loses `.dwell`, `#spot` placed at her gaze → **live**; otherwise nothing |
| **live** (`S.pen` set) | `#spot`; crayons, modes, Undo, Done | mouse/pen `pointermove` inside the picture → `penMove` (α 0.35, ≥ 0.006 widths) + redraw + spot follows → **live**; reaching `pen.room` points → **ended** |
| live | | `pointermove` outside the picture → spot removed, leave timer `graceMs + 600` armed (re-entry disarms it) → timer fires → **ended** |
| live | | dwell on `#spot` / finger tap on the picture → `penEnd` with the landing point → **ended** |
| live | | any other control (crayon, mode, Undo, Done, a door, the sheet opening, the shelf, `pagehide`) → **ended**, then that control acts |
| live | | rest watch (gaze inside `#restTile` for her dwell) → **ended** |
| **ended** (transient) | | ≥ 2 points → push `{s:"stroke",…}`, history `place`, repaint, autosave; < 2 → discarded silently; spot and pen removed; `#scene` `.dwell` again → **idle** |

**Move** (`S.mode` ∈ stickers, people, places):

| State | Targets | Event → effect → next |
|---|---|---|
| **idle** (`S.carry === null`) | one `.hit` per sticker/person (not strokes, not the cooled item); palette, modes, Undo, Done | dwell/tap on `.hit` i → speak its word, `S.carry = {i, sx, sy}`, art gets `.carried`, hits cleared, `#spot` placed at her gaze → **carried** |
| **carried** | `#spot`; palette, modes, Undo, Done | mouse/pen `pointermove` → smoothed centre (α 0.35) clamped inside the picture, art follows; spot follows inside the picture, removed outside → **carried** (no timer, ever) |
| carried | | dwell on `#spot` / finger tap on the picture → **dropped** at the landing point |
| carried | | finger drag on the carried item → **dropped** where the finger lets go, `by:"partner"` (touch wins) |
| carried | | rest watch, any palette tile, mode tile, Undo, Done, a door, the sheet, the shelf, `pagehide` → **put back**, then that control acts (Undo then undoes the previous event; Done saves) |
| **dropped** (transient) | | history `{t:"move", i, from}`, item `x,y` = clamped landing, `by:"ellie"` (or partner), `S.cool = i`, repaint, autosave → **idle** |
| **put back** (transient) | | no history, no save; repaint at the stored position → **idle** |

`S.cool` (the dropped item) has no `.hit` until a `pointermove` falls outside its hit box; then `S.cool = null` and hits repaint.

### Hit-box rule and the landing spot

- `F = Math.ceil(90 * innerWidth / 1920) + 1` px (91 at 1920, 61 at 1280) — above invariants' floor `90·vw/1920` at every width.
- `hitBox(op, W, H, F)` (scene.js): the item's art box in px (`op.left·W`, `op.top·H`, `op.width·W`, `op.height·H`), grown to at least F×F about its centre, then SHIFTED (never shrunk) to lie inside the W×H picture. Hit elements are `<div class="hit dwell" data-hit="<i>" aria-label="<word>">` in `#hits`, DOM order = item order, so overlapping hits: topmost (latest) wins.
- `#spot`: a `<div id="spot" class="spot dwell" aria-label="Here">` F×F, centred on her gaze and clamped inside the picture; re-created (new element) whenever her gaze leaves its square; its centre is the landing point.

### Spoken lines (v2 additions; `Speech.stop()` first, always)

| Act | Says |
|---|---|
| switch mode | the mode word ("Draw", "People", "Stickers", "Places"); a switch into People with no library: `No people yet` |
| dwell the active mode | nothing |
| crayon / place / person tile | its word (also when it is already the current one) |
| More (people) | nothing (v1's More is silent) |
| stroke start / end, drop, put back | nothing |
| lift | the item's word (sticker word, or the person's `word`) |
| Done | `describe()` — people named once each by their word, strokes not counted |

### Page state and hooks (additions to v1's)

- `localStorage`: `drawing_mode` → one of the four ids (try/catch).
- `window.Drawing.state()` gains `mode, crayon, backdrop, pen` (`null` or `{ n, c }`), `carrying` (`null` or item index), `cool`, `people` (slugs), `peoplePage`, `peoplePages`.
- `window.Drawing` gains `setMode(id)`, `settle()`, `releaseCarry()` → `{ i, x, y } | null`, `swallowClicks(ms)`, `exportPng()` → `Promise<Blob>`.
- Under `window.__testHooks` only: `window.Drawing.__show(scene)` (paint a scene WITHOUT marking it dirty — no PUT) and `window.Drawing.__lift(i)`.
- `window.DrawingBackdrops` = the backdrops.js namespace (module shim).

### Test ports (unchanged from v1)

`tests/drawings.test.mjs` hub **8477** + fake Resend **8479**; `tests/drawing-ui.test.mjs` hub **8478**. Re-run `ss -ltn | grep -E ':(8477|8478|8479)\b'` before the first run (must print nothing).

---
## How to run things

- Every suite runs from the worktree root: `cd /home/claude/new-era/era-hub--wt-drawing-modes && node --test tests/<name>.test.mjs`. `drawings`, `drawing-scene`, `drawing-ui`, `drive-mirror` need no running hub.
- A single subtest: `node --test --test-name-pattern="<part of the name>" tests/<name>.test.mjs`. Expected summary lines: `# pass N` and `# fail 0`.
- `invariants.test.mjs` / `icons.test.mjs` assume the shared hub on :8377 — the LIVE family hub serving MASTER. Never test against it. Use v1 plan "How to run things" recipe with this worktree's path (a scratch hub on 8380–8389 with `ERA_DATA_DIR` in your session scratchpad, `INVARIANTS_BASE=http://127.0.0.1:$P`), and start it so you can stop it by ITS pid only:

```bash
cd /home/claude/new-era/era-hub--wt-drawing-modes
P=8383; ss -ltn | grep -q ":$P " && echo "PORT $P BUSY — pick another in 8380-8389"
D=$(mktemp -d "$SCRATCH/hub-XXXX")          # SCRATCH = your session's scratchpad directory
ERA_DATA_DIR=$D ERA_BIND=127.0.0.1 ERA_DEVICE_ID=wt ERA_NO_UPDATE=1 ERA_AI_URL=http://127.0.0.1:1 \
  ERA_ELEVEN_URL=http://127.0.0.1:1 ERA_RESEND_URL=http://127.0.0.1:1 ERA_WEATHER_URL=http://127.0.0.1:1 \
  ERA_GEO_URL=http://127.0.0.1:1/geo ERA_GEOCODE_URL=http://127.0.0.1:1/geocode ERA_FAL_URL=http://127.0.0.1:1 \
  ERA_TMDB_URL=http://127.0.0.1:1 ERA_STREAMING_URL=http://127.0.0.1:1 \
  nohup node server.js $P > $D/server.log 2>&1 < /dev/null & echo $! > $D/hub.pid
# … run the audit …
ps -p "$(cat $D/hub.pid)" -o args= && kill "$(cat $D/hub.pid)"     # that one pid, nothing else
```
  Never `pkill`, never kill by session or process group (a PreToolUse hook blocks it; `/home/claude/.claude/CLAUDE.md`).

---
### Task 1: The tables — modes, crayons, places in `stickers.json`; the mode glyphs vendored; horizon-relative slots

**Files:**
- Modify: `public/drawing/stickers.json` (insert the Definitions block after `"lapOffset": 0.04,`)
- Modify: `tools/drawing-fetch-stickers.mjs` (the `files` list)
- Create (by running the tool): `public/drawing/stickers/mode-draw.png`, `mode-people.png`, `mode-places.png`
- Modify: `public/drawing/scene.js` (`landing`, new `slotY`)
- Test: `tests/drawings.test.mjs` (§6 section), `tests/drawing-scene.test.mjs`

**Interfaces:**
- Consumes: v1's `stickers.json`, `scene.js`.
- Produces: `TABLE.modes[] {id, word, seat, src, source, sha256}`, `TABLE.crayons[] {id, word, hex, at}`, `TABLE.crayonDefault`, `TABLE.backdrops[] {id, word, at}`; `export function slotY(zone, slot, w, h, ref) → number`; `landing(id, items, table, rand = Math.random, horizon) → {x, y, w, c?, seed?} | null` (`horizon` omitted = `table.horizon`).

- [ ] **Step 1: Write the failing tests.** In `tests/drawings.test.mjs` add `import crypto from "node:crypto";` to the imports, and after the test "zones: 0-1 slots, …" add:

```js
// ---- v2 (spec 2026-10-02 §1-§5): the mode row, the crayons, the places --------------
const SEAT_KEYS = ["1,1", "2,1", "3,1", "4,1", "1,3", "2,3", "3,3", "4,3"];
test("v2 tables: four modes in their row-5 seats, eight crayons and eight places in fixed seats, no partner red", () => {
  assert.deepEqual(TABLE.modes.map(m => [m.id, m.word, m.seat]),
    [["draw", "Draw", 1], ["people", "People", 2], ["stickers", "Stickers", 4], ["places", "Places", 5]]);
  assert.deepEqual(TABLE.crayons.map(c => c.at.join(",")), SEAT_KEYS);
  assert.deepEqual(TABLE.crayons.map(c => [c.word, c.hex]), [["Black", "#1b1b1b"], ["Blue", "#0F7C8A"], ["Green", "#2E7D5B"],
    ["Yellow", "#B7822B"], ["Red-orange", "#DE7B52"], ["Purple", "#6a4fb3"], ["Pink", "#d96fa6"], ["White", "#f7f7f7"]]);
  assert.equal(TABLE.crayonDefault, "#0F7C8A", "Blue first");
  assert.ok(!TABLE.crayons.some(c => c.hex.toLowerCase() === "#b23a48"), "partner red is never a crayon");
  assert.deepEqual(TABLE.backdrops.map(b => [b.id, b.word]), [["meadow", "Meadow"], ["beach", "Beach"], ["night", "Night"],
    ["snow", "Snow"], ["sunset", "Sunset"], ["forest", "Forest"], ["city", "City"], ["rainbow", "Rainbow"]]);
  assert.deepEqual(TABLE.backdrops.map(b => b.at.join(",")), SEAT_KEYS);
  assert.deepEqual(TABLE.stickers.map(s => s.at.join(",")), SEAT_KEYS, "the stickers already sit in the same seats");
  assert.equal(TABLE.horizon, 0.58, "the slot tables are written against the meadow's horizon");
});

test("every mode glyph is vendored and pinned like the stickers; Stickers reuses the star", () => {
  execFileSync(process.execPath, [path.join(HUB, "tools", "drawing-fetch-stickers.mjs"), "--check"], { stdio: "pipe" });
  for (const m of TABLE.modes) {
    const b = fs.readFileSync(path.join(DRAW, m.src));
    assert.equal(b.readUInt32BE(0), 0x89504e47, m.id + " is a PNG");
    assert.ok(b.readUInt32BE(16) >= 256 && b.readUInt32BE(20) >= 256, m.id + " is at least 256 px");
    assert.match(m.source, /^https:\/\/raw\.githubusercontent\.com\/microsoft\/fluentui-emoji\/[0-9a-f]{40}\/assets\//);
    assert.equal(crypto.createHash("sha256").update(b).digest("hex"), m.sha256, m.id + " matches its pin");
  }
  assert.equal(TABLE.modes.find(m => m.id === "stickers").src, TABLE.stickers.find(s => s.id === "star").src);
});
```

In `tests/drawing-scene.test.mjs` change the import line to also import `slotY`:

```js
import { ASPECT, MEADOW, SPLAT_COLOURS, clampItem, landing, slotY, splatPath, describe, meadowCss, sceneOps }
  from "../public/drawing/scene.js";
```

and append:

```js
// ---- v2 (spec 2026-10-02 §5): slots move with the place's horizon -------------------
test("slots are horizon-relative: the meadow's horizon keeps v1's landings, a higher horizon moves both bands", () => {
  assert.deepEqual(landing("horse", [], T, Math.random, 0.58), { x: 0.5, y: 0.82, w: 0.2 }, "v1 exactly");
  assert.deepEqual(landing("sun", [], T, Math.random, 0.58), { x: 0.5, y: 0.17, w: 0.16 }, "v1 exactly");
  near(landing("horse", [], T, Math.random, 0.72).y, 0.8467, "ground base keeps its share of [h,1]");   // 0.72 + 0.34*0.28/0.42 - 0.1
  near(landing("sun", [], T, Math.random, 0.72).y, 0.211, "sky y keeps its share of [0,h]");          // 0.17 * 0.72 / 0.58
  for (const h of [0.58, 0.6, 0.62, 0.64, 0.66, 0.7, 0.72]) {
    for (const s of T.zones.ground.slots) { const y = slotY("ground", s, 0, h, T.horizon); assert.ok(y > h && y <= 1, `${h} ground ${y}`); }
    for (const s of T.zones.sky.slots) { const y = slotY("sky", s, 0, h, T.horizon); assert.ok(y > 0 && y < h, `${h} sky ${y}`); }
  }
  assert.equal(slotY("any", { x: 0.3, y: 0.85 }, 0.15, 0.72, 0.58), 0.85, "a splat goes anywhere, whatever the place");
  const items = [];
  for (let k = 0; k < 8; k++) { const at = landing("tree", items, T, Math.random, 0.72); items.push({ s: "tree", ...at, by: "ellie" }); }
  near(items[7].x, 0.54, "the lap offset still applies after the mapping");
});
```

- [ ] **Step 2: Run them — they fail**

Run: `node --test tests/drawings.test.mjs tests/drawing-scene.test.mjs`
Expected: `drawing-scene` fails to load (`does not provide an export named 'slotY'`); `drawings` fails "v2 tables" (`Cannot read properties of undefined (reading 'map')`) and "every mode glyph" (`TABLE.modes` undefined).

- [ ] **Step 3: Write the tables.** Insert the `stickers.json` block from Definitions verbatim after `"lapOffset": 0.04,`.

- [ ] **Step 4: Teach the fetch tool the modes.** In `tools/drawing-fetch-stickers.mjs` replace the `files` array with:

```js
// A mode glyph that is also a sticker (Stickers = the star) is one file with one pin: fetched once.
const stickerDests = new Set(table.stickers.filter(s => s.src).map(s => s.src));
const files = [
  ...table.stickers.filter(s => s.src).map(s => ({ what: s.id, url: s.source, pin: s.sha256, dest: s.src, png: true })),
  ...(table.modes || []).filter(m => !stickerDests.has(m.src))
    .map(m => ({ what: "mode " + m.id, url: m.source, pin: m.sha256, dest: m.src, png: true })),
  { what: "LICENSE", url: table.source.licenseUrl, pin: table.source.licenseSha256, dest: table.source.licenseFile, png: false },
];
```
and add to the header comment: `// v2 (spec 2026-10-02 §1): also the mode glyphs (modes[] — Pencil, People hugging, National park).`

Run (network): `node tools/drawing-fetch-stickers.mjs` → prints `wrote stickers/…` for the seven stickers, the three `mode-*.png` and `LICENSE`, exit 0. Then `node tools/drawing-fetch-stickers.mjs --check` → eleven `ok` lines, exit 0. `git status` must show exactly the three new `mode-*.png` (the others are byte-identical).

- [ ] **Step 5: Horizon-relative landing.** In `public/drawing/scene.js` replace `export function landing(…) { … }` with:

```js
// Horizon-relative slots (spec 2026-10-02 §5): stickers.json's slot numbers are written against the
// reference horizon table.horizon (0.58, the meadow). A place with another horizon h carries them:
// a ground base keeps its share of the ground band [h,1], a sky y its share of the sky band [0,h], a
// splat ("any") goes anywhere. At h = ref this is v1 exactly.
export function slotY(zone, slot, w, h, ref) {
  if (zone === "ground") return h + (slot.base - ref) * (1 - h) / (1 - ref) - w / 2;
  if (zone === "sky") return slot.y * h / ref;
  return slot.y;
}

// "Pick and it lands" (spec 2026-09-30 §2.1). Sky/ground: the n-th sticker of a zone takes slot n % 7,
// one lap later everything shifts +lapOffset in x and y. Any (the splat): a random slot.
// horizon: the current place's (backdrops.js horizonOf); omitted = the reference horizon.
export function landing(id, items, table, rand = Math.random, horizon) {
  const st = stickerById(table, id);
  if (!st || !table.zones || !table.zones[st.zone]) return null;
  const slots = table.zones[st.zone].slots;
  if (st.zone === "any") {
    const slot = slots[Math.min(slots.length - 1, Math.floor(rand() * slots.length))];
    const [lo, hi] = Array.isArray(st.scale) ? st.scale : [st.scale, st.scale];
    const w = round(lo + rand() * (hi - lo), 3);
    const c = SPLAT_COLOURS[Math.min(SPLAT_COLOURS.length - 1, Math.floor(rand() * SPLAT_COLOURS.length))];
    const seed = Math.floor(rand() * 2147483647);
    return { ...clampItem({ x: slot.x, y: slot.y, w }), w, c, seed };
  }
  const ref = table.horizon || 0.58;
  const h = Number.isFinite(horizon) ? horizon : ref;
  const n = items.filter((it) => { const s = stickerById(table, it.s); return s && s.zone === st.zone; }).length;
  const slot = slots[n % slots.length];
  const off = Math.floor(n / slots.length) * (table.lapOffset || 0);
  const w = st.scale;
  return { ...clampItem({ x: slot.x + off, y: slotY(st.zone, slot, w, h, ref) + off, w }), w };
}
```

- [ ] **Step 6: Run them — they pass**

Run: `node --test tests/drawings.test.mjs tests/drawing-scene.test.mjs`
Expected: `# pass 38` (`drawings` 28, `drawing-scene` 10), `# fail 0`. Then `node --test tests/drawing-ui.test.mjs` → `# pass 33`, `# fail 0` (nothing visible changed).

- [ ] **Step 7: Commit**

```bash
git add public/drawing/stickers.json tools/drawing-fetch-stickers.mjs public/drawing/stickers/mode-draw.png \
  public/drawing/stickers/mode-people.png public/drawing/stickers/mode-places.png public/drawing/scene.js \
  tests/drawings.test.mjs tests/drawing-scene.test.mjs
git commit -m "drawing: the v2 tables — four mode glyphs (Fluent, pinned), eight crayons, eight places in fixed seats, and slots that move with a place's horizon (spec 2026-10-02 §1, §3, §5)"
```

---

### Task 2: `backdrops.js` — eight places as shared geometry; `renderScene` draws the place (DOM, thumbnails, PNG)

**Files:**
- Create: `public/drawing/backdrops.js`
- Modify: `public/drawing/scene.js` (import backdrops; `renderScene` paints `scene.backdrop`; `MEADOW` and `meadowCss` removed)
- Modify: `public/drawing/index.html` (shim: `window.DrawingBackdrops`)
- Modify: `public/drawing/drawing.css` (`.scene .backdrop`)
- Modify: `public/drawing/drawing.js` (`window.Drawing.exportPng`)
- Test: `tests/drawing-scene.test.mjs`, `tests/drawing-ui.test.mjs`

**Interfaces:**
- Consumes: T1's `stickers.json` `backdrops[]` ids.
- Produces (backdrops.js): `VIEW = [1600, 900]`; `BACKDROPS: {id, horizon, shapes}[]`; `backdropById(id)` (unknown → meadow); `horizonOf(id) → number`; `backdropMarkup(id) → string` (inner SVG markup, gradient ids unique per call); `backdropSvg(id) → SVGSVGElement` (`class="backdrop"`, `data-backdrop=<id>`, viewBox `0 0 1600 900`, `preserveAspectRatio="none"`); `paintBackdrop(ctx, id, W, H)`. scene.js re-exports `horizonOf`. `window.Drawing.exportPng() → Promise<Blob>` (the current scene, 1600×900). Shape vocabulary: `{k:"band", y0, y1, stops}` · `{k:"circle", cx, cy, r, fill}` · `{k:"path", d, fill}` · `{k:"line", d, stroke, width}` (absolute M/L/Q/A/Z only).
- Test helper (top of `drawing-scene.test.mjs`, used by T3 too): `fakeCtx(calls)`.

- [ ] **Step 1: Write the failing tests.** In `tests/drawing-scene.test.mjs`: change the scene import to drop `MEADOW` and `meadowCss`, add the backdrops import, add `fakeCtx`, and REPLACE the v1 test "the meadow: sky over grass…" with the four tests below.

```js
import { ASPECT, SPLAT_COLOURS, clampItem, landing, slotY, splatPath, describe, sceneOps, renderScene }
  from "../public/drawing/scene.js";
import { BACKDROPS, backdropById, horizonOf, backdropMarkup, paintBackdrop } from "../public/drawing/backdrops.js";

// A canvas that records what it was asked to draw (node has no canvas). Path2D is the browser's; a
// stand-in that keeps its path string is all the painters need.
globalThis.Path2D ??= class { constructor(d) { this.d = d; } };
function fakeCtx(calls, W = 1600, H = 900) {
  return { canvas: { width: W, height: H }, fillStyle: null, strokeStyle: null, lineWidth: 1, lineCap: "butt", lineJoin: "miter",
    save() {}, restore() {}, translate() {}, beginPath() {},
    scale(sx, sy) { calls.push(["scale", sx, sy]); },
    createLinearGradient(x0, y0, x1, y1) { const g = { stops: [] }; g.addColorStop = (at, c) => g.stops.push([at, c]); return g; },
    fillRect(x, y, w, h) { calls.push(["band", y, y + h, JSON.stringify(this.fillStyle.stops)]); },
    arc(cx, cy, r) { this._arc = [cx, cy, r]; },
    fill(p) { calls.push(p ? ["path", p.d, this.fillStyle] : ["circle", ...this._arc, this.fillStyle]); },
    stroke(p) { calls.push(["line", p.d, this.strokeStyle, this.lineWidth, this.lineCap]); },
    drawImage(im, x, y, w, h) { calls.push(["img", x, y, w, h]); } };
}

// ---- v2 (spec 2026-10-02 §5): the eight places --------------------------------------
test("eight places with stickers.json's ids, each horizon where its ground band starts; unknown is the meadow", () => {
  assert.deepEqual(BACKDROPS.map(b => b.id), T.backdrops.map(b => b.id));
  for (const b of BACKDROPS) {
    const ground = b.shapes.filter(s => s.k === "band").at(-1);
    assert.equal(ground.y1, 900, b.id + ": the ground band reaches the bottom");
    near(ground.y0 / 900, b.horizon, b.id + ": horizon");
  }
  assert.equal(backdropById("volcano").id, "meadow");
  assert.equal(horizonOf("city"), 0.72);
  assert.equal(horizonOf(undefined), 0.58);
});

test("no red in any place: every colour is calm (no saturated hue within 15 degrees of red), never partner red", () => {
  const hues = [];
  for (const b of BACKDROPS) for (const s of b.shapes)
    for (const c of [s.fill, s.stroke, ...(s.stops || []).map(([, c]) => c)].filter(Boolean)) hues.push([b.id, c]);
  for (const [id, c] of hues) {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl), d = mx - mn, l = (mx + mn) / 2;
    const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let hue = d === 0 ? 0 : mx === r ? 60 * (((g - bl) / d) % 6) : mx === g ? 60 * ((bl - r) / d + 2) : 60 * ((r - g) / d + 4);
    if (hue < 0) hue += 360;
    assert.ok(!(sat > 0.4 && (hue >= 345 || hue < 15)), `${id} ${c}: hue ${hue.toFixed(0)}`);
    assert.notEqual(c.toLowerCase(), "#b23a48");
  }
});

test("one geometry: the SVG markup and the canvas paint the same shapes with the same numbers", () => {
  for (const b of BACKDROPS) {
    const m = backdropMarkup(b.id);
    const grads = [...m.matchAll(/<linearGradient[^>]*>(.*?)<\/linearGradient>/g)]
      .map(([, inner]) => JSON.stringify([...inner.matchAll(/offset="([^"]+)" stop-color="([^"]+)"/g)].map(([, at, c]) => [+at, c])));
    let gi = 0;
    const fromSvg = [...m.matchAll(/<(rect|circle|path)([^>]*)\/>/g)].map(([, tag, a]) => {
      const at = (n) => (new RegExp(` ${n}="([^"]*)"`).exec(a) || [])[1];
      if (tag === "rect") return ["band", +at("y"), +at("y") + +at("height"), grads[gi++]];
      if (tag === "circle") return ["circle", +at("cx"), +at("cy"), +at("r"), at("fill")];
      return at("fill") === "none" ? ["line", at("d"), at("stroke"), +at("stroke-width"), "butt"] : ["path", at("d"), at("fill")];
    });
    const calls = [];
    paintBackdrop(fakeCtx(calls), b.id, 800, 450);
    assert.deepEqual(calls[0], ["scale", 0.5, 0.5], b.id + ": the canvas paints in 1600x900 units");
    assert.deepEqual(calls.slice(1), fromSvg, b.id);
    assert.equal(fromSvg.length, b.shapes.length, b.id + ": every shape drawn once");
  }
  const a = backdropMarkup("meadow"), z = backdropMarkup("meadow");
  assert.notEqual(a.match(/id="([^"]+)"/)[1], z.match(/id="([^"]+)"/)[1], "gradient ids never repeat in one page");
});

test("the PNG paints the picture's place first, then the items over it", () => {
  const calls = [];
  renderScene(fakeCtx(calls), { v: 1, backdrop: "city", items: [{ s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" }] },
    { table: T, images: { horse: { complete: true, naturalWidth: 256, naturalHeight: 256 } } });
  assert.deepEqual(calls[0], ["scale", 1, 1]);
  assert.equal(calls.filter(c => c[0] === "band").length, BACKDROPS.find(b => b.id === "city").shapes.filter(s => s.k === "band").length);
  assert.equal(calls.at(-1)[0], "img", "the horse is painted last");
});
```

In `tests/drawing-ui.test.mjs`: give `seed` an `extra` argument —

```js
function seed(id, items, when, extra = {}) {
  fs.mkdirSync(path.join(PICS, id), { recursive: true });
  fs.writeFileSync(path.join(PICS, id, "scene.json"), JSON.stringify(
    { v: 1, id, created: when, updated: when, device: "test-dev", backdrop: "meadow", items, mailedHash: null, ...extra }));
}
```
— in the test "the Splat tile and a splat in her picture …" replace `box.firstElementChild.cloneNode(true)` with `box.querySelector(".item").cloneNode(true)`; in "a shelf cell is her picture …" replace `bg: th.style.background,` with `bd: th.querySelector("svg.backdrop") && th.querySelector("svg.backdrop").dataset.backdrop,` and `assert.match(t.bg, /linear-gradient/);` with `assert.equal(t.bd, "meadow", "the thumbnail draws its place");` — and append:

```js
// ================================================================ v2 T2 — the place is part of the picture
const close = (got, want, tol = 14) => got.every((v, k) => Math.abs(v - want[k]) <= tol);
test("the ring draws the picture's place, and the exported PNG paints the same place", async () => {
  const id = "2026-10-02-090000-test-dev";
  seed(id, [H()], "2026-10-02T09:00:00Z", { backdrop: "beach" });
  const { ctx, page, errors } = await openRing({ id });
  assert.equal(await page.locator('#scene svg.backdrop[data-backdrop="beach"]').count(), 1);
  const px = await page.evaluate(async () => {
    const bmp = await createImageBitmap(await window.Drawing.exportPng());
    const c = document.createElement("canvas"); c.width = 1600; c.height = 900;
    const g = c.getContext("2d"); g.drawImage(bmp, 0, 0);
    const at = (x, y) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
    return { size: [bmp.width, bmp.height], sky: at(40, 40), sea: at(40, 520), sand: at(40, 880) };
  });
  assert.deepEqual(px.size, [1600, 900]);
  assert.ok(close(px.sky, [164, 218, 241]), "beach sky " + px.sky);
  assert.ok(close(px.sea, [103, 181, 210]), "beach sea " + px.sea);
  assert.ok(close(px.sand, [227, 198, 139]), "beach sand " + px.sand);
  assert.deepEqual(errors, []);
  await ctx.close();
});
```

- [ ] **Step 2: Run them — they fail**

Run: `node --test tests/drawing-scene.test.mjs` → fails to load (`Cannot find module …/backdrops.js`). `node --test --test-name-pattern="place" tests/drawing-ui.test.mjs` → fails (`backdrop` count 0 / `exportPng is not a function`).

- [ ] **Step 3: Create `public/drawing/backdrops.js`:**

```js
// backdrops.js — Drawing's eight places (spec 2026-10-02 §5). Procedural: no assets, no licences.
// Each place is DATA — { id, horizon, shapes } in 1600x900 units — and two painters read the SAME
// shapes: backdropMarkup()/backdropSvg() for the ring and every thumbnail, paintBackdrop() for the
// mailed PNG. So what she sees and what her family receives cannot drift apart. horizon = where the
// ground band starts (0-1 of the height): scene.js's slotY moves the sticker slots with it.
// Words and seats live in stickers.json (backdrops[]), which the hub validates against.
// Calm palette, never red (palette law): the reddest colour here is the vowel orange #DE7B52.
export const VIEW = [1600, 900];
const SKY = [[0, "#BFE3F2"], [1, "#E4F3F7"]];
const GRASS = [[0, "#A9D69A"], [1, "#78BD6E"]];
const star = (cx, cy, r) => ({ k: "circle", cx, cy, r, fill: "#FFF6D5" });
const arc = (r, stroke) => ({ k: "line", d: `M${800 - r} 522 A${r} ${r} 0 0 1 ${800 + r} 522`, stroke, width: 36 });

export const BACKDROPS = [
  { id: "meadow", horizon: 0.58, shapes: [
    { k: "band", y0: 0, y1: 522, stops: SKY },
    { k: "band", y0: 522, y1: 900, stops: GRASS } ] },
  { id: "beach", horizon: 0.66, shapes: [
    { k: "band", y0: 0, y1: 432, stops: [[0, "#9ED8F0"], [1, "#DDF2FA"]] },
    { k: "circle", cx: 1330, cy: 150, r: 70, fill: "#F6CF5C" },
    { k: "band", y0: 432, y1: 594, stops: [[0, "#4FA3C7"], [1, "#7CC4DC"]] },
    { k: "band", y0: 594, y1: 900, stops: [[0, "#F1DDAE"], [1, "#E2C489"]] } ] },
  { id: "night", horizon: 0.62, shapes: [
    { k: "band", y0: 0, y1: 558, stops: [[0, "#14213D"], [1, "#2C3E66"]] },
    { k: "circle", cx: 1250, cy: 170, r: 70, fill: "#F2EBC9" },
    star(220, 120, 6), star(430, 260, 5), star(640, 90, 6), star(860, 220, 5), star(1040, 80, 6), star(1460, 330, 5),
    { k: "band", y0: 558, y1: 900, stops: [[0, "#2F4A3A"], [1, "#1F3328"]] } ] },
  { id: "snow", horizon: 0.60, shapes: [
    { k: "band", y0: 0, y1: 540, stops: [[0, "#CFE3EE"], [1, "#EEF5F8"]] },
    { k: "path", d: "M0 540 Q400 430 800 540 Q1200 450 1600 540 L1600 560 L0 560 Z", fill: "#F4F8FA" },
    { k: "band", y0: 540, y1: 900, stops: [[0, "#FFFFFF"], [1, "#E3ECF1"]] } ] },
  { id: "sunset", horizon: 0.64, shapes: [
    { k: "band", y0: 0, y1: 576, stops: [[0, "#5B5B9E"], [0.6, "#E9A3C9"], [1, "#F6B66B"]] },
    { k: "circle", cx: 800, cy: 576, r: 110, fill: "#F7C266" },
    { k: "band", y0: 576, y1: 900, stops: [[0, "#4C6B46"], [1, "#2F4A2E"]] } ] },
  { id: "forest", horizon: 0.70, shapes: [
    { k: "band", y0: 0, y1: 630, stops: [[0, "#B9E0F0"], [1, "#E6F4F8"]] },
    { k: "path", d: "M0 630 L90 400 L180 630 Z M150 630 L260 360 L370 630 Z M330 630 L430 420 L530 630 Z " +
                    "M1070 630 L1170 410 L1270 630 Z M1230 630 L1340 350 L1450 630 Z M1410 630 L1510 420 L1600 600 L1600 630 Z",
      fill: "#2E7D5B" },
    { k: "band", y0: 630, y1: 900, stops: [[0, "#7DBB6A"], [1, "#4F8F45"]] } ] },
  { id: "city", horizon: 0.72, shapes: [
    { k: "band", y0: 0, y1: 648, stops: [[0, "#BFD7EA"], [1, "#E8F0F6"]] },
    { k: "path", d: "M60 648 L60 380 L220 380 L220 648 Z M260 648 L260 300 L400 300 L400 648 Z " +
                    "M1180 648 L1180 340 L1320 340 L1320 648 Z M1360 648 L1360 420 L1540 420 L1540 648 Z", fill: "#8A9BA8" },
    { k: "path", d: "M150 648 L150 470 L300 470 L300 648 Z M1260 648 L1260 480 L1420 480 L1420 648 Z", fill: "#6E8291" },
    { k: "band", y0: 648, y1: 900, stops: [[0, "#B9BEC2"], [1, "#9EA4A8"]] } ] },
  { id: "rainbow", horizon: 0.58, shapes: [
    { k: "band", y0: 0, y1: 522, stops: SKY },
    arc(420, "#DE7B52"), arc(385, "#F2A65A"), arc(350, "#E8C547"), arc(315, "#2E7D5B"), arc(280, "#0F7C8A"), arc(245, "#6A4FB3"),
    { k: "band", y0: 522, y1: 900, stops: GRASS } ] },
];

export const backdropById = (id) => BACKDROPS.find((b) => b.id === id) || BACKDROPS[0];
export const horizonOf = (id) => backdropById(id).horizon;

// Gradient ids must be unique in the document: the ring and every shelf thumbnail draw a place.
let UID = 0;
export function backdropMarkup(id) {
  const b = backdropById(id), u = "bd" + (++UID);
  let defs = "", body = "";
  b.shapes.forEach((s, k) => {
    if (s.k === "band") {
      defs += `<linearGradient id="${u}-${k}" x1="0" y1="0" x2="0" y2="1">` +
        s.stops.map(([at, c]) => `<stop offset="${at}" stop-color="${c}"/>`).join("") + "</linearGradient>";
      body += `<rect x="0" y="${s.y0}" width="1600" height="${s.y1 - s.y0}" fill="url(#${u}-${k})"/>`;
    } else if (s.k === "circle") body += `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${s.fill}"/>`;
    else if (s.k === "path") body += `<path d="${s.d}" fill="${s.fill}"/>`;
    else if (s.k === "line") body += `<path d="${s.d}" fill="none" stroke="${s.stroke}" stroke-width="${s.width}"/>`;
  });
  return `<defs>${defs}</defs>${body}`;
}
export function backdropSvg(id) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 1600 900");
  el.setAttribute("preserveAspectRatio", "none");
  el.setAttribute("class", "backdrop");
  el.setAttribute("data-backdrop", backdropById(id).id);
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = backdropMarkup(id);
  return el;
}
export function paintBackdrop(ctx, id, W, H) {
  const b = backdropById(id);
  ctx.save();
  ctx.scale(W / 1600, H / 900);
  for (const s of b.shapes) {
    if (s.k === "band") {
      const g = ctx.createLinearGradient(0, s.y0, 0, s.y1);
      for (const [at, c] of s.stops) g.addColorStop(at, c);
      ctx.fillStyle = g;
      ctx.fillRect(0, s.y0, 1600, s.y1 - s.y0);
    } else if (s.k === "circle") {
      ctx.beginPath(); ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2); ctx.fillStyle = s.fill; ctx.fill();
    } else if (s.k === "path") {
      ctx.fillStyle = s.fill; ctx.fill(new Path2D(s.d));
    } else if (s.k === "line") {
      ctx.strokeStyle = s.stroke; ctx.lineWidth = s.width; ctx.lineCap = "butt"; ctx.stroke(new Path2D(s.d));
    }
  }
  ctx.restore();
}
```

- [ ] **Step 4: `renderScene` draws the place.** In `public/drawing/scene.js`: delete `MEADOW` and `meadowCss` (and the comment line above `MEADOW`), add at the top after the header comment

```js
import { backdropSvg, paintBackdrop } from "./backdrops.js";
export { horizonOf } from "./backdrops.js";
```

In `renderScene`, in the canvas branch replace the five lines from `const g = target.createLinearGradient` through `target.fillRect(0, 0, W, H);` with `paintBackdrop(target, (scene && scene.backdrop) || "meadow", W, H);`; in the DOM branch replace `target.style.background = meadowCss();` with `target.style.background = "";` and the final `target.replaceChildren(...kids);` with `target.replaceChildren(backdropSvg((scene && scene.backdrop) || "meadow"), ...kids);`.

In `public/drawing/drawing.css` after `.scene{…}` add:

```css
.scene .backdrop{position:absolute; inset:0; width:100%; height:100%; display:block; pointer-events:none}
```

In `public/drawing/index.html` (module shim) add `import * as DrawingBackdrops from "./backdrops.js";` and `window.DrawingBackdrops = DrawingBackdrops;`. In `public/drawing/drawing.js` add to `window.Drawing`: `exportPng: () => exportPng(S.scene),`.

- [ ] **Step 5: Run them — they pass**

Run: `node --test tests/drawing-scene.test.mjs` → `# pass 13`, `# fail 0`. `node --test tests/drawing-ui.test.mjs` → `# pass 34`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add public/drawing/backdrops.js public/drawing/scene.js public/drawing/index.html public/drawing/drawing.css \
  public/drawing/drawing.js tests/drawing-scene.test.mjs tests/drawing-ui.test.mjs
git commit -m "drawing: eight places as one shared geometry — the ring, every thumbnail and the mailed PNG paint the picture's backdrop from the same shapes (spec 2026-10-02 §5)"
```

---
### Task 3: `scene.js` — strokes, people and the v2 celebration sentence (still ONE renderer)

**Files:**
- Modify: `public/drawing/scene.js`
- Modify: `public/drawing/drawing.css` (strokes are never pointer targets; images keep their shape)
- Test: `tests/drawing-scene.test.mjs`

**Interfaces:**
- Consumes: T2's `fakeCtx`, `paintBackdrop`.
- Produces: `PEN = { alpha: 0.35, minStep: 0.006, maxPts: 400, width: 0.014, byteSoft: 245760, ptBytes: 14 }`; `penStart(x, y, room = 400) → pen {sx, sy, room, pts}`; `penMove(pen, x, y) → boolean` (true = a point was appended; mutates `pen`); `penEnd(pen, landing | null) → pts` (a copy, landing appended when distinct and there is room); `penRoom(jsonLength) → number`; `strokePath(pts) → "M… L…"` in 1600×900 units, 1 decimal; `strokeSvg(d, colour, w) → SVGSVGElement`; `withPeople(table, people[]) → table` (adds `table.people[]` entries `{ id: "person:<slug>", word, plural, zone: "ground", scale, src: "/characters/<slug>.png", person: true }`); `stickerById` also finds people; `itemWord(table, s) → string` (`""` when unknown); `sceneOps` emits `{ kind: "stroke", d, stroke, lineWidth, left: 0, top: 0, width: 1, height: 1 }` for strokes and skips unknown ids; `renderScene` draws strokes (DOM: `svg.item.stroke`; canvas: `stroke(new Path2D(d))` scaled to 1600×900) and draws images contain-fit, bottom-aligned; `describe` per deviation 15.

- [ ] **Step 1: Write the failing tests.** Extend the scene import in `tests/drawing-scene.test.mjs` with `PEN, penStart, penMove, penEnd, penRoom, strokePath, withPeople, itemWord, stickerById` and append:

```js
// ---- v2 (spec 2026-10-02 §3): the pen ------------------------------------------------
test("the pen: smoothing is deterministic, a point every 0.6% of the width, 3 decimals, never past its room", () => {
  const pen = penStart(0.2, 0.5);
  assert.deepEqual([pen.pts, pen.room], [[[0.2, 0.5]], 400]);
  assert.equal(penMove(pen, 0.3, 0.5), true, "a jump is smoothed, not copied");
  assert.deepEqual(pen.pts[1], [0.235, 0.5]);                       // 0.2 + 0.35 * 0.1
  const still = penStart(0.5, 0.5);
  assert.equal(penMove(still, 0.505, 0.5), false, "a wobble under the step adds nothing");
  const run = () => { const p = penStart(0.1, 0.1); for (let k = 1; k <= 60; k++) penMove(p, 0.1 + k * 0.01, 0.1 + (k % 5) * 0.03); return p.pts; };
  const a = run();
  assert.deepEqual(a, run(), "the same gaze gives the same line");
  for (let k = 0; k < a.length; k++) {
    for (const v of a[k]) { assert.equal(v, Math.round(v * 1000) / 1000); assert.ok(v >= 0 && v <= 1); }
    if (k) assert.ok(Math.hypot(a[k][0] - a[k - 1][0], (a[k][1] - a[k - 1][1]) / ASPECT) >= PEN.minStep - 0.001, "spaced " + k);
  }
  const full = penStart(0, 0, 3);
  for (let k = 1; k < 100; k++) penMove(full, k / 100, 0);
  assert.equal(full.pts.length, 3, "never past its room");
  assert.equal(penStart(0, 0, 9999).room, 400, "never past 400");
});

test("penEnd lands on the dwell dot; penRoom keeps a scene under the soft cap", () => {
  const p = penStart(0.1, 0.1);
  penMove(p, 0.5, 0.1);
  assert.deepEqual(penEnd(p, { x: 0.6, y: 0.4 }).at(-1), [0.6, 0.4]);
  assert.equal(p.pts.length, 2, "penEnd does not touch the live pen");
  assert.deepEqual(penEnd(penStart(0.1, 0.1), null), [[0.1, 0.1]], "a dwell without movement is one point (the page drops it)");
  assert.deepEqual(penEnd(penStart(0.1, 0.1), { x: 0.1, y: 0.1 }), [[0.1, 0.1]], "a landing on the start adds nothing");
  assert.equal(penRoom(1000), 400);
  assert.equal(penRoom(PEN.byteSoft - 96 - 14 * 10), 10);
  assert.ok(penRoom(PEN.byteSoft) < 2, "a full picture has no room for a stroke");
});

test("a stroke is one path in 1600x900 units — the same string for the ring and the PNG", () => {
  assert.equal(strokePath([[0, 0], [0.5, 0.5], [1, 1]]), "M0 0L800 450L1600 900");
  assert.equal(strokePath([[0.123, 0.456], [0.2, 0.2]]), "M196.8 410.4L320 180");
  const S1 = { s: "stroke", c: "#d96fa6", w: 0.014, pts: [[0.1, 0.2], [0.3, 0.4]], by: "ellie" };
  const ops = sceneOps({ v: 1, backdrop: "meadow", items: [{ s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" }, S1, { ...S1, pts: [[0.1, 0.1]] }] }, T);
  assert.equal(ops.length, 2, "a one-point stroke is never drawn");
  const op = ops[1];
  assert.deepEqual([op.i, op.kind, op.d, op.stroke, op.left, op.top, op.width, op.height],
    [1, "stroke", strokePath(S1.pts), "#d96fa6", 0, 0, 1, 1]);
  near(op.lineWidth, 12.6, "1.4% of the height");
  const calls = [];
  renderScene(fakeCtx(calls), { v: 1, backdrop: "meadow", items: [S1] }, { table: T, images: {} });
  assert.deepEqual(calls.at(-1), ["line", strokePath(S1.pts), "#d96fa6", op.lineWidth, "round"]);
});

// ---- v2 (spec 2026-10-02 §4): people --------------------------------------------------
const PEOPLE = [{ slug: "maya", word: "Maya", scale: 0.3 }, { slug: "sam", word: "Sam", scale: 0.25 }];
test("people are ground stickers named by their word, scaled from the library, drawn from /characters/", () => {
  const TP = withPeople(T, PEOPLE);
  assert.equal(TP.stickers, T.stickers, "the sticker table is untouched");
  const m = stickerById(TP, "person:maya");
  assert.deepEqual([m.zone, m.scale, m.word, m.src, m.person], ["ground", 0.3, "Maya", "/characters/maya.png", true]);
  assert.deepEqual(landing("person:maya", [], TP), { x: 0.5, y: 0.77, w: 0.3 }, "the first ground slot, feet on the grass");
  const items = [{ s: "horse", ...landing("horse", [], TP), by: "ellie" }];
  assert.equal(landing("person:sam", items, TP).x, 0.35, "people and stickers share the ground slots");
  assert.deepEqual([itemWord(TP, "person:sam"), itemWord(TP, "horse"), itemWord(TP, "person:gone")], ["Sam", "Horse", ""]);
  const ops = sceneOps({ v: 1, items: [{ s: "person:maya", x: 0.5, y: 0.77, w: 0.3, by: "ellie" },
                                        { s: "person:gone", x: 0.5, y: 0.5, w: 0.3, by: "ellie" }] }, TP);
  assert.equal(ops.length, 1, "a person who left the library is drawn as nothing — never an error");
  assert.deepEqual([ops[0].kind, ops[0].src, ops[0].s], ["img", "/characters/maya.png", "person:maya"]);
});

test("the PNG draws a person into its box without stretching: contain, bottom on the box's bottom", () => {
  const calls = [];
  renderScene(fakeCtx(calls), { v: 1, backdrop: "meadow", items: [{ s: "person:maya", x: 0.5, y: 0.5, w: 0.4, by: "ellie" }] },
    { table: withPeople(T, PEOPLE), images: { "person:maya": { complete: true, naturalWidth: 64, naturalHeight: 128 } } });
  const [, x, y, w, h] = calls.find((c) => c[0] === "img");
  // the box: 0.4 x 900 = 360 px square centred at (800, 450); a 1:2 figure fills its height, 180 px wide
  for (const [got, want, what] of [[x, 710, "x"], [y, 270, "y"], [w, 180, "w"], [h, 360, "h"]]) near(got, want, what);
});

test("the celebration names people by their word, once each, and never counts strokes", () => {
  const TP = withPeople(T, PEOPLE);
  const I = (...ids) => ids.map((s) => ({ s }));
  assert.equal(describe(I("person:maya", "horse", "person:maya", "person:sam"), TP), "You made a picture with Maya, a horse and Sam!");
  assert.equal(describe(I("stroke", "stroke"), TP), "You made a picture!");
  assert.equal(describe(I("stroke", "star", "stroke", "star"), TP), "You made a picture with two stars!");
  assert.equal(describe(I("person:gone", "sun"), TP), "You made a picture with a sun!", "a vanished person is not named");
});
```

- [ ] **Step 2: Run them — they fail**

Run: `node --test tests/drawing-scene.test.mjs` → fails to load (`does not provide an export named 'PEN'`).

- [ ] **Step 3: Implement in `public/drawing/scene.js`.**

Replace `export const stickerById = …;` with:

```js
// A sticker from stickers.json, or a person from the library (withPeople): one lookup for both.
export const stickerById = (table, id) => (table && table.stickers || []).find((s) => s.id === id)
  || (table && table.people || []).find((p) => p.id === id) || null;
export const itemWord = (table, s) => { const st = stickerById(table, s); return st ? st.word : ""; };

// People (spec 2026-10-02 §4): her family, cut out, from the private library the hub serves at
// /characters/. A person is a ground sticker whose scale and word come from characters.json.
export function withPeople(table, people) {
  return { ...table, people: (people || []).map((p) => ({ id: "person:" + p.slug, word: p.word, plural: p.word,
    zone: "ground", scale: p.scale, src: "/characters/" + encodeURIComponent(p.slug) + ".png", person: true })) };
}

// The pen (spec 2026-10-02 §3, EyeDraw's look-look adapted): it follows her gaze through an
// exponential smoother and keeps a point every minStep scene WIDTHS (dy is in heights, so it counts
// 9/16). Points have 3 decimals — at most 14 bytes of JSON each ("[0.123,0.456],") — and byteSoft
// keeps a whole scene under the hub's 256 KB, so her ink can never make a save fail (deviation 11).
export const PEN = { alpha: 0.35, minStep: 0.006, maxPts: 400, width: 0.014, byteSoft: 240 * 1024, ptBytes: 14 };
const r3 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
export function penStart(x, y, room = PEN.maxPts) {
  return { sx: x, sy: y, room: Math.min(PEN.maxPts, room), pts: [[r3(x), r3(y)]] };
}
export function penMove(pen, x, y) {
  pen.sx += PEN.alpha * (x - pen.sx);
  pen.sy += PEN.alpha * (y - pen.sy);
  if (pen.pts.length >= pen.room) return false;
  const last = pen.pts[pen.pts.length - 1];
  if (Math.hypot(pen.sx - last[0], (pen.sy - last[1]) / ASPECT) < PEN.minStep) return false;
  pen.pts.push([r3(pen.sx), r3(pen.sy)]);
  return true;
}
export function penEnd(pen, landing) {
  const pts = pen.pts.slice();
  if (landing && pts.length < pen.room) {
    const p = [r3(landing.x), r3(landing.y)], last = pts[pts.length - 1];
    if (p[0] !== last[0] || p[1] !== last[1]) pts.push(p);
  }
  return pts;
}
export const penRoom = (jsonLength) => Math.min(PEN.maxPts, Math.floor((PEN.byteSoft - jsonLength - 96) / PEN.ptBytes));
export function strokePath(pts) {
  const f = (v) => String(Math.round(v * 10) / 10);
  return pts.map(([x, y], k) => (k ? "L" : "M") + f(x * 1600) + " " + f(y * 900)).join("");
}
```

Replace `describe` with:

```js
// What she DID (spec 2026-09-30 §2.3; 2026-10-02 §4): counted, in the order she first placed each,
// "a, b and c". A person is named by their word, once. Strokes and ids this table does not know (a
// person who left the library, a newer version's sticker) are not in the sentence.
export function describe(items, table) {
  const order = [], count = new Map();
  for (const it of items || []) {
    if (!it || it.s === "stroke" || !stickerById(table, it.s)) continue;
    if (!count.has(it.s)) order.push(it.s);
    count.set(it.s, (count.get(it.s) || 0) + 1);
  }
  const parts = order.map((id) => {
    const st = stickerById(table, id), n = count.get(id);
    if (st.person) return st.word;
    return n === 1 ? "a " + st.word.toLowerCase() : (NUMBER[n] || String(n)) + " " + st.plural;
  });
  if (!parts.length) return "You made a picture!";
  const list = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  return "You made a picture with " + list + "!";
}
```

Replace `sceneOps` with:

```js
// The one geometry: every item's box as fractions of the scene's width (left, width) and height
// (top, height). A stroke covers the whole picture and carries its path in 1600x900 units.
// Unknown ids (a newer version's sticker, a person who left the library) are skipped, never thrown on.
export function sceneOps(scene, table) {
  const out = [];
  (scene && scene.items || []).forEach((it, i) => {
    if (it && it.s === "stroke") {
      if (!Array.isArray(it.pts) || it.pts.length < 2) return;
      out.push({ i, s: "stroke", kind: "stroke", d: strokePath(it.pts), stroke: it.c, lineWidth: it.w * 900,
                 left: 0, top: 0, width: 1, height: 1 });
      return;
    }
    const st = stickerById(table, it && it.s);
    if (!st) return;
    const hx = it.w / ASPECT / 2, hy = it.w / 2;
    const splat = it.s === "splat";
    out.push({ i, s: it.s, kind: splat ? "splat" : "img", src: splat ? null : st.src,
               d: splat ? splatPath(it.seed) : null, fill: splat ? it.c : null,
               left: it.x - hx, top: it.y - hy, width: 2 * hx, height: 2 * hy });
  });
  return out;
}
```

After `splatSvg` add:

```js
// One stroke as DOM: the ring's strokes (renderScene) and the live pen (drawing.js) are this element.
export function strokeSvg(d, colour, w) {
  const el = document.createElementNS(SVGNS, "svg");
  el.setAttribute("viewBox", "0 0 1600 900");
  el.setAttribute("preserveAspectRatio", "none");
  const p = document.createElementNS(SVGNS, "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", colour);
  p.setAttribute("stroke-width", String(Math.round(w * 900 * 10) / 10));
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  el.appendChild(p);
  return el;
}
```

In `renderScene`'s canvas loop, make the item branches:

```js
      if (op.kind === "stroke") {
        target.save();
        target.scale(W / 1600, H / 900);
        target.strokeStyle = op.stroke;
        target.lineWidth = op.lineWidth;
        target.lineCap = "round";
        target.lineJoin = "round";
        target.stroke(new Path2D(op.d));
        target.restore();
      } else if (op.kind === "splat") {
        /* v1's splat lines, unchanged */
      } else if (images && images[op.s] && images[op.s].complete && images[op.s].naturalWidth) {
        const im = images[op.s];                     // contain, bottom-aligned: a figure is never stretched
        const f = Math.min(w / im.naturalWidth, h / im.naturalHeight), dw = im.naturalWidth * f, dh = im.naturalHeight * f;
        target.drawImage(im, x + (w - dw) / 2, y + h - dh, dw, dh);
      }
```

In the DOM branch's `ops.map`, make the element: `if (op.kind === "stroke") el = strokeSvg(op.d, op.stroke, op.lineWidth / 900); else if (op.kind === "splat") … else …` (v1's two branches unchanged) and set the class with `el.setAttribute("class", op.kind === "stroke" ? "item stroke" : "item");`.

In `public/drawing/drawing.css` after `#scene .item{…}` add:

```css
.scene img.item{object-fit:contain; object-position:50% 100%}         /* a person is never stretched */
#scene .item.stroke{pointer-events:none}                                /* ink is never a finger target */
```

- [ ] **Step 4: Run them — they pass**

Run: `node --test tests/drawing-scene.test.mjs` → `# pass 19`, `# fail 0`. `node --test tests/drawing-ui.test.mjs` → `# pass 34`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add public/drawing/scene.js public/drawing/drawing.css tests/drawing-scene.test.mjs
git commit -m "drawing: scene.js learns strokes and people — a smoothed, spaced, capped pen; one path string for the ring and the PNG; people from the library, never stretched; the sentence names people and skips ink (spec 2026-10-02 §3, §4)"
```

---

### Task 4: The hub — v2 validation, 256 KB, the characters library and its routes, the `characters` mirror

**Files:**
- Modify: `drawings.js`
- Modify: `server.js` (two routes, just above `if ((req.method === "GET" || req.method === "HEAD") && urlPath.startsWith("/books/"))`)
- Modify: `drive.js` (header list, `MIRROR_SUBDIRS`, `MIRROR_DELETES`, `ADOPT_ON_FIRST_SYNC`, `BYTE_COMPARE`)
- Test: `tests/drawings.test.mjs`, `tests/drive-mirror.test.mjs`

**Interfaces:**
- Consumes: T1's `stickers.json` (`crayons`, `crayonDefault`, `backdrops`).
- Produces: `drawings.LIMITS = { items: 200, sceneBytes: 262144, pngBytes: 4194304, strokePts: 400, strokeW: [0.005, 0.05] }`; `drawings.validateScene(obj, { people = null } = {}) → { ok, scene: { v: 1, backdrop, crayon, items } } | { ok: false, why }` (`people`: a `Set` of slugs, or `null` = shape only); `drawings.characters() → [{ slug, word, scale }]`; `drawings.SLUG_RE`; stored scenes carry `backdrop` and `crayon`; `list()` rows carry thinned strokes. Routes `GET/HEAD /characters/index.json`, `GET/HEAD /characters/<slug>.png|characters.json`.

- [ ] **Step 1: Write the failing tests.** In `tests/drawings.test.mjs` add `import zlib from "node:zlib";`; in "validation: …" replace `assert.equal(drawings.validateScene({ v: 1, backdrop: "beach", items: [] }).ok, false, "one backdrop in v1");` with `assert.equal(drawings.validateScene({ v: 1, backdrop: "beach", items: [] }).scene.backdrop, "beach", "eight places in v2");`; in "PUT scene.json validates …" change `" ".repeat(66 * 1024)` to `" ".repeat(257 * 1024)`. After the test "where a picture lives is drive.json plus one stat …" add:

```js
// ---- v2 (spec 2026-10-02 §3-§5, §7): strokes, crayons, places, people -------------------
// A tiny real PNG (RGBA, one colour) — family images never enter this repo (spec §4).
function tinyPng(w, h, rgba = [51, 102, 204, 255]) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 4).fill(Buffer.from(rgba))]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
const CH = () => path.join(UNIT, "characters");
function library(people, pngs = people.map((p) => p.slug)) {
  fs.mkdirSync(CH(), { recursive: true });
  for (const s of pngs) fs.writeFileSync(path.join(CH(), s + ".png"), tinyPng(16, 32));
  fs.writeFileSync(path.join(CH(), "characters.json"), JSON.stringify({ v: 1, people }));
}
const S1 = { s: "stroke", c: "#d96fa6", w: 0.014, pts: [[0.1, 0.2], [0.3, 0.4]], by: "ellie" };
const P = (slug) => ({ s: "person:" + slug, x: 0.5, y: 0.77, w: 0.3, by: "ellie" });

test("v2 validation: strokes, crayons and places; unknown place → meadow, unknown crayon → Blue", () => {
  freshUnit("none");
  const v = drawings.validateScene({ v: 1, backdrop: "city", crayon: "#d96fa6", items: [S1, H] });
  assert.deepEqual(v, { ok: true, scene: { v: 1, backdrop: "city", crayon: "#d96fa6", items: [S1, H] } });
  assert.equal(drawings.validateScene({ v: 1, backdrop: "volcano", items: [] }).scene.backdrop, "meadow");
  assert.equal(drawings.validateScene({ v: 1, crayon: "#B23A48", items: [] }).scene.crayon, "#0F7C8A", "partner red is never a crayon");
  assert.equal(drawings.validateScene({ v: 1, items: [] }).scene.crayon, "#0F7C8A");
  for (const [why, it] of [
    ["one point", { ...S1, pts: [[0.1, 0.2]] }], ["401 points", { ...S1, pts: Array.from({ length: 401 }, () => [0.5, 0.5]) }],
    ["a point outside", { ...S1, pts: [[0.1, 0.2], [1.2, 0.4]] }], ["a point not a pair", { ...S1, pts: [[0.1, 0.2], [0.3]] }],
    ["not a crayon", { ...S1, c: "#B23A48" }], ["too thin", { ...S1, w: 0.004 }], ["too thick", { ...S1, w: 0.06 }],
    ["pts not a list", { ...S1, pts: "M0 0" }], ["by a robot", { ...S1, by: "robot" }],
  ]) assert.equal(drawings.validateScene({ v: 1, items: [it] }).ok, false, why);
  assert.equal(drawings.validateScene({ v: 1, items: [{ ...S1, c: "#D96FA6" }] }).ok, true, "hex compared case-insensitively");
  assert.equal(drawings.validateScene({ v: 1, items: Array(201).fill(S1) }).ok, false, "a stroke is one item toward the 200");
  assert.equal(drawings.validateScene({ v: 1, items: [P("maya")] }).ok, true, "shape only when no library is given");
  assert.equal(drawings.validateScene({ v: 1, items: [P("maya")] }, { people: new Set(["sam"]) }).ok, false, "not in the library");
  assert.equal(drawings.validateScene({ v: 1, items: [P("maya")] }, { people: new Set(["maya"]) }).ok, true);
  assert.equal(drawings.validateScene({ v: 1, items: [{ ...P("maya"), s: "person:Maya!" }] }).ok, false, "a slug is a-z0-9-");
  assert.equal(drawings.validateScene({ v: 1, items: [{ ...P("maya"), x: 2 }] }).ok, false, "a person is placed like a sticker");
});

test("the characters library: dad's order, only with a PNG, junk skipped; absent or broken → []", () => {
  freshUnit("none");
  assert.deepEqual(drawings.characters(), [], "no folder");
  library([{ slug: "sam", word: "Sam" }, { slug: "maya", word: " Maya ", scale: 0.25 }, { slug: "nopic", word: "No pic" },
    { slug: "Bad Slug", word: "x" }, { slug: "maya", word: "Again" }, { slug: "tall", word: "Tall", scale: 0.9 },
    { slug: "noword" }, 7, { slug: "long", word: "x".repeat(25) }], ["sam", "maya", "tall", "noword", "long"]);
  assert.deepEqual(drawings.characters(), [{ slug: "sam", word: "Sam", scale: 0.3 }, { slug: "maya", word: "Maya", scale: 0.25 },
    { slug: "tall", word: "Tall", scale: 0.3 }]);
  fs.writeFileSync(path.join(CH(), "characters.json"), "{ not json");
  assert.deepEqual(drawings.characters(), []);
  fs.writeFileSync(path.join(CH(), "characters.json"), JSON.stringify({ v: 1, people: "nope" }));
  assert.deepEqual(drawings.characters(), []);
});

test("a person who left the library: a picture that already holds them still saves; a new unknown person is refused (deviation 8)", () => {
  freshUnit("none");
  library([{ slug: "maya", word: "Maya" }, { slug: "sam", word: "Sam" }]);
  const { id } = drawings.create();
  assert.equal(drawings.writeScene(id, { v: 1, items: [P("maya"), P("sam")] }).ok, true);
  fs.rmSync(path.join(CH(), "sam.png"));
  library([{ slug: "maya", word: "Maya" }], ["maya"]);
  assert.equal(drawings.writeScene(id, { v: 1, items: [P("maya"), P("sam"), H] }).ok, true, "sam is already in this picture");
  assert.equal(drawings.writeScene(id, { v: 1, items: [P("maya"), P("sam"), P("kai")] }).error, "bad-scene");
});

test("the shelf keeps a picture's place and crayon, thins strokes to 60 points, and never hides another device's people", () => {
  freshUnit("none");
  const { id } = drawings.create();
  const pts = Array.from({ length: 400 }, (_, k) => [0.1, +(0.1 + k / 1000).toFixed(3)]);
  drawings.writeScene(id, { v: 1, backdrop: "night", crayon: "#f7f7f7", items: [{ s: "stroke", c: "#f7f7f7", w: 0.014, pts, by: "ellie" }] });
  const row = drawings.list().find((p) => p.id === id);
  assert.deepEqual([row.items, row.scene.backdrop, row.scene.crayon], [1, "night", "#f7f7f7"]);
  const th = row.scene.items[0].pts;
  assert.equal(th.length, 60);
  assert.deepEqual([th[0], th.at(-1)], [pts[0], pts[399]]);
  assert.equal(drawings.readScene(id).items[0].pts.length, 400, "the picture itself stays whole");
  const other = "2026-10-02-100000-other-dev";
  fs.mkdirSync(onShelf(other), { recursive: true });
  fs.writeFileSync(path.join(onShelf(other), "scene.json"), JSON.stringify({ v: 1, id: other, items: [P("gone")] }));
  assert.ok(drawings.list().some((p) => p.id === other), "a person this device lacks never hides the picture");
});
```

and after the test "the doors: …" (routes section) add:

```js
test("PUT takes a scene up to 256 KB and refuses a bigger body with 413", async () => {
  const id = await newPic();
  const pts = Array.from({ length: 400 }, (_, k) => [0.123, +(0.1 + k / 1000).toFixed(3)]);
  const S = { s: "stroke", c: "#0F7C8A", w: 0.014, pts, by: "ellie" };
  const ok = JSON.stringify({ v: 1, items: Array(44).fill(S) });
  assert.ok(ok.length > 64 * 1024 && ok.length < 256 * 1024, String(ok.length));
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, ok)).status, 200);
  const big = JSON.stringify({ v: 1, items: Array(50).fill(S) });
  assert.ok(big.length > 256 * 1024, String(big.length));
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, big)).status, 413);
});

test("GET /characters/index.json lists the library ([] with none), PNGs are path-jailed, and a PUT checks people against it", async () => {
  const CHR = path.join(RT, "characters");
  fs.rmSync(CHR, { recursive: true, force: true });
  let r = await fetch(BASE + "/characters/index.json");
  assert.deepEqual([r.status, await r.json()], [200, []]);
  fs.mkdirSync(CHR, { recursive: true });
  fs.writeFileSync(path.join(CHR, "maya.png"), tinyPng(16, 32));
  fs.writeFileSync(path.join(CHR, "characters.json"), JSON.stringify({ v: 1, people: [{ slug: "maya", word: "Maya" }] }));
  assert.deepEqual(await (await fetch(BASE + "/characters/index.json")).json(), [{ slug: "maya", word: "Maya", scale: 0.3 }]);
  r = await fetch(BASE + "/characters/maya.png");
  assert.deepEqual([r.status, r.headers.get("content-type"), r.headers.get("cache-control")], [200, "image/png", "no-cache"]);
  assert.equal((await fetch(BASE + "/characters/characters.json")).status, 200);
  for (const bad of ["/characters/Maya.png", "/characters/maya.txt", "/characters/sub/maya.png", "/characters/..%2Fdrive.json"])
    assert.notEqual((await fetch(BASE + bad)).status, 200, bad);
  const id = await newPic();
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, { v: 1, items: [P("maya")] })).status, 200);
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, { v: 1, items: [P("maya"), P("kai")] })).status, 400);
});
```

In `tests/drive-mirror.test.mjs` change the pin at `:202-203` to `["books", "music", "movies", "content", "clothing", "drawings", "characters"]` and append:

```js
// ---- characters (spec 2026-10-02 §4): Drawing's People library rides the mirror like drawings —
// it all arrives through the mirror (adopted on the first sync), a person removed in Drive leaves
// every device, and characters.json is compared by its bytes (dad edits words of the same length).
test("characters mirror in, adopt what is there, follow deletions, and a same-length characters.json edit still crosses", async () => {
  const D = path.join(TMP, "data-characters"), S = path.join(TMP, "My Drive", "Characters Content");
  const src = (f) => path.join(S, "characters", f), here = (f) => path.join(D, "characters", f);
  fs.mkdirSync(path.join(S, "characters"), { recursive: true });
  fs.writeFileSync(src("maya.png"), "png-a");
  fs.writeFileSync(src("sam.png"), "png-b");
  const j1 = JSON.stringify({ v: 1, people: [{ slug: "maya", word: "Maya" }, { slug: "sam", word: "Sam" }] });
  fs.writeFileSync(src("characters.json"), j1);
  fs.mkdirSync(path.join(D, "characters"), { recursive: true });
  fs.writeFileSync(here("old.png"), "an earlier sync's copy");       // no ledger yet: adopted, so it follows Drive
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);
  await drive.sync();
  assert.ok(fs.existsSync(here("maya.png")) && fs.existsSync(here("sam.png")), "the library reached this device");
  assert.ok(!fs.existsSync(here("old.png")), "adopted on the first sync");
  const j2 = j1.replace('"Sam"', '"Kai"');
  assert.equal(j2.length, j1.length);
  fs.writeFileSync(src("characters.json"), j2);
  await drive.sync();
  assert.equal(fs.readFileSync(here("characters.json"), "utf8"), j2, "compared by content, not by size");
  fs.rmSync(src("sam.png"));
  await drive.sync();
  assert.ok(!fs.existsSync(here("sam.png")), "a person removed in Drive leaves this device");
  assert.ok(fs.existsSync(here("maya.png")));
});
```

- [ ] **Step 2: Run them — they fail**

Run: `node --test tests/drawings.test.mjs tests/drive-mirror.test.mjs`
Expected failures: "validation: …" (beach refused), "v2 validation" (`unknown sticker`), "the characters library" (`drawings.characters is not a function`), "a person who left …", "the shelf keeps …" (backdrop `meadow`), "PUT takes … 256 KB" (413 on the 44-stroke body), "GET /characters/index.json" (404), the PUT 257 KB line passes already (413) — fine; drive-mirror: the pin and "characters mirror in" (`maya.png` missing).

- [ ] **Step 3: `drawings.js`.**

Change `LIMITS` to `const LIMITS = { items: 200, sceneBytes: 256 * 1024, pngBytes: 4 * 1024 * 1024, strokePts: 400, strokeW: [0.005, 0.05] };` and add below it:

```js
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PERSON_RE = /^person:([a-z0-9][a-z0-9-]{0,39})$/;
const WORD_MAX = 24, SCALE = { min: 0.1, max: 0.6, dflt: 0.30 };
```

Add after `stickerTable()`:

```js
// ---------------------------------------------------------------- People (spec 2026-10-02 §4)
// The library the mirror carries in from the family's Drive folder: <DATA>/characters/characters.json
// + <slug>.png. Read fresh on every call (a few hundred bytes; dad edits it by hand). An entry shows
// only with its PNG beside it; anything malformed is skipped; an unreadable file is an empty library.
const charactersRoot = () => path.join(DATA, "characters");
function characters() {
  if (!DATA) return [];
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(charactersRoot(), "characters.json"), "utf8")); } catch { return []; }
  const out = [], seen = new Set();
  for (const p of (j && Array.isArray(j.people)) ? j.people : []) {
    if (!p || typeof p !== "object") continue;
    const slug = p.slug, word = typeof p.word === "string" ? p.word.trim() : "";
    if (typeof slug !== "string" || !SLUG_RE.test(slug) || seen.has(slug) || !word || word.length > WORD_MAX) continue;
    if (!fs.existsSync(path.join(charactersRoot(), slug + ".png"))) continue;
    const scale = typeof p.scale === "number" && Number.isFinite(p.scale) && p.scale >= SCALE.min && p.scale <= SCALE.max ? p.scale : SCALE.dflt;
    seen.add(slug);
    out.push({ slug, word, scale });
  }
  return out;
}
// The shelf's thumbnails need the shape of a stroke, not all 400 points (deviation 10).
function thin(pts, n = 60) {
  if (pts.length <= n) return pts;
  const out = [];
  for (let k = 0; k < n; k++) out.push(pts[Math.round(k * (pts.length - 1) / (n - 1))]);
  return out;
}
```

Replace `validateScene` with:

```js
// people: a Set of slugs a person item may name (writeScene: the library + the people this picture
// already holds — deviation 8), or null = shape only (list(): never hide another device's picture).
const num01 = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
function validateScene(obj, { people = null } = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, why: "not an object" };
  if (obj.v !== 1) return { ok: false, why: "v must be 1" };
  if (!Array.isArray(obj.items)) return { ok: false, why: "items must be a list" };
  if (obj.items.length > LIMITS.items) return { ok: false, why: "more than " + LIMITS.items + " items" };
  const T = stickerTable();
  const known = new Set((T.stickers || []).map((s) => s.id));
  const crayons = new Set((T.crayons || []).map((c) => c.hex.toLowerCase()));
  const places = new Set((T.backdrops || []).map((b) => b.id));
  const backdrop = places.has(obj.backdrop) ? obj.backdrop : "meadow";                 // spec §5
  const crayon = typeof obj.crayon === "string" && crayons.has(obj.crayon.toLowerCase()) ? obj.crayon : (T.crayonDefault || "#0F7C8A");
  const items = [];
  for (let i = 0; i < obj.items.length; i++) {
    const it = obj.items[i];
    if (!it || typeof it !== "object" || Array.isArray(it)) return { ok: false, why: `item ${i} is not an object` };
    const by = it.by === undefined ? "ellie" : it.by;
    if (!BY.includes(by)) return { ok: false, why: `item ${i}: by` };
    if (it.s === "stroke") {                                                             // spec §3
      if (typeof it.c !== "string" || !crayons.has(it.c.toLowerCase())) return { ok: false, why: `item ${i}: stroke colour` };
      if (typeof it.w !== "number" || !(it.w >= LIMITS.strokeW[0] && it.w <= LIMITS.strokeW[1])) return { ok: false, why: `item ${i}: stroke width` };
      if (!Array.isArray(it.pts) || it.pts.length < 2 || it.pts.length > LIMITS.strokePts) return { ok: false, why: `item ${i}: stroke points` };
      for (const p of it.pts) if (!Array.isArray(p) || p.length !== 2 || !num01(p[0]) || !num01(p[1])) return { ok: false, why: `item ${i}: a point` };
      items.push({ s: "stroke", c: it.c, w: it.w, pts: it.pts.map((p) => [p[0], p[1]]), by });
      continue;
    }
    const person = PERSON_RE.exec(typeof it.s === "string" ? it.s : "");
    if (person) { if (people && !people.has(person[1])) return { ok: false, why: `item ${i}: not in the library` }; }
    else if (!known.has(it.s)) return { ok: false, why: `item ${i}: unknown sticker` };
    if (!num01(it.x) || !num01(it.y)) return { ok: false, why: `item ${i}: x/y outside 0-1` };
    if (!num01(it.w) || it.w === 0) return { ok: false, why: `item ${i}: w outside (0,1]` };
    const out = { s: it.s, x: it.x, y: it.y, w: it.w, by };
    if (it.s === "splat") {
      if (typeof it.c !== "string" || !HEX.test(it.c)) return { ok: false, why: `item ${i}: splat colour` };
      if (!Number.isInteger(it.seed) || it.seed < 0 || it.seed > 0xFFFFFFFF) return { ok: false, why: `item ${i}: splat seed` };
      out.c = it.c; out.seed = it.seed;
    }
    items.push(out);
  }
  return { ok: true, scene: { v: 1, backdrop, crayon, items } };
}
```

In `create()` make the scene `{ v: 1, id, created: t, updated: t, device: DEVICE, backdrop: "meadow", crayon: stickerTable().crayonDefault || "#0F7C8A", items: [], mailedHash: null }`. Replace the body of `writeScene` after the `isId` check with:

```js
  const prev = readScene(id);
  const lib = new Set(characters().map((p) => p.slug));
  for (const it of (prev && Array.isArray(prev.items)) ? prev.items : []) {
    const m = PERSON_RE.exec(it && typeof it.s === "string" ? it.s : "");
    if (m) lib.add(m[1]);                                   // grandfathered (deviation 8)
  }
  const v = validateScene(body, { people: lib });
  if (!v.ok) return { error: "bad-scene", why: v.why };
  const scene = { v: 1, id, created: (prev && prev.created) || iso(), updated: iso(),
                  device: (prev && prev.device) || DEVICE, backdrop: v.scene.backdrop, crayon: v.scene.crayon,
                  items: v.scene.items, mailedHash: (prev && prev.mailedHash) || null };
  const w = writeFile(id, "scene.json", sceneBytes(scene));
  return w.ok ? { ok: true, scene, mount: w.mount } : { error: "write-failed" };
```

In `list()`, make the pushed row's scene `{ ...sc, backdrop: v.scene.backdrop, crayon: v.scene.crayon, items: v.scene.items.map((it) => (it.s === "stroke" ? { ...it, pts: thin(it.pts) } : it)) }` (the `validateScene(sc)` call stays shape-only). Add `SLUG_RE, characters` to `module.exports`. Update the header comment's first line to also cite `docs/superpowers/specs/2026-10-02-drawing-modes-design.md §3-§5, §7`.

- [ ] **Step 4: `server.js` routes.** Just above `if ((req.method === "GET" || req.method === "HEAD") && urlPath.startsWith("/books/")) {` insert:

```js
  // ---- People (spec 2026-10-02 §4): the private library the mirror carries in from the family's
  // Drive folder. index.json never 500s (drawings.characters() reads defensively); files are
  // path-jailed to one flat folder, slugs only.
  if ((req.method === "GET" || req.method === "HEAD") && urlPath === "/characters/index.json") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(drawings.characters()));
    return;
  }
  const charPath = /^\/characters\/([a-z0-9][a-z0-9-]{0,39}\.png|characters\.json)$/.exec(urlPath);
  if (charPath && (req.method === "GET" || req.method === "HEAD")) {
    serveMediaJail(req, res, path.join(DATA, "characters"), charPath[1], [".png", ".json"], [], [], null, "no-cache");
    return;
  }
```

- [ ] **Step 5: `drive.js`.** Add to the header list after the drawings line: `//   <folder>/characters/... -> <DATA>/characters/... (Drawing's People: cut-outs + characters.json)`. Append `"characters"` to `MIRROR_SUBDIRS`, `MIRROR_DELETES` and `ADOPT_ON_FIRST_SYNC`, each with a one-line comment `// characters: added 10/2 — Drawing's People library (spec 2026-10-02 §4); like drawings, everything under <DATA>/characters arrived through this mirror.`; make `BYTE_COMPARE = MANIFEST_NAMES.concat(["job.json", "scene.json", "characters.json"]);` with the comment `// characters.json (People): dad renames "Sam" to "Kai" — a same-size rewrite.`

- [ ] **Step 6: Run them — they pass**

Run: `node --test tests/drawings.test.mjs tests/drive-mirror.test.mjs` → `# pass 67` (`drawings` 34, `drive-mirror` 33), `# fail 0`. Then `node --test tests/drawing-ui.test.mjs` → `# pass 34`.

- [ ] **Step 7: Commit**

```bash
git add drawings.js server.js drive.js tests/drawings.test.mjs tests/drive-mirror.test.mjs
git commit -m "drawing: the hub takes v2 pictures — strokes, crayons, eight places, people checked against the family's library (grandfathered), 256 KB, thinned shelf strokes; /characters routes; characters ride the Drive mirror (spec 2026-10-02 §3-§5, §7)"
```

---
### Task 5: Row 5 — four mode tiles beside the rest tile, the glow, the remembered mode, the palette seats

**Files:**
- Modify: `public/drawing/index.html` (`#sRing` markup)
- Modify: `public/drawing/drawing.css` (row 5, `#art`/`#pen`/`#hits`, glow, `.pal-black`)
- Modify: `public/drawing/drawing.js` (modes, `renderPalette`, `markOn`, `applyTargets`, `settle`, route hook; v1 `buildTiles` split)
- Test: `tests/drawing-ui.test.mjs`

**Interfaces:**
- Consumes: T1 `TABLE.modes`; T2 `exportPng`.
- Produces (drawing.js): `MODES`, `SEATS`, `MODE_KEY = "drawing_mode"`, `ROUTE_RE = /^#p=([^&]+)(?:&mode=([a-z]+))?$/`; `S.mode`; `setMode(id)`; `renderPalette()` (rebuilds the 8 `#sRing > .pal` cells for `S.mode`; T6–T8 add their builders to its switch); `markOn()` (the `.on` glow; T6/T7 extend it); `applyTargets()` (T7, T9 fill it); `settle()` (T7, T9 fill it); `stickerTile(st)`; `blackPal()`; `paintScene()` now renders into `#art`. `window.Drawing.setMode`, `window.Drawing.settle`, `state().mode`. Test helpers (drawing-ui): `SEAT_KEYS`, `paletteOf(page)`, `makePage({ hooks: false })`.

- [ ] **Step 1: Write the failing tests.** In `tests/drawing-ui.test.mjs`: add `import { CONTRACT } from "../public/lib/contract.js";`; in `makePage` replace `await ctx.addInitScript(() => { window.__testHooks = true; });` with `if (opts.hooks !== false) await ctx.addInitScript(() => { window.__testHooks = true; });`. Update the v1 counts: in "her picture and the rest tile are inert …" make the count `ringTargets: document.querySelectorAll("#sRing .cell.dwell").length,` (tiles only — from T9 the picture's items are targets too and are counted by the audit, not here) and replace `assert.equal(r.ringTargets, 10, "8 stickers + Undo + Done");` with 

```js
  assert.equal(r.ringTargets, 14, "8 palette + 4 modes + Undo + Done");
  assert.ok(r.ringTargets <= CONTRACT.maxChoices.cap, "inside the contract's cap of 16 (spec 2026-10-02 §8)");
```
— in "at 1280x720 …" make the selector `#sRing .cell.dwell` and `assert.equal(mins.length, 10);` → `14`; in "the sheet puts every target to sleep …" `asleep: 10` → `asleep: 14` and `live: 10` → `live: 14`, and before `await page.locator("#pClose").click();` add `assert.equal(await page.evaluate(() => document.getElementById("mode-draw").hasAttribute("data-dwell-disabled")), true, "the mode tiles sleep too");`. Then append:

```js
// ================================================================ v2 T5 — row 5 and the modes
const SEAT_KEYS = ["1,1", "2,1", "3,1", "4,1", "1,3", "2,3", "3,3", "4,3"];
const paletteOf = (page) => page.evaluate(() => [...document.querySelectorAll("#sRing > .pal")].map((el) => ({
  seat: el.dataset.seat, id: el.id || null, black: el.classList.contains("pal-black"), dwell: el.classList.contains("dwell"),
  on: el.classList.contains("on"), word: el.textContent.trim() })));
const rects = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => {
  const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(","); }), sel);

test("row 5: Undo, Draw, People, the black rest tile, Stickers, Places, Done — five equal cells under the picture", async () => {
  const { ctx, page, errors } = await openRing();
  const g = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    return { row: [...document.querySelectorAll("#modeRow > *")].map((el) => ({ id: el.id, ...box(el), word: el.textContent.trim(),
               dwell: el.classList.contains("dwell"), bg: getComputedStyle(el).backgroundColor,
               attrs: [...el.attributes].some((a) => a.name.startsWith("data-dwell")) })),
             undo: box(document.getElementById("btnUndo")), done: box(document.getElementById("btnDone")),
             scene: box(document.getElementById("scene")) };
  });
  const byX = [...g.row].sort((a, b) => a.x - b.x);
  assert.deepEqual(byX.map((c) => c.id), ["mode-draw", "mode-people", "restTile", "mode-stickers", "mode-places"]);
  assert.deepEqual(byX.map((c) => c.word), ["Draw", "People", "", "Stickers", "Places"]);
  assert.deepEqual([byX[2].bg, byX[2].dwell, byX[2].attrs], ["rgb(0, 0, 0)", false, false], "the rest tile: black and inert");
  for (const c of byX) {
    assert.ok(Math.abs(c.w - byX[0].w) < 1 && Math.abs(c.h - byX[0].h) < 1, "equal cells: " + c.id);
    assert.ok(Math.abs(c.y - g.undo.y) < 1 && Math.abs(c.h - g.undo.h) < 1, "on row 5: " + c.id);
    assert.ok(Math.min(c.w, c.h) >= 90, c.id + " is at least 90 px");
  }
  for (let k = 1; k < 5; k++) assert.ok(byX[k].x - (byX[k - 1].x + byX[k - 1].w) >= 13.5, "14 px gaps");
  assert.ok(byX[0].x > g.undo.x + g.undo.w && byX[4].x + byX[4].w < g.done.x, "between Undo and Done");
  assert.ok(Math.abs(byX[2].x + byX[2].w / 2 - (g.scene.x + g.scene.w / 2)) < 2, "the rest tile is centred under the picture");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("modes: Stickers first and glowing teal; a switch speaks its word, moves the glow and is remembered; the active mode does nothing", async () => {
  const { ctx, page } = await openRing();
  const on = () => page.evaluate(() => [...document.querySelectorAll("#modeRow .on")].map((e) => e.id));
  assert.equal((await st(page)).mode, "stickers");
  assert.deepEqual(await on(), ["mode-stickers"]);
  assert.match(await page.evaluate(() => getComputedStyle(document.getElementById("mode-stickers")).boxShadow), /rgb\(15, 124, 138\)/);
  await page.locator("#mode-places").click();
  let s = await st(page);
  assert.deepEqual([s.mode, s.said.at(-1)], ["places", "Places"]);
  assert.deepEqual(await on(), ["mode-places"]);
  assert.ok(await page.evaluate(() => (window.__speechEngineLog || []).some((e) => e.ev === "stop")), "Speech.stop() first");
  const n = s.said.length;
  await page.locator("#mode-places").click();
  assert.equal((await st(page)).said.length, n, "the active mode: no toggle, no speech");
  assert.equal(await page.evaluate(() => localStorage.getItem("drawing_mode")), "places");
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.Drawing && window.Drawing.state().ready);
  assert.equal((await st(page)).mode, "places", "the ring remembers the last mode");
  await ctx.close();
});

test("the side columns are the mode's palette: eight fixed seats whose contents swap; nothing on the ring moves", async () => {
  const { ctx, page } = await openRing();
  assert.deepEqual((await paletteOf(page)).map((c) => c.seat), SEAT_KEYS);
  assert.deepEqual((await paletteOf(page)).map((c) => c.id),
    ["tile-house", "tile-horse", "tile-tree", "tile-person", "tile-sun", "tile-cloud", "tile-star", "tile-splat"], "Stickers = v1");
  const ring = "#sRing > .pal, #modeRow > *, #btnUndo, #btnDone, #scene";
  const before = await rects(page, ring);
  for (const m of ["draw", "people", "places", "stickers"]) {
    await page.locator("#mode-" + m).click();
    assert.deepEqual((await paletteOf(page)).map((c) => c.seat), SEAT_KEYS, m);
    assert.deepEqual(await rects(page, ring), before, m + ": zero layout shift");
  }
  await ctx.close();
});

test("&mode=<id> in the hash opens that mode under the test hooks only, and is never remembered", async () => {
  const id = await newId();
  let p = await makePage({ hash: `#p=${id}&mode=draw` });
  await p.page.waitForFunction(() => window.Drawing.state().screen === "ring");
  assert.equal((await st(p.page)).mode, "draw");
  assert.equal(await p.page.evaluate(() => localStorage.getItem("drawing_mode")), null);
  await p.ctx.close();
  p = await makePage({ hash: `#p=${id}&mode=draw`, hooks: false });
  await p.page.waitForFunction(() => window.Drawing.state().screen === "ring");
  assert.equal((await st(p.page)).mode, "stickers", "a real device ignores it");
  await p.ctx.close();
});
```

- [ ] **Step 2: Run them — they fail**

Run: `node --test tests/drawing-ui.test.mjs`
Expected: the four new tests fail (`#modeRow` missing / `state().mode` undefined); the three updated v1 tests fail on 10 vs 14.

- [ ] **Step 3: Markup.** In `public/drawing/index.html` replace the body of `<section id="sRing" …>` with:

```html
  <div id="sceneCell"><div id="scene" class="scene" aria-label="Her picture">
    <div id="art" class="scene"></div><div id="pen"></div><div id="hits"></div>
  </div></div>
  <button type="button" id="btnUndo" class="cell text dwell" aria-label="Undo">
    <span class="glyph" aria-hidden="true">↩</span><span class="word">Undo</span></button>
  <!-- row 5 under the picture (spec 2026-10-02 §1): Draw, People, the rest tile, Stickers, Places;
       drawing.js puts the four mode tiles in their columns from stickers.json modes[].seat -->
  <div id="modeRow"><div id="restTile" aria-hidden="true"></div></div>
  <button type="button" id="btnDone" class="cell text dwell" aria-label="Done">
    <span class="glyph" aria-hidden="true">✔</span><span class="word">Done</span></button>
```
and change the comment above the section to say the side columns are the current mode's palette (spec 2026-10-02 §1) and the picture is a dwell target only in Draw mode or while she carries something.

- [ ] **Step 4: Styles.** In `public/drawing/drawing.css` replace the `#restTile{…}` rule (`:41-42`) with:

```css
/* row 5 (spec 2026-10-02 §1): five equal cells under the picture — Draw, People, rest, Stickers, Places */
#modeRow{grid-row:5; grid-column:2; display:grid; grid-template-columns:repeat(5, minmax(0, 1fr));
         gap:var(--gap); min-width:0; min-height:0}
#restTile{grid-column:3; background:#000; border-radius:16px; min-width:0}   /* inert: no .dwell, ever */
```
and add:

```css
/* her picture's layers: #art (renderScene), the live pen, the item hit boxes, the landing spot */
#art{position:absolute; inset:0}
#pen, #hits{position:absolute; inset:0; pointer-events:none}
#pen{z-index:3} #hits{z-index:4}
/* the active mode, crayon and place: a teal glow outside the tile (never red, zero shift) */
.cell.on{box-shadow:0 0 0 5px var(--teal), 0 0 22px 6px rgba(15, 124, 138, .55)}
.pal-black{background:#000; border-radius:16px}                    /* an empty seat: inert, no text */
```

- [ ] **Step 5: drawing.js — modes and palettes.**

Constants (after `BAR_DOORS`):

```js
// v2 (spec 2026-10-02 §1): four modes, fixed forever; each palette fills the same eight seats.
const MODES = ["draw", "people", "stickers", "places"];
const SEATS = [[1, 1], [2, 1], [3, 1], [4, 1], [1, 3], [2, 3], [3, 3], [4, 3]];
const MODE_KEY = "drawing_mode";
const ROUTE_RE = /^#p=([^&]+)(?:&mode=([a-z]+))?$/;
```
Add `mode: "stickers", people: [], gaze: null, pen: null, carry: null, cool: null, spot: null, swallowUntil: 0, leaveTimer: null, restTimer: null,` to `S`.

Replace `buildTiles()` with `stickerTile(st)` (v1's loop body, returning the button without setting its grid row/column or appending it) and `loadStickers()`:

```js
function stickerTile(st) {
  const b = document.createElement("button");
  b.type = "button";
  b.id = "tile-" + st.id;
  b.className = "cell tile photo dwell";
  b.dataset.s = st.id;
  b.setAttribute("aria-label", st.word);
  let pic;
  if (st.src) { pic = document.createElement("img"); pic.src = st.src; pic.alt = ""; pic.draggable = false; }
  else pic = splatSample();
  pic.classList.add("pic");
  const word = document.createElement("span");
  word.className = "word plate";
  word.textContent = st.word;
  b.append(pic, word);
  b.addEventListener("click", () => place(st.id, b));
  return b;
}
function loadStickers() {
  for (const st of S.table.stickers) {
    S.stickers.set(st.id, st);
    if (st.src) { const im = new Image(); im.src = st.src; S.images[st.id] = im; }   // for the PNG
  }
}
```

Add the mode row:

```js
// ---------- the mode row (spec 2026-10-02 §1) ----------
function readMode() { try { const m = localStorage.getItem(MODE_KEY); return MODES.includes(m) ? m : "stickers"; } catch { return "stickers"; } }
function buildModes() {
  const row = $("modeRow");
  for (const m of S.table.modes || []) {
    const b = document.createElement("button");
    b.type = "button";
    b.id = "mode-" + m.id;
    b.className = "cell mode photo dwell";
    b.dataset.mode = m.id;
    b.setAttribute("aria-label", m.word);
    b.style.gridColumn = String(m.seat);
    const pic = document.createElement("img");
    pic.className = "pic"; pic.src = m.src; pic.alt = ""; pic.draggable = false;
    const word = document.createElement("span");
    word.className = "word plate";
    word.textContent = m.word;
    b.append(pic, word);
    b.addEventListener("click", () => setMode(m.id));
    row.appendChild(b);
  }
}
// A mode tile is her dwell. The active one does nothing; a switch speaks the mode word, swaps the
// palette in its fixed seats and is remembered. A live stroke ends / a carried item goes back first.
function setMode(m) {
  if (!MODES.includes(m) || S.screen !== "ring" || !S.scene) return;
  settle();
  if (m === S.mode) return;
  hush();
  S.mode = m;
  try { localStorage.setItem(MODE_KEY, m); } catch {}
  const mo = (S.table.modes || []).find((x) => x.id === m);
  say(m === "people" && !S.people.length ? "No people yet" : (mo ? mo.word : m));
  renderPalette();
  applyTargets();
  suppress();
  log("mode", { mode: m });
}
function blackPal() {
  const d = document.createElement("div");
  d.className = "pal-black";
  d.setAttribute("aria-hidden", "true");
  return d;
}
// The eight seats of the current mode. Every cell is rebuilt (a mode switch is a page change for her:
// setMode suppresses), and each lands in SEATS[k] — positions never move.
function paletteCells() {
  if (S.mode === "stickers") return S.table.stickers.map(stickerTile);
  return SEATS.map(blackPal);                 // T6 places, T7 draw, T8 people
}
function renderPalette() {
  const ring = $("sRing");
  for (const el of [...ring.querySelectorAll(":scope > .pal")]) el.remove();
  paletteCells().forEach((el, k) => {
    const [r, c] = SEATS[k];
    el.classList.add("pal");
    el.dataset.seat = r + "," + c;
    el.style.gridRow = String(r);
    el.style.gridColumn = String(c);
    ring.appendChild(el);
  });
  markOn();
  refreeze();
}
// The glow: the active mode (T6 adds the current place, T7 the current crayon).
function markOn() {
  for (const el of document.querySelectorAll("#modeRow .mode")) el.classList.toggle("on", el.dataset.mode === S.mode);
}
// Which parts of her picture are dwell targets right now (T7: the picture itself in Draw mode;
// T9: the item hit boxes). Stickers mode in this task: none — v1's inert picture.
function applyTargets() { refreeze(); }
// End whatever her gaze is in the middle of before another control acts (T7: a live stroke ends;
// T9: a carried item goes back). Nothing is live yet in this task.
function settle() {}
```

`paintScene()` becomes `function paintScene() { SC.renderScene($("art"), S.scene, { table: S.table }); }`.

`route()`:

```js
async function route() {
  const m = ROUTE_RE.exec(location.hash || "");
  let id = null;
  try { id = m ? decodeURIComponent(m[1]) : null; } catch {}
  // test-only (spec 2026-10-02 §9): invariants and the suites open a mode directly; a device never does
  if (m && m[2] && window.__testHooks && MODES.includes(m[2])) S.mode = m[2];
  if (id && ID_RE.test(id)) await openRing(id); else await openShelf();
}
```

In `openRing` make `settle();` the first line (whatever her gaze was doing on the previous picture ends there), and replace `show("ring"); paintScene();` with:

```js
  S.scene.backdrop = S.scene.backdrop || "meadow";
  S.scene.crayon = S.scene.crayon || S.table.crayonDefault || "#0F7C8A";
  show("ring");
  renderPalette();
  paintScene();
  applyTargets();
```
(the defaults are not a change: no `changed()`). In `freeze()` make the first line `settle();`. In `boot()` replace `buildTiles();` with `S.mode = readMode(); loadStickers(); buildModes();`, and make the preload list `S.table.stickers.map((s) => s.word).concat((S.table.modes || []).map((m) => m.word), ["Undo", "No people yet"])`. Add `setMode, settle,` to `window.Drawing` and `mode: S.mode,` to `state()`.

- [ ] **Step 6: Run them — they pass**

Run: `node --test tests/drawing-ui.test.mjs` → `# pass 38`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add public/drawing/index.html public/drawing/drawing.css public/drawing/drawing.js tests/drawing-ui.test.mjs
git commit -m "drawing: row 5 is the mode row — Draw, People, the rest tile, Stickers, Places in five equal cells; the active mode glows teal, speaks on a switch, is remembered; the side columns become the mode's palette in fixed seats (spec 2026-10-02 §1, §8)"
```

---

### Task 6: Places — eight backdrops in the side columns; a dwell swaps her picture's place, Undo brings it back

**Files:**
- Modify: `public/drawing/drawing.js` (`placeCells`, `pickPlace`, `markOn`, `undo`, `place` uses the horizon)
- Modify: `public/drawing/drawing.css` (`.place` tiles)
- Test: `tests/drawing-ui.test.mjs`

**Interfaces:**
- Consumes: T2 `window.DrawingBackdrops.backdropSvg`, `SC.horizonOf`; T5 `renderPalette`, `markOn`, `settle`.
- Produces: palette cells `#place-<id>` (`.place`, `data-place`); history event `{ t: "backdrop", from }`; `state().backdrop`.

- [ ] **Step 1: Write the failing tests** (append to `tests/drawing-ui.test.mjs`):

```js
// ================================================================ v2 T6 — Places
test("Places: a dwell swaps the picture's place and speaks it, every item stays put, the place glows, Undo brings the old one back", async () => {
  const { ctx, page, id } = await openRing();
  await page.locator("#tile-horse").click();
  await page.locator("#mode-places").click();
  const pal = await paletteOf(page);
  assert.deepEqual(pal.map((c) => c.id), ["place-meadow", "place-beach", "place-night", "place-snow",
    "place-sunset", "place-forest", "place-city", "place-rainbow"]);
  assert.deepEqual(pal.map((c) => c.word), ["Meadow", "Beach", "Night", "Snow", "Sunset", "Forest", "City", "Rainbow"]);
  assert.deepEqual(pal.filter((c) => c.on).map((c) => c.id), ["place-meadow"]);
  assert.equal(await page.locator('#place-night svg.backdrop[data-backdrop="night"]').count(), 1, "each tile shows its place");
  const horse = (await st(page)).items[0];
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.ok() && r.request().postData().includes('"backdrop":"night"'));
  await page.locator("#place-night").click();
  let s = await st(page);
  assert.deepEqual([s.backdrop, s.said.at(-1), s.items[0]], ["night", "Night", horse], "the horse stays exactly where it was");
  assert.equal(await page.locator('#scene svg.backdrop[data-backdrop="night"]').count(), 1);
  assert.deepEqual((await paletteOf(page)).filter((c) => c.on).map((c) => c.id), ["place-night"]);
  await saved;
  assert.equal((await hubScene(id)).backdrop, "night");
  const n = s.history;
  await page.locator("#place-night").click();
  s = await st(page);
  assert.deepEqual([s.history, s.said.at(-1)], [n, "Night"], "the current place: its word, nothing else");
  await page.locator("#btnUndo").click();
  s = await st(page);
  assert.deepEqual([s.backdrop, s.items.length], ["meadow", 1], "Undo restores the old place and leaves the horse");
  await ctx.close();
});

test("a sticker lands on the current place's ground: slots follow the horizon", async () => {
  const { ctx, page } = await openRing();
  await page.locator("#mode-places").click();
  await page.locator("#place-city").click();
  await page.locator("#mode-stickers").click();
  await page.locator("#tile-horse").click();
  await page.locator("#tile-sun").click();
  const [h, s] = (await st(page)).items;
  assert.ok(Math.abs(h.y - 0.8467) < 1e-9, JSON.stringify(h));
  assert.ok(Math.abs(s.y - 0.211) < 1e-9, JSON.stringify(s));
  await ctx.close();
});

test("the shelf shows each picture on its own place", async () => {
  seedShelf(0);
  const id = "2026-10-02-110000-test-dev";
  seed(id, [H()], "2026-10-02T11:00:00Z", { backdrop: "snow" });
  const { ctx, page } = await makePage();
  assert.equal(await page.locator(`#shelfGrid [data-id="${id}"] svg.backdrop[data-backdrop="snow"]`).count(), 1);
  await ctx.close();
});
```

- [ ] **Step 2: Run them — they fail** (`node --test --test-name-pattern="place|Places" tests/drawing-ui.test.mjs` → the first two fail: the Places palette is black; the shelf test passes already since T4 — that is fine, it pins the behaviour).

- [ ] **Step 3: Implement.** In `drawing.js`:

```js
// ---------- Places (spec 2026-10-02 §5) ----------
function placeCells() {
  return S.table.backdrops.map((b) => {
    const el = document.createElement("button");
    el.type = "button";
    el.id = "place-" + b.id;
    el.className = "cell place photo dwell";
    el.dataset.place = b.id;
    el.setAttribute("aria-label", b.word);
    const pic = document.createElement("span");
    pic.className = "pic";
    pic.appendChild(window.DrawingBackdrops.backdropSvg(b.id));      // backdrops.js's one painter
    const word = document.createElement("span");
    word.className = "word plate";
    word.textContent = b.word;
    el.append(pic, word);
    el.addEventListener("click", () => pickPlace(b.id));
    return el;
  });
}
// A dwell swaps her picture's place and keeps every item where it is (a horse in the sea is hers to
// move). Undo restores the previous place. The current place: its word, nothing else.
function pickPlace(id) {
  if (S.screen !== "ring" || !S.scene || S.paused) return;
  settle();
  const b = S.table.backdrops.find((x) => x.id === id);
  if (!b) return;
  hush();
  say(b.word);
  if ((S.scene.backdrop || "meadow") === id) return;
  push({ t: "backdrop", from: S.scene.backdrop || "meadow" });
  S.scene.backdrop = id;
  paintScene();
  markOn();
  changed();
  log("backdrop", { id });
}
```
In `paletteCells()` add `if (S.mode === "places") return placeCells();`. In `markOn()` add `for (const el of document.querySelectorAll("#sRing > .place")) el.classList.toggle("on", !!S.scene && el.dataset.place === (S.scene.backdrop || "meadow"));`. In `undo()` add the branch `else if (ev.t === "backdrop") { S.scene.backdrop = ev.from; markOn(); }`. In `place()` pass the place's horizon: `const spot = SC.landing(id, S.scene.items, S.table, Math.random, SC.horizonOf(S.scene.backdrop));`. Add `backdrop: S.scene ? S.scene.backdrop || "meadow" : null,` to `state()`. Add the eight place words to the preload list.

In `drawing.css`:

```css
.place .pic{display:flex; align-items:center; justify-content:center; padding:8px 8px 0}
.place .pic svg{width:100%; height:100%; display:block; border-radius:10px}
```

- [ ] **Step 4: Run them — they pass:** `node --test tests/drawing-ui.test.mjs` → `# pass 41`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add public/drawing/drawing.js public/drawing/drawing.css tests/drawing-ui.test.mjs
git commit -m "drawing: Places — eight backdrops in fixed seats; a dwell swaps her picture's place and keeps every item put, Undo brings the old place back, stickers land on the new place's ground (spec 2026-10-02 §5)"
```

---
### Task 7: Draw — eight crayons; her gaze traces a line between two dwells; no ink without a live stroke

**Files:**
- Modify: `public/drawing/drawing.js` (crayons, gaze tracking, the landing spot, the stroke state machine, `settle`, `applyTargets`)
- Modify: `public/drawing/drawing.css` (crayon tiles, the spot)
- Test: `tests/drawing-ui.test.mjs`

**Interfaces:**
- Consumes: T3 `SC.PEN`, `penStart/penMove/penEnd/penRoom`, `strokePath`, `strokeSvg`; T5 `renderPalette`, `markOn`, `applyTargets`, `settle`, `#pen`.
- Produces (drawing.js): `floorPx()`, `toScene(cx, cy) → {x, y, inside}`, `onPointer(e)` (document `pointermove`/`pointerdown`, capture), `placeSpot(cx, cy)`, `removeSpot()`, `followSpot(cx, cy)`, `land(at)`, `startStroke(p)`, `penFollow()`, `endStroke(landing | null)`, `restWatch()`, `stopRestWatch()`, `onSceneClick()`; palette cells `#crayon-<id>` (`.crayon`, `data-hex`); `state().pen`, `state().crayon`. T9 extends `onPointer`, `land`, `settle`, `applyTargets`. Test helpers: `slowDwell(page)`, `scenePt(page, fx, fy)`, `pngPixels(page, [[x,y]…])`, `drawLine(page, x0, x1, y = 0.4, steps = 20)`.

- [ ] **Step 1: Write the failing tests** (append to `tests/drawing-ui.test.mjs`):

```js
// ================================================================ v2 T7 — Draw
// The suites click for her dwell (dwell.js fires el.click()); a 30 s dwell keeps dwell.js itself from
// firing while the mouse rests between steps. The "real dwell" tests set a short one instead.
const slowDwell = (page) => page.evaluate(() => window.Dwell.setMs(30000));
async function scenePt(page, fx, fy) { const b = await page.locator("#scene").boundingBox(); return { x: b.x + fx * b.width, y: b.y + fy * b.height }; }
async function pngPixels(page, pts) {
  return page.evaluate(async (pts) => {
    const bmp = await createImageBitmap(await window.Drawing.exportPng());
    const c = document.createElement("canvas"); c.width = 1600; c.height = 900;
    const g = c.getContext("2d"); g.drawImage(bmp, 0, 0);
    return pts.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)]);
  }, pts);
}
async function drawLine(page, x0, x1, y = 0.4, steps = 20) {      // her dwell on the picture, then her gaze moving
  const a = await scenePt(page, x0, y), b = await scenePt(page, x1, y);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y, { steps });
}

test("Draw: eight crayons in fixed seats, round swatches, Blue first; a dwell picks one, says it, glows, and the picture keeps it", async () => {
  const { ctx, page, id } = await openRing();
  await page.locator("#mode-draw").click();
  const pal = await paletteOf(page);
  assert.deepEqual(pal.map((c) => c.id), ["crayon-black", "crayon-blue", "crayon-green", "crayon-yellow",
    "crayon-red-orange", "crayon-purple", "crayon-pink", "crayon-white"]);
  assert.deepEqual(pal.map((c) => c.word), ["Black", "Blue", "Green", "Yellow", "Red-orange", "Purple", "Pink", "White"]);
  assert.deepEqual(pal.filter((c) => c.on).map((c) => c.id), ["crayon-blue"]);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#sRing > .crayon .swatch")].map((e) => getComputedStyle(e).backgroundColor)),
    ["rgb(27, 27, 27)", "rgb(15, 124, 138)", "rgb(46, 125, 91)", "rgb(183, 130, 43)", "rgb(222, 123, 82)", "rgb(106, 79, 179)",
     "rgb(217, 111, 166)", "rgb(247, 247, 247)"]);
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.ok() && r.request().postData().includes('"crayon":"#d96fa6"'));
  await page.locator("#crayon-pink").click();
  const s = await st(page);
  assert.deepEqual([s.crayon, s.said.at(-1)], ["#d96fa6", "Pink"]);
  assert.deepEqual((await paletteOf(page)).filter((c) => c.on).map((c) => c.id), ["crayon-pink"]);
  await saved;
  assert.equal((await hubScene(id)).crayon, "#d96fa6");
  await ctx.close();
});

test("Draw: a dwell on the picture starts a stroke (silently), her gaze draws it, a dwell on the spot ends it there", async () => {
  const { ctx, page, id } = await openRing();
  await slowDwell(page);
  await page.locator("#mode-draw").click();
  assert.equal(await page.evaluate(() => document.getElementById("scene").matches(".dwell")), true, "in Draw mode the picture is her target");
  const said = (await st(page)).said.length;
  const a = await scenePt(page, 0.2, 0.5);
  await page.mouse.click(a.x, a.y);
  let s = await st(page);
  assert.deepEqual([s.pen && s.pen.n, s.said.length], [1, said], "a stroke is live; nothing was said");
  assert.equal(await page.evaluate(() => document.getElementById("scene").matches(".dwell")), false);
  assert.equal(await page.locator("#scene > #spot.dwell").count(), 1, "the landing spot is the target now");
  const b = await scenePt(page, 0.7, 0.5);
  await page.mouse.move(b.x, b.y, { steps: 40 });
  s = await st(page);
  assert.ok(s.pen.n > 10, "points follow her gaze: " + s.pen.n);
  assert.equal(await page.locator("#pen svg path").count(), 1, "drawn live");
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.ok() && r.request().postData().includes('"stroke"'));
  await page.locator("#spot").click();
  s = await st(page);
  assert.equal(s.pen, null);
  const k = s.items[0];
  assert.deepEqual([s.items.length, k.s, k.c, k.w, k.by], [1, "stroke", "#0F7C8A", 0.014, "ellie"]);
  assert.deepEqual(k.pts[0], [0.2, 0.5]);
  assert.ok(Math.abs(k.pts.at(-1)[0] - 0.7) < 0.04 && Math.abs(k.pts.at(-1)[1] - 0.5) < 0.07, "it ends at the dwell dot: " + k.pts.at(-1));
  for (let i = 1; i < k.pts.length; i++)
    assert.ok(Math.hypot(k.pts[i][0] - k.pts[i - 1][0], (k.pts[i][1] - k.pts[i - 1][1]) * 9 / 16) >= 0.005, "spaced " + i);
  assert.equal(await page.locator("#art svg.item.stroke").count(), 1, "the stroke is in her picture");
  assert.deepEqual([await page.locator("#scene > #spot").count(), await page.locator("#pen *").count()], [0, 0]);
  assert.equal(await page.evaluate(() => document.getElementById("scene").matches(".dwell")), true, "ready for the next stroke");
  await saved;
  assert.equal((await hubScene(id)).items[0].s, "stroke");
  await ctx.close();
});

test("no ink without a live stroke: looking around in Draw mode lays nothing; in the other modes the picture is never a target", async () => {
  const { ctx, page } = await openRing();
  await slowDwell(page);
  await page.locator("#mode-draw").click();
  for (const [x, y] of [[0.1, 0.1], [0.9, 0.9], [0.5, 0.5]]) { const p = await scenePt(page, x, y); await page.mouse.move(p.x, p.y, { steps: 10 }); }
  await page.mouse.move(5, 500, { steps: 10 });
  const s = await st(page);
  assert.deepEqual([s.pen, s.items.length, await page.locator("#pen *").count()], [null, 0, 0]);
  for (const m of ["stickers", "places", "people"]) {
    await page.locator("#mode-" + m).click();
    assert.equal(await page.evaluate(() => document.getElementById("scene").matches(".dwell")), false, m);
    const p = await scenePt(page, 0.5, 0.5);
    await page.mouse.click(p.x, p.y);
    assert.equal((await st(page)).pen, null, m + ": no stroke");
  }
  await ctx.close();
});

test("a stroke ends when her gaze leaves the picture for grace + 600 ms, and on any other dwell — which then acts", async () => {
  const { ctx, page } = await openRing();
  await slowDwell(page);
  await page.locator("#mode-draw").click();
  await drawLine(page, 0.1, 0.3);
  await page.mouse.move(5, 300);                                    // off the picture
  await page.waitForTimeout(700);
  assert.notEqual((await st(page)).pen, null, "still live inside the grace");
  await page.waitForTimeout(600);
  let s = await st(page);
  assert.deepEqual([s.pen, s.items.length], [null, 1], "ended after graceMs (400) + 600 ms");
  await drawLine(page, 0.4, 0.6);
  await page.locator("#crayon-green").click();
  s = await st(page);
  assert.deepEqual([s.pen, s.items.length, s.items[1].c, s.crayon, s.said.at(-1)], [null, 2, "#0F7C8A", "#2E7D5B", "Green"],
    "the stroke kept its colour; then the crayon switched");
  await drawLine(page, 0.2, 0.8);
  await page.locator("#mode-stickers").click();
  s = await st(page);
  assert.deepEqual([s.pen, s.items.length, s.items[2].c, s.mode], [null, 3, "#2E7D5B", "stickers"]);
  await page.locator("#mode-draw").click();
  await drawLine(page, 0.3, 0.5);
  await page.locator("#btnUndo").click();
  s = await st(page);
  assert.deepEqual([s.pen, s.items.length, s.said.at(-1)], [null, 3, "Undo"], "Undo mid-stroke: it ends, then Undo takes it away");
  await ctx.close();
});

test("a glance off the picture shorter than the grace keeps the stroke; a crayon dwell ends it, then switches (Review Focus 1)", async () => {
  const { ctx, page } = await openRing();
  await slowDwell(page);
  await page.locator("#mode-draw").click();
  await drawLine(page, 0.1, 0.4);
  const n = (await st(page)).pen.n;
  const pink = await centreOf(page, "#crayon-pink");
  await page.mouse.move(pink.x, pink.y, { steps: 4 });               // a glance at Pink…
  await page.waitForTimeout(500);
  const back = await scenePt(page, 0.6, 0.4);
  await page.mouse.move(back.x, back.y, { steps: 10 });              // …and back to her line
  let s = await st(page);
  assert.ok(s.pen && s.pen.n > n, "the same stroke goes on: " + JSON.stringify(s.pen));
  assert.equal(s.items.length, 0, "nothing committed, nothing lost");
  await page.locator("#crayon-pink").click();
  s = await st(page);
  assert.deepEqual([s.pen, s.items.length, s.items[0].c, s.crayon], [null, 1, "#0F7C8A", "#d96fa6"]);
  await ctx.close();
});

test("Undo takes the last stroke away; Clear takes ink too; a stroke drawn after a sticker lies on top; a finger never drags ink", async () => {
  const { ctx, page } = await openRing();
  await slowDwell(page);
  await page.locator("#tile-horse").click();
  await page.locator("#mode-draw").click();
  await drawLine(page, 0.1, 0.9, 0.82);                              // across the horse
  await page.locator("#spot").click();
  const s = await st(page);
  assert.deepEqual(s.items.map((i) => i.s), ["horse", "stroke"]);
  assert.equal(await page.evaluate(() => document.getElementById("art").lastElementChild.matches("svg.item.stroke")), true, "on top");
  await page.locator("#mode-stickers").click();
  const ink = await scenePt(page, 0.3, 0.82);                        // on the ink, off the horse
  await finger(page, ink, { x: ink.x + 100, y: ink.y - 100 });
  assert.deepEqual((await st(page)).items[1].pts, s.items[1].pts, "ink never moves under a finger");
  await page.locator("#btnUndo").click();
  assert.deepEqual((await st(page)).items.map((i) => i.s), ["horse"]);
  await page.locator("#mode-draw").click();
  await drawLine(page, 0.2, 0.6);
  await page.locator("#spot").click();
  await page.locator("#partnerTab").click();
  await page.locator("#pClear").click();
  await page.locator("#pClearYes").click();
  assert.deepEqual((await st(page)).items, []);
  await ctx.close();
});

test("the PNG has her stroke in its crayon, 1.4% of the height thick", async () => {
  const id = "2026-10-02-120000-test-dev";
  seed(id, [{ s: "stroke", c: "#6a4fb3", w: 0.014, pts: [[0.2, 0.5], [0.8, 0.5]], by: "ellie" }], "2026-10-02T12:00:00Z");
  const { ctx, page } = await openRing({ id });
  const [on, off] = await pngPixels(page, [[800, 450], [800, 470]]);
  assert.ok(close(on, [106, 79, 179], 6), "the line is purple: " + on);
  assert.ok(!close(off, [106, 79, 179], 40), "and only ~13 px thick: " + off);
  await ctx.close();
});

test("ink budget: a nearly full picture refuses a new stroke and never sends a body over the cap (Review Focus 4)", async () => {
  const id = "2026-10-02-130000-test-dev";
  const pts = Array.from({ length: 400 }, (_, k) => [0.123, +(0.1 + k / 1000).toFixed(3)]);
  seed(id, Array(44).fill({ s: "stroke", c: "#0F7C8A", w: 0.014, pts, by: "ellie" }), "2026-10-02T13:00:00Z");   // ≈ 242 KB
  const { ctx, page } = await openRing({ id });
  await slowDwell(page);
  const bodies = [];
  page.on("request", (r) => { if (r.method() === "PUT") bodies.push(r.postData().length); });
  await page.locator("#mode-draw").click();
  const a = await scenePt(page, 0.5, 0.8);
  await page.mouse.click(a.x, a.y);
  assert.equal((await st(page)).pen, null, "no room: no stroke, nothing said");
  await page.locator("#crayon-pink").click();                       // a change she can still make
  await page.waitForTimeout(1200);
  assert.ok(bodies.length >= 1 && bodies.every((n) => n < 256 * 1024), JSON.stringify(bodies));
  await ctx.close();
});

test("with her real dwell: rest on the picture to start, keep moving to draw (never an end), rest to finish", async () => {
  const { ctx, page } = await openRing();
  await page.locator("#mode-draw").click();
  await page.evaluate(() => window.Dwell.setMs(800));
  const a = await scenePt(page, 0.25, 0.45);
  await page.mouse.move(a.x, a.y, { steps: 5 });
  await page.waitForFunction(() => window.Drawing.state().pen, null, { timeout: 4000 });
  for (let k = 1; k <= 30; k++) {                                    // ~1.5 s of steady movement
    const p = await scenePt(page, 0.25 + k * 0.015, 0.45 + Math.sin(k / 3) * 0.05);
    await page.mouse.move(p.x, p.y, { steps: 2 });
    await page.waitForTimeout(50);
  }
  assert.notEqual((await st(page)).pen, null, "moving is drawing, never a landing");
  await page.waitForFunction(() => !window.Drawing.state().pen, null, { timeout: 4000 });   // she rests: the spot fills
  const s = await st(page);
  assert.deepEqual([s.items.length, s.items[0].s], [1, "stroke"]);
  assert.ok(s.items[0].pts.length > 10, String(s.items[0].pts.length));
  await ctx.close();
});
```

- [ ] **Step 2: Run them — they fail** (`node --test --test-name-pattern="Draw|stroke|ink|crayon" tests/drawing-ui.test.mjs` → every new test fails: the Draw palette is black, `#scene` never becomes `.dwell`).

- [ ] **Step 3: Implement in `drawing.js`.**

Crayons:

```js
// ---------- Draw (spec 2026-10-02 §3) ----------
function crayonCells() {
  return S.table.crayons.map((cr) => {
    const el = document.createElement("button");
    el.type = "button";
    el.id = "crayon-" + cr.id;
    el.className = "cell crayon photo dwell";
    el.dataset.hex = cr.hex;
    el.setAttribute("aria-label", cr.word);
    const pic = document.createElement("span");
    pic.className = "pic";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.setProperty("--sw", cr.hex);
    pic.appendChild(sw);
    const word = document.createElement("span");
    word.className = "word plate";
    word.textContent = cr.word;
    el.append(pic, word);
    el.addEventListener("click", () => pickCrayon(cr));
    return el;
  });
}
// A dwell picks the crayon for her next line, says its word and glows; the picture remembers it.
function pickCrayon(cr) {
  if (S.screen !== "ring" || !S.scene || S.paused) return;
  settle();
  hush();
  say(cr.word);
  if ((S.scene.crayon || "").toLowerCase() === cr.hex.toLowerCase()) return;
  S.scene.crayon = cr.hex;
  markOn();
  changed();
  log("crayon", { id: cr.id });
}
```
In `paletteCells()` add `if (S.mode === "draw") return crayonCells();`; in `markOn()` add `for (const el of document.querySelectorAll("#sRing > .crayon")) el.classList.toggle("on", !!S.scene && el.dataset.hex.toLowerCase() === (S.scene.crayon || "").toLowerCase());`.

Her gaze, the spot, the stroke:

```js
// ---------- her gaze (spec 2026-10-02 §3, §6) ----------
// dwell.js keeps the gaze point to itself (dwell.js:380-384), so the page follows the pointer too.
// ERAgaze moves the OS cursor — a "mouse" pointer. A finger is "touch": its taps land (touch
// parity), its moves never ink (deviation 17).
const LEAVE_EXTRA_MS = 600;
const floorPx = () => Math.ceil(90 * innerWidth / 1920) + 1;     // above invariants' 90 x vw/1920 at every width
const leaveMs = () => ((window.Dwell && Dwell.config.graceMs) || 400) + LEAVE_EXTRA_MS;
const restMs = () => (window.Dwell ? Dwell.config.ms : EC.holds.content);
function toScene(cx, cy) {
  const r = $("scene").getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (cx - r.left) / r.width)), y: Math.min(1, Math.max(0, (cy - r.top) / r.height)),
           inside: cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom };
}
function onPointer(e) {
  S.gaze = { cx: e.clientX, cy: e.clientY, type: e.pointerType || "mouse" };
  if (e.type !== "pointermove" || e.pointerType === "touch") return;
  if (S.pen) { penFollow(); if (S.pen) restWatch(); }
}
// THE LANDING SPOT (deviation 1): a fresh element whenever her gaze leaves its square, so dwell.js
// starts a new dwell (dwell.js:259) — only a real REST fills it. Its centre is where the line ends.
function placeSpot(cx, cy) {
  const r = $("scene").getBoundingClientRect(), F = floorPx();
  const x = Math.min(r.width - F / 2, Math.max(F / 2, cx - r.left)), y = Math.min(r.height - F / 2, Math.max(F / 2, cy - r.top));
  removeSpot();
  const el = document.createElement("div");
  el.id = "spot";
  el.className = "spot dwell";
  el.setAttribute("aria-label", "Here");
  Object.assign(el.style, { left: x - F / 2 + "px", top: y - F / 2 + "px", width: F + "px", height: F + "px" });
  const at = { x: x / r.width, y: y / r.height };
  el.addEventListener("click", (e) => { e.stopPropagation(); land(at); });
  $("scene").appendChild(el);
  S.spot = { cx: r.left + x, cy: r.top + y, F };
  refreeze();
}
function removeSpot() { const s = $("spot"); if (s) s.remove(); S.spot = null; }
function followSpot(cx, cy) {
  const s = S.spot;
  if (!s || Math.abs(cx - s.cx) > s.F / 2 || Math.abs(cy - s.cy) > s.F / 2) placeSpot(cx, cy);
}
function land(at) { if (S.pen) endStroke(at); }
// The rest tile is inert (no .dwell, ever): resting on it is watched here, for her dwell (deviation 5).
function restWatch() {
  const r = $("restTile").getBoundingClientRect(), g = S.gaze;
  if (!(g.cx >= r.left && g.cx <= r.right && g.cy >= r.top && g.cy <= r.bottom)) { stopRestWatch(); return; }
  if (!S.restTimer) S.restTimer = setTimeout(() => { S.restTimer = null; log("rest", {}); settle(); }, restMs());
}
function stopRestWatch() { clearTimeout(S.restTimer); S.restTimer = null; }

// A dwell (or a tap) on her picture. Draw idle: a stroke starts where she looks. While a stroke is
// live or something is carried, only a FINGER tap lands here — her own landing is the spot.
function onSceneClick() {
  if (Date.now() < S.swallowUntil || !S.gaze || S.screen !== "ring" || !S.scene) return;
  const p = toScene(S.gaze.cx, S.gaze.cy);
  if (!p.inside) return;
  if (S.pen || S.carry) { if (S.gaze.type === "touch") land(p); return; }
  if (S.mode === "draw") startStroke(p);
}
function startStroke(p) {
  if (S.paused || S.scene.items.length >= MAX_ITEMS) return;
  const room = SC.penRoom(JSON.stringify(S.scene).length);
  if (room < 2) { log("ink_full", {}); return; }                  // deviation 11: silent, like the 200 cap
  hush();
  S.pen = SC.penStart(p.x, p.y, room);
  S.pen.c = S.scene.crayon || S.table.crayonDefault;
  drawPen();
  applyTargets();
  placeSpot(S.gaze.cx, S.gaze.cy);
  log("stroke_start", {});
}
function drawPen() {
  const box = $("pen");
  if (!S.pen) { box.replaceChildren(); return; }
  const pts = S.pen.pts.length > 1 ? S.pen.pts : S.pen.pts.concat(S.pen.pts);      // a dot until she moves
  box.replaceChildren(SC.strokeSvg(SC.strokePath(pts), S.pen.c, SC.PEN.width));
}
function penFollow() {
  const g = S.gaze, p = toScene(g.cx, g.cy);
  if (!p.inside) {
    removeSpot();
    if (!S.leaveTimer) S.leaveTimer = setTimeout(() => { S.leaveTimer = null; endStroke(null); }, leaveMs());
    return;
  }
  clearTimeout(S.leaveTimer); S.leaveTimer = null;
  if (SC.penMove(S.pen, p.x, p.y)) drawPen();
  if (S.pen.pts.length >= S.pen.room) { endStroke(null); return; }   // 400 points (or the ink budget)
  followSpot(g.cx, g.cy);
}
// One stroke = one item = one Undo. Fewer than two points is not a line: dropped silently.
function endStroke(landing) {
  if (!S.pen) return;
  clearTimeout(S.leaveTimer); S.leaveTimer = null;
  stopRestWatch();
  const pen = S.pen;
  S.pen = null;
  const pts = SC.penEnd(pen, landing);
  drawPen();
  removeSpot();
  if (pts.length >= 2) {
    S.scene.items.push({ s: "stroke", c: pen.c, w: SC.PEN.width, pts, by: "ellie" });
    push({ t: "place" });
    paintScene();
    changed();
    log("stroke", { n: pts.length });
  }
  applyTargets();
}
```

Replace T5's `applyTargets` and `settle` with:

```js
// In Draw mode, idle, her picture itself is the dwell target (spec §3). Never while a stroke is live
// (the spot is) and never in the other modes.
function applyTargets() {
  const sc = $("scene");
  const want = S.screen === "ring" && !!S.scene && S.mode === "draw" && !S.pen && !S.carry;
  if (!want) { sc.classList.remove("dwell"); sc.removeAttribute("data-dwell-disabled"); frozen = frozen.filter((el) => el !== sc); }
  else if (!sc.hasAttribute("data-dwell-disabled")) sc.classList.add("dwell");
  refreeze();
}
function settle() { if (S.pen) endStroke(null); }
```

Make `settle();` the first statement of `place()`, `undo()`, `onLeave()`, `onPause()` and `openShelf()`, and the statement right after the guard in `done()` (`if (S.screen !== "ring" || !S.scene || S.finishing) return; settle();`). Change the `pagehide` listener to `() => { settle(); save({ keepalive: true }); }`. In `openShelf()`, right after `show("shelf");`, call `applyTargets();` (the hidden ring must not keep live targets: from T9 this also clears the hit boxes). In `boot()` add, before `await route()`:

```js
  document.addEventListener("pointermove", onPointer, true);
  document.addEventListener("pointerdown", onPointer, true);
  $("scene").addEventListener("click", onSceneClick);
```
and make the resize listener also `if (S.spot && S.gaze) placeSpot(S.gaze.cx, S.gaze.cy);`. Add to `state()`: `crayon: S.scene ? S.scene.crayon || null : null, pen: S.pen ? { n: S.pen.pts.length, c: S.pen.c } : null,`. Add the crayon words to the preload list.

In `drawing.css`:

```css
.crayon .pic{display:flex; align-items:center; justify-content:center; padding:10px 8px 0}
.crayon .swatch{display:block; height:100%; aspect-ratio:1; max-width:100%; border-radius:50%;
                background:var(--sw); border:3px solid #C9D3D6}            /* White shows on the white tile */
/* the landing spot: id-qualified, because dwell.js's injected .dwell{position:relative} comes later */
#scene > .spot{position:absolute; z-index:6; border-radius:50%; border:4px solid var(--teal);
               background:rgba(15, 124, 138, .14); box-sizing:border-box}
```

- [ ] **Step 4: Run them — they pass:** `node --test tests/drawing-ui.test.mjs` → `# pass 50`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add public/drawing/drawing.js public/drawing/drawing.css tests/drawing-ui.test.mjs
git commit -m "drawing: Draw — eight crayons; a dwell on the picture starts a line, her gaze draws it, a rest on the gaze-following spot ends it; leaving, any other dwell or the rest tile ends it too; no ink without a live stroke; an ink budget under the cap (spec 2026-10-02 §3)"
```

---
### Task 8: People — her family from the library, More paging, the empty library, synthetic fixtures

**Files:**
- Modify: `public/drawing/drawing.js` (`loadPeople`, `personTile`, `peopleMoreTile`, `peopleCells`, `place` via `stickerById`)
- Modify: `public/drawing/index.html` (`#pPeople` line in the sheet)
- Modify: `public/drawing/partner.js` (`#pPeople` shown when the library is empty)
- Modify: `public/drawing/drawing.css` (`#peopleMore` colour)
- Test: `tests/drawing-ui.test.mjs`

**Interfaces:**
- Consumes: T3 `SC.withPeople`, `SC.stickerById`; T4 `GET /characters/index.json`, `/characters/<slug>.png`; T5 `renderPalette`, `setMode`'s "No people yet".
- Produces: `S.people = [{slug, word, scale}]`, `S.peoplePage`, `S.peoplePages`; palette cells `#person-<slug>` (`.person`, `data-s="person:<slug>"`), `#peopleMore`; `S.images["person:<slug>"]`; `state().people` (slugs), `state().peoplePage`, `state().peoplePages`. Test helpers: `tinyPng(w, h, rgba)`, `seedPeople(list | null)`, `MAYA`, `SAM`.

- [ ] **Step 1: Write the failing tests.** Add `import zlib from "node:zlib";` to `tests/drawing-ui.test.mjs` and append:

```js
// ================================================================ v2 T8 — People
// Two neutral synthetic people (spec §4: family images never enter this repo), solid colours so the
// PNG test can find them. The hub reads <DATA>/characters — what the Drive mirror would carry in.
function tinyPng(w, h, rgba) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 4).fill(Buffer.from(rgba))]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
const CHARS = path.join(TMP, "characters");
const MAYA = { slug: "maya", word: "Maya", scale: 0.3, rgba: [51, 102, 204, 255] };
const SAM = { slug: "sam", word: "Sam", scale: 0.25, rgba: [138, 90, 43, 255] };
function seedPeople(people) {
  fs.rmSync(CHARS, { recursive: true, force: true });
  if (!people) return;
  fs.mkdirSync(CHARS, { recursive: true });
  for (const p of people) fs.writeFileSync(path.join(CHARS, p.slug + ".png"), tinyPng(64, 128, p.rgba || [51, 102, 204, 255]));
  fs.writeFileSync(path.join(CHARS, "characters.json"),
    JSON.stringify({ v: 1, people: people.map(({ slug, word, scale }) => ({ slug, word, scale })) }));
}

test("People: the library in dad's order, the other seats black; a dwell says the name and they land on the grass", async () => {
  seedPeople([MAYA, SAM]);
  const { ctx, page, id } = await openRing();
  await page.locator("#mode-people").click();
  assert.equal((await st(page)).said.at(-1), "People");
  const pal = await paletteOf(page);
  assert.deepEqual(pal.map((c) => c.id), ["person-maya", "person-sam", null, null, null, null, null, null]);
  assert.deepEqual(pal.slice(2).map((c) => [c.black, c.dwell]), Array(6).fill([true, false]), "empty seats: black and inert");
  assert.deepEqual(pal.slice(0, 2).map((c) => c.word), ["Maya", "Sam"]);
  assert.equal(await page.getAttribute("#person-maya img", "src"), "/characters/maya.png");
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.ok() && r.request().postData().includes("person:sam"));
  await page.locator("#person-maya").click();
  await page.locator("#person-sam").click();
  const s = await st(page);
  assert.deepEqual(s.said.slice(-2), ["Maya", "Sam"]);
  assert.deepEqual(s.items, [{ s: "person:maya", x: 0.5, y: 0.77, w: 0.3, by: "ellie" },
                             { s: "person:sam", x: 0.35, y: 0.755, w: 0.25, by: "ellie" }], "centre-out on the grass, scaled from the library");
  await saved;
  assert.deepEqual((await hubScene(id)).items.map((i) => i.s), ["person:maya", "person:sam"], "the hub took them: they are in the library");
  assert.equal(await page.locator('#art img.item[src="/characters/sam.png"]').count(), 1);
  seedPeople(null);
  await ctx.close();
});

test("People: past eight, seven a page with More in the last seat; More turns the page silently and loops", async () => {
  seedPeople(Array.from({ length: 10 }, (_, k) => ({ slug: "p" + k, word: "P" + k, scale: 0.3 })));
  const { ctx, page } = await openRing();
  await page.locator("#mode-people").click();
  assert.deepEqual((await paletteOf(page)).map((c) => c.id),
    ["person-p0", "person-p1", "person-p2", "person-p3", "person-p4", "person-p5", "person-p6", "peopleMore"]);
  let s = await st(page);
  assert.deepEqual([s.peoplePage, s.peoplePages], [0, 2]);
  const n = s.said.length;
  await page.locator("#peopleMore").click();
  assert.deepEqual((await paletteOf(page)).map((c) => c.id), ["person-p7", "person-p8", "person-p9", null, null, null, null, "peopleMore"]);
  assert.equal((await st(page)).said.length, n, "More is silent (v1's More)");
  await page.locator("#peopleMore").click();
  assert.equal((await st(page)).peoplePage, 0, "More loops back");
  seedPeople(null);
  await ctx.close();
});

test("People with no library: eight black inert seats, \"No people yet\", and the grown-ups' sheet says where to add them", async () => {
  seedPeople(null);
  let { ctx, page } = await openRing();
  await page.locator("#mode-people").click();
  assert.equal((await st(page)).said.at(-1), "No people yet");
  const pal = await paletteOf(page);
  assert.deepEqual([pal.length, pal.every((c) => c.black && !c.dwell)], [8, true]);
  assert.equal(await page.evaluate(() => document.querySelectorAll("#sRing .cell.dwell").length), 6, "4 modes + Undo + Done");
  await page.locator("#partnerTab").click();
  assert.equal(await page.textContent("#pPeople"), "Add people: Drive folder → characters");
  assert.equal(await page.isVisible("#pPeople"), true);
  await ctx.close();
  seedPeople([MAYA]);
  ({ ctx, page } = await openRing());
  await page.locator("#partnerTab").click();
  assert.equal(await page.isVisible("#pPeople"), false, "with a library the line is gone");
  seedPeople(null);
  await ctx.close();
});

test("a person who left the library: drawn as nothing, kept, and the picture still saves (Review Focus 3)", async () => {
  seedPeople([MAYA]);
  const id = "2026-10-02-140000-test-dev";
  seed(id, [{ s: "person:sam", x: 0.35, y: 0.755, w: 0.25, by: "ellie" }], "2026-10-02T14:00:00Z");   // sam is not in this library
  const { ctx, page, errors } = await openRing({ id });
  assert.equal(await page.locator("#art .item").count(), 0, "drawn as nothing — never an error");
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/drawings/${id}/scene.json`));
  await page.locator("#tile-horse").click();
  assert.equal((await saved).status(), 200, "grandfathered by the hub (deviation 8)");
  assert.deepEqual((await hubScene(id)).items.map((i) => i.s), ["person:sam", "horse"], "kept");
  assert.deepEqual(errors, []);
  seedPeople(null);
  await ctx.close();
});

test("Done names her people, and the PNG has them in it", async () => {
  seedPeople([MAYA]);
  const { ctx, page } = await openRing();
  await page.locator("#mode-people").click();
  await page.locator("#person-maya").click();
  await page.locator("#mode-stickers").click();
  await page.locator("#tile-horse").click();
  // Maya: a 270 px box centred at (800, 693) in the PNG; the 1:2 figure fills its height, 135 px wide
  const [px] = await pngPixels(page, [[800, 640]]);
  assert.ok(close(px, MAYA.rgba.slice(0, 3), 6), "Maya is in the PNG: " + px);
  await page.locator("#btnDone").click();
  await page.waitForFunction(() => window.Drawing.state().screen === "shelf");
  assert.ok((await st(page)).said.includes("You made a picture with Maya and a horse!"), JSON.stringify((await st(page)).said));
  seedPeople(null);
  await ctx.close();
});
```

- [ ] **Step 2: Run them — they fail** (`node --test --test-name-pattern="People|person|people" tests/drawing-ui.test.mjs` — the People palette is black; `#pPeople` missing).

- [ ] **Step 3: Implement.** In `drawing.js`:

```js
// ---------- People (spec 2026-10-02 §4) ----------
// The private library the hub serves from the family's Drive folder. No library (Drive off on this
// device, nothing cut out yet): People shows black seats and says so — the picture never errors.
async function loadPeople() {
  try {
    const j = await (await fetch("/characters/index.json", { cache: "no-store" })).json();
    S.people = Array.isArray(j) ? j : [];
  } catch { S.people = []; }
  S.table = SC.withPeople(S.table, S.people);
  for (const p of S.people) {
    const im = new Image();
    im.src = "/characters/" + encodeURIComponent(p.slug) + ".png";
    S.images["person:" + p.slug] = im;                                // for the PNG (same origin: exportable)
  }
}
function personTile(p) {
  const id = "person:" + p.slug, st = SC.stickerById(S.table, id);
  const b = document.createElement("button");
  b.type = "button";
  b.id = "person-" + p.slug;
  b.className = "cell person photo dwell";
  b.dataset.s = id;
  b.setAttribute("aria-label", p.word);
  const pic = document.createElement("img");
  pic.className = "pic"; pic.src = st.src; pic.alt = ""; pic.draggable = false;
  const word = document.createElement("span");
  word.className = "word plate";
  word.textContent = p.word;
  b.append(pic, word);
  b.addEventListener("click", () => place(id, b));
  return b;
}
// The Reader's More rule: past eight people, seven a page and More in the last seat; it loops.
function peopleMoreTile() {
  const b = document.createElement("button");
  b.type = "button";
  b.id = "peopleMore";
  b.className = "cell text dwell";
  b.setAttribute("aria-label", "More people");
  const g = document.createElement("span"); g.className = "glyph"; g.setAttribute("aria-hidden", "true"); g.textContent = "▶";
  const w = document.createElement("span"); w.className = "word"; w.textContent = "More";
  b.append(g, w);
  b.addEventListener("click", () => {
    settle(); hush();
    S.peoplePage = (S.peoplePage + 1) % S.peoplePages;
    renderPalette(); suppress();
    log("people-page", { page: S.peoplePage });
  });
  return b;
}
function peopleCells() {
  const n = S.people.length, seats = SEATS.length;
  S.peoplePages = n > seats ? Math.ceil(n / (seats - 1)) : 1;
  if (S.peoplePage >= S.peoplePages) S.peoplePage = 0;
  const per = S.peoplePages > 1 ? seats - 1 : seats;
  const slice = S.people.slice(S.peoplePage * per, S.peoplePage * per + per);
  const cells = SEATS.map((_, k) => (slice[k] ? personTile(slice[k]) : blackPal()));
  if (S.peoplePages > 1) cells[seats - 1] = peopleMoreTile();
  return cells;
}
```
Add `peoplePage: 0, peoplePages: 1,` to `S`; in `paletteCells()` add `if (S.mode === "people") return peopleCells();`. In `place()` replace `const st = S.stickers.get(id);` with `const st = SC.stickerById(S.table, id);`. In `boot()` add `await loadPeople();` right after `loadStickers();` (before `buildModes()`), and add `S.people.map((p) => p.word)` to the preload list. Add `people: S.people.map((p) => p.slug), peoplePage: S.peoplePage, peoplePages: S.peoplePages,` to `state()`.

`index.html`, in the sheet after `<p class="sheet-say" id="pMail"></p>`: `<p class="sheet-say" id="pPeople" hidden>Add people: Drive folder → characters</p>`.
`partner.js` `paint()`: add `$("pPeople").hidden = !(D.state().screen === "ring" && D.state().people.length === 0);`.
`drawing.css`: change `#btnUndo, #shelfMore{…}` to `#btnUndo, #shelfMore, #peopleMore{…}`.

- [ ] **Step 4: Run them — they pass:** `node --test tests/drawing-ui.test.mjs` → `# pass 55`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add public/drawing/drawing.js public/drawing/index.html public/drawing/partner.js public/drawing/drawing.css tests/drawing-ui.test.mjs
git commit -m "drawing: People — her family from the private library in dad's order, landing on the grass by name and scale, More past eight, black seats and 'No people yet' with no library, a person who left is kept and never an error (spec 2026-10-02 §4)"
```

---
### Task 9: Gaze-move — look at it (lift), carry it with her gaze, rest to drop it; put back; touch wins

**Files:**
- Modify: `public/drawing/scene.js` (`hitBox`)
- Modify: `public/drawing/drawing.js` (`paintHits`, `lift`, `carryFollow`, `drop`, `putBack`, `releaseCarry`, `coolCheck`, `swallowClicks`; `onPointer`, `land`, `settle`, `applyTargets`, `moveItem`, `undo`, `clearPicture` extended; test hooks)
- Modify: `public/drawing/partner.js` (finger drag via `.hit` / the carried item; strokes skipped; click swallow)
- Modify: `public/drawing/drawing.css` (hits, carried)
- Test: `tests/drawing-scene.test.mjs`, `tests/drawing-ui.test.mjs`

**Interfaces:**
- Consumes: T7 `onPointer`, `placeSpot`, `followSpot`, `removeSpot`, `restWatch`, `stopRestWatch`, `toScene`, `floorPx`, `land`, `settle`, `applyTargets`; T3 `SC.PEN.alpha`, `SC.itemWord`, `SC.sceneOps`.
- Produces: `export function hitBox(op, W, H, F) → {left, top, width, height}` (px, relative to the picture); `#hits > .hit.dwell[data-hit]`; `S.carry = {i, sx, sy, x, y}`; `S.cool`; `window.Drawing.releaseCarry() → {i, x, y} | null`, `swallowClicks(ms)`, `state().carrying`, `state().cool`; under `__testHooks`: `window.Drawing.__show(scene)`, `window.Drawing.__lift(i)`. Test constant `SPACED` (drawing-ui): eight stickers and one stroke, every hit box ≥ 100 px from its neighbours at 1920.

- [ ] **Step 1: Write the failing tests.** In `tests/drawing-scene.test.mjs` add `hitBox` to the scene import and append:

```js
// ---- v2 (spec 2026-10-02 §6): hit boxes ------------------------------------------------
test("hit boxes: at least F px, centred on the item, shifted (never shrunk) inside the picture", () => {
  const W = 1359, H = 764, F = 91;
  const one = (it) => sceneOps({ v: 1, items: [{ by: "ellie", ...it }] }, T)[0];
  let b = hitBox(one({ s: "star", x: 0.5, y: 0.5, w: 0.1 }), W, H, F);              // a 76 px star
  assert.deepEqual([b.width, b.height], [F, F]);
  near(b.left + b.width / 2, 0.5 * W, "centred x"); near(b.top + b.height / 2, 0.5 * H, "centred y");
  b = hitBox(one({ s: "house", x: 0.5, y: 0.5, w: 0.26 }), W, H, F);
  near(b.height, 0.26 * H, "a big item's hit box is its own box");
  b = hitBox(one({ s: "star", x: 0.0282, y: 0.05, w: 0.1 }), W, H, F);
  assert.deepEqual([b.left, b.top, b.width, b.height], [0, 0, F, F], "pushed inside, not shrunk");
  b = hitBox(one({ s: "star", x: 0.9718, y: 0.95, w: 0.1 }), W, H, F);
  near(b.left + b.width, W, "right edge"); near(b.top + b.height, H, "bottom edge");
});
```

In `tests/drawing-ui.test.mjs`, in the v1 test "her picture and the rest tile are inert …" replace the `sceneAttrs:` line with

```js
    sceneAttrs: [...document.querySelectorAll("#scene, #art, #art *")].some((n) =>
      n.matches(".dwell") || [...n.attributes].some((a) => a.name.startsWith("data-dwell"))),
    hits: document.querySelectorAll("#hits > .hit.dwell").length,
```
and add `assert.equal(r.hits, 1, "the horse is liftable (spec 2026-10-02 §6); the picture itself is not a target");` after the `sceneAttrs` assertion (rename its message to `"no .dwell on the picture or its art in Stickers mode"`). In the v1 audit test "the contract audit is clean on a full shelf and a full ring …" replace the eight-item `seed(full, [...])` with `seed(full, SPACED, "2026-09-30T15:00:00Z");` (v1's items sat 3–20 px apart; as targets they would break the gap law — the audit is right, the fixture was crowded). Then append:

```js
// ================================================================ v2 T9 — gaze-move
// Eight stickers and a stroke, every hit box >= 100 px from the next at 1920 (>= 70 at 1280).
const SPACED = [
  { s: "house", x: 0.15, y: 0.70, w: 0.26, by: "ellie" }, { s: "horse", x: 0.42, y: 0.80, w: 0.20, by: "ellie" },
  { s: "tree", x: 0.68, y: 0.70, w: 0.28, by: "ellie" }, { s: "person", x: 0.90, y: 0.80, w: 0.22, by: "ellie" },
  { s: "sun", x: 0.12, y: 0.18, w: 0.16, by: "ellie" }, { s: "cloud", x: 0.40, y: 0.18, w: 0.14, by: "ellie" },
  { s: "star", x: 0.62, y: 0.15, w: 0.10, by: "ellie" }, { s: "splat", x: 0.85, y: 0.22, w: 0.15, by: "ellie", c: "#DE7B52", seed: 7 },
  { s: "stroke", c: "#6a4fb3", w: 0.014, pts: [[0.05, 0.45], [0.95, 0.45]], by: "ellie" },
];
const hitsOf = (page) => page.evaluate(() => [...document.querySelectorAll("#hits > .hit.dwell")].map((e) => {
  const r = e.getBoundingClientRect(); return { i: e.dataset.hit, label: e.getAttribute("aria-label"), w: r.width, h: r.height }; }));
async function liftAt(page, i) {
  await page.waitForFunction(() => !document.querySelector(".flyer"));
  await page.locator(`#hits > .hit[data-hit="${i}"]`).click();
}

test("gaze-move targets: a hit box ≥ the floor for every sticker and person in Stickers, People and Places — none in Draw, never ink", async () => {
  const id = "2026-10-02-150000-test-dev";
  seed(id, [{ s: "star", x: 0.3, y: 0.2, w: 0.1, by: "ellie" }, H(),
            { s: "stroke", c: "#0F7C8A", w: 0.014, pts: [[0.1, 0.5], [0.9, 0.5]], by: "ellie" }], "2026-10-02T15:00:00Z");
  const { ctx, page } = await openRing({ id });
  for (const m of ["stickers", "people", "places"]) {
    if (m !== "stickers") await page.locator("#mode-" + m).click();
    const h = await hitsOf(page);
    assert.deepEqual(h.map((x) => [x.i, x.label]), [["0", "Star"], ["1", "Horse"]], m + ": ink is never a target");
    for (const x of h) assert.ok(Math.min(x.w, x.h) >= 90, `${m} ${x.label} ${x.w}x${x.h}`);
    assert.equal(await page.evaluate(() => document.getElementById("scene").matches(".dwell")), false, m);
  }
  await page.locator("#mode-draw").click();
  assert.deepEqual(await hitsOf(page), [], "Draw mode: items are not targets");
  await ctx.close();
});

test("lift → carry → drop: a dwell lifts it (its word), her gaze carries it, a rest on the spot drops it there; Undo puts it back", async () => {
  const { ctx, page } = await openRing();
  await slowDwell(page);
  await page.locator("#tile-horse").click();
  await liftAt(page, 0);
  let s = await st(page);
  assert.deepEqual([s.carrying, s.said.at(-1)], [0, "Horse"]);
  assert.equal(await page.locator('#art [data-i="0"].carried').count(), 1, "lifted: bigger, with a soft shadow");
  assert.deepEqual([await page.locator("#hits > .hit").count(), await page.locator("#scene > #spot.dwell").count()], [0, 1],
    "one thing at a time: the spot is the only target on the picture");
  const to = await scenePt(page, 0.25, 0.3);
  await page.mouse.move(to.x, to.y, { steps: 15 });
  const art = await page.evaluate(() => { const el = document.querySelector('#art [data-i="0"]'); return [parseFloat(el.style.left), parseFloat(el.style.top)]; });
  assert.ok(art[0] < 30 && art[1] < 30, "the horse follows her gaze (left/top %): " + art);
  assert.deepEqual(s.items[0], { s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" });
  assert.deepEqual((await st(page)).items[0], s.items[0], "nothing is stored while she carries it");
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.ok());
  await page.locator("#spot").click();
  s = await st(page);
  assert.equal(s.carrying, null);
  assert.ok(Math.abs(s.items[0].x - 0.25) < 0.04 && Math.abs(s.items[0].y - 0.3) < 0.07, JSON.stringify(s.items[0]));
  assert.deepEqual([s.items[0].by, s.history], ["ellie", 2], "one move in her history");
  await saved;
  await page.locator("#btnUndo").click();
  assert.deepEqual((await st(page)).items[0], { s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" });
  await ctx.close();
});

test("put it back: the rest tile, a mode tile, Undo and Done each drop it where it was — then act as usual", async () => {
  const { ctx, page } = await openRing();
  await slowDwell(page);
  await page.locator("#tile-horse").click();
  await page.locator("#tile-sun").click();
  const home = (await st(page)).items;
  const liftAway = async (i) => {
    await liftAt(page, i);
    const p = await scenePt(page, 0.15, 0.5);
    await page.mouse.move(p.x, p.y, { steps: 10 });
  };
  await page.evaluate(() => window.Dwell.setMs(600));                   // the rest watch uses her dwell
  await liftAway(0);
  const rest = await page.locator("#restTile").boundingBox();
  await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2, { steps: 5 });
  await page.waitForFunction(() => window.Drawing.state().carrying === null, null, { timeout: 3000 });
  let s = await st(page);
  assert.deepEqual([s.items, s.history], [home, 2], "the rest tile: back where it was, no history");
  assert.equal(await page.evaluate(() => document.getElementById("restTile").matches(".dwell")), false, "and the rest tile stays inert");
  await slowDwell(page);
  await liftAway(1);
  await page.locator("#mode-places").click();
  s = await st(page);
  assert.deepEqual([s.items, s.mode, s.carrying], [home, "places", null], "a mode tile: back, then the mode");
  await liftAway(1);
  await page.locator("#btnUndo").click();
  assert.deepEqual((await st(page)).items, home.slice(0, 1), "Undo: back, then the previous event (the sun) is undone");
  await liftAway(0);
  await page.locator("#btnDone").click();
  await page.waitForFunction(() => window.Drawing.state().screen === "shelf");
  assert.ok((await st(page)).said.includes("You made a picture with a horse!"), "Done: back, then it saves and celebrates");
  await ctx.close();
});

test("touch wins: a finger on the carried item drags it and drops it where the finger lets go", async () => {
  const { ctx, page } = await openRing();
  await slowDwell(page);
  await page.locator("#tile-horse").click();
  await liftAt(page, 0);
  const p = await scenePt(page, 0.3, 0.5);
  await page.mouse.move(p.x, p.y, { steps: 10 });
  const from = await centreOf(page, '#art [data-i="0"]');
  await finger(page, from, { x: from.x + 150, y: from.y + 60 });
  await page.waitForTimeout(300);                                       // past dwell.js's tap rescue
  const s = await st(page);
  const sw = (await page.locator("#scene").boundingBox()).width;
  assert.deepEqual([s.carrying, s.items[0].by, s.history], [null, "partner", 2]);
  assert.ok(Math.abs(s.items[0].x - (0.3 + 150 / sw)) < 0.05, JSON.stringify(s.items[0]));
  await ctx.close();
});

test("a finger drag in Draw mode moves a sticker and never starts a stroke (Review Focus 2)", async () => {
  const { ctx, page } = await openRing();
  await slowDwell(page);
  await page.locator("#tile-horse").click();
  await page.waitForFunction(() => !document.querySelector(".flyer"));
  await page.locator("#mode-draw").click();
  const from = await centreOf(page, '#art [data-i="0"]');
  await finger(page, from, { x: from.x - 60, y: from.y - 20 });       // short: released inside the picture
  await page.waitForTimeout(400);
  const s = await st(page);
  assert.deepEqual([s.pen, s.items.length, s.items[0].by], [null, 1, "partner"]);
  await ctx.close();
});

test("a dropped item is not lifted again until her gaze has left it once (Review Focus 5)", async () => {
  const { ctx, page } = await openRing();
  await slowDwell(page);
  await page.locator("#tile-horse").click();
  await liftAt(page, 0);
  const p = await scenePt(page, 0.3, 0.5);
  await page.mouse.move(p.x, p.y, { steps: 10 });
  await page.locator("#spot").click();
  assert.equal((await st(page)).cool, 0);
  assert.equal(await page.locator('#hits > .hit[data-hit="0"]').count(), 0, "no target under her resting gaze");
  const near = await scenePt(page, 0.31, 0.51);
  await page.mouse.move(near.x, near.y);
  assert.equal(await page.locator('#hits > .hit[data-hit="0"]').count(), 0, "still on it");
  const away = await scenePt(page, 0.8, 0.2);
  await page.mouse.move(away.x, away.y, { steps: 3 });
  assert.equal((await st(page)).cool, null);
  assert.equal(await page.locator('#hits > .hit[data-hit="0"]').count(), 1, "she looked away: it can be lifted again");
  await ctx.close();
});

test("with her real dwell: rest on a sticker to lift it, look to carry it as long as she likes, rest to drop it", async () => {
  const { ctx, page } = await openRing();
  await page.locator("#tile-sun").click();
  await page.waitForFunction(() => !document.querySelector(".flyer"));
  await page.evaluate(() => window.Dwell.setMs(800));
  const sun = await centreOf(page, '#hits > .hit[data-hit="0"]');
  await page.mouse.move(sun.x, sun.y, { steps: 5 });
  await page.waitForFunction(() => window.Drawing.state().carrying === 0, null, { timeout: 4000 });
  for (let k = 1; k <= 20; k++) {
    const q = await scenePt(page, 0.5 - k * 0.015, 0.17 + k * 0.01);
    await page.mouse.move(q.x, q.y, { steps: 2 });
    await page.waitForTimeout(50);
  }
  assert.equal((await st(page)).carrying, 0, "still carried while she keeps looking");
  await page.waitForFunction(() => window.Drawing.state().carrying === null, null, { timeout: 4000 });
  const s = (await st(page)).items[0];
  assert.ok(s.x < 0.3 && s.y > 0.3, "dropped where she rested: " + JSON.stringify(s));
  await ctx.close();
});
```

- [ ] **Step 2: Run them — they fail** (`node --test tests/drawing-scene.test.mjs` → `hitBox` not exported; `node --test tests/drawing-ui.test.mjs` → the seven new tests and the updated "inert" test fail: no `#hits > .hit`).

- [ ] **Step 3: `scene.js`** — append:

```js
// A dwell target for a placed item (spec 2026-10-02 §6, deviation 2): its art box in px, grown to
// at least F x F about its centre, then SHIFTED — never shrunk — to lie inside the W x H picture.
export function hitBox(op, W, H, F) {
  const w = Math.max(op.width * W, F), h = Math.max(op.height * H, F);
  const cx = (op.left + op.width / 2) * W, cy = (op.top + op.height / 2) * H;
  const fit = (c, size, max) => Math.min(Math.max(0, c - size / 2), Math.max(0, max - size));
  return { left: fit(cx, w, W), top: fit(cy, h, H), width: w, height: h };
}
```

- [ ] **Step 4: `drawing.js`** — add:

```js
// ---------- gaze-move (spec 2026-10-02 §6) ----------
// In Stickers, People and Places every placed sticker or person has a hit box; Draw mode has none
// (her picture is the target there), ink never has one, and while she carries something only the
// spot is a target. The item she just dropped waits until her gaze has left it (deviation 13).
function paintHits() {
  const box = $("hits");
  const show = S.screen === "ring" && !!S.scene && S.mode !== "draw" && !S.carry && !S.pen;
  if (!show) { box.replaceChildren(); return; }
  const r = $("scene").getBoundingClientRect();
  if (!r.width) return;
  const F = floorPx(), kids = [];
  for (const op of SC.sceneOps(S.scene, S.table)) {
    if (op.kind === "stroke" || op.i === S.cool) continue;
    const b = SC.hitBox(op, r.width, r.height, F);
    const el = document.createElement("div");
    el.className = "hit dwell";
    el.dataset.hit = String(op.i);
    el.setAttribute("aria-label", SC.itemWord(S.table, op.s) || "Picture");
    Object.assign(el.style, { left: b.left + "px", top: b.top + "px", width: b.width + "px", height: b.height + "px" });
    el.addEventListener("click", (e) => { e.stopPropagation(); lift(op.i); });
    kids.push(el);                                   // item order: the latest is on top and wins
  }
  box.replaceChildren(...kids);
  refreeze();
}
// LIFT: her full dwell on an item. It says its word, grows a little, and follows her gaze.
function lift(i) {
  if (Date.now() < S.swallowUntil) return;
  if (S.screen !== "ring" || !S.scene || S.paused || S.mode === "draw" || S.pen || S.carry) return;
  const it = S.scene.items[i];
  if (!it || it.s === "stroke") return;
  hush();
  say(SC.itemWord(S.table, it.s));
  S.carry = { i, sx: it.x, sy: it.y, x: it.x, y: it.y };
  const art = document.querySelector('#art [data-i="' + i + '"]');
  if (art) art.classList.add("carried");
  applyTargets();
  const g = S.gaze, r = $("scene").getBoundingClientRect();
  if (g && toScene(g.cx, g.cy).inside) placeSpot(g.cx, g.cy);
  else placeSpot(r.left + it.x * r.width, r.top + it.y * r.height);
  log("lift", { s: it.s });
}
// CARRY: the centre tracks her gaze (smoothed like the pen), clamped so it never leaves the picture.
// Nothing is stored until it lands. No timer — she can carry it as long as she likes.
function carryFollow() {
  const c = S.carry, it = S.scene.items[c.i], g = S.gaze, p = toScene(g.cx, g.cy);
  c.sx += SC.PEN.alpha * (p.x - c.sx);
  c.sy += SC.PEN.alpha * (p.y - c.sy);
  const at = SC.clampItem({ x: c.sx, y: c.sy, w: it.w });
  c.x = at.x; c.y = at.y;
  const art = document.querySelector('#art [data-i="' + c.i + '"]');
  if (art) { art.style.left = (at.x - it.w / SC.ASPECT / 2) * 100 + "%"; art.style.top = (at.y - it.w / 2) * 100 + "%"; }
  if (p.inside) followSpot(g.cx, g.cy); else removeSpot();
}
function drop(at, by) {
  const c = S.carry;
  if (!c) return;
  stopRestWatch(); removeSpot();
  S.carry = null;
  const it = S.scene.items[c.i], to = SC.clampItem({ x: at.x, y: at.y, w: it.w });
  push({ t: "move", i: c.i, from: { x: it.x, y: it.y, by: it.by } });
  it.x = to.x; it.y = to.y; it.by = by;
  S.cool = c.i;
  paintScene(); applyTargets(); changed();
  log("drop", { s: it.s, by });
}
function putBack() {
  if (!S.carry) return;
  stopRestWatch(); removeSpot();
  S.carry = null;
  paintScene(); applyTargets();
  log("put_back", {});
}
// partner.js: a finger took the carried item (touch wins). The art stays where it is; the drag commits.
function releaseCarry() {
  const c = S.carry;
  if (!c) return null;
  stopRestWatch(); removeSpot();
  S.carry = null;
  return { i: c.i, x: c.x, y: c.y };
}
function coolCheck() {
  const op = SC.sceneOps(S.scene, S.table).find((o) => o.i === S.cool), r = $("scene").getBoundingClientRect();
  if (!op || !r.width) { S.cool = null; paintHits(); return; }
  const b = SC.hitBox(op, r.width, r.height, floorPx()), x = S.gaze.cx - r.left, y = S.gaze.cy - r.top;
  if (x < b.left || x > b.left + b.width || y < b.top || y > b.top + b.height) { S.cool = null; paintHits(); }
}
function swallowClicks(ms) { S.swallowUntil = Date.now() + (ms || 400); }
```

Replace `onPointer`, `land`, `settle`, and extend `applyTargets` and `paintScene`:

```js
function onPointer(e) {
  S.gaze = { cx: e.clientX, cy: e.clientY, type: e.pointerType || "mouse" };
  if (S.cool !== null && !S.carry && S.scene) coolCheck();
  if (e.type !== "pointermove" || e.pointerType === "touch") return;
  if (S.pen) penFollow();
  else if (S.carry) carryFollow();
  if (S.pen || S.carry) restWatch();
}
function land(at) { if (S.pen) endStroke(at); else if (S.carry) drop(at, "ellie"); }
function settle() { if (S.pen) endStroke(null); if (S.carry) putBack(); }
function paintScene() { SC.renderScene($("art"), S.scene, { table: S.table }); paintHits(); }
```
In `applyTargets()` call `paintHits();` just before `refreeze();`. In `moveItem(i, x, y)` add first `if (S.carry && S.carry.i === i) releaseCarry();`. In `undo()`, `clearPicture()` and `openRing()` add `S.cool = null;` (an index into the items that just changed). The resize listener also calls `paintHits()`. Add `carrying: S.carry ? S.carry.i : null, cool: S.cool,` to `state()` and `releaseCarry, swallowClicks,` to `window.Drawing`. After the `window.Drawing = {…}` block add:

```js
// Test-only (spec 2026-10-02 §9): the contract audit paints a seeded scene on the gate hub's
// never-saved ring WITHOUT a PUT (no changed(), so nothing reaches the gate's data dir) and lifts one.
if (window.__testHooks) Object.assign(window.Drawing, {
  __show(scene) {
    S.scene = { v: 1, backdrop: "meadow", ...scene, items: (scene.items || []).map((i) => ({ ...i })) };
    S.scene.crayon = S.scene.crayon || S.table.crayonDefault;
    renderPalette(); paintScene(); applyTargets();
  },
  __lift: (i) => lift(i),
});
```

- [ ] **Step 5: `partner.js`** — replace the `pointerdown` handler and `end`:

```js
  scene.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    const carrying = D.state().carrying;
    let i;
    if (carrying !== null) {
      // While she carries something, a finger ON it takes it (touch wins); anywhere else the tap is her
      // landing (drawing.js). Hit-tested by the art's own box: the spot may lie on top of it.
      const art = scene.querySelector('#art [data-i="' + carrying + '"]'), r = art && art.getBoundingClientRect();
      if (!r || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      i = carrying;
    } else {
      const el = e.target && e.target.closest ? e.target.closest("[data-i], [data-hit]") : null;
      if (!el || !scene.contains(el)) return;
      i = Number(el.hasAttribute("data-hit") ? el.getAttribute("data-hit") : el.getAttribute("data-i"));
    }
    let it = D.itemAt(i);
    if (!it || it.s === "stroke") return;                     // ink is never dragged
    const wasCarried = carrying === i;
    if (wasCarried) { const c = D.releaseCarry(); if (c) it = { ...it, x: c.x, y: c.y }; }
    const art = scene.querySelector('#art [data-i="' + i + '"]');
    if (!art) return;
    e.preventDefault();
    drag = { i, id: e.pointerId, el: art, x0: e.clientX, y0: e.clientY, it, r: scene.getBoundingClientRect(),
             nx: it.x, ny: it.y, moved: false, wasCarried };
    try { e.target.setPointerCapture(e.pointerId); } catch {}
  });
```
and

```js
  const end = (commit) => (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    // One "move" in her history. Swallow the click the finger's release may still produce: it must
    // never lift the item again, start a stroke in Draw mode, or land something (spec 2026-10-02 §6).
    if (commit && (d.moved || d.wasCarried)) { D.moveItem(d.i, d.nx, d.ny); D.swallowClicks(400); }
    else D.repaint();
  };
```
Update its header comment: the finger also takes a carried item (touch wins) and never moves ink.

- [ ] **Step 6: `drawing.css`:**

```css
/* item hit boxes: transparent, id-qualified (dwell.js's .dwell{position:relative} is injected later) */
#hits > .hit{position:absolute; pointer-events:auto; border-radius:12px; background:transparent}
#art .item.carried{transform:scale(1.1); filter:drop-shadow(0 10px 12px rgba(0, 0, 0, .35)); z-index:2}
```

- [ ] **Step 7: Run them — they pass:** `node --test tests/drawing-scene.test.mjs` → `# pass 20`; `node --test tests/drawing-ui.test.mjs` → `# pass 62`, `# fail 0` (the v1 finger-drag test passes unchanged: its finger now lands on the horse's `.hit`).

- [ ] **Step 8: Commit**

```bash
git add public/drawing/scene.js public/drawing/drawing.js public/drawing/partner.js public/drawing/drawing.css \
  tests/drawing-scene.test.mjs tests/drawing-ui.test.mjs
git commit -m "drawing: gaze-move — a dwell lifts a sticker or a person, her gaze carries it as long as she likes, a rest on the spot drops it; the rest tile, a mode, Undo or Done put it back first; a finger takes it (touch wins); never in Draw mode, never ink (spec 2026-10-02 §6)"
```

---

### Task 10: The contract audit — every mode, items, a library and a carried item; the 12-vs-16 question closed

**Files:**
- Modify: `tests/invariants.mjs` (`STATES`)
- Test: `tests/drawing-ui.test.mjs`

**Interfaces:**
- Consumes: T5 `&mode=`; T9 `__show`, `__lift`, `SPACED`; T8 `seedPeople`.
- Produces: the gate audits each Drawing mode on the gate hub at both viewports; this suite audits the same with a library and items.

**The 12-vs-16 question, resolved (verified, not assumed):** `tests/invariants.mjs` never counts choices — MEASURE returns `nTargets` only (`:272`) and the file has no `maxChoices` reference; `CONTRACT.maxChoices = { ideal: 2, comfortable: 12, cap: 16 }` (`public/lib/contract.js:70-74`) is pinned only by era-core's `lib-contract.test.mjs:76`. So no per-page override is needed (deviation 3); T5 pins the ring at 14 ≤ cap. Nothing to change in the audit's laws.

- [ ] **Step 1: Write the tests.** In `tests/invariants.mjs` `STATES`, after `{ id: "/drawing/#ring", … }`, add:

```js
  // Drawing v2 (spec 2026-10-02 §9): each mode's palette on the same never-saved id (&mode= is
  // honoured only under __testHooks, which measureAt sets before any script), the item hit boxes and a
  // carried item. __show paints a scene WITHOUT a PUT: the gate hub's data dir stays untouched.
  // (Choices are not counted by this audit — the ring's 14 <= CONTRACT.maxChoices.cap is pinned in
  // drawing-ui.test.mjs.)
  { id: "/drawing/#ring-draw", path: "/drawing/#p=2026-01-01-000000-fixture&mode=draw" },
  { id: "/drawing/#ring-people", path: "/drawing/#p=2026-01-01-000000-fixture&mode=people" },
  { id: "/drawing/#ring-places", path: "/drawing/#p=2026-01-01-000000-fixture&mode=places" },
  { id: "/drawing/#ring-items", path: "/drawing/#p=2026-01-01-000000-fixture&mode=stickers", setup: async () => {
      window.Drawing.__show({ items: [
        { s: "house", x: 0.15, y: 0.70, w: 0.26, by: "ellie" }, { s: "horse", x: 0.42, y: 0.80, w: 0.20, by: "ellie" },
        { s: "tree", x: 0.68, y: 0.70, w: 0.28, by: "ellie" }, { s: "person", x: 0.90, y: 0.80, w: 0.22, by: "ellie" },
        { s: "sun", x: 0.12, y: 0.18, w: 0.16, by: "ellie" }, { s: "cloud", x: 0.40, y: 0.18, w: 0.14, by: "ellie" },
        { s: "star", x: 0.62, y: 0.15, w: 0.10, by: "ellie" }, { s: "splat", x: 0.85, y: 0.22, w: 0.15, by: "ellie", c: "#DE7B52", seed: 7 },
        { s: "stroke", c: "#6a4fb3", w: 0.014, pts: [[0.05, 0.45], [0.95, 0.45]], by: "ellie" }] });
      await new Promise((r) => setTimeout(r, 400));
    } },
  { id: "/drawing/#ring-carried", path: "/drawing/#p=2026-01-01-000000-fixture&mode=stickers", setup: async () => {
      window.Drawing.__show({ items: [
        { s: "horse", x: 0.42, y: 0.80, w: 0.20, by: "ellie" }, { s: "star", x: 0.62, y: 0.15, w: 0.10, by: "ellie" }] });
      window.Drawing.__lift(1);
      await new Promise((r) => setTimeout(r, 400));
    } },
```

and append to `tests/drawing-ui.test.mjs`:

```js
// ================================================================ v2 T10 — the contract audit per mode
test("the contract audit is clean in every mode — with a library, items, ink and a carried item — at both gate viewports", async () => {
  seedPeople([MAYA, SAM]);
  const id = "2026-10-02-160000-test-dev";
  seed(id, SPACED, "2026-10-02T16:00:00Z");
  process.env.INVARIANTS_BASE = BASE;
  const { auditPath } = await import("./invariants.mjs");
  for (const m of ["draw", "people", "places", "stickers"]) {
    const r = await auditPath(browser, { id: "/drawing/#" + m, path: `/drawing/#p=${id}&mode=${m}` });
    assert.deepEqual(r.violations, [], m + ":\n" + r.violations.join("\n"));
    for (const v of r.viewports) assert.ok(v.nTargets >= 9, `${m} @${v.vp.w}: ${v.nTargets} targets`);
  }
  const r = await auditPath(browser, { id: "/drawing/#carried", path: `/drawing/#p=${id}&mode=stickers`,
    setup: async () => { window.Drawing.__lift(6); await new Promise((res) => setTimeout(res, 300)); } });
  assert.deepEqual(r.violations, [], "carried:\n" + r.violations.join("\n"));
  for (const v of r.viewports) assert.ok(v.nTargets >= 17, "spot + 8 palette + 4 modes + Undo + Done + 2 doors: " + v.nTargets);
  seedPeople(null);
});
```

- [ ] **Step 2: Run them.** `node --test tests/drawing-ui.test.mjs` → `# pass 63`, `# fail 0`. Then the gate's own STATES on a scratch hub (How to run things): `INVARIANTS_BASE=http://127.0.0.1:$P node tests/invariants.mjs '/drawing/#p=2026-01-01-000000-fixture&mode=draw' '/drawing/#p=2026-01-01-000000-fixture&mode=people' '/drawing/#p=2026-01-01-000000-fixture&mode=places'` → `violations=0` on all six lines; `INVARIANTS_BASE=http://127.0.0.1:$P node --test tests/invariants.test.mjs` → `# fail 0`. Afterwards `ls $D/drawings` must say "No such file or directory" (the audit wrote nothing). A violation: fix the CSS or the hit-box/spot code — never the seats, never a contract number; STOP and report if it cannot be fixed that way.

- [ ] **Step 3: Commit**

```bash
git add tests/invariants.mjs tests/drawing-ui.test.mjs
git commit -m "drawing: the contract audit covers every mode — the gate audits Draw, People, Places, the item hit boxes and a carried item on a never-saved ring; the suite audits them with a library and ink; choices are not an audit law, the 14 is pinned (spec 2026-10-02 §8, §9)"
```

---
### Task 11: The dev note, and the spec's test list checked off

**Files:**
- Modify: `docs/drawing.md`

**Interfaces:** none (docs only; the land rail accepts a docs-only commit on a gated tree).

- [ ] **Step 1: Update `docs/drawing.md`.** Change the first line under the title to cite both specs and both plans (`2026-09-30-drawing-design.md` + `2026-10-02-drawing-modes-design.md`; `2026-09-30-drawing-plan.md` + `2026-10-02-drawing-modes-plan.md`). In "## Files" add:

```markdown
- `public/drawing/backdrops.js` — the eight places as data (shapes in 1600x900 units) and their two
  painters: `backdropSvg` (ring, thumbnails, the Places tiles) and `paintBackdrop` (the PNG).
- `public/drawing/stickers/mode-*.png` — the mode glyphs (Fluent 3D, MIT, pinned in `stickers.json`
  `modes[]`; ⭐ Stickers reuses `star.png`).
```
and extend the existing lines: `scene.js` — "+ the pen (`penStart/penMove/penEnd/penRoom`), strokes as one path string, people (`withPeople`), horizon-relative slots (`slotY`), hit boxes (`hitBox`)"; `drawing.js` — "+ the mode row, the per-mode palettes (`renderPalette`), the Draw and gaze-move state machines (plan 2026-10-02 Definitions), the landing spot"; `partner.js` — "+ touch wins over a carried item; ink is never dragged"; `stickers.json` — "+ `modes`, `crayons`, `backdrops`; slot tables are written against the reference horizon 0.58"; `drawings.js` — "+ v2 validation (strokes, crayons, places, people with grandfathering), 256 KB, `characters()`"; `drive.js` — "+ `characters` mirrors like `drawings`".

Add two sections before "## Re-cutting assets":

```markdown
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
```

In "## Tests and ports" add: "v2 added no suite and no port: `drawing-scene` (geometry), `drawings` (hub), `drive-mirror` (characters), `drawing-ui` (the app + per-mode audits) and `invariants.mjs` STATES (`#ring-draw/-people/-places/-items/-carried`)." Replace the body of "## Later rungs" with: `Resizing or recolouring stickers, stroke widths, an eraser (Undo is the eraser), backgrounds from her photos, sound effects, a People editor in Settings, printing (spec 2026-10-02 §10); and v1's remaining rungs (a picture outbox, the TD Snap tile + Drawing.bat, ticking Drawing on devices whose apps.json predates it).`

- [ ] **Step 2: Check the spec's test list (§9) against the suites** — every line must name a test that exists (grep the quoted names):

| Spec §9 line | Test |
|---|---|
| scene: strokes (point cap, smoothing determinism, path output) | drawing-scene "the pen: smoothing is deterministic…", "penEnd lands…", "a stroke is one path…" |
| scene: backdrop geometry (horizon-relative slots) | drawing-scene "slots are horizon-relative…", "eight places…", "one geometry…", "no red in any place…" |
| scene: person items; describe() with people and strokes | drawing-scene "people are ground stickers…", "the PNG draws a person…", "the celebration names people…" |
| drawings: strokes, crayons, person ids vs a synthetic characters.json, backdrop ids, 256 KB | drawings "v2 validation…", "a person who left the library…", "PUT takes a scene up to 256 KB…" |
| drawings: `/characters/*` incl. absent library → `[]` | drawings "the characters library…", "GET /characters/index.json…" |
| drive-mirror: characters mirrors, prunes only ledger-owned, json byte-compared | drive-mirror "characters mirror in, adopt…" |
| ui: mode row seats and glow; mode switch speaks and persists | drawing-ui "row 5: …", "modes: Stickers first…", "the side columns are the mode's palette…" |
| ui Draw: dwell starts, gaze moves, dwell ends; no ink without a live stroke; crayon applied; Undo removes the stroke | drawing-ui "Draw: a dwell on the picture starts…", "no ink without a live stroke…", "Draw: eight crayons…", "a stroke ends when…", "Undo takes the last stroke…", "with her real dwell: rest on the picture…" |
| ui People: two synthetic people land on the grass, More pages, empty library → black cells + "No people yet" | drawing-ui "People: the library in dad's order…", "People: past eight…", "People with no library…" |
| ui Places: swap keeps items, Undo restores | drawing-ui "Places: a dwell swaps…" |
| ui Move: lift → carry → drop at the second dwell; put-back on rest/mode/Undo/Done; not targets in Draw; partner touch wins | drawing-ui "lift → carry → drop…", "put it back…", "gaze-move targets…", "touch wins…", "with her real dwell: rest on a sticker…" |
| ui: PNG export includes strokes/people/backdrop | drawing-ui "the PNG has her stroke…", "Done names her people, and the PNG…", "the ring draws the picture's place, and the exported PNG…" |
| invariants: STATES per mode + carried, both viewports, zero violations; the maxChoices override | `tests/invariants.mjs` STATES `#ring-draw/-people/-places/-items/-carried`; drawing-ui "the contract audit is clean in every mode…"; override not needed (deviation 3, T5's `≤ CONTRACT.maxChoices.cap`) |

Run: `grep -c "^test(" tests/drawings.test.mjs tests/drawing-ui.test.mjs tests/drawing-scene.test.mjs tests/drive-mirror.test.mjs` → `34`, `63`, `20`, `33`.

- [ ] **Step 3: Commit**

```bash
git add docs/drawing.md
git commit -m "docs: drawing.md — modes, the landing spot and hit boxes, the private People library, the v2 suites (spec 2026-10-02)"
```

---

### Task 12: Gate green (the plan stops here; landing is the overseer's act)

**Files:** none (a red suite goes back to the task that owns it).

- [ ] **Step 1: Everything committed** — `git status --porcelain --untracked-files=no` prints nothing (a dirty tracked tree writes `dirty=1` into the stamp and `land` refuses it).

- [ ] **Step 2: Run the gate detached, its PID in a file** (it outruns the 10-minute tool ceiling; it takes a machine-wide lock and may queue behind another worktree's run):

```bash
cd /home/claude/new-era/era-hub--wt-drawing-modes
G="$SCRATCH/gate"; mkdir -p "$G"                 # SCRATCH = your session's scratchpad directory
nohup bash tools/era-gate.sh > "$G/gate.log" 2>&1 < /dev/null & echo $! > "$G/gate.pid"
cat "$G/gate.pid"
```
Wait with the Monitor tool on an until-loop: `until grep -q '^== era-gate:' "$G/gate.log"; do sleep 30; done` (no foreground `sleep`).

**Stopping it** (only if it truly must stop): first `ps -p "$(cat $G/gate.pid)" -o args=` must show `bash tools/era-gate.sh`; then send the signal to THAT ONE pid (`kill "$(cat $G/gate.pid)"`). If its children linger, list them with `pgrep -P "$(cat $G/gate.pid)"`, check each with `ps -p <pid> -o args=` and signal those pids one at a time. Never signal a process group or a session, never use pkill/killall, never target pid 0 or -1 — a PreToolUse hook blocks all of those (`/home/claude/.claude/CLAUDE.md`: on 10/1 a session-wide kill took down every session on the build box).

- [ ] **Step 3: Read the verdict.** Expected last line: `== era-gate: 116 passed, 0 failed ==` (master `e022305` is 116; v2 adds tests to existing suites, no new suite file). Then:

```bash
T=$(git rev-parse 'HEAD^{tree}'); cat /tmp/era-gate-green/$T
```
Expected: line 1 the same `0 failed` summary, `head=` this HEAD, `at=` within the last few minutes, NO `dirty=1`. A `FAIL <suite>` line: read `gate/<suite>.out`, fix in the owning task's files, commit, re-run from Step 2. Never weaken an assertion to get green — STOP and report instead.

- [ ] **Step 4: Hand over** — report the stamp line and HEAD to the overseer. `worktree.sh land`, the status line, any release (v2 is a patch under the signed installer — no installer change: no new app, nothing outside `public/drawing/` and the already-listed hub modules; `backdrops.js` and the three PNGs ride `cp -r public/drawing`), and the device rollout are the OVERSEER's acts. The People library needs the private pipeline task below before People shows anything on a device.

---

## Private pipeline task (not in this repo) — the cut-out tool, for a separate agent in `ellie-this-week`

Hand this section to an agent working ONLY in the private `ellie-this-week` repo. Nothing from it is ever committed to era-hub.

**Goal:** turn each family member's approved character sheet into a transparent cut-out the hub's People mode can use, and publish it to the family's Drive folder with dad's approval.

**Contract the hub enforces** (era-hub `drawings.js characters()`, `server.js /characters/*`; spec 2026-10-02 §4):
- Location: `<family Drive folder>/characters/` (the same folder that holds `books/` and `drawings/`; Google Drive for desktop carries it to every device's `<DATA>/characters/` within ~10 min).
- `characters.json` = `{ "v": 1, "people": [ { "slug": "<slug>", "word": "<Name>", "scale": 0.30 } ] }`. Array order = the order on her People palette (dad's order; the first eight fill the two columns, then pages of seven with More). `slug` matches `^[a-z0-9][a-z0-9-]{0,39}$` and is unique; `word` is what she hears and reads (1–24 chars); `scale` ∈ [0.1, 0.6] = height as a fraction of the picture's height (default 0.30; a small child ≈ 0.22, an adult ≈ 0.32). Write it atomically (`.part` + rename); keep every existing entry, word, scale and the order dad set; append new slugs at the end.
- `<slug>.png`: RGBA, background fully transparent, the figure cropped to its alpha bounding box + ~2 % margin, feet at the bottom edge (the hub draws it contain-fit, bottom-aligned, on the grass), longest side 768 px (≥ 512), sRGB, no halo. An entry is shown only when its PNG exists.
- Nothing else goes into `characters/` (the hub serves only `<slug>.png` and `characters.json`).

**Tool** (suggested `tools/characters/cutout.py`, uv + PEP 723, the repo's conventions):
- Input: a slug and `people/<slug>/sheet.png` (the plain-white per-person turnaround) or a dad-chosen render path. Refuse a slug whose source is not marked `approved_by_dad` (the character-consistency rule) unless dad names an explicit render.
- Cut out the figure with whichever gives clean alpha on these sheets — the on-device u2netp runtime or fal BiRefNet v2: try both on two people, compare edges at ~270 px tall (her PNG size), keep the better as the default and the other behind a flag.
- Stage the result in a review folder with a contact sheet (each cut-out on white, on the meadow green `#A9D69A` and on the night navy `#14213D`); send dad the contact sheet the way the weekly-book approvals go; on his "yes" for a slug, copy that PNG into the Drive folder and update `characters.json`. No yes, no write.
- Re-running for a slug replaces its PNG (same name) and leaves its json entry (word, scale, order) alone.

**Acceptance:** for the starting roster in spec §4, each PNG is RGBA with transparent pixels on all four borders and a longest side of 768; `characters.json` parses and matches the contract; on a device whose hub has mirrored it, `curl -s http://127.0.0.1:8377/characters/index.json` lists them in dad's order and `/characters/<slug>.png` answers 200; a picture with two people exported from the ring shows them unstretched, feet on the grass.

---
## Risks and unknowns

1. **Midas touch on items.** In Stickers, People and Places every placed sticker or person is a dwell target: looking at her own picture for one dwell lifts something, and the next rest on the picture drops it — possibly somewhere she did not mean. Guards built: her full dwell, page-settle after every palette swap, dwell.js's 48 px rearm, the cool-down on the item just dropped (deviation 13), put-back by resting on the black tile, and Undo. The field will tell; if dad sees accidental lifts, the cheapest dial is "gaze-move in Stickers mode only" (one condition in `paintHits`).
2. **Stray strokes.** In Draw mode, idle, her whole picture is the target (spec §3 as written): a dwell's worth of looking anywhere on it starts a line, even while she wanders. Ink only follows movement, and Undo removes a line, but a fixation start (the landing-spot mechanism used for the start too) is a one-function change if lines appear she did not mean.
3. **Stroke density vs 256 KB.** At ≤ 14 bytes a point a picture holds ~17,500 points ≈ 44 full-length strokes; past that the page refuses new lines silently (deviation 11). Each autosave PUTs the whole scene (up to 256 KB) and Drive for desktop re-uploads `scene.json` after every save while she draws; `index.json` stays small thanks to thinning (deviation 10), but a Drive with many big pictures syncs more.
4. **Small-item hit boxes vs the audit.** Hit boxes ≥ 91 px make two nearby items' targets touch, overlap or sit 1–13 px apart — a MINGAP/OCCLUDED violation by the contract's own law on a real picture. The audit only runs on seeded, spaced states (T10), so the gate stays green; on her real pictures topmost wins and an item fully covered by a later one cannot be lifted (the partner's finger still can).
5. **Gaze tracking assumes the OS cursor.** The pen, the carry and the spot follow `pointermove`. ERAgaze moves the cursor (Drawing does not set `gazeSpace`); a gaze engine that drove dwell.js only through its bus coordinates would leave the pen still. Check on the i13 and the tablet that a line follows her eyes.
6. **The spot's size vs her jitter.** The landing spot is F ≈ 91 px at 1920; Tobii jitter at rest is usually well inside that, but a large jitter would keep re-creating the spot and never land (she would rest on the black tile or dwell another control instead — the line or item is kept, not lost). Tune by widening the re-centre threshold by dwell.js's `padPx` if needed.
7. **Old devices' browsers.** v2 needs `Path2D(svgString)` (also v1's splat), SVG `innerHTML`, pointer events, `aspect-ratio`, `:scope`. All are in any Chromium ≥ 88; the kiosk Edge/Chrome on the family devices is current (v1 risk 7 still applies to the container units).
8. **The People library is absent on the tablet** (Drive off since its 9/14 wipe): People shows black seats + "No people yet" there, and a picture made on the i13 with people renders on the tablet without them (its PNG too, if Done is pressed on the tablet). The hub keeps them in the scene (grandfathering), so nothing is lost; turning Drive on brings the library.
9. **Mixed versions.** A device still on v0.38.0 refuses a scene with strokes, people, crayons or a new place: its shelf hides such pictures and its PUT of one would 400 (the ring would keep it dirty in localStorage). Release v2 to both devices together.
10. **14 choices.** Above the contract's comfortable 12, inside its cap 16 — dad's 10/2 layout. Items as targets add more on a busy picture. The audit enforces neither number (deviation 3).
11. **Fluent has no family glyph.** 🫂 People hugging stands in for 👨‍👩‍👧 (deviation 4); dad may prefer the alternate or, later, a tile made from the first person in his library.

## Not verified (and what WAS)

- **Verified in code on 10/2 (`02efe4e`):** every row of the Preflight table, including dwell.js's single-element dwell, its pad-only-for-the-halo, its injected `.dwell{position:relative}`, invariants' measurement and its lack of any choice count, the ring grid, `route()`, the autosave, `renderScene`'s dispatch, `serveMediaJail`, the drive.js mirror sets and the 64 KB cap; the three Fluent glyphs were fetched at the pinned commit and hashed (256×256 each), and the Family paths 404.
- **Computed, not run:** the backdrop pixel colours in T2's PNG test, the `SPACED` gaps at both viewports, the 44/50-stroke body sizes either side of 256 KB, the PNG person pixel — each from the formulas in this plan. If one is off by more than the stated tolerance, fix the fixture numbers, not the law.
- **Not run:** any of this plan's code (no implementation exists yet), a reviewer subagent (the writing-plans method calls for a self-review only; done below), the gate, a real `build-payload.sh` cut, era-scan over the new files (the pre-commit will), anything on a real device (ERAgaze driving the pen and the spot, Tobii jitter vs the spot size, touch on real glass, TTS voices), the private cut-out pipeline, Google Drive for Windows with 256 KB `scene.json` rewrites.

## Spec coverage (self-review)

| Spec | Task(s) |
|---|---|
| §1 ring v2: row 5 seven cells, mode tiles (photo, Fluent, glow), active mode inert, switch speaks, remembered, Stickers first, fixed positions, partner freeze | T1 (glyphs), T5 |
| §2 Stickers = v1 + gaze-move | T5 (palette), T9 |
| §3 Draw: crayon palette (seats, hexes, never partner red, swatch, speaks, per picture, default Blue); the line (scene `.dwell` in Draw only, start silent, pointermove, α 0.35, ≥ 0.6 %, ≤ 400, live SVG path, 1.4 %, ends: dwell / leave grace+600 / any other dwell / rest), the Midas law; stroke item, render order, Undo, never moved, Clear; PNG + thumbnails; hub validation + 256 KB | T1, T3, T4, T7 (spot: deviation 1) |
| §4 People: library location + json shape + order + More; mirror sets; routes incl. `[]`; pipeline (contract only); behaviour (ground, scale, word, `person:` ids validated, vanished renders nothing); empty library (black cells, "No people yet", partner line); PNG from `/characters/`; synthetic fixtures | T3, T4, T8, Private pipeline section |
| §5 Places: eight procedural, fixed seats, shared geometry, horizon-relative slots; swap speaks, keeps items, `backdrop` history, glow; thumbnails; unknown → meadow | T1, T2, T4, T6 |
| §6 gaze-move: targets in three modes, lift (word, 1.1, shadow, follows, α 0.35), drop at the next dwell anywhere (spot), one thing at a time, `move` history, put-back rules, guards, hit area ≥ floor (pad → hit boxes), topmost wins, touch wins | T9 (deviations 1, 2, 5, 12, 13) |
| §7 data and routes | T3, T4 |
| §8 laws (incl. 14 choices / audit override) | T5, T7, T9, T10 (deviation 3) |
| §9 tests | T11's table |
| §10 out of scope | not built; listed in `docs/drawing.md` |
