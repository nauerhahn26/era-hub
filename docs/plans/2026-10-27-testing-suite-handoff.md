# Testing suite handoff — 2026-10-27

Do not land this superseded research branch. Its testing tooling reached master
through separate rollouts; this branch contains unrelated application ancestry.

The completed release batch was Voice v1.0.23/build20261027.0013 (164 Linux
suites and12 Windows cases) followed by cumulative Lockout
v1.0.24/build20261027.0034 (167 Linux suites and12 Windows cases). All required
checks passed without exclusions. All six anonymous public downloads matched
each tested build. Both owners completed their source/cleanup handoffs, and the
shared source/resource hold was lifted.

Detailed status, source tuples, evidence hashes, limitations and next-work notes
are in `~/aac-board-builder--wt-testing-suite/docs/status.md`. Durable original
proof and seal records are under
`~/.local/state/era-release-coordination/lockout-voice-20261026/`.
The seal records include the additional app-transcript archive and tablet check;
the older canonical chat-backup script alone does not cover those transcripts.

The recorded final release handoff was Hubc601e32. Later independent testing
work legitimately advanced canonical Hub to96be1fb, including suite-result
reuse and the blocking gate waiter. Read CURRENT master `docs/dev-flow.md` and
the testing-parallelization plan before using recovery commands; retain their
remaining acceptance restrictions. New work syncs actual current masters before
collection and preserves resource admission plus serialized landing/publication.
Historical raw logs are not permission to manually mint a different green stamp.
