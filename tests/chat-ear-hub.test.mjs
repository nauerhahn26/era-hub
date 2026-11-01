// The wake word through the hub's Chat module (stable frame design
// 2026-10-28 §8; plan "Wake word", W1). `{type:'window', ear:true}` opens an
// EAR: a listening window that never closes on silence or cap, in which an
// utterance is sealed only when it holds the wake name (the words of the
// device's chatName; "elly" and the name + "'s" count). The question is the
// words after the name (or before it, past a greeting); a bare name makes the
// next utterance within 8 s the question. Anything else is dropped: never an
// event, never a choice request. A hold pauses the ear; it resumes after the
// hold. Fake services on loopback only; ephemeral ports.
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-ear-hub-'));
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


const { wakeQuestion } = require('../chat-window.js');
const ENDED = (text, order = 0) => turn(text, { end: true, order });
const events = (s, ...types) => s.seen.filter(event => types.includes(event.type));

test('wakeQuestion: the name as whole words, any case, "elly" and the possessive; the words after it, else before it past a greeting', () => {
  const cases = [
    ['Ellie, what do you want for lunch', 'Ellie', { question: 'what do you want for lunch' }],
    ['ELLIE. Do you want juice?', 'Ellie', { question: 'Do you want juice?' }],
    ['elly do you want to play', 'Ellie', { question: 'do you want to play' }],
    ["Ellie's turn to pick a book", 'Ellie', { question: 'turn to pick a book' }],
    ['What do you want for lunch, Ellie?', 'Ellie', { question: 'What do you want for lunch?' }],
    ['hey ellie', 'Ellie', { question: '' }],
    ['Ellie?', 'Ellie', { question: '' }],
    ['Okay, hey Ellie.', 'Ellie', { question: '' }],
    ['what time is it', 'Ellie', null],
    ['the jelly is on the table', 'Ellie', null],
    ['Ellen, do you want tea', 'Ellie', null],
    ['Mary Jo, want a snack?', 'Mary Jo', { question: 'want a snack?' }],
    ['mary wants a snack', 'Mary Jo', null],
    ['elly do you want tea', 'Sam', null],
    ['Sam, do you want tea', 'Sam', { question: 'do you want tea' }],
  ];
  for (const [text, name, expected] of cases) assert.deepEqual(wakeQuestion(text, name), expected, `${name}: ${text}`);
});

test('/config: wake is true with a streaming runtime and false without; the wake name is the device\'s', async t => {
  const service = await turnsService(t);
  const h = await hub(t, { service, name: () => 'Sam' });
  const config = await (await fetch(h.base + '/config')).json();
  assert.equal(config.runtime.capabilities.wake, true); assert.equal(config.wakeName, 'Sam');
  const plain = await hub(t);
  const bare = await (await fetch(plain.base + '/config')).json();
  assert.equal(bare.runtime.capabilities.wake, false); assert.equal(bare.wakeName, 'Ellie', 'the default name');
});

test('an ear seals "Ellie, what do you want for lunch" as the question, staged as a first batch; nothing of the room is emitted', async t => {
  const service = await turnsService(t, { 2: [turn('Ellie, what')], 3: [ENDED('Ellie, what do you want for lunch')] });
  const h = await hub(t, { service });
  const s = await h.session();
  const opened = await s.open({ ear: true, context: ['Me: Hi!'] });
  assert.equal(opened.status, 200); assert.match(opened.earId, /^[0-9a-f]{12}$/);
  await until(() => s.events('ear').length === 1);
  assert.deepEqual([s.events('ear')[0].state, s.events('ear')[0].earId, s.events('ear')[0].generation], ['listening', opened.earId, opened.generation]);
  assert.equal(s.events('window-open').length, 0, 'an ear is not a button window');
  await s.frames(5);
  await until(() => s.events('batch-sealed').length === 1);
  const sealed = s.events('utterance-sealed')[0];
  assert.deepEqual([sealed.text, sealed.windowText, sealed.seq, sealed.ear, sealed.earId], ['what do you want for lunch', 'what do you want for lunch', 1, true, opened.earId]);
  const batch = s.events('batch-sealed')[0];
  assert.deepEqual([batch.windowId, batch.seq, batch.generation], [sealed.windowId, 1, opened.generation]);
  assert.notEqual(sealed.windowId, opened.earId, 'each question has its own id');
  assert.equal(s.events('partial').length + s.events('settled').length + s.events('speculation').length, 0, 'no running words of the room reach the page');
  assert.equal(h.api.window(), null, 'the button dispatcher never presses an ear');
});

test('a bare "hey ellie" makes the next utterance within 8 s the question, whole', async t => {
  const service = await turnsService(t, { 2: [ENDED('hey ellie')], 4: [ENDED('do you want juice', 1)], 6: [ENDED('and some crackers', 2)] });
  const h = await hub(t, { service });
  const s = await h.session();
  await s.open({ ear: true });
  await s.frames(7);
  await until(() => s.events('batch-sealed').length === 1);
  await pause(200);
  assert.deepEqual(s.events('utterance-sealed').map(e => e.text), ['do you want juice'], 'the wake is spent on one question');
});

test('a bare name goes stale after 8 s', async t => {
  let now = 1000000;
  const service = await turnsService(t, { 2: [ENDED('Ellie?')], 4: [ENDED('do you want juice', 1)] });
  const h = await hub(t, { service, clock: () => now });
  const s = await h.session();
  await s.open({ ear: true });
  await s.frames(2);
  await until(() => service.connections[0].frames >= 2);
  await pause(100);
  now += 8100;
  await s.frames(3);
  await pause(300);
  assert.equal(s.events('utterance-sealed').length, 0);
});

test('"what time is it" without the name seals nothing, emits nothing and asks no reply model', async t => {
  const service = await turnsService(t, { 2: [turn('what time')], 3: [ENDED('what time is it')], 5: [ENDED('the jelly is on the table', 1)] });
  let calls = 0;
  const h = await hub(t, { service, fetch: async (url, init) => { if (init?.method !== 'HEAD') calls++; return new Response(null); },
    env: { ERA_CHAT_TEXT_URL: 'https://reply.invalid/responses', ERA_CHAT_TEXT_MODEL: 'reply-model', ERA_CHAT_TEXT_TOKEN: 'reply-secret' } });
  const s = await h.session();
  await s.open({ ear: true });
  const before = s.seen.length;
  await s.frames(6);
  await until(() => service.connections[0].frames >= 6);
  await pause(300);
  assert.deepEqual(s.seen.slice(before).map(e => e.type).filter(type => type !== 'socket'), [], 'no event at all');
  assert.equal(calls, 0);
});

test('the ear outlives the window silence and cap; frames past the window and session byte budgets are no audio-limit', async t => {
  const service = await turnsService(t, { 30: [ENDED('Ellie, are you hungry')] });
  const h = await hub(t, { service, limits: { windowSilenceMs: 200, windowCapMs: 300, windowBytes: 16000, sessionBytes: 16000, lifetimeMs: 300 } });
  const s = await h.session();
  await s.open({ ear: true });
  await s.frames(10, QUIET, 60);
  h.api.sweep();
  await s.frames(20, TONE, 5);
  await until(() => s.events('batch-sealed').length === 1, 3000);
  assert.deepEqual(s.events('utterance-sealed').map(e => e.text), ['are you hungry']);
  assert.equal(s.events('ear').filter(e => e.state === 'off').length, 0);
  assert.equal(s.events('error').length, 0);
});

test('a hold pauses the ear and it resumes after the final; ear:false closes it', async t => {
  const service = await turnsService(t, { 2: [ENDED('Ellie, do you want milk')] }, { onTerminate: [ENDED('would you like a story')] });
  const h = await hub(t, { service });
  const s = await h.session();
  await s.open({ ear: true });
  const r = await s.control('ask', { context: [] });
  assert.equal(r.status, 200);
  s.generation = (await r.json()).generation;
  await until(() => s.events('ear').length === 2);
  assert.deepEqual([s.events('ear')[1].state, s.events('ear')[1].reason], ['off', 'hold']);
  await s.frames(1);
  assert.equal((await s.control('finish', { seq: s.sent() })).status, 200);
  await until(() => s.events('final').length === 1);
  assert.equal(s.events('final')[0].text, 'would you like a story');
  await until(() => s.events('ear').length === 3);
  const resumed = s.events('ear')[2];
  assert.deepEqual([resumed.state, resumed.generation], ['listening', s.generation], 'the hold\'s generation: its batch is still delivered');
  await until(() => s.events('batch-sealed').length === 1);
  await s.frames(3);
  await until(() => s.events('utterance-sealed').length === 1);
  assert.equal(s.events('utterance-sealed')[0].text, 'do you want milk');
  assert.equal((await s.control('window', { ear: false })).status, 200);
  await until(() => s.events('ear').length === 4);
  assert.deepEqual([s.events('ear')[3].state, s.events('ear')[3].reason], ['off', 'off']);
  const sealed = s.events('utterance-sealed').length;
  await s.frames(4);
  await pause(200);
  assert.equal(s.events('utterance-sealed').length, sealed, 'closed: frames go nowhere');
});

test('a cancelled hold resumes the ear too; a cancel with the ear listening keeps it listening', async t => {
  const service = await turnsService(t);
  const h = await hub(t, { service });
  const s = await h.session();
  await s.open({ ear: true });
  s.generation = (await (await s.control('ask')).json()).generation;
  assert.equal((await s.control('cancel')).status, 200);
  await until(() => s.events('ear').length === 3);
  const resumed = s.events('ear')[2];
  assert.equal(resumed.state, 'listening'); assert.ok(resumed.generation > s.generation, 'a cancel moves the generation; the ear says the new one');
  assert.equal((await s.control('cancel')).status, 200);
  assert.equal((await s.control('pick')).status, 200);
  await pause(100);
  assert.equal(s.events('ear').length, 3, 'still listening');
  assert.equal((await s.control('finish')).status, 409, 'nothing to finish');
});

test('a new wake cancels the reply still being prepared for the last one', async t => {
  const service = await turnsService(t, { 2: [ENDED('Ellie, what should we cook tonight')], 5: [ENDED('Ellie, what about some juice', 1)] });
  let aborted = 0;
  const choices = JSON.stringify({ choices: [{ label: 'Yes juice', say: 'Yes, juice please.' }, { label: 'No juice', say: 'No juice.' }] });
  const sse = events => new Response(new ReadableStream({ start(controller) {
    for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); controller.close(); } }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const h = await hub(t, { service, env: { ERA_CHAT_TEXT_URL: 'https://reply.invalid/responses', ERA_CHAT_TEXT_MODEL: 'reply-model', ERA_CHAT_TEXT_TOKEN: 'reply-secret' },
    fetch: (url, init) => {
      if (init?.method === 'HEAD') return Promise.resolve(new Response(null));
      if (JSON.parse(init.body).input.includes('juice'))
        return Promise.resolve(sse([{ type: 'response.output_text.delta', delta: choices }, { type: 'response.completed', response: {} }]));
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted++; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }));
    } });
  const s = await h.session();
  await s.open({ ear: true });
  await s.frames(6);
  await until(() => s.events('batch-sealed').length === 1);
  assert.deepEqual(s.events('utterance-sealed').map(e => e.text), ['what should we cook tonight', 'what about some juice']);
  assert.equal(aborted, 1);
  assert.equal(s.events('batch-sealed')[0].windowId, s.events('utterance-sealed')[1].windowId);
  assert.equal(s.events('choices-error').length, 0);
});

test('the ear starts a fresh stream turn after a seal once it is old enough, and keeps listening', async t => {
  const service = await turnsService(t, { 2: [ENDED('Ellie, do you want tea')] });
  const h = await hub(t, { service, limits: { earRollMs: 0 } });
  const s = await h.session();
  await s.open({ ear: true });
  await s.frames(3);
  await until(() => s.events('utterance-sealed').length === 1);
  await until(() => service.connections.length >= 2);
  await s.frames(3);
  await until(() => s.events('utterance-sealed').length >= 2);
  assert.equal(s.events('ear').length, 1, 'no off/on events for a roll');
});

test('the ear guards: it needs streaming; a second ear open is the same ear; a lost socket closes it', async t => {
  const plain = await hub(t);
  const p = await plain.session();
  const refused = await p.open({ ear: true });
  assert.equal(refused.status, 409); assert.equal(refused.error, 'stream-unavailable');
  assert.equal((await p.control('window', { ear: 'yes' })).status, 400);
  const service = await turnsService(t);
  const h = await hub(t, { service });
  const s = await h.session();
  const first = await s.open({ ear: true });
  const again = await s.open({ ear: true, context: ['Me: Hi!'] });
  assert.deepEqual([again.status, again.earId, again.generation], [200, first.earId, first.generation]);
  s.ws.terminate();
  await until(() => s.events('ear').some(e => e.state === 'off'));
  assert.equal(s.events('ear').find(e => e.state === 'off').reason, 'socket');
});

test('auto-off (§10): warnings at two minutes and one minute left, off as idle after the idle time; a wake or a hold restarts the clock', async t => {
  let now = 5000000, offs = 0;
  const service = await turnsService(t, { 2: [ENDED('Ellie, do you want tea')] }, { onTerminate: [ENDED('would you like a story')] });
  const h = await hub(t, { service, clock: () => now, limits: { windowTickMs: 10 }, extra: { wakeIdleMs: () => 300000, onWakeIdle: () => { offs++; } } });
  const s = await h.session();
  await s.open({ ear: true });
  const ear = state => s.events('ear').filter(e => e.state === state);
  now += 179000; await pause(60);
  assert.equal(ear('warning').length, 0);
  now += 1000; await until(() => ear('warning').length === 1);
  assert.equal(ear('warning')[0].remainingMs, 120000);
  now += 60000; await until(() => ear('warning').length === 2);
  assert.equal(ear('warning')[1].remainingMs, 60000);
  // A wake restarts the clock: nothing more until two minutes before the new end.
  await s.frames(3);
  await until(() => s.events('utterance-sealed').length === 1);
  now += 170000; await pause(60);
  assert.equal(ear('warning').length, 2, 'the clock restarted at the wake');
  // So does a hold (and its resume).
  s.generation = (await (await s.control('ask')).json()).generation;
  await s.frames(1);
  await s.control('finish', { seq: s.sent() });
  await until(() => ear('listening').length === 2);
  now += 170000; await pause(60);
  assert.equal(ear('warning').length, 2, 'the clock restarted at the hold');
  now += 10000; await until(() => ear('warning').length === 3);
  now += 120000; await until(() => ear('off').some(e => e.reason === 'idle'));
  assert.equal(offs, 1, 'the hub saves the switch off');
  await pause(60);
  assert.equal(ear('off').filter(e => e.reason === 'idle').length, 1);
});

test('server.js turns the saved switch off when the ear goes idle', async () => {
  const source = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /onWakeIdle: \(\) => wakeModeOff\(DATA\)/);
  assert.match(source, /wakeIdleMs: \(\) => chatWake\(DATA\)\.chatWakeIdleMs/);
});

// ---- Yes and No in full (spec 2026-10-28 §11, plan Y2) ----
// A yes-or-no question stages the local set at once; one model request for the
// two answers in full runs after the seal and arrives as `yes-no-answered`.
const REPLY_ENV = { ERA_CHAT_TEXT_URL: 'https://reply.invalid/responses', ERA_CHAT_TEXT_MODEL: 'reply-model', ERA_CHAT_TEXT_TOKEN: 'reply-secret' };
const completed = value => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  usage: { input_tokens: 300, output_tokens: 20 } }));
function answerService({ value = { yes: "Yes, I'm hungry", no: "No, I'm not hungry", feeling: 'hungry' }, hold = false } = {}) {
  const calls = [], gates = [];
  let aborted = 0;
  const fetcher = (url, init) => {
    if (init?.method === 'HEAD') return Promise.resolve(new Response(null));
    const body = JSON.parse(init.body); calls.push(body);
    if (body.text.format.name !== 'yes_no') {
      const text = JSON.stringify({ choices: [{ label: 'Pasta', say: 'Pasta please.', symbol: 'chat', picture: 'pasta' }, { label: 'Not sure', say: "I'm not sure.", symbol: 'chat', picture: 'shrug' }] });
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        for (const event of [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: {} }]) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted++; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      const answer = () => resolve(completed(value));
      if (hold) gates.push(answer); else answer();
    });
  };
  return { fetcher, calls, gates, aborted: () => aborted, answers: () => calls.filter(body => body.text.format.name === 'yes_no') };
}

test('a yes-or-no question: the local set is sealed at once, then the answers in full arrive with the feeling\'s picture', async t => {
  const service = await turnsService(t, { 2: [ENDED('Ellie, are you hungry')] });
  const model = answerService({ hold: true });
  const h = await hub(t, { service, env: REPLY_ENV, fetch: model.fetcher });
  const s = await h.session();
  const opened = await s.open({ ear: true, context: ['Me: Hi!'] });
  await s.frames(3);
  await until(() => s.events('batch-sealed').length === 1);
  const batch = s.events('batch-sealed')[0];
  assert.equal(batch.kind, 'yes-no');
  assert.deepEqual(s.events('choice-staged').map(e => e.choice.label), ['Yes', 'No', "I'm not sure", 'Please say that again']);
  await until(() => model.gates.length === 1);
  assert.equal(s.events('yes-no-answered').length, 0, 'the seal never waits for the answers');
  const input = JSON.parse(model.answers()[0].input);
  assert.deepEqual([input.question, input.context], ['are you hungry', ['Me: Hi!']]);
  model.gates[0]();
  await until(() => s.events('yes-no-answered').length === 1);
  const answer = s.events('yes-no-answered')[0];
  assert.deepEqual([answer.generation, answer.windowId, answer.seq], [opened.generation, batch.windowId, 1]);
  assert.deepEqual(answer.yes, { label: "Yes, I'm hungry", say: "Yes, I'm hungry", symbol: 'hungry', symbolId: 4962 });
  assert.deepEqual(answer.no, { label: "No, I'm not hungry", say: "No, I'm not hungry", symbol: 'hungry', symbolId: 4962 });
  assert.equal(answer.feeling, 'hungry');
  assert.ok(s.seen.indexOf(answer) > s.seen.indexOf(batch));
});

test('the answers in full: no feeling keeps the check mark and the cross; a question that is not yes-or-no asks for none; a new wake or a drop aborts them', async t => {
  const service = await turnsService(t, { 2: [ENDED('Ellie, is it raining')], 4: [ENDED('Ellie, what do you want for lunch', 1)], 6: [ENDED('Ellie, do you like dogs', 2)] });
  const model = answerService({ value: { yes: "Yes, it's raining", no: "No, it isn't", feeling: 'none' }, hold: true });
  const h = await hub(t, { service, env: REPLY_ENV, fetch: model.fetcher });
  const s = await h.session();
  await s.open({ ear: true });
  await s.frames(2);
  await until(() => model.gates.length === 1);
  model.gates[0]();
  await until(() => s.events('yes-no-answered').length === 1);
  const plain = s.events('yes-no-answered')[0];
  assert.deepEqual([plain.yes, plain.no, plain.feeling], [{ label: "Yes, it's raining", say: "Yes, it's raining" }, { label: "No, it isn't", say: "No, it isn't" }, null]);
  await s.frames(2);
  await until(() => s.events('batch-sealed').length === 2);
  await pause(50);
  assert.equal(model.answers().length, 1, 'an open question gets no answers in full');
  await s.frames(2);
  await until(() => model.gates.length === 2);
  assert.equal((await s.control('drop')).status, 200, 'the page dropped the question (Something else, Clear, Back)');
  await until(() => model.aborted() === 1);
  model.gates[1]();
  await pause(50);
  assert.equal(s.events('yes-no-answered').length, 1, 'nothing for a dropped question');
  assert.equal(s.events('ear').filter(e => e.state === 'off').length, 0, 'a drop leaves the ear listening');
});

test('the answers in full are aborted by a new question, a cancel and a close, and need the built-in reply core', async t => {
  const service = await turnsService(t, { 2: [ENDED('Ellie, are you tired')], 4: [ENDED('Ellie, are you cold', 1)] });
  const model = answerService({ hold: true });
  const h = await hub(t, { service, env: REPLY_ENV, fetch: model.fetcher });
  const s = await h.session();
  await s.open({ ear: true });
  await s.frames(2);
  await until(() => model.gates.length === 1);
  await s.frames(2);
  await until(() => model.aborted() === 1 && model.gates.length === 2);
  assert.equal((await s.control('cancel')).status, 200);
  await until(() => model.aborted() === 2);
  for (const gate of model.gates) gate();
  await pause(50);
  assert.equal(s.events('yes-no-answered').length, 0);
  const none = await hub(t, { service: await turnsService(t, { 2: [ENDED('Ellie, are you tired')] }) });
  const q = await none.session();
  await q.open({ ear: true });
  await q.frames(2);
  await until(() => q.events('batch-sealed').length === 1);
  await pause(50);
  assert.equal(q.events('yes-no-answered').length, 0, 'no reply model: the local set alone');
});

// ---- What the ear heard (spec 2026-10-28 §12, plan E1) ----
// Every ear event reaches the hub's `onEar` (server.js: the chat-turns writer,
// which keeps them only while test mode is on): each turn's words and tier,
// each seal and what the wake rule found, pause/resume/off with reasons, a lost
// socket, and her clips as the page posts them (`control {type:'clip'}`, §13).
const earOf = records => (...events) => records.filter(record => events.includes(record.event));
test('ear records: each turn and seal with what the wake rule found, pause and resume with reasons, off; her clips', async t => {
  const service = await turnsService(t, { 2: [ENDED('what time is it')], 4: [ENDED('Ellie, are you hungry', 1)] }, { onTerminate: [ENDED('would you like a story')] });
  const records = [], ear = earOf(records);
  let now = 1000000;
  const h = await hub(t, { service, clock: () => now, extra: { onEar: record => { records.push(record); } } });
  const s = await h.session();
  const opened = await s.open({ ear: true });
  await s.frames(5);
  await until(() => s.events('utterance-sealed').length === 1);
  assert.deepEqual(ear('turn').map(r => [r.tier, r.text]), [['main', 'what time is it'], ['main', 'Ellie, are you hungry']]);
  assert.deepEqual(ear('seal').map(r => [r.text, r.wake, r.question]), [['what time is it', 'none', undefined], ['Ellie, are you hungry', 'question', 'are you hungry']]);
  assert.ok(records.every(r => r.earId === opened.earId && r.at === now), 'the ear and the hub\'s clock on every line');
  // Her clips: recorded with their words, nothing else changes; a bad one is refused; the old gate is gone.
  assert.equal((await s.control('clip', { on: true, at: 1234.5, text: "Yes, I'm tired." })).status, 200);
  assert.equal((await s.control('clip', { on: false, at: 1300, source: 'other', text: 'ignored when off' })).status, 200);
  for (const bad of [{ on: 'yes', at: 1, text: 'Yes.' }, { on: true, text: 'Yes.' }, { on: true, at: -1, text: 'Yes.' }, { on: true, at: 1, source: 'tab', text: 'Yes.' },
    { on: true, at: 1 }, { on: true, at: 1, text: 7 }, { on: true, at: 1, text: 'x'.repeat(601) }]) assert.equal((await s.control('clip', bad)).status, 400, JSON.stringify(bad));
  for (const old of [{ on: true, at: 1 }, { on: false, at: 2 }]) assert.equal((await s.control('gate', old)).status, 400, 'gate is refused: ' + JSON.stringify(old));
  assert.deepEqual(ear('clip').map(r => [r.on, r.source, r.text, r.pageAt]), [[true, 'page', "Yes, I'm tired.", 1234.5], [false, 'other', undefined, 1300]]);
  assert.equal(s.events('ear').length, 1, 'a clip never pauses the ear');
  // A hold pauses it; the final resumes it; the switch turns it off.
  s.generation = (await (await s.control('ask', { context: [] })).json()).generation;
  await s.frames(1);
  assert.equal((await s.control('finish', { seq: s.sent() })).status, 200);
  await until(() => ear('resume').length === 1);
  assert.deepEqual([ear('pause')[0].reason, ear('resume')[0].reason], ['hold', 'final']);
  // §14: the ear's opening and its resume are written too, so the log shows when it listened at all.
  assert.deepEqual(ear('on').map(r => [r.tier, r.resumed, r.earId]), [['main', false, opened.earId], ['main', true, opened.earId]]);
  assert.ok(records.indexOf(ear('on')[0]) < records.indexOf(ear('turn')[0]), 'on comes first');
  assert.equal((await s.control('window', { ear: false })).status, 200);
  assert.deepEqual(ear('off').map(r => r.reason), ['off']);
  const before = records.length;
  assert.equal((await s.control('clip', { on: true, at: 2000, text: 'No.' })).status, 200);
  assert.equal(records.length, before, 'no ear, no clip line');
  assert.ok(records.every(r => Object.keys(r).every(key => ['event', 'at', 'earId', 'tier', 'text', 'wake', 'question', 'reason', 'replayedMs', 'on', 'source', 'pageAt', 'heard', 'clip', 'kept', 'resumed', 'code'].includes(key))));
});

test('ear records: a bare name is found as a name; a lost socket is recorded and the ear is off; a broken writer never touches the ear', async t => {
  const service = await turnsService(t, { 2: [ENDED('hey ellie')] });
  const records = [], ear = earOf(records);
  const h = await hub(t, { service, extra: { onEar: record => { records.push(record); throw new Error('disk full'); } } });
  const s = await h.session();
  await s.open({ ear: true });
  await s.frames(3);
  await until(() => ear('seal').length === 1);
  assert.deepEqual([ear('seal')[0].wake, ear('seal')[0].question], ['name', undefined]);
  s.ws.terminate();
  await until(() => ear('off').length === 1);
  assert.deepEqual([ear('socket').length, ear('off')[0].reason], [1, 'socket']);
  assert.ok(records.indexOf(ear('socket')[0]) < records.indexOf(ear('off')[0]));
});

// A failed reply never ends the session (spec 2026-10-28 §14): the reply
// service refusing every request (11/1: no credit left) fails the turn only.
test('a failed reply job: choices-error with the hub\'s code, a fault ear record, one log line with the service\'s status and never its text; the ear listens on', async t => {
  const service = await turnsService(t, { 2: [ENDED('Ellie, what should we cook tonight')], 5: [ENDED('Ellie, what about some soup', 1)] });
  const records = [], lines = [], ear = earOf(records);
  const h = await hub(t, { service, env: REPLY_ENV, extra: { onEar: record => { records.push(record); }, log: line => lines.push(line) },
    fetch: (url, init) => {
      if (init?.method === 'HEAD') return Promise.resolve(new Response(null));
      return Promise.resolve(new Response(JSON.stringify({ error: { message: 'Your credit balance is too low (secret account 1234)' } }), { status: 402, headers: { 'Content-Type': 'application/json' } }));
    } });
  const s = await h.session();
  const opened = await s.open({ ear: true });
  await s.frames(3);
  await until(() => s.events('choices-error').length === 1);
  const failed = s.events('choices-error')[0];
  assert.deepEqual([failed.error, failed.windowId, failed.generation], ['generation-unavailable', s.events('utterance-sealed')[0].windowId, opened.generation]);
  assert.deepEqual(ear('fault').map(r => [r.code, r.earId]), [['generation-unavailable', opened.earId]]);
  assert.deepEqual(lines, ['[chat] replies failed: generation-unavailable 402']);
  assert.ok(!JSON.stringify([records, lines, s.seen]).includes('credit'), 'never the service\'s message text');
  // The ear was never touched: no off, and the next wake question is sealed and asked.
  assert.equal(s.events('ear').filter(e => e.state === 'off').length, 0);
  await s.frames(3);
  await until(() => s.events('choices-error').length === 2);
  assert.deepEqual(s.events('utterance-sealed').map(e => e.text), ['what should we cook tonight', 'what about some soup']);
  assert.equal(ear('fault').length, 2); assert.equal(lines.length, 2);
  assert.equal(ear('on').length, 1, 'opened once: a failure never closes or reopens the ear');
});

test('server.js sends the ear\'s lines to the chat-turns writer', async () => {
  const source = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /onEar: \(record\) => chatTurns\.ear\(record\)/);
});

// ---- Her clip is handled, never silenced (spec 2026-10-28 §13, plan H2) ----
// The page posts each clip's words (`control {type:'clip'}`); the hub removes
// them from every transcript turn heard while the clip plays or within 3 s
// after: a turn left with no words seals nothing; the partner's words left go on.
const READING = 'Ellie, your options are Yes. No.';
test('main tier: the reading heard back is dropped (no turn, no seal, no wake); the partner\'s words beside her clip seal as the question', async t => {
  const service = await turnsService(t, { 2: [ENDED('Ellie, your options are Yes. No.')], 4: [ENDED("Ellie are you hungry yes I'm tired", 1)] });
  const records = [], ear = earOf(records);
  const h = await hub(t, { service, extra: { onEar: record => { records.push(record); } } });
  const s = await h.session();
  await s.open({ ear: true });
  assert.equal((await s.control('clip', { on: true, at: 10, text: READING })).status, 200);
  await s.frames(2);
  await until(() => ear('echo').length === 1);
  assert.equal((await s.control('clip', { on: false, at: 20 })).status, 200);
  assert.equal((await s.control('clip', { on: true, at: 30, text: "Yes, I'm tired." })).status, 200);
  await s.frames(2);
  await until(() => s.events('utterance-sealed').length === 1);
  assert.deepEqual(s.events('utterance-sealed').map(e => e.text), ['are you hungry']);
  assert.deepEqual(ear('turn').map(r => r.text), ['Ellie are you hungry'], 'the dropped turn is no turn');
  assert.deepEqual(ear('seal').map(r => [r.text, r.wake]), [['Ellie are you hungry', 'question']]);
  assert.deepEqual(ear('echo').map(r => [r.tier, r.heard, r.kept]), [['main', READING, 'dropped'], ['main', "Ellie are you hungry yes I'm tired", 'Ellie are you hungry']]);
  assert.equal(ear('echo')[1].clip, "yes I'm tired");
  assert.deepEqual(ear('clip').map(r => [r.on, r.text]), [[true, READING], [false, undefined], [true, "Yes, I'm tired."]]);
});

test('a turn 5 s after her clip ended passes untouched', async t => {
  let now = 1000000;
  const service = await turnsService(t, { 2: [ENDED('Ellie, your options are yes')] });
  const records = [], ear = earOf(records);
  const h = await hub(t, { service, clock: () => now, extra: { onEar: record => { records.push(record); } } });
  const s = await h.session();
  await s.open({ ear: true });
  await s.control('clip', { on: true, at: 1, text: READING });
  now += 1000; await s.control('clip', { on: false, at: 2 });
  now += 5000;
  await s.frames(2);
  await until(() => s.events('utterance-sealed').length === 1);
  assert.equal(s.events('utterance-sealed')[0].text, 'your options are yes');
  assert.equal(ear('echo').length, 0);
});

test('a held question: her clip\'s words leave the partials and the final; nothing of the ear is recorded with the ear off', async t => {
  const service = await turnsService(t, { 1: [turn("Yes, I'm tired")], 2: [turn("do you want juice yes I'm tired")] },
    { onTerminate: [ENDED("Do you want juice? Yes, I'm tired.")] });
  const records = [];
  const h = await hub(t, { service, extra: { onEar: record => { records.push(record); } } });
  const s = await h.session();
  assert.equal((await s.control('clip', { on: true, at: 5, text: "Yes, I'm tired." })).status, 200);
  s.generation = (await (await s.control('ask', { context: [] })).json()).generation;
  await s.frames(2);
  await until(() => service.connections.some(c => c.frames >= 2));
  await pause(50);
  assert.equal((await s.control('finish', { seq: s.sent() })).status, 200);
  await until(() => s.events('final').length === 1);
  assert.equal(s.events('partial')[0].text, 'do you want juice', 'her words alone are no partial');
  assert.ok(s.events('partial').every(e => !/tired/i.test(e.text)), 'no partial holds her words');
  assert.equal(s.events('final')[0].text, 'Do you want juice?');
  assert.deepEqual(records, [], 'no ear: no clip or echo lines');
});

test('a held question that was only her clip is no speech', async t => {
  const service = await turnsService(t, {}, { onTerminate: [ENDED('No.')] });
  const h = await hub(t, { service });
  const s = await h.session();
  await s.control('clip', { on: true, at: 5, text: 'No.' });
  s.generation = (await (await s.control('ask', { context: [] })).json()).generation;
  await s.frames(2);
  await until(() => service.connections.some(c => c.frames >= 2));
  assert.equal((await s.control('finish', { seq: s.sent() })).status, 200);
  await until(() => s.events('error').length === 1);
  assert.equal(s.events('error')[0].error, 'no-speech');
  assert.equal(s.events('final').length, 0);
});

test('a button window: her clip heard back seals nothing; the partner\'s next words seal', async t => {
  const service = await turnsService(t, { 2: [turn("Yes, I'm")], 3: [ENDED("Yes, I'm tired.")], 30: [ENDED('do you want a nap', 1)] });
  const h = await hub(t, { service });
  const s = await h.session();
  await s.control('clip', { on: true, at: 5, text: "Yes, I'm tired." });
  await s.open({ context: [] });
  await s.frames(3);
  await until(() => service.connections.some(c => c.frames >= 3));
  await s.frames(25, QUIET);
  assert.equal(s.events('utterance-sealed').length, 0, 'the echo never seals, on its turn end or on quiet frames');
  await s.frames(2);
  await until(() => s.events('utterance-sealed').length === 1);
  assert.equal(s.events('utterance-sealed')[0].text, 'do you want a nap');
});
