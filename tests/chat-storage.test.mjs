import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../public/chat/storage.js', import.meta.url), 'utf8');
const { createChatStorage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const initial = () => ({ version: 1, revision: 0, exists: false, value: { voicePreference: 'saved', stories: [], timings: [] } });
const row = (status = 'completed') => ({ kind: 'fixed', status, ...(status === 'cancelled' ? { reason: 'reload' } : {}), timings: { playbackMs: 5 } });
function server(start = initial()) {
  let state = clone(start); const calls = [];
  return { calls, state: () => clone(state), set: value => { state = clone(value); }, fetch: async (_url, options = {}) => {
    calls.push(options);
    if (options.method !== 'PUT') return Response.json(state);
    const body = JSON.parse(options.body);
    if (body.expectedRevision !== state.revision) return Response.json({ error: 'revision_conflict', state }, { status: 409 });
    state = { version: 1, revision: state.revision + 1, exists: true, value: { ...state.value, ...body.patch } };
    return Response.json(state);
  } };
}
function legacy(values = {}) {
  const data = new Map(Object.entries(values));
  return { data, getItem: key => data.get(key) ?? null, removeItem: key => data.delete(key) };
}

test('hydrate waits for canonical settings and existing backend state never imports old browser data', async () => {
  const delayed = deferred(), s = server({ ...initial(), exists: true, revision: 3, value: { voicePreference: 'local', stories: [{ label: 'News', say: 'My chosen story.' }], timings: [row()] } });
  const store = createChatStorage({ fetch: () => delayed.promise, legacyStorage: { getItem() { throw Error('legacy must not be read'); } } });
  const loading = store.hydrate(); assert.equal(store.status().ready, false);
  delayed.resolve(Response.json(s.state()));
  assert.equal((await loading).voicePreference, 'local'); assert.equal(store.status().ready, true); assert.equal(store.status().available, true);
  assert.deepEqual(store.snapshot().stories, [{ label: 'News', say: 'My chosen story.' }]);
});

test('legacy migration clears all three keys only after durable acknowledgement and never resurrects after clear', async () => {
  const s = server(), old = legacy({ 'chat:voicePreference': 'local', 'chat:stories': '[{"label":"News","say":"A real story."}]',
    'chat:timings:v1': JSON.stringify({ turns: [row()] }) });
  const first = deferred(); let put;
  const store = createChatStorage({ legacyStorage: old, fetch: (url, options) => {
    if (options?.method === 'PUT' && !put) { put = options; return first.promise; } return s.fetch(url, options);
  } });
  const loading = store.hydrate(); while (!put) await tick();
  assert.equal(old.data.size, 3); first.resolve(await s.fetch('', put)); await loading;
  assert.equal(old.data.size, 0); assert.equal(store.snapshot().voicePreference, 'local');
  await store.update({ stories: [] });
  old.data.set('chat:stories', '[{"label":"Old","say":"Must not return."}]');
  const next = createChatStorage({ fetch: s.fetch, legacyStorage: old }); await next.hydrate();
  assert.deepEqual(next.snapshot().stories, []); assert.equal(s.calls.filter(call => call.method === 'PUT').length, 2);
});

test('failed migration keeps legacy data and clearly reports an unsaved fallback', async () => {
  const old = legacy({ 'chat:stories': '[{"label":"News","say":"Keep this."}]' });
  const store = createChatStorage({ legacyStorage: old, fetch: async (_url, options) => options?.method === 'PUT' ? Response.json({ error: 'state_write_failed' }, { status: 503 }) : Response.json(initial()) });
  await store.hydrate(); assert.equal(old.data.size, 1); assert.equal(store.status().state, 'unsaved');
  assert.equal(store.status().ready, true); assert.equal(store.status().available, false); assert.deepEqual(store.snapshot().stories, []);
  await assert.rejects(store.update({ stories: [{ label: 'New', say: 'Must not replace unmigrated stories.' }] }));
});

test('explicit story and voice changes do not become current until their acknowledgement', async () => {
  const s = server(), waiting = deferred(); let write;
  const store = createChatStorage({ legacyStorage: legacy(), fetch: (url, options) => {
    if (options?.method === 'PUT') { write = options; return waiting.promise; } return s.fetch(url, options);
  } });
  await store.hydrate(); const saving = store.update({ voicePreference: 'local', stories: [{ label: 'News', say: 'Confirmed words.' }] });
  await tick(); assert.equal(store.snapshot().voicePreference, 'saved'); assert.deepEqual(store.snapshot().stories, []);
  waiting.resolve(await s.fetch('', write)); await saving;
  assert.equal(store.snapshot().voicePreference, 'local'); assert.equal(store.status().state, 'saved');
});

test('timing writes coalesce without blocking stages and clear only the timing section', async () => {
  const s = server({ ...initial(), revision: 2, exists: true, value: { voicePreference: 'local', stories: [{ label: 'News', say: 'A story.' }], timings: [] } });
  const store = createChatStorage({ fetch: s.fetch, legacyStorage: legacy(), debounceMs: 100 }); await store.hydrate();
  for (let i = 0; i < 10; i++) store.stageTimings([{ ...row(), timings: { playbackMs: i } }]);
  assert.equal(store.snapshot().timings[0].timings.playbackMs, 9); assert.equal(s.calls.length, 1);
  assert.equal(await store.flush(), true); assert.equal(s.calls.filter(call => call.method === 'PUT').length, 1);
  store.metricsStorage.removeItem('chat:timings:v1'); assert.equal(await store.flush(), true);
  assert.deepEqual(s.state().value.timings, []); assert.equal(s.state().value.voicePreference, 'local'); assert.equal(s.state().value.stories.length, 1);
});

test('updates serialize revisions and preserve the latest queued timing snapshot', async () => {
  const s = server(), first = deferred(); let firstWrite;
  const store = createChatStorage({ legacyStorage: legacy(), fetch: (url, options) => {
    if (options?.method === 'PUT' && !firstWrite) { firstWrite = options; return first.promise; } return s.fetch(url, options);
  } });
  await store.hydrate(); const preference = store.update({ voicePreference: 'local' }); await tick();
  store.stageTimings([row()]); store.stageTimings([row(), row()]);
  first.resolve(await s.fetch('', firstWrite)); await preference; assert.equal(await store.flush(), true);
  assert.equal(s.state().revision, 2); assert.equal(s.state().value.timings.length, 2);
  assert.deepEqual(s.calls.filter(call => call.method === 'PUT').map(call => JSON.parse(call.body).expectedRevision), [0, 1]);
});

test('revision conflict is visible, preserves current UI and never overwrites the other window', async () => {
  const s = server(), store = createChatStorage({ fetch: s.fetch, legacyStorage: legacy() }); await store.hydrate();
  s.set({ ...initial(), revision: 1, exists: true, value: { voicePreference: 'saved', stories: [{ label: 'Other', say: 'Other selected story.' }], timings: [] } });
  await assert.rejects(store.update({ voicePreference: 'local' }), error => error.code === 'revision_conflict');
  assert.equal(store.status().state, 'conflict'); assert.equal(store.snapshot().voicePreference, 'saved');
  await assert.rejects(store.update({ stories: [] })); assert.equal(s.state().value.stories.length, 1);
  assert.equal(s.calls.filter(call => call.method === 'PUT').length, 1);
});

test('load failure is bounded and does not read legacy or claim durable settings', async () => {
  const store = createChatStorage({ timeoutMs: 10, fetch: () => new Promise(() => {}), legacyStorage: { getItem() { throw Error('must not read'); } } });
  await store.hydrate(); assert.equal(store.status().available, false); assert.equal(store.status().state, 'unsaved');
  await assert.rejects(store.update({ voicePreference: 'local' })); assert.equal(await store.flush(), false);
});

test('pagehide flush sets keepalive and failed writes never report saved', async () => {
  const s = server(), store = createChatStorage({ fetch: s.fetch, legacyStorage: legacy(), debounceMs: 100 }); await store.hydrate();
  store.stageTimings([row()]); assert.equal(await store.flush({ keepalive: true }), true);
  assert.equal(s.calls.at(-1).keepalive, true);
  const failed = createChatStorage({ fetch: async (_url, options) => options?.method === 'PUT' ? Response.json({}, { status: 503 }) : Response.json(initial()), legacyStorage: legacy() });
  await failed.hydrate(); await assert.rejects(failed.update({ stories: [] })); assert.equal(failed.status().state, 'unsaved');
});

test('storage rejects conversation content and strict row violations before writing', async () => {
  const s = server(), store = createChatStorage({ fetch: s.fetch, legacyStorage: legacy() }); await store.hydrate();
  for (const patch of [{ transcript: 'private' }, { stories: Array.from({ length: 5 }, () => ({ label: 'x', say: 'x' })) },
    { timings: [{ ...row(), question: 'private' }] }, { timings: [{ ...row(), timings: { raw: 'private' } }] }]) await assert.rejects(store.update(patch));
  assert.equal(s.calls.length, 1);
});

test('an unrelated successful response is never accepted as a durable write acknowledgement', async () => {
  for (const ack of [initial(), { ...initial(), exists: true, revision: 1 }]) {
    const store = createChatStorage({ legacyStorage: legacy(), fetch: async (_url, options) => Response.json(options?.method === 'PUT' ? ack : initial()) });
    await store.hydrate();
    await assert.rejects(store.update({ voicePreference: 'local' }));
    assert.equal(store.snapshot().voicePreference, 'saved'); assert.equal(store.status().state, 'unsaved');
  }
});

test('failed timing persistence is retried with the next explicit save and never replaced by an older server snapshot', async () => {
  const s = server(); let fail = true;
  const store = createChatStorage({ legacyStorage: legacy(), fetch: (url, options) => {
    if (options?.method === 'PUT' && fail) { fail = false; return Promise.resolve(Response.json({}, { status: 503 })); }
    return s.fetch(url, options);
  } });
  await store.hydrate(); store.stageTimings([row()]); assert.equal(await store.flush(), false);
  assert.equal(store.snapshot().timings.length, 1);
  await store.update({ voicePreference: 'local' });
  assert.equal(store.snapshot().timings.length, 1); assert.equal(s.state().value.timings.length, 1);
  assert.equal(s.state().value.voicePreference, 'local'); assert.equal(store.status().state, 'saved');
});

test('explicit timing clear replaces failed dirty rows rather than resurrecting them on the following flush', async () => {
  const s = server(); let fail = true;
  const store = createChatStorage({ legacyStorage: legacy(), fetch: (url, options) => {
    if (options?.method === 'PUT' && fail) { fail = false; return Promise.resolve(Response.json({}, { status: 503 })); }
    return s.fetch(url, options);
  } });
  await store.hydrate(); store.stageTimings([row()]); assert.equal(await store.flush(), false);
  await store.update({ timings: [] }); assert.equal(await store.flush(), true);
  assert.deepEqual(store.snapshot().timings, []); assert.deepEqual(s.state().value.timings, []);
});
