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

let content, store, drive;

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
  content = require("./content.js");
  content.start(DATA);
});

beforeEach(() => {
  fs.rmSync(path.join(FOLDER, "books"), { recursive: true, force: true });
  fs.mkdirSync(path.join(FOLDER, "books"), { recursive: true });
  driveCfg({ mode: "local", folderPath: FOLDER });
  content._testReset();
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

// -------------------------------------------------------------------- status

test("status says what the shell is doing without naming a device or a key", () => {
  const s = content.status();
  assert.equal(s.local, true);
  assert.equal(s.building, false);
  assert.deepEqual(s.queued, []);
  assert.ok(!JSON.stringify(s).toLowerCase().includes("apikey"));
});
