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
  assert.equal(pick('Pizza', { symbol: 'yummy' }).symbol, 'yummy', 'the model\'s vocabulary pick for a curated label stands');
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
