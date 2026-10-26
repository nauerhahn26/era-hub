'use strict';
// Release-ended PCM transcription. Configuration and credentials stay external.
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const RATE = 16000, FRAME_SAMPLES = 320, MAX_FRAME_BYTES = 64000;

class SpeechActivity {
  constructor(ort, session) { this.ort = ort; this.session = session; }
  static async create() {
    const ort = require('./vendor/onnxruntime-web/dist/ort.node.min.js');
    ort.env.logLevel = 'error'; ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = pathToFileURL(path.join(__dirname, 'vendor/onnxruntime-web/dist')).href + '/';
    const session = await ort.InferenceSession.create(path.join(__dirname, 'vendor/models/chat-activity.onnx'), {
      executionProviders: ['wasm'], graphOptimizationLevel: 'all',
    });
    if (JSON.stringify(session.inputNames) !== '["x","h","c"]' || JSON.stringify(session.outputNames) !== '["prob","new_h","new_c"]') throw new Error('activity_unavailable');
    return new SpeechActivity(ort, session);
  }
  async voiced(pcm, signal) {
    const tensor = (data, dimensions) => new this.ort.Tensor('float32', data, dimensions);
    let h = tensor(new Float32Array(128), [2, 1, 64]), c = tensor(new Float32Array(128), [2, 1, 64]), voiced = 0;
    const inputs = this.session.inputNames, outputs = this.session.outputNames;
    for (let offset = 0; offset < pcm.length; offset += 1024) {
      if (signal?.aborted) return false;
      const samples = new Float32Array(512), count = Math.min(512, (pcm.length - offset) / 2);
      for (let i = 0; i < count; i++) samples[i] = pcm.readInt16LE(offset + i * 2) / 32768;
      const result = await this.session.run({ [inputs[0]]: tensor(samples, [1, 512]), [inputs[1]]: h, [inputs[2]]: c });
      const probability = result[outputs[0]]?.data?.[0];
      h = result[outputs[1]]; c = result[outputs[2]];
      if (!Number.isFinite(probability) || probability < 0 || probability > 1 || h?.data?.length !== 128 || c?.data?.length !== 128) throw new Error('activity_failed');
      if (probability >= .5) voiced += count;
      if (voiced >= RATE * .12) return !signal?.aborted;
    }
    return false;
  }
}

function wave(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function createSpeechWorker(options = {}) {
  const env = options.env || process.env, emit = options.emit || (() => {});
  const fetcher = options.fetch || globalThis.fetch;
  const activity = options.activity;
  const url = new URL(env.ERA_CHAT_SPEECH_URL || '');
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || !env.ERA_CHAT_SPEECH_MODEL || !env.ERA_CHAT_SPEECH_TOKEN || typeof fetcher !== 'function' || typeof activity?.voiced !== 'function') throw new Error('runtime_unavailable');
  const maxBytes = Math.floor(Math.min(15, Math.max(0, options.maxSeconds ?? 15)) * RATE) * 2;
  const timeoutMs = Math.min(30000, Math.max(1, Number(options.timeoutMs ?? env.ERA_CHAT_SPEECH_TIMEOUT_MS) || 20000));
  let generation = 0, epoch = 0, closed = false, capture = null, active = null, pending = null;
  const event = (type, fields = {}) => emit({ type, generation, ...fields });
  function abort() {
    epoch++; capture = null; pending = null;
    if (active) active.controller.abort();
  }
  function fail(message) { event('error', { message }); }
  function current(job) { return !closed && job.epoch === epoch && job.generation === generation; }
  async function responseText(response) {
    if (!response.ok || !response.body) throw new Error('decode_failed');
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) throw new Error('decode_failed');
        chunks.push(Buffer.from(value));
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof result.text !== 'string' || result.text.length > 8000) throw new Error('decode_failed');
      return result.text.trim();
    } finally { await reader.cancel().catch(() => {}); }
  }
  function start(job) {
    if (!current(job)) return;
    active = job;
    job.controller = new AbortController();
    const timer = setTimeout(() => job.controller.abort(), timeoutMs);
    const before = performance.now();
    (async () => {
      try {
        const voiced = await activity.voiced(job.pcm, job.controller.signal);
        const activityMs = performance.now() - before;
        if (!current(job)) return;
        if (job.controller.signal.aborted) throw new Error('decode_failed');
        if (!voiced) { fail('no_speech'); return; }
        const cloudBefore = performance.now();
        const body = new FormData();
        body.set('model', env.ERA_CHAT_SPEECH_MODEL);
        body.set('language', env.ERA_CHAT_SPEECH_LANGUAGE || 'en');
        body.set('file', new Blob([wave(job.pcm)], { type: 'audio/wav' }), 'question.wav');
        const response = await fetcher(url.href, { method: 'POST', headers: { Authorization: 'Bearer ' + env.ERA_CHAT_SPEECH_TOKEN }, body, redirect: 'error', signal: job.controller.signal });
        const text = await responseText(response);
        const cloudMs = performance.now() - cloudBefore;
        if (!current(job)) return;
        if (!text) { fail('no_transcript'); return; }
        event('final', { text, timings: { audioMs: job.pcm.length / 32, captureWallMs: job.captureMs,
          activityMs: +activityMs.toFixed(2), cloudMs: +cloudMs.toFixed(2),
          firstPartialMs: null, finalDecodeMs: +(performance.now() - before).toFixed(2), turnMs: +(performance.now() - job.started).toFixed(2) } });
      } catch {
        if (current(job)) fail('decode_failed');
      } finally {
        clearTimeout(timer); job.pcm = null; active = null;
        const next = pending; pending = null;
        if (next) start(next);
      }
    })();
  }
  function measure(pcm) {
    // Energy above a conservative floor rejects near-silence and DC. This is
    // not a speech classifier: ordinary background noise can pass this gate.
    for (let offset = 0; offset < pcm.length; offset += 2) {
      const value = pcm.readInt16LE(offset) / 32768;
      capture.sum += value; capture.squares += value * value; capture.frameSamples++;
      if (capture.frameSamples === FRAME_SAMPLES) {
        const variance = capture.squares / FRAME_SAMPLES - (capture.sum / FRAME_SAMPLES) ** 2;
        if (variance >= .003 ** 2) capture.energeticSamples += FRAME_SAMPLES;
        capture.sum = capture.squares = capture.frameSamples = 0;
      }
    }
  }
  function handle(message) {
    if (closed) return;
    if (!message || typeof message !== 'object' || Array.isArray(message)) { abort(); fail('invalid_command'); return; }
    const nextGeneration = message.generation ?? generation;
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration < generation) return;
    if (nextGeneration > generation) { abort(); generation = nextGeneration; }
    switch (message.type) {
      case 'close': closed = true; abort(); break;
      case 'cancel': case 'pause': abort(); break;
      case 'arm': abort(); if (message.enabled !== false) fail('invalid_command'); break;
      case 'ask':
        abort();
        if ((message.endpoint ?? 'release') !== 'release') { fail('invalid_command'); break; }
        capture = { chunks: [], bytes: 0, sum: 0, squares: 0, frameSamples: 0, energeticSamples: 0, started: performance.now() };
        break;
      case 'audio': {
        if (!capture) return;
        const encoded = message.pcm;
        if (typeof encoded !== 'string' || encoded.length > 90000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) { fail('invalid_audio'); break; }
        const pcm = Buffer.from(encoded, 'base64');
        if (!pcm.length || pcm.length % 2 || pcm.length > MAX_FRAME_BYTES) { fail('invalid_audio'); break; }
        if (capture.bytes + pcm.length >= maxBytes) { abort(); fail('capture_limit'); break; }
        capture.chunks.push(pcm); capture.bytes += pcm.length; measure(pcm);
        break;
      }
      case 'finish': {
        if (!capture) return;
        const completed = capture; capture = null;
        if (completed.energeticSamples < RATE * .12) { fail('no_speech'); break; }
        const job = { generation, epoch, started: completed.started, captureMs: +(performance.now() - completed.started).toFixed(2), pcm: Buffer.concat(completed.chunks) };
        if (active) pending = job;
        else start(job);
        break;
      }
      default: abort(); fail('invalid_command');
    }
  }
  return { handle, close() { closed = true; abort(); }, invalid() { if (!closed) { abort(); fail('invalid_command'); } } };
}

module.exports = { createSpeechWorker, SpeechActivity };
if (require.main === module) {
  (async () => {
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  let worker;
  try {
    const activity = await SpeechActivity.create();
    worker = createSpeechWorker({ emit, activity });
    emit({ type: 'ready', sampleRate: RATE, capabilities: { wake: false, partial: false, automaticEndpoint: false, referenceFinal: true, remoteFinal: true, remoteStreaming: false } });
  } catch { emit({ type: 'error', generation: 0, message: 'runtime_unavailable' }); process.exitCode = 1; }
  if (worker) {
    let buffered = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => {
      buffered += data;
      let end;
      while ((end = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        try {
          if (line.length > 100000) throw new Error();
          const message = JSON.parse(line); worker.handle(message);
          if (message?.type === 'close') { process.stdin.destroy(); break; }
        } catch { worker.invalid(); }
      }
      if (buffered.length > 100000) { buffered = ''; worker.invalid(); }
    });
    process.stdin.on('end', () => worker.close());
    process.stdin.on('error', () => worker.close());
  }
  })().catch(() => { process.stdout.write(JSON.stringify({ type: 'error', generation: 0, message: 'runtime_unavailable' }) + '\n'); process.exitCode = 1; });
}
