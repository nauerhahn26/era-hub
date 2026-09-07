// content-loose.test.mjs — the pile of photos a parent dropped straight into
// books/ without making a folder (dad 9/7: "I didn't put into, like, a folder
// and name it… you should assume they are [one book], and let me say
// otherwise"). Two halves:
//
//   content-gather.js  the disk rules — one pile is one folder, a photo is
//                      moved and never deleted, an interrupted move is finished
//                      rather than restarted, and a model's title is turned
//                      into a name Windows will actually take.
//   content.js         the decision — the same ten-minute quiet clock a book
//                      folder is on, the claim, the `autoTitle` note, the
//                      rename door, and the loose count /content/status
//                      publishes so no card ever says "no books yet" over the
//                      top of seventeen photos.
//
// Disk plus a fake clock: no server, no port, no network, no key, no model, and
// no real waiting. Every title here is synthetic ("Sunny Pond").
// (Port table: this suite claims none.)
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-loose-"));
const DATA = path.join(TMP, "data");
const FOLDER = path.join(TMP, "My Drive", "New ERA Content");   // what Drive for Desktop shows
const BOOKS = path.join(FOLDER, "books");

let content, store, drive, gather;

const MIN = 60 * 1000;
const T0 = Date.parse("2026-09-07T09:00:00.000Z");

function driveCfg(cfg) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "drive.json"), JSON.stringify(cfg));
}

// A photo landing in books/ itself — the thing that was invisible until 9/7.
// Bytes, not pixels: nothing in this suite decodes anything.
const drop = (name, bytes) => fs.writeFileSync(path.join(BOOKS, name), Buffer.alloc(bytes || 64, 7));
const inBooks = () => fs.readdirSync(BOOKS).sort();
const dirs = () => fs.readdirSync(BOOKS, { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name).sort();
const looseLeft = () => gather.looseNames(BOOKS);

before(() => {
  fs.mkdirSync(BOOKS, { recursive: true });
  driveCfg({ mode: "local", folderPath: FOLDER });
  drive = require("./drive.js");
  drive.start(DATA);
  store = require("./content-store.js");
  gather = require("./content-gather.js");
  content = require("./content.js");
  content.start(DATA);
});

beforeEach(async () => {
  await content.idle();
  fs.rmSync(BOOKS, { recursive: true, force: true });
  fs.mkdirSync(BOOKS, { recursive: true });
  driveCfg({ mode: "local", folderPath: FOLDER });
  content._testReset();
  // No build here is a real one: this suite is about which pile becomes which
  // folder, not about what a build does (content-worker.test.mjs is).
  content.runJob = () => Promise.resolve({ ok: true });
});

// ---------------------------------------------------- a name Windows will take

test("safeTitle keeps a title and drops what NTFS refuses", () => {
  assert.equal(gather.safeTitle("Sunny Pond"), "Sunny Pond");
  assert.equal(gather.safeTitle('  Sunny: Pond?  '), "Sunny Pond");
  assert.equal(gather.safeTitle("Sunny/Pond"), "Sunny Pond");
});

test("safeTitle takes the first line — a model often sends the byline on a second", () => {
  assert.equal(gather.safeTitle("Sunny Pond\nby A. Writer"), "Sunny Pond");
});

test("safeTitle refuses the names that would make a book unreachable", () => {
  assert.equal(gather.safeTitle(""), "", "nothing at all");
  assert.equal(gather.safeTitle("..."), "", "a name made only of dots");
  assert.equal(gather.safeTitle("CON"), "", "a Windows device name");
  assert.equal(gather.safeTitle("nul.txt"), "", "…with an extension on it");
  // A leading dot would make the finished book INVISIBLE — books-index.js skips
  // dot directories, so it would build perfectly and never reach a shelf.
  assert.equal(gather.safeTitle(".Sunny Pond"), "Sunny Pond");
  // Windows silently eats a trailing dot, so the path we wrote down would be
  // wrong by one character for ever after.
  assert.equal(gather.safeTitle("Sunny Pond."), "Sunny Pond");
});

test("safeTitle caps a runaway answer at a folder name, on a word boundary", () => {
  const long = gather.safeTitle(("Sunny Pond ").repeat(20));
  assert.ok(long.length <= gather.MAX_TITLE, long.length + " characters");
  assert.ok(!/\s$/.test(long), "no trailing space");
});

test("the placeholder name is today, in the parent's own day", () => {
  const noon = new Date(2026, 8, 7, 12, 0, 0).getTime();      // local 7 Sept 2026
  assert.equal(gather.fallbackTitle(noon), "New book 2026-09-07");
});

// ------------------------------------------------------------------ the move

test("one pile becomes one folder, and every photo is MOVED into it", () => {
  drop("IMG_0001.HEIC"); drop("IMG_0002.HEIC"); drop("IMG_0003.jpg");
  const g = gather.gather(BOOKS, { now: T0 });
  assert.equal(g.moved, 3);
  assert.deepEqual(dirs(), ["New book 2026-09-07"], "exactly one folder, named for today");
  assert.deepEqual(looseLeft(), [], "nothing left loose");
  assert.deepEqual(fs.readdirSync(g.dir).sort(), ["IMG_0001.HEIC", "IMG_0002.HEIC", "IMG_0003.jpg"]);
  assert.equal(fs.existsSync(path.join(BOOKS, gather.MARKER)), false, "the marker is cleared");
});

test("the hub never creates books/ — a missing folder is nothing to gather", () => {
  fs.rmSync(BOOKS, { recursive: true, force: true });
  assert.equal(gather.gather(BOOKS, { now: T0 }), null);
  assert.equal(fs.existsSync(BOOKS), false, "and it is still not there");
});

test("an interrupted move is FINISHED into the same folder, never restarted", () => {
  // What a hub that died half way leaves behind: a folder with some of the
  // photos in it, the rest still loose, and the marker naming where they go.
  fs.mkdirSync(path.join(BOOKS, "New book 2026-09-07"));
  fs.writeFileSync(path.join(BOOKS, "New book 2026-09-07", "IMG_0001.HEIC"), Buffer.alloc(64, 7));
  fs.writeFileSync(path.join(BOOKS, gather.MARKER),
    JSON.stringify({ dir: "New book 2026-09-07", startedAt: new Date(T0).toISOString() }));
  drop("IMG_0002.HEIC"); drop("IMG_0003.HEIC");

  const g = gather.gather(BOOKS, { now: T0 + 3 * MIN });
  assert.equal(g.resumed, true);
  assert.equal(dirs().length, 1, "one book, not two");
  assert.equal(fs.readdirSync(g.dir).length, 3, "all three pages are in it");
});

test("a marker naming a folder that is gone is stale, and the pile starts again", () => {
  fs.writeFileSync(path.join(BOOKS, gather.MARKER), JSON.stringify({ dir: "New book 2026-09-01" }));
  drop("IMG_0001.HEIC");
  const g = gather.gather(BOOKS, { now: T0 });
  assert.equal(g.resumed, false);
  assert.equal(g.name, "New book 2026-09-07");
  assert.deepEqual(looseLeft(), []);
});

test("a marker whose `dir` is a path names no folder at all", () => {
  fs.writeFileSync(path.join(BOOKS, gather.MARKER), JSON.stringify({ dir: "../../escape" }));
  drop("IMG_0001.HEIC");
  const g = gather.gather(BOOKS, { now: T0 });
  assert.equal(g.resumed, false);
  assert.equal(path.dirname(path.resolve(g.dir)), path.resolve(BOOKS));
});

test("a second pile on the same day gets its own folder, never the first one's", () => {
  drop("a.jpg");
  gather.gather(BOOKS, { now: T0 });
  drop("b.jpg");
  const g = gather.gather(BOOKS, { now: T0 });
  assert.equal(g.name, "New book 2026-09-07 (2)");
  assert.deepEqual(dirs(), ["New book 2026-09-07", "New book 2026-09-07 (2)"]);
});

test("two phones, one file name: both photos are kept", () => {
  drop("IMG_0001.HEIC");
  const first = gather.gather(BOOKS, { now: T0 });
  drop("IMG_0001.HEIC");
  // the resumed-name case: point the marker at the folder that already has one
  fs.writeFileSync(path.join(BOOKS, gather.MARKER), JSON.stringify({ dir: first.name }));
  gather.gather(BOOKS, { now: T0 });
  assert.deepEqual(fs.readdirSync(first.dir).sort(), ["IMG_0001-2.HEIC", "IMG_0001.HEIC"]);
});

// --------------------------------------------------- the quiet clock and scan

test("a first sighting is never gathered — the photos may still be arriving", () => {
  drop("IMG_0001.HEIC"); drop("IMG_0002.HEIC");
  content.scan({ now: T0 });
  assert.equal(dirs().length, 0, "no folder yet");
  assert.equal(looseLeft().length, 2, "and the photos are where the parent put them");
});

test("a photo that lands during the quiet period joins the SAME book, and resets the clock", () => {
  drop("IMG_0001.HEIC");
  content.scan({ now: T0 });
  content.scan({ now: T0 + 9 * MIN });
  assert.equal(dirs().length, 0, "nine minutes is not ten");
  drop("IMG_0002.HEIC");                      // Drive trickles the next one in
  content.scan({ now: T0 + 10 * MIN });
  assert.equal(dirs().length, 0, "the newcomer restarted the ten minutes");
  content.scan({ now: T0 + 21 * MIN });
  assert.equal(dirs().length, 1, "…and then one book");
  assert.deepEqual(gather.looseNames(path.join(BOOKS, dirs()[0])).length, 2, "with BOTH photos in it");
});

test("ten quiet minutes: one folder, claimed, marked as a book nobody has named", async () => {
  const started = [];
  content.runJob = (job) => { started.push(job); return Promise.resolve({ ok: true }); };
  drop("IMG_0001.HEIC"); drop("IMG_0002.HEIC"); drop("IMG_0003.HEIC");
  content.scan({ now: T0 });
  const res = content.scan({ now: T0 + 11 * MIN });

  assert.equal(dirs().length, 1);
  const dir = path.join(BOOKS, dirs()[0]);
  const job = store.readJob(dir);
  assert.equal(job.state, "inbox");
  assert.ok(job.claimedBy, "claimed by this hub");
  assert.equal(job.autoTitle, true, "nobody has named this book yet");
  assert.equal(res.claimed.length, 1, "the scan says it claimed it");
  assert.equal(started.length, 1, "and the build started at once, not in five minutes");
  assert.equal(started[0].dir, dir);
  await content.idle();
});

test("a second scan does not make a second book out of the same pile", async () => {
  drop("IMG_0001.HEIC");
  content.scan({ now: T0 });
  content.scan({ now: T0 + 11 * MIN });
  await content.idle();
  content.scan({ now: T0 + 22 * MIN });
  await content.idle();
  assert.equal(dirs().length, 1);
});

test("loose photos never disturb the book folders beside them", () => {
  fs.mkdirSync(path.join(BOOKS, "Sunny Pond"));
  fs.writeFileSync(path.join(BOOKS, "Sunny Pond", "p1.jpg"), Buffer.alloc(64, 1));
  drop("IMG_0001.HEIC");
  content.scan({ now: T0 });
  content.scan({ now: T0 + 11 * MIN });
  assert.deepEqual(gather.looseNames(path.join(BOOKS, "Sunny Pond")), ["p1.jpg"]);
  assert.equal(dirs().length, 2);
});

test("no loose photos: books/ is left exactly as it is", () => {
  fs.mkdirSync(path.join(BOOKS, "Sunny Pond"));
  content.scan({ now: T0 });
  content.scan({ now: T0 + 11 * MIN });
  assert.deepEqual(inBooks().filter(n => n !== ".slugs.json"), ["Sunny Pond"],
    "no marker, no new folder, nothing (books-index's own .slugs.json aside)");
});

test("status counts the photos that are waiting, and says how long the wait is", () => {
  drop("IMG_0001.HEIC"); drop("IMG_0002.HEIC");
  const s = content.status();
  assert.equal(s.loose, 2, "seventeen photos are never 'no books yet'");
  assert.equal(s.quietMs, content.QUIET_MS, "the card's promise is the hub's own number");
  assert.deepEqual(s.jobs, [], "and they are not a book yet");
});

// -------------------------------------------------------- naming, and undoing

test("the cover's title renames the folder and the book carries on under it", async () => {
  const runs = [];
  content.runJob = (job) => {
    runs.push(job);
    return Promise.resolve(runs.length === 1
      ? { held: "needs-title", title: "Sunny Pond" }        // the worker's title hold
      : { ok: true });
  };
  drop("IMG_0001.HEIC");
  content.scan({ now: T0 });
  content.scan({ now: T0 + 11 * MIN });
  await content.idle();

  assert.deepEqual(dirs(), ["Sunny Pond"], "the placeholder folder became the book");
  assert.equal(fs.readdirSync(path.join(BOOKS, "Sunny Pond")).includes("IMG_0001.HEIC"), true,
    "with the photo still in it");
  const job = store.readJob(path.join(BOOKS, "Sunny Pond"));
  assert.equal(job.autoTitle, undefined, "and it is never asked its name twice");
  assert.equal(job.held, undefined, "the hold is answered");
  assert.equal(runs.length, 2, "the build started again under the real name");
  assert.equal(runs[1].name, "Sunny Pond");
  assert.equal(runs[1].slug, "sunny-pond");
});

test("a cover that says nothing keeps the placeholder name, and still carries on", async () => {
  const runs = [];
  content.runJob = () => Promise.resolve(runs.push(1) === 1 ? { held: "needs-title", title: null } : { ok: true });
  drop("IMG_0001.HEIC");
  content.scan({ now: T0 });
  content.scan({ now: T0 + 11 * MIN });
  await content.idle();
  assert.deepEqual(dirs(), ["New book 2026-09-07"]);
  assert.equal(store.readJob(path.join(BOOKS, "New book 2026-09-07")).autoTitle, undefined);
  assert.equal(runs.length, 2);
});

test("'let me say otherwise': a rename moves the folder and keeps every photo", async () => {
  drop("IMG_0001.HEIC");
  content.scan({ now: T0 });
  content.scan({ now: T0 + 11 * MIN });
  await content.idle();
  const was = dirs()[0];
  const out = content.renameBook({ kind: "books", slug: "new-book-2026-09-07", title: "Sunny Pond" });
  await content.idle();
  assert.equal(out.renamed, true);
  assert.equal(out.title, "Sunny Pond");
  assert.equal(out.was, was);
  assert.deepEqual(dirs(), ["Sunny Pond"]);
  assert.deepEqual(fs.readdirSync(path.join(BOOKS, "Sunny Pond")).filter(n => !n.startsWith(".")),
    ["IMG_0001.HEIC"]);
  assert.equal(store.readJob(path.join(BOOKS, "Sunny Pond")).autoTitle, undefined,
    "a grown-up named it, so the cover never overrules them");
});

test("a rename is refused while the book is being built", async () => {
  drop("IMG_0001.HEIC");
  let release;
  content.runJob = () => new Promise((r) => { release = () => r({ ok: true }); });
  content.scan({ now: T0 });
  content.scan({ now: T0 + 11 * MIN });
  const out = content.renameBook({ kind: "books", slug: "new-book-2026-09-07", title: "Sunny Pond" });
  assert.match(out.error, /working on this book/i);
  assert.deepEqual(dirs(), ["New book 2026-09-07"]);
  release();
  await content.idle();
});

test("a rename names a book by its slug, and a slug is never a path", () => {
  assert.deepEqual(content.renameBook({ kind: "books", slug: "../..", title: "Sunny Pond" }),
    { error: "unknown book" });
  assert.deepEqual(content.renameBook({ kind: "books", slug: "nothing-here", title: "Sunny Pond" }),
    { error: "unknown book" });
  assert.deepEqual(content.renameBook({ kind: "songs", slug: "x", title: "Sunny Pond" }),
    { error: "unknown kind" });
});

test("a rename to something no folder could be called is refused, and says so plainly", async () => {
  drop("IMG_0001.HEIC");
  content.scan({ now: T0 });
  content.scan({ now: T0 + 11 * MIN });
  await content.idle();
  const out = content.renameBook({ kind: "books", slug: "new-book-2026-09-07", title: " ??? " });
  assert.match(out.error, /folder name/i);
  assert.doesNotMatch(out.error, /[/\\]/, "no path on the family's disk is ever quoted back");
  assert.deepEqual(dirs(), ["New book 2026-09-07"], "and nothing moved");
});

test("a rename in API mode is refused with the one word Settings turns into a sentence", () => {
  driveCfg({ mode: "api", folderId: "F0", token: { refresh_token: "x" } });
  assert.deepEqual(content.renameBook({ kind: "books", slug: "x", title: "Sunny Pond" }),
    { skipped: "needs-local-drive" });
  driveCfg({ mode: "local", folderPath: FOLDER });
});
