// Ephemeral Chat sessions. Audio and transcripts are never written to disk.
'use strict';
const { randomUUID } = require('node:crypto');
const { spawn: spawnProcess } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isLoopback } = require('./update.js');
const { createChoicesAdapter } = require('./chat-choices.js');

const PREFIX = '/chat/api';
const DEFAULTS = Object.freeze({ sessions: 2, idleMs: 90000, lifetimeMs: 1800000,
  bodyBytes: 8192, audioBytes: 64000, utteranceBytes: 640000, sessionBytes: 19200000,
  runtimeLineBytes: 16384, runtimeQueueBytes: 256000, adapterBytes: 32768,
  adapterMs: 15000, choices: 2, writeMs: 3000 });

function chatVariables(env) {
  const result = {};
  for (const [key, value] of Object.entries(env || {}))
    if (/^ERA_CHAT_[A-Z0-9_]+$/.test(key) && typeof value === 'string' && value.length <= 8192) result[key] = value;
  return result;
}
function literalValue(raw) {
  if (raw.startsWith("'")) {
    const match = /^'([^']*)'(?:\s*#.*)?$/.exec(raw);
    return match ? match[1] : null;
  }
  if (raw.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")(?:\s*#.*)?$/.exec(raw);
    if (!match) return null;
    try { return JSON.parse(match[1]); } catch { return null; }
  }
  return raw.replace(/\s+#.*$/, '').trim();
}
function loadChatEnvironment(options = {}) {
  const overrides = chatVariables(options.env === undefined ? process.env : options.env);
  if (overrides.ERA_CHAT_CONFIG_DISABLED === '1') return overrides;
  const file = options.file === undefined ? path.join(os.homedir(), '.config', 'ai', 'ai.env') : options.file;
  const fromFile = {};
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 65536) return overrides;
    const bytes = Buffer.alloc(65537), size = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (size > 65536) return overrides;
    for (const line of bytes.subarray(0, size).toString('utf8').split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?(ERA_CHAT_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const value = literalValue(match[2]);
      if (typeof value === 'string' && value.length <= 8192) fromFile[match[1]] = value;
    }
  } catch { /* Missing or unreadable private configuration means unconfigured. */ }
  finally { if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {} }
  return { ...fromFile, ...overrides };
}
function speechEnvironment(chat, system, builtIn) {
  const result = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PYTHONPATH', 'VIRTUAL_ENV'])
    if (typeof system[key] === 'string') result[key] = system[key];
  for (const [key, value] of Object.entries(chat))
    if (builtIn ? key.startsWith('ERA_CHAT_SPEECH_') : !/^ERA_CHAT_(?:TEXT|CHOICES)_/.test(key)) result[key] = value;
  return result;
}
function transportUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}

function fault(status, code) { return Object.assign(new Error(code), { status, code }); }
function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function ownRequest(req) {
  if (!isLoopback(req.socket && req.socket.remoteAddress)) return false;
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false;
  try {
    const target = new URL('http://' + req.headers.host);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (host !== 'localhost' && !isLoopback(host)) return false;
    if (req.headers.origin && new URL(req.headers.origin).origin !== target.origin) return false;
    return true;
  } catch { return false; }
}
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [], done = false;
    const stop = error => { if (!done) { done = true; chunks = []; reject(error); } };
    req.on('data', chunk => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > cap) { stop(fault(413, 'body-too-large')); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('aborted', () => stop(fault(400, 'request-aborted')));
    req.on('error', () => stop(fault(400, 'request-aborted')));
  });
}
async function readJson(req, cap) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json'))
    throw fault(415, 'json-required');
  try {
    const value = JSON.parse(String(await readBody(req, cap)));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw fault(400, 'invalid-json');
    return value;
  } catch (error) { if (error.code) throw error; throw fault(400, 'invalid-json'); }
}
function cleanText(value, cap) {
  if (typeof value !== 'string' || !value.trim() || value.length > cap || /[\x00-\x08\x0b-\x1f<>]/.test(value)) return null;
  return value.trim().replace(/\s+/g, ' ');
}
function choiceList(items) {
  return items.map((item, index) => typeof item === 'string' ?
    { id: `choice-${index + 1}`, label: item, say: item } :
    { id: `choice-${index + 1}`, label: item.label, say: item.say });
}
function safeTimings(value) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  for (const key of ['audioMs', 'captureWallMs', 'firstPartialMs', 'finalDecodeMs', 'turnMs', 'finalizeMs']) {
    if (Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 3600000) result[key] = value[key];
    else if (key === 'firstPartialMs' && value[key] === null) result[key] = null;
  }
  return result;
}
function localChoices(text) {
  let trimmed = text.replace(/[?.!]+$/, '').trim();
  const explicitAddress = /^hey[\s,!.?:]+ellie[\s,!.?:]+(.+)$/i.exec(trimmed) ||
    /^ellie\s*[,!.?:]+\s*(.+)$/i.exec(trimmed);
  const questionAddress = /^ellie\s+(.+)$/i.exec(trimmed);
  // Explicit addresses also precede statements. Without punctuation, a lone
  // name is removed only before a clear question, preserving name subjects and
  // possessives. Only local parsing changes; the transcript is kept.
  if (explicitAddress) trimmed = explicitAddress[1];
  else if (questionAddress && /^(?:(?:what|which|why|where|when|how|who|hi|hello|hey)\b|(?:do|does|did|can|could|would|will|have|has|had|shall|should|may|are|were)\s+(?:you|we)\b|(?:is|was)\s+(?:it|this|that|there)\b)/i.test(questionAddress[1]))
    trimmed = questionAddress[1];
  if (/\bor\b/i.test(trimmed)) {
    const prefix = /^(?:(?:would|do) you (?:like|want|prefer|choose)(?: to)?|would you rather|(?:shall|should|can|could|would) we|(?:which|what) (?:would|do) you (?:like|want|prefer|choose)(?: to)?|is it)\s*[:,.!?]?\s+/i;
    // Unrecognised question forms need context and factual grounding. Splitting
    // them can turn half a question into the communicator's spoken answer.
    if (!prefix.test(trimmed)) {
      if (/^(?:did|have|had|were|was)\s+you\b/i.test(trimmed))
        return { kind: 'guarded', generated: false, choices: choiceList([
          'Can you give me a clue?', 'Let me tell you another way.', "I don't want to answer now.",
        ]) };
      return null;
    }
    const stripped = trimmed.replace(prefix, '');
    const parts = stripped.split(/\s+or\s+/i);
    if (parts.length >= 2 && parts.length <= 4 && parts.every(p => p.length > 0 && p.length <= 55 && !/[.!?;:]/.test(p))) {
      return { kind: 'alternatives', choices: choiceList(parts.map(p => p[0].toUpperCase() + p.slice(1))) };
    }
    return null;
  }
  if (/^(?:is|are|was|were|do|does|did|can|could|would|will|have|has|should|may)\b/i.test(trimmed))
    return { kind: 'yes-no', choices: choiceList(['Yes', 'No', "I'm not sure", 'Please say that again']) };
  if (/^(hi|hello|hey)(?:\b|!)/i.test(trimmed))
    return { kind: 'comments', choices: choiceList(['Hello!', "It's good to see you", 'How are you?']) };
  if (/^how are you\b/i.test(trimmed))
    return { kind: 'comments', choices: choiceList(["I'm good", "I'm tired", "I'm not sure", 'How are you?']) };
  return null;
}

function createFixedChatApi(options = {}, env = chatVariables(options.env === undefined ? process.env : options.env)) {
  const spawn = options.spawn || spawnProcess;
  const fetcher = options.fetch || globalThis.fetch;
  const clock = options.clock || Date.now;
  const limits = { ...DEFAULTS, ...options.limits };
  const sessions = new Map(), requests = new Set();
  let runtimeArgs = null, closed = false, activeRoutes = 0;
  try {
    const args = JSON.parse(env.ERA_CHAT_RUNTIME_ARGS || '[]');
    if (Array.isArray(args) && args.length <= 32 && args.every(x => typeof x === 'string' && x.length <= 4096)) runtimeArgs = args;
  } catch { /* invalid configuration is unavailable */ }
  const externalRuntime = typeof env.ERA_CHAT_RUNTIME === 'string' && !!env.ERA_CHAT_RUNTIME.trim();
  let speechUrl = null;
  try {
    const parsed = new URL(transportUrl(env.ERA_CHAT_SPEECH_URL));
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) speechUrl = parsed.href;
  } catch { /* Native speech permits secure remote transport or local testing. */ }
  const speechConfigured = !!(speechUrl && env.ERA_CHAT_SPEECH_MODEL && env.ERA_CHAT_SPEECH_TOKEN);
  const workerPath = path.join(__dirname, 'chat-speech-worker.js');
  const builtIn = !externalRuntime && speechConfigured;
  const runtimeKind = externalRuntime ? 'external' : builtIn ? 'built-in' : 'unconfigured';
  const runtimeConfigured = externalRuntime || builtIn;
  const runtimeAvailable = externalRuntime ? runtimeArgs !== null : builtIn && (options.workerExists || fs.existsSync)(workerPath);
  const runtimeCommand = externalRuntime ? env.ERA_CHAT_RUNTIME : process.execPath;
  if (builtIn) runtimeArgs = [workerPath];
  const childEnv = speechEnvironment(env, options.env || process.env, builtIn);
  const adapterRequested = typeof env.ERA_CHAT_CHOICES_URL === 'string' && !!env.ERA_CHAT_CHOICES_URL.trim();
  const adapterUrl = transportUrl(env.ERA_CHAT_CHOICES_URL);
  const choicesCore = createChoicesAdapter({ env, fetch: fetcher, limits: { concurrent: limits.choices, timeoutMs: Math.min(limits.adapterMs, 12000) } });

  function emit(session, event) {
    if (session.closed) return;
    const record = { ...event, at: clock(), elapsedMs: Math.max(0, clock() - session.created) };
    const line = 'data: ' + JSON.stringify(record) + '\n\n';
    if (session.events) {
      if (session.events.writableLength > limits.runtimeQueueBytes) { dispose(session); return; }
      session.events.write(line);
    } else if (event.type === 'ready') session.ready = record;
  }
  function dispose(session) {
    if (session.closed) return;
    session.closed = true; sessions.delete(session.id);
    clearTimeout(session.killTimer);
    if (session.events) session.events.end();
    try { session.child.stdin.end(JSON.stringify({ type: 'close', generation: session.generation }) + '\n'); } catch {}
    // Only this session's child is signalled. No process group or session kill.
    session.killTimer = setTimeout(() => { try { session.child.kill('SIGKILL'); } catch {} }, 2000);
    session.killTimer.unref();
    try { session.child.kill('SIGTERM'); } catch {}
    session.ready = null;
  }
  function runtimeFailure(session, code = 'runtime-error') {
    emit(session, { type: 'error', error: code, generation: session.generation });
    dispose(session);
  }
  function write(session, message) {
    if (session.closed || !session.child.stdin || session.child.stdin.destroyed)
      return Promise.reject(fault(503, 'runtime-unavailable'));
    const line = JSON.stringify({ ...message, generation: session.generation }) + '\n';
    if (session.child.stdin.writableLength + Buffer.byteLength(line) > limits.runtimeQueueBytes)
      return Promise.reject(fault(429, 'runtime-busy'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { runtimeFailure(session); reject(fault(503, 'runtime-unavailable')); }, limits.writeMs);
      timer.unref();
      try {
        session.child.stdin.write(line, error => {
          clearTimeout(timer);
          if (error) { runtimeFailure(session); reject(fault(503, 'runtime-unavailable')); }
          else resolve();
        });
      } catch { clearTimeout(timer); runtimeFailure(session); reject(fault(503, 'runtime-unavailable')); }
    });
  }
  function startSession() {
    if (!runtimeAvailable) throw fault(503, 'runtime-unavailable');
    if (sessions.size >= limits.sessions) throw fault(429, 'session-limit');
    let child;
    try { child = spawn(runtimeCommand, runtimeArgs, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv }); }
    catch { throw fault(503, 'runtime-unavailable'); }
    const session = { id: randomUUID(), child, created: clock(), touched: clock(), generation: 0,
      mode: 'paused', seq: 0, bytes: 0, utteranceBytes: 0, uploading: false, events: null, runtimeReady: false, closed: false };
    sessions.set(session.id, session);
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (session.closed) return;
      pending += chunk;
      if (Buffer.byteLength(pending) > limits.runtimeLineBytes) { runtimeFailure(session); return; }
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { runtimeFailure(session); return; }
        if (!event || !['ready', 'wake', 'partial', 'final', 'error'].includes(event.type)) { runtimeFailure(session); return; }
        const startupError = event.type === 'error' && !session.runtimeReady && event.generation === undefined;
        if (event.type !== 'ready' && !startupError && event.generation !== session.generation) continue;
        if (event.type === 'ready') {
          session.runtimeReady = true;
          const caps = event.capabilities || {};
          emit(session, { type: 'ready', sampleRate: 16000, capabilities: {
            wake: caps.wake === true, partial: caps.partial === true, automaticEndpoint: caps.automaticEndpoint === true,
            remoteFinal: caps.remoteFinal === true, remoteStreaming: caps.remoteStreaming === true,
          } });
        } else if (event.type === 'error') {
          session.mode = 'paused';
          emit(session, { type: 'error', error: (event.error || event.message) === 'no_speech' ? 'no-speech' : 'runtime-error', generation: session.generation });
        } else if (event.type === 'wake') {
          if (session.mode !== 'armed') continue;
          session.mode = 'capturing'; session.utteranceBytes = 0;
          emit(session, { type: 'wake', generation: session.generation });
        } else {
          if (!['capturing', 'finishing'].includes(session.mode)) continue;
          const text = cleanText(event.text, 2000);
          if (!text) { if (event.type === 'final') { session.mode = 'paused'; emit(session, { type: 'error', error: 'no-speech', generation: session.generation }); } continue; }
          if (event.type === 'final') session.mode = 'paused';
          emit(session, { type: event.type, text, generation: session.generation,
            ...(event.type === 'final' ? { timings: safeTimings(event.timings) } : {}) });
        }
      }
    });
    child.stdout.on('error', () => runtimeFailure(session));
    child.stderr.on('data', () => {}); // Never log child output: it may contain speech or paths.
    child.stderr.on('error', () => {});
    child.stdin.on('error', () => runtimeFailure(session));
    child.on('error', () => runtimeFailure(session));
    child.on('exit', () => { clearTimeout(session.killTimer); if (!session.closed) runtimeFailure(session, 'runtime-stopped'); });
    return session;
  }
  function sweep() {
    const now = clock();
    for (const session of sessions.values())
      if (now - session.touched > limits.idleMs || now - session.created > limits.lifetimeMs) dispose(session);
  }
  const timer = setInterval(sweep, Math.min(limits.idleMs, 10000)); timer.unref();

  async function generate(req, res) {
    const began = clock();
    const input = await readJson(req, limits.bodyBytes);
    const text = cleanText(input.text, 2000);
    if (!text) throw fault(400, 'invalid-text');
    let context;
    if (input.context !== undefined) {
      if (!Array.isArray(input.context) || input.context.length > 8 || !input.context.every(x => cleanText(x, 500))) throw fault(400, 'invalid-context');
      context = input.context.map(x => cleanText(x, 500));
    }
    const local = localChoices(text);
    if (local) return json(res, 200, { ...local, timings: { totalMs: Math.max(0, clock() - began) } });
    if (adapterRequested && !adapterUrl) throw fault(503, 'choices-unavailable');
    if (!adapterUrl && !choicesCore.available) return json(res, 200, { kind: 'fallback', choices: choiceList([
      'Tell me more', "I'm not sure", 'Please say that again', "I don't want to answer",
    ]), timings: { totalMs: Math.max(0, clock() - began) } });
    if (requests.size >= limits.choices) throw fault(429, 'choices-busy');
    const controller = new AbortController(); requests.add(controller);
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    const timeout = setTimeout(() => controller.abort(), limits.adapterMs); timeout.unref();
    try {
      let result;
      if (!adapterUrl) result = await choicesCore.generate({ text, ...(context ? { context } : {}) }, { signal: controller.signal });
      else {
        const response = await fetcher(adapterUrl, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(env.ERA_CHAT_CHOICES_TOKEN ? { Authorization: 'Bearer ' + env.ERA_CHAT_CHOICES_TOKEN } : {}) },
          body: JSON.stringify({ text, ...(context ? { context } : {}) }) });
        if (!response.ok || !response.body) throw fault(502, 'choices-unavailable');
        let size = 0, chunks = [];
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > limits.adapterBytes) { controller.abort(); throw fault(502, 'choices-invalid'); }
          chunks.push(Buffer.from(chunk));
        }
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault(502, 'choices-invalid'); }
      }
      const items = result && result.choices;
      if (!Array.isArray(items) || items.length < 2 || items.length > 6 || !items.every(item =>
        item && cleanText(item.label, 60) && cleanText(item.say, 300))) throw fault(502, 'choices-invalid');
      const unique = new Set(items.map(item => cleanText(item.say, 300).toLowerCase()));
      if (unique.size !== items.length) throw fault(502, 'choices-invalid');
      if (controller.signal.aborted) throw fault(502, 'choices-unavailable');
      json(res, 200, { kind: ['guarded', 'generated'].includes(result.kind) ? result.kind : 'adapter',
        ...(['guarded', 'generated'].includes(result.kind) ? { generated: result.kind === 'generated' && result.generated === true } : {}),
        choices: choiceList(items.map(item => ({ label: cleanText(item.label, 60), say: cleanText(item.say, 300) }))),
        timings: { totalMs: Math.max(0, clock() - began) } });
    } catch (error) { throw error.status ? error : fault(502, 'choices-unavailable'); }
    finally { clearTimeout(timeout); requests.delete(controller); res.off('close', cancel); }
  }
  async function route(req, res, url) {
    if (closed) throw fault(503, 'chat-unavailable');
    if (!ownRequest(req)) throw fault(403, 'local-only');
    const routePath = url.pathname.slice(PREFIX.length);
    if (req.method === 'GET' && routePath === '/config') return json(res, 200, {
      wakeName: 'Ellie', runtime: { available: !!runtimeAvailable, configured: !!runtimeConfigured, kind: runtimeKind,
        status: runtimeAvailable ? 'configured' : runtimeConfigured ? 'unavailable' : 'unconfigured', capabilities: { wake: null, streaming: null } },
      choices: { available: true, kind: adapterRequested ? 'adapter' : choicesCore.available ? 'built-in' : 'local', generated: adapterRequested ? !!adapterUrl : choicesCore.available },
    });
    if (req.method === 'POST' && routePath === '/choices') return generate(req, res);
    if (req.method === 'POST' && routePath === '/sessions') {
      await readBody(req, limits.bodyBytes);
      const session = startSession(); return json(res, 201, { id: session.id });
    }
    const match = /^\/sessions\/([a-f0-9-]+)(?:\/(events|control|audio))?$/.exec(routePath);
    if (!match) throw fault(404, 'not-found');
    const session = sessions.get(match[1]);
    if (!session || session.closed) throw fault(404, 'session-not-found');
    session.touched = clock();
    if (req.method === 'GET' && !match[2]) return json(res, 200, { ready: session.runtimeReady, mode: session.mode });
    if (req.method === 'DELETE' && !match[2]) { dispose(session); return json(res, 200, { closed: true }); }
    if (req.method === 'GET' && match[2] === 'events') {
      if (session.events) throw fault(409, 'events-already-open');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n'); session.events = res;
      if (session.ready) { res.write('data: ' + JSON.stringify(session.ready) + '\n\n'); session.ready = null; }
      res.once('close', () => dispose(session)); return;
    }
    if (req.method === 'POST' && match[2] === 'control') {
      const body = await readJson(req, limits.bodyBytes);
      if (!['arm', 'ask', 'finish', 'cancel', 'pause', 'close'].includes(body.type) ||
        (body.type === 'arm' && typeof body.enabled !== 'boolean')) throw fault(400, 'invalid-control');
      if (body.type === 'close') { dispose(session); return json(res, 200, { closed: true }); }
      if (body.type !== 'finish') session.generation++;
      session.mode = body.type === 'ask' ? 'capturing' : body.type === 'arm' && body.enabled ? 'armed' : body.type === 'finish' ? 'finishing' : 'paused';
      if (body.type !== 'finish') session.utteranceBytes = 0;
      await write(session, { type: body.type, ...(body.type === 'arm' ? { enabled: body.enabled } : {}) });
      return json(res, 200, { ok: true, generation: session.generation });
    }
    if (req.method === 'POST' && match[2] === 'audio') {
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/octet-stream')) throw fault(415, 'pcm-required');
      if (!['armed', 'capturing'].includes(session.mode)) throw fault(409, 'capture-inactive');
      const seq = url.searchParams.get('seq');
      if (!/^\d+$/.test(seq || '') || !Number.isSafeInteger(Number(seq)) || Number(seq) !== session.seq || session.uploading) throw fault(409, 'audio-sequence');
      const generation = session.generation; session.uploading = true;
      try {
        const audio = await readBody(req, limits.audioBytes);
        if (session.closed || generation !== session.generation || !['armed', 'capturing'].includes(session.mode)) throw fault(409, 'capture-inactive');
        if (!audio.length || audio.length % 2) throw fault(400, 'invalid-pcm');
        if (session.bytes + audio.length > limits.sessionBytes ||
          (session.mode === 'capturing' && session.utteranceBytes + audio.length > limits.utteranceBytes)) {
          session.generation++; session.mode = 'paused'; await write(session, { type: 'cancel' }); throw fault(413, 'audio-limit');
        }
        session.bytes += audio.length;
        if (session.mode === 'capturing') session.utteranceBytes += audio.length;
        await write(session, { type: 'audio', pcm: audio.toString('base64') });
        session.seq++; return json(res, 200, { ok: true, seq: session.seq });
      } finally { session.uploading = false; }
    }
    throw fault(405, 'method-not-allowed');
  }
  return {
    handle(req, res) {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
      if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
      activeRoutes++;
      route(req, res, url).catch(error => json(res, error.status || 500, { error: error.code || 'chat-error' }))
        .finally(() => { activeRoutes--; });
      return true;
    },
    sweep,
    isIdle() { return sessions.size === 0 && requests.size === 0 && activeRoutes === 0; },
    close() { closed = true; clearInterval(timer); for (const session of sessions.values()) dispose(session); for (const request of requests) request.abort(); choicesCore.close(); },
  };
}

function createChatApi(options = {}) {
  // Explicit environments stay isolated unless the caller names a private file.
  if (options.env !== undefined && options.configPath === undefined) return createFixedChatApi(options);
  const load = () => loadChatEnvironment({ env: options.env, file: options.configPath });
  const stamp = env => JSON.stringify(Object.keys(env).sort().map(key => [key, env[key]]));
  const initial = load();
  let fingerprint = stamp(initial), inner = createFixedChatApi(options, initial), closed = false;
  return {
    handle(req, res) {
      let boundary = false;
      try {
        const url = new URL(req.url, 'http://localhost');
        boundary = req.method === 'GET' && url.pathname === PREFIX + '/config' ||
          req.method === 'POST' && url.pathname === PREFIX + '/sessions';
      } catch { /* The inner router handles malformed URLs. */ }
      if (!closed && boundary && inner.isIdle() && ownRequest(req)) {
        const next = load(), nextFingerprint = stamp(next);
        if (nextFingerprint !== fingerprint) {
          const replacement = createFixedChatApi(options, next);
          inner.close(); inner = replacement; fingerprint = nextFingerprint;
        }
      }
      return inner.handle(req, res);
    },
    sweep() { inner.sweep(); },
    close() { closed = true; inner.close(); },
  };
}
module.exports = { createChatApi, loadChatEnvironment };
