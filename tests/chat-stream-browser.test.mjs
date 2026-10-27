// The real Chat page against the real hub Chat module (real-time chat spec
// 2026-10-27 §3, §4): held-question audio over the session WebSocket, a
// streamed turn end to end (partials, speculation, streamed choices, saved
// voice), and the reveal gate. Every service is an owned loopback fixture: a
// scripted recognizer child, a fake streaming transcription service, a fake
// streamed reply service and a fake saved voice. No credentials, no paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { makeChatToneWav } from '../tests-vm/lib/chat-ui-smoke.mjs';

const require = createRequire(import.meta.url);
const { createChatApi } = require('../chat-api.js');
const { createChatStore } = require('../chat-store.js');
const { acceptWebSocket } = require('../chat-ws.js');
const root = fileURLToPath(new URL('../', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
const QUESTION = 'Would you like music or a story?';

// A recognizer child that answers finish with the scripted question.
function scriptedRuntime(log) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _, next) {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      const message = JSON.parse(line); log.push(message.type);
      if (message.type === 'finish') setTimeout(() => child.stdout.write(JSON.stringify({ type: 'final', generation: message.generation, text: QUESTION,
        timings: { audioMs: 400, activityMs: 2, cloudMs: 20, finalDecodeMs: 22 } }) + '\n'), 20);
    }
    next();
  } });
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 0)); };
  setTimeout(() => child.stdout.write(JSON.stringify({ type: 'ready', capabilities: { remoteFinal: true } }) + '\n'), 10);
  return child;
}

async function fixture(t, { env = {}, runtimeLog = [], apiOptions = {} } = {}) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-stream-browser-'));
  const store = createChatStore({ dataDir: scratch });
  const api = createChatApi({ env: { ERA_CHAT_RUNTIME: 'scripted', ERA_CHAT_RUNTIME_ARGS: '[]', ...env }, spawn: () => scriptedRuntime(runtimeLog), ...apiOptions });
  const requests = [];
  const ttsTexts = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.method + ' ' + req.url.split('?')[0]);
    try {
      if (store.handle(req, res) || api.handle(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Chat fixture</title>'); return; }
      if (url.pathname === '/settings') return json({ dwellMs: 1200, pauseGoes: 'home', chatTestMode: false });
      if (url.pathname === '/voices') return json({ enabled: true, current: 'synthetic-saved' });
      if (url.pathname === '/tts') { let body = ''; for await (const chunk of req) body += chunk; ttsTexts.push(JSON.parse(body).text); res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(makeChatToneWav()); return; }
      const relative = url.pathname === '/chat/' ? 'chat/index.html' : decodeURIComponent(url.pathname).slice(1);
      if (relative.split(/[\\/]/).some(part => part === '..') || !mime[path.extname(relative)]) { res.writeHead(404).end(); return; }
      const bytes = await fs.readFile(path.join(root, 'public', relative));
      res.writeHead(200, { 'Content-Type': mime[path.extname(relative)] }); res.end(bytes);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  server.on('upgrade', (req, socket, head) => { if (!api.upgrade(req, socket, head)) socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const wav = path.join(scratch, 'microphone.wav'); await fs.writeFile(wav, makeChatToneWav());
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
  t.after(async () => { await browser.close(); api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(scratch, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, hasTouch: true, permissions: ['microphone'] });
  await context.route(url => url.origin !== base, route => route.abort('blockedbyclient'));
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  const sockets = []; page.on('websocket', ws => { const entry = { url: ws.url(), sent: 0, closed: false }; sockets.push(entry); ws.on('framesent', () => entry.sent++); ws.on('close', () => { entry.closed = true; }); });
  const cdp = await context.newCDPSession(page);
  const press = async selector => {
    const box = await page.locator(selector).boundingBox(); assert.ok(box, selector);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
  };
  const lift = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  async function start() {
    await page.goto(base + '/chat/');
    await page.waitForFunction(() => document.body.dataset.storageReady === 'true' && document.querySelector('#engineNote').textContent.includes('set up'));
    await press('#startChat'); await lift();
    await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask', null, { timeout: 10000 });
  }
  async function hold(ms = 500) { await press('#ask'); await page.waitForTimeout(ms); await lift(); }
  async function restOnCentre() {
    const rest = await page.locator('.rest').first().boundingBox();
    await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2);
  }
  return { page, base, requests, ttsTexts, sockets, errors, runtimeLog, start, hold, restOnCentre, press, lift, api };
}

test('a held question travels over the session socket, not per-frame POSTs, and End closes the socket', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.start();
  await f.page.waitForTimeout(150);
  assert.equal(f.sockets.length, 1, 'one audio socket per session');
  assert.match(f.sockets[0].url, /\/chat\/api\/sessions\/[a-f0-9-]+\/audio$/);
  assert.equal(f.sockets[0].sent, 0, 'no audio is sent before a hold');
  await f.hold(600);
  await f.page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Replies ready'), null, { timeout: 10000 });
  assert.ok(f.sockets[0].sent > 0, 'frames were sent on the socket');
  assert.equal(f.requests.filter(line => /\/audio$/.test(line) && line.startsWith('POST')).length, 0, 'no per-frame POSTs');
  const audio = f.runtimeLog.filter(type => type === 'audio').length;
  assert.ok(audio > 0);
  assert.ok(f.runtimeLog.lastIndexOf('audio') < f.runtimeLog.indexOf('finish'), 'every frame reached the recognizer before finish');
  await f.restOnCentre();
  await f.page.waitForSelector('.response');
  await f.press('#endChat'); await f.lift();
  await f.page.waitForFunction(() => document.querySelector('#phase').textContent === 'Off');
  for (let i = 0; i < 50 && !f.sockets[0].closed; i++) await f.page.waitForTimeout(20);
  assert.equal(f.sockets[0].closed, true, 'End closes the audio socket');
  assert.deepEqual(f.errors, []);
});

test('hiding the page closes the socket and cancels a hold in progress', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.start();
  await f.press('#ask'); await f.page.waitForTimeout(300);
  await f.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  for (let i = 0; i < 50 && !f.sockets[0].closed; i++) await f.page.waitForTimeout(20);
  assert.equal(f.sockets[0].closed, true);
  await f.lift();
  await f.page.waitForTimeout(200);
  assert.equal(f.runtimeLog.includes('finish'), false, 'a hidden hold never submits');
});

// A turn-streaming fake service: partials as frames arrive, the question's words at the forced endpoint.
async function turnsService(t, words) {
  const connections = [];
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    const ws = acceptWebSocket(req, socket, head), conn = { frames: 0, ws }; connections.push(conn);
    ws.send(JSON.stringify({ type: 'Begin' }));
    ws.on('message', (data, binary) => {
      const turn = (text, end) => ws.send(JSON.stringify({ type: 'Turn', turn_order: 0, end_of_turn: end, turn_is_formatted: end, transcript: text }));
      if (binary) { conn.frames++; if (conn.frames === 2) turn(words.split(' ').slice(0, 2).join(' '), false); if (conn.frames === 4) turn(words.replace(/[?.!]$/, '').toLowerCase(), false); return; }
      const value = JSON.parse(data);
      if (value.type === 'ForceEndpoint') turn(words, true);
      if (value.type === 'Terminate') { ws.send(JSON.stringify({ type: 'Termination' })); setTimeout(() => ws.close(1000), 5); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const c of connections) c.ws.terminate(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  return { url: `ws://127.0.0.1:${server.address().port}/v3/ws`, connections };
}
// The streamed reply service: one delta every few ms.
function replyService() {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push(JSON.parse(JSON.parse(init.body).input).question);
    const text = JSON.stringify({ choices: [{ label: 'Play outside', say: 'Let us play outside.', symbol: 'chat' }, { label: 'Read', say: 'I want to read.', symbol: 'chat' }, { label: 'Not sure', say: 'I am not sure.', symbol: 'chat' }] });
    const events = []; for (let i = 0; i < text.length; i += 16) events.push({ type: 'response.output_text.delta', delta: text.slice(i, i + 16) });
    events.push({ type: 'response.completed', response: { usage: { input_tokens: 800, output_tokens: 50 } } });
    return new Response(new ReadableStream({ async start(controller) {
      for (const event of events) { if (init.signal.aborted) { controller.error(new Error('aborted')); return; } controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); await new Promise(r => setTimeout(r, 5)); }
      controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetcher, calls };
}

test('a streamed turn end to end: partials heard so far, staged voices warm before the reveal, a resting gaze reveals the sealed batch', { timeout: 60000 }, async t => {
  const words = 'What should we do after lunch?';
  const service = await turnsService(t, words), reply = replyService();
  const f = await fixture(t, { env: { ERA_CHAT_STREAM_PROTOCOL: 'ws-streaming-turns', ERA_CHAT_STREAM_URL: service.url, ERA_CHAT_STREAM_MODEL: 'stream-model',
    ERA_CHAT_STREAM_TOKEN: 'stream-secret', ERA_CHAT_SPECULATE_MS: '50',
    ERA_CHAT_TEXT_URL: 'https://reply.invalid/responses', ERA_CHAT_TEXT_MODEL: 'reply-model', ERA_CHAT_TEXT_TOKEN: 'reply-secret' }, apiOptions: { fetch: reply.fetcher } });
  await f.start();
  await f.restOnCentre(); // her gaze rests in the black centre throughout
  await f.press('#ask');
  await f.page.waitForFunction(() => document.querySelector('#diagnostics').textContent.startsWith('Heard so far'), null, { timeout: 10000 });
  await f.page.waitForTimeout(400);
  await f.lift();
  await f.page.waitForSelector('.response', { timeout: 10000 });
  assert.deepEqual(await f.page.locator('.response .label').allTextContents(), ['Play outside', 'Read', 'Not sure']);
  assert.equal(f.requests.filter(line => line.startsWith('POST /chat/api/choices')).length, 0, 'the hub staged the replies; the page asked for none');
  // Speculation ran on the stable partials; the last one matched the final and was kept (no request after it).
  assert.equal(reply.calls.at(-1), 'what should we do after lunch', 'the kept speculation was on the stable partial');
  for (const say of ['Let us play outside.', 'I want to read.', 'I am not sure.']) assert.ok(f.ttsTexts.includes(say), 'voice warmed for ' + say);
  assert.equal(f.runtimeLog.includes('finish'), false, 'the one-shot recognizer was not needed');
  const html = await f.page.content();
  assert.ok(!html.includes('stream-secret') && !html.includes('reply-secret'));
  assert.deepEqual(f.errors, []);
});

test('the reveal gate: a gaze on a tile cell when the batch seals waits for a move into the centre; the reveal settles 250 ms', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.start();
  await f.page.evaluate(() => { window.__suppress = []; const original = window.Dwell.suppress; window.Dwell.suppress = ms => { window.__suppress.push(ms); return original(ms); }; });
  const yes = await f.page.locator('.tile.yes').boundingBox();
  await f.page.mouse.move(yes.x + yes.width / 2, yes.y + yes.height / 2);
  await f.hold(500);
  await f.page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Replies ready'), null, { timeout: 10000 });
  await f.page.waitForTimeout(600);
  assert.equal(await f.page.locator('.response').count(), 0, 'a gaze on a tile cell never inherits the new batch');
  await f.page.evaluate(() => { window.__suppress = []; });
  await f.restOnCentre();
  await f.page.waitForSelector('.response');
  assert.ok((await f.page.evaluate(() => window.__suppress)).length >= 1);
  assert.ok((await f.page.evaluate(() => window.__suppress)).every(ms => ms === 250), 'the reveal redraw settles 250 ms, not 600');
});

test('a finish the hub refuses (409) shows the partner the recovery wording, never a raw code', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.page.route('**/control', async route => {
    const body = route.request().postDataJSON();
    if (body?.type === 'finish') return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'capture-inactive' }) });
    return route.continue();
  });
  await f.start();
  await f.hold(400);
  await f.page.waitForFunction(() => /start Chat again/i.test(document.querySelector('#notice').textContent), null, { timeout: 10000 });
  const notice = await f.page.locator('#notice').textContent();
  assert.doesNotMatch(notice, /capture-inactive/);
  assert.match(notice, /Ready to ask/);
});
