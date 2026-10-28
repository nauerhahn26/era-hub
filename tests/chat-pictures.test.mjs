// Chat pictures on the hub (spec 2026-10-27 §6): the reply model picks a
// vocabulary word, the hub maps it to a pictogram id, refuses an affirmative
// picture for a refusal or negation, and falls back to its own text guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pictures = require('../chat-symbols.js');
const { createChoicesAdapter } = require('../chat-choices.js');
const { createChatApi } = require('../chat-api.js');
const vocabulary = JSON.parse(fs.readFileSync(new URL('../public/chat/vocabulary.json', import.meta.url), 'utf8'));
const byWord = new Map(vocabulary.concepts.map(concept => [concept.word, concept]));
const env = { ERA_CHAT_TEXT_URL: 'https://text.example/responses', ERA_CHAT_TEXT_MODEL: 'configured', ERA_CHAT_TEXT_TOKEN: 'private-value' };
const response = value => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
const negative = word => byWord.get(word)?.tone === 'negative';

test('the strict choice schema requires a symbol drawn only from the vocabulary words plus "chat"', async () => {
  let schema, instructions;
  const adapter = createChoicesAdapter({ env, fetch: async (_, options) => {
    ({ instructions, text: { format: { schema } } } = JSON.parse(options.body));
    return response({ choices: [{ label: 'Pizza', say: 'I would like pizza.', symbol: 'pizza' }, { label: 'Not now', say: 'Not now, thanks.', symbol: 'not now' }] });
  } });
  await adapter.generate({ text: 'What would you like for dinner?' });
  const item = schema.properties.choices.items;
  assert.deepEqual(item.required, ['label', 'say', 'symbol', 'picture'], 'strict mode requires every property');
  assert.deepEqual(item.properties.picture, { type: 'string', minLength: 1, maxLength: 32 });
  assert.match(instructions, /picture: one to three plain words naming a concrete thing, action or gesture/);
  assert.match(instructions, /'shrug' for not sure, 'magnifying glass' for a clue, 'clock' for later, 'wave' for hello/);
  assert.match(instructions, /for a person their role \(mom, dad, friend, teacher\)/);
  assert.equal(item.additionalProperties, false);
  const symbols = item.properties.symbol.enum;
  assert.ok(symbols.includes('chat'));
  assert.deepEqual([...symbols].sort(), [...pictures.symbolWords()].sort());
  assert.ok(symbols.length <= 500 && symbols.join('').length < 15000, 'inside the structured-output enum limits');
  assert.ok(symbols.every(word => byWord.has(word)), 'no enum value outside the table');
  for (const unknown of ['spaceship', 'Pizza', 'unicorn rainbow', '', 'happy face']) assert.ok(!symbols.includes(unknown), unknown);
  assert.match(instructions, /symbol/i);
  assert.match(instructions, /never .*affirmative picture.*(refusal|negation)/i);
  assert.match(instructions, /"chat" when unsure/i);
});

test('the model\'s plain-words picture reaches the result; a malformed one is dropped and never costs the reply', async () => {
  const adapter = createChoicesAdapter({ env, fetch: async () => response({ choices: [
    { label: 'Maybe', say: 'Maybe.', symbol: 'chat', picture: 'shrug' },
    { label: 'A clue', say: 'Can you give me a clue?', symbol: 'clue', picture: '  magnifying   glass ' },
    { label: 'Later', say: 'Later, please.', symbol: 'chat', picture: 'a very long picture name here' },
    { label: 'Hello', say: 'Hello!', symbol: 'hello', picture: '<b>wave</b>' }] }) });
  const result = await adapter.generate({ text: 'Shall we look for it?' });
  assert.deepEqual(result.choices.map(choice => choice.picture), ['shrug', 'magnifying glass', undefined, undefined]);
  assert.deepEqual(result.choices.map(choice => choice.label), ['Maybe', 'A clue', 'Later', 'Hello'], 'labels and says are unchanged');
  const extra = createChoicesAdapter({ env, fetch: async () => response({ choices: [
    { label: 'A', say: 'A.', symbol: 'chat', picture: 'cat', colour: 'red' }, { label: 'B', say: 'B.', symbol: 'chat', picture: 'dog' }] }) });
  await assert.rejects(extra.generate({ text: 'Which?' }), error => error.code === 'generation-invalid', 'other extra fields are still refused');
});

test('a valid model symbol reaches the result; an unknown or missing one falls back to the hub text guess', async () => {
  const adapter = createChoicesAdapter({ env, fetch: async () => response({ choices: [
    { label: 'Pizza', say: 'I would like pizza.', symbol: 'pizza' },
    { label: 'Music', say: 'Can we play music?', symbol: 'spaceship' },
    { label: 'A story', say: 'Read me a story.' }] }) });
  const result = await adapter.generate({ text: 'What shall we do?' });
  assert.deepEqual(result.choices.map(choice => choice.symbol), ['pizza', undefined, undefined]);
  const placed = pictures.withSymbols(result.choices);
  assert.deepEqual(placed.map(choice => choice.symbol), ['pizza', 'music', 'book']);
  for (const choice of placed) assert.equal(choice.symbolId, byWord.get(choice.symbol).id);
});

test('negation never keeps an affirmative or topic picture: refusals show "no", other negations the bubble', () => {
  for (const concept of vocabulary.concepts.filter(concept => concept.tone !== 'negative')) {
    const word = concept.word;
    for (const [label, say] of [[`Not ${word}`, `I don't want ${word}.`], [`No ${word}`, `No ${word}, thanks.`], [`Not ${word}`, `It is not ${word}.`]]) {
      const picked = pictures.pickSymbol({ label, say, symbol: word });
      assert.ok(negative(picked), `${label} / ${say} kept ${picked}`);
    }
  }
  assert.equal(pictures.pickSymbol({ label: 'No music', say: 'No music, thanks.', symbol: 'music' }), 'no');
  assert.equal(pictures.pickSymbol({ label: "Don't like it", say: "I don't like it.", symbol: 'like' }), "don't like");
  assert.equal(pictures.pickSymbol({ label: 'Not happy', say: 'I am not happy.', symbol: 'happy' }), 'chat');
  // A negated feeling is not that feeling: "Not sad" never shows the sad face.
  for (const word of ['sad', 'scared', 'tired', 'angry', 'sick', 'hurt', 'bored', 'lonely', 'cry'])
    assert.equal(pictures.pickSymbol({ label: `Not ${word}`, say: `I'm not ${word}.`, symbol: word }), 'chat', word);
  assert.equal(pictures.pickSymbol({ label: 'Not now', say: 'Not now, thanks.', symbol: 'not now' }), 'not now');
  assert.equal(pictures.pickSymbol({ label: 'Never mind', say: 'Never mind.', symbol: 'yes' }), 'chat');
  // Other negative forms (review 10/27): none may keep an affirmative or topic picture.
  for (const [label, say, symbol] of [['Nope', 'Nope.', 'yes'], ['Nah', 'Nah, I am good.', 'good'], ['Wouldnt like it', "I wouldn't like that.", 'like'],
    ['I havent been', "I haven't been to the park.", 'park'], ['Hate it', 'I hate it.', 'love'], ['Dislike dogs', 'I dislike dogs.', 'dog'],
    ["Couldn't", "I couldn't eat pizza.", 'pizza'], ["Shouldn't", "We shouldn't go outside.", 'outside']])
    assert.ok(negative(pictures.pickSymbol({ label, say, symbol })), `${label} / ${say}`);
  assert.ok(negative(pictures.pickSymbol({ label: 'Hate it', say: 'I hate it.' })), 'the text guess is guarded too');
  // A curated label never hides a refusal in the say.
  assert.equal(pictures.pickSymbol({ label: "I'm good", say: 'No thanks, I am good.' }), 'no');
  // A "No," that answers with a positive is not a refusal picture.
  assert.equal(pictures.pickSymbol({ label: 'No, I love it!', say: 'No, I love it!', symbol: 'love' }), 'chat');
  // Reassurance and surprise are curated, not refusals.
  assert.equal(pictures.pickSymbol({ label: 'No worries', say: 'No worries.' }), 'chat');
  assert.equal(pictures.pickSymbol({ label: 'No way!', say: 'No way!' }), 'surprised');
});

test('the text guess finds one clear subject and stays neutral when there are two or none', () => {
  const guess = (label, say) => pictures.pickSymbol({ label, say });
  assert.equal(guess('Pizza please', ''), 'pizza');
  assert.equal(guess('Play outside', ''), 'outside');
  assert.equal(guess('I am happy to play music', ''), 'music');
  assert.equal(guess('Draw with friends', ''), 'draw');
  assert.equal(guess("Let's play together", ''), 'play');
  assert.equal(guess('My choice', 'I want to listen to music.'), 'music');
  assert.equal(guess('Music', 'Tell me a story.'), 'music');
  assert.equal(guess('Music or a story', ''), 'chat');
  assert.equal(guess('I like music and stories', ''), 'chat');
  // A quality the library has is no longer the bubble (the actions map); a word it lacks still is.
  assert.equal(guess('A surprising thought', 'Something unusual.'), 'surprising');
  assert.equal(guess('A zorbish thought', 'Something zorbish.'), 'chat');
  assert.equal(guess('Grandma', 'I want to see Grandma.'), 'grandma');
  assert.equal(guess('Two dogs', ''), 'dog');
});

test('shortcuts and guarded templates carry curated pictures with their ids', async t => {
  const api = createChatApi({ env: {}, fetch: () => { throw Error('unexpected request'); } });
  const server = http.createServer((req, res) => { if (!api.handle(req, res)) res.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  t.after(async () => { api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const ask = async text => (await (await fetch(`http://localhost:${server.address().port}/chat/api/choices`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })).json()).choices;
  const pairs = choices => choices.map(choice => [choice.say, choice.symbol, choice.symbolId]);
  const id = word => byWord.get(word).id;
  assert.deepEqual(pairs(await ask('Did you enjoy that?')), [['Yes', 'yes', id('yes')], ['No', 'no', id('no')],
    ["I'm not sure", 'not sure', id('not sure')], ['Please say that again', 'say again', id('say again')]]);
  assert.deepEqual(pairs(await ask('Hello!')).map(row => row[1]), ['hello', 'happy', 'feelings']);
  assert.deepEqual(pairs(await ask('Would you like music or a story?')).map(row => row[1]), ['music', 'book']);
  assert.deepEqual(pairs(await ask('Were you at school or at home?')).map(row => row[1]), ['clue', 'different', 'not now']);
  // A recall batch that asserts a past activity is thrown out for the fixed repairs (since 10/28 the model is asked first).
  const invented = new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
    text: JSON.stringify({ choices: [{ label: 'The park', say: 'I went to the park.' }, { label: 'Fun', say: 'It was fun.' }] }) }] }] }));
  const guarded = await createChoicesAdapter({ env, fetch: async () => invented }).generate({ text: 'What did you do last weekend?', shape: 'recall' });
  assert.deepEqual(pictures.withSymbols(guarded.choices).map(choice => choice.symbol), ['clue', 'different', 'forget', 'not now']);
  const adapter = createChoicesAdapter({ env, fetch: () => { throw Error('guarded turns make no request'); } });
  const support = await adapter.generate({ text: 'I lost my drawing.' });
  assert.deepEqual(pictures.withSymbols(support.choices).map(choice => choice.symbol), ['help', 'more', 'wait']);
});

test('the warm list is every vocabulary picture once, alternates included', () => {
  const ids = pictures.vocabularyIds();
  assert.equal(new Set(ids).size, ids.length);
  for (const concept of vocabulary.concepts) {
    assert.ok(ids.includes(String(concept.id)), concept.word);
    if (concept.altId) assert.ok(ids.includes(String(concept.altId)), concept.word + ' alternate');
  }
  assert.ok(ids.every(id => /^\d+$/.test(id)));
});

test('the pre-warm pass is sequential, throttled, resumable and idempotent', async () => {
  const cache = new Set(['2', '5']), fetched = [], sleeps = [];
  let active = 0, peak = 0;
  const warmer = pictures.createSymbolWarmer({
    ids: ['1', '2', '3', '4', '5', '6'], delayMs: 40,
    isCached: id => cache.has(id),
    fetchOne: async id => { active++; peak = Math.max(peak, active); await null; active--; fetched.push(id); if (id === '4') return null; cache.add(id); return id; },
    sleep: async ms => { sleeps.push(ms); },
  });
  const first = await warmer.run();
  assert.deepEqual(fetched, ['1', '3', '4', '6'], 'cached pictures are never fetched again');
  assert.equal(peak, 1, 'one request at a time');
  assert.deepEqual(sleeps, [40, 40, 40], 'a pause between consecutive network fetches');
  assert.deepEqual(first, { fetched: 3, cached: 2, failed: 1, remaining: 1, stopped: false });
  fetched.length = 0; sleeps.length = 0;
  const second = await warmer.run();
  assert.deepEqual(fetched, ['4'], 'a later pass resumes with what is still missing');
  assert.deepEqual(second.remaining, 1);
  cache.add('4'); fetched.length = 0;
  assert.deepEqual(await warmer.run(), { fetched: 0, cached: 6, failed: 0, remaining: 0, stopped: false });
  assert.deepEqual(fetched, [], 'a complete cache makes no request');
});

test('the pre-warm pass stops after repeated failures and never runs twice at once', async () => {
  let calls = 0;
  const warmer = pictures.createSymbolWarmer({ ids: Array.from({ length: 50 }, (_, i) => String(i + 1)), delayMs: 0, maxFailures: 3,
    isCached: () => false, fetchOne: async () => { calls++; return null; }, sleep: async () => {} });
  const [a, b] = await Promise.all([warmer.run(), warmer.run()]);
  assert.equal(a, b, 'a second caller joins the running pass');
  assert.equal(calls, 3);
  assert.equal(a.stopped, true);
});

test('the pictures preview covers the 46 fixed phrases and 30 sample replies on scratch-hub ports only', async () => {
  const { FIXED_PHRASES, SAMPLE_REPLIES, previewScenes, scratchPort } = await import('../tools/chat-pictures-preview.mjs');
  assert.equal(FIXED_PHRASES.length, 46); assert.equal(new Set(FIXED_PHRASES).size, 46);
  assert.equal(SAMPLE_REPLIES.length, 30);
  const scenes = previewScenes();
  assert.equal(scenes.flatMap(scene => scene.words).length, 76);
  assert.ok(scenes.every(scene => scene.words.length >= 1 && scene.words.length <= 4));
  for (const word of scenes.filter(scene => scene.type === 'response').flatMap(scene => scene.words))
    assert.equal(word.symbolId, byWord.get(word.symbol).id, word.label);
  assert.equal(scratchPort({}), 8493);
  const { PREVIEW_SIZES, PREVIEW_STYLES } = await import('../tools/chat-pictures-preview.mjs');
  assert.deepEqual(PREVIEW_SIZES.map(size => `${size.width}x${size.height}`), ['1280x800', '1920x1080']);
  assert.deepEqual(PREVIEW_STYLES.map(style => style.id), ['color', 'bw', 'emoji', 'stacked-big']);
  for (const port of ['8377', '8378', '8386', '8500']) assert.throws(() => scratchPort({ ERA_TEST_PORT: port }), port);
  const { previewArguments } = await import('../tools/chat-preview.mjs');
  assert.deepEqual(previewArguments(['--pictures', '--out', '/tmp/x']), { pictures: true, out: '/tmp/x', data: undefined });
  assert.deepEqual(previewArguments([]), { pictures: false, out: undefined, data: undefined });
});

test('the vocabulary contact sheet shows every word with its picture and lists ids that return no image', async () => {
  const { buildSheet } = await import('../tools/chat-vocabulary-sheet.mjs');
  const concepts = [{ word: 'pizza', id: 2527 }, { word: 'apple', id: 2462, alt: ['apples'] }, { word: "don't know", id: 7180, tone: 'negative' }];
  const asked = [];
  const sheet = await buildSheet({ concepts, fetchPicture: async id => { asked.push(id); return id === 2462 ? null : Buffer.from('png-bytes'); } });
  assert.deepEqual(asked, [2527, 2462, 7180]);
  assert.deepEqual(sheet.missing, [{ word: 'apple', id: 2462 }]);
  assert.match(sheet.html, /pizza/); assert.match(sheet.html, /don&#39;t know/); assert.match(sheet.html, /2527/);
  assert.match(sheet.html, /data:image\/png;base64,/);
  assert.ok(!/https?:\/\//.test(sheet.html), 'the sheet is self-contained');
  assert.match(sheet.html, /NO IMAGE/);
});

test('without public/chat/vocabulary.json the module loads, warns once and falls back to the bubble with no picture id', async t => {
  const os = await import('node:os'), path = await import('node:path'), { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-chat-novocab-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(new URL('../chat-symbols.js', import.meta.url), path.join(dir, 'chat-symbols.js'));
  const probe = `const p = require('./chat-symbols.js');
    const a = p.withSymbols([{ label: 'Pizza', say: 'Pizza please.', symbol: 'pizza' }, { label: 'No', say: 'No.' }]);
    console.log(JSON.stringify({ words: p.symbolWords(), ids: p.vocabularyIds(), a, pick: p.pickSymbol({ label: 'Not now' }) }));`;
  const run = () => execFileSync(process.execPath, ['-e', probe], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = JSON.parse(run());
  assert.deepEqual(out.words, ['chat'], 'the strict enum still has its one fallback value');
  assert.deepEqual(out.ids, []);
  assert.deepEqual(out.a.map(choice => [choice.symbol, choice.symbolId]), [['chat', undefined], ['chat', undefined]]);
  assert.equal(out.pick, 'chat');
  const { spawnSync } = await import('node:child_process');
  const warned = spawnSync(process.execPath, ['-e', probe], { cwd: dir, encoding: 'utf8' }).stderr;
  assert.equal(warned.split('\n').filter(line => /picture vocabulary unavailable/.test(line)).length, 1, 'one clear warning: ' + warned);
});

test('a hub installed without the vocabulary file still boots and answers /status and Chat choices', { timeout: 60000 }, async t => {
  const os = await import('node:os'), path = await import('node:path'), { spawn } = await import('node:child_process');
  const HUB = new URL('..', import.meta.url).pathname;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-chat-novocab-hub-'));
  const modules = [...fs.readFileSync(path.join(HUB, 'tools', 'build-payload.sh'), 'utf8').matchAll(/"\$HUB\/([A-Za-z0-9._-]+\.(?:json|js))"/g)].map(m => m[1]);
  assert.ok(modules.includes('chat-symbols.js'));
  fs.mkdirSync(path.join(dir, 'install', 'public', 'home'), { recursive: true });
  for (const file of modules) fs.copyFileSync(path.join(HUB, file), path.join(dir, 'install', file));
  assert.equal(fs.existsSync(path.join(dir, 'install', 'public', 'chat', 'vocabulary.json')), false);
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js', String(port)], { cwd: path.join(dir, 'install'), stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ERA_DATA_DIR: path.join(dir, 'data'), ERA_BIND: '127.0.0.1', ERA_CHAT_CONFIG_DISABLED: '1', ERA_UPDATE_URL: 'http://127.0.0.1:1',
      ERA_SYMBOL_SEARCH_URL: 'http://127.0.0.1:1/search/', ERA_SYMBOL_IMAGE_URL: 'http://127.0.0.1:1/images/{id}.png' } });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { if (child.exitCode === null) { const gone = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await gone; } fs.rmSync(dir, { recursive: true, force: true }); });
  let status = 0;
  for (let i = 0; i < 150 && child.exitCode === null; i++) {
    try { status = (await fetch(`http://127.0.0.1:${port}/status`)).status; if (status === 200) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(status, 200, 'the hub serves /status: ' + stderr.slice(0, 400));
  const reply = await (await fetch(`http://127.0.0.1:${port}/chat/api/choices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Did you like it?' }) })).json();
  assert.deepEqual(reply.choices.map(choice => choice.say), ['Yes', 'No', "I'm not sure", 'Please say that again']);
});

test('the payload ships the vocabulary with the Chat page', () => {
  const payload = fs.readFileSync(new URL('../tools/build-payload.sh', import.meta.url), 'utf8');
  assert.ok(payload.includes('cp -r "$HUB/public/chat" "$OUT/public/chat"'));
  assert.match(payload, /public\/chat\/vocabulary\.json/, 'the payload refuses a tree without the vocabulary');
});

test('shortcut food, drink, place and person tiles get their own concept, else the category concept, never a part-word match', () => {
  const pick = label => pictures.pickSymbol({ label, say: label });
  for (const [label, word] of [['Spaghetti', 'pasta'], ['Chicken', 'chicken'], ['Meatballs', 'meat'], ['Beef', 'meat'],
    ['Wine', 'wine'], ['Sushi', 'sushi'], ['Mushrooms', 'mushrooms'], ['Juice', 'juice'], ['Water', 'water'],
    ['Chicken and rice', 'food'], ['Beef and mushrooms', 'food'], ['Juice and milk', 'drink'],
    ['Park', 'park'], ['Library', 'library'], ['Stay inside', 'home'], ['Go outside', 'outside'],
    ['Mom', 'mom'], ['Dad', 'dad'], ['The teacher', 'teacher']])
    assert.equal(pick(label), word, label);
  // Never a partial-word or prefix match: "Meatballs" is not "me", "Carpet" is not "car".
  for (const label of ['Carpet', 'Mondays meeting room', 'Pineapple tart']) assert.notEqual(pick(label), label.toLowerCase().slice(0, 3), label);
  // The library knows the whole word (the lexicon layer, spec §6): the carpet, never the car.
  assert.equal(pick('Carpet'), 'carpet');
});

test('a model symbol from another concept family than the food label is rejected for the category picture (recorded batch)', () => {
  // The device's recorded choice set: the model named "monday" for a dish.
  const recorded = [{ label: 'Chicken and rice', say: 'Chicken and rice, please.', symbol: 'chicken' },
    { label: 'Meatballs', say: 'Meatballs, please.', symbol: 'meat' },
    { label: 'Beef mushrooms', say: 'Beef and mushrooms, please.', symbol: 'monday' }];
  const placed = pictures.withSymbols(recorded);
  assert.deepEqual(placed.map(choice => choice.symbol), ['chicken', 'meat', 'food']);
  assert.equal(placed[2].symbolId, byWord.get('food').id);
  assert.deepEqual(recorded.map(pictures.symbolRejected), [false, false, true]);
  // Weather and time pictures never stand for a food or drink; other families and the same family stay the model's.
  assert.equal(pictures.pickSymbol({ label: 'Wine', say: 'Wine, please.', symbol: 'sunny' }), 'wine', 'the library\'s own picture of the word, never the weather');
  assert.equal(pictures.pickSymbol({ label: 'Pizza', say: 'Pizza, please.', symbol: 'tomorrow' }), 'pizza');
  assert.equal(pictures.pickSymbol({ label: 'Pizza', say: 'Pizza, please.', symbol: 'yummy' }), 'pizza', 'the label\'s own curated thing beats the model\'s word');
  assert.equal(pictures.pickSymbol({ label: 'Wine', say: 'Wine, please.', symbol: 'drink' }), 'wine');
  assert.equal(pictures.pickSymbol({ label: 'Go to the park', say: 'Let us go to the park.', symbol: 'friday' }), 'park');
  assert.equal(pictures.pickSymbol({ label: 'Saturday', say: 'On Saturday.', symbol: 'saturday' }), 'saturday');
  assert.equal(pictures.symbolRejected({ label: 'Saturday', say: 'On Saturday.', symbol: 'saturday' }), false);
  // Negation still wins over the category.
  assert.equal(pictures.pickSymbol({ label: 'No beef', say: 'No beef, thanks.', symbol: 'monday' }), 'no');
});

test('the hub counts rejected model symbols for test mode and the prompt says the symbol names the thing in the label', async t => {
  let instructions;
  const recorded = { choices: [{ label: 'Chicken and rice', say: 'Chicken and rice, please.', symbol: 'chicken' },
    { label: 'Meatballs', say: 'Meatballs, please.', symbol: 'meat' }, { label: 'Beef mushrooms', say: 'Beef and mushrooms, please.', symbol: 'monday' }] };
  const api = createChatApi({ env, fetch: async (_, options) => { ({ instructions } = JSON.parse(options.body)); return response(recorded); } });
  const server = http.createServer((req, res) => { if (!api.handle(req, res)) res.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  t.after(async () => { api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const result = await (await fetch(`http://localhost:${server.address().port}/chat/api/choices`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'What would you like for dinner tonight, my love?' }) })).json();
  assert.deepEqual(result.choices.map(choice => choice.symbol), ['chicken', 'meat', 'food']);
  assert.ok(result.choices.every(choice => choice.symbolId !== 37730), 'never the weekday picture');
  assert.equal(result.symbolRejected, 1);
  assert.match(instructions, /the symbol must name the thing in the label; a dish or food uses its food word or "food"/i);
});
