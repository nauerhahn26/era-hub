# Clothing Picker — the morning counts (plan)

Design: [2026-11-02-morning-weather-design.md](../specs/2026-11-02-morning-weather-design.md).
Branch `feat/clothing-morning-weather`, worktree `era-hub--wt-clothing-morning-weather`, era-hub only
(the board renders the recipe; nothing in era-board changes).

## Preflight (verified against this tree, 521c85b)

- `readWindow(hourly, day, win)` has three callers (`clothing-worker.js` ~1387, 1393, 1437); the
  weather object is spread as `{...r, window, place, fetchedAt, source}` at ~1389, so new fields
  (`morning`, `high`, `morningBand`) ride along for free. Consumers of `w.t`: the deal (1654), the
  tile (1706-1707), the browse grids (1804). `w.band` → `accessoryOrder` (1616 → the acc grids).
- Settings: `server.js` ~2166-2170 validates `weatherWindow` and ~2215 deletes the stored week and
  rebuilds when the window or place changes. The new `weatherLeaveAt` follows that shape exactly.
  UI: `public/settings/index.html` row `#wxWindow` (213-219), `wxPaint` (~1920), the save at ~1935.
  `tests/settings-ui.test.mjs` ~964-980 drives the window selects; the knob gets the same treatment.
- **Fixture warning.** `tests/clothing-weather.test.mjs hourly()` gives 55 at every hour before 9 and
  67 at noon. With the leave hour 8 the suite's standard window (9-12) now plans at
  round(55/3 + 2·67/3) = **63 "cool"**, not 67 "warm". Assertions that pin `67° warm`, `band: "warm"`
  in page-1 memory fixtures, and the "hour 12 is the warmest (67 not 66)" check must be re-pinned to the
  new numbers deliberately (63 vs 62 still tells the inclusive end apart). The 11/1 hot-window test
  (14-17, high 80) now plans at 72 "warm": its order assertions (tees first, tank before the sweater,
  sweater last, light pants before fleece) still hold at 72 — confirm, do not loosen.
- `tests/weather-location.test.mjs` stubs `w` whole (`{t, band, symbol, window}`) — untouched.
- No suite to register: `tools/testing/registry.json` already lists `clothing-weather`,
  `clothing-rank`, `settings-ui`, `routes`.
- `tools/clothing-simulate.mjs` / `clothing-diversity.mjs` take a planning °F; they do not read the
  forecast and need no change.

## Guardrails (every task)

- **Test first.** Each task's test is written and seen failing before the code (the pin is the red
  run's message). No task ticks without its test.
- **Verify** with the command the task names; paste the summary line into the tick.
- **STOP and report** rather than improvise when: a suite outside the ones named goes red; the
  rule's numbers on dad's five days (spec §3 table) do not come out as the table says; a change
  would touch the curve's crossovers, `FIT`, `SHARE_FLOOR` or `weatherOrder`; the settings knob needs
  more than one select; the tile's label would not fit its cell.
- **No family names, towns, IPs, device ids; no AI vendor or model names** in code, tests, fixtures,
  docs or commits. Commits by the user, no trailers.
- Worktree only; never the main checkout; never the live hub on 8377; test hubs 8380-8389.

## Tasks

### Phase 1 — the number (posture: implementing)

- [x] T1 `tests/clothing-rank.test.mjs`: `planningTemp(morning, high)` — 52/67 → 62, 55/72 → 66,
      60/75 → 70, 65/85 → 78, 45/60 → 55; `null`/`NaN` morning → `high` unchanged; `null` high → null;
      result is an integer. Red on `R.planningTemp is not a function`.
      Red: `R.planningTemp is not a function` (4 fails, `# pass 147 / # fail 4`).
- [x] T2 `clothing-rank.js`: `planningTemp` beside `sharesAt`, exported, with the 11/2 quote in its
      comment and the 9/23 §4 amendment named. Verify: `node --test tests/clothing-rank.test.mjs`.
      `node --test tests/clothing-rank.test.mjs` → `# pass 151 / # fail 0`. The spec §3 table reproduces exactly (62/66/70/78/55/63 and every share).

### Phase 2 — the forecast read (posture: implementing)

- [x] T3 `tests/clothing-weather.test.mjs`: (a) the standard build's tile reads `55° → 67°  cool`,
      `w.t` 63 (re-pin every assertion the preflight names, each with a one-line reason); (b) a
      series with no hour 8 reads `67° warm` and the old label (fallback = today's behaviour); (c)
      `weatherLeaveAt: 10` with window 10-14 reads morning = hour 10 (66) → t 67; (d) window 14-17
      (the 11/1 hot test) plans at 72 and its order assertions hold; (e) the jacket grid
      (`acc_jacket`) is ordered by the MORNING band: with morning 55 (cool) and high 80 (warm/hot),
      the warmest jacket leads. Red first.
      Red: 18 of 23 failing before T4 (the no-hour-8 fallback, the cool 0-8 grid and the re-pinned 80 °F deal pass on the old code, as they should). (c) reads 69, not 67: window 10-14 peaks at 70 (hour 13), round(66/3 + 2·70/3) = 69; the clamp itself is pinned separately (leave 11, window 9-12 → hour 9). The 9/29 hot-deal case moved to window 16-17 + leave 16 to keep reading 80 °F (at 72 the sweater is 12 % and is dealt). Added: a flat-day case (morning = high reads as before).
- [x] T4 `clothing-worker.js`: `leaveHour()` reads `weatherLeaveAt` (integer 0-23, default 8) from
      `app-settings.json` next to `weatherWindow`, clamped to `win.from` when the window starts
      earlier; `readWindow(hourly, day, win, leaveAt)` adds `morning` (the hour's temp or null),
      `high`, `morningBand`, and `t = planningTemp(morning, high)`; the three callers pass the hour;
      `buildCataloged` orders accessories by `w.morningBand || w.band`; the tile label
      `${morning}° → ${high}°  ${band}` and say *"This morning it is about M degrees, warming to H.
      Dress for BAND."* when `morning` exists, else exactly as today. Comments name dad's 11/2 words.
      Verify: `node --test tests/clothing-weather.test.mjs tests/clothing-rank.test.mjs`.
      `node --test tests/clothing-weather.test.mjs tests/clothing-rank.test.mjs` → `# pass 187 / # fail 0` (with weather-location: 215/0). Tile arrow only when the morning is a separate hour (leave < window start) AND cooler than the high; otherwise the pre-11/2 tile with the planning °F. weather-location re-pinned once (`/^81°/` → `/→ 81°/`).

### Phase 3 — the knob (posture: implementing)

- [x] T5 `tests/settings-ui.test.mjs` + `tests/routes.test.mjs`: POST `{weatherLeaveAt: 7}` round-trips
      through GET; `null` clears to the default; `"8"`, 24, -1, 3.5 are ignored; a changed hour deletes
      `.weather-cache.json` and triggers a rebuild (as the window does); the select `#wxLeave` shows
      the stored hour and saving it toasts. Red first.
      Red: both new cases fail (`# pass 0 / # fail 2`, filtered by name).
- [x] T6 `server.js` + `public/settings/index.html`: validation beside `weatherWindow`; one select
      "She leaves the house at" under the window row with the hour labels `wxLabel` already makes;
      hint text names why (the morning counts for pants and jackets). Verify:
      `node --test tests/settings-ui.test.mjs tests/routes.test.mjs` → `# pass 95 / # fail 0`. The row also had to join the weather card in `public/settings/settings-layout.js` (it moves rows by id).
      `node --test tests/settings-ui.test.mjs tests/routes.test.mjs`.

### Gate: review (phase boundary)

- [ ] T7 Overseer review of the diff against spec §3-§4: the rule, the fallback, the clamp, the
      accessory band, the tile, the knob. Focused run:
      `node --test tests/clothing-rank.test.mjs tests/clothing-weather.test.mjs tests/clothing-fit.test.mjs tests/clothing-accessories.test.mjs tests/clothing-variety.test.mjs tests/clothing-diversity.test.mjs tests/settings-ui.test.mjs tests/routes.test.mjs tests/weather-location.test.mjs`
      Builder's focused run (review left to the overseer): `# pass 406 / # fail 0`.
      all green.

### Phase 4 — behavioural verification (mandatory)

- [x] T8 A scratch hub on a free 8380-8389 port with `ERA_WEATHER_URL` pointed at a fake Open-Meteo
      serving today's real shape (52 at 8, rising to 67 at 13, 65 at 14) and a fixture wardrobe with a
      sweater, a long sleeve, two tees, a tank, pants, fleece pants, shorts, a jacket: the built
      `recipes/today.json` shows the tile `52° → 67°  cool`, page 1 holds no tank, pants outnumber
      shorts, the tops grid leads with the sweater, the jacket grid leads with the warmest jacket.
      Then the same hub with 60 at 8 / 75 at 13: tile `60° → 75°  warm`, shorts on page 1. One
      screenshot of each tile into the scratchpad (not the repo). Kill only the recorded hub pid.
      Scratch hub 8383 + fake forecast 8384, 10-piece fixture (sweater, light long sleeve, two tees,
      tank, light pants, fleece, shorts, coat, shell). 52/67 day: tile `52° → 67°  cool`; page 1 =
      7 pants looks + 1 shorts, no tank (whole deal 12 looks: 4 shorts, 0 tank); tops grid longsleeve,
      sweater, tee1, tee2, tank — the LIGHT long sleeve (67.5) leads at 62, the sweater second (it
      ties the tees at 14 and wins on id); jackets coat, shell. 60/75 day: tile `60° → 75°  warm`;
      page 1 = 4 shorts + 4 pants, 2 tank looks; tops longsleeve, tee1, tee2, tank, sweater; jackets
      coat, shell (the 60 °F morning is cool). Both pids killed by number.
- [ ] T9 Full gate detached (`setsid nohup bash tools/era-gate.sh`), pid recorded, one
      `bash tools/gate-wait.sh <pid> --timeout 570` (again if 124). Tick with the receipt line.

### Phase 5 — ship (on dad's word only)

- [ ] T10 Land (`worktree.sh sync` first if master moved; re-gate; `worktree.sh land`); patch build
      and push to the device dad names; patch release when dad says. None without his word.

## Retrospective

(filled after T9)
