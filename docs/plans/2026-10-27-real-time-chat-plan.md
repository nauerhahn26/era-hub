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

## Morning patch from dad's second live test (10/28)

Dad, 10/28 night: "the snappiness is incredible." Three asks: (1) lists of
people and of letters ("Mom, Dad, …" and "A, B, C, D") were handled badly;
(2) pictures are "still often weak when they aren't simple objects";
(3) the layout is not nailed yet — design choices to show her AAC specialist,
nothing built.

Evidence (device turn log, last ten holds): "Is the answer A, B, C, or D?" went
to the reply model twice (once "Need the question / Give me clues / Not sure",
once "A chicken / B fish / C park / D swim" invented from earlier turns); "Do you
want to go outside and play, or …" lost its last word ("Go outside and");
"play with Lisa or Sam" gave both names the bubble picture, so the second tile
had none. Root causes: the local shortcut only knows "do you want … or …"
stems; a verb clause's tail cut fires on a word after "and"; the word index was
built from nouns and names only (verbs, qualities and social words dropped by
design), so an action or a feeling has no library picture unless hand-curated;
names are not things the index knows, while the hub already serves the
family's own people pictures (the Drawing library at `/characters/`).

Build (agents, test first; two sibling worktrees; gate; test push to the home
device; land; release):

- [x] Shortcut rules (`chat-api.js`): a trailing list of 2–4 single letters or
      numbers under any question stem ("Is the answer A, B, C, or D?", "A or
      B?") offers the letters; a "who / which / what … X, Y, Z or W" question
      offers the named list; a verb phrase keeps the words after "and"
      ("Go outside and play"); a label never ends on "and", "or" or "with".
- [x] Letter tiles: a one- or two-character label takes the tile as a large
      glyph (no picture), marked for the layout test.
- [x] Word index of actions, qualities and social words (`tools/chat-lexicon-
      build.mjs`, second map in `lexicon.json`, budget raised); the picture
      pick uses an action for a verb-led label whose object is not a thing.
- [x] Reply model names a picture in plain words (`picture`, 1–2 words) beside
      the enum `symbol`; the hub resolves it against the whole index with the
      family guard, after the label's own thing and before the text guess.
- [x] People: a label that is one of the family's people (the Drawing
      characters library, family source first, generic second) shows that
      person's own picture from `/characters/<slug>.png`; unknown names take
      the friend picture; the page honours a picture source beside library ids
      and never shows two tiles with one picture.
- [x] Contact sheet of real tiles for sixteen questions (device questions plus
      abstract ones) reviewed by the overseer before the push.
- [x] Layout: a shareable page of four layout options drawn to the device's
      scale with a real question, each with the case for and against through
      her gaze, and the questions for the AAC specialist. No product code.

Built 10/28 03:00–06:00 UTC on `feat/real-time-chat` (shortcut rules, glyph
tiles) and `feat/chat-pictures-actions` (index of 6,383 actions beside 18,706
things, the model's plain-words picture, people pictures, park → playground,
the label's own concept beats the model's word); merged, gate 191/0, landed
255d785, released v1.0.32. The layout page: five options (as built; replies
across the top; the cross around the rest; big four with a thin rest band;
replies beside the rest with the question shown), published for dad to share
with her AAC specialist; the decision is theirs, nothing built. Still open:
the model's picture only decides when nothing else does; "Wave" is a sea wave
(things before actions); a name that is also a word shows the thing.

## Open-ended questions (dad, 10/28 evening)

Dad: "build some logic to handle open-ended questions like 'what do you want
to do today' or 'how was your weekend', and give her four options in those
open-ended scenarios: identify the open-ended question, then create options
using the model."

**As built before this.** "How was your weekend?" and every "what did you
do…" question never reached the model: `guardedChoices` answered with three
fixed repairs (clue, another way, not now). Every other open question went to
the model with "2 to 4, normally 3", tilted toward uncertainty and refusal.
So an open question gave her the thinnest board of all.

**Design.**

- The hub classifies a question that has no local answer (not yes/no, not a
  spoken, named or letter list) into an open shape and passes it to the model
  as `shape`: `want` (what do you want / would you like / what should we / what
  are we doing / what do you want to do, eat, play, watch…), `recall` (what
  did you do, where did you go, what happened, tell me about your day), `feel`
  (how are you, how was your…, how do you feel, did you like it), `open`
  (any other who/what/where/when/why/how/which/tell-me question). A statement
  or anything else keeps today's behaviour (no shape).
- An open shape asks the model for exactly four choices, each a real reply
  she could pick, genuinely different, concrete and short, in the register of
  a seven-year-old; at most one of the four is a repair (not sure, tell me
  more, another way) and never two. `want` draws on the family's own list of
  what she likes (below) plus the question's own domain; `feel` offers a
  spread (good, so-so, not good, plus one that says more); `recall` offers how
  it was and a wish to tell, never an event; `open` is the model's call.
- No invented facts stays law. For `recall` the hub checks every reply: a say
  that asserts a past activity ("I went", "we played", "I saw", "I had", "I
  ate", "I made", "I watched"…) throws the batch out and the four fixed
  repairs stand (clue, another way, I don't remember, I don't want to say).
  A confirmed earlier utterance with the same time anchor still goes first
  and the model's list is trimmed to three behind it.
- "What she likes": `chatLikes` in app-settings.json, up to twelve short
  phrases, edited in the partner dialog (a textarea, one per line), with a
  generic default (play outside, draw, read a book, watch a show, play a
  game, music, a snack, see a friend). Family values stay on the device.
- Telemetry: the turn record carries `shape` and whether the recall check
  threw a batch out.

**Tasks.**

- [x] Tests first: shape classifier (hub), the four-choice instruction and
      `shape` + `likes` in the model input, recall check, confirmed-quote
      rule, settings round trip, partner dialog textarea, turn record field.
- [x] Classifier in chat-api.js; model instructions and input in
      chat-choices.js; recall check; chatLikes setting (chat-turns.js style)
      and dialog field; spec §8 note that the history guard is now a check on
      the model's replies, not a bypass of the model.
- [ ] Gate, land, patch release.

- [x] Gate 191/0, landed; released v1.0.33 (the open-ended shapes, four
      choices, likes, people for who-questions, recall check, pictures).

## Her world as context (dad, 10/28 evening, second message)

Dad: "the best would be that you take the context that you already know
about Ellie. 'What was your favorite thing last week at school?' — you have
access to what she learned last week at school: learning about bats, Jackie
Robinson, reading books with my friends. I want the system built so it can
take her global context, narrow the context, and give reasonable suggestions
that are coherent."

**What the device already holds.** Every week package the Drive mirror keeps
(`<DATA>/this-week/<week_of>/manifest.json`: week_of, title, topic by subject
including the hero, talk words by group, the watch list's titles, the play
questions), every book on the shelf (title, weekOf, authored), the people
library, and the likes list. Nothing new has to be published for this.

**Design.**

- `chat-world.js` builds a compact plain-text digest, the *world*, from the
  device's data, newest first, with each week labelled relative to today
  ("this week", "last week", "two weeks ago"): the week's title, its topics
  by subject, its hero, its talk words, its video titles; the last four weeks
  in full, older ones as a title line; the shelf's last eight book titles
  with their week; the people; the likes; today's weekday and date. Capped
  (about 2,500 characters), rebuilt when a source file changes (mtime), never
  more than once a minute.
- An open-ended question (any shape) sends `world` with the question. The
  model is told: world is what the communicator's class is learning and what
  she has, by week; for a question about school, a week, a book, a hero,
  people or what she likes, draw the four choices from the part of world the
  question points at (last week means the week marked last week), stated
  plainly as things she could say ("Learning about shadows", "Wilma Rudolph",
  "The Gruffalo"); world is known, not invented, so it may be stated; beyond
  world the no-invented-facts rule stands.
- The recall check accepts a reply that names something from world (a term of
  four or more letters from the digest); an asserted activity with nothing
  from world still throws the batch out.
- The partner dialog shows "What Chat knows this week" (the digest, read-only)
  under the likes box, so dad can see what the model was given.
- Telemetry: the turn record carries `world: {weeks, chars}`; never the text.
- Tests use fixture week manifests and a fixture shelf with generic content.
- Since the coordinator's follow-up (10/28): the weekly builder also
  publishes `world.json` (schema 1) beside each manifest: `about` her, the
  teachers' weekly lists (`asked`, `worked_on`) and day notes (mood,
  activities, moments, what she said on her device). The digest merges every
  folder's file (about from the newest, weeks by start, days by date), places
  About her, the world weeks and the last ten days' notes after the Today
  line, and caps at 4,000 characters (oldest days go first, then worked_on
  lists, then the package order). The turn record carries `days` beside
  `weeks` and `chars`.
- After the live run with the real 10/26 package (10/28: the trim dropped
  every day line, the most valuable part): per-list caps come first (About
  320 characters of whole sentences; the teacher's list 8 x 110; worked on
  5 x 90; a day's moments 3 x 120 and said 2 x 140; package Words 10 and
  Videos 3; two weeks ago the teacher's list only; older world weeks
  dropped), the cap is 6,000 characters, and the trim takes worked_on
  lists, package videos, the two-weeks-ago list, days older than seven,
  older package weeks, books beyond four, and only then the newest days.
  The teacher's list reads "Last week at school (her teacher's list): …".

**Tasks.**

- [x] Tests first: digest builder (labels, caps, mtime cache, missing data →
      empty world), `world` in the model input for open shapes only, the
      instruction text, recall check with world terms, dialog preview, turn
      record field.
- [x] `chat-world.js`; wiring in server.js and chat-api.js; chat-choices.js
      instruction + input; partner dialog preview; spec §8 sentence.
- [x] Live check against the real model with the 10/26 week package, then
      gate, land, patch release.

Built 10/28 15:00–16:30 UTC. The weekly builder gained `ellie world` (a
`world.json` beside each week's manifest on Drive: the teacher's lists, the
aide's daily notes, what she said on her device, about-her lines; medical,
appointment, lost-item and hard-moment lines dropped) and a daily cron row;
the first file reached the home device's mirror within twenty minutes. The
hub's digest (6,000 characters, per-list caps, day notes kept longest) goes
to the model with every open-ended question. Live sheet of twelve questions:
"What was your favorite thing last week at school?" → Bats / Number 42 / Bat
art; "What did you make with your big buddy?" → Positive pumpkin / Monsters /
Twin projects; "What do you want to be for Halloween?" → Penny / A detective.
Gate 192/0, landed 6dca68d, released v1.0.34. Open: a full name only beats a
library word when the model names a picture; the fixed bottom-row "Tell me
more" keeps the "more" picture; no school updates had arrived for this week
yet, so the first digest is last week's.

## A stable frame (dad, 10/28 night) — design map only, nothing built

Dad set aside the earlier layout rules (black rest cells, YES/NO as full
tiles, every fixed tile reply-sized). What he sees: places that never move,
and a middle that belongs to the conversation.

**The frame** (1920×1080, bar 90, grid rail + 12 middle columns, rows
0.5 / 1 / 1 / 0.62, gap 10):

- Top row: small YES (top left), the partner's question as quiet text
  (never a tile, where her eyes can wait), small NO (top right).
- Left rail, three pages that are hers: My questions, My comments, About me.
- Bottom row: Tell me more (out), Ask a question (mode), Make a comment
  (mode), Something else (out).
- Middle: 2, 3 or 4 replies (2×2 / three across / two tall), spanning 6, 4
  or 6 columns, so every count looks intended. Reply ≈ 1.6× today's tile
  with four, 2.1× with three, 3.2× with two; pages 0.7×, bottom row 0.5×,
  YES/NO 0.4×.

**Static vs dynamic.** Static: YES, NO, the three pages, both outs, both
mode tiles (nine tiles, same place on every turn, every device). Dynamic:
the strip, the replies, and the four questions or four comments the model
makes when she dwells a mode tile.

**Dwell outcomes.** Reply/YES/NO: speak, screen stays until the next hold.
Ask a question: middle swaps to four questions she could ask back about
what was just said (e.g. "What kind of chicken?"); tile stays lit; dwell
again returns the replies. Make a comment: same with four remarks ("I don't
like sushi anymore"). Tell me more: speaks, nothing else changes. Something
else: speaks and four fresh replies (as today). A page: middle + bottom row
become the page (10 items, More, Back); YES/NO stay; Back or a new hold
returns. Before any question the middle is empty but pages, YES and NO work,
so she can open a conversation.

**Content sources.** Replies: today's reply model with likes, people, world.
Ask/Comment: two new reply shapes from the transcript, the replies shown,
her likes and said lines; prefetched once replies land so the swap is
instant; dropped on the next hold; recall check applies to comments. Pages:
three lists in app settings edited in the partner dialog, seeded with
first-grade sets; About me also reads the world digest's About and
This-week lines (marked weekly), later the weekly builder writes an
"about me" set into world.json.

**Alternative considered:** two rails (pages left; NO, Ask, Comment, Tell
me more, Something else right). Replies 1.9× / 3.8× but fixed tiles 0.4–0.5×
and YES/NO 0.23×; "comments" labels hit the floor. Not recommended.

**Software changes implied** (to scope with rae-flow:planning when dad says
go): new chat grid + span rules by count; fit law for small fixed tiles
(60 px floor, picture beside); lit state + Back; strip in the grid; three
lists in settings + partner dialog editor + seeds; world.json about-me set
(ellie-this-week); shapes 'ask' and 'comment' in chat-choices + prefetch;
turn records gain mode/page/item; tests for grid by count, small-tile fit,
lists API, both shapes, page round trip in the UI smoke leg.

**Open questions for dad** (on the page): gap 10 px or none; longer dwell
on page tiles (1.6 s); Tell me more = speak only or also a deeper reply
set; 10 or 8 items per page; modes with no question on screen; the seed
lists in her voice.

Design page: Chat Stable Frame (private artifact, 10/28). Mock generator and
renders in the session scratchpad (`layout/gen-frame.py`,
`layout/frame-*.png`).

## The stable frame: build (dad, 10/28 night, "go for it")

Three more decisions with the go: the question strip speaks the question
again on dwell; the lock button moves left of Hold to ask so Hold to ask is
in the top right corner; Ask a question / Make a comment are context aware
over the whole conversation (the ledger is the seam for an always-on
listener later). Icons stay as they are for now (prototype).

Spec: `docs/specs/2026-10-28-chat-stable-frame-design.md`. Two builders in
this worktree, test first, each committing only its own files.

Page (public/chat, tests/chat-browser, tests-vm smoke):
- [x] F1 `frame.js` pure layout: areas by reply count (4/3/2/1), the nine
      fixed tiles, page cells (10 + More + Back) and paging — `tests/chat-frame.test.mjs`.
- [x] F2 renderGrid on the frame: strip (dwell speaks the question, partial
      while capturing, "Ask me something" when empty), rail, bottom row,
      replies by count, openers before a question, waiting tiles — chat.css.
- [x] F3 Pages: open/lit/Back/More; About me = stories + chatAbout + world
      about/week lines; lists from /settings; partner dialog textareas.
- [x] F4 Modes: prefetch both sets after reveal, swap/lit/back, waiting
      tiles until landed, dropped on a hold; Something else re-asks with avoid.
- [x] F5 Lock left of •••, Hold to ask in the corner.
- [x] F6 Telemetry fields in the turn log (mode, page, again); browser tests
      and the VM smoke helper updated (no rest cells; My news → About me).

Hub (chat-turns, server, chat-world, chat-api, chat-choices, registry):
- [x] H1 Settings lists chatQuestions/chatComments/chatAbout (defaults,
      clean, GET/POST /settings) — chat-turns + server tests.
- [x] H2 World `about` and `week` lines on digest() and GET /chat/api/world — chat-world tests.
- [x] H3 Choices `mode` and `avoid`: inputData, instructions, fixed sets
      without a model, recall check on comments, produceChoices/generate
      pass-through, world always with a mode — chat-choices-adapter + chat-api tests.
- [x] H4 validateTurn accepts content.mode/page/again — chat-turns tests.
- [x] H5 Registry entries (new suite, new source file) and build-payload
      (public/chat is copied whole; confirm frame.js rides).

Then: gate detached, VM legs, land, release (patch), push both i13s + tablet.
