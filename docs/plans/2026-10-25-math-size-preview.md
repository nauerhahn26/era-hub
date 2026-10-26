# Math sizing preview and release plan

Status: published in v1.0.21 and verified on an installed device.

Design: [larger numerals and modest side controls](../specs/2026-10-25-math-size-preview.md).

- [x] Inspect current Math layout and confirm the worktree starts clean.
- [x] Confirm Math source and focused tests match the later landed master.
- [x] Run existing geometry checks before editing: six cases passed.
- [x] Adjust only the Math stylesheet for the sizing proposal.
- [x] Capture before/after previews at both supported review sizes.
- [x] Pass existing Math layout checks and inspect representative layouts.
- [x] Prepare the review gallery and full-size images for the maintainer.
- [x] Maintainer reviewed the preview and explicitly approved deployment.
- [x] Sync current landed dependencies and verify the combined source.
- [x] Pass the isolated full gate and land through the worktree helper.
- [x] Publish a patch after its Windows update acceptance passes.
- [x] Verify public payload bytes and installed-device delivery separately.

The original visual preview was held from deployment. After reviewing it, the
maintainer requested deployment. Ship the exact reviewed stylesheet through the
normal combined gate, landing and patch-release process. Keep the existing
website presentation unchanged.

At preview time, the main checkout had newer unrelated work but matching Math
source and focused tests. Release preparation subsequently merged the final
landed suite, including the published Chat replacement, before freezing the
combined candidate. All Math application edits remain limited to its stylesheet;
review artifacts live outside the payload.

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


## Release receipt

The maintainer explicitly requested deployment after reviewing the actual
before/after images. The released sizing is that same reviewed stylesheet.
Candidate Hub `d6e83c0` (tree `dd5ae8b4`) includes final predecessor master
`fc83762`. Its other five sources are Core `c5f33cf`, Board `2cb86de`,
Words `9b2daa9`, Pencil `bd43dbb` and Gaze `fc73172`.

Isolated full job `gate-20261026T150437Z-980ab1c3` passed all 156 suites in
2,131 seconds, with no failed or omitted cases. The driver validated the
unchanged six-source tuple and genuine outputs. With an empty worktree suffix,
the gate issues one genuine Hub stamp while covering all six sources. Its
original bytes and issue time were preserved in a private stamp cache before
landing. The normal helper landed the candidate as `863ed9e` and pushed master.
An earlier Math-only run was stopped when the separately approved Chat release
took precedence; it supplies no acceptance for this combined candidate.

The independent build farm produced v1.0.21, build `20261026.1507`, without
changing active source checkouts. It retained the signed v1.0.0 installer.
The first managed Windows attempt passed update and Math checks but failed two
existing Chat readability checks on the template's 1024-by-768 desktop. Its
9/11 result remains failed and preserved; no green marker was accepted.
The successful Chat qualification had initialized an actual 1280-by-800 desktop.
A new private preparation closure retained the same helper and test bytes,
rebinding only candidate version, build, payload hash and manifest ID. Sixteen
local preparation checks passed. No application code or assertion changed.

Fresh Windows job `win-20261026T152754Z-12b254bb` verified the actual native
1280-by-800 mode before installation and passed all eleven unchanged update
cases, including Math and complete Chat restart persistence. It completed on
2026-10-26 at 15:42 UTC. Both owned transport and temporary-host cleanup passed.
Its original VM marker was copied byte-for-byte for the exact tested archive.

A reviewed private publisher retained fresh full-gate, source ancestry,
installer signature, complete Windows and exact artifact checks while using
the managed qualification instead of the older canonical tunnel cleanup. It
held the cooperative publication lock, required public predecessor v1.0.20,
and created a new nonforce source tag at the exact candidate. All six public
assets were downloaded and hash-verified after publication. The actual public
latest feed and stable archive also match v1.0.21 and build `20261026.1507`.
Payload SHA-256:
`cf925508455e5188d68a52e928e0c43f5aa489ea47c220dfcbce388a9a7f36ca`.
TAR, ZIP and expanded payload agree; the four Math files match the reviewed
commit. The website presentation remains unchanged.

An installed device took the normal public-feed update. Running and disk builds
both report `20261026.1507`; Math is installed and enabled. Its complete app
selection response is unchanged, and the served Math stylesheet matches the
approved payload byte-for-byte. Reopening Math loads the larger layout.

Private evidence is retained under `~/.cache/era-math-size-release/`, with
original isolated and managed job records in their state directories. The
failed attempt remains historical. No live operator hub restart was performed.

## Retrospective

Preserve the inherited Windows desktop preparation when adding a small change
to a cumulative release: passing app logic alone does not establish the other
apps' readable geometry. Keep immutable candidate files across a harness-only
repeat, and distinguish its failed and successful receipts. Overlapping release
owners must establish the final cumulative source before collecting a full gate.
