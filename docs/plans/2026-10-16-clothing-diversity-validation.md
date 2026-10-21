# Clothing diversity: validation and handoff

Branch: `feat/clothing-diversity`; worktree: `era-hub--wt-clothing-diversity`.
Implementation: [design and behaviour](../specs/2026-10-16-clothing-diversity.md).

Status: **published v1.0.1**, build `20261016.1925`, for normal device update
checks. Feature landed as `887f110`; implementation commit `2eae73a` passed
200 focused tests and the full integration gate **122 passed, 0 failed**.
Windows self-update leg B passed **5 tests, 0 failed**. The public latest feed
and downloaded update archive were verified. Device installation receipt has
not been checked; publication and update availability are complete.

## Scope and sibling worktrees

Orientation flagged `clothing-picker-ui`, `jackets`, `long-press-clothing` and
`weather` as related worktrees. This change confines runtime behaviour to
`clothing-rank.js`; it adds a simulation tool and regression suite and updates
the nearest ranking/temperature documentation. It does not alter picker UI,
accessory categories, photo ingest, weather fetching or shared-log schemas.
Coordinate changes to the ranking module when those siblings are resumed.

## Before and after

The private tablet snapshot contains 63 catalogued items with all item tiles
present. Its deployed ranking source matched the branch's original source.
Read-only copies of the local history and mirrored offer/pick logs fed the
simulations. The home device was unavailable for a separate direct inspection.

The focused comparison uses 30 daily deals beginning 2026-10-16, the same
wardrobe/history, constant planning temperature and no invented future picks.
Numbers are mean exact-combination overlaps on six-option first pages.

| Planning temperature | Two days later, before | Two days later, after | Seven days later, after | Distinct combinations over 30 days, before → after |
| --- | --- | --- | --- | --- |
| 74°F | 1.32 | 0 | 1.13 | 90 → 108 |
| 88°F | 2.82 | 0 | 3.35 | 40 → 53 |

All 30 ordered first pages differed after the change at both temperatures.
This is an extrapolation from copied inputs, not an exact replay of historical
builds or a forecast of future choices. Some standalone favourites return in
five to six days in the hot wardrobe; the week is a recovery target, not a ban.

## Favourite influence is retained

In the invented broad-wardrobe six-week regression, the two learned favourites
each appeared six times without any new choice events, versus five and four
times without their learned history. Their returns were seven days apart.
Further Yes events on an already familiar look, including from More, preserve
preference without restarting the first-page exposure clock. New deep-page
likes still get a first-page turn the next day when not recently offered there.

## Checks

- `node --test tests/clothing-{rank,variety,fit,diversity}.test.mjs`: 200 tests
  passed. Existing all-integer 45–95°F weather sweeps run in both explicit-fit
  and legacy-word modes. The diversity suite also feeds daily simulated Yes
  events across representative temperatures, including offline weather.
- The scratch expanded audit ran 6,540 daily deals across 74 scenarios after
  the implementation, each also rebuilt to verify identical-input ordering.
  It covered the generic 63-item fixture, 35-item invented wardrobes with and
  without curated pairings, the private snapshot, preferences, sparse builds,
  weather changes, offline weather, lost history and legacy attributes.
- The public CLI was exercised with daily first-tile Yes events at 88°F and
  every-other-day builds at 74°F. Both preserved full first pages and showed
  zero two-calendar-day exact-combination overlap in these runs.
- `git diff --check`: clean.
- Full integration gate: **122 passed, 0 failed**, with a clean tree stamp for
  implementation commit `2eae73a`. Invoked with `ERA_TEST_PORT=8389` after
  confirming the port was free; the gate retained its global serialization.
  The first attempt reported 121 passing suites and one browser launch crash
  (`board-edit.test.mjs`, Chromium signal 11 before that test's assertions).
  A standalone retry passed all 15 tests, then the entire gate was rerun and
  passed all 122 suites without any code changes between attempts. The test
  server exited normally and released its port. This receipt update is docs-only.

The original 5,970-deal audit and the expanded implementation audit's private
snapshots/logs live only in local scratch storage, not in the repository.
The checked-in CLI and invented-input tests reproduce the selection checks
without those files; no AI call or device connection is needed.

## Known limits

Small or extreme-weather wardrobes can repeat early through ranked fill; this
is intentional availability protection. At 88°F the real wardrobe has only
eight sleeveless top-half garments for five daily sleeve-kind slots, so some
individual garments must recur even when exact combinations are different.

An existing deep-page edge remains: at 95°F a short internal page can run into
the next rendered page when the flat list is paginated, repeating a garment
on a More page. A 21-day learned-choice run reproduced this on two deep pages
with the unmodified deployed source. This change does not alter pagination;
first pages remain garment-distinct, and the existing deep-page variety cases
continue to pass. Track a pagination repair separately from favourite spacing.

## Published patch receipt

- Release: [v1.0.1](https://github.com/nauerhahn26/new-era-releases/releases/tag/v1.0.1).
- Build: `20261016.1925`; source: `887f110`; installer retained from signed v1.0.0
  as `Our-Era-Comms-Setup.exe`, with its signature verified before publication.
- Update archive SHA-256:
  `03d66c2fe5035b18391f52a1109d7efdc0cb4d0c165d61a706359a06e7a7401d`.
- Windows verification: clean v1.0.0 install, wizard and chosen-pack setup,
  automatic update to v1.0.1, profile/pack/app preservation, clean shutdown;
  all five checks passed on the exact archive published.
- Public `releases/latest/download/latest.json` matched the tested feed.
  Its stable update archive was downloaded publicly: 62,949,685 bytes, with
  the SHA-256 above. All six download/update assets were present.
- Temporary QA host teardown completed; status confirmed no QA host remains.
  No live development-server restart or direct device update was performed.

The first release attempt built successfully but stopped before publication
because the test harness's default output directory referenced an unset `USER`.
The successful rerun supplied `VM_OUT` explicitly; no application or test
assertion was changed. The old QA template required its documented temporary
clean-baseline repair on each fresh host; this release did not save a new
template. The separate permanent-template follow-up remains as previously
documented in the private QA runbook.

Release command used (with an existing fresh, clean gate stamp):

```
VM_OUT=/tmp/clothing-diversity-release-20261016/vm bash tools/release.sh v1.0.1 --patch --skip-gate
```

Installed devices receive this release on their normal updater checks. Delayed
or offline-device receipt is pending delivery, not a failed publication.
