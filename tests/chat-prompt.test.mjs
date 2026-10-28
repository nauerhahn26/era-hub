// Reading the options aloud (spec 2026-10-28 §6): the pure reader behind it,
// with fake timers and a fake voice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/chat/prompt.js', import.meta.url), 'utf8');
const { createOptionsReader, PROMPT_GAP_MS } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function clock() {
  let at = 0, seq = 0; const timers = new Map();
  return {
    now: () => at,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, due: at + ms }); return id; },
    clearTimeout: id => { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const end = at + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        timers.delete(next[0]); at = next[1].due; next[1].fn();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      at = end;
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}
// A voice whose clips take `clipMs` on the fake clock, honouring the abort signal.
function voice(c, clipMs = 500) {
  const log = [];
  const speak = (text, signal) => new Promise(resolve => {
    log.push(`say:${text}`);
    const id = c.setTimeout(() => resolve(true), clipMs);
    signal?.addEventListener('abort', () => { c.clearTimeout(id); resolve(false); }, { once: true });
  });
  return { log, speak, light: item => log.push(`light:${item.label}`), unlight: item => log.push(`unlight:${item.label}`) };
}
const batch = (id, labels) => ({ id, items: labels.map(label => ({ label })) });

test('after the silence the name and each label are read in order, each tile lit while its clip plays', async () => {
  const c = clock(), v = voice(c); let started = 0;
  const reader = createOptionsReader({ delayMs: () => 12000, name: () => 'Sam', ...v, onStart: () => started++, ...c });
  const done = reader.armed(batch('1', ['Chicken', 'Fish', 'Sushi']));
  await c.advance(11999); assert.deepEqual(v.log, [], 'nothing before the delay');
  await c.advance(1); assert.deepEqual(v.log, ['say:Sam, your options are']); assert.equal(started, 1);
  await c.advance(10000);
  assert.deepEqual(v.log, ['say:Sam, your options are', 'light:Chicken', 'say:Chicken', 'unlight:Chicken',
    'light:Fish', 'say:Fish', 'unlight:Fish', 'light:Sushi', 'say:Sushi', 'unlight:Sushi']);
  assert.deepEqual(await done, { read: 3, cancelled: false });
  assert.ok(PROMPT_GAP_MS >= 250 && PROMPT_GAP_MS <= 500);
});

test('a natural cadence: a short gap between items, none before the first or after the last', async () => {
  const c = clock(), v = voice(c, 500), at = [];
  const reader = createOptionsReader({ delayMs: 1000, name: 'Sam', speak: (t, s) => { at.push(c.now()); return v.speak(t, s); }, light() {}, unlight() {}, ...c });
  const done = reader.armed(batch('1', ['A one', 'A two']));
  await c.advance(10000); await done;
  assert.deepEqual(at, [1000, 1500, 2000 + PROMPT_GAP_MS]);
});

test('cancel stops the timer before it fires, or the reading at once, and unlights the lit tile', async () => {
  const c = clock(), v = voice(c);
  const reader = createOptionsReader({ delayMs: 5000, name: 'Sam', ...v, ...c });
  const before = reader.armed(batch('1', ['Chicken', 'Fish']));
  await c.advance(4000); reader.cancel();
  assert.deepEqual(await before, { read: 0, cancelled: true }); assert.equal(c.pending(), 0);
  await c.advance(10000); assert.deepEqual(v.log, []);
  const during = reader.armed(batch('2', ['Chicken', 'Fish']));
  await c.advance(5000 + 500 + 200); // into Chicken's clip
  assert.deepEqual(v.log, ['say:Sam, your options are', 'light:Chicken', 'say:Chicken']);
  reader.cancel();
  assert.deepEqual(await during, { read: 0, cancelled: true });
  assert.deepEqual(v.log.slice(3), ['unlight:Chicken']);
  await c.advance(10000); assert.equal(v.log.length, 4, 'nothing more is said');
});

test('a batch is read at most once; off (0) never arms; a new batch re-arms and replaces the old timer', async () => {
  const c = clock(), v = voice(c); let delay = 0;
  const reader = createOptionsReader({ delayMs: () => delay, name: 'Sam', ...v, ...c });
  assert.deepEqual(await reader.armed(batch('off', ['A'])), { read: 0, cancelled: true }); assert.equal(c.pending(), 0);
  delay = 2000;
  const first = reader.armed(batch('1', ['A']));
  const again = reader.armed(batch('1', ['A']));
  assert.deepEqual(await again, { read: 0, cancelled: true }, 'the same batch is not armed twice');
  await c.advance(5000); assert.deepEqual(await first, { read: 1, cancelled: false });
  assert.deepEqual(await reader.armed(batch('1', ['A'])), { read: 0, cancelled: true }, 'a read batch is never read again');
  const old = reader.armed(batch('2', ['B']));
  await c.advance(1000);
  const fresh = reader.armed(batch('3', ['C']));
  assert.deepEqual(await old, { read: 0, cancelled: true });
  await c.advance(5000); assert.deepEqual(await fresh, { read: 1, cancelled: false });
  assert.deepEqual(v.log.filter(line => line.startsWith('say:') && line !== 'say:Sam, your options are'), ['say:A', 'say:C']);
  assert.deepEqual(await reader.armed(batch('4', [])), { read: 0, cancelled: true }, 'nothing to read');
});

test('a clip that fails or a light that throws never leaves a tile lit or breaks the reading', async () => {
  const c = clock(), lit = new Set();
  const reader = createOptionsReader({ delayMs: 100, name: 'Sam', ...c,
    speak: async text => { if (text === 'Fish') throw new Error('no sound'); return true; },
    light: item => lit.add(item.label), unlight: item => lit.delete(item.label) });
  const done = reader.armed(batch('1', ['Chicken', 'Fish', 'Beef']));
  await c.advance(5000);
  assert.deepEqual(await done, { read: 3, cancelled: false }); assert.equal(lit.size, 0);
});
