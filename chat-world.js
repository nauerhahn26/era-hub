// Her world (real-time chat plan, "Her world as context", dad 10/28): a compact
// plain-text digest of what this device already holds, the week packages the
// Drive mirror keeps under <DATA>/this-week/<week_of>/manifest.json, the
// weekly builder's world.json beside each (about her, the teachers' weekly
// lists, day notes; schema 1), the books
// on her shelf, her people and what she likes, newest first and labelled
// relative to today. It goes to the reply model with an open-ended question
// only, as known facts the model may state; the turn record keeps only its size.
//
// digest() is synchronous and cheap on the reply path: it looks at its sources
// at most once a minute and rebuilds only when a manifest's mtime, a provider's
// list or the day changed. Every source is optional: a missing or broken week
// folder, or a provider that throws, contributes nothing.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const CAP = 6000, DAYS_BACK = 10, RECENT_DAYS = 7, CHECK_MS = 60000, FULL_WEEKS = 4, BOOKS = 8, BOOKS_KEPT = 4, PEOPLE = 12, LIKES = 12, WORDS = 10, VIDEOS = 3, LINES = 6;
// Per-list caps, applied before the global cap so long lists never crowd out the days.
const ABOUT_CHARS = 320, ASKED = [8, 110], WORKED = [5, 90], MOMENTS = [3, 120], SAID = [2, 140];
const DAY_MS = 86400000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const AGO = ['This week', 'Last week', 'Two weeks ago', 'Three weeks ago'];

// One field on one line: no control characters, no angle brackets, and double
// quotes become single ones so a quoted title never breaks its line.
function field(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[<>]/g, '').replace(/["“”]/g, "'")
    .replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max).replace(/\s+\S*$/, '').trim() || text.slice(0, max) : text;
}
// A field cut to `max` characters at a sentence or clause boundary when one
// falls late enough, else at a word boundary; never mid-word (a single word
// longer than `max` is nothing).
function clip(value, max) {
  const text = field(value, 1000);
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  let cut = -1;
  for (const match of head.matchAll(/[.!?;:,](?=\s)/g)) if (match.index >= max / 4 && match.index < max) cut = match.index;
  const out = cut >= 0 ? head.slice(0, cut) : head.slice(0, head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : 0);
  return out.replace(/[\s.,;:!?-]+$/, '').trim();
}
// A date string's calendar day as UTC midnight milliseconds (null if unreadable).
function dayOf(value) {
  if (typeof value !== 'string') return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) { const t = Date.UTC(+iso[1], +iso[2] - 1, +iso[3]); return Number.isFinite(t) ? t : null; }
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
const monday = day => day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
const monthDay = day => `${MONTHS[new Date(day).getUTCMonth()]} ${new Date(day).getUTCDate()}`;
const subject = key => { const words = key.replace(/_/g, ' ').trim(); return words.charAt(0).toUpperCase() + words.slice(1); };
// A provider's list, or nothing: a missing provider, a throw or a non-list all cost only that line.
function listFrom(provider) {
  try { const list = provider?.(); return Array.isArray(list) ? list : []; } catch { return []; }
}

// Every week folder with a parsable manifest, newest first, read with the
// tolerance of this-week.js readWeek (a mid-write or broken manifest is
// skipped; a book's manifest is never a week), and every folder's world.json.
function readWeeks(dataDir) {
  const root = path.join(dataDir, 'this-week');
  let names;
  try { names = fs.readdirSync(root).filter(name => WEEK_RE.test(name)).sort().reverse(); } catch { return { weeks: [], worlds: [], stamp: [] }; }
  const weeks = [], worlds = [], stamp = [];
  const json = (name, file) => {
    const full = path.join(root, name, file);
    const st = fs.statSync(full);
    if (!st.isFile()) return undefined;
    stamp.push([name, file, st.mtimeMs, st.size]);
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  };
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  for (const name of names) {
    const day = dayOf(name);
    if (day === null) continue;
    try {
      const manifest = json(name, 'manifest.json');
      if (isObject(manifest) && !('pages' in manifest) && !('cover' in manifest)) weeks.push({ day, manifest });
    } catch { /* a broken week contributes nothing */ }
    try {
      const world = json(name, 'world.json');
      if (isObject(world) && (world.schema === undefined || world.schema === 1)) worlds.push(world);
    } catch { /* nor does a broken world.json */ }
  }
  return { weeks, worlds, stamp };
}

// A list of short strings from a world.json field; anything else is nothing.
const strings = (value, max, count) => (Array.isArray(value) ? value : []).map(item => clip(item, max)).filter(Boolean).slice(0, count);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const sentence = text => /[.!?]$/.test(text) ? text : text + '.';
// About her: whole sentences, in order, up to 320 characters in all.
function aboutOf(value) {
  const sentences = (Array.isArray(value) ? value : []).map(line => field(line, 1000)).filter(Boolean)
    .flatMap(line => line.split(/(?<=[.!?])\s+/)).map(text => sentence(text.trim())).filter(text => text.length > 1);
  const out = [];
  for (const text of sentences) {
    if ([...out, text].join(' ').length > ABOUT_CHARS) break;
    out.push(text);
  }
  if (!out.length && sentences.length) { const first = clip(sentences[0], ABOUT_CHARS - 1); if (first) out.push(sentence(first)); }
  return out;
}
// The world.json files merged, newest folder first: `about` from the newest
// file that has one, weeks by start and days by date (the newest file wins).
function mergeWorlds(worlds) {
  let about = [];
  const weeks = new Map(), days = new Map();
  for (const world of worlds) {
    if (!about.length) about = aboutOf(world.about);
    for (const week of Array.isArray(world.weeks) ? world.weeks : []) {
      if (!week || typeof week !== 'object' || typeof week.start !== 'string' || !ISO_DAY.test(week.start)) continue;
      const day = dayOf(week.start);
      if (day === null || weeks.has(day)) continue;
      weeks.set(day, { day, asked: strings(week.asked, ...ASKED.slice().reverse()), worked: strings(week.worked_on, ...WORKED.slice().reverse()) });
    }
    for (const item of Array.isArray(world.days) ? world.days : []) {
      if (!item || typeof item !== 'object' || typeof item.date !== 'string' || !ISO_DAY.test(item.date)) continue;
      const day = dayOf(item.date);
      if (day === null || days.has(day)) continue;
      days.set(day, { day, mood: clip(item.mood, 60), activities: strings(item.activities, 40, 10),
        moments: strings(item.moments, MOMENTS[1], MOMENTS[0]), said: strings(item.said, SAID[1], SAID[0]) });
    }
  }
  const newest = (a, b) => b.day - a.day;
  return { about, weeks: [...weeks.values()].sort(newest), days: [...days.values()].sort(newest) };
}

function weekParts(week, label) {
  const m = week.manifest, topic = m.topic && typeof m.topic === 'object' && !Array.isArray(m.topic) ? m.topic : {};
  const title = field(m.title, 80);
  const head = `${label} at school${title ? `: "${title}"` : ''}.`;
  const facts = [];
  for (const [key, value] of Object.entries(topic)) {
    const text = field(value, 120), name = key === 'hero' ? 'Hero of the week' : field(subject(key), 40);
    if (text && name) facts.push(`${name}: ${text}.`);
  }
  const words = (Array.isArray(m.talk) ? m.talk : []).map(item => field(item && item.word, 30)).filter(Boolean).slice(0, WORDS);
  if (words.length) facts.push(`Words: ${words.join(', ')}.`);
  const videos = (Array.isArray(m.watch) ? m.watch : []).map(item => field(item && item.title, 100)).filter(Boolean).slice(0, VIDEOS);
  return { head, facts, videos: videos.length ? `Videos: ${videos.join('; ')}.` : '' };
}

// A topic in a sentence: "Magnets" reads "magnets"; a topic with another
// capital after its first letter ("Abraham Lincoln", "The USA") reads as a
// name and stays as given.
const inSentence = text => /^[A-Z][^A-Z]*$/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
// This week's package as first-person lines for About me (stable frame §2):
// one per subject topic, the hero, the first video; at most six, the hero and
// the video always kept. Older weeks give nothing.
function weekLines(week) {
  if (!week) return [];
  const m = week.manifest, topic = m.topic && typeof m.topic === 'object' && !Array.isArray(m.topic) ? m.topic : {};
  const extras = [];
  const hero = field(topic.hero, 120);
  if (hero) extras.push(`Our hero is ${hero}`);
  const video = (Array.isArray(m.watch) ? m.watch : []).map(item => field(item && item.title, 100)).find(Boolean);
  if (video) extras.push(`We are watching ${video}`);
  const topics = Object.entries(topic).filter(([key]) => key !== 'hero').map(([, value]) => field(value, 120)).filter(Boolean)
    .map(text => `We are learning about ${inSentence(text)}`);
  return [...topics.slice(0, LINES - extras.length), ...extras];
}

function build({ weeks, worlds, books, people, likes, today }) {
  const thisMonday = monday(today);
  const ago = day => Math.round((thisMonday - monday(day)) / (7 * DAY_MS));
  const label = day => { const n = ago(day); return n >= 0 && n < AGO.length ? AGO[n] : `${monthDay(monday(day))} week`; };
  const bookLabel = day => { const n = ago(day); return n >= 0 && n < AGO.length ? AGO[n].toLowerCase() : `week of ${monthDay(monday(day))}`; };
  const dayLabel = day => {
    const back = Math.round((today - day) / DAY_MS), weekday = DAYS[new Date(day).getUTCDay()];
    if (back === 0) return 'Today';
    if (back === 1) return 'Yesterday';
    if (monday(day) === thisMonday) return weekday;
    if (monday(day) === thisMonday - 7 * DAY_MS) return 'Last ' + weekday;
    return monthDay(day);
  };
  const world = mergeWorlds(worlds);
  // The teachers' weekly lists: this week and last week in full, two weeks ago
  // its list alone, anything older (or not yet begun) left out.
  const worldWeeks = world.weeks.filter(week => ago(week.day) >= 0 && ago(week.day) <= 2)
    .map(week => ({ label: label(week.day), asked: week.asked, worked: ago(week.day) <= 1 ? week.worked : [], showWorked: true, twoBack: ago(week.day) === 2, show: true }));
  // Day notes from the last ten days, newest first; a day with nothing to say is no line.
  const dayLines = world.days.filter(day => today - day.day >= 0 && today - day.day < DAYS_BACK * DAY_MS).map(day => {
    const parts = [day.mood, day.activities.join(', '), day.moments.map(sentence).join(' ')].filter(Boolean);
    const said = day.said.length ? `She said on her device: ${day.said.map(sentence).join(' ')}` : '';
    if (!parts.length && !said) return null;
    return { back: Math.round((today - day.day) / DAY_MS), show: true,
      text: parts.length ? `${dayLabel(day.day)} at school: ${sentence(parts.join('; '))}${said ? ' ' + said : ''}` : `${dayLabel(day.day)}: ${said}` };
  }).filter(Boolean);
  const full = weeks.slice(0, FULL_WEEKS).map(week => ({ ...weekParts(week, label(week.day)), showVideos: true }));
  const earlier = weeks.slice(FULL_WEEKS).map(week => {
    const title = field(week.manifest.title, 80), hero = field(week.manifest.topic && week.manifest.topic.hero, 120);
    return `Earlier week (${monthDay(week.day)})${title ? `: "${title}"` : ''}${hero ? `${title ? ',' : ':'} hero ${hero}` : ''}.`;
  });
  // The shelf: newest week first, then newest published; a book without a week lists its title alone.
  const shelf = books.map(book => book && typeof book === 'object' ? { title: field(book.title, 80), day: dayOf(book.weekOf),
    published: Date.parse(book.publishedAt) || 0 } : null).filter(book => book && book.title)
    .sort((a, b) => (b.day ?? -Infinity) - (a.day ?? -Infinity) || b.published - a.published).slice(0, BOOKS)
    .map(book => `"${book.title}"${book.day === null ? '' : ` (${bookLabel(book.day)})`}`);
  const names = people.map(person => typeof person === 'string' ? person : person && !person.retired ? person.word || person.name : '')
    .map(name => field(name, 30)).filter(Boolean).slice(0, PEOPLE);
  const liked = likes.map(like => field(like, 30)).filter(Boolean).slice(0, LIKES);
  const d = new Date(today);
  const head = `Today: ${DAYS[d.getUTCDay()]}, ${monthDay(today)}.`;
  let fullCount = full.length, earlierCount = earlier.length, bookCount = shelf.length;
  // Lines with their kind, so the counts follow what the cap kept.
  const compose = () => {
    const lines = [{ kind: 'today', text: head }];
    if (world.about.length) lines.push({ kind: 'about', text: `About her: ${world.about.map(sentence).join(' ')}` });
    for (const week of worldWeeks.filter(week => week.show)) {
      if (week.asked.length) lines.push({ kind: 'world-week', text: `${week.label} at school (her teacher's list): ${sentence(week.asked.join('; '))}` });
      if (week.showWorked && week.worked.length) lines.push({ kind: 'world-week', text: `${week.label} her class worked on: ${sentence(week.worked.join('; '))}` });
    }
    for (const day of dayLines.filter(day => day.show)) lines.push({ kind: 'day', text: day.text });
    for (const week of full.slice(0, fullCount))
      lines.push({ kind: 'week', text: [week.head, ...week.facts, ...(week.showVideos && week.videos ? [week.videos] : [])].join(' ') });
    for (const text of earlier.slice(0, earlierCount)) lines.push({ kind: 'week', text });
    if (bookCount) lines.push({ kind: 'books', text: `Books on her shelf: ${shelf.slice(0, bookCount).join(', ')}.` });
    if (names.length) lines.push({ kind: 'people', text: `People: ${names.join(', ')}.` });
    if (liked.length) lines.push({ kind: 'likes', text: `She likes: ${liked.join(', ')}.` });
    return lines;
  };
  const size = lines => lines.reduce((sum, line) => sum + line.text.length, 0) + lines.length - 1;
  // The cap, whole lines only (the coordinator's order, 10/28: the days are
  // the most valuable part): the world weeks' worked_on lists (oldest week
  // first), then the package video lists (oldest week first), then the Two
  // weeks ago list, then days older than seven days (oldest first), then the
  // package lines for older weeks (oldest first, the newest week stays), then
  // books beyond four, then the newest days (oldest first) as the last resort.
  let lines = compose();
  const over = () => size(lines) > CAP;
  for (let i = worldWeeks.length - 1; over() && i >= 0; i--) { worldWeeks[i].showWorked = false; lines = compose(); }
  for (let i = fullCount - 1; over() && i >= 0; i--) { full[i].showVideos = false; lines = compose(); }
  for (const week of worldWeeks) if (over() && week.twoBack) { week.show = false; lines = compose(); }
  for (let i = dayLines.length - 1; over() && i >= 0; i--) if (dayLines[i].back > RECENT_DAYS) { dayLines[i].show = false; lines = compose(); }
  while (over() && earlierCount > 0) { earlierCount--; lines = compose(); }
  while (over() && fullCount > 1) { fullCount--; lines = compose(); }
  while (over() && bookCount > BOOKS_KEPT) { bookCount--; lines = compose(); }
  for (let i = dayLines.length - 1; over() && i >= 0; i--) if (dayLines[i].show) { dayLines[i].show = false; lines = compose(); }
  // Last resort: drop lines from the end, never the Today line, never mid-line.
  while (lines.length > 1 && size(lines) > CAP) lines.pop();
  const text = lines.map(line => line.text).join('\n');
  return { text, weeks: lines.filter(line => line.kind === 'week').length, days: lines.filter(line => line.kind === 'day').length, chars: text.length,
    about: world.about.slice(0, LINES), week: weekLines(weeks.find(week => ago(week.day) === 0)) };
}

function createWorld({ dataDir, books, people, likes, now = Date.now } = {}) {
  let cached = null, checkedAt = -Infinity, signature = null;
  function digest() {
    const t = now();
    if (cached && t - checkedAt < CHECK_MS) return cached;
    checkedAt = t;
    const local = new Date(t), today = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
    const read = dataDir ? readWeeks(dataDir) : { weeks: [], worlds: [], stamp: [] };
    const sources = { books: listFrom(books), people: listFrom(people), likes: listFrom(likes) };
    let next;
    try { next = JSON.stringify([today, read.stamp, sources]); } catch { next = null; }
    if (cached && next !== null && next === signature) return cached;
    signature = next;
    cached = build({ weeks: read.weeks, worlds: read.worlds, ...sources, today });
    return cached;
  }
  return { digest, preview: () => digest().text };
}

module.exports = { createWorld, CAP };
