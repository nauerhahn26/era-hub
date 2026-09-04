// content-publish.test.mjs — step 4 of the book pipeline (plan T2.8): the
// moment a folder of photos becomes a book on the shelf. manifest.json is
// written LAST, atomically (manifest.tmp + rename), and never points at a file
// that is not already on disk — a torn or early manifest is a package the
// reader opens onto a 404.
//
// PORTS: 8433 (the real server.js, to prove booksIndex() lists what publish
// wrote). The plan's 8429/8431 slots stay unclaimed by their own suites.
//
// MONEY GUARDRAIL (plan §B.2, Gap 20): nothing here talks to a provider —
// publish is pure disk — and the spawned hub gets its own mkdtemp ERA_DATA_DIR
// so the gate's real ElevenLabs credential is nowhere near this suite. No
// ERA_*_URL seam is needed because no call is made; there is no key in this
// file and no key file is read.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const PORT = 8433;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-content-publish-"));
const BOOKS = path.join(TMP, "books");

const store = require("./content-store.js");
const publish = require("./content-publish.js");

let child;

// Synthetic bytes throughout: publish never decodes an image or an mp3, it only
// checks that the file is there and copies the cover, so a page can be any
// distinguishable blob. Never real book content.
const jpg = (n) => Buffer.alloc(64, n);
const mp3 = (n) => Buffer.concat([Buffer.from("ID3"), Buffer.alloc(8, n)]);

// A book part-way through the pipeline: pages/ + audio/ on disk and the two
// .build files the earlier steps left behind. `pages` is
// [{text, flags?, audio?, video?, cover?}] in reading order, one-based like
// content-ingest.js numbers them.
function book(name, pages, opts) {
  const o = opts || {};
  const dir = path.join(BOOKS, name);
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  const text = [], narr = [];
  pages.forEach((p, i) => {
    const index = i + 1, pad = String(index).padStart(3, "0");
    fs.writeFileSync(path.join(dir, "pages", pad + ".jpg"), jpg(index));
    text.push({ index, source: "sources/IMG_000" + index + ".jpg", text: p.text || "",
                flags: p.flags || [], cover: p.cover === undefined ? index === 1 : !!p.cover });
    if (p.audio) {
      fs.mkdirSync(path.join(dir, "audio"), { recursive: true });
      if (p.audio !== "missing") fs.writeFileSync(path.join(dir, "audio", pad + ".mp3"), mp3(index));
      narr.push({ index, audio: "audio/" + pad + ".mp3",
                  words: [{ word: (p.text || "x").split(/\s+/)[0], start: 0, end: 0.4 }] });
    }
    if (p.video) {
      fs.mkdirSync(path.join(dir, "video"), { recursive: true });
      fs.writeFileSync(path.join(dir, "video", pad + ".mp4"), Buffer.alloc(16, index));
    }
  });
  store.writeText(dir, { pages: text });
  if (narr.length || o.narration)
    store.writeAtomic(path.join(dir, ".build", "narration.json"),
      { provider: "elevenlabs", model: "eleven_multilingual_v2", voice: "JBFqnCBsd6RMkjVDRZzb",
        pages: narr });
  return dir;
}

const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

before(async () => {
  fs.mkdirSync(BOOKS, { recursive: true });
});
after(() => { if (child) child.kill("SIGKILL"); });

// ------------------------------------------------------------ the manifest

test("a three-page book publishes: schemaVersion 1, one page per photo", async () => {
  const dir = book("Tabby McTat", [
    { text: "Tabby McTat", audio: true },
    { text: "The butcher's cat.", audio: true },
    { text: "The end.", audio: true },
  ]);
  const r = await publish.publishBook(dir, { slug: "tabby-mctat", now: "2026-09-04T10:00:00.000Z" });
  assert.equal(r.published, true);
  const m = read(dir);
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.slug, "tabby-mctat");
  assert.equal(m.title, "Tabby McTat");
  assert.equal(m.authored, false);          // built here, not hand-authored
  assert.equal(m.exportedAt, "2026-09-04T10:00:00.000Z");
  assert.match(m.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(m.narration,
    { provider: "elevenlabs", model: "eleven_multilingual_v2", voice: "JBFqnCBsd6RMkjVDRZzb" });
  assert.deepEqual(m.pages.map(p => p.index), [1, 2, 3]);
  assert.deepEqual(m.pages.map(p => p.image), ["pages/001.jpg", "pages/002.jpg", "pages/003.jpg"]);
  assert.deepEqual(m.pages.map(p => p.audio), ["audio/001.mp3", "audio/002.mp3", "audio/003.mp3"]);
  assert.deepEqual(m.pages[1].words, [{ word: "The", start: 0, end: 0.4 }]);
  assert.equal(m.pages[0].text, "Tabby McTat");
  // the cover is the page text.json marked, copied to the name booksIndex()
  // defaults to
  assert.equal(m.cover, "cover.jpg");
  assert.ok(fs.readFileSync(path.join(dir, "cover.jpg")).equals(jpg(1)));
});

test("nothing half-written is left behind, and every path in the manifest exists", async () => {
  const dir = path.join(BOOKS, "Tabby McTat");
  assert.ok(!fs.existsSync(path.join(dir, ".build", "manifest.tmp")));
  assert.ok(!fs.existsSync(path.join(dir, "manifest.tmp")), "written tmp + rename");
  const m = read(dir);
  const mAt = fs.statSync(path.join(dir, "manifest.json")).mtimeMs;
  for (const p of m.pages)
    for (const rel of [p.image, p.audio, p.video].filter(Boolean)) {
      const f = path.join(dir, rel);
      assert.ok(fs.existsSync(f), rel + " must be on disk before the manifest names it");
      assert.ok(fs.statSync(f).mtimeMs <= mAt, "the manifest is written LAST");
    }
});

test("a flagged page publishes with the rest, and its flags stay in text.json", async () => {
  const dir = book("Zog", [
    { text: "Zog was the keenest.", audio: true },
    { text: "He won a gold star.", audio: true,
      flags: [{ word: "gold", reason: "the model was not sure of this word" }] },
  ]);
  await publish.publishBook(dir, { slug: "zog" });
  const m = read(dir);
  // ruling 9/4: a small mistake is tolerable, a book that never appears is not
  assert.equal(m.pages.length, 2);
  assert.equal(m.pages[1].text, "He won a gold star.");
  // …and the flag is NOT in the manifest — the reader has no use for it; the
  // review page reads text.json
  assert.equal(m.pages[1].flags, undefined);
  assert.deepEqual(store.readText(dir).pages[1].flags,
    [{ word: "gold", reason: "the model was not sure of this word" }]);
});

test("a book with text and no voice publishes silent — no audio key at all", async () => {
  const dir = book("The Gruffalo", [{ text: "A mouse took a stroll." }, { text: "The end." }]);
  const r = await publish.publishBook(dir, { slug: "the-gruffalo" });
  assert.equal(r.published, true);
  const m = read(dir);
  assert.equal(m.pages.length, 2);
  for (const p of m.pages) {
    assert.equal("audio" in p, false, "a silent page carries no audio key");
    assert.equal("words" in p, false);
    assert.ok(p.text);
  }
  // no narration.json was written, so nothing is claimed about a provider
  assert.deepEqual(m.narration, { provider: null, model: null, voice: null });
});

test("an mp3 that is not on disk publishes as a silent page, never as a 404", async () => {
  const dir = book("Room on the Broom", [{ text: "The witch had a cat.", audio: "missing" }]);
  await publish.publishBook(dir, { slug: "room-on-the-broom" });
  const m = read(dir);
  assert.equal("audio" in m.pages[0], false);
  assert.equal(m.pages[0].text, "The witch had a cat.");
});

test("a page the transcriber never reached publishes as a picture page", async () => {
  const dir = book("Stick Man", [{ text: "Stick Man lives in the family tree." }, { text: "" }]);
  await publish.publishBook(dir, { slug: "stick-man" });
  const m = read(dir);
  assert.equal(m.pages.length, 2);
  assert.equal(m.pages[1].text, "");
  assert.equal(m.pages[1].image, "pages/002.jpg");
});

// The review page's drag (plan T3.2) permutes text.json's ARRAY and renames
// nothing: a page's `index` stays welded to its photo, its audio and the flags
// bought for it. Publish has to read that array order, or the parent's drag
// lives only on the review page and the shelf keeps the scanner's guess.
test("the reading order is text.json's array order, not the scanner's numbering", async () => {
  const dir = book("Room on the Broom", [
    { text: "one", audio: true }, { text: "two", audio: true }, { text: "three", audio: true },
  ]);
  const was = store.readText(dir).pages;
  // the last page dragged to the front, exactly what content.js saveOrder writes
  store.writeText(dir, { pages: [{ ...was[2], cover: true },
                                 { ...was[0], cover: false }, { ...was[1], cover: false }] });
  await publish.publishBook(dir, { slug: "room-on-the-broom" });
  const m = read(dir);
  assert.deepEqual(m.pages.map(p => p.text), ["three", "one", "two"]);
  // every page keeps the photo and the voice that were bought for it
  assert.deepEqual(m.pages.map(p => p.image), ["pages/003.jpg", "pages/001.jpg", "pages/002.jpg"]);
  assert.deepEqual(m.pages.map(p => p.audio), ["audio/003.mp3", "audio/001.mp3", "audio/002.mp3"]);
  assert.deepEqual(m.pages.map(p => p.index), [3, 1, 2]);
  // and the cover is the page the parent starred, not page 1
  assert.ok(fs.readFileSync(path.join(dir, "cover.jpg")).equals(jpg(3)));
});

test("a photo added since text.json was written follows on the end, never dropped", async () => {
  const dir = book("The Gruffalo", [{ text: "a mouse", audio: true }, { text: "took a stroll" }]);
  // page 3's photo landed after the transcriber wrote text.json
  fs.writeFileSync(path.join(dir, "pages", "003.jpg"), jpg(3));
  await publish.publishBook(dir, { slug: "the-gruffalo" });
  const m = read(dir);
  assert.deepEqual(m.pages.map(p => p.image),
    ["pages/001.jpg", "pages/002.jpg", "pages/003.jpg"]);
  assert.equal(m.pages[2].text, "");
});

test("a second publish bumps exportedAt and keeps the book's id", async () => {
  const dir = path.join(BOOKS, "Zog");
  const before = read(dir);
  await publish.publishBook(dir, { slug: "zog", now: "2026-09-05T08:00:00.000Z" });
  const after = read(dir);
  assert.equal(after.exportedAt, "2026-09-05T08:00:00.000Z");
  assert.notEqual(after.exportedAt, before.exportedAt, "the reader cache-busts on exportedAt");
  assert.equal(after.id, before.id, "the same book, so the same id");
});

test("an animated page carries its video; a folder with no pages holds instead", async () => {
  const dir = book("Superworm", [{ text: "Superworm is super-long.", audio: true, video: true }]);
  await publish.publishBook(dir, { slug: "superworm" });
  assert.equal(read(dir).pages[0].video, "video/001.mp4");

  const empty = path.join(BOOKS, "Empty Book");
  fs.mkdirSync(empty, { recursive: true });
  const r = await publish.publishBook(empty, { slug: "empty-book" });
  assert.equal(r.hold, "no-pages");
  assert.ok(!fs.existsSync(path.join(empty, "manifest.json")), "no pages, no package");
});

// -------------------------------------------------------------- the wiring

// The walk does not stop at `published`: that state owes no step, so a job left
// there would look claimable to every hub in the family half an hour later, for
// ever. `done` is the state nothing takes back (content-worker.js settle()).
test("the worker's publish step walks a narrating job all the way to done", async () => {
  const dir = book("The Snail and the Whale", [{ text: "This is the tale.", audio: true }]);
  store.writeJob(dir, store.newJob({ claimedBy: "test", state: "narrating" }));
  const done = await new Promise((resolve, reject) => {
    const w = new Worker(path.join(HUB, "content-worker.js"), {
      workerData: { dataDir: TMP, dir, kind: "books", slug: "the-snail-and-the-whale",
                    name: "The Snail and the Whale", step: "publish" },
    });
    w.on("message", (m) => { if (m.done) resolve(m.done); });
    w.on("error", reject);
    w.on("exit", () => resolve(null));
  });
  assert.ok(done, "the worker must post a {done}");
  assert.equal(done.error, undefined);
  assert.deepEqual(done.steps.map(s => s.step), ["publish"]);
  assert.equal(store.readJob(dir).state, "done");
  assert.equal(done.state, "done");
  assert.equal(read(dir).title, "The Snail and the Whale");
});

// --------------------------------------------------------------- the shelf

test("booksIndex() lists a published book with its slug, title and page count", async () => {
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_DEVICE_ID: "test-dev" },
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { await fetch(`${BASE}/settings`); up = true; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(up, "server never came up");

  const idx = await (await fetch(`${BASE}/books/index.json`)).json();
  const tabby = idx.find(e => e.slug === "tabby-mctat");
  assert.ok(tabby, "the folder a parent named serves as its slug");
  assert.equal(tabby.title, "Tabby McTat");
  assert.equal(tabby.pages, 3);
  assert.equal(tabby.authored, false);
  assert.equal(tabby.hasVideo, false);
  assert.equal(idx.find(e => e.slug === "superworm").hasVideo, true);
  assert.ok(!idx.some(e => e.slug === "empty-book"), "a folder with no manifest is not a book");
  // the manifest publish wrote actually serves, and so does the cover it made
  const m = await fetch(`${BASE}/books/tabby-mctat/manifest.json`);
  assert.equal(m.status, 200);
  assert.equal((await m.json()).pages.length, 3);
  assert.equal((await fetch(`${BASE}${tabby.cover}`)).status, 200);
  // …and the builder's scratch is still private (T1.3's deny, unchanged here)
  assert.equal((await fetch(`${BASE}/books/tabby-mctat/.build/text.json`)).status, 404);
});
