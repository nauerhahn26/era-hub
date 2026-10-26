# Math sizing preview plan

Design: [larger numerals and modest side controls](../specs/2026-10-25-math-size-preview.md).

- [x] Inspect current Math layout and confirm the worktree starts clean.
- [x] Confirm Math source and focused tests match the later landed master.
- [x] Run existing geometry checks before editing: six cases passed.
- [x] Adjust only the Math stylesheet for the sizing proposal.
- [x] Capture before/after previews at both supported review sizes.
- [x] Pass existing Math layout checks and inspect representative layouts.
- [x] Prepare the review gallery and full-size images for the maintainer.
- [x] Maintainer reviewed the preview and explicitly approved deployment.
- [ ] Sync current landed dependencies and verify the combined source.
- [ ] Pass the isolated full gate and land through the worktree helper.
- [ ] Publish a patch after its Windows update acceptance passes.
- [ ] Verify public payload bytes and installed-device delivery separately.

The original visual preview was held from deployment. After reviewing it, the
maintainer requested deployment. Ship the exact reviewed stylesheet through the
normal combined gate, landing and patch-release process. Keep the existing
website presentation unchanged.

The main checkout has newer unrelated work. Its Math stylesheet, renderer,
state and focused browser tests match this worktree's baseline, so this preview
does not incorporate other feature branches. All application edits remain
limited to the Math stylesheet; review artifacts live outside the payload.

## Preview receipt

The candidate changes eight stylesheet declarations. At the native review size,
the main Numbers numeral grows from 230 to 282 pixels, the partner whole from
140 to 172, and part numerals from 120 to 148: approximately 23% larger.
Side rails grow from 360 to 384 pixels (6.7%), with labels from 74 to 78 (5.4%).
The two right-side actions are 5% taller; left-side rows retain their existing
heights. Equations and picker numerals have smaller increases.

All eight existing layout cases passed after the final refinement, including
fifty, both extreme partitions of twenty, and both picker pages at 1920×1080
and 1280×720. The black rest area remains inert. Visual review covered Numbers
seven, partners three and four, and partners eleven and nine. Six original and
six proposed images plus measurements are available in the local review
artifacts. A static before/after gallery passed desktop and mobile image/link,
overflow and page-error checks.

The approved candidate changes no application logic or saved-state format.
The screenshots and geometry checks describe the reviewed candidate; release
and delivery evidence will be recorded below after the combined checks.
