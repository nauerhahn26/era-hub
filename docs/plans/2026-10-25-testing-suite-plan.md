# ERA Hub testing suite audit and rollout plan

Branch: `feat/testing-suite`. Research and audit are complete; implementation is
authorized in stages, prioritizing the releases already waiting for the gate.
The [audit](../research/2026-10-25-testing-suite-audit.md) and
[proposed strategy](../specs/2026-10-25-testing-strategy-design.md) are reviewable
recommendations. The first [test-only speedup stage](2026-10-25-testing-suite-speedups.md)
has passed all 35 cases in an isolated proof. Runner hardening and focused-job
tools are being verified separately. Acceptance requirements and live services
remain unchanged.

The [queued-suite supplement](../research/2026-10-26-queued-suite-audit.md)
reviews the six Chat and three Games files added since the original snapshot.
All protect distinct boundaries; none warrants deletion. Its registry metadata
remains a draft until those sources merge, so the active inventory cannot claim
files absent from its selected tuple.

The [reuse eligibility record](../research/2026-10-26-gate-reuse-eligibility.md)
distinguishes the avoidable fixture-only repeat cost from the new full
integration required after the shared speech and sorting runtime landed.
No composed or partial receipt has been accepted.

## Current priority: parallel full gates

The maintainer has prioritized isolated complete gates over the smaller fixture
savings. Deliver a standalone runner usable with an owning release's existing
gate, without requiring that release to absorb the wider registry, selection or
landing changes. Keep the existing active gate untouched. The initial capacity
is one isolated worker alongside the legacy lane, with host resource admission;
two complete gates is the total ceiling, not two additional gates.

- [x] Prove namespace execution with all 35 clothing cases and no skipped cases.
- [x] Snapshot clean selected sibling sources, complete required Git history,
  runtime and synthetic data; validate origins before and after execution.
- [x] Verify isolation, complete collection, resource admission and genuine
  gate-issued receipts with negative and concurrent synthetic tests.
- [ ] Run a consenting queued release's complete gate as the first real pilot.
- [x] Obtain owner acknowledgments of adoption and exact source tuples; timing
  remains provisional until the first complete pilot finishes.
- [ ] Coordinate cumulative source candidates and serialize final landing,
  version selection and publication; retain all required Windows acceptance.
- [ ] Measure actual overlap, memory and completion time before promising
  throughput or increasing capacity.

See the [adoption record](2026-10-25-parallel-gate-adoption.md). The implementation
order below remains the wider strategy; this priority supersedes its sequencing.

## Development-tool stage

The separate conservative planner, registry, serialized development queue and
gate hardening are implemented. Inventory validation covers 138 suites on this
branch. The combined targeted checks passed 84/84 with no skipped or todo cases;
the parallel safeguards separately passed 37/37 and their nested namespace proof.
These checks do not replace this branch's eventual complete acceptance gate.
Do not migrate the queued releases to the wider development-tool stage merely
to use the standalone parallel capability.

The optional hub-only verification/landing transaction and compatible house
helper were tested against synthetic repositories. They retain serialized
verification and are separate from parallel release preparation. The house
reservation tests passed 8/8 and the existing helper tests passed 131/131 with
session operations replaced by controlled fakes. No actual landing or session
operation occurred during those tests.

Usage and limitations: [test planning](../../tools/testing/suite-runner.README.md).

## Audit receipt

- [x] Read the house router, development flow, current status and testing code.
- [x] Check overlapping worktrees: chat changes the gate and introduces suites;
  weekly-video work changes Play/Watch/recipe suites. Do not edit their trees.
- [x] Inventory all 132 current gate suite files and associated hub test files,
  plus release, native Windows, OCR, diagnostic and CI boundaries.
- [x] Review primary research on selection, test layers, isolation, flakiness
  and input identity. Distinguish published observations from project choices.
- [x] Recover 119 modern-suite durations from a historical complete gate and
  verify all 132 copied suite sources against the selected current sources.
- [x] Deep-review the two slowest suites; identify weak assertions, avoidable
  fixture work and complete-file lifecycle constraints.
- [x] Record a staged strategy preserving full landing/release acceptance.
- [x] Research merge savings as well as edit cycles, prioritizing bug detection:
  verify the existing Markdown-only stamp fallback and evaluate complete result
  reuse, conservative impact selection and delayed full testing separately.
- [x] Assess multi-chat scheduling: verify current serial waiting, identify
  suite/provider ports and shared data/output conflicts, and specify a visible
  queue plus a measured isolation-first concurrency rollout.
- [x] Define cumulative parallel release preparation, explicit dependencies,
  ordered publication, skipped-version update paths and monotonic build IDs;
  distinguish that future workflow from current script capabilities.
- [x] Complete independent document review and artifact consistency checks.

Report validation passed: all 105 tracked hub test files are represented,
132 inventory rows identify current gate suites, all 119 timing rows agree
with the recorded total, and all 66 detailed clothing cases have distinct
source locations. Relative links and whitespace checks passed. The report
artifacts passed the privacy scanner with the private block and warning lists.
Independent review found no blocking factual or safety issue. These are report
checks, not a fresh functional gate or selector-effectiveness result.

## Proposed implementation order

Implementation follows the audit. Use dedicated
matching worktrees when correcting tests owned by sibling repositories. Recheck
chat's gate edits and other overlap before editing common files.

1. Write failing runner tests first using synthetic workspaces: missing suites,
   duplicate names, collection failures, live-source/data/port refusal, occupied
   ports, wrong server readiness, source changes during execution, and focused
   results accidentally producing a full stamp.
2. Fix explicit source/data/origin propagation and owned-process cleanup. Keep
   external services isolated and use the gate lock until resource sharing has
   been removed. Verify that all existing suites exercise the selected source.
   Add visible queued/running/finished job records while retaining one legacy
   worker; preserve input identity when a job waits.
3. Strengthen phonetic/personal-lexicon checks, the missing-tile fixture,
   segmentation readiness and deterministic freshness boundaries. Preserve
   intentional contract constants and meaningful complete journeys.
4. Repair slow clothing fixtures. Check the drop fake's socket closure and
   isolate the label-budget catalog. Measure before/after on the same inputs;
   retain production spacing and timeout protections.
5. Add a reviewed registry and discovery verification, explicit native/VM/tool
   stages, and per-suite timing/outcome reports. Repair or retire the obsolete
   direct `tests/all.sh` entry point with documented replacement instructions.
6. Add a safe complete-file focused runner with conservative impact rules,
   explicit selection reasons, cumulative diffs across selected repos, and full
   fallback for uncertainty. Test staged/unstaged/new/deleted/renamed inputs,
   changed helpers, missing baselines and multi-repository combinations.
7. Compute selections during complete gates. Replay historical regressions and
   isolated fault probes. Report missed failures, genuine failing-change recall,
   unknown-path fallback and net time saved; all-green samples leave recall
   unknown. Keep full acceptance gates while developing this evidence.
8. Preserve and document the existing recent Markdown-only landing fallback.
   Review any proposed broader allowlist against test and payload inputs; root
   `README.md` ships in the payload, and CSV/HTML are outside the exception.
9. Only then consider bounded parallel units or input-complete result reuse.
   Isolate each job's data, source inputs, output and every endpoint; compare
   native dynamic-port fixtures with a prepared isolated-network runner for
   legacy fixed ports. Test two jobs with different fixtures, concurrent failure,
   owned-child cancellation, occupied endpoints, input changes while waiting,
   resource limits and independent receipts. Benchmark serial versus a trial of
   two workers for throughput, memory, latency and failure stability. Use one
   global capacity budget across jobs and suites; retain exclusive resources
   where measurements or native stages require them.
   Evaluate a composed merge receipt in which every required suite has current
   or validated earlier evidence. Preserve original run times and reject stale,
   failed or unknown-input results. Update development rules and all stamp
   readers together before broadening acceptance policy. Keep candidate-byte
   Windows checks. Release publication continues to require the maintainer.
10. Add a cumulative release queue with synthetic tests before implementation:
    S + A and S + A + B candidates; explicit A/B dependencies; earlier failure,
    withdrawal or modification; combined-only failure; completion out of order;
    and unexpected latest/installer changes. Use private candidate artifacts,
    monotonically ordered build identities and complete input/receipt binding.
    Verify both supported-baseline-to-second and materially distinct
    first-to-second update paths, including persistent state. Serialize final
    publication and required published checks, with explicit maintainer
    authorization. Fix shared release logs and VM output cleanup before
    overlapping candidate preparation; retain VM capacity limits until proven
    otherwise. Never publish a later branch snapshot that drops accepted earlier
    changes, or relabel changed artifacts with an old passing receipt.

## Acceptance and upkeep

Runner hardening and selection need focused negative tests followed by the full
gate, detached with an owned PID and completion sentinel. Record native Windows
evidence separately when applicable. Never use a partial run as a green landing
stamp. Keep documentation nearest the change in the same implementation commit.

New tests must declare their behavior/regression, responsible module,
dependencies, stage and resources. Review runtime/reliability monthly and
overlapping scenarios quarterly. Test retirement needs a replacement or a
retired requirement; test count reduction is not the objective.

## Audit retrospective

The clearest savings are avoiding unrelated complete development runs and
repairing expensive fixture work. The most consequential findings concern
correctness: wrong-source/live-data fallbacks, silent collection omissions, and
assertions whose names promise more than they verify. A complete historical
green run does not disprove these gaps. The inventory records review depth so a
file-level survey cannot be mistaken for exhaustive mutation/coverage evidence.
