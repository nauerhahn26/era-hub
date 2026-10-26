# The weekly suite, phase 2b — the small boards, the three-answer triangle, arming after the question — Implementation Plan

> **For agentic workers:** REQUIRED WORKFLOW: subagent-driven development (one fresh-context builder per task, the overseer reviews between tasks). Steps use `- [ ]` checkboxes. TDD on every task: the test is written and SEEN red before the code.

**Goal:** Dad assessed phase 2 on the tablet (2026-10-25): "Awesome!" with two notes. (1) Which one? with three answers: "while I was waiting for the question … I would start selecting things. I think the spacing is perfect when you have 2 options with the black in the middle." (2) "The grid of 4x3 feels wrong for watch, play, talk. I could see us adding 1-2 more but not 6 more." He approved the overseer's proposal: the **triangle** (two up, one down, black elsewhere) for the week root, the Play menu and three-answer questions; a **3×3 ring** for the Watch grid; answers **armed only after the question has been read**, released "as rapidly as practical".

**Architecture:** One repo, `era-hub--wt-youtube-videos` (branch `feat/youtube-videos`, synced onto master `b77f5c8` on 10/25). The board renderer already lays out any `rows × columns` (clothing ships 2×2 and 3×2 boards), so the board shapes are a recipe change in `this-week.js`; the question pages are `public/play/which.js` + `play.js`/`play.css`. No board, engine or kit change.

**Spec:** `docs/specs/2026-10-12-weekly-suite-design.md` — §1 (amended 2026-10-25), **§3.4**, §5.6 (amended 2026-10-25), §11 row 2b. The phase-2 plan's Definitions hold for everything this plan does not change.

**Discipline:** TDD every task. Two builders may work in this worktree at once because their files are disjoint (A: `this-week.js` + `tests/this-week-recipe.test.mjs` + `docs/this-week.md`; B: `public/play/*` + `tests/play-ui.test.mjs` + `tests/watch-ui.test.mjs`), but **only one commits at a time**: builder A stops before committing and waits for the overseer's word. `git add` exact paths, never `-A`. No "while I'm here". STOP and report instead of improvising when: a test outside this plan starts failing; an assertion would have to be weakened; a change would touch `public/dwell.js`, `public/speech.js`, `public/lib/*`, era-board, the engine or the server routes; a port outside the table looks necessary.

**Commits:** house style `this-week: <what> — <why> (spec 2026-10-12 §N)`. Author is the user; no vendor or model names anywhere (say "the agent"); no attribution trailers. The pre-commit era-scan runs: no family names but Ellie, no infra terms, no IPs but loopback, no school, teacher, town or classmate names. Fixtures use fake weeks (`2026-01-05`, `2026-01-12`, …), topic "shadows", ids like `aBcDeFgHiJk`.

---

## Spec deviations

1. **Arming has a cap.** `Speech.say()` returns a promise that resolves when the utterance ends; a stuck synthesiser would never resolve it and she would wait forever, so the answers also arm after a cap (`ARM_CAP_MS = 8000`). The spec's "short cap" is this number.
2. **No added beat after the reading.** Dad: "release arm as rapidly as practical." The tiles arm on the promise, and the dwell engine starts counting on her next gaze sample over an armed tile (it accrues only on `.dwell:not([data-dwell-disabled])`, `public/dwell.js:154`), so a gaze already parked on a tile still gets one full dwell before it fires. That is the beat.
3. **Sort it keeps its bins live** while its question reads (dad's words were about Which one?); it is a follow-up for his next look, not part of this patch.
4. **The release is a patch** (`v1.0.<next>`, unsigned, under the signed v1.0.0 installer): recipe + page files only.

## Preflight (verified 10/25 against the synced worktree)

| Fact | Where |
|---|---|
| `layoutCells(board)` honours any `rows`/`columns`; `gridFit` stretches tiles to fill; declared rows always render | `era-board/app/board-render.js:455-494, 151, 832-836` |
| Other recipes already ship small boards (`rows: 2, columns: 2`; `rows: 3, columns: 2`) | `clothing-worker.js:1687, 1730` |
| Root recipe: Watch [1,1], Talk [1,4], Play `link` [3,4]; `WATCH_SEATS = [[1,2],[1,3],[1,4],[2,1],[2,4]]`; `emptyRecipe()` is a 3×4 root; `THIS_WEEK_REV = 2` feeds the ETag | `this-week.js:20, 28, 246-249, 256-264, 279` |
| Recipe tests pin the current seats (`root.rows 3 / columns 4`, Talk `col: 4`, Play `row: 3, col: 4`, Watch seats) | `tests/this-week-recipe.test.mjs:71-116` |
| `seatsFor(choices)`: three → `[0,1,2]` in one row; two → `[i, null, j]`; `mountWhich` says the question then arms idle; `freeze()` sets `data-dwell-disabled`; `pick(idx)` is the only path to a log line | `public/play/which.js:67-73, 76-172` |
| `Speech.say(text, kind)` returns the chain promise; test mode resolves after `60 + min(240, 4·len)` ms and logs `end` | `public/speech.js:109-154` |
| Play menu: three `.seat` cells in one row (`.seats` grid of three columns); an absent engine is `.seat.empty` | `public/play/play.js:72-112`, `public/play/play.css:33-43` |
| The watch page mounts `mountWhich` for a `before` question (the Pause tile is a rest box while it is up) | `public/watch/watch.js` |
| Ports: play-ui **8466**, watch-ui **8427**, this-week-recipe **8456** (each suite spawns its own hub) | the suites' headers |
| era-board's `board-this-week.test.mjs` uses its own 3×4 fixture recipe, not the hub's — unaffected | `era-board/tests/board-this-week.test.mjs:41-51` |

## Definitions

### The recipe (`this-week.js`)
- `THIS_WEEK_REV = 3` (comment: "3: the small boards (spec §1, §3.4)"). The empty-recipe ETag string stays `"none-r1"` unless a test pins otherwise — the shape of the empty board changes too (2×3), so bump it to `"none-r3"` and update its test.
- Root board: `rows: 2, columns: 3`. Watch `row:1,col:1`; Talk `row:1,col:3`; Play `link` `row:2,col:2` (only when an engine has content, as today). Nothing else; the renderer paints the rest black.
- `emptyRecipe()` root: `rows: 2, columns: 3, buttons: []`.
- Watch board: `rows: 3, columns: 3`; `backCell()` unchanged at [1,1]; `WATCH_SEATS = [[1,2],[1,3],[2,1],[2,3],[3,1]]`.
- Talk boards: unchanged.
- `docs/this-week.md`: the shapes paragraph updated.

### Which one? (`public/play/which.js`)
- `seatsFor(choices)` returns, for three answers, a **two-row** seating: `[[0, null, 1], [null, 2, null]]`-shaped output or an equivalent the DOM builder consumes (the builder chooses the representation; the exported function keeps its name and the tests assert the seat→index map: answer 0 at row 1 col 1, answer 1 at row 1 col 3, answer 2 at row 2 col 2). Two answers: one row, as today.
- CSS: `.wh-seats` becomes a grid of three columns and **one or two rows** (`data-rows="2"` on the row container, or a modifier class); the tile's glyph/label sizing already follows the tile's box (`container-type:size`).
- Arming: every answer tile is created with `data-dwell-disabled` and class `wh-waiting` (muted: `opacity:.55; filter:saturate(.6)`, no transition on arm longer than 150 ms). `mountWhich` awaits `Promise.race([say(item.q), sleep(ARM_CAP_MS)])`, then removes both from every tile (`arm()`), unless destroyed meanwhile. `pick()` returns at once while not armed (no log). The miss re-say and the idle re-say never disarm. `freeze()` unchanged.
- Test seam: `window.__whichArmed` is not needed — the tests read the DOM (`[data-dwell-disabled]` present → absent) and `__speechLog`'s `end` line for the question.

### The Play menu (`public/play/play.js`, `play.css`)
- `.seats` becomes two rows × three columns; Which one? seat `[1,1]`, Sort it `[1,3]`, Play it `[2,2]`; `.seat.empty` fills `[1,2]`, `[2,1]`, `[2,3]` and any absent engine's seat. `data-seat` keeps counting 0..5 in reading order (tests pin ids `tile-which`, `tile-sort`, `tile-playit`).

### Ports and test names
| suite | port | file |
|---|---|---|
| recipe | 8456 | `tests/this-week-recipe.test.mjs` |
| play-ui | 8466 | `tests/play-ui.test.mjs` |
| watch-ui | 8427 | `tests/watch-ui.test.mjs` |

## How to run things
- One suite: `node --test tests/<name>.test.mjs` from the worktree (Playwright resolves from `~/new-era/node_modules`; the suites spawn their own hub on their own port — check `ss -ltn` first).
- Full gate (the overseer, detached): `ERA_WT_SUFFIX=--wt-youtube-videos setsid nohup tools/era-gate.sh > <scratch>/gate-2b.log 2>&1 &` then `pgrep -af era-gate.sh` for the pid.

## Task skeleton

### Task A — the small boards (recipe) — posture hint: implementing
- [ ] A1 Tests first in `tests/this-week-recipe.test.mjs`: root `rows 2 / columns 3`; Watch [1,1], Talk [1,3], Play [2,2]; no Play door → only two buttons; empty recipe 2×3 with ETag `"none-r3"`; Watch board `rows 3 / columns 3`, Back [1,1], five videos at `[[1,2],[1,3],[2,1],[2,3],[3,1]]`, fewer videos fill in that order; Talk unchanged; ETag carries `-r3`. See them red.
- [ ] A2 `this-week.js` per Definitions; `docs/this-week.md` shapes paragraph. Suite green (`8456`). `node --test tests/this-week-fetch.test.mjs tests/routes.test.mjs tests/packs.test.mjs` still green.
- [ ] A3 Report to the overseer with the diff summary; **do not commit** until told (builder B commits first).
- **Verification:** `node --test tests/this-week-recipe.test.mjs` → all pass; `curl -s 127.0.0.1:<port>/recipes/this-week.json` on a scratch hub shows the shapes (overseer, F1).

### Task B — the triangle and arming (Which one?, the Play menu) — posture hint: implementing
- [ ] B1 Tests first in `tests/play-ui.test.mjs`: (a) a three-answer item seats answer 0 at `[1,1]`, 1 at `[1,3]`, 2 at `[2,2]` with three black cells (assert on `data-seat`/`data-i` and on bounding boxes: the third tile's centre x ≈ the strip's centre x, its top below the first row's bottom); a two-answer item keeps one row with the black middle; (b) on mount every answer tile has `data-dwell-disabled` and `.wh-waiting`; a click on the right answer before arming produces no `alive`, no `/log` line and no praise; after `__speechLog` shows `end` for the question the attributes are gone and a click works; (c) with speech mode off the tiles are armed at once; (d) with a question that never ends (stub `Speech.say` to a pending promise in the page) the tiles arm within `ARM_CAP_MS` under `page.clock`; (e) the menu seats Which one? `[1,1]`, Sort it `[1,3]`, Play it `[2,2]`, black elsewhere, and a week with only Which one? leaves the other two black. In `tests/watch-ui.test.mjs`: the `before` question's answers arm after its reading (one test). See them red.
- [ ] B2 `which.js`, `play.js`, `play.css` per Definitions. Both suites green (`8466`, `8427`). Floors: every answer tile ≥ 60 px on both axes at 1280×720 in the two-row shape (the existing floor test extended).
- [ ] B3 Commit: `this-week: the triangle for three answers and the Play menu, answers armed when the question has been read — a wandering gaze picked before the question finished and three tiles across left nowhere to rest; two answers keep the tall row with the black middle (spec 2026-10-12 §5.6, amended 2026-10-25)`. Report with the diff summary and the suite counts.
- **Verification:** `node --test tests/play-ui.test.mjs tests/watch-ui.test.mjs` → all pass; the overseer views screenshots of a three-answer item muted and armed, and the menu (F1).

### Phase F — gate, scratch end-to-end, patch release, devices (the overseer drives)
- [ ] F0 After B3: tell builder A to commit (`this-week: the small boards — a 2×3 triangle root and a 3×3 Watch ring; twelve cells for three doors read wrong and nothing on this board will ever need six more (spec 2026-10-12 §1, §3.4)`).
- [ ] F1 Full gate detached; expect `0 failed`. Scratch hub on **8482** over the real current week with fixture media: screenshots of the root, the Watch grid, the Play menu, a three-answer item muted then armed, a two-answer item. Overseer views every shot.
- [ ] F2 `worktree.sh land ~/new-era/era-hub youtube-videos`; `release.sh v1.0.<next> --patch` detached (check the feed's current version first — other sessions publish from this repo); VM leg B green; publish (dad's "Go for it" 10/25 is the word).
- [ ] F3 Tablet + home i13: `POST /update/check`, confirm `/version` and `/recipes/this-week.json` root `rows 2`. Tell dad. Follow-up for his next look: Sort it's bins while its question reads (deviation 3).

## Risks and unknowns
- A 2×3 root makes each door roughly a third of the width and half the height — bigger than today; glyph and label scale with the tile (board tiles already do). Verified by the F1 screenshots, not by a test.
- Arming while her gaze already rests on a tile: the dwell engine counts from the next gaze sample after arming (deviation 2). If the F3 look shows the opposite (an instant fire), the fix is a `rearm` in `dwell.js`, which is era-core's file — a separate task, not this patch.
- `watch-ui`'s `before` test depends on the Pause tile staying a rest box while the question is up; unchanged.

## Spec coverage (self-review)
§1 amended (root 2×3, future doors) → A; §3.4 (Watch ring) → A; §5.6 amended (triangle, arming, cap, menu) → B; §11 row 2b → this file. Talk untouched by design.
