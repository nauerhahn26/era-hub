// Profile-backed Chat settings. Conversation context and captured speech never enter this store.
const ROUTE = '/chat/api/state';
const KEYS = { voicePreference: 'chat:voicePreference', stories: 'chat:stories', timings: 'chat:timings:v1' };
const KINDS = ['hold', 'typed', 'fixed', 'reply'];
const STATUSES = ['open', 'completed', 'cancelled', 'failed'];
const REASONS = ['cancel', 'closed', 'interrupted', 'superseded', 'reload', 'timeout', 'capture', 'recognition', 'choices', 'speech', 'connection', 'other'];
const DURATIONS = new Set(['holdMs', 'releaseToDrainedMs', 'drainToFinishSentMs', 'finishRoundTripMs', 'finishToTranscriptMs', 'releaseToTranscriptMs', 'transcriptToChoicesMs', 'choicesToRevealMs', 'revealToSelectMs', 'selectionToPlaybackMs', 'playbackMs', 'releaseToPlaybackMs', 'workerActivityMs', 'workerCloudMs', 'workerFinalMs', 'audioMs', 'choicesServerMs', 'totalMs']);
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const failure = code => Object.assign(new Error(code === 'revision_conflict' ? 'Saved Chat settings changed in another window. Reload Chat before saving.' : 'Chat changes were not saved. Try again or reload Chat.'), { code });
function patchData(value) {
  if (!keys(value, ['voicePreference', 'stories', 'timings']) || !Object.keys(value).length) throw failure('invalid_state');
  if (Object.hasOwn(value, 'voicePreference') && !['saved', 'local'].includes(value.voicePreference)) throw failure('invalid_state');
  if (Object.hasOwn(value, 'stories') && (!Array.isArray(value.stories) || value.stories.length > 4 || !value.stories.every(story =>
    keys(story, ['label', 'say']) && typeof story.label === 'string' && story.label.length <= 55 && typeof story.say === 'string' && story.say.length <= 600 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(story.label + story.say)))) throw failure('invalid_state');
  if (Object.hasOwn(value, 'timings') && (!Array.isArray(value.timings) || value.timings.length > 40 || !value.timings.every(row => {
    if (!keys(row, ['kind', 'status', 'reason', 'timings']) || !KINDS.includes(row.kind) || !STATUSES.includes(row.status) || !object(row.timings)) return false;
    if (['failed', 'cancelled'].includes(row.status) ? !REASONS.includes(row.reason) : Object.hasOwn(row, 'reason')) return false;
    return Object.entries(row.timings).every(([key, number]) => DURATIONS.has(key) && Number.isFinite(number) && number >= 0 && number <= 3600000);
  }))) throw failure('invalid_state');
  return clone(value);
}
function stateData(value) {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.exists !== 'boolean' ||
    !object(value.value) || !['voicePreference', 'stories', 'timings'].every(key => Object.hasOwn(value.value, key))) throw failure('invalid_state');
  return { ...value, value: patchData(value.value) };
}
function legacyRows(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-40).filter(row => object(row) && KINDS.includes(row.kind) && STATUSES.includes(row.status)).map(row => {
    const failed = ['cancelled', 'failed'].includes(row.status), timings = {};
    for (const [key, number] of Object.entries(object(row.timings) ? row.timings : {})) if (DURATIONS.has(key) && Number.isFinite(number) && number >= 0 && number <= 3600000) timings[key] = number;
    return { kind: row.kind, status: row.status, ...(failed ? { reason: REASONS.includes(row.reason) ? row.reason : 'other' } : {}), timings };
  });
}
export function createChatStorage(options = {}) {
  const fetcher = options.fetch || ((...args) => fetch(...args)), timeoutMs = options.timeoutMs || 3000;
  const listeners = new Set();
  let legacy;
  try { legacy = options.legacyStorage === undefined ? globalThis.localStorage : options.legacyStorage; } catch {}
  let value = { voicePreference: 'saved', stories: [], timings: [] }, revision = 0, ready = false, loaded = false, available = false;
  let state = 'loading', error = '', pending = {}, waiters = [], active = null, timer = null, keepalive = false, hydration = null;
  let dirtyTimings = null;
  const snapshot = () => clone(value);
  const status = () => ({ ready, available, state, error });
  function changed(next, code = '') {
    state = next; error = code;
    for (const fn of listeners) try { fn(status()); } catch { /* Storage diagnostics cannot block communication. */ }
  }
  async function request(method, body, alive = false) {
    const controller = new AbortController(); let rejectTimeout;
    const stopped = new Promise((_, reject) => { rejectTimeout = () => reject(failure('state_unavailable')); });
    const deadline = setTimeout(() => { controller.abort(); rejectTimeout(); }, timeoutMs);
    try {
      return await Promise.race([(async () => {
        const response = await fetcher(ROUTE, { method, cache: 'no-store', signal: controller.signal, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: alive } : {}) });
        const result = await response.json();
        if (!response.ok) throw failure(response.status === 409 ? 'revision_conflict' : 'state_unavailable');
        const canonical = stateData(result);
        if (method === 'PUT' && (!canonical.exists || canonical.revision !== body.expectedRevision + 1 || Object.keys(body.patch).some(key => JSON.stringify(canonical.value[key]) !== JSON.stringify(body.patch[key])))) throw failure('state_unavailable');
        return canonical;
      })(), stopped]);
    } catch (cause) { throw failure(cause?.code === 'revision_conflict' ? 'revision_conflict' : 'state_unavailable'); }
    finally { clearTimeout(deadline); }
  }
  function pump() {
    clearTimeout(timer); timer = null;
    if (active || !Object.keys(pending).length || !available || state === 'conflict') return active;
    const batch = pending, batchWaiters = waiters, alive = keepalive;
    pending = {}; waiters = []; keepalive = false; changed('saving');
    const work = request('PUT', { version: 1, expectedRevision: revision, patch: batch }, alive).then(result => {
      revision = result.revision; value = result.value;
      if (Object.hasOwn(batch, 'timings') && JSON.stringify(batch.timings) === JSON.stringify(dirtyTimings)) dirtyTimings = null;
      if (dirtyTimings !== null) value.timings = clone(dirtyTimings);
      batchWaiters.forEach(item => item.resolve(clone(result.value)));
      changed(Object.keys(pending).length ? 'saving' : dirtyTimings === null ? 'saved' : 'unsaved');
    }, cause => {
      batchWaiters.concat(waiters).forEach(item => item.reject(cause));
      pending = {}; waiters = []; changed(cause.code === 'revision_conflict' ? 'conflict' : 'unsaved', cause.code);
    }).finally(() => { active = null; if (Object.keys(pending).length && state !== 'conflict') pump(); });
    active = work; return work;
  }
  function enqueue(patch, immediate) {
    if (!loaded || !available || state === 'conflict') return Promise.reject(failure(state === 'conflict' ? 'revision_conflict' : 'state_unavailable'));
    pending = { ...pending, ...patch };
    if (dirtyTimings !== null && !Object.hasOwn(pending, 'timings')) pending.timings = clone(dirtyTimings);
    changed('saving');
    const work = new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    if (immediate) pump();
    else if (!timer) timer = setTimeout(pump, options.debounceMs ?? 75);
    return work;
  }
  async function update(patch) {
    const cleaned = patchData(patch);
    if (Object.hasOwn(cleaned, 'timings')) dirtyTimings = clone(cleaned.timings);
    return enqueue(cleaned, true);
  }
  function stageTimings(rows) {
    const cleaned = patchData({ timings: rows }); value.timings = cleaned.timings; dirtyTimings = clone(cleaned.timings);
    enqueue(cleaned, false).catch(() => {});
  }
  async function hydrate() {
    if (hydration) return hydration;
    hydration = (async () => {
      try {
        const result = await request('GET'); value = result.value; revision = result.revision; loaded = available = true;
        if (!result.exists) {
          const raw = {}; let found = false;
          for (const [key, name] of Object.entries(KEYS)) { try { const text = legacy?.getItem(name); if (text !== null && text !== undefined) { found = true; if (text.length <= 65536) raw[key] = text; } } catch {} }
          if (found) {
            const migrated = clone(value);
            if (['saved', 'local'].includes(raw.voicePreference)) migrated.voicePreference = raw.voicePreference;
            try { migrated.stories = patchData({ stories: JSON.parse(raw.stories) }).stories; } catch {}
            try { migrated.timings = legacyRows(JSON.parse(raw.timings).turns); } catch {}
            await update(migrated);
            for (const name of Object.values(KEYS)) try { legacy?.removeItem(name); } catch {}
          }
        }
        if (state !== 'unsaved') changed('saved');
      } catch (cause) { loaded = available = false; changed(cause.code === 'revision_conflict' ? 'conflict' : 'unsaved', cause.code || 'state_unavailable'); }
      finally { ready = true; for (const fn of listeners) try { fn(status()); } catch {} }
      return snapshot();
    })();
    return hydration;
  }
  async function flush({ keepalive: alive = false, timeoutMs: cap = 2000 } = {}) {
    if (!available || state === 'conflict') return false;
    if (!active && !Object.keys(pending).length && dirtyTimings !== null) enqueue({ timings: clone(dirtyTimings) }, false).catch(() => {});
    keepalive ||= alive; pump();
    let deadline;
    const settled = (async () => {
      while (active || Object.keys(pending).length) { if (!active) pump(); if (active) await active; else break; }
      return state === 'saved';
    })();
    try { return await Promise.race([settled, new Promise(resolve => { deadline = setTimeout(() => resolve(false), cap); })]); }
    finally { clearTimeout(deadline); }
  }
  const metricsStorage = {
    getItem(key) { return key === KEYS.timings ? JSON.stringify({ turns: value.timings }) : null; },
    setItem(key, text) { if (key === KEYS.timings) stageTimings(JSON.parse(text).turns); },
    removeItem(key) { if (key === KEYS.timings) stageTimings([]); },
  };
  return { hydrate, update, stageTimings, flush, snapshot, status, metricsStorage,
    voiceStorage: { getItem(key) { return key === KEYS.voicePreference ? value.voicePreference : null; }, setItem() {} },
    subscribe(fn) { listeners.add(fn); try { fn(status()); } catch {} return () => listeners.delete(fn); },
  };
}
