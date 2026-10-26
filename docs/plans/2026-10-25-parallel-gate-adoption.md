# Parallel full-gate adoption

Design: [testing strategy](../specs/2026-10-25-testing-strategy-design.md).
Owner: testing-suite. The maintainer authorized coordination with the queued
release owners, staged delivery and parallel full gates. Each release owner
alone may replace its own queued job. Existing running gates remain untouched.

## Availability

The source-isolation proof passed all 35 clothing cases. The standalone runner,
source snapshot and resource admission safeguards pass their synthetic and real
namespace preflight checks. A complete parallel gate pilot has not yet finished.
Do not treat these checks as a full landing or release stamp. Commands and
boundaries: [isolated full gates](../../tools/testing/parallel-worker.README.md).

Initial capacity is one isolated gate plus the reserved legacy gate lane,
subject to available RAM and CPU. Each isolated run has private sources, data,
network, processes, temporary files and reports. The candidate's unchanged gate
must issue its own genuine clean-tree stamp; missing suites or changed inputs
invalidate promotion. Final landing and publication remain serialized.

## Owner acknowledgments

| Release | Fixture stage | Queue / source coordination | Parallel adoption |
| --- | --- | --- | --- |
| Math | Existing run unchanged | Passed 132/0 and landed `e75e16c`; Windows acceptance follows separately | No migration requested |
| YouTube Videos | `2597549` includes `fe2e9e7`; file hash verified | Owner confirmed clean `6abdcf0` and active corrected legacy gate | Owner explicitly agrees to use the runner on a next necessary run after full pilot validation |
| Chat | Owner confirmed `654af54` | Frozen clean hub `28fc5be`, board `395d02b`; includes actual Math and cumulative YouTube source | Owner consents to first full pilot; narrow isolation prerequisites adopted |
| Games | Owner confirmed `783f083` | Frozen cumulative hub `7929a5f`, board `fca7f91`; board tree matches Chat's tested source | Owner explicitly agrees to adopt after first full pilot validates |

These are observations and acknowledgments at the time of writing, not a
reservation of publication order or version numbers. Recheck the original
worktree's clean source tuple immediately before collection. A snapshot protects
execution from source movement; it does not waive the requirement to include
current master when landing. Candidates can overlap usefully when later ones
already include the frozen earlier source, or when earlier changes have landed.

## Verification and timing

The unchanged old board route test required a public symbol-cache miss. The
necessary isolation prerequisites are hub `a9b68c4` (optional provider seams,
three provider tests and closed Reader seams) and board `cd841f3` (owned model
and route fixtures, all 11 cases green). Defaults for normal installations
remain the same. Chat adopted both before freezing the pilot candidate.

Namespace preflight proves a fresh PID namespace and mounted process view,
nonzero user identity with zero capabilities, hidden home except the owned job,
private runtime sockets and scratch mounts, independent fixed ports and locks,
and no external egress. The legacy cleanup stopped its owned inner canary while
the matching owned host canary survived. All modern skipped and todo counts
invalidate acceptance. Memory budgets are admission checks; sampled RSS and
host memory pressure are recorded, with no claim of an enforced memory cap.

Fixture commit: `fe2e9e7325436d46290bc286597a7239065ba0ce`.
File SHA-256: `8004285c50226315e0132fea5b77b1ee6b9fa6ac859b01e48dbed2328199b3ae`.
All 35 cases passed with zero failures, skips or cancellations; complete-file
wall time was 420.499 seconds on one CPU at low priority. The connection-drop
case took 15.498 seconds and the label-budget case 0.520 seconds. These fixture
improvements are secondary to the parallel-gate work.

The first full pilot started on 2026-10-26 at 00:06 UTC, job
`gate-20261026T000616Z-e0a2d99d`, using the frozen Chat tuple in the table. Its
complete expected inventory contains 139 suites. It runs alongside YouTube's
existing legacy gate. This original pilot retains its collected port and code;
new legacy starts are held while it runs. Future isolated jobs use 8388 so the
host legacy gate's 8378 cleanup cannot match them. Both cleanup directions and
nested namespace execution passed owned synthetic checks before that change.

No measured complete parallel-gate duration is available yet. Record the first
pilot's complete inventory, input verification, start/end times, peak resource
use and receipt location before giving a firm revised queue completion time.
