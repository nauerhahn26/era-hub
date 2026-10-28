// The Chat page's command stream (button press to ask, design 2026-10-27 §4.2;
// plan T1.2). The page opens GET /chat/api/commands the moment it loads, before
// any session exists, and the hub pushes `ask`, `end` and `cancel` on it. One
// subscriber: a newer connection replaces the older. A relaunched kiosk opens
// /chat/?ask=<nonce>; the page connects with that nonce and the hub replays the
// press as `ask` exactly once. The page reports its visibility so a hidden
// page is foregrounded before a push. Loopback and same-origin only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createChatApi } = require('../chat-api.js');

const pause = ms => new Promise(r => setTimeout(r, ms));
const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await pause(5); } };

async function service(t, options = {}) {
  const api = createChatApi({ env: {}, spawn: () => { throw new Error('no runtime here'); }, ...options });
  const server = http.createServer((req, res) => { if (!api.handle(req, res)) res.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  const origin = `http://localhost:${server.address().port}`, base = origin + '/chat/api';
  const readers = [];
  t.after(async () => { for (const r of readers) await r.cancel().catch(() => {}); api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  // One command-stream connection: its raw text, its parsed events and whether it ended.
  async function connect(query = '') {
    const response = await fetch(base + '/commands' + query);
    const stream = { status: response.status, type: response.headers.get('content-type'), raw: '', events: [], ended: false };
    if (response.status !== 200) { await response.body?.cancel(); return stream; }
    const reader = response.body.getReader(), decoder = new TextDecoder(); readers.push(reader);
    stream.close = () => reader.cancel().catch(() => {});
    (async () => { let pending = ''; try { while (true) { const { value, done } = await reader.read(); if (done) break; const text = decoder.decode(value, { stream: true });
      stream.raw += text; pending += text;
      let cut; while ((cut = pending.indexOf('\n\n')) >= 0) { const block = pending.slice(0, cut); pending = pending.slice(cut + 2); if (block.startsWith('data: ')) stream.events.push(JSON.parse(block.slice(6))); } } } catch {} stream.ended = true; })();
    await until(() => stream.raw.includes(': connected'));
    return stream;
  }
  const visibility = body => fetch(base + '/commands/visibility', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { api, base, origin, connect, visibility };
}
const nonPing = stream => stream.events.filter(e => e.type !== 'ping');

test('the page connects before any session; pushes arrive in order; nothing is pushed with no page', async t => {
  const s = await service(t);
  assert.equal(s.api.commands.push({ type: 'ask', pressAt: 1, key: 'F13' }), false, 'nobody listening');
  assert.deepEqual(s.api.commands.state(), { connected: false, visible: null });
  const page = await s.connect();
  assert.equal(page.status, 200); assert.match(page.type, /^text\/event-stream/);
  assert.equal(s.api.commands.state().connected, true);
  assert.equal(s.api.commands.push({ type: 'ask', pressAt: 5, key: 'F13' }), true);
  s.api.commands.push({ type: 'end' }); s.api.commands.push({ type: 'cancel' });
  await until(() => nonPing(page).length === 3);
  assert.deepEqual(nonPing(page), [{ type: 'ask', pressAt: 5, key: 'F13' }, { type: 'end' }, { type: 'cancel' }]);
  page.close();
  await until(() => !s.api.commands.state().connected);
});

test('a newer connection replaces the older, which is told and ended', async t => {
  const s = await service(t);
  const first = await s.connect(), second = await s.connect();
  await until(() => first.ended);
  assert.deepEqual(nonPing(first), [{ type: 'replaced' }]);
  s.api.commands.push({ type: 'end' });
  await until(() => nonPing(second).length === 1);
  assert.deepEqual(nonPing(second), [{ type: 'end' }]);
  assert.equal(s.api.commands.state().connected, true, 'the old one closing does not disconnect the new one');
});

test('a nonce is 16 hex characters, replayed as ask once at connect, then spent', async t => {
  const s = await service(t);
  const nonce = s.api.commands.issue({ pressAt: 42, key: 'Ctrl+Alt+F9' });
  assert.match(nonce, /^[0-9a-f]{16}$/);
  assert.equal(s.api.commands.pending(nonce), true);
  const page = await s.connect('?nonce=' + nonce);
  await until(() => nonPing(page).length === 1);
  assert.deepEqual(nonPing(page), [{ type: 'ask', pressAt: 42, key: 'Ctrl+Alt+F9', nonce }]);
  assert.equal(s.api.commands.pending(nonce), false);
  const again = await s.connect('?nonce=' + nonce); // a reload of /chat/?ask=<nonce>
  await pause(100);
  assert.deepEqual(nonPing(again), [], 'a spent nonce never asks again');
  const stranger = await s.connect('?nonce=' + 'f'.repeat(16));
  await pause(50);
  assert.deepEqual(nonPing(stranger), []);
  assert.notEqual(s.api.commands.issue({ pressAt: 1, key: 'F13' }), s.api.commands.issue({ pressAt: 1, key: 'F13' }));
});

test('a nonce lives 30 s; a revoked nonce never asks', async t => {
  let now = 1000;
  const s = await service(t, { clock: () => now });
  const old = s.api.commands.issue({ pressAt: now, key: 'F13' });
  now += 30001;
  assert.equal(s.api.commands.pending(old), false);
  const late = await s.connect('?nonce=' + old);
  await pause(50);
  assert.deepEqual(nonPing(late), [], 'expired');
  const fresh = s.api.commands.issue({ pressAt: now, key: 'F13' });
  s.api.commands.revoke(fresh);
  const page = await s.connect('?nonce=' + fresh);
  await pause(50);
  assert.deepEqual(nonPing(page), [], 'revoked (a cancel during the relaunch)');
});

test('the page reports its visibility; waitVisible answers at once, on the report, or false at the timeout', async t => {
  const s = await service(t);
  assert.equal((await s.visibility({ visible: true })).status, 409, 'no page connected');
  const page = await s.connect('?visible=0');
  assert.deepEqual(s.api.commands.state(), { connected: true, visible: false });
  assert.equal(await s.api.commands.waitVisible(30), false);
  const waiting = s.api.commands.waitVisible(2000);
  const r = await s.visibility({ visible: true });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
  assert.equal(await waiting, true);
  assert.equal(await s.api.commands.waitVisible(10), true, 'already visible');
  for (const body of [{}, { visible: 'yes' }, { visible: 1 }]) assert.equal((await s.visibility(body)).status, 400, JSON.stringify(body));
  page.close();
  await until(() => !s.api.commands.state().connected);
  assert.equal(s.api.commands.state().visible, null, 'a closed page has no visibility');
  const shown = await s.connect('?visible=1');
  assert.equal(s.api.commands.state().visible, true);
  shown.close();
});

test('a ping keeps the stream alive', async t => {
  const s = await service(t, { limits: { commandPingMs: 30 } });
  const page = await s.connect();
  await until(() => page.events.filter(e => e.type === 'ping').length >= 2);
});

test('a non-loopback peer, another origin or a cross-site fetch cannot open or steer the stream', async t => {
  const s = await service(t);
  for (const url of ['/chat/api/commands', '/chat/api/commands/visibility']) {
    const request = new EventEmitter();
    Object.assign(request, { url, method: url.endsWith('visibility') ? 'POST' : 'GET', socket: { remoteAddress: 'remote.invalid' }, headers: { host: 'localhost' } });
    let status;
    const response = { writeHead(value) { status = value; return this; }, end() {}, setHeader() {} };
    assert.equal(s.api.handle(request, response), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(status, 403, url);
  }
  for (const headers of [{ Origin: 'https://elsewhere.example' }, { 'Sec-Fetch-Site': 'cross-site' }])
    assert.equal((await fetch(s.base + '/commands', { headers })).status, 403, JSON.stringify(headers));
  assert.equal(s.api.commands.state().connected, false);
});

test('the stream outlives a private configuration reload (the API inside is replaced, the page stays connected)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-chat-commands-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chat.env');
  fs.writeFileSync(file, 'ERA_CHAT_SPECULATE_MS=300\n');
  const s = await service(t, { env: {}, configPath: file });
  const page = await s.connect();
  fs.writeFileSync(file, 'ERA_CHAT_SPECULATE_MS=400\n');
  assert.equal((await fetch(s.base + '/config')).status, 200);
  assert.equal(s.api.commands.push({ type: 'end' }), true);
  await until(() => nonPing(page).length === 1);
  assert.equal(page.ended, false);
});
