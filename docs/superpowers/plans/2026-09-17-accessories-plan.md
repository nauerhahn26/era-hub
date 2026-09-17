# Accessories (jackets first) — implementation plan

Spec: `docs/superpowers/specs/2026-09-17-accessories-design.md` (dad: "go for it", 9/17,
commit a878111). Repos: era-hub (this worktree, `feat/jackets`) and era-board (sibling
worktree `era-board--wt-jackets`, same slug — dev-flow.md "a feature that spans repos").
era-core untouched (dwell.js is read, not changed).

Every task: TDD (`superpowers:test-driven-development` — failing test first), a
verification command, STOP conditions. Builders are Opus agents (`model:'opus'`); Fable
reviews at each phase gate (`rae-flow:reviewing`). Posture hints are advisory.

Ports: the 84xx census on 9/17 across all five repos' tests shows 8465–8479 free of suites
(8463/8464 = kiosk-pause, 8480 taken). **The accessories suite takes 8465 (hub) and 8467
(fake model)** — 8466 is named in an era-making-words manual-run comment, so it is skipped;
`ss -ltn | grep -E '846[57]'` must be empty before the first run, and
grep the five repos again before binding (tunnel-ports memory: two collisions already
exist in the band).

## §A Preflight (9/17, against 27376a4)

| # | Finding | Class | Mitigation → task |
|---|---------|-------|-------------------|
| 1 | `category` whitelist is inline at `clothing-worker.js:859` and duplicated by `CATEGORY` at `clothing-rank.js:315`; unknown → `"top"` | warn | one exported `CATEGORIES`/`ACCESSORY_KINDS` in clothing-rank.js, imported by the worker → T1, T3 |
| 2 | `buildCataloged` pools every `ok` item with a tile (`:1054`); `categoryOf()` `null` parks an item silently | info | accessories get role `"accessory"` and an explicit filter — never `null` → T1, T5 |
| 3 | The worker's build path: `ingest()` (skipped when `rebuildOnly`) → `loadCatalog()` (`:1226`) → `buildCataloged` | info | the manual sweep runs right after that `loadCatalog()`, on BOTH paths, and `saveCatalog` only when it changed something → T4 |
| 4 | `wardrobe.json` is written by the worker with plain `writeFileSync` (`:98`); main thread reads it in `status()` under try/catch | warn | the route reads the catalogue read-only, answers `503 {error:"catalogue busy — try again"}` on a parse failure; it never writes wardrobe.json → T6 |
| 5 | A main-thread shared-log handle exists (`server.js` uses `clothingLog.appendPick`); `openLog()` returns `appendTag` (`clothing-log.js:162,289`) | info | the route uses that handle for the manual line → T6 |
| 6 | `readMerged` picks the newest `tags` line per id/hash by `t` (`clothing-log.js:204-215`) — no manual notion | warn | manual-beats-non-manual rule in that reducer; `tagsFor` unchanged for ingest → T2 |
| 7 | `clothing.rebuildToday()` exists (`clothing.js:544`, `regenerate(true,{rebuildOnly:true})`) | info | the route calls it; a build already running → `regenerate` decides (queue/no-op) — the route reports `builds:false` and the edit still lands on the next build → T6 |
| 8 | `/clothing/status` has no build stamp; the board's `#wardrobeNote` detects a new board with `watcher.checkNow()` (recipe ETag, `board.js:390`) | info | no `builtAt` needed: the sheet polls `watcher.checkNow()` after Done, then `location.reload()` — same door the note uses → T8 |
| 9 | Confirm page is `rows:3, columns:2` (`:1137`); `[3,2]` empty. Browse grids `[3,4]` empty; today pages already put a dwell tile at `[3,4]` (Build my own) and pass the park-corner law (park = literal 0.995/0.995 pixel) | info | placements as specced → T5 |
| 10 | `tests/clothing.test.mjs:302-339` asserts board ids exist and confirm-page buttons; 616 s runtime | warn | additive only; if it asserts an exact button COUNT on `confirm_0`, extend that one assertion, add nothing else there → T5 |
| 11 | `tests/synthetic-wardrobe.mjs` hard-codes 17/12/3/3 and the variety gate depends on it | info | optional `accessories:{jacket:n,…}` arg, default none; existing suites byte-identical → T5 |
| 12 | `board-render.js` stamps `el.dataset.tileType` (`:253`) and closes over `btn` in `onTile(btn, el)` (`:657,:758`); no ids on the element | warn | render stamps `el.dataset.items` when `btn.items` is present → T7 |
| 13 | `dwell.js` tap-rescue fires a `.dwell` tile 150 ms after a long touch; `board-lock.js:340-353` is the proven hold pattern; each sheet owner keeps its own frozen list (`board-lock.js:21-27`) | warn | copy the pattern; drop `.dwell` + set `data-dwell-disabled` on the held tile while armed; fourth frozen list → T8 |
| 14 | `mountPartnerStrip` returns null for `recipe === "today"` (`board-partner.js:580`); the coach mounts on `RECIPE_NAME === "today"` (`board.js:235`) | info | the edit module mounts beside the coach, not in the strip → T8 |
| 15 | era-board Playwright suites hard-code `BASE = http://localhost:8377/board/` and stub routes; the gate rewrites 8377 → `$ERA_TEST_PORT` (`era-gate.sh:138`) and assembles siblings by `ERA_WT_SUFFIX` | info | `board-edit.test.mjs` follows `board-lock.test.mjs` exactly (hasTouch context, stubbed `/settings`, `/outfit-event`); run the gate with `ERA_WT_SUFFIX=--wt-jackets` → T9, T10 |
| 16 | `board-lock.test.mjs:23` documents that `page.touchscreen` cannot hold — the hold is driven by dispatched pointer events | info | reuse its driver → T9 |
| 17 | `invariants.mjs` law 2: allowed holds are dwell / 2×dwell / reading targets; the 1600 ms hold is not a `data-dwell-ms` and lives outside the ladder (the lock proves it) | info | the edit sheet has no `data-dwell-*` anywhere → T8 |
| 18 | Hidden garments may be referenced by history (`page1`, picks) | info | T4 test: a hidden id in yesterday's page 1 / picks neither throws nor re-enters the deal |

No blockers.

## §B Tasks

### Phase 0 — worktrees

**T0 — era-board sibling worktree** · posture: implementing
- `bash /home/claude/aac-board-builder/tools/worktree.sh open /home/claude/new-era/era-board jackets`
  → `/home/claude/new-era/era-board--wt-jackets`, branch `feat/jackets`.
- Verify: `git -C /home/claude/new-era/era-board--wt-jackets status` clean on `feat/jackets`;
  `ERA_WT_SUFFIX=--wt-jackets bash tools/assemble.sh` in the hub worktree reports it
  sourced `era-board--wt-jackets`.
- STOP if: worktree.sh refuses (an old `feat/jackets` branch exists in era-board) — report, don't force.

### Phase 1 — hub, pure modules (era-hub)

**T1 — categories & roles in `clothing-rank.js`** · posture: implementing
- Export `GARMENT_KINDS = ["top","pants","shorts","dress","set"]`,
  `ACCESSORY_KINDS = [{id:"jacket",label:"Jackets",symbol:…},{id:"shoes",…},{id:"jewelry",…},{id:"hat",…},{id:"hair",…},{id:"makeup",…}]`
  (symbols: ARASAAC ids or emoji, whichever the browse grids already use — copy the
  `symbol` convention from `build`'s tiles), `CATEGORIES` (Set of all eleven),
  `OCCASIONS = ["everyday","fancy"]`, `isAccessory(cat)`.
- `CATEGORY` map gains the six accessory words → `"accessory"`; `categoryOf()` returns it.
- `buildCandidates` (and every pool it builds) drops role `"accessory"` and `hidden`
  items before anything else — exactly where it sorts items by id (A4-4).
- `accessoryOrder(items, band)` → items of one kind sorted by `|level(warmth) − level(band)|`
  then id; `band` null → by id. Warmth levels reuse the existing word→level mapping
  (`any` → distance 0).
- Tests first, `tests/clothing-rank.test.mjs`: `categoryOf` for all eleven words + junk;
  `buildCandidates` over a wardrobe with 3 jackets + 1 hidden top never emits an accessory
  id or the hidden id, and deals the same 21 as without them; `accessoryOrder` on a cold
  band puts `cold` before `cool` before `any` before `hot`, ties by id, null band = id order.
- Verify: `node --test tests/clothing-rank.test.mjs tests/clothing-variety.test.mjs`.
- STOP if: the variety gate's 35-garment fixture output changes (it must not — hidden and
  accessories are absent there).

**T2 — manual precedence in `clothing-log.js`** · posture: implementing
- `usable("tags", line)` accepts `occasion`, `hidden`, `manual` (booleans/whitelist).
- The tags reducer (`:204-215`): a `manual:true` line beats any non-manual line for the
  same key regardless of `t`; among manual lines newest `t` wins; among non-manual,
  as today. Expose the winning line's `manual` and `t` to the caller (`tagsFor` result
  carries them).
- Tests first, `tests/clothing-log.test.mjs`: manual older than a non-manual newer →
  manual wins; two manual → newest; a manual line naming neither id nor hash is skipped;
  torn last line unchanged; the reducer is byte-stable for wardrobes with no manual lines
  (snapshot an existing case).
- Verify: `node --test tests/clothing-log.test.mjs`.
- STOP if: `usable()` is shared with `picks`/`offers` validation in a way that would
  loosen those kinds — keep the new fields tags-only.

**Gate 1:** `rae-flow:reviewing` on the Phase 1 diff; T1+T2 green; commit (prose
message, trailers). Retro note appended to §C.

### Phase 2 — hub, worker + route (era-hub)

**T3 — classifier: prompt, whitelist, occasion** · posture: implementing
- `INGEST_PROMPT` per spec §3.3 (opening sentence + category clause + occasion clause);
  `ATTRS_PROMPT` untouched.
- `namePhotos` writes `category` through `CATEGORIES` (unknown → `"top"`, unchanged
  default) and `occasion` through `OCCASIONS` (default `"everyday"`); the known-item
  redraw `meta` and the shared-tag `meta` carry `occasion`, `hidden`, `manualAt` through
  (`...known` already keeps them — assert it). `shareTag` includes `occasion`.
- Tests first, `tests/clothing-attrs.test.mjs` (fake model on 8462, owns its wardrobe)
  or a new small block in the accessories suite (T5's ports): the fake answers
  `category:"jacket", occasion:"fancy"` → catalogue has both; junk category → `"top"`,
  junk occasion → `"everyday"`; the shared tag line carries `occasion`; the prompt string
  contains every one of the eleven words exactly once (guards drift).
- Verify: `node --test tests/clothing-attrs.test.mjs`.
- STOP if: `askModel`'s JSON parse rejects the longer reply (max_tokens 480 is per
  provider — measure a real reply length in the fake; if the prompt pushes answers past
  it, raise the cap in all three provider blocks together and note it).

**T4 — manual sweep, `edits.json`, hidden** · posture: implementing
- `clothing-worker.js`: `applyManual(cat, edits, merged)` after `loadCatalog()` on both
  build paths (preflight 3): for each `ok` item, candidates = own `edits[id]` and the
  merged shared manual line (by id then hash); the newest `t` among them, if newer than
  `item.manualAt` (or none), applies `category`/`occasion`/`hidden` and stamps
  `manualAt = dayKey(t)`; `saveCatalog` iff anything changed. Unreadable `edits.json` →
  one log line, treated as empty, never deleted.
- `wardrobe/edits.json` shape `{ [id]: {category?, occasion?, hidden?, t} }`; the worker
  only reads it. Prune (worker, after apply): entries with `t` older than 60 days whose
  item already carries `manualAt >= dayKey(t)` are dropped — write back with
  `contentStore.writeAtomic` **only** if the main thread is not the writer at that
  moment: simplest safe rule — the worker never writes edits.json; the route prunes on
  its own next write. (Choose this; note it in the code.)
- `buildCataloged`: `items` excludes `hidden`; `present` kinds computed from un-hidden
  accessories with tiles.
- The needs-attributes pass leaves `category`/`occasion`/`hidden` alone (it only writes
  `attributes(meta)` — assert with a test, don't assume).
- Tests first, in the new `tests/clothing-accessories.test.mjs` (hub 8465, fake model
  8467; wardrobe from `synthetic-wardrobe.mjs` + explicit jacket/hoodie photos as the
  existing suites make them): an `edits.json` entry moves a top to `jacket` on a
  rebuild-only build and stamps `manualAt`; a shared manual line from a second writer
  does the same on a second DATA dir; a later manual line wins over an earlier one;
  a hidden item disappears from every board and from `present`; a hidden id sitting in
  yesterday's `page1` and in picks neither throws nor returns (preflight 18); the
  attributes pass on a manual item does not touch its category.
- Verify: `node --test tests/clothing-accessories.test.mjs` (and `clothing-attrs`).
- STOP if: `readMerged` is not reachable on the rebuild-only path without opening the
  Drive mount (check `shared()` init order) — then open it the same way the attrs pass does.

**T5 — the board graph** · posture: implementing
- `buildCataloged`/`gridPages` per spec §4.1: `items:[{id,name,category,occasion}…]`
  on every garment/outfit tile (objects, not bare ids — the board's edit sheet names
  the rows from them; spec §4.1 amended here);
  `present`; entry tile (`type:"category"`, label/symbol from `ACCESSORY_KINDS` or
  "Accessories"/`acc`) at confirm `[3,2]`, every browse page `[3,4]` (`gridPages` gains
  `extra`), a Build-my-own row; `acc` menu when ≥ 2 kinds (layout = Build my own's);
  `acc_<kind>` grids via `gridPages` with `accessoryOrder`, Back → `today`, no entry
  tile; recipe root gains `categories: [{id,label}]` (garments then accessories).
  Zero accessories → boards byte-identical to today except the `items` field (assert).
- `tests/synthetic-wardrobe.mjs`: optional `accessories` counts (preflight 11).
- Tests first, `tests/clothing-accessories.test.mjs`: with one jacket → `acc_jacket`
  exists, entry tile "Jackets" at `confirm_0` [3,2], at `cat_top` [3,4] on every page,
  Build row present, no `acc` board; add a shoe → label "Accessories", `acc` board with
  two tiles, `acc_shoes` exists; jackets ordered by band (fake weather cold); `items`
  on tiles; root `categories`; no accessories → the recipe equals the pre-change
  recipe modulo `items` (deep-compare after deleting `items`).
- `tests/clothing.test.mjs` (preflight 10): only if an exact confirm-button count
  breaks — extend that assertion; nothing else.
- Verify: `node --test tests/clothing-accessories.test.mjs`; then, once,
  `node --test tests/clothing.test.mjs` (budget 900 s) to prove nothing moved.
- STOP if: `board-pixel`/`board-input` gates (run in Phase 3) reject a tile at
  confirm `[3,2]` — fall back to no entry tile on the confirm page and report; do not
  move it into the msgbar or the centre.

**T6 — `POST /clothing/item`, status, Settings sentence** · posture: implementing
- `server.js` route per spec §5.1: `ownDoor`, 4 KB cap, validation (id regex + exists
  in catalogue; `category` ∈ `CATEGORIES`; `occasion` ∈ `OCCASIONS`; `hidden` boolean;
  ≥ 1 field), `400 {error}` / `503` on an unreadable catalogue (preflight 4), then in
  order: `edits.json` RMW via `writeAtomic` (the route prunes 60-day stamped entries
  here), `clothingLog.appendTag({...currentTag, ...fields, manual:true, id, hash})`,
  `clothing.rebuildToday()` → `200 {ok:true, builds}`.
- `/clothing/status` adds `accessories:{kinds:[{kind,count}], hidden}` (read-only).
- `public/settings/index.html`: one sentence under the Clothing Picker card from
  `status.accessories`, through `CT_ESC`; nothing when empty.
- Tests first: `tests/clothing-accessories.test.mjs` — happy path writes the file and
  the tag line (`manual:true`, `hash` present) and the next build moves the item; each
  400 case; ownDoor refusal (copy the books-route test shape); a second POST for the
  same id replaces the entry; status payload. `tests/settings-ui.test.mjs` (8423) — the
  sentence renders and escapes.
- Verify: `node --test tests/clothing-accessories.test.mjs tests/settings-ui.test.mjs tests/routes.test.mjs`.
- STOP if: `routes.test.mjs` has a route-surface snapshot that must list every POST —
  add the row, don't skip the test.

**Gate 2:** `rae-flow:reviewing` on the Phase 2 diff against spec §3–§5; all Phase 1–2
suites green; `node --test tests/clothing-variety.test.mjs` unchanged; commit. Retro §C.

### Phase 3 — board (era-board--wt-jackets)

**T7 — render stamps ids** · posture: implementing
- `board-render.js`: beside `el.dataset.tileType = type` (`:253`),
  `if (btn.items) el.dataset.items = btn.items.map(i => i.id).join(",")`, and export
  `tileButton(el)` backed by a `WeakMap` set in the same place (the render already
  closes over `btn`).
- Test first: `tests/board-model.test.mjs` or `board-clothing-visuals.test.mjs` — a
  recipe tile with `items` renders `data-items` and `tileButton(el).items` returns the
  objects; one without renders neither.
- Verify: `node --test tests/board-clothing-visuals.test.mjs`.

**T8 — `app/board-edit.js`** · posture: implementing (STOP conditions below)
- Mount from `board.js` beside the coach when `RECIPE_NAME === "today"`; export
  `mountEditSheet({root, watcher, categories})` and `window.__editTest = {holdMs, open(ids), close}`.
- Arm/fire per spec §4.2, copied from `board-lock.js:319-381`: `pointerdown` on
  `[data-items]` with `pointerType === "touch"` → `preventDefault`, remove `.dwell` +
  set `data-dwell-disabled` on that tile, `.holding` + `--hold-ms`, 1600 ms timer;
  `pointerup/cancel/leave` before → restore tile (+ `Dwell.suppress(600)`), nothing
  fires and no click is replayed; `contextmenu` on the tile while armed →
  `preventDefault`. Timer fires → own `frozen` list (freeze every `.dwell` like
  `applyLock` does), open the sheet.
- Sheet (`#editSheet`, fixed bottom, above `footerClearance()`): one row per item —
  `<img src="wardrobe-items/<id>.jpg">`, name, category chips from `recipe.categories`,
  Fancy / Hide toggles; Cancel / Done. The rows come from the tile's `items` objects
  (T5 shape `{id, name, category, occasion}`), reached through `tileButton(el)` (T7),
  never by parsing the label. No `.dwell`, no `data-dwell-*` anywhere in the sheet.
- Done: for each changed row `fetch("/clothing/item", POST JSON)`; all 2xx → text
  "Updating the board…", poll `watcher.checkNow()` every 1 s up to 60 s → on change
  `location.reload()`; on timeout "The board will update by itself in a minute" and
  close. Any non-2xx → show `error` text (or the offline sentence), keep the sheet.
  Cancel → thaw, `Dwell.suppress(600)`.
- CSS in the board's stylesheet, copying the lock banner/keypad tokens.
- STOP if: (a) freezing must survive a `render()` (a re-render while the sheet is open)
  — do what `syncLock` does post-render; (b) `pointerleave` fires on the tablet when the
  finger drifts a few px (the lock had this?) — check `board-lock.js` comments before
  changing the cancel set; (c) the confirm-page outfit tile has `say_on_load` semantics
  that interact with the hold — test both tile types.

**T9 — `tests/board-edit.test.mjs`** · posture: implementing
- Harness = `board-lock.test.mjs` (hasTouch context, stubbed routes, the pointer-event
  hold driver; stub `/clothing/item` → 200 and `/recipes/today.json` ETag flip to
  simulate the rebuild).
- Cases (spec §8): mouse pointerdown 2 s → no sheet, tile still `.dwell`; touch hold
  1600 ms → sheet with one row (garment tile) / two rows (outfit tile), board frozen;
  touch release at 1000 ms → no sheet, no `outfit-event`, tile speaks nothing, `.dwell`
  restored; during a hold the tap-rescue does not fire (`/outfit-event` never called,
  no navigation); Done posts `{id, category:"jacket"}` for the changed row only, then
  reloads after the ETag flip; Cancel posts nothing and thaws; 400 keeps the sheet
  with the hub's sentence; sheet bottom sits above the standing footer.
- Also run: `node --test tests/board-pixel.test.mjs tests/board-input.test.mjs
  tests/board-clothing-visuals.test.mjs tests/board-lock.test.mjs` against a hub serving
  a recipe with accessories (the gate does this; locally use a scratch hub on 8481+
  over `synthetic-wardrobe.mjs --materialize` with jackets).
- Verify: the five suites green.
- STOP if: `board-pixel` rejects the entry tile at confirm `[3,2]` (see T5 STOP).

**Gate 3:** `rae-flow:reviewing` on the era-board diff against spec §4.2; commit in
`era-board--wt-jackets`; `ERA_WT_SUFFIX=--wt-jackets bash tools/assemble.sh` in the hub
worktree; hub tests that render the board still green. Retro §C.

### Phase 4 — gate, land, patch, push

**T10 — era-gate + land + patch + push-device** · posture: collaborating (dad's word
needed for publish; the rest is mechanical)
- `ERA_WT_SUFFIX=--wt-jackets bash tools/era-gate.sh` in the hub worktree (never 8377;
  gate uses 8378). One red in `board-arrange.test.mjs` → re-run once before digging.
- Land in dependency order while the 2 h stamps hold: `worktree.sh land
  /home/claude/new-era/era-board jackets` then `… era-hub jackets`. If master moved:
  `sync` (merge, never rebase), re-check the stamp.
- `bash tools/release.sh v0.33.7 --patch --dry-run` (or the next free Z at the time)
  → dist with `VM-GREEN legs∋b`; then `bash tools/push-device.sh tablet <dist>` (the
  tablet is on unpublished v0.33.6; a real `--patch` publish only on dad's word).
- Verify: gate summary `N passed, 0 failed`; `git log master --oneline -3` shows both
  lands; the tablet's `/settings/` reports the new build stamp.
- STOP if: `land` refuses (dirty main checkout, moved master) — report the sentence.

### Phase 5 — behavioral verification (mandatory)

**T11 — prove it works as she and dad would see it** · posture: implementing
- Scratch hub (8481/8482 — `ss -ltn` first) over a materialized synthetic wardrobe
  with 3 jackets + 1 shoe photo (real photo files through the fake model on 8482
  answering `jacket`/`shoes`; `ERA_WEATHER_URL` fixture = cold day). Playwright
  recording (gif/webm, `playwright-cli`, hasTouch): today → outfit → "This one?" →
  Accessories → Jackets → tap "Blue puffer" (TTS stub logs the utterance) → Back →
  Change top → tops grid → hold a hoodie 1.6 s → sheet → Jacket → Done → board reloads
  → hoodie on the Jackets grid, gone from tops. Then `curl -s :8481/clothing/status | jq .accessories`
  → `{kinds:[{kind:"jacket",count:4},{kind:"shoes",count:1}], hidden:0}` and
  `cat <DATA>/wardrobe/edits.json` shows the hoodie entry; the Drive folder's
  `clothing/.era/tags/<device>.jsonl` last line has `"manual":true`.
- Second DATA dir on the same Drive folder: one rebuild → the hoodie is a jacket there
  too (`grep hoodie <DATA2>/wardrobe.json` shows `"category":"jacket"` and `manualAt`).
- On the tablet after push-device: dad holds a real tile; report what he saw. (Dad
  never tests a branch — this is post-push, per dev-flow.)
- Evidence: recording + command output under `~/new-era/dist/qa/2026-09-17-accessories/`
  and linked from §C.
- Verify: every line above has its expected output captured; a miss is a bug, not a
  note.

## §C Retro / evidence (appended per gate)

**Gate 1 (9/17)** — T1 + T2 green: `node --test tests/clothing-rank.test.mjs
tests/clothing-log.test.mjs tests/clothing-variety.test.mjs` → 187 pass, 0 fail.
Byte-identity proven both ways: 70 `buildCandidates` deals (35 garments × 5 bands × 7
seeds) against `git show HEAD:clothing-rank.js` — 0 differ; `readMerged` snapshot on a
three-writer fixture with no manual lines — identical.
Decisions: (1) `attributes()` does NOT carry `occasion`/`hidden`/`manualAt` — it is what
the needs-attributes pass and the shared-tag path write over an item, so widening it
would let the model overwrite a parent's edit (spec §3.2); `toWorkerShape` passes them
through whole. T3 parses `occasion` beside `category`; T4 owns `hidden`/`manualAt`.
(2) `accessoryOrder`: `any`/untagged is distance 0 and ties with the exact band match
(the plan's prose said "before hot" and was loose; the metric is the rule).
(3) A malformed optional field (`occasion:"weird"`, `hidden:"yes"`, `manual:1`) is
dropped and the line stands — the file's existing rule for warmth/rotate/crop;
`manual:1` therefore cannot smuggle precedence. (4) The reducer carries `t` only on a
manual winner (unconditional `t` broke byte-stability and leaked onto every item).
(5) Symbols are ARASAAC bestsearch words, checked live 9/17 (jacket 2319, shoes 2622,
jewelry 29088, hat 2572, hair 2851, make up 8626). Gate fix: clothing-log's local
`OCCASIONS` now imports the clothing-rank list (the T2 builder left it local to avoid
racing T1 in the shared worktree).


## §D Follow-ups (not this cut)

- "Dress up" page over `occasion:"fancy"` (garments + accessories).
- Rename in the hold sheet; optional PIN reuse of the lock keypad.
- Settings wardrobe list on the same route (the 9/4 "too busy" ruling stands for now).
- Tracked outfit + jacket (3-id combos) if dad wants the Yes to carry it.
- Prune `<DATA>/clothing/.era` and the growing `tags/` files (known since 9/6).
