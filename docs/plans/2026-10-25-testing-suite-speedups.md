# Clothing gate fixture speedups

This stage changes only `tests/clothing.test.mjs` and documentation. It can be
adopted independently of the proposed gate runner, registry or job queue.
Design: [testing strategy](../specs/2026-10-25-testing-strategy-design.md).

The local fake now closes its response so a dropped connection does not wait
for the production two-minute timeout. The label-budget case temporarily owns
only its two source photos and restores the original catalog/photo directory
afterward. It asserts that rebuilding labels makes no provider requests.
Production code, request spacing and timeouts are unchanged.

The same file now proves missing-tile exclusion with the source photo still
present, checks segmentation runtime readiness, and exercises seven morning
cutoff cases with a deterministic clock. All existing journeys remain.

- [x] New connection-drop assertion failed against the old fake after 5,003 ms.
- [x] The independent drop/cutoff smoke passed 2/2 in 0.475 seconds after repair.
- [x] Review the complete test-file diff, syntax and privacy checks.
- [ ] Run the complete 35-case file inside a full gate and record final timings.
- [ ] Land after complete acceptance and notify queued release sessions.

The earlier source-matched run recorded 134.1 seconds for the dropped-connection
case and 85.2 seconds for the label case. New full-suite savings are not yet
measured. Focused smoke does not supply a full green gate stamp.

Queued release owners may adopt this test-only stage into their own feature
worktrees and let their complete gate verify the combined tree. Preserve source
stability while a gate runs and do not modify a running gate's collected files.
No running gate or release was cancelled or rewritten for this stage.
