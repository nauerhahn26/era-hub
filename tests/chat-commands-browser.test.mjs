// The real Chat page asked from the partner's button (design 2026-10-27
// §4.2-§4.6; plan T2.1-T2.4, T3.4-T3.6). The page opens the hub's command
// stream at load, before any session; an `ask` pushed on it (or replayed from
// a relaunch's ?ask=<nonce>) starts Chat with no touch at all: microphone,
// session, a listening window, a listening tone, then frames. The hub's window
// machine seals utterances into batches and closes the window; the page plays
// the done tone. Every service is an owned loopback fixture on an ephemeral
// port (fixture shape of chat-stream-browser.test.mjs): a scripted recognizer
// child, a fake turn-streaming service, a fake saved voice. No touch is ever
// dispatched in these tests unless a test says so.
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
const turn = (text, { end = false, order = 0 } = {}) => ({ type: 'Turn', turn_order: order, end_of_turn: end, turn_is_formatted: end, transcript: text });

function scriptedRuntime() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _, next) { next(); } });
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 0)); };
  setTimeout(() => child.stdout.write(JSON.stringify({ type: 'ready', capabilities: { remoteFinal: true } }) + '\n'), 10);
  return child;
}

// The turn-streaming fake service, scripted by the frame count of each socket.
async function turnsService(t, script = {}) {
  const connections = [];
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    const ws = acceptWebSocket(req, socket, head), conn = { frames: 0, texts: [], ws, firstFrameAt: null };
    connections.push(conn);
    ws.send(JSON.stringify({ type: 'Begin' }));
    ws.on('message', (data, binary) => {
      if (binary) { conn.frames++; conn.firstFrameAt ??= Date.now(); for (const message of script[conn.frames] || []) ws.send(JSON.stringify(message)); return; }
      const value = JSON.parse(data); conn.texts.push(value.type);
      if (value.type === 'Terminate') { ws.send(JSON.stringify({ type: 'Termination' })); setTimeout(() => ws.close(1000), 5); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const c of connections) c.ws.terminate(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  return { url: `ws://127.0.0.1:${server.address().port}/v3/ws`, connections };
}

async function fixture(t, { script = {}, streaming = true, limits = {}, deny = false } = {}) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-commands-browser-'));
  const store = createChatStore({ dataDir: scratch });
  const service = await turnsService(t, script);
  const streamEnv = streaming ? { ERA_CHAT_STREAM_PROTOCOL: 'ws-streaming-turns', ERA_CHAT_STREAM_URL: service.url, ERA_CHAT_STREAM_MODEL: 'stream-model', ERA_CHAT_STREAM_TOKEN: 'stream-secret' } : {};
  const api = createChatApi({ env: { ERA_CHAT_RUNTIME: 'scripted', ERA_CHAT_RUNTIME_ARGS: '[]', ERA_CHAT_SPECULATE_MS: '0', ...streamEnv }, spawn: () => scriptedRuntime(), limits });
  const requests = [], controls = [], ttsTexts = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.method + ' ' + req.url.split('?')[0]);
    try {
      if (req.method === 'POST' && /\/control$/.test(req.url)) {
        // Record the control type, then hand the request on with its body intact.
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks); controls.push(JSON.parse(String(body)).type);
        const replay = Object.assign(new PassThrough(), { method: req.method, url: req.url, headers: req.headers, socket: req.socket });
        replay.end(body);
        if (api.handle(replay, res)) return;
      }
      if (store.handle(req, res) || api.handle(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/settings') return json({ dwellMs: 1200, pauseGoes: 'home', chatTestMode: false });
      if (url.pathname === '/voices') return json({ enabled: true, current: 'synthetic-saved' });
      if (url.pathname === '/tts') { let body = ''; for await (const chunk of req) body += chunk; ttsTexts.push({ text: JSON.parse(body).text, at: Date.now() }); res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(makeChatToneWav()); return; }
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
  // Spies installed before any page script: tones, playback, speech and touches.
  await context.addInitScript(({ deny }) => {
    window.__tones = []; window.__plays = 0; window.__speaks = 0; window.__touches = 0;
    const create = BaseAudioContext.prototype.createOscillator;
    BaseAudioContext.prototype.createOscillator = function () {
      const osc = create.call(this), entry = { at: performance.now(), from: null };
      const set = osc.frequency.setValueAtTime.bind(osc.frequency);
      osc.frequency.setValueAtTime = (value, time) => { if (entry.from === null) entry.from = value; return set(value, time); };
      const ramp = osc.frequency.linearRampToValueAtTime.bind(osc.frequency);
      osc.frequency.linearRampToValueAtTime = (value, time) => { entry.to = value; return ramp(value, time); };
      window.__tones.push(entry); return osc;
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__plays++; return play.call(this); };
    if (window.speechSynthesis) { const speak = speechSynthesis.speak.bind(speechSynthesis); speechSynthesis.speak = u => { window.__speaks++; return speak(u); }; }
    for (const type of ['touchstart', 'pointerdown']) addEventListener(type, e => { if (e.pointerType === 'touch' || type === 'touchstart') window.__touches++; }, true);
    // When listening began, and the frames the page sent after it.
    document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
      if (document.body.dataset.listening === 'true' && window.__listeningAt === undefined) window.__listeningAt = performance.now();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-listening'] }));
    if (deny) navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  }, { deny });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  const press = async selector => {
    const box = await page.locator(selector).boundingBox(); assert.ok(box, selector);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
  };
  const lift = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  async function load(query = '') {
    await page.goto(base + '/chat/' + query);
    await page.waitForFunction(() => document.body.dataset.storageReady === 'true');
  }
  const until = async (check, ms = 10000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };
  const ask = () => api.commands.push({ type: 'ask', pressAt: Date.now(), key: 'F13' });
  async function restOnCentre() {
    const rest = await page.locator('.rest').first().boundingBox();
    await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2);
  }
  const sessions = () => requests.filter(line => line === 'POST /chat/api/sessions').length;
  return { page, base, api, service, requests, controls, ttsTexts, errors, press, lift, load, until, ask, restOnCentre, sessions };
}

// ---- T2.1 the command stream ----

test('the page opens the command stream at load, before any session, and reports its visibility', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  assert.deepEqual(f.api.commands.state(), { connected: true, visible: true });
  assert.equal(f.sessions(), 0, 'no session, no microphone, before a press');
  await f.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await f.until(() => f.api.commands.state().visible === false);
  await f.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await f.until(() => f.api.commands.state().visible === true);
  assert.deepEqual(f.errors, []);
});

test('a relaunch nonce in ?ask= is claimed once and stripped from the address; a reload never asks again', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const nonce = f.api.commands.issue({ pressAt: Date.now(), key: 'F13' });
  await f.load('?ask=' + nonce);
  await f.until(() => f.page.evaluate(() => !location.search.includes('ask=')));
  assert.equal(f.api.commands.pending(nonce), false, 'the hub spent the nonce');
  await f.until(() => f.sessions() === 1);
  await f.page.waitForFunction(() => document.body.dataset.listening === 'true', null, { timeout: 15000 });
  await f.page.reload();
  await f.page.waitForFunction(() => document.body.dataset.storageReady === 'true');
  await f.until(() => f.api.commands.state().connected);
  await f.page.waitForTimeout(800);
  assert.equal(f.sessions(), 1, 'the reload did not ask again');
  assert.equal(await f.page.evaluate(() => document.body.dataset.listening), 'false');
});

test('a newer page replaces this one on the stream: this one stops listening for commands', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  const other = await fetch(f.base + '/chat/api/commands');
  await f.page.waitForTimeout(300);
  await other.body.cancel();
  await f.page.waitForTimeout(1500);
  assert.equal(f.api.commands.state().connected, false, 'the replaced page did not reconnect and fight');
});

// ---- T2.2 ask from the button ----

test('an ask push starts a session with no touch: microphone, session, window, tone, then frames 200 ms after the tone', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  assert.equal(f.sessions(), 0);
  f.ask();
  await f.page.waitForFunction(() => document.body.dataset.listening === 'true', null, { timeout: 15000 });
  assert.equal(await f.page.locator('#phase').textContent(), 'Listening');
  assert.equal(f.sessions(), 1);
  assert.ok(f.controls.includes('window'), 'the page opened a listening window');
  assert.equal(f.controls.includes('ask'), false, 'never a hold');
  await f.until(() => f.service.connections.some(c => c.frames > 2));
  const timing = await f.page.evaluate(() => ({ tone: window.__tones[0], listeningAt: window.__listeningAt, touches: window.__touches }));
  assert.equal(timing.touches, 0, 'no touch anywhere');
  assert.deepEqual([timing.tone.from, timing.tone.to], [660, 880], 'the rising listening tone');
  assert.ok(timing.listeningAt - timing.tone.at >= 360, `frames began ${Math.round(timing.listeningAt - timing.tone.at)} ms after the tone started (180 ms tone + 200 ms)`);
  assert.equal(await f.page.locator('#startChat').isDisabled(), true, 'the session is the one Start Chat would have made');
  assert.deepEqual(f.errors, []);
});

test('a hidden page refuses an ask, as Start Chat does', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  await f.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await f.until(() => f.api.commands.state().visible === false);
  f.ask();
  await f.page.waitForTimeout(1000);
  assert.equal(f.sessions(), 0);
  assert.equal(await f.page.evaluate(() => window.__tones.length), 0);
});

test('an ask with a session already running goes straight to listening; a second ask while listening is ignored by the page', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.load();
  await f.press('#startChat'); await f.lift();
  await f.page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask', null, { timeout: 10000 });
  f.ask();
  await f.page.waitForFunction(() => document.body.dataset.listening === 'true', null, { timeout: 10000 });
  f.ask();
  await f.page.waitForTimeout(500);
  assert.equal(f.sessions(), 1);
  assert.equal(f.controls.filter(type => type === 'window').length, 1);
});
