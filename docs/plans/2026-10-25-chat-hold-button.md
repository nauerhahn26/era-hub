# Chat hold button plan

Design: [on-screen hold interaction](../specs/2026-10-25-chat-hold-button.md).
This is the current pilot interaction. Wake comparison remains research evidence;
the page no longer enables voice activation.

## Work

- [x] Confirm the maintainer's choice of an on-screen hold button first.
- [x] Inspect capture, endpointing, session idle expiry and cancellation behavior.
- [x] Test and implement a quiet Ready to ask state and touch-only held capture.
- [x] Keep question pauses until release and enforce an aborting capture ceiling.
- [x] Preserve idle readiness without sending idle audio or extending hard lifetime.
- [x] Exercise real microphone processing, delayed acknowledgements and failures.
- [x] Run a real recognition request with a pause inside the held question.
- [x] Review the final change and retain evidence and handoff instructions.

After the final commit, run the full gate detached and verify its matching clean
tree receipt as described below.

Browser, backend and speech-worker changes have separate ownership. Work stays
in the Chat worktree. Runtime credentials/models remain private. No live hub,
device or TD Snap changes are included.

## Preview and evidence

Use the setup in the [prototype plan](2026-10-25-chat-prototype.md), then Start
Chat and wait for Ready to ask. Hold the on-screen Ask control while speaking;
release when finished. Voice activation is disabled. An interrupted hold is
cancelled. The device voice is used by the standalone preview.

The private fixture and report directory is `~/.cache/era-chat/hold-button/`.
Its generated paused question contains an exact 1.5-second silent gap between
Would you like and music or a story. The manifest records synthesis provenance,
sample boundaries and a checksum. It is synthetic speech, not a real child or
conversation partner.

The full gate runs after the final commit. Its authoritative receipt is
`/tmp/era-gate-green/<tree-sha>` for `git rev-parse 'HEAD^{tree}'`, matching HEAD
with no dirty marker. The log and exit sentinel are `/tmp/era-chat-gate.log` and
`/tmp/era-chat-gate.exit`; retained copies accompany the private evidence.

## Validation receipt

Targeted checks: 58 Node tests pass, including two wrappers running 28 Python
checks. These cover capture through pauses and silence, explicit release,
capture limits, cancellation, heartbeat idle refresh, unchanged hard expiry,
origin restrictions and existing reply/voice contracts.

The browser interaction check uses the actual microphone graph and worklet with
synthetic audio, simulated recognition/choices and a simulated status endpoint.
It confirms zero idle PCM uploads, zero arm commands, no recognition generation
change from a status poll, held audio preserved during delayed acknowledgement,
single submission on release, ownership by the initiating touch, cancellation
without submission, fixed speech interrupting a hold, and hide/timeout/error
recovery. Its voice output is an instrumented double, not native playback.
Report and screenshots are retained under `interaction/`.

One actual browser trial with ordinary synthetic speech returns Would you like
music or a story and the correct Music / A story choices. Readiness is 1451 ms
after release and approximately 2066 ms after estimated speech end; neutral
movement and paint add 28 ms. Final decoding takes 1441 ms. These are individual
host observations, not a latency distribution. Idle uploads and implicit arm
commands are both zero. Report and screenshot: `normal-browser/`.

The paused trial captures 4569 ms through the entire silent gap and submits once
after release. It fails the expected-choice assertion: recognition returns
What you like. Music or a story. The fast rule cannot safely reconstruct the
missing auxiliary, and the deliberately unconfigured text adapter leaves repair
choices available. This failure is preserved under `real-browser/` rather than
counted as an end-to-end success.

A separate paced replay of the original paused waveform compares selected and
reference cloud recognition. Both return What do you like? Music or a story,
two word edits in seven reference words, with finalization at 929 / 720 ms.
The valid paraphrase also exposed an ordinary punctuation gap in local choice
parsing. New regressions accept punctuation after recognized choice prompts and
return Music / A story from that transcript. They preserve incomplete or negated
questions and subsequent clauses for contextual handling rather than inventing
missing words. The original failed browser request is not rerun or relabelled as
passing. Retained files: `selected-paused-quality.json`,
`reference-paused-quality.json` and `quality-manifest.json`.

The pause fixture splices separately synthesized segments; it does not establish
how either recognizer handles natural partner pauses. The default recognition
configuration is unchanged. Native voice, actual gaze, device/network behavior
and Bluetooth hardware remain untested here. No captured conversation or real
child speech was collected for this update.

## Retrospective

The default automatic endpoint was unsuitable for a held question: silence could
submit it before release. Ask now has an explicit endpoint, with automatic
endpointing reserved for separate wake/diagnostic use. Idle status requests also
replace the old continuous audio as the way a visible session stays ready.
The internal-pause integration test found a recognition/parsing limitation that
unit interaction tests could not reveal. Preserve both successes and failures.

## Remaining device acceptance

Verify the actual microphone, gaze selection, voice playback and the launch/return
to the communication system. Check natural partner speech and background noise.
The earlier wake failures and open-ended generation delay are not solved by a
different input control. Bluetooth integration waits for the actual hardware.
