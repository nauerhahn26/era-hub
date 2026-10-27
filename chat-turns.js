// Chat test mode (real-time chat spec 2026-10-27 §5). A separate, explicit,
// per-device switch: while app-settings.json has chatTestMode === true the
// page posts one record per turn (timeline, words, usage, device health) and
// may store the held question's audio. Off, every route here is a 404 and
// nothing is written. The production timing rows (chat-store.js) are not
// touched by this module and stay content-free in both modes.
//   POST   /chat/api/turns              one turn -> logs/chat-turns/<day>.jsonl + pool "chat-turn"
//   PUT    /chat/api/turns/<id>/audio   PCM16 16 kHz mono, <= 15 s -> logs/chat-turns/audio/<id>.wav
//   GET    /chat/api/turns              the last ten turns and per-build summaries
//   DELETE /chat/api/turns              the partner's "delete test recordings" (works on or off):
//                                       day files, audio, and this device's own pool chat-turn lines
//   GET    /chat/api/health             cpu, memory, event-loop lag, gaze state, last service round trips
//   GET    /chat/api/health/warm        measure the service round trips now (at a hold's touch-down), cached 30 s
// Audio never enters the pool. The hub never deletes these files by itself
// except the audio rotation (the newest 200 recordings are kept).
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ownRequest, loadChatEnvironment } = require('./chat-api.js');

const PREFIX = '/chat/api';
const LIMITS = Object.freeze({ bodyBytes: 65536, audioBytes: 480000, audioTurns: 200, dayBytes: 16777216,
  recent: 10, summaryTurns: 500, rttTtlMs: 30000, rttTimeoutMs: 2000, cpuSampleMs: 200, lagIntervalMs: 100, lagWindow: 50 });
const KINDS = ['hold', 'typed', 'fixed', 'reply'];
const MODES = ['one-shot', 'stream', 'local', 'typed', 'none'];
const OUTCOMES = ['completed', 'cancelled', 'failed'];
const REASONS = ['cancel', 'closed', 'interrupted', 'superseded', 'reload', 'timeout', 'capture', 'recognition', 'choices', 'speech', 'connection', 'other'];
// Every v1.0.20 timing mark plus the spec §5 additions. "transcript" is the
// final transcript's arrival and "finishSent" the finalize; socketConnect and
// the speculative marks are reserved for the streaming pipeline (phase 2).
const STAGES = ['begin', 'release', 'drained', 'finishSent', 'finishAck', 'transcript', 'choicesReady', 'revealed', 'selected',
  'playbackStart', 'playbackEnd', 'socketConnect', 'firstPartial', 'partial', 'speculativeStart', 'speculativeKeep',
  'speculativeDiscard', 'firstChoiceStaged', 'choiceStaged', 'batchSealed', 'firstAudio'];
const TEXT_STAGES = new Set(['firstPartial', 'partial', 'firstChoiceStaged', 'choiceStaged']);
const WORKER = ['audioMs', 'captureWallMs', 'activityMs', 'cloudMs', 'firstPartialMs', 'finalDecodeMs', 'turnMs', 'finalizeMs', 'choicesServerMs'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

// ---- a small strict schema: every check is a predicate, objects are closed ----
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (max = 3600000) => v => Number.isFinite(v) && v >= 0 && v <= max;
const int = (max = 1e9) => v => Number.isSafeInteger(v) && v >= 0 && v <= max;
const str = (max, pattern) => v => typeof v === 'string' && v.length <= max && !CONTROL.test(v) && (!pattern || pattern.test(v));
const oneOf = list => v => list.includes(v);
const nullable = check => v => v === null || check(v);
const list = (check, max) => v => Array.isArray(v) && v.length <= max && v.every(check);
const shape = (fields, required = []) => v => isObject(v) && Object.keys(v).every(key => Object.hasOwn(fields, key) && fields[key](v[key])) &&
  required.every(key => Object.hasOwn(v, key));
const health = shape({ cpuBusy: nullable(num(1)), load1: nullable(num(1e4)), freeMemBytes: nullable(num(Number.MAX_SAFE_INTEGER)),
  totalMemBytes: nullable(num(Number.MAX_SAFE_INTEGER)), eventLoopLagMs: nullable(num()), gaze: nullable(str(32)),
  rtt: shape({ transcription: nullable(num(60000)), reply: nullable(num(60000)) }) });
const choice = shape({ id: str(32), label: str(100), say: str(600), symbol: nullable(str(64)) }, ['label', 'say']);
const stage = v => isObject(v) && oneOf(STAGES)(v.name) && num()(v.ms) &&
  Object.keys(v).every(key => key === 'name' || key === 'ms' || (key === 'text' && TEXT_STAGES.has(v.name) && str(2000)(v.text)));
const RECORD = shape({
  version: v => v === 1, id: str(36, UUID), kind: oneOf(KINDS), mode: oneOf(MODES), session: nullable(str(64, /^[A-Za-z0-9-]+$/)),
  startedAt: str(30, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/), outcome: oneOf(OUTCOMES), reason: oneOf(REASONS), error: str(300),
  stages: list(stage, 300),
  worker: shape(Object.fromEntries(WORKER.map(key => [key, key === 'firstPartialMs' ? nullable(num()) : num()]))),
  content: shape({ transcript: str(2000), partials: list(str(2000), 100), choiceKind: str(32), choices: list(choice, 6),
    selected: nullable(choice), spoken: str(600), keyterms: nullable(list(str(64), 100)) }),
  usage: shape({ reply: shape({ model: nullable(str(128)), inputTokens: int(), cachedTokens: int(), outputTokens: int() }),
    audioSeconds: num(3600), socketSeconds: nullable(num(86400)),
    voice: shape({ chars: int(10000), cache: oneOf(['hit', 'pending', 'miss', 'device']), fetchedChars: int(100000) }) }),
  health: shape({ release: health, reveal: health }),
  mic: shape({ peakRms: num(1), clipped: int(), frames: int() }, ['peakRms', 'clipped', 'frames']),
}, ['version', 'id', 'kind', 'mode', 'startedAt', 'outcome', 'stages']);

function fault(status, code) { return Object.assign(new Error(code), { status, code }); }
function validateTurn(value) {
  if (!RECORD(value)) throw fault(400, 'invalid-turn');
  // A completed turn has no reason; a cancelled or failed one always has one.
  if ((value.outcome === 'completed') === Object.hasOwn(value, 'reason')) throw fault(400, 'invalid-turn');
  return JSON.parse(JSON.stringify(value));
}

// ---- the switch: a per-device boolean in app-settings.json, off when absent ----
function testModeOn(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'app-settings.json'), 'utf8')).chatTestMode === true; }
  catch { return false; }
}
// `fetchSite` is the request's Sec-Fetch-Site: a page on another site steering
// the browser never moves the switch; the page itself ("same-origin"), a typed
// URL ("none") or a tool that sends no such header does.
function applyTestModeSetting(stored, incoming, fetchSite) {
  const next = { ...stored };
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return next;
  if (typeof incoming?.chatTestMode === 'boolean') next.chatTestMode = incoming.chatTestMode;
  return next;
}
// Day files and summaries use the device's local calendar day.
const two = n => String(n).padStart(2, '0');
function localDay(date = new Date()) { return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`; }

// ---- cost from a private price table (<data>/chat-prices.json; shape in the spec §5) ----
const round = value => Math.round(value * 1e6) / 1e6;
function estimateCost(record, prices) {
  if (!isObject(prices)) return null;
  const usage = record.usage || {}, models = record.models || {};
  let complete = true;
  const priced = (table, model) => isObject(table) && typeof model === 'string' && isObject(table[model]) ? table[model] : null;
  const rate = value => Number.isFinite(value) && value >= 0 ? value : 0;
  let reply = 0;
  if (usage.reply) {
    const price = priced(prices.reply, usage.reply.model || models.reply);
    if (!price) { reply = null; complete = false; }
    else {
      const cached = Math.min(usage.reply.cachedTokens, usage.reply.inputTokens);
      reply = round(((usage.reply.inputTokens - cached) * rate(price.inputPerMillion) + cached * rate(price.cachedInputPerMillion ?? price.inputPerMillion) +
        usage.reply.outputTokens * rate(price.outputPerMillion)) / 1e6);
    }
  }
  let transcription = 0;
  // Local recognition and turns with no recognition cost nothing; one-shot and
  // stream turns are priced by the model configured for that mode (stamped by the hub).
  const transcribed = record.mode === 'one-shot' || record.mode === 'stream';
  if (transcribed && (Number.isFinite(usage.audioSeconds) || Number.isFinite(usage.socketSeconds))) {
    const price = priced(prices.transcription, models.transcription);
    if (!price) { transcription = null; complete = false; }
    else transcription = round(rate(usage.audioSeconds) / 60 * rate(price.perAudioMinute) + rate(usage.socketSeconds) / 60 * rate(price.perSocketMinute));
  }
  let voice = 0;
  if (usage.voice && usage.voice.fetchedChars) {
    if (!isObject(prices.voice) || !Number.isFinite(prices.voice.perThousandChars)) { voice = null; complete = false; }
    else voice = round(usage.voice.fetchedChars / 1000 * rate(prices.voice.perThousandChars));
  }
  return { currency: typeof prices.currency === 'string' ? prices.currency.slice(0, 8) : 'USD',
    reply, transcription, voice, total: round((reply || 0) + (transcription || 0) + (voice || 0)), complete };
}
function readPrices(dataDir) {
  try {
    const file = path.join(dataDir, 'chat-prices.json');
    if (fs.statSync(file).size > 65536) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(value) ? value : null;
  } catch { return null; }
}

// ---- summaries: shared by the diagnostics panel and tools/chat-turns.mjs ----
function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * q;
  const low = Math.floor(position), high = Math.ceil(position);
  return Math.round((sorted[low] + (sorted[high] - sorted[low]) * (position - low)) * 10) / 10;
}
// Stage times are measured from release when the turn has one (a held
// question), else from the turn's start. Only the first of each stage counts.
function stageTimes(record) {
  const stages = Array.isArray(record.stages) ? record.stages : [];
  const release = stages.find(s => s.name === 'release');
  const anchor = release ? release.ms : 0, out = {};
  for (const s of stages) if (!Object.hasOwn(out, s.name) && s.ms >= anchor) out[s.name] = Math.round((s.ms - anchor) * 10) / 10;
  return out;
}
function summarize(records) {
  const builds = {}, outcomes = { completed: 0, cancelled: {}, failed: {} }, costPerDay = {}, samples = {};
  for (const record of records) {
    if (!isObject(record)) continue;
    const build = String(record.build || 'unknown'), kind = String(record.kind || 'unknown');
    const group = ((builds[build] ||= {})[kind] ||= { turns: 0, stages: {} });
    group.turns++;
    if (record.outcome === 'completed') {
      outcomes.completed++;
      for (const [name, ms] of Object.entries(stageTimes(record))) (((samples[build] ||= {})[kind] ||= {})[name] ||= []).push(ms);
    } else if (record.outcome === 'cancelled' || record.outcome === 'failed') {
      const reason = String(record.reason || 'other');
      outcomes[record.outcome][reason] = (outcomes[record.outcome][reason] || 0) + 1;
    }
    let day = typeof record.day === 'string' && /^\d{4}-\d\d-\d\d$/.test(record.day) ? record.day : null;
    if (!day) { const at = new Date(record.receivedAt || record.startedAt || NaN); day = Number.isNaN(at.getTime()) ? 'unknown' : localDay(at); }
    const entry = (costPerDay[day] ||= { usd: 0, turns: 0, unpriced: 0 });
    entry.turns++;
    if (record.cost && Number.isFinite(record.cost.total)) { entry.usd = round(entry.usd + record.cost.total); if (!record.cost.complete) entry.unpriced++; }
    else entry.unpriced++;
  }
  for (const [build, kinds] of Object.entries(samples)) for (const [kind, stages] of Object.entries(kinds))
    for (const [name, values] of Object.entries(stages)) builds[build][kind].stages[name] = { n: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95) };
  return { builds, outcomes, costPerDay };
}

// ---- wav: the bake-off and replay tools read 16 kHz mono PCM16 ----
function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function readBody(req, cap) {
  if (Number(req.headers['content-length']) > cap) { req.resume(); return Promise.reject(fault(413, 'body-too-large')); }
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], done = false;
    const stop = error => { if (!done) { done = true; chunks = []; reject(error); } };
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > cap) { stop(fault(413, 'body-too-large')); req.resume(); } else chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('aborted', () => stop(fault(400, 'request-aborted')));
    req.on('error', () => stop(fault(400, 'request-aborted')));
  });
}
function originOf(value) {
  try {
    const url = new URL(value);
    const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
    return ['http:', 'https:'].includes(protocol) ? protocol + '//' + url.host + '/' : null;
  } catch { return null; }
}

function createChatTurns(options = {}) {
  const dataDir = path.resolve(options.dataDir || '.');
  const logDir = path.join(dataDir, 'logs', 'chat-turns'), audioDir = path.join(logDir, 'audio');
  const limits = { ...LIMITS, ...options.limits };
  const enabled = options.enabled || (() => testModeOn(dataDir));
  const env = options.env || (() => loadChatEnvironment());
  const build = options.build || (() => null);
  const gaze = options.gaze || (() => null);
  const fetcher = options.fetch || globalThis.fetch;
  const clock = options.clock || Date.now;
  const pool = options.pool || null;
  let writing = Promise.resolve();
  const serial = work => { const job = writing.then(work); writing = job.catch(() => {}); return job; };

  const io = { renameSync: fs.renameSync, ...options.io };
  // Event-loop lag: how late a short timer fires, the worst over the last ~5 s.
  // The timer runs only while test mode is in use: it starts on the first
  // health sample with the switch on and stops as soon as the switch reads off.
  const lags = [];
  let expected = 0, lagTimer = null;
  function startLag() {
    if (lagTimer) return;
    lags.length = 0; expected = performance.now() + limits.lagIntervalMs;
    lagTimer = setInterval(() => {
      if (!enabled()) { stopLag(); return; }
      const now = performance.now();
      lags.push(Math.max(0, now - expected)); if (lags.length > limits.lagWindow) lags.shift();
      expected = now + limits.lagIntervalMs;
    }, limits.lagIntervalMs);
    lagTimer.unref();
  }
  function stopLag() { if (lagTimer) clearInterval(lagTimer); lagTimer = null; lags.length = 0; }
  // Turns this hub recorded (the audio route takes recordings only for these).
  const known = new Set();
  const remember = id => { known.add(id); if (known.size > 2000) known.delete(known.values().next().value); };

  // Service round trips: one HEAD to each configured service's origin, ms only.
  // Measured only when the page warms them at a hold's touch-down (at most once
  // per 30 s per origin), never while a question is being sent; a health sample
  // reads the last measurement.
  const rttCache = new Map();
  const services = () => { const chat = env() || {}; return { transcription: originOf(chat.ERA_CHAT_STREAM_URL || chat.ERA_CHAT_SPEECH_URL), reply: originOf(chat.ERA_CHAT_TEXT_URL) }; };
  function warm() {
    for (const origin of Object.values(services())) {
      if (!origin) continue;
      const cached = rttCache.get(origin);
      if (cached && clock() - cached.at < limits.rttTtlMs) continue;
      const entry = { at: clock(), value: null };
      rttCache.set(origin, entry);
      const before = performance.now();
      fetcher(origin, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(limits.rttTimeoutMs) })
        .then(async response => { await response.body?.cancel?.().catch(() => {}); entry.value = Math.round((performance.now() - before) * 10) / 10; }, () => {});
    }
  }
  const lastRoundTrip = origin => {
    const cached = origin && rttCache.get(origin);
    return cached && clock() - cached.at < limits.rttTtlMs * 4 ? cached.value : null;
  };
  async function sampleCpu() {
    const total = cpus => cpus.reduce((sum, cpu) => {
      const t = cpu.times; return { idle: sum.idle + t.idle, all: sum.all + t.user + t.nice + t.sys + t.idle + t.irq };
    }, { idle: 0, all: 0 });
    const before = total(os.cpus());
    await new Promise(resolve => setTimeout(resolve, limits.cpuSampleMs));
    const after = total(os.cpus()), all = after.all - before.all;
    return all > 0 ? Math.round(Math.min(1, Math.max(0, 1 - (after.idle - before.idle) / all)) * 1000) / 1000 : null;
  }
  async function health() {
    startLag();
    const origins = services(), cpuBusy = await sampleCpu();
    const transcription = lastRoundTrip(origins.transcription), reply = lastRoundTrip(origins.reply);
    let state = null;
    try { const value = gaze(); state = typeof value === 'string' ? value.slice(0, 32) : null; } catch {}
    return { cpuBusy, load1: process.platform === 'win32' ? null : Math.round(os.loadavg()[0] * 100) / 100,
      freeMemBytes: os.freemem(), totalMemBytes: os.totalmem(),
      eventLoopLagMs: Math.round(Math.max(0, ...lags) * 10) / 10, gaze: state, rtt: { transcription, reply } };
  }

  async function record(value) {
    const turn = validateTurn(value), chat = env() || {};
    const id = (key) => typeof chat[key] === 'string' && chat[key] && chat[key].length <= 128 ? chat[key] : null;
    const now = new Date(clock());
    const transcription = turn.mode === 'stream' ? id('ERA_CHAT_STREAM_MODEL') : turn.mode === 'one-shot' ? id('ERA_CHAT_SPEECH_MODEL') : null;
    const stamped = { ...turn, receivedAt: now.toISOString(), day: localDay(now), build: build() || null, device: options.deviceId || null,
      models: { reply: id('ERA_CHAT_TEXT_MODEL'), transcription } };
    stamped.cost = estimateCost(stamped, readPrices(dataDir));
    const line = JSON.stringify(stamped) + '\n';
    await serial(async () => {
      const file = path.join(logDir, stamped.day + '.jsonl');
      await fsp.mkdir(logDir, { recursive: true });
      const size = await fsp.stat(file).then(s => s.size, () => 0);
      if (size + Buffer.byteLength(line) > limits.dayBytes) throw fault(507, 'turn-log-full');
      await fsp.appendFile(file, line);
    });
    remember(stamped.id);
    try { pool?.append('chat-turn', { turn: stamped }); } catch { /* history is nice-to-have */ }
    return stamped;
  }
  async function dayFiles() {
    try { return (await fsp.readdir(logDir)).filter(name => /^\d{4}-\d\d-\d\d\.jsonl$/.test(name)).sort(); }
    catch { return []; }
  }
  async function recentRecords(count) {
    const out = [];
    for (const name of (await dayFiles()).reverse()) {
      let text = '';
      try { text = await fsp.readFile(path.join(logDir, name), 'utf8'); } catch { continue; }
      const lines = text.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && out.length < count; i--) { try { out.push(JSON.parse(lines[i])); } catch {} }
      if (out.length >= count) break;
    }
    return out.reverse();
  }
  // A recording joins a turn the hub recorded: remembered since boot, or found
  // in a day file (a hub restarted between the record and its audio).
  async function knowsTurn(id) {
    if (known.has(id)) return true;
    const needle = '"id":' + JSON.stringify(id);
    for (const name of (await dayFiles()).reverse().slice(0, 3)) {
      try { if ((await fsp.readFile(path.join(logDir, name), 'utf8')).includes(needle)) { remember(id); return true; } } catch {}
    }
    return false;
  }
  async function storeAudio(id, pcm) {
    await serial(async () => {
      await fsp.mkdir(audioDir, { recursive: true });
      try { await fsp.writeFile(path.join(audioDir, id + '.wav'), wavFromPcm(pcm), { flag: 'wx' }); }
      catch (error) { throw error.code === 'EEXIST' ? fault(409, 'audio-exists') : error; }
      const files = [];
      for (const name of await fsp.readdir(audioDir)) {
        if (!name.endsWith('.wav')) continue;
        try { files.push({ name, at: (await fsp.stat(path.join(audioDir, name))).mtimeMs }); } catch {}
      }
      files.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
      for (const file of files.slice(0, Math.max(0, files.length - limits.audioTurns))) await fsp.rm(path.join(audioDir, file.name), { force: true });
    });
  }
  // The pool is one writer per device. This device's own events folder loses
  // every chat-turn line; a folder of an EARLIER id of this device (a renamed
  // device) loses only lines of turns this device recorded (their ids are in
  // the day files being deleted, and the line names that folder's device).
  // Nothing else moves: other kinds, torn lines, other devices' turns. Files
  // are read asynchronously; each rewrite re-reads, writes a temporary file and
  // renames it in one synchronous step, so no pool.append in this process can
  // land between the read and the rename. A rename that fails is reported.
  async function stripPoolTurns(ours) {
    const result = { poolLines: 0, failed: [] };
    if (!pool || typeof pool.root !== 'string' || typeof pool.deviceId !== 'string' || !pool.deviceId) return result;
    const events = path.join(pool.root, 'events');
    let folders = [];
    try { folders = (await fsp.readdir(events, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); } catch { return result; }
    for (const folder of folders) {
      const current = folder === pool.deviceId;
      const drop = line => {
        let value; try { value = JSON.parse(line); } catch { return false; }
        if (!value || value.kind !== 'chat-turn') return false;
        return current || (value.device === folder && ours.has(value.turn && value.turn.id));
      };
      let names = [];
      try { names = (await fsp.readdir(path.join(events, folder))).filter(name => name.endsWith('.jsonl')).sort(); } catch { continue; }
      for (const name of names) {
        const file = path.join(events, folder, name);
        let text;
        try { text = await fsp.readFile(file, 'utf8'); } catch { continue; }
        if (!text.split('\n').some(line => line && drop(line))) continue;
        const temporary = path.join(events, folder, '.' + name + '.' + process.pid + '.tmp');
        try {
          const fresh = fs.readFileSync(file, 'utf8'), kept = [];
          let dropped = 0;
          for (const line of fresh.split('\n')) { if (!line) continue; if (drop(line)) dropped++; else kept.push(line); }
          fs.writeFileSync(temporary, kept.length ? kept.join('\n') + '\n' : '');
          io.renameSync(temporary, file);
          result.poolLines += dropped;
        } catch {
          try { fs.rmSync(temporary, { force: true }); } catch {}
          result.failed.push(folder + '/' + name);
        }
      }
    }
    return result;
  }
  async function deleteAll() {
    return serial(async () => {
      const days = await dayFiles(), ours = new Set(known);
      for (const name of days) {
        try { for (const line of (await fsp.readFile(path.join(logDir, name), 'utf8')).split('\n')) { try { const id = JSON.parse(line).id; if (typeof id === 'string') ours.add(id); } catch {} } } catch {}
      }
      let recordings = 0;
      try { recordings = (await fsp.readdir(audioDir)).filter(name => name.endsWith('.wav')).length; } catch {}
      for (const name of days) await fsp.rm(path.join(logDir, name), { force: true });
      await fsp.rm(audioDir, { recursive: true, force: true });
      const stripped = await stripPoolTurns(ours);
      known.clear();
      return { deleted: { days: days.length, recordings, poolLines: stripped.poolLines, failed: stripped.failed } };
    });
  }

  async function route(req, res, routePath) {
    if (!ownRequest(req)) throw fault(403, 'local-only');
    if (routePath === '/turns' && req.method === 'DELETE') return json(res, 200, await deleteAll());
    if (!enabled()) { stopLag(); throw fault(404, 'test-mode-off'); }
    if (routePath === '/health' || routePath === '/health/warm') {
      if (req.method !== 'GET') throw fault(405, 'method-not-allowed');
      if (routePath === '/health/warm') { warm(); return json(res, 202, { ok: true }); }
      return json(res, 200, await health());
    }
    if (routePath === '/turns') {
      if (req.method === 'GET') {
        const records = await recentRecords(limits.summaryTurns);
        return json(res, 200, { turns: records.slice(-limits.recent), summary: summarize(records) });
      }
      if (req.method !== 'POST') throw fault(405, 'method-not-allowed');
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw fault(415, 'json-required');
      let value;
      const bytes = await readBody(req, limits.bodyBytes);
      try { value = JSON.parse(bytes.toString('utf8')); } catch { throw fault(400, 'invalid-json'); }
      const stamped = await record(value);
      return json(res, 201, { ok: true, id: stamped.id, cost: stamped.cost });
    }
    const match = /^\/turns\/([^/]+)\/audio$/.exec(routePath);
    if (!match || !UUID.test(match[1])) throw fault(404, 'not-found');
    if (req.method !== 'PUT') throw fault(405, 'method-not-allowed');
    if (!/^application\/octet-stream(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw fault(415, 'pcm-required');
    if (!(await knowsTurn(match[1]))) { req.resume(); throw fault(404, 'unknown-turn'); }
    const pcm = await readBody(req, limits.audioBytes);
    if (!pcm.length || pcm.length % 2) throw fault(400, 'invalid-pcm');
    await storeAudio(match[1], pcm);
    return json(res, 201, { ok: true });
  }
  return {
    handle(req, res) {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
      const routePath = url.pathname.startsWith(PREFIX + '/') ? url.pathname.slice(PREFIX.length) : null;
      if (!routePath || !(routePath === '/health' || routePath === '/health/warm' || routePath === '/turns' || routePath.startsWith('/turns/'))) return false;
      route(req, res, routePath).catch(error => json(res, error.status || 500, { error: error.status ? error.code : 'turns-error' }));
      return true;
    },
    record, health, knowsTurn,
    lagActive() { return lagTimer !== null; },
    close() { stopLag(); },
  };
}

module.exports = { createChatTurns, validateTurn, estimateCost, summarize, stageTimes, testModeOn, applyTestModeSetting, localDay, wavFromPcm, STAGES };
