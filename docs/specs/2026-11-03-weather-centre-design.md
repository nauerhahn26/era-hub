# Clothing Picker — the weather in the middle (design)

Dad, 11/3: "can you also put the weather in the middle box when she is picking
out a t-shirt or any other item? nice to always see the weather in the middle."

## 1. What exists

- The today pages (`today`, `today_2`, `today_3`) carry the weather tile across
  the two centre cells `[2,2][2,3]` (`col_span: 2`, `type: "control"`, no `load`):
  it speaks the forecast on dwell and stays on the page. Its label is
  `52° → 67°  cool` (or `70°  warm` on a flat day), its say names the morning,
  the high and the band, its footnote the place, the window and when the
  forecast was fetched (`clothing-worker.js`, the today loop in `buildCataloged`).
  With no forecast the pair is black and the page is as it always was.
- Every other 3×4 page of the picker keeps the pair black: Full wardrobe
  (`build`), the Accessories menu (`acc`), every browse page (`cat_top`,
  `cat_pants`, `cat_shorts`, `cat_dress`, `cat_outfit` and their `_N` pages) and
  every accessory page (`acc_<kind>`, Dress up included). `gridPages` never
  places anything at the centre; `tests/clothing-accessories.test.mjs` pins the
  black centre on each of them.
- "Pants or shorts?" (`choose_bottom`) is a 2×2 board with no centre pair.
- The law (memory `board-design-rules-are-law`, dad 9/3, 9/17, 9/22): centre
  cells black on every board. The today page's weather tile has stood in that
  pair since the 9/1 port with dad's approval ("speaking weather", approved
  layout test), so the pair holding the weather is not new; it is only on
  three of the picker's pages.

## 2. Decision

The same weather tile, in the same two cells, on **every 3×4 page of the
Clothing Picker** whenever there is a forecast:

| page | today | after |
| --- | --- | --- |
| `today`, `today_N` | weather tile | unchanged |
| `build` (Full wardrobe) | black | weather tile |
| `acc` (Accessories menu) | black | weather tile |
| `cat_*` and `cat_*_N` (Tops, Pants, Shorts, Dresses, Outfits) | black | weather tile |
| `acc_<kind>` and `_N` (jackets … and Dress up) | black | weather tile |
| `choose_bottom` (2×2) | no centre | unchanged |

- **One tile, one behaviour.** A single `weatherTile(w)` factory builds the
  object the today loop builds now (label, say, symbol, footnote, `row: 2,
  col: 2, col_span: 2`, no `load`, no `combo`), and every page above pushes
  the same object. Dwell on it speaks the forecast and stays on the page,
  exactly as on today. Nothing about the tile's words changes.
- **No forecast, no tile.** `w` null (offline, stale-and-missing week) leaves
  the pair black on every page, so an offline board is byte for byte the board
  it was. Nothing else on any page moves: Back, More, the Full wardrobe door
  and every garment keep their cells.
- **Targets per page.** A browse page goes from 10 (8 garments or 7 + the
  door, Back, More) to 11, under the contract's comfortable 12. Full wardrobe
  and the menu are far under.
- **The law, amended 11/3.** The black centre stays the rule for every board.
  In the Clothing Picker the centre pair holds the weather tile when there is
  a forecast, on every page, because dad wants the weather always in view
  while she chooses. No other app's board changes.

## 3. Non-goals

- No change to the deal, the browse order, the planning °F or the tile's text.
- No era-board change: the renderer already draws this control spanning
  `[2,2][2,3]` on the today pages (`board-render.js` hero/`col_span`).
- No tile on "Pants or shorts?" (no centre to put it in) and no new Settings.

## 4. Testing

- `tests/clothing-accessories.test.mjs`: every case that builds **under a
  sky** and asserts `at(page, 2, 2) === undefined` is re-pinned to the weather
  tile (same `say` as the today page's, `col_span` 2, no `load`), with a
  one-line reason each; cases that build with no sky keep asserting black.
  New: one walk over every 3×4 board in the recipe asserting the tile is at
  `[2,2]` with span 2 and that no cells overlap; the no-sky walk asserting
  `[2,2]` and `[2,3]` are empty on every board; Dress up and a `_2` page
  included.
- `tests/clothing-weather.test.mjs`: the browse-grid cases' `gridIds` keep
  reading garments only (the tile has no `items`), so they hold unchanged;
  confirm, do not loosen.
- Scratch hub on a free 8380-8389 port with the fake forecast used on 11/2:
  one screenshot of a Tops page and one of Full wardrobe showing the tile, into
  the scratchpad (not the repo). Kill only the recorded pids.
- Full gate detached, `gate-wait.sh`, green stamp; land on dad's word.
