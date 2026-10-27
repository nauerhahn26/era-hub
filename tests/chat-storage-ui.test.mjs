import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
async function deadline(work, ms) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('observation deadline exceeded')), ms); })]); }
  finally { clearTimeout(timer); }
}

// One Chromium for the file (CPU audit 10/27). browser.newPage() opens every
// page in a context of its own, so no storage or route crosses cases.
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

test('explicit device voice still works for this page when durable state is unavailable, without claiming saved', async t => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  t.after(() => page.close());   // and with it the context newPage() opened for it
  const errors = []; let foreign = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__chosenWords = [];
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    Object.defineProperty(window, 'speechSynthesis', { value: { cancel() {}, getVoices: () => [], speak(utterance) {
      window.__chosenWords.push(utterance.text); queueMicrotask(() => { utterance.onstart?.(); utterance.onend?.(); });
    } } });
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => { throw Error('microphone forbidden in this check'); };
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://chat.test') { foreign++; return route.abort(); }
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/chat/api/state') return json({ error: 'state_unavailable' }, 503);
    if (url.pathname === '/chat/api/config') return json({ runtime: { available: false }, choices: { available: true } });
    if (url.pathname === '/settings') return json({ dwellMs: 1200, pauseGoes: 'home' });
    if (url.pathname === '/voices') return json({ enabled: false, current: 'unconfigured' });
    const file = path.join(publicRoot, url.pathname === '/chat/' ? 'chat/index.html' : url.pathname);
    if (!file.startsWith(publicRoot)) return route.fulfill({ status: 404 });
    try { return route.fulfill({ body: await fs.readFile(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); }
    catch { return route.fulfill({ status: 404 }); }
  });
  await page.goto('http://chat.test/chat/');
  await page.waitForFunction(() => document.body.dataset.storageReady === 'true');
  assert.equal(await page.locator('body').getAttribute('data-storage-available'), 'false');
  await page.locator('#partnerOpen').click();
  await page.locator('#voicePreference').selectOption('local');
  await page.waitForFunction(() => !document.querySelector('#voicePreference').disabled);
  assert.equal(await page.locator('#voicePreference').inputValue(), 'local');
  assert.match(await page.locator('#storageStatus').innerText(), /not.*saved|unsaved/i);
  await page.getByRole('button', { name: 'Close partner settings', exact: true }).click();
  await page.getByRole('button', { name: 'yes', exact: true }).click();
  await page.waitForFunction(() => window.__chosenWords.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__chosenWords), ['Yes.']);
  assert.deepEqual(errors, []); assert.equal(foreign, 0);
});

test('Chat Exit waits for timing acknowledgement or its bounded fallback while Talk stays immediate', async t => {
  for (const scenario of ['ack', 'timeout', 'talk']) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    let release, put, action, actionResolve, putResolve;
    const pending = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { actionResolve = resolve; });
    const writing = new Promise(resolve => { putResolve = resolve; });
    const order = [];
    await page.addInitScript(() => {
      const fetcher = window.fetch;
      window.fetch = (...args) => {
        if (String(args[0]).startsWith('/kiosk/')) window.__handoffAt = performance.now();
        return fetcher(...args);
      };
      document.addEventListener('click', event => { if (event.target.closest('#barDoor,#barTalk')) window.__doorAt = performance.now(); }, true);
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      Object.defineProperty(window, 'speechSynthesis', { value: { cancel() {}, getVoices: () => [], speak(utterance) { queueMicrotask(() => { utterance.onstart?.(); utterance.onend?.(); }); } } });
    });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://chat.test') return route.abort();
      const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname === '/settings') return json({ dwellMs: 1200, pauseGoes: 'tdsnap' });
      if (url.pathname === '/chat/api/config') return json({ runtime: { available: false } });
      if (url.pathname === '/chat/api/state') {
        const value = { voicePreference: 'local', stories: [], timings: [] };
        if (route.request().method() === 'GET') return json({ version: 1, revision: 1, exists: true, value });
        put = route.request().postDataJSON(); order.push('put'); putResolve(); await pending; order.push('ack');
        return json({ version: 1, revision: put.expectedRevision + 1, exists: true, value: { ...value, ...put.patch } }).catch(() => {});
      }
      if (url.pathname.startsWith('/kiosk/')) { action = url.pathname; order.push('handoff'); actionResolve(); return json({ action: url.pathname.endsWith('/pause') ? 'paused' : 'closed' }); }
      const file = path.join(publicRoot, url.pathname === '/chat/' ? 'chat/index.html' : url.pathname);
      if (!file.startsWith(publicRoot)) return route.fulfill({ status: 404 });
      try { return route.fulfill({ body: await fs.readFile(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); }
      catch { return route.fulfill({ status: 404 }); }
    });
    try {
      await page.goto('http://chat.test/chat/'); await page.waitForFunction(() => document.body.dataset.storageReady === 'true');
      await page.getByRole('button', { name: 'yes', exact: true }).click();
      await deadline(writing, 2000);
      assert.ok(put, 'a real timing PUT is pending before handoff');
      await page.locator(scenario === 'talk' ? '#barTalk' : '#barDoor').click();
      if (scenario === 'ack') {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(action, undefined, 'Exit has not overtaken the pending timing acknowledgement'); release();
      }
      await deadline(requested, 1800);
      const elapsed = await page.evaluate(() => window.__handoffAt - window.__doorAt);
      if (scenario === 'ack') assert.deepEqual(order.slice(0, 3), ['put', 'ack', 'handoff']);
      if (scenario === 'timeout') assert.ok(elapsed >= 600 && elapsed < 1100, `Chat's 850ms fallback observed ${elapsed}ms`);
      if (scenario === 'talk') { assert.equal(action, '/kiosk/pause'); assert.ok(elapsed < 300, `Talk did not wait for persistence: ${elapsed}ms`); }
    } finally { release(); await page.close(); }
  }
});
