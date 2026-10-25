# Installed Chat trial

The maintainer requested a normal release after the private localhost pilot
failed to open. That authorizes publishing and delivery through the existing
updater. The hold interaction and deliberate speech contract remain as specified
in [the hold design](2026-10-25-chat-hold-button.md).

The installed app uses its bundled Node executable for both the hub and speech
worker. A local speech activity model runs through the existing portable
WebAssembly inference runtime. After release, qualifying PCM becomes one bounded
WAV request to an explicitly configured transcription endpoint. There is no
automatic endpoint or wake activation in this path. Generation changes abort
requests and suppress stale results. Silence and noise controls are checked
locally; this does not establish real-world background-noise accuracy.

Chat shares the Board app pack because the portable inference runtime already
lives there. Its page, icons and small server modules remain in the core
payload. Enabling Chat installs its dependency through the existing pack flow.
Chat is optional and disabled by default; saved enabled-app selections remain
authoritative. Both uninstall paths remove its shortcuts.

The hub reads bounded literal private Chat settings from the operating account's
configuration file. Idle configuration and new-session requests pick up changes
without restarting the hub. Active sessions, choice requests and pending request
bodies retain their current instance. The worker receives speech credentials only. Structured
reply generation runs in process using the existing validated choice logic;
text credentials are not passed into the worker. Explicit external adapters
remain an operator override. Gates disable private file loading as well as
clearing exported Chat settings.

No credentials, family data or operator paths ship in the payload. Release copy
describes optional cloud processing. Installed checks must use the actual
bundled executable, activity model and runtime with a local mock transcription
endpoint; separate synthetic probes exercise the configured real service.
Physical microphone, gaze, voice playback and foreground return remain live
acceptance checks. No live communication-board edit is part of this release.
