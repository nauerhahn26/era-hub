# Speech Mirror implementation

Design: [Speech Mirror](../specs/2026-11-13-slp-videos-design.md).
The maintainer authorized building the separate app, local recordings and
folder-based video access. Publication has not been authorized.

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
- [ ] Complete interruption, access and browser layout acceptance.
- [ ] Run the full detached integration gate and record its verdict.
- [ ] Record manual preview and remaining device acceptance limitations.

Sharing a Drive folder with the family account is the selected simpler path.
No separate service account, credentials or broad app authorization is needed.
The owner still needs to share the source into that account; desktop sync and
an available-offline folder must be set up separately on each target device.
No external folder permissions have been changed by this feature session.
