// Chat test mode's turn record (real-time chat spec 2026-10-27 §5). A separate
// path beside the production timing rows: metrics.js and storage.js are never
// changed by it, and their rows stay content-free whether test mode is on or
// off. Only while this device's switch is on does a turn here keep its words,
// its full timeline, usage, device health and (for a released hold) its audio,
// and post them to the hub's /chat/api/turns route at the turn's end.
const TURNS = '/chat/api/turns';
const MULTI = new Set(['partial', 'choiceStaged', 'speculativeStart', 'speculativeDiscard', 'utteranceSealed', 'batchReplaced']);
const WORKER = ['audioMs', 'captureWallMs', 'activityMs', 'cloudMs', 'firstPartialMs', 'finalDecodeMs', 'turnMs', 'finalizeMs', 'choicesServerMs', 'connectMs', 'settledMs', 'wordsSettledMs'];
const LIMITS = { audioBytes: 480000, partials: 100, stages: 300, recent: 10, healthWaitMs: 1500, bodyBytes: 60000 };
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const text = (value, max) => typeof value === 'string' ? value.replace(CONTROL, ' ').slice(0, max) : undefined;
const finite = value => Number.isFinite(value) && value >= 0 && value <= 3600000;
const tenth = value => Math.round(value * 10) / 10;
const bytes = value => new TextEncoder().encode(value).length;
function cleanChoice(choice) {
  if (!choice || typeof choice.label !== 'string' || typeof choice.say !== 'string') return null;
  return { ...(typeof choice.id === 'string' ? { id: choice.id.slice(0, 32) } : {}), label: text(choice.label, 100), say: text(choice.say, 600),
    ...(typeof choice.symbol === 'string' || choice.symbol === null ? { symbol: choice.symbol === null ? null : choice.symbol.slice(0, 64) } : {}),
    ...(Number.isSafeInteger(choice.symbolId) && choice.symbolId > 0 ? { symbolId: choice.symbolId } : {}) };
}

// RMS level (0..1) and clipped samples of one little-endian PCM16 frame.
export function micLevel(buffer) {
  const samples = new Int16Array(buffer);
  let squares = 0, clipped = 0;
  for (const value of samples) { squares += value * value; if (value >= 32767 || value <= -32768) clipped++; }
  return { rms: samples.length ? Math.min(1, Math.sqrt(squares / samples.length) / 32768) : 0, clipped };
}

export function createTurnLog(options = {}) {
  const enabled = options.enabled || (() => false);
  const fetcher = options.fetch || ((...args) => fetch(...args));
  const now = options.now || (() => performance.now());
  const wallClock = options.wallClock || (() => Date.now());
  const randomId = options.randomId || (() => crypto.randomUUID());
  const health = options.health || (async () => null);
  const limits = { ...LIMITS, ...options.limits };
  const turns = new Map(), listeners = new Set();
  let recent = [], latest = null;
  // Listeners hear about changes after the current task, once per task, and
  // build the live view or the recent list only if they read it: a mark taken
  // inside the reveal or a selection adds no synchronous work.
  const view = () => ({ get live() { return api.live(); }, get recent() { return api.recent(); } });
  let scheduled = false;
  function notify() {
    if (scheduled || !listeners.size) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      const value = view();
      for (const listener of listeners) try { listener(value); } catch { /* Diagnostics never interrupt a turn. */ }
    }, 0);
  }
  function push(turn, name, extra = {}) {
    if (turn.stages.length >= limits.stages) return;
    // A stage past the schema's one-hour bound is clamped, never a dropped record.
    turn.stages.push({ name, ms: Math.min(3600000, tenth(Math.max(0, now() - turn.began))), ...extra });
  }
  function assemble(turn) {
    const record = { version: 1, id: turn.id, kind: turn.kind, mode: turn.mode, ...(turn.mode === 'stream' && turn.setting ? { setting: turn.setting } : {}), session: turn.session, startedAt: turn.startedAt,
      outcome: turn.outcome, ...(turn.outcome !== 'completed' ? { reason: turn.reason } : {}), ...(turn.error ? { error: turn.error } : {}),
      stages: turn.stages.map(stage => ({ ...stage })) };
    if (Object.keys(turn.worker).length) record.worker = { ...turn.worker };
    // Keyterms are counted, never listed: the list holds family names.
    record.content = { ...turn.content, keyterms: null, ...(Number.isSafeInteger(turn.keytermsFired) ? { keytermsFired: turn.keytermsFired } : {}) };
    const usage = {};
    if (turn.reply) usage.reply = { ...turn.reply };
    if (finite(turn.worker.audioMs)) { usage.audioSeconds = Math.round(turn.worker.audioMs) / 1000; usage.socketSeconds = turn.socketSeconds; }
    if (turn.voice || turn.fetchedChars) usage.voice = { ...turn.voice, ...(turn.fetchedChars ? { fetchedChars: turn.fetchedChars } : {}) };
    if (Object.keys(usage).length) record.usage = usage;
    if (Object.keys(turn.health).length) record.health = { ...turn.health };
    if (turn.mic.frames) record.mic = { peakRms: Math.round(turn.mic.peakRms * 10000) / 10000, clipped: turn.mic.clipped, frames: turn.mic.frames };
    // One record stays under the hub's 64 KB body cap: partial texts go first.
    const size = () => bytes(JSON.stringify(record));
    if (size() > limits.bodyBytes) for (const stage of record.stages) if (stage.name === 'partial' || stage.name === 'firstPartial') delete stage.text;
    while (size() > limits.bodyBytes && record.content.partials?.length > 1) record.content.partials = record.content.partials.slice(Math.ceil(record.content.partials.length / 2));
    return record;
  }
  async function send(turn) {
    if (turn.healthPending.size) {
      let timer;
      await Promise.race([Promise.allSettled([...turn.healthPending]), new Promise(resolve => { timer = setTimeout(resolve, limits.healthWaitMs); })]);
      clearTimeout(timer);
    }
    const record = assemble(turn);
    recent = [...recent, record].slice(-limits.recent); notify();
    try {
      const body = JSON.stringify(record), init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
      let response;
      // A browser that refuses a keepalive request (quota, size) gets it once more without.
      try { response = await fetcher(TURNS, { ...init, keepalive: bytes(body) < 65000 }); }
      catch (error) { if (error?.name !== 'TypeError') throw error; response = await fetcher(TURNS, { ...init, keepalive: false }); }
      if (response?.ok) { const reply = await response.json().catch(() => null); if (reply && 'cost' in reply) { record.cost = reply.cost; notify(); } }
    } catch { /* A lost test record never affects Chat. */ }
    if (turn.audio.length && turn.submitted) {
      const bytes = new Uint8Array(turn.audioBytes); let offset = 0;
      for (const chunk of turn.audio) { bytes.set(chunk, offset); offset += chunk.length; }
      try { await fetcher(`${TURNS}/${turn.id}/audio`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }); } catch {}
    }
    options.onPosted?.(record);
  }
  const api = {
    begin(handle, kind, extra = {}) {
      if (!handle || !enabled()) return;
      const turn = { id: randomId(), kind, mode: kind === 'hold' ? 'one-shot' : kind === 'typed' ? 'typed' : 'none', session: null,
        began: now(), startedAt: new Date(wallClock()).toISOString(), stages: [], marks: new Set(), worker: {}, content: {},
        reply: null, voice: null, fetchedChars: 0, socketSeconds: null, keytermsFired: null, health: {}, healthPending: new Set(), audio: [], audioBytes: 0,
        mic: { peakRms: 0, clipped: 0, frames: 0 }, partials: 0, submitted: false, outcome: null, reason: null, error: '' };
      turns.set(handle, turn); latest = handle;
      // A button press counts from the press at the hub (`ago` ms before this
      // page heard it, same machine clock): the press is stage 0.
      if (kind === 'press' && Number.isFinite(extra.ago) && extra.ago >= 0 && extra.ago <= 60000) {
        turn.began -= extra.ago; turn.marks.add('press'); turn.stages.push({ name: 'press', ms: 0 });
      }
      push(turn, 'begin'); api.set(handle, extra); notify();
    },
    tracking(handle) { return turns.has(handle); },
    set(handle, { mode, session, setting } = {}) {
      const turn = turns.get(handle); if (!turn) return;
      if (['one-shot', 'stream', 'local', 'typed', 'none'].includes(mode)) turn.mode = mode;
      if (['primary', 'fallback'].includes(setting)) turn.setting = setting;
      if (typeof session === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(session)) turn.session = session;
    },
    mark(handle, stage, extra = {}) {
      const turn = turns.get(handle); if (!turn || (!MULTI.has(stage) && turn.marks.has(stage))) return;
      if (stage === 'revealed') { turn.marks.add('batchSealed'); push(turn, 'batchSealed'); }
      turn.marks.add(stage); push(turn, stage, typeof extra.text === 'string' ? { ...extra, text: text(extra.text, 2000) } : extra);
      if (stage === 'finishSent') turn.submitted = true;
      if (stage === 'playbackStart' && !turn.marks.has('firstAudio')) { turn.marks.add('firstAudio'); push(turn, 'firstAudio'); }
      notify();
    },
    partial(handle, value) {
      const turn = turns.get(handle), words = text(value, 2000); if (!turn || !words) return;
      if (turn.partials < limits.partials) {
        if (!turn.marks.has('firstPartial')) { turn.marks.add('firstPartial'); push(turn, 'firstPartial', { text: words }); }
        push(turn, 'partial', { text: words });
      }
      turn.partials++;
      turn.content.partials = [...(turn.content.partials || []), words].slice(-limits.partials);
      notify();
    },
    staged(handle, choices, { kind, usage, symbolRejected, pictureWarm, shape, recallRejected, world } = {}) {
      const turn = turns.get(handle); if (!turn || !Array.isArray(choices)) return;
      const clean = choices.map(cleanChoice).filter(Boolean).slice(0, 6);
      // A streamed batch was marked choice by choice as it staged.
      if (!turn.marks.has('firstChoiceStaged')) clean.forEach((choice, index) => {
        if (index === 0) { turn.marks.add('firstChoiceStaged'); push(turn, 'firstChoiceStaged', { text: choice.label }); }
        push(turn, 'choiceStaged', { text: choice.label });
      });
      turn.content.choices = clean;
      if (typeof kind === 'string') turn.content.choiceKind = kind.slice(0, 32);
      // Model pictures the hub refused for the label's own: a count, never the words.
      if (Number.isSafeInteger(symbolRejected) && symbolRejected > 0 && symbolRejected <= 6) turn.content.symbolRejected = symbolRejected;
      else delete turn.content.symbolRejected;
      // Pictures the hub warmed into its cache for this hold (spec §6): a count only.
      if (Number.isSafeInteger(pictureWarm) && pictureWarm >= 0 && pictureWarm <= 12) turn.content.pictureWarm = pictureWarm;
      else delete turn.content.pictureWarm;
      // An open question's shape and the recall check's verdict (dad, 10/28): category words only.
      if (['want', 'recall', 'feel', 'open'].includes(shape)) turn.content.shape = shape; else delete turn.content.shape;
      if (recallRejected === true) turn.content.recallRejected = true; else delete turn.content.recallRejected;
      // Her world's size when it went with the question: counts, never the text.
      const count = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
      if (world && count(world.weeks, 520) && count(world.chars, 6000) && (world.days === undefined || count(world.days, 31)))
        turn.content.world = { weeks: world.weeks, ...(world.days === undefined ? {} : { days: world.days }), chars: world.chars };
      else delete turn.content.world;
      if (usage && ['inputTokens', 'cachedTokens', 'outputTokens'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0))
        turn.reply = { model: typeof usage.model === 'string' ? usage.model.slice(0, 128) : null, inputTokens: usage.inputTokens, cachedTokens: usage.cachedTokens, outputTokens: usage.outputTokens };
      notify();
    },
    // One streamed choice staged (spec §3.3): marked as it arrives.
    stagedOne(handle, choice) {
      const turn = turns.get(handle), clean = cleanChoice(choice); if (!turn || !clean) return;
      if (turn.stagedOne >= 6) return;
      turn.stagedOne = (turn.stagedOne || 0) + 1;
      if (!turn.marks.has('firstChoiceStaged')) { turn.marks.add('firstChoiceStaged'); push(turn, 'firstChoiceStaged', { text: clean.label }); }
      push(turn, 'choiceStaged', { text: clean.label });
      notify();
    },
    content(handle, patch = {}) {
      const turn = turns.get(handle); if (!turn) return;
      if (typeof patch.transcript === 'string') turn.content.transcript = text(patch.transcript, 2000);
      if (typeof patch.spoken === 'string') turn.content.spoken = text(patch.spoken, 600);
      if ('selected' in patch) turn.content.selected = cleanChoice(patch.selected);
      // The stable frame (spec 2026-10-28 §4): the middle swapped to a mode, a page opened, Something else used.
      if (['ask', 'comment'].includes(patch.mode)) turn.content.mode = patch.mode;
      if (['questions', 'comments', 'about'].includes(patch.page)) turn.content.page = patch.page;
      if (patch.again === true) turn.content.again = true;
      if (patch.prompted === true) turn.content.prompted = true; // the options were read aloud (§6)
      if (patch.back === true) turn.content.back = true; // Back was used (maintainer 10/29)
      notify();
    },
    worker(handle, timings) {
      const turn = turns.get(handle); if (!turn || !timings || typeof timings !== 'object') return;
      for (const key of WORKER) {
        if (finite(timings[key])) turn.worker[key] = tenth(timings[key]);
        else if (key === 'firstPartialMs' && timings[key] === null) turn.worker[key] = null;
      }
    },
    usage(handle, { voice, stream } = {}) {
      const turn = turns.get(handle); if (!turn) return;
      if (stream && typeof stream === 'object') {
        if (Number.isFinite(stream.socketSeconds) && stream.socketSeconds >= 0 && stream.socketSeconds <= 86400) turn.socketSeconds = Math.round(stream.socketSeconds * 1000) / 1000;
        if (Number.isSafeInteger(stream.keytermsFired) && stream.keytermsFired >= 0) turn.keytermsFired = Math.min(stream.keytermsFired, 100);
      }
      if (voice && Number.isSafeInteger(voice.chars) && ['hit', 'pending', 'miss', 'device'].includes(voice.cache))
        turn.voice = { chars: Math.min(voice.chars, 10000), cache: voice.cache };
    },
    // Saved-voice characters fetched for THIS turn: its staged choices or the
    // words it spoke. Warming the fixed phrases is nobody's turn.
    fetched(handle, chars, words) {
      const turn = turns.get(handle); if (!turn || !Number.isSafeInteger(chars) || chars < 0 || typeof words !== 'string') return false;
      const own = turn.content.spoken === words || (turn.content.choices || []).some(choice => choice.say === words);
      if (own) turn.fetchedChars = Math.min(100000, turn.fetchedChars + chars);
      return own;
    },
    sample(handle, at) {
      const turn = turns.get(handle); if (!turn || !['release', 'reveal'].includes(at) || turn.health[at]) return;
      const job = Promise.resolve().then(() => health(at)).then(value => { if (value && typeof value === 'object') turn.health[at] = value; }, () => {});
      turn.healthPending.add(job); job.finally(() => turn.healthPending.delete(job));
    },
    audio(handle, buffer) {
      const turn = turns.get(handle); if (!turn || !(buffer instanceof ArrayBuffer) || buffer.byteLength % 2) return;
      const level = micLevel(buffer);
      turn.mic.frames++; turn.mic.clipped += level.clipped; turn.mic.peakRms = Math.max(turn.mic.peakRms, level.rms);
      if (turn.audioBytes + buffer.byteLength > limits.audioBytes) return;
      turn.audio.push(new Uint8Array(buffer.slice(0))); turn.audioBytes += buffer.byteLength;
    },
    error(handle, message) {
      const turn = turns.get(handle); if (!turn) return;
      turn.error = text(String(message || ''), 300);
    },
    end(handle, outcome, reason) {
      const turn = turns.get(handle); if (!turn || !['completed', 'cancelled', 'failed'].includes(outcome)) return;
      turns.delete(handle); if (latest === handle) latest = null;
      turn.outcome = outcome;
      if (outcome !== 'completed') turn.reason = ['cancel', 'short', 'closed', 'interrupted', 'superseded', 'reload', 'timeout', 'capture', 'recognition', 'choices', 'speech', 'connection', 'other'].includes(reason) ? reason : 'other';
      void send(turn);
    },
    live() {
      const turn = latest && turns.get(latest); if (!turn) return null;
      const release = turn.stages.find(stage => stage.name === 'release');
      return { kind: turn.kind, stages: turn.stages.map(stage => ({ name: stage.name, ms: stage.ms, ...(stage.text ? { text: stage.text } : {}),
        sinceRelease: release ? tenth(stage.ms - release.ms) : null })).map(stage => (stage.sinceRelease !== null && stage.sinceRelease < 0 ? { ...stage, sinceRelease: null } : stage)) };
    },
    recent() { return recent.map(record => JSON.parse(JSON.stringify(record))); },
    subscribe(listener) { listeners.add(listener); try { listener(view()); } catch {} return () => listeners.delete(listener); },
  };
  return api;
}

// The staging hook: runs only for a recorded turn, computes each choice's
// picture id there, and can never throw into Chat's reply preparation.
export function stageChoices(log, handle, choices, meta, symbolFor) {
  try {
    if (!log || !log.tracking(handle) || !Array.isArray(choices)) return;
    log.staged(handle, choices.map(choice => {
      let symbol = null;
      try { symbol = symbolFor(choice) ?? null; } catch { /* A picture lookup never blocks the record. */ }
      return { ...choice, symbol };
    }), meta || {});
  } catch { /* Test mode never ends a Chat turn. */ }
}

// The production metrics with a test-mode tap: every call reaches metrics.js
// exactly as before; the turn log only listens.
export function observeMetrics(metrics, log) {
  return {
    ...metrics,
    begin(kind) { const handle = metrics.begin(kind); if (handle) log.begin(handle, kind); return handle; },
    mark(handle, stage) { metrics.mark(handle, stage); log.mark(handle, stage); },
    observe(handle, timings) { metrics.observe(handle, timings); log.worker(handle, timings); },
    end(handle, status, reason) { metrics.end(handle, status, reason); log.end(handle, status, reason); },
  };
}
