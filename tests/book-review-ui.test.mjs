// book-review-ui.test.mjs — the review page's page strip (plan T3.2, spec §5):
// every page in the order text.json keeps them, drag to reorder, tap to mark
// the cover. A real browser drives it, because a drag is the whole feature and
// a DOM assertion about a drag that never happened proves nothing.
//
// PORTS: 8435 (the real server.js) + 8440 (the provider stand-in below).
// 8440 is the free slot between the plan's 8439 (fal hub) and 8441 (fake fal);
// this suite claims it so the money guardrail can be an assertion rather than
// a hope.
//
// MONEY GUARDRAIL (plan §B.2, Gap 20): the hub is spawned with its own mkdtemp
// ERA_DATA_DIR, so the gate's real ElevenLabs credential is nowhere near this
// suite, AND every provider seam (ERA_AI_URL, ERA_ELEVEN_URL, ERA_FAL_URL) is
// pointed at a local stand-in that counts what it is asked for. Reordering a
// book must never spend a thing: the last test asserts the stand-in saw ZERO
// calls. Playwright also routes **/tts* so a page that grew a narration button
// could not reach one either. There is no key in this file and no key file is
// read.
//
// A VIDEO of the drag: set ERA_REVIEW_VIDEO=<dir> and the drag test records
// itself there as .webm (that is how the task's recording was made). Unset —
// the gate — it records nothing and costs nothing.
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

let child, fake, browser, calls = 0;

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
function book(name, texts, opts) {
  const o = opts || {};
  const dir = path.join(BOOKS, name);
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  const pages = [];
  texts.forEach((t, i) => {
    const index = i + 1, pad = String(index).padStart(3, "0");
    fs.writeFileSync(path.join(dir, "pages", pad + ".jpg"), jpg(index));
    pages.push({ index, source: "sources/IMG_000" + index + ".jpg", text: t,
                 flags: [], cover: index === 1 });
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
  // Anything that reaches a provider lands here instead, and is counted.
  fake = http.createServer((req, res) => { calls++; res.writeHead(500).end("{}"); });
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

// ----------------------------------------------------------------- the money

test("reordering a book spends nothing — the provider stand-in was never called", () => {
  assert.equal(calls, 0, "a review-page suite that reaches a provider is a suite that bills the family");
});
