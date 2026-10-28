import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { createChatApi, openShape, localChoices } = require('../chat-api.js');
const pictures = require('../chat-symbols.js');

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

test('configured bundled speech uses this Node runtime with only speech secrets in its child environment', async t => {
  const speech = { ERA_CHAT_SPEECH_URL: 'https://speech.example/transcribe', ERA_CHAT_SPEECH_MODEL: 'configured',
    ERA_CHAT_SPEECH_TOKEN: 'speech-private', ERA_CHAT_SPEECH_LANGUAGE: 'en', ERA_CHAT_TEXT_TOKEN: 'text-private',
    UNRELATED_PRIVATE_KEY: 'other-private' };
  const s = await service(t, { env: speech, workerExists: () => true });
  const config = await (await fetch(s.base + '/config')).json();
  assert.equal(config.runtime.available, true);
  assert.equal(config.runtime.kind, 'built-in');
  const created = await s.request('/sessions'); assert.equal(created.status, 201);
  const [command, args, options] = s.children[0].args;
  assert.equal(command, process.execPath);
  assert.equal(path.basename(args[0]), 'chat-speech-worker.js');
  assert.equal(path.isAbsolute(args[0]), true);
  assert.equal(options.shell, false);
  assert.equal(options.env.ERA_CHAT_SPEECH_TOKEN, 'speech-private');
  assert.equal(options.env.ERA_CHAT_SPEECH_LANGUAGE, 'en');
  assert.ok(!('ERA_CHAT_TEXT_TOKEN' in options.env) && !('UNRELATED_PRIVATE_KEY' in options.env));
  const { id } = await created.json();
  await s.request(`/sessions/${id}/control`, { type: 'ask' });
  assert.deepEqual(s.children[0].messages, [{ type: 'ask', generation: 1 }]);
  assert.ok(!JSON.stringify(config).includes('speech-private') && !JSON.stringify(config).includes('text-private'));
  const missing = await service(t, { env: speech, workerExists: () => false });
  assert.equal((await (await fetch(missing.base + '/config')).json()).runtime.available, false);
  assert.equal((await missing.request('/sessions')).status, 503);
});

test('bundled speech availability matches the worker transport restrictions', async t => {
  const base = { ERA_CHAT_SPEECH_MODEL: 'configured', ERA_CHAT_SPEECH_TOKEN: 'speech-private' };
  for (const url of ['https://speech.example/transcribe', 'http://localhost:8380/transcribe',
    'http://127.0.0.1:8380/transcribe', 'http://[::1]:8380/transcribe']) {
    const s = await service(t, { env: { ...base, ERA_CHAT_SPEECH_URL: url }, workerExists: () => true });
    assert.equal((await (await fetch(s.base + '/config')).json()).runtime.available, true, url);
  }
  for (const url of ['http://speech.example/transcribe', 'https://user:secret@speech.example/transcribe',
    'ftp://speech.example/transcribe', 'http://[::ffff:127.0.0.1]:8380/transcribe']) {
    const s = await service(t, { env: { ...base, ERA_CHAT_SPEECH_URL: url }, workerExists: () => true });
    assert.equal((await (await fetch(s.base + '/config')).json()).runtime.available, false, url);
    assert.equal((await s.request('/sessions')).status, 503, url);
    assert.equal(s.children.length, 0);
  }
  const external = await service(t, { env: { ...base, ...configured, ERA_CHAT_SPEECH_URL: 'http://speech.example/transcribe' } });
  assert.equal((await external.request('/sessions')).status, 201);
  assert.equal(external.children[0].args[0], configured.ERA_CHAT_RUNTIME);
});

test('explicit private file loads configured API while the process override and disable flag remain authoritative', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'era-chat-api-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ai.env');
  writeFileSync(file, ['ERA_CHAT_SPEECH_URL=https://speech.example/transcribe', 'ERA_CHAT_SPEECH_MODEL=configured',
    'ERA_CHAT_SPEECH_TOKEN=private-value', 'UNRELATED_PRIVATE_KEY=not-chat'].join('\n'));
  const s = await service(t, { env: { ERA_CHAT_SPEECH_MODEL: 'process-choice' }, configPath: file, workerExists: () => true });
  const config = await (await fetch(s.base + '/config')).json(); assert.equal(config.runtime.kind, 'built-in');
  await s.request('/sessions');
  assert.equal(s.children[0].args[2].env.ERA_CHAT_SPEECH_MODEL, 'process-choice');
  assert.ok(!JSON.stringify(config).includes('private-value') && !('UNRELATED_PRIVATE_KEY' in s.children[0].args[2].env));
  const disabled = await service(t, { env: { ERA_CHAT_CONFIG_DISABLED: '1' }, configPath: file, workerExists: () => true });
  assert.equal((await disabled.request('/sessions')).status, 503);
  assert.equal(disabled.children.length, 0);
});

test('private speech configuration created after startup is picked up at the next idle boundary', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'era-chat-api-late-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ai.env');
  const s = await service(t, { configPath: file, workerExists: () => true });
  assert.equal((await (await fetch(s.base + '/config')).json()).runtime.available, false);
  writeFileSync(file, ['ERA_CHAT_SPEECH_URL=https://speech.example/transcribe',
    'ERA_CHAT_SPEECH_MODEL=late-configured', 'ERA_CHAT_SPEECH_TOKEN=private-value'].join('\n'));
  assert.equal((await (await fetch(s.base + '/config')).json()).runtime.available, true);
  assert.equal((await s.request('/sessions')).status, 201);
  assert.equal(s.children[0].args[2].env.ERA_CHAT_SPEECH_MODEL, 'late-configured');
});

test('private configuration changes preserve active sessions and apply after the session closes', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'era-chat-api-live-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ai.env');
  const settings = model => ['ERA_CHAT_SPEECH_URL=https://speech.example/transcribe',
    `ERA_CHAT_SPEECH_MODEL=${model}`, 'ERA_CHAT_SPEECH_TOKEN=private-value'].join('\n');
  writeFileSync(file, settings('initial-configured'));
  const s = await service(t, { configPath: file, workerExists: () => true });
  const { id } = await (await s.request('/sessions')).json();
  writeFileSync(file, '');
  assert.equal((await (await fetch(s.base + '/config')).json()).runtime.available, true);
  assert.ok(!s.children[0].killed);
  await s.request(`/sessions/${id}`, undefined, 'DELETE');
  assert.equal((await (await fetch(s.base + '/config')).json()).runtime.available, false);
  writeFileSync(file, settings('replacement-configured'));
  assert.equal((await s.request('/sessions')).status, 201);
  assert.equal(s.children[1].args[2].env.ERA_CHAT_SPEECH_MODEL, 'replacement-configured');
});

test('private configuration reload waits for an active choices request without aborting it', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'era-chat-api-busy-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ai.env');
  writeFileSync(file, ['ERA_CHAT_TEXT_URL=https://text.example/respond', 'ERA_CHAT_TEXT_MODEL=configured', 'ERA_CHAT_TEXT_TOKEN=private-value'].join('\n'));
  let finish, signal;
  const s = await service(t, { configPath: file, fetch: (_, init) => {
    signal = init.signal; return new Promise(resolve => { finish = resolve; });
  } });
  const pending = s.request('/choices', { text: 'What is a fun game?' });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  writeFileSync(file, '');
  assert.equal((await (await fetch(s.base + '/config')).json()).choices.kind, 'built-in');
  assert.equal(signal.aborted, false);
  finish(Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
    text: JSON.stringify({ choices: [{ label: 'Guessing', say: 'We could play a guessing game.' }, { label: 'Your idea', say: 'What would you like to play?' }] }) }] }] }));
  assert.equal((await pending).status, 200);
  assert.equal((await (await fetch(s.base + '/config')).json()).choices.kind, 'local');
});

test('explicit external runtime remains authoritative over bundled speech', async t => {
  const s = await service(t, { env: { ...configured, ERA_CHAT_SPEECH_URL: 'https://speech.example/transcribe',
    ERA_CHAT_SPEECH_MODEL: 'configured', ERA_CHAT_SPEECH_TOKEN: 'speech-private' }, workerExists: () => true });
  await s.request('/sessions');
  assert.equal(s.children[0].args[0], configured.ERA_CHAT_RUNTIME);
  assert.deepEqual(s.children[0].args[1], ['--worker']);
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
    timings: { audioMs: 250, activityMs: 3, cloudMs: 17, finalDecodeMs: 20, firstPartialMs: null, private: '/private/path' } }) + '\n');
  child.stdout.write(JSON.stringify({ type: 'error', error: '/private/path secret', generation }) + '\n');
  while (!received.includes('runtime-error')) received += new TextDecoder().decode((await reader.read()).value);
  assert.ok(!received.includes('obsolete') && !received.includes('/private/path'));
  const events = received.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
  assert.ok(events.some(event => event.type === 'partial' && event.text === 'A question'));
  assert.deepEqual(events.find(event => event.type === 'ready').capabilities,
    { wake: true, partial: false, automaticEndpoint: false, remoteFinal: true, remoteStreaming: false, audioSocket: true, stagedChoices: false });
  assert.deepEqual(events.find(event => event.type === 'final').timings, { audioMs: 250, activityMs: 3, cloudMs: 17, finalDecodeMs: 20, firstPartialMs: null });
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
    assert.deepEqual(seen.at(-1), { text, context, shape: 'want' });
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
      assert.deepEqual(JSON.parse(options.body), { text: 'What happened today?', context: ['We talked about a game.'], shape: 'recall' });
      return new Response(JSON.stringify({ choices: [{ label: 'A game', say: 'We played a game.' }, { label: 'Reading', say: 'We read a story.' }] }));
    } });
  const result = await (await s.request('/choices', { text: 'What happened today?', context: ['We talked about a game.'] })).json();
  assert.equal(calls, 1);
  assert.equal(result.kind, 'adapter');
  assert.equal(result.choices[0].say, 'We played a game.');
  assert.ok(!JSON.stringify(result).includes('private-value'));
});

test('configured text generation works in process without a standalone adapter', async t => {
  let calls = 0;
  const s = await service(t, { env: { ERA_CHAT_TEXT_URL: 'https://text.example/responses', ERA_CHAT_TEXT_MODEL: 'configured', ERA_CHAT_TEXT_TOKEN: 'private-value' },
    fetch: async (url, options) => {
      calls++; assert.equal(url, 'https://text.example/responses');
      assert.equal(options.headers.Authorization, 'Bearer private-value');
      assert.deepEqual(JSON.parse(JSON.parse(options.body).input), { question: 'What shall we talk about?', context: ['Me: Space.'], shape: 'want' });
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        choices: [{ label: 'Space', say: 'We could talk about space.' }, { label: 'Something else', say: 'Let us choose something else.' }],
      }) }] }] }));
    } });
  assert.equal((await (await fetch(s.base + '/config')).json()).choices.kind, 'built-in');
  const result = await (await s.request('/choices', { text: 'What shall we talk about?', context: ['Me: Space.'] })).json();
  assert.equal(result.kind, 'generated'); assert.equal(result.generated, true); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes('private-value'));
});

test('the Chat API passes the reply usage through to the page only in test mode, and shortcuts report none', async t => {
  let testMode = true;
  const s = await service(t, { reportUsage: () => testMode, env: { ERA_CHAT_TEXT_URL: 'https://text.example/responses', ERA_CHAT_TEXT_MODEL: 'configured', ERA_CHAT_TEXT_TOKEN: 'private-value' },
    fetch: async () => new Response(JSON.stringify({ status: 'completed', usage: { input_tokens: 700, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        choices: [{ label: 'Space', say: 'We could talk about space.' }, { label: 'Something else', say: 'Let us choose something else.' }] }) }] }] })) });
  const result = await (await s.request('/choices', { text: 'What shall we talk about?' })).json();
  assert.deepEqual(result.usage, { model: 'configured', inputTokens: 700, cachedTokens: 0, outputTokens: 40 });
  const shortcut = await (await s.request('/choices', { text: 'Would you like music or a story?' })).json();
  assert.equal(shortcut.kind, 'alternatives'); assert.equal('usage' in shortcut, false);
  testMode = false;
  const off = await (await s.request('/choices', { text: 'What shall we talk about?' })).json();
  assert.equal(off.kind, 'generated'); assert.equal('usage' in off, false, 'off: no model id or token counts reach the page');
});

test('explicit external choices override built-in generation and invalid overrides fail without a paid fallback', async t => {
  const textEnv = { ERA_CHAT_TEXT_URL: 'https://text.example/responses', ERA_CHAT_TEXT_MODEL: 'configured', ERA_CHAT_TEXT_TOKEN: 'private-value' };
  const s = await service(t, { env: { ...textEnv, ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' }, fetch: async (url) => {
    assert.equal(url, 'https://adapter.example/choices');
    return new Response(JSON.stringify({ choices: [{ label: 'More', say: 'Tell me more.' }, { label: 'Not sure', say: 'I am not sure.' }] }));
  } });
  assert.equal((await (await s.request('/choices', { text: 'What shall we talk about?' })).json()).kind, 'adapter');
  let calls = 0;
  const invalid = await service(t, { env: { ...textEnv, ERA_CHAT_CHOICES_URL: 'invalid-endpoint' }, fetch: () => { calls++; throw Error('must not call'); } });
  assert.equal((await invalid.request('/choices', { text: 'What shall we talk about?' })).status, 503);
  assert.equal(calls, 0);
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
  function checkedIsolation(script) {
    const block = script.match(/for chat_setting in[^\n]+; do unset[^\n]+; done/);
    assert.ok(block, 'gate must clear the complete Chat configuration namespace');
    const disabled = /^[ \t]*export ERA_CHAT_CONFIG_DISABLED=1[ \t]*(?:#[^\n]*)?$/m.exec(script);
    assert.ok(disabled && disabled.index > block.index + block[0].length,
      'private file loading is disabled after inherited values are cleared');
    const launches = [...script.matchAll(/^[ \t]*(?:node|"\$NODE_BIN")[ \t]+"\$HUB\/server\.js"[ \t]+"\$PORT"[^#;\n|]*[ \t]&[ \t]*(?:#[^\n]*)?$/gm)];
    assert.ok(launches.length, 'an actual background hub launch must exist');
    for (const launch of launches) assert.ok(disabled.index + disabled[0].length < launch.index,
      'private file loading is disabled before every actual background hub launch');
    return { block, disabled };
  }
  const { block, disabled } = checkedIsolation(source);
  const clear = block[0], guard = 'export ERA_CHAT_CONFIG_DISABLED=1';
  for (const command of ['node', '"$NODE_BIN"']) {
    const launch = `${command} "$HUB/server.js" "$PORT" >"$GATE/server.log" 2>&1 &`;
    const decoys = `# ${launch}\nSRV_ARGS='${launch}'\n${command} "$HUB/server.js" "$PORT" # &`;
    checkedIsolation(`${decoys}\n${clear}\n${guard}\n${launch}\n`);
    assert.throws(() => checkedIsolation(`${decoys}\n${clear}\n${guard}\n`), /actual background hub launch/);
    assert.throws(() => checkedIsolation(`${clear}\n${launch}\n${guard}\n`), /before every actual background hub launch/);
    assert.throws(() => checkedIsolation(`${guard}\n${clear}\n${launch}\n`), /after inherited values are cleared/);
  }
  const isolated = source.slice(block.index, disabled.index + disabled[0].length);
  const run = spawnSync('bash', ['-c', isolated + '\nnode -e \'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("ERA_CHAT_")))))\''], {
    env: { PATH: process.env.PATH, ERA_CHAT_RUNTIME: 'unexpected-command', ERA_CHAT_CHOICES_URL: 'https://adapter.example',
      ERA_CHAT_CHOICES_TOKEN: 'private-value', ERA_CHAT_SPEECH_CONFIG: 'unexpected-file' }, encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(run.stdout), { ERA_CHAT_CONFIG_DISABLED: '1' });
});

test('standalone preview serves only the prototype and has inert app handoffs', async t => {
  const { createPreviewServer, previewPort } = await import('../tools/chat-preview.mjs');
  assert.equal(previewPort({}), 8386);
  assert.throws(() => previewPort({ ERA_TEST_PORT: String(8300 + 77) }));
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

test('either/or shortcuts keep the alternatives and drop a trailing clause or a shared leading verb', async t => {
  const s = await service(t, { env: {}, fetch: () => { throw Error('unexpected request'); } });
  const labels = async text => (await (await s.request('/choices', { text })).json()).choices.map(choice => choice.label);
  assert.deepEqual(await labels('Do you want mom or dad to feed you?'), ['Mom', 'Dad']);
  assert.deepEqual(await labels('Would you like mom or the teacher to help you?'), ['Mom', 'The teacher']);
  assert.deepEqual(await labels('Do you want chicken and rice or sushi tonight?'), ['Chicken and rice', 'Sushi']);
  assert.deepEqual(await labels('Would you like pizza tonight or pasta tonight?'), ['Pizza', 'Pasta']);
  assert.deepEqual(await labels('Do you want to eat now or later?'), ['Now', 'Later']);
  assert.deepEqual(await labels('Do you want to play with mom or dad?'), ['Mom', 'Dad']);
  assert.deepEqual(await labels('Would you like juice or water?'), ['Juice', 'Water']);
  assert.deepEqual(await labels('Would you like sushi or chicken and rice?'), ['Sushi', 'Chicken and rice']);
  assert.deepEqual(await labels('Would you like park or library?'), ['Park', 'Library']);
  assert.deepEqual(await labels('Would you like to read a book or play outside?'), ['Read a book', 'Play outside']);
});

test('either/or lists of two to four alternatives give one clean tile each, in every list shape', async t => {
  const s = await service(t, { env: {}, fetch: () => { throw Error('unexpected request'); } });
  const ask = async text => (await (await s.request('/choices', { text })).json());
  for (const [text, expected] of [
    ['Do you want chicken, sushi, or wine?', ['Chicken', 'Sushi', 'Wine']],
    ['Do you want chicken, sushi or wine?', ['Chicken', 'Sushi', 'Wine']],
    ['Do you want chicken or sushi or wine?', ['Chicken', 'Sushi', 'Wine']],
    ['Would you like juice, milk, water, or tea?', ['Juice', 'Milk', 'Water', 'Tea']],
    ['Do you want either juice or water?', ['Juice', 'Water']],
    ['Would you like either pizza, pasta, or soup?', ['Pizza', 'Pasta', 'Soup']],
    ['Do you want mom, dad, or the teacher to help you?', ['Mom', 'Dad', 'The teacher']],
    ['Would you like chicken and rice, sushi, or pasta tonight?', ['Chicken and rice', 'Sushi', 'Pasta']],
  ]) {
    const result = await ask(text);
    assert.equal(result.kind, 'alternatives', text);
    assert.deepEqual(result.choices.map(choice => choice.label), expected, text);
    assert.ok(result.choices.every(choice => !/[,.;:!?]$/.test(choice.say)), text);
  }
});

test('more than four alternatives, or a restart whose last question is not a recognised choice prompt, go to the model', async t => {
  const seen = [];
  const s = await service(t, { env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' }, fetch: async (_, options) => {
    seen.push(JSON.parse(options.body).text);
    return new Response(JSON.stringify({ choices: [{ label: 'Meatballs', say: 'Meatballs, please.' }, { label: 'Beef', say: 'Beef and mushrooms.' }] }));
  } });
  for (const text of ['Do you want chicken, sushi, pizza, pasta, or soup?',
    'You want chicken and fruit? Chicken and rice. Meatballs or beef and mushrooms?']) {
    const result = await (await s.request('/choices', { text })).json();
    assert.equal(result.kind, 'adapter', text);
    assert.equal(seen.at(-1), text, 'the model still receives the whole transcript');
  }
});

test('when the partner restarts, the shortcut reads only the last question sentence', async t => {
  const s = await service(t, { env: {}, fetch: () => { throw Error('unexpected request'); } });
  const ask = async text => (await (await s.request('/choices', { text })).json());
  const first = await ask('Do you want chicken and fruit? Hmm, okay. Do you want meatballs or beef and mushrooms?');
  assert.equal(first.kind, 'alternatives');
  assert.deepEqual(first.choices.map(choice => choice.label), ['Meatballs', 'Beef and mushrooms']);
  const second = await ask('Would you like juice or water? Sorry. Do you want chicken, sushi, or wine?');
  assert.deepEqual(second.choices.map(choice => choice.label), ['Chicken', 'Sushi', 'Wine']);
  const third = await ask('Do you want pizza or pasta? No wait. Are you hungry?');
  assert.equal(third.kind, 'yes-no');
});

test('two verb-phrase alternatives keep each head verb and its object, never a purpose clause or a dangling "to"', async t => {
  const s = await service(t, { env: {}, fetch: () => { throw Error('unexpected request'); } });
  const ask = async text => (await (await s.request('/choices', { text })).json()).choices;
  const labels = async text => (await ask(text)).map(choice => choice.label);
  assert.deepEqual(await labels('Do you want to go outside to play or stay inside?'), ['Go outside', 'Stay inside']);
  assert.deepEqual(await labels('Do you want to play outside or read a book?'), ['Play outside', 'Read a book']);
  assert.deepEqual(await labels('Do you want to go to the park or stay home?'), ['Go to the park', 'Stay home']);
  assert.deepEqual(await labels('Do you want to watch a video or draw?'), ['Watch a video', 'Draw']);
  assert.deepEqual(await labels('Would you like to go to the park so we can run or stay home?'), ['Go to the park', 'Stay home']);
  for (const text of ['Do you want to go outside to play or stay inside?', 'Do you want to go to the park or stay home?'])
    for (const choice of await ask(text)) assert.doesNotMatch(choice.label, /\b(?:to|so|the|a)$/i, text);
  const pictures = (await ask('Do you want to go outside to play or stay inside?')).map(choice => choice.symbol);
  assert.deepEqual(pictures, ['outside', 'home']);
});

test('a question stem repeated in a later alternative is stripped before the alternatives are cleaned', async t => {
  const s = await service(t, { env: {}, fetch: () => { throw Error('unexpected request'); } });
  const labels = async text => {
    const result = await (await s.request('/choices', { text })).json();
    assert.equal(result.kind, 'alternatives', text);
    return result.choices.map(choice => choice.label);
  };
  assert.deepEqual(await labels('Do you want to go outside to play, or do you want to stay inside?'), ['Go outside', 'Stay inside']);
  assert.deepEqual(await labels('Would you like to read a book, or would you rather play outside?'), ['Read a book', 'Play outside']);
  assert.deepEqual(await labels('Should we go to the park, or should we stay home?'), ['Go to the park', 'Stay home']);
  assert.deepEqual(await labels('Do you want juice, or do you want milk?'), ['Juice', 'Milk']);
  assert.deepEqual(await labels('Is it hot or is it cold?'), ['Hot', 'Cold']);
  assert.deepEqual(await labels('Are you hot or are you cold?'), ['Hot', 'Cold']);
  assert.deepEqual(await labels('Do you wanna draw, or do you need to rest?'), ['Draw', 'Rest']);
  assert.deepEqual(await labels('Shall we sing, or can we dance?'), ['Sing', 'Dance']);
});

test('"is it" and "are you" are stripped only when every alternative carries one', async t => {
  const seen = [];
  const s = await service(t, { env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' }, fetch: async (_, options) => {
    seen.push(JSON.parse(options.body).text);
    return new Response(JSON.stringify({ choices: [{ label: 'Hungry', say: 'I am hungry.' }, { label: 'Thirsty', say: 'I am thirsty.' }] }));
  } });
  const result = await (await s.request('/choices', { text: 'Are you hungry or thirsty?' })).json();
  assert.equal(result.kind, 'adapter');
  const mixed = await (await s.request('/choices', { text: 'Is it hot or cold or is it windy?' })).json();
  assert.ok(mixed.choices.every(choice => !/^Is it\b/i.test(choice.label)), 'never a tile that repeats the stem');
});

test('a verb phrase only the first alternative carries is shared when the rest parallels, and a shared leading possessive or article leaves the labels', async t => {
  const s = await service(t, { env: {}, fetch: () => { throw Error('unexpected request'); } });
  const ask = async text => {
    const result = await (await s.request('/choices', { text })).json();
    assert.equal(result.kind, 'alternatives', text);
    return result.choices.map(choice => [choice.label, choice.say]);
  };
  // The partner's "my" is her "your": she never claims the partner's things.
  assert.deepEqual(await ask('Do you want to play with my dinosaurs or my Magna-Tiles?'),
    [['Dinosaurs', 'Your dinosaurs'], ['Magna-Tiles', 'Your Magna-Tiles']]);
  assert.deepEqual(await ask('Do you want to read the dinosaur book or the truck book?'), [['Dinosaur book', 'Dinosaur book'], ['Truck book', 'Truck book']]);
  assert.deepEqual(await ask('Do you want to go to the park or the beach?'), [['Park', 'Park'], ['Beach', 'Beach']]);
  assert.deepEqual(await ask('Would you like my apple or my pear?'), [['Apple', 'Your apple'], ['Pear', 'Your pear']]);
  assert.deepEqual(await ask('Do you want to play with mom or dad?'), [['Mom', 'Mom'], ['Dad', 'Dad']]);
  // Not shared by every alternative: the words stay, the ownership still flips.
  assert.deepEqual(await ask('Do you want my apple or a pear?'), [['Your apple', 'Your apple'], ['A pear', 'A pear']]);
  assert.deepEqual(await ask('Would you like music or a story?'), [['Music', 'Music'], ['A story', 'A story']]);
  assert.deepEqual(await ask('Shall we play a game or draw pictures?'), [['Play a game', 'Play a game'], ['Draw pictures', 'Draw pictures']]);
});

test('a trailing list of letters or numbers becomes glyph tiles under any stem, and "a" the article never counts as a letter', async t => {
  const s = await service(t, { env: {}, fetch: () => { throw Error('unexpected request'); } });
  const ask = async text => (await (await s.request('/choices', { text })).json());
  for (const [text, expected] of [
    ['Is the answer A, B, C, or D?', ['A', 'B', 'C', 'D']],
    ['Is the answer A, B, C or D?', ['A', 'B', 'C', 'D']],
    ['A or B?', ['A', 'B']],
    ['Do you want A or B?', ['A', 'B']],
    ['Is it a or b', ['A', 'B']],
    ['Which one, 1, 2 or 3?', ['1', '2', '3']],
    ['Pick one: 10, 20, or 30?', ['10', '20', '30']],
    ['Ellie, is the answer a, b, or c?', ['A', 'B', 'C']],
    ['Would you like plan a or b?', ['A', 'B']],
    ['Is it door 1 or 2?', ['1', '2']],
  ]) {
    const result = await ask(text);
    assert.equal(result.kind, 'alternatives', text);
    assert.deepEqual(result.choices.map(choice => choice.label), expected, text);
    assert.deepEqual(result.choices.map(choice => choice.say), expected, text);
    assert.ok(result.choices.every(choice => choice.glyph === true), text);
    assert.ok(result.choices.every(choice => !('symbol' in choice) && !('symbolId' in choice)), `${text}: a glyph carries no picture`);
  }
  const food = await ask('Do you want a cookie or a banana?');
  assert.deepEqual(food.choices.map(choice => choice.label), ['Cookie', 'Banana']);
  assert.ok(food.choices.every(choice => !('glyph' in choice)), 'words are never glyphs');
  assert.ok(food.choices.every(choice => typeof choice.symbol === 'string'));
});

test('who / which / what questions ending in a list offer the named items', async t => {
  const s = await service(t, { env: {}, fetch: () => { throw Error('unexpected request'); } });
  const ask = async text => {
    const result = await (await s.request('/choices', { text })).json();
    assert.equal(result.kind, 'alternatives', text);
    return result.choices.map(choice => [choice.label, choice.say]);
  };
  assert.deepEqual(await ask('Who do you want to read with you tonight, Mom, Dad, Lisa, or Sam?'),
    [['Mom', 'Mom'], ['Dad', 'Dad'], ['Lisa', 'Lisa'], ['Sam', 'Sam']]);
  assert.deepEqual(await ask('Which one do you want: the red one, the blue one or the green one?'),
    [['Red one', 'Red one'], ['Blue one', 'Blue one'], ['Green one', 'Green one']]);
  assert.deepEqual(await ask('Who should feed you, Mom or Dad?'), [['Mom', 'Mom'], ['Dad', 'Dad']]);
  assert.deepEqual(await ask('Whom do you want to sit with, my sister or my brother?'), [['Sister', 'Your sister'], ['Brother', 'Your brother']]);
  assert.deepEqual(await ask('What do you want for dinner, mac and cheese or pizza?'), [['Mac and cheese', 'Mac and cheese'], ['Pizza', 'Pizza']]);
});

test('a who / which / what question whose list would hold half-questions is not split', async t => {
  const seen = [];
  const s = await service(t, { env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' }, fetch: async (_, options) => {
    seen.push(JSON.parse(options.body).text);
    return new Response(JSON.stringify({ choices: [{ label: 'Mom', say: 'Mom.' }, { label: 'Dad', say: 'Dad.' }] }));
  } });
  for (const text of ['Who do you want, Mom, or do you want Dad?', 'What is it, is it a dog or is it a cat?',
    'Who is coming, Mom, Dad, Lisa, Sam, or the teacher?']) {
    const result = await (await s.request('/choices', { text })).json();
    assert.equal(result.kind, 'adapter', text);
  }
});

test('a clause word right after "and" never cuts an alternative, and none ends on a joining word', async t => {
  const s = await service(t, { env: {}, fetch: () => { throw Error('unexpected request'); } });
  const labels = async text => {
    const result = await (await s.request('/choices', { text })).json();
    assert.equal(result.kind, 'alternatives', text);
    return result.choices.map(choice => choice.label);
  };
  assert.deepEqual(await labels('Do you want to go outside and play, or do you want to stay inside?'), ['Go outside and play', 'Stay inside']);
  assert.deepEqual(await labels('Do you want to go outside and then play, or stay inside?'), ['Go outside and then play', 'Stay inside']);
  assert.deepEqual(await labels('Do you want to go outside and play with dad, or stay inside?'), ['Go outside and play', 'Stay inside']);
  for (const text of ['Do you want to go outside and play, or do you want to stay inside?', 'Do you want to go to the park and then, or stay home?'])
    for (const label of await labels(text)) assert.doesNotMatch(label, /\b(?:and|or|with|then)$/i, text);
});

test('an open-ended question is classified into a shape; local shortcuts and statements have none', () => {
  const cases = {
    'What do you want to do today?': 'want', 'what do you want for lunch': 'want', 'Where should we go?': 'want',
    'Ellie, what would you like to play?': 'want', 'Hey Ellie, what game should we play?': 'want', 'What are we going to make?': 'want',
    'How was your weekend?': 'feel', 'how are you': 'feel', 'How are you feeling today?': 'feel', 'How was your lesson?': 'feel',
    'How do you feel?': 'feel', 'How was it?': 'feel',
    'What did you do last weekend?': 'recall', 'Tell me about your day.': 'recall', 'What happened?': 'recall',
    'Where did you go?': 'recall', 'What was your favourite part?': 'recall', 'Ellie what did you see?': 'recall',
    'Why is the sky blue?': 'open', 'Who is your best friend?': 'open', 'Tell me a joke.': 'open', 'Describe your picture.': 'open',
    'What about the dog?': 'open', 'Which color is best?': 'open',
    'It is raining.': null, 'Do you want pizza or pasta?': null, 'Did you go to the park or the pool?': null, 'I got a new puppy.': null,
    "Ellie's drawing was funny.": null,
  };
  for (const [text, shape] of Object.entries(cases)) assert.equal(openShape(text), shape, text);
  // Local shortcuts win before any shape is used: these never reach the model.
  for (const text of ['Do you want pizza or pasta?', 'Did you go to the park or the pool?', 'Did you like it?', 'How are you?'])
    assert.ok(localChoices(text), text);
});

test('an open question sends its shape and the device likes to the adapter; a statement sends neither; the result carries the shape', async t => {
  const seen = [];
  const likes = ['draw', 'play outside'];
  const s = await service(t, { likes: () => likes, env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' }, fetch: async (_, options) => {
    seen.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ label: 'Draw', say: 'I want to draw.' }, { label: 'Outside', say: 'Let us play outside.' }] }));
  } });
  const open = await (await s.request('/choices', { text: 'What do you want to do today?' })).json();
  assert.deepEqual(seen.at(-1), { text: 'What do you want to do today?', shape: 'want', likes });
  assert.equal(open.shape, 'want');
  const statement = await (await s.request('/choices', { text: 'I got a new puppy.' })).json();
  assert.deepEqual(seen.at(-1), { text: 'I got a new puppy.' });
  assert.equal('shape' in statement, false);
  const local = await (await s.request('/choices', { text: 'Do you want pizza or pasta?' })).json();
  assert.equal(local.kind, 'alternatives'); assert.equal('shape' in local, false); assert.equal(seen.length, 2);
  // A provider that throws or returns junk costs the likes, never the reply.
  const broken = await service(t, { likes: () => { throw Error('unreadable'); }, env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' }, fetch: async (_, options) => {
    seen.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ label: 'Good', say: 'I feel good.' }, { label: 'Tired', say: 'I am tired.' }] }));
  } });
  const feel = await (await broken.request('/choices', { text: 'How was your weekend?' })).json();
  assert.deepEqual(seen.at(-1), { text: 'How was your weekend?', shape: 'feel' });
  assert.equal(feel.shape, 'feel');
});

test('a built-in recall reply that asserts an activity reaches the page as the fixed repairs with the shape and recallRejected', async t => {
  let input;
  const s = await service(t, { likes: () => ['draw'], env: { ERA_CHAT_TEXT_URL: 'https://text.example/responses', ERA_CHAT_TEXT_MODEL: 'configured', ERA_CHAT_TEXT_TOKEN: 'private-value' },
    fetch: async (_, options) => { input = JSON.parse(JSON.parse(options.body).input);
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        choices: [{ label: 'Zoo', say: 'We went to the zoo.' }, { label: 'Fun', say: 'It was fun.' }] }) }] }] })); } });
  const result = await (await s.request('/choices', { text: 'What did you do last weekend?' })).json();
  assert.deepEqual(input, { question: 'What did you do last weekend?', context: [], shape: 'recall', likes: ['draw'] });
  assert.equal(result.kind, 'guarded'); assert.equal(result.generated, false);
  assert.equal(result.shape, 'recall'); assert.equal(result.recallRejected, true);
  assert.deepEqual(result.choices.map(choice => choice.say), ['Can you give me a clue?', 'Let me tell you another way.', "I don't remember.", "I don't want to answer now."]);
});

test('a who question sends the family\'s names to the adapter; other questions and a missing or broken provider send none', async t => {
  const seen = [];
  const reply = async (_, options) => { seen.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ label: 'Mom', say: 'Mom' }, { label: 'Sam', say: 'Sam' }] })); };
  const env = { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' };
  const s = await service(t, { people: () => ['Mom', 'Sam', 'x'.repeat(21), 3, ...Array.from({ length: 15 }, (_, i) => 'Name' + i)], env, fetch: reply });
  await s.request('/choices', { text: 'Who do you want to sit with?' });
  assert.equal(seen.at(-1).shape, 'open');
  assert.deepEqual(seen.at(-1).people, ['Mom', 'Sam', ...Array.from({ length: 10 }, (_, i) => 'Name' + i)], 'cleaned and capped at twelve');
  await s.request('/choices', { text: 'What do you want to do today?' });
  assert.equal('people' in seen.at(-1), false);
  await s.request('/choices', { text: 'I saw who did it.' });
  assert.equal('people' in seen.at(-1), false, 'a statement has no shape');
  const none = await service(t, { env, fetch: reply });
  await none.request('/choices', { text: 'Who do you want to sit with?' });
  assert.equal('people' in seen.at(-1), false, 'no provider, no names');
  const broken = await service(t, { people: () => { throw Error('unreadable'); }, env, fetch: reply });
  const result = await (await broken.request('/choices', { text: 'Who do you want to sit with?' })).json();
  assert.equal('people' in seen.at(-1), false); assert.equal(result.choices.length, 2, 'a broken provider costs only the list');
});

test('a name the model returns keeps its words and shows that person\'s own picture', async t => {
  pictures.setPeople(() => [{ slug: 'mom', word: 'Mom' }, { slug: 'sam-2', word: 'Sam' }]);
  t.after(() => pictures.setPeople(null));
  const s = await service(t, { people: () => ['Mom', 'Sam'], env: { ERA_CHAT_CHOICES_URL: 'https://adapter.example/choices' },
    fetch: async () => new Response(JSON.stringify({ choices: [{ label: 'Sam', say: 'Sam, please.' }, { label: 'Mom', say: 'Mom' },
      { label: 'Not sure', say: "I'm not sure." }] })) });
  const result = await (await s.request('/choices', { text: 'Who do you want to sit with?' })).json();
  assert.deepEqual(result.choices.map(c => [c.label, c.say]), [['Sam', 'Sam, please.'], ['Mom', 'Mom'], ['Not sure', "I'm not sure."]], 'no name is stripped');
  assert.deepEqual(result.choices.slice(0, 2).map(c => c.picture), [{ src: '/characters/sam-2.png', kind: 'person' }, { src: '/characters/mom.png', kind: 'person' }]);
});
