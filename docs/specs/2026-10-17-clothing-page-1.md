# Clothing page 1

Dad approved the layout preview on 2026-10-17, with the existing board style.

- Remove Accessories from suggested outfits, confirmation pages and garment
  browsing. Accessories lives inside Full wardrobe, through one menu entry.
- Rename Build my own to Full wardrobe and use a cupboard pictogram. Keep
  this door bottom-right on every suggested-outfit and garment/accessory
  browse page. Confirmation pages use their available bottom-right cell.
- First page: eight outfit slots, including top-left. More stays bottom-left.
  Subsequent pages keep Back top-left and offer seven outfits each. At most
  three pages: 8 + 7 + 7 = 22, subject to the wardrobe's available combinations.
- Forecast spans row 2, columns 2–3 on suggested-outfit pages. Sage background,
  dark ink, existing weather symbol, label and freshness footnote. Standard
  dwell speaks the forecast; it never chooses an outfit or navigates. She can
  leave the tile and look again to repeat it. No forecast leaves the center
  black; the outfit slots stay the same.
- Browse pages and Full wardrobe retain their black center cells, existing
  colors, sizing, gaps, labels and dwell behavior. No layout change elsewhere.
- Ranking knows the different first/deeper page capacities. Recorded page 1
  contains eight combinations when available; yesterday's looks start after
  those eight. A small wardrobe first uses distinct garments, then fills the
  extra choice with another pairing when necessary, preferring a repeated
  garment over yesterday's combination. The simulator uses the same capacities.
- An existing recipe named Build my own triggers a re-sort on the first tick
  after upgrading, without ingesting its photos again.

Implementation spans era-hub and era-board, both on `feat/clothing-page-1`.
Use `ERA_WT_SUFFIX=--wt-clothing-page-1` for assembly, gate and payloads.
The separate clothing-diversity, clothing-picker-ui, jackets,
long-press-clothing and weather worktrees overlap these files or behavior;
review their changes when integrating. No sibling branch was changed here.

## Validation and release

Released as [v1.0.3](https://github.com/nauerhahn26/new-era-releases/releases/tag/v1.0.3),
build `20261017.0310`. Hub implementation landed as ad26148; board as ecb106e.

- Browser checks pass at 1920×1080 and 1280×800, including two separate gaze
  dwells speaking the forecast without recording an outfit choice.
- Full gate on the final committed hub and board trees: 122 suites passed,
  zero failed. The weather-location selectors cover the spanning center tile.
- Clean Windows self-update leg B on the exact release archive: five passed,
  zero failed. The inherited signed v1.0.0 installer signature was verified.
- Public latest feed, six assets, downloaded archive checksum and included
  clothing code, board renderer and wardrobe icon were verified. Temporary
  QA host destroyed; permanent template unchanged.

See [release receipt](../plans/2026-10-17-clothing-page-1-release.md) for the
archive hash and delivery state. Devices use normal automatic updates;
publication does not establish installation on a particular device.
