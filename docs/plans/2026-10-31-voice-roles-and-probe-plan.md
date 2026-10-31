# Two voices, and a probe that does not play — plan (2026-10-31)

Spec: `docs/specs/2026-10-31-voice-roles-and-probe-design.md`. One builder per
task, TDD (the test is seen red before the code), `git add` exact paths,
house commit style (`speech: …` in era-core, `hub: …` / `chat: …` /
`settings: …` here), no vendor or model names in code or commits, no
attribution trailers, no family names but Ellie. STOP and report if a test
outside the task fails or an assertion must be weakened.

Worktrees: `~/new-era/era-core--wt-elevenlabs-voice-timing` and
`~/new-era/era-hub--wt-elevenlabs-voice-timing`. The hub's `public/speech.js`
is a link to era-core's file; the gate runs with
`ERA_WT_SUFFIX=--wt-elevenlabs-voice-timing`.

## Task A — era-core: the probe downloads, never plays; clips ask for the helper voice

- [x] `tests/speech-ready.test.mjs`: the probe produces no `play` event; the
      sentence after `init()` plays `clip:Q` once (the probe's download is
      the sentence's clip when the sample is the question); every `/tts`
      body carries `voice: "helper"`.
- [x] `tests/speech-barge-in.test.mjs`: "boot self-test remains silent"
      becomes "boot never plays" (no `play` event at boot).
- [x] `speech.js`: `probe()` = `/voices` enabled → `fetchClip(sample)` →
      `mode = "eleven"`, else the local self-test as today; `fetchClip`
      posts `{ text, voice: "helper" }`. Header comment updated.
- [x] `node --test tests/*.test.mjs` green in era-core (a bare `tests/` is read as one file on this node) — 71/0, commit 2e37b08.

## Task B — hub: voice roles in `/tts`, config, `/voices`, `/settings`, builder role, Settings card

- [x] `tests/chat-voice-stream.test.mjs` (real hub case): `/tts` with no
      `voice` asks the stand-in for `voiceId`; `voice: "helper"` asks for
      `helperVoiceId` (and for Jessica when the file has none); `voice:
      "x"` is 400; the two clips cache under different files.
- [x] `tests/settings-ui.test.mjs`: `/voices` carries `helper`; `/settings`
      round-trips `helperVoiceId`, refuses a non-curated id; the card shows
      "Her voice" and "Helper voice" rows and a helper pick posts
      `helperVoiceId`.
- [x] `tests/ai-config.test.mjs`: `elevenRole().voiceId` is
      `helperVoiceId`, default Jessica.
- [x] `server.js`: `DEFAULT_HELPER_VOICE_ID`, Hope first in
      `CURATED_VOICES`, `loadTtsCfg` fills `helperVoiceId`, `streamTts(cfg,
      text, res, role)`, `/tts` role parsing, `/voices` `helper`,
      `/settings` GET/POST `helperVoiceId`.
- [x] `ai-config.js` `elevenRole`.
- [x] `public/settings/index.html`: two rows, two previews with roles, hint
      text says which voice does what.
- [x] Affected suites green (`node tools/test-suite.mjs plan --base master`).

## Task C — Chat: her pick in her voice, everything else in the helper voice

- [x] `tests/chat-voice.test.mjs`: `say(text, { role: "her" })` posts
      `voice: "her"`; `role: "helper"` posts `helper`; default role is
      `her`; same text under two roles is two `/tts` requests and two cache
      entries; `prefetch(items, { role })` carries it; a changed `helper` id
      from `/voices` clears clips.
- [x] A browser suite that stubs `/tts` (chat-browser or
      chat-test-mode-browser): her pick carries `her`; the echo, "your
      options are" and each label carry `helper`.
- [x] `public/chat/voice.js`, `public/chat/app.js` per spec §3.3.
- [x] Affected chat suites green.

## Task D — overseer: review, gate, docs

- [x] Review each task's diff against the spec (2e37b08 core; 7f00ec7, 61627b8, 42bfc39 hub).
- [x] Full gate detached with `ERA_WT_SUFFIX=--wt-elevenlabs-voice-timing`,
      one `tools/gate-wait.sh` call — 207 passed, 0 failed (run 2026-10-31T19-11-06Z).
- [x] Retrospective below; `docs/dev-flow.md` untouched unless the rail
      changed.
- [x] Landed era-core 62abdf7, era-hub c88f99e (10/31); v1.0.43 patch dist built
      from the worktree.
- [ ] Push to the home I-13 and tablet on the maintainer's word; release on his word.

## Retrospective

- The 10/26 speech-ready fix was right about the race and wrong about the
  probe's length: a probe that plays its sample to the end is bounded by the
  clip, not by the network, and the before-video question is the longest
  sample any app passes. Tests that drive `init()` with a stubbed Audio whose
  `play()` ends on the next microtask could never see it. A probe should
  prove the service with the cheapest thing that proves it.
- The content-narrate suite pinned her voice reading books by naming
  `voiceId` in a fixture; the role split made that assertion wrong on
  purpose. Fixture renamed, assertion kept.
- Master moved twice under the branch (Hope first in the curated list and
  the key-role default; the retired board-arrange registry entry). Keeping
  the Hope line byte-identical to the sibling commit made that merge a
  no-op; the narration default was the one real conflict and the spec
  decided it (helper, not her).
- `node --test tests/` on this node treats the folder as one file; use
  `tests/*.test.mjs`. `tools/test-suite.mjs plan` refuses while the
  registry names a suite master retired; sync first.
- Parked: the Sort it sentence the hub composes, the window glyph the
  device font lacks, and the auditor the maintainer asked for.
