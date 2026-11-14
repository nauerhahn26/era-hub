# Speech Mirror

A separate core Hub app at `/slp-videos/` shows a chosen practice video on the
left and a muted, horizontally mirrored front-camera preview on the right.
Both images are passive, equally sized, letterboxed panels. Four stable large
commands below them provide Previous, Play/Pause, Replay and Next. Finishing a
clip leaves the mirror available; no next clip starts automatically. There are
no scores, speech recognition or requirements to imitate a sound.

The shared Exit and Talk bar keeps its positions and doubled dwell. The four
video commands use the shared dwell engine, move-to-rearm and Settings timing.
Command labels follow the existing player: 44 px minimum, 74 px cap and
responsive sizing between them, with at least 14 px gaps.
The app has an independent app lock. Locking, Talk, leaving and hiding pause the
model, stop the camera and finish any recording. Returning may restore a camera
that the partner had enabled, but never automatically resumes recording or the
model video. Permission results arriving after suspension release their tracks.

Touch-only Partner controls select/start/stop a camera, import videos, choose
a local synced folder, refresh the library and start/stop a recording. The
camera preview never requests a microphone; recording explicitly requests one.
Recordings use the camera plus microphone, with echo cancellation requested,
and are capped at five minutes or 128 MiB. The visible recording indicator is
continuous. Saving must complete before a deliberate Exit or Talk handoff.
Unexpected browser closure during a save can interrupt it; only a server
acknowledgement means Saved. The display mirror does not reverse stored video.

## Content and account boundary

The app never authenticates to Google. Drive for desktop, signed into the
family account, synchronizes a folder shared by its owner. Sharing alone does
not guarantee that each computer downloads a folder: select it on each device
and mark it available offline. A configured absolute local folder is read-only.
Alternatively, the app discovers `slp-videos` immediately under the Hub's
existing local Drive content root. No existing Drive OAuth scope is expanded.
A folder share into an existing signed-in account does not itself restrict the
existing desktop sync client's account privileges.

Local imports live in `<DATA>/slp-videos/library`; configured-folder clips and
local imports appear together. Only immediate, regular MP4, WebM, MOV and M4V
files are exposed; symlinks and subdirectories are ignored. Library refreshes
are explicit and every 30 seconds while visible, paused and not recording.
New media is not allowed to switch a playing clip. MP4 with H.264/AAC is the
recommended portable format; HEVC phone originals may need conversion before
use. The Hub does not ship a new transcoder. Actual private source media and
folder identifiers stay outside source control and release payloads.

Recordings live exclusively in `<DATA>/slp-videos/recordings`, never under the
Drive root. Uploads stream to private temporary files, reject empty/oversized
bodies and atomically rename only completed files. Partial files are removed
on failures and never listed. Recordings are available through explicit local
download links. An interrupted process can leave a hidden partial file, which
is excluded from the library. No automatic upload or deletion is introduced.
All media/configuration/recording APIs require a loopback peer, a local Host
and a same-origin request. Media uses the existing streamed Range/HEAD jail,
opaque library IDs and no-store caching. Paths and filenames remain device data.

## Delivery

The Hub contains the app, storage API, icon and payload wiring. The matching
Core worktree adds the lock identity. Feature selection uses
`ERA_WT_SUFFIX=--wt-slp-videos`. Existing explicit enabled-app sets retain their
choices; enable Speech Mirror in Settings when absent. Windows front-camera,
microphone and gaze coexistence require on-device acceptance. Browser tests
use synthetic camera media, never private therapy clips. Publication and device
installation require a separate maintainer instruction.
