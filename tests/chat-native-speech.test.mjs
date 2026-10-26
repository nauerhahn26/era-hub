import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const workerPath = new URL('../chat-speech-worker.js', import.meta.url);
const { createSpeechWorker, SpeechActivity } = require(workerPath.pathname);
const env = { ERA_CHAT_SPEECH_URL: 'https://speech.invalid/transcribe', ERA_CHAT_SPEECH_MODEL: 'configured-tier', ERA_CHAT_SPEECH_TOKEN: 'private-test-token' };
function pcm(seconds = .2, amplitude = 3000) {
  const data = Buffer.alloc(Math.round(seconds * 16000) * 2);
  for (let i = 0; i < data.length / 2; i++) data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 16000) * amplitude), i * 2);
  return data.toString('base64');
}
function setup(fetcher = async () => Response.json({ text: 'a question' }), extra = {}) {
  const events = [], calls = [];
  const worker = createSpeechWorker({ env, activity: { voiced: async () => true }, emit: e => events.push(e), fetch: (...args) => { calls.push(args); return fetcher(...args); }, ...extra });
  const send = (type, fields = {}) => worker.handle({ type, generation: 1, ...fields });
  return { worker, events, calls, send };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 15));

test('explicit hold survives speech pauses and submits exactly one authenticated WAV after release', async () => {
  const s = setup();
  s.send('audio', { pcm: pcm() });
  s.send('ask'); s.send('audio', { pcm: pcm() }); s.send('audio', { pcm: pcm(1.5, 0) });
  assert.equal(s.calls.length, 0);
  s.send('audio', { pcm: pcm() }); s.send('finish'); s.send('finish');
  await settle();
  assert.equal(s.calls.length, 1);
  const [url, init] = s.calls[0];
  assert.equal(url, env.ERA_CHAT_SPEECH_URL);
  assert.equal(init.headers.Authorization, 'Bearer private-test-token');
  assert.equal(init.redirect, 'error');
  assert.equal(init.body.get('model'), 'configured-tier');
  const wav = Buffer.from(await init.body.get('file').arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.length, 44 + 60800);
  const final = s.events.filter(e => e.type === 'final');
  assert.equal(final.length, 1); assert.equal(final[0].generation, 1);
  assert.equal(final[0].text, 'a question'); assert.equal(final[0].timings.audioMs, 1900);
  assert.equal(final[0].timings.firstPartialMs, null);
  s.worker.close();
});

test('empty, near-silent and DC-only holds never call recognition', async () => {
  for (const data of [null, pcm(.5, 0), pcm(.5, 2), Buffer.alloc(16000, 127).toString('base64')]) {
    const s = setup(); s.send('ask'); if (data) s.send('audio', { pcm: data }); s.send('finish'); await settle();
    assert.equal(s.calls.length, 0); assert.equal(s.events.at(-1).message, 'no_speech'); s.worker.close();
  }
});

test('activity rejection or inference failure prevents upload with no energy-only fallback', async () => {
  for (const activity of [{ voiced: async () => false }, { voiced: async () => { throw new Error('private model error'); } }]) {
    const s = setup(undefined, { activity }); s.send('ask'); s.send('audio', { pcm: pcm() }); s.send('finish'); await settle();
    assert.equal(s.calls.length, 0); assert.equal(s.events.at(-1).type, 'error');
    assert.ok(['no_speech', 'decode_failed'].includes(s.events.at(-1).message)); s.worker.close();
  }
});

test('activity recurrent tensors reset per question and require at least 120ms probability above threshold', async () => {
  const inputs = [];
  const ort = { Tensor: class { constructor(type, data, dims) { this.data = data; this.dims = dims; } } };
  const session = { inputNames: ['x', 'h', 'c'], outputNames: ['prob', 'new_h', 'new_c'], async run(input) {
    inputs.push(input);
    return { prob: { data: [.8] }, new_h: new ort.Tensor('float32', new Float32Array(128).fill(1), [2, 1, 64]), new_c: new ort.Tensor('float32', new Float32Array(128).fill(2), [2, 1, 64]) };
  } };
  const activity = new SpeechActivity(ort, session);
  assert.equal(await activity.voiced(Buffer.from(pcm(.096), 'base64')), false);
  assert.equal(await activity.voiced(Buffer.from(pcm(.128), 'base64')), true);
  assert.deepEqual(inputs[0].x.dims, [1, 512]); assert.deepEqual(inputs[0].h.dims, [2, 1, 64]);
  assert.equal(inputs[1].h.data[0], 1); assert.equal(inputs[1].c.data[0], 2);
  assert.equal(inputs[3].h.data[0], 0);
});

test('bundled activity model rejects actual silence, continuous tone and deterministic noise', async () => {
  const activity = await SpeechActivity.create();
  let seed = 42;
  const noise = Buffer.alloc(32000);
  for (let i = 0; i < noise.length; i += 2) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    noise.writeInt16LE(Math.round((seed / 4294967296 * 2 - 1) * 6000), i);
  }
  for (const data of [Buffer.alloc(32000), Buffer.from(pcm(1), 'base64'), noise]) assert.equal(await activity.voiced(data), false);
});

test('cancel during activity inference cannot start a subsequent upload', async () => {
  let finish;
  const s = setup(undefined, { activity: { voiced: () => new Promise(resolve => { finish = resolve; }) } });
  s.send('ask'); s.send('audio', { pcm: pcm() }); s.send('finish');
  s.send('cancel', { generation: 2 }); finish(true); await settle();
  assert.equal(s.calls.length, 0); assert.equal(s.events.length, 0); s.worker.close();
});

test('fifteen-second and shorter limits abort without final recognition', async () => {
  for (const seconds of [15, .5]) {
    const s = setup(undefined, { maxSeconds: seconds }); s.send('ask');
    for (let i = 0; i < 15; i++) s.send('audio', { pcm: pcm(1) });
    s.send('finish'); await settle();
    assert.equal(s.calls.length, 0); assert.equal(s.events.at(-1).message, 'capture_limit'); s.worker.close();
  }
});

test('pause, cancel and a newer generation abort active transport and suppress stale finals', async () => {
  for (const control of ['pause', 'cancel', 'ask', 'close']) {
    let finish;
    const s = setup(() => new Promise(resolve => { finish = resolve; }));
    s.send('ask'); s.send('audio', { pcm: pcm() }); s.send('finish'); await settle();
    s.send(control, { generation: 2 });
    assert.equal(s.calls[0][1].signal.aborted, true);
    finish(Response.json({ text: 'stale private result' })); await settle();
    assert.equal(s.events.filter(e => e.type === 'final').length, 0); s.worker.close();
  }
});

test('rapid superseding holds retain one active request and only the latest pending capture', async () => {
  const completions = [];
  const s = setup(() => new Promise(resolve => completions.push(resolve)));
  for (const generation of [1, 2, 3]) {
    s.send('ask', { generation }); s.send('audio', { generation, pcm: pcm() }); s.send('finish', { generation });
    if (generation === 1) await settle();
  }
  assert.equal(s.calls.length, 1);
  completions[0](Response.json({ text: 'old' })); await settle();
  assert.equal(s.calls.length, 2);
  completions[1](Response.json({ text: 'latest' })); await settle();
  assert.deepEqual(s.events.filter(e => e.type === 'final').map(e => [e.generation, e.text]), [[3, 'latest']]);
  s.worker.close();
});

test('stale controls/audio, malformed PCM and automatic endpoint requests cannot submit', async () => {
  const s = setup(); s.send('ask', { generation: 3 }); s.send('cancel', { generation: 2 });
  s.send('audio', { generation: 2, pcm: pcm() }); s.send('finish', { generation: 2 });
  s.send('audio', { generation: 3, pcm: 'not encoded private text!' });
  assert.equal(s.events.at(-1).message, 'invalid_audio');
  s.send('ask', { generation: 4, endpoint: 'automatic' }); s.send('audio', { generation: 4, pcm: pcm() }); s.send('finish', { generation: 4 });
  await settle(); assert.equal(s.calls.length, 0); assert.equal(s.events.at(-1).message, 'invalid_command'); s.worker.close();
});

test('empty text, oversized responses, network failures and timeouts are sanitized', async () => {
  for (const fetcher of [async () => Response.json({ text: '' }), async () => Response.json({ text: 'x'.repeat(9000) }), async () => { throw new Error('private-token and URL'); }, (_, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private timeout'))))]) {
    const s = setup(fetcher, { timeoutMs: 10 }); s.send('ask'); s.send('audio', { pcm: pcm() }); s.send('finish');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(s.events.at(-1).type, 'error'); assert.ok(['no_transcript', 'decode_failed'].includes(s.events.at(-1).message));
    assert.ok(!JSON.stringify(s.events).includes('private')); s.worker.close();
  }
});

test('redirect response never forwards credentials to the target', async t => {
  let targetCalls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/target') { targetCalls++; res.end('{"text":"bad"}'); }
    else { res.writeHead(302, { Location: '/target' }); res.end(); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const s = setup(globalThis.fetch, { env: { ...env, ERA_CHAT_SPEECH_URL: `http://127.0.0.1:${server.address().port}/redirect` } });
  s.send('ask'); s.send('audio', { pcm: pcm() }); s.send('finish');
  for (let i = 0; i < 80 && !s.events.length; i++) await settle();
  assert.equal(targetCalls, 0); assert.equal(s.events.at(-1).message, 'decode_failed'); s.worker.close();
});

test('JSONL child advertises release-only capabilities and missing config is sanitized', async () => {
  for (const configured of [true, false]) {
    const childEnv = { ...process.env, ERA_CHAT_SPEECH_URL: '', ERA_CHAT_SPEECH_MODEL: '', ERA_CHAT_SPEECH_TOKEN: '', ...(configured ? env : {}) };
    const child = spawn(process.execPath, [workerPath.pathname], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    if (configured) child.stdin.end('{"type":"close","generation":1}\n');
    const [code] = await once(child, 'close');
    const event = JSON.parse(stdout.trim()); assert.equal(stderr, '');
    if (configured) { assert.equal(code, 0); assert.equal(event.type, 'ready'); assert.equal(event.capabilities.wake, false); assert.equal(event.capabilities.partial, false); assert.equal(event.capabilities.automaticEndpoint, false); }
    else { assert.equal(code, 1); assert.deepEqual(event, { type: 'error', generation: 0, message: 'runtime_unavailable' }); }
  }
});
