# Clothing Picker — the weather in the middle (plan)

Design: [2026-11-03-weather-centre-design.md](../specs/2026-11-03-weather-centre-design.md).
Branch `feat/weather-centre`, worktree `era-hub--wt-weather-centre` (from master fc722ed), era-hub only.

## Preflight (verified against this tree, b35393f)

- The weather tile is built inline in the today loop of `buildCataloged`
  (`clothing-worker.js` ~1715-1760: `twoNumbers`, `span`, `lead`, label, say, footnote,
  `row: 2, col: 2, col_span: 2`). It depends only on `w`. `gridPages(id, name, items,
  backLoad, extra)` (~1581) builds every browse page; `build` (~1806), `acc` (~1818)
  and `choose_bottom` (~1826, 2×2) are built inline after it. `w` is in scope for all
  of them (`const w = known || await weather()` ~1643).
- `tests/clothing-accessories.test.mjs`: all six centre-black assertions (lines 688, 723,
  748, 757, 775, 1065) build with NO sky (seam `ERA_WEATHER_URL` 127.0.0.1:1), so they
  keep holding: no forecast, black centre. The "approved layout" case (~1085) builds
  under `underSky(allDayAt(72))` and already pins the tile on today pages by
  `footnote != null`, `row 2 / col 2 / col_span 2`, no `load`, no `combo`, plus the
  overlap walk — the shape to reuse. Helpers: `at(board,row,col)` matches exact
  row/col (a span-2 tile is found at [2,2], and [2,3] stays `undefined` — pin that
  deliberately, it is how the old black-centre asserts read); `boardOf`, `pagesOf`,
  `cellsOf(board,type)`.
- `tests/clothing.test.mjs:359` checks only `type === "outfit"` tiles: unaffected.
- `tests/clothing-weather.test.mjs gridIds` filters `type === "clothing"`: unaffected.
  Its fake forecast (`hourly()`, 55 at 8 / 67 at noon, default window) gives the tile
  `55° → 67°  cool` — the label to pin on a browse page there.
- The renderer draws any `col_span` control (`public/board/board-render.js` 341, 534,
  929); nothing in era-board changes. No suite to register (`clothing-accessories`,
  `clothing-weather`, `clothing` are in `tools/testing/registry.json`).
- The 11/2 scratch-hub proof used a fake Open-Meteo on 8384 + hub on 8383
  (`ERA_WEATHER_URL`, `ERA_TEST_PORT`); its shape is in the 11/2 plan's T8 tick.

## Guardrails (every task)

- **Test first**: the test is written and seen red before the code; the tick quotes the
  red message. No task ticks without its test.
- **Verify** with the named command; paste the summary line into the tick.
- **STOP and report** rather than improvise when: a suite outside the ones named goes
  red; any garment, Back, More or the door changes cell; the tile's words differ from
  the today page's on the same build; the offline recipe is not byte for byte the old
  one; the tile would need a `load` or any new field.
- No family names, towns, IPs, device ids; no AI vendor or model names, in code, tests,
  docs or commits. Commits by the user, no trailers.
- Worktree only; never the main checkout; never the live hub on 8377; test hubs
  8380-8389 after `ss -ltn`.

## Tasks

### Phase 1 — the tile everywhere (posture: implementing)

- [x] T1 `tests/clothing-accessories.test.mjs`: under `underSky(allDayAt(72))` with a
      wardrobe of ≥ 17 tops and `{ jacket: 1 }` plus one fancy piece: (a) EVERY 3×4
      board in the recipe (`rows 3, columns 4`: today pages, `build`, `acc`, every
      `cat_*` page incl. a `_2`, every `acc_*` incl. Dress up) has the weather tile at
      `[2,2]` with `col_span 2`, `type "control"`, no `load`, no `combo`, the same
      `say` and `footnote` as `today`'s tile, and `[2,3]` undefined; (b) the overlap
      walk from the approved-layout case passes on every one of them; (c) on `cat_top`
      the seven/eight garment cells, Back [1,1], More [3,1] and the door [3,4] are
      exactly where the no-sky case puts them; (d) `choose_bottom` is unchanged (2×2,
      four buttons, no footnote). Then the no-sky mirror: the same walk asserts `[2,2]`
      and `[2,3]` undefined on every 3×4 board. Red first on (a).
      Two cases added after the approved-layout case (one wardrobe built twice, sky and no
      sky, 17 tops + 1 jacket + a fancy dress; the tile is also `deepEqual` to today's and
      each page has exactly one button more than its offline twin). Red on (a):
      `build: the weather stands in the middle` (# pass 33 / # fail 1; the no-sky mirror
      was green from the start, as expected).
- [x] T2 `clothing-worker.js`: lift the today loop's tile into `weatherTile(w)` (one
      object, built once per build and pushed by reference or spread — identical
      fields); the today loop pushes it as before; `gridPages` takes `w` (or the tile)
      and pushes it on every page when present; `build` and `acc` push it too;
      `choose_bottom` untouched. Comments name dad's 11/3 words and the 11/3 amendment
      of the 9/3 law. Verify: `node --test tests/clothing-accessories.test.mjs`.
      **# pass 34 / # fail 0.** `weatherTile(w)` sits above `FIRST_SLOTS`, built once as
      `tile` in `buildCataloged`; `gridPages(..., extra, tile)` pushes it last on every page,
      `build` and `acc` push it last; the today loop pushes it first as before. Offline
      proof: the same 35-piece fixture (9 jackets, shoes, a fancy dress) built with no sky
      on 7244464's worker and on this one gives byte-identical `recipes/today.json`
      (`cmp`, 69871 bytes). Neighbour check `node --test tests/clothing.test.mjs`: # pass 36 /
      # fail 0.
- [x] T3 `tests/clothing-weather.test.mjs`: on the standard build the `cat_top` tile
      reads `55° → 67°  cool` and `gridIds("cat_top")` is unchanged (garments only).
      Red first, then green with no code change expected beyond T2.
      Verify: `node --test tests/clothing-weather.test.mjs`.
      Red against the pre-T2 worker (T2 was already written, so the old file was put back
      for the run): `the weather stands in the middle of the Tops grid`. Green:
      **# pass 38 / # fail 0**; the 11/1 `gridIds` cases unchanged.

### Gate: review (phase boundary)

- [x] T4 Overseer review of the diff against spec §2: one tile, every 3×4 page, nothing
      moved, offline identical. Focused run:
      `node --test tests/clothing-accessories.test.mjs tests/clothing-weather.test.mjs tests/clothing.test.mjs tests/clothing-rank.test.mjs tests/clothing-fit.test.mjs tests/clothing-variety.test.mjs tests/clothing-diversity.test.mjs`
      Review 11/3: `weatherTile(w)` is the today loop's object moved verbatim, built once and
      pushed by reference on every 3×4 page (nothing downstream mutates a button, checked);
      `choose_bottom` untouched; offline recipe byte-identical (builder's `cmp`). Focused run:
      `# pass 323 / # fail 0`. Screenshots of Tops and Full wardrobe show the tile in the middle.

### Phase 2 — behavioural verification (mandatory)

- [x] T5 Scratch hub on a free 8380-8389 port with a fake forecast (the 11/2 shape,
      52 at 8 rising to 67 at 13) and a fixture wardrobe: built `recipes/today.json`
      shows the tile at [2,2] on `cat_top`, `cat_top_2`, `build`, `acc`, `acc_jacket`;
      then one screenshot each of the Tops page and Full wardrobe in the board
      (playwright from `tests/`, page `/board/?recipe=...` as the 11/2 proof did) into
      the scratchpad, showing the weather in the middle. Kill only the recorded pids.
      Scratch hub 8383 + fake forecast 8384 (52 at 8, 55/58/61/64 to 67 at 13, 65 after;
      default 10 AM-2 PM window), fixture `synthetic-wardrobe.mjs --materialize … 35
      --accessories jacket=2` + one dress marked fancy (17 tops). Board built (37 boards):
      `today`, `today_2`, `today_3`, `build`, `acc`, `cat_top`, `cat_top_2`, `cat_top_3`,
      `cat_pants`, `cat_shorts`, `cat_dress`, `cat_outfit`, `acc_jacket`, `acc_fancy` each
      carry the tile at [2,2] span 2, `[2,3]` empty, the JSON identical to `today`'s
      (`52° → 67°  cool`, "This morning it is about 52 degrees, warming to 67. Dress for
      cool."). Screenshots (1280x800, `Board.show(id)` since `?board=` refuses `_`) of Tops
      and Full wardrobe in the scratchpad show the tile across the centre pair. Both node
      pids killed by number.
- [x] T6 Full gate detached (`setsid nohup bash tools/era-gate.sh`), real pid from
      `/tmp/era-gate-slots/`, one `bash tools/gate-wait.sh <pid> --timeout 570` (again
      if 124). Tick with the receipt line.
      **208 passed, 0 failed** on 7d43347 (run `2026-11-03T19-17-33Z-367b3c7`, 0 reused; stamp
      `/tmp/era-gate-green/367b3c72244d79e999928d09defe8e60a9fc536f`).

### Phase 3 — ship (on dad's word only)

- [ ] T7 Land (`worktree.sh sync` first if master moved; re-gate; `worktree.sh land`);
      patch build + push to the device dad names; release when he says. None without
      his word.

## Retrospective

- The board's `?board=` deep link accepts only `[a-z0-9-]`, so a picker page (`cat_top`) cannot be
  opened by URL; the proof used `window.Board.show(id)`. Worth knowing for any future screenshot proof.
- Full wardrobe with the weather in its centre shows a black bottom row under a full middle row;
  it reads top-heavy. Design point for dad, not a bug.
- The tile's footnote is cut off on the board ("updated Tue, Nov 3, 7:0…") exactly as on the today
  page since 9/23; not new, not touched.
- One tile object is shared by reference across boards; fine today because nothing mutates buttons
  after the build. A future per-board mutation would have to spread it.
