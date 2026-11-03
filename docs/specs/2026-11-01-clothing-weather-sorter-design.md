# Clothing weather sorter — every browse grid follows the weather (design)

**Date:** 2026-11-01 · **Branch:** `feat/clothing-weather-sorter` (era-hub only) ·
**Amends:** `2026-09-29-warmth-coherence-and-dress-up.md` §2 (the deal), `2026-09-17-accessories-design.md` §4.1 (accessoryOrder)

**Origin:** dad, 11/1, after a cool morning:

> *"On a cold day, or it should basically just use the weather, whether you're picking out a t-shirt or
> whatever you're picking out, all of the clothes, it should sort them based on the weather. So like today
> was cool, her first options when she went to top was all t-shirts, so that doesn't make sense. Doesn't
> need to be perfect, but should be coherent to the weather."*

## 1. What the board does today (verified against this tree, e3d045a)

- The suggested-outfit pages (`today`, `today_2`, `today_3`) are apportioned and ranked by the planning °F
  — the warmest hour of the window she is out — through the 9/29 spectrum (`clothing-rank.js sharesAt`,
  `quotasFor`, `fitPts`). They are already coherent with the weather.
- The accessory grids (`acc_jacket`, `acc_shoes`, …) are reordered by the day's band word
  (`accessoryOrder`): on a cold morning the coats lead. Nothing is hidden.
- The five garment browse grids behind Full wardrobe — `cat_top`, `cat_pants`, `cat_shorts`, `cat_dress`,
  `cat_outfit` — are in **catalogue order** (wardrobe.json's own order, which is the photo names; the Dress
  up page is by id) and never read the weather (`clothing-worker.js buildCataloged`, the `browse(cat)`
  filter straight into `gridPages`). Her tees and her sweaters sit in whatever order their photo names
  sort, eight to a page. That is the morning dad saw.

## 2. Decision

**Every garment grid is sorted by the same planning °F the deal uses.** Nothing is filtered; the weather
only decides the order, exactly as it does for accessories (spec 9/17 §4.1, "never weather-hidden").
A grid's page 1 is then the eight garments that fit the day best, and the rest follow on More.

The sort key is already in the code: each garment's FIT centre(s) (`clothing-rank.js FIT`, read through
`fitAttrs` / `rowsOf`), the °F it is best at. A garment's **distance** is the sum over its rows of
`|temp − centre|`: one row for a top, pants or shorts; two for a dress or set (its top half and its legs,
the same two rows `fitPts` already scores a single by). Smaller distance leads; ties break by id, so two
devices lay the grid out the same way (W1).

What that gives on a cool 58 °F morning, tops grid: mid long sleeves (centre 52) first, light long sleeves
(67.5), then tees (76), then tanks (90) last. On an 85 °F morning the same grid reverses. Pants and shorts
grids are single-coverage, so inside them the weight orders (fleece before light pants when cold, the
reverse when warm). Dresses and sets: a covered long-sleeve dress leads when cold, a sundress when hot.
Because the deal's fit term reads the same table, a garment that leads its browse grid is the one the deal
would have ranked first inside its kind: one rule, two doors.

**Weather offline (no planning °F): the grids exactly as today.** The worker asks `weatherOrder` only when
it has a planning °F, so an offline board is byte for byte the board it was (the `cat_*` grids in
wardrobe.json order, Dress up by id). The function itself answers id order for a missing temperature, the
rule `accessoryOrder` keeps for a missing band. (Builder's correction, 11/1: the first draft of this spec
called today's grid order "by id"; it is not, and sorting by id offline would have reshuffled every
offline grid and broke the accessories suite's layout snapshot.) A garment refit has not reached is placed
by the legacy fallback (`fitAttrs`, spec 9/29 §2 D1), as the deal places it.

### What the rule does NOT touch

- The suggested-outfit pages, their quotas and ranking (spec 9/29 §7): unchanged, byte for byte.
- The accessory grids: still `accessoryOrder` by band. (A jacket's FIT row exists only for its weight;
  the band rule is the one the 9/17 spec pinned and dad has not asked to change it.)
- The Dress up page: it is a `gridPages` over fancy garments **and** fancy accessories. Garments on it
  sort by the same distance; its accessories (no FIT row) follow after the garments, in id order. Dad's
  "all of the clothes" reaches it; the cost is nil.
- The `choose_bottom` menu, Full wardrobe menu, confirm pages, Back/More/Full wardrobe doors: unchanged.
- The board front end (era-board): nothing to change, the recipe's order is what it renders.

## 3. Design

One pure function in `clothing-rank.js`, next to `accessoryOrder`:

```
weatherOrder(items, temp) → items sorted
```

- `temp` not a finite number → `[...items].sort(byId)`.
- Otherwise each item's distance is `rowsOf(fitAttrs(item))` summed as `|temp − centre|`; an item with no
  fit rows (an accessory, an unknown category) gets `Infinity`; sort by distance, then `byId`.
- Never mutates its input; `undefined` / `[]` → `[]` (as `accessoryOrder`).

The worker (`buildCataloged`) passes `w ? w.t : null` — the same `temp` it hands `buildCandidates` —
to every `cat_*` grid's item list and to the Dress up list; `accessoryOrder` keeps the band.

## 4. Testing

- `tests/clothing-rank.test.mjs`: `weatherOrder` — at 58 °F a mid long sleeve leads a light long sleeve
  leads a tee leads a tank; at 85 °F the reverse; pants: fleece before light at 50, light before fleece
  at 72; a covered long-sleeve dress before a sundress at 55 and after it at 88; a legacy-word garment
  (no coverage, `warmth: "cool"`) sorts as a long sleeve; `temp` null / undefined / NaN → id order; an
  accessory in the list sorts last, by id; the input array is not mutated.
- `tests/clothing-weather.test.mjs` (the fake-forecast suite, port 8446): after a cool window build, the
  `cat_top` grid's first tile is the long sleeve and the tank is last; after a hot window build the order
  flips; the `cat_pants` grid puts light pants before fleece on the hot build. The tests read
  `recipes/today.json` as the existing ones do.
- Existing suites (`clothing-fit`, `clothing-variety`, `clothing-diversity`, `clothing-accessories`) must
  stay green untouched: the deal and the accessory grids do not change.

## 5. Risks

- A wardrobe with no fit words at all (never refit, pre-9/29 tags) sorts by the legacy fallback, which was
  right for 59 of her 63 on 9/29. "Doesn't need to be perfect."
- Weather offline leaves the grids as they are today. The 10/10 ladder (three rungs and the stored week)
  makes that rare.
