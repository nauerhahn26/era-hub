# The hub survives a reboot — design

Date: 2026-10-19. Unit of work on branch `fix/weather`. Follows the 2026-09-23
weather-location design (§7, the three-rung ladder) and the 2026-09-26 rename
design (R1, the shortcut boot pass).

## 1. Intent and why

On Wed 2026-10-14 at 02:35 a Windows security update rebooted the family's
tablet. The hub died with the reboot and nothing started it again: the hub has
never had a logon start (rename design R1: "an engine (exe) also starts at
logon; a page app never does"), it is started on demand by a TD Snap tile's
launcher batch file. No tile was tapped on that device for two days. On Friday
morning the tile was tapped, the launcher started the hub, and the first thing
on her screen was the standing board file — dealt the previous Tuesday, with
Tuesday's weather and the honest footnote "updated Tue". Twenty seconds later
the hub's startup build fetched fresh weather and rewrote the board; the page
took its usual idle-guarded reload cycle (poll every 5 min, reload when idle a
minute) to show it. Dad saw "weather from Tuesday" and then the right board
"maybe 15 minutes later".

The weather ladder worked. The problem is that a reboot leaves the hub dead
until a human taps a tile, so every reboot produces a stale first board and two
dead days of no Drive mirror, no morning build, no video fetch, no book sync.
The same gap has bitten the home i13 (2026-09-15: "rebooted and sat dark") and
the school i13.

Dad's decision (2026-10-19): "do hub survives reboot".

## 2. Goals, non-goals, anti-goals

Goals
- After any reboot, once her account is logged on, the hub is running within a
  minute with no one touching a tile.
- The hub starts QUIETLY: no page, no kiosk window, no console. TD Snap owns
  the screen at logon exactly as today.
- A tile tap after the hub is already up behaves exactly as today (the
  launcher's "already running? just open the page" branch).
- Every device gets this through the normal self-update, with no installer
  run and no hands on the device: the hub's own boot pass lays the link.
- A stored-week ("rung 3") weather answer no longer stands all day once the
  network is back (Part B, the overseer's call — see §5).

Non-goals
- Windows auto-logon. If a device does not log her account on by itself after
  a reboot, the hub starts at the first logon; that is still before any tile
  tap. Configuring auto-logon is a device runbook matter, not this unit.
- Making the hub a Windows service, or running it outside her session. The
  hub must run IN her session (it launches Drive for Desktop there; see the
  2026-10-08 family-photos work).
- Reloading the board page faster after a build. The idle-guarded reload is
  deliberate (pause-to-talk, 2026-09-17) and stays.

Anti-goals (a failure even if it "works")
- A console window, a flash of a browser, or the home page opening at logon.
- Two hubs on the port, or a hub fighting the updater's own restart.
- PowerShell invoked from anything in the payload (the 2026-08-29 Defender law;
  `tests/start-hub-bat.test.mjs` pins it). The hub may run PowerShell from
  Node as it does today for every other link.
- A link that survives uninstall. Both uninstallers already delete
  `Startup\Our Era Comms.lnk` (installer.nsi SecCore, UNINSTALL.bat sweep), so
  the name below is the one they already expect.

## 3. Constraints

- The payload ships no PowerShell. Links are written by `shortcuts.js` from
  the running hub, one PowerShell per boot pass, `windowsHide`.
- The launcher is `start-hub.bat`, authored inside `tools/build-payload.sh`
  and tested from that text by `tests/start-hub-bat.test.mjs`. It already has
  an "already running" guard (`curl /settings`, 2 s) ahead of the node start.
- `shortcuts.test.mjs` pins the plan: the home door on Desktop + Start Menu
  and NEVER Startup; the engine on all three. That law stands; the new link is
  not the home door.
- The hub daemonizes itself on Windows (server.js: re-spawn hidden, parent
  exits), and the updater restarts it with `node server.js <port>` directly.
  Neither path goes through the launcher, so the launcher change below cannot
  interfere with them.
- Vendor-neutral code, docs and commits. No family names (Ellie excepted),
  towns, IPs or device identifiers in this repo.
- Unsigned patch release under the signed v1.0.0 installer; the devices pick
  it up by self-update and the restarted hub's boot pass lays the link.

## 4. Part A — the logon start (decided)

### 4.1 The launcher gets a hub-only mode

`start-hub.bat <port> --hub-only`: start the hub if it is not already up and
open NOTHING. Concretely, in `tools/build-payload.sh`'s heredoc:

- `--hub-only` is recognised from `%~2` right after the port is set. Spelling
  is the builder's call; the test must pin whatever is chosen, exactly.
- With the flag, the file runs the existing "already running?" guard and the
  existing node start, then jumps to `:done`. It never reaches the kiosk
  resume POST, the wmic kiosk kill, or the browser launch. The branch sits
  right after the `:open` label (before the `/kiosk/resume` curl), because
  the already-running guard jumps straight to `:open` and a hub-only run with
  the hub already up must exit there too. (The wmic line
  terminating a kiosk at logon would be a visible anti-goal on its own: at
  logon there is no kiosk, but a hub-only run at any other time must not
  close the window she is using.)
- Nothing else in the file changes. The default page `/home/` and the quoted
  page handling (T7.6b) stay.
- Laws pinned by the test: the flag branch sits AFTER the `:open` label
  and BEFORE the first `curl ... /kiosk/resume`; a hub-only run contains no
  `--kiosk`, no `wmic` on its path (static check on the bat text is enough:
  the goto target is `:done`); still no PowerShell anywhere.

### 4.2 The boot pass lays a Startup link for the hub

In `shortcuts.js`, `reconcileShortcuts` adds one owned link beside the home
door:

- Path `Startup\<homeTitle>.lnk` — i.e. `Startup\Our Era Comms.lnk` (the name
  both uninstallers already delete).
- Target `<dir>\start-hub.bat`, arguments `<port> --hub-only`, working
  directory `<dir>`, the suite icon, `WindowStyle = 7` like every other link.
- It is rewritten every boot pass (folder moves, renames) like the rest. It
  is not a per-app toggle; it exists whenever the home door does. TWO write
  sites produce it, because the boot pass is deferred until the wizard has
  been answered (`server.js`: no profile → no boot pass) and the wizard lays
  the home door itself through `applyShortcut(home, true)`: the home door's
  own script (`shortcutScript` for the `/home/` entry) writes the Startup
  hub link in the same PowerShell, so the wizard path and the boot pass both
  lay it, and a fresh install has it before its first reboot. Turning the
  home door off (if any path ever does) removes it the same way.
- The plan entry carries `action: "write"`, the same shape as the others, so
  the `[apps] shortcuts reconciled (N links)` count rises by one.
- `dirsFor()` keeps its meaning for apps. The hub link is a third kind, not a
  change to what "exe" or "page app" mean. The builder decides the shape (a
  flag on the owned entry, or a separate small function) — the test pins the
  plan, not the shape.

Tests (`tests/shortcuts.test.mjs`):
- The dry-run plan contains exactly one Startup entry for the hub, target
  `start-hub.bat`, and the script sets its arguments to `'<port> --hub-only'`.
- The home door still has exactly Desktop + Start Menu. (The existing test
  selects the home door by file name, which the Startup link now shares:
  the selection must exclude `Startup\` or match on arguments.)
- `shortcutScript(home, true)` — the wizard path — writes the Startup hub
  link too; `shortcutScript(home, false)` removes it.
- The old-name deletion set is unchanged.
- The single-PowerShell-per-pass and off-Windows-runs-nothing laws still hold.

### 4.3 What happens on a device

1. Self-update lands the patch; the updater restarts the hub.
2. The restarted hub's boot pass writes `Startup\Our Era Comms.lnk`.
3. On the next reboot + logon, Windows runs the link: the launcher sees no hub,
   starts node minimized, node re-spawns itself hidden and the console exits;
   the launcher exits at `:done`. Twenty seconds later the hub's startup tick
   builds the day's board with weather; Drive, books and videos resume on
   their own timers.
4. A tile tap later finds the hub up and opens its page as today.

Battery: Startup-folder links run on battery (scheduled tasks do not by
default; that is why this is a link, not a task — see the 2026-09-03 schtasks
finding).

### 4.4 Verification on a real device (overseer, after the patch is on it)

- `Startup\Our Era Comms.lnk` exists; its target, arguments and working
  directory read as §4.2.
- Running the link's command by hand while the hub is up: the hub's pid is
  unchanged afterwards, no browser window opened, the launcher exited.
- The link must land in HER profile's Startup folder: `GetFolderPath('Startup')`
  is the account the hub runs under, so the by-hand check also confirms the
  hub's node process is owned by her account (on the home devices it is: the
  tile launcher and the updater both run in her session) and that the link
  sits under her user profile, not the maintenance account's.
- A true reboot test is dad's to schedule. The VM legs are the automated
  proof that the link gets laid: leg A (fresh install, wizard path) and leg B
  (self-update, boot pass) both assert `Startup\Our Era Comms.lnk` with the
  `--hub-only` arguments — leg A already reads .lnk files on the guest, so it
  is cheap.

## 5. Part B — a stored-week answer is still "blind" (overseer's call)

Why it belongs here: a logon start races Wi-Fi. If the startup build runs
before the network is back, both providers fail and rung 3 answers from the
stored week — up to six days old — and today that counts as weather found:
`weatherBlind` stays false and the board stands all day on old numbers. The
logon start makes that race common. Part B ships in this unit's patch
unless dad drops it: one branch, one gate, one release.

Decided shape:
- `clothing-worker.js weather()` marks a rung-3 answer: the object it returns
  carries `stale: true` when the answer came from the stored week after both
  providers failed. A fresh fetch or an under-3-hours store is not stale.
- The build result reports `weatherStale: true` beside the existing
  `weatherless` when the deal used a stale answer. A weather retry (the
  `weatherRetry` build) that gets a stale answer again does NOT redraw and
  returns `{ rebuildOnly: true, weatherStale: true, retried: true }`, exactly
  as the weatherless retry does today.
- `clothing.js` sets `weatherBlind` when the build reports EITHER
  `weatherless` or `weatherStale`; the existing 14-minute retry
  (`ERA_WEATHER_RETRY_MS`) walks the ladder again, zero AI calls, until a
  provider answers and the board is re-dealt on fresh numbers.
- The footnote is untouched: it already says the fetch time.

Tests (`tests/weather-location.test.mjs`, where the ladder, both provider
fakes (`ERA_WEATHER_URL` + `ERA_NWS_URL`), the stored-week fixtures and the
`ERA_WEATHER_RETRY_MS` spacing tests already live; the existing "both fail,
the store covers today" case is where `weatherStale` is asserted):
- Both providers down, a stored week that covers today → the board deals from
  the store, the result reports `weatherStale`, and the next retry tick walks
  the ladder.
- Providers come back → the retry re-deals, the store is rewritten, the flag
  clears (`weatherBlind` false; the retry spacing law from §7.3 of the
  weather-location design holds).
- A store under 3 h old is served without a fetch and is NOT stale.

## 6. Left to the builder

- The flag token in the launcher and the owned-entry shape in `shortcuts.js`.
- Whether leg B can assert the Startup link cheaply.
- Exact log wording; keep the existing `[clothing] weather: …` lines.

## 7. Release

Unsigned patch (v1.0.5 or the next free Z) under the signed v1.0.0 installer,
`release.sh vX.Y.Z --patch`; then the home devices by self-update, a by-hand
check of the link on the tablet. Publishing waits for dad's word.
