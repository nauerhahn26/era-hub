// Chat owns a cancellation-safe voice path without changing the shared engine.
const PREFERENCE_KEY = 'chat:voicePreference';
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
  const limits = { concurrent: 2, queued: 32, cached: 64, fetchMs: 10000, prepareMs: 8000, ...options.limits };
  const cache = new Map(), pending = new Map(), queue = [], fetching = new Set();
  let generation = 0, current = null, finish = null, preference = 'saved', cacheEpoch = 0;
  let voiceId = null, metadata = null, metadataController = null, metadataEpoch = 0, active = 0;
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
  async function savedVoice() {
    if (metadata) return metadata;
    const controller = new AbortController(), epoch = metadataEpoch;
    metadataController = controller;
    const work = bounded(controller, async () => {
      const response = await fetcher('/voices', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw savedUnavailable();
      const result = await response.json();
      if (controller.signal.aborted || epoch !== metadataEpoch || result?.enabled !== true || typeof result.current !== 'string' || !result.current || result.current.length > 256) throw savedUnavailable();
      if (voiceId !== result.current) { voiceId = result.current; clearClips(); }
      return voiceId;
    }).finally(() => { if (metadata === work) { metadata = null; metadataController = null; } });
    metadata = work; return work;
  }
  function pump() {
    while (active < limits.concurrent && queue.length) {
      const job = queue.shift(), controller = new AbortController();
      job.controller = controller;
      active++; fetching.add(controller);
      bounded(controller, async () => {
        const response = await fetcher('/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: job.text }), signal: controller.signal });
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
        cache.set(job.text, url);
        if (cache.size > limits.cached) { const oldest = cache.keys().next().value; revokeUrl(cache.get(oldest)); cache.delete(oldest); }
        return url;
      }).then(job.resolve, job.reject).finally(() => {
        active--; fetching.delete(controller);
        if (pending.get(job.text) === job) pending.delete(job.text);
        pump();
      });
    }
  }
  function clip(text, priority = false) {
    if (cache.has(text)) {
      const url = cache.get(text); cache.delete(text); cache.set(text, url); return Promise.resolve(url);
    }
    if (pending.has(text)) {
      const job = pending.get(text), index = queue.indexOf(job);
      if (!priority) job.background = true;
      if (priority && index > 0) { queue.splice(index, 1); queue.unshift(job); }
      return job.promise;
    }
    if (queue.length >= limits.queued) {
      if (!priority) return Promise.reject(savedUnavailable());
      const dropped = queue.pop(); pending.delete(dropped.text); dropped.reject(savedUnavailable());
    }
    const job = { text, epoch: cacheEpoch, background: !priority };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    pending.set(text, job);
    if (priority) queue.unshift(job); else queue.push(job);
    pump(); return job.promise;
  }
  function selectedClip(text, signal) {
    if (signal.aborted) return Promise.reject(savedUnavailable());
    const work = clip(text, true), job = pending.get(text);
    const abort = () => {
      if (!job || job.background) return;
      const index = queue.indexOf(job);
      if (index >= 0) { queue.splice(index, 1); if (pending.get(text) === job) pending.delete(text); job.reject(savedUnavailable()); }
      else job.controller?.abort();
    };
    signal.addEventListener('abort', abort, { once: true });
    return work.finally(() => signal.removeEventListener('abort', abort));
  }
  async function say(text, { signal, onStart, onEnd } = {}) {
    stop(); const mine = generation, selected = preference;
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
    const cancelled = new Promise(resolve => { finish = () => { preparation.abort(); resolve(false); }; });
    try {
      if (selected === 'saved') {
        const preparing = bounded(preparation, async () => {
          await savedVoice(); if (!fresh() || preparation.signal.aborted) return null;
          return selectedClip(text, preparation.signal);
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
    prefetch(choices) {
      if (preference !== 'saved' || !Array.isArray(choices)) return;
      const epoch = metadataEpoch;
      savedVoice().then(() => {
        if (preference !== 'saved' || epoch !== metadataEpoch) return;
        for (const item of choices.slice(0, 64)) if (typeof item?.say === 'string' && item.say.trim() && item.say.length <= 600) clip(item.say).catch(() => {});
      }).catch(() => {});
    },
    dispose() { stop(); metadataEpoch++; metadataController?.abort(); metadata = null; metadataController = null; voiceId = null; clearClips(); },
  };
}
