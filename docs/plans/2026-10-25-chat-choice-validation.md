# Chat choice validation

Date: 2026-10-25. Prototype validation only; no release or device deployment.
Design: [Chat prototype](../specs/2026-10-25-chat-prototype.md).

The local text adapter accepts a question and at most eight confirmed recent
conversation entries. It requests a strict structured response without response
storage, validates two to four short label/spoken-text pairs, and returns an
explicit source kind. It never starts speech. Credentials, transport destination
and model selection remain outside the repository. Ordinary tests inject the
transport and cannot spend a real credential.

The first live service probe succeeded in 2343 ms. A baseline eight-question
run then had no transport/schema failures: first request 1296 ms, warm median
1070 ms and warm maximum 1432 ms. Manual inspection rejected that configuration:
it invented weekend activities and book events, and reassigned a partner's lost
drawing to the communicator. Valid JSON and fast responses did not establish
acceptable choice quality. A smaller comparison configuration was unavailable;
its eight requests failed quickly rather than producing choices.

A different configured small model was tested on the same eight cases after
clearer speaker-role and factual-grounding instructions. All requests succeeded;
first request 1418 ms, warm median 1321 ms and warm maximum 1612 ms. Ownership,
unknown history and refusal examples improved, but one book example contained
two choices with substantially the same meaning.

The final implementation therefore adds deterministic handling before generation:
unknown personal history and book-detail questions receive repair, clue and
decline options. A confirmed earlier utterance is reused only when an explicit
time anchor matches. Common first-person partner incidents receive support
options without becoming child biography. Generated responses also undergo a
bounded ownership check. These are conservative language rules, not a general
proof of factual correctness; unfamiliar wording and nuanced implications remain
limitations. Source kind `guarded` and `generated:false` distinguish such replies
from actual generated suggestions.

The final ten-case run used the selected configuration and normally three short
choices. Seven cases made real service calls; three used deterministic guards.
There were no transport, schema or validation failures. First network request:
1923 ms. Six subsequent network requests: median 1535 ms, minimum 1143 ms,
maximum 1913 ms. The nearest-rank empirical p95 is that maximum; this small
sample does not estimate a production tail. Guarded cases completed locally in
less than the timer's one-millisecond display resolution.

| Case | Observed result |
| --- | --- |
| Topic invitation | Different conversation directions and uncertainty. |
| Game opinion | Positive, negative and undecided replies. |
| Negation | Alternatives respected an earlier refusal to play a sport. |
| Unknown weekend | Guarded clue, another-way and refusal options; no invented event. |
| Book details | Guarded repairs; no invented plot from a book topic alone. |
| Secret request | Privacy, later and topic-change options. |
| Partner's lost drawing | Guarded help options; no transfer of ownership. |
| Follow-up about space | Related views and uncertainty using confirmed context. |
| Break-time invitation | Possible future activities without claiming past events. |
| Cartoon reaction | Amusement, concern and uncertainty. |

Detailed synthetic-case outputs and failure records remain in the private
`~/.cache/era-chat/benchmarks/text-results.json`, not in application logs. No captured speech or
real conversation was used for this text evaluation. Full speech-to-choice
latency must be measured through the complete chain; these generation timings
alone do not establish the two-second end-to-end target.

Targeted checks: 35 backend/adapter tests pass, including request/response caps,
cancel/timeout behavior, source metadata, unknown-history handling, ownership
handling, static alternative extraction, and worker capability whitelists. Past
history alternatives use guarded repairs rather than incomplete question fragments
or invented answers. Leading Ellie and Hey Ellie addresses, punctuation variants
and subsequent statements cannot turn substantive questions into greetings.
Original transcripts and context remain unchanged for the adapter. The broader gate is recorded in the
main prototype plan.
