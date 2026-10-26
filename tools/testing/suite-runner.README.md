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
The merged Chat feature has six registered suites and two Python helper files
owned by its speech wrapper. Games metadata remains a draft until those files
merge. Registration classifies coverage and resources; Chat product changes
retain the complete fallback and gain no new omission rule.

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

Development and release requirements remain in [the development flow](../../docs/dev-flow.md).
