// content-imprint.js — the lines on a page that are the PUBLISHER talking, not
// the book. One pure function over a string; no network, no disk, no clock.
//
// WHY THIS EXISTS (E5, 9/4). The OCR bake-off measured every prompt wording it
// could think of at the problem and never solved it: the models narrate
// publisher furniture off a cover or a title page whatever they are told —
// copyright lines, the ISBN, "All rights reserved", "Printed in …", "First
// published …", the publisher's address and web site, "A CIP catalogue record
// …". The prompt already asks for them to be dropped (content-providers.js's
// JUNK REMOVAL clause, ported verbatim from tools/ocr-bakeoff/lib/prompts.mjs)
// and they come back anyway. A prompt is a request; this file is the rule.
//
// It matters twice over:
//
//   * A READER WOULD READ THEM ALOUD. A five-year-old opening the first page of
//     their own book and hearing "eye-ess-bee-enn nine seven eight dash one" is
//     the whole product failing at the first sentence.
//   * TWO MODELS NEVER AGREE ABOUT FURNITURE. An ISBN is thirteen digits of
//     nothing but opportunities to differ, and a page's copyright block is the
//     smallest, greyest print on it. Before this, a title page could be flagged
//     for a grown-up to check over an imprint line neither reading was ever
//     going to keep. So both readings are stripped BEFORE the agreement
//     comparison, and the only words the two models are judged on are the words
//     the book is made of.
//
// THE RULE THAT SHAPES EVERY PATTERN BELOW: losing a story line is worse than
// keeping a copyright line. A dropped sentence is a page that goes silent in
// the middle of the book, with nothing to tell anybody it happened; a kept
// imprint line is a grown-up rolling their eyes on the review page. So every
// test here is CONSERVATIVE and LINE-SHAPED — a line is furniture because of
// how the WHOLE line reads, never because a story sentence happened to contain
// the word "published" or a year. "The bus published a great grey cloud of
// steam" stays. "In 2019 the bramble bush grew over the gate" stays. "Their
// footprints were printed in the mud" stays.
//
// Nothing in here is ever written to text.json: text.json is the interop point,
// hand-editable, and its schema is fixed. The COUNT goes in .build/log.jsonl
// ("imprint lines removed: N") so a parent looking at a short page can see
// where the rest of it went.
"use strict";

// ------------------------------------------------------------- the patterns

// A copyright mark or the word itself, anywhere on the line, PLUS a year: the
// year is what makes it a notice rather than a sentence. 1600 is early enough
// for a reprint of anything a family owns and late enough that a page number,
// a price or a house number cannot pass for one.
const YEAR = /\b(?:1[6-9]|20)\d{2}\b/;
const COPYRIGHT_MARK = /(?:©|\(c\)|\bcopyright\b)/i;

// The same notice with no year on it ("Text copyright © Ada Bramblewick"). Only
// at the START of a line, because that is where a notice lives and it is the
// one place a story sentence never begins.
const COPYRIGHT_HEAD =
  /^(?:(?:text|illustrations?|photographs?|photography|artwork|cover|design|translation)\s+)?(?:copyright\b|©|\(c\))/i;

// The rest of the furniture. Each one is either unmistakable wherever it sits
// on the line (an ISBN, a URL, "all rights reserved") or anchored to the start
// of the line so that a sentence containing the same words survives.
const PATTERNS = [
  /\bISBN\b/i,                                    // never a word in a story
  /\ball rights reserved\b/i,
  /^printed\s+(?:and\s+bound\s+)?(?:in|by)\b/i,   // NOT "footprints were printed in the mud"
  /^(?:this\s+(?:\w+\s+)?edition\s+)?(?:first\s+)?(?:published|reprinted|reissued)\b/i,
  /^published\s+(?:by|in)\b/i,
  /\bCIP\b/,                                      // capitals only: the abbreviation, not a word
  /\bcatalogu?e\s+record\b/i,
  /\bwww\./i,
  /https?:\/\//i,
];

// A company and an address on one line — "Puddleduck Press Ltd, 12 Marigold
// Lane, Fakebury". The company token is matched CASE-SENSITIVELY on purpose:
// "limited" is an ordinary English word ("a limited number of buses") and
// "Limited" at the end of a name is not. The comma is what makes the rest of
// the line an address rather than a sentence about a company.
const COMPANY = /\b(?:Ltd|Limited|Inc|LLC|PLC|GmbH)\b/;

// A line of two words or fewer that is ONLY a year, or only a code. This is the
// "2019" under a title and the "FSC C000000" in the gutter.
//
// THREE guards keep a story line out, and the third one is the one that matters:
// there has to be a digit in the line (so "The end." is safe), the line has to
// be all capitals, digits and punctuation (so "Chapter 3" and "3 buses" are),
// and — because A PICTURE BOOK IS PRINTED IN CAPITALS — every token in it has to
// look like part of a code rather than like a word. Without that last test the
// rule ate the whole of a counting book: "3 BEARS", "1 DUCK", "CHAPTER 3",
// "DAY 1" are all two words, all capitals, all with a digit in them, and every
// one of them is the page's only sentence. Losing one is silent twice over —
// both readings are stripped before they are compared, so the page agrees with
// itself and is never flagged.
//
// A token is part of a code when it is DIGITS and punctuation ("2019",
// "978-1-00000-000-0", "#4") or when letters and digits are mixed INSIDE the one
// token ("C000000", "MIX-1"). A bare capitalised word ("BEARS", "CHAPTER") is
// neither, so a line only reads as a code when the line is all numbers, or when
// something in it is unmistakably a code and nothing in it is a number standing
// on its own next to a word.
const ONLY_YEAR = /^\(?(?:1[6-9]|20)\d{2}\)?[.,;:]?$/;
const ONLY_CODE = /^[A-Z0-9][A-Z0-9\s.\-–—/#:]*$/;
const NUMBER_TOKEN = (w) => /\d/.test(w) && !/[A-Za-z]/.test(w);
const CODE_TOKEN = (w) => /\d/.test(w) && /[A-Za-z]/.test(w);
const LABEL_TOKEN = (w) => /^[A-Z.\-–—/#:]+$/.test(w);      // "FSC", "ISBN": the capitals that LABEL a code

function tokens(s) { return s.split(/\s+/).filter(Boolean); }
function wordCount(s) { return tokens(s).length; }

function looksLikeCode(s) {
  const ws = tokens(s);
  if (!ws.length) return false;
  if (ws.every(NUMBER_TOKEN)) return true;                  // "2019", an ISBN on its own line
  // Something in the line IS a code, and everything else is a code, a number or
  // the capitals that label one ("FSC C000000"). "3 BEARS" has no code token in
  // it at all, so it never reaches this test as anything but a story line.
  return ws.some(CODE_TOKEN) &&
         ws.every(w => CODE_TOKEN(w) || NUMBER_TOKEN(w) || LABEL_TOKEN(w));
}

// isImprintLine(line) — is this ONE line the publisher talking?
//
// The line is judged trimmed: leading space is the scan's or the OCR's, and a
// copyright line indented under a title is the same copyright line.
function isImprintLine(line) {
  const s = String(line == null ? "" : line).trim();
  if (!s) return false;                            // a blank line is not furniture
  if (COPYRIGHT_MARK.test(s) && YEAR.test(s)) return true;
  if (COPYRIGHT_HEAD.test(s)) return true;
  for (const re of PATTERNS) if (re.test(s)) return true;
  if (COMPANY.test(s) && s.includes(",")) return true;
  if (wordCount(s) < 3 && /\d/.test(s) &&
      (ONLY_YEAR.test(s) || (ONLY_CODE.test(s) && looksLikeCode(s)))) return true;
  return false;
}

// ------------------------------------------------------------------ the page

// strip(text) -> {text, removed}
//
// `removed` counts LINES, not characters, and never counts a blank one — it is
// the number that goes in the log, and "imprint lines removed: 4" has to mean
// four lines a person could have pointed at.
//
// What is left is joined back in its own order and tidied in exactly one way:
// the gap a removed line leaves between two blank lines is closed, so taking a
// copyright block out of the middle of a page does not leave a paragraph break
// where there was not one. Leading and trailing whitespace goes, which is what
// turns a page that was NOTHING but furniture into the empty string — and an
// empty page is a page the narrate step is required to skip rather than buy
// (content-narrate.js: "a page with no words is a picture page").
function strip(text) {
  if (text == null) return { text: "", removed: 0 };
  const lines = String(text).split(/\r?\n/);
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    if (isImprintLine(line)) { removed++; continue; }
    kept.push(line);
  }
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, removed };
}

module.exports = { isImprintLine, strip, YEAR, COMPANY };
