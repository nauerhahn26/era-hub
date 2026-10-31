// Chat owns a cancellation-safe voice path without changing the shared engine.
const PREFERENCE_KEY = 'chat:voicePreference';
// Two voices (spec 2026-10-31 §3.2): "her" says her pick, "helper" says
// everything else (the options reading, each label, the partner's question).
// Anything unnamed is hers, as the hub's /tts treats it.
const roleOf = role => (role === 'helper' ? 'helper' : 'her');
// One text can be both a label read by the helper and her pick: clips key on both.
const keyOf = (role, text) => `${role}\n${text}`;
function savedUnavailable() {
  return Object.assign(new Error('Saved voice unavailable. The words are still here. Choose Device voice explicitly to use it.'), { code: 'saved-voice-unavailable' });
}
export function createChatVoice(options = {}) {
  const fetcher = options.fetch || ((...args) => fetch(...args));
  const synth = options.synth || globalThis.speechSynthesis;
  const makeAudio = options.makeAudio || (url => new Audio(url));
  const makeUtterance = options.makeUtterance || (text => new SpeechSynthesisUtterance(text));
  const createUrl = options.createObjectURL || (blob => URL.createObjectURL(blob));
  const revokeUrl = options.revokeObjectURL || (url => URL.revokeObjectURL(url));
  // Background warm-up runs two clips at a time; a staged choice or the
  // selected words (urgent) start at once, up to `urgent` in flight (spec §3.4).
  const limits = { concurrent: 2, urgent: 6, queued: 32, cached: 64, fetchMs: 10000, prepareMs: 8000, voiceRefreshMs: 600000, ...options.limits };
  const now = options.now || (() => Date.now());
  const cache = new Map(), pending = new Map(), queue = [], fetching = new Set();
  let generation = 0, current = null, finish = null, preference = 'saved', cacheEpoch = 0;
  let voiceId = null, helperId = null, metadata = null, metadataController = null, metadataEpoch = 0, active = 0, voiceAt = -Infinity;
  let storage;
  try {
    storage = options.storage === undefined ? globalThis.localStorage : options.storage;
    const stored = storage?.getItem(PREFERENCE_KEY);
    if (stored === 'saved' || stored === 'local') preference = stored;
  } catch { /* Browser storage is optional; the configured saved voice remains default. */ }
  function stop() {
    generation++;
    if (current) { try { current.pause(); } catch {} current = null; }
    synth?.cancel(); finish?.(false); finish = null;
  }
  async function bounded(controller, task, timeoutMs = limits.fetchMs) {
    let onAbort;
    const aborted = new Promise((_, reject) => { onAbort = () => reject(savedUnavailable()); controller.signal.addEventListener('abort', onAbort, { once: true }); });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (controller.signal.aborted) throw savedUnavailable();
      return await Promise.race([Promise.resolve().then(task), aborted]);
    } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); }
  }
  function clearClips() {
    cacheEpoch++;
    for (const job of queue.splice(0)) job.reject(savedUnavailable());
    pending.clear();
    for (const controller of fetching) controller.abort();
    for (const url of cache.values()) revokeUrl(url);
    cache.clear();
  }
  // The hub's voices are read once and refreshed every ten minutes (or on
  // refresh(), at each Chat session start), never once per say. A stale value is used while
  // its refresh runs in the background.
  async function savedVoice() {
    if (voiceId && now() - voiceAt < limits.voiceRefreshMs) return voiceId;
    if (voiceId) { if (!metadata) fetchVoice().catch(() => {}); return voiceId; }
    return fetchVoice();
  }
  async function fetchVoice() {
    if (metadata) return metadata;
    const controller = new AbortController(), epoch = metadataEpoch;
    metadataController = controller;
    const work = bounded(controller, async () => {
      const response = await fetcher('/voices', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw savedUnavailable();
      const result = await response.json();
      if (controller.signal.aborted || epoch !== metadataEpoch || result?.enabled !== true || typeof result.current !== 'string' || !result.current || result.current.length > 256) throw savedUnavailable();
      // An older hub names no helper voice; a changed id in either role clears the clips.
      const helper = typeof result.helper === 'string' && result.helper.length <= 256 ? result.helper : null;
      if (voiceId !== result.current || helperId !== helper) { voiceId = result.current; helperId = helper; clearClips(); }
      voiceAt = now();
      return voiceId;
    }).finally(() => { if (metadata === work) { metadata = null; metadataController = null; } });
    metadata = work; return work;
  }
  function startable() {
    return queue.findIndex(job => active < (job.background && !job.urgent ? limits.concurrent : limits.urgent));
  }
  function pump() {
    let index;
    while (queue.length && (index = startable()) >= 0) {
      const [job] = queue.splice(index, 1), controller = new AbortController();
      job.controller = controller;
      active++; fetching.add(controller);
      // Test mode counts the characters sent to the saved-voice service.
      try { options.onFetch?.(job.text.length, job.text); } catch { /* Diagnostics never block a clip. */ }
      bounded(controller, async () => {
        const response = await fetcher('/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: job.text, voice: job.role }), signal: controller.signal });
        if (!response.ok) throw savedUnavailable();
        const type = response.headers?.get('content-type');
        if (type && !/^audio\//i.test(type)) throw savedUnavailable();
        const reader = response.body?.getReader();
        if (!reader) throw savedUnavailable();
        const chunks = []; let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 2097152) { controller.abort(); throw savedUnavailable(); }
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        if (controller.signal.aborted || job.epoch !== cacheEpoch || !bytes) throw savedUnavailable();
        const blob = new Blob(chunks, { type: type || 'audio/mpeg' });
        const url = createUrl(blob);
        cache.set(job.key, url);
        if (cache.size > limits.cached) { const oldest = cache.keys().next().value; revokeUrl(cache.get(oldest)); cache.delete(oldest); }
        return url;
      }).then(job.resolve, job.reject).finally(() => {
        active--; fetching.delete(controller);
        if (pending.get(job.key) === job) pending.delete(job.key);
        pump();
      });
    }
  }
  function clip(text, role, priority = false, urgent = false) {
    const key = keyOf(role, text);
    if (cache.has(key)) {
      const url = cache.get(key); cache.delete(key); cache.set(key, url); return Promise.resolve(url);
    }
    if (pending.has(key)) {
      const job = pending.get(key), index = queue.indexOf(job);
      if (!priority) job.background = true;
      if (urgent) job.urgent = true;
      if ((priority || urgent) && index > 0) { queue.splice(index, 1); queue.splice(priority ? 0 : queue.filter(item => !item.background || item.urgent).length, 0, job); }
      pump();
      return job.promise;
    }
    if (queue.length >= limits.queued) {
      if (!priority) return Promise.reject(savedUnavailable());
      const dropped = queue.pop(); pending.delete(dropped.key); dropped.reject(savedUnavailable());
    }
    const job = { text, role, key, epoch: cacheEpoch, background: !priority, urgent };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    pending.set(key, job);
    if (priority) queue.unshift(job);
    else if (urgent) queue.splice(queue.filter(item => !item.background || item.urgent).length, 0, job);
    else queue.push(job);
    pump(); return job.promise;
  }
  function selectedClip(text, role, signal) {
    if (signal.aborted) return Promise.reject(savedUnavailable());
    const key = keyOf(role, text), work = clip(text, role, true), job = pending.get(key);
    const abort = () => {
      if (!job || job.background) return;
      const index = queue.indexOf(job);
      if (index >= 0) { queue.splice(index, 1); if (pending.get(key) === job) pending.delete(key); job.reject(savedUnavailable()); }
      else job.controller?.abort();
    };
    signal.addEventListener('abort', abort, { once: true });
    return work.finally(() => signal.removeEventListener('abort', abort));
  }
  async function say(text, { role, signal, onStart, onEnd, onClip } = {}) {
    stop(); const mine = generation, selected = preference, voice = roleOf(role), key = keyOf(voice, text);
    const fresh = () => mine === generation && !signal?.aborted;
    if (!fresh()) return false;
    if (typeof text !== 'string' || !text.trim() || text.length > 600) throw new Error('No words available');
    const cancel = () => { if (mine === generation) stop(); };
    signal?.addEventListener('abort', cancel, { once: true });
    let started = false, ended = false;
    const notify = callback => { try { callback?.(); } catch { /* Diagnostics cannot block the chosen words. */ } };
    const began = () => { if (fresh() && !started && !ended) { started = true; notify(onStart); } };
    const completed = () => { if (fresh() && !ended) { ended = true; if (started) notify(onEnd); return started; } return false; };
    const preparation = new AbortController();
    // Test mode: was the chosen words' clip ready (hit), on its way (pending) or not asked for yet (miss)?
    const clipUsage = cache => { try { onClip?.({ chars: text.length, cache }); } catch { /* Diagnostics never block speech. */ } };
    const cancelled = new Promise(resolve => { finish = () => { preparation.abort(); resolve(false); }; });
    try {
      if (selected === 'saved') {
        const preparing = bounded(preparation, async () => {
          await savedVoice(); if (!fresh() || preparation.signal.aborted) return null;
          clipUsage(cache.has(key) ? 'hit' : pending.has(key) ? 'pending' : 'miss');
          return selectedClip(text, voice, preparation.signal);
        }, limits.prepareMs);
        const url = await Promise.race([preparing, cancelled]);
        if (!fresh() || !url) return false;
        return await new Promise((resolve, reject) => {
          const audio = makeAudio(url); current = audio;
          finish = () => resolve(false);
          audio.onplaying = began;
          audio.onended = () => resolve(completed());
          audio.onerror = () => { if (fresh()) reject(savedUnavailable()); };
          Promise.resolve(audio.play()).catch(() => { if (fresh()) reject(savedUnavailable()); });
        });
      }
      if (!synth) throw new Error('Device voice unavailable. The words are still here.');
      clipUsage('device');
      return await new Promise((resolve, reject) => {
        const utterance = makeUtterance(text), voices = synth.getVoices();
        utterance.voice = voices.find(v => /^en/i.test(v.lang) && v.localService) || voices.find(v => /^en/i.test(v.lang)) || null;
        utterance.rate = 0.95; utterance.onstart = began;
        utterance.onend = () => resolve(completed());
        utterance.onerror = () => { if (fresh()) reject(new Error('Device voice unavailable. The words are still here.')); };
        finish = () => resolve(false); synth.speak(utterance);
      });
    } catch (error) {
      if (!fresh()) return false;
      throw selected === 'saved' ? savedUnavailable() : error;
    } finally { ended = true; preparation.abort(); signal?.removeEventListener('abort', cancel); if (mine === generation) { current = null; finish = null; } }
  }
  return {
    say, stop,
    getPreference() { return preference; },
    setPreference(value) {
      if (value !== 'saved' && value !== 'local') return;
      preference = value;
      try { storage?.setItem(PREFERENCE_KEY, value); } catch { /* The selection still applies for this page. */ }
    },
    prefetch(choices, { role, urgent = false } = {}) {
      if (preference !== 'saved' || !Array.isArray(choices)) return;
      const epoch = metadataEpoch, voice = roleOf(role);
      savedVoice().then(() => {
        if (preference !== 'saved' || epoch !== metadataEpoch) return;
        for (const item of choices.slice(0, 64)) if (typeof item?.say === 'string' && item.say.trim() && item.say.length <= 600) clip(item.say, voice, false, urgent).catch(() => {});
      }).catch(() => {});
    },
    // Read the hub's voices again before the next clip (each Chat session start).
    refresh() { voiceAt = -Infinity; },
    dispose() { stop(); metadataEpoch++; metadataController?.abort(); metadata = null; metadataController = null; voiceId = null; helperId = null; voiceAt = -Infinity; clearClips(); },
  };
}
