import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { createChatStore } = require('../chat-store.js');
const defaults = { voicePreference: 'saved', stories: [], timings: [] };
const story = { label: 'My news', say: 'I went to the park.' };
const row = { kind: 'hold', status: 'completed', timings: { holdMs: 700, workerCloudMs: 1200 } };
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
const update = (expectedRevision, patch) => ({ version: 1, expectedRevision, patch });

test('empty state does not write; explicit saves survive a new store and preserve untouched sections', async t => {
  const dataDir = await directory(t), store = createChatStore({ dataDir });
  assert.deepEqual(await store.get(), { version: 1, revision: 0, exists: false, value: defaults });
  assert.deepEqual(await fs.readdir(dataDir), []);
  const saved = await store.put(update(0, { stories: [story], timings: [row] }));
  assert.equal(saved.revision, 1); assert.equal(saved.exists, true);
  const reopened = createChatStore({ dataDir });
  assert.deepEqual(await reopened.get(), saved);
  const next = await reopened.put(update(1, { voicePreference: 'local' }));
  assert.deepEqual(next.value, { voicePreference: 'local', stories: [story], timings: [row] });
  assert.deepEqual(await createChatStore({ dataDir }).get(), next);
  assert.deepEqual(await fs.readdir(dataDir), ['chat-state.json']);
});

test('concurrent revisions serialize across store instances and stale writers receive current state', async t => {
  const dataDir = await directory(t), a = createChatStore({ dataDir }), b = createChatStore({ dataDir });
  const results = await Promise.allSettled([a.put(update(0, { stories: [story] })), b.put(update(0, { voicePreference: 'local' }))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const error = results.find(r => r.status === 'rejected').reason;
  assert.equal(error.status, 409); assert.equal(error.code, 'revision_conflict'); assert.equal(error.state.revision, 1);
  const saved = await b.put(update(1, { voicePreference: 'local' }));
  assert.equal(saved.revision, 2); assert.deepEqual(saved.value.stories, [story]);
});

test('strict state schema rejects content in timing records and oversized or unknown fields without writing', async t => {
  const dataDir = await directory(t), store = createChatStore({ dataDir });
  const invalid = [
    { ...update(0, { stories: [] }), filename: '../other.json' }, update(0, { filename: '../other.json' }), update(0, { transcript: 'private' }),
    update(0, {}), update(-1, { stories: [] }), { ...update(0, { stories: [] }), version: 2 },
    update(0, { voicePreference: 'automatic' }), update(0, { stories: Array(5).fill(story) }),
    update(0, { stories: [{ ...story, label: 'x'.repeat(56) }] }), update(0, { stories: [{ ...story, say: 'x'.repeat(601) }] }),
    update(0, { stories: [{ ...story, question: 'private' }] }), update(0, { timings: Array(41).fill(row) }),
    ...[{ question: 'private' }, { id: 'turn' }, { reason: 'private' }, { kind: 'other' }, { status: 'other' },
      { timings: { question: 3 } }, { timings: { holdMs: -1 } }, { timings: { holdMs: Infinity } },
      { timings: { holdMs: 3600001 } }, { timings: { holdMs: '2' } }, { timings: [] }].map(p => update(0, { timings: [{ ...row, ...p }] })),
  ];
  for (const input of invalid) await assert.rejects(store.put(input), e => e.status === 400 && e.code === 'invalid_state');
  assert.deepEqual(await fs.readdir(dataDir), []);
  const rows = Array.from({ length: 40 }, (_, i) => ({ kind: 'typed', status: i ? 'cancelled' : 'open', ...(i ? { reason: 'reload' } : {}), timings: { totalMs: i } }));
  assert.deepEqual((await store.put(update(0, { timings: rows }))).value.timings, rows);
});

test('corrupt or unsupported stored state is preserved and never silently reset', async t => {
  const dataDir = await directory(t), file = path.join(dataDir, 'chat-state.json');
  for (const raw of ['{broken', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, revision: 1, value: { ...defaults, question: 'private' } })]) {
    await fs.writeFile(file, raw);
    const store = createChatStore({ dataDir });
    await assert.rejects(store.get(), e => e.code === 'state_corrupt' && e.status === 503);
    await assert.rejects(store.put(update(0, { stories: [] })), e => e.code === 'state_corrupt');
    assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
});

test('failed atomic replacement never acknowledges Saved or changes the previous revision; retry can recover', async t => {
  const dataDir = await directory(t), store = createChatStore({ dataDir });
  await store.put(update(0, { stories: [story] }));
  const failing = createChatStore({ dataDir, io: { ...fs, rename: async () => { throw new Error('private disk detail'); } } });
  await assert.rejects(failing.put(update(1, { stories: [] })), e => e.code === 'state_write_failed' && !e.message.includes('private'));
  assert.deepEqual((await store.get()).value.stories, [story]);
  assert.equal((await store.get()).revision, 1);
  assert.deepEqual(await fs.readdir(dataDir), ['chat-state.json']);
  assert.equal((await store.put(update(1, { stories: [] }))).revision, 2);
});

test('revision exhaustion refuses a write rather than creating an unreadable persisted revision', async t => {
  const dataDir = await directory(t), file = path.join(dataDir, 'chat-state.json');
  const previous = { version: 1, revision: Number.MAX_SAFE_INTEGER - 1, value: defaults };
  await fs.writeFile(file, JSON.stringify(previous));
  const store = createChatStore({ dataDir });
  await assert.rejects(store.put(update(previous.revision, { stories: [] })), e => e.code === 'state_write_failed');
  assert.deepEqual(await store.get(), { ...previous, exists: true });
});

async function service(t, options = {}) {
  const store = createChatStore(options);
  const server = http.createServer((req, res) => { if (!store.handle(req, res)) res.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://localhost:${server.address().port}/chat/api/state`;
  const put = (body, headers = {}) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { store, url, put };
}

test('state HTTP supports GET/PUT, revision conflicts, and explicit dataDir only', async t => {
  const off = await service(t);
  assert.equal((await fetch(off.url)).status, 503); assert.equal((await off.put(update(0, { stories: [] }))).status, 503);
  const dataDir = await directory(t), s = await service(t, { dataDir });
  assert.deepEqual(await (await fetch(s.url)).json(), { version: 1, revision: 0, exists: false, value: defaults });
  assert.equal((await s.put(update(0, { stories: [story] }))).status, 200);
  const stale = await s.put(update(0, { timings: [] }));
  assert.equal(stale.status, 409); const conflict = await stale.json();
  assert.equal(conflict.error, 'revision_conflict'); assert.equal(conflict.state.revision, 1);
  assert.equal((await fetch(s.url, { method: 'POST' })).status, 405);
  assert.equal((await s.put(update(1, { stories: [] }), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await fetch(s.url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(65537) })).status, 413);
  assert.equal((await fetch(s.url + '?file=elsewhere')).status, 400);
});

test('every state method rejects foreign Origin, Host and peer before reading/writing', async t => {
  const dataDir = await directory(t), s = await service(t, { dataDir });
  for (const method of ['GET', 'PUT', 'DELETE']) for (const headers of [{ Origin: 'https://foreign.invalid' }, { Host: 'foreign.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const status = await new Promise((resolve, reject) => { const r = http.request(s.url, { method, headers }, res => { res.resume(); resolve(res.statusCode); }); r.on('error', reject); r.end(); });
    assert.equal(status, 403);
  }
  let status;
  s.store.handle({ url: '/chat/api/state', method: 'GET', headers: { host: 'localhost' }, socket: { remoteAddress: 'foreign.invalid' } }, { writeHead(code) { status = code; }, end() {} });
  assert.equal(status, 403); assert.deepEqual(await fs.readdir(dataDir), []);
});

test('payload Chat copy ships the store module and rejects any private state accidentally staged', async t => {
  const root = new URL('../', import.meta.url), script = await fs.readFile(new URL('tools/build-payload.sh', root), 'utf8');
  const copy = script.split('\n').find(line => line.startsWith('cp "$HUB/chat-api.js"'));
  assert.ok(copy.includes('"$HUB/chat-store.js"'), 'store must be in actual payload copy command');
  const guard = script.match(/# BEGIN Chat private-state guard\n([\s\S]*?)# END Chat private-state guard/);
  assert.ok(guard, 'payload must actively refuse private state');
  const dir = await directory(t), hub = path.join(dir, 'hub'), out = path.join(dir, 'out');
  await fs.mkdir(path.join(hub, 'data'), { recursive: true }); await fs.mkdir(out);
  for (const file of [...copy.matchAll(/"\$HUB\/([^"$]+)"/g)].map(m => m[1])) await fs.copyFile(new URL(file, root), path.join(hub, file));
  await fs.writeFile(path.join(hub, 'data', 'chat-state.json'), 'private sentinel');
  const run = () => spawnSync('bash', ['-euc', copy + '\n' + guard[1]], { env: { ...process.env, HUB: hub, OUT: out }, encoding: 'utf8' });
  assert.equal(run().status, 0); assert.ok((await fs.stat(path.join(out, 'chat-store.js'))).isFile());
  assert.equal((await fs.readdir(out)).includes('data'), false);
  await fs.mkdir(path.join(out, 'data')); await fs.writeFile(path.join(out, 'data', 'chat-state.json'), 'private sentinel');
  const refused = run(); assert.notEqual(refused.status, 0); assert.match(refused.stdout + refused.stderr, /private Chat state/);
  await fs.unlink(path.join(out, 'data', 'chat-state.json'));
  await fs.writeFile(path.join(out, 'data', '.chat-state-owned.tmp'), 'unfinished private sentinel');
  const temporary = run(); assert.notEqual(temporary.status, 0); assert.match(temporary.stdout + temporary.stderr, /private Chat state/);
});

test('a timing row cancelled as "short" (a hold let go too soon) is stored by the hub and by the page store', async t => {
  const dataDir = await directory(t), store = createChatStore({ dataDir });
  const short = { kind: 'hold', status: 'cancelled', reason: 'short', timings: { totalMs: 241 } };
  assert.deepEqual((await store.put(update(0, { timings: [short] }))).value.timings, [short]);
  const { createChatStorage } = await import('../public/chat/storage.js');
  let state = { version: 1, revision: 0, exists: false, value: defaults };
  const page = createChatStorage({ legacyStorage: { getItem: () => null, removeItem() {} }, debounceMs: 0, fetch: async (_url, options = {}) => {
    if (options.method !== 'PUT') return Response.json(state);
    const body = JSON.parse(options.body); state = { version: 1, revision: state.revision + 1, exists: true, value: { ...state.value, ...body.patch } };
    return Response.json(state);
  } });
  await page.hydrate(); page.stageTimings([short]);
  assert.equal(await page.flush(), true);
  assert.deepEqual(state.value.timings, [short]);
});
