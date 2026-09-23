# Weather location — a town, not a guess (design)

**Date:** 2026-09-23 · **Branch:** `fix/weather` (era-hub only) · **Unit A of three**
**Origin:** dad, 9/23: *"I've just noticed it's always a lot colder than my weather
reports."* Then, on being shown the cause: *"Except either city or town or zip. That's
how people think."* And: *"I think make the window 10 to 2."*

This is the first of three units split out of the 9/23 weather review. It is small and
it ships first, because it fixes a wrong number the child is dressing by today.

- **Unit A (this spec)** — where the weather comes from, and the one window.
- **Unit B** — the warmth model: coverage + weight on every garment, all categories
  gated, and the layering prompt. Blocked on the dressing-research pass.
- **Unit C** — cross-device convergence for clothing (ownership, the zero-cost heal).
  Blocked on the clothing-sync audit.

## 1. What exists (verified against this tree, 0743331 + fix/weather)

- `clothing-worker.js:1039 weather()` geolocates by IP — `ERA_GEO_URL` if set, else
  `https://ipapi.co/json/` then `https://ipwho.is/` — takes the first answer whose
  `latitude` is a number, then asks Open-Meteo (`ERA_WEATHER_URL`, default
  `https://api.open-meteo.com`) for `hourly=temperature_2m,weather_code`,
  `forecast_days=1`, `timezone=auto`.
- `weatherWindow()` (`:1028`) reads `weatherWindow {from,to}` out of
  `<DATA>/app-settings.json`, requiring integers with `0 <= from < to <= 23`.
  Anything else returns `null`, which means *the whole day* — silently.
- The window is applied at `:1067-1074`: hours inside it, **max** temperature
  (`:1071`) and max `weather_code` (`:1073`). Band thresholds `78/66/54` (`:1077`).
- The result is cached 3 h in `<DATA>/.weather-cache.json`, keyed on the window
  only (`:1041-1045`). `server.js:1549-1560` writes the window and deletes the
  cache when it changes.
- Settings UI: `public/settings/index.html:175-181` (the row) and `:1646-1690`
  (the two selects, "All day" default, `to` forced forward of `from`).
- The tile is built at `clothing-worker.js:1293-1305`: label `"72°  warm"`, a
  `say` line naming the hours, and a footnote `"for 10 AM-2 PM · updated <when>"`.

### The evidence that prompted this

Read off both live devices on 9/22-9/23:

- `ipapi.co` answers `{"error":true,"reason":"RateLimited"}` on **both** devices, so
  every lookup falls through to `ipwho.is`, which returns **37.7749, -122.4194** —
  a **city centroid** — an ISP-level guess, not a position. The family does not live
  at that point; it sits in a materially different microclimate from theirs, which is
  what makes the error systematic rather than noisy.
- The tablet's cached temperature and band for 9/22 reproduce **exactly** from that
  centroid over its 10-14 window. The fetch is correct; the input is wrong.
- Over 9/12-9/22 the tile was colder than the family's real daily high **11 days out
  of 11, never once warmer** — mean 4.3 °F, worst 11 °F. ~80 % of the gap is the
  location; the window accounts for ~0.5 °F/day and was never the culprit.
- On 9/22 the error crossed a band boundary (`cool` where the truth was `warm`).
  Per the gate probe on her real 57 garments that single flip cuts her from 17
  eligible bottoms to **2**, and fills the rest of the board with dresses.
- The two devices were running **different windows** — tablet 10-14, i13 10-13 —
  so they disagreed with each other as well as with the sky (65° vs 63°).

## 2. Goals / non-goals

**Goals.** (a) A parent types a town or a ZIP once and the hub uses that point from
then on. (b) Both devices use 10 AM - 2 PM. (c) The tile says which place and which
hours it is talking about, so a wrong answer is visible instead of silent.

**Non-goals.** A different weather provider. GPS or per-device locations. Anything in
the warmth model or the gate (unit B). Making settings themselves sync between
devices (unit C) — for this unit the location is set on each device, which for two
devices is two ssh calls and gets the fix out today.

## 3. Design

### 3.1 The stored location

`<DATA>/app-settings.json` gains one optional object, written only by the route below:

```json
"location": { "q": "12345", "name": "Springfield", "admin1": "Illinois",
              "country": "US", "lat": 39.7817, "lon": -89.6501,
              "at": "2026-09-23T04:11:02.000Z" }
```

(Example values. The family's own town, ZIP and coordinates are family config and
never appear in this repo — they live in `<DATA>/app-settings.json` on the devices
and in the private session memory, per the era-scan rule.)

`q` is what the parent typed, kept so the box can show it back. `name`/`admin1` are
what the tile and Settings display. `lat`/`lon` are what the forecast uses. Absent =
fall back to the IP lookup exactly as today, so a first run still works untouched.

### 3.2 Geocoding — Open-Meteo's own, keyless

`https://geocoding-api.open-meteo.com/v1/search?name=<q>&count=5&language=en&format=json`
— same provider as the forecast, no key, no new dependency, and it resolves a
**ZIP as well as a name**. Checked 9/23 against the family's own town and ZIP (not named here): each resolved to
the same single point, the town as the top hit. An ambiguous name is why the picker
shows a list rather than taking the first hit — `Springfield` returns Missouri,
Illinois, Massachusetts and Ohio, population-ranked.

A new seam `ERA_GEOCODE_URL` joins `ERA_WEATHER_URL` and `ERA_GEO_URL` so the suite
never touches the network. Same shape as its two siblings; add it to the seam list in
`docs/` wherever those two are named.

The hub proxies it rather than letting the Settings page call out directly, so there
is one place that owns the timeout, the error wording and the seam:

```
GET /weather/search?q=<text>   ->  200 {results:[{name,admin1,country,lat,lon}, …]}
                                   200 {results:[]}          nothing matched
                                   503 {error:"offline"}     the geocoder did not answer
```

Read-only, no body, no `ownDoor` gate (it reveals nothing the device does not already
send to the same host). At most 5 results; 4 KB response ceiling.

```
POST /settings {location:{…}}  ->  stores it, or {error} on a malformed body
POST /settings {location:null} ->  clears it, back to the IP guess
```

Validation mirrors `weatherWindow`'s: `lat` and `lon` finite numbers in range,
`name` a string of 1-64 chars, everything else dropped. A malformed field costs that
field, never the whole setting — the house rule from `clothing-log normalizeTag`.

### 3.3 `weather()` uses it

```
const loc = settings.location;
const point = loc ? {lat: loc.lat, lon: loc.lon} : await ipLookup();
```

The IP lookup keeps both providers and its 6 s timeouts, and is reached **only** when
no location is stored. One behaviour change beyond that: a geo answer is accepted only
if `latitude` AND `longitude` are both finite (today `:1054` checks latitude alone).

### 3.4 The cache key gains the location — and the day

Today the key is the window alone (`:1041`). It must become the window, the location
**and the local day**:

```
key = `${loc ? loc.lat.toFixed(3)+","+loc.lon.toFixed(3) : "ip"}|${win ?? "all"}|${dayKey(now, tz)}`
```

The location half is obvious — moving the point makes a cached answer an answer to a
different question, exactly as changing the window does, and `server.js` already
deletes the cache when the window changes (extend that to the location).

The **day** half is a latent bug this unit should close while it is in here. The cache
holds for 3 h with no day in the key, and `forecast_days=1` always means *today*. A
build between local midnight and ~03:00 that follows an evening build therefore serves
**yesterday's** window — the board would be sorted for a day that has ended. The 5 AM
cutoff in `clothing.js:454 boardIsFresh` makes the ordinary morning build a fresh fetch,
so this is narrow, but a photo-change or a restart in that gap reaches it.

### 3.5 The window: 10 AM - 2 PM

The default for an unset window becomes `{from:10, to:14}` instead of "all day".
Rationale in one line in the code, without the family's hours in prose (the 9/5 rule,
commit `687bcd3`): *a child dresses for the middle of her day, not for the afternoon
high.*

The two devices already carry explicit values (10-14 and 10-13), and a default does not
touch an explicit value. **This is a deployment step, not a migration** — rewriting a
setting a parent chose would be a surprise. Both devices get `POST /settings` by hand
when the patch lands, and the spec records that they were set, not defaulted.

`from < to` stays as it is. A one-hour window and an overnight window remain rejected;
what changes is that rejection is no longer silent (§3.6).

### 3.6 The tile tells the truth

Three changes to the tile built at `:1293-1305`:

1. The footnote names the **place**: `"<Town> · for 10 AM-2 PM · updated Tue, Sep 23 5:07 AM"`.
   When the location came from the IP guess it says `"approximate location"` instead of
   a town — so the state that caused this whole investigation is visible on the board
   rather than invisible in a cache file.
2. The `say` line is unchanged in shape; it gains the town only if one is set.
3. The symbol mapping at `:1078` is wrong above code 67 and is fixed here because it is
   two lines and it is a lie on the tile today:

   | codes | today | should be |
   |---|---|---|
   | 0-1 | `sun` | `sun` |
   | 2-48 | `cloud` | `cloud` |
   | 51-67, 80-82 | `cloud` / `cold` | `rain` (ARASAAC **3123**, checked 9/23) |
   | 71-77, 85-86 | `cold` | `cold` |
   | 95-99 | `cold` | `rain` |

   Note the existing `max(weather_code)` is not a severity ordering (fog 45 loses to
   drizzle 51; snow 71 loses to rain showers 80). Fixing the ordering properly is
   unit B's business, where precipitation may earn a place in the deal. Here the
   mapping is corrected so a rainy day stops reading as a cold one; the code that
   picks *which* hour wins is left alone.

### 3.7 Settings UI

The existing weather row grows a location control above the two hour selects:

```
Where you are        [ <Town>, <State>            ] [ Change ]
Dress for the weather between  [10 AM] and [2 PM]
```

`Change` turns the label into a text box ("Town or ZIP"). Typing and submitting calls
`GET /weather/search`; matches render as a short tap list of `Name, Admin1, Country`;
tapping one POSTs it and collapses back to the label. Empty results say *"No town by
that name — try a ZIP code."* A 503 says *"Could not reach the lookup — check the
connection."* With nothing stored the label reads *"Guessing from the network"* and is
styled as a warning, because that is what has been wrong.

No dwell targets, no gaze path: this is the parent's Settings page, standing footers
measured per the 9/14 rule.

## 4. Testing

New suite `tests/weather-location.test.mjs`, with `ERA_GEOCODE_URL` and the existing
`ERA_WEATHER_URL` / `ERA_GEO_URL` seams pointed at one local stub server, the way
`clothing-weather.test.mjs` serves both seams off a single fake.

**Port 8401.** Not 8380-8389 — that band is for *manual* hubs (`docs/dev-flow.md:24`),
not suites, and an earlier draft of this spec had it wrong. Surveyed 9/23 across all
five repos' `tests/`: 8390-8451 is otherwise solid, and the forbidden set is
8377/8378/8425/8427/8450-8462. Free and unclaimed anywhere in any repo: **8401** and
8426. Taking 8401; 8426 is the spare if unit B or C needs one.

1. A stored location is what the forecast is asked for — the IP lookup is never called.
2. No stored location falls back to the IP lookup, both providers in order.
3. A geo answer with a numeric `latitude` but no `longitude` is refused (today it passes).
4. The cache is re-read within 3 h for the same location+window+day.
5. Changing the location makes the cached answer stale, like changing the window does.
6. **A cached answer from yesterday is stale even inside 3 h** (the §3.4 bug — this
   test fails before the fix).
7. `GET /weather/search` returns at most 5 results; a geocoder that does not answer is
   a 503, not a crash, and the stored location survives it.
8. `POST /settings {location}` validates: a non-finite lat, a 200-char name and a
   missing lon each cost their field, and a malformed location never clears a good one.
9. The tile footnote names the town when one is set and says "approximate location"
   when it is not.
10. Code 80 and code 95 both map to `rain`; 71 stays `cold`; 1 stays `sun`.
11. The default window for an unset `weatherWindow` is 10-14, and an explicitly stored
    window is not rewritten by the upgrade.

Existing suites that must stay green untouched: `tests/clothing-weather.test.mjs`
(the window arithmetic and both-ends-inclusive rules are unchanged),
`tests/settings-ui.test.mjs`, `tests/routes.test.mjs`.

## 5. Risks

- **The geocoder is a new outbound dependency.** Mitigated: it is called only when a
  parent presses Change, never on the build path, and a stored location needs no
  network at all afterwards. A dead geocoder cannot stop the board being built.
- **A parent picks the wrong Springfield.** Mitigated by showing state and country in
  the list, and by the tile footnote naming the town every day thereafter.
- **A family that moves.** Out of scope; the label is right there in Settings.
- **The 5 AM cutoff interacts with the new day-keyed cache.** Covered by test 6.

## 6. What this unit deliberately does not fix

The gate itself. With the correct location the band will be right, but on a warm day
the gate still admits every garment she owns, on a hot day it still offers a sweater
because tops are never gated, and on a cool day it still leaves her two bottoms out of
seventeen. That is unit B, and it is the larger half of the 9/23 review.
