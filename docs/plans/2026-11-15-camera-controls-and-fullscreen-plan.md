# Camera, playback icons and full-screen launch follow-up

Design: [camera, controls and full-screen launch](../specs/2026-11-15-camera-controls-and-fullscreen-design.md).
The maintainer authorized implementation, testing and deployment. Continue in
the Hub `slp-videos` worktree; the existing Core worktree has the same product
content as landed master. No native gaze-engine change is currently needed.

Potential overlap: `screen-issue`, `era-gaze-launcher` and `apps-not-launching`
siblings may touch shared launch behavior. Their worktrees remain untouched.

- [x] Read current implementation and home-device launch logs.
- [x] Establish red browser tests for camera persistence and playback icons.
- [x] Implement local camera setup persistence and stable SVG controls.
- [x] Establish red tests for per-launch settling and owned-job cancellation.
- [x] Notify the shared native settle after every fresh kiosk launch.
- [x] Add Windows coverage checks before any pointer/touch activation.
- [ ] Run focused tests and the full detached gate; record the verdict.
- [ ] Land, run patch-release Windows acceptance and publish the tested bytes.
- [ ] Update the home device and verify the delivered version and app behavior.

Initial evidence: fresh batch launches request kiosk mode but never notify the
existing settle helper; settling at first install is protected by a one-time
marker, while Talk returns and button relaunches have their own settle calls.
No touch or browser navigation was injected on the home device during diagnosis.

Focused verification: 54 tests passed across the camera/storage, playback UI,
launcher, pause/resume, batch-launcher and native coverage contracts. The
playback targets contain both icons and labels at 1280×720, 1280×800 and
1920×1080. The suite registry remains unchanged at 210 suites.
