# Tic-tac-toe delivery

Design record is [Tic-tac-toe in Games](../specs/2026-11-08-tic-tac-toe-design.md).
The maintainer authorized implementation, testing and publication on 2026-11-08.
Worktree is `era-hub--wt-games`, branch `feat/games`.

## Starting state

The original Games release was v1.0.17. Production at kickoff was v1.1.2.
The Games worktree was fast-forwarded to current Hub master `7b9e589`.
Matching Core and Board worktrees were synchronized and have the same content
as their main checkouts. The older `games-g2` worktree is separate historical
work and must not supply this release. Other active feature worktrees remain
independent. No sibling runtime change is planned for tic-tac-toe.

## Implementation and acceptance

- [x] Rules and model tests failed before implementation, with eight new rule
      cases failing and 21 existing cases passing. The new menu assertion and
      Windows helper import also failed before their implementations.
- [x] Rules, computer moves, Undo, confirmations and strict save validation pass.
      State tests pass 30/30, including every one of the 19,683 possible boards
      compared with an independent set of 5,478 legal boards in both modes.
- [x] Existing saves migrate without losing the other three workspaces.
      Save tests pass 10/10, including legacy browser and durable-file migration
      and fresh browser storage with a restarted hub.
- [x] Four-choice menu and nine stable square controls pass browser journeys.
- [x] Shared dwell, Talk, hiding, app lock and native-size layout pass.
      Games UI and audio pass 26/26. Final layout checks pass at 1280×720,
      1280×800 and 1920×1080. Root reviewed the menu and game screenshots.
      Tests exposed and fixed save-status overlap and a pending computer turn
      failing to resume after unlocking.
- [x] Installed Windows journey is implemented for all four games and a complete
      browser restart, after existing leg-B cases and before shutdown. Local
      acceptance-contract and geometry checks pass 10/10. The actual Windows run
      passes all 14 cases, with no failures, cancellations, skips or todos.
      Both original and restarted kiosks measure 1280×800 at scale and DPR 1.
      The Talk timing subcase invokes the real square and shared Talk handlers
      in one browser task with a mocked acknowledgment and observes the real
      timer for 900 ms. Physical gaze is untested.
- [x] Documentation, test registry and source review are complete.
- [x] Complete integration gate is green on the committed candidate.
      Final source `513a79d` and tree `ae98de8` pass 208/208 suites, all fresh.
      An earlier complete 208-suite run also passed before the Windows timing
      test correction. Original stamps and receipts are retained.
- [x] Patch artifacts are built once and qualified by the full Windows baseline
      and Games journey, with original evidence and cleanup retained.
      All 280 regular payload files agree across the tarball, zip and unpacked
      directory. All eight built artifact files retain their recorded hashes.
      The same hub and data restore all four workspaces after every browser
      process and its debugger endpoint disappear, followed by a new browser
      process, creation time and debugger identity. App selection is restored.
      The temporary QA host is destroyed with no remaining lease.
- [x] Gate-qualified source is merged and pushed through the normal landing rail.
      Runtime master is `b8a1f26`, with the same tree as the tested source.
- [x] Authorized release is published and public assets and update feed are read back.
      All six public assets match their tested hashes. The normal latest feed
      returns the same version, build and tarball hash. The new source tag
      names the exact built commit.

## Delivery receipt

Published v1.1.3, build `20261108.2140`, on 2026-11-08. Tic-tac-toe is the
first menu choice in Games alongside the three existing games. Existing
explicit app selections are preserved. Enable Games in Settings when absent.
[Public release](https://github.com/nauerhahn26/new-era-releases/releases/tag/v1.1.3).

The selected cached Windows runtime has the same bytes as production v1.1.2.
Its existing private cache modification is retained. The patch carries the
verified signed v1.1.0 installer. The standard release dry run built the patch
once and ran the complete Windows journey. Publication used the reviewed
existing files and a new source tag.

The stable and versioned tarballs have SHA-256
`e11c6f61d6336ba37cae0ae5d35946353374b4a18924e8df6b6557982d89fd29`.
The private evidence directory is
`~/.local/state/era-games-releases/tictactoe-20261108/`. Its `proof.tar.gz`
contains 603 files and has SHA-256
`871f406be4497cf7e15fbcae593113ad72d020703b097c4901faf79162eab884`.
Every archived file was read back and verified. Publication metadata, the
public-feed receipt, full Linux and Windows evidence and screenshots are retained.

Automated acceptance covers browser dwell, touch and installed Windows
pointer interaction. The Windows Talk subcase has the explicit simulated
transport scope above. Physical eye-tracker comfort and real speaker output
remain hands-on acceptance checks. Production delivery uses the normal updater.
