// Chat test mode through the real hub (spec 2026-10-27 §5): the settings
// default and door, the cross-site refusal, and the route order (test-mode
// routes answer before the Chat API's own 404). The hub runs on a port the
// kernel picked, with its own temporary data folder and no private Chat
// configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HUB = fileURLToPath(new URL('../', import.meta.url));
const pad2 = n => String(n).padStart(2, '0');
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
async function freePort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address(); await new Promise(resolve => probe.close(resolve));
  return port;
}

test('the hub keeps test mode off by default, moves it only by a real boolean from its own pages, and routes it before Chat', { timeout: 60000 }, async t => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-test-mode-hub-'));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  // One week package (generic content) for her world, this week's Monday.
  const today = new Date(), monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (today.getDay() + 6) % 7);
  const weekOf = `${monday.getFullYear()}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`;
  await fs.mkdir(path.join(data, 'this-week', weekOf), { recursive: true });
  await fs.writeFile(path.join(data, 'this-week', weekOf, 'manifest.json'), JSON.stringify({ week_of: weekOf, title: 'Magnets!', schema: 1,
    topic: { science: 'magnets', hero: 'a famous inventor' }, watch: [], talk: [{ word: 'magnet', say: 'magnet', group: 'science', glyph: '🧲', symbol: null }] }));
  // And the weekly builder's world.json beside it: about her and yesterday's note.
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const yesterdayKey = `${yesterday.getFullYear()}-${pad2(yesterday.getMonth() + 1)}-${pad2(yesterday.getDate())}`;
  await fs.writeFile(path.join(data, 'this-week', weekOf, 'world.json'), JSON.stringify({ schema: 1, generated_on: weekOf, week_of: weekOf,
    about: ['She loves drawing animals.'], weeks: [], days: [{ date: yesterdayKey, mood: 'happy', activities: ['music'], moments: [], said: ['She wants to paint.'] }] }));
  const child = spawn(process.execPath, [path.join(HUB, 'server.js'), String(port)], { cwd: HUB, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, ERA_DATA_DIR: data, ERA_BIND: '127.0.0.1', ERA_DEVICE_ID: 'test-hub', ERA_CHAT_CONFIG_DISABLED: '1', ERA_POOL_DIR: '' } });
  t.after(async () => { child.kill('SIGKILL'); await fs.rm(data, { recursive: true, force: true }); });
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/version')).ok; } catch { await new Promise(r => setTimeout(r, 100)); } }
  assert.ok(up, 'the hub came up');
  const settings = async () => (await (await fetch(base + '/settings')).json()).chatTestMode;
  const set = (value, headers = {}) => fetch(base + '/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ chatTestMode: value }) });
  const record = { version: 1, id: '0f8fad5b-d9cb-469f-a165-70867728950e', kind: 'typed', mode: 'typed', session: null, startedAt: new Date().toISOString(),
    outcome: 'completed', stages: [{ name: 'begin', ms: 0 }, { name: 'transcript', ms: 1 }], content: { transcript: 'hub question' } };
  const post = () => fetch(base + '/chat/api/turns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });

  assert.equal(await settings(), false, 'a device that never chose answers false');
  const off = await fetch(base + '/chat/api/turns');
  assert.equal(off.status, 404); assert.deepEqual(await off.json(), { error: 'test-mode-off' }, 'answered by the test-mode routes, not the Chat API');
  assert.equal((await post()).status, 404);
  for (const junk of ['true', 1, null]) { assert.equal((await set(junk)).status, 204); assert.equal(await settings(), false); }
  assert.equal((await set(true, { 'Sec-Fetch-Site': 'cross-site' })).status, 204);
  assert.equal(await settings(), false, 'a page on another site cannot switch it on');
  assert.equal((await set(true, { 'Sec-Fetch-Site': 'same-origin' })).status, 204);
  assert.equal(await settings(), true);

  assert.equal((await post()).status, 201);
  const lines = (await fs.readFile(path.join(data, 'logs', 'chat-turns', localDay() + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 1); assert.equal(lines[0].device, 'test-hub'); assert.equal(lines[0].content.transcript, 'hub question');
  const pooled = (await fs.readdir(path.join(data, 'pool', 'events', 'test-hub'))).filter(name => name.endsWith('.jsonl'));
  const poolLines = (await Promise.all(pooled.map(name => fs.readFile(path.join(data, 'pool', 'events', 'test-hub', name), 'utf8')))).join('').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(poolLines.some(line => line.kind === 'chat-turn' && line.turn.id === record.id));

  assert.equal((await set(false, { 'Sec-Fetch-Site': 'cross-site' })).status, 204);
  assert.equal(await settings(), true, 'nor switch it off');
  assert.equal((await set(false)).status, 204);
  assert.equal(await settings(), false);
  assert.equal((await post()).status, 404, 'off stops writing');
  assert.equal((await fs.readFile(path.join(data, 'logs', 'chat-turns', localDay() + '.jsonl'), 'utf8')).trim().split('\n').length, 1, 'and keeps what was written');

  // What she likes (dad, 10/28): the generic default until a partner saves a
  // list; junk leaves the stored list alone; another site cannot change it.
  const likes = async () => (await (await fetch(base + '/settings')).json()).chatLikes;
  const setLikes = (value, headers = {}) => fetch(base + '/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ chatLikes: value }) });
  assert.deepEqual(await likes(), ['play outside', 'draw', 'read a book', 'watch a show', 'play a game', 'listen to music', 'have a snack', 'see a friend']);
  assert.equal((await setLikes([' swim ', 'dance', 'swim', 'bake cookies'])).status, 204);
  assert.deepEqual(await likes(), ['swim', 'dance', 'bake cookies'], 'trimmed and deduplicated');
  for (const junk of ['swim', [1, 2], ['x'.repeat(31)], ['ok', 'bad\u0007'], Array(13).fill('a'), null, {}]) {
    assert.equal((await setLikes(junk)).status, 204);
    assert.deepEqual(await likes(), ['swim', 'dance', 'bake cookies'], JSON.stringify(junk));
  }
  assert.equal((await setLikes(['paint'], { 'Sec-Fetch-Site': 'cross-site' })).status, 204);
  assert.deepEqual(await likes(), ['swim', 'dance', 'bake cookies'], 'a page on another site cannot change it');
  assert.equal((await setLikes([])).status, 204);
  assert.deepEqual(await likes(), [], 'an empty list is a real choice');

  // Her lists (stable frame §2): generic defaults, saved per key, same door.
  const lists = async () => { const all = await (await fetch(base + '/settings')).json(); return { q: all.chatQuestions, c: all.chatComments, a: all.chatAbout }; };
  const setLists = (body, headers = {}) => fetch(base + '/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const before = await lists();
  assert.equal(before.q.length, 10); assert.equal(before.q[0], 'How are you?');
  assert.equal(before.c.length, 10); assert.equal(before.c[0], "That's cool!");
  assert.deepEqual(before.a, ['I talk with my eyes', 'I love books', 'I like to draw', 'Ask me anything']);
  assert.equal((await setLists({ chatQuestions: [' Why? ', 'why?'], chatAbout: ['I have a cat'] })).status, 204);
  assert.deepEqual(await lists(), { q: ['Why?'], c: before.c, a: ['I have a cat'] });
  assert.equal((await setLists({ chatComments: ['x'.repeat(41)], chatAbout: ['ok'] })).status, 204);
  assert.deepEqual(await lists(), { q: ['Why?'], c: before.c, a: ['ok'] }, 'junk in one key leaves it alone');
  assert.equal((await setLists({ chatQuestions: ['Hm?'] }, { 'Sec-Fetch-Site': 'cross-site' })).status, 204);
  assert.deepEqual((await lists()).q, ['Why?'], 'a page on another site cannot change them');

  // Her world (plan "Her world as context"): the hub's digest of the week
  // package and the likes, served to its own pages for the partner dialog.
  assert.equal((await setLikes(['swim'])).status, 204);
  const world = await (await fetch(base + '/chat/api/world')).json();
  assert.match(world.text, /^Today: \w+day, \w+ \d+\.\nAbout her: She loves drawing animals\.\nYesterday at school: happy; music\. She said on her device: She wants to paint\.\nThis week at school: "Magnets!"\. Science: magnets\. Hero of the week: a famous inventor\. Words: magnet\.\n/);
  assert.match(world.text, /\nShe likes: swim\.$/);
  assert.equal(world.weeks, 1); assert.equal(world.days, 1); assert.equal(world.chars, world.text.length);
  assert.equal((await fetch(base + '/chat/api/world', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});
