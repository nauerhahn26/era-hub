# The warmth model — dress her for the day, not for a word (design)

**Date:** 2026-09-23 · **Branch:** `fix/weather` (era-hub + era-board) · **Unit B of three**
**Origin:** dad, 9/23, describing the ladder he actually dresses her by:

> *"there's extreme cold, like you need a big jacket type of thing and thick pants.
> There's, like, regular cold where you might want thicker pants and a long-sleeve
> shirt … pants and a long sleeve. Pants don't need to be very thick. Or you could do
> pants and a short sleeve on that day with, like, a jacket … to thin pants and a
> T-shirt, to a T-shirt and shorts, to a tank top and shorts."*

And the thing the current model cannot see:

> *"some of her pants are thin and some are thicker. Some of her long sleeves are thick
> and some are thinner. In an ideal world, you would capture that somehow."*

Decisions taken with dad, 9/23: **all clothing gated by the weather, including tops**;
**AI takes the first pass at weight** with a human override; **no temperature table for
him to tune** — *"more just if you would change the weights or whatever."*

**Sequencing:** unit A (location) ships first and alone. **Unit C must land before or
with this unit's re-describe pass** — §6 spends one vision call per garment, and
without C both devices spend it and diverge, which is the 9/21 incident all over again.

## 1. Why the current model cannot work

`clothing-rank.js` gates on one word per garment, `warmth ∈ {hot, warm, cool, cold, any}`,
mapped to three levels (`WORD_LEVELS`, `:75`) and admitted per band by `BAND_WARMTH`
(`:69`). Measured against her real 57 garments on 9/23:

| Day | Tops admitted | Bottoms | Dresses + sets |
|---|---|---|---|
| hot | 27 / 27 | 15 / 17 | 7 / 7 |
| warm | 27 / 27 | **17 / 17** | 7 / 7 |
| cool | 27 / 27 | **2 / 17** | 7 / 7 |
| cold | 27 / 27 | 2 / 17 | 7 / 7 |

Four separate failures, all visible in that table:

1. **Tops are never gated** (`eligible`, `:377`) — a sweatshirt is offered at 85 °F.
2. **On a warm day the gate admits everything** — it is a no-op on her commonest day.
3. **On a cool day she has two bottoms**, so pages fill with dresses, including
   summer ones, because the widening floor (`:380-384`) opens all seven singles.
4. **Cold and cool are identical boards** — after jackets are set aside there is not
   one cold-tagged garment in the wardrobe.

Underneath all four: 41 of her 51 garments are tagged `hot` or `warm`, and those two
words collapse to the *same* level. All 8 pairs of shorts are `hot`; nothing is `cold`.
The vocabulary has no resolution, and one word per garment never could.

Also: the band contributes **nothing** to `rankOf` (`:393`). Weather is a door, never a
preference — among admitted garments the more suitable one gets no lift at all.

## 2. Two attributes instead of one word

A garment's warmth is a product of how much it covers and how thick it is. Both are
asked of the model at ingest; both are correctable by a parent.

**`coverage`** — geometry, which vision reads well.

| category | values |
|---|---|
| top | `sleeveless` · `short` · `long` |
| pants, shorts | `short` · `long` |
| dress, set | `sleeveless` · `short` · `long` (of the top half) plus `legs: bare` \| `covered` |

**`weight`** — `light` · `mid` · `heavy`. Asked **only for long-sleeve tops and the
outer-layer kinds** (jacket). Everything else takes its category's modal weight and is
never asked. This is not laziness, it is the measured truth: across 62-88 °F her whole
wardrobe spans roughly 0.2-0.8 clo, and a light vs heavy t-shirt is 0.08 vs 0.12 clo —
about **0.5 °F**, beneath the noise floor of the forecast itself. Weight only earns a
question on the rung that fires on cold mornings.

### What the model can honestly be asked

Research verdict, 9/23: judging fabric weight from a flat-lay is **unreliable**, not
borderline. Frontier models score 34-47 % F1 on fabric *type* (a coarser label than
weight), weight appears in no benchmark at all, and a flat-lay is the worst possible
input because it removes drape and motion — which is exactly where the weight signal
lives. Where GSM prediction does work it is from handheld microscopy, not a photograph.

So the design assumes the model is **wrong a meaningful fraction of the time on weight**
and is built to survive that:

- Ask for weight on ~14 garments, not 57, so the blast radius is small.
- `temperature: 0` on the call (a measured +6-7 pp).
- Offer `unsure` as an explicit first-class option — models are specifically bad at
  volunteering it (NA-detection F1 ≈ 34 %) and their verbalised confidence is
  overconfident (ECE > 0.25). **Never route on self-reported confidence.**
- **`unsure` does not mean `mid`.** It falls back to the category's modal weight, and
  where there is doubt it biases **light**: over-dressing at 88 °F is the worse error
  in this climate, and under-dressing at 62 °F costs nothing a jacket cannot fix.
- The cues that carry real signal, for the prompt: visible quilting or baffles
  (near-definitive for heavy), loft at the cuff or hem, pile or nap texture, rib gauge,
  opacity (good for confirming light, useless mid-vs-heavy). Sheen is fibre, not weight.
  A closed flat-lay usually hides lining — a known blind spot, and a reason the override
  matters.

Coverage carries no such warning: sleeve length is shape, not texture.

## 3. From attributes to a comfort range

Each garment gets a range in °F, derived from `(category, coverage, weight)` by a table
**inside the code** — dad tunes garments, never the table.

| role | coverage / weight | range °F |
|---|---|---|
| top | sleeveless | 78 → ∞ |
| top | short, light | 66 → ∞ |
| top | short, mid | 62 → 88 |
| top | long, light | 55 → 75 |
| top | long, mid | 48 → 68 |
| top | long, heavy | −∞ → 58 |
| bottom | short (shorts) | 72 → ∞ |
| bottom | long, light | 58 → 85 |
| bottom | long, mid | 48 → 72 |
| bottom | long, heavy | −∞ → 60 |
| single | by its top half, `legs: bare` = shorts, `covered` = long | as above |

These boundaries are the published consensus, not invention. Across daycare, scouting,
pediatric and outdoor-retailer charts: tank ≥ 80 (±2), tee + shorts 72-80 (**±7 — the
loosest boundary in the set**), short sleeve + pants 60-66 (±2), long sleeve + pants
50-60 (±2), jacket + warm pants 40-50 (±3, the most agreed-upon of all). The 66-72 rung
is interpolated — every chart treats 60-70 as one band — and is flagged as the one to
tune from real feedback.

### Soft edges, because the sources disagree

A ±7 °F spread in the published boundaries must not become a hard line in the code. So:

- **inside the range** — admitted, and ranked by distance from the range's centre;
- **within `EDGE = 8 °F` outside** — admitted, ranked below everything inside;
- **beyond that** — excluded.

Eight is chosen as the largest published disagreement, so the gate is never more
confident than the evidence. This is also what finally makes weather a *preference*:
`rankOf` gains a `fit` term (negative points for distance from centre) so that among
admitted garments the better-suited one leads, instead of freshness deciding alone.

The existing "never empty the board" floor stays, unchanged in spirit: if the gate
leaves fewer than a page, widen the edge before dropping the rule, and deal the
whole category before dealing nothing.

## 4. The planning temperature — dad's rule stands

`planTemp` = the window's **maximum**, as today. `lowTemp` = the window's **minimum**,
which is new and drives §5 only. Dad, 9/23:

> *"if the day is going to go from 55 to 72 during the main hours, we actually plan for
> 72. It's useful to know it's 55 … you might want a jacket when you leave the house,
> but you're going to get rid of it."*

**The research recommends the opposite** — dress for the coldest moment and remove a
layer later. That recommendation is rejected here, deliberately, for two reasons:

1. **She cannot self-regulate.** She has Rett syndrome and communicates by eye gaze;
   she cannot take off her own jacket. A layer she does not need is a layer that stays
   on her until an adult notices. Dressing for the low means being over-dressed through
   the warm half of every wide-spread day.
2. **The research contradicts itself here**, and its other half agrees with dad: it
   says plainly that in this climate "over-dressing at 88 °F is worse than
   under-dressing at 62 °F, where nothing bad happens. Bias light." Dressing for the
   high *is* biasing light.

Recorded so a later reader does not "fix" this back.

## 5. The layer, and the two advisories

With `lowTemp` in hand the board can finally say something useful about a morning.

**The jacket prompt.** When `lowTemp` is below 62 °F *and* the spread is at least
10 °F, the Yes button gains `load` to a new `layer_<i>` board and `say_on_load`:
*"Yes! It is a cool morning — take a jacket."* The board holds her jacket tiles in
`accessoryOrder`, plus Back and Done.

This costs **no era-board change**: `board-model.js:87-97 activate()` navigates on any
button carrying `load` and speaks when `say_on_load` is set, and `board-render.js:718`
already posts the pick *before* `activate()` runs. Yes stays a plain leaf on days that
do not warrant a layer, or when the wardrobe holds no jacket.

**The heat advisory.** The one safety rule that survives in this climate: at a heat
index ≥ 90 °F outdoor play is not recommended (child-care guidance; one district uses
≤ 90 outdoors, 91-94 discretion, > 95 indoors). At 88 °F highs this is live. The
weather tile gains a line, not a gate — it never changes what she is offered.

**Not built:** an activity flag. The research withdrew its own claim that this was the
most load-bearing input once the sub-freezing math was removed; at 62-88 °F the effect
collapses to the same direction the spread already points. One rule, not two.

**Deliberately dropped**, all unreachable at these temperatures: IREQ / ISO 11079
(applicability ends at 50 °F), the US Army required-clo chart (axis ends at 32 °F),
military ensemble values, wet-halves-insulation (cold-wet hypothermia physics), wind
chill (the NWS formula is undefined above 50 °F), snow pants, frostbite windows, and
every institutional cold cutoff. A plain "is it raining" boolean is kept for the jacket
line; the insulation math is not.

Sun ≈ +10 °F is real and larger than most garment differences here, but it needs a
cloud-cover read the tile does not take yet. Noted, not built.

## 6. Migration — one pass, once

`attrsAt` is a one-way door and must not be reused. A new marker `fitAt` drives a pass
with the same shape as the 9/5 needs-attributes pass (`clothing-worker.js:593-757`):
one call per garment from the tile already on disk, at most once a garment a day,
consulting the shared log **first** so a family pays once, not once per device.

Roughly 51 garments, one call each, inside the free daily allowance. **This is the
step that requires unit C.** Without ownership, both devices run this pass, spend 102
calls between them, and produce two different wardrobes — precisely what happened on
2026-09-21 at 00:53, where the two devices described the same twelve garments two
minutes apart and disagree about all twelve to this day.

The legacy `warmth` word is kept in the file and ignored by the deal, so a rollback is
a one-line revert rather than a re-ingest.

## 7. The override

The hold-to-edit sheet (`era-board/app/board-edit.js`) gains a **weight** chip row —
Light · Medium · Heavy — on long-sleeve tops and jackets only, beside the existing
category chips. A coverage row is offered too, since a mis-read sleeve is both possible
and cheap to fix.

**This requires widening the manual whitelist**, and that is a real bug on the way:
`manualFields` (`clothing-worker.js:982-988`) admits only `category`, `occasion` and
`hidden`, and `applyManual` skips a line whose fields all fall outside it
(`:1007`) — so a manual correction to `weight` would today be accepted by the route,
written to the shared log, and **silently do nothing on every device**. `coverage` and
`weight` join that list, and `clothing-log.js normalizeTag` (`:268`) carries them.

## 8. Testing

New `tests/clothing-fit.test.mjs`, plus additions to `clothing-rank.test.mjs`:

1. The range table is total — every `(role, coverage, weight)` maps to a range.
2. A garment inside its range is admitted; one 8 °F outside is admitted and ranked
   last; one 20 °F outside is excluded.
3. **Tops are gated now** — this replaces the two "tops never gated" assertions in
   `clothing-weather.test.mjs:268` and `:283`, which become the opposite assertion.
   The old rule is a deliberate break from the `outfit_set.py` port (dad, 9/23:
   "all clothing should be gated by the weather, including tops") and the port note at
   the head of `clothing-rank.js` must say so.
4. Her real wardrobe shape: at 85 °F no long-sleeve heavy top is dealt; at 55 °F no
   tank and no shorts; at 70 °F more than two bottoms are available.
5. `unsure` weight resolves to the category's modal weight, never to `mid` blindly.
6. The board is never emptied: a wardrobe with one garment per role still deals.
7. `fit` moves the rank — two garments equal on freshness order by distance from centre.
8. The Yes button gains `load` only when `lowTemp < 62` and spread ≥ 10 and a jacket
   exists; otherwise it is a leaf exactly as today.
9. A manual `weight` edit reaches the catalogue (fails before §7's whitelist change).
10. A garment carrying `fitAt` is never re-asked; one without it is asked once a day.

## 9. Risks

- **The model gets weight wrong.** Accepted and designed around (§2). The override is
  the answer, and the blast radius is ~14 garments.
- **Her wardrobe is thin at the cold end** — two cold-tagged items, both jackets. Once
  coverage and weight are real this should improve, but a 50 °F morning may still deal
  a short board. The floor covers it; dad may simply need more long sleeves.
- **The 66-72 rung is interpolated.** Flagged in the table; tune from feedback.
- **Two suites change meaning, not just content** (test 3). Called out here so the
  diff is not mistaken for a regression.
