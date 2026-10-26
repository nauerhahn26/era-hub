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

Record numeric stage durations for every attempted turn in bounded hub-local
storage. Capture hold release, ordered-audio drain, finish control,
transcript arrival, reply readiness, reveal, selection and actual playback
start/end. Retain worker timings where supplied. Record cancelled and failed
attempts separately; they do not silently enter successful latency summaries.

The partner diagnostics view provides recent durations, clearly defined
summaries and clear/export controls. Records contain no audio, transcript,
question, reply, person, account, credential, service URL or session identifier.
Only allowlisted numeric durations and bounded status/category values enter
storage or export. Logs stay on this computer and are not uploaded to an external service.

Bound local audio upload and release drain so a failed request cannot leave
the app indefinitely sending a question. Timeout cancels the turn and restores
the existing explicit restart path; it never submits truncated speech.

## Saved voice

Use the configured saved voice by default, with an explicit device-voice
alternative. Persist that choice on this computer and reflect it in partner
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

## Durable device state

The installed kiosk uses a private browser session. Reloading a page does not
prove that browser storage survives closing the final window. Durable timing
history, manually entered stories and the explicit voice preference therefore
belong in the local hub data directory. Conversation context, recognized
questions, generated replies and microphone audio remain ephemeral.

A dedicated loopback and same-origin state endpoint stores only a bounded,
versioned schema: the saved/device voice choice, up to four explicit stories
and forty content-free timing rows. Unknown fields and invalid values are
rejected. Writes merge supplied sections atomically and use a revision check
to prevent stale updates from overwriting a newer state. Corrupt files remain
preserved and produce a visible recovery error; they are never silently reset.
Private saved state and temporary files must never enter a public payload.

Hydrate before enabling interaction or warming a selected voice. A serialized
client cache keeps measurements nonblocking and coalesces stage writes. Saved
confirmation requires a hub acknowledgement; failure or conflict remains
visible. Migrate the three older browser keys only when durable state is
missing, then clear them after acknowledgement. Clearing timing history must
not resurrect older browser data or remove stories and preferences.

End, page hide and the supported asynchronous door-leave barrier flush pending
writes within a bounded wait. Failed saving must not make the communicator
unable to leave. The new regression closes every browser window and process,
recreates the hub/store on the same data directory, and opens a fresh private
browser without restored browser storage. The installed Windows check must
likewise verify data after a complete kiosk and hub restart. Reload-only
evidence is retained as history and cannot certify this stronger contract.

## Lost acknowledgement recovery

A local state write can commit before its response reaches the page. A request
timeout therefore leaves an uncertain outcome. Retain the last confirmed state
separately from the latest local timings, and reconcile an uncertain write before
sending a later revision. A bounded read may acknowledge that write only when
both the exact next revision and the complete expected prior state plus sent
patch match. Preserve newer pending measurements and clear operations while the
read is in flight, then save them under the confirmed revision.

A different revision or value remains a visible conflict. An unavailable read
remains unsaved; it must not silently overwrite another window. Any retry of an
unchanged base retains the original revision check and a finite retry budget.
Recovery runs in the background and cannot extend the bounded Exit wait or delay
communication. Legacy browser keys are removed only after durable confirmation.

The Windows helper retains its exact completed-row assertion. It waits for the
voice control's client acknowledgement before navigating and captures bounded,
content-free state diagnostics before restoring fixtures on a failed wait.
