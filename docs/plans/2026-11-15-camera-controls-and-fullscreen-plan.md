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
- [x] Run focused tests and the full detached gate; record the verdict.
- [x] Land, run patch-release Windows acceptance and publish the tested bytes.
- [x] Update the home device and verify the delivered version, assets and library.
- [x] Finish the home device's native bottom-edge probe after it is online again.

Initial evidence: fresh batch launches request kiosk mode but never notify the
existing settle helper; settling at first install is protected by a one-time
marker, while Talk returns and button relaunches have their own settle calls.
No touch or browser navigation was injected on the home device during diagnosis.

Focused verification: 56 tests passed across the camera/storage, playback UI,
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

The durable-camera implementation passed a second fresh gate: 210 passed,
0 failed, receipt `2026-11-16T00-40-09Z-0102163`. The Windows candidate then
passed all existing checks and all 14 fresh app routes at 1280×800: each browser
was focused, covered the center and three bottom-edge points, and filled the
screen before any click. The new camera fixture exposed an empty canvas stream
that left video playback waiting for its first frame. A direct browser
reproduction confirmed stream active / media readyState 0; drawing frames
unblocked the preview, saved setup and passed fresh-session automatic camera
request. The fixture now delivers frames continuously. The app code is unchanged
by this fixture correction; the required gate and Windows pipeline are rerun.

The fixture correction passed 210 fresh suites (one existing Watch UI flake
passed its automatic retry), receipt `2026-11-16T01-23-58Z-dd43605`.
A direct startup check then reproduced a camera request surviving a brief
hide/restore while acquisition was pending: the stale grant stopped correctly
but prevented the wanted preview from restarting. A red browser test pins that
transition. After releasing a stale grant, the camera now retries only when
the visible, unlocked app still wants it. Real failures never loop. All 56
focused tests pass, including late-grant cleanup, hide/restore and denial.

## Published and delivered v1.1.5

Published: https://github.com/nauerhahn26/new-era-releases/releases/tag/v1.1.5

Version `v1.1.5`, build `20261116.0216`, source tag
`e74e23d146a3d2d576dfdf08d0b2ca9305ca2fe4`, source tree
`782600b98b0944331b599b7386fe8c3f9e069249`.
Final gate: **210 passed, 0 failed, all fresh**, receipt
`2026-11-16T01-56-48Z-782600b`. Focused verification: **56 passed**.
The canonical patch pipeline passed **16 Windows checks, 0 failures**, using
the quiet guest profile and the verified signed installer from v1.1.0.

All 14 installed app routes, Home and Settings included, filled the native
1280×800 display and owned focus, the center and all three bottom-edge points
before any click. Camera setup survived a complete Edge restart, with a new
InPrivate storage session and an automatic camera request. This is a request
and persistence check; the QA VM has no physical camera.

The public latest feed and downloaded stable tarball match the tested archive:

```
23b54aa1210cf6754aba6ece8f5079155b52ae7da89a39fe825e913533d81469
```

The home device updated through the normal updater from `20261115.1956` to
`20261116.0216`. Running and disk builds match. Its served HTML, JavaScript and
CSS hashes match the release payload; the shared folder remains available with
both practice videos. The installed batch launcher then opened Speech Mirror
successfully (completed, result 0), without an agent pointer/touch action. The
device initially went offline before the native window measurement. After it
was woken, another fresh installed-batch launch completed with result 0 on the
same build. A windowless native probe confirmed that the owned Speech Mirror
Chrome kiosk held focus and covered the center and all three bottom-edge
checkpoints on the Windows-reported 1280×720 desktop, without an agent pointer
or touch action. The taskbar was behind the app. The old version had no saved
camera choice; start and select the camera once on this version to save its
setup. Physical camera image quality and gaze accuracy require confirmation on
the device.

All release QA hosts were destroyed by the runner's cleanup. No live host hub
was restarted. Future checks should review camera lifecycle alongside native
minimize/restore, give synthetic canvas cameras continuous frames, and run the
Linux gate and Windows legs serially in one worktree because both own `gate/`.
