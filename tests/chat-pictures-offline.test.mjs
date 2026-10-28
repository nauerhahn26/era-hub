// Chat pictures offline (spec 2026-10-27 §6): enabling Chat pre-warms every
// vocabulary picture into the hub's cache from the symbol provider, and the
// Chat page then shows them with the provider gone and every outside request
// blocked. The provider is an owned loopback fixture (ERA_SYMBOL_* seams);
// the hub, provider and browser use ports the system hands out.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { vocabularyIds } = createRequire(import.meta.url)('../chat-symbols.js');
const IDS = vocabularyIds();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'era-chat-pictures-'));
const CACHE = path.join(DATA, 'symbols-cache');

// A real 4x4 PNG whose colour encodes the variant, so the page decodes it.
function png(rgb) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(4, 0); header.writeUInt32BE(4, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...Array(4).fill(rgb).flat()])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const COLOUR = png([200, 40, 40]), GREY = png([90, 90, 90]);
const provider = { requests: [], server: null };
provider.server = http.createServer((req, res) => {
  provider.requests.push(req.url);
  const image = /^\/images\/(\d+)\.png$/.exec(req.url), bw = /^\/bw\/(\d+)\.png$/.exec(req.url);
  if (image || bw) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(bw ? GREY : COLOUR); return; }
  if (req.url.startsWith('/search/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify([{ _id: 1 }])); return; }
  res.writeHead(404).end();
});
await new Promise(resolve => provider.server.listen(0, '127.0.0.1', resolve));
const PROVIDER = `http://127.0.0.1:${provider.server.address().port}`;

async function freePort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}
let hub = null, base = '';
async function startHub() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  hub = spawn(process.execPath, ['server.js', String(port)], { cwd: HUB, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env,
    ERA_DATA_DIR: DATA, ERA_BIND: '127.0.0.1', ERA_CHAT_CONFIG_DISABLED: '1', ERA_SYMBOL_WARM_MS: '0', ERA_UPDATE_URL: 'http://127.0.0.1:1',
    ERA_SYMBOL_SEARCH_URL: PROVIDER + '/search/', ERA_SYMBOL_IMAGE_URL: PROVIDER + '/images/{id}.png',
    ERA_SYMBOL_IMAGE_BW_URL: PROVIDER + '/bw/{id}.png' } });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/settings')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('hub never came up');
}
async function stopHub() {
  if (!hub || hub.exitCode !== null) return;
  const exited = new Promise(resolve => hub.once('exit', resolve));
  hub.kill('SIGTERM'); await exited;   // only the pid this suite started
}
const cached = () => IDS.filter(id => fs.existsSync(path.join(CACHE, id + '.png')));
async function waitForCache(count, ms = 60000) {
  const deadline = Date.now() + ms;
  while (cached().length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  return cached().length;
}
after(async () => {
  await stopHub();
  provider.server.closeAllConnections(); await new Promise(resolve => provider.server.close(resolve));
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('enabling Chat pre-warms every vocabulary picture once, by id, and a restart fetches nothing again', { timeout: 120000 }, async () => {
  await startHub();
  assert.equal(cached().length, 0);
  const enabled = await fetch(base + '/apps', { method: 'POST', body: JSON.stringify({ id: 'chat', enabled: true }) });
  assert.ok(enabled.ok);
  assert.equal(await waitForCache(IDS.length), IDS.length, 'every vocabulary picture is in the cache');
  // (The board's own outfit pre-warm shares the provider; only Chat's ids are counted.)
  for (const id of IDS) assert.equal(provider.requests.filter(url => url === `/images/${id}.png`).length, 1, `picture ${id} fetched exactly once`);
  await stopHub();
  provider.requests.length = 0;
  await startHub();   // Chat is still enabled: the boot pass finds a complete cache
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.deepEqual(provider.requests, [], 'a complete cache makes no provider request');
});

test('the black-and-white variant is passed through to its own provider image and cached separately', { timeout: 30000 }, async () => {
  const id = IDS[0];
  const colour = Buffer.from(await (await fetch(`${base}/symbol/${id}`)).arrayBuffer());
  const first = await fetch(`${base}/symbol/${id}?color=false`);
  assert.equal(first.status, 200); assert.equal(first.headers.get('x-symbol-cache'), 'miss');
  const grey = Buffer.from(await first.arrayBuffer());
  assert.deepEqual(grey, GREY); assert.deepEqual(colour, COLOUR);
  assert.deepEqual(provider.requests.filter(url => url.startsWith('/bw/')), [`/bw/${id}.png`]);
  const again = await fetch(`${base}/symbol/${id}?color=false`);
  assert.equal(again.headers.get('x-symbol-cache'), 'hit');
  assert.equal((await fetch(`${base}/symbol/not-a-number?color=false`)).status, 404);
});

test('with the provider gone and outside requests blocked, Chat tiles show cached pictures', { timeout: 90000 }, async () => {
  provider.server.closeAllConnections(); await new Promise(resolve => provider.server.close(resolve));
  provider.requests.length = 0;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let foreign = 0;
    await context.route(url => url.origin !== base, route => { foreign++; return route.abort('blockedbyclient'); });
    const page = await context.newPage(), errors = [], symbolResponses = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/symbol/')) symbolResponses.push(response.headers()['x-symbol-cache']); });
    await page.goto(base + '/chat/');
    await page.waitForFunction(() => [...document.querySelectorAll('#grid button.tile img.chat-symbol')].length >= 10
      && [...document.querySelectorAll('#grid img.chat-symbol')].every(img => img.complete && img.naturalWidth > 0));
    const tiles = await page.locator('#grid button.tile').evaluateAll(nodes => nodes.map(node => {
      const img = node.querySelector('img.chat-symbol');
      return { label: node.textContent.trim(), src: img && new URL(img.src).pathname, kind: node.dataset.picture, width: img?.naturalWidth || 0 };
    }));
    for (const tile of tiles) {
      assert.match(tile.src || '', /^\/symbol\/\d+$/, `${tile.label} shows a cached library picture`);
      assert.equal(tile.kind, 'library', tile.label); assert.equal(tile.width, 4, tile.label);
    }
    assert.ok(symbolResponses.length >= tiles.length && symbolResponses.every(state => state === 'hit'), symbolResponses.join(','));
    // A reply turn from the hub's own shortcut: its pictures come from the cache too.
    await page.locator('#partnerOpen').click();
    await page.locator('#testing > summary').click();
    await page.locator('#typedQuestion').fill('Would you like music or a story?');
    await page.locator('#typedAsk').click();
    // The sealed batch shows at once (spec §4): no gaze move is needed.
    await page.locator('.response').first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.response img.chat-symbol')].every(img => img.complete && img.naturalWidth > 0));
    const replies = await page.locator('.response').evaluateAll(nodes => nodes.map(node => [node.querySelector('.label').textContent, node.dataset.symbol, node.dataset.picture]));
    assert.deepEqual(replies, [['Music', 'music', 'library'], ['A story', 'book', 'library']]);
    assert.equal(foreign, 0, 'the page never asks an outside host for a picture');
    assert.deepEqual(provider.requests, []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a reply tile that is one of the family shows their own picture; the other tiles keep their library pictures', { timeout: 60000 }, async () => {
  // This hub has no family library of its own: the built-in people (Mom, Dad, ...) stand in.
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.route(url => url.origin !== base, route => route.abort('blockedbyclient'));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/chat/');
    await page.locator('#partnerOpen').click();
    await page.locator('#testing > summary').click();
    await page.locator('#typedQuestion').fill('Do you want to play with Mom or Sam?');
    await page.locator('#typedAsk').click();
    await page.locator('.response').first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.response img.chat-symbol')].length === 2
      && [...document.querySelectorAll('.response img.chat-symbol')].every(img => img.complete && img.naturalWidth > 0));
    const replies = await page.locator('.response').evaluateAll(nodes => nodes.map(node => [node.querySelector('.label').textContent,
      node.dataset.picture, new URL(node.querySelector('img.chat-symbol').src).pathname]));
    assert.deepEqual(replies.map(row => row.slice(0, 2)), [['Mom', 'person'], ['Sam', 'library']]);
    assert.equal(replies[0][2], '/characters/mom.png');
    assert.match(replies[1][2], /^\/symbol\/\d+$/, 'an unknown name: the library\'s friend picture');
    const others = await page.locator('#grid button.tile:not(.response) img.chat-symbol').evaluateAll(imgs => imgs.map(img => new URL(img.src).pathname));
    assert.ok(others.length >= 4 && others.every(src => /^\/symbol\/\d+$/.test(src)), others.join(','));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
