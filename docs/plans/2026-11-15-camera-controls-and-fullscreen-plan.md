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

Focused verification: 55 tests passed across the camera/storage, playback UI,
launcher, pause/resume, batch-launcher and native coverage contracts. The
playback targets contain both icons and labels at 1280×720, 1280×800 and
1920×1080. The suite registry remains unchanged at 210 suites.

The first full gate passed all 210 suites fresh, receipt
`2026-11-16T00-00-54Z-f4e67f2`. The unpublished Windows candidate passed 14
checks; the new launch test failed because it attached to the old CDP browser
while the batch launcher was closing it. It now explicitly closes the whole
browser and waits for its guest listener to disappear before launching again.

Restart review also identified Edge kiosk's InPrivate storage lifetime. A red
test reproduced losing camera setup with a completely new browser context.
Camera setup now lives in the local Hub data instead. Service-restart and
new-browser-session tests pass. Windows acceptance also checks that local setup
survives a complete Edge restart and triggers an automatic camera request
(the QA VM has no physical camera). A new full gate and candidate build follow.
