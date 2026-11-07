# Chat: About me in her own words, and the rail, mode and AI-made icons (design, 2026-11-07)

Approved by the maintainer on 11/7 ("All of that is good. I like the
sparkles. Instead of I love to sing, say I love to walk and explore." and
"and then build and publish"). Amends the stable frame spec
(`2026-10-28-chat-stable-frame-design.md` §2 Pages, and the picture rules of
`2026-10-27-real-time-chat-design.md` §6). The plan is in
`docs/plans/2026-10-27-real-time-chat-plan.md`, section "About me in her
own words + the rail, mode and AI icons".

## 1. What was wrong (dad, 11/7)

"The things she shares about herself … are not coherent concepts. They're
just a bunch of words … They should be things that she can genuinely share
that would sound normal for a person to share about herself. Better if
there's some sort of icon that can resemble that and be coherent to it."
And: "my comments or questions … should have icons on those tiles … a comment
bubble, a question bubble … and then maybe some icon for the ones that are AI
generated versus not."

Cause, on the device: the About me page (stable frame §2) showed the four
shipped lines, then the weekly builder's *About her* notes exactly as they
are written for the reply model (third person, fragments: "Music.",
"Disney movies.", "Maths — she loves a maths lesson."), then five "We are
learning about …" lines: fifteen tiles over two pages, most without a
picture. The phrase table pinned My questions to the library's *think*
picture and My comments to *remember* (a girl with an appointment note), and
Make a comment to *tell* (a grandmother telling a story). Nothing marked
which tiles the model wrote.

## 2. About me: her own lines, one page

- The page shows her saved stories first (label speaks its message, as
  today), then the device's `chatAbout` lines. The world's *About her*
  notes and the week's "We are learning about …" lines no longer appear on
  the page. They still feed every generated reply through the world digest
  (`GET /chat/api/world` keeps `about` and `week`; the page stops reading
  them).
- A line is a whole first-person sentence a person would say about herself
  ("I love math", never "Maths — she loves a maths lesson."), up to 40
  characters, ten lines at most (down from twenty; the partner dialog says
  so). Ten fit on one page, so every tile keeps its place; with stories the
  page may still turn (More), as today.
- Every line carries one picture, chosen when the line is saved, never
  guessed at the reveal. In the partner dialog a line is `words` or
  `words = picture word`, where the picture word is a concept of the
  vocabulary table (`eyes`, `school`, `music`, `book`, `draw`, `walk` …).
  Without `= word` the hub picks one with its existing text guess
  (chat-symbols.js, the same pick a reply gets); a guess of `chat` keeps the
  words alone rather than show a wrong picture. An unknown picture word is
  refused with the dialog's "Not saved" note naming it. The same syntax works
  for My questions and My comments.
- Under each list box the dialog shows a preview strip: each line as her
  tile will show it (words and picture, library style), so the partner sees
  the pick and can override it with `= word`.
- Storage: `chatAbout`, `chatQuestions`, `chatComments` become lists of
  `{ label, symbol }` (`symbol` a vocabulary word or null) in app-settings.
  Plain strings are still accepted on read and on POST (label alone, symbol
  picked by the hub) so nothing stored today breaks. Validation in
  chat-turns.js as today (count, length, control characters), plus: a symbol
  must be a word of the table, else the POST is refused.
- Shipped defaults (generic, never family facts): About me = "I talk with my
  eyes = eyes", "I go to school = school", "I love music = music", "I love
  books = book", "I like to draw = draw", "I like movies = cinema", "I like
  to be silly = silly", "Ask me anything" (no picture). My questions and My
  comments keep their lines, pictures picked by the hub. Her own lines are
  entered on each device as settings and never shipped.

## 3. The rail and the modes: a question bubble and a comment bubble

- The phrase table pins `my questions` and `ask a question` to the library's
  `question` picture (the question-mark bubble) and `my comments` and
  `make a comment` to a new concept `comment`: a speech bubble with two text
  lines, drawn in-house (symbols.js `shapes`) in the library's own style, a
  black outline with a white-filled bubble, fixed colours so it matches the
  question bubble on the grey rail and mode tiles in every picture style
  (colour, black-and-white, emoji). `comment` has no library id: it is the
  first concept whose picture is a drawing in every style, and the plan
  (`planPictures`) handles a concept without an id by planning the drawing
  (`kind: 'drawn'`). The vocabulary sheet tool tolerates it.
- `about me` stays `me`; Tell me more and Something else keep their pictures.
- Pair rule: two tiles on one page may show the same picture when exactly
  one of them carries a badge (the AI mark of §4), the way Yes and No already
  pair; so My questions and Ask a question share the question bubble, My
  comments and Make a comment share the comment bubble, and a generated
  reply still never repeats a rail picture.

## 4. The AI mark: sparkles

- One badge in the lower-right corner of a tile's picture, the place and
  size of the Yes/No check-mark badge (`attachBadge` gains a third side,
  `ai`; `placeBadge` is unchanged): three four-pointed sparkles drawn
  in-house, one colour (violet on the white badge disc; black in the
  black-and-white style), the same in every picture style. Dad chose the
  sparkles over a brain ("I like the sparkles").
- Where it goes: the two mode tiles (Ask a question, Make a comment),
  always, lit or dimmed; and every reply the model generated: a batch the
  hub reports as `generated: true` (the §3 mode sets, a Something else
  batch, a full-answer merge). Never on her own lines, the openers, Tell me
  more, Something else, Back, the yes-or-no pair, letters and numbers, a
  "this or that" split, the guarded templates, or any batch the hub built
  without the model.
- One badge a tile: the Yes/No badge of a full answer (§11) outranks the AI
  mark, because the check mark is the meaning and the sparkle only the
  provenance. A tile whose picture is set aside (words alone) shows no
  badge, as today.
- No new record: the turn record already says `generated`.

## 5. Tests first

- chat-symbols / chat-pictures: the phrase pins; `comment` plans as a
  drawing in every style; the pair rule (badged + unbadged may share; two
  unbadged may not); `attachBadge('ai')` draws the sparkles and sits where
  the check mark sits; the yes/no badge wins over ai.
- chat-turns: list items as `{label, symbol}`, strings accepted, symbol
  validated against the table, ten About me lines at most, the new
  defaults; the `= word` form parsed by the page, not the hub.
- chat-browser: About me shows stories then lines with their pictures and
  no world lines; the mode tiles carry the mark; a generated batch's replies
  carry it and a local yes-or-no pair does not; the dialog saves `= word`,
  refuses an unknown word, and the preview strip shows the pick.
- The VM smoke (chat-ui-smoke) keeps passing: its About me round trip looks
  for the saved story, which still comes first.

## 6. Builder check (11/7): three calls

- **A hub pick outside the table keeps its picture.** A stored line is
  `{ label, symbol, symbolId }`: `symbol` a table word (id from the table),
  or a word the table lacks paired with the library id the hub's word index
  found for it (the "lasagna" branch the page already renders), or null for
  no picture. A POST is accepted when `symbol` is a table word, or a
  word with a positive integer `symbolId`, or null; anything else is
  refused. So "Can I have a turn?" keeps the hub's *turn* picture.
- **`= none` means no picture, and the box shows every pick.** In the
  dialog `words = none` stores `symbol: null`; a plain `words` line asks the
  hub to pick. When the dialog fills a box from the stored list it writes
  `label = word` (or `label = none`) on every line, so a list round-trips
  without drifting and the partner sees each pick in the box as well as in
  the preview strip. The shipped "Ask me anything" is stored as `= none`.
- **A Yes or No answered in full never carries the sparkles.** With a
  feeling the tile shows the feeling with its Yes/No badge (the badge wins);
  without one the check mark or the cross is the picture itself and gets no
  badge. In short: no tile of the yes-or-no pair, merged or not, shows the
  AI mark. The §11 browser case asserts it.
