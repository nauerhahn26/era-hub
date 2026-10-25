# Installed Chat release plan

Current status: implementation complete; release validation and publication in
progress. This supersedes the development-only setup in the earlier prototype
plan. Design: [installed Chat](../specs/2026-10-25-chat-installed-release.md).
Usage and private setup: [Chat](../chat.md).

## Work

- [x] Confirm the maintainer's explicit release request after localhost failed.
- [x] Replace the development-only speech dependency with a bundled Node worker.
- [x] Bundle and pin local speech activity weights and retain their license.
- [x] Load private per-account literal configuration without shell evaluation.
- [x] Run structured reply generation in process with existing ownership guards.
- [x] Add optional Chat tile, icons, pack dependency and shortcut cleanup.
- [x] Test release-only transcription, silence rejection, cancellation and limits.
- [x] Prevent the gate from loading private settings or using paid services.
- [x] Probe the actual configured service through the browser audio graph.
- [ ] Validate the installed worker and model on Windows during update leg B.
- [ ] Commit, synchronize master and run the complete gate on the clean tree.
- [ ] Land, publish the patch, provision private device configuration and verify.
- [ ] Record final evidence and the remaining physical acceptance checks.

Agents own separate speech, backend and packaging changes; the overseer reviews,
documents, validates and releases. Sibling Math, Music, Games, video and testing
worktrees overlap shared app, release and gate files; synchronize through the
standard worktree flow and preserve their tested behavior. Never restart the
live operator hub as part of this work.

## Validation and handoff

Targeted API, configuration, shared choice, native speech, packaging, app
registry, launcher and isolation checks pass 107/107 in one final run. The
installed harness adds one passing host check. Actual local activity inference rejects synthetic silence, tone
and deterministic noise and accepts the ordinary and paused synthetic question.
These controls establish execution and basic boundaries, not field accuracy.

The bundled Node path passes the actual browser audio graph with an ordinary
synthetic question: the full transcript is correct, Music / A story choices are
ready 1020 ms after release, and estimated speech end to choices is 1627 ms.
Final decode is 1008 ms. No idle uploads, wake events or implicit arm commands
occur. A separate configured contextual request about recess returns three
distinct play suggestions in 3348 ms. These are single host observations, not
device measurements or a latency distribution. Reports: `browser/report.json`
and `choices-probe.json` in the private installed evidence directory.

The identical installed-speech harness passes on the host with actual activity
inference and a local mock recognizer: silence rejected, zero uploads while held,
one final after release, transport closed on cancel, no stale final, and a
successful following turn. The Windows leg remains pending.

The branch incorporates the tested fixture repair from the concurrent testing
suite work: accepted mock-provider disconnects now close the response promptly,
and clothing label checks isolate their photos. The full gate validates those
fixtures without changing production behavior or reducing release coverage.

Retain private real-service evidence under `~/.cache/era-chat/installed/`; never
commit private credentials or recorded partner speech. Full gate logs and tree
stamp are authoritative for landing. The patch pipeline must run Windows update
leg B on the exact candidate before publication.

Live acceptance: open Chat, Start, wait for Ready to ask, hold through one short
natural question, release, move to the black center and deliberately select a
reply. Confirm audible voice, normal gaze behavior, a second turn, cancellation
and return to the communication system. Bluetooth and wake activation are
deferred.

## Retrospective

A development server was insufficient for the requested installed trial. The
portable activity runtime already shipped in a shared pack, so reusing that pack
avoids requiring a separate interpreter or duplicating runtime binaries. The
installed check must exercise pack recovery as well as the worker protocol.
