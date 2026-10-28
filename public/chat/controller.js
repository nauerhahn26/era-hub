// Pure session state. Displayed choices are immutable: within one listening
// window a replacement batch is a new sealed batch, swapped in whole at a
// neutral moment (design 2026-10-27 §4.5), never an edit of the shown one.
export const isPartnerTouch = e => e?.isTrusted === true && e.pointerType === 'touch';

// The hub's choices, checked: at most four with words to say. The hub's
// decorative picture pick (spec §6) rides along; it never changes the words.
function cleanChoices(list, prefix) {
  return (Array.isArray(list) ? list : []).filter(x => x && typeof x.label === 'string' && typeof x.say === 'string' && x.say.trim()).slice(0, 4)
    .map((x, i) => Object.freeze({ id: `${prefix}:${i}`, label: x.label.slice(0, 100), say: x.say.slice(0, 600),
      ...(typeof x.symbol === 'string' && x.symbol.length <= 64 ? { symbol: x.symbol } : {}),
      ...(Number.isSafeInteger(x.symbolId) && x.symbolId > 0 ? { symbolId: x.symbolId } : {}) }));
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
  let turn = 0, pending = null, abort = null, speechAbort = null, utterance = 0;
  // At most one replacement waits for a neutral moment; a newer one supersedes it unseen.
  let replacement = null, batches = 0;
  const listeners = new Set();
  // `stale`: the choices shown are a finished turn's, kept after a press until
  // a neutral moment (design §2: a tile never changes under her gaze);
  // clearStale() (or a centre gaze, neutral()) removes them. `staleTurn` is the
  // turn they were drawn in: a dwell completed on one of them is her pick and
  // speaks it (select with that turn), ending the press window as any pick does.
  let state = Object.freeze({ phase: 'Off', engineReady: false, wakeEnabled: false, question: '', partial: '', choices: Object.freeze([]), staged: false, replacing: false, stale: false, staleTurn: null, error: '', turn });
  function timing(name) { try { deps.onTiming?.(name); } catch { /* Diagnostics never interrupt communication. */ } }
  function patch(p) { state = Object.freeze({ ...state, ...p, replacing: replacement !== null }); for (const fn of listeners) fn(state); }
  function invalidate() {
    turn++; utterance++; abort?.abort(); speechAbort?.abort(); abort = new AbortController(); pending = null; replacement = null;
    deps.stopSpeech?.();
    return turn;
  }
  const api = {
    get state() { return state; },
    subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
    ready(wakeEnabled = false) { patch({ engineReady: true, wakeEnabled, phase: state.phase === 'Off' ? (wakeEnabled ? 'Local wake listening' : 'Ready to ask') : state.phase, error: '' }); },
    // keepShown (a press): the last turn's tiles stay, stale, until a neutral moment.
    ask({ keepShown = false } = {}) {
      const drawnIn = state.stale ? state.staleTurn : turn;
      invalidate();
      const stale = (keepShown || state.stale) && state.choices.length > 0;
      patch({ turn, phase: 'Capturing question', question: '', partial: '', choices: stale ? state.choices : Object.freeze([]), stale, staleTurn: stale ? drawnIn : null, staged: false, error: '' });
    },
    clearStale() {
      if (!state.stale) return false;
      const phase = state.phase === 'Your turn' ? (state.engineReady ? (state.wakeEnabled ? 'Local wake listening' : 'Ready to ask') : 'Off') : state.phase;
      patch({ choices: Object.freeze([]), stale: false, staleTurn: null, phase });
      return true;
    },
    partial(text) { if (state.phase === 'Capturing question') patch({ partial: String(text || '').slice(0, 600) }); },
    async prepare(text) {
      const question = String(text || '').trim().slice(0, 600);
      if (!question) { api.fail('No question heard. Try again, or use a phrase.'); return; }
      const mine = invalidate();
      patch({ turn, phase: 'Preparing', question, partial: '', choices: state.stale ? state.choices : Object.freeze([]), staged: false, error: '' });
      try {
        const result = await deps.requestChoices?.({ text: question, signal: abort.signal });
        if (mine !== turn) return;
        const clean = cleanChoices(result?.choices, `${mine}`);
        if (!clean.length) throw new Error('No suggestions available. Your phrases still work.');
        pending = Object.freeze(clean);
        timing('choicesReady');
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
    // A batch for the same window while one is shown: staged, never drawn
    // until neutral(). Refused unless a batch is showing in 'Your turn'.
    replace(choices) {
      if (state.phase !== 'Your turn' || !state.choices.length || state.stale) return false;
      const clean = cleanChoices(choices, `${turn}.${++batches}`);
      if (!clean.length) return false;
      if (replacement) timing('replacementSuperseded');
      replacement = Object.freeze(clean);
      patch({});
      return true;
    },
    // A cancelled window: a replacement still waiting is dropped unseen.
    dropReplacement() { if (!replacement) return false; replacement = null; patch({}); return true; },
    neutral() {
      api.clearStale();
      if (replacement && state.phase === 'Your turn') {
        const next = place(state.choices, replacement); replacement = null;
        deps.beforeChoices?.();
        timing('replaced');
        patch({ choices: next });
        return true;
      }
      if (!pending || state.phase !== 'Preparing') return false;
      const next = pending; pending = null;
      deps.beforeChoices?.();
      timing('revealed');
      patch({ choices: next, staged: false, phase: 'Your turn' });
      return true;
    },
    async select(id, expectedTurn = turn) {
      // A still-shown old tile after a press (design §4.5, a pick wins): her
      // dwell speaks it; whatever the window was preparing is dropped unseen.
      const stalePick = state.stale && expectedTurn === state.staleTurn;
      if (!stalePick && (expectedTurn !== turn || state.stale || !['Your turn', 'Speaking'].includes(state.phase))) return false;
      const c = state.choices.find(x => x.id === id);
      if (!c) return false;
      if (stalePick) { invalidate(); patch({ turn, question: '', partial: '', staged: false, error: '' }); }
      timing('selected');
      return api.sayFixed(c.say);
    },
    async sayFixed(text) {
      const mine = turn, spoken = ++utterance;
      replacement = null; // a pick wins: anything waiting to replace the shown batch is dropped
      speechAbort?.abort(); speechAbort = new AbortController();
      deps.stopSpeech?.();
      timing('speechRequested');
      const back = state.choices.length && !state.stale ? 'Your turn' : state.engineReady ? (state.wakeEnabled ? 'Local wake listening' : 'Ready to ask') : 'Off';
      patch({ phase: 'Speaking', error: '' });
      try { await deps.speak?.({ say: text }, { signal: speechAbort.signal }); }
      catch (error) { if (mine === turn && spoken === utterance) patch({ error: error?.code === 'saved-voice-unavailable'
        ? 'Saved voice is unavailable. Choose Device voice in partner settings to use it instead. The words are still here.'
        : 'Sound unavailable. The words are still here.' }); }
      if (mine === turn && spoken === utterance && state.phase === 'Speaking') patch({ phase: pending ? 'Preparing' : back });
      return true;
    },
    // A listening window that ends with nothing to show (nothing said, or
    // cancelled before a batch was revealed) goes back to where a turn starts:
    // anything staged and unseen is dropped; nothing shown ever changes.
    idle() {
      if (!['Capturing question', 'Preparing'].includes(state.phase)) return false;
      invalidate();
      patch({ turn, phase: state.choices.length && !state.stale ? 'Your turn' : state.engineReady ? (state.wakeEnabled ? 'Local wake listening' : 'Ready to ask') : 'Off',
        question: '', partial: '', staged: false, error: '' });
      return true;
    },
    fail(message) {
      invalidate();
      patch({ turn, staged: false, engineReady: false, wakeEnabled: false, error: String(message || 'Live listening unavailable. Your phrases still work.'), phase: state.choices.length && !state.stale ? 'Your turn' : 'Off' });
    },
    stop() {
      invalidate();
      patch({ turn, phase: 'Off', engineReady: false, wakeEnabled: false, question: '', partial: '', choices: Object.freeze([]), staged: false, stale: false, staleTurn: null, error: '' });
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
