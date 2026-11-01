# Clothing weather sorter — plan

Design: [2026-11-01-clothing-weather-sorter-design.md](../specs/2026-11-01-clothing-weather-sorter-design.md).
Branch `feat/clothing-weather-sorter`, worktree `era-hub--wt-clothing-weather-sorter`, era-hub only.

Sibling worktrees flagged at orientation (clothing-diversity, clothing-page-1, clothing-picker-ui,
long-press-clothing, weather): all five are landed in master and zero commits ahead; nothing in flight
overlaps `clothing-rank.js` or `clothing-worker.js`.

## Tasks (test first)

- [x] T1 `tests/clothing-rank.test.mjs`: a `describe("weatherOrder …")` block per spec §4, written before
      the function exists and failing on `R.weatherOrder is not a function`.
- [x] T2 `clothing-rank.js`: `weatherOrder(items, temp)` beside `accessoryOrder`, exported; T1 green.
- [x] T3 `tests/clothing-weather.test.mjs`: grid-order assertions on the cool and hot window builds
      (spec §4), failing on the current id order first.
- [x] T4 `clothing-worker.js buildCataloged`: the five `cat_*` grids and Dress up go through
      `weatherOrder(…, w ? w.t : null)`; accessory grids keep `accessoryOrder(…, band)`. T3 green.
- [x] T5 Focused run: `node --test tests/clothing-rank.test.mjs tests/clothing-weather.test.mjs
      tests/clothing-fit.test.mjs tests/clothing-accessories.test.mjs tests/clothing-variety.test.mjs
      tests/clothing-diversity.test.mjs` all green.
- [x] T6 Comments in `clothing-worker.js` near `browse()` and in `clothing-rank.js` name the 11/1 ruling;
      README / docs nearest the change updated if they describe the browse grids' order.
- [x] T7 Full gate detached, `gate-wait.sh`: **208 passed, 0 failed** on 8b35c95 (run
      `2026-11-01T20-57-45Z-daa4aee`, stamp `/tmp/era-gate-green/daa4aeeb55543eafce7457bdbd762c56a6f5c2a3`).
- [ ] T8 Land on dad's word; push to a device on dad's word; release on dad's word.

## Retrospective

- The deal was already weather-coherent (9/29 spectrum); the whole gap was the browse grids. The
  orientation question ("sort or filter, which pages, which number") was the right one to ask first.
- The builder caught a wrong premise in the spec (grids were in wardrobe.json order, not id order) by
  running the accessories layout snapshot; the fix was to leave offline boards byte for byte alone.
- One function, one call site, two suites extended, no new suite to register. Gate ran clean first time.
