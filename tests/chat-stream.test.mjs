// chat-stream.js: the hub's streaming transcription client (real-time chat
// spec 2026-10-27 §3.1-§3.2), one protocol-neutral interface over two wire
// shapes ported from the phase-0 bake-off (tools/chat-bakeoff.py). Fake
// services on loopback replay the recorded message shapes of the bake-off's
// self-test fakes; no credentials, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStreamTranscriber, keytermsFired, loadKeyterms, streamSettings } = require('../chat-stream.js');
const { acceptWebSocket } = require('../chat-ws.js');

const until = async (check, ms = 3000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)); } };
const pause = ms => new Promise(r => setTimeout(r, ms));

// A fake service: `script(conn)` drives one connection; every connection is recorded.
async function fake(t, script, { refuse = false } = {}) {
  const connections = [];
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    if (refuse) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    const ws = acceptWebSocket(req, socket, head);
    const conn = { url: new URL(req.url, 'http://x'), headers: req.headers, binary: [], bytes: [], texts: [], closed: false, ws,
      send: value => ws.send(typeof value === 'string' ? value : JSON.stringify(value)) };
    connections.push(conn);
    ws.on('message', (data, binary) => {
      if (binary) { conn.binary.push(data.length); conn.bytes.push(data); conn.onAudio?.(conn.binary.length, data); }
      else { const value = JSON.parse(data); conn.texts.push(value); conn.onText?.(value); }
    });
    ws.on('close', () => { conn.closed = true; });
    script(conn);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const c of connections) c.ws.terminate(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  return { url: `ws://127.0.0.1:${server.address().port}/v3/ws`, connections };
}
const turn = (text, { end = false, order = 0 } = {}) => ({ type: 'Turn', turn_order: order, end_of_turn: end, turn_is_formatted: end, transcript: text });
// The turn-streaming fake (bake-off fake_streaming_turns): Begin, partials as
// audio arrives, and at the forced endpoint the question's tail lands as a
// further turn; Termination answers Terminate.
function turnsScript({ split = true, partials = [[2, 'is ellie'], [3, 'is ellie coming']] } = {}) {
  return conn => {
    conn.send({ type: 'Begin', id: 'x', expires_at: 0 });
    conn.onAudio = count => { for (const [at, text] of partials) if (count === at) conn.send(turn(text)); };
    conn.onText = value => {
      if (value.type === 'ForceEndpoint') {
        if (split) { conn.send(turn('Is Ellie coming to the', { end: true })); conn.send(turn('party', { order: 1 })); conn.send(turn('party?', { end: true, order: 1 })); }
        else conn.send(turn('Is Ellie coming to the party?', { end: true }));
      } else if (value.type === 'Terminate') { conn.send({ type: 'Termination', audio_duration_seconds: 1 }); setTimeout(() => conn.ws.close(1000), 5); }
    };
  };
}
const results = (text, { final = false, fromFinalize = false } = {}) => ({ type: 'Results', is_final: final, speech_final: final, from_finalize: fromFinalize,
  channel: { alternatives: [{ transcript: text, confidence: 0.9 }] } });
// The listen-query fake (bake-off fake_listen_v1).
function listenScript(conn) {
  conn.onAudio = count => {
    if (count === 2) conn.send(results('do you'));
    if (count === 3) conn.send(results('do you want', { final: true }));
  };
  conn.onText = value => {
    if (value.type === 'Finalize') conn.send(results('music or a story', { final: true, fromFinalize: true }));
    if (value.type === 'CloseStream') { conn.send({ type: 'Metadata', request_id: 'x' }); setTimeout(() => conn.ws.close(1000), 5); }
  };
}
const frame = (ms = 100, fill = 1) => Buffer.alloc(32 * ms, fill);
function collect(stream) {
  const events = [];
  for (const type of ['partial', 'settled', 'final', 'error', 'socket']) stream.on(type, value => events.push({ type, ...value }));
  return events;
}
function transcriber(t, service, extra = {}) {
  const stream = createStreamTranscriber({ protocol: 'ws-streaming-turns', url: service.url, model: 'stream-model', token: 'stream-secret',
    keyterms: ['Ellie', 'Saturday club'], idleCloseMs: 60000, finalTimeoutMs: 2000, ...extra });
  t.after(() => stream.close());
  return stream;
}

test('turn streaming: open carries the settings in the query, keyterms as one JSON list, the raw token in Authorization', async t => {
  const service = await fake(t, turnsScript());
  const stream = transcriber(t, service);
  await stream.open();
  const [conn] = service.connections, q = conn.url.searchParams;
  assert.equal(q.get('sample_rate'), '16000'); assert.equal(q.get('encoding'), 'pcm_s16le'); assert.equal(q.get('speech_model'), 'stream-model');
  assert.equal(q.get('format_turns'), 'false');
  assert.deepEqual(JSON.parse(q.get('keyterms_prompt')), ['Ellie', 'Saturday club']);
  assert.equal(conn.headers.authorization, 'stream-secret');
  assert.ok(!conn.url.href.includes('stream-secret'), 'the token never rides in the URL');
});

test('turn streaming: partials arrive in order, the turn split at release is joined, settled comes before final', async t => {
  const service = await fake(t, turnsScript());
  const stream = transcriber(t, service), events = collect(stream);
  await stream.open();
  stream.begin();
  for (let i = 0; i < 4; i++) { stream.sendPcm(frame()); await pause(10); }
  await until(() => events.filter(e => e.type === 'partial').length === 2);
  stream.finalize();
  await until(() => events.some(e => e.type === 'final'));
  assert.deepEqual(events.filter(e => e.type === 'partial').map(e => e.text).slice(0, 2), ['is ellie', 'is ellie coming']);
  const settled = events.find(e => e.type === 'settled'), final = events.find(e => e.type === 'final');
  assert.equal(settled.text, 'Is Ellie coming to the', 'settled: no turn open after the forced endpoint');
  assert.equal(final.text, 'Is Ellie coming to the party?', 'final: every turn of the hold joined at Termination');
  assert.ok(events.indexOf(settled) < events.indexOf(final));
  assert.deepEqual(service.connections[0].texts.map(x => x.type), ['ForceEndpoint', 'Terminate']);
  assert.ok(Number.isFinite(final.timings.finalizeMs) && Number.isFinite(final.timings.firstPartialMs));
  assert.equal(final.timings.audioMs, 400);
});

test('turn streaming: without a split the settled words equal the final', async t => {
  const service = await fake(t, turnsScript({ split: false }));
  const stream = transcriber(t, service), events = collect(stream);
  stream.begin(); for (let i = 0; i < 3; i++) stream.sendPcm(frame());
  stream.finalize();
  await until(() => events.some(e => e.type === 'final'));
  assert.equal(events.find(e => e.type === 'settled').text, events.find(e => e.type === 'final').text);
});

test('turn streaming: messages hold 20 ms or more: small frames are joined and the release tail is padded', async t => {
  const service = await fake(t, turnsScript({ split: false, partials: [] }));
  const stream = transcriber(t, service), events = collect(stream);
  await stream.open();
  stream.begin();
  stream.sendPcm(Buffer.alloc(200, 1)); stream.sendPcm(Buffer.alloc(300, 2)); stream.sendPcm(Buffer.alloc(400, 3)); stream.sendPcm(frame()); stream.sendPcm(Buffer.alloc(100, 4));
  stream.finalize();
  await until(() => events.some(e => e.type === 'final'));
  const sizes = service.connections[0].binary;
  assert.ok(sizes.every(size => size >= 640 && size <= 32000), JSON.stringify(sizes));
  assert.equal(sizes.reduce((a, b) => a + b, 0) >= 200 + 300 + 400 + 3200 + 100, true);
  const all = Buffer.concat(service.connections[0].bytes);
  assert.equal(all[0], 1); assert.equal(all[200], 2); assert.equal(all[500], 3); assert.equal(all[900 + 3200], 4, 'order kept');
});

test('turn streaming: audio sent before the socket is open is queued in order; after Termination a fresh socket is warmed', async t => {
  const service = await fake(t, turnsScript({ split: false }));
  const stream = transcriber(t, service), events = collect(stream);
  stream.begin(); // touch-down with no socket yet: connect now
  stream.sendPcm(frame(100, 7)); stream.sendPcm(frame(100, 8));
  stream.finalize();
  await until(() => events.some(e => e.type === 'final'));
  assert.equal(service.connections[0].bytes[0][0], 7); assert.equal(service.connections[0].bytes[1][0], 8);
  const socket = events.find(e => e.type === 'socket');
  assert.equal(socket.warm, false); assert.ok(socket.connectMs >= 0);
  assert.equal(events.find(e => e.type === 'final').timings.connectMs, socket.connectMs);
  await until(() => service.connections.length === 2 && stream.state === 'open');
  await until(() => service.connections[0].closed, 1500);
  stream.begin();
  assert.equal(events.filter(e => e.type === 'socket').at(-1).warm, true, 'the next hold starts on the warm socket');
});

test('connection billing: an idle socket is closed after the bounded quiet period and reopened at the next touch-down', async t => {
  const service = await fake(t, turnsScript({ split: false }));
  const stream = transcriber(t, service, { idleCloseMs: 80 });
  await stream.open();
  await until(() => service.connections[0].closed);
  assert.equal(service.connections[0].texts.at(-1).type, 'Terminate', 'closed politely');
  stream.begin(); stream.sendPcm(frame());
  await until(() => service.connections.length === 2 && service.connections[1].binary.length === 1);
  assert.ok(stream.takeSocketSeconds() > 0);
  assert.equal(stream.takeSocketSeconds(), 0, 'socket seconds are reported once');
});

test('listen query: settings and repeated keyterm params, Token auth, Finalize answers the turn and the socket stays warm with KeepAlive', async t => {
  const service = await fake(t, listenScript);
  const stream = transcriber(t, service, { protocol: 'ws-listen-query', model: 'listen-model', keepAliveMs: 40 }), events = collect(stream);
  await stream.open();
  const [conn] = service.connections, q = conn.url.searchParams;
  assert.equal(q.get('model'), 'listen-model'); assert.equal(q.get('encoding'), 'linear16'); assert.equal(q.get('sample_rate'), '16000');
  assert.equal(q.get('channels'), '1'); assert.equal(q.get('interim_results'), 'true');
  assert.deepEqual(q.getAll('keyterm'), ['Ellie', 'Saturday club']);
  assert.equal(conn.headers.authorization, 'Token stream-secret');
  stream.begin(); for (let i = 0; i < 4; i++) { stream.sendPcm(frame()); await pause(5); }
  await until(() => events.filter(e => e.type === 'partial').length >= 2);
  stream.finalize();
  await until(() => events.some(e => e.type === 'final'));
  assert.deepEqual(events.filter(e => e.type === 'partial').map(e => e.text).slice(0, 2), ['do you', 'do you want']);
  assert.equal(events.find(e => e.type === 'final').text, 'do you want music or a story');
  assert.equal(events.find(e => e.type === 'settled').text, 'do you want music or a story');
  await pause(120);
  assert.ok(conn.texts.some(x => x.type === 'KeepAlive'), 'idle keepalive');
  assert.equal(conn.closed, false);
  stream.begin(); stream.sendPcm(frame()); stream.finalize();
  await until(() => events.filter(e => e.type === 'final').length === 2);
  assert.equal(service.connections.length, 1, 'the second hold used the same socket');
});

test('an open that the service refuses reports an error before any audio', async t => {
  const service = await fake(t, () => {}, { refuse: true });
  const stream = transcriber(t, service), events = collect(stream);
  stream.begin(); stream.sendPcm(frame());
  await until(() => events.some(e => e.type === 'error'));
  const error = events.find(e => e.type === 'error');
  assert.equal(error.code, 'open-failed'); assert.equal(error.beforeAudio, true);
  assert.equal(events.some(e => e.type === 'final'), false);
});

test('a socket lost mid-turn is an error and never a final', async t => {
  const service = await fake(t, conn => { conn.send({ type: 'Begin' }); conn.onAudio = count => { if (count === 2) conn.ws.terminate(); }; });
  const stream = transcriber(t, service), events = collect(stream);
  await stream.open(); stream.begin();
  for (let i = 0; i < 3; i++) { stream.sendPcm(frame()); await pause(10); }
  await until(() => events.some(e => e.type === 'error'));
  assert.equal(events.find(e => e.type === 'error').code, 'socket-lost');
  stream.finalize(); await pause(50);
  assert.equal(events.some(e => e.type === 'final'), false);
});

test('a service error message fails the turn; a final that never comes times out', async t => {
  const failing = await fake(t, conn => { conn.send({ type: 'Begin' }); conn.onAudio = () => conn.send({ type: 'Error', error: 'Input Duration Violation' }); });
  const a = transcriber(t, failing), aEvents = collect(a);
  a.begin(); a.sendPcm(frame());
  await until(() => aEvents.some(e => e.type === 'error'));
  assert.equal(aEvents.find(e => e.type === 'error').code, 'service-error');
  const silent = await fake(t, conn => conn.send({ type: 'Begin' }));
  const b = transcriber(t, silent, { finalTimeoutMs: 60 }), bEvents = collect(b);
  b.begin(); b.sendPcm(frame()); b.finalize();
  await until(() => bEvents.some(e => e.type === 'error'));
  assert.equal(bEvents.find(e => e.type === 'error').code, 'final-timeout');
});

test('cancel drops the turn: its late messages never surface and the next hold starts clean', async t => {
  const service = await fake(t, turnsScript({ split: false }));
  const stream = transcriber(t, service), events = collect(stream);
  await stream.open(); stream.begin();
  stream.sendPcm(frame()); stream.sendPcm(frame());
  await until(() => events.some(e => e.type === 'partial'));
  const before = events.length;
  stream.cancel();
  service.connections[0].send(turn('stale words', { end: true }));
  await pause(50);
  assert.equal(events.slice(before).some(e => ['partial', 'settled', 'final'].includes(e.type)), false);
  stream.begin(); for (let i = 0; i < 3; i++) stream.sendPcm(frame()); stream.finalize();
  await until(() => events.some(e => e.type === 'final'));
  assert.equal(events.find(e => e.type === 'final').text, 'Is Ellie coming to the party?');
});

test('keyterms that fired are counted, never listed; the keyterm file is bounded and private', async t => {
  assert.equal(keytermsFired('Is Ellie coming to the Saturday club, ellie?', ['Ellie', 'Saturday club', 'Bob']), 2);
  assert.equal(keytermsFired('Bobcat', ['Bob']), 0);
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'era-keyterms-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'a.json'), JSON.stringify({ keyterms: ['One', ' Two ', 'One', 7, 'x'.repeat(80)] }));
  assert.deepEqual(loadKeyterms(path.join(dir, 'a.json')), ['One', 'Two']);
  await fs.writeFile(path.join(dir, 'b.json'), JSON.stringify(Array.from({ length: 300 }, (_, i) => 'term' + i)));
  assert.equal(loadKeyterms(path.join(dir, 'b.json')).length, 100);
  assert.deepEqual(loadKeyterms(path.join(dir, 'missing.json')), []);
});

test('stream settings: a complete primary and fallback in order; incomplete or insecure settings are absent', () => {
  const env = { ERA_CHAT_STREAM_PROTOCOL: 'ws-streaming-turns', ERA_CHAT_STREAM_URL: 'wss://turns.example/v3/ws', ERA_CHAT_STREAM_MODEL: 'm1', ERA_CHAT_STREAM_TOKEN: 't1',
    ERA_CHAT_STREAM_BILLING: 'connection', ERA_CHAT_STREAM_FALLBACK_PROTOCOL: 'ws-listen-query', ERA_CHAT_STREAM_FALLBACK_URL: 'wss://listen.example/v1/listen',
    ERA_CHAT_STREAM_FALLBACK_MODEL: 'm2', ERA_CHAT_STREAM_FALLBACK_TOKEN: 't2' };
  const settings = streamSettings(env);
  assert.deepEqual(settings.map(s => [s.protocol, s.model, s.billing]), [['ws-streaming-turns', 'm1', 'connection'], ['ws-listen-query', 'm2', 'audio']]);
  assert.deepEqual(streamSettings({ ...env, ERA_CHAT_STREAM_URL: 'ws://turns.example/v3/ws' }).map(s => s.model), ['m2'], 'plain ws only to loopback');
  assert.deepEqual(streamSettings({ ...env, ERA_CHAT_STREAM_PROTOCOL: 'unknown-shape', ERA_CHAT_STREAM_FALLBACK_TOKEN: '' }), []);
  assert.equal(streamSettings({ ...env, ERA_CHAT_STREAM_URL: 'ws://127.0.0.1:9/x' })[0].model, 'm1');
  assert.deepEqual(streamSettings({ ...env, ERA_CHAT_STREAM_QUERY: '{"format_turns":true}' })[0].query, { format_turns: true });
});

test('the payload ships every hub module the Chat API loads, transitively', async () => {
  const fs = await import('node:fs'), path = await import('node:path');
  const hub = new URL('../', import.meta.url).pathname;
  const copied = new Set([...fs.readFileSync(path.join(hub, 'tools', 'build-payload.sh'), 'utf8').matchAll(/"\$HUB\/([A-Za-z0-9._-]+\.js)"/g)].map(m => m[1]));
  // chat-world.js is loaded by the hub beside the Chat API and handed to it.
  const seen = new Set(), queue = ['chat-api.js', 'chat-world.js'];
  while (queue.length) {
    const file = queue.shift(); if (seen.has(file)) continue; seen.add(file);
    for (const [, name] of fs.readFileSync(path.join(hub, file), 'utf8').matchAll(/require\('\.\/([A-Za-z0-9._-]+\.js)'\)/g)) queue.push(name);
  }
  for (const file of seen) assert.ok(copied.has(file), file + ' is copied into the payload');
});

// Button press to ask (design 2026-10-27 §4.4, plan T0.1): a window turn spans
// several utterances. The service's own end of turn is surfaced as 'turn-end'
// and nothing is finalized or terminated per utterance.
function collectWindow(stream) {
  const events = collect(stream);
  stream.on('turn-end', value => events.push({ type: 'turn-end', ...value }));
  return events;
}
function windowTurnsScript(conn) {
  conn.send({ type: 'Begin', id: 'x', expires_at: 0 });
  conn.onAudio = count => {
    if (count === 2) conn.send(turn('do you want chicken'));
    if (count === 3) conn.send(turn('Do you want chicken or fish?', { end: true }));
    if (count === 5) conn.send(turn('or pasta', { order: 1 }));
    if (count === 6) conn.send(turn('Or pasta?', { end: true, order: 1 }));
  };
  conn.onText = value => {
    if (value.type === 'Terminate') { conn.send({ type: 'Termination', audio_duration_seconds: 1 }); setTimeout(() => conn.ws.close(1000), 5); }
  };
}

test('window turn, turn streaming: each end of turn is a turn-end with that utterance, the socket stays open, finalize joins them', async t => {
  const service = await fake(t, windowTurnsScript);
  const stream = transcriber(t, service), events = collectWindow(stream);
  await stream.open();
  stream.begin({ window: true });
  for (let i = 0; i < 3; i++) { stream.sendPcm(frame()); await pause(10); }
  await until(() => events.some(e => e.type === 'turn-end'));
  assert.deepEqual(events.filter(e => e.type === 'turn-end').map(e => e.text), ['Do you want chicken or fish?']);
  assert.deepEqual(service.connections[0].texts, [], 'nothing finalized or terminated per utterance');
  assert.equal(events.some(e => ['settled', 'final'].includes(e.type)), false);
  for (let i = 0; i < 3; i++) { stream.sendPcm(frame()); await pause(10); }
  await until(() => events.filter(e => e.type === 'turn-end').length === 2);
  assert.equal(events.filter(e => e.type === 'turn-end')[1].text, 'Or pasta?');
  assert.equal(service.connections[0].closed, false);
  assert.equal(service.connections.length, 1, 'one socket for the whole window');
  stream.finalize();
  await until(() => events.some(e => e.type === 'final'));
  assert.equal(events.find(e => e.type === 'final').text, 'Do you want chicken or fish? Or pasta?');
});

test('a hold turn never emits turn-end (hold behaviour unchanged)', async t => {
  const service = await fake(t, windowTurnsScript);
  const stream = transcriber(t, service), events = collectWindow(stream);
  await stream.open(); stream.begin();
  for (let i = 0; i < 6; i++) { stream.sendPcm(frame()); await pause(10); }
  await until(() => events.filter(e => e.type === 'partial').length >= 3);
  await pause(30);
  assert.equal(events.some(e => e.type === 'turn-end'), false);
});

test('window turn, listen query: speech_final is a turn-end with the words since the last one; without it, never', async t => {
  const service = await fake(t, conn => {
    conn.onAudio = count => {
      if (count === 1) conn.send({ ...results('do you want', { final: true }), speech_final: false });
      if (count === 2) conn.send({ ...results('chicken or fish', { final: true }), speech_final: true });
      if (count === 3) conn.send({ ...results('or pasta', { final: true }), speech_final: undefined });
      if (count === 4) conn.send({ ...results('please', { final: true }), speech_final: true });
    };
    conn.onText = value => { if (value.type === 'Finalize') conn.send(results('', { final: true, fromFinalize: true })); };
  });
  const stream = transcriber(t, service, { protocol: 'ws-listen-query', model: 'listen-model' }), events = collectWindow(stream);
  await stream.open(); stream.begin({ window: true });
  for (let i = 0; i < 4; i++) { stream.sendPcm(frame()); await pause(10); }
  await until(() => events.filter(e => e.type === 'turn-end').length === 2);
  assert.deepEqual(events.filter(e => e.type === 'turn-end').map(e => e.text), ['do you want chicken or fish', 'or pasta please']);
  assert.deepEqual(service.connections[0].texts.filter(x => x.type !== 'KeepAlive'), [], 'no Finalize per utterance');
});

// A second press or the window's cap finalizes the window turn mid-utterance
// (review fix): the utterance in flight lands in the final, which carries the
// whole window text; an end of turn arriving while finalizing is no turn-end.
test('window turn finalized mid-utterance: the final is the whole window text with the words that arrive after the finalize', async t => {
  const service = await fake(t, conn => {
    conn.send({ type: 'Begin', id: 'x', expires_at: 0 });
    conn.onAudio = count => {
      if (count === 2) conn.send(turn('Chicken or fish?', { end: true }));
      if (count === 3) conn.send(turn('or pas', { order: 1 }));
    };
    conn.onText = value => {
      if (value.type === 'ForceEndpoint') conn.send(turn('Or pasta?', { end: true, order: 1 }));
      if (value.type === 'Terminate') { conn.send({ type: 'Termination', audio_duration_seconds: 1 }); setTimeout(() => conn.ws.close(1000), 5); }
    };
  });
  const stream = transcriber(t, service), events = collectWindow(stream);
  await stream.open(); stream.begin({ window: true });
  for (let i = 0; i < 3; i++) { stream.sendPcm(frame()); await pause(10); }
  await until(() => events.some(e => e.type === 'partial' && e.text.endsWith('or pas')));
  stream.finalize();
  await until(() => events.some(e => e.type === 'final'));
  assert.equal(events.find(e => e.type === 'final').text, 'Chicken or fish? Or pasta?');
  assert.deepEqual(events.filter(e => e.type === 'turn-end').map(e => e.text), ['Chicken or fish?'], 'the end of turn during the finalize is the final, not a turn-end');
  const listen = await fake(t, conn => {
    conn.onAudio = count => {
      if (count === 1) conn.send({ ...results('chicken or fish', { final: true }), speech_final: true });
      if (count === 2) conn.send(results('or pas'));
    };
    conn.onText = value => { if (value.type === 'Finalize') conn.send(results('or pasta', { final: true, fromFinalize: true })); };
  });
  const s2 = transcriber(t, listen, { protocol: 'ws-listen-query', model: 'listen-model' }), e2 = collectWindow(s2);
  await s2.open(); s2.begin({ window: true });
  for (let i = 0; i < 2; i++) { s2.sendPcm(frame()); await pause(10); }
  await until(() => e2.some(e => e.type === 'partial' && e.text.endsWith('or pas')));
  s2.finalize();
  await until(() => e2.some(e => e.type === 'final'));
  assert.equal(e2.find(e => e.type === 'final').text, 'chicken or fish or pasta');
});
