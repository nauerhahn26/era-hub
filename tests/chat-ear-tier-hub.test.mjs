// The ear's two tiers through the hub's Chat module (stable frame design
// 2026-10-28 §10). With ERA_CHAT_STREAM_EAR_MODEL set the ear listens on that
// cheaper stream profile and keeps the last 10 s of its audio; a wake opens the
// main (engagement) stream, replays the audio from 1.5 s before the wake
// utterance began, and forwards live frames; the engagement stream seals the
// questions until chatEngageMs passes without a wake, when the ear tier
// resumes alone. Unset, the ear is the main stream exactly as before. Fake
// services on loopback only; ephemeral ports; a fake clock where time matters.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createChatApi } = require('../chat-api.js');
const { acceptWebSocket, connectWebSocket } = require('../chat-ws.js');

const until = async (check, ms = 4000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)); } };
const pause = ms => new Promise(r => setTimeout(r, ms));
const turn = (text, { end = false, order = 0 } = {}) => ({ type: 'Turn', turn_order: order, end_of_turn: end, turn_is_formatted: end, transcript: text });
// 100 ms of PCM16 at 16 kHz: a tone (energetic) or zeros (quiet).
const TONE = (() => { const b = Buffer.alloc(3200); for (let i = 0; i < 1600; i++) b.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / 16000) * 1200), i * 2); return b; })();
const QUIET = Buffer.alloc(3200);

// The turn-streaming fake service, scripted by frame count: `script` maps a
// frame number to the messages sent when that frame arrives.
// `onTerminate` messages are sent when Terminate arrives, before Termination
// (the final words of the utterance in flight); `silent` never answers it.
async function turnsService(t, script = {}, { onTerminate = [], silent = false } = {}) {
  const connections = [];
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    const ws = acceptWebSocket(req, socket, head);
    const conn = { frames: 0, texts: [], closed: false, ws };
    connections.push(conn);
    ws.send(JSON.stringify({ type: 'Begin' }));
    ws.on('message', (data, binary) => {
      if (binary) { conn.frames++; for (const message of script[conn.frames] || []) ws.send(JSON.stringify(message)); return; }
      const value = JSON.parse(data); conn.texts.push(value.type);
      if (value.type === 'Terminate' && !silent) { for (const message of onTerminate) ws.send(JSON.stringify(message)); ws.send(JSON.stringify({ type: 'Termination' })); setTimeout(() => ws.close(1000), 5); }
    });
    ws.on('close', () => { conn.closed = true; });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const c of connections) c.ws.terminate(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  return { url: `ws://127.0.0.1:${server.address().port}/v3/ws`, connections };
}

function runtime() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.messages = [];
  child.stdin = new Writable({ write(chunk, _, done) { for (const line of String(chunk).split('\n').filter(Boolean)) child.messages.push(JSON.parse(line)); done(); } });
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 0)); };
  setTimeout(() => child.stdout.write(JSON.stringify({ type: 'ready', capabilities: { remoteFinal: true } }) + '\n'), 5);
  return child;
}

async function hub(t, { service, limits = {}, env = {}, fetch: fetcher, name, clock, extra = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-ear-tier-hub-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const streamEnv = service ? { ERA_CHAT_STREAM_PROTOCOL: 'ws-streaming-turns', ERA_CHAT_STREAM_URL: service.url, ERA_CHAT_STREAM_MODEL: 'stream-model',
    ERA_CHAT_STREAM_TOKEN: 'stream-secret-token', ERA_CHAT_STREAM_BILLING: 'connection' } : {};
  const children = [];
  const api = createChatApi({ env: { ERA_CHAT_RUNTIME: 'scripted', ERA_CHAT_RUNTIME_ARGS: '[]', ERA_CHAT_SPECULATE_MS: '0', ...streamEnv, ...env }, limits,
    spawn: () => { const child = runtime(); children.push(child); return child; }, ...(fetcher ? { fetch: fetcher } : {}), ...(name ? { name } : {}), ...(clock ? { clock } : {}), ...extra });
  const server = http.createServer((req, res) => { if (!api.handle(req, res)) res.writeHead(404).end(); });
  server.on('upgrade', (req, socket, head) => { if (!api.upgrade(req, socket, head)) socket.destroy(); });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  const port = server.address().port, origin = `http://localhost:${port}`, base = origin + '/chat/api';
  const sockets = [];
  t.after(async () => { for (const ws of sockets) ws.terminate(); api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = (url, body, method = 'POST') => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function session() {
    const { id } = await (await request('/sessions')).json();
    const response = await fetch(`${base}/sessions/${id}/events`), reader = response.body.getReader(), decoder = new TextDecoder(), seen = [];
    let pending = '';
    (async () => { try { while (true) { const { value, done } = await reader.read(); if (done) break; pending += decoder.decode(value, { stream: true });
      let cut; while ((cut = pending.indexOf('\n\n')) >= 0) { const block = pending.slice(0, cut); pending = pending.slice(cut + 2); if (block.startsWith('data: ')) seen.push(JSON.parse(block.slice(6))); } } } catch {} })();
    t.after(() => reader.cancel().catch(() => {}));
    const ws = await connectWebSocket(`ws://localhost:${port}/chat/api/sessions/${id}/audio`, { headers: { Origin: origin } });
    sockets.push(ws);
    let seq = 0;
    const s = { id, seen, ws, child: children.at(-1),
      async open(extra = {}) { const r = await request(`/sessions/${id}/control`, { type: 'window', ...extra }); const body = await r.json(); if (r.ok) s.generation = body.generation; return { status: r.status, ...body }; },
      frame(pcm = TONE) { const b = Buffer.alloc(8 + pcm.length); b.writeUInt32LE(s.generation, 0); b.writeUInt32LE(seq++, 4); pcm.copy(b, 8); ws.send(b); },
      async frames(n, pcm = TONE, gap = 4) { for (let i = 0; i < n; i++) { s.frame(pcm); await pause(gap); } },
      control(type, extra = {}) { return request(`/sessions/${id}/control`, { type, ...extra }); },
      sent: () => seq,
      events: type => seen.filter(event => event.type === type) };
    await until(() => seen.some(e => e.type === 'ready'));
    return s;
  }
  return { api, request, session, children, base };
}



const ENDED = (text, order = 0) => turn(text, { end: true, order });
// A frame whose every sample is its index: the service can tell which frames it got, in order.
const pcmOf = i => { const b = Buffer.alloc(3200); for (let k = 0; k < 1600; k++) b.writeInt16LE(i, k * 2); return b; };

// One fake service for both profiles: each connection is told apart by its
// speech_model and runs that profile's script (frame count -> messages).
async function tieredService(t, scripts = {}, { onTerminate = [] } = {}) {
  const connections = [];
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    const ws = acceptWebSocket(req, socket, head);
    const model = new URL(req.url, 'http://x').searchParams.get('speech_model');
    const conn = { model, frames: 0, values: [], texts: [], closed: false, ws };
    connections.push(conn);
    ws.send(JSON.stringify({ type: 'Begin' }));
    ws.on('message', (data, binary) => {
      if (binary) { conn.frames++; conn.values.push(data.readInt16LE(0)); for (const message of (scripts[model] || {})[conn.frames] || []) ws.send(JSON.stringify(message)); return; }
      const value = JSON.parse(data); conn.texts.push(value.type);
      if (value.type === 'Terminate') { for (const message of onTerminate) ws.send(JSON.stringify(message)); ws.send(JSON.stringify({ type: 'Termination' })); setTimeout(() => ws.close(1000), 5); }
    });
    ws.on('close', () => { conn.closed = true; });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const c of connections) c.ws.terminate(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  return { url: `ws://127.0.0.1:${server.address().port}/v3/ws`, connections, of: model => connections.filter(c => c.model === model) };
}
const EAR_ENV = { ERA_CHAT_STREAM_EAR_MODEL: 'ear-model' };
// Frames 1..n, 100 ms of fake time each, each waited for at the service.
async function play(s, service, clock, from, to) {
  for (let i = from; i <= to; i++) {
    clock.now += 100; s.frame(pcmOf(i));
    await until(() => service.connections.some(c => c.values.at(-1) === i), 2000).catch(() => {});
    await pause(4);
  }
}

test('config: earTier is "ear" with an ear profile and "main" without', async t => {
  const service = await tieredService(t);
  const tiered = await hub(t, { service, env: EAR_ENV });
  assert.equal((await (await fetch(tiered.base + '/config')).json()).runtime.capabilities.earTier, 'ear');
  const plain = await hub(t, { service });
  assert.equal((await (await fetch(plain.base + '/config')).json()).runtime.capabilities.earTier, 'main');
  assert.ok(!JSON.stringify(await (await fetch(tiered.base + '/config')).json()).includes('ear-model'), 'the model id stays private');
});

test('a wake heard on the ear tier opens the main stream, replays the audio from 1.5 s before the wake, then live frames; the main stream seals the question', async t => {
  const clock = { now: 7000000 };
  const service = await tieredService(t, { 'ear-model': { 50: [turn('ellie what')], 55: [ENDED('ellie what do you want')] },
    'stream-model': { 21: [ENDED('Ellie, what do you want for lunch')] } });
  const h = await hub(t, { service, env: EAR_ENV, clock: () => clock.now, limits: { windowTickMs: 10 } });
  const s = await h.session();
  const opened = await s.open({ ear: true });
  assert.equal(opened.status, 200);
  await until(() => s.events('ear').length === 1);
  assert.equal(s.events('ear')[0].tier, 'ear');
  await play(s, service, clock, 1, 55);
  await until(() => s.events('ear').some(e => e.state === 'tier'));
  assert.deepEqual(s.events('ear').filter(e => e.state === 'tier').map(e => e.tier), ['main']);
  assert.equal(s.events('utterance-sealed').length, 0, 'the ear tier only wakes the main stream');
  await play(s, service, clock, 56, 60);
  await until(() => s.events('utterance-sealed').length === 1);
  assert.deepEqual([s.events('utterance-sealed')[0].text, s.events('utterance-sealed')[0].ear], ['what do you want for lunch', true]);
  await until(() => s.events('batch-sealed').length === 1);
  const ear = service.of('ear-model'), main = service.of('stream-model').at(-1);
  assert.deepEqual(ear[0].values, Array.from({ length: 55 }, (_, i) => i + 1), 'the ear tier heard every frame until the wake');
  await until(() => ear[0].closed, 2000);
  // Replay: from 1.5 s before the wake utterance's first words (frame 50 at 5.0 s: from 3.5 s, frame 35), in order, then live.
  assert.deepEqual(main.values.slice(0, 26), Array.from({ length: 26 }, (_, i) => i + 35));
});

test('the replay is at most the last 10 s', async t => {
  const clock = { now: 7000000 };
  // One long utterance, its words growing every second from frame 1, ended at frame 150 (15 s).
  const words = { 150: [ENDED('ellie are you there')] };
  for (let k = 0; k < 15; k++) words[1 + 10 * k] = [turn('ellie ' + 'and '.repeat(k))];
  const service = await tieredService(t, { 'ear-model': words });
  const h = await hub(t, { service, env: EAR_ENV, clock: () => clock.now, limits: { windowTickMs: 10 } });
  const s = await h.session();
  await s.open({ ear: true });
  await play(s, service, clock, 1, 150);
  await until(() => service.of('stream-model').some(c => c.values.length >= 100));
  const main = service.of('stream-model').at(-1);
  assert.deepEqual(main.values.slice(0, 101), Array.from({ length: 101 }, (_, i) => i + 50), 'frames 50..150: ten seconds back from the wake');
});

test('two minutes without a wake on the main stream (chatEngageMs) and the ear tier resumes alone; a wake there engages again', async t => {
  const clock = { now: 7000000 };
  const service = await tieredService(t, { 'ear-model': { 2: [ENDED('Ellie, is it time')] }, 'stream-model': { 3: [ENDED('Ellie, is it time to go')] } });
  const h = await hub(t, { service, env: EAR_ENV, clock: () => clock.now, limits: { windowTickMs: 10 }, extra: { engageMs: () => 30000 } });
  const s = await h.session();
  await s.open({ ear: true });
  await play(s, service, clock, 1, 2);
  await until(() => s.events('ear').some(e => e.state === 'tier'));
  await play(s, service, clock, 3, 4);
  await until(() => s.events('utterance-sealed').length === 1);
  const tiers = () => s.events('ear').filter(e => e.state === 'tier').map(e => e.tier);
  clock.now += 29000; await pause(60);
  assert.deepEqual(tiers(), ['main'], 'the wake restarted the engagement clock');
  clock.now += 1500; await until(() => tiers().length === 2);
  assert.deepEqual(tiers(), ['main', 'ear']);
  await until(() => service.of('ear-model').length === 2);
  await until(() => service.of('stream-model').every(c => c.closed), 2000);
  await play(s, service, clock, 5, 6);
  await until(() => tiers().length === 3);
  assert.deepEqual(tiers(), ['main', 'ear', 'main']);
});

test('a hold during engagement uses the main stream and the ear resumes engaged', async t => {
  const clock = { now: 7000000 };
  const service = await tieredService(t, { 'ear-model': { 2: [ENDED('Ellie?')] } }, { onTerminate: [ENDED('would you like a story')] });
  const h = await hub(t, { service, env: EAR_ENV, clock: () => clock.now, limits: { windowTickMs: 10 } });
  const s = await h.session();
  await s.open({ ear: true });
  await play(s, service, clock, 1, 2);
  await until(() => s.events('ear').some(e => e.state === 'tier'));
  const mains = service.of('stream-model').length;
  s.generation = (await (await s.control('ask')).json()).generation;
  await until(() => s.events('ear').some(e => e.reason === 'hold'));
  s.frame(pcmOf(900));
  assert.equal((await s.control('finish', { seq: s.sent() })).status, 200);
  await until(() => s.events('final').length === 1);
  assert.equal(s.events('final')[0].text, 'would you like a story');
  assert.ok(service.of('stream-model').slice(mains - 1).some(c => c.values.includes(900)), 'the hold went to the main stream');
  assert.ok(!service.of('ear-model').some(c => c.values.includes(900)), 'never to the ear tier');
  await until(() => s.events('ear').filter(e => e.state === 'listening').length === 2);
  assert.equal(s.events('ear').filter(e => e.state === 'listening')[1].tier, 'main', 'resumed engaged');
});

test('without an ear profile the ear is the main stream exactly as before: no tier events, no replay', async t => {
  const clock = { now: 7000000 };
  const service = await tieredService(t, { 'stream-model': { 2: [ENDED('Ellie, do you want tea')] } });
  const h = await hub(t, { service, clock: () => clock.now, limits: { windowTickMs: 10 } });
  const s = await h.session();
  await s.open({ ear: true });
  await play(s, service, clock, 1, 4);
  await until(() => s.events('utterance-sealed').length === 1);
  assert.equal(s.events('utterance-sealed')[0].text, 'do you want tea');
  assert.equal(s.events('ear').filter(e => e.state === 'tier').length, 0);
  assert.equal(service.of('ear-model').length, 0);
  assert.deepEqual(service.of('stream-model').at(-1).values, [1, 2, 3, 4]);
});

test('server.js reads the engagement time from the device settings', async () => {
  const source = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /engageMs: \(\) => chatWake\(DATA\)\.chatEngageMs/);
});
