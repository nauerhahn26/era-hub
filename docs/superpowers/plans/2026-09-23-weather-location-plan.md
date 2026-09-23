# Weather location — implementation plan (unit A)

**Spec:** `docs/superpowers/specs/2026-09-23-weather-location-design.md`
**Branch:** `fix/weather` (era-hub only — no era-board change in this unit)
**Date:** 2026-09-23

TDD throughout: the test comes first and must **fail for the right reason** before any
implementation. Gate in the FOREGROUND in this worktree. Never restart live 8377.
Test port **8401** (surveyed free across all five repos, 9/23).

## Preflight — validated against the tree, not assumed

| Check | Result |
|---|---|
| `POST /settings` shape | **PASS.** `server.js:1530-1575` is a chain of `if (typeof inc.X …)` validators over `app-settings.json`, then side effects. `location` slots in beside `weatherWindow` with no restructuring. |
| Cache-invalidation precedent | **PASS.** The window already does exactly what location needs (`server.js:1559-1561`): compare before/after, `rmSync` the cache, `clothing.rebuildToday()`. Copy it. |
| Seam pattern for tests | **PASS.** `clothing-weather.test.mjs:80-100` points `ERA_GEO_URL` and `ERA_WEATHER_URL` at ONE fake server. `ERA_GEOCODE_URL` joins them on the same fake. |
| Settings UI pattern | **PASS.** `public/settings/index.html:1646-1690` (`wxPaint`/save) is the local idiom to follow. |
| Test port band | **FAIL, caught and fixed.** The spec said 8380-8389; that is the *manual hub* band (`dev-flow.md:24`). Corrected to 8401. |
| Worker reads settings | **INFO.** `clothing-worker.js:1028-1036` reads `app-settings.json` off disk directly, not through a settings module. `location` is read the same way — no new plumbing, but the worker must tolerate a malformed file exactly as `weatherWindow()` already does (bare `try/catch`, fall back). |
| `dayKey` availability in the worker | **INFO.** `clothing-rank.dayKey(now, tz)` is already required in the worker and `workerData.tz` is populated (`clothing.js:375-376`). The cache key can use it with no new import. |

No blockers.

---

## Phase 1 — the cache key (smallest, highest-confidence, no new surface)

**Posture hint:** implementing. Pure function change, unambiguous, fully covered by tests.

1. **T1.1** Write the failing test: a cached answer stamped yesterday is stale inside
   3 h. Assert the forecast is re-fetched (the fake's `asks` array grows).
2. **T1.2** Write the failing test: same day + same window + same point inside 3 h is
   served from cache (`asks` does NOT grow) — the existing behaviour, pinned so the
   next change cannot silently break it.
3. **T1.3** Make both pass: the cache record gains `day`, and the key becomes
   `point|window|day`.

**Verify:** `node --test tests/weather-location.test.mjs` — 3 pass.
**Gate:** stop if the existing `clothing-weather.test.mjs` goes red; it pins the window
arithmetic and must not move in this phase.

---

## Phase 2 — the stored location and the forecast point

**Posture hint:** implementing.

4. **T2.1** Failing test: with `location` in `app-settings.json`, `/v1/forecast` is asked
   for those coordinates and the geo seam is **never** hit.
5. **T2.2** Failing test: with no `location`, the IP lookup runs, both providers in order.
6. **T2.3** Failing test: a geo answer carrying a numeric `latitude` but no `longitude`
   is refused and the second provider is tried. (Today `clothing-worker.js:1054` checks
   latitude alone — this fails before the fix.)
7. **T2.4** Implement: `locationOf()` beside `weatherWindow()`, same defensive read;
   `weather()` takes the stored point when present.
8. **T2.5** Failing test then implement: the default window for an absent
   `weatherWindow` is 10-14, and an explicitly stored `{from,to}` is **not** rewritten.

**Verify:** `node --test tests/weather-location.test.mjs tests/clothing-weather.test.mjs`
**Gate:** `clothing-weather.test.mjs` must stay green — it sets an explicit window, so
the new default must not perturb it. If it goes red, the default is leaking into the
explicit path.

---

## Phase 3 — the geocoder route

**Posture hint:** implementing.

9. **T3.1** Failing test: `GET /weather/search?q=…` returns at most 5 normalised
    `{name, admin1, country, lat, lon}`.
10. **T3.2** Failing test: a geocoder that does not answer is a **503**, not a throw,
    and any already-stored location survives it untouched.
11. **T3.3** Failing test: nothing matched is `200 {results:[]}`, not 404 — the UI
    needs to tell those apart to word its message.
12. **T3.4** Implement the route with `ERA_GEOCODE_URL`, a 6 s `AbortSignal.timeout`
    matching the two existing lookups, and a 4 KB ceiling.
13. **T3.5** Failing test then implement: `POST /settings {location}` validates
    per-field — a non-finite lat, an over-long name and a missing lon each cost their
    own field, and a malformed body never clears a good stored location. `{location:
    null}` clears it.
14. **T3.6** Implement the side effect: a changed location deletes `.weather-cache.json`
    and calls `clothing.rebuildToday()`, exactly as a changed window does.

**Verify:** `node --test tests/weather-location.test.mjs tests/routes.test.mjs`
**Gate:** `/reviewing` before phase 4. Scope: the new route's validation and refusal
wording against the house rule that a malformed field costs that field, not the setting.

---

## Phase 4 — the tile and the symbol

**Posture hint:** implementing.

15. **T4.1** Failing test: the tile footnote names the town when a location is stored.
16. **T4.2** Failing test: with no location the footnote says "approximate location" —
    the state that caused this whole investigation becomes visible on the board.
17. **T4.3** Failing test: weather code 80 and code 95 both map to `rain`; 71 stays
    `cold`; 1 stays `sun`. (ARASAAC `rain` = 3123, checked 9/23.)
18. **T4.4** Implement 4.1-4.3 in the tile builder (`clothing-worker.js:1293-1305`)
    and the symbol map (`:1078`).

**Verify:** `node --test tests/weather-location.test.mjs tests/clothing-weather.test.mjs`

---

## Phase 5 — Settings UI

**Posture hint:** **collaborating.** Copy and layout are judgment calls dad has opinions
about, the warning styling for "guessing from the network" is a visual decision, and the
standing-footer measurement rule (9/14) has bitten before. Surface choices, do not guess.

19. **T5.1** The location row above the two hour selects: label, Change button, text box
    ("Town or ZIP"), tap list of `Name, Admin1, Country`.
20. **T5.2** The three states: stored (town shown), none (warning styling, "Guessing
    from the network"), and in-flight.
21. **T5.3** The two error wordings — no match ("No town by that name — try a ZIP
    code.") and 503 ("Could not reach the lookup — check the connection.").
22. **T5.4** Extend `tests/settings-ui.test.mjs` for the three states and both errors.

**Verify:** `node --test tests/settings-ui.test.mjs`
**Gate:** screenshot the Settings page against a scratch hub over the dist payload (the
9/16 recipe) before calling it done. Playwright resolves only from `tests/`.

---

## Phase 6 — behavioural verification (mandatory, not unit tests)

**Posture hint:** collaborating — the last step needs dad.

23. **T6.1** Full gate in the FOREGROUND: `bash tools/era-gate.sh`. Expect
    **107 passed, 0 failed** plus this unit's new suite. Any red is a stop.
24. **T6.2** Stand up a manual hub on `ERA_TEST_PORT=8380` (check `ss -ltn` first),
    with a **copy** of a real wardrobe — never the live data dir. Then, against it:
    - `curl -s 'localhost:8380/weather/search?q=<a real town>'` → expect a ranked list
      with state and country.
    - `curl -s 'localhost:8380/weather/search?q=<a real ZIP>'` → expect that same town.
    - `curl -s 'localhost:8380/weather/search?q=zzzzzzzz'` → expect `{"results":[]}`.
    - POST the chosen location, then confirm `.weather-cache.json` is gone and
      `recipes/today.json` has been rebuilt with a tile whose footnote names the town.
25. **T6.3** The number that started this: with the family's real location set, confirm
    the tile's temperature is within ~1 °F of the forecast for that point, and that it
    is **warmer** than the SF-centroid answer it replaces. Compare against dad's phone.
26. **T6.4** Dad confirms on a device before any release.

---

## Rollout

Unsigned patch under the v0.34.0 installer, per `docs/dev-flow.md`. Then:

- `POST /settings {"weatherWindow":{"from":10,"to":14}}` on the i13 (it is on 10-13) —
  a deployment step, **not** a migration; rewriting a setting a parent chose would be
  a surprise (spec §3.5).
- Set the location on both devices.
- `POST /clothing/regenerate` on both, since a band change wants a re-sort.

## Out of scope for this unit

The gate itself. With the right location the band will be right, but a warm day still
admits every garment she owns and a cool day still leaves her two bottoms. That is
unit B — and unit C lands before unit B's re-describe pass.
