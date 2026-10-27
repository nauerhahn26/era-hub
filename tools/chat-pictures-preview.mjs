#!/usr/bin/env node
// Chat pictures preview for dad (spec 2026-10-27 §6): the fixed phrases and 30
// sample replies on Chat boards at board size, in three styles side by side —
// the library in colour, the library in black and white, and the emoji backup.
// A scratch hub (this checkout's server.js, its own data dir, never 8377) serves
// the page modules and the /symbol/<id> cache; screenshots go outside the repo.
//   node tools/chat-preview.mjs --pictures [--out DIR] [--data DIR]
//   ERA_TEST_PORT 8480-8499 (default 8493), checked free first.
// tools/chat-vocabulary-sheet.mjs reuses startScratchHub for the contact sheet.
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export function scratchPort(env = process.env) {
  const port = Number(env.ERA_TEST_PORT || 8493);
  if (!Number.isInteger(port) || port < 8480 || port > 8499) throw Error('Use ERA_TEST_PORT between 8480 and 8499 for a scratch hub.');
  return port;
}
function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}
// Starts this checkout's hub on a free scratch port; stop() ends only that pid.
export async function startScratchHub({ port = scratchPort(), data, enableChat = false } = {}) {
  if (await listening(port)) throw Error(`Port ${port} is in use; choose another ERA_TEST_PORT (8480-8499).`);
  fs.mkdirSync(data, { recursive: true });
  if (enableChat) fs.writeFileSync(path.join(data, 'apps.json'), JSON.stringify({ enabled: ['chat'] }));
  const child = spawn(process.execPath, ['server.js', String(port)], { cwd: HUB, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, ERA_DATA_DIR: data, ERA_BIND: '127.0.0.1', ERA_CHAT_CONFIG_DISABLED: '1', ERA_UPDATE_URL: 'http://127.0.0.1:1' } });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw Error('The scratch hub exited.');
    try { if ((await fetch(base + '/settings')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { base, pid: child.pid, async stop() {
    if (child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await exited;
  } };
}

// The phrases Chat shows without a reply model: its fixed pages and routes, the
// hub's shortcuts and its guarded templates.
export const FIXED_PHRASES = [
  'yes', 'no', 'Hi!', "What's up?", 'How are you?', 'Come sit with me.', 'Tell me more', 'Reactions', 'My news', 'Help me say it',
  'Back to Chat', "That's funny!", 'I love that!', 'No way!', "That's not fair!", 'Give me more time.', "That's not what I meant.",
  'Ask me yes or no.', 'Let me try again.', "I'm not sure", 'Please say that again', "I don't want to answer", 'Hello!',
  "It's good to see you", "I'm good", "I'm tired", 'Can you give me a clue?', 'Let me tell you another way.',
  "I don't want to answer now.", 'Can I help you?', 'I need a moment.', 'My earlier words', 'Not now', 'No thanks', 'Something else',
  'No worries', 'No problem', 'Not bad', "I don't know", 'No idea', 'Try again', 'Can you say that again?', 'Give me a clue',
  'Another way', 'A moment', 'Offer help',
];
// Thirty replies of the kind the reply model offers (label, say), pictured by the
// hub's own pick as a reply without a model symbol would be.
export const SAMPLE_REPLIES = [
  ['Pizza', 'I would like pizza.'], ['Pasta', 'Pasta please.'], ['Not hungry', "I'm not hungry."], ['Apple', 'An apple, please.'],
  ['Read a book', "Let's read a book."], ['Music', 'Can we play music?'], ['Watch a video', 'I want to watch a video.'], ['Go outside', "Let's go outside."],
  ['Swimming', 'I want to go swimming.'], ['The park', 'Can we go to the park?'], ['Draw', 'I want to draw.'], ['Play a game', "Let's play a game."],
  ['Happy', 'I feel happy.'], ['Tired', "I'm a bit tired."], ['Scared', 'That was scary.'], ['Not sad', "I'm not sad."],
  ['My dog', 'I love my dog.'], ['Grandma', 'I want to see Grandma.'], ['My brother', 'My brother is funny.'], ['School', 'School was fun.'],
  ['Sunny', "It's sunny today."], ['Rain', 'It is raining.'], ['Friday', 'On Friday.'], ['Weekend', 'At the weekend.'],
  ['Horse riding', 'I love horse riding.'], ['Dancing', "Let's dance."], ['No thanks', 'No, thank you.'], ['Ice cream', 'Ice cream please!'],
  ['Hug', 'Can I have a hug?'], ['Something different', 'I want to do something different.'],
];

// Board pages: four words each in the four reply cells, the corners and rest
// cells and the bottom row exactly as the Chat page draws them.
export function previewScenes() {
  const { withSymbols } = require('../chat-symbols.js');
  const scenes = [];
  for (let i = 0; i < FIXED_PHRASES.length; i += 4)
    scenes.push({ name: `fixed-${String(i / 4 + 1).padStart(2, '0')}`, type: 'static', words: FIXED_PHRASES.slice(i, i + 4).map(text => ({ label: text, say: text })) });
  const replies = withSymbols(SAMPLE_REPLIES.map(([label, say]) => ({ label, say })));
  for (let i = 0; i < replies.length; i += 4)
    scenes.push({ name: `replies-${String(i / 4 + 1).padStart(2, '0')}`, type: 'response', words: replies.slice(i, i + 4) });
  return scenes;
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Chat pictures preview</title>
<link rel="stylesheet" href="/chat/chat.css"><style>
body{overflow:auto;background:#222;margin:0;padding:16px;font-family:Arial,sans-serif}
.row{display:flex;gap:24px;align-items:flex-start}.board{position:relative;width:1280px;height:822px;background:#000;flex:none}
.board h2{margin:0;height:22px;font-size:16px;color:#ddd;font-weight:700}
.grid{position:absolute;inset:34px 28px 12px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr));gap:14px}
</style></head><body><div class="row" id="row"></div></body></html>`;

async function renderScene(page, scene) {
  await page.evaluate(async scene => {
    const { setVocabulary, planPictures, attachPicture } = await import('/chat/symbols.js');
    const { fitTile } = await import('/chat/tile-fit.js');
    setVocabulary(await (await fetch('/chat/vocabulary.json')).json());
    const row = document.getElementById('row'); row.replaceChildren();
    const styles = [['color', 'Library, colour'], ['bw', 'Library, black and white'], ['emoji', 'Emoji backup (then drawn)']];
    for (const [variant, title] of styles) {
      const board = document.createElement('section'); board.className = 'board';
      const heading = document.createElement('h2'); heading.textContent = `${title} · ${scene.name}`; board.append(heading);
      const grid = document.createElement('div'); grid.className = 'grid'; board.append(grid); row.append(board);
      const cells = [['yes', 'yes', [0, 0]], ['no', 'no', [3, 0]], ['', 'rest', [1, 1]], ['', 'rest', [2, 1]],
        ...scene.words.map((word, i) => [word.label, scene.type, [[1, 0], [2, 0], [0, 1], [3, 1]][i], word]),
        ...['Tell me more', 'Reactions', 'My news', 'Help me say it'].map((label, i) => [label, i ? 'route' : 'static', [i, 2]])];
      const tiles = cells.map(([label, type, [column, line], word = {}]) => {
        const tile = document.createElement(type === 'rest' ? 'div' : 'button'); tile.className = `tile ${type}`;
        tile.style.gridColumn = column + 1; tile.style.gridRow = line + 1;
        const text = document.createElement('span'); text.className = 'label'; text.textContent = label; tile.append(text);
        grid.append(tile); return [tile, { label, type, say: word.say || label, symbol: word.symbol, symbolId: word.symbolId }];
      });
      const plan = planPictures(tiles.map(([, options]) => options), { variant });
      tiles.forEach(([tile], i) => attachPicture(tile, plan[i], fitTile));
    }
    await Promise.all([...document.images].map(img => img.complete ? null : new Promise(resolve => { img.onload = img.onerror = resolve; })));
    await new Promise(resolve => setTimeout(resolve, 50));
    for (const tile of document.querySelectorAll('.tile:not(.rest)')) fitTile(tile);
  }, scene);
}

export async function runPicturesPreview({ out = path.join(os.homedir(), '.cache', 'era-chat', 'pictures-preview'),
  data = path.join(os.homedir(), '.cache', 'era-chat', 'pictures-hub') } = {}) {
  const { chromium } = await import('playwright');
  fs.mkdirSync(out, { recursive: true });
  const hub = await startScratchHub({ data });
  const browser = await chromium.launch({ headless: true });
  const written = [];
  try {
    const page = await browser.newPage({ viewport: { width: 3920, height: 860 } });
    await page.goto(hub.base + '/chat/vocabulary.json');
    await page.setContent(PAGE, { waitUntil: 'load' });
    for (const scene of previewScenes()) {
      await renderScene(page, scene);
      const file = path.join(out, `${scene.name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      written.push(file);
    }
  } finally { await browser.close(); await hub.stop(); }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
  runPicturesPreview({ ...(value('--out') ? { out: value('--out') } : {}), ...(value('--data') ? { data: value('--data') } : {}) })
    .then(files => { for (const file of files) console.log(file); })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
