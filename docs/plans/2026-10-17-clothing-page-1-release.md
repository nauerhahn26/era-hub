# Clothing page 1 patch release

Dad authorized testing and a subversion release on 2026-10-17.
Target: v1.0.3, following public v1.0.2 and retaining the signed v1.0.0 installer.
Feature: eight first-page outfit choices, speaking center weather, Full wardrobe
on outfit/browse pages, and Accessories inside Full wardrobe. Existing board
styling is preserved. Spec: ../specs/2026-10-17-clothing-page-1.md.

## Release steps

1. Full gate on committed era-hub and era-board feature worktrees with
   `ERA_WT_SUFFIX=--wt-clothing-page-1`; require zero failures and clean stamps.
2. Land era-board, then era-hub through worktree.sh. No live server restart
   between the coordinated merges.
3. Release v1.0.3 with `--patch --skip-gate` while the matching green stamp
   remains fresh. Verify the inherited installer signature and run Windows
   self-update leg B on the exact candidate archive before publication.
4. Verify the public release, six assets, feed/archive checksum and included
   hub/board changes. Confirm temporary QA teardown. Record receipt here.

The QA template may need the documented disposable-host repair; follow
`aac-board-builder/docs/vm-e2e.md` and its preserved recovery helper. Never
change the permanent template during this release or leave a temporary host up.
Publication does not establish receipt on any family device; use normal updates.

## Release receipt

Published [v1.0.3](https://github.com/nauerhahn26/new-era-releases/releases/tag/v1.0.3),
build `20261017.0310`, on 2026-10-17. Implementation merged and pushed:
era-board ecb106e, then era-hub ad26148. Release source/tag: b98b35d,
with the same application tree tested before the merges.

- Full gate: **122 suites passed, zero failed**, clean hub and board stamps.
- Windows self-update leg B: **five passed, zero failed** on the exact archive
  published. Prior signed installer v1.0.0; signature verification succeeded.
- Public latest feed reports v1.0.3; all six expected assets are uploaded.
- Downloaded public archive matches both the feed and locally tested archive.
  Packaged clothing-worker.js, clothing-rank.js, clothing.js, board-render.js
  and wardrobe.svg match the committed feature sources.
- Archive SHA-256:
  `ced93f8fce895359a6db115f99d5824d818046153d250bdf7e7834e26143b2d8`.
- Temporary QA host was repaired using the documented clean-baseline procedure
  and destroyed automatically after publication. `qa.sh status` confirmed no
  QA host remains. Permanent template unchanged.

Evidence: `gate/vm-e2e/leg-b.log` in the feature worktree and
`dist/release-v1.0.3/VM-GREEN` beside the repos (legs=b, matching archive hash).
Release command after the clean full gate:

```
VM_OUT=/tmp/clothing-page-1-release-vm ERA_WT_SUFFIX=--wt-clothing-page-1 \
  bash tools/release.sh v1.0.3 --patch --skip-gate
```

Delivery uses the normal public updater. On dad's request, v1.0.3 was also
pushed to the tablet through `push-device.sh` on 2026-10-17. The tablet's running
build was verified as `20261017.0310`; its regenerated clothing recipe has eight
first-page outfits, weather at row 2 / column 2 spanning two columns, Full
wardrobe, and no Accessories door on the suggested-outfit page. Other devices'
receipt remains unverified. No live development-server restart was done.

## Pre-clear audit (2026-10-17)

Feature work and delivery are complete; application source worktrees are clean.
A cold, read-only agent with no chat history recovered the layout, navigation,
small-wardrobe rule, release/build/archive hash, validation results, and the
separate tablet delivery evidence from these files. It cited both the spec and
release receipt and corroborated the Windows test marker/log. Probe passed.

The archive job compressed eight updated transcripts without failures. Six
additional CLI transcripts were compressed separately because the current
backup script scans only its original transcript directory. The archive job
then reported 12 files synced to tablet recovery/chats. The transient concurrent
connection timeout did not negate that completed transfer. Additional active
transcript updates are archived again at the end of this audit.

The host-wide hygiene sweep returned exit 1 with 12 findings:

- Nine reported missing paths all exist after expanding `~`; these are scanner
  path-resolution false positives, not missing project files.
- The workspace router repo has six uncommitted entries, comprising prior
  operational documentation/log changes and an untracked plans directory.
  They are outside this feature; do not commit or discard another session's
  work to make the sweep green.
- School-device work remains queued while that device is offline. Delayed
  school delivery was previously accepted; do not claim receipt.
- The legacy gaze source and current gaze repo differ. Their drift requires
  separate review; do not overwrite either source during this audit.

No legacy application code changed in this feature, so its conditional legacy
suite rerun is not required. The current suite's release gate is 122/0 and the
Windows self-update result is 5/0. The seal checklist strictly requires hygiene
exit 0, so this audit cannot claim a seal while the sweep remains nonzero.
The feature's decisions and verified delivery are nevertheless preserved here.
