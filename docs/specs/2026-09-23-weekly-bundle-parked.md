# The weekly bundle — PARKED (dad, 2026-09-23)

Status: **parked, coming back soon.** Not a spec to build from yet. Written so the
idea survives a chat clear; dad asked for it to be part of the seal.

## The idea

One teacher email in (the class newsletter, Fridays), three things out:

| Piece | What it is | Where it stands |
|---|---|---|
| **Book** | A fun story: her life, the hero's real story, as many of the week's concepts as fit *without forcing*. | Exists (`ellie-this-week`). Being fixed first — branch `feat/books-better`. |
| **Word board** | The week's words as a board she talks with (hero, science words, …), pictures from the book. | Decided 2026-08-02 (aac-board-builder `docs/design-decisions.md` **D46**: rebuild on Ellie Board). **Never done** — `ellie-this-week/src/ellie/board/deploy.py` still targets AsTeRICS, dead since D41. TD Snap edits go only through the editor harness (router law 1) and touch her live board, so the lean is: board lives on Ellie Board, a TD Snap tile opens it. |
| **This Week's Games** | Short gaze exercises in the hub: a question + 2–4 big picture choices, dwell to answer, errorless (wrong → gentle retry, then the answer is shown). | New. Would be an era-hub module. |

Dad's framing: "Not everything has to be a book … I don't think we necessarily want
to co-mingle all this with the book, which is a fun story and incorporates her life
and weekly learnings." Example: learning about planets → a board with all the planets.

## Games — first sketch (for when we come back)

- **Math at first-grade level**, never counting-to-ten: doubles, make-ten, count
  back, missing part — using objects and characters from that week's book
  ("Grandma cuts 5 slices here, 5 there — how many?"). The page turn / reveal is the
  think-then-see beat.
- **Phonics**: "Which one is *pot*?" with 3 pictures; the week's sound could also
  choose her next Making Words lesson (era-making-words already ships the
  Cunningham & Hall sequence).
- **About the book**: "What did the hero say?" — two picture choices
- **A record**: her answers logged → a weekly note for dad and her teachers (IEP
  evidence).

## Open questions for the return

1. Board target: Ellie Board only, or also a TD Snap page (cost: the harness)?
2. Games: a new era-hub module, or a mode of the reader after the last page?
3. Does the record go to school, and in what form?
4. Rett-specific: 2 vs 4 choices, dwell time, how "try again" should sound.
