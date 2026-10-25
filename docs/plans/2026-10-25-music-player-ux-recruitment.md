# Music player UX recruitment plan

Design: [song page pictures and layout](../specs/2026-10-25-music-player-ux-recruitment.md).
Branch in both repositories: `feat/music-player-ux-recruitment`.
Maintainer authorized build and deployment on 2026-10-25.

- [x] Orient read-only, check sibling overlap, and wait for scope approval.
- [x] Create the matching board worktree and write failing layout/pipeline tests.
- [x] Expand the song image to three columns and move controls to column four.
- [x] Add bounded storyboard capture and helper screening in a worker.
- [x] Preserve audio ingestion on picture failure and add existing-song refresh.
- [x] Advance pictures on selection without restarting audio; cache all ten.
- [x] Add a touch-only parent review, refresh and cover-only option.
- [x] Verify synthetic pipeline, recipe, range serving and add/refresh behavior.
- [x] Verify browser geometry, gaze rearm, playback, offline frames and parent controls.
- [ ] Run the full gate on committed matching worktrees, detached with a sentinel.
- [ ] Land the green branches, build the patch and verify Windows self-update.
- [ ] Deploy the approved release and record live verification and limitations.

Initial evidence: the updated layout regression failed against the former
half-width image. Targeted hub checks passed 37/37 after implementation.
The first browser pass covered all ten pictures, wraparound, offline cycling,
unchanged music position/full-song mode, zero empty song-page cells and the
pointer-only parent review. Additional gaze and shared-control checks follow.

Retrospective: the installed payload intentionally has no video decoder.
Using actual video preview frames preserves that installation contract, at the
cost of preview resolution. Pictures are optional enrichment: missing helper,
missing storyboards, failed screening or unavailable networking retain the
song's usable cover/audio rather than turning a music add into a failure.
