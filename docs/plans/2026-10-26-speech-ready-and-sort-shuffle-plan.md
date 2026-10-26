# Speech waits for its probe; Sort it shuffles — Implementation Plan (2026-10-26)

> **For agentic workers:** REQUIRED WORKFLOW: subagent-driven development (one fresh-context builder per task, the overseer reviews between tasks). Steps use `- [ ]` checkboxes. TDD on every task: the test is written and SEEN red before the code.

**Goal:** Dad, after assessing v1.0.14 (2026-10-26): (1) "on occasion it fails to use the ElevenLabs voice … in particular on the question right before the video"; (2) in Sort it "they go in order, there needs to be some randomness". Both are logic fixes, not this week's content.

**Root cause of (1):** `era-core/speech.js` starts with `mode = null`; `init()` picks the mode by an async probe (`fetch("/voices")`, then one muted clip). `public/watch/watch.js:126` calls `Speech.init(item.q)` without awaiting and `mountWhich` says the question at once → `speakNow` sees `mode !== "eleven"` → `sayLocal`. When the clip is already cached the probe wins the race, hence "on occasion". `play.js:217` has the same shape; its first sentence comes after a dwell, so it rarely bites.

**Architecture:** two repos, one slug `speech-ready`. *era-core* (`~/new-era/era-core--wt-speech-ready`): `speech.js` keeps the init promise and lets `say()` wait for it (capped); tests in `tests/speech-*.test.mjs`. *era-hub* (`~/new-era/era-hub--wt-speech-ready`): `public/play/sort.js` shuffles its items at mount with a seedable RNG seam; `tests/play-ui.test.mjs` pins it. The hub's `public/speech.js` is a link to era-core's file (`tools/assemble.sh`), so the gate with `ERA_WT_SUFFIX=--wt-speech-ready` runs both worktrees together.

**Spec:** `docs/specs/2026-10-12-weekly-suite-design.md` §5.6 (Sort it amended 2026-10-26; "The voice" paragraph).

**Discipline:** TDD; one builder per worktree; `git add` exact paths; house commit style (`speech: …` in era-core, `this-week: …` in the hub); no vendor or model names; no attribution trailers; no family names but Ellie; STOP and report if a test outside the plan fails or an assertion must be weakened.

## Definitions

### era-core `speech.js`
- `init()` stores its promise in `ready` (module scope) before awaiting anything; a second `init()` call replaces it.
- `say(text, kind)` for `kind !== "letter"`: the chain step first awaits `Promise.race([ready, sleep(READY_CAP_MS)])` when `mode === null` and `ready` is pending, then proceeds exactly as today (`speakNow` reads `mode` after the wait). `READY_CAP_MS = 4000`. Letter echoes are untouched (they are typed, never the first sentence of a page).
- If the probe rejects or caps out, `mode` stays whatever `init()` set (it always sets `mode` on its own exit), and the sentence plays by the usual fallback. `mode === "off"` short-circuit stays as is — but only once `mode` is actually known (a `null` mode is "unknown", not "off").
- `stop()` does not cancel `ready`. `window.__testHooks` keeps `mode = "test"` immediate (no behaviour change for existing suites).
- Header comment: one paragraph on the law ("a sentence waits for the probe; cap 4 s").

### era-hub `public/play/sort.js`
- `mountSort(host, sort, opts)`: `items` are shuffled (Fisher–Yates) at mount using `rng()` = `window.__testHooks && typeof window.__rng === "function" ? window.__rng : Math.random`. If the shuffle's first item equals the id remembered from the previous play of this week (`sessionStorage` key `era-sort-first:<week_of>` — `opts.weekOf` passed by `play.js`), rotate the order by one. Remember the new first item's id after the shuffle. Bins untouched. `onItem`, logs and the question formula keep working on the shuffled order (the log carries the item id, so the order is reconstructible).
- `play.js` passes `weekOf: S.week` (or whatever the page already holds) to `mountSort`.

### Ports and tests
| suite | port | file |
|---|---|---|
| era-core speech | (its own) | `era-core/tests/speech-ready.test.mjs` (new) |
| play-ui | 8466 | `era-hub/tests/play-ui.test.mjs` |

## Task skeleton

### Task A — era-core: the sentence waits for the probe — posture hint: implementing
- [ ] A1 Tests first (new `tests/speech-ready.test.mjs`, in the mould of `speech-engine.test.mjs`): (a) with `/voices` answering `{enabled:true}` after a 300 ms delay and a clip that plays, `say("Q")` issued 10 ms after `init()` plays through the ElevenLabs path (one `/tts` request for "Q"), not the local one; (b) with `/voices` never answering, `say("Q")` plays locally after `READY_CAP_MS` (under fake timers), not before; (c) with no `init()` ever called, `say()` behaves as today; (d) `stop()` during the wait drops the sentence and leaves `ready` intact. See them red. Note: test mode (`__testHooks`) forces `mode = "test"` at once, so these tests must drive the real path with stubbed `fetch`/`Audio`/`speechSynthesis` the way the existing engine tests do — read them first.
- [ ] A2 `speech.js` per Definitions; existing speech suites green; commit `speech: a sentence waits for the voice probe before choosing its voice (cap 4 s) — the first sentence of a page spoke before init() had answered and fell to the local voice; the question before a video did it on every cold start`.

### Task B — era-hub: Sort it shuffles — posture hint: implementing
- [ ] B1 Tests first in `tests/play-ui.test.mjs`: with `__rng` pinned to a sequence that reverses the order, the first item shown is the manifest's last and the questions follow the shuffled order; the existing Sort tests that assume manifest order get a pinned identity `__rng` (never weaken an assertion — pin the order instead); a second mount in the same session with an `__rng` that would repeat the first item rotates it away; bins' labels and seats unchanged. See them red.
- [ ] B2 `sort.js` + `play.js` per Definitions; play-ui green (8466); commit `this-week: Sort it shuffles its items every time it opens and never reopens on the last play's first item — the set ran in the written order every time (spec 2026-10-12 §5.6, amended 2026-10-26)`.

### Phase F — the overseer: gate AT THE BACK OF THE LINE (dad 10/26), land era-core then era-hub, patch release under the shared release lock, devices
- [ ] F1 Coordinate the gate start with the testing-suite session (the legacy-gate startup guard during the Chat pilot); `ERA_WT_SUFFIX=--wt-speech-ready`.
- [ ] F2 Land era-core, then era-hub (sync first if master moved); release `--patch --skip-gate` on the fresh stamp inside `flock /tmp/era-suite-release.lock`; tablet + home i13; tell dad.
