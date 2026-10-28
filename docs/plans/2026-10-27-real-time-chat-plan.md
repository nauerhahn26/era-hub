# Real-time chat — plan (2026-10-27)

Status: dad said "Go" 10/27 on the recommended decisions; phase 0 DONE 10/27
(spec §9); phase 1 built 10/27 (spec §5.1), awaiting review and the gate.
Design: [real-time chat](../specs/2026-10-27-real-time-chat-design.md).
Worktree `era-hub--wt-real-time-chat`, branch `feat/real-time-chat`, from
master `dca6ba5` (which already contains Chat v1.0.20). Builders: agents, test
first; the overseer scopes, reviews and decides. The gate runs detached with a
sentinel and one `gate-wait.sh` call. Publishing waits for dad's word each time.

Order: 0 evidence → 1 telemetry → 2 streaming → 3 pictures → 4 school/local.
Telemetry comes before speed because dad tests with it and phase 2 is
measured by it. Phases 2 and 3 can be built by different agents in parallel
once phase 1 has landed.

## Phase 0 — evidence (1 day, no product code)

- [ ] Copy `chat-state.json` off the home device (ssh timed out twice 10/27;
      moot once phase 1 ships).
- [x] Clips: dad recorded 26 (one adult voice; references drafted by the
      published transcription, awaiting his corrections); 60 synthetic clips
      with lexicon names added. Teacher and child voices still missing.
- [x] Transcription bake-off: five protocols, three trial accounts (one
      refused for balance), keyterms on and off. Spec §9.
- [x] Reply-model bake-off: 7 settings × 27 questions × 10 runs plus a
      fast-tier run. Spec §3.3 and §9. The "333 ms smaller setting" was void.
- [x] Local models measured on one host core, native and under the shipped
      WASM runtime (QA VM run deferred to phase 4). Spec §9.
- [x] Numbers written in; services picked (spec §9).

## Phase 1 — telemetry test mode

- [x] Spec amendment landed: test mode is a separate route and schema; the
      production allowlists and their tests stay byte for byte.
- [x] Partner settings switch + banner; off by default; absent from payload
      defaults (`tests/start-hub-bat` style pin that no payload file enables it).
- [x] Hub `chat-turns` writer: one line per turn to `data/logs/chat-turns/`
      and the pool; bounded PCM retention while on; delete control.
      Socket seconds and keyterms are null until phase 2 has a socket.
- [x] Client timeline marks for every stage in the spec §5, including each
      partial, each staged choice, batch sealed.
- [x] Usage capture: reply-model token usage, audio seconds, socket seconds,
      saved-voice characters and cache hit; private price table → cost per turn.
- [x] Device health sampler (CPU, memory, event-loop lag, gaze state, mic
      level, service round trip) at release and reveal.
- [x] Diagnostics panel: live turn timeline, last ten, summaries per build.
- [x] `tools/chat-turns.mjs` host report over the synced pool; `tools/chat-replay.mjs`
      re-runs a recorded turn through any configured transcription setting.
- [x] Tests: schema, bounded files, off-by-default, no content in production
      rows while test mode is off, pool line shape, report tool on fixtures.
- [x] Gate green (190/0), patch v1.0.25, dad's word, home device nudged; dad
      tests one evening and we read the numbers (open).

## Phase 2 — streaming pipeline

Built 10/27 on `feat/real-time-chat` (spec §3.5 "Decided shapes").

- [x] Hub WebSocket upgrade on the session audio route; binary PCM frames with
      generation; page switches from per-frame POST to the socket; the POST
      path stays for the one-shot fallback (`chat-ws.js`, `chat-api.js`).
- [x] Streaming transcription client in the hub (Node 22 WebSocket), warm
      socket per session with bounded idle close/reopen; keyterm list from
      private settings; partials → SSE; finalize on release; cancel paths
      (`chat-stream.js`, two wire shapes ported from the bake-off).
- [x] Private settings `ERA_CHAT_STREAM_*` read the way the speech settings
      are; delivered to devices by the same operator-managed `ai.env` (the
      keyterm file travels beside it).
- [x] Speculative choices on stable partials; keep/discard rule; never shown.
- [x] Streamed structured choices parsed as they complete; page stages one by
      one; batch sealed at reveal; fast reply setting from phase 0.
- [x] Keep-alive agents for reply and saved-voice services; saved-voice
      streaming endpoint; prefetch all staged choices; voice list on a timer.
- [x] Reveal gate per dad's decision (§Decisions 2).
- [x] Tests: socket ordering and generation checks, mid-turn socket failure
      falls back without a lost turn, speculative batch never reaches the page,
      partial never mutates a tile, sealed batch immutable, playback and
      capture exclusion unchanged, 15 s hold, cancel/hide/leave, keyterms
      never logged outside test mode, no credential in the page.
- [x] Browser test with local fixture services exercising a streamed turn
      end to end (partials, speculation, streamed choices, saved voice)
      (`tests/chat-stream-browser.test.mjs`).
- [x] Host real runs with the private settings (spec §3.5 numbers).
- [x] Gate green, VM leg B 12/12, patch v1.0.25, dad's word, home device nudged;
      device numbers against §2 targets still to read (open).

## Phase 3 — pictures

Built 10/27 in `era-hub--wt-real-time-chat-pictures` (spec §6 "Decided shapes").

- [x] Vocabulary table (words → approved pictogram ids) seeded from her board
      labels, the fixed phrases and the library's core set; review tool prints
      a contact sheet (`tools/chat-vocabulary-sheet.mjs`; 389 concepts, 0 misses).
- [x] Preview page on a scratch hub: colour vs black-and-white vs emoji
      backup, at board size (`tools/chat-preview.mjs --pictures`).
- [ ] Dad picks the style from the preview PNGs.
- [x] `symbol` enum in the choice schema; server maps word → id; negation
      check server-side; emoji backup; bubble last.
- [x] Tile layout per board law (picture beside word, 42%/82%, 74 px label
      floor, stacked fallback marked); Chat page CSS; `symbols.js` licence
      header fixed.
- [x] Pre-warm the vocabulary's images on enable; offline test.
- [x] Credit on the About page (settings "About the pictures"); dad's
      non-commercial ruling recorded in spec §6 (his own words still to quote).
- [x] Tests: schema rejects unknown symbols, every vocabulary id resolves,
      no two tiles share a symbol, negation never gets an affirmative picture,
      layout geometry, offline render from cache.
- [x] Gate, patch v1.0.25, dad's word, home device nudged.

## Phase 4 — school and local (after dad's go)

- [ ] Read-only reachability probe of the chosen service hosts in a school
      awake window via the school job rail; record which are reachable.
- [ ] Local streaming model in the hub worker behind `ERA_CHAT_LOCAL_*`
      settings if the QA VM numbers justify it; template choices when the
      reply service is unreachable.
- [ ] Battery policy: Chat never keeps the device awake at school.

## Decisions (dad: "Go", 10/27, on the recommendations)

1. **Services.** Pay for the best: the pro turn-streaming transcription
   service with keyterms, the listen-streaming service as fallback, the
   published reply model streamed on the fast tier. Trial accounts created
   10/27 (keys in the private bake-off env file); production keys and the
   fast tier are dad's to fund.
2. **Reveal gate.** Dad 10/27 evening: "show replies, don't get cute with the gate" — the batch shows the moment it is sealed, 250 ms settle only (v1.0.26); the "resting counts" variant lived only in v1.0.25.
3. **Test mode content.** Transcripts, choices and the turn's audio kept on
   the device while on; text lines sync to Drive; banner; off by default.
4. **Pictogram library.** The AAC library the hub already uses, fetched at
   runtime, credit on About. Dad's explicit non-commercial ruling still to be
   recorded in words.
5. **Phase order.** Telemetry first, then speed and pictures in parallel.

Open for dad: correct the 26 draft references; fund or drop the
token-streaming trial; a teacher's and a child's voice clips when possible.

## Same-night patches from dad's live test (10/27 evening → 10/28)

Dad tested v1.0.25 on the home device with test mode on: "looks much better.
Responsiveness is very good." Device numbers: release → final about 1.1–1.2 s
(the primary service's turn-close), choices shown within 5 ms of the final
(speculation kept on every turn). Each patch below gated 190+/0, was pushed to
the home device, then landed and published:

- v1.0.26 — replies show the moment the batch is sealed ("show replies, don't
  get cute with the gate").
- v1.0.27 — lists of three or four alternatives; dish pictures by category;
  a model symbol from the wrong family is rejected (a "beef mushrooms" tile
  had worn a weekday).
- v1.0.28 — a repeated question stem ("…, or do you want to stay inside?")
  never becomes a tile.
- v1.0.29 — a slipped or too-short hold returns to Ready to ask instead of
  ending the session (every slip had demanded Start Chat again); her tiles
  never say the partner's "my".
- v1.0.30 — no Start Chat: the page prepares itself, a hold starts a session
  ("one more unnecessary step").
- v1.0.31 — the library's full word index ships with the page so any known
  word gets its picture ("lasagna"); pictures named in partials are warmed in
  the background.

Fast path used for each: sibling worktree → commit → gate → `build-dist.sh
--patch` → `push-device.sh i13` → merge → land → `release.sh --patch`.
Dad's recordings and the device's hold audio live in the family repo's
private `test-data/chat-voices/` on the operator host.

## Retrospective (10/27, same day)

- Five read-only recon agents, then four builders in parallel, then three
  phase builders in sequence with one independent reviewer each; one calendar
  day from "way too slow" to a published patch. Agents wrote every line; the
  overseer scoped, reviewed, squashed, gated, landed and released.
- The sibling worktree for pictures kept two builders off one tree; the merge
  caught a real bug (the model's picture pick never reached the page) that
  both suites had passed around.
- The full gate caught what focused suites could not: a require of the
  vocabulary file killed every installed hub at boot. Installed-copy suites
  build from the payload module list, so a new hub module must never require
  a `public/` file at load time.
- A gate on a tree that an agent is still editing reports `inputs-changed`
  and may fail on half-written code; gate only a committed tree.
- The "333 ms smaller reply setting" in the earlier plan timed failed
  requests. Benchmarks must refuse rows whose status is not success.
- Trial accounts: one signup passed its bot check only in a headed browser on
  a virtual screen; two needed dad's hand; one trial refused for balance.
- Open: device-side numbers under test mode, the stacked-big picture layout
  choice, dad's transcript corrections, a teacher's and a child's voice,
  school reachability (phase 4), and the deferred review nits (page buffers
  the whole voice clip on a miss; socket edge cases; retry on the reply
  service's concurrency limit).
