# Test planning and execution

Use the planner for development feedback. It selects complete suite files and
prints why each runs. Landing and release acceptance retain their required
complete gate evidence.

Run commands from the owning hub worktree:

```sh
node tools/test-suite.mjs check
node tools/test-suite.mjs list
node tools/test-suite.mjs plan --base master
node tools/test-suite.mjs plan --base master --json
```

Set `ERA_WT_SUFFIX=--wt-<feature>` when selecting matching sibling worktrees.
The registry check refuses missing or unregistered suites, unsupported executable
names and collection collisions. The registered parallel gate suite imports its
capacity and snapshot tests and runs the Python memory-monitor tests.
The historical public rollout baseline had six registered Chat suites and three
Games suites, for 147 suites using the reviewed registry from `cea43bd`. Its Chat
speech wrapper owns two Python helper files. Four later Chat suites reviewed at
`3105eec` were draft metadata in the
[audit supplement](../../docs/research/2026-10-26-queued-suite-audit.md), alongside
their separate Windows boundary. The historical private 151-suite pass at
`3536a18` verifies only its exact source, not the current candidate.

The current combined Chat, Games and Windows runner candidate registers 156
Linux suites, including the Windows runner's local contract suite.
Games adds durable state coverage; Chat adds the four reviewed browser, metrics,
symbols and voice suites plus store, storage and storage UI suites. Chat's browser
suite checks file-backed state across complete browser and store restarts and
verifies that clearing remains effective and committed writes recover after a
lost acknowledgement. Its storage UI suite checks truthful
unsaved fallback, Exit waiting for acknowledgement or its 850ms limit, and
immediate Talk handoff. The Windows update leg and the helper-contract and
failure-diagnostic privacy cases in `tests-vm/chat-ui-smoke.test.mjs` remain
separate from this flat Linux inventory. These counts classify coverage; they
are not complete gate evidence.

Unreviewed VM/helper changes retain the complete fallback. Registration
classifies coverage and resources; Chat and Games product changes retain the
complete fallback and gain no new omission rule.

## Conservative development selection

The baseline comparison includes committed feature work, staged and unstaged
edits, new files, deletions and both sides of renames across selected sources.
Changed suites, declared helper consumers, unresolved previous failures and shared
access smoke join the selected set.

Reviewed Math page/state paths and Markdown files under the hub's `docs/` can
narrow development execution. Shared runtime, `server.js`, tooling, uncertain
helpers or fixtures, unknown paths and missing baselines require the complete
gate. Group labels and observed source references cannot establish independence.
Selected passes never write complete green stamps.

## Existing serialized queue

```sh
node tools/test-suite.mjs queue
node tools/test-suite.mjs queue --affected --base master
node tools/test-suite.mjs status
node tools/test-suite.mjs status <job-id> --json
node tools/test-suite.mjs cancel <job-id>
```

The default request is complete; `--affected` expands to complete when dependency
scope is uncertain. These jobs use the existing machine-wide gate lock and run
in series. Each job retains its plan, input manifest, logs and outcome under
`~/.local/state/era-tests/` (`ERA_TEST_JOBS` can choose another directory outside
source repositories).

Queue outcomes deliberately retain `completeEvidence=false`, including complete
jobs that pass. Preserve that field. Acceptance comes from the genuine complete
gate outputs and original stamps checked by the existing landing/release readers;
the queue never relabels its tracking record as acceptance evidence.

Physical source, served assembly or seed/configuration changes invalidate the
job. Integration baseline movement while waiting requires replanning. A baseline
move after execution starts is reported separately from the tested candidate's
physical result. Queued cancellation writes a request; active termination is
unavailable. No process is signalled by this queue.

## Independent concurrent complete gates

Use the independent snapshot queue when preparing complete gates concurrently
with the legacy lane:

```sh
node tools/parallel-gate.mjs inspect
node tools/parallel-gate.mjs queue --hub /absolute/path/to/owning-worktree
node tools/parallel-gate.mjs status <job-id>
node tools/parallel-gate.mjs log <job-id> --lines 40
```

It freezes clean source inputs and a sanitized test seed, runs the candidate's
unchanged complete gate inside private namespaces, and validates the complete
inventory, outputs and genuine stamps before exposing acceptance evidence.
Admission allows one isolated worker and reserves one lane for existing gates.
Resource observations report an admission memory budget and sampled usage;
they do not claim an enforced memory cap. A queued or running request is not a
passing receipt. Availability and ETA depend on completed full validation.

See the [parallel gate adoption plan](../../docs/plans/2026-10-25-parallel-gate-adoption.md)
for rollout status and the evidence required for adoption.

## Explicit verification and landing

```sh
bash tools/testing/verify-and-land.sh /absolute/path/to/main-era-hub <feature-slug>
```

This explicit owner command synchronizes the chosen clean hub feature, verifies
it completely and lands it. It holds the gate reservation followed by the
landing reservation through the operation, and requires compatible gate and
house helper capabilities. `ERA_WORKTREE_TOOL` can point at an absolute capable
helper during staged rollout.

The operation is serialized and hub-only. Dependency owners must land matching
sibling changes first; dirty or unlanded paired sources are refused. It does
not prepare a parallel release train. Use the snapshot queue for concurrent
verification preparation, and keep final release publication separate under the
maintainer's authorization.

## Suite durations

`tools/testing/durations.json` holds each registered suite's median, mean, min
and max wall seconds and sample count. The lane scheduler reads it for
longest-first ordering; a suite with no sample gets `default_s`, the mean of
all medians. Regenerate it from green gate directories:

```sh
node tools/testing/harvest-durations.mjs --out tools/testing/durations.json \
  ~/.local/state/era-parallel-gates/jobs/*/workspace/era-hub*/gate
```

A parallel job counts only when its `status.json` says `passed`. A legacy
serial gate dir (`<hub-worktree>/gate`) counts only when its outputs are green by the
parallel validator's rules. Any dir with a `.execution-plan.tsv` must also be
complete. A run that fails any of these is skipped whole. Symlinked aliases
count once. Modern suites use the TAP trailer `# duration_ms` (`source: "tap"`).
Legacy `.js` scripts use the gap from the previous suite's `.out` mtime, which is
lower confidence (`source: "mtime"`). The first suite is anchored on the plan's
mtime, and a run without a plan yields no sample for its first suite. Warnings
name registry suites with no sample and samples with no registry entry; the
latter are left out of the table. Keys are sorted and `--generated-at ISO` pins
the timestamp, so the same inputs give identical bytes.

`--results FILE` (repeatable) also reads one JSON object per line,
`{"suite", "status", "seconds"}`, keeping `pass`/`passed` lines
(`source: "results"`). Phase 2 fixes the `results.jsonl` fields; adjust this
reader to match before relying on it. A suite whose samples have mixed sources
reports the lowest-confidence source. Refresh on a green master gate and commit
weekly.

## Suite classes

Every registry suite ends with the classes the lane scheduler and the result
store read: `hub` (`none`, `own`, `shared-reader`, `shared-writer`), `ports`,
`browsers`, `heavy`, `solo`, `quiet`, `retry` and `owner`. They are derived from
the suite sources, never typed by hand:

```sh
node tools/testing/classify-suites.mjs          # rewrite registry.json in place
node tools/testing/classify-suites.mjs --check  # list what differs, exit 1
```

Rerun it after any sync, merge or suite edit and review the diff;
`tests/suite-classes.test.mjs` fails the gate while the registry and the sources
disagree. Judgment calls (`solo`, `quiet`, segmentation reached through a hub,
two hub corrections) live in the commented `OVERRIDES` table in the script,
each with a witness pattern that must still match its suite. `retry` and
`owner` are reviewed decisions the script keeps; it refuses either without the
other. A `resources` list made only of derived words is rewritten from the
classes; a list with any other word is a reviewer's and stays verbatim.

Development and release requirements remain in [the development flow](../../docs/dev-flow.md).
