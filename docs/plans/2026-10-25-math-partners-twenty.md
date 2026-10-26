# Number partners through twenty plan

Design: [picker and representation update](../specs/2026-10-25-math-partners-twenty.md).
Continue the existing math worktree and suite delivery scope. Website copy stays
at Coming soon.

- [x] Inspect the installed picker behavior, state limits and part rendering.
- [x] Flag sibling overlap: chat touches integration; testing-suite is auditing
  gate strategy. This change stays within Math and its existing focused tests.
- [x] Write and reproduce regressions before implementation.
- [x] Show 0–10 on the first partner picker page and 11–20 on the next.
- [x] Extend whole quantities and structured part rendering through twenty.
- [x] Preserve saved state, cancellation, passive objects and existing controls.
- [x] Pass focused state/browser checks and review both desktop sizes visually.
- [x] Commit, run the full gate and land through the normal helper.
- [x] Publish the next patch after its required Windows self-update checks.
- [x] Verify public bytes and installed delivery separately; record the outcome.

The public release at the start of this unit is v1.0.12. No other worktree's
pending changes belong in this patch. The operator hub is not restarted.

Initial regressions reproduced six state failures and both targeted browser
failures before the implementation changed. The new state suite then passed
all eleven cases. The final combined focused run passed **34/34 checks**:
eleven state tests and twenty-three browser tests. Visual review confirmed both
picker pages and both extreme partitions at 1920×1080 and 1280×720. Counting
through the 11 + 9 partition visits one continuous twenty-object inventory.
The existing Windows Math smoke exercises the new picker and saves the
11 + 9 partition across reload. Both syntax and real installed Windows
validation passed.

## Concurrent release coordination

A prior authorized weekly-board update is ahead in the shared gate queue and
also plans a suite patch. Automatic publication of a preselected version was
stopped before it could run. The owned Math gate was briefly paused before
collecting sources, retaining its place in the queue. The released master was
then synchronized and the queued gate resumed. The other feature has not yet
landed; pending feature branches do not belong in this patch.

After the gate, recheck master and synchronize/retest if new runtime changes
have landed. Choose an unused version against the then-current public release
and any actual release run in progress. If another publication is in progress,
wait for it to finish before selecting the next version. Build from the tested
landed snapshot containing all already published features.

The gate, landing and Windows locks are separate; the release script does not
itself provide whole-release locking or version reservation. This publication
used a cooperative lock across live-version and tag checks, version selection,
build, Windows verification and publication. It required the source to be a
landed snapshot containing the current public hub tag, and refused existing
candidate tags or dist directories. Other queued publishers were notified of
the landed revision and the completed publication.

## Publication and installed-delivery receipt

The runtime change is commit `003082f`; the complete gate on the frozen
candidate passed **132 suites, zero failures**. The feature landed and pushed
as `e75e16c`. Published **v1.0.13** on 2026-10-26 at 00:12 UTC, build
`20261025.2354`, retaining the verified signed v1.0.0 installer.

The required Windows self-update leg passed **8/8 tests**. Its installed Math
smoke selected ten from the first page, opened 11–20 directly, selected twenty,
transferred a counter to make 11 + 9, and preserved that partition across
reload. Screenshot: `gate/vm-e2e/06-math-after-update.png` (local evidence).
The temporary QA host was destroyed and the publication lock released.

All six release assets are public. The public manifest and stable archive agree
on SHA-256
`290ad7474c0f3450e44d3874f09db010d5f05408d6eaa1ab3218221697b4aaa6`.
All nine checked Math, icon, registry and shared speech files match tested
source. Release notes describe the new picker and structured parts.

After the maintainer woke the installed device, the normal public-feed check
reported the update already current. Separate probes confirmed both running
and disk build `20261025.2354`, Math installed and enabled, the same saved app
selection, and a deployed picker/state module identical to tested source.
Reopening Math loads the new interface and preserves the exploration.

No operator hub restart or website change was performed. Physical acceptance
of the revised picker remains a maintainer trial; this receipt establishes the
release, deployed code and preserved settings rather than a learning outcome.
