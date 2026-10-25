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

The experimental Chat board lives at `/chat/`. Its isolated local preview runs
with `node tools/chat-preview.mjs` after checking that test port 8386 is free.
Prepared phrases work without a speech runtime; microphone recognition requires
an explicitly configured local worker. Setup, interaction rules and evaluation
limits are recorded in [the Chat prototype plan](docs/plans/2026-10-25-chat-prototype.md).

License: MPL-2.0.
