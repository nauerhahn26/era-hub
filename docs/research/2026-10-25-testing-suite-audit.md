# ERA Hub testing suite audit

Keep the meaningful regression coverage and select development runs by affected
behavior and dependencies. Keep complete evidence before landing, including
the existing narrow documentation reuse rule, and the Windows checks for each
release shape. First fix execution isolation,
discovery gaps and several assertions that provide less protection than their
names imply. There is no evidence from this audit to delete an entire current
gate suite.

This is a static audit with deeper review of the two slowest suites and selected
integration boundaries. The [66 clothing cases](2026-10-25-testing-suite-clothing-cases.csv)
and eight book-sharing cases received full assertion/lifecycle review; the
other 90 modern hub files received a file-level survey with targeted assertion
sampling. Every suite has a file-level purpose and disposition in
the [inventory](2026-10-25-testing-suite-inventory.csv). That inventory is an audit
snapshot, not an executable dependency map or proof that every assertion is
necessary. No tests, hubs, Windows hosts, releases or device actions were run for
this audit. Historical timing evidence is identified separately below.

The [proposed strategy](../specs/2026-10-25-testing-strategy-design.md) describes
selection and its safeguards. The [implementation plan](../plans/2026-10-25-testing-suite-plan.md)
orders the work. Current runner behavior and gate requirements are unchanged.

## Scope and current execution

The captured source snapshot is hub `b3de595`, core `0cffc72`, board `bd3733d`,
Making Words `9b2daa9`, and Pencil `bd43dbb`, using the sibling sources resolved
by the gate without a worktree suffix. These identify the audit inputs rather
than moving branch tips.

| Source | Modern Node suites | Legacy browser suites | Total in Linux gate |
| --- | ---: | ---: | ---: |
| Hub | 93 | 0 | 93 |
| Core | 6 | 0 | 6 |
| Board | 19 | 0 | 19 |
| Making Words | 1 | 12 | 13 |
| Pencil | 0 | 1 | 1 |
| Total | 119 | 13 | 132 |

The gate flattens these repositories' `tests/` directories into `gate/`, rewrites
the old server port in the copies, runs a fixed list of thirteen legacy files,
then runs top-level `*.test.mjs` files sequentially. See
[collection](../../tools/era-gate.sh#L132) and
[execution](../../tools/era-gate.sh#L190).

The inventory covers all 105 tracked files under the hub's `tests/`, all 39
imported executable suite files, three VM legs and their three helpers, four OCR
tool suites, two native gaze regressions and their drivers, and both CI workflows.
One referenced private migration-tool test and the house landing helper and its
regression suite are recorded for completeness; this does not audit the entire
private workspace. There are 163 inventory entries, including fixtures, helpers,
diagnostics and runner/configuration files. The landing-helper review uses the
house repository's `e241c23` snapshot.

Important boundaries:

- The three Windows VM legs are release checks, not part of the Linux gate.
  Fresh install, installed self-update, and published signed download exercise
  distinct failure paths. The patch flow already selects only the update leg.
- Native gaze overlay and volume regressions require separate Windows runs.
  Source-constant checks and a Linux green stamp do not establish native success.
- The four `tools/ocr-bakeoff/test/` suites are outside the gate glob. Run them
  when their tool changes; they need an explicit place in the future registry.
- The five `tests/pixel-audit/` scripts are diagnostics. In particular,
  `audit.js` catches scenario failures and writes results without converting
  measured violations into a failing process. Treat its output as investigation,
  not acceptance evidence.
- CI currently scans for private material and checks syntax. Installer CI builds
  an artifact. Neither workflow executes the functional gate.
- The hub's `tests/all.sh` is an obsolete direct entry point: its legacy scripts
  now live in sibling repositories. The gate imports those scripts separately.
  Current imported `run.js` and `pencil.js` use the shared door correctly; an older
  status note about their obsolete door selector is not grounds to retire them.

## Measured cost

The recorded complete Math gate from 2026-10-25 contains 132 suite outputs.
All 132 copied suite sources match this audit's selected sources after the
gate's port rewrite. The 119 modern TAP summaries contain durations totaling
**1,807.8 seconds, or 30 minutes 8 seconds**. This excludes legacy suites,
assembly, hub startup, queueing and Windows checks. It is one historical run,
not a current benchmark or reliability distribution. The
[timing table](2026-10-25-testing-suite-timings.csv) preserves all 119 values.

| Modern suite | Seconds in that run |
| --- | ---: |
| `clothing.test.mjs` | 563.0 |
| `clothing-accessories.test.mjs` | 181.6 |
| `drawing-ui.test.mjs` | 102.6 |
| `play-ui.test.mjs` | 63.7 |
| `clothing-responsive.test.mjs` | 58.8 |

The two clothing suites consume **41.2%** of measured modern-suite time. At the
other end, 49 modern suites each finish in under one second and together take
19.4 seconds. Isolation and resource needs still matter when deciding whether
these belong in a cheap default group. Labels such as unit or integration alone
do not predict cost.

Two expensive cases deserve fixture repair before removing coverage:

1. The label-budget case in `clothing.test.mjs:851` takes 85.2 seconds. It replaces
   the catalog with two named garments but leaves earlier source photos in place.
   The recorded output shows eleven unrelated photos being cataloged again.
   Give this case its own consistent catalog/photo fixture, or use the existing
   rebuild-only boundary where that preserves the intended label integration.
2. The dropped-connection case at `clothing.test.mjs:988` takes 134.1 seconds and
   records a timeout. Its fake destroys the request after consuming its body;
   production has a 120-second timeout. Investigate closing the actual response
   or socket promptly so the fake proves an immediate transport drop. Keep a
   separate deterministic timeout assertion if needed. This is a supported
   explanation to verify, not an implemented speedup.

The worker intentionally waits five seconds after an AI ingestion request
(`clothing-worker.js:1044`), and transport retries also have a deliberate delay.
Do not lower those production protections to accelerate tests. Keep real image,
worker, transport and board integration coverage; move unrelated fixture work
out of cases that do not need it. The final complete gate is the comparison for
any later refactoring.

## Findings to fix first

### Test execution can use the wrong source or data

`era-board/tests/board-routes.test.mjs:14` resolves the main hub, including when
copied into a feature worktree's `gate/`. Its data directory falls back to the
private live directory at line 15. It starts a hub using those paths at line 34
and deletes/recreates a symbol cache file at lines 95–105. The board-model suite
also falls back to the live recipe at lines 11–25.

The gate sets its local `DATA` variable to test data but passes `ERA_DATA_DIR`
only to assembly and the shared hub. It does not export that variable to the
suite process. Unless the caller supplies it, the fallback remains reachable.
These are verified source paths; no live writes were attempted or observed in
this audit. Use explicit selected hub sources and owned synthetic fixtures, and
reject live-data paths before executing any test.

Direct execution is also unsafe for suites such as `icons.test.mjs:14`, which
defaults to the live hub and can POST setup at line 40. Prediction tests and the
invariants helper also default to the live origin. A focused runner must provide
the same isolation as the complete runner. Do not recommend a raw
`node --test tests/*.test.mjs` invocation as a shortcut.

The gate accepts an unchecked `ERA_TEST_PORT` and uses a broad process-name
match to clear that port (`era-gate.sh:182`). Replace that behavior with port
validation and refusal when occupied. Cleanup must address only an owned,
recorded and verified child PID. A declared test port is not proof of ownership.

### Discovery can silently lose coverage

The collector silently skips missing test directories and overwrites duplicate
basenames (`era-gate.sh:136`); the legacy loop skips absent files at line 194.
No current top-level collision was found. Nevertheless, adding selection to
this discovery model could hide missing coverage. Fail on missing registered
tests, duplicate identities, collection failures and unclassified executable
tests. Preserve each suite's source identity in reports.

Only dirty tracked content is considered by the stamp writer. Source trees and
test files are read throughout the run, and the final stamp identifies hub or
individual sibling trees rather than the complete tested workspace, assets and
environment. Record the resolved inputs before a run, verify they remain stable
afterward, and refuse reusable success if they changed. Treat new source/test
files as inputs while allowing declared generated output directories.

`release.sh:183` can reuse a recent stamp when differences are confined to
`tools/`, `tests-vm/` and `docs/`. Some tools are themselves gate-tested, so this
exception is broader than a general claim that those changes cannot affect a
test. Inventory those dependencies before expanding result reuse. The later
build and VM run remain required by the existing release flow.

### A few assertions do not prove their named behavior

| Evidence | Problem | Disposition |
| --- | --- | --- |
| Making Words `tests/phonetic.js:29` | `regex.test(w) || true` always accepts each word; only nonemptiness remains | Repair the literal-prefix assertion using an explicit controlled fixture |
| Pencil `tests/pencil.js:63` | The claimed personal-lexicon check also accepts any nonempty prediction list | Retain the journey; make the lexicon case distinguish the expected result |
| Hub `tests/clothing.test.mjs:835` | The missing-tile catalog entry has no source photo; pruning removes it before tile filtering | Supply a source-backed entry and suppress repair through the intended boundary, then prove omission and continued board availability |
| Hub `tests/clothing.test.mjs:451` | A test named runtime loadability accepts a null cutout, while initialization failures also return null | Assert runtime readiness separately from valid no-object and graceful-fallback behavior |
| Hub `tests/clothing.test.mjs:345` | Early execution hours skip both morning-freshness boundary assertions | Test the boundaries with a deterministic clock |
| Core `tests/lib-contract.test.mjs:111` | A placeholder identity assertion has little evidence of user-facing value | Review the API promise; replace or retire only this assertion if the promise is unnecessary |

The speech-engine and speech-overlap suites also contain mock-mode checks whose
names imply stronger cancellation behavior than they prove. Preserve the real
late-response regression in `speech-barge-in.test.mjs`, and map exact scenarios
before consolidating the other files. Passing test counts alone would conceal
these differences.

### Apparent duplication often protects different boundaries

The book-sharing tests are a useful example. `erabook` checks archive format and
malicious input; `books-share` checks policy and placement; Reader sheets check
adult interactions; `book-sharing-e2e` transfers between two real hubs and opens
the result. Keeping all those boundaries is justified even though all concern
sharing.

Likewise, pure Math arithmetic tests cannot establish gaze rearming, interrupted
speech or DOM geometry. Controlled browser routes do not prove real hub APIs.
Linux source checks cannot prove installed Windows behavior. Source-level
constants can be deliberate requirements: the clothing migration design
explicitly requires the constants pinned in `clothing-rank.test.mjs`.

Potential consolidation should start with duplicate setup and repeated boundary
conditions in the same layer. The narrow-screen legacy suite and modern layout
suite merit scenario mapping, as do the two older speech suites. Neither pair
has been established as wholly redundant.

Maintainability improvements include replacing literal source-marker extraction
in `device-volume.test.mjs:25` with a stable behavioral boundary, and preserving
the accessories compatibility comparison through an explicit versioned fixture
instead of requiring `git show` of historical commit `c1a0195`. Shallow checkouts
and source archives may not contain that commit. Neither observation justifies
deleting the underlying regression.

## Reducing the merge gate and release work

The maintainer requested research on both development selection and final
acceptance, with bug detection first. Several approaches are materially
different:

| Approach | Assessment for this repo |
| --- | --- |
| Reuse a recent complete result after documentation-only changes | Already supported narrowly by the house landing helper; retain its explicit conditions |
| Repair fixtures, share safe setup and order fast checks first | Useful now without reducing the required behaviors; measure improvements |
| Reuse unchanged individual suite results | Promising after isolation and complete input tracking; current evidence is insufficient |
| Require all dependency-affected suites plus a stable shared smoke at merge | Possible later, with a validated conservative map, full fallback and separately specified receipts |
| Run a short merge subset and defer the complete gate until after merge/nightly | Detects some bugs only after main has changed; inconsistent with the current priority as an initial policy |
| Omit checks because a change is small or tests seldom fail | Reject; neither establishes independence from the change |

There is an existing optimization that the short development instructions do
not spell out: when the exact-tree stamp file is absent, house
`tools/worktree.sh:155–169` accepts an ancestor's green stamp when every changed
path matches `^docs/.*\.md$`. An existing stale or dirty exact-tree stamp does
not trigger this fallback. Reuse still requires a clean green stamp under two
hours old and
the normal ancestry/integration checks. `tools/worktree.test.sh:392–422` covers
accepting Markdown documentation changes and refusing a tools change. This is
read source evidence, not a newly executed house test. It does not cover every
file colloquially called documentation: root `README.md`, CSV, HTML, tools and
tests do not qualify. A README under `docs/` does match the rule. Do not reset
the old receipt's time to manufacture freshness.

A broader documentation exemption needs dependency review. `build-payload.sh:104`
copies `README.md` and license/notice material into the installed payload.
The test-source search found documentation mentions mainly in comments, not an
executed read of `docs/` Markdown; that search is evidence for a narrow candidate,
not proof that every tool or external consumer ignores documentation. Maintain
an explicit exclusion from the allowlist when a document becomes an executable
input. The audit's CSV artifacts themselves do not qualify for the existing
Markdown-only fallback.

For code changes, the strongest future optimization is retaining complete
verification while reusing valid earlier results for suites whose full inputs
are unchanged. A mature build tool's
[test-result cache documentation](https://bazel.build/docs/user-manual#cache-test-results-yesnoauto--t)
illustrates this distinction: changed tests/dependencies, external tests and
failed tests rerun; an out-of-date result is not success. This is a design
pattern, not a proposal to adopt that tool or claim this repo already has its
guarantees.

The longest current suites are poor initial cache targets because they use wall
clocks, shared mutable fixtures, real worker processes or deliberate timing
measurements. Pure deterministic suites are easier, but the 49 subsecond suites
total only 19.4 seconds in the recorded run. Avoid building an elaborate cache
for that small benefit before repairing the slow fixtures and isolated inputs.
Do not cache a responsiveness or native-environment check merely because source
files match. Continue performing representative current-environment smoke and
candidate artifact checks.

Any future composed merge receipt must account for every required suite,
identify fresh executions versus verified reused results, retain original run
times, bind the current integration inputs, and reject unknown, failed, stale
or missing evidence. Every stamp reader must understand that receipt before it
can authorize a merge. A selected pass must never be relabeled as an existing
complete-gate pass. Keep complete shadow runs and replayed regressions while
developing this system, with periodic full validation afterward if adopted.

Releases already make a justified selection: patches retain the signed
installer and run installed-update leg B; signed releases exercise fresh install
and update, followed by their published-download check. Keep those candidate-byte
checks. Avoiding an unnecessary second Linux gate through a valid existing stamp
is preferable to removing Windows evidence for the path users actually take.

## What research supports

Selection should use dependencies and observable behavior, with new tests,
previous failures and a full fallback when analysis is uncertain. The
[Test Impact Analysis documentation](https://learn.microsoft.com/en-us/azure/devops/pipelines/test/test-impact-analysis?view=azure-devops)
documents these safeguards and periodic full runs. That implementation targets
managed code; its policy pattern is relevant here, not its runtime tooling.

Dependency tracking must include external files and cumulative changes since
the relevant tested baseline. The original
[regression-selection dissertation](https://users.ece.utexas.edu/~gligoric/papers/Gligoric15PhD.pdf),
§2.3 and §3.2.4, also discusses limits from nondeterminism, external processes
and networking. For this repo, the inference is that a JavaScript import graph
or Node coverage alone misses browser loads, HTTP/DOM contracts, worker files,
copied sibling assets, fixtures and installer behavior.

The firsthand [predictive-selection report](https://engineering.fb.com/2018/11/21/developer-tools/predictive-test-selection/)
describes strong empirical results from a large historical dataset while still
running exhaustive tests before deployment. It does not establish zero missed
regressions or a comparable guarantee for this project. A simple explicit map
is a more appropriate starting point than a learned predictor here.

The author of [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html#AvoidTestDuplication)
recommends reducing repeated detail across layers while retaining integration
confidence and ordering feedback by speed and scope. This supports focused
lower-level checks plus a few complete journeys. An eye-gaze interface still
needs substantial real-browser coverage for geometry, dwell and escape actions.

[Playwright's guidance](https://playwright.dev/docs/best-practices) favors
observable behavior, independent test data and controlled third-party responses.
The firsthand [flakiness report](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html)
explains how retries and quarantine can hide genuine defects. Keep the first
failure visible; fix its cause instead of treating a retry as equivalent to an
uninterrupted pass. A real responsiveness threshold can protect a real freeze:
the existing 900 ms clothing check needs workload and timing context, not an
automatic deletion or tighter threshold.

[Hermeticity guidance](https://bazel.build/basics/hermeticity) connects reliable
reuse with input identity and environmental isolation. Borrow that principle
without adopting a new build system. A hub tree alone cannot identify all the
inputs consumed by this multi-repository gate.

## Gates requested by multiple chats

The current runner serializes full gates with a machine-wide lock at
`era-gate.sh:34–36`; a read-only process/lock check found an active gate and a
second request waiting. Serial runs therefore already work. They do not yet
have a managed queue with clear ownership, progress and scheduling policy.

Port conflicts extend beyond the shared gate hub. Examples include the fixed
fake service in `clothing-accessories.test.mjs:38` and the engine stand-in in
`routes.test.mjs:154`, whose occupied-port path skips the stand-in scenario.
The gate defaults to shared test data, and its generated `gate/` directory is
shared by invocations in the same worktree. Changing the main test port alone
cannot isolate full runs. Separate processes also do not isolate TCP ports or
filesystem writes.

The proposed sequence is a visible queue with one legacy worker, then private
job inputs/data/outputs and complete endpoint injection or per-job network
isolation, then a measured trial of two concurrent workers. Independent pure
tests can use spare capacity earlier once their lack of shared resources is
verified. Stateful cases keep their order. Responsiveness checks, heavy image
work and native/VM stages need declared capacity or exclusive resources.

The [concurrency design](../specs/2026-10-25-testing-strategy-design.md#concurrent-gate-jobs-from-different-chats)
includes both parallel full gates across chats and parallel suites within a
gate, queue freshness, cancellation ownership and separate receipts. Every
successful job must still account for the complete required inventory. No
second full suite was launched, lock bypassed or running job changed here.

## Recommended decisions

1. Keep every meaningful current suite, repair the specific weak assertions,
   and make execution safe before introducing a new focused command.
2. Select complete suite files for developer feedback. Include affected
   dependencies, changed/new tests, shared helpers/fixtures and previous
   failures. Several files intentionally share mutable setup across cases;
   selecting individual test names would invalidate their lifecycle.
3. Keep complete pre-landing and release requirements and the existing narrow
   documentation reuse rule. Broad shared changes,
   unknown paths and uncertain baselines expand to the complete applicable
   suite. A short diff is not a lower-risk classification.
4. Compute proposed selections during complete runs and compare the result
   with what actually failed. Replay known regressions and isolated fault
   probes; an all-green period cannot measure failure recall.
5. Require a behavior/regression reason, dependencies, stage, environment and
   responsible module for each new test. Automate registry/discovery agreement.
   Review the slowest and least reliable cases monthly and overlapping scenarios
   quarterly. Remove a test only when equivalent protection or a retired
   requirement is documented.
6. Give chats a shared queue and job status. Preserve serial legacy execution
   until complete jobs are isolated; then benchmark bounded concurrency with
   one global resource budget and separate acceptance evidence for each job.
7. Prepare cumulative release candidates: verify S + A and S + A + B in parallel
   where capacity allows, then publish in a checked order. Two branch passes do
   not prove their combination. Hold or rebuild later candidates when earlier
   changes fail, change or are removed. Keep devices that skip an intermediate
   release in the update test matrix. The strategy records existing build-ID,
   shared-log and VM-output limitations that must be fixed before closely spaced
   prepared releases are safe.

Open worktrees that overlap future implementation are `feat/chat`
(`tools/era-gate.sh` and new suites) and `feat/youtube-videos` (Play, Watch and
weekly-recipe suites). Recheck their current state before making runner or test
changes. This audit did not edit their files.
