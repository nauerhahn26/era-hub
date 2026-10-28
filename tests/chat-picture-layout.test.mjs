// Chat tiles by board law (spec 2026-10-27 §6; ux-contract §E 20; era-board
// board-render.js): the picture BESIDE the word at 42% of the tile's width and
// 82% of its height, a 74 px label target, the stacked layout for a long label
// before any shrink, a 44 px floor marked data-font-reduced, the two black
// rest cells and the yes/no tiles untouched, and no two tiles on a page
// sharing a picture. Owned loopback fixtures only; pictures come from the
// page's own /symbol/<id> route, never from another host.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { createChatStore } = require('../chat-store.js');
const { withSymbols } = require('../chat-symbols.js');
const root = fileURLToPath(new URL('../', import.meta.url));
const vocabulary = JSON.parse(await fs.readFile(new URL('../public/chat/vocabulary.json', import.meta.url), 'utf8'));
const source = await fs.readFile(new URL('../public/chat/symbols.js', import.meta.url), 'utf8');
const symbols = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const id = word => vocabulary.concepts.find(concept => concept.word === word).id;

test('page pictures are planned fixed tiles first and never repeat: alternate, then the bubble, then none', () => {
  assert.equal(symbols.setVocabulary(vocabulary), true);
  const entries = [
    { label: 'yes', type: 'yes' }, { label: 'no', type: 'no' }, { label: '', type: 'rest' }, { label: '', type: 'rest' },
    { label: 'Yes', type: 'response', symbol: 'yes', symbolId: id('yes') },
    { label: 'Music', type: 'response', symbol: 'music', symbolId: id('music') },
    { label: 'Songs', type: 'response', symbol: 'music', symbolId: id('music') },
    { label: 'More songs', type: 'response', symbol: 'music', symbolId: id('music') },
    { label: 'Tell me more', type: 'static' }, { label: 'Reactions', type: 'route' }, { label: 'My news', type: 'route' }, { label: 'Help me say it', type: 'route' },
  ];
  const plan = symbols.planPictures(entries);
  assert.equal(plan[0].id, id('yes')); assert.equal(plan[1].id, id('no'));
  assert.equal(plan[2], null); assert.equal(plan[3], null);
  const yes = vocabulary.concepts.find(concept => concept.word === 'yes');
  assert.equal(plan[4].id, yes.altId, 'a reply "Yes" yields the corner tile its picture and shows the alternate');
  assert.equal(plan[5].id, id('music'));
  assert.equal(plan[6].id, id('chat'), 'a second music reply falls back to the bubble picture');
  assert.equal(plan[7], null, 'a third has no picture rather than a repeat');
  assert.deepEqual(plan.slice(8).map(item => item.word), ['more', 'wow', 'news', 'help']);
  const shown = plan.filter(Boolean).map(item => item.id);
  assert.equal(new Set(shown).size, shown.length);
  assert.equal(symbols.planPictures(entries, { variant: 'bw' })[5].src, `/symbol/${id('music')}?color=false`);
  assert.equal(symbols.planPictures(entries)[5].src, `/symbol/${id('music')}`);
  const emoji = symbols.planPictures([{ label: 'Home', type: 'response', symbol: 'home', symbolId: id('home') }, { label: 'Pizza', type: 'response', symbol: 'pizza', symbolId: id('pizza') }], { variant: 'emoji' });
  assert.equal(emoji[0].src, '/drawing/stickers/house.png'); assert.equal(emoji[0].kind, 'emoji');
  assert.equal(emoji[1].src, null); assert.equal(emoji[1].kind, 'drawn', 'no emoji for the concept: the drawn picture');
  const drawnPage = symbols.planPictures(['pizza', 'pasta', 'apple'].map(word => ({ label: word, type: 'response', symbol: word, symbolId: id(word) })), { variant: 'emoji' });
  assert.deepEqual(drawnPage.map(item => item && item.drawn), ['chat', null, null], 'the emoji style never repeats a drawn picture either');
  for (const item of symbols.planPictures(entries).filter(Boolean)) assert.match(item.src, /^\/symbol\/\d+(\?color=false)?$/, 'never another host');
});

test('a replacement keeps each unchanged reply\'s picture; only new labels get pictures planned (review fix)', () => {
  assert.equal(symbols.setVocabulary(vocabulary), true);
  const reply = (label, word) => ({ label, type: 'response', symbol: word, symbolId: id(word) });
  const fixedTiles = [{ label: 'yes', type: 'yes' }, { label: 'no', type: 'no' }, { label: '', type: 'rest' }, { label: '', type: 'rest' }];
  const first = symbols.planPictures([...fixedTiles, reply('Music', 'music'), reply('Songs', 'music'), reply('More songs', 'music'), { label: '', type: 'waiting' }]);
  assert.deepEqual(first.slice(4, 7).map(item => item && item.id), [id('music'), id('chat'), null]);
  // Music is removed (its cell stays empty); Songs and More songs stay; Dance is new.
  const next = [...fixedTiles, { label: '', type: 'waiting' }, reply('Songs', 'music'), reply('More songs', 'music'), reply('Dance', 'music')];
  const keep = [undefined, undefined, undefined, undefined, undefined, first[5], first[6], undefined];
  const plan = symbols.planPictures(next, { keep });
  assert.equal(plan[5], first[5], 'Songs keeps the bubble picture it had');
  assert.equal(plan[6], null, 'More songs keeps having no picture');
  assert.equal(plan[7].id, id('music'), 'the new label is planned around the kept pictures');
  const shownIds = plan.filter(Boolean).map(item => item.id);
  assert.equal(new Set(shownIds).size, shownIds.length, 'still no repeat on the page');
});

test('fixed phrases and stories without a server pick use the curated table, then exact words, then the drawn guess', () => {
  symbols.setVocabulary(vocabulary);
  const word = options => symbols.planPictures([options])[0]?.word;
  assert.equal(word({ label: 'Hi!', type: 'static' }), 'hello');
  assert.equal(word({ label: "That's not fair!", type: 'static' }), 'angry');
  assert.equal(word({ label: 'Back to Chat', type: 'route' }), 'back');
  assert.equal(word({ label: 'Pizza', type: 'static', say: 'We had pizza.' }), 'pizza');
  assert.equal(word({ label: 'Our trip', type: 'static', say: 'We went to the park and read a book.' }), 'chat');
  assert.equal(word({ label: 'Weekend', type: 'static' }), 'weekend');
  assert.equal(word({ label: 'Hello', type: 'waiting' }), undefined);
});

function png(size) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: size }, () => Buffer.from([0, ...Array(size).fill([30, 120, 60]).flat()])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const PICTURE = png(48);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serve(dataDir, symbolRequests) {
  const store = createChatStore({ dataDir });
  return http.createServer(async (req, res) => {
    try {
      if (store.handle(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/settings') return json({ dwellMs: 1200, pauseGoes: 'home' });
      if (url.pathname === '/chat/api/config') return json({ runtime: { available: false, kind: 'built-in' }, choices: { available: true } });
      const picture = /^\/symbol\/(\d+)$/.exec(url.pathname);
      if (picture) { symbolRequests.push(url.pathname + url.search); res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PICTURE); return; }
      const relative = url.pathname === '/chat/' ? 'chat/index.html' : decodeURIComponent(url.pathname).slice(1);
      if (relative.split(/[\\/]/).some(part => part === '..') || !mime[path.extname(relative)]) { res.writeHead(404).end(); return; }
      const bytes = await fs.readFile(path.join(root, 'public', relative));
      res.writeHead(200, { 'Content-Type': mime[path.extname(relative)] }); res.end(bytes);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
}

// What the page shows, measured after its own fit pass.
const measure = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(
  [...document.querySelectorAll('#grid .tile')].map(tile => {
    const label = tile.querySelector('.label'), picture = tile.querySelector('.chat-symbol'), style = getComputedStyle(tile);
    const box = tile.getBoundingClientRect(), art = picture?.getBoundingClientRect();
    const contentHeight = box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    // Fits = no word cut inside the label's own box, and the label inside the tile's content box.
    const words = label?.getBoundingClientRect(), bottom = box.bottom - parseFloat(style.paddingBottom);
    return { text: label?.textContent || '', type: [...tile.classList].find(name => ['yes', 'no', 'rest', 'response', 'static', 'route', 'waiting'].includes(name)),
      beside: tile.classList.contains('beside'), stacked: tile.classList.contains('stacked'), reduced: tile.dataset.fontReduced || null,
      font: parseFloat(style.fontSize), width: box.width, height: box.height, background: style.backgroundColor,
      // the board's shares are of the tile's content box (board.css percentages inside the padding)
      contentWidth: tile.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), contentHeight,
      picture: picture ? { tag: picture.tagName.toLowerCase(), src: picture.getAttribute('src'), width: art.width, height: art.height } : null,
      symbolId: tile.dataset.symbolId || null, symbol: tile.dataset.symbol || null,
      fits: !label || (label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1
        && words.bottom <= bottom + 1 && words.top >= box.top + parseFloat(style.paddingTop) - 1
        && (!picture || tile.classList.contains('stacked') || words.left >= art.right - 1)
        && (!picture || !tile.classList.contains('stacked') || words.top >= art.bottom - 1)) };
  }))))));

test('the Chat page lays pictures out by board law and keeps every page free of repeats', { timeout: 90000 }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-layout-'));
  const symbolRequests = [];
  const server = serve(scratch, symbolRequests); server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(scratch, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, hasTouch: true });
  let foreign = 0;
  await context.route(url => url.origin !== base, route => { foreign++; return route.abort('blockedbyclient'); });
  const replies = withSymbols([
    { id: 'choice-1', label: 'Yes', say: 'Yes.', symbol: 'yes' },
    // the model's pick, which the page could not guess from these words
    { id: 'choice-2', label: 'That one', say: 'I choose that one.', symbol: 'pizza' },
    { id: 'choice-3', label: 'Let me tell you another way', say: 'Let me tell you another way.', symbol: 'different' },
    { id: 'choice-4', label: 'Tell me more', say: 'Tell me more.', symbol: 'more' }]);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/chat/api/choices', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'generated', choices: replies, timings: { totalMs: 3 } }) }));
  await page.goto(base + '/chat/');
  await page.waitForFunction(() => document.body.dataset.storageReady === 'true'
    && [...document.querySelectorAll('#grid img.chat-symbol')].length >= 10
    && [...document.querySelectorAll('#grid img.chat-symbol')].every(img => img.complete && img.naturalWidth > 0));

  function law(tiles, viewport) {
    const tag = tile => `${viewport}: "${tile.text}"`;
    const rest = tiles.filter(tile => tile.type === 'rest');
    assert.equal(rest.length, 2);
    for (const tile of rest) { assert.equal(tile.background, 'rgb(0, 0, 0)'); assert.equal(tile.picture, null); }
    assert.equal(tiles.find(tile => tile.type === 'yes').symbol, 'yes'); assert.equal(tiles.find(tile => tile.type === 'no').symbol, 'no');
    const shown = tiles.filter(tile => tile.picture).map(tile => tile.symbolId);
    assert.equal(new Set(shown).size, shown.length, `${viewport}: no two tiles share a picture (${shown})`);
    for (const tile of tiles.filter(tile => tile.picture)) {
      assert.match(tile.picture.src || '', /^\/symbol\/\d+$/, tag(tile));
      assert.ok(tile.font >= 44 - 0.5, `${tag(tile)} ${tile.font}px is under the 44 px floor`);
      assert.ok(tile.fits, `${tag(tile)} does not fit at ${tile.font}px`);
      if (tile.font < 74 - 0.5) assert.equal(tile.reduced, '1', `${tag(tile)} below 74 px must be marked`);
      else assert.equal(tile.reduced, null, tag(tile));
      assert.ok(tile.beside !== tile.stacked, tag(tile));
      if (tile.beside) {
        assert.ok(tile.text.length <= 16 && tile.width >= 190, tag(tile));
        assert.ok(tile.font >= 74 - 0.5, `${tag(tile)}: a beside label never shrinks under 74 px — it goes stacked first`);
        const share = tile.picture.width / tile.contentWidth;
        assert.ok(Math.abs(share - 0.42) < 0.01 || Math.abs(share - 0.30) < 0.01, `${tag(tile)} picture is ${share.toFixed(3)} of the width`);
        assert.ok(Math.abs(tile.picture.height / tile.contentHeight - 0.82) < 0.01, `${tag(tile)} picture is ${(tile.picture.height / tile.contentHeight).toFixed(3)} of the height`);
      }
    }
    for (const tile of tiles.filter(tile => tile.picture && tile.text.length > 16)) assert.ok(tile.stacked, `${tag(tile)}: a long label stacks`);
  }

  for (const viewport of [{ width: 1600, height: 1000 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(80);
    const tiles = await measure(page);
    law(tiles, `${viewport.width} fixed`);
    if (viewport.width === 1600) assert.ok(tiles.some(tile => tile.beside && tile.font >= 74), 'the roomy board shows words beside their pictures');
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.locator('#partnerOpen').click();
  await page.locator('#testing > summary').click();
  await page.locator('#typedQuestion').fill('What would you like?');
  await page.locator('#typedAsk').click();
  await page.waitForFunction(() => document.querySelector('#notice')?.textContent.includes('Replies ready'));
  const rest = await page.locator('.tile.rest').first().boundingBox();
  await page.mouse.move(0, 0); await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2);
  await page.locator('.response').first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('#grid img.chat-symbol')].every(img => img.complete && img.naturalWidth > 0));
  for (const viewport of [{ width: 1600, height: 1000 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(80);
    const tiles = await measure(page);
    law(tiles, `${viewport.width} replies`);
    const responses = Object.fromEntries(tiles.filter(tile => tile.type === 'response').map(tile => [tile.text, tile]));
    assert.equal(Number(responses.Yes.symbolId), vocabulary.concepts.find(concept => concept.word === 'yes').altId, 'the reply "Yes" shows the alternate yes picture');
    assert.equal(Number(responses['That one'].symbolId), id('pizza'), 'the hub pick reaches the tile');
    assert.ok(responses['Let me tell you another way'].stacked);
    assert.equal(responses['Tell me more'].symbolId === String(id('more')), false, 'the bottom row keeps "more"; the reply yields');
    if (viewport.width === 1600) assert.ok(responses['That one'].beside);
    if (viewport.width === 1280) assert.ok(tiles.some(tile => tile.reduced === '1'), 'the small board marks the labels it had to shrink');
  }
  assert.equal(foreign, 0, 'no picture or anything else is requested from another host');
  assert.ok(symbolRequests.length > 0 && symbolRequests.every(url => /^\/symbol\/\d+$/.test(url)));
  assert.deepEqual(errors, []);
});

test('a picture that cannot load falls back to the emoji backup, then the drawn picture, without moving the tile', { timeout: 60000 }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-layout-'));
  const server = serve(scratch, []); server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(scratch, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.route('**/symbol/**', route => route.fulfill({ status: 404, body: 'not found' }));
  await page.goto(base + '/chat/');
  await page.waitForFunction(() => document.body.dataset.storageReady === 'true' && [...document.querySelectorAll('#grid button.tile')].length >= 10
    && [...document.querySelectorAll('#grid button.tile')].every(tile => tile.dataset.picture === 'drawn' || tile.dataset.picture === 'emoji'));
  const kinds = await page.locator('#grid button.tile').evaluateAll(nodes => nodes.map(node => [node.textContent.trim(), node.dataset.picture, node.querySelectorAll('.chat-symbol').length]));
  for (const [label, kind, count] of kinds) { assert.equal(count, 1, label); assert.ok(['drawn', 'emoji'].includes(kind), label); }
});

test('a stacked label tries every height share at the 74 px target before shrinking (board fitFont order)', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('**/*', route => route.abort());
  const css = (await fs.readFile(new URL('../public/chat/chat.css', import.meta.url), 'utf8')).replace(/^@import[^;]+;/m, '');
  const fit = await fs.readFile(new URL('../public/chat/tile-fit.js', import.meta.url), 'utf8');
  await page.setContent(`<style>${css}</style><main id="app"><div id="grid"></div></main>`);
  const result = await page.evaluate(async moduleURL => {
    const { fitTile } = await import(moduleURL);
    const tile = document.createElement('button'); tile.className = 'tile response has-symbol';
    tile.style.cssText = 'position:absolute;left:0;top:0;width:480px;height:300px;grid-column:auto';
    const picture = document.createElement('div'); picture.className = 'chat-symbol';
    const label = document.createElement('span'); label.className = 'label'; label.textContent = 'Something different';
    tile.append(picture, label); document.querySelector('#grid').append(tile);
    const out = fitTile(tile);
    return { ...out, reduced: tile.dataset.fontReduced || null, lines: Math.round(label.getBoundingClientRect().height / (parseFloat(getComputedStyle(tile).fontSize) * 1.08)) };
  }, `data:text/javascript;base64,${Buffer.from(fit).toString('base64')}`);
  assert.equal(result.layout, 'stacked');
  assert.ok(result.size >= 74, `two lines at 74 px fit in 80% of the height, got ${result.size}px`);
  assert.equal(result.reduced, null);
});

test('the stacked-big preview profile keeps a real picture on a stacked tile; the default stays board law', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('**/*', route => route.abort());
  const css = (await fs.readFile(new URL('../public/chat/chat.css', import.meta.url), 'utf8')).replace(/^@import[^;]+;/m, '');
  const fit = await fs.readFile(new URL('../public/chat/tile-fit.js', import.meta.url), 'utf8');
  await page.setContent(`<style>${css}</style><main id="app"><div id="grid"></div></main>`);
  const run = profile => page.evaluate(async ({ moduleURL, profile }) => {
    const { fitTile } = await import(moduleURL);
    const grid = document.querySelector('#grid'); grid.replaceChildren();
    const tile = document.createElement('button'); tile.className = 'tile static has-symbol';
    tile.style.cssText = 'position:absolute;left:0;top:0;width:296px;height:219px';
    const picture = document.createElement('div'); picture.className = 'chat-symbol';
    const label = document.createElement('span'); label.className = 'label'; label.textContent = 'Tell me more';
    tile.append(picture, label); grid.append(tile);
    const out = fitTile(tile, profile ? { profile } : undefined);
    const style = getComputedStyle(tile), content = tile.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return { ...out, share: picture.getBoundingClientRect().height / content, reduced: tile.dataset.fontReduced || null,
      fits: label.scrollWidth <= label.clientWidth + 1 && label.getBoundingClientRect().bottom <= tile.getBoundingClientRect().bottom };
  }, { moduleURL: `data:text/javascript;base64,${Buffer.from(fit).toString('base64')}`, profile });
  const law = await run(), big = await run('stacked-big');
  assert.equal(law.layout, 'stacked'); assert.ok(law.share < 0.3, 'board law keeps the label first: ' + JSON.stringify(law));
  assert.equal(big.layout, 'stacked'); assert.ok(big.share >= 0.27, `picture ${big.share.toFixed(2)} of the height`);
  assert.ok(big.size >= 44 && big.fits, JSON.stringify(big));
  assert.equal(big.reduced, big.size < 74 ? '1' : null);
});
