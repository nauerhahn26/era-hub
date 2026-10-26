# Chat trial feedback

The first installed trial exposed three gaps: text-only choices, unrecorded
turn latency and a voice path that defaulted to the device even when a saved
voice was configured. Prepare a new candidate covering all three. Publication
requires a later explicit instruction. Validation runs on owned local fixtures
and the Windows QA VM; the maintainer owns further testing on the home device.

## Pictures and access

Put a recognizable local pictogram beside each communication label. Fixed
phrases and routes have curated mappings; dynamic suggestions use a small
deterministic concept map and a neutral communication picture when uncertain.
Negation must not select a misleading affirmative picture. Pictures are
decorative to accessibility tools; the words remain authoritative. No image
request, generation or external provider belongs in the reply path.

Keep existing tile bounds, the two black rest cells, deliberate selection and
the 44-pixel label floor. A staged batch remains immutable until the existing
fresh movement into the rest area permits its reveal. Log that display wait
separately from the time spent preparing replies.

## Turn measurements

Record numeric stage durations for every attempted turn in bounded local
browser storage. Capture hold release, ordered-audio drain, finish control,
transcript arrival, reply readiness, reveal, selection and actual playback
start/end. Retain worker timings where supplied. Record cancelled and failed
attempts separately; they do not silently enter successful latency summaries.

The partner diagnostics view provides recent durations, clearly defined
summaries and clear/export controls. Records contain no audio, transcript,
question, reply, person, account, credential, service URL or session identifier.
Only allowlisted numeric durations and bounded status/category values enter
storage or export. Logs stay on this browser and are not uploaded.

Bound local audio upload and release drain so a failed request cannot leave
the app indefinitely sending a question. Timeout cancels the turn and restores
the existing explicit restart path; it never submits truncated speech.

## Saved voice

Use the configured saved voice by default, with an explicit device-voice
alternative. Persist that choice on the browser and reflect it in partner
settings. Saved voice uses the hub's existing speech route and account
configuration; no duplicate service configuration or browser credentials.

Prefetch prepared phrases and new replies silently with bounded concurrency,
deduplication, cancellation and cache limits. Respect changes to the configured
voice. A requested saved voice must not silently become a different voice
because preparation took longer than a short race. Fail visibly when it is
unavailable; the words remain available and the partner can explicitly choose
the device voice. Playback starts only after deliberate selection. Only
confirmed completed speech enters conversation history.

## Acceptance

Deterministic tests cover symbol semantics, layout/accessibility, content-free
bounded records, stage ordering, cancellation and timeout recovery, voice
preference persistence, delayed saved audio, actual playback-start callbacks,
voice changes and stale-result suppression. A browser test uses local service
fixtures to exercise a complete held turn with pictures, timing export and
saved-voice playback. Repeat the complete gate on the clean candidate, then
run Windows update leg B on the exact prepared payload. Keep the candidate
unpublished and provide the maintainer with the receipt and test steps.
