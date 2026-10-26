// Full Chat page with owned loopback fixtures. No hub, credentials or paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { checkInstalledChatUI, makeChatToneWav, assertContentFreeMetrics } from '../tests-vm/lib/chat-ui-smoke.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const alternatives = { kind: 'alternatives', choices: [{ id: 'one', label: 'Music', say: 'Music' }, { id: 'two', label: 'A story', say: 'A story' }], timings: { totalMs: 7 } };
function serve() {
  return http.createServer(async (req, res) => {
    try {
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
}

test('combined Chat page validates icons, deliberate saved playback, timing privacy, held capture and timeout recovery', { timeout: 90000 }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-ui-'));
  const artifacts = process.env.ERA_CHAT_UI_OUT;
  if (artifacts) await fs.mkdir(artifacts, { recursive: true });
  const wav = path.join(scratch, 'microphone.wav'); await fs.writeFile(wav, makeChatToneWav());
  const server = serve(); server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
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
  const controls = [], uploaded = []; let generation = 0, sequence = 0, stalled = false, releaseUpload;
  await page.addInitScript(() => {
    window.EventSource = class { constructor() { window.__timingEvents = this; } close() { this.closed = true; } };
  });
  await page.route('**/voices', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, current: 'synthetic-saved' }) }));
  await page.route('**/tts', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: makeChatToneWav() }));
  await page.route('**/chat/api/**', async route => {
    const req = route.request(), url = new URL(req.url()); let result = {};
    if (url.pathname.endsWith('/config')) result = { runtime: { available: true, kind: 'built-in' }, choices: { available: true } };
    else if (url.pathname.endsWith('/sessions') && req.method() === 'POST') { generation = 0; sequence = 0; result = { id: 'private-browser-session' }; }
    else if (url.pathname.endsWith('/control')) {
      const body = req.postDataJSON(); controls.push(body.type); if (body.type !== 'finish') generation++;
      result = { generation };
    } else if (url.pathname.endsWith('/audio')) {
      assert.equal(Number(url.searchParams.get('seq')), sequence); sequence++;
      uploaded.push(req.postDataBuffer().length); result = { seq: sequence };
      if (stalled) await new Promise(resolve => { releaseUpload = resolve; });
    } else if (url.pathname.endsWith('/choices')) result = alternatives;
    else result = { ready: true, mode: 'paused' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) }).catch(() => {});
  });
  await page.goto(base + '/chat/'); await page.waitForFunction(() => document.querySelector('#engineNote').textContent.includes('set up'));
  const cdp = await context.newCDPSession(page);
  async function down(selector) {
    const box = await page.locator(selector).boundingBox(); assert.ok(box);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
  }
  const up = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  async function start() {
    await page.waitForFunction(() => !document.querySelector('#startChat').disabled); await down('#startChat'); await up();
    await page.waitForFunction(() => window.__timingEvents && !window.__timingEvents.closed);
    await page.evaluate(() => window.__timingEvents.onmessage({ data: JSON.stringify({ type: 'ready', capabilities: { remoteFinal: true } }) }));
    await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask');
  }
  async function finishHold() {
    const before = controls.filter(type => type === 'finish').length;
    await down('#ask'); await page.waitForTimeout(240); await up();
    for (let i = 0; i < 100 && controls.filter(type => type === 'finish').length === before; i++) await page.waitForTimeout(20);
    assert.equal(controls.filter(type => type === 'finish').length, before + 1);
  }
  await start(); await page.waitForTimeout(150); assert.equal(uploaded.length, 0, 'ready state sends no audio');
  await finishHold(); assert.ok(uploaded.length > 0); assert.equal(controls.includes('arm'), false);
  await page.evaluate(generation => window.__timingEvents.onmessage({ data: JSON.stringify({ type: 'final', generation, text: 'Would you like music or a story?', timings: { activityMs: 3, cloudMs: 30, finalDecodeMs: 33, audioMs: 240 } }) }), generation);
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Replies ready'));
  assert.equal(await page.locator('#phase').textContent(), 'Replies ready');
  assert.equal(await page.locator('.response').count(), 0, 'completed replies still require a fresh neutral movement');
  let stored = JSON.parse(await page.evaluate(() => localStorage.getItem('chat:timings:v1')));
  const held = stored.turns.find(row => row.kind === 'hold'); assert.ok(held.timings.transcriptToChoicesMs >= 0); assert.equal(held.timings.choicesToRevealMs, undefined);
  const rest = await page.locator('.rest').first().boundingBox(); await page.mouse.move(0, 0); await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2);
  await page.waitForSelector('.response'); await page.locator('.response').first().click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('chat:timings:v1')).turns.some(row => row.kind === 'hold' && row.status === 'completed'));
  stored = JSON.parse(await page.evaluate(() => localStorage.getItem('chat:timings:v1'))); assertContentFreeMetrics(stored);
  const completed = stored.turns.find(row => row.kind === 'hold' && row.status === 'completed');
  for (const name of ['releaseToDrainedMs', 'finishRoundTripMs', 'releaseToTranscriptMs', 'transcriptToChoicesMs', 'choicesToRevealMs', 'revealToSelectMs', 'selectionToPlaybackMs', 'playbackMs']) assert.ok(Number.isFinite(completed.timings[name]), name);
  assert.equal(completed.timings.workerActivityMs, 3); assert.equal(completed.timings.workerCloudMs, 30);
  assert.equal(JSON.stringify(stored).includes('private-browser-session'), false); assert.equal(JSON.stringify(stored).includes('music'), false);
  for (const size of [{ width: 1280, height: 800 }, { width: 1600, height: 1000 }]) {
    await page.setViewportSize(size); await page.waitForTimeout(50);
    assert.equal(await page.locator('.rest .chat-symbol').count(), 0); assert.equal(await page.locator('.response .chat-symbol').count(), 2);
    const bad = await page.locator('.tile:not(.rest):not(.waiting) .label').evaluateAll(labels => labels.filter(label => {
      const tile = label.parentElement, style = getComputedStyle(tile), icon = tile.querySelector('.chat-symbol');
      const height = tile.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - (icon?.getBoundingClientRect().height || 0) - (icon ? parseFloat(style.rowGap) || 0 : 0);
      return parseFloat(style.fontSize) < 44 || label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > height + 1;
    }).map(label => label.textContent));
    assert.deepEqual(bad, []);
    const screenshot = `chat-${size.width}.png`;
    await page.screenshot({ path: path.join(scratch, screenshot) });
    if (artifacts) await fs.copyFile(path.join(scratch, screenshot), path.join(artifacts, screenshot));
  }
  const finishes = controls.filter(type => type === 'finish').length;
  await down('#ask'); await page.waitForTimeout(120); await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Off'); assert.equal(controls.filter(type => type === 'finish').length, finishes);
  await start(); stalled = true; await down('#ask');
  for (let i = 0; i < 100 && !releaseUpload; i++) await page.waitForTimeout(20);
  assert.ok(releaseUpload); await up(); await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Off', null, { timeout: 6000 });
  stalled = false; releaseUpload(); assert.equal(controls.filter(type => type === 'finish').length, finishes);
  await start(); await finishHold(); assert.equal(controls.filter(type => type === 'finish').length, finishes + 1);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  stored = JSON.parse(await page.evaluate(() => localStorage.getItem('chat:timings:v1'))); assertContentFreeMetrics(stored);
  assert.ok(stored.turns.some(row => row.status === 'cancelled' && row.reason === 'cancel'));
  assert.ok(stored.turns.some(row => row.status === 'failed' && row.reason === 'timeout'));
  assert.ok(stored.turns.some(row => row.status === 'cancelled' && row.reason === 'closed'));
  assert.deepEqual(errors, []);
  assert.equal(negativeControlRequests, 1);
  assert.equal(unexpectedForeignRequests, 0, 'no other foreign network attempts');
  if (artifacts) await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ ok: true,
    evidence: 'Owned local fixture only. Native browser saved-audio playback; real worklet with synthetic microphone input. Recognition, choices and voice services are mocked. No device, real service, voice-quality or speech-accuracy claim.',
    installedUIContracts: report, heldCapture: true, freshNeutralRequired: true, boundedUploadRecovery: true,
    cancelledAndFailedSeparate: true, numericExportOnly: true, screenshots: ['chat-1280.png', 'chat-1600.png'], counts: stored.summary.counts }, null, 2));
});
