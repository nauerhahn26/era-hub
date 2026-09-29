# Warmth coherence + Dress up — execution plan

**Spec:** `docs/superpowers/specs/2026-09-29-warmth-coherence-and-dress-up.md` (amends `2026-09-23-warmth-model-design.md`)
**Worktrees:** `era-hub--wt-weather` and `era-board--wt-weather`, both `fix/weather`. Gate: `ERA_WT_SUFFIX=--wt-weather tools/era-gate.sh`
under `setsid nohup` with a `.done` sentinel (the full gate outruns the 10-minute tool ceiling).
**Discipline:** TDD every task (failing test first, then the code); Opus agents build, the lead reviews at each
phase gate; no "while I'm here" changes; STOP and report when a threshold in spec §2 cannot be met without an
indefensible table row, or when a test outside this plan starts failing.

## Preflight (validated 9/29 against the tree)

- `clothing-rank.js` is pure and takes `band`; `clothing-worker.js buildCataloged` (`:1290-1327`) is the one
  caller and already has `w.t`. `accessoryOrder` and the tile keep reading `band` — untouched.
- The door: `buildCandidates` `:434` filters `hidden` and accessories; `occasion` is nowhere in the deal.
- Ingest parser `clothing-worker.js:891-895` validates `category`/`occasion`/`warmth` by list — the three
  new fields go the same way. Prompt text `:437-446`. `attributes(meta)` in clothing-rank carries the
  descriptive fields.
- `manualFields` `:982-988`, `applyManual` `:989`; `normalizeTag` `clothing-log.js:268`; `/clothing/item`
  `server.js:2893-2935` (own-door, one-sentence refusals, `fields` by list).
- The 9/5 needs-attributes pass `clothing-worker.js:593-757` is the shape for refit (spacing
  `ATTRS_SPACING_MS`, `ATTRS_MAX_MISSES`, `tagsFor` first, `shareTag` after a real answer).
- Recipe: `kinds`/`present`/`acc` menu `:1436-1487`, `gridPages` `:1241`, `itemRef` `:1215`.
- era-board hold sheet: `board-edit.js:275-379` (rows, Fancy toggle at `:319`, body at `:379`).
- Fixture `tests/fixtures/wardrobe-shape.json` exists (63 items, her shape, coverage truth from names).
- Tests that change meaning: `tests/clothing-weather.test.mjs:291` and `:306`.
- Free ports 8452–8457. Tunnels 8500+, scratch hubs 8480+.

## Phase 1 — the model in clothing-rank.js (posture: implementing)

1. `FIT` table + `fitOf(item)` → `{lo, hi, centre}` for every `(role, coverage, weight)`; open ends
   `-Infinity`/`Infinity`, centre = closed end + 10. Legacy fallback (`spec §2 D1`) when `coverage` is absent.
   `unsure`/missing weight → modal weight for the row, biased light. Test: the table is total over the
   fixture's every `(category, coverage, weight)`; fallback maps each warmth word as specced.
2. `eligible(items, cat, temp)`: inside `[lo, hi]` or within `EDGE` **below** `lo`; never above `hi`;
   `temp == null` gates nothing; the widening floor keeps its spirit (fewer than a page → widen the cold-side
   edge, then deal the whole category). Test: 8 °F under admits (ranked last), 1 °F over excludes.
3. `rankOf` gains `fit` (`FIT_PTS_PER_DEG`); `ctx.temp`. Test: two looks equal on freshness order by distance.
4. The door drops `occasion === "fancy"`. Test in clothing-rank.test.mjs.
5. `buildCandidates(opts.temp)`; keep accepting `opts.band` for nothing but the offer record. Update the port
   note at the head of the file: tops ARE gated now (dad 9/23, 9/29).
   Verify: `node --test tests/clothing-rank.test.mjs`.

## Phase 2 — the harness (posture: implementing, STOP rule above)

1. `tools/clothing-simulate.mjs`: exports `simulate({items, temps, seed, stripFit})` → per-temp
   `{admitted:{top,bottom,single}, looks:[{pieces, sleeves, legs}], verdicts}`; CLI as spec §2 D2 prints a
   table. Reads a `wardrobe.json` (`{items}`) or the fixture.
2. `tests/clothing-fit.test.mjs`: the §2 threshold table over 40–100 in steps of 2, both modes, plus
   `seed` varied over seven consecutive days so a lucky day cannot pass it.
3. Tune `FIT` rows / `EDGE` / `FIT_PTS_PER_DEG` until green; record the final table and each moved row's
   reason in the code comment. Do NOT loosen a threshold to pass — STOP and report instead.
   Verify: `node --test tests/clothing-fit.test.mjs tests/clothing-rank.test.mjs` and
   `node tools/clothing-simulate.mjs --wardrobe tests/fixtures/wardrobe-shape.json --temps 58,72,81`.
   **Gate 1 (lead review):** the table reads as defensible; the 81 °F sweep shows what dad asked for.

## Phase 3 — hub wiring (posture: implementing)

1. Ingest prompt asks `coverage`, `legs` (dress/set) and `weight` (long tops + jackets only, `unsure`
   allowed); parser validates by list; `attributes()` / `shareTag` / `normalizeTag` carry them.
2. `buildCataloged` passes `temp: w ? w.t : null` (band still to the tile/offer).
3. `manualFields` + `/clothing/item` accept `coverage`/`weight`/`legs` (refusals in a parent's words).
4. Refit: `POST /clothing/refit` (own-door, 202, `refit` in `/clothing/status`) → worker pass modelled on
   the attrs pass: `fitAt` one-way, `fitTriedAt` daily, shared log first, spacing, two-miss stop, rebuild
   after. Nothing else ever triggers it.
5. Dress up: virtual kind in `present`/`kinds` when a fancy item with a tile exists; `acc_fancy` via
   `gridPages`; fancy items out of `cat_*` grids; symbol per spec D3.
6. Invert `clothing-weather.test.mjs:291, :306`; extend accessories/item/status suites per spec §4.
   Verify: `node --test tests/clothing-*.test.mjs tests/weather-location.test.mjs`.
   **Gate 2 (lead review).**

## Phase 4 — era-board hold sheet (posture: implementing; parallel with 3 after Gate 1)

1. `board-edit.js`: Sleeves row (tops/dresses/sets), Legs row (dresses/sets), Weight row (long-sleeve tops,
   jackets); posts `coverage`/`legs`/`weight` only when changed, like Fancy/Hide.
2. era-board tests beside the existing edit-sheet ones (its suite loads the page from 8377 — run through the
   gate with `ERA_WT_SUFFIX`, see memory `board-suites-load-page-from-8377`).
   Verify: gate run. **Gate 3 (lead review).**

## Phase 5 — behavioural verification (mandatory)

1. Full gate green under `ERA_WT_SUFFIX=--wt-weather`.
2. Scratch hub (8480+) over a copy of the tablet's real `wardrobe.json` + tiles, `ERA_WEATHER_URL` stubbed to
   81 °F then 58 °F → `today.json` inspected: 81 → zero long sleeves, ≤ 3 leggings looks, no fancy dress;
   58 → no shorts, long sleeves lead; Accessories menu shows Dress up with the three fancy dresses.
3. `node tools/clothing-simulate.mjs --wardrobe <tablet copy> --temps 58,72,81 --strip-fit` and without.
4. Land (merge-only master, gate line in the message), unsigned patch via `push-device.sh` to the tablet and
   i13; on the tablet: `POST /clothing/refit`, wait for `refit.pending = 0`, `POST /clothing/regenerate`;
   confirm `today.json` on both devices and that the i13 spent nothing (its `wardrobe.json` gains `coverage`
   from shared lines, `fitAt` only where a line existed).
