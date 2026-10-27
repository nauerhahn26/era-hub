// Speech ready before she looks (real-time chat spec 2026-10-27 §3.3-§3.4):
// the hub keeps its connections to the reply and saved-voice services alive for
// its lifetime (keepalive-fetch.js), and /tts streams the saved voice's bytes to
// the page as they arrive, caching the whole clip only once it is complete
// (tts-stream.js). Fake upstream servers on loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createKeepAliveFetch } = require('../keepalive-fetch.js');
const { streamSpeech } = require('../tts-stream.js');
const pause = ms => new Promise(r => setTimeout(r, ms));

async function upstream(t, handler) {
  let connections = 0;
  const server = http.createServer(handler);
  server.keepAliveTimeout = 60000;
  server.on('connection', () => { connections++; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, connections: () => connections };
}

test('the keep-alive fetch keeps one warm connection across a quiet gap longer than the default pool keeps it', { timeout: 20000 }, async t => {
  const up = await upstream(t, async (req, res) => { let body = ''; for await (const c of req) body += c; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ echo: body, method: req.method, auth: req.headers.authorization })); });
  const fetcher = createKeepAliveFetch();
  t.after(() => fetcher.close());
  const first = await fetcher(up.url + '/a', { method: 'POST', headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, body: '{"q":1}' });
  assert.equal(first.ok, true); assert.equal(first.status, 200); assert.equal(first.headers.get('content-type'), 'application/json');
  assert.deepEqual(await first.json(), { echo: '{"q":1}', method: 'POST', auth: 'Bearer x' });
  await pause(4500);
  const second = await fetcher(up.url + '/b');
  assert.equal((await second.json()).method, 'GET');
  assert.equal(up.connections(), 1, 'the second request reused the warm connection');
});

test('the keep-alive fetch streams the body as it arrives, aborts on its signal and never follows a redirect', async t => {
  const up = await upstream(t, async (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/elsewhere' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: one\n\n'); await pause(200); res.end('data: two\n\n');
  });
  const fetcher = createKeepAliveFetch();
  t.after(() => fetcher.close());
  const began = Date.now(), response = await fetcher(up.url + '/stream');
  const chunks = []; for await (const chunk of response.body) chunks.push([Date.now() - began, String(chunk)]);
  assert.equal(chunks[0][1], 'data: one\n\n'); assert.ok(chunks[0][0] < 150, 'the first event is read before the reply ends');
  assert.equal((await fetcher(up.url + '/redirect', { redirect: 'error' })).ok, false);
  const controller = new AbortController();
  const slow = fetcher(up.url + '/stream', { signal: controller.signal }).then(async r => { for await (const _ of r.body); });
  await pause(50); controller.abort();
  await assert.rejects(slow, error => error.name === 'AbortError');
});

test('/tts bytes reach the page while the voice is still arriving; the full clip is cached on completion and served from it next time', async t => {
  let calls = 0;
  const up = await upstream(t, async (req, res) => {
    calls++; for await (const _ of req);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.write(Buffer.from('first-')); await pause(300); res.end(Buffer.from('second'));
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'era-tts-stream-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'clip.mp3');
  const page = http.createServer((req, res) => {
    streamSpeech({ fetch: globalThis.fetch, url: up.url + '/v1/text-to-speech/voice/stream', headers: { 'Content-Type': 'application/json' }, body: '{}', cacheFile, res })
      .catch(() => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
  });
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
  t.after(async () => { page.closeAllConnections(); await new Promise(resolve => page.close(resolve)); });
  const base = `http://127.0.0.1:${page.address().port}/tts`;
  const began = Date.now(), response = await fetch(base, { method: 'POST' });
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  const reader = response.body.getReader(), first = await reader.read();
  assert.equal(Buffer.from(first.value).toString(), 'first-'); assert.ok(Date.now() - began < 250, 'first bytes before the clip is complete');
  await assert.rejects(fs.stat(cacheFile), 'nothing is cached before the clip completes');
  let rest = ''; for (let r = await reader.read(); !r.done; r = await reader.read()) rest += Buffer.from(r.value).toString();
  assert.equal(rest, 'second');
  for (let i = 0; i < 50 && !(await fs.stat(cacheFile).catch(() => null)); i++) await pause(10);
  assert.equal(await fs.readFile(cacheFile, 'utf8'), 'first-second');
  assert.equal(Buffer.from(await (await fetch(base, { method: 'POST' })).arrayBuffer()).toString(), 'first-second');
  assert.equal(calls, 1, 'the second say came from the cache');
});

test('/tts: a voice service that fails before or during the clip leaves no cache; a refusal is an error before any byte', async t => {
  const up = await upstream(t, async (req, res) => {
    for await (const _ of req);
    if (req.url.includes('refuse')) { res.writeHead(401).end(); return; }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.write('partial-'); await pause(30); res.destroy();
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'era-tts-stream-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const res = { headersSent: false, writeHead() { this.headersSent = true; return this; }, write() { return true; }, end() {}, destroy() { this.destroyed = true; }, on() {}, once() {} };
  await assert.rejects(streamSpeech({ url: up.url + '/refuse', headers: {}, body: '{}', cacheFile: path.join(dir, 'a.mp3'), res }));
  assert.equal(res.headersSent, false);
  await assert.rejects(streamSpeech({ url: up.url + '/cut', headers: {}, body: '{}', cacheFile: path.join(dir, 'b.mp3'), res }));
  assert.deepEqual(await fs.readdir(dir), [], 'no partial clip and no temporary file is left behind');
});

test('the real hub /tts asks the saved-voice service\'s streaming endpoint and answers the second say from its cache', { timeout: 60000 }, async t => {
  const { spawn } = await import('node:child_process');
  const seen = [];
  const voice = await upstream(t, async (req, res) => { for await (const _ of req); seen.push(req.url); res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.write('ab'); await pause(20); res.end('cd'); });
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'era-tts-hub-'));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  await fs.writeFile(path.join(data, 'tts-config.json'), JSON.stringify({ apiKey: 'stand-in-voice-key', keyOk: true }));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const hub = new URL('../', import.meta.url).pathname;
  const child = spawn(process.execPath, [path.join(hub, 'server.js'), String(port)], { cwd: hub, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, ERA_DATA_DIR: data, ERA_BIND: '127.0.0.1', ERA_DEVICE_ID: 'tts-hub', ERA_CHAT_CONFIG_DISABLED: '1', ERA_POOL_DIR: '', ERA_ELEVEN_URL: voice.url } });
  t.after(() => child.kill('SIGKILL'));
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/version`)).ok; } catch { await pause(100); } }
  assert.ok(up);
  const say = async () => Buffer.from(await (await fetch(`http://127.0.0.1:${port}/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Let us play outside.' }) })).arrayBuffer()).toString();
  assert.equal(await say(), 'abcd');
  assert.equal(await say(), 'abcd');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^\/v1\/text-to-speech\/[A-Za-z0-9]+\/stream\?output_format=/);
});

test('error answers never jam the keep-alive pool: nine refusals in a row, then the tenth request still goes through', { timeout: 20000 }, async t => {
  let n = 0;
  const up = await upstream(t, async (req, res) => { for await (const _ of req); n++; if (n <= 9) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":"busy"}'); return; } res.writeHead(200); res.end('ok'); });
  const fetcher = createKeepAliveFetch();
  t.after(() => fetcher.close());
  for (let i = 0; i < 9; i++) assert.equal((await fetcher(up.url + '/x', { method: 'POST', body: '{}' })).ok, false); // bodies never read, as callers do
  const last = await Promise.race([fetcher(up.url + '/x'), pause(3000).then(() => null)]);
  assert.ok(last, 'the tenth request was not stuck behind unread error bodies');
  assert.equal(await last.text(), 'ok');
});

test('/tts: a voice service that stalls mid-clip is cut off by the timeout and leaves no cache', async t => {
  const up = await upstream(t, async (req, res) => { for await (const _ of req); res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.write('stuck-'); });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'era-tts-stall-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const res = { headersSent: false, writeHead() { this.headersSent = true; return this; }, write() { return true; }, end() {}, destroy() {}, on() {}, once() {} };
  await assert.rejects(streamSpeech({ fetch: createKeepAliveFetch(), url: up.url + '/stall', headers: {}, body: '{}', cacheFile: path.join(dir, 'c.mp3'), res, timeoutMs: 150 }));
  assert.deepEqual(await fs.readdir(dir), []);
});
