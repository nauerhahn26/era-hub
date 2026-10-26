# Individual app lockouts — implementation plan

Date: 2026-10-25. Status: implementation prepared; testing and release paused by dad.
Design: [individual app lockouts](../specs/2026-10-25-individual-app-lockouts-design.md).
Worktree: era-hub--wt-lockout; branch: fix/lockout.

## 1. Baseline and review

- [x] Read the house router, hub dev flow, current media-lock design/plan,
  board-lock implementation, app registry, shared door bar and app lifecycle seams.
- [x] Identify Music's coupled lock and integration overlaps; record them in design.
- [x] Dad authorized implementation, with testing and release held.
- [ ] Coordinate frozen shared sources with Testing suite; record agreed baseline
  commits and gate ownership before implementation. Re-read sibling dirty diffs.
- [ ] Create matching --wt-lockout worktrees for era-core, era-board,
  era-making-words and era-pencil through the worktree tool; read their local
  instructions. Use ERA_WT_SUFFIX=--wt-lockout for assembly, payload and gate.

## 2. Shared controller, tests first

- [ ] Write failing controller tests: independent IDs and expiry; indefinite locks;
  malformed state; storage failure; reload; tab updates; simultaneous different-app
  writes; disposal; timer/focus checks; settings refresh; legacy migration including
  partial failure and preservation of a stronger existing lock.
- [ ] Extract hold/keypad/banner/styles from board lock into era-core. Test short
  touch, canceled hold, mouse/gaze rejection, correct/incorrect passcode, stale
  asynchronous verification after dismissal and duplicate mounting.
- [ ] Add a door-bar partner-strip seam only if needed; pin exit/talk positions,
  touch-only control semantics, keypad target sizes and narrow-window layout.
- [ ] Define app identity mapping and a shared adapter contract; test child routes.

Checkpoint: shared tests green; one controller owns the lock mechanics, with no
app imports. No production app behavior changes until its adapter tests exist.

## 3. Settings and Music migration

- [ ] Test Settings status rows and explicit Lock/Unlock actions for installed apps;
  no state writes on load/navigation; hashed passcode only; accessible mouse and
  keyboard management; duration changes affect future locks only.
- [ ] Add the per-app management UI using the shared controller. Retain old settings
  keys and relocate/reword the media-only description. Home app links stay usable
  and open the locked screen rather than bypassing restrictions.
- [ ] Replace board-lock mechanics with adapters for Music, Movies, Clothing and
  This week. Test separate locks despite shared renderer/pack; legacy migration;
  stop Music in every open tab; re-render; sheet/arrange interactions; direct
  episode/song links; child activity and video routes.

Checkpoint: existing music/passcode behavior preserved except the deliberately
independent app scope. No duplicate hold, keypad or persistence implementation.

## 4. Every app adapter, tests before each change

| App | Lock transition and late-work checks |
|---|---|
| Making Words | Stop speech and prompt chains; invalidate pending lesson work; preserve lesson |
| Pencil | Stop speech/prediction callbacks; block letter/word/save mutations; retain writing |
| Clothing | Block outfit and wardrobe interactions; ignore late interactive render callbacks |
| Music / Movies | Stop local playback; guard play/full-song/launch entry points; document external-player limit |
| This week / Play / Watch | Stop video/audio and activity engines; cancel timers; guard deep-link startup |
| Reader | Stop narration/autoplay/page turns; preserve book position; guard shelf/open paths |
| Drawing | Cancel active drag and pending gestures; block scene edits; preserve existing drawing |
| Math | Stop counting/speech; invalidate async sequences; retain number state |
| Games | Stop sounds/animation/input and delayed moves; retain state for every game |
| Chat | Stop capture/stream/speech; cancel requests; ignore late responses; no automatic capture on unlock |

- [ ] Implement each row with tests for startup already locked, lock mid-activity,
  all input paths, rerender, unlock without automatic restart, and available doors.
- [ ] Verify settings-return and communication-return cannot bypass a still active
  lock. Test queued work that completes between locking and unlocking.
- [ ] Test boot ordering: no autoplay, capture or interactive action before initial
  lock state is checked. Do not disable unrelated background content maintenance.

Checkpoint: complete route matrix for all eleven apps, including Chat/Games from
the coordinated baseline. No app silently omitted because absent on this branch.

## 5. Regression and installed payload

- [ ] Run focused shared/controller, adapter and settings tests; then cross-app
  browser scenarios: lock A leaves B usable; reopen A directly; cross-tab stop;
  separate expiry; indefinite lock; wrong/correct passcode; preserved work;
  paused/sheet/arrange state; sleep past expiry; keyboard and touch bypass attempts.
- [ ] Verify shared assets ship in the core payload and all optional app packs
  resolve them; exercise fresh and upgraded profiles in the installed build.
  Use existing payload/VM test rails; coordinate any tooling changes with Testing suite.
- [ ] Perform a recorded touch walkthrough: independently lock Music and a second
  app, leave through the door, reopen each, unlock one while the other stays locked,
  and demonstrate continued access to the communication door.
- [ ] Run the coordinated full gate detached with a sentinel and recorded PID;
  collect exact result and green tree stamps for every sourced feature worktree.
  Never restart live 8377; manual hubs only on checked free ports 8380–8389.
- [ ] Update nearest docs, app coverage evidence and retrospective in the same
  commits as code; record remaining limitations and tested baseline revisions.

## 6. Delivery boundary

- [ ] Review final cross-repo diffs and evidence with dad.
- [ ] Land only after Testing suite coordination and green current stamps, in
  dependency order: era-core → era-board → era-making-words → era-pencil → era-hub.
- [ ] Publish or deliver to devices only on the maintainer's explicit instruction.

No code built or tests run during this planning pass. Plan acceptance does not
claim the current implementation already satisfies these checks.

## Implementation handoff — 2026-10-25

Dad authorized making the change and explicitly requested waiting before tests
and release. No test, syntax-check command, manual hub, gate, payload build,
VM leg, device delivery or release has been run for these changes. Source/diff
review and worktree-only assembly are the only checks performed.

- [x] Created dedicated lockout worktrees for core, board, words and pencil.
- [x] Updated this hub branch to landed Chat master, then merged the committed
  Games integration branch locally to cover Games. No sibling source tree or
  main checkout was edited. Games in this branch is an integration input, not
  a claim that its release has landed.
- [x] Added the shared controller, per-app storage/identity, timer and tab updates,
  migration, adult hold/keypad, shared styling and optional Continue control.
- [x] Connected all eleven apps and weekly child pages, with local action guards
  and cancellation hooks for speech, media, recording, timers and gestures.
- [x] Added Settings per-app controls using the shared controller and kept the
  existing duration/passcode API. Added a last-known configuration cache.
- [x] Authored state/UI/app-entry regression cases and revised media-only board
  expectations for independent full-app locks. These have NOT been executed.
- [x] Updated user-facing app-lock documentation and sibling READMEs.
- [ ] Await explicit instruction to start testing; then finish the verification
  matrix above, including real touch, viewport/door geometry, optional payloads,
  offline/storage failure, all app adapters and interrupted asynchronous work.
- [ ] Coordinate the final baseline and gate/landing slot with Testing suite.
  Frozen integration worktrees and shared main sources remain untouched.
- [ ] Review and land only after coordinated green checks. Publish separately
  only when explicitly instructed.

Feature worktrees: era-hub--wt-lockout, era-core--wt-lockout,
era-board--wt-lockout, era-making-words--wt-lockout, era-pencil--wt-lockout.
Use ERA_WT_SUFFIX=--wt-lockout for later validation. Changes are uncommitted;
the hub has a local integration merge of Games. Do not land it while review
and validation are pending.
