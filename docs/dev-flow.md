# era-hub dev flow — worktrees, releases, push-to-device

House law lives in `aac-board-builder/docs/parallel-worktrees.md`; this page is
the era-hub half, so a fresh session here isn't blind to it. Design record:
`docs/specs/2026-09-15-dev-flow-worktrees-and-patch-releases-design.md`.

## The routine

Every feature gets its own worktree on its own branch; master is only ever
merged into, never edited. Dad says **"new feature: <name>"** in a chat opened in
the main checkout `~/new-era/era-hub`, and the session runs
(`W=~/aac-board-builder/tools/worktree.sh`):

```
bash $W open ~/new-era/era-hub <slug> [--fix]
EnterWorktree path=~/new-era/era-hub--wt-<slug>
```

Then `bash $W sync|land|close ~/new-era/era-hub <slug>` for "sync" /
"land it" / "close it". `land` wants a green era-gate stamp for the branch's tree
(`$ERA_GATE_STAMPS/<tree-sha>`, default `/tmp/era-gate-green/`, under 2 h old, no
`dirty=1`) — run `bash tools/era-gate.sh` in the worktree first. It never
restarts live 8377; that stays an explicit act in the main checkout.
Ports: `ERA_TEST_PORT` 8380-8389 for manual hubs, 8480+ scratch, 8500+ tunnels,
never 8377/8378/8425/8427/8450-8462. Refusal messages → fixes are tabled in the
aac-board-builder doc.
The gate refuses an occupied test port without stopping its listener. Choose
another test port or have the session that started that listener stop its own PID.

A feature that spans repos keeps one worktree per repo, all on the same slug
(`<repo>--wt-<slug>`), and `ERA_WT_SUFFIX=--wt-<slug>` is what makes
`assemble.sh`, `era-gate.sh` and `build-payload.sh` reach into them instead of
the main checkouts — per repo, falling back to `$ROOT/<repo>` for any repo the
feature doesn't touch. A green gate then stamps the hub's tree **and** every
sibling worktree tree it sourced (each with its own `dirty=1` verdict), so
`worktree.sh land` accepts each repo in turn; land in dependency order, in one
sitting while the 2 h stamps hold: era-core → era-board → era-making-words →
era-pencil → era-gaze → era-hub, and never restart the live 8377 hub in between.

Symbol-provider tests use `ERA_SYMBOL_SEARCH_URL` and `ERA_SYMBOL_IMAGE_URL`
to point the hub at an owned local service. The image template replaces `{id}`;
normal installations retain the existing public-service defaults. The board
route suite owns its data and provider so a complete gate can exercise cache
misses without external network access. Standalone board routes must name the
selected hub with `ERA_HUB_SRC`; matching feature worktrees retain the source
selection rules above.

## The gate runs in lanes; focused runs for the dev loop

Since 2026-10-26 `era-gate.sh` runs the frozen suites two at a time
(`ERA_GATE_LANES`, default 2; `ERA_GATE_LANES=1` is the old serial loop byte for
byte). The scheduler (`tools/testing/lanes.mjs`) starts the longest known suite
first and keeps apart what cannot share the host: solo suites run alone, two
heavy suites never overlap, a quiet suite never sits beside a heavy one, and two
claimants of one fixed port (the gaze engine's bus 49155 included) never run
together. Under 2 GiB of free memory a lane holds; the last running lane never
does. The classes live in `tools/testing/registry.json`, written by
`node tools/testing/classify-suites.mjs` from the suite sources (re-run it after
a sync; `tests/suite-classes.test.mjs` fails the gate when they drift).
Measured 10/26: 164 suites, 14 min 10 s at two lanes, 26 min 39 s serial after
the same day's suite speedups, 33 min before them. A TERM to the gate's pid now
stops every suite within seconds. Each gate leaves `gate/results.jsonl`, one
line per suite with its lane and seconds.

Gates no longer lock each other out (10/27). Each gate re-executes itself in a
private network namespace (loopback plus a test link, no route out, no
capabilities), so its 8378 hub and every suite's fixed port are its own, and it
starts when admitted: fewer than `ERA_GATE_MAX_GATES` (default 2) other gates
running, none in the same checkout, and `MemAvailable` of 1 GiB per lane plus
1 GiB (with room for one lane only it runs one lane and says so). Otherwise it
waits and prints `== era-gate: waiting for a slot: N gates running, M GiB free
(why) ==` once a minute; a gate admitted under 2 minutes ago has its lanes'
memory set aside first, since it has not reached its peak. Running gates are
files in `/tmp/era-gate-slots/<pid>`, and a job of the isolated runner holds one
too, so it counts. An admitted gate holds `/tmp/era-gate.lock` shared; a gate
that cannot unshare says so and falls back to holding it exclusively (it waits
for every other gate and runs alone), and so does every branch whose
`era-gate.sh` predates this: sync master before gating beside other sessions.
A running gate's hub and suite ports live in that gate's network namespace; to
reach them from a shell, as the same user, run
`nsenter --user --net --preserve-credentials -t <gate pid> curl -s http://127.0.0.1:8378/settings`
(the gate pid is its file name in `/tmp/era-gate-slots`; without
`--preserve-credentials` nsenter tries to become root inside and stops at
"setgroups failed").

Stand-in providers never wait: the clothing worker's 5 s photo spacing and 3 s
retry gap are 0 when `ERA_AI_URL` names this machine (there is no real provider
to protect) and unchanged for every family hub; no environment variable can
change them (`tests/clothing-pacing.test.mjs`).

For the dev loop, run only what a change touches, with no stamp:

```
node tools/test-suite.mjs plan --base master            # which suites, and why
node tools/test-suite.mjs queue --affected --base master # run them, in series, through gate admission
node tools/test-suite.mjs status                        # jobs under ~/.local/state/era-tests/
```

A change to `server.js`, shared runtime or tooling expands to the complete set;
landing still wants the full gate's stamp.

## Recovering from a red gate: reuse, FLAKY, rerun-failed, restamp

Since 2026-10-27 a full gate records every run under `$ERA_GATE_RUNS` (default
`~/.local/state/era-gate-runs`) and keys each suite by what it can observe:
product files by content (not `tests/` or `docs/`), the private scanner, every
collected helper and fixture, the gate's own code, node, playwright and its
chromium, the suites' environment, the suite's collected copy and its registry
entry (`reuse: key = ...` prints the parts). A suite whose key holds a pass
under 24 h old prints `REUSE X (from <run> at <time>)` instead of running;
`reuse: to run, <why>: ...` says why the rest run. Any product change reruns
everything, a helper or fixture change reruns everything, a fixed test reruns
that suite, a docs-only change (`docs/`, or a repo root's `*.md`) reruns
nothing. The summary line counts reused passes, the stamp keeps its four
lines, and the `receipt:` line just before the summary names how many were
reused, the oldest evidence and the run's `receipt.json`.

One failed suite runs once more, alone, at the end: a pass is `FLAKY X (passed
on retry)`, counts for the stamp, goes to `$ERA_GATE_RUNS/flakes.jsonl`, and is
never reused. No retry (a `retry:` line says why) for a resource failure
(timeout, killed, out of memory, EADDRINUSE), a suite that already failed on
the same key, or a gate with more than one failure. Twice failed on one key, a
suite is refused without running until it or what it tests changes.

| After | Run | Runs |
| --- | --- | --- |
| a wrong fixture or test, now fixed | `bash tools/era-gate.sh` | that suite (a helper: all) |
| a failure with nothing changed | `bash tools/era-gate.sh --rerun-failed latest` | what failed or never finished there |
| a gate that died half way | `bash tools/era-gate.sh` | what did not pass (shared readers rerun) |
| a stamp that expired, nothing changed | `bash tools/era-gate.sh --restamp latest` | nothing; no hub; under a minute |
| the dev loop | `bash tools/era-gate.sh --only lanes,gate-reuse` | those suites; no stamp, no store |

`--rerun-failed` refuses when a suite that passed in that run can no longer be
reused; `--restamp` refuses unless every suite can; both say which and why.
`--no-cache` runs everything fresh and reads no earlier run. The isolated
runner has no writable home: its gates say so and run fresh, without retries.

## The three release shapes

A dist lives at `~/new-era/dist/release-<V>/` (sibling of the
checkout) — that is also where a `--dry-run` leaves its artefacts.

### Patch — `bash tools/release.sh vX.Y.Z --patch` (Z ≥ 1)

No SimplySign, nothing for dad to type. Four steps:

```
1/4 gate     era-gate fully green
2/4 build    build-dist.sh --patch: payload, tarball, zip, checksums, latest.json.
             NO makensis — the signed installer named by the LIVE latest.json
             (`installer` = its tag, `installer_file` = its file name) is
             downloaded and re-attached under that name, its Authenticode
             signature verified with osslsigncode first.
             X.Y must match that installer's ("patch $V cannot carry installer
             $TAG — cut a signed ${V%.*}.0 first").
3/4 VM e2e   vm-e2e.sh $DIST --only b — that installer fresh on the VM, self-
             updating to the candidate tarball: the only path a patch takes on
             any device.
4/4 publish  tag + gh release create with the six assets; the notes name the
             installer's tag.
```

The website keeps serving the previous signed installer; installed copies pick
up the new tarball on their next check.

### Signed — `bash tools/release.sh vX.Y.0`

```
1/5 gate     era-gate.sh --no-cache: every suite fresh, nothing reused
2/5 build    build-dist.sh --unsigned: same payload, plus an UNSIGNED Setup.exe
3/5 VM e2e   legs A + B on those very files (neither leg reads a signature)
4/5 sign     "VM green — ready for the SimplySign code (stage it now)."
             sign-installer.sh --check must pass, then build-dist.sh --sign-only
             re-cuts the installer WITH -DSIGN over the same payload and verifies
5/5 publish  tag + release, THEN leg C (vm-e2e.sh --post-publish) against the
             real download URL
```

A red leg C prints `LEG C RED — PULL THE RELEASE: gh release delete $V --repo
$REPO --yes` (re-attach the previous installer first if the website must stay
up) and exits 1. It deletes nothing itself — a pulled release 404s the website,
so a human decides.

### The installer's name (9/26 rename)

A signed cut builds `Our-Era-Comms-Setup.exe` (it was `New-ERA-Setup.exe` up to
v0.35.x); every other asset name — `new-era-suite.tar.gz`,
`new-era-suite-$V.tar.gz`, `new-era-suite.zip`, `latest.json`, `checksums.txt`
and the tarball's `new-era-suite/` top folder — never changes, because installed
hubs fetch them by name. So `latest.json` records the installer's file name as
`installer_file` next to its tag (`installer`), and everything that needs the
installer reads it from there: `--patch` downloads and re-attaches it by that
name, release.sh attaches it, vm-e2e.sh installs the candidate and finds each
previous cut's exe by it, and leg C expects the website to hand out exactly it.
A latest.json without the field predates the rename and means
`New-ERA-Setup.exe`. A signed cut also downloads the live installer into
`$DIST/prev/`: leg B starts from it, and while it is the old `New-ERA-Setup.exe`
leg A installs it and runs the candidate over it (the `.onInit` folder move to
`%LOCALAPPDATA%\Our Era Comms`, a junction left at `New ERA`, one Apps entry).
The website's download buttons must name the new exe the day it publishes; for
that one release the old name keeps working anyway: when the live feed's
`installer_file` (absent: `New-ERA-Setup.exe`) differs from the cut's, release.sh
(signed shape) attaches the same signed exe a second time under the old name,
lists both in checksums.txt and says so in the notes, while latest.json names
only the new file.

### Flags

- `--dry-run` — both shapes: stop after the VM, publish nothing. Signed stops
  before the code is ever wanted, leaving an unsigned exe in `$DIST`.
- `--skip-gate` — re-cut past a green gate (lapsed login, starved VM host). Reads
  the same green stamp as `land`; a `dirty=1` stamp is refused outright. It skips
  the gate and nothing else — the build and the VM legs run again (~15 min).
- `--resume-sign` — signed only, when the SimplySign code died under you:
  re-enters at 4/5 over the dist the VM already drove (checks the stamp, that
  `$DIST/TREE` is this HEAD's tree, and that the tarball still matches
  latest.json's sha256).
- `--prerelease` — hidden from the website and the updater; legal with `--patch`.

## The VM legs run on an on-demand QA host

Since 2026-10-05 the Windows QA host exists only while a VM leg runs:
`vm-e2e.sh` brings it up from a template snapshot (`era-family/tools/vm/qa.sh up`)
and destroys it on exit; `release.sh` holds one host across all of a cut's legs
(`QA_KEEP=1`) and destroys it in its EXIT trap. Expect a few minutes of server
creation before a VM leg starts. Details, the reaper cron and how to change the
template: `aac-board-builder/docs/vm-e2e.md`.

The legs drive one of two guest profiles (`vm-e2e.sh --profile`):

- **`full`**: the template's pristine snapshot, Defender on, with its
  post-restore signature update and scan waited out (about 7 minutes). Every
  signed cut drives it for legs A, B and C.
- **`quiet`**: a separately named snapshot with Defender and Windows Update off,
  where a readiness check of at most 2 minutes replaces the wait. `release.sh
  --patch` drives it, because a patch ships no installer.

`release.sh --vm-profile=full|quiet` overrides the shape's default, but a signed
cut takes `quiet` only on a `--dry-run`. `VM-GREEN` records `profile=`, and the
signed publish and `--resume-sign` accept only `full`. The quiet snapshot and how
to remake it: the runbook above. `tests-vm/lib/guest-profile.mjs` says why it is a
snapshot rather than a switch.

## Push to one device

```
bash tools/push-device.sh <host> <dist-dir> [--dry-run]
```

`<host>` is an ssh alias (`i13`, `tablet`, `school-i13`). It serves `<dist-dir>`
on a loopback-only `python3 -m http.server`, opens ONE ssh session with `-R` (so
the device can fetch our feed) and `-L` (so we can reach the device's hub on
127.0.0.1:8377), POSTs `{"feed":"http://127.0.0.1:<R>"}` to `/update/check`, and
polls `/version` until the new build is live (90 s). Nothing is published.

It refuses before opening anything when: the ssh alias is unknown; the dist lacks
`latest.json` / `new-era-suite.tar.gz` / `checksums.txt`; the tarball's sha256
does not match `latest.json`; the dist's tree has no green stamp under 2 h (or it
is `dirty=1`); no free port in 8480-8499 / 8500-8599 outside the forbidden
8377-8462 band; the device can't reach the feed through `-R`; or the device is
already on a build ≥ the dist's — **the device never downgrades** (the updater
only moves when the feed's `build` stamp sorts strictly after the installed one).

**Loopback rule:** the hub honours a `{feed}` override only when the request's
socket peer is the machine itself, which is why the POST goes through `-L`. The
route is ungated and reachable on the LAN; an unrestricted override would let
anyone on a school network install code on the Tobii. Never loosen it.

**Chicken-and-egg:** a device honours the override only once it runs a hub
carrying that change, so the first delivery of it is a normal release (patch or
signed); an older hub ignores the body and the script says so plainly.
**App packs still come from the public feed** (`server.js` downloads packs from
`updater.FEED`) — only the suite tarball comes from the pushed dist.

## Alternative Pencil dwell

The Pencil has an independent `pencilDwellMs` setting (default 1500 ms,
600–3000 ms). Settings → Alternative Pencil dwell time saves it for the next
Pencil opening. Other apps continue using `dwellMs`. The Pencil partner strip's
dwell buttons also save this value; its exit and talk doors remain twice its
current dwell. Predicted words retain their existing 2000 ms hold.

## Overlay rendering regression

Gaze engine changes can use `era-gaze--wt-<slug>` too: payload source, gate
contracts and gate stamps follow `ERA_WT_SUFFIX`. Run the gaze repo's
`tests/overlay-regression.ps1` on an interactive Windows desktop when changing
overlays; it verifies drawing, hiding, GDI resource stability and recovery from
conversion failure. A responding gaze `/status` alone does not detect a modal
WinForms error that has blocked the UI timer.

## Clothing page layout

The approved [clothing page 1 layout](specs/2026-10-17-clothing-page-1.md)
uses eight outfit slots first, then seven beside Back. Weather spans the center
pair; Full wardrobe replaces Build my own, and Accessories lives inside it.
Shipped in v1.0.3 across era-hub and era-board. Future changes to both repos
use matching feature worktrees and `ERA_WT_SUFFIX` as described above.

## Per-device speaker limit

Settings → Voice & sound → Voice also has Response voice speed on this device
(70–120%, default 80%). Save on the device being adjusted, then reopen the app
to refresh cached speech. The preference stays in that hub's local settings;
Drive does not synchronize it. This adjusts premium active responses across
apps; recorded books, songs and the built-in computer voice keep their pace.

Settings → Volume cap for this device saves On/Off and a whole percentage
(0–100, default 45) to the local gaze engine through `/volcap`
(`deviceEnabled`, `deviceCap`). Open Settings on the device being adjusted.
Both the mode and percentage persist across restarts. Raising the cap does not
raise current volume. Music volume cap remains the separate shared music setting.
New devices retain the engine's opt-in behavior; their initial cap value is 45.

On the first explicit save, the engine neutralizes the legacy watchdog's saved
ceiling (`CAP=100`) and stops only its known executable. A scheduled restart
therefore cannot reimpose 45 or undo Off. The integrated engine owns the saved
limit afterward. Older Settings clients keep their existing endpoint fields.
The new control requires an updated local engine and verifies its reply before
reporting success. Windows regression: `era-gaze/tests/volume-cap-regression.ps1`.

## Settings navigation

Settings now has a persistent section list: Eye gaze, Voice & sound, Apps &
navigation, Books, Clothing & weather, Writing & media, Connections and System.
Search finds named controls across sections. Narrow windows use an Open sections
button; keyboard users can jump to search with Ctrl+K.

Books has Library, Build activity and Book setup views. Library search, status
filters and six-row pages keep a growing collection separate from device controls.
View opens the existing review, rename, build and recovery actions. Readable books
with uncertain words also appear under Needs review. Saved writing is paged too.

Service setup lives in Connections; feature pages link to the relevant form.
Weather place and hours are in Clothing & weather. Temporary gaze pause is in
Eye gaze, while complete stop and restart guidance are in System.

Old links such as `/settings/#content` and `/settings/#integrations` still reveal
their destinations. New links can use `/settings/#books`, `#books/activity`,
`#books/setup`, `#clothing`, or `#connections/drive`. Preferences stay on the
computer being adjusted; Drive content sharing does not synchronize these settings.
The existing Reader dwell mirror is unchanged. Opening or navigating Settings
does not save a preference or start a content sync. Explicit actions and the hub's
background work retain their existing behavior.

Design and acceptance checks: [settings upgrade](specs/2026-10-22-settings-upgrade-design.md).

## Song page pictures

The song image fills the first three columns; Back, Stop and Full song fill
the fourth. During playback, a completed dwell on the image advances one of
ten screened video stills without changing the song. The normal move-to-rearm
rule applies. Images are cached for offline use. New song adds request pictures
automatically when an AI helper is configured; missing or unapproved pictures
leave cover art available. The touch-only Pictures panel reviews a song's set,
gets pictures for older songs, or returns to cover art. Details and source
resolution limits: [song page design](specs/2026-10-25-music-player-ux-recruitment.md).

## Math

Math is a core app at `/math/`: Numbers explores 0–50, and Number partners
keeps a whole within 20 while one object moves between its parts. Large
commands handle all movement; the quantities themselves are passive.
Existing explicit app selections are preserved, so enable Math in Settings
when it is not already listed on the home screen. State stays local to each
computer. Usage and access behavior: [Math](math.md).

## Games

Games is a core app at `/games/`, with Fashion Studio, Four in a Row and
Number Tiles. Fashion Studio keeps editable local looks and a runway show;
both board games use commands around passive boards.
The partner panel contains hosted-game references and local source credits.
Existing explicit app selections are preserved, so enable Games in Settings
when it is absent from the home screen. State and recovery stay in the local
browser. Usage and access behavior: [Games](games.md).

## Experimental Chat

Chat is an optional app at `/chat/`, disabled by default and sharing the Board
pack's portable speech activity runtime. A configured installed Node worker
transcribes a partner's held question after release; optional contextual choices
run through the hub. Service credentials stay in the operating account's private
configuration file. Gates disable private configuration loading. Setup, cloud
data boundaries and current acceptance limits: [Chat](chat.md).

## Gaze engine supervision

When ERAgaze is enabled and the hub's own build is compiled, the hub polls the
engine's bus (`127.0.0.1:49155/status`) every 10 s. Silent for 30 s after a
60 s boot grace, the hub stops its own build by path and starts it again, then
backs off 30 → 60 → 120 → 300 → 600 s while it stays silent; two minutes of
answers reset the ladder. `GET /status` shows `gaze.state`, `restarts`,
`nextRetry` and `stoppedOnPurpose`. Settings' "Stop ERAgaze completely" goes
through `POST /gaze/stop` (loopback only), which writes `<DATA>/gaze-stopped.json`
and holds the supervisor off until `POST /gaze/start` ("Start ERAgaze again"),
the engine reappears by hand, or eight hours pass; the marker survives a hub
restart. Turning the engine off in the apps list is simply unsupervised. The
engine side (era-gaze `StartBus()`) retries a failed bus bind instead of running
deaf. Design: [gaze engine supervisor](specs/2026-10-26-gaze-engine-supervisor-design.md).
