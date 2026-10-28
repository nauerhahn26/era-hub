#!/usr/bin/env node
// chat-lexicon-build.mjs — rebuild public/chat/lexicon.json, Chat's word → id
// index of the pictogram library (spec 2026-10-27 §6, "Lexicon").
//
// The library publishes its whole English keyword list (one JSON array, about
// 7.6 MB). This keeps only what the hub's picture pick needs: each lowercased
// keyword and plural form of a thing (common nouns and names, never pronouns
// or place names) → the best pictogram id for it (`words`); each lowercased
// keyword of an action, quality or social phrase (verbs, descriptive, social
// and miscellaneous words: "wait", "later", "hello", "I do not know") → its
// best id (`actions`), with a verb's simple -s and -ing forms where no real
// keyword holds them; plus a coarse family
// per id (food, drink, weather, time, place, person) for the picture guard.
// Words and numbers only: the artwork never enters the repository (licence;
// docs/specs/2026-09-30-drawing-design.md). Pictures flagged sexual or violent
// are dropped. When several pictures share a word, the library's core AAC
// entry wins, then one in a "core vocabulary" category, then the entry whose
// first keyword it is, then one with a family (the dish over the fungus for
// "mushrooms"), then the oldest id.
//
//   node tools/chat-lexicon-build.mjs [--out public/chat/lexicon.json]
//
// The list comes from ERA_SYMBOL_INDEX_URL, else the host of
// ERA_SYMBOL_SEARCH_URL (the hub's /symbol seam), else the library's API.
// The written file is refused over BUDGET_BYTES.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUDGET_BYTES = 1000 * 1024;
const DEFAULT_SEARCH = 'https://api.arasaac.org/api/pictograms/en/bestsearch/';
const INDEX_PATH = '/api/pictograms/all/en';
// Keyword types in the list: 1 proper name, 2 common noun (the things), then
// 3 verb, 4 descriptive, 5 social, 6 miscellaneous (the actions: the picture
// for a reply that names no thing, "Wait", "Later", "Give me a clue").
const THING_TYPES = new Set([1, 2]);
const ACTION_TYPES = new Set([3, 4, 5, 6]);
const VERB = 3;
const DROP_CATEGORIES = /^(?:country|city|province|region|continent|spain province|spain region|aragon|saragossa|huesca|teruel|pronoun|personal pronoun|possessive pronoun|possessive adjective|demonstrative pronoun|demonstrative adjective|indefinite pronoun|indefinite adjective|interrogative pronoun|article|preposition|conjunction|letter|alphabet|sexual practice|sexual crime|drug addiction|gender violence|contraceptive method)$/;
const DROP_TAGS = new Set(['political geography', 'flag', 'country']);
// First match wins: a beverage is a drink before it is food.
const FAMILY_TAGS = [
  ['drink', ['beverage']],
  ['food', ['food', 'gastronomy']],
  ['weather', ['meteorology', 'atmospheric phenomena']],
  ['time', ['time', 'calendar', 'unit of time', 'day hours']],
  ['person', ['person', 'family', 'professional']],
  ['place', ['place', 'building', 'room']],
];

// The hub's own folding of a label (chat-symbols.js normal()), with accents dropped.
export function fold(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/['’]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function indexUrl(env = process.env) {
  if (env.ERA_SYMBOL_INDEX_URL) return env.ERA_SYMBOL_INDEX_URL;
  return new URL(env.ERA_SYMBOL_SEARCH_URL || DEFAULT_SEARCH).origin + INDEX_PATH;
}

function familyOf(entry) {
  const tags = new Set([...(entry.tags || []), ...(entry.categories || [])].map(tag => String(tag).toLowerCase()));
  return FAMILY_TAGS.find(([, names]) => names.some(name => tags.has(name)))?.[0] || null;
}
function dropped(entry) {
  if (!entry || !Number.isSafeInteger(entry._id) || entry._id <= 0) return true;
  if (entry.sex || entry.violence) return true;
  if (!Array.isArray(entry.keywords) || !entry.keywords.length) return true;
  if ((entry.categories || []).some(category => DROP_CATEGORIES.test(String(category).toLowerCase()))) return true;
  return (entry.tags || []).some(tag => DROP_TAGS.has(String(tag).toLowerCase()));
}

// A verb's simple -s and -ing forms ("waits", "waiting", "makes", "making").
export function verbForms(form) {
  if (!/^[a-z]{2,}$/.test(form)) return [];
  const s = /(?:s|sh|ch|x|z|o)$/.test(form) ? form + 'es' : /[^aeiou]y$/.test(form) ? form.slice(0, -1) + 'ies' : form + 's';
  const ing = /ie$/.test(form) ? form.slice(0, -2) + 'ying' : /[^aeio]e$/.test(form) ? form.slice(0, -1) + 'ing' : form + 'ing';
  return [s, ing];
}

export function buildLexicon(entries, { source = '', built = '' } = {}) {
  const things = new Map(), actions = new Map(), inflected = new Map();   // form → { id, score, family }
  const offer = (map, form, id, score, family) => {
    if (form.length < 2 || form.length > 40 || form.split(' ').length > 4) return;
    const held = map.get(form);
    if (!held || score > held.score || (score === held.score && id < held.id)) map.set(form, { id, score, family });
  };
  for (const entry of entries) {
    if (dropped(entry)) continue;
    const core = (entry.categories || []).some(category => /^core vocabulary/i.test(category));
    const family = familyOf(entry);
    entry.keywords.forEach((keyword, index) => {
      if (!keyword) return;
      const score = (entry.aac ? 8 : 0) + (core ? 4 : 0) + (index === 0 ? 2 : 0) + (family ? 1 : 0);
      if (THING_TYPES.has(keyword.type)) {
        for (const raw of [keyword.keyword, keyword.plural]) offer(things, fold(raw), entry._id, score, family);
      } else if (ACTION_TYPES.has(keyword.type)) {
        const form = fold(keyword.keyword);
        offer(actions, form, entry._id, score, family);
        if (keyword.type === VERB) for (const extra of verbForms(form)) offer(inflected, extra, entry._id, score, family);
      }
    });
  }
  // An inflected form never displaces a real keyword of either kind.
  for (const [form, held] of inflected) if (!actions.has(form) && !things.has(form)) actions.set(form, held);
  const sorted = map => { const out = {}; for (const form of [...map.keys()].sort()) out[form] = map.get(form).id; return out; };
  const words = sorted(things), actionWords = sorted(actions), families = {};
  const familyById = new Map([...things.values(), ...actions.values()].map(({ id, family }) => [id, family]));
  for (const [family] of FAMILY_TAGS) {
    const ids = [...familyById].filter(([, value]) => value === family).map(([id]) => id).sort((a, b) => a - b);
    if (ids.length) families[family] = ids;
  }
  return { version: 2,
    note: 'Chat lexicon: words and pictogram ids only, data about the library, never its images. Built by tools/chat-lexicon-build.mjs from the library\'s English keyword list; images are fetched by the hub at runtime (GET /symbol/<id>). Spec docs/specs/2026-10-27-real-time-chat-design.md section 6.',
    source, built, count: Object.keys(words).length, actionCount: Object.keys(actionWords).length, families, words, actions: actionWords };
}

export function serializeLexicon(lexicon, { budget = BUDGET_BYTES } = {}) {
  const text = JSON.stringify(lexicon) + '\n';
  const bytes = Buffer.byteLength(text);
  if (bytes > budget) throw new Error(`lexicon is ${bytes} bytes, over the ${budget}-byte budget`);
  return text;
}

export async function build({ env = process.env, out, fetch: fetcher = globalThis.fetch, now = new Date() } = {}) {
  const url = indexUrl(env);
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`keyword list: HTTP ${response.status} from ${url}`);
  const entries = await response.json();
  if (!Array.isArray(entries) || !entries.length) throw new Error('keyword list has no entries');
  const lexicon = buildLexicon(entries, { source: url, built: now.toISOString().slice(0, 10) });
  if (!lexicon.count) throw new Error('keyword list has no entries with a usable keyword');
  const text = serializeLexicon(lexicon);
  fs.writeFileSync(out, text);
  return { bytes: Buffer.byteLength(text), words: lexicon.count, actions: lexicon.actionCount, entries: entries.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out');
  const out = at > 0 ? process.argv[at + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'chat', 'lexicon.json');
  build({ out }).then(result => console.log(`lexicon: ${result.words} things and ${result.actions} actions from ${result.entries} pictures, ${result.bytes} bytes → ${out}`),
    error => { console.error('lexicon: ' + error.message); process.exit(1); });
}
