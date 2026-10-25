# Song page pictures and layout

The maintainer requested a song image across three quarters of the screen,
Back / Stop / Full song in the far-right column, no black rest cells on the
song page, and ten child-friendly video stills that advance when selected by
gaze. Build and deployment were authorized on 2026-10-25.

The 3 by 4 song grid keeps its existing navigation and paging. On a song page,
the image spans all three rows and the first three columns. Back, Stop and
Full song occupy column four, in that order. The shared door bar stays in
place. Recipe revision 5 invalidates cached older layouts.

While the song is playing, a completed dwell or tap on the image advances one
picture, wrapping after ten. This never changes audio position, volume or
clip/full authorization. Existing Stop/resume and end/replay behavior remains.
The normal dwell rearm rule applies: a stationary gaze changes one picture;
moving the gaze re-arms another selection. There is no slideshow timer.

Song ingestion samples up to forty distinct preview frames across the source
video, using the largest storyboard supplied by the downloader metadata. The
storyboard schema is documented in the [downloader's extractor source](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py).
These are video stills at the source's preview resolution; they may look softer
than full-resolution screenshots. No full video download, new binary or video
decoder is required. JPEG/WebP image decoding, cropping and screening run in a worker.
Real video validation found WebP content behind a `.jpg` address, so decoding
uses file signatures. The small vendored WebP decoder runs in WebAssembly,
with its pinned package provenance and licenses in `vendor/NOTICE-vendor.txt`.
Image downloads are bounded, limited to the image CDN, and reject redirects.

The existing configured AI helper screens a contact sheet for age-appropriate
frames. Only an explicit, unambiguous selection of at least ten distinct
approved frames produces a ten-picture set. Otherwise audio and cover remain
available and the parent sees why pictures were unavailable. Screening is an
automated judgment; the parent can inspect all ten using the touch-only
Pictures panel and choose Use cover only. No new credential or provider is
introduced. Requests use the existing helper configuration and transport.

Images have unique immutable filenames in the shared music folder. Only a
complete local set is included in the child recipe. The ordinary content
mirror carries the files to each device; the board caches all ten in IndexedDB
for offline use. Failed loads retain the displayed image. Generation checks
prevent a late load from replacing a newer selection or a different page.

POST `/music/pictures` with `{id}` refreshes an existing song's pictures using
its saved source, without downloading audio or changing rank. `{id,clear:true}`
returns to cover art without contacting the source. Both operations share the
add/reorder writer lock and report progress through `/music/add/status`.
New songs acquire pictures during the existing add operation. Existing songs
can be prepared from Pictures → Get video pictures.

Work spans matching hub and board worktrees. Other open clothing worktrees
also edit the board renderer, so land through the gate and normal merge flow.
Publishing uses the patch release shape and Windows self-update validation;
the live development hub is never restarted by the agent.
