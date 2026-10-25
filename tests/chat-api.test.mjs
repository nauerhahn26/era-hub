import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createChatApi } = require('../chat-api.js');

function runtime() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.messages = [];
  child.stdin = new Writable({ write(chunk, _, next) {
    child.messages.push(JSON.parse(String(chunk)));
    next();
  } });
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
}

async function service(t, options = {}) {
  const children = [];
  const api = createChatApi({ env: {}, spawn: (...args) => {
    const child = runtime(); child.args = args; children.push(child); return child;
  }, ...options });
  const server = http.createServer((req, res) => {
    if (!api.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  const base = `http://localhost:${server.address().port}/chat/api`;
  t.after(async () => {
    api.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const request = (url, body, method = 'POST') => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { api, base, children, request };
}
const configured = { ERA_CHAT_RUNTIME: 'runtime-command', ERA_CHAT_RUNTIME_ARGS: '["--worker"]' };

test('configuration is truthful, disabled by default and contains no secret configuration', async t => {
  const s = await service(t);
  const config = await (await fetch(s.base + '/config')).json();
  assert.equal(config.wakeName, 'Ellie');
  assert.equal(config.runtime.available, false);
  assert.equal((await s.request('/sessions')).status, 503);
  assert.equal(s.children.length, 0);
  const c = await service(t, { env: { ...configured, ERA_CHAT_CHOICES_TOKEN: 'private-value' } });
  const text = await (await fetch(c.base + '/config')).text();
  assert.ok(!text.includes('private-value') && !text.includes('runtime-command'));
  const invalid = await service(t, { env: { ...configured, ERA_CHAT_RUNTIME_ARGS: '{"shell":true}' } });
  assert.equal((await invalid.request('/sessions')).status, 503);
  assert.equal(invalid.children.length, 0);
});

test('a non-local socket cannot create sessions even with an allowed Host', async t => {
  const s = await service(t, { env: configured });
  const request = new EventEmitter();
  Object.assign(request, { url: '/chat/api/sessions', method: 'POST', socket: { remoteAddress: 'remote.invalid' }, headers: { host: 'localhost' } });
  let status;
  const response = { writeHead(value) { status = value; }, end() {} };
  assert.equal(s.api.handle(request, response), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(status, 403);
  assert.equal(s.children.length, 0);
});

test('cross-origin requests and hostile host headers are rejected before spawning', async t => {
  const s = await service(t, { env: configured });
  for (const headers of [ { Origin: 'https://elsewhere.example' },
    { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'elsewhere.example' } ]) {
    const status = await new Promise((resolve, reject) => {
      const request = http.request(s.base + '/sessions', { method: 'POST', headers }, response => {
        response.resume(); resolve(response.statusCode);
      });
      request.on('error', reject); request.end();
    });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  assert.equal(s.children.length, 0);
});

test('runtime starts without a shell and receives ordered bounded PCM only while active', async t => {
  const s = await service(t, { env: configured });
  const created = await s.request('/sessions');
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const child = s.children[0];
  assert.equal(child.args[0], configured.ERA_CHAT_RUNTIME);
  assert.deepEqual(child.args[1], ['--worker']);
  assert.equal(child.args[2].shell, false);
  const send = seq => fetch(`${s.base}/sessions/${id}/audio?seq=${seq}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(3200),
  });
  assert.equal((await send(0)).status, 409);
  assert.equal((await s.request(`/sessions/${id}/control`, { type: 'ask' })).status, 200);
  assert.equal((await send(0)).status, 200);
  assert.equal((await send(0)).status, 409);
  assert.equal((await send(2)).status, 409);
  assert.equal((await send(1)).status, 200);
  assert.deepEqual(child.messages.map(x => x.type), ['ask', 'audio', 'audio']);
  assert.equal(Buffer.from(child.messages[1].pcm, 'base64').length, 3200);
  assert.equal(child.messages[0].generation, child.messages[1].generation);
  await s.request(`/sessions/${id}/control`, { type: 'pause' });
  assert.equal((await send(2)).status, 409);
  assert.equal((await s.request(`/sessions/${id}`, undefined, 'DELETE')).status, 200);
  assert.equal(child.killed, true);
});

test('SSE timestamps events, drops cancelled generations and sanitizes runtime errors', async t => {
  const s = await service(t, { env: configured });
  const { id } = await (await s.request('/sessions')).json();
  await s.request(`/sessions/${id}/control`, { type: 'ask' });
  const child = s.children[0], old = child.messages.at(-1).generation;
  await s.request(`/sessions/${id}/control`, { type: 'cancel' });
  await s.request(`/sessions/${id}/control`, { type: 'ask' });
  const generation = child.messages.at(-1).generation;
  const controller = new AbortController();
  const stream = await fetch(`${s.base}/sessions/${id}/events`, { signal: controller.signal });
  const reader = stream.body.getReader();
  let received = '';
  await reader.read();
  child.stdout.write(JSON.stringify({ type: 'ready', capabilities: { wake: true, remoteFinal: true, remoteStreaming: false, private: 'secret' } }) + '\n');
  child.stdout.write(JSON.stringify({ type: 'final', text: 'obsolete', generation: old }) + '\n');
  child.stdout.write(JSON.stringify({ type: 'partial', text: 'A question', generation }) + '\n');
  child.stdout.write(JSON.stringify({ type: 'final', text: 'A question?', generation,
    timings: { audioMs: 250, finalDecodeMs: 20, firstPartialMs: null, private: '/private/path' } }) + '\n');
  child.stdout.write(JSON.stringify({ type: 'error', error: '/private/path secret', generation }) + '\n');
  while (!received.includes('runtime-error')) received += new TextDecoder().decode((await reader.read()).value);
  assert.ok(!received.includes('obsolete') && !received.includes('/private/path'));
  const events = received.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
  assert.ok(events.some(event => event.type === 'partial' && event.text === 'A question'));
  assert.deepEqual(events.find(event => event.type === 'ready').capabilities,
    { wake: true, partial: false, automaticEndpoint: false, remoteFinal: true, remoteStreaming: false });
  assert.deepEqual(events.find(event => event.type === 'final').timings, { audioMs: 250, finalDecodeMs: 20, firstPartialMs: null });
  assert.ok(events.every(event => Number.isFinite(event.at) && event.elapsedMs >= 0));
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(child.killed, true);
});

test('no-speech runtime errors are accepted with either supported code field', async t => {
  const s = await service(t, { env: configured });
  const { id } = await (await s.request('/sessions')).json();
  await s.request(`/sessions/${id}/control`, { type: 'ask' });
  const child = s.children[0], generation = child.messages.at(-1).generation;
  const stream = await fetch(`${s.base}/sessions/${id}/events`);
  const reader = stream.body.getReader(); await reader.read();
  child.stdout.write(JSON.stringify({ type: 'error', message: 'no_speech', generation }) + '\n');
  const text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /no-speech/);
  await reader.cancel();
});

test('startup errors without a generation are delivered immediately and sanitized', async t => {
  const s = await service(t, { env: configured });
  const { id } = await (await s.request('/sessions')).json();
  const stream = await fetch(`${s.base}/sessions/${id}/events`);
  const reader = stream.body.getReader(); await reader.read();
  s.children[0].stdout.write(JSON.stringify({ type: 'error', message: 'runtime_unavailable', detail: '/private/path' }) + '\n');
  const output = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(Error('startup error was dropped')), 100))]);
  const text = new TextDecoder().decode(output.value);
  assert.match(text, /runtime-error/);
  assert.ok(!text.includes('/private/path') && !text.includes('detail'));
  await reader.cancel();
});

test('malformed control, oversized bodies, session caps and idle expiry are bounded', async t => {
  let now = 0;
  const s = await service(t, { env: configured, clock: () => now, limits: { sessions: 1, idleMs: 100, bodyBytes: 100 } });
  const { id } = await (await s.request('/sessions')).json();
  assert.equal((await s.request('/sessions')).status, 429);
  assert.equal((await s.request(`/sessions/${id}/control`, { type: 'unknown' })).status, 400);
  assert.equal((await s.request(`/sessions/${id}/control`, { type: 'ask', extra: 'x'.repeat(200) })).status, 413);
  now = 101; s.api.sweep();
  assert.equal(s.children[0].killed, true);
  assert.equal((await s.request(`/sessions/${id}/control`, { type: 'ask' })).status, 404);
});

test('session heartbeat refreshes idle time without worker commands or extending hard lifetime', async t => {
  let now = 0;
  const s = await service(t, { env: configured, clock: () => now, limits: { idleMs: 100, lifetimeMs: 300 } });
  const { id } = await (await s.request('/sessions')).json();
  const status = () => fetch(`${s.base}/sessions/${id}`);
  assert.deepEqual(await (await status()).json(), { ready: false, mode: 'paused' });
  const child = s.children[0];
  child.stdout.write(JSON.stringify({ type: 'ready', capabilities: { wake: false, private: 'private-value' } }) + '\n');
  for (const at of [80, 160, 240]) {
    now = at; s.api.sweep();
    assert.equal(child.killed, undefined);
    const reply = await status();
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), { ready: true, mode: 'paused' });
  }
  assert.deepEqual(child.messages, []);
  assert.equal((await fetch(`${s.base}/sessions/${id}`, { headers: { Origin: 'https://elsewhere.example' } })).status, 403);
  assert.deepEqual(child.messages, []);
  now = 301; s.api.sweep();
  assert.equal(child.killed, true);
  assert.equal((await status()).status, 404);
});

test('heartbeat leaves active capture generation and worker state untouched', async t => {
  const s = await service(t, { env: configured });
  const { id } = await (await s.request('/sessions')).json();
  await s.request(`/sessions/${id}/control`, { type: 'ask' });
  const child = s.children[0], generation = child.messages[0].generation;
  for (let i = 0; i < 2; i++)
    assert.deepEqual(await (await fetch(`${s.base}/sessions/${id}`)).json(), { ready: false, mode: 'capturing' });
  await s.request(`/sessions/${id}/control`, { type: 'finish' });
  assert.deepEqual(child.messages.map(message => message.type), ['ask', 'finish']);
  assert.equal(child.messages[1].generation, generation);
});

test('malformed runtime output closes the worker without reflecting content', async t => {
  const s = await service(t, { env: configured });
  const { id } = await (await s.request('/sessions')).json();
  s.children[0].stdout.write('not-json\n');
  assert.equal(s.children[0].killed, true);
  assert.equal((await s.request(`/sessions/${id}/control`, { type: 'ask' })).status, 404);
});

test('oversized audio, odd PCM and capture hard limits reject before decoding', async t => {
  const s = await service(t, { env: configured, limits: { audioBytes: 10, utteranceBytes: 12 } });
  const { id } = await (await s.request('/sessions')).json();
  await s.request(`/sessions/${id}/control`, { type: 'ask' });
  const audio = (seq, bytes) => fetch(`${s.base}/sessions/${id}/audio?seq=${seq}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(bytes),
  });
  assert.equal((await audio(0, 11)).status, 413);
  assert.equal((await audio(0, 3)).status, 400);
  assert.equal((await audio(0, 8)).status, 200);
  assert.equal((await audio(1, 8)).status, 413);
  assert.deepEqual(s.children[0].messages.map(x => x.type), ['ask', 'audio', 'cancel']);
});

test('closing one session leaves other runtime processes alone', async t => {
  const s = await service(t, { env: configured });
  const one = await (await s.request('/sessions')).json();
  const two = await (await s.request('/sessions')).json();
  await s.request(`/sessions/${one.id}`, undefined, 'DELETE');
  assert.equal(s.children[0].killed, true);
  assert.equal(s.children[1].killed, undefined);
  assert.equal((await s.request(`/sessions/${two.id}/control`, { type: 'ask' })).status, 200);
});

test('deterministic alternatives, yes/no and comments never call external generation', async t => {
  const s = await service(t, { env: {}, fetch: () => { throw Error('unexpected request'); } });
  const alternatives = await (await s.request('/choices', { text: 'Would you like apples or pears?' })).json();
  assert.equal(alternatives.kind, 'alternatives');
  assert.deepEqual(alternatives.choices.map(x => x.say), ['Apples', 'Pears']);
  const yesno = await (await s.request('/choices', { text: 'Did you enjoy that?' })).json();
  assert.equal(yesno.kind, 'yes-no');
  assert.ok(yesno.choices.some(x => x.say === 'Yes'));
  const greeting = await (await s.request('/choices', { text: 'Hello!' })).json();
  assert.equal(greeting.kind, 'comments');
  const open = await (await s.request('/choices', { text: 'What happened today?' })).json();
  assert.equal(open.kind, 'fallback');
  assert.ok(open.choices.length >= 3);
  assert.ok(open.choices.every(x => typeof x.id === 'string' && x.label && x.say));
  assert.ok(Number.isFinite(open.timings.totalMs));
  assert.ok(!('speak' in open) && !('autoSpeak' in open));
});

test('static alternatives accept clear natural choice prompts without repeating the question', async t => {
  const s = await service(t, { env: {}, fetch: () => { throw Error('unexpected request'); } });
  for (const [text, expected] of [
    ['Would you rather read or draw?', ['Read', 'Draw']],
    ['Which would you prefer: reading or drawing?', ['Reading', 'Drawing']],
    ['Do you prefer apples or pears?', ['Apples', 'Pears']],
    ['Shall we play a game or draw pictures?', ['Play a game', 'Draw pictures']],
  ]) {
    const result = await (await s.request('/choices', { text })).json();
    assert.equal(result.kind, 'alternatives', text);
    assert.deepEqual(result.choices.map(choice => choice.say), expected, text);
  }
});

test('recognized choice prompts allow natural sentence punctuation before their options', async t => {
  const s = await service(t, { env: {}, fetch: () => { throw Error('unexpected request'); } });
  for (const [text, expected] of [
    ['What do you like? Music or a story.', ['Music', 'A story']],
    ['What do you like? Music or a story?', ['Music', 'A story']],
    ['Which would you prefer? Read or draw.', ['Read', 'Draw']],
    ['Would you rather. Read or draw?', ['Read', 'Draw']],
    ['Do you want! Music or a story?', ['Music', 'A story']],
  ]) {
    const result = await (await s.request('/choices', { text })).json();
    assert.equal(result.kind, 'alternatives', text);
    assert.deepEqual(result.choices.map(choice => choice.say), expected, text);
  }
});

test('choice punctuation does not repair missing words or swallow negative follow-up clauses', async t => {
  const seen = [];
  const s = await service(t, { env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' }, fetch: async (_, options) => {
    seen.push(JSON.parse(options.body).text);
    return new Response(JSON.stringify({ choices: [{ label: 'More time', say: 'I need more time.' }, { label: 'Another way', say: 'Ask me another way.' }] }));
  } });
  for (const text of ['What you like? Music or a story.', 'What do you not like? Music or a story.',
    'Would you like music or a story? Not music.', 'What do you like? Music or a story. I do not want music.']) {
    const result = await (await s.request('/choices', { text })).json();
    assert.equal(result.kind, 'adapter', text);
    assert.equal(seen.at(-1), text);
  }
  assert.equal(seen.length, 4);
});

test('both leading wake addresses preserve fast alternatives, yes/no and guarded history', async t => {
  const s = await service(t, { env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' },
    fetch: () => { throw Error('these questions should be handled locally'); } });
  for (const address of ['Ellie,', 'Hey Ellie,', 'Ellie', 'Hey Ellie']) {
    const alternatives = await (await s.request('/choices', { text: `${address} do you want music or a story?` })).json();
    assert.equal(alternatives.kind, 'alternatives', address);
    assert.deepEqual(alternatives.choices.map(choice => choice.say), ['Music', 'A story'], address);
    const request = await (await s.request('/choices', { text: `${address} shall we read or draw?` })).json();
    assert.equal(request.kind, 'alternatives', address);
    assert.deepEqual(request.choices.map(choice => choice.say), ['Read', 'Draw'], address);
    const yesno = await (await s.request('/choices', { text: `${address} can we play?` })).json();
    assert.equal(yesno.kind, 'yes-no', address);
    const history = await (await s.request('/choices', { text: `${address} did you go to the park or the pool?` })).json();
    assert.equal(history.kind, 'guarded', address);
    assert.equal(history.generated, false);
    assert.ok(history.choices.every(choice => !/park|pool|did you/i.test(choice.say)), address);
  }
  for (const text of ['Hey!', 'Hey there!']) {
    const greeting = await (await s.request('/choices', { text })).json();
    assert.equal(greeting.kind, 'comments', text);
  }
});

test('addressed wh questions retain their complete text and context for the adapter', async t => {
  const seen = [];
  const s = await service(t, { env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' }, fetch: async (_, options) => {
    seen.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ label: 'Space', say: 'We could talk about space.' }, { label: 'Something else', say: 'Let us choose something else.' }] }));
  } });
  const context = ['Me: Space sounds interesting.'];
  for (const address of ['Ellie,', 'Hey Ellie,', 'Ellie', 'Hey Ellie']) {
    const text = `${address} what should we talk about next?`;
    const result = await (await s.request('/choices', { text, context })).json();
    assert.equal(result.kind, 'adapter', address);
    assert.deepEqual(seen.at(-1), { text, context });
  }
  assert.equal(seen.length, 4);
});

test('subject, possessive and embedded name references remain conversation content', async t => {
  const seen = [];
  const s = await service(t, { env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' }, fetch: async (_, options) => {
    seen.push(JSON.parse(options.body).text);
    return new Response(JSON.stringify({ choices: [{ label: 'More', say: 'Tell me more.' }, { label: 'A moment', say: 'I need a moment.' }] }));
  } });
  for (const text of ["Ellie's drawing was funny.", 'Ellie is a friend from class.', 'Ellie can draw really well.', 'I told Ellie about the game.']) {
    const result = await (await s.request('/choices', { text })).json();
    assert.equal(result.kind, 'adapter', text);
    assert.equal(seen.at(-1), text);
  }
  assert.equal(seen.length, 4);
});

test('punctuated Hey addresses preserve choice prompts and contextual statements', async t => {
  const seen = [];
  const s = await service(t, { env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' }, fetch: async (_, options) => {
    seen.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ label: 'More', say: 'Tell me more.' }, { label: 'A moment', say: 'I need a moment.' }] }));
  } });
  for (const text of ['Hey, Ellie, do you want music or a story?', 'Hey! Ellie, do you want music or a story?']) {
    const result = await (await s.request('/choices', { text })).json();
    assert.equal(result.kind, 'alternatives', text);
    assert.deepEqual(result.choices.map(choice => choice.say), ['Music', 'A story']);
  }
  const context = ['Me: Tell me something new.'];
  for (const text of ['Hey Ellie, I got a new puppy.', 'Hey, Ellie, that was funny.', 'Hey Ellie that was funny.',
    'Ellie, I got a new puppy.', 'Ellie, that was funny.']) {
    const result = await (await s.request('/choices', { text, context })).json();
    assert.equal(result.kind, 'adapter', text);
    assert.deepEqual(seen.at(-1), { text, context });
  }
  assert.equal(seen.length, 5);
});

test('past-history alternatives use honest repairs before any generation request', async t => {
  let calls = 0;
  const question = 'Did you go to the park or the pool?';
  const s = await service(t, { env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' }, fetch: async () => {
    calls++;
    throw Error('personal history must not be invented');
  } });
  const result = await (await s.request('/choices', { text: question })).json();
  assert.equal(calls, 0);
  assert.equal(result.kind, 'guarded');
  assert.equal(result.generated, false);
  assert.ok(result.choices.every(choice => !/park|pool|Did you/.test(choice.say)));
  const local = await service(t);
  const fallback = await (await local.request('/choices', { text: question })).json();
  assert.equal(fallback.kind, 'guarded');
  assert.ok(fallback.choices.every(choice => !/park|pool|Did you/.test(choice.say)));
});

test('configured adapter handles open questions, validates output and never exposes credentials', async t => {
  let calls = 0;
  const s = await service(t, { env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices', ERA_CHAT_CHOICES_TOKEN: 'private-value' },
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, 'https://adapter.example/choices');
      assert.equal(options.headers.Authorization, 'Bearer private-value');
      assert.deepEqual(JSON.parse(options.body), { text: 'What happened today?', context: ['We talked about a game.'] });
      return new Response(JSON.stringify({ choices: [{ label: 'A game', say: 'We played a game.' }, { label: 'Reading', say: 'We read a story.' }] }));
    } });
  const result = await (await s.request('/choices', { text: 'What happened today?', context: ['We talked about a game.'] })).json();
  assert.equal(calls, 1);
  assert.equal(result.kind, 'adapter');
  assert.equal(result.choices[0].say, 'We played a game.');
  assert.ok(!JSON.stringify(result).includes('private-value'));
});

test('malformed or oversized adapter replies fail explicitly', async t => {
  for (const body of ['bad-json', JSON.stringify({ choices: [{ label: 'One', say: 'Only one' }] }), 'x'.repeat(40000)]) {
    const s = await service(t, { env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' }, fetch: async () => new Response(body) });
    const result = await s.request('/choices', { text: 'What happened today?' });
    assert.equal(result.status, 502);
    assert.equal((await result.json()).error, 'choices-invalid');
  }
});

test('adapter source distinctions are preserved through a strict metadata whitelist', async t => {
  for (const kind of ['guarded', 'generated']) {
    const s = await service(t, { env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' }, fetch: async () => new Response(JSON.stringify({
      choices: [{ label: 'More', say: 'Tell me more.' }, { label: 'A clue', say: 'Can you give me a clue?' }], kind,
      generated: kind === 'generated', private: 'private-value',
    })) });
    const result = await (await s.request('/choices', { text: 'What happened today?' })).json();
    assert.equal(result.kind, kind);
    assert.equal(result.generated, kind === 'generated');
    assert.ok(!JSON.stringify(result).includes('private-value'));
  }
});

test('adapter timeouts and concurrency limits are enforced without fallback masquerading as generation', async t => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const s = await service(t, { env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' }, limits: { adapterMs: 100, choices: 1 },
    fetch: async (_, options) => new Promise((resolve, reject) => {
      started(); options.signal.addEventListener('abort', () => reject(Error('request stopped')));
    }) });
  const pending = s.request('/choices', { text: 'What happened today?' });
  await began;
  assert.equal((await s.request('/choices', { text: 'What did you see?' })).status, 429);
  const result = await pending;
  assert.equal(result.status, 502);
  assert.deepEqual(await result.json(), { error: 'choices-unavailable' });
});

test('disconnect cancels an outstanding adapter request', async t => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  let aborted;
  const ended = new Promise(resolve => { aborted = resolve; });
  const s = await service(t, { env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' },
    fetch: async (_, options) => new Promise((resolve, reject) => {
      started(); options.signal.addEventListener('abort', () => { aborted(); reject(Error('cancelled')); });
    }) });
  const controller = new AbortController();
  const pending = fetch(s.base + '/choices', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'What happened today?' }), signal: controller.signal }).catch(() => {});
  await began; controller.abort(); await pending;
  await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(Error('adapter was not cancelled')), 500))]);
});

test('gate clears inherited Chat configuration before any test hub starts', () => {
  const source = readFileSync(new URL('../tools/era-gate.sh', import.meta.url), 'utf8');
  const block = source.match(/for chat_setting in[^\n]+; do unset[^\n]+; done/);
  assert.ok(block, 'gate must clear the complete Chat configuration namespace');
  assert.ok(block.index < source.indexOf('node "$HUB/server.js"'));
  const run = spawnSync('bash', ['-c', block[0] + '\ncompgen -A variable ERA_CHAT_'], {
    env: { PATH: process.env.PATH, ERA_CHAT_RUNTIME: 'unexpected-command', ERA_CHAT_CHOICES_URL: 'https://adapter.example',
      ERA_CHAT_CHOICES_TOKEN: 'private-value', ERA_CHAT_SPEECH_CONFIG: 'unexpected-file' }, encoding: 'utf8',
  });
  assert.equal(run.stdout, '');
});

test('standalone preview serves only the prototype and has inert app handoffs', async t => {
  const { createPreviewServer, previewPort } = await import('../tools/chat-preview.mjs');
  assert.equal(previewPort({}), 8386);
  assert.throws(() => previewPort({ ERA_TEST_PORT: '8377' }));
  let stopped = false;
  const server = createPreviewServer({ env: {}, api: { handle: () => false, close: () => { stopped = true; } } });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://localhost:${server.address().port}`;
  const settings = await (await fetch(base + '/settings')).json();
  assert.equal(settings.preview, true);
  assert.equal(settings.pauseGoes, 'home');
  assert.deepEqual(await (await fetch(base + '/kiosk/exit', { method: 'POST' })).json(), { action: 'home' });
  const script = await fetch(base + '/dwell.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(base + '/server.js')).status, 404);
  assert.equal((await fetch(base + '/chat/%2e%2e%2fserver.js')).status, 404);
  assert.equal((await fetch(base + '/tts')).status, 503);
  await new Promise(resolve => server.close(resolve));
  assert.equal(stopped, true);
});
