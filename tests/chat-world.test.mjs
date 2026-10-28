// Her world as context (real-time chat plan, "Her world as context", 10/28):
// a compact plain-text digest of what the device already holds (week
// packages, the shelf, people, likes), newest first, labelled relative to
// today, capped, cached on mtimes and never rebuilt more than once a minute.
// Generic invented fixture content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWorld } = require('../chat-world.js');

// Wednesday, October 28, 2026 at noon, local time: this week began Monday the 26th.
const NOW = new Date(2026, 9, 28, 12, 0, 0).getTime();

function week(week_of, title, topic, words = [], videos = []) {
  return { week_of, title, topic, schema: 1, approved: 'fixture',
    watch: videos.map((title, i) => ({ id: 'vid' + i + week_of.replace(/-/g, ''), title, channel: 'A channel', minutes: 3, why: 'fixture' })),
    talk: words.map(word => ({ word, say: word, group: 'science', glyph: '🧲', symbol: null })), play: {} };
}
function fixture(t, weeks, worldFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-chat-world-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(weeks)) {
    fs.mkdirSync(path.join(dir, 'this-week', name), { recursive: true });
    if (value !== undefined && value !== null) fs.writeFileSync(path.join(dir, 'this-week', name, 'manifest.json'), typeof value === 'string' ? value : JSON.stringify(value));
  }
  for (const [name, value] of Object.entries(worldFiles)) {
    fs.mkdirSync(path.join(dir, 'this-week', name), { recursive: true });
    fs.writeFileSync(path.join(dir, 'this-week', name, 'world.json'), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return dir;
}
const THIS = week('2026-10-26', 'Magnets and Inventors!', { science: 'magnets', social_studies: 'community helpers', phonics: 'long a words',
  math: 'counting by tens', hero: 'a famous inventor' }, ['magnet', 'pull', 'push'], ['Magnets for Kids | Science Show', 'How a compass works']);
const LAST = week('2026-10-19', 'Leaves Fall Down', { science: 'falling leaves', hero: 'a brave pilot' }, ['leaf', 'tree'], ['Why leaves change color']);
const BOOKS = [
  { title: 'The Big Red Kite', weekOf: '2026-10-26', publishedAt: '2026-10-26T15:00:00.000Z' },
  { title: 'Leaf Pile Day', weekOf: '2026-10-19', publishedAt: '2026-10-19T15:00:00.000Z' },
  { title: 'A Very Old Story', weekOf: null, publishedAt: null },
  { title: 'Moon Song', weekOf: '2026-10-12', publishedAt: '2026-10-12T15:00:00.000Z' },
  { title: 'Snow Day', weekOf: '2026-09-23', publishedAt: '2026-09-23T15:00:00.000Z' },
];
const PEOPLE = ['Mom', 'Dad', 'Grandpa', 'Teacher Sam'];
const LIKES = ['draw', 'play outside', 'music'];

test('the digest names today, each week relative to this week, the shelf, people and likes, newest first', t => {
  const dataDir = fixture(t, { '2026-10-26': THIS, '2026-10-19': LAST, '2026-10-12': '{ not json', notes: { title: 'x' } });
  const world = createWorld({ dataDir, books: () => BOOKS, people: () => PEOPLE, likes: () => LIKES, now: () => NOW });
  const digest = world.digest();
  const lines = digest.text.split('\n');
  assert.deepEqual(lines, [
    'Today: Wednesday, October 28.',
    'This week at school: "Magnets and Inventors!". Science: magnets. Social studies: community helpers. Phonics: long a words. Math: counting by tens. Hero of the week: a famous inventor. Words: magnet, pull, push. Videos: Magnets for Kids | Science Show; How a compass works.',
    'Last week at school: "Leaves Fall Down". Science: falling leaves. Hero of the week: a brave pilot. Words: leaf, tree. Videos: Why leaves change color.',
    'Books on her shelf: "The Big Red Kite" (this week), "Leaf Pile Day" (last week), "Moon Song" (two weeks ago), "Snow Day" (week of September 21), "A Very Old Story".',
    'People: Mom, Dad, Grandpa, Teacher Sam.',
    'She likes: draw, play outside, music.',
  ]);
  assert.equal(digest.weeks, 2, 'the broken folder and the non-week folder count for nothing');
  assert.equal(digest.days, 0);
  assert.equal(digest.chars, digest.text.length);
  assert.equal(world.preview(), digest.text);
});

test('labels run this week, last week, two and three weeks ago, then a date; the four newest in full, older weeks as one line', t => {
  const weeks = {};
  for (const [i, day] of ['2026-10-26', '2026-10-19', '2026-10-12', '2026-10-05', '2026-09-28', '2026-09-21'].entries())
    weeks[day] = week(day, 'Week ' + (i + 1), { science: 'topic ' + (i + 1), hero: 'hero ' + (i + 1) }, ['word' + (i + 1)]);
  const dataDir = fixture(t, weeks);
  const { text, weeks: count } = createWorld({ dataDir, now: () => NOW }).digest();
  const lines = text.split('\n');
  assert.match(lines[1], /^This week at school: "Week 1"\./);
  assert.match(lines[2], /^Last week at school: "Week 2"\./);
  assert.match(lines[3], /^Two weeks ago at school: "Week 3"\./);
  assert.match(lines[4], /^Three weeks ago at school: "Week 4"\./);
  assert.equal(lines[5], 'Earlier week (September 28): "Week 5", hero hero 5.');
  assert.equal(lines[6], 'Earlier week (September 21): "Week 6", hero hero 6.');
  assert.equal(lines.length, 7, 'no shelf, people or likes lines without providers');
  assert.equal(count, 6);
  // Viewed from three weeks later, the newest week is a date label.
  const later = createWorld({ dataDir, now: () => NOW + 21 * 86400000 }).digest().text.split('\n');
  assert.equal(later[0], 'Today: Wednesday, November 18.');
  assert.match(later[1], /^Three weeks ago at school: "Week 1"\./);
  assert.match(later[2], /^October 19 week at school: "Week 2"\./);
});

test('nothing on the device gives only the Today line and no weeks; broken providers cost only their line', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-chat-world-empty-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const boom = () => { throw Error('unreadable'); };
  const digest = createWorld({ dataDir, books: boom, people: () => 'Mom', likes: () => [], now: () => NOW }).digest();
  assert.deepEqual(digest, { text: 'Today: Wednesday, October 28.', weeks: 0, days: 0, chars: 29, about: [], week: [] });
  assert.equal(createWorld({ dataDir: path.join(dataDir, 'missing'), now: () => NOW }).digest().weeks, 0);
});

test('people may be library rows; retired ones and more than twelve are left out', t => {
  const dataDir = fixture(t, {});
  const rows = [{ word: 'Mom' }, { word: 'Old Friend', retired: true }, ...Array.from({ length: 14 }, (_, i) => ({ word: 'Name' + i }))];
  const { text } = createWorld({ dataDir, people: () => rows, now: () => NOW }).digest();
  assert.equal(text.split('\n')[1], 'People: Mom, ' + Array.from({ length: 11 }, (_, i) => 'Name' + i).join(', ') + '.');
});

test('no control characters, angle brackets or double quotes inside a field survive', t => {
  const bad = week('2026-10-26', 'Bad\u0007 "Title"\nhere', { science: 'mag<b>nets</b>\r\n', hero: 'a\ttab' }, ['pu\u0000ll'], ['Video "one"\u001b']);
  const dataDir = fixture(t, { '2026-10-26': bad });
  const { text } = createWorld({ dataDir, books: () => [{ title: 'Book\u0008 <i>"x"</i>' }], people: () => ['Mo\u0001m'], likes: () => ['dr\u007faw'], now: () => NOW }).digest();
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f<>]/, 'only newlines between lines');
  const lines = text.split('\n');
  assert.equal(lines.length, 5, 'a newline inside a field never makes a line of its own');
  assert.equal(lines[1], 'This week at school: "Bad \'Title\' here". Science: magbnets/b. Hero of the week: a tab. Words: pu ll. Videos: Video \'one\'.');
  assert.equal(lines[2], 'Books on her shelf: "Book i\'x\'/i".');
});

test('package lists are capped: ten words and three videos a week', t => {
  const dataDir = fixture(t, { '2026-10-26': week('2026-10-26', 'Week 1', { science: 'magnets' },
    Array.from({ length: 14 }, (_, i) => 'word' + i), Array.from({ length: 6 }, (_, i) => 'Video ' + i)) });
  const line = createWorld({ dataDir, now: () => NOW }).digest().text.split('\n')[1];
  assert.equal(line, 'This week at school: "Week 1". Science: magnets. Words: ' + Array.from({ length: 10 }, (_, i) => 'word' + i).join(', ') + '. Videos: Video 0; Video 1; Video 2.');
});

test('the package order under the 6,000 cap: video lists go first (oldest week first), then older weeks, then books beyond four; never mid-line', t => {
  const topic = n => 'a very long topic description that goes on and on about subject number ' + n + ' for the whole class this week';
  const weeks = {};
  for (const [i, day] of ['2026-10-26', '2026-10-19', '2026-10-12', '2026-10-05', '2026-09-28', '2026-09-21'].entries())
    weeks[day] = week(day, 'Week ' + (i + 1), Object.fromEntries(['science', 'social_studies', 'phonics', 'math', 'art', 'music', 'reading', 'writing', 'spelling', 'history', 'geography', 'hero'].map((k, j) => [k, topic(j)])),
      Array.from({ length: 10 }, (_, j) => 'wordnumber' + j), Array.from({ length: 3 }, (_, j) => 'A long video title number ' + j + ' about the topic of this week and more'));
  const dataDir = fixture(t, weeks);
  const books = Array.from({ length: 10 }, (_, i) => ({ title: 'A book with a rather long title, volume ' + i + ' of the series', weekOf: '2026-10-26', publishedAt: new Date(Date.UTC(2026, 9, 26, i)).toISOString() }));
  const { text, chars, weeks: count } = createWorld({ dataDir, books: () => books, people: () => PEOPLE, likes: () => LIKES, now: () => NOW }).digest();
  assert.ok(chars <= 6000, String(chars)); assert.equal(chars, text.length);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Today: Wednesday, October 28.');
  assert.ok(lines.every(line => line.endsWith('.')), 'whole lines only');
  assert.ok(!text.includes('Videos:'), 'every video list went first');
  assert.ok(!text.includes('Earlier week'), 'then the older week lines');
  assert.match(lines[1], /^This week at school: "Week 1"\..*Words: wordnumber0/);
  assert.ok(!text.includes('Three weeks ago at school'), 'then the oldest full week');
  assert.ok(text.includes('Two weeks ago at school'));
  assert.equal(count, 3);
  const shelf = lines.find(line => line.startsWith('Books on her shelf: '));
  assert.equal(shelf.match(/"A book/g).length, 8, 'books beyond four go only after the older weeks');
  assert.ok(lines.some(line => line.startsWith('People: ')) && lines.some(line => line.startsWith('She likes: ')));
});

// world.json (schema 1), published by the weekly builder beside each manifest:
// what she is about, the teachers' weekly lists, and day notes.
const WORLD_NEW = { schema: 1, generated_on: '2026-10-27', week_of: '2026-10-26',
  about: ['She loves drawing animals.', 'She likes music with a beat'],
  weeks: [{ start: '2026-10-19', end: '2026-10-23', asked: ['a leaf collage', 'a song about seasons'], worked_on: ['counting by fives', 'read-alouds about fall'], coming: ['Science: magnets'] }],
  days: [
    { date: '2026-10-27', mood: 'happy, calm', activities: ['speech', 'buddies'], moments: ['Classmates liked her drawing.'], said: ['She wants to paint a rainbow.'] },
    { date: '2026-10-26', mood: null, activities: ['music'], moments: [], said: [] },
    { date: '2026-10-22', mood: 'tired', activities: [], moments: ['She rested after lunch.'] },
    { date: '2026-10-17', mood: 'happy', activities: ['art'] },
  ] };
const WORLD_OLD = { schema: 1, generated_on: '2026-10-20', week_of: '2026-10-19',
  about: ['An older line about her.'],
  weeks: [{ start: '2026-10-19', asked: ['a stale list'] }, { start: '2026-10-12', end: '2026-10-16', asked: ['a pumpkin poem'], worked_on: ['never printed two weeks back'] },
    { start: '2026-10-05', asked: ['three weeks back is dropped'] }, { start: 'soon', asked: ['x'] }, 7],
  days: [{ date: '2026-10-27', mood: 'sad', activities: ['stale'] }, { date: '2026-10-20', mood: null, activities: ['library'], moments: [], said: [] },
    { date: 'bad', mood: 'x' }, null, { date: '2026-10-21', mood: 7, activities: 'speech', moments: [3] }] };

test('world.json files are merged across folders, newest first, and placed after Today and before the week packages', t => {
  const dataDir = fixture(t, { '2026-10-26': THIS, '2026-10-19': LAST, '2026-10-12': null, '2026-10-05': null },
    { '2026-10-26': WORLD_NEW, '2026-10-19': WORLD_OLD, '2026-10-12': '{ not json', '2026-10-05': { schema: 2, about: ['A future schema.'] } });
  const digest = createWorld({ dataDir, likes: () => LIKES, now: () => NOW }).digest();
  assert.deepEqual(digest.text.split('\n'), [
    'Today: Wednesday, October 28.',
    'About her: She loves drawing animals. She likes music with a beat.',
    "Last week at school (her teacher's list): a leaf collage; a song about seasons.",
    'Last week her class worked on: counting by fives; read-alouds about fall.',
    "Two weeks ago at school (her teacher's list): a pumpkin poem.",
    'Yesterday at school: happy, calm; speech, buddies; Classmates liked her drawing. She said on her device: She wants to paint a rainbow.',
    'Monday at school: music.',
    'Last Thursday at school: tired; She rested after lunch.',
    'Last Tuesday at school: library.',
    'This week at school: "Magnets and Inventors!". Science: magnets. Social studies: community helpers. Phonics: long a words. Math: counting by tens. Hero of the week: a famous inventor. Words: magnet, pull, push. Videos: Magnets for Kids | Science Show; How a compass works.',
    'Last week at school: "Leaves Fall Down". Science: falling leaves. Hero of the week: a brave pilot. Words: leaf, tree. Videos: Why leaves change color.',
    'She likes: draw, play outside, music.',
  ]);
  assert.equal(digest.days, 4, 'a day older than ten days, a malformed day and a duplicate count for nothing');
  assert.equal(digest.weeks, 2, 'weeks counts the week packages');
  // A world.json alone, with no manifest beside it, still counts.
  const alone = fixture(t, {}, { '2026-10-26': { schema: 1, days: [{ date: '2026-10-28', activities: ['recess'], said: ['Hello there'] }] } });
  assert.deepEqual(createWorld({ dataDir: alone, now: () => NOW }).digest(), { text: 'Today: Wednesday, October 28.\nToday at school: recess. She said on her device: Hello there.', weeks: 0, days: 1, chars: 91,
    about: [], week: [] });
});

test('a day older than last week is named by its date; a world week three or more weeks back is dropped', t => {
  const sunday = NOW + 4 * 86400000;   // Sunday, November 1
  const dataDir = fixture(t, {}, { '2026-10-26': { schema: 1, weeks: [{ start: '2026-10-05', asked: ['a long ago list'] }, { start: '2026-10-19', asked: ['a recent list'], worked_on: ['shapes'] }],
    days: [{ date: '2026-10-23', activities: ['gym'] }, { date: '2026-10-24', activities: ['art'] }] } });
  const lines = createWorld({ dataDir, now: () => sunday }).digest().text.split('\n');
  assert.deepEqual(lines.slice(1), ["Last week at school (her teacher's list): a recent list.", 'Last week her class worked on: shapes.', 'Last Saturday at school: art.', 'Last Friday at school: gym.']);
  const monday = createWorld({ dataDir, now: () => sunday + 86400000 }).digest();   // Monday, November 2
  assert.deepEqual(monday.text.split('\n').slice(1), ["Two weeks ago at school (her teacher's list): a recent list.", 'October 24 at school: art.']);
  assert.equal(monday.days, 1, 'ten days back at most');
});

test('per-list caps: about 320 characters of whole sentences, eight asked, five worked on, three moments, two said; cut at a boundary, never mid-word', t => {
  const about = ['She loves fashion: outfits, colours, noticing people\'s clothes and hair, and she will tell you about it.',
    'She enjoys music with a strong beat and dancing in her chair with friends at recess.', 'She likes stories about animals, especially cats and horses and the ocean.',
    'She laughs when grown-ups make silly voices.', 'Another sentence that would go past the limit if it were kept in full here.'];
  const asked = Array.from({ length: 11 }, (_, i) => 'Item ' + i + ' about a book report diorama. She made a box with a forest scene and three paper animals and a river of foil');
  const worked = ['fall mini lessons with read-alouds, then partner reading in small groups, and a chart about how leaves change color',
    'counting by fives', 'shapes', 'letters', 'sounds', 'never shown'];
  const moments = ['One.', 'Two.', 'Three.', 'Four.'];
  const said = ['First thing.', 'Second thing.', 'Third thing.'];
  const dataDir = fixture(t, {}, { '2026-10-26': { schema: 1, about, weeks: [{ start: '2026-10-19', asked, worked_on: worked }],
    days: [{ date: '2026-10-27', mood: 'happy', activities: ['speech'], moments, said }, { date: '2026-10-26', moments: ['Fine.', 'x'.repeat(130) + ' end.'] }] } });
  const lines = createWorld({ dataDir, now: () => NOW }).digest().text.split('\n');
  const aboutLine = lines.find(line => line.startsWith('About her: '));
  assert.equal(aboutLine, 'About her: ' + about.slice(0, 4).join(' '), 'whole sentences up to 320 characters');
  assert.ok(aboutLine.length - 'About her: '.length <= 320);
  const askedLine = lines.find(line => line.startsWith("Last week at school (her teacher's list): ")).slice("Last week at school (her teacher's list): ".length);
  const items = askedLine.replace(/\.$/, '').split('; ');
  assert.equal(items.length, 8);
  for (const item of items) { assert.ok(item.length <= 110, item); assert.match(item, /^Item \d+ about a book report diorama$/, 'cut at the sentence boundary'); }
  const workedLine = lines.find(line => line.startsWith('Last week her class worked on: '));
  assert.equal(workedLine, 'Last week her class worked on: fall mini lessons with read-alouds, then partner reading in small groups; counting by fives; shapes; letters; sounds.');
  assert.equal(lines.find(line => line.startsWith('Yesterday')), 'Yesterday at school: happy; speech; One. Two. Three. She said on her device: First thing. Second thing.');
  assert.equal(lines.find(line => line.startsWith('Monday')), 'Monday at school: Fine.', 'a moment with no word boundary inside 120 characters is left out, never split');
});

test('a real-sized week keeps at least five day lines: the long lists go before the days under the 6,000 cap', t => {
  const long = (what, n, size) => Array.from({ length: n }, (_, i) => (what + ' ' + i + ' ').padEnd(size, 'and more about it ').trim());
  const days = Array.from({ length: 10 }, (_, i) => { const d = new Date(Date.UTC(2026, 9, 28 - i)); return { date: d.toISOString().slice(0, 10), mood: 'happy, calm',
    activities: ['speech', 'music', 'buddies', 'library'], moments: long('a moment about day ' + i, 6, 200), said: long('she said on day ' + i, 4, 200) }; });
  const worldFile = { schema: 1, about: long('She loves a thing number', 6, 150).map(x => x + '.'),
    weeks: [{ start: '2026-10-19', asked: long('a teacher asked item', 12, 150), worked_on: long('a worked on item', 10, 150) },
      { start: '2026-10-12', asked: long('an older asked item', 12, 150), worked_on: long('an older worked item', 10, 150) }], days };
  const topic = n => 'a long topic description about subject number ' + n + ' for the class this week, with details';
  const weeks = {};
  for (const [i, day] of ['2026-10-26', '2026-10-19', '2026-10-12', '2026-10-05', '2026-09-28', '2026-09-21'].entries())
    weeks[day] = week(day, 'Week ' + (i + 1), Object.fromEntries(['science', 'social_studies', 'phonics', 'math', 'hero'].map((k, j) => [k, topic(j)])),
      Array.from({ length: 24 }, (_, j) => 'wordnumber' + j), Array.from({ length: 8 }, (_, j) => 'A long video title number ' + j + ' about the topic of the week'));
  const dataDir = fixture(t, weeks, { '2026-10-26': worldFile });
  const books = Array.from({ length: 8 }, (_, i) => ({ title: 'Book number ' + i, weekOf: '2026-10-19' }));
  const { text, chars, days: dayCount } = createWorld({ dataDir, books: () => books, people: () => PEOPLE, likes: () => LIKES, now: () => NOW }).digest();
  assert.ok(chars <= 6000, String(chars));
  assert.ok(dayCount >= 5, 'at least five day lines: ' + dayCount);
  assert.match(text, /\nToday at school: happy, calm/);
  assert.match(text, /\nYesterday at school: /);
  assert.match(text, /\nAbout her: /);
  assert.match(text, /\nLast week at school \(her teacher's list\): /, 'the newest teacher list stays');
  assert.doesNotMatch(text, /her class worked on/, 'worked_on lists went first');
  assert.doesNotMatch(text, /Videos: /, 'then the package video lists');
  assert.doesNotMatch(text, /Two weeks ago at school \(her teacher's list\)/, 'then the Two weeks ago line');
  assert.match(text, /\nThis week at school: "Week 1"/);
});

test('world.json changes are picked up by the minute cache like the manifests', t => {
  const dataDir = fixture(t, {}, { '2026-10-26': { schema: 1, about: ['First line.'] } });
  let clock = NOW;
  const world = createWorld({ dataDir, now: () => clock });
  assert.match(world.digest().text, /About her: First line\./);
  const file = path.join(dataDir, 'this-week', '2026-10-26', 'world.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, about: ['Second line.'] }));
  const later = new Date(Date.now() + 5000); fs.utimesSync(file, later, later);
  clock += 61000;
  assert.match(world.digest().text, /About her: Second line\./);
});

test('the cache: rebuilt when a manifest or a provider list changes, never more than once a minute, identical otherwise', t => {
  const dataDir = fixture(t, { '2026-10-26': THIS });
  let clock = NOW, likes = ['draw'], calls = 0;
  const world = createWorld({ dataDir, likes: () => { calls++; return likes; }, now: () => clock });
  const first = world.digest();
  assert.equal(world.digest(), first, 'the same object while nothing changed');
  const callsAfterFirst = calls;
  // A new manifest within the minute is not read yet.
  const file = path.join(dataDir, 'this-week', '2026-10-26', 'manifest.json');
  fs.writeFileSync(file, JSON.stringify({ ...THIS, title: 'Magnets Again' }));
  const later = new Date(Date.now() + 5000); fs.utimesSync(file, later, later);
  clock += 30000;
  assert.equal(world.digest(), first);
  assert.equal(calls, callsAfterFirst, 'no provider is asked within the minute');
  clock += 31000;
  const second = world.digest();
  assert.notEqual(second, first);
  assert.match(second.text, /"Magnets Again"/);
  // Nothing changed for another minute: the same object back.
  clock += 61000;
  assert.equal(world.digest(), second);
  // A provider's list changed.
  likes = ['draw', 'swim'];
  clock += 61000;
  assert.match(world.digest().text, /She likes: draw, swim\./);
});

test('about and week (stable frame §2): her about sentences, and first-person lines from this week\'s package only', t => {
  const dataDir = fixture(t, { '2026-10-26': THIS, '2026-10-19': LAST }, { '2026-10-26': WORLD_NEW });
  const digest = createWorld({ dataDir, now: () => NOW }).digest();
  assert.deepEqual(digest.about, ['She loves drawing animals.', 'She likes music with a beat.']);
  assert.deepEqual(digest.week, ['We are learning about magnets', 'We are learning about community helpers', 'We are learning about long a words',
    'We are learning about counting by tens', 'Our hero is a famous inventor', 'We are watching Magnets for Kids | Science Show']);
  // A capitalised topic is lowered unless it reads as a name; at most six lines, the hero and the video kept.
  const many = week('2026-10-26', 'Many', { science: 'Magnets', social_studies: 'Abraham Lincoln', phonics: 'The USA', math: 'shapes', art: 'colors',
    music: 'drums', hero: 'Grace Hopper' }, [], ['A show']);
  const lines = createWorld({ dataDir: fixture(t, { '2026-10-26': many }), now: () => NOW }).digest().week;
  assert.deepEqual(lines, ['We are learning about magnets', 'We are learning about Abraham Lincoln', 'We are learning about The USA',
    'We are learning about shapes', 'Our hero is Grace Hopper', 'We are watching A show']);
  // Nothing from older weeks: last week's package alone gives no week lines; six about sentences at most.
  const old = createWorld({ dataDir: fixture(t, { '2026-10-19': LAST }, { '2026-10-19': { schema: 1, about: ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.', 'Seven.'] } }),
    now: () => NOW }).digest();
  assert.deepEqual(old.week, []);
  assert.deepEqual(old.about, ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.']);
  const bare = createWorld({ dataDir: fixture(t, { '2026-10-26': week('2026-10-26', 'Bare', { hero: '' }) }), now: () => NOW }).digest();
  assert.deepEqual(bare.week, [], 'no topics, no hero, no videos: no lines');
});
