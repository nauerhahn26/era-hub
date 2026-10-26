import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createChoicesAdapter, createChoicesServer, adapterPort } from '../tools/chat-choices-adapter.mjs';

const env = { ERA_CHAT_TEXT_URL: 'https://text.example/responses', ERA_CHAT_TEXT_MODEL: 'configured', ERA_CHAT_TEXT_TOKEN: 'private-value' };
const choices = [{ label: 'Games', say: "Let's talk about games." }, { label: 'Something else', say: "I'd like to talk about something else." }];
const response = value => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));

test('adapter is disabled without explicit runtime configuration and never calls a service', async () => {
  let calls = 0;
  const adapter = createChoicesAdapter({ env: {}, fetch: async () => { calls++; } });
  assert.equal(adapter.available, false);
  await assert.rejects(adapter.generate({ text: 'What shall we talk about?' }), /unavailable/);
  assert.equal(calls, 0);
});

test('structured request carries bounded context, no persistence and no automatic speech', async () => {
  let calls = 0;
  const adapter = createChoicesAdapter({ env, fetch: async (url, options) => {
    calls++;
    assert.equal(url, env.ERA_CHAT_TEXT_URL);
    assert.equal(options.headers.Authorization, 'Bearer ' + env.ERA_CHAT_TEXT_TOKEN);
    const body = JSON.parse(options.body);
    assert.equal(body.model, env.ERA_CHAT_TEXT_MODEL);
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.schema.properties.choices.maxItems, 4);
    assert.deepEqual(JSON.parse(body.input), { question: 'What next?', context: ['Me: I like games.'] });
    assert.match(body.instructions, /Do not invent/i);
    assert.ok(!('tools' in body) && !('audio' in body));
    return response({ choices });
  } });
  const result = await adapter.generate({ text: 'What next?', context: ['Me: I like games.'] });
  assert.equal(calls, 1);
  assert.deepEqual(result.choices, choices);
  assert.equal(result.kind, 'generated');
  assert.ok(result.timings.totalMs >= 0);
  assert.ok(!JSON.stringify(result).includes('private-value'));
});

test('request validation rejects excess context or invalid text before a paid call', async () => {
  const adapter = createChoicesAdapter({ env, fetch: () => { throw Error('must not call'); } });
  for (const input of [{ text: '' }, { text: 'x'.repeat(2001) }, { text: 'Question?', context: [null] },
    { text: 'Question?', context: Array(9).fill('turn') }, { text: 'Question?', context: ['x'.repeat(501)] }])
    await assert.rejects(adapter.generate(input), /invalid/);
});

test('unknown personal history uses honest grounded repairs without a generation request', async () => {
  let calls = 0;
  const adapter = createChoicesAdapter({ env, fetch: async () => { calls++; return response({ choices }); } });
  for (const input of [{ text: 'What did you do last weekend?' },
    { text: 'What happened in your book?', context: ['Me: I read a book about a dragon.'] },
    { text: 'What was your favourite part?', context: ['Me: I read a book about a dragon.'] },
    { text: 'What did you do last weekend?', context: ['Partner: You played outside.'] }]) {
    const result = await adapter.generate(input);
    assert.equal(result.kind, 'guarded');
    assert.equal(result.generated, false);
    assert.ok(result.choices.some(x => /clue|remember|another way/.test(x.say)));
    assert.ok(result.choices.every(x => !/played|dragon.*fire|visited|chores|treasure/.test(x.say)));
  }
  const known = await adapter.generate({ text: 'What did you do last weekend?', context: ['Me: Last weekend I read a book.'] });
  assert.ok(known.choices.some(x => x.say === 'Last weekend I read a book.'));
  assert.equal(calls, 0);
});

test('partner feelings and possessions never become unsupported first-person child claims', async () => {
  for (const bad of ['I lost my drawing.', 'I feel sad because my drawing is lost.', 'Can we find my lost drawing?']) {
    const adapter = createChoicesAdapter({ env, fetch: async () => response({ choices: [{ label: 'Tell you', say: bad }, choices[1]] }) });
    const result = await adapter.generate({ text: 'I feel sad because I lost my drawing. What could we do?' });
    assert.equal(result.kind, 'guarded');
    assert.equal(result.generated, false);
    assert.ok(result.choices.every(x => !/my.*drawing|I (?:feel sad|lost)/i.test(x.say)));
  }
});

test('explicit reasoning configuration is passed without choosing a model in code', async () => {
  const adapter = createChoicesAdapter({ env: { ...env, ERA_CHAT_TEXT_REASONING: 'none' }, fetch: async (_, options) => {
    assert.deepEqual(JSON.parse(options.body).reasoning, { effort: 'none' });
    return response({ choices });
  } });
  await adapter.generate({ text: 'What next?' });
});

test('invalid structures, duplicate meanings, oversized replies and refusals fail explicitly', async () => {
  const bodies = [
    { choices: [choices[0]] }, { choices: [choices[0], choices[0]] },
    { choices: [{ label: 'x'.repeat(41), say: 'words' }, choices[1]] },
    { choices: [{ label: 'Unsafe', say: '<markup>' }, choices[1]] },
    { choices: [{ label: 'First', say: 'x'.repeat(181) }, choices[1]] },
  ];
  for (const body of bodies) {
    const adapter = createChoicesAdapter({ env, fetch: async () => response(body) });
    await assert.rejects(adapter.generate({ text: 'What next?' }), /invalid/);
  }
  for (const reply of [new Response('x'.repeat(70000)), new Response('bad-json'),
    new Response(JSON.stringify({ status: 'incomplete', output: [] })),
    new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private text' }] }] }))]) {
    const adapter = createChoicesAdapter({ env, fetch: async () => reply });
    await assert.rejects(adapter.generate({ text: 'What next?' }), /invalid|refused/);
  }
});

test('service errors are sanitized and requests are cancelled on timeout or caller abort', async () => {
  const bad = createChoicesAdapter({ env, fetch: async () => { throw Error('private upstream details'); } });
  await assert.rejects(bad.generate({ text: 'What next?' }), error => error.message === 'generation-unavailable');
  const adapter = createChoicesAdapter({ env, limits: { timeoutMs: 20 }, fetch: async (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Error('aborted')));
  }) });
  await assert.rejects(adapter.generate({ text: 'What next?' }), /unavailable/);
  const signal = new AbortController(); signal.abort();
  await assert.rejects(adapter.generate({ text: 'What next?' }, { signal: signal.signal }), /cancelled/);
});

test('HTTP adapter rejects cross-origin traffic, caps payloads and closes pending generation', async t => {
  let calls = 0;
  const server = createChoicesServer({ env, fetch: async () => { calls++; return response({ choices }); } });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://localhost:${server.address().port}`;
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.available, true);
  assert.ok(!JSON.stringify(health).includes('private-value'));
  const request = (body, headers = {}) => fetch(base + '/choices', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await request({ text: 'What next?' }, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await request({ text: 'x'.repeat(9000) })).status, 413);
  assert.equal((await fetch(base + '/choices', { method: 'POST', body: 'text=data' })).status, 415);
  const result = await request({ text: 'What next?' });
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).choices, choices);
  assert.equal(calls, 1);
  assert.equal(adapterPort({}), 8385);
  assert.throws(() => adapterPort({ ERA_CHAT_TEXT_PORT: String(8300 + 77) }));
});

test('disconnect aborts an in-flight upstream call and releases capacity', async t => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  let cancelled;
  const aborted = new Promise(resolve => { cancelled = resolve; });
  const server = createChoicesServer({ env, fetch: async (_, options) => new Promise((resolve, reject) => {
    started(); options.signal.addEventListener('abort', () => { cancelled(); reject(Error('abort')); });
  }) });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const controller = new AbortController();
  const pending = fetch(`http://localhost:${server.address().port}/choices`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'What next?' }), signal: controller.signal }).catch(() => {});
  await began; controller.abort(); await pending;
  await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(Error('not cancelled')), 500))]);
});
