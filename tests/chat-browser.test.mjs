// Full Chat page with owned loopback fixtures. No hub, credentials or paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { checkInstalledChatUI, checkRestoredChatState, waitForChatState, makeChatToneWav, assertContentFreeMetrics } from '../tests-vm/lib/chat-ui-smoke.mjs';

const { createChatStore } = createRequire(import.meta.url)('../chat-store.js');

const root = fileURLToPath(new URL('../', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const alternatives = { kind: 'alternatives', choices: [{ id: 'one', label: 'Music', say: 'Music' }, { id: 'two', label: 'A story', say: 'A story' }], timings: { totalMs: 7 } };
function serve(dataDir, options = {}) {
  const store = createChatStore({ dataDir });
  const timers = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'PUT' && req.url === '/chat/api/state' && options.delayStateResponse) {
        const end = res.end;
        res.end = function (bytes, ...rest) {
          const state = JSON.parse(String(bytes));
          if (!Array.isArray(state.value?.timings)) return end.call(res, bytes, ...rest);
          const delay = options.delayStateResponse(state);
          let sent = false;
          res.once('close', () => options.onStateResponseClose?.(state, !sent));
          const send = () => { sent = true; return end.call(res, bytes, ...rest); };
          if (!delay) return send();
          const timer = setTimeout(() => { timers.delete(timer); send(); }, delay);
          timers.add(timer); return res;
        };
      }
      if (store.handle(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Chat fixture</title>'); return; }
      if (url.pathname === '/settings') return json({ dwellMs: 1200, pauseGoes: 'home' });
      if (url.pathname === '/chat/api/config') return json({ runtime: { available: true, kind: 'built-in' }, choices: { available: true } });
      if (url.pathname === '/chat/api/choices' && req.method === 'POST') {
        let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 8192) throw Error(); }
        const input = JSON.parse(text); assert.match(input.text, /music|story/i); return json(alternatives);
      }
      const relative = url.pathname === '/chat/' ? 'chat/index.html' : decodeURIComponent(url.pathname).slice(1);
      if (relative.split(/[\\/]/).some(part => part === '..') || !mime[path.extname(relative)]) { res.writeHead(404).end(); return; }
      const bytes = await fs.readFile(path.join(root, 'public', relative));
      res.writeHead(200, { 'Content-Type': mime[path.extname(relative)] }); res.end(bytes);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  server.once('close', () => { for (const timer of timers) clearTimeout(timer); });
  return server;
}

test('combined Chat page validates icons, deliberate saved playback, timing privacy, held capture and timeout recovery', { timeout: 90000 }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-ui-'));
  const artifacts = process.env.ERA_CHAT_UI_OUT;
  if (artifacts) await fs.mkdir(artifacts, { recursive: true });
  const wav = path.join(scratch, 'microphone.wav'); await fs.writeFile(wav, makeChatToneWav());
  const server = serve(scratch); server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(scratch, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, hasTouch: true, permissions: ['microphone'], acceptDownloads: true });
  let negativeControlRequests = 0, unexpectedForeignRequests = 0;
  // Allowed fixture requests need no context callback. A terminal continue on
  // the same route as a page handler races removal of in-flight page routes.
  await context.route(url => url.origin !== base, route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://blocked.invalid' && url.pathname === '/isolation-control') negativeControlRequests++;
    else unexpectedForeignRequests++;
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  // Snapshot and cleanup on an inert owned page: no unscoped Chat prefetch.
  await page.goto(base + '/');
  assert.equal(await page.evaluate(() => fetch('https://blocked.invalid/isolation-control').then(() => false, () => true)), true);
  assert.equal(negativeControlRequests, 1, 'the foreign request is intercepted and blocked');
  const report = await checkInstalledChatUI(page, { baseURL: base }); assert.equal(report.ok, true);
  // The shared installed-UI helper restores its routes/storage after its test.
  // This second pass owns a simulated recognizer with the real capture graph.
  const controls = [], uploaded = [], choiceBodies = [], spokenTexts = []; let generation = 0, sequence = 0, stalled = false, releaseUpload, sessionPosts = 0;
  await page.addInitScript(() => {
    window.__eventSources = 0;
    window.EventSource = class { constructor() { window.__timingEvents = this; window.__eventSources++; } close() { this.closed = true; } };
  });
  await page.route('**/voices', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, current: 'synthetic-saved' }) }));
  await page.route('**/tts', route => { try { spokenTexts.push(route.request().postDataJSON().text); } catch {} return route.fulfill({ status: 200, contentType: 'audio/wav', body: makeChatToneWav() }); });
  await page.route('**/chat/api/**', async route => {
    const req = route.request(), url = new URL(req.url()); let result = {};
    if (url.pathname === '/chat/api/state') return route.continue();
    if (url.pathname.endsWith('/config')) result = { runtime: { available: true, kind: 'built-in' }, choices: { available: true } };
    else if (url.pathname.endsWith('/sessions') && req.method() === 'POST') { sessionPosts++; generation = 0; sequence = 0; result = { id: 'private-browser-session' }; }
    else if (url.pathname.endsWith('/control')) {
      const body = req.postDataJSON(); controls.push(body.type); if (body.type !== 'finish') generation++;
      result = { generation };
    } else if (url.pathname.endsWith('/audio')) {
      assert.equal(Number(url.searchParams.get('seq')), sequence); sequence++;
      uploaded.push(req.postDataBuffer().length); result = { seq: sequence };
      if (stalled) await new Promise(resolve => { releaseUpload = resolve; });
    } else if (url.pathname.endsWith('/choices')) { choiceBodies.push(req.postDataJSON()); result = alternatives; }
    else result = { ready: true, mode: 'paused' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) }).catch(() => {});
  });
  await page.goto(base + '/chat/'); await page.waitForFunction(() => document.body.dataset.storageReady === 'true' && document.querySelector('#engineNote').textContent.includes('set up'));
  const cdp = await context.newCDPSession(page);
  async function down(selector) {
    const box = await page.locator(selector).boundingBox(); assert.ok(box);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
  }
  const up = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  // No Start Chat: the page opened its session by itself; the simulated recognizer says ready.
  async function ready() {
    await page.waitForFunction(() => window.__timingEvents && !window.__timingEvents.closed);
    await page.evaluate(() => window.__timingEvents.onmessage({ data: JSON.stringify({ type: 'ready', capabilities: { remoteFinal: true } }) }));
    await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask' && !document.querySelector('#ask').disabled);
  }
  async function finishHold() {
    const before = controls.filter(type => type === 'finish').length;
    await down('#ask'); await page.waitForTimeout(450); await up(); // a hold under 400 ms is a slip, never a question
    for (let i = 0; i < 100 && controls.filter(type => type === 'finish').length === before; i++) await page.waitForTimeout(20);
    assert.equal(controls.filter(type => type === 'finish').length, before + 1);
  }
  assert.equal(await page.locator('#startChat').count(), 0, 'there is no Start Chat');
  await ready(); await page.waitForTimeout(150); assert.equal(uploaded.length, 0, 'ready state sends no audio');
  assert.equal(sessionPosts, 1, 'the page opened one session with no partner action');
  await finishHold(); assert.ok(uploaded.length > 0); assert.equal(controls.includes('arm'), false);
  await page.evaluate(generation => window.__timingEvents.onmessage({ data: JSON.stringify({ type: 'final', generation, text: 'Would you like music or a story?', timings: { activityMs: 3, cloudMs: 30, finalDecodeMs: 33, audioMs: 240 } }) }), generation);
  // The sealed batch shows at once, with no gaze move (spec §4, 10/27 evening).
  await page.waitForSelector('.response', { timeout: 5000 });
  assert.equal(await page.locator('#phase').textContent(), 'Your turn');
  assert.equal(await page.locator('.response').count(), 2);
  await page.locator('.response').first().click();
  let state = await waitForChatState(page, value => value.timings.some(row => row.kind === 'hold' && row.status === 'completed'));
  let stored = { version: 1, retention: 40, turns: state.value.timings }; assertContentFreeMetrics(stored);
  const completed = stored.turns.find(row => row.kind === 'hold' && row.status === 'completed');
  for (const name of ['releaseToDrainedMs', 'finishRoundTripMs', 'releaseToTranscriptMs', 'transcriptToChoicesMs', 'choicesToRevealMs', 'revealToSelectMs', 'selectionToPlaybackMs', 'playbackMs']) assert.ok(Number.isFinite(completed.timings[name]), name);
  assert.equal(completed.timings.workerActivityMs, 3); assert.equal(completed.timings.workerCloudMs, 30);
  assert.equal(JSON.stringify(stored).includes('private-browser-session'), false); assert.equal(JSON.stringify(stored).includes('music'), false);
  for (const size of [{ width: 1280, height: 800 }, { width: 1600, height: 1000 }]) {
    await page.setViewportSize(size); await page.waitForTimeout(50);
    assert.equal(await page.locator('.tile.rest').count(), 0, 'the stable frame has no rest cells');
    assert.equal(await page.locator('.response .chat-symbol').count(), 2); assert.equal(await page.locator('.tile.question .chat-symbol').count(), 0);
    // The strip is the partner's words in grey: whole, at its own smaller size (public/chat/tile-fit.js STRIP).
    assert.equal(await page.locator('.tile.question .label').evaluate(label => label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.parentElement.clientHeight), true);
    const bad = await page.locator('.tile:not(.waiting):not(.question) .label').evaluateAll(labels => labels.filter(label => {
      const tile = label.parentElement, style = getComputedStyle(tile), icon = tile.querySelector('.chat-symbol');
      // A picture beside the words takes width, not height (public/chat/tile-fit.js).
      // A picture set aside for the words (tile-fit.js) takes nothing.
      const art = icon && getComputedStyle(icon).display !== 'none' && !tile.classList.contains('beside') ? icon.getBoundingClientRect().height + (parseFloat(style.rowGap) || 0) : 0;
      const height = tile.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - art;
      return parseFloat(style.fontSize) < 44 || label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1 || label.getBoundingClientRect().height > height + 1;
    }).map(label => label.textContent));
    assert.deepEqual(bad, []);
    const screenshot = `chat-${size.width}.png`;
    await page.screenshot({ path: path.join(scratch, screenshot) });
    if (artifacts) await fs.copyFile(path.join(scratch, screenshot), path.join(artifacts, screenshot));
  }
  // The stable frame (spec 2026-10-28): nine fixed tiles, the strip speaks the
  // question again (never logged as her words), a mode swap and back, Something else.
  assert.deepEqual(await page.locator('#grid .tile.page .label').allTextContents(), ['My questions', 'My comments', 'About me']);
  assert.deepEqual(await page.locator('#grid .tile.mode .label').allTextContents(), ['Ask a question', 'Make a comment']);
  assert.deepEqual(await page.locator('#grid .tile.static .label').allTextContents(), ['Tell me more', 'Something else']);
  for (let i = 0; i < 100 && choiceBodies.filter(body => body.mode).length < 2; i++) await page.waitForTimeout(20);
  const QUESTION = 'Would you like music or a story?';
  const modeBodies = choiceBodies.filter(body => body.mode);
  assert.deepEqual(modeBodies.map(body => body.mode).sort(), ['ask', 'comment'], 'both sets are asked for once the batch is revealed');
  for (const body of modeBodies) { assert.equal(body.text, QUESTION); assert.deepEqual(body.context, [`Partner: ${QUESTION}`]); }
  assert.equal(await page.locator('.tile.question.dwell .label').textContent(), QUESTION);
  await page.locator('.tile.question').click();
  for (let i = 0; i < 100 && !spokenTexts.includes(QUESTION); i++) await page.waitForTimeout(20);
  assert.ok(spokenTexts.includes(QUESTION), 'the strip speaks the question');
  await page.locator('.tile.mode[data-mode="ask"]').click();
  await page.waitForSelector('.tile.made');
  assert.equal(await page.locator('.tile.made').count(), 2); assert.equal(await page.locator('.response').count(), 0);
  assert.equal(await page.locator('.tile.mode[data-mode="ask"]').evaluate(el => el.classList.contains('on')), true, 'the mode tile is lit');
  await page.locator('.tile.mode[data-mode="ask"]').click();
  await page.waitForSelector('.response'); assert.equal(await page.locator('.tile.made').count(), 0, 'the lit tile returns the replies');
  const shownIds = await page.locator('.response').evaluateAll(nodes => nodes.map(node => node.dataset.choiceId));
  await page.locator('.tile.static', { hasText: 'Something else' }).click();
  await page.waitForFunction(ids => [...document.querySelectorAll('.response')].length === 2 && [...document.querySelectorAll('.response')].every(node => !ids.includes(node.dataset.choiceId)), shownIds);
  const againBody = choiceBodies.find(body => Array.isArray(body.avoid));
  assert.deepEqual(againBody.avoid, ['Music', 'A story']); assert.equal(againBody.text, QUESTION);
  assert.ok(againBody.context.includes(`Partner: ${QUESTION}`) && againBody.context.includes('Me: Music'));
  assert.equal(againBody.context.some(line => line === `Me: ${QUESTION}`), false, 'the strip\'s repeat is not her words');
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Your turn'); // "Something else." has finished
  // Her gaze never ends a hold (spec 2026-10-28 §7): from touch-down to the final
  // transcript no grid tile is a dwell target, and a click on one speaks nothing.
  const controlsBefore = controls.length, yesClips = spokenTexts.filter(text => text === 'Yes.').length;
  await down('#ask');
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Capturing question');
  assert.equal(await page.locator('#grid .dwell').count(), 0, 'no dwell targets while the partner holds');
  assert.equal(await page.locator('#grid button.tile:not([data-dwell-disabled])').count(), 0);
  await page.evaluate(() => document.querySelector('#grid .tile.yes').click());
  await page.waitForTimeout(450);
  assert.equal(await page.locator('#phase').textContent(), 'Capturing question', 'a look at YES does not end the hold');
  assert.equal(controls.slice(controlsBefore).includes('cancel'), false, 'the capture was not cancelled');
  assert.equal(spokenTexts.filter(text => text === 'Yes.').length, yesClips, 'YES said nothing');
  const finishedBefore = controls.filter(type => type === 'finish').length;
  await up();
  for (let i = 0; i < 100 && controls.filter(type => type === 'finish').length === finishedBefore; i++) await page.waitForTimeout(20);
  assert.equal(await page.locator('#grid .dwell').count(), 0, 'still none until the final transcript');
  await page.evaluate(generation => window.__timingEvents.onmessage({ data: JSON.stringify({ type: 'final', generation, text: 'Would you like music or a story?' }) }), generation);
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Your turn' && document.querySelectorAll('#grid .response.dwell').length === 2);
  assert.ok(await page.locator('#grid .tile.yes.dwell').count() === 1, 'the dwell targets are back');
  const finishes = controls.filter(type => type === 'finish').length;
  // A cancelled touch drops only that hold: Ready to ask again on the same session, nothing submitted.
  await down('#ask'); await page.waitForTimeout(120); await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask'); assert.equal(controls.filter(type => type === 'finish').length, finishes);
  assert.equal(sessionPosts, 1, 'the session stays on');
  stalled = true; await down('#ask');
  for (let i = 0; i < 100 && !releaseUpload; i++) await page.waitForTimeout(20);
  assert.ok(releaseUpload); await page.waitForTimeout(450); await up(); // a real hold (past 400 ms) whose upload stalls
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Off', null, { timeout: 6000 });
  stalled = false; releaseUpload(); assert.equal(controls.filter(type => type === 'finish').length, finishes);
  // The failure ended the session; the next hold starts one by itself. Its audio
  // waits on the device until the new session is ready, then is submitted whole.
  const sources = await page.evaluate(() => window.__eventSources), sentBefore = uploaded.length;
  await down('#ask');
  await page.waitForFunction(n => window.__eventSources === n + 1, sources);
  await page.waitForTimeout(250);
  assert.equal(uploaded.length, sentBefore, 'nothing leaves the device before the new session is ready');
  await page.evaluate(() => window.__timingEvents.onmessage({ data: JSON.stringify({ type: 'ready', capabilities: { remoteFinal: true } }) }));
  await page.waitForTimeout(300); await up();
  for (let i = 0; i < 100 && controls.filter(type => type === 'finish').length === finishes; i++) await page.waitForTimeout(20);
  assert.equal(controls.filter(type => type === 'finish').length, finishes + 1); assert.equal(sessionPosts, 2);
  assert.ok(uploaded.length - sentBefore >= 4, `the frames held before the session was ready were submitted (${uploaded.length - sentBefore})`);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  state = await waitForChatState(page, value => value.timings.some(row => row.status === 'cancelled' && row.reason === 'closed'));
  stored = { version: 1, retention: 40, turns: state.value.timings }; assertContentFreeMetrics(stored);
  assert.ok(stored.turns.some(row => row.status === 'cancelled' && row.reason === 'cancel'));
  assert.ok(stored.turns.some(row => row.status === 'failed' && row.reason === 'timeout'));
  assert.ok(stored.turns.some(row => row.status === 'cancelled' && row.reason === 'closed'));
  assert.deepEqual(errors, []);
  assert.equal(negativeControlRequests, 1);
  assert.equal(unexpectedForeignRequests, 0, 'no other foreign network attempts');
  if (artifacts) await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ ok: true,
    evidence: 'Owned local fixture only. Native browser saved-audio playback; real worklet with synthetic microphone input. Recognition, choices and voice services are mocked. No device, real service, voice-quality or speech-accuracy claim.',
    installedUIContracts: report, heldCapture: true, freshNeutralRequired: true, boundedUploadRecovery: true,
    cancelledAndFailedSeparate: true, numericExportOnly: true, screenshots: ['chat-1280.png', 'chat-1600.png'], counts: Object.fromEntries(['completed', 'cancelled', 'failed', 'open'].map(status => [status, stored.turns.filter(row => row.status === status).length])) }, null, 2));
});

test('the whole Chat UI recovers one completed turn after a committed timing acknowledgement exceeds its deadline', { timeout: 30000 }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-ack-'));
  let delayed = false, foreign = 0, timingAckAbandoned = false, voiceAckAbandoned = false;
  const server = serve(scratch, {
    delayStateResponse(state) {
      if (!delayed && state.value.timings.length) { delayed = true; return 3500; }
      return state.revision > 1 && !state.value.timings.length ? 600 : 0;
    },
    onStateResponseClose(state, abandoned) {
      if (state.value.timings.length) timingAckAbandoned ||= abandoned;
      else voiceAckAbandoned ||= abandoned;
    },
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(scratch, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route(url => url.origin !== base, route => { foreign++; return route.abort('blockedbyclient'); });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/');
  const report = await checkInstalledChatUI(page, { baseURL: base, timeout: 7000 });
  assert.equal(report.ok, true); assert.equal(report.typedTurn.status, 'completed');
  assert.deepEqual(report.actualAudio, { playCalls: 1, playing: 1, ended: 1, deviceCalls: 0, nativeAudio: true });
  assert.equal(report.audioSessions, 0, 'the refused microphone opened no audio session');
  assert.equal(delayed, true); assert.equal(timingAckAbandoned, true, 'the real store committed before the browser acknowledgement timed out');
  assert.equal(voiceAckAbandoned, false, 'voice changes receive their client acknowledgement before navigation');
  assert.deepEqual(errors, []); assert.equal(foreign, 0);
});

test('Chat stories, explicit voice and numeric timings survive a fresh browser and store, and clearing survives again', { timeout: 120000 }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-restart-'));
  const errors = [];
  let server, browser, context, page, base, port = 0, foreignRequests = 0;
  async function stop() {
    if (context) { await context.close(); context = null; }
    if (browser) { const previous = browser; await previous.close(); assert.equal(previous.isConnected(), false); browser = null; }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
  }
  async function start() {
    // A new store has no in-memory state from its predecessor. The origin and
    // scratch data directory stay the same while browser profiles are fresh.
    server = serve(scratch); server.listen(port, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    port = server.address().port; base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
    await context.route(url => url.origin !== base, route => { foreignRequests++; return route.abort('blockedbyclient'); });
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(base + '/');
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('chat:'))), [], 'the fresh browser carries no Chat localStorage or injected storage state');
  }
  t.after(async () => { await stop(); await fs.rm(scratch, { recursive: true, force: true }); });
  await start();
  const prepared = await checkInstalledChatUI(page, { baseURL: base, prepareRestart: true });
  assert.equal(prepared.restartState.voicePreference, 'local'); assert.equal(prepared.restartState.stories.length, 1);
  assert.equal(prepared.restartState.timings.length, 1); assert.equal(prepared.restartState.timings[0].status, 'completed');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(scratch, 'chat-state.json'), 'utf8')).value, prepared.restartState, 'the acknowledged state was written to the owned data file');
  await stop(); await start();
  const cleared = await checkRestoredChatState(page, prepared.restartState, { baseURL: base, clear: true });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(scratch, 'chat-state.json'), 'utf8')).value, cleared, 'the UI clear was committed to the owned data file');
  await stop(); await start();
  await checkRestoredChatState(page, cleared, { baseURL: base });
  assert.deepEqual(errors, []);
  assert.equal(foreignRequests, 0, 'restart coverage never contacts a real provider');
  if (process.env.ERA_CHAT_UI_OUT) {
    await fs.mkdir(process.env.ERA_CHAT_UI_OUT, { recursive: true });
    await fs.writeFile(path.join(process.env.ERA_CHAT_UI_OUT, 'restart-report.json'), JSON.stringify({ ok: true,
      evidence: 'Three independent browser processes and store instances over one owned origin and scratch data directory. State is written through the UI and restored through the real local file API; voice services use synthetic fixtures.',
      browserProcesses: 3, storeInstances: 3, explicitVoiceRestored: true, storyRestored: true,
      numericTimingRowsRestored: prepared.restartState.timings.length, clearSurvivedRestart: true, foreignRequests }, null, 2));
  }
});

test('her pages: lists from settings, ten a page with More and Back, the lit rail tile closes, About me puts stories first, the dialog saves the lists', { timeout: 60000 }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-pages-'));
  const server = serve(scratch); server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(scratch, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.route(url => url.origin !== base, route => route.abort('blockedbyclient'));
  const page = await context.newPage(), errors = [], saved = [];
  page.on('pageerror', error => errors.push(error.message));
  const questions = Array.from({ length: 13 }, (_, i) => `Question ${i + 1}?`);
  await page.route('**/settings', route => {
    if (route.request().method() === 'POST') { saved.push(route.request().postDataJSON()); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ dwellMs: 1200, chatQuestions: questions, chatComments: ['That is cool!'], chatAbout: ['I like swings.', 7] }) });
  });
  await page.route('**/chat/api/world', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: '', about: ['I am in first grade.'], week: ['This week: magnets.'] }) }));
  // A saved story, through the real store, before the page loads.
  await page.goto(base + '/');
  await page.evaluate(async () => {
    const state = await (await fetch('/chat/api/state')).json();
    await fetch('/chat/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, expectedRevision: state.revision, patch: { stories: [{ label: 'Our trip', say: 'We went to the zoo.' }] } }) });
  });
  await page.goto(base + '/chat/'); await page.waitForFunction(() => document.body.dataset.storageReady === 'true');
  await page.waitForFunction(() => document.querySelector('#chatQuestions').value.split('\n').length === 13);
  // The door bar's right end (spec 2026-10-28 §1): lock, partner settings, Hold to ask in the corner.
  await page.locator('#stripLock').waitFor();
  const bar = await page.evaluate(() => ['#stripLock', '#partnerOpen', '#ask'].map(id => document.querySelector(id).getBoundingClientRect().toJSON()));
  assert.ok(bar[0].right <= bar[1].left && bar[1].right <= bar[2].left, `lock, •••, Hold to ask from left to right: ${JSON.stringify(bar.map(box => [box.left, box.right]))}`);
  assert.ok(1600 - bar[2].right <= 16, `Hold to ask is in the top right corner (${1600 - bar[2].right} px from the edge)`);
  const items = () => page.locator('#grid .tile.item .label').allTextContents();
  const navs = () => page.locator('#grid .tile.nav .label').allTextContents();
  await page.locator('#grid .tile.page[data-page="questions"]').click();
  assert.deepEqual(await items(), questions.slice(0, 10)); assert.deepEqual(await navs(), ['More', 'Back']);
  assert.equal(await page.locator('#grid .tile.page.on').getAttribute('data-page'), 'questions');
  assert.equal(await page.locator('#grid .tile.mode').count(), 0, 'the page takes the bottom row too');
  assert.equal(await page.locator('#grid .tile.page').count(), 3); assert.equal(await page.locator('#grid .tile.yes, #grid .tile.no, #grid .tile.question').count(), 3);
  await page.locator('#grid .tile.nav', { hasText: 'More' }).click();
  assert.deepEqual(await items(), questions.slice(10)); assert.deepEqual(await navs(), ['Back']);
  await page.locator('#grid .tile.page.on').click(); // the lit tile closes the page
  await page.locator('#grid .tile.page.on').waitFor({ state: 'detached' });
  assert.deepEqual(await page.locator('#grid .tile.static .label').allTextContents(), ['Tell me more', 'Something else', "Hi!", "What's up?", 'How are you?', 'Come sit with me.']);
  await page.locator('#grid .tile.page[data-page="about"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#grid .tile.item').length === 4);
  assert.deepEqual(await items(), ['Our trip', 'I like swings.', 'I am in first grade.', 'This week: magnets.'], 'stories, then her lines, then the world');
  await page.locator('#grid .tile.nav', { hasText: 'Back' }).click();
  await page.locator('#grid .tile.page.on').waitFor({ state: 'detached' });
  await page.locator('#grid .tile.page[data-page="comments"]').click();
  assert.deepEqual(await items(), ['That is cool!']);
  // The partner dialog: one per line, twenty lines of forty characters at most.
  await page.locator('#partnerOpen').click();
  const lines = [...Array.from({ length: 24 }, (_, i) => `Comment ${i}`), 'x'.repeat(60)];
  await page.locator('#chatComments').fill(lines.join('\n')); await page.locator('#chatComments').blur();
  await page.waitForFunction(() => document.querySelector('#chatCommentsNote').textContent.startsWith('Saved 20'));
  assert.deepEqual(saved.at(-1), { chatComments: lines.slice(0, 20) });
  await page.locator('#partnerDialog form button').click();
  assert.deepEqual(await items(), lines.slice(0, 10), 'the open page shows the saved list');
  assert.deepEqual(errors, []);
});
