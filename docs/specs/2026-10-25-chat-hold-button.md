# Chat with an on-screen hold button

The first pilot uses a conversation partner's on-screen hold control. The
maintainer chose this after comparing wake phrases and expects Bluetooth
hardware in one or two days. Hardware type and mapping remain separate from
this interaction. This record updates the activation behavior in the
[prototype design](2026-10-25-chat-prototype.md).

## Interaction

- Start Chat prepares the microphone and recognition runtime once. Ask stays
  unavailable until the page shows Ready to ask. Preparation does not arm a
  keyword detector or submit idle microphone samples.
- A real touch down on Hold to ask begins one question. Audio from the held
  interval is captured immediately; a bounded local buffer protects the first
  words while the local control acknowledgement arrives.
- Releasing the touch ends capture, drains only that question's remaining PCM,
  and submits it exactly once. Silence inside a held question does not end it.
- A cancelled touch, hide, leave or expired capture abandons the question. It
  does not submit a truncated question. Fifteen seconds is the maximum hold;
  runtime audio duration and the browser wall clock independently enforce it.
- Voice activation is off. Runtime wake capability and stray wake events cannot
  arm the page or begin a question. Completing speech returns to Ready to ask.
- Deliberate fixed phrases and selected replies remain available. Speaking
  cancels any held question; its later release cannot submit abandoned audio.
- Partner microphone controls remain touch-only. The separate desktop Space
  controls exist for testing. Physical Bluetooth mapping is deferred until its
  hardware is known and can be exercised.

The prepared microphone can remain open between turns, so the browser may show
its microphone indicator. No idle PCM is submitted to the local speech worker.
End, pause, hiding and leaving close the microphone. A visible active session
refreshes its idle timeout using a status request with no audio or worker command;
the existing thirty-minute hard lifetime remains in force.

## Invariants and validation

The existing immutable choices, fresh neutral boundary, deliberate speech,
bounded confirmed context and failure recovery remain required. A cancelled
request, delayed control acknowledgement or old recognition event cannot
restart capture, submit stale audio, or stop a newer turn.

Test the actual audio worklet idle boundary and flush behavior, delayed control
acknowledgements, release/cancel distinction, pauses while held, duplicate release,
speaking during a hold, timeout, hide/end, repeated turns and failure recovery.
Measure a real recognition request containing an internal pause. Simulated events
establish interaction contracts; they do not establish transcription accuracy.

This is still a host prototype. Actual device microphone, gaze, voice output,
Windows runtime setup and Bluetooth access need their own acceptance. Publishing,
device delivery and live communication-board edits are separate maintainer acts.
