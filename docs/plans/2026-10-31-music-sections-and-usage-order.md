# Music sections and usage order plan

Design: [music section rail and play-count order](../specs/2026-10-31-music-sections-and-usage-order.md).
Branch in era-hub and era-board: `fix/music-layout-fixes`.
Maintainer authorized build and publish on 2026-10-31.

- [x] Orient, check sibling overlap, agree the design in chat.
- [ ] Open the matching era-board worktree.
- [ ] Hub, test first: shared play log (music-log.js), scoring, addedAt,
  category field, add-time classification, POST /music/category, sectioned
  recipe with rail, recipe revision bump.
- [ ] Board, test first: rail rendering and section/page navigation, song page
  Back to the originating section page, order stable during a visit, Arrange
  removed from songs, parent category control.
- [ ] Focused suites green; browser geometry at 1920 x 1080 and 1280 x 720.
- [ ] Full gate on committed matching worktrees, detached with a sentinel.
- [ ] Land era-board then era-hub; patch release; Windows self-update leg.
- [ ] Publish; update devices; set the initial categories; verify live.
