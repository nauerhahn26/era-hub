# Chat with an on-screen hold button

The first pilot uses a conversation partner's on-screen hold control. The
maintainer chose this after comparing wake phrases and expects Bluetooth
hardware in one or two days. Hardware type and mapping remain separate from
this interaction. This record updates the activation behavior in the
[prototype design](2026-10-25-chat-prototype.md).

## Interaction

- Start Chat prepares the microphone and recognition runtime once. Ask stays
  unavailable until the page shows Ready to ask. *(Superseded 10/27 evening: no
  Start Chat; Chat prepares itself. See the amendment below.)* Preparation does not arm a
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
Pause, hiding and leaving close the microphone (End is gone since 10/27 evening). A visible active session
refreshes its idle timeout using a status request with no audio or worker command;
the existing thirty-minute hard lifetime remains in force.

## Amendment, 10/27 evening: no Start Chat

The maintainer, testing on the family's touchscreen device: "Can we just get rid
of start chat. It adds one more unnecessary step." Decision: the Start Chat
button and its desktop twin go away, and so does End.

- Chat prepares itself with no partner action: on load, and on every return to
  the page (visible again, or restored by `pageshow`), it opens the microphone
  and worklet, starts a hub session, waits for speech ready and opens the audio
  socket, exactly what Start Chat did. Ask reads "Preparing…" and stays disabled
  until Ready to ask. Preparing submits no audio.
- The browser asks for microphone permission itself the first time. A refusal
  shows "Microphone permission was not granted. Your phrases still work."; Ask
  gives way to a touch-only "Try again" that prepares again.
- A hold on Ask when no session is live (the 30-minute lifetime ended, the hub
  restarted, a failure ended the session, the microphone was paused) starts a
  session itself. The hold's audio waits on the device in the same bounded
  local buffer as the first frames before the Ask acknowledgement, grown to
  thirty 100 ms frames (about 3 s) to cover a session start, then streams once
  the session is ready. Past the bound, or if the session cannot start, the
  whole hold is dropped with the hint "Chat could not get ready. Hold Ask again
  while you speak." and the page stays usable. Truncated audio is never
  submitted.
- A session the hub ends by itself while no question is in progress ends
  silently: the prepared microphone stays open, the page stands by at Ready to
  ask, and the next hold re-creates the session. A question in progress at that
  moment is lost and the partner is told, as before.
- Leaving the page still ends the session and closes the microphone; hiding it
  still closes both. End is gone. The partner settings dialog keeps a small
  touch-only "Pause microphone" that closes capture and the session while Chat
  stays open; paused stays paused until the next hold (or Try again), which
  prepares again.
- Every law above holds: no idle PCM leaves the device, capture stops during
  playback and on hide or leave, partner controls are touch-only, nothing speaks
  unless selected, the hard lifetime still ends a session. Test-mode records are
  unchanged except that the session id may differ between holds.

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

The [installed release design](2026-10-25-chat-installed-release.md) extends this
interaction to the optional installed app. Actual microphone, gaze, voice output
and Bluetooth access still need their own acceptance. The maintainer separately
authorized publishing and device delivery; communication-board edits remain
outside this change.
