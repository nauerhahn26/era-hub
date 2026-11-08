# Tic-tac-toe delivery

Design record is [Tic-tac-toe in Games](../specs/2026-11-08-tic-tac-toe-design.md).
The maintainer authorized implementation, testing and publication on 2026-11-08.
Worktree is `era-hub--wt-games`, branch `feat/games`.

## Starting state

The original Games release was v1.0.17. Current production is v1.1.2.
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
      acceptance-contract and geometry checks pass 10/10. Actual VM run is pending.
      Talk transport is mocked and recorded as such. Physical gaze is untested.
- [x] Documentation, test registry and source review are complete.
- [ ] Complete integration gate is green on the committed candidate.
- [ ] Patch artifacts are built once and qualified by the full Windows baseline
      and Games journey, with original evidence and cleanup retained.
- [ ] Gate-qualified source is merged and pushed through the normal landing rail.
- [ ] Authorized release is published and public assets and update feed are read back.

## Delivery receipt

Pending implementation and qualification.

The selected cached Windows runtime has the same bytes as production v1.1.2.
Its existing private cache modification is retained. Planned patch is v1.1.3.
Use the standard release dry run for a single build and complete Windows test,
then publish the reviewed existing files with a new source tag and six assets.
