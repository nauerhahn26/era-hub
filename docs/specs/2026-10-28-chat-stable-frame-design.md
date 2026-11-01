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

The timer starts at the reveal. It is cancelled by a selection, a page or
mode swap, a new hold, Clear or Back, or the partner dialog opening. A glance
does NOT stop it (dad, 10/31 night: "it stops reading just at the first
glance, which is not a good user experience. It should keep giving her the
options until she makes a selection"): dwell progress on a tile neither
cancels the timer nor the reading; until 10/31 it did. The reading never
blocks her: a dwell during it selects as usual, and the selection stops the
reading. YES and NO are not read. After a full reading the timer re-arms
with the same delay, so an unanswered batch is read again, up to three
readings per batch (then quiet; the partner can repeat the question). The
turn record (test mode) gains `content.prompted: true` when a reading started
(and `content.readings: n`) and keeps `selected` as usual, so prompted turns
can be compared.

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

## 9. Her eyes never touch the voice (dad, 10/29, after testing the wake word)

"Whether you're holding the button, using the clicking button or the square,
or saying Ellie to activate, her eyes don't interfere with how the voice is
processing. The voice continues processing even with her eyes activating
buttons or interrupting things."

- During a hold: no tile is a dwell target (§7); nothing she does reaches
  the capture.
- With the ear open or a button window open: a selection plays its clip and
  nothing else. It does not stop the microphone, does not change the capture
  mode, sends the hub no cancel and no pick. A button window ends only on its
  own clock or the second press; her pick no longer ends it (this replaces
  design 2026-10-27 §4.4 "a pick wins").
- Her own clip is kept out of the stream by echo cancellation on the
  microphone track and, since 10/31 night, by the hub removing the clip's
  words from any transcript that arrives while it plays (§13). Until then the
  page sent silence in place of the frames while the clip played, which
  muted the partner too (a question was lost that way twice on 10/31).
- Considered and not needed: a grace period after the hold's release. The
  hold already locks her targets, and the streaming service starts the reply
  before release.

## 10. The ear's cost: auto-off, quiet notices, two tiers (dad, 10/31)

- Auto-off: the ear closes after 30 minutes without a wake (`chatWakeIdleMs`,
  default 1,800,000). No countdown. The status line at the top says, gently,
  "Listening turns off in 2 minutes", then "… in 1 minute", then "Listening
  is off. Touch Listen for <name> to turn it on"; the switch reads off. The
  partner's 30 minutes restart with every wake, hold or press.
- No recording notices. The test-mode banner and the "room audio is sent for
  transcription" banner are gone from the Chat page; the lit dot and
  "Listening for <name>" are the signal. Test mode itself stays a quiet switch
  in the partner dialog (its records are how the maintainer reads a session).
- Two tiers. The ear may listen on a cheaper stream profile
  (`ERA_CHAT_STREAM_EAR_MODEL` in the private settings; unset, the ear uses
  the main stream). The hub keeps a rolling buffer of the last 10 s of the
  ear's audio. On a wake it opens the main (engagement) stream, replays the
  buffer from just before the wake name, then forwards live frames; the
  engagement stream handles everything, further wakes included, until two
  minutes pass without a wake (`chatEngageMs`), when the ear tier resumes
  alone. A button press or a hold always goes to the main stream, as today.
  Later: an on-device wake detector in the ear slot (nothing leaves the
  device until the name is heard).

## 11. Yes and No: her boards' pictures, and the answer in full (dad, 10/31 evening)

- Pictures. Yes and No show the pictures her TD Snap boards use: the green
  check mark (library id 5584) and the red cross (5526). They stand on the
  corner tiles and on any Yes or No reply in the middle. The nodding and
  shaking heads (5583, 5525) are not used for yes and no (dad, 10/31 night:
  "it should be the check mark and the X"; the heads were a wrong guess earlier
  that evening). Only the ids in `public/chat/vocabulary.json` say which.
- The answer in full. For a yes-or-no question the local set still shows at
  once (Yes, No, I'm not sure, Please say that again): nothing waits for a
  model. In parallel the hub asks the reply model for the two answers in her
  words, first person, six words at most ("Yes, I'm angry", "No, I'm not
  angry"), plus at most one feeling or action word that the question is about,
  from the vocabulary table (angry, happy, sad, tired, hungry, …) or none.
  When it arrives (`yes-no-answered` on the session's events, generation and
  window as for choices) the Yes and No replies in the middle take the full
  phrase as label and words; their picture becomes the feeling's picture with
  the check mark or the cross as a small badge in a corner ("merge it when it
  can be"); without a feeling word the check mark or cross stays. The corner tiles keep their
  look and their short labels and SPEAK the full phrase while this question is
  open. Nothing changes under a reply she has already chosen (the selection
  wins), and Clear, Back and a new question put the plain Yes and No back.
  The reading aloud says the full phrases once they are on screen. Turn
  record: `content.answered: true` when the full phrasing was on screen
  before she chose; `answered` in `validateTurn`.
- Partner's dialog: nothing new; the ids live in the table.

## 12. What the ear heard (10/31 evening, after a question was lost)

A question the partner asked in Listen mode went unanswered and no record
could say why: the day's turn records hold only sealed questions. While test
mode is on the hub appends ear records to the day's chat-turns log (`kind:
'ear'`, one per event, private device data like every record): each ear
turn's text and tier (cheap or main), tier changes and engagements with the
replayed milliseconds, every seal with what the wake rule found, pause and
resume with their reasons, off with its reason, socket losses, and her clips
(each clip's start and end with its words, from this page or another) posted
by the page as `control {type:'clip', on, text, at}`, plus `echo` records for
what the hub removed (§13). The partner dialog's diagnostics
box shows the last twelve ear lines. Nothing is sent anywhere but the hub.

## 13. Her clip is handled, never silenced (dad, 10/31 night)

A second question was lost on 10/31 (3:53 pm PT, Listen mode): the ear records
(§12) show the main tier live and hearing the room, and seven of her clips in
one minute, each muting the microphone for its length plus the tail, about
2 s. The partner's two-second question fell inside those mutes. Dad: "you
cannot silence the mic when she talks. You have to handle it."

- The microphone is never silenced. §9's "silence in place of the frames
  while the clip plays" is withdrawn: the page sends the real frames during
  her clips, the reading aloud (§6), press tones and the device voice, to the
  ear and to a button window alike. Echo cancellation on the track stays.
- The page tells the hub what is being spoken. When a clip starts the page
  posts `control {type:'clip', on:true, text, at, source}` with the words the
  clip speaks (her words, or the reading's whole text); when it ends,
  `{type:'clip', on:false, at, source}`. `source` is `page` or `other` (another
  Chat page on the device, whose broadcast now carries its text). This replaces
  the `gate` control and the `gate` ear record; the ear record is `clip`.
- The hub handles the echo. It keeps the clips of the last few seconds (text,
  start, end or still playing). A transcript turn that arrives while a clip
  plays or within 3 s after it ends is compared with that clip's words: any run
  of two or more of the clip's words, in the clip's order, is removed from the
  turn; a one-word clip (Yes. No.) removes only a turn that is just that word.
  A turn with no words left is dropped: no seal, no wake, no question. A turn
  with words left goes on with those words only: the partner's words during
  her clip survive, and the wake rule (§8) runs on them. This applies to every
  tier (ear and main), to a button window and to a held question, at the
  seal, and to the partials the page shows and speculates on.
- Ear records (§12) gain `clip` (on/off, source, the text) and `echo` (what
  arrived, which clip matched, what was kept or `dropped`; turn-ends and
  finals only, never partials). The diagnostics box shows this page's own
  clip starts; `echo` lines live only in the hub's log (the hub sends the
  page no ear records). Built 11/1: a one-word turn also goes when that word
  is in any clip in play (her "Yes." heard back; her name split off the
  reading), a clip whose end never arrives counts as ended after 30 s, and
  the words that survive keep their casing and punctuation.
- Not done: a client-side energy detector for "voice while muted" (no mute
  remains), and a detector that knows her voice from the partner's.

## 14. A failed reply never ends the session (11/1 morning)

Seven wake questions failed with "Replies are unavailable" between 10/31
5 pm and 11/1 8 am PT. The cause was outside the software: the reply
service's account had no credit left (every request refused). But each
failure also ended the Chat session on the page (`onChoicesError` →
`shutdown`), which closed the audio socket, which turned the ear off; the
page reopened it a second later or not at all. The partner's next question,
about pain, was never heard.

- A failed reply job fails the TURN only: the strip says "Replies are
  unavailable. Your phrases still work." and the question stays on screen;
  the session, the audio socket, the ear and a button window are untouched;
  the ear goes on listening (resumed as after any seal). Her pages and the
  local Yes/No set work as before.
- The turn record keeps the hub's reason: `reason: 'choices'` as today plus
  `content.choicesError` = the hub's code (`generation-unavailable`,
  `generation-invalid`, `generation-refused`, `generation-busy`, …); the hub's
  `choices-error` event already carries it. The hub also writes an ear record
  `fault {code}` while the ear is on, and one line to its log
  (`[chat] replies failed: <code> <http status if any>`), never the service's
  message text and never a secret.
- Ear records (§12) gain `on` (the ear opened or resumed: tier, resumed) so
  the log shows when the ear was listening at all; until now only its ending
  was written, and a morning with no records could not be read.

## 15. The question re-renders its replies (dad, 11/1 morning)

"If you click the question or she looks at the question, it should re-deliver
or just re-render the responses … she accidentally made a comment or chose
to make a comment, but then wanted to actually answer your question."

- A dwell on the question strip, or a partner's touch or click on it, repeats
  the question aloud (as today, §1) AND puts that question's replies back in
  the middle when they are not showing: the batch last shown for this
  question (Back's memory), or the local Yes/No set for a yes-or-no question;
  a page or a mode she had opened gives way. With the replies already in the
  middle it only repeats the question. Nothing is asked of the model again.
- A question whose replies never arrived (a failed job, §14) is asked of the
  model again by the same look or touch, once per look.
- The read-aloud timer (§6) re-arms when the replies come back.
- Built 11/1: a page or a mode never changes the controller's batch, so the
  replies brought back are the ones the controller holds (for a yes-or-no
  question, the local set it was sealed with); the made sets stay made. A
  failed question is asked again by the plain request path (`POST /choices`,
  as a typed question), recorded in test mode as its own turn with
  `content.retried`. With the replies showing a look only repeats the
  question, and that repeat still stops a reading in progress as before.

## 10 (addendum, 11/1 morning): the ear across a sleep

The device slept from 8:20 pm to 7:40 am PT with the ear on (18 minutes into
its 30). Nothing streamed while it slept (no record of any kind, the hub was
frozen with the rest). On waking the ear was listening again by itself and no
`off (idle)` was written although twelve hours had passed; the switch read
on. Expected: the first tick after a sleep longer than the idle allowance
turns the ear off as idle and saves the switch off, like any idle half hour;
the page shows the gentle line. A pinned test jumps the clock twelve hours.

Built 11/1: the tick alone already did this (the pinned test passed before
any change; the hub's clock is wall time). What the device did instead: on
waking, I/O runs before the first timer, and the session the ear lived in
ended (its event stream closed, which disposes it with no record, or the
socket or stream was lost), so the page, its switch still on, opened a new
ear with a fresh half hour. The allowance now belongs to the switch: an ear
opened again without a wake, hold or press inherits the last activity and
closes as idle on its first tick; the partner's off, the idle off and the
partner's own switch-on (`window {ear:true, fresh:true}`) start anew, and a
hold or press with no ear open restarts it. A session that ends with its ear
on writes `off (ended)`.
