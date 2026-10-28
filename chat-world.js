// Her world (real-time chat plan, "Her world as context", dad 10/28): a compact
// plain-text digest of what this device already holds, the week packages the
// Drive mirror keeps under <DATA>/this-week/<week_of>/manifest.json, the books
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
const CAP = 2500, CHECK_MS = 60000, FULL_WEEKS = 4, BOOKS = 8, BOOKS_KEPT = 4, PEOPLE = 12, LIKES = 12, WORDS = 24, VIDEOS = 8;
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
// skipped; a book's manifest is never a week).
function readWeeks(dataDir) {
  const root = path.join(dataDir, 'this-week');
  let names;
  try { names = fs.readdirSync(root).filter(name => WEEK_RE.test(name)).sort().reverse(); } catch { return { weeks: [], stamp: [] }; }
  const weeks = [], stamp = [];
  for (const name of names) {
    const file = path.join(root, name, 'manifest.json');
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      stamp.push([name, st.mtimeMs, st.size]);
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || 'pages' in manifest || 'cover' in manifest) continue;
      const day = dayOf(name);
      if (day !== null) weeks.push({ day, manifest });
    } catch { /* a broken week contributes nothing */ }
  }
  return { weeks, stamp };
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

function build({ weeks, books, people, likes, today }) {
  const thisMonday = monday(today);
  const ago = day => Math.round((thisMonday - monday(day)) / (7 * DAY_MS));
  const label = day => { const n = ago(day); return n >= 0 && n < AGO.length ? AGO[n] : `${monthDay(monday(day))} week`; };
  const bookLabel = day => { const n = ago(day); return n >= 0 && n < AGO.length ? AGO[n].toLowerCase() : `week of ${monthDay(monday(day))}`; };
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
  const compose = () => {
    const lines = [head];
    for (const week of full.slice(0, fullCount)) lines.push([week.head, ...week.facts, ...(week.showVideos && week.videos ? [week.videos] : [])].join(' '));
    lines.push(...earlier.slice(0, earlierCount));
    if (bookCount) lines.push(`Books on her shelf: ${shelf.slice(0, bookCount).join(', ')}.`);
    if (names.length) lines.push(`People: ${names.join(', ')}.`);
    if (liked.length) lines.push(`She likes: ${liked.join(', ')}.`);
    return lines.join('\n');
  };
  // The cap, whole lines only: the oldest week lines first, then video titles
  // (oldest week first), then books beyond four, then whole weeks (oldest first).
  let text = compose();
  while (text.length > CAP && earlierCount > 0) { earlierCount--; text = compose(); }
  for (let i = fullCount - 1; text.length > CAP && i >= 0; i--) { full[i].showVideos = false; text = compose(); }
  while (text.length > CAP && bookCount > BOOKS_KEPT) { bookCount--; text = compose(); }
  while (text.length > CAP && fullCount > 1) { fullCount--; text = compose(); }
  if (text.length > CAP) {
    // Last resort: drop lines from the end, never the Today line, never mid-line.
    const lines = text.split('\n');
    while (lines.length > 1 && lines.join('\n').length > CAP) lines.pop();
    text = lines.join('\n');
  }
  const weeksShown = text.split('\n').filter(line => / at school(?::|\.)/.test(line) || line.startsWith('Earlier week (')).length;
  return { text, weeks: weeksShown, chars: text.length };
}

function createWorld({ dataDir, books, people, likes, now = Date.now } = {}) {
  let cached = null, checkedAt = -Infinity, signature = null;
  function digest() {
    const t = now();
    if (cached && t - checkedAt < CHECK_MS) return cached;
    checkedAt = t;
    const local = new Date(t), today = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
    const read = dataDir ? readWeeks(dataDir) : { weeks: [], stamp: [] };
    const sources = { books: listFrom(books), people: listFrom(people), likes: listFrom(likes) };
    let next;
    try { next = JSON.stringify([today, read.stamp, sources]); } catch { next = null; }
    if (cached && next !== null && next === signature) return cached;
    signature = next;
    cached = build({ weeks: read.weeks, ...sources, today });
    return cached;
  }
  return { digest, preview: () => digest().text };
}

module.exports = { createWorld, CAP };
