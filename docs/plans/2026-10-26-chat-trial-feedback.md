# Chat trial feedback plan

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
- [ ] Commit the clean candidate and pass the complete gate.
- [ ] Prepare the normal patch distribution and pass Windows update leg B.
- [ ] Record exact source, payload hash, tests and remaining maintainer checks.
- [ ] Publish only after the maintainer's later explicit instruction.

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
