// Chat test mode in the real page (spec 2026-10-27 §5): the partner turns it on
// by touch, a banner says so, one held turn posts a complete record (timeline,
// words, usage, health, audio) through the real hub module, and the production
// timing rows stay content-free. Owned loopback fixtures only: recognition,
// choices and voice are simulated; no hub, credentials or paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { makeChatToneWav, assertContentFreeMetrics } from '../tests-vm/lib/chat-ui-smoke.mjs';

const require = createRequire(import.meta.url);
const { createChatStore } = require('../chat-store.js');
const { createChatTurns, testModeOn, applyTestModeSetting, applyLikesSetting, chatLikes, DEFAULT_LIKES, validateTurn } = require('../chat-turns.js');
const { initPool } = require('../pool.js');
const root = fileURLToPath(new URL('../', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const QUESTION = 'Would you like music or a story?';
const generated = { kind: 'generated', generated: true, timings: { totalMs: 7 },
  // The hub attaches its picture pick to every choice (spec §6).
  choices: [{ id: 'one', label: 'Music', say: 'Music please', symbol: 'music', symbolId: 24795 }, { id: 'two', label: 'A story', say: 'A story please', symbol: 'book', symbolId: 2450 }],
  usage: { model: 'reply-model-x', inputTokens: 700, cachedTokens: 0, outputTokens: 40 } };

function serve(dataDir) {
  const store = createChatStore({ dataDir });
  const pool = initPool(dataDir, 'fixture-device');
  const turns = createChatTurns({ dataDir, pool, deviceId: 'fixture-device', build: () => 'fixture-build', env: () => ({}), gaze: () => 'running' });
  const settingsFile = path.join(dataDir, 'app-settings.json');
  const server = http.createServer(async (req, res) => {
    try {
      if (store.handle(req, res) || turns.handle(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Chat fixture</title>'); return; }
      if (url.pathname === '/settings' && req.method === 'POST') {
        let text = ''; for await (const chunk of req) text += chunk;
        let saved = {}; try { saved = JSON.parse(await fs.readFile(settingsFile, 'utf8')); } catch {}
        const incoming = JSON.parse(text);
        await fs.writeFile(settingsFile, JSON.stringify(applyLikesSetting(applyTestModeSetting(saved, incoming), incoming)));
        res.writeHead(204).end(); return;
      }
      if (url.pathname === '/settings') return json({ dwellMs: 1200, pauseGoes: 'home', chatTestMode: testModeOn(dataDir), chatLikes: chatLikes(dataDir) });
      const relative = url.pathname === '/chat/' ? 'chat/index.html' : decodeURIComponent(url.pathname).slice(1);
      if (relative.split(/[\\/]/).some(part => part === '..') || !mime[path.extname(relative)]) { res.writeHead(404).end(); return; }
      const bytes = await fs.readFile(path.join(root, 'public', relative));
      res.writeHead(200, { 'Content-Type': mime[path.extname(relative)] }); res.end(bytes);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  server.once('close', () => turns.close());
  return { server, pool };
}

test('test mode: touch switch, banner, one held turn recorded in full, production rows content-free, panel and delete', { timeout: 90000 }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-test-mode-'));
  const wav = path.join(scratch, 'microphone.wav'); await fs.writeFile(wav, makeChatToneWav());
  const { server, pool } = serve(scratch); server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(scratch, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, hasTouch: true, permissions: ['microphone'] });
  let foreign = 0;
  await context.route(url => url.origin !== base, route => { foreign++; return route.abort('blockedbyclient'); });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  const controls = []; let generation = 0, uploads = 0;
  await page.addInitScript(() => { window.EventSource = class { constructor() { window.__events = this; } close() { this.closed = true; } }; });
  await page.route('**/voices', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, current: 'synthetic-saved' }) }));
  await page.route('**/tts', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: makeChatToneWav() }));
  await page.route('**/chat/api/**', async route => {
    const req = route.request(), url = new URL(req.url()); let result;
    if (/^\/chat\/api\/(?:state|turns|health)(?:\/|$)/.test(url.pathname)) return route.continue();
    if (url.pathname.endsWith('/config')) result = { runtime: { available: true, kind: 'built-in' }, choices: { available: true } };
    else if (url.pathname.endsWith('/sessions') && req.method() === 'POST') { generation = 0; result = { id: 'a1b2c3d4-0000-4000-8000-000000000001' }; }
    else if (url.pathname.endsWith('/control')) { const body = req.postDataJSON(); controls.push(body.type); if (body.type !== 'finish') generation++; result = { generation }; }
    else if (url.pathname.endsWith('/audio')) { uploads++; result = { seq: uploads }; }
    else if (url.pathname.endsWith('/choices')) result = generated;
    else result = { ready: true, mode: 'paused' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) }).catch(() => {});
  });
  await page.goto(base + '/chat/');
  await page.waitForFunction(() => document.body.dataset.storageReady === 'true' && document.querySelector('#engineNote').textContent.includes('set up'));
  const cdp = await context.newCDPSession(page);
  const touch = async selector => {
    await page.locator(selector).scrollIntoViewIfNeeded();
    const box = await page.locator(selector).boundingBox(); assert.ok(box, selector);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
  };
  const lift = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  const paths = []; page.on('request', request => paths.push(new URL(request.url()).pathname));
  const finishes = () => controls.filter(type => type === 'finish').length;
  async function heldTurn() {
    // No Start Chat: the page opened its session by itself; the simulated recognizer says ready.
    if (await page.locator('#ask').isDisabled()) {
      await page.waitForFunction(() => window.__events && !window.__events.closed);
      await page.evaluate(() => window.__events.onmessage({ data: JSON.stringify({ type: 'ready', capabilities: { remoteFinal: true } }) }));
      await page.waitForFunction(() => document.querySelector('#phase').textContent === 'Ready to ask' && !document.querySelector('#ask').disabled);
    }
    const asks = controls.filter(type => type === 'ask').length, before = finishes();
    await touch('#ask');
    for (let i = 0; i < 100 && controls.filter(type => type === 'ask').length === asks; i++) await page.waitForTimeout(20);
    await page.waitForTimeout(250); // past the 400 ms floor: a shorter hold is a slip, never a question
    await page.evaluate(g => window.__events.onmessage({ data: JSON.stringify({ type: 'partial', generation: g, text: 'would you like' }) }), generation);
    await page.waitForTimeout(250); await lift();
    for (let i = 0; i < 100 && finishes() === before; i++) await page.waitForTimeout(20);
    assert.equal(finishes(), before + 1);
    await page.evaluate(([g, text]) => window.__events.onmessage({ data: JSON.stringify({ type: 'final', generation: g, text,
      timings: { activityMs: 3, cloudMs: 30, finalDecodeMs: 33, audioMs: 240, captureWallMs: 260, turnMs: 41 } }) }), [generation, QUESTION]);
    // Shown at once, wherever the gaze is (spec §4): no move into the centre.
    await page.waitForSelector('.response'); await page.locator('.response').first().click();
  }
  const completedHolds = async () => {
    const state = await fs.readFile(path.join(scratch, 'chat-state.json'), 'utf8').then(JSON.parse, () => null);
    return (state?.value.timings || []).filter(row => row.kind === 'hold' && row.status === 'completed').length;
  };

  // OFF: a whole held turn records nothing and never asks for health.
  assert.equal(await page.locator('#testModeBanner').isVisible(), false);
  await heldTurn();
  for (let i = 0; i < 200 && await completedHolds() < 1; i++) await page.waitForTimeout(50);
  assert.equal(await completedHolds(), 1, 'the turn completed');
  await page.waitForTimeout(300);
  assert.deepEqual(paths.filter(p => /^\/chat\/api\/(?:turns|health)/.test(p)), [], 'off: no test-mode request at all');
  assert.equal(await fs.stat(path.join(scratch, 'logs', 'chat-turns')).then(() => true, () => false), false, 'off: no chat-turns folder');

  // Off by default: no panel, the switch reads "Turn on".
  await page.locator('#partnerOpen').click();
  assert.equal(await page.locator('#testModePanel').isVisible(), false);
  assert.match(await page.locator('#testModeToggle').textContent(), /Turn on test mode/);
  // A mouse click (the gaze engine's injection path) does not move the switch.
  await page.locator('#testModeToggle').click(); await page.waitForTimeout(200);
  assert.equal(testModeOn(scratch), false, 'only a partner touch turns test mode on');
  await touch('#testModeToggle'); await lift();
  await page.waitForFunction(() => !document.querySelector('#testModeBanner').hidden);
  assert.equal(testModeOn(scratch), true);
  assert.equal(await page.locator('#testModeBanner').textContent(), 'Test mode: this computer is recording Chat turns');
  assert.match(await page.locator('#testModeToggle').textContent(), /Turn off test mode/);
  await page.locator('#partnerDialog .close').click();
  const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await settled();
  const tilesBefore = await page.locator('#grid .tile').evaluateAll(tiles => tiles.map(tile => tile.getBoundingClientRect()).map(r => [r.x, r.y, r.width, r.height]));

  // ON: one held turn.
  await heldTurn();

  const now = new Date(), pad2 = n => String(n).padStart(2, '0');
  const dayFile = path.join(scratch, 'logs', 'chat-turns', `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}.jsonl`);
  let record;
  for (let i = 0; i < 300 && !record; i++) {
    const lines = await fs.readFile(dayFile, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), () => []);
    record = lines.find(line => line.kind === 'hold' && line.outcome === 'completed');
    if (!record) await page.waitForTimeout(50);
  }
  assert.ok(record, 'the completed held turn was recorded');
  const names = record.stages.map(stage => stage.name);
  for (const name of ['begin', 'firstPartial', 'partial', 'release', 'drained', 'finishSent', 'finishAck', 'transcript', 'choicesReady',
    'firstChoiceStaged', 'choiceStaged', 'batchSealed', 'revealed', 'selected', 'playbackStart', 'firstAudio', 'playbackEnd'])
    assert.ok(names.includes(name), 'stage ' + name + ' in ' + names.join(','));
  const at = name => record.stages.find(stage => stage.name === name).ms;
  for (const [a, b] of [['release', 'transcript'], ['transcript', 'choicesReady'], ['choicesReady', 'batchSealed'], ['batchSealed', 'revealed'], ['revealed', 'selected'], ['selected', 'playbackStart'], ['playbackStart', 'playbackEnd']])
    assert.ok(at(a) <= at(b), `${a} before ${b}`);
  // No gaze wait: the reveal follows the sealed batch within the 250 ms settle.
  for (const sealedMark of ['choicesReady', 'batchSealed'])
    assert.ok(at('revealed') - at(sealedMark) <= 300, `revealed ${at('revealed') - at(sealedMark)} ms after ${sealedMark}`);
  assert.equal(record.stages.find(stage => stage.name === 'partial').text, 'would you like');
  assert.deepEqual(record.stages.filter(stage => stage.name === 'choiceStaged').map(stage => stage.text), ['Music', 'A story']);
  assert.equal(record.mode, 'one-shot'); assert.equal(record.session, 'a1b2c3d4-0000-4000-8000-000000000001');
  assert.equal(record.content.transcript, QUESTION); assert.deepEqual(record.content.partials, ['would you like']);
  assert.deepEqual(record.content.choices.map(choice => [choice.label, choice.say]), [['Music', 'Music please'], ['A story', 'A story please']]);
  assert.ok(record.content.choices.every(choice => typeof choice.symbol === 'string'), 'staged choices carry their picture id');
  assert.deepEqual(record.content.choices.map(choice => [choice.symbol, choice.symbolId]), [['music', 24795], ['book', 2450]], 'with the hub pictogram ids');
  assert.equal(record.content.selected.say, 'Music please'); assert.equal(record.content.spoken, 'Music please'); assert.equal(record.content.choiceKind, 'generated');
  assert.equal(record.worker.captureWallMs, 260); assert.equal(record.worker.turnMs, 41);
  assert.deepEqual(record.usage.reply, generated.usage); assert.equal(record.usage.audioSeconds, 0.24);
  assert.ok(['hit', 'pending', 'miss'].includes(record.usage.voice.cache)); assert.equal(record.usage.voice.chars, 12);
  for (const at of ['release', 'reveal']) { assert.equal(record.health[at].gaze, 'running'); assert.ok(record.health[at].freeMemBytes > 0); }
  assert.ok(record.mic.frames > 0); assert.ok(record.mic.peakRms > 0);
  assert.equal(record.build, 'fixture-build'); assert.equal(record.device, 'fixture-device');
  const { receivedAt, day, build, device, models, cost, ...posted } = record;
  assert.deepEqual(validateTurn(posted), posted);
  const pooled = pool.readMerged({ kind: 'chat-turn' });
  assert.ok(pooled.some(line => line.turn.id === record.id));
  assert.ok(paths.includes('/chat/api/health/warm'), 'round trips were warmed at touch-down');
  let audio;
  for (let i = 0; i < 100 && !audio; i++) { audio = await fs.readFile(path.join(scratch, 'logs', 'chat-turns', 'audio', record.id + '.wav')).catch(() => null); if (!audio) await page.waitForTimeout(50); }
  assert.ok(audio && audio.length > 44, 'the released hold kept its audio');

  // Production rows: content-free, and the same fields they always had.
  const state = JSON.parse(await fs.readFile(path.join(scratch, 'chat-state.json'), 'utf8'));
  assertContentFreeMetrics({ version: 1, retention: 40, turns: state.value.timings });
  assert.doesNotMatch(JSON.stringify(state), /music|story|would you|reply-model|running/i);

  // The recording changed nothing on the board.
  await page.locator('#partnerOpen').click();
  await page.waitForFunction(() => !document.querySelector('#testModePanel').hidden);
  await page.locator('#turnTimings summary').click();
  await page.waitForFunction(q => document.querySelector('#recentTurns').textContent.includes(q), QUESTION);
  await page.waitForFunction(() => document.querySelector('#buildSummary').textContent.includes('fixture-build'));
  await page.locator('#partnerDialog .close').click();
  await settled();
  const tilesAfter = await page.locator('#grid .tile').evaluateAll(tiles => tiles.map(tile => tile.getBoundingClientRect()).map(r => [r.x, r.y, r.width, r.height]));
  assert.deepEqual(tilesAfter, tilesBefore, 'the banner and the panel never move a tile');

  // Delete control: two touches; then off keeps writing nothing new.
  await page.locator('#partnerOpen').click();
  await touch('#deleteRecordings'); await lift();
  assert.match(await page.locator('#deleteRecordings').textContent(), /again/i);
  assert.ok(await fs.stat(dayFile).then(() => true, () => false), 'one touch deletes nothing');
  await touch('#deleteRecordings'); await lift();
  await page.waitForFunction(() => /Deleted/.test(document.querySelector('#testModeNote').textContent));
  assert.equal(await fs.stat(dayFile).then(() => true, () => false), false);
  assert.deepEqual(pool.readMerged({ kind: 'chat-turn' }), [], 'this device\'s pool copies are stripped too');
  assert.equal(await fs.stat(path.join(scratch, 'logs', 'chat-turns', 'audio')).then(() => true, () => false), false);
  await touch('#testModeToggle'); await lift();
  await page.waitForFunction(() => document.querySelector('#testModeBanner').hidden);
  assert.equal(testModeOn(scratch), false);
  assert.equal(await page.locator('#testModePanel').isVisible(), false);

  // What she likes (dad, 10/28): one per line, loaded from the settings, saved as a list when the box is left.
  const likes = page.locator('#chatLikes');
  assert.equal(await likes.getAttribute('maxlength'), '400');
  assert.equal(await likes.inputValue(), DEFAULT_LIKES.join('\n'), 'the generic default until a partner saves a list');
  const saves = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/settings' && request.method() === 'POST') saves.push(request.postDataJSON()); });
  await likes.fill('  swim \n\ndance\nbake cookies\n');
  await likes.blur();
  for (let i = 0; i < 100 && !saves.length; i++) await page.waitForTimeout(20);
  assert.deepEqual(saves, [{ chatLikes: ['swim', 'dance', 'bake cookies'] }], 'trimmed, empty lines dropped');
  for (let i = 0; i < 100 && chatLikes(scratch)[0] !== 'swim'; i++) await page.waitForTimeout(20);
  assert.deepEqual(chatLikes(scratch), ['swim', 'dance', 'bake cookies']);
  await page.waitForFunction(() => /Saved/.test(document.querySelector('#chatLikesNote').textContent));
  assert.deepEqual(errors, []); assert.equal(foreign, 0);
});
