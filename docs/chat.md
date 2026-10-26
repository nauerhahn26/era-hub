# Chat

Chat is an optional experimental conversation app. Enable Chat under Settings,
Apps & navigation, then open the Chat tile or shortcut. It shares the Board
pack's local speech activity runtime; enabling it installs that pack if needed.
Existing app selections are preserved, and Chat starts disabled.

Touch Start Chat and wait for Ready to ask. A conversation partner holds
Hold to ask while speaking, then releases it. The question remains open through
pauses until release. A cancelled touch, leaving, hiding or exceeding fifteen
seconds abandons the question. Voice activation is off. Bluetooth controls await
hardware testing.

Replies appear only after a fresh move into the black center. The communicator
chooses a reply using gaze or touch, and the selected voice speaks that selection.
Yes, No, reactions and repair phrases remain available without recognition.
The page never automatically speaks an AI suggestion. Personal stories require
explicit local entry; they are not invented from questions.

Communication buttons pair bundled pictures with labels. Unknown
concepts use a neutral communication picture; the words remain authoritative.
Pictures require no image service and preserve the black rest cells and tile
positions.

## Voice and timing diagnostics

Chat defaults to the hub's configured saved voice. Conversation
partner settings offers an explicit Device voice alternative, and the selection
persists in the hub's local data on this computer. Prepared phrases and new replies can warm audio
silently; a deliberate selection is still required before speech. Changing the
configured voice invalidates older prepared clips. Saved-voice failure leaves the
words visible and reports the failure instead of silently using another voice.

Partner diagnostics retain the latest forty attempted turns locally, with
separate completed, cancelled and failed outcomes. Durations separate audio
drain, recognition, reply generation, waiting for a fresh move into the black
center, selection and actual playback. Clear removes the records; export
contains numeric durations and bounded status categories only. Records contain
no audio, question, reply, person, credential or session identifier and are not
uploaded to an external service. Successful summaries show their sample counts; median requires three
samples and the 95th percentile requires twenty.

Chat loads its saved state before enabling interaction. Stories and voice choices
report success only after the hub acknowledges the write. An unavailable store
or a conflicting change in another window produces a visible warning; reload
Chat before relying on persistence. Device voice can still be selected for the
current page when saving is unavailable. Timing writes are coalesced and flushed
when ending or leaving Chat, with a bounded wait that cannot trap Exit.
If a write's reply is lost, Chat checks the exact saved revision and complete
value before continuing. A later clear or completed turn remains pending during
that check. Changes from another window still require a reload.

## Private service setup

The installed hub reads literal `ERA_CHAT_*` assignments from
`~/.config/ai/ai.env` in the Windows account running the hub. Process environment
values override the file. Idle configuration and new-session requests pick up
file changes without a hub restart; active sessions and generation retain their
current configuration until finished. The file is operator managed, restricted to that
account, and never included in a release. Do not enter secrets into browser
storage, URLs or source files. The parser does not run shell commands.

For the bundled speech worker, configure `ERA_CHAT_SPEECH_URL`,
`ERA_CHAT_SPEECH_MODEL` and `ERA_CHAT_SPEECH_TOKEN`. The endpoint must accept
an authenticated multipart WAV transcription request and return JSON with
`text`. Optional language defaults to English; request timeout defaults to
twenty seconds. The installed Node executable runs the worker; no separate
language runtime or adapter server is needed.

Optional contextual reply suggestions use `ERA_CHAT_TEXT_URL`,
`ERA_CHAT_TEXT_MODEL`, `ERA_CHAT_TEXT_TOKEN` and optional
`ERA_CHAT_TEXT_REASONING`. The endpoint must implement the structured response
contract in `chat-choices.js`. Simple alternatives use deterministic local rules;
unknown personal history produces repair choices. Unconfigured speech leaves
prepared phrases usable. Configured does not guarantee credentials or network
availability; failures leave restart controls and prepared phrases available.

Explicit external runtime and choice-adapter settings remain supported for
development. Do not carry those settings into a bundled installation unless
their external services exist on that computer. Automated gates set
`ERA_CHAT_CONFIG_DISABLED=1` and remove other Chat settings.

## Data and current limits

Start prepares the microphone. Idle audio is not sent to the worker. After a
completed hold, a local speech activity check rejects silence before the held
audio is sent to the configured cloud transcription service. Contextual replies
may send the question and up to eight recent confirmed conversation entries to
the configured text service. The browser receives no service credentials.

The hub and worker do not save held microphone audio or recognition transcripts.
The explicit device-voice option stays local. The saved voice uses the existing
speech service and its local audio cache. The hub's local data directory retains
the voice choice, up to four manually entered stories and forty timing records
in `chat-state.json`. This state survives closing the private kiosk and restarting
the hub; it is excluded from release payloads. Timing records remain until cleared
or evicted by the bounded history, and explicit stories remain until removed.
Older browser data migrates only when the local state file is missing, and its
three legacy keys are removed after the hub acknowledges migration. Conversation
context stays in page memory and is cleared when the page ends. Cloud providers have their own retention
policies. The prepared microphone may show the browser microphone indicator
between turns; End, hide and leave close it. Sessions have a thirty-minute hard
limit.

The published replacement is v1.0.20, build `20261026.1045`. It passed
156 regression suites and all eleven installed Windows cases, including whole
kiosk and hub restarts, followed by a separate native 1280 by 800 geometry check.
Exact sources, artifacts, publication readback and original evidence are recorded
in the [trial feedback plan](plans/2026-10-26-chat-trial-feedback.md).

This candidate supports a supervised live trial. Synthetic browser checks and
installed Windows checks do not establish recognition accuracy in a classroom,
native voice audibility, gaze comfort or microphone quality. Test natural
partner speech on the intended device and network before relying on it.

Design and receipts: [hold interaction](specs/2026-10-25-chat-hold-button.md),
[installed design](specs/2026-10-25-chat-installed-release.md),
[installed plan](plans/2026-10-25-chat-installed-release.md),
[next candidate design](specs/2026-10-26-chat-trial-feedback.md),
[next candidate plan](plans/2026-10-26-chat-trial-feedback.md).
