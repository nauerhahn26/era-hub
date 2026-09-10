// maker-drop.test.mjs — the weekly-book maker's package landing on a real hub,
// end to end (spec §16-A "End to end (phase A exit)", plan V.1).
//
// THE NAME. The plan calls this file after the machine that assembles the book;
// that word is on the release scanner's BLOCK list (era-scan.sh, the pre-commit
// gate), so the file is named for the weekly-book MAKER instead. Same test.
//
// WHAT IT IS. A scratch hub over a local Drive root — the same shape as the
// family PC, where <folderPath>/books is what Drive for Desktop shows and
// <DATA>/books is what the Reader serves — plus the maker's finished package,
// copied in one file at a time with manifest.json LAST, exactly as deliver.py's
// two rclone passes do it (spec §8). Three things are proved in order:
//
//   1. the shelf shows NOTHING until the last byte, then one row, authored:true
//   2. /content/status calls the book done: buildable false, elsewhere false,
//      published true — a book that is made, not a pile waiting for a tap
//   3. an hour of the scan's own ticks starts no step and rewrites no byte
//
// (3) is the one that matters on the family's disk. The maker signs its
// job.json `done` with its OWN device (spec §8's latch) and the hub is a
// different device, so §12's two rules — a folder with a manifest is never an
// inbox, and a pile builds only where a grown-up tapped Build — are all that
// stand between the weekly book and a hub re-reading every page against the
// family's vision key and re-buying the narration. The runJob counter can only
// come back non-zero if one of those rules has gone, which is the regression it
// is here for; the byte comparison of the whole book folder is the same
// sentence said in the strongest form there is. A positive control at the end
// proves the counter is wired to the thing scan() would have called, so a zero
// is a zero and not a dead stub.
//
// PORTS: 8400 (the plan's 8390-8424 range). 8390 board, 8391 reader-ui,
// 8392/8398 books, 8393/8394 pool, 8395/8396 seen held by stale scratch hubs,
// 8397 setup, 8402+ the sibling suites. 8399 is free in this repo and was NOT
// free on the box — a stray python -m http.server sat on it and answered every
// request 404/501, which reads exactly like a broken hub; hence the identity
// check in before(), which fails on "something is listening" rather than
// leaving the next person to debug a mirror that was never asked. Never
// 8377/8378 (live) and never 8425+ (device tunnels answer as the device's live
// hub).
//
// MONEY GUARDRAIL (plan §B.2, Gap 20): the hub gets its own mkdtemp
// ERA_DATA_DIR, so no real credential is anywhere near this suite, and every
// provider seam is pointed at a closed port — answered by the kernel in a
// millisecond, never off this box. Nothing here should reach a provider at all;
// the seams are what makes "should" checkable. Every byte of the fixture is
// synthetic: 64-byte blobs and one-line pages, never real book content.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const PORT = 8400;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-maker-drop-"));
const DATA = path.join(TMP, "data");                          // the hub's ERA_DATA_DIR
const FOLDER = path.join(TMP, "My Drive", "New ERA Content"); // what Drive for Desktop shows
const BOOKS = path.join(FOLDER, "books");                     // where the maker delivers
const STAGE = path.join(TMP, "stage");                        // the package as assembled elsewhere
// The scan half of this suite drives content.js in THIS process on a fake
// clock, over the same Drive folder, and is given its own data dir so two
// processes never write one ledger.
const TICK_DATA = path.join(TMP, "data-ticks");

// This install, and the maker, which is emphatically not it: deviceOf() takes
// the part before the last colon (spec §14), so the hub reads this claim as
// another computer's and §12 forbids the takeover anyway.
const DEVICE = "kitchen-pc";
const MAKER = "book-maker-7c31:41";

const TITLE = "The Paper Boat";
const SLUG = "the-paper-boat";
const BOOK = path.join(BOOKS, TITLE);

// For said() only — the narration fingerprint a re-publish compares against, so
// the fixture carries the hub's own hash rather than a made-up string. Nothing
// else in the module is called and nothing in it reaches a provider.
const narrate = require("./content-narrate.js");

let child, content, drive;

// ---------------------------------------------------------------- the package
//
// Built to the contract in spec §8, whose shapes are the hub's own: the golden
// manifest of tests/content-publish.test.mjs:88-114 and the job.json
// content-store.js newJob() writes. Never real book content — one line a page.
const jpg = (n) => Buffer.alloc(64, n);
const mp3 = (n) => Buffer.concat([Buffer.from("ID3"), Buffer.alloc(60, n)]);
const PAGES = ["A boat of paper.", "It sailed to the gate.", "Then home again."];
const pad = (i) => String(i).padStart(3, "0");

function stage() {
  const dir = path.join(STAGE, TITLE);
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "audio"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".build"), { recursive: true });
  const text = [], narr = [], mpages = [];
  PAGES.forEach((t, i) => {
    const index = i + 1;
    fs.writeFileSync(path.join(dir, "pages", pad(index) + ".jpg"), jpg(index));
    fs.writeFileSync(path.join(dir, "audio", pad(index) + ".mp3"), mp3(index));
    const words = [{ word: t.split(/\s+/)[0], start: 0, end: 0.4 }];
    // `edited: true` — the words are the manuscript's, so no device ever reads
    // the page again against a vision key (spec §8).
    text.push({ index, source: "pages/" + pad(index) + ".jpg", text: t, flags: [],
                cover: index === 1, edited: true });
    narr.push({ index, audio: "audio/" + pad(index) + ".mp3", said: narrate.said(t), words });
    mpages.push({ index, image: "pages/" + pad(index) + ".jpg", text: t,
                  audio: "audio/" + pad(index) + ".mp3", words });
  });
  // cover.jpg is a byte copy of page 1, which is what the hub's own writeCover
  // would have done.
  fs.writeFileSync(path.join(dir, "cover.jpg"), jpg(1));
  const w = (rel, obj) => fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj, null, 2));
  w(".build/text.json", { pages: text });
  w(".build/narration.json", { provider: "elevenlabs", model: "eleven_multilingual_v2",
                               voice: "JBFqnCBsd6RMkjVDRZzb", pages: narr });
  fs.writeFileSync(path.join(dir, ".build", "log.jsonl"),
    JSON.stringify({ step: "assemble", week: "2026-W37", book_id: "paper-boat" }) + "\n" +
    JSON.stringify({ step: "deliver", costs: { art: 0.4, narration: 0.05, clips: 0 } }) + "\n");
  // THE ANTI-REBUILD LATCH (spec §8). `done` is one of the two states
  // takeable() refuses before it looks at anything else, and none of the keys
  // §8 forbids (held, pausedUntil, pausedNote, pausedProvider, failedFrom,
  // autoTitle) is here.
  const t0 = "2026-09-09T21:40:00.000Z", t1 = "2026-09-09T22:07:11.000Z";
  w(".build/job.json", {
    state: "done", claimedBy: MAKER,
    startedAt: new Date(t0).toISOString(), heartbeat: new Date(t1).toISOString(),
    steps: { inbox: { at: t0 }, transcribing: { at: t0 }, reviewing: { at: t0 },
             narrating: { at: t0 }, published: { at: t1 }, done: { at: t1 } },
    errors: [],
    spent: { narrate: { chars: PAGES.join("").length, calls: 3 },
             animate: { chars: 0, calls: 0 } },
  });
  // …and the manifest, which is what makes the folder a book. Written into the
  // staging tree like any other file; what matters is the order it is DELIVERED
  // in, below.
  w("manifest.json", {
    schemaVersion: 1,
    id: "5d0e4a2c-9f3b-5a1e-8c77-0b2d61f4ae90",   // uuid5 of the book id — stable
    slug: SLUG, title: TITLE,
    exportedAt: "2026-09-09T22:07:11.000Z",
    narration: { provider: "elevenlabs", model: "eleven_multilingual_v2",
                 voice: "JBFqnCBsd6RMkjVDRZzb" },
    cover: "cover.jpg", authored: true, pages: mpages,
  });
  return dir;
}

// The delivery order, art first: that is what Drive lands (spec §12's review
// note) and it is the order that puts every trap this test cares about before
// the manifest rather than after it. manifest.json is the second pass, alone.
const DELIVERY = [
  "pages/001.jpg", "pages/002.jpg", "pages/003.jpg", "cover.jpg",
  "audio/001.mp3", "audio/002.mp3", "audio/003.mp3",
  ".build/text.json", ".build/narration.json", ".build/log.jsonl", ".build/job.json",
];
const MANIFEST = "manifest.json";

function deliver(rel) {
  const src = path.join(STAGE, TITLE, rel);
  const dst = path.join(BOOK, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// ------------------------------------------------------------------- helpers

const sync = async () => {
  const r = await fetch(`${BASE}/integrations/drive/sync`, { method: "POST" });
  assert.equal(r.status, 200, "the mirror door answered");
  return r.json();
};
const shelf = async () => {
  const r = await fetch(`${BASE}/books/index.json`);
  assert.equal(r.status, 200);
  return r.json();
};
const statusOf = async () => {
  const r = await fetch(`${BASE}/content/status`);
  assert.equal(r.status, 200);
  return r.json();
};
const rowFor = (body, slug) => (body.jobs || []).find(j => j.slug === slug);

// Every file under a directory as relative path -> sha256, so "nothing was
// touched" can be asserted in the strongest form there is.
function snapshot(root, rel = "", out = new Map()) {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) snapshot(root, r, out);
    else if (e.isFile())
      out.set(r, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, r))).digest("hex"));
  }
  return out;
}
const asObject = (m) => Object.fromEntries([...m].sort());

before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(BOOKS, { recursive: true });
  fs.writeFileSync(path.join(DATA, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: FOLDER }));
  stage();
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    // NOWHERE TO GO (plan §B.2): every provider seam this hub knows, at a
    // closed port. A step that started anyway would fail against the kernel
    // rather than spend a family's allowance — and this suite asserts none
    // starts at all.
    env: { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1",
           ERA_DEVICE_ID: DEVICE,
           ERA_AI_URL: "http://127.0.0.1:1", ERA_ELEVEN_URL: "http://127.0.0.1:1",
           ERA_FAL_URL: "http://127.0.0.1:1", ERA_WEATHER_URL: "http://127.0.0.1:1",
           ERA_GEO_URL: "http://127.0.0.1:1" },
  });
  // …and it has to BE the hub. "Something answered" is not the same question:
  // a stray static server on the port answers every request, and this suite
  // would then have read an empty shelf as the mirror behaving itself.
  let up = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/content/status`);
      if (r.status === 200 && Array.isArray((await r.json()).jobs)) { up = true; break; }
      throw new Error("port " + PORT + " is answering, but not as an era-hub");
    } catch (e) {
      if (String(e.message).includes("not as an era-hub")) throw e;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!up) throw new Error("server never came up");
});
after(() => { if (child) child.kill("SIGKILL"); });

// ------------------------------------------------- 1. the shelf waits for it

test("the shelf is empty while the package is still arriving, whole book or nothing", async () => {
  assert.deepEqual(await shelf(), [], "the scratch hub starts with no books at all");
  for (const rel of DELIVERY) {
    deliver(rel);
    await sync();
    assert.deepEqual(await shelf(), [],
      "the shelf must still be empty after " + rel + " — the manifest is the ready signal");
  }
  // …and the empty shelf above is the MANIFEST's doing, not a dead mirror: the
  // bytes really did cross onto the Reader's side while it stayed empty.
  const mirrored = path.join(DATA, "books", TITLE);
  for (const rel of DELIVERY)
    assert.ok(fs.readFileSync(path.join(mirrored, rel)).equals(fs.readFileSync(path.join(BOOK, rel))),
      rel + " reached <DATA>/books while the shelf was still empty");
});

test("the last byte is the manifest, and then there is exactly one book on the shelf", async () => {
  deliver(MANIFEST);
  await sync();
  const list = await shelf();
  assert.equal(list.length, 1, "one row, the moment the manifest lands");
  const b = list[0];
  assert.equal(b.slug, SLUG);
  assert.equal(b.title, TITLE);
  assert.equal(b.authored, true, "a book somebody wrote, not one this hub read off photos");
  assert.equal(b.pages, 3);
  assert.equal(b.hasVideo, false);
  assert.match(b.cover, new RegExp("^/books/" + SLUG + "/cover\\.jpg\\?v="));
  // the reader can actually open it, which is the whole point of waiting
  const cover = await fetch(BASE + b.cover.split("?")[0]);
  assert.equal(cover.status, 200);
  const page = await fetch(`${BASE}/books/${SLUG}/pages/003.jpg`);
  assert.equal(page.status, 200);
  const audio = await fetch(`${BASE}/books/${SLUG}/audio/003.mp3`);
  assert.equal(audio.status, 200);
});

// ------------------------------------------------------- 2. what the card says

test("/content/status calls it done: nothing to build, nobody else building it", async () => {
  const j = rowFor(await statusOf(), SLUG);
  assert.ok(j, "the maker's folder is on the card");
  assert.equal(j.kind, "books");
  assert.equal(j.title, TITLE);
  assert.equal(j.state, "done");
  assert.equal(j.published, true, "the manifest is there");
  assert.equal(j.buildable, false, "a book that is made offers no Build");
  assert.equal(j.elsewhere, false,
    "a finished job owes no work, so the maker's claim is not another computer building it");
  assert.equal(j.waiting, null, "not a pile waiting for a tap");
  assert.equal(j.step, null, "nothing is owed");
  assert.equal(j.progress.pages, 3);
  assert.equal(j.error, null);
  assert.equal(j.held, null);
  // no device name ever reaches this payload (spec §14)
  const raw = await (await fetch(`${BASE}/content/status`)).text();
  assert.ok(!raw.includes("book-maker"), "the card never names the machine that made it");
});

// ------------------------------------------------------- 3. an hour of ticks

test("an hour of scan ticks starts no step and rewrites no byte of the book", async () => {
  // The same content.js the hub runs, driven here so the clock can be a fake
  // one. Its own data dir; the same Drive folder.
  fs.mkdirSync(TICK_DATA, { recursive: true });
  fs.writeFileSync(path.join(TICK_DATA, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: FOLDER }));
  drive = require("./drive.js");
  drive.start(TICK_DATA);
  content = require("./content.js");
  content.start(TICK_DATA, { deviceId: DEVICE });
  content._testReset({ deviceId: DEVICE });
  // The stub that would be the family's money. _testReset puts the real worker
  // back, so this is set after it.
  let calls = 0;
  content.runJob = () => { calls++; return Promise.resolve({ ok: true }); };

  const before = snapshot(BOOK);
  const jobBefore = fs.readFileSync(path.join(BOOK, ".build", "job.json"));

  const MIN = 60 * 1000;
  const T0 = Date.parse("2026-09-10T08:00:00.000Z");
  let ticks = 0;
  for (let m = 0; m <= 60; m += 5) {
    const res = content.scan({ now: T0 + m * MIN });
    ticks++;
    assert.equal(res.skipped, undefined,
      "the scan really looked — a skipped scan proves nothing about this book");
    const seen = (res.books || []).find(b => b.slug === SLUG);
    assert.ok(seen, "the book is in front of the scan at minute " + m);
    assert.equal(seen.inbox, false, "a folder with a manifest is never an inbox (spec §12)");
    assert.equal(seen.takeable, false, "`done` is refused before anything else is looked at");
    assert.deepEqual(res.claimed, [], "nothing was claimed at minute " + m);
  }
  assert.equal(ticks, 13, "an hour, five minutes at a time, both ends");
  assert.equal(calls, 0, "not one step ran against the weekly book");
  assert.equal(content.isBuilding(), false);

  assert.ok(fs.readFileSync(path.join(BOOK, ".build", "job.json")).equals(jobBefore),
    "job.json is byte-identical after an hour of looking");
  assert.deepEqual(asObject(snapshot(BOOK)), asObject(before),
    "not one byte of the delivered package changed");
  // and the book is still on the shelf it reached — a hub that leaves it alone
  // is not a hub that loses it
  assert.equal((await shelf()).length, 1);
  assert.equal(rowFor(await statusOf(), SLUG).state, "done");
});

// The zero above is only worth having if the counter could ever have moved. It
// is the same stub, on the same module, called the one way scan() would have
// called it.
test("the counter is live: the same stub counts one when a run is actually asked for", async () => {
  let calls = 0;
  content.runJob = () => { calls++; return Promise.resolve({ ok: true }); };
  await content.run({ kind: "books", slug: SLUG, name: TITLE, dir: BOOK, dataDir: TICK_DATA });
  await content.idle();
  assert.equal(calls, 1, "runJob is what a started book goes through");
  // …and even that did not touch the folder, because the worker is a stub.
  assert.equal(fs.existsSync(path.join(BOOK, MANIFEST)), true);
});
