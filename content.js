// content.js — the shell for content jobs, in the shape clothing.js proved
// (spec §3: "content.js copies its shape so a later merge is mechanical").
// It answers three questions and nothing else:
//
//   1. WHERE do we build?  Only inside the family's local Drive folder. The
//      hub's Drive scope is read-only (drive.js:9) — there is no upload path —
//      so in API mode a finished book could never reach the family's Drive or a
//      second device. scan() therefore refuses anything but local mode
//      ({skipped:"needs-local-drive"}) and Settings says so. The book is built
//      IN PLACE in books/<Title>/ and Google Drive for Windows does the
//      uploading for us.
//   2. WHICH folder is ready?  A folder is an inbox when it holds photos and no
//      .build/job.json — nothing else is asked of the parent. It is only
//      claimed once its listing (names + sizes) has not moved for ten minutes,
//      so a half-uploaded book never starts. That ten minutes is measured on
//      THIS module's own clock, not on a count of syncs: a parent hammering
//      "Sync now" in Settings must not talk us into claiming a book whose
//      photos are still arriving.
//   3. MAY WE take it?  Every device in the family sees the same folder, so a
//      job is claimed by writing claimedBy + heartbeat into job.json. A claim
//      whose heartbeat stopped more than thirty minutes ago is abandoned — a
//      laptop that was closed mid-book — and may be taken over, keeping the
//      job's state and its error history so it resumes where it fell over.
//
// The building itself is not here: like clothing.js, this shell only tracks
// state and runs ONE job at a time, so /content/status answers instantly while
// a book is being transcribed. The step table lives in content-worker.js and
// is plugged in at runJob() below.
//
// No key is read in this file, and nothing it writes to job.json or log.jsonl
// goes in unredacted — content-store.js owns both of those laws.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const drive = require("./drive.js");
const store = require("./content-store.js");
const { slugify } = require("./slug.js");
const { EXT: PHOTO_EXT } = require("./clothing-photos.js");
const { narrationPath } = require("./content-narrate.js");

// A folder must look identical across two observations at least this far apart
// before it is claimed (spec §2 "Quiet period"; the local mirror syncs every
// 10 min, drive.js:494, so this is one sync's worth of silence).
const QUIET_MS = 10 * 60 * 1000;
// A claim nobody has touched for this long is abandoned (spec §2 "Claim").
const STALE_MS = 30 * 60 * 1000;
// How often we look. Half the quiet period, so a book that stopped changing is
// claimed within about fifteen minutes of the last photo landing.
const SCAN_EVERY = 5 * 60 * 1000;

let DATA = null;
let running = null;     // {kind, slug, dir, step} of the job in flight
let inflight = null;    // its promise, for idle()
let queue = [];         // [{job, waiters[]}] — books asked for while one runs
let progress = null;    // {step, state} the running worker last reported
let lastScan = null;    // small JSON-safe summary for status()

// Who holds the claim, written into job.json and read by the other devices.
// The machine name is what makes it useful to a parent ("still claimed by the
// laptop"); it is never a key and never leaves the family's own folder.
function whoami() { return os.hostname() + ":" + process.pid; }

const iso = (now) => new Date(now).toISOString();

// ------------------------------------------------------------- the folder scan

// Top-level photos only: this is the pile the parent dropped in, not the
// pages/ and sources/ the builder makes afterwards (by then job.json exists and
// the folder is no longer an inbox). clothing-photos.js owns the "what counts
// as a photo" list so the two pipelines can never disagree; a HEIC counts here
// even though content-ingest.js cannot page it yet — the folder IS an inbox,
// and the ingest log is where that gets explained.
function listing(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const parts = [];
  for (const e of ents) {
    if (e.name.startsWith(".") || !e.isFile()) continue;
    if (!PHOTO_EXT.has(path.extname(e.name).toLowerCase())) continue;
    let size = -1;
    try { size = fs.statSync(path.join(dir, e.name)).size; } catch {}
    parts.push(e.name + ":" + size);
  }
  parts.sort();
  return { count: parts.length, sig: parts.join("\n") };
}

// What the last scan saw, per folder: {sig, since}. `since` is the moment the
// CURRENT listing first appeared, so it survives any number of extra scans —
// that is what makes the quiet period a wall clock rather than a sync count.
let seen = new Map();

function observe(dir, sig, now) {
  const prev = seen.get(dir);
  if (!prev || prev.sig !== sig) { seen.set(dir, { sig, since: now }); return 0; }
  return now - prev.since;
}

// A claim is stale when its heartbeat stopped long enough ago — or when it is
// unreadable, which is the same thing from here. A finished book is never
// taken over, however old it is.
function takeable(job, now) {
  if (!job || job.state === "done") return false;
  const beat = Date.parse(job.heartbeat);
  return !(beat >= 0) || now - beat > STALE_MS;
}

function dirsIn(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => e.name).sort();
  } catch { return null; }
}

// Write the claim. A fresh inbox gets a new job.json; a takeover keeps the
// job exactly as the other device left it (state, startedAt, errors) and only
// changes hands, so the build resumes at the step that fell over.
function claim(dir, job, now) {
  const me = whoami();
  const next = job
    ? { ...store.transition(job, job.state, { now: iso(now) }), claimedBy: me }
    : store.newJob({ claimedBy: me, now: iso(now) });
  store.writeJob(dir, next);
  store.appendLog(dir, "claim", job ? "taken over by " + me : "claimed by " + me, { now: iso(now) });
  return next;
}

// Walks <folderPath>/books/*. Returns a small JSON-safe picture of every book
// folder plus the slugs claimed this time round; the jobs themselves run
// behind it (one at a time — see run()).
function scan(opts) {
  const o = opts || {};
  const now = o.now == null ? Date.now() : o.now;
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };

  const root = path.join(st.folderPath, "books");
  const names = dirsIn(root);
  const books = [], claimed = [];
  for (const name of names || []) {
    const dir = path.join(root, name);
    const list = listing(dir);
    if (!list) continue;                      // vanished between readdir and stat
    const job = store.readJob(dir);
    const inbox = !job && list.count > 0;
    // Only an inbox is on the quiet clock; anything else forgets its listing so
    // a shelf of a hundred published books costs us nothing to remember.
    if (!inbox) seen.delete(dir);
    const quiet = inbox && observe(dir, list.sig, now) >= QUIET_MS;
    const stale = takeable(job, now);
    const b = { name, slug: slugify(name), images: list.count, inbox,
                quiet, takeable: stale, state: job ? job.state : null };
    books.push(b);
    if (!quiet && !stale) continue;
    try {
      claim(dir, job, now);
      claimed.push(b.slug);
      // dataDir travels with the job: the worker builds in `dir` (the family's
      // Drive folder) but reads its key roles out of <DATA> (ai-config.js).
      run({ kind: "books", slug: b.slug, name, dir, dataDir: DATA });
    } catch (e) {
      console.error("[content] could not claim " + name + ": " + e.message);
    }
  }
  lastScan = { at: iso(now), books: books.length,
               inboxes: books.filter(b => b.inbox).length, claimed: claimed.slice() };
  return { books, claimed };
}

// ------------------------------------------------------------- one at a time

// The step table lives in content-worker.js and runs in a WORKER THREAD, for
// the reason clothing.js:56 spawns one: the build reads and re-encodes whole
// photo albums, and on the main thread that froze every hub page for minutes
// (dad 8/31). The shell only relays progress and the final result, so
// /content/status answers instantly while a book is being built.
// Assigned onto module.exports so the tests can replace it in one place.
function runJob(job) {
  return new Promise((resolve) => {
    let result = null;
    const w = new Worker(path.join(__dirname, "content-worker.js"), {
      workerData: { dataDir: job.dataDir || DATA, dir: job.dir, kind: job.kind,
                    slug: job.slug, name: job.name || null, step: job.step || null },
    });
    w.on("message", (m) => {
      if (m && m.step) progress = { step: m.step, state: m.state || null };
      if (m && m.done) result = m.done;
    });
    // The worker already turned a step's own failure into a {done:{error}}; an
    // error HERE is the thread itself dying, which the exit handler answers for.
    w.on("error", (e) => console.error("[content] " + job.slug + " worker: " + e.message));
    w.on("exit", (code) => {
      progress = null;
      resolve(result || { slug: job.slug,
        error: "the builder stopped before it finished (exit " + code + ")" });
    });
  });
}

const keyOf = (job) => job.dir + "|" + (job.step || "");

// One job at a time, and a caller that arrives mid-build gets the result of the
// run it asked for rather than a bare {busy} it would have to poll for — the
// same deal clothing.js:47-53 makes. Asking for the book that is ALREADY
// running joins that run instead of queueing a second one.
function run(job) {
  if (running) {
    if (keyOf(running) === keyOf(job)) return inflight;
    const waiting = queue.find(q => keyOf(q.job) === keyOf(job));
    if (waiting) return new Promise((resolve) => { waiting.waiters.push(resolve); });
    return new Promise((resolve) => { queue.push({ job, waiters: [resolve] }); });
  }
  return begin(job);
}

function begin(job) {
  running = job;
  // Started here and now, not on the next tick: clothing.js spawns its worker
  // the moment regenerate() is called, and a caller that gets the promise back
  // expects the work to already be under way.
  let step;
  try { step = Promise.resolve(module.exports.runJob(job)); }
  catch (e) { step = Promise.reject(e); }
  const p = step
    // A book that fell over must not wedge the queue behind it: the error is
    // this run's result, and the next book starts anyway.
    .catch((e) => {
      console.error("[content] " + job.slug + ": " + e.message);
      return { slug: job.slug, error: store.redact(e.message) };
    })
    .then((result) => {
      running = null; inflight = null;
      const next = queue.shift();
      if (next) begin(next.job).then(r => next.waiters.forEach(w => w(r)));
      return result;
    });
  inflight = p;
  return p;
}

function isBuilding() { return !!running; }

// Resolves when nothing is running and nothing is queued. Used by the tests and
// by anything that wants to let a book finish before it looks at the folder.
function idle() { return inflight ? inflight.then(idle) : Promise.resolve(); }

// The heartbeat a step refreshes as it works, so the other devices can see the
// claim is alive. Same-state transitions are exactly that (content-store.js).
function beat(dir, now) {
  const job = store.readJob(dir);
  if (!job) return null;
  const next = store.transition(job, job.state, { now: iso(now == null ? Date.now() : now) });
  return store.writeJob(dir, next);
}

// --------------------------------------------------------------- the job list

// The kinds /content/run will act on. Music and movies are catalogue writes,
// not folder builds, and get their own routes in Phases 4 and 5 — an unknown
// kind is refused here rather than quietly treated as a book.
const KINDS = ["books"];

// books/<Title> for a slug, or null. The slug is derived, never stored, so this
// is the only translation between what a URL says and what is on disk — the
// same rule booksIndex() follows on the serving side (server.js). A slug that
// matches no folder is refused; nothing is created from a URL.
function bookFor(slug, st) {
  const root = path.join(st.folderPath, "books");
  for (const name of dirsIn(root) || [])
    if (slugify(name) === slug) return { name, dir: path.join(root, name) };
  return null;
}

// What one book folder looks like from outside, and NOTHING else: no absolute
// path (a status page is not a map of the family's disk), no claimedBy device
// name, no key — content.js never reads one and this payload is public.
// The book's title is the one identifying thing in here, and it is the one
// thing a parent needs to recognise their own book.
function jobFor(name, dir) {
  const job = store.readJob(dir);
  const text = store.readText(dir);
  const narr = store.readJson(narrationPath(dir));
  const narrated = new Set(((narr && narr.pages) || []).map(p => p.index));
  const pages = (text && text.pages) || [];
  // No text.json yet means the pile of photos IS the page count.
  const count = pages.length || (listing(dir) || { count: 0 }).count;
  let characters = 0, spent = 0, transcribed = 0, flags = 0;
  for (const p of pages) {
    const n = p.text.length;
    characters += n;
    if (n) transcribed++;
    if (narrated.has(p.index)) spent += n;
    flags += p.flags.length;
  }
  const owed = job ? store.owedState(job) : "inbox";
  const last = job && (job.errors || [])[job.errors.length - 1];
  return {
    kind: "books",
    slug: slugify(name),
    title: name,
    // A folder nobody has claimed is still a job — it is an inbox waiting for
    // its quiet ten minutes, and the Settings card must be able to say so.
    state: job ? job.state : "inbox",
    step: store.stepOwed(owed),
    progress: { pages: count, transcribed, narrated: narrated.size },
    // The only unit a book's spend can be counted in until the fal card lands
    // (Phase 6): ElevenLabs characters owed, and the ones already paid for.
    cost: { characters, narrated: spent },
    flags,
    pausedUntil: (job && job.pausedUntil) || null,
    note: (job && job.pausedNote) || null,
    published: fs.existsSync(path.join(dir, "manifest.json")),
    // Only while it IS failed. job.errors is a history kept on purpose (a book
    // that fell over twice for two reasons is the one a parent needs the whole
    // story of), but a card that keeps showing yesterday's error under a book
    // that has since published is a card nobody believes.
    error: job && job.state === "failed" && last ? last.msg : null,
  };
}

// Every book folder, cheapest-first: three small reads per book and no walk of
// pages/. The running job's live step wins over the one job.json owes, so the
// card follows the work rather than lagging a whole step behind it.
function jobs() {
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return [];
  const out = [];
  for (const name of dirsIn(path.join(st.folderPath, "books")) || []) {
    const dir = path.join(st.folderPath, "books", name);
    let j;
    // A folder that vanished mid-read, or a hand-edited text.json the schema
    // refuses: one bad book must never blank the whole card.
    try { j = jobFor(name, dir); } catch { continue; }
    if (running && running.dir === dir && progress && progress.step) j.step = progress.step;
    out.push(j);
  }
  return out;
}

// POST /content/run's whole decision, kept here so the route stays four lines
// and so the same validation is available to anything else that kicks a build.
// Returns {started:true}, {skipped:"needs-local-drive"} (409) or {error} (400).
// An omitted step means "carry on from wherever this book is".
function runStep(o) {
  const req = o || {};
  const step = req.step == null || req.step === "" ? null : req.step;
  if (!KINDS.includes(req.kind)) return { error: "unknown kind" };
  if (typeof req.slug !== "string" || !req.slug) return { error: "unknown book" };
  if (step !== null && !store.STEP_NAMES.includes(step)) return { error: "unknown step" };
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };
  const found = bookFor(req.slug, st);
  if (!found) return { error: "unknown book" };
  // A parent pressing "start this book" must not have to wait for the quiet
  // period they have just decided is over: an unclaimed folder is claimed here
  // and then built, exactly as scan() would have done in its own time.
  const job = store.readJob(found.dir);
  if (!job) claim(found.dir, null, Date.now());
  run({ kind: req.kind, slug: req.slug, name: found.name, dir: found.dir,
        dataDir: DATA, step }).catch(() => {});
  return { started: true };
}

// ------------------------------------------------------------------- status

// Deliberately thin, and deliberately free of the claim's device name and of
// anything key-shaped: /content/status is public.
function status() {
  const st = drive.status();
  const local = st.mode === "local" && !!st.folderPath;
  return {
    mode: st.mode,
    local,
    // Why there is nothing to show, in the one word Settings turns into a
    // sentence: the hub's Drive scope is read-only, so a book built in API mode
    // could never reach the family's Drive (Gap 1).
    skipped: local ? null : "needs-local-drive",
    building: !!running,
    job: running ? { kind: running.kind, slug: running.slug,
                     step: (progress && progress.step) || running.step || null } : null,
    queued: queue.map(q => q.job.slug),
    jobs: jobs(),
    lastScan,
  };
}

function tick(reason) {
  const res = scan();
  if (res.skipped || !res.claimed.length) return res;
  console.log("[content] claimed " + res.claimed.join(", ") + " (" + reason + ")");
  return res;
}

function start(dataDir) {
  DATA = dataDir;
  // Late enough that the first local sync (drive.js:493) has had its go, so a
  // fresh install does not spend its first scan on a half-copied folder.
  setTimeout(() => tick("startup"), 90 * 1000).unref();
  setInterval(() => tick("scan"), SCAN_EVERY).unref();
}

module.exports = {
  start, scan, tick, run, runJob, runStep, isBuilding, idle, status, beat, claim,
  jobs, jobFor, bookFor, KINDS, QUIET_MS, STALE_MS,
  _testReset: () => {
    running = null; inflight = null; queue = []; seen = new Map();
    progress = null; lastScan = null;
    module.exports.runJob = runJob;
  },
};
