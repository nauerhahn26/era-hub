// The prompt is an input to every cached call, so its version and the two rules the
// v3 bump exists for are worth a test. String-contains only: no page text here.
//
// Two things this file has to do that a `prompt.includes(phrase)` cannot:
//   1. SCOPE. The rules overlap in vocabulary - "sticker" appears in rule 5 (price
//      stickers) and in rule 6 (stickers on this copy) - so a whole-prompt contains
//      passes even when the rule under test lost the phrase entirely. Every phrase is
//      therefore asserted against the numbered rule it is supposed to be in.
//   2. PIN. The v3 changelog claims everything except rules 5 and 6 is byte-identical
//      to v2. Nothing in the repo could check that - tools/ocr-bakeoff is untracked and
//      the cache records store only `promptVersion`, never the prompt text - so a later
//      edit to the output contract or to an unrelated rule would ship silently under a
//      version number that says it did not change. The exact strings live here.

import test from 'node:test';
import assert from 'node:assert/strict';
import prompts, { PROMPT_VERSION, transcribePrompt, transcribePromptV2, reviewPrompt } from '../lib/prompts.mjs';

// --- byte pins (v2, carried unchanged through v3) ----------------------------------
const PINNED_RULES = {
  1: '1. VERBATIM PRINTED TEXT ONLY. Transcribe the words exactly as printed. Never modernise, localise or correct spelling (British spelling stays British). Never add, expand or paraphrase words that are not printed. Do not translate.',
  2: '2. READING ORDER follows the visual and narrative flow of the page, not raw top-to-bottom geometry. For rhyming verse use rhyme and metre as an ordering signal across columns, panels and speech bubbles, so the text reads coherently start to finish.',
  3: '3. ELLIPSES: render any printed ellipsis, including a spaced ". . .", as three dots "...". Keep leading or trailing ellipses that are used as page-turn continuations.',
  4: '4. QUOTES: transcribe quotation marks exactly as printed, even when they are unbalanced on this page (a speech may continue across pages).',
  7: '7. If the page has no printed story text at all (a full-bleed illustration, an endpaper), return an empty string for "text".',
  8: '8. LINE AND STANZA BREAKS: use a single newline between printed lines of verse and a blank line between stanzas or separate text blocks. Do not re-wrap prose.',
  9: '9. FLAG, DO NOT GUESS: list in "uncertain" every word you are not fully confident about (obscured, blurred, cut off, or ambiguous). Still put your best reading in "text"; the list is for human review.',
};

// --- byte pins (v2, the wording the hub's transcriber is pinned to) -------------
// v2 is not history: era-hub's content-providers.js pins its transcribe pass to this
// exact string, because that is how the bake-off measured the winning pair (the
// transcriber under v2, its partner under v3). Recovered from a 06:33 worktree
// snapshot of this repo - inside the window the cache's v2 records span - and it
// differs from v3 in PROMPT_VERSION and rules 5 and 6 and nothing else, exactly as
// the v3 changelog says. These two lines are the pin that keeps it that way.
const PINNED_V2_RULES = {
  5: '5. JUNK REMOVAL: drop text that belongs to the illustration rather than the story - lettering painted on objects such as boat hulls or signs, barcodes, printed page numbers, publisher furniture, and misread glyphs (for example a stray "99" that is really a quotation mark).',
  6: '6. COVERS: if this page is a cover, transcribe the printed title, author and illustrator with the casing exactly as printed. Do not invent a byline that is not printed. ORDER ON A COVER IS FIXED, because a cover has no narrative flow: transcribe the printed blocks strictly TOP TO BOTTOM in the order they appear on the page. On many picture books the author and illustrator names are printed ABOVE the title - when they are, they come first. Do not promote the title to the front, and do not group the names with a byline at the end.',
};

const PINNED_OUTPUT_CONTRACT = [
  'Reply with a single JSON object and nothing else - no prose, no markdown code fence:',
  '{"text": "<the full page transcription>", "uncertain": ["<word>", ...]}',
  'Use "uncertain": [] when you are confident about every word.',
].join('\n');

/**
 * The numbered rules of a prompt's policy block, as {1..9}. The rules are one per line
 * with no blank line between them, so the policy ends at the first blank line after
 * rule 1 - which is what separates it from the output contract in the transcribe prompt
 * and from the draft under review in the review prompt.
 */
function rules(prompt) {
  const start = prompt.indexOf('1. VERBATIM');
  assert.notEqual(start, -1, 'the policy must start at rule 1');
  const rest = prompt.slice(start);
  const stop = rest.indexOf('\n\n');
  assert.notEqual(stop, -1, 'the policy must be followed by something');
  const body = rest.slice(0, stop).trimEnd();
  const parts = body.split(/\n(?=\d\. )/);
  const out = {};
  parts.forEach((p) => {
    out[Number(p.slice(0, p.indexOf('.')))] = p;
  });
  assert.deepEqual(Object.keys(out).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9], 'nine numbered rules, in order');
  return out;
}

test('PROMPT_VERSION is v3', () => {
  assert.equal(PROMPT_VERSION, 'v3');
});

test('rule 5 keeps story lettering and still drops publisher furniture', () => {
  const r = rules(transcribePrompt())[5];
  assert.match(r, /^5\. JUNK REMOVAL/);
  for (const phrase of ['PART OF THE STORY', 'blackboard', 'banner', 'hand-lettered']) {
    assert.ok(r.includes(phrase), `rule 5 must mention "${phrase}"`);
  }
  for (const phrase of ['running head', 'ISBN', 'barcode', 'imprint', 'price sticker']) {
    assert.ok(r.includes(phrase), `rule 5 must still drop "${phrase}"`);
  }
});

test('rule 5 does not name a sign on both sides of itself', () => {
  // "decorative" cannot be left to disambiguate a word the same rule uses as its
  // explicit counter-example: a sign a character holds up is story text, full stop.
  const r = rules(transcribePrompt())[5];
  const drop = r.slice(0, r.indexOf('BUT lettering'));
  const keep = r.slice(r.indexOf('BUT lettering'));
  assert.ok(!drop.includes('sign'), 'the drop clause must not name signs');
  assert.ok(keep.includes('a sign'), 'the keep clause must name a sign');
});

test('rule 6 ignores inscriptions and keeps printed cover order', () => {
  const r = rules(transcribePrompt())[6];
  assert.match(r, /^6\. COVERS/);
  for (const phrase of ['inscription', 'gift dedication', 'library stamp', 'sticker']) {
    assert.ok(r.includes(phrase), `rule 6 must mention "${phrase}"`);
  }
  assert.ok(r.includes('TOP TO BOTTOM'), 'the v2 cover-order convention must survive the v3 bump');
});

test('the output contract is byte-identical in both prompts', () => {
  const t = transcribePrompt();
  const r = reviewPrompt('an invented draft');
  assert.ok(t.endsWith(PINNED_OUTPUT_CONTRACT), 'the transcribe prompt must end with the pinned contract');
  assert.ok(r.endsWith(PINNED_OUTPUT_CONTRACT), 'the review prompt must end with the pinned contract');
  // exactly once each: a second, drifted copy is as bad as an edited one
  assert.equal(t.split(PINNED_OUTPUT_CONTRACT).length - 1, 1);
  assert.equal(r.split(PINNED_OUTPUT_CONTRACT).length - 1, 1);
});

test('the rules v3 calls byte-identical to v2 really are', () => {
  const r = rules(transcribePrompt());
  for (const [n, text] of Object.entries(PINNED_RULES)) {
    assert.equal(r[n], text, `rule ${n} changed - bump PROMPT_VERSION and update the pin`);
  }
});

test('the review prompt embeds the same policy, rule for rule', () => {
  const t = rules(transcribePrompt());
  const r = rules(reviewPrompt('an invented draft'));
  assert.deepEqual(r, t, 'a rule change must reach the review pass too');
  assert.ok(reviewPrompt('an invented draft').includes('an invented draft'), 'the draft is interpolated');
});

test('the v2 wording differs from v3 in rules 5 and 6 and nowhere else', () => {
  const three = rules(transcribePrompt());
  const two = rules(transcribePromptV2());
  for (const n of [1, 2, 3, 4, 7, 8, 9]) {
    assert.equal(two[n], three[n], `rule ${n} is carried unchanged from v2 into v3`);
  }
  for (const n of [5, 6]) {
    assert.equal(two[n], PINNED_V2_RULES[n], `v2 rule ${n} is not the string that was measured`);
    assert.notEqual(two[n], three[n], `rule ${n} is the whole reason v3 exists`);
  }
  // the trade, in one line each: v2 drops signs as art, v3 keeps them as story;
  // v2 says nothing about what a gift inscription on our own copy is.
  assert.ok(!two[5].includes('PART OF THE STORY'), 'v2 rule 5 has no keep clause');
  assert.ok(!two[6].includes('inscription'), 'v2 rule 6 says nothing about inscriptions');
});

test('the v2 wording is, byte for byte, v3 with those two rules put back', () => {
  // The strongest form of "copied, not paraphrased": rebuild v2 out of the v3 string
  // by swapping exactly the two pinned rules, and require the result to BE it. A
  // stray space, a curly quote or a tidied hyphen anywhere else fails here.
  const three = rules(transcribePrompt());
  const rebuilt = transcribePrompt()
    .replace(three[5], PINNED_V2_RULES[5])
    .replace(three[6], PINNED_V2_RULES[6]);
  assert.equal(transcribePromptV2(), rebuilt, 'v2 is not v3-with-rules-5-and-6-restored');
  assert.ok(transcribePromptV2().endsWith(PINNED_OUTPUT_CONTRACT), 'v2 ends with the same contract');
  assert.equal(transcribePromptV2().split(PINNED_OUTPUT_CONTRACT).length - 1, 1);
});

test('PROMPT_VERSION does not move because v2 is exported', () => {
  // The per-call cache keys on PROMPT_VERSION, so re-exporting an older wording must
  // not restamp what the harness itself sends: transcribePrompt() is still v3's.
  assert.equal(PROMPT_VERSION, 'v3');
  assert.notEqual(transcribePrompt(), transcribePromptV2());
  assert.equal(prompts.transcribePromptV2, transcribePromptV2, 'the default export carries it too');
});
