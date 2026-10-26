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
- [x] Land the green branches, build the patch and verify Windows self-update.
- [x] Deploy the approved release and record live verification and limitations.
- [x] Refresh pictures for all 27 existing songs through their saved video sources,
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
- [x] Gate, release and deploy the quality follow-up.
- [x] Rebuild and visually verify all 27 picture sets with the quality checks;
  use matching music-video sources for the two static album uploads.

## Completion receipt

v1.0.11 is published and installed on the tablet, build `20261025.0332`.
The running and on-disk versions both report that build. The second full gate
passed **129 suites, 0 failed** on committed matching trees; Windows self-update
passed **7/7**, including the installed picture worker and WebP decoder. The
temporary Windows QA host was destroyed after verification. The published
manifest and tarball matched the built artifact, SHA-256
`654cffbabaea2abaed10bdcff9ca672c1011338683820b7b17f1f8981072a5c4`.
The tablet used the verified tagged release feed because the latest-release
download was still cached at the preceding version.

All 27 existing entries now have ten newly downloaded pictures each. Source
prechecks found forty useful, distinct candidates for every entry. The quality
follow-up regenerated 25 sets; two uncertain helper results retained the sets
downloaded earlier in this task after direct visual review. Those retained
sets show ordinary animated film scenes and computer hardware, respectively.
The two static album uploads now use matching music-video picture sources,
independently of their original audio sources.

All 270 installed files were fetched and decoded for verification: zero blank
frames and zero near-duplicate pairs under the implemented quality checks.
All nine contact sheets received a final visual review. Every installed song
recipe exposes its complete ten-picture set. Original audio, source, titles,
covers and ordering metadata match the baseline library.

Reopening Music loads the updated player and starts its normal picture cache.
Pictures use video preview resolution and can look soft at full size. The song
page fills the first three columns with the image and the final column with
Back, Stop and Full song. A completed gaze selection advances one picture
without restarting the song; remaining on the image does not repeatedly fire.

## Content-only resolution follow-up

The maintainer found the 320 × 180 preview pictures too soft on the expanded
song page and requested a modest step up. This follow-up extracts actual
640 × 360 frames from the existing source videos on the maintenance machine;
it does not upscale the previews or add a decoder to the installed player.
Frames are matched to the previously reviewed moments, then visually reviewed
again, with empty transitions and end cards replaced where needed.

- [x] Download all 27 picture-source videos without changing the song audio.
- [x] Prepare and review ten sharper pictures for every existing entry.
- [x] Publish immutable picture files before atomically updating the shared manifest.
- [x] Mirror and fetch all 270 installed files; verify dimensions, hashes,
  complete recipes and preservation of every non-picture song field.

This is a shared-content refresh on v1.0.11, not a software release. The normal
on-device Get video pictures action still uses the largest available storyboard
previews; maintaining the sharper library sets requires the full-video
maintenance path until an installed extraction path is designed and verified.

Verified on the tablet after the refresh: 27 complete recipes, 270 served JPEGs,
all **640 × 360**, with matching SHA-256 hashes. The pictures total 9,999,033
bytes (37,033 bytes per picture on average). Pixel checks found zero blanks or
near-duplicates; all nine contact sheets received visual review. Every song
field other than `pictures` matches the original manifest, including its audio,
source, title, cover and rank. The shared-folder mirror copied 271 files (the
pictures plus manifest), with zero errors. Old picture files remain available
for rollback, and a private recovery receipt retains the original manifest,
original picture bytes, replacement files, frame selections and checksums.

The shared mount is accessible to the signed-in account running the hub, not
the maintenance SSH account. A temporary task ran the atomic update in that
existing interactive session, with no application restart or persistent task.
Reopening Music loads the new immutable image names and caches the sharper set.

## Home-device verification and recovery checkpoint

The subsequent home-device check found all 27 sharper sets in its local
manifest and all 270 replacement files present, totaling 9,999,033 bytes.
Its running and on-disk builds both reported `20261025.0332`; its live songs
recipe exposed all 27 replacement sets. An initial HTTP timeout cleared on
retry. The older-looking open player was therefore likely holding its cached
picture list; the maintainer was advised to reload Music with Ctrl+Shift+R.
The browser's actual displayed image was not inspected, so cache remains the
diagnosis supported by those checks rather than a directly observed fact.

The private recovery checkpoint is
`~/backups/music-picture-resolution-20261025/`. Its `receipt.json` records the
completed refresh and verification, `music-sharper-baseline.json` and
`music-sharper-before.json` preserve the prior library and image bytes, and
`pictures/` holds replacements and frame selections. Contact sheets, the
before/after comparison, checksums and maintenance scripts are retained there.
Scripts assume their original scratch paths and must be reviewed before reuse.

The implementation is landed and released. The resolution receipt and this
home-device diagnosis are documentation-only follow-ups committed on
`feat/music-player-ux-recruitment`; they have not been merged into master.
A main merge remains subject to the normal fresh-gate rule. No software
release or image regeneration is needed to preserve the deployed result.
