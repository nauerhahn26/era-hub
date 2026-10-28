// Pure session state. Displayed choices are immutable until a new explicit turn.
// A sealed batch is shown the moment it arrives (spec 2026-10-27 §4): no gaze gate.
// Two kinds of later batch exist for one shown batch, and they never mix:
// - replace(): a fresh batch she asked for herself (Something else, stable
//   frame 2026-10-28 §3), shown the moment it lands;
// - stageReplacement(): a button-press window's later batch (design 2026-10-27
//   §4.5), swapped in whole at a neutral moment, never an edit of the shown one.
export const isPartnerTouch = e => e?.isTrusted === true && e.pointerType === 'touch';

// A batch as the page shows it: at most four, words required, the hub's picture fields checked.
export function cleanChoices(list, prefix) {
  return (Array.isArray(list) ? list : []).filter(x => x && typeof x.label === 'string' && typeof x.say === 'string' && x.say.trim()).slice(0, 4)
    .map((x, i) => Object.freeze({ id: `${prefix}:${i}`, label: x.label.slice(0, 100), say: x.say.slice(0, 600),
      // The hub's decorative picture pick (spec §6) rides along; it never changes the words.
      ...(typeof x.symbol === 'string' && x.symbol.length <= 64 ? { symbol: x.symbol } : {}),
      ...(Number.isSafeInteger(x.symbolId) && x.symbolId > 0 ? { symbolId: x.symbolId } : {}),
      // A person's own picture, from the hub's /characters/ route only.
      ...(x.picture && typeof x.picture.src === 'string' && /^\/characters\/[a-z0-9][a-z0-9-]{0,39}\.png$/.test(x.picture.src)
        ? { picture: Object.freeze({ src: x.picture.src, kind: 'person' }) } : {}),
      // A letter or number tile the page draws big, with no picture.
      ...(x.glyph === true ? { glyph: true } : {}) }));
}

// Position stability (design §4.5, plan decision 10): a label still in the
// replacement keeps its cell; new labels take never-used cells first, then
// cells a removed label left; a removed label's cell stays empty. A first
// batch carries no cell: its choices stand in cells 0-3 in order.
export const cellOf = (choice, index) => (Number.isInteger(choice?.cell) ? choice.cell : index);
function place(shown, next) {
  const key = label => label.trim().toLowerCase();
  const was = new Map(shown.map((c, i) => [key(c.label), cellOf(c, i)]));
  const used = new Set(shown.map(cellOf)), taken = new Set(), at = [];
  next.forEach((c, i) => { const cell = was.get(key(c.label)); if (cell !== undefined && !taken.has(cell)) { taken.add(cell); at[i] = cell; } });
  const open = [0, 1, 2, 3].filter(n => !used.has(n)).concat([0, 1, 2, 3].filter(n => used.has(n) && !taken.has(n)));
  return Object.freeze(next.map((c, i) => Object.freeze({ ...c, cell: at[i] ?? open.shift() })).sort((a, b) => a.cell - b.cell));
}

export function createChatController(deps = {}) {
  let turn = 0, batch = 0, preparing = false, abort = null, speechAbort = null, utterance = 0;
  // At most one staged replacement waits for a neutral moment; a newer one supersedes it unseen.
  let replacement = null;
  const listeners = new Set();
  // standby: no session is live, but a hold starts one (no Start Chat, 10/27 evening).
  // `stale`: the choices shown are a finished turn's, kept after a press until
  // a neutral moment (design §2: a tile never changes under her gaze) or until
  // the window's first batch shows (at once, like every first batch);
  // clearStale() (or swapReplacement()) removes them. `staleTurn` is the turn they
  // were drawn in: a dwell completed on one of them is her pick and speaks it
  // (select with that turn), ending the press window as any pick does.
  let state = Object.freeze({ phase: 'Off', engineReady: false, wakeEnabled: false, standby: false, question: '', partial: '', choices: Object.freeze([]), replacing: false, stale: false, staleTurn: null, error: '', hint: '', turn });
  function timing(name) { try { deps.onTiming?.(name); } catch { /* Diagnostics never interrupt communication. */ } }
  function patch(p) { state = Object.freeze({ ...state, ...p, replacing: replacement !== null }); for (const fn of listeners) fn(state); }
  function invalidate() {
    turn++; utterance++; abort?.abort(); speechAbort?.abort(); abort = new AbortController(); preparing = false; replacement = null;
    deps.stopSpeech?.();
    return turn;
  }
  const idlePhase = () => state.engineReady ? (state.wakeEnabled ? 'Local wake listening' : 'Ready to ask') : state.standby ? 'Ready to ask' : 'Off';
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
    // keepShown (a press): the last turn's tiles stay, stale, until a neutral moment.
    ask({ keepShown = false } = {}) {
      const drawnIn = state.stale ? state.staleTurn : turn;
      invalidate();
      const stale = (keepShown || state.stale) && state.choices.length > 0;
      patch({ turn, phase: 'Capturing question', question: '', partial: '', choices: stale ? state.choices : Object.freeze([]), stale, staleTurn: stale ? drawnIn : null, error: '', hint: '' });
    },
    clearStale() {
      if (!state.stale) return false;
      const phase = state.phase === 'Your turn' ? idlePhase() : state.phase;
      patch({ choices: Object.freeze([]), stale: false, staleTurn: null, phase });
      return true;
    },
    // A hold that ended without a question (a slip, a too-quick tap, nothing heard):
    // only that hold is dropped. The engine stays ready and the partner sees a hint.
    retry(hint) {
      invalidate();
      patch({ turn, phase: idlePhase(), question: '', partial: '', error: '', hint: String(hint || '').slice(0, 200) });
    },
    partial(text) { if (state.phase === 'Capturing question') patch({ partial: String(text || '').slice(0, 600) }); },
    async prepare(text) {
      const question = String(text || '').trim().slice(0, 600);
      if (!question) { api.fail('No question heard. Try again, or use a phrase.'); return; }
      const mine = invalidate();
      preparing = true;
      patch({ turn, phase: 'Preparing', question, partial: '', choices: state.stale ? state.choices : Object.freeze([]), error: '', hint: '' });
      try {
        const result = await deps.requestChoices?.({ text: question, signal: abort.signal });
        if (mine !== turn) return;
        const clean = cleanChoices(result?.choices, mine);
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
        patch({ choices: next, stale: false, staleTurn: null, phase: state.phase === 'Speaking' ? 'Speaking' : 'Your turn' });
      } catch (e) {
        if (mine !== turn) return;
        // Final recognition has already paused capture. A failed reply request
        // cannot truthfully restore listening without an acknowledged rearm.
        api.fail('Replies are unavailable. Chat is off. Your phrases still work.');
        await deps.onChoicesError?.();
      }
    },
    // A fresh batch for the same question (Something else, spec 2026-10-28 §3):
    // only while that turn's replies are on screen; the ids are new. She asked
    // for it with her own dwell, so it shows the moment it lands; a window's
    // replacement still waiting is dropped with the batch it was to replace.
    replace(choices, expectedTurn = turn) {
      if (expectedTurn !== turn || !state.choices.length || state.stale || !['Your turn', 'Speaking'].includes(state.phase)) return false;
      const next = Object.freeze(cleanChoices(choices, `${turn}.${++batch}`));
      if (!next.length) return false;
      replacement = null;
      try { deps.prefetch?.(next); } catch { /* Warming never holds the reveal back. */ }
      deps.beforeChoices?.();
      patch({ choices: next });
      return true;
    },
    // A batch for the same press window while one is shown (design 2026-10-27
    // §4.5): staged, never drawn until swapReplacement(). Refused unless a
    // batch is showing in 'Your turn'.
    stageReplacement(choices) {
      if (state.phase !== 'Your turn' || !state.choices.length || state.stale) return false;
      const clean = cleanChoices(choices, `${turn}.${++batch}`);
      if (!clean.length) return false;
      if (replacement) timing('replacementSuperseded');
      replacement = Object.freeze(clean);
      // Warming is silent: the voices are ready by the time the swap shows them.
      try { deps.prefetch?.(replacement); } catch { /* Warming never holds the swap back. */ }
      patch({});
      return true;
    },
    // A cancelled window: a replacement still waiting is dropped unseen.
    dropReplacement() { if (!replacement) return false; replacement = null; patch({}); return true; },
    // A neutral moment (her gaze on no tile): stale tiles clear and a waiting
    // replacement swaps in. First batches never wait for it (spec §4).
    swapReplacement() {
      api.clearStale();
      if (!replacement || state.phase !== 'Your turn') return false;
      const next = place(state.choices, replacement); replacement = null;
      deps.beforeChoices?.();
      timing('replaced');
      patch({ choices: next });
      return true;
    },
    // onSelected(choice) runs only for an accepted pick, before anything speaks.
    async select(id, expectedTurn = turn, onSelected) {
      // A still-shown old tile after a press (design §4.5, a pick wins): her
      // dwell speaks it; whatever the window was preparing is dropped unseen.
      const stalePick = state.stale && expectedTurn === state.staleTurn;
      if (!stalePick && (expectedTurn !== turn || state.stale || !['Your turn', 'Speaking'].includes(state.phase))) return false;
      const c = state.choices.find(x => x.id === id);
      if (!c) return false;
      if (stalePick) { invalidate(); patch({ turn, question: '', partial: '', error: '' }); }
      onSelected?.(c);
      timing('selected');
      return api.sayFixed(c.say);
    },
    // echo: the partner's own words said again (the question strip); speak() is told.
    async sayFixed(text, { echo = false } = {}) {
      const mine = turn, spoken = ++utterance;
      replacement = null; // a pick wins: anything waiting to replace the shown batch is dropped
      speechAbort?.abort(); speechAbort = new AbortController();
      deps.stopSpeech?.();
      timing('speechRequested');
      const back = state.choices.length && !state.stale ? 'Your turn' : idlePhase();
      patch({ phase: 'Speaking', error: '', hint: '' });
      try { await deps.speak?.(echo ? { say: text, echo: true } : { say: text }, { signal: speechAbort.signal }); }
      catch (error) { if (mine === turn && spoken === utterance) patch({ error: error?.code === 'saved-voice-unavailable'
        ? 'Saved voice is unavailable. Choose Device voice in partner settings to use it instead. The words are still here.'
        : 'Sound unavailable. The words are still here.' }); }
      if (mine === turn && spoken === utterance && state.phase === 'Speaking') patch({ phase: state.choices.length && !state.stale ? 'Your turn' : preparing ? 'Preparing' : back });
      return true;
    },
    // A listening window that ends with nothing to show (nothing said, or
    // cancelled before a batch was revealed) goes back to where a turn starts:
    // anything staged and unseen is dropped; nothing shown ever changes.
    idle() {
      if (!['Capturing question', 'Preparing'].includes(state.phase)) return false;
      invalidate();
      patch({ turn, phase: state.choices.length && !state.stale ? 'Your turn' : idlePhase(), question: '', partial: '', error: '' });
      return true;
    },
    fail(message) {
      invalidate();
      patch({ turn, engineReady: false, wakeEnabled: false, standby: false, hint: '', error: String(message || 'Live listening unavailable. Your phrases still work.'), phase: state.choices.length && !state.stale ? 'Your turn' : 'Off' });
    },
    stop() {
      invalidate();
      patch({ turn, phase: 'Off', engineReady: false, wakeEnabled: false, standby: false, question: '', partial: '', choices: Object.freeze([]), stale: false, staleTurn: null, error: '', hint: '' });
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
