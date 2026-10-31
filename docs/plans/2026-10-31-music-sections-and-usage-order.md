# Music sections and usage order plan

Design: [music section rail and play-count order](../specs/2026-10-31-music-sections-and-usage-order.md).
Branch in era-hub and era-board: `fix/music-layout-fixes`.
Maintainer authorized build and publish on 2026-10-31.

- [x] Orient, check sibling overlap, agree the design in chat.
- [x] Open the matching era-board worktree.
- [x] Hub, test first: shared play log (music-log.js), scoring, addedAt,
  category field, add-time classification, POST /music/category, sectioned
  recipe with rail, recipe revision bump.
- [x] Board, test first: rail rendering and section/page navigation, song page
  Back to the originating section page, order stable during a visit, Arrange
  removed from songs, parent category control.
- [x] Focused suites green; browser geometry at 1920 x 1080 and 1280 x 720.
- [x] Full gate on committed matching worktrees, detached with a sentinel.
- [ ] Land era-board then era-hub; patch release; Windows self-update leg.
- [ ] Publish; update devices; set the initial categories; verify live.

## Retrospective (build, 2026-10-31)

- Hub: `music-log.js` (pick fold + shared log under `music/.era/plays/<device>/`,
  the family pool as the local canonical, a one-time `legacy.jsonl` backfill of
  this device's pool history), `music-sections.js` (section order), the
  sectioned recipe (`rail` per grid page, `return:true` song-page Back,
  RECIPE_REV 6), `/music-event` `clip`/`done`/`fresh`, `addedAt`, add-time
  classification (one helper rung, failure = none), `POST /music/category`.
  `/music/order` and `order()` are retired with Arrange.
- Board: the rail in `board-render.js`, the player's `clip`/`done`/`fresh`
  events, the watcher ignoring the ETag's `~o` order part and never reloading
  under a playing song, the section choice in the song sheet,
  `board-arrange.js` and its suite removed (movies keep their Arrange door).
- Decided while building: Music opens on Favorites, or All while nothing has
  been played. The rail is one grid column wide and widens only when a word
  will not fit at the contract's 44px minimum (1280 x 720: "Favorites").
  "Favorites" is marked fit-impossible at 62px on 1920 x 1080; every other
  rail label holds 74. Old pool `end` events score as partial (they cannot be
  told apart); old `play` then `full` before the next pick is full. Full song
  after the clip ran out upgrades that pick rather than starting a new one.
- The gate fixture has no `addedAt`, so its songs order by rank, newest
  (highest) first; suites that assumed `test-song-1` first now read the first
  song off the page.
- Review change: a song with no `addedAt` first fell back to its audio mtime,
  which is the mirror's copy time and differs per device. Now it counts as
  older than every dated song, higher `rank` newer among undated songs, in New
  and in the score tie-break alike (music-sections.js), so every device orders
  the existing library the same way.
- Gate: 207 passed, 0 failed (run 2026-10-31T18-28-56Z-0863608), rerun after the review change.
