// Streaming Chat through the hub's Chat module (real-time chat spec 2026-10-27
// §3): with stream settings the session warms one service socket at Start
// Chat, frames from the page's socket stream to it during a hold, partials
// reach the page as SSE, release finalizes, and any failure before the final
// falls back to the one-shot recognizer with the whole hold (never a truncated
// submit). Speculative and streamed choices are staged by the hub, sealed
// once, and nothing ever speaks. Fake services on loopback only.
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

const until = async (check, ms = 3000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)); } };
const pause = ms => new Promise(r => setTimeout(r, ms));
const turn = (text, { end = false, order = 0 } = {}) => ({ type: 'Turn', turn_order: order, end_of_turn: end, turn_is_formatted: end, transcript: text });

// The turn-streaming fake service. `say` scripts the words: partials by frame
// count, the forced endpoint's end of turn, Termination on Terminate.
async function turnsService(t, { refuse = false, words = 'Would you like music or a story?', partials = [[2, 'would you like'], [3, 'would you like music or a story']], dropAt = 0 } = {}) {
  const connections = [];
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    if (refuse) { socket.end('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n'); return; }
    const ws = acceptWebSocket(req, socket, head);
    const conn = { url: new URL(req.url, 'http://x'), headers: req.headers, frames: 0, bytes: 0, texts: [], closed: false, ws };
    connections.push(conn);
    ws.send(JSON.stringify({ type: 'Begin' }));
    ws.on('message', (data, binary) => {
      if (binary) {
        conn.frames++; conn.bytes += data.length;
        if (dropAt && conn.frames === dropAt) { ws.terminate(); return; }
        for (const [at, text] of partials) if (conn.frames === at) ws.send(JSON.stringify(turn(text)));
        return;
      }
      const value = JSON.parse(data); conn.texts.push(value.type);
      if (value.type === 'ForceEndpoint') ws.send(JSON.stringify(turn(words, { end: true })));
      if (value.type === 'Terminate') { ws.send(JSON.stringify({ type: 'Termination' })); setTimeout(() => ws.close(1000), 5); }
    });
    ws.on('close', () => { conn.closed = true; });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const c of connections) c.ws.terminate(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  return { url: `ws://127.0.0.1:${server.address().port}/v3/ws`, connections };
}

// The one-shot recognizer child: answers finish with the words it was given.
function runtime({ ready = true, words = 'Would you like music or a story?', slow = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.messages = []; child.audioBytes = 0;
  child.stdin = new Writable({ highWaterMark: slow ? 1024 : 16384, write(chunk, _, done) {
    const next = slow ? () => setTimeout(done, 1) : done;
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      const message = JSON.parse(line); child.messages.push(message);
      if (message.type === 'audio') child.audioBytes += Buffer.from(message.pcm, 'base64').length;
      if (message.type === 'finish') setTimeout(() => child.stdout.write(JSON.stringify({ type: 'final', generation: message.generation, text: words, timings: { audioMs: 300, cloudMs: 40 } }) + '\n'), 5);
    }
    next();
  } });
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 0)); };
  if (ready) setTimeout(() => child.stdout.write(JSON.stringify({ type: 'ready', capabilities: { remoteFinal: true } }) + '\n'), 5);
  return child;
}

async function hub(t, { services = [], env = {}, limits = {}, runtimeOptions = {}, reportUsage = false, fetch: fetcher, pictures } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-stream-hub-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const keyterms = path.join(dir, 'keyterms.json');
  await fs.writeFile(keyterms, JSON.stringify({ keyterms: ['Ellie', 'Saturday club'] }));
  const streamEnv = {};
  if (services[0]) Object.assign(streamEnv, { ERA_CHAT_STREAM_PROTOCOL: 'ws-streaming-turns', ERA_CHAT_STREAM_URL: services[0].url, ERA_CHAT_STREAM_MODEL: 'stream-model',
    ERA_CHAT_STREAM_TOKEN: 'stream-secret-token', ERA_CHAT_STREAM_BILLING: 'connection', ERA_CHAT_STREAM_KEYTERMS: keyterms });
  if (services[1]) Object.assign(streamEnv, { ERA_CHAT_STREAM_FALLBACK_PROTOCOL: 'ws-streaming-turns', ERA_CHAT_STREAM_FALLBACK_URL: services[1].url,
    ERA_CHAT_STREAM_FALLBACK_MODEL: 'fallback-model', ERA_CHAT_STREAM_FALLBACK_TOKEN: 'fallback-secret-token' });
  const children = [];
  const api = createChatApi({ env: { ERA_CHAT_RUNTIME: 'scripted', ERA_CHAT_RUNTIME_ARGS: '[]', ...streamEnv, ...env }, limits, reportUsage: () => reportUsage,
    spawn: () => { const child = runtime(runtimeOptions); children.push(child); return child; }, ...(fetcher ? { fetch: fetcher } : {}), ...(pictures ? { pictures } : {}) });
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
      async ask(extra = {}) { s.generation = (await (await request(`/sessions/${id}/control`, { type: 'ask', ...extra })).json()).generation; return s.generation; },
      frame(bytes = 3200, fill = 1) { const b = Buffer.alloc(8 + bytes, fill); b.writeUInt32LE(s.generation, 0); b.writeUInt32LE(seq++, 4); ws.send(b); },
      finish() { return request(`/sessions/${id}/control`, { type: 'finish', seq }); },
      control(type) { return request(`/sessions/${id}/control`, { type }); },
      events: type => seen.filter(event => event.type === type) };
    return s;
  }
  return { api, request, session, children, base };
}
const raw = async (s, frames, gap = 15) => { for (let i = 0; i < frames; i++) { s.frame(); await pause(gap); } };

test('stream settings advertise partials and remote streaming; nothing private reaches config or events', async t => {
  const service = await turnsService(t);
  const h = await hub(t, { services: [service] });
  const s = await h.session();
  await until(() => s.events('ready').length === 1);
  const caps = s.events('ready')[0].capabilities;
  assert.equal(caps.partial, true); assert.equal(caps.remoteStreaming, true); assert.equal(caps.audioSocket, true); assert.equal(caps.remoteFinal, true);
  const config = await (await fetch(h.base + '/config')).text();
  for (const secret of ['stream-secret-token', 'stream-model', '127.0.0.1', 'Saturday']) assert.ok(!config.includes(secret), secret);
  const plain = await hub(t);
  const p = await plain.session();
  await until(() => p.events('ready').length === 1);
  assert.equal(p.events('ready')[0].capabilities.partial, false); assert.equal(p.events('ready')[0].capabilities.remoteStreaming, false);
});

test('Start Chat warms one service socket with the keyterms; a hold streams frames, partials reach the page in order, release brings the final', async t => {
  const service = await turnsService(t);
  const h = await hub(t, { services: [service] });
  const s = await h.session();
  await until(() => service.connections.length === 1);
  assert.deepEqual(JSON.parse(service.connections[0].url.searchParams.get('keyterms_prompt')), ['Ellie', 'Saturday club']);
  assert.equal(service.connections[0].frames, 0, 'nothing is sent before a hold');
  const generation = await s.ask();
  await raw(s, 4);
  await until(() => s.events('partial').length === 2);
  assert.deepEqual(s.events('partial').map(e => [e.text, e.generation]), [['would you like', generation], ['would you like music or a story', generation]]);
  assert.equal((await s.finish()).status, 200);
  await until(() => s.events('final').length === 1);
  const final = s.events('final')[0];
  assert.equal(final.text, 'Would you like music or a story?'); assert.equal(final.mode, 'stream'); assert.equal(final.generation, generation);
  assert.equal(final.setting, 'primary');
  assert.ok(Number.isFinite(final.timings.finalizeMs));
  assert.equal(s.events('socket')[0].warm, true);
  assert.ok(s.events('settled').length === 1);
  assert.deepEqual(service.connections[0].texts, ['ForceEndpoint', 'Terminate']);
  assert.equal(s.child.messages.some(m => m.type === 'audio' || m.type === 'finish'), false, 'the one-shot recognizer never heard the hold');
  const sse = JSON.stringify(s.seen);
  assert.ok(!sse.includes('stream-secret-token') && !sse.includes('Saturday club'), 'no credential or keyterm in events');
});

test('a refused service: the hold falls back to the one-shot recognizer with every frame', async t => {
  const service = await turnsService(t, { refuse: true });
  const h = await hub(t, { services: [service] });
  const s = await h.session();
  await s.ask(); await raw(s, 5);
  await s.finish();
  await until(() => s.events('final').length === 1);
  assert.equal(s.events('final')[0].mode, 'one-shot');
  assert.equal(s.child.audioBytes, 5 * 3200, 'the whole hold, not a fragment');
  assert.deepEqual(s.child.messages.filter(m => m.generation === s.generation).map(m => m.type).filter((type, i, all) => type !== 'audio' || all[i - 1] !== 'audio'), ['ask', 'audio', 'finish']);
});

test('a socket lost mid-hold falls back with the whole hold, including frames the service already had', async t => {
  const service = await turnsService(t, { dropAt: 3 });
  const h = await hub(t, { services: [service] });
  const s = await h.session();
  await until(() => service.connections.length === 1);
  await s.ask(); await raw(s, 6);
  await s.finish();
  await until(() => s.events('final').length === 1);
  assert.equal(s.events('final')[0].mode, 'one-shot');
  assert.equal(s.child.audioBytes, 6 * 3200);
});

test('when the one-shot recognizer cannot take the hold the turn fails cleanly: an error, never a final', async t => {
  const service = await turnsService(t, { refuse: true });
  const h = await hub(t, { services: [service], runtimeOptions: { ready: false } });
  const s = await h.session();
  await s.ask(); await raw(s, 3); await s.finish();
  await until(() => s.events('error').length === 1);
  assert.equal(s.events('final').length, 0);
  assert.equal(s.child.messages.some(m => m.type === 'finish'), false);
});

test('a refused primary hands the next holds to the fallback stream setting', async t => {
  const primary = await turnsService(t, { refuse: true }), fallback = await turnsService(t);
  const h = await hub(t, { services: [primary, fallback] });
  const s = await h.session();
  await s.ask(); await raw(s, 3); await s.finish();
  await until(() => s.events('final').length === 1);
  await until(() => fallback.connections.length >= 1);
  assert.equal(fallback.connections[0].url.searchParams.get('speech_model'), 'fallback-model');
  await s.ask(); await raw(s, 4); await s.finish();
  await until(() => s.events('final').length === 2);
  assert.equal(s.events('final')[1].mode, 'stream');
  assert.equal(s.events('final')[1].setting, 'fallback', 'the record names the setting the hold used');
  // The primary refused the warm socket at Start Chat, so the first hold already streamed on the fallback.
  assert.deepEqual(s.events('final').map(e => [e.mode, e.setting]), [['stream', 'fallback'], ['stream', 'fallback']]);
});

test('cancel discards the hold: its socket goes, nothing more of it reaches the page, the next hold reconnects', async t => {
  const service = await turnsService(t);
  const h = await hub(t, { services: [service] });
  const s = await h.session();
  await until(() => service.connections.length === 1);
  await s.ask(); await raw(s, 2);
  await until(() => s.events('partial').length === 1);
  await s.control('cancel');
  await until(() => service.connections[0].closed);
  const after = s.seen.length;
  await pause(40);
  assert.equal(s.seen.slice(after).some(e => ['partial', 'final', 'settled'].includes(e.type)), false);
  await s.ask(); await raw(s, 4); await s.finish();
  await until(() => s.events('final').length === 1);
  assert.equal(s.events('socket').at(-1).warm, false); assert.ok(s.events('socket').at(-1).connectMs >= 0);
});

test('an idle socket closes after the bounded quiet period and the next touch-down reopens it', async t => {
  const service = await turnsService(t);
  const h = await hub(t, { services: [service], limits: { streamIdleMs: 60 } });
  const s = await h.session();
  await until(() => service.connections.length === 1 && service.connections[0].closed);
  await s.ask(); await raw(s, 4); await s.finish();
  await until(() => s.events('final').length === 1);
  assert.equal(service.connections.length >= 2, true);
  assert.equal(s.events('socket')[0].warm, false);
});

test('an empty final is no speech; test mode alone gets the socket seconds and the keyterm count', async t => {
  const quiet = await turnsService(t, { words: '', partials: [] });
  const h = await hub(t, { services: [quiet] });
  const s = await h.session();
  await s.ask(); await raw(s, 2); await s.finish();
  await until(() => s.events('error').length === 1);
  assert.equal(s.events('error')[0].error, 'no-speech');
  const service = await turnsService(t, { words: 'Is Ellie coming to the Saturday club?' });
  const on = await hub(t, { services: [service], reportUsage: true });
  const u = await on.session();
  await u.ask(); await raw(u, 3); await u.finish();
  await until(() => u.events('final').length === 1);
  assert.equal(u.events('final')[0].usage.keytermsFired, 2);
  assert.ok(u.events('final')[0].usage.socketSeconds >= 0);
  const off = await hub(t, { services: [await turnsService(t)] });
  const o = await off.session();
  await o.ask(); await raw(o, 3); await o.finish();
  await until(() => o.events('final').length === 1);
  assert.equal(o.events('final')[0].usage, undefined);
});

// ---- staged, streamed and speculative choices (spec §3.3) ----
const replyEnv = { ERA_CHAT_TEXT_URL: 'https://reply.invalid/responses', ERA_CHAT_TEXT_MODEL: 'reply-model', ERA_CHAT_TEXT_TOKEN: 'reply-secret' };
// The streamed reply service: answers by question, releases its deltas on a timer.
function replyService({ gapMs = 15, answers = {} } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body), input = JSON.parse(body.input), call = { url, body, input, signal: init.signal };
    calls.push(call);
    const value = answers[input.question] || { choices: [{ label: 'Play outside', say: 'Let us play outside.', symbol: 'chat' }, { label: 'Read', say: 'I want to read.', symbol: 'chat' }, { label: 'Not sure', say: 'I am not sure.', symbol: 'chat' }] };
    const text = JSON.stringify(value), pieces = [];
    for (let i = 0; i < text.length; i += 12) pieces.push({ type: 'response.output_text.delta', delta: text.slice(i, i + 12) });
    pieces.push({ type: 'response.completed', response: { usage: { input_tokens: 800, output_tokens: 50 } } });
    const stream = new ReadableStream({ async start(controller) {
      for (const event of pieces) {
        if (init.signal.aborted) { controller.error(new DOMException('aborted', 'AbortError')); return; }
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); await pause(gapMs);
      }
      call.completed = true; controller.close();
    } });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetcher, calls };
}
const OPEN = 'What should we do after lunch?';

test('choices are staged by the hub one by one and sealed once; the page never asks for them', async t => {
  const service = await turnsService(t, { words: OPEN, partials: [] });
  const reply = replyService();
  const h = await hub(t, { services: [service], env: { ...replyEnv, ERA_CHAT_SPECULATE_MS: '0' }, fetch: reply.fetcher });
  const s = await h.session();
  await until(() => s.events('ready').length === 1);
  assert.equal(s.events('ready')[0].capabilities.stagedChoices, true);
  await s.ask({ context: ['Me: I like books.'] }); await raw(s, 3); await s.finish();
  await until(() => s.events('batch-sealed').length === 1);
  const staged = s.events('choice-staged'), sealed = s.events('batch-sealed')[0];
  assert.deepEqual(staged.map(e => e.choice.label), ['Play outside', 'Read', 'Not sure']);
  assert.ok(s.seen.indexOf(staged[0]) < s.seen.indexOf(staged[2]) && s.seen.indexOf(staged[2]) < s.seen.indexOf(sealed));
  assert.ok(staged[1].at - staged[0].at >= 0);
  assert.deepEqual(sealed.choices.map(c => c.say), ['Let us play outside.', 'I want to read.', 'I am not sure.']);
  assert.ok(sealed.choices.every(c => typeof c.symbol === 'string'));
  assert.equal(sealed.kind, 'generated'); assert.equal(sealed.generation, s.generation);
  assert.deepEqual(reply.calls[0].input, { question: OPEN, context: ['Me: I like books.'], shape: 'want' }, 'an open question carries its shape');
  assert.equal(sealed.shape, 'want', 'the sealed batch carries the shape for the turn record');
  assert.equal(reply.calls[0].body.stream, true);
  assert.equal(reply.calls.length, 1); assert.equal(sealed.usage, undefined, 'usage only in test mode');
  await pause(60);
  assert.equal(s.events('batch-sealed').length, 1, 'sealed once');
  assert.ok(!JSON.stringify(s.seen).includes('reply-secret'));
});

test('a stable partial starts a hidden speculative request; an equal final keeps it and nothing reached the page before', async t => {
  const service = await turnsService(t, { words: OPEN, partials: [[2, 'what should we do after lunch']] });
  const reply = replyService({ gapMs: 2 });
  const h = await hub(t, { services: [service], env: { ...replyEnv, ERA_CHAT_SPECULATE_MS: '40' }, fetch: reply.fetcher });
  const s = await h.session();
  await s.ask(); await raw(s, 3);
  await until(() => reply.calls.length === 1 && reply.calls[0].completed);
  assert.equal(reply.calls[0].input.question, 'what should we do after lunch');
  assert.deepEqual(s.events('speculation').map(e => e.state), ['start']);
  assert.equal(s.events('choice-staged').length + s.events('batch-sealed').length, 0, 'speculative choices never reach the page before the final');
  await s.finish();
  await until(() => s.events('batch-sealed').length === 1);
  assert.deepEqual(s.events('speculation').map(e => e.state), ['start', 'keep']);
  assert.equal(reply.calls.length, 1, 'kept: no second request');
  assert.equal(s.events('choice-staged').length, 3);
});

test('a final that differs from the speculation discards it (aborted, never shown) and starts fresh', async t => {
  const service = await turnsService(t, { words: 'What should we do after lunch today?', partials: [[2, 'what should we do after']] });
  const reply = replyService({ gapMs: 40, answers: { 'What should we do after lunch today?': { choices: [{ label: 'Fresh one', say: 'The fresh one.', symbol: 'chat' }, { label: 'Fresh two', say: 'The second fresh one.', symbol: 'chat' }] } } });
  const h = await hub(t, { services: [service], env: { ...replyEnv, ERA_CHAT_SPECULATE_MS: '20' }, fetch: reply.fetcher });
  const s = await h.session();
  await s.ask(); await raw(s, 3);
  await until(() => reply.calls.length === 1);
  await s.finish();
  await until(() => s.events('batch-sealed').length === 1);
  // The settled words differ from the stable partial: that speculation is
  // discarded (aborted) and a new one starts on them at once; the final equals it.
  assert.deepEqual(s.events('speculation').map(e => e.state), ['start', 'discard', 'start', 'keep']);
  assert.equal(reply.calls[0].signal.aborted, true, 'the speculative request was cancelled');
  assert.equal(reply.calls[0].input.question, 'what should we do after');
  assert.deepEqual(s.events('batch-sealed')[0].choices.map(c => c.label), ['Fresh one', 'Fresh two']);
  assert.deepEqual(s.events('choice-staged').map(e => e.choice.label), ['Fresh one', 'Fresh two']);
});

test('shortcuts run on partials: an either/or is ready from the speculation without any reply request', async t => {
  const service = await turnsService(t, { words: 'Would you like music or a story?', partials: [[2, 'Would you like music or a story']] });
  const reply = replyService();
  const h = await hub(t, { services: [service], env: { ...replyEnv, ERA_CHAT_SPECULATE_MS: '20' }, fetch: reply.fetcher });
  const s = await h.session();
  await s.ask(); await raw(s, 3);
  await until(() => s.events('speculation').length === 1);
  await s.finish();
  await until(() => s.events('batch-sealed').length === 1);
  assert.equal(reply.calls.length, 0);
  assert.equal(s.events('batch-sealed')[0].kind, 'alternatives');
  assert.deepEqual(s.events('batch-sealed')[0].choices.map(c => c.label), ['Music', 'A story']);
  assert.deepEqual(s.events('speculation').map(e => e.state), ['start', 'keep']);
});

test('a shortcut batch is staged as it was picked: two unknown names keep friend and people, a letter list stays glyphs', async t => {
  for (const [words, expect] of [['Do you want to play with Lisa or Sam?', [['Lisa', 'friend', undefined], ['Sam', 'people', undefined]]],
    ['Do you want A or B?', [['A', undefined, true], ['B', undefined, true]]]]) {
    const service = await turnsService(t, { words });
    const h = await hub(t, { services: [service], env: replyEnv, fetch: replyService().fetcher });
    const s = await h.session();
    await s.ask(); await raw(s, 3); await s.finish();
    await until(() => s.events('batch-sealed').length === 1);
    const staged = s.events('choice-staged').map(e => [e.choice.label, e.choice.symbol, e.choice.glyph]);
    assert.deepEqual(staged, expect, words);
  }
});

test('a new hold or a cancel drops the turn\'s choices: no staged or sealed event of an old generation ever arrives', async t => {
  const service = await turnsService(t, { words: OPEN, partials: [] });
  const reply = replyService({ gapMs: 30 });
  const h = await hub(t, { services: [service], env: { ...replyEnv, ERA_CHAT_SPECULATE_MS: '0' }, fetch: reply.fetcher });
  const s = await h.session();
  const first = await s.ask(); await raw(s, 3); await s.finish();
  await until(() => s.events('final').length === 1 && reply.calls.length === 1);
  await s.ask();
  await until(() => reply.calls[0].signal.aborted);
  await pause(150);
  assert.equal(s.seen.filter(e => ['batch-sealed'].includes(e.type) && e.generation === first).length, 0);
});

test('one-shot finals in a streaming session are staged by the hub too; a reply failure is a choices-error', async t => {
  const service = await turnsService(t, { refuse: true });
  const failing = async () => new Response('busy', { status: 503 });
  const h = await hub(t, { services: [service], env: { ...replyEnv, ERA_CHAT_SPECULATE_MS: '0' }, fetch: failing, runtimeOptions: { words: OPEN } });
  const s = await h.session();
  await s.ask(); await raw(s, 2); await s.finish();
  await until(() => s.events('choices-error').length === 1);
  assert.equal(s.events('final')[0].mode, 'one-shot');
  assert.equal(s.events('batch-sealed').length, 0);
});

test('the reply service connection is warmed at Start Chat and at most every 30 s at a touch-down, never with a body', async t => {
  const service = await turnsService(t, { words: OPEN, partials: [] });
  const heads = [];
  const fetcher = async (url, init) => { if (init.method === 'HEAD') { heads.push(url); return new Response(null, { status: 404 }); } return new Response('no', { status: 503 }); };
  const h = await hub(t, { services: [service], env: { ...replyEnv, ERA_CHAT_SPECULATE_MS: '0' }, fetch: fetcher });
  const s = await h.session();
  await until(() => heads.length === 1);
  assert.equal(heads[0], 'https://reply.invalid/');
  await s.ask(); await s.control('cancel'); await s.ask();
  await pause(20);
  assert.equal(heads.length, 1, 'throttled');
});

test('a long hold that falls back late is replayed with back-pressure: a slow recognizer still gets every frame', { timeout: 30000 }, async t => {
  const service = await turnsService(t, { dropAt: 140, partials: [] });
  const h = await hub(t, { services: [service], runtimeOptions: { slow: true } });
  const s = await h.session();
  await until(() => service.connections.length === 1);
  await s.ask();
  for (let i = 0; i < 140; i++) s.frame();
  await until(() => service.connections[0].frames >= 140 || service.connections[0].closed, 5000);
  await s.finish();
  await until(() => s.events('final').length === 1 || s.events('error').length === 1, 20000);
  assert.deepEqual(s.events('error'), []);
  assert.equal(s.events('final')[0].mode, 'one-shot');
  assert.equal(s.child.audioBytes, 140 * 3200);
});

// ---- pictures warmed while the partner speaks (spec 2026-10-27 §6, lexicon layer) ----
const lexicon = JSON.parse(await fs.readFile(new URL('../public/chat/lexicon.json', import.meta.url), 'utf8')).words;
// The symbol provider as the hub sees it: a cache check and a fetch that, here, never finishes.
// The curated vocabulary is pre-warmed at enable (spec §6), so its pictures are cached.
const vocabularyCached = new Set(require('../chat-symbols.js').vocabularyIds().map(Number));
function stuckProvider() {
  const calls = [];
  return { calls, pictures: { isCached: id => vocabularyCached.has(id), fetchOne: (id, { signal }) => { calls.push({ id, at: Date.now(), signal }); return new Promise(() => {}); } } };
}

test('the things named in a partial are warmed into the picture cache before release; a stuck provider never delays the batch', async t => {
  const words = 'Would you like lasagna or tacos?';
  const service = await turnsService(t, { words, partials: [[2, 'would you like lasagna'], [3, 'would you like lasagna or tacos']] });
  const provider = stuckProvider();
  const h = await hub(t, { services: [service], pictures: provider.pictures, reportUsage: true });
  const s = await h.session();
  await s.ask(); await raw(s, 4);
  await until(() => provider.calls.length === 2);
  assert.deepEqual(provider.calls.map(call => call.id), [lexicon.lasagna, lexicon.tacos]);
  assert.equal(s.events('final').length, 0, 'warmed while she is still listening');
  const released = Date.now();
  await s.finish();
  await until(() => s.events('batch-sealed').length === 1);
  assert.ok(Date.now() - released < 1500, `sealed ${Date.now() - released} ms after release with both fetches still hanging`);
  const sealed = s.events('batch-sealed')[0];
  assert.deepEqual(sealed.choices.map(choice => choice.symbolId), [lexicon.lasagna, lexicon.tacos]);
  assert.equal(sealed.pictureWarm, 2, 'test mode counts the pictures this hold warmed');
  await pause(30);
  assert.equal(provider.calls.length, 2, 'the staged choices name the same pictures: never fetched twice');
});

test('a staged choice\'s picture is warmed as it is staged; the count reaches test mode only', async t => {
  const service = await turnsService(t, { words: OPEN, partials: [] });
  const reply = replyService({ answers: { [OPEN]: { choices: [{ label: 'Burritos', say: 'Burritos, please.', symbol: 'food' },
    { label: 'Pizza', say: 'Pizza, please.', symbol: 'pizza' }, { label: 'Not sure', say: 'I am not sure.', symbol: 'not sure' }] } } });
  const cached = new Set();
  const calls = [];
  const pictures = { isCached: id => cached.has(id), fetchOne: async id => { calls.push(id); cached.add(id); return true; } };
  const h = await hub(t, { services: [service], env: { ...replyEnv, ERA_CHAT_SPECULATE_MS: '0' }, fetch: reply.fetcher, pictures });
  const s = await h.session();
  await s.ask(); await raw(s, 3); await s.finish();
  await until(() => s.events('batch-sealed').length === 1);
  await until(() => calls.length >= 3);
  assert.deepEqual(calls.slice(0, 1), [lexicon.burrito], 'the first staged choice warms first');
  assert.equal(new Set(calls).size, calls.length);
  assert.equal(s.events('batch-sealed')[0].pictureWarm, undefined, 'outside test mode the batch carries no count');
  // The next hold names the same picture: cached, nothing fetched.
  const before = calls.length;
  await s.ask(); await raw(s, 3); await s.finish();
  await until(() => s.events('batch-sealed').length === 2);
  await pause(30);
  assert.equal(calls.length, before);
});

test('warming is bounded per hold: at most six fetches, two at a time, whatever the partner lists', async t => {
  const list = 'would you like lasagna, tacos, burritos, sushi, pancakes, waffles, muffins, noodles, dumplings or pretzels';
  const service = await turnsService(t, { words: 'Okay.', partials: [[2, list]] });
  const provider = stuckProvider();
  const h = await hub(t, { services: [service], pictures: provider.pictures, reportUsage: true });
  const s = await h.session();
  await s.ask(); await raw(s, 4);
  await until(() => provider.calls.length === 2);
  await pause(60);
  assert.equal(provider.calls.length, 2, 'two at once while both hang');
  await s.finish();
  await until(() => s.events('batch-sealed').length === 1);
  const counted = s.events('batch-sealed')[0].pictureWarm;
  assert.ok(counted >= 2 && counted <= 6, `counted ${counted}`);
});
