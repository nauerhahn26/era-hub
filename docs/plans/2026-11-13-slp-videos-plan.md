# Speech Mirror implementation

Design: [Speech Mirror](../specs/2026-11-13-slp-videos-design.md).
The maintainer authorized building the separate app, local recordings and
folder-based video access. The maintainer subsequently authorized release.

Worktrees: Hub and Core `--wt-slp-videos`, branch `feat/slp-videos` in each.
The existing `youtube-videos` and `video-generation` siblings overlap in media
concepts; their Watch/player and content pipelines are left with their owners.
Changes to the shared Hub registry, server and payload may need reconciliation.

- [x] Locate the shared source and prepare portable practice copies privately.
- [x] Write storage/security and browser journey tests before implementation;
      establish red failures for missing implementation.
- [x] Add the local library, synced-folder reader and device-only recording API.
- [x] Add the split view, shared doors, dwell commands, camera controls and
      explicit recording; exercise a real browser MediaRecorder with fake media.
- [x] Add the separate registry entry, original icon and payload inclusion.
- [x] Add the Core lock identity in a matching worktree; verify the main Core
      checkout is unchanged after correcting an assembled symlink edit.
- [x] Complete interruption, access and browser layout acceptance.
- [x] Run the full detached integration gate and record its verdict.
- [x] Record manual preview and remaining device acceptance limitations.

Sharing a Drive folder with the family account is the selected simpler path.
No separate service account, credentials or broad app authorization is needed.
The owner still needs to share the source into that account; desktop sync and
an available-offline folder must be set up separately on each target device.
No external folder permissions have been changed by this feature session.


## Validation and handoff

The final product commit is `f2851b4` in Hub and `ef50669` in Core. The full
integration gate ran all 210 suites fresh: **210 passed, 0 failed**, receipt
`2026-11-14T20-49-09Z-529dad1`. This includes six browser journeys plus the
storage/request-boundary suite, the expanded Core lock routes, Settings lock
coverage and the existing app, icon and packaging contracts.

The scanner-approved standalone payload was exercised with the prepared private
practice clip, a synthetic camera and an actual browser recording saved through
the real local API. HEAD and Range playback worked for the practice files and
recorded WebM. The final payload's app and Core lock files were compared byte
for byte with the committed sources; runtime data is absent from the payload.
Manual views at 1280×720, 1280×800 and 1920×1080 showed equal panels, unclipped
commands, 14 px gaps and 49.4/74 px command labels. Screenshots and source media
remain private, outside both repositories. Temporary manual hubs were stopped.

The payload fixture formerly started copying at the server entrypoint and
skipped a new module copied earlier. It now validates the entire core module
copy block, including the entrypoint and Speech Mirror, with derived scheduler
metadata refreshed. The actual assembled payload already contained that module.
Access review also pinned the shared text floor, preserved the visible Lock
control, and removed a recording-save guard that could delay communication.
Talk is immediate; Exit retains the shared 1200 ms bound. A partner should stop
and save before closing when a recording matters.

The selected setup uses the existing family Google account: the source owner
shares the folder, a shortcut is added to My Drive, and each device makes that
folder available offline. No source-folder permissions were changed here.
New phone MOV clips may need the same portable MP4 preparation as the initial
clips. The app reads local files and holds no new Google credentials.

Remaining acceptance is on the actual device: front camera, microphone/browser
permissions, captured sound and coexistence with gaze. No Windows installer VM
run, device installation, merge or public release was performed or authorized.


## Release authorization

The maintainer requested publication on 2026-11-15. Target is v1.1.4, a patch
following published v1.1.3 and retaining the signed v1.1.0 installer. Refresh
Hub/Core stamps, land in dependency order, then run the canonical patch build,
Windows leg B and publication. The host's live Hub is not restarted by tools.
The source folder share and physical camera/gaze acceptance remain separate
setup steps; private practice media and recordings are not release assets.
