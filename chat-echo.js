// Her clip is handled, never silenced (stable frame spec 2026-10-28 §13).
//
// The microphone hears her voice when it plays (her words, the reading of the
// options, another Chat page). The page tells the hub what each clip speaks;
// the hub keeps the clips of the last few seconds in a clip book and runs every
// transcript turn through stripEcho before acting on it.
//
// A clip is in play for a turn heard at `at` from 500 ms before its start
// (the page posts the start a moment late) until 3 s after its end (the
// transcript of the echo arrives late). Against each clip in play:
//   - every run of two or more of the clip's words that appears in the turn in
//     the clip's order is removed, the longest runs first;
//   - a turn of one word goes when that word is one of a clip's words ("Yes."
//     heard back as "yes", the name split off the reading as "Ellie.");
//   - a single word inside a longer turn is the partner's and stays.
// What is left keeps its own casing and punctuation; '' when nothing is.
//
// Pure: no clock of its own (the book takes `now`), no I/O.
'use strict';

const ECHO_LIMITS = Object.freeze({ leadMs: 500, tailMs: 3000, keepMs: 8000, openMs: 30000 });
const MAX_CLIPS = 32;
// The wake word's TOKEN (chat-window.js): letters and digits, with an apostrophe inside a word.
const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
const tokens = text => [...String(text || '').matchAll(TOKEN)].map(match => ({ start: match.index, end: match.index + match[0].length,
  word: match[0].toLowerCase().replace(/’/g, "'") }));

// The clip's end for the in-play rule: an end never posted counts as 30 s after the start.
const endOf = (clip, at) => clip.endedAt ?? (at - clip.startedAt > ECHO_LIMITS.openMs ? clip.startedAt + ECHO_LIMITS.openMs : null);
function inPlayAt(clip, at) {
  if (!clip || !Number.isFinite(clip.startedAt) || at < clip.startedAt - ECHO_LIMITS.leadMs) return false;
  const end = endOf(clip, at);
  return end === null || at <= end + ECHO_LIMITS.tailMs;
}

// The longest run of unremoved turn tokens that appears, consecutively and in
// order, in one clip's words: { from, length } in the turn, or null.
function longestRun(turn, removed, clipWords) {
  let best = null;
  for (let i = 0; i < turn.length; i++) {
    if (removed[i]) continue;
    for (let j = 0; j < clipWords.length; j++) {
      let n = 0;
      while (i + n < turn.length && j + n < clipWords.length && !removed[i + n] && turn[i + n].word === clipWords[j + n]) n++;
      if (n >= 2 && (!best || n > best.length)) best = { from: i, length: n };
    }
  }
  return best;
}

function stripEcho(turnText, clips, at) {
  const text = typeof turnText === 'string' ? turnText.trim() : '';
  const turn = tokens(text);
  const playing = (Array.isArray(clips) ? clips : []).filter(clip => inPlayAt(clip, at))
    .map(clip => tokens(clip.text).map(token => token.word)).filter(words => words.length);
  if (!turn.length || !playing.length) return { text, matched: [] };
  const removed = new Array(turn.length).fill(false), runs = [];
  if (turn.length === 1) {
    if (playing.some(words => words.includes(turn[0].word))) return { text: '', matched: [text.slice(turn[0].start, turn[0].end)] };
    return { text, matched: [] };
  }
  for (;;) {
    let best = null;
    for (const words of playing) { const run = longestRun(turn, removed, words); if (run && (!best || run.length > best.length)) best = run; }
    if (!best) break;
    for (let k = 0; k < best.length; k++) removed[best.from + k] = true;
    runs.push(best);
  }
  if (!runs.length) return { text, matched: [] };
  // Cut each removed token with the punctuation and space after it, up to the next token.
  let kept = '', cursor = 0;
  for (let i = 0; i < turn.length; i++) {
    if (!removed[i]) continue;
    kept += text.slice(cursor, turn[i].start);
    cursor = i + 1 < turn.length ? turn[i + 1].start : text.length;
  }
  kept += text.slice(cursor);
  kept = kept.replace(/\s+/g, ' ').replace(/^[\s,.;:!?—–-]+/u, '').replace(/\s+([,.;:!?])/g, '$1').trim();
  if (!tokens(kept).length) kept = '';
  runs.sort((a, b) => a.from - b.from);
  return { text: kept, matched: runs.map(run => text.slice(turn[run.from].start, turn[run.from + run.length - 1].end)) };
}

// The clips of the last few seconds, on the hub's clock.
function createClipBook({ keepMs = ECHO_LIMITS.keepMs, now = Date.now } = {}) {
  let clips = [];
  function prune() {
    const t = now();
    clips = clips.filter(clip => { const end = endOf(clip, t); return end === null || t - end <= keepMs; });
    if (clips.length > MAX_CLIPS) clips = clips.slice(-MAX_CLIPS);
  }
  return {
    start({ text, at = now(), source = 'page' } = {}) {
      clips.push({ text: typeof text === 'string' ? text : '', startedAt: at, endedAt: null, source });
      prune();
    },
    // Ends the latest open clip of that source; none open: nothing happens.
    end({ at = now(), source = 'page' } = {}) {
      for (let i = clips.length - 1; i >= 0; i--) if (clips[i].source === source && clips[i].endedAt === null) { clips[i].endedAt = at; break; }
      prune();
    },
    inPlay(at = now()) { prune(); return clips.filter(clip => inPlayAt(clip, at)); },
    prune,
    get clips() { return clips.map(clip => ({ ...clip })); },
  };
}

module.exports = { stripEcho, createClipBook, ECHO_LIMITS };
