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
- [x] Run a fresh full gate; the earlier 132-suite green stamp has expired.
- [x] Build and run the required Windows self-update leg through release.sh.
- [x] Publish v1.0.12 and verify public manifest, archives and included Math files.
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
Syntax and whitespace checks passed, followed by the real Windows validation
recorded below.

Sibling overlap: chat, games and other feature worktrees can touch the app
registry or shared runtime. Only committed landed master content and the paired
math core worktree belong in this release; do not include their pending edits.

## Publication receipt

Published v1.0.12, build `20261025.2212`, through the patch release script.
The full gate passed **132 suites, zero failures**. The Windows self-update
leg passed **8 tests, zero failures**, including the installed Math smoke.
Math opened from Home, quantities changed 7 → 8 → 7, a partner transfer kept
the whole at seven, and reload preserved the partition. The disposable VM's
original app choice and Math state were restored. Screenshot:
`gate/vm-e2e/06-math-after-update.png` (local ignored evidence).

Release preparation landed and pushed as `b3de595`; the release tag names
the gated feature commit `c286357` with the same tree. The public manifest
reports v1.0.12 and the correct build, retaining signed installer v1.0.0.
The public stable archive's SHA-256 matches the manifest:
`819897ae20faa0f1605c717706d7dd231ef9b655166c876a2b6a689d419fa699`.
All nine checked Math, icon, registry and shared speech files match tested
source. All six expected release assets are published; the release is neither
draft nor prerelease. The temporary Windows QA host was destroyed successfully.

The initial installed-device probe showed the previous build and a saved app
selection. The device went offline while validation ran. Publication is verified;
installed delivery and enabling Math remain pending until the device is online.
The maintainer was asked to wake it. No operator hub restart, website change
or other device write was performed.
