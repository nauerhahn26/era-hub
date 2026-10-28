// buttons.js: the hub's half of "button press to ask" (design 2026-10-27
// §4.1-§4.2, plan T1.1/T1.3). A partner's button (a Flic in keyboard mode, the
// I-13's Square button) reaches the hub as POST /buttons/press {key, action};
// buttons.press() validates the key and drives one dispatcher. Unit tests: no
// hub, every dependency injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createButtons, KEYS } = require('../buttons.js');

function fakeCommands({ connected = false, visible = null } = {}) {
  const pushed = [], issued = [], revoked = [];
  const c = {
    pushed, issued, revoked, connected, visible, visibleAfterForeground: false,
    state: () => ({ connected: c.connected, visible: c.visible }),
    push: cmd => { if (!c.connected) return false; pushed.push(cmd); return true; },
    issue: info => { const nonce = (issued.length + 1).toString(16).padStart(16, '0'); issued.push({ nonce, ...info }); return nonce; },
    pending: nonce => issued.some(i => i.nonce === nonce) && !revoked.includes(nonce) && !c.claimed,
    revoke: nonce => { revoked.push(nonce); },
    waitVisible: async () => c.visible === true,
  };
  return c;
}
function fakeKiosk(commands, { found = true } = {}) {
  const k = { foregrounds: 0, relaunches: [],
    foreground: async () => { k.foregrounds++; if (found && commands.visibleAfterForeground) commands.visible = true; return found; },
    relaunch: async open => { k.relaunches.push(open); return { would: [open] }; } };
  return k;
}
function make({ chat = true, commands = fakeCommands(), kiosk, window = () => null, now = 1000 } = {}) {
  const logs = [];
  const buttons = createButtons({ port: 8377, enabledChat: () => chat, commands, kiosk: kiosk || fakeKiosk(commands), window,
    log: m => logs.push(m), clock: () => now, platform: 'linux', visibleWaitMs: 50 });
  return { buttons, commands, logs };
}

test('KEYS: F13, Ctrl+Alt+F9 and Ctrl+Alt+F10 ask; F14 and Ctrl+Alt+F11 cancel', () => {
  assert.deepEqual({ ...KEYS }, { 'F13': 'ask', 'Ctrl+Alt+F9': 'ask', 'Ctrl+Alt+F10': 'ask', 'F14': 'cancel', 'Ctrl+Alt+F11': 'cancel' });
  assert.ok(Object.isFrozen(KEYS));
});

test('an unknown key, a missing body or an action that does not match its key is 400 and records nothing', async () => {
  const { buttons } = make();
  for (const body of [null, {}, { key: 'F12', action: 'ask' }, { key: 'f13' }, { key: 'F13', action: 'cancel' }, { key: 'F14', action: 'ask' }, { key: ['F13'] }]) {
    const r = await buttons.press(body);
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.ok, false);
  }
  assert.equal((await buttons.press({ key: 'F12' })).error, 'unknown-key');
  assert.equal((await buttons.press({ key: 'F13', action: 'cancel' })).error, 'wrong-action');
  assert.equal(buttons.status().lastPress, null);
});

test('Chat turned off: 409 chat-off, nothing dispatched, the press is still shown as the last press', async () => {
  const commands = fakeCommands({ connected: true, visible: true });
  const kiosk = fakeKiosk(commands);
  const { buttons } = make({ chat: false, commands, kiosk });
  const r = await buttons.press({ key: 'F13', action: 'ask' });
  assert.deepEqual([r.status, r.ok, r.error], [409, false, 'chat-off']);
  assert.equal(commands.pushed.length, 0); assert.equal(kiosk.relaunches.length + kiosk.foregrounds, 0);
  assert.deepEqual(buttons.status().lastPress, { at: new Date(1000).toISOString(), key: 'F13', action: 'ask', dispatch: 'chat-off' });
});

test('the action may be left out: the key decides it', async () => {
  const { buttons } = make({ commands: fakeCommands({ connected: true, visible: true }) });
  const r = await buttons.press({ key: 'Ctrl+Alt+F9' });
  assert.equal(r.status, 200); assert.equal(buttons.status().lastPress.action, 'ask');
});

test('status: the listener fields, unsupported off Windows, nothing pressed yet', () => {
  const { buttons } = make();
  assert.deepEqual(buttons.status(), { state: 'unsupported', pid: null, keys: { registered: [], failed: [] }, lastPress: null,
    restarts: 0, lastError: null, micPolicy: 'n/a' });
});

test('the payload ships buttons.js and every hub module server.js loads, transitively', async () => {
  const fs = await import('node:fs'), path = await import('node:path');
  const hub = new URL('../', import.meta.url).pathname;
  const copied = new Set([...fs.readFileSync(path.join(hub, 'tools', 'build-payload.sh'), 'utf8').matchAll(/"\$HUB\/([A-Za-z0-9._-]+\.js)"/g)].map(m => m[1]));
  assert.ok(copied.has('buttons.js'), 'buttons.js is copied into the payload');
  const seen = new Set(), queue = ['server.js'];
  while (queue.length) {
    const file = queue.shift(); if (seen.has(file)) continue; seen.add(file);
    for (const [, name] of fs.readFileSync(path.join(hub, file), 'utf8').matchAll(/require\(["']\.\/([A-Za-z0-9._-]+\.js)["']\)/g)) queue.push(name);
  }
  for (const file of seen) assert.ok(copied.has(file), file + ' is copied into the payload');
});
