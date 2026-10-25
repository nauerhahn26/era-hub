// Pure session state. Displayed choices are immutable until a new explicit turn.
export const isPartnerTouch = e => e?.isTrusted === true && e.pointerType === 'touch';

export function createChatController(deps = {}) {
  let turn = 0, pending = null, abort = null, speechAbort = null, utterance = 0;
  const listeners = new Set();
  let state = Object.freeze({ phase: 'Off', engineReady: false, wakeEnabled: false, question: '', partial: '', choices: Object.freeze([]), staged: false, error: '', turn });
  function patch(p) { state = Object.freeze({ ...state, ...p }); for (const fn of listeners) fn(state); }
  function invalidate() {
    turn++; utterance++; abort?.abort(); speechAbort?.abort(); abort = new AbortController(); pending = null;
    deps.stopSpeech?.();
    return turn;
  }
  const api = {
    get state() { return state; },
    subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
    ready(wakeEnabled = false) { patch({ engineReady: true, wakeEnabled, phase: state.phase === 'Off' ? (wakeEnabled ? 'Local wake listening' : 'Ready to ask') : state.phase, error: '' }); },
    ask() {
      invalidate();
      patch({ turn, phase: 'Capturing question', question: '', partial: '', choices: Object.freeze([]), staged: false, error: '' });
    },
    partial(text) { if (state.phase === 'Capturing question') patch({ partial: String(text || '').slice(0, 600) }); },
    async prepare(text) {
      const question = String(text || '').trim().slice(0, 600);
      if (!question) { api.fail('No question heard. Try again, or use a phrase.'); return; }
      const mine = invalidate();
      patch({ turn, phase: 'Preparing', question, partial: '', choices: Object.freeze([]), staged: false, error: '' });
      try {
        const result = await deps.requestChoices?.({ text: question, signal: abort.signal });
        if (mine !== turn) return;
        const clean = (result?.choices || []).filter(x => x && typeof x.label === 'string' && typeof x.say === 'string' && x.say.trim()).slice(0, 4)
          .map((x, i) => Object.freeze({ id: `${mine}:${i}`, label: x.label.slice(0, 100), say: x.say.slice(0, 600) }));
        if (!clean.length) throw new Error('No suggestions available. Your phrases still work.');
        pending = Object.freeze(clean);
        patch({ staged: true });
        // Preparation is silent. Audio can warm without speaking a suggestion.
        deps.prefetch?.(pending);
      } catch (e) {
        if (mine !== turn) return;
        // Final recognition has already paused capture. A failed reply request
        // cannot truthfully restore listening without an acknowledged rearm.
        api.fail('Replies are unavailable. Chat is off. Your phrases still work.');
        await deps.onChoicesError?.();
      }
    },
    neutral() {
      if (!pending || state.phase !== 'Preparing') return false;
      const next = pending; pending = null;
      deps.beforeChoices?.();
      patch({ choices: next, staged: false, phase: 'Your turn' });
      return true;
    },
    async select(id, expectedTurn = turn) {
      if (expectedTurn !== turn || !['Your turn', 'Speaking'].includes(state.phase)) return false;
      const c = state.choices.find(x => x.id === id);
      if (!c) return false;
      return api.sayFixed(c.say);
    },
    async sayFixed(text) {
      const mine = turn, spoken = ++utterance;
      speechAbort?.abort(); speechAbort = new AbortController();
      deps.stopSpeech?.();
      const back = state.choices.length ? 'Your turn' : state.engineReady ? (state.wakeEnabled ? 'Local wake listening' : 'Ready to ask') : 'Off';
      patch({ phase: 'Speaking' });
      try { await deps.speak?.({ say: text }, { signal: speechAbort.signal }); }
      catch { if (mine === turn && spoken === utterance) patch({ error: 'Sound unavailable. The words are still here.' }); }
      if (mine === turn && spoken === utterance && state.phase === 'Speaking') patch({ phase: pending ? 'Preparing' : back });
      return true;
    },
    fail(message) {
      invalidate();
      patch({ turn, staged: false, engineReady: false, wakeEnabled: false, error: String(message || 'Live listening unavailable. Your phrases still work.'), phase: state.choices.length ? 'Your turn' : 'Off' });
    },
    stop() {
      invalidate();
      patch({ turn, phase: 'Off', engineReady: false, wakeEnabled: false, question: '', partial: '', choices: Object.freeze([]), staged: false, error: '' });
    },
  };
  return api;
}

// Streaming weighted-bin resampling; phase carries across worklet messages.
// Frames are 100ms, little-endian signed PCM16, independent of device rate.
export function createPCM16Resampler(inputRate, emit) {
  if (!Number.isFinite(inputRate) || inputRate <= 0) throw new Error('Invalid audio rate');
  const ratio = inputRate / 16000;
  let remaining = ratio, sum = 0, frame = new Int16Array(1600), index = 0;
  function output(value) {
    const clipped = Math.max(-1, Math.min(1, value));
    frame[index++] = Math.round(clipped * (clipped < 0 ? 32768 : 32767));
    if (index === frame.length) { emit(frame.buffer); frame = new Int16Array(1600); index = 0; }
  }
  return {
    push(samples) {
      for (const sample of samples) {
        let portion = 1;
        while (portion > 1e-9) {
          const used = Math.min(portion, remaining);
          sum += sample * used; portion -= used; remaining -= used;
          if (remaining < 1e-9) { output(sum / ratio); sum = 0; remaining = ratio; }
        }
      }
    },
    flush() { if (index) { emit(frame.buffer.slice(0, index * 2)); index = 0; } },
  };
}
