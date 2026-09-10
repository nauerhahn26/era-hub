// content-build.test.mjs — BUILT ONCE, BUILT HERE (spec §12 and §14, plan
// B1.2). Two rules, and this suite is both of them:
//
//   never twice   a folder with manifest.json is never an inbox and never a
//                 pile, whatever loose files sit beside it. A finished book now
//                 lands in the family's Drive folder every week, made somewhere
//                 else, and the hub that decided to "help" would read every page
//                 again against the vision key and buy the narration twice.
//   built here    nothing starts by itself any more. A pile of photos builds
//                 when a grown-up taps Build ON THE COMPUTER THAT WILL DO IT;
//                 the scan claims no quiet inbox, gathers no loose pile and
//                 takes no book off another device — but it still resumes THIS
//                 device's own job after a restart.
//
// Disk plus fixtures written against the real clock: no server, no port, no
// network, no key and no waiting — a "stale" claim is one whose heartbeat says
// thirty-one minutes ago, and the quiet period is driven by scan({now}).
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-build-"));
const DATA = path.join(TMP, "data");
const FOLDER = path.join(TMP, "My Drive", "New ERA Content");   // what Drive for Desktop shows
const BOOKS = path.join(FOLDER, "books");

let content, store, drive, gather;

const MIN = 60 * 1000;
// The two computers in the family, by the id device-id.js gives an install —
// never os.hostname(), which is two identical "DESKTOP-7F3K"s reading as one.
const DEVICE = "kitchen-pc";
const OTHER = "study-pc";
const ME = () => DEVICE + ":" + process.pid;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function driveCfg(cfg) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "drive.json"), JSON.stringify(cfg));
}

// A book folder with a pile of photos loose in it: no job, no manifest — the
// thing the shelf now draws a Build card over.
function book(name, photos) {
  const dir = path.join(BOOKS, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, bytes] of Object.entries(photos || { "IMG_1.jpg": 10, "IMG_2.jpg": 12 }))
    fs.writeFileSync(path.join(dir, f), Buffer.alloc(bytes, 7));
  return dir;
}

// A BOOK THAT ARRIVES FINISHED (spec §8): pages, a cover copied from page 1,
// and manifest.json written last. Its job.json is the anti-rebuild latch, which
// lands BEFORE the manifest — a folder mid-download has neither.
function madeElsewhere(name, opts) {
  const o = opts || {};
  const dir = path.join(BOOKS, name);
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pages", "001.jpg"), Buffer.alloc(64, 3));
  fs.writeFileSync(path.join(dir, "cover.jpg"), Buffer.alloc(64, 3));
  if (o.manifest !== false)
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      schemaVersion: 1, id: "0f0f", slug: "x", title: name,
      exportedAt: ago(20 * MIN), cover: "cover.jpg", authored: true,
      pages: [{ index: 1, image: "pages/001.jpg", text: "A fossil in the sand." }],
    }));
  return dir;
}

// Another computer's claim, as it looks from here: {claimedBy: "<device>:<pid>"}.
function jobOn(dir, who, extra) {
  const base = store.newJob({ claimedBy: who, state: (extra && extra.state) || "transcribing" });
  return store.writeJob(dir, { ...base, heartbeat: ago(0), ...(extra || {}) });
}

// The line the OTHER hub's claim() left in log.jsonl. Drive delivers .build/ in
// its own order, so this often lands before the job.json that goes with it.
function claimLine(dir, opts) {
  const o = opts || {};
  fs.mkdirSync(store.buildDir(dir), { recursive: true });
  const line = { t: o.t || ago(0), step: "claim", msg: o.msg || ("claimed by " + o.by) };
  if (o.by && o.prose !== true) line.by = o.by;
  fs.appendFileSync(store.logPath(dir), JSON.stringify(line) + "\n");
}

// Where ingest puts the originals once it has taken them in (content-ingest.js
// owns the name; content.js keeps its own copy of the string for the same
// reason — requiring the ingest module drags a JPEG decoder in for one word).
const SOURCES_DIR = "sources";

const jobOf = (dir) => store.readJob(dir);
const rowOf = (title) => content.jobs().find(j => j.title === title);
const found = (res, name) => (res.books || []).find(b => b.name === name);
const dirs = () => fs.readdirSync(BOOKS, { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name).sort();

let started = [];

before(() => {
  fs.mkdirSync(BOOKS, { recursive: true });
  driveCfg({ mode: "local", folderPath: FOLDER });
  drive = require("./drive.js");
  drive.start(DATA);
  store = require("./content-store.js");
  gather = require("./content-gather.js");
  content = require("./content.js");
  // The id this install signs its claims with, exactly as server.js hands it
  // over (device-id.js resolveDeviceId, server.js DEVICE_ID).
  content.start(DATA, { deviceId: DEVICE });
});

beforeEach(async () => {
  await content.idle();
  fs.rmSync(BOOKS, { recursive: true, force: true });
  fs.mkdirSync(BOOKS, { recursive: true });
  driveCfg({ mode: "local", folderPath: FOLDER });
  content._testReset({ deviceId: DEVICE });
  // No build here is a real one: this suite is about who may start a book, not
  // about what a build does (content-worker.test.mjs is).
  started = [];
  content.runJob = (job) => { started.push(job); return Promise.resolve({ ok: true }); };
});

// -------------------------------------------------------- who this hub is (§14)

test("a claim names this DEVICE and this process, never the machine's hostname", () => {
  const dir = book("Sunny Pond");
  assert.deepEqual(content.build({ kind: "books", slug: "sunny-pond" }),
                   { started: true, slug: "sunny-pond" });
  assert.equal(jobOf(dir).claimedBy, ME());
  // …and the line that says so carries WHO in a field, not only in its prose:
  // the other device reads it back while job.json is mid-mirror (B1.1).
  const line = store.readLog(dir).filter(l => l.step === "claim").pop();
  assert.equal(line.by, ME());
});

test("mine is the device before the last colon — and an older hub's hostname claim is mine too", () => {
  assert.equal(content.isMine({ claimedBy: DEVICE + ":9" }), true, "same device, another process");
  assert.equal(content.isMine({ claimedBy: OTHER + ":9" }), false);
  assert.equal(content.isMine({ claimedBy: os.hostname() + ":9" }), true,
    "a job.json written before this release names this machine, and it is still ours");
  assert.equal(content.isMine({ claimedBy: null }), false, "a claim that names nobody is nobody's");
  assert.equal(content.isMine(null), false);
});

// --------------------------------------------------------------- never twice

// The latch (job.json, state done) is written before manifest.json, so today's
// hubs are already safe — but a device's own finished book, or one whose
// .build/ has not mirrored yet, has a manifest and no job at all. Today
// that is an inbox: cover.jpg counts as a photo, the folder goes quiet, and ten
// minutes later the hub reads every page again against the vision key.
test("a finished book with a cover and no job.json is never an inbox and never a pile", () => {
  const T0 = Date.now();
  const dir = madeElsewhere("The Fossil Hunter");
  content.scan({ now: T0 });
  const res = content.scan({ now: T0 + 11 * MIN });
  assert.equal(found(res, "The Fossil Hunter").inbox, false);
  assert.deepEqual(res.claimed, []);
  assert.equal(jobOf(dir), null, "nothing of ours was written into the family's folder");
  assert.equal(fs.existsSync(store.buildDir(dir)), false);
  const row = rowOf("The Fossil Hunter");
  assert.equal(row.published, true);
  assert.equal(row.waiting, null, "a book is not a pile of photos waiting for a tap");
  assert.equal(row.buildable, false);
  assert.deepEqual(started, []);
});

// THE TWO GUARDS NOTHING WAS MEASURING (review 9/10). Both halves of "a folder
// with a manifest is a BOOK" — scan()'s `!list.published` and jobFor()'s
// `!published` — could be deleted with every suite in the hub still green,
// because no fixture had ever put a loose photo beside a finished book. That is
// the shape they exist for and the shape that happens: a parent drops one more
// photo into the folder of a book that is already made, or the maker's package
// lands in a folder a stray was already sitting in. Without the guards the
// count is one, the folder is an inbox again, ten still minutes make it quiet,
// and the card offers to build the book that is already on the shelf.
test("a stray photo dropped beside a finished book leaves it a book, not an inbox", () => {
  const T0 = Date.now();
  const dir = madeElsewhere("The Fossil Hunter");
  fs.writeFileSync(path.join(dir, "IMG_9999.jpg"), Buffer.alloc(64, 9));    // a parent's drop
  content.scan({ now: T0 });
  const res = content.scan({ now: T0 + 11 * MIN });
  const b = found(res, "The Fossil Hunter");
  assert.equal(b.inbox, false, "a folder holding manifest.json is never an inbox");
  assert.equal(b.quiet, false, "and nothing is on the quiet clock to go quiet");
  const row = rowOf("The Fossil Hunter");
  assert.equal(row.published, true);
  assert.equal(row.waiting, null, "nor a pile of photos waiting for a tap");
  assert.equal(row.buildable, false);
  // …and no tick of any kind — the boot one, the five-minute one, the one after
  // every Drive mirror — leaves a mark of ours inside the family's folder.
  for (const reason of ["startup", "scan", "drive sync"]) content.tick(reason);
  assert.equal(jobOf(dir), null, "nothing of ours was written beside their book");
  assert.equal(fs.existsSync(store.buildDir(dir)), false);
  assert.deepEqual(started, []);
});

test("the Build door refuses a folder that already has a manifest", () => {
  madeElsewhere("The Red Bicycle");
  const out = content.build({ kind: "books", slug: "the-red-bicycle" });
  assert.equal(out.refused, "built");
  assert.match(out.error, /already made/i);
  assert.ok(!out.started);
  assert.deepEqual(started, []);
});

test("the Build door refuses a job that says done, manifest or no manifest", () => {
  const dir = madeElsewhere("Six Dots", { manifest: false });
  let job = store.newJob({ claimedBy: OTHER + ":ellie-this-week", state: "published" });
  job = store.transition(job, "done");
  const was = store.writeJob(dir, job);
  const out = content.build({ kind: "books", slug: "six-dots" });
  assert.equal(out.refused, "built");
  assert.deepEqual(jobOf(dir), was, "and the latch is left exactly as it arrived");
});

// ----------------------------------------------------------- built here (scan)

test("a quiet inbox is not claimed any more — a grown-up taps Build", () => {
  const T0 = Date.now();
  const dir = book("Waiting");
  content.scan({ now: T0 });
  const res = content.scan({ now: T0 + 11 * MIN });
  assert.equal(found(res, "Waiting").quiet, true, "it IS quiet — that is no longer a licence");
  assert.deepEqual(res.claimed, []);
  assert.equal(jobOf(dir), null);
  assert.equal(fs.existsSync(store.buildDir(dir)), false, "no .build/ for Drive to mirror");
  assert.deepEqual(started, []);
});

test("the scan never gathers the pile loose in books/ — the tap is what says it is finished", () => {
  const T0 = Date.now();
  fs.writeFileSync(path.join(BOOKS, "IMG_0001.HEIC"), Buffer.alloc(64, 7));
  fs.writeFileSync(path.join(BOOKS, "IMG_0002.HEIC"), Buffer.alloc(64, 7));
  content.scan({ now: T0 });
  content.scan({ now: T0 + 21 * MIN });
  assert.deepEqual(dirs(), [], "no folder was made out from under the family");
  assert.deepEqual(gather.looseNames(BOOKS), ["IMG_0001.HEIC", "IMG_0002.HEIC"]);
  assert.equal(content.status().loose, 2, "and both cards can still say the photos are there");
});

test("another computer's abandoned job is not taken over by a scan", () => {
  const T0 = Date.now();
  const dir = book("Theirs");
  const was = jobOn(dir, OTHER + ":31", { heartbeat: ago(31 * MIN) });
  const res = content.scan({ now: T0 });
  assert.deepEqual(res.claimed, []);
  assert.deepEqual(jobOf(dir), was, "no machine takes a book off another one by itself");
  assert.deepEqual(store.readLog(dir), [], "and nothing was appended inside the family's folder");
  assert.deepEqual(started, []);
});

// The one start that survives: this hub was building the book when the laptop
// was closed. Nobody else can be waiting on it, and a book that stops half way
// through the night with nothing to restart it is the thing the scan is for.
test("this device's own stale job is resumed after a restart, keeping its history", () => {
  const T0 = Date.now();
  const dir = book("Ours");
  let job = store.newJob({ claimedBy: DEVICE + ":999", state: "transcribing" });
  job = store.fail(job, "the network went away");
  job = store.transition(job, "transcribing");
  store.writeJob(dir, { ...job, heartbeat: ago(31 * MIN) });
  const res = content.scan({ now: T0 });
  assert.deepEqual(res.claimed, ["ours"]);
  const taken = jobOf(dir);
  assert.equal(taken.claimedBy, ME(), "the same device, this process");
  assert.equal(taken.state, "transcribing", "resumes where it fell over");
  assert.equal(taken.errors.length, 1, "and the earlier failure is history a parent needs");
  assert.equal(started.length, 1);
  assert.equal(started[0].dir, dir);
});

// --------------------------------------------------- the door refuses (§14.1)

test("a fresh claim from another computer is refused, and nothing is written", () => {
  const dir = book("Busy Elsewhere");
  const was = jobOn(dir, OTHER + ":12", { heartbeat: ago(3 * MIN) });
  const out = content.build({ kind: "books", slug: "busy-elsewhere" });
  assert.equal(out.refused, "elsewhere");
  assert.match(out.error, /another computer/i);
  assert.deepEqual(jobOf(dir), was);
  assert.deepEqual(store.readLog(dir), []);
  assert.deepEqual(started, []);
});

test("a job.json that will not parse is 'checking', not a second build", () => {
  const dir = book("Half Mirrored");
  fs.mkdirSync(store.buildDir(dir), { recursive: true });
  fs.writeFileSync(store.jobPath(dir), '{"state":"transcribing","claimedBy":"stu');
  const out = content.build({ kind: "books", slug: "half-mirrored" });
  assert.equal(out.refused, "checking");
  assert.match(out.error, /try again/i);
  assert.deepEqual(started, []);
});

test("a claim LINE from another computer, with no job.json yet, is 'checking'", () => {
  const dir = book("Line Only");
  claimLine(dir, { by: OTHER + ":12" });
  const out = content.build({ kind: "books", slug: "line-only" });
  assert.equal(out.refused, "checking");
  assert.equal(jobOf(dir), null, "and this hub did not claim it either");
});

// A line an OLDER hub wrote carries no `by` at all (content-store.js appendLog):
// the two prefixes it has always used are what is left to read.
test("an older hub's claim line is read from its prose", () => {
  const dir = book("Old Words");
  claimLine(dir, { by: OTHER + ":12", prose: true, msg: "taken over by " + OTHER + ":12" });
  assert.equal(content.build({ kind: "books", slug: "old-words" }).refused, "checking");
});

test("a claim line THIS device wrote is not another computer's, and the tap goes through", () => {
  const dir = book("My Own Line");
  claimLine(dir, { by: ME() });
  assert.deepEqual(content.build({ kind: "books", slug: "my-own-line" }),
                   { started: true, slug: "my-own-line" });
  assert.equal(jobOf(dir).claimedBy, ME());
});

test("a claim line older than the stale window is nobody's hand on the wheel", () => {
  const dir = book("Long Gone");
  claimLine(dir, { by: OTHER + ":12", t: ago(31 * MIN) });
  assert.equal(content.build({ kind: "books", slug: "long-gone" }).started, true);
});

// A PAUSE IS ITS OWNER'S UNTIL THIRTY MINUTES AFTER IT ENDS (§14 step 1). The
// book that held wrote a fresh heartbeat as it held and then stopped beating,
// so on the heartbeat alone a second device walks in the moment the pause
// passes — before the owner's own scan has had its turn.
test("a paused job stays its owner's until the stale window after the pause ends", () => {
  const dir = book("Out Of Allowance");
  jobOn(dir, OTHER + ":12", { heartbeat: ago(3 * 60 * MIN), pausedUntil: ago(5 * MIN),
                              pausedNote: "waiting for tomorrow's quota" });
  assert.equal(content.build({ kind: "books", slug: "out-of-allowance" }).refused, "elsewhere",
    "the pause ended five minutes ago: the owner is due its own turn first");
});

test("…and thirty-one minutes after the pause ended, the tap is answered", () => {
  const dir = book("Woke Up");
  jobOn(dir, OTHER + ":12", { heartbeat: ago(6 * 60 * MIN), pausedUntil: ago(31 * MIN) });
  const out = content.build({ kind: "books", slug: "woke-up" });
  assert.deepEqual(out, { started: true, slug: "woke-up" });
  assert.equal(jobOf(dir).claimedBy, ME());
});

// -------------------------------------------------- the door accepts (§14.3)

test("a pile folder is claimed at inbox and built, here", async () => {
  const dir = book("Sunny Pond");
  const out = content.build({ kind: "books", slug: "sunny-pond" });
  assert.deepEqual(out, { started: true, slug: "sunny-pond" });
  const job = jobOf(dir);
  assert.equal(job.state, "inbox");
  assert.equal(job.claimedBy, ME());
  assert.equal(job.autoTitle, undefined, "a parent named this folder themselves");
  assert.equal(started.length, 1);
  assert.equal(started[0].slug, "sunny-pond");
  await content.idle();
});

test("another computer's abandoned job is taken over BY THE TAP, keeping its state", () => {
  const dir = book("Left Half Done");
  let job = store.newJob({ claimedBy: OTHER + ":9", state: "transcribing" });
  job = store.fail(job, "the network went away");
  job = store.transition(job, "transcribing");
  store.writeJob(dir, { ...job, heartbeat: ago(31 * MIN) });
  assert.equal(content.build({ kind: "books", slug: "left-half-done" }).started, true);
  const taken = jobOf(dir);
  assert.equal(taken.claimedBy, ME(), "a grown-up decided; no machine did");
  assert.equal(taken.state, "transcribing");
  assert.equal(taken.errors.length, 1);
  assert.equal(store.readLog(dir).pop().msg, "taken over by " + ME());
});

// THE SLOW WINDOW IS NOT A LICENCE TO BUILD ANONYMOUSLY (B1.3 review, 9/10).
// A job held for something no clock brings — "needs-photo-decoder" — backs off
// to the twelve-hour look, so between half an hour and twelve hours it is cold
// to claimWarm() (the door lets the tap through) and not yet takeable() (the
// scan leaves it alone). That gap used to run the book HERE while job.json still
// named the other computer: no claim line, no change of hands, and the other
// device's next scan read a claim naming ITSELF going warm again and could
// resume the very same book. Whoever the door lets build, signs.
test("a foreign claim cold inside the slow-hold window is taken over by the tap", () => {
  const dir = book("Blurry Photos");
  let job = store.newJob({ claimedBy: OTHER + ":41", state: "inbox" });
  store.writeJob(dir, { ...job, held: "needs-photo-decoder", heartbeat: ago(45 * MIN) });
  assert.equal(content.build({ kind: "books", slug: "blurry-photos" }).started, true);
  const taken = jobOf(dir);
  assert.equal(taken.claimedBy, ME(), "the device that is doing the work is the device on the job");
  assert.equal(taken.state, "inbox", "and it resumes where the other one stopped");
  const line = store.readLog(dir).filter(l => l.step === "claim").pop();
  assert.equal(line.by, ME(), "with a claim line the other device can read in a field");
});

// The other half of the same rule: a book THIS device is already building is
// joined, not re-claimed. run() picks it up as it stands, and rewriting job.json
// out from under the worker that holds the folder is exactly what the claim
// rules exist to stop — the shelf's "Making this book…" card is reading it.
test("a warm job of our own is joined without a fresh claim", () => {
  const dir = book("Ours, Running");
  const was = jobOn(dir, DEVICE + ":9", { heartbeat: ago(MIN) });
  assert.equal(content.build({ kind: "books", slug: "ours-running" }).started, true);
  assert.deepEqual(jobOf(dir), was, "not one byte of job.json for Drive to re-upload");
  assert.deepEqual(store.readLog(dir), [], "and no second claim line inside the family's folder");
});

test("a book that fell over on a page the provider lost is buildable again", () => {
  const dir = book("Retry Me");
  let job = store.newJob({ claimedBy: DEVICE + ":9", state: "transcribing" });
  job = store.fail(job, "that page came back 500");
  store.writeJob(dir, { ...job, heartbeat: ago(31 * MIN) });
  assert.equal(content.build({ kind: "books", slug: "retry-me" }).started, true);
  // A failure that is not permanent is not a dead end: the claim changes hands
  // and `failed` still owes the step it fell over on (store.owedState), which
  // is what the walk resumes at. Only a PERMANENT refusal owes nothing, and
  // only Settings' "Try this book again" lifts one (runStep).
  assert.equal(jobOf(dir).claimedBy, ME());
  assert.equal(store.owedState(jobOf(dir)), "transcribing", "back on the step it fell over on");
});

// THE TAP IS THE GROWN-UP SAYING THE PHOTOS HAVE STOPPED ARRIVING (§14 step 3),
// so the pile in books/ skips the quiet clock it used to sit out.
test("loose:true gathers the pile at once, with no quiet period", async () => {
  fs.writeFileSync(path.join(BOOKS, "IMG_0001.HEIC"), Buffer.alloc(64, 7));
  fs.writeFileSync(path.join(BOOKS, "IMG_0002.HEIC"), Buffer.alloc(64, 7));
  const out = content.build({ kind: "books", loose: true });
  assert.equal(out.started, true);
  assert.ok(out.slug, "the card is answered with the slug the pile just got");
  assert.equal(dirs().length, 1);
  const dir = path.join(BOOKS, dirs()[0]);
  const job = jobOf(dir);
  assert.equal(job.claimedBy, ME());
  assert.equal(job.autoTitle, true, "nobody has named this book yet");
  assert.deepEqual(gather.looseNames(BOOKS), [], "and every photo went into it");
  assert.equal(started.length, 1);
  await content.idle();
});

test("loose:true with no pile to gather says so rather than pretending", () => {
  const out = content.build({ kind: "books", loose: true });
  assert.equal(out.refused, "checking");
  assert.deepEqual(dirs(), [], "and no empty book is left behind");
});

test("the door refuses what is not a book, and never takes a path for a slug", () => {
  book("Keep Me");
  assert.deepEqual(content.build({ kind: "songs", slug: "keep-me" }), { error: "unknown kind" });
  for (const slug of ["..", "../..", "keep-me/pages", "no-such-book", ""])
    assert.equal(content.build({ kind: "books", slug }).error, "unknown book", slug);
  assert.ok(fs.existsSync(path.join(BOOKS, "Keep Me")));
});

test("a hub with no local Drive folder answers the one word Settings turns into a sentence", () => {
  driveCfg({ mode: "api", folderId: "F0", token: { refresh_token: "x" } });
  assert.deepEqual(content.build({ kind: "books", slug: "anything" }),
                   { skipped: "needs-local-drive" });
  driveCfg({ mode: "local", folderPath: FOLDER });
});

// ----------------------------------------- the two older doors (§14, step 1 only)

test("/content/run is refused while another computer is building the book", () => {
  const dir = book("Theirs Now");
  const was = jobOn(dir, OTHER + ":12", { heartbeat: ago(MIN) });
  const out = content.runStep({ kind: "books", slug: "theirs-now" });
  assert.equal(out.refused, "elsewhere");
  assert.match(out.error, /another computer/i);
  assert.deepEqual(jobOf(dir), was);
  assert.deepEqual(started, []);
});

// NEVER STEP 2 on this door (§14): every review-page action runs through
// /content/run on a book that HAS a manifest, and the weekly book arrives
// carrying a fresh claim of its own. Refusing it would leave a family unable to
// fix a word in the book that just landed.
test("/content/run still works on a finished book another computer made", () => {
  const dir = madeElsewhere("The Fossil Hunter");
  let job = store.newJob({ claimedBy: OTHER + ":ellie-this-week", state: "published" });
  job = store.transition(job, "done");
  store.writeJob(dir, { ...job, heartbeat: ago(MIN) });
  const out = content.runStep({ kind: "books", slug: "the-fossil-hunter", step: "publish" });
  assert.deepEqual(out, { started: true });
  assert.equal(started.length, 1);
});

test("a rename with another computer's claim on it renames, and starts nothing", async () => {
  const dir = book("Wrong Name");
  jobOn(dir, OTHER + ":12", { heartbeat: ago(MIN) });
  const out = content.renameBook({ kind: "books", slug: "wrong-name", title: "Sunny Pond" });
  await content.idle();
  assert.equal(out.renamed, true);
  assert.equal(out.title, "Sunny Pond");
  assert.deepEqual(dirs(), ["Sunny Pond"], "a grown-up may always name their own book");
  assert.deepEqual(started, [], "but the build is the other computer's to finish");
  assert.ok(!fs.existsSync(dir));
});

// ------------------------------------------------------------- what a card sees

test("a pile row says it is waiting for a tap, and that this hub could answer it", () => {
  book("Sunny Pond", { "IMG_1.jpg": 10, "IMG_2.jpg": 12, "IMG_3.jpg": 12 });
  const row = rowOf("Sunny Pond");
  assert.equal(row.waiting, "pile");
  assert.equal(row.buildable, true);
  assert.equal(row.elsewhere, false);
  assert.equal(row.progress.pages, 3, "N photos, for the card's own sentence");
});

test("a row claimed by another computer says elsewhere, and no device name", () => {
  const dir = book("Theirs");
  jobOn(dir, OTHER + ":12", { heartbeat: ago(MIN) });
  const row = rowOf("Theirs");
  assert.equal(row.elsewhere, true);
  assert.equal(row.buildable, false);
  assert.equal(row.waiting, null, "it has a job: it is building, not waiting for a tap");
  assert.ok(!JSON.stringify(row).includes(OTHER), "a status payload never names a device");
});

test("a stale claim from another computer hands Build back to the family", () => {
  const dir = book("Gave Up");
  jobOn(dir, OTHER + ":12", { heartbeat: ago(31 * MIN) });
  const row = rowOf("Gave Up");
  assert.equal(row.elsewhere, false);
  assert.equal(row.buildable, true, "thirty minutes on, a grown-up decides");
});

test("a finished book offers no Build at all", () => {
  madeElsewhere("Six Dots");
  const row = rowOf("Six Dots");
  assert.equal(row.buildable, false);
  assert.equal(row.waiting, null);
  assert.equal(row.elsewhere, false);
});

// ------------------------------------- THE BOOK THAT IS STILL COMING DOWN (9/10)

// Drive for Desktop brings a folder down in whatever order it likes, and the
// art is usually first: pages/ and the cover copied from page 1 are here, while
// .build/job.json and manifest.json are still on their way. For those minutes
// the folder has no job to refuse it, no manifest to say it is finished, and not
// one loose photo — and it used to come back `buildable`, so both screens laid
// "Build a book" over the weekly-book maker's own folder. A tap would have
// claimed it, run the walk over a folder with zero photos in it, and left a
// .build/job.json for the maker's arriving one to collide with.
function arriving(name) {
  const dir = path.join(BOOKS, name);
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  for (const n of ["001.jpg", "002.jpg", "003.jpg"])
    fs.writeFileSync(path.join(dir, "pages", n), Buffer.alloc(64, 3));
  fs.writeFileSync(path.join(dir, "cover.jpg"), Buffer.alloc(64, 3));   // publish's copy of page 1
  return dir;
}

test("a book still arriving — pages and a cover, no job and no manifest yet — offers no Build", () => {
  const dir = arriving("Detective Dog Nell");
  const row = rowOf("Detective Dog Nell");
  assert.equal(row.published, false, "the manifest has not landed yet");
  assert.equal(row.waiting, null, "a cover is not a pile of photos (NOT_A_PAGE)");
  assert.equal(row.buildable, false, "and there is nothing here for a build to do");
});

test("…and the door refuses the tap that beat the paint to it", () => {
  const dir = arriving("Detective Dog Nell");
  const out = content.build({ kind: "books", slug: "detective-dog-nell" });
  assert.equal(out.refused, "checking");
  assert.match(out.error, /still arriving/i, "which is exactly what they are doing");
  assert.equal(jobOf(dir), null, "and the maker's folder is not claimed out from under it");
  assert.equal(fs.existsSync(store.buildDir(dir)), false, "no .build/ to collide with the one coming");
  assert.deepEqual(started, []);
});

// The other side of the same rule: "something to build" is a job that owes work
// OR loose photos, never both. Ingest MOVES the pile into sources/ as it runs,
// so a book part-way through has no loose photo left in it at all — and it is
// exactly the book a grown-up walks over to Settings to restart.
test("a book part-way through, its photos moved into sources/, is still buildable", () => {
  const dir = book("Half Read");
  fs.mkdirSync(path.join(dir, SOURCES_DIR), { recursive: true });
  for (const n of ["IMG_1.jpg", "IMG_2.jpg"])
    fs.renameSync(path.join(dir, n), path.join(dir, SOURCES_DIR, n));
  jobOn(dir, OTHER + ":12", { heartbeat: ago(31 * MIN), state: "transcribing" });
  assert.equal(rowOf("Half Read").buildable, true, "a job that owes work is something to build");
  assert.equal(content.build({ kind: "books", slug: "half-read" }).started, true);
  assert.equal(jobOf(dir).claimedBy, ME());
});
