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

// A 16 kHz mono wav from [ms, tone?] segments: the fake microphone loops it.
function segmentsWav(segments) {
  const rate = 16000, samples = segments.reduce((n, [ms]) => n + Math.round(rate * ms / 1000), 0), wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  let i = 0;
  for (const [ms, tone] of segments) for (let n = 0; n < Math.round(rate * ms / 1000); n++, i++)
    wav.writeInt16LE(tone ? Math.round(Math.sin(i * Math.PI * 2 * 300 / rate) * 6000) : 0, 44 + i * 2);
  return wav;
}

async function fixture(t, { script = {}, streaming = true, limits = {}, deny = false, audio = null } = {}) {
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
  const wav = path.join(scratch, 'microphone.wav'); await fs.writeFile(wav, audio || makeChatToneWav());
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
  // Her gaze resting on one spot: the mouse at an element's centre.
  async function lookAt(selector) {
    const box = await page.locator(selector).first().boundingBox(); assert.ok(box, selector);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  }
  // A dwell that never completes inside a test: a gaze on a tile fills it and never picks it.
  const slowDwell = () => page.evaluate(() => { const set = window.Dwell.set; window.Dwell.set = o => set({ ...o, ms: 600000 }); set({ ms: 600000 }); });
  // Each shown reply: [label, grid column, grid row].
  const shown = () => page.locator('.response').evaluateAll(nodes => nodes.map(node => [node.textContent, node.style.gridColumn, node.style.gridRow]));
  return { page, base, api, service, requests, controls, ttsTexts, errors, press, lift, load, until, ask, restOnCentre, sessions, lookAt, slowDwell, shown };
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

// ---- T2.3 the partner's three lines ----

test('no stream settings: "Streaming speech is not set up on this device", no tone, no microphone', { timeout: 60000 }, async t => {
  const f = await fixture(t, { streaming: false });
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  f.ask();
  await f.page.waitForFunction(() => document.querySelector('#notice').textContent === 'Streaming speech is not set up on this device', null, { timeout: 10000 });
  assert.equal(await f.page.evaluate(() => window.__tones.length), 0);
  assert.equal(f.sessions(), 0);
});

test('no stream settings while another screen shows: the press goes to Chat, then shows the line (review fix)', { timeout: 60000 }, async t => {
  const f = await fixture(t, { streaming: false });
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  await f.page.locator('.route', { hasText: 'Reactions' }).click();
  await f.page.waitForFunction(() => [...document.querySelectorAll('.route')].some(el => el.textContent === 'Back to Chat'));
  f.ask();
  await f.page.waitForFunction(() => document.querySelector('#notice').textContent === 'Streaming speech is not set up on this device', null, { timeout: 10000 });
  assert.ok(await f.page.locator('.route', { hasText: 'Help me say it' }).count(), 'the Chat screen is showing');
  assert.equal(await f.page.locator('.route', { hasText: 'Back to Chat' }).count(), 0);
  assert.equal(f.sessions(), 0);
  assert.deepEqual(f.errors, []);
});

test('a session started by touch without streaming speech: a press shows the line and leaves the session open (review fix)', { timeout: 60000 }, async t => {
  const f = await fixture(t, { streaming: false });
  // The page is told streaming exists; the session it gets has none (a stream lost after load).
  await f.page.route('**/chat/api/config', async route => {
    const response = await route.fetch(); const body = await response.json();
    body.runtime = { ...body.runtime, capabilities: { ...(body.runtime?.capabilities || {}), streaming: true } };
    await route.fulfill({ response, json: body });
  });
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  await f.press('#startChat'); await f.lift();
  await f.page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask', null, { timeout: 10000 });
  f.ask();
  await f.page.waitForFunction(() => document.querySelector('#notice').textContent === 'Streaming speech is not set up on this device', null, { timeout: 10000 });
  await f.page.waitForTimeout(500);
  assert.equal(await f.page.locator('#phase').textContent(), 'Ready to ask', 'the session is still ready');
  assert.equal(await f.page.locator('#startChat').isDisabled(), true, 'the session someone started is still running');
  assert.equal(await f.page.locator('#endChat').isDisabled(), false);
  assert.equal(f.requests.filter(line => /^DELETE \/chat\/api\/sessions\//.test(line)).length, 0, 'no session was closed');
  assert.equal(f.sessions(), 1);
  assert.equal(await f.page.evaluate(() => window.__tones.length), 0);
  assert.deepEqual(f.errors, []);
});

test('microphone refused: "Touch Start Chat once to allow the microphone", no tone', { timeout: 60000 }, async t => {
  const f = await fixture(t, { deny: true });
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  f.ask();
  await f.page.waitForFunction(() => document.querySelector('#notice').textContent === 'Touch Start Chat once to allow the microphone', null, { timeout: 10000 });
  await f.page.waitForTimeout(300);
  assert.equal(await f.page.evaluate(() => window.__tones.length), 0);
  assert.equal(f.controls.includes('window'), false);
});

test('nothing said: the window closes, "Didn\'t hear a question" for 4 s, nothing submitted, Chat ready again', { timeout: 60000 }, async t => {
  const f = await fixture(t, { limits: { windowSilenceMs: 1500 } });
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  f.ask();
  await f.page.waitForFunction(() => document.body.dataset.listening === 'true', null, { timeout: 15000 });
  await f.page.waitForFunction(() => document.querySelector('#notice').textContent === "Didn't hear a question", null, { timeout: 10000 });
  const shownAt = Date.now();
  assert.equal(await f.page.evaluate(() => document.body.dataset.listening), 'false');
  assert.equal(await f.page.locator('#phase').textContent(), 'Ready to ask');
  assert.equal(f.requests.filter(line => line === 'POST /chat/api/choices').length, 0, 'nothing submitted');
  const sent = f.service.connections.reduce((n, c) => n + c.frames, 0);
  await f.page.waitForFunction(() => document.querySelector('#notice').textContent !== "Didn't hear a question", null, { timeout: 8000 });
  const shown = Date.now() - shownAt;
  assert.ok(shown >= 3500 && shown <= 5500, `shown ${shown} ms`);
  assert.equal(f.service.connections.reduce((n, c) => n + c.frames, 0), sent, 'the microphone closed with the window');
  // Ready for the next press at once, in the same session.
  f.ask();
  await f.page.waitForFunction(() => document.body.dataset.listening === 'true', null, { timeout: 10000 });
  assert.equal(f.sessions(), 1);
  assert.deepEqual(f.errors, []);
});

// ---- T2.4 the tones ----

test('two tones per window, rising then falling, and nothing is spoken while listening', { timeout: 60000 }, async t => {
  const f = await fixture(t, { script: { 6: [turn('do you want chicken or fish')], 7: [turn('do you want chicken or fish', { end: true })] }, limits: { windowSilenceMs: 1500 } });
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  await f.page.waitForTimeout(300); // the fixed phrases' voices warm at load, before any press
  f.ask();
  await f.page.waitForFunction(() => document.body.dataset.listening === 'true', null, { timeout: 15000 });
  const toneAt = Date.now();
  await f.page.waitForFunction(() => document.querySelector('#diagnostics').textContent.startsWith('Question:'), null, { timeout: 10000 });
  // The sealed batch's own clips warm the moment it is staged, which can beat this check; any other voice would be one fetched while listening.
  const fetched = f.ttsTexts.filter(entry => entry.at >= toneAt && !['Chicken', 'Fish'].includes(entry.text)).map(entry => entry.text);
  assert.deepEqual(fetched, [], 'no voice is fetched between the tone and the first seal');
  await f.page.waitForFunction(() => document.body.dataset.listening === 'false', null, { timeout: 10000 });
  await f.page.waitForFunction(() => window.__tones.length === 2, null, { timeout: 2000 });
  const tones = await f.page.evaluate(() => window.__tones.map(({ from, to }) => [from, to]));
  assert.deepEqual(tones, [[660, 880], [880, 660]], 'the listening tone, then the done tone');
  assert.deepEqual(await f.page.evaluate(() => [window.__plays, window.__speaks]), [0, 0], 'nothing spoke during the window');
  assert.equal(await f.page.locator('.response').count(), 0, 'the batch waits for her gaze in the black centre');
  await f.restOnCentre();
  await f.page.waitForSelector('.response', { timeout: 5000 });
  assert.deepEqual(await f.page.locator('.response .label').allTextContents(), ['Chicken', 'Fish']);
  assert.deepEqual(await f.page.evaluate(() => [window.__plays, window.__speaks]), [0, 0], 'revealing speaks nothing');
});

test('the tones are drawn, not shipped: no audio files in the Chat page', async () => {
  const files = await fs.readdir(path.join(root, 'public', 'chat'));
  assert.deepEqual(files.filter(name => /\.(wav|mp3|ogg|m4a|aac|flac|opus|webm)$/i.test(name)), []);
});

// ---- T3.4 her pick ends the window ----

test('her pick while the window listens: pick reaches the hub before anything speaks, the window closes, the tile is spoken', { timeout: 60000 }, async t => {
  const f = await fixture(t, { script: { 4: [turn('do you want chicken or fish', { end: true })] } });
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  await f.restOnCentre();
  f.ask();
  await f.page.waitForSelector('.response', { timeout: 15000 });
  assert.equal(await f.page.evaluate(() => document.body.dataset.listening), 'true', 'still listening after the first batch');
  const plays = await f.page.evaluate(() => window.__plays);
  await f.page.locator('.response', { hasText: 'Fish' }).click();
  await f.page.waitForFunction(() => document.body.dataset.listening === 'false', null, { timeout: 5000 });
  await f.until(() => f.controls.includes('cancel'));
  assert.ok(f.controls.indexOf('pick') >= 0 && f.controls.indexOf('pick') < f.controls.lastIndexOf('cancel'), f.controls.join(','));
  await f.until(() => f.ttsTexts.some(entry => entry.text === 'Fish'));
  await f.page.waitForFunction(n => window.__plays > n, plays, { timeout: 5000 });
  assert.equal(f.api.window(), null, 'the hub closed the window');
  assert.deepEqual(await f.page.evaluate(() => window.__tones.map(({ from }) => from)), [660, 880]);
  assert.deepEqual(f.errors, []);
});

// ---- T3.6 utterances, batches and the close, all through the command stream ----

test('a question with a pause inside it stays one utterance: under 1.5 s of quiet never seals', { timeout: 60000 }, async t => {
  // Speech 0.8 s, quiet 1.0 s, again and again; the service's end of turn comes only after the whole question.
  const f = await fixture(t, { audio: segmentsWav([[800, true], [1000, false]]),
    script: { 5: [turn('do you want')], 20: [turn('do you want chicken or fish')], 30: [turn('do you want chicken or fish', { end: true })] } });
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  f.ask();
  await f.page.waitForFunction(() => document.querySelector('#diagnostics').textContent.startsWith('Question:'), null, { timeout: 20000 });
  assert.equal(await f.page.locator('#diagnostics').textContent(), 'Question: do you want chicken or fish', 'one utterance: the pause did not cut the question');
  await f.page.waitForTimeout(500);
  assert.equal(f.api.window() !== null, true, 'still listening');
});

test('with no end of turn from the service, 1.5 s of real quiet after speech seals the utterance (the hub energy gate)', { timeout: 60000 }, async t => {
  const f = await fixture(t, { audio: segmentsWav([[1000, true], [6000, false]]),
    script: { 3: [turn('is it time for lunch')], 8: [turn('is it time for lunch')] } });
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  await f.restOnCentre();
  f.ask();
  await f.page.waitForSelector('.response', { timeout: 20000 });
  assert.deepEqual(await f.page.locator('.response .label').allTextContents(), ['Yes', 'No', "I'm not sure", 'Please say that again']);
  assert.equal(await f.page.evaluate(() => document.body.dataset.listening), 'true', 'sealed by the quiet, not by the window closing');
});

test('a second utterance before she has seen the first batch replaces it unseen: chicken, fish and pasta together', { timeout: 60000 }, async t => {
  const f = await fixture(t, { script: { 4: [turn('do you want chicken or fish', { end: true })], 10: [turn('or pasta', { order: 1 })], 12: [turn('or pasta', { order: 1, end: true })] } });
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  await f.page.mouse.move(5, 5); // her gaze is off the board: nothing is revealed yet
  f.ask();
  await f.page.waitForFunction(() => document.querySelector('#diagnostics').textContent === 'Question: do you want chicken or fish or pasta', null, { timeout: 15000 });
  await f.page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Replies ready'), null, { timeout: 10000 });
  assert.equal(await f.page.locator('.response').count(), 0);
  await f.restOnCentre();
  await f.page.waitForSelector('.response', { timeout: 5000 });
  assert.deepEqual(await f.page.locator('.response .label').allTextContents(), ['Chicken', 'Fish', 'Pasta']);
  assert.equal(await f.page.evaluate(() => document.body.dataset.listening), 'true', 'still listening after both seals');
});

// ---- T4.3 the neutral moment ----

const pastaLater = { 4: [turn('do you want chicken or fish', { end: true })], 25: [turn('or pasta', { order: 1 })], 27: [turn('or pasta', { order: 1, end: true })] };

test('a replacement waits with no upper bound while her gaze rests on a tile, and swaps when it leaves for the black centre', { timeout: 60000 }, async t => {
  const f = await fixture(t, { script: pastaLater });
  await f.load(); await f.slowDwell();
  await f.until(() => f.api.commands.state().connected);
  await f.restOnCentre();
  f.ask();
  await f.page.waitForSelector('.response', { timeout: 15000 });
  const before = await f.shown();
  assert.deepEqual(before, [['Chicken', '2', '1'], ['Fish', '3', '1']]);
  await f.lookAt('.response >> text=Chicken');
  await f.page.waitForFunction(() => document.body.dataset.replacing === 'true', null, { timeout: 15000 });
  assert.notEqual(await f.page.evaluate(() => window.Dwell.state().target), null, 'a dwell is filling Chicken');
  await f.page.waitForTimeout(5000);
  assert.deepEqual(await f.shown(), before, 'five seconds on a tile: nothing changed or appeared');
  assert.equal(await f.page.evaluate(() => document.body.dataset.replacing), 'true', 'still waiting');
  await f.restOnCentre();
  await f.page.waitForFunction(() => document.body.dataset.replacing === 'false', null, { timeout: 5000 });
  assert.deepEqual(await f.shown(), [['Chicken', '2', '1'], ['Fish', '3', '1'], ['Pasta', '1', '2']], 'chicken and fish stayed put; pasta took a free cell');
  assert.deepEqual(f.errors, []);
});

// ---- T4.4 replacement batches through the command stream ----

// Every redraw of the board after the first reveal, with the dwell then in progress.
const watchRedraws = page => page.evaluate(() => {
  window.__redraws = [];
  new MutationObserver(() => window.__redraws.push(window.Dwell.state().target)).observe(document.querySelector('#grid'), { childList: true });
});

test('a second utterance replaces the batch only after a neutral move', { timeout: 60000 }, async t => {
  const f = await fixture(t, { script: pastaLater });
  await f.load(); await f.slowDwell();
  await f.until(() => f.api.commands.state().connected);
  await f.restOnCentre();
  f.ask();
  await f.page.waitForSelector('.response', { timeout: 15000 });
  await f.lookAt('.response >> text=Fish');
  await watchRedraws(f.page);
  await f.page.waitForFunction(() => document.body.dataset.replacing === 'true', null, { timeout: 15000 });
  await f.page.waitForTimeout(1000);
  assert.deepEqual(await f.shown(), [['Chicken', '2', '1'], ['Fish', '3', '1']], 'her gaze is on Fish: nothing moves');
  assert.deepEqual(await f.page.evaluate(() => window.__redraws), [], 'not one redraw while she dwells');
  // Her gaze leaves the board for the status line: no tile, and the dwell she left fades out first.
  await f.lookAt('#phase');
  await f.page.waitForFunction(() => document.body.dataset.replacing === 'false', null, { timeout: 5000 });
  assert.deepEqual(await f.shown(), [['Chicken', '2', '1'], ['Fish', '3', '1'], ['Pasta', '1', '2']]);
  const redraws = await f.page.evaluate(() => window.__redraws);
  assert.ok(redraws.length >= 1 && redraws.every(target => target === null), `every redraw with no dwell in progress: ${JSON.stringify(redraws)}`);
  assert.deepEqual(await f.page.evaluate(() => [window.__plays, window.__speaks]), [0, 0], 'the swap speaks nothing');
  assert.deepEqual(f.errors, []);
});

test('a pick during a pending replacement wins: the shown tile is spoken, the replacement is dropped, the window closes', { timeout: 60000 }, async t => {
  const f = await fixture(t, { script: pastaLater });
  await f.load(); await f.slowDwell();
  await f.until(() => f.api.commands.state().connected);
  await f.restOnCentre();
  f.ask();
  await f.page.waitForSelector('.response', { timeout: 15000 });
  await f.lookAt('.response >> text=Chicken');
  await f.page.waitForFunction(() => document.body.dataset.replacing === 'true', null, { timeout: 15000 });
  const plays = await f.page.evaluate(() => window.__plays);
  await f.page.locator('.response', { hasText: 'Fish' }).click();
  await f.page.waitForFunction(() => document.body.dataset.listening === 'false', null, { timeout: 5000 });
  assert.equal(await f.page.evaluate(() => document.body.dataset.replacing), 'false', 'the replacement was dropped');
  await f.until(() => f.ttsTexts.some(entry => entry.text === 'Fish'));
  await f.page.waitForFunction(n => window.__plays > n, plays, { timeout: 5000 });
  await f.page.waitForTimeout(500);
  assert.equal(await f.page.evaluate(() => window.__plays), plays + 1, 'one clip played: the picked tile, nothing after it');
  assert.ok(f.controls.includes('pick'), f.controls.join(','));
  await f.until(() => f.api.window() === null);
  await f.restOnCentre();
  await f.page.waitForTimeout(600);
  assert.deepEqual(await f.shown(), [['Chicken', '2', '1'], ['Fish', '3', '1']], 'the black centre brings nothing back');
  assert.deepEqual(f.errors, []);
});

test('a press while her gaze rests on a tile from the last turn: the tiles stay until her gaze leaves, then clear; listening starts at once (review fix)', { timeout: 60000 }, async t => {
  const f = await fixture(t, { script: { 4: [turn('do you want chicken or fish', { end: true })] }, limits: { windowSilenceMs: 4000 } });
  await f.load(); await f.slowDwell();
  await f.until(() => f.api.commands.state().connected);
  await f.restOnCentre();
  f.ask();
  await f.page.waitForSelector('.response', { timeout: 15000 });
  await f.page.waitForFunction(() => document.body.dataset.listening === 'false', null, { timeout: 15000 });
  const before = await f.shown();
  assert.deepEqual(before, [['Chicken', '2', '1'], ['Fish', '3', '1']]);
  await f.lookAt('.response >> text=Chicken');
  await f.page.waitForFunction(() => window.Dwell.state().target != null, null, { timeout: 5000 });
  await f.page.evaluate(() => { for (const el of document.querySelectorAll('#grid .tile')) el.__before = true; });
  await watchRedraws(f.page);
  f.ask();
  await f.page.waitForFunction(() => document.body.dataset.listening === 'true', null, { timeout: 15000 });
  await f.page.waitForTimeout(1000);
  assert.deepEqual(await f.shown(), before, 'her gaze is on Chicken: the last turn\'s tiles stay');
  assert.deepEqual(await f.page.evaluate(() => window.__redraws), [], 'not one redraw while she dwells');
  assert.equal(await f.page.evaluate(() => [...document.querySelectorAll('#grid .tile')].every(el => el.__before)), true, 'the same tiles, not redrawn copies');
  await f.lookAt('#phase');
  await f.page.waitForFunction(() => document.querySelectorAll('.response').length === 0, null, { timeout: 5000 });
  const redraws = await f.page.evaluate(() => window.__redraws);
  assert.ok(redraws.length >= 1 && redraws.every(target => target === null), `every redraw with no dwell in progress: ${JSON.stringify(redraws)}`);
  assert.deepEqual(f.errors, []);
});

test('a dwell that completes on an old tile after a press speaks it as her pick: the window closes as a pick, nothing waits to replace it (review fix)', { timeout: 60000 }, async t => {
  const f = await fixture(t, { script: { 4: [turn('do you want chicken or fish', { end: true })] }, limits: { windowSilenceMs: 4000 } });
  await f.load(); await f.slowDwell();
  await f.until(() => f.api.commands.state().connected);
  await f.restOnCentre();
  f.ask();
  await f.page.waitForSelector('.response', { timeout: 15000 });
  await f.page.waitForFunction(() => document.body.dataset.listening === 'false', null, { timeout: 15000 });
  await f.lookAt('.response >> text=Fish');
  await f.page.waitForFunction(() => window.Dwell.state().target != null, null, { timeout: 5000 });
  // The session's events as the page receives them.
  const events = [], cdp = await f.page.context().newCDPSession(f.page);
  await cdp.send('Network.enable');
  cdp.on('Network.eventSourceMessageReceived', ({ data }) => { try { events.push(JSON.parse(data)); } catch { /* not an event */ } });
  f.ask();
  await f.page.waitForFunction(() => document.body.dataset.listening === 'true', null, { timeout: 15000 });
  assert.deepEqual(await f.shown(), [['Chicken', '2', '1'], ['Fish', '3', '1']], 'the old tiles still show under her gaze');
  const plays = await f.page.evaluate(() => window.__plays);
  const pickAt = f.controls.length;
  // Her dwell on Fish completes now.
  await f.page.evaluate(() => window.Dwell.setMs(300));
  await f.until(() => f.ttsTexts.some(entry => entry.text === 'Fish'));
  await f.page.waitForFunction(n => window.__plays > n, plays, { timeout: 5000 });
  await f.page.waitForFunction(() => document.body.dataset.listening === 'false', null, { timeout: 5000 });
  assert.ok(f.controls.slice(pickAt).includes('pick'), `the window closed as a pick: ${f.controls.slice(pickAt).join(',')}`);
  await f.until(() => f.api.window() === null);
  await f.until(() => events.some(e => e.type === 'window-closed'));
  assert.deepEqual(events.filter(e => e.type === 'window-closed').map(e => e.reason), ['pick'], 'window-closed {reason: pick}');
  assert.equal(await f.page.evaluate(() => document.body.dataset.replacing), 'false', 'no replacement pending');
  await f.page.waitForTimeout(1500);
  assert.notEqual(await f.page.locator('#phase').textContent(), 'Preparing', 'nothing of the window waits to be revealed');
  assert.equal(await f.page.evaluate(() => window.__plays), plays + 1, 'one clip: the picked tile');
  assert.deepEqual(f.errors, []);
});

// ---- T4.5 the on-screen Hold to ask is inert while a window is open ----

test('a partner touch on Hold to ask during a listening window does nothing: no hold, the session lives', { timeout: 60000 }, async t => {
  const f = await fixture(t, { script: { 4: [turn('do you want chicken or fish', { end: true })] } });
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  await f.restOnCentre();
  f.ask();
  await f.page.waitForSelector('.response', { timeout: 15000 });
  assert.equal(await f.page.evaluate(() => document.body.dataset.listening), 'true');
  assert.equal(await f.page.locator('#ask').isDisabled(), true, 'inert while the window is open');
  await f.press('#ask'); await f.page.waitForTimeout(300); await f.lift();
  await f.page.waitForTimeout(500);
  assert.equal(f.controls.includes('ask'), false, 'no hold was sent');
  assert.equal(f.controls.includes('cancel'), false);
  assert.equal(await f.page.evaluate(() => document.body.dataset.listening), 'true', 'the window still listens');
  assert.notEqual(f.api.window(), null);
  assert.deepEqual(await f.page.locator('.response .label').allTextContents(), ['Chicken', 'Fish']);
  assert.equal(await f.page.locator('#startChat').isDisabled(), true, 'the session is still running');
  await f.page.locator('.response', { hasText: 'Fish' }).click();
  await f.page.waitForFunction(() => document.body.dataset.listening === 'false', null, { timeout: 5000 });
  await f.page.waitForFunction(() => !document.querySelector('#ask').disabled, null, { timeout: 10000 });
  assert.deepEqual(f.errors, []);
});

test('the second press ends the window: the done tone fires, the microphone closes, the batch stays', { timeout: 60000 }, async t => {
  const { createButtons } = require('../buttons.js');
  const f = await fixture(t, { script: { 4: [turn('do you want chicken or fish', { end: true })] } });
  const buttons = createButtons({ enabledChat: () => true, commands: f.api.commands, window: () => f.api.window(),
    kiosk: { foreground: async () => false, relaunch: async () => ({ ok: true }) } });
  await f.load();
  await f.until(() => f.api.commands.state().connected);
  await f.restOnCentre();
  assert.equal((await buttons.press({ key: 'F13', action: 'ask' })).dispatch, 'visible');
  await f.page.waitForSelector('.response', { timeout: 15000 });
  assert.equal((await buttons.press({ key: 'F13', action: 'ask' })).dispatch, 'end', 'the second press');
  await f.page.waitForFunction(() => document.body.dataset.listening === 'false', null, { timeout: 5000 });
  await f.page.waitForFunction(() => window.__tones.length === 2, null, { timeout: 2000 });
  assert.deepEqual(await f.page.evaluate(() => window.__tones.map(({ from, to }) => [from, to])), [[660, 880], [880, 660]]);
  assert.deepEqual(await f.page.locator('.response .label').allTextContents(), ['Chicken', 'Fish'], 'the last batch stays showing');
  assert.equal(await f.page.locator('#phase').textContent(), 'Your turn');
  const sent = f.service.connections.reduce((n, c) => n + c.frames, 0);
  await f.page.waitForTimeout(500);
  assert.equal(f.service.connections.reduce((n, c) => n + c.frames, 0), sent, 'no frame after the close');
  assert.equal(await f.page.evaluate(() => window.__touches), 0);
});
