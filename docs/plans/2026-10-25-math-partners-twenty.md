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
- [ ] Commit, run the full gate and land through the normal helper.
- [ ] Publish the next patch after its required Windows self-update checks.
- [ ] Verify public bytes and installed delivery separately; record the outcome.

The public release at the start of this unit is v1.0.12. No other worktree's
pending changes belong in this patch. The operator hub is not restarted.

Initial regressions reproduced six state failures and both targeted browser
failures before the implementation changed. The new state suite then passed
all eleven cases. The final combined focused run passed **34/34 checks**:
eleven state tests and twenty-three browser tests. Visual review confirmed both
picker pages and both extreme partitions at 1920×1080 and 1280×720. Counting
through the 11 + 9 partition visits one continuous twenty-object inventory.
The existing Windows Math smoke now exercises the new picker and saves the
11 + 9 partition across reload. Its syntax check passed; actual installed
Windows validation remains required before publication.

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

The gate, landing and Windows locks are separate; there is no whole-release
lock or version reservation. Existing release tagging can overwrite a tag, so
check both the public release and existing tag before any publication. Do not
reuse an old dist directory or let a later patch omit already published work.
