// words.js — character timings in, word timings out.
//
// ElevenLabs' /with-timestamps endpoint returns one start and one end per
// CHARACTER of the narrated page. The reader's highlighter wants one per WORD
// (`pages[].words = [{word, start, end}]`, spec §2 manifest contract), so
// something has to group them. That something is this file, and it is a
// FAITHFUL PORT of the Python that narrated the family's existing books
// (ellie-this-week, src/ellie/book/audio.py `words_from_chars`) — a book built
// by the hub has to highlight exactly like a book built by the old script, or
// the same story reads differently depending on which pair of hands made it.
//
// Ported rules, deliberately not "improved":
//   * a word is a maximal run of non-whitespace entries;
//   * start = the first entry's start, end = the last entry's end;
//   * punctuation stays glued to its word ('"Stop!"' is one word);
//   * NO smoothing, NO clamping, NO rounding, NO epsilon — the numbers are
//     passed through exactly as the provider gave them;
//   * the three arrays truncate to the shortest (Python's `zip`);
//   * whitespace flushes only a non-empty accumulator, and a word still open
//     when the arrays run out is flushed after the loop.
//
// Pure and dependency-free on purpose: it is the one piece of the narration
// path that can be tested without a network, and the golden cases in
// tests/words.test.mjs are the Python project's own tests, value for value.
"use strict";

// Python's str.isspace(): true only for a NON-EMPTY string that is all
// whitespace. An entry ElevenLabs sends as "" is therefore NOT whitespace and
// does not flush the word being built — same as the source.
function isSpace(ch) { return /^\s+$/.test(ch); }

// A timing has to be a real number to be usable: the reader compares
// audio.currentTime against these, and a single NaN highlights nothing for the
// rest of the page. A torn or padded alignment drops the character rather than
// poisoning the word around it. (The Python never saw one; a mirrored file can.)
function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }

// chars: string[] (each entry OPAQUE — a multi-codepoint grapheme is one
// entry with one timing, and is concatenated whole, never split)
// starts/ends: number[] in seconds
function wordsFromChars(chars, starts, ends) {
  const out = [];
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends)) return out;
  const n = Math.min(chars.length, starts.length, ends.length);   // zip
  let cur = "";
  let wStart = 0, wEnd = 0;
  for (let i = 0; i < n; i++) {
    const ch = String(chars[i] == null ? "" : chars[i]);
    if (isSpace(ch)) {
      if (cur) { out.push({ word: cur, start: wStart, end: wEnd }); cur = ""; }
      continue;
    }
    const s = num(starts[i]), e = num(ends[i]);
    if (s === null || e === null) continue;
    if (!cur) wStart = s;
    cur += ch;
    wEnd = e;
  }
  if (cur) out.push({ word: cur, start: wStart, end: wEnd });
  return out;
}

// The whole `with-timestamps` reply, or just its alignment object. ElevenLabs
// sends `alignment` (the text as spoken) and `normalized_alignment` (the text
// after its own normalisation, e.g. "3" -> "three"); the first is what the page
// actually says, so it wins and the second is only a fallback.
// Returns null — not [] — when neither is present, so a caller can tell
// "the provider sent no timings" from "the page was silent".
function wordsFromAlignment(reply) {
  if (!reply || typeof reply !== "object") return null;
  const al = (reply.alignment && typeof reply.alignment === "object" ? reply.alignment : null) ||
             (reply.normalized_alignment && typeof reply.normalized_alignment === "object" ? reply.normalized_alignment : null) ||
             (Array.isArray(reply.characters) ? reply : null);
  if (!al || !Array.isArray(al.characters)) return null;
  return wordsFromChars(al.characters, al.character_start_times_seconds, al.character_end_times_seconds);
}

module.exports = { wordsFromChars, wordsFromAlignment };
