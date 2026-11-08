import test from 'node:test';
import assert from 'node:assert/strict';
import { assertGamesNativeGeometry, assertFreshGamesBrowser, gamesProgress } from './lib/games-ui-smoke.mjs';

const viewport = () => ({ width: 1280, height: 800, screenWidth: 1280, screenHeight: 800,
  screenX: 0, screenY: 0, dpr: 1, visualScale: 1, htmlZoom: '1', bodyZoom: '1' });
const identity = () => ({ browserPid: 41, created: '2026-01-01T00:00:00.000Z',
  cdp: 'ws://guest/devtools/browser/first', hubPid: 17, installedDir: 'installed' });

test('native Games geometry permits the established one-pixel kiosk height tolerance only', () => {
  assertGamesNativeGeometry(viewport());
  assertGamesNativeGeometry({ ...viewport(), height: 799 });
  for (const change of [{ width: 1279 }, { height: 798 }, { screenWidth: 1024 },
    { screenHeight: 768 }, { screenX: 1 }, { screenY: 1 }, { dpr: 2 },
    { visualScale: 1.1 }, { htmlZoom: '1.25' }, { bodyZoom: '0.8' }]) {
    assert.throws(() => assertGamesNativeGeometry({ ...viewport(), ...change }));
  }
});

test('Games durability requires a different browser process and endpoint on the same hub', () => {
  const before = identity();
  const after = { ...before, browserPid: 42, created: '2026-01-01T00:01:00.000Z',
    cdp: 'ws://guest/devtools/browser/second' };
  const closed = { method: 'Browser.close', allBrowserProcessesGone: true, guestCdpUnavailable: true };
  assertFreshGamesBrowser(before, after, closed);
  for (const key of ['browserPid', 'created', 'cdp']) {
    assert.throws(() => assertFreshGamesBrowser(before, { ...after, [key]: before[key] }, closed));
  }
  for (const change of [{ hubPid: 18 }, { installedDir: 'another-install' }]) {
    assert.throws(() => assertFreshGamesBrowser(before, { ...after, ...change }, closed));
  }
  assert.throws(() => assertFreshGamesBrowser(before, after, { ...closed, allBrowserProcessesGone: false }));
  assert.throws(() => assertFreshGamesBrowser(before, after, { ...closed, guestCdpUnavailable: false }));
});

test('durability compares all four independent Games workspaces and excludes transient readiness', () => {
  const state = { version: 1, view: 'tictactoe', fashion: { looks: [{ id: 'look-1' }] },
    connect4: { board: [[1]] }, tiles: { score: 4 }, tictactoe: { board: [1, 2, 0] },
    ready: true, paused: false, hidden: false, pending: null };
  const progress = gamesProgress(state);
  assert.deepEqual(Object.keys(progress).sort(), ['version', 'view', 'fashion', 'connect4', 'tiles', 'tictactoe'].sort());
  progress.fashion.looks[0].id = 'changed';
  progress.tictactoe.board[0] = 2;
  assert.equal(state.fashion.looks[0].id, 'look-1');
  assert.equal(state.tictactoe.board[0], 1);
});
