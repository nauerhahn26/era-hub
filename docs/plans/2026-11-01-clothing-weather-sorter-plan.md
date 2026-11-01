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
- [ ] T7 Full gate detached, `gate-wait.sh`; stamp recorded here.
- [ ] T8 Land on dad's word; push to a device on dad's word; release on dad's word.

## Retrospective

(filled at close)
