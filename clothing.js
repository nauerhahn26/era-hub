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
const { listPhotos, photoSet, PHOTOSET_FILE } = require("./clothing-photos");
const { aiRoles, visionCheck } = require("./ai-config.js");
const drive = require("./drive.js");
const contentStore = require("./content-store.js");
const rank = require("./clothing-rank.js");

let DATA = null;
// The family's calendar zone and this hub's name, handed in by server.js at
// start(): the worker seeds the day's deal from the family's day key (spec
// §3.2) and signs what it shares with the device id. The zone is a getter so
// a profile edit reaches the next build without a restart. A caller that
// passes neither (an in-process suite) gets the server's own defaults — a
// suite that seeds "yesterday" by the clock must pass its zone (plan T2.1).
const DEFAULT_TZ = "America/Los_Angeles";
let tzOf = () => DEFAULT_TZ;
let deviceId = "hub";
let badZone = "";   // the last unusable zone we complained about
// The zone the next build is seeded with. profile.json can hold a zone this
// computer does not know — "Pacific Time" and "America/Los_Angelos" are not
// IANA names — and dayKey throws RangeError on those. The deal is seeded with
// dayKey(now, tz), so an unchecked zone threw inside the worker and the board
// was simply never rebuilt, every build, with one console line as the only
// signal. Probe it here and fall back to the default instead (review r1).
// EXPORTED because history.json has two doors: POST /outfit-event buckets its
// pick by a day key as well, and on the raw profile zone it threw RangeError
// inside the route, answered 400 and dropped every Yes — silently, every
// pick, so favourites could never be learned at all (review r2). One
// validated zone, both doors.
function zone() {
  const z = String(tzOf() || DEFAULT_TZ);
  try { rank.dayKey(Date.now(), z); return z; }
  catch {
    if (badZone !== z) {
      badZone = z;
      console.error("[clothing] profile time zone \"" + z + "\" is not one this computer knows — using " + DEFAULT_TZ);
    }
    return DEFAULT_TZ;
  }
}
let worker = null;
let ingesting = null;   // {done, total} live from the worker
let lastResult = null;
// The last build could not read wardrobe/history.json (see the {done} handler):
// the board on screen was dealt blind, so tick's freshness door does not count
// it as the day's work.
let memoryUnread = false;
let queued = false;     // a regenerate asked for while one was running
let queuedFull = false; // ...and at least one of those callers wanted a FULL build
let waiters = [];       // callers that arrived mid-build, awaiting the queued run

// The shell only ever needs to SAY which provider is configured (/clothing/status
// is public), so it drops the key on the floor here; the worker reads the same
// role for the calls it makes.
function aiCfg() {
  const v = aiRoles(DATA).vision;
  return v ? { provider: v.provider, ...visionCheck(DATA) } : null;
}

function isBuilding() { return !!worker; }

// ---- memory: wardrobe/history.json, ONE writer (spec §3.3, A4-1) ----------
// {days: {date: {band, page1}}, events: {date: [{kind, combo, at}]}}. The
// worker deals and posts the page-1 lineup; the shell records it here, and
// POST /outfit-event (server.js) appends the board's picks through the same
// two doors — every read-modify-write on the main thread, so none can
// interleave, and every write is a rename (writeAtomic), so a reader never
// sees half a file. Nothing else may write this file.
function historyPath() { return path.join(DATA, "wardrobe", "history.json"); }
function readHistory() {
  const file = historyPath();
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT") return {};   // no memory yet: the first build makes it
    // The file IS there and its bytes never arrived — a backup or a virus
    // scanner holding it, a mode change. That is NOT "no memory": answering
    // {} here and writing it back replaces 60 days of page-1 lineups and
    // every Yes with one entry. Both callers already survive a throw (the
    // build logs and keeps the board, /outfit-event answers 400), so one
    // lost pick beats sixty lost days (review r1).
    throw e;
  }
  try {
    const h = JSON.parse(raw);
    if (h && typeof h === "object" && !Array.isArray(h)) return h;
  } catch {}
  // Unreadable, and not empty: a parent's picks may be in there. Set it aside
  // for a hand to look at rather than overwrite it with {} (plan T2.2).
  if (raw.trim()) {
    // A name of its own: two set-asides in the same millisecond used to pick
    // the same one, and the second rename clobbered the first quarantined
    // copy — the very bytes this path exists to keep (review r2).
    let aside = file + ".bad-" + Date.now();
    for (let n = 2; fs.existsSync(aside); n++) aside = file + ".bad-" + Date.now() + "-" + n;
    try {
      fs.renameSync(file, aside);
      console.error("[clothing] history.json unreadable — moved to " + path.basename(aside));
    } catch (e) { console.error("[clothing] history.json unreadable and could not be set aside: " + e.message); }
  }
  return {};
}
// The day's page-1 lineup as the worker dealt it: {date, band, page1: [[ids]]}.
// Same-date reruns overwrite (idempotent) and the 60-day window is trimmed
// by clothing-rank.recordOffer.
function recordOffer(offer) {
  // A build that could draw nothing — every tile gone, the precondition the
  // tile repair exists for — deals an empty page 1. Recording it would REPLACE
  // the morning's seven-look lineup with none (recordOffer overwrites the day
  // wholesale), so that day would contribute nothing to tomorrow's yesterday
  // bar or per-garment freshness. An empty deal leaves the memory alone (r2).
  if (!offer || !Array.isArray(offer.page1) || !offer.page1.length) return;
  const h = readHistory();
  const combos = offer.page1.map(ids => ({ pieces: ids.map(id => ({ id })) }));
  rank.recordOffer(h, offer.date, combos, combos.length, offer.band);
  contentStore.writeAtomic(historyPath(), h);
}

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
    // whether the provider recognised the key when it was saved (null = unchecked)
    aiKeyOk: cfg ? cfg.keyOk : null, aiKeyError: cfg ? cfg.keyError : "",
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
    // The Drive folder is resolved HERE, at spawn, from the main thread's
    // drive.js (the way content.js does): a worker of its own would read the
    // config behind the main one's back (plan W10). API mode / no folder =
    // null, and the worker shares nothing.
    const st = drive.status();
    const driveFolder = st.mode === "local" && st.folderPath ? st.folderPath : null;
    worker = new Worker(path.join(__dirname, "clothing-worker.js"),
      // deviceId and driveFolder are the sharing seam: the worker does not read
      // them yet (they are consumed in T4.3), the zone it seeds the deal with
      // is live from this build on.
      { workerData: { dataDir: DATA, force: !!force, rebuildOnly: !!opts.rebuildOnly,
                      tz: zone(), deviceId, driveFolder } });
    worker.on("message", (m) => {
      if ("ingesting" in m) ingesting = m.ingesting;
      // The lineup arrives BEFORE the composites are drawn (I9): the memory
      // tomorrow's deal reads must not depend on every picture surviving.
      if (m.offer) {
        try { recordOffer(m.offer); } catch (e) { console.error("[clothing] history: " + e.message); }
      }
      if (m.done) {
        done = m.done;
        // A build that dealt without her memory (history.json there but its
        // bytes never came) is not the day's work: it has no staples, no
        // yesterday bar and no freshness, and the day it dealt was never
        // recorded either. The next tick deals again instead of leaving it up
        // until the next forced door (r3). Only a build that reached the deal
        // can answer this, so other results leave the flag alone.
        if (m.done.mode === "cataloged") memoryUnread = !!m.done.historyUnread;
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
// The memory starts as what the LAST build saw (the worker stores its photo
// set beside .clothing-sig, I23): a photo removed while the hub was down is
// then a change to the first tick after boot, not a wait for tomorrow's 5am.
let seenPhotos = null;
function storedPhotoSet(dataDir) {
  try { return fs.readFileSync(path.join(dataDir, PHOTOSET_FILE), "utf8"); } catch { return null; }
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
  const now = photoSet(path.join(DATA, "clothing"));
  const changed = seenPhotos !== null && now !== seenPhotos;
  seenPhotos = now;
  let why = changed ? "photos changed, " : memoryUnread ? "the last board was dealt without her memory, " : "";
  if (!changed && !memoryUnread && boardIsFresh(DATA)) {
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
// opts.tz: () => the family's IANA zone; opts.deviceId: this hub's name (both
// from server.js). Both are AUTHORITATIVE: a start() without them puts the
// module back on its own defaults, so a suite can hand a zone back (it used to
// assign only when the option was present, and the caller that thought it had
// reset the zone had not — review r2). A zone this computer cannot resolve is
// never honoured at either history.json door — zone() falls back to the
// default — so the two clocks below can only ever be a real zone apart.
// Known residual (I22): boardIsFresh's 5am cutoff and the
// allowance hold (holdDay) still read the OS clock, not the family zone — the
// deal itself is seeded in the family zone by the worker.
function start(dataDir, opts = {}) {
  DATA = dataDir;
  tzOf = typeof opts.tz === "function" ? opts.tz : () => DEFAULT_TZ;
  deviceId = opts.deviceId ? String(opts.deviceId) : "hub";
  seenPhotos = storedPhotoSet(dataDir);
  memoryUnread = false;   // a fresh start knows nothing about the last build's read
  if (opts.noTimers) return;
  setTimeout(() => tick("startup/wake"), 20 * 1000).unref();
  setInterval(() => tick("morning check"), 15 * 60 * 1000).unref();
}

// Re-sort TODAY'S board for a wardrobe that has not changed: the weather
// window moved (dad 9/5), so the board must follow within the second. Same
// build as the morning one minus photo ingest, so it costs no AI request and
// cannot be slowed down by a folder full of new photos.
function rebuildToday() { return regenerate(true, { rebuildOnly: true }); }

// recordOffer is not exported: the worker's {offer} message is its only caller
// (server.js uses historyPath/readHistory/zone for POST /outfit-event).
module.exports = { start, regenerate, rebuildToday, isBuilding, status, boardIsFresh, tick,
  historyPath, readHistory, zone,
  _testReset: (o = {}) => { if (!o.keepHold) holdDay = ""; lastRetry = 0; retryBuild = false; memoryUnread = false; } };
