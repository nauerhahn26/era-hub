// book-sharing-e2e.test.mjs — the FEATURE, not the units (plan T5.1, spec §8).
//
// erabook.test.mjs proves the format. books-share.test.mjs proves the policy.
// reader-share/reader-strip prove the two sheets. Every one of them runs
// against one machine's idea of the world. This one runs a book across the gap
// the feature actually exists to cross: TWO real hubs, each with its own
// <DATA>, its own Drive content folder and its own port, one book on the first
// shelf and nothing at all on the second.
//
// Nothing here is mocked or stubbed. Both ends are `node server.js`; the bytes
// travel over HTTP exactly as they do when a parent sends a file; and the last
// assertion is a browser opening the book on the receiving family's shelf,
// because "it is in the index" is not the same claim as "she can read it".
//
// What it pins that no unit test can:
//
//   * the receiving hub SERVES what it took in — the shelf lists it, the cover
//     and the narration answer 200 with a type a browser will play;
//   * the package landed in hub B's DRIVE CONTENT FOLDER, which is the law
//     (books-share.js #1): a book written into <DATA> would live on one PC and
//     the next mirror prune would eat it;
//   * <DATA> got its copy too, through drive.mirrorBook — with the provenance
//     LEDGER written, which is what makes the book the mirror's to take away
//     again when the parent deletes the folder in Drive;
//   * the book OPENS. A real page, rendered, in a real browser;
//   * and hub A is untouched by having been exported from. Sending is a copy:
//     nothing consumed, nothing moved, not one byte of the sender's shelf
//     different afterwards.
//
// Ports 8470 and 8471, claimed for this suite by the plan's sweep across all
// five repos' tests/ and every open worktree. 8377 is the live family hub,
// 8378 the gate's, 8469 the reader-share/reader-strip suites'.
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

// Every provider seam at a closed port, the way the gate does it hub-wide: a
// spawned hub reaches out on its own (the /content/status poll asks ElevenLabs
// for the month's voice left, the clothing tick asks for the weather) and no
// test may spend a family's key.
const CLOSED = {
  ERA_AI_URL: "http://127.0.0.1:1", ERA_ELEVEN_URL: "http://127.0.0.1:1",
  ERA_FAL_URL: "http://127.0.0.1:1", ERA_GEO_URL: "http://127.0.0.1:1/geo",
  ERA_WEATHER_URL: "http://127.0.0.1:1", ERA_RESEND_URL: "http://127.0.0.1:1",
  ERA_TMDB_URL: "http://127.0.0.1:1", ERA_STREAMING_URL: "http://127.0.0.1:1",
};

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

// The SYNTHETIC "Luna the Fox" fixture, the reader suites' own — never real
// book content. Three pages so a page COUNT is a fact and not a coincidence.
const TITLE = "Luna the Fox";
const PAGES = ["Luna naps now.", "The fox sleeps.", "Good night fox."];
const MANIFEST = {
  schemaVersion: 1,
  id: "00000000-0000-4000-8000-000000000002",
  slug: "luna-the-fox",
  title: TITLE,
  authored: true,
  exportedAt: "2026-08-24T00:00:00Z",
  narration: { provider: "synthetic", model: "fixture", voice: "none" },
  cover: "cover.jpg",
  pages: PAGES.map((text, i) => ({
    index: i,
    image: "pages/00" + (i + 1) + ".jpg",
    text,
    audio: "audio/00" + (i + 1) + ".wav",
  })),
};

// One hub: a throwaway <DATA>, a throwaway "Drive" mount with a content folder
// in it, and a real server.js on its own port. Two of these are the whole test.
function makeHub(label, port) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-share-e2e-" + label + "-"));
  const FOLDER = path.join(TMP, "drive", "New ERA Content");
  fs.mkdirSync(path.join(FOLDER, "books"), { recursive: true });
  // The content folder written down the way drive.js records a picked one, so
  // the hub has a real place for books before it boots.
  fs.writeFileSync(path.join(TMP, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: FOLDER }));
  return { label, port, TMP, FOLDER, BASE: `http://127.0.0.1:${port}`, child: null };
}

async function boot(hub) {
  hub.child = spawn("node", ["server.js", String(hub.port)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...CLOSED, ERA_DATA_DIR: hub.TMP, ERA_BIND: "127.0.0.1",
           ERA_DEVICE_ID: "test-" + hub.label },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${hub.BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("hub " + hub.label + " never came up on " + hub.port);
}

// Every non-dot file under a tree, as "rel|size|mtimeMs" — the sender's shelf,
// so "unchanged" can mean unchanged rather than "still has a book in it".
function tree(dir, rel = "", out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents.sort((a, b) => a.name < b.name ? -1 : 1)) {
    const abs = path.join(dir, e.name), r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) tree(abs, r, out);
    else { const st = fs.statSync(abs); out.push(r + "|" + st.size + "|" + st.mtimeMs); }
  }
  return out;
}

const A = makeHub("a", 8470);          // the family that has the book
const B = makeHub("b", 8471);          // the family that is sent it
let browser;
// Filled in by the journey test below; the shelf assertions read them.
let ERABOOK = null, imported = null, aShelfBefore = null;

before(async () => {
  // A's shelf: the fixture package, exactly as the builder would have left it.
  const book = path.join(A.TMP, "books", "luna-the-fox");
  fs.mkdirSync(path.join(book, "pages"), { recursive: true });
  fs.mkdirSync(path.join(book, "audio"), { recursive: true });
  fs.writeFileSync(path.join(book, "cover.jpg"), JPEG);
  for (const n of ["001", "002", "003"]) {
    fs.writeFileSync(path.join(book, "pages", n + ".jpg"), JPEG);
    fs.writeFileSync(path.join(book, "audio", n + ".wav"), makeWav(2));
  }
  fs.writeFileSync(path.join(book, "manifest.json"), JSON.stringify(MANIFEST, null, 2));
  // B's shelf: nothing. Not an empty directory — no directory at all, which is
  // what a hub that has never had a book looks like.

  await boot(A);
  await boot(B);
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
});

after(async () => {
  if (browser) await browser.close();
  for (const h of [A, B]) {
    if (h.child) h.child.kill("SIGKILL");
    fs.rmSync(h.TMP, { recursive: true, force: true });
  }
});

const json = async (url) => {
  const r = await fetch(url);
  assert.equal(r.status, 200, url + " -> " + r.status);
  return r.json();
};

// ============================================================== the journey

test("the book crosses: hub A exports over HTTP, hub B imports over HTTP", async () => {
  // Hub A, warmed: the shelf read once so books-index has written its
  // .slugs.json, and the snapshot below is of a settled shelf rather than of
  // one that is about to write a dotfile for reasons of its own.
  const shelfA = await json(`${A.BASE}/books/index.json`);
  assert.equal(shelfA.length, 1, "hub A starts with the one book");
  aShelfBefore = tree(path.join(A.TMP, "books"));

  // Hub B, empty. If this is not true the rest of the file proves nothing.
  assert.deepEqual(await json(`${B.BASE}/books/index.json`), [],
    "hub B was supposed to start with an empty shelf");

  // ---- hub A: the export, over HTTP, exactly as a browser asks for it -----
  const out = await fetch(`${A.BASE}/books/${shelfA[0].slug}.erabook`);
  assert.equal(out.status, 200, "the export answered " + out.status);
  assert.equal(out.headers.get("content-type"), "application/octet-stream");
  // The header a parent's browser turns into a filename. The title is family
  // text going into an HTTP header, so both spellings are here (spec §6.1).
  const cd = out.headers.get("content-disposition") || "";
  assert.match(cd, /attachment; filename="Luna the Fox\.erabook"/, cd);
  assert.match(cd, /filename\*=UTF-8''Luna%20the%20Fox\.erabook/, cd);
  const bytes = Buffer.from(await out.arrayBuffer());
  assert.ok(bytes.length > 0, "an empty .erabook");
  assert.equal(bytes.slice(0, 2).toString("latin1"), "PK", "not a zip at all");
  // THROUGH A FILE ON DISK, because that is what actually crosses between two
  // families — a thing in a Drive folder, an attachment, a copy on a stick.
  // The import below posts what was READ BACK from it, not the response buffer
  // still in this process's memory.
  ERABOOK = path.join(A.TMP, "Luna the Fox.erabook");
  fs.writeFileSync(ERABOOK, bytes);
  const onDisk = fs.readFileSync(ERABOOK);
  assert.equal(onDisk.length, bytes.length, "the file on disk is not the answer");

  // ---- hub B: the import, over HTTP, raw body, source on the wire ---------
  // The raw File as the body is what reader-strip.js sends; there is no
  // multipart parser in this hub and there must never be one.
  const res = await fetch(`${B.BASE}/books/import?source=file`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: onDisk,
  });
  imported = await res.json();
  assert.equal(res.status, 200, "the import answered " + res.status + ": " +
    JSON.stringify(imported));
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.title, TITLE);
  assert.equal(imported.source, "file", "the source came back as it went out");
  assert.equal(imported.mirrored, true,
    "the import did not nudge this device's shelf: " + JSON.stringify(imported));
  assert.equal(imported.dir, TITLE, "the folder is named from the manifest's title");
  assert.ok(imported.slug, "no slug came back: " + JSON.stringify(imported));
});

// ======================================================= what hub B now has

test("hub B's shelf lists the book, with its title and its page count", async () => {
  const shelf = await json(`${B.BASE}/books/index.json`);
  assert.equal(shelf.length, 1, "the receiving shelf: " + JSON.stringify(shelf));
  assert.equal(shelf[0].title, TITLE);
  assert.equal(shelf[0].pages, PAGES.length, "three pages went, three pages arrived");
  // …and it is NOT this family's story. The manifest that crossed says
  // `authored: true` — truthfully, about hub A's child — and the shelf that
  // reads it is hub B's. See the badge test below for what the flag becomes on
  // a screen; this is the row it is made of.
  assert.equal(shelf[0].authored, false,
    "hub B's shelf repeats another family's authorship claim: " + JSON.stringify(shelf[0]));
  const m = await json(`${B.BASE}/books/${shelf[0].slug}/manifest.json`);
  assert.equal(m.authored, true,
    "the import rewrote the manifest — the flag is the sender's and travels byte for byte");
});

test("hub B SERVES the book: the cover and the first narration both answer 200", async () => {
  const shelf = await json(`${B.BASE}/books/index.json`);
  const slug = shelf[0].slug;

  const cover = await fetch(`${B.BASE}` + shelf[0].cover);
  assert.equal(cover.status, 200, "cover " + shelf[0].cover);
  assert.equal(cover.headers.get("content-type"), "image/jpeg");
  assert.ok(Number(cover.headers.get("content-length")) > 0, "an empty cover");

  // The first audio the manifest names, read from B's OWN manifest — the shape
  // the reader itself follows, not a path this test remembers.
  const m = await json(`${B.BASE}/books/${slug}/manifest.json`);
  const first = m.pages[0].audio;
  assert.match(first, /\.(mp3|wav)$/, "the first page's narration: " + first);
  const audio = await fetch(`${B.BASE}/books/${slug}/${first}`);
  assert.equal(audio.status, 200, "audio " + first);
  assert.equal(audio.headers.get("content-type"), "audio/wav");
  assert.ok(Number(audio.headers.get("content-length")) > 44, "a WAV header and no sound");
});

// ================================================== where hub B put it

// books-share.js law 1. A book written into <DATA> would exist on one PC and
// the next mirror prune would eat it; the family's Drive folder is the one
// place new content lands, and Google Drive for Windows carries it to their
// other devices on its own.
test("the package is in hub B's DRIVE CONTENT FOLDER, which is the law", async () => {
  const pkg = path.join(B.FOLDER, "books", TITLE);
  assert.ok(fs.existsSync(path.join(pkg, "manifest.json")),
    "no package at " + pkg + " — " + JSON.stringify(tree(path.join(B.FOLDER, "books"))));
  const m = JSON.parse(fs.readFileSync(path.join(pkg, "manifest.json"), "utf8"));
  assert.equal(m.title, TITLE);
  for (const p of m.pages) {
    assert.ok(fs.existsSync(path.join(pkg, p.image)), "missing " + p.image);
    assert.ok(fs.existsSync(path.join(pkg, p.audio)), "missing " + p.audio);
  }
  assert.ok(fs.existsSync(path.join(pkg, ".erabook.json")),
    "the envelope travelled with the book");
  // And nothing of the temp unpack is left behind beside it.
  assert.deepEqual(fs.readdirSync(path.join(B.FOLDER, "books")).filter(n => n.startsWith(".import-")),
    [], "an abandoned temp directory in the family's Drive folder");
});

test("<DATA> has its copy too, carried there by drive.mirrorBook — ledger and all", async () => {
  const shelf = path.join(B.TMP, "books");
  assert.ok(fs.existsSync(path.join(shelf, TITLE, "manifest.json")),
    "the shelf the reader serves never got the book: " + JSON.stringify(tree(shelf)));
  // The provenance ledger (drive.js): a path in it is the mirror's to delete
  // when the parent deletes the folder in Drive. A book mirrored without one
  // would be an orphan on this device forever.
  const ledger = JSON.parse(fs.readFileSync(path.join(shelf, ".mirrored.json"), "utf8"));
  assert.ok(Array.isArray(ledger), "the ledger is a list of paths: " + typeof ledger);
  assert.ok(ledger.includes(TITLE + "/manifest.json"),
    "the manifest is not the mirror's: " + JSON.stringify(ledger));
  for (const p of MANIFEST.pages)
    assert.ok(ledger.includes(TITLE + "/" + p.image), "not in the ledger: " + p.image);
});

// ======================================================= it actually opens

// "It is in the index" and "she can read it" are two different claims. This is
// the second one: a browser, hub B's own /reader/, a tap on the cover, and a
// page of somebody else's book on the screen.
test("the book OPENS on hub B: the shelf card, then the first page rendered", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const page = await ctx.newPage();
  try {
    await page.goto(`${B.BASE}/reader/`, { waitUntil: "load" });
    await page.waitForFunction(() => window.Reader && typeof window.Reader.state === "function");
    const card = page.locator("#shelfGrid .shelf-card-button", { hasText: TITLE });
    await card.waitFor({ timeout: 10000 });
    await card.click();
    await page.waitForFunction(() => window.Reader.state().screen === "sRead", null, { timeout: 10000 });
    assert.equal(await page.locator("#bookTitle").textContent(), TITLE);
    assert.equal((await page.locator("#pageText").textContent()).trim(), PAGES[0],
      "the first page's words");
    // RENDERED, not merely present: a 404 cover is an <img> too.
    const img = await page.locator("#pageImg").evaluate(el => ({
      complete: el.complete, w: el.naturalWidth, h: el.naturalHeight, src: el.src }));
    assert.equal(img.complete, true, "the page image never loaded: " + img.src);
    assert.ok(img.w > 0 && img.h > 0, "the page image is a broken image: " + JSON.stringify(img));
    assert.equal(await page.locator("#imgFallback").isVisible(), false,
      "the reader is showing 'Page image unavailable.'");
  } finally { await ctx.close(); }
});

// ========================================== whose story the shelf says it is

// The bug this journey caught on its first run (9/22), and what it looked like
// on the tablet: the book landed on hub B's shelf wearing the coral rim and
// the badge that reads "<her name>'s story" — "My story" until a family has
// given a name — and the shelf's own voice said it too, because the dwell
// button's aria-label is "Read <title> — <her name> story".
//
// A book another family made about THEIR child is not her story. The flag is
// not false either, which is why nothing rewrote it: it is hub A's truth,
// travelling byte for byte. Two hubs, one package, two honest answers.
async function shelfCard(hub, title) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const page = await ctx.newPage();
  try {
    await page.goto(`${hub.BASE}/reader/`, { waitUntil: "load" });
    await page.waitForFunction(() => window.Reader && typeof window.Reader.state === "function");
    const btn = page.locator("#shelfGrid .shelf-card-button", { hasText: title });
    await btn.waitFor({ timeout: 10000 });
    const card = page.locator("#shelfGrid .shelf-card", { hasText: title });
    const badges = card.locator(".shelf-authored-badge");
    const n = await badges.count();
    return {
      label: await btn.getAttribute("aria-label"),
      rim: await card.evaluate(el => el.classList.contains("is-authored")),
      badges: n,
      badge: n ? (await badges.first().textContent()).trim() : null,
      text: await page.evaluate(() => document.body.innerText),
    };
  } finally { await ctx.close(); }
}

test("hub A wears the badge for its own book; hub B's copy never claims it", async () => {
  const a = await shelfCard(A, TITLE);
  assert.equal(a.rim, true, "the family that MADE the book lost its coral rim");
  assert.equal(a.badges, 1, "hub A's own book: " + JSON.stringify(a));
  assert.equal(a.badge, "My story", "the badge hub A has always had");
  assert.equal(a.label, "Read " + TITLE + " — My story");

  const b = await shelfCard(B, TITLE);
  assert.equal(b.badges, 0,
    "hub B's shelf badges somebody else's book as this child's story: " + JSON.stringify(b));
  assert.equal(b.rim, false, "the coral rim is the same claim in paint");
  assert.equal(b.label, "Read " + TITLE,
    "the shelf reads another family's book out as her own story");
  assert.doesNotMatch(b.text, /My story/,
    "'My story' is still somewhere on the receiving shelf: " + b.text);
});

// =================================================== and hub A is untouched

// Sending is a COPY. A parent who sends their child's book to a friend must
// still have it afterwards — the same bytes, in the same place, with the same
// slug, so the child's saved place in it is still there too.
test("hub A's own shelf is exactly as it was: nothing consumed, nothing moved", async () => {
  assert.deepEqual(tree(path.join(A.TMP, "books")), aShelfBefore,
    "the sender's shelf changed by being exported from");
  const shelf = await json(`${A.BASE}/books/index.json`);
  assert.equal(shelf.length, 1);
  assert.equal(shelf[0].slug, "luna-the-fox", "the sender's book kept its slug");
  assert.equal(shelf[0].title, TITLE);
  assert.equal(shelf[0].pages, PAGES.length);
  // The export is a read: it leaves nothing behind in the sender's Drive
  // folder either (that is share-to-drive's job, and this was not it).
  assert.deepEqual(tree(path.join(A.FOLDER, "books")), [],
    "the export wrote into the sender's Drive folder");
});
