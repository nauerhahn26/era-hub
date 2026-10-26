// Chat owns a cancellation-safe voice path without changing the shared engine.
export function createChatVoice(options = {}) {
  const fetcher = options.fetch || ((...args) => fetch(...args));
  const synth = options.synth || globalThis.speechSynthesis;
  const makeAudio = options.makeAudio || (url => new Audio(url));
  const makeUtterance = options.makeUtterance || (text => new SpeechSynthesisUtterance(text));
  const cache = new Map(), pending = new Map();
  const fetching = new Set();
  let generation = 0, current = null, finish = null, preference = 'local', cacheEpoch = 0;
  function stop() {
    generation++;
    if (current) { current.pause(); current = null; }
    synth?.cancel(); finish?.(); finish = null;
  }
  async function clip(text) {
    if (cache.has(text)) return cache.get(text);
    if (pending.has(text)) return pending.get(text);
    const epoch = cacheEpoch, cancellation = new AbortController();
    fetching.add(cancellation);
    const work = (async () => {
      const r = await fetcher('/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(4000)]) });
      if (!r.ok) throw new Error('Voice unavailable');
      const url = URL.createObjectURL(await r.blob());
      if (epoch !== cacheEpoch) { URL.revokeObjectURL(url); throw new Error('Voice preparation canceled'); }
      cache.set(text, url);
      if (cache.size > 64) { const oldest = cache.keys().next().value; URL.revokeObjectURL(cache.get(oldest)); cache.delete(oldest); }
      return url;
    })().finally(() => { pending.delete(text); fetching.delete(cancellation); });
    pending.set(text, work); return work;
  }
  async function say(text, { signal } = {}) {
    stop(); const mine = generation;
    const fresh = () => mine === generation && !signal?.aborted;
    if (!fresh()) return;
    signal?.addEventListener('abort', stop, { once: true });
    try {
      let url = cache.get(text);
      if (preference === 'saved' && !url) {
        // Never leave a selected answer waiting indefinitely for remote audio.
        url = await Promise.race([clip(text).catch(() => null), new Promise(r => setTimeout(() => r(null), 800))]);
      }
      if (!fresh()) return; // Includes cancellation WHILE a clip was fetching.
      if ((preference === 'saved' || !synth) && url) {
        await new Promise((resolve, reject) => {
          const a = makeAudio(url); current = a;
          finish = resolve; a.onended = resolve; a.onerror = () => reject(new Error('Audio failed'));
          a.play().catch(reject);
        });
      } else if (synth) {
        await new Promise((resolve, reject) => {
          const u = makeUtterance(text);
          const voices = synth.getVoices();
          u.voice = voices.find(v => /^en/i.test(v.lang) && v.localService) || voices.find(v => /^en/i.test(v.lang)) || null;
          u.rate = 0.95; u.onend = resolve; u.onerror = () => reject(new Error('Device voice failed'));
          finish = resolve; synth.speak(u);
        });
      } else throw new Error('No voice available');
    } finally { signal?.removeEventListener('abort', stop); if (mine === generation) { current = null; finish = null; } }
  }
  return {
    say, stop,
    setPreference(value) { preference = value === 'saved' ? 'saved' : 'local'; },
    prefetch(choices) { if (preference === 'saved') for (const c of choices) clip(c.say).catch(() => {}); },
    dispose() { stop(); cacheEpoch++; for (const c of fetching) c.abort(); fetching.clear(); for (const url of cache.values()) URL.revokeObjectURL(url); cache.clear(); pending.clear(); },
  };
}
