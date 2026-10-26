# Chat trial feedback plan

Status: the historical v1.0.18 / `20261026.0436` candidate remains unpublished
and immutable with its original 147-suite and ten-case Windows evidence.
A later kiosk persistence review found that closing the final private window
can remove its browser-only timing history, stories and voice preference.
The later v1.0.19 / `20261026.0754` candidate has a genuine 155-suite pass and
verified payload, but remains unpublished after a Windows timing assertion
failed. Independent local reproductions found a committed-write acknowledgement
recovery bug. Its actual role in that Windows failure is unconfirmed. A new
recovery candidate and fresh acceptance are required before readiness.

Goal: prepare the next installed Chat candidate with pictograms, timing for
every turn and reliable use of the configured saved voice. The maintainer
requested preparation, not publication, and explicitly owns further home-device
validation. Design: [trial feedback](../specs/2026-10-26-chat-trial-feedback.md).

## Work

- [x] Record the first installed release and actual home delivery privately.
- [x] Separate measured service time from the required movement-to-reveal wait.
- [x] Confirm that current worker/API timings are returned but not retained per turn.
- [x] Identify device-voice default and the silent short-timeout voice fallback.
- [x] Scope independent symbol, voice and timing changes with tests first.
- [x] Add local symbols and verify semantics, readability and unchanged access geometry.
- [x] Add bounded, content-free turn timing, diagnostics and numeric export.
- [x] Bound audio drain and verify cancellation and recovery.
- [x] Persist saved-voice preference, prefetch silently and expose failures.
- [x] Review combined changes and update usage and privacy documentation.
- [x] Run a complete browser interaction with local fixtures.
- [x] Commit the clean candidate and pass the complete gate.
- [x] Prepare the normal patch distribution and pass Windows update leg B.
- [x] Record exact source, payload hash, tests and remaining maintainer checks.
- [x] Keep the candidate unpublished; publication requires a later explicit instruction.

### Persistence follow-up

- [x] Confirm the installed kiosk flags and private-session storage lifecycle.
- [x] Add a strict, bounded, atomic hub-local Chat state endpoint with revisions.
- [x] Exclude private state and temporary files from all public payloads.
- [x] Hydrate before interaction; serialize saves and expose acknowledgement failures.
- [x] Migrate older browser state only once and prevent resurrection after clearing.
- [x] Preserve timing-only privacy and ephemeral conversation/audio boundaries.
- [x] Use the compatible bounded leave-flush barrier from the new shared core.
- [x] Prove persistence after a full browser and hub/store restart on owned local fixtures.
- [x] Integrate the owning features' exact new frozen Game/core/tooling baseline.
- [ ] Run a fresh full gate and build after the new predecessor release timestamp.
- [ ] Run full installed Windows acceptance on the replacement payload.
- [ ] Record replacement source, hashes and limitations; retain the publication hold.

### Lost acknowledgement follow-up

- [x] Preserve the exact v1.0.19 payload and both failed Windows attempts.
- [x] Reproduce a committed write with a delayed acknowledgement using unchanged code.
- [x] Keep real external-writer conflicts protected in the reproduction controls.
- [x] Integrate the reviewed Windows tooling through `defec579` before new collection.
- [x] Reconcile only an exact next revision and complete expected committed value.
- [x] Preserve newer timing/clear operations and bounded leave behavior during recovery.
- [x] Retain strict Windows assertions and add bounded content-free failure diagnostics.
- [x] Include the Games owner's final master and documentation before freezing sources.
- [ ] Derive the new complete inventory and pass a fresh full gate on the clean tuple.
- [ ] Build the newly reserved private v1.0.20 without overwriting earlier candidates.
- [ ] Pass every installed Windows case, native layout and owned cleanup check.
- [ ] Record exact replacement evidence and keep publication separate.

## Ownership and coordination

Three agents own symbols, voice and timing respectively; the timing agent
integrates their browser hooks. The overseer scopes, reviews, records receipts
and prepares the distribution. All edits remain in the Chat feature worktree.
Games owns the current release/Windows artifact window; do not land even
Markdown on master, alter shared scripts or use its QA rail until it explicitly
clears. Choose the next private distribution directory after its reservation
is released. No live operator hub restart and no further home-device probes.

The historical candidate used the Games owner's frozen `0227f86` source.
That source was conditional on its separately approved landing; its inclusion
did not authorize Chat to land or publish that feature.

The replacement candidate must instead collect the new durable Games, shared
core leave barrier and testing-tool baseline after their owners freeze the exact
sources. Wait for their current QA handoff, then recut Chat with an updater build
timestamp later than the new predecessor. The old private distribution remains
immutable and must not be published as the replacement.

## Durable-state local validation

The reviewed follow-up passes 170 focused checks with no failures or skips,
including backend state, recognition and choice adapters, capture/controller,
voice, symbols, timing, storage, browser integration and Windows helper contracts.
The selected shared core passes its fifteen door-bar cases. These are local
checks, not the required replacement full gate or installed Windows run.
Private focused evidence: `~/.cache/era-chat/durable-final/targeted.log`.

Three separate browser processes and store instances restore the same explicit
story, voice choice and numeric timing rows through the real scratch state file.
UI clearing survives a second complete restart. Direct disk reads verify that
acknowledged data reached the file; no browser storage state is carried across
restarts. The existing held-capture, native browser playback, layout and privacy
checks remain covered with owned synthetic services.

An independent review reproduced timing loss after a failed timing write followed
by an unrelated successful preference save. The client now retains dirty timing
rows and merges them into the next save or flush; its regression passes. A failed
explicit voice save still allows the selected voice on the current page with a
visible unsaved warning. Story success continues to require acknowledgement.
The real Chat/shared-core interaction check verifies delayed-write ordering,
an 850 ms Exit flush bound and immediate Talk while a write remains pending.

The combined source merges the Games owner's exact `663978b` with the reviewed
tooling and Reader readiness fixes. Matching siblings select core `3c908c9`,
Board `2cb86de`, Words `9b2daa9`, Pencil `bd43dbb` and gaze `fc73172`.
Post-merge checks pass 133/133 across Chat state/API/config/browser, Games state,
Reader and Math. The actual registry check resolves all six selected worktrees
and reports 155 suites; the planner's thirty regression cases pass. Seven Chat
entries and their broad support consumers are registered without relaxing any
complete-gate or selection rule. These checks do not replace the new full run.

## Recovery findings and preserved Windows evidence

The clean `b0bb259` source passed the actual complete 155-suite native run
`2026-10-26T07-26-37-417Z-a071f1e3`, with zero failures, skips, TODO cases or
cancellations. Original inputs, all report receipts, owned-process exits and all
six original gate-issued stamps were independently validated and archived before
source movement. The queue's `completeEvidence=false` field remains unchanged.
Private archive: `~/.cache/era-chat/durable-final/proof-native-a071f1e3/`.

Private v1.0.19, build `20261026.0754`, binds that source and its exact six-source
tuple. The payload SHA-256 is
`7bab145edab33c8375a15aefad56b7e36fb23589b3080dcfc2826a62614886d0`.
An independent static check matched all 252 payload files and directories across
the expanded tree, tarball and ZIP: 245 direct source files, two public binary
cache files and five generated files. All eight distribution inputs, installer
signature evidence and absence of private state were verified. These bytes stay
unchanged; this is not the replacement recovery candidate.

The first independent managed Windows attempt stopped during native display
preparation before installation. The helper did not produce its result or exit
sentinel within the bound. The actual cause remains unproven. The owner captured
separate read-only diagnostics and stopped only its ancestry-proven baseline
test process, leaving the manager to complete owned transport and resource
cleanup. Original failure evidence and diagnostic supplements remain preserved.

A fresh private preparation closure ran the stock desktop wake/preparation
before the native helper and added progress checkpoints without changing native
mode selection or success criteria. Its second actual run passed native
1280-by-800 preparation, including the first successful width/height test, apply,
OS readback and process exit. The canonical update run then passed ten of eleven
cases, including full kiosk and hub restart persistence and clearing. The sole
failure waited for exactly one completed timing row after native audio playback
had completed. The separate post-baseline geometry phase did not run and no
`VM-GREEN` was produced. Both failed attempts completed owned resource, tunnel,
slot and process cleanup. Neither failure is relabelled as acceptance.

Two independent local reproductions use the unchanged production client, real
store and complete browser helper. Committing the initial open row while delaying
its response beyond the client's three-second deadline reproduces the same wait:
the page has a completed row while disk retains an open row. The client loses the
acknowledged revision, and later saves can enter a permanent conflict. Immediate
acknowledgement, shorter delays and genuine independent-writer controls pass.
This establishes a reachable production defect; it does not prove the Windows
attempt had that cause. The narrow recovery work follows the design above.
Private diagnosis and browser evidence remain under
`~/.cache/era-chat/durable-final/storage-ack-diagnosis/` and
`~/.cache/era-chat/durable-final/state-wait-repro/`.

The recovery implementation passes 240 combined focused checks with no failures,
skips, TODO cases or cancellations. These include the real-store browser helper
with an acknowledgement delayed beyond three seconds, external-writer and retry
races, queued clear operations, migration, bounded leave recovery and the new
Windows runner contracts. Recovery reads, retries and pending writes inherit a
leave flush's keepalive flag without extending its 850 ms wait. The original
request deadline and state schema remain unchanged. All eleven canonical Windows
cases and the exact one-completed-row predicate remain intact. The registry
resolves 156 suites, with no new omission rule. Private focused evidence:
`~/.cache/era-chat/ack-recovery/targeted.log`.
The final Games master `ce63f10` is merged before collection. Core selects its
landed `c5f33cf` history with the same tested `44b0248` tree. The other four
dependency trees remain unchanged. The new full run must bind this complete
clean tuple; earlier 155-suite evidence remains historical.

## Existing measurements and limits

The initial release is v1.0.16 / `20261026.0231`. The home device's running build,
Chat enablement, both configured services and preservation of other app choices
were verified before the maintainer stopped further remote device validation.
Private receipt: `~/.cache/era-chat/installed/delivery-receipt.json`.

One synthetic paced question through the installed worker and configured
services returned the correct transcript. Release to final was 1871 ms; final
to local alternatives was 192 ms; release to alternatives was 2063 ms. A
separate generated-reply request took 2469 ms. These are individual synthetic
observations, not timings of the maintainer's slow turn or field percentiles.
Private receipt: `performance-framed-report.json` in the same directory.

The original optional measurement helper timed out in its operator bootstrap;
newline framing and stage diagnostics allowed the subsequent probe to finish.
That repair changes only the private probe, not the installed app. A previously
started silent saved-voice preparation returned audio successfully in 549 ms,
without playback. No further device validation is authorized for this work.

The current client discards worker/API timings. It also waits for fresh rest
movement before displaying a prepared batch, and audio drain has no deadline.
The new measurements must distinguish these from remote recognition and reply
generation. Do not claim a speed improvement until the corresponding stage is
measured on the candidate. Natural speech quality and eye gaze remain the
maintainer's acceptance checks.

## Candidate validation

The final combined focused run passes 111/111 with no skips or failures.
It covers the backend timing whitelist and privacy ordering, native speech
stage measurements, controller, saved voice, timing store, symbols and the
complete browser page. Logs are retained privately in
`~/.cache/era-chat/feedback/targeted.log`.

The collector-included browser test and installed Windows helper share one
interaction check. Owned local endpoints provide voice metadata, generated
synthetic audio and deterministic replies. The browser uses its real native
audio element and playback events; silent prefetch never speaks. A second
pass exercises actual microphone worklet capture with synthetic input and a
mock recognizer, then verifies cancellation, upload timeout, restart and
content-free export. Screenshots at two viewport sizes retain the black rest
cells, pictures and readable labels. Private report and images:
`~/.cache/era-chat/feedback-browser/`.

Saved preparation has an eight-second overall selection deadline, including
metadata, queue and download. Background preparation is bounded and silent;
expired on-demand work cannot play later. The existing shared speech proxy's
upstream cancellation and disk-cache behavior are unchanged. These mocked
checks establish behavior and execution, not live service latency or voice
quality. Full gate and installed Windows acceptance remain required below.

The first full follow-up run, `gate-20261026T032716Z-afce089a`, found a browser
fixture cleanup race. Removing a page interceptor auto-continued an in-flight
request while a context interceptor also tried to continue it. A private cold
two-CPU reproduction with forty concurrent owned requests failed at that same
point. The fixture now starts and returns on an inert owned page, and its
context guard only denies foreign origins. An explicit intercepted external
negative control retains the isolation check; no routing errors are ignored.
The repaired complete browser/API files pass 39/39 in three cold stressed runs.
Product code and the installed Windows helper did not change for this repair.

The known-red full run was stopped through its verified owned namespace PID
after 64 suites: 63 passing and the fixture failure. It produced no green stamp
or completed full receipt. A new complete 147-suite run is required on the
corrected clean candidate. Release copy is corrected before that run as well,
so its saved-voice description matches the implemented default.

## Prepared candidate receipt

The following receipt describes the historical browser-storage candidate. It
does not certify the later durable-state runtime or restart behavior.

The corrected clean source is `cbe7a54` (tree `0faa354`). Complete job
`gate-20261026T034943Z-35b25ee9` ran all 147 unique collected suites unchanged
and passed with zero failures, TAP skips, TODO cases or cancellations. The
full gate took 1978 seconds. All six selected sources remained clean and
matched the recorded pins. After namespace and worker exit, the owner
validated the genuine result. Original proof, timestamps and all six exact
stamp bytes were archived before any receipt edits under
`~/.cache/era-chat/feedback/proof-gate-20261026T034943Z-35b25ee9/`.
No stamp was relabelled, renewed or synthesized.

The standard gate reader and patch builder produced private v1.0.18, build
`20261026.0436`, retaining the signed v1.0.0 installer. Distribution:
`~/new-era/dist/release-v1.0.18/`. Stable and versioned payloads have SHA-256
`3f7e7643cd5b828af2d62945b145dcc7b780db90c969ae7899621ff533ab8c76`.
All 250 expanded payload files agree with the tarball; required source files,
all eight distribution files and checksums were verified. The candidate was
reused unchanged for Windows validation.

An initial Windows attempt stopped at its display fixture before installing
the app: the advertised high-resolution mode failed the native mode test.
The failed attempt and successful cleanup remain recorded. A separately
reviewed private fixture then tested actually enumerated modes, requested
width and height without forcing the virtual driver's refresh frequency,
and applied only a mode whose native test succeeded. Windows reported
1280 by 800, and the actual installed kiosk independently reported the same
screen, inner and visual viewport dimensions, pixel ratio one and zoom one.
No browser viewport emulation was used. Windows coverage is 1280 by 800;
the local browser checks retain their recorded viewport sizes.

Private transport adaptations retain all ten canonical update cases and
their assertions unchanged. Only helper source paths and process ownership
are adapted; cleanup signals recorded process identities rather than process
name patterns. The native display setup runs after the pristine revert and
before installation. The accepted run is
`~/.cache/era-chat/feedback-prep/chat-v18-mode2/runs/chatprep-3812523/`.
Its receipt is `prepared-unpublished`; Windows leg B passes 10/10 with zero
failures, skips, TODO cases or cancellations. `VM-GREEN` names leg B and the
exact payload hash above.

Installed checks cover update continuity, profile and pack preservation,
existing apps, real local speech activity inference, release/cancel transport,
picture rendering, saved-voice default and persistence, deliberate native
audio playback, and content-free timing export. Recognition and voice service
responses in these Windows checks are local mocks. Actual browser playback
events were observed; this does not claim physical speaker audibility or
live recognition accuracy.

The temporary QA host was destroyed, its own lease removed, local debug
tunnel closed and both release locks independently confirmed free. Games
received the explicit next-slot handoff and qualified display fixture hashes.
No master landing, tag, publication, public-feed change, home-device contact
or delivery target was part of this preparation. This receipt-only commit is
outside the prepared artifact; the artifact and Windows proof bind `cbe7a54`.
The conditional cumulative dependency remains subject to its owning feature's
separate acceptance and approved landing.

Maintainer trial after a later release: confirm readable pictures, the selected
saved voice, a held natural question, a deliberate reply, cancellation and
return to the communication system. Inspect Turn timings for actual field
durations. Further home-device validation belongs to the maintainer.
