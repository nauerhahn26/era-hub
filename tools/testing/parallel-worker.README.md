# Isolated full gates

This standalone capability runs a consenting owner's committed candidate through
that candidate's own unchanged `tools/era-gate.sh`. Invoke the driver by absolute
path; the candidate does not need this framework or a new registry. Availability
remains provisional until an actual full pilot finishes and its evidence validates.

```sh
node /absolute/driver/tools/parallel-gate.mjs inspect --preflight
node /absolute/driver/tools/parallel-gate.mjs queue --hub /absolute/clean/era-hub--wt-feature
node /absolute/driver/tools/parallel-gate.mjs status
node /absolute/driver/tools/parallel-gate.mjs status gate-YYYYMMDDTHHMMSSZ-0123abcd
node /absolute/driver/tools/parallel-gate.mjs log gate-YYYYMMDDTHHMMSSZ-0123abcd --lines 60
```

The worktree suffix is inferred from the hub name. Pass `--suffix --wt-feature`
to select it explicitly, or `--suffix ''` for canonical siblings. Each sibling
with that suffix is selected when present; otherwise its canonical checkout is
selected. All six repositories must be clean, with complete Git history. Commit
the intended candidate and obtain its owner's consent before enqueueing.

The default seed is the adjacent `era-family/test-data`; `--seed /absolute/test-data`
selects another approved synthetic seed. Enqueue freezes a scrubbed owned copy
immediately, recording the original seed provenance. Later changes by a legacy
gate cannot change that job's seed. Live data and seed symlinks are refused.
The private scanner used by scanner parity tests is copied and pinned too.

Jobs persist under `~/.local/state/era-parallel-gates/jobs/`. Each includes its
request, source manifest, complete logs, namespace proof, gate result, memory
observations, and `done.json` sentinel. Runtime packages, browser binaries, Node,
and their linked libraries are copied and hashed at preparation time. The copied
control code is frozen at enqueue. Every Git clone has its own complete objects;
the gate cannot change the original source repositories.

One isolated lane permanently reserves the second lane for the existing legacy
gate. The driver does not acquire, signal, reorder, or edit legacy jobs. Isolated
jobs wait in enqueue order and require at least three GiB available RAM and three
GiB free disk. Admission budgets two GiB for the worker plus one GiB host reserve;
this is not an enforced memory cap. The worker uses one CPU at nice19. Its sampled
descendant RSS, host minimum available memory, swap, and memory pressure are
reported so the pilot can establish whether the shared-host budget is adequate.
RSS samples can miss intervening peaks and count shared pages more than once.

The worker has private PID, mount, network, `/proc`, `/tmp`, `/var/tmp`, and shared
memory mounts. It uses the same nonzero UID with all capabilities dropped. Its
home is hidden except for the owned job; `/run`, original workspaces, credentials,
and live data are inaccessible through their original home paths. Loopback and a
dummy IPv4 interface allow network coverage without an egress route. The preflight
proves that the old gate's process cleanup stops its inner canary while the owned
host canary survives, and that fixed ports and temporary locks are independent.

Candidates must provide deterministic closed provider fixtures. A candidate that
requires a real network provider fails visibly; this capability does not silently
skip network or permission cases. Every expected suite must execute once with a
successful complete TAP or legacy receipt. Modern skipped and todo counts must
both be zero. Dirty inputs, changed source tuples, missing outputs, partial gate
summaries, changed runtime bytes, and missing genuine stamps prevent acceptance.

`status JOB` rechecks the current source tuple, runtime, full output and genuine
gate-issued stamps before returning an `exposed-stamps` directory. It preserves
the original stamp bytes and issuance time. A source move makes that proof stale
for current acceptance; the historical logs and result remain available. Stamps
are never written to the shared host stamp directory. This capability does not
land, publish, or deploy a release. Existing maintainer approval still applies.

Queue ETA is explicitly unknown until at least one actual complete isolated gate
passes validation. Later estimates use completed full runs and can vary with host
load and candidate scope. There is no active cancellation command in this first
version. A dead or unknown lease owner is retained for explicit owner review;
the driver never steals leases or kills unrelated processes.

Run the safeguards with:

```sh
node --test tests/parallel-gate.test.mjs
```

That root suite includes snapshot, capacity, memory-monitor and real namespace
canary checks. A synthetic green is a prerequisite for the full pilot, not a
substitute for it.
