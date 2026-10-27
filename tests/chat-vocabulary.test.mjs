// Chat picture vocabulary (spec 2026-10-27 §6): concept words and approved
// pictogram ids only — the library's images never live in the repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const vocabulary = JSON.parse(fs.readFileSync(new URL('../public/chat/vocabulary.json', import.meta.url), 'utf8'));
const concepts = vocabulary.concepts;
const words = new Map(concepts.map(concept => [concept.word, concept]));

test('the table holds 300 to 600 concepts, each one lowercase word with one approved numeric pictogram id', () => {
  assert.ok(concepts.length >= 300 && concepts.length <= 600, `${concepts.length} concepts`);
  for (const concept of concepts) {
    assert.deepEqual(Object.keys(concept).filter(key => !['word', 'id', 'alt', 'altId', 'tone'].includes(key)), [], concept.word);
    assert.match(concept.word, /^[a-z][a-z' ]{0,23}$/, concept.word);
    assert.ok(Number.isSafeInteger(concept.id) && concept.id > 0, concept.word);
    if (concept.altId !== undefined) assert.ok(Number.isSafeInteger(concept.altId) && concept.altId !== concept.id, concept.word);
    if (concept.alt !== undefined) assert.ok(Array.isArray(concept.alt) && concept.alt.every(alt => /^[a-z][a-z' -]{0,30}$/.test(alt)), concept.word);
    if (concept.tone !== undefined) assert.equal(concept.tone, 'negative', concept.word);
  }
});

test('words, alternative words and pictogram ids are unique across the table', () => {
  const spoken = concepts.flatMap(concept => [concept.word, ...(concept.alt || [])]);
  assert.equal(new Set(spoken).size, spoken.length, spoken.filter((word, i) => spoken.indexOf(word) !== i).join(', '));
  const ids = concepts.map(concept => concept.id);
  assert.equal(new Set(ids).size, ids.length, 'one picture means one concept');
});

test('the core conversation, feeling, family-role, day and weather words are present', () => {
  for (const word of ['yes', 'no', "don't know", 'more', 'help', 'stop', 'again', 'wait', 'finished', 'not now', "don't like",
    'my turn', 'hello', 'bye', 'funny', 'tired', 'hungry', 'thirsty', 'happy', 'sad', 'scared', 'sick', 'hurt', 'love', 'play',
    'eat', 'drink', 'sleep', 'school', 'home', 'outside', 'book', 'music', 'video', 'draw', 'game', 'mom', 'dad', 'grandma',
    'grandpa', 'sister', 'brother', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'weather',
    'sunny', 'rain', 'snow', 'cold', 'hot', 'apple', 'pizza', 'park', 'beach', 'chat'])
    assert.ok(words.has(word), word);
  assert.equal(vocabulary.fallback, 'chat', '"chat" is the no-clear-picture concept');
});

test('every curated phrase names a concept in the table, covering the fixed Chat phrases and routes', () => {
  const phrases = Object.entries(vocabulary.phrases);
  assert.ok(phrases.length >= 46, `${phrases.length} curated phrases`);
  for (const [phrase, word] of phrases) {
    assert.match(phrase, /^[a-z][a-z ]*$/, 'phrases are stored normalised: ' + phrase);
    assert.ok(words.has(word), `${phrase} → ${word}`);
  }
  for (const phrase of ['hi', 'whats up', 'how are you', 'come sit with me', 'tell me more', 'reactions', 'my news', 'help me say it',
    'back to chat', 'thats funny', 'i love that', 'no way', 'thats not fair', 'give me more time', 'thats not what i meant',
    'ask me yes or no', 'let me try again', 'im not sure', 'please say that again', 'can i help you', 'i need a moment',
    'can you give me a clue', 'let me tell you another way', 'i dont want to answer now'])
    assert.ok(vocabulary.phrases[phrase], phrase);
});

test('refusals, negations and uncertainty are marked so no affirmative picture can stand in for them', () => {
  for (const word of ['no', "don't know", 'not sure', 'stop', 'not now', "don't like", 'chat'])
    assert.equal(words.get(word).tone, 'negative', word);
  for (const word of ['yes', 'like', 'love', 'happy', 'good', 'ok', 'fun', 'favourite'])
    assert.equal(words.get(word).tone, undefined, word);
  // "negative" marks pictures that ARE a refusal, negation or uncertainty; a
  // feeling such as sad is a topic, and "Not sad" must not show it.
  for (const word of ['sad', 'scared', 'tired', 'angry', 'sick', 'hurt', 'bad', 'yucky', 'cry'])
    assert.equal(words.get(word).tone, undefined, word);
});

test('the repository carries no pictogram images and no person names', () => {
  const chat = fs.readdirSync(new URL('../public/chat/', import.meta.url));
  assert.deepEqual(chat.filter(name => /\.(png|jpe?g|gif|webp)$/i.test(name)), []);
  // Vocabulary words are common nouns and verbs: a capital letter would be a name.
  assert.ok(!/[A-Z]/.test(JSON.stringify(concepts.map(concept => [concept.word, concept.alt]))));
  assert.ok(!/[A-Z]/.test(Object.keys(vocabulary.phrases).join(' ')));
});

test('the settings page carries the pictogram library credit its licence requires, beside the sticker credit', () => {
  const html = fs.readFileSync(new URL('../public/settings/index.html', import.meta.url), 'utf8');
  const card = /<div class="card" id="credits">([\s\S]*?)<\/div>/.exec(html)?.[1] || '';
  assert.match(card, /property of the Government of Arag(ó|&oacute;)n and have been created by Sergio Palao for ARASAAC/);
  assert.match(card, /https:\/\/arasaac\.org/);
  assert.match(card, /Creative Commons.*BY-NC-SA/);
  assert.match(card, /non-commercial/i);
  assert.match(card, /Fluent Emoji.*MIT/);
});
