// The device button listener's keeper in buttons.js (button press to ask,
// design 2026-10-27 §4.1; plan T5.2, T5.3; decisions 4 and 16). The hub
// compiles buttons/EraButtons.cs with Windows' csc when the shipped source
// differs from the one the exe was built from, runs the exe as its own child
// while Chat is on, reads its one registration line into /status.buttons,
// restarts it with backoff 5/15/60/300 s when it exits (the ladder resets after
// 10 minutes alive), stops ours (the child, then by path, never by name) when
// Chat is turned off. It writes no microphone policy (decision 16: the policy
// key is admin-protected and the hub runs unelevated). Unit tests: the clock,
// the compiler, the spawn and the by-path stop are all injected; real files
// in a temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const buttonsModule = require('../buttons.js');
const { createListener, cscArgs, parseRegistration, stopScript, CSC, BACKOFF_MS, HEALTHY_MS } = buttonsModule;
const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = process.env.ERA_TEST_TMP || os.tmpdir();
const ALL = ['F13', 'F14', 'Ctrl+Alt+F9', 'Ctrl+Alt+F10', 'Ctrl+Alt+F11'];
const LINE = JSON.stringify({ registered: ALL, failed: [] }) + '\r\n';
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const settle = () => new Promise((r) => setImmediate(r));

function harness({ platform = 'win32', chat = true, csc = null, exe = true, source = '// listener v1\n', compileFails = false } = {}) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'era-buttons-keeper-'));
  fs.writeFileSync(path.join(dir, 'EraButtons.cs'), source);
  if (exe) { fs.writeFileSync(path.join(dir, 'EraButtons.exe'), 'built from ' + source); fs.writeFileSync(path.join(dir, 'EraButtons.exe.src-sha256'), sha(source) + '\n'); }
  const h = { t: 1_000_000, chat, dir, children: [], runs: [], stops: [], logs: [] };
  h.listener = createListener({
    dir, port: 8377, hubPid: 4242, platform, csc,
    enabled: () => h.chat, now: () => h.t, log: (m) => h.logs.push(m),
    run: async (cmd, args) => {
      h.runs.push([cmd, ...args]);
      if (compileFails) return { status: 1, stdout: 'EraButtons.cs(1,1): error CS1002: ; expected', stderr: '' };
      const out = args.find((a) => a.startsWith('/out:')).slice(5);
      fs.writeFileSync(out, 'built from ' + fs.readFileSync(args[args.length - 1], 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    },
    spawn: (cmd, args, opts) => {
      const c = new EventEmitter();
      c.cmd = cmd; c.args = args; c.opts = opts; c.pid = 9000 + h.children.length; c.killed = false;
      c.stdout = new EventEmitter();
      c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null, 'SIGTERM')); return true; };
      h.children.push(c);
      return c;
    },
    stopByPath: (file) => { h.stops.push(file); },
  });
  h.child = () => h.children[h.children.length - 1];
  h.tick = async (dt = 0) => { h.t += dt; await h.listener.tick(); await settle(); };
  h.exit = async (code = 1) => { h.child().emit('exit', code, null); await settle(); };
  return h;
}

test('the constants: csc and its arguments, the backoff ladder, the 10 minute reset', () => {
  assert.equal(CSC, 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe');
  assert.deepEqual(cscArgs('X\\EraButtons.new.exe', 'X\\EraButtons.cs'),
    ['/nologo', '/target:winexe', '/platform:x64', '/out:X\\EraButtons.new.exe', '/r:System.Windows.Forms.dll', 'X\\EraButtons.cs']);
  assert.deepEqual(BACKOFF_MS, [5000, 15000, 60000, 300000]);
  assert.equal(HEALTHY_MS, 10 * 60 * 1000);
});

test('the registration line: two arrays of known key names, anything else is null', () => {
  assert.deepEqual(parseRegistration(LINE), { registered: ALL, failed: [] });
  assert.deepEqual(parseRegistration('{"registered":["F14"],"failed":["F13"]}'), { registered: ['F14'], failed: ['F13'] });
  for (const bad of ['', 'hello', '{}', '{"registered":"F13","failed":[]}', '{"registered":["F12"],"failed":[]}', '[1,2]'])
    assert.equal(parseRegistration(bad), null, bad);
});

test('start: the exe runs as the hub\'s child with port and hub pid, stdout piped, hidden; its line fills keys and state', async () => {
  const h = harness();
  await h.listener.start(); await settle();
  assert.equal(h.children.length, 1);
  const c = h.child();
  assert.equal(c.cmd, path.join(h.dir, 'EraButtons.exe'));
  assert.deepEqual(c.args, ['8377', '4242']);
  assert.deepEqual(c.opts.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(c.opts.windowsHide, true);
  assert.notEqual(c.opts.detached, true, 'a child of the hub, not detached');
  assert.equal(h.listener.status().state, 'starting');
  c.stdout.emit('data', Buffer.from(LINE.slice(0, 20))); c.stdout.emit('data', Buffer.from(LINE.slice(20)));
  const s = h.listener.status();
  assert.equal(s.state, 'running'); assert.equal(s.pid, c.pid);
  assert.deepEqual(s.keys, { registered: ALL, failed: [] });
  assert.equal(s.restarts, 0); assert.equal(s.lastError, null);
  assert.equal(h.runs.filter((r) => r[0] === CSC).length, 0, 'an exe built from this source is not compiled again');
});

test('exits are restarted on the ladder 5, 15, 60, 300, 300 s, never sooner', async () => {
  const h = harness();
  await h.listener.start(); await settle();
  const ladder = [5000, 15000, 60000, 300000, 300000];
  for (let i = 0; i < ladder.length; i++) {
    await h.exit(1);
    const s = h.listener.status();
    assert.equal(s.state, 'restarting'); assert.equal(s.pid, null);
    assert.equal(s.restarts, i + 1); assert.match(s.lastError, /exited \(1\)/);
    const before = h.children.length;
    await h.tick(ladder[i] - 1);
    assert.equal(h.children.length, before, 'not before ' + ladder[i] + ' ms');
    await h.tick(1);
    assert.equal(h.children.length, before + 1, 'restarted at ' + ladder[i] + ' ms');
  }
});

test('ten minutes alive resets the ladder to 5 s; exit 3 says another listener holds the keys', async () => {
  const h = harness();
  await h.listener.start(); await settle();
  await h.exit(1); await h.tick(5000);
  await h.exit(1); await h.tick(15000);
  await h.tick(10 * 60 * 1000);           // alive ten minutes
  await h.exit(3);
  assert.match(h.listener.status().lastError, /another listener holds the keys/);
  const before = h.children.length;
  await h.tick(5000);
  assert.equal(h.children.length, before + 1, 'back to the first rung');
});

test('a spawn error is an exit like any other (counted once)', async () => {
  const h = harness();
  await h.listener.start(); await settle();
  const c = h.child();
  c.emit('error', new Error('spawn EPERM')); c.emit('exit', -4048, null); await settle();
  const s = h.listener.status();
  assert.equal(s.restarts, 1); assert.match(s.lastError, /EPERM/);
});

test('Chat turned off: our child is stopped, then ours by path; nothing restarts until Chat is back', async () => {
  const h = harness();
  await h.listener.start(); await settle();
  h.child().stdout.emit('data', Buffer.from(LINE));
  h.chat = false;
  await h.tick(1000);
  assert.equal(h.child().killed, true, 'our own child, by its handle');
  assert.deepEqual(h.stops, [path.join(h.dir, 'EraButtons.exe')], 'then ours by path');
  const s = h.listener.status();
  assert.equal(s.state, 'off'); assert.equal(s.pid, null); assert.deepEqual(s.keys, { registered: [], failed: [] });
  assert.equal(s.restarts, 0, 'a stop on purpose is not a restart');
  await h.tick(10 * 60 * 1000);
  assert.equal(h.children.length, 1);
  h.chat = true;
  await h.tick(1000);
  assert.equal(h.children.length, 2, 'Chat on again: running again at once');
});

test('Chat off at boot: nothing compiles, nothing runs', async () => {
  const h = harness({ chat: false, exe: false });
  await h.listener.start(); await settle();
  assert.equal(h.children.length, 0); assert.deepEqual(h.runs, []);
  assert.equal(h.listener.status().state, 'off');
});

test('off Windows with no stub compiler: unsupported, nothing compiled or run', async () => {
  const h = harness({ platform: 'linux', exe: false });
  await h.listener.start(); await h.tick(60000);
  assert.deepEqual(h.runs, []); assert.equal(h.children.length, 0);
  assert.deepEqual(h.listener.status(), { state: 'unsupported', pid: null, keys: { registered: [], failed: [] }, restarts: 0, lastError: null });
});

test('a fresh install compiles to EraButtons.new.exe, swaps it in, records the source hash, then runs it', async () => {
  const h = harness({ exe: false });
  const states = [];
  const tick = h.listener.start(); states.push(h.listener.status().state); await tick; await settle();
  assert.equal(states[0], 'compiling');
  const compiles = h.runs.filter((r) => r[0] === CSC);
  assert.deepEqual(compiles, [[CSC, ...cscArgs(path.join(h.dir, 'EraButtons.new.exe'), path.join(h.dir, 'EraButtons.cs'))]]);
  assert.equal(fs.readFileSync(path.join(h.dir, 'EraButtons.exe'), 'utf8'), 'built from // listener v1\n');
  assert.equal(fs.readFileSync(path.join(h.dir, 'EraButtons.exe.src-sha256'), 'utf8').trim(), sha('// listener v1\n'));
  assert.ok(!fs.existsSync(path.join(h.dir, 'EraButtons.new.exe')));
  assert.deepEqual(h.stops, [], 'nothing of ours to stop before the first exe');
  assert.equal(h.children.length, 1);
});

test('a changed source recompiles: ours is stopped by path before the swap', async () => {
  const h = harness();
  fs.writeFileSync(path.join(h.dir, 'EraButtons.cs'), '// listener v2\n');
  await h.listener.start(); await settle();
  assert.deepEqual(h.stops, [path.join(h.dir, 'EraButtons.exe')]);
  assert.equal(fs.readFileSync(path.join(h.dir, 'EraButtons.exe'), 'utf8'), 'built from // listener v2\n');
  assert.equal(fs.readFileSync(path.join(h.dir, 'EraButtons.exe.src-sha256'), 'utf8').trim(), sha('// listener v2\n'));
  assert.ok(h.logs.some((l) => /recompiled from updated source/.test(l)), h.logs.join('\n'));
  assert.equal(h.children.length, 1);
});

test('a failed compile keeps the old exe and its hash, logs once, and the old listener runs', async () => {
  const h = harness({ compileFails: true });
  const exe = fs.readFileSync(path.join(h.dir, 'EraButtons.exe'), 'utf8');
  const hash = fs.readFileSync(path.join(h.dir, 'EraButtons.exe.src-sha256'), 'utf8');
  fs.writeFileSync(path.join(h.dir, 'EraButtons.cs'), '// listener v2 BROKEN\n');
  await h.listener.start(); await settle();
  for (let i = 0; i < 5; i++) await h.tick(5000);
  assert.equal(h.runs.filter((r) => r[0] === CSC).length, 1, 'the same source is not compiled again this boot');
  assert.equal(h.logs.filter((l) => /compile failed/.test(l)).length, 1, h.logs.join('\n'));
  assert.match(h.logs.find((l) => /compile failed/.test(l)), /CS1002/);
  assert.equal(fs.readFileSync(path.join(h.dir, 'EraButtons.exe'), 'utf8'), exe);
  assert.equal(fs.readFileSync(path.join(h.dir, 'EraButtons.exe.src-sha256'), 'utf8'), hash);
  assert.ok(!fs.existsSync(path.join(h.dir, 'EraButtons.new.exe')));
  assert.deepEqual(h.stops, [], 'nothing is stopped for a compile that failed');
  assert.equal(h.children.length, 1, 'the old build still listens');
  assert.match(h.listener.status().lastError, /compile failed: .*CS1002/);
});

test('a failed first compile: no listener, state failed, and it does not retry the same source', async () => {
  const h = harness({ exe: false, compileFails: true });
  await h.listener.start(); await settle();
  for (let i = 0; i < 5; i++) await h.tick(5000);
  const s = h.listener.status();
  assert.equal(s.state, 'failed'); assert.equal(s.pid, null); assert.match(s.lastError, /compile failed/);
  assert.equal(h.children.length, 0);
  assert.equal(h.runs.filter((r) => r[0] === CSC).length, 1);
});

test('one compile at a time: a tick during a compile does not start a second', async () => {
  const h = harness({ exe: false });
  const first = h.listener.start();
  const second = h.listener.tick();
  await Promise.all([first, second]); await settle();
  assert.equal(h.runs.filter((r) => r[0] === CSC).length, 1);
  assert.equal(h.children.length, 1);
});

test('no microphone policy (decision 16): the keeper runs csc and the listener only, never reg.exe, and says nothing of a policy', async () => {
  const h = harness({ exe: false });
  await h.listener.start(); await settle();
  for (let i = 0; i < 3; i++) await h.tick(30000);
  assert.ok(h.runs.length > 0);
  assert.ok(h.runs.every((r) => r[0] === CSC), 'only the compiler runs: ' + JSON.stringify(h.runs));
  assert.ok(!h.runs.some((r) => /reg(\.exe)?$/i.test(path.basename(r[0])) || /Policies/i.test(r.join(' '))));
  assert.ok(!h.logs.some((l) => /policy/i.test(l)), h.logs.join('\n'));
  assert.deepEqual(Object.keys(h.listener.status()).sort(), ['keys', 'lastError', 'pid', 'restarts', 'state']);
  for (const gone of ['micPolicyArgs', 'REG', 'POLICY_RETRY_MS', 'POLICY_KEYS']) assert.equal(buttonsModule[gone], undefined, gone + ' is gone');
  const src = fs.readFileSync(path.join(HUB, 'buttons.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /reg\.exe|AudioCaptureAllowedUrls/i);
});

test('the seam: a stub compiler stands for csc off Windows', async () => {
  const h = harness({ platform: 'linux', exe: false, csc: '/stub/csc' });
  await h.listener.start(); await settle();
  assert.deepEqual(h.runs.map((r) => r[0]), ['/stub/csc']);
  assert.equal(h.children.length, 1);
});

test('the stop by path names our exe by its full path, never a process name alone', () => {
  const script = stopScript('C:\\Users\\sample\\AppData\\Local\\Our Era Comms\\buttons\\EraButtons.exe');
  assert.match(script, /Where-Object \{ \$_\.Path -eq 'C:\\Users\\sample\\AppData\\Local\\Our Era Comms\\buttons\\EraButtons\.exe' \}/);
  assert.match(script, /Stop-Process -Force$/);
  assert.match(stopScript("C:\\it's\\EraButtons.exe"), /'C:\\it''s\\EraButtons\.exe'/, 'a quote in the path is doubled');
  const src = fs.readFileSync(path.join(HUB, 'buttons.js'), 'utf8');
  assert.doesNotMatch(src, /taskkill|\/IM\b|pkill|killall/i);
});
