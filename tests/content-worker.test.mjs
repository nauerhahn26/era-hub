// content-worker.test.mjs — the engine room and the wiring around it (plan
// T2.4): content.js spawns content-worker.js in a worker thread, the worker
// walks the step table over one book folder, and the hub's single
// drive.onSynced slot now feeds BOTH the Clothing Picker and the book scan.
//
// PORTS: 8428 (the hub spawned for the drive.onSynced fan-out). The two
// provider stand-ins bind an EPHEMERAL port (:0) — they exist only to catch a
// request that should never be made, so they need no reserved slot.
//
// MONEY GUARDRAIL (plan §B.2, Gap 20). The gate's default data dir holds a
// real, billable ElevenLabs credential, so the spawned hub gets its own
// mkdtemp ERA_DATA_DIR and ERA_AI_URL / ERA_ELEVEN_URL pointed at stand-ins.
// No data dir in this suite holds an AI key, so transcription HOLDS the moment
// the walk reaches it and no vision step ever runs: the expected recorded AI
// call count is ZERO, and the assertion is what proves the walk stopped where
// we think it did. (The provider steps themselves are covered against their own
// stand-ins in content-transcribe.test.mjs and content-narrate.test.mjs.)
// The two "a step that could not do it all" tests below are the exception: they
// need a step to FAIL, so they get their OWN data dir with a stand-in voice
// credential and their own ElevenLabs stand-in on an ephemeral port, and each
// asserts that stand-in saw the traffic — a count of zero there would mean the
// request escaped ERA_ELEVEN_URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const PORT = 8428;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-content-worker-"));
const DATA = path.join(TMP, "data");
const FOLDER = path.join(TMP, "My Drive", "New ERA Content");   // what Drive for Desktop shows

const T0 = Date.parse("2026-09-04T09:00:00.000Z");
const MIN = 60 * 1000;

let content, store;

function driveCfg(cfg, dataDir = DATA) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "drive.json"), JSON.stringify(cfg));
}

// A pile of photos in the shape a parent drops them: names out of order and
// bytes that are NOT a decodable JPEG, so ingest exercises its "keep the
// original as the page" fallback (that is a success, not a failure).
function book(root, name, files) {
  const dir = path.join(root, "books", name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), Buffer.alloc(bytes, 7));
  return dir;
}

const PHOTOS = { "IMG_0002.jpg": 24, "IMG_0001.jpg": 24, "IMG_0010.jpg": 24 };

before(() => {
  fs.mkdirSync(path.join(FOLDER, "books"), { recursive: true });
  driveCfg({ mode: "local", folderPath: FOLDER });
  const drive = require("./drive.js");
  drive.start(DATA);
  store = require("./content-store.js");
  content = require("./content.js");
  content.start(DATA);
});

// ------------------------------------------------------- the worker contract

test("the worker posts the step it is on, then the finished walk", async () => {
  const dir = book(FOLDER, "Tabby McTat", PHOTOS);
  store.writeJob(dir, store.newJob({ claimedBy: "test", now: T0 }));
  const seen = [];
  const done = await new Promise((resolve, reject) => {
    const w = new Worker(path.join(HUB, "content-worker.js"),
      { workerData: { dataDir: DATA, dir, kind: "books", slug: "tabby-mctat" } });
    w.on("message", (m) => { seen.push(m); if (m.done) resolve(m.done); });
    w.on("error", reject);
    w.on("exit", () => resolve(null));
  });
  assert.ok(done, "the worker must post a {done} before it exits");
  // progress first, result last — the shape clothing-worker.js posts.
  // transcribe is announced and then holds: this data dir has no AI key.
  assert.deepEqual(seen.filter(m => m.step).map(m => m.step), ["ingest", "transcribe"]);
  assert.equal(seen[seen.length - 1].done, done);
  assert.equal(done.slug, "tabby-mctat");
});

// ------------------------------------------------- content.js spawns it

test("run() walks a claimed inbox as far as the table goes", async () => {
  const dir = book(FOLDER, "The Gruffalo", PHOTOS);
  store.writeJob(dir, store.newJob({ claimedBy: "test", now: T0 }));
  const r = await content.run({ kind: "books", slug: "the-gruffalo", dir, dataDir: DATA });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.steps.map(s => s.step), ["ingest"]);
  // the walk stops at the first step that cannot go on, and says which and why:
  // there is no AI key in this data dir, so transcription holds (T2.6)
  assert.equal(r.held, "no-ai-key");
  assert.equal(r.step, "transcribe");
  assert.equal(store.readJob(dir).state, "transcribing");
  assert.ok(fs.existsSync(path.join(dir, "pages", "001.jpg")));
  assert.ok(fs.existsSync(path.join(dir, "sources", "IMG_0001.jpg")));
  // and the claim survived the run — the folder is still ours
  assert.equal(store.readJob(dir).claimedBy, "test");
});

test("status() shows the book while its worker runs, and nothing after", async () => {
  const dir = book(FOLDER, "Zog", PHOTOS);
  store.writeJob(dir, store.newJob({ claimedBy: "test", now: T0 }));
  const p = content.run({ kind: "books", slug: "zog", dir, dataDir: DATA });
  const mid = content.status();
  assert.equal(mid.building, true);
  assert.equal(mid.job.slug, "zog");
  await p;
  await content.idle();
  assert.equal(content.status().building, false);
});

test("one named step re-runs on its own, and never walks the job backwards", async () => {
  const dir = book(FOLDER, "Room on the Broom", PHOTOS);
  store.writeJob(dir, store.newJob({ claimedBy: "test", now: T0 }));
  await content.run({ kind: "books", slug: "room-on-the-broom", dir, dataDir: DATA });
  assert.equal(store.readJob(dir).state, "transcribing");
  const r = await content.run({ kind: "books", slug: "room-on-the-broom", dir, dataDir: DATA, step: "ingest" });
  assert.deepEqual(r.steps.map(s => s.step), ["ingest"]);
  // ingest is idempotent and the job does not fall back to "transcribing"
  assert.equal(store.readJob(dir).state, "transcribing");
});

test("a step nobody has heard of is this run's error, and the shell stays usable", async () => {
  const dir = book(FOLDER, "Stick Man", PHOTOS);
  store.writeJob(dir, store.newJob({ claimedBy: "test", now: T0 }));
  const r = await content.run({ kind: "books", slug: "stick-man", dir, dataDir: DATA, step: "polish" });
  assert.match(r.error, /polish/);
  await content.idle();
  assert.equal(content.status().building, false);
  // the next book still runs
  const ok = await content.run({ kind: "books", slug: "stick-man", dir, dataDir: DATA });
  assert.deepEqual(ok.steps.map(s => s.step), ["ingest"]);
});

test("a book that fell over transiently resumes at the step it fell over on", async () => {
  const dir = book(FOLDER, "Superworm", PHOTOS);
  const job = store.newJob({ claimedBy: "test", now: T0 });
  store.writeJob(dir, store.fail(job, "the network went away", { now: T0 + MIN }));
  assert.equal(store.readJob(dir).state, "failed");
  const r = await content.run({ kind: "books", slug: "superworm", dir, dataDir: DATA });
  assert.deepEqual(r.steps.map(s => s.step), ["ingest"]);
  assert.equal(store.readJob(dir).state, "transcribing");
});

test("a permanent failure is left alone — retrying it would only spend more", async () => {
  const dir = book(FOLDER, "Monkey Puzzle", PHOTOS);
  const job = store.newJob({ claimedBy: "test", now: T0 });
  store.writeJob(dir, store.fail(job, "permanent: that key was refused", { now: T0 + MIN }));
  const r = await content.run({ kind: "books", slug: "monkey-puzzle", dir, dataDir: DATA });
  assert.deepEqual(r.steps, []);
  assert.equal(r.failed, true);
  assert.equal(store.readJob(dir).state, "failed");
  assert.ok(!fs.existsSync(path.join(dir, "pages")), "a permanent failure must not re-run the step");
});

// --------------------------------------------- a step that could not do it all

// A step's non-fatal errors used to be dropped on the floor: the walk read only
// `hold`, so a page whose provider call failed transiently was left wordless or
// silent, the job walked on to `published`, and nothing — not job.json, not
// /content/status, not the Settings card — said a word about it.
//
// These two use the NARRATE step because it is the cheapest one to fail on
// demand: its own data dir (never the gate's) holds a stand-in voice key, and
// ERA_ELEVEN_URL points at a stand-in that answers 500 or 401 to order. The
// stand-in's tally is asserted, so a request that escaped the seam shows up.
let voiceCalls = 0, voiceMode = "500", voice;
const VOICE_DATA = path.join(TMP, "voice-data");

// A book that has already been read: pages, text and a job that owes narration.
function readBook(name) {
  const dir = book(FOLDER, name, {});
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  for (let i = 1; i <= 2; i++)
    fs.writeFileSync(path.join(dir, "pages", "00" + i + ".jpg"), Buffer.alloc(24, 7));
  store.writeText(dir, { pages: [1, 2].map(i =>
    ({ index: i, source: "sources/IMG_" + i + ".jpg", text: "Page " + i + ".", flags: [] })) });
  store.writeJob(dir, store.newJob({ claimedBy: "test", state: "reviewing", now: T0 }));
  return dir;
}

before(async () => {
  fs.mkdirSync(VOICE_DATA, { recursive: true });
  // Stand-in credential, assembled at runtime so era-scan never sees a key-shaped
  // run in a tracked file. Nothing real is reachable from this suite.
  fs.writeFileSync(path.join(VOICE_DATA, "tts-config.json"), JSON.stringify(
    { apiKey: ["test", "-", "voice", "-", "key"].join(""), voiceId: "cgSgspJ2msm6clMCkdW9" }));
  voice = http.createServer((req, res) => {
    voiceCalls++;
    if (voiceMode === "401") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end('{"detail":{"status":"invalid_api_key"}}');
      return;
    }
    res.writeHead(500).end("upstream boom");
  });
  await new Promise(r => voice.listen(0, "127.0.0.1", r));
  // Read fresh per call by content-narrate.js, and copied into every worker
  // thread this suite starts after this point.
  process.env.ERA_ELEVEN_URL = `http://127.0.0.1:${voice.address().port}`;
});

test("a page the voice service could not record holds the step and is written down", async () => {
  voiceMode = "500"; voiceCalls = 0;
  const dir = readBook("Sharing a Shell");
  const r = await content.run({ kind: "books", slug: "sharing-a-shell", dir, dataDir: VOICE_DATA });
  assert.equal(r.held, "retry", "a step that could not finish must not walk the job on");
  assert.equal(r.step, "narrate");
  const job = store.readJob(dir);
  assert.equal(job.state, "reviewing", "the book still owes the narration it did not get");
  assert.ok(job.errors.length > 0, "the failure has to be somewhere a parent can be told about it");
  assert.equal(job.errors[job.errors.length - 1].state, "reviewing");
  // and the Settings card can say so, with a button that restarts this book
  const card = content.jobs().find(x => x.title === "Sharing a Shell");
  assert.ok(card.error, "/content/status must carry the reason, not swallow it");
  assert.ok(!fs.existsSync(path.join(dir, "manifest.json")), "and the book did not publish silent");
  assert.ok(voiceCalls > 0, "zero calls would mean the request escaped ERA_ELEVEN_URL");
});

test("a voice key the provider refused stops the book and says so", async () => {
  voiceMode = "401"; voiceCalls = 0;
  const dir = readBook("The Smartest Giant");
  const r = await content.run({ kind: "books", slug: "the-smartest-giant", dir, dataDir: VOICE_DATA });
  assert.equal(r.failed, true);
  const job = store.readJob(dir);
  assert.equal(job.state, "failed");
  assert.equal(job.failedFrom, "reviewing", "and it resumes at narration once the key is fixed");
  assert.match(job.errors[job.errors.length - 1].msg, /^permanent:/);
  assert.ok(voiceCalls > 0, "zero calls would mean the request escaped ERA_ELEVEN_URL");
  // the refusal is not retried by the next scan — that only buys the same answer
  const again = await content.run({ kind: "books", slug: "the-smartest-giant", dir, dataDir: VOICE_DATA });
  assert.equal(again.failed, true);
});

// ---------------------------------------------------------- the walk finishes

// `published` owes no step, so a walk that stopped there left every book in a
// state the claim rules still consider live: re-claimed and re-spawned every
// thirty minutes for ever, rewriting job.json and log.jsonl inside the family's
// Drive folder each time. `done` is the state nothing takes back.
test("a book with nothing left to do finishes at done, not published", async () => {
  const dir = book(FOLDER, "The Highway Rat", {});
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pages", "001.jpg"), Buffer.alloc(24, 7));
  store.writeText(dir, { pages: [{ index: 1, source: "sources/IMG_1.jpg", text: "One page.", flags: [] }] });
  store.writeJob(dir, store.newJob({ claimedBy: "test", state: "narrating", now: T0 }));
  const r = await content.run({ kind: "books", slug: "the-highway-rat", dir, dataDir: DATA });
  assert.deepEqual(r.steps.map(s => s.step), ["publish"]);
  assert.equal(r.state, "done");
  assert.equal(store.readJob(dir).state, "done");
  assert.ok(fs.existsSync(path.join(dir, "manifest.json")));
});

// ------------------------------------------------------------ payload shipping

// Gap 10: a worker is loaded by PATH, so build-payload.sh's require-guard could
// never see it, and a hub that ships without its worker dies the first time a
// parent adds a book. Belt to the guard's braces (plan T2.4 adaptation).
test("every worker the hub spawns is in build-payload.sh's copy list", () => {
  const sh = fs.readFileSync(path.join(HUB, "tools", "build-payload.sh"), "utf8");
  const copied = new Set([...sh.matchAll(/\$HUB\/([A-Za-z0-9._-]+)/g)].map(m => m[1]));
  const targets = new Set();
  for (const f of fs.readdirSync(HUB).filter(f => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(HUB, f), "utf8");
    for (const m of src.matchAll(/new Worker\(path\.join\(__dirname, "([^"]+)"\)/g)) targets.add(m[1]);
  }
  assert.ok(targets.has("content-worker.js"), "content.js must spawn content-worker.js by path");
  assert.ok(targets.has("clothing-worker.js"));
  for (const t of targets) assert.ok(copied.has(t), t + " is spawned by the hub but not copied into the payload");
  for (const m of ["content.js", "content-store.js", "content-ingest.js", "content-narrate.js",
                   "content-providers.js", "books-index.js", "slug.js", "words.js"])
    assert.ok(copied.has(m), m + " is required by the hub but not copied into the payload");
});

test("the payload guard looks for spawned workers, not only requires", () => {
  const sh = fs.readFileSync(path.join(HUB, "tools", "build-payload.sh"), "utf8");
  assert.match(sh, /new Worker\(path/, "build-payload.sh must scan for new Worker(path.join(__dirname, …))");
});

// -------------------------------------------------- the drive.onSynced fan-out

// Gap 17: that slot is a single property and clothing already owned it. Both
// halves have to fire, so this spawns the real hub and watches both.
test("a Drive sync feeds the Clothing Picker AND the book scan", async () => {
  const data2 = path.join(TMP, "hub-data");
  const folder2 = path.join(TMP, "hub-drive");
  fs.mkdirSync(path.join(folder2, "books"), { recursive: true });
  driveCfg({ mode: "local", folderPath: folder2 }, data2);
  // A claim whose heartbeat stopped an hour ago: takeable at once, so the test
  // never has to wait out the ten-minute quiet period a fresh inbox owes.
  const dir = book(folder2, "The Snail and the Whale", PHOTOS);
  store.writeJob(dir, store.newJob({ claimedBy: "a-laptop-that-closed", now: Date.now() - 60 * MIN }));

  let aiCalls = 0, elevenCalls = 0;
  const stand = (count) => http.createServer((req, res) => { count(); res.writeHead(404).end(); });
  const ai = stand(() => aiCalls++), eleven = stand(() => elevenCalls++);
  await new Promise(r => ai.listen(0, "127.0.0.1", r));
  await new Promise(r => eleven.listen(0, "127.0.0.1", r));

  const child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: data2, ERA_BIND: "127.0.0.1",
           ERA_AI_URL: `http://127.0.0.1:${ai.address().port}`,
           ERA_ELEVEN_URL: `http://127.0.0.1:${eleven.address().port}` },
  });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    let up = false;
    for (let i = 0; i < 150; i++) {
      try { await fetch(`${base}/settings`); up = true; break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(up, "the hub never came up");
    // nothing has run yet: clothing's own startup tick is 20 s away, content's 90 s
    assert.equal((await (await fetch(`${base}/clothing/status`)).json()).guidance, null);

    await fetch(`${base}/integrations/drive/sync`, { method: "POST" });

    let clothingRan = false, bookBuilt = false;
    for (let i = 0; i < 150; i++) {
      if (!clothingRan) {
        const s = await (await fetch(`${base}/clothing/status`)).json();
        // no photos and no key: the build's own word for "there is nothing here"
        if (s.guidance) clothingRan = true;
      }
      if (!bookBuilt) bookBuilt = fs.existsSync(path.join(dir, "pages", "001.jpg"));
      if (clothingRan && bookBuilt) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(clothingRan, "the sync did not reach clothing.regenerate");
    assert.ok(bookBuilt, "the sync did not reach content.scan / the book worker");
    assert.notEqual(store.readJob(dir).claimedBy, "a-laptop-that-closed");
  } finally {
    child.kill("SIGKILL");
    ai.close(); eleven.close();
  }
  // The walk holds AT transcription for want of a key, so neither provider may
  // have been touched. A non-zero count here means a step escaped its seam.
  assert.equal(aiCalls, 0);
  assert.equal(elevenCalls, 0);
});

after(() => {
  if (voice) voice.close();
  delete process.env.ERA_ELEVEN_URL;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
