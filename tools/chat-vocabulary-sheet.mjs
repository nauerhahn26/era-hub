#!/usr/bin/env node
// Chat vocabulary contact sheet (spec 2026-10-27 §6): every concept word with the
// picture its approved id returns, from a scratch hub's /symbol/<id> cache, so a
// reviewer can correct wrong picks by id in public/chat/vocabulary.json. Prints
// every concept whose id returns no image. The sheet (HTML, plus a PNG) is written
// outside the repository: the library's images never enter it.
//   node tools/chat-vocabulary-sheet.mjs [--out DIR] [--data DIR]
//   ERA_TEST_PORT 8480-8499 (default 8493), checked free first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startScratchHub } from './chat-pictures-preview.mjs';

const escape = text => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export async function buildSheet({ concepts, fetchPicture }) {
  const missing = [], cells = [];
  for (const concept of concepts) {
    const bytes = await fetchPicture(concept.id);
    if (!bytes) missing.push({ word: concept.word, id: concept.id });
    const picture = bytes ? `<img alt="" src="data:image/png;base64,${Buffer.from(bytes).toString('base64')}">` : '<div class="miss">NO IMAGE</div>';
    cells.push(`<figure${concept.tone ? ' class="negative"' : ''}>${picture}<figcaption><b>${escape(concept.word)}</b> ${concept.id}`
      + `${concept.alt?.length ? `<br><small>${escape(concept.alt.join(', '))}</small>` : ''}</figcaption></figure>`);
  }
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Chat vocabulary</title><style>
body{font:14px Arial,sans-serif;margin:12px;background:#fff;color:#17272e}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
figure{margin:0;border:1px solid #c8d2d4;border-radius:8px;padding:6px;text-align:center}figure.negative{border-color:#b23a48}
img,.miss{width:120px;height:120px;object-fit:contain;display:block;margin:0 auto}.miss{background:#f3e2de;line-height:120px;font-weight:700}
small{color:#5b6b70}</style><h1>Chat vocabulary: ${concepts.length} concepts, ${missing.length} without an image</h1>
<p>Red border: refusal, negation or uncertainty (never replaced by an affirmative picture).</p><main>${cells.join('\n')}</main></html>`;
  return { html, missing };
}

export async function runSheet({ out = path.join(os.homedir(), '.cache', 'era-chat', 'vocabulary-sheet'),
  data = path.join(os.homedir(), '.cache', 'era-chat', 'pictures-hub') } = {}) {
  const vocabulary = JSON.parse(fs.readFileSync(new URL('../public/chat/vocabulary.json', import.meta.url), 'utf8'));
  fs.mkdirSync(out, { recursive: true });
  const hub = await startScratchHub({ data });
  try {
    const sheet = await buildSheet({ concepts: vocabulary.concepts, fetchPicture: async id => {
      const response = await fetch(`${hub.base}/symbol/${id}`).catch(() => null);
      return response?.ok ? Buffer.from(await response.arrayBuffer()) : null;
    } });
    const file = path.join(out, 'vocabulary.html');
    fs.writeFileSync(file, sheet.html);
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
      await page.goto('file://' + file);
      await page.screenshot({ path: path.join(out, 'vocabulary.png'), fullPage: true });
    } finally { await browser.close(); }
    return { file, png: path.join(out, 'vocabulary.png'), missing: sheet.missing };
  } finally { await hub.stop(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
  runSheet({ ...(value('--out') ? { out: value('--out') } : {}), ...(value('--data') ? { data: value('--data') } : {}) }).then(result => {
    console.log(result.file); console.log(result.png);
    for (const miss of result.missing) console.log(`no image: ${miss.word} (${miss.id})`);
    console.log(`${result.missing.length} concept(s) without an image`);
    if (result.missing.length) process.exitCode = 2;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
