// content-claim.test.mjs — the shell that decides WHICH book folder is worth
// starting and whether this hub is allowed to start it (spec §2 "Rules", plan
// T2.2). Everything here is disk plus a fake clock: no server, no port, no
// network, no key, and no real waiting — the ten-minute quiet period and the
// thirty-minute stale claim are both driven by scan({now}).
// (Port table: this suite claims none — plan §B.)
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-claim-"));
const DATA = path.join(TMP, "data");
const FOLDER = path.join(TMP, "My Drive", "New ERA Content");   // what Drive for Desktop shows

let content, store, drive, booksIndex;

const MIN = 60 * 1000;
const T0 = Date.parse("2026-09-04T09:00:00.000Z");

// The hub's own Drive config: local mode with a folder is the only mode a
// content job may run in (plan Gap 1 — there is no upload path in API mode).
function driveCfg(cfg) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "drive.json"), JSON.stringify(cfg));
}

function book(name, photos) {
  const dir = path.join(FOLDER, "books", name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, bytes] of Object.entries(photos || {}))
    fs.writeFileSync(path.join(dir, f), Buffer.alloc(bytes, 7));
  return dir;
}

const jobOf = (dir) => store.readJob(dir);
const found = (res, name) => (res.books || []).find(b => b.name === name);

before(() => {
  fs.mkdirSync(path.join(FOLDER, "books"), { recursive: true });
  driveCfg({ mode: "local", folderPath: FOLDER });
  drive = require("./drive.js");
  drive.start(DATA);
  store = require("./content-store.js");
  booksIndex = require("./books-index.js");
  content = require("./content.js");
  content.start(DATA);
});

beforeEach(async () => {
  // Let anything the LAST test started finish before its folder is taken away.
  // A claim spawns a build, and a build that is still running while the next
  // test wipes books/ raced it: `rmSync` walked a directory a worker thread was
  // still writing into and threw ENOTEMPTY, failing whichever test happened to
  // be next (about one run in four before this line existed).
  await content.idle();
  fs.rmSync(path.join(FOLDER, "books"), { recursive: true, force: true });
  fs.mkdirSync(path.join(FOLDER, "books"), { recursive: true });
  driveCfg({ mode: "local", folderPath: FOLDER });
  content._testReset();
  // …and no build here is a REAL one. This suite is about which folder gets
  // claimed, not about what a build does (content-worker.test.mjs is), and
  // _testReset puts the real worker back, so every scan() below would otherwise
  // spawn a thread that reads and writes inside a folder the next test deletes.
  // A test that cares what was started replaces this with a stub of its own.
  content.runJob = () => Promise.resolve({ ok: true });
});

// ------------------------------------------------------------ where it runs

test("API mode is skipped — nothing this hub builds could ever reach Drive", () => {
  driveCfg({ mode: "api", folderId: "F0", token: { refresh_token: "x" } });
  assert.deepEqual(content.scan({ now: T0 }), { skipped: "needs-local-drive" });
});

test("local mode with no folder chosen yet is skipped too", () => {
  driveCfg({ mode: "local", folderPath: "" });
  assert.deepEqual(content.scan({ now: T0 }), { skipped: "needs-local-drive" });
});

test("a missing books/ folder is not an error", () => {
  fs.rmSync(path.join(FOLDER, "books"), { recursive: true, force: true });
  const res = content.scan({ now: T0 });
  assert.deepEqual(res.books, []);
  assert.deepEqual(res.claimed, []);
});

// ------------------------------------------------------------- the inbox test

test("images and no job.json make a folder an inbox", () => {
  book("Tabby McTat", { "IMG_1.jpg": 10, "IMG_2.jpg": 12 });
  const b = found(content.scan({ now: T0 }), "Tabby McTat");
  assert.equal(b.inbox, true);
  assert.equal(b.images, 2);
  assert.equal(b.slug, "tabby-mctat");   // the shelf addresses it by this
});

test("a folder with no images is not an inbox", () => {
  const dir = book("Notes", {});
  fs.writeFileSync(path.join(dir, "readme.txt"), "hello");
  const b = found(content.scan({ now: T0 }), "Notes");
  assert.equal(b.inbox, false);
  assert.equal(b.images, 0);
});

test("a folder that already has job.json is not an inbox", () => {
  const dir = book("Started", { "IMG_1.jpg": 10 });
  store.writeJob(dir, store.newJob({ claimedBy: "someone-else", now: T0 }));
  const b = found(content.scan({ now: T0 + 60 * MIN }), "Started");
  assert.equal(b.inbox, false);
  assert.equal(b.state, "inbox");        // the job's state, not the folder's
});

// ---------------------------------------------------------- the quiet period

test("a first sighting is never claimed — one observation proves nothing", () => {
  const dir = book("Fresh", { "IMG_1.jpg": 10 });
  const res = content.scan({ now: T0 });
  assert.equal(found(res, "Fresh").quiet, false);
  assert.deepEqual(res.claimed, []);
  assert.equal(jobOf(dir), null);
});

test("a listing that changed between observations is not claimable", () => {
  const dir = book("Uploading", { "IMG_1.jpg": 10 });
  content.scan({ now: T0 });
  fs.writeFileSync(path.join(dir, "IMG_2.jpg"), Buffer.alloc(10, 7));   // still uploading
  const res = content.scan({ now: T0 + 11 * MIN });
  assert.equal(found(res, "Uploading").quiet, false);
  assert.deepEqual(res.claimed, []);
  assert.equal(jobOf(dir), null);
});

test("a file that only grew is a change too — half an upload has the same name", () => {
  const dir = book("Growing", { "IMG_1.jpg": 10 });
  content.scan({ now: T0 });
  fs.writeFileSync(path.join(dir, "IMG_1.jpg"), Buffer.alloc(4096, 7));
  assert.deepEqual(content.scan({ now: T0 + 11 * MIN }).claimed, []);
  assert.equal(jobOf(dir), null);
});

test("unchanged but under ten minutes is not claimable yet", () => {
  const dir = book("Nearly", { "IMG_1.jpg": 10 });
  content.scan({ now: T0 });
  const res = content.scan({ now: T0 + 9 * MIN });
  assert.equal(found(res, "Nearly").quiet, false);
  assert.equal(jobOf(dir), null);
});

test("unchanged across ten minutes is claimed, and the claim is a full job.json", () => {
  const dir = book("Quiet Book", { "IMG_1.jpg": 10, "IMG_2.jpg": 10 });
  content.scan({ now: T0 });
  const res = content.scan({ now: T0 + 10 * MIN });
  assert.deepEqual(res.claimed, ["quiet-book"]);
  const job = jobOf(dir);
  assert.equal(job.state, "inbox");
  assert.ok(job.claimedBy, "a claim names its worker");
  assert.equal(job.heartbeat, new Date(T0 + 10 * MIN).toISOString());
  assert.equal(job.startedAt, job.heartbeat);
  assert.deepEqual(job.errors, []);
  assert.ok(job.steps && job.steps.inbox, "the state it was born in is a step it entered");
});

test("the quiet clock is content.js's own, not the sync count", () => {
  // Six manual syncs inside one minute must not add up to a quiet period
  // (plan Gap 18: a POST /integrations/drive/sync burst cannot claim a
  // half-uploaded book).
  const dir = book("Bursty", { "IMG_1.jpg": 10 });
  for (let i = 0; i <= 6; i++) content.scan({ now: T0 + i * 10 * 1000 });
  assert.equal(jobOf(dir), null);
  content.scan({ now: T0 + 10 * MIN });
  assert.ok(jobOf(dir), "ten minutes of wall clock is what claims it");
});

test("the claim is written atomically and leaves no .tmp behind", () => {
  const dir = book("Atomic", { "IMG_1.jpg": 10 });
  content.scan({ now: T0 });
  content.scan({ now: T0 + 10 * MIN });
  const built = fs.readdirSync(store.buildDir(dir)).sort();
  assert.deepEqual(built, ["job.json", "log.jsonl"]);   // the claim, and the line saying so
  assert.ok(!built.some(f => f.endsWith(".tmp")), "a .tmp is a half-written claim Drive would mirror");
});

// ------------------------------------------------------------- stale claims

test("a fresh claim from another device is left alone", () => {
  const dir = book("Theirs", { "IMG_1.jpg": 10 });
  const theirs = store.writeJob(dir, store.newJob({ claimedBy: "other-hub", state: "transcribing", now: T0 }));
  const res = content.scan({ now: T0 + 29 * MIN });
  assert.equal(found(res, "Theirs").takeable, false);
  assert.deepEqual(res.claimed, []);
  assert.equal(jobOf(dir).claimedBy, "other-hub");
  assert.equal(jobOf(dir).heartbeat, theirs.heartbeat);
});

test("a claim whose heartbeat is 31 minutes old may be taken over, keeping its history", () => {
  const dir = book("Abandoned", { "IMG_1.jpg": 10 });
  let job = store.newJob({ claimedBy: "other-hub", state: "transcribing", now: T0 });
  job = store.fail(job, "the network went away", { now: T0 });
  job = store.transition(job, "transcribing", { now: T0 });
  store.writeJob(dir, job);
  const res = content.scan({ now: T0 + 31 * MIN });
  assert.equal(found(res, "Abandoned").takeable, true);
  assert.deepEqual(res.claimed, ["abandoned"]);
  const taken = jobOf(dir);
  assert.notEqual(taken.claimedBy, "other-hub");
  assert.equal(taken.state, "transcribing");                       // resumes where it fell over
  assert.equal(taken.heartbeat, new Date(T0 + 31 * MIN).toISOString());
  assert.equal(taken.startedAt, new Date(T0).toISOString());       // the book started then
  assert.equal(taken.errors.length, 1, "an earlier failure is history a parent needs");
});

test("a finished book is never taken over, however old its heartbeat", () => {
  const dir = book("Done", { "IMG_1.jpg": 10 });
  let job = store.newJob({ claimedBy: "other-hub", state: "published", now: T0 });
  job = store.transition(job, "done", { now: T0 });
  store.writeJob(dir, job);
  const res = content.scan({ now: T0 + 10 * 60 * MIN });
  assert.equal(found(res, "Done").takeable, false);
  assert.deepEqual(res.claimed, []);
  assert.equal(jobOf(dir).claimedBy, "other-hub");
});

// Every published book sits in the family's Drive folder for good. If the only
// exemption were `done`, a published one would be re-claimed on the first scan
// after its heartbeat went stale and then every thirty minutes forever, and each
// re-claim rewrites job.json and appends to log.jsonl INSIDE the Drive folder —
// which Drive then re-uploads and re-mirrors to every device, for ever.
test("a published book is never re-claimed, however old its heartbeat", () => {
  const dir = book("Out", { "IMG_1.jpg": 10 });
  const was = store.writeJob(dir, store.newJob({ claimedBy: "other-hub", state: "published", now: T0 }));
  const res = content.scan({ now: T0 + 31 * MIN });
  assert.equal(found(res, "Out").takeable, false);
  assert.deepEqual(res.claimed, []);
  assert.deepEqual(jobOf(dir), was, "the scan rewrote nothing in the family's Drive folder");
  assert.equal(store.readLog(dir).length, 0, "and appended nothing to the log");
});

test("a book that failed for good is never re-claimed — the refusal costs nothing to repeat", () => {
  const dir = book("Refused", { "IMG_1.jpg": 10 });
  let job = store.newJob({ claimedBy: "other-hub", state: "transcribing", now: T0 });
  job = store.fail(job, "permanent: that key was refused", { now: T0 });
  const was = store.writeJob(dir, job);
  const res = content.scan({ now: T0 + 31 * MIN });
  assert.equal(found(res, "Refused").takeable, false);
  assert.deepEqual(res.claimed, []);
  assert.deepEqual(jobOf(dir), was);
});

test("two scans in a row do not claim the same book twice", async () => {
  const dir = book("Once", { "IMG_1.jpg": 10 });
  const jobs = [];
  content.runJob = (job) => { jobs.push(job.slug); return Promise.resolve({ ok: true }); };
  content.scan({ now: T0 });
  content.scan({ now: T0 + 10 * MIN });
  const first = jobOf(dir);
  const res = content.scan({ now: T0 + 20 * MIN });
  assert.deepEqual(res.claimed, []);
  assert.deepEqual(jobOf(dir), first, "the second scan rewrote nothing");
  await content.idle();
  assert.deepEqual(jobs, ["once"], "and it started the job exactly once");
});

// -------------------------------------------------------------- single flight

test("one job at a time: the second book waits for the first", async () => {
  const order = [];
  let release;
  content.runJob = (job) => {
    order.push("start:" + job.slug);
    return new Promise((res) => { release = () => res({ slug: job.slug }); })
      .then(r => { order.push("end:" + job.slug); return r; });
  };
  const a = content.run({ kind: "books", slug: "a", dir: path.join(FOLDER, "books", "A") });
  const b = content.run({ kind: "books", slug: "b", dir: path.join(FOLDER, "books", "B") });
  assert.deepEqual(order, ["start:a"], "B has not started while A runs");
  assert.equal(content.isBuilding(), true);
  const relA = release; relA();
  assert.deepEqual(await a, { slug: "a" });
  const relB = release; relB();
  assert.deepEqual(await b, { slug: "b" });
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b"]);
  assert.equal(content.isBuilding(), false);
});

test("asking for the running book again joins it instead of queueing a second run", async () => {
  let calls = 0, release;
  content.runJob = (job) => { calls++; return new Promise((res) => { release = () => res({ n: calls }); }); };
  const dir = path.join(FOLDER, "books", "Same");
  const a = content.run({ kind: "books", slug: "same", dir });
  const b = content.run({ kind: "books", slug: "same", dir });
  release();
  assert.deepEqual(await a, { n: 1 });
  assert.deepEqual(await b, { n: 1 });
  assert.equal(calls, 1);
});

test("a job that throws does not wedge the queue", async () => {
  const seen = [];
  content.runJob = (job) => {
    seen.push(job.slug);
    if (job.slug === "bad") return Promise.reject(new Error("boom"));
    return Promise.resolve({ ok: true });
  };
  const bad = content.run({ kind: "books", slug: "bad", dir: path.join(FOLDER, "books", "Bad") });
  const good = content.run({ kind: "books", slug: "good", dir: path.join(FOLDER, "books", "Good") });
  const r = await bad;
  assert.match(r.error, /boom/);
  assert.deepEqual(await good, { ok: true });
  assert.deepEqual(seen, ["bad", "good"]);
  assert.equal(content.isBuilding(), false);
});

// ---------------------------------------------------------------- the job list

// The Settings card renders "N of M pages read" and the board renders "page N
// of M" straight off progress. Counting only the pages already transcribed
// makes M chase N, so a twelve-page book part-way through says "4 of 4" and
// reads as finished.
test("a part-read book's page total is the whole book, not the pages read so far", () => {
  const dir = book("Twelve Pages", {});
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  for (let i = 1; i <= 12; i++)
    fs.writeFileSync(path.join(dir, "pages", String(i).padStart(3, "0") + ".jpg"), Buffer.alloc(8, 7));
  store.writeJob(dir, store.newJob({ claimedBy: "test", state: "transcribing", now: T0 }));
  store.writeText(dir, { pages: [1, 2, 3, 4].map(i =>
    ({ index: i, source: "sources/IMG_" + i + ".jpg", text: "a word", flags: [] })) });
  const j = content.jobs().find(x => x.title === "Twelve Pages");
  assert.equal(j.progress.pages, 12, "the card would otherwise say '4 of 4 pages read'");
  assert.equal(j.progress.transcribed, 4);
});

// One resolver assigns every slug (books-index.js). Bare slugify() cannot: two
// titles collapse onto one slug (so /content/run and the review link address
// the wrong folder) and a title with no Latin letters slugifies to nothing at
// all (so the link is dead), while the shelf serves both perfectly well.
test("two titles that slugify alike, and one with no Latin letters, get one slug each", async () => {
  // A worker still finishing an earlier test can recreate its folder under us,
  // so this test speaks only about the three books it made itself.
  await content.idle();
  const titles = ["Tabby McTat", "Tabby, McTat!", "えほん"];
  for (const t of titles) book(t, { "IMG_1.jpg": 10 });
  const jobs = content.jobs().filter(j => titles.includes(j.title));
  const slugs = jobs.map(j => j.slug);
  assert.equal(slugs.length, 3);
  assert.equal(new Set(slugs).size, 3, "two books must never share a slug: " + slugs.join(" "));
  assert.ok(slugs.every(Boolean), "a book with no slug has no review link: " + slugs.join(" "));
  // The shelf and the builder must agree, or Settings' "Review this book" and
  // the board's review link point at a book the reader does not serve.
  const shelf = booksIndex.bookDirs(path.join(FOLDER, "books")).list
    .filter(e => titles.includes(e.dir)).map(e => e.slug);
  assert.deepEqual(slugs.slice().sort(), shelf.slice().sort());
  for (const j of jobs) assert.equal(content.bookFor(j.slug, { folderPath: FOLDER }).name, j.title);
});

// ------------------------------------------ the whole-book actions (T3.4, §5)
//
// The two rules the review page's own suite cannot reach from a browser: which
// pages "Read the photos again" would pay for, and the refusal that stops a
// book being deleted out from under the worker that is building it.

// A book with text.json already written, one page of it typed by a grown-up.
function reviewedBook(name) {
  const dir = book(name, {});
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  for (const i of [1, 2, 3])
    fs.writeFileSync(path.join(dir, "pages", String(i).padStart(3, "0") + ".jpg"), Buffer.alloc(8, i));
  store.writeText(dir, {
    pages: [
      { index: 1, source: "pages/001.jpg", text: "read by the model", flags: [], cover: true },
      { index: 2, source: "pages/002.jpg", text: "typed by a grown-up", flags: [], edited: true },
      { index: 3, source: "pages/003.jpg", text: "read by the model", flags: [] },
    ],
  });
  return dir;
}

test("'read the photos again' pays for the pages a grown-up did not type", () => {
  const dir = reviewedBook("Rebuildable");
  assert.deepEqual(content.rebuildPages(dir, true), [1, 3], "the page they typed is kept");
  assert.deepEqual(content.rebuildPages(dir, false), [1, 2, 3], "unticked, the photos win everywhere");
  // A photo that was never read at all is picked up by the same press: the
  // union of what is on disk and what text.json knows about.
  fs.writeFileSync(path.join(dir, "pages", "004.jpg"), Buffer.alloc(8, 4));
  assert.deepEqual(content.rebuildPages(dir, true), [1, 3, 4]);
  // A book nothing has read yet asks for nothing in particular — the ordinary
  // step already reads every page with no words.
  assert.equal(content.rebuildPages(book("Untouched", { "IMG_1.jpg": 10 }), true), null);
});

test("a book being built right now cannot be removed out from under the worker", async () => {
  const dir = book("Busy", { "IMG_1.jpg": 10 });
  let release;
  content.runJob = () => new Promise((res) => { release = () => res({ ok: true }); });
  const running = content.run({ kind: "books", slug: "busy", name: "Busy", dir });
  const no = content.removeBook({ kind: "books", slug: "busy" });
  assert.match(no.error, /right now/);
  assert.ok(fs.existsSync(dir), "and the folder is still there");
  release();
  await running;
  // Once it has stopped, the same press removes it.
  const yes = content.removeBook({ kind: "books", slug: "busy" });
  assert.deepEqual(yes, { removed: true, slug: "busy", title: "Busy" });
  assert.ok(!fs.existsSync(dir));
});

test("a remove can only ever name a folder directly inside books/", () => {
  const dir = book("Keep Me", { "IMG_1.jpg": 10 });
  const outside = path.join(FOLDER, "clothing");
  fs.mkdirSync(outside, { recursive: true });
  for (const slug of ["..", "../..", "../clothing", "/etc", ".", "keep-me/pages", "no-such-book"])
    assert.equal(content.removeBook({ kind: "books", slug }).error, "unknown book", slug);
  assert.equal(content.removeBook({ kind: "music", slug: "keep-me" }).error, "unknown kind");
  assert.ok(fs.existsSync(dir));
  assert.ok(fs.existsSync(outside), "nothing beside books/ is reachable from this door");
  assert.ok(fs.existsSync(path.join(FOLDER, "books")));
});

// -------------------------------------------------------------------- status

test("status says what the shell is doing without naming a device or a key", () => {
  const s = content.status();
  assert.equal(s.local, true);
  assert.equal(s.building, false);
  assert.deepEqual(s.queued, []);
  assert.ok(!JSON.stringify(s).toLowerCase().includes("apikey"));
});
