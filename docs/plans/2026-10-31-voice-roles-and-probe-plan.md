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

- [ ] `tests/chat-voice-stream.test.mjs` (real hub case): `/tts` with no
      `voice` asks the stand-in for `voiceId`; `voice: "helper"` asks for
      `helperVoiceId` (and for Jessica when the file has none); `voice:
      "x"` is 400; the two clips cache under different files.
- [ ] `tests/settings-ui.test.mjs`: `/voices` carries `helper`; `/settings`
      round-trips `helperVoiceId`, refuses a non-curated id; the card shows
      "Her voice" and "Helper voice" rows and a helper pick posts
      `helperVoiceId`.
- [ ] `tests/ai-config.test.mjs`: `elevenRole().voiceId` is
      `helperVoiceId`, default Jessica.
- [ ] `server.js`: `DEFAULT_HELPER_VOICE_ID`, Hope first in
      `CURATED_VOICES`, `loadTtsCfg` fills `helperVoiceId`, `streamTts(cfg,
      text, res, role)`, `/tts` role parsing, `/voices` `helper`,
      `/settings` GET/POST `helperVoiceId`.
- [ ] `ai-config.js` `elevenRole`.
- [ ] `public/settings/index.html`: two rows, two previews with roles, hint
      text says which voice does what.
- [ ] Affected suites green (`node tools/test-suite.mjs plan --base master`).

## Task C — Chat: her pick in her voice, everything else in the helper voice

- [ ] `tests/chat-voice.test.mjs`: `say(text, { role: "her" })` posts
      `voice: "her"`; `role: "helper"` posts `helper`; default role is
      `her`; same text under two roles is two `/tts` requests and two cache
      entries; `prefetch(items, { role })` carries it; a changed `helper` id
      from `/voices` clears clips.
- [ ] A browser suite that stubs `/tts` (chat-browser or
      chat-test-mode-browser): her pick carries `her`; the echo, "your
      options are" and each label carry `helper`.
- [ ] `public/chat/voice.js`, `public/chat/app.js` per spec §3.3.
- [ ] Affected chat suites green.

## Task D — overseer: review, gate, docs

- [ ] Review each task's diff against the spec.
- [ ] Full gate detached with `ERA_WT_SUFFIX=--wt-elevenlabs-voice-timing`,
      one `tools/gate-wait.sh` call.
- [ ] Retrospective below; `docs/dev-flow.md` untouched unless the rail
      changed.
- [ ] Land era-core, then era-hub, in one sitting; patch build; push to the
      home I-13 and tablet on the maintainer's word; release on his word.

## Retrospective

(filled in when the work lands)
