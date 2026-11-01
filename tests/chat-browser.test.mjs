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
  const controls = [], uploaded = [], choiceBodies = [], spokenTexts = [], clipRoles = []; let generation = 0, sequence = 0, stalled = false, releaseUpload, sessionPosts = 0;
  await page.addInitScript(() => {
    window.__eventSources = 0;
    // The command stream (the partner's button) is a second EventSource opened at load; only session streams count.
    window.EventSource = class { constructor(url) { if (!String(url).includes('/chat/api/commands')) { window.__timingEvents = this; window.__eventSources++; } } close() { this.closed = true; } };
  });
  await page.route('**/voices', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, current: 'synthetic-saved' }) }));
  await page.route('**/tts', route => { try { const body = route.request().postDataJSON(); spokenTexts.push(body.text); clipRoles.push([body.text, body.voice]); } catch {} return route.fulfill({ status: 200, contentType: 'audio/wav', body: makeChatToneWav() }); });
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
  // Two voices (spec 2026-10-31 §3.3): her picks in hers, the partner's question in the helper's.
  const rolesOf = text => [...new Set(clipRoles.filter(([said]) => said === text).map(([, role]) => role))];
  assert.deepEqual(rolesOf(QUESTION), ['helper'], 'the echoed question is the helper voice');
  for (const choice of alternatives.choices) assert.deepEqual(rolesOf(choice.say), ['her'], `her pick "${choice.say}" is her voice`);
  for (const opener of ['Hi!', 'Yes.', 'No.']) assert.deepEqual(rolesOf(opener), ['her'], `her word "${opener}" is her voice`);
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
  assert.equal(await page.locator('#back.dwell').count(), 0, 'Back is locked like the grid during a hold');
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

test('after a silence the options are read aloud: the name, then each label with its tile lit, three times at most; a glance never stops it, a selection does (spec 2026-10-28 §6)', { timeout: 60000 }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-prompt-'));
  const server = serve(scratch); server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(scratch, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.route(url => url.origin !== base, route => route.abort('blockedbyclient'));
  const page = await context.newPage(), errors = [], clips = [], saved = [], roles = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__lit = []; window.__plays = 0;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) { window.__plays++; return play.apply(this, args); };
    document.addEventListener('DOMContentLoaded', () => new MutationObserver(records => {
      for (const record of records) if (record.target.matches?.('.tile.response.on') && !record.oldValue?.split(' ').includes('on')) window.__lit.push(record.target.textContent.trim());
    }).observe(document.querySelector('#grid'), { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true }));
  });
  await page.route('**/voices', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, current: 'synthetic-saved' }) }));
  await page.route('**/tts', route => { const body = route.request().postDataJSON(); clips.push(body.text); roles.push([body.text, body.voice]); return route.fulfill({ status: 200, contentType: 'audio/wav', body: makeChatToneWav() }); });
  await page.route('**/settings', route => {
    if (route.request().method() === 'POST') { saved.push(route.request().postDataJSON()); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ dwellMs: 1200, chatPromptMs: 1000, chatName: 'Sam' }) });
  });
  await page.goto(base + '/chat/'); await page.waitForFunction(() => document.body.dataset.storageReady === 'true');
  await page.waitForFunction(() => document.querySelector('#chatName').value === 'Sam');
  assert.equal(await page.locator('#chatPrompt').inputValue(), '1000', 'an unlisted delay from the hub is kept as is');
  // The mouse stays on the door bar: no dwell progress on a tile.
  async function ask() {
    await page.locator('#partnerOpen').click();
    if (!(await page.locator('#testing').evaluate(el => el.open))) await page.locator('#testing > summary').click();
    await page.locator('#typedQuestion').fill('Would you like music or a story?');
    await page.locator('#typedAsk').focus(); await page.keyboard.press('Enter');
    await page.locator('.response').first().waitFor();
  }
  await ask();
  const playsAtReveal = await page.evaluate(() => window.__plays);
  assert.equal(playsAtReveal, 0, 'the reveal itself speaks nothing');
  await page.waitForFunction(() => window.__lit.length === 2 && !document.querySelector('#grid .response.on'), null, { timeout: 15000 });
  assert.deepEqual(await page.evaluate(() => window.__lit), ['Music', 'A story'], 'each reply lit in spoken order');
  assert.equal(await page.evaluate(() => window.__plays), 3, 'the name, then each label');
  assert.ok(clips.includes('Sam, your options are') && clips.includes('Music') && clips.includes('A story'));
  // The reading is the helper voice; each label is also her pick's words, so
  // the same text is two clips, one per voice (spec 2026-10-31 §3.3).
  const rolesOf = text => [...new Set(roles.filter(([said]) => said === text).map(([, role]) => role))].sort();
  assert.deepEqual(rolesOf('Sam, your options are'), ['helper']);
  for (const label of ['Music', 'A story']) assert.deepEqual(rolesOf(label), ['helper', 'her'], `"${label}": read by the helper, warmed as her pick`);
  // Unanswered: read again after the same delay, three readings in all, then quiet (amended 10/31 night).
  await page.waitForFunction(() => window.__plays === 9 && !document.querySelector('#grid .response.on'), null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => window.__plays), 9, 'three readings of a batch, then quiet');
  assert.deepEqual(await page.evaluate(() => window.__lit), ['Music', 'A story', 'Music', 'A story', 'Music', 'A story']);
  // A new batch: a glance on a tile mid-reading (dwell progress) never stops it; a selection stops it at once.
  await page.evaluate(() => { window.__lit = []; window.__plays = 0; });
  await ask();
  await page.waitForFunction(() => window.__lit.length === 1, null, { timeout: 15000 });
  await page.evaluate(() => { const tile = [...document.querySelectorAll('#grid .tile.response')].find(el => el.textContent.includes('A story'));
    tile.classList.add('dwell-active'); setTimeout(() => tile.classList.remove('dwell-active'), 300); });
  await page.waitForFunction(() => window.__lit.length === 3, null, { timeout: 15000 });
  assert.deepEqual(await page.evaluate(() => window.__lit), ['Music', 'A story', 'Music'], 'the glance left the reading going, and the next reading came');
  await page.locator('#grid .tile.response', { hasText: 'A story' }).dispatchEvent('click');
  await page.waitForTimeout(3000);
  assert.deepEqual(await page.evaluate(() => window.__lit), ['Music', 'A story', 'Music'], 'the reading stopped at the selection, and never came back');
  assert.equal(await page.locator('#grid .response.on').count(), 0, 'no tile is left lit');
  // The partner dialog: Off / 10 / 12 / 15 / 20 s and her name, saved to the device.
  await page.locator('#partnerOpen').click();
  await page.locator('#chatPrompt').selectOption('15000');
  await page.locator('#chatName').fill('Alex'); await page.locator('#chatName').blur();
  await page.waitForFunction(() => document.querySelector('#chatPromptNote').textContent.startsWith('Saved'));
  assert.deepEqual(saved, [{ chatPromptMs: 15000 }, { chatName: 'Alex' }]);
  assert.deepEqual(await page.locator('#chatPrompt option').evaluateAll(options => options.map(option => option.value)).then(values => values.filter(value => value !== '1000')), ['0', '10000', '12000', '15000', '20000']);
  assert.deepEqual(errors, []);
});

test('Back in the door bar: twice the door wide a quarter door right of it; it closes a page, then a mode, then brings back earlier batches (maintainer 10/29)', { timeout: 60000 }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-back-'));
  const server = serve(scratch); server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(scratch, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.route(url => url.origin !== base, route => route.abort('blockedbyclient'));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const batch = labels => ({ kind: 'alternatives', choices: labels.map(label => ({ label, say: label })) });
  await page.route('**/chat/api/choices', route => {
    const body = route.request().postDataJSON();
    const result = body.mode ? batch([`${body.mode} one`, `${body.mode} two`]) : body.avoid ? batch(['Pizza', 'Pasta']) : /lunch/.test(body.text) ? batch(['Tea', 'Milk']) : batch(['Music', 'A story']);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(base + '/chat/'); await page.waitForFunction(() => document.body.dataset.storageReady === 'true');
  for (const size of [{ width: 1600, height: 1000 }, { width: 1280, height: 800 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size); await page.waitForTimeout(100);
    const [door, back, status] = await page.evaluate(() => ['#barDoor', '#back', '#sessionStatus'].map(id => document.querySelector(id).getBoundingClientRect().toJSON()));
    const tag = `${size.width}x${size.height}`;
    assert.ok(Math.abs(back.width - 2 * door.width) <= 2, `${tag}: Back is twice the door wide (${back.width} vs ${door.width})`);
    assert.ok(Math.abs(back.left - door.right - door.width / 4) <= 2, `${tag}: a quarter of the door between them (${back.left - door.right})`);
    assert.ok(Math.abs(back.top - door.top) <= 1 && Math.abs(back.height - door.height) <= 1, `${tag}: the door's height`);
    assert.ok(Math.abs(status.left - back.right - door.width / 4) <= 2, `${tag}: the status follows Back at the same gap (${status.left - back.right})`);
  }
  assert.equal(await page.locator('#back .label').textContent(), 'Back');
  assert.equal(await page.locator('#back').evaluate(el => getComputedStyle(el).borderRadius), await page.locator('#barDoor').evaluate(el => getComputedStyle(el).borderRadius));
  const backOn = () => page.locator('#back').evaluate(el => el.classList.contains('dwell') && !el.classList.contains('off') && !('dwellDisabled' in el.dataset));
  assert.equal(await backOn(), false, 'nothing to go back to: dimmed, not a dwell target');
  assert.equal(await page.locator('#back').getAttribute('data-dwell-ms'), await page.locator('#barDoor').getAttribute('data-dwell-ms'), 'the door\'s dwell');
  const replies = () => page.locator('#grid .response .label').allTextContents();
  async function ask(text) {
    await page.locator('#partnerOpen').click();
    if (!(await page.locator('#testing').evaluate(el => el.open))) await page.locator('#testing > summary').click();
    await page.locator('#typedQuestion').fill(text); await page.locator('#typedAsk').click();
    await page.locator('.response').first().waitFor();
  }
  await ask('Would you like music or a story?');
  assert.deepEqual(await replies(), ['Music', 'A story']); assert.equal(await backOn(), false);
  // A page, then a lit mode: Back returns to the replies.
  await page.locator('#grid .tile.page[data-page="about"]').click();
  assert.equal(await backOn(), true);
  await page.locator('#back').click();
  await page.locator('#grid .tile.page.on').waitFor({ state: 'detached' }); assert.deepEqual(await replies(), ['Music', 'A story']);
  await page.locator('#grid .tile.mode[data-mode="ask"]').click(); await page.locator('#grid .tile.made').first().waitFor();
  await page.locator('#back').click();
  await page.locator('#grid .response').first().waitFor(); assert.equal(await page.locator('#grid .tile.mode.on').count(), 0);
  assert.equal(await backOn(), false, 'the first batch has nothing behind it');
  // Something else, then a new question: Back walks the batches back, with their questions.
  await page.locator('#grid .tile.static', { hasText: 'Something else' }).click();
  await page.waitForFunction(() => document.querySelector('#grid .response .label')?.textContent === 'Pizza');
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Your turn');
  await ask('What about lunch?');
  assert.deepEqual(await replies(), ['Tea', 'Milk']); assert.equal(await backOn(), true);
  await page.locator('#back').click();
  await page.waitForFunction(() => document.querySelector('#grid .response .label')?.textContent === 'Pizza');
  assert.equal(await page.locator('#grid .tile.question .label').textContent(), 'Would you like music or a story?', 'the earlier question comes back with its replies');
  await page.locator('#back').click();
  await page.waitForFunction(() => document.querySelector('#grid .response .label')?.textContent === 'Music');
  assert.deepEqual(await replies(), ['Music', 'A story']);
  assert.equal(await backOn(), false, 'nothing further back');
  // The restored replies select as usual.
  assert.equal(await page.locator('#grid .response.dwell').count(), 2);
  assert.deepEqual(errors, []);
});

// The hub's ear (spec 2026-10-28 §8, chat-api.js W1) as this fixture speaks it:
// the control replies, the ear's events and the audio socket are this test's own.
test('Listen for <name>: the switch streams room audio as an ear, a wake utterance reveals replies, her clips are never heard, a hold still works, off closes it', { timeout: 90000 }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-wake-'));
  const wav = path.join(scratch, 'microphone.wav'); await fs.writeFile(wav, makeChatToneWav());
  const server = serve(scratch); server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(scratch, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, hasTouch: true, permissions: ['microphone'] });
  await context.route(url => url.origin !== base, route => route.abort('blockedbyclient'));
  const page = await context.newPage(), errors = [], controls = [], saved = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__frames = []; window.__clips = [];
    window.EventSource = class { constructor(url) { if (String(url).includes('/sessions/')) window.__events = this; } close() { this.closed = true; } };
    window.WebSocket = class {
      static OPEN = 1;
      constructor() { this.readyState = 0; this.bufferedAmount = 0; window.__socket = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 10); }
      send(buffer) { const view = new DataView(buffer), pcm = new Uint8Array(buffer, 8);
        window.__frames.push({ gen: view.getUint32(0, true), seq: view.getUint32(4, true), at: performance.now(), silent: pcm.every(byte => byte === 0) }); }
      close() { this.readyState = 3; }
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      const clip = { start: performance.now(), end: null }; window.__clips.push(clip);
      this.addEventListener('ended', () => { clip.end = performance.now(); }, { once: true });
      return play.apply(this, args);
    };
  });
  let generation = 10;
  const EAR = 7;
  await page.route('**/voices', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, current: 'synthetic-saved' }) }));
  await page.route('**/tts', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: makeChatToneWav() }));
  await page.route('**/settings', route => {
    if (route.request().method() === 'POST') { saved.push(route.request().postDataJSON()); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ dwellMs: 1200, chatName: 'Ellie', chatWakeMode: false, chatPromptMs: 0 }) });
  });
  await page.route('**/chat/api/**', async route => {
    const req = route.request(), url = new URL(req.url()); let result = {};
    if (url.pathname === '/chat/api/state') return route.continue();
    if (url.pathname.endsWith('/config')) result = { runtime: { available: true, kind: 'built-in', capabilities: { streaming: true, wake: true } }, choices: { available: true } };
    else if (url.pathname.endsWith('/sessions') && req.method() === 'POST') result = { id: 'wake-session' };
    else if (url.pathname.endsWith('/control')) {
      const body = req.postDataJSON(); controls.push(body);
      result = body.type === 'clip' ? { ok: true } : body.type === 'window' && body.ear === true ? { ok: true, generation: EAR, earId: 'ear-1' } : body.type === 'window' ? { ok: true, generation }
        : body.type === 'finish' ? { generation } : body.type === 'cancel' ? { ok: true, generation: EAR } : { generation: ++generation };
    } else if (url.pathname.endsWith('/choices')) result = { kind: 'alternatives', choices: [{ label: 'Music', say: 'Music' }, { label: 'A story', say: 'A story' }] };
    else result = {};
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) }).catch(() => {});
  });
  await page.goto(base + '/chat/'); await page.waitForFunction(() => document.body.dataset.storageReady === 'true');
  await page.waitForFunction(() => window.__events);
  await page.evaluate(() => window.__events.onmessage({ data: JSON.stringify({ type: 'ready', capabilities: { remoteStreaming: true, audioSocket: true, stagedChoices: true } }) }));
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask');
  const cdp = await context.newCDPSession(page);
  const touch = async (selector, ms = 60) => {
    const box = await page.locator(selector).boundingBox(); assert.ok(box, selector);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
    await page.waitForTimeout(ms); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const emit = data => page.evaluate(value => window.__events.onmessage({ data: JSON.stringify(value) }), data);
  const earFrames = () => page.evaluate(ear => window.__frames.filter(frame => frame.gen === ear).length, EAR);
  // The switch: in the partner strip left of the lock, off by default, enabled with a wake-capable runtime.
  const toggle = page.locator('#wakeToggle');
  assert.equal((await toggle.textContent()).trim(), 'Listen for Ellie: off'); assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await toggle.isDisabled(), false);
  const [wakeBox, lockBox] = await page.evaluate(() => ['#wakeToggle', '#stripLock'].map(id => document.querySelector(id).getBoundingClientRect().toJSON()));
  assert.ok(wakeBox.right <= lockBox.left, 'the switch is left of the lock');
  await page.waitForTimeout(200); assert.equal(await earFrames(), 0);
  // No recording notices on the page (spec 2026-10-28 §10): the lit dot and the status line are the signal.
  assert.equal(await page.locator('#wakeBanner, #testModeBanner').count(), 0, 'no banners');
  await toggle.click(); assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'a mouse or gaze click does not switch it');
  // On: the ear opens and frames flow with no hold.
  await touch('#wakeToggle');
  await page.waitForFunction(() => document.querySelector('#wakeToggle').getAttribute('aria-pressed') === 'true');
  assert.deepEqual(saved.at(-1), { chatWakeMode: true });
  for (let i = 0; i < 100 && !controls.some(body => body.type === 'window' && body.ear === true); i++) await page.waitForTimeout(20);
  assert.ok(controls.some(body => body.type === 'window' && body.ear === true), 'the ear is asked for');
  // The partner's switch-on starts a new half hour at the hub (§10 addendum); a reopen never does.
  assert.equal(controls.find(body => body.type === 'window' && body.ear === true).fresh, true, 'the switch-on is fresh');
  await page.waitForFunction(ear => window.__frames.filter(frame => frame.gen === ear).length >= 5, EAR, { timeout: 5000 });
  assert.equal((await toggle.textContent()).trim(), 'Listen for Ellie: on');
  assert.equal(await page.locator('#phase').textContent(), 'Listening for Ellie');
  assert.equal(await page.evaluate(() => document.body.dataset.ear), 'on', 'the dot is lit');
  assert.ok(await page.locator('#grid .tile.yes.dwell').count() === 1, 'tiles stay live in ear mode');
  // A wake utterance: its staged batch reveals through the window path, the strip shows the question.
  await emit({ type: 'ear', state: 'listening', earId: 'ear-1', generation: EAR });
  await emit({ type: 'utterance-sealed', ear: true, earId: 'ear-1', windowId: 'w-1', seq: 1, text: 'music or a story?', windowText: 'music or a story?', generation: EAR });
  await emit({ type: 'choice-staged', generation: EAR, windowId: 'w-other', seq: 1, index: 0, choice: { label: 'Wrong', say: 'Wrong' } });
  await emit({ type: 'batch-sealed', generation: EAR, windowId: 'w-1', seq: 1, kind: 'generated', choices: [{ label: 'Music', say: 'Music' }, { label: 'A story', say: 'A story' }] });
  await page.waitForSelector('#grid .response');
  assert.equal(await page.locator('#grid .tile.question .label').textContent(), 'music or a story?');
  // Her clip is handled at the hub, never silenced (spec 2026-10-28 §13): the
  // frames keep their sound while it plays, the hub is told its words at its
  // start and its end, and her pick touches nothing of capture (maintainer 10/29).
  const controlsAtPick = controls.length;
  await page.locator('#grid .response', { hasText: 'Music' }).click();
  await page.waitForFunction(() => window.__clips.length && window.__clips.at(-1).end, null, { timeout: 5000 });
  await page.waitForTimeout(300);
  const heard = await page.evaluate(ear => { const clip = window.__clips.at(-1); const during = window.__frames.filter(frame => frame.gen === ear && frame.at > clip.start && frame.at < clip.end);
    return { during: during.length, loud: during.filter(frame => !frame.silent).length }; }, EAR);
  assert.ok(heard.during > 0 && heard.loud > 0, `the microphone is never silenced while her clip plays: ${JSON.stringify(heard)}`);
  const clipped = controls.slice(controlsAtPick).filter(body => body.type === 'clip');
  assert.deepEqual(clipped.map(body => [body.on, body.text, body.source]), [[true, 'Music', undefined], [false, undefined, undefined]], 'her clip\'s words at its start, then its end');
  assert.ok(clipped.every(body => Number.isFinite(body.at)) && clipped[1].at >= clipped[0].at);
  assert.deepEqual(controls.slice(controlsAtPick).filter(body => ['cancel', 'pick'].includes(body.type)), [], 'her pick sends no cancel and no pick');
  const refresh = controls.filter(body => body.type === 'window' && body.ear === true).at(-1);
  assert.ok(controls.filter(body => body.type === 'window' && body.ear === true).length >= 2 && refresh.context.includes('Me: Music'), 'after her pick the ear gets the conversation so far');
  // A hold with the ear on: the hold's frames are the hold's; the ear resumes after the final.
  await touch('#ask', 600);
  for (let i = 0; i < 100 && !controls.some(body => body.type === 'finish'); i++) await page.waitForTimeout(20);
  const ask = controls.filter(body => body.type === 'ask').length;
  assert.equal(ask, 1, 'the hold asked as today');
  const holdGen = generation; // the ask's generation (finish keeps it)
  assert.ok(await page.evaluate(ear => window.__frames.some(frame => frame.gen !== ear), EAR), 'the hold sent its own frames');
  await emit({ type: 'ear', state: 'off', reason: 'hold', earId: 'ear-1', generation: holdGen });
  await emit({ type: 'final', generation: holdGen, text: 'Would you like music or a story?' });
  await emit({ type: 'batch-sealed', generation: holdGen, kind: 'generated', choices: [{ label: 'Tea', say: 'Tea' }, { label: 'Milk', say: 'Milk' }] });
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Your turn');
  // The hub resumes the ear itself, under the session's new generation.
  await emit({ type: 'ear', state: 'listening', resumed: true, earId: 'ear-1', generation: holdGen });
  const resumedAt = await page.evaluate(() => performance.now());
  await page.waitForTimeout(600);
  assert.ok(await page.evaluate(({ gen, at }) => window.__frames.filter(frame => frame.gen === gen && frame.at > at).length, { gen: holdGen, at: resumedAt }) > 0, 'the ear resumes after the final, with the generation it was given');
  // A stream error closes the ear at the hub; with the switch still on the page opens it again.
  const opens = controls.filter(body => body.type === 'window' && body.ear === true).length;
  await emit({ type: 'ear', state: 'off', reason: 'error', earId: 'ear-1', generation: holdGen });
  for (let i = 0; i < 150 && controls.filter(body => body.type === 'window' && body.ear === true).length === opens; i++) await page.waitForTimeout(20);
  assert.equal(controls.filter(body => body.type === 'window' && body.ear === true).length, opens + 1, 'the ear is opened again');
  assert.equal(controls.filter(body => body.type === 'window' && body.ear === true).at(-1).fresh, undefined, 'a reopen inherits the half hour');
  await page.waitForFunction(() => document.body.dataset.ear === 'on');
  // Off: the ear closes and nothing more is sent.
  await touch('#wakeToggle');
  await page.waitForFunction(() => document.querySelector('#wakeToggle').getAttribute('aria-pressed') === 'false');
  assert.deepEqual(saved.at(-1), { chatWakeMode: false });
  assert.ok(controls.some(body => body.type === 'window' && body.ear === false), 'the ear is closed');
  await emit({ type: 'ear', state: 'off', reason: 'off', earId: 'ear-1', generation: holdGen });
  await page.waitForTimeout(200); const stopped = await page.evaluate(() => window.__frames.length); await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__frames.length), stopped, 'no frames once the ear is off');
  assert.equal(await page.evaluate(() => document.body.dataset.ear), 'off', 'the dot is out');
  assert.deepEqual(errors, []);
});

// ---- her own audio is never heard by the ear (10/31 turn record: the read-aloud's
// "Ellie, your options are" came back as a wake question) ----
// One browser context, every route at the context, so a second Chat page shares it.
async function earFixture(t, settings = {}) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-ear-gate-'));
  const wav = path.join(scratch, 'microphone.wav'); await fs.writeFile(wav, makeChatToneWav());
  const server = serve(scratch); server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(scratch, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, hasTouch: true, permissions: ['microphone'] });
  const controls = [], errors = [], turns = [], requests = [], EAR = 7;
  // The replies a /choices request gets (§15's ask-again goes there); a function of the body, or a status.
  const fixture = { choices: () => ({ kind: 'alternatives', choices: [{ label: 'Music', say: 'Music' }, { label: 'A story', say: 'A story' }] }) };
  await context.route(url => url.origin !== base, route => route.abort('blockedbyclient'));
  await context.addInitScript(() => {
    window.__frames = []; window.__clips = [];
    window.EventSource = class { constructor(url) { if (String(url).includes('/sessions/')) window.__events = this; } close() { this.closed = true; } };
    window.WebSocket = class {
      static OPEN = 1;
      constructor() { this.readyState = 0; this.bufferedAmount = 0; window.__socket = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 10); }
      send(buffer) { const view = new DataView(buffer), pcm = new Uint8Array(buffer, 8);
        window.__frames.push({ gen: view.getUint32(0, true), at: performance.timeOrigin + performance.now(), silent: pcm.every(byte => byte === 0) }); }
      close() { this.readyState = 3; }
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      const clip = { start: performance.timeOrigin + performance.now(), end: null }; window.__clips.push(clip);
      this.addEventListener('ended', () => { clip.end = performance.timeOrigin + performance.now(); }, { once: true });
      return play.apply(this, args);
    };
  });
  await context.route('**/voices', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, current: 'synthetic-saved' }) }));
  await context.route('**/tts', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: makeChatToneWav() }));
  await context.route('**/settings', route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ dwellMs: 1200, chatName: 'Ellie', chatWakeMode: true, chatPromptMs: 0, ...settings }) });
  });
  await context.route('**/chat/api/**', async route => {
    const req = route.request(), url = new URL(req.url()); let result = {};
    if (url.pathname === '/chat/api/state') return route.continue();
    requests.push(`${req.method()} ${url.pathname}`);
    if (url.pathname.endsWith('/config')) result = { runtime: { available: true, kind: 'built-in', capabilities: { streaming: true, wake: true } }, choices: { available: true } };
    else if (url.pathname.endsWith('/sessions') && req.method() === 'POST') result = { id: 'gate-session' };
    else if (url.pathname.endsWith('/control')) { const body = req.postDataJSON(); controls.push(body); result = { ok: true, generation: EAR, earId: 'ear-1' }; }
    else if (url.pathname.endsWith('/choices')) {
      const answer = fixture.choices(req.postDataJSON());
      if (Number.isInteger(answer)) return route.fulfill({ status: answer, contentType: 'application/json', body: JSON.stringify({ error: 'generation-unavailable' }) }).catch(() => {});
      result = answer;
    } else if (url.pathname === '/chat/api/turns' && req.method() === 'POST') turns.push(req.postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) }).catch(() => {});
  });
  async function open({ ear = true } = {}) {
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/chat/'); await page.waitForFunction(() => document.body.dataset.storageReady === 'true');
    await page.waitForFunction(() => window.__events);
    await page.evaluate(() => window.__events.onmessage({ data: JSON.stringify({ type: 'ready', capabilities: { remoteStreaming: true, audioSocket: true, stagedChoices: true } }) }));
    if (ear) {
      await page.waitForFunction(() => document.body.dataset.ear === 'on', null, { timeout: 5000 });
      await page.waitForFunction(ear => window.__frames.filter(frame => frame.gen === ear && !frame.silent).length >= 3, EAR, { timeout: 5000 });
    }
    return page;
  }
  const emit = (page, data) => page.evaluate(value => window.__events.onmessage({ data: JSON.stringify(value) }), data);
  // The ear frames sent in [from, to] (epoch ms), and how many carried sound.
  const heard = (page, from, to) => page.evaluate(({ ear, from, to }) => { const frames = window.__frames.filter(frame => frame.gen === ear && frame.at > from && frame.at < to);
    return { frames: frames.length, loud: frames.filter(frame => !frame.silent).length }; }, { ear: EAR, from, to });
  return { context, controls, errors, turns, requests, fixture, EAR, open, emit, heard };
}

test('the read-aloud is heard, never silenced: the frames keep their sound and the hub gets the whole reading as one clip, then each spoken piece', { timeout: 90000 }, async t => {
  const f = await earFixture(t, { chatPromptMs: 800 });
  const page = await f.open();
  await f.emit(page, { type: 'utterance-sealed', ear: true, earId: 'ear-1', windowId: 'w-1', seq: 1, text: 'music or a story?', windowText: 'music or a story?', generation: f.EAR });
  await f.emit(page, { type: 'batch-sealed', generation: f.EAR, windowId: 'w-1', seq: 1, kind: 'generated', choices: [{ label: 'Music', say: 'Music' }, { label: 'A story', say: 'A story' }] });
  await page.waitForSelector('#grid .response');
  await page.waitForFunction(() => window.__clips.length >= 3 && window.__clips.slice(0, 3).every(clip => clip.end), null, { timeout: 15000 });
  await page.waitForTimeout(800);
  // The first reading's clips (a second reading may follow, §6).
  const clips = (await page.evaluate(() => window.__clips)).slice(0, 3);
  for (const clip of clips) {
    const during = await f.heard(page, clip.start, clip.end);
    assert.ok(during.frames > 0 && during.loud > 0, `the microphone is never silenced while the read-aloud plays: ${JSON.stringify(during)}`);
  }
  const clipped = f.controls.filter(body => body.type === 'clip');
  assert.deepEqual(clipped.slice(0, 8).map(body => [body.on, body.text]), [[true, 'Ellie, your options are, Music, A story'],
    [true, 'Ellie, your options are'], [false, undefined], [true, 'Music'], [false, undefined], [true, 'A story'], [false, undefined], [false, undefined]],
    'the reading\'s whole text first (its gaps never end it), each piece inside it');
  assert.deepEqual(f.controls.filter(body => ['cancel', 'pick'].includes(body.type)), [], 'the reading touches nothing of capture');
  assert.deepEqual(f.errors, []);
});

test('the device voice is heard, never silenced: its words go to the hub as a clip', { timeout: 90000 }, async t => {
  const f = await earFixture(t);
  // A device voice that reports its end at once but keeps speaking for a second (the kiosk's voices can).
  await f.context.addInitScript(() => {
    const synth = { speaking: false, pending: false, paused: false, getVoices: () => [], cancel() { synth.speaking = false; }, pause() {}, resume() {},
      speak(utterance) { synth.speaking = true; window.__synth = { start: performance.timeOrigin + performance.now() };
        setTimeout(() => utterance.onstart?.(), 5); setTimeout(() => utterance.onend?.(), 20);
        setTimeout(() => { synth.speaking = false; window.__synth.end = performance.timeOrigin + performance.now(); }, 1000); } };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  });
  const page = await f.open();
  await page.locator('#partnerOpen').click(); await page.locator('#voicePreference').selectOption('local');
  await page.locator('#partnerDialog form button').click();
  await page.locator('#grid .tile.static', { hasText: 'Hi!' }).click();
  await page.waitForFunction(() => window.__synth?.end, null, { timeout: 5000 });
  await page.waitForTimeout(500);
  const synth = await page.evaluate(() => window.__synth);
  const during = await f.heard(page, synth.start, synth.end);
  assert.ok(during.frames > 0 && during.loud > 0, `the microphone is never silenced while the device voice speaks: ${JSON.stringify(during)}`);
  const clipped = f.controls.filter(body => body.type === 'clip');
  assert.deepEqual(clipped.map(body => [body.on, body.text]), [[true, 'Hi!'], [false, undefined]]);
  assert.deepEqual(f.errors, []);
});

test('another Chat page speaking: its words reach this page on the channel and go to the hub as an other clip; the microphone stays open', { timeout: 90000 }, async t => {
  const f = await earFixture(t);
  const ear = await f.open();
  const other = await f.open({ ear: false });
  await other.locator('#grid .tile.static', { hasText: 'Hi!' }).click();
  await other.waitForFunction(() => window.__clips.length && window.__clips.at(-1).end, null, { timeout: 5000 });
  await ear.waitForTimeout(500);
  const clip = await other.evaluate(() => window.__clips.at(-1));
  const during = await f.heard(ear, clip.start, clip.end);
  assert.ok(during.frames > 0 && during.loud > 0, `the microphone is never silenced while another Chat page speaks: ${JSON.stringify(during)}`);
  const others = f.controls.filter(body => body.type === 'clip' && body.source === 'other');
  assert.deepEqual(others.map(body => [body.on, body.text]), [[true, 'Hi!'], [false, undefined]], 'the other page\'s words, once, from the ear page');
  assert.deepEqual(f.errors, []);
});

test('Clear in the top bar drops the current question: strip order, off when there is nothing to clear or a hold, the ear and the Back stack untouched (maintainer 10/31)', { timeout: 90000 }, async t => {
  const f = await earFixture(t);
  const page = await f.open();
  const cdp = await f.context.newCDPSession(page);
  const touch = async (selector, ms = 60) => {
    const box = await page.locator(selector).boundingBox(); assert.ok(box, selector);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
    await page.waitForTimeout(ms); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  // Clear, Listen for <name>, the lock, •••, Hold to ask, left to right.
  const boxes = await page.evaluate(() => ['#clearQuestion', '#wakeToggle', '#stripLock', '#partnerOpen', '#ask'].map(id => document.querySelector(id).getBoundingClientRect().toJSON()));
  for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i - 1].right <= boxes[i].left, `strip order at ${i}: ${JSON.stringify(boxes.map(box => [box.left, box.right]))}`);
  const clear = page.locator('#clearQuestion');
  assert.equal((await clear.textContent()).trim(), 'Clear');
  assert.equal(await clear.isDisabled(), true, 'nothing to clear yet');
  async function ask(text, first) {
    await f.emit(page, { type: 'utterance-sealed', ear: true, earId: 'ear-1', windowId: `w-${text}`, seq: 1, text, windowText: text, generation: f.EAR });
    await f.emit(page, { type: 'batch-sealed', generation: f.EAR, windowId: `w-${text}`, seq: 1, kind: 'generated', choices: [{ label: first, say: first }, { label: 'Not now', say: 'Not now' }] });
    await page.waitForFunction(label => document.querySelector('#grid .response .label')?.textContent === label, first);
  }
  await ask('music or a story?', 'Music');
  await ask('what about lunch?', 'Tea');
  assert.equal(await clear.isDisabled(), false);
  await page.locator('#grid .tile.mode[data-mode="ask"]').click();
  await clear.click(); assert.equal(await page.locator('#grid .tile.response').count(), 0, 'a mouse or gaze click does nothing (the made set still shows)');
  const controlsBefore = f.controls.length;
  await touch('#clearQuestion');
  await page.waitForFunction(() => document.querySelector('#grid .tile.question .label')?.textContent === 'Ask me something');
  assert.deepEqual(await page.locator('#grid .tile.static .label').allTextContents(), ['Tell me more', 'Something else', 'Hi!', "What's up?", 'How are you?', 'Come sit with me.'], 'the openers are back');
  assert.equal(await page.locator('#grid .tile.mode.on').count(), 0, 'the lit mode is closed');
  assert.equal(await page.locator('#phase').textContent(), 'Listening for Ellie', 'the ear listens on');
  assert.deepEqual(f.controls.slice(controlsBefore), [], 'the session and the ear are untouched');
  assert.equal(await clear.isDisabled(), true, 'nothing left to clear');
  // The cleared batch is not kept for Back; the one before it is.
  await page.locator('#back').click();
  await page.waitForFunction(() => document.querySelector('#grid .response .label')?.textContent === 'Music');
  assert.equal(await page.locator('#grid .tile.question .label').textContent(), 'music or a story?');
  // A page open with nothing else: Clear closes it.
  await touch('#clearQuestion'); await page.waitForFunction(() => !document.querySelector('#grid .response'));
  await page.locator('#grid .tile.page[data-page="about"]').click();
  assert.equal(await clear.isDisabled(), false);
  await touch('#clearQuestion'); await page.locator('#grid .tile.page.on').waitFor({ state: 'detached' });
  // During a hold Clear is off.
  await ask('anything else?', 'Juice');
  const box = await page.locator('#ask').boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Capturing question');
  assert.equal(await clear.isDisabled(), true, 'off during a hold');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.deepEqual(f.errors, []);
});

test('the ear turns itself off when idle: a gentle status line, no countdown, the switch reads off and it stays off (spec 2026-10-28 §10)', { timeout: 90000 }, async t => {
  const f = await earFixture(t);
  const page = await f.open();
  const phase = () => page.locator('#phase').textContent();
  assert.equal(await phase(), 'Listening for Ellie');
  await f.emit(page, { type: 'ear', state: 'warning', remainingMs: 120000, earId: 'ear-1', generation: f.EAR });
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Listening turns off in 2 minutes');
  assert.equal(await page.evaluate(() => document.body.dataset.ear), 'on', 'the dot stays lit');
  await page.waitForTimeout(1200);
  assert.equal(await phase(), 'Listening turns off in 2 minutes', 'no countdown');
  // A wake clears the warning: the partner's 30 minutes restart at the hub.
  await f.emit(page, { type: 'utterance-sealed', ear: true, earId: 'ear-1', windowId: 'w-1', seq: 1, text: 'music or a story?', windowText: 'music or a story?', generation: f.EAR });
  await f.emit(page, { type: 'batch-sealed', generation: f.EAR, windowId: 'w-1', seq: 1, kind: 'generated', choices: [{ label: 'Music', say: 'Music' }, { label: 'A story', say: 'A story' }] });
  await page.waitForSelector('#grid .response');
  assert.equal(await phase(), 'Your turn');
  // With her replies showing, the warnings still reach the partner.
  await f.emit(page, { type: 'ear', state: 'warning', remainingMs: 60000, earId: 'ear-1', generation: f.EAR });
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Listening turns off in 1 minute');
  const opens = f.controls.filter(body => body.type === 'window' && body.ear === true).length;
  await f.emit(page, { type: 'ear', state: 'off', reason: 'idle', earId: 'ear-1', generation: f.EAR });
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Listening is off. Touch Listen for Ellie to turn it on');
  assert.equal(await page.locator('#wakeToggle').getAttribute('aria-pressed'), 'false');
  assert.equal((await page.locator('#wakeToggle').textContent()).trim(), 'Listen for Ellie: off');
  assert.equal(await page.evaluate(() => document.body.dataset.ear), 'off', 'the dot is out');
  await page.waitForTimeout(2500);
  assert.equal(f.controls.filter(body => body.type === 'window' && body.ear === true).length, opens, 'an idle-off is never re-opened by the page');
  const frames = await page.evaluate(() => window.__frames.length); await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__frames.length), frames, 'nothing more is sent');
  assert.equal(await phase(), 'Listening is off. Touch Listen for Ellie to turn it on', 'the line stays until the partner acts');
  // A hold clears it.
  const cdp = await f.context.newCDPSession(page), box = await page.locator('#ask').boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Capturing question');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
  assert.notEqual(await phase(), 'Listening is off. Touch Listen for Ellie to turn it on');
  assert.deepEqual(f.errors, []);
});

// A failed reply never ends the session (spec 2026-10-28 §14; 11/1: the reply
// service had no credit and every wake question's failure closed the session,
// the socket and the ear, so the partner's next question was never heard).
test('a failed reply fails the turn only (spec 2026-10-28 §14): the session, socket and ear stay, the question stays on the strip, the next wake question gets its replies, the record keeps the hub\'s code', { timeout: 90000 }, async t => {
  const f = await earFixture(t, { chatTestMode: true });
  const page = await f.open();
  const before = { controls: f.controls.length, requests: f.requests.length };
  await f.emit(page, { type: 'utterance-sealed', ear: true, earId: 'ear-1', windowId: 'w-1', seq: 1, text: 'does your tummy hurt?', windowText: 'does your tummy hurt?', generation: f.EAR });
  await f.emit(page, { type: 'choices-error', error: 'generation-unavailable', generation: f.EAR, windowId: 'w-1', seq: 1 });
  await page.waitForFunction(() => document.querySelector('#notice').textContent === 'Replies are unavailable. Your phrases still work.');
  assert.equal(await page.locator('#grid .tile.question .label').textContent(), 'does your tummy hurt?', 'the question stays on the strip');
  assert.equal(await page.locator('#phase').textContent(), 'Listening for Ellie');
  assert.equal(await page.evaluate(() => document.body.dataset.ear), 'on', 'the ear is still on');
  assert.equal(await page.evaluate(() => window.__socket.readyState), 1, 'the audio socket is open');
  assert.notEqual(await page.evaluate(() => window.__events.closed), true, 'the event stream is open');
  const framesAt = await page.evaluate(ear => window.__frames.filter(frame => frame.gen === ear).length, f.EAR);
  await page.waitForFunction(({ ear, at }) => window.__frames.filter(frame => frame.gen === ear).length > at + 3, { ear: f.EAR, at: framesAt }, { timeout: 5000 });
  await page.waitForTimeout(1500); // longer than the page's reopen delay
  assert.deepEqual(f.controls.slice(before.controls).filter(body => body.type !== 'clip'), [], 'no close, cancel, pause or ear change');
  assert.deepEqual(f.requests.slice(before.requests).filter(line => /^DELETE|\/sessions$/.test(line)), [], 'no session ended or started');
  // Her phrases still work; Clear is there for the failed question.
  assert.equal(await page.locator('#clearQuestion').isDisabled(), false);
  assert.ok(await page.locator('#grid .tile.yes.dwell').count() === 1);
  // The record: failed for 'choices', the hub's code kept, never its text.
  for (let i = 0; i < 100 && !f.turns.some(turn => turn.outcome === 'failed'); i++) await page.waitForTimeout(20);
  const failed = f.turns.find(turn => turn.outcome === 'failed');
  assert.ok(failed, 'the failed turn is recorded');
  assert.deepEqual([failed.reason, failed.content.choicesError, failed.content.transcript, failed.content.wake], ['choices', 'generation-unavailable', 'does your tummy hurt?', true]);
  // The ear listens on: the next wake question renders its replies.
  await f.emit(page, { type: 'utterance-sealed', ear: true, earId: 'ear-1', windowId: 'w-2', seq: 1, text: 'music or a story?', windowText: 'music or a story?', generation: f.EAR });
  await f.emit(page, { type: 'batch-sealed', generation: f.EAR, windowId: 'w-2', seq: 1, kind: 'generated', choices: [{ label: 'Music', say: 'Music' }, { label: 'A story', say: 'A story' }] });
  await page.waitForFunction(() => document.querySelector('#grid .response .label')?.textContent === 'Music');
  assert.equal(await page.locator('#grid .tile.question .label').textContent(), 'music or a story?');
  assert.equal(await page.locator('#notice').textContent(), '', 'the failure line goes with the next question');
  assert.deepEqual(f.errors, []);
});

test('Yes and No in full (spec 2026-10-28 §11): the phrases land in place with the feeling\'s picture and a check-mark or cross badge, the corners speak them, her pick wins, Clear/Back/Something else/a new question put the plain Yes and No back, the record says answered', { timeout: 90000 }, async t => {
  const f = await earFixture(t, { chatTestMode: true });
  const vocabulary = await fs.readFile(path.join(root, 'public/chat/vocabulary.json'));
  // A one-pixel PNG for every library picture: the page's own /symbol/<id> route.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const records = [];
  await f.context.route('**/chat/vocabulary.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: vocabulary }));
  await f.context.route('**/symbol/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
  await f.context.route('**/chat/api/turns', route => { try { const body = route.request().postDataJSON(); if (body) records.push(body); } catch {} return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  const page = await f.open();
  const YES_NO = [{ label: 'Yes', say: 'Yes.', symbol: 'yes', symbolId: 5584 }, { label: 'No', say: 'No.', symbol: 'no', symbolId: 5526 },
    { label: "I'm not sure", say: "I'm not sure.", symbol: 'not sure', symbolId: 11696 }, { label: 'Please say that again', say: 'Please say that again.', symbol: 'say again' }];
  async function ask(id, text) {
    await f.emit(page, { type: 'utterance-sealed', ear: true, earId: 'ear-1', windowId: id, seq: 1, text, windowText: text, generation: f.EAR });
    await f.emit(page, { type: 'batch-sealed', generation: f.EAR, windowId: id, seq: 1, kind: 'yes-no', choices: YES_NO });
    await page.waitForFunction(() => document.querySelectorAll('#grid .tile.response').length === 4 && document.querySelector('#grid .tile.response .label').textContent === 'Yes');
  }
  const answer = (id, feeling = 'hungry', words = ["Yes, I'm hungry", "No, I'm not hungry"]) => ({ type: 'yes-no-answered', generation: f.EAR, windowId: id, seq: 1, feeling,
    yes: { label: words[0], say: words[0], ...(feeling ? { symbol: feeling, symbolId: 4962 } : {}) }, no: { label: words[1], say: words[1], ...(feeling ? { symbol: feeling, symbolId: 4962 } : {}) } });
  const labels = () => page.locator('#grid .tile.response .label').allTextContents();
  const reply = label => page.locator('#grid .tile.response', { hasText: label }).first();
  const tileOf = side => page.evaluate(side => { const el = [...document.querySelectorAll('#grid .tile.response')][side === 'yes' ? 0 : 1];
    const badge = el.querySelector('.chat-badge'), picture = el.querySelector('.chat-symbol');
    const box = picture?.getBoundingClientRect(), mark = badge?.getBoundingClientRect();
    return { label: el.querySelector('.label').textContent, symbolId: el.dataset.symbolId, badge: badge ? { src: badge.getAttribute('src'), side: badge.dataset.side,
      shown: getComputedStyle(badge).display !== 'none', smaller: mark.width < box.width * 0.75, overlaps: mark.left < box.right && mark.right > box.left && mark.top < box.bottom && mark.bottom > box.top } : null }; }, side);
  // What she said: each speech turn's record (test mode) holds its words; clips may come from the warm cache.
  const saidCount = () => records.filter(record => record.content?.spoken).length;
  const lastSpoken = async text => { const before = saidCount(); for (let i = 0; i < 200 && saidCount() === before; i++) await page.waitForTimeout(20);
    assert.equal(records.filter(record => record.content?.spoken).at(-1)?.content.spoken, text); };

  await ask('w-1', 'are you hungry?');
  const cornerBefore = await page.locator('#grid .tile.yes').evaluate(el => [el.querySelector('.label').textContent, el.dataset.symbolId]);
  assert.deepEqual(cornerBefore, ['yes', '5584'], 'the corner shows the check mark');
  assert.equal((await tileOf('yes')).symbolId, '5584', 'the plain Yes reply shows the check mark too');
  // Another question's answers change nothing; this question's change only the Yes and No, in place.
  await f.emit(page, answer('w-other'));
  await page.waitForTimeout(100);
  assert.deepEqual(await labels(), ['Yes', 'No', "I'm not sure", 'Please say that again']);
  const kept = await page.evaluate(() => { window.__kept = [...document.querySelectorAll('#grid .tile')]; return window.__kept.length; });
  await f.emit(page, answer('w-1'));
  await page.waitForFunction(() => document.querySelector('#grid .tile.response .label').textContent === "Yes, I'm hungry");
  assert.deepEqual(await labels(), ["Yes, I'm hungry", "No, I'm not hungry", "I'm not sure", 'Please say that again']);
  assert.ok(await page.evaluate(n => document.querySelectorAll('#grid .tile').length === n && window.__kept.every(el => el.isConnected), kept), 'no tile was redrawn');
  await page.waitForFunction(() => [...document.querySelectorAll('#grid .chat-badge')].every(img => img.complete));
  const yes = await tileOf('yes'), no = await tileOf('no');
  assert.equal(yes.symbolId, '4962'); assert.equal(no.symbolId, '4962', 'both show the feeling');
  assert.deepEqual([yes.badge.src, yes.badge.side, no.badge.src, no.badge.side], ['/symbol/5584', 'yes', '/symbol/5526', 'no'], 'the check mark and the cross as badges');
  assert.ok(yes.badge.shown && yes.badge.smaller && yes.badge.overlaps, `a small badge on the picture: ${JSON.stringify(yes.badge)}`);
  assert.deepEqual(await page.locator('#grid .tile.yes').evaluate(el => [el.querySelector('.label').textContent, el.dataset.symbolId]), cornerBefore, 'the corner keeps its look');
  // The corners speak the phrase; the middle Yes speaks and records it.
  await page.locator('#grid .tile.no').click(); await lastSpoken("No, I'm not hungry");
  await reply("Yes, I'm hungry").click(); await lastSpoken("Yes, I'm hungry");
  // A new question: plain Yes and No; the first turn's record says answered, with the words she chose.
  await ask('w-2', 'is it raining?');
  const question = () => records.find(record => record.content?.transcript === 'are you hungry?');
  for (let i = 0; i < 100 && !question(); i++) await page.waitForTimeout(20);
  assert.equal(question().content.answered, true); assert.equal(question().content.selected.label, "Yes, I'm hungry");
  // Her pick wins: answers after it change nothing; the corner says plain Yes.
  await reply('No').click(); await lastSpoken('No.');
  await f.emit(page, answer('w-2', null, ["Yes, it's raining", "No, it isn't"]));
  await page.waitForTimeout(150);
  assert.deepEqual(await labels(), ['Yes', 'No', "I'm not sure", 'Please say that again']);
  await page.locator('#grid .tile.yes').click(); await lastSpoken('Yes.');
  // A bare Yes and No (one word each) is no answer in full: nothing changes and the record does not say answered.
  await ask('w-bare', 'is your tummy okay?');
  await f.emit(page, answer('w-bare', null, ['Yes', 'No.']));
  await page.waitForTimeout(150);
  await page.locator('#grid .tile.yes').click(); await lastSpoken('Yes.');
  // Without a feeling the check mark stays the picture, with no badge; Clear puts the plain set back.
  await ask('w-3', 'do you like dogs?');
  await f.emit(page, answer('w-3', null, ['Yes, I like dogs', "No, I don't"]));
  await page.waitForFunction(() => document.querySelector('#grid .tile.response .label').textContent === 'Yes, I like dogs');
  const bare = () => records.find(record => record.content?.transcript === 'is your tummy okay?');
  for (let i = 0; i < 100 && !bare(); i++) await page.waitForTimeout(20);
  assert.equal('answered' in bare().content, false, 'a bare Yes/No never counts as answered');
  const plainYes = await tileOf('yes');
  assert.equal(plainYes.symbolId, '5584'); assert.equal(plainYes.badge, null);
  const touch = async selector => { const cdp = await f.context.newCDPSession(page), box = await page.locator(selector).boundingBox();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
    await page.waitForTimeout(60); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
  const drops = () => f.controls.filter(body => body.type === 'drop').length;
  await touch('#clearQuestion');
  await page.waitForFunction(() => !document.querySelector('#grid .tile.response'));
  assert.equal(drops(), 0, 'the answers had landed: nothing to drop at the hub');
  await page.locator('#grid .tile.yes').click(); await lastSpoken('Yes.');
  // Back: the earlier batch returns plain.
  await page.locator('#back').click();
  await page.waitForFunction(() => document.querySelector('#grid .tile.response .label')?.textContent === 'Yes');
  assert.deepEqual(await labels(), ['Yes', 'No', "I'm not sure", 'Please say that again']);
  // Something else while the answers are still coming: the hub is told to drop them, and late ones change nothing.
  await ask('w-4', 'are you tired?');
  await page.locator('#grid .tile.static', { hasText: 'Something else' }).click();
  for (let i = 0; i < 100 && !drops(); i++) await page.waitForTimeout(20);
  assert.equal(drops(), 1, 'Something else drops the answers still coming');
  await page.waitForFunction(() => document.querySelector('#grid .tile.response .label')?.textContent === 'Music');
  await f.emit(page, answer('w-4', 'tired', ["Yes, I'm tired", "No, I'm not tired"]));
  await page.waitForTimeout(150);
  assert.deepEqual(await labels(), ['Music', 'A story']);
  assert.deepEqual(f.errors, []);
});

test('what the ear heard (spec 2026-10-28 §12-§13): every clip start (with its words) and end goes to the hub; the diagnostics box shows the page\'s clips and the last twelve ear lines', { timeout: 90000 }, async t => {
  const f = await earFixture(t);
  const page = await f.open();
  const gates = () => f.controls.filter(body => body.type === 'clip');
  await f.emit(page, { type: 'utterance-sealed', ear: true, earId: 'ear-1', windowId: 'w-1', seq: 1, text: 'music or a story?', windowText: 'music or a story?', generation: f.EAR });
  await f.emit(page, { type: 'batch-sealed', generation: f.EAR, windowId: 'w-1', seq: 1, kind: 'generated', choices: [{ label: 'Music', say: 'Music' }, { label: 'A story', say: 'A story' }] });
  await page.waitForSelector('#grid .response');
  assert.equal(gates().length, 0, 'nothing plays: no clip');
  await page.locator('#grid .response', { hasText: 'Music' }).click();
  for (let i = 0; i < 150 && gates().length < 2; i++) await page.waitForTimeout(20);
  const [on, off] = gates();
  assert.deepEqual([on.on, off.on, on.text, off.text, on.source, off.source], [true, false, 'Music', undefined, undefined, undefined], 'on with its words at the clip, off after it');
  assert.ok(Number.isFinite(on.at) && off.at > on.at);
  // Two clips a moment apart are two clips: no merge, each with its own words.
  await page.locator('#grid .tile.yes').click();
  await page.waitForTimeout(150);
  await page.locator('#grid .tile.no').click();
  for (let i = 0; i < 200 && gates().filter(g => !g.on).length < 3; i++) await page.waitForTimeout(20);
  await page.waitForTimeout(300);
  assert.deepEqual(gates().slice(2).filter(g => g.on).map(g => g.text), ['Yes.', 'No.']);
  assert.equal(gates().length, 6, JSON.stringify(gates().map(g => g.on)));
  // Another Chat page's voice: its words on the channel, an other clip; a message without words is no clip.
  await page.evaluate(() => { const channel = new BroadcastChannel('era-chat-audio'); channel.postMessage({ from: 'other-page', playing: true, text: 'A story' });
    channel.postMessage({ from: 'old-page', playing: true });
    setTimeout(() => channel.postMessage({ from: 'other-page', playing: false, text: 'A story' }), 200); });
  for (let i = 0; i < 150 && gates().length < 8; i++) await page.waitForTimeout(20);
  await page.waitForTimeout(100);
  assert.deepEqual(gates().slice(6).map(g => [g.on, g.source, g.text]), [[true, 'other', 'A story'], [false, 'other', undefined]]);
  const own = (await page.locator('#diagnostics').textContent()).split('\n').filter(line => / ear clip /.test(line));
  assert.deepEqual(own.map(line => line.replace(/^\d\d:\d\d:\d\d /, '')), ['ear clip Music', 'ear clip Yes.', 'ear clip No.', 'ear clip (another page) A story']);
  // The diagnostics box: the ear's lines, twelve at most, newest last.
  for (let i = 0; i < 14; i++) await f.emit(page, { type: 'ear', state: 'tier', tier: i % 2 ? 'main' : 'ear', earId: 'ear-1', generation: f.EAR });
  const box = await page.locator('#diagnostics').textContent();
  const lines = box.split('\n').filter(line => / ear /.test(line));
  assert.equal(lines.length, 12, box);
  assert.match(lines.at(-1), /^\d\d:\d\d:\d\d ear tier main$/);
  assert.deepEqual(f.errors, []);
});
