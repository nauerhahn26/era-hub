// Her clip is handled, never silenced (stable frame spec 2026-10-28 §13; plan
// H1). The hub keeps the clips of the last few seconds (her words, the
// reading's whole text) and removes their words from any transcript turn that
// arrives while a clip plays or within 3 s after it ends: every run of two or
// more of the clip's words, in the clip's order. A one-word turn goes only
// when it is a word of a clip in play ("Yes." heard back as "yes"). The
// partner's own words around the echo survive. Pure: no clock, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stripEcho, createClipBook, ECHO_LIMITS } = require('../chat-echo.js');

const clip = (text, startedAt = 1000, endedAt = 3000, source = 'page') => ({ text, startedAt, endedAt, source });
const READING = 'Ellie, your options are Yes. No. Tell me more. Something else.';

test('the limits: in play from 500 ms before the start to 3 s after the end; kept 8 s', () => {
  assert.deepEqual({ ...ECHO_LIMITS }, { leadMs: 500, tailMs: 3000, keepMs: 8000, openMs: 30000 });
});

test('an exact echo of her clip is dropped', () => {
  assert.deepEqual(stripEcho("Yes, I'm tired.", [clip("Yes, I'm tired.")], 2000), { text: '', matched: ["Yes, I'm tired"] });
  assert.deepEqual(stripEcho('yes im tired', [clip("Yes, I'm tired.")], 2000).text, 'yes im tired', 'other words are other words');
});

test('a partial echo of the reading is dropped', () => {
  const clips = [clip(READING, 1000, 6000)];
  assert.equal(stripEcho('your options are yes no', clips, 4000).text, '');
  assert.equal(stripEcho('Your options are, yes.', clips, 4000).text, '');
  assert.equal(stripEcho("your options are yes I'm tired", [clip(READING, 1000, null), clip("Yes, I'm tired.", 2500, null)], 4000).text, '');
});

test('the partner\'s words before or after the echo survive, punctuation and casing kept', () => {
  const clips = [clip("Yes, I'm tired.")];
  assert.deepEqual(stripEcho("Ellie are you hungry yes I'm tired", clips, 2500), { text: 'Ellie are you hungry', matched: ["yes I'm tired"] });
  assert.equal(stripEcho("Ellie, are you hungry? Yes, I'm tired.", clips, 2500).text, 'Ellie, are you hungry?');
  assert.equal(stripEcho("Yes, I'm tired. Ellie, do you want a nap?", clips, 2500).text, 'Ellie, do you want a nap?');
  assert.equal(stripEcho("so YES I'M TIRED, then what", clips, 2500).text, 'so then what');
});

test('the reading\'s text holds her name: the name never leaks as a wake', () => {
  const clips = [clip(READING, 1000, 6000)];
  assert.equal(stripEcho('Ellie, your options are', clips, 3000).text, '');
  assert.equal(stripEcho('Ellie.', clips, 3000).text, '', 'the name split off as a turn of its own');
  assert.equal(stripEcho('Ellie your options are tell me more', clips, 3000).text, '');
});

test('in play: 500 ms before the start, while playing, 3 s after the end; never after', () => {
  const clips = [clip("Yes, I'm tired.", 10000, 12000)];
  assert.equal(stripEcho("yes I'm tired", clips, 9400).text, "yes I'm tired");
  assert.equal(stripEcho("yes I'm tired", clips, 9600).text, '');
  assert.equal(stripEcho("yes I'm tired", clips, 15000).text, '');
  assert.equal(stripEcho("yes I'm tired", clips, 17000).text, "yes I'm tired", '5 s after the end: untouched');
  assert.equal(stripEcho("yes I'm tired", [clip("Yes, I'm tired.", 10000, null)], 40000).text, '', 'still playing');
});

test('one-word clips: Yes. and No. remove only a turn that is just that word', () => {
  assert.deepEqual(stripEcho("No, I don't", [clip('No.')], 2000), { text: "No, I don't", matched: [] });
  assert.deepEqual(stripEcho('No.', [clip('No.')], 2000), { text: '', matched: ['No'] });
  assert.equal(stripEcho('no', [clip('No.')], 2000).text, '');
  assert.equal(stripEcho('yes', [clip('No.')], 2000).text, 'yes');
});

test('a single word of a longer clip survives inside the partner\'s words; alone it is the echo', () => {
  const clips = [clip("No, I'm not tired.")];
  assert.equal(stripEcho('no do you want juice', clips, 2000).text, 'no do you want juice');
  assert.equal(stripEcho('are you tired', clips, 2000).text, 'are you tired');
  assert.equal(stripEcho('no', clips, 2000).text, '', 'a one-word turn of her words while it plays');
});

test('two clips in play at once: each removes its own runs, longest first', () => {
  const clips = [clip("I'm hungry.", 1000, 2000), clip('Something else.', 1500, 2500, 'other')];
  const result = stripEcho("I'm hungry what do you want something else", clips, 3000);
  assert.equal(result.text, 'what do you want');
  assert.deepEqual(result.matched.sort(), ["I'm hungry", 'something else']);
  // The longer run wins where two clips overlap the same words.
  assert.deepEqual(stripEcho('tell me more please', [clip('me more'), clip('Tell me more.')], 2000).matched, ['tell me more']);
});

test('nothing in play, nothing to strip: the turn is returned as it came', () => {
  assert.deepEqual(stripEcho('  Ellie,  are you hungry? ', [], 1000), { text: 'Ellie,  are you hungry?', matched: [] });
  assert.deepEqual(stripEcho('', [clip('Yes.')], 2000), { text: '', matched: [] });
  assert.deepEqual(stripEcho('are you hungry', [clip('')], 2000), { text: 'are you hungry', matched: [] });
});

test('the clip book: start, end the latest open clip of a source, in play, pruned after 8 s', () => {
  let now = 1000;
  const book = createClipBook({ now: () => now });
  book.end({ at: 900, source: 'page' });
  assert.deepEqual(book.inPlay(1000), [], 'an end with no open clip is a no-op');
  book.start({ text: 'Ellie, your options are', at: 1000 });
  book.start({ text: 'Yes.', at: 1200, source: 'page' });
  book.start({ text: 'Something else.', at: 1300, source: 'other' });
  book.end({ at: 1500, source: 'page' });
  assert.deepEqual(book.clips.map(c => [c.text, c.endedAt]), [['Ellie, your options are', null], ['Yes.', 1500], ['Something else.', null]]);
  book.end({ at: 1600, source: 'other' }); book.end({ at: 2000 });
  assert.equal(book.inPlay(4400).length, 3);
  assert.equal(book.inPlay(5100).length, 0, 'past the 3 s tail');
  now = 9599; book.prune();
  assert.equal(book.clips.length, 2, 'Yes. ended at 1500: gone 8 s after');
  now = 10001; book.prune();
  assert.equal(book.clips.length, 0);
});

test('the clip book: an end never heard ends a clip 30 s after its start; the book stays small', () => {
  let now = 0;
  const book = createClipBook({ now: () => now, keepMs: 1000 });
  book.start({ text: 'Tell me more.', at: 0 });
  assert.equal(book.inPlay(20000).length, 1);
  assert.equal(book.inPlay(34000).length, 0, 'open past 30 s: treated as ended then');
  now = 31001; book.prune();
  assert.equal(book.clips.length, 0);
  now = 40000;
  for (let i = 0; i < 100; i++) book.start({ text: 'Yes.', at: now });
  assert.ok(book.clips.length <= 32);
});
