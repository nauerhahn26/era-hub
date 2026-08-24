// reader-ui.test.mjs — Book Reader v1 e2e (era-book-reader M3, spec Piece 3).
// Spawns the REAL server.js on a scratch port with a throwaway ERA_DATA_DIR and
// the SYNTHETIC "Luna the Fox" fixture package (never real book content), then
// drives /reader/ with Playwright. Proves: shelf renders the fixture cover as a
// dwell target (+ black rest cell), a tap opens the book and narration PLAYS,
// word-sync highlights >=1 word with a monotonically non-decreasing active
// index (manifest words AND the interpolation fallback), next/prev/repeat work
// by synthetic click (touch parity), a textless page shows the advance arrow
// immediately, auto-advance turns the page when narration ends, every page
// change arms the dwell settle window (D51), progress lands in the hub log,
// local resume reopens at the saved page, and speechSynthesis.speak is NEVER
// called (narration is recorded audio — the old harness's no-TTS law).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(__dirname, "..");

// scratch-port map: books=8392/8398, pool=8393/8394, setup=8397, board=8390 —
// never the live hub port.
const PORT = 8391;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-reader-"));
let child, browser;

// Minimal valid 1x1 JPEG (hand-crafted synthetic bytes, no image lib needed).
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64");

// Valid PCM WAV: 44-byte RIFF header + 16-bit mono sine. 8kHz, `secs` long.
function makeWav(secs) {
  const samples = Math.round(8000 * secs);
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples; i++)
    buf.writeInt16LE(Math.round(3000 * Math.sin(i / 10)), 44 + i * 2);
  return buf;
}

before(async () => {
  // fixture package — three page shapes the reader must handle:
  //   p0: words+audio (manifest timings)   p1: audio, NO words (interpolation)
  //   p2: textless + silent (advance arrow immediately); p2 is also the LAST page
  const book = path.join(TMP, "books", "luna-the-fox");
  fs.mkdirSync(path.join(book, "pages"), { recursive: true });
  fs.mkdirSync(path.join(book, "audio"), { recursive: true });
  fs.writeFileSync(path.join(book, "cover.jpg"), JPEG);
  for (const n of ["001", "002", "003"]) fs.writeFileSync(path.join(book, "pages", n + ".jpg"), JPEG);
  fs.writeFileSync(path.join(book, "audio", "001.wav"), makeWav(3));
  fs.writeFileSync(path.join(book, "audio", "002.wav"), makeWav(3));
  fs.writeFileSync(path.join(book, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000002",
    slug: "luna-the-fox",
    title: "Luna the Fox",
    exportedAt: "2026-08-24T00:00:00Z",
    narration: { provider: "synthetic", model: "fixture", voice: "none" },
    cover: "cover.jpg",
    pages: [
      { index: 0, image: "pages/001.jpg", text: "Luna naps now.", audio: "audio/001.wav",
        words: [{ word: "Luna", start: 0.10, end: 0.80 },
                { word: "naps", start: 0.90, end: 1.70 },
                { word: "now.", start: 1.80, end: 2.60 }] },
      { index: 1, image: "pages/002.jpg", text: "The fox sleeps.", audio: "audio/002.wav" },
      { index: 2, image: "pages/003.jpg", text: "", audio: null },
    ],
  }, null, 2));

  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_DEVICE_ID: "test-dev" },
  });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); up = true; break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!up) throw new Error("server never came up");
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
});
after(async () => {
  if (browser) await browser.close();
  if (child) child.kill("SIGKILL");
});

// hasTouch contexts: the required next/prev/repeat interactions are the touch
// path (synthetic click/tap — parity law); the dwell engine itself is proven in
// dwell-engine.test.mjs. speechSynthesis.speak is wrapped to COUNT calls.
async function makePage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  await ctx.addInitScript(() => {
    window.__testHooks = true;                     // reader records highlights to __hlSeq
    window.__speakCalls = 0;
    if (window.speechSynthesis) {
      speechSynthesis.speak = () => { window.__speakCalls++; };
    }
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/reader/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Reader && typeof window.Reader.state === "function");
  return { ctx, page };
}
const state = (page) => page.evaluate(() => window.Reader.state());
const openLuna = async (page) => {
  await page.locator("#shelf .book", { hasText: "Luna the Fox" }).click();
  await page.waitForFunction(() => window.Reader.state().screen === "sRead");
};

test("shelf: fixture cover renders as a dwell target, black rest cell present", async () => {
  const { ctx, page } = await makePage();
  const tile = page.locator("#shelf .book.dwell").first();
  await tile.waitFor();
  assert.equal(await tile.locator(".name").textContent(), "Luna the Fox");
  assert.match(await tile.locator("img.cover").getAttribute("src"),
    /\/books\/luna-the-fox\/cover\.jpg$/);
  assert.equal(await page.locator("#shelf .restCell").count(), 1, "black rest cell in the grid");
  assert.equal(await page.locator("#rest").count(), 1, "fixed black rest area exists");
  assert.equal((await state(page)).shelfCount, 1);
  await ctx.close();
});

test("open book by tap: reading screen, narration audio PLAYS (no speechSynthesis)", async () => {
  const { ctx, page } = await makePage();
  await openLuna(page);
  await page.waitForFunction(() => {
    const s = window.Reader.state();
    return s.audio === "playing" && s.audioTime > 0;
  }, null, { timeout: 8000 });
  const s = await state(page);
  assert.equal(s.slug, "luna-the-fox");
  assert.equal(s.page, 0);
  assert.equal(s.arrow, false, "no arrow while narration is playing");
  assert.equal(await page.evaluate(() => window.__speakCalls), 0, "speechSynthesis never called");
  await ctx.close();
});

test("word sync (manifest words): >=1 highlight, active index never decreases", async () => {
  const { ctx, page } = await makePage();
  await openLuna(page);
  await page.waitForFunction(
    () => (window.__hlSeq || []).filter(e => e.page === 0).length >= 2, null, { timeout: 6000 });
  const seq = await page.evaluate(() => window.__hlSeq.filter(e => e.page === 0).map(e => e.idx));
  assert.ok(seq.length >= 1, "at least one word highlighted");
  for (let i = 1; i < seq.length; i++)
    assert.ok(seq[i] >= seq[i - 1], `active index never decreases (${seq.join(",")})`);
  assert.ok(await page.locator("#pageText .w.hl").count() <= 1, "at most one live highlight");
  await ctx.close();
});

test("auto-advance: narration end turns the page by itself", async () => {
  const { ctx, page } = await makePage();
  await openLuna(page);
  await page.waitForFunction(() => window.Reader.state().page === 1, null, { timeout: 10000 });
  assert.equal((await state(page)).screen, "sRead");
  await ctx.close();
});

test("next/prev/repeat by synthetic click (touch parity)", async () => {
  const { ctx, page } = await makePage();
  await openLuna(page);
  await page.locator("#btnNext").click();
  assert.equal((await state(page)).page, 1, "next turns forward");
  await page.locator("#btnPrev").click();
  assert.equal((await state(page)).page, 0, "prev turns back");
  // let narration run, then repeat: time rewinds and the word cursor resets
  await page.waitForFunction(() => window.Reader.state().audioTime > 0.7, null, { timeout: 6000 });
  const rewound = await page.evaluate(() => {
    document.getElementById("btnRepeat").click();
    return window.Reader.state().audioTime;
  });
  assert.ok(rewound < 0.5, `repeat rewinds narration (t=${rewound})`);
  await page.waitForFunction(() => {
    const s = window.Reader.state();
    return s.audio === "playing" && s.activeIdx >= 0;
  }, null, { timeout: 6000 });
  assert.equal(await page.evaluate(() => window.__speakCalls), 0, "still no speechSynthesis");
  await ctx.close();
});

test("interpolation fallback: audio with NO word timings still highlights, monotonic", async () => {
  const { ctx, page } = await makePage();
  await openLuna(page);
  await page.locator("#btnNext").click();          // -> page 1: audio, no words
  await page.waitForFunction(
    () => (window.__hlSeq || []).filter(e => e.page === 1).length >= 1, null, { timeout: 8000 });
  const s = await state(page);
  assert.equal(s.words, 3, "interpolated one timing per word of 'The fox sleeps.'");
  const seq = await page.evaluate(() => window.__hlSeq.filter(e => e.page === 1).map(e => e.idx));
  for (let i = 1; i < seq.length; i++)
    assert.ok(seq[i] >= seq[i - 1], `interpolated index never decreases (${seq.join(",")})`);
  await ctx.close();
});

test("textless page shows the advance arrow IMMEDIATELY; arrow advances (to The End)", async () => {
  const { ctx, page } = await makePage();
  await openLuna(page);
  await page.locator("#btnNext").click();
  await page.locator("#btnNext").click();          // -> page 2: textless, silent, last
  const s = await state(page);
  assert.equal(s.page, 2);
  assert.equal(s.arrow, true, "advance arrow up immediately, no waiting on audio");
  assert.equal(s.audio, "paused", "no narration on a silent page");
  assert.ok(await page.locator("#advanceArrow.show").isVisible());
  assert.equal(await page.locator("#btnRepeat").evaluate(el => el.style.visibility),
    "hidden", "repeat hidden with nothing to repeat");
  await page.locator("#advanceArrow").click();     // last page: arrow finishes the book
  await page.waitForFunction(() => window.Reader.state().screen === "sEnd");
  assert.equal(await page.evaluate(() => window.__speakCalls), 0, "no speechSynthesis, ever");
  await ctx.close();
});

test("page-change settle: every turn suppresses dwell arming (D51)", async () => {
  const { ctx, page } = await makePage();
  await openLuna(page);
  // measured synchronously INSIDE the click's evaluate — no wire latency race
  const ms = await page.evaluate(() => {
    document.getElementById("btnNext").click();
    return window.Dwell.state().suppressedMs;
  });
  assert.ok(ms > 0, `fresh page armed the settle window (${ms.toFixed(0)}ms left)`);
  await ctx.close();
});

test("progress: book-progress pool events logged; local resume reopens the page", async () => {
  const { ctx, page } = await makePage();
  await openLuna(page);
  await page.locator("#btnNext").click();          // page 1 -> progress saved
  assert.equal((await state(page)).page, 1);
  await page.waitForTimeout(300);                  // let the POST /log land
  const day = new Date().toISOString().slice(0, 10);
  const logged = fs.readFileSync(path.join(TMP, "logs", day + ".jsonl"), "utf8");
  assert.match(logged, /"event":"book-progress"/, "progress reaches the hub log/pool");
  assert.match(logged, /"slug":"luna-the-fox"/);
  // same client, fresh visit: the shelf reopens her book at the saved page
  await page.goto(`${BASE}/reader/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Reader && typeof window.Reader.state === "function");
  await openLuna(page);
  assert.equal((await state(page)).page, 1, "resumed at the saved page");
  await ctx.close();
});

test("LAW: fresh client with no saved progress opens at page 1", async () => {
  const { ctx, page } = await makePage();          // new context = clean localStorage
  await openLuna(page);
  assert.equal((await state(page)).page, 0, "nothing client-side -> page 1 (resume-from-pool is a follow-up)");
  await ctx.close();
});
