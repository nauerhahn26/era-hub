// Browser contract check against an existing preview. Real microphone graph and
// PCM framing, simulated recognition events: this is NOT a speech accuracy test.
// node tools/chat-browser-check.mjs <base URL> <scratch output directory>
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:8386';
const step = text => process.stdout.write(`[chat browser] ${text}\n`);
const out = process.argv[3] || await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-browser-'));
await fs.mkdir(out, { recursive: true });
// A synthetic tone exercises getUserMedia -> AudioWorklet -> resampler -> POST.
const rate = 48000, samples = rate * 5, wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF'); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 4000), 44 + i * 2);
const audioFile = path.join(out, 'capture-fixture.wav'); await fs.writeFile(audioFile, wav);
const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${audioFile}`, '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, hasTouch: true, permissions: ['microphone'] });
const page = await context.newPage();
const errors = [], controls = [], frames = [], spoken = [], choiceRequests = [];
let generation = 0, heldChoice = null, staleFinalChecked = false, stallCancel = false, releaseCancel = null, rejectNextAudio = false, rejectedAudio = 0, acceptedSequence = 0;
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  window.__qaSpeech = []; window.__qaStreams = []; window.__qaContexts = [];
  window.EventSource = class { constructor() { window.__qaEvents = this; } close() { this.closed = true; } };
  const Original = window.AudioContext;
  window.AudioContext = class extends Original { constructor(...args) { super(...args); window.__qaContexts.push(this); } };
  const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async options => { const s = await get(options); window.__qaStreams.push(s); return s; };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    cancel() {}, getVoices() { return []; }, speak(u) { window.__qaSpeech.push(u.text); setTimeout(() => u.onend?.(), 30); },
  } });
});
await page.route('**/chat/api/**', async route => {
  const req = route.request(), url = new URL(req.url());
  let data = {};
  if (url.pathname.endsWith('/config')) data = { wakeName: 'Ellie', runtime: { available: true }, choices: { available: true } };
  else if (url.pathname.endsWith('/sessions')) data = { id: 'browser-contract-session' };
  else if (url.pathname.endsWith('/control')) {
    const body = req.postDataJSON(); controls.push(body.type); const oldGeneration = generation;
    if (body.type !== 'finish') generation++;
    if (body.type === 'ask' && !staleFinalChecked) {
      await page.evaluate(generation => window.__qaEvents.onmessage({ data: JSON.stringify({ type: 'final', generation, text: 'stale earlier question' }) }), oldGeneration);
      assert.equal(await page.locator('#phase').textContent(), 'Capturing question', 'old final in ask acknowledgement gap is ignored');
      staleFinalChecked = true;
    }
    if (body.type === 'cancel' && stallCancel) await new Promise(resolve => { releaseCancel = resolve; });
    data = { generation };
  }
  else if (url.pathname.endsWith('/audio')) {
    const seq = Number(url.searchParams.get('seq'));
    if (rejectNextAudio) {
      rejectNextAudio = false; rejectedAudio++;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'capture-inactive' }) }); return;
    }
    if (seq !== acceptedSequence) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'audio-sequence' }) }); return;
    }
    acceptedSequence++;
    const bytes = req.postDataBuffer(); frames.push({ seq, length: bytes.length, nonzero: bytes.some(x => x !== 0) });
  } else if (url.pathname.endsWith('/choices')) {
    const body = req.postDataJSON();
    choiceRequests.push(body);
    if (body.text === 'older question') await new Promise(resolve => { heldChoice = resolve; });
    data = { choices: [{ id: 'first', label: body.text === 'older question' ? 'Older answer' : 'I like that!', say: body.text === 'older question' ? 'Older spoken answer.' : 'I like that idea!' }, { id: 'second', label: 'Something else', say: 'I would like something else.' }], kind: 'adapter' };
  }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
});
const emit = data => page.evaluate(data => window.__qaEvents.onmessage({ data: JSON.stringify(data) }), data);
const cdp = await context.newCDPSession(page);
async function touch(selector, duration = 0) {
  const box = await page.locator(selector).boundingBox(); assert.ok(box, selector);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, radiusX: 3, radiusY: 3 }] });
  if (duration) await page.waitForTimeout(duration);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
try {
  step('load');
  await page.goto(`${base}/chat/`); await page.waitForSelector('.tile');
  await page.waitForFunction(() => document.querySelector('#engineNote').textContent.includes('configured'));
  assert.equal(await page.locator('#grid .tile').count(), 12);
  assert.equal(await page.locator('#grid .rest').count(), 2);
  await page.locator('#startChat').click();
  await page.locator('#startChat').evaluate(el => el.click());
  assert.equal(await page.evaluate(() => window.__qaStreams.length), 0, 'generic mouse and synthetic gaze click cannot request microphone');
  await touch('#startChat');
  step('microphone requested');
  await page.waitForFunction(() => !!window.__qaEvents);
  await emit({ type: 'ready', generation, capabilities: { wake: true, automaticEndpoint: true } });
  step('worker ready');
  await page.waitForFunction(() => document.body.dataset.listening === 'true');
  await page.waitForFunction(() => window.__qaContexts.some(c => c.state === 'running'));
  await page.waitForTimeout(600);
  assert.ok(frames.length >= 3, 'real worklet produces streamed frames');
  assert.ok(frames.some(f => f.nonzero)); assert.ok(frames.every(f => f.length === 3200));
  assert.deepEqual(frames.map(f => f.seq), frames.map((_, i) => i));
  step('PCM stream verified');
  const asks = controls.filter(x => x === 'ask').length;
  await page.locator('#ask').click(); await page.locator('#ask').evaluate(el => el.click());
  assert.equal(controls.filter(x => x === 'ask').length, asks);
  await touch('#ask', 450);
  step('touch hold released');
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Capturing question');
  await page.waitForTimeout(200);
  assert.ok(controls.includes('ask')); assert.equal(controls.filter(x => x === 'finish').length, 1, 'touch release finishes exactly once');
  await emit({ type: 'final', text: 'a question', generation });
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Replies ready'));
  assert.equal(await page.locator('.response').count(), 0, 'new answers wait for a rest movement');
  const rest = await page.locator('.rest').first().boundingBox();
  await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2);
  await page.waitForSelector('.response');
  step('neutral committed replies');
  assert.equal(await page.locator('.response').first().textContent(), 'I like that!');
  stallCancel = true;
  await page.locator('.response').first().click();
  await page.waitForFunction(() => window.__qaSpeech.includes('I like that idea!'));
  assert.ok(releaseCancel, 'recognition cancel is deliberately stalled while device voice speaks');
  stallCancel = false; releaseCancel();
  await page.waitForFunction(() => document.body.dataset.listening === 'true');
  const priorAsk = controls.filter(x => x === 'ask').length;
  rejectNextAudio = true;
  await emit({ type: 'wake', generation });
  assert.equal(controls.filter(x => x === 'ask').length, priorAsk, 'wake does not reset worker capture');
  for (let i = 0; i < 20 && !rejectedAudio; i++) await page.waitForTimeout(50);
  assert.equal(rejectedAudio, 1, 'automatic endpoint rejects one final in-flight frame');
  await emit({ type: 'final', text: 'another question', generation });
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Replies ready'));
  assert.ok(choiceRequests.at(-1).context.includes('Me: I like that idea!'), 'follow-ups receive only confirmed spoken replies');
  assert.ok(!choiceRequests.at(-1).context.includes('Me: I would like something else.'), 'unselected suggestions never become personal history');
  await page.mouse.move(rest.x + 10, rest.y + 10); await page.waitForSelector('.response');
  const acceptedBeforeRearm = frames.length;
  await page.locator('.response').first().click();
  await page.waitForFunction(() => document.body.dataset.listening === 'true');
  for (let i = 0; i < 20 && frames.length === acceptedBeforeRearm; i++) await page.waitForTimeout(50);
  assert.ok(frames.length > acceptedBeforeRearm, 'audio sequence resumes after the final-frame rejection');
  await page.screenshot({ path: path.join(out, 'chat-desktop.png') });

  // An older typed request resolves after a fresh one; it cannot replace it.
  async function typed(text) {
    await page.locator('#partnerOpen').click(); await page.locator('#testing').evaluate(el => { el.open = true; });
    await page.locator('#typedQuestion').fill(text); await page.locator('#typedAsk').click();
  }
  await typed('older question'); await page.waitForTimeout(50); await typed('newer question');
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Replies ready'));
  heldChoice?.(); await page.mouse.move(rest.x + 20, rest.y + 20); await page.waitForSelector('.response');
  assert.equal(await page.locator('.response').first().textContent(), 'I like that!');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: path.join(out, 'chat-compact.png') });
  const overflow = await page.locator('.tile .label').evaluateAll(labels => labels.filter(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.parentElement.clientHeight - 12).map(el => el.textContent));
  assert.deepEqual(overflow, [], 'labels fit without clipping');
  await page.evaluate(() => window.__qaEvents.onerror());
  await page.waitForFunction(() => document.querySelector('#startChat').disabled === false);
  assert.equal(await page.locator('.response').first().textContent(), 'I like that!', 'engine expiry preserves committed answers');
  await page.locator('.yes').click();
  await page.waitForFunction(() => window.__qaSpeech.includes('Yes.'));
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => window.__qaStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')) && window.__qaContexts.every(c => c.state === 'closed'));
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Off');
  assert.equal(await page.locator('.response').count(), 0);
  assert.ok(staleFinalChecked); assert.deepEqual(errors, []);
  spoken.push(...await page.evaluate(() => window.__qaSpeech));
  const report = { ok: true, evidence: 'Real browser microphone graph with synthetic WAV; recognition events and choices simulated.', frames: frames.length, frameBytes: 3200, controls, spoken, errors, screenshots: ['chat-desktop.png', 'chat-compact.png'] };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally { await browser.close(); }
