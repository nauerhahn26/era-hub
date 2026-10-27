# era-hub

The local runtime of Our Era Communication Tools (Our Era Comms): one dependency-free
Node server (Node 18+, stdlib only) that serves the installed app modules and
their shared local APIs — settings, TTS proxy with disk cache (optional
ElevenLabs key, system-voice fallback), word prediction, session logging,
board recipes, symbol cache.

Local-first: binds 127.0.0.1 by default (ERA_BIND to override). All family
state lives in a data dir (ERA_DATA_DIR) — profile, settings, keys, content,
caches — never in this repo.

- `tools/assemble.sh` — dev-workspace mode: builds `public/` from sibling
  module repos (era-core, era-making-words, era-pencil, era-board).
- `tools/era-gate.sh` — the parity/regression gate: collects every module's
  test suite, boots a test instance on its own port, runs everything.
- [Windows patch runner](tools/testing/windows-runner.README.md) — an opt-in
  independent QA host, pinned native/app phases and owned cleanup.
- [Math](docs/math.md) — number exploration and number partners through
  large gaze or touch controls, with optional spoken counting.
- [Games](docs/games.md) — local Fashion Studio, Four in a Row and Number
  Tiles, with large gaze or touch commands and saved progress.

The optional experimental [Chat app](docs/chat.md) lives at `/chat/`. Enable it
in Settings; it shares the Board pack's bundled speech activity runtime.
Prepared phrases work without cloud configuration. Configured speech uses the
installed Node runtime and sends a held question for transcription after release.
The child deliberately selects what to say. Setup and validation are recorded in
[the installed Chat plan](docs/plans/2026-10-25-chat-installed-release.md).

License: MPL-2.0.

- [Individual app locks](docs/app-locks.md) — independent locks with shared adult
  controls and passcode handling.
