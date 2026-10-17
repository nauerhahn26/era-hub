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

## Current state

Testing/release in progress. Feature commits before release documentation:
hub fc27925; board b62adf7. No publication or device receipt claimed yet.
