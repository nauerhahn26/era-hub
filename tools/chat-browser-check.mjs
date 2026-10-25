// Real microphone graph and PCM, simulated recognition/choices. No paid calls.
// node tools/chat-browser-check.mjs <existing preview base> <scratch directory>
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:8386';
const out = process.argv[3] || await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-browser-'));
const step = text => process.stdout.write(`[chat browser] ${text}\n`);
await fs.mkdir(out, { recursive: true });
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
// Installed before app timers. Fast-forward checks bounded holds and heartbeat
// behavior; the microphone/worklet continue to run on the real audio clock.
await page.clock.install();
const errors = [], controls = [], frames = [], choiceRequests = [], trace = [];
let generation = 0, serverSequence = 0, created = 0, statusPolls = 0;
let delayAsk = true, heldAsk = null, heldChoice = null, heldFailure = null;
let stallCancel = false, releaseCancel = null, staleFinalChecked = false;
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  window.__qaSpeech = []; window.__qaStreams = []; window.__qaContexts = []; window.__qaPointers = [];
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, e => {
    if (e.target.id === 'ask') window.__qaPointers.push({ type, id: e.pointerId });
  }, true);
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
  const req = route.request(), url = new URL(req.url()); let data = {};
  if (url.pathname.endsWith('/config')) data = { wakeName: 'Ellie', runtime: { available: true }, choices: { available: true } };
  else if (url.pathname.endsWith('/sessions') && req.method() === 'POST') {
    created++; generation = 0; serverSequence = 0; data = { id: `browser-session-${created}` };
  } else if (/\/sessions\/[^/]+$/.test(url.pathname) && req.method() === 'GET') {
    statusPolls++; data = { ready: true, mode: 'paused' };
  } else if (url.pathname.endsWith('/control')) {
    const body = req.postDataJSON(), previous = generation;
    controls.push(body.type); trace.push(body.type);
    if (body.type !== 'finish') generation++;
    const responseGeneration = generation;
    if (body.type === 'ask' && !staleFinalChecked) {
      await page.evaluate(generation => window.__qaEvents.onmessage({ data: JSON.stringify({ type: 'final', generation, text: 'stale earlier question' }) }), previous);
      assert.equal(await page.locator('#phase').textContent(), 'Capturing question'); staleFinalChecked = true;
    }
    if (body.type === 'ask' && delayAsk) {
      delayAsk = false; const status = await new Promise(resolve => { heldAsk = resolve; }); heldAsk = null;
      if (status === 503) { await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: 'capture-unavailable' }) }).catch(() => {}); return; }
    }
    if (body.type === 'cancel' && stallCancel) await new Promise(resolve => { releaseCancel = resolve; });
    data = { generation: responseGeneration };
  } else if (url.pathname.endsWith('/audio')) {
    const seq = Number(url.searchParams.get('seq'));
    assert.equal(seq, serverSequence, 'only accepted frames consume sequence numbers'); serverSequence++;
    const bytes = req.postDataBuffer(); trace.push('audio');
    frames.push({ session: created, seq, length: bytes.length, nonzero: bytes.some(x => x !== 0) });
    data = { seq: serverSequence };
  } else if (url.pathname.endsWith('/choices')) {
    const body = req.postDataJSON(); choiceRequests.push(body);
    if (body.text === 'older question') await new Promise(resolve => { heldChoice = resolve; });
    if (body.text === 'late failing question') await new Promise(resolve => { heldFailure = resolve; });
    if (['unavailable choices', 'late failing question'].includes(body.text)) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'choices-unavailable' }) }).catch(() => {}); return;
    }
    data = { choices: [{ id: 'first', label: body.text === 'older question' ? 'Older answer' : 'I like that!', say: body.text === 'older question' ? 'Older spoken answer.' : 'I like that idea!' }, { id: 'second', label: 'Something else', say: 'I would like something else.' }], kind: 'adapter' };
  }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
});
const emit = data => page.evaluate(data => window.__qaEvents.onmessage({ data: JSON.stringify(data) }), data);
const cdp = await context.newCDPSession(page);
async function down(selector) {
  const b = await page.locator(selector).boundingBox(); assert.ok(b, selector);
  const point = { id: 1, x: b.x + b.width / 2, y: b.y + b.height / 2, radiusX: 3, radiusY: 3 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }); return point;
}
const up = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
async function touch(selector, ms = 0) { await down(selector); if (ms) await page.waitForTimeout(ms); await up(); }
async function waitNode(predicate, label) { for (let i = 0; i < 100 && !predicate(); i++) await page.waitForTimeout(20); assert.ok(predicate(), label); }
const finishCount = () => controls.filter(x => x === 'finish').length;
async function idleNoAudio(ms = 180) { const before = frames.length; await page.waitForTimeout(ms); assert.equal(frames.length, before, 'idle has zero audio uploads'); }
async function ready() {
  await emit({ type: 'ready', generation, capabilities: { wake: true, automaticEndpoint: true, remoteFinal: true } });
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  assert.equal(await page.evaluate(() => document.body.dataset.listening), 'false');
  assert.ok((await page.locator('#engineNote').textContent()).includes('Voice activation is off'));
  assert.equal(controls.includes('arm'), false);
}
async function restart() {
  await page.waitForFunction(() => !document.querySelector('#startChat').disabled);
  await touch('#startChat'); await page.waitForFunction(() => window.__qaEvents && !window.__qaEvents.closed); await ready();
}
async function commit(text = 'a question') {
  await emit({ type: 'final', text, generation });
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Replies ready'));
  assert.equal(await page.locator('.response').count(), 0);
  const rest = await page.locator('.rest').first().boundingBox();
  await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2); await page.waitForSelector('.response');
}
async function normalHold(ms = 220) {
  const count = finishCount(); await touch('#ask', ms); await waitNode(() => finishCount() === count + 1, 'release finishes once');
}
async function typed(text) {
  await page.locator('#partnerOpen').click(); await page.locator('#testing').evaluate(el => { el.open = true; });
  await page.locator('#typedQuestion').fill(text); await page.locator('#typedAsk').click();
}
async function disposed() {
  await page.waitForFunction(() => window.__qaStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')) && window.__qaContexts.every(c => c.state === 'closed'));
}
try {
  step('startup stays idle until hold');
  await page.goto(`${base}/chat/`); await page.waitForSelector('.tile');
  await page.waitForFunction(() => document.querySelector('#engineNote').textContent.includes('configured'));
  assert.equal(await page.locator('#grid .tile').count(), 12); assert.equal(await page.locator('#grid .rest').count(), 2);
  await page.locator('#startChat').click(); await page.locator('#startChat').evaluate(el => el.click());
  assert.equal(await page.evaluate(() => window.__qaStreams.length), 0);
  await touch('#startChat'); await page.waitForFunction(() => !!window.__qaEvents);
  assert.equal(await page.locator('#ask').isDisabled(), true);
  await page.waitForTimeout(220); assert.equal(frames.length, 0);
  await ready(); await idleNoAudio();
  await emit({ type: 'wake', generation: 999 }); await emit({ type: 'final', generation: 999, text: 'unsolicited' });
  assert.equal(await page.locator('#phase').textContent(), 'Ready to ask'); await idleNoAudio();
  const asks = controls.filter(x => x === 'ask').length;
  await page.locator('#ask').click(); await page.locator('#ask').evaluate(el => el.click());
  assert.equal(controls.filter(x => x === 'ask').length, asks);

  step('slow acknowledgement preserves held-only audio, release drains once');
  const firstFinger = await down('#ask'); await waitNode(() => !!heldAsk, 'Ask is awaiting acknowledgement');
  const secondFinger = { ...firstFinger, id: 2, x: firstFinger.x + 12 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [firstFinger, secondFinger] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [secondFinger] });
  assert.equal(finishCount(), 0, 'a second finger cannot release the first hold');
  assert.equal(await page.locator('#ask').evaluate(el => el.classList.contains('held')), true, 'the initiating finger still owns the hold');
  await page.waitForTimeout(340); assert.equal(frames.length, 0, 'held audio is buffered locally before Ask acknowledgement');
  await up(); await page.waitForTimeout(100); assert.equal(finishCount(), 0);
  assert.equal(frames.length, 0); heldAsk(200);
  await waitNode(() => finishCount() === 1, 'release flushes and finishes after acknowledgement');
  assert.ok(frames.reduce((n, f) => n + f.length, 0) >= 6400, 'initial held words were not dropped');
  assert.ok(frames.every(f => f.length <= 3200 && f.length % 2 === 0)); assert.ok(frames.some(f => f.nonzero));
  assert.equal(trace.at(-1), 'finish', 'all PCM reaches the API before Finish');
  await idleNoAudio(); await commit();
  assert.equal(await page.locator('.response').first().textContent(), 'I like that!');
  stallCancel = true; await page.locator('.response').first().click();
  await page.waitForFunction(() => window.__qaSpeech.includes('I like that idea!'));
  assert.ok(releaseCancel); stallCancel = false; releaseCancel();
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Your turn');
  await idleNoAudio(); assert.equal(controls.includes('arm'), false);

  step('fixed speech cancels held audio and pending acknowledgement without submitting');
  let finishes = finishCount(); await down('#ask'); await page.waitForTimeout(130);
  await page.locator('.yes').evaluate(el => el.click()); await up();
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask');
  assert.equal(finishCount(), finishes); await idleNoAudio();
  delayAsk = true; const beforeBuffered = frames.length;
  await down('#ask'); await waitNode(() => !!heldAsk, 'second pending Ask'); await page.waitForTimeout(160);
  await page.locator('.yes').evaluate(el => el.click()); heldAsk(503); await up();
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask');
  assert.equal(finishCount(), finishes); assert.equal(frames.length, beforeBuffered); await idleNoAudio();
  assert.equal(await page.locator('#startChat').isDisabled(), true, 'late canceled Ask failure does not close the warm session');
  await normalHold(); await commit('another question');
  assert.ok(choiceRequests.at(-1).context.includes('Me: I like that idea!'));
  assert.ok(!choiceRequests.at(-1).context.includes('Me: I would like something else.'));
  await page.screenshot({ path: path.join(out, 'chat-desktop.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: path.join(out, 'chat-compact.png') });
  const overflow = await page.locator('.tile .label').evaluateAll(labels => labels.filter(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.parentElement.clientHeight - 12).map(el => el.textContent));
  assert.deepEqual(overflow, []);

  step('heartbeat keeps idle session without audio or recognition commands');
  const polls = statusPolls, gen = generation, commands = controls.length, idleFrames = frames.length;
  await page.clock.fastForward(30001); await waitNode(() => statusPolls > polls, 'idle status poll');
  assert.equal(generation, gen); assert.equal(controls.length, commands); assert.equal(frames.length, idleFrames);

  step('pointer cancel aborts, and choices failure still permits restart');
  finishes = finishCount(); await down('#ask'); await page.waitForTimeout(100);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await disposed();
  await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Off'); assert.equal(finishCount(), finishes);
  await restart(); await idleNoAudio();
  await typed('older question'); await page.waitForTimeout(40); await typed('newer question');
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Replies ready'));
  heldChoice?.();
  let rest = await page.locator('.rest').first().boundingBox(); await page.mouse.move(rest.x + 20, rest.y + 20); await page.waitForSelector('.response');
  assert.equal(await page.locator('.response').first().textContent(), 'I like that!');
  await typed('unavailable choices'); await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Off'); await disposed();
  assert.equal(await page.locator('#startChat').isEnabled(), true); assert.equal(await page.locator('#ask').isDisabled(), true);
  await page.locator('.yes').click(); await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Off');
  await restart(); await typed('late failing question'); await waitNode(() => !!heldFailure, 'late request is pending');
  await touch('#endChat'); await restart(); heldFailure(); await page.waitForTimeout(100);
  assert.equal(await page.locator('#phase').textContent(), 'Ready to ask'); assert.equal(await page.locator('#ask').isEnabled(), true);
  await idleNoAudio();

  step('hold limit aborts rather than submitting; hide disposes capture and heartbeat');
  finishes = finishCount(); await down('#ask'); await page.clock.fastForward(15001); await disposed(); await up();
  assert.equal(finishCount(), finishes); assert.equal(await page.locator('#phase').textContent(), 'Off');
  await restart(); await normalHold(); await commit('current question');
  await page.evaluate(() => window.__qaEvents.onerror()); await disposed();
  assert.equal(await page.locator('.response').first().textContent(), 'I like that!');
  await restart(); finishes = finishCount(); await down('#ask'); await page.waitForTimeout(100);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await disposed(); await up();
  assert.equal(await page.locator('#phase').textContent(), 'Off'); assert.equal(await page.locator('.response').count(), 0); assert.equal(finishCount(), finishes);
  const endedPolls = statusPolls, endedFrames = frames.length; await page.clock.fastForward(30001); await page.waitForTimeout(50);
  assert.equal(statusPolls, endedPolls); assert.equal(frames.length, endedFrames); assert.equal(controls.includes('arm'), false);
  assert.ok(staleFinalChecked); assert.deepEqual(errors, []);
  const report = { ok: true, evidence: 'Hold-only UI, real microphone/worklet with synthetic WAV; recognition, choices and heartbeat service simulated.',
    frames: frames.length, frameBytesMax: 3200, idleAudioUploads: 0, implicitArmCommands: 0, statusPolls,
    pendingAskAudioPreserved: true, fixedSpeechAbortsHold: true, canceledAskFailureIgnored: true,
    pointerCancelDoesNotSubmit: true, holdLimitDoesNotSubmit: true, choicesFailureRecovery: true, staleFailureAfterRestartIgnored: true,
    controls, spoken: await page.evaluate(() => window.__qaSpeech), errors, screenshots: ['chat-desktop.png', 'chat-compact.png'] };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally { await browser.close(); }
