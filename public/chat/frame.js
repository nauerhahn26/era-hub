// The stable frame of the Chat reply screen (spec 2026-10-28 §1-2). Pure
// layout, no DOM: app.js places every tile with style.gridArea from here.
// Areas are CSS grid-area strings "row-start / col-start / row-end / col-end".
export const GRID = Object.freeze({ columns: '3fr repeat(12, 1fr)', rows: '0.5fr 1fr 1fr 0.62fr' });
export const PAGE_SIZE = 10;

const area = (row, col, rows = 1, cols = 1) => `${row} / ${col} / ${row + rows} / ${col + cols}`;

// Nine tiles never move (the strip is the tenth cell of the top row's frame).
const FIXED = Object.freeze([
  { key: 'yes', label: 'yes', kind: 'yes', area: area(1, 1) },
  { key: 'question', label: '', kind: 'question', area: area(1, 2, 1, 9) },
  { key: 'no', label: 'no', kind: 'no', area: area(1, 11, 1, 3) },
  { key: 'questions', label: 'My questions', kind: 'page', area: area(2, 1) },
  { key: 'comments', label: 'My comments', kind: 'page', area: area(3, 1) },
  { key: 'about', label: 'About me', kind: 'page', area: area(4, 1) },
  { key: 'more', label: 'Tell me more', kind: 'static', area: area(4, 2, 1, 3) },
  { key: 'ask', label: 'Ask a question', kind: 'mode', area: area(4, 5, 1, 3) },
  { key: 'comment', label: 'Make a comment', kind: 'mode', area: area(4, 8, 1, 3) },
  { key: 'else', label: 'Something else', kind: 'static', area: area(4, 11, 1, 3) },
].map(tile => Object.freeze(tile)));
export function fixedTiles() { return FIXED; }

// The middle is rows 2-3, columns 2-13. Four replies read in spoken order:
// top-left, top-right, bottom-left, bottom-right.
const REPLIES = {
  1: [area(2, 2, 2, 12)],
  2: [area(2, 2, 2, 6), area(2, 8, 2, 6)],
  3: [area(2, 2, 2, 4), area(2, 6, 2, 4), area(2, 10, 2, 4)],
  4: [area(2, 2, 1, 6), area(2, 8, 1, 6), area(3, 2, 1, 6), area(3, 8, 1, 6)],
};
export function replyAreas(count) {
  const n = Math.min(4, Math.max(0, Math.floor(Number(count) || 0)));
  return n ? [...REPLIES[n]] : [];
}

// A page takes the middle and the bottom row: four 3-column cells a row, rows 2-4.
export function pageCells() {
  const out = [];
  for (let row = 2; row <= 4; row++) for (let i = 0; i < 4; i++) out.push(area(row, 2 + i * 3, 1, 3));
  return out;
}

// Ten items a page; More while more remain (it wraps back to the first page).
export function paginate(items, offset = 0) {
  const list = Array.isArray(items) ? items : [];
  const start = Number.isInteger(offset) && offset > 0 && offset < list.length ? offset : 0;
  const shown = list.slice(start, start + PAGE_SIZE);
  const more = start + PAGE_SIZE < list.length;
  return { shown, more, next: more ? start + PAGE_SIZE : 0 };
}

// Back in the door bar (maintainer, 10/29): right of the door, twice its width,
// a quarter of its width between them; the session status follows at the same gap.
export const BAR_BACK = Object.freeze({ widthOfDoor: 2, gapOfDoor: 0.25 });

// What Back does now: close a page, then a lit mode, then restore the previous
// batch of this session. Nothing during a hold or with nothing behind (dimmed).
export function backTarget({ page = null, mode = null, previous = false, holding = false } = {}) {
  if (holding) return null;
  if (page) return 'page';
  if (mode) return 'mode';
  return previous ? 'restore' : null;
}

// The batches this session showed before the one on screen, newest last.
export function createBackStack(limit = 8) {
  let items = [];
  return {
    push(batch) {
      if (!batch || !Array.isArray(batch.choices) || !batch.choices.length) return;
      items = [...items, { question: String(batch.question || ''), choices: batch.choices.map(choice => ({ ...choice })) }].slice(-limit);
    },
    pop() { return items.length ? items.pop() : null; },
    clear() { items = []; },
    get size() { return items.length; },
  };
}
