# Clothing Picker — migrating the original's variety, favourites and memory (design)

**Date:** 2026-09-05 · **Branch:** `feat/clothing-migration` (era-hub) · **Ships as:** v0.32.2
**Origin:** dad, 9/5: "I think the diversity of outfits is not as good or creative as
the original. Also not sure it's tracking favorites or what was selected yesterday.
Can you review the previous work and migrate with the local infrastructure and data
sharing being thoughtful." Reviewed by a 69-agent understand pass (five readers, 21
gaps confirmed, 0 refuted). The original is `aac-studio/packages/generator/outfit_set.py`
(+ `tests/variety_test.py`, `docs/plans/outfit-variety-plan.md`, dad's 8/5 ruling).

## 1. What the review found

Composition is at parity: both generators make top+bottom pairs or one-piece looks,
and the composite geometry (840×560, halves 420, pad 6, top left / bottom right) is
identical. The original's felt "creativity" came from three things the hub never got:

| # | Original | Hub today (v0.32.1) |
|---|---|---|
| V1 | Taste rules: `harmonizes()` (never two statement pieces; a statement piece needs a neutral partner) and `style_score()` (base 50; curated `great` +30 / `avoid` −1000; statement-over-basic +15, two basics +5; palette neutral-or-same +10, warm-vs-cool −10; same vibe +5). Garments carry `colors[] pattern statement palette vibe`. | Every top × every bottom; the model is only asked for name/category/warmth/top_side/crop. |
| V2 | `rank()` = style + fav 10 + dress 8 + **per-garment freshness** (min(gap, 8) × 6, unseen = 9 days) + loved 12 (≥ 2 pick credits) + sha256(date\|combo) % 16 jitter. | Sort by least-recently-shown **combo**, then `Math.random()`. A garment can sit on page 1 daily in different pairings. |
| V3 | Page 1 = 2 rotating staples + 1 LRU **coverage slot** + freshest, garment-distinct; yesterday's page-1 looks barred from page 1 for one day and **lead page 2**; deeper pages garment-once-per-page. | Staples + garment-distinct fill; no coverage, no yesterday rule, deeper pages may repeat a garment. |
| V4 | One deterministic deal per date. | **Re-dealt on every Drive sync — every 10 minutes in local mode** (`server.js:2500` `drive.onSynced → clothing.regenerate(true)`). The LRU signal collapses within the hour and the lineup flips all day. |
| V5 | Only bottoms/dresses are weather-gated (`BAND_WARMTH`); tops never. | Tops gated too (smaller pool on hot/cold days). |
| F1–F3 | Loved lift, staple rotation by hash, staples skip if on page 1 yesterday; day = local date. | Loved lift missing; rotation by UTC epoch-day; day = OS-zone date in the worker (the event recorder already uses the family TZ). |
| H1 | `history.json {days:{date:{band,page1}}, events}` — 60 days kept. | Only `clothing-history.json {shown:{combo:iso}}`; nothing records what was on page 1. |
| S1 | (n/a — the original shared through a server, which the local-first law forbids) | `wardrobe/history.json` is device-local; the Drive mirror never carries it. AI tagging is paid once **per device**. |
| O1 | — | Nothing in Settings shows that picks are being learned. |

Spacing: the 14 px gap / 7-per-page contract landed 9/5 and shipped in v0.32.1 twenty
minutes before this design; no device has run it yet. Two visible leftovers are
board-side and stay queued until dad has seen v0.32.1 (§9).

Dad's 8/5 ruling (outfit-variety-plan.md), which settles the one contradiction
between the codebases: **no hard exclusions** — fresh things come to the front,
recent things slide back through the More pages, nothing is ever removed, a few
proven favourites stay up front. So yesterday's page-1 looks — including the one she
said Yes to — lead **page 2** today, not page 1. The hub's 9/2 rule ("yesterday's Yes
first on page 1") is retired. Flagged to dad as reversible.

## 2. Goals / non-goals

Goals: (a) the original's ranking, page assembly and memory, byte-for-byte in
semantics, as pure Node functions with the original's variety gate ported;
(b) the attributes the rules read, free for new photos and free for the family's
already-tagged garments; (c) one deterministic board per day; (d) picks, offers and
tags shared across the family's devices through the Drive mirror the hub already has,
with no server, no races and no new secrets; (e) a Settings read-out so a parent can
see it working.

Non-goals (this cut): a grown-up ♥ / "never together" control (queued); board-side
spacing changes (§9); Build-my-own garment-level events; any change to the board's
dwell rules or grid (the 9/5 contract stands); any behaviour that needs a key in tests.

## 3. Architecture

Two new plain CommonJS modules, both stdlib-only, both unit-testable without a worker,
a hub or a key; the worker composes them.

```
clothing-rank.js     pure: attributes, harmonizes, styleScore, rank, buildCandidates,
                     derivePicks, recordOffer, dayKey, h() — no fs, no Date.now()
clothing-log.js      the shared dot-folder: append own lines, merge-read all devices,
                     torn-line tolerant, never throws
clothing-worker.js   ingest (+attributes) → merge tags → weather band → buildCandidates
                     → composites/boards → recordOffer → history + log
clothing.js          tick() is the only door a sync opens (V4)
server.js            POST /outfit-event also appends to the log; /clothing/status picks
public/settings      "Her picks" read-out
```

### 3.1 Garment attributes

`wardrobe.json` items gain `colors: string[]`, `pattern`, `statement: bool`,
`palette`, `vibe`, `hash` (sha256 of the photo bytes, hex). Sources, in precedence:

1. **Shared tags** (`clothing/.era/tags/<writer>.jsonl`, §5) matched by `id`, else by
   `hash`. Covers the family's 35 already-tagged garments (the original's
   `wardrobe.json` keys them by `source_hash` = sha256 of the HEIC bytes) via the
   private migration tool (§7) — zero AI calls.
2. **The vision model** at ingest: `INGEST_PROMPT` asks additionally for
   `"colors": 1-3 plain colour words, "pattern": one of solid, denim, stripes, floral,
   graphic, print, "statement": true if it is a loud print/graphic piece that wants a
   plain partner, "palette": warm|cool|neutral|pastel, "vibe": sweet|sporty|graphic|basic`.
   Same one call per new photo. Parsed with a whitelist like the existing fields.
3. **Already-catalogued items with no attributes and no shared tag**: a
   `needs-attributes` pass inside `ingest()` runs **after** new photos are named, one
   call per item through the same provider ladder, the same 5 s spacing, the same
   holdDay/allowance rules, and only when a vision key is configured. Items it cannot
   reach today stay as they are.
   **This precedence is a one-way door, and the order of the upgrade morning decides
   it** (plan A4-13, settled in T4.3): the pass stamps `attrsAt` on a garment within
   minutes of first boot and nothing revisits a stamped garment, so a `tags/` line that
   arrives on a LATER Drive pull can no longer replace what this device's own model
   said. Source 1 therefore only beats source 3 if the migration tool's output is
   already in the mirrored folder when the upgraded hub builds for the first time —
   which is why §7's placement step comes before the first boot, not after it. The
   alternative considered and rejected was a `tagsFor` sweep independent of
   `needsAttributes` in which a tag whose `t` is newer than `attrsAt` wins: it does not
   actually cover this case, because the tool's `t` is stamped when the operator RUNS
   it, which on the restore is hours *before* the hub's first boot — the sweep would
   look at an older tag and keep the model's answer. It would also let one device's
   later re-describe silently overwrite another's, for a family that has no way to see
   or undo it.
4. **Missing attributes degrade, never exclude**: no colours/pattern → `isNeutral`
   is treated as true when `statement` is false; `statement` defaults false; empty
   palette/vibe score 0. A wardrobe with no attributes at all ranks as "all basics"
   and still fills 21 slots.

Attributes never appear in a recipe (the board is unchanged); they live in
`wardrobe.json` and the shared tags line. Names/colours are family data, never logged.

### 3.2 Ranking and page assembly — `clothing-rank.js`

A faithful port of `outfit_set.py` lines 61–73 and 242–557 with the same constants
(`NEUTRALS`, `HISTORY_DAYS_KEPT 60`, `FRESH_CAP_DAYS 8`, `FRESH_PTS_PER_DAY 6`,
`LOVED_PTS 12`, `JITTER_PTS 16`, `STAPLE_SLOTS 2`, `STAPLE_POOL 5`, `YES_WEIGHT 1.0`,
`INFERRED_WEIGHT 0.5`), the same functions and the same order of operations:

- `isNeutral(g)`, `harmonizes(top, bottom)`, `styleScore(top, bottom, pairing)`.
- `derivePicks(events, before)` — already byte-for-byte in the worker; moves here.
- `buildCandidates({items, band, cap, seed, pairing, history, perPage})` returns the
  ordered list of combos (`{key, pieces:[garment…]}`) exactly as the original:
  pool = clean × band-eligible (§3.4) with `harmonizes && styleScore > 0`; `rank()`;
  staples (picks, else curated `great`; garment-distinct top-5; sorted by
  `h("staple", key)`; skipped if in yesterday's page 1); the coverage slot (longest
  unseen garment by page-1 age, tiebreak `h("aged", id)`, in its best-ranked look);
  freshest fill with the yesterday bar; tiny-pool relaxation; deeper pages =
  `demoted` (yesterday's page 1) first, garment-once-per-page. `dressy` is dropped
  (dead lever on both sides); `favorite` is read if present (curated, +10).
- `h(seed, ...parts)` = `BigInt("0x" + sha256(seed|parts))` and `% n` via BigInt —
  no `Math.random()` anywhere in the deal.
- `recordOffer(history, date, combos, perPage, band)` — overwrites `days[date]`,
  prunes `days` to 60 and (new, bounded growth) `events` to the same 60 days.
- `dayKey(now, tz)` = `toLocaleDateString("en-CA", {timeZone: tz})`; the worker gets
  `tz` in `workerData` from the profile; `POST /outfit-event` already uses it.
  "Yesterday" = `dayKey` minus one calendar day in that zone.

`status: clean` — the hub has no status field; every `ok` item with a tile is clean.

### 3.3 Memory — `wardrobe/history.json`

Becomes the original's shape and stays the local canonical:

```json
{ "days":   { "2026-09-05": { "band": "warm", "page1": [["item_a","item_b"], ["item_c"]] } },
  "events": { "2026-09-05": [ { "kind": "yes", "combo": ["item_a","item_b"], "at": "…" } ] } }
```

Written tmp+rename (`writeAtomic` from content-store.js), by the worker (days) and by
`POST /outfit-event` (events) — two writers, one file, so both do read-modify-write
and the worker never touches `events` beyond the 60-day prune. `clothing-history.json`
(`shown`) is retired: the worker stops reading and writing it and deletes it once.

Reads for a build use **only days strictly before today** (freshness, yesterday) and
**events strictly before today** (picks): a same-day rebuild — weather re-sort, Sync
now, restart — reproduces the same lineup unless the weather band changed.

### 3.4 Weather

The original's rule with the hub's thresholds: band from the windowed forecast
(78/66/54, `weatherWindow`), tops **never** gated, bottoms/dresses/sets gated by
`BAND_WARMTH = {hot:{1}, warm:{1,2}, cool:{2,3}, cold:{3}}` over the mapping
`warmth word → level: hot 1, warm 1, cool 2, cold 3, any = every level`. The hub's
"widen to the neighbouring band when fewer than two remain" safety stays for the
gated categories (a wardrobe must never empty the board). Offline = no gating.

### 3.5 One deal per day (V4)

`drive.onSynced` calls `clothing.tick("drive sync")` instead of `regenerate(true)`:
tick already rebuilds only when the photo set changed, the board predates this
morning's cutoff, or leftovers are due a retry. Log-only changes (another device's
picks/offers/tags arriving) never rebuild today's board — they count tomorrow, which is
the original's property. `POST /clothing/regenerate` and the weather re-sort stay the
only intra-day doors, and §3.3 makes even those reproduce the lineup.

## 4. Favourites

Learned favourites exactly as the original: `derivePicks` over the merged pick log,
staples from the top-5 by weight rotated by `h("staple", key)`, `LOVED_PTS` in
`rank()`. Curated pairs (`great`/`avoid`, and a per-garment `favorite`) are read from
the shared `pairs/` log (§5) — the family's 14 great / 1 avoid arrive through the
migration tool; there is no UI for them this cut.

`/clothing/status` gains

```json
"picks":   { "days": 24, "lastDay": "2026-09-04",
             "top": [ { "combo": ["item_a","item_b"], "names": ["…","…"], "weight": 3.5 } ] },
"memory":  { "days": 33, "yesterdayPage1": 7 },
"sharing": { "mode": "drive" | "local", "devices": ["<own-id>", "…"] }
```

(top five, names from the catalogue, computed from the merged log, days < today) and
Settings' Clothing Picker card renders under the existing status line:
"Her picks: 24 days recorded, last Thursday. Favourites: A + B (×3), C (×2)…" and,
when Drive is connected in local mode, "Shared with: 2 devices". No picks yet →
"No picks recorded yet — every Yes on the board is remembered from tomorrow."

## 5. Sharing — `clothing/.era/` inside the mirrored folder

```
<Drive folder>/clothing/.era/
  picks/<device-id>/<YYYY-MM-DD>.jsonl   {t, kind: select|yes, combo:[ids]}
  offers/<device-id>/<YYYY-MM-DD>.jsonl  {t, band, page1:[[ids]…]}   (last line of a date wins)
  tags/<writer>.jsonl                    {t, id?, hash?, name?, category, warmth, colors, pattern,
                                          statement, palette, vibe}  (newest per id/hash wins)
  pairs/<writer>.jsonl                   {t, kind: great|avoid|favorite|none, combo:[ids]}
```

Why this is safe under the mirror the hub has (verified in drive.js, 9/5): dotfiles
are copied by `copyTreeLocal` and `mirrorDir`, never pruned by `pruneTree`, never
listed as photos by `clothing-photos.js`, and never trip `photoSet()`; one writer per
file means Drive for Desktop never sees two editors; append-only means every write
grows the file, so the size-equal copy skip always copies it; a torn last line is
skipped on read. Nothing secret is ever written; names are the only family text and
they already live in the mirrored folder's photos. ~2 KB per device per day.

- **Own writes** go to the Drive mount when `drive` is in local mode with a folder
  (`<folderPath>/clothing/.era/...`), through `clothing-log.js`, which never throws
  (a missing mount, API mode or a permission error = a log line and nothing else).
  The local canonical (§3.3) is always written first.
- **Reads** merge `<DATA>/clothing/.era/**` (the mirrored copy — other devices *and*
  this device's own uploaded lines) with the local canonical for this device; own
  device-id lines in the mirror are skipped in favour of the local file. Picks =
  union (one credit per combo per day across devices); offers = union (`lastP1` =
  max date across devices, yesterday's page 1 = the union); tags = newest per
  id/hash; pairs = newest per unordered pair.
- **Device id**: `DEVICE_ID` today defaults to `"hub"`. A stable id is generated once
  per install — `<DATA>/device-id`, `<hostname-slug>-<4 hex>`, created when absent,
  honoured if `profile.deviceId`/`ERA_DEVICE_ID` is set — and used by pool.js and
  the clothing log alike (two devices called "hub" would share a file).
- **Same board everywhere**: identical tags (shared), identical picks/offers
  (merged), the same date and the same band → `buildCandidates` deals the same 21 on
  both devices without coordination. The one residual divergence is the weather
  fetch (per device, 3 h cache).
- **Tags pay the AI once per family**: `ingest()` checks merged tags by id, then by
  content hash, before `askModel`; a hit records the attributes and skips the call
  (the tile is still drawn locally).
- Latency is Drive's upload plus the 10-minute pull (6 h in API mode); fine, since a
  build only ever reads days strictly before today.

## 6. Data flow (one morning)

1. 05:00+ tick → worker: `ingest()` (new photos → tags: shared hit or one call;
   then the needs-attributes pass) → `weather()` → merged log read → `buildCandidates`
   with seed = `dayKey` → composites + boards (unchanged) → `recordOffer` into
   `wardrobe/history.json` + one `offers/` line → recipe written.
2. She gazes: the board POSTs `/outfit-event` → `events[today]` in history.json + a
   `picks/` line + the pool event (unchanged).
3. Every 10 minutes the mirror pulls other devices' `.era` lines; nothing rebuilds.
4. Tomorrow's build reads today's picks/offers from every device.

## 7. Migration of the family's original data (private tool, era-family)

`era-family/tools/clothing-migrate-studio.mjs <studio wardrobe dir> <photos dir> <out .era dir>`
(no keys; runs on the build box): reads the original `wardrobe.json`, `pairing.json`,
`history.json`; maps garments to hub ids by `sha256(photo bytes)` = `source_hash`
against the photos it is given (the Drive `clothing/` folder or the i13 keep), falls
back to `md5(source filename)` (= the hub id when the filename is unchanged); writes
`tags/studio.jsonl` (hash + id + attributes, `retired`/`too_big` skipped),
`pairs/studio.jsonl`, `offers/studio/<date>.jsonl` and `picks/studio/<date>.jsonl`
with hub ids, and prints counts of what could not be mapped. Placement into the
family Drive folder is an operator step in the private restore runbook. Nothing from
it enters era-hub.

**Ordering (A4-13): the tool's `.era` output must be in the mirrored folder BEFORE the
upgraded hub builds for the first time.** The hub's needs-attributes pass (§3.1 item 3)
describes every garment it can reach on that first morning and stamps `attrsAt`, and a
stamped garment is never revisited — so a `tags/studio.jsonl` that lands afterwards is
read for garments the hub has not described yet and ignored for the ones it has. Placing
the folder first is what makes §3.1 item 1's "zero AI calls" true for the family's
already-tagged wardrobe. Nothing breaks if the order slips: the hub describes the
wardrobe itself, at its own cost, and the boards are dealt either way.

## 8. Tests (node:test, no key, no network; ports 8458–8462 — 8450–8457 are taken by hand-run hubs)

- `tests/clothing-rank.test.mjs` — pure: `harmonizes`/`styleScore` cases from the
  original (two statements never; statement needs a neutral; avoid = −1000; great +30;
  palette ±10; vibe +5), missing-attribute degradation, `derivePicks` (2.0 / 1.5 /
  today excluded — the original's picks scenario), `recordOffer` prune (days and
  events), `dayKey` across a zone boundary, `h()` reproducible.
- `tests/clothing-variety.test.mjs` — the ported gate on a **synthetic** 35-garment
  wardrobe with attributes (invented names, e.g. "Sunny tee"): 14 days × {warm, hot}:
  every eligible garment on page 1 within 10 days; zero page-1 combos on two
  consecutive days; ≥ 80 % of yesterday's page 1 still offered; page 1
  garment-distinct; 21 a day; determinism (same date + history → same list); **a
  same-day rebuild is identical**; yesterday's page-1 looks lead page 2; a Yes made
  from a deep page (not in yesterday's page 1) is seated on page 1 as a staple.
- `tests/clothing-share.test.mjs` (8458 hub, 8459 fake AI) — temp Drive folder + two
  temp DATA dirs: own lines land in the mount, the mirror copies `.era` and never
  prunes it, photos are not affected, torn last line tolerated, own-id dedupe, tags
  hit skips the AI call (the fake counts), device B builds the identical 21 from the
  same logs; API mode / no folder → local only, no throw; a stable device id is
  created once.
- `tests/clothing-sync-rebuild.test.mjs` (8460) — `onSynced` with unchanged photos
  leaves `recipes/today.json` untouched; a new photo rebuilds.
- Updates: `tests/clothing.test.mjs` favourites block (yesterday's page-1 Yes → leads
  page 2; a Yes from a deep page → page 1), any `clothing-history.json` reference;
  `tests/clothing-weather.test.mjs` (tops ungated); a Settings test for the read-out;
  `tests/pool.test.mjs` device id.
- Gate: `bash tools/era-gate.sh` green; then the v0.32.2 cut and VM QA.

## 9. Queued for dad (not in this cut)

- Which spacing issue he still sees on v0.32.1: (a) the tile gap — fixed; (b) the
  white letterbox inside each tile (a two-image photo row in the board instead of the
  3:2 composite, era-board); (c) the grey note over the bottom row's labels (move the
  notes into the header partner strip, legal since the 9/4 amendment).
- A grown-up ♥ / "never together" control (Settings first; the header strip if he
  wants it on the board) — the `pairs/` log is already the store for it.
- Yes on the confirm page marking the outfit or returning to page 1.

## 9. As shipped in v0.32.2 — amendments to this design

Written after the cut. Sections 1–8 above are left as they were written on 9/5; this
section is the difference between them and the code that shipped. (It follows §9
"Queued for dad" rather than renumbering it, so every "§n" reference elsewhere in the
plan and in the source comments still points where it did.)

### 9.1 The thirteen plan amendments (plan §A4)

| # | Rule as shipped | Amends |
|---|---|---|
| 1 | `wardrobe/history.json` has **one** writer on the main thread, not two; same file, same shape. | §3.3 |
| 2 | `/clothing/status` `sharing.devices` is a **count**, not a list of ids — no id list leaves the device. | §4 |
| 3 | A `tags/` line may carry `rotate_deg` and `crop`; a `favorite`/`none` line in `pairs/` names exactly one id. | §5 |
| 4 | `buildCandidates` sorts items by id before pooling, so the deal does not inherit catalogue order. | §3.2 |
| 5 | The needs-attributes pass keys on an `attrsAt` marker: at most one describe per item per day. | §3.1 item 3 |
| 6 | The mirror compares `.era/` paths by **bytes** (local) / `md5Checksum` (API), never by size. | §5 |
| 7 | Tests add `clothing-log.test.mjs` (pure) and `synthetic-wardrobe.mjs` (helper); the read-out hub runs on 8461 and the attribute pass has its own `clothing-attrs.test.mjs` with a fake model on 8462, because `clothing.test.mjs` is near its 900 s ceiling. | §8 |
| 8 | `holdDay` stays **photo-only**. The pass gets the same effect by stamping `attrsTriedAt = today` on every real call whatever its outcome, and never asking an item already stamped today. | §3.1 item 3 |
| 9 | Own writes go to the Drive **mount only** — there is no local `.era` copy. The local canonical is `wardrobe/history.json` (picks/offers) and `wardrobe.json` (tags); `<DATA>/clothing/.era/**` belongs to the mirror alone, and own-id dirs are skipped on read. | §5 |
| 10 | The events prune has a **young-history guard**: the "below the oldest kept day" cutoff applies only once `days` holds its 60; while it is younger, the 60 most recent event dates are kept, so a fresh or just-migrated install does not lose its migrated picks to its first offer. | §3.2 |
| 11 | "A garment returns once per page" means once per **algorithmic** page. On a small pool a page can run short, so a flat `slice(7,14)` is a page only where every page fills. | §1 V3 |
| 12 | "Degrade, never exclude" now also covers attributes the model **did** supply: when the harmonizing deal cannot fill one page (`pairs + singles < pageCap`), the `harmonizes` predicate is dropped for that deal — `avoid` and the ranking stand, the extra looks rank last. Above a page the floor stays shut and boards are byte-identical. | §3.1 item 4, §3.4 |
| 13 | The §3.1 precedence is a one-way door: the migration tool's `.era` output must be in the mirrored folder **before** the upgraded hub's first build. Recorded in §3.1 item 3 and §7. | §3.1, §7 |

### 9.2 Behaviours changed by review, beyond A4

- **Untagged warmth is `any`.** A garment whose warmth word the hub does not know is
  gated by no band (levels 1–3), and an unrecognised *band* word gates nothing at all
  — the hub's "never empty the board" rule beating the original's `{1,2}` default
  (§3.4; both are inputs the hub itself never produces, and both are pinned).
- **A memory that will not open buys ONE re-deal per day, and that re-deal is a
  re-sort.** It can never re-enter ingest or spend the day's model allowance, it sits
  inside the board-freshness branch (a board that is also stale still gets the
  morning's full build and the tile repair it carries), and the budget resets with the
  day, as `holdDay` does (§3.5).
- **`memory.days` counts today; `picks.days` does not.** A build a parent has just
  triggered shows in the memory immediately, while a Yes made this morning counts
  tomorrow — exactly as the deal reads it (§4, §3.3).
- **A `/clothing/status` poll never writes.** The read-out opens `history.json`
  read-only, so a public GET during a restore cannot quarantine a half-copied file
  (§4).
- **`sharing.devices` counts writers, not devices** — distinct names under `picks/`,
  `offers/`, `tags/` and `pairs/`, plus this one, so the migration tool's `studio`
  lines count as one (§4, §5).
- **Yesterday's page-1 Yes leads page 2**, and a Yes from a deeper page is seated on
  page 1 as a staple; a square wardrobe can re-seat a barred look in the last page-1
  slot, which is the original's relaxation, faithfully ported (§1 V3, §4).
- **An empty lineup is refused at both ends of the shared log** — `appendOffer` will
  not write one and the reader will not read one — so a device whose tiles have gone
  missing cannot blank that date's page 1 for the whole family (§5).
- **Every door that sets the local mount re-opens the shared log**, including
  `POST /integrations/drive/create-folder` (Settings' one-click "make the folder"),
  which previously left the process sharing nothing until a restart (§5).
- **The per-day 200-event cap covers the shared copy too**: past it the event is
  written to neither store, so the two never disagree (§3.3, §5).
- **`/outfit-event` still answers `204` with an empty body** after the added share
  write; era-board relies on it (§6 step 2).
- **The shared reader skips a line that lacks its kind's required field, and any
  `marker` line**, and a skipped line is never "the last line of a date" (§5).
- **Migration tool (§7): only the four PERMANENT statuses are held back** —
  `too_big`, `too_small`, `retired`, `outgrown`. `dirty` (in the wash) and
  `unavailable` are per-run rotation filters in the original, not migration decisions,
  so they cross whole; a garment in the laundry on restore morning is no longer lost
  to the do-not-copy list. Each held-back entry carries its reason.
- **Migration tool: `mapped` means the taste crossed whole** (a photo matched *and* a
  category the hub has a word for); everything else not held back counts as unmapped.
  Category/warmth lookups use an own-property check, so a studio `type` of
  `constructor` can no longer ship a tag line with no category. The out dir must BE
  the `.era` dir, `do-not-copy.txt` is written first and always, stdout stays exactly
  three counts, and the A4-13 ordering reminder goes to stderr.
- **The re-run marker is idempotent by pad, not by count**, and a re-run is additive
  per date and per kind; the hub's own 60-day prune retires what the studio dropped.

### 9.3 Known, accepted, not fixed in this cut

- Nothing prunes `<DATA>/clothing/.era` (≈0.7 MB per device per year), and the
  `tags/` file grows one line per garment per describing device.
- A device does not read its OWN tags back, so one device pays twice for the same
  photo saved under two names; what "own lines are skipped" should mean wants a
  decision, not a patch.
- The `.era` byte-compare reads both files on every sync.
- The card says nothing about `memory.yesterdayPage1`, though the payload carries it.
- The upgraded hub's first morning has no yesterday bar (the old `shown` LRU is
  retired without a shim) — one day, cosmetic.
