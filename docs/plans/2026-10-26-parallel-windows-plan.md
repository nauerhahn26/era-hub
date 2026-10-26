# Parallel Windows rollout

Design: [independent Windows qualification](../specs/2026-10-26-parallel-windows-design.md).
Work branch: `feat/windows-parallel`, separate from the frozen release
candidates. The maintainer authorized this stage and requested further
speed and recovery recommendations afterward.

- [x] Identify shared VM destination, global locks, fixed local tunnel, output
  cleanup, provider lease and source/artifact coupling.
- [x] Keep the active Linux gates monitored and all canonical QA inputs unchanged.
- [x] Implement and negatively test private host/context allocation and teardown.
- [x] Implement and negatively test owned transport and distinct local ports.
- [x] Freeze source, artifact and control inputs with explicit adaptation receipts.
- [x] Prove concurrent fake jobs, complete evidence and failed-job independence.
- [x] Coordinate and validate a real second Windows host without disturbing Games.
- [x] Add pinned native initialization after revert and application execution
  after complete baseline, preserving test assertions and separate outputs.
- [x] Finish review and negative coverage:23 public checks (including33 Python
  transport checks),56 private manager checks, registry148 and syntax checks.
- [x] Freeze the public/private implementation commits for owner review and adoption.
- [ ] Report supported concurrency, measured overlap, blockers and adoption commands.
- [x] Propose ranked [speed and recovery work](../research/2026-10-26-test-speed-and-recovery.md).
- [ ] Adopting owners qualify their actual native/application/restart phases.

Scope is one isolated managed Windows host beside the reserved canonical or
strict legacy host. No canonical helper changes, live-device actions, new application features
or acceptance-policy relaxation are authorized by this testing stage.

Real pilot: `win-20261026T080334Z-3aea1aae`, 08:06:52–08:20:53UTC, about14m01s.
Its historical build0258 passed all9 baseline cases, with no failures,
cancellations, skips or TODOs. Managed and canonical hosts overlapped from
08:08:42 until Games' own teardown after its failed app journey around08:13.
Both used four remote CPUs/eightGB RAM; local tunnel ports were distinct.
The pilot's transport and host cleanup both returned0, resource state is
deleted, both captured local PIDs and the listener are gone. Canonical helper
and configuration bytes were not changed. Local pilot storage was513MB; about
4.6GB local RAM and42GB disk remained available after both Linux gates ended.

The pilot's optional hooks were absent. Their implementation has local negative
coverage and a separate owner qualification requirement. The completed pilot
does not qualify Games' new durable runtime or Chat's eleven-case baseline.
Games' new full148 and Chat's full155 Linux runs passed and retain their genuine
original receipts. Games' failed fullscreen/visibility app journey stays failed;
its owner is qualifying the private native harness before another full run.

Chat adopted the staged driver for its exact eleven-case baseline and native
hooks. Its first attempt failed the native helper's interactive-exit precondition
and is preserved as failed; the owner's exact child interruption allowed normal
transport/host cleanup. No installation/application acceptance is inferred.
That attempt exposed a receipt issue: exec changed the waiting wrapper's argv
at the same PID/start. A real-child regression now requires separate immutable
launch and observed-execution receipts, with the intended argv explicitly pinned.
The replacement driver does not alter the failed job's frozen controls.
