# Gaze engine supervisor — design (2026-10-26)

Dad, 10/26 morning: "When I open the device in the morning, ERA Gaze is not
working. It has happened twice now. It should already have a restart function
if it turns itself off, unless purposely deactivated."

## What the devices said

Tablet, engine log, 10/25 18:49:

```
18:49:37.857  config load failed: Invalid JSON primitive: .
18:49:37.864  ERAgaze 2.0 start source=gaze ... bus=49155
18:49:37.880  bus start FAILED on port 49155: ... conflicts with an existing registration
18:49:37.953  tracker ... streaming
18:49:39.626  newer instance took over; exiting
```

- A second engine instance was launched by hand (its command line was
  `ERAgaze.exe 8377 "null"`: the Start-menu and desktop links still carried
  arguments from a 9/14 write; see §4). "Newest launch wins": it claimed the
  owner file, tried to bind the bus while the instance it replaced still held
  the port, failed, and ran on **with no bus**. Two seconds later the old
  instance exited. From then on the cursor moved but every door, dwell and
  hub probe was dead: "ERA Gaze is not working".
- The hub restarted seven times overnight (self-updates) and never noticed:
  `reconcileApps` only starts the engine when it installs or recompiles it.
  The hub log has no `[gaze]` line at all after the 18:49 event.
- Startup links on both home devices are correct (the hub's boot pass rewrote
  them this morning); they read as the ssh user's path only when inspected from
  the ssh session, because the .lnk stores a profile-relative path. Hypothesis
  "the Startup link is missing or wrong" is ruled out.
- The tablet's `ERAgaze.json` has a trailing comma and has failed to parse
  since 9/14, so that engine ran on defaults. Not the cause here, but a
  resilience gap in the same family.

## The fix, in three parts

### 1. The hub keeps the engine on its bus (`gaze-supervisor.js`)

When the engine is enabled in apps.json and our build is compiled, the hub
polls `GET 127.0.0.1:49155/status` every 10 s. Silent for 30 s (after a 60 s
boot grace, so a Startup-link engine still coming up is not trampled), it
stops **our** process by path (a deaf instance is still a process and would
hold the port) and starts it again. Still silent, it tries again after 30 s,
then 60, 120, 300, 600 s; once the engine has answered for two minutes the
ladder resets. An install or recompile in flight holds it off. A family build
answering the bus is simply "alive" and never touched.

`GET /status` reports it: `gaze: {state, alive, lastSeen, downSince,
restarts, lastRestart, nextRetry, stoppedOnPurpose, ...}` — `state` is one of
`off | starting | watching | down | waiting | restarting | installing |
stopped`.

### 2. "Unless purposely deactivated"

Settings' "Stop ERAgaze completely" now goes through the hub: `POST
/gaze/stop` writes `<DATA>/gaze-stopped.json` and posts the engine's
`/shutdown`; the supervisor leaves the engine alone while the marker is there.
It is cleared by `POST /gaze/start` (a new "Start ERAgaze again" button on the
stopped card), by the engine reappearing on the bus (the desktop icon), or
after eight hours. The marker outlives a hub restart (a self-update lands most
nights). Both routes are loopback-only: nothing on a school network may stop
her engine. Turning the engine OFF in the apps list still works as before and
is "off", not "stopped".

### 3. The engine binds its bus or keeps trying (era-gaze)

`StartBus()` retries a failed bind every 500 ms for a minute (the hand-off
case: the previous owner exits within ~2 s) and then every 10 s for as long
as the process lives, logging only now and then. The tracker, overlay and
hook never waited on the bus. The hub recompiles the shipped source on the
next update, so the device gets this without a signed cut.

Also: `Cfg.LoadFile` forgives a trailing comma before `}` / `]`.

### 4. Stale link arguments

`shortcuts.js` now always writes `$l.Arguments` — empty for an exe link.
`CreateShortcut` on an existing .lnk keeps every property the script does not
set; the engine's links still carried `8377 "null"` from 9/14.

## Not done, on purpose

- No change to the single-instance rule (newest launch wins): it is what lets
  a hand launch replace a wedged engine.
- The legacy VolCap watchdog task and the disabled legacy `\ERAgaze` task on
  the home i13 are left alone.
- The i13's morning event itself was not captured (the device went to sleep
  before its logs could be read); the supervisor covers every shape of "the
  bus is not answering", including that one.

## Acceptance

- `tests/gaze-supervisor.test.mjs` — the state machine on a fake clock.
- `tests/gaze-status.test.mjs` — the real hub over a stub compiler and a
  stand-in bus: restart with backoff, `/status`, stop/start, marker survives a
  restart, OFF is unsupervised, loopback guard.
- `tests/shortcuts.test.mjs` — an exe link writes an empty Arguments.
- Device: stop the engine by hand on a home device → it is back on the bus
  within about a minute; reboot → it comes up from the Startup link and the
  supervisor reports `watching`.
