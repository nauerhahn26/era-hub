// One paced, release-ended hold turn through the actual preview APIs.
// No recognition, choices, microphone graph or server responses are mocked.
// Supply external, attributed mono 16k PCM16 WAV fixtures; none live in the repo.
// node tools/chat-real-browser-check.mjs <base> <scratch dir> <hold.wav> <expected,words>
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const [base, out, holdFile, expectedText] = process.argv.slice(2);
if (!base || !out || !holdFile || !expectedText) throw new Error('Supply base, scratch directory, an external hold WAV file and expected choice words.');
const expected = expectedText.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const leadMs = 8000, tailMs = 10000;
await fs.mkdir(out, { recursive: true });
function pcmFromWave(wav) {
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let offset = 12, data = null, format = null;
  while (offset + 8 <= wav.length) {
    const kind = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4), body = offset + 8;
    if (kind === 'fmt ') format = { encoding: wav.readUInt16LE(body), channels: wav.readUInt16LE(body + 2), rate: wav.readUInt32LE(body + 4), bits: wav.readUInt16LE(body + 14) };
    if (kind === 'data') data = wav.subarray(body, body + size);
    offset = body + size + size % 2;
  }
  assert.deepEqual(format, { encoding: 1, channels: 1, rate: 16000, bits: 16 }); assert.ok(data?.length);
  return data;
}
function paddedWave(pcm) {
  const bytes = leadMs * 32 + pcm.length + tailMs * 32, wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF'); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  pcm.copy(wav, 44 + leadMs * 32); return wav;
}
async function runCase(file) {
  const kind = 'hold';
  const pcm = pcmFromWave(await fs.readFile(file));
  const clipMs = pcm.length / 32, padded = path.join(out, `${kind}-padded.wav`);
  await fs.writeFile(padded, paddedWave(pcm));
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${padded}`, '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, hasTouch: true, permissions: ['microphone'] });
  const page = await context.newPage(), errors = [], remoteRequests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', req => { if (new URL(req.url()).origin !== new URL(base).origin) remoteRequests.push(new URL(req.url()).origin); });
  await page.addInitScript(() => {
    window.__realChat = { events: [], audio: [], choices: null, stagedAt: null, visibleAt: null, finishAt: null, micAt: null, controls: [] };
    const eventSource = window.EventSource;
    window.EventSource = class extends eventSource {
      constructor(...args) { super(...args); this.addEventListener('message', e => {
        try { window.__realChat.events.push({ ...JSON.parse(e.data), browserAt: performance.now() }); } catch {}
      }); }
    };
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await get(options); window.__realChat.micAt = performance.now(); return stream; };
    const fetcher = window.fetch.bind(window);
    window.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href), stamp = performance.now();
      if (url.pathname.endsWith('/audio') && options.body instanceof ArrayBuffer) {
        const view = new DataView(options.body); let lastActive = -1;
        for (let i = 0; i < view.byteLength / 2; i++) if (Math.abs(view.getInt16(i * 2, true)) >= 150) lastActive = i;
        window.__realChat.audio.push({ at: stamp, bytes: view.byteLength, lastActive });
      }
      if (url.pathname.endsWith('/control')) {
        const control = JSON.parse(options.body); window.__realChat.controls.push({ type: control.type, at: stamp });
        if (control.type === 'finish') window.__realChat.finishAt = stamp;
      }
      const response = await fetcher(input, options);
      if (url.pathname.endsWith('/choices') && response.ok) window.__realChat.choices = { at: performance.now(), ...await response.clone().json() };
      return response;
    };
    addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
      const qa = window.__realChat;
      if (qa.stagedAt === null && document.querySelector('#notice')?.textContent.includes('Replies ready')) qa.stagedAt = performance.now();
      if (qa.visibleAt === null && document.querySelector('.response')) qa.visibleAt = performance.now();
    }).observe(document.body, { childList: true, subtree: true, characterData: true }));
  });
  const cdp = await context.newCDPSession(page);
  async function touchDown(selector) {
    const box = await page.locator(selector).boundingBox(); assert.ok(box);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, radiusX: 3, radiusY: 3 }] });
  }
  const touchUp = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const waitUntil = async target => { const delay = await page.evaluate(target => target - performance.now(), target); if (delay > 0) await page.waitForTimeout(delay); };
  try {
    process.stdout.write(`[real chat] ${kind}: starting real microphone and worker\n`);
    await page.goto(`${base}/chat/`);
    await page.waitForFunction(() => document.querySelector('#engineNote').textContent.includes('configured'));
    await touchDown('#startChat'); await touchUp();
    await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask', null, { timeout: 20000 });
    const micAt = await page.evaluate(() => window.__realChat.micAt);
    const now = await page.evaluate(() => performance.now());
    assert.ok(now < micAt + leadMs - 800, 'worker is ready before fixture speech begins');
    assert.equal(await page.evaluate(() => window.__realChat.audio.length), 0, 'warmup and ready state send no PCM');
    await waitUntil(micAt + leadMs - 450);
    assert.equal(await page.evaluate(() => window.__realChat.audio.length), 0, 'idle before hold sends no PCM');
    await touchDown('#ask');
    await waitUntil(micAt + leadMs + clipMs + 250);
    await touchUp();
    await page.waitForFunction(() => window.__realChat.stagedAt !== null || document.querySelector('#notice').textContent.includes('stopped'), null, { timeout: 35000 });
    assert.ok(await page.evaluate(() => window.__realChat.stagedAt !== null), 'actual recognition produces real choices');
    assert.equal(await page.locator('.response').count(), 0, 'actual returned choices remain staged until neutral gaze');
    const rest = await page.locator('.rest').first().boundingBox();
    await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2);
    await page.waitForSelector('.response'); await page.waitForTimeout(50);
    const qa = await page.evaluate(() => window.__realChat);
    const final = qa.events.find(e => e.type === 'final'); assert.ok(final);
    const labels = await page.locator('.response').allTextContents();
    for (const word of expected) assert.ok(labels.some(label => label.toLowerCase().includes(word)), `actual replies preserve ${word}`);
    assert.equal(qa.events.filter(e => e.type === 'wake').length, 0);
    assert.equal(qa.controls.filter(x => x.type === 'ask').length, 1);
    assert.equal(qa.controls.filter(x => x.type === 'finish').length, 1);
    assert.equal(qa.controls.filter(x => x.type === 'arm').length, 0);
    assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
    const last = qa.audio.filter(f => f.lastActive >= 0).at(-1);
    const speechEndEstimate = last ? last.at - last.bytes / 32 + (last.lastActive + 1) / 16 : null;
    const result = {
      kind, ok: true, finalText: final.text, choiceLabels: labels, choiceKind: qa.choices.kind,
      fixture: { source: 'Externally supplied synthetic speech fixture', clipMs, leadMs },
      latencyMs: {
        finishToChoicesReady: qa.finishAt === null ? null : +(qa.stagedAt - qa.finishAt).toFixed(1),
        estimatedSpeechEndToChoicesReady: speechEndEstimate === null ? null : +(qa.stagedAt - speechEndEstimate).toFixed(1),
        finalToChoicesReady: +(qa.stagedAt - final.browserAt).toFixed(1),
        neutralWaitAndPaint: +(qa.visibleAt - qa.stagedAt).toFixed(1),
      },
      speechEndMethod: 'Last above-threshold sample in actual uploaded PCM, timed from its browser request; estimate includes worklet buffering and request queue delay.',
      runtimeTimings: final.timings, readyCapabilities: qa.events.find(e => e.type === 'ready')?.capabilities,
      wakeEvents: 0, implicitArmCommands: 0, idleAudioUploads: 0, audioFrames: qa.audio.length,
      directBrowserRemoteRequests: remoteRequests,
      cloudBeforeActivation: 'Worker network calls are not instrumented by this browser check; no claim from browser request observation alone.',
      nativeVoicePlayback: 'Not exercised; no reply was selected.', errors,
    };
    await page.screenshot({ path: path.join(out, `${kind}-actual-choices.png`) });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) {
    const evidence = await page.evaluate(() => ({ phase: document.querySelector('#phase')?.textContent, notice: document.querySelector('#notice')?.textContent, qa: window.__realChat })).catch(() => null);
    await fs.writeFile(path.join(out, `${kind}-failure.json`), JSON.stringify(evidence, null, 2));
    throw error;
  } finally {
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }).catch(() => {});
    await browser.close();
  }
}
const results = [];
try { results.push(await runCase(holdFile)); }
catch (error) { results.push({ kind: 'hold', ok: false, error: error.message }); process.stdout.write(`[real chat] hold: ${error.message}\n`); }
await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ evidence: 'Hold-only real browser audio graph, actual worker, actual transcription and choices APIs. One bounded synthetic speech case; native playback not tested.', results }, null, 2));
if (results.some(r => !r.ok)) process.exitCode = 1;
