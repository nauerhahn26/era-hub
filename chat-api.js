// Ephemeral Chat sessions. Audio and transcripts are never written to disk.
'use strict';
const { randomUUID } = require('node:crypto');
const { spawn: spawnProcess } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isLoopback } = require('./update.js');
const { createChoicesAdapter } = require('./chat-choices.js');
const { withSymbols, symbolRejected, pictureCandidates, createPictureWarmer } = require('./chat-symbols.js');
const { acceptWebSocket, refuseUpgrade } = require('./chat-ws.js');
const { createStreamTranscriber, streamSettings, loadKeyterms, keytermsFired } = require('./chat-stream.js');
const { createKeepAliveFetch } = require('./keepalive-fetch.js');

const PREFIX = '/chat/api';
const DEFAULTS = Object.freeze({ sessions: 2, idleMs: 90000, lifetimeMs: 1800000,
  bodyBytes: 8192, audioBytes: 64000, utteranceBytes: 640000, sessionBytes: 19200000,
  runtimeLineBytes: 16384, runtimeQueueBytes: 256000, adapterBytes: 32768,
  adapterMs: 15000, choices: 2, writeMs: 3000,
  // The audio socket (spec 2026-10-27 §3.1): one hold may carry 16 s of PCM16
  // at 16 kHz (the page stops at 15 s); finish waits this long for frames.
  turnBytes: 512000, drainMs: 2000,
  // The streaming transcription socket (§3.1): closed after this long idle
  // (null: 60 s for a connection-billed service, 5 min otherwise); the final
  // must arrive this long after release or the hold falls back to one-shot.
  streamIdleMs: null, streamFinalMs: 4000, streamKeepAliveMs: 5000 });
const FRAME_HEADER = 8;

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
    // The streaming service's credentials and keyterms stay in the hub (spec §3.1).
    if (builtIn ? key.startsWith('ERA_CHAT_SPEECH_') : !/^ERA_CHAT_(?:TEXT|CHOICES|STREAM)_/.test(key)) result[key] = value;
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
// Every choice leaves the hub with a decorative picture: { symbol, symbolId }.
function choiceList(items) {
  return withSymbols(items.map((item, index) => typeof item === 'string' ?
    { id: `choice-${index + 1}`, label: item, say: item } :
    { id: `choice-${index + 1}`, label: item.label, say: item.say, ...(typeof item.symbol === 'string' ? { symbol: item.symbol } : {}) }));
}
function safeTimings(value) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  for (const key of ['audioMs', 'captureWallMs', 'activityMs', 'cloudMs', 'firstPartialMs', 'finalDecodeMs', 'turnMs', 'finalizeMs', 'connectMs', 'settledMs', 'wordsSettledMs']) {
    if (Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 3600000) result[key] = value[key];
    else if (key === 'firstPartialMs' && value[key] === null) result[key] = null;
  }
  return result;
}
// The built-in reply core's token usage, for Chat test mode only: numbers and
// the configured model id. Production timing rows never take it.
function cleanUsage(value) {
  const count = x => Number.isSafeInteger(x) && x >= 0;
  if (!value || typeof value !== 'object' || !count(value.inputTokens) || !count(value.cachedTokens) || !count(value.outputTokens)) return null;
  return { model: typeof value.model === 'string' && value.model.length <= 128 ? value.model : null,
    inputTokens: value.inputTokens, cachedTokens: value.cachedTokens, outputTokens: value.outputTokens };
}
// The alternatives of an either/or are the things offered, not the sentence
// around them: "mom or dad to feed you" offers Mom and Dad; "to eat now or
// later" offers Now and Later; "pizza tonight or pasta tonight" Pizza and Pasta.
// A leading verb only the first alternative carries is shared and dropped (with
// a following preposition); in every alternative a clause or time word after
// its first word ends it.
const SHARED_VERB = /^(?:eat|drink|have|play|go|read|watch|listen|sing|do|make|see|visit|wear|sit|take|get|draw|paint|build|write|run|swim|ride|dance|cook|bake|stay|come|sleep|rest|walk|jump|climb)$/i;
const OBJECT = /^(?:a|an|the|some|my|your|this|that|these|those)$/i;
const PARTICLE = /^(?:with|to|for|at|in|on)$/i;
const TAIL = /^(?:to|for|at|in|on|with|from|after|before|tonight|today|tomorrow|now|later|first|next|please|because|so|when|feed|feeds|help|helps|read|reads|play|plays|take|takes|come|comes|bring|brings|sit|sits)$/i;
function alternativesOf(parts) {
  const words = parts.map(part => part.trim().split(/\s+/).filter(Boolean));
  let shared = false;
  if (words.length >= 2 && words[0].length > 1 && SHARED_VERB.test(words[0][0]) && words.slice(1).every(w => w.length && !SHARED_VERB.test(w[0]))) {
    // Shared only when what follows the verb is the same kind of thing as the
    // other alternatives (as long, and not the verb's own object: "play a
    // game or draw pictures" offers two activities).
    let rest = words[0].slice(1);
    if (rest.length > 1 && PARTICLE.test(rest[0])) rest = rest.slice(1);
    // A leading article or possessive is parallel only when every other
    // alternative starts with the same one ("play with my X or my Y").
    const parallel = !OBJECT.test(rest[0]) || words.slice(1).every(w => w[0].toLowerCase() === rest[0].toLowerCase());
    if (parallel && words.slice(1).every(w => w.length === rest.length)) { words[0] = rest; shared = true; }
  }
  return words.map((list, index) => {
    // A verb phrase keeps its verb, a preposition and article right after it,
    // and its object: "go to the park so we can run" is "go to the park",
    // "go outside to play" is "go outside". Elsewhere a clause or time word
    // after the first word ends the alternative.
    let from = 1;
    if (!(shared && index === 0) && list.length > 1 && SHARED_VERB.test(list[0])) {
      while (from < list.length - 1 && (PARTICLE.test(list[from]) || OBJECT.test(list[from]))) from++;
      from++;
    }
    const cut = list.findIndex((word, i) => i >= from && TAIL.test(word));
    const kept = cut > 0 ? list.slice(0, cut) : list;
    // Never a dangling "to", "the" or "a".
    while (kept.length > 1 && (PARTICLE.test(kept.at(-1)) || OBJECT.test(kept.at(-1)))) kept.pop();
    return kept.join(' ');
  });
}
// The partner's "my" is the communicator's "your" (and the other way round):
// she never claims the partner's things. A leading possessive or article that
// every alternative shares leaves the labels ("my dinosaurs or my blocks" is
// Dinosaurs / Blocks); the say keeps a flipped possessive ("Your dinosaurs").
function spokenAlternatives(parts) {
  const capital = text => text[0].toUpperCase() + text.slice(1);
  const flip = text => text.replace(/\b(my|your)\b/gi, word => /^my$/i.test(word) ? 'your' : 'my');
  const lists = parts.map(part => part.split(' '));
  const lead = lists[0][0].toLowerCase();
  const shared = OBJECT.test(lead) && lists.every(list => list.length > 1 && list[0].toLowerCase() === lead);
  return lists.map(list => {
    if (!shared) { const text = capital(flip(list.join(' '))); return { label: text, say: text }; }
    const rest = flip(list.slice(1).join(' '));
    return { label: capital(rest), say: /^(?:my|your)$/.test(lead) ? capital(flip(lead) + ' ' + rest) : capital(rest) };
  });
}
// A partner who restarts ("You want chicken and fruit? Chicken and rice.
// Meatballs or beef and mushrooms?") is read from the last question sentence
// on, together with an opener sentence just before it ("What do you like?
// Music or a story?"). Words after that question still count: they may refuse.
function lastQuestion(text, opener) {
  const sentences = text.match(/[^.?!]+[.?!]*\s*/g) || [text];
  let index = -1;
  sentences.forEach((sentence, i) => { if (/\?\s*$/.test(sentence)) index = i; });
  if (index <= 0) return text;
  if (opener.test(sentences[index - 1].trim())) index--;
  return sentences.slice(index).join('').trim();
}
const STEM = /^(?:or\s+)?(?:do you (?:want|need)(?: to)?|do you wanna|would you (?:like|prefer)(?: to)?|would you rather|should we|shall we|can we)\s+/i;
const CHOICE_PROMPT = String.raw`(?:(?:would|do) you (?:like|want|prefer|choose)(?: to)?|do you wanna|would you rather|(?:shall|should|can|could|would) we|(?:which|what) (?:would|do) you (?:like|want|prefer|choose)(?: to)?|is it)`;
const OPENER = new RegExp(String.raw`^(?:(?:hey[\s,!.?:]+)?ellie[\s,!.?:]+)?` + CHOICE_PROMPT + String.raw`\s*[:,.!?]*$`, 'i');
function localChoices(text) {
  let trimmed = lastQuestion(text, OPENER).replace(/[?.!]+$/, '').trim();
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
    const prefix = new RegExp('^' + CHOICE_PROMPT + String.raw`\s*[:,.!?]?\s+`, 'i');
    // Unrecognised question forms need context and factual grounding. Splitting
    // them can turn half a question into the communicator's spoken answer.
    // "Are you hot or are you cold?": a stem that pairs every alternative.
    const paired = /^(is it|are you)\s+/i.exec(trimmed)?.[1].toLowerCase();
    const pairedStem = paired && new RegExp(String.raw`^${paired}\s+`, 'i');
    const later = trimmed.split(/\s+or\s+/i).slice(1);
    const everyPaired = !!paired && later.every(part => pairedStem.test(part.replace(/^[\s,]+/, '')));
    if (paired && !everyPaired && later.some(part => pairedStem.test(part))) return null;
    if (!prefix.test(trimmed) && !(paired === 'are you' && everyPaired)) {
      if (/^(?:did|have|had|were|was)\s+you\b/i.test(trimmed))
        return { kind: 'guarded', generated: false, choices: choiceList([
          'Can you give me a clue?', 'Let me tell you another way.', "I don't want to answer now.",
        ]) };
      return null;
    }
    const stripped = (paired === 'are you' && everyPaired ? trimmed.replace(pairedStem, '') : trimmed.replace(prefix, '')).replace(/^either\s+/i, '');
    // "A, B, or C", "A, B or C", "A or B or C": commas list alternatives only
    // before the last "or"; after it a comma starts a clause ("dad, to help").
    const ors = stripped.split(/\s+or\s+/i), last = ors.pop().replace(/\s*,.*$/, '');
    // A question stem repeated in a later alternative ("…, or do you want to
    // stay inside?") is not part of what is offered.
    const unstem = part => part.replace(STEM, '').replace(everyPaired ? pairedStem : /^$/, '');
    const parts = alternativesOf([...ors.flatMap(part => part.replace(/\s*,\s*$/, '').split(/\s*,\s*/)), last]
      .map(part => unstem(part.replace(/[,;:]+$/, '').trim())));
    if (parts.length >= 2 && parts.length <= 4 && parts.every(p => p.length > 0 && p.length <= 55 && !/[.!?;:]/.test(p))) {
      return { kind: 'alternatives', choices: choiceList(spokenAlternatives(parts)) };
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
  // The reply service is reached over connections kept warm for the hub's
  // lifetime (spec 2026-10-27 §3.3), and warmed at each session start and touch-down.
  const ownFetch = options.fetch ? null : createKeepAliveFetch();
  const fetcher = options.fetch || ownFetch;
  let warmedAt = -Infinity;
  function warmReply() {
    if (!choicesCore.available || adapterUrl || clock() - warmedAt < 30000) return;
    warmedAt = clock();
    let origin; try { origin = new URL(env.ERA_CHAT_TEXT_URL).origin + '/'; } catch { return; }
    Promise.resolve().then(() => fetcher(origin, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) }))
      .then(response => response?.body?.cancel?.() ?? response?.body?.resume?.(), () => {});
  }
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
  // Streaming transcription (spec 2026-10-27 §3): rides on the one-shot
  // recognizer, which stays the fallback for any hold the stream cannot finish.
  const streams = runtimeAvailable ? streamSettings(env) : [];
  const streamConnect = options.streamConnect;
  const adapterRequested = typeof env.ERA_CHAT_CHOICES_URL === 'string' && !!env.ERA_CHAT_CHOICES_URL.trim();
  const adapterUrl = transportUrl(env.ERA_CHAT_CHOICES_URL);
  // Chat test mode only (spec 2026-10-27 §5): the model id and token counts reach the page while the switch is on.
  const reportUsage = () => { try { return options.reportUsage?.() === true; } catch { return false; } };
  // Two more than the HTTP route's own limit: a streaming session's speculative
  // request and its fresh one may overlap for a moment while one aborts.
  const choicesCore = createChoicesAdapter({ env, fetch: fetcher, limits: { concurrent: limits.choices + 2, timeoutMs: Math.min(limits.adapterMs, 12000) } });
  // Pictures warmed while the partner speaks (spec §6): the things a partial
  // names and each staged choice's picture go into the hub's symbol cache in
  // the background, so the reveal's <img> usually finds them there. Nothing in
  // the reply path waits for a fetch.
  const warmer = options.pictures && typeof options.pictures.fetchOne === 'function'
    ? createPictureWarmer({ isCached: options.pictures.isCached || (() => false), fetchOne: options.pictures.fetchOne }) : null;
  function warmSpoken(session, text) {
    const turn = session.turn;
    if (!warmer || !turn || turn.generation !== session.generation) return;
    try {
      turn.pictures = turn.pictures || warmer.hold();
      for (const candidate of pictureCandidates(text)) turn.pictures.add(candidate.id);
    } catch { /* A picture never holds a turn back. */ }
  }
  const speculateMs = (() => { const value = Number(env.ERA_CHAT_SPECULATE_MS ?? 300); return Number.isFinite(value) && value >= 0 && value <= 5000 ? value : 300; })();

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
    if (session.socket) { session.socket.close(1001, 'session-ended'); session.socket = null; }
    abortChoices(session);
    if (session.stream) { session.stream.close(); session.stream = null; }
    session.turn = null;
    for (const waiter of session.frameWaiters) waiter.fail();
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
      mode: 'paused', seq: 0, bytes: 0, utteranceBytes: 0, uploading: false, events: null, runtimeReady: false, closed: false,
      socket: null, socketSeq: 0, turnBytes: 0, frameWaiters: new Set(), stream: null, streamIndex: 0, turn: null, keyterms: [],
      staged: streams.length > 0, context: [], choiceJob: null };
    sessions.set(session.id, session);
    if (streams.length) { session.keyterms = loadKeyterms(env.ERA_CHAT_STREAM_KEYTERMS); startStream(session, 0); }
    warmReply();
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
          const streaming = !!session.stream;
          emit(session, { type: 'ready', sampleRate: 16000, capabilities: {
            wake: caps.wake === true, partial: caps.partial === true || streaming, automaticEndpoint: caps.automaticEndpoint === true,
            remoteFinal: caps.remoteFinal === true, remoteStreaming: caps.remoteStreaming === true || streaming,
            audioSocket: true, stagedChoices: session.staged,
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
          if (event.type === 'final') { session.mode = 'paused'; if (session.turn) session.turn.done = true; }
          emit(session, { type: event.type, text, generation: session.generation,
            ...(event.type === 'final' ? { timings: safeTimings(event.timings), ...(session.staged ? { mode: 'one-shot' } : {}) } : {}) });
          if (event.type === 'final') choicesForFinal(session, text); else warmSpoken(session, text);
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

  // ---- streaming transcription per session ----
  function startStream(session, index) {
    const settings = streams[index];
    if (!settings || session.closed) { session.stream = null; return; }
    session.streamIndex = index;
    const stream = createStreamTranscriber({ ...settings, keyterms: session.keyterms, connect: streamConnect,
      idleCloseMs: limits.streamIdleMs ?? (settings.billing === 'connection' ? 60000 : 300000),
      finalTimeoutMs: limits.streamFinalMs, keepAliveMs: limits.streamKeepAliveMs });
    session.stream = stream;
    const current = () => session.stream === stream && session.turn && session.turn.mode === 'stream' && !session.turn.done && session.turn.generation === session.generation;
    stream.on('socket', value => { if (current()) emit(session, { type: 'socket', warm: value.warm, connectMs: value.connectMs, generation: session.generation }); });
    stream.on('partial', ({ text }) => {
      const clean = cleanText(text, 2000);
      if (current() && clean && ['capturing', 'finishing'].includes(session.mode)) { emit(session, { type: 'partial', text: clean, generation: session.generation }); speculate(session, clean, false); warmSpoken(session, clean); }
    });
    stream.on('settled', ({ text }) => {
      const clean = cleanText(text, 2000);
      if (current() && clean) { emit(session, { type: 'settled', text: clean, generation: session.generation }); speculate(session, clean, true); warmSpoken(session, clean); }
    });
    stream.on('final', ({ text, timings }) => {
      if (!current()) return;
      const turn = session.turn; turn.done = true; turn.pcm = null;
      const socketSeconds = stream.takeSocketSeconds();
      session.mode = 'paused';
      const clean = cleanText(text, 2000);
      if (!clean) { emit(session, { type: 'error', error: 'no-speech', generation: session.generation }); return; }
      emit(session, { type: 'final', text: clean, generation: session.generation, mode: 'stream', setting: index === 0 ? 'primary' : 'fallback', timings: safeTimings(timings),
        ...(reportUsage() ? { usage: { socketSeconds, keytermsFired: keytermsFired(clean, session.keyterms) } } : {}) });
      choicesForFinal(session, clean);
    });
    stream.on('error', ({ code, beforeAudio }) => {
      if (code === 'open-failed' && beforeAudio && streams[index + 1] && session.stream === stream) {
        // The next holds use the fallback stream setting; this one goes one-shot.
        stream.close(); startStream(session, index + 1);
      }
      if (session.turn && session.turn.mode === 'stream' && !session.turn.done && session.turn.transcriber === stream) fallBack(session);
    });
    stream.open().catch(() => {
      if (session.stream === stream && streams[index + 1] && !(session.turn && session.turn.transcriber === stream && !session.turn.done)) { stream.close(); startStream(session, index + 1); }
    });
  }
  // The stream could not finish this hold: the one-shot recognizer gets every
  // frame of it, in order, and the release if it already happened.
  // The replay waits for each write to flush (back-pressure): a whole hold
  // written at once could overrun the recognizer's input queue. Live frames
  // and the release queue behind it, in order.
  function fallBack(session) {
    const turn = session.turn;
    turn.mode = 'one-shot';
    const pcm = turn.pcm || []; turn.pcm = null;
    if (!session.runtimeReady || session.closed) { cancelTurn(session, 'recognition-failed'); return; }
    turn.chain = Promise.resolve();
    for (const piece of pcm) queueWrite(session, turn, { type: 'audio', pcm: piece.toString('base64') });
    if (turn.released) queueWrite(session, turn, { type: 'finish' });
  }
  function queueWrite(session, turn, message) {
    turn.chain = turn.chain.then(() => {
      if (session.turn !== turn || turn.failed || session.closed) return;
      return write(session, message);
    }).catch(() => { if (session.turn === turn && !turn.failed) { turn.failed = true; cancelTurn(session, 'runtime-busy'); } });
  }
  function endStreamTurn(session) {
    const turn = session.turn;
    if (turn && turn.mode === 'stream' && !turn.done && session.stream) { turn.done = true; session.stream.cancel(); }
    session.turn = null;
  }
  function beginTurn(session) {
    endStreamTurn(session);
    const stream = session.stream;
    session.turn = { generation: session.generation, mode: stream ? 'stream' : 'one-shot', transcriber: stream, pcm: [], released: false, done: false,
      pictures: warmer ? warmer.hold() : null };
    if (stream) stream.begin();
  }
  function acceptPcm(session, pcm) {
    const turn = session.turn;
    if (turn && turn.chain && turn.generation === session.generation) { queueWrite(session, turn, { type: 'audio', pcm: pcm.toString('base64') }); return; }
    if (turn && turn.mode === 'stream' && !turn.done && turn.generation === session.generation) {
      turn.pcm.push(Buffer.from(pcm)); turn.transcriber.sendPcm(pcm); return;
    }
    forwardPcm(session, pcm);
  }

  // ---- the audio socket (spec 2026-10-27 §3.1) ----
  // A hold that cannot be completed honestly is cancelled: a new generation, the
  // recognizer told to drop it, never a short submit.
  function cancelTurn(session, error) {
    if (session.closed) return;
    const active = ['capturing', 'finishing'].includes(session.mode);
    abortChoices(session); endStreamTurn(session);
    session.generation++; session.mode = 'paused'; session.turnBytes = 0;
    write(session, { type: 'cancel' }).catch(() => {});
    if (error && active) emit(session, { type: 'error', error, generation: session.generation });
  }
  function forwardPcm(session, pcm) {
    write(session, { type: 'audio', pcm: pcm.toString('base64') }).catch(error => {
      if (error.status === 429) cancelTurn(session, 'runtime-busy');
    });
  }
  function waitForFrames(session, count) {
    if (session.socketSeq >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        check() { if (session.socketSeq >= count) { this.done(); resolve(); } },
        fail() { this.done(); reject(fault(409, 'audio-sequence')); },
        done() { clearTimeout(this.timer); session.frameWaiters.delete(this); },
      };
      waiter.timer = setTimeout(() => waiter.fail(), limits.drainMs);
      waiter.timer.unref?.();
      session.frameWaiters.add(waiter);
    });
  }
  function attachSocket(session, ws) {
    session.socket = ws; session.socketSeq = 0;
    const broken = (code, reason) => {
      if (session.socket === ws) { session.socket = null; if (['capturing', 'finishing'].includes(session.mode)) cancelTurn(session); }
      ws.close(code, reason);
    };
    ws.on('message', (data, binary) => {
      if (session.closed || session.socket !== ws) return;
      if (!binary) { broken(1003, 'binary-only'); return; }
      if (data.length < FRAME_HEADER + 2 || (data.length - FRAME_HEADER) % 2 || data.length - FRAME_HEADER > limits.audioBytes) { broken(1008, 'invalid-pcm'); return; }
      const generation = data.readUInt32LE(0), seq = data.readUInt32LE(4);
      if (seq !== session.socketSeq) { broken(1008, 'audio-sequence'); return; }
      session.socketSeq++; session.touched = clock();
      for (const waiter of [...session.frameWaiters]) waiter.check();
      // Another generation's frame, or any frame outside a hold, is dropped here.
      if (generation !== session.generation || session.mode !== 'capturing') return;
      const pcm = data.subarray(FRAME_HEADER);
      if (session.bytes + pcm.length > limits.sessionBytes || session.turnBytes + pcm.length > limits.turnBytes) { cancelTurn(session, 'audio-limit'); return; }
      session.bytes += pcm.length; session.turnBytes += pcm.length;
      acceptPcm(session, pcm);
    });
    ws.on('close', () => {
      if (session.socket !== ws) return;
      session.socket = null;
      if (['capturing', 'finishing'].includes(session.mode)) cancelTurn(session);
    });
  }
  function upgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
    if (closed) { refuseUpgrade(socket, 503); return true; }
    if (!ownRequest(req)) { refuseUpgrade(socket, 403); return true; }
    const match = /^\/sessions\/([a-f0-9-]+)\/audio$/.exec(url.pathname.slice(PREFIX.length));
    const session = match && sessions.get(match[1]);
    if (!session || session.closed) { refuseUpgrade(socket, 404); return true; }
    if (session.socket) { refuseUpgrade(socket, 409); return true; }
    const ws = acceptWebSocket(req, socket, head, { maxPayload: limits.audioBytes + FRAME_HEADER });
    if (ws) { session.touched = clock(); attachSocket(session, ws); }
    return true;
  }

  // The one choice path: local shortcuts first, then the external adapter or
  // the built-in reply core (streamed when `onChoice` listens), then the
  // published post-checks. Returns the page's body; throws a fault.
  async function produceChoices(text, context, signal, onChoice) {
    const began = clock();
    const local = localChoices(text);
    if (local) return { ...local, timings: { totalMs: Math.max(0, clock() - began) } };
    if (adapterRequested && !adapterUrl) throw fault(503, 'choices-unavailable');
    if (!adapterUrl && !choicesCore.available) return { kind: 'fallback', choices: choiceList([
      'Tell me more', "I'm not sure", 'Please say that again', "I don't want to answer",
    ]), timings: { totalMs: Math.max(0, clock() - began) } };
    try {
      let result;
      const input = { text, ...(context && context.length ? { context } : {}) };
      if (!adapterUrl) result = onChoice ? await choicesCore.generateStream(input, { signal, onChoice }) : await choicesCore.generate(input, { signal });
      else {
        const response = await fetcher(adapterUrl, { method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', ...(env.ERA_CHAT_CHOICES_TOKEN ? { Authorization: 'Bearer ' + env.ERA_CHAT_CHOICES_TOKEN } : {}) },
          body: JSON.stringify(input) });
        if (!response.ok || !response.body) throw fault(502, 'choices-unavailable');
        let size = 0, chunks = [];
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > limits.adapterBytes) throw fault(502, 'choices-invalid');
          chunks.push(Buffer.from(chunk));
        }
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault(502, 'choices-invalid'); }
      }
      const items = result && result.choices;
      if (!Array.isArray(items) || items.length < 2 || items.length > 6 || !items.every(item =>
        item && cleanText(item.label, 60) && cleanText(item.say, 300))) throw fault(502, 'choices-invalid');
      const unique = new Set(items.map(item => cleanText(item.say, 300).toLowerCase()));
      if (unique.size !== items.length) throw fault(502, 'choices-invalid');
      if (signal.aborted) throw fault(502, 'choices-unavailable');
      // How many model pictures the hub refused for the label's own (test mode counts them).
      const rejected = items.filter(item => symbolRejected({ label: cleanText(item.label, 60), say: cleanText(item.say, 300), symbol: item.symbol })).length;
      return { kind: ['guarded', 'generated'].includes(result.kind) ? result.kind : 'adapter',
        ...(['guarded', 'generated'].includes(result.kind) ? { generated: result.kind === 'generated' && result.generated === true } : {}),
        choices: choiceList(items.map(item => ({ label: cleanText(item.label, 60), say: cleanText(item.say, 300), symbol: item.symbol }))),
        ...(rejected ? { symbolRejected: rejected } : {}),
        ...(!adapterUrl && reportUsage() && cleanUsage(result.usage) ? { usage: cleanUsage(result.usage) } : {}),
        timings: { totalMs: Math.max(0, clock() - began), ...(Number.isFinite(result.timings?.firstChoiceMs) ? { firstChoiceMs: result.timings.firstChoiceMs } : {}) } };
    } catch (error) { throw error.status ? error : fault(502, 'choices-unavailable'); }
  }
  function cleanContext(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 8 || !value.every(x => cleanText(x, 500))) throw fault(400, 'invalid-context');
    return value.map(x => cleanText(x, 500));
  }
  async function generate(req, res) {
    const input = await readJson(req, limits.bodyBytes);
    const text = cleanText(input.text, 2000);
    if (!text) throw fault(400, 'invalid-text');
    const context = cleanContext(input.context);
    if (requests.size >= limits.choices && !localChoices(text)) throw fault(429, 'choices-busy');
    const controller = new AbortController(); requests.add(controller);
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    const timeout = setTimeout(() => controller.abort(), limits.adapterMs); timeout.unref();
    try { json(res, 200, await produceChoices(text, context, controller.signal)); }
    finally { clearTimeout(timeout); requests.delete(controller); res.off('close', cancel); }
  }

  // ---- hub-staged choices for streaming sessions (spec 2026-10-27 §3.3) ----
  // A job runs one choice request. While unattached (speculative) nothing of
  // it leaves the hub. Attached, each choice is staged to the page as it
  // completes and the checked batch is sealed once; a newer generation drops it.
  const normalized = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  function runChoices(session, text) {
    const turn = session.turn && session.turn.generation === session.generation ? session.turn : null;
    const job = { text, norm: normalized(text), generation: session.generation, controller: new AbortController(), staged: [],
      stagedCount: 0, result: null, error: null, done: false, attached: false, sealed: false,
      pictures: turn && turn.pictures || (warmer ? warmer.hold() : null) };
    const timeout = setTimeout(() => job.controller.abort(), limits.adapterMs); timeout.unref?.();
    produceChoices(text, session.context, job.controller.signal, choice => { job.staged.push(choice); if (job.attached) stageChoice(session, job, choice); })
      .then(result => { job.result = result; }, error => { job.error = error; })
      .finally(() => { clearTimeout(timeout); job.done = true; if (job.attached) sealChoices(session, job); });
    return job;
  }
  const liveJob = (session, job) => !session.closed && session.choiceJob === job && job.generation === session.generation && !job.sealed;
  function stageChoice(session, job, choice) {
    if (!liveJob(session, job)) return;
    const index = job.stagedCount++;
    const [pick] = choiceList([{ label: choice.label, say: choice.say, ...(typeof choice.symbol === 'string' ? { symbol: choice.symbol } : {}) }]);
    emit(session, { type: 'choice-staged', generation: job.generation, index, choice: { ...pick, id: `choice-${index + 1}` } });
    // The hub knows the picture before the page does: warm it now, behind the event.
    if (job.pictures && pick.symbolId) try { job.pictures.stage(pick.symbolId); } catch { /* decorative */ }
  }
  function sealChoices(session, job) {
    if (!liveJob(session, job)) return;
    if (job.error) { job.sealed = true; emit(session, { type: 'choices-error', error: job.error.code || 'choices-unavailable', generation: job.generation }); return; }
    // A batch that arrived whole (a shortcut, the adapter) stages each choice now.
    if (!job.stagedCount) for (const choice of job.result.choices) stageChoice(session, job, choice);
    job.sealed = true;
    emit(session, { type: 'batch-sealed', generation: job.generation, ...job.result,
      ...(reportUsage() && job.pictures ? { pictureWarm: Math.min(job.pictures.count, 12) } : {}) });
  }
  function attachChoices(session, job) {
    session.choiceJob = job; job.attached = true;
    for (const choice of job.staged) stageChoice(session, job, choice);
    if (job.done) sealChoices(session, job);
  }
  function abortChoices(session) {
    const turn = session.turn;
    if (turn) { clearTimeout(turn.stableTimer); if (turn.speculation && !turn.speculation.attached) turn.speculation.controller.abort(); turn.speculation = null; }
    if (session.choiceJob) { session.choiceJob.controller.abort(); session.choiceJob = null; }
  }
  // Speculation: a partial unchanged for ERA_CHAT_SPECULATE_MS (or words the
  // service says are settled) starts a hidden request on that text.
  function speculate(session, text, now) {
    const turn = session.turn;
    if (!speculateMs || !turn || turn.mode !== 'stream' || turn.done || turn.generation !== session.generation) return;
    clearTimeout(turn.stableTimer);
    const start = () => {
      if (session.turn !== turn || turn.done || session.closed || turn.generation !== session.generation) return;
      const norm = normalized(text);
      if (!norm || (turn.speculation && turn.speculation.norm === norm)) return;
      if (turn.speculation) { turn.speculation.controller.abort(); emit(session, { type: 'speculation', state: 'discard', generation: turn.generation }); }
      turn.speculation = runChoices(session, text);
      emit(session, { type: 'speculation', state: 'start', generation: turn.generation });
    };
    if (now) start(); else { turn.stableTimer = setTimeout(start, speculateMs); turn.stableTimer.unref?.(); }
  }
  // The final transcript is the only thing the choices commit to.
  function choicesForFinal(session, text) {
    if (!session.staged) return;
    const turn = session.turn, spec = turn && turn.speculation;
    if (turn) { clearTimeout(turn.stableTimer); turn.speculation = null; }
    if (spec && spec.norm === normalized(text) && spec.generation === session.generation && !(spec.done && spec.error)) {
      emit(session, { type: 'speculation', state: 'keep', generation: session.generation });
      attachChoices(session, spec); return;
    }
    if (spec) { spec.controller.abort(); emit(session, { type: 'speculation', state: 'discard', generation: session.generation }); }
    attachChoices(session, runChoices(session, text));
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
      if (body.type === 'finish' && body.seq !== undefined) {
        if (!Number.isSafeInteger(body.seq) || body.seq < 0) throw fault(400, 'invalid-control');
        // The page's frames travel on the socket, this request on another
        // connection: finish waits for every frame the page says it sent.
        const generation = session.generation;
        try { await waitForFrames(session, body.seq); }
        catch (error) { if (generation === session.generation) cancelTurn(session); throw error; }
        if (session.closed || generation !== session.generation) throw fault(409, 'capture-inactive');
      }
      // A hold the hub already ended (cancelled, failed, over budget) is never finished.
      if (body.type === 'finish' && session.mode !== 'capturing') throw fault(409, 'capture-inactive');
      const context = body.type === 'ask' ? cleanContext(body.context) || [] : null;
      if (body.type !== 'finish') { abortChoices(session); endStreamTurn(session); session.generation++; }
      if (context) session.context = context;
      session.mode = body.type === 'ask' ? 'capturing' : body.type === 'arm' && body.enabled ? 'armed' : body.type === 'finish' ? 'finishing' : 'paused';
      if (body.type !== 'finish') { session.utteranceBytes = 0; session.turnBytes = 0; }
      if (body.type === 'ask') { beginTurn(session); warmReply(); }
      if (body.type === 'finish' && session.turn && session.turn.generation === session.generation) {
        session.turn.released = true;
        if (session.turn.mode === 'stream' && !session.turn.done) {
          // Release finalizes the stream; the recognizer's own capture is left unused.
          session.turn.transcriber.finalize();
          return json(res, 200, { ok: true, generation: session.generation });
        }
        if (session.turn.chain) { queueWrite(session, session.turn, { type: 'finish' }); return json(res, 200, { ok: true, generation: session.generation }); }
      }
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
        const turn = session.turn;
        if (turn && turn.generation === session.generation && (turn.chain || (turn.mode === 'stream' && !turn.done))) acceptPcm(session, audio);
        else await write(session, { type: 'audio', pcm: audio.toString('base64') });
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
    upgrade,
    sweep,
    isIdle() { return sessions.size === 0 && requests.size === 0 && activeRoutes === 0; },
    close() { closed = true; clearInterval(timer); for (const session of sessions.values()) dispose(session); for (const request of requests) request.abort(); choicesCore.close(); ownFetch?.close(); },
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
    upgrade(req, socket, head) { return inner.upgrade(req, socket, head); },
    sweep() { inner.sweep(); },
    close() { closed = true; inner.close(); },
  };
}
module.exports = { createChatApi, loadChatEnvironment, ownRequest };
