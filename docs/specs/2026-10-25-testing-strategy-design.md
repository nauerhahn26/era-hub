# Proposed ERA Hub testing strategy

Run tests according to affected behavior, shared dependencies and the delivery
stage. Preserve complete gate evidence before landing, its existing narrow
documentation reuse rule, and release-shape Windows checks. A focused development
result must never create a full green stamp. This proposal follows the
[audit](../research/2026-10-25-testing-suite-audit.md); it does not change current
development rules or implement a selector.

## Test stages

Every edit does not run every test. Development uses affected suites and shared
smoke. Initially each distinct integrated code candidate needs complete Linux
regression evidence before landing/release; a still-valid matching complete
result can satisfy a later stage without repeating that Linux run. Tools,
diagnostics and native-platform checks have their declared triggers, and Windows
release checks follow the release shape. Validated reuse may later reduce fresh
execution further, while retaining evidence for every required behavior.

| Stage | Required checks | Success means |
| --- | --- | --- |
| Editing | Applicable syntax/privacy checks; changed/new tests; previous failures; affected whole suite files | Feedback on the current edit |
| Feature review | Relevant suites plus a small shared access/navigation smoke; all affected cross-feature consumers | Evidence for the feature, without a landing stamp |
| Landing | Complete registered Linux gate against stable selected inputs, or the existing eligible recent documentation-only reuse | Existing acceptance requirement satisfied |
| Patch candidate | Complete gate and Windows installed-update leg B against candidate bytes | Existing patch acceptance |
| Signed candidate | Complete gate, Windows fresh-install A and update B; published-download C at its existing stage | Existing signed-release acceptance |
| Native gaze change | Relevant native Windows regressions as well as applicable Linux tests | Explicit native evidence, separately identified |

An editorial-only change can use privacy, documentation and link checks while
editing. The house landing helper already permits reuse of an ancestor's clean
green stamp under two hours old when every intervening path is Markdown under
`docs/` and the exact-tree stamp file is absent. An existing stale/dirty exact
stamp blocks that fallback. Root `README.md`, CSV and HTML do not qualify;
`docs/README.md` does. Broader exceptions need reviewed policy and evidence that
their files are not consumed by tests, generation or builds. The audit's
merge/release assessment records the implementation and tests of the exception.

## Selection rules

Select complete files initially. Tests such as clothing and two-hub book
sharing deliberately carry state between cases. No test-name filtering or
reordering until the fixture lifecycle is independent and verified.

The selected set is the union of:

- Registered always-required inexpensive checks for the current stage.
- Suites affected by all changes since the relevant baseline, across every
  resolved source repository, including staged, unstaged, new and deleted files.
- Added or modified tests, plus all consumers of changed helpers and fixtures.
- Previously failing suites until the failure is resolved and recorded.
- Additional suites requested explicitly by the operator.

A missing/ambiguous baseline, unknown changed path, unavailable sibling,
unregistered executable test, stale dependency map, or selection error must
produce an explicit complete-run fallback or fail before claiming success.
Never interpret an empty or failed diff command as no relevant change. Preserve
rename/deletion impact using both the old and new dependency identities. At a
landing boundary, compare the current integration inputs, not just the latest
commit or the last focused run.

Start with conservative module mappings. Runtime coverage and observed failure
history may enrich them, but an unobserved dependency is not evidence of
independence. Do not use changed-line counts, file-count thresholds or a
probabilistic model to omit tests initially.

| Example change | Development selection principle |
| --- | --- |
| Math state or page only | Math state/browser suites and shared access smoke; add registry, launcher, route and packaging checks when their inputs change |
| Clothing ranking, weather, worker or image pipeline | Relevant clothing units/integration and affected board/UI consumers; retain full worker/image tests for pipeline changes |
| Book archive or sharing policy | Format and policy suites, Reader sheets and two-hub sharing journey; add mirror/content consumers where affected |
| Shared speech, dwell, doors, contract or global CSS | Complete Linux gate initially, because consumers span apps |
| Monolithic `server.js` | Complete Linux gate initially, even for a small diff |
| Updater, launcher, assembly, payload, installer or runner | Related infrastructure suites and complete gate; appropriate candidate/native Windows checks at their established boundaries |
| Helper, fixture or toolchain/vendor input | Every consumer; complete fallback if the set is uncertain; OCR tool suites for their tool changes |
| Unknown or mixed change | Union of known affected suites plus complete fallback for the unknown part |

These examples are policy, not a complete executable map. The audit CSV records
observed dependencies, which require review before they can justify omission.
An inexpensive common smoke must be explicitly defined and measured. Existing
`invariants.test.mjs` covers declared literacy, Pencil, board and drawing states;
it does not cover every app. Math and Reader have their own access/layout checks.

## Safe execution before selection

Both focused and complete runs must use one isolation contract:

1. Resolve selected source roots explicitly. A suite cannot silently substitute
   the main hub or another sibling for a feature worktree.
2. Use owned synthetic data and temporary directories; seed required recipes
   and assets intentionally. Refuse live-data directories. Export the test data
   path to every spawned suite and hub, not just the shared server.
3. Inject a validated test origin. Refuse the live port and other reserved
   services; check availability before binding. While fixed suite ports remain,
   use the existing machine-wide lock for focused runs too.
4. Capture and verify child PIDs and test-server identity. Refuse an occupied
   port instead of killing a process found by name. Clean up only owned
   processes; verify the expected child served readiness rather than accepting
   any HTTP responder.
5. Default uncontrolled provider endpoints to closed local seams. Clear
   operator hooks and live credentials, use synthetic keys where protocol tests
   need them, and allow only explicitly owned stand-ins. Preserve intentional
   protocol tests without spending real credentials or contacting real devices.
6. Discover a complete suite inventory, reject collisions and collection errors,
   and report skipped native/VM stages distinctly from passing stages.

Do not parallelize the existing suite files wholesale. They use fixed ports,
shared data, shared globals and CPU-heavy image work. First establish isolation
and resource declarations. Pure independent units may then be scheduled with
bounded concurrency while browser/worker cases remain controlled.

## Concurrent gate jobs from different chats

Keep one acceptance policy while allowing independent verification jobs to
share the machine safely. There are two different scheduling decisions:
running suite files concurrently inside one gate, and running complete gates
for different feature worktrees concurrently. They need one shared resource
budget so nested parallelism does not multiply browser and image-worker load.

Current gates already wait in series: `era-gate.sh:34–36` holds a machine-wide
lock. A read-only check found an active gate and a second invocation waiting.
The lock is a safety mechanism, not a managed job queue with durable status or
fair scheduling. Changing only `ERA_TEST_PORT` and removing the lock would
leave fixed suite/provider ports, shared fixtures and source/output paths in
conflict. For example, clothing accessories uses a fixed fake-service port,
routes binds a fixed engine stand-in, and the complete gate defaults to shared
test data.

Introduce a small queue first, retaining one legacy worker while isolation is
incomplete. Requests identify the worktree, complete resolved input manifest,
verification stage and requested suites. Show queued/running/finished status,
active suite, logs, enqueue/start/end times and final result. Fair scheduling
must prevent repeated short requests from starving a complete gate. A queued
request whose inputs changed must be refreshed explicitly or reported stale;
it cannot quietly test different code from the identified request.

An isolated job needs its own source snapshot or equivalently protected inputs,
synthetic data, generated assets, browser state, scratch directory, output/log
directory, server identity and child ownership record. Different chats must
never overwrite each other's receipts. Pin all selected sibling sources;
another feature landing in a shared main checkout cannot change a running job.
Keep one writer per mutable worktree assembly, or assemble into the private job
workspace instead. Cancellation can stop only that job's recorded and verified
children. It must leave other jobs and chat sessions alive.

Two approaches can remove port conflicts:

| Approach | Application here |
| --- | --- |
| Allocate actual server ports and inject every consumer's origin | Preferred native migration for new/refactored fixtures; includes all fake services and engine endpoints, not just the shared hub |
| Isolate each complete job's network and filesystem, for example in a prepared container | Can retain legacy fixed ports inside separate loopback networks, but requires a reproducible runtime, private job data and no shared live mounts |

For owned stand-ins, bind once with an OS-assigned port and report that port to
consumers. Do not probe a port, close it and assume it remains reserved until
another process starts. This pattern follows
[Node's server API](https://nodejs.org/docs/latest-v22.x/api/net.html#serverlistenport-host-backlog-callback).
Hub endpoint injection must continue to enforce the project's approved test
port rules; port zero is not currently implemented as a hub launcher shortcut.
Mocks currently tied to a fixed engine endpoint need an explicit seam or an
isolated network before they can overlap safely.

Prepared containers with a
[loopback-only network](https://docs.docker.com/engine/network/drivers/none/)
are one candidate for complete jobs. All local hubs, stand-ins and browsers
would run inside the same job's namespace. Ordinary bridged networking still
permits outbound access; a container alone is not provider isolation. Supply
required dependencies and synthetic fixtures beforehand, preserve required
historical Git inputs until that fixture is repaired, and never mount live
family data or the host's entire workspace. No container runner was installed
or tested by this audit.

After isolation, benchmark one worker against a trial of two bounded workers.
Use the same known inputs and complete inventory. Measure total throughput,
per-job latency, peak memory and first-attempt failures. Two is an experiment,
not an asserted safe host limit or promised speedup. Image/segmentation work and
the existing real responsiveness threshold may need exclusive capacity even
when ports are separate. Treat native/VM legs as separately declared resources;
the VM runner has its own machine-wide lock today.

Run only independent suite files concurrently. Preserve case order inside the
stateful files. The separate-worker and bounded-concurrency principles are also
documented in [Playwright's parallelism guidance](https://playwright.dev/docs/test-parallel);
this repo currently uses its browser library with Node/legacy runners, so a
Playwright Test configuration switch would not implement the proposed scheduler.

Before accepting concurrent green receipts, prove that two jobs use distinct
fixture contents and endpoints, a failure or cancellation in one does not
affect the other, stale input changes invalidate the correct job, and missing
suite/resource setup cannot become a pass. Publish a complete receipt only
after every required suite for that input set succeeds. Identical clean input
requests may eventually share one running job, using the complete input identity
rather than a branch name or hub tree alone.

## One registry and honest reports

Use one versioned registry as the execution authority, with an entry for each
executable suite and separately declared diagnostic/fixture/helper files. Each
suite needs an identity including repository and path, purpose or historical
regression, responsible module, level, dependency patterns, stage, platform,
data/network needs, resources and review disposition. Keep observed durations
and outcomes in run records rather than hand-editing numbers in the registry.

Compare registry entries with discovered files in automation. New or missing
tests, basename collisions, helper consumers without coverage and unclassified
paths must surface immediately. Declare intentional exclusions such as native
Windows and OCR tool stages; exclusion from Linux must not hide ownership.

A selected-run report must identify its baseline, resolved inputs, selected
suites and reasons, omitted suites, fallback reasons, durations, initial results,
retries and unavailable stages. Selection-only and partial reports must not be
written to the directory consumed by landing/release stamp readers.

For reusable complete evidence, capture the full resolved source set and dirty
state, test/helper/fixture hashes, assembled assets, runtime/browser/native tool
versions, relevant nonsecret configuration, runner/registry version and platform.
Check those inputs before and after execution. Candidate VM evidence must keep
the existing artifact-hash binding. Do not broaden cache or stamp reuse until
all consumers verify the necessary identity; partial successes cannot overwrite
complete receipts.

## Validate the selector without losing coverage

Initially compute the proposed subset while still executing the complete gate.
Compare the proposal with actual failures. Record estimated selected runtime,
actual complete runtime, fallback rate, unmapped changes, omitted failing tests
and missed failing changes. A change can still be caught by another selected
test even if one failing test was omitted, so retain both measures.

Classify actual product regressions, test defects and environment failures.
Never relabel an unexplained omission as flakiness to improve the score. If no
genuine failures occurred, report failure recall as unknown. Replay historical
regressions and introduce controlled faults only in isolated fixtures/checkouts
to challenge shared-runtime, route, fixture, sibling and packaging boundaries.

Use shadow evidence to improve development selection first. Broadening the
landing or release policy would be a separate decision after representative
failure evidence, stable input tracking and zero unexplained misses. A number
of green runs alone cannot establish safety. Scheduled broader testing can
supplement this evidence but does not replace required acceptance checks.

## Future reuse at the merge boundary

The preferred next merge optimization is complete verification with valid
result reuse, rather than dropping an affected behavior. Start only with suites
whose entire input set is known and isolated. Retain original execution times,
input identities and test/runner versions; rerun a failed, stale, modified or
unknown-input suite. Do not treat clocks, performance conditions or external
environments as unchanged just because the source tree matches.

A future aggregate receipt must enumerate every required suite with either a
current pass or validated earlier pass, distinguish those sources, and bind the
current merge inputs. It must respect receipt age instead of refreshing the
time of an old result. New readers, negative tests and development documentation
must be updated together before this can satisfy landing policy. Existing
candidate-byte VM checks remain separate.

Keep dependency-only selective merge acceptance experimental until known
regressions, deliberately varied dependency changes and complete comparisons
support it. Deferring the complete gate until after merge would move detection
later and is not the recommended starting policy. Current cheap tests offer
little cache savings; expensive fixture repairs and focused developer feedback
have clearer value first.

## Prepare cumulative releases in parallel

Parallel branch jobs alone do not establish that their changes work together.
Add a release queue whose preview candidates contain the changes expected ahead
of them. For current source set S and proposed changes A and B:

| Candidate | Exact source contents to verify | Publication dependency |
| --- | --- | --- |
| First | S + A | Approved first release |
| Second | S + A + B | First accepted, or an explicit reviewed replacement decision |

Both candidates can be verified concurrently in isolated workspaces. This is
the combined-candidate behavior documented by
[merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
and [merge trains](https://docs.gitlab.com/ci/pipelines/merge_trains/).
Borrow that behavior without assuming a hosted feature is available or changing
the existing merge-only master workflow. Preview work stays in dedicated
worktrees. The final integrated sources must match the candidate evidence,
including all selected sibling repositories and embedded build inputs.

The second candidate needs its own complete applicable evidence for S + A + B;
a green result for S + B does not substitute for that combination. Its changed
scope is the union of A and B, including shared consumers and interactions.
Likewise, passing two disjoint feature test selections is not proof that their
combined source set passed. Initially run the complete product regression on
each integrated candidate; later reuse can avoid repeating genuinely unchanged
inputs through the specified receipt rules.

Record explicit feature dependencies separately from incidental queue order.
If B requires A, B stays blocked when A fails or is withdrawn. If B is independent
and A is removed, construct S + B and verify that new candidate. If A changes,
invalidate dependent combined candidates and rebuild/revalidate them. If the
combination fails while A passes alone, A may proceed with approval and B stays
held. A green B result that finishes first cannot reorder publication or omit A
from the later release. A text-conflict-free merge is not a substitute for
interaction evidence.

## Ordered publication and update paths

Build and test work may overlap. Updating the public release/feed remains a
single ordered operation so there is one authoritative latest version. Hold
only the publication and required post-publication verification stages in that
order; do not hold a publication lock across all earlier test work.

Before publishing, verify the expected preceding accepted release and installer,
current integration inputs, candidate versions/build order, artifact hashes,
complete Linux evidence and required VM receipts. A change to an assumed input
holds the candidate for reassessment; it cannot silently publish against a new
base. Reserve unique release versions and reject another candidate's existing
tag/release rather than overwrite it. Signed releases' published-download check C must finish successfully
before a later publication changes the download it inspects. A red post-publish
check holds later dependent releases for the maintainer's recovery decision.
Publication still requires the maintainer's explicit word or an explicitly
approved ordered batch; passing checks alone does not grant publication.

Two prepared releases can go out minutes apart when their required evidence is
ready and prior publication checks finish. There is no guaranteed two-minute
cadence. The Windows runner is a single-capacity resource today; its validation
must finish in advance or use separately proven isolated workers. Signing and
published-download checks can also determine the interval.

Devices may skip the first release and update directly from S to the second.
The second payload must contain the accepted A and B changes and handle required
state migrations without assuming A ran on that device. Verify a supported
baseline-to-second path, and the first-to-second path when updater, migration,
settings, packs or persistent state makes it distinct. Pin each tested starting
artifact and its state assumptions. The existing leg B starts from a previous
installer; a first patch tarball followed by a second patch tarball is an extra
transition that the current previous-installer argument does not itself test.

Current tools need changes before this workflow is available:

- `build-payload.sh:23` uses a timestamp with minute precision for its build ID,
  and `update.js:180` accepts only lexicographically newer build IDs. Parallel
  completion can produce equal or reversed order. Allocate compatible unique,
  monotonic build identities in intended release order before building/testing.
  Do not rewrite a tested payload's version afterward to fix ordering; changed
  bytes need corresponding new evidence.
- `release.sh` writes shared temporary gate/VM logs and has no publication-wide
  ordering lock or expected-latest comparison; its tag step also forces the
  chosen version tag. Per-job output, unique version ownership and a checked
  publication queue must replace those shared assumptions.
- `vm-e2e.sh` uses a common output directory and clears it before acquiring its
  VM lock. Resource acquisition and private output ownership must precede
  destructive preparation; separate gate workers alone do not repair that.
- Existing recent-stamp reuse and VM tarball hashes are useful foundations,
  but do not yet express a cumulative multi-repository release dependency or
  the full update-path matrix.

Test the queue first with synthetic candidates and no real publication:
out-of-order completion; A failure/change/removal; B's real dependency on A;
combined-only failures; unexpected changes to latest; duplicate build IDs;
stale evidence; artifact changes after validation; skipped intermediate updates;
and a failed signed post-publish check blocking the next publication. Prove that
the later released payload includes all accepted predecessors and that one
candidate cannot borrow another candidate's green receipt.

## Keep test growth useful

Every new feature/regression records what failure its test would catch and why
an existing test cannot catch it. Prefer focused logic tests for combinatorial
detail, browser tests for actual access/DOM/timing, and complete journeys for
integration and installed behavior. Do not enforce an arbitrary layer ratio.

Review the slowest and least reliable cases monthly. Review overlapping
scenarios quarterly and when a feature is retired. Move expensive fixture work
out of unrelated cases, use deterministic clocks for pure time rules, and keep
a representative production path where mocking changes semantics.

Do not retry until green. Preserve the initial failure, bound any diagnostic
retry, and investigate its cause. A temporary quarantine needs a tracked reason,
responsible module, review date and substitute protection; it cannot silently
turn a missing required check into a complete pass.

Retire a test only with a documented removed requirement or a named replacement
that catches the same failure at an appropriate boundary. Preserve regressions
for data loss, escape/communication, gaze rearming, privacy, spending consent,
update/rollback and installation unless their requirements have actually ended.
