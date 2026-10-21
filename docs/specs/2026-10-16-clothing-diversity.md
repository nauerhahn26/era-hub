# Clothing diversity: favourites distributed across weeks

Dad, 10/16: first-page choices feel repetitive when checking every few days.
Favourite combinations should retain influence, with familiar choices returning
about a week later rather than Monday/Wednesday/Friday. This amends the ranking
and reservation rules in the 9/5 migration and the 9/29 warmth design; the
weather curve and its quotas retain their existing contract.

## Evidence

The tablet's deployed ranking source matched this branch's initial source.
Saved first pages from 9/30 through 10/16 had no consecutive-day combination
overlap across 13 comparisons, but averaged 1.83 of six combinations in common
two days apart across 12 comparisons; the maximum was four. A 30-day simulation
of its copied wardrobe and local/shared preference history averaged 2.82 of six
repeated combinations after two days at 88°F. Removing pick history reduced
that to 1.32. At 74°F the corresponding averages were 1.32 and 0.18.

The explicit repeat bar read only yesterday. Two staple slots bypassed garment
freshness, and no term penalized recently shown exact combinations beyond that
one-day bar. Garment freshness alone cannot distinguish a new pairing from a
combination returning every other day. Weather uses a continuous curve, but
rounding into six slots creates temperature plateaus; with fixed date/history,
72–74°F can produce the same page. Date/history still vary choices across days.

The review covered 5,970 simulated daily deals over invented wardrobes and a
private tablet snapshot. Private inputs and scratch transcripts stay outside
the repository. Public regression tests use invented inputs only.

## Behaviour

1. Read each exact combination's most recent first-page date from the existing
   60-day offer history, including the shared history union. Ignore today's and
   future dates, as the existing garment clock does. No persisted schema or
   migration is needed.
2. Subtract 14 points per remaining day before its seven-day return: yesterday
   costs 84 points, two days ago 70, six days ago 14, seven or more days ago zero.
   This applies to all combinations, alongside the existing garment freshness,
   style, warmth fit, date-seeded jitter and preference terms.
3. Preserve the existing +12 learned-combination lift, +10 curated-garment lift,
   pick weights, two staple slots and top-five staple rotation. A favourite can
   reserve a staple slot once a week has elapsed since its last first-page
   appearance. Until then it still competes through ordinary ranked fill and
   remains available on the More pages when the daily deal includes it.
4. The garment-coverage reservation also asks for a combination not shown in
   the past six days. A dress/set cannot bypass spacing just because its garment
   age is older than the tops that appear with changing partners. If the oldest
   garment cannot claim this reservation, ordinary ranked fill uses the slot.
5. Spacing is prioritisation, not a new exclusion. Tiny wardrobes can repeat
   early and remain usable. The weather curve/quotas still decide clothing
   types. Online and offline deals both space combinations; offline ignores
   fit words as before but no longer promises the old multi-day golden order.
6. A new favourite picked from a deep page can still receive a first-page turn
   tomorrow when it has not recently appeared there. Choosing an outfit again
   from More reinforces the preference without resetting its first-page clock.

The week is a recovery target, not an exact schedule or guaranteed absence.
Some standalone favourites return sooner through ranked fill in a constrained
hot-weather wardrobe. Learned preferences retain the existing 60-day event
retention; this change does not erase, weaken or migrate the saved signals.

## Verification and repeatable simulations

`tests/clothing-diversity.test.mjs` checks preference recovery and meaningful
favourite advantage, approximate weekly returns over six weeks, two/three-day
recurrence, first-page order, new deep-page likes, same-day stability, sparse
builds, tiny wardrobes, and the existing weather verdicts while simulated daily
Yes events feed the learning loop. Existing ranking/variety/fit suites retain
garment coverage, carryover to More, page quotas and weather limits.

```
node --test tests/clothing-{rank,variety,fit,diversity}.test.mjs
node tools/clothing-diversity.mjs --wardrobe tests/fixtures/wardrobe-shape.json --temp 88 --days 42 --seed 2026-10-16 --pick first
```

The new CLI accepts `--history`, `--pairing`, `--step 2` for sparse builds and
`--temp offline`. It reads but does not write input data, invoke AI, or contact a
device. Calendar-day lag metrics distinguish adjacent visits from adjacent
days; missing comparisons are null. Summary output omits garment names/ids.

Private-snapshot before/after receipts and full-gate results are recorded in
`docs/plans/2026-10-16-clothing-diversity-validation.md`.
