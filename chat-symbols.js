// Chat pictures on the hub (spec 2026-10-27 §6). The reply model picks one of
// the vocabulary's words; this module maps it to an approved pictogram id,
// refuses an affirmative or topic picture for a refusal or negation, and
// guesses from the words when the model gave none. Pictures are decorative:
// the words stay authoritative and nothing here changes a label or a say.
'use strict';
const VOCABULARY = require('./public/chat/vocabulary.json');

const ENUM_CAP = 400;   // structured-output enums stay well inside the services' limits
const FALLBACK = VOCABULARY.fallback || 'chat';
const concepts = VOCABULARY.concepts;
const byWord = new Map(concepts.map(concept => [concept.word, concept]));

function normal(value) {
  if (typeof value !== 'string' || value.length > 800 || /[<>\x00-\x1f]/.test(value)) return '';
  return value.normalize('NFKC').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const phrases = new Map(Object.entries(VOCABULARY.phrases).map(([phrase, word]) => [normal(phrase), word]));
// Every spoken form of a concept, normalised, longest first so "ice cream" beats "cream".
const forms = concepts.flatMap(concept => [concept.word, ...(concept.alt || [])].map(form => [normal(form), concept.word]))
  .filter(([form]) => form).sort((a, b) => b[0].length - a[0].length);
const patterns = forms.map(([form, word]) => [new RegExp(`\\b${form.replace(/ /g, '\\s+')}s?\\b`), word, form]);
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

function symbolWords() { return concepts.slice(0, ENUM_CAP).map(concept => concept.word); }
function isNegative(word) { return byWord.get(word)?.tone === 'negative'; }

function curated(text) { return text && phrases.has(text) ? phrases.get(text) : null; }
function guess(text) {
  if (!text) return null;
  const found = [];
  let rest = ` ${text} `;
  for (const [pattern, word] of patterns) {
    if (!pattern.test(rest)) continue;
    if (!found.includes(word)) found.push(word);
    rest = rest.replace(pattern, ' ');   // "ice cream" is not also "cream"
  }
  const concrete = found.filter(word => !BROAD.has(word));
  if (concrete.length === 1) return concrete[0];
  if (concrete.length > 1) return FALLBACK;
  return found.length === 1 ? found[0] : found.length ? FALLBACK : null;
}
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
  const picked = typeof symbol === 'string' && byWord.has(symbol) ? symbol : guess(l) || guess(s) || FALLBACK;
  return negationGuard(l, s, picked);
}
function withSymbols(choices) {
  return choices.map(choice => {
    const symbol = pickSymbol(choice);
    return { ...choice, symbol, symbolId: byWord.get(symbol).id };
  });
}
function vocabularyIds() {
  const ids = [];
  for (const concept of concepts) for (const id of [concept.id, concept.altId]) if (id && !ids.includes(String(id))) ids.push(String(id));
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

module.exports = { symbolWords, pickSymbol, withSymbols, vocabularyIds, createSymbolWarmer, normal };
