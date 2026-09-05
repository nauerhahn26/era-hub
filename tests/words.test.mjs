// words.test.mjs — the word grouper the reader's highlighter is fed from.
// ElevenLabs hands back one timing per CHARACTER; the reader wants one per
// word. This is a faithful port of the Python that narrated the family's
// existing books (ellie-this-week src/ellie/book/audio.py words_from_chars),
// so the first two cases below are that project's golden tests, transcribed
// value for value — a book narrated by the hub must highlight exactly like a
// book narrated by the old script.
// In-process only: no server, no port, no network, no key. (Port table: this
// suite claims none — plan §B.)
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const words = require(path.join(HUB, "words.js"));

// ------------------------------------------------------ the Python golden cases

test("golden: groups chars into words (test_groups_chars_into_words)", () => {
  const text = "A busy bee.";
  const chars = [...text];
  const starts = chars.map((_, i) => i * 0.1);
  const ends = starts.map(s => s + 0.1);
  const out = words.wordsFromChars(chars, starts, ends);
  assert.deepEqual(out.map(w => w.word), ["A", "busy", "bee."]);
  assert.equal(out[0].start, 0.0);
  assert.equal(out[1].start, 0.2);                    // the 'b' of busy
  assert.equal(out[2].end, ends[ends.length - 1]);
});

test("golden: leading and multiple spaces (test_handles_leading_and_multiple_spaces)", () => {
  const chars = [" ", "h", "i", " ", " ", "y", "o"];
  const starts = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  const ends = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
  const out = words.wordsFromChars(chars, starts, ends);
  assert.deepEqual(out.map(w => w.word), ["hi", "yo"]);
  assert.equal(out[0].start, 0.1);
  assert.equal(out[1].start, 0.5);
});

// --------------------------------------------------------------- the port's edges

test("a trailing word with no closing whitespace is still flushed", () => {
  const chars = [..."hi yo"];
  const starts = chars.map((_, i) => i);
  const ends = starts.map(s => s + 1);
  const out = words.wordsFromChars(chars, starts, ends);
  assert.deepEqual(out.map(w => w.word), ["hi", "yo"]);
  assert.equal(out[1].start, 3);
  assert.equal(out[1].end, 5);
});

test("unequal arrays truncate to the shortest (Python zip)", () => {
  const out = words.wordsFromChars(["a", " ", "b", "c"], [0, 1, 2], [1, 2, 3, 4]);
  assert.deepEqual(out, [{ word: "a", start: 0, end: 1 }, { word: "b", start: 2, end: 3 }]);
});

test("punctuation stays glued to its word, and no rounding happens", () => {
  const chars = [...'"Stop!" said Mr. Fox,'];
  const starts = chars.map((_, i) => i / 3);
  const ends = starts.map(s => s + 1 / 3);
  const out = words.wordsFromChars(chars, starts, ends);
  assert.deepEqual(out.map(w => w.word), ['"Stop!"', "said", "Mr.", "Fox,"]);
  assert.equal(out[0].start, starts[0]);              // exact, not rounded
  assert.equal(out[0].end, ends[6]);
});

test("empty input is an empty list, and so is all-whitespace input", () => {
  assert.deepEqual(words.wordsFromChars([], [], []), []);
  assert.deepEqual(words.wordsFromChars([" ", "\n", "\t"], [0, 1, 2], [1, 2, 3]), []);
});

test("a multi-codepoint character entry is opaque — never split", () => {
  // ElevenLabs may hand back a whole grapheme (an emoji, a combining pair) as
  // ONE entry with ONE timing. The Python concatenates it whole; so do we.
  const out = words.wordsFromChars(["ni", "ño", " ", "🐝"], [0, 1, 2, 3], [1, 2, 3, 4]);
  assert.deepEqual(out.map(w => w.word), ["niño", "🐝"]);
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, 2);
});

test("non-finite or missing timings are skipped rather than poisoning a word", () => {
  // A torn alignment must not put NaN into the manifest — the reader compares
  // currentTime against these numbers and NaN highlights nothing forever.
  const out = words.wordsFromChars(["a", "b", " ", "c"], [0, null, 2, 3], [1, 2, 3, 4]);
  assert.deepEqual(out.map(w => w.word), ["a", "c"]);
});

// ------------------------------------------------------- the alignment envelope

const ALIGN = {
  characters: [...'"Hi!" said Bee.'],
  character_start_times_seconds: [...'"Hi!" said Bee.'].map((_, i) => i * 0.05),
  character_end_times_seconds: [...'"Hi!" said Bee.'].map((_, i) => i * 0.05 + 0.05),
};

test("wordsFromAlignment reads alignment, and falls back to normalized_alignment", () => {
  const a = words.wordsFromAlignment({ alignment: ALIGN, normalized_alignment: null });
  assert.deepEqual(a.map(w => w.word), ['"Hi!"', "said", "Bee."]);
  const b = words.wordsFromAlignment({ alignment: null, normalized_alignment: ALIGN });
  assert.deepEqual(b, a);
  assert.equal(words.wordsFromAlignment({}), null);   // no alignment at all
  assert.equal(words.wordsFromAlignment(null), null);
});

test("round trip: the alignment envelope lands in the manifest's page shape", () => {
  // The manifest contract (spec §2): page.words = [{word, start, end}] and
  // nothing else — an extra field would ship to the reader unread forever.
  const out = words.wordsFromAlignment({ alignment: ALIGN });
  for (const w of out) {
    assert.deepEqual(Object.keys(w), ["word", "start", "end"]);
    assert.equal(typeof w.word, "string");
    assert.ok(Number.isFinite(w.start) && Number.isFinite(w.end), JSON.stringify(w));
    assert.ok(w.end >= w.start);
  }
  assert.deepEqual(out[0], { word: '"Hi!"', start: 0, end: ALIGN.character_end_times_seconds[4] });
  assert.equal(out[out.length - 1].end, ALIGN.character_end_times_seconds[14]);
  // and it survives JSON, which is how it actually reaches the reader
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

// ------------------------------------------------- a recorded provider output

// tests/fixtures/recorded/sunny-pond-words.json is what the pipeline actually
// wrote for a synthetic four-page book on 2026-09-05 (T7.4): real ElevenLabs
// `with-timestamps` timings, no family text. The synthetic envelopes above are
// contiguous; a real read has silence BETWEEN words (0.104 → 0.151 s here) and
// a closing word that runs long on its punctuation. The reader's binary search
// ("the last word started by t") has to hold on that shape, so the manifest
// contract is pinned against it — every page, every word.
const RECORDED = JSON.parse(readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "recorded", "sunny-pond-words.json"), "utf8"));

test("recorded ElevenLabs timings keep the manifest contract on every page", () => {
  assert.equal(RECORDED.pages.length, 4);
  for (const page of RECORDED.pages) {
    assert.ok(page.words.length >= 5, `page ${page.index} has ${page.words.length} words`);
    let prevEnd = 0;
    for (const w of page.words) {
      assert.deepEqual(Object.keys(w), ["word", "start", "end"]);
      assert.ok(/\S/.test(w.word) && !/\s/.test(w.word), JSON.stringify(w));   // one token, no whitespace
      assert.ok(Number.isFinite(w.start) && Number.isFinite(w.end), JSON.stringify(w));
      assert.ok(w.end > w.start, JSON.stringify(w));
      assert.ok(w.start >= prevEnd, `page ${page.index}: "${w.word}" starts before the previous word ends`);
      prevEnd = w.end;
    }
  }
  // the gap the synthetic cases never show: silence between spoken words
  const p2 = RECORDED.pages[1].words;
  assert.ok(p2.some((w, i) => i > 0 && w.start > p2[i - 1].end), "no inter-word gap in the recorded page");
  assert.equal(p2.map(w => w.word).join(" "), "The duck swims in the pond.");
});
