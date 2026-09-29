# Warmth coherence + the Dress up page — amendment to the 9/23 warmth model

**Date:** 2026-09-29 · **Branch:** `fix/weather` (era-hub + era-board) · **Amends:** `2026-09-23-warmth-model-design.md` (unit B)
**Origin:** dad, 9/29, after checking the board on an 81 °F morning:

> *"it was 79 on the app … there were multiple options that were long sleeve and pants. I would have
> expected on a 79 degree day that you would have pretty much almost everything shorts, maybe one pant
> outfit, and nothing long sleeve. … fetch the clothing from Ellie and go through a process of simulating
> different weathers and make sure that they're coherent … some sort of testing for deploys."*
>
> *"I selected fancy on a few outfits … I want to make sure that fancy should be in accessories and should
> not be eligible for the daily offerings."*

## 1. What the board actually dealt (the receipt)

Tablet, 2026-09-29, `.weather-cache.json`: `t: 81, band: hot, place: "ip"`. `recipes/today.json`, 18 looks:

| in the deal | looks |
|---|---|
| a long-sleeve top (cardigan, sweater, sweatshirt, shacket, 3× "long sleeve") | **7 / 18** |
| leggings | **11 / 18** |
| shorts | 4 / 18 |
| a garment dad marked **fancy** (Polka dot dress, `manualAt 2026-09-27`) | page 3 |

Her catalogue that morning: 63 items — 29 tops (5 hot / 15 warm / 9 cool), 10 pants (8 warm / 2 cool),
8 shorts (all hot), 7 dresses, 4 sets, 5 jackets; 3 dresses `occasion: fancy`; nothing hidden.

Three lines explain all of it, and the 9/23 spec §1 had already named them:

1. `clothing-rank.js eligible` (`:372-377`) — **tops are never gated.** Her nine `cool` tops are exactly her
   long sleeves; all 29 enter every deal.
2. `BAND_WARMTH.hot = {1}` and `WORD_LEVELS.warm = [1]` — a hot day admits every `warm` legging beside the
   shorts (8 and 8); leggings pair more freely under the harmony rule and win 11–4.
3. `buildCandidates` drops `hidden` and accessories at its door (`:434`) and **never reads `occasion`.**
   Fancy is stored, editable and shared — and consumed by nothing.

Unit B was specified 9/23 and never built. This amendment is what changes in it, decided from the receipt.

## 2. Decisions (9/29)

**D1 — unit B ships now, without waiting for unit C.** The 9/23 ordering (A → C → B) existed because §6's
re-describe pass spends one vision call per garment on every device. Two changes remove that dependency:

- `coverage` / `weight` / `legs` join the **ingest prompt** — the same call that already names and
  categorises a new photo. A new garment costs nothing extra and rides the dedup that exists today.
- The existing 63 are migrated by an **operator-run pass on ONE device**: `POST /clothing/refit` (own-door,
  202, runs behind like `/clothing/regenerate`). It consults the shared log first, calls the model only for
  a garment nobody has described, stamps `fitAt` / `fitTriedAt`, and publishes each real answer as a shared
  tag line. The other device adopts the lines on its next sync and never runs the pass by itself — **nothing
  triggers refit automatically.** That is the whole of the 9/21 hole, closed by procedure for this one pass.

Until refit reaches a garment, the deal uses a **legacy fallback** from the warmth word it already has:
top `hot → sleeveless`, `warm → short`, `cool|cold → long` (weight `light`); pants `long light`; shorts
`short`; dress/set by warmth as a top, `legs: bare` unless `cold`. Measured on her 63 on 9/29 this is right
for 59 of them (the two misses that matter: a cardigan and a crop shirt tagged `warm`). The board is coherent
from the first boot; refit only sharpens it.

**D2 — the acceptance test is the coherence harness, not the table.** Dad tunes nothing; the code owns
the table (9/23). So the table, the edge and the fit weight are free to move — what is fixed is what the
board may deal at each temperature, in dad's words. `tests/clothing-fit.test.mjs` sweeps a fixture with the
exact shape of her wardrobe (`tests/fixtures/wardrobe-shape.json`, generic names) across 40–100 °F and asserts:

| planTemp | must hold over the whole deal (all pages) |
|---|---|
| any | at least one full page of looks; **no fancy garment, ever** |
| ≥ 86 | no long-sleeve top; no long bottom |
| ≥ 78 | **no long-sleeve top**; long bottoms ≤ 1 on page 1 and ≤ 3 in the deal (a staple or the coverage slot may carry one) |
| 72–77 | no `mid`/`heavy` long sleeve; shorts and pants both present |
| 62–71 | no sleeveless top on page 1; no `heavy` |
| < 62 | no shorts, no bare-legged single, no sleeveless top |
| < 54 | no short-sleeve top on page 1 (long sleeves lead); `mid`/`heavy` before `light` |

Same fixture with `coverage`/`weight`/`legs` stripped (a catalogue refit has not reached) must hold the
weaker legacy set: never empty, no `cool`/`cold`-tagged top at ≥ 78, no `hot`-tagged garment below 54,
no fancy.

Two model rules follow from the receipt and make the thresholds reachable:

- **The edge is one-sided.** 9/23 §3 admitted a garment within 8 °F *outside* its range on either side.
  Below its range a garment is merely too light — "nothing a jacket cannot fix" — so the edge stays on the
  cold side. **Above its range a garment is too warm, and that is the error she cannot undo**; there is no
  edge on the warm side. A long-sleeve light top `55 → 75` is out at 76, full stop.
- **Fit ranks.** `rankOf` gains `fit = −FIT_PTS_PER_DEG × |t − centre|`, large enough that among admitted
  looks the better-suited ones fill the pages before freshness and jitter decide. An open-ended range's
  centre is its closed end + 10. Start from the 9/23 table and the consensus chart in its §3 (tee + shorts
  72–80, short sleeve + pants 60–66, long sleeve + pants 50–60) and move rows until the harness is green;
  write the final table and why each row moved into the code comment.

A CLI shares the harness's engine so the same sweep runs against a **real** catalogue before a push:
`node tools/clothing-simulate.mjs --wardrobe <path/to/wardrobe.json> [--temps 45,58,65,72,79,85,95]
[--seed YYYY-MM-DD] [--strip-fit]` prints, per temperature, the admitted counts per role, the dealt looks
with their sleeve/leg words, and each threshold's verdict. Copy the device's `wardrobe.json` down over ssh
and run it — that is the deploy check dad asked for.

**D3 — fancy lives on the Dress up page and nowhere else.** `occasion === "fancy"` is dropped at
`buildCandidates`' door beside `hidden`, and left out of every `cat_*` browse grid. A virtual kind
**Dress up** joins the accessories menu (`acc`) when at least one un-hidden fancy item with a tile exists —
in `present` like the real kinds, so the door, the seventh-slot arithmetic and the menu cells follow it
with no new rule. Its page `acc_fancy` is `gridPages` over every fancy item, garment or accessory, tiles of
`type: "clothing"` exactly like a browse page (a fancy accessory stays on its own kind page too — it was
never dealt anyway). ARASAAC symbol: a bestsearch hit for "party" or "dress up", else "dress"; check it
the way the 9/17 spec checked "accessories" (25634).

**D4 — the override.** The hold sheet (`era-board/app/board-edit.js`) gains a **Sleeves** row
(Sleeveless · Short · Long) on tops, dresses and sets and a **Weight** row (Light · Medium · Heavy) shown
only when the piece is a long-sleeve top or a jacket. Dresses and sets also get **Legs** (Bare · Covered).
The hub side: `POST /clothing/item` accepts `coverage`, `weight`, `legs` through their own lists with
one-sentence refusals; `manualFields` (`clothing-worker.js:982`) admits them — the 9/23 §7 bug — and
`clothing-log.js normalizeTag` carries them so the other device honours the edit.

**D5 — out of this cut,** on the record so nobody widens it: §5 of 9/23 (the jacket prompt and heat
advisory — `feat/jackets` is open), unit A phases 2–5 (the typed town; the tablet still reads `place: "ip"`,
the ~4 °F cold bias stands and is a separate fix), unit C (ownership for new photos), and `lowTemp`.

## 3. Data shape (delta)

Catalogue entry, shared tag line and manual line all gain, optional:

| field | values | who writes |
|---|---|---|
| `coverage` | top: `sleeveless\|short\|long` · pants/shorts: `short\|long` · dress/set: as a top | model at ingest / refit; parent |
| `weight` | `light\|mid\|heavy\|unsure` — asked only for long-sleeve tops and jackets; `unsure` → the category's modal weight, biased light (9/23 §2) | model; parent (never `unsure`) |
| `legs` | dress/set only: `bare\|covered` | model; parent |
| `fitAt`, `fitTriedAt` | day keys, refit's markers, same semantics as `attrsAt`/`attrsTriedAt` | worker |

`warmth` stays in the file and in the ingest prompt (the tile's band, `accessoryOrder` and the offer log
still read it); the deal no longer does. `band` keeps flowing to the tile and `appendOffer`; `buildCandidates`
takes `temp` (the planning °F, `w.t`) and treats `temp == null` as the weather being offline — gates nothing,
like `band null` today.

## 4. Testing

- `tests/clothing-fit.test.mjs` (new): the §2 sweep over the fixture, both modes; the table is total; the
  one-sided edge; `unsure` → modal weight; `fit` moves the rank; fancy never dealt; never empty.
- `tests/clothing-rank.test.mjs`: `eligible` by temp; the door drops fancy; legacy fallback mapping.
- `tests/clothing-weather.test.mjs:291, :306`: the two "tops never gated" tests become the opposite
  assertion — a deliberate break from the `outfit_set.py` port (dad 9/23, 9/29); the port note at the head
  of `clothing-rank.js` says so.
- `tests/clothing-accessories.test.mjs` (+): Dress up present only with a fancy item; the page lists them;
  no `cat_*` grid does; the ingest prompt asks for coverage/weight/legs; a shared line carries them.
- `tests/clothing-item.test.mjs` (+): coverage/weight/legs accepted and refused; a manual weight edit
  reaches the catalogue (fails before D4).
- Refit: a garment with `fitAt` is never asked; one described in the shared log is adopted without a call;
  the pass stops after two misses; a device that never posts `/clothing/refit` never spends.
- era-board: the sheet's new rows, shown for the right kinds only, post the right body.
- Ports for any new server suite: 8452 / 8453 (surveyed free across all five repos 9/29).
