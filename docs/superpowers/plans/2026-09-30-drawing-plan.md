# Drawing — make a picture with your eyes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new core era-hub app at `public/drawing/` where Ellie makes a picture by dwelling on eight sticker tiles that land in sensible places by themselves, with Undo, a partner's touch help, a "My pictures" shelf, Drive-mirrored `scene.json` and a Done that saves, shelves and mails.

**Architecture:** Plain DOM on the hub's own kit (door bar, contract, dwell.js, speech.js, celebrate.js — the Pencil's module shim). One ES module `public/drawing/scene.js` holds the pure scene logic and THE scene renderer `renderScene(target, scene, opts)` (DOM for the ring and every shelf thumbnail, canvas 2D for the 1600×900 PNG). The hub side is one CommonJS module `drawings.js` (ids, validation, mount/no-mount writes, list, cleanup, Done + mail) behind thin routes in `server.js`, riding `drive.js`'s mirror (`drawings` joins the mirror set; `mirrorDrawing(id)` is the `mirrorBook` shape; a `.local` marker keeps no-mount pictures safe and carries them up later).

**Tech Stack:** Node 22 (no package.json, no deps in the hub), plain browser JS (classic scripts + one module shim), node:test + Playwright (resolved from `/home/claude/new-era/node_modules` → aac-studio's), sharp (tool-time only, for the icon), Microsoft Fluent Emoji 3D PNGs (MIT).

**Spec:** `docs/superpowers/specs/2026-09-30-drawing-design.md` (commit `0b46a96`, dad-approved 9/30). Executors read both; the spec wins on intent, this plan wins on names and numbers.

**Worktree:** `/home/claude/new-era/era-hub--wt-drawing`, branch `feat/drawing`, base `0b46a96`. Only era-hub changes, so the gate needs no `ERA_WT_SUFFIX`. Never touch the frozen main checkout `/home/claude/new-era/era-hub` or any sibling repo.
**Discipline:** TDD every task (the test is written and SEEN to fail, then the code). Opus (or latest Sonnet) builders with a fresh context per task; the overseer reviews between tasks. No "while I'm here" changes. STOP and report instead of improvising when: a test outside this plan starts failing, an assertion would have to be weakened to pass, or the contract audit (T13) can only be satisfied by moving a tile the spec fixes.
**Commits:** house style `drawing: <what> — <why> (spec 2026-09-30 §N)`; add the attribution trailers your own session's system prompt names. `git add` exact paths, never `-A`. The pre-commit hook runs era-scan over the whole worktree: no family names (except Ellie), no infra terms, no IPs other than loopback — fixtures use the neutral child name `Maya` and device ids like `test-dev`, `kitchen-pc-3f9a`.

---

## Spec deviations (each is the nearest faithful thing; reason given)

1. **`public/settings/index.html:792` does NOT gain `drawing`.** That array is the list of apps that get a "🗑 remove files" button, and `POST /apps/delete` answers `400 "core app"` for any `pack: null` app (`server.js` `/apps/delete`, the `else { res.writeHead(400).end("core app") }` branch). Drawing is core (spec §1), so the button could only ever fail. T12 pins this with a test instead.
2. **`stickers.json` is an object, not a bare array:** `{ v, source, aspect, horizon, lapOffset, stickers: [...], zones: {...} }`. Spec §2.1 puts the zones and slot tables in `stickers.json` and §6 shows the per-sticker array; both have to live in one file. Each sticker keeps the spec's fields (`id, word, src, zone, scale, source`) plus `sha256` (the pin), `plural` (for the celebration sentence) and `at` (its fixed `[row, col]` seat).
3. **`scene.json` gains `updated`** (ISO, stamped by the hub on every PUT). Spec §3 says "newest first" and §2.3 says after Done "the picture is the first cell" — for a reopened older picture both can only hold if the shelf sorts by last change. `created` is kept and still drives the date plate.
4. **Done's `mail` answer gains `"empty"`.** A picture with no items is saved but never mailed: the §2.3/§5 rule (mail when `sha1(items) !== mailedHash`) would otherwise email a blank meadow, and a blank picture is never shelved either (§3). The partner line for it is defined below.
5. **`GET /drawings/<id>/scene.json`** is served by the same path-jailed static as `picture.png` (§5 lists only the PNG). The ring's load/reload reads one scene instead of the whole index.
6. **Park on the shelf + on every screen switch.** §2 says the ring posts the rest tile's centre on boot/resize/resume. The shelf's rest is its two black centre cells, so on the shelf the park is their joint centre, and the park is re-posted whenever the screen switches (the rest spot moves).
7. **Partner tab placement.** "In the door bar" (§2.4): the tab is a `.stripbtn`-style button at the bar's RIGHT end — the one slot doorbar.js's BOARD LAW (9/4 amendment) allows a touch-only control — with the Pencil's behaviour (tap opens a sheet, never `.dwell`). It is present on both screens; Clear is shown on the ring only.
8. **Side columns are `13vw`** (≈250 px at 1920, ≈166 px at 1280) instead of "about 220". "Undo"/"Done" at the 74 px floor measure ≈215 px in the headless Linux fonts the gate uses; the scene is height-bound at 16:9, so it loses nothing.
9. **The celebration does not wait for the mail.** Done starts the POST and celebrates at once; the mail result lands in the partner line when it arrives. The Pencil truth rule is untouched (the mail result is never spoken); a Resend round-trip (up to 30 s with an attachment) must not hold her celebration.
10. **Clear resets the undo history** (not undoable): it already has its own two-stage confirm, and §2.2 lists only placements and moves as history events.
11. **`resendSend` timeout is 30 s when attachments are present** (8 s unchanged for the Pencil): a 1–2 MB base64 body on a slow home link does not fit in 8 s.

## Preflight (verified 9/30 against `0b46a96`; line numbers are anchors — grep for the quoted text if they drifted)

| Fact | Where |
|---|---|
| Module shim: classic app scripts + one `<script type="module">` that imports `../lib/contract.js`, `../lib/doorbar.js`, `../lib/celebrate.js` onto `window.EllieContract / DoorBar / EllieCelebrate` | `era-pencil/app/index.html:222-231` |
| `tellPark()` posts `{x,y}` (0-1, 3 decimals) to `http://127.0.0.1:49155/app/park`; `<html data-park-override="center">` | `era-pencil/app/pencil.js:555-567`, `index.html:2` |
| `tuneDwell` clamps `EC.holds.floor..EC.holds.tuneMax` (800–3000) and calls `BAR.setDwell` | `pencil.js:497-505` |
| `mountDoorBar(mount, {onLeave,onPause,onResume})` → `{bar, doorBtn(#barDoor), talkBtn(#barTalk), sizeBar, setPause, setDwell}`; publishes `--bar-h` on the mount and `--bar-inner` on the bar; doors carry `data-dwell-ms = 2×dwell`; `onResume` fires only after a real `/kiosk/pause` | `era-core/lib/doorbar.js:76-217` |
| `Dwell.setMs / set / suppress / config / state`; targets = `closest(".dwell:not([data-dwell-disabled])")` | `era-core/dwell.js:149-158, 366-384` |
| `Speech.init` sets mode `"test"` synchronously when `window.__testHooks`; `say(text,kind)`, `stop()`, `preload()`; the test log truncates text to 40 chars (so the app keeps its own `said` list) | `era-core/speech.js:17-21, 82-160` |
| Partner freeze: every `.dwell` except `#barDoor/#barTalk` loses the class and gains `data-dwell-disabled`; thaw + `Dwell.suppress(600)` | `era-board/app/board-partner.js:53-81` |
| Partner strip in the bar: `margin-left:auto`, `height:var(--bar-inner)`, NO `.dwell` | `era-board/app/board.css:42-47`, `board-partner.js:579-600` |
| Reader shelf: `BOOK_CELLS` nine cells, `[2,2] [2,3]` black, More at `[3,1]` only when pages > 1 and loops; cells placed by `grid-row/column`; rail `clamp(120px,13vw,250px)`, gaps 18/16 | `public/reader/reader.js:486-742`, `public/reader/index.html:120-171` |
| Hub spawn recipe (real `server.js`, `mkdtemp` data, seams closed, 100×100 ms wait) | `tests/reader-shelf.test.mjs:40-115`, `tests/pencil-ui.test.mjs:26-60` |
| CDP touch (`Input.dispatchTouchEvent`) for finger holds/drags — `page.touchscreen` only taps | `tests/reader-share.test.mjs:153-166, 300-315` |
| `APPS` registry; `/apps` answers `icon: /icons/<id>.png` when the file exists; `loadEnabledApps()` = every non-engine app when there is no `apps.json` | `server.js:119-127, 209-218, 519-522, 2480-2489` |
| `/apps/delete` → 400 "core app" for `pack: null` | `server.js:2607-2629` |
| `resendKey()`, `mailConfigured()`, `mailErrorFor()`, `resendSend(key,to,subject,html)` (8 s abort, `from: "The Pencil <onboarding@resend.dev>"`) | `server.js:1263-1302` |
| `ownDoor(req,res)` (JSON content-type + same-origin), `readBinaryBody(req, cap, cb)` (temp file, 413 path), `serveMediaJail(req,res,jail,rest,exts,avExts,denyDirs,resolveDir)` | `server.js:1502, 1527, 682` |
| Books GET static route (insert the drawings block just above it) | `server.js:2466` |
| Boot: `drive.start(DATA)` then `booksShare.start(DATA)` | `server.js:3492-3495` |
| drive.js: `MIRROR_SUBDIRS:34`, `MIRROR_DELETES:171`, `ADOPT_ON_FIRST_SYNC:195`, `loadLedger:197`, `listTree:205`, `pruneTree:228`, `BYTE_COMPARE:276`, `atomically:346`, `copyTreeLocal:605`, `syncLocal:639`, `mirrorBook:685`, exports `:781` | `drive.js` |
| `tests/drive-mirror.test.mjs:201-203` pins `Object.keys(drive.status().content)` to the five subdirs | must gain `drawings` |
| `build-payload.sh:30` is an explicit engine-file list with a require-scan that fails the build when a required module is missing; `:115-126` copies each public app dir | `tools/build-payload.sh` |
| Installer core section `File /r /x pencil /x board /x reader /x onnxruntime-web /x models /x libheif.js /x yt-dlp` — a core app needs no `/x` and no section | `tools/installer.nsi:103` |
| `tests/invariants.mjs` `STATES:282`; law 3 skips the park corner when `<html data-park-override>`; photo tiles are recognised by `.photo` or a `.plate` child (font floor 24 instead of 74); `INVARIANTS_BASE` env overrides the hub | `tests/invariants.mjs:36, 136-138, 218-228, 282-311` |
| The gate copies every `tests/*` of the five repos flat into `gate/`, rewrites `8377`→`8378`, runs the shared hub on `era-family/test-data` (no `apps.json`, no `drive.json`, no `drawings/`) | `tools/era-gate.sh:150-200` |
| Fluent Emoji: every candidate is exactly 256×256 RGBA; commit-pinned raw URLs return the same bytes as `main` (checked for horse + LICENSE at `1ffb34c752ecf5d402f04cfb4b392c77f57c54bc`) | fetched 9/30 into the session scratchpad |
| No icon tool in the repo (icons came from her i13 on 9/3, `36e00fe`; Music/Movies "drawn to match" by hand). `sharp 0.34.5` with librsvg resolves from the worktree through `/home/claude/new-era/node_modules` (a symlink to aac-studio's) | T12 adds `tools/drawing-icon.mjs` |
| Ports: 8477, 8478, 8479 appear in no `tests/` of the five repos nor any `*--wt-*/tests`, and `ss -ltn` shows nothing on 8470-8489 except 8471/8472 | swept 9/30 |

## Global Constraints

- APPS entry, verbatim: `{ id: "drawing", title: "Drawing", sub: "make a picture with stickers", path: "/drawing/", pack: null }`.
- Holds: every tile is her dwell (the `/settings` `dwellMs`); only 🚪 and 💬 are 2×dwell (doorbar.js does that). No other `data-dwell-ms` anywhere on the page.
- The scene is inert: no `.dwell`, no `data-dwell-*` inside `#scene`. Its item elements are pointer targets for the partner's TOUCH only; a mouse (= ERAgaze) never drags.
- Park: `<html data-park-override="center">`; POST the rest spot's centre (0–1, 3 decimals) to `http://127.0.0.1:49155/app/park`.
- Sizes: every dwell target ≥ 90 px at 1920×1080 and ≥ 60 px at 1280×720; gap ≥ 14 px; bar height from `--bar-h`. Photo-tile plates 24–46 px; text tiles ≥ 74 px at 1920. ≤ 12 choices (10 dwell tiles on the ring, 11 on the shelf incl. More and New picture).
- Speech: `Speech.stop()` first on every action of hers; never "wrong"; never say "sent"; celebration names what she made; no chime.
- Autosave: every history change PUTs `scene.json`, debounced 800 ms, last write wins; the picture lives in memory + `localStorage` key `drawing_scene_<id>` until a PUT succeeds.
- Undo bounded to 60 events. Items ≤ 200. Scene body ≤ 64 KB. PNG body ≤ 4 MB, 1600×900.
- Ids `<YYYY-MM-DD>-<HHMMSS>-<device-id short>`; regex `^\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9][a-z0-9-]{0,39}$`.
- Mail: subject `🎨 <name> made a picture`, the Pencil's `from`, `attachments: [{ filename: "<id>.png", content: <base64> }]`; mail failures never fail the save; the Pencil's own email body is byte-for-byte unchanged (no `attachments` key).
- No red anywhere except partner controls (`#B23A48`, tokens `--c-partner-red`).
- Test ports: `tests/drawings.test.mjs` hub **8477** + fake Resend **8479**; `tests/drawing-ui.test.mjs` hub **8478**. Never 8377 / 8378 / 8425 / 8427 / 8450-8462. Re-run `ss -ltn | grep -E ':(8477|8478|8479)\b'` before the first run (must print nothing).
- Suite basenames unique across the five repos: `drawings.test.mjs`, `drawing-ui.test.mjs`, `drawing-scene.test.mjs` (none exist today).
- "Keep it super simple and let's see how she uses it. Definitely don't overbuild." (dad 9/30)

## Review Focus

The five inputs the spec implies but no spec'd test exercises, most likely to bite first. Each has its test in the owning task (named there).

1. **A rapid repeat on one tile** (her dwell plus a partner's tap, or two quick taps): every placement lands in its own next slot, none is lost, the saves coalesce into one PUT, and one Undo removes exactly one. → T8 test "five quick dwells on one tile…".
2. **The hub not answering a PUT** (a Wi-Fi blink): the picture stays on screen and in `localStorage` (dirty), the next change retries, and a reload before the retry still shows it. → T8 test "a save the hub does not take keeps the picture safe…".
3. **Leaving inside the 800 ms debounce** (🚪, 💬, the kiosk closing): the last sticker still reaches the hub (keepalive flush). → T8 test "leaving within the debounce still saves the last sticker".
4. **Junk in the drawings folder** (a Drive conflict copy `<id> (1)`, a half-written `scene.json`, a folder with no scene, a non-id folder): the shelf lists the good pictures and never throws; cleanup never deletes what it cannot read. → T3 tests "list: non-empty pictures only… conflict copies… skipped" and "cleanup: …".
5. **The 200-item cap**: a 201st dwell says the word and places nothing, so no PUT the hub would refuse is ever sent. → T8 test "the 200th sticker is the last…".

---
## Definitions (every task uses these names and numbers)

### Files

| Path | Responsibility | Task |
|---|---|---|
| `public/drawing/stickers.json` | the sticker table: ids, words, seats, zones + slot tables, scales, pins | T1 |
| `public/drawing/stickers/{house,horse,tree,person,sun,cloud,star}.png`, `stickers/LICENSE` | vendored Fluent Emoji 3D (MIT) | T1 |
| `tools/drawing-fetch-stickers.mjs` | download + sha256/size verify; `--check` verifies offline | T1 |
| `drive.js` (modify) | `drawings` in the mirror sets, `scene.json` byte-compared, `.local` protection + copy-up, `mirrorDrawing(id)`, export `atomically`, `LOCAL_MARKER` | T2 |
| `drawings.js` (new, hub root) | ids, validation, mount/no-mount writes, read, list, cleanup, Done + mail decision | T3, T5 |
| `server.js` (modify) | require + boot `drawings.start`, the five routes, `resendSend(..., attachments)`, `DRAWING_MAIL` | T4, T5 |
| `tools/build-payload.sh` (modify) | `drawings.js` in the engine list (T4); `cp -r public/drawing` (T12) | T4, T12 |
| `public/drawing/scene.js` | ES module: pure scene logic + THE renderer `renderScene` | T6 |
| `public/drawing/index.html` | markup: shelf, ring, partner sheet; module shim | T7 |
| `public/drawing/drawing.css` | all styles | T7 (+T9, T10 add blocks) |
| `public/drawing/drawing.js` | classic app script: boot, router, ring, placing, undo, autosave, park, shelf, Done | T7, T8, T9, T10, T11 |
| `public/drawing/partner.js` | classic script: partner tab + sheet + finger drag | T9 |
| `public/icons/drawing.png`, `public/icons/drawing.ico`, `tools/drawing-icon.mjs` | app icon (256 PNG; ICO with 256/48/32/16 PNG entries) | T12 |
| `tests/drawings.test.mjs` | assets (T1), module (T3), routes (T4), Done/mail (T5) | T1–T5 |
| `tests/drawing-scene.test.mjs` | scene.js pure logic in node | T6 |
| `tests/drawing-ui.test.mjs` | the app in Playwright on a scratch hub | T7–T11, T13 |
| `docs/drawing.md` | dev note | T14 |

**Where the ONE scene renderer lives:** `public/drawing/scene.js`, `export function renderScene(target, scene, { table, images })`. It dispatches on `target`: a `CanvasRenderingContext2D` (has `drawImage`) → paints the PNG (Done, T11); any element → rebuilds it as DOM (the ring `#scene`, T7; every shelf thumbnail and the New picture tile, T10). Both backends consume the same `sceneOps(scene, table)` geometry and the same `MEADOW` stops and `splatPath(seed)`, so the ring, the thumbnails and the mailed PNG cannot drift apart.

### Stickers and seats (fixed forever)

The ring is a CSS grid of 3 columns × 5 rows under the door bar: `[13vw tile] [scene 1fr] [13vw tile]`.

| Seat `[row,col]` | Tile | id | zone | scale (fraction of scene HEIGHT) | spoken word | plural |
|---|---|---|---|---|---|---|
| [1,1] | House | `house` | ground | 0.26 | House | houses |
| [2,1] | Horse | `horse` | ground | 0.20 | Horse | horses |
| [3,1] | Tree | `tree` | ground | 0.28 | Tree | trees |
| [4,1] | Person | `person` | ground | 0.22 | Person | people |
| [1,3] | Sun | `sun` | sky | 0.16 | Sun | suns |
| [2,3] | Cloud | `cloud` | sky | 0.14 | Cloud | clouds |
| [3,3] | Star | `star` | sky | 0.10 | Star | stars |
| [4,3] | Splat | `splat` | any | random 0.12–0.18 | Splat | splats |
| [5,1] | Undo (text tile, `#btnUndo`) | | | | Undo | |
| [5,2] | rest tile `#restTile` (black, one tile wide, centred, inert) | | | | | |
| [5,3] | Done (text tile, `#btnDone`) | | | | | |
| [1–4,2] | the scene `#scene` (16:9, largest box that fits, inert) | | | | | |

Sticker tiles are `<button class="cell tile photo dwell" id="tile-<id>" data-s="<id>">` with a `.pic` (the `<img>`, or an inline `<svg>` for Splat) and `<span class="word plate">Word</span>`.

Assets (Fluent Emoji commit `1ffb34c752ecf5d402f04cfb4b392c77f57c54bc`, raw base `https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/`), all 256×256:

| id | path under the base | sha256 |
|---|---|---|
| house | `assets/House/3D/house_3d.png` | `0279b073321551b55c86a10dc2fff5bf66c8dec895672004da43482c5a1de87c` |
| horse | `assets/Horse/3D/horse_3d.png` | `ff0729b37bc624b02e115e2e5b52c1e92461a3764751a65ce676f4ee26cef72d` |
| tree | `assets/Deciduous%20tree/3D/deciduous_tree_3d.png` | `3c13998c6b866d824703327296c0317de5f079c2b31a6c22defd49d819d6e7f9` |
| person | `assets/Child/Default/3D/child_3d_default.png` | `d8cfe98673ded5575f36c851318fea1b60d3591e93517a31792f6834440b31b9` |
| sun | `assets/Sun/3D/sun_3d.png` | `c9bb15d03d4b1e6151d97e12119ac93bbd2bcb5e713a49c1fcfc11ece54caec1` |
| cloud | `assets/Cloud/3D/cloud_3d.png` | `a4d4629711661a80f6b6b0081c0f84e65352518b2bf23f4c1bec55e297a9fafc` |
| star | `assets/Star/3D/star_3d.png` | `b935cdf502b69054bc2b08e7ba4e4eaba6499564a2041dd77d6291e21bf8cfe8` |
| LICENSE | `LICENSE` | `c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383` |

Person = 🧒 Child, picked 9/30 by rendering every candidate at tile size: the full-body figures (Person standing/walking/running) come out about 40 px wide on a 250 px tile and read as a stick; the child's face fills the tile and reads as "a person" across a room. Alternates if dad wants a body: `assets/Person%20raising%20hand/Default/3D/person_raising_hand_3d_default.png` (`5a4d204f6ad60de492241816e0d963e73324616c97b3f340a4b5fdc46598d645`), `assets/Person%20standing/Default/3D/person_standing_3d_default.png` (`1388e0f9fe7fcb37caf52198c603b7f554ee1b9ded985ff35a300ca685064df1`).

### The scene coordinate system

- Scene aspect 16:9 (the PNG is 1600×900). `x` ∈ [0,1] of the scene WIDTH, `y` ∈ [0,1] of the scene HEIGHT, both the CENTRE of the item's box.
- `w` = the item's box size as a fraction of the scene HEIGHT. Boxes are square (every Fluent PNG is square), so the box spans `w × 9/16` in x-units and `w` in y-units. Half-extents: `hx = w / (16/9) / 2`, `hy = w / 2`.
- Every landed or moved item is clamped so its box stays inside the scene: `x ∈ [hx, 1−hx]`, `y ∈ [hy, 1−hy]`, rounded to 4 decimals.
- Backdrop `meadow`: sky over grass, horizon at `y = 0.58`. `MEADOW` stops (used by BOTH the CSS gradient and the canvas gradient): `[[0, "#BFE3F2"], [0.575, "#E4F3F7"], [0.58, "#A9D69A"], [1, "#78BD6E"]]`.
- Splat colours (tokens.css, never red): `["#0F7C8A" (--c-teal), "#DE7B52" (--c-vowel), "#2E7D5B" (--c-good-literacy), "#B7822B" (--c-confetti-gold)]`.
- Render order = array order: what she placed last is on top.

### Zone slot tables (centre-out order; stored in `stickers.json` → `zones`)

`ground` — `{x, base}`: `base` is where the box's BOTTOM edge sits on the grass; centre `y = base − w/2`.

| # | x | base |
|---|---|---|
| 1 | 0.50 | 0.92 |
| 2 | 0.35 | 0.88 |
| 3 | 0.65 | 0.88 |
| 4 | 0.20 | 0.93 |
| 5 | 0.80 | 0.93 |
| 6 | 0.07 | 0.86 |
| 7 | 0.93 | 0.86 |

`sky` — `{x, y}` centres, all above the horizon for every sky scale:

| # | x | y |
|---|---|---|
| 1 | 0.50 | 0.17 |
| 2 | 0.33 | 0.25 |
| 3 | 0.67 | 0.25 |
| 4 | 0.17 | 0.14 |
| 5 | 0.83 | 0.14 |
| 6 | 0.42 | 0.40 |
| 7 | 0.58 | 0.40 |

`any` (Splat) — `{x, y}` centres, one picked at random per splat (no laps):
`(0.15,0.30) (0.30,0.15) (0.45,0.33) (0.60,0.18) (0.75,0.32) (0.88,0.20) (0.12,0.72) (0.28,0.85) (0.42,0.66) (0.58,0.82) (0.72,0.68) (0.88,0.84)`.

**Landing rule** (`landing(id, items, table, rand)` in scene.js): for `sky`/`ground`, `n` = how many CURRENT items belong to that zone; slot = `slots[n % 7]`; lap offset = `floor(n / 7) × 0.04` added to BOTH x and y; then clamp. For `any`: slot = `slots[floor(rand()·12)]`, `w = round3(0.12 + rand()·0.06)`, `c = SPLAT_COLOURS[floor(rand()·4)]`, `seed = floor(rand()·2147483647)`, then clamp. Nothing is ever refused below the 200-item cap.

### `stickers.json` (exact shape)

```json
{
  "v": 1,
  "source": {
    "repo": "https://github.com/microsoft/fluentui-emoji",
    "commit": "1ffb34c752ecf5d402f04cfb4b392c77f57c54bc",
    "license": "MIT",
    "licenseUrl": "https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/LICENSE",
    "licenseFile": "stickers/LICENSE",
    "licenseSha256": "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383"
  },
  "aspect": [16, 9],
  "horizon": 0.58,
  "lapOffset": 0.04,
  "stickers": [
    { "id": "house",  "word": "House",  "plural": "houses", "at": [1, 1], "zone": "ground", "scale": 0.26, "src": "stickers/house.png",  "source": "<base>assets/House/3D/house_3d.png", "sha256": "0279b073…" },
    "… one object per row of the Stickers table, in that order …",
    { "id": "splat",  "word": "Splat",  "plural": "splats", "at": [4, 3], "zone": "any",    "scale": [0.12, 0.18], "src": null, "source": null, "sha256": null }
  ],
  "zones": {
    "ground": { "slots": [ { "x": 0.50, "base": 0.92 }, "… the ground table …" ] },
    "sky":    { "slots": [ { "x": 0.50, "y": 0.17 }, "… the sky table …" ] },
    "any":    { "slots": [ { "x": 0.15, "y": 0.30 }, "… the any list …" ] }
  }
}
```
(`<base>` and `…` above are shorthand in THIS document only; T1 Step 3 writes the file out in full.)

### `scene.json` (exact shape)

```json
{ "v": 1, "id": "2026-09-30-101542-kitchen-pc-3f9a", "created": "2026-09-30T17:15:42.000Z",
  "updated": "2026-09-30T17:16:03.000Z", "device": "kitchen-pc-3f9a", "backdrop": "meadow",
  "items": [ { "s": "horse", "x": 0.5, "y": 0.82, "w": 0.2, "by": "ellie" },
             { "s": "splat", "x": 0.45, "y": 0.33, "w": 0.153, "by": "ellie", "c": "#DE7B52", "seed": 918273 } ],
  "mailedHash": null }
```
- The hub owns `id`, `created`, `updated`, `device`, `mailedHash`: a PUT body's values for them are ignored. `mailedHash` = `sha1(JSON.stringify(items))` of the items last mailed.
- `by`: `"ellie"` when a tile placed it (dwell or tap — touch parity makes them one act), `"partner"` after a finger drag moved it.
- Items are normalised by the hub to exactly `{s,x,y,w,by}` plus `{c,seed}` on splats, in that key order.

### Id

`<YYYY-MM-DD>-<HHMMSS>-<short>` in the hub's time zone (`TZ`, America/Los_Angeles unless the profile says otherwise). `short = deviceId.length <= 16 ? deviceId : deviceId.slice(0, 11).replace(/-+$/, "") + "-" + deviceId.slice(-4)` (keeps the random tail of a generated `<host>-<4 hex>` id). A taken id (folder exists in the mount or in `<DATA>/drawings`) gets `-2`, `-3`, … Regex (hub and page): `^\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9][a-z0-9-]{0,39}$`.

### Where a picture lives

| Situation | Canonical write | `<DATA>/drawings/<id>/` |
|---|---|---|
| `drive.json` `mode:"local"` + `folderPath` that is a directory ("mount") | `<folderPath>/drawings/<id>/` (`.part`+rename), then `drive.mirrorDrawing(id)` | mirror copy, ledger-owned |
| anything else ("no mount": Drive off, fresh install, offline mount) | `<DATA>/drawings/<id>/` + a `.local` marker file | canonical |

The shelf, `GET /drawings/index.json` and `GET /drawings/<id>/scene.json` read `<DATA>/drawings`. `drive.js` never prunes a folder holding `.local`, and on the next local sync with a mount it copies the folder's non-dot files up to `<folderPath>/drawings/<id>/` and removes the marker.

### Routes (server.js; `drawings.js` does the work)

| Method + path | Body | Door | Answer |
|---|---|---|---|
| `GET /drawings/index.json` | – | – | `200 [ {id, created, updated, device, items: n, scene} ]`, non-empty only, `updated` desc |
| `POST /drawings` | `{}` (≤ 4 KB) | `ownDoor` | `200 {id}` · `500 {error:"write-failed"}` |
| `PUT /drawings/<id>/scene.json` | scene JSON (≤ 64 KB) | `ownDoor` | `200 {ok:true, updated}` · `400 {error:"bad-scene", why}` · `404 {error:"bad-id"}` · `413 {error:"too-big"}` · `500 {error:"write-failed"}` |
| `POST /drawings/<id>/done` | `image/png` bytes (≤ 4 MB, `readBinaryBody`) | `Sec-Fetch-Site` same-origin/none/absent | `200 {saved:true, mail:"sent"\|"no-email"\|"unchanged"\|"failed"\|"empty", reason?}` · `400 {error:"not-png"}` · `404 {error:"no-such-picture"\|"bad-id"}` · `413 {error:"too-big"}` |
| `GET/HEAD /drawings/<id>/picture.png`, `/drawings/<id>/scene.json` | – | – | `serveMediaJail` over `<DATA>/drawings`, exts `.png .json`, id must match the regex |

### Mail status line (partner sheet)

| Done answer | Line |
|---|---|
| none yet | `No picture finished yet` |
| `mail:"sent"` | `Sent to your family` |
| `mail:"no-email"` | `Saved — no family email set up yet` |
| `mail:"failed"` | `Saved — mail failed, will not retry` |
| `mail:"unchanged"` | `Saved — already sent, nothing new to send` |
| `mail:"empty"` | `Saved — the picture is empty, nothing sent` |
| no answer / non-2xx (`saved:false`) | `Not saved — the hub did not answer` |

### Spoken lines

Placing: the sticker's `word`. Undo: `Undo` (nothing at all on an empty history). Done: `describe(items)` — `You made a picture!` when empty, else `You made a picture with ` + list + `!`, where the list counts each sticker id in first-placed order (`a horse`; `two stars`, number words up to twelve, digits after), joined `a, b and c`; e.g. `You made a picture with a horse, a house and two stars!`. Partner Clear: `Clear the whole picture?` then `All clear! A fresh picture.`

### Page state and hooks

- `localStorage`: `drawing_scene_<id>` → `{ scene, dirty, at }`; `drawing_mail_last` → the last Done answer `{ id, saved, mail, reason? }`. Every access in try/catch.
- `window.Drawing` (drawing.js; tests and partner.js use it): `state()` → `{ ready, screen: "shelf"|"ring", id, items, history, dirty, lastMail, shelfPage, shelfPages, shelfIds, said, park, paused }`; `itemAt(i)`, `moveItem(i, x, y)`, `clamp({x,y,w})`, `clearPicture()`, `repaint()`, `tuneDwell(delta)` → ms, `dwellMs()`, `freeze()`, `thaw()`, `say(text)`, `mailLine()`, `onMail(cb)`, `pollShelf()`, `flush()`.
- `window.DrawingScene` = the scene.js module namespace (set by the module shim).

---
## How to run things

- Every suite runs from the worktree root: `cd /home/claude/new-era/era-hub--wt-drawing && node --test tests/<name>.test.mjs`. `drawings`, `drawing-scene` and `drawing-ui` spawn their own hub (ports above) — no hub needs to be running.
- **Two suites assume the shared hub on :8377** (`icons.test.mjs`, `invariants.test.mjs`). Run standalone, :8377 is the LIVE family hub serving MASTER — never test against it. Use a worktree hub on the manual band instead:

```bash
cd /home/claude/new-era/era-hub--wt-drawing
P=8383; ss -ltn | grep -q ":$P " && echo "PORT $P BUSY — pick another in 8380-8389"
D=$(mktemp -d /tmp/claude-1001/-home-claude-new-era-era-hub--wt-drawing/e934eb35-7c51-4242-885b-b8b6a91e3cec/scratchpad/hub-XXXX)
ERA_DATA_DIR=$D ERA_BIND=127.0.0.1 ERA_DEVICE_ID=wt ERA_NO_UPDATE=1 ERA_AI_URL=http://127.0.0.1:1 \
  ERA_ELEVEN_URL=http://127.0.0.1:1 ERA_RESEND_URL=http://127.0.0.1:1 ERA_WEATHER_URL=http://127.0.0.1:1 \
  ERA_GEO_URL=http://127.0.0.1:1/geo ERA_GEOCODE_URL=http://127.0.0.1:1/geocode ERA_FAL_URL=http://127.0.0.1:1 \
  ERA_TMDB_URL=http://127.0.0.1:1 ERA_STREAMING_URL=http://127.0.0.1:1 \
  setsid nohup node server.js $P > $D/server.log 2>&1 < /dev/null &
sleep 2; curl -sf http://127.0.0.1:$P/settings > /dev/null && echo up
# icons.test hard-codes 8377: run a re-pointed copy from gate/ (gitignored; HUB still resolves to the worktree)
mkdir -p gate && sed "s/8377/$P/g" tests/icons.test.mjs > gate/icons.test.mjs && node --test gate/icons.test.mjs
INVARIANTS_BASE=http://127.0.0.1:$P node --test tests/invariants.test.mjs
# stop it BY PID of the node process (setsid's pid is not node's; never pkill -f — it can match your own shell)
kill $(ss -ltnp | grep ":$P " | sed -E 's/.*pid=([0-9]+).*/\1/')
```

- A single subtest: `node --test --test-name-pattern="<part of the name>" tests/<name>.test.mjs`.
- Expected summary lines from `node --test`: `# pass N` and `# fail 0`.

---

### Task 1: The stickers — table, fetch tool, vendored PNGs + MIT licence

**Files:**
- Create: `public/drawing/stickers.json`
- Create: `tools/drawing-fetch-stickers.mjs`
- Create (by running the tool): `public/drawing/stickers/house.png`, `horse.png`, `tree.png`, `person.png`, `sun.png`, `cloud.png`, `star.png`, `LICENSE`
- Test: `tests/drawings.test.mjs` (new; this task writes its first section)

**Interfaces:**
- Consumes: nothing.
- Produces: `public/drawing/stickers.json` in the exact Definitions shape (read by `drawings.js` for validation, by `scene.js` for landing/rendering, by `drawing.js` for tiles). `node tools/drawing-fetch-stickers.mjs --check` exits 0 when every vendored file matches its pin.

- [ ] **Step 1: Write the failing test** — create `tests/drawings.test.mjs`:

```js
// drawings.test.mjs — the Drawing app's hub half (spec docs/superpowers/specs/2026-09-30-drawing-design.md):
// the vendored stickers (§6), the drawings.js module (§4) and its routes (§5). Synthetic fixtures only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRAW = path.join(HUB, "public", "drawing");
const TABLE = JSON.parse(fs.readFileSync(path.join(DRAW, "stickers.json"), "utf8"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-drawings-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ---- §6 the stickers ---------------------------------------------------------
test("the eight stickers sit in their fixed seats: ground things left, sky things then the splat right", () => {
  assert.deepEqual(TABLE.stickers.map(s => s.id), ["house", "horse", "tree", "person", "sun", "cloud", "star", "splat"]);
  assert.deepEqual(TABLE.stickers.map(s => s.at.join(",")), ["1,1", "2,1", "3,1", "4,1", "1,3", "2,3", "3,3", "4,3"]);
  assert.deepEqual(TABLE.stickers.map(s => s.word), ["House", "Horse", "Tree", "Person", "Sun", "Cloud", "Star", "Splat"]);
  assert.deepEqual(TABLE.stickers.map(s => s.zone), ["ground", "ground", "ground", "ground", "sky", "sky", "sky", "any"]);
  assert.equal(TABLE.stickers.find(s => s.id === "person").plural, "people");
});

test("every image sticker is vendored, matches its sha256 pin and is at least 256 px; the splat has no asset", () => {
  execFileSync(process.execPath, [path.join(HUB, "tools", "drawing-fetch-stickers.mjs"), "--check"], { stdio: "pipe" });
  for (const s of TABLE.stickers) {
    if (s.id === "splat") { assert.equal(s.src, null); continue; }
    const b = fs.readFileSync(path.join(DRAW, s.src));
    assert.equal(b.readUInt32BE(0), 0x89504e47, s.id + " is a PNG");
    assert.ok(b.readUInt32BE(16) >= 256 && b.readUInt32BE(20) >= 256, s.id + " is at least 256 px");
    assert.match(s.source, /^https:\/\/raw\.githubusercontent\.com\/microsoft\/fluentui-emoji\/[0-9a-f]{40}\/assets\//);
    assert.match(s.sha256, /^[0-9a-f]{64}$/);
  }
});

test("the MIT licence travels beside the stickers", () => {
  const lic = fs.readFileSync(path.join(DRAW, "stickers", "LICENSE"), "utf8");
  assert.match(lic, /MIT License/);
  assert.match(lic, /Microsoft Corporation/);
});

test("zones: 0-1 slots, sky above the horizon, ground bases on the grass, centre first; scales as the spec", () => {
  assert.equal(TABLE.horizon, 0.58);
  assert.equal(TABLE.lapOffset, 0.04);
  assert.deepEqual(TABLE.aspect, [16, 9]);
  for (const s of TABLE.zones.sky.slots) assert.ok(s.x > 0 && s.x < 1 && s.y > 0 && s.y < TABLE.horizon, JSON.stringify(s));
  for (const s of TABLE.zones.ground.slots) assert.ok(s.x > 0 && s.x < 1 && s.base > TABLE.horizon && s.base <= 1, JSON.stringify(s));
  for (const s of TABLE.zones.any.slots) assert.ok(s.x > 0 && s.x < 1 && s.y > 0 && s.y < 1, JSON.stringify(s));
  assert.equal(TABLE.zones.ground.slots.length, 7);
  assert.equal(TABLE.zones.sky.slots.length, 7);
  assert.equal(TABLE.zones.any.slots.length, 12);
  assert.equal(TABLE.zones.ground.slots[0].x, 0.5, "ground fills centre-out");
  assert.equal(TABLE.zones.sky.slots[0].x, 0.5, "sky fills centre-out");
  const scale = Object.fromEntries(TABLE.stickers.map(s => [s.id, s.scale]));
  assert.deepEqual(scale, { house: 0.26, horse: 0.20, tree: 0.28, person: 0.22, sun: 0.16, cloud: 0.14, star: 0.10, splat: [0.12, 0.18] });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tests/drawings.test.mjs`
Expected: FAIL at load — `ENOENT: no such file or directory, open '…/public/drawing/stickers.json'`.

- [ ] **Step 3: Write `public/drawing/stickers.json`** (in full):

```json
{
  "v": 1,
  "source": {
    "repo": "https://github.com/microsoft/fluentui-emoji",
    "commit": "1ffb34c752ecf5d402f04cfb4b392c77f57c54bc",
    "license": "MIT",
    "licenseUrl": "https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/LICENSE",
    "licenseFile": "stickers/LICENSE",
    "licenseSha256": "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383"
  },
  "aspect": [16, 9],
  "horizon": 0.58,
  "lapOffset": 0.04,
  "stickers": [
    { "id": "house", "word": "House", "plural": "houses", "at": [1, 1], "zone": "ground", "scale": 0.26,
      "src": "stickers/house.png",
      "source": "https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/House/3D/house_3d.png",
      "sha256": "0279b073321551b55c86a10dc2fff5bf66c8dec895672004da43482c5a1de87c" },
    { "id": "horse", "word": "Horse", "plural": "horses", "at": [2, 1], "zone": "ground", "scale": 0.20,
      "src": "stickers/horse.png",
      "source": "https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/Horse/3D/horse_3d.png",
      "sha256": "ff0729b37bc624b02e115e2e5b52c1e92461a3764751a65ce676f4ee26cef72d" },
    { "id": "tree", "word": "Tree", "plural": "trees", "at": [3, 1], "zone": "ground", "scale": 0.28,
      "src": "stickers/tree.png",
      "source": "https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/Deciduous%20tree/3D/deciduous_tree_3d.png",
      "sha256": "3c13998c6b866d824703327296c0317de5f079c2b31a6c22defd49d819d6e7f9" },
    { "id": "person", "word": "Person", "plural": "people", "at": [4, 1], "zone": "ground", "scale": 0.22,
      "src": "stickers/person.png",
      "source": "https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/Child/Default/3D/child_3d_default.png",
      "sha256": "d8cfe98673ded5575f36c851318fea1b60d3591e93517a31792f6834440b31b9" },
    { "id": "sun", "word": "Sun", "plural": "suns", "at": [1, 3], "zone": "sky", "scale": 0.16,
      "src": "stickers/sun.png",
      "source": "https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/Sun/3D/sun_3d.png",
      "sha256": "c9bb15d03d4b1e6151d97e12119ac93bbd2bcb5e713a49c1fcfc11ece54caec1" },
    { "id": "cloud", "word": "Cloud", "plural": "clouds", "at": [2, 3], "zone": "sky", "scale": 0.14,
      "src": "stickers/cloud.png",
      "source": "https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/Cloud/3D/cloud_3d.png",
      "sha256": "a4d4629711661a80f6b6b0081c0f84e65352518b2bf23f4c1bec55e297a9fafc" },
    { "id": "star", "word": "Star", "plural": "stars", "at": [3, 3], "zone": "sky", "scale": 0.10,
      "src": "stickers/star.png",
      "source": "https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/Star/3D/star_3d.png",
      "sha256": "b935cdf502b69054bc2b08e7ba4e4eaba6499564a2041dd77d6291e21bf8cfe8" },
    { "id": "splat", "word": "Splat", "plural": "splats", "at": [4, 3], "zone": "any", "scale": [0.12, 0.18],
      "src": null, "source": null, "sha256": null }
  ],
  "zones": {
    "ground": { "slots": [
      { "x": 0.50, "base": 0.92 }, { "x": 0.35, "base": 0.88 }, { "x": 0.65, "base": 0.88 },
      { "x": 0.20, "base": 0.93 }, { "x": 0.80, "base": 0.93 }, { "x": 0.07, "base": 0.86 },
      { "x": 0.93, "base": 0.86 } ] },
    "sky": { "slots": [
      { "x": 0.50, "y": 0.17 }, { "x": 0.33, "y": 0.25 }, { "x": 0.67, "y": 0.25 },
      { "x": 0.17, "y": 0.14 }, { "x": 0.83, "y": 0.14 }, { "x": 0.42, "y": 0.40 },
      { "x": 0.58, "y": 0.40 } ] },
    "any": { "slots": [
      { "x": 0.15, "y": 0.30 }, { "x": 0.30, "y": 0.15 }, { "x": 0.45, "y": 0.33 }, { "x": 0.60, "y": 0.18 },
      { "x": 0.75, "y": 0.32 }, { "x": 0.88, "y": 0.20 }, { "x": 0.12, "y": 0.72 }, { "x": 0.28, "y": 0.85 },
      { "x": 0.42, "y": 0.66 }, { "x": 0.58, "y": 0.82 }, { "x": 0.72, "y": 0.68 }, { "x": 0.88, "y": 0.84 } ] }
  }
}
```

- [ ] **Step 4: Write `tools/drawing-fetch-stickers.mjs`:**

```js
#!/usr/bin/env node
// drawing-fetch-stickers.mjs — vendors the Drawing app's sticker PNGs (spec 2026-09-30 §6).
// Microsoft Fluent Emoji, 3D style (MIT), fetched by COMMIT-pinned raw URL and refused unless the
// bytes match the sha256 pinned in public/drawing/stickers.json and the PNG is at least 256 px.
//   node tools/drawing-fetch-stickers.mjs          download, verify, write public/drawing/stickers/*
//   node tools/drawing-fetch-stickers.mjs --check  verify what is vendored, offline (the test uses this)
// Re-pick a sticker = change its `source` + `sha256` in stickers.json, then run without --check.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(HUB, "public", "drawing");
const table = JSON.parse(fs.readFileSync(path.join(DIR, "stickers.json"), "utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const pngSize = (b) => (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47)
  ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;

const files = [
  ...table.stickers.filter(s => s.src).map(s => ({ what: s.id, url: s.source, pin: s.sha256, dest: s.src, png: true })),
  { what: "LICENSE", url: table.source.licenseUrl, pin: table.source.licenseSha256, dest: table.source.licenseFile, png: false },
];
function verify(f, buf) {
  const got = sha(buf);
  if (got !== f.pin) return `${f.what}: sha256 ${got} is not the pin ${f.pin}`;
  if (f.png) {
    const s = pngSize(buf);
    if (!s) return `${f.what}: not a PNG`;
    if (s.w < 256 || s.h < 256) return `${f.what}: ${s.w}x${s.h} is under 256 px — pick an alternate (see the plan)`;
  }
  return null;
}

const check = process.argv.includes("--check");
let bad = 0;
for (const f of files) {
  const dest = path.join(DIR, f.dest);
  let buf;
  if (check) {
    try { buf = fs.readFileSync(dest); } catch { console.error("missing " + f.dest); bad++; continue; }
  } else {
    const r = await fetch(f.url);
    if (!r.ok) { console.error(`${f.what}: HTTP ${r.status} ${f.url}`); bad++; continue; }
    buf = Buffer.from(await r.arrayBuffer());
  }
  const err = verify(f, buf);
  if (err) { console.error(err); bad++; continue; }
  if (!check) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf); }
  console.log((check ? "ok    " : "wrote ") + f.dest);
}
if (bad) { console.error(bad + " file(s) failed"); process.exit(1); }
```

- [ ] **Step 5: Vendor the files and look at them**

Run: `node tools/drawing-fetch-stickers.mjs`
Expected: eight `wrote …` lines (seven PNGs + `stickers/LICENSE`), exit 0. Then `file public/drawing/stickers/*.png` → every line `PNG image data, 256 x 256`. If any is under 256 px or a hash differs, STOP: pick the alternate from the Definitions table (update `source` + `sha256`) and re-run. Open `public/drawing/stickers/person.png` with the Read tool and confirm it reads as a child's face at a glance.

- [ ] **Step 6: Run the test**

Run: `node --test tests/drawings.test.mjs`
Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add public/drawing/stickers.json public/drawing/stickers tools/drawing-fetch-stickers.mjs tests/drawings.test.mjs
git commit -m "drawing: the sticker table + vendored Fluent Emoji 3D (MIT, sha256-pinned, commit-pinned URLs) and the fetch tool — eight fixed seats, zones and centre-out slots (spec 2026-09-30 §2.1, §6)"
```

---

### Task 2: drive.js — drawings ride the mirror; `.local` pictures are safe and go up; `mirrorDrawing(id)`

**Files:**
- Modify: `drive.js:34` (`MIRROR_SUBDIRS`), `:171` (`MIRROR_DELETES`), `:195` (`ADOPT_ON_FIRST_SYNC`), `:205-215` (`listTree`), `:228-252` (`pruneTree`), `:276` (`BYTE_COMPARE`), `:639-655` (`syncLocal`), after `mirrorBook` (`:685-708`) add `uploadLocal` + `mirrorDrawing`, `:781` exports
- Test: `tests/drive-mirror.test.mjs` (modify `:201-203`; append five tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `drive.mirrorDrawing(id) → { picture, files, skipped, removed, errors } | { blocked: "needs-local-drive" } | { error: "unknown picture" | "not-started" }`; `drive.atomically(dest, write)` (exported as-is); `drive.LOCAL_MARKER === ".local"`. `syncLocal` copies `.local` pictures up before copying down and never prunes a folder that holds `.local`.

- [ ] **Step 1: Write the failing tests** — in `tests/drive-mirror.test.mjs`, change the pinned list at `:202-203` to:

```js
  assert.deepEqual(Object.keys(drive.status().content),
    ["books", "music", "movies", "content", "clothing", "drawings"]);
```

and append at the end of the file:

```js
// ---- drawings (spec 2026-09-30 §4): a picture made on one device is on every device's shelf,
// a parent deleting its folder in Drive removes it everywhere, and a picture made with no Drive
// folder (.local) is never pruned and goes UP the moment a folder is there.
const PIC = (root, id) => path.join(root, "drawings", id);
const sceneOf = (id, s) => JSON.stringify({ v: 1, id, items: [{ s, x: 0.5, y: 0.5, w: 0.2, by: "ellie" }] });

test("drawings mirror in, a same-length scene.json rewrite still crosses, and a picture deleted in Drive leaves", async () => {
  const D = path.join(TMP, "data-drawings"), S = path.join(TMP, "My Drive", "Drawings Content");
  const id = "2026-09-30-101500-dev-b";
  fs.mkdirSync(PIC(S, id), { recursive: true });
  fs.writeFileSync(path.join(PIC(S, id), "scene.json"), sceneOf(id, "horse"));
  fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);

  await drive.sync();
  const got = path.join(PIC(D, id), "scene.json");
  assert.ok(fs.existsSync(got), "another device's picture reached this shelf");

  fs.writeFileSync(path.join(PIC(S, id), "scene.json"), sceneOf(id, "house"));   // horse -> house: same length
  await drive.sync();
  assert.match(fs.readFileSync(got, "utf8"), /"house"/, "scene.json is compared by content, not by size");

  fs.rmSync(PIC(S, id), { recursive: true });
  const r = await drive.sync();
  assert.equal(r.removed, 1);
  assert.ok(!fs.existsSync(PIC(D, id)), "a picture folder deleted in Drive is deleted here");
});

test("drawings adopt what is already there (it all came through the mirror); a .local picture stays hers", async () => {
  const D = path.join(TMP, "data-drawings-adopt"), S = path.join(TMP, "My Drive", "Adopt Content");
  const old = "2026-09-01-080000-dev-b", mine = "2026-09-02-090000-dev-a";
  fs.mkdirSync(PIC(D, old), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, old), "scene.json"), sceneOf(old, "star"));   // mirrored by an earlier sync, no ledger yet
  fs.mkdirSync(PIC(D, mine), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, mine), "scene.json"), sceneOf(mine, "tree"));
  fs.writeFileSync(path.join(PIC(D, mine), ".local"), "{}");
  fs.mkdirSync(path.join(S, "drawings"), { recursive: true });     // a folder that no longer holds `old`
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);

  await drive.sync();
  assert.ok(!fs.existsSync(PIC(D, old)), "adopted as the mirror's, then pruned: Drive does not have it");
  assert.ok(fs.existsSync(path.join(PIC(D, mine), "scene.json")), "the .local picture is hers, not the mirror's");
});

test("a .local picture is copied up on the next sync (creating <folder>/drawings is allowed) and loses its marker", async () => {
  const D = path.join(TMP, "data-drawings-up"), S = path.join(TMP, "My Drive", "Up Content");
  const owned = "2026-09-29-090000-dev-b", mine = "2026-09-30-120000-dev-a";
  fs.mkdirSync(PIC(D, owned), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, owned), "scene.json"), "{}");
  fs.writeFileSync(path.join(D, "drawings", ".mirrored.json"), JSON.stringify([owned + "/scene.json"]));
  fs.mkdirSync(PIC(D, mine), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, mine), "scene.json"), '{"v":1}');
  fs.writeFileSync(path.join(PIC(D, mine), "picture.png"), "png");
  fs.writeFileSync(path.join(PIC(D, mine), "scene.json.part"), "crash leftover");
  fs.writeFileSync(path.join(PIC(D, mine), ".local"), "{}");
  fs.mkdirSync(S, { recursive: true });                            // the family folder exists; drawings/ does not yet
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);

  const r = await drive.sync();
  assert.deepEqual(r.errors, []);
  assert.equal(fs.readFileSync(path.join(PIC(S, mine), "scene.json"), "utf8"), '{"v":1}', "her picture went up");
  assert.ok(fs.existsSync(path.join(PIC(S, mine), "picture.png")));
  assert.ok(!fs.existsSync(path.join(PIC(S, mine), ".local")), "the marker never travels");
  assert.ok(!fs.existsSync(path.join(PIC(S, mine), "scene.json.part")), "nor does a .part leftover");
  assert.ok(!fs.existsSync(path.join(PIC(D, mine), ".local")), "the mirror owns it now");
  assert.ok(fs.existsSync(path.join(PIC(D, mine), "scene.json")), "and it is still on this shelf");
  assert.ok(!fs.existsSync(PIC(D, owned)), "the mirror's copy of a picture Drive no longer has went");
});

test("a .local picture the copy-up could not carry keeps its marker and is never pruned, even if a ledger claims it", async () => {
  const D = path.join(TMP, "data-drawings-stuck"), S = path.join(TMP, "My Drive", "Stuck Content");
  const mine = "2026-09-30-130000-dev-a";
  fs.mkdirSync(PIC(D, mine), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, mine), "scene.json"), '{"v":1}');
  fs.writeFileSync(path.join(PIC(D, mine), ".local"), "{}");
  fs.writeFileSync(path.join(D, "drawings", ".mirrored.json"), JSON.stringify([mine + "/scene.json"]));
  fs.mkdirSync(path.join(S, "drawings"), { recursive: true });
  fs.chmodSync(path.join(S, "drawings"), 0o555);                   // a read-only Drive folder: the copy-up fails
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);
  try {
    const r = await drive.sync();
    assert.ok(r.errors.some(e => e.includes(mine)), "the failed copy-up is reported, not swallowed: " + JSON.stringify(r.errors));
    assert.ok(fs.existsSync(path.join(PIC(D, mine), "scene.json")), "provenance loses to the marker");
    assert.ok(fs.existsSync(path.join(PIC(D, mine), ".local")), "and the marker stays until a copy-up succeeds");
  } finally { fs.chmodSync(path.join(S, "drawings"), 0o755); }
});

test("mirrorDrawing: one picture onto this shelf now, ledger merged not replaced, blocked without a local folder", () => {
  const D = path.join(TMP, "data-drawings-one"), S = path.join(TMP, "My Drive", "One Content");
  const id = "2026-09-30-140000-dev-a", other = "2026-09-01-080000-dev-b";
  fs.mkdirSync(PIC(S, id), { recursive: true });
  fs.writeFileSync(path.join(PIC(S, id), "scene.json"), sceneOf(id, "sun"));
  fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "off" }));
  drive.start(D);
  assert.equal(drive.mirrorDrawing(id).blocked, "needs-local-drive");

  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  fs.mkdirSync(path.join(D, "drawings"), { recursive: true });
  fs.writeFileSync(path.join(D, "drawings", ".mirrored.json"), JSON.stringify([other + "/scene.json"]));
  const r = drive.mirrorDrawing(id);
  assert.equal(r.picture, id);
  assert.equal(r.files, 1);
  assert.deepEqual(r.errors, []);
  assert.ok(fs.existsSync(path.join(PIC(D, id), "scene.json")));
  const ledger = JSON.parse(fs.readFileSync(path.join(D, "drawings", ".mirrored.json"), "utf8"));
  assert.ok(ledger.includes(id + "/scene.json"), "this picture is the mirror's now");
  assert.ok(ledger.includes(other + "/scene.json"), "merged, never replaced");
  assert.equal(drive.mirrorDrawing("../books").error, "unknown picture");
  assert.equal(drive.mirrorDrawing(".local").error, "unknown picture");
  assert.equal(drive.mirrorDrawing("2026-09-30-999999-nope").error, "unknown picture");
  assert.equal(drive.LOCAL_MARKER, ".local");
  assert.equal(typeof drive.atomically, "function");
});

// The skip in listTree is only visible where an ADOPTED set is persisted: mirrorDrawing writes the
// ledger it loaded (sync writes the source's files instead). Without the skip her .local picture
// would be recorded as the mirror's, and pruned the day it left the source.
test("adoption never claims a .local picture: the first ledger a mirrorDrawing writes names only what the mirror owns", () => {
  const D = path.join(TMP, "data-drawings-ledger"), S = path.join(TMP, "My Drive", "Ledger Content");
  const old = "2026-09-01-080000-dev-b", mine = "2026-09-02-090000-dev-a", id = "2026-09-30-150000-dev-a";
  fs.mkdirSync(PIC(D, old), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, old), "scene.json"), sceneOf(old, "star"));      // came through the mirror, no ledger yet
  fs.mkdirSync(PIC(D, mine), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, mine), "scene.json"), sceneOf(mine, "tree"));
  fs.writeFileSync(path.join(PIC(D, mine), ".local"), "{}");                      // made here with no folder
  fs.mkdirSync(PIC(S, id), { recursive: true });
  fs.writeFileSync(path.join(PIC(S, id), "scene.json"), sceneOf(id, "sun"));
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);
  assert.deepEqual(drive.mirrorDrawing(id).errors, []);
  const ledger = JSON.parse(fs.readFileSync(path.join(D, "drawings", ".mirrored.json"), "utf8")).sort();
  assert.deepEqual(ledger, [old + "/scene.json", id + "/scene.json"].sort(), "her .local picture is not the mirror's to prune later");
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/drive-mirror.test.mjs`
Expected: FAIL — the pinned-list test (`drawings` missing), the sync tests (no `drawings` in the mirror set: nothing crosses, `.local` never goes up), and both `mirrorDrawing` tests (`drive.mirrorDrawing is not a function`). The file's existing tests still pass.

- [ ] **Step 3: Implement in `drive.js`**

3a. The sets (keep each block's existing comment; add one line saying why):

```js
const MIRROR_SUBDIRS = ["books", "music", "movies", "content", "clothing", "drawings"];
// …
const MIRROR_DELETES = ["clothing", "books", "music", "movies", "drawings"];
// …
// drawings (spec 2026-09-30 §4): everything under <DATA>/drawings arrived through this mirror or is
// this device's own .local work (never pruned, see LOCAL_MARKER), so the ledger may own it from day one.
const ADOPT_ON_FIRST_SYNC = ["clothing", "drawings"];
// …
// scene.json (Drawing): a sticker swapped for one with an id of the same length ("horse" -> "house")
// or a moved sticker is a same-size rewrite; under the size skip the other devices would never see it.
const BYTE_COMPARE = MANIFEST_NAMES.concat(["job.json", "scene.json"]);
```

3b. The marker, right after `saveLedger` (`:216-221`):

```js
// A folder holding LOCAL_MARKER is this device's own work made while it had no Drive folder
// (drawings.js rule 3). It is never the mirror's to judge: listTree skips it (so adoption never
// claims it) and pruneTree never enters it (so a ledger that somehow names it cannot delete it).
// syncLocal copies it UP first (uploadLocal) and only a folder that went up whole loses the marker.
const LOCAL_MARKER = ".local";
const UPLOAD_LOCAL = ["drawings"];
function hasLocalMarker(dir) {
  try { return fs.statSync(path.join(dir, LOCAL_MARKER)).isFile(); } catch { return false; }
}
```

3c. `listTree` — the directory branch becomes:

```js
    if (e.isDirectory()) { if (!hasLocalMarker(path.join(dir, r))) listTree(dir, r, out); }
```

3d. `pruneTree` — first line of the directory branch:

```js
    if (e.isDirectory()) {
      if (hasLocalMarker(abs)) continue;          // this device's own work, never the mirror's (LOCAL_MARKER)
      pruneTree(dest, keep, stats, r);
```

3e. `syncLocal` — upload before copy-down, only when the family folder is really there:

```js
function syncLocal(cfg) {
  const stats = { files: 0, skipped: 0, removed: 0, errors: [] };
  let mounted = false;
  try { mounted = fs.statSync(cfg.folderPath).isDirectory(); } catch {}
  for (const sub of MIRROR_SUBDIRS) {
    // .local work goes UP before anything comes down or is pruned (spec §4 rule 3). Never when the
    // family folder itself is missing: an offline mount is not an empty one, and the family folder
    // is never ours to create.
    if (mounted && UPLOAD_LOCAL.includes(sub)) uploadLocal(cfg.folderPath, sub, stats);
    const src = path.join(cfg.folderPath, sub);
    // …the rest of the loop exactly as it is today…
```

3f. After `mirrorBook`, add:

```js
// uploadLocal — carry every LOCAL_MARKER folder of <DATA>/<sub> up to <folderPath>/<sub>/<name>.
// Files only (a picture folder has no subfolders), never dotfiles and never a .part leftover, each
// .part-atomic. Creating <folderPath>/<sub> is allowed here (spec §4 rule 2: nothing family-only
// lives under <DATA>/drawings, so an empty source can only ever remove mirror-owned copies).
function uploadLocal(folderPath, sub, stats) {
  const root = path.join(DATA, sub);
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const from = path.join(root, e.name);
    if (!hasLocalMarker(from)) continue;
    const to = path.join(folderPath, sub, e.name);
    let ok = true;
    try {
      fs.mkdirSync(to, { recursive: true });
      for (const f of fs.readdirSync(from, { withFileTypes: true })) {
        if (!f.isFile() || f.name.startsWith(".") || f.name.endsWith(".part")) continue;
        atomically(path.join(to, f.name), (tmp) => fs.copyFileSync(path.join(from, f.name), tmp));
        stats.files++;
      }
    } catch (err) { ok = false; stats.errors.push(e.name + " (up): " + err.message); }
    if (ok) { try { fs.rmSync(path.join(from, LOCAL_MARKER)); } catch {} }
  }
}

// mirrorDrawing(id) — ONE picture from the family's Drive folder onto this device's shelf, now
// (the mirrorBook shape, spec §4): an own write lands in <folderPath>/drawings/<id>, and without
// this the shelf would wait up to ten minutes for it. One folder, copyTreeLocal (.part-atomic,
// scene.json byte-compared), ledger MERGED, no prune, no onSynced.
function mirrorDrawing(id) {
  if (!DATA) return { error: "not-started" };
  const c = loadCfg();
  if (c.mode !== "local" || !c.folderPath) return { blocked: "needs-local-drive" };
  const safe = path.basename(String(id || ""));          // a NAME, never a path
  if (!safe || safe.startsWith(".")) return { error: "unknown picture" };
  const src = path.join(c.folderPath, "drawings", safe);
  try { if (!fs.statSync(src).isDirectory()) return { error: "unknown picture" }; }
  catch { return { error: "unknown picture" }; }
  const dest = path.join(DATA, "drawings", safe);
  const stats = { files: 0, skipped: 0, removed: 0, errors: [] };
  const have = { files: new Set(), dirs: new Set() };
  copyTreeLocal(src, dest, stats, have);
  const lib = path.join(DATA, "drawings");
  const owned = loadLedger(lib, "drawings");
  for (const r of have.files) owned.add(safe + "/" + r);
  saveLedger(lib, owned);
  return { picture: safe, ...stats };
}
```

3g. Exports — add `mirrorDrawing, atomically, LOCAL_MARKER` to the `module.exports` object at `:781`. In the file header (`:5-10`) add `//   <folder>/drawings/... -> <DATA>/drawings/... (Drawing's pictures; .local = made with no folder)` to the list, and change `// Read-only scope; nothing is ever uploaded.` (`:10`) to `// Read-only Google scope (API mode uploads nothing). In local mode the one thing this mirror ever writes into the family's folder is a .local Drawing picture going up (uploadLocal).` — the old sentence stops being true in this task.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/drive-mirror.test.mjs tests/drive-localfolder.test.mjs`
Expected: both files `# fail 0` (drive-mirror: 24 before, 30 now). Prove the last test bites: temporarily revert 3c (the `listTree` skip) → it fails; restore → it passes.

- [ ] **Step 5: Commit**

```bash
git add drive.js tests/drive-mirror.test.mjs
git commit -m "drive: drawings ride the mirror — scene.json byte-compared, adopted from day one, .local pictures never pruned and copied up once a folder exists; mirrorDrawing(id) puts an own write on this shelf at once (spec 2026-09-30 §4)"
```

---
### Task 3: `drawings.js` — ids, validation, where a picture is written, the shelf list, empty cleanup

**Files:**
- Create: `drawings.js` (hub root)
- Test: `tests/drawings.test.mjs` (append the module section)

**Interfaces:**
- Consumes: `drive.status()`, `drive.mirrorDrawing(id)`, `drive.atomically(dest, write)`, `drive.LOCAL_MARKER` (T2); `public/drawing/stickers.json` (T1).
- Produces (all used by T4/T5 and the tests):
  - `ID_RE`, `LIMITS = { items: 200, sceneBytes: 65536, pngBytes: 4194304 }`
  - `start(dataDir, { deviceId, tz, now })` → `{ removed: [ids] }` (runs `cleanupEmpty()`); `tz` and `now` are functions (`() => "America/Los_Angeles"`, `() => new Date()`)
  - `isId(s) → boolean`, `shortDevice(deviceId) → string`, `newId() → string`
  - `validateScene(obj) → { ok: true, scene: { v, backdrop, items } } | { ok: false, why }`
  - `itemsHash(items) → sha1 hex`
  - `mountRoot() → "<folderPath>/drawings" | null`
  - `readScene(id) → scene | null` (canonical first, then `<DATA>` copy)
  - `create() → { id, scene } | { error: "write-failed" }`
  - `writeScene(id, body) → { ok: true, scene, mount } | { error: "bad-id" | "bad-scene" | "write-failed", why? }`
  - `list() → [{ id, created, updated, device, items, scene }]`
  - `cleanupEmpty({ olderThanMs = 86400000 }) → { removed: [ids] }`

- [ ] **Step 1: Write the failing tests** — append to `tests/drawings.test.mjs` (add `import { createRequire } from "node:module";` to the imports):

```js
// ---- §4 the module ------------------------------------------------------------
const require = createRequire(path.join(HUB, "server.js"));
const drive = require("./drive.js");
const drawings = require("./drawings.js");

const UNIT = path.join(TMP, "unit");                                 // this device's <DATA>
const MOUNT = path.join(TMP, "My Drive", "New ERA Content");          // the family's Drive folder
const H = { s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" };
let clock = new Date("2026-09-30T17:15:42Z");

// mode: "mount" (folder there) | "offline" (drive.json names a folder that is not there) | "none"
function freshUnit(mode, tz = "UTC") {
  fs.rmSync(UNIT, { recursive: true, force: true });
  fs.rmSync(path.join(TMP, "My Drive"), { recursive: true, force: true });
  fs.mkdirSync(UNIT, { recursive: true });
  if (mode !== "none") fs.writeFileSync(path.join(UNIT, "drive.json"), JSON.stringify({ mode: "local", folderPath: MOUNT }));
  if (mode === "mount") fs.mkdirSync(MOUNT, { recursive: true });
  drive.start(UNIT);
  drawings.start(UNIT, { deviceId: "kitchen-pc-3f9a", tz: () => tz, now: () => clock });
}
const onShelf = (id) => path.join(UNIT, "drawings", id);
const inDrive = (id) => path.join(MOUNT, "drawings", id);

test("an id is the date, the time (hub zone) and this device, and a taken one is never reused", () => {
  freshUnit("none");
  const a = drawings.create().id;
  assert.equal(a, "2026-09-30-171542-kitchen-pc-3f9a");
  assert.equal(drawings.create().id, a + "-2", "same second, same device: a second folder, not the first one again");
  freshUnit("none", "America/Los_Angeles");
  assert.equal(drawings.newId(), "2026-09-30-101542-kitchen-pc-3f9a", "the family's clock, not UTC");
  assert.equal(drawings.shortDevice("kitchen-pc-3f9a"), "kitchen-pc-3f9a");
  assert.equal(drawings.shortDevice("desktop-abcdefghijkl-7f3k"), "desktop-abc-7f3k", "long ids keep their random tail");
  for (const ok of [a, a + "-2", "2026-01-01-000000-gate"]) assert.equal(drawings.isId(ok), true, ok);
  for (const bad of ["../x", "2026-09-30-171542-", "2026-9-30-171542-x", "2026-09-30-171542-X",
                     "2026-09-30-171542-a/b", "index.json", "2026-09-30-171542-dev (1)", "", null])
    assert.equal(drawings.isId(bad), false, String(bad));
});

test("validation: unknown stickers, out-of-range numbers, bad splats, too many items and other versions are refused", () => {
  freshUnit("none");
  const ok = drawings.validateScene({ v: 1, backdrop: "meadow", items: [H] });
  assert.equal(ok.ok, true);
  for (const [why, items] of [
    ["unknown sticker", [{ ...H, s: "dragon" }]],
    ["x over 1", [{ ...H, x: 1.2 }]],
    ["y under 0", [{ ...H, y: -0.01 }]],
    ["w zero", [{ ...H, w: 0 }]],
    ["x a string", [{ ...H, x: "0.5" }]],
    ["by someone else", [{ ...H, by: "robot" }]],
    ["splat colour", [{ s: "splat", x: 0.5, y: 0.5, w: 0.15, by: "ellie", c: "red", seed: 3 }]],
    ["splat seed", [{ s: "splat", x: 0.5, y: 0.5, w: 0.15, by: "ellie", c: "#0F7C8A", seed: -1 }]],
    ["an item that is not an object", [7]],
  ]) assert.equal(drawings.validateScene({ v: 1, backdrop: "meadow", items }).ok, false, why);
  const many = Array.from({ length: 201 }, () => ({ s: "star", x: 0.5, y: 0.2, w: 0.1, by: "ellie" }));
  assert.equal(drawings.validateScene({ v: 1, backdrop: "meadow", items: many }).ok, false, "201 items");
  assert.equal(drawings.validateScene({ v: 1, backdrop: "meadow", items: many.slice(1) }).ok, true, "200 is the cap, not over it");
  assert.equal(drawings.validateScene({ v: 2, backdrop: "meadow", items: [] }).ok, false, "v2");
  assert.equal(drawings.validateScene({ v: 1, backdrop: "beach", items: [] }).ok, false, "one backdrop in v1");
  assert.equal(drawings.validateScene([]).ok, false);
  assert.equal(drawings.validateScene(null).ok, false);
  const norm = drawings.validateScene({ v: 1, backdrop: "meadow",
    items: [{ ...H, c: "#000000", extra: 1 }, { s: "splat", x: 0.3, y: 0.3, w: 0.15, c: "#DE7B52", seed: 9 }] });
  assert.deepEqual(norm.scene.items, [H, { s: "splat", x: 0.3, y: 0.3, w: 0.15, by: "ellie", c: "#DE7B52", seed: 9 }],
    "only known keys, in one order; colour and seed only on splats; by defaults to ellie");
});

test("with a Drive folder: the write lands in it (.part-atomic) and on this shelf at once, and the ledger owns it", () => {
  freshUnit("mount");
  const { id } = drawings.create();
  assert.ok(fs.existsSync(path.join(inDrive(id), "scene.json")), "canonical = the family's Drive folder");
  assert.ok(fs.existsSync(path.join(onShelf(id), "scene.json")), "mirrorDrawing put it on this shelf");
  assert.ok(!fs.existsSync(path.join(onShelf(id), ".local")));
  const w = drawings.writeScene(id, { v: 1, backdrop: "meadow", items: [H] });
  assert.equal(w.ok, true);
  assert.equal(w.mount, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(onShelf(id), "scene.json"), "utf8")).items.length, 1);
  assert.deepEqual(fs.readdirSync(inDrive(id)).filter(n => n.endsWith(".part")), [], "no .part left behind");
  const ledger = JSON.parse(fs.readFileSync(path.join(UNIT, "drawings", ".mirrored.json"), "utf8"));
  assert.ok(ledger.includes(id + "/scene.json"));
});

test("with no Drive folder (or an offline one): the write stays on this device, marked .local; the family folder is never created", () => {
  for (const mode of ["none", "offline"]) {
    freshUnit(mode);
    const { id } = drawings.create();
    assert.ok(fs.existsSync(path.join(onShelf(id), "scene.json")), mode);
    assert.ok(fs.existsSync(path.join(onShelf(id), ".local")), mode + ": marked as this device's own");
    assert.equal(fs.existsSync(MOUNT), false, mode + ": no folder conjured for the family");
    assert.equal(drawings.writeScene(id, { v: 1, backdrop: "meadow", items: [H] }).mount, false);
  }
});

test("the hub keeps created, device and mailedHash; a body cannot rewrite them; updated moves with every save", () => {
  freshUnit("none");
  const { id, scene } = drawings.create();
  clock = new Date("2026-09-30T17:20:00Z");
  const w = drawings.writeScene(id, { v: 1, backdrop: "meadow", items: [H],
    id: "2000-01-01-000000-evil", created: "1999-01-01T00:00:00Z", device: "evil", mailedHash: "x", updated: "1999" });
  assert.equal(w.ok, true);
  const s = drawings.readScene(id);
  assert.equal(s.id, id);
  assert.equal(s.created, scene.created);
  assert.equal(s.device, "kitchen-pc-3f9a");
  assert.equal(s.mailedHash, null);
  assert.equal(s.updated, "2026-09-30T17:20:00.000Z");
  assert.equal(drawings.writeScene("../x", { v: 1, backdrop: "meadow", items: [] }).error, "bad-id");
  assert.equal(drawings.writeScene(id, { v: 1, backdrop: "meadow", items: [{ ...H, s: "dragon" }] }).error, "bad-scene");
  clock = new Date("2026-09-30T17:15:42Z");
});

test("a write that cannot land says so in a word and never throws", () => {
  freshUnit("none");
  const { id } = drawings.create();
  fs.chmodSync(onShelf(id), 0o555);
  try {
    let r;
    assert.doesNotThrow(() => { r = drawings.writeScene(id, { v: 1, backdrop: "meadow", items: [H] }); });
    assert.equal(r.error, "write-failed");
  } finally { fs.chmodSync(onShelf(id), 0o755); }
});

// Review Focus 4: junk in the folder never reaches her shelf and never breaks it.
test("list: non-empty pictures only, newest change first; Drive conflict copies, half-written and foreign folders skipped", () => {
  freshUnit("none");
  const put = (id, items, updated, raw) => {
    fs.mkdirSync(onShelf(id), { recursive: true });
    fs.writeFileSync(path.join(onShelf(id), "scene.json"), raw || JSON.stringify(
      { v: 1, id, created: "2026-09-29T08:00:00Z", updated, device: "dev-b", backdrop: "meadow", items, mailedHash: null }));
  };
  put("2026-09-29-080000-dev-a", [H], "2026-09-30T10:00:00Z");
  put("2026-09-29-080000-dev-b", [H, H], "2026-09-30T11:00:00Z");
  put("2026-09-29-080000-dev-c", [], "2026-09-30T12:00:00Z");                    // empty: not listed
  put("2026-09-29-080000-dev-d", [H], "2026-09-30T13:00:00Z", '{"v":1,"items":[');  // half-written
  put("2026-09-29-080000-dev-b (1)", [H], "2026-09-30T14:00:00Z");                 // a Drive conflict copy
  put("2026-09-29-080000-dev-e", [{ ...H, s: "dragon" }], "2026-09-30T15:00:00Z"); // from a future version
  fs.mkdirSync(onShelf("2026-09-29-080000-dev-f"), { recursive: true });           // no scene at all
  fs.mkdirSync(onShelf("notes"), { recursive: true });
  fs.writeFileSync(path.join(UNIT, "drawings", "stray.txt"), "x");
  let l;
  assert.doesNotThrow(() => { l = drawings.list(); });
  assert.deepEqual(l.map(p => p.id), ["2026-09-29-080000-dev-b", "2026-09-29-080000-dev-a"]);
  assert.deepEqual(Object.keys(l[0]).sort(), ["created", "device", "id", "items", "scene", "updated"]);
  assert.equal(l[0].items, 2);
  assert.equal(l[0].scene.items.length, 2, "the scene rides inline so the shelf draws in one request");
});

test("cleanup: empty pictures older than a day go from both places; new, non-empty and unreadable ones stay", () => {
  freshUnit("mount");
  const mk = (root, id, items, created, raw) => {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, "scene.json"), raw || JSON.stringify({ v: 1, id, created, items }));
  };
  const drv = path.join(MOUNT, "drawings"), mine = path.join(UNIT, "drawings");
  mk(drv, "2026-09-28-080000-dev-a", [], "2026-09-28T08:00:00Z");       // empty, two days old: goes
  mk(mine, "2026-09-28-080000-dev-a", [], "2026-09-28T08:00:00Z");      // …and its mirror copy
  mk(mine, "2026-09-28-090000-dev-a", [], "2026-09-28T09:00:00Z");      // .local-style, empty and old: goes
  mk(drv, "2026-09-30-170000-dev-a", [], "2026-09-30T17:00:00Z");       // empty but 15 minutes old: stays
  mk(drv, "2026-09-20-080000-dev-a", [H], "2026-09-20T08:00:00Z");      // old but she drew on it: stays
  mk(drv, "2026-09-21-080000-dev-a", null, null, "{broken");           // unreadable: never ours to delete
  const r = drawings.cleanupEmpty();
  assert.deepEqual(r.removed.sort(), ["2026-09-28-080000-dev-a", "2026-09-28-080000-dev-a", "2026-09-28-090000-dev-a"]);
  assert.ok(!fs.existsSync(path.join(drv, "2026-09-28-080000-dev-a")));
  assert.ok(!fs.existsSync(path.join(mine, "2026-09-28-080000-dev-a")));
  for (const id of ["2026-09-30-170000-dev-a", "2026-09-20-080000-dev-a", "2026-09-21-080000-dev-a"])
    assert.ok(fs.existsSync(path.join(drv, id)), id + " stayed");
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/drawings.test.mjs`
Expected: the four T1 tests pass; the module tests FAIL with `Cannot find module './drawings.js'`.

- [ ] **Step 3: Write `drawings.js`:**

```js
// drawings.js — Drawing's pictures on the hub (spec docs/superpowers/specs/2026-09-30-drawing-design.md §4-§5).
//
// A picture is a folder drawings/<id>/ holding scene.json (the truth: backdrop + items) and, after
// Done, picture.png (for the family's mail and for a parent opening the Drive folder; the app
// never reads it). Ids are <YYYY-MM-DD>-<HHMMSS>-<device short> so two devices never make the
// same folder.
//
// THE FOUR RULES (clothing-log.js's laws, applied — spec §4). Each is a way to lose her picture.
//  1. OWN WRITES GO TO THE MOUNT when drive.json is local mode with a folderPath that exists:
//     <folderPath>/drawings/<id>/, .part + rename, then drive.mirrorDrawing(id) puts it on this
//     shelf at once. <DATA>/drawings is the mirror's destination.
//  2. CREATING <folderPath>/drawings/ IS ALLOWED (unlike clothing): nothing family-only ever lives
//     under <DATA>/drawings, so an empty source can only remove mirror-owned copies (drive.js).
//  3. NO MOUNT (Drive off, a fresh install, an offline mount): write <DATA>/drawings/<id>/ and mark
//     it .local. drive.js never prunes that folder and copies it up once a mount appears.
//  4. NOTHING HERE THROWS TO HER: a failed write is one console line and an {error} word; the
//     ring keeps the picture in memory + localStorage and retries on the next change.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const drive = require("./drive.js");

const ID_RE = /^\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9][a-z0-9-]{0,39}$/;
const LIMITS = { items: 200, sceneBytes: 64 * 1024, pngBytes: 4 * 1024 * 1024 };
const DAY = 24 * 60 * 60 * 1000;
const HEX = /^#[0-9a-fA-F]{6}$/;
const BY = ["ellie", "partner"];

let DATA = null;
let DEVICE = "hub";
let TZ = () => "UTC";
let NOW = () => new Date();
let TABLE = null;

function start(dataDir, opts = {}) {
  DATA = dataDir;
  if (opts.deviceId) DEVICE = String(opts.deviceId);
  if (typeof opts.tz === "function") TZ = opts.tz;
  if (typeof opts.now === "function") NOW = opts.now;
  const r = cleanupEmpty();
  if (r.removed.length) console.log("[drawings] cleared " + r.removed.length + " empty picture(s) older than a day");
  return r;
}

const isId = (s) => typeof s === "string" && ID_RE.test(s);
function shortDevice(id) {
  const s = String(id || "hub");
  return s.length <= 16 ? s : s.slice(0, 11).replace(/-+$/, "") + "-" + s.slice(-4);
}
// The same file the page draws its tiles from: one list of what a sticker may be.
function stickerTable() {
  if (TABLE) return TABLE;
  try { TABLE = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "drawing", "stickers.json"), "utf8")); }
  catch (e) { console.error("[drawings] stickers.json unreadable: " + e.message); return { stickers: [] }; }
  return TABLE;
}
const stamp = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : 0; };
const iso = () => NOW().toISOString();

// ---------------------------------------------------------------- where it lives
function mountRoot() {
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return null;
  try { if (!fs.statSync(st.folderPath).isDirectory()) return null; } catch { return null; }
  return path.join(st.folderPath, "drawings");
}
const shelfRoot = () => path.join(DATA, "drawings");
function taken(id) {
  return [mountRoot(), shelfRoot()].filter(Boolean).some((r) => fs.existsSync(path.join(r, id)));
}
function newId() {
  let p;
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ(), year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(NOW()).map((x) => [x.type, x.value]));
  } catch { return newIdUtc(); }
  return free(`${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}${p.second}-${shortDevice(DEVICE)}`);
}
function newIdUtc() {
  const s = NOW().toISOString();   // 2026-09-30T17:15:42.000Z
  return free(s.slice(0, 10) + "-" + s.slice(11, 13) + s.slice(14, 16) + s.slice(17, 19) + "-" + shortDevice(DEVICE));
}
function free(base) {
  for (let n = 1; n < 100; n++) { const id = n === 1 ? base : base + "-" + n; if (!taken(id)) return id; }
  return base + "-" + crypto.randomBytes(2).toString("hex");
}

// Rule 1 / rule 3 in one place. Never throws (rule 4).
function writeFile(id, name, buf) {
  const m = mountRoot();
  const dir = path.join(m || shelfRoot(), id);
  try {
    fs.mkdirSync(dir, { recursive: true });                  // rule 2: <folderPath>/drawings may be created
    if (!m) {
      const mk = path.join(dir, drive.LOCAL_MARKER);
      if (!fs.existsSync(mk)) fs.writeFileSync(mk, JSON.stringify({ device: DEVICE, since: iso() }) + "\n");
    }
    drive.atomically(path.join(dir, name), (tmp) => fs.writeFileSync(tmp, buf));
  } catch (e) {
    console.error("[drawings] " + id + "/" + name + " not written: " + e.message);
    return { ok: false };
  }
  if (m) {
    const r = drive.mirrorDrawing(id) || {};
    if (r.error || r.blocked || (r.errors || []).length)
      console.error("[drawings] " + id + " is in Drive but not on this shelf yet: " + (r.error || r.blocked || r.errors.join("; ")));
  }
  return { ok: true, mount: !!m };
}
const sceneBytes = (scene) => Buffer.from(JSON.stringify(scene, null, 1) + "\n");

function readScene(id) {
  if (!isId(id) || !DATA) return null;
  for (const root of [mountRoot(), shelfRoot()].filter(Boolean)) {
    try {
      const sc = JSON.parse(fs.readFileSync(path.join(root, id, "scene.json"), "utf8"));
      if (sc && typeof sc === "object" && !Array.isArray(sc)) return sc;
    } catch { /* not here, or half-written: try the next place */ }
  }
  return null;
}

// ---------------------------------------------------------------- validation
const num01 = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
function validateScene(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, why: "not an object" };
  if (obj.v !== 1) return { ok: false, why: "v must be 1" };
  if (obj.backdrop !== undefined && obj.backdrop !== "meadow") return { ok: false, why: "unknown backdrop" };
  if (!Array.isArray(obj.items)) return { ok: false, why: "items must be a list" };
  if (obj.items.length > LIMITS.items) return { ok: false, why: "more than " + LIMITS.items + " items" };
  const known = new Set(stickerTable().stickers.map((s) => s.id));
  const items = [];
  for (let i = 0; i < obj.items.length; i++) {
    const it = obj.items[i];
    if (!it || typeof it !== "object" || Array.isArray(it)) return { ok: false, why: `item ${i} is not an object` };
    if (!known.has(it.s)) return { ok: false, why: `item ${i}: unknown sticker` };
    if (!num01(it.x) || !num01(it.y)) return { ok: false, why: `item ${i}: x/y outside 0-1` };
    if (!num01(it.w) || it.w === 0) return { ok: false, why: `item ${i}: w outside (0,1]` };
    const by = it.by === undefined ? "ellie" : it.by;
    if (!BY.includes(by)) return { ok: false, why: `item ${i}: by` };
    const out = { s: it.s, x: it.x, y: it.y, w: it.w, by };
    if (it.s === "splat") {
      if (typeof it.c !== "string" || !HEX.test(it.c)) return { ok: false, why: `item ${i}: splat colour` };
      if (!Number.isInteger(it.seed) || it.seed < 0 || it.seed > 0xFFFFFFFF) return { ok: false, why: `item ${i}: splat seed` };
      out.c = it.c; out.seed = it.seed;
    }
    items.push(out);
  }
  return { ok: true, scene: { v: 1, backdrop: "meadow", items } };
}
const itemsHash = (items) => crypto.createHash("sha1").update(JSON.stringify(items)).digest("hex");

// ---------------------------------------------------------------- create / write
function create() {
  const id = newId(), t = iso();
  const scene = { v: 1, id, created: t, updated: t, device: DEVICE, backdrop: "meadow", items: [], mailedHash: null };
  return writeFile(id, "scene.json", sceneBytes(scene)).ok ? { id, scene } : { error: "write-failed" };
}
// The body brings backdrop + items; the hub owns id, created, device, updated and mailedHash.
function writeScene(id, body) {
  if (!isId(id)) return { error: "bad-id" };
  const v = validateScene(body);
  if (!v.ok) return { error: "bad-scene", why: v.why };
  const prev = readScene(id);
  const scene = { v: 1, id, created: (prev && prev.created) || iso(), updated: iso(),
                  device: (prev && prev.device) || DEVICE, backdrop: "meadow", items: v.scene.items,
                  mailedHash: (prev && prev.mailedHash) || null };
  const w = writeFile(id, "scene.json", sceneBytes(scene));
  return w.ok ? { ok: true, scene, mount: w.mount } : { error: "write-failed" };
}

// ---------------------------------------------------------------- the shelf
function list() {
  let names = [];
  try { names = fs.readdirSync(shelfRoot()); } catch { return []; }
  const out = [];
  for (const id of names) {
    if (!isId(id)) continue;                                   // conflict copies, notes, strays
    let sc;
    try { sc = JSON.parse(fs.readFileSync(path.join(shelfRoot(), id, "scene.json"), "utf8")); } catch { continue; }
    const v = validateScene(sc);
    if (!v.ok || !v.scene.items.length) continue;              // unreadable, foreign, or blank
    out.push({ id, created: sc.created || null, updated: sc.updated || sc.created || null,
               device: sc.device || null, items: v.scene.items.length, scene: { ...sc, items: v.scene.items } });
  }
  return out.sort((a, b) => stamp(b.updated) - stamp(a.updated) || stamp(b.created) - stamp(a.created)
                          || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

// A "New picture" she left blank never clutters any shelf: at boot, an EMPTY picture older than a
// day goes from the Drive folder and from this device. Anything unreadable is left alone.
function cleanupEmpty({ olderThanMs = DAY } = {}) {
  const removed = [];
  if (!DATA) return { removed };
  const now = NOW().getTime();
  for (const root of [mountRoot(), shelfRoot()].filter(Boolean)) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const id of names) {
      if (!isId(id)) continue;
      const dir = path.join(root, id);
      let sc;
      try { sc = JSON.parse(fs.readFileSync(path.join(dir, "scene.json"), "utf8")); } catch { continue; }
      if (!sc || !Array.isArray(sc.items) || sc.items.length) continue;
      let born = stamp(sc.created);
      if (!born) { try { born = fs.statSync(dir).mtimeMs; } catch { continue; } }
      if (now - born < olderThanMs) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(id); }
      catch (e) { console.error("[drawings] could not clear " + id + ": " + e.message); }
    }
  }
  return { removed };
}

module.exports = { ID_RE, LIMITS, start, isId, shortDevice, stickerTable, newId, validateScene, itemsHash,
                   mountRoot, readScene, create, writeScene, list, cleanupEmpty };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/drawings.test.mjs`
Expected: `# pass 12`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add drawings.js tests/drawings.test.mjs
git commit -m "drawings: the hub module — ids that never collide across devices, validated scenes, own writes to the Drive folder (or .local with none), the shelf list and the one-day blank cleanup (spec 2026-09-30 §4)"
```

---
### Task 4: The routes — index, allocate, save a scene, read a scene/PNG; boot; the payload knows the module

**Files:**
- Modify: `server.js` — require (`:27`, after `booksShelf`), routes (insert just above `if ((req.method === "GET" || req.method === "HEAD") && urlPath.startsWith("/books/"))`, `:2466`), boot (after `booksShare.start(DATA);`, `:3495`)
- Modify: `tools/build-payload.sh:30` (engine-file list)
- Test: `tests/drawings.test.mjs` (append the routes section)

**Interfaces:**
- Consumes: `drawings.{isId, LIMITS, list, create, writeScene, start}` (T3); `ownDoor`, `serveMediaJail` (server.js).
- Produces: the routes table in Definitions except Done (T5).

- [ ] **Step 1: Write the failing tests** — in `tests/drawings.test.mjs`: change the `child_process` import to `import { execFileSync, spawn } from "node:child_process";`, add `import http from "node:http";`, DELETE the T1 line `after(() => fs.rmSync(TMP, { recursive: true, force: true }));` (the combined `after` below replaces it), then append:

```js
// ---- §5 the routes: the REAL server.js on a scratch port ------------------------
// 8477 (hub) + 8479 (fake Resend, used by T5): swept free 9/30 across all five repos' tests/ and
// every open worktree, and not listening (ss -ltn). The hub's Drive folder is a temp dir.
const PORT = Number(process.env.ERA_TEST_DRAWINGS_PORT) || 8477;
const FAKE = 8479;
const BASE = `http://127.0.0.1:${PORT}`;
const RT = path.join(TMP, "routes");
const RT_MOUNT = path.join(TMP, "Route Drive", "New ERA Content");
const SEAMS = {
  ERA_AI_URL: "http://127.0.0.1:1", ERA_ELEVEN_URL: "http://127.0.0.1:1", ERA_FAL_URL: "http://127.0.0.1:1",
  ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1",
  ERA_GEOCODE_URL: "http://127.0.0.1:1/geocode", ERA_TMDB_URL: "http://127.0.0.1:1",
  ERA_STREAMING_URL: "http://127.0.0.1:1",
};
const got = [];            // every email the fake provider accepted
let fakeMode = "ok";       // ok | down
let child, fake;

before(async () => {
  fake = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (fakeMode === "down") { res.writeHead(500).end("boom"); return; }
      got.push(JSON.parse(b));
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"id":"x"}');
    });
  });
  await new Promise((r) => fake.listen(FAKE, "127.0.0.1", r));
  fs.mkdirSync(RT, { recursive: true });
  fs.mkdirSync(RT_MOUNT, { recursive: true });
  fs.writeFileSync(path.join(RT, "profile.json"), JSON.stringify({ childName: "Maya" }));
  fs.writeFileSync(path.join(RT, "drive.json"), JSON.stringify({ mode: "local", folderPath: RT_MOUNT }));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: RT, ERA_BIND: "127.0.0.1", ERA_DEVICE_ID: "test-dev", ERA_NO_UPDATE: "1",
           ...SEAMS, ERA_RESEND_URL: `http://127.0.0.1:${FAKE}/emails` },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server never came up");
});
after(() => {
  if (child) child.kill("SIGKILL");
  if (fake) fake.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const call = (method, url, body, headers = {}) => fetch(BASE + url, { method,
  headers: { "Content-Type": "application/json", ...headers },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const sceneOf = (items) => ({ v: 1, backdrop: "meadow", items });
const newPic = async () => (await (await call("POST", "/drawings", {})).json()).id;

test("POST /drawings allocates a picture in the family's Drive folder; a blank one is not on the shelf", async () => {
  const r = await call("POST", "/drawings", {});
  assert.equal(r.status, 200);
  const { id } = await r.json();
  assert.match(id, /^\d{4}-\d{2}-\d{2}-\d{6}-test-dev(-\d+)?$/);
  assert.ok(fs.existsSync(path.join(RT_MOUNT, "drawings", id, "scene.json")), "canonical = the Drive folder");
  assert.deepEqual(await (await fetch(BASE + "/drawings/index.json")).json(), []);
  const sc = await (await fetch(`${BASE}/drawings/${id}/scene.json`)).json();
  assert.deepEqual(sc.items, []);
  assert.equal(sc.device, "test-dev");
});

test("PUT scene.json validates and saves, and the shelf lists the picture with its scene inline", async () => {
  const id = await newPic();
  let r = await call("PUT", `/drawings/${id}/scene.json`, sceneOf([H]));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.match(j.updated, /^\d{4}-\d{2}-\d{2}T/);
  const row = (await (await fetch(BASE + "/drawings/index.json")).json()).find((p) => p.id === id);
  assert.equal(row.items, 1);
  assert.deepEqual(row.scene.items, [H]);
  r = await call("PUT", `/drawings/${id}/scene.json`, sceneOf([{ ...H, s: "dragon" }]));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "bad-scene");
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, "{not json")).status, 400);
  assert.equal((await call("PUT", "/drawings/not-an-id/scene.json", sceneOf([H]))).status, 404);
  const big = JSON.stringify(sceneOf([H])) + " ".repeat(66 * 1024);
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, big)).status, 413);
});

test("the doors: a page on another site, or a body that is not JSON, cannot create or overwrite a picture", async () => {
  const id = await newPic();
  assert.equal((await call("POST", "/drawings", {}, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await fetch(BASE + "/drawings", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 403);
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, sceneOf([H]), { "Sec-Fetch-Site": "cross-site" })).status, 403);
});

test("GET is path-jailed: an id's scene.json and picture.png, nothing beside or above them", async () => {
  const id = await newPic();
  assert.equal((await fetch(`${BASE}/drawings/${id}/scene.json`)).status, 200);
  assert.equal((await fetch(`${BASE}/drawings/${id}/picture.png`)).status, 404, "no Done yet");
  for (const bad of [`/drawings/${id}/.local`, `/drawings/${id}/scene.json.part`, "/drawings/notes/scene.json",
                     "/drawings/..%2fdrive.json/scene.json", "/drawings/%2e%2e/scene.json"])
    assert.ok([403, 404].includes((await fetch(BASE + bad)).status), bad);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/drawings.test.mjs`
Expected: T1/T3 tests pass; the four route tests FAIL (the hub answers `404 not found` for `/drawings`, so `r.status` is 404, not 200).

- [ ] **Step 3: Wire `server.js`**

3a. Require, after `const booksShelf = require("./books-shelf.js");`:

```js
const drawings = require("./drawings.js");   // Drawing's pictures (spec 2026-09-30 §4-§5)
```

3b. Routes, inserted immediately above the `/books/` GET static route:

```js
  // ---- Drawing (spec 2026-09-30 §5): the pictures, their scenes, the Done door. drawings.js does
  // the work — every write goes to the family's Drive folder, or .local when there is none.
  if (req.method === "GET" && urlPath === "/drawings/index.json") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(drawings.list()));
    return;
  }
  if (req.method === "POST" && urlPath === "/drawings") {
    if (!ownDoor(req, res)) return;                 // a page on another site may not make pictures
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      const r = drawings.create();
      res.writeHead(r.error ? 500 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.error ? { error: r.error } : { id: r.id }));
    });
    return;
  }
  const drawingPath = /^\/drawings\/([^/]+)\/(scene\.json|picture\.png|done)$/.exec(urlPath);
  if (drawingPath && req.method === "PUT" && drawingPath[2] === "scene.json") {
    if (!ownDoor(req, res)) return;                 // …nor overwrite hers
    const id = drawingPath[1];
    if (!drawings.isId(id)) { res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"bad-id"}'); return; }
    const chunks = [];
    let size = 0, over = false;
    req.on("data", (c) => {
      if (over) return;
      size += c.length;
      if (size > drawings.LIMITS.sceneBytes) {
        over = true;
        res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
        res.end('{"error":"too-big"}', () => { try { req.destroy(); } catch {} });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (over) return;
      let obj = null;
      try { obj = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      const r = drawings.writeScene(id, obj);
      res.writeHead(r.ok ? 200 : r.error === "write-failed" ? 500 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.ok ? { ok: true, updated: r.scene.updated } : { error: r.error, why: r.why }));
    });
    return;
  }
  if (drawingPath && (req.method === "GET" || req.method === "HEAD") && drawingPath[2] !== "done") {
    serveMediaJail(req, res, path.join(DATA, "drawings"), drawingPath[1] + "/" + drawingPath[2],
      [".json", ".png"], [], [], (id) => (drawings.isId(id) ? id : null));
    return;
  }
```

3c. Boot, right after `booksShare.start(DATA);`:

```js
  // Drawing (spec 2026-09-30 §4): the device that signs new picture ids, the family's clock for them,
  // and the one-day sweep of blank pictures. After drive.start: it reads drive.json.
  drawings.start(DATA, { deviceId: DEVICE_ID, tz: () => TZ });
```

3d. `tools/build-payload.sh:30`: add `"$HUB/drawings.js"` right after `"$HUB/books-shelf.js"` in the `cp` list (the require-scan below it fails the cut if this is forgotten).

- [ ] **Step 4: Run the tests**

Run: `node --test tests/drawings.test.mjs`
Expected: `# pass 16`, `# fail 0`.
Also run: `node --test tests/books.test.mjs tests/routes.test.mjs` → `# fail 0` (the new block sits beside the books routes).

- [ ] **Step 5: Commit**

```bash
git add server.js tools/build-payload.sh tests/drawings.test.mjs
git commit -m "drawings: the routes — index, allocate, save a scene (own-door, 64 KB, validated), path-jailed scene/PNG reads; boot sweep; drawings.js in the payload (spec 2026-09-30 §5)"
```

---

### Task 5: Done — save the PNG, mail it only when it changed, never fail the save

**Files:**
- Modify: `drawings.js` (add `done`, `setMailedHash`, `pictureHtml`; export `done`)
- Modify: `server.js` — `resendSend` (`:1288-1302`) gains the optional fifth argument; `DRAWING_MAIL` right after `resendSend`; the Done route inside the drawings block (after the PUT branch)
- Test: `tests/drawings.test.mjs` (append), `tests/mail.test.mjs` (append one test)

**Interfaces:**
- Consumes: T3/T4; `readBinaryBody`, `mailConfigured`, `resendKey`, `PROFILE`, `TZ` (server.js).
- Produces: `drawings.done(id, pngBuffer, mail) → Promise<{ saved: true, mail, reason? } | { error, status }>` where `mail = { configured(): boolean, send(subject, html, attachments): Promise<{ok, error?}>, who(): string, when(): string }`; `resendSend(key, to, subject, html, attachments?)`; `POST /drawings/<id>/done`.

- [ ] **Step 1: Write the failing tests** — append to `tests/drawings.test.mjs`:

```js
// ---- §5 Done: save the PNG, mail it only when it changed --------------------------
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const finish = (id, body = PNG_1x1, headers = {}) => fetch(`${BASE}/drawings/${id}/done`,
  { method: "POST", headers: { "Content-Type": "image/png", ...headers }, body });
async function pictureWith(items) {
  const id = await newPic();
  if (items) assert.equal((await call("PUT", `/drawings/${id}/scene.json`, sceneOf(items))).status, 200);
  return id;
}

test("Done saves the PNG where the scene lives and says no-email while no family email is set up", async () => {
  const id = await pictureWith([H]);
  const r = await finish(id);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { saved: true, mail: "no-email" });
  assert.ok(fs.readFileSync(path.join(RT_MOUNT, "drawings", id, "picture.png")).equals(PNG_1x1), "in the family's Drive folder");
  assert.ok(fs.existsSync(path.join(RT, "drawings", id, "picture.png")), "and on this device's shelf");
  const g = await fetch(`${BASE}/drawings/${id}/picture.png`);
  assert.equal(g.status, 200);
  assert.match(g.headers.get("content-type") || "", /image\/png/);
  assert.equal(got.length, 0, "nothing was mailed");
});

test("Done refuses what is not a PNG, what is too big, a picture that does not exist, and another site", async () => {
  const id = await pictureWith([H]);
  let r = await finish(id, Buffer.from("GIF89a, not a png"));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "not-png");
  // readBinaryBody pauses (never resets) an over-cap body so this 413 is readable (server.js:1512-1545)
  r = await finish(id, Buffer.concat([PNG_1x1, Buffer.alloc(4 * 1024 * 1024)]));
  assert.equal(r.status, 413);
  assert.equal((await finish("2026-01-01-000000-nobody")).status, 404);
  assert.equal((await finish(id, PNG_1x1, { "Sec-Fetch-Site": "cross-site" })).status, 403);
});

test("a blank picture is saved and never mailed", async () => {
  const id = await pictureWith(null);
  assert.deepEqual(await (await finish(id)).json(), { saved: true, mail: "empty" });
  assert.ok(fs.existsSync(path.join(RT_MOUNT, "drawings", id, "picture.png")));
});

test("with a family email: sent with the PNG attached; unchanged on a second Done; sent again after a change", async () => {
  const cfg = await call("POST", "/mail-config", { email: "family@example.com", apiKey: "re_test_key" });
  assert.equal((await cfg.json()).ok, true, "the fake provider took the test email");
  const before = got.length;
  const id = await pictureWith([H]);
  assert.deepEqual(await (await finish(id)).json(), { saved: true, mail: "sent" });
  assert.equal(got.length, before + 1);
  const m = got[got.length - 1];
  assert.equal(m.subject, "🎨 Maya made a picture");
  assert.equal(m.from, "The Pencil <onboarding@resend.dev>");
  assert.deepEqual(m.to, ["family@example.com"]);
  assert.deepEqual(m.attachments, [{ filename: id + ".png", content: PNG_1x1.toString("base64") }]);
  assert.match(m.html, /Maya made a picture/);
  const stored = JSON.parse(fs.readFileSync(path.join(RT_MOUNT, "drawings", id, "scene.json"), "utf8"));
  assert.match(stored.mailedHash, /^[0-9a-f]{40}$/);
  assert.deepEqual(await (await finish(id)).json(), { saved: true, mail: "unchanged" });
  assert.equal(got.length, before + 1, "the same picture is not mailed twice");
  await call("PUT", `/drawings/${id}/scene.json`, sceneOf([H, { s: "star", x: 0.5, y: 0.17, w: 0.1, by: "ellie" }]));
  assert.deepEqual(await (await finish(id)).json(), { saved: true, mail: "sent" });
  assert.equal(got.length, before + 2);
});

test("a send that fails still saves, says failed with the reason, and the next Done tries again", async () => {
  const id = await pictureWith([H]);
  fakeMode = "down";
  try {
    const r = await (await finish(id)).json();
    assert.equal(r.saved, true);
    assert.equal(r.mail, "failed");
    assert.match(r.reason, /Resend answered 500/);
  } finally { fakeMode = "ok"; }
  assert.ok(fs.existsSync(path.join(RT_MOUNT, "drawings", id, "picture.png")));
  assert.deepEqual(await (await finish(id)).json(), { saved: true, mail: "sent" }, "a failed mail recorded no mailedHash");
});
```

Append to `tests/mail.test.mjs` (after its last test; the file's email is configured and `mode` is `"ok"` by then):

```js
// Drawing (spec 2026-09-30 §5) taught resendSend a fifth argument; the Pencil's own email must not change.
test("the Pencil's email body is exactly what it was: no attachments key", async () => {
  const j = await (await publish("a plain note")).json();
  assert.equal(j.mailed, true);
  const last = got[got.length - 1];
  assert.equal("attachments" in last, false);
  assert.deepEqual(Object.keys(last).sort(), ["from", "html", "subject", "to"]);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/drawings.test.mjs tests/mail.test.mjs`
Expected: the five Done tests FAIL (404 for `/done`); `mail.test.mjs` all pass (its new test pins today's shape before the change).

- [ ] **Step 3: Implement**

3a. `drawings.js` — add before `module.exports`, and add `done` to the exports:

```js
// ---------------------------------------------------------------- Done (spec §2.3, §5)
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
function pictureHtml(who, when) {
  return "<div style=\"font-family:Georgia,serif\">" +
    "<p style=\"font-size:26px;line-height:1.4\">🎨 " + esc(who) + " made a picture.</p>" +
    "<p style=\"color:#777\">It is attached" + (when ? " · " + esc(when) : "") + ".</p>" +
    "<p style=\"color:#999;font-size:13px\">Made with Drawing, in Our Era Comms.</p></div>";
}
// Only mailedHash moves: a PUT that landed while the mail was in flight keeps its items, and the
// next Done then sees a changed picture and mails it again — which is the truth.
function setMailedHash(id, hash) {
  const cur = readScene(id);
  if (!cur) return false;
  cur.mailedHash = hash;
  return writeFile(id, "scene.json", sceneBytes(cur)).ok;
}
// The PNG is saved first and whatever happens to the mail the save stands. The answer's `mail`
// is for the partner line only — the page never speaks it (the Pencil's truth rule).
async function done(id, png, mail) {
  if (!isId(id)) return { error: "bad-id", status: 404 };
  const scene = readScene(id);
  if (!scene) return { error: "no-such-picture", status: 404 };
  if (!Buffer.isBuffer(png) || png.length < 8 || !png.subarray(0, 8).equals(PNG_SIG)) return { error: "not-png", status: 400 };
  if (!writeFile(id, "picture.png", png).ok) return { error: "write-failed", status: 500 };
  const items = Array.isArray(scene.items) ? scene.items : [];
  if (!items.length) return { saved: true, mail: "empty" };          // a blank meadow is never mailed
  const hash = itemsHash(items);
  if (hash === scene.mailedHash) return { saved: true, mail: "unchanged" };
  if (!mail || !mail.configured()) return { saved: true, mail: "no-email" };
  const who = (mail.who && mail.who()) || "Your artist";
  let v;
  try {
    v = await mail.send("🎨 " + who + " made a picture", pictureHtml(who, mail.when ? mail.when() : ""),
                        [{ filename: id + ".png", content: png.toString("base64") }]);
  } catch (e) { v = { ok: false, error: String((e && e.message) || e) }; }
  if (!v || !v.ok) {
    console.error("[drawings] " + id + " saved; mail failed: " + ((v && v.error) || "unknown"));
    return { saved: true, mail: "failed", reason: (v && v.error) || "failed" };
  }
  setMailedHash(id, hash);
  return { saved: true, mail: "sent" };
}
```

3b. `server.js` `resendSend` becomes:

```js
async function resendSend(key, to, subject, html, attachments) {
  const ctl = new AbortController();
  // Drawing's picture (spec 2026-09-30 §5) rides as a 1-2 MB base64 attachment; 8 s is a text
  // email's budget and a slow home link needs more. The Pencil's body and timeout are unchanged.
  const withFiles = Array.isArray(attachments) && attachments.length > 0;
  const timer = setTimeout(() => ctl.abort(), withFiles ? 30000 : 8000);
  try {
    const payload = { from: "The Pencil <onboarding@resend.dev>", to: [to], subject, html };
    if (withFiles) payload.attachments = attachments;
    const r = await fetch(RESEND_URL, {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    // …the rest of the function exactly as it is today…
```

and right after the function:

```js
// Drawing's Done mails through the Pencil's own door — same key, same family address, same sender.
// drawings.js decides WHETHER (changed since the last mail, email set up); this says HOW.
const DRAWING_MAIL = {
  configured: () => mailConfigured(),
  who: () => PROFILE.childName || "Your artist",
  when: () => new Date().toLocaleString("en-US", { timeZone: TZ }),
  send: (subject, html, attachments) => resendSend(resendKey(), PROFILE.publishEmail, subject, html, attachments),
};
```

3c. The Done route, inside the drawings block right after the PUT branch:

```js
  if (drawingPath && req.method === "POST" && drawingPath[2] === "done") {
    // ownDoor() insists on JSON and this body is a PNG, so keep the half that matters: the
    // browser's own Sec-Fetch-Site (the /books/import precedent). curl and the suites send none.
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "That came from somewhere else, so Our Era Comms did not do it." }));
      return;
    }
    const id = drawingPath[1];
    if (!drawings.isId(id)) { res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"bad-id"}'); return; }
    readBinaryBody(req, drawings.LIMITS.pngBytes, (err, tmp) => {
      if (err) {
        if (err.error === "aborted") { try { res.destroy(); } catch {} return; }
        const big = err.error === "too-big";
        res.writeHead(big ? 413 : 500, { "Content-Type": "application/json", ...(big ? { Connection: "close" } : {}) });
        res.end(JSON.stringify({ error: err.error }), () => { if (big) { try { req.destroy(); } catch {} } });
        return;
      }
      let png = null;
      try { png = fs.readFileSync(tmp); } catch {} finally { fs.unlink(tmp, () => {}); }   // ON EVERY PATH
      drawings.done(id, png, DRAWING_MAIL).then((r) => {
        res.writeHead(r.error ? r.status : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r.error ? { error: r.error } : r));
      }).catch((e) => {
        console.error("[drawings] done " + id + ": " + e.message);
        try { res.writeHead(500, { "Content-Type": "application/json" }).end('{"error":"write-failed"}'); } catch {}
      });
    });
    return;
  }
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/drawings.test.mjs tests/mail.test.mjs tests/pencil-ui.test.mjs`
Expected: `drawings` `# pass 21`, `mail` and `pencil-ui` `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add drawings.js server.js tests/drawings.test.mjs tests/mail.test.mjs
git commit -m "drawings: Done saves the PNG and mails it to the family only when the picture changed (attachment through the Pencil's door, 30 s for a picture); a blank one is never mailed; a failed mail never fails the save (spec 2026-09-30 §2.3, §5)"
```

---
### Task 6: `scene.js` — landing, splats, the celebration sentence, and THE scene renderer

**Files:**
- Create: `public/drawing/scene.js` (ES module, no DOM at import time — node imports it)
- Test: `tests/drawing-scene.test.mjs` (new; pure node, no hub, no browser)

**Interfaces:**
- Consumes: the `stickers.json` table (T1), passed in as `table`.
- Produces (named exports): `ASPECT`, `MEADOW`, `SPLAT_COLOURS`, `stickerById(table, id)`, `clampItem({x, y, w}) → {x, y}`, `landing(id, items, table, rand = Math.random) → {x, y, w, c?, seed?} | null`, `splatPath(seed) → string`, `describe(items, table) → string`, `meadowCss() → string`, `sceneOps(scene, table) → [{i, s, kind: "img"|"splat", src, d, fill, left, top, width, height}]` (fractions of scene W and H), `renderScene(target, scene, { table, images })`. The DOM backend gives each item element `class="item"` and `data-i="<index>"`; T8/T9 rely on both.

- [ ] **Step 1: Write the failing tests** — create `tests/drawing-scene.test.mjs`:

```js
// drawing-scene.test.mjs — Drawing's scene logic (spec 2026-09-30 §2.1, §2.3, §3): where a sticker
// lands, what a splat looks like, what the celebration says, and the ONE geometry the ring, the
// shelf thumbnails and the mailed PNG all draw from. Pure: no hub, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASPECT, MEADOW, SPLAT_COLOURS, clampItem, landing, splatPath, describe, meadowCss, sceneOps }
  from "../public/drawing/scene.js";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = JSON.parse(fs.readFileSync(path.join(HUB, "public", "drawing", "stickers.json"), "utf8"));
const put = (items, id) => { const at = landing(id, items, T); items.push({ s: id, ...at, by: "ellie" }); return at; };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

test("the first ground sticker lands in the first centre-out slot, its bottom edge on the grass", () => {
  const at = landing("horse", [], T);
  assert.deepEqual(at, { x: 0.5, y: 0.82, w: 0.2 });           // base 0.92 - w/2
});

test("a zone fills centre-out, counts only its own stickers, then laps with +0.04", () => {
  const items = [];
  put(items, "sun"); put(items, "cloud");                        // sky things do not use ground slots
  const xs = [];
  for (let k = 0; k < 7; k++) xs.push(put(items, "horse").x);
  assert.deepEqual(xs, [0.5, 0.35, 0.65, 0.2, 0.8, 0.07, 0.93].map(x => clampItem({ x, y: 0.5, w: 0.2 }).x));
  const lap = put(items, "horse");
  near(lap.x, 0.54, "second lap x"); near(lap.y, 0.86, "second lap y");
});

test("sun, cloud and star share the sky slots, all above the horizon", () => {
  const items = [];
  assert.deepEqual(put(items, "sun"), { x: 0.5, y: 0.17, w: 0.16 });
  assert.deepEqual(put(items, "star"), { x: 0.33, y: 0.25, w: 0.1 });
  for (let k = 0; k < 5; k++) { const at = put(items, "cloud"); assert.ok(at.y + at.w / 2 < T.horizon, JSON.stringify(at)); }
});

test("nothing ever lands outside the picture, however many laps", () => {
  const items = [];
  for (let k = 0; k < 60; k++) {
    const at = put(items, "tree");
    const hx = at.w / ASPECT / 2, hy = at.w / 2;
    assert.ok(at.x >= hx - 1e-9 && at.x <= 1 - hx + 1e-9 && at.y >= hy - 1e-9 && at.y <= 1 - hy + 1e-9, JSON.stringify(at));
  }
});

test("a splat takes a slot from the fixed list, a size 0.12-0.18, a palette colour and a seed", () => {
  const seq = [0.99, 0.5, 0.26, 0.4];                            // slot 11, size .15, colour 1, seed
  let k = 0;
  const at = landing("splat", [], T, () => seq[k++]);
  const slot = T.zones.any.slots[11];
  assert.deepEqual({ x: at.x, y: at.y }, clampItem({ x: slot.x, y: slot.y, w: at.w }));
  near(at.w, 0.15, "size");
  assert.equal(at.c, SPLAT_COLOURS[1]);
  assert.equal(at.seed, Math.floor(0.4 * 2147483647));
  assert.ok(!SPLAT_COLOURS.some(c => /^#(b2|c0|d0|e0|ff)[0-3]/i.test(c)), "no red in her palette");
});

test("splatPath is deterministic, 8-12 points, inside the unit box", () => {
  assert.equal(splatPath(7), splatPath(7));
  assert.notEqual(splatPath(7), splatPath(8));
  for (const seed of [0, 1, 7, 99, 123456, 2147483646]) {
    const d = splatPath(seed);
    const n = (d.match(/Q/g) || []).length;
    assert.ok(n >= 8 && n <= 12, seed + ": " + n + " points");
    for (const v of d.match(/-?\d+\.\d+/g).map(Number)) assert.ok(v >= -1 && v <= 1, seed + ": " + v);
    assert.match(d, /^M.*Z$/);
  }
});

test("the celebration names what she made, counted, in the order she made it", () => {
  const I = (...ids) => ids.map(s => ({ s }));
  assert.equal(describe([], T), "You made a picture!");
  assert.equal(describe(I("horse"), T), "You made a picture with a horse!");
  assert.equal(describe(I("horse", "house"), T), "You made a picture with a horse and a house!");
  assert.equal(describe(I("horse", "house", "star", "star"), T), "You made a picture with a horse, a house and two stars!");
  assert.equal(describe(I("person", "person", "person"), T), "You made a picture with three people!");
  assert.equal(describe(I(...Array(13).fill("splat")), T), "You made a picture with 13 splats!");
  assert.doesNotMatch(describe(I("sun"), T), /sent|wrong/i);
});

test("one geometry for the ring, the thumbnails and the PNG: boxes in scene fractions", () => {
  const ops = sceneOps({ v: 1, backdrop: "meadow", items: [
    { s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" },
    { s: "splat", x: 0.45, y: 0.33, w: 0.15, by: "ellie", c: "#DE7B52", seed: 5 },
    { s: "dragon", x: 0.5, y: 0.5, w: 0.2, by: "ellie" },                 // a sticker this version does not know
  ] }, T);
  assert.equal(ops.length, 2, "unknown stickers are skipped, never thrown on");
  const [h, sp] = ops;
  assert.equal(h.kind, "img"); assert.equal(h.src, "stickers/horse.png"); assert.equal(h.i, 0);
  near(h.width, 0.2 / ASPECT, "width in scene widths"); near(h.height, 0.2, "height in scene heights");
  near(h.left, 0.5 - 0.1 / ASPECT, "left"); near(h.top, 0.72, "top");
  assert.equal(sp.kind, "splat"); assert.equal(sp.fill, "#DE7B52"); assert.equal(sp.d, splatPath(5)); assert.equal(sp.i, 1);
});

test("the meadow: sky over grass, the horizon at 0.58, the same stops for CSS and canvas", () => {
  assert.equal(MEADOW.find(([at, c]) => c === "#A9D69A")[0], 0.58);
  assert.equal(meadowCss(), "linear-gradient(to bottom, #BFE3F2 0%, #E4F3F7 57.5%, #A9D69A 58%, #78BD6E 100%)");
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test tests/drawing-scene.test.mjs`
Expected: FAIL — `Cannot find module '…/public/drawing/scene.js'`.

- [ ] **Step 3: Write `public/drawing/scene.js`:**

```js
// scene.js — Drawing's scene: where a sticker lands, what a splat looks like, what the celebration
// says, and THE scene renderer (spec 2026-09-30 §2.1, §2.3, §3). ONE renderScene() draws the ring,
// every shelf thumbnail and the 1600x900 PNG that is mailed, from one geometry (sceneOps), one
// meadow (MEADOW) and one splat (splatPath) — so what she sees, what the shelf shows and what her
// family receives can never drift apart. Plain ES module, no DOM at import time: node tests import
// it; the page puts it on window.DrawingScene through the module shim in index.html.
// Coordinates: x of the scene WIDTH, y of the scene HEIGHT, both the item's CENTRE; w = its square
// box as a fraction of the scene HEIGHT.

export const ASPECT = 16 / 9;
// The only backdrop in v1 (spec §2.1): sky over grass, horizon at 0.58, a calm palette, no asset.
export const MEADOW = [[0, "#BFE3F2"], [0.575, "#E4F3F7"], [0.58, "#A9D69A"], [1, "#78BD6E"]];
// tokens.css: --c-teal, --c-vowel, --c-good-literacy, --c-confetti-gold. Never red (palette law).
export const SPLAT_COLOURS = ["#0F7C8A", "#DE7B52", "#2E7D5B", "#B7822B"];
const NUMBER = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

export const stickerById = (table, id) => (table && table.stickers || []).find((s) => s.id === id) || null;

// Rounded to 4 decimals INWARD: a plain round could put an edge item 0.00005 outside (caught by
// the "however many laps" test), and the hub refuses nothing inside 0-1 but the box must stay in.
export function clampItem({ x, y, w }) {
  const hx = w / ASPECT / 2, hy = w / 2;
  const lo = (h) => Math.ceil(h * 1e4) / 1e4, hi = (h) => Math.floor((1 - h) * 1e4) / 1e4;
  const fit = (v, h) => Math.min(hi(h), Math.max(lo(h), round(v, 4)));
  return { x: fit(x, hx), y: fit(y, hy) };
}

// "Pick and it lands" (spec §2.1). Sky/ground: the n-th sticker of a zone takes slot n % 7,
// one lap later everything shifts +lapOffset in x and y. Any (the splat): a random slot.
export function landing(id, items, table, rand = Math.random) {
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
  const n = items.filter((it) => { const s = stickerById(table, it.s); return s && s.zone === st.zone; }).length;
  const slot = slots[n % slots.length];
  const off = Math.floor(n / slots.length) * (table.lapOffset || 0);
  const w = st.scale;
  const y = st.zone === "ground" ? slot.base - w / 2 : slot.y;
  return { ...clampItem({ x: slot.x + off, y: y + off, w }), w };
}

// A procedural paint splat (spec §2.1): 8-12 control points at random radii from a seeded PRNG,
// joined by quadratic curves through their midpoints. Path in the box -1..1 (viewBox "-1 -1 2 2").
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function splatPath(seed) {
  const r = mulberry32(seed >>> 0);
  const n = 8 + Math.floor(r() * 5);
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + (r() - 0.5) * (Math.PI / n);
    const rad = 0.55 + r() * 0.45;
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
  }
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const f = (v) => v.toFixed(3);
  const m0 = mid(pts[n - 1], pts[0]);
  let d = "M" + f(m0[0]) + " " + f(m0[1]);
  for (let k = 0; k < n; k++) {
    const p = pts[k], m = mid(p, pts[(k + 1) % n]);
    d += "Q" + f(p[0]) + " " + f(p[1]) + " " + f(m[0]) + " " + f(m[1]);
  }
  return d + "Z";
}

// What she DID (spec §2.3): counted, in the order she first placed each, "a, b and c".
export function describe(items, table) {
  const order = [], count = new Map();
  for (const it of items || []) {
    if (!count.has(it.s)) order.push(it.s);
    count.set(it.s, (count.get(it.s) || 0) + 1);
  }
  const parts = order.map((id) => {
    const st = stickerById(table, id), n = count.get(id);
    const word = st ? st.word.toLowerCase() : id;
    return n === 1 ? "a " + word : (NUMBER[n] || String(n)) + " " + (st ? st.plural : id + "s");
  }).filter(Boolean);
  if (!parts.length) return "You made a picture!";
  const list = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  return "You made a picture with " + list + "!";
}

export const meadowCss = () =>
  "linear-gradient(to bottom, " + MEADOW.map(([at, c]) => c + " " + round(at * 100, 2) + "%").join(", ") + ")";

// The one geometry: every item's box as fractions of the scene's width (left, width) and height
// (top, height). Unknown stickers (a newer version's) are skipped, never thrown on.
export function sceneOps(scene, table) {
  const out = [];
  (scene && scene.items || []).forEach((it, i) => {
    const st = stickerById(table, it.s);
    if (!st) return;
    const hx = it.w / ASPECT / 2, hy = it.w / 2;
    const splat = it.s === "splat";
    out.push({ i, s: it.s, kind: splat ? "splat" : "img", src: splat ? null : st.src,
               d: splat ? splatPath(it.seed) : null, fill: splat ? it.c : null,
               left: it.x - hx, top: it.y - hy, width: 2 * hx, height: 2 * hy });
  });
  return out;
}

const SVGNS = "http://www.w3.org/2000/svg";
// THE renderer. target = a CanvasRenderingContext2D (the PNG) or an element (the ring's #scene, a
// shelf thumbnail, the New picture tile). opts.images = { stickerId: loaded HTMLImageElement } for
// the canvas. Returns target.
export function renderScene(target, scene, { table, images } = {}) {
  const ops = sceneOps(scene, table);
  if (target && typeof target.drawImage === "function") {
    const W = target.canvas.width, H = target.canvas.height;
    const g = target.createLinearGradient(0, 0, 0, H);
    for (const [at, c] of MEADOW) g.addColorStop(at, c);
    target.fillStyle = g;
    target.fillRect(0, 0, W, H);
    for (const op of ops) {
      const x = op.left * W, y = op.top * H, w = op.width * W, h = op.height * H;
      if (op.kind === "splat") {
        target.save();
        target.translate(x + w / 2, y + h / 2);
        target.scale(w / 2, h / 2);
        target.fillStyle = op.fill;
        target.fill(new Path2D(op.d));
        target.restore();
      } else if (images && images[op.s] && images[op.s].complete && images[op.s].naturalWidth) {
        target.drawImage(images[op.s], x, y, w, h);
      }
    }
    return target;
  }
  target.style.background = meadowCss();
  const kids = ops.map((op) => {
    let el;
    if (op.kind === "splat") {
      el = document.createElementNS(SVGNS, "svg");
      el.setAttribute("viewBox", "-1 -1 2 2");
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", op.d);
      p.setAttribute("fill", op.fill);
      el.appendChild(p);
    } else {
      el = document.createElement("img");
      el.src = op.src;
      el.alt = "";
      el.draggable = false;
    }
    el.setAttribute("class", "item");
    el.setAttribute("data-i", String(op.i));
    el.style.left = op.left * 100 + "%";
    el.style.top = op.top * 100 + "%";
    el.style.width = op.width * 100 + "%";
    el.style.height = op.height * 100 + "%";
    return el;
  });
  target.replaceChildren(...kids);
  return target;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/drawing-scene.test.mjs`
Expected: `# pass 9`, `# fail 0`. (Node 22 loads the `.js` as ESM by syntax detection, exactly as `tests/invariants.mjs` loads `public/lib/contract.js`; no warning is printed.)

- [ ] **Step 5: Commit**

```bash
git add public/drawing/scene.js tests/drawing-scene.test.mjs
git commit -m "drawing: scene.js — pick-and-it-lands (zones, centre-out slots, laps, clamped), the procedural splat, the celebration sentence, and ONE renderScene for the ring, the thumbnails and the PNG (spec 2026-09-30 §2.1, §2.3, §3)"
```

---
### Task 7: The ring page — markup, styles, boot, router, tiles, the picture, the park

**Files:**
- Create: `public/drawing/index.html`, `public/drawing/drawing.css`, `public/drawing/drawing.js`
- Test: `tests/drawing-ui.test.mjs` (new: the harness + the ring's five tests)

**Interfaces:**
- Consumes: `stickers.json` (T1), the routes (T4: `POST /drawings`, `PUT` + `GET /drawings/<id>/scene.json`), `window.DrawingScene` = scene.js (T6), `window.DoorBar / EllieContract / EllieCelebrate` via the module shim, `Dwell`, `Speech`.
- Produces: the page; `window.Drawing` with its FINAL shape (Definitions → Page state and hooks). `drawing.js` is written in sections; the four marked `— T8`, `— T9`, `— T10`, `— T11` start as stubs and each later task REPLACES ITS WHOLE SECTION (from its header line up to the next `// ----------` header). Ids the later tasks rely on: `#sShelf`, `#sRing`, `#scene`, `#restTile`, `#btnUndo`, `#btnDone`, `#railNew`, `#newThumb`, `#shelfGrid`, `#tile-<id>` (class `cell tile photo dwell`, children `.pic` and `.word.plate`). The global helper that silences speech is `hush()` (never a global named `stop`, which would shadow `window.stop`).

- [ ] **Step 1: Write the failing tests** — create `tests/drawing-ui.test.mjs`:

```js
// drawing-ui.test.mjs — Drawing in a real browser (spec docs/superpowers/specs/2026-09-30-drawing-design.md
// §2-§3, §8). Harness: reader-shelf.test.mjs's — the REAL server.js on a scratch port with a throwaway
// ERA_DATA_DIR, every provider seam closed, NO Drive folder (so every write is .local in the data dir),
// synthetic pictures only; Playwright at 1920x1080 with touch, UTC, speech in test mode.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 8478 — swept free 9/30 across all five repos' tests/ and every open worktree; ss -ltn clean.
const PORT = Number(process.env.ERA_TEST_DRAWING_PORT) || 8478;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-drawing-ui-"));
const PICS = path.join(TMP, "drawings");
const SEAMS = {
  ERA_AI_URL: "http://127.0.0.1:1", ERA_ELEVEN_URL: "http://127.0.0.1:1", ERA_FAL_URL: "http://127.0.0.1:1",
  ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1",
  ERA_GEOCODE_URL: "http://127.0.0.1:1/geocode", ERA_TMDB_URL: "http://127.0.0.1:1",
  ERA_STREAMING_URL: "http://127.0.0.1:1", ERA_RESEND_URL: "http://127.0.0.1:1",
};
let child, browser;

before(async () => {
  fs.writeFileSync(path.join(TMP, "profile.json"), JSON.stringify({ childName: "Maya" }));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_DEVICE_ID: "test-dev", ERA_NO_UPDATE: "1", ...SEAMS },
  });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); up = true; break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error("server never came up");
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (child) child.kill("SIGKILL");
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function makePage(opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1920, height: 1080 }, hasTouch: true,
    deviceScaleFactor: 1, timezoneId: "UTC", reducedMotion: opts.reducedMotion || "no-preference" });
  await ctx.addInitScript(() => { window.__testHooks = true; });
  await ctx.route("http://127.0.0.1:49155/**", (r) => r.abort());   // ERAgaze's port on her PC; nothing answers here
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  if (opts.routes) await opts.routes(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(`${BASE}/drawing/${opts.hash || ""}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Drawing && window.Drawing.state().ready);
  return { ctx, page, errors };
}
const st = (page) => page.evaluate(() => window.Drawing.state());
const newId = async () => (await (await fetch(`${BASE}/drawings`, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: "{}" })).json()).id;
const hubScene = async (id) => (await fetch(`${BASE}/drawings/${id}/scene.json`)).json();
async function openRing(opts = {}) {
  const id = opts.id || (await newId());
  const p = await makePage({ ...opts, hash: "#p=" + id });
  await p.page.waitForFunction(() => window.Drawing.state().screen === "ring");
  return { ...p, id };
}
// a picture another device made, straight into the data dir (what the mirror would carry in)
function seed(id, items, when) {
  fs.mkdirSync(path.join(PICS, id), { recursive: true });
  fs.writeFileSync(path.join(PICS, id, "scene.json"), JSON.stringify(
    { v: 1, id, created: when, updated: when, device: "test-dev", backdrop: "meadow", items, mailedHash: null }));
}
const H = (x = 0.5, y = 0.82) => ({ s: "horse", x, y, w: 0.2, by: "ellie" });
const puts = (page) => {
  const seen = [];
  page.on("request", (r) => { if (r.method() === "PUT" && r.url().includes("/scene.json")) seen.push(r); });
  return seen;
};

// ================================================================ T7 — the ring
test("the ring: eight sticker tiles in their fixed seats, Undo and Done either side of the black rest tile", async () => {
  const { ctx, page, errors } = await openRing();
  const g = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    const rest = document.getElementById("restTile");
    return {
      tiles: [...document.querySelectorAll("#sRing .tile")].map((el) => ({ id: el.dataset.s, word: el.textContent.trim(), ...box(el) })),
      undo: box(document.getElementById("btnUndo")), done: box(document.getElementById("btnDone")),
      rest: { ...box(rest), bg: getComputedStyle(rest).backgroundColor }, scene: box(document.getElementById("scene")),
    };
  });
  assert.deepEqual(g.tiles.map((t) => t.id), ["house", "horse", "tree", "person", "sun", "cloud", "star", "splat"]);
  assert.deepEqual(g.tiles.map((t) => t.word), ["House", "Horse", "Tree", "Person", "Sun", "Cloud", "Star", "Splat"]);
  const left = g.tiles.slice(0, 4), right = g.tiles.slice(4);
  for (const t of left) assert.ok(t.x + t.w <= g.scene.x, t.id + " is left of the picture");
  for (const t of right) assert.ok(t.x >= g.scene.x + g.scene.w, t.id + " is right of the picture");
  for (const col of [left, right]) for (let k = 1; k < 4; k++)
    assert.ok(col[k].y - (col[k - 1].y + col[k - 1].h) >= 13.5, "a 14px gap down each column");
  assert.ok(Math.abs(g.undo.x - left[0].x) < 1 && g.undo.y > left[3].y, "Undo under Person");
  assert.ok(Math.abs(g.done.x - right[0].x) < 1 && g.done.y > right[3].y, "Done under Splat, bottom-right");
  assert.equal(g.rest.bg, "rgb(0, 0, 0)", "the rest tile is pure black");
  assert.ok(Math.abs(g.rest.y - g.undo.y) < 1 && g.rest.x > g.undo.x + g.undo.w && g.rest.x + g.rest.w < g.done.x);
  assert.ok(Math.abs(g.rest.x + g.rest.w / 2 - (g.scene.x + g.scene.w / 2)) < 2, "centred under the picture");
  for (const t of [...g.tiles, { id: "undo", ...g.undo }, { id: "done", ...g.done }])
    assert.ok(Math.min(t.w, t.h) >= 90, t.id + " is at least 90px at 1920");
  assert.ok(Math.abs(g.scene.w / g.scene.h - 16 / 9) < 0.01, "the picture is 16:9");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("her picture and the rest tile are inert, and the only holds on the page are the two doors' (2x her dwell)", async () => {
  const id = await newId();                              // a picture with one horse, saved through the hub
  await fetch(`${BASE}/drawings/${id}/scene.json`, { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ v: 1, backdrop: "meadow", items: [H()] }) });
  const { ctx, page } = await openRing({ id });
  const r = await page.evaluate(() => ({
    sceneAttrs: [...document.querySelectorAll("#scene, #scene *")].some((n) =>
      n.matches(".dwell") || [...n.attributes].some((a) => a.name.startsWith("data-dwell"))),
    rest: document.getElementById("restTile").matches(".dwell") ||
      [...document.getElementById("restTile").attributes].some((a) => a.name.startsWith("data-dwell")),
    holds: [...document.querySelectorAll("[data-dwell-ms]")].map((el) => el.id + "=" + el.dataset.dwellMs).sort(),
    ringTargets: document.querySelectorAll("#sRing .dwell").length,
    items: document.querySelectorAll("#scene .item").length,
  }));
  assert.equal(r.sceneAttrs, false, "no .dwell and no data-dwell-* anywhere in her picture");
  assert.equal(r.rest, false);
  assert.deepEqual(r.holds, ["barDoor=2400", "barTalk=2400"]);
  assert.equal(r.ringTargets, 10, "8 stickers + Undo + Done");
  assert.equal(r.items, 1);
  await ctx.close();
});

test("the rest tile is the gaze park: its centre is what the page posts, in 0-1 coordinates", async () => {
  const { ctx, page } = await openRing();
  const { park, rest, override } = await page.evaluate(() => {
    const r = document.getElementById("restTile").getBoundingClientRect();
    return { park: window.Drawing.state().park, override: document.documentElement.dataset.parkOverride,
             rest: { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight } };
  });
  assert.equal(override, "center");
  assert.ok(park && Math.abs(park.x - rest.x) < 0.002 && Math.abs(park.y - rest.y) < 0.002, JSON.stringify({ park, rest }));
  await ctx.close();
});

test("a hash that is not a picture id opens the shelf, never a broken ring", async () => {
  for (const h of ["#p=../../etc", "#p=2026-09-30-101500-X", "#p=", "#nothing"]) {
    const { ctx, page, errors } = await makePage({ hash: h });
    assert.equal((await st(page)).screen, "shelf", h);
    assert.deepEqual(errors, [], h);
    await ctx.close();
  }
});

test("at 1280x720 every ring tile is still at least 60px", async () => {
  const { ctx, page } = await openRing({ viewport: { width: 1280, height: 720 } });
  const mins = await page.evaluate(() => [...document.querySelectorAll("#sRing .dwell")].map((el) => {
    const r = el.getBoundingClientRect(); return Math.min(r.width, r.height); }));
  assert.equal(mins.length, 10);
  for (const m of mins) assert.ok(m >= 60, String(m));
  await ctx.close();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `ss -ltn | grep -E ':8478\b'` (must print nothing), then `node --test tests/drawing-ui.test.mjs`
Expected: FAIL — every test times out in `makePage` (`/drawing/` answers `404 not found`, so `window.Drawing` never appears).

- [ ] **Step 3: Write `public/drawing/index.html`:**

```html
<!doctype html>
<html lang="en" data-park-override="center">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Drawing</title>
<!-- Drawing — make a picture with your eyes (spec docs/superpowers/specs/2026-09-30-drawing-design.md).
     Two screens: the shelf (/drawing/) and the ring (/drawing/#p=<id>). The Pencil's kit: the
     shared door bar, the contract, dwell.js, speech.js, celebrate.js. data-park-override: the gaze
     park is this page's own rest spot (the ring's black tile, the shelf's black centre), posted to
     the engine by drawing.js — so Done may sit in the bottom-right corner. -->
<link rel="stylesheet" href="../lib/tokens.css">
<link rel="stylesheet" href="../lib/doorbar.css">
<link rel="stylesheet" href="drawing.css">
<script>
  window.DwellConfig = {
    ms: 1200, graceMs: 400, decayMs: 1000, padPx: 16, rearmPx: 48,
    audioPreview: false, chime: false, bus: "auto", staleMs: 600, color: "#0F7C8A"
  };
</script>
</head>
<body>
<!-- THE SHELF (spec §3): the Reader's TD Snap page — a rail (New picture) and the 3x4
     centre-black grid, More at [3,1]. drawing.js fills #shelfGrid by [row,col]. -->
<section id="sShelf" class="screen" aria-label="My pictures">
  <nav id="shelfRail" aria-label="Pictures">
    <button type="button" id="railNew" class="cell photo dwell" aria-label="New picture">
      <span class="thumbBox"><span class="scene thumb" id="newThumb"></span></span>
      <span class="plate">New picture</span>
    </button>
  </nav>
  <div id="shelfGrid"></div>
</section>

<!-- THE RING (spec §2): sticker tiles down both sides (drawing.js draws the eight from
     stickers.json into their fixed seats), her picture in the middle — inert, no .dwell —
     and the black rest tile between Undo and Done. -->
<section id="sRing" class="screen" aria-label="Your picture">
  <div id="sceneCell"><div id="scene" class="scene" aria-label="Her picture"></div></div>
  <button type="button" id="btnUndo" class="cell text dwell" aria-label="Undo">
    <span class="glyph" aria-hidden="true">↩</span><span class="word">Undo</span></button>
  <div id="restTile" aria-hidden="true"></div>
  <button type="button" id="btnDone" class="cell text dwell" aria-label="Done">
    <span class="glyph" aria-hidden="true">✔</span><span class="word">Done</span></button>
</section>

<script src="../dwell.js"></script>
<script src="../speech.js"></script>
<script type="module">
  // The Pencil's shim: the app scripts stay classic (tests reach window.Drawing), and a module
  // runs before the deferred classics in document order.
  import { CONTRACT, holdFor, holdForExit } from "../lib/contract.js";
  import { mountDoorBar } from "../lib/doorbar.js";
  import { confetti } from "../lib/celebrate.js";
  import * as DrawingScene from "./scene.js";
  window.EllieContract = { CONTRACT, holdFor, holdForExit };
  window.DoorBar = { mountDoorBar };
  window.EllieCelebrate = { confetti };
  window.DrawingScene = DrawingScene;
</script>
<script src="drawing.js" defer></script>
</body>
</html>
```

- [ ] **Step 4: Write `public/drawing/drawing.css`:**

```css
/* drawing.css — Drawing's two screens and the grown-up's sheet (spec 2026-09-30 §2-§3).
   Contract colours come from ../lib/tokens.css; the page keeps only its own derived shades. */
:root{
  --ink:var(--color-ink, #17272E); --card:#FFFFFF;
  --page:#22343B;                 /* dark page: the rest tile's pure black reads as its own shape */
  --teal:var(--color-primary, #0F7C8A); --nav:var(--color-nav, #6B7B82);
  --warn:var(--color-warn-partner, #B23A48);   /* partner controls ONLY (palette law) */
  --side:13vw;                    /* tile columns: 250px @1920 (74px "Undo"/"Done" fit), 166px @1280 */
  --gap:var(--gap-floor, 14px);
  --font:"Segoe UI", system-ui, sans-serif;
}
*{box-sizing:border-box; user-select:none}
[hidden]{display:none !important}
html,body{height:100%; margin:0}
body{background:var(--page); color:var(--ink); font-family:var(--font); overflow:hidden}

/* both screens sit under the shared bar; --bar-h is published on <body> by doorbar.js */
.screen{position:fixed; inset:0; top:var(--bar-h, 0px); display:none}
.screen.show{display:grid}

/* ---- tiles (both screens) ---- */
.cell{appearance:none; border:0; margin:0; padding:0; border-radius:16px; background:var(--card);
      color:var(--ink); font:inherit; min-width:0; min-height:0; overflow:hidden; cursor:pointer;
      display:flex; flex-direction:column; align-items:center; justify-content:center}
/* photo tiles (ux-contract §C): the picture keeps ~4/5, the whole-word plate 24-46px */
.photo .pic, .photo .thumbBox{flex:1 1 auto; min-height:0; width:100%}
.photo img.pic, .photo svg.pic{height:0; object-fit:contain; padding:8px 8px 0}
.plate{flex:0 0 auto; font-size:clamp(24px, 1.5vw, 46px); font-weight:700; line-height:1.25;
       padding:2px 6px 6px; text-align:center}
/* text tiles: glyph + word, the word on the 74px floor at 1920 */
.text .glyph{font-size:clamp(28px, 2.9vw, 56px); line-height:1}
.text .word{font-size:clamp(44px, 3.86vw, 74px); font-weight:750; line-height:1.1}
#btnUndo, #shelfMore{background:var(--nav); color:#fff}
#btnDone{background:var(--teal); color:#fff}

/* ---- the ring: 3 x 5 under the bar; the picture in the middle, never moving ---- */
#sRing{grid-template-columns:var(--side) minmax(0, 1fr) var(--side);
       grid-template-rows:repeat(5, minmax(0, 1fr)); gap:var(--gap); padding:12px 14px}
#btnUndo{grid-row:5; grid-column:1}
#btnDone{grid-row:5; grid-column:3}
#restTile{grid-row:5; grid-column:2; justify-self:center; width:var(--side); height:100%;
          background:#000; border-radius:16px}                  /* inert: no .dwell, ever */
#sceneCell{grid-row:1 / 5; grid-column:2; container-type:size; min-width:0; min-height:0;
           display:flex; align-items:center; justify-content:center}
/* the largest 16:9 box that fits (the PNG is 1600x900, so what she sees is what is mailed) */
#scene{width:min(100cqw, calc(100cqh * 16 / 9)); height:min(100cqh, calc(100cqw * 9 / 16));
       border-radius:18px; touch-action:none}
.scene{position:relative; overflow:hidden; display:block}
.scene .item{position:absolute; display:block; pointer-events:none; overflow:visible}
#scene .item{pointer-events:auto; touch-action:none; -webkit-user-drag:none}   /* the partner's finger */
.flyer{position:fixed; z-index:50; pointer-events:none; transform-origin:0 0}

/* ---- the shelf: the Reader's rail + 3x4 grid (public/reader/index.html) ---- */
#sShelf{grid-template-columns:clamp(120px, 13vw, 250px) minmax(0, 1fr); gap:18px; padding:12px 14px 14px}
#shelfRail{display:grid; grid-template-rows:repeat(3, minmax(0, 1fr)); gap:16px; min-height:0}
#shelfGrid{display:grid; grid-template-columns:repeat(4, minmax(0, 1fr));
           grid-template-rows:repeat(3, minmax(0, 1fr)); gap:16px; min-height:0}
.shelf-black{background:#000; border-radius:16px}               /* inert: no text, no .dwell */
.shelf-pic, #railNew{padding:8px 8px 0}
.thumbBox{display:flex; align-items:center; justify-content:center; container-type:size}
.thumb{width:min(100cqw, calc(100cqh * 16 / 9)); height:min(100cqh, calc(100cqw * 9 / 16)); border-radius:12px}
.thumb, .thumb *{pointer-events:none}

@media (prefers-reduced-motion: reduce){ .flyer{display:none} }
```

- [ ] **Step 5: Write `public/drawing/drawing.js`** (the four task sections are stubs until T8–T11 replace them):

```js
/*
 * Drawing — make a picture with your eyes (spec docs/superpowers/specs/2026-09-30-drawing-design.md).
 *
 * Two screens: THE SHELF (/drawing/) — her pictures newest first, a New picture tile — and THE RING
 * (/drawing/#p=<id>) — eight sticker tiles down both sides, her picture in the middle, Undo and
 * Done either side of a black rest tile. One dwell on a sticker speaks its word and the sticker
 * flies into a sensible place by itself ("pick and it lands"). Her picture is inert: looking at
 * it does nothing (EyeDraw's Midas-touch lesson). A grown-up's finger may move a sticker.
 *
 * Laws (spec §7): one dwell per user, only the two doors are 2x; Speech.stop() before every
 * action of hers; never "wrong", never "sent"; nothing times out; zero layout shift; a picture is
 * never lost (memory + localStorage until the hub has it).
 */
"use strict";
const EC = window.EllieContract.CONTRACT;
const SC = window.DrawingScene;
const $ = (id) => document.getElementById(id);

const ID_RE = /^\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9][a-z0-9-]{0,39}$/;   // drawings.js ID_RE, the same
const MAX_ITEMS = 200;          // drawings.js LIMITS.items: the hub refuses more
const HISTORY_MAX = 60;         // spec §2.2
const SAVE_MS = 800;            // spec §4: autosave debounce
const POLL_MS = 60000;          // the shelf notices a picture another device made
const BOOK_CELLS = [[1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [2, 4], [3, 2], [3, 3], [3, 4]];   // reader.js:489
const PER_PAGE = BOOK_CELLS.length;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAIL_LINES = {
  sent: "Sent to your family",
  "no-email": "Saved — no family email set up yet",
  failed: "Saved — mail failed, will not retry",
  unchanged: "Saved — already sent, nothing new to send",
  empty: "Saved — the picture is empty, nothing sent",
};
const BAR_DOORS = new Set(["barDoor", "barTalk"]);

const S = {
  ready: false, table: { stickers: [], zones: {} }, stickers: new Map(), images: {},
  screen: null, id: null, scene: null, history: [], dirty: false, saveTimer: null, finishing: false,
  paused: false, wasPaused: false,
  index: [], shelfPage: 0, shelfPages: 1, shelfIds: [], painted: "", pollTimer: null,
  lastMail: null, said: [], park: null, session: "s" + Date.now(),
};
let BAR = null;
let frozen = [];                 // the .dwell targets the grown-up's sheet put to sleep
const mailWatchers = [];

// ---------- small things ----------
function log(event, detail) {
  fetch("/log", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ t: Date.now(), session: S.session, app: "drawing", event, ...detail }) }).catch(() => {});
}
function hush() { try { if (window.Speech) Speech.stop(); } catch {} }
// every voice the app has goes through here; S.said is the tests' (and a grown-up's) record
function say(text) {
  S.said.push(text);
  if (S.said.length > 20) S.said.shift();
  if (S.paused || !window.Speech) return Promise.resolve();
  return Speech.say(text, "long");
}
function suppress(ms) { try { if (window.Dwell && Dwell.suppress) Dwell.suppress(ms); } catch {} }
function confetti(n) { try { window.EllieCelebrate.confetti(n); } catch {} }

// ---------- local safety net (spec §4 rule 4) ----------
const stashKey = (id) => "drawing_scene_" + id;
function stash() {
  if (!S.id || !S.scene) return;
  try { localStorage.setItem(stashKey(S.id), JSON.stringify({ scene: S.scene, dirty: S.dirty, at: Date.now() })); } catch {}
}
function readStash(id) {
  try {
    const j = JSON.parse(localStorage.getItem(stashKey(id)) || "null");
    return j && j.scene && Array.isArray(j.scene.items) ? j : null;
  } catch { return null; }
}

// ---------- screens ----------
function show(which) {
  S.screen = which;
  $("sShelf").classList.toggle("show", which === "shelf");
  $("sRing").classList.toggle("show", which === "ring");
  document.body.dataset.screen = which;
}

// ---------- the gaze park (spec §2; deviation 6: the shelf's rest is its black centre) ----------
function tellPark() {
  try {
    let r = null;
    if (S.screen === "ring") r = $("restTile").getBoundingClientRect();
    else {
      const a = document.querySelector('#shelfGrid [data-cell="2,2"]'), b = document.querySelector('#shelfGrid [data-cell="2,3"]');
      if (a && b) {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        r = { left: ra.left, top: ra.top, width: rb.right - ra.left, height: rb.bottom - ra.top };
      }
    }
    if (!r || !r.width) return;
    const x = +((r.left + r.width / 2) / innerWidth).toFixed(3);
    const y = +((r.top + r.height / 2) / innerHeight).toFixed(3);
    S.park = { x, y };
    fetch(EC.parkOverride.endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x, y }) }).catch(() => {});
  } catch {}
}

// ---------- the shared bar: 🚪 leave and 💬 pause to talk ----------
function onLeave() { log("door", {}); hush(); save({ keepalive: true }); }
function onPause() { log("talk", {}); hush(); S.wasPaused = S.paused; S.paused = true; save({ keepalive: true }); }
function onResume() { S.paused = S.wasPaused; log("talk_resume", {}); tellPark(); }

// ---------- the ring's tiles, from stickers.json (seats fixed forever) ----------
function splatSample() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "-1 -1 2 2");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", SC.splatPath(7));
  p.setAttribute("fill", SC.SPLAT_COLOURS[0]);
  svg.appendChild(p);
  return svg;
}
function buildTiles() {
  const ring = $("sRing");
  for (const st of S.table.stickers) {
    S.stickers.set(st.id, st);
    const b = document.createElement("button");
    b.type = "button";
    b.id = "tile-" + st.id;
    b.className = "cell tile photo dwell";
    b.dataset.s = st.id;
    b.setAttribute("aria-label", st.word);
    b.style.gridRow = String(st.at[0]);
    b.style.gridColumn = String(st.at[1]);
    let pic;
    if (st.src) { pic = document.createElement("img"); pic.src = st.src; pic.alt = ""; pic.draggable = false; }
    else pic = splatSample();
    pic.classList.add("pic");
    const word = document.createElement("span");
    word.className = "word plate";
    word.textContent = st.word;
    b.append(pic, word);
    b.addEventListener("click", () => place(st.id, b));
    ring.appendChild(b);
    if (st.src) { const im = new Image(); im.src = st.src; S.images[st.id] = im; }   // for the PNG
  }
}
function paintScene() { SC.renderScene($("scene"), S.scene, { table: S.table }); }

// ---------- routing ----------
async function route() {
  const m = /^#p=([^&]+)$/.exec(location.hash || "");
  let id = null;
  try { id = m ? decodeURIComponent(m[1]) : null; } catch {}
  if (id && ID_RE.test(id)) await openRing(id); else await openShelf();
}
function go(id) {
  if (id) { location.hash = "p=" + encodeURIComponent(id); return; }     // hashchange -> route()
  history.replaceState(null, "", location.pathname + location.search);
  route();
}
async function loadScene(id) {
  const local = readStash(id);
  if (local && local.dirty) { S.dirty = true; return local.scene; }       // unsaved work wins (rule 4)
  S.dirty = false;
  try {
    const r = await fetch("/drawings/" + encodeURIComponent(id) + "/scene.json", { cache: "no-store" });
    if (r.ok) { const sc = await r.json(); if (sc && Array.isArray(sc.items)) return sc; }
  } catch {}
  if (local) return local.scene;
  return { v: 1, id, backdrop: "meadow", items: [] };
}
async function openRing(id) {
  if (S.screen === "ring" && S.id && S.id !== id && S.dirty) await save();
  stopPoll();
  S.id = id;
  S.history = [];
  S.scene = await loadScene(id);
  show("ring");
  paintScene();
  suppress();
  tellPark();
  if (S.dirty) scheduleSave();
  log("open", { id, items: S.scene.items.length });
}

// ---------- placing, undo, autosave (spec §2.1, §2.2, §4) — T8 ----------
// T8 replaces this section.
function place() {}
function undo() {}
function changed() {}
function scheduleSave() {}
async function save() { return true; }

// ---------- the grown-up's hands (partner.js calls these; spec §2.4) — T9 ----------
// T9 replaces this section.
function itemAt() { return null; }
function moveItem() {}
async function clearPicture() {}
function tuneDwell() { return window.Dwell ? Dwell.config.ms : EC.holds.content; }
function freeze() {}
function thaw() {}
function mailLine() { return ""; }
function setMail(res) { S.lastMail = res; }

// ---------- the shelf (spec §3) — T10 ----------
// T10 replaces this section. Until then the shelf is an empty screen the router can land on.
async function openShelf() { S.id = null; S.scene = null; S.history = []; S.dirty = false; show("shelf"); suppress(); tellPark(); }
function stopPoll() {}
async function pollShelf() {}
async function newPicture() {}

// ---------- Done (spec §2.3) — T11 ----------
// T11 replaces this section.
async function done() {}

// ---------- the page's own surface: tests, partner.js, field debugging ----------
window.Drawing = {
  state: () => ({
    ready: S.ready, screen: S.screen, id: S.id,
    items: S.scene ? S.scene.items.map((i) => ({ ...i })) : [],
    history: S.history.length, dirty: S.dirty, lastMail: S.lastMail,
    shelfPage: S.shelfPage, shelfPages: S.shelfPages, shelfIds: S.shelfIds.slice(),
    said: S.said.slice(), park: S.park, paused: S.paused,
  }),
  itemAt, moveItem, clamp: (o) => SC.clampItem(o), clearPicture, repaint: () => { if (S.scene) paintScene(); },
  tuneDwell, dwellMs: () => (window.Dwell ? Dwell.config.ms : EC.holds.content),
  freeze, thaw, say: (t) => { hush(); return say(t); },
  mailLine, onMail: (cb) => { mailWatchers.push(cb); },
  pollShelf, flush: () => save(),
};

// ---------- boot ----------
async function boot() {
  // THE DOOR IS UP BEFORE ANY FETCH (the board's 9/3 rule): a hub that will not answer never
  // leaves her on a screen she cannot leave. partner.js finds the bar the moment it runs.
  BAR = window.DoorBar.mountDoorBar(document.body, { onLeave, onPause, onResume });
  try { if (window.Speech) Speech.init("Let's make a picture!"); } catch {}
  try { S.lastMail = JSON.parse(localStorage.getItem("drawing_mail_last") || "null"); } catch {}
  try { S.table = await (await fetch("stickers.json")).json(); } catch { S.table = { stickers: [], zones: {} }; }
  buildTiles();
  SC.renderScene($("newThumb"), { v: 1, backdrop: "meadow", items: [] }, { table: S.table });
  try {
    const st = await (await fetch("/settings")).json();
    if (Number.isFinite(st.dwellMs) && st.dwellMs > 0) { if (window.Dwell) Dwell.setMs(st.dwellMs); BAR.setDwell(st.dwellMs); }
    if (window.Dwell && Number.isFinite(st.settleMs)) Dwell.set({ settleMs: Math.max(0, Math.min(2000, st.settleMs)) });
    BAR.setPause(st.pauseGoes === "tdsnap");
    if (st.childName) window.ERA_CHILD_NAME = st.childName;
  } catch { /* defaults stand — never block her on settings */ }
  $("btnUndo").addEventListener("click", () => undo());
  $("btnDone").addEventListener("click", () => { done(); });
  $("railNew").addEventListener("click", () => { newPicture(); });
  addEventListener("hashchange", () => { route(); });
  addEventListener("resize", () => { if (BAR) BAR.sizeBar(); tellPark(); });
  addEventListener("pagehide", () => { save({ keepalive: true }); });
  await route();
  S.ready = true;
  try { if (window.Speech) Speech.preload(S.table.stickers.map((s) => s.word).concat(["Undo"])); } catch {}
  log("boot", {});
}
boot();
```

- [ ] **Step 6: Run the tests, then look at it**

Run: `node --test tests/drawing-ui.test.mjs`
Expected: `# pass 5`, `# fail 0`. Then on a worktree hub (How to run things) screenshot `http://127.0.0.1:$P/drawing/#p=2026-01-01-000000-look` at 1920×1080 with Playwright (run the script from inside `tests/` so `playwright` resolves) and Read the PNG: eight tiles down the sides, the meadow in the middle, the black rest tile between Undo and Done.

- [ ] **Step 7: Commit**

```bash
git add public/drawing/index.html public/drawing/drawing.css public/drawing/drawing.js tests/drawing-ui.test.mjs
git commit -m "drawing: the ring — eight sticker tiles in fixed seats round an inert 16:9 meadow, Undo and Done either side of the black rest tile that is also the gaze park; the Pencil's shim and the shared door bar (spec 2026-09-30 §2)"
```

---

### Task 8: Pick and it lands — placing, the flight, Undo, autosave and the local safety net

**Files:**
- Modify: `public/drawing/drawing.js` — replace the section `// ---------- placing, undo, autosave (spec §2.1, §2.2, §4) — T8 ----------`
- Test: `tests/drawing-ui.test.mjs` (append)

**Interfaces:**
- Consumes: `SC.landing`, `SC.renderScene` (T6); `PUT /drawings/<id>/scene.json` (T4); the T7 skeleton (`S`, `say`, `hush`, `log`, `stash`, `paintScene`).
- Produces: `place(id, tile)`, `flyIn(tile, index)`, `undo()`, `push(ev)`, `changed()`, `scheduleSave()`, `save({ keepalive })` → `Promise<boolean>`. History events: `{ t: "place" }` and `{ t: "move", i, from: { x, y, by } }`.

- [ ] **Step 1: Write the failing tests** — append to `tests/drawing-ui.test.mjs`:

```js
// ================================================================ T8 — placing, undo, autosave
test("a dwell on Horse says \"Horse\" (after Speech.stop) and the horse lands at the first centre-out ground slot", async () => {
  const { ctx, page } = await openRing();
  await page.locator("#tile-horse").click();
  let s = await st(page);
  assert.deepEqual(s.items, [{ s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" }]);
  assert.equal(s.said.at(-1), "Horse");
  assert.ok(await page.evaluate(() => (window.__speechEngineLog || []).some((e) => e.ev === "stop")), "Speech.stop() first");
  await page.locator("#tile-sun").click();
  s = await st(page);
  assert.deepEqual(s.items[1], { s: "sun", x: 0.5, y: 0.17, w: 0.16, by: "ellie" });
  await ctx.close();
});

test("Undo takes the last sticker away and says so; on an empty history it does nothing and says nothing", async () => {
  const { ctx, page } = await openRing();
  await page.locator("#btnUndo").click();
  let s = await st(page);
  assert.equal(s.items.length, 0);
  assert.deepEqual(s.said, [], "silence — never \"wrong\"");
  await page.locator("#tile-tree").click();
  await page.locator("#tile-star").click();
  await page.locator("#btnUndo").click();
  s = await st(page);
  assert.deepEqual(s.items.map((i) => i.s), ["tree"]);
  assert.equal(s.said.at(-1), "Undo");
  await ctx.close();
});

test("a sticker flies from its tile into its slot; with reduced motion it simply appears", async () => {
  let { ctx, page } = await openRing();
  await page.locator("#tile-cloud").click();
  assert.equal(await page.locator(".flyer").count(), 1, "in flight");
  await page.waitForFunction(() => !document.querySelector(".flyer"), null, { timeout: 2000 });
  assert.equal(await page.evaluate(() => document.querySelector('#scene [data-i="0"]').style.visibility), "");
  await ctx.close();
  ({ ctx, page } = await openRing({ reducedMotion: "reduce" }));
  await page.locator("#tile-cloud").click();
  assert.equal(await page.locator(".flyer").count(), 0);
  await ctx.close();
});

test("her picture is saved as she goes: a reload shows it exactly", async () => {
  const { ctx, page, id } = await openRing();
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/drawings/${id}/scene.json`) && r.ok());
  await page.locator("#tile-house").click();
  await saved;
  assert.deepEqual((await hubScene(id)).items.map((i) => i.s), ["house"]);
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.Drawing && window.Drawing.state().ready);
  const s = await st(page);
  assert.deepEqual([s.screen, s.id, s.items.map((i) => i.s)], ["ring", id, ["house"]]);
  assert.equal(await page.locator("#scene .item").count(), 1);
  await ctx.close();
});

test("five quick dwells on one tile: five horses in five slots, one coalesced save, one Undo takes one (Review Focus 1)", async () => {
  const { ctx, page, id } = await openRing();
  const seen = puts(page);
  await page.evaluate(() => { for (let k = 0; k < 5; k++) document.getElementById("tile-horse").click(); });  // dwell.js's el.click()
  assert.deepEqual((await st(page)).items.map((i) => i.x), [0.5, 0.35, 0.65, 0.2, 0.8]);
  await page.waitForTimeout(1500);
  assert.equal(seen.length, 1, "the debounce coalesced five changes into one PUT");
  assert.equal((await hubScene(id)).items.length, 5);
  await page.locator("#btnUndo").click();
  assert.equal((await st(page)).items.length, 4);
  await ctx.close();
});

test("a save the hub does not take keeps the picture safe, survives a reload and goes on the next change (Review Focus 2)", async () => {
  let fail = true;
  const { ctx, page, id } = await openRing({ routes: (c) => c.route("**/drawings/*/scene.json",
    (r) => (fail && r.request().method() === "PUT" ? r.abort() : r.continue())) });
  await page.locator("#tile-horse").click();
  await page.waitForTimeout(1200);
  assert.equal((await st(page)).dirty, true);
  const stashed = await page.evaluate((id) => JSON.parse(localStorage.getItem("drawing_scene_" + id)), id);
  assert.equal(stashed.dirty, true);
  assert.equal(stashed.scene.items.length, 1);
  assert.deepEqual((await hubScene(id)).items, [], "the hub never got it");
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.Drawing && window.Drawing.state().ready);
  assert.equal((await st(page)).items.length, 1, "a reload before the retry still shows it");
  await page.waitForTimeout(1200);                    // the reload's own retry fails too
  fail = false;
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.ok() && r.request().postData().includes('"star"'));
  await page.locator("#tile-star").click();
  await saved;
  assert.deepEqual((await hubScene(id)).items.map((i) => i.s), ["horse", "star"]);
  assert.equal((await st(page)).dirty, false);
  await ctx.close();
});

test("leaving within the debounce still saves the last sticker (Review Focus 3)", async () => {
  const { ctx, page, id } = await openRing({ routes: (c) => c.route("**/kiosk/exit",
    (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"action":"closed"}' })) });
  const put = page.waitForRequest((r) => r.method() === "PUT" && r.url().endsWith(`/drawings/${id}/scene.json`));
  await page.locator("#tile-person").click();
  await page.locator("#barDoor").click();                // well inside the 800 ms
  assert.deepEqual(JSON.parse((await put).postData()).items.map((i) => i.s), ["person"]);
  await page.waitForTimeout(300);
  assert.deepEqual((await hubScene(id)).items.map((i) => i.s), ["person"]);
  await ctx.close();
});

test("the 200th sticker is the last: a 201st dwell says its word, places nothing, sends nothing (Review Focus 5)", async () => {
  const id = "2026-09-30-120000-cap-dev";
  seed(id, Array.from({ length: 200 }, () => ({ s: "star", x: 0.5, y: 0.2, w: 0.1, by: "ellie" })), "2026-09-30T12:00:00Z");
  const { ctx, page } = await openRing({ id });
  const seen = puts(page);
  await page.locator("#tile-star").click();
  const s = await st(page);
  assert.equal(s.items.length, 200);
  assert.equal(s.said.at(-1), "Star");
  await page.waitForTimeout(1200);
  assert.equal(seen.length, 0);
  await ctx.close();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/drawing-ui.test.mjs`
Expected: the five T7 tests pass; the eight new ones FAIL (a click places nothing: `items` stays `[]`).

- [ ] **Step 3: Replace the T8 section of `drawing.js` with:**

```js
// ---------- placing, undo, autosave (spec §2.1, §2.2, §4) — T8 ----------
function push(ev) { S.history.push(ev); if (S.history.length > HISTORY_MAX) S.history.shift(); }
function place(id, tile) {
  if (S.screen !== "ring" || !S.scene || S.paused) return;
  const st = S.stickers.get(id);
  if (!st) return;
  hush();
  say(st.word);
  if (S.scene.items.length >= MAX_ITEMS) { log("place_full", { s: id }); return; }   // the hub's cap
  const spot = SC.landing(id, S.scene.items, S.table);
  if (!spot) return;
  const item = { s: id, x: spot.x, y: spot.y, w: spot.w, by: "ellie" };
  if (id === "splat") { item.c = spot.c; item.seed = spot.seed; }
  S.scene.items.push(item);
  push({ t: "place" });
  paintScene();
  flyIn(tile, S.scene.items.length - 1);
  log("place", { s: id, n: S.scene.items.length });
  changed();
}
// The sticker appears at its tile and flies into its slot (~450 ms, ease-out); reduced motion:
// it simply appears. A fixed-position copy flies; the real one waits hidden, so the scene's clip
// never swallows the start of the flight.
function flyIn(tile, index) {
  try {
    if (!tile || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const target = document.querySelector('#scene [data-i="' + index + '"]');
    const from = tile.querySelector(".pic");
    if (!target || !from || !target.animate) return;
    const a = from.getBoundingClientRect(), b = target.getBoundingClientRect();
    if (!a.width || !b.width) return;
    const fly = target.cloneNode(true);
    fly.removeAttribute("data-i");
    fly.setAttribute("class", "flyer");
    Object.assign(fly.style, { left: b.left + "px", top: b.top + "px", width: b.width + "px", height: b.height + "px" });
    document.body.appendChild(fly);
    target.style.visibility = "hidden";
    const s = Math.min(a.width / b.width, a.height / b.height);
    fly.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${s})` }, { transform: "none" }],
                { duration: 450, easing: "ease-out" })
      .finished.catch(() => {}).then(() => { fly.remove(); target.style.visibility = ""; });
  } catch {}
}
function undo() {
  if (S.screen !== "ring" || !S.scene || !S.history.length) return;   // nothing, and silence (§2.2)
  hush();
  say("Undo");
  const ev = S.history.pop();
  if (ev.t === "place") S.scene.items.pop();
  else if (ev.t === "move" && S.scene.items[ev.i]) Object.assign(S.scene.items[ev.i], ev.from);
  paintScene();
  log("undo", { t: ev.t });
  changed();
}
function changed() { S.dirty = true; stash(); scheduleSave(); }
function scheduleSave() { clearTimeout(S.saveTimer); S.saveTimer = setTimeout(() => { save(); }, SAVE_MS); }
// Last write wins. A failed save logs one line and keeps the picture (memory + localStorage,
// dirty); the next change — or the next open of this picture — tries again.
async function save(opts = {}) {
  clearTimeout(S.saveTimer);
  S.saveTimer = null;
  if (!S.dirty || !S.id || !S.scene) return true;
  const id = S.id, body = JSON.stringify(S.scene);
  try {
    const r = await fetch("/drawings/" + encodeURIComponent(id) + "/scene.json", { method: "PUT",
      headers: { "Content-Type": "application/json" }, body, keepalive: !!opts.keepalive });
    if (!r.ok) throw new Error("PUT " + r.status);
    if (S.id === id && JSON.stringify(S.scene) === body) { S.dirty = false; stash(); }
    return true;
  } catch (e) {
    log("save_failed", { id, why: String(e && e.message) });
    return false;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/drawing-ui.test.mjs`
Expected: `# pass 13`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add public/drawing/drawing.js tests/drawing-ui.test.mjs
git commit -m "drawing: pick and it lands — one dwell speaks the word and the sticker flies to its slot; Undo; every change autosaved (800 ms, keepalive on leaving) and kept in localStorage until the hub has it; 200 is the cap (spec 2026-09-30 §2.1, §2.2, §4)"
```

---

### Task 9: The grown-up — the tab in the bar, the sheet (tune, Clear, mail truth) and the finger drag

**Files:**
- Modify: `public/drawing/index.html` — insert the sheet markup just above `<script src="../dwell.js"></script>`; add `<script src="partner.js" defer></script>` right after `<script src="drawing.js" defer></script>`
- Modify: `public/drawing/drawing.css` — insert the partner block just above the final `@media (prefers-reduced-motion: reduce)` line
- Modify: `public/drawing/drawing.js` — replace the section `// ---------- the grown-up's hands (partner.js calls these; spec §2.4) — T9 ----------`
- Create: `public/drawing/partner.js`
- Test: `tests/drawing-ui.test.mjs` (append)

**Interfaces:**
- Consumes: `window.Drawing` (T7: `state, itemAt, moveItem, clamp, clearPicture, repaint, tuneDwell, dwellMs, freeze, thaw, say, mailLine, onMail`); `push`, `changed`, `paintScene` (T7/T8).
- Produces: `#partnerTab` (inside `.msgbar`), `#partnerSheet` with `#pSlower #pFaster #pDwell #pClear #pClearYes #pClearRow #pMail #pClose`; `setMail(res)` (T11 calls it); `frozen` is non-empty while the sheet is up (T10's poll checks it).

- [ ] **Step 1: Write the failing tests** — append to `tests/drawing-ui.test.mjs`:

```js
// ================================================================ T9 — the grown-up
async function finger(page, from, to, steps = 6) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
    for (let k = 1; k <= steps; k++)
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove",
        touchPoints: [{ x: from.x + ((to.x - from.x) * k) / steps, y: from.y + ((to.y - from.y) * k) / steps }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach().catch(() => {}); }
}
const centreOf = async (page, sel) => { const b = await page.locator(sel).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

test("the grown-up's tab sits in the door bar and is never a gaze target", async () => {
  const { ctx, page } = await openRing();
  const t = await page.evaluate(() => {
    const el = document.getElementById("partnerTab");
    return { inBar: !!el.closest(".msgbar"), dwell: el.matches(".dwell"),
             attrs: [...el.attributes].map((a) => a.name).filter((n) => n.startsWith("data-dwell")) };
  });
  assert.deepEqual(t, { inBar: true, dwell: false, attrs: [] });
  await ctx.close();
});

test("the sheet puts every target to sleep but the two doors, says no picture is finished yet, and wakes them on close", async () => {
  const { ctx, page } = await openRing();
  await page.locator("#partnerTab").click();
  let r = await page.evaluate(() => ({ live: [...document.querySelectorAll(".dwell")].map((e) => e.id).sort(),
    asleep: document.querySelectorAll("#sRing [data-dwell-disabled]").length }));
  assert.deepEqual(r, { live: ["barDoor", "barTalk"], asleep: 10 });
  assert.equal(await page.textContent("#pMail"), "No picture finished yet");
  await page.locator("#pClose").click();
  r = await page.evaluate(() => ({ live: document.querySelectorAll("#sRing .dwell").length,
    asleep: document.querySelectorAll("[data-dwell-disabled]").length }));
  assert.deepEqual(r, { live: 10, asleep: 0 });
  await ctx.close();
});

test("dwell tune: 200 ms a tap, clamped 800-3000, and the doors follow at 2x", async () => {
  const { ctx, page } = await openRing();
  await page.locator("#partnerTab").click();
  await page.locator("#pSlower").click();
  assert.equal(await page.evaluate(() => window.Dwell.config.ms), 1400);
  assert.equal(await page.getAttribute("#barDoor", "data-dwell-ms"), "2800");
  assert.equal(await page.textContent("#pDwell"), "1400 ms");
  for (let k = 0; k < 12; k++) await page.locator("#pSlower").click();
  assert.equal(await page.evaluate(() => window.Dwell.config.ms), 3000);
  for (let k = 0; k < 20; k++) await page.locator("#pFaster").click();
  assert.equal(await page.evaluate(() => window.Dwell.config.ms), 800);
  assert.equal(await page.getAttribute("#barDoor", "data-dwell-ms"), "1600");
  await ctx.close();
});

test("Clear picture: two stages, spoken, the same picture stays open, and the blank picture leaves the shelf", async () => {
  const { ctx, page, id } = await openRing();
  const first = page.waitForResponse((r) => r.request().method() === "PUT" && r.ok());
  await page.locator("#tile-horse").click();
  await page.locator("#tile-sun").click();
  await first;
  assert.ok((await (await fetch(`${BASE}/drawings/index.json`)).json()).some((p) => p.id === id), "listed while it has stickers");
  await page.locator("#partnerTab").click();
  await page.locator("#pClear").click();
  let s = await st(page);
  assert.equal(s.items.length, 2, "one tap never clears");
  assert.equal(s.said.at(-1), "Clear the whole picture?");
  assert.equal(await page.isVisible("#pClearYes"), true);
  const cleared = page.waitForResponse((r) => r.request().method() === "PUT" && r.ok());
  await page.locator("#pClearYes").click();
  s = await st(page);
  assert.deepEqual([s.items.length, s.id, s.screen, s.history], [0, id, "ring", 0]);
  assert.equal(s.said.at(-1), "All clear! A fresh picture.");
  await cleared;
  assert.ok(!(await (await fetch(`${BASE}/drawings/index.json`)).json()).some((p) => p.id === id), "a blank picture is not listed");
  await ctx.close();
});

test("a grown-up's finger drags a sticker (one move in her history, saved, undoable); a mouse drag never moves it", async () => {
  const { ctx, page } = await openRing();
  await page.locator("#tile-horse").click();
  await page.waitForFunction(() => !document.querySelector(".flyer"));
  const sw = await page.evaluate(() => document.getElementById("scene").getBoundingClientRect().width);
  const from = await centreOf(page, '#scene [data-i="0"]');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 200, from.y - 50, { steps: 6 });
  await page.mouse.up();
  let s = await st(page);
  assert.deepEqual([s.items[0], s.history], [{ s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" }, 1], "a mouse is her gaze: nothing moves");
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.ok() && r.request().postData().includes('"partner"'));
  await finger(page, from, { x: from.x - 200, y: from.y - 50 });
  s = await st(page);
  assert.ok(Math.abs(s.items[0].x - (0.5 - 200 / sw)) < 0.01, JSON.stringify(s.items[0]));
  assert.equal(s.items[0].by, "partner");
  assert.equal(s.history, 2);
  await saved;
  await page.locator("#btnUndo").click();
  assert.deepEqual((await st(page)).items[0], { s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" }, "Undo puts it back");
  await ctx.close();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/drawing-ui.test.mjs`
Expected: the thirteen earlier tests pass; the five new ones FAIL (`#partnerTab` does not exist).

- [ ] **Step 3: Add the sheet to `index.html`** (above `<script src="../dwell.js"></script>`), then the script tag after `drawing.js`:

```html
<!-- THE GROWN-UP'S SHEET (spec §2.4): opened by the tab partner.js puts in the door bar.
     Touch/click only — nothing here is .dwell or carries a data-dwell-*. -->
<div id="partnerSheet" hidden>
  <div class="sheet-card" role="dialog" aria-label="Grown-ups">
    <h2>Grown-ups</h2>
    <div class="sheet-row">Dwell
      <button type="button" id="pSlower" class="sheet-btn">🐢 +200</button>
      <b id="pDwell"></b>
      <button type="button" id="pFaster" class="sheet-btn">🐇 −200</button></div>
    <div class="sheet-row" id="pClearRow">
      <button type="button" id="pClear" class="sheet-btn">🗑 Clear picture</button>
      <button type="button" id="pClearYes" class="sheet-btn warn" hidden>Yes, clear</button></div>
    <p class="sheet-say" id="pMail"></p>
    <div class="sheet-row"><button type="button" id="pClose" class="sheet-btn">Close</button></div>
  </div>
</div>
```

```html
<script src="partner.js" defer></script>
```

- [ ] **Step 4: Add the partner block to `drawing.css`** (above the final `@media` line):

```css
/* ---- the grown-up's tab (in the bar, right end) and sheet ---- */
#partnerTab{margin-left:auto; flex:0 0 auto; height:var(--bar-inner, 40px); border:none; border-radius:10px;
            padding:0 14px; cursor:pointer; font-family:var(--font); line-height:1; white-space:nowrap;
            font-size:calc(var(--bar-inner, 40px) * 0.34); font-weight:700;
            background:rgba(255,255,255,.16); color:#fff}
#partnerSheet{position:fixed; inset:0; top:var(--bar-h, 0px); z-index:90; display:flex;
              align-items:center; justify-content:center; background:rgba(0,0,0,.45)}
.sheet-card{background:#fff; color:var(--ink); width:min(560px, 88vw); padding:22px 24px;
            border-radius:18px; box-shadow:0 12px 40px rgba(0,0,0,.35)}
.sheet-card h2{margin:0 0 8px; font-size:28px}
.sheet-row{display:flex; gap:12px; align-items:center; margin-top:14px; font-size:20px}
.sheet-btn{border:none; border-radius:10px; padding:12px 20px; cursor:pointer; font-family:var(--font);
           font-size:20px; font-weight:700; background:#E3EAEC; color:var(--ink)}
.sheet-btn.warn{background:var(--warn); color:#fff}
.sheet-say{margin:14px 0 0; font-size:19px; line-height:1.3; min-height:1.3em}
```

- [ ] **Step 5: Replace the T9 section of `drawing.js` with:**

```js
// ---------- the grown-up's hands (partner.js calls these; spec §2.4) — T9 ----------
function itemAt(i) { const it = S.scene && S.scene.items[i]; return it ? { ...it } : null; }
function moveItem(i, x, y) {
  const it = S.scene && S.scene.items[i];
  if (!it) return;
  const c = SC.clampItem({ x, y, w: it.w });
  push({ t: "move", i, from: { x: it.x, y: it.y, by: it.by } });
  it.x = c.x; it.y = c.y; it.by = "partner";
  paintScene();
  log("partner", { action: "move", s: it.s });
  changed();
}
async function clearPicture() {
  if (S.screen !== "ring" || !S.scene) return;
  S.scene.items = [];
  S.history = [];                     // not undoable: it had its own two-stage confirm
  paintScene();
  log("partner", { action: "clear" });
  changed();
  hush();
  await say("All clear! A fresh picture.");
}
function tuneDwell(d) {
  const cur = window.Dwell ? Dwell.config.ms : EC.holds.content;
  const ms = Math.max(EC.holds.floor, Math.min(EC.holds.tuneMax, cur + d));
  if (window.Dwell) Dwell.setMs(ms);
  if (BAR) BAR.setDwell(ms);          // the doors stay 2 x the dwell she is actually on
  log("partner", { action: "dwell", ms });
  return ms;
}
// A full-screen sheet hides nothing from dwell.js (board-partner.js:53-71): every target but the
// two doors loses .dwell and gains data-dwell-disabled while it is up.
function freeze() {
  const live = [...document.querySelectorAll(".dwell")].filter((el) => !BAR_DOORS.has(el.id));
  for (const el of live) { el.classList.remove("dwell"); el.setAttribute("data-dwell-disabled", ""); }
  frozen = frozen.concat(live);
}
function thaw() {
  for (const el of frozen) { el.classList.add("dwell"); el.removeAttribute("data-dwell-disabled"); }
  frozen = [];
  suppress(600);
}
function mailLine() {
  const m = S.lastMail;
  if (!m) return "No picture finished yet";
  if (m.saved === false) return "Not saved — the hub did not answer";
  return MAIL_LINES[m.mail] || "Saved";
}
function setMail(res) {
  S.lastMail = res;
  try { localStorage.setItem("drawing_mail_last", JSON.stringify(res)); } catch {}
  for (const cb of mailWatchers) { try { cb(mailLine()); } catch {} }
}
```

- [ ] **Step 6: Write `public/drawing/partner.js`:**

```js
/*
 * partner.js — the grown-up's side of Drawing (spec 2026-09-30 §2.4).
 *
 * A tab at the RIGHT end of the shared door bar (the one slot doorbar.js lets a touch-only control
 * have — board-partner.js's strip) opens one sheet: dwell tune, Clear picture (two stages,
 * spoken), and the last Done's mail truth. And a FINGER may drag a sticker she placed to move it.
 * Nothing here is .dwell or carries a data-dwell-*: ERAgaze moves a MOUSE, so her gaze can never
 * open the sheet or drag a sticker.
 */
"use strict";
(function () {
  const D = window.Drawing;
  const $ = (id) => document.getElementById(id);
  const sheet = $("partnerSheet");

  const tab = document.createElement("button");
  tab.type = "button";
  tab.id = "partnerTab";
  tab.textContent = "⚙ grown-ups";                 // deliberately NO .dwell, NO data-dwell-*
  const bar = document.querySelector(".msgbar");
  if (bar) bar.appendChild(tab);

  let clearArmed = false;
  function paint() {
    $("pDwell").textContent = D.dwellMs() + " ms";
    $("pMail").textContent = D.mailLine();
    $("pClearRow").hidden = D.state().screen !== "ring";
    $("pClear").textContent = clearArmed ? "Clear the whole picture?" : "🗑 Clear picture";
    $("pClearYes").hidden = !clearArmed;
  }
  function open() { if (!sheet.hidden) return; clearArmed = false; D.freeze(); sheet.hidden = false; paint(); }
  function close() { if (sheet.hidden) return; sheet.hidden = true; clearArmed = false; D.thaw(); }
  tab.addEventListener("click", () => (sheet.hidden ? open() : close()));
  $("pClose").addEventListener("click", close);
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });     // the backdrop
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  $("pSlower").addEventListener("click", () => { D.tuneDwell(+200); paint(); });
  $("pFaster").addEventListener("click", () => { D.tuneDwell(-200); paint(); });
  $("pClear").addEventListener("click", () => {
    if (clearArmed) return;
    clearArmed = true;
    paint();
    D.say("Clear the whole picture?");
  });
  $("pClearYes").addEventListener("click", async () => {
    clearArmed = false;
    paint();
    await D.clearPicture();
  });
  D.onMail(() => { if (!sheet.hidden) paint(); });

  // ---- the finger drag: pointerType "touch" only (a mouse = her gaze, never drags) ----
  const scene = $("scene");
  let drag = null;
  scene.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    const el = e.target && e.target.closest ? e.target.closest("[data-i]") : null;
    if (!el || !scene.contains(el)) return;
    const i = Number(el.getAttribute("data-i")), it = D.itemAt(i);
    if (!it) return;
    e.preventDefault();
    drag = { i, id: e.pointerId, el, x0: e.clientX, y0: e.clientY, it,
             r: scene.getBoundingClientRect(), nx: it.x, ny: it.y, moved: false };
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  scene.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const c = D.clamp({ x: drag.it.x + (e.clientX - drag.x0) / drag.r.width,
                        y: drag.it.y + (e.clientY - drag.y0) / drag.r.height, w: drag.it.w });
    drag.nx = c.x; drag.ny = c.y; drag.moved = true;
    drag.el.style.transform = `translate(${(c.x - drag.it.x) * drag.r.width}px, ${(c.y - drag.it.y) * drag.r.height}px)`;
  });
  const end = (commit) => (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (commit && d.moved) D.moveItem(d.i, d.nx, d.ny);    // one "move" in her history, autosaved
    else D.repaint();
  };
  scene.addEventListener("pointerup", end(true));
  scene.addEventListener("pointercancel", end(false));
  scene.addEventListener("contextmenu", (e) => e.preventDefault());
})();
```

- [ ] **Step 7: Run the tests**

Run: `node --test tests/drawing-ui.test.mjs`
Expected: `# pass 18`, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add public/drawing/index.html public/drawing/drawing.css public/drawing/drawing.js public/drawing/partner.js tests/drawing-ui.test.mjs
git commit -m "drawing: the grown-up's tab in the door bar — a sheet that freezes every target but the doors (dwell tune, two-stage spoken Clear, the last Done's mail truth) — and a finger drag that moves a sticker while her gaze never can (spec 2026-09-30 §2.4)"
```

---

### Task 10: The shelf — "My pictures", newest first, thumbnails from scene.json, More, New picture

**Files:**
- Modify: `public/drawing/drawing.js` — replace the section `// ---------- the shelf (spec §3) — T10 ----------`
- Test: `tests/drawing-ui.test.mjs` (append)

**Interfaces:**
- Consumes: `GET /drawings/index.json`, `POST /drawings` (T4); `SC.renderScene` (T6); `go`, `show`, `suppress`, `tellPark`, `hush`, `frozen` (T7/T9).
- Produces: `openShelf()`, `renderShelf()`, `turnShelf(page)`, `refreshIndex()`, `startPoll()`, `stopPoll()`, `pollShelf()`, `newPicture()`; shelf cells `button.cell.shelf-pic.photo.dwell[data-id][data-cell]`, `.shelf-black`, `#shelfMore`; `state().shelfIds / shelfPage / shelfPages`.

- [ ] **Step 1: Write the failing tests** — append to `tests/drawing-ui.test.mjs`:

```js
// ================================================================ T10 — the shelf
const PIC_CELLS = ["1,1", "1,2", "1,3", "1,4", "2,1", "2,4", "3,2", "3,3", "3,4"];
const ALL_CELLS = ["1,1", "1,2", "1,3", "1,4", "2,1", "2,2", "2,3", "2,4", "3,1", "3,2", "3,3", "3,4"];
const cellsOf = (page) => page.evaluate(() => {
  const out = {};
  for (const el of document.querySelectorAll("#shelfGrid > [data-cell]")) out[el.dataset.cell] = {
    kind: el.classList.contains("shelf-black") ? "black" : el.id === "shelfMore" ? "more" : el.dataset.id ? "pic" : "other",
    id: el.dataset.id || null, dwell: el.classList.contains("dwell"), text: el.textContent.trim(),
    attrs: [...el.attributes].some((a) => a.name.startsWith("data-dwell")),
  };
  return out;
});
// n pictures, newest first, an hour apart back from `base`; returns their ids newest first
function seedShelf(n, base = Date.UTC(2026, 8, 30, 12, 0, 0)) {
  fs.rmSync(PICS, { recursive: true, force: true });
  const ids = [];
  for (let k = 0; k < n; k++) {
    const d = new Date(base - k * 3600e3), s = d.toISOString();
    const id = s.slice(0, 10) + "-" + s.slice(11, 19).replace(/:/g, "") + "-test-dev";
    seed(id, [H(), { s: "sun", x: 0.5, y: 0.17, w: 0.16, by: "ellie" }], s);
    ids.push(id);
  }
  return ids;
}

test("the shelf: New picture in the rail, the centre two black, newest first, More at [3,1] past nine; blank pictures never listed", async () => {
  const ids = seedShelf(11);
  seed("2026-09-30-130000-test-dev", [], "2026-09-30T13:00:00Z");          // blank (and newest): not listed
  const { ctx, page } = await makePage();
  const c = await cellsOf(page);
  assert.deepEqual(Object.keys(c).sort(), [...ALL_CELLS].sort());
  for (const k of ["2,2", "2,3"]) assert.deepEqual([c[k].kind, c[k].dwell, c[k].text, c[k].attrs], ["black", false, "", false], k);
  assert.deepEqual([c["3,1"].kind, c["3,1"].dwell], ["more", true]);
  assert.deepEqual(PIC_CELLS.map((k) => c[k].id), ids.slice(0, 9));
  assert.equal((await st(page)).shelfPages, 2);
  assert.equal(await page.locator("#railNew.dwell").count(), 1);
  await page.locator("#shelfMore").click();
  const c2 = await cellsOf(page);
  assert.deepEqual(PIC_CELLS.map((k) => c2[k].id), [ids[9], ids[10], null, null, null, null, null, null, null]);
  for (const k of PIC_CELLS.slice(2)) assert.equal(c2[k].kind, "black", k);
  await page.locator("#shelfMore").click();
  assert.equal((await st(page)).shelfPage, 0, "More loops back to page 1");
  await ctx.close();
});

test("a shelf cell is her picture drawn from scene.json by the same renderer, with a date plate", async () => {
  const [id] = seedShelf(1);
  const { ctx, page } = await makePage();
  const t = await page.evaluate((id) => {
    const el = document.querySelector(`#shelfGrid [data-id="${id}"]`), th = el.querySelector(".thumb"), r = th.getBoundingClientRect();
    return { items: th.querySelectorAll(".item").length, img: th.querySelector("img.item").getAttribute("src"),
             bg: th.style.background, plate: el.querySelector(".plate").textContent, ratio: r.width / r.height };
  }, id);
  assert.deepEqual([t.items, t.img, t.plate], [2, "stickers/horse.png", "Wed 30 Sep"]);
  assert.match(t.bg, /linear-gradient/);
  assert.ok(Math.abs(t.ratio - 16 / 9) < 0.02, String(t.ratio));
  assert.equal((await cellsOf(page))["3,1"].kind, "black", "one page: [3,1] stays black");
  await ctx.close();
});

test("a picture on the shelf opens the ring on it, and she keeps adding", async () => {
  const [id] = seedShelf(1);
  const { ctx, page } = await makePage();
  await page.locator(`#shelfGrid [data-id="${id}"]`).click();
  await page.waitForFunction(() => window.Drawing.state().screen === "ring");
  assert.deepEqual([(await st(page)).id, (await st(page)).items.length], [id, 2]);
  await page.locator("#tile-star").click();
  assert.equal((await st(page)).items.length, 3);
  await ctx.close();
});

test("New picture: the hub gives it an id, the ring opens empty, and the shelf does not list it yet", async () => {
  seedShelf(0);
  const { ctx, page } = await makePage();
  await page.locator("#railNew").click();
  await page.waitForFunction(() => window.Drawing.state().screen === "ring");
  const s = await st(page);
  assert.match(s.id, /^\d{4}-\d{2}-\d{2}-\d{6}-test-dev(-\d+)?$/);
  assert.equal(s.items.length, 0);
  assert.equal(await page.evaluate(() => location.hash), "#p=" + s.id);
  assert.deepEqual(await (await fetch(`${BASE}/drawings/index.json`)).json(), []);
  assert.ok(fs.existsSync(path.join(PICS, s.id, ".local")), "no Drive folder here: kept on this device, marked .local");
  await ctx.close();
});

test("a picture another device made shows up on the open shelf without a relaunch", async () => {
  seedShelf(1);
  const { ctx, page } = await makePage();
  assert.equal((await st(page)).shelfIds.length, 1);
  seed("2026-09-30-140000-other-dev", [H()], "2026-09-30T14:00:00Z");     // the mirror just carried it in
  await page.evaluate(() => window.Drawing.pollShelf());
  assert.deepEqual((await st(page)).shelfIds.slice(0, 2), ["2026-09-30-140000-other-dev", "2026-09-30-120000-test-dev"]);
  await ctx.close();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/drawing-ui.test.mjs`
Expected: the eighteen earlier tests pass; the five new ones FAIL (the shelf grid is empty: no `[data-cell]`).

- [ ] **Step 3: Replace the T10 section of `drawing.js` with:**

```js
// ---------- the shelf (spec §3) — T10 ----------
async function refreshIndex() {
  try {
    const j = await (await fetch("/drawings/index.json", { cache: "no-store" })).json();
    S.index = Array.isArray(j) ? j : [];
  } catch { S.index = []; }
}
const shelfSig = () => JSON.stringify(S.index.map((p) => [p.id, p.updated, p.items]));
function plate(when) {
  const d = new Date(when);
  if (!Number.isFinite(d.getTime())) return "";
  return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()];
}
function blackCell() {
  const d = document.createElement("div");
  d.className = "shelf-black";
  d.setAttribute("aria-hidden", "true");
  return d;
}
function picCell(p) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cell shelf-pic photo dwell";
  b.dataset.id = p.id;
  const when = plate(p.created);
  b.setAttribute("aria-label", "Picture " + when);
  const box = document.createElement("span");
  box.className = "thumbBox";
  const th = document.createElement("span");
  th.className = "scene thumb";
  SC.renderScene(th, p.scene, { table: S.table });      // the same renderer as the ring
  box.appendChild(th);
  const pl = document.createElement("span");
  pl.className = "plate";
  pl.textContent = when;
  b.append(box, pl);
  b.addEventListener("click", () => { hush(); go(p.id); });
  return b;
}
function moreCell(pages) {
  const b = document.createElement("button");
  b.type = "button";
  b.id = "shelfMore";
  b.className = "cell text dwell";
  b.setAttribute("aria-label", "More pictures");
  const w = document.createElement("span");
  w.className = "word";
  w.textContent = "More ▶";
  b.appendChild(w);
  b.addEventListener("click", () => turnShelf((S.shelfPage + 1) % pages));   // the last page loops
  return b;
}
function renderShelf() {
  const pages = Math.max(1, Math.ceil(S.index.length / PER_PAGE));
  if (S.shelfPage >= pages) S.shelfPage = pages - 1;
  if (S.shelfPage < 0) S.shelfPage = 0;
  S.shelfPages = pages;
  const slice = S.index.slice(S.shelfPage * PER_PAGE, (S.shelfPage + 1) * PER_PAGE);
  const at = new Map();
  BOOK_CELLS.forEach(([r, c], i) => at.set(r + "," + c, slice[i] ? picCell(slice[i]) : blackCell()));
  at.set("2,2", blackCell());
  at.set("2,3", blackCell());
  at.set("3,1", pages > 1 ? moreCell(pages) : blackCell());
  const kids = [];
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 4; c++) {
    const el = at.get(r + "," + c);
    el.dataset.cell = r + "," + c;
    el.style.gridRow = String(r);
    el.style.gridColumn = String(c);
    kids.push(el);
  }
  $("shelfGrid").replaceChildren(...kids);
  S.shelfIds = slice.map((p) => p.id);
  S.painted = shelfSig();
}
function turnShelf(page) {
  hush();
  S.shelfPage = page;
  renderShelf();
  suppress();
  log("shelf-page", { page });
}
async function openShelf() {
  const fresh = S.screen !== "shelf";
  S.id = null; S.scene = null; S.history = []; S.dirty = false;
  await refreshIndex();
  if (fresh) S.shelfPage = 0;                           // every return lands on page 1: newest first
  show("shelf");
  renderShelf();
  suppress();
  tellPark();
  startPoll();
}
function startPoll() { stopPoll(); S.pollTimer = setInterval(pollShelf, POLL_MS); }
function stopPoll() { if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; } }
// Repaint ONLY when something changed (a rebuild throws away an in-flight dwell — reader.js's
// lesson), and never under a grown-up's open sheet.
async function pollShelf() {
  if (S.screen !== "shelf" || frozen.length) return;
  await refreshIndex();
  if (shelfSig() === S.painted) return;
  renderShelf();
  suppress();
  tellPark();
}
async function newPicture() {
  hush();
  try {
    const r = await fetch("/drawings", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const j = await r.json();
    if (r.ok && j && ID_RE.test(j.id)) { log("new", { id: j.id }); go(j.id); return; }
  } catch {}
  log("new_failed", {});             // the hub did not answer: she stays on her shelf, nothing is said
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/drawing-ui.test.mjs`
Expected: `# pass 23`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add public/drawing/drawing.js tests/drawing-ui.test.mjs
git commit -m "drawing: My pictures — the Reader's TD Snap page (New picture rail, 3x4 centre-black, More at [3,1]), each picture drawn from its scene.json by the ring's own renderer; blank pictures never listed; a picture from another device appears on the next look (spec 2026-09-30 §3)"
```

---

### Task 11: Done — the PNG, the celebration that names what she made, back to the shelf

**Files:**
- Modify: `public/drawing/drawing.js` — replace the section `// ---------- Done (spec §2.3) — T11 ----------`
- Test: `tests/drawing-ui.test.mjs` (append)

**Interfaces:**
- Consumes: `POST /drawings/<id>/done` (T5); `SC.renderScene` on a canvas + `SC.describe` (T6); `save` (T8); `setMail` (T9); `go` → `openShelf` (T7/T10).
- Produces: `exportPng(scene) → Promise<Blob>` (1600×900 PNG), `done()`.

- [ ] **Step 1: Write the failing tests** — append to `tests/drawing-ui.test.mjs`:

```js
// ================================================================ T11 — Done
test("Done: a 1600x900 PNG goes to the hub, she hears what she made (never \"sent\"), and the shelf opens with it first", async () => {
  seedShelf(3, Date.now() - 3600e3);                      // older pictures already on the shelf
  const { ctx, page, id } = await openRing();
  for (const t of ["horse", "house", "star", "star"]) await page.locator("#tile-" + t).click();
  const req = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/drawings/${id}/done`));
  await page.locator("#btnDone").click();
  const png = (await req).postDataBuffer();
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1600, 900]);
  await page.waitForFunction(() => window.Drawing.state().screen === "shelf");
  let s = await st(page);
  assert.ok(s.said.includes("You made a picture with a horse, a house and two stars!"), JSON.stringify(s.said));
  assert.ok(!s.said.some((t) => /sent/i.test(t)), "the mail is never spoken");
  assert.equal(s.shelfIds[0], id, "her picture is the first cell");
  await page.waitForFunction(() => window.Drawing.state().lastMail);
  assert.deepEqual((await st(page)).lastMail, { id, saved: true, mail: "no-email" });
  assert.ok(fs.existsSync(path.join(PICS, id, "picture.png")));
  await ctx.close();
});

test("Done on a blank picture: \"You made a picture!\", saved, never mailed, not on the shelf", async () => {
  seedShelf(0);
  const { ctx, page, id } = await openRing();
  await page.locator("#btnDone").click();
  await page.waitForFunction(() => window.Drawing.state().screen === "shelf" && window.Drawing.state().lastMail);
  const s = await st(page);
  assert.ok(s.said.includes("You made a picture!"));
  assert.deepEqual(s.lastMail, { id, saved: true, mail: "empty" });
  assert.deepEqual(s.shelfIds, []);
  assert.ok(fs.existsSync(path.join(PICS, id, "picture.png")), "saved all the same");
  await ctx.close();
});

test("the partner line tells the mail truth, one line per answer", async () => {
  for (const [answer, line] of [
    [{ saved: true, mail: "sent" }, "Sent to your family"],
    [{ saved: true, mail: "no-email" }, "Saved — no family email set up yet"],
    [{ saved: true, mail: "failed", reason: "x" }, "Saved — mail failed, will not retry"],
    [{ saved: true, mail: "unchanged" }, "Saved — already sent, nothing new to send"],
    [{ saved: true, mail: "empty" }, "Saved — the picture is empty, nothing sent"],
    [null, "Not saved — the hub did not answer"],
  ]) {
    const { ctx, page } = await openRing({ routes: (c) => c.route("**/drawings/*/done", (r) => (answer
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answer) }) : r.abort())) });
    await page.locator("#tile-sun").click();
    await page.locator("#btnDone").click();
    await page.waitForFunction(() => window.Drawing.state().screen === "shelf" && window.Drawing.state().lastMail);
    await page.locator("#partnerTab").click();
    assert.equal(await page.textContent("#pMail"), line, JSON.stringify(answer));
    assert.equal(await page.isVisible("#pClearRow"), false, "Clear lives on the ring only");
    await ctx.close();
  }
});

test("the celebration does not wait for the mail (deviation 9)", async () => {
  let release;
  const held = new Promise((r) => (release = r));
  const { ctx, page } = await openRing({ routes: (c) => c.route("**/drawings/*/done", async (r) => { await held; await r.continue(); }) });
  await page.locator("#tile-tree").click();
  await page.locator("#btnDone").click();
  await page.waitForFunction(() => window.Drawing.state().said.some((t) => t.startsWith("You made a picture")), null, { timeout: 3000 });
  assert.equal((await st(page)).lastMail, null, "the mail has not answered yet");
  release();
  await page.waitForFunction(() => window.Drawing.state().lastMail, null, { timeout: 5000 });
  await ctx.close();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/drawing-ui.test.mjs`
Expected: the twenty-three earlier tests pass; the four new ones FAIL (Done does nothing: no request, the screen stays `ring`).

- [ ] **Step 3: Replace the T11 section of `drawing.js` with:**

```js
// ---------- Done (spec §2.3) — T11 ----------
async function exportPng(scene) {
  await Promise.all(Object.values(S.images).map((im) => (im.decode ? im.decode().catch(() => {}) : null)));
  const c = document.createElement("canvas");
  c.width = 1600; c.height = 900;
  SC.renderScene(c.getContext("2d"), scene, { table: S.table, images: S.images });
  return new Promise((res) => c.toBlob(res, "image/png"));
}
async function done() {
  if (S.screen !== "ring" || !S.scene || S.finishing) return;
  S.finishing = true;
  hush();
  const id = S.id, scene = JSON.parse(JSON.stringify(S.scene));
  const saved = save();                                  // her last sticker first
  // The PNG and the mail run alongside the celebration (deviation 9); the answer goes to the
  // partner line only — never spoken (the Pencil's truth rule).
  const posted = saved.then(() => exportPng(scene))
    .then((blob) => fetch("/drawings/" + encodeURIComponent(id) + "/done",
      { method: "POST", headers: { "Content-Type": "image/png" }, body: blob }))
    .then((r) => (r.ok ? r.json() : { saved: false, mail: "failed", reason: "hub " + r.status }))
    .catch(() => ({ saved: false, mail: "failed", reason: "no answer" }))
    .then((res) => { setMail({ id, ...res }); log("done", { id, mail: res.mail }); return res; });
  confetti(24);
  try {
    await say(SC.describe(scene.items, S.table));        // what she DID
    await saved;
  } finally { S.finishing = false; }                     // Done can never stay latched
  go(null);                                               // the shelf, this picture first (newest change)
  return posted;
}
```

- [ ] **Step 4: Run the tests, then look at the PNG**

Run: `node --test tests/drawing-ui.test.mjs`
Expected: `# pass 27`, `# fail 0`. Then on a worktree hub place a few stickers, press Done, `curl -s -o $SCRATCH/picture.png http://127.0.0.1:$P/drawings/<id>/picture.png` and Read it: the same meadow and stickers as the ring, 1600×900.

- [ ] **Step 5: Commit**

```bash
git add public/drawing/drawing.js tests/drawing-ui.test.mjs
git commit -m "drawing: Done — a 1600x900 PNG from the same renderer, confetti and a sentence naming what she made (never the mail), then her shelf with the picture first; the mail truth goes to the partner line (spec 2026-09-30 §2.3)"
```

---
### Task 12: Register the app — APPS, the icon, the payload copy, and the registry suites

**Files:**
- Modify: `server.js` — `APPS` (`:119-127`): one entry after `reader`
- Create: `tools/drawing-icon.mjs`; generated: `public/icons/drawing.png`, `public/icons/drawing.ico`
- Modify: `tools/build-payload.sh` — after `cp -r "$HUB/public/book-review" "$OUT/public/book-review"` (`:125`)
- Test: `tests/apps.test.mjs`, `tests/home-tiles.test.mjs`, `tests/shortcuts.test.mjs`, `tests/packs.test.mjs` (append one test each); `tests/icons.test.mjs` picks the app up unchanged (it walks `/apps`)

**Interfaces:**
- Consumes: the page at `/drawing/` (T7–T11), `drawings.js` in the engine list (T4).
- Produces: `GET /apps` lists `{ id: "drawing", title: "Drawing", sub: "make a picture with stickers", path: "/drawing/", icon: "/icons/drawing.png", engine: false, installed: true }`; a home tile when enabled; a `Drawing.lnk` with `drawing.ico` on Windows; the app ships in every payload. NOT touched (deviation 1): `public/settings/index.html:792`, `packs.js`, `tools/installer.nsi`.

- [ ] **Step 1: Write the failing tests** — append to `tests/apps.test.mjs`:

```js
// Drawing (spec 2026-09-30 §1): a CORE app — registered, on wherever no apps.json says otherwise,
// always installed (its files ride with the engine), and never offered a "remove files" button,
// because /apps/delete refuses a core app (plan deviation 1).
test("Drawing is a core app: registered as the spec says, always installed, never removable", async () => {
  const { apps } = await (await fetch(`${BASE}/apps`)).json();
  const d = apps.find(a => a.id === "drawing");
  assert.ok(d, "Drawing is in the registry");
  assert.deepEqual({ title: d.title, sub: d.sub, path: d.path, engine: d.engine, installed: d.installed, icon: d.icon },
    { title: "Drawing", sub: "make a picture with stickers", path: "/drawing/", engine: false, installed: true, icon: "/icons/drawing.png" });
  if (d.enabled) assert.equal((await fetch(`${BASE}/apps`, { method: "POST", body: JSON.stringify({ id: "drawing", enabled: false }) })).status, 204);
  const r = await fetch(`${BASE}/apps/delete`, { method: "POST", body: JSON.stringify({ id: "drawing" }) });
  assert.equal(r.status, 400);
  assert.equal(await r.text(), "core app");
  const settings = fs.readFileSync(path.join(HUB, "public", "settings", "index.html"), "utf8");
  const removable = settings.match(/\(a\.engine \|\| (\[[^\]]*\])\.includes\(a\.id\)\)/);
  assert.ok(removable, "Settings' remove-files list is where it was");
  assert.ok(!JSON.parse(removable[1]).includes("drawing"), "no remove-files button for a core app");
});
```

to `tests/home-tiles.test.mjs`:

```js
test("Drawing switched on has a tile of its own, with its icon", async () => {
  const r = await fetch(`${BASE}/apps`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "drawing", enabled: true }) });
  assert.ok(r.ok);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const t = await tiles(page);
  const d = t.find(x => x.href === "/drawing/");
  assert.ok(d, "Drawing has a tile: " + JSON.stringify(t));
  assert.match(d.sub, /make a picture with stickers/);
  const img = await page.$eval('a.app[href="/drawing/"] img', i => ({ src: i.getAttribute("src"), w: i.naturalWidth }));
  assert.equal(img.src, "/icons/drawing.png");
  assert.ok(img.w > 0, "the icon loaded");
  await ctx.close();
});
```

to `tests/shortcuts.test.mjs`:

```js
test("a Drawing shortcut opens /drawing/ and wears its own icon, not the generic one", () => {
  const { plan, script } = reconcileShortcuts({ apps: [{ id: "drawing", title: "Drawing", path: "/drawing/" }],
    dryRun: true, dir: DIR, port: 8377, returnScript: true });
  assert.deepEqual(plan.filter(p => p.action === "write" && p.path.endsWith("\\Drawing.lnk")).map(p => p.path).sort(),
    ["Desktop\\Drawing.lnk", "StartMenu\\Programs\\Drawing.lnk"]);
  assert.match(script, /'8377 "\/drawing\/"'/);
  assert.match(script, /drawing\.ico,0'/);
});
```

and to `tests/packs.test.mjs`:

```js
// Drawing (spec 2026-09-30 §1) is CORE: no pack owns its files, the installer's core section ships
// them with no /x, and the cut copies both the page and its hub module.
test("Drawing is core: no pack owns public/drawing, no /x, and the cut copies the page and drawings.js", () => {
  assert.equal(packOf("public/drawing/index.html"), null);
  assert.equal(packOf("public/drawing/stickers/horse.png"), null);
  assert.doesNotMatch(NSI, /\/x drawing\b/);
  const payload = fs.readFileSync(new URL("../tools/build-payload.sh", import.meta.url), "utf8");
  assert.match(payload, /cp -r "\$HUB\/public\/drawing" "\$OUT\/public\/drawing"/);
  assert.match(payload, /"\$HUB\/drawings\.js"/);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/apps.test.mjs tests/home-tiles.test.mjs tests/shortcuts.test.mjs tests/packs.test.mjs`
Expected: each file's new test FAILS — apps: `Drawing is in the registry`; home-tiles: `POST /apps` → 400 (unknown id); shortcuts: no `drawing.ico` in the script (the icon does not exist yet); packs: `cp -r "$HUB/public/drawing"` missing. Every other test passes.

- [ ] **Step 3: Register the app** — in `server.js` `APPS`, right after the `reader` line:

```js
  // Drawing (spec 2026-09-30 §1): a CORE app — its files ride with the engine (build-payload.sh
  // copies public/drawing; no installer /x, no pack), so it is never "installing" and never removable.
  { id: "drawing", title: "Drawing", sub: "make a picture with stickers", path: "/drawing/", pack: null },
```

- [ ] **Step 4: Ship it** — in `tools/build-payload.sh`, right after the `book-review` copy line:

```bash
# Drawing (spec 2026-09-30 §1) — CORE like book-review: its page, scene module, sticker table
# and the vendored Fluent Emoji (MIT, LICENSE beside them). No /x in installer.nsi.
cp -r "$HUB/public/drawing" "$OUT/public/drawing"
```

- [ ] **Step 5: Make the icon** — write `tools/drawing-icon.mjs`:

```js
#!/usr/bin/env node
// drawing-icon.mjs — Drawing's app icon: public/icons/drawing.png (256, the home tile) and
// public/icons/drawing.ico (256/48/32/16, the desktop shortcut). The other app icons are her i13's
// own .ico files (9/3) and Music/Movies were drawn to match; this one is drawn here, in the same
// flat style — a white card holding a tiny meadow, a sun, a tree and a splat — so it can be
// re-cut without a design tool. sharp (with librsvg) resolves from /home/claude/new-era/node_modules
// at tool time only; nothing ships but the two files.
//   node tools/drawing-icon.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(HUB, "public", "icons");
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect x="10" y="10" width="236" height="236" rx="30" fill="#FFFFFF" stroke="#D8E0DE" stroke-width="6"/>
  <clipPath id="c"><rect x="28" y="28" width="200" height="200" rx="18"/></clipPath>
  <g clip-path="url(#c)">
    <rect x="28" y="28" width="200" height="118" fill="#BFE3F2"/>
    <rect x="28" y="146" width="200" height="82" fill="#78BD6E"/>
    <circle cx="178" cy="78" r="26" fill="#F2B632"/>
    <rect x="72" y="118" width="14" height="62" rx="4" fill="#7A5230"/>
    <circle cx="79" cy="108" r="34" fill="#2E7D5B"/>
    <path d="M142 172 q12 -22 34 -10 q22 -10 28 12 q16 12 -2 26 q-6 18 -28 10 q-20 8 -28 -10 q-18 -10 -4 -28 z" fill="#DE7B52"/>
  </g>
</svg>`;
// An ICO whose every entry is a PNG (Windows Vista+ reads PNG entries at any size).
function ico(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let off = head.length;
  entries.forEach(({ size, buf }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  return Buffer.concat([head, ...entries.map((x) => x.buf)]);
}
const png = (size) => sharp(Buffer.from(SVG), { density: 72 * size / 256 * 4 }).resize(size, size).png().toBuffer();
const sizes = [256, 48, 32, 16];
const bufs = await Promise.all(sizes.map(png));
fs.writeFileSync(path.join(OUT, "drawing.png"), bufs[0]);
fs.writeFileSync(path.join(OUT, "drawing.ico"), ico(sizes.map((size, i) => ({ size, buf: bufs[i] }))));
console.log("wrote public/icons/drawing.png (" + bufs[0].length + " bytes) and public/icons/drawing.ico");
```

Run: `node tools/drawing-icon.mjs && file public/icons/drawing.png public/icons/drawing.ico`
Expected: `wrote public/icons/drawing.png (… bytes) and public/icons/drawing.ico`; `file` says `PNG image data, 256 x 256` and `MS Windows icon resource - 4 icons, 256x256 with PNG image data`. Read `public/icons/drawing.png` beside `public/icons/pencil.png`: a white rounded card like the Pencil's, holding a small meadow, a sun, a tree and an orange splat.

- [ ] **Step 6: Run the tests**

Run: `node --test tests/apps.test.mjs tests/home-tiles.test.mjs tests/shortcuts.test.mjs tests/packs.test.mjs`
Expected: all four `# fail 0`.
Then `icons.test.mjs` through a worktree hub (How to run things): `mkdir -p gate && sed "s/8377/$P/g" tests/icons.test.mjs > gate/icons.test.mjs && node --test gate/icons.test.mjs` → `# pass 2`, `# fail 0` (it now checks `drawing.ico` and `/icons/drawing.png` too).
Optional cut check: `bash tools/build-payload.sh /tmp/claude-1001/-home-claude-new-era-era-hub--wt-drawing/e934eb35-7c51-4242-885b-b8b6a91e3cec/scratchpad/payload` → last line `payload: …`; `ls …/payload/public/drawing/stickers` lists the seven PNGs and `LICENSE`; `…/payload/drawings.js` exists; era-scan inside it passes.

- [ ] **Step 7: Commit**

```bash
git add server.js tools/build-payload.sh tools/drawing-icon.mjs public/icons/drawing.png public/icons/drawing.ico tests/apps.test.mjs tests/home-tiles.test.mjs tests/shortcuts.test.mjs tests/packs.test.mjs
git commit -m "drawing: a core app — in the registry, a home tile and a desktop shortcut with its own icon (drawn to match, tools/drawing-icon.mjs), shipped in every payload; never offered a remove-files button (spec 2026-09-30 §1, §6)"
```

---

### Task 13: The contract audit — both screens in `STATES`, and a seeded full-shelf / full-ring audit

**Files:**
- Modify: `tests/invariants.mjs` — `STATES` (`:282-311`): two entries after `/board/`
- Test: `tests/drawing-ui.test.mjs` (append the seeded audit)

**Interfaces:**
- Consumes: the whole page (T7–T11); `auditPath(browser, state)` and `INVARIANTS_BASE` from `tests/invariants.mjs`.
- Produces: the gate audits `/drawing/` and the ring at 1920×1080 and 1280×720 on every run.

- [ ] **Step 1: Write the tests** — in `tests/invariants.mjs`, after `{ id: "/board/", path: "/board/" },`:

```js
  // Drawing (spec 2026-09-30 §8): the shelf, and the ring on a never-saved id — the ring opens
  // empty and nothing is written to the gate hub's data dir (a PUT only follows a change).
  { id: "/drawing/", path: "/drawing/" },
  { id: "/drawing/#ring", path: "/drawing/#p=2026-01-01-000000-fixture" },
```

and append to `tests/drawing-ui.test.mjs` (the gate hub's data dir has no pictures, so the full shelf and the eight-sticker ring are audited here, on this suite's own hub):

```js
// ================================================================ T13 — the contract audit, seeded
test("the contract audit is clean on a full shelf and a full ring, at both gate viewports", async () => {
  seedShelf(12);
  const full = "2026-09-30-150000-test-dev";
  seed(full, [H(), { s: "house", x: 0.35, y: 0.75, w: 0.26, by: "ellie" }, { s: "tree", x: 0.65, y: 0.74, w: 0.28, by: "ellie" },
    { s: "person", x: 0.2, y: 0.82, w: 0.22, by: "ellie" }, { s: "sun", x: 0.5, y: 0.17, w: 0.16, by: "ellie" },
    { s: "cloud", x: 0.33, y: 0.25, w: 0.14, by: "ellie" }, { s: "star", x: 0.67, y: 0.25, w: 0.1, by: "ellie" },
    { s: "splat", x: 0.45, y: 0.33, w: 0.15, by: "ellie", c: "#DE7B52", seed: 7 }], "2026-09-30T15:00:00Z");
  process.env.INVARIANTS_BASE = BASE;                    // read when invariants.mjs is first imported
  const { auditPath } = await import("./invariants.mjs");
  for (const state of [{ id: "/drawing/ (12 pictures)", path: "/drawing/" },
                       { id: "/drawing/#ring (every sticker)", path: "/drawing/#p=" + full }]) {
    const r = await auditPath(browser, state);
    for (const v of r.viewports) assert.ok(v.nTargets >= 11, `${state.id} @${v.vp.w}: only ${v.nTargets} targets`);
    assert.deepEqual(r.violations, [], state.id + ":\n" + r.violations.join("\n"));
  }
});
```

- [ ] **Step 2: Run them**

Run: `node --test tests/drawing-ui.test.mjs` → `# pass 28`, `# fail 0`.
Then the shared-hub audit on a worktree hub (How to run things): `INVARIANTS_BASE=http://127.0.0.1:$P node --test tests/invariants.test.mjs` → `# fail 0`; and for the detail `INVARIANTS_BASE=http://127.0.0.1:$P node tests/invariants.mjs /drawing/ '/drawing/#p=2026-01-01-000000-fixture'` → `violations=0` on all four lines (the empty shelf has 2 targets: New picture + 🚪; the ring 11; at 1280×720 `FONT_SUB btnUndo 49` / `btnDone 49` are the tolerated warns). Afterwards `ls $D/drawings` must say "No such file or directory": the audit wrote nothing.
If a violation appears, fix the CSS (never the tile order, never a contract number) and STOP to report if it cannot be fixed that way.

- [ ] **Step 3: Commit**

```bash
git add tests/invariants.mjs tests/drawing-ui.test.mjs
git commit -m "drawing: the contract audit covers both screens — the gate audits the shelf and a never-saved ring; the suite audits a full shelf (More) and an eight-sticker ring at both gate viewports (spec 2026-09-30 §8)"
```

---

### Task 14: The dev note, and the spec's test list checked off

**Files:**
- Create: `docs/drawing.md`

**Interfaces:** none (docs only; the land rail accepts a docs-only commit on a gated tree).

- [ ] **Step 1: Write `docs/drawing.md`:**

````markdown
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
````

- [ ] **Step 2: Check the spec's test list against the suites** — every line of spec §8 must name a test that exists (grep the quoted names):

| Spec §8 line | Test |
|---|---|
| ring renders 8 sticker tiles + Undo + Done + rest | drawing-ui "the ring: eight sticker tiles…" |
| a click on Horse adds one item in the ground zone at the first centre-out slot; tile order fixed | drawing-ui "a dwell on Horse says…"; "the ring: eight sticker tiles…"; drawings "the eight stickers sit in their fixed seats" |
| Undo removes it | drawing-ui "Undo takes the last sticker away…" |
| a touch drag moves a sticker and a mouse drag does not | drawing-ui "a grown-up's finger drags a sticker…" |
| reload restores the scene | drawing-ui "her picture is saved as she goes…" |
| Done POSTs a PNG and lands on the shelf with the picture first | drawing-ui "Done: a 1600x900 PNG goes to the hub…" |
| the scene has no `.dwell`; the rest tile is black and not `.dwell` | drawing-ui "her picture and the rest tile are inert…" |
| a blank picture is not listed | drawing-ui "the shelf: …blank pictures never listed", "Clear picture: …", "Done on a blank picture…" |
| id shape; validation rejects unknown stickers / out-of-range coords | drawings "an id is the date…", "validation: …" |
| mount vs no-mount write paths; `.local` marker | drawings "with a Drive folder…", "with no Drive folder…" |
| `mirrorDrawing` ledger merge | drive-mirror "mirrorDrawing: one picture onto this shelf now…"; drawings "with a Drive folder… the ledger owns it" |
| done writes the PNG and answers `mail: "no-email"`; `unchanged` on a second Done | drawings "Done saves the PNG…", "with a family email: …unchanged on a second Done…" |
| empty-picture cleanup | drawings "cleanup: …" |
| drive-mirror: drawings mirrors, prunes only ledger-owned, scene.json byte-compared | drive-mirror "drawings mirror in, a same-length…", "drawings adopt…", ".local…" (×2), "adoption never claims a .local picture…" |
| invariants STATES shelf + ring, both viewports | invariants.mjs STATES + drawing-ui "the contract audit is clean…" |
| apps, home-tiles, icons, packs, shortcuts pick up the app | T12's four appended tests + icons.test unchanged |
| no family content in fixtures | era-scan pre-commit on every commit |

Run: `grep -c "^test(" tests/drawings.test.mjs tests/drawing-ui.test.mjs tests/drawing-scene.test.mjs` → `21`, `28`, `9`.

- [ ] **Step 3: Commit**

```bash
git add docs/drawing.md
git commit -m "docs: drawing.md — where a picture lives, how the stickers and icon are re-cut, the suites and ports, the later rungs (spec 2026-09-30)"
```

---

### Task 15: Gate green (the plan stops here; landing is the overseer's act)

**Files:** none (a red suite goes back to the task that owns it).

- [ ] **Step 1: Everything committed** — `git status --porcelain --untracked-files=no` prints nothing (a dirty tracked tree writes `dirty=1` into the stamp and `land` refuses it). `rm -rf gate` is not needed: the gate rebuilds it.

- [ ] **Step 2: Run the gate detached** (it outruns the 10-minute tool ceiling; it takes a machine-wide lock and may queue behind another worktree's run):

```bash
cd /home/claude/new-era/era-hub--wt-drawing
LOG=/tmp/claude-1001/-home-claude-new-era-era-hub--wt-drawing/e934eb35-7c51-4242-885b-b8b6a91e3cec/scratchpad/gate.log
setsid nohup bash tools/era-gate.sh > "$LOG" 2>&1 < /dev/null &
echo "setsid pid $! (not the node pid — never pkill -f to stop it; kill its session if you must)"
```

Wait with the Monitor tool on an until-loop: `until grep -q '^== era-gate:' "$LOG"; do sleep 30; done` (no foreground `sleep`).

- [ ] **Step 3: Read the verdict**

Expected last line: `== era-gate: N passed, 0 failed ==` (N = the previous master count 113 plus the three new suites = 116). Then:

```bash
T=$(git rev-parse 'HEAD^{tree}'); cat /tmp/era-gate-green/$T
```

Expected: line 1 the same `0 failed` summary, `head=` this HEAD, `at=` within the last few minutes, and NO `dirty=1` line. A `FAIL <suite>` line: read `gate/<suite>.out`, fix in the owning task's files, commit, re-run from Step 2. Never weaken an assertion to get green — STOP and report instead.

- [ ] **Step 4: Hand over** — report the stamp line and HEAD to the overseer. `bash /home/claude/aac-board-builder/tools/worktree.sh land /home/claude/new-era/era-hub drawing` and the status line in `aac-board-builder/docs/status.md` are the OVERSEER's acts, not the builder's; so are any release and the device rollout (spec §10).

---
## Risks and unknowns

1. **Drive conflict copies.** Two devices editing one picture at once (or one editing while the other's mount is offline and then copying up) is last-write-wins; Google Drive for Windows may also leave `scene (1).json` files or `<id> (1)` folders. `list()` reads only `scene.json` in id-shaped folders, so her shelf never shows the debris, but it accumulates in the family's Drive. Accepted for v1 (spec §4).
2. **No-mount devices.** With Drive off (the tablet today), every picture is `.local` on that one device: never shared, never backed up; a wipe loses them (the family's email is then the only copy, and only when mail is set up). They go up automatically the first time a folder is adopted or picked.
3. **Mail size and sender.** A 10-sticker 1600×900 PNG measured 350 KB on 9/30 (≈ 470 KB base64); worst case a few MB, far under Resend's 40 MB, inside the 30 s budget on a home link. The sender is the Pencil's (`The Pencil <onboarding@resend.dev>`, as the spec says), so the family sees "The Pencil" on a picture email; Resend's free sender still only delivers to the account's own address (`mailErrorFor` explains it in Settings).
4. **Park override without ERAgaze.** The POST to `127.0.0.1:49155/app/park` fails silently where no engine listens. On a device whose gaze engine parks the cursor at the literal bottom-right corner and ignores `/app/park`, Done sits under the parked cursor (the invariants' `PARK_TARGET` law is waived only because the page declares the override). Done is not destructive (it saves, celebrates and returns to the shelf), but check on the i13 and the tablet that the ERAgaze log shows the park moving to the rest tile before dad tries it. The Pencil carries the same exposure.
5. **Thumbnail cost with many pictures.** Only one page (9) of thumbnails is ever in the DOM; each is ≤ 200 absolutely-positioned elements sharing seven cached PNGs. `index.json` inlines every non-empty scene (typically 1–3 KB each) and is re-fetched every 60 s on the shelf: ≈ 100 KB at 50 pictures, fine locally; at several hundred pictures a paged index would be the fix.
6. **Fresh installs start with Drawing off.** The installer writes `apps.json` from its component sections and Drawing has none (a core app needs no `/x`, and the spec adds no section), so the wizard shows it unticked and existing devices need dad's tick (spec §10). A `Section "Drawing" SecDrawing` + one `writeApps` line (the `SecMW` shape) is the follow-up for the next signed cut — the overseer's call.
7. **Kiosk browser support.** The 16:9 boxes use container-query units (`cqw/cqh`, Chromium ≥ 105). The kiosk Edge/Chrome on the family devices is current, but an old kiosk browser would collapse the picture box — check the i13 and the tablet once.
8. **Sticker sharpness on the companion display.** The PNGs are 256 px; at 1920×1080 a tree renders ≈ 214 px (crisp); on the 2736×1824 companion display they upscale a little. Fluent's flat SVGs would be crisper but the spec chose 3D PNG.
9. **Clock skew.** `updated` (shelf order) is stamped by whichever hub saved it; two devices with skewed clocks can order the shelf slightly differently.
10. **Out-of-order saves.** Every PUT carries the whole scene; a slow earlier PUT (say the debounced one) landing after a later one (the keepalive flush on 🚪) would leave the hub one sticker behind while the page says saved. On the loopback hub requests are handled in arrival order, so this is accepted for v1; a per-picture revision number checked by the hub is the fix if it is ever seen.
11. **Gate hub side effects.** None by design: the ring state uses a never-saved id (no PUT without a change) and the shelf state only reads. T13 Step 2 checks the scratch data dir stays empty.

## Not verified (and what WAS)

- **Validated before writing this plan** (9/30, in a scratch copy of this worktree with every task's code applied exactly as written here): `drawings.test.mjs` 21/21, `drawing-scene.test.mjs` 9/9, `drawing-ui.test.mjs` 28/28 and each intermediate stage (T7 5, T8 13, T9 18, T10 23, T11 27 + T13 audit), `drive-mirror.test.mjs` 30/30 (and the last test fails with the `listTree` skip reverted), `mail.test.mjs` 8/8, `apps` 7/7, `home-tiles` 4/4, `shortcuts` 8/8, the new `packs` test, `icons.test.mjs` through the How-to-run recipe (2/2), and `tests/invariants.mjs` on both new STATES (0 violations). The fetch tool downloaded all eight pinned files; the icon tool's output was looked at; screenshots of the ring, the shelf and the exported PNG were looked at.
- **Plan review:** one Sonnet reviewer pass (writing-plans method), Approved with no blocking issues; its advisory points were folded in (a test that proves adoption never claims a `.local` picture, drive.js's header no longer says "nothing is ever uploaded", Done's latch in a `try/finally`, the Settings/`createContentFolder` note in `docs/drawing.md`, the out-of-order-save risk) and re-validated (drive-mirror 30/30, drawing-ui 28/28).
- **Not run:** the full gate (T15), a real `build-payload.sh` cut, era-scan over the new files (the pre-commit will), anything on a real device (ERAgaze park, kiosk browser, touch drag on real glass, TTS voices, Windows shortcut + icon), a real Resend delivery with an attachment, Google Drive for Windows' behaviour under frequent small `scene.json` rewrites.

## Spec coverage (self-review)

| Spec | Task(s) |
|---|---|
| §1 new core app, APPS entry, the Pencil shim, two screens | T7, T12 |
| §2 ring layout, seats, text tiles, holds, inert scene, park, sizes | T1, T7, T13 |
| §2.1 pick and it lands: speech, flight, zones/slots/scales/laps, procedural splat | T1, T6, T8 |
| §2.2 Undo (60, silent on empty) | T8 |
| §2.3 Done: PNG, POST, celebration, back to the shelf | T5, T11 |
| §2.4 partner: finger drag, tab + freezing sheet, tune, two-stage Clear, mail line | T9 |
| §3 shelf: rail + New picture, 3×4 centre-black, More, thumbnails from scene.json, date plate, blank not listed, cleanup | T3, T10 |
| §4 data: folder layout, scene shape, ids, mount/no-mount, `.local`, mirror sets, `mirrorDrawing`, byte compare, autosave, never lost | T2, T3, T8 |
| §5 routes + `resendSend` attachments | T4, T5 |
| §6 assets + licence + icon | T1, T12 |
| §7 laws | tests in T7–T11, T13 |
| §8 tests | T14's table |
| §10 out of scope | not built; listed in `docs/drawing.md` |
