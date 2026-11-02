# Gaze stream watchdog — plan (2026-11-02)

Design: [specs/2026-11-02-gaze-stream-watchdog-design.md](../specs/2026-11-02-gaze-stream-watchdog-design.md).
Worktrees: `era-hub--wt-eragaze-tablet-drops` + `era-gaze--wt-eragaze-tablet-drops`
(`ERA_WT_SUFFIX=--wt-eragaze-tablet-drops`), branch `fix/eragaze-tablet-drops`.

- [x] Diagnose on the tablet: hub/supervisor state, engine log (dated by
      rollover), System + Application event logs, power states. Root cause: a
      Stream Engine connection that Modern Standby leaves open, error-free and
      empty; the engine only reconnected on an error, the hub only probed the bus.
- [x] Controlled test on the device (engine `/shutdown` → supervisor restart →
      frames flow): the tracker is fine, the connection was dead.
- [x] era-gaze: `tests/StreamWatchdogRegression.cs` + `tests/stream-watchdog-regression.ps1`
      (red against 2.6: no such members); engine v2.7 stream watchdog,
      `/status` `samples` + `silentMs`, `streamSilentMs` knob. 14/14 on the tablet's csc.
- [x] era-hub: `tests/gaze-status.test.mjs` three new cases (red 2, then
      11/11); `gazeBusProbe` / `gazeEngineAlive`, `ERA_GAZE_STREAM_SILENT_MS`,
      `/status` → `gaze.engine`.
- [x] Docs: spec, this plan, era-gaze README.
- [ ] Gate with `ERA_WT_SUFFIX`, detached + `gate-wait.sh`.
- [ ] Land era-gaze, then era-hub (`worktree.sh land`).
- [ ] `build-dist.sh --patch` → push-device tablet + home i13; engine recompiled
      to 2.7, `/status` shows `samples` climbing.
- [ ] Dad: power button sleep → wake on the tablet; engine log shows the
      reconnect and frames without a hand launch.

## Retrospective

(filled at the end)
