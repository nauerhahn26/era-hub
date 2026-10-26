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
- [x] Gate (lane 8380, `ERA_WT_SUFFIX`), detached: 158 passed, 0 failed, both trees stamped 16:19 UTC.
- [x] push-device to tablet + home i13 as build 20261026.1547: both recompiled the engine, bus up, `watching`. Engine killed by hand: back on the bus in 54 s (tablet) / 67 s (i13), restart #1 logged.
- [ ] Tablet reboot → `watching`; i13 duplicate hand launch → bus bound after retries (running).
- [x] School job `aac-board-builder/tools/school-queue/school-gaze-launcher.sh` armed (*/10, `# beacon: idle`, idle via /version idleMs ≥ 5 min); device not online yet today. push-device refuses a stamp > 2 h → re-gate on NEEDS-MANUAL.
- [ ] Land both repos once the freeze lifts (era-gaze first, then era-hub).

## Retrospective

(filled at the end)
