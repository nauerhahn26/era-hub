# Chat prototype

## Purpose

An explicitly opened conversation board lets a partner address Ellie naturally
while she keeps control of what she says. It combines prepared language and
personal stories with a small, stable set of suggestions for the current turn.
This is a prototype for evaluation, not a replacement for her communication
system or a release approved for school use.

## Accepted interaction

- Voice activation uses **Ellie**, only while the visible Chat session is armed.
- A partner can instead hold a strictly touch-only Ask control. Releasing it
  ends the question. Desktop keyboard input is a separate testing convenience.
- Wake detection processes microphone audio locally. Activation captures one
  utterance; it does not identify the speaker or establish permission.
- A short volatile audio buffer preserves the beginning of an utterance spoken
  without a pause after the name. No audio or transcript history is saved by
  default. Local recognition and cloud response generation are distinct paths.
- Capture and wake activation pause while Ellie reads, selects, and speaks.
  Listening resumes after playback. Hide, pause, leave, cancel and disposal
  stop capture and invalidate outstanding work.
- Labels, spoken messages and positions remain immutable during a choice.
  A replacement batch requires an explicit turn boundary and neutral gaze before
  it becomes selectable. Nothing speaks merely because it was generated.
- Fixed reactions, disagreement, refusal, repair and personal stories remain
  usable when recognition or networking fails. Stories are supplied deliberately;
  the prototype must not invent experiences or feelings for her.

## Prototype boundaries

The hub owns the new `/chat/` page and `/chat/api` routes. Shared dwell, visual
constants and the door bar are reused without editing sibling main checkouts.
Audio processing runs in a separately configured local worker. Runtime commands,
model locations and external service configuration remain outside tracked files.
Unavailable capabilities are reported truthfully; typed prompt testing does not
stand in for measured microphone recognition.

The local API rejects remote peers and foreign browser origins. Sessions, audio
frames, request sizes and runtime output are bounded. Audio is transient. Child
processes use argument arrays, no shell. Session deletion and expiry tear down
workers. No credentials, raw transcripts or audio are written to application logs.

## Evaluation contract

Quality takes precedence over the local/cloud choice. Compare a reference-quality
recognizer with the streaming candidate on the same recordings. Include names,
negation, explicit alternatives, remarks, short utterances, silence and noise.
Report transcription errors, meaning failures and latency together; accurate
answers cannot compensate for a changed question.

Separate cold model load, wake detection, first partial, end-of-utterance to final,
final to stable choices and selection to first audio. Target about one second
from the end of a straightforward utterance to usable choices and two seconds at
the slower end. These are goals, not measured guarantees. Include endpointing in
that measurement. A release of Ask provides an explicit endpoint baseline.

Synthetic speech can exercise the pipeline but is not child-speech validation.
Host measurements do not establish performance on the communication device.
Document missing data and failed cases rather than declaring classroom readiness.

## Required checks

1. Touch, keyboard and wake activation feed the same bounded capture lifecycle.
2. Gaze-generated clicks cannot operate partner microphone controls.
3. Capture stops outside the foreground session and during playback.
4. Cancelled or superseded recognition, choices and speech never appear or play.
5. Partial transcript revisions cannot mutate selectable choices.
6. All response choices are deliberate selections; refusal and repair persist.
7. Runtime failure and disconnect leave ordinary communication usable.
8. Real inference measurements and evidence limits accompany the prototype.

Packaging includes the hub module and browser page. The optional speech runtime
must be configured separately for this prototype; it is not silently installed by
the application. Publication and device delivery remain separate maintainer acts.
