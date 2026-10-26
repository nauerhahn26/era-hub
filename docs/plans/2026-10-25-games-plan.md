# Games implementation

Branch: `feat/games`. Worktree: `era-hub--wt-games`.
Design: [Games and Fashion Studio](../specs/2026-10-25-games-design.md).

The maintainer approved implementation of both existing-game access and the
Fashion Studio first playable loop. The selected art direction is polished
illustrated 2D. The initial research and review artifacts were supplied as
private Drive copies after local file links proved unsuitable on a phone.

## Implementation sequence

- [x] Reorient from the house router, development flow and current source.
- [x] Inspect sibling worktrees. Chat overlaps server and payload/gate files;
  YouTube overlaps the server. Keep Games changes isolated and review shared
  integration hunks before completion.
- [x] Record the accepted scope, evidence boundaries and access contract.
- [x] Write failing state and browser acceptance tests before app code. The
  browser/registry tests failed for the absent page/registry entry; state tests
  failed for the absent model module before implementation began.
- [x] Implement validated local state, bounded recovery, Four in a Row, and
  the attributed 2048 adaptation. The 21 state checks pass, including all win
  axes, draw recovery, computer ordering, seeded moves, invalid saves and
  transient pause reset on reload.
- [x] Implement Fashion Studio design, styling, collection and performance.
  The browser route creates three visibly different looks, reorders them and
  directs a show through commands. Replacement/removal identify the saved
  look being changed and wait for confirmation.
- [x] Produce and inspect coherent original artwork; retain editable garment
  layers and record provenance without private data. Original studio, theatre
  and garden illustrations complement an editable character rig. Prompts and
  source notes ship in `public/games/art/provenance.md`.
- [x] Integrate Games into the registry, shortcuts, icons, payload and gate.
  Registry and gate-stamp checks pass (16 tests). The gate already discovers
  all test suites; its busy-port guard now refuses an existing listener rather
  than stopping another session's process.
- [x] Verify touch/gaze parity, stationary rearm, tracking loss, Talk/return,
  hidden-tab interruption, restart/recovery and offline use in browser checks.
  No external requests are needed for local play. Actual tracker and speaker
  acceptance remain separate from simulated validity and audio fixtures.
- [x] Verify native and constrained layouts and reduced motion visually.
  Command labels remain 74 pixels at both logical viewports. Passive display
  fit exceptions are recorded in the usage guide. Normal-motion interruption
  retains the same animation node and progress.
- [x] Update usage documentation and record the implementation receipt.
- [x] Commit as the user and launch the full gate detached with a sentinel.
- [ ] Record the actual gate result and any physical acceptance limits.

## Acceptance and handoff

The delivered app must contain working local games and a complete fashion
creation-to-show route, with no placeholder child destinations. Confirm that
invalid saved data cannot inject markup or silently corrupt completed looks;
storage failure leaves the current session usable. A reset cannot bypass its
confirmation. Animation, speech, computer turns and music cannot mutate state
after leaving or pausing. Preserve explicit app selections on existing installs.

All code/tests are delegated to implementation agents; the overseer scopes,
reviews, coordinates and records evidence. Use existing browser tooling and
temporary test data. Never restart the live hub. A release or device delivery
requires the maintainer's separate instruction.

## Retrospective and validation receipt

The first implementation used several catalog values without a matching
visible treatment. Review found those gaps before acceptance; every offered
color, cut, pattern, detail and motif position now changes the delivered
preview. Long labels were shortened rather than reducing command text across
the app. Passive column numbers make Four in a Row's command-to-board mapping
visible even when the board and command widths differ.

Local state tests passed 21/21; focused audio checks passed 3/3 after red runs
for restored-show autoplay, delayed audio after interruption and volume-cap
application. Registry and gate-stamp checks passed 16/16. Browser checks passed
15/15, followed by a passing confirmation-target regression (16 checks total).
They cover all workspaces, catalog label fit, actual rendered changes, the
three-look route, fixed control identity, rearm/loss, normal-motion suspension
and recovery. The full gate result is recorded below when complete. The repository scan passed
with existing first-name/legacy-name warnings and no fatal findings; shell
syntax and whitespace checks passed.

The model and browser checks use the real shared dwell and doorbar code with
simulated tracker validity. Headless browser visibility fixtures dispatch the
runtime visibility handlers; they do not establish Windows foreground handoff.
Validated logical viewports are 1920×1080 and 1280×720, with reduced and normal
motion. Actual device calibration, physical reading comfort/zoom, synthetic
gaze audio unlock, speaker level and enjoyment remain physical acceptance.
Neither publishing nor device delivery has been performed.

Private phone previews of the functioning app were uploaded and read back as
PNG files with owner-only permissions. No external game profile was created;
hosted games remain partner references rather than redistributed content.

Implementation commit: `b5ec044`. A 37-second silent recording of actual UI
commands was also supplied as a private, verified phone-compatible video.
The first queued gate yielded voluntarily to a previously approved public
patch, before any Games tests were collected. Only this feature's verified
owned gate/waiter processes were stopped; its exit 143 records cancellation,
not a failed test. The replacement run's artifacts are
`/tmp/era-games-gate-20261025-requeued/gate.log`, `pid` and `exit`; the exit
sentinel is written only when the run finishes. Do not treat the focused
checks as a full-gate stamp. Never stop another worktree's run.

Reviewed fixture-only commit `fe2e9e7` was adopted as `783f083` before new gate
collection. It repairs an accepted-request disconnect and isolates a label
fixture's photos while strengthening missing-tile, runtime and cutoff checks.
It changes no app or runner behavior. Its focused red/green evidence is in
the testing-suite records; this full gate must validate the combined tree.

The complete clothing-file proof subsequently passed 35/35 with exit 0 in
420.499 seconds; its fixture SHA-256 matches the adopted file. The testing
coordinator then required synchronizing the preceding release's master changes
immediately before Games collection. The replacement waiting run was also
withdrawn intentionally (exit 143, no tests collected) to avoid starting before
that landing. Current verification state: waiting for the preceding release's
master landing, then sync, verify combined inputs and launch a fresh full gate.
There is currently no active Games gate. Preserve all Games acceptance checks.

Cumulative source preparation then merged the frozen preceding candidate
`0c771772831115f18e3facceaf9d53724ea56e2d` (tree
`7ce783af8015fb378d8fb829ce9a60683862ae77`), containing master `e75e16c`, Math
and Video. Three conflicts in the registry, app tests and development notes
retain both features. Games source, tests and artwork are byte-identical to
the initial implementation. Thirteen targeted suites passed 198/198 after
this merge. The app registry's fixed-port fixture had a free listener check
before/after its run; final acceptance still requires the isolated combined
full run. No other test processes were stopped. The isolated full command is
still awaiting the testing coordinator's validation and exact input tuple;
source preparation alone authorizes no landing, publication or device update.

The isolated pilot required owned symbol-provider fixtures. Updated frozen
candidate `28fc5beb71887d15090b8e8a4f450b011ca8b600` adds two optional server
URL seams with unchanged defaults, closed reader-test endpoints and three
provider regressions. Those three checks pass. A matching Board worktree
adopts fixture-only `cd841f3` as `fca7f91`; its tree
`2e0b35d7b910779628bb36df098062ec8fd916bb` matches the preceding candidate's
Board tree exactly. Its six pure model checks pass, and its app source is
unchanged. Fixed-port route checks remain for the isolated combined gate.
Use `ERA_WT_SUFFIX=--wt-games` so that gate sources the paired fixture worktree.
There is still no active Games gate pending the coordinator's pilot proof.

The coordinator approved the existing full gate in the host legacy lane on
port 8381 while the other full pilot remains in separate namespaces. The
preceding Video run exited green (132 suites) and landed as master `3f8655c`.
Games synchronized that actual master; the merge adds only the final Math
delivery receipt. No runtime or Games acceptance changes resulted.

Launch preconditions are a free legacy lock, clear selected fixed test ports
and at least 3 GiB available memory. Run with the matching worktree suffix and
explicit private test-data directory. Preserve all 142 selected suites (129
modern and 13 legacy). The frozen source tuple, runtime and inventory belong
in `/tmp/era-games-gate-20261026-8381/inputs.json`; the same directory holds the
owned `pid`, `gate.log` and completion `exit` sentinel. This is the ordinary
full gate with its genuine stamps; it grants no Games publication or delivery.

The first full attempt started at 00:36 UTC on 2026-10-26 from `f22ff9d`.
It was stopped intentionally after 58 suite passes and two Chat fixture
failures: gate rewriting changed an invalid live-port example into allowed
port 8381. Source fingerprints stayed unchanged; owned processes were
verified individually and stopped without group signals or other-job changes.
Exit 143 is cancellation, and no green stamp was issued.

The corrected frozen predecessor `228b5b3220148f9de331c1319d63048595268067`
constructs the real protected port without a rewriteable literal. Both full
Chat test files pass 48/48 after actual gate rewriting at both 8381 and 8388.
It also carries the independently validated Music local-provider fixture
(12/12) and Reader rendered-shelf readiness fixture (17/17). All four fixture
blobs match the owner commit; application code and every Games acceptance
check remain unchanged. A fresh complete 142-suite run is required. Retry
artifacts belong in `/tmp/era-games-gate-20261026-8381-retry/`.
