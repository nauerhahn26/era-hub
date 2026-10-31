# Two voices, and a probe that does not play — design (2026-10-31)

Slug `elevenlabs-voice-timing`, two repos: `era-core--wt-elevenlabs-voice-timing`
(speech.js) and `era-hub--wt-elevenlabs-voice-timing` (hub, Chat, Settings,
builder role). Plan: `docs/plans/2026-10-31-voice-roles-and-probe-plan.md`.

## 1. What the maintainer reported (10/29–10/31)

1. "It's very common that the question that comes before the video in This
   Week doesn't use the ElevenLabs voice." The 10/26 fix (speech-ready: a
   sentence waits for the voice probe, cap 4 s) did not end it.
2. Her voice is Hope (since 10/29). "Anything that's not her speaking, like
   reading back the question or choices, should be in Jessica's voice."
3. On the probe: "That seems aggressive to literally play out every audio
   file."

## 2. Root cause of (1)

`era-core/speech.js` `probe()` fetches `/voices`, then `sayEleven(sample,
"long", muted=true)`: it downloads the sample clip AND plays it muted to its
end (`playClip` resolves on `ended` or a text-length timeout) before setting
`mode = "eleven"`. `watch.js` passes the before-video question as the sample,
so a long question is a long probe. The cost is wall time, not compute: clip
download (a fresh round trip since the 10/29 voice change emptied every cache
key) plus the clip's own playing time commonly exceeds `READY_CAP_MS` (4 s);
the cap expires with `mode` still `null`, `speakNow` falls to `sayLocal`, and
the already-downloaded clip is never used.

## 3. Design

### 3.1 The probe stops at "the clip arrived" (era-core)

`probe(sample)`: `/voices` says `enabled` → `fetchClip(sample)` (download
only; the blob lands in `clipCache`) → `mode = "eleven"`. No `Audio` is
created and nothing plays, muted or otherwise, during the probe. A failed
`/voices` or clip fetch falls to the local self-test exactly as today. The
first sentence of a page is usually the sample, so it plays at once from the
cache. `READY_CAP_MS` stays 4 s as the safety net.

### 3.2 Two voice roles (hub)

| role | who | voice | default id |
|---|---|---|---|
| `her` | what she says: her chosen reply in Chat, her chosen words | `voiceId` | Hope `cVd39cx0VtXNC13y5Y7z` on her devices (file already set) |
| `helper` | everything else: every prompt and question through `speech.js` (Which one, Sort it, Play it, the before-video question, Drawing, Math, reader prompts, dwell previews), Chat's "your options are" reading and each label, the partner's question echoed in Chat, Settings previews, book narration | `helperVoiceId` | Jessica `cgSgspJ2msm6clMCkdW9` |

- `tts-config.json` gains `helperVoiceId` (optional). `loadTtsCfg()` fills
  the default when absent. No device file needs editing: her devices keep
  `voiceId` = Hope and get Jessica as helper by default.
- `POST /tts` body: `{ text, voice }` with `voice` ∈ `"her" | "helper"`;
  absent = `"her"` (today's behaviour for any caller that does not say);
  anything else → 400. The role picks the id; the disk cache key already
  includes the voice id, so clips never collide and this week's Jessica
  question clips are still on disk.
- `GET /voices` adds `helper` (the helper id) beside `current` (hers).
- `GET /settings` adds `helperVoiceId`; `POST /settings` accepts
  `helperVoiceId` (curated ids only, like `voiceId`). `POST /voice` is
  unchanged (her voice).
- `CURATED_VOICES` gains Hope first, same line as wt-real-time-chat 715dd04
  (`{ id: "cVd39cx0VtXNC13y5Y7z", name: "Hope — young and warm" }`), so her
  voice is a legal pick in Settings and the later merge is a no-op.
- `ai-config.js` `elevenRole()`: the builder's narration voice is the helper
  voice (`helperVoiceId` → `DEFAULT_VOICE_ID`, which is already Jessica).
  Books already narrated keep their recordings and credits.

### 3.3 Callers

- `era-core/speech.js` posts `{ text, voice: "helper" }` for every clip.
  Its `cycleVoice()` keeps `POST /voice`.
- `public/chat/voice.js`: `say(text, { role })` and `prefetch(items, { role })`
  carry the role; the clip cache and pending map key on role + text (one
  text can be both a read label and her pick). `/voices` is read as today;
  a changed `current` or `helper` clears clips.
- `public/chat/app.js`: `speak(choice)` → `her` for her pick, `helper` when
  `choice.echo`; the options reader (`createOptionsReader` `speak`) →
  `helper`; `prefetch(choices)` → `her`, the label and prefix prefetches →
  `helper`.
- Settings voice card: two rows of the same curated list, "Her voice" and
  "Helper voice", each previewing through `/tts` with its own role
  (`"Hi! This is my voice."` for hers, the existing helper sentence for the
  helper).

### 3.4 Out of scope (own worktrees later)

The Sort it sentence the hub composes ("Is glasses blocks the light…"), the
window glyph the device font lacks, and the maintainer's auditor idea.

## 4. Laws pinned by tests

- The probe never creates or plays an `Audio` (era-core `speech-ready`,
  `speech-barge-in`).
- A sentence said right after `init()` plays the clip voice once, from the
  probe's download, with one `/tts` request carrying `voice: "helper"`.
- `/tts` without `voice` uses `voiceId`; with `helper` uses `helperVoiceId`
  (default Jessica when the file has none); a bad role is 400; the two roles
  cache under different keys (`chat-voice-stream`).
- `GET /voices` reports `helper`; `GET/POST /settings` round-trip
  `helperVoiceId` and refuse a non-curated id (`settings-ui`).
- `elevenRole().voiceId` is the helper voice (`ai-config`).
- Chat: her pick posts `voice: "her"`; the echo, the options reading and its
  prefetches post `voice: "helper"`; same text under two roles is two clips
  (`chat-voice`).
