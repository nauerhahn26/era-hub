// reader-ui.test.mjs — Book Reader v2 e2e (the OLD Book-Reader UI ported onto
// the local package data layer; dad: "I like my old layout. Please match.").
// Spawns the REAL server.js on a scratch port with a throwaway ERA_DATA_DIR and
// the SYNTHETIC "Luna the Fox" fixture package (never real book content), then
// drives /reader/ with Playwright. Proves: the shelf renders the OLD layout
// (shelf-card grid, square covers, NO in-grid black rest cell — generous
// gutters are the drift protection — plus the Back-to-TD-Snap exit tile), a
// tap opens the book and narration PLAYS, word-sync highlights >=1 token with
// a monotonically non-decreasing active index (manifest words AND the
// interpolation fallback), next/prev/Read-Pause work by synthetic click
// (touch parity), a textless page is ready IMMEDIATELY, narration end PAUSES
// ON THE PAGE with the big ready-arrow (the old reader's law — the page never
// turns itself), the arrow stops narration mid-read before turning, the end
// of the book grows the Library button, every page change arms the dwell
// settle window (D51), progress lands in the hub log, local resume reopens at
// the saved page, and speechSynthesis.speak is NEVER called (narration is
// recorded audio — the old harness's no-TTS law).
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
  // fixture package — four page shapes the reader must handle:
  //   p0: words+audio (manifest timings)   p1: audio, NO words (interpolation)
  //   p2: textless + silent MIDDLE page (ready arrow IMMEDIATELY)
  //   p3: LAST page with audio (narration end -> book finished -> Library)
  const book = path.join(TMP, "books", "luna-the-fox");
  fs.mkdirSync(path.join(book, "pages"), { recursive: true });
  fs.mkdirSync(path.join(book, "audio"), { recursive: true });
  fs.writeFileSync(path.join(book, "cover.jpg"), JPEG);
  for (const n of ["001", "002", "003", "004"]) fs.writeFileSync(path.join(book, "pages", n + ".jpg"), JPEG);
  for (const n of ["001", "002", "004"]) fs.writeFileSync(path.join(book, "audio", n + ".wav"), makeWav(3));
  fs.writeFileSync(path.join(book, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000002",
    slug: "luna-the-fox",
    title: "Luna the Fox",
    authored: true,          // a family-made book — wears the "…'s story" badge
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
      { index: 3, image: "pages/004.jpg", text: "Good night fox.", audio: "audio/004.wav" },
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

// hasTouch contexts: the required next/prev/Read interactions are the touch
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
  await page.locator("#shelfGrid .shelf-card-button", { hasText: "Luna the Fox" }).click();
  await page.waitForFunction(() => window.Reader.state().screen === "sRead");
};

test("shelf: OLD layout — shelf-card grid, square cover, NO in-grid rest cell, TD Snap exit tile", async () => {
  const { ctx, page } = await makePage();
  const tile = page.locator("#shelfGrid .shelf-card-button.dwell").first();
  await tile.waitFor();
  assert.equal(await tile.locator(".shelf-title").textContent(), "Luna the Fox");
  assert.match(await tile.locator(".shelf-cover img").getAttribute("src"),
    /\/books\/luna-the-fox\/cover\.jpg\?v=[a-z0-9]+$/);   // ?v= cache-bust (8/25)
  // the OLD shelf's drift protection is its generous gutters — no black cells
  assert.equal(await page.locator("#shelfGrid .restCell").count(), 0, "no in-grid rest cell (old layout)");
  assert.equal(await page.locator("#rest").count(), 0, "no rest area anywhere (dad 8/25)");
  assert.equal(await page.locator("#shelfGrid .shelf-tdsnap-button").count(), 1, "Back to TD Snap exit tile");
  assert.equal(await page.locator("#shelfGrid .shelf-tdsnap-button").getAttribute("data-dwell-ms"),
    "2400", "leaving the app is the highest-consequence hold (EXIT_HOLD_MS)");
  assert.equal((await state(page)).shelfCount, 1);
  await ctx.close();
});

// The door goes where Settings says (dad 9/3). The tile is named for where
// the door will REALLY go — TD Snap only when a gaze engine answers the bus
// (VM leg B 9/3: a PC with no engine promised "Back to TD Snap" and went
// home) — and both answers of the hub's /kiosk/exit are followed.
test("exit tile: named for the door's REAL destination; follows /kiosk/exit (closed stays, home navigates)", async () => {
  const setExit = (v) => fetch(`${BASE}/settings`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exitTo: v }) });
  // a stand-in ERAgaze on its fixed port; skip that half (not fail) if a real one holds it
  const http = await import("node:http");
  const engine = http.createServer((q, s) => { s.writeHead(200).end("ok"); });
  const bound = await new Promise((res) => { engine.once("error", () => res(false)); engine.listen(49155, "127.0.0.1", () => res(true)); });
  try {
    await setExit("home");
    const { ctx, page } = await makePage();
    const tile = page.locator("#shelfGrid .shelf-tdsnap-button");
    assert.equal(await tile.locator(".shelf-title").textContent(), "Back to New ERA");
    assert.equal(await tile.getAttribute("data-dwell-say"), "back to new era");
    await tile.click();                                   // live hub → home
    await page.waitForURL(/\/home\/?$/, { timeout: 8000 });
    await ctx.close();

    await setExit("tdsnap");
    if (bound) {
      const { ctx: c2, page: p2 } = await makePage();
      const t2 = p2.locator("#shelfGrid .shelf-tdsnap-button");
      assert.equal(await t2.locator(".shelf-title").textContent(), "Back to TD Snap", "an engine on the bus: the door really goes to TD Snap");
      let hits = 0;
      await c2.route("**/kiosk/exit", (r) => { hits++; r.fulfill({ status: 200, contentType: "application/json", body: '{"action":"closed"}' }); });
      await t2.click();
      await p2.waitForTimeout(300);
      assert.equal(hits, 1, "door POSTs /kiosk/exit exactly once");
      assert.match(p2.url(), /\/reader\//, "closed: the hub is closing the kiosk — no navigation");
      await c2.close();
      engine.close();
      await new Promise((r) => engine.once("close", r));
    } else console.log("# 49155 busy — engine stand-in half skipped");

    // Settings still says TD Snap, but no engine answers: the tile must not promise it
    const { ctx: c3, page: p3 } = await makePage();
    const t3 = p3.locator("#shelfGrid .shelf-tdsnap-button");
    assert.equal(await t3.locator(".shelf-title").textContent(), "Back to New ERA", "no engine: the door goes home and the tile says so");
    await t3.click();
    await p3.waitForURL(/\/home\/?$/, { timeout: 8000 });
    await c3.close();
  } finally { if (bound && engine.listening) engine.close(); await setExit("tdsnap"); }
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
  assert.equal(s.arrow, false, "no ready-arrow while narration is playing");
  assert.equal(await page.locator("#rest").count(), 0, "no black rest spot in the reader (dad 8/25)");
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
  assert.ok(await page.locator("#pageText .reader-token.active").count() <= 1, "at most one live highlight");
  await ctx.close();
});

test("OLD-READER LAW: narration end PAUSES on the page with the ready-arrow; HER arrow turns it", async () => {
  const { ctx, page } = await makePage();
  await openLuna(page);
  // narration (3s) ends -> the big ready-arrow rises and WAITS
  await page.waitForFunction(() => window.Reader.state().arrow === true, null, { timeout: 10000 });
  assert.ok(await page.locator("#btnNext.reader-next-button-ready").isVisible(),
    "next arrow grew into the big centre-right ready-arrow");
  // the page NEVER turns itself (v1 auto-advanced 600ms after audio — the regression)
  await page.waitForTimeout(1500);
  const s = await state(page);
  assert.equal(s.page, 0, "reader waits on the page — no auto-advance");
  assert.equal(s.screen, "sRead");
  await page.locator("#btnNext").click();          // she turns the page
  assert.equal((await state(page)).page, 1);
  await ctx.close();
});

test("next/prev/Read-Pause by synthetic click (touch parity); arrow stops narration mid-read", async () => {
  const { ctx, page } = await makePage();
  await openLuna(page);
  // arrow mid-narration: the story stops, the page turns, the new page reads
  await page.waitForFunction(() => window.Reader.state().audioTime > 0.4, null, { timeout: 6000 });
  await page.locator("#btnNext").click();
  assert.equal((await state(page)).page, 1, "next turns forward");
  assert.match(await page.evaluate(() => document.getElementById("narration").src),
    /002\.wav(\?v=[^&]*)?$/, "page 0 narration was stopped — page 1's audio loaded (pauses with the arrow)");
  await page.locator("#btnPrev").click();
  assert.equal((await state(page)).page, 0, "prev turns back");
  // let narration run, then Read/Pause: pauses in place, resumes in place
  await page.waitForFunction(() => window.Reader.state().audioTime > 0.7, null, { timeout: 6000 });
  await page.locator("#btnRead").click();
  await page.waitForFunction(() => window.Reader.state().audio === "paused", null, { timeout: 3000 });
  const tPaused = (await state(page)).audioTime;
  assert.ok(tPaused > 0.6, `pause keeps her place (t=${tPaused})`);
  // the pause EVENT (which flips the pill) fires a task after paused=true —
  // wait for the label rather than racing it
  await page.waitForFunction(
    () => document.querySelector("#btnRead .dwell-label").textContent === "Read",
    null, { timeout: 3000 });
  await page.locator("#btnRead").click();
  await page.waitForFunction(() => window.Reader.state().audio === "playing", null, { timeout: 3000 });
  assert.ok((await state(page)).audioTime >= tPaused - 0.3, "resume continues from where she paused");
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

test("textless page is ready IMMEDIATELY (big arrow, Read disabled); her arrow advances", async () => {
  const { ctx, page } = await makePage();
  await openLuna(page);
  await page.locator("#btnNext").click();
  await page.locator("#btnNext").click();          // -> page 2: textless, silent, MIDDLE page
  const s = await state(page);
  assert.equal(s.page, 2);
  assert.equal(s.arrow, true, "ready-arrow up immediately, no waiting on audio");
  assert.equal(s.audio, "paused", "no narration on a silent page");
  assert.ok(await page.locator("#btnNext.reader-next-button-ready").isVisible());
  assert.equal(await page.locator("#btnRead").getAttribute("data-dwell-disabled"), "",
    "Read pill disabled with nothing to read");
  await page.locator("#btnNext").click();
  assert.equal((await state(page)).page, 3, "her arrow turns the silent page");
  assert.equal(await page.evaluate(() => window.__speakCalls), 0, "no speechSynthesis, ever");
  await ctx.close();
});

test("end of book: last narration ends -> big pulsing Library button invites her back to the shelf", async () => {
  const { ctx, page } = await makePage();
  await openLuna(page);
  for (let i = 0; i < 3; i++) await page.locator("#btnNext").click();  // -> page 3 (last)
  await page.waitForFunction(() => window.Reader.state().bookFinished === true, null, { timeout: 12000 });
  const s = await state(page);
  assert.equal(s.page, 3, "still on the last page — no dead-end screen");
  assert.equal(s.arrow, false, "no ready-arrow at the end (Library is the invitation)");
  assert.ok(await page.locator("#btnLibrary.reader-library-button-finished").isVisible(),
    "Library button grew into the end-of-book invitation");
  await page.locator("#btnLibrary").click();
  await page.waitForFunction(() => window.Reader.state().screen === "sShelf");
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

// Bug 32 (QA 9/2): every authored book was badged "Ellie's story" for every
// family. The badge and the shelf heading take her name from Settings, and
// say "My" until the family has given one.
test("the authored badge and shelf heading carry HER name from Settings, 'My' before setup (bug 32)", async () => {
  let { ctx, page } = await makePage();            // no profile.json yet
  const badge = page.locator("#shelfGrid .shelf-authored-badge").first();
  await badge.waitFor();
  assert.equal((await badge.textContent()).trim(), "My story");
  assert.equal(await page.locator("#shelfTitle").textContent(), "My Bookshelf");
  await ctx.close();

  const r = await fetch(`${BASE}/setup`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ childName: "Maya" }) });
  assert.ok(r.ok, "setup saved");
  ({ ctx, page } = await makePage());
  await page.waitForFunction(() => document.getElementById("shelfTitle").textContent.startsWith("Maya"));
  assert.equal((await page.locator("#shelfGrid .shelf-authored-badge").first().textContent()).trim(), "Maya's story");
  assert.equal(await page.locator("#shelfTitle").textContent(), "Maya's Bookshelf");
  assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /Ellie/, "nobody else's name on the shelf");
  await ctx.close();
});

// Bug 31 (VM QA 9/2): an empty bookshelf never noticed the first Drive book
// without a relaunch. The empty shelf keeps asking for the index and the
// cover appears on its own. The hub's index is stood in for so the poll can
// be driven without waiting 20 real seconds.
test("an empty shelf notices the first book without a relaunch (bug 31)", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  await ctx.addInitScript(() => {
    window.__timers = [];
    const si = window.setInterval.bind(window);
    window.setInterval = (fn, ms) => { window.__timers.push({ fn, ms }); return si(fn, ms); };
  });
  let empty = true;
  await ctx.route("**/books/index.json", r => empty
    ? r.fulfill({ status: 200, contentType: "application/json", body: "[]" }) : r.continue());
  const page = await ctx.newPage();
  await page.goto(`${BASE}/reader/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Reader && window.Reader.state().shelfCount === 0);
  assert.equal(await page.locator("#shelfEmpty").isHidden(), false, "'No books yet' shows");
  assert.equal(await page.locator("#shelfGrid .shelf-card-button").count(), 0);
  const poll = await page.evaluate(() => (window.__timers.find(t => t.ms === 20000) || {}).ms);
  assert.equal(poll, 20000, "the empty shelf keeps asking for the index");

  empty = false;                                   // Drive delivered the first book
  await page.evaluate(() => window.__timers.filter(t => t.ms === 20000).forEach(t => t.fn()));
  await page.waitForFunction(() => window.Reader.state().shelfCount === 1);
  await page.locator("#shelfGrid .shelf-card-button", { hasText: "Luna the Fox" }).waitFor();
  assert.equal(await page.locator("#shelfEmpty").isHidden(), true, "the notice is gone");
  await ctx.close();
});
