# Installed Chat release plan

Current status: the complete Linux gate passed 140/140; Windows update validation
and publication are in progress. This supersedes the development-only setup in the earlier prototype
plan. Design: [installed Chat](../specs/2026-10-25-chat-installed-release.md).
Usage and private setup: [Chat](../chat.md).

## Work

- [x] Confirm the maintainer's explicit release request after localhost failed.
- [x] Replace the development-only speech dependency with a bundled Node worker.
- [x] Bundle and pin local speech activity weights and retain their license.
- [x] Load private per-account literal configuration without shell evaluation.
- [x] Run structured reply generation in process with existing ownership guards.
- [x] Add optional Chat tile, icons, pack dependency and shortcut cleanup.
- [x] Test release-only transcription, silence rejection, cancellation and limits.
- [x] Prevent the gate from loading private settings or using paid services.
- [x] Adopt owned symbol fixtures so the complete gate can run without network access.
- [x] Probe the actual configured service through the browser audio graph.
- [ ] Validate the installed worker and model on Windows during update leg B.
- [x] Commit, synchronize master and run the complete gate on the clean tree.
- [ ] Land, publish the patch, provision private device configuration and verify.
- [ ] Record final evidence and the remaining physical acceptance checks.

Agents own separate speech, backend and packaging changes; the overseer reviews,
documents, validates and releases. Sibling Math, Music, Games, video and testing
worktrees overlap shared app, release and gate files; synchronize through the
standard worktree flow and preserve their tested behavior. Never restart the
live operator hub as part of this work.

## Validation and handoff

Targeted API, configuration, shared choice, native speech, packaging, app
registry, launcher, isolation and installed host harness checks pass 111/111 in
one final run. Actual local activity inference rejects synthetic silence, tone
and deterministic noise and accepts the ordinary and paused synthetic question.
These controls establish execution and basic boundaries, not field accuracy.

The bundled Node path passes the actual browser audio graph with an ordinary
synthetic question: the full transcript is correct, Music / A story choices are
ready 1020 ms after release, and estimated speech end to choices is 1627 ms.
Final decode is 1008 ms. No idle uploads, wake events or implicit arm commands
occur. A separate configured contextual request about recess returns three
distinct play suggestions in 3348 ms. These are single host observations, not
device measurements or a latency distribution. Reports: `browser/report.json`
and `choices-probe.json` in the private installed evidence directory.

The identical installed-speech harness passes on the host with actual activity
inference and a local mock recognizer: silence rejected, zero uploads while held,
one final after release, transport closed on cancel, no stale final, and a
successful following turn. The Windows leg remains pending.

The branch incorporates the tested fixture repair from the concurrent testing
suite work: accepted mock-provider disconnects now close the response promptly,
and clothing label checks isolate their photos. The full gate validates those
fixtures without changing production behavior or reducing release coverage.

An update/setup ordering review found that credentials might arrive after the
updated hub starts. Private settings now reload at idle config/session boundaries
without a restart. Three regressions cover file creation, an active session and
an active generation request; none interrupts existing work or reads a file in
the PCM upload path.

The isolated full-gate pilot also requires two optional operator-configured
symbol endpoint seams, retaining the existing production defaults. The matching
Board worktree owns synthetic model/route fixtures and a local symbol service;
it retains cache-miss, disk-write, hit and request-count assertions without
reading a live wardrobe or relying on the public network. Independent review
finds no weakened contract. Three provider checks and eleven Board checks pass.
The Board changes affect tests and their README only. The full run must stamp
both Chat worktrees; land Board before the hub, then publish the exact candidate.

The first isolated full run completed all 139 suites with 137 passing and two
test failures. All six Chat suites passed. Music's numeric-symbol test still
depended on a public image download; it now owns a local image provider and
checks exact numeric URL, bytes, miss/disk/hit behavior and one provider request.
Reader's reload test observed its index before boot restored the saved position;
it now waits for the independently rendered grid before the unchanged section
and page assertions. A deterministic delayed-status browser probe confirms
persistence was intact. Whole-file checks pass 12/12 and 17/17. No application
code changed. The failed run yields no release authorization or green stamp;
a fresh complete run is required. Original failed job:
`gate-20261026T000616Z-e0a2d99d` in the private parallel-gate job directory.

A separate gate on an alternate test port exposed two negative-test literals
being rewritten into valid preview ports by the gate's blanket port replacement.
Those inputs now compute the protected port while preserving strict rejection
assertions. Both complete files pass 48/48 after the actual replacement to each
of two approved alternate ports. Application port validation is unchanged.

The second complete isolated run finished 138/139 passing; Music and reload
restoration passed. Reader's separate sort test had not made its two purported
ties equal in the third sort key: first-seen time. A controlled advancing clock
reproduces the correct non-alphabetical result for those unequal keys. The two
manifests now seed equal first-seen values, and the test verifies all three date
keys match before its original alphabetical assertion. Product sorting is
unchanged. The full Reader file passes 17/17 under the adversarial clock.
This second failed run also yields no green authorization; retain its receipt
under `gate-20261026T005503Z-5d020d05` and require another complete run.

Before a fixture-only reuse proposal was accepted, shared speech and Sort it
runtime changes landed. The Chat branch now includes that actual hub predecessor,
and matching Chat worktrees pin every dependency, including the new shared speech
revision. This changes application inputs and adds a speech regression suite, so
the next complete acceptance run must cover all 140 suites. The fixture-only
evidence cannot certify those new runtime inputs. No reuse policy or fabricated
green receipt is used.

## Complete Linux acceptance

The final pinned candidate passes all 140 suites with zero failures, skips or
TODO cases. The unchanged full gate ran in an isolated namespace and exited
successfully; the owner validated source, runtime, suite and stamp identities
after namespace exit. Job: `gate-20261026T015400Z-b27fb428`, 2042 seconds.
Tested hub commit `81fcabb` (tree `f5d89bae`), shared core `02377c5`, Board
`395d02b`, and the other matching Chat dependency worktrees were clean.

While all six source origins were still frozen, exact original proof and stamp
bytes were archived privately under
`~/.cache/era-chat/installed/parallel-proof-gate-20261026T015400Z-b27fb428/`.
The archive retains original tree filenames, head, timestamp and byte hashes;
no stamp was relabelled or renewed. Standard landing and release readers use
that directory through `ERA_GATE_STAMPS`. Subsequent Markdown-only receipts use
the existing documented eligibility rules. Windows update validation remains
mandatory on the exact release payload before publication.

Retain private real-service evidence under `~/.cache/era-chat/installed/`; never
commit private credentials or recorded partner speech. Full gate logs and tree
stamp are authoritative for landing. The patch pipeline must run Windows update
leg B on the exact candidate before publication.

Live acceptance: open Chat, Start, wait for Ready to ask, hold through one short
natural question, release, move to the black center and deliberately select a
reply. Confirm audible voice, normal gaze behavior, a second turn, cancellation
and return to the communication system. Bluetooth and wake activation are
deferred.

## Retrospective

A development server was insufficient for the requested installed trial. The
portable activity runtime already shipped in a shared pack, so reusing that pack
avoids requiring a separate interpreter or duplicating runtime binaries. The
installed check must exercise pack recovery as well as the worker protocol.
