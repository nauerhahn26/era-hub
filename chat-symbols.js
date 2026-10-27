// Chat pictures on the hub (spec 2026-10-27 §6). The reply model picks one of
// the vocabulary's words; this module maps it to an approved pictogram id,
// refuses an affirmative or topic picture for a refusal or negation, and
// guesses from the words when the model gave none. Pictures are decorative:
// the words stay authoritative and nothing here changes a label or a say.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ENUM_CAP = 400;   // structured-output enums stay well inside the services' limits
const FALLBACK = 'chat';

function normal(value) {
  if (typeof value !== 'string' || value.length > 800 || /[<>\x00-\x1f]/.test(value)) return '';
  return value.normalize('NFKC').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// The table is read on first use, never at require time: an install without
// public/chat/vocabulary.json (a partial copy, a damaged update) still boots,
// warns once, and every choice gets the bubble word with no picture id.
let table = null;
function vocabulary() {
  if (table) return table;
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'chat', 'vocabulary.json'), 'utf8'));
    if (!Array.isArray(data.concepts) || !data.phrases || typeof data.phrases !== 'object') throw new Error('unexpected shape');
  } catch (error) {
    console.error('[chat] picture vocabulary unavailable (' + (error.code || error.message) + '): replies get no pictures until public/chat/vocabulary.json is restored');
    data = { concepts: [], phrases: {} };
  }
  const concepts = data.concepts;
  // Every spoken form of a concept, normalised, longest first so "ice cream" beats "cream".
  const forms = concepts.flatMap(concept => [concept.word, ...(concept.alt || [])].map(form => [normal(form), concept.word]))
    .filter(([form]) => form).sort((a, b) => b[0].length - a[0].length);
  table = { concepts, byWord: new Map(concepts.map(concept => [concept.word, concept])),
    phrases: new Map(Object.entries(data.phrases).map(([phrase, word]) => [normal(phrase), word])),
    patterns: forms.map(([form, word]) => [new RegExp(`\\b${form.replace(/ /g, '\\s+')}s?\\b`), word, form]) };
  return table;
}
// Broad words never erase a clear subject: "I am happy to play music" is music.
const BROAD = new Set(['me', 'you', 'want', 'need', 'like', 'love', 'happy', 'sad', 'tired', 'good', 'fun', 'play', 'go', 'look',
  'more', 'now', 'today', 'time', 'day', 'friend', 'family', 'people', 'please', 'ok', 'make', 'give', 'tell', 'think', 'know',
  'same', 'come here', 'feelings', 'chat', 'again', 'yes', 'no',
  // verbs that take an object: "listen to music" is music, "eat pizza" is pizza
  'listen', 'watch', 'read', 'eat', 'drink', 'ride', 'visit', 'buy', 'find', 'choose', 'sing', 'see', 'wash']);

const NEGATION = /\b(?:no|nope|nah|not|never|dont|doesnt|didnt|isnt|arent|wasnt|werent|cant|cannot|couldnt|wont|wouldnt|shouldnt|havent|hasnt|hadnt|without|nothing|nobody|none|hate|hates|dislike|dislikes)\b/;
// "No music, thanks" refuses; "No, I love it" answers with a positive and is only negated.
const REFUSAL = /^(?:no|nope|nah)$|^no\s+(?!(?:i|im|we|you|it|its|thats|that|way|problem|worries)\b)(?:(?:a|an|the|any|more)\s+)?[a-z ]+?(?:\s+(?:please|thanks|thank you))?$|^no thanks?\b|^no thank you\b|\b(?:dont|do not)\s+(?:want|need|choose|prefer)\b/;
const DISLIKE = /\b(?:dont|do not|didnt|doesnt|wouldnt)\s+like\b|\b(?:hate|hates|dislike|dislikes)\b/;

function symbolWords() {
  const words = vocabulary().concepts.slice(0, ENUM_CAP).map(concept => concept.word);
  return words.includes(FALLBACK) ? words : [...words, FALLBACK];
}
function isNegative(word) { return word === FALLBACK || vocabulary().byWord.get(word)?.tone === 'negative'; }

// Concept families. A food, drink, place or person label takes a picture of its
// own family; a model picture from another known family (a weekday for a dish,
// the weather for a drink) is rejected for the label's own picture.
const FAMILIES = {
  food: ['food', 'breakfast', 'lunch', 'dinner', 'snack', 'fruit', 'apple', 'banana', 'orange', 'grapes', 'strawberry', 'watermelon',
    'blueberries', 'pear', 'vegetables', 'carrot', 'broccoli', 'corn', 'potato', 'salad', 'bread', 'toast', 'sandwich', 'pizza', 'pasta',
    'rice', 'soup', 'egg', 'pancake', 'cereal', 'cheese', 'yogurt', 'chicken', 'fish fingers', 'meat', 'hamburger', 'hot dog', 'fries',
    'crackers', 'cookie', 'cake', 'chocolate', 'candy', 'ice cream', 'popcorn', 'pretzel', 'avocado', 'hummus'],
  drink: ['drink', 'milk', 'juice', 'water', 'hot chocolate', 'tea'],
  place: ['school', 'home', 'outside', 'park', 'playground', 'beach', 'swimming pool', 'zoo', 'farm', 'library', 'shop', 'restaurant',
    'cinema', 'garden', 'bedroom', 'kitchen', 'bathroom', 'living room', 'classroom', 'hospital', 'church', 'synagogue', 'museum',
    'mountains', 'forest'],
  person: ['mom', 'dad', 'grandma', 'grandpa', 'sister', 'brother', 'baby', 'family', 'friend', 'teacher', 'doctor', 'boy', 'girl', 'people'],
  time: ['time', 'now', 'today', 'tomorrow', 'yesterday', 'weekend', 'morning', 'afternoon', 'night', 'day', 'week',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
  weather: ['weather', 'sunny', 'cloudy', 'rain', 'snow', 'windy', 'hot', 'cold', 'storm', 'umbrella', 'rainbow'],
};
const FAMILY = new Map(Object.entries(FAMILIES).flatMap(([family, words]) => words.map(word => [word, family])));
const CATEGORIES = new Set(['food', 'drink', 'place', 'person']);
// Several things of one family show the family's own picture: "Chicken and rice" is food.
const GENERIC = { food: 'food', drink: 'drink', person: 'people' };

function curated(text) { const { phrases } = vocabulary(); return text && phrases.has(text) ? phrases.get(text) : null; }
// Every concept named by whole words, never part of a word ("meatballs" is not "me").
function conceptsIn(text) {
  const found = [];
  if (!text) return found;
  let rest = ` ${text} `;
  for (const [pattern, word] of vocabulary().patterns) {
    if (!pattern.test(rest)) continue;
    if (!found.includes(word)) found.push(word);
    rest = rest.replace(pattern, ' ');   // "ice cream" is not also "cream"
  }
  return found;
}
function guess(text) {
  if (!text) return null;
  const found = conceptsIn(text);
  const concrete = found.filter(word => !BROAD.has(word));
  if (concrete.length === 1) return concrete[0];
  if (concrete.length > 1) return FALLBACK;
  return found.length === 1 ? found[0] : found.length ? FALLBACK : null;
}
// The whole label is one concept's word or alternative word ("Spaghetti", "The teacher").
function exact(text) {
  const { patterns } = vocabulary(), bare = text.replace(/^(?:a|an|the|some)\s+/, '');
  const hit = patterns.find(([, , form]) => form === bare || form + 's' === bare || form + 'es' === bare);
  return hit ? hit[1] : null;
}
// The label's food, drink, place or person category: every concrete thing it
// names is in those families. Returns the families named and the picture.
function category(text) {
  // "Wine" is the drink concept itself, broad elsewhere but a category here.
  const concrete = conceptsIn(text).filter(word => CATEGORIES.has(FAMILY.get(word)) || !BROAD.has(word));
  const families = new Set(concrete.map(word => FAMILY.get(word)));
  if (!concrete.length || ![...families].every(family => CATEGORIES.has(family))) return null;
  if (concrete.length === 1) return { families, word: concrete[0] };
  const main = families.has('food') ? 'food' : families.size === 1 ? [...families][0] : null;
  return { families, word: (families.size === 1 || main === 'food') && GENERIC[main] || FALLBACK };
}
function fromWords(l, s) { return exact(l) || category(l)?.word || guess(l) || guess(s) || FALLBACK; }
// A model picture from another known family than the label's category.
function rejects(l, symbol) {
  const family = FAMILY.get(symbol), labelled = family && category(l);
  return !!labelled && !labelled.families.has(family);
}
function modelSymbol(symbol) { return typeof symbol === 'string' && vocabulary().byWord.has(symbol) ? symbol : null; }
// A refusal or negated reply keeps only a picture that is itself a refusal,
// negation or uncertainty; otherwise "no" for a clear refusal, else the bubble.
function negationGuard(label, say, word) {
  const text = `${label} ${say}`.trim();
  if (!NEGATION.test(text) || isNegative(word)) return word;
  if (DISLIKE.test(text)) return "don't like";
  if (REFUSAL.test(label) || REFUSAL.test(say)) return 'no';
  return FALLBACK;
}
function pickSymbol({ label = '', say = '', symbol } = {}) {
  const l = normal(label), s = normal(say);
  // A curated phrase is reviewed for its own words; the other field is still guarded
  // ("I'm good" / "No thanks, I am good." is a refusal).
  if (curated(l)) return NEGATION.test(l) ? curated(l) : negationGuard('', s, curated(l));
  if (curated(s)) return NEGATION.test(s) ? curated(s) : negationGuard(l, '', curated(s));
  const model = modelSymbol(symbol);
  const picked = model && !rejects(l, model) ? model : fromWords(l, s);
  return negationGuard(l, s, picked);
}
// True when the model named a picture the hub refused for the label's own
// (test mode counts these; the words are never changed).
function symbolRejected({ label = '', say = '', symbol } = {}) {
  const l = normal(label), s = normal(say), model = modelSymbol(symbol);
  return !!model && !curated(l) && !curated(s) && rejects(l, model);
}
function withSymbols(choices) {
  return choices.map(choice => {
    const symbol = pickSymbol(choice), id = vocabulary().byWord.get(symbol)?.id;
    return { ...choice, symbol, ...(id ? { symbolId: id } : {}) };
  });
}
function vocabularyIds() {
  const ids = [];
  for (const concept of vocabulary().concepts) for (const id of [concept.id, concept.altId]) if (id && !ids.includes(String(id))) ids.push(String(id));
  return ids;
}

// One pass at a time over the pictures still missing from the cache: one
// request at a time, a pause between network fetches, and a stop after
// `maxFailures` failures in a row (offline, provider down) so a later pass
// resumes. Pictures already cached are never fetched again.
function createSymbolWarmer({ ids, isCached, fetchOne, delayMs = 250, maxFailures = 5, sleep } = {}) {
  const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms).unref?.()));
  let running = null;
  async function pass() {
    const result = { fetched: 0, cached: 0, failed: 0, remaining: 0, stopped: false };
    let streak = 0, first = true;
    for (const id of ids) {
      if (isCached(id)) { result.cached++; continue; }
      if (result.stopped) { result.remaining++; continue; }
      if (!first) await wait(delayMs);
      first = false;
      let ok = false;
      try { ok = !!(await fetchOne(id)); } catch { ok = false; }
      if (ok) { result.fetched++; streak = 0; continue; }
      result.failed++; result.remaining++; streak++;
      if (streak >= maxFailures) result.stopped = true;
    }
    return result;
  }
  return {
    run() {
      if (!running) running = pass().finally(() => { running = null; });
      return running;
    },
    get running() { return !!running; },
  };
}

module.exports = { symbolWords, pickSymbol, symbolRejected, withSymbols, vocabularyIds, createSymbolWarmer, normal };
