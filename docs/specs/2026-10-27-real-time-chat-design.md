# Real-time chat — design (2026-10-27)

Dad, 10/27, after the first installed Chat trial: "the overall interactive chat
is just way too slow ... it needs to basically be like the experience of
chatting with your AI ... I want the best experience. I'm willing to pay for
it." Also: "we need really good telemetry ... everything that's going on in the
device, usage, what it's interpreting, response times", and "the icons, just
like a total miss. It should be like an easy library that we can steal from."

Trial-night quotes (10/25 PT, from the Chat session record): "I sent a request.
Oh, that was way too slow." "Better. Not using Icons. Are you logging response
time?" "It's also not using eleven labs voices."

This record amends the Chat feature as published in v1.0.20
([prototype](2026-10-25-chat-prototype.md), [hold button](2026-10-25-chat-hold-button.md),
[installed release](2026-10-25-chat-installed-release.md),
[trial feedback](2026-10-26-chat-trial-feedback.md)). It keeps every
communicator-safety law in them and changes how the work behind the tiles is
done. Sweep evidence: five read-only recon reports, 10/27; numbers below are
from `~/.cache/era-chat/benchmarks` (host-paced), one recorded clip replayed
through the installed hub on the home device, and the independent
conversational streaming-transcription benchmark published 9/2026.

## 1. Where the time goes today

The v1.0.20 turn is strictly serial. Nothing starts until the step before it
has finished, and nothing is streamed.

| Stage | What happens | Measured |
| --- | --- | --- |
| Hold | 100 ms PCM frames, one HTTP POST each, buffered in the worker; no recognition | the whole hold is dead overlap |
| Release → transcript | worklet flush, drain, finish, a second activity pass, then **one WAV upload** to the transcription service; wait for the whole JSON | 1871 ms on the device (one clip); host p50/p95 648/1942 ms |
| Transcript → choices | one **non-streaming** reply-model call, 450-token cap, strict schema; shortcuts for either/or, yes/no, greetings | 2469 ms generated on the device; 192 ms when a shortcut matched; host 1.1–1.9 s (the earlier "smaller setting, 333 ms" figure timed failed requests and is void) |
| Choices → reveal | staged tiles wait for a **fresh move** of her gaze into a black rest cell, then a 600 ms dwell suppress | unbounded; never measured on a host |
| Reveal → speech | 1200 ms default dwell; saved-voice clip fetched if not prefetched; playback at 0.8 speed | 549 ms per cache miss; 2 concurrent prefetches, so tiles 3 and 4 queue |

Dad's own slow turn was on v1.0.16, which recorded no timings; v1.0.20's rows
are content-free numbers held on the device with no timestamp, build or device
id, and nothing goes upstream. So the first thing this work needs is evidence.

Roughly: 1.9 s + 2.5 s + the gaze gate + 0.6 s + 1.2 s before Ellie has even
scanned the tiles. The specs' own target was about 1 s from end of utterance to
usable choices.

## 2. Targets

Measured on the home device, over at least 20 real partner turns, in test mode
(§5):

| Stage | p50 | p95 |
| --- | --- | --- |
| Release → final transcript | 0.4 s | 0.8 s |
| Release → first choice staged | 0.8 s | 1.5 s |
| Release → all choices staged | 1.2 s | 2.0 s |
| With speculation on partials, choices ready at release | often | — |
| Selection → first audio | 0.15 s | 0.4 s |
| Staged → selectable (the reveal gate) | bounded by Ellie, see §4 | — |

Quality takes precedence over speed (prototype spec §Evaluation). A faster
transcript that changes the question is a failure, so the transcription choice
is made by a bake-off on our own recordings (plan phase 0), not by the public
benchmark alone.

## 3. The streaming pipeline

### 3.1 Audio: one open channel, not one POST per frame

- The page opens one WebSocket to the hub when Chat starts (`/chat/api/sessions/:id/audio`)
  and keeps it for the session. Node 22 serves the upgrade in the hub with no
  new dependency; the browser already has the client. Frames go as binary
  PCM16 at 16 kHz, 20–100 ms each, in order, with the generation number.
- The hub, not the browser, talks to the transcription service. Credentials
  never reach the page (installed-release spec). The hub holds one warm
  connection to the service per Chat session, opened at Start Chat and kept
  alive between turns within the service's billing rules (some bill for open
  socket time; the hub closes an idle socket after a bounded quiet period and
  reopens it on touch-down, which costs one connect, measured).
- The local speech-activity model still gates what is sent: during a hold,
  frames stream as they arrive; outside a hold nothing is sent (hold-button
  spec: no idle PCM leaves the device). Voice activation stays off.
- Release sends a finalize to the service instead of an upload. The partner's
  release is the endpoint; no server-side turn detection is needed for the
  hold pilot. Cancel, hide, leave and timeout discard the turn as today.
- Caps are redesigned for streaming: 15 s hold stays; the per-POST and
  per-utterance byte caps become a per-turn frame budget.

### 3.2 Transcription: streaming, with her words boosted

- A streaming transcription service with keyterm boosting. The hub sends a
  bounded keyterm list (family first names, classmates, teacher, school and
  class words, her favourites) assembled from private settings and the
  family library, never from the repo.
- Partials stream to the page over the existing SSE event route and are shown
  to the partner as "Heard so far"; they never touch the tiles.
- The final transcript is the only thing the choice pipeline commits to.
- The configuration is private settings only: `ERA_CHAT_STREAM_URL`,
  `ERA_CHAT_STREAM_MODEL`, `ERA_CHAT_STREAM_TOKEN`, `ERA_CHAT_STREAM_KEYTERMS`
  (a file path), delivered to devices the way the seven v1.0.20 settings were.
  The one-shot WAV path stays as the fallback when the stream setting is
  absent or the socket fails mid-turn.

### 3.3 Choices: start early, arrive one by one

- **Speculative generation.** When a partial has been stable for a short
  window (about 300 ms, tunable) the hub starts a hidden choice request on
  it. On the final transcript the hub compares: same meaning (normalized text
  equal, or the service's own confidence that nothing changed) keeps the
  speculative batch; otherwise it is discarded and a new request starts.
  Speculative batches are never shown and never spoken.
- **Streaming output.** The reply model streams its structured output; the
  hub parses choices as they complete and forwards each to the page as it
  lands. The page stages them one at a time. Staging is invisible until the
  reveal, so the immutable-choices law is untouched: the batch is sealed at
  reveal time, and nothing added later joins it.
- **A fast reply setting.** The published reply model, reasoning off, streamed,
  on the vendor's fast processing tier (phase 0, §9): first choice 594 / 913 ms
  p50 / p95 on the host, all choices 749 / 1096 ms, about $0.00035 a turn.
  Smaller and other-vendor models were not better: they invented details,
  dropped the third of three alternatives, or could not turn thinking off.
  The instruction prefix is under the vendors' 1024-token cache floor, so
  caching does not engage; keep the prefix short rather than pad it.
- **Warm connections.** One keep-alive agent for the reply model and the
  saved-voice service for the hub's lifetime.
- Shortcuts (either/or, yes/no, greetings) stay and now also run on partials.

### 3.4 Speech: ready before she looks

- Prefetch every staged choice with the saved voice at once (concurrency equal
  to the batch size, not 2), as each one stages.
- Use the saved-voice service's streaming endpoint so a cache miss starts
  playing at first bytes instead of after the whole clip.
- Drop the per-say voice-list refetch; refresh the list on a timer.
- Playback speed stays the partner's setting (default 0.8 since 10/26).

## 4. The reveal gate (dad's decision)

The fresh-movement rule exists so a batch never lands under a gaze that is
already dwelling (nothing selects by accident). Today it costs an unbounded wait
plus 600 ms. Options, with the recommended one first:

1. **Resting counts.** A gaze already inside the black centre when the batch
   seals is the neutral boundary; no fresh move is required. Suppress drops to
   the contract's 250 ms redraw settle. A gaze on a tile cell when the batch
   seals still waits for a move into the centre.
2. Keep the fresh move, shorten the suppress to 250 ms.
3. Keep everything as published.

Dwell stays the partner's setting (default 1200 ms).

## 5. Telemetry: a test mode that records everything, off by default

Production Chat keeps the v1.0.20 privacy contract (content-free numeric rows,
nothing uploaded). **Test mode** is a separate, explicit, per-device switch in
the partner settings, shown as a banner on the Chat page while on, never on by
default and never on in the public payload's defaults. While it is on the hub
writes one JSON line per turn to `data/logs/chat-turns/YYYY-MM-DD.jsonl` and
appends the same line to the family data pool (Drive-synced, like the other
apps' `/log` events), carrying:

- identity: timestamp, build, device id, session id, turn id, mode
  (stream / one-shot / local), reply setting id and model ids as configured
  (ids only, never credentials or URLs);
- the full stage timeline (every mark v1.0.20 defines plus: socket connect,
  first partial, each partial's arrival and text, finalize sent, final
  arrival, speculative start/keep/discard, first choice staged, each choice
  staged, batch sealed, reveal, selection, first audio, playback end);
- content: final transcript, every partial, the staged choices with their
  symbol ids, which was selected, what was spoken, the keyterms that fired;
- cost and usage: audio seconds streamed, socket open seconds, reply-model
  input/cached/output tokens, saved-voice characters and cache hit/miss, an
  estimated cost per turn from a private price table;
- device health at release and at reveal: CPU load, free memory, hub event
  loop lag, gaze state from the supervisor, microphone level and clipping,
  network round trip to the hub's service endpoints;
- outcome: completed / cancelled / failed with reason, and the error text.

The partner diagnostics panel shows the live timeline for the current turn and
the last ten, with the summaries per stage and per build. A host tool
(`tools/chat-turns.mjs`) reads the synced pool and prints p50/p95 per stage per
build, cost per day, and failure reasons, so dad's testing has numbers the
same evening. A replay tool re-runs a recorded turn's audio (test mode keeps
the turn's PCM in `data/logs/chat-turns/audio/` only while on, bounded to the
last 200 turns) through any configured transcription setting, which is the
bake-off harness.

Turning test mode off stops writing, keeps what was written, and the hub
never deletes those files itself; the partner panel has a "delete test
recordings" control.

### 5.1 Test mode as built (phase 1, 10/27)

Test mode is a separate route and schema. `public/chat/metrics.js`,
`public/chat/storage.js`, `chat-store.js` and their tests are unchanged byte
for byte; the page taps the same marks through `observeMetrics` in
`public/chat/turnlog.js`, and the production rows stay content-free whether
test mode is on or off (`tests/chat-turnlog.test.mjs`, the browser suite).
The trial-feedback privacy contract (production rows; context, questions,
replies and audio ephemeral) holds while the switch is off; with it on, by
dad's decision 3 in the plan, the turn's words and timings are kept on the
device AND their text lines sync to the family data folder (the Drive-synced
pool), while the held-question audio stays on the device only.

- **Switch.** `chatTestMode` in `app-settings.json`, read by `GET /settings`
  (default `false`), moved only by a real boolean on `POST /settings`, and
  never by a request a page on another site steered (`Sec-Fetch-Site` other
  than `same-origin` or `none` is ignored, as for the hub's other doors). The
  partner settings show a "Test mode" section with a touch-only switch (a
  trusted keyboard press is the desktop path; gaze and injected clicks are
  inert) and a two-touch "Delete test recordings" control. While on, the
  banner "Test mode: this computer is recording Chat turns" sits at the top
  of the message bar, outside the grid. The payload guard refuses any
  `app-settings.json`, `chat-prices.json`, `chat-turns/` file or a shipped
  file that sets the switch true.
- **Routes** (`chat-turns.js`, loopback and same-origin like `chat-store.js`,
  dispatched before the Chat API):
  `POST /chat/api/turns` (one record, JSON, at most 64 KB; 201 with the
  estimated cost), `PUT /chat/api/turns/<uuid>/audio` (PCM16, 16 kHz mono,
  1 byte to 15 s, stored as `logs/chat-turns/audio/<uuid>.wav`; only for a
  turn this hub recorded (404 otherwise, so no orphan recordings); 409 if
  that turn already has one; the newest 200 kept), `GET /chat/api/turns` (the
  last ten records and per-build summaries over the last 500), `GET
  /chat/api/health`, `GET /chat/api/health/warm` and `DELETE /chat/api/turns`.
  With the switch off every route but DELETE answers 404 and writes nothing.
  DELETE works on or off: it removes `logs/chat-turns/*.jsonl`, the audio
  folder, every `chat-turn` line in this device's own pool folder, and, in a
  folder of an earlier id of this device, the `chat-turn` lines of turns this
  device recorded (their ids come from the day files being deleted). Each
  pool file is rewritten tmp-then-rename in one synchronous step; other
  kinds, torn lines and other devices' turns are never touched; copies a
  syncer already carried elsewhere follow when it syncs the rewrite. A file
  that cannot be replaced is listed in the answer (`failed`) and named on the
  page. A day file stops at 16 MB (507).
- **Record** (strict: unknown fields, unknown stages, out-of-range numbers and
  control characters are rejected). Posted by the page:
  `version` 1, `id` (uuid), `kind` hold/typed/fixed/reply, `mode`
  one-shot/stream/local/typed/none, `session` (the Chat session id or null),
  `startedAt`, `outcome` completed/cancelled/failed, `reason` (the v1.0.20
  reasons; required unless completed), `error` (≤ 300 characters),
  `stages` [{`name`, `ms` from the turn's start, `text` on partials and staged
  choices}] up to 300, `worker` {audioMs, captureWallMs, activityMs, cloudMs,
  firstPartialMs, finalDecodeMs, turnMs, finalizeMs, choicesServerMs},
  `content` {transcript, partials (≤ 100), choiceKind, choices [{id, label,
  say, symbol}], selected, spoken, keyterms (null until phase 2)}, `usage`
  {reply {model, inputTokens, cachedTokens, outputTokens}, audioSeconds,
  socketSeconds (null until phase 2), voice {chars, cache hit/pending/miss/device,
  fetchedChars}}, `health` {release, reveal}, `mic` {peakRms, clipped,
  frames}. Stage times past the one-hour bound are clamped by the page. The
  hub adds `receivedAt`, `day` (the device's local calendar day), `build`,
  `device`, `models` {reply, transcription: the model configured for the
  turn's mode, null for local or no recognition} (ids only, never a URL or
  credential) and `cost`, writes the line to `logs/chat-turns/<day>.jsonl`
  and appends
  `{t, device, kind: "chat-turn", turn: <the same record>}` to the pool. Audio
  never enters the pool.
- **Stage names.** The v1.0.20 marks (`release`, `drained`, `finishSent` = the
  finalize, `finishAck`, `transcript` = the final's arrival, `choicesReady`,
  `revealed`, `selected`, `playbackStart`, `playbackEnd`) plus `begin`,
  `firstPartial`, `partial`, `firstChoiceStaged`, `choiceStaged`,
  `batchSealed` (just before `revealed`: the batch is sealed at reveal),
  `firstAudio` (the playback start until the streaming voice lands in phase 2)
  and, reserved for phase 2, `socketConnect` and `speculativeStart/Keep/Discard`.
- **Audio** is kept only for a hold that was released and submitted
  (`finishSent`); a cancelled hold keeps none. It is uploaded after the record.
- **Usage.** The in-process reply core returns the service's token counts
  and the configured model id; `/chat/api/choices` passes them to the page
  only while the switch is on (never through an external adapter), and the
  production rows never take them. No usage is reported when the service gave
  none or a shortcut answered. Audio seconds are the worker's `audioMs`. The
  saved voice reports the chosen clip's characters and whether it was ready,
  and the characters of each clip fetched for this turn's own staged choices
  or spoken words (`fetchedChars`; warming the fixed phrases is no turn's; an
  upper bound, since the hub's TTS disk cache may answer without a paid call).
- **Price table** `<data>/chat-prices.json` (private, never in the repo or a
  payload; absent or unreadable means `cost: null`):

  ```json
  { "version": 1, "currency": "USD",
    "reply": { "<model id>": { "inputPerMillion": 0, "cachedInputPerMillion": 0, "outputPerMillion": 0 } },
    "transcription": { "<model id>": { "perAudioMinute": 0, "perSocketMinute": 0 } },
    "voice": { "perThousandChars": 0 } }
  ```

  Cost per turn: `{currency, reply, transcription, voice, total, complete}`;
  transcription is priced by the turn's mode (one-shot and stream by their
  configured models; local, typed and fixed turns cost 0); a part whose model
  has no price is null and `complete` false.
- **Health** (`GET /chat/api/health`, sampled by the page at release and at
  reveal, never awaited by either): `cpuBusy` (0–1 from an `os.cpus()` delta
  over 200 ms, all platforms), `load1` (null on Windows), free and total
  memory, `eventLoopLagMs` (the worst lateness of a 100 ms timer over the last
  ~5 s; the timer runs only from the first sample with the switch on until
  the switch reads off), `gaze` (the supervisor's state) and `rtt`
  {transcription, reply}: the last measured HEAD to each configured service's
  origin, milliseconds or null, never the URL. The HEADs are sent only by
  `/health/warm`, which the page calls at a hold's touch-down (at most once
  per 30 s per origin), never at release. Microphone level and clipping are
  measured on the held question's 16 kHz frames as they leave the capture path.
- **Panel.** With test mode on, "Turn timings" adds the live timeline of the
  current turn (stage, milliseconds from release, partial and choice text),
  the last ten turns with their words and p50/p95 per stage per build with
  cost per day, drawn only while the panel is open (changes are coalesced
  after the current task, so a reveal or selection does no extra synchronous
  work). Off, the panel is as published.
- **Host tools.** `node tools/chat-turns.mjs [--dir DATA|LOGS|POOL] [--json]
  [--turn ID]`; `node tools/chat-replay.mjs --turn ID --configs NAMES
  [--dir DATA] [--dry-run]` writes a one-clip manifest (reference: the turn's
  own transcript) and runs `uv run tools/chat-bakeoff.py --configs NAMES
  --manifest FILE --clips turn-ID`.

## 6. Pictures: a real pictogram library, at board size

The v1.0.20 pictures are 34 hand-drawn one-colour line icons, stacked above
the word at 40–64 px under a 74–90 px label, chosen by a 46-phrase table and
13 word patterns, with most generated replies falling to one speech bubble.
The hub already serves a child-oriented AAC pictogram library through
`GET /symbol/<word|id>` with a disk cache; the Clothing Picker and the board's
More and Stop tiles use it. Chat will too.

- **Vocabulary.** A reviewed table of about 300–600 concepts, each with one
  approved pictogram id, seeded from her TD Snap labels, the 46 fixed phrases
  and the library's core set; wrong picks are corrected by id the way "stop"
  and "back" already are. The table lives in the repo (ids and words only);
  the images do not (licence: non-commercial share-alike; fetched at runtime
  or pre-warmed, with the required credit on the About page, as the Drawing
  spec decided). Dad confirms the foundation's free app is non-commercial use.
- **The model picks the picture.** The choice schema gains a `symbol` field
  whose values are the vocabulary's words, with `chat` for "no clear picture".
  Strict schema means it cannot invent one. The negation rule moves into the
  prompt and stays as a server-side check.
- **Backups.** A feeling or object with no concept in the table uses the
  MIT emoji set already shipped for Drawing; the plain bubble is last.
- **Board law.** Picture beside the word at 42% of tile width and 82% of
  height, label 74 px floor (44 px only when nothing else fits, marked), the
  two black rest cells, 2–4 choices, no two tiles on a page sharing a symbol.
- **Offline.** Enabling Chat pre-warms the vocabulary's images into the cache
  so school, where outside hosts are unproven, still shows pictures.
- A preview page on a scratch hub shows the fixed phrases and 30 sample
  replies in the library's colour and black-and-white variants and the emoji
  backup, side by side, for dad to judge before the vocabulary is frozen.

**Decided shapes (phase 3 build, 10/27).**

- *Licence.* The maintainer's non-commercial ruling is recorded: the
  foundation's free app is non-commercial use of the library's BY-NC-SA
  pictures (plan decision 4; his own words and date to be quoted here when he
  gives them). The images stay out of the repository and are fetched by the
  hub into its cache; the credit the licence requires is the "About the
  pictures" card on the settings page, beside the Drawing stickers' MIT credit.
- *Vocabulary* `public/chat/vocabulary.json`: `phrases` (51 normalised fixed
  phrases, routes, shortcuts and guarded templates → a concept word) and
  `concepts` (389 rows `{word, id, alt?, altId?, tone?}`: one approved
  pictogram id, alternative spoken forms, an optional alternate picture for a
  repeat, `tone: "negative"` for refusal, negation and uncertainty). Seeded
  from her board labels (no person names), the fixed phrases and the library's
  English keyword list, every candidate reviewed on a contact sheet
  (`tools/chat-vocabulary-sheet.mjs`, which also prints ids that return no
  image: 0 of 389 on 10/27). Wrong picks are corrected by id in the table.
- *Schema.* Each choice is `{label ≤40, say ≤180, symbol}`, all required
  (strict); `symbol` is an enum of every concept word (389, "chat" included;
  capped at 400 in `chat-symbols.js`), about 3.3 kB / ~830 tokens of schema per
  request. The instruction gains one sentence: pick the symbol whose meaning
  matches the reply, never an affirmative picture for a refusal or negation,
  "chat" when unsure.
- *Hub pick* (`chat-symbols.js`, every choice the hub returns, shortcuts and
  guarded templates included): curated phrase → the model's symbol → the hub's
  text guess (one clear subject wins; broad words such as like, happy, play,
  listen never erase one; two subjects or none is "chat") → "chat". A reply
  whose label or say is negated (not, no, nope, never, n't forms, hate,
  dislike …) keeps only a `negative` picture — a refusal, negation or
  uncertainty, never a feeling: "Not sad" is not the sad face; otherwise "no"
  for a refusal ("no music", "no thanks", "don't want/need"), "don't like" for
  a dislike, else "chat". A curated phrase is guarded on the other field too. An unknown or missing model symbol never fails the batch. The hub
  attaches `{symbol, symbolId}`; labels and says are never changed.
- *Page.* Pictures are planned for the whole page: yes/no, then routes, then
  fixed phrases, then replies claim pictures; a repeat takes the concept's
  `altId`, then the bubble concept, then no picture. Images are
  `<img src="/symbol/<id>">` from the hub only; on error the Drawing emoji
  sticker for the concept (11 keyword matches), then the in-house drawing.
  Without the table the in-house drawings stay as in v1.0.20. `?pictures=bw` and
  `?pictures=emoji` show the other styles on the live page.
- *Layout* (`public/chat/tile-fit.js`, board-render.js constants): beside when
  the label is ≤16 characters and the tile ≥190 px wide, picture 42% of the
  content width (30% only if the word needs it) and 82% of its height, label
  ≥74 px; otherwise stacked (label may take 55%, then 80% of the height, both
  tried at 74 px first), then shrinking at 80% to the 44 px floor marked
  `data-font-reduced="1"`; words that do
  not fit even then keep the tile and the picture is set aside.
- *Pre-warm.* Enabling Chat, and every boot while it is enabled, fetches every
  vocabulary id (and alternate) missing from `data/symbols-cache`, one at a
  time, `ERA_SYMBOL_WARM_MS` apart (250 ms default, about 100 s for a cold
  cache), stopping after 5 failures in a row and retrying every 30 minutes
  while pictures are missing. `GET /symbol/<id>?color=false` serves the
  black-and-white variant (`ERA_SYMBOL_IMAGE_BW_URL`, cached as `<id>-bw.png`).
- *Preview.* `node tools/chat-preview.mjs --pictures` (scratch hub,
  `ERA_TEST_PORT` 8480–8499, default 8493) writes one PNG per board — 12 boards
  of the 46 fixed phrases and 8 of 30 sample replies — at 1280x800 and the
  device's 1920x1080, with colour, black and white, emoji and "stacked-big"
  side by side, to `~/.cache/era-chat/pictures-preview/<size>/`. Stacked-big
  (`fitTile(tile, { profile: 'stacked-big' })`, preview only, not the
  default): a stacked label takes at most 70% of the height, so the picture
  keeps 30%, stepping down through 60 px to the 44 px floor. The maintainer
  picks.

## 7. Local and school

- No recognition model ships today; only the activity model, on a single
  thread of the portable WASM runtime. A native runtime was rejected for the
  missing Visual C++ runtime on clean Windows.
- The best open streaming model measured about twice the errors of the top
  services and worse in noise. A local path is a fallback for school (outside
  hosts unproven under the school DNS filter, device asleep on battery), not
  the main path. Phase 4 measures it on the QA VM before any device.
- Cloud-first at home. A read-only reachability probe of the candidate service
  hosts runs in a school awake window on dad's approval before Chat is ever
  enabled there.

## 8. Laws that do not move

Immutable sealed batch; nothing speaks unless selected; capture stops during
playback and on hide/leave/end; a cancelled or timed-out hold never submits;
partner controls touch-only; no invented personal facts; refusal, repair,
yes/no and stories available when the network fails; credentials only in the
hub; production rows content-free; no vendor or model names in code or docs
(ids in private settings only); agents write the code and tests, test first.

## 9. Phase 0 evidence (10/27, host-paced)

Tools: `tools/chat-bakeoff.py` (transcription, five wire protocols, real-time
100 ms pacing, finalize at release) and `tools/chat-reply-bakeoff.mjs`
(streamed structured choices); private settings, prices and reports under
`~/.cache/era-chat/bakeoff/`. Three clip sets: 18 earlier clips (six public
child recordings, synthetic sentences, either/or clean and at 10 dB noise),
60 new synthetic clips with lexicon names, and 26 real clips recorded by dad
(name questions, negations, either/or, remarks; references are drafts until
he corrects them).

**Transcription, dad's 26 clips, keyterms on** (release → final p50):

| Setting | WER | meaning | names | release → final |
| --- | --- | --- | --- | --- |
| turn-streaming service, pro tier | 0.000 | 11/11 | 12/12 | ~430 ms (words settled ~120 ms) |
| listen-streaming service, v1 | 0.037 | 11/11 | 12/12 | ~120 ms |
| listen-streaming service, turn-model variant | 0.019 | 11/11 | 12/12 | ~140 ms |
| realtime-events stream (the unshipped prototype) | 0.013 | 11/11 | 12/12 | ~560 ms |
| published one-shot upload | 0.006 | 11/11 | 11/12 | ~620 ms |

On the 78-clip main set the pro turn-streaming service kept the lowest error
rate of the streaming settings (WER 0.084, meaning 37/39) while the fast
listen service rose to 0.143 and its turn-model variant to 0.311. Keyterms
lifted names from 7–8/10 to 10/10 on every streaming setting. The
token-streaming service could not be scored: its trial account refused with
"balance exhausted" before the first clip. Pro turn-streaming bills by
connection time, so the hub closes idle sockets (§3.1).

**Reply model, 27 questions × 10 runs, warm:** see §3.3. Streaming alone
halves time to first choice (1371 → 785 ms p50) at the same price and
quality; the fast tier takes it to 594 ms.

**Local, one CPU core, native:** the best open 0.6B models match the cloud
on synthetic speech but make about twice its errors on child speech and
project to 3.7–5.5 s on the device under the shipped WASM runtime (measured
2.4–6× slower than native). Only a 110M model decoded on release is
plausible (about 1 s projected) and it fails 2 of 7 meaning checks,
including the noisy either/or. Local stays the phase 4 school fallback.

**Picks:** the pro turn-streaming service as primary transcription, the
listen-streaming v1 service as the fallback setting, the published reply
model streamed on the fast tier. Release-to-first-choice at 0.8 s still
needs the speculative start on partials; the transcript alone now lands in
0.1–0.4 s.
