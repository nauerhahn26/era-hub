// The button-press listening window (design 2026-10-27 §4.4; plan T3.1, T3.3).
//
// A press opens a window. Inside it speech is cut into utterances; each one
// that sounds complete is SEALED: its words join the window's text and the
// caller runs a choice request on the whole window text ("do you want chicken
// or fish, or pasta"), so later words can change earlier choices. Listening
// continues after a seal. The window closes on the first of:
//
//   her pick of a tile                 'pick'          no seal (a pick wins)
//   a second press                     'press'         the utterance in flight seals first ('press')
//   10 s with no new words             'silence'       (unsealed words seal first)
//   60 s since the press               'cap'           the utterance in flight seals first ('cap')
//   a cancel (the button held 1 s)     'cancel'        nothing seals
//   no words at all within 10 s        'nothing-said'  zero seals: nothing is submitted
//   stop(reason) from outside          reason          nothing seals (a lost stream)
//
// An utterance "sounds complete" when the streaming service says its turn
// ended (turnEnd), or, when no such signal comes, after 15 quiet 100 ms frames
// (1.5 s) following at least 2 energetic ones (the energy gate below, the
// speech worker's own floor), or, when speech stays under that floor while
// words arrive, after 1.5 s with no new words. Whichever comes first seals; the same words
// never seal twice. One utterance is capped at 15 s from its first energetic frame or its
// first words, whichever comes first: at the cap it seals and listening goes on.
//
// "Words" are the service's running text for the whole window (partials are
// cumulative inside one window turn). The window's 10 s silence counts words,
// not energy: a noisy room never holds the microphone open, and a press with
// no words submits nothing.
//
// The utterance in flight at a second press or the cap: words or speech since
// the last seal (`pending`). With no `drain` hook it seals at once from the
// words heard so far. With one (the hub), the machine goes 'ending' and calls
// drain(reason): the caller finalizes the transcriber and calls end(finalText)
// when the final arrives, or end() at its own deadline (the latest partial
// seals, or nothing when no words came). While ending, partials still update
// the words; frames, ticks and presses wait; cancel, pick and stop close with
// no seal. With nothing in flight the window closes at once, unsealed.
//
// Pure: the clock is injected, the caller feeds frames and ticks; no sockets,
// no page, no timers. The speech activity model is never loaded here.
'use strict';

const WINDOW_LIMITS = Object.freeze({ quietFrames: 15, speechFrames: 2, utteranceMs: 15000, silenceMs: 10000, capMs: 60000 });
const FRAME_MS = 100;
const normalized = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const clean = text => typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';

function createWindow({ clock = Date.now, limits = {}, seal = () => {}, close = () => {}, drain = null } = {}) {
  const L = { ...WINDOW_LIMITS, ...limits };
  const openedAt = clock();
  let state = 'open', seq = 0, ending = null;
  let heard = '', sealed = '', lastWordsAt = openedAt;
  let utterance = { startedAt: null, energetic: 0, quiet: 0 };
  const resetUtterance = () => { utterance = { startedAt: null, energetic: 0, quiet: 0 }; };
  const unsealed = () => !!normalized(heard) && normalized(heard) !== normalized(sealed);

  function trySeal(reason) {
    if (!(state === 'open' || (state === 'ending' && reason === ending)) || !unsealed()) return false;
    const windowText = heard;
    const text = windowText.toLowerCase().startsWith(sealed.toLowerCase()) && sealed ? windowText.slice(sealed.length).trim() || windowText : windowText;
    sealed = windowText; seq++; lastWordsAt = clock(); resetUtterance();
    try { seal({ seq, text, windowText, reason }); } catch { /* the caller's work never breaks the window */ }
    return true;
  }
  function finish(reason) {
    if (state !== 'open' && state !== 'ending') return;
    state = 'closed';
    try { close(reason, { seals: seq, windowText: sealed }); } catch { /* as above */ }
  }
  // The deadlines: one utterance's cap, the window's silence and its cap.
  function tick() {
    if (state !== 'open') return;
    const now = clock();
    if (now - openedAt >= L.capMs) { endUtterance('cap'); return; }
    if (utterance.startedAt !== null && now - utterance.startedAt >= L.utteranceMs) { trySeal('cap'); resetUtterance(); }
    // Speech under the energy floor while words still arrive: no quiet frames
    // follow energetic ones, so 1.5 s with no new words is the quiet instead.
    else if (utterance.energetic < L.speechFrames && unsealed() && now - lastWordsAt >= L.quietFrames * FRAME_MS) trySeal('silence');
    if (now - lastWordsAt >= L.silenceMs) {
      const any = trySeal('close') || seq > 0;
      finish(any ? 'silence' : 'nothing-said');
    }
  }
  function heardWords(text) {
    if (!text || text === heard) return false;
    heard = text; lastWordsAt = clock();
    // The utterance clock starts on its first words as well as its first energetic frame.
    if (state === 'open' && utterance.startedAt === null && unsealed()) utterance.startedAt = lastWordsAt;
    return true;
  }
  // Speech since the last seal: unsealed words, or speech frames whose words
  // may still be on their way from the service.
  const pending = () => unsealed() || utterance.energetic >= L.speechFrames;
  // A second press or the cap: the utterance in flight seals, then the window closes.
  function endUtterance(reason) {
    if (state !== 'open') return;
    if (typeof drain === 'function' && pending()) {
      state = 'ending'; ending = reason;
      try { drain(reason); } catch { end(); }
      return;
    }
    trySeal(reason); finish(reason);
  }
  // The final for the utterance in flight (the whole window text), or nothing.
  function end(text) {
    if (state !== 'ending') return;
    const words = clean(text);
    if (words) heard = words;
    trySeal(ending); finish(ending);
  }
  const quietEnough = () => utterance.energetic >= L.speechFrames && utterance.quiet >= L.quietFrames;

  return {
    get state() { return state; },
    get seals() { return seq; },
    get text() { return sealed; },
    get pending() { return state === 'open' && pending(); },
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
      if (state === 'ending') { const words = clean(text); if (words) heard = words; return; }
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
    press() { endUtterance('press'); },
    end,
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

// The wake word (stable frame design 2026-10-28 §8): does this utterance hold
// the wake name, and what is the question? The name's words match whole words
// in any case, a possessive ("Ellie's") counts, and "elly" is heard as "ellie".
// The question is the words after the name; with nothing after it, the words
// before it once a greeting ("hey", "okay") is set aside. { question: '' }
// is a bare name (the next utterance is the question); null is no wake at all.
const WAKE_ALIASES = Object.freeze({ ellie: ['elly'] });
const GREETING = /^(?:hey|hi|hello|okay|ok|oh|so|um|uh|and|now)$/;
const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
function wakeQuestion(text, name) {
  if (typeof text !== 'string' || typeof name !== 'string') return null;
  const words = name.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const tokens = [...text.matchAll(TOKEN)].map(match => ({ start: match.index, end: match.index + match[0].length,
    word: match[0].toLowerCase().replace(/’/g, "'").replace(/'s$/, '') }));
  const fits = (token, word) => token.word === word || (WAKE_ALIASES[word] || []).includes(token.word);
  for (let i = 0; i + words.length <= tokens.length; i++) {
    if (!words.every((word, k) => fits(tokens[i + k], word))) continue;
    const end = tokens[i + words.length - 1].end;
    const after = text.slice(end).replace(/^[\s,.;:!?—–-]+/u, '').trim();
    if (/\p{L}/u.test(after)) return { question: after };
    const before = tokens.slice(0, i);
    let first = 0;
    while (first < before.length && GREETING.test(before[first].word)) first++;
    if (first === before.length) return { question: '' };
    const asked = text.slice(before[first].start, tokens[i].start).replace(/[\s,.;:—–-]+$/u, '').trim();
    return { question: asked + (/\?/.test(text.slice(end)) && !/[.!?]$/.test(asked) ? '?' : '') };
  }
  return null;
}

module.exports = { createWindow, energyGate, wakeQuestion, WINDOW_LIMITS };
