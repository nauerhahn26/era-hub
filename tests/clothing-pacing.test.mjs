// clothing-pacing.test.mjs — the two waits the clothing worker keeps between
// provider calls, and who may change them.
//
//   * 5 s after every photo the photo loop asked the AI provider about
//     (clothing-worker.js namePhotos): free tiers cap requests per minute, and
//     at 1.5 s the family tripped 429/503 all day (dad 9/1-9/2).
//   * 3 s before the one quick retry of a call that met a 5xx or a dropped
//     connection (callModel), added after the 9/1 free-tier 503 storm.
//
// Review r1 ruled that an environment variable meant to shorten a suite must
// not be able to take either away from a family. The maintainer ruled on 10/26
// "Don't wait 5s in the testing environment", so the worker now tells the two
// apart by the provider it will actually call: when ERA_AI_URL (the stand-in
// seam) names a loopback address there is no real provider to protect and both
// waits default to 0; a family's hub never sets ERA_AI_URL and keeps 5 s and
// 3 s, which ERA_AI_SPACING_MS still cannot touch. An explicit `aiPacing`
// option passed to clothing.start() wins over either default.
//
// Two halves, neither of which sleeps through a wait. The shell's half: a
// recording stand-in takes the place of worker_threads' Worker before
// clothing.js loads, and shows what each build hands the worker. The worker's
// half: the real clothing-worker.js runs in a worker thread over an empty data
// dir with the environment a hub would give it, and says the pacing it settled
// on in its first message.
//
// No ports, no hub, no key: temp dirs and worker threads only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-pace-"));
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const threads = require("node:worker_threads");
const RealWorker = threads.Worker;
const spawned = [];
class RecordingWorker extends EventEmitter {
  constructor(file, opts) {
    super();
    spawned.push({ file, workerData: opts && opts.workerData });
    setImmediate(() => this.emit("exit", 0));
  }
}
// clothing.js destructures Worker when it loads, so the stand-in goes in first.
threads.Worker = RecordingWorker;
const clothing = require("./clothing.js");

// ---- the shell: what one build hands the worker ----------------------------
async function handed(opts) {
  clothing.start(TMP, { noTimers: true, ...opts });
  const before = spawned.length;
  await clothing.regenerate(true);
  assert.equal(spawned.length, before + 1, "the build spawned one worker");
  const { file, workerData } = spawned.at(-1);
  assert.equal(path.basename(file), "clothing-worker.js");
  return workerData.aiPacing;
}

test("the shell hands the worker an explicit option, or nothing — never a default of its own", async () => {
  assert.equal(await handed({}), null, "no option: the worker decides from the provider it will call");
  assert.deepEqual(await handed({ aiPacing: { photoMs: 0, retryMs: 0 } }), { photoMs: 0, retryMs: 0 });
  // authoritative, like tz and deviceId (review r2): absent means absent again,
  // never whatever the last start() left behind
  assert.equal(await handed({}), null);
  // each half stands alone; anything that is not a usable number is not handed on
  assert.deepEqual(await handed({ aiPacing: { photoMs: 5000 } }), { photoMs: 5000 });
  assert.deepEqual(await handed({ aiPacing: { photoMs: -1, retryMs: "0" } }), {});
  assert.deepEqual(await handed({ aiPacing: { photoMs: NaN, retryMs: Infinity } }), {});
});

// ---- the worker: the pacing it settles on -----------------------------------
const STAND_IN = "http://127.0.0.1:8418";       // the shape every suite's stand-in has
const PROVIDER = "https://provider.example";     // anything that is not this machine
let dirs = 0;
function workerPacing({ url, spacing, aiPacing = null }) {
  const dataDir = path.join(TMP, "w" + dirs++);
  fs.mkdirSync(dataDir);
  const env = { ...process.env };
  delete env.ERA_AI_URL; delete env.ERA_AI_SPACING_MS;
  if (url !== undefined) env.ERA_AI_URL = url;
  if (spacing !== undefined) env.ERA_AI_SPACING_MS = spacing;
  // a re-sort of an empty wardrobe: no photo, no provider, no picture drawn
  const w = new RealWorker(path.join(HUB, "clothing-worker.js"), { env, workerData: {
    dataDir, force: true, rebuildOnly: true, refit: false, weatherRetry: false,
    tz: "UTC", deviceId: "dev-pace", driveFolder: null, aiPacing } });
  return new Promise((resolve, reject) => {
    let pacing = null;
    w.on("message", (m) => { if (m && m.pacing && !pacing) pacing = m.pacing; });
    w.on("error", reject);
    w.on("exit", () => pacing ? resolve(pacing) : reject(new Error("the worker never said its pacing")));
  });
}
const FAMILY = { photoMs: 5000, retryMs: 3000 };
const NONE = { photoMs: 0, retryMs: 0 };

test("a family's hub (no ERA_AI_URL) waits 5 s and 3 s, and ERA_AI_SPACING_MS cannot change that", async () => {
  assert.deepEqual(await workerPacing({}), FAMILY);
  assert.deepEqual(await workerPacing({ spacing: "1" }), FAMILY, "the attrs pass's seam reaches neither wait");
});

test("a provider that is not this machine keeps both waits, even with ERA_AI_SPACING_MS set (review r1)", async () => {
  assert.deepEqual(await workerPacing({ url: PROVIDER, spacing: "1" }), FAMILY);
  // a host that only starts like a loopback name is somebody else's machine
  for (const url of ["http://127.0.0.1.example.com:8418", "http://localhost.example:8418", "not a url"])
    assert.deepEqual(await workerPacing({ url }), FAMILY, url);
});

test("a stand-in on a loopback address waits nothing (maintainer 10/26: no 5 s in the testing environment)", async () => {
  for (const url of [STAND_IN, "http://localhost:8418", "http://[::1]:8418", "http://127.0.0.1:1"])
    assert.deepEqual(await workerPacing({ url }), NONE, url);
});

test("an explicit option wins both ways, half by half", async () => {
  assert.deepEqual(await workerPacing({ url: STAND_IN, aiPacing: FAMILY }), FAMILY, "a stand-in can be paced like a family");
  assert.deepEqual(await workerPacing({ url: PROVIDER, aiPacing: NONE }), NONE, "and test code can unpace a provider URL");
  assert.deepEqual(await workerPacing({ url: STAND_IN, aiPacing: { photoMs: 5000 } }), { photoMs: 5000, retryMs: 0 });
  assert.deepEqual(await workerPacing({ aiPacing: { retryMs: 0 } }), { photoMs: 5000, retryMs: 0 });
});

// The sleeps themselves: the two waits above are the only ones the photo loop
// and the retry take, so no literal can outlive the rule.
test("the worker's two sleeps use the settled pacing, and no literal 5 s or 3 s sleep is left", () => {
  const src = fs.readFileSync(path.join(HUB, "clothing-worker.js"), "utf8");
  assert.match(src, /if \(usedAi\) await new Promise\(r => setTimeout\(r, PHOTO_SPACING_MS\)\);/);
  assert.match(src, /if \(attempt\) await new Promise\(r => setTimeout\(r, RETRY_GAP_MS\)\);/);
  assert.doesNotMatch(src, /setTimeout\(r, (5000|3000)\)/, "a literal sleep the rule cannot reach");
});

test("server.js never passes the option: a family's hub is paced by the rule alone", () => {
  const src = fs.readFileSync(path.join(HUB, "server.js"), "utf8");
  assert.doesNotMatch(src, /aiPacing/);
});
