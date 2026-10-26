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
chooses a reply using gaze or touch, and the device voice speaks that selection.
Yes, No, reactions and repair phrases remain available without recognition.
The page never automatically speaks an AI suggestion. Personal stories require
explicit local entry; they are not invented from questions.

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
The default device voice stays local. The optional saved voice uses the existing
speech service and its local audio cache. Conversation context stays
in page memory and is cleared when the page ends; manually entered stories stay
in browser storage until removed. Cloud providers have their own retention
policies. The prepared microphone may show the browser microphone indicator
between turns; End, hide and leave close it. Sessions have a thirty-minute hard
limit.

This release supports a supervised live trial. Synthetic browser checks and
installed Windows checks do not establish recognition accuracy in a classroom,
native voice audibility, gaze comfort or microphone quality. Test natural
partner speech on the intended device and network before relying on it.

Design and receipts: [hold interaction](specs/2026-10-25-chat-hold-button.md),
[installed design](specs/2026-10-25-chat-installed-release.md),
[installed plan](plans/2026-10-25-chat-installed-release.md).
