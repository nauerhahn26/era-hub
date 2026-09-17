// reader-ui.test.mjs — Book Reader v2 e2e (the OLD Book-Reader UI ported onto
// the local package data layer; dad: "I like my old layout. Please match.").
// Spawns the REAL server.js on a scratch port with a throwaway ERA_DATA_DIR and
// the SYNTHETIC "Luna the Fox" fixture package (never real book content), then
// drives /reader/ with Playwright. Proves: the shelf renders the OLD layout
// (shelf-card grid, square covers, NO in-grid black rest cell — generous
// gutters are the drift protection — under the shared door bar, era-core's
// lib/doorbar.js: 🚪 leave and 💬 pause to talk, both holding 2x her dwell), a
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

// An 8-second 16x16 silent VP9-in-MP4 clip (ffmpeg -f lavfi color, 2fps, 6kbps;
// synthetic bytes, never family video). VP9 rather than H.264 because
// Playwright's Chromium ships no proprietary codecs, and MP4 rather than WebM
// because the hub's books jail serves .mp3/.mp4/.wav only (server.js
// BOOK_AV_EXTS). It is the per-page outro on page 1, so the 💬 has something
// playing to interrupt.
const MP4 = Buffer.from(
  "AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAABBm1kYXSCSYNCAADwAPYAOCQc" +
  "GEIAADBgAAAQv//9iyoAAIYAQJKcAElAAAMgAABCQIYAQJKcAErAAAMgAABCQIYAQJKcAEnAAAMg" +
  "AABCQIYAQJKcAEigAAMgAABCQIYAQJKcAEeAAAMgAABCQIYAQJKcAEbgAAMgAABCQIYAQJKcAEZA" +
  "AAMgAABCQIYAQJKcAEXAAAMgAABCQIYAQJKcAEVAAAMgAABCQIYAwJKcAEEAAAMgAABCQIYAQJKc" +
  "AETgAAMgAABCQIYAQJKcAERgAAMgAABCQIYAQJKcAEQAAAMgAABCQIYAQJKcAEOgAAMgAABCQIYA" +
  "QJKcAENAAAMgAABCQAAAA1Jtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAfQAABAAABAAAA" +
  "AAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAACAAACfXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAfQAAA" +
  "AAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAEAAAABAA" +
  "AAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAH0AAAAAAAAEAAAAAAfVtZGlhAAAAIG1kaGQAAAAA" +
  "AAAAAAAAAAAAAEAAAAIAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVv" +
  "SGFuZGxlcgAAAAGgbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAA" +
  "AAABAAAADHVybCAAAAABAAABYHN0YmwAAACoc3RzZAAAAAAAAAABAAAAmHZwMDkAAAAAAAAAAQAA" +
  "AAAAAAAAAAAAAAAAAAAAEAAQAEgAAABIAAAAAAAAAAEXTGF2YzYxLjMuMTAwIGxpYnZweC12cDkA" +
  "AAAAAAAAAAAY//8AAAAUdnBjQwEAAAAACoICAgIAAAAAAApmaWVsAQAAAAAQcGFzcAAAAAEAAAAB" +
  "AAAAFGJ0cnQAAAAAAAAXcAAAAP4AAAAYc3R0cwAAAAAAAAABAAAAEAAAIAAAAAAUc3RzcwAAAAAA" +
  "AAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAEAAAAAEAAABUc3RzegAAAAAAAAAAAAAAEAAA" +
  "AB0AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAA" +
  "DwAAAA8AAAAUc3RjbwAAAAAAAAABAAAALAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAA" +
  "AAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZm" +
  "NjEuMS4xMDA=",
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
  //   p0: words+audio (manifest timings)   p1: audio, NO words (interpolation),
  //                                            plus the outro VIDEO
  //   p2: textless + silent MIDDLE page (ready arrow IMMEDIATELY)
  //   p3: LAST page with audio (narration end -> book finished -> Library)
  const book = path.join(TMP, "books", "luna-the-fox");
  fs.mkdirSync(path.join(book, "pages"), { recursive: true });
  fs.mkdirSync(path.join(book, "audio"), { recursive: true });
  fs.mkdirSync(path.join(book, "video"), { recursive: true });
  fs.writeFileSync(path.join(book, "video", "002.mp4"), MP4);
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
      { index: 1, image: "pages/002.jpg", text: "The fox sleeps.", audio: "audio/002.wav",
        video: "video/002.mp4" },
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
// `opts.settings` overlays keys onto the hub's OWN /settings answer (dwellMs and
// her name stay real) — the one seam the 💬 needs, because pauseGoes is "tdsnap"
// only where a gaze engine answers the bus and this box has none.
// `opts.routes(ctx)` runs before the first navigation, for /kiosk/* stubs.
async function makePage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  await ctx.addInitScript(() => {
    window.__testHooks = true;                     // reader records highlights to __hlSeq
    window.__speakCalls = 0;
    if (window.speechSynthesis) {
      speechSynthesis.speak = () => { window.__speakCalls++; };
    }
  });
  // `opts.init` is one more init script, for a suite that needs a seam of its
  // own (the pulse test hooks setTimeout so five seconds can be turned by hand).
  if (opts.init) await ctx.addInitScript(opts.init);
  if (opts.settings) await settingsOverlay(ctx, opts.settings);
  if (opts.routes) await opts.routes(ctx);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/reader/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Reader && typeof window.Reader.state === "function");
  return { ctx, page };
}

async function settingsOverlay(ctx, over) {
  await ctx.route("**/settings", async (r) => {
    let base = {};
    try { base = await (await r.fetch()).json(); } catch {}
    await r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ...base, ...over }) });
  });
}
const state = (page) => page.evaluate(() => window.Reader.state());
const openLuna = async (page) => {
  await page.locator("#shelfGrid .shelf-card-button", { hasText: "Luna the Fox" }).click();
  await page.waitForFunction(() => window.Reader.state().screen === "sRead");
};

test("shelf: OLD layout — shelf-card grid, square cover, NO in-grid rest cell, and the shared door bar above it", async () => {
  const { ctx, page } = await makePage();
  const tile = page.locator("#shelfGrid .shelf-card-button.dwell").first();
  await tile.waitFor();
  assert.equal(await tile.locator(".shelf-title").textContent(), "Luna the Fox");
  assert.match(await tile.locator(".shelf-cover img").getAttribute("src"),
    /\/books\/luna-the-fox\/cover\.jpg\?v=[a-z0-9]+$/);   // ?v= cache-bust (8/25)
  // the OLD shelf's drift protection is its generous gutters — no black cells
  assert.equal(await page.locator("#shelfGrid .restCell").count(), 0, "no in-grid rest cell (old layout)");
  assert.equal(await page.locator("#rest").count(), 0, "no rest area anywhere (dad 8/25)");
  // THE EXIT TILE IS GONE (9/17): the door is the shared bar's 🚪, in the same
  // corner as every other app of hers, and it costs the shelf no slot.
  assert.equal(await page.locator(".shelf-tdsnap-button").count(), 0, "no exit tile on the shelf");
  assert.equal(await page.locator("#bar .msgbar #barDoor.dwell").count(), 1, "the bar's 🚪 is up");
  assert.equal((await state(page)).shelfCount, 1);
  await ctx.close();
});

// ONE bar, mounted once, above BOTH screens (spec §6.1) — so the door does not
// move when she opens a book, and the poll cannot rebuild it under her gaze.
test("the bar is the same strip on the shelf and inside a book, and the app sits under it", async () => {
  const { ctx, page } = await makePage();
  const geom = () => page.evaluate(() => {
    const bar = document.querySelector(".msgbar").getBoundingClientRect();
    const screen = document.querySelector(".screen.show").getBoundingClientRect();
    return { barTop: bar.top, barH: +bar.height.toFixed(2), screenTop: +screen.top.toFixed(2),
             barH_css: getComputedStyle(document.documentElement).getPropertyValue("--bar-h").trim(),
             doors: document.querySelectorAll(".msgbar .dwell").length };
  });
  await page.evaluate(() => { document.getElementById("barDoor").dataset.mark = "same"; });
  const shelf = await geom();
  assert.equal(shelf.barTop, 0, "the strip is the top of the screen");
  assert.ok(shelf.barH > 0 && shelf.barH <= 124, `a slim strip, got ${shelf.barH}`);
  assert.equal(shelf.barH_css, `${Math.round(shelf.barH)}px`, "--bar-h is published for the page's own chrome");
  assert.ok(Math.abs(shelf.screenTop - shelf.barH) < 1.5,
    `the shelf starts under the bar (${shelf.screenTop} vs ${shelf.barH})`);
  await openLuna(page);
  const read = await geom();
  assert.ok(Math.abs(read.screenTop - read.barH) < 1.5, "so does the book page");
  assert.equal(read.doors, shelf.doors, "the same doors, not a second set");
  assert.equal(await page.locator("#barDoor").getAttribute("data-mark"), "same",
    "the very same element — one bar for the whole app");
  // and the stage fits in what is left, instead of hanging off the bottom
  const over = await page.evaluate(() => {
    const st = document.querySelector(".reader-stage").getBoundingClientRect();
    return +(st.bottom - innerHeight).toFixed(2);
  });
  assert.ok(over <= 0.5, `the stage ends at the bottom of the screen, overshoot ${over}px`);
  await ctx.close();
});

// The 🚪 is silent glyph chrome now (the boards' door since 8/5, shared since
// 9/17): it is not NAMED for its destination any more, because the hub decides
// where it goes at the moment she uses it and the tile that carried the promise
// is gone. What is pinned is the behaviour — it POSTs /kiosk/exit exactly once
// and follows the hub's answer: "closed" = ERAgaze took the screen, stay put;
// anything else (or no hub) = New ERA's home.
test("🚪: silent chrome that POSTs /kiosk/exit and follows the answer (closed stays, home navigates)", async () => {
  const setExit = (v) => fetch(`${BASE}/settings`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exitTo: v }) });
  try {
    await setExit("home");
    const { ctx, page } = await makePage();
    const door = page.locator("#barDoor");
    assert.equal(await door.textContent(), "\u{1F6AA}", "the door is a glyph");
    assert.equal(await door.getAttribute("data-dwell-say"), "door", "silent chrome — it promises nothing");
    assert.equal(await door.getAttribute("aria-label"), "door");
    await door.click();                                   // live hub, no engine → home
    await page.waitForURL(/\/home\/?$/, { timeout: 8000 });
    await ctx.close();

    let hits = 0;
    const { ctx: c2, page: p2 } = await makePage({ routes: (c) =>
      c.route("**/kiosk/exit", (r) => { hits++;
        r.fulfill({ status: 200, contentType: "application/json", body: '{"action":"closed"}' }); }) });
    await p2.locator("#barDoor").click();
    await p2.waitForTimeout(300);
    assert.equal(hits, 1, "door POSTs /kiosk/exit exactly once");
    assert.match(p2.url(), /\/reader\//, "closed: the hub is closing the kiosk — no navigation");
    await c2.close();
  } finally { await setExit("tdsnap"); }
});

// DAD'S 9/17 RULING, on the one screen that used to carry a literal 2400: the
// two doors hold TWICE her Settings dwell and everything else holds her dwell
// exactly. No floors, no bonuses, no fixed numbers anywhere in this app.
test("both doors hold 2x her dwell, and nothing else in the Reader claims a hold at all", async () => {
  const setDwell = (ms) => fetch(`${BASE}/settings`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dwellMs: ms }) });
  try {
    for (const dwell of [900, 1500]) {
      await setDwell(dwell);
      const { ctx, page } = await makePage({ settings: { pauseGoes: "tdsnap" } });
      await page.waitForFunction((d) =>
        document.getElementById("barDoor").dataset.dwellMs === String(2 * d), dwell, { timeout: 5000 });
      assert.equal(await page.locator("#barTalk").getAttribute("data-dwell-ms"), String(2 * dwell),
        "the 💬 leaves the screen too — same consequence, same hold");
      // the shelf, its cards and the page's own controls carry NO literal hold
      assert.equal(await page.locator("[data-dwell-ms]:not(.bardoor)").count(), 0,
        "something outside the bar claims a hold of its own");
      await ctx.close();
    }
  } finally { await setDwell(1200); }
});

// THE BAR IS NOT THE READER'S (spec §5). This page restyles dwell.js's feedback
// into the old DwellButton look — the rising fill hidden, the ring turned into a
// coral conic progress arc that reader.js drives from the fill's height — and
// both rules used to be written `.dwell …`, which is every door on the shared
// strip too. The doors came out wearing the Reader's coral ring from the FIRST
// frame, past doorbar.css's ~200ms onset gate: a glance across 🚪/💬 flashed
// feedback that the very same glyphs suppress in her other four apps.
test("the bar's two doors wear era-core's feedback, not the Reader's: no conic ring, no mirrored progress, onset gate intact", async () => {
  const { ctx, page } = await makePage({ settings: { pauseGoes: "tdsnap" } });
  await page.locator("#barTalk").waitFor();
  // dwell.js's own fx markup, driven the way the engine drives it (it sets the
  // fill's HEIGHT every frame — that style mutation is reader.js's mirror hook)
  const probe = (sel) => page.evaluate(async (s) => {
    const host = document.querySelector(s);
    const fx = document.createElement("div"); fx.className = "dwell-fx";
    const fill = document.createElement("div"); fill.className = "dwell-fill";
    const ring = document.createElement("div"); ring.className = "dwell-ring";
    fx.appendChild(fill); fx.appendChild(ring); host.appendChild(fx);
    fill.style.height = "40%";
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const cf = getComputedStyle(fill), cr = getComputedStyle(ring);
    const out = { progress: host.style.getPropertyValue("--dwell-progress"),
                  fillOpacity: cf.opacity, ringBg: cr.backgroundImage };
    host.classList.add("dwell-active");            // what the engine adds on arm
    await new Promise(r => requestAnimationFrame(r));
    out.onset = getComputedStyle(fill).animationName;
    host.classList.remove("dwell-active"); fx.remove();
    return out;
  }, sel);

  const door = await probe("#barDoor");
  assert.equal(door.progress, "", "the Reader never mirrors gaze progress onto a door");
  assert.equal(door.ringBg.includes("conic-gradient"), false,
    "no coral progress arc on the 🚪: " + door.ringBg);
  assert.notEqual(door.fillOpacity, "0",
    "doorbar.css's fill governs the bar — the Reader's blanket opacity:0 beat it outright");
  assert.equal(door.onset, "dwellOnset",
    "…so the ~200ms onset gate is back: a glance across the door flashes nothing");

  // …and the app's own targets are untouched: the old DwellButton look stands
  const card = await probe("#shelfGrid .shelf-card-button.dwell");
  assert.equal(card.progress, "144.0deg", "the Reader's ring still tracks the engine (40% -> 144deg)");
  assert.equal(card.fillOpacity, "0", "…with the rising fill still hidden under it");
  assert.equal(card.ringBg.includes("conic-gradient"), true, card.ringBg);
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

// ======================================================= 💬 PAUSE TO TALK (9/17)
// She is mid-book and wants to SAY something. The 💬 pauses the story IN PLACE
// (the 🚪 would stop it dead and leave), POSTs /kiosk/pause with this app's own
// path so her tile can find the same kiosk again, and does nothing more — the
// window is about to go under her talker. When TD Snap hands the screen back the
// page gets a visibilitychange and picks the page up: a clip carries on, a
// narration starts the page again from the top (spec §6 — a half-read sentence
// is not a place a child wants to resume at).
async function talkPage(opts = {}) {
  const pauses = [];
  const answer = opts.answer || { status: 200, body: '{"action":"paused"}' };
  const r = await makePage({
    settings: { pauseGoes: "tdsnap", ...(opts.settings || {}) },
    // opts.timers: record every setTimeout the page arms, so the ready-arrow's
    // five seconds can be fired by hand — and, crucially, so a test can fire
    // ONLY the ones armed after a given moment (the same stale-closure trap the
    // shelf's __timers hook has: re-firing the timer from BEFORE the pause would
    // paint the pulse the resume was supposed to re-arm).
    init: opts.timers ? (() => {
      window.__timers = [];
      const st = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms) => { window.__timers.push({ fn, ms }); return st(fn, ms); };
    }) : undefined,
    routes: (c) => c.route("**/kiosk/pause", (route) => {
      pauses.push({ raw: route.request().postData() || "",
                    json: (() => { try { return JSON.parse(route.request().postData() || ""); } catch { return null; } })() });
      route.fulfill({ status: answer.status, contentType: "application/json", body: answer.body });
    }),
  });
  // Use the 💬 and WAIT FOR THE HUB TO ANSWER: the bar arms its "she is coming
  // back" latch on that reply, so a hand-back dispatched before it lands is one
  // the bar is right to ignore (and a flaky test, 9/17).
  const talk = async () => {
    const answered = r.page.waitForResponse((res) => res.url().includes("/kiosk/pause"));
    await r.page.locator("#barTalk").click();
    await answered;
  };
  // TD Snap gives the screen back: the launcher's /kiosk/resume line
  // re-foregrounds this kiosk, and the page hears a visibilitychange.
  const handBack = () => r.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  // how many timers have been armed so far, and "fire the ms-second ones armed
  // since then" — never the whole list (see init above)
  const armed = () => r.page.evaluate(() => window.__timers.length);
  const fireSince = (since, ms) => r.page.evaluate(
    ({ since, ms }) => { for (const t of window.__timers.slice(since)) if (t.ms === ms) t.fn(); },
    { since, ms });
  return { ...r, pauses, talk, handBack, armed, fireSince };
}

test("💬 exists only where there is a talker to step out to", async () => {
  const { ctx, page } = await makePage({ settings: { pauseGoes: "home" } });
  assert.equal(await page.locator("#barTalk").count(), 1, "the door is built either way");
  assert.equal(await page.locator("#barTalk").isVisible(), false,
    "…and stays hidden on a PC with no gaze engine — the bar looks exactly as it did before 9/17");
  assert.equal(await page.locator("#barDoor").isVisible(), true, "the 🚪 never hides");
  await ctx.close();

  const t = await makePage({ settings: { pauseGoes: "tdsnap" } });
  assert.equal(await t.page.locator("#barTalk").isVisible(), true, "her talker is there: the 💬 is up");
  await t.ctx.close();
});

test("💬 mid-narration: the story stops WHERE SHE IS, /kiosk/pause carries /reader/, and coming back re-reads the page", async () => {
  const { ctx, page, pauses, talk, handBack } = await talkPage();
  await openLuna(page);
  await page.waitForFunction(() => window.Reader.state().audioTime > 0.7, null, { timeout: 8000 });
  await talk();
  await page.waitForFunction(() => window.Reader.state().audio === "paused", null, { timeout: 3000 });
  const s = await state(page);
  assert.ok(s.audioTime > 0.6, `the 💬 is not the 🚪: narration keeps her place (t=${s.audioTime})`);
  assert.equal(s.page, 0, "and her page");
  assert.equal(s.screen, "sRead", "…and the book is still open behind her talker");
  await page.waitForTimeout(200);
  assert.equal(pauses.length, 1, "one pause, POSTed once");
  assert.deepEqual(pauses[0].json, { path: "/reader/" },
    "the path her tile will ask to resume: " + pauses[0].raw);
  assert.match(page.url(), /\/reader\//, "paused: the hub is minimizing this kiosk — no navigation");

  await handBack();
  await page.waitForFunction((was) => {
    const st = window.Reader.state();
    return st.audio === "playing" && st.audioTime < was;
  }, s.audioTime, { timeout: 5000 });
  assert.equal((await state(page)).page, 0, "the same page she left — never a fresh book");
  assert.equal(await page.evaluate(() => window.__speakCalls), 0, "still no speechSynthesis");
  await ctx.close();
});

test("💬 mid-outro: the clip pauses and carries on from where it stopped", async () => {
  const { ctx, page, talk, handBack } = await talkPage();
  await openLuna(page);
  await page.locator("#btnNext").click();                    // -> page 1, the page with the video
  await page.waitForFunction(() => window.Reader.state().arrow === true, null, { timeout: 12000 });
  await page.locator("#btnNext").click();                    // her arrow starts the outro
  await page.waitForFunction(() => {
    const v = document.getElementById("pageVideo");
    return window.Reader.state().videoShowing && !v.paused && v.currentTime > 0.2;
  }, null, { timeout: 8000 });

  await talk();
  const paused = await page.evaluate(() => {
    const v = document.getElementById("pageVideo");
    return { paused: v.paused, t: v.currentTime, src: !!v.getAttribute("src") };
  });
  assert.equal(paused.paused, true, "the clip stopped");
  assert.equal(paused.src, true, "…and was NOT torn down: she is coming back to it");
  assert.ok(paused.t > 0.1, `it kept its place (t=${paused.t})`);
  assert.equal((await state(page)).videoShowing, true, "the page did not turn under the pause");

  await handBack();
  await page.waitForFunction((was) => {
    const v = document.getElementById("pageVideo");
    return !v.paused && v.currentTime >= was;
  }, paused.t, { timeout: 5000 });
  assert.equal((await state(page)).page, 1, "still her page");
  await ctx.close();
});

// She must never be left silent AND on screen (spec §5): a hub that answers
// anything but "paused" means there is nothing to step out to, so the 💬 IS the
// 🚪 — stop the story and take the hub's exit answer.
test("💬 with nothing to step out to falls through to the 🚪", async () => {
  const { ctx, page } = await talkPage({ answer: { status: 200, body: '{"action":"home"}' } });
  await openLuna(page);
  await page.waitForFunction(() => window.Reader.state().audioTime > 0.2, null, { timeout: 8000 });
  await page.locator("#barTalk").click();
  await page.waitForURL(/\/home\/?$/, { timeout: 8000 });    // live hub, no engine → home
  await ctx.close();
});

// She stepped out with the big ready-arrow waiting for her. pauseMedia() clears
// its pulse — an arrow must not pulse at a screen she is not looking at — and
// nothing used to put it back: the page she had finished came back with a still
// arrow and the old reader's gentle nudge was gone until she turned the page.
test("💬 with the ready-arrow waiting: the pulse comes back with her", async () => {
  const { ctx, page, talk, handBack, armed, fireSince } = await talkPage({ timers: true });
  await openLuna(page);
  await page.waitForFunction(() => window.Reader.state().arrow === true, null, { timeout: 12000 });
  const pulse = page.locator("#btnNext.reader-next-button-pulse");
  await fireSince(0, 5000);                                  // the nudge, without five real seconds
  assert.equal(await pulse.count(), 1, "the arrow is pulsing at her before she steps out");

  await talk();
  assert.equal(await pulse.count(), 0, "no arrow pulsing at a screen she is not looking at");
  const mark = await armed();                                // only timers armed AFTER this count

  await handBack();
  assert.equal((await state(page)).arrow, true, "the arrow is still hers to press");
  await fireSince(mark, 5000);
  assert.equal(await pulse.count(), 1, "…and the nudge was armed again when she came back");
  await ctx.close();
});

// The 💬 pressed while SHE had already stopped the story (the Read/Pause pill).
// There is nothing to restart — but the page has to come back exactly as she
// left it. Clearing S.paused flipped the pill to "Ready to read" over narration
// still sitting mid-page, and toggleRead's resume branch stopped matching: her
// next Read threw away the place she had stopped at on purpose.
test("💬 while she is already paused hands her pause back, and Read carries on from it", async () => {
  const { ctx, page, talk, handBack } = await talkPage();
  await openLuna(page);
  await page.waitForFunction(() => window.Reader.state().audioTime > 0.7, null, { timeout: 8000 });
  await page.locator("#btnRead").click();                    // her own Pause, mid-page
  await page.waitForFunction(() => window.Reader.state().audio === "paused", null, { timeout: 3000 });
  const t0 = (await state(page)).audioTime;
  assert.ok(t0 > 0.6, `she stopped part-way through (t=${t0})`);
  assert.match(await page.locator("#pageMeta").textContent(), /Paused/);

  await talk();
  await handBack();
  await page.waitForTimeout(200);
  const s = await state(page);
  assert.equal(s.audio, "paused", "the 💬 never starts the story she stopped herself");
  assert.ok(Math.abs(s.audioTime - t0) < 0.01, `…and never moves it (t=${s.audioTime} vs ${t0})`);
  assert.equal(s.page, 0, "her page");
  assert.match(await page.locator("#pageMeta").textContent(), /Paused/,
    "the pill still says Paused — it is her pause, not a fresh page");
  assert.equal(await page.locator("#btnReadLabel").textContent(), "Read");

  await page.locator("#btnRead").click();                    // and Read carries on, never restarts
  const t1 = await page.evaluate(() => document.getElementById("narration").currentTime);
  assert.ok(t1 >= t0 - 0.05, `Read resumed where she stopped (t=${t1} vs ${t0})`);
  await page.waitForFunction(() => window.Reader.state().audio === "playing", null, { timeout: 5000 });
  await ctx.close();
});

// The bar arms its "she is coming back" latch on the hub's `paused` answer, so a
// visibilitychange with NO pause pending is an alt-tab (or a QA VM's window
// manager), not TD Snap handing the screen back. It must change nothing at all.
test("a visibilitychange with no pause pending is an alt-tab, and changes nothing", async () => {
  const kiosk = [];
  const { ctx, page } = await makePage({
    settings: { pauseGoes: "tdsnap" },
    routes: (c) => c.route("**/kiosk/**", (r) => { kiosk.push(r.request().url());
      r.fulfill({ status: 200, contentType: "application/json", body: '{"action":"paused"}' }); }),
  });
  await openLuna(page);
  await page.waitForFunction(() => window.Reader.state().audioTime > 0.5, null, { timeout: 8000 });
  await page.locator("#btnRead").click();                    // her own pause; the 💬 was never used
  await page.waitForFunction(() => window.Reader.state().audio === "paused", null, { timeout: 3000 });
  const before = await state(page);

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(250);
  const after = await state(page);
  assert.equal(after.audio, "paused", "nothing started playing under her");
  assert.ok(Math.abs(after.audioTime - before.audioTime) < 0.01, "her place is where she left it");
  assert.equal(after.page, before.page, "and her page");
  assert.match(await page.locator("#pageMeta").textContent(), /Paused/, "still Paused");
  assert.equal(kiosk.length, 0, "no /kiosk/* traffic at all: " + kiosk.join(", "));
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
  if (opts.settings) await settingsOverlay(ctx, opts.settings);
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
// makes every card again — every book she could have been about to open — and
// era-core/dwell.js tracks
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
  // The nodes her gaze may be resting on when the poll comes round. The door is
  // one of them and is no longer ON the shelf (9/17) — it is marked here too,
  // because a repaint must not reach it at all now.
  await page.evaluate(() => {
    document.getElementById("barDoor").dataset.mark = "same";
    document.querySelector("#shelfGrid .shelf-card-button").dataset.mark = "same";
  });

  await tick(); await tick();
  assert.equal(await page.locator("#shelfGrid .shelf-card-button").getAttribute("data-mark"), "same",
    "the book she was about to open was replaced under her gaze while nothing had changed");
  assert.equal(await page.evaluate(() => window.Reader.state().buildingCount), 1,
    "…and it would have gone on doing it for the whole session");

  // …and a card whose words really did change still repaints, settling her gaze
  // afterwards the way every other render in this app does (D51).
  live.status = contentStatus({ jobs: [{ ...job, held: null, state: "transcribing",
    progress: { pages: 16, transcribed: 9, narrated: 0 } }] });
  await tick();
  await page.locator("#shelfGrid .shelf-card.is-building", { hasText: "9 of 16 pages read" }).waitFor();
  assert.equal(await page.locator("#shelfGrid .shelf-card-button").getAttribute("data-mark"), null,
    "a real change repaints");
  assert.equal(await page.locator("#barDoor").getAttribute("data-mark"), "same",
    "…and never the door: it lives above the shelf, out of the repaint's way");
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

test("while the ask is open the shelf is asleep — no live dwell target, BOTH doors included", async () => {
  const { ctx, page } = await shelfWith(contentStatus({ jobs: [pileRow()] }),
    JSON.stringify([{ slug: "luna-the-fox", title: "Luna the Fox",
      cover: "/books/luna-the-fox/cover.jpg", pages: 4, hasVideo: false, authored: true }]),
    { settings: { pauseGoes: "tdsnap" } });                // …with the 💬 up too
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  await page.locator("#barTalk").waitFor();
  await page.locator("#shelfGrid .shelf-card.is-pile .shelf-build-button").click();
  await page.locator("#shelfAsk").waitFor();
  assert.equal(await page.locator("#sShelf .dwell:not([data-dwell-disabled])").count(), 0,
    "a parked gaze could still fire the shelf behind the question");
  // the two doors are the highest-consequence holds in the app, and unlike the
  // board's door they are NOT kept awake under this one
  assert.equal(await page.locator(".msgbar .dwell:not([data-dwell-disabled])").count(), 0,
    "a parked gaze could still fire a door over the question");
  for (const id of ["#barDoor", "#barTalk"]) {
    assert.equal(await page.locator(id).getAttribute("data-dwell-disabled"), "", id + " stays armed");
    assert.equal(await page.locator(id).evaluate(el => el.classList.contains("dwell")), false,
      "the class goes too — dwell.js's 150ms tap-rescue matches .dwell alone (" + id + ")");
  }
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
  assert.equal(await page.locator("#barDoor").evaluate(el => el.classList.contains("dwell")), true);
  assert.equal(await page.locator("#barDoor").getAttribute("data-dwell-disabled"), null,
    "the shelf she can use, and the door out of it, are handed back");
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
  assert.equal(await page.locator("#barDoor").evaluate(el => el.classList.contains("dwell")), true,
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
  assert.equal(await page.locator("#barDoor").evaluate(el => el.classList.contains("dwell")), true,
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
  await page.evaluate(() => { document.querySelector("#shelfGrid .shelf-card-button").dataset.mark = "same"; });
  // a real change: one more photo landed in the pile while the question was up
  st = contentStatus({ jobs: [pileRow({ progress: { pages: 13, transcribed: 0, narrated: 0 } })] });
  await tick();
  await page.locator("#shelfGrid .shelf-card.is-pile", { hasText: "13 photos" }).waitFor();
  assert.equal(await page.locator("#shelfGrid .shelf-card-button").getAttribute("data-mark"), null,
    "the shelf really was rebuilt");
  await page.locator("#shelfAsk").waitFor();
  assert.match(await page.locator("#shelfAsk").textContent(), /13 photos/,
    "the question came back over the card it belongs to");
  assert.equal(await page.locator("#sShelf .dwell:not([data-dwell-disabled])").count(), 0,
    "a rebuilt shelf under an open ask is awake again unless the freeze is asked for a second time");
  await page.locator("#shelfAskNo").click();
  await page.waitForFunction(() => !document.getElementById("shelfAsk"));
  assert.equal(await page.locator("#barDoor").evaluate(el => el.classList.contains("dwell")), true,
    "…and the door the repaint left frozen is awake again with it");
  await ctx.close();
});

// THE QUESTION'S CARD CAN ALSO GO AWAY. The build finishes (or another computer
// takes the pile) while the ask is up, and the row leaves /content/status: the
// repaint has no card to paint the question over. Dropping S.asking on the floor
// was invisible before the bar — every frozen node was a shelf node the repaint
// had already destroyed — but the strip is mounted ONCE and lives through every
// repaint, so both doors stayed stamped data-dwell-disabled with .dwell removed
// for ever: she was left on the shelf with no way off it and no way to ask to
// talk. The question must be CLOSED, which is the only thing that thaws.
test("a build that finishes under the ask closes it — and never leaves her doors dead", async () => {
  let st = contentStatus({ jobs: [pileRow()] });
  const { ctx, page, tick } = await shelfWith(() => st,
    JSON.stringify([{ slug: "luna-the-fox", title: "Luna the Fox",
      cover: "/books/luna-the-fox/cover.jpg", pages: 4, hasVideo: false, authored: true }]),
    { settings: { pauseGoes: "tdsnap" } });                  // …with the 💬 up too
  await page.waitForFunction(() => window.Reader.state().buildingCount === 1);
  await page.locator("#barTalk").waitFor();
  await page.locator("#shelfGrid .shelf-card.is-pile .shelf-build-button").click();
  await page.locator("#shelfAsk").waitFor();
  assert.equal(await page.locator(".msgbar .dwell:not([data-dwell-disabled])").count(), 0,
    "both doors are asleep under the question");

  // the pile is a book now: the row is gone from the hub's answer
  st = contentStatus({ jobs: [] });
  await tick();
  await page.waitForFunction(() => window.Reader.state().buildingCount === 0);
  await page.waitForFunction(() => !document.getElementById("shelfAsk"));
  assert.equal((await state(page)).asking, null, "the question is closed, not merely forgotten");
  assert.equal(await page.locator(".msgbar .dwell").count(), 2, "the strip still carries two doors");
  assert.equal(await page.locator(".msgbar .dwell:not([data-dwell-disabled])").count(), 2,
    "…and BOTH of them are hers again");
  for (const id of ["#barDoor", "#barTalk"]) {
    assert.equal(await page.locator(id).getAttribute("data-dwell-disabled"), null,
      id + " is still stamped disabled — she cannot leave and cannot ask to talk");
    assert.equal(await page.locator(id).evaluate(el => el.classList.contains("dwell")), true,
      "the class comes back too — dwell.js's 150ms tap-rescue matches .dwell alone (" + id + ")");
  }
  assert.ok(await page.evaluate(() => window.Dwell.state().suppressedMs) > 0,
    "closing under her gaze settles it, like every other close");
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
