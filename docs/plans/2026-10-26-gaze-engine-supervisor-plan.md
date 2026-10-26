# Gaze engine supervisor — plan (2026-10-26)

Design: [specs/2026-10-26-gaze-engine-supervisor-design.md](../specs/2026-10-26-gaze-engine-supervisor-design.md).
Worktrees: `era-hub--wt-era-gaze-launcher` + `era-gaze--wt-era-gaze-launcher`
(`ERA_WT_SUFFIX=--wt-era-gaze-launcher`). Urgent device fix under a release
freeze: push-device only, no publish, no landing until the freeze lifts.

- [x] Diagnose from device logs (tablet: deaf engine since 10/25 18:49; i13 and
      school asleep). Startup links ruled out.
- [x] `gaze-supervisor.js` + `tests/gaze-supervisor.test.mjs` (12, fake clock).
- [x] Hub wiring: supervisor instance, `ERA_GAZE_BUS_PORT` seam, `startGazeProcess`,
      `GET /status`, `POST /gaze/stop|start` (loopback), poll loop at boot,
      module in `build-payload.sh`.
- [x] `tests/gaze-status.test.mjs` (8, real hub + stand-in bus).
- [x] Settings: stop goes through `/gaze/stop`; "Start ERAgaze again" button.
- [x] `shortcuts.js`: exe links write an empty Arguments (+ test).
- [x] era-gaze: `StartBus()` retry; trailing-comma-tolerant config. Compiled with
      the device's csc into a scratch file (78 KB, clean).
- [x] Docs: spec, this plan, dev-flow section, era-gaze README, bug-test index row.
- [ ] Gate (one lane, `ERA_WT_SUFFIX`), detached with a sentinel.
- [ ] push-device to tablet + home i13; verify: engine stopped by hand comes
      back; reboot comes up `watching`.
- [ ] School through the queue, idle gate respected.
- [ ] Land both repos once the freeze lifts (era-gaze first, then era-hub).

## Retrospective

(filled at the end)
