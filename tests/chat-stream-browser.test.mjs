// The real Chat page against the real hub Chat module (real-time chat spec
// 2026-10-27 §3, §4): held-question audio over the session WebSocket, a
// streamed turn end to end (partials, speculation, streamed choices, saved
// voice), and the reveal: a sealed batch shows at once wherever the gaze is. Every service is an owned loopback fixture: a
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

// A recognizer child that answers finish with the scripted question (or, while
// `answers` lasts, the next scripted words: '' is a hold where nothing was heard).
function scriptedRuntime(log, answers = []) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _, next) {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      const message = JSON.parse(line); log.push(message.type);
      if (message.type === 'finish') setTimeout(() => child.stdout.write(JSON.stringify({ type: 'final', generation: message.generation, text: answers.length ? answers.shift() : QUESTION,
        timings: { audioMs: 400, activityMs: 2, cloudMs: 20, finalDecodeMs: 22 } }) + '\n'), 20);
    }
    next();
  } });
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 0)); };
  setTimeout(() => child.stdout.write(JSON.stringify({ type: 'ready', capabilities: { remoteFinal: true } }) + '\n'), 10);
  return child;
}

// In the page: when the sealed batch reached it (the hub's batch-sealed event,
// or the one-shot /choices answer), each staged choice, and every change of the
// reply tiles with the dwell settle at that instant. A reveal is a new set.
function revealProbe() {
  const now = () => performance.now();
  window.__sealed = []; window.__staged = []; window.__reveals = [];
  const Native = window.EventSource;
  window.EventSource = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => { try { const data = JSON.parse(event.data);
        if (data.type === 'batch-sealed') window.__sealed.push(now()); if (data.type === 'choice-staged') window.__staged.push(now()); } catch { /* not ours */ } });
    }
  };
  const nativeFetch = window.fetch.bind(window);
  // The made sets (Ask a question / Make a comment, spec 2026-10-28 §3) are asked for after a reveal: not a batch.
  const made = init => { try { return !!JSON.parse(init?.body || '{}').mode; } catch { return false; } };
  window.fetch = async (...args) => { const r = await nativeFetch(...args); if (String(args[0]).includes('/chat/api/choices') && !made(args[1])) window.__sealed.push(now()); return r; };
  document.addEventListener('DOMContentLoaded', () => {
    let last = '';
    new MutationObserver(() => {
      const labels = [...document.querySelectorAll('#grid .response .label')].map(label => label.textContent), key = labels.join('|');
      if (key && key !== last) { const dwell = window.Dwell?.state() || {}; window.__reveals.push({ at: now(), labels, suppressedMs: dwell.suppressedMs, target: dwell.target }); }
      last = key;
    }).observe(document.body, { childList: true, subtree: true });
  });
}
const probe = page => page.evaluate(() => ({ sealed: window.__sealed, staged: window.__staged, reveals: window.__reveals }));
// In the page: every microphone the page opened (and whether it is still live),
// a switch that refuses the next request as a browser permission refusal does,
// and every look the Ask button had (its words, enabled or not, shown or not).
function micProbe() {
  window.__gum = 0; window.__tracks = []; window.__deny = false; window.__askLooks = [];
  const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    window.__gum++;
    if (window.__deny) throw new DOMException('Permission denied', 'NotAllowedError');
    const stream = await native(constraints); window.__tracks.push(...stream.getTracks()); return stream;
  };
  document.addEventListener('DOMContentLoaded', () => {
    const ask = document.querySelector('#ask');
    const look = () => { const value = { text: ask.textContent, disabled: ask.disabled, hidden: ask.hidden }, last = window.__askLooks.at(-1);
      if (!last || last.text !== value.text || last.disabled !== value.disabled || last.hidden !== value.hidden) window.__askLooks.push(value); };
    look(); new MutationObserver(look).observe(ask, { attributes: true, childList: true, characterData: true, subtree: true });
  });
}
const sessionsOpened = f => f.requests.filter(line => line === 'POST /chat/api/sessions').length;
const liveTracks = page => page.evaluate(() => window.__tracks.filter(track => track.readyState === 'live').length);
// The reveal shows the sealed batch within the 250 ms settle (plus scheduling slack).
const REVEAL_SLACK_MS = 300;

async function fixture(t, { env = {}, runtimeLog = [], apiOptions = {}, answers = [] } = {}) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-stream-browser-'));
  const store = createChatStore({ dataDir: scratch });
  const api = createChatApi({ env: { ERA_CHAT_RUNTIME: 'scripted', ERA_CHAT_RUNTIME_ARGS: '[]', ...env }, spawn: () => scriptedRuntime(runtimeLog, answers), ...apiOptions });
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
  await context.addInitScript(revealProbe); await context.addInitScript(micProbe);
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  const sockets = []; page.on('websocket', ws => { const entry = { url: ws.url(), sent: 0, closed: false }; sockets.push(entry); ws.on('framesent', () => entry.sent++); ws.on('close', () => { entry.closed = true; }); });
  const cdp = await context.newCDPSession(page);
  const press = async selector => {
    const box = await page.locator(selector).boundingBox(); assert.ok(box, selector);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
  };
  const lift = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const touchCancel = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  // No Start Chat (maintainer, 10/27 evening): opening Chat prepares it, with no touch at all.
  async function start() {
    await page.goto(base + '/chat/');
    await page.waitForFunction(() => document.body.dataset.storageReady === 'true' && document.querySelector('#engineNote').textContent.includes('set up'));
    await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask' && !document.querySelector('#ask').disabled, null, { timeout: 10000 });
  }
  async function hold(ms = 500) { await press('#ask'); await page.waitForTimeout(ms); await lift(); }
  return { page, base, requests, ttsTexts, sockets, errors, runtimeLog, start, hold, press, lift, touchCancel, api, scratch };
}

test('Chat prepares itself on load (Preparing…, then Hold to ask); a held question travels over the session socket; leaving the page closes it', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.start();
  for (const id of ['startChat', 'desktopStart', 'endChat']) assert.equal(await f.page.locator('#' + id).count(), 0, `no #${id}: Chat starts itself`);
  const looks = await f.page.evaluate(() => window.__askLooks);
  const preparing = looks.findIndex(look => look.text === 'Preparing…' && look.disabled), ready = looks.findIndex(look => look.text === 'Hold to ask' && !look.disabled);
  assert.ok(preparing >= 0 && ready > preparing, 'Ask reads Preparing… until Ready to ask: ' + JSON.stringify(looks));
  assert.equal(looks.slice(0, ready).some(look => !look.disabled), false, 'Ask is never enabled while preparing');
  assert.equal(sessionsOpened(f), 1, 'one session, opened with no partner action');
  assert.equal(await liveTracks(f.page), 1, 'the microphone is open between turns');
  await f.page.waitForTimeout(150);
  assert.equal(f.sockets.length, 1, 'one audio socket per session');
  assert.match(f.sockets[0].url, /\/chat\/api\/sessions\/[a-f0-9-]+\/audio$/);
  assert.equal(f.sockets[0].sent, 0, 'no audio is sent before a hold');
  await f.hold(600);
  await f.page.waitForSelector('.response', { timeout: 10000 });
  assert.ok(f.sockets[0].sent > 0, 'frames were sent on the socket');
  assert.equal(f.requests.filter(line => /\/audio$/.test(line) && line.startsWith('POST')).length, 0, 'no per-frame POSTs');
  const audio = f.runtimeLog.filter(type => type === 'audio').length;
  assert.ok(audio > 0);
  assert.ok(f.runtimeLog.lastIndexOf('audio') < f.runtimeLog.indexOf('finish'), 'every frame reached the recognizer before finish');
  const errors = [...f.errors];
  await f.page.goto(f.base + '/');
  for (let i = 0; i < 100 && !(f.sockets[0].closed && f.requests.some(line => /^DELETE \/chat\/api\/sessions\//.test(line))); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(f.sockets[0].closed, true, 'leaving closes the audio socket');
  assert.ok(f.requests.some(line => /^DELETE \/chat\/api\/sessions\//.test(line)), 'leaving ends the session');
  assert.deepEqual(errors, []);
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
  assert.equal(await liveTracks(f.page), 0, 'hiding closes the microphone');
  // Coming back prepares Chat again by itself: a new session, the microphone, Ready to ask.
  const show = () => f.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await show();
  await f.page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask' && !document.querySelector('#ask').disabled, null, { timeout: 10000 });
  assert.equal(sessionsOpened(f), 2); assert.equal(f.sockets.length, 2); assert.equal(await liveTracks(f.page), 1);
  // A page restored from the back/forward cache (pageshow) prepares too.
  await f.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  for (let i = 0; i < 50 && !f.sockets[1].closed; i++) await f.page.waitForTimeout(20);
  await f.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await f.page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask' && !document.querySelector('#ask').disabled, null, { timeout: 10000 });
  assert.equal(sessionsOpened(f), 3);
  await f.hold(600);
  await f.page.waitForSelector('.response', { timeout: 10000 });
  assert.deepEqual(f.errors, []);
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
    // The made sets (spec 2026-10-28 §3) go to the model too, after the reveal; only the replies are recorded here.
    const data = JSON.parse(JSON.parse(init.body).input); if (!data.mode) calls.push(data.question);
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

test('a streamed turn end to end: partials heard so far, staged voices warm before the reveal, the sealed batch shows once with no gaze on the page', { timeout: 60000 }, async t => {
  const words = 'What should we do after lunch?';
  const service = await turnsService(t, words), reply = replyService();
  const f = await fixture(t, { env: { ERA_CHAT_STREAM_PROTOCOL: 'ws-streaming-turns', ERA_CHAT_STREAM_URL: service.url, ERA_CHAT_STREAM_MODEL: 'stream-model',
    ERA_CHAT_STREAM_TOKEN: 'stream-secret', ERA_CHAT_SPECULATE_MS: '50',
    ERA_CHAT_TEXT_URL: 'https://reply.invalid/responses', ERA_CHAT_TEXT_MODEL: 'reply-model', ERA_CHAT_TEXT_TOKEN: 'reply-secret' }, apiOptions: { fetch: reply.fetcher } });
  await f.start(); // no gaze or mouse ever moves on the page
  await f.press('#ask');
  await f.page.waitForFunction(() => document.querySelector('#diagnostics').textContent.startsWith('Heard so far'), null, { timeout: 10000 });
  await f.page.waitForTimeout(400);
  await f.lift();
  await f.page.waitForSelector('.response', { timeout: 10000 });
  assert.deepEqual(await f.page.locator('.response .label').allTextContents(), ['Play outside', 'Read', 'Not sure']);
  await f.page.waitForTimeout(400);
  const { sealed, staged, reveals } = await probe(f.page);
  assert.equal(staged.length, 3, 'the choices streamed one by one'); assert.equal(sealed.length, 1, 'the hub sealed once, when the stream ended');
  assert.ok(sealed[0] >= Math.max(...staged), 'the seal follows the last staged choice');
  assert.deepEqual(reveals.map(r => r.labels), [['Play outside', 'Read', 'Not sure']], 'one reveal per turn, never a partial batch');
  assert.ok(reveals[0].at - sealed[0] <= REVEAL_SLACK_MS, `revealed ${Math.round(reveals[0].at - sealed[0])} ms after the seal`);
  // The hub staged the replies; the page asked only for the two made sets, after the reveal (spec 2026-10-28 §3).
  assert.equal(f.requests.filter(line => line.startsWith('POST /chat/api/choices')).length, 2, 'the hub staged the replies; the page asked only for the made sets');
  // Speculation ran on the stable partials; the last one matched the final and was kept (no request after it).
  assert.equal(reply.calls.at(-1), 'what should we do after lunch', 'the kept speculation was on the stable partial');
  for (const say of ['Let us play outside.', 'I want to read.', 'I am not sure.']) assert.ok(f.ttsTexts.includes(say), 'voice warmed for ' + say);
  assert.equal(f.runtimeLog.includes('finish'), false, 'the one-shot recognizer was not needed');
  const html = await f.page.content();
  assert.ok(!html.includes('stream-secret') && !html.includes('reply-secret'));
  assert.deepEqual(f.errors, []);
});

// The cell where the first reply lands (the stable frame's top-left reply area,
// public/chat/frame.js replyAreas(4)[0]): a waiting tile while replies prepare.
const firstReplyCell = page => page.evaluate(() => {
  const r = [...document.querySelectorAll('#grid .tile.waiting')].find(el => el.style.gridArea === '2 / 2 / 3 / 8').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
// Slow the one-shot replies so the gaze is parked before they seal.
const slowChoices = (page, ms = 400) => page.route('**/chat/api/choices', async route => { await new Promise(r => setTimeout(r, ms)); await route.continue(); });

test('the batch shows at once with the gaze parked on a tile cell; dwell cannot select during the 250 ms settle', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await slowChoices(f.page);
  await f.start();
  await f.page.evaluate(() => {
    window.__suppress = []; const original = window.Dwell.suppress; window.Dwell.suppress = ms => { window.__suppress.push(ms); return original(ms); };
    window.Dwell.set({ ms: 100 }); // a fast dwell, so only the settle can hold a selection back
    window.__activations = []; document.addEventListener('dwell:activate', () => window.__activations.push(performance.now()));
  });
  await f.hold(500);
  await f.page.waitForFunction(() => document.querySelector('#phase').textContent === 'Preparing', null, { timeout: 10000 });
  const cell = await firstReplyCell(f.page);
  await f.page.mouse.move(cell.x, cell.y); // her gaze sits on the tile cell where a reply will land
  await f.page.evaluate(({ x, y }) => {
    // From the reveal on, her gaze keeps moving on that cell, as an eye tracker's samples do.
    const watch = new MutationObserver(() => {
      if (!document.querySelector('#grid .response')) return;
      watch.disconnect();
      const until = performance.now() + 800;
      const timer = setInterval(() => { document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
        if (performance.now() > until) clearInterval(timer); }, 16);
    });
    watch.observe(document.querySelector('#grid'), { childList: true });
  }, cell);
  await f.page.waitForSelector('.response', { timeout: 5000 });
  await f.page.waitForTimeout(900);
  const { sealed, reveals } = await probe(f.page);
  assert.equal(reveals.length, 1);
  assert.ok(reveals[0].at - sealed.at(-1) <= REVEAL_SLACK_MS, `revealed ${Math.round(reveals[0].at - sealed.at(-1))} ms after the replies arrived`);
  assert.ok(reveals[0].suppressedMs > 150 && reveals[0].suppressedMs <= 250, `the reveal redraw settles 250 ms (${reveals[0].suppressedMs})`);
  assert.equal(reveals[0].target, null, 'nothing is armed as the batch lands');
  assert.ok((await f.page.evaluate(() => window.__suppress)).includes(250));
  const activations = await f.page.evaluate(() => window.__activations);
  assert.ok(activations.length >= 1, 'after the settle the gaze can select (the probe is live)');
  assert.ok(activations[0] - reveals[0].at >= 250, `no selection inside the settle (first at ${Math.round(activations[0] - reveals[0].at)} ms)`);
  assert.deepEqual(f.errors, []);
});

test('the batch shows at once with no gaze on the page at all', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await slowChoices(f.page);
  await f.start();
  await f.page.mouse.move(5, 5); await f.page.mouse.move(-50, -50); // the cursor left the page
  await f.page.evaluate(() => document.documentElement.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' })));
  await f.hold(500);
  await f.page.waitForSelector('.response', { timeout: 5000 });
  const { sealed, reveals } = await probe(f.page);
  assert.equal(reveals.length, 1);
  assert.ok(reveals[0].at - sealed.at(-1) <= REVEAL_SLACK_MS, `revealed ${Math.round(reveals[0].at - sealed.at(-1))} ms after the replies arrived`);
  assert.equal(await f.page.locator('#phase').textContent(), 'Your turn');
  assert.deepEqual(f.errors, []);
});

test('a finish the hub refuses (409) shows the partner the recovery wording, never a raw code', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.page.route('**/control', async route => {
    const body = route.request().postDataJSON();
    if (body?.type === 'finish') return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'capture-inactive' }) });
    return route.continue();
  });
  await f.start();
  await f.hold(500);
  await f.page.waitForFunction(() => /did not finish/i.test(document.querySelector('#notice').textContent), null, { timeout: 10000 });
  const notice = await f.page.locator('#notice').textContent();
  assert.doesNotMatch(notice, /capture-inactive/);
  assert.doesNotMatch(notice, /start Chat/i, 'there is no Start Chat to point at');
  assert.match(notice, /hold Ask/i);
  assert.equal(await f.page.locator('#ask').isDisabled(), false, 'the next hold starts Chat again by itself');
});

// ---- a slip on Ask never ends the session (touchscreen field report 10/27) ----
// A finger that rolls off, a palm, a long press or a too-quick tap cancels only
// that hold: back to Ready to ask with a hint, the same session and socket, and
// the cancelled hold's audio is dropped (never a short submit).
const notice = f => f.page.locator('#notice').textContent();
async function holdRow(f, predicate) {
  for (let i = 0; i < 200; i++) {
    const state = await fs.readFile(path.join(f.scratch, 'chat-state.json'), 'utf8').then(JSON.parse, () => null);
    const row = (state?.value.timings || []).find(value => value.kind === 'hold' && predicate(value));
    if (row) return row;
    await f.page.waitForTimeout(50);
  }
  return null;
}
async function stillOn(f) {
  assert.equal(sessionsOpened(f), 1, 'the same Chat session');
  assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0].closed, false, 'the audio socket stays open');
  assert.equal(await f.page.locator('#ask').isDisabled(), false, 'Ask stays armed');
  assert.equal(await f.page.locator('#startChat').count(), 0, 'there is no Start Chat');
}
async function nextHoldWorks(f) {
  await f.hold(600);
  await f.page.waitForSelector('.response', { timeout: 10000 });
  assert.equal(await f.page.locator('#phase').textContent(), 'Your turn');
  assert.equal(sessionsOpened(f), 1);
}

test('a cancelled touch on Ask returns to Ready to ask with a hint; the session stays and the next hold works', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.start();
  await f.press('#ask'); await f.page.waitForTimeout(600);
  await f.touchCancel();
  await f.page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask', null, { timeout: 5000 });
  assert.match(await notice(f), /Hold while you speak, let go when done/);
  await f.page.waitForTimeout(200);
  assert.equal(f.runtimeLog.includes('finish'), false, 'a cancelled hold never submits');
  assert.ok(f.runtimeLog.includes('cancel'), 'the recognizer dropped the hold');
  await stillOn(f);
  const row = await holdRow(f, value => ['cancelled', 'failed'].includes(value.status));
  assert.deepEqual([row?.status, row?.reason], ['cancelled', 'cancel']);
  await nextHoldWorks(f);
  assert.equal(f.runtimeLog.filter(type => type === 'finish').length, 1);
  assert.deepEqual(f.errors, []);
});

test('a hold let go too soon (under 400 ms) never submits: Ready to ask with "Let go too soon", cancelled as short', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.start();
  await f.hold(150);
  await f.page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask', null, { timeout: 5000 });
  assert.match(await notice(f), /Let go too soon — hold while you speak/);
  await f.page.waitForTimeout(300);
  assert.equal(f.runtimeLog.includes('finish'), false, 'a too-short hold never submits');
  await stillOn(f);
  const row = await holdRow(f, value => ['cancelled', 'failed'].includes(value.status));
  assert.deepEqual([row?.status, row?.reason], ['cancelled', 'short']);
  await nextHoldWorks(f);
  assert.deepEqual(f.errors, []);
});

test('no question heard returns to Ready to ask with the session kept, and the next hold works', { timeout: 60000 }, async t => {
  const f = await fixture(t, { answers: [''] });
  await f.start();
  await f.hold(600);
  await f.page.waitForFunction(() => /No question was heard/.test(document.querySelector('#notice').textContent), null, { timeout: 10000 });
  assert.equal(await f.page.locator('#phase').textContent(), 'Ready to ask');
  await stillOn(f);
  const row = await holdRow(f, value => ['cancelled', 'failed'].includes(value.status));
  assert.deepEqual([row?.status, row?.reason], ['failed', 'recognition']);
  await nextHoldWorks(f);
  assert.equal(f.runtimeLog.filter(type => type === 'finish').length, 2);
  assert.deepEqual(f.errors, []);
});

test('Ask keeps its finger: no long-press menu, no selection or drag, touch-action none', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.start();
  const prevented = await f.page.evaluate(() => Object.fromEntries(['contextmenu', 'selectstart', 'dragstart'].map(type => {
    const event = type === 'dragstart' ? new DragEvent(type, { bubbles: true, cancelable: true }) : type === 'contextmenu'
      ? new MouseEvent(type, { bubbles: true, cancelable: true }) : new Event(type, { bubbles: true, cancelable: true });
    document.querySelector('#ask').dispatchEvent(event); return [type, event.defaultPrevented];
  })));
  assert.deepEqual(prevented, { contextmenu: true, selectstart: true, dragstart: true });
  const style = await f.page.evaluate(() => { const s = getComputedStyle(document.querySelector('#ask')); return { touchAction: s.touchAction, userSelect: s.userSelect }; });
  assert.deepEqual(style, { touchAction: 'none', userSelect: 'none' });
  // A menu event never cancels a hold in progress either.
  await f.press('#ask'); await f.page.waitForTimeout(300);
  await f.page.evaluate(() => document.querySelector('#ask').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await f.page.waitForTimeout(300); await f.lift();
  await f.page.waitForSelector('.response', { timeout: 10000 });
  assert.deepEqual(f.errors, []);
});

// ---- no Start Chat (maintainer, 10/27 evening: "It adds one more unnecessary step") ----
// The hub's own clock, frozen until the test moves it: the idle sweep runs every
// second, and nothing expires until the clock jumps past the 30-minute lifetime.
function hubClock() {
  const frozen = Date.now(); let offset = 0;
  return { clock: () => frozen + offset, jump: ms => { offset += ms; } };
}
const askReady = page => page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask' && !document.querySelector('#ask').disabled, null, { timeout: 10000 });
const framesHeard = f => f.runtimeLog.filter(type => type === 'audio').length;

test('the 30-minute lifetime still ends a session; the next hold re-creates it silently and its whole question is heard', { timeout: 60000 }, async t => {
  const time = hubClock();
  const f = await fixture(t, { apiOptions: { clock: time.clock, limits: { idleMs: 1000 } } });
  await f.start();
  time.jump(31 * 60 * 1000);
  for (let i = 0; i < 150 && !f.sockets[0].closed; i++) await f.page.waitForTimeout(20);
  assert.equal(f.sockets[0].closed, true, 'the hub ended the expired session');
  await f.page.waitForTimeout(300);
  assert.equal(await f.page.locator('#phase').textContent(), 'Ready to ask', 'standing by, not Off');
  assert.equal(await f.page.locator('#ask').isDisabled(), false);
  assert.doesNotMatch(await notice(f), /ended|closed|unavailable|again/i, 'the lifetime ending is silent');
  assert.equal(sessionsOpened(f), 1, 'no new session until a hold asks for one');
  assert.equal(await liveTracks(f.page), 1, 'the prepared microphone stays open between turns');
  const before = framesHeard(f);
  await f.hold(800);
  await f.page.waitForSelector('.response', { timeout: 10000 });
  assert.equal(sessionsOpened(f), 2, 'the hold re-created the session');
  assert.equal(await f.page.evaluate(() => window.__gum), 1, 'the same microphone carried the hold');
  assert.ok(framesHeard(f) - before >= 7, `the whole held question reached the recognizer (${framesHeard(f) - before} frames for 800 ms)`);
  assert.equal(f.runtimeLog.filter(type => type === 'finish').length, 1, 'submitted once');
  assert.deepEqual(f.errors, []);
});

test('a hold whose session cannot start is dropped with a hint, submits nothing, and the page stays usable; the next hold works', { timeout: 60000 }, async t => {
  const time = hubClock();
  const f = await fixture(t, { apiOptions: { clock: time.clock, limits: { idleMs: 1000 } } });
  await f.start();
  time.jump(31 * 60 * 1000);
  for (let i = 0; i < 150 && !f.sockets[0].closed; i++) await f.page.waitForTimeout(20);
  let refused = 0;
  await f.page.route('**/chat/api/sessions', route => { if (route.request().method() !== 'POST' || refused) return route.continue(); refused++;
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'runtime-unavailable' }) }); });
  await f.hold(800);
  await f.page.waitForFunction(() => /could not get ready/i.test(document.querySelector('#notice').textContent), null, { timeout: 10000 });
  assert.equal(refused, 1);
  assert.equal(await f.page.locator('#phase').textContent(), 'Ready to ask');
  assert.equal(await f.page.locator('#ask').isDisabled(), false, 'Ask stays usable');
  assert.equal(f.runtimeLog.includes('finish'), false, 'nothing was submitted');
  assert.equal(await f.page.locator('#grid .tile.static').count() > 0, true, 'phrases are still on the board');
  const row = await holdRow(f, value => ['cancelled', 'failed'].includes(value.status));
  assert.equal(row?.status, 'failed');
  await f.hold(700);
  await f.page.waitForSelector('.response', { timeout: 10000 });
  assert.equal(sessionsOpened(f), 2);
  assert.deepEqual(f.errors, []);
});

test('a refused microphone shows the truthful message; Ask gives way to a touch-only Try again that prepares Chat', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.page.addInitScript(() => { window.__deny = true; });
  await f.page.goto(f.base + '/chat/');
  await f.page.waitForFunction(() => /Microphone permission was not granted/.test(document.querySelector('#notice').textContent), null, { timeout: 10000 });
  assert.ok(await f.page.evaluate(() => window.__gum) >= 1, 'the page asked for the microphone by itself');
  assert.equal(await f.page.locator('#ask').isVisible(), false, 'Ask is not offered');
  assert.equal(await f.page.locator('#ask').isDisabled(), true);
  assert.equal(await f.page.locator('#retryChat').isVisible(), true);
  assert.equal(await f.page.locator('#retryChat').textContent(), 'Try again');
  assert.equal(sessionsOpened(f), 0, 'no session without a microphone');
  await f.page.evaluate(() => { window.__deny = false; });
  await f.page.locator('#retryChat').click(); await f.page.waitForTimeout(400);
  assert.equal(sessionsOpened(f), 0, 'a gaze or mouse click cannot try again');
  await f.press('#retryChat'); await f.lift();
  await askReady(f.page);
  assert.equal(await f.page.locator('#retryChat').isVisible(), false);
  assert.equal(sessionsOpened(f), 1);
  await f.hold(600);
  await f.page.waitForSelector('.response', { timeout: 10000 });
  assert.deepEqual(f.errors, []);
});

test('Pause microphone (partner settings, touch only) closes capture and the session; the next hold prepares Chat again', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.start();
  await f.page.locator('#partnerOpen').click();
  await f.page.locator('#pauseMic').click(); await f.page.waitForTimeout(300);
  assert.equal(await liveTracks(f.page), 1, 'a gaze or mouse click does not pause');
  await f.press('#pauseMic'); await f.lift();
  for (let i = 0; i < 100 && (await liveTracks(f.page)) > 0; i++) await f.page.waitForTimeout(20);
  assert.equal(await liveTracks(f.page), 0, 'the microphone is closed');
  for (let i = 0; i < 50 && !f.sockets[0].closed; i++) await f.page.waitForTimeout(20);
  assert.equal(f.sockets[0].closed, true);
  await f.page.locator('#partnerDialog .close').click();
  assert.match(await notice(f), /paused/i);
  assert.equal(await f.page.locator('#ask').isDisabled(), false, 'a hold turns it back on');
  await f.page.waitForTimeout(300);
  assert.equal(sessionsOpened(f), 1, 'paused stays paused until a hold');
  await f.hold(900);
  await f.page.waitForSelector('.response', { timeout: 10000 });
  assert.equal(sessionsOpened(f), 2); assert.equal(await f.page.evaluate(() => window.__gum), 2);
  assert.equal(await liveTracks(f.page), 1);
  assert.deepEqual(f.errors, []);
});

test('a hold waits on the device for a session start for about 3 s at most, then is dropped whole, never submitted short', { timeout: 60000 }, async t => {
  const time = hubClock();
  const f = await fixture(t, { apiOptions: { clock: time.clock, limits: { idleMs: 1000 } } });
  await f.start();
  time.jump(31 * 60 * 1000);
  for (let i = 0; i < 150 && !f.sockets[0].closed; i++) await f.page.waitForTimeout(20);
  let slowed = 0;
  await f.page.route('**/chat/api/sessions', async route => { if (route.request().method() !== 'POST' || slowed) return route.continue(); slowed++;
    await new Promise(resolve => setTimeout(resolve, 4500)); return route.continue(); });
  await f.press('#ask');
  await f.page.waitForFunction(() => /could not get ready/i.test(document.querySelector('#notice').textContent), null, { timeout: 6000 });
  await f.lift();
  assert.equal(slowed, 1);
  await askReady(f.page); // the slow session still arrives, ready for the next hold
  assert.equal(f.runtimeLog.includes('finish'), false, 'the over-long wait submitted nothing');
  assert.equal(framesHeard(f), 0, 'no frame of the dropped hold left the device');
  await f.hold(700);
  await f.page.waitForSelector('.response', { timeout: 10000 });
  assert.deepEqual(f.errors, []);
});

// Listen for <name> (stable frame §8) against the real hub module: an ear
// service that hears the wake name in the room once enough frames arrived.
async function earService(t, words, atFrame = 6) {
  const connections = [];
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    const ws = acceptWebSocket(req, socket, head), conn = { frames: 0, ws }; connections.push(conn);
    ws.send(JSON.stringify({ type: 'Begin' }));
    ws.on('message', (data, binary) => {
      if (binary) { conn.frames++; if (conn.frames === atFrame) ws.send(JSON.stringify({ type: 'Turn', turn_order: 0, end_of_turn: true, turn_is_formatted: true, transcript: words })); return; }
      const value = JSON.parse(data);
      if (value.type === 'Terminate') { ws.send(JSON.stringify({ type: 'Termination' })); setTimeout(() => ws.close(1000), 5); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const c of connections) c.ws.terminate(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  return { url: `ws://127.0.0.1:${server.address().port}/v3/ws`, connections };
}

test('Listen for Ellie through the real hub: the switch opens the ear, room frames flow with no hold, a wake question reveals its replies, off stops the frames', { timeout: 60000 }, async t => {
  const service = await earService(t, 'Ellie, would you like music or a story?'), reply = replyService();
  const f = await fixture(t, { env: { ERA_CHAT_STREAM_PROTOCOL: 'ws-streaming-turns', ERA_CHAT_STREAM_URL: service.url, ERA_CHAT_STREAM_MODEL: 'stream-model',
    ERA_CHAT_STREAM_TOKEN: 'stream-secret', ERA_CHAT_SPECULATE_MS: '0',
    ERA_CHAT_TEXT_URL: 'https://reply.invalid/responses', ERA_CHAT_TEXT_MODEL: 'reply-model', ERA_CHAT_TEXT_TOKEN: 'reply-secret' }, apiOptions: { fetch: reply.fetcher } });
  await f.start();
  const toggle = f.page.locator('#wakeToggle');
  assert.equal(await toggle.isDisabled(), false, 'the hub offers the wake word'); assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  await f.page.waitForTimeout(200); assert.equal(f.sockets[0].sent, 0, 'nothing is sent with the switch off');
  await f.press('#wakeToggle'); await f.page.waitForTimeout(60); await f.lift();
  await f.page.waitForFunction(() => document.body.dataset.ear === 'on', null, { timeout: 10000 });
  assert.match(await f.page.locator('#phase').textContent(), /^Listening for /);
  await f.page.waitForSelector('#grid .response', { timeout: 15000 });
  assert.ok(f.sockets[0].sent >= 6, 'room frames flowed with no hold');
  // An either-or question: the hub's own alternatives answer it.
  assert.deepEqual(await f.page.locator('#grid .response .label').allTextContents(), ['Music', 'A story']);
  assert.match(await f.page.locator('#grid .tile.question .label').textContent(), /music or a story/i, 'the strip shows the question after her name');
  await f.press('#wakeToggle'); await f.page.waitForTimeout(60); await f.lift();
  await f.page.waitForFunction(() => document.body.dataset.ear === 'off', null, { timeout: 10000 });
  await f.page.waitForTimeout(300); const sent = f.sockets[0].sent; await f.page.waitForTimeout(600);
  assert.equal(f.sockets[0].sent, sent, 'no frames once the switch is off');
  assert.deepEqual(f.errors, []);
});
