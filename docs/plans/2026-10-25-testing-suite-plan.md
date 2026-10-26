# ERA Hub testing suite audit and rollout plan

This research branch retains unpublished future Chat ancestry. Do not land it
into master. The independently scoped public rollout is `feat/testing-suite-rollout`;
its own fresh complete gate must qualify its exact source. Historical private
151-suite evidence remains archived without any changed stamp fields.

The maintainer authorized staged testing improvements and coordination with the
queued release owners. Bug detection remains the priority. Complete landing and
release acceptance is retained; conservative selection is for development.
The [audit](../research/2026-10-25-testing-suite-audit.md),
[strategy](../specs/2026-10-25-testing-strategy-design.md) and
[queued-suite review](../research/2026-10-26-queued-suite-audit.md) record the
research, coverage boundaries and maintenance rules. No entire suite was shown
to be unnecessary.

## Current rollout source

The public tooling candidate is prepared separately on `feat/testing-suite-rollout`
in the matching worktree. Its base is conditionally approved Games `0227f86`,
which already includes published Chat v1.0.16 and current master `67ff162`.
It extracts only testing infrastructure, tests and their documentation from the
research branch. It introduces no future Chat application code. Its inventory
is 147 suites, with six public Chat suites, three Games suites and four testing
infrastructure suites. Four future Chat suites remain reviewed draft metadata;
they become active only when their application sources are independently approved.

The original `feat/testing-suite` branch includes unpublished future Chat source.
Its complete native job at `3536a18` passed 151/151 on 2026-10-26, finishing at
05:03 UTC in about 34 minutes, with every suite once and zero modern failures,
skips, cancellations or todos. Its selected inputs matched before and after
execution, and the genuine original Hub and Board stamps were archived with the
reports and checksums. That historical pass qualifies only its exact source.
It does not qualify this separate 147-suite rollout or authorize future Chat.

The rollout incorporates reviewed Math fixture blob
`0666b15021d39374addaacea5c060139e410052d` before its fresh complete
147-suite gate. Games is adopting the same exact fixture independently. Games' separate fresh 143-suite
run on `0227f86` finished 142/143: the sole failure was a Math return-window test
that treated response headers as the completed application acknowledgment.
No green stamps were issued. The private fixture repair waits for consumption of
the real JSON response, then performs one return event and a synchronous duration
assertion with a restored monotonic clock. All 23 cases pass; forced ACK delay and
scheduler-stall checks pass, while the original 250 ms regression, missing shared
suppression and missing resume all fail. It changes no application runtime.
Whole-file diagnostics are not substitutes for the next complete candidate gates.

Games must finish its independently authorized source landing and exact-artifact
Windows acceptance before this tooling lands. Final landing, version choice and
publication remain serialized. Chat's next private preparation is complete with
147/147 Linux and 10/10 Windows; its maintainer instruction is prepare only.
Neither this tooling rollout nor Games may publish that future Chat feature.

## Parallel full gates

The standalone runner is available by absolute path to an owning clean worktree;
using it does not require merging the wider registry or development runner.
Initial capacity is one isolated gate alongside the reserved native lane: two
complete Linux gates total, subject to RAM/CPU admission. Each isolated job owns
its source snapshot, runtime, data, network, processes, temporary files and output.
It freezes all six selected repositories and validates originals before and after.
The candidate's actual complete gate must issue genuine clean-tree stamps.

- [x] Prove all 35 clothing cases with external network access unavailable.
- [x] Verify isolation, collection, source identity, admission and genuine stamps
  with negative checks and concurrent synthetic jobs; safeguards pass 40/40.
- [x] Run and obtain owner verification for Chat 140/140 isolated concurrently
  with Games 143/143 native, preserving all original receipts.
- [x] Measure overlap: about 36 minutes for the pair versus about 66 minutes
  summed individual durations, suggesting roughly 30 minutes saved for a pair.
  This is an observed estimate, not a controlled serial benchmark.
- [x] Coordinate Windows handoffs: published Chat v1.0.16 is complete; the next
  Chat private preparation finished and explicitly handed QA back to Games.
- [ ] Finish Games' required complete Linux/Windows evidence and serialized
  source/publication transaction, then land this separately tested tooling.

The isolated pilot took 34.03 minutes, sampled peak process-tree RSS 1.36 GiB and
minimum host available RAM 2.53 GiB. Memory budgets are admission checks, not
hard memory limits. Recheck at least 3 GiB available RAM before admitting the
second worker. Use native CPUs 0–1 at low priority beside isolated CPUs 2–3 on
the current four-CPU host. Linux gates do not acquire the Windows QA/release
locks; that remote native stage remains single-owner.

Current commands, original source pins, owner acknowledgments and Windows
limitations are in the [adoption record](2026-10-25-parallel-gate-adoption.md) and
[runner instructions](../../tools/testing/parallel-worker.README.md).

## Conservative development tools

The reviewed registry, complete-file planner, serialized development queue,
input verification, reporting and gate hardening are implemented. The clean
rollout's inventory check passes at 147; existing planner regressions pass 30/30.
The historical 151-suite complete gate also exercised the four infrastructure
suites. The rollout's own complete acceptance remains required after finalizing
its source; these checks cannot authorize a different tree.

Reviewed Math paths and Markdown under `docs/` can narrow development runs.
Changed suites, declared helper consumers, unresolved previous failures and
shared access smoke are included. Unknown paths, shared runtime, tooling,
uncertain helpers or fixtures and missing baselines select the full inventory.
The real documentation-only development job passed its six selected smoke and
scanner suites in about 28 seconds, with matching complete inputs and no full
stamp. This demonstrates development feedback, not release selection accuracy.

Every development-queue outcome deliberately retains `completeEvidence: false`,
including full jobs. Genuine complete gate outputs and original stamps checked
by the existing landing/release readers remain the acceptance authority. Preserve
both records without relabeling or rewriting their issue times.

A previous cumulative 147-suite job finished 146/147 because a Chat privacy test
searched only for a literal executable name. The corrected test verifies the
actual background launch and environment-clearing order for both supported
forms; its whole-file proof reproduced old 37/38 and corrected 38/38. The real
subprocess environment check remains. That failed job issued no accepted stamps.

The optional verification/landing transaction and compatible house helper were
tested on synthetic repositories. House reservation regressions passed 8/8 and
existing helper cases 131/131 with controlled fake session operations. The helper
is independent of the standalone parallel lane and has not been landed by this
rollout. Usage: [test planning](../../tools/testing/suite-runner.README.md).

The [reuse eligibility record](../research/2026-10-26-gate-reuse-eligibility.md)
distinguishes avoidable fixture-only repeats from actual shared runtime changes.
No composed, partial or relabeled receipt has been accepted. Existing recent
`docs/**/*.md`-only landing fallback remains the only narrow landing exception.

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
