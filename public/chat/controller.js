// Pure session state. Displayed choices are immutable until a new explicit turn.
// A sealed batch is shown the moment it arrives (spec 2026-10-27 §4): no gaze gate.
export const isPartnerTouch = e => e?.isTrusted === true && e.pointerType === 'touch';

export function createChatController(deps = {}) {
  let turn = 0, preparing = false, abort = null, speechAbort = null, utterance = 0;
  const listeners = new Set();
  // standby: no session is live, but a hold starts one (no Start Chat, 10/27 evening).
  let state = Object.freeze({ phase: 'Off', engineReady: false, wakeEnabled: false, standby: false, question: '', partial: '', choices: Object.freeze([]), error: '', hint: '', turn });
  function timing(name) { try { deps.onTiming?.(name); } catch { /* Diagnostics never interrupt communication. */ } }
  function patch(p) { state = Object.freeze({ ...state, ...p }); for (const fn of listeners) fn(state); }
  function invalidate() {
    turn++; utterance++; abort?.abort(); speechAbort?.abort(); abort = new AbortController(); preparing = false;
    deps.stopSpeech?.();
    return turn;
  }
  const api = {
    get state() { return state; },
    subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
    ready(wakeEnabled = false) { patch({ engineReady: true, wakeEnabled, standby: false, phase: state.phase === 'Off' ? (wakeEnabled ? 'Local wake listening' : 'Ready to ask') : state.phase, error: '' }); },
    // The session ended by itself (lifetime, hub restart) with no hold in progress:
    // nothing to report; the next hold starts a new one. Answers on the board stay.
    standby() {
      patch({ engineReady: false, wakeEnabled: false, standby: true, error: '',
        phase: ['Off', 'Ready to ask', 'Local wake listening'].includes(state.phase) ? 'Ready to ask' : state.phase });
    },
    ask() {
      invalidate();
      patch({ turn, phase: 'Capturing question', question: '', partial: '', choices: Object.freeze([]), error: '', hint: '' });
    },
    // A hold that ended without a question (a slip, a too-quick tap, nothing heard):
    // only that hold is dropped. The engine stays ready and the partner sees a hint.
    retry(hint) {
      invalidate();
      patch({ turn, phase: state.engineReady ? (state.wakeEnabled ? 'Local wake listening' : 'Ready to ask') : state.standby ? 'Ready to ask' : 'Off', question: '', partial: '', error: '', hint: String(hint || '').slice(0, 200) });
    },
    partial(text) { if (state.phase === 'Capturing question') patch({ partial: String(text || '').slice(0, 600) }); },
    async prepare(text) {
      const question = String(text || '').trim().slice(0, 600);
      if (!question) { api.fail('No question heard. Try again, or use a phrase.'); return; }
      const mine = invalidate();
      preparing = true;
      patch({ turn, phase: 'Preparing', question, partial: '', choices: Object.freeze([]), error: '', hint: '' });
      try {
        const result = await deps.requestChoices?.({ text: question, signal: abort.signal });
        if (mine !== turn) return;
        const clean = (result?.choices || []).filter(x => x && typeof x.label === 'string' && typeof x.say === 'string' && x.say.trim()).slice(0, 4)
          .map((x, i) => Object.freeze({ id: `${mine}:${i}`, label: x.label.slice(0, 100), say: x.say.slice(0, 600),
            // The hub's decorative picture pick (spec §6) rides along; it never changes the words.
            ...(typeof x.symbol === 'string' && x.symbol.length <= 64 ? { symbol: x.symbol } : {}),
            ...(Number.isSafeInteger(x.symbolId) && x.symbolId > 0 ? { symbolId: x.symbolId } : {}),
            // A letter or number tile the page draws big, with no picture.
            ...(x.glyph === true ? { glyph: true } : {}) }));
        if (!clean.length) throw new Error('No suggestions available. Your phrases still work.');
        const next = Object.freeze(clean);
        preparing = false;
        timing('choicesReady');
        // Preparation is silent. Audio can warm without speaking a suggestion.
        try { deps.prefetch?.(next); } catch { /* Warming never holds the reveal back. */ }
        // Shown at once, wherever her gaze is. Dwell settles first (250 ms), so
        // nothing under her gaze can select as the batch lands. A phrase still
        // playing keeps playing; the reveal itself speaks nothing.
        deps.beforeChoices?.();
        timing('revealed');
        patch({ choices: next, phase: state.phase === 'Speaking' ? 'Speaking' : 'Your turn' });
      } catch (e) {
        if (mine !== turn) return;
        // Final recognition has already paused capture. A failed reply request
        // cannot truthfully restore listening without an acknowledged rearm.
        api.fail('Replies are unavailable. Chat is off. Your phrases still work.');
        await deps.onChoicesError?.();
      }
    },
    async select(id, expectedTurn = turn) {
      if (expectedTurn !== turn || !['Your turn', 'Speaking'].includes(state.phase)) return false;
      const c = state.choices.find(x => x.id === id);
      if (!c) return false;
      timing('selected');
      return api.sayFixed(c.say);
    },
    async sayFixed(text) {
      const mine = turn, spoken = ++utterance;
      speechAbort?.abort(); speechAbort = new AbortController();
      deps.stopSpeech?.();
      timing('speechRequested');
      const back = state.choices.length ? 'Your turn' : state.engineReady ? (state.wakeEnabled ? 'Local wake listening' : 'Ready to ask') : state.standby ? 'Ready to ask' : 'Off';
      patch({ phase: 'Speaking', error: '', hint: '' });
      try { await deps.speak?.({ say: text }, { signal: speechAbort.signal }); }
      catch (error) { if (mine === turn && spoken === utterance) patch({ error: error?.code === 'saved-voice-unavailable'
        ? 'Saved voice is unavailable. Choose Device voice in partner settings to use it instead. The words are still here.'
        : 'Sound unavailable. The words are still here.' }); }
      if (mine === turn && spoken === utterance && state.phase === 'Speaking') patch({ phase: state.choices.length ? 'Your turn' : preparing ? 'Preparing' : back });
      return true;
    },
    fail(message) {
      invalidate();
      patch({ turn, engineReady: false, wakeEnabled: false, standby: false, hint: '', error: String(message || 'Live listening unavailable. Your phrases still work.'), phase: state.choices.length ? 'Your turn' : 'Off' });
    },
    stop() {
      invalidate();
      patch({ turn, phase: 'Off', engineReady: false, wakeEnabled: false, standby: false, question: '', partial: '', choices: Object.freeze([]), error: '', hint: '' });
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
