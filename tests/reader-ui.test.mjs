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
// …overridable, the way pool.test.mjs's is, so this suite can be run on a
// scratch port while the box's own hubs hold the map above.
const PORT = Number(process.env.ERA_TEST_HUB_PORT) || 8391;
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
  // The slower of the two clocks (spec §13): nothing is in flight on an empty
  // shelf — no book is being made — so the shelf looks once a minute rather
  // than every twenty seconds. It still never needs a relaunch, which is the
  // whole of bug 31.
  const poll = await page.evaluate(() => (window.__timers.find(t => t.ms === 60000) || {}).ms);
  assert.equal(poll, 60000, "the empty shelf keeps asking for the index");

  empty = false;                                   // Drive delivered the first book
  await page.evaluate(() => window.__timers.filter(t => t.ms === 60000).forEach(t => t.fn()));
  await page.waitForFunction(() => window.Reader.state().shelfCount === 1);
  await page.locator("#shelfGrid .shelf-card-button", { hasText: "Luna the Fox" }).waitFor();
  assert.equal(await page.locator("#shelfEmpty").isHidden(), true, "the notice is gone");
  await ctx.close();
});

// ------------------------------------------------ the shelf that is not empty
// yet (dad 9/7). "No books yet — 📚 Add books with Google Drive, set it up in
// Settings" was shown in EVERY state with nothing on the shelf: it was on the
// screen while seventeen of his photos sat in the Drive folder he had already
// set up. The Drive prompt is true in exactly one state, and the shelf now says
// what is really happening in the others. /content/status is the Settings
// card's own payload; the shelf reads the same one, so the two can never tell a
// family two different stories.
const contentStatus = (over) => ({
  mode: "local", local: true, skipped: null, loose: 0, quietMs: 600000,
  building: false, job: null, queued: [], jobs: [], lastScan: null, ...over });

// A PILE OF PHOTOS NOBODY HAS TAPPED BUILD ON (spec §13/§14). content.jobFor
// reports one as a job row with no job.json behind it: `waiting:"pile"`,
// `buildable` (this door would say yes) and `elsewhere` (another computer's
// warm claim) are the three derived answers the card is drawn from, and the
// photo count arrives as `progress.pages` like every other row's.
const pileRow = (over) => ({
  kind: "books", slug: "kitchen-table", title: "Kitchen Table", state: "inbox",
  waiting: "pile", buildable: true, elsewhere: false,
  progress: { pages: 12, transcribed: 0, narrated: 0 },
  held: null, error: null, paused: null, ...over });

// THE STATUS STUB (spec §17's reader list). Everything on this shelf that is
// not yet a book is drawn from /content/status, and the tap that starts one
// goes back out of the same page as POST /content/build — so the whole of Part
// B's shelf can be driven by handing the page a payload and reading what it
// posts. `status` may be a function so a test can change the hub's answer
// between polls; `posts` collects the build requests, raw as well as parsed,
// because "never the sentinel" is a claim about the BYTES on the wire.
// The timer hooks are the same idiom the two poll tests already use: the poll
// is a real interval, and a suite must be able to turn it by hand rather than
// wait a minute of wall clock for it.
async function shelfWith(status, index = "[]", opts = {}) {
  const posts = [];
  const answer = opts.answer || { code: 202, body: { started: true, slug: "kitchen-table" } };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  await ctx.addInitScript(() => {
    window.__timers = [];
    const si = window.setInterval.bind(window);
    window.setInterval = (fn, ms) => { window.__timers.push({ fn, ms, kind: "interval" }); return si(fn, ms); };
    const st = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms) => { window.__timers.push({ fn, ms, kind: "timeout" }); return st(fn, ms); };
  });
  await ctx.route("**/books/index.json",
    r => r.fulfill({ status: 200, contentType: "application/json", body: index }));
  await ctx.route("**/content/status", r => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify(typeof status === "function" ? status() : status) }));
  await ctx.route("**/content/build", (r) => {
    const raw = r.request().postData() || "";
    let json = null; try { json = JSON.parse(raw); } catch {}
    posts.push({ raw, json });
    r.fulfill({ status: answer.code, contentType: "application/json", body: JSON.stringify(answer.body) });
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/reader/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Reader && typeof window.Reader.state === "function");
  // turn every poll interval the page has armed, whichever clock it chose
  const tick = () => page.evaluate(async () => {
    for (const t of window.__timers.filter(x => x.ms === 20000 || x.ms === 60000)) await t.fn();
  });
  // and the ask's own fifteen seconds, without waiting fifteen of them
  const fire = (ms) => page.evaluate((n) => {
    for (const t of window.__timers.filter(x => x.ms === n)) t.fn();
  }, ms);
  return { ctx, page, posts, tick, fire };
}

test("no Drive folder on this computer: the Drive prompt is the right answer", async () => {
  const { ctx, page } = await shelfWith(contentStatus({ local: false, mode: "off" }));
  await page.waitForFunction(() => window.Reader.state().drive === false);
  assert.equal(await page.locator("#shelfEmpty").isHidden(), false);
  assert.equal(await page.locator("#shelfEmptyLink").isHidden(), false, "the link to Settings");
  await ctx.close();
});

test("Drive IS set up and there are no books: the prompt names the folder, not Settings", async () => {
  const { ctx, page } = await shelfWith(contentStatus({ local: true }));
  await page.waitForFunction(() => window.Reader.state().drive === true);
  assert.equal(await page.locator("#shelfEmpty").isHidden(), false);
  assert.equal(await page.locator("#shelfEmptyLink").isHidden(), true,
    "never 'set up Google Drive' at a family whose Drive is set up");
  const s = await page.locator("#shelfEmptyLine").textContent();
  assert.match(s, /books folder in your Google Drive/i, s);
  await ctx.close();
});

// The loose pile is a PILE card now (spec §13), not a book with a clock on it:
// "17 photos" and Build a book, because since "built here" nothing on this
// shelf starts by itself and "about 10 minutes" was a promise the hub stopped
// keeping. The gaze rule it was written for is unchanged in substance — her
// gaze can never arm on it — but the card is no longer classless: it carries
// .dwell AND data-dwell-disabled, so a grown-up's slow press still works on
// Windows (dwell.js's long-press rescue matches .dwell alone).
test("photos are waiting in books/: the shelf says a book is coming, not 'no books'", async () => {
  const { ctx, page } = await shelfWith(contentStatus({ loose: 17 }));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  assert.equal(await page.locator("#shelfEmpty").isHidden(), true, "not an empty shelf at all");
  const card = page.locator("#shelfGrid .shelf-card.is-pile");
  const s = await card.textContent();
  assert.match(s, /17 photos/, s);
  assert.match(s, /Build a book/, "and what a grown-up does about it: " + s);
  assert.equal(await card.locator(".dwell:not([data-dwell-disabled])").count(), 0,
    "her gaze can never arm on it");
  assert.equal(await page.locator("#shelfGrid .shelf-card-button").count(), 0, "nothing to open");
  await ctx.close();
});

test("a book being built shows how far it has got, and is not openable", async () => {
  const { ctx, page } = await shelfWith(contentStatus({ jobs: [
    { kind: "books", slug: "sunny-pond", title: "Sunny Pond", state: "transcribing",
      progress: { pages: 16, transcribed: 4, narrated: 0 }, held: null, error: null, paused: null }] }));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  const s = await page.locator("#shelfGrid .shelf-card.is-building").textContent();
  assert.match(s, /Sunny Pond/);
  assert.match(s, /Making this book/i);
  assert.match(s, /4 of 16 pages read/);
  assert.equal(await page.locator("#shelfGrid .shelf-card-button").count(), 0, "nothing to open yet");
  await ctx.close();
});

test("a book that is stuck says WHY, and never 'set up Google Drive'", async () => {
  const { ctx, page } = await shelfWith(contentStatus({ jobs: [
    { kind: "books", slug: "sunny-pond", title: "Sunny Pond", state: "inbox",
      progress: { pages: 17, transcribed: 0, narrated: 0 },
      held: "needs-photo-decoder", error: null, paused: null }] }));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  const s = await page.locator("#shelfGrid .shelf-card.is-building").textContent();
  assert.match(s, /iPhone photos/i, s);
  assert.doesNotMatch(s, /set it up in Settings/i);
  assert.equal(await page.locator("#shelfEmpty").isHidden(), true);
  await ctx.close();
});

// A book that STOPPED, said to a six-year-old. `error` is the provider's own
// string off job.errors — the Settings card is forbidden to print it
// (public/settings/index.html ctSorry: "it names nothing a parent can act on and
// reads like a crash") and this shelf is the last place it belongs.
test("a stopped book never puts the provider's own words on her screen", async () => {
  const { ctx, page } = await shelfWith(contentStatus({ jobs: [
    { kind: "books", slug: "sunny-pond", title: "Sunny Pond", state: "failed",
      progress: { pages: 16, transcribed: 4, narrated: 0 },
      held: null, paused: null, error: "ai(google/gemini-3-flash-preview) 500 boom" }] }));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  const s = await page.locator("#shelfGrid .shelf-card.is-building").textContent();
  assert.match(s, /This book stopped/i, s);
  assert.match(s, /grown-up/i, "and who can do something about it");
  assert.doesNotMatch(s, /gemini|500|boom|ai\(/i, "the raw provider string reached her screen: " + s);
  await ctx.close();
});

// A book holding on "retry" ALWAYS carries an error (content-worker.js notes the
// page it lost and only then holds), and it has not stopped at all — it is
// waiting for its next look and will carry on by itself.
test("a book that lost one page and will try again is not called stopped", async () => {
  const { ctx, page } = await shelfWith(contentStatus({ jobs: [
    { kind: "books", slug: "sunny-pond", title: "Sunny Pond", state: "transcribing",
      progress: { pages: 16, transcribed: 12, narrated: 0 },
      held: "retry", paused: null, error: "ai(google/gemini-3-flash-preview) 500 boom on page 13" }] }));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  const s = await page.locator("#shelfGrid .shelf-card.is-building").textContent();
  assert.doesNotMatch(s, /stopped/i, s);
  assert.match(s, /12 of 16 pages read/, "it is still making this book: " + s);
  await ctx.close();
});

// THE SHELF IS NOT REBUILT UNDER HER GAZE. renderShelf() empties the grid and
// makes every card again — the openable books' dwell-buttons and #btnExit (the
// highest-consequence hold in the app) with them — and era-core/dwell.js tracks
// the ELEMENT, so a rebuild throws an in-flight dwell away. A book that cannot
// finish (no key yet, a hold nobody has lifted) keeps the poll running for the
// whole session, so "re-render because something is building" meant doing that
// every twenty seconds, for ever.
test("the poll only repaints the shelf when something actually changed", async () => {
  const job = { kind: "books", slug: "sunny-pond", title: "Sunny Pond", state: "inbox",
                progress: { pages: 16, transcribed: 4, narrated: 0 },
                held: "no-ai-key", paused: null, error: null };
  const live = { status: contentStatus({ jobs: [job] }) };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  await ctx.addInitScript(() => {
    window.__timers = [];
    const si = window.setInterval.bind(window);
    window.setInterval = (fn, ms) => { window.__timers.push({ fn, ms }); return si(fn, ms); };
  });
  await ctx.route("**/books/index.json", r => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify([{ slug: "luna-the-fox", title: "Luna the Fox",
      cover: "/books/luna-the-fox/cover.jpg", pages: 4, hasVideo: false, authored: false }]) }));
  await ctx.route("**/content/status", r => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify(live.status) }));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/reader/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Reader && window.Reader.state().buildingCount === 1);
  const tick = () => page.evaluate(async () => {
    for (const t of window.__timers.filter(x => x.ms === 20000)) await t.fn();
  });
  // The two nodes her gaze may be resting on when the poll comes round.
  await page.evaluate(() => {
    document.getElementById("btnExit").dataset.mark = "same";
    document.querySelector("#shelfGrid .shelf-card-button").dataset.mark = "same";
  });

  await tick(); await tick();
  assert.equal(await page.locator("#btnExit").getAttribute("data-mark"), "same",
    "the exit tile was replaced under her gaze while nothing had changed");
  assert.equal(await page.locator("#shelfGrid .shelf-card-button").getAttribute("data-mark"), "same",
    "so was the book she was about to open");
  assert.equal(await page.evaluate(() => window.Reader.state().buildingCount), 1,
    "…and it would have gone on doing it for the whole session");

  // …and a card whose words really did change still repaints, settling her gaze
  // afterwards the way every other render in this app does (D51).
  live.status = contentStatus({ jobs: [{ ...job, held: null, state: "transcribing",
    progress: { pages: 16, transcribed: 9, narrated: 0 } }] });
  await tick();
  await page.locator("#shelfGrid .shelf-card.is-building", { hasText: "9 of 16 pages read" }).waitFor();
  assert.equal(await page.locator("#btnExit").getAttribute("data-mark"), null, "a real change repaints");
  assert.ok(await page.evaluate(() => window.Dwell.state().suppressedMs) > 0,
    "a fresh set of dwell targets never inherits her gaze");
  await ctx.close();
});

test("a book already on the shelf is not shown twice while the mirror catches up", async () => {
  const { ctx, page } = await shelfWith(
    contentStatus({ jobs: [
      { kind: "books", slug: "luna-the-fox", title: "Luna the Fox", state: "done",
        progress: { pages: 4, transcribed: 4, narrated: 4 }, held: null, error: null, paused: null }] }),
    JSON.stringify([{ slug: "luna-the-fox", title: "Luna the Fox", cover: "/books/luna-the-fox/cover.jpg",
                     pages: 4, hasVideo: false, authored: false }]));
  await page.waitForFunction(() => window.Reader.state().shelfCount === 1);
  assert.equal(await page.evaluate(() => window.Reader.state().buildingCount), 0);
  assert.equal(await page.locator("#shelfGrid .shelf-card.is-building").count(), 0);
  await ctx.close();
});

// ============================================================ BUILT ONCE (§13)
// Nothing on this shelf starts a book any more. The scan stopped claiming quiet
// inboxes and stopped gathering the loose pile, so a pile of photos sits there
// until a grown-up taps Build on the device that will do the work — and this
// shelf is one of the two places that tap lives. Everything below is spec §13's
// contract: the card keeps a real card's box so the slot never reflows, her
// gaze can never arm on any of it, the press only ASKS, and while the question
// is open the whole shelf is asleep the way the board is under its partner
// sheet (board-partner.js freezeBoard).

test("a pile of photos keeps a real card's box, and her gaze can never arm any of it", async () => {
  const { ctx, page } = await shelfWith(contentStatus({ jobs: [pileRow()] }));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  const card = page.locator("#shelfGrid .shelf-card.is-pile");
  await card.waitFor();
  assert.equal(await card.locator(".shelf-cover").count(), 1, "the picture sits where the cover goes");
  assert.equal(await card.locator(".shelf-title").textContent(), "Kitchen Table");
  const s = await card.textContent();
  assert.match(s, /12 photos/, s);
  assert.match(s, /Build a book/, s);
  // §13 gaze safety, and it is NOT "no class": .dwell keeps dwell.js's
  // long-press rescue and its context-menu suppression alive for a finger,
  // data-dwell-disabled keeps targetAt() away from it for her gaze.
  assert.ok(await card.evaluate(el => el.classList.contains("dwell")), "the card carries .dwell");
  assert.equal(await card.getAttribute("data-dwell-disabled"), "", "…and is stamped disabled");
  assert.equal(await card.locator(".dwell:not([data-dwell-disabled])").count(), 0,
    "zero live dwell targets inside a pile card");
  assert.ok(await card.locator(".dwell-button").count() >= 1, "the pile has a button to press");
  assert.equal(await card.locator(".dwell-button:not([data-dwell-disabled])").count(), 0,
    "every button on it carries data-dwell-disabled");
  assert.equal(await page.locator("#shelfGrid .shelf-card-button").count(), 0, "nothing to open yet");
  await ctx.close();
});

test("Build does not build: it opens the ask, and the confirming button is a different element", async () => {
  const { ctx, page, posts } = await shelfWith(contentStatus({ jobs: [pileRow()] }));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  await page.locator("#shelfGrid .shelf-card.is-pile .shelf-build-button").click();
  const ask = page.locator("#shelfAsk");
  await ask.waitFor();
  const q = await ask.textContent();
  assert.match(q, /Build a book from these 12 photos\?\s*A grown-up should do this\./, q);
  assert.equal(posts.length, 0, "pressing Build spends nothing and starts nothing");
  // two different buttons in two different places — the press that starts a
  // book can never be the second half of the press that asked the question
  const same = await page.evaluate(() => {
    const yes = document.getElementById("shelfAskYes");
    const b = document.querySelector("#shelfGrid .shelf-card.is-pile .shelf-build-button");
    return yes === b || (b ? b.contains(yes) : false);
  });
  assert.equal(same, false, "the confirming button is its own element");
  const boxes = await page.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return [b.left, b.top]; };
    return [r(document.getElementById("shelfAskYes")), r(document.getElementById("shelfAskNo"))];
  });
  assert.notDeepEqual(boxes[0], boxes[1], "…in a different place from Not now");
  await ctx.close();
});

test("while the ask is open the shelf is asleep — no live dwell target, the exit tile included", async () => {
  const { ctx, page } = await shelfWith(contentStatus({ jobs: [pileRow()] }),
    JSON.stringify([{ slug: "luna-the-fox", title: "Luna the Fox",
      cover: "/books/luna-the-fox/cover.jpg", pages: 4, hasVideo: false, authored: true }]));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  await page.locator("#shelfGrid .shelf-card.is-pile .shelf-build-button").click();
  await page.locator("#shelfAsk").waitFor();
  assert.equal(await page.locator("#sShelf .dwell:not([data-dwell-disabled])").count(), 0,
    "a parked gaze could still fire the shelf behind the question");
  // the exit tile is the highest-consequence hold in the app, and unlike the
  // board's door it is NOT kept awake under this one
  assert.equal(await page.locator("#btnExit").getAttribute("data-dwell-disabled"), "");
  assert.equal(await page.locator("#btnExit").evaluate(el => el.classList.contains("dwell")), false,
    "the class goes too — dwell.js's 150ms tap-rescue matches .dwell alone");
  assert.ok(await page.evaluate(() => window.Dwell.state().suppressedMs) > 0,
    "opening the ask settles her gaze (Dwell.suppress(600))");
  await ctx.close();
});

test("Not now closes the ask, thaws with a settle window, and wakes nothing that was born asleep", async () => {
  const { ctx, page, posts } = await shelfWith(contentStatus({ jobs: [pileRow()] }),
    JSON.stringify([{ slug: "luna-the-fox", title: "Luna the Fox",
      cover: "/books/luna-the-fox/cover.jpg", pages: 4, hasVideo: false, authored: true }]));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  await page.locator("#shelfGrid .shelf-card.is-pile .shelf-build-button").click();
  await page.locator("#shelfAsk").waitFor();
  await page.evaluate(() => window.Dwell.suppress(1));   // let the opening settle window run down
  await page.waitForTimeout(30);
  await page.locator("#shelfAskNo").click();
  await page.waitForFunction(() => !document.getElementById("shelfAsk"));
  assert.equal(posts.length, 0, "Not now spends nothing");
  assert.equal(await page.locator("#btnExit").evaluate(el => el.classList.contains("dwell")), true);
  assert.equal(await page.locator("#btnExit").getAttribute("data-dwell-disabled"), null,
    "the shelf she can use is handed back");
  assert.ok(await page.evaluate(() => window.Dwell.state().suppressedMs) > 0,
    "closing settles her gaze too");
  // …and the pile card, which was asleep BEFORE the ask, is still asleep: a
  // thaw that woke everything it found would hand her gaze the Build button.
  assert.equal(await page.locator("#shelfGrid .shelf-card.is-pile .dwell:not([data-dwell-disabled])").count(), 0);
  await ctx.close();
});

test("fifteen seconds untouched closes the ask by itself and thaws the shelf", async () => {
  const { ctx, page, fire } = await shelfWith(contentStatus({ jobs: [pileRow()] }));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  await page.locator("#shelfGrid .shelf-card.is-pile .shelf-build-button").click();
  await page.locator("#shelfAsk").waitFor();
  assert.equal(await page.evaluate(() => (window.__timers.find(t => t.ms === 15000) || {}).ms), 15000,
    "the question does not sit on her shelf for ever");
  await page.evaluate(() => window.Dwell.suppress(1));
  await page.waitForTimeout(30);
  await fire(15000);
  await page.waitForFunction(() => !document.getElementById("shelfAsk"));
  assert.equal(await page.locator("#btnExit").evaluate(el => el.classList.contains("dwell")), true,
    "the shelf comes back on its own");
  assert.ok(await page.evaluate(() => window.Dwell.state().suppressedMs) > 0);
  await ctx.close();
});

test("Build it posts /content/build for the pile folder and thaws the shelf", async () => {
  const { ctx, page, posts } = await shelfWith(contentStatus({ jobs: [pileRow()] }));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  await page.locator("#shelfGrid .shelf-card.is-pile .shelf-build-button").click();
  await page.locator("#shelfAskYes").click();
  await page.waitForFunction(() => !document.getElementById("shelfAsk"));
  assert.equal(posts.length, 1, "exactly one build, on the press she confirmed");
  assert.deepEqual(posts[0].json, { kind: "books", slug: "kitchen-table" });
  assert.equal(await page.locator("#btnExit").evaluate(el => el.classList.contains("dwell")), true,
    "and the shelf is hers again");
  await ctx.close();
});

test("the loose pile posts loose:true — its sentinel slug never leaves this page", async () => {
  const { ctx, page, posts } = await shelfWith(contentStatus({ loose: 9 }));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  const card = page.locator("#shelfGrid .shelf-card.is-pile");
  assert.match(await card.textContent(), /9 photos/);
  await card.locator(".shelf-build-button").click();
  await page.locator("#shelfAskYes").click();
  await page.waitForFunction(() => !document.getElementById("shelfAsk"));
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].json, { kind: "books", loose: true },
    "the pile in books/ has no slug until the hub gathers it");
  assert.equal(posts[0].raw.includes("\u0000"), false, "the sentinel reached the hub: " + posts[0].raw);
  assert.equal(posts[0].raw.includes("slug"), false, "…as a slug: " + posts[0].raw);
  await ctx.close();
});

test("the ask survives a repaint: S.asking is outside the signature, and the fresh cards are asleep again", async () => {
  let st = contentStatus({ jobs: [pileRow()] });
  const { ctx, page, tick } = await shelfWith(() => st,
    JSON.stringify([{ slug: "luna-the-fox", title: "Luna the Fox",
      cover: "/books/luna-the-fox/cover.jpg", pages: 4, hasVideo: false, authored: true }]));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  await page.locator("#shelfGrid .shelf-card.is-pile .shelf-build-button").click();
  await page.locator("#shelfAsk").waitFor();
  await page.evaluate(() => { document.getElementById("btnExit").dataset.mark = "same"; });
  // a real change: one more photo landed in the pile while the question was up
  st = contentStatus({ jobs: [pileRow({ progress: { pages: 13, transcribed: 0, narrated: 0 } })] });
  await tick();
  await page.locator("#shelfGrid .shelf-card.is-pile", { hasText: "13 photos" }).waitFor();
  assert.equal(await page.locator("#btnExit").getAttribute("data-mark"), null, "the shelf really was rebuilt");
  await page.locator("#shelfAsk").waitFor();
  assert.match(await page.locator("#shelfAsk").textContent(), /13 photos/,
    "the question came back over the card it belongs to");
  assert.equal(await page.locator("#sShelf .dwell:not([data-dwell-disabled])").count(), 0,
    "a rebuilt shelf under an open ask is awake again unless the freeze is asked for a second time");
  await page.locator("#shelfAskNo").click();
  await page.waitForFunction(() => !document.getElementById("shelfAsk"));
  assert.equal(await page.locator("#btnExit").evaluate(el => el.classList.contains("dwell")), true);
  await ctx.close();
});

test("the poll runs on a shelf that already has books — a pile dropped on a full shelf needs no relaunch", async () => {
  const full = JSON.stringify([{ slug: "luna-the-fox", title: "Luna the Fox",
    cover: "/books/luna-the-fox/cover.jpg", pages: 4, hasVideo: false, authored: true }]);
  let st = contentStatus({});
  const { ctx, page, tick } = await shelfWith(() => st, full);
  await page.waitForFunction(() => window.Reader.state().shelfCount === 1);
  assert.equal(await page.evaluate(() => window.Reader.state().buildingCount), 0);
  // Nothing is in flight, so the shelf looks on the slower clock — but it DOES
  // look: before §13 the interval was never armed at all once the shelf had a
  // book on it, and a pile dropped into Drive waited for a relaunch.
  assert.equal(await page.evaluate(() => window.Reader.state().pollMs), 60000);
  st = contentStatus({ jobs: [pileRow()] });
  await tick();
  await page.locator("#shelfGrid .shelf-card.is-pile").waitFor();
  // …and a book actually being made moves it to the faster one
  st = contentStatus({ jobs: [{ kind: "books", slug: "sunny-pond", title: "Sunny Pond",
    state: "transcribing", buildable: true, elsewhere: false, waiting: null,
    progress: { pages: 16, transcribed: 4, narrated: 0 }, held: null, error: null, paused: null }] });
  await tick();
  await page.waitForFunction(() => window.Reader.state().pollMs === 20000);
  await ctx.close();
});

test("a book another computer is making says so, and offers nothing to press", async () => {
  const { ctx, page } = await shelfWith(contentStatus({ jobs: [
    { kind: "books", slug: "sunny-pond", title: "Sunny Pond", state: "transcribing",
      waiting: null, buildable: false, elsewhere: true,
      progress: { pages: 16, transcribed: 4, narrated: 0 }, held: null, error: null, paused: null }] }));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  const card = page.locator("#shelfGrid .shelf-card.is-building");
  const s = await card.textContent();
  assert.match(s, /Building on another computer/i, s);
  assert.equal(await card.locator(".shelf-build-button").count(), 0, "no button while it is theirs");
  assert.equal(await card.locator(".dwell:not([data-dwell-disabled])").count(), 0);
  await ctx.close();
});

// …AND NEITHER DOES THE BOOK THIS COMPUTER IS MAKING (B1.7's flagged gap, 9/10).
// `buildable` is "the door would say yes", and the door says yes to a job that is
// already ours — that is how run() joins a build in flight. So the card that had
// just been tapped drew "Making this book… 4 of 16 pages read" and "Build a book"
// over the same photo, on the one screen in the product that cannot ask anybody
// what it means. /content/status already says which book this hub has in hand
// (`building` + `job.slug`, and `queued` for the one waiting its turn), so the
// press is simply not offered on it.
test("the book THIS computer is making offers nothing to press either", async () => {
  const { ctx, page } = await shelfWith(contentStatus({
    building: true, job: { kind: "books", slug: "sunny-pond", step: "transcribe" },
    jobs: [
      { kind: "books", slug: "sunny-pond", title: "Sunny Pond", state: "transcribing",
        waiting: null, buildable: true, elsewhere: false,
        progress: { pages: 16, transcribed: 4, narrated: 0 }, held: null, error: null, paused: null },
      pileRow(),
    ],
  }));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 2);
  const mine = page.locator("#shelfGrid .shelf-card.is-building");
  const s = await mine.textContent();
  assert.match(s, /4 of 16 pages read/, s);
  assert.equal(await mine.locator(".shelf-build-button").count(), 0,
    "the card says what is happening; it does not also ask for it: " + s);
  assert.equal(await mine.locator(".shelf-build-tag").count(), 0, "and no tag over the cover");
  // The pile beside it is untouched: nothing is building on it, so the press stays.
  assert.equal(await page.locator("#shelfGrid .shelf-card.is-pile .shelf-build-button").count(), 1,
    "the pile of photos still has its Build");
  await ctx.close();
});

// The book that is only QUEUED here is the same answer: to a parent "it is
// building" and "it is about to build" are one sentence (content.js busyWith).
test("a book queued behind another on this computer offers nothing to press", async () => {
  const { ctx, page } = await shelfWith(contentStatus({
    building: true, job: { kind: "books", slug: "other-book", step: "transcribe" },
    queued: ["sunny-pond"],
    jobs: [
      { kind: "books", slug: "sunny-pond", title: "Sunny Pond", state: "inbox",
        waiting: null, buildable: true, elsewhere: false,
        progress: { pages: 16, transcribed: 0, narrated: 0 }, held: null, error: null, paused: null },
    ],
  }));
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  assert.equal(await page.locator("#shelfGrid .shelf-card.is-building .shelf-build-button").count(), 0);
  await ctx.close();
});

// EVERY SENTENCE THAT PROMISED AN AUTOMATIC START GOES (spec §12). The scan
// claims nothing now, so "this book starts in about 10 minutes", "building
// starts about 10 minutes after the last photo arrives" and "New ERA makes the
// book by itself" were all the hub promising something it had stopped doing.
test("no card on this shelf promises a book that starts by itself", async () => {
  // The three sentences by name, not "any mention of time": a book that is
  // PAUSED on a spent allowance really does carry on by itself when there is
  // more room, and that one stays.
  const PROMISE = /makes the book by itself|starts in about|Building starts about|minutes after the last photo/i;
  for (const st of [
    contentStatus({}),                                   // Drive set up, nothing on it
    contentStatus({ local: false, mode: "off" }),        // no Drive folder on this computer
    contentStatus({ loose: 17 }),                        // the pile in books/
    contentStatus({ jobs: [pileRow()] }),                // a pile folder
    contentStatus({ jobs: [pileRow({ waiting: null })] }),   // …once it has been claimed
    contentStatus({ jobs: [{ kind: "books", slug: "sunny-pond", title: "Sunny Pond",
      state: "transcribing", waiting: null, buildable: true, elsewhere: false,
      progress: { pages: 16, transcribed: 4, narrated: 0 }, held: null, error: null, paused: null }] }),
  ]) {
    const { ctx, page } = await shelfWith(st);
    await page.waitForFunction(() => window.Reader.state().drive !== null);
    const text = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(text, PROMISE, "a card still promises an automatic start: " + text);
    await ctx.close();
  }
});

// The coral rim is the whole point of the weekly book on this shelf: `authored`
// travels in the manifest, survives a word edit and animate's re-publish
// (content-publish.js), and lands here as a warm border a six-year-old can pick
// out from across the room.
test("an authored manifest paints the rim", async () => {
  const { ctx, page } = await shelfWith(contentStatus({}),
    JSON.stringify([
      { slug: "luna-the-fox", title: "Luna the Fox", cover: "/books/luna-the-fox/cover.jpg",
        pages: 4, hasVideo: false, authored: true },
      { slug: "plain-book", title: "Plain Book", cover: "/books/plain-book/cover.jpg",
        pages: 4, hasVideo: false, authored: false },
    ]));
  await page.waitForFunction(() => window.Reader.state().shelfCount === 2);
  assert.equal(await page.locator("#shelfGrid .shelf-card.is-authored").count(), 1);
  const rims = await page.evaluate(() => [...document.querySelectorAll("#shelfGrid .shelf-card-button")]
    .map(el => getComputedStyle(el).borderColor));
  assert.match(rims[0], /222,\s*110,\s*75/, "the authored book wears the coral rim: " + rims[0]);
  assert.doesNotMatch(rims[1], /222,\s*110,\s*75/, "and a plain book does not: " + rims[1]);
  assert.equal(await page.locator("#shelfGrid .shelf-card").first()
    .evaluate(el => el.classList.contains("is-authored")), true);
  await ctx.close();
});
