// books-share.test.mjs — the policy between a book and another family's hub
// (plan T2.1). erabook.js is the format; this is everything the format is not
// allowed to decide.
//
// What this file proves, and why each half matters:
//
//  1. ONLY THE BOOK TRAVELS. The manifest is the inventory, so `sources/` (the
//     originals a parent dropped in — often ten times the rest of the package
//     and full of their own child), `.build/` (the builder's scratch) and any
//     loose file beside them are simply not in the archive. A manifest that
//     NAMES one of those is refused rather than obeyed: the deny list is the
//     serve side's law too, and an export that walked a hand-edited manifest
//     into sources/ would mail a stranger a family's photographs.
//
//  2. THE BOOK LANDS WHERE NEW CONTENT LANDS. music-add.js's law #1: the
//     family's Drive content folder, never <DATA>. <DATA> is one device's
//     shelf, which the mirror fills; a book written there would exist on one PC
//     and the next prune would eat it. So the import writes the package into
//     <folderPath>/books and then nudges the shelf with drive.mirrorBook — and
//     NEVER drive.sync(), whose fan-out starts a vision spend on photos nobody
//     touched (preflight, 9/22). That is asserted here by spying on both.
//
//  3. A SECOND COPY IS NOT AN OVERWRITE. A family that is sent the same book
//     twice gets two books. The first one's slug — which is where the reader
//     keeps a child's place in it — does not move.
//
//  4. THE DIRECTORY NAME IS A JAIL, NOT A NICETY. The title comes from another
//     family's computer. Separators, colons, control characters, a trailing dot
//     (Windows silently drops one, so the folder you then write to is not the
//     one you made), a name longer than any filesystem wants, and the Windows
//     reserved device names — CON, PRN, AUX, NUL, COM1-9, LPT1-9 — are every
//     one of them a name this import must not create.
//
//  5. EVERY REFUSAL IS A SENTENCE. Spec §5.2's table is the contract: a parent
//     standing at the tablet is told what happened in words they can act on,
//     and never a 500, a stack, or an error code. Each row has a test.
//
// Unit: no server, no port, no network. drive.js is driven directly with a
// throwaway <DATA> and a throwaway "Drive folder", which is what makes the
// where-it-lands assertions real rather than mocked. Fixture content is
// synthetic throughout — never a real book.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-books-share-"));
const DATA = path.join(TMP, "data");                            // this device's shelf
const MOUNT = path.join(TMP, "My Drive");
const FOLDER = path.join(MOUNT, "New ERA Content");             // what the family picked
const SHELF = path.join(DATA, "books");                         // <DATA>/books
const DRIVE_BOOKS = path.join(FOLDER, "books");                 // where new content goes
const DRIVE_CFG = path.join(DATA, "drive.json");

let drive, erabook, share;
const booksIndex = require("./books-index.js");
// The slug this device's shelf has given a package directory. Forced, because
// a directory created a moment ago is younger than the index's mtime cache.
function slugOf(dirName) {
  booksIndex.bookDirs(SHELF, true);
  return booksIndex.slugFor(SHELF, dirName);
}
let n = 0;
const scratch = (what) => {
  const d = path.join(TMP, what + "-" + (++n));
  fs.mkdirSync(d, { recursive: true });
  return d;
};

before(() => {
  fs.mkdirSync(SHELF, { recursive: true });
  fs.mkdirSync(DRIVE_BOOKS, { recursive: true });
  fs.writeFileSync(DRIVE_CFG, JSON.stringify({ mode: "local", folderPath: FOLDER }));
  drive = require("./drive.js");
  erabook = require("./erabook.js");
  drive.start(DATA);            // its timers are unref'd; nothing here syncs
  share = require("./books-share.js");
  share.start(DATA);
});
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

// ------------------------------------------------------------- the fixture
//
// The shape of a real package (tests/reader-ui.test.mjs:93): manifest.json and
// cover.jpg at the root, pages/ audio/ video/ beneath, and the two directories
// an export must never carry beside them.
const JPEG = (k) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(48, k)]);
const WAV = (k) => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40, k)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(24, 9)]);

function manifestFor(over) {
  return {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000002",
    slug: "luna-the-fox",
    title: "Luna the Fox",
    authored: true,
    exportedAt: "2026-08-24T00:00:00Z",
    cover: "cover.jpg",
    pages: [
      { index: 0, image: "pages/001.jpg", text: "Luna naps now.", audio: "audio/001.wav" },
      { index: 1, image: "pages/002.jpg", text: "The fox sleeps.", audio: "audio/002.wav",
        video: "video/002.mp4" },
      { index: 2, image: "pages/003.jpg", text: "", audio: null },   // a silent page
    ],
    ...(over || {}),
  };
}

// A published package on disk, under `root`, in a directory of its own.
function packageAt(root, dirName, over) {
  const dir = path.join(root, dirName);
  for (const sub of ["pages", "audio", "video", "sources", ".build"])
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  for (const p of ["001", "002", "003"]) fs.writeFileSync(path.join(dir, "pages", p + ".jpg"), JPEG(+p));
  for (const p of ["001", "002"]) fs.writeFileSync(path.join(dir, "audio", p + ".wav"), WAV(+p));
  fs.writeFileSync(path.join(dir, "video", "002.mp4"), MP4);
  fs.writeFileSync(path.join(dir, "cover.jpg"), JPEG(0));
  // The three things that must not travel: the originals, the scratch, and a
  // loose file the manifest never named.
  fs.writeFileSync(path.join(dir, "sources", "IMG_0001.jpg"), JPEG(7));
  fs.writeFileSync(path.join(dir, ".build", "text.json"), '{"pages":[]}');
  fs.writeFileSync(path.join(dir, "notes.json"), '{"nobody":"named me"}');
  const m = manifestFor(over);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  return { dir, manifest: m };
}

async function drain(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

// A real .erabook on disk, made the way the send sheet makes one: publish a
// package on THIS hub's shelf and export it.
async function erabookOf(dirName, over) {
  packageAt(SHELF, dirName, over);
  const out = share.exportBook(slugOf(dirName));
  assert.equal(out.error, undefined, "export refused: " + out.message);
  const f = path.join(scratch("out"), "book.erabook");
  fs.writeFileSync(f, await drain(out.stream));
  fs.rmSync(path.join(SHELF, dirName), { recursive: true, force: true });   // sender's copy gone
  return f;
}

// What is actually inside an archive, by name.
function entriesOf(file) {
  const dest = scratch("peek");
  return erabook.unpack(file, dest).files;
}

// ------------------------------------------------------- hostile archives
//
// Built here, by hand, out of raw zip records — never by asking erabook.js to
// make them. A test that can only express the attacks its subject is willing
// to write down is not a test. (The same writer as erabook.test.mjs, trimmed
// to what a POLICY test needs to lie about: which entries exist at all.)
function rawZip(entries, opts) {
  const o = opts || {};
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "binary");
    const data = e.data || Buffer.alloc(0);
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(33, 12);
    lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(33, 14);
    ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    parts.push(lh, name, data);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(o.count === undefined ? entries.length : o.count, 8);
  eocd.writeUInt16LE(o.count === undefined ? entries.length : o.count, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, eocd]);
}

const envelope = (over) => ({ name: ".erabook.json", data: Buffer.from(JSON.stringify({
  v: 1, title: "Luna the Fox", slug: "luna-the-fox", pages: 3,
  exportedAt: "2026-08-24T00:00:00Z", from: { app: "New ERA", build: "20260922.1200" },
  ...(over || {}),
})) });

function rawFile(entries, opts) {
  const f = path.join(scratch("raw"), "hostile.erabook");
  fs.writeFileSync(f, rawZip(entries, opts));
  return f;
}

// drive.sync must never be reached from an import (preflight blocker #1), and
// drive.mirrorBook must be. Both are spied rather than asserted from the files
// on disk, because "the book arrived" is true of either route and only one of
// them is free.
function spyDrive(run) {
  const realSync = drive.sync, realMirror = drive.mirrorBook;
  const calls = { sync: 0, mirror: [] };
  drive.sync = async () => { calls.sync++; throw new Error("drive.sync() must not be called by an import"); };
  drive.mirrorBook = (name) => { calls.mirror.push(name); return realMirror.call(drive, name); };
  try { return { calls, out: run() }; }
  finally { drive.sync = realSync; drive.mirrorBook = realMirror; }
}

// The family's content folder, taken away and given back around one test.
// Awaited, so an async door is still inside the window when it reads
// drive.json rather than after the folder has been handed back.
async function withoutContentFolder(run) {
  const had = fs.readFileSync(DRIVE_CFG, "utf8");
  fs.writeFileSync(DRIVE_CFG, JSON.stringify({}));
  try { return await run(); }
  finally { fs.writeFileSync(DRIVE_CFG, had); }
}

const leftovers = () => fs.readdirSync(DRIVE_BOOKS).filter(n2 => n2.startsWith("."));

// =========================================================== 1. what travels

test("the export carries the manifest, the cover and the files it names — and nothing else", async () => {
  const f = await erabookOf("Luna the Fox");
  const names = entriesOf(f).sort();
  assert.deepEqual(names, [
    ".erabook.json", "audio/001.wav", "audio/002.wav", "cover.jpg", "manifest.json",
    "pages/001.jpg", "pages/002.jpg", "pages/003.jpg", "video/002.mp4",
  ]);
});

test("sources/ and .build/ are not in the archive", async () => {
  const f = await erabookOf("Sources Book");
  const names = entriesOf(f);
  assert.equal(names.some(x => x.startsWith("sources/")), false, "sources/ escaped into the archive");
  assert.equal(names.some(x => x.startsWith(".build/")), false, ".build/ escaped into the archive");
});

test("a file the manifest does not name is not in the archive", async () => {
  const f = await erabookOf("Loose File Book");
  assert.equal(entriesOf(f).includes("notes.json"), false);
});

test("a manifest that NAMES a file under sources/ is refused, not obeyed", () => {
  packageAt(SHELF, "Leaky Book", {
    pages: [{ index: 0, image: "sources/IMG_0001.jpg", text: "", audio: null }],
  });
  const out = share.exportBook(slugOf("Leaky Book"));
  assert.equal(out.error, "private-file");
  assert.match(out.message, /New ERA/);
  fs.rmSync(path.join(SHELF, "Leaky Book"), { recursive: true, force: true });
});

test("a manifest naming a missing file refuses rather than shipping a book with a hole", () => {
  packageAt(SHELF, "Holey Book", {
    pages: [{ index: 0, image: "pages/009.jpg", text: "", audio: null }],
  });
  const out = share.exportBook(slugOf("Holey Book"));
  assert.equal(out.error, "missing-file");
  fs.rmSync(path.join(SHELF, "Holey Book"), { recursive: true, force: true });
});

test("a package with no manifest is not a finished book and cannot be shared", () => {
  fs.mkdirSync(path.join(SHELF, "Half Built"), { recursive: true });
  const out = share.exportBook(slugOf("Half Built"));
  assert.equal(out.error, "not-finished");
  fs.rmSync(path.join(SHELF, "Half Built"), { recursive: true, force: true });
});

test("an unknown slug is not a book", () => {
  assert.equal(share.exportBook("no-such-book").error, "no-such-book");
});

// ============================================== 2. the header a title becomes

test("a title with a newline and a quote in it cannot split the response", () => {
  const v = share.disposition('Rae\'s "D\ria"\nX-Evil: yes');
  assert.equal(/[\r\n]/.test(v), false, "a header value carrying CR or LF: " + JSON.stringify(v));
  // Exactly the two that delimit filename=; a third would end the value early
  // and let a book's name write headers of its own.
  assert.equal((v.match(/"/g) || []).length, 2, "a quote came through the title: " + JSON.stringify(v));
  assert.match(v, /^attachment; filename="/);
});

test("a title that is not ASCII still arrives named — RFC 5987 beside the plain filename", () => {
  const v = share.disposition("Rae's Día");
  assert.match(v, /filename\*=UTF-8''/);
  assert.match(v, /%C3%ADa\.erabook/);
});

// ================================================= 3. put it in my Drive

test("share-to-drive writes the bytes to <folderPath>/shared and says where", async () => {
  // Named for the book's TITLE, not for the folder it sits in: the file is
  // about to travel to somebody who has never seen either.
  packageAt(SHELF, "Drive Bound", { title: "Drive Bound" });
  const r = await share.shareToDrive(slugOf("Drive Bound"));
  assert.equal(r.error, undefined, "refused: " + r.message);
  assert.equal(r.path, path.join(FOLDER, "shared", "Drive Bound.erabook"));
  assert.equal(fs.existsSync(r.path), true, "nothing was written");
  // It is a real .erabook, not a promise of one.
  assert.deepEqual(entriesOf(r.path).includes("manifest.json"), true);
  fs.rmSync(path.join(SHELF, "Drive Bound"), { recursive: true, force: true });
});

test("share-to-drive with no content folder says needs-local-drive, drive.mirrorBook's own word", async () => {
  packageAt(SHELF, "Homeless Book");
  const r = await withoutContentFolder(() => share.shareToDrive(slugOf("Homeless Book")));
  assert.equal(r.error, "needs-local-drive");
  assert.match(r.message, /content folder/i);
  fs.rmSync(path.join(SHELF, "Homeless Book"), { recursive: true, force: true });
});

// =============================================== 4. where an import lands

test("an import lands in the family's Drive folder, and reaches <DATA> only through the mirror", async () => {
  const f = await erabookOf("Landing Book", { title: "Landing Book", slug: "landing-book" });
  const stopMirror = drive.mirrorBook;
  drive.mirrorBook = () => ({ book: "Landing Book", files: 0, skipped: 0, removed: 0, errors: [] });
  let r;
  try { r = share.importBook(f); } finally { drive.mirrorBook = stopMirror; }
  assert.equal(r.error, undefined, "refused: " + r.message);
  // The law: new content is written where Google Drive uploads it.
  assert.equal(fs.existsSync(path.join(DRIVE_BOOKS, "Landing Book", "manifest.json")), true,
    "the package is not in the family's Drive folder");
  // …and nowhere else. With the mirror stubbed out, <DATA> must be untouched:
  // an import that wrote <DATA> directly would pass every other test in this
  // file and be eaten by the next prune.
  assert.equal(fs.existsSync(path.join(SHELF, "Landing Book")), false,
    "the import wrote <DATA> itself");
  assert.equal(leftovers().length, 0, "a temp unpack directory was left behind");
});

test("the import nudges the shelf with drive.mirrorBook and never with drive.sync", async () => {
  const f = await erabookOf("Mirror Book", { title: "Mirror Book", slug: "mirror-book" });
  const { calls, out } = spyDrive(() => share.importBook(f));
  assert.equal(out.error, undefined, "refused: " + out.message);
  assert.equal(calls.sync, 0, "drive.sync() was called — that is a vision spend per import");
  assert.deepEqual(calls.mirror, ["Mirror Book"]);
  assert.equal(fs.existsSync(path.join(SHELF, "Mirror Book", "manifest.json")), true,
    "the book never reached this device's shelf");
  assert.equal(out.slug, "mirror-book");
  assert.equal(out.title, "Mirror Book");
});

test("a second copy of the same book is a second book, and the first keeps its slug", async () => {
  const f = await erabookOf("Twice Book", { title: "Twice Book", slug: "twice-book" });
  const first = share.importBook(f);
  assert.equal(first.error, undefined, "refused: " + first.message);
  assert.equal(first.slug, "twice-book");

  const again = await erabookOf("Twice Book Source", { title: "Twice Book", slug: "twice-book" });
  const second = share.importBook(again);
  assert.equal(second.error, undefined, "refused: " + second.message);
  assert.equal(second.dir, "Twice Book-2", "the second copy overwrote or renamed the first");
  assert.equal(fs.existsSync(path.join(DRIVE_BOOKS, "Twice Book", "manifest.json")), true);
  assert.equal(fs.existsSync(path.join(DRIVE_BOOKS, "Twice Book-2", "manifest.json")), true);
  // The reader keeps a child's place per slug. The book she is halfway through
  // must not be renamed by a newcomer — asserted AFTER the second import, over
  // the index as it now stands, because "it was right before" proves nothing.
  assert.equal(slugOf("Twice Book"), "twice-book");
  assert.notEqual(second.slug, first.slug);
});

// ========================================= 5. the directory name is a jail

// Each of these imports a book whose TITLE came from another family's computer
// and asserts the directory this hub actually made.
async function importTitled(sourceDir, title, slug) {
  const f = await erabookOf(sourceDir, { title, slug });
  const r = share.importBook(f);
  assert.equal(r.error, undefined, "refused: " + r.message);
  return r.dir;
}

test("a title with separators and a colon cannot name a directory anywhere else", async () => {
  const dir = await importTitled("Jail A", "../../Windows/System32:evil", "jail-a");
  assert.equal(/[\\/:]/.test(dir), false, "the directory name kept a separator or a colon: " + dir);
  assert.equal(fs.existsSync(path.join(DRIVE_BOOKS, dir, "manifest.json")), true);
});

test("a trailing dot is trimmed — Windows drops one silently and the folder moves", async () => {
  const dir = await importTitled("Jail B", "Luna the Fox.", "jail-b");
  assert.equal(dir, "Luna the Fox");
});

test("a title of nothing but punctuation falls back to the slug", async () => {
  const dir = await importTitled("Jail C", ":::", "the-quiet-book");
  assert.equal(dir, "the-quiet-book");
});

test("a title AND a slug that both clean away fall back to \"book\"", async () => {
  const dir = await importTitled("Jail D", ":::", ":::");
  assert.equal(dir, "book");
});

test("a very long title is capped at 64 characters", async () => {
  const dir = await importTitled("Jail E", "L".repeat(200), "jail-e");
  assert.equal(dir.length, 64);
});

test("CON is a Windows device, not a folder — it falls back to the slug", async () => {
  const dir = await importTitled("Jail F", "CON", "luna-of-the-wood");
  assert.equal(dir, "luna-of-the-wood");
});

// Runs straight after the test above, which already took "book": a reserved
// name WITH an extension is still a device, a reserved SLUG is no better a
// fallback, and the name this leaves is the numeric suffix doing its job.
test("a reserved name with an extension, and a reserved slug, land on the next free \"book\"", async () => {
  const dir = await importTitled("Jail G", "nul.txt", "CON");
  assert.equal(dir, "book-2");
});

test("every reserved device name is refused, not just CON", async () => {
  // COM1-9 and LPT1-9 are nine each; one of each family stands for the rest
  // here, the whole list being asserted through the cleaner in one import each
  // would cost twenty archives to prove one regular expression.
  for (const [i, name] of ["PRN", "AUX", "COM3", "LPT9"].entries()) {
    const dir = await importTitled("Jail H" + i, name, "reserved-" + i);
    assert.equal(dir, "reserved-" + i, name + " was allowed to name a directory");
  }
});

// ============================================ 6. every refusal is a sentence

// Spec §5.2's table, row by row. `error` is the code the sheet switches on;
// `message` is the only thing a parent ever reads.
function refused(file, code, sentence) {
  const r = share.importBook(file);
  assert.equal(r.ok, undefined, "that was accepted");
  assert.equal(r.error, code);
  if (sentence) assert.equal(r.message, sentence);
  assert.equal(leftovers().length, 0, "a temp unpack directory was left behind by a refusal");
  return r;
}

test("a file that is not a zip at all: \"That file isn't a New ERA book.\"", () => {
  const f = path.join(scratch("raw"), "holiday.jpg");
  fs.writeFileSync(f, JPEG(3));
  refused(f, "not-a-zip", "That file isn't a New ERA book.");
});

test("a zip with no envelope in it: \"That file isn't a New ERA book.\"", () => {
  const f = rawFile([
    { name: "manifest.json", data: Buffer.from("{}") },
    { name: "cover.jpg", data: JPEG(1) },
  ]);
  refused(f, "no-envelope", "That file isn't a New ERA book.");
});

test("an envelope from a newer New ERA: update this computer", () => {
  const f = rawFile([
    envelope({ v: 2 }),
    { name: "manifest.json", data: Buffer.from("{}") },
  ]);
  refused(f, "future-version",
    "That book was made by a newer New ERA. Update this computer and try again.");
});

test("a manifest that does not parse: \"That book's file is damaged\"", () => {
  const f = rawFile([
    envelope(),
    { name: "manifest.json", data: Buffer.from("{\"title\": \"Luna") },
  ]);
  refused(f, "bad-manifest", "That book's file is damaged - ask them to send it again.");
});

test("a manifest naming a file the zip does not hold: damaged", () => {
  const f = rawFile([
    envelope(),
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifestFor())) },
    { name: "cover.jpg", data: JPEG(0) },
  ]);
  refused(f, "manifest-mismatch", "That book's file is damaged - ask them to send it again.");
});

test("a zip holding a file the manifest never named: damaged", () => {
  const m = { schemaVersion: 1, title: "Luna the Fox", slug: "luna-the-fox",
              cover: "cover.jpg", pages: [] };
  const f = rawFile([
    envelope(),
    { name: "manifest.json", data: Buffer.from(JSON.stringify(m)) },
    { name: "cover.jpg", data: JPEG(0) },
    { name: "pages/001.jpg", data: JPEG(1) },      // nobody asked for this
  ]);
  refused(f, "manifest-mismatch", "That book's file is damaged - ask them to send it again.");
});

test("an archive with more entries than a book has: \"That file is too big to be a book.\"", () => {
  const many = [envelope()];
  for (let i = 0; i < 2100; i++) many.push({ name: "pages/" + i + ".jpg", data: JPEG(i & 255) });
  // One code for every cap: the sheet has one thing to say and a parent has
  // one thing to do about it, whichever of the three the archive blew.
  refused(rawFile(many), "too-big", "That file is too big to be a book.");
});

test("no content folder on this computer: set one up first", async () => {
  const f = await erabookOf("No Folder Book", { title: "No Folder Book", slug: "no-folder-book" });
  const r = await withoutContentFolder(() => share.importBook(f));
  assert.equal(r.error, "needs-local-drive");
  assert.match(r.message, /content folder/i);
  // "+ the link Settings already uses" (spec §5.2): the sheet must be able to
  // send the parent somewhere, not just tell them they are stuck.
  assert.equal(r.settings, "/settings/#integrations");
});

test("nowhere to write it: \"There wasn't room to save the book.\"", async () => {
  const f = await erabookOf("Unwritable Book", { title: "Unwritable Book", slug: "unwritable-book" });
  // A books "directory" that is a file: every write under it fails the way a
  // full or read-only disk fails, without needing either.
  const blocked = path.join(MOUNT, "Blocked Content");
  fs.mkdirSync(blocked, { recursive: true });
  fs.writeFileSync(path.join(blocked, "books"), "not a directory");
  const had = fs.readFileSync(DRIVE_CFG, "utf8");
  fs.writeFileSync(DRIVE_CFG, JSON.stringify({ mode: "local", folderPath: blocked }));
  try {
    const r = share.importBook(f);
    assert.equal(r.error, "write-failed");
    assert.equal(r.message, "There wasn't room to save the book.");
  } finally { fs.writeFileSync(DRIVE_CFG, had); }
});

// ====================================== 7. a title that is not well-formed text
//
// A JavaScript string is UTF-16 CODE UNITS, not characters, and nothing
// guarantees the ones in another family's manifest are paired. JSON.stringify
// writes a lone surrogate as the escape "\ud800" and JSON.parse hands it back,
// so one travels through a .erabook intact and arrives as a title.
//
// encodeURIComponent THROWS URIError on one. That is not a refusal — it is not
// an erabook.RefusalError, so exportBook's catch does not see it — and the GET
// /books/<slug>.erabook route has no try of its own: the throw escapes the
// http.createServer callback and the hub DIES. A book that imports without a
// word becomes a delayed kill switch, and the hub dying is a non-verbal child
// losing her voice mid-sentence.
//
// Two layers, and this section proves both, because one is one refactor away
// from being the only one:
//
//   the NAME must not hold one — it is about to become a directory in the
//   family's Drive folder and mirror to every device, and \ud800 is not a thing
//   anybody can read, type or delete; and
//
//   the HEADER encoder must not be able to throw whatever it is handed, even a
//   lone surrogate that never went near the cleaner.
//
// The second is not hypothetical even with the first in place: cleanName caps
// at 64 CODE UNITS, and a cut at 64 can land BETWEEN a surrogate pair and
// manufacture a lone one out of a title that was perfectly well-formed. A book
// called "L…L🦊" is not hostile. It was a kill switch too.

test("a lone surrogate in a title cannot throw on the way into a header", () => {
  // Called with the raw title, never a pre-cleaned name: this is what the route
  // does, and it is where the hub died.
  for (const title of ["\ud800Luna", "Luna\udfff", "\udc00", "Luna 🦊 \ud800"]) {
    let v;
    assert.doesNotThrow(() => { v = share.disposition(title); }, JSON.stringify(title));
    assert.match(v, /^attachment; filename="[ -~]*"; filename\*=UTF-8''/,
      "not a header value: " + JSON.stringify(v));
    // Whatever survives is well-formed text — a header that carried a lone
    // surrogate would be the same bug one layer further out.
    assert.ok(v.isWellFormed(), "the header value is not well-formed: " + JSON.stringify(v));
  }
});

test("the 64-character cap cannot cut a surrogate pair in half", () => {
  // A title nobody meant as an attack: 63 letters and a fox. The cap lands
  // between the fox's two code units.
  const title = "L".repeat(63) + "🦊";
  let v;
  assert.doesNotThrow(() => { v = share.disposition(title); });
  assert.ok(v.isWellFormed(), "the header value is not well-formed: " + JSON.stringify(v));
  assert.equal(/%ED%A0/.test(v), false, "a half a fox was percent-encoded into the header: " + v);
});

test("a lone surrogate in a title never becomes a folder name, and a real pair survives", async () => {
  // Built by hand out of raw records, the way every other hostile archive here
  // is: this book came off somebody else's computer and our own export is not
  // allowed to be the only thing that can express it.
  const title = "\ud800Luna 🦊";           // a lone surrogate AND a real fox
  const m = { schemaVersion: 1, slug: "surrogate-book", title, cover: "cover.jpg",
              pages: [{ index: 0, image: "pages/001.jpg", text: "", audio: null }] };
  const f = rawFile([
    envelope({ title, slug: "surrogate-book" }),
    { name: "manifest.json", data: Buffer.from(JSON.stringify(m)) },
    { name: "cover.jpg", data: JPEG(0) },
    { name: "pages/001.jpg", data: JPEG(1) },
  ]);

  const r = share.importBook(f);
  assert.equal(r.error, undefined, "refused: " + r.message);
  // The name is about to be a directory in the family's Drive folder and mirror
  // to every device they own. Stripped, not replaced: a "�" in a folder
  // name is not better than a "\ud800" in one.
  assert.equal(r.dir, "Luna 🦊", "the folder name is " + JSON.stringify(r.dir));
  assert.ok(r.dir.isWellFormed(), "the folder name is not well-formed text");
  assert.equal(fs.existsSync(path.join(DRIVE_BOOKS, r.dir, "manifest.json")), true);

  // …and then the delayed half. The book is on the shelf and looks fine; this
  // is the request that used to kill the hub.
  let out;
  assert.doesNotThrow(() => { out = share.exportBook(r.slug); },
    "GET /books/<slug>.erabook threw — the hub would be gone");
  assert.equal(out.error, undefined, "refused: " + out.message);
  assert.ok(out.disposition.isWellFormed());
  assert.equal(entriesOf(await (async () => {
    const p = path.join(scratch("out"), "again.erabook");
    fs.writeFileSync(p, await drain(out.stream));
    return p;
  })()).includes("manifest.json"), true, "the book did not come back out");
});

test("an unexpected fault while sending is a sentence, not a stack", () => {
  // Belt and braces for the CLASS rather than today's instance. The GET route
  // has no try of its own — it cannot have one and still stream — so anything
  // exportBook lets escape kills the hub. Forced from a helper that has no
  // catch anywhere near it.
  packageAt(SHELF, "Faulty Book", { title: "Faulty Book" });
  const slug = slugOf("Faulty Book");
  const real = booksIndex.dirFor;
  booksIndex.dirFor = () => { throw new TypeError("something nobody wrote a sentence for"); };
  let out;
  try { assert.doesNotThrow(() => { out = share.exportBook(slug); }); }
  finally { booksIndex.dirFor = real; }
  assert.equal(out.error, "send-failed");
  assert.match(out.message, /New ERA did not send it\.$/);
  fs.rmSync(path.join(SHELF, "Faulty Book"), { recursive: true, force: true });
});

// ========================== 8. the manifest travels, and keeps travelling

// The law this feature's `authored` fix exists to protect (law 3). A book that
// arrived here and is then passed on to a THIRD family must leave carrying the
// manifest its author published — down to the key order, the whitespace and
// `authored: true` — because the manifest is the book's own record of itself
// and this hub is a courier, not an editor. The shelf's refusal to repeat that
// flag as "<this child>'s story" is a decision about a BADGE, made where the
// badge is made; nothing about it may reach the bytes.
test("a re-export of an imported book carries the sender's manifest byte for byte", async () => {
  const f = await erabookOf("Faithful Book", { title: "Faithful Book", slug: "faithful-book" });
  const sentDir = scratch("sent");
  erabook.unpack(f, sentDir);                       // the manifest as it crossed
  const sent = fs.readFileSync(path.join(sentDir, "manifest.json"));
  assert.equal(JSON.parse(sent).authored, true, "the fixture was supposed to be authored");

  const got = share.importBook(f);
  assert.equal(got.error, undefined, "refused: " + got.message);
  // The mark the shelf reads is beside the manifest on BOTH copies: the
  // family's Drive folder, and the <DATA> shelf the mirror filled from it. A
  // marker that did not survive the mirror would be no marker at all.
  for (const root of [DRIVE_BOOKS, SHELF])
    assert.equal(fs.existsSync(path.join(root, got.dir, ".erabook.json")), true,
      "no envelope beside the manifest in " + root);

  const out = share.exportBook(got.slug);
  assert.equal(out.error, undefined, "re-export refused: " + out.message);
  const againDir = scratch("again");
  const again = path.join(scratch("out"), "again.erabook");
  fs.writeFileSync(again, await drain(out.stream));
  erabook.unpack(again, againDir);
  const rebroadcast = fs.readFileSync(path.join(againDir, "manifest.json"));
  assert.ok(rebroadcast.equals(sent),
    "the manifest was edited in transit:\n" + sent.toString() + "\n---\n" + rebroadcast.toString());
  assert.equal(JSON.parse(rebroadcast).authored, true,
    "the flag was cleared on the way out — the third family loses the truth");
  // The old envelope is NOT one of the entries: every export writes its own,
  // from this hub, so the last sender is the one the next hub reads.
  const names = erabook.unpack(again, scratch("peek")).files;
  assert.equal(names.filter(n2 => n2 === ".erabook.json").length, 1);
});

// ================================================= 9. the one shared list

test("BOOK_EXTS and BOOK_DENY_DIRS are one list, and the format reads the same one", () => {
  assert.deepEqual(share.BOOK_EXTS, erabook.EXTS,
    "export, import and serving must read one extension list");
  assert.deepEqual(share.BOOK_DENY_DIRS, ["sources", ".build"]);
});
