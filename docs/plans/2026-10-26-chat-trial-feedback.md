# Chat trial feedback plan

Status: v1.0.18 / `20261026.0436` is prepared and unpublished. The complete
Linux gate passed 147/147 and the exact candidate passed all ten Windows
update cases. The published release remains v1.0.16.

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

## Ownership and coordination

Three agents own symbols, voice and timing respectively; the timing agent
integrates their browser hooks. The overseer scopes, reviews, records receipts
and prepares the distribution. All edits remain in the Chat feature worktree.
Games owns the current release/Windows artifact window; do not land even
Markdown on master, alter shared scripts or use its QA rail until it explicitly
clears. Choose the next private distribution directory after its reservation
is released. No live operator hub restart and no further home-device probes.

The Games owner permits its exact frozen `0227f86` source in a private
cumulative candidate before collection. This is conditional on that feature's
separately approved landing. Commit the Chat changes first, then merge that
frozen predecessor and run the final combined checks before freezing all six
sources. Do not land or publish the conditional dependency through Chat.

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
