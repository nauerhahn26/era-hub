// content-loose.test.mjs — the pile of photos a parent dropped straight into
// books/ without making a folder (dad 9/7: "I didn't put into, like, a folder
// and name it… you should assume they are [one book], and let me say
// otherwise"). Two halves:
//
//   content-gather.js  the disk rules — one pile is one folder, a photo is
//                      moved and never deleted, an interrupted move is finished
//                      rather than restarted, and a model's title is turned
//                      into a name Windows will actually take.
//   content.js         the decision — the TAP that gathers the pile, the claim,
//                      the `autoTitle` note, the rename door, and the loose
//                      count /content/status publishes so no card ever says
//                      "no books yet" over the top of seventeen photos.
//
// BUILT HERE (spec §12 and §14, plan B1.3). The decision half of this suite
// used to be a clock: ten still minutes and the hub made the folder, named it
// after today, claimed it and started reading the photos against the family's
// vision key, with nobody asked. The gather is also the one path that renames a
// folder by itself. A clock can only ever GUESS that the photos have stopped
// arriving; the grown-up whose photos they are knows, so the guess stopped
// being a licence: `build({kind:"books", loose:true})` — the Build button on the
// loose card — is the sentence the clock was trying to infer, and it skips the
// quiet period outright because the tap IS "I have finished putting them in".
//
// The clock itself is not gone and is still asserted below: gatherLoose keeps
// its unforced path, where every arriving photo restarts the ten minutes so a
// phone trickling an album in over five of them makes ONE book. Nothing in the
// hub calls it that way today; it is the guard for whatever asks next, and it
// is tested directly rather than through a scan that no longer gathers.
//
// Disk plus a fake clock: no server, no port, no network, no key, no model, and
// no real waiting — except that the TAP reads the wall clock, because a finger
// happens now, so a gathered pile is born under TODAY's placeholder name and
// this suite asks content-gather for it rather than writing a date down twice.
// Every title here is synthetic ("Sunny Pond").
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

// ONE PHOTO THE DISK WILL NOT MOVE — the ordinary case on Windows, where Google
// Drive for Desktop still holds an upload handle open on the file that landed a
// second ago. Both halves of moveIn refuse it (rename, then copy+unlink), which
// is what an EPERM/EBUSY looks like from in here. ext4 will not produce one on
// demand, so the two calls are stood in for, the way this suite stands in for
// content.runJob.
function withUnmovable(name, fn) {
  const rename = fs.renameSync, copy = fs.copyFileSync;
  const locked = (p) => path.basename(String(p)) === name;
  fs.renameSync = (a, b) => { if (locked(a)) throw new Error("EPERM: operation not permitted"); return rename(a, b); };
  fs.copyFileSync = (a, b) => { if (locked(a)) throw new Error("EPERM: operation not permitted"); return copy(a, b); };
  try { return fn(); } finally { fs.renameSync = rename; fs.copyFileSync = copy; }
}

// THE FAMILY'S DISK, MODELLED. NTFS (and a Mac's APFS) hold "Sunny Pond" and
// "sunny pond" to be one folder; the QA box's ext4 does not, which is exactly
// why a whole class of naming bug was invisible to this suite. fs.existsSync is
// the call that decided "taken", so it is the one stood in for.
function withCaseBlindDisk(fn) {
  const exists = fs.existsSync;
  fs.existsSync = (p) => {
    if (exists(p)) return true;
    const at = String(p), want = path.basename(at).toLowerCase();
    try { return fs.readdirSync(path.dirname(at)).some(n => n.toLowerCase() === want); } catch { return false; }
  };
  try { return fn(); } finally { fs.existsSync = exists; }
}
// THE TAP on the loose card, which is the only thing that gathers now: the
// Build button the Book Reader's shelf and the Settings content card both post
// to /content/build. `loose:true` and never a slug — the pile has no folder yet,
// so it has no slug either (reader.js's old " loose" sentinel is never sent).
const tap = () => content.build({ kind: "books", loose: true });
// The placeholder name a pile gathered by a tap is born with. The tap reads the
// wall clock, so this is TODAY's name, asked of the one module that owns it
// rather than written down here as a second copy that would rot overnight.
const today = () => gather.fallbackTitle(Date.now());
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

// RULE 3 IS NOT ONLY ABOUT A CRASH. One photo the disk refuses used to clear
// the marker anyway, and the photos left loose became an ordinary new pile: ten
// minutes later they were a SECOND book, with its own folder, its own claim and
// its own transcription off the family's free key — and the page was detached
// from its real book for ever, with nothing to tell the parent.
test("one photo the disk will not move keeps the marker, and joins the SAME book next look", () => {
  drop("IMG_0001.HEIC"); drop("IMG_0002.HEIC"); drop("IMG_0003.HEIC");
  const g = withUnmovable("IMG_0002.HEIC", () => gather.gather(BOOKS, { now: T0 }));
  assert.equal(g.moved, 2);
  assert.equal(g.failed, 1, "and it says so, so content.js can put it in the log");
  assert.equal(gather.pending(BOOKS), g.name, "the marker stays while the pile is not empty");
  assert.deepEqual(looseLeft(), ["IMG_0002.HEIC"], "the photo is exactly where the parent put it");

  // Drive lets go of the file; the next look FINISHES the same move.
  const again = gather.gather(BOOKS, { now: T0 + 5 * MIN });
  assert.equal(again.resumed, true);
  assert.equal(again.name, g.name);
  assert.deepEqual(dirs(), [g.name], "one book, not two");
  assert.equal(fs.readdirSync(g.dir).length, 3, "all three pages of it");
  assert.equal(gather.pending(BOOKS), null, "and only now is the marker gone");
});

test("a photo nothing will ever move lets the marker go rather than pinning books/ for ever", () => {
  drop("IMG_0001.HEIC"); drop("IMG_0002.HEIC");
  withUnmovable("IMG_0002.HEIC", () => {
    // One look per scan: the resume never waits out the quiet clock again.
    for (let i = 0; i <= gather.MAX_RESUMES; i++) gather.gather(BOOKS, { now: T0 + i * MIN });
  });
  assert.equal(gather.pending(BOOKS), null, "held any longer, books/ could never be gathered again");
  assert.deepEqual(looseLeft(), ["IMG_0002.HEIC"]);
  assert.equal(dirs().length, 1, "and the book that was made is still one book");
});

test("a pile nothing could move at all leaves no empty book behind", () => {
  drop("IMG_0001.HEIC");
  withUnmovable("IMG_0001.HEIC", () => {
    for (let i = 0; i <= gather.MAX_RESUMES; i++) gather.gather(BOOKS, { now: T0 + i * MIN });
  });
  assert.deepEqual(dirs(), [], "no phantom book, and the name is free for the real one");
  assert.deepEqual(looseLeft(), ["IMG_0001.HEIC"], "and the photo is untouched");
});

// A folder made and then a marker that never landed left an EMPTY phantom: not
// an inbox (no photos in it), so never claimed, never built, never swept — but
// with a slug, a permanent zero-page card on the Settings page, and the NAME, so
// the real book was born as "New book 2026-09-07 (2)".
test("a marker that will not land leaves books/ exactly as the parent left it", () => {
  drop("IMG_0001.HEIC");
  const write = fs.writeFileSync;
  fs.writeFileSync = (p, d, ...rest) => {
    if (path.basename(String(p)).startsWith(".gather")) throw new Error("power loss");
    return write(p, d, ...rest);
  };
  try { assert.throws(() => gather.gather(BOOKS, { now: T0 }), /power loss/); }
  finally { fs.writeFileSync = write; }

  assert.deepEqual(dirs(), [], "no empty phantom book squatting the name");
  assert.equal(gather.pending(BOOKS), null, "and no marker left pointing at one");
  assert.deepEqual(looseLeft(), ["IMG_0001.HEIC"]);
  // …so when the disk comes back, the book is born under the name the parent
  // will recognise rather than under "(2)".
  assert.equal(gather.gather(BOOKS, { now: T0 }).name, "New book 2026-09-07");
});

test("a folder the disk refuses takes its marker with it", () => {
  drop("IMG_0001.HEIC");
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = (p, o) => {
    if (path.basename(String(p)).startsWith(gather.FALLBACK_PREFIX)) throw new Error("no space left");
    return mkdir(p, o);
  };
  try { assert.throws(() => gather.gather(BOOKS, { now: T0 }), /no space left/); }
  finally { fs.mkdirSync = mkdir; }
  assert.deepEqual(inBooks(), ["IMG_0001.HEIC"], "not even the marker of a folder that never was");
});

test("the marker lands whole — a torn one would make the rest of the pile a second book", () => {
  drop("IMG_0001.HEIC");
  const write = fs.writeFileSync, seen = [];
  fs.writeFileSync = (p, d, ...rest) => { seen.push(path.basename(String(p))); return write(p, d, ...rest); };
  try { gather.gather(BOOKS, { now: T0 }); } finally { fs.writeFileSync = write; }
  assert.equal(seen.includes(gather.MARKER), false, "never written in place under its own name");
  assert.ok(seen.some(n => n.startsWith(".gather") && n.endsWith(".tmp")), "tmp + rename, like every other file");
  // Why it matters: half a marker reads as NO marker, and a resume that reads no
  // marker starts a second book out of the photos still loose.
  fs.writeFileSync(path.join(BOOKS, gather.MARKER), '{"dir":"New bo');
  assert.equal(gather.pending(BOOKS), null);
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

// --------------------------------------------------- the quiet clock and the tap

// A FIRST SIGHTING IS NEVER GATHERED, and neither is a hundredth. This used to
// be the first half of the quiet clock — one observation proves nothing, two
// ten minutes apart proved the photos had stopped arriving — and the second
// half is the one that went: a scan does not gather at all now, however long
// the pile has sat there, because making a folder inside the family's own Drive
// and spending their vision key on what is in it is a decision with a person's
// name on it (spec §12, "built here"). The photos stay exactly where the parent
// put them until somebody taps Build, which is the companion below.
test("the scan never gathers the pile, however long the photos sit there", () => {
  drop("IMG_0001.HEIC"); drop("IMG_0002.HEIC");
  for (const mins of [0, 11, 60, 24 * 60]) content.scan({ now: T0 + mins * MIN });
  assert.deepEqual(dirs(), [], "no folder was made in the family's own Drive folder");
  assert.deepEqual(looseLeft(), ["IMG_0001.HEIC", "IMG_0002.HEIC"],
    "and the photos are where the parent put them");
  assert.equal(fs.existsSync(path.join(BOOKS, gather.MARKER)), false, "not even a marker");
  assert.equal(content.status().loose, 2, "…but the card can still say they are there");
});

// THE CLOCK ITSELF IS KEPT, one caller further out. gatherLoose's unforced path
// is what makes a phone trickling a twenty-photo album in over five minutes ONE
// book: every arrival restarts the ten minutes, so none of them is ever left
// behind in a second folder. Nothing in the hub asks for it that way today —
// this test used to drive it through content.scan(), which no longer gathers —
// so it is asked of the exported function directly, which is where the guard
// now lives for whatever calls it next.
test("a photo that lands during the quiet period joins the SAME book, and resets the clock", () => {
  drop("IMG_0001.HEIC");
  content.gatherLoose(BOOKS, T0);
  content.gatherLoose(BOOKS, T0 + 9 * MIN);
  assert.equal(dirs().length, 0, "nine minutes is not ten");
  drop("IMG_0002.HEIC");                      // Drive trickles the next one in
  content.gatherLoose(BOOKS, T0 + 10 * MIN);
  assert.equal(dirs().length, 0, "the newcomer restarted the ten minutes");
  content.gatherLoose(BOOKS, T0 + 21 * MIN);
  assert.equal(dirs().length, 1, "…and then one book");
  assert.deepEqual(gather.looseNames(path.join(BOOKS, dirs()[0])).length, 2, "with BOTH photos in it");
});

// …AND THE TAP DOES NOT WAIT FOR IT AT ALL (spec §14 step 3). Everything this
// test asserted about the folder a gather leaves behind is unchanged — one
// folder, claimed at `inbox`, `autoTitle` so the cover may still name it, and
// the build started in the same breath. What changed is the sentence in front
// of it: not "ten minutes have passed" but "a grown-up pressed Build", which is
// why there is no quiet period left to wait out. The photos may have landed a
// second ago; the person who put them there says they are all in.
test("the tap: one folder, claimed at once, marked as a book nobody has named", async () => {
  const started = [];
  content.runJob = (job) => { started.push(job); return Promise.resolve({ ok: true }); };
  drop("IMG_0001.HEIC"); drop("IMG_0002.HEIC"); drop("IMG_0003.HEIC");
  const out = tap();                          // no scan first, and no clock at all

  assert.equal(out.started, true);
  assert.deepEqual(dirs(), [today()], "one folder, named for the day it was tapped");
  const dir = path.join(BOOKS, dirs()[0]);
  const job = store.readJob(dir);
  assert.equal(job.state, "inbox");
  assert.ok(job.claimedBy, "claimed by this hub");
  assert.equal(content.isMine(job), true, "…which is the computer the button was on");
  assert.equal(job.autoTitle, true, "nobody has named this book yet");
  assert.equal(started.length, 1, "and the build started at once");
  assert.equal(started[0].dir, dir);
  assert.equal(started[0].slug, out.slug, "the door answers with the slug it just made");
  assert.deepEqual(looseLeft(), [], "nothing left loose");
  await content.idle();
});

test("a second tap does not make a second book out of the same pile", async () => {
  drop("IMG_0001.HEIC");
  assert.equal(tap().started, true);
  await content.idle();
  // Nothing left to gather: a second press (or the other parent's, on the other
  // computer's card, a moment later) says so rather than making an empty book.
  assert.equal(tap().refused, "checking");
  content.scan({ now: T0 + 22 * MIN });
  await content.idle();
  assert.equal(dirs().length, 1);
});

test("loose photos never disturb the book folders beside them", () => {
  fs.mkdirSync(path.join(BOOKS, "Sunny Pond"));
  fs.writeFileSync(path.join(BOOKS, "Sunny Pond", "p1.jpg"), Buffer.alloc(64, 1));
  drop("IMG_0001.HEIC");
  assert.equal(tap().started, true);
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

// The gather is started by a tap now rather than by the clock (above), and the
// rest of this half of the suite is unchanged: what the cover is allowed to say
// about a machine-made name, and what a grown-up is allowed to say over the top
// of it. Only the two scans that used to stand in for "the pile is ready" have
// become the press that says so.
test("the cover's title renames the folder and the book carries on under it", async () => {
  const runs = [];
  content.runJob = (job) => {
    runs.push(job);
    return Promise.resolve(runs.length === 1
      ? { held: "needs-title", title: "Sunny Pond" }        // the worker's title hold
      : { ok: true });
  };
  drop("IMG_0001.HEIC");
  tap();
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
  tap();
  await content.idle();
  assert.deepEqual(dirs(), [today()]);
  assert.equal(store.readJob(path.join(BOOKS, today())).autoTitle, undefined);
  assert.equal(runs.length, 2);
});

test("'let me say otherwise': a rename moves the folder and keeps every photo", async () => {
  drop("IMG_0001.HEIC");
  const made = tap();
  await content.idle();
  const was = dirs()[0];
  const out = content.renameBook({ kind: "books", slug: made.slug, title: "Sunny Pond" });
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

// A NAME IS TAKEN WHATEVER ITS CAPITALS, because the disk this ships on decides
// it that way: on NTFS "Sunny Pond" and "sunny pond" are one folder. Answering
// otherwise on ext4 hid the whole class of bug from this suite.
test("a name is taken whatever its capitals — and never by the folder asking", () => {
  fs.mkdirSync(path.join(BOOKS, "Sunny Pond"));
  assert.equal(gather.freeDirName(BOOKS, "sunny pond"), "sunny pond (2)");
  assert.equal(gather.freeDirName(BOOKS, "sunny pond", "Sunny Pond"), "sunny pond",
    "…except by the folder that is being renamed, which is allowed to be itself");
});

// Fixing the capitals of a machine-made name is one of the likeliest first uses
// of the Rename button, and it used to answer "Sunny Pond (2)": a new folder, a
// new slug (books-index assigns them off folder names) and a package Ellie's
// saved place is not in.
test("retyping a title in different capitals renames the book, it does not clone it", () => {
  fs.mkdirSync(path.join(BOOKS, "sunny pond"));
  fs.writeFileSync(path.join(BOOKS, "sunny pond", "p1.jpg"), Buffer.alloc(64, 1));
  const out = withCaseBlindDisk(() => gather.rename(BOOKS, "sunny pond", "Sunny Pond"));
  assert.equal(out.renamed, true);
  assert.equal(out.name, "Sunny Pond");
  assert.deepEqual(dirs(), ["Sunny Pond"], "one book on the shelf, not two");
  assert.deepEqual(fs.readdirSync(out.dir), ["p1.jpg"], "with its photo still in it");
});

test("a title that clashes with ANOTHER book, in any capitals, still gets its own folder", () => {
  fs.mkdirSync(path.join(BOOKS, "Sunny Pond"));
  fs.mkdirSync(path.join(BOOKS, "New book 2026-09-07"));
  const out = withCaseBlindDisk(() => gather.rename(BOOKS, "New book 2026-09-07", "sunny pond"));
  assert.equal(out.name, "sunny pond (2)", "two books that share a title are two books");
  assert.deepEqual(dirs(), ["Sunny Pond", "sunny pond (2)"]);
});

// The worker's first act is to read a job.json, and a folder still inside its
// quiet ten minutes has none: it threw "no job.json in <folder>", and the catch
// around it wrote that line into .build/log.jsonl INSIDE the family's Drive
// folder — a whole .build/ directory, for Drive to upload to every device, under
// a book the parent had only just made.
test("renaming a book nobody has claimed yet does not start a build", async () => {
  const runs = [];
  content.runJob = (job) => { runs.push(job); return Promise.resolve({ ok: true }); };
  fs.mkdirSync(path.join(BOOKS, "Sunny Pond"));
  fs.writeFileSync(path.join(BOOKS, "Sunny Pond", "p1.jpg"), Buffer.alloc(64, 1));
  content.scan({ now: T0 });                       // seen once: the quiet clock, no claim
  const out = content.renameBook({ kind: "books", slug: "sunny-pond", title: "Sunny Pond 2" });
  await content.idle();
  assert.equal(out.renamed, true);
  assert.deepEqual(runs, [], "nothing to run on a book with no job.json");
  assert.equal(fs.existsSync(path.join(BOOKS, "Sunny Pond 2", ".build")), false,
    "and nothing of ours appears in the family's folder");
});

test("a rename is refused while the book is being built", async () => {
  drop("IMG_0001.HEIC");
  let release;
  content.runJob = () => new Promise((r) => { release = () => r({ ok: true }); });
  const made = tap();
  const out = content.renameBook({ kind: "books", slug: made.slug, title: "Sunny Pond" });
  assert.match(out.error, /working on this book/i);
  assert.deepEqual(dirs(), [today()]);
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
  const made = tap();
  await content.idle();
  const out = content.renameBook({ kind: "books", slug: made.slug, title: " ??? " });
  assert.match(out.error, /folder name/i);
  assert.doesNotMatch(out.error, /[/\\]/, "no path on the family's disk is ever quoted back");
  assert.deepEqual(dirs(), [today()], "and nothing moved");
});

test("a rename in API mode is refused with the one word Settings turns into a sentence", () => {
  driveCfg({ mode: "api", folderId: "F0", token: { refresh_token: "x" } });
  assert.deepEqual(content.renameBook({ kind: "books", slug: "x", title: "Sunny Pond" }),
    { skipped: "needs-local-drive" });
  driveCfg({ mode: "local", folderPath: FOLDER });
});
