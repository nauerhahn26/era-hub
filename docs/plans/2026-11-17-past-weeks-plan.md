# Past weeks — plan (2026-11-17)

Spec: `docs/specs/2026-11-17-past-weeks-design.md`. Hub only (era-hub); no
era-board change expected — if the board front end cannot render a recipe
shape below, stop and report rather than editing era-board.

## Tasks (test first, each)

- [x] T1 `this-week.js`: `readWeeks(dataDir)` → every valid week, newest first
      (current = first, same pick as `readWeek`); past weeks capped at 52.
- [x] T2 recipe: the root's [2,1] 🗓️ Past weeks door (only with ≥1 past week);
      `past-N` pages; `w-<week>` corner boards; `w-<week>-watch` / `-talk-N`
      from the same builders; Back targets per the spec; glyph rule.
- [x] T3 ETag over all listed weeks; `THIS_WEEK_REV` → 4; `build()` never throws
      on a bad past week.
- [x] T4 the way back: `public/watch/watch.js` and `public/play/play.js` return to
      the board the video/game came from (past week → its `w-` board).
- [ ] T5 tests: `tests/this-week-recipe.test.mjs` (+ watch/play UI tests as
      needed); full gate green. (Targeted suites green: this-week-recipe 29/29,
      watch-ui 14/14, play-ui 44/44, this-week-fetch 8/8, chat-world 14/14;
      the full gate is the overseer's.)

## Retrospective

(after landing)
