# Queued Chat and Games suite audit

All nine added suite files protect useful, distinct boundaries. Retain them;
the overlap does not justify deleting a file. Keep focused development execution
separate from complete landing and release evidence. Games browser coverage is
the clearest candidate for affected execution because it is broader and more
expensive than the pure state checks.

This supplement compares master `3f8655c` with frozen Chat `28fc5be` and cumulative
Games `7929a5f`. It extends the [original audit](2026-10-25-testing-suite-audit.md).
The Games candidate already contains Chat, so its six Chat suites are counted
once. The two Python files are children of `chat-speech.test.mjs`, not additional
gate suite entries. `symbol-provider.test.mjs` is also new relative to that master,
but was already reviewed and registered during the testing infrastructure work.

The review inspected imports, fixtures, test definitions and representative
assertions from those immutable commits. No tests, gates or source queues were
run or changed. Case counts below come from source declarations, including the
two viewport loops and two Python-wrapper invocations. Runtime costs are
structural classifications; measured durations remain to be collected from the
owners' existing receipts.

## Added suite files

| Suite | Cases | Failure it protects | Runtime and resources | Disposition |
| --- | ---: | --- | --- | --- |
| `chat-api.test.mjs` | 38 | Local request authorization, bounded sessions/audio, runtime isolation, idle configuration reload, cancelled generations, truthful alternatives and provider failures | Node HTTP integration with owned ephemeral loopback listeners, synthetic children/fetch and temporary configuration; no browser or paid service | Keep. Run for Chat API, choice policy, runtime protocol, preview or gate configuration changes. |
| `chat-choices-adapter.test.mjs` | 10 | Bounded generation requests, grounded personal-history repairs, strict reply validation, cancellation and adapter HTTP boundaries | Node module/HTTP integration; injected provider replies and owned ephemeral listeners | Keep. Direct adapter callers need their own protection independently of the hub API. |
| `chat-config.test.mjs` | 3 | Literal configuration parsing, precedence, disabled/missing/oversized files and absence of shell evaluation | Small filesystem/module checks in owned temporary directories | Keep. Parser detail belongs here; API tests verify reload and session integration. |
| `chat-native-speech.test.mjs` | 13 | Explicit-release upload, silence/activity refusal, bounded capture, generation cancellation, redirect credential protection and child protocol | Node worker tests, controlled transport, owned loopback server/child processes; one real bundled activity inference path uses the shipped runtime and assets | Keep. Preserve the real inference case when simplifying doubles elsewhere. |
| `chat-speech.test.mjs` | 2 wrapper invocations | Python runtime protocol and benchmark-tool contracts | Requires `python3`; runs the two files described below with a 15-second subprocess ceiling each | Keep while the optional Python runtime and evaluation tools remain supported. It is developer-tool coverage, not proof that an installed device needs Python. |
| `chat-ui.test.mjs` | 17 | Controller generations, neutral gating, pause/failure recovery, stale speech suppression, sample-rate conversion and idle worklet audio retention | In-process Node tests with controlled promises, voice doubles and a VM worklet harness; no rendered browser page | Keep. Its filename should not be interpreted as browser/layout acceptance. |
| `games-state.test.mjs` | 21 | Independent workspaces, bounded persistence, exact undo/randomness, confirmed replacement, legal moves, wins/draws and computer strategy | Pure state/reducer tests; no server, browser, model or external service | Keep as the cheap place for combinatorial game rules. |
| `games-ui.test.mjs` | 16 | Real shared dwell and doors, tracking-loss/rearm, timer/visibility cancellation, stable DOM, readable geometry, rendered option distinctions and reversible journeys | Chromium, owned ephemeral static server, synthetic settings/gaze and local storage; actual DOM/CSS at both supported viewport sizes; explicit waits, screenshots and catalog loops | Keep. Run for Games rendering/controller/assets and shared access changes; measure this file before attempting runtime reductions. |
| `games-audio.test.mjs` | 3 | No music on restore, late AudioContext resume after Talk, cap application and prompt cancellation/disconnection of scheduled notes | Chromium and owned ephemeral static server with a deliberately deferred AudioContext double; no actual speaker | Keep. This Web Audio lifecycle is different from media-element and shared speech playback. |

The Python children contain 22 runtime tests in `chat-speech-runtime.py` and six
metric/replay tests in `chat-speech-benchmark.py`. They use deterministic doubles,
synthetic PCM and controlled local transport. The metric cases validate error
counting, negation, percentile calculation and endpoint selection; they do not
measure real recognition accuracy or conversational usefulness.

## Overlap and coverage limits

- Configuration appears in both parser and API tests. The parser checks literal
  input and precedence; the API checks when changes become effective without
  disrupting active sessions. Neither replaces the other.
- Choice validation and honest repairs appear at both public entrypoints. Hub
  API wiring and direct adapter access have separate request/response boundaries.
  Keep representative protection at each and maintain detailed parsing cases at
  their owning layer. Similar wording alone is not redundant coverage.
- Node and Python speech tests share generation, hold and cancellation concepts
  but exercise different implementations. The bundled Node worker is copied by
  the payload builder; the Python worker and benchmark remain optional tools.
  Retirement requires an explicit end to that supported tool contract.
- Chat voice cancellation resembles the shared speech regressions, and Games
  audio resembles music playback tests. Their implementations and asynchronous
  resources differ. Consolidating their fixtures may help maintenance; removing
  the protected boundary would reduce coverage.
- Games state tests cover rule detail; its browser tests check actual integration,
  access, geometry, lifecycle and persistence wiring. Keep both supported
  viewport checks and the rendered catalog distinctions. A correct state value
  cannot establish that a visible option differs or a target remains reachable.

These suites leave meaningful acceptance work elsewhere. Chat's controller/VM
tests do not establish rendered layout, actual gaze activation, browser microphone
permissions, the live AudioWorklet connection or installed handoffs. Retain the
owner's browser/device acceptance evidence; a stable rendered Chat smoke is a
useful future coverage addition. The real speech-activity case tests silence,
tone and noise rejection; a licensed nonpersonal positive speech fixture would
also detect an activity implementation that rejects everything. Provider doubles
cannot prove acoustic recognition quality, and the Games audio double cannot
establish physical speaker volume. These are coverage limits, not reasons to
delete the existing tests.

## Existing integration tests also changed

The candidates extend `apps`, `packs` and `start-hub-bat` checks for registration,
payload assets and launch wiring. Reader sizing adds controlled symbol endpoints.
Games also extends `gate-stamp.test.mjs` with a busy-port listener-survival
regression. Keep those existing files and their added boundary checks; this
supplement does not count modifications as new suite files.

## Registry metadata: Chat and Games applied

The six Chat entries and their two Python helper declarations are now applied
to the execution registry after Chat master `e1caf6b` merged into the testing
worktree. Comparing the merged files with the audited Chat commit found only
the two already-reviewed forbidden-port fixture repairs; case counts and runtime
boundaries remain unchanged. Applied dependencies use repository-qualified paths
and include the API's shared loopback helper and preview's served dwell source.

The three Games entries are now applied after frozen, complete-green candidate
`c097524` merged into the cumulative testing source. All three suite files are
byte-identical to the originally audited Games versions. The state dependency
metadata explicitly includes its two imported rule engines; audio's volume
contract is exercised through the Games implementation and its controlled settings
fixture. These applied entries, including the Python helpers above, bring the
current inventory to 147 suites.

Register each suite only when its source exists in the selected source tuple.
The inventory must not declare files that have not merged. These entries introduce
no new omission rule: Chat, Games, shared runtime and unknown source
changes retain the existing conservative complete fallback until their impact
boundaries are explicitly reviewed.

```json
{
  "suites": [
    {
      "id": "era-hub:tests/chat-api.test.mjs",
      "purpose": "Local Chat authorization, bounded sessions, runtime/configuration lifecycle and choice-service integration",
      "group": "chat", "lane": "linux", "level": "HTTP module integration",
      "dependencies": ["chat-api.js", "chat-choices.js", "chat-speech-worker.js", "tools/chat-preview.mjs", "tools/chat-choices-adapter.mjs", "tools/era-gate.sh"],
      "resources": ["owned-loopback-services", "temporary-data", "synthetic-runtime-children"]
    },
    {
      "id": "era-hub:tests/chat-choices-adapter.test.mjs",
      "purpose": "Bounded grounded choice generation, strict provider replies and direct adapter HTTP cancellation",
      "group": "chat", "lane": "linux", "level": "module and HTTP integration",
      "dependencies": ["tools/chat-choices-adapter.mjs", "chat-choices.js"],
      "resources": ["owned-loopback-services", "provider-doubles"]
    },
    {
      "id": "era-hub:tests/chat-config.test.mjs",
      "purpose": "Literal private configuration parsing, precedence, bounds and disabled behavior",
      "group": "chat", "lane": "linux", "level": "module and filesystem",
      "dependencies": ["chat-api.js"],
      "resources": ["temporary-data"]
    },
    {
      "id": "era-hub:tests/chat-native-speech.test.mjs",
      "purpose": "Release-only speech capture, actual activity refusal, cancellation, bounded transport and safe child protocol",
      "group": "chat", "lane": "linux", "level": "worker and inference integration",
      "dependencies": ["chat-speech-worker.js", "vendor/models/chat-activity.onnx", "vendor/onnxruntime-web/**"],
      "resources": ["wasm-cpu", "bundled-activity-assets", "owned-loopback-services", "owned-node-child", "provider-doubles"]
    },
    {
      "id": "era-hub:tests/chat-speech.test.mjs",
      "purpose": "Optional Python speech-runtime protocol and evaluation-tool metric contracts",
      "group": "chat-tools", "lane": "linux", "level": "subprocess protocol and metrics",
      "dependencies": ["tests/chat-speech-runtime.py", "tests/chat-speech-benchmark.py", "tools/chat-speech-worker.py", "tools/chat-benchmark.py"],
      "resources": ["python3", "owned-loopback-services", "owned-python-children", "synthetic-audio"]
    },
    {
      "id": "era-hub:tests/chat-ui.test.mjs",
      "purpose": "Conversation/voice generations, neutral gating, bounded PCM resampling and idle worklet retention",
      "group": "chat", "lane": "linux", "level": "controller and VM worklet unit",
      "dependencies": ["public/chat/controller.js", "public/chat/voice.js", "public/chat/pcm-worklet.js"],
      "resources": ["in-process-voice-doubles", "vm-worklet-harness"]
    },
    {
      "id": "era-hub:tests/games-state.test.mjs",
      "purpose": "Independent persisted workspaces, legal game rules, confirmations, deterministic randomness and reversible undo",
      "group": "games", "lane": "linux", "level": "state unit",
      "dependencies": ["public/games/state.js"],
      "resources": ["in-process"]
    },
    {
      "id": "era-hub:tests/games-ui.test.mjs",
      "purpose": "Rendered game journeys, real shared dwell/doors, lifecycle recovery, geometry and distinct catalog options",
      "group": "games", "lane": "linux", "level": "browser access and integration",
      "dependencies": ["public/games/**", "era-core/lib/**", "era-core/dwell.js", "era-core/speech.js"],
      "resources": ["chromium", "owned-loopback-services", "private-browser-storage", "real-dwell-timers", "rendered-catalog-matrix"]
    },
    {
      "id": "era-hub:tests/games-audio.test.mjs",
      "purpose": "Explicit synthesized music activation, Talk cancellation, shared cap and scheduled-note cleanup",
      "group": "games", "lane": "linux", "level": "browser audio lifecycle integration",
      "dependencies": ["public/games/**", "era-core/lib/**", "era-core/dwell.js", "era-core/speech.js", "music volume setting contract"],
      "resources": ["chromium", "owned-loopback-services", "private-browser-storage", "deferred-audio-context-double"]
    }
  ],
  "support": [
    { "id": "era-hub:tests/chat-speech-runtime.py", "purpose": "Optional speech runtime protocol checks", "consumers": ["era-hub:tests/chat-speech.test.mjs"] },
    { "id": "era-hub:tests/chat-speech-benchmark.py", "purpose": "Evaluation metric and replay checks", "consumers": ["era-hub:tests/chat-speech.test.mjs"] }
  ]
}
```

The metadata above records the original audit. The execution registry qualifies
source paths and includes reconciled implementation dependencies and conservative
shared-helper consumer lists. Chat classification brought the inventory from
138 to 144 suites; Games brings it to 147. Keep measured suite durations and
initial outcomes in run receipts. Do not remove cases or split stateful files
merely to reduce the reported suite count.

## Published shared speech readiness supplement

Core `02377c5471b6bf2eac71a3554cb65658992456aa` adds
`tests/speech-ready.test.mjs`. Retain all four cases: a sentence during the voice
probe waits for the chosen voice, a stalled probe falls back after a bounded
wait, callers without initialization retain immediate local speech, and stopping
a waiting sentence preserves the probe while suppressing the stale sentence.
These protect production `speech.js` with controlled fetch, Audio and speech
synthesis in Chromium. They require no hub, network service, credentials or
physical speaker. The four-second fallback uses a virtual clock.

This boundary is distinct from `lib-contract`'s static values and `dwell-engine`'s
activation and rearm behavior. `speech-barge-in` awaits initialization before
checking delayed clip cancellation, so it cannot detect this startup race.
One targeted run passed all four cases with zero skips or TODOs in 1.82 seconds
including browser startup. This small shared regression suite therefore joins
the always-run development smoke set; the observation is not a runtime budget
or a substitute for complete gate evidence.

The registry refused the new executable suite before classification. Its exact
speech dependency, browser resources and conservative helper consumer membership
are now registered, with review date 2026-10-26. Core changes still select the
complete gate. Chat and Games are now registered without new omission rules.
