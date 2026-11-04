// Helper contract for vm.geometry(): the kiosk viewport measured against the
// screen. The law is "fills the screen", with ONE pixel of height forgiven
// (the re-saved QA guest reports the kiosk one pixel short in both display
// modes); a short window is always logged.
// Run: node --test tests-vm/kiosk-geometry.test.mjs (outside the flat Linux gate,
// like tests-vm/native-display.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { geometry } from './lib/vm.mjs';

const page = (win) => ({ evaluate: async () => ({ ...win }) });
const screen = (extra = {}) => ({ w: 1024, h: 768, x: 0, y: 0, sw: 1024, sh: 768, ...extra });

async function measure(win) {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return { ...(await geometry(page(win))), lines }; } finally { console.log = log; }
}

test('a viewport exactly the size of the screen, at the origin, is full-screen and logs nothing', async () => {
  const r = await measure(screen());
  assert.equal(r.fullscreen, true);
  assert.deepEqual(r.win, screen());
  assert.deepEqual(r.lines, []);
});

test('one pixel short in height is full-screen, and the shortfall is still logged', async () => {
  for (const win of [screen({ h: 767 }), screen({ w: 1280, h: 799, sw: 1280, sh: 800 })]) {
    const r = await measure(win);
    assert.equal(r.fullscreen, true, JSON.stringify(win));
    assert.equal(r.lines.length, 1, 'one warning line — ' + JSON.stringify(r.lines));
    assert.match(r.lines[0], /WARNING: kiosk viewport is \d+x\d+ .*one pixel short/);
  }
});

test('two pixels short in height, one pixel short in width, or an offset window is not full-screen', async () => {
  for (const win of [screen({ h: 766 }), screen({ w: 1023 }), screen({ x: 10 }), screen({ y: 10 }), screen({ x: 10, y: 10 })]) {
    const r = await measure(win);
    assert.equal(r.fullscreen, false, JSON.stringify(win));
    assert.match(r.lines.join('\n'), /WARNING: kiosk viewport .*not full-screen/);
  }
});
