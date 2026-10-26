# Parallel full-gate adoption

Design: [testing strategy](../specs/2026-10-25-testing-strategy-design.md).
Owner: testing-suite. The maintainer authorized coordination with the queued
release owners, staged delivery and parallel full gates. Each release owner
alone may replace its own queued job. Existing running gates remain untouched.

## Availability

The source-isolation proof passed all 35 clothing cases. The standalone runner,
source snapshot and resource admission safeguards pass their synthetic and real
namespace preflight checks. Two complete 139-suite pilots finished red because
of fixture defects; their results were never accepted as green. The current
combined-runtime Chat and Games gates are running with all known fixture repairs.
Do not treat preliminary checks as a full landing or release stamp. Commands and
boundaries: [isolated full gates](../../tools/testing/parallel-worker.README.md).

Initial capacity is one isolated gate plus the reserved legacy gate lane,
subject to available RAM and CPU. Each isolated run has private sources, data,
network, processes, temporary files and reports. The candidate's unchanged gate
must issue its own genuine clean-tree stamp; missing suites or changed inputs
invalidate promotion. Final landing and publication remain serialized.

## Owner acknowledgments

| Release | Fixture stage | Queue / source coordination | Parallel adoption |
| --- | --- | --- | --- |
| Math | Existing run unchanged | v1.0.13 completed 132/0 plus Windows 8/8 | No migration requested |
| YouTube Videos | `2597549` includes `fe2e9e7`; file hash verified | v1.0.14 completed 132/0 plus Windows 8/8 | Owner explicitly agrees to use the runner on a next necessary run after full pilot validation |
| Speech and sorting follow-up | Existing legacy lane | v1.0.15 completed 133/0 plus Windows 8/8; actual Hub `cbfbb8d` and Core `02377c5` are now predecessors | Owner confirms no further repository landings during the Chat/Games batch |
| Chat | Fixture stages and both Reader repairs adopted | Frozen Hub `81fcabb`, Core `02377c5`, Board `395d02b`; every dependency is pinned in matching worktrees | Full 140-suite isolated run started 01:54 UTC, port 8388, two CPUs |
| Games | Same fixture repairs adopted before collection | Frozen Hub `c097524`, Core pin `02377c5`, Board `fca7f91`; 143-suite inventory verified | Full 143-suite legacy run started 01:56:53 UTC on 8381 alongside Chat |

These are observations and acknowledgments at the time of writing, not a
reservation of publication order or version numbers. Recheck the original
worktree's clean source tuple immediately before collection. A snapshot protects
execution from source movement; it does not waive the requirement to include
current master when landing. Candidates can overlap usefully when later ones
already include the frozen earlier source, or when earlier changes have landed.

The active Chat job is `gate-20261026T015400Z-b27fb428`. Games owns its separate
legacy job and completion sentinel. The initial intended ordering changed when
the speech/sorting release was authorized and shipped first. Both candidates
now include that actual runtime. New publication still requires each owner's
authorization; Games publication has not been inferred from test coordination.

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

The first pilot completed all 139 suites with 137 passing and two failing; no
green stamp was issued or accepted. Music still required an external numeric
symbol image, and the Reader reload case inspected the populated index before
the shelf rendered and restored its saved position. The narrow fixes retain all
12 Music and 17 Reader cases: Music owns its provider and verifies exact image
identity plus cache behavior; Reader waits for independent rendered-grid
readiness after both navigations while retaining the original state assertions.
Both complete files passed in fresh no-egress namespaces. These test changes
require a fresh complete candidate gate under the existing acceptance policy.
