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
- [ ] Commit as the user and run the full gate detached with a sentinel.
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
