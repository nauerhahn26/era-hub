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
- [x] Gate with `ERA_WT_SUFFIX`, detached + `gate-wait.sh`: 208 passed, 0 failed, tree 9b9f62d, 00:10 UTC 11/3.
- [x] Land era-gaze (728033c), then era-hub (9346cb4).
- [x] `build-dist.sh v1.0.46 --patch` (20261103.0011) → push-device tablet 00:12 UTC
      and home i13 00:13 UTC; both hubs recompiled the engine to 2.7 on boot,
      `/status` → `gaze.engine.samples` climbing, `silentMs` a few hundred ms.
      Not published; the school device waits for the next published release or
      the school queue.
- [ ] Dad: power button sleep → wake on the tablet; engine log shows the
      reconnect and frames without a hand launch.

## Retrospective

- The 10/26 supervisor was right about what it watched and blind to what
  mattered: liveness was "the bus answers". The engine's own frame counter
  (`METRICS samples=`) had been flat for 17 h in plain sight. Any process that
  owns a stream should report the stream's age, and its keeper should read it.
- Dating a log that has no dates: time rollovers plus the System log's standby
  entries (Kernel-Power 506/507, USBHUB3 196/205) pinned every stall to a
  standby exit. The Windows event log named the mechanism ("DRIPS blocking
  device … removed … re-enumerating") before the engine code was opened.
- The decisive measurement was the idle rate: 20 frames per 10 s with nobody
  there. Without it a silence watchdog would have been a guess about empty
  rooms; with it, 15 s of silence is unambiguous.
- A controlled restart on the device (engine `/shutdown`, supervisor restart,
  frames in 37 s) confirmed the hypothesis before a line was written, and gave
  dad a working tablet an hour before the fix landed. A host-side sitter (ssh
  every 20 s, restart on a frozen counter) covered the gap until the push.
- No C# compiler on the Linux host: the engine regression was written first,
  proven red against the 2.6 source on the tablet's own csc (missing members),
  then green 14/14 there. The device compiler is the engine's test rig.
- Open: dad's power-button sleep/wake on the tablet is the proof of the real
  failure mode; the engine log should show `stream silent … reconnecting` →
  `streaming` (or `no tracker found` until the tracker is back) with no hand
  launch. Also open from 10/26: the hub's Startup link reads as the ssh user's
  path when inspected over ssh (profile-relative .lnk) — cosmetic.
