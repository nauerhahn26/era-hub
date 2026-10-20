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

### 1.1 What the daily alert mails and the watcher logs say (reviewed 2026-10-20)

Twelve "deploy queue stalled" mails since 2026-10-02, one per school day the
queue had not drained by 3:30 PM Pacific. Three classes:

- NEVER-ONLINE (10/2, 10/5, 10/7, 10/8, 10/12, 10/16): the device was not seen
  on the network all day — or, on 10/16, WAS seen 08:32-08:59 PT but the
  end-of-day check did not read the watcher log then (fixed 10/19).
- ONLINE-FAILING (10/9, 10/14, 10/15): a job erred on every attempt (the
  Drive-for-Desktop repair; resolved 10/15).
- STILL-QUEUED (10/6, 10/13, 10/19): the device had windows but the board-sync
  job's "is she on it" proxy — the TD Snap page-set file untouched for 15-20
  minutes — never opened. On 10/19 the four windows were 76, 18, 32 and 16
  minutes long, and the watcher kicked nothing because of a crontab path bug
  (fixed 10/19 20:23 UTC, after the last window). Hub self-update was never
  among the queued jobs: nothing from the ops side asked the hub to check, and
  the hub's own 6-hour timer never landed in a window. The school hub has
  served build 20261005.0056 since 10/6.

Online windows seen by the watcher (Pacific): 10/14 08:40-13:00 (one long
block), 10/15 08:50-10:03 and 11:50-12:41, 10/16 08:32-08:59, 10/19 08:47-10:03,
10:40-10:58, 11:01-11:33, 12:05-12:20. None on weekends. The device sleeps
after 10 idle minutes on battery, so "idle for 15 minutes" and "awake" almost
never overlap — exactly dad's point — while the awake minutes are minutes
Ellie is using it. A deploy path for this device must therefore (a) act within
the first minute of a window and (b) not need her to stop using it, or not
touch anything she is using.

The device's own wake-window log (what woke it, how long it held) has not been
read yet: the read-only probe armed 10/19 fires the next time the device is
seen and answers that question. Until then the watcher's online windows are
the wake evidence.

## 2. Goals, non-goals, anti-goals

Goals
- An update never interrupts Ellie: the restart that completes an update
  happens only in a quiet moment, or at the next boot if none comes.
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
- A restart while she is mid-use: a tap that fails because the hub was
  restarting under it.
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

### 4.4 The apply step waits for a quiet moment (dad 2026-10-20: "without interference")

Today `runCheck()` downloads, verifies, overlays the install and restarts in one
pass. A restart takes about two seconds, during which any request from the
kiosk fails once (a tap's log line, a spoken word, a prediction). Fine at 3 AM;
not fine while Ellie is using the board. So the pass splits:

- FETCH + STAGE (safe any time): download, verify the checksum, extract into a
  staging directory beside the install (`<HERE>/.update-staged/<build>`), never
  into the live tree. Log `[update] staged <build>`.
- APPLY (only when quiet): overlay from the staging directory exactly as today
  (same filters: never `data/`, never `node/`, never an absent pack) and
  restart. Log line unchanged (`[update] <from> -> <to> (<version>); restarting`).

Quiet means: no interaction for `QUIET_MS` (90 s). The hub learns interaction
from its own traffic — `server.js` stamps `lastInteractionAt` on every request
Ellie's actions produce: every POST except `/update/check`, `/kiosk/resume`,
`/kiosk/close` (those come from the launcher or an operator), and every GET
under `/tts` and `/predict` (spoken words and predictions). Polls (`/version`,
`/settings` GET, board recipe ETag checks) are not interaction. The hub exposes
the stamp to the updater as a function (`lastInteractionAt()`), and `/version`
gains `idleMs` (ms since the last interaction, or null when none yet) so an
operator can read it.

Scheduling: when a check finds a staged build waiting, or has just staged one,
it applies at once if quiet, else arms ONE short timer (every 15 s) that
applies the moment `QUIET_MS` has passed. A staged build also applies on the
next boot before anything else (so a device that is never quiet while awake
still updates at its first logon after the download). A manual
`POST /update/check` keeps today's immediate behaviour (`force: true` through
the route → stage + apply now): the operator asked for it. `/update/check`'s
answer reports `{status:"staged", build, idleMs}` when it stages but defers.

Seams: `ERA_UPDATE_QUIET_MS` (test seam, default 90 s). Same rule as every
seam: closed by the gate, listed in the parity test.

Why 90 s: a page of the board is a few taps a minute while she is talking;
90 s without any of them is a break (recess, a transition), and a two-second
restart then is invisible. Why not the TD Snap file-age proxy: the hub cannot
see TD Snap, and the hub restart does not touch TD Snap; what it must not
touch is OUR board mid-use, which the hub sees directly.

### 4.5 Presence beacon: the device says "I am awake" (dad 2026-10-20)

Dad: "the device should tell us the minute it wakes up so we don't get
confusing messages about it never coming online just due to insignificant
checks." Today the ops side learns a device is up by polling the network
every minute and by jobs that try every ten; a device that wakes for a short
window can be missed, and the end-of-day mail then says it never came online.

The hub gains an opt-in, generic beacon. When the setting `beaconUrl` is set
(app-settings.json; no UI; set per device by the operator — never a default, the
public repo carries no addresses), the hub POSTs a small JSON body
`{device, build, event, idleMs, at}` to that URL:
- `event: "boot"` once the server listens;
- `event: "wake"` when the heartbeat of §4.2 detects lost time;
- `event: "idle"` the moment the device has been idle for `IDLE_MS` (5 min,
  seam `ERA_BEACON_IDLE_MS`) — edge-triggered: once per idle stretch, re-armed
  by the next activity. Dad (2026-10-20): "have the device notify you on boot
  and anytime it's idle for 5 mins, then we catch a moment to perform
  functions immediately." A device that sleeps at 10 idle minutes still gives
  the operator a five-minute window it certified itself.
- `event: "alive"` every `BEACON_MS` (5 min) while running.

Idle, for the beacon, means BOTH of: no board interaction (the §4.4 stamp) for
`IDLE_MS`, AND every file named by the setting `idleWatchFiles` (an array of
absolute paths; default empty) unmodified for `IDLE_MS`. The hub cannot see
other apps' use — on the school device Ellie may be in TD Snap, whose
page-set file the operator's gate has trusted as the "is she on it" proxy
since August — so the operator lists that file and the hub stats it every
30 s (a stat, never a read; a missing file counts as idle). `idleMs` in the
body is the smaller of the two idle times.
Fire-and-forget: 5-s timeout, never retried, one log line per failure class
(`[beacon] unreachable`), never more than one in flight. `device` is the pool's
device id (`pool.deviceId`), `build` is `updater.runningBuild`.

The receiving side is the same hub code running on the operator's host with
`ERA_BIND` open to the private network: a route `POST /presence` that accepts
that body (device id limited to `[A-Za-z0-9_-]{1,64}`, body ≤ 4 KB, else 400),
writes `<DATA>/presence/<device>.json` `{device, lastSeen, event, build,
idleMs, from}` (newest wins), appends an `app-log`-style pool event, and — if
`ERA_PRESENCE_HOOK` names an executable — spawns it detached with the device
id and event as arguments, so the operator's queue can act within seconds
instead of on the next cron minute. The route is not loopback-gated (its
callers are remote by nature) and changes nothing but that file; a flood is
harmless (one small write per request; the hook is rate-limited by the hook
itself).

`GET /presence` lists the files (for the operator and tests). On an `idle`
beacon the operator's hook runs the queued jobs at once with the device's own
certification standing in for the jobs' idle gate; the on-screen pixel gates
stay no matter what. On a family
device no one sets `ERA_PRESENCE_HOOK`, and `beaconUrl` unset means the beacon
code never runs.

Tests: `tests/presence.test.mjs` (a fresh port from the free band; grep every
repo's tests/ before choosing, as the port memory requires): a hub with
`beaconUrl` pointing at a second hub's `/presence` sends `boot` within a few
seconds of listening; with `ERA_BEACON_IDLE_MS` small, an `idle` beacon follows
once after the last interaction and not again until a new interaction (POST
`/log`) re-arms it; touching a file listed in `idleWatchFiles` postpones it; the receiver's file carries the device id and build;
`GET /presence` lists it; a bad device id is 400; with the hook env set to a
script that appends its arguments to a file, the hook runs once per beacon.

### 4.3 What a device sees

1. Logon (the Startup link from the 2026-10-19 unit) → hub boots → boot check
   90 s in (unchanged).
2. Sleep at 10 idle minutes; wake by the aide or the wake task → heartbeat sees
   the gap → check 20 s later → a newer release is staged; it applies the first
   time the board has been quiet for 90 s (or at the next boot).
3. Awake all day → a check every 30 minutes; the beacon says "alive" every
   5 minutes, so the operator's view of the device is never older than that.

## 5. Tests

- `tests/update-boot.test.mjs` gains one case after the existing two: the fake
  feed now advertises a NEWER build (`NEWER_BUILD`), with `ERA_UPDATE_EVERY_MS`
  set small for the hub under test (the hub is started once in `before`; the
  env is set there); within a few intervals `/version` serves `NEWER_BUILD`
  from a new pid, with no POST sent. (The feed handler must be able to switch
  what it serves; the first two cases are untouched.)
- `tests/update-boot.test.mjs` cadence case (above) also proves the quiet gate:
  before publishing `NEWER_BUILD`, the test keeps the hub "in use" by POSTing
  `/log` every few hundred ms for several intervals and asserts the hub STAGED
  (`/update/check`-free: the log line or `/version` shows the old build with
  the staging dir present) but did not restart; then it stops posting and the
  update lands within `ERA_UPDATE_QUIET_MS` + a few ticks. `/version.idleMs`
  is asserted to reset on a POST `/log` and to be null before any interaction.
- A boot with a staged build present applies it before serving (a small case
  in the same suite or `tests/update.test.mjs`: write a staged dir by hand,
  start the hub, it comes up on the staged build).
- A unit test for `wokeUp` (in the same file or `tests/update-wake.test.mjs`
  with NO ports — a pure import): below the threshold false; above it true;
  a backwards clock jump is treated as a wake (true) — the check is harmless.
- The seam-parity test lists every new `ERA_UPDATE_*` seam and
  `tools/era-gate.sh` closes it (the builder finds the list the same way the
  2026-10-10 weather unit did: grep for `ERA_WEATHER_RETRY_MS`).
- The existing cases ("no restart under the wizard", "the moment the wizard
  is answered") stay green unchanged.

## 6. Left to the builder

- The staging directory layout and how a boot finds it (one dir, newest build).
- Which single place in `server.js` stamps interaction (a request-level hook
  before routing is the obvious one).

- Whether the heartbeat lives in `start()` or a small helper; whether one or
  two seams are needed. Exact log wording, keeping the `[update]` prefix.
- Whether `ERA_UPDATE_EVERY_MS` deserves a floor on devices.

## 7. Release

The operator's own hub must be restarted on the new build by hand (it runs
from a checkout, so the updater is off there) before `/presence` exists for
the devices to call; that restart is an explicit act, never a script's.


Unsigned patch (`release.sh v1.0.6 --patch`) under the signed v1.0.0
installer. Publishing waits for dad's word. The QA host needs the 10/16
repair helper after `qa.sh up` before the VM leg (see the 2026-10-19 plan's
retrospective) until the template is re-saved.
