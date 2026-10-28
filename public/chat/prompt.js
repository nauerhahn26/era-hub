// Reading the options aloud (spec 2026-10-28 §6). Pure: no DOM, no voice of
// its own. When a batch is revealed and she has not answered after a silence,
// the reader says "<name>, your options are", then each reply label in spoken
// order, each tile lit while its clip plays. Any dwell progress, selection,
// page or mode swap, hold or partner dialog cancels it at once. A batch is
// read at most once; a delay of 0 is off.
export const PROMPT_GAP_MS = 350;

const value = v => (typeof v === 'function' ? v() : v);

export function createOptionsReader({ delayMs = 0, name = '', speak, light = () => {}, unlight = () => {}, onStart = () => {},
  gapMs = PROMPT_GAP_MS, setTimeout: later = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout } = {}) {
  let seen = null, run = null;
  const safe = fn => { try { fn(); } catch { /* lighting never breaks the reading */ } };

  // The current run (timer, then reading) ends: cancelled or done.
  function finish(current, result) {
    if (!current || current.done) return;
    current.done = true; clear(current.timer); current.abort.abort();
    if (current.lit) { const item = current.lit; current.lit = null; safe(() => unlight(item)); }
    if (run === current) run = null;
    current.resolve(result);
  }
  function wait(current, ms) {
    return new Promise(resolve => {
      const id = later(resolve, ms);
      current.abort.signal.addEventListener('abort', () => { clear(id); resolve(); }, { once: true });
    });
  }
  async function say(current, text) {
    try { await speak(text, current.abort.signal); } catch { /* a clip that fails moves on */ }
  }
  async function read(current, items) {
    try { onStart(); } catch { /* telemetry never blocks */ }
    const who = String(value(name) || '').trim();
    await say(current, who ? `${who}, your options are` : 'Your options are');
    let n = 0;
    for (const [i, item] of items.entries()) {
      if (current.done) return;
      if (i) { await wait(current, gapMs); if (current.done) return; }
      current.lit = item; safe(() => light(item));
      await say(current, item.label);
      if (current.done) return;
      current.lit = null; safe(() => unlight(item)); n++;
      current.read = n;
    }
    finish(current, { read: n, cancelled: false });
  }

  return {
    // Starts the silence timer for this batch, once per batch.
    armed(batch) {
      const id = batch?.id, items = Array.isArray(batch?.items) ? batch.items.filter(item => item && typeof item.label === 'string' && item.label) : [];
      const delay = Number(value(delayMs)) || 0;
      if (id === undefined || id === null || id === seen) return Promise.resolve({ read: 0, cancelled: true });
      if (delay <= 0 || !items.length) return Promise.resolve({ read: 0, cancelled: true });
      seen = id;
      finish(run, { read: run?.read || 0, cancelled: true });
      const current = { done: false, timer: null, lit: null, read: 0, abort: new AbortController(), resolve: null };
      const result = new Promise(resolve => { current.resolve = resolve; });
      current.timer = later(() => { if (!current.done) void read(current, items); }, delay);
      run = current;
      return result;
    },
    cancel() { if (run) finish(run, { read: run.read, cancelled: true }); },
    get reading() { return !!run && !run.done; },
  };
}
