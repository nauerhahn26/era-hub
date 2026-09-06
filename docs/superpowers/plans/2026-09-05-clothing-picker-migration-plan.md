# Implementation plan: Clothing Picker migration (variety, favourites, memory, sharing)

Date: 2026-09-05. Produced by `rae-flow:planning` (subagent mode, no user
interaction — every unresolved question is written down, not asked).

- **Design source:** `docs/superpowers/specs/2026-09-05-clothing-picker-migration-design.md`
- **Repo / branch:** `era-hub`, worktree `era-hub--wt-clothing`, branch
  `feat/clothing-migration` (HEAD `6b1f5c3` at planning time). Ships as v0.32.2.
- **Original being ported:** `/home/claude/aac-board-builder/aac-studio/packages/generator/outfit_set.py`
  (+ `tests/variety_test.py`). Read-only reference; nothing is copied from it but
  semantics.
- **Private repo:** `era-family` is touched by exactly one task (T6.1) and only at
  `era-family/tools/`. No family-data file is read by any public task.
- **Preflight verdict:** PASS WITH WARNINGS — 3 blockers with agreed mitigations
  (all folded into tasks), 13 warnings, 22 infos. Detail in §A.

---

## A. Preflight results (design vs repo reality)

Five validators (ranking port; attributes/ingest; sharing/mirror; status/Settings/
onSynced/history; test infrastructure) verified 80+ claims against the checkout and
the original. Status: **PASS WITH WARNINGS**. Every gap below names the task that
pays it.

### A1. Blockers (each has a mitigation that is now a task constraint)

**B1 — The needs-attributes pass would fire on every hand-seeded and fake-answered
fixture in the existing suites** (two validators independently). `clothing.test.mjs`
is already at 616.5 s of the 900 s per-suite ceiling (`gate/clothing.test.out`); the
fake AI's `ANSWERS` (`tests/clothing.test.mjs:52-56`), every `forceAnswer`
(`:493,:510,:527,:723`), `clothing-responsive.test.mjs:38-41`'s fixed JSON and every
hand-written catalogue entry (`:627-629,:646-649,:683-686,:771-783`,
`clothing-weather.test.mjs:106-109`) carry no attributes, so an "attributes empty →
ask" pass would add a call + 5 s per item per build and break the `calls === before`
pins (`:155,:237,:382,:406,:442`).
*Mitigation (adopted):* (a) needs-attributes keys on an explicit marker `attrsAt`
(dayKey of the last successful answer or tag hit), never on "colors empty", and
asks an item at most once per day; (b) the fake's answers and every seeded entry
gain attributes (or `attrsAt`) so the pass is a no-op in the existing suites;
(c) the pass's counters stay out of `busy/quota/left/landed`
(`clothing-worker.js:638-640`) so `holdDay` (`clothing.js:79`) stays photo-only;
(d) an env seam `ERA_AI_SPACING_MS` next to `ERA_AI_URL` (`clothing-worker.js:458`)
lets new suites shorten the 5 s. *Paid in:* T3.1, T3.2.

**B2 — Two threads read-modify-writing `wardrobe/history.json` can lose picks or
wipe the file** (three validators). The worker (days) and the main-thread
`/outfit-event` handler (events, `server.js:1499-1510`, plain `writeFileSync`) are
separate threads; `writeAtomic` uses a FIXED tmp name `<basename>.tmp`
(`content-store.js:131-134`) so concurrent calls collide (second rename → ENOENT →
`/outfit-event` 400 → the exact 9/2 dropped-pick bug) and a byte-level interleave
leaves a torn file the next read parses as `{}` (`server.js:1501-1502`) — total
memory loss. *Mitigation (adopted, a mechanism change from spec §3.3 "two writers"
— semantics unchanged):* the **main thread is the only writer**. The worker posts
`{offer:{date, band, page1}}` on `parentPort` (the channel already carries
`ingesting`/`done`, `clothing.js:67-81`); `clothing.js` applies `days[date]` + both
60-day prunes with `writeAtomic`; `/outfit-event` switches to `writeAtomic` on the
same event loop. Synchronous fs on one loop serialises; no lock. Parse failure on
read never overwrites a non-empty file with `{}` (rename aside + log).
*Paid in:* T2.2.

**B3 — A 14-day × 2-band variety gate cannot run end-to-end through the worker.**
28 builds × 21 pure-JS composites (~15-20 s per build) + 35 ingests ≈ well over
900 s, and the worker buckets the day with `new Date()` (`clothing-worker.js:822-823`)
so "14 days" cannot be simulated. *Mitigation (adopted):* the variety gate runs on
the pure module (`buildCandidates`/`recordOffer` with explicit `seed`, in-memory
history, sub-second); the end-to-end check is small (pre-tiled 5-7 garments, no key,
2-3 builds). *Paid in:* T1.5, T2.4, T4.4.

### A2. Warnings (documented, mitigated, proceed)

| # | Gap | Evidence | Mitigation | Task |
|---|---|---|---|---|
| W1 | Rank ties resolve by pool order; the hub's pool order is photo-ingest order (`Object.values(cat.items)` = filename insertion), so §5 "same board everywhere" is not guaranteed on ties (ties are common: style multiples of 5, fresh of 6, jitter 0-15) | `outfit_set.py:404-410,:453`; `clothing-worker.js:807-810,:609` | `buildCandidates` sorts items by `id` before building tops/bottoms/singles — **one documented deviation** (the hub has no canonical list order). Variety test: shuffled item order → identical key list | T1.4, T1.5 |
| W2 | `favorite` (+10) shape undefined: per-garment bool in the original vs a `pairs/` line with `combo:[ids]` | `outfit_set.py:87,:436`; spec :115,:165-167,:193 | `kind: favorite|none` lines carry exactly one id; reader builds a `Set` of favourite ids (newest line per id wins); `buildCandidates` takes `favorites: Set`; rank checks `pieces.some(p => favorites.has(p.id))`. Family data has 0 favourites — forward-only | T1.2, T4.2 |
| W3 | `BAND_WARMTH` gating × the hub's "widen when < 2" is not composed; migrated tags carry int warmth | `clothing-worker.js:714-722,:612`; `outfit_set.py:181,:397,:402` | `eligible(cat, band)` = level gate per `BAND_WARMTH`; if a gated category (bottoms, singles — counted separately) has < 2, union with the neighbour band(s); if still empty, all of that category. Tags reader accepts warmth as int (1→warm, 2→cool, 3→cold) or word | T1.4, T2.3, T4.2 |
| W4 | Tile-repair / legacy-turn path rebuilds the catalogue entry from five fields and would drop attributes + hash | `clothing-worker.js:545-547,:565-573,:609-612` | `cat.items[f] = { ...(known || {}), id, ok: true, … }`; extend the repair test (`tests/clothing.test.mjs:365-386`) and legacy-turn test (`:434-445`) to assert attributes + hash survive with zero calls | T3.1 |
| W5 | A shared-tag hit that skips `askModel` loses the model's `top_side`/crop → a sideways photo on device B gets a sideways tile | `clothing-worker.js:410-413,:580,:599`; spec §5 tags line | Tags line gains optional `rotate_deg` and `crop` written by the device that made the call; a line without them = rot 0 (accepted, documented) | T4.2, T4.3 |
| W6 | Reply token budget 300 for anthropic/openai; the enlarged reply risks truncated JSON (`JSON.parse` throw → generic error → hourly retry spend) | `clothing-worker.js:463,:481,:501,:617-620` | Raise to 480 in the same change; keep "ONLY a JSON object, no prose" | T3.1 |
| W7 | `ingest()` returns `{done:0}` before any loop when there are no new photos — the family's existing wardrobe would never get attributes | `clothing-worker.js:547-548` | Restructure: compute todo → photo loop if any → needs-attributes loop → combined result with separate `attrsDone/attrsLeft` | T3.2 |
| W8 | Own writes must never create `<folderPath>/clothing/`: a side-effect mkdir turns "absent source = leave ours alone" (`drive.js:460`) into "empty source = prune the local wardrobe" (`:466-467`, `ADOPT_ON_FIRST_SYNC :173,:180`) — local-only photos gone for good | `drive.js:460,:466-467,:173-181,:424-431,:550`; `clothing.js:124-127` | `clothing-log.js` writes only when `statSync(<folderPath>/clothing).isDirectory()` already holds; mkdir only `.era/<kind>/<id>` beneath it; test: Drive folder without `clothing/` + local photos → own write is a no-op log line and a sync prunes nothing | T4.2, T4.4 |
| W9 | Same-length rewrites of a `.era` file are invisible to both mirrors (size-equal skip, no mtime) — the migration tool rewrites `tags/studio.jsonl` wholesale | `drive.js:447-449,:277-279`; empirical sync4 | Treat paths under `.era/` like manifests in both copy paths (byte compare locally, `md5Checksum` in API mode — ~2 KB files); extend `tests/drive-mirror.test.mjs` TREE with a `.era` subtree and a same-size rewrite case. Migration tool additionally always ends with a fresh marker line | T4.3, T4.4, T6.1 |
| W10 | The worker cannot discover the Drive folder or the family TZ on its own — a worker-thread `drive.js` instance has `DATA = null` and `status()` silently returns `{mode:'local', folderPath:''}` (`drive.js:38` swallows the TypeError); calling `drive.start()` in the worker would arm sync timers | empirical; `drive.js:38,:567-573`; `clothing.js:65-66`; `server.js:54-60,:2524` | `workerData` gains `tz`, `deviceId`, `driveFolder` resolved at spawn (TZ can change after `/setup`, `server.js:1350`); `clothing.start(DATA, {tz: () => TZ, deviceId})`; `driveFolder` from `drive.status()` gated exactly as `content.js:233-234` | T2.1, T4.3 |
| W11 | Computing picks/memory/sharing inside `status()` on every poll (Settings 5 s, board 3-15 s) risks the 900 ms bound of `clothing-responsive.test.mjs:84-95` on a Defender-scanned box | `clothing.js:32-47`; `public/settings/index.html:870`; `era-board/app/board.js:57` | Memoize the block in `clothing.js` keyed on `dayKey` + `statSync(historyPath).mtimeMs` + `size` (one stat per poll, well inside the bound) — **not** a TTL: a TTL makes a hand-seeded or mirror-delivered history.json invisible for up to a minute (T5.1's own verification seeds the file under a running hub) and needs a route→module invalidation hook | T5.1 |
| W12 | `sharing.devices` would list device ids (hostname slugs) on a public unauthenticated endpoint; the sibling `/content/status` deliberately omits device names | `server.js:2250-2254`; `content.js:1129-1131` | **Spec amendment:** `sharing: { mode, devices: <count> }` — count only; Settings only needs "Shared with: 2 devices" | T5.1, T5.2 |
| W13 | The "Clothing Picker card" of §4 does not exist; `#aiStatus` is overwritten wholesale by four exclusive branches (`aiPaint`); `sharing.mode` "local" collides with drive.js's `mode: "local"` (which means Drive-for-Desktop folder, and is the default even with no folder) | `public/settings/index.html:180-203,:855-867`; `drive.js:45,:51` | Dedicated `<div class="status" id="picksStatus">` under `#aiStatus`, painted before the branch chain from the same fetch; `sharing.mode = (drive.json.mode === "local" && folderPath) ? "drive" : "local"` derived without calling `drive.status()` | T5.1, T5.2 |

### A3. Info (constraints the implementer must reproduce)

- **Port budget reality (I1):** 8458-8462 are free and unreferenced in all five
  repos' tests; **8463 is occupied** by a hub from `era-hub--wt-install-qa` (pid at
  preflight); 8453 holds a hand-run hub. New rows: 8458 share hub, 8459 share fake AI,
  8460 sync-rebuild hub, 8461 status/read-out hub, 8462 attrs-suite fake AI (A4-7;
  no spare is left — a conflict is a §E STOP). The behavioural scratch hubs (T7.3)
  take two consecutive free ports ≥ 8464 by `ss -ltn`.
- **Payload cp list (I2):** `tools/build-payload.sh:23` is an explicit list; the
  guard at `:31-34` catches a missing `require("./x.js")` only at build time.
  `clothing-rank.js` and `clothing-log.js` go on the list in the commit that creates
  them (T1.1, T4.2).
- **Original details the spec omits (I3):** singles score a fixed 55.0 in `rank` and
  in the great-fallback staple sort; singles bypass `harmonizes`/style; the coverage
  slot tries only the single oldest garment (no fallback); age for a never-recorded
  garment is `1e6` (not `Infinity` — `Infinity − Infinity = NaN`); staples skip a combo
  sharing a garment with an already-taken staple; deep-page outer bound is
  `min(cap, pool.length)` and stops when a page adds nothing (`outfit_set.py:435,
  :465,:399-403,:497-518,:491,:543-556`).
- **h() (I4):** `BigInt("0x" + sha256(join("|",[seed,...parts])))` reproduces the
  Python exactly (cross-checked on three inputs). Sort by full hash with BigInt `<`
  or the 64-char hex string — a subtraction comparator throws.
- **§3.1 rule 4 is a deliberate deviation (I5):** original `is_neutral` is false for
  empty colours + empty pattern; the spec keeps such a pair. Implement inside
  `isNeutral`, label it in the module header, test separately from parity cases.
- **Yesterday (I6):** calendar arithmetic on the day key
  (`Date.UTC(y, m-1, d-1)`), never `now − 86400e3` formatted in the zone (DST).
- **derivePicks/events prune (I7):** string-compare date keys but skip keys not
  matching `^\d{4}-\d{2}-\d{2}$`; after pruning `days`, delete event dates below the
  oldest kept day key (when `days` is empty: keep the 60 most recent event dates).
- **Retired/too_big (I8):** the hub has no status; the migration tool writes the
  non-clean source filenames to a `do-not-copy.txt` beside the out `.era` dir
  (private output). **Never to stdout** — photo filenames in a hand-curated
  wardrobe can be garment names, and stdout ends up in workpads (§F).
- **recordOffer order (I9):** record `chosen.slice(0, perPage)` before rendering
  composites (parity with `outfit_set.py:1035`); a composite failure drops the tile,
  the offer still lists it.
- **clothing.test.mjs page-2 case (I10):** needs `days[yesterday].page1` seeded,
  not only `events`; loose ids (`item_top1`) must stay accepted by the pure module —
  only `/outfit-event` validates `^item_[0-9a-f]{4,32}$`.
- **Rendered vs algorithmic pages (I11):** a short algorithmic page shifts the flat
  list; rendered page 1 of a tiny wardrobe can repeat a garment — parity, not a bug.
  Garment-distinct assertions go on `chosen.slice(0, 7)` in the pure gate, never on
  rendered buttons at tiny sizes.
- **Pass picture (I12):** decode the existing 640 px tile and scale to 384 px rather
  than re-decoding a HEIC; `askModel`/`callModel` get an optional prompt argument
  defaulting to `INGEST_PROMPT` (the fake never inspects prompt text).
- **Stop conditions (I13):** in the pass, `break` on `/permanent/` or "allowance
  spent"; sleep only after a real call.
- **colors normalisation (I14):** accept array or string split on `, / & and`;
  lowercase-trim; cap 3; enum-check pattern/palette/vibe; `statement === true`;
  unknown → absent. `light blue` must survive as one entry.
- **fiveGarments() (I15)** copies one tile's bytes to all five photos — hash-keyed
  matching collides there; share tests seed distinct bytes.
- **Settings progress label (I16):** the pass posts its own `attrs:{done,total}`
  field, not `ingesting`.
- **Hub id = md5 of the path relative to `clothing/` including subfolders (I17)**
  — the migration tool hashes the relative path, not the bare filename.
- **pool.js day file is UTC (I18):** picks/offers files are named by
  `dayKey(now, tz)`; the merge reader keys the day off the file name.
- **Mirror leaves `.part` siblings and lists `.era` in `.mirrored.json` (I19):** the
  reader admits only `*.jsonl` with a date name.
- **`contentReady()` counts `.era` as clothing content (I20):** one-line dot filter
  at `drive.js:406`.
- **API-mode pull is 6 h (I21):** add "(6 h in API mode)" where §5 says 10 minutes.
- **boardIsFresh/holdDay use the OS clock (I22):** known residual; documented in
  T2.1, not fixed.
- **First tick after boot cannot see a removal that happened while the hub was down
  (I23):** seed `seenPhotos` from the last build's `.clothing-sig` in `start()`.
- **`ELLIE_WARDROBE_DIR` (I24):** dead seam that diverges the two writers' paths
  (`server.js:76-78` vs `clothing-worker.js:90`); unify on one path in T2.2.
- **Device id (I25):** precedence `ERA_DEVICE_ID` > `profile.deviceId` >
  `<DATA>/device-id` > generate-and-write; slug `/^[a-z0-9-]{1,32}$/`; validate
  what is read back; deterministic hostname-slug fallback if the file cannot be
  written; six suites rely on `ERA_DEVICE_ID=test-dev` staying first.
- **`dayKey` on Node 22.22.2 (I26):** `toLocaleDateString("en-CA", {timeZone})`
  yields `YYYY-MM-DD` and flips at the zone's midnight (verified).
- **No gate registration (I27):** `era-gate.sh:31-42` flat-copies `tests/` and
  globs `*.test.mjs`; helpers must be top-level in `tests/` and not match the glob.
- **Band under the gate (I28):** `ERA_GEO_URL`/`ERA_WEATHER_URL` are exported
  gate-wide to a dead port; any band-dependent test must run its own fake (the
  8446 shape in `clothing-weather.test.mjs:44-53`) and assert a positive band guard.

### A4. Spec amendments this plan assumes (reviewer: hold each gate to these)

1. §3.3 "two writers" → single writer on the main thread (B2). Same file, same shape.
2. §4 `sharing.devices` → a count, not ids (W12).
3. §5 tags line gains optional `rotate_deg`, `crop` (W5); `pairs/` `favorite`/`none`
   lines carry exactly one id (W2).
4. §3.2 `buildCandidates` sorts items by id before pooling (W1).
5. §3.1 item 3 keys on an `attrsAt` marker, at most once per item per day (B1).
6. §5 mirror: `.era/` paths are byte-compared, not size-compared (W9).
7. §8 adds `tests/clothing-log.test.mjs` (pure) and `tests/synthetic-wardrobe.mjs`
   (helper); the read-out hub test uses 8461; Phase 3's attribute-pass block lives
   in a new `tests/clothing-attrs.test.mjs` (fake AI on 8462) rather than inside
   `clothing.test.mjs`, which is already at 616.5 s of its 900 s ceiling
   (`gate/clothing.test.out`, 9/5) and gains Phase 2's regenerates first.
8. §3.1 item 3 "the same holdDay/allowance rules": `holdDay` stays **photo-only**
   (B1-c — a pass quota must not silence the photo retry, and the pass's counters
   stay out of `busy/quota/left/landed`). The pass gets the spec's *effect* another
   way: every real call in the pass, whatever its outcome (parsed, unparsable,
   429, 503), stamps the item `attrsTriedAt = today`, and the pass never asks an
   item whose `attrsTriedAt === today`. So the ladder is spent at most once per
   item per day across every intra-day door (regenerate, Sync now with a new
   photo, the morning tick) — which is what holdDay buys the photo path.
9. §5 "own writes … the local canonical is always written first" is honoured
   with **no local `.era` copy**: the local canonical for own picks/offers is
   `wardrobe/history.json` (§3.3, single writer per A4-1) and for own tags
   `wardrobe.json`; `clothing-log.js` writes only to the Drive mount.
   `<DATA>/clothing/.era/**` is the mirror's destination and the hub never
   appends there (a hub append would race the mirror's `.part`+rename,
   `drive.js:435-450` — the B2 class of bug). Own-id dirs in the mirror are
   skipped on read, as §5 says.
10. §3.2 events prune (I7) gains a **young-history guard**: the "delete event dates
    below the oldest kept day key" cutoff applies only once `days` holds its 60;
    while `days` is younger (a fresh install, the migration's first weeks) the
    events keep their 60 most recent dates instead. Without it the first recorded
    offer would wipe every pick migrated from before it (`clothing-rank.js`
    `pruneEvents`, tested in `clothing-rank.test.mjs` "a young days map").
11. §1 V3 "deeper pages garment-once-per-page" means once per **algorithmic**
    page — the `perPage` slots `buildCandidates` fills in one pass of
    `outfit_set.py:543-556`. On a tiny pool a page may run short (fewer than
    `perPage` looks fit garment-distinct), so a flat `slice(7,14)` of the returned
    list is only a page on wardrobes where every page fills; the variety gate's
    per-page assertions run on the 35-garment wardrobe where they do.
12. §3.1 item 4 "degrade, never exclude" is stated for MISSING attributes; the
    same floor now covers attributes the model DID supply. A wardrobe every
    garment of which the model called a statement piece has no harmonizing pair
    at all, and `buildCandidates` dealt only the dresses (reproduced: 8 tops ×
    7 bottoms all loud → 0 outfits). `clothing-rank.js` therefore drops the
    `harmonizes` predicate — `avoid` and the ranking stand — when the
    harmonizing deal cannot fill one page, which is spec §3.4's "a wardrobe must
    never empty the board" applied to the taste gate (P3 review r1).
    **The threshold is a PAGE, not emptiness** (P3 review r3; r2's nit was
    rejected on a `hot`-only measurement and the rejection was wrong in two of
    the five bands). Re-measured across every band the picker can be in, 35
    synthetic garments, all-loud vs the same wardrobe with ONE plain top, board
    length under the shipped empty-only trigger vs `pairs + singles < pageCap`:

    | band | all-loud | one-plain-top, empty-only | one-plain-top, page floor |
    |---|---|---|---|
    | hot | 21 | 12 | 12 |
    | warm | 21 | 18 | 18 |
    | cool | 21 | **6** | 21 |
    | cold | 21 | **6** | 21 |
    | null | 21 | 18 | 18 |

    `cool`/`cold` gate the bottoms to four, all loud, so the only harmonizing
    pairs are the four using that one plain top: 4 pairs + 2 eligible dresses =
    a SIX-look board — under one page, and 3.5× shorter than the all-loud
    wardrobe's, for a wardrobe the model described one garment better. The
    trigger is therefore `pairs.length + singles.length < pageCap` (the board is
    `min(cap, pool.length)` looks, so that reads "this deal comes up short of a
    page"), de-duplicated so a harmonizing pair is never dealt twice. Above a
    page the floor stays SHUT: `hot` 12 and `warm`/band-null 18 are unchanged,
    the ordinary 35-garment wardrobe deals a byte-identical board in all five
    bands, and a board that already holds a page of harmonizing looks is never
    padded with loud-on-loud ones. Below it a clash is offered rather than a
    short board, ranked last (`clothing-rank.test.mjs` "a deal shorter than a
    page opens the floor"). The remaining `hot` 21 → 12 step is the
    garment-once-per-page rule (`outfit_set.py:543-556`) meeting a pool whose
    every pair needs the same top, not the floor's threshold: that board's page
    1 is the five looks it could fill garment-distinct and every look after it
    re-uses that top, so it is A4-11's short page — spec §1 V3 holds per
    ALGORITHMIC page and a flat `slice(0,7)` spans two of them.
    `tests/clothing-variety.test.mjs` pins the board LENGTH per band (a `> 0`
    row cannot catch a six-look cold morning) and sweeps all five bands, which
    the r2 rows did not.
13. §3.1's source precedence ("1. shared tags … 3. the needs-attributes pass")
    inverts on the upgrade morning: the pass stamps `attrsAt` within minutes of
    first boot and `needsAttributes` never revisits a stamped garment, so a
    `tags/` line arriving on a later Drive pull can no longer replace what the
    local model said. **T4.3 decides and records** which it is: a `tagsFor`
    sweep independent of `needsAttributes` (a tag whose `t` is newer than
    `attrsAt` wins), or "place the migration tool's output before the upgraded
    hub's first build" as the documented expectation (P3 review r1 nit).

---

## B. Port table (new rows; existing 8391-8449 held by sibling suites, 8450-8457 hand-run)

| Port | Suite | Role |
|---|---|---|
| 8458 | `tests/clothing-share.test.mjs` | hub A (device id generated, no `ERA_DEVICE_ID`) |
| 8459 | `tests/clothing-share.test.mjs` | fake AI (counts calls, returns attributes) |
| 8460 | `tests/clothing-sync-rebuild.test.mjs` | hub |
| 8461 | `tests/clothing-status.test.mjs` | hub for the `/clothing/status` read-out |
| 8462 | `tests/clothing-attrs.test.mjs` | fake AI for the needs-attributes pass (A4-7) |
| ≥ 8464 | T7.3 scratch hubs | two consecutive free ports by `ss -ltn` (8463 is occupied): hub A, then hub B on the next one — never a same-port handoff |

`tests/clothing.test.mjs`'s own fake AI is pinned at **8416** — inside the
never-touch range, pre-dating this plan — so it now reads `ERA_TEST_AI_PORT`:
a run on a box where a sibling worktree holds 8416 (or a reviewer held to the
port rule) passes a free port instead, and the default is unchanged (r2).

`tests/pool.test.mjs` (T2.2 verification step 1) has the same seam for the same
reason: its hubs default to **8393/8394/8395**, inside the never-touch range, and
`ERA_TEST_HUB_PORT` moves all FOUR (`PORT`, `PORT + 1`, `PORT + 2`, `PORT + 3` — the fourth is
T4.1's unnamed-install hub) — e.g. `ERA_TEST_HUB_PORT=8466 node --test tests/pool.test.mjs` (r3).

Never touch 8377-8416, 8425, 8427, 8450-8457. Every spawned hub sets
`ERA_ELEVEN_URL ERA_FAL_URL ERA_GEO_URL ERA_WEATHER_URL ERA_RESEND_URL ERA_TMDB_URL
ERA_STREAMING_URL=http://127.0.0.1:1` and `ERA_BIND=127.0.0.1`. **Any hub given a
key in its DATA dir (T4.4 case 6, the attrs suite) is additionally spawned with
`ERA_AI_URL=http://127.0.0.1:<the suite's fake>`** — the gate leaves `ERA_AI_URL`
unset (`era-gate.sh:55-57`) and `clothing-worker.js:458` then falls back to the
provider's real endpoint, so a key in `ai-config.json` without the seam is a real
network call. The suite asserts that the fake's call counter is what moved.

---

## C. House guardrails (apply to every task; repeated only where a task adds to them)

- **TDD required** — red (test fails for the right reason) → green → refactor; the
  test file is in the same commit as the code.
- **Synthetic data only.** Invented garment names ("Sunny tee"), invented ids,
  invented history. Never a family-data file, never the family's names/colours/
  schedule in code, tests, logs, commit messages or this plan's retrospectives.
- **No keys.** Provider seams point at `http://127.0.0.1:1` or a suite-owned fake.
  A test that needs a key is a STOP.
- **Named git paths only** (`git add clothing-rank.js tests/clothing-rank.test.mjs`),
  never `git add -A`/`-u`; commit only in `era-hub--wt-clothing`; never touch another
  worktree; never stash.
- **Never start a hub on 8377-8416, 8425, 8427, 8450-8457.** The gate
  (`bash tools/era-gate.sh`) runs once machine-wide — check `flock`/`ps` first and
  never launch it while another gate is active.
- **Original is read-only reference**; the private repo is off limits except T6.1's
  named path.
- **The word that starts with "drop" and ends with "let" is banned** — say "the QA
  host" / "the build box".

---

## Task Skeleton

### Phase 1: `clothing-rank.js` — the pure port
**Posture hint:** implementing — the original is a line-numbered reference
implementation with a test file; every function has a byte-for-byte oracle.

1. [ ] **T1.1 Scaffold `clothing-rank.js` with constants, `h()`, `dayKey()`, `yesterdayOf()`; register in the payload**
   - **Acceptance:** `clothing-rank.js` (CommonJS, stdlib-only: `crypto` only; no
     `fs`, no `Date.now()`, no `Math.random`) exports `NEUTRALS` (11 entries incl.
     `"light blue"`), `HISTORY_DAYS_KEPT 60, FRESH_CAP_DAYS 8, FRESH_PTS_PER_DAY 6,
     LOVED_PTS 12, JITTER_PTS 16, STAPLE_SLOTS 2, STAPLE_POOL 5, YES_WEIGHT 1.0,
     INFERRED_WEIGHT 0.5, SINGLE_STYLE 55, BAND_WARMTH`, `WARMTH_LEVELS` (spec §3.4
     mapping: `hot → {1}, warm → {1}, cool → {2}, cold → {3}, any → {1,2,3}`; an
     int 1/2/3 accepted as-is for migrated tags, W3), `h(seed, ...parts)` →
     BigInt, `hmod(seed, n, ...parts)` → Number, `dayKey(now, tz)`,
     `yesterdayOf(dayKey)` (calendar arithmetic per I6). Module header documents the
     original's line ranges and the two labelled deviations (I5, W1).
     `tools/build-payload.sh:23` lists `clothing-rank.js`.
   - **Verification:**
     1. `cd /home/claude/new-era/era-hub--wt-clothing && node --test tests/clothing-rank.test.mjs` — `# pass ≥ 6`, `# fail 0`; cases: `h("2026-09-05","item_a+item_b") % 16n` equals the value the implementer computes with `python3 -c 'import hashlib; print(int(hashlib.sha256(b"2026-09-05|item_a+item_b").hexdigest(),16) % 16)'` (record both numbers in the test as a literal); `dayKey(Date.UTC(2026,8,5,6,30), "America/Los_Angeles") === "2026-09-04"` and `07:30Z → "2026-09-05"`; `yesterdayOf("2026-03-09") === "2026-03-08"` (day after spring-forward) and `yesterdayOf("2026-03-01") === "2026-02-28"`.
     2. `grep -nE "Math\.random|Date\.now|require\(.fs.\)" clothing-rank.js; echo rc=$?` — prints nothing, `rc=1`.
     3. `grep -c "clothing-rank.js" tools/build-payload.sh` — `1`.
   - **Guardrails:** TDD (write the h() vector test first — it is the parity anchor). Only `crypto` may be required. §C.
   - **Gate:** structure reviewed with T1.5 (single phase gate).

2. [ ] **T1.2 `attributes()`, `isNeutral()`, `harmonizes()`, `styleScore()`**
   - **Acceptance:** `attributes(meta)` whitelist per I14 returns
     `{colors:[…], pattern?, statement:bool, palette?, vibe?}` with unknowns absent;
     `isNeutral(g)`: original rule (`pattern ∈ {solid, denim}` OR any colour exactly
     in `NEUTRALS`) **plus** the hub degradation rule (no colours and no pattern and
     `!statement` → neutral), labelled; `harmonizes(top,bottom)` per
     `outfit_set.py:246-252`; `styleScore(top, bottom, pairing)` (the favourite lift is `rankOf`'s, `outfit_set.py:436`): base 50;
     `avoid` → −1000 immediately; `great` +30; statement≠statement +15, both basics
     +5; palettes both set: neutral-or-same +10, `{warm,cool}` −10; same non-empty
     vibe +5. `pairing` is `{great:Set<key>, avoid:Set<key>}` keyed by the
     **unordered** pair (sorted ids joined `+`). Favourite lift (+10) lives in
     `rank`, not here, reading `favorites: Set<id>` (W2).
   - **Verification:** `node --test tests/clothing-rank.test.mjs` — new cases pass: two statements never harmonize; statement + non-neutral basic fails, statement + neutral passes; `avoid` pair scores −1000 even when also `great`; `great` = 80; palette warm+cool = 40 for two basics (50+5−10... implementer records the arithmetic as literals); same vibe +5; a garment with no attributes at all pairs with a statement piece under the degradation rule (separate `describe`, labelled "hub deviation"); `attributes({colors:"pink and white, Light Blue"})` → `["pink","white","light blue"]`; `attributes({statement:"true"}).statement === false`.
   - **Guardrails:** TDD. Parity cases cite `outfit_set.py` line numbers in comments; the degradation case is in its own block so a future parity audit can skip it. §C.
   - **Gate:** with T1.5.

3. [ ] **T1.3 `derivePicks()`, `recordOffer()`, history shape tolerance**
   - **Acceptance:** `derivePicks(events, before)` — only dates `< before` (string compare, keys matching `^\d{4}-\d{2}-\d{2}$`, non-list values skipped); per day the SET of Yes combo keys each +1.0; if no Yes, the LAST select +0.5; combo key = ids joined `+` in the order given (never re-sorted — matches the worker/original). `recordOffer(history, date, combos, perPage, band)` mutates and returns `history`: `days[date] = {band, page1: combos.slice(0, perPage).map(c => c.pieces.map(p => p.id))}`; keeps the 60 lexicographically-latest day keys; then prunes `events` per I7. A history with no `days` or no `events` key is treated as empty maps. `lastPage1(history, before)` and `yesterdayPage1(history, dayKey)` helpers return per-garment last-page-1 date map and the Set of yesterday's combo keys (flattening combos per `outfit_set.py:415-428`).
   - **Verification:** `node --test tests/clothing-rank.test.mjs` — the original's picks scenario: day −2 `select A+B` then `yes C+D`, day −1 `yes C+D` then `select A+B` (no yes → last select), today `yes A+B` (excluded) → `C+D = 2.0`, `A+B = 0.5`... implementer transcribes `variety_test.py:178-196` exactly and asserts `2.0 / 1.5 / today excluded` as that file does; `recordOffer` on 61 days keeps 60 and drops events older than the oldest kept day; `recordOffer({}, …)` works; `derivePicks({"garbage":[…], "2026-09-01":"x"}, "2026-09-05")` → `{}`.
   - **Guardrails:** TDD. No id validation in this module (I10). §C.
   - **Gate:** with T1.5.

4. [ ] **T1.4 `buildCandidates()` — pool, rank, staples, coverage, fill, relaxation, deep pages**
   - **Acceptance:** `buildCandidates({items, band, cap, seed, pairing, favorites, history, perPage})` returns a flat ordered list of `{key, pieces}` (pieces `[top, bottom]` or `[one]`) per `outfit_set.py:381-557` with: items sorted by `id` first (W1); category map `top→top`, `pants|shorts→bottom`, `dress|set→single`; `eligible(items, cat, band)` per W3 (tops never gated; `band == null` → no gating); pool = singles (in id order) then pairs in tops×bottoms nested order kept iff `harmonizes && styleScore > 0`; `rank` = style (`SINGLE_STYLE` for singles) + fav 10 + fresh + loved + jitter (no dressy); stable sort desc; staples per `:459-492` (BigInt/hex comparison, I4); coverage slot per `:497-518` with age `1e6` for never-seen and **no fallback** past `aged[0]`; page-1 fill with the yesterday bar, tiny-pool relaxation; deep pages `demoted` first, garment-once-per-page, bound `min(cap, pool.length)`, break when a page adds nothing; `slice(0, cap)`. Also exports `eligible` and `toWorkerShape(combo)` (`pieces.length === 1 ? {key, one} : {key, top, bottom}`).
   - **Verification:** `node --test tests/clothing-rank.test.mjs` — unit cases: an `avoid` pair is absent from the pool; a single never passes through `harmonizes`; a never-seen garment has `fresh 48`, an 8-day-old one `48`, a 3-day-old one `18`; `loved` applies at 2.0 not 1.5; the coverage case of I3 (oldest garment's only looks were on yesterday's page 1 → the slot goes to the fill, `aged[1]` is not tried); **gating, positive and negative (spec §3.4):** hot band, 3 `hot` + 1 `cold` bottoms → the cold bottom is **absent** from `eligible("bottom", "hot")` and from every combo of the 21; hot band, 1 `hot` + 2 `warm` bottoms → the warm bottoms are present (neighbour union, W3) and a `cold` one still absent; a `warmth: "any"` bottom is eligible in all four bands; a bottom with int warmth `3` behaves as `cold`; hot band with a wardrobe of two `cold` bottoms → both bottoms still eligible (widen → all); `band: null` → nothing gated; `eligible("top", "cold")` returns every top including `warmth: "hot"`.
   - **Guardrails:** TDD. Port line-for-line; keep the original's comments' intent as JS comments citing `outfit_set.py:NNN`. Precompute rank into a `Map` by key. Never `Infinity` in a comparator. §C.
   - **Gate:** with T1.5.

5. [ ] **T1.5 `tests/clothing-variety.test.mjs` — the ported gate + `tests/synthetic-wardrobe.mjs`**
   - **Acceptance:** `tests/synthetic-wardrobe.mjs` (helper, not matched by the glob) exports `makeItems({n:35, seed})` → 17 tops / 12 bottoms / 3 dresses / 3 sets, 9 statement, warmth words mapped from the original's int mix (28 × level 1, 7 × level 2), invented names, all attributes, ids `item_` + 10 hex; and `makePairing()` → 14 great / 1 avoid over those ids. `tests/clothing-variety.test.mjs` runs the pure module for 14 days × {warm, hot} with `recordOffer` between days and asserts exactly `variety_test.py:89-132`: every eligible garment on page 1 (`chosen.slice(0,7)`) within 10 days; zero page-1 combo overlap on consecutive days; ≥ 80 % of yesterday's page 1 still offered somewhere in today's 21; page 1 garment-distinct; 21 a day; determinism on day 1 (two calls, deep-equal). Plus: **same-day rebuild identical** (same seed + same history → same list, after events for "today" were added → still identical); **shuffled item order → identical key list** (W1); **yesterday's page-1 looks lead page 2** (indices 7-13 start with yesterday's combos in ranked order); **a Yes from a deep page (not in yesterday's page 1) is seated on page 1 as a staple**; **deeper pages are garment-once-per-page (spec §1 V3 / §3.2, `outfit_set.py:543-556`)**: for every day and both bands, `chosen.slice(7,14)` and `chosen.slice(14,21)` are each garment-distinct on the full 35-garment wardrobe (the only test of that rule anywhere — a port that repeats a garment on page 2 passes every other check); **zero-attribute wardrobe fills 21 (spec §3.1 item 4, I5 — in the labelled "hub deviation" block)**: `makeItems()` with `colors/pattern/statement/palette/vibe` stripped and an empty pairing → `buildCandidates` returns 21, page 1 garment-distinct, and every two-piece pool entry has `styleScore === 55` (50 + two basics 5; no palette, no vibe); **no `Math.random`/`Date.now` in `clothing-rank.js`** (grep from the test).
   - **Verification:** `node --test tests/clothing-variety.test.mjs` — `# pass ≥ 12`, `# fail 0`, `# duration_ms < 5000`; the deep-page and zero-attribute test names contain "garment-once" and "no attributes".
   - **Guardrails:** TDD (write the 14×2 loop first with the parity assertions; expect red until T1.4 lands, then green). Synthetic names only. The helper must be importable as `./synthetic-wardrobe.mjs` from a flat copy (I27) and runnable as a CLI (`node tests/synthetic-wardrobe.mjs --materialize <DATA> [n]`) for T4.4/T7.3 — the materialize half (tiles + photos + `wardrobe.json`) is added in T4.4. §C.
   - **Gate:** `rae-flow:reviewing` — **Scope:** `clothing-rank.js` + both pure suites against spec §3.1 rule 4, §3.2, §3.4, §4 (loved/staples), §8 first two bullets, and `outfit_set.py:61-73, 242-557` for parity. **Pass criteria:** every constant and order-of-operations item in A3-I3 is present and cited; deviations are exactly A4 item 4, I5 and the two labelled hub-side defaults D1/D2 in the module header (unknown warmth word → never gated; unknown band word → gates nothing — input the hub never produces, accepted in review r1); no fs/Date/random in the module. Then **Phase 1 retrospective** in the workpad.

### Phase 2: memory + worker integration
**Posture hint:** implementing — the surgery is bounded to `clothing-worker.js:814-842`, `clothing.js`, `server.js` lines named by preflight; every change has a named test.

6. [ ] **T2.1 Plumb `tz` / `deviceId` / `driveFolder` into the worker; seed `seenPhotos`**
   - **Acceptance:** `clothing.start(DATA, opts)` accepts `{tz: () => string, deviceId: string}`; `server.js:2524` passes `{tz: () => TZ, deviceId: DEVICE_ID}`; `clothing.js:65-66` spawns with `workerData: {dataDir, force, rebuildOnly, tz, deviceId, driveFolder}` where `driveFolder` is `st.mode === "local" && st.folderPath ? st.folderPath : null` from `drive.status()` resolved **at spawn** (W10; `drive` required in `clothing.js` the way `content.js:233` does — never inside the worker). `tz` defaults to `"America/Los_Angeles"` when the getter is absent — so any in-process suite that seeds "yesterday"/"today" by wall clock **must** pass its own `tz` and derive its day keys from the same zone (T2.4); the build box is `Etc/UTC` and `tests/clothing.test.mjs:770`'s OS-zone `dayAgo()` disagrees with LA between 00:00 and ~07:00 UTC. `start()` seeds `seenPhotos` from the stored photo-set string beside `.clothing-sig` (I23; the worker writes it next to the sig). `boardIsFresh`/`holdDay` stay OS-clock — documented in the `start()` comment (I22).
   - **Verification:** `node --test tests/clothing.test.mjs` — existing tick tests green (`:553-621`); new case: after a build, `clothing.start(TMP, {noTimers:true})` a second time, remove one photo, `tick()` returns a promise (a rebuild), not `null`. `node --test tests/content-worker.test.mjs` green (`:407-464`).
   - **Guardrails:** TDD for the seed case. No `drive.start()` in the worker; no `require("./drive.js")` in `clothing-worker.js` (grep in the test). §C.
   - **Gate:** with T2.4.

7. [ ] **T2.2 Single-writer `wardrobe/history.json` (B2) + `writeAtomic` + one path**
   - **Acceptance:** `clothing.js` owns `historyPath = <DATA>/wardrobe/history.json` and exports `historyPath`/`readHistory`/`zone`; `recordOffer(offer)` (RMW with `clothing-rank.recordOffer`, `contentStore.writeAtomic`) stays PRIVATE to the `{offer}` handler — one fewer public writer on a single-writer file, and `server.js`'s `/outfit-event` needs only the three exports (amended after review r2, which found the literal wording unmet; `zone()` is exported so both doors bucket by the same validated family zone). The worker never writes history.json — it posts `{offer:{date, band, page1}}` on `parentPort` before rendering composites (I9); `clothing.js:67-81` handles `m.offer`. `server.js` `/outfit-event` reads/writes through the same path via `writeAtomic`, keeps the 200-events-per-day cap (`server.js:1506`), and on a parse failure of a non-empty file renames it to `history.json.bad-<ts>` and logs instead of overwriting with `{}`. `ELLIE_WARDROBE_DIR` (I24): removed if `grep -rn ELLIE_WARDROBE_DIR --include=*.js --include=*.mjs --include=*.sh --include=*.ps1 .` finds only `server.js:76,78`; otherwise the same env is threaded into `clothing.js` — the two paths can never disagree.
   - **Verification:**
     1. `node --test tests/pool.test.mjs` — green (`h.events[HDAY].length === 1` still holds).
     2. `node --test tests/clothing.test.mjs` — new case: seed `events[today]` with one Yes, `regenerate(true)`, read history.json → `events[today]` unchanged and `days[today].page1.length === 7` (or the wardrobe's page size) and `days[today].band === null` (weather offline). `today` here is the suite's `ZONE` day key (T2.4), the same zone the module was started with.
     3. `grep -n "history.json\|writeFileSync" clothing-worker.js | grep -v "^.*//"` — no history.json write in the worker.
   - **Guardrails:** TDD. Both writes on the main event loop; no lock code. Never `writeFileSync` on history.json anywhere after this task. §C.
   - **Gate:** with T2.4.

8. [ ] **T2.3 Worker surgery — deterministic deal, tops ungated, retire `clothing-history.json`**
   - **Acceptance:** `clothing-worker.js:814-842` (loadHistory/shown, `Math.random` sort, `staplesFor`, the two fills, OS-zone `dayStr`, epoch-day rotation) replaced by: `band` → `eligible` sets from `clothing-rank` (tops never gated; bottoms/singles gated with widen, W3) → read history.json (local canonical; merged-log reads arrive in T4.3) → `buildCandidates({items, band, cap: PER_PAGE*PAGES, seed: dayKey(Date.now(), workerData.tz), pairing, favorites, history, perPage: PER_PAGE})` → `toWorkerShape` → post `{offer}` → composites/boards **unchanged from `:844` on**. `HISTORY()` (`:67`), `loadHistory/saveHistory` (`:78-81`), `PICKS/derivePicks/staplesFor` (`:90-120`) deleted; `regenerate()` runs `fs.rmSync(path.join(DATA, "clothing-history.json"), {force:true})` once. Items enter `buildCandidates` with `warmth` word and attributes from the catalogue.
   - **Verification:**
     1. `grep -nE "Math\.random|Date\.now\(\) ?/ ?86400000|clothing-history" clothing-worker.js` — only the `rmSync` line mentions `clothing-history`; no `Math.random`. `grep -n 'en-CA' clothing-worker.js | grep -vc timeZone` — `0` (every `en-CA` call carries `timeZone`; today's offender at `:822` has a trailing comment, so an end-of-line-anchored pattern would never have caught it).
     2. `node --test tests/clothing.test.mjs` — after the first build in the favourites block, `fs.existsSync(TMP/clothing-history.json) === false`; two same-day `regenerate(true)` calls produce identical `allCombos()` (the T2.4 helper: all 21 across `today|today_2|today_3`, 21-for-21 deep-equal — not page 1 only).
     3. `node --test tests/clothing-weather.test.mjs` — green (rewritten in T2.4).
   - **Guardrails:** TDD (write the same-day-identical and file-gone assertions first). Composite geometry, `SLOTS`, confirm boards, More/Build untouched — `git diff --stat clothing-worker.js` must show no hunk after the composite loop other than the `{offer}` post. Weather offline in tests = `band null` = no gating; do not "fix" that. §C.
   - **Gate:** with T2.4.

9. [ ] **T2.4 Update `tests/clothing.test.mjs` favourites block and `tests/clothing-weather.test.mjs` (tops ungated)**
   - **Acceptance:** **one clock for the suite:** a header constant `ZONE`, stated once with its reason and picked so it is **neither of the two wrong answers**: not the box's own zone and not the module's default (LA). `const ZONE = "UTC"` was the original wording and it is wrong — the build box IS `Etc/UTC`, so a worker that ignored `workerData.tz` and read the OS clock dealt byte-identical seeds, `days` keys and boards, and the whole T2.3 zone change had zero test bite (amended after review r4). Take the two ends of the world's calendar dates (`Pacific/Kiritimati` +14, `Etc/GMT+12` −12) and use the first that differs from both; between 00:00 and ~07:00 UTC only two dates exist anywhere and the box and the module hold one each, so in those hours take the first that differs from the box. `:125` becomes `clothing.start(TMP, { tz: () => ZONE })`; `dayAgo(n)` at `:770` and every `today`/`yesterday` key are rewritten over `dayKey(Date.now(), ZONE)` and `yesterdayOf()` from `clothing-rank.js` (never `toLocaleDateString` in the OS zone, never `now − n×86400e3` formatted in a DST zone — I6). **`allCombos()` helper** beside `firstCombos()` (`:784-789`): the outfit buttons of every board whose id matches `/^today(_\d)?$/`, in board order then `load` order, as `combo.join("+")` — the 21-for-21 comparator used by T2.3 v2, T4.4 case 7 and T7.3 step 4. `writePicks(events, days)` writes `{days, events}`; `:807-818` rewritten: yesterday's page-1 Yes (seeded in both `events[yesterday]` and `days[yesterday].page1`) is **absent from page 1** and **first on `today_2`**, and `allCombos()` identical after a same-day rebuild; new case: a Yes in `events[yesterday]` whose combo is **not** in `days[yesterday].page1` (seed `page1: []` explicitly) leads page 1 as a staple; `:820-833` kept with `days[yesterday] = {band:null, page1:[]}` written explicitly. Rendered-button assertions never claim garment-distinctness at 5 garments (I11). `clothing-weather.test.mjs`: the wardrobe (`:106-109`: one `any` top, one `any` bottom) gains a `cold` top, a `hot` bottom **and a `cold` bottom** (three tiles, distinct bytes); under the 14-17 window (80° → `hot`) the cold top still appears in the lineup, the hot bottom appears, **and the `cold` bottom is absent from every combo of every board** (the `any` + `hot` bottoms make two hot-eligible bottoms, so no widening — the one rendered negative gating assertion, spec §3.4); under 9-12 (67° → `warm`) the `cold` top still appears; positive guard `assert.ok(tile().label.includes("hot"))` (I28); `rm .weather-cache.json` between rebuilds as `:126` does; `aiCalls === 0` throughout.
   - **Verification:** `node --test tests/clothing.test.mjs` — `# fail 0`, `# duration_ms < 720000` (the one ceiling, §E; measured 616.5 s before this plan, Phase 2 budget ≤ 60 s of regenerates); `node --test tests/clothing-weather.test.mjs` — `# fail 0`, the new tests' names contain "tops never gated" and "cold bottom absent". `grep -c 'toLocaleDateString("en-CA")' tests/clothing.test.mjs` — `0`.
   - **Guardrails:** TDD (rewrite the assertions red first against the old worker if T2.3 is not yet merged locally — otherwise write them to fail on a deliberately wrong index and then correct). Non-hex ids stay (I10). Budget: at most 4 added regenerates in `clothing.test.mjs`. §C.
   - **Gate:** `rae-flow:reviewing` — **Scope:** T2.1-T2.4 against spec §1 rows V2-V5, F1-F3, H1, §3.3 (as amended A4-1), §3.4, §3.5's "same-day rebuild reproduces", §6 step 1-2, §8 "Updates". **Pass criteria:** worker has no random/OS-zone/epoch-day code; one writer; boards byte-identical in shape; suites green within budget. Then **Phase 2 retrospective**.

### Phase 3: attributes at ingest + the needs-attributes pass
**Posture hint:** implementing — prompt text, whitelist and pass placement are fully specified by spec §3.1 and preflight B1/W4/W6/W7.

10. [ ] **T3.1 `INGEST_PROMPT` + `attributes()` at ingest + `hash` + repair-path preservation + fake-AI update**
    - **Acceptance:** `INGEST_PROMPT` asks for `colors, pattern, statement, palette, vibe` with the exact vocab of spec §3.1 item 2 and "ONLY a JSON object, no prose"; anthropic/openai output budgets `:463,:481` → 480; the catalogue literal `:609-612` becomes `{ ...(known || {}), id, ok:true, name, rotate_deg, crop, exif, category, warmth, ...attributes(meta), hash, attrsAt }` where `hash` = sha256 hex of the photo bytes (one `readFileSync`, or the Buffer refactor of `readImageRgba`/`photoOrientation`) and `attrsAt = dayKey` after a successful answer; the repair/legacy-turn path preserves attributes + hash (W4). Tests: `ANSWERS` (`:52-56`), every `forceAnswer`, `clothing-responsive.test.mjs:40`'s JSON gain the five keys; every hand-seeded entry gains `attrsAt` (or attributes) — including `fiveGarments()`, the ghost, the long-label and tie pairs, `clothing-weather.test.mjs:107-108`. The fake records the text part so one test proves the prompt now asks for colours.
    - **Verification:** `node --test tests/clothing.test.mjs` — `assert.equal(calls, 3)` at `:155` holds; the repair test (`:365-386`) and legacy-turn test (`:434-445`) additionally assert `colors`, `hash`, `attrsAt` survive with `calls === before`; a new case: an item catalogued through the fake has `colors.length ≥ 1`, `statement === false`, `hash` 64 hex; the prompt-text assertion passes. `node --test tests/clothing-responsive.test.mjs` green.
    - **Guardrails:** TDD. Attributes never enter `recipes/today.json` (assert in the same test: `JSON.stringify(recipe)` contains no `"colors"`). `attributes()` is imported from `clothing-rank.js`, not re-implemented. §C.
    - **Gate:** with T3.2.

11. [ ] **T3.2 The needs-attributes pass (spec §3.1 item 3) under the allowance rules**
    - **Acceptance:** inside `ingest()` after the photo loop and **before** the `{done:0}` return (W7): for every `ok` item with a tile, no attributes (`!item.colors && !item.pattern`), `attrsAt !== today` **and `attrsTriedAt !== today`** (A4-8), once per item per day: shared-tag lookup first (T4.3 wires it; here a no-op hook `tagsFor(id, hash)` returning null), else `askModel` with the tile scaled to 384 px (I12) and an optional prompt argument; **every real call stamps `attrsTriedAt = today` before its outcome is known** (parsed, unparsable, 429, 503 alike — the ladder is spent at most once per item per day across every intra-day door); on success write `attributes(meta)` + `attrsAt`; on any answer that parses but carries no attributes still set `attrsAt` (asked today, don't loop); `break` on `/permanent/` or "allowance spent" (I13); count 429/503 into `attrsLeft`; sleep `ERA_AI_SPACING_MS || 5000` only after a real call (seam beside `ERA_AI_URL`, `:458`); post `{attrs:{done,total}}` progress (I16); result gains `attrsDone/attrsLeft` and **does not** alter `busy/quota/left/landed` (`:638-640`) — `holdDay` stays photo-only (A4-8, the recorded deviation from spec §3.1 item 3's "same holdDay rules"). Not run on `rebuildOnly`; not run without a key (inherits `:532`).
    - **Verification:** `node --test tests/clothing-attrs.test.mjs` — **new suite** (A4-7: in-process like `clothing.test.mjs`, its own fake AI on **8462**, `ERA_AI_URL=http://127.0.0.1:8462` and `ERA_AI_SPACING_MS=50` set in `before()`, `ZONE` per T2.4): seed 3 attribute-less items with tiles + one key; `regenerate(true)` → `calls` +3, all three carry `colors`, `attrsAt === today` and `attrsTriedAt === today`; a second `regenerate(true)` the same day → `calls` +0; a `rebuildToday()` → `calls` +0; **with the fake returning 429 for all models on 3 fresh attribute-less items → `attrsLeft === 3`, `r.quotaHit` false (photo-only), `holdDay` unset (tick still runs next hour: `pendingPhotos() === 0` so no retry either), all three carry `attrsTriedAt === today` and no `attrsAt`; then a second `regenerate(true)` the same day → `calls` +0 (the ladder is not re-spent); setting `attrsTriedAt` to yesterday on one item → the next `regenerate(true)` makes exactly 1 call**; `throttleModel` 503 counter: the pass breaks after the ladder is spent, not after 3×ladder. `# fail 0`, `# duration_ms < 300000`. `node --test tests/clothing.test.mjs` unchanged by this task: `# duration_ms < 720000`.
    - **Guardrails:** TDD. Keep `chosenModel/spentModels` shared (no second ladder). Never re-decode a HEIC in the pass. Nothing from this task is added to `clothing.test.mjs` (budget, A4-7). §C.
    - **Gate:** `rae-flow:reviewing` — **Scope:** T3.1-T3.2 against spec §3.1 items 2-4, §1 V1 (attributes present), A4-5, A4-7, A4-8. **Pass criteria:** every existing `calls` pin unchanged; degradation rule reachable (a wardrobe with zero attributes still yields 21 — the T1.5 "no attributes" case, run again here); the 429 pass provably does not re-spend the ladder the same day; no family text in logs. Then **Phase 3 retrospective**.

### Phase 4: sharing through the Drive mirror
**Posture hint:** implementing, with an escape hatch — switch to collaborating if `drive.js`'s local-mode copy semantics differ from preflight claim (3) when the `.era` byte-compare is added (W9), or if the hostname on the build box does not slug under the regex.

12. [ ] **T4.1 Per-install device id shared by `pool.js` and the clothing log**
    - **Acceptance:** new `device-id.js` (stdlib) exports `resolveDeviceId(DATA, {env, profile, hostname})` (`hostname` injectable, default `os.hostname()`): precedence I25; generated form `<hostname-slug>-<4 hex>` (slug: lowercase, `[^a-z0-9-]→-`, trim `-`, cut so the whole id ≤ 32); reads back `<DATA>/device-id` and regenerates if it fails `/^[a-z0-9-]{1,32}$/`; on write failure returns the hostname slug without hex and logs once. `server.js:67` uses it synchronously before `initPool`. `/setup` doc comment says a `deviceId` change needs a restart. `tools/build-payload.sh:23` lists `device-id.js`. **The gate's shared hub gets `ERA_DEVICE_ID=gate` on its launch line (`tools/era-gate.sh:67`, same commit)**: that hub's DATA defaults to `era-family/test-data` (`era-gate.sh:9`) and is launched without a device id today, so without this the first T7.1 run would generate a `device-id` file carrying the build box's hostname slug inside the private repo's working tree — a second era-family side effect this plan forbids (header: T6.1 is the only one).
    - **Verification:** `node --test tests/device-id.test.mjs` (new, pure): env wins; profile beats file; file created once (two calls → same id, file mtime unchanged); a corrupted file (`"HUB!!"`) is replaced; read-only DATA → deterministic slug, no throw, with `hostname: "Family-PC.local"` injected so the log line carries the fixture slug, never the real one; slug of `"Family-PC.local"` matches the regex. `node --test tests/pool.test.mjs` green — and it gains the case spec §8's "`tests/pool.test.mjs` device id" row actually asks for: a fourth hub (`PORT + 3`) spawned with `ERA_DEVICE_ID` **deleted** from the child env, one POST `/log`, and the event's `device` plus its `pool/events/<device>/` directory asserted equal to `<DATA>/device-id` and not `"hub"`. The pre-existing `test-dev`/`tz-dev` hubs all pass an id, which is the one precedence branch that behaved identically before this change, so "the suite stays green" was no coverage at all (review r1). `grep -n "ERA_DEVICE_ID=gate" tools/era-gate.sh` — `1` hit on the `node "$HUB/server.js"` line.
    - **Guardrails:** TDD. Never print the real hostname in test output (inject fixture names). `tools/era-gate.sh` is edited on that one line only. §C.
    - **Gate:** with T4.4.

13. [ ] **T4.2 `clothing-log.js` — append, merge-read, torn-line, self-dedupe, never throws**
    - **Acceptance:** exports `openLog({dataDir, driveFolder, deviceId, tz})` → `{appendPick(day, line), appendOffer(day, line), appendTag(line), readMerged(today), tagsFor(merged, id, hash)}`. **Writes — the mount only (A4-9):** `<driveFolder>/clothing/.era/<kind>/<own-id>/<date>.jsonl` (tags: `.era/tags/<own-id>.jsonl`), and only if `driveFolder` is set **and** `statSync(join(driveFolder,"clothing")).isDirectory()` (W8); mkdir only `.era/<kind>/<id>` beneath it; every write appends one `\n`-terminated JSON line (bytes always grow); any error → one `console.warn` line, return false, never throw; `driveFolder: null` (API mode / no folder) → returns false, one log line at `openLog` time, no per-append noise. **This module never writes under `<DATA>`**: the local canonical for own picks/offers is `wardrobe/history.json` (single writer, T2.2) and for own tags `wardrobe.json`; `<DATA>/clothing/.era/**` is the mirror's own destination (`drive.js:461`, `copyTreeLocal` recursing into dotdirs `:435-450` with `.part`+rename) and a hub append there would be a second writer on the mirror's file — B2's class of bug. Files named by `dayKey` (I18). **Reads:** walk `<DATA>/clothing/.era/**` admitting only `*.jsonl` with a `YYYY-MM-DD` or writer name (I19), **skip the own-id dirs** (own lines come from history.json/wardrobe.json, merged by the caller — T4.3), skip date files older than `HISTORY_DAYS_KEPT` before `today`, tolerate a torn last line (`pool.js:71-77` pattern) and a missing dir; **skip any line with `kind: "marker"` (T6.1's re-run marker, W9) or lacking its kind's required field** (picks: `combo` array of strings; offers: `page1` array; tags: `id` or `hash` string; pairs: `combo`) — a skipped line never counts as "the last line of a date", so a marker at the end of an offers file leaves that day's page 1 as the previous line's; return `{picksEvents: {date:[{kind,combo}]}, offers: {date:{band, page1}}, tags: Map<id|hash, line>, pairing: {great:Set, avoid:Set}, favorites: Set<id>}` with union rules from spec §5 (one credit per combo per day; offers: last valid line per date per device, page1 = union across devices; tags newest per id then hash, warmth int→word W3; pairs newest per unordered key; `favorite`/`none` per single id, newest wins). `tagsFor(merged, id, hash)` looks up by `id` first, else by `hash` (spec §3.1 item 1). `tools/build-payload.sh:23` lists `clothing-log.js`.
    - **Verification:** `node --test tests/clothing-log.test.mjs` (new, pure, temp dirs, no ports): own line lands in the mount when it has `clothing/` and **nothing appears under `<DATA>/clothing/.era`** (assert `!existsSync`); **no mount write and no mkdir of `clothing/`** when it is absent (W8 — assert `!existsSync(join(driveFolder,"clothing"))` afterwards); `driveFolder:null` → returns false, no file anywhere, no throw; unwritable mount → returns false, no throw; torn last line skipped and the rest read; own-id dir in the mirror ignored (seed a picks line under the own id → absent from `readMerged().picksEvents`); **a `{"kind":"marker"}` as the last line of `offers/dev-b/<yesterday>.jsonl` → that day's page1 is the preceding line's, not empty**; a tags line with only `hash` → `tagsFor(merged, "item_other", hash)` hits; a line with both where the id differs → hash hit; tag with `warmth: 2` reads as `"cool"`; `favorite` then `none` for the same id → not favourite; pairs with ids in either order collapse to one key; files older than 60 days ignored; a picks line without `combo` is skipped without a throw.
    - **Guardrails:** TDD. No `require("./drive.js")`. No `mkdirSync(..., {recursive:true})` whose target is above `.era`. `grep -n "dataDir" clothing-log.js` shows read paths only — no `appendFileSync`/`writeFileSync` whose target is under `dataDir`. Synthetic ids only. §C.
    - **Gate:** with T4.4.

14. [ ] **T4.3 Wire the log: worker + server + `onSynced → tick` + mirror byte-compare for `.era`**
    - **Acceptance:** worker: `readMerged(today)` feeds `buildCandidates` (`history.events` ∪ `picksEvents`, `history.days` ∪ `offers`, `pairing`, `favorites` — own picks/offers come from history.json, every other device's from the mirror, A4-9); after posting `{offer}` it appends one `offers/` line to the mount (own id; no local `.era` copy); `tagsFor(merged, id, hash)` is consulted **before** `askModel` in both the photo loop and the pass — a hit records attributes + `attrsAt` + `rotate_deg/crop` when present (W5) and skips the call; every successful model answer appends a `tags/<deviceId>.jsonl` line `{t, id, hash, name, category, warmth, colors, pattern, statement, palette, vibe, rotate_deg, crop}`. `server.js` `/outfit-event` appends a `picks/` line to the mount after the history.json write (`openLog` created once at boot with the resolved `driveFolder`, re-resolved when **every door that sets the local mount** succeeds — `/integrations/drive/localfolder`, `/setup` **and `/integrations/drive/create-folder`**, the one-click 'make the folder' button, which `drive.js:568` also gives a `mode`+`folderPath` (the r1 review found this third door missing: the process kept the `driveFolder: null` it booted with and every pick after it was shared with nobody until a restart). `drive.setFolder` and `drive.connect` set neither, so those two are not doors); **the response stays `204` with an empty body** (`server.js:1512`; era-board relies on it). `server.js:2501` → `clothing.tick("drive sync")`. `drive.js`: paths containing `/.era/` compare by bytes (local) / `md5Checksum` (API) instead of size (W9); `contentReady()` ignores dot entries (I20). Spec note: "(6 h in API mode)" added to §5 (I21).
    - **Verification:** `node --test tests/drive-mirror.test.mjs` — TREE extended with `.era/picks/dev-b/2026-09-01.jsonl`; asserts the file lands, a same-size rewrite is re-copied, and pruning never touches `.era`. `node --test tests/content-worker.test.mjs` green (`:407-464` still builds because the board is not fresh). Share/sync suites in T4.4.
    - **Guardrails:** TDD (mirror cases first). `tick` must not be called with `force`. Never log a tag line's `name` to stdout. §C.
    - **Gate:** with T4.4.

15. [ ] **T4.4 `tests/clothing-share.test.mjs` (8458/8459) + `tests/clothing-sync-rebuild.test.mjs` (8460) + helper materialize**
    - **Acceptance:** `tests/synthetic-wardrobe.mjs --materialize <DATA> [n] [--drive <folder>]` writes distinct-byte photos (`makeJpg` per `clothing.test.mjs:23-29`, varied colours — I15) into `<DATA>/clothing/` and, if given, `<folder>/clothing/`, matching tiles into `<DATA>/wardrobe-items/`, and `wardrobe.json` with attributes + `attrsAt` (ids = md5 of the relative path, so two DATA dirs agree). **clothing-share:** temp Drive folder + DATA A + DATA B, `drive.json` local mode in both, no key for the build half; every hub in this suite is spawned with a child env built as `const env = {...process.env, ...SEAMS}; delete env.ERA_DEVICE_ID;` (the gate sources a private `gate-env.sh`, `era-gate.sh:13`, whose exports a suite must not inherit for this assertion) and, whenever a key is present in its DATA, `ERA_AI_URL=http://127.0.0.1:8459` (§B): (1) hub A on 8458, `<DATA_A>/device-id` created once and identical on a second boot; (2) POST `/outfit-event` Yes with hex ids → `204`, a line in `<folder>/clothing/.era/picks/<idA>/<today>.jsonl`, the event in **`<DATA_A>/wardrobe/history.json`** `events[today]`, and **nothing under `<DATA_A>/clothing/.era`** until a sync mirrors it back (A4-9); (3) in-process `drive.start(DATA_B) + await drive.sync()` copies `.era` into B and prunes nothing (photos intact); (4) torn last line in a mirrored file is tolerated by B's build; (5) A's own-id dir in A's mirror is ignored — after a sync copies A's own picks line back into `<DATA_A>/clothing/.era/picks/<idA>/`, append a divergent line to that mirrored file by hand and assert A's `derivePicks` input equals history.json's events, not the mirror's (A's picks come from history.json); (6) with the fake AI on 8459 that counts calls and a key in A only: a new photo in A produces one call and a `tags/` line; **the same photo bytes copied into B under a different filename (so a different md5-of-path id) with a key configured produce zero calls after a sync — the `hash` path of spec §3.1 item 1, not an id hit — and the tile is drawn**; (7) after both devices hold the same logs and the same `days[yesterday]`, `regenerate(true)` in A and B produce identical `allCombos()` — 21-for-21 across `today|today_2|today_3` (same date, band null); (8) Drive folder without `clothing/` + local photos → no mount write, sync prunes nothing (W8); (9) API-mode `drive.json` → local-only, no throw; **(10) another device's Yes is consumed (spec §5 "Reads", §6 step 4):** write `<folder>/clothing/.era/picks/dev-b/<yesterday-1>.jsonl` and `<yesterday>.jsonl` each with a Yes on a harmonizing synthetic combo that is in neither A's history nor A's `days[yesterday].page1` → after a sync and `regenerate(true)` in A that combo is the first outfit on A's `today` board (seated as the staple); **(11) another device's page-1 offer is consumed:** `<folder>/clothing/.era/offers/dev-b/<yesterday>.jsonl` with `page1` containing a harmonizing combo absent from A's own `days[yesterday]` → after sync + `regenerate(true)` it is absent from A's `today` board and first on `today_2`; **(12) a shared avoid pair is consumed:** `<folder>/clothing/.era/pairs/studio.jsonl` with an `avoid` line on a combo that appeared in the previous build's 21 → after sync + `regenerate(true)` that pair is in none of the 21. Cases 10-12 are the only end-to-end proof that the worker reads the merged log — case 7 alone is satisfied by a worker that ignores the mirror. **clothing-sync-rebuild (8460):** hub with a pre-materialized wardrobe; wait for `building:false` after the first board; record `recipes/today.json` mtime + bytes; POST `/integrations/drive/sync` → poll `building:false`; **then write `<folder>/clothing/.era/picks/dev-b/<today>.jsonl` and `offers/dev-b/<today>.jsonl` (foreign, log-only changes)**; POST `/integrations/drive/sync` again → poll → mtime unchanged and body byte-identical (spec §3.5 "log-only changes never rebuild today's board" — the property that licenses `onSynced → tick`), **and both lines are present under `<DATA>/clothing/.era/`** (the mirror carried them); add a photo to the Drive folder → sync → mtime changes.
    - **Verification:** `node --test tests/clothing-share.test.mjs` — `# fail 0`, `# duration_ms < 360000`; `node --test tests/clothing-sync-rebuild.test.mjs` — `# fail 0`, `< 120000`; the sync-rebuild test names contain "log-only". Both with the §B env seams; `grep -n "8458\|8459\|8460" tests/*.mjs` shows only these two suites; `grep -c "ERA_AI_URL" tests/clothing-share.test.mjs` ≥ 1.
    - **Guardrails:** TDD. Hex ids over HTTP; loose ids only in-process. `ERA_AI_SPACING_MS=50`. Never spawn on 8463. A hub with a key and no `ERA_AI_URL` seam is a STOP (§B). §C.
    - **Gate:** `rae-flow:reviewing` — **Scope:** T4.1-T4.4 against spec §3.5, §5 (every bullet, as amended A4-2/3/6/9), §6 steps 2-4, §8 share/sync-rebuild bullets, `pool.test.mjs` device id. **Pass criteria:** no mount write can create `clothing/`; the hub never writes under `<DATA>/clothing/.era` (one writer per file — the mirror); no id list leaves the device; mirror never prunes `.era`; onSynced no longer forces; the gate's shared hub carries `ERA_DEVICE_ID=gate`; cases 10-12 and the sync-rebuild log-only case present. Then **Phase 4 retrospective**.

### Phase 5: `/clothing/status` + Settings read-out
**Posture hint:** implementing — payload shape fixed by spec §4 (+A4-2), Settings pattern exists (`settings-ui.test.mjs:83-103`).

16. [ ] **T5.1 `/clothing/status` gains `picks`, `memory`, `sharing` (memoized)**
    - **Acceptance:** `clothing.status()` adds `picks: {days, lastDay, top:[{combo, names, weight}]}` (top 5 by `derivePicks` over history ∪ merged picks, days `< today`; names via `byId` over `ok` items; an unresolvable id drops that combo; one-piece combos have one name), `memory: {days, yesterdayPage1}` where **`memory.days = ` the number of distinct date keys in `history.days ∪ merged offers` (today included — the just-finished build counts, unlike `picks` which is `< today`)** and **`memory.yesterdayPage1 = (union page 1 for yesterday across devices).length`** (spec §4's `days: 33` example is silent on today; this rule is what T7.3 step 1's `"memory":{"days":1}` follows from), `sharing: {mode: "drive"|"local", devices: <count incl. self>}` (W12/W13, from `<DATA>/drive.json` without `drive.status()`). Block memoized keyed on `dayKey` + `statSync(historyPath).mtimeMs` + `size` (a missing file = key `0`) — **not a TTL** (W11 as amended): one stat per poll, and a history.json written by anyone (the shell's `recordOffer`, `/outfit-event`, a hand-seeded fixture) is seen on the next poll; no `historyChanged()` export, no route coupling. The mirror-delivered half (merged picks/offers) is re-read when the memo key changes, which is every history.json write — at least daily.
    - **Amended after final review (r1), two sentences the shipped code outgrew:** (a) the memo key is `dayKey` plus the stat of the **three** files the block reads THROUGH — the memory, `drive.json` (the folder) and `wardrobe.json` (the names, and the rule that a combo the catalogue lost is dropped) — i.e. three stats per poll, still never a TTL; the one-file wording above pre-dates the two r1 widenings (`8a69195`, `892a4b7`, the latter with its own case in `clothing-status.test.mjs`). (b) The read-out opens the memory **read-only** (`readHistory({readOnly: true})`): the set-aside of an unreadable history.json is a WRITE and belongs to the two doors that write the file (`recordOffer`, `POST /outfit-event`), never to a public unauthenticated endpoint polled every few seconds — a `cp` of a keep's history.json into a running hub's data dir is not atomic, so a poll landing mid-copy used to rename the half-written file to `history.json.bad-<ts>` and leave the finished copy with no `history.json` in place. Bytes that are there and will not parse throw, so the `picks`/`memory` blocks drop out and the card says nothing rather than "No picks recorded yet" (`clothing-status.test.mjs` "a poll never sets the memory aside").
    - **Verification:** `node --test tests/clothing-status.test.mjs` (new, hub on 8461, materialized wardrobe, no key): before any event → `picks.days === 0`, `picks.top` empty, `memory.days === 0` (no build yet) or `1` (after the first build — the test waits for `building:false` and asserts `1`); seed `history.json` with 3 past days of Yes on synthetic combos + `days` **under the running hub, then poll once** → `picks.days === 3` (the stat key makes the seed visible immediately — the assertion that pins "no TTL"), `lastDay` = the latest seeded day, `top[0].weight === 3`, `top[0].names.length === 2`, a combo naming a removed id is absent, `memory.days === 4` (3 seeded + today); `sharing.mode === "local"` with no folder, `"drive"` with `drive.json` local + folder, `devices` is a number; response JSON contains no `item_` under `sharing` and no folder path. `node --test tests/clothing-responsive.test.mjs` — `/clothing/status` `< 900 ms` still.
    - **Guardrails:** TDD. Public endpoint: no device ids, no paths, no attributes. §C.
    - **Gate:** with T5.2.

17. [ ] **T5.2 Settings `#picksStatus` + `tests/settings-ui.test.mjs` extension**
    - **Acceptance:** `public/settings/index.html`: `<div class="status" id="picksStatus"></div>` after `#aiStatus` (`:202`), painted in `aiPaint()` **before** the branch chain from the same fetch, guarded `if (s.picks && s.memory)`, names through `CT_ESC`; text: "Her picks: N days recorded, last <yesterday|weekday>. Favourites: A + B (×3), C (×2)…" (weekday from `new Date(y, m-1, d)` per the local-date rule; one-name combos without " + "); when `sharing.mode === "drive"` a second line "Shared with: N devices"; no picks → "No picks recorded yet — every Yes on the board is remembered from tomorrow." Line persists in the no-key and ingesting branches.
    - **Amended after the Phase 5 review (r1), so the final pass is not held to superseded wording:** the "when" clause has **four** forms, not two — `≤ 0 days` (a family profile zone ahead of the browser's hands the card a lastDay it has not reached) says *nothing about when*, so the sentence is "Her picks: N days recorded."; `1 day` is "last one yesterday"; `< 7 days` is the plan's "last <weekday>"; `≥ 7 days` names the date, which `toLocaleDateString(undefined,{day:"numeric",month:"long"})` renders **"July 11"** under the family browser's en-US default (the retrospective's "2 September" example was the wrong locale, not the shipped string). And `devices === 1` under `mode === "drive"` reads "Shared through your Google Drive folder — no other device has written to it yet." rather than "Shared with: 1 device" — the count includes self, so the literal form would mean "shared with myself".
    - **Verification:** `node --test tests/settings-ui.test.mjs` — `clothingPayload()` helper + `ctx.route("**/clothing/status", …)` before `page.goto`: four cases (picks present with escaped synthetic names containing `<b>`; none; sharing line only when `mode === "drive"`; line present with `aiConfigured:false`); `lastDay` = yesterday renders "yesterday"; a `lastDay` four days back renders the right weekday when the browser zone is `America/Los_Angeles` (`ctx = browser.newContext({timezoneId})`). Browser verification per rae-flow: a short Playwright video of the Settings card is saved under the scratchpad and referenced in the workpad.
    - **Guardrails:** TDD. `innerHTML` only with escaped names; no new i18n mechanism. §C.
    - **Gate:** `rae-flow:reviewing` — **Scope:** T5.1-T5.2 against spec §4 (as amended A4-2) and §1 row O1. **Pass criteria:** read-out visible in every `aiPaint` branch; payload hygiene; responsive bound. Then **Phase 5 retrospective**.

### Phase 6: private migration tool (era-family)
**Posture hint:** implementing with escape hatch — switch to collaborating if the original's `wardrobe.json`/`history.json` shapes differ from what `outfit_set.py:87-120, 306-373` reads (the implementer verifies against the original's code, never against a family data file).

18. [ ] **T6.1 `era-family/tools/clothing-migrate-studio.mjs`**
    - **Acceptance (told to the implementer verbatim):** the file lives at `/home/claude/new-era/era-family/tools/clothing-migrate-studio.mjs`; usage `<studio wardrobe dir> <photos dir> <out .era dir>`; no keys, no network; reads the original `wardrobe.json`, `pairing.json`, `history.json`; maps each garment to a hub id by `sha256(photo bytes) === source_hash` over the photos dir (relative path incl. subfolders, I17), falling back to `"item_" + md5(relative path).slice(0,10)`; writes `tags/studio.jsonl` (hash + id + attributes, warmth as word, `rotate_deg` absent, `retired`/`too_big` skipped and their **filenames written to `<out .era dir>/../do-not-copy.txt`**, one per line — I8; **never printed**, since a curated wardrobe's photo filenames can be garment names and stdout lands in workpads, §F), `pairs/studio.jsonl` (`great`/`avoid`, and per-garment `favorite` lines with one id), `offers/studio/<date>.jsonl` and `picks/studio/<date>.jsonl` with hub ids and `t`; every output file ends with a marker line `{"t":…,"kind":"marker"}` so a re-run changes byte length (W9 — the public reader skips `kind: marker`, T4.2); stdout is **exactly three counts** (`mapped N`, `unmapped N`, `skipped N`, the last being the do-not-copy count) and **never a garment name, colour, filename or id-to-name pair**. A test in `era-family/tools/` (private) runs it on a synthetic studio fixture the test itself generates (invented names, photo filenames that *are* the invented names — the hostile case), asserts the counts, the line shapes, that `do-not-copy.txt` holds the expected entries, and that stdout contains no fixture name and no filename.
    - **Amended after final review (r1):** `do-not-copy.txt`'s "one per line" is one HELD PHOTO per line as `<path><TAB><why it is held back>`, under a single `#` comment line naming those two columns — the reason is what lets an operator tell outgrown from lost, and without the header a copy-exclusion list fed this file straight would swallow the reason as part of each path. Two guards go with it: a studio `type` that is not a string is no type at all (`isStr`, the guard every other field here already keeps — `String(["top"])` would otherwise ship a category), and a history key is used only when it round-trips through the calendar (`9999-99-99` matches the date SHAPE, and the hub's 60-day window is a string compare, so one junk key would hold a slot in her memory for good).
    - **Verification:** `cd /home/claude/new-era/era-family && node --test tools/clothing-migrate-studio.test.mjs` — `# fail 0`; `node tools/clothing-migrate-studio.mjs <fixture> <fixture-photos> <tmp>/.era | wc -l` — `3`; `grep -n '"marker"' /home/claude/new-era/era-hub--wt-clothing/clothing-log.js` — ≥ 1 hit (the reader's skip, landed in T4.2 with its own test case).
    - **Guardrails:** TDD on the synthetic fixture. **Never** run the tool on real family data as part of this task; the operator runs it from the private restore runbook. Commit only in `era-family` with the named path; nothing from it enters era-hub. The implementer must not open, list or describe any file under `era-family/data/`. §C.
    - **Gate:** `rae-flow:reviewing` — **Scope:** spec §7; output hygiene (no names in stdout); marker line honoured by the public reader. Then **Phase 6 retrospective**.

### Phase 7: gate, review, behavioural verification, cut
**Posture hint:** implementing — commands and expected outputs are fixed below; anything unexpected is a STOP, not an adaptation.

19. [ ] **T7.1 Full gate**
    - **Acceptance:** `bash tools/era-gate.sh` from `/home/claude/new-era/era-hub--wt-clothing` completes green with every new suite listed.
    - **Verification:**
      1. `ps -eo pid,cmd | grep -c "[e]ra-gate.sh"` — `0` **before** starting (never run two gates; if `flock -n 9 9>/tmp/era-gate.lock` fails, wait — do not kill).
      2. `cd /home/claude/new-era/era-hub--wt-clothing && setsid nohup bash tools/era-gate.sh > <scratch>/gate.log 2>&1 &` then poll the log (10-minute tool ceiling: background + Monitor). `<scratch>` is the running agent's own scratchpad directory — a session-id path means nothing to a later reader, so it is not written down here (amended after final review).
      3. The gate prints `PASS <suite>` / `FAIL <suite> (see gate/<suite>.out)` per suite and one summary `== era-gate: N passed, M failed[ → names] ==` (`tools/era-gate.sh:79-80,89-92`); the `# fail` TAP lines live in `gate/<suite>.out`, never in gate.log. So: `grep -cE '^== era-gate: [0-9]+ passed, 0 failed' …/gate.log` — `1`; `grep -c '^FAIL ' …/gate.log` — `0`; `grep -cE 'clothing-(rank|variety|log|share|sync-rebuild|status|attrs)' …/gate.log` — `7` (note `-E`: with BRE the `(`/`|` are literal and the count is 0 on a green log); read `# fail` from `gate/<suite>.out` only when a `FAIL` line names a suite; `clothing.test` duration in `gate/clothing.test.out` `< 720000`.
    - **Guardrails:** §C. Kill nothing by pattern (`pkill -f` self-match — memory); by pid only if a suite hangs past 900 s.
    - **Gate:** green gate is the gate.

20. [x] **T7.2 Final spec review**
    - **Acceptance:** `rae-flow:reviewing` over the full diff (`git diff master...feat/clothing-migration --stat`) against the spec + A4, with the §D coverage table as the checklist.
    - **Verification:** review status `APPROVED` recorded in the workpad; every CHANGES_REQUESTED loop re-runs the affected suite(s) and T7.1 if a module changed.
    - **Guardrails:** §C.
    - **Gate:** APPROVED.

21. [x] **T7.3 Behavioural verification — a scratch hub and two DATA dirs on one temp Drive folder**
    - **Acceptance:** the feature works as a parent would see it: picks/memory/sharing in status; 21 outfits with page 1 garment-distinct; a second sync leaves today's board alone; two devices deal the same 21. All on synthetic data, no key.
    - **Verification (run in order; expected output after each):**
      ```bash
      S=<scratch>/bv                     # the running agent's own scratchpad dir
      H=/home/claude/new-era/era-hub--wt-clothing
      rm -rf "$S"; mkdir -p "$S/A" "$S/B" "$S/drive/clothing"
      # two consecutive free ports: A and B never share one (a same-port handoff races the
      # socket release → EADDRINUSE on B → an unbounded wait). Both must be ≥ 8464.
      PORT=$(for p in $(seq 8464 8498); do ss -ltn | grep -q ":$p " || { echo $p; break; }; done)
      PORTB=$(for p in $(seq $((PORT+1)) 8499); do ss -ltn | grep -q ":$p " || { echo $p; break; }; done); echo "PORT=$PORT PORTB=$PORTB"
      # → PORT=8464 PORTB=8465 (or the next free ones)
      # bounded waits — every loop ends with an explicit failure line so the §E STOP can fire.
      # The whole block runs as ONE background script under Monitor (the tool shell blocks a
      # foreground sleep; the 10-minute ceiling applies to the background run too — memory).
      waitfor() { local url=$1 pat=$2 n=${3:-90}; for i in $(seq 1 $n); do curl -sf "$url" | grep -q "$pat" && return 0; sleep 2; done; echo "TIMEOUT: $pat"; return 1; }
      # idle = no build running, checked twice 5 s apart: POST /clothing/regenerate runs drive.sync()
      # first (→ onSynced → tick → build #1 when there is no board) and then its own regenerate(true)
      # (queued as build #2, clothing.js:58-62), and the 20 s startup tick can queue a third —
      # recipes/today.json is rewritten for 40-60 s after the door, so a fixed sleep is a coin flip.
      idle() { waitfor "$1/clothing/status" '"building":false' 120 || return 1; sleep 5; waitfor "$1/clothing/status" '"building":false' 120; }
      node "$H/tests/synthetic-wardrobe.mjs" --materialize "$S/A" 35 --drive "$S/drive"
      node "$H/tests/synthetic-wardrobe.mjs" --materialize "$S/B" 35 --drive "$S/drive"
      for d in A B; do printf '{"mode":"local","folderPath":"%s"}' "$S/drive" > "$S/$d/drive.json"; done
      SEAMS="ERA_ELEVEN_URL=http://127.0.0.1:1 ERA_FAL_URL=http://127.0.0.1:1 ERA_GEO_URL=http://127.0.0.1:1 ERA_WEATHER_URL=http://127.0.0.1:1 ERA_RESEND_URL=http://127.0.0.1:1 ERA_TMDB_URL=http://127.0.0.1:1 ERA_STREAMING_URL=http://127.0.0.1:1 ERA_BIND=127.0.0.1"
      U="http://127.0.0.1:$PORT"; UB="http://127.0.0.1:$PORTB"
      # The pid file must hold NODE's pid (amended after final review): `env … setsid nohup node &`
      # + `echo $!` records the wrapper — env execs setsid, setsid forks the session leader and
      # exits — so `kill $(cat hubA.pid)` before step 4 was a no-op, hub A ran on through hub B's
      # build on the same temp mount, and both ports leaked at the end (observed: hubA.pid 217058
      # vs `node server.js 8464` 217059). `bash -c 'echo $$; exec …'` keeps the pid across the exec.
      starthub() { setsid bash -c "echo \$\$ > '$2'; cd '$H'; exec env $SEAMS ERA_DATA_DIR='$1' node server.js $3" > "$4" 2>&1 & }
      stophub() { local p; p=$(cat "$1" 2>/dev/null); [ -n "$p" ] && kill -0 "$p" 2>/dev/null || { echo "STOP: $2 is not running under the pid it recorded"; return 1; }
        kill "$p"; for i in $(seq 1 50); do kill -0 "$p" 2>/dev/null || return 0; sleep 0.2; done; echo "STOP: $2 did not exit"; return 1; }
      starthub "$S/A" "$S/hubA.pid" $PORT "$S/hubA.log"
      waitfor "$U/clothing/status" '"cataloged":35' 60 || echo "STOP: hub A never catalogued 35"
      # → (nothing) — a TIMEOUT/STOP line here is the §E stop
      curl -s -X POST "$U/clothing/regenerate"; echo   # → {"started":true}
      idle "$U" || echo "STOP: build never settled"
      # 1. status read-out (memory.days counts today's just-written day — T5.1 rule)
      curl -s "$U/clothing/status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify({picks:j.picks,memory:j.memory,sharing:j.sharing}))})'
      # → {"picks":{"days":0,"lastDay":null,"top":[]},"memory":{"days":1,"yesterdayPage1":0},"sharing":{"mode":"drive","devices":1}}
      # 2. 21 outfits, page 1 garment-distinct
      node -e 'const r=require(process.argv[1]);const b=r.boards.filter(x=>/^today(_\d)?$/.test(x.id));const o=b.flatMap(x=>x.buttons.filter(y=>y.type==="outfit"));const p1=b.find(x=>x.id==="today").buttons.filter(y=>y.type==="outfit").flatMap(y=>y.combo);console.log("outfits",o.length,"page1 garments",p1.length,"distinct",new Set(p1).size)' "$S/A/recipes/today.json"
      # → outfits 21 page1 garments 14 distinct 14   (13/13 if a single sits on page 1 — distinct must equal garments)
      # 3. a Yes lands in the mount, and a second sync does not rewrite today.json
      ID1=$(node -e 'const r=require(process.argv[1]);console.log(r.boards.find(x=>x.id==="today").buttons.find(y=>y.type==="outfit").combo.join(","))' "$S/A/recipes/today.json")
      curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d "{\"kind\":\"yes\",\"combo\":[\"${ID1/,/\",\"}\"]}" "$U/outfit-event"
      # → 204   (the route answers 204 with an empty body, server.js:1512 — T4.3 keeps that; there is no {"ok":true})
      # The MOUNT line is what carries A4-9 here; the "0" below is only true BEFORE the first
      # sync mirrors A's own lines back under <DATA_A>/clothing/.era (T4.4 case 2), so these two
      # lines must stay above the syncs and a bare "0" proves nothing on its own — hence the
      # non-empty test on the mount file (amended after final review).
      test -s "$(ls "$S/drive/clothing/.era/picks/"*/*.jsonl | head -1)" && echo "the mount has her pick"
      # → the mount has her pick
      ls "$S/A/clothing/.era" 2>/dev/null | wc -l           # → 0   (the hub never writes under the mirror target, A4-9)
      idle "$U"; M1=$(stat -c %Y "$S/A/recipes/today.json")
      curl -s -X POST "$U/integrations/drive/sync" >/dev/null; idle "$U"
      curl -s -X POST "$U/integrations/drive/sync" >/dev/null; idle "$U"
      M2=$(stat -c %Y "$S/A/recipes/today.json"); echo "mtime unchanged: $([ "$M1" = "$M2" ] && echo yes || echo NO)"
      # → mtime unchanged: yes
      # 4. device B deals the same 21 from the same logs (same date, band null, same tags)
      cp "$S/A/wardrobe/history.json" "$S/B/wardrobe/history.json" 2>/dev/null || true   # only days[] < today matter; on day 1 both are empty
      # A is DOWN before B builds — both hubs share the one temp mount, and a live A that
      # re-synced and rebuilt would silently invalidate the 21-for-21 comparison below. The
      # STOP line is the point of the wait: a silent `break` is what let A run on (amended
      # after final review).
      stophub "$S/hubA.pid" "hub A" || echo "STOP: hub A is still up — do not compare boards"
      starthub "$S/B" "$S/hubB.pid" $PORTB "$S/hubB.log"
      waitfor "$UB/clothing/status" '"cataloged":35' 60 || echo "STOP: hub B never catalogued 35"
      curl -s -X POST "$UB/clothing/regenerate" >/dev/null; idle "$UB" || echo "STOP: build never settled"
      ALL() { node -e 'const r=require(process.argv[1]);console.log(r.boards.filter(x=>/^today(_\d)?$/.test(x.id)).sort((a,b)=>a.id.localeCompare(b.id)).map(x=>x.id+": "+x.buttons.filter(y=>y.type==="outfit").sort((a,b)=>a.load.localeCompare(b.load)).map(y=>y.combo.join("+")).join(" ")).join("\n"))' "$1"; }
      diff <(ALL "$S/A/recipes/today.json") <(ALL "$S/B/recipes/today.json") && echo "all 21 identical"
      # → all 21 identical   (spec §8 "the identical 21" — pages 2-3, where demotion and garment-once live, are compared too)
      grep -c "device-id" <(ls "$S/A" "$S/B")   # → 2
      stophub "$S/hubB.pid" "hub B"
      # …and the two reserved ports are given back — the leak that stranded them was invisible
      # until someone else needed 8464/8465 (amended after final review).
      ss -ltn | grep -qE ":($PORT|$PORTB) " && echo "STOP: a hub of mine is still listening" || echo "both ports released"
      # → both ports released
      ```
      Capture every printed line into the workpad's Execution Evidence, tagged with the spec row it proves (O1, V3, V4, S1/§5 "same board everywhere", A4-9).
    - **Guardrails:** synthetic wardrobe only; two ports ≥ 8464 chosen by `ss`, never one port for both hubs; kill by pid and wait for exit; no key file in either DATA; every wait bounded (a `TIMEOUT`/`STOP` line is the §E stop — never loosen a bound). If `cataloged` never reaches 35, STOP (the materialize helper or ingest gate is wrong — do not add a key). If `mtime unchanged: NO` appears, first check `idle` really saw `building:false` twice — a chained build is the usual cause, a rebuild on a log-only sync is the bug. §C.
    - **Gate:** evidence captured in the workpad; `rae-flow:reviewing` reads it as part of T7.2's final pass if it ran later.

22. [ ] **T7.4 Cut v0.32.2 (orchestrator step — noted, not planned here)**
    - **Acceptance:** after T7.1-T7.3 are green and APPROVED, the orchestrator runs `bash tools/release.sh v0.32.2` from the worktree (the `v` prefix is the script's usage and every existing tag/dist dir: `release.sh:13`, `git tag` → `v0.32.1`, `dist/release-v0.32.1`; a bare `0.32.2` would tag and name off-convention for the update feed). Free disk ≥ 2 GB — memory: build-dist refuses otherwise; signing rail live since 9/5. VM QA on the QA host follows the private runbook and is **not** planned in this document.
    - **Verification:** there is no cheap preview: `--dry-run` runs the **full** pipeline (`release.sh:20-30` — step 1 the gate, taking the machine-wide `flock` and ~40 min if T7.1's gate is not still the freshest; step 2 `build-dist.sh` with makensis and the SimplySign signing rail; step 3 `vm-e2e.sh` on the QA host) and only skips the tag/publish (`:31`); budget ≥ 1 h and never overlap it with another gate. Cheap preflight instead: `df -Pm /home/claude/new-era | awk 'NR==2{print $4}'` ≥ 2048; `git -C /home/claude/new-era/era-hub--wt-clothing tag -l v0.32.2` prints nothing; `bash tools/era-gate.sh` result from T7.1 within the last commit (no module changed since). Then the real `bash tools/release.sh v0.32.2`.
    - **Guardrails:** not an implementer task; never run from `era-hub--wt-install-qa`; the gate must have finished (no concurrent gate/cut); `--dry-run` is a full build with the signing rail, not a listing.
    - **Gate:** orchestrator's.

#### Final review (T7.2/T7.3) — result

**Behavioural verification (T7.3): PASS.** T7.2 ran seven review lenses over
`v0.32.1...HEAD`: the ranking/memory core against spec §3.1-§3.4/§4 with
function-for-function parity against `outfit_set.py:61-73, :242-557`; the sharing rail
(`device-id.js`, `clothing-log.js`, `drive.js`, `server.js` wiring, the gate and payload
scripts, six suites) against §5/§8 with an independent scratch-hub reproduction of the
A4-9 and §3.5 claims; the read-out half (`status()`/`readOutFor`, `GET /clothing/status`,
the Settings card and its two suites) against §4/§7 and the board design rules; the
private migration tool against §6/§7 and A4-13, round-tripped through the public reader
and on into `buildCandidates`; the plan's §D coverage table row by row for bite, plus §E
STOP conditions, §C guardrails, the payload cp list, the `clothing.test.mjs` duration
ceiling and Gate 0; and a public-repo hygiene pass over all 69 commits (28 files,
+7683/-227). Six lenses returned APPROVED_WITH_COMMENTS and one (the read-out half)
CHANGES_REQUESTED.

**One fix round (r1), five commits, then re-review APPROVED_WITH_COMMENTS:**
`550cba0` (a `/clothing/status` poll no longer sets her memory aside — the read-out
opens `history.json` read-only), `0de7150` (T7.3's runbook records node's own pid, the
A-is-down wait fails loudly, no session path in a public doc), `23a7b8a` (the two
merged-log levers with no bite: a shared tag's `rotate_deg`/`crop`, and the favourite
line's wiring into the deal), `026aa8c` (two comments that claimed more than the code
does), and in the private repo `aecab41` (migration tool: a type that is not a string is
not a type, a history key that is not a real date is not a day, and `do-not-copy.txt`
says what its two columns are). Spec §10 records every A4 item and every review-driven
behaviour change as shipped.


---

## D. Spec coverage

| Spec item | Delivered by |
|---|---|
| §1 V1 taste rules + attributes | T1.2 (rules), T1.4 (pool filter), T3.1 (attributes at ingest), T4.3 (shared tags) |
| §1 V2 rank: style + fav + freshness + loved + jitter, no random | T1.4, T1.5 (no-random grep), T2.3 (worker) |
| §1 V3 staples + coverage + fill, yesterday bar → page 2, garment-once-per-page | T1.4, T1.5 (incl. the deep-page "garment-once" case — the only test of that rule), T2.4 |
| §1 V4 one deterministic deal per date | T2.3 (seed = dayKey), T4.3 (`onSynced → tick`), T4.4 (sync-rebuild, incl. the log-only case), T7.3 step 3 |
| §1 V5 tops never gated | T1.4 (`eligible`), T2.3, T2.4 (weather test) |
| §1 F1 loved lift | T1.4 |
| §1 F2 staple rotation by hash | T1.4 |
| §1 F3 staples skip yesterday's page 1; day = family TZ | T1.4, T1.1 (`dayKey`), T2.1 (`tz` plumbing), T2.4 (one `ZONE` for the suite) |
| §1 H1 history `{days, events}` 60 days | T1.3, T2.2 |
| §1 S1 sharing without a server | T4.1-T4.4 |
| §1 O1 Settings shows learning | T5.1, T5.2 |
| §3 module layout (rank / log / worker / clothing / server / settings) | T1.1, T4.2, T2.3, T2.1, T4.3, T5.2; payload list I2 |
| §3.1 item 1 shared tags by id then hash | T4.2 (reader + `tagsFor` hash-only and id-differs cases, and — added after final review — A4-3's `rotate_deg`/`crop` carried across so a device that skips the call does not draw a sideways tile), T4.3 (lookup before `askModel`), T4.4 case 6 (hash path end-to-end) |
| §3.1 item 2 `INGEST_PROMPT` + whitelist | T3.1 |
| §3.1 item 3 needs-attributes pass (holdDay as amended A4-8) | T3.2 |
| §3.1 item 4 degrade, never exclude | T1.2 (isNeutral rule), T1.5 ("no attributes" case: zero-attribute wardrobe fills 21) |
| §3.1 attributes never in a recipe | T3.1 (assertion) |
| §3.2 constants, functions, order | T1.1-T1.4 |
| §3.2 `derivePicks` moves | T1.3, T2.3 (deleted from worker) |
| §3.2 `h()` BigInt, no `Math.random` | T1.1, T1.5 |
| §3.2 `recordOffer` prune days + events | T1.3 |
| §3.2 `dayKey`, yesterday in zone | T1.1, T2.1 |
| §3.2 clean = every ok item with a tile | T2.3 |
| §3.3 shape, `writeAtomic`, worker/events separation (as A4-1) | T2.2 |
| §3.3 retire `clothing-history.json` | T2.3 |
| §3.3 same-day rebuild reproduces | T1.5, T2.3, T2.4 |
| §3.4 weather bands, mapping (incl. `any`), widen, offline = none | T1.1 (`WARMTH_LEVELS`), T1.4 (positive + negative gating cases), T2.3, T2.4 (cold bottom absent) |
| §3.5 `onSynced → tick`; log-only changes never rebuild; intra-day doors reproduce | T4.3, T4.4 (sync-rebuild "log-only" case), T2.3 |
| §4 learned favourites (derivePicks, staples, loved) | T1.3, T1.4 |
| §4 curated pairs + favorite from `pairs/` | T4.2, T4.3, T4.4 (the `favorite` wiring end-to-end — added after final review: the reader and rankOf both bit, the wiring between them did not) |
| §4 `/clothing/status` picks/memory/sharing (as A4-2) | T5.1 |
| §4 Settings sentences | T5.2 |
| §5 layout of `.era/` | T4.2 |
| §5 safety under the mirror (dotfiles, append-only, torn line) | T4.2, T4.3 (byte-compare), T4.4, drive-mirror extension |
| §5 own writes (mount only, local canonical = history.json, never throws — as A4-9) | T4.2, T4.4 case 2, 8-9 |
| §5 reads merge + own-id dedupe + union rules (marker/malformed lines skipped) | T4.2, T4.4 case 5 (dedupe), cases 10-12 (worker consumes another device's Yes / offer / avoid) |
| §5 device id | T4.1 (+ `ERA_DEVICE_ID=gate` for the shared gate hub), T4.4 case 1 |
| §5 same board everywhere / §8 "the identical 21" | T1.5 (shuffled order), T2.4 (`allCombos()`), T4.4 case 7 (21-for-21), T7.3 step 4 (all three boards) |
| §5 tags pay once per family | T4.3, T4.4 case 6 (different filename → hash hit) |
| §5 latency note | T4.3 (spec text "(6 h in API mode)") |
| §6 data flow | T2.3, T3.2, T4.3, T4.4 cases 10-12 (step 4) |
| §7 migration tool (do-not-copy list to a file, counts only on stdout) | T6.1 |
| §8 `clothing-rank.test.mjs` | T1.1-T1.4 |
| §8 `clothing-variety.test.mjs` | T1.5 |
| §8 `clothing-share.test.mjs` | T4.4 |
| §8 `clothing-sync-rebuild.test.mjs` | T4.4 |
| §8 updates: `clothing.test.mjs`, `clothing-weather.test.mjs`, Settings test, `pool.test.mjs` | T2.4, T3.1, T5.2, T4.1 (Phase 3's pass block is the new `clothing-attrs.test.mjs`, A4-7) |
| §4 `memory` semantics (today included) | T5.1 (rule), T7.3 step 1 |
| §8 gate green, then cut + VM QA | T7.1, T7.4 (VM QA out of this plan by instruction) |
| §9 queued items | deliberately deferred — already in spec §9, no task |

---

## E. Adaptation protocol (STOP conditions)

- **A rule in the original that the spec contradicts** (beyond A4 and I5): STOP, signal NEEDS_CONTEXT with the `outfit_set.py` line and the spec line; do not pick a side.
- **A test that needs a key** (a fake cannot stand in): STOP, signal BLOCKED; never add a key file to a test DATA dir.
- **A port conflict** on 8458-8462 or the T7.3 ports (`ss -ltn` shows a listener): STOP and record it (§B has no spare; T7.3 simply moves up the ≥ 8464 scan); never touch 8377-8416, 8425, 8427, 8450-8457; never kill a listener you did not start.
- **Anything requiring a family-data file** (a fixture that only works with the real wardrobe, a name needed for a test): STOP, signal BLOCKED; synthetic only.
- **`clothing.test.mjs` over 720 s locally**: STOP, move the new cases to a new suite rather than trimming existing ones.
- **`writeAtomic` tmp-name collision observed** in any suite even after T2.2: STOP — the single-writer invariant is broken somewhere; find the second writer before proceeding.
- **Pattern differs from expected** (e.g. `aiPaint` structure changed since preflight): document the adaptation in the retrospective, proceed.
- **Discovery** (security or hygiene finding, e.g. a family string reaching a log): document in Follow-ups, fix if one line, else complete the task and flag.

## F. Phase retrospective instructions

After every phase gate the implementer appends to the workpad `## Phase N Retrospective` with: Decisions Made (with alternatives), Observations (easier/harder, surprises — especially any parity mismatch found against the original), Adaptations (approved or in-scope), Follow-ups (with rationale), Confidence (High/Medium/Low + risks). Machine output only in Execution Evidence — narrative claims are not evidence. Never include garment names, ids paired with names, family schedule, or the banned word.
