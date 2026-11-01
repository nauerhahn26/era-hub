// Reading the options aloud (spec 2026-10-28 §6). Pure: no DOM, no voice of
// its own. When a batch is revealed and she has not answered after a silence,
// the reader says "<name>, your options are", then each reply label in spoken
// order, each tile lit while its clip plays. A glance (dwell progress) never
// stops it (amended 10/31 night); the page cancels it on a selection, a page
// or mode swap, a hold, Clear, Back or the partner dialog. After a full reading
// the same delay re-arms, up to PROMPT_READINGS readings of a batch, then
// quiet. The page arms a batch once; a delay of 0 is off. onStart(text, n)
// gets the reading's whole spoken text and its number, onEnd() follows each
// reading's end or cancel (spec §13: the page tells the hub its words as one clip).
export const PROMPT_GAP_MS = 350, PROMPT_READINGS = 3;

const value = v => (typeof v === 'function' ? v() : v);

export function createOptionsReader({ delayMs = 0, name = '', speak, light = () => {}, unlight = () => {}, onStart = () => {}, onEnd = () => {},
  gapMs = PROMPT_GAP_MS, setTimeout: later = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout } = {}) {
  let seen = null, run = null, last = 0;
  const safe = fn => { try { fn(); } catch { /* lighting never breaks the reading */ } };

  // The current run (timer, then reading) ends: cancelled or done.
  function finish(current, result) {
    if (!current || current.done) return;
    current.done = true; clear(current.timer); current.abort.abort();
    if (current.lit) { const item = current.lit; current.lit = null; safe(() => unlight(item)); }
    if (current.started) { current.started = false; safe(onEnd); }
    if (run === current) run = null;
    current.resolve({ ...result, readings: current.readings });
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
    const who = String(value(name) || '').trim(), intro = who ? `${who}, your options are` : 'Your options are';
    current.started = true; current.read = 0; last = ++current.readings;
    try { onStart([intro, ...items.map(item => item.label)].join(', '), current.readings); } catch { /* telemetry never blocks */ }
    await say(current, intro);
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
    if (current.readings >= PROMPT_READINGS) { finish(current, { read: n, cancelled: false }); return; }
    // Unanswered: the same delay again, then the next reading.
    current.started = false; safe(onEnd);
    current.timer = later(() => { if (!current.done) void read(current, items); }, current.delay);
  }

  return {
    // Starts the silence timer for this batch, once per batch.
    armed(batch) {
      const id = batch?.id, items = Array.isArray(batch?.items) ? batch.items.filter(item => item && typeof item.label === 'string' && item.label) : [];
      const delay = Number(value(delayMs)) || 0;
      if (id === undefined || id === null || id === seen) return Promise.resolve({ read: 0, cancelled: true, readings: 0 });
      if (delay <= 0 || !items.length) return Promise.resolve({ read: 0, cancelled: true, readings: 0 });
      seen = id;
      finish(run, { read: run?.read || 0, cancelled: true });
      const current = { done: false, timer: null, lit: null, read: 0, readings: 0, started: false, delay, abort: new AbortController(), resolve: null };
      last = 0;
      const result = new Promise(resolve => { current.resolve = resolve; });
      current.timer = later(() => { if (!current.done) void read(current, items); }, delay);
      run = current;
      return result;
    },
    cancel() { if (run) finish(run, { read: run.read, cancelled: true }); },
    get reading() { return !!run && !run.done; },
    // Readings started of the batch armed last (0 before the first).
    get readings() { return last; },
  };
}
