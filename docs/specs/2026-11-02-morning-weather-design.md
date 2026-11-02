# Clothing Picker — the morning counts (design)

**Date:** 2026-11-02 · **Branch:** `feat/clothing-morning-weather` (era-hub only) ·
**Amends:** `2026-09-23-warmth-model-design.md` §4 (the planning temperature), `2026-09-17-accessories-design.md` §4.1 (accessoryOrder's band)

**Origin:** dad, 11/2, after a morning in the low 50s that reached 67 by midday:

> *"The clothing picker needs to consider the morning weather somehow. … low 50s but will get to 67 as a
> max during 10-2p, would you send your 7 y old to school in shorts? A tank top? No. You'd do pants and
> maybe a t-shirt / long sleeve, knowing you might be a bit warmer by end of day. … In summer I don't
> want it to never offer warm weather clothes, cause obviously if it starts at 60 and gets to 75 that's a
> very different day."*

## 1. What the board does today (verified against master 53491d8)

- `readWindow` (`clothing-worker.js`) reads one number out of the forecast: the **warmest hour** of the
  window she is out (default 10 AM–2 PM). That is the planning °F. The band word (hot ≥ 78 / warm ≥ 66 /
  cool ≥ 54 / cold) is derived from it. Nothing else about the day is read.
- The deal's shares (`sharesAt`) and the fit rank, the browse-grid order (11/1) and the accessory order
  (by band) all follow that one number.
- The 9/23 spec §4 recorded dad's rule then: *"if the day is going to go from 55 to 72 … we plan for
  72"*, because she cannot take a layer off herself. The spec also defined a `lowTemp` (the window's
  minimum) and a jacket prompt (§5) that were never built.
- On 11/2 the forecast read 67 at the window's warmest hour → "warm" → tees 65 %, long sleeves 29 %,
  tanks 5 %, shorts 34 %. The morning was 52.

## 2. What the research says

- **Building-science clothing models predict what people wear from the early-morning outdoor
  temperature, not the day's high.** Schiavon & Lee (2013, *Building and Environment* 59; UC Berkeley
  preprint) fitted clothing insulation to 6,333 ASHRAE field observations and found the 6 AM outdoor
  temperature the best single predictor (r = 0.45; the 3 PM maximum and the daily mean were tried and
  correlate less). Their model is the informative clothing-prediction appendix of ASHRAE Standard 55:
  `clo = 10^(−0.1635 − 0.0066·t₆ₐₘ)` for 5–26 °C. People dress once, in the morning, for the morning.
- Morgan & de Dear (2003, *Climate Research* 24) found day-to-day clothing in a Sydney mall tracked the
  **daily mean** outdoor temperature (R² = 0.52), again not the maximum.
- Parent and school guidance (layering guides, school-nurse advice) says the same in plain words: dress
  for the morning, add a layer that can come off; shorts only when the morning is mild.
- Against that, the 9/23 spec's reason still holds: **she cannot shed a layer**, so a rule that dresses
  her for 52 on a 67 day leaves her over-dressed all afternoon. Dad's two examples bracket the answer: the
  52→67 day is pants + tee/long sleeve; the 60→75 day must still offer shorts and tees.

## 3. Decision

**Two numbers from the forecast, one planning °F between them, leaning to the high.**

- `morning` = the forecast temperature at the hour she leaves the house (default **8 AM**; a Settings
  knob "She leaves the house at", stored beside the window, clamped to the window's start when the
  window starts earlier).
- `high` = the warmest hour of the out window, as today.
- **planning °F = round(morning / 3 + 2 · high / 3)** — two thirds of the way to the high. Dad, 11/2,
  on the midpoint first proposed: *"planning for the midpoint is gonna leave her in too warm of clothes
  on a regular basis. Try maybe 2/3 to max."* The band word, the deal, the fit rank and the browse grids
  all read it exactly as they read the warmest hour today. The 5 % share floor and everything else in
  the ranking stay as they are.
- **Jackets follow the morning.** The accessory grids (jackets first among them) are ordered by the band
  of the **morning** temperature, not the planning °F: a jacket is for leaving the house. Shoes and the
  rest follow the same rule; it is one band word for all accessories, as today.
- **The tile says both numbers.** Label `52° → 67°  cool`, spoken *"This morning it is about 52 degrees,
  warming to 67. Dress for cool."* The footnote keeps place, hours and the fetch time. With no separate
  morning read (window starts at or before the leave hour, or the hour is missing from the series) the
  tile reads as today.

What the rule deals on dad's days (tops · legs shares; the deal is 8 + 7 + 7 looks):

| day | today's rule (high) | 2/3 to the high |
| --- | --- | --- |
| 11/2: 52 → 67 | 67 warm: tee 65 % long 29 % tank 5 % · shorts 34 % | **62 cool: long 57 % tee 43 % · shorts 15 %** |
| 9/23 example 55 → 72 | 72 warm: tee 73 % tank 15 % long 12 % · shorts 61 % | 66 warm: tee 64 % long 36 % · shorts 29 % |
| summer 60 → 75 | 75 warm: tee 68 % tank 25 % · shorts 75 % | 70 warm: tee 72 % long 18 % tank 10 % · shorts 50 % |
| hot 65 → 85 | 85 hot: tank 76 % · shorts 100 % | 78 hot: tee 59 % tank 41 % · shorts 85 % |
| winter 45 → 60 | 60 cool: long 67 % tee 33 % · shorts 10 % | 55 cool: long 86 % tee 14 % · pants 100 % |
| fall 48 → 70 | 70 warm: tee 72 % · shorts 50 % | 63 cool: long 51 % tee 49 % · shorts 18 % |

**The shorts that remain.** At 62 the curve still gives shorts 15 % — about three looks in the 22 dealt,
one of them on page 1 — on the 11/2 day. That is the price of the lean; the midpoint (60) would have
removed them and dad judged it too warm elsewhere. The one lever if he wants them gone is the share
floor (`SHARE_FLOOR`, 5 % since 9/29): at 16 % the 11/2 day deals no shorts and the hot day deals no
pants; the winter day loses its tees. Not moved here; noted for his call after he sees a week of boards.

**Why not the morning alone** (the research's number): it makes the 60→75 day a 60 day — pants 90 %,
no tanks, long sleeves leading — dad's "never offers warm weather clothes".

### What this does NOT do

- No jacket prompt on Yes, no `layer_<i>` board (9/23 §5). A second unit once the number is right.
- No "feels like" (wind, sun, humidity). Open-Meteo offers `apparent_temperature`; noted, not taken.
- No change to the fit table, the curve's crossovers (63 / 70 / 80) or `weatherOrder`.
- Offline (no forecast at all): as today, no tile, nothing gated.

## 4. Design

- `readWindow(hourly, day, win, leaveAt)` returns `{t, band, symbol, morning, high}`: `high` as the
  warmest hour now; `morning` the temperature at `leaveAt` on that day (null when absent); `t` =
  `planningTemp(morning, high)` (a pure function in `clothing-rank.js`: round(m/3 + 2h/3), or `high`
  alone when `morning` is null); `band` from `t`; a new `morningBand` from `morning`.
- `leaveAt` read from `app-settings.json` next to `weatherWindow` (`weatherLeaveAt`, integer 0–23,
  default 8, clamped to `win.from`); `server.js` validates and stores it the way it does the window and
  deletes the stored week when it changes, as the window does.
- `buildCataloged`: `accessoryOrder(items, w.morningBand || w.band)`; the tile label/say/footnote as §3.
- Settings: one select "She leaves the house at" beside the window row; the toast re-sorts.
- Both devices read the same two numbers from the same series, so they agree (W1 convergence).

## 5. Testing

- `tests/clothing-rank.test.mjs`: `planningTemp(morning, high)` → 62 for 52/67, 70 for 60/75, `high`
  when `morning` is null; the floor stays 0.05 (pinned as today).
- `tests/clothing-weather.test.mjs` (fake forecast, 8446): a 52-at-8 / 67-at-noon series builds a board
  with `w.t` 62 and band `cool` whose tile reads `52° → 67°  cool`, with the sweater before the tees in
  the tops grid; a 60 / 75 series reads 70 `warm`; a series missing hour 8 falls back to the warmest hour
  (67, as today); a `weatherLeaveAt` of 10 with a window from 10 reads morning = hour 10; the jacket
  grid is ordered by the morning band on the 52 / 67 day.
- `tests/clothing-fit`, `clothing-variety`, `clothing-diversity`, `clothing-accessories`, the harness
  sweep (`tools/clothing-*`) re-run; the harness thresholds are dad's words and stay.
- Settings suite: the knob round-trips and a change deletes the stored week.

## 6. Decided

- 2/3 to the high (dad, 11/2). The midpoint was offered first and refused as too warm on a regular basis.
- Leave-the-house hour: 8 AM default, a Settings knob.
- The 9/23 "plan for 72" ruling is amended: that day now reads 66, tees with a bit under a third shorts.
- Share floor stays 5 %; the 16 % lever is recorded above for after a week of real boards.
