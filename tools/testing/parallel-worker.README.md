# Isolated full gates

This standalone capability runs a consenting owner's committed candidate through
that candidate's own unchanged `tools/era-gate.sh`. Invoke the driver by absolute
path; the candidate does not need this framework or a new registry. The first
complete isolated pilot passed all 140 suites while a legacy 143-suite gate also
passed. See the [adoption record](../../docs/plans/2026-10-25-parallel-gate-adoption.md)
for source identities, measured resources and the serial Windows handoff.

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

A running isolated job shares one gate count with the host's gates: while its
namespace runs, the host worker holds a slot for it in `/tmp/era-gate-slots` (the
namespace launcher's host pid, one lane, marked isolated), so host gates count it
toward `ERA_GATE_MAX_GATES` (default 2) and set its lane's memory aside for its
first two minutes. The gate inside takes no host lock and never waits on host
admission. The driver does not acquire, signal, reorder, or edit legacy jobs.
Isolated jobs wait in enqueue order and require at least three GiB available RAM
and three GiB free disk. Admission budgets two GiB for the worker plus one GiB
host reserve; this is not an enforced memory cap. That budget covers one suite at
a time, so the worker hands the gate `ERA_GATE_LANES=1` (recorded as
`resources.gateLanes`): a second two-lane gate beside a legacy one would push the
host into swap. Legacy gates keep `era-gate.sh`'s default of two. The worker uses
up to two CPUs at nice19, leaving at least half the allowed CPUs outside its
affinity. Hosts with only two or three allowed CPUs use one worker CPU. Its
sampled descendant RSS, host minimum available memory, swap, and memory pressure
are reported so the pilot can establish whether the shared-host budget is
adequate. RSS samples can miss intervening peaks and count shared pages more than
once.

The worker has private PID, mount, network, `/proc`, `/tmp`, `/var/tmp`, and shared
memory mounts. It uses the same nonzero UID with all capabilities dropped. Its
home is hidden except for the owned job; `/run`, original workspaces, credentials,
and live data are inaccessible through their original home paths. Loopback and a
dummy IPv4 interface allow network coverage without an egress route. The preflight
proves that the old gate's process cleanup stops its inner canary while the owned
host canary survives, and that fixed ports and temporary locks are independent.
The isolated main hub uses port 8388; legacy gates retain 8378. An ancestor PID namespace
can still see descendants, so the different command-line port also prevents an
old host gate's 8378 cleanup expression from matching the isolated hub. The selected
six-source suites were checked for a fixed 8388 listener before choosing this port.
A separate synthetic outer-host check exercises the cleanup shape on an owned
8387 control canary and proves the nested 8388 canary remains alive. It also checks
the exact real 8378 expression against the nested canary's actual process arguments.
It never runs a broad cleanup expression in the real host PID namespace.

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

Before syncing an actual master that only adds documentation, the owner should
run `status JOB` while the tested source tuple still matches. After it returns
validated exposed stamps, copy those genuine bytes into a new owner-private stamp
cache before changing any source checkout. A later status refresh can revoke the
job's exposed directory when a source HEAD moves; it does not revoke the preserved
historical receipt. Keep every original `at`, `head`, and other field unchanged,
and pass the private cache through the normal existing stamp-reader mechanism.
Those existing readers decide whether an ancestor proof is acceptable after the
sync. A private copy creates no new acceptance policy, refreshes no proof, and
must not overwrite the shared host stamp directory.

Queue ETA is explicitly unknown until at least one actual complete isolated gate
passes validation. `inspect.fullPilotValidated` records that historical pilot;
ETA uses recorded results with successful validation, exit zero, a complete
passing gate summary and positive measured gate time. A later origin move can
make current status stale without erasing that history or timing sample. Neither
field grants current stamp eligibility: `status JOB` retains all source, runtime
and genuine-stamp checks. Estimates can vary with host load and candidate scope.
There is no active cancellation command in this first
version. A dead or unknown lease owner is retained for explicit owner review;
the driver never steals leases or kills unrelated processes.
Failure cleanup verifies and waits for its captured namespace launcher before
releasing the isolated slot, so a failed worker cannot overlap the next one.

Run the safeguards with:

```sh
node --test tests/parallel-gate.test.mjs
```

That root suite includes snapshot, capacity, memory-monitor and real namespace
canary checks. A synthetic green is a prerequisite for the full pilot, not a
substitute for it.
