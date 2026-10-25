# Chat wake phrase comparison

Date: 2026-10-25. Host prototype only; no deployment or live service changes.
Design: [Chat prototype](../specs/2026-10-25-chat-prototype.md).

## Decision

Retain Ellie provisionally with the current detector. Requiring Hey Ellie loses
the intended requests in this synthetic comparison, including clean connected
speech. A small development-only calibration check did not rescue that behavior.
This is a choice between available prototype configurations, not a finding that
the longer phrase is inherently worse or that either configuration is suitable
for school. The touch hold control remains the dependable alternative when voice
activation is missed.

Do not claim that name-only recognition automatically accepts Hey Ellie because
the name occurs inside it. The acoustic detector missed those connected inputs
too. Reply parsing now accepts either leading address once a transcript exists;
that is a separate capability.

## Method and denominators

Two isolated keyword configurations use the same local acoustic model, threshold
0.25, per-token boost 1.5 and one trailing blank. Only the required keyword
sequence changes. Configuration, models and generated speech stay outside the
repository. No cloud calls or credentials are used for this comparison.

There are 288 sentence clips and 36 standalone controls: 324 clips per
configuration, 648 runs total. Six synthetic voice/speed profiles are variants
of generated speech, not six independent humans. The paired controlled request
set has three fresh questions, two delays after the address (zero and 450 ms),
clean and additive Gaussian 10 dB noise, and both address forms. This gives 72
requests per form, including 36 clean and 36 noisy. Most of these requests splice
separately synthesized address and question segments to establish exact timing.
Twelve additional continuous utterances, six per form, check connected synthesis.

The same waveform is delivered to both configurations in causal 100 ms frames.
The main run is accelerated, so detection lag is audio availability at decision,
not browser wall-clock latency. A separate eight-clip paced subset agrees on
detection outcomes. The keyword result is read once because reading it consumes
the result; repeated reads cannot provide reliable result metadata.

## Fixed-settings observations

Each request row uses the phrase that configuration requires. Both configurations
receive all clips; cross-form controls are reported separately.

| Case | Ellie detector | Strict Hey Ellie detector |
| --- | --- | --- |
| Clean controlled requests, own form | 32 / 36 detected | 0 / 36 detected |
| Noisy controlled requests, own form | 5 / 36 detected | 0 / 36 detected |
| Continuous clean requests, own form | 4 / 6 detected | 0 / 6 detected |
| Standalone required phrase, mixed clean/noise | 7 / 12 detected | 0 / 12 detected |
| Ordinary actual-name mentions | 1 / 36 activations | 0 / 36 activations |
| Quoted genuine phrase | 1 / 12 activations | 0 / 12 activations |
| Genuine phrase across sentence boundary | 2 / 12 activations | 2 / 12 activations |
| Near-sounding names | 1 / 24 activations | 0 / 24 activations |
| Near-sounding ordinary words | 0 / 24 activations | 0 / 24 activations |
| Other speech | 0 / 24 activations | 0 / 24 activations |

The name detector misses all 72 controlled Hey Ellie requests. The strict phrase
detector correctly ignores all 12 standalone Ellie controls. Both ignore the
12 Hey-only controls. None of these counts estimates field false alarms per
hour. Genuine words quoted, mentioned or spoken across a boundary are address
ambiguity; the near-name activation is an acoustic error. Zero accidental
activations would not establish an improvement when intended activations are
also zero.

For the 37 successful controlled name detections, median lag after the address
ends is 567 ms, empirical p95 637 ms. The one-second volatile pre-roll preserves
the question start in all 37 detected cases. The other 35 missed requests lose
the entire turn; they are not successful recordings with zero clipping. Across
clean/noisy cases, the no-pause variant detects 15 / 36 and the 450 ms pause
variant 22 / 36. These timings do not replace the complete browser measurements.

## Sanity and calibration limits

Local reference recognition transcribes the isolated, continuous and spliced
Hey Ellie examples correctly. Pronunciation inspection matches the intended
words. The exact earlier Ellie positive still activates. A connected Hey Ellie
variant using that same synthesis profile misses both detectors, while a
deliberately paused Hey. Ellie variant activates both. The strict candidate
can therefore recognize its configured sequence in some acoustic contexts; its
connected-speech failure is specific to this model and test setup.

A separate development diagnostic uses four fresh clips: two connected Hey
Ellie requests, one paused control and one near-name negative. It checks
boost/threshold pairs 1.5/0.25, 2.5/0.25 and 2.5/0.15. All three miss both
connected requests, detect the paused control and ignore the near-name clip.
No diagnostic setting is selected, applied to the comparison matrix, or claimed
to have a held-out error rate. Fixed numeric thresholds are not an equal-recall
calibration between phrases of different lengths.

Naturalness and real reliability require actual partners, voices and microphones.
Gaussian noise and synthesized variants do not represent a classroom. The current
noise performance fails to establish acceptable wake reliability. Next acceptance
needs recorded natural addresses, incidental mentions and background conversation,
with calibration and fresh evaluation data kept separate.

## Evidence and parsing changes

Private, reproducible evidence is retained in
`~/.cache/era-chat/wake-comparison/`: `report.json`, attributed/generated audio
manifest, causal results, paced results, sanity transcripts, controls, development
diagnostic, scripts, separate keyword configurations and synthesis provenance.
The active default configuration is unchanged.

Backend regressions fix a related parsing bug: Hey Ellie before a yes/no question
or statement used to match the greeting rule. Local parsing now recognizes both
leading address forms and punctuation variants, preserves their substantive
content, and retains the original transcript/context for generated replies.
Ordinary name subjects and possessives remain conversation content. There are
35 backend/adapter tests and 53 total targeted Node tests after this correction.
The final full gate receipt is recorded through the mechanism in the
[prototype plan](2026-10-25-chat-prototype.md).
