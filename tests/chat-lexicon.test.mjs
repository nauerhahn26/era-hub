// Chat's lexicon layer (spec 2026-10-27 §6, "Lexicon"): the pictogram
// library's English keyword list trimmed to a word → id index that ships in
// the repo (words and numbers only; the artwork stays out), and the hub's
// picture pick that consults it after the curated vocabulary. Fixtures only:
// these tests never reach the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builder = await import('../tools/chat-lexicon-build.mjs');
const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/chat-lexicon-sample.json', import.meta.url), 'utf8'));
const pictures = require('../chat-symbols.js');
const vocabulary = JSON.parse(fs.readFileSync(path.join(HUB, 'public', 'chat', 'vocabulary.json'), 'utf8'));
const vocabId = word => vocabulary.concepts.find(concept => concept.word === word).id;
const shipped = JSON.parse(fs.readFileSync(path.join(HUB, 'public', 'chat', 'lexicon.json'), 'utf8'));

// ---- the index builder ------------------------------------------------------

test('the builder trims the keyword list to lowercased keyword and plural forms, the core AAC entry winning a shared word', () => {
  const lexicon = builder.buildLexicon(sample, { source: 'fixture', built: '2026-10-28' });
  assert.equal(lexicon.words.lasagna, 9051); assert.equal(lexicon.words.lasagne, 9051);
  assert.equal(lexicon.words.pizza, 2527); assert.equal(lexicon.words.sushi, 38993);
  // Three pictures share "chicken": a core AAC one beats the plain one; between
  // two equal core entries the one with a family wins (the dish over the bird).
  assert.equal(lexicon.words.chicken, 4952);
  assert.equal(lexicon.words['roast chicken'], 4952);
  assert.equal(lexicon.words.tiles, 6054, 'a plural form is a key of its own');
  assert.equal(lexicon.words['floor tile'], 6054);
  assert.equal(lexicon.words['spit roast chicken'], 4952, 'punctuation folds to spaces, as the hub folds a label');
  for (const key of Object.keys(lexicon.words)) assert.match(key, /^[a-z0-9]+(?: [a-z0-9]+)*$/, key);
  assert.equal(lexicon.source, 'fixture'); assert.equal(lexicon.built, '2026-10-28');
  assert.equal(lexicon.count, Object.keys(lexicon.words).length);
});

test('the builder drops entries with no keyword, flagged entries, pronouns, place names and verbs-only words', () => {
  const lexicon = builder.buildLexicon(sample, { source: 'fixture', built: '2026-10-28' });
  const ids = new Set(Object.values(lexicon.words));
  assert.ok(!ids.has(99999), 'no keyword, no entry');
  assert.ok(!ids.has(99998) && !ids.has(99997), 'sex- or violence-flagged pictures never enter');
  assert.equal(lexicon.words.flagged, undefined);
  assert.equal(lexicon.words.me, undefined, 'a pronoun is never a picture');
  assert.equal(lexicon.words.germany, undefined, 'no place names');
  assert.equal(lexicon.words.stop, undefined, 'verbs are not things: they live in the actions map');
  assert.equal(lexicon.words.i, undefined);
});

test('the builder keeps a second map of actions, qualities and social words (keyword types 3-6) under the same rules', () => {
  const lexicon = builder.buildLexicon(sample, { source: 'fixture', built: '2026-10-28' });
  const { actions } = lexicon;
  assert.equal(actions.stop, 7196, 'a verb');
  assert.equal(actions.wait, 16697, 'the core AAC entry wins a shared verb');
  assert.equal(actions.await, 8109);
  assert.equal(actions.later, 32749, 'a descriptive word');
  assert.equal(actions.hello, 6522, 'a social word'); assert.equal(actions.hi, 6522);
  assert.equal(actions['i do not know'], 7180); assert.equal(actions['i dont know'], 7180, 'folded as the hub folds a label');
  assert.equal(actions.weekend, 27329, 'a miscellaneous word');
  assert.equal(actions.wave, 8208, 'the gesture is an action; the sea wave stays a thing');
  assert.equal(lexicon.words.wave, 4706);
  assert.equal(actions.chicken, undefined, 'things never enter the actions map');
  assert.equal(lexicon.words.hello, undefined, 'actions never enter the things map');
  // Simple verb forms, never over a real keyword.
  assert.equal(actions.waits, 16697); assert.equal(actions.waiting, 16697);
  assert.equal(actions.tells, 9692); assert.equal(actions.telling, 9692);
  assert.equal(actions.makes, 11749); assert.equal(actions.making, 11749);
  assert.equal(actions.laters, undefined, 'only verbs are inflected');
  // The same drop rules: letters, pronouns, flagged pictures.
  assert.equal(actions.b, undefined); assert.equal(actions['bee letter'], undefined);
  assert.equal(actions.myself, undefined);
  assert.equal(actions['flagged mood'], undefined);
  for (const key of Object.keys(actions)) assert.match(key, /^[a-z0-9]+(?: [a-z0-9]+)*$/, key);
  assert.equal(lexicon.actionCount, Object.keys(actions).length);
  const family = id => Object.entries(lexicon.families).find(([, ids]) => ids.includes(id))?.[0];
  assert.equal(family(27329), 'time', 'an action id has its family too, for the guard');
});

test('verb forms: -s, -es, -ies and -ing', () => {
  assert.deepEqual(builder.verbForms('wait'), ['waits', 'waiting']);
  assert.deepEqual(builder.verbForms('wash'), ['washes', 'washing']);
  assert.deepEqual(builder.verbForms('cry'), ['cries', 'crying']);
  assert.deepEqual(builder.verbForms('make'), ['makes', 'making']);
  assert.deepEqual(builder.verbForms('see'), ['sees', 'seeing']);
  assert.deepEqual(builder.verbForms('lie'), ['lies', 'lying']);
  assert.deepEqual(builder.verbForms('go'), ['goes', 'going']);
  assert.deepEqual(builder.verbForms('give up'), [], 'phrases are not inflected');
});

test('the builder records a coarse family per id for the picture guard: food, drink, weather, time', () => {
  const lexicon = builder.buildLexicon(sample, { source: 'fixture', built: '2026-10-28' });
  const family = id => Object.entries(lexicon.families).find(([, ids]) => ids.includes(id))?.[0];
  assert.equal(family(9051), 'food'); assert.equal(family(4952), 'food');
  assert.equal(family(2296), 'drink', 'a beverage is a drink before it is food');
  assert.equal(family(3135), 'weather');
  assert.ok(!['food', 'drink', 'weather', 'time'].includes(family(6054)), 'a floor tile is none of the guarded families');
  for (const list of Object.values(lexicon.families)) for (const id of list) assert.ok([...Object.values(lexicon.words), ...Object.values(lexicon.actions)].includes(id), 'families name only indexed ids');
});

test('the serialized index is compact JSON within the size budget, and an index over budget is refused', () => {
  const lexicon = builder.buildLexicon(sample, { source: 'fixture', built: '2026-10-28' });
  const text = builder.serializeLexicon(lexicon);
  assert.deepEqual(JSON.parse(text).words, lexicon.words);
  assert.equal(builder.BUDGET_BYTES, 1000 * 1024, 'the hub reads it, never the page: under 1 MB');
  assert.throws(() => builder.serializeLexicon(lexicon, { budget: 200 }), /budget/);
});

test('the index URL comes from ERA_SYMBOL_INDEX_URL, else the search seam\'s host, else the library default', () => {
  assert.equal(builder.indexUrl({ ERA_SYMBOL_INDEX_URL: 'http://127.0.0.1:9/all.json' }), 'http://127.0.0.1:9/all.json');
  assert.equal(builder.indexUrl({ ERA_SYMBOL_SEARCH_URL: 'http://127.0.0.1:9/api/pictograms/en/bestsearch/' }), 'http://127.0.0.1:9/api/pictograms/all/en');
  assert.match(builder.indexUrl({}), /^https:\/\/[^/]+\/api\/pictograms\/all\/en$/);
});

test('the build fetches through the injected fetcher, writes the file and reports its size (no network)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-chat-lexicon-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asked = [];
  const out = path.join(dir, 'lexicon.json');
  const result = await builder.build({ env: { ERA_SYMBOL_INDEX_URL: 'http://fixture.invalid/all/en' }, out, now: new Date('2026-10-28T12:00:00Z'),
    fetch: async url => { asked.push(url); return new Response(JSON.stringify(sample)); } });
  assert.deepEqual(asked, ['http://fixture.invalid/all/en']);
  const written = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(written.built, '2026-10-28'); assert.equal(written.source, 'http://fixture.invalid/all/en');
  assert.equal(written.words.lasagna, 9051);
  assert.equal(result.bytes, fs.statSync(out).size); assert.equal(result.words, written.count);
  await assert.rejects(builder.build({ env: { ERA_SYMBOL_INDEX_URL: 'http://fixture.invalid/x' }, out, fetch: async () => new Response('nope', { status: 503 }) }), /503/);
  await assert.rejects(builder.build({ env: { ERA_SYMBOL_INDEX_URL: 'http://fixture.invalid/x' }, out, fetch: async () => new Response('[]') }), /no entries/);
});

test('the shipped index is words and numbers only, under budget, with its source and build date', () => {
  const bytes = fs.statSync(path.join(HUB, 'public', 'chat', 'lexicon.json')).size;
  assert.ok(bytes <= builder.BUDGET_BYTES, `${bytes} bytes`);
  assert.match(shipped.note, /words and pictogram ids only/i);
  assert.match(shipped.source, /^https:\/\//); assert.match(shipped.built, /^\d{4}-\d\d-\d\d$/);
  assert.ok(shipped.count > 10000, 'the library\'s thousands of things, not a sample');
  assert.ok(shipped.actionCount > 3000 && Object.keys(shipped.actions).length === shipped.actionCount, 'and its thousands of actions');
  for (const [word, id] of [...Object.entries(shipped.words), ...Object.entries(shipped.actions)]) {
    assert.match(word, /^[a-z0-9]+(?: [a-z0-9]+)*$/);
    assert.ok(Number.isSafeInteger(id) && id > 0);
  }
  assert.ok(!/https?:\/\/(?!api\.arasaac)/.test(JSON.stringify(shipped)), 'no other host');
  const readme = fs.readFileSync(path.join(HUB, 'README.md'), 'utf8');
  assert.match(readme, /public\/chat\/lexicon\.json/);
});

// ---- the hub's pick with the lexicon ----------------------------------------

const pick = (label, extra = {}) => pictures.withSymbols([{ label, say: extra.say ?? label, ...extra }])[0];
const lex = word => shipped.words[word];

test('a thing the curated vocabulary lacks takes the library picture of its own word: lasagna, tacos, burritos', () => {
  pictures.setLexicon(null);
  assert.deepEqual([pick('Lasagna').symbol, pick('Lasagna').symbolId], ['lasagna', lex('lasagna')]);
  assert.equal(pick('Tacos').symbolId, lex('taco'), 'a plural finds the singular');
  assert.equal(pick('Burritos').symbolId, lex('burrito'));
  assert.equal(pick('Some lasagna, please').symbolId, lex('lasagna'), 'articles and politeness are stripped');
  assert.equal(pick('My lasagna').symbolId, lex('lasagna'), 'and possessives');
  assert.equal(pick('Eat lasagna').symbolId, lex('lasagna'), 'a broad verb never erases the thing');
  assert.equal(pick('Lasagna for dinner').symbolId, lex('lasagna'), 'the head noun before a preposition');
  // The curated stand-ins ("sushi" was filed under food for want of a picture) yield to the library's own.
  assert.equal(pick('Sushi').symbolId, lex('sushi'));
});

test('the curated vocabulary wins whenever it has the word: its ids were checked by hand', () => {
  pictures.setLexicon(null);
  for (const word of ['stop', 'back', 'pizza', 'monday', 'park', 'music']) {
    const choice = pick(word[0].toUpperCase() + word.slice(1));
    assert.equal(choice.symbol, word, word); assert.equal(choice.symbolId, vocabId(word), word);
  }
  assert.notEqual(vocabId('back'), lex('back'), 'the library\'s own "back" is the body part; the table keeps its arrow');
  assert.equal(pick('Chicken').symbolId, vocabId('chicken'));
  assert.equal(pick('Pizza', { symbol: 'yummy' }).symbol, 'pizza', 'the label\'s own curated word beats the model\'s vocabulary pick');
});

test('several things in one label: the family picture, never one of them', () => {
  pictures.setLexicon(null);
  assert.equal(pick('Chicken and rice').symbol, 'food');
  assert.equal(pick('Beef and mushrooms').symbol, 'food');
  assert.equal(pick('Lasagna and salad').symbol, 'food');
  assert.equal(pick('Tacos and juice').symbol, 'food');
  assert.equal(pick('Lasagna or pizza').symbol, 'chat', 'an either/or in one tile is the bubble');
});

test('never a word inside a word', () => {
  pictures.setLexicon({ words: { car: 1, pet: 2, cake: 3 }, families: { food: [3] } });
  try {
    assert.equal(pick('Petunias').symbol, 'chat');
    assert.equal(pick('Carpets').symbol, 'chat');
    assert.equal(pick('Pancakes').symbol, 'pancake', 'the curated word, not the cake inside it');
    assert.equal(pick('Cheesecakes').symbol, 'chat');
  } finally { pictures.setLexicon(null); }
});

test('the family guard: a time or weather picture never stands for a food label', () => {
  pictures.setLexicon({ words: { frost: 10, lasagna: 11, spring: 12 }, families: { weather: [10], food: [11], time: [12] } });
  try {
    assert.equal(pick('Spring with rice').symbol, 'rice', 'a time picture for a food label is rejected, as a model pick would be');
    assert.equal(pick('Lasagna', { symbol: 'sunday' }).symbol, 'lasagna');
    assert.equal(pick('Spring rolls').symbol, 'chat', 'a time or weather word is never picked as one noun of several');
    assert.equal(pick('Frost peas').symbol, 'chat');
    assert.notEqual(pick('Rice and spring onions').symbolId, 12);
    assert.equal(pick('Frost').symbol, 'frost', 'the whole label may still be the weather');
  } finally { pictures.setLexicon(null); }
});

test('negation still wins over a library picture', () => {
  pictures.setLexicon(null);
  assert.equal(pick('No lasagna', { say: 'No lasagna, thanks.' }).symbol, 'no');
  assert.equal(pick("Don't like lasagna", { say: "I don't like lasagna." }).symbol, "don't like");
  assert.equal(pick('Not lasagna', { say: 'It is not lasagna.' }).symbol, 'chat');
  assert.equal(pick('No lasagna').symbolId, vocabId('no'));
});

test('the four probe labels from the device', () => {
  pictures.setLexicon(null);
  assert.equal(pick('Lasagna').symbolId, 9051);
  assert.equal(pick('Pizza').symbolId, vocabId('pizza'));
  assert.equal(pick('Chicken and rice').symbolId, vocabId('food'));
  // A brand the library lacks: curated under blocks, never the floor tile its head noun would find.
  assert.equal(pick('Magna-Tiles').symbolId, vocabId('blocks'));
});

test('without public/chat/lexicon.json the hub warns once and keeps the vocabulary picks', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-chat-nolexicon-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(HUB, 'chat-symbols.js'), path.join(dir, 'chat-symbols.js'));
  fs.mkdirSync(path.join(dir, 'public', 'chat'), { recursive: true });
  fs.copyFileSync(path.join(HUB, 'public', 'chat', 'vocabulary.json'), path.join(dir, 'public', 'chat', 'vocabulary.json'));
  const probe = `const p = require('./chat-symbols.js');
    console.log(JSON.stringify(p.withSymbols([{ label: 'Lasagna', say: 'Lasagna.' }, { label: 'Pizza', say: 'Pizza.' }, { label: 'Sushi', say: 'Sushi.' }]).map(c => c.symbol)));`;
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['-e', probe], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })), ['chat', 'pizza', 'food']);
  const warned = spawnSync(process.execPath, ['-e', probe], { cwd: dir, encoding: 'utf8' }).stderr;
  assert.equal(warned.split('\n').filter(line => /picture lexicon unavailable/.test(line)).length, 1, warned);
});

// ---- what the partner says, before the reply ---------------------------------

test('candidate pictures from a partial: the things after or/and/commas and after want/like/eat/play with/go to', () => {
  pictures.setLexicon(null);
  const ids = text => pictures.pictureCandidates(text).map(candidate => candidate.id);
  assert.deepEqual(ids('would you like lasagna or tacos'), [lex('lasagna'), lex('taco')]);
  assert.deepEqual(ids('do you want to eat burritos'), [lex('burrito')]);
  assert.deepEqual(ids('shall we go to the beach'), [vocabId('beach')]);
  assert.deepEqual(ids('do you want to play with the magnets'), [lex('magnet')]);
  assert.deepEqual(ids('we have lasagna, sushi and tacos'), [lex('lasagna'), lex('sushi'), lex('taco')]);
  assert.deepEqual(ids('how was your day'), [], 'no trigger, no candidates');
  for (const candidate of pictures.pictureCandidates('would you like lasagna or pizza')) assert.ok(Number.isSafeInteger(candidate.id) && candidate.id > 0);
  assert.ok(pictures.pictureCandidates('a, b, c, d, e, f, g, h, i, j, lasagna, pizza, tacos, burritos, sushi, rice, beans, peas').length <= 6);
});

test('the warmer is bounded: six per hold, deduplicated, two at once, three seconds each, and never awaited', async () => {
  let active = 0, most = 0;
  const started = [], cached = new Set([5]);
  const release = new Map();
  const warmer = pictures.createPictureWarmer({ isCached: id => cached.has(id), timeoutMs: 60,
    fetchOne: (id, { signal }) => { started.push(id); active++; most = Math.max(most, active);
      return new Promise(resolve => { release.set(id, resolve); signal.addEventListener('abort', () => resolve(false)); }).finally(() => { active--; }); } });
  const hold = warmer.hold();
  const began = Date.now();
  for (const id of [1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10]) hold.add(id);
  assert.ok(Date.now() - began < 20, 'adding never waits for a fetch');
  assert.equal(hold.count, 6, 'six fetches at most for one hold (a cached picture costs nothing)');
  assert.deepEqual(started, [], 'fetches start after the caller has moved on');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [1, 2]);
  release.get(1)(true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(started, [1, 2, 3]);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(started, [1, 2, 3, 4, 6, 7], 'a stuck fetch times out and frees its slot');
  assert.equal(most, 2);
  // A staged choice's picture goes first and is not counted against the partials' six.
  const second = warmer.hold();
  for (const id of [20, 21, 22, 23, 24, 25, 26]) second.add(id);
  second.stage(30);
  assert.equal(second.count, 7);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(started.indexOf(30) >= 0 && started.indexOf(30) < started.indexOf(22), 'staged first in the queue');
  second.stage(30); second.stage(5);
  assert.equal(second.count, 7, 'deduplicated, cached skipped');
});

test('the hub hands Chat its symbol cache: a cache check on data/symbols-cache and a fetch it can abort', () => {
  const hubSource = fs.readFileSync(path.join(HUB, 'server.js'), 'utf8');
  const call = hubSource.match(/require\("\.\/chat-api\.js"\)\.createChatApi\(\{([\s\S]*?)\}\);/)?.[1] || '';
  assert.match(call, /pictures:\s*\{/);
  assert.match(call, /isCached:[^\n]*SYMBOLS_CACHE/);
  assert.match(call, /fetchOne:[^\n]*fetchSymbolToCache\(String\(id\), \{ signal \}\)/);
  assert.match(hubSource, /async function fetchSymbolToCache\(name, \{ signal \} = \{\}\)/);
  assert.match(hubSource, /fetch\(ARASAAC_API \+ encodeURIComponent\(name\), \{ signal \}\)/);
});

test('the page never asks another host or the lexicon for a picture: the hub resolves, the page loads /symbol/<id>', () => {
  for (const file of ['app.js', 'symbols.js', 'controller.js', 'turnlog.js']) {
    const source = fs.readFileSync(path.join(HUB, 'public', 'chat', file), 'utf8');
    assert.ok(!/lexicon/.test(source), `${file} never loads the lexicon`);
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(source), `${file} names no other host`);
  }
});

test('Magna-Tiles is a toy: the curated blocks picture, never the library\'s floor tile', () => {
  pictures.setLexicon(null);
  for (const label of ['Magna-Tiles', 'magna tiles', 'Magnatiles', 'Magnetic tiles', 'Play with Magna-Tiles']) {
    const choice = pick(label);
    assert.equal(choice.symbolId, vocabId('blocks'), label);
    assert.notEqual(choice.symbolId, lex('tiles'), label);
  }
});

// ---- the actions map: a picture for a reply that names no thing --------------

const ACTIONS_FIXTURE = {
  words: { paddle: 203, lasagna: 11, frost: 12 },
  actions: { go: 101, later: 102, hurry: 103, sure: 104, lot: 105, learn: 106, clap: 107, shout: 108, whisper: 109, try: 110,
    wiggle: 111, spin: 112, tickle: 113, snuggle: 114, late: 115, pretend: 116, celebrate: 117, silly: 118, paddle: 204, sunny: 119 },
  families: { food: [11], weather: [12, 119], time: [102, 115] },
};

test('a label that names no thing takes the library picture of its action, quality or social word', () => {
  pictures.setLexicon(ACTIONS_FIXTURE);
  try {
    // [label, the action word it shows]
    const table = [
      ['Go now', 'go'], ['Ever so late', 'late'], ['Hurry up', 'hurry'], ['Sure', 'sure'], ['A lot', 'lot'],
      ['Learned things', 'learn'], ['Clap', 'clap'], ['Shout', 'shout'], ['Whisper it', 'whisper'], ['Keep trying', 'try'],
      ['Wiggle', 'wiggle'], ['Spin around', 'spin'], ['Whispering', 'whisper'], ['Snuggle', 'snuggle'], ['Stay up late', 'late'],
      ['Pretend', 'pretend'], ["Let's pretend!", 'pretend'], ['Wiggling', 'wiggle'], ['Keep going', 'go'], ['Clapping', 'clap'],
    ];
    for (const [label, word] of table) {
      const choice = pick(label);
      assert.equal(choice.symbolId, ACTIONS_FIXTURE.actions[word], `${label} → ${choice.symbol}`);
      assert.notEqual(choice.symbol, 'chat', label);
    }
  } finally { pictures.setLexicon(null); }
});

test('actions come last: curated words and things first, an either/or and a negation keep their pictures', () => {
  pictures.setLexicon(ACTIONS_FIXTURE);
  try {
    assert.equal(pick('Paddle').symbolId, 203, 'the thing before the action of the same word');
    assert.equal(pick('Go swim').symbol, 'swim', 'a curated word still wins');
    assert.equal(pick('Pizza now').symbol, 'pizza');
    assert.equal(pick('Clap or shout').symbol, 'chat', 'an either/or in one tile stays the bubble');
    assert.equal(pick("Don't shout", { say: "Please don't shout." }).symbol, 'chat', 'a negation never takes the action');
    assert.equal(pick('Not really').symbol, 'chat');
    assert.equal(pick('Hurry up', { symbol: 'happy' }).symbol, 'happy', 'the model\'s accepted vocabulary pick comes first');
    assert.equal(pick('Hurry up', { symbol: 'chat' }).symbolId, 103, 'the model\'s bubble is no pick: the action still shows');
    assert.equal(pick('Hmm', { say: 'Hmm, a big wiggle.' }).symbolId, 111, 'the say when the label has nothing');
  } finally { pictures.setLexicon(null); }
});

// ---- the model names a picture in plain words ---------------------------------

const PICTURE_FIXTURE = {
  words: { 'magnifying glass': 301, clock: 302, frost: 12, umbrella: 305 },
  actions: { shrug: 303, wave: 304, late: 115, sunny: 119 },
  families: { weather: [12, 119, 305], time: [302, 115] },
};

test('the model\'s picture words resolve through the curated table, the things, then the actions', () => {
  pictures.setLexicon(PICTURE_FIXTURE);
  try {
    assert.equal(pick('Hmm', { say: 'Hmm, let me think.', symbol: 'chat', picture: 'shrug' }).symbolId, 303, 'an action');
    assert.equal(pick('Hmm', { say: 'Hmm.', picture: 'magnifying glass' }).symbolId, 301, 'a thing of two words');
    assert.equal(pick('Hmm', { say: 'Hmm.', picture: 'tiny shrug' }).symbolId, 303, 'its head word when the whole is unknown');
    assert.equal(pick('Hmm', { say: 'Hmm.', picture: 'clock' }).symbolId, vocabId('time'), 'a curated alternative word keeps its checked id');
    assert.equal(pick('Hmm', { say: 'Hmm.', picture: 'hello' }).symbolId, vocabId('hello'), 'a curated word keeps its checked id');
    assert.equal(pick('Ever so late', { picture: 'magnifying glass' }).symbolId, 301, 'before the label\'s own action word');
    assert.equal(pick('Ever so late', { picture: 'zorbish' }).symbolId, 115, 'an unknown picture falls through to the action');
    assert.equal(pick('Ever so late', { picture: 'one two three four' }).symbolId, 115, 'more than three words is no picture');
    assert.equal(pick('Ever so late', { picture: 'chat' }).symbolId, 115, 'the bubble is no picture');
  } finally { pictures.setLexicon(null); }
});

test('the model\'s picture comes after the label\'s own picks and is guarded like its symbol', () => {
  pictures.setLexicon(PICTURE_FIXTURE);
  try {
    assert.equal(pick('Pizza', { picture: 'clock' }).symbol, 'pizza', 'a curated label');
    assert.equal(pick('Hmm', { say: 'Hmm.', symbol: 'happy', picture: 'shrug' }).symbol, 'happy', 'an accepted vocabulary symbol');
    assert.equal(pick('Give me a clue', { symbol: 'chat', picture: 'magnifying glass' }).symbol, 'clue', 'a label that is a curated word');
    assert.equal(pick('Pizza at the park', { picture: 'frost' }).symbol, 'food', 'a label\'s own category');
    // A drink-and-place label (no picture of its own) never shows a time or weather picture.
    for (const picture of ['frost', 'clock', 'umbrella', 'sunny']) assert.equal(pick('Juice at the park', { picture }).symbol, 'chat', picture);
    assert.equal(pick('Juice at the park', { picture: 'park' }).symbol, 'park', 'a picture of the label\'s own family stands');
    // A negation keeps only a negative picture.
    assert.equal(pick('Not later', { say: 'Not later.', picture: 'clock' }).symbol, 'chat');
    assert.equal(pick('No clocks', { say: 'No clocks, thanks.', picture: 'clock' }).symbol, 'no');
  } finally { pictures.setLexicon(null); }
});

test('the hub passes the model\'s picture words from the reply to the pick', async t => {
  const http = await import('node:http');
  const { createChatApi } = require('../chat-api.js');
  pictures.setLexicon(PICTURE_FIXTURE);
  const env = { ERA_CHAT_TEXT_URL: 'https://text.example/responses', ERA_CHAT_TEXT_MODEL: 'configured', ERA_CHAT_TEXT_TOKEN: 'private-value' };
  const reply = { choices: [{ label: 'Hmm', say: 'Hmm, let me think.', symbol: 'chat', picture: 'magnifying glass' },
    { label: 'Not sure', say: 'I am not sure.', symbol: 'not sure', picture: 'shrug' }] };
  const api = createChatApi({ env, fetch: async () => new Response(JSON.stringify({ status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(reply) }] }] })) });
  const server = http.createServer((req, res) => { if (!api.handle(req, res)) res.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  t.after(async () => { pictures.setLexicon(null); api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const body = await (await fetch(`http://localhost:${server.address().port}/chat/api/choices`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'What should we look for next?' }) })).json();
  assert.deepEqual(body.choices.map(choice => choice.symbolId), [301, vocabId('not sure')]);
  assert.ok(body.choices.every(choice => choice.picture === undefined || typeof choice.picture === 'object'), 'the model\'s words never reach the page as a picture');
  // The streamed path stages each choice through the same pick.
  const source = fs.readFileSync(path.join(HUB, 'chat-api.js'), 'utf8');
  assert.match(source.match(/function stageChoice[\s\S]*?\n  \}/)[0], /picture: choice\.picture/);
});

// ---- the family's own people pictures ------------------------------------------

const PEOPLE = [{ slug: 'mom', word: 'Mom' }, { slug: 'dad', word: 'Dad' }, { slug: 'sam-2', word: 'Sam' },
  { slug: 'grandma', word: 'Granny' }, { slug: 'old-friend', word: 'Lisa', retired: true }];
const person = slug => ({ src: `/characters/${slug}.png`, kind: 'person' });

test('a tile that is one of the family shows their own picture: their word, a kin word, "my" or "with" before it', () => {
  pictures.setPeople(() => PEOPLE);
  try {
    for (const [label, slug, word] of [['Mom', 'mom', 'Mom'], ['mom', 'mom', 'Mom'], ['My mom', 'mom', 'Mom'], ['With Dad', 'dad', 'Dad'],
      ['with my dad', 'dad', 'Dad'], ['Mommy', 'mom', 'Mom'], ['Mum', 'mom', 'Mom'], ['Daddy', 'dad', 'Dad'], ['Sam', 'sam-2', 'Sam'],
      ['Grandma', 'grandma', 'Granny'], ['Nana', 'grandma', 'Granny']]) {
      const choice = pick(label);
      assert.deepEqual(choice.picture, person(slug), label);
      assert.equal(choice.symbol, word, label);
      assert.equal(choice.symbolId, undefined, `${label}: the person picture stands alone`);
    }
    assert.deepEqual(pick('Hmm', { say: 'Sam.' }).picture, person('sam-2'), 'the say, when the label has nothing');
    assert.equal(pick('Play with Sam').picture, undefined, 'only a tile that is the person, not one that mentions them');
    assert.equal(pick('Not Mom', { say: 'Not Mom.' }).picture, undefined, 'a negation is never the person');
    assert.equal(pick('Grandpa').picture, undefined, 'a kin word the family library lacks keeps the library picture');
    assert.equal(pick('Grandpa').symbol, 'grandpa');
  } finally { pictures.setPeople(null); }
});

test('an unknown name is the friend picture, the second one people; a retired person is an unknown name', () => {
  pictures.setPeople(() => PEOPLE);
  try {
    const choices = pictures.withSymbols(['Lisa', 'Jo', 'Mom', 'Sam'].map(label => ({ label, say: label })));
    assert.deepEqual(choices.map(choice => choice.symbol), ['friend', 'people', 'Mom', 'Sam']);
    assert.deepEqual(choices.map(choice => choice.picture?.src || choice.symbolId),
      [vocabId('friend'), vocabId('people'), '/characters/mom.png', '/characters/sam-2.png']);
    // Without a family library the two names still never share a picture.
    pictures.setPeople(() => []);
    const plain = pictures.withSymbols([{ label: 'Lisa', say: 'Lisa.' }, { label: 'Sam', say: 'Sam.' }]);
    assert.deepEqual(plain.map(choice => choice.symbol), ['friend', 'people']);
    // Ordinary one-word replies are never names.
    for (const label of ['Sure', 'Maybe', 'Okay', 'Later', 'Nothing', 'Whatever', 'Yes', 'Pizza', 'Wait', 'Again'])
      assert.ok(!['friend', 'people'].includes(pick(label).symbol), label);
  } finally { pictures.setPeople(null); }
});

test('the people provider is asked once per batch, may fail, and is never loaded at require time', () => {
  let asked = 0;
  pictures.setPeople(() => { asked++; return PEOPLE; });
  try {
    pictures.withSymbols([{ label: 'Mom', say: 'Mom.' }, { label: 'Dad', say: 'Dad.' }, { label: 'Pizza', say: 'Pizza.' }]);
    assert.equal(asked, 1);
    pictures.setPeople(() => { throw Error('no library'); });
    assert.equal(pick('Mom').symbol, 'mom', 'a failing provider leaves the library picture');
    pictures.setPeople(() => [{ slug: '../x', word: 'Mom' }, { slug: 'ok', word: '<b>Dad</b>' }, null, { slug: 'fine' }]);
    assert.equal(pick('Mom').picture, undefined, 'a slug outside the pattern is never a picture path');
    assert.equal(pick('Dad').picture, undefined);
  } finally { pictures.setPeople(null); }
  const source = fs.readFileSync(path.join(HUB, 'chat-symbols.js'), 'utf8');
  assert.ok(!/require\(['"]\.\/drawings/.test(source), 'chat-symbols never requires drawings.js');
  const hub = fs.readFileSync(path.join(HUB, 'server.js'), 'utf8');
  assert.match(hub, /setPeople\(\(\) => drawings\.charactersLibrary\(\)\.people\)/, 'the hub hands Chat its people library, lazily');
});

test('the label\'s own curated concept at its head beats the model\'s word; a label naming nothing curated keeps the model\'s', () => {
  pictures.setLexicon(null);
  const table = [
    [{ label: 'Stay home', symbol: 'game' }, 'home'],
    [{ label: 'Go outside', symbol: 'park' }, 'outside'],
    [{ label: 'Something fun', symbol: 'game' }, 'game'],
    [{ label: 'Go to the park', symbol: 'swim' }, 'park'],
    [{ label: 'Eat pizza', symbol: 'yummy' }, 'pizza'],
    [{ label: 'Play with the dog', symbol: 'play' }, 'dog'],
    [{ label: 'Stay inside', symbol: 'game' }, 'home'],
    [{ label: 'Hmm', symbol: 'game' }, 'game'],
    [{ label: 'Not home', say: 'Not home.', symbol: 'game' }, 'chat'],
  ];
  for (const [choice, word] of table) assert.equal(pick(choice.label, choice).symbol, word, `${choice.label} / ${choice.symbol}`);
});
