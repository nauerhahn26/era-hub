// The stable frame (spec 2026-10-28 §1-2): the pure layout module behind the
// Chat reply screen. Nine fixed tiles, the middle by reply count, the page
// cells with ten items, More and Back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/chat/frame.js', import.meta.url), 'utf8');
const { GRID, fixedTiles, replyAreas, pageCells, paginate, PAGE_SIZE } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// "row-start / col-start / row-end / col-end" → the cells it covers.
function cells(area) {
  const [r0, c0, r1, c1] = area.split('/').map(part => Number(part.trim()));
  const out = [];
  for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) out.push(`${r}:${c}`);
  return out;
}
const MIDDLE = cells('2 / 2 / 4 / 14');

test('the grid tracks are one 3fr rail column, twelve equal columns and four rows', () => {
  assert.deepEqual(GRID, { columns: '3fr repeat(12, 1fr)', rows: '0.5fr 1fr 1fr 0.62fr' });
});

test('nine fixed tiles sit where the spec table puts them, with their kinds', () => {
  const tiles = fixedTiles();
  assert.deepEqual(tiles.map(tile => [tile.key, tile.kind, tile.area]), [
    ['yes', 'yes', '1 / 1 / 2 / 2'],
    ['question', 'question', '1 / 2 / 2 / 11'],
    ['no', 'no', '1 / 11 / 2 / 14'],
    ['questions', 'page', '2 / 1 / 3 / 2'],
    ['comments', 'page', '3 / 1 / 4 / 2'],
    ['about', 'page', '4 / 1 / 5 / 2'],
    ['more', 'static', '4 / 2 / 5 / 5'],
    ['ask', 'mode', '4 / 5 / 5 / 8'],
    ['comment', 'mode', '4 / 8 / 5 / 11'],
    ['else', 'static', '4 / 11 / 5 / 14'],
  ]);
  assert.deepEqual(tiles.map(tile => tile.label), ['yes', '', 'no', 'My questions', 'My comments', 'About me', 'Tell me more', 'Ask a question', 'Make a comment', 'Something else']);
  // The fixed tiles and the middle tile the whole 4 x 13 grid exactly once.
  const covered = [...tiles.flatMap(tile => cells(tile.area)), ...MIDDLE];
  assert.equal(covered.length, 4 * 13); assert.equal(new Set(covered).size, 4 * 13);
  assert.ok(Object.isFrozen(tiles));
});

test('replies by count: four as two by two in spoken order, three and two across both rows, one takes the middle', () => {
  assert.deepEqual(replyAreas(4), ['2 / 2 / 3 / 8', '2 / 8 / 3 / 14', '3 / 2 / 4 / 8', '3 / 8 / 4 / 14']);
  assert.deepEqual(replyAreas(3), ['2 / 2 / 4 / 6', '2 / 6 / 4 / 10', '2 / 10 / 4 / 14']);
  assert.deepEqual(replyAreas(2), ['2 / 2 / 4 / 8', '2 / 8 / 4 / 14']);
  assert.deepEqual(replyAreas(1), ['2 / 2 / 4 / 14']);
  for (const n of [1, 2, 3, 4]) {
    const covered = replyAreas(n).flatMap(cells);
    assert.deepEqual(covered.sort(), [...MIDDLE].sort(), `${n} replies fill the middle exactly`);
  }
  assert.deepEqual(replyAreas(0), []);
  assert.deepEqual(replyAreas(6), replyAreas(4), 'never more than four');
});

test('a page takes rows 2-4 as twelve 3-column cells, left to right then down', () => {
  const page = pageCells();
  assert.equal(page.length, 12);
  assert.deepEqual(page.slice(0, 4), ['2 / 2 / 3 / 5', '2 / 5 / 3 / 8', '2 / 8 / 3 / 11', '2 / 11 / 3 / 14']);
  assert.equal(page[11], '4 / 11 / 5 / 14');
  const covered = page.flatMap(cells);
  assert.equal(new Set(covered).size, 36);
  assert.deepEqual(covered.sort(), [...MIDDLE, ...cells('4 / 2 / 5 / 14')].sort());
});

test('paging shows ten items, More while more remain, and wraps back to the start', () => {
  const items = Array.from({ length: 23 }, (_, i) => `item ${i}`);
  assert.equal(PAGE_SIZE, 10);
  assert.deepEqual(paginate(items, 0), { shown: items.slice(0, 10), more: true, next: 10 });
  assert.deepEqual(paginate(items, 10), { shown: items.slice(10, 20), more: true, next: 20 });
  assert.deepEqual(paginate(items, 20), { shown: items.slice(20), more: false, next: 0 });
  assert.deepEqual(paginate(items.slice(0, 10), 0), { shown: items.slice(0, 10), more: false, next: 0 });
  assert.deepEqual(paginate([], 0), { shown: [], more: false, next: 0 });
  assert.deepEqual(paginate(items, 99), paginate(items, 0), 'an offset past the end starts again');
  assert.deepEqual(paginate(items, -3), paginate(items, 0));
});
