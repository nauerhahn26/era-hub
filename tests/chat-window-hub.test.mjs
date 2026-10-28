// The button-press listening window through the hub's Chat module (design
// 2026-10-27 §4.4; plan T3.2-T3.4). A `window` control opens one streaming
// turn that is never finalized per utterance: the service socket stays open,
// each utterance that sounds complete is sealed (the service's end of turn, or
// the hub's own energy gate after 1.5 s of quiet), and each seal runs the
// choice request on the WHOLE window text, sealed as `batch-sealed {windowId,
// seq}` (seq 1 first, then replacements). The window closes on a second press,
// a cancel, her pick, 10 s without words or 60 s. Nothing said submits
// nothing. Fake services on loopback only; ephemeral ports.
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
async function turnsService(t, script = {}) {
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
      if (value.type === 'Terminate') { ws.send(JSON.stringify({ type: 'Termination' })); setTimeout(() => ws.close(1000), 5); }
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

async function hub(t, { service, limits = {}, env = {}, fetch: fetcher } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-window-hub-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const streamEnv = service ? { ERA_CHAT_STREAM_PROTOCOL: 'ws-streaming-turns', ERA_CHAT_STREAM_URL: service.url, ERA_CHAT_STREAM_MODEL: 'stream-model',
    ERA_CHAT_STREAM_TOKEN: 'stream-secret-token', ERA_CHAT_STREAM_BILLING: 'connection' } : {};
  const children = [];
  const api = createChatApi({ env: { ERA_CHAT_RUNTIME: 'scripted', ERA_CHAT_RUNTIME_ARGS: '[]', ERA_CHAT_SPECULATE_MS: '0', ...streamEnv, ...env }, limits,
    spawn: () => { const child = runtime(); children.push(child); return child; }, ...(fetcher ? { fetch: fetcher } : {}) });
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
      events: type => seen.filter(event => event.type === type) };
    await until(() => seen.some(e => e.type === 'ready'));
    return s;
  }
  return { api, request, session, children, base };
}

const CHICKEN = { 2: [turn('do you want')], 4: [turn('do you want chicken or fish')], 5: [turn('do you want chicken or fish', { end: true })],
  8: [turn('or pasta', { order: 1 })], 9: [turn('or pasta', { order: 1, end: true })] };

test('/config says whether streaming is set up (nothing private)', async t => {
  const service = await turnsService(t);
  const h = await hub(t, { service });
  const config = await (await fetch(h.base + '/config')).json();
  assert.equal(config.runtime.capabilities.streaming, true);
  assert.ok(!JSON.stringify(config).includes('127.0.0.1'));
  const plain = await hub(t);
  assert.equal((await (await fetch(plain.base + '/config')).json()).runtime.capabilities.streaming, null);
});

test('a window: each end of turn seals an utterance, choices run on the whole window text, the socket stays open', async t => {
  const service = await turnsService(t, CHICKEN);
  const h = await h_(t, { service });
  const s = await h.session();
  await until(() => service.connections.length === 1);
  const opened = await s.open({ context: ['Me: Hello!'] });
  assert.equal(opened.status, 200);
  assert.match(opened.windowId, /^[0-9a-f]{12}$/);
  await until(() => s.events('window-open').length === 1);
  assert.equal(s.events('window-open')[0].windowId, opened.windowId);
  await s.frames(6);
  await until(() => s.events('batch-sealed').length === 1);
  const first = s.events('utterance-sealed')[0];
  assert.deepEqual([first.seq, first.text, first.windowText, first.reason, first.windowId], [1, 'do you want chicken or fish', 'do you want chicken or fish', 'turn-end', opened.windowId]);
  const batch1 = s.events('batch-sealed')[0];
  assert.deepEqual([batch1.windowId, batch1.seq, batch1.generation], [opened.windowId, 1, opened.generation]);
  assert.deepEqual(batch1.choices.map(c => c.label), ['Chicken', 'Fish']);
  assert.ok(s.events('choice-staged').every(e => e.windowId === opened.windowId && e.seq === 1));
  await s.frames(4);
  await until(() => s.events('batch-sealed').length === 2);
  const second = s.events('utterance-sealed')[1];
  assert.deepEqual([second.seq, second.text, second.windowText], [2, 'or pasta', 'do you want chicken or fish or pasta']);
  const batch2 = s.events('batch-sealed')[1];
  assert.equal(batch2.seq, 2, 'a replacement batch');
  assert.deepEqual(batch2.choices.map(c => c.label), ['Chicken', 'Fish', 'Pasta'], 'the whole window text, so later words modify earlier choices');
  assert.deepEqual(service.connections[0].texts, [], 'no ForceEndpoint or Terminate per utterance');
  assert.equal(service.connections.length, 1);
  assert.equal(s.events('final').length, 0, 'a window never finalizes per utterance');
  assert.equal(s.events('window-closed').length, 0, 'still listening after a seal');
  assert.equal((await (await h.request(`/sessions/${s.id}`, undefined, 'GET')).json()).mode, 'capturing');
});
const h_ = hub;

test('a window holds more audio than one hold: the window byte budget, not audio-limit at 16 s', async t => {
  const service = await turnsService(t);
  const h = await hub(t, { service, limits: { turnBytes: 32000 } });
  const s = await h.session();
  await s.open();
  await s.frames(20);
  await until(() => service.connections[0]?.frames >= 1);
  await pause(50);
  assert.equal(s.events('error').length, 0);
  assert.equal(s.events('window-closed').length, 0);
});

test('with no end of turn from the service, the hub energy gate seals after 1.5 s of quiet', async t => {
  const service = await turnsService(t, { 3: [turn('is it time for lunch')] });
  const h = await hub(t, { service });
  const s = await h.session();
  await s.open();
  await s.frames(5, TONE);
  await s.frames(14, QUIET);
  await pause(30);
  assert.equal(s.events('utterance-sealed').length, 0, '1.4 s of quiet');
  await s.frames(1, QUIET);
  await until(() => s.events('utterance-sealed').length === 1);
  assert.equal(s.events('utterance-sealed')[0].reason, 'silence');
  assert.equal(s.events('utterance-sealed')[0].windowText, 'is it time for lunch');
  await until(() => s.events('batch-sealed').length === 1);
  assert.equal(s.events('batch-sealed')[0].kind, 'yes-no');
});

test('the second press (buttons → api.window().press()) seals what was heard and closes the window; later frames go nowhere', async t => {
  const service = await turnsService(t, { 2: [turn('chicken or fish')] });
  const h = await hub(t, { service });
  assert.equal(h.api.window(), null, 'no window yet');
  const s = await h.session();
  const opened = await s.open();
  await s.frames(3);
  await until(() => s.events('partial').length === 1);
  const open = h.api.window();
  assert.equal(open.id, opened.windowId);
  open.press();
  await until(() => s.events('window-closed').length === 1);
  const closed = s.events('window-closed')[0];
  assert.deepEqual([closed.reason, closed.seals, closed.windowId], ['press', 1, opened.windowId]);
  assert.equal(s.events('utterance-sealed')[0].reason, 'press');
  await until(() => s.events('batch-sealed').length === 1, 4000);
  assert.equal(h.api.window(), null);
  assert.equal((await (await h.request(`/sessions/${s.id}`, undefined, 'GET')).json()).mode, 'paused');
  const heard = service.connections[0].frames;
  await s.frames(3);
  await pause(50);
  assert.equal(service.connections[0].frames, heard, 'no frame reaches the service after the window closed');
});

test('cancel discards the window: no seal, no batch, nothing submitted', async t => {
  const service = await turnsService(t, { 2: [turn('chicken or fish')] });
  const h = await hub(t, { service });
  const s = await h.session();
  await s.open();
  await s.frames(3);
  await until(() => s.events('partial').length === 1);
  h.api.window().cancel();
  await until(() => s.events('window-closed').length === 1);
  assert.equal(s.events('window-closed')[0].reason, 'cancel');
  assert.equal(s.events('window-closed')[0].seals, 0);
  await pause(100);
  assert.equal(s.events('utterance-sealed').length, 0);
  assert.equal(s.events('batch-sealed').length, 0);
});

test('a cancel while a batch is still being made discards the staged batch too', async t => {
  const service = await turnsService(t, { 2: [turn('what should we cook', { end: true })] });
  let release;
  const slow = (url, init) => new Promise((resolve, reject) => { release = resolve; init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  const h = await hub(t, { service, fetch: slow, env: { ERA_CHAT_TEXT_URL: 'https://reply.invalid/responses', ERA_CHAT_TEXT_MODEL: 'reply-model', ERA_CHAT_TEXT_TOKEN: 'reply-secret' } });
  const s = await h.session();
  await s.open();
  await s.frames(3);
  await until(() => s.events('utterance-sealed').length === 1);
  h.api.window().cancel();
  await until(() => s.events('window-closed').length === 1);
  await pause(100);
  assert.equal(s.events('batch-sealed').length, 0);
  assert.equal(s.events('choices-error').length, 0, 'a discarded batch is silent');
});

test('her pick closes the window and wins over a seal that was about to happen', async t => {
  const service = await turnsService(t, { 2: [turn('chicken or fish', { end: true })], 5: [turn('or pasta', { order: 1 })] });
  const h = await hub(t, { service });
  const s = await h.session();
  await s.open();
  await s.frames(3, TONE);
  await until(() => s.events('batch-sealed').length === 1);
  await s.frames(3, TONE);
  await s.frames(14, QUIET);
  await until(() => s.events('partial').some(e => e.text.includes('pasta')));
  assert.equal((await s.control('pick')).status, 200);
  await until(() => s.events('window-closed').length === 1);
  assert.equal(s.events('window-closed')[0].reason, 'pick');
  await s.frames(3, QUIET);
  await pause(80);
  assert.equal(s.events('utterance-sealed').length, 1, 'the words after her pick never seal');
});

test('nothing said: the window closes with zero seals and no choice request', async t => {
  const service = await turnsService(t);
  let calls = 0;
  const h = await hub(t, { service, limits: { windowSilenceMs: 300 }, fetch: async (url, init) => { if (init?.method !== 'HEAD') calls++; throw new Error('no'); },
    env: { ERA_CHAT_TEXT_URL: 'https://reply.invalid/responses', ERA_CHAT_TEXT_MODEL: 'reply-model', ERA_CHAT_TEXT_TOKEN: 'reply-secret' } });
  const s = await h.session();
  await s.open();
  await s.frames(3, QUIET);
  await until(() => s.events('window-closed').length === 1, 3000);
  assert.deepEqual([s.events('window-closed')[0].reason, s.events('window-closed')[0].seals], ['nothing-said', 0]);
  assert.equal(s.events('utterance-sealed').length + s.events('batch-sealed').length, 0);
  assert.equal(calls, 0, 'no choice request (the reply warm-up HEAD is not one)');
  assert.equal(h.api.window(), null);
});

test('10 s without new words after a seal closes: silence; the cap closes at 60 s (limits shortened)', async t => {
  const service = await turnsService(t, { 2: [turn('chicken or fish', { end: true })] });
  const h = await hub(t, { service, limits: { windowSilenceMs: 400 } });
  const s = await h.session();
  await s.open(); await s.frames(3);
  await until(() => s.events('window-closed').length === 1, 3000);
  assert.deepEqual([s.events('window-closed')[0].reason, s.events('window-closed')[0].seals], ['silence', 1]);
  const words = {}; for (let i = 1; i <= 400; i++) words[i] = [turn('word '.repeat(i).trim())];
  const talky = await turnsService(t, words);
  const h2 = await hub(t, { service: talky, limits: { windowCapMs: 500 } });
  const s2 = await h2.session();
  await s2.open();
  s2.frames(200, TONE, 5);
  await until(() => s2.events('window-closed').length === 1, 4000);
  assert.equal(s2.events('window-closed')[0].reason, 'cap');
});

test('guards: finish, ask or a second window on a windowed session is 409 window-open; a window needs streaming', async t => {
  const service = await turnsService(t);
  const h = await hub(t, { service });
  const s = await h.session();
  await s.open();
  for (const type of ['finish', 'ask', 'window']) {
    const r = await s.control(type);
    assert.equal(r.status, 409, type); assert.equal((await r.json()).error, 'window-open');
  }
  assert.equal(s.events('window-closed').length, 0, 'the refused controls leave the window open');
  assert.equal((await s.control('cancel')).status, 200);
  await until(() => s.events('window-closed').length === 1);
  assert.equal(s.events('window-closed')[0].reason, 'cancel', 'a plain cancel control ends the window');
  const plain = await hub(t);
  const p = await plain.session();
  const refused = await p.open();
  assert.equal(refused.status, 409); assert.equal(refused.error, 'stream-unavailable');
  assert.equal((await p.control('pick')).status, 200, 'a pick with no window is harmless');
});

test('a lost service socket closes the window (error), never a one-shot fallback', async t => {
  const service = await turnsService(t, { 2: [turn('chicken')] });
  const h = await hub(t, { service });
  const s = await h.session();
  await s.open(); await s.frames(3);
  await until(() => s.events('partial').length === 1);
  service.connections[0].ws.terminate();
  await until(() => s.events('window-closed').length === 1);
  assert.equal(s.events('window-closed')[0].reason, 'error');
  assert.equal(s.child.messages.some(m => m.type === 'audio' || m.type === 'finish'), false);
});

test('a hold still works after a window, and its budget is the hold budget', async t => {
  const service = await turnsService(t, { 2: [turn('chicken or fish', { end: true })] });
  const h = await hub(t, { service, limits: { turnBytes: 16000 } });
  const s = await h.session();
  await s.open(); await s.frames(3);
  await until(() => s.events('batch-sealed').length === 1);
  h.api.window().press();
  await until(() => s.events('window-closed').length === 1);
  const r = await s.control('ask');
  assert.equal(r.status, 200);
  s.generation = (await r.json()).generation;
  await s.frames(6);
  await until(() => s.events('error').some(e => e.error === 'audio-limit'));
});

test('the buttons dispatcher reaches the window: a second F13 is `end` (press), F14 is `cancel`', async t => {
  const { createButtons } = require('../buttons.js');
  const service = await turnsService(t, { 2: [turn('chicken or fish')] });
  const h = await hub(t, { service });
  const buttons = createButtons({ enabledChat: () => true, commands: h.api.commands, window: () => h.api.window(),
    kiosk: { foreground: async () => false, relaunch: async () => ({ ok: true }) } });
  const s = await h.session();
  await s.open(); await s.frames(3);
  await until(() => s.events('partial').length === 1);
  assert.deepEqual(await buttons.press({ key: 'F13', action: 'ask' }), { status: 200, ok: true, dispatch: 'end' });
  await until(() => s.events('window-closed').length === 1);
  assert.equal(s.events('window-closed')[0].reason, 'press');
  await s.open(); await s.frames(2);
  assert.equal((await buttons.press({ key: 'F14', action: 'cancel' })).dispatch, 'cancel');
  await until(() => s.events('window-closed').length === 2);
  assert.equal(s.events('window-closed')[1].reason, 'cancel');
  assert.equal((await buttons.press({ key: 'F14', action: 'cancel' })).dispatch, 'none', 'no window: nothing to cancel');
});

test('server.js hands the dispatcher the Chat API window', async () => {
  const source = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  const call = source.slice(source.indexOf('require("./buttons.js").createButtons('));
  assert.match(call.slice(0, call.indexOf('});')), /window: \(\) => chatApi\.window\(\)/);
});
