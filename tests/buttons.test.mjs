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
function make({ chat = true, commands = fakeCommands(), kiosk, window = () => null, now = 1000, clock = () => now, visibleWaitMs = 50 } = {}) {
  const logs = [];
  const buttons = createButtons({ port: 8377, enabledChat: () => chat, commands, kiosk: kiosk || fakeKiosk(commands), window,
    log: m => logs.push(m), clock, platform: 'linux', visibleWaitMs });
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
  assert.ok(seen.has('buttons.js') && seen.has('kiosk-launch.js'), 'server.js loads buttons.js and kiosk-launch.js');
  for (const file of seen) assert.ok(copied.has(file), file + ' is copied into the payload');
});

// ---- the dispatcher (design §4.2; plan T1.3) ----
test('Chat page connected and visible: ask is pushed on its stream, nothing else moves', async () => {
  const commands = fakeCommands({ connected: true, visible: true }), kiosk = fakeKiosk(commands);
  const { buttons } = make({ commands, kiosk, now: 777 });
  assert.deepEqual(await buttons.press({ key: 'F13', action: 'ask' }), { status: 200, ok: true, dispatch: 'visible' });
  assert.deepEqual(commands.pushed, [{ type: 'ask', pressAt: 777, key: 'F13' }]);
  assert.equal(kiosk.foregrounds + kiosk.relaunches.length, 0);
  assert.deepEqual(buttons.status().lastPress, { at: new Date(777).toISOString(), key: 'F13', action: 'ask', dispatch: 'visible' });
});

test('Chat page hidden: the kiosk is foregrounded, the page reports visible, then ask is pushed', async () => {
  const commands = fakeCommands({ connected: true, visible: false }), kiosk = fakeKiosk(commands);
  commands.visibleAfterForeground = true;
  const { buttons } = make({ commands, kiosk });
  assert.equal((await buttons.press({ key: 'Ctrl+Alt+F10' })).dispatch, 'foreground');
  assert.equal(kiosk.foregrounds, 1); assert.equal(kiosk.relaunches.length, 0);
  assert.deepEqual(commands.pushed.map(c => c.type), ['ask']);
});

test('Chat page hidden and never visible within the wait, or no window to foreground, or visibility unknown: relaunch', async () => {
  for (const [visible, found] of [[false, true], [false, false], [null, true]]) {
    const commands = fakeCommands({ connected: true, visible }), kiosk = fakeKiosk(commands, { found });
    const { buttons } = make({ commands, kiosk });
    assert.equal((await buttons.press({ key: 'F13' })).dispatch, 'relaunch', JSON.stringify({ visible, found }));
    assert.equal(kiosk.foregrounds, 1);
    assert.equal(commands.pushed.length, 0, 'never pushed to a page that may be hidden');
    assert.equal(kiosk.relaunches.length, 1);
  }
});

test('no Chat page listening: a nonce is issued for the press and the kiosk relaunches at /chat/?ask=<nonce>', async () => {
  const commands = fakeCommands(), kiosk = fakeKiosk(commands);
  const { buttons } = make({ commands, kiosk, now: 4242 });
  assert.deepEqual(await buttons.press({ key: 'Ctrl+Alt+F9', action: 'ask' }), { status: 200, ok: true, dispatch: 'relaunch' });
  assert.equal(kiosk.foregrounds, 0);
  assert.equal(commands.issued.length, 1);
  assert.deepEqual(commands.issued[0], { nonce: commands.issued[0].nonce, pressAt: 4242, key: 'Ctrl+Alt+F9' });
  assert.deepEqual(kiosk.relaunches, ['/chat/?ask=' + commands.issued[0].nonce]);
});

test('a second ask while the relaunch is still coming up does not relaunch again; once claimed, presses dispatch again', async () => {
  const commands = fakeCommands(), kiosk = fakeKiosk(commands);
  const { buttons } = make({ commands, kiosk });
  await buttons.press({ key: 'F13' });
  assert.equal((await buttons.press({ key: 'F13' })).dispatch, 'busy');
  assert.equal(kiosk.relaunches.length, 1);
  commands.claimed = true; commands.connected = true; commands.visible = true; // the page came up and took the nonce
  assert.equal((await buttons.press({ key: 'F13' })).dispatch, 'visible');
});

test('cancel: with no window and nothing coming up, nothing; during a relaunch, the nonce is revoked', async () => {
  const commands = fakeCommands(), kiosk = fakeKiosk(commands);
  const { buttons } = make({ commands, kiosk });
  assert.deepEqual(await buttons.press({ key: 'F14', action: 'cancel' }), { status: 200, ok: true, dispatch: 'none' });
  assert.equal(commands.pushed.length + kiosk.relaunches.length + kiosk.foregrounds, 0);
  await buttons.press({ key: 'F13' });
  assert.equal((await buttons.press({ key: 'Ctrl+Alt+F11' })).dispatch, 'cancel');
  assert.deepEqual(commands.revoked, [commands.issued[0].nonce]);
  assert.equal((await buttons.press({ key: 'F14' })).dispatch, 'none');
});

test('a listening window open: ask is the second press (end), cancel discards it', async () => {
  const commands = fakeCommands({ connected: true, visible: true }), kiosk = fakeKiosk(commands), calls = [];
  const open = { press: () => calls.push('press'), cancel: () => calls.push('cancel') };
  const { buttons } = make({ commands, kiosk, window: () => open });
  assert.equal((await buttons.press({ key: 'F13' })).dispatch, 'end');
  assert.equal((await buttons.press({ key: 'F14' })).dispatch, 'cancel');
  assert.deepEqual(calls, ['press', 'cancel']);
  assert.deepEqual(commands.pushed, [{ type: 'end' }, { type: 'cancel' }]);
  assert.equal(kiosk.relaunches.length + kiosk.foregrounds, 0);
});

test('a relaunch that fails is logged, never thrown at the press', async () => {
  const commands = fakeCommands();
  const kiosk = { foreground: async () => false, relaunch: async () => { throw new Error('spawn EPERM'); } };
  const { buttons, logs } = make({ commands, kiosk });
  assert.equal((await buttons.press({ key: 'F13' })).dispatch, 'relaunch');
  await new Promise(r => setImmediate(r));
  assert.ok(logs.some(l => l.includes('spawn EPERM')), logs.join('\n'));
  assert.equal((await buttons.press({ key: 'F13' })).dispatch, 'relaunch', 'nothing is coming up, so the next press tries again');
});

test('a relaunch that reports no browser frees the next press too', async () => {
  const commands = fakeCommands();
  const kiosk = { foreground: async () => false, relaunch: async () => ({ ok: false, reason: 'no-browser' }) };
  const { buttons, logs } = make({ commands, kiosk });
  await buttons.press({ key: 'F13' });
  await new Promise(r => setImmediate(r));
  assert.ok(logs.some(l => l.includes('no-browser')));
  assert.equal((await buttons.press({ key: 'F13' })).dispatch, 'relaunch');
});

// ---- review fixes: one dispatch in flight, a bounded relaunch ----
// A hidden page whose wait the test controls: waitVisible resolves only when
// the test says so, or after its ms like the real stream.
function hiddenPage() {
  const commands = fakeCommands({ connected: true, visible: false });
  commands.waits = 0;
  commands.waitVisible = ms => new Promise(resolve => { commands.waits++; commands.release = resolve; setTimeout(() => resolve(false), ms); });
  return commands;
}

test('two presses while a hidden page is being foregrounded: one dispatch in flight, exactly one relaunch', async () => {
  const commands = hiddenPage(), kiosk = fakeKiosk(commands);
  const { buttons } = make({ commands, kiosk, visibleWaitMs: 60 });
  const [a, b] = await Promise.all([buttons.press({ key: 'F13' }), buttons.press({ key: 'F13' })]);
  assert.deepEqual([a.dispatch, b.dispatch], ['relaunch', 'busy']);
  assert.equal(kiosk.foregrounds, 1, 'the second press never foregrounds again');
  assert.equal(kiosk.relaunches.length, 1, 'one close-then-spawn on the one profile');
  assert.equal(commands.issued.length, 1);
});

test('a press during the foreground wait ends an open window instead of waiting', async () => {
  const commands = hiddenPage(), kiosk = fakeKiosk(commands), calls = [];
  let open = null;
  const { buttons } = make({ commands, kiosk, visibleWaitMs: 60, window: () => open });
  const first = buttons.press({ key: 'F13' });
  await new Promise(r => setImmediate(r));
  open = { press: () => calls.push('press'), cancel: () => calls.push('cancel') };
  assert.equal((await buttons.press({ key: 'F13' })).dispatch, 'end');
  open = null;
  await first;
  assert.deepEqual(calls, ['press']);
});

test('a cancel during the foreground wait aborts it: no relaunch, no nonce, the press resolves at once', async () => {
  const commands = hiddenPage(), kiosk = fakeKiosk(commands);
  const { buttons } = make({ commands, kiosk, visibleWaitMs: 5000 });
  const started = Date.now();
  const first = buttons.press({ key: 'F13' });
  await new Promise(r => setImmediate(r));
  assert.equal(commands.waits, 1, 'the press is waiting for the page');
  assert.equal((await buttons.press({ key: 'F14' })).dispatch, 'cancel');
  assert.equal((await first).dispatch, 'cancelled');
  assert.ok(Date.now() - started < 1000, 'the cancelled press does not sit out the wait');
  commands.release(true);
  await new Promise(r => setImmediate(r));
  assert.equal(kiosk.relaunches.length, 0);
  assert.equal(commands.issued.length, 0);
  assert.equal(commands.pushed.length, 0);
  assert.equal((await buttons.press({ key: 'F14' })).dispatch, 'none', 'nothing is left in flight');
});

test('a cancel while the hidden page is still being foregrounded aborts before the wait', async () => {
  const commands = fakeCommands({ connected: true, visible: false });
  let found;
  const kiosk = { foregrounds: 0, relaunches: [], foreground: () => { kiosk.foregrounds++; return new Promise(r => { found = r; }); },
    relaunch: async open => { kiosk.relaunches.push(open); return {}; } };
  const { buttons } = make({ commands, kiosk });
  const first = buttons.press({ key: 'F13' });
  await new Promise(r => setImmediate(r));
  assert.equal((await buttons.press({ key: 'F14' })).dispatch, 'cancel');
  found(true);
  assert.equal((await first).dispatch, 'cancelled');
  assert.equal(kiosk.relaunches.length + commands.issued.length + commands.pushed.length, 0);
});
