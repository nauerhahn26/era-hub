# The weekly suite, phase 2 — the Watch rework + Play (all three engines) — Implementation Plan

> **For agentic workers:** REQUIRED WORKFLOW: subagent-driven development (one fresh-context builder per task, the overseer reviews between tasks). Steps use `- [ ]` checkboxes. TDD on every task: the test is written and SEEN red before the code.

**Goal:** Dad 10/13 (after the first week on the tablet): a video must not open "another Chrome window"; it should be "like the music player — you take yourself to another screen and there you see the video", with pause and back, for a three-minute clip, not an hour-long movie. He also heard the sound twice. Dad 10/21: "do watch rework, do all plays so I can assess." So: (1) the Watch tile takes the same kiosk window to the hub's own watch page, which wears the door bar, a Back tile and a Pause/Play tile — no ERAgaze launch, nothing can fire twice; (2) the Play door opens `/play/` with Which one?, Sort it and Play it filled from the week's package, never-wrong, nothing scored, every pick logged silently.

**Architecture:** Two public repos, one slug, one private line. *Hub* (`era-hub--wt-youtube-videos`): `this-week.js` validates `play` and serves it at `/this-week/<w>/play.json`, adds the `link` Play door to the root recipe; `public/watch/` is rewritten as a hub app page (door bar, rail, video); `public/play/` is a new hub app page in Drawing's mould (plain DOM on the shared kit: `dwell.js`, `speech.js`, `lib/doorbar`, `lib/celebrate`, `lib/contract`, `lib/shell`) with three engine modules and a Web Audio sound module; `build-payload.sh` ships it. *Board* (`era-board--wt-youtube-videos`): a `link` tile type, and `video` tiles navigate instead of launching. *Engine* (`ellie-this-week--wt-youtube-videos`): one prompt line naming each instrument's positions so the model's `answer` index means what the app means.

**Tech stack:** Node 22 hub (no deps), plain browser JS (ES modules in the page, CommonJS in the server), node:test + Playwright from `~/new-era/node_modules`; Python 3.12 + pytest under `uv` in the engine. No new dependencies anywhere. No media files: sounds are synthesised.

**Spec:** `docs/specs/2026-10-12-weekly-suite-design.md` — §3.3 (amended 2026-10-21), §5.1–§5.4, **§5.6** (the app's pages, the instruments' positions, the synthesised sounds, the `link` door), §9 phase-2 row, §11 row 2. Phase 1 (plan `2026-10-12-weekly-suite-phase1-plan.md`) is on the devices as v0.39.0 → v1.0.7; its Definitions still hold for everything this plan does not change.

**Worktrees:** `~/new-era/era-hub--wt-youtube-videos` (this file; branch `feat/youtube-videos` at master `8b055f2`+), `~/new-era/era-board--wt-youtube-videos` (opened by the overseer with `~/aac-board-builder/tools/worktree.sh open ~/new-era/era-board youtube-videos`), `~/ellie-this-week--wt-youtube-videos` (same tool, for D1 and the workpad). Never edit any main checkout. Gate and scratch hubs need `ERA_WT_SUFFIX=--wt-youtube-videos`.

**Discipline:** TDD every task. A fresh builder per task; one builder per worktree at a time (two builders in one worktree collided on the index in phase 1). No "while I'm here". STOP and report instead of improvising when: a test outside this plan starts failing; an assertion would have to be weakened; a change would touch `public/dwell.js`, `public/speech.js`, `public/lib/*` (era-core's files, mirrored), TD Snap, ERAgaze, or the hub's `/movie-event`; a media file or a new dependency looks necessary; a port outside this plan's table looks necessary.

**Commits:** house style `this-week: <what> — <why> (spec 2026-10-12 §N)` in the hub and board, `activities: <what> — <why>` in the engine. Author is the user; no vendor or model names anywhere in code, docs or messages (say "the agent"); no attribution trailers. `git add` exact paths, never `-A`. The pre-commit era-scan runs in the public repos: no family names but Ellie, no infra terms, no IPs but loopback, no school, teacher, town or classmate names. Fixtures use the fake week `2026-01-05`, topic "shadows", ids like `aBcDeFgHiJk`.

---

## Spec deviations (each is the nearest faithful thing; reason given)

1. **The page reads `play.json`, not the manifest.** The browser cannot share `this-week.js`'s validator, and a page must never trust an unvalidated file: the server validates `play` and the `before` items once and serves `GET /this-week/<w>/play.json`. The media jail still serves `manifest.json` (unchanged, for hand checks).
2. **Yes/no seats.** Spec §5.1 says yes/no items use "the top corners (D5)"; the Play pages are app pages, not 3×4 boards, and the top corners of an app page are the door bar's two doors. The faithful reading of D5 (a fixed seat per answer) is: **yes is always the left answer seat, no always the right**, whatever order the manifest lists them (spec §5.6 says so now).
3. **Sounds are synthesised** (spec §5.6): the build box downloads no media, a CC0 library needs a licence file and a fetch, and the instruments need pitched notes anyway. A manifest `sound` name the library lacks is ignored, never an error.
4. **The watch page's Back goes to the Watch grid**, `/board/?recipe=this-week&board=watch` (the board's `?board=` deep link, `board.js:536-539`), not the root — she came from there.
5. **No `.watching` marker.** The board page is gone while the video plays; the marker had nothing to mark. The media lock still refuses `video` tiles.
6. **`link` navigates same-origin paths only.** `href` must start with `/` and contain no `//`, `\`, or whitespace; anything else is painted but inert (the recipe is trusted, the rule is cheap).
7. **Play it's free-play clock is 60 s of page time** from the instrument's first sound, not from entry — a page nobody touches never asks.
8. **The release is a patch** (`v1.0.8`, unsigned, same installer): Play is a page of the This week app (no new APPS entry, no home tile, no installer Section — `installer.nsi:123` already calls the watch page core). New `public/` dirs ride the tarball. A signed cut is not needed and would cost dad an app code.
9. **One port for the new suite: 8466.** Swept 10/21 across every repo's `tests/`, `tools/`, era-family and the engine: only a comment in `era-making-words/tests/layout.test.mjs:35` names it as a hand-run base; nothing spawns on it; `ss -ltn` clean. Scratch hub for F2: **8482** (free of every reference).
10. **The engine's one change is a prompt line + its test**, not a schema change: `answer` stays an int; the positions table in spec §5.6 is what the line says.

## Preflight (verified 10/21 against hub master `e58b3ab` / worktree `8b055f2`, board `ecb106e`, engine `c845e09`; line numbers are anchors — grep the quoted identifier if they drifted)

| Fact | Where |
|---|---|
| `mountDoorBar(mount, { appPath, onLeave, onPause, onResume, exitTo })`; 🚪 → `/kiosk/exit`, falls back to `exitTo`; 💬 → `/kiosk/pause`; `setPause(bool)`, `setDwell(ms)`, `sizeBar()`; doors hold 2× | `public/lib/doorbar.js:41-100` |
| Drawing's page kit: `window.DwellConfig` block in `index.html`, `mountDoorBar(document.body, {onLeave,onPause,onResume})`, `/settings` → `Dwell.setMs(st.dwellMs)`, `Dwell.set({settleMs})`, `BAR.setPause(st.pauseGoes==="tdsnap")`, `ERA_CHILD_NAME` | `public/drawing/index.html:12-17`, `drawing.js:1011-1024` |
| `window.Speech = { init, say, stop, preload, cycleVoice, mode }` (`say(text, kind)` returns a promise) | `public/speech.js:122, 181` |
| `celebrate.js` exports `confetti(count, opts)`, `makeShuffleBag(items)`, `PRAISE_FAST`, `PRAISE_PLAIN`, `ENCOURAGE` | `public/lib/celebrate.js:44-85` |
| `shell.js` exports `makeLog(app, opts)`, `wireTtsWarn(speech, opts)`, `dwellConfigDefaults(overrides)`, `makeParkPad()` | `public/lib/shell.js:17-73` |
| `contract.js` exports `holdForExit`, `CONTRACT`, `holdFor(role, dwell)`, `assertContract`; `contract.json` `gapFloor 14`, `barH 124` | `public/lib/contract.js:15-167`, `contract.json:6-11` |
| dwell targets are `.dwell` elements (`[data-dwell-disabled]` skips); activation = `dwell:activate` CustomEvent (bubbles, cancelable) + click; `window.Dwell.setMs/set/state` | `public/dwell.js:154, 228, 367` |
| `/settings` defaults `musicVolCap: 100`, `dwellMs: 1200`, `settleMs: 250`, `exitTo`; `POST` clamps `musicVolCap` 1–100 | `server.js:1653, 1739-1740` |
| board reads `musicVolCap` from `/settings` and hands it to the music player as `volCap` | `era-board/app/board.js:461-466, 511` |
| `?board=<id>` deep link: `api.show(b)` when `^[a-z0-9-]{1,64}$` | `era-board/app/board.js:536-539` |
| `launchVideo` (to retire) posts `/app/launch` with `{url, watch:true}`; `videoKey`, `.watching`, `setLaunchWarn`, `.launch-failed` | `era-board/app/board-render.js:645-680` |
| `LAUNCH_TYPES = new Set(["movie","episode"])` (never add `video`/`link`); `isPhoto` true for `type === "video"` | `board-render.js:114, 153-164` |
| `MEDIA_TYPES` in `board-lock.js` holds `video` (phase 1 C1) | `era-board/app/board-lock.js` |
| board suite stubs `**/log`, `**/voices`, `**/tts*`, `**/this-week/<w>/*`, `**/recipes/this-week.json`, `http://127.0.0.1:49155/app/launch`; BASE `http://localhost:8377/board/?recipe=this-week` (the gate hub) | `era-board/tests/board-this-week.test.mjs:23-24, 76-89` |
| `this-week.js`: `validate(m)` drops items, never the page; `recipe(week, ready)` root = Watch [1,1] + Talk [1,4]; `WATCH_SEATS`, `TALK_SEATS`, `ROOT`, `THIS_WEEK_REV = 1`; `build(dataDir)`; `readWeek`, `videoState`, `etagFor` | `this-week.js:20-30, 74-108, 142-215` |
| `isGlyph` (one grapheme, Extended_Pictographic) already in the hub | `this-week.js:37-42` |
| media jail under `/this-week/` serves `.mp4 .webp .jpg .jpeg .png .json` (`.json` no-cache) | `server.js` (`serveMediaJail`, phase 1 B2) |
| `/log` → `LOGS/<day>.jsonl` + `pool.append("app-log")`, 204 | `server.js:2067-2077` |
| watch page today: one `<video autoplay>`, posts `/log` then `127.0.0.1:49155/app/watch-end` on end/error — to be replaced whole | `public/watch/watch.js` |
| `watch-ui.test.mjs`: port **8427**, spawns `node server.js <port>` with `ERA_DATA_DIR` holding one fixture week + `tests/fixtures/this-week-1s.mp4`; routes `**/app/watch-end` in the page context | `tests/watch-ui.test.mjs:5-11, 22-44` |
| `drawing-ui.test.mjs` (port 8478): the UI-suite mould — `page.goto`, `window.Dwell.setMs`, `Dwell.state().suppressedMs`, `__speechLog`, floors at 1280×720 | `tests/drawing-ui.test.mjs:61, 165, 804, 992-993` |
| `packs.test.mjs` pins This week's Section + `build-payload.sh` lines for `public/watch`, `this-week.js`, `this-week-fetch.js` | `tests/packs.test.mjs:230-245` |
| `build-payload.sh` copies explicit `public/` dirs (`drawing` `:127`, `watch` `:131`) | `tools/build-payload.sh:117-133` |
| `era-gate.sh` collects `tests/*` from each sibling worktree under `ERA_WT_SUFFIX` — a new test file runs without registration | `tools/era-gate.sh:19, 141, 198` |
| `release.sh vX.Y.Z --patch`: gate → `build-dist.sh --patch` (new tarball, same signed installer) → VM → publish; never signed | `tools/release.sh:2-32` |
| newest tag `v1.0.7`; hub master `e58b3ab` | `git tag` |
| engine schema: `Choice{label, glyph, sound?, right?}`, `WhichItem{id, skill, q, choices 2–3, one right}`, `Video.before: WhichItem|None`, `SortSet{bins 2, skill, items 4–10 {label, glyph, bin}}`, `PlayIt{instrument, q, answer:int}`, `Play{which ≤10, sort?, playit?}` | `ellie-this-week/src/ellie/activities/schema.py:107-190` |
| engine prompt's Play-it line: `"- Play it: one of harmonica, xylophone, string-telephone, shadow-puppet."` | `src/ellie/activities/prompt.py:252` |
| every week so far answers index 0: harmonica "lowest note", xylophone "lowest sound", string-telephone "tight or loose", shadow-puppet "closer or farther"; no week uses `sound` names; 2026-10-19 has 9 which (true-false/decode/rhyme/add/subtract/classify/sequence/cause/compare), a 6-item sort, 3 `before`s | `eval/golden/*/activities.json`, `weeks/2026-10-19/activities.json` |
| the gaze log of dad's test: four `/app/launch watch` lines 17:26:29–:33 for one id, "kiosks closed: 11" at exit, every strip tap → two `play/pause` lines | tablet `C:\Users\Public\ERAgaze\eragaze.log` 2026-10-13 |
| `worktree.sh open|land|close <repo-path> <slug>` | `~/aac-board-builder/tools/worktree.sh:5-11` |

## Global constraints

- Laws: D4 text first, D5 fixed yes/no seats (deviation 2), D18 never a test, D26 fixed seats, ux-contract §14 two-strike errorless, §15–16 nothing scored on screen, ≥32 pt text, dwell from `/settings` (1200 default), doors 2×, every dwell target ≥ 90 px at 1920 (≥ 60 px at 1280×720), gaps ≥ 14.
- The hub never contacts the network at play time; the pages read only this hub. No ERAgaze call from the watch page or Play (the engine only ever learns the gaze park, as Drawing does, if a page needs one).
- No new dependencies. No media files. No edits to era-core's mirrored files.
- Test hubs: only **8466** (play-ui) and the phase-1 ports 8427 / 8456 / 8457. Scratch hub: 8482.

## Review focus (what the overseer checks between tasks)

Never-a-test (no score, no "wrong", no red, no buzzer); the two-strike path on every engine and on `before`; fixed seats and yes-left/no-right; both doors hold 2× and nothing else does; every pick logged with `right` and `strike`; the watch page never calls the engine; `link`/`video` navigation is same-origin only; the sound module stays silent on an unknown name and respects the cap; nothing private in the public repos.

## Definitions (every task uses these names and numbers)

### Files

Hub: `this-week.js` (+ `validatePlay`, `playJson`), `server.js` (one route), `public/watch/index.html` + `watch.js` + `watch.css` (rewritten), `public/play/index.html`, `play.css`, `play.js` (shell + menu + router), `which.js` (Which one? — exported for the watch page), `sort.js`, `playit.js`, `sounds.js`, `docs/this-week.md`, `tools/build-payload.sh`, tests `tests/this-week-recipe.test.mjs` (extended), `tests/watch-ui.test.mjs` (rewritten, **8427**), `tests/play-ui.test.mjs` (new, **8466**), `tests/packs.test.mjs` (one assertion: `public/play` ships).

Board: `app/board-render.js`, `app/board.css` (if a `link` tile needs paint), tests `tests/board-this-week.test.mjs` (extended).

Engine: `src/ellie/activities/prompt.py` (one line), `tests/activities/test_prompt_positions.py` (new).

### `GET /this-week/<week_of>/play.json` (no-store; 404 when no such week)

```json
{"week_of": "2026-01-05", "title": "Shadows!",
 "play": {"which": [ …validated WhichItems… ], "sort": {…}|null, "playit": {…}|null},
 "before": {"aBcDeFgHiJk": {…WhichItem…}},
 "dropped": [ {"field":"play.which","index":3,"why":"two right answers"} ]}
```

`validatePlay(m)` rules (JS twins of `schema.py`): `which` ≤ 10 items, each `id` a non-empty string unique in the set, `skill` ∈ the twelve, `q` non-empty ≤ 160 chars, `choices` 2–3 with non-empty `label` ≤ 40 and a `glyph` passing `isGlyph`, exactly one `right: true`, `sound` a string or absent; `sort` = exactly 2 bins `{label, glyph}` and 4–10 items `{label, glyph, bin ∈ {0,1}}` else `null`; `playit` = `instrument` ∈ harmonica/xylophone/string-telephone/shadow-puppet, `q` non-empty, `answer` an integer 0 ≤ n < positions(instrument) (10, 10, 2, 2) else `null`; `before` per video = a valid WhichItem or dropped. A failing item is dropped into `dropped`, never the page. `play` absent → `{which: [], sort: null, playit: null}`.

### The recipe (changes only)

`THIS_WEEK_REV = 2`. Root gains **Play** `{type:"link", href:"/play/?w=<week_of>", label:"Play", say:"play", glyph:"🎲", row:3, col:4}` when `validatePlay` leaves at least one of `which.length ≥ 1`, `sort`, `playit`; otherwise the seat stays black. `video` tiles unchanged in shape (`{type:"video", id, week_of, label, image, row, col}`).

### The watch page (`/watch/?w=<week_of>&v=<id>`)

Shell: `<link>` `lib/tokens.css`, `lib/doorbar.css`, `watch.css`; `window.DwellConfig` as Drawing's; `mountDoorBar(document.body, { appPath: "/watch/", onLeave: stop video, onPause: video.pause(), onResume: video.play() })`; `/settings` → `Dwell.setMs`, `settleMs`, `setPause`, `volCap = musicVolCap/100` → `video.volume`. Params validated as today; bad params → `location.replace("/board/?recipe=this-week&board=watch")` after 1 s.

Layout under the bar: a **rail** on the left (width = one board cell at the contract's floors) with **Back** (top, `.dwell`, label "Back", glyph ←) and **Pause / Play** (below, `.dwell`, label "Pause" ⏸ while playing, "Play" ▶ while paused); the **video** fills the remaining width and height, `object-fit: contain`, black behind. No other dwell target on the page. Back → `location.assign("/board/?recipe=this-week&board=watch")`. `ended` → log `ended` then Back's navigation; `error` → log `error`, 1 s, the same navigation. `playsinline`, `autoplay` after the `before` step (or at once when there is none).

`before`: fetch `play.json`; if `before[v]` exists, `which.js`'s `mountWhich(host, item, opts)` runs first over the video area (the video element exists, paused, hidden): the question spoken, the pick, two-strike, the cheer, then `host` is cleared and the video plays. Log `{event:"before", item, pick, right, strike}` through the same `/log` shape as Play (door `"watch"`).

Logs: `/log` `{app:"this-week", door:"watch", week_of, id, event ∈ open|ended|error|paused|resumed|before, ms:<played ms>}`, `keepalive: true` on the ones that precede a navigation.

### The Play app (`/play/?w=<week_of>`)

Shell as the watch page's (door bar `appPath: "/play/"`, `/settings`, `DwellConfig`, cap). `play.js` loads `play.json` (a 404 or a bad `w` → the menu with no engine tiles and one line "Nothing to play yet", spoken once, plus Back). State lives in memory; the URL hash names the page (`#menu`, `#which`, `#sort`, `#playit`) so a reload lands on the same page at its first item.

**Menu:** door bar; Back (to `/board/?recipe=this-week`) at the left-rail top seat; three engine tiles in fixed seats across the middle — Which one? (❓) left, Sort it (🗂️) centre, Play it (🎵 for harmonica/xylophone, ☎️ string-telephone, 🔦 shadow-puppet) right — an engine without content has no tile (its seat empty, black). Tiles ≥ 90 px at 1920; gaps ≥ 14.

**Which one?** (`which.js`, `export function mountWhich(host, item, { say, log, sound, onDone })`): the question in a strip at the top (≥32 pt), `say(q)` on mount and again after 20 s with no pick (once); choices as big tiles in a row of fixed seats — 2 → left + right, 3 → left + middle + right; a yes/no item (both labels in {yes, no}, case-insensitive) is re-seated yes left, no right; each tile = glyph (large) + label (text). A pick: `right` → the tile "comes alive" (CSS `alive` class: scale + glow 600 ms) + `sound(choice.sound ?? "pop")` + `confetti(24)` + `say(PRAISE)`; `log({item: item.id, pick: idx, right: true, strike})`; `onDone()` after 1200 ms. First miss → the tile does its small thing (`wiggle` 400 ms, `sound(choice.sound ?? "pop")`), `say(q + " " + hint)` where hint = "Look for " + the right label, both tiles stay lit, `strike = 1` logged; second miss → the right tile comes alive by itself with the cheer, `strike = 2` logged, `onDone()`. Nothing says "no"; no red; no score. `play.js` runs the week's `which` items in manifest order, one `mountWhich` at a time; after the last, `confetti(60)` + `say("You did them all!")` and the menu.

**Sort it** (`sort.js`): the current item centred (glyph + label, inert), bins left and right (`.dwell`, glyph + label, ≥ 120 px tall), Back at the rail. `say("Is " + label + " " + bins[0].label + " or " + bins[1].label + "?")` on each item and after 20 s idle. Right bin → the item slides into it (CSS transition 500 ms; reduced motion → appears), `sound("pop")`, the bin's count grows by one small glyph in its tray, next item. First miss → the item wobbles back to the centre, the question again; second miss → it slides into the right bin by itself + the cheer. Last item → `confetti(60)` + `say("All sorted!")` and the menu. Log `{engine:"sort", item: idx, pick: bin, right, strike}`.

**Play it** (`playit.js`): one module, four instrument renderers sharing the two-strike runner. Positions per spec §5.6: harmonica 10 holes (MIDI 60 62 64 65 67 69 71 72 74 76), xylophone 10 bars (same notes, bar height falls left → right), string-telephone `[tight, loose]`, shadow-puppet `[closer, farther]`. Every position is a `.dwell` tile ≥ 90 px at 1920 (ten across at 1920 is ~150 px each with 14 px gaps — fine; at 1280×720 ten holes are ~90 px — still above 60). A pick plays the position (`sounds.note(midi, voice)` for the pitched two; the telephone plays a short "hello" voice through a clear or muffled filter after a wave runs the string, 900 ms; the puppet moves and the shadow scales 1.0 → 1.6 or 0.7). Shapes for the puppet are four small tiles (bat 🦇, bird 🐦, rabbit 🐰, dog 🐕) under the scene, `.dwell`, 1×. After **60 s from the first pick**, the question strip appears and `say(q)`; the next pick answers: `answer` → alive + cheer; first miss → the position does its thing, `say(q + " Listen for the " + ["lowest","highest"][…] ...)` — the hint is the spec's own: for pitched instruments "Listen for the low one" / "high one" (from the question's words `low|high`), for the telephone "Try the tight string" / "loose string", for the puppet "Move it closer" / "farther"; second miss → the right position lights and sounds by itself + cheer. The question never returns; free play goes on. Log `{engine:"playit", instrument, pick: idx, right?, strike?}` (free-play picks have no `right`).

**Sounds** (`sounds.js`, `export function createSounds({ volCap })` → `{ play(name), note(midi, voice="harmonica"|"xylophone"), muffled(on), unlock() }`): one `AudioContext` created lazily on the first dwell/click (autoplay policy); a master `GainNode` at `volCap`; voices by name: `drum-low` (sine 80 Hz, 300 ms decay), `drum-high` (sine 180 Hz, 200 ms), `bell-low` / `bell-high` (sine + 3rd harmonic, 1.2 s), `string-pluck` (Karplus-Strong noise burst into a short delay loop), `whoosh-up` / `whoosh-down` (filtered noise sweep), `pop` (short sine chirp), `cheer` (three rising notes); `note(midi, voice)`: harmonica = sawtooth + 5 Hz vibrato + bandpass, 700 ms; xylophone = sine + decaying 4th harmonic, 500 ms. Unknown name → nothing. Test hook `window.__soundLog` (array of names/midi) when `window.__ERA_TEST` is set or in Playwright (same pattern as `__speechLog`).

**Common:** `say` = `Speech.stop()` then `Speech.say(text)`; `log` = `makeLog("this-week")`-style POST to `/log` with `door:"play"`, `week_of`; `confetti` from `celebrate.js`; the page's only 2× holds are the two doors (`holdForExit`); every content tile is 1× (`holdFor`). Reduced motion (`prefers-reduced-motion`) disables transitions. Keyboard/mouse clicks work for grown-ups.

### The board (`board-render.js`)

- `link` tile: painted like a door (glyph + label), `onTile` → if `safeHref(btn.href)` (starts with `/`, no `//`, `\`, whitespace, `<`, `>`) → `location.assign(btn.href)`; else nothing. Not in `LAUNCH_TYPES`; not a media type (no lock).
- `video` tile: `onTile` → lock check (unchanged) → `location.assign("/watch/?w=" + week_of + "&v=" + id)` after the same `safeHref`-style validation of `week_of` (`^\d{4}-\d{2}-\d{2}$`) and `id` (`^[A-Za-z0-9_-]{11}$`). `launchVideo`, `videoKey`, the `.watching` marker and its `/log launch` line are removed; `setLaunchWarn`/`.launch-failed` stay for movies.
- The dwell on a tile that navigates must not re-fire: `onTile` marks the element `data-dwell-disabled` before `location.assign` (belt and braces — the page is leaving).

### Ports and test names

Hub: **8466** `play-ui`; 8427 `watch-ui`; 8456 `this-week-recipe`. Board `board-this-week` through the gate hub (8377). Engine pytest needs none. Scratch hub for F2: 8482.

## How to run things

```bash
cd ~/new-era/era-hub--wt-youtube-videos && node --test tests/this-week-recipe.test.mjs
node --test tests/play-ui.test.mjs && node --test tests/watch-ui.test.mjs
# the board suite ONLY through the gate (a bare run tests master's front end)
ERA_WT_SUFFIX=--wt-youtube-videos bash tools/era-gate.sh
# a scratch hub over the worktree board (F2)
ERA_WT_SUFFIX=--wt-youtube-videos bash tools/assemble.sh && ERA_DATA_DIR=<scratch>/tw-data node server.js 8482
# engine
cd ~/ellie-this-week--wt-youtube-videos && uv run pytest -q tests/activities
```

---

## Task skeleton

### Phase A — the hub's data side (`era-hub--wt-youtube-videos`)
**Posture hint:** implementing

- [ ] **A1. `validatePlay`, `play.json`, the Play door** — `this-week.js`: `validatePlay(m)` per Definitions (exported), `playJson(dataDir, week_of)` → the object above or `null`; `recipe()` adds the `link` Play door at [3,4] when the validated play has content; `THIS_WEEK_REV = 2`; `server.js`: `GET /this-week/<w>/play.json` (no-store, 404 when `playJson` is null; `w` must match `WEEK_RE` else 400) placed BEFORE the media jail so the jail never serves a raw file of that name; `docs/this-week.md` gains the route under "The recipe". Tests in `tests/this-week-recipe.test.mjs`: a full fixture week (9 which incl. one yes/no listed no-first, a sort, a harmonica playit `answer 0`, one video with `before`) → `play.json` shape, `dropped` empty, the root has the Play door; malformed items (two rights, four choices, a bad glyph, `answer 10`, a sort with one bin, a `before` with no right) → each dropped with a reason and the page intact; no `play` → no door, `play.json` has empty engines; the hub route answers 404 for an unknown week and 400 for `w=../x`; the recipe ETag changes between REV 1 and 2 (string contains `-r2`).
  - **Acceptance:** suite green; `routes.test.mjs`, `this-week-fetch.test.mjs`, `watch-ui.test.mjs` untouched and green.
  - **Verification:** `node --test tests/this-week-recipe.test.mjs tests/routes.test.mjs`.
  - **Guardrails:** TDD; `validate()`'s existing behaviour for watch/talk unchanged (its tests must not change); STOP if the jail ordering in `server.js` cannot take a route before it without touching other routes (report the line).
  - **Gate:** overseer review; retrospective in the workpad.

### Phase B — the Play app (`era-hub--wt-youtube-videos`), one builder per task, in order
**Posture hint:** implementing (B1–B3), collaborating on look only (B3's instruments: the builder may choose shapes and colours inside the contract; seats, sizes, holds and the two-strike runner are fixed)

- [ ] **B1. Shell, menu, sounds, Which one?** — `public/play/index.html`, `play.css`, `play.js`, `sounds.js`, `which.js` per Definitions; `tools/build-payload.sh` `cp -r "$HUB/public/play" "$OUT/public/play"` (after `watch`) and `packs.test.mjs` asserts it. `tests/play-ui.test.mjs` (8466; spawn the hub with `ERA_DATA_DIR` holding the fake week `2026-01-05` with a manifest carrying 3 which items — one 3-choice, one 2-choice, one yes/no listed `no` first — no sort, no playit; route `**/voices` and `**/tts*` as the board suite does; `__speechLog`, `__soundLog`, `/log` captured): the menu shows Back + the Which one? tile only, in its seat, ≥ 60 px at 1280×720; the two doors are the only 2× holds; Which one? → the first question is in the strip and was spoken; the yes/no item seats yes left and no right; a dwell (`Dwell.setMs(300)`, hover) on the right tile → `.alive`, a `pop`/choice sound in `__soundLog`, a `/log` line `{door:"play", engine:"which", right:true, strike:0}`, the next question appears; on a 2-choice item a wrong dwell → `.wiggle`, the question re-spoken with "Look for", no `.alive`, `/log strike:1`, both tiles still `.dwell`; a second wrong → the right tile `.alive` by itself, `/log strike:2`, the next item; after the last → `confetti` ran (a `.confetti` node existed) and the menu is back; the 20 s re-say (use `page.clock` or a test seam `window.__idleMs`) says the question again once; a `w` that does not exist → the menu with "Nothing to play yet" and Back; no element on the page ever contains "wrong", "no!", a score or a counter (assert over `document.body.innerText`); reduced motion → no transition.
  - **Acceptance:** suite green; `drawing-ui`, `watch-ui`, `packs` green.
  - **Verification:** `node --test tests/play-ui.test.mjs tests/packs.test.mjs`.
  - **Guardrails:** TDD; the kit files are read-only; `which.js` is a module with no page globals (the watch page imports it in B4); Web Audio must not throw where `AudioContext` is missing (the test browser may lack audio) — `createSounds` degrades to the log hook; STOP if a tile cannot meet 60 px at 1280×720 with three choices (report sizes).
  - **Gate:** overseer review; retrospective.

- [ ] **B2. Sort it** — `sort.js` per Definitions; the menu shows its tile when the week has a sort; `play-ui.test.mjs` grows a second fixture week (or adds a sort to the first): bins left/right with labels and glyphs; the item centred and inert (no `.dwell`); the prompt spoken "Is X A or B?"; right bin → the item lands in the bin's tray (a child glyph appears), next item; wrong → wobble + re-ask, `strike:1`; wrong again → lands in the right bin by itself, `strike:2`; the last → confetti + "All sorted!" + menu; `/log engine:"sort"` lines with `pick` and `right`.
  - **Acceptance / Verification:** `node --test tests/play-ui.test.mjs` green; the B1 tests unchanged.
  - **Guardrails:** TDD; no "wrong" words, no red; STOP if the bins cannot be ≥ 90 px at 1920 beside a centred item (report).
  - **Gate:** overseer review; retrospective.

- [ ] **B3. Play it, four instruments** — `playit.js` per Definitions and spec §5.6: the shared runner (positions, free play, 60 s clock from the first pick, the question, two-strike with the instrument's hint, the cheer, free play after), four renderers. `play-ui.test.mjs` adds a fixture per instrument (four small weeks or one week whose `playit` the test rewrites between cases): ten holes/bars present as `.dwell` ≥ 60 px at 1280×720, left-to-right order, a dwell on hole 3 logs `note` 65 in `__soundLog` and `/log {engine:"playit", pick:3}` with no `right`; the reed/bar wears `.alive` while sounding; the telephone's two state tiles + the cup; `tight` then the cup → a `.wave` runs and `hello` plays clear; `loose` → `muffled`; the puppet's two position tiles + four shapes, `closer` → the shadow's scale grows; the question strip is absent until the clock passes (seam `window.__clockMs` or `page.clock`) and then spoken; a right pick → `.alive` + cheer + `right:true`; the miss path with the hint text; the question strip gone afterwards and picks still sound.
  - **Acceptance / Verification:** `node --test tests/play-ui.test.mjs` green (whole suite under ~90 s); the overseer views a screenshot of each instrument at 1920×1080 (saved by the test to the scratchpad when `ERA_SHOTS` names a dir).
  - **Guardrails:** TDD; shapes are CSS/SVG inline (no image files); STOP if an instrument cannot meet the floors (report); STOP if the harmonica needs more than ten holes to make the week's question answerable (it does not).
  - **Gate:** overseer review; retrospective.

### Phase C — the watch page rework (`era-hub--wt-youtube-videos`)
**Posture hint:** implementing

- [ ] **C1. The watch page as a hub app page** — `public/watch/index.html`, `watch.css`, `watch.js` rewritten per Definitions (door bar, rail Back + Pause/Play, the video, cap, `before` via `import { mountWhich } from "../play/which.js"`, no engine call anywhere — grep `49155` must find nothing under `public/watch`). `tests/watch-ui.test.mjs` rewritten (8427; fixture week + `this-week-1s.mp4` as today, plus a `before` on one video in a second case): page shows the bar, Back and Pause at board size, the video playing (`!paused`, `volume === cap`); `open` logged; a dwell on Pause → `paused`, label "Play", `/log paused`; again → playing, `resumed`; `ended` → `/log ended` then `location` becomes `/board/?recipe=this-week&board=watch` (the hub serves a board page; assert the URL, not the board); Back → the same URL; bad params → the same URL after ~1 s; the `before` case: the question first, the video `paused` and hidden, a right dwell → `/log before … right:true` then the video plays; the 💬 door with `pauseGoes:"tdsnap"` → `/kiosk/pause` posted (route it) and the video paused; the two doors are the only 2× holds; nothing on the page says "wrong".
  - **Acceptance:** suite green; `play-ui` green (shared `which.js` unchanged by this task); `docs/this-week.md` "The watch page" section rewritten to match.
  - **Verification:** `node --test tests/watch-ui.test.mjs tests/play-ui.test.mjs`; `grep -rn 49155 public/watch` empty.
  - **Guardrails:** TDD; `which.js` is not edited here (if it needs a change, STOP and report — B1's builder owns it); no `requestFullscreen`; the mp4 path stays `/this-week/<w>/<v>.mp4`.
  - **Gate:** overseer review; retrospective.

### Phase D — the board (`era-board--wt-youtube-videos`)
**Posture hint:** implementing

- [ ] **D1. `link` tiles and navigating `video` tiles** — `board-render.js` per Definitions; `tests/board-this-week.test.mjs`: the fixture recipe gains the Play `link` door; the root shows three doors (Watch, Talk, Play) in their seats; a dwell on Play → `page.waitForURL(/\/play\/\?w=2026-01-05$/)` (route `**/play/*` to a stub 200 page so the test does not need the app); a dwell on a `video` tile → `waitForURL(/\/watch\/\?w=2026-01-05&v=aBcDeFgHiJk$/)` and NO request to `127.0.0.1:49155` (the stub records calls → zero); with `era.lock` set the video dwell does nothing and the Play dwell still navigates; a `link` with `href:"http://evil"` or `"//x"` is inert; `.watching` no longer exists in the DOM after any action; `board-movies`, `board-lock`, `board-pixel`, `board-partner-strip` unchanged.
  - **Acceptance:** green under the gate.
  - **Verification:** `cd ~/new-era/era-hub--wt-youtube-videos && ERA_WT_SUFFIX=--wt-youtube-videos bash tools/era-gate.sh`.
  - **Guardrails:** TDD; `LAUNCH_TYPES` untouched; `launchMovie` untouched; STOP if the pixel audit's root-board invariants fail with three doors (report the measure).
  - **Gate:** overseer review; retrospective.

### Phase E — the engine's one line (`ellie-this-week--wt-youtube-videos`)
**Posture hint:** implementing

- [ ] **E1. The prompt names each instrument's positions** — `prompt.py:252` becomes the positions table of spec §5.6 in prose: "Play it: one of harmonica (answer = hole 0–9, left to right, low to high), xylophone (bar 0–9, longest/lowest to shortest/highest), string-telephone (0 = tight, 1 = loose), shadow-puppet (0 = closer to the lamp, 1 = farther away). `answer` is that index." `tests/activities/test_prompt_positions.py` asserts the rendered prompt contains the four position phrases; the existing prompt tests unchanged; `uv run pytest -q tests/activities` green; `selfcheck.sh` green.
  - **Guardrails:** schema untouched; no other prompt wording changes.
  - **Gate:** overseer review.

### Phase F — gate, scratch end-to-end, patch release, devices, dad (behavioral verification; the overseer drives)
**Posture hint:** collaborating

- [ ] **F1. Gate green** — `ERA_WT_SUFFIX=--wt-youtube-videos bash tools/era-gate.sh`: `== era-gate: N passed, 0 failed ==` with N ≥ 125 + 1 (play-ui); engine pytest green.
- [ ] **F2. Scratch end-to-end on the build box** — scratch hub 8482 (`ERA_WT_SUFFIX` assemble) over a fake Drive root holding the **real 2026-10-19 package** (`weeks/2026-10-19/this-week/manifest.json` from the engine checkout, the five mp4s replaced by the 1 s fixture, thumbnails by any webp) — Playwright at 1920×1080: root (three doors), Watch grid, the watch page with the rail (one with the `before` question first), Play menu, Which one? mid-set, Sort it mid-set, the shadow-puppet instrument (10-19's) with its question up; the overseer views every shot; `curl -s :8482/this-week/2026-10-19/play.json | jq '.dropped'` is `[]`; `curl -I :8482/recipes/this-week.json` ETag ends `-r2`.
- [ ] **F3. Land + patch release + devices** — land era-board then era-hub (`worktree.sh land`), land the engine; `bash tools/release.sh v1.0.8 --patch`; `POST /update/check` on the tablet and home i13 (or wait for the 30-minute cadence); `/version` shows the new build; `curl :8377/recipes/this-week.json` on the i13 shows the Play door for 2026-10-19 (or the current week).
- [ ] **F4. Dad assesses on the tablet** — the Watch tile opens the video on its own screen in the same window, one sound, Pause works, Back and the video's end land on the Watch grid; Play's three engines with the week's content; dad's words in the chat are the verdict. Open: whether Talk stays, folds, or goes (dad decides after seeing Play).
  - **Verification:** `logs/<day>.jsonl` on the tablet holds `door:"watch"` `open`/`ended` and `door:"play"` lines with `strike`; the ERAgaze log shows no `/app/launch` for a hub URL that day.

## Risks and unknowns

- Headless Chromium may have no audio device: `createSounds` must degrade (no `AudioContext` → log hook only) or the whole suite goes red for a reason that is not the app's.
- The board's dwell can activate a tile a second time during the page's unload; `data-dwell-disabled` before `location.assign` covers it, and the new page has no tile under that spot by design (the rail is on the left; the Watch grid's video seats are not).
- Ten harmonica holes at 1280×720 are near the 60 px floor; B3 measures and STOPs if short (eight holes would still answer every golden question but changes the positions table — the overseer decides).
- `Speech.say` on a page with no TTS key falls back to `speechSynthesis`; the tests stub `/voices` and `/tts*` as the board suite does.
- A patch release still runs the VM leg; if the VM template is unhappy, the release memory's recipe applies — not this plan's problem, but it gates F3.

## Not verified (and what WAS)

Verified by reading on 10/21: every line in the Preflight table; the tablet's gaze log for dad's test. Not verified: that Playwright's Chromium exposes `AudioContext` headless (B1 degrades); that `page.clock` exists in the pinned Playwright (B1/B3 fall back to a `window.__clockMs` seam); that the patch flow's VM leg is green on the re-saved template (F3 finds out).

## Spec coverage (self-review)

§3.3 (amended) → C1, D1. §5.1 pages/engines → B1–B3. §5.2 never wrong → B1–B3, C1 (`before`). §5.3 bar → the engine's rubric (phase 1, unchanged). §5.4 predict-then-watch → A1 (`before` in `play.json`), C1. §5.5 media → deviation 3 (B1 sounds). §5.6 → A1 (door), B1–B3, E1. §6 package → A1 (`validatePlay`). §9 phase-2 row → A1, B1 (payload), C1, D1, E1. §10 Play UI tests → B1–B3, C1. §11 row 2 → this plan. §13 Q3 (Play) → answered by this plan; Talk's fate → F4.
