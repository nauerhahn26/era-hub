import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createState, serializeState, reduce } from '../public/games/state.js';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = process.env.ERA_TEST_TMP || os.tmpdir();
const data = fs.mkdtempSync(path.join(scratch, 'era-games-save-'));
const file = path.join(data, 'games', 'state.json');
const sibling = path.resolve(HUB, '..', 'era-core' + (process.env.ERA_WT_SUFFIX || ''));
const CORE = fs.existsSync(sibling) ? sibling : path.resolve(HUB, '..', 'era-core');
let child, base;
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function start() {
  const port = await freePort();
  child = spawn(process.execPath, ['server.js', String(port)], {
    cwd: HUB, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ERA_DATA_DIR: data, ERA_BIND: '127.0.0.1',
      ERA_GEO_URL: 'http://127.0.0.1:1/geo', ERA_WEATHER_URL: 'http://127.0.0.1:1' },
  });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error('hub exited before listening');
    try { await fetch(base + '/settings'); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('hub did not listen');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const owned = child;
  owned.kill('SIGTERM');
  await new Promise(resolve => owned.once('exit', resolve));
  child = null;
}
async function request(method, body, headers = {}) {
  return fetch(base + '/games/state', { method, headers: { 'Content-Type': 'application/json', ...headers }, body });
}
async function browserPage(browser, local, { holdBody = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(({ local }) => {
    window.__testHooks = true;
    if (local) localStorage.setItem('era.games.v1', local);
    window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  }, { local });
  if (holdBody) await context.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (url, options) => {
      if (url === '/games/state' && (!options || options.method !== 'PUT')) {
        return Promise.resolve({ status: 200, text: () => new Promise(resolve => { window.__finishSavedLoad = resolve; }) });
      }
      return original(url, options);
    };
  });
  for (const name of ['dwell.js', 'speech.js']) {
    await context.route(base + '/' + name, route => route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(CORE, name), 'utf8') }));
  }
  await context.route(base + '/lib/doorbar.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(CORE, 'lib', 'doorbar.js'), 'utf8') }));
  const page = await context.newPage();
  await page.goto(base + '/games/');
  await page.waitForFunction(() => window.GamesApp?.state().ready, {}, { timeout: 5000 });
  return { context, page };
}

test('Games state route persists validated wardrobes and both boards through hub restart', async () => {
  await start();
  try {
    assert.equal((await request('GET')).status, 404);
    let saved = reduce(createState(), { type: 'open', value: 'fashion' });
    saved = reduce(saved, { type: 'fashion-edit', value: 'color' });
    saved = reduce(saved, { type: 'option', value: 'coral' });
    saved = reduce(saved, { type: 'fashion-save' });
    saved = reduce(saved, { type: 'lineup-add', value: saved.fashion.looks[0].id });
    saved = reduce(saved, { type: 'open', value: 'connect4' });
    saved = reduce(saved, { type: 'connect4-drop', value: 0 });
    saved = reduce(saved, { type: 'open', value: 'tiles' });
    saved = reduce(saved, { type: 'tiles-move', value: 'left' });
    const raw = serializeState(saved);
    assert.equal((await request('PUT', raw)).status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    await stop();
    await start();
    const response = await request('GET');
    assert.equal(response.status, 200);
    const restored = JSON.parse(await response.text());
    const expected = JSON.parse(raw);
    assert.deepEqual(restored.fashion.draft, expected.fashion.draft);
    assert.deepEqual(restored.fashion.looks, expected.fashion.looks);
    assert.deepEqual(restored.fashion.lineup, expected.fashion.lineup);
    assert.deepEqual(restored.connect4, expected.connect4);
    assert.deepEqual(restored.tiles, expected.tiles);
  } finally { await stop(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('Games state route refuses malformed, oversize, foreign and corrupt writes without changing raw bytes', async () => {
  await start();
  try {
    const valid = serializeState(createState());
    assert.equal((await request('PUT', valid)).status, 200);
    for (const [body, status] of [['{', 400], [JSON.stringify({ version: 2 }), 400], ['x'.repeat(524289), 413]]) {
      assert.equal((await request('PUT', body)).status, status);
      assert.equal(fs.readFileSync(file, 'utf8'), valid);
    }
    assert.equal((await request('PUT', valid, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal(fs.readFileSync(file, 'utf8'), valid);
    fs.writeFileSync(file, '{broken');
    assert.equal((await request('GET')).status, 409);
    assert.equal(await (await fetch(base + '/games/state/recovery')).text(), '{broken');
    assert.equal((await request('PUT', valid)).status, 409);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    const oversizedOriginal = 'z'.repeat(524289);
    fs.writeFileSync(file, oversizedOriginal);
    assert.equal((await request('GET')).status, 409);
    assert.equal((await request('PUT', valid)).status, 409);
    const oversizedRecovery = await fetch(base + '/games/state/recovery');
    assert.equal(oversizedRecovery.status, 200);
    assert.equal(await oversizedRecovery.text(), oversizedOriginal);
    assert.equal(fs.readFileSync(file, 'utf8'), oversizedOriginal);
    fs.writeFileSync(file, valid);
    fs.mkdirSync(path.join(data, 'games', 'state.tmp'));
    assert.equal((await request('PUT', valid)).status, 500, 'atomic write failure is reported');
    assert.equal(fs.readFileSync(file, 'utf8'), valid, 'failed write preserves the previous state');
  } finally { await stop(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('fresh browser storage and a restarted hub restore all Games progress from the same data folder', async () => {
  await start();
  const browser = await chromium.launch();
  let context;
  try {
    let page;
    ({ context, page } = await browserPage(browser));
    let saved = reduce(createState(), { type: 'open', value: 'fashion' });
    for (const color of ['coral', 'plum', 'sky']) {
      saved = reduce(saved, { type: 'fashion-edit', value: 'color' });
      saved = reduce(saved, { type: 'option', value: color });
      saved = reduce(saved, { type: 'fashion-save' });
    }
    saved = reduce(saved, { type: 'lineup-add', value: saved.fashion.looks[0].id });
    saved = reduce(saved, { type: 'lineup-add', value: saved.fashion.looks[1].id });
    if (process.env.ERA_GAMES_SAVE_SHOTS) {
      const collection = structuredClone(saved);
      collection.view = 'fashion'; collection.fashion.view = 'collection';
      await page.evaluate(value => window.GamesApp.test.setState(value), collection);
      assert.equal(await page.evaluate(() => window.GamesApp.test.flush()), true);
      fs.mkdirSync(process.env.ERA_GAMES_SAVE_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ERA_GAMES_SAVE_SHOTS, 'fashion-collection-1280x800.png') });
    }
    saved = reduce(saved, { type: 'open', value: 'connect4' });
    saved = reduce(saved, { type: 'connect4-drop', value: 0 });
    saved = reduce(saved, { type: 'open', value: 'tiles' });
    saved = reduce(saved, { type: 'tiles-move', value: 'left' });
    await page.evaluate(value => window.GamesApp.test.setState(value), saved);
    assert.equal(await page.evaluate(() => window.GamesApp.test.flush()), true);
    assert.match(await page.locator('#saveNotice').textContent(), /Saved/);
    await context.close(); context = null;
    await stop(); await start();
    ({ context, page } = await browserPage(browser));
    assert.equal(await page.evaluate(() => localStorage.getItem('era.games.v1')), null, 'new browser context has no migration copy');
    const restored = await page.evaluate(() => window.GamesApp.state());
    assert.deepEqual(restored.fashion.looks, saved.fashion.looks);
    assert.deepEqual(restored.fashion.draft, saved.fashion.draft);
    assert.deepEqual(restored.fashion.lineup, saved.fashion.lineup);
    assert.deepEqual(restored.connect4, saved.connect4);
    assert.deepEqual(restored.tiles, saved.tiles);
    assert.equal(restored.paused, false);
    assert.equal(restored.hidden, false);
  } finally { await context?.close(); await browser.close(); await stop(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('valid browser progress migrates once only when durable progress is missing', async () => {
  await start();
  const browser = await chromium.launch();
  let context;
  try {
    let legacy = reduce(createState(), { type: 'open', value: 'fashion' });
    legacy = reduce(legacy, { type: 'fashion-edit', value: 'color' });
    legacy = reduce(legacy, { type: 'option', value: 'plum' });
    ({ context } = await browserPage(browser, serializeState(legacy)));
    await context.pages()[0].waitForFunction(() => document.querySelector('#saveNotice')?.textContent?.includes('Saved'));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).fashion.draft.color, 'plum');
    await context.close(); context = null;
    const replacement = reduce(createState(), { type: 'open', value: 'tiles' });
    ({ context } = await browserPage(browser, serializeState(replacement)));
    assert.equal((await context.pages()[0].evaluate(() => window.GamesApp.state())).fashion.draft.color, 'plum', 'server wins when it already exists');
  } finally { await context?.close(); await browser.close(); await stop(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('a held save fails visibly, stays playable, and a later choice retries without stale success', async () => {
  await start();
  const browser = await chromium.launch();
  let context;
  try {
    const opened = await browserPage(browser);
    context = opened.context;
    const page = opened.page;
    let held = false;
    await context.route(base + '/games/state', route => {
      if (route.request().method() !== 'PUT') return route.continue();
      if (!held) { held = true; return; }
      return route.continue();
    });
    await page.locator('[data-action="open"][data-value="fashion"]').click();
    await page.waitForFunction(() => document.querySelector('#saveNotice')?.textContent?.includes('Not saved'), {}, { timeout: 3000 });
    const noticeFit = await page.evaluate(() => {
      const el = document.querySelector('#saveNotice'), box = el.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(el);
      const ink = range.getBoundingClientRect();
      return { box: { left: box.left, right: box.right }, ink: { left: ink.left, right: ink.right }, width: innerWidth };
    });
    assert.ok(noticeFit.ink.left >= 0 && noticeFit.ink.right <= noticeFit.width, JSON.stringify(noticeFit));
    if (process.env.ERA_GAMES_SAVE_SHOTS) {
      fs.mkdirSync(process.env.ERA_GAMES_SAVE_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ERA_GAMES_SAVE_SHOTS, 'save-failed-1280x800.png') });
    }
    assert.equal((await page.evaluate(() => window.GamesApp.state())).view, 'fashion', 'failure does not freeze play');
    assert.equal(fs.existsSync(file), false, 'an unacknowledged save was not written');
    await page.locator('[data-action="fashion-new"]').click();
    await page.waitForFunction(() => document.querySelector('#saveNotice')?.textContent?.includes('Saved'), {}, { timeout: 3000 });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).fashion.view, 'workbench');
  } finally { await context?.close(); await browser.close(); await stop(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('rapid edits serialize writes and an older acknowledgement cannot mark the latest edit saved', async () => {
  await start();
  const browser = await chromium.launch();
  let context;
  try {
    const opened = await browserPage(browser);
    context = opened.context;
    const page = opened.page;
    const held = [];
    await context.route(base + '/games/state', route => {
      if (route.request().method() === 'PUT') held.push(route);
      else return route.continue();
    });
    await page.locator('[data-action="open"][data-value="fashion"]').click();
    await page.waitForFunction(() => document.querySelector('#saveNotice')?.textContent === 'Saving…');
    await page.locator('[data-action="fashion-new"]').click();
    assert.equal(held.length, 1, 'second write waits for first');
    await held[0].continue();
    for (let i = 0; i < 40 && held.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(held.length, 2);
    assert.equal(await page.locator('#saveNotice').textContent(), 'Saving…', 'older ACK cannot announce Saved');
    await held[1].continue();
    await page.waitForFunction(() => document.querySelector('#saveNotice')?.textContent === 'Saved');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).fashion.view, 'workbench');
  } finally { await context?.close(); await browser.close(); await stop(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('corrupt durable bytes block migration and writes but remain downloadable', async () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken durable bytes');
  await start();
  const browser = await chromium.launch();
  let context;
  try {
    const local = reduce(createState(), { type: 'open', value: 'tiles' });
    const opened = await browserPage(browser, serializeState(local));
    context = opened.context;
    const page = opened.page;
    assert.equal((await page.evaluate(() => window.GamesApp.state())).view, 'menu', 'local state cannot replace corrupt durable state');
    assert.match(await page.locator('#saveNotice').textContent(), /Not saved/);
    await page.locator('.partner-button').click();
    assert.match(await page.locator('#storageNotice').textContent(), /unreadable saved Games file remains untouched/);
    assert.equal(await (await page.request.get(base + '/games/state/recovery')).text(), '{broken durable bytes');
    await page.locator('[data-action="open"][data-value="fashion"]').click();
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken durable bytes');
  } finally { await context?.close(); await browser.close(); await stop(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('Exit waits for the pending save acknowledgement before requesting kiosk close', async () => {
  await start();
  const browser = await chromium.launch();
  let context;
  try {
    const opened = await browserPage(browser);
    context = opened.context;
    const page = opened.page;
    let held, exits = 0;
    await context.route(base + '/games/state', route => {
      if (route.request().method() !== 'PUT') return route.continue();
      held = route;
    });
    await context.route(base + '/kiosk/exit', route => { exits++; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"action":"closed"}' }); });
    await page.locator('[data-action="open"][data-value="fashion"]').click();
    await page.waitForFunction(() => document.querySelector('#saveNotice')?.textContent === 'Saving…');
    await page.locator('#barDoor').click();
    await page.waitForTimeout(100);
    assert.equal(exits, 0);
    await held.continue();
    await page.waitForFunction(() => document.querySelector('#saveNotice')?.textContent === 'Saved');
    await page.waitForTimeout(100);
    assert.equal(exits, 1);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).view, 'fashion');
  } finally { await context?.close(); await browser.close(); await stop(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('a held GET body times out and its late response cannot replace live work', async () => {
  await start();
  const browser = await chromium.launch();
  let context;
  try {
    const opened = await browserPage(browser, null, { holdBody: true });
    context = opened.context;
    const page = opened.page;
    assert.match(await page.locator('#saveNotice').textContent(), /Not saved/);
    await page.locator('[data-action="open"][data-value="fashion"]').click();
    const stale = serializeState(reduce(createState(), { type: 'open', value: 'tiles' }));
    await page.evaluate(raw => window.__finishSavedLoad(raw), stale);
    await page.waitForTimeout(100);
    assert.equal((await page.evaluate(() => window.GamesApp.state())).view, 'fashion');
    assert.equal(fs.existsSync(file), false);
  } finally { await context?.close(); await browser.close(); await stop(); fs.rmSync(data, { recursive: true, force: true }); }
});
