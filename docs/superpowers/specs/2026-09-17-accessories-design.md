# Accessories — jackets first, with a hold-to-edit override (design)

**Date:** 2026-09-17 · **Branch:** `feat/jackets` (era-hub) + a matching era-board branch
**Origin:** dad, 9/17: "it is getting cooler here and so we need to evaluate how to add
jackets to options. I don't think this should be done in the combo portion. Once she
selects her clothes, she should be able to add accessories. Sometimes she chooses her
combo and then changes her pants/shirt so I think each page needs to offer accessories.
In future accessories could include jewelry, shoes, makeup, hair … dress up clothes for
fancy events. How can the AI categorize items purely based on photos, and can there be
a user override without too many changes to UX — the touch-only long touch could allow
modifications."

Decisions taken with dad on 9/17 (AskUserQuestion, three rounds):
1. **Flow shape: speak it, like Change top.** A jacket is a tile she taps and the board
   speaks its name — the board stays stateless; no tracked outfit, `combo` stays ≤ 2 ids.
2. **Classifier learns every accessory kind now, plus a fancy flag.** Only Jackets gets
   UX polish this cut; the other grids come for free from the generic page builder.
3. **Hold sheet = category chips + Fancy + Hide from board.** No rename, no PIN.

## 1. What exists (verified 9/17 against `27376a4`)

- The catalogue is `<DATA>/wardrobe.json {items:{<relpath>: item}}`; the only item
  writer is `clothing-worker.js` (`namePhotos`, ~line 857). `category` is one of
  `top pants shorts dress set`, whitelisted inline; **an unknown word becomes `"top"`.**
- `clothing-rank.js` `CATEGORY` (line ~315) maps category → pool role
  `top | bottom | single`; `categoryOf()` returning `null` parks a garment out of every
  pool. The deal, composites and `/outfit-event` (`server.js` ~1666, `combo` length 1..2)
  only ever see garments.
- The vision model is asked once per new photo (`INGEST_PROMPT`, ~line 426; `ATTRS_ASK`
  for the taste attributes). Answers are shared family-wide as `tags/<writer>.jsonl`
  lines in `<Drive folder>/clothing/.era/` (spec 2026-09-05 §5); a shared line is read
  **only at ingest** of a new photo (`tagsFor`). `attrsAt` is a one-way door — a
  described garment is never re-asked.
- The board (`era-board/app`, copied to `public/board` by `tools/assemble.sh`) renders
  `/recipes/today.json`, built by `buildCataloged()` (~1047) and `gridPages()` (~1020).
  Today pages: 7 outfit slots + weather/Back [1,1] + More [3,1] + Build my own [3,4],
  centre [2,2][2,3] black — full. "This one?" (`confirm_<i>`, 3×2): photo, Yes, Change
  top, Change bottoms, Back — **[3,2] empty.** Browse grids (`cat_*`, 3×4): Back [1,1],
  six garment tiles at [1,2][1,3][1,4][2,1][2,2][2,3], More [3,1] — **[2,4][3,2][3,3][3,4]
  empty.** A garment tile (`type:"clothing"`) has no `load`: tapping it speaks the name.
  Yes speaks "Yes" and posts the pick; nothing else happens.
- There is **no** route, Settings control or gesture that edits a garment. The closest
  editing pattern is books: `POST /content/rename` / `/content/remove` — `ownDoor`-gated,
  4 KB body, module owns policy, `{error|refused}` → 400/409.
- Touch-only gestures: `board-lock.js` hand-rolls a 1600 ms hold on `pointerdown` with
  `pointerType === "touch"` (ERAgaze drives the real cursor, so gaze == mouse at the DOM;
  `touch` is the entire filter), `preventDefault`, own `contextmenu` suppression, no
  `.dwell` class. `dwell.js` (era-core) has a **tap-rescue**: a long touch on a `.dwell`
  element fires `el.click()` 150 ms after release when Windows swallowed the click — so a
  hold on a garment tile must take the tile out of `.dwell` while armed. Each sheet owner
  (partner, arrange, lock) keeps its own frozen-tile list.
- The family wardrobe (era-family fixture, 35 garments) holds **no jackets, hoodies or
  sweaters** — jackets will be new photos; no re-describe pass is needed.

## 2. Goals / non-goals

Goals: (a) jackets on the board wherever she is after choosing a combo, spoken like any
garment; (b) photos of any accessory kind, and fancy wear, filed by the model at ingest
with no code change per kind; (c) a grown-up can correct category / fancy / hidden from
the board with one touch gesture, and the correction reaches every family device and is
never undone by the model; (d) the 9/5 deal, ranking, memory and sharing are untouched.

Non-goals (this cut): a tracked outfit + jacket (3-id combos, 3-piece composites); a
"Dress up" page (the `occasion` tag is captured, not surfaced); rename; a PIN on the
sheet; a Settings wardrobe editor (can be added later on the same route); any change to
the today pages, the 7-slot contract, the msgbar or Yes; migration-tool changes.

## 3. Data model & classifier

### 3.1 Categories

```
GARMENTS    = top pants shorts dress set            (pooled as today)
ACCESSORIES = jacket shoes jewelry hat hair makeup   (never pooled)
```

`clothing-rank.js`: `CATEGORY` gains the six accessory words → role `"accessory"`;
`categoryOf()` returns `top | bottom | single | accessory | null`. `buildCandidates`,
`eligible`, `harmonizes`, composites and the favourites derivation filter on the three
garment roles exactly as now — an accessory can never reach `combo`. Exported
`ACCESSORY_KINDS` (ordered: jacket, shoes, jewelry, hat, hair, makeup) with a display
label and an ARASAAC/emoji symbol per kind is the single list every other module reads.

### 3.2 Item fields (additive)

| field | values | default | who writes |
|---|---|---|---|
| `category` | garments + accessories | `"top"` on an unknown word (unchanged) | model / manual |
| `occasion` | `"everyday" \| "fancy"` | `"everyday"` | model / manual |
| `hidden` | bool | `false` | manual only |
| `manualAt` | `YYYY-MM-DD` | absent | the hub, when a manual edit is applied |

The worker's inline `category` whitelist (~859) is replaced by one `CATEGORIES` set
imported from `clothing-rank.js`, so the prompt, the whitelist and the pools cannot
drift. `attributes()` stays the taste-attribute whitelist; `occasion` is parsed beside
`category`/`warmth`.

**Manual beats model, forever.** A `manualAt`-stamped item keeps its `category`,
`occasion` and `hidden` through every path that rebuilds an entry: the known-item redraw
(`meta = {…known}` already carries them), the needs-attributes pass (touches only taste
attributes — no change needed, documented), and the manual sweep (§3.4).

### 3.3 The prompt

`INGEST_PROMPT` category clause becomes:

> `"category": one of "top","pants","shorts","dress","set","jacket","shoes","jewelry","hat","hair","makeup" — "jacket" is an outer layer worn over another top and taken off indoors (jacket, coat, hoodie, cardigan, zip fleece, vest; a pullover sweater is a "top"); "set" is a matching top and bottom; "hair" is a hair accessory (clip, band, bow); "jewelry" is a necklace, bracelet, ring or earrings,`
> `"occasion": "fancy" only if it is party, holiday or dress-up wear, else "everyday",`

The opening sentence changes from "one clothing item (or a matching set)" to "one
clothing item, accessory or matching set". Warmth is asked as before (it orders the
jackets). `ATTRS_PROMPT` is unchanged. `top_side`/`crop` stay: the cut-out pipeline
(u2netp, `segment.cutOut`) is used as-is for accessories; a poor cut-out is cosmetic.

### 3.4 Sharing — `tags/` lines

A tag line gains `occasion`, `hidden` and `manual: true`. Reader rule in
`clothing-log.js` (merged `tags` map): **a manual line beats any non-manual line for the
same id/hash regardless of `t`; among manual lines the newest `t` wins.** Non-manual
lines behave exactly as today.

**Manual sweep** (new, `clothing-worker.js`, at the top of every build after
`loadCatalog()`): for every `ok` item, look up the merged tags by id then hash; if the
winning line is manual and its `t` is newer than the item's `manualAt` (or the item has
none), apply `category`/`occasion`/`hidden` from it and stamp `manualAt`. Also apply the
device's own local edits (§4.2) the same way. This is the narrow sweep spec 2026-09-05
§3.1 rejected for model tags, and it is safe here: only a human writes a manual line, and
the newest human wins. A device never reads its own mirror lines back (A4-9), which is
why its own edits live in a local file too.

### 3.5 Existing wardrobes

No re-describe pass and no migration-tool change. Anything mis-filed (a hoodie the model
called a top last month) is corrected with the hold sheet; the `attrsAt` door stays shut.

## 4. What she sees

All boards are built server-side in `clothing-worker.js`; the board learns nothing new
to render them. Every garment/outfit tile gains `items: [id…]` (one id on a garment
tile, the `combo` ids on an outfit tile) so the board can name what is under a finger.

### 4.1 Boards

Let `present` = the accessory kinds that have at least one `ok`, un-hidden item with a
tile, in `ACCESSORY_KINDS` order.

- **Entry tile.** When `present.length === 0` there is no entry tile anywhere (today's
  boards, byte-identical). When `present.length === 1` the tile is that kind ("Jackets",
  its symbol, `load: "acc_jacket"`). When ≥ 2 the tile is "Accessories" (`load: "acc"`).
  It is a `type:"category"` tile like Build my own — a dwell target, never a partner
  control.
- **"This one?"** — entry tile at `[3,2]`.
- **Browse grids** `cat_top / cat_pants / cat_shorts / cat_dress / cat_outfit` — entry
  tile at `[3,4]` on every page of the grid (the corner Build my own uses on today pages).
  `gridPages` gains an optional `extra` button placed on each page.
- **Build my own** — a row for the entry tile (label/symbol as above) after Outfits.
- **Accessories menu** `acc` (only when ≥ 2 kinds): one tile per present kind, laid out
  like Build my own, Back → `today`.
- **Accessory grids** `acc_<kind>` — `gridPages` over that kind's items, `type:"clothing"`
  tiles (tap speaks the name), Back → `today`, More as usual, **no entry tile** on these
  pages. Jackets are ordered by closeness of their warmth level to today's band level
  (`|level(item) − level(band)|`, ties by id), so on a cold day coats lead; with no
  weather, catalogue order by id. Other kinds: by id. **Accessories are never
  weather-hidden** (dad may reverse: flagged).
- **Hidden items** (`hidden: true`) are dropped from `items` at the top of
  `buildCataloged` — out of the deal, every grid, and `present`.
- Today pages, `choose_bottom`, Yes, `/outfit-event`, composites: unchanged.

### 4.2 The hold-to-edit sheet (era-board `app/board-edit.js`)

Mounted on the clothing board only (`recipe === "today"`), like the coach.

- **Arm:** `pointerdown` on a tile with `items` and `pointerType === "touch"` →
  `preventDefault()`, `contextmenu` suppressed, the tile loses `.dwell` and gets
  `data-dwell-disabled` (as `applyLock` does) so dwell.js's tap-rescue and the gaze fill
  cannot fire it, `--hold-ms` fill ring, timer = `HOLD_MS = 1600` (the lock's number).
  `pointerup`/`pointercancel`/`pointerleave` before the timer: restore the tile, nothing
  fires — and the tap that already happened is NOT replayed (holding is not tapping).
- **Fire:** freeze the board with its own frozen list (fourth owner beside partner,
  arrange, lock), open a bottom sheet: one row per id — 96 px thumbnail
  (`wardrobe-items/<id>.jpg`), name, category chips (`CATEGORIES` in garment-then-
  accessory order, current one selected), **Fancy** and **Hide from board** toggles —
  then **Cancel** / **Done**. Everything in the sheet is a plain button: no `.dwell`, no
  gaze handlers, `pointerType` unchecked (once open, a mouse may drive it — the hold is
  the gate). The sheet must measure the standing footers (`footerClearance` twins) as the
  lock banner does.
- **Done:** one `POST /clothing/item` per changed row (§5). On 2xx the sheet shows
  "Updating the board…", polls `/clothing/status` until `builtAt` moves past the request
  time (≤ 60 s; the `#wardrobeNote` watcher already polls this endpoint), then reloads
  the recipe in place (`acceptNewRecipe`) and thaws. On a non-2xx or a timeout it shows
  the hub's sentence (or "Couldn't reach the hub — try again in a moment") and stays open
  with the values kept. Cancel thaws with no request.
- Names for the chips come from the recipe (`ACCESSORY_KINDS` is echoed into the recipe
  root as `categories: [{id, label}]`, garments first) so the board has no list of its
  own to drift.

## 5. The hub side

### 5.1 `POST /clothing/item`

Body `{id, category?, occasion?, hidden?}` (4 KB cap). `ownDoor`-gated like
`/content/rename`. Validation: `id` matches `/^item_[0-9a-f]{4,32}$/` and names a
catalogued item; `category` ∈ `CATEGORIES`; `occasion` ∈ `{everyday, fancy}`; `hidden`
boolean; at least one field present. Failures → `400 {error}`; a build in progress that
cannot take the edit yet is NOT an error (the edit is queued in the file and applied on
the next build). Answers `200 {ok:true, builds:true|false}`.

Effect, on the main thread, in order:
1. `wardrobe/edits.json` — `{ [id]: {category?, occasion?, hidden?, t} }`, read-modify-
   write with `writeAtomic` (one writer: the route). Newer `t` per id replaces.
2. `clothingLog.appendTag({id, hash, …fields, manual: true})` — the shared line; never
   throws (existing discipline). `hash` and the unchanged fields are copied from the
   catalogue so the line is a complete tag for a device that has not ingested the photo.
3. `clothing.rebuildToday()` — the door the weather-window save uses; a rebuild-only
   build: no ingest, no model calls, the manual sweep runs, the recipe is rewritten.

The worker's manual sweep (§3.4) reads `edits.json` first (own edits, always), then the
merged shared tags (other devices' manual lines), newest `t` per id winning across both.
`edits.json` is pruned of entries older than 60 days that are already stamped into the
catalogue.

### 5.2 `/clothing/status`

Adds `accessories: { kinds: [{kind, count}], hidden: <n> }` for the Settings read-out
(one sentence under the Clothing Picker card: "Accessories: 4 jackets · 2 hidden items").
Read-only, no writes on a poll (existing rule).

## 6. Data flow

1. Dad photographs a jacket into `clothing/`. Next tick: `namePhotos` asks the model →
   `category: "jacket"`, `occasion: "everyday"`, warmth `cold`; tile drawn; `tags/` line
   shared; `present = [jacket]`; the build adds "Jackets" tiles to This one?, every
   browse grid and Build my own, and an `acc_jacket` grid.
2. She picks an outfit → "This one?" → Jackets → taps "Blue puffer" → the board says
   "Blue puffer". Or: Change top → tops grid → Jackets from the same corner.
3. The model filed a hoodie as a top. Dad holds the tile 1.6 s on the tops grid → sheet →
   Jacket chip → Done. The hub writes `edits.json`, appends the manual line, rebuilds; the
   sheet reloads the board; the hoodie is now on the Jackets grid, gone from the outfits.
4. The i13 pulls the mirror within 10 minutes; its next build's manual sweep moves the
   hoodie too (tomorrow morning, or on its next rebuild).
5. A shoes photo next month: the model says `shoes`; `present = [jacket, shoes]`; the
   entry tile becomes "Accessories" and the `acc` menu appears — no code change.

## 7. Error handling

- Model returns an unknown category → `"top"` (unchanged) — the sheet corrects it.
- `edits.json` unreadable → logged, ignored for the build, kept on disk (never deleted
  by a reader). A torn shared line is skipped (existing).
- Hub unreachable from the sheet → message, values kept, no retry loop.
- A hidden item's photo is deleted → `prune()` removes the entry as today.
- `present` computed from items **with tiles** — an accessory whose tile is missing
  never produces an empty grid.

## 8. Tests (node:test; no key, no network; ports grepped across all five repos before
assignment — 8391 and 8423 are known collisions, 8440/8441 are holes)

- `tests/clothing-rank.test.mjs` — `categoryOf` for every word; accessories never in
  `buildCandidates` output; jacket ordering by band; `CATEGORIES`/`ACCESSORY_KINDS`
  shape.
- `tests/clothing-log.test.mjs` — manual line beats a newer non-manual line; newest
  manual wins; a manual line missing `id` and `hash` is unusable.
- `tests/clothing-accessories.test.mjs` (new; own hub + fake-model ports) — fake model
  returns a jacket and a hoodie-as-top: `acc_jacket` exists, entry tile at This one? [3,2],
  every browse page [3,4], Build my own row, label "Jackets"; add shoes → "Accessories" +
  `acc` menu; `POST /clothing/item` happy path (edits.json written, tag line appended
  with `manual:true`, rebuild moves the hoodie, `manualAt` stamped), 400 on bad body,
  ownDoor refusal, hidden item leaves the deal and the grids; a second DATA dir on the
  same Drive folder applies the manual line on its build; `/clothing/status.accessories`.
- `tests/synthetic-wardrobe.mjs` — optional jacket/shoe counts for the helper.
- era-board `tests/board-edit.test.mjs` (Playwright, stubbed) — mouse pointerdown never
  arms; touch hold opens the sheet; release at 1000 ms neither opens it nor speaks the
  tile; dwell tap-rescue does not fire during a hold; Done posts the right body and
  reloads on a status change; Cancel posts nothing; footer clearance; `board-pixel` and
  `board-input` gates pass with the new tiles (entry tiles are dwell; sheet is not).
- `tests/settings-ui.test.mjs` — the accessories sentence.
- Gate: `bash tools/era-gate.sh` green → `worktree.sh land` → `release.sh vX.Y.Z --patch`
  → `push-device` to the tablet, per `docs/dev-flow.md`.

## 9. Flagged to dad (reversible)

- Accessories never weather-hidden; jackets only re-ordered.
- No PIN on the hold sheet; the 1.6 s hold is the deterrent (the media lock's keypad can
  be bolted on later).
- Entry tile is a dwell target (she can reach Jackets by gaze) — deliberate: it is her
  choice, not a grown-up control.
- Other devices apply a manual edit on their next build, not immediately.
- Six accessory words fixed now; "makeup" and "hair" are the least certain from a flat
  photo — the sheet is the fix.
