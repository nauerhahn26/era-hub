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

function lostResponse(signal) {
  return new Promise((_, reject) => {
    const aborted = () => reject(new DOMException('Connection closed', 'AbortError'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

test('a committed timing write with a lost acknowledgement beyond the default deadline preserves queued completion and voice waiters', async () => {
  const s = server(), committed = deferred(); let first = true;
  const store = createChatStorage({ legacyStorage: legacy(), debounceMs: 1, fetch: async (url, options) => {
    if (options?.method === 'PUT' && first) {
      first = false; await s.fetch(url, options); committed.resolve(); return lostResponse(options.signal);
    }
    return s.fetch(url, options);
  } });
  await store.hydrate(); store.stageTimings([{ kind: 'typed', status: 'open', timings: {} }]); await committed.promise;
  store.stageTimings([{ kind: 'typed', status: 'completed', timings: { playbackMs: 5 } }]);
  const voice = store.update({ voicePreference: 'local' });
  await voice; assert.equal(await store.flush(), true);
  assert.equal(store.status().state, 'saved'); assert.equal(s.state().revision, 2);
  assert.equal(s.state().value.voicePreference, 'local'); assert.equal(s.state().value.timings.length, 1);
  assert.equal(s.state().value.timings[0].status, 'completed');
  assert.deepEqual(s.calls.filter(call => call.method === 'PUT').map(call => JSON.parse(call.body).expectedRevision), [0, 1]);
});

test('a disconnect after commit reconciles exact complete state before acknowledging an explicit save', async () => {
  const s = server(); let first = true;
  const store = createChatStorage({ legacyStorage: legacy(), fetch: async (url, options) => {
    if (options?.method === 'PUT' && first) { first = false; await s.fetch(url, options); throw new TypeError('Connection closed'); }
    return s.fetch(url, options);
  } });
  await store.hydrate(); await store.update({ voicePreference: 'local' });
  assert.equal(store.snapshot().voicePreference, 'local'); assert.equal(store.status().state, 'saved');
  assert.equal(s.state().revision, 1); assert.equal(s.calls.filter(call => call.method === 'PUT').length, 1);
});

test('an unchanged canonical base permits one bounded retry of the same revision and patch', async () => {
  const s = server(), attempts = []; let first = true;
  const store = createChatStorage({ legacyStorage: legacy(), fetch: async (url, options) => {
    if (options?.method === 'PUT') {
      attempts.push(JSON.parse(options.body));
      if (first) { first = false; throw new TypeError('Connection closed before commit'); }
    }
    return s.fetch(url, options);
  } });
  await store.hydrate(); await store.update({ voicePreference: 'local' });
  assert.equal(store.status().state, 'saved'); assert.equal(s.state().revision, 1);
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
});

test('the original write winning after the reconciliation read is safe when the identical CAS retry conflicts', async () => {
  const s = server(); let original, reads = 0; const attempts = [];
  const store = createChatStorage({ legacyStorage: legacy(), fetch: async (url, options) => {
    if (options?.method === 'PUT') {
      attempts.push(JSON.parse(options.body));
      if (!original) { original = options; throw new TypeError('Original acknowledgement unavailable'); }
    } else if (++reads === 2) {
      const beforeCommit = await s.fetch(url, options); await s.fetch('', original); return beforeCommit;
    }
    return s.fetch(url, options);
  } });
  await store.hydrate(); await store.update({ voicePreference: 'local' });
  assert.equal(store.status().state, 'saved'); assert.equal(s.state().revision, 1);
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
});

test('ambiguous writes never adopt another window with a changed unrelated section or additional revision', async () => {
  for (const extraRevision of [false, true]) {
    const s = server(); let first = true;
    const store = createChatStorage({ legacyStorage: legacy(), fetch: async (url, options) => {
      if (options?.method === 'PUT' && first) {
        first = false;
        await s.fetch('', { method: 'PUT', body: JSON.stringify({ version: 1, expectedRevision: 0, patch: {
          voicePreference: 'local', ...(extraRevision ? {} : { stories: [{ label: 'Other', say: 'Other selected words.' }] }),
        } }) });
        if (extraRevision) await s.fetch('', { method: 'PUT', body: JSON.stringify({ version: 1, expectedRevision: 1, patch: { voicePreference: 'local' } }) });
        throw new TypeError('Our write acknowledgement unavailable');
      }
      return s.fetch(url, options);
    } });
    await store.hydrate(); await assert.rejects(store.update({ voicePreference: 'local' }), error => error.code === 'revision_conflict');
    assert.equal(store.status().state, 'conflict'); assert.equal(store.snapshot().voicePreference, 'saved');
    assert.equal(await store.flush(), false); assert.equal(s.state().revision, extraRevision ? 2 : 1);
    assert.equal(s.state().value.stories.length, extraRevision ? 0 : 1);
  }
});

test('unavailable reconciliation stays unsaved and a later explicit save reconciles before sending a new revision', async () => {
  const s = server(); let first = true, unreadable = false;
  const store = createChatStorage({ legacyStorage: legacy(), fetch: async (url, options) => {
    if (options?.method === 'PUT' && first) {
      first = false; await s.fetch(url, options); unreadable = true; throw new TypeError('Connection closed');
    }
    if (options?.method !== 'PUT' && unreadable) throw new TypeError('Read unavailable');
    return s.fetch(url, options);
  } });
  await store.hydrate(); await assert.rejects(store.update({ voicePreference: 'local' }));
  assert.equal(store.status().state, 'unsaved'); assert.equal(store.snapshot().voicePreference, 'saved');
  unreadable = false; await store.update({ stories: [{ label: 'News', say: 'Chosen words.' }] });
  assert.equal(store.status().state, 'saved'); assert.equal(s.state().revision, 2);
  assert.equal(s.state().value.voicePreference, 'local'); assert.equal(s.state().value.stories.length, 1);
});

test('a queued timing clear supersedes uncertain older rows without resurrecting them after acknowledgement', async () => {
  const s = server(), waiting = deferred(), committed = deferred(); let first = true;
  const store = createChatStorage({ legacyStorage: legacy(), fetch: async (url, options) => {
    if (options?.method === 'PUT' && first) { first = false; await s.fetch(url, options); committed.resolve(); await waiting.promise; throw new TypeError('Connection closed'); }
    return s.fetch(url, options);
  } });
  await store.hydrate(); store.stageTimings([row()]); const saving = store.flush(); await committed.promise;
  store.metricsStorage.removeItem('chat:timings:v1'); const voice = store.update({ voicePreference: 'local' }); waiting.resolve();
  await voice; assert.equal(await saving, true); assert.equal(await store.flush(), true);
  assert.deepEqual(store.snapshot().timings, []); assert.deepEqual(s.state().value.timings, []);
  assert.equal(s.state().value.voicePreference, 'local'); assert.equal(s.state().revision, 2);
});

test('migration removes legacy keys only after exact committed state is recovered from its lost acknowledgement', async () => {
  const s = server(), committed = deferred(), release = deferred(); let first = true;
  const old = legacy({ 'chat:voicePreference': 'local', 'chat:stories': '[{"label":"News","say":"Chosen story."}]' });
  const store = createChatStorage({ legacyStorage: old, fetch: async (url, options) => {
    if (options?.method === 'PUT' && first) { first = false; await s.fetch(url, options); committed.resolve(); await release.promise; throw new TypeError('Connection closed'); }
    return s.fetch(url, options);
  } });
  const hydrating = store.hydrate(); await committed.promise; assert.equal(old.data.size, 2); release.resolve(); await hydrating;
  assert.equal(old.data.size, 0); assert.equal(store.status().state, 'saved'); assert.equal(store.status().available, true);
  assert.equal(store.snapshot().voicePreference, 'local'); assert.equal(store.snapshot().stories.length, 1);
});

test('an850ms leave flush can time out while uncertain persistence remains pending without blocking later recovery', async () => {
  const s = server(), committed = deferred(), release = deferred(); let first = true;
  const store = createChatStorage({ legacyStorage: legacy(), fetch: async (url, options) => {
    if (options?.method === 'PUT' && first) { first = false; await s.fetch(url, options); committed.resolve(); await release.promise; throw new TypeError('Connection closed'); }
    return s.fetch(url, options);
  } });
  await store.hydrate(); store.stageTimings([row()]); const leave = store.flush({ keepalive: true, timeoutMs: 850 }); await committed.promise;
  assert.equal(await leave, false); assert.notEqual(store.status().state, 'saved');
  release.resolve(); assert.equal(await store.flush(), true); assert.equal(store.status().state, 'saved');
  assert.equal(s.calls.find(call => call.method === 'PUT').keepalive, true);
});

test('repeated ambiguous failures retry once per pump and never create an unbounded background write loop', async () => {
  const s = server(); let attempts = 0;
  const store = createChatStorage({ legacyStorage: legacy(), fetch: async (url, options) => {
    if (options?.method === 'PUT') { attempts++; throw new TypeError('Connection closed'); }
    return s.fetch(url, options);
  } });
  await store.hydrate(); await assert.rejects(store.update({ voicePreference: 'local' }));
  assert.equal(attempts, 2); assert.equal(store.status().state, 'unsaved'); await tick(); assert.equal(attempts, 2);
});

test('another window winning between the unchanged-base read and CAS retry is preserved without a second overwrite', async () => {
  const s = server(); let original, reads = 0, attempts = 0;
  const store = createChatStorage({ legacyStorage: legacy(), fetch: async (url, options) => {
    if (options?.method === 'PUT') {
      attempts++;
      if (!original) { original = options; throw new TypeError('Original connection closed'); }
    } else if (++reads === 2) {
      const beforeCommit = await s.fetch(url, options);
      await s.fetch('', { method: 'PUT', body: JSON.stringify({ version: 1, expectedRevision: 0,
        patch: { stories: [{ label: 'Other', say: 'Other selected words.' }] } }) });
      return beforeCommit;
    }
    return s.fetch(url, options);
  } });
  await store.hydrate(); await assert.rejects(store.update({ voicePreference: 'local' }), error => error.code === 'revision_conflict');
  assert.equal(attempts, 2); assert.equal(store.status().state, 'conflict'); assert.equal(await store.flush(), false);
  assert.equal(s.state().revision, 1); assert.equal(s.state().value.voicePreference, 'saved');
  assert.deepEqual(s.state().value.stories, [{ label: 'Other', say: 'Other selected words.' }]);
});

test('a keepalive flush covers reconciliation reads and the bounded identical retry as well as the original write', async () => {
  const s = server(), calls = []; let first = true;
  const store = createChatStorage({ legacyStorage: legacy(), debounceMs: 100, fetch: async (url, options) => {
    calls.push({ method: options.method, keepalive: options.keepalive });
    if (options.method === 'PUT' && first) { first = false; throw new TypeError('Connection closed before commit'); }
    return s.fetch(url, options);
  } });
  await store.hydrate(); store.stageTimings([row()]); assert.equal(await store.flush({ keepalive: true }), true);
  assert.deepEqual(calls.slice(1).map(call => [call.method, call.keepalive]), [['PUT', true], ['GET', true], ['PUT', true]]);
});

test('leave promotes future recovery and queued writes when the active write predates keepalive, without extending850ms or retaining it after drain', async () => {
  const s = server(), started = deferred(), disconnect = deferred(), calls = []; let first = true, original;
  const store = createChatStorage({ legacyStorage: legacy(), debounceMs: 1, fetch: async (url, options) => {
    calls.push({ method: options.method, keepalive: options.keepalive });
    if (options.method === 'PUT' && first) {
      first = false; original = options; started.resolve(); await disconnect.promise; throw new TypeError('Connection closed before commit');
    }
    return s.fetch(url, options);
  } });
  await store.hydrate(); store.stageTimings([{ kind: 'typed', status: 'open', timings: {} }]); await started.promise;
  assert.equal(original.keepalive, false);
  const leaving = store.flush({ keepalive: true, timeoutMs: 850 });
  store.stageTimings([{ kind: 'typed', status: 'completed', timings: { playbackMs: 5 } }]);
  assert.equal(await leaving, false); assert.equal(original.keepalive, false, 'an already-started request is unchanged');
  disconnect.resolve(); assert.equal(await store.flush(), true);
  assert.deepEqual(calls.slice(2).map(call => [call.method, call.keepalive]), [['GET', true], ['PUT', true], ['PUT', true]]);
  assert.equal(s.state().value.timings[0].status, 'completed');
  await store.update({ voicePreference: 'local' });
  assert.equal(calls.at(-1).keepalive, false, 'unrelated writes after the flush drains use ordinary requests again');
});
