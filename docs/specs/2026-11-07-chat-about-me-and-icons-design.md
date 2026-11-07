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

## 7. Review on a scratch hub (11/7): two amendments

Screenshots at the tablet's 1280×800 and the eye-gaze device's 1920×1080:

- **The AI mark on a tile with no picture.** The bottom row is short, so
  Ask a question and Make a comment set their picture aside at both sizes
  (as Tell me more and Something else already do), and a mark that lives
  only on a picture never shows there. Amends §4: the mark marks the tile,
  not the picture. On a tile that shows a picture it sits on the picture's
  corner as the check mark does; on a tile with no picture (set aside, or a
  words-only reply) it sits in the tile's own top-right corner on its white
  disc, small (about an eighth of the tile's height, never under 28 px nor
  over 56 px), over the padding so the words are not refitted. The Yes/No
  badge keeps needing a picture.
- **Her pages keep their pictures.** Under the default fit law a line such
  as "I love music" fits at 74 px stacked and leaves the picture a speck, so
  the picture is set aside: at 1280×800 seven of her ten About me tiles
  showed words alone, and at 1920×1080 two pictures were specks. Dad asked
  for a picture that means each line, so the items of her three pages (and
  only those: `.tile.item`) fit with the `stacked-big` profile that
  tile-fit.js already carries as a candidate: the label takes at most 70 %
  of the height and steps down through 60 px to the 44 px floor before the
  picture is set aside, so the picture keeps at least 30 %. Replies, the
  rail, the corners and the bottom row keep the default law. The overseer's
  call; the maintainer can revert it with a word.
- Tests: chat-picture-layout (a page item at 1280×800 keeps its picture and
  shrinks its words; a reply does not change), chat-browser (the mode tiles'
  mark is placed and visible with the picture set aside; a words-only
  generated reply carries the corner mark; a yes/no badge without a picture
  stays hidden).

## 8. Gate (11/7): her pages stay inside the pre-warmed table

The offline picture suite failed: the hub's own pick for four shipped lines
("Can I have a turn?" → *turn*, "Who is coming?", "Where are we going?",
"That sounds fun!") came from the word index outside the vocabulary table,
and only the table is pre-warmed into the cache, so those tiles miss with
the provider gone — which is school. Amends §6, first call: a line's picture
is a table word or none. The hub's pick for a line is kept only when it is a
table word; an off-table pick stores no picture (words alone), and a POST
with an off-table word is refused as before. `symbolId` is then always the
table's id (or null). The shipped My questions and My comments defaults pin
their picture words in the table so no default is left without one where
one fits ("Can I have a turn?" = my turn, "That sounds fun!" = fun, "Where
are we going?" = go, "Who is coming?" = come here or none). Partners who
want a picture the table lacks get the words alone; adding the concept to
the table is the fix, and it is then pre-warmed like every other.
