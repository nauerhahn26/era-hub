# Chat prototype plan

Design: [Chat prototype](../specs/2026-10-25-chat-prototype.md).

Current pilot: [on-screen hold button](2026-10-25-chat-hold-button.md), with voice
activation off. The original measurements below describe the earlier prototype;
the current plan records new behavior and validation.

## Scope and work division

The maintainer authorized a prototype, key interaction tests and performance
validation. Recognition quality is the acceptance priority; local or hosted
processing is acceptable. The original voice experiment used Ellie while Chat was active.
The maintainer subsequently authorized comparing Ellie with Hey Ellie and
choosing on reliability and naturalness. The fixed-settings comparison retains
Ellie provisionally; requiring Hey Ellie missed connected-speech requests on
the current detector. Neither wake configuration is accepted for classroom use.

- [x] Read workspace instructions and synchronize the clean feature branch.
- [x] Inspect existing UI, speech, dwell and application handoff components.
- [x] Record the interaction, privacy, cancellation and evaluation contracts.
- [x] Implement and test the bounded local API and configurable runtime bridge.
- [x] Implement initial tests for the board controller and stable choices.
- [x] Complete browser microphone lifecycle and combined interaction checks.
- [x] Implement real local wake detection and recognition with runtime configuration.
- [x] Run actual recognition and quality/latency comparisons; label corpus limits.
- [x] Exercise the combined browser experience, including races and failures.
- [x] Review packaging and privacy boundaries.
- [x] Record measurements, remaining device acceptance and handoff instructions.

Backend, browser and audio/runtime work have separate file ownership. All edits
stay in this feature worktree. The prototype is reachable directly; existing
home navigation and live communication pages are not edited. No release or live
hub restart is included.

## Validation receipt

The prototype and its real speech path are implemented. Targeted checks pass:
53 Node tests, including 21 Python speech checks inside two of those tests.
The interaction browser check passes with a real microphone processing graph
and simulated recognition/choices. A separate browser run uses the actual local
worker and hosted recognition for both touch and wake activation. It returns the
correct two alternatives and holds them until neutral gaze; no page errors.
These are separate evidence levels, not interchangeable tests.

Measured simple-choice readiness is approximately 1.63 seconds after estimated
speech end for touch, and 1.73 seconds for wake. A separate paced API test takes
3.44 seconds for an open-ended response. The latter misses the two-second goal.
The provisional configuration uses a cloud final pass with local wake detection
and local partial transcripts. A faster live configuration fails the noisy
meaning check twice and is not selected.

Recognition is not yet accepted for classroom use: the small recorded-child set
has six errors in 24 reference words, compared with five for the reference cloud
recognizer. The synthetic set passes all seven meaning checks. Neither result
proves the desired real-world recognition standard.

Full methods, comparisons, retained evidence and outstanding device acceptance:
[speech and interaction validation](2026-10-25-chat-validation.md).
Choice grounding and earlier rejected configurations:
[choice validation](2026-10-25-chat-choice-validation.md).
Wake phrase comparison and additional noise/miss limitations:
[wake comparison](2026-10-25-chat-wake-comparison.md).

After the final commit, run `bash tools/era-gate.sh` detached. The authoritative
receipt is `/tmp/era-gate-green/<tree-sha>`, where `tree-sha` comes from
`git rev-parse 'HEAD^{tree}'`; require a green summary, matching head, and no
`dirty=1`. The run log and exit sentinel are `/tmp/era-chat-gate.log` and
`/tmp/era-chat-gate.exit`. This generated receipt avoids recording a result for
a different committed tree. No merge, publication, device push or live service
restart is included in this prototype task.

Overlapping registered worktrees include settings, pictures, math and app
launch/handoff work that can also touch the hub. Chat adds only a route hook,
module lifecycle hook and packaging entries to shared files; it does not edit
their UI or shared dwell implementation. Its gate uses sibling master sources,
not another feature's uncommitted worktree. Recheck shared files when landing.

## Local preview

Check that test port 8386 is free, then run `node tools/chat-preview.mjs` and
open `http://localhost:8386/chat/` on that same computer. `ERA_TEST_PORT` may select another unused
port in 8380–8389. The standalone server has no installed-hub background jobs
and its leave/pause actions return to its own preview home.

Microphone recognition uses an operator-configured runtime. Set
`ERA_CHAT_RUNTIME` to its interpreter executable, `ERA_CHAT_RUNTIME_ARGS` to a
JSON argument array containing the worker path, and `ERA_CHAT_SPEECH_CONFIG` to
a private configuration file with model paths. Keep configuration and model
identifiers outside tracked files. An absent runtime is reported as unavailable;
the partner drawer provides a clearly labelled typed-prompt test path.

An optional `ERA_CHAT_CHOICES_URL` accepts `{text, context}` and returns
`{choices:[{label,say}]}`. Its optional token is supplied by
`ERA_CHAT_CHOICES_TOKEN`, never browser code. Without it, only local rules and
clearly identified generic replies are used. Typed prompts and local reply rules
do not establish recognition quality or open-ended generation quality.

Start Chat with actual touch and wait for Ready to ask. Desktop microphone tests
use the separate partner drawer keyboard controls. Hold Ask while speaking and
release to finish. Voice activation is off. End, hide and leave close the microphone.

For the measured setup, the private configuration is already retained in
`~/.config/ai/ai.env`, with dependencies and models in `~/.cache/era-chat/`.
In each operator terminal, export that environment with
`set -a; source ~/.config/ai/ai.env; set +a`. After checking that port 8385 is
free, start `node tools/chat-choices-adapter.mjs` in one terminal. Start the
preview in another. The selected speech configuration is
`~/.cache/era-chat/cloud-runtime.json`; local, reference-cloud and live variants
are retained there for explicit comparison. This configuration is host-specific
and is not an installed-device setup. Never print or commit its contents.

The preview uses the device's built-in voice. Its saved-voice route is
intentionally unavailable. Actual installed-device voice playback remains an
acceptance check. The microphone requires a secure browser context; the local
preview address qualifies, while a plain remote address does not.

## Retrospective

Keep wake detection local and evaluate final recognition separately from partial
speed. Fast partials did not predict accurate final questions. Structured reply
validation alone also failed to catch invented personal facts: manual review
rejected that first configuration and led to explicit repair/ownership guards.

The neutral boundary and cancellation checks caught interaction races before
handoff. A failed reply request originally left a listening label above paused
capture. The regression now verifies microphone/session closure, an honest Off
state, restart controls, surviving fixed phrases and ignored stale failures.
Keep the fast deterministic paths for simple alternatives; the measured
open-ended path needs further latency work. Next acceptance is representative
speech on the communication device, with actual voice playback, gaze access,
foreground transitions and the intended network. No school-readiness conclusion
is drawn from the host prototype.

The expanded wake comparison found substantially more misses than the first
two positive controls. Keep separate evidence for keyword detection and reply
parsing: accepting Hey Ellie in the transcript does not demonstrate that it
activates the microphone reliably. Both leading address forms, including natural
punctuation and following statements, now preserve the substantive question in
the local reply rules; ordinary name subjects and possessives remain content.
