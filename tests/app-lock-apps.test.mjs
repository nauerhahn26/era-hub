// Actual app entrypoints, with synthetic APIs and no live data. Execution deferred.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
const PUBLIC = new URL('../public/', import.meta.url).pathname;
let server, browser, base, passcodeHash = '';
before(async () => {
  server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://fixture.invalid').pathname;
    if (p === '/settings') {
      const respond = () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ lockMinutes: 0, lockPasscodeHash: passcodeHash, pauseGoes: 'tdsnap', dwellMs: 900 })); };
      if (req.method === 'POST') { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { const update = JSON.parse(body); if (typeof update.lockPasscodeHash === 'string') passcodeHash = update.lockPasscodeHash; respond(); }); }
      else respond(); return;
    }
    if (p === '/apps') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ apps: ['making-words','pencil','board','music','movies','this-week','reader','drawing','math','games','chat'].map(id => ({ id, installed: true, enabled: true })) })); return; }
    if (p === '/log') { res.writeHead(204).end(); return; }
    if (p.startsWith('/lib/') || /\.(js|css|svg|png)$/.test(p) || p.endsWith('/') || p === '/index.html') {
      let target = path.resolve(PUBLIC, '.' + p);
      if (!target.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
      try { res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(target)] || 'application/octet-stream'); res.end(fs.readFileSync(target)); }
      catch { res.writeHead(404).end(); } return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(p === '/books/index.json' ? [] : p === '/voices' ? { enabled: false, voices: [] } : {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch();
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
test('Math programmatic actions stay blocked and saved quantities survive unlock', async () => {
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => { window.__testHooks = true; });
    const page = await context.newPage(); await page.goto(base + '/math/');
    await page.waitForFunction(() => window.MathApp?.state().ready);
    const initial = await page.evaluate(() => window.MathApp.state().number);
    await page.evaluate(() => window.AppLock.get('math').lock());
    await page.evaluate(() => window.MathApp.action('more'));
    assert.equal(await page.evaluate(() => window.MathApp.state().number), initial);
    assert.equal(await page.locator('#barDoor').isVisible(), true);
    await page.evaluate(() => window.AppLock.get('math').requestUnlock());
    assert.equal(await page.evaluate(() => window.MathApp.state().number), initial);
  } finally { await context.close(); }
});
test('Chat already locked cannot start a microphone session and has an exit', async () => {
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => localStorage.setItem('era.app-lock.v1.chat', JSON.stringify({ until: 0 })));
    const page = await context.newPage(), sessions = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/chat/api/sessions')) sessions.push(request.url()); });
    await page.goto(base + '/chat/'); await page.locator('.app-lock-control').waitFor();
    await page.evaluate(() => document.querySelector('#startChat')?.click());
    assert.equal(await page.locator('.app-lock-curtain').isVisible(), true);
    assert.equal(await page.locator('#barDoor').isVisible(), true);
    assert.deepEqual(sessions, []);
  } finally { await context.close(); }
});

test('Settings offers independent app controls and does not lock anything on load', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage(); await page.goto(base + '/settings/#apps');
    await page.waitForFunction(() => document.querySelectorAll('[data-app-lock-id]').length === 11);
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('era.app-lock.v1.'))), []);
    await page.locator('[data-app-lock-id="music"] button').click();
    await page.waitForFunction(() => !!localStorage.getItem('era.app-lock.v1.music'));
    assert.equal(await page.evaluate(() => localStorage.getItem('era.app-lock.v1.movies')), null);
    await page.locator('[data-app-lock-id="music"] button').click();
    await page.waitForFunction(() => !localStorage.getItem('era.app-lock.v1.music'));
  } finally { await context.close(); }
});

test('saving a passcode refreshes its offline hash immediately', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage(); await page.goto(base + '/settings/#apps');
    await page.waitForFunction(() => document.querySelectorAll('[data-app-lock-id]').length === 11);
    await page.locator('#lockPass').fill('2468');
    const saved = page.waitForResponse(response => response.url().endsWith('/settings') && response.request().method() === 'POST');
    await page.locator('#lockPassSave').click(); await saved;
    const expected = await page.evaluate(async () => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('2468')))].map(b => b.toString(16).padStart(2, '0')).join(''));
    await page.waitForFunction(hash => JSON.parse(localStorage.getItem('era.app-lock.settings.v1')).lockPasscodeHash === hash, expected, { timeout: 3000 });
  } finally { passcodeHash = ''; await context.close(); }
});
