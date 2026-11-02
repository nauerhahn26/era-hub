# Gaze stream watchdog — design (2026-11-02)

Dad, 11/2 (Sunday, home tablet): ERAgaze "keeps dropping" despite the 10/26
supervisor; minutes before this record "I launched the ERA gaze, and it was on,
and then I went to the chat, and it was off."

## What the tablet said

- Hub build 20261102.1727, supervisor `watching`, engine process up since
  10/31 09:55 (a hand launch). The bus answered every probe. Nothing was dead
  by the supervisor's definition — and the engine had delivered **zero gaze
  frames for 17 hours**: `METRICS samples=719153` at every line from 11/1
  22:38 through 11/2 15:47, `sent` on `/status` frozen too, while dad used the
  board (bus clients connecting at 08:23, 15:26, 15:36).
- The System log pairs every stall with Modern Standby. On entering standby
  Windows removes the Tobii tracker (USB `VID 0x2104 PID 0x318`, "USB device
  draining system power when system is idle … Re-enumerating a DRIPS blocking
  device that was previously removed when exiting low power epoch"), and the
  Tobii Service answered the service controller late twice (event 7011).
  Afterwards the engine's Stream Engine connection sometimes reports an error
  (`process_callbacks err 5 x21; reconnecting` on 11/1 00:12 → `no tracker
  found` until the power button at 06:42 → streaming again, frames flowing) and
  sometimes reports **nothing**: 11/1 20:59 power button → standby → 22:38 a
  brief wake delivers 15 frames → silence with `tobii_device_process_callbacks`
  returning 0 forever. The engine's service loop only reconnects on an error.
- Across the week the engine logged about 75 h of exact-zero frame intervals
  against 47 h of idle streaming and 9.5 h of use. Every recovery was a hand
  launch of the desktop/Start-menu link (10/27 18:49, 10/28 08:43, 10/31 09:55),
  i.e. a fresh process and a fresh connection.
- A healthy tracker is never quiet: with nobody in front of it the engine still
  receives 20 frames per 10 s (validity 0), 330 per 10 s with eyes on it. Zero
  for 15 s is a dead connection, not an empty room.
- Controlled test 15:47: `POST /shutdown` to the engine; the supervisor started
  it again 37 s later; the fresh process streamed at once (20 per 10 s). The
  tracker and the Tobii service were fine; only the old connection was dead.

## The fix, in two layers

### 1. The engine reconnects a silent stream (era-gaze, v2.7)

`GazeCallback` stamps `lastFrameTick` on every frame (before the paused
check). The service loop, after `tobii_gaze_point_subscribe`, resets the stamp
and on every pass asks `StreamStalled()`: connected and no frame for
`Cfg.StreamSilentMs` (default 15 000 ms = 30 idle frames; `streamSilentMs` in
`ERAgaze.json`, floor 1 s). Stalled → `stream silent for N s with the tracker
connected; reconnecting` and the existing retry path: unsubscribe, destroy
device and api, 3 s, enumerate again. If the tracker is still unplugged that
is the `no tracker found` loop as before; once it is back the subscribe is
fresh and frames flow — the same thing a hand launch did, without the launch.

`/status` gains `"samples"` (frames received since start) and `"silentMs"`
(ms since the last frame while connected, `null` while not), version `2.7`.

### 2. The hub's second look (era-hub)

`gazeBusProbe()` parses the engine's `/status`; the supervisor's `isAlive`
is now `gazeEngineAlive()`: an engine that answers but reports `connected:
true` and `silentMs > ERA_GAZE_STREAM_SILENT_MS` (default 90 s) is counted as
gone, logged once per episode (`engine answers but its tracker stream has been
silent for N s — counting it as gone`), and the 10/26 restart ladder does the
rest. `connected: false` is the engine's own retry loop and is left alone; an
engine without the fields (a family build, an older engine) is alive as before.
`GET /status` → `gaze.engine = { connected, silentMs, samples }` and
`gaze.streamSilentMs`.

Why both: the engine's watchdog is the fix; the hub's look is for the case
where a reconnect inside the same process does not bring frames back (a
wedged Tobii service) — a fresh process is what has worked by hand all week.

## Not done, on purpose

- No change to the tablet's power plan. Modern Standby on a kiosk tablet is
  the device's normal life; the engine must survive it.
- No change to the single-instance rule or to the 10/26 supervisor's clocks.
- The Tobii Service's own 30 s transaction timeouts (event 7011) are the
  vendor's; the reconnect copes with them.

## Acceptance

- `era-gaze/tests/stream-watchdog-regression.ps1` — compiles the real engine
  beside a test entry point on a Windows box: the stall decision (threshold,
  `TickCount` wrap), `StreamStalled()` over the engine's own state, the
  `/status` fields, the config knob. Red against the 2.6 source (no such
  members), 14/14 on the tablet's own csc.
- `era-hub/tests/gaze-status.test.mjs` — three new cases over the real hub and
  the stand-in bus: silent-but-connected restarts once and settles when frames
  return; unplugged never restarts; `/status` carries the engine's report.
- Device: push to the tablet, the hub recompiles 2.7 and restarts the engine;
  dad puts the tablet to sleep with the power button and wakes it; the engine
  log shows `stream silent … reconnecting` → `streaming` and `samples` climbing
  without anyone launching anything.
