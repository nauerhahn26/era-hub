# Real-time chat — plan (2026-10-27)

Status: dad said "Go" 10/27 on the recommended decisions; phase 0 DONE 10/27
(spec §9); phase 1 building.
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

- [ ] Spec amendment landed: test mode is a separate route and schema; the
      production allowlists and their tests stay byte for byte.
- [ ] Partner settings switch + banner; off by default; absent from payload
      defaults (`tests/start-hub-bat` style pin that no payload file enables it).
- [ ] Hub `chat-turns` writer: one line per turn to `data/logs/chat-turns/`
      and the pool; bounded PCM retention while on; delete control.
- [ ] Client timeline marks for every stage in the spec §5, including each
      partial, each staged choice, batch sealed.
- [ ] Usage capture: reply-model token usage, audio seconds, socket seconds,
      saved-voice characters and cache hit; private price table → cost per turn.
- [ ] Device health sampler (CPU, memory, event-loop lag, gaze state, mic
      level, service round trip) at release and reveal.
- [ ] Diagnostics panel: live turn timeline, last ten, summaries per build.
- [ ] `tools/chat-turns.mjs` host report over the synced pool; `tools/chat-replay.mjs`
      re-runs a recorded turn through any configured transcription setting.
- [ ] Tests: schema, bounded files, off-by-default, no content in production
      rows while test mode is off, pool line shape, report tool on fixtures.
- [ ] Gate green, unsigned patch, dad's word, home device, dad tests one evening
      and we read the numbers.

## Phase 2 — streaming pipeline

- [ ] Hub WebSocket upgrade on the session audio route; binary PCM frames with
      generation; page switches from per-frame POST to the socket; the POST
      path stays for the one-shot fallback.
- [ ] Streaming transcription client in the hub (Node 22 WebSocket), warm
      socket per session with bounded idle close/reopen; keyterm list from
      private settings; partials → SSE; finalize on release; cancel paths.
- [ ] Private settings `ERA_CHAT_STREAM_*` read the way the speech settings
      are; delivered to devices by the same receipt flow.
- [ ] Speculative choices on stable partials; keep/discard rule; never shown.
- [ ] Streamed structured choices parsed as they complete; page stages one by
      one; batch sealed at reveal; fast reply setting from phase 0.
- [ ] Keep-alive agents for reply and saved-voice services; saved-voice
      streaming endpoint; prefetch all staged choices; voice list on a timer.
- [ ] Reveal gate per dad's decision (§Decisions 2).
- [ ] Tests: socket ordering and generation checks, mid-turn socket failure
      falls back without a lost turn, speculative batch never reaches the page,
      partial never mutates a tile, sealed batch immutable, playback and
      capture exclusion unchanged, 15 s hold, cancel/hide/leave, keyterms
      never logged outside test mode, no credential in the page.
- [ ] Browser test with local fixture services exercising a streamed turn
      end to end (partials, speculation, streamed choices, saved voice).
- [ ] Gate green, VM leg B on the payload, unsigned patch, dad's word, home
      device; phase-1 numbers compared to the §2 targets.

## Phase 3 — pictures

- [ ] Vocabulary table (words → approved pictogram ids) seeded from her board
      labels, the fixed phrases and the library's core set; review tool prints
      a contact sheet.
- [ ] Preview page on a scratch hub: colour vs black-and-white vs emoji
      backup, at board size; dad picks the style.
- [ ] `symbol` enum in the choice schema; server maps word → id; negation
      check server-side; emoji backup; bubble last.
- [ ] Tile layout per board law (picture beside word, 42%/82%, 74 px label
      floor, stacked fallback marked); Chat page CSS; `symbols.js` licence
      header fixed.
- [ ] Pre-warm the vocabulary's images on enable; offline test.
- [ ] Credit on the About page; dad's non-commercial ruling recorded.
- [ ] Tests: schema rejects unknown symbols, every vocabulary id resolves,
      no two tiles share a symbol, negation never gets an affirmative picture,
      layout geometry, offline render from cache.
- [ ] Gate, patch, dad's word, home device.

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
2. **Reveal gate.** Resting in the black centre counts; 250 ms settle.
3. **Test mode content.** Transcripts, choices and the turn's audio kept on
   the device while on; text lines sync to Drive; banner; off by default.
4. **Pictogram library.** The AAC library the hub already uses, fetched at
   runtime, credit on About. Dad's explicit non-commercial ruling still to be
   recorded in words.
5. **Phase order.** Telemetry first, then speed and pictures in parallel.

Open for dad: correct the 26 draft references; fund or drop the
token-streaming trial; a teacher's and a child's voice clips when possible.

## Retrospective

(to be written)
