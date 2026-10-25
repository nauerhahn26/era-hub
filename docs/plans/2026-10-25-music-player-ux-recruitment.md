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
- [x] Run the full gate on committed matching worktrees, detached with a sentinel.
- [ ] Land the green branches, build the patch and verify Windows self-update.
- [ ] Deploy the approved release and record live verification and limitations.
- [ ] Refresh pictures for all 27 existing songs through their saved video sources,
  as explicitly requested by the maintainer, and verify audio/order preservation.

Initial evidence: the updated layout regression failed against the former
half-width image. Targeted hub checks passed 39/39 after implementation.
The first browser pass covered all ten pictures, wraparound, offline cycling,
unchanged music position/full-song mode, zero empty song-page cells and the
pointer-only parent review. Additional gaze and shared-control checks follow.
Gaze, lock, arrange and parent-strip checks subsequently passed (39 browser
checks across the focused suites). A sync-race regression first failed, then
passed after frame availability was added to the recipe ETag. Real source
lookup succeeded on the tablet; the build host was bot-blocked. The real
storyboard returned WebP bytes behind a `.jpg` URL, so a synthetic WebP
fixture and an installed Windows decoder/worker smoke were added before release.

Retrospective: the installed payload intentionally has no video decoder.
Using actual video preview frames preserves that installation contract, at the
cost of preview resolution. Pictures are optional enrichment: missing helper,
missing storyboards, failed screening or unavailable networking retain the
song's usable cover/audio rather than turning a music add into a failure.

## Full gate

The committed hub and board worktrees passed the full gate: **129 suites,
0 failed**. The gate stamped both repositories with clean trees. Hub targeted
checks passed 39/39; the board checks include actual gaze rearming, image
wraparound, offline cycling and continued audio/full-song mode.

## Live content review and quality follow-up

v1.0.10 passed Windows self-update 7/7 and was published (build
`20261025.0231`). The published manifest and tarball hash matched the build.
The local push helper refused the docs-only receipt tree, so the tablet used
the normal published-feed updater and reported the new running/disk build.
All 27 sources produced ten pictures, with original audio/order metadata
preserved. Visual review then caught blank end frames and two static album
cover sources that byte hashes had treated as distinct. This prevented closing
the picture task on a technically complete but unhelpful result.

- [x] Add failing regressions for dark/white end frames, perceptual duplicates
  and an alternate picture source that preserves audio.
- [x] Filter blank frames and near-duplicates before helper screening; sample
  more of the video and screen at most forty useful candidates.
- [x] Let a parent supply a music-video link for pictures independently of audio.
- [x] Pass focused hub checks (41/41) and browser checks (18/18).
- [ ] Gate, release and deploy the quality follow-up.
- [ ] Rebuild and visually verify all 27 picture sets with the quality checks;
  use matching music-video sources for the two static album uploads.
