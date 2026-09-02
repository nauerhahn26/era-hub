// clothing.js — thin shell for the Clothing Picker. The actual pipeline
// (HEIC decode, AI ingest, composites, board build) lives in
// clothing-worker.js and runs in a WORKER THREAD: on 8/31 dad's ingest froze
// every hub page — Settings' "Back to apps" included — because the pixel
// loops starved the event loop. The shell only tracks state, spawns one
// worker at a time, and answers /clothing/status instantly.
"use strict";
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const { listPhotos } = require("./clothing-photos");

const PROVIDERS = ["anthropic", "openai", "google"];

let DATA = null;
let worker = null;
let ingesting = null;   // {done, total} live from the worker
let lastResult = null;
let queued = false;     // a regenerate asked for while one was running
let waiters = [];       // callers that arrived mid-build, awaiting the queued run

function aiCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(DATA, "ai-config.json"), "utf8"));
    if (typeof c.apiKey !== "string" || !c.apiKey) return null;
    return { provider: PROVIDERS.includes(c.provider) ? c.provider : "google" };
  } catch { return null; }
}

function isBuilding() { return !!worker; }

function status() {
  const cfg = aiCfg();
  let cataloged = 0, photos = 0;
  try {
    const cat = JSON.parse(fs.readFileSync(path.join(DATA, "wardrobe.json"), "utf8"));
    cataloged = Object.values(cat.items || {}).filter(i => i.ok).length;
  } catch {}
  photos = listPhotos(path.join(DATA, "clothing")).length;
  return { building: !!worker, ingesting, cataloged, photos,
    aiConfigured: !!cfg, aiProvider: cfg ? cfg.provider : null,
    guidance: lastResult && lastResult.guidance ? lastResult.guidance : null };
}

function regenerate(force) {
  // One build at a time. A caller that arrives mid-build gets the QUEUED run's
  // result, not a bare {busy} it would have to poll for (9/1: a sync landing
  // during a build silently did nothing from the caller's point of view).
  if (worker) {
    queued = true;
    return new Promise((resolve) => { waiters.push(resolve); });
  }
  return new Promise((resolve) => {
    worker = new Worker(path.join(__dirname, "clothing-worker.js"),
      { workerData: { dataDir: DATA, force: !!force } });
    worker.on("message", (m) => {
      if ("ingesting" in m) ingesting = m.ingesting;
      if (m.done) lastResult = m.done;
    });
    worker.on("error", (e) => console.error("[clothing] worker: " + e.message));
    worker.on("exit", () => {
      worker = null; ingesting = null;
      const result = lastResult || {};
      resolve(result);
      if (queued) {
        queued = false;
        const pending = waiters; waiters = [];
        regenerate(true).then(r => pending.forEach(w => w(r)),
                              () => pending.forEach(w => w({})));
      } else if (waiters.length) {
        const pending = waiters; waiters = [];
        pending.forEach(w => w(result));
      }
    });
  });
}

// Scheduling (dad 9/1: "run locally each morning if it's awake, or as soon as
// it wakes, and re-sort by the weather"). Three triggers, all local:
//   * shortly after the hub starts  — covers "the computer just woke up"
//   * every 15 minutes, but only ACTS when the day's board is missing or was
//     built before this morning's cutoff — covers "it was already awake"
//   * the Drive sync's onSynced hook (new photos land -> rebuild)
// The build itself always re-reads the weather, so the outfits are sorted for
// the day the child is actually dressing for.
const MORNING_HOUR = 5;   // local time from which "today's board" is expected

function boardIsFresh(dataDir) {
  try {
    const f = path.join(dataDir, "recipes", "today.json");
    const built = fs.statSync(f).mtime;
    const now = new Date();
    const cutoff = new Date(now); cutoff.setHours(MORNING_HOUR, 0, 0, 0);
    // before 5am the previous evening's board still counts as today's
    if (now < cutoff) cutoff.setDate(cutoff.getDate() - 1);
    return built >= cutoff;
  } catch { return false; }
}

// What the tick last saw in clothing/ (names + sizes). A family that adds or
// deletes photos at 3pm — Drive folder or the data folder itself — expects
// the board to follow that afternoon, not tomorrow morning (dad 9/2: "all
// that should just work by adding to the clothing directory").
let seenPhotos = null;
function photoSet(dataDir) {
  const dir = path.join(dataDir, "clothing");
  return listPhotos(dir).map(f => {
    try { return f + ":" + fs.statSync(path.join(dir, f)).size; } catch { return f; }
  }).join("\n");
}

// Returns the build's promise when it acts, null when there is nothing to do.
function tick(reason) {
  const now = photoSet(DATA);
  const changed = seenPhotos !== null && now !== seenPhotos;
  seenPhotos = now;
  if (!changed && boardIsFresh(DATA)) return null;
  console.log("[clothing] building today's board (" + (changed ? "photos changed, " : "") + reason + ")");
  return regenerate(true).catch(e => console.error("[clothing] " + e.message));
}

function start(dataDir) {
  DATA = dataDir;
  setTimeout(() => tick("startup/wake"), 20 * 1000).unref();
  setInterval(() => tick("morning check"), 15 * 60 * 1000).unref();
}

module.exports = { start, regenerate, isBuilding, status, boardIsFresh, tick };
