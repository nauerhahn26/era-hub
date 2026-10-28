// The button-press listening window (design 2026-10-27 §4.4; plan T3.1, T3.3).
//
// A press opens a window. Inside it speech is cut into utterances; each one
// that sounds complete is SEALED: its words join the window's text and the
// caller runs a choice request on the whole window text ("do you want chicken
// or fish, or pasta"), so later words can change earlier choices. Listening
// continues after a seal. The window closes on the first of:
//
//   her pick of a tile                 'pick'          no seal (a pick wins)
//   a second press                     'press'         words heard so far seal first
//   10 s with no new words             'silence'       (unsealed words seal first)
//   60 s since the press               'cap'           (unsealed words seal first)
//   a cancel (the button held 1 s)     'cancel'        nothing seals
//   no words at all within 10 s        'nothing-said'  zero seals: nothing is submitted
//   stop(reason) from outside          reason          nothing seals (a lost stream)
//
// An utterance "sounds complete" when the streaming service says its turn
// ended (turnEnd), or, when no such signal comes, after 15 quiet 100 ms frames
// (1.5 s) following at least 2 energetic ones (the energy gate below, the
// speech worker's own floor). Whichever comes first seals; the same words
// never seal twice. One utterance is capped at 15 s: at the cap it seals and
// listening goes on.
//
// "Words" are the service's running text for the whole window (partials are
// cumulative inside one window turn). The window's 10 s silence counts words,
// not energy: a noisy room never holds the microphone open, and a press with
// no words submits nothing.
//
// Pure: the clock is injected, the caller feeds frames and ticks; no sockets,
// no page, no timers. The speech activity model is never loaded here.
'use strict';

const WINDOW_LIMITS = Object.freeze({ quietFrames: 15, speechFrames: 2, utteranceMs: 15000, silenceMs: 10000, capMs: 60000 });
const normalized = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const clean = text => typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';

function createWindow({ clock = Date.now, limits = {}, seal = () => {}, close = () => {} } = {}) {
  const L = { ...WINDOW_LIMITS, ...limits };
  const openedAt = clock();
  let state = 'open', seq = 0;
  let heard = '', sealed = '', lastWordsAt = openedAt;
  let utterance = { startedAt: null, energetic: 0, quiet: 0 };
  const resetUtterance = () => { utterance = { startedAt: null, energetic: 0, quiet: 0 }; };
  const unsealed = () => !!normalized(heard) && normalized(heard) !== normalized(sealed);

  function trySeal(reason) {
    if (state !== 'open' || !unsealed()) return false;
    const windowText = heard;
    const text = windowText.toLowerCase().startsWith(sealed.toLowerCase()) && sealed ? windowText.slice(sealed.length).trim() || windowText : windowText;
    sealed = windowText; seq++; lastWordsAt = clock(); resetUtterance();
    try { seal({ seq, text, windowText, reason }); } catch { /* the caller's work never breaks the window */ }
    return true;
  }
  function finish(reason) {
    if (state !== 'open') return;
    state = 'closed';
    try { close(reason, { seals: seq, windowText: sealed }); } catch { /* as above */ }
  }
  // The deadlines: one utterance's cap, the window's silence and its cap.
  function tick() {
    if (state !== 'open') return;
    const now = clock();
    if (utterance.startedAt !== null && now - utterance.startedAt >= L.utteranceMs) { trySeal('cap'); resetUtterance(); }
    if (now - openedAt >= L.capMs) { trySeal('close'); finish('cap'); return; }
    if (now - lastWordsAt >= L.silenceMs) {
      const any = trySeal('close') || seq > 0;
      finish(any ? 'silence' : 'nothing-said');
    }
  }
  function heardWords(text) {
    if (!text || text === heard) return false;
    heard = text; lastWordsAt = clock();
    return true;
  }
  const quietEnough = () => utterance.energetic >= L.speechFrames && utterance.quiet >= L.quietFrames;

  return {
    get state() { return state; },
    get seals() { return seq; },
    get text() { return sealed; },
    // One 100 ms frame from the energy gate.
    speech(energetic) {
      if (state !== 'open') return;
      if (energetic) {
        if (utterance.startedAt === null) utterance.startedAt = clock();
        utterance.energetic++; utterance.quiet = 0;
      } else if (utterance.energetic >= L.speechFrames) {
        utterance.quiet++;
        if (quietEnough()) trySeal('silence');
      }
      tick();
    },
    // The service's running text for the whole window.
    partial(text) {
      if (state !== 'open') return;
      if (heardWords(clean(text)) && quietEnough()) trySeal('silence');
      tick();
    },
    // The service says one utterance ended; `text` is that utterance's words.
    turnEnd(text) {
      if (state !== 'open') return;
      const words = clean(text);
      if (!words) return;
      if (!normalized(heard).includes(normalized(words))) heardWords([sealed, words].filter(Boolean).join(' '));
      trySeal('turn-end');
      tick();
    },
    press() { if (state !== 'open') return; trySeal('press'); finish('press'); },
    cancel() { finish('cancel'); },
    pick() { finish('pick'); },
    stop(reason = 'error') { finish(reason); },
    tick,
  };
}

// The speech worker's energy gate (chat-speech-worker.js `measure`), ported:
// 100 ms frames of PCM16 at 16 kHz, energetic when the sample variance reaches
// .003². Not a speech classifier: background noise can pass it. Returns, per
// chunk fed, one boolean for each frame the chunk completed.
function energyGate({ frameSamples = 1600, floor = .003 } = {}) {
  let sum = 0, squares = 0, count = 0;
  return function feed(pcm) {
    const frames = [];
    if (!Buffer.isBuffer(pcm)) return frames;
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
      const value = pcm.readInt16LE(offset) / 32768;
      sum += value; squares += value * value; count++;
      if (count === frameSamples) {
        const variance = squares / frameSamples - (sum / frameSamples) ** 2;
        frames.push(variance >= floor ** 2);
        sum = squares = count = 0;
      }
    }
    return frames;
  };
}

module.exports = { createWindow, energyGate, WINDOW_LIMITS };
