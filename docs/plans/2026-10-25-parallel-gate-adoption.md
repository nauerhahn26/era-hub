# Parallel full-gate adoption

Design: [testing strategy](../specs/2026-10-25-testing-strategy-design.md).
Owner: testing-suite. The maintainer authorized coordination with the queued
release owners, staged delivery and parallel full gates. Each release owner
alone may replace its own queued job. Existing running gates remain untouched.

## Availability

Two complete Linux gates have now passed concurrently: Chat's isolated pilot
passed 140/140 and Games' legacy gate passed 143/143. Both owners verified their
full source tuples, runtime inputs, complete collection and genuine stamps.
The standalone runner's safeguards also pass 40/40 synthetic and real namespace
checks. Two earlier 139-suite pilots finished red because of fixture defects;
their results were never accepted as green. Commands and boundaries:
[isolated full gates](../../tools/testing/parallel-worker.README.md).

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
| Chat | Fixture stages and both Reader repairs adopted | Tested Hub `81fcabb`, Core `02377c5`, Board `395d02b`; every dependency pinned in matching worktrees | Full 140/140 isolated run, 01:54–02:28 UTC, port 8388, two CPUs; original stamps privately archived before allowed documentation sync |
| Games | Same fixture repairs adopted before collection | Tested Hub `c097524`, Core `02377c5`, Board `fca7f91`; complete fingerprint unchanged at postflight | Full 143/143 legacy run, 01:56:53–02:29:14 UTC on 8381 alongside Chat; owner postflight verified at 02:29:49 UTC |

These are observations and acknowledgments at the time of writing, not a
reservation of publication order or version numbers. Recheck the original
worktree's clean source tuple immediately before collection. A snapshot protects
execution from source movement; it does not waive the requirement to include
current master when landing. Candidates can overlap usefully when later ones
already include the frozen earlier source, or when earlier changes have landed.

The completed Chat job is `gate-20261026T015400Z-b27fb428`; its private
`verified-receipt` retains all six original stamp bytes and hashes, manifest,
result and resource observations. Games owns its separate legacy job and
completion sentinel; its verified postflight is recorded with that job. The
initial intended ordering changed when
the speech/sorting release was authorized and shipped first. Both candidates
now include that actual runtime. New publication still requires each owner's
authorization; Games publication has not been inferred from test coordination.

Chat acknowledged its normal Board then Hub landing and patch build under the
shared release/VM locks. The accepted source is `e3a03653` after documentation
changes only. Games acknowledged waiting for Chat's lock handoff before its own
Windows acceptance. Windows, version selection and publication remain in series;
each release still runs its required complete Windows leg. Testing will not land
into master during this release window.

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
`gate-20261026T000616Z-e0a2d99d`, using the earlier Chat candidate `28fc5be`.
It ran alongside YouTube's legacy gate. Its collected port and code remained
unchanged. Later isolated jobs use 8388 so the host legacy gate's 8378 cleanup
cannot match them. Both cleanup directions and nested namespace execution
passed owned synthetic checks before that change.

The first pilot completed all 139 suites with 137 passing and two failing; no
green stamp was issued or accepted. Music still required an external numeric
symbol image, and the Reader reload case inspected the populated index before
the shelf rendered and restored its saved position. The narrow fixes retain all
12 Music and 17 Reader cases: Music owns its provider and verifies exact image
identity plus cache behavior; Reader waits for independent rendered-grid
readiness after both navigations while retaining the original state assertions.
Both complete files passed in fresh no-egress namespaces. These test changes
require a fresh complete candidate gate under the existing acceptance policy.

The second complete pilot passed 138/139 and exposed a separate Reader fixture
that claimed an alphabetical tie while generating distinct date keys. Commit
`309b603` makes those keys equal and asserts that precondition; all 17 Reader
cases passed with an adversarial clock that made the old fixture fail. Both
final candidates also include the subsequently published real shared speech and
sorting changes; their integration required the fresh complete 140/143 gates.

The successful isolated gate took 2,041.778 seconds (34.03 minutes), including
every expected suite once, with all modern skipped and todo counters zero.
All six genuine stamps retained their original issue time. The memory monitor
recorded 1,016 valid samples, peak tree RSS 1,457,807,360 bytes (1.36 GiB), minimum
host available RAM 2,720,542,720 bytes (2.53 GiB), and at most 130,154,496 bytes
(124 MiB) additional host swap. These are sampled observations, not hard limits.

The aligned pair completed and was verified in about 36 minutes. Summing the
observed individual gate durations gives about 66 minutes, suggesting roughly
30 minutes of throughput savings for a similar pair. This is an estimate from
the overlapping runs, not a controlled serial benchmark or a claim that the
initial rollout avoided its earlier fixture-repair and source-order delays.
Full Windows tests and publication add their own serialized time.
