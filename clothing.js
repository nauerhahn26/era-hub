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
const { aiRoles } = require("./ai-config.js");

let DATA = null;
let worker = null;
let ingesting = null;   // {done, total} live from the worker
let lastResult = null;
let queued = false;     // a regenerate asked for while one was running
let queuedFull = false; // ...and at least one of those callers wanted a FULL build
let waiters = [];       // callers that arrived mid-build, awaiting the queued run

// The shell only ever needs to SAY which provider is configured (/clothing/status
// is public), so it drops the key on the floor here; the worker reads the same
// role for the calls it makes.
function aiCfg() {
  const v = aiRoles(DATA).vision;
  return v ? { provider: v.provider } : null;
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
    // photos not named yet, and whether today's free allowance is what stops them
    waiting: cfg ? pendingPhotos(DATA) : 0, heldToday: holdDay === new Date().toDateString(),
    guidance: lastResult && lastResult.guidance ? lastResult.guidance : null };
}

function regenerate(force, opts = {}) {
  // One build at a time. A caller that arrives mid-build gets the QUEUED run's
  // result, not a bare {busy} it would have to poll for (9/1: a sync landing
  // during a build silently did nothing from the caller's point of view).
  // The queued run is the widest thing anyone asked for: a full build if ANY
  // waiter wanted one, a re-sort if they all only wanted a re-sort. It used to
  // be a full build unconditionally, which turned the second half of setting a
  // weather window (two POSTs, seconds apart) into photo ingest and spent AI
  // requests — the one thing the re-sort door promises never to do (9/5).
  if (worker) {
    queued = true;
    if (!opts.rebuildOnly) queuedFull = true;
    return new Promise((resolve) => { waiters.push(resolve); });
  }
  return new Promise((resolve) => {
    let done = null;
    worker = new Worker(path.join(__dirname, "clothing-worker.js"),
      { workerData: { dataDir: DATA, force: !!force, rebuildOnly: !!opts.rebuildOnly } });
    worker.on("message", (m) => {
      if ("ingesting" in m) ingesting = m.ingesting;
      if (m.done) {
        done = m.done;
        // A re-sort that found nothing catalogued has no ingest behind it, so
        // it knows nothing about the allowance or a busy provider: keeping the
        // old verdict leaves the board's "allowance used up" coaching standing
        // instead of dropping it to the generic Drive message (9/5).
        if (!m.done.rebuildOnly) lastResult = m.done;
        // Photos left behind by the day's allowance wait for tomorrow, and so
        // does a photo that failed twice (a retry that landed nothing): an
        // hourly loop into the same wall would only spend the free requests.
        if (m.done.left && (m.done.quotaHit || (retryBuild && !m.done.landed))) holdDay = new Date().toDateString();
        retryBuild = false;
      }
    });
    worker.on("error", (e) => console.error("[clothing] worker: " + e.message));
    worker.on("exit", () => {
      worker = null; ingesting = null;
      const result = done || lastResult || {};
      resolve(result);
      if (queued) {
        const full = queuedFull;
        queued = false; queuedFull = false;
        const pending = waiters; waiters = [];
        regenerate(true, { rebuildOnly: !full }).then(r => pending.forEach(w => w(r)),
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

// Photos the AI has not named yet. A transient 503 or a hub restart mid-batch
// must not park a garment until tomorrow's 5am build (QA 9/2: 12 of 20 photos
// waited a day) — the tick tries the leftovers again about once an hour,
// except on a day the allowance already ran out (holdDay).
let holdDay = "";
let lastRetry = 0;
let retryBuild = false;   // the running build is a retry of leftovers
const RETRY_EVERY = 60 * 60 * 1000;
function pendingPhotos(dataDir) {
  let items = {};
  try { items = JSON.parse(fs.readFileSync(path.join(dataDir, "wardrobe.json"), "utf8")).items || {}; } catch {}
  return listPhotos(path.join(dataDir, "clothing")).filter(f => !(items[f] && items[f].ok)).length;
}

// Returns the build's promise when it acts, null when there is nothing to do.
function tick(reason) {
  const now = photoSet(DATA);
  const changed = seenPhotos !== null && now !== seenPhotos;
  seenPhotos = now;
  let why = changed ? "photos changed, " : "";
  if (!changed && boardIsFresh(DATA)) {
    const retry = aiCfg() && holdDay !== new Date().toDateString() &&
      Date.now() - lastRetry >= RETRY_EVERY && pendingPhotos(DATA) > 0;
    if (!retry) return null;
    lastRetry = Date.now();
    retryBuild = true;
    why = "photos still waiting, ";
  }
  console.log("[clothing] building today's board (" + why + reason + ")");
  return regenerate(true).catch(e => console.error("[clothing] " + e.message));
}

// noTimers: point the module at a data dir WITHOUT arming the schedule — for a
// suite that drives the doors itself. The timers are unref'd, but a suite that
// outlives the 20 s startup tick (a slow parallel gate on this two-CPU box)
// would otherwise get a surprise full build, AI requests and all (9/5).
function start(dataDir, opts = {}) {
  DATA = dataDir;
  if (opts.noTimers) return;
  setTimeout(() => tick("startup/wake"), 20 * 1000).unref();
  setInterval(() => tick("morning check"), 15 * 60 * 1000).unref();
}

// Re-sort TODAY'S board for a wardrobe that has not changed: the weather
// window moved (dad 9/5), so the board must follow within the second. Same
// build as the morning one minus photo ingest, so it costs no AI request and
// cannot be slowed down by a folder full of new photos.
function rebuildToday() { return regenerate(true, { rebuildOnly: true }); }

module.exports = { start, regenerate, rebuildToday, isBuilding, status, boardIsFresh, tick,
  _testReset: (o = {}) => { if (!o.keepHold) holdDay = ""; lastRetry = 0; retryBuild = false; } };
