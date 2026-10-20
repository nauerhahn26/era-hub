# Self-update cadence: wake-aware and every 30 minutes — design

Date: 2026-10-20. Unit of work on branch `fix/update-cadence`. Follows the
2026-09-15 dev-flow design (§5, the self-updater) and the 2026-10-19
hub-survives-reboot design (the hub now starts at logon).

## 1. Intent and why

The installed hub checks the release feed 90 s after boot, then every 6 hours
(`update.js start()`). A device that is awake all day meets that cadence. The
school device does not: it sleeps after 10 idle minutes on battery and is awake
in 20-60 minute windows, two or three a day. A 6-hour timer almost never lands
inside such a window, and a timer that comes due while the machine sleeps fires
only when the machine wakes — which it may do for a window too short to finish.
Evidence: the school hub self-updated on 2026-10-06 (nudged by an ops job that
sends `POST /update/check` for its own reasons) and has sat on that build since,
through two signed releases and six patches. Nothing in the hub itself ever
caught an awake window.

Dad's decision (2026-10-20): "make the deploys happen faster with shorter
periods of inactivity as the first thing. If the device goes to sleep after 10
minutes of inactivity and we only deploy after 15 minutes of inactivity, then
we will never deploy to the device."

Two layers. The ops side (private repo) now nudges the school hub with
`POST /update/check` the minute it appears on the network and every five
minutes while it stays up. This unit is the hub side, so a device never depends
on the ops watcher: the hub checks often enough, and right after it wakes.

## 2. Goals, non-goals, anti-goals

Goals
- A hub that is awake for 20 minutes with a newer release on the feed updates
  itself inside that window, with no help from outside.
- A hub that has just woken from sleep checks within about a minute of waking.
- The cost of a check that finds nothing stays what it is: one small GET of
  `latest.json`, no download.

Non-goals
- Changing the wizard gate (`ready()`), the manual `POST /update/check` path,
  the restart mechanics, the loopback-only rule or the pack rules. All stay
  byte-for-byte in behaviour.
- Changing how a device sleeps, or the ops watcher. Out of this repo.
- Tracking downloads or retries beyond today's "failures wait for the next
  tick".

Anti-goals (a failure even if it "works")
- Two checks in flight at once, or a check storm after a long sleep (one wake
  check, then the normal cadence).
- A restart under the welcome wizard (`tests/update-boot.test.mjs` pins it).
- A hub that hammers the feed: the periodic interval never goes below the
  decided default on a device; only the test seams shrink it.
- A new seam that the gate does not close or the seam-parity test does not
  list (every `ERA_*` test seam is closed by `tools/era-gate.sh` and listed in
  the parity test, so a forgotten seam cannot point a gate hub at a live feed).

## 3. Constraints

- `update.js` is stdlib-only Node, loaded by `server.js`; `start(port, ready)`
  is its only scheduling entry. `ERA_UPDATE_BOOT_MS` already shrinks the boot
  delay for tests; `ERA_UPDATE_URL` points at a fake feed; `ERA_NO_UPDATE`
  disables.
- `tests/update-boot.test.mjs` boots a real installed hub (ports 8423 hub /
  8424 feed) against a fake release server and drives it through the wizard
  and one update. It is the natural home for a cadence test: after its last
  case the hub serves `NEW_BUILD`; a newer build published to the fake feed
  must then land by the periodic tick alone, with no POST.
- Node timers cannot be suspended in a test, so wake detection is designed as
  a pure decision that a unit test can drive with numbers.
- Vendor-neutral code, docs and commits; no family names, towns, IPs or device
  identifiers.

## 4. Decided shape

### 4.1 Periodic check every 30 minutes

`start()` keeps the boot check as is and replaces the 6-hour interval with
`EVERY_MS`, default 30 minutes, overridable by `ERA_UPDATE_EVERY_MS` (a test
seam like `ERA_UPDATE_BOOT_MS`; the builder may clamp it to a floor only for
non-test use if that is simple — not required). The interval tick is gated by
`ready()` exactly as today. `inFlight` already refuses an overlapping check.

Why 30 minutes: an awake window of 20 minutes has at least one tick in it two
times out of three, and the boot/wake check covers the rest; a `latest.json`
read every 30 minutes is a negligible cost on any connection.

### 4.2 Wake detection: a heartbeat that notices lost time

A heartbeat `setInterval` every `HEARTBEAT_MS` (default 30 s) records
`Date.now()`. When the gap between two heartbeats exceeds `HEARTBEAT_MS +
WAKE_GAP_MS` (default gap 2 minutes), the hub has been asleep (or the clock
jumped): schedule ONE check `WAKE_DELAY_MS` (20 s, let Wi-Fi settle — the same
delay the Clothing Picker uses for its startup/wake tick) later, gated by
`ready()`, logged as `[update] wake check: <status>` only when the status is
not `up-to-date`. A wake check does not reset the periodic interval; the
periodic tick after a wake is simply the next tick.

The decision is a pure function, exported for its unit test:
`wokeUp(prevMs, nowMs, heartbeatMs, gapMs) -> boolean`. Seams: the builder
needs at most `ERA_UPDATE_EVERY_MS` and, if the integration test wants to
drive the heartbeat path, `ERA_UPDATE_HEARTBEAT_MS`; every seam added goes
into the gate's close list and the seam-parity test. Fewer seams is better:
the pure function test needs none.

### 4.3 What a device sees

1. Logon (the Startup link from the 2026-10-19 unit) → hub boots → boot check
   90 s in (unchanged).
2. Sleep at 10 idle minutes; wake by the aide or the wake task → heartbeat sees
   the gap → check 20 s later → a newer release lands and the hub restarts.
3. Awake all day → a check every 30 minutes.

## 5. Tests

- `tests/update-boot.test.mjs` gains one case after the existing two: the fake
  feed now advertises a NEWER build (`NEWER_BUILD`), with `ERA_UPDATE_EVERY_MS`
  set small for the hub under test (the hub is started once in `before`; the
  env is set there); within a few intervals `/version` serves `NEWER_BUILD`
  from a new pid, with no POST sent. (The feed handler must be able to switch
  what it serves; the first two cases are untouched.)
- A unit test for `wokeUp` (in the same file or `tests/update-wake.test.mjs`
  with NO ports — a pure import): below the threshold false; above it true;
  a backwards clock jump is treated as a wake (true) — the check is harmless.
- The seam-parity test lists every new `ERA_UPDATE_*` seam and
  `tools/era-gate.sh` closes it (the builder finds the list the same way the
  2026-10-10 weather unit did: grep for `ERA_WEATHER_RETRY_MS`).
- The existing cases ("no restart under the wizard", "the moment the wizard
  is answered") stay green unchanged.

## 6. Left to the builder

- Whether the heartbeat lives in `start()` or a small helper; whether one or
  two seams are needed. Exact log wording, keeping the `[update]` prefix.
- Whether `ERA_UPDATE_EVERY_MS` deserves a floor on devices.

## 7. Release

Unsigned patch (`release.sh v1.0.6 --patch`) under the signed v1.0.0
installer. Publishing waits for dad's word. The QA host needs the 10/16
repair helper after `qa.sh up` before the VM leg (see the 2026-10-19 plan's
retrospective) until the template is re-saved.
