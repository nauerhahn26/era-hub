# Chat speech and interaction validation

Date: 2026-10-25. Host prototype; no publication or device delivery.
Design: [Chat prototype](../specs/2026-10-25-chat-prototype.md).
Status and setup: [prototype plan](2026-10-25-chat-prototype.md).

## Provisional selection

Use local wake detection and streaming partials, followed by a higher-quality
cloud final pass. Only final text produces reply choices. Keep the touch hold
control as an explicit endpoint. The faster live cloud variant remains optional:
it changed the meaning of the noisy alternatives case in two repeat tests.
All engine identities, endpoints and credentials stay in private configuration.

This selection is provisional. The tests do not establish reference-quality
recognition for everyday child conversation, a production latency distribution,
or readiness on the communication device.

## Corpus and measurement method

The Linux host has four logical CPUs and about 4.5 GiB available memory; no
accelerator was established for these runs. Audio is mono 16 kHz PCM, replayed
in paced 100 ms batches through the actual worker. Cold initialization means a
new process, with operating-system caches left intact. Typical observed worker
readiness was about two seconds for the selected configuration; a separately
loaded local reference process took about 3.5 seconds. This startup cost is
separate from turn latency.

The recorded-child subset contains six clips, ages six to eight, reading English
with Mandarin as their first language: only 24 reference words. Intended corpus
text supplies the references; pronunciation may differ. These clips come from
[OpenSLR 101](https://www.openslr.org/101/), under CC BY 4.0. They are not native
classroom conversations and do not represent the actual conversation partners.

Seven synthetic speech cases contain 52 reference words: six clean cases and
one with additive Gaussian noise at 10 dB signal-to-noise ratio. Checks cover
alternatives, negation, a name, a comment, and wake activation with and without a
pause. Meaning checks require specified words and forbid specified negations;
they are narrow checks, not human comprehension scoring. Two additional
silence/noise cases and three negative-wake cases have separate denominators.

Word errors are substitutions, insertions and deletions divided by reference
words. Timing below is from the end of the paced clip/explicit Finish to the
final transcript. Automatic endpoint cases include the added silence tail.
Interpolation yields empirical p50/p95 from small samples, not reliable
production tails. Missing finals contribute transcription errors but have no
successful-final latency.

## Recognition observations

| Configuration | Child word errors / 24 | Child final p50 / p95 | Synthetic word errors / 52 | Synthetic meaning |
| --- | --- | --- | --- | --- |
| Local streaming | 11; one missing final | 19 / 31 ms | Not used for acceptance | Not used for acceptance |
| Local reference | 10 | 4093 / 12954 ms | 5 | 6 / 7 |
| Cloud reference | 5 | 1411 / 2350 ms | 0 | 7 / 7 |
| Selected cloud final | 6 | 966 / 1961 ms | 0 | 7 / 7 |
| Live cloud | 5 | 438 / 523 ms | 4 | 6 / 7 |

On the combined 13 speech cases (76 words), the reference cloud path has five
errors, selected final six, and live cloud nine. All three return a final for
every speech case. The selected path's combined finalization median is 648 ms
and empirical p95 1942 ms; the reference path is 1338 / 2385 ms. Live cloud is
494 / 2637 ms, including an unusually slow name case. It emits a partial before
the end of 12 of the 13 speech clips, but those partials never choose the reply.

A subsequent explicit-name-hint test repeats five cases twice. The eight clean
name, negation and wake trials preserve the checked meaning; both noisy
alternatives trials fail. Those ten tuning trials are separate from the original
comparison. No question-specific vocabulary was added to conceal the failure.

Silence and noise correctly return no speech in both additional cases. The two
synthetic wake positives activate. Neither of the two phonetic near-matches
activates, while the one genuine name mention does activate even when it is
not addressed to the communicator. Name-only activation cannot distinguish
address from mention. These counts do not estimate a false-alarm rate.

## Complete path and interaction checks

The simulated-event browser check uses an actual microphone stream and audio
worklet but injects recognition and reply events. It verifies strictly touch-only
partner controls, ordered PCM, finishing once after release, stable choices,
neutral-gaze staging, speech cancellation races, bounded confirmed context,
foreground cleanup, engine failure recovery and compact layout. It is not a
recognition-quality test. Voice playback is an instrumented test double.

A separate browser check uses actual microphone processing, the local worker,
cloud final recognition and actual reply API. Each row below is one synthetic
trial, not a percentile. Estimated speech end comes from the last above-threshold
sample in uploaded PCM timed on the browser clock; buffering and request queue
delay limit that estimate. The neutral event is supplied by the test after
replies become ready, so the user's reading/selection time is excluded.

| Browser case | Actual final | Ready after estimated speech end | Other observation |
| --- | --- | --- | --- |
| Touch hold | Would you like music or a story? | 1635 ms | 1046 ms after release |
| Name activation | Ellie, do you want music or a story? | 1734 ms | One actual keyword event |

Both return Music / A story and wait for neutral gaze before exposing selectable
choices. The test adds about 31 / 39 ms for neutral-event delivery and paint.
No page errors or direct browser requests to remote origins occur. This does
not instrument the worker's network requests and does not establish network
silence before activation by observation alone. Worker contract tests cover the
activation boundary. Native voice output is not exercised in these two trials.

A separate paced actual-API run measures the explicit endpoint without browser
painting or human selection delay:

| Input | Final after clip end | Choices after clip end | Reply path |
| --- | --- | --- | --- |
| Would you like music or a story? | 1057 ms | 1059 ms | Local alternatives |
| That was really funny. Do it again. | 1493 ms | 3436 ms | Actual generated suggestions |

The simple paths approach the two-second goal; the open-ended path misses it.
Generation separately takes about 1.5 seconds at the median in its small warm
sample; see [choice validation](2026-10-25-chat-choice-validation.md). True live
recognition could reduce part of that delay, but the observed noisy failure
prevents selecting it merely for speed. Live handshake setup also blocks the
worker reader briefly after activation; no live remote session is opened while
only local wake detection is armed.

## Reproducible evidence and remaining acceptance

Private evidence lives in `~/.cache/era-chat/benchmarks/`: attributed manifests,
input audio, paced reports, text results, `browser/` screenshots and JSON,
`interaction/` report/screenshots, and `real-api.json`. No recordings or captured
conversation are added to tracked fixtures or application logs.

`tools/chat-benchmark.py` accepts an external attributed manifest and explicit
output path; add `--paced` for real-time replay. The browser scripts are separate:
`tools/chat-browser-check.mjs <base> <scratch>` simulates recognition, whereas
`tools/chat-real-browser-check.mjs <base> <scratch> <hold.wav> <wake.wav>
<expected,words>` makes actual configured calls and can spend the operator's
service credential. Keep scratch output outside the checkout. Unit tests use
transport doubles and the full gate removes inherited Chat configuration.

Still required before wider use: representative natural partner speech and
background conversation; names and negation in the intended acoustic conditions;
the actual device microphone, native voice, eye tracker, hide/return behavior
and school network; cold start and repeated long sessions; and selection-to-first
audible-output timing. Current runtime dependencies/models are an explicit
host-only installation, not an automatic installed-device payload.
