# Chat: the stable frame (design, 2026-10-28)

Approved by the maintainer on 10/28 night ("I like this UX much better, go for
it"). Replaces the reply screen of spec 2026-10-27 §4 (rest cells, four
reply-sized helpers). The plan is in `docs/plans/2026-10-27-real-time-chat-plan.md`,
section "A stable frame".

## 1. The frame

The grid is one CSS grid under the door bar: columns `3fr repeat(12, 1fr)`,
rows `0.5fr 1fr 1fr 0.62fr`, gap 10 px, inset 12 px (sides 28 px as today).
Nine tiles never move:

| Tile | Area (row/col) | Kind | Dwell |
|---|---|---|---|
| YES | 1 / 1 | yes | speaks "Yes." |
| the question strip | 1 / 2–10 | question | speaks the partner's question again |
| NO | 1 / 11–13 | no | speaks "No." |
| My questions | 2 / 1 | page | opens the page |
| My comments | 3 / 1 | page | opens the page |
| About me | 4 / 1 | page | opens the page |
| Tell me more | 4 / 2–4 | static | speaks "Tell me more." |
| Ask a question | 4 / 5–7 | mode | the middle shows four questions she could ask back |
| Make a comment | 4 / 8–10 | mode | the middle shows four comments |
| Something else | 4 / 11–13 | static | speaks "Something else." and asks for four different replies |

The middle (rows 2–3, columns 2–13) holds the replies: four as a two-by-two
(each 6 columns, one row), three across (4 columns each, both rows), two
across (6 columns each, both rows). One reply takes the whole middle. Before
any question the middle shows the four openers ("Hi!", "What's up?", "How are
you?", "Come sit with me.") as static tiles. While a question is captured or
prepared the middle shows the waiting tiles as today.

The question strip is a dwell target with no picture: grey text, the partner's
question (or the live partial while it is captured). Empty, it reads "Ask me
something" and is not a dwell target. A dwell speaks the question in the
device voice. The page's dwell rules do not change (1.2 s, 250 ms settle on
reveal).

Door bar: the lock button sits to the left of the partner controls; the order
at the right end is lock, partner settings (•••), Hold to ask, so Hold to ask
is in the top right corner.

## 2. Pages

A page takes the middle and the bottom row (rows 2–4, columns 2–13) as a
four-by-three grid of 3-column cells: ten items, then More (when more than
ten remain) and Back. YES, NO, the strip and the rail stay. The open page's
rail tile is lit (`.on`). An item speaks and the page stays open. Back, the
lit tile, or a new question from the partner (a hold) returns to the replies.

Content:
- My questions: the device's `chatQuestions` list.
- My comments: the device's `chatComments` list.
- About me: the stories saved in the partner dialog (label speaks its
  message) first, then the device's `chatAbout` list, then the world's lines
  (`about` sentences and `week` lines from `GET /chat/api/world`).

Lists live in app-settings.json beside `chatLikes`, edited in the partner
dialog one item per line (`chatQuestions`, `chatComments`, `chatAbout`; up to
20 items of 40 characters; defaults in chat-turns.js). Family-specific lines
are entered on the device, never shipped as defaults.

## 3. Modes

Ask a question and Make a comment are made for the moment. Once a batch of
replies is revealed, the page asks the hub for both sets in the background
(`POST /chat/api/choices` with `mode`), after the reveal so the reply itself
is never slowed, and keeps them for that turn. A dwell on a mode tile swaps
the middle to its four tiles at once (or to waiting tiles until the set
lands), lights the tile, and a dwell on the lit tile returns the replies.
A new hold drops both sets.

Request: `{ text, context, mode: 'ask' | 'comment' }`. The hub sends the
model the question, the conversation so far (the page's `Partner:` / `Me:`
ledger), her likes, her world (always, for a mode) and the mode. Mode ask:
four questions the communicator could ask the partner back about what was
just said and the conversation so far, concrete and different, none a repair.
Mode comment: four remarks about it in a seven-year-old's words, drawing on
likes and world, a spread of views, never an invented fact; the recall check
applies. Without a reply model the hub answers a fixed set per mode.

The conversation ledger is the seam for more context later (an always-on
listener would add to it); its shape does not change here. Mode tiles are
dwell targets only while replies are on screen.

Something else: speaks, then asks for a fresh batch for the same question
with `avoid` (the says already shown); the model is told to offer different
replies. The middle shows the new batch when it lands.

## 4. Telemetry

A turn record (test mode) gains, in `content`: `mode` ('ask' | 'comment')
when she swapped the middle, `page` ('questions' | 'comments' | 'about') when
she opened a page in that turn, and `again: true` when Something else was
used. `selected` and `spoken` are unchanged. Nothing new is written in
production mode.

## 5. Tests

- `tests/chat-frame.test.mjs`: the pure layout module (`public/chat/frame.js`):
  areas by reply count, page cells and paging, the fixed tiles.
- Browser (`tests/chat-browser.test.mjs`, `tests-vm/lib/chat-ui-smoke.mjs`):
  the frame's tiles, no rest cells, a page round trip (About me shows the
  saved stories), the strip speaks the question, a mode swap and back.
- Hub: settings lists (chat-turns, server /settings), world `about` and
  `week`, choices `mode` and `avoid` (chat-choices-adapter, chat-api), the
  fixed sets without a model, turn record fields (chat-turns validateTurn,
  chat-turnlog).

## 6. Reading the options aloud (dad, 10/28 night)

When a batch is revealed and she has not answered after a silence, the device
reads the options: "<name>, your options are" in the saved voice (the one
used for everything), then each reply label in spoken order at a natural
cadence, the tile lit while its clip plays. The name is the device's
`chatName` setting (default the one first name used in this software), so it
works for anyone. The delay is the device's `chatPromptMs` setting, chosen in
the partner dialog (off, 10, 12, 15 or 20 s; default 12 s).

The timer starts at the reveal. It is cancelled by any dwell progress on a
tile, a selection, a page or mode swap, a new hold, or the partner dialog
opening. The reading never blocks her: a dwell during it selects as usual and
stops the reading. YES and NO are not read. A batch is read at most once.
The turn record (test mode) gains `content.prompted: true` when a reading
started and keeps `selected` as usual, so prompted turns can be compared.

## 7. Her gaze never ends a hold

While the partner holds Hold to ask (from touch-down until the final
transcript or the hold's end), no tile on the grid is a dwell target: a look
at YES, a page or an old reply during the question cannot speak and cannot
cancel the capture. The targets return when the hold ends. Today a selection
during a hold cancels it (speak() ends the capture), which is what the
partner saw as "I had to redo the question".

## 8. Wake word: "Listen for <name>" (dad, 10/29)

A partner-touch switch at the top of Chat, in the partner strip left of the
lock: "Listen for Ellie" (the name is `chatName`), off by default, saved per
device as `chatWakeMode` in app-settings and restored on load. While it is on
the page keeps the microphone open and streams every frame to the hub over
the audio socket as an "ear": one listening window (chat-window.js) that
never closes on silence or cap, in which an utterance is sealed only when it
contains the wake name (the name's words, case-insensitive, with "elly" and
"ellie's" counted); the question is the utterance's words after the name, and
when the name stood alone ("Ellie?") the next utterance within 8 s is the
question. A sealed utterance goes through the same staged choices as a button
window (`utterance-sealed`, `choice-staged`, `batch-sealed`, with
`windowId`), and the page reveals the batch as today. The ear keeps listening
after each question; a new wake cancels a reply still being prepared, like a
new hold.

The partner's hold still works with the ear on: a hold pauses the ear (its
frames become the hold's) and the ear resumes after the final. Her own clips:
while a clip plays, and for 400 ms after, the page sends no frames, so the
service never hears her; tiles stay live in ear mode (no hold, no lock). The
status reads "Listening for Ellie" with the dot lit; a banner says that room
audio is sent for transcription while the switch is on. The switch is
disabled, with a note, when no streaming runtime is configured
(`/chat/api/config` capabilities.wake). Turning it off closes the window and
the microphone returns to hold-only. Test mode records a wake turn with
`mode: 'wake'` and the question's audio from the wake name on, never the
room before it. Nothing of the room before a wake is kept or sent beyond the
transcription service's live stream.
