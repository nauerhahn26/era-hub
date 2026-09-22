// reader-strip.test.mjs — the RECEIVE half of book sharing (spec §5, plan T4.1).
//
// Another family sent a `.erabook`. A grown-up presses "+ Add a book" at the
// right end of the reader's door bar, picks the file, and the book is on Rae's
// shelf — read-aloud, word timings, video pages and all.
//
// What this suite pins:
//
//   * THE 🚪 DOES NOT MOVE. doorbar.js's standing law: the 💬 is absolutely
//     centred and the 🚪 owns the top-left corner precisely so a board (or a
//     reader) growing a strip never moves her motor plan for either door. The
//     strip is measured in and measured out again, and both doors must be in
//     the same place to the pixel;
//   * the strip is a GROWN-UP's control: no `.dwell`, no `data-dwell-*`,
//     mouse OR finger — only the HOLD is finger-only, because only the hold
//     shares a surface with her gaze;
//   * it is mounted on the SHELF screen only. While a book is open the bar
//     belongs to 🚪 and 💬;
//   * the sheet is a LIST OF SOURCES that happens to hold one row today, and
//     `source=file` is on the wire from this first commit — dad's other reading
//     tools are a new row and a new word, never a redesign. Nothing is stubbed
//     for them;
//   * the file is POSTed as the RAW BODY. There is no multipart parser in the
//     hub and there must never be one;
//   * every refusal is one sentence a parent can act on, and the sheet keeps it.
//
// Harness: reader-ui.test.mjs's — the REAL server.js on scratch port 8469 with
// a throwaway ERA_DATA_DIR, a real Drive content folder, and the SYNTHETIC
// "Luna the Fox" fixture (never real book content). The `.erabook` this suite
// imports is one the hub exported from that fixture seconds earlier, so the
// round trip is real bytes rather than a hand-written archive.
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

// 8469, the same port reader-share.test.mjs uses — the two suites never run at
// the same time (the gate runs *.test.mjs one after another) and the plan's
// sweep claimed exactly one port for the reader half of this feature.
const PORT = Number(process.env.ERA_TEST_HUB_PORT) || 8469;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-reader-strip-"));
const FOLDER = path.join(TMP, "drive", "New ERA Content");
let child, browser, ERABOOK, NOT_A_BOOK;

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64");

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
  const book = path.join(TMP, "books", "luna-the-fox");
  fs.mkdirSync(path.join(book, "pages"), { recursive: true });
  fs.mkdirSync(path.join(book, "audio"), { recursive: true });
  fs.mkdirSync(FOLDER, { recursive: true });
  fs.writeFileSync(path.join(book, "cover.jpg"), JPEG);
  for (const n of ["001", "002"]) fs.writeFileSync(path.join(book, "pages", n + ".jpg"), JPEG);
  for (const n of ["001", "002"]) fs.writeFileSync(path.join(book, "audio", n + ".wav"), makeWav(3));
  fs.writeFileSync(path.join(book, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000002",
    slug: "luna-the-fox",
    title: "Luna the Fox",
    authored: true,
    exportedAt: "2026-08-24T00:00:00Z",
    narration: { provider: "synthetic", model: "fixture", voice: "none" },
    cover: "cover.jpg",
    pages: [
      { index: 0, image: "pages/001.jpg", text: "Luna naps now.", audio: "audio/001.wav" },
      { index: 1, image: "pages/002.jpg", text: "Good night fox.", audio: "audio/002.wav" },
    ],
  }, null, 2));
  fs.writeFileSync(path.join(TMP, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: FOLDER }));

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

  // The file another family would send: the hub's own export of the fixture.
  ERABOOK = path.join(TMP, "Luna the Fox.erabook");
  const res = await fetch(`${BASE}/books/luna-the-fox.erabook`);
  if (!res.ok) throw new Error("export failed: " + res.status);
  fs.writeFileSync(ERABOOK, Buffer.from(await res.arrayBuffer()));
  // …and a file that is not one at all.
  NOT_A_BOOK = path.join(TMP, "holiday.erabook");
  fs.writeFileSync(NOT_A_BOOK, "these are not the bytes you are looking for\n");

  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
});
after(async () => {
  if (browser) await browser.close();
  if (child) child.kill("SIGKILL");
});

async function settingsOverlay(ctx, over) {
  await ctx.route("**/settings", async (r) => {
    let base = {};
    try { base = await (await r.fetch()).json(); } catch {}
    await r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ...base, ...over }) });
  });
}

async function makePage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  await ctx.addInitScript(() => { window.__testHooks = true; });
  // pauseGoes:"tdsnap" so the 💬 is up: the door whose CENTRE the strip must
  // not move is only on screen where there is a talker to step out to.
  await settingsOverlay(ctx, { pauseGoes: "tdsnap", ...(opts.settings || {}) });
  if (opts.routes) await opts.routes(ctx);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/reader/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Reader && typeof window.Reader.state === "function");
  await page.locator("#stripAddBook").waitFor();
  return { ctx, page };
}

const openSheet = async (page) => {
  await page.locator("#stripAddBook").click();
  await page.locator("#addSheet").waitFor({ timeout: 3000 });
};

// =================================================== the strip, and her motor plan

// doorbar.js's header, verbatim: "a touch-only strip may sit at the bar's right
// end (it is never .dwell), and it is why the 💬 is absolutely CENTRED on the
// bar rather than packed after the 🚪: her motor plan for it must not move when
// a board grows a strip." The reader is the second app to grow one, so this is
// the second time that sentence has to be true.
test("THE 🚪 DOES NOT MOVE when the strip mounts, and neither does the 💬", async () => {
  const { ctx, page } = await makePage();
  await page.locator("#barTalk").waitFor({ state: "visible" });
  const centres = () => page.evaluate(() => {
    const mid = (id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return { x: +(r.left + r.width / 2).toFixed(2), y: +(r.top + r.height / 2).toFixed(2),
               w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
    };
    return { door: mid("barDoor"), talk: mid("barTalk"),
             barH: +document.querySelector(".msgbar").getBoundingClientRect().height.toFixed(2) };
  });
  const withStrip = await centres();
  assert.equal(await page.locator(".msgbar #readerStrip").count(), 1, "the strip is on the bar");
  // …take it away and look again. Same bar, same doors, same pixels.
  await page.evaluate(() => document.getElementById("readerStrip").remove());
  await page.waitForTimeout(50);
  const without = await centres();
  assert.deepEqual(withStrip.door, without.door,
    "the 🚪 moved when the strip mounted — that is her motor plan for the way out");
  assert.deepEqual(withStrip.talk, without.talk,
    "the 💬 moved when the strip mounted");
  assert.equal(withStrip.barH, without.barH, "and the strip did not grow the bar");
  await ctx.close();
});

// A GROWN-UP's control, exactly as the board's partner strip is: no class for
// the gaze engine to find, no hold of its own, and a mouse works as well as a
// finger (only the hold is finger-only, because only the hold shares a surface
// with her gaze).
test("the strip button is no gaze target at all, and answers a mouse", async () => {
  const { ctx, page } = await makePage();
  const btn = page.locator("#stripAddBook");
  assert.equal((await btn.textContent()).trim(), "+ Add a book");
  const marks = await btn.evaluate(el => ({
    dwell: el.classList.contains("dwell"),
    attrs: [...el.attributes].map(a => a.name).filter(n => n.startsWith("data-dwell")),
    tag: el.tagName, type: el.type,
  }));
  assert.equal(marks.dwell, false, "the strip button carries .dwell");
  assert.deepEqual(marks.attrs, [], "…or a data-dwell-* attribute: " + marks.attrs.join(","));
  assert.equal(marks.tag, "BUTTON");
  assert.equal(marks.type, "button", "never a submit inside somebody's form");
  assert.equal(await page.locator(".msgbar .dwell").count(), 2,
    "the bar's only gaze targets are still its two doors");
  await btn.click();                       // a plain mouse click: a grown-up at a keyboard
  await page.locator("#addSheet").waitFor({ timeout: 3000 });
  await ctx.close();
});

// While a book is open the bar belongs to 🚪 and 💬 (spec §5.1). The strip is
// the shelf's, and a child mid-story must not find a grown-up's control in the
// one strip she has learned.
test("the strip is on the SHELF screen only: it goes away inside a book", async () => {
  const { ctx, page } = await makePage();
  assert.equal(await page.locator("#stripAddBook").isVisible(), true, "up on the shelf");
  await page.locator("#shelfGrid .shelf-card-button", { hasText: "Luna the Fox" }).click();
  await page.waitForFunction(() => window.Reader.state().screen === "sRead");
  assert.equal(await page.locator("#stripAddBook").isVisible(), false,
    "the strip is still on the bar over an open book");
  await page.locator("#btnLibrary").click();
  await page.waitForFunction(() => window.Reader.state().screen === "sShelf");
  assert.equal(await page.locator("#stripAddBook").isVisible(), true, "and it comes back with the shelf");
  await ctx.close();
});

// ======================================================================= the sheet

// A LIST OF ONE, BUT A LIST. Dad, 9/19: "there's like a few other reading tools
// there that we could eventually allow people to add books through." When one
// arrives it is a new row here and a new `source` on the wire — so nothing is
// built for it now: no adapter interface, no registry, no second row stubbed.
test("the add sheet lists sources, and today there is exactly one", async () => {
  const { ctx, page } = await makePage();
  await openSheet(page);
  assert.match(await page.locator("#addSheet .add-title").textContent(), /Add a book/);
  const rows = await page.locator("#addSheet .add-source").allTextContents();
  assert.deepEqual(rows.map(s => s.trim()), ["📁 Choose a file"], rows.join(" | "));
  const input = page.locator("#addFile");
  assert.equal(await input.getAttribute("accept"), ".erabook,.zip",
    "Explorer on Windows, the file picker on a phone");
  await ctx.close();
});

// The sheet is a grown-up's, so the shelf beneath it sleeps exactly as it does
// under the send sheet and the Build ask — reader.js's own freeze, borrowed.
test("while the add sheet is open the shelf and both doors are asleep, and wake together", async () => {
  const { ctx, page } = await makePage();
  const live = () => page.evaluate(() => ({
    cards: document.querySelectorAll("#shelfGrid .shelf-card-button.dwell").length,
    doors: document.querySelectorAll(".msgbar .bardoor.dwell").length,
  }));
  const before = await live();
  assert.ok(before.cards >= 1 && before.doors === 2, JSON.stringify(before));
  await openSheet(page);
  assert.deepEqual(await live(), { cards: 0, doors: 0 }, "something is still a live gaze target");
  await page.locator("#addClose").click();
  await page.waitForTimeout(100);
  assert.deepEqual(await live(), before, "her shelf and her doors came back");
  await ctx.close();
});

test("nothing on the add sheet or the strip is a dwell target or claims a hold", async () => {
  const { ctx, page } = await makePage();
  await openSheet(page);
  for (const root of ["#addSheet", "#readerStrip"]) {
    assert.equal(await page.locator(root + " .dwell").count(), 0, root + " .dwell");
    assert.equal(await page.locator(root + " [data-dwell-say]").count(), 0, root + " say");
    assert.equal(await page.locator(root + " [data-dwell-ms]").count(), 0, root + " ms");
    assert.equal(await page.locator(root + " [data-dwell-disabled]").count(), 0, root + " disabled");
  }
  await ctx.close();
});

// ================================================================== a real import

// Dad, 9/18: "should land arrive on their bookshelf ready to read." End to end
// over the real wire: the file goes up as a RAW BODY with `source=file`, the
// hub writes it into the family's Drive folder and mirrors one book onto this
// device's shelf, and the shelf behind the sheet repaints with it on.
test("choosing a file adds the book: raw body, source=file, and the shelf repaints with it", async () => {
  const { ctx, page } = await makePage();
  const seen = [];
  await ctx.route("**/books/import**", async (r) => {
    const req = r.request();
    seen.push({ url: req.url(), method: req.method(),
                type: (req.headers()["content-type"] || ""),
                bytes: (req.postDataBuffer() || Buffer.alloc(0)).length });
    await r.continue();
  });
  const before = (await page.evaluate(() => window.Reader.state())).shelfCount;
  await openSheet(page);
  await page.locator("#addFile").setInputFiles(ERABOOK);
  // "Adding <Title>…" while it travels — a parent standing at a tablet with a
  // forty-megabyte book must be told something is happening.
  await page.waitForFunction(
    () => /Adding/.test((document.querySelector("#addSheet .add-msg") || {}).textContent || ""),
    null, { timeout: 5000 });
  await page.waitForFunction(
    () => /is on the shelf/.test((document.querySelector("#addSheet .add-msg") || {}).textContent || ""),
    null, { timeout: 30000 });
  const said = await page.locator("#addSheet .add-msg").textContent();
  assert.match(said, /^Luna the Fox is on the shelf\.$/, said);
  assert.equal(await page.locator("#addSheet .add-cover img").count(), 1,
    "…with the book's own cover, so a parent can see it is the right one");

  assert.equal(seen.length, 1, "one POST, once");
  assert.equal(seen[0].method, "POST");
  assert.match(seen[0].url, /\/books\/import\?source=file$/,
    "the source is on the wire from the first commit: " + seen[0].url);
  assert.equal(seen[0].bytes, fs.statSync(ERABOOK).size,
    "the file went up as the RAW body — there is no multipart parser in the hub");
  assert.doesNotMatch(seen[0].type, /multipart/, seen[0].type);

  // the shelf behind the sheet repainted, and the book really is on this
  // device's shelf (mirrorBook, not the next ten-minute tick)
  await page.waitForFunction((n) => window.Reader.state().shelfCount === n + 1, before,
    { timeout: 10000 });
  assert.ok(fs.existsSync(path.join(FOLDER, "books", "Luna the Fox", "manifest.json")),
    "the book landed in the family's Drive folder (books-share law 1)");
  assert.ok(fs.existsSync(path.join(TMP, "books", "Luna the Fox", "manifest.json")),
    "…and was mirrored onto this device's shelf");
  assert.equal(await page.locator("#shelfGrid .shelf-card-button").count(), before + 1);
  await ctx.close();
});

// ===================================================================== refusals

// A parent is standing at a tablet holding a file somebody sent them. They get
// ONE line they can act on — never a code, never a stack, never a 500. The hub
// writes the sentence (books-share.js MESSAGES); the sheet only shows it.
test("a file that is not a New ERA book is refused in one sentence, and the sheet stays open", async () => {
  const { ctx, page } = await makePage();
  await openSheet(page);
  await page.locator("#addFile").setInputFiles(NOT_A_BOOK);
  await page.waitForFunction(
    () => /isn't a New ERA book/.test((document.querySelector("#addSheet .add-msg") || {}).textContent || ""),
    null, { timeout: 15000 });
  assert.equal((await page.locator("#addSheet .add-msg").textContent()).trim(),
    "That file isn't a New ERA book.");
  assert.equal(await page.locator("#addSheet").count(), 1, "the sheet stayed open");
  assert.equal(await page.locator("#addSheet .add-source").count(), 1,
    "…and they can pick another file");
  await ctx.close();
});

// The one refusal with somewhere to send them (spec §5.2, row 5). Stood in
// rather than provoked: this hub HAS a content folder, and taking it away for
// one assertion would be a different hub.
test("no content folder on this computer: the sentence, and the way to fix it", async () => {
  const { ctx, page } = await makePage({ routes: (c) =>
    c.route("**/books/import**", r => r.fulfill({ status: 409, contentType: "application/json",
      body: JSON.stringify({ error: "needs-local-drive", settings: "/settings/#integrations",
        message: "New ERA keeps books in the family's content folder in Google Drive, so every device gets them. Set up your content folder first." }) })) });
  await openSheet(page);
  await page.locator("#addFile").setInputFiles(ERABOOK);
  await page.waitForFunction(
    () => /content folder/.test((document.querySelector("#addSheet .add-msg") || {}).textContent || ""),
    null, { timeout: 15000 });
  const link = page.locator("#addSheet .add-link");
  assert.equal(await link.count(), 1, "the only refusal with somewhere to go says where");
  assert.equal(await link.getAttribute("href"), "/settings/#integrations");
  await ctx.close();
});

// A refusal nobody wrote a sentence for must still be a sentence. A hub that
// answers with no `message` at all — an older one, a proxy, a bug — still gets
// a parent a line, never an error object on a six-year-old's bookshelf.
test("a refusal with no sentence in it still says something a parent can read", async () => {
  const { ctx, page } = await makePage({ routes: (c) =>
    c.route("**/books/import**", r => r.fulfill({ status: 500, contentType: "text/plain", body: "boom" })) });
  await openSheet(page);
  await page.locator("#addFile").setInputFiles(ERABOOK);
  await page.waitForFunction(
    () => ((document.querySelector("#addSheet .add-msg") || {}).textContent || "").length > 10,
    null, { timeout: 15000 });
  const said = (await page.locator("#addSheet .add-msg").textContent()).trim();
  assert.doesNotMatch(said, /\[object|undefined|500|Error/, said);
  assert.match(said, /\.$/, "a sentence, with a full stop on it: " + said);
  await ctx.close();
});
