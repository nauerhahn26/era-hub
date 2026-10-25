# Math suite release

The maintainer expected Math on an installed computer. The earlier instruction
was handled as source publication plus a website coming-soon notice; that did
not distribute an update. Publish the suite patch now while retaining the
website notice. No website content changes are part of this release.

Design: [Math exploration](../specs/2026-10-25-math-design.md).
Implementation: [Math plan](2026-10-25-math-plan.md).

- [x] Confirm paired runtime changes are landed and pushed, with clean worktrees.
- [x] Confirm the public release is v1.0.11; reserve v1.0.12 for this update.
- [x] Include Math in the release app-list description.
- [x] Add an installed Math smoke to the Windows self-update leg.
- [ ] Run a fresh full gate; the earlier 132-suite green stamp has expired.
- [ ] Build and run the required Windows self-update leg through release.sh.
- [ ] Publish v1.0.12 and verify public manifest, archives and included Math files.
- [ ] Check installed delivery and selected-app visibility separately.
- [ ] Commit and push the release receipt.

Use the patch flow, retaining the signed v1.0.0 installer. The standard release
script owns temporary QA host setup and cleanup. Capture the detached run's PID,
log and exit sentinel. Do not restart the operator hub. Existing explicit app
selections remain preserved; enable Math through the app settings if needed.

The new Windows smoke checks that Math ships as core content while the earlier
app selection is preserved, enables it through the app endpoint, opens it from
Home, checks 7 → 8 → 7, moves a counter between parts, and verifies reload
persistence. It restores the disposable VM's Math workspace and app selection.
Syntax and whitespace checks passed; real Windows validation remains pending.

Sibling overlap: chat, games and other feature worktrees can touch the app
registry or shared runtime. Only committed landed master content and the paired
math core worktree belong in this release; do not include their pending edits.
