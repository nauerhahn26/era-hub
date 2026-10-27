// The Chat page's held-question audio over one WebSocket per session (real-time
// chat spec 2026-10-27 §3.1): the same loopback, same-origin and session checks
// as the HTTP routes; binary frames are a 8-byte {generation, seq} header and
// PCM16; frames of another generation or outside a hold never reach the
// recognizer; a per-turn budget replaces the per-POST caps; finish waits for
// the frames the page says it sent. A fake runtime child and a Node client.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once, EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createChatApi } = require('../chat-api.js');
const { connectWebSocket } = require('../chat-ws.js');

function runtime() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.messages = [];
  child.stdin = new Writable({ write(chunk, _, next) { for (const line of String(chunk).split('\n')) if (line) child.messages.push(JSON.parse(line)); next(); } });
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
}
const configured = { ERA_CHAT_RUNTIME: 'runtime-command', ERA_CHAT_RUNTIME_ARGS: '[]' };
async function service(t, options = {}) {
  const children = [];
  const api = createChatApi({ env: configured, spawn: () => { const child = runtime(); children.push(child); return child; }, ...options });
  const server = http.createServer((req, res) => { if (!api.handle(req, res)) res.writeHead(404).end(); });
  server.on('upgrade', (req, socket, head) => { if (!api.upgrade(req, socket, head)) socket.destroy(); });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  const port = server.address().port, origin = `http://localhost:${port}`, base = origin + '/chat/api';
  const sockets = [];
  t.after(async () => { for (const ws of sockets) ws.terminate(); api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = (url, body, method = 'POST') => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function session() {
    const { id } = await (await request('/sessions')).json();
    children.at(-1).stdout.write(JSON.stringify({ type: 'ready', capabilities: { remoteFinal: true } }) + '\n');
    return id;
  }
  async function socket(id, headers = { Origin: origin }) {
    const ws = await connectWebSocket(`ws://localhost:${port}/chat/api/sessions/${id}/audio`, { headers });
    sockets.push(ws); return ws;
  }
  async function events(id) {
    const response = await fetch(`${base}/sessions/${id}/events`);
    const reader = response.body.getReader(), decoder = new TextDecoder(), seen = [];
    let pending = '';
    (async () => { try { while (true) { const { value, done } = await reader.read(); if (done) break; pending += decoder.decode(value, { stream: true });
      let cut; while ((cut = pending.indexOf('\n\n')) >= 0) { const block = pending.slice(0, cut); pending = pending.slice(cut + 2); if (block.startsWith('data: ')) seen.push(JSON.parse(block.slice(6))); } } } catch {} })();
    t.after(() => reader.cancel().catch(() => {}));
    return seen;
  }
  return { api, port, origin, base, children, request, session, socket, events };
}
const frame = (generation, seq, bytes = 3200, fill = 1) => { const b = Buffer.alloc(8 + bytes, fill); b.writeUInt32LE(generation, 0); b.writeUInt32LE(seq, 4); return b; };
const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)); } };
const audio = child => child.messages.filter(message => message.type === 'audio');

test('the ready event advertises the audio socket', async t => {
  const s = await service(t);
  const id = await s.session(); const seen = await s.events(id);
  await until(() => seen.some(event => event.type === 'ready'));
  assert.equal(seen.find(event => event.type === 'ready').capabilities.audioSocket, true);
});

test('upgrades are refused for another origin, a cross-site fetch, an unknown session and a second socket', async t => {
  const s = await service(t);
  const id = await s.session();
  await assert.rejects(s.socket(id, { Origin: 'https://elsewhere.example' }), error => error.status === 403);
  await assert.rejects(s.socket(id, { Origin: s.origin, 'Sec-Fetch-Site': 'cross-site' }), error => error.status === 403);
  await assert.rejects(s.socket('0f8fad5b-d9cb-469f-a165-70867728950e', { Origin: s.origin }), error => error.status === 404);
  await assert.rejects(connectWebSocket(`ws://localhost:${s.port}/chat/api/sessions/${id}/elsewhere`, { headers: { Origin: s.origin } }), error => error.status === 404);
  const first = await s.socket(id);
  await assert.rejects(s.socket(id), error => error.status === 409);
  first.close();
});

test('a socket from a non-loopback address is refused before any session state changes', async t => {
  const s = await service(t);
  const id = await s.session();
  const socket = new net.Socket(); let written = '';
  socket.write = text => { written += text; return true; }; socket.end = text => { written += text || ''; }; socket.destroy = () => {};
  Object.defineProperty(socket, 'remoteAddress', { value: '192.0.2.10' });
  const req = { method: 'GET', url: `/chat/api/sessions/${id}/audio`, socket, headers: { host: 'localhost', upgrade: 'websocket', connection: 'Upgrade',
    'sec-websocket-version': '13', 'sec-websocket-key': Buffer.alloc(16, 1).toString('base64') } };
  assert.equal(s.api.upgrade(req, socket, Buffer.alloc(0)), true);
  await until(() => written.length > 0);
  assert.match(written, /^HTTP\/1\.1 403 /);
});

test('frames reach the recognizer in order only for the current generation and only during a hold', async t => {
  const s = await service(t);
  const id = await s.session(); const ws = await s.socket(id); const child = s.children[0];
  ws.send(frame(0, 0)); // no hold yet: dropped, never forwarded
  const { generation } = await (await s.request(`/sessions/${id}/control`, { type: 'ask' })).json();
  ws.send(frame(generation, 1, 3200, 1)); ws.send(frame(generation - 1, 2, 3200, 9)); ws.send(frame(generation, 3, 1600, 2)); ws.send(frame(generation, 4, 640, 3));
  await until(() => audio(child).length === 3);
  const bytes = audio(child).map(message => Buffer.from(message.pcm, 'base64'));
  assert.deepEqual(bytes.map(b => [b.length, b[0]]), [[3200, 1], [1600, 2], [640, 3]]);
  assert.ok(audio(child).every(message => message.generation === generation));
  await s.request(`/sessions/${id}/control`, { type: 'pause' });
  ws.send(frame(generation + 1, 5));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(audio(child).length, 3, 'paused: nothing is forwarded');
});

test('a sequence gap or a malformed frame closes the socket (1008) and nothing after it is forwarded', async t => {
  const s = await service(t);
  const id = await s.session(); const ws = await s.socket(id); const child = s.children[0];
  const { generation } = await (await s.request(`/sessions/${id}/control`, { type: 'ask' })).json();
  const closed = once(ws, 'close');
  ws.send(frame(generation, 0)); ws.send(frame(generation, 2)); ws.send(frame(generation, 3));
  const [{ code, reason }] = await closed;
  assert.equal(code, 1008); assert.equal(reason, 'audio-sequence');
  assert.equal(audio(child).length, 1);
  assert.equal(child.messages.at(-1).type, 'cancel', 'a broken socket mid-hold never leaves a turn to submit');
  const second = await s.socket(id), again = once(second, 'close');
  second.send(Buffer.from([1, 2, 3]));
  assert.equal((await again)[0].code, 1008);
  const third = await s.socket(id), text = once(third, 'close');
  third.send('{"type":"audio"}');
  assert.equal((await text)[0].code, 1003);
});

test('the per-turn budget stops the hold with an audio-limit event instead of per-POST caps', async t => {
  const s = await service(t, { limits: { turnBytes: 8000 } });
  const id = await s.session(); const seen = await s.events(id); const ws = await s.socket(id); const child = s.children[0];
  const { generation } = await (await s.request(`/sessions/${id}/control`, { type: 'ask' })).json();
  for (let seq = 0; seq < 4; seq++) ws.send(frame(generation, seq, 3200));
  await until(() => seen.some(event => event.type === 'error'));
  assert.deepEqual(seen.filter(event => event.type === 'error').map(event => event.error), ['audio-limit']);
  assert.equal(audio(child).length, 2);
  assert.equal(child.messages.at(-1).type, 'cancel');
  // The next hold has a fresh budget.
  const next = (await (await s.request(`/sessions/${id}/control`, { type: 'ask' })).json()).generation;
  ws.send(frame(next, 4, 3200));
  await until(() => audio(child).length === 3);
});

test('finish waits for the frames the page says it sent before the recognizer hears finish', async t => {
  const s = await service(t);
  const id = await s.session(); const ws = await s.socket(id); const child = s.children[0];
  const { generation } = await (await s.request(`/sessions/${id}/control`, { type: 'ask' })).json();
  ws.send(frame(generation, 0));
  const finishing = s.request(`/sessions/${id}/control`, { type: 'finish', seq: 3 });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(child.messages.some(message => message.type === 'finish'), false, 'finish is held until frame 3 arrives');
  ws.send(frame(generation, 1)); ws.send(frame(generation, 2));
  assert.equal((await finishing).status, 200);
  assert.deepEqual(child.messages.map(message => message.type), ['ask', 'audio', 'audio', 'audio', 'finish']);
});

test('finish gives up on frames that never come: the turn is cancelled, never submitted short', async t => {
  const s = await service(t, { limits: { drainMs: 80 } });
  const id = await s.session(); const ws = await s.socket(id); const child = s.children[0];
  const { generation } = await (await s.request(`/sessions/${id}/control`, { type: 'ask' })).json();
  ws.send(frame(generation, 0));
  const response = await s.request(`/sessions/${id}/control`, { type: 'finish', seq: 5 });
  assert.equal(response.status, 409); assert.equal((await response.json()).error, 'audio-sequence');
  assert.equal(child.messages.some(message => message.type === 'finish'), false);
  assert.equal(child.messages.at(-1).type, 'cancel');
});

test('ending the session closes its socket; the page closing the socket mid-hold cancels the turn', async t => {
  const s = await service(t);
  const id = await s.session(); const ws = await s.socket(id); const child = s.children[0];
  const { generation } = await (await s.request(`/sessions/${id}/control`, { type: 'ask' })).json();
  ws.send(frame(generation, 0));
  await until(() => audio(child).length === 1);
  ws.close(1001, 'hidden');
  await until(() => child.messages.at(-1).type === 'cancel');
  const second = await s.socket(id), closed = once(second, 'close');
  assert.equal((await s.request(`/sessions/${id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await closed)[0].code, 1001);
});

test('the real hub answers the audio socket upgrade through the Chat module and refuses every other upgrade', { timeout: 60000 }, async t => {
  const { spawn } = await import('node:child_process');
  const fsp = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const hub = new URL('../', import.meta.url).pathname;
  const data = await fsp.mkdtemp(path.join(os.tmpdir(), 'era-chat-socket-hub-'));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [path.join(hub, 'server.js'), String(port)], { cwd: hub, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, ERA_DATA_DIR: data, ERA_BIND: '127.0.0.1', ERA_DEVICE_ID: 'socket-hub', ERA_CHAT_CONFIG_DISABLED: '1', ERA_POOL_DIR: '',
      // An idle stand-in recognizer: the session exists, nothing is recognized.
      ERA_CHAT_RUNTIME: process.execPath, ERA_CHAT_RUNTIME_ARGS: JSON.stringify(['-e', 'process.stdin.resume()']) } });
  t.after(async () => { child.kill('SIGKILL'); await fsp.rm(data, { recursive: true, force: true }); });
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/version`)).ok; } catch { await new Promise(r => setTimeout(r, 100)); } }
  assert.ok(up, 'the hub came up');
  const origin = `http://127.0.0.1:${port}`;
  await assert.rejects(connectWebSocket(`ws://127.0.0.1:${port}/chat/api/sessions/0f8fad5b-d9cb-469f-a165-70867728950e/audio`, { headers: { Origin: origin } }),
    error => error.code === 'ws-handshake' && error.status === 404, 'answered by the Chat module');
  const { id } = await (await fetch(`${origin}/chat/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const ws = await connectWebSocket(`ws://127.0.0.1:${port}/chat/api/sessions/${id}/audio`, { headers: { Origin: origin } });
  assert.equal(ws.readyState, 'open', 'the hub upgrades a live session');
  const closed = once(ws, 'close');
  await fetch(`${origin}/chat/api/sessions/${id}`, { method: 'DELETE' });
  assert.equal((await closed)[0].code, 1001);
  await assert.rejects(connectWebSocket(`ws://127.0.0.1:${port}/elsewhere`, { headers: { Origin: origin } }), error => error.code !== 'ws-handshake' || error.status !== 101);
});

test('no recognizer child, built-in or external, receives the streaming service credentials', async t => {
  const seen = [];
  const env = { ...configured, ERA_CHAT_STREAM_PROTOCOL: 'ws-listen-query', ERA_CHAT_STREAM_URL: 'wss://stream.invalid/', ERA_CHAT_STREAM_MODEL: 'm',
    ERA_CHAT_STREAM_TOKEN: 'stream-private', ERA_CHAT_STREAM_FALLBACK_TOKEN: 'fallback-private', ERA_CHAT_STREAM_KEYTERMS: '/private/keyterms.json' };
  const api = createChatApi({ env, spawn: (command, args, options) => { seen.push(options.env); return runtime(); }, streamConnect: () => new Promise(() => {}) });
  t.after(() => api.close());
  const server = http.createServer((req, res) => { if (!api.handle(req, res)) res.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  assert.equal((await fetch(`http://localhost:${server.address().port}/chat/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 201);
  assert.equal(seen.length, 1);
  assert.ok(!Object.keys(seen[0]).some(key => key.startsWith('ERA_CHAT_STREAM_')), Object.keys(seen[0]).join(','));
});
