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
// The lexicon (spec §6, "Lexicon"): the library's own word → id index for the
// things the curated table lacks ("lasagna", "tacos"). Read on first use; an
// install without public/chat/lexicon.json warns once and keeps the table's
// pictures. Families (food, drink, weather, time, place, person) feed the guard.
let lexiconTable = null;
function compileLexicon(data) {
  const map = key => {
    const out = new Map();
    for (const [word, id] of Object.entries(data && typeof data[key] === 'object' && data[key] || {}))
      if (Number.isSafeInteger(id) && id > 0 && normal(word) === word) out.set(word, id);
    return out;
  };
  const words = map('words'), actions = map('actions');
  const family = new Map();
  for (const [name, ids] of Object.entries(data && typeof data.families === 'object' && data.families || {}))
    if (Array.isArray(ids)) for (const id of ids) family.set(id, name);
  return { words, actions, family };
}
function lexicon() {
  if (lexiconTable) return lexiconTable;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'chat', 'lexicon.json'), 'utf8'));
    if (!data || !data.words || typeof data.words !== 'object') throw new Error('unexpected shape');
  } catch (error) {
    console.error('[chat] picture lexicon unavailable (' + (error.code || error.message) + '): replies use the vocabulary pictures only until public/chat/lexicon.json is restored');
    data = null;
  }
  lexiconTable = compileLexicon(data);
  return lexiconTable;
}
// Tools and tests may load another table; null reads the shipped file again.
function setLexicon(data) { lexiconTable = data ? compileLexicon(data) : null; }
// One form of the label in the lexicon, then its singular ("tacos" → "taco").
function lexiconForm(form) {
  if (!form) return null;
  const { words, family } = lexicon();
  const forms = [form];
  if (/ies$/.test(form)) forms.push(form.replace(/ies$/, 'y'));
  if (/(?:ches|shes|xes|ses|zes|oes)$/.test(form)) forms.push(form.replace(/es$/, ''));
  if (/[^s]s$/.test(form)) forms.push(form.replace(/s$/, ''));
  for (const candidate of forms) {
    const id = words.get(candidate);
    if (id) return { word: candidate, id, family: family.get(id) || null };
  }
  return null;
}
// One form in the actions map, then its plain verb ("clapping" → clap,
// "learned" → learn, "tries" → try).
function actionForm(form) {
  if (!form) return null;
  const { actions, family } = lexicon();
  const forms = [form];
  if (/^[a-z]+$/.test(form)) {
    const stem = form.replace(/(?:ing|ed)$/, '');
    if (stem !== form && stem.length >= 2) {
      forms.push(stem, stem + 'e');
      if (/([^aeiou])\1$/.test(stem)) forms.push(stem.slice(0, -1));
    }
    if (/ied$|ies$/.test(form)) forms.push(form.slice(0, -3) + 'y');
    if (/[^s]s$/.test(form)) forms.push(form.slice(0, -1));
  }
  for (const candidate of forms) {
    const id = actions.get(candidate);
    if (id) return { word: candidate, id, family: family.get(id) || null };
  }
  return null;
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
function exactHit(text) {
  const { patterns } = vocabulary(), bare = text.replace(/^(?:a|an|the|some)\s+/, '');
  return patterns.find(([, , form]) => form === bare || form + 's' === bare || form + 'es' === bare) || null;
}
function exact(text) { return exactHit(text)?.[1] || null; }
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
// ---- the lexicon layer ----------------------------------------------------
// Words that never name the thing on a tile: articles, pronouns, helpers,
// prepositions, politeness, time words and the broad words.
const STOP = new Set(['a', 'an', 'the', 'some', 'any', 'more', 'another', 'lots', 'lot', 'bit', 'of',
  'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'we', 'us', 'our', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their',
  'this', 'that', 'these', 'those', 'im', 'youre', 'theyre', 'ive', 'weve', 'lets', 'let', 'thats', 'whats', 'theres', 'heres',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'have', 'has', 'had', 'can', 'could', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'wanna', 'gonna', 'dont', 'doesnt', 'didnt', 'cant', 'wont', 'isnt', 'arent',
  'want', 'like', 'love', 'need', 'eat', 'drink', 'play', 'go', 'get', 'make', 'see', 'watch', 'read', 'ride', 'visit', 'buy', 'find',
  'choose', 'sing', 'wash', 'try', 'cook', 'bake', 'build', 'draw', 'take', 'give', 'bring', 'put', 'look', 'listen', 'pick', 'prefer', 'rather',
  'to', 'with', 'for', 'at', 'in', 'on', 'from', 'after', 'before', 'by', 'about', 'into', 'onto', 'over', 'under', 'up', 'down', 'out', 'off',
  'and', 'or', 'but', 'so', 'then', 'than', 'too', 'also', 'not', 'no', 'yes', 'please', 'thanks', 'thank',
  'now', 'today', 'tonight', 'tomorrow', 'yesterday', 'later', 'soon', 'first', 'next', 'again',
  'what', 'which', 'who', 'where', 'when', 'why', 'how', 'something', 'anything', 'nothing', 'thing', 'things', 'one', 'ones',
  'very', 'really', 'just', 'maybe', 'ok', 'okay', 'either', 'both',
  // placeholders that name no thing: "My choice" says nothing a picture can show
  'choice', 'idea', 'turn', 'answer', 'favorite', 'favourite', 'way', 'stuff', 'kind', 'sort', 'type', 'option', 'plan',
  'question', 'thought', 'guess', 'mind', 'word', 'words', 'bit', 'same', 'different', 'other', 'else', ...BROAD]);
const GUARDED = new Set(['time', 'weather']);
// Curated concepts filed as stand-ins ("sushi" under food for want of a
// picture) yield to the library's own picture of the word.
const STAND_INS = new Set(['food', 'drink']);
const words = text => text ? text.split(' ').filter(Boolean) : [];
// The thing a label names: after "of" ("a slice of lasagna"), past the leading
// helpers and verbs ("play with", "eat"), up to the next helper ("for dinner").
function headPhrase(text) {
  let list = words(text);
  const of = list.lastIndexOf('of');
  if (of >= 0 && of < list.length - 1) list = list.slice(of + 1);
  let from = 0;
  while (from < list.length && STOP.has(list[from])) from++;
  list = list.slice(from);
  const cut = list.findIndex((word, index) => index > 0 && STOP.has(word));
  return (cut > 0 ? list.slice(0, cut) : list).join(' ');
}
// Curated concepts in the text, each with the form that named it.
function formsIn(text) {
  const found = [];
  if (!text) return found;
  let rest = ` ${text} `;
  for (const [pattern, word, form] of vocabulary().patterns) {
    if (!pattern.test(rest)) continue;
    found.push({ word, standIn: STAND_INS.has(word) && form !== word });
    rest = rest.replace(pattern, ' ');
  }
  return found;
}
const curatedIn = text => formsIn(text).filter(hit => !hit.standIn).map(hit => hit.word);
// The library's picture for a label with no curated thing at its head: the
// whole label, the head phrase, its last word, then (only when no curated
// thing is named anywhere) each other word, never a time or weather word.
// A time or weather picture never stands for a food or drink label.
function lexiconPick(text, { anyWord = false, foodLabel = false } = {}) {
  const head = headPhrase(text);
  const whole = text.replace(/^(?:(?:a|an|the|some|my|your|our)\s+)+/, '').replace(/\s+(?:please|thanks|thank you)$/, '');
  const fits = hit => hit && !(foodLabel && GUARDED.has(hit.family));
  for (const form of [whole, head, words(head).at(-1)]) {
    if (!form || words(form).every(word => STOP.has(word))) continue;
    const hit = lexiconForm(form);
    if (fits(hit)) return hit;
  }
  if (!anyWord) return null;
  for (const word of words(text)) {
    if (STOP.has(word)) continue;
    const hit = lexiconForm(word);
    if (hit && !GUARDED.has(hit.family)) return hit;
  }
  return null;
}
// One part of a coordinated label: its curated concept or its library picture.
function thingOf(part) {
  const own = curatedIn(part).filter(word => !BROAD.has(word));
  if (own.length === 1) return { family: FAMILY.get(own[0]) || null, lexical: false };
  if (own.length > 1) return null;
  const hit = lexiconPick(part);
  return hit ? { family: hit.family, lexical: true } : null;
}
// Several things in one label ("Lasagna and salad") show their family's
// picture; an either/or of two things shows the bubble. Only labels that need
// the lexicon take this path; the rest keep the curated category rule.
function coordinated(label, l) {
  if (!/\b(?:and|or)\b|,|&|\+/.test(label)) return null;
  const either = /\bor\b/.test(l);
  const parts = String(label).split(/\s*(?:,|&|\+|\band\b|\bor\b|\bplus\b)\s*/i).map(normal).filter(Boolean);
  if (parts.length < 2) return null;
  const things = parts.map(thingOf);
  if (!things.some(thing => thing && thing.lexical)) return null;
  let known = things.filter(Boolean);
  if (known.length < 2) return null;
  if (either) return { word: FALLBACK };
  const families = new Set(known.map(thing => thing.family));
  if (families.has('food') || families.has('drink')) known = known.filter(thing => !GUARDED.has(thing.family));
  const left = new Set(known.map(thing => thing.family));
  if (left.size && [...left].every(family => family === 'food' || family === 'drink')) return { word: left.has('food') ? 'food' : 'drink' };
  if (left.size === 1 && left.has('person')) return { word: GENERIC.person };
  return { word: FALLBACK };
}
function lexiconChoice(label, l) {
  const named = exactHit(l);
  if (!l || (named && !(STAND_INS.has(named[1]) && named[2] !== named[1]))) return null;
  const whole = words(l).every(word => STOP.has(word)) ? null : lexiconForm(l);
  if (whole && formsIn(l).every(hit => hit.standIn)) return whole;
  const several = coordinated(label, l);
  if (several) return several;
  if (/\b(?:and|or)\b/.test(l)) return null;
  const head = headPhrase(l);
  if (formsIn(head).some(hit => !hit.standIn) || (!head && curatedIn(l).length)) return null;
  const foodLabel = !!category(l) && [...category(l).families].some(family => family === 'food' || family === 'drink');
  return lexiconPick(l, { anyWord: !curatedIn(l).some(word => !BROAD.has(word)), foodLabel });
}
// ---- the actions layer ---------------------------------------------------
// Words that are never the picture of a reply, even when nothing concrete is
// named: articles, pronouns, helpers, prepositions, joining and polite words.
// Unlike STOP, verbs, time words and qualities stay: "Hurry up" is hurry,
// "Maybe later" is later.
const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'some', 'any', 'of', 'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'we', 'us', 'our',
  'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their', 'this', 'that', 'these', 'those', 'im', 'youre', 'ive', 'lets',
  'let', 'thats', 'whats', 'theres', 'heres', 'am', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'have', 'has', 'had',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'wanna', 'gonna', 'keep', 'to', 'with', 'for', 'at', 'in',
  'on', 'from', 'by', 'about', 'into', 'onto', 'up', 'down', 'out', 'off', 'around', 'and', 'or', 'but', 'so', 'then', 'than', 'too',
  'also', 'not', 'no', 'yes', 'please', 'thanks', 'thank', 'what', 'which', 'who', 'where', 'when', 'why', 'how', 'something',
  'anything', 'nothing', 'thing', 'things', 'one', 'ones', 'very', 'really', 'just', 'maybe', 'ok', 'okay',
  // hedges, not qualities: "Kind of", "Pretty good"
  'kind', 'kinda', 'sort', 'sorta', 'pretty', 'quite', 'bit']);
// The library's picture of what a reply does or is, when it names no thing:
// the whole label, then its head verb, then each other content word in order.
function actionPick(text, { foodLabel = false } = {}) {
  if (!text) return null;
  const fits = hit => hit && !(foodLabel && GUARDED.has(hit.family));
  const whole = text.replace(/^(?:(?:a|an|the|some|my|your|our)\s+)+/, '').replace(/\s+(?:please|thanks|thank you)$/, '');
  if (words(whole).length > 1) { const hit = actionForm(whole); if (fits(hit)) return hit; }
  for (const word of words(whole)) {
    if (FUNCTION_WORDS.has(word)) continue;
    const hit = actionForm(word);
    if (fits(hit)) return hit;
  }
  return null;
}
// A label offering several concrete things, or an either/or, keeps the bubble.
function ambiguous(l) { return /\bor\b/.test(l) || conceptsIn(l).filter(word => !BROAD.has(word)).length > 1; }
function foodish(l) { const labelled = category(l); return !!labelled && [...labelled.families].some(family => family === 'food' || family === 'drink'); }

// The model's picture words ("magnifying glass", "shrug", "clock"): the whole
// words, then each word from the last, through the curated table, the things,
// then the actions. A picture of another known family than the label's own
// (a clock or the weather for a dish) is refused, as `rejects` refuses a symbol.
function picturePick(picture, l) {
  const named = normal(picture);
  if (!named || named.length > 32 || words(named).length > 3) return null;
  const labelled = category(l);
  const forms = [named, ...words(named).reverse()].filter((form, index, all) => all.indexOf(form) === index && !FUNCTION_WORDS.has(form));
  for (const form of forms) {
    const curatedWord = exactHit(form)?.[1];
    const hit = curatedWord && curatedWord !== FALLBACK && !STAND_INS.has(curatedWord) ? { word: curatedWord, family: FAMILY.get(curatedWord) || null }
      : lexiconForm(form) || actionForm(form);
    if (!hit) continue;
    if (labelled && hit.family && !labelled.families.has(hit.family)) continue;
    return hit;
  }
  return null;
}
const guardedPick = (l, s, hit) => { const word = negationGuard(l, s, hit.word); return word === hit.word ? hit : { word }; };

// ---- the family's own people (the Drawing feature's library) ---------------
// The hub hands over a provider (server.js: drawings.charactersLibrary().people),
// asked once per batch of choices, never at require time. A tile that is one
// of them (their word, or a kin word for theirs: "Mommy" for "Mom", with an
// optional leading "my" or "with") shows their own picture.
let peopleProvider = null;
function setPeople(fn) { peopleProvider = typeof fn === 'function' ? fn : null; }
const PERSON_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
function currentPeople() {
  if (!peopleProvider) return [];
  let list;
  try { list = peopleProvider(); } catch { return []; }
  return Array.isArray(list) ? list.filter(p => p && typeof p.slug === 'string' && PERSON_SLUG.test(p.slug) && typeof p.word === 'string'
    && p.word.length <= 40 && !/[<>\x00-\x1f]/.test(p.word) && normal(p.word) && p.retired !== true) : [];
}
const KIN = [['mom', 'mum', 'mommy', 'mummy', 'mama', 'momma', 'mother'], ['dad', 'daddy', 'papa', 'dada', 'father'],
  ['grandma', 'granny', 'nana', 'gran', 'grandmother'], ['grandpa', 'grandad', 'granddad', 'grampa', 'gramps', 'grandfather'],
  ['sister', 'sis'], ['brother', 'bro'], ['baby'], ['friend'], ['teacher'], ['girl'], ['boy']];
const KIN_GROUP = new Map(KIN.flatMap((group, index) => group.map(word => [word, index])));
function personFor(text, people) {
  const bare = text.replace(/^(?:with\s+)?(?:my\s+)?/, '');
  if (!bare || !people.length) return null;
  const kin = KIN_GROUP.get(bare);
  const found = people.find(p => normal(p.word) === bare) || (kin !== undefined && people.find(p => KIN_GROUP.get(normal(p.word)) === kin));
  return found ? { word: found.word, src: `/characters/${found.slug}.png`, kind: 'person' } : null;
}
// One-word replies that are never a name, though the library may lack them.
const NOT_NAMES = new Set(['sure', 'okay', 'ok', 'fine', 'maybe', 'perhaps', 'later', 'nothing', 'whatever', 'never', 'always',
  'sometimes', 'cool', 'great', 'awesome', 'yay', 'yep', 'yeah', 'yup', 'nope', 'nah', 'hmm', 'um', 'oops', 'wow', 'totally',
  'definitely', 'absolutely', 'probably', 'really', 'seriously', 'exactly', 'everything', 'everyone', 'nobody', 'somebody',
  'someone', 'anyone', 'neither', 'either', 'both', 'all', 'none', 'again', 'done', 'finished', 'ready', 'alright', 'thanks']);
// A capitalised single word that names nothing the hub knows is a name. Only
// with the library's whole index loaded: without it every dish would be a name.
const NAME_INDEX_MIN = 1000;
function unknownName(label, l) {
  if (lexicon().words.size < NAME_INDEX_MIN) return false;
  if (!/^[A-Z][a-z]{1,19}$/.test(String(label).trim()) || NOT_NAMES.has(l) || STOP.has(l) || FUNCTION_WORDS.has(l)) return false;
  if (KIN_GROUP.has(l) || exactHit(l) || lexiconForm(l) || actionForm(l)) return false;
  return true;
}

// The hub's pick: { word, id? }. A curated phrase, then the library's picture
// for a thing the table lacks, then the model's symbol, then the text guess.
function choose({ label = '', say = '', symbol, picture } = {}, people = currentPeople()) {
  const l = normal(label), s = normal(say);
  const known = personFor(l, people) || (!l || !conceptsIn(l).length && !lexiconForm(l) ? personFor(s, people) : null);
  if (known) return guardedPick(l, s, known);
  if (unknownName(label, l)) return { word: 'friend', name: true };
  // A curated phrase is reviewed for its own words; the other field is still guarded
  // ("I'm good" / "No thanks, I am good." is a refusal).
  if (curated(l)) return { word: NEGATION.test(l) ? curated(l) : negationGuard('', s, curated(l)) };
  if (curated(s)) return { word: NEGATION.test(s) ? curated(s) : negationGuard(l, '', curated(s)) };
  const lexical = lexiconChoice(label, l);
  if (lexical) return guardedPick(l, s, lexical);
  const model = modelSymbol(symbol);
  if (model && model !== FALLBACK && !rejects(l, model)) return { word: negationGuard(l, s, model) };
  // The label's own curated word or category, then the model's picture words,
  // then the text guess, then the label's action or quality, else the bubble.
  const labelled = exact(l) || category(l)?.word;
  if (labelled && labelled !== FALLBACK) return { word: negationGuard(l, s, labelled) };
  const named = picturePick(picture, l);
  if (named) return guardedPick(l, s, named);
  const guessed = labelled || guess(l) || guess(s);
  if (guessed && guessed !== FALLBACK) return { word: negationGuard(l, s, guessed) };
  if (!ambiguous(l)) {
    const action = actionPick(l, { foodLabel: foodish(l) }) || (!guessed ? actionPick(s, { foodLabel: foodish(l) }) : null);
    if (action) return guardedPick(l, s, action);
  }
  return { word: negationGuard(l, s, FALLBACK) };
}
function pickSymbol(choice = {}) { return choose(choice).word; }
// True when the model named a picture the hub refused for the label's own
// (test mode counts these; the words are never changed).
function symbolRejected({ label = '', say = '', symbol } = {}) {
  const l = normal(label), s = normal(say), model = modelSymbol(symbol);
  return !!model && !curated(l) && !curated(s) && rejects(l, model);
}
function withSymbols(choices) {
  const people = currentPeople();
  let names = 0;
  return choices.map(choice => {
    const pick = choose(choice, people);
    // Two unknown names never share a picture: the first is a friend, the next people.
    if (pick.name && names++) pick.word = GENERIC.person;
    // The model's picture words are an input of the pick, never sent on to the page.
    const { picture: _named, ...rest } = choice;
    if (pick.kind === 'person') return { ...rest, symbol: pick.word, picture: { src: pick.src, kind: 'person' } };
    const id = pick.id || vocabulary().byWord.get(pick.word)?.id;
    return { ...rest, symbol: pick.word, ...(id ? { symbolId: id } : {}) };
  });
}
// The things a partner names while still speaking, for warming their pictures
// (spec §6): what follows "or", "and" or a comma, and what follows want, like,
// eat, have, play with, go to. At most six, each with its picture id.
const TRIGGER = /\b(?:want(?: to)?|wanna|like|love|need|eat|have|play with|go to)\b/gi;
function pictureCandidates(text, max = 6) {
  const found = [], seen = new Set();
  if (typeof text !== 'string' || text.length > 2000) return found;
  const pieces = text.split(/([,.;!?]|\bor\b|\band\b)/i);
  let after = '';
  for (const piece of pieces) {
    if (found.length >= max) break;
    if (/^(?:[,.;!?]|or|and)$/i.test(piece.trim()) && piece.trim()) { after = piece.trim().toLowerCase(); continue; }
    let phrase = null;
    TRIGGER.lastIndex = 0;
    let match, last = null;
    while ((match = TRIGGER.exec(piece))) last = match;
    if (last) phrase = piece.slice(last.index + last[0].length);
    else if ([',', 'or', 'and'].includes(after)) phrase = piece;
    after = '';
    const head = phrase && headPhrase(normal(phrase));
    if (!head) continue;
    const pick = choose({ label: head }, []);
    const id = pick.id || vocabulary().byWord.get(pick.word)?.id;
    if (!id || pick.word === FALLBACK || seen.has(id)) continue;
    seen.add(id); found.push({ word: pick.word, id });
  }
  return found;
}
// Warming the pictures of one hold into the hub's cache, in the background:
// at most `perHold` fetches for what the partner says, deduplicated, `concurrent`
// at a time across the hub, each given up after `timeoutMs`. A staged choice's
// picture goes to the front and is not counted against the six. Adding never
// waits; nothing in the reply path awaits a fetch.
function createPictureWarmer({ isCached, fetchOne, perHold = 6, concurrent = 2, timeoutMs = 3000, queueCap = 24 } = {}) {
  const queue = [], pending = new Set();
  let active = 0;
  function pump() {
    while (active < concurrent && queue.length) {
      const id = queue.shift(), controller = new AbortController();
      active++;
      let timer;
      const limit = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, timeoutMs); timer.unref?.(); });
      Promise.race([Promise.resolve().then(() => fetchOne(id, { signal: controller.signal })), limit]).catch(() => false)
        .finally(() => { clearTimeout(timer); active--; pending.delete(id); pump(); });
    }
  }
  function enqueue(id, first) {
    let cached = false;
    try { cached = !!isCached(id); } catch { cached = false; }
    if (cached || pending.has(id)) return false;
    pending.add(id);
    if (first) queue.unshift(id); else queue.push(id);
    while (queue.length > queueCap) pending.delete(queue.pop());
    // Started on the next turn: the caller's event is already out.
    queueMicrotask(pump);
    return true;
  }
  return {
    hold() {
      const seen = new Set();
      let count = 0, spoken = 0;
      const valid = id => Number.isSafeInteger(id) && id > 0 && !seen.has(id);
      return {
        add(id) {
          if (!valid(id) || spoken >= perHold) return false;
          seen.add(id);
          if (!enqueue(id, false)) return false;
          spoken++; count++; return true;
        },
        stage(id) {
          if (!valid(id)) return false;
          seen.add(id);
          if (!enqueue(id, true)) return false;
          count++; return true;
        },
        get count() { return count; },
      };
    },
    get active() { return active; },
  };
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

module.exports = { symbolWords, pickSymbol, symbolRejected, withSymbols, vocabularyIds, createSymbolWarmer, normal,
  setLexicon, setPeople, pictureCandidates, createPictureWarmer };
