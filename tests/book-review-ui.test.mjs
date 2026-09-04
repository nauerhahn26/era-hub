// book-review-ui.test.mjs — the review page (plan T3.2 + T3.3, spec §5): every
// page in the order text.json keeps them, drag to reorder, tap to mark the
// cover, and then the per-page controls a parent actually came here for — the
// flagged words picked out, an inline field to fix them, "Re-narrate this page"
// and "Clear flag". A real browser drives it, because a drag is the whole
// feature and a DOM assertion about a drag that never happened proves nothing.
//
// PORTS: 8435 (the real server.js) + 8440 (the provider stand-in below).
// 8440 is the free slot between the plan's 8439 (fal hub) and 8441 (fake fal);
// this suite claims it so the money guardrail can be an assertion rather than
// a hope.
//
// MONEY GUARDRAIL (plan §B.2, Gap 20): the hub is spawned with its own mkdtemp
// ERA_DATA_DIR, so the gate's real ElevenLabs credential is nowhere near this
// suite, AND every provider seam (ERA_AI_URL, ERA_ELEVEN_URL, ERA_FAL_URL) is
// pointed at one local stand-in that records every request it is handed.
// Re-narrating is the one thing on this page that spends the family's money, so
// the count is asserted twice: nothing at all is bought up to the point the
// voice is set up, and after it exactly ONE page is bought — never the book.
// Playwright also routes **/tts* so a page that grew a second narration path
// could not reach one either. There is no key in this file (the stand-in's is
// assembled at runtime) and no key file on this machine is read.
//
// A VIDEO of the page working: set ERA_REVIEW_VIDEO=<dir> and the drag test and
// the re-narrate test each record themselves there as .webm (that is how the
// task's recordings were made). Unset — the gate — nothing is recorded and
// nothing costs anything.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const PORT = 8435;
const FAKE = 8440;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-book-review-"));
const DATA = path.join(TMP, "data");
// What Google Drive for Windows shows the family; the hub builds in place here.
const FOLDER = path.join(TMP, "My Drive", "New ERA Content");
const BOOKS = path.join(FOLDER, "books");
const VIDEO = process.env.ERA_REVIEW_VIDEO || null;

const store = require("./content-store.js");
const publish = require("./content-publish.js");
const { encodeJpg } = require("./image-util.js");

// Assembled at runtime, never written as a literal: era-scan treats an `sk_…`
// run in a tracked file as a fatal secret hit, and a fixture that looks like a
// key is indistinguishable from one that is.
const FAKE_KEY = ["sk", "_", "bookreview", "0".repeat(24)].join("");
const VOICE = "cgSgspJ2msm6clMCkdW9";
// What the transcriber writes when a model could not read a word
// (content-providers.FLAG_UNSURE) — the sentence a parent meets on this page.
const UNSURE = "the model was not sure of this word";
// "ID3" and junk: the stand-in's mp3. Never a real recording.
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x21]);

let child, fake, browser;
// One entry per request the stand-in actually saw, on ANY seam. Nothing resets
// it — the money guardrails read the whole suite's history off it.
let calls = [];

// A real (tiny) JPEG per page, in its own colour: the strip shows these in an
// <img>, and a browser will not paint a blob of zeroes. Never a real photo.
function jpg(index) {
  const w = 48, h = 64, data = Buffer.alloc(w * h * 4);
  const hue = [[214, 90, 70], [70, 150, 190], [230, 190, 80], [120, 180, 120]][(index - 1) % 4];
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = hue[0]; data[i * 4 + 1] = hue[1]; data[i * 4 + 2] = hue[2]; data[i * 4 + 3] = 255;
  }
  return encodeJpg({ data, width: w, height: h }, 80);
}

// A book part-way through the pipeline: pages/ on disk, text.json beside it,
// and (once published) a manifest. `texts` is the reading order, one-based like
// content-ingest.js numbers them. One short made-up line per page — never real
// book content.
// `o.flags` is keyed by the page's one-based index: {2:["mat"]} is "the model
// was not sure of `mat` on page two", which is exactly what the transcriber
// leaves behind for this page to show.
function book(name, texts, opts) {
  const o = opts || {};
  const dir = path.join(BOOKS, name);
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  const pages = [];
  texts.forEach((t, i) => {
    const index = i + 1, pad = String(index).padStart(3, "0");
    fs.writeFileSync(path.join(dir, "pages", pad + ".jpg"), jpg(index));
    pages.push({ index, source: "sources/IMG_000" + index + ".jpg", text: t,
                 flags: ((o.flags || {})[index] || []).map(w => ({ word: w, reason: UNSURE })),
                 cover: index === 1 });
  });
  store.writeText(dir, { pages });
  store.writeJob(dir, { ...store.newJob({ claimedBy: "test:1" }), state: o.state || "published" });
  if (o.publish !== false) publish.publishBook(dir, { slug: o.slug, title: name });
  return dir;
}

const textOf = (name) => store.readText(path.join(BOOKS, name)).pages;
const orderOf = (name) => textOf(name).map(p => p.index);
const manifestOf = (name) =>
  JSON.parse(fs.readFileSync(path.join(BOOKS, name, "manifest.json"), "utf8"));

const post = (body) => fetch(`${BASE}/content/text`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(BOOKS, { recursive: true });
  fs.writeFileSync(path.join(DATA, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: FOLDER }));
  // Anything that reaches a provider lands here instead, and is recorded. It
  // answers exactly ONE shape — ElevenLabs' with-timestamps reply, the only
  // provider call this page can make — and 500s everything else, so a seam this
  // suite did not expect to be used is loud rather than silently satisfied.
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      calls.push({ url: req.url, key: req.headers["xi-api-key"] || null,
                   text: (parsed && parsed.text) || null });
      if (!/\/with-timestamps/.test(req.url)) { res.writeHead(500).end("{}"); return; }
      // 0.1 s per character, so a word's timings can be worked out by hand.
      const chars = [...((parsed && parsed.text) || "")];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        audio_base64: MP3.toString("base64"),
        alignment: {
          characters: chars,
          character_start_times_seconds: chars.map((_, i) => i * 0.1),
          character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
        },
      }));
    });
  });
  await new Promise(r => fake.listen(FAKE, "127.0.0.1", r));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1",
           ERA_AI_URL: `http://127.0.0.1:${FAKE}`,
           ERA_ELEVEN_URL: `http://127.0.0.1:${FAKE}`,
           ERA_FAL_URL: `http://127.0.0.1:${FAKE}` },
  });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/content/status`); up = true; break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!up) throw new Error("server never came up");
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (child) child.kill("SIGKILL");
  if (fake) fake.close();
});

async function review(slug, opts) {
  const o = opts || {};
  // Tall enough that a four-page book's last card is ON the screen: page.mouse
  // works in viewport coordinates, so a grip below the fold is a drag that
  // silently does nothing (which is exactly how this suite first "passed").
  const ctx = await browser.newContext({
    viewport: { width: 1100, height: 1000 }, hasTouch: true,
    ...(o.video && VIDEO ? { recordVideo: { dir: VIDEO, size: { width: 1100, height: 1000 } } } : {}),
  });
  // ERAgaze lives on 127.0.0.1:49155 on the family PC; here nothing answers.
  await ctx.route("http://127.0.0.1:49155/**", r => r.abort());
  // Gap 20, belt and braces: no browser on this page may reach a voice.
  await ctx.route("**/tts*", r => r.abort());
  const page = await ctx.newPage();
  await page.goto(`${BASE}/book-review/?slug=${slug}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("#strip .page").length > 0);
  return { ctx, page };
}

// The strip as a parent reads it: the position label, the page's own text, and
// which one wears the cover star.
const strip = (page) => page.$$eval("#strip .page", els => els.map(el => ({
  index: Number(el.dataset.index),
  no: el.querySelector(".no").textContent.trim(),
  text: el.querySelector(".txt").textContent.trim(),
  cover: el.querySelector(".cover").getAttribute("aria-pressed") === "true",
})));

// Drag the grip of the card at `from` onto the card at `to`, in steps, the way
// a hand does it — one jump lands on no card at all and reorders nothing.
async function dragPage(page, from, to) {
  const grip = (n) => page.locator(`#strip .page:nth-child(${n}) .grip`);
  const box = async (n) => (await grip(n).boundingBox());
  const a = await box(from), b = await box(to);
  const h = page.viewportSize().height;
  for (const r of [a, b])
    assert.ok(r.y >= 0 && r.y + r.height <= h,
      "both handles must be on the screen or the mouse never reaches them");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + a.width / 2,
                          a.y + a.height / 2 + (b.y - a.y) * (i / steps), { steps: 1 });
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
}

// ------------------------------------------------------------------ the strip

test("the strip shows every page in the order text.json keeps them", async () => {
  book("Tabby McTat", ["The cat sat", "on the mat", "and then", "the end"]);
  const { ctx, page } = await review("tabby-mctat");
  const rows = await strip(page);
  assert.deepEqual(rows.map(r => r.index), [1, 2, 3, 4]);
  assert.deepEqual(rows.map(r => r.text),
    ["The cat sat", "on the mat", "and then", "the end"]);
  // The number a parent reads is the POSITION in the book, not the index the
  // scanner gave the photo — after a drag those two stop agreeing, and the
  // position is the one that means anything to them.
  assert.deepEqual(rows.map(r => r.no), ["Page 1", "Page 2", "Page 3", "Page 4"]);
  // Every card shows its own photo, served from the book folder itself: the
  // Drive mirror runs every ten minutes and a book being reviewed is usually
  // newer than that.
  const srcs = await page.$$eval("#strip .page img", els => els.map(e => e.getAttribute("src")));
  assert.equal(srcs.length, 4);
  assert.match(srcs[0], /\/content\/page\?.*index=1/);
  const img = await fetch(`${BASE}${srcs[0]}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  await ctx.close();
});

test("nothing on this page is a gaze target", async () => {
  book("Quiet Book", ["one", "two"]);
  const { ctx, page } = await review("quiet-book");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".dwell").length), 0);
  assert.equal(await page.evaluate(() => typeof window.dwell), "undefined");
  await ctx.close();
});

test("dragging the last page to the top writes the new order, and a reload shows it", async () => {
  book("Mixed Up", ["one", "two", "three", "four"]);
  const { ctx, page } = await review("mixed-up", { video: true });
  await dragPage(page, 4, 1);
  await page.waitForFunction(() => document.getElementById("strip").dataset.saved === "1");
  // On the screen, straight away.
  const rows = await strip(page);
  assert.deepEqual(rows.map(r => r.index), [4, 1, 2, 3]);
  assert.deepEqual(rows.map(r => r.text), ["four", "one", "two", "three"]);
  assert.deepEqual(rows.map(r => r.no), ["Page 1", "Page 2", "Page 3", "Page 4"]);
  // On disk: the array order IS the reading order, and the index stays welded
  // to the photo (and to the audio and flags that were bought for it).
  assert.deepEqual(orderOf("Mixed Up"), [4, 1, 2, 3]);
  assert.deepEqual(textOf("Mixed Up").map(p => p.text), ["four", "one", "two", "three"]);
  assert.deepEqual(textOf("Mixed Up").map(p => p.source),
    ["sources/IMG_0004.jpg", "sources/IMG_0001.jpg",
     "sources/IMG_0002.jpg", "sources/IMG_0003.jpg"]);
  // And after a reload, because a parent who comes back tomorrow must not find
  // the book back the way the scanner left it.
  if (VIDEO) await page.waitForTimeout(900);        // let the recording show "Saved ✓"
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("#strip .page").length === 4);
  assert.deepEqual((await strip(page)).map(r => r.index), [4, 1, 2, 3]);
  if (VIDEO) await page.waitForTimeout(1200);       // …and the book after the reload
  await ctx.close();
});

test("a published book is re-published, so the shelf follows the new order", async () => {
  book("On The Shelf", ["one", "two", "three"]);
  assert.deepEqual(manifestOf("On The Shelf").pages.map(p => p.text), ["one", "two", "three"]);
  const { ctx, page } = await review("on-the-shelf");
  await dragPage(page, 3, 1);
  await page.waitForFunction(() => document.getElementById("strip").dataset.saved === "1");
  // The re-publish runs behind a 202, exactly as Settings' "start this book"
  // does — so wait for the manifest to catch up rather than for the response.
  let m;
  for (let i = 0; i < 100; i++) {
    m = manifestOf("On The Shelf");
    if (m.pages[0].text === "three") break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.deepEqual(m.pages.map(p => p.text), ["three", "one", "two"]);
  // The image goes with its page: page 3's photo is now the first page.
  assert.equal(m.pages[0].image, "pages/003.jpg");
  await ctx.close();
});

// ------------------------------------------------------------------ the cover

test("exactly one page is the cover, and tapping another moves it", async () => {
  book("Cover Story", ["one", "two", "three"]);
  const { ctx, page } = await review("cover-story");
  assert.deepEqual((await strip(page)).map(r => r.cover), [true, false, false]);
  await page.locator("#strip .page:nth-child(3) .cover").click();
  await page.waitForFunction(() => document.getElementById("strip").dataset.saved === "1");
  assert.deepEqual((await strip(page)).map(r => r.cover), [false, false, true]);
  const pages = textOf("Cover Story");
  assert.deepEqual(pages.map(p => p.cover), [false, false, true]);
  assert.equal(pages.filter(p => p.cover).length, 1);
  // The order was not touched by a cover tap.
  assert.deepEqual(pages.map(p => p.index), [1, 2, 3]);
  await ctx.close();
});

// ------------------------------------------------------- the write, on its own

test("a write that is not this book's pages is refused rather than half-applied", async () => {
  book("Careful", ["one", "two", "three"]);
  const bad = [
    { slug: "careful", order: [1, 2] },                 // a page dropped
    { slug: "careful", order: [1, 2, 3, 4] },           // a page invented
    { slug: "careful", order: [1, 2, 2] },              // a page twice
    { slug: "careful", order: [1, 2, "3"] },            // not an index
    { slug: "careful", order: [1, 2, 3], cover: 9 },    // a cover that is not a page
    { slug: "no-such-book", order: [1] },
    { order: [1, 2, 3] },
  ];
  for (const b of bad) {
    const r = await post(b);
    assert.equal(r.status, 400, JSON.stringify(b) + " should be refused");
    assert.ok((await r.json()).error, "a refusal says why");
  }
  assert.equal((await post("{not json")).status, 400);
  // Not one of them moved a page or a cover.
  assert.deepEqual(orderOf("Careful"), [1, 2, 3]);
  assert.deepEqual(textOf("Careful").map(p => p.cover), [true, false, false]);
});

test("a body far bigger than any book's order is dropped on the floor", async () => {
  await assert.rejects(() => post(JSON.stringify(
    { slug: "careful", order: [1, 2, 3], pad: "x".repeat(200000) })));
});

test("with Drive not in local mode there is nothing to reorder and the page says so", async () => {
  const drive = path.join(DATA, "drive.json");
  fs.writeFileSync(drive, JSON.stringify({ mode: "api", folderId: "F0", token: { refresh_token: "x" } }));
  try {
    const r = await post({ slug: "careful", order: [1, 2, 3] });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, "needs-local-drive");
    const g = await fetch(`${BASE}/content/text?slug=careful`);
    assert.equal(g.status, 409);
  } finally {
    fs.writeFileSync(drive, JSON.stringify({ mode: "local", folderPath: FOLDER }));
  }
});

// ------------------------------------------------- the per-page controls (T3.3)
//
// What a parent came to this page for: the words the model was unsure of picked
// out of the page's own text, a field to fix them in, a button to buy that one
// page's narration again, and a button to say "that word is fine as it is".

// The words the page has picked out on card `n`, and the whole line they sit in.
const marksOn = (page, n) =>
  page.$$eval(`#strip .page:nth-child(${n}) .txt mark`, els => els.map(e => e.textContent));

test("the words the model was unsure of are picked out of the page's own text", async () => {
  book("Flagged Up", ["The cat sat", "on the mat"], { flags: { 2: ["mat"] } });
  const { ctx, page } = await review("flagged-up");
  assert.deepEqual(await marksOn(page, 2), ["mat"]);
  // Picked out, not rewritten: the line still reads exactly as text.json has it.
  assert.equal((await strip(page))[1].text, "on the mat");
  // A page nothing was flagged on is left completely plain — a page of
  // highlights tells a parent nothing about where to look.
  assert.deepEqual(await marksOn(page, 1), []);
  // Why it is marked, for a parent who hovers.
  assert.equal(await page.locator("#strip .page:nth-child(2) .txt mark").getAttribute("title"), UNSURE);
  // And "Clear flag" is only offered on the page that has one.
  assert.equal(await page.locator("#strip .page:nth-child(2) .clear").count(), 1);
  assert.equal(await page.locator("#strip .page:nth-child(1) .clear").count(), 0);
  await ctx.close();
});

test("the same word twice is marked twice, and a flag for a word that is gone marks nothing", async () => {
  book("Twice Over", ["the cat and the dog", "nothing to see"],
       { flags: { 1: ["the"], 2: ["banana"] } });
  const { ctx, page } = await review("twice-over");
  assert.deepEqual(await marksOn(page, 1), ["the", "the"]);
  assert.equal((await strip(page))[0].text, "the cat and the dog");
  // A flag whose word a parent already fixed by hand in power mode must not
  // blank the page or throw — it simply has nothing to mark.
  assert.deepEqual(await marksOn(page, 2), []);
  assert.equal((await strip(page))[1].text, "nothing to see");
  await ctx.close();
});

test("an inline field puts the parent's words into text.json, and the shelf follows", async () => {
  book("Typo", ["The cat sta", "on the mat"], { flags: { 1: ["sta"] } });
  const { ctx, page } = await review("typo");
  await page.locator("#strip .page:nth-child(1) .edit").click();
  await page.locator("#strip .page:nth-child(1) textarea").fill("The cat sat");
  await page.locator("#strip .page:nth-child(1) .save").click();
  await page.waitForFunction(() => document.getElementById("strip").dataset.saved === "1");
  // On the screen…
  assert.equal((await strip(page))[0].text, "The cat sat");
  assert.equal(await page.locator("#strip .page:nth-child(1) textarea").count(), 0);
  // …on disk, and nothing else moved.
  const pages = textOf("Typo");
  assert.equal(pages[0].text, "The cat sat");
  assert.equal(pages[1].text, "on the mat", "the other pages were not touched");
  assert.deepEqual(pages.map(p => p.index), [1, 2]);
  assert.deepEqual(pages.map(p => p.cover), [true, false]);
  assert.deepEqual(pages[0].source, "sources/IMG_0001.jpg", "a page keeps the photo it came from");
  // The word the model was unsure of is the word the parent has just retyped,
  // so the flag has been answered and goes with the edit.
  assert.deepEqual(pages[0].flags, []);
  assert.deepEqual(await marksOn(page, 1), []);
  // The book was already on the shelf, so the shelf follows the correction.
  let m;
  for (let i = 0; i < 100; i++) {
    m = manifestOf("Typo");
    if (m.pages[0].text === "The cat sat") break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.deepEqual(m.pages.map(p => p.text), ["The cat sat", "on the mat"]);
  await ctx.close();
});

test("an edit a parent thought better of writes nothing at all", async () => {
  book("Second Thoughts", ["The cat sat", "on the mat"]);
  const { ctx, page } = await review("second-thoughts");
  await page.locator("#strip .page:nth-child(1) .edit").click();
  await page.locator("#strip .page:nth-child(1) textarea").fill("something else entirely");
  await page.locator("#strip .page:nth-child(1) .cancel").click();
  assert.equal(await page.locator("#strip .page:nth-child(1) textarea").count(), 0);
  assert.equal((await strip(page))[0].text, "The cat sat");
  assert.equal(await page.evaluate(() => document.getElementById("strip").dataset.saved || ""), "");
  assert.equal(textOf("Second Thoughts")[0].text, "The cat sat");
  await ctx.close();
});

test("Clear flag drops the marks and leaves every word exactly as it was", async () => {
  book("Sure Enough", ["The cat sat", "on the mat"], { flags: { 2: ["mat", "the"] } });
  const { ctx, page } = await review("sure-enough");
  assert.deepEqual(await marksOn(page, 2), ["the", "mat"]);   // in the order they are read
  await page.locator("#strip .page:nth-child(2) .clear").click();
  await page.waitForFunction(() => document.getElementById("strip").dataset.saved === "1");
  assert.deepEqual(await marksOn(page, 2), []);
  assert.equal(await page.locator("#strip .page:nth-child(2) .clear").count(), 0);
  const pages = textOf("Sure Enough");
  assert.deepEqual(pages[1].flags, []);
  assert.equal(pages[1].text, "on the mat", "clearing a flag must not touch a single word");
  assert.equal(pages[0].text, "The cat sat");
  assert.deepEqual(pages.map(p => p.index), [1, 2]);
  await ctx.close();
});

test("a per-page write that is not this book's page is refused rather than half-applied", async () => {
  book("Fussy", ["one", "two"], { flags: { 1: ["one"] } });
  const bad = [
    { slug: "fussy", page: 9, text: "hello" },          // not a page of this book
    { slug: "fussy", page: "1", text: "hello" },        // not an index
    { slug: "fussy", page: 1 },                         // nothing to change
    { slug: "fussy", page: 1, text: 7 },                // not words
    { slug: "fussy", page: 1, flags: [{ word: "one" }] }, // flags are cleared here, never authored
    { slug: "no-such-book", page: 1, text: "hello" },
  ];
  for (const b of bad) {
    const r = await post(b);
    assert.equal(r.status, 400, JSON.stringify(b) + " should be refused");
    assert.ok((await r.json()).error, "a refusal says why");
  }
  const pages = textOf("Fussy");
  assert.deepEqual(pages.map(p => p.text), ["one", "two"]);
  assert.deepEqual(pages[0].flags.map(f => f.word), ["one"]);
});

// ------------------------------------------------------------- the money, part 1

test("looking, reordering and editing a book spends nothing at all", () => {
  assert.deepEqual(calls, [],
    "a review page that reaches a provider before a parent asks for narration bills the family");
});

// -------------------------------------------------------------- Re-narrate (£)

test("Re-narrate with no voice set up is a sentence, not a 500 — and buys nothing", async () => {
  book("No Voice Yet", ["The cat sat"]);
  const { ctx, page } = await review("no-voice-yet");
  await page.locator("#strip .page:nth-child(1) .narrate").click();
  await page.waitForFunction(() => /voice/i.test(document.getElementById("stripNote").textContent));
  const msg = (await page.locator("#stripNote").textContent()).trim();
  assert.match(msg, /voice/i);
  assert.ok(!/\d{3}/.test(msg), "a parent gets words, not a status code: " + msg);
  assert.deepEqual(calls, [], "nothing was asked of a provider");
  await ctx.close();
});

test("Re-narrate this page buys that page and nothing else, and the shelf follows", async () => {
  // The Voice card, as a parent who just pasted a key leaves it. This is the
  // stand-in's key, on the stand-in's host: ERA_ELEVEN_URL is what makes that
  // true, and the assertions below prove the request went there.
  fs.writeFileSync(path.join(DATA, "tts-config.json"),
    JSON.stringify({ apiKey: FAKE_KEY, voiceId: VOICE, keyOk: true }));
  book("Read Aloud", ["The cat sat", "on the mat", "the end"]);
  const before = manifestOf("Read Aloud");
  assert.ok(!before.pages.some(p => p.audio), "the book starts silent");
  const { ctx, page } = await review("read-aloud", { video: true });
  await page.locator("#strip .page:nth-child(2) .narrate").click();
  await page.waitForFunction(() => /Recorded/.test(document.getElementById("stripNote").textContent),
                             null, { timeout: 30000 });
  // ONE page, ONE call, on the seam, with the Voice card's key in the header
  // where it belongs (never in the URL — a URL ends up in logs).
  assert.equal(calls.length, 1, "one page re-narrated is one call, never the book");
  assert.equal(calls[0].text, "on the mat");
  assert.equal(calls[0].key, FAKE_KEY);
  assert.ok(calls[0].url.startsWith("/v1/text-to-speech/" + VOICE + "/with-timestamps"), calls[0].url);
  assert.ok(!calls[0].url.includes(FAKE_KEY), "the key must never travel in a URL");
  // The audio and the word timings reach the shelf, on that page only.
  let m;
  for (let i = 0; i < 150; i++) {
    m = manifestOf("Read Aloud");
    if (m.pages[1].audio) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(m.pages[1].audio, "audio/002.mp3");
  assert.deepEqual(m.pages[1].words.map(w => w.word), ["on", "the", "mat"]);
  assert.equal(m.pages[1].words[0].start, 0);
  assert.ok(!m.pages[0].audio && !m.pages[2].audio,
    "the pages nobody asked for are still silent — nothing else was bought");
  assert.ok(fs.existsSync(path.join(BOOKS, "Read Aloud", "audio", "002.mp3")));
  assert.deepEqual(fs.readdirSync(path.join(BOOKS, "Read Aloud", "audio")), ["002.mp3"]);
  // exportedAt is the reader's cache-bust (public/reader/reader.js): without a
  // bump the family hears yesterday's page for a day.
  assert.ok(m.exportedAt > before.exportedAt,
    "a re-publish must bump exportedAt or the reader serves the old audio for 24 h");
  // And the page says so in the parent's own words, not in step names.
  const msg = (await page.locator("#stripNote").textContent()).trim();
  assert.match(msg, /Recorded/);
  if (VIDEO) await page.waitForTimeout(1500);
  await ctx.close();
});

// ------------------------------------------------------------- the money, part 2

test("every provider call the whole suite made went to the stand-in, and there was one", () => {
  // A count of anything but one means a request escaped ERA_ELEVEN_URL (or the
  // page bought pages nobody asked for) and the family was billed for it.
  assert.equal(calls.length, 1,
    "the stand-in recorded " + calls.length + " calls; exactly one page was ever asked for");
  assert.ok(calls.every(c => /with-timestamps/.test(c.url)),
    "the only provider shape this page may ever reach is one page of narration");
});
