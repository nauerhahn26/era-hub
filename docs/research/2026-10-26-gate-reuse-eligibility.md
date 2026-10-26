# When another complete gate is necessary

The existing acceptance rule requires a complete green receipt for the tree
that lands, with the documented Markdown-only ancestor exception. It cannot
currently combine passing suites from one failed gate with a corrected suite
from another run. That is an acceptance mechanism, distinct from the technical
question of whether unchanged tests could detect a fixture-only correction.

## Evidence from the parallel rollout

- The first 139-suite pilot passed 137 files. Music required an external symbol
  image; the Reader reload test observed a populated index before rendering
  restored the saved section. Both fixtures were corrected without changing
  application code.
- The second 139-suite pilot passed 138 files. The previous repairs passed;
  another Reader case incorrectly assumed identical discovery timestamps.
  Both supposedly tied books now explicitly seed the same dates, and the test
  verifies the three actual index keys before retaining its original ordering
  assertion. The complete 17-case file passed with discovery time deliberately
  advancing by ten milliseconds per unseeded book.
- Comparing Chat `228b5b3` with `6d1e556` showed only the Reader test and its
  Markdown plan changed. That was a strong candidate for a narrow fixture-only
  reuse rule, had one been implemented and approved. No composed receipt or
  replacement full stamp was issued.

At 01:36 UTC, the source baseline then changed independently: Core `02377c5`
landed a real shared speech change and a new mandatory regression suite; Hub
`cbfbb8d` landed the sorting change. These changes shipped in v1.0.15. The old
passing files had not exercised the combined new runtime with Chat or Games.
Therefore the current candidates genuinely require complete integration runs:
140 suites for Chat and 143 for Games. Reusing the old coverage would not be a
fixture-only optimization. Pinning an older dependency to avoid this run would
also omit an already shipped runtime change.

## Safe future reuse requirements

A future implementation must identify each required suite and all its material
inputs: selected production sources, shared test helpers, fixtures, runtime,
configuration and relevant environment. It needs explicit treatment of owned
data and cross-file effects. An unchanged test file alone is insufficient.

Reuse can be considered only when those inputs still match and passing evidence
is complete and fresh. A changed test and its consumers must run again. Unknown
dependencies, new production code, changed shared runtime, changed material
configuration or missing evidence require the complete fallback. Every required
suite must have valid evidence; original times and output hashes must survive.

The gate and all acceptance readers must understand and validate that provenance
before a composed result can be accepted. Do not edit a failed summary, refresh
an old timestamp, or mint an ordinary full-run stamp from partial results. This
document approves no exception to the existing rule.

Until that mechanism is validated, use focused checks during editing, fix
determinism before entering the release queue, and freeze the complete source
tuple for the final gate and build. Coordinated publication order is essential:
isolation protects execution from moving files, while ordered integration keeps
the tested candidate eligible to land.
