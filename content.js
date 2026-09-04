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
const booksIndex = require("./books-index.js");
const { EXT: PHOTO_EXT } = require("./clothing-photos.js");
const { narrationPath, forgetPage } = require("./content-narrate.js");
const { pagesOf, pauseHolds } = require("./content-providers.js");
// Booleans only — which roles the family has set up. No key is read in this
// file and none ever will be (see the header).
const { haveRoles } = require("./ai-config.js");

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
// unreadable, which is the same thing from here.
//
// A book with no work left is NEVER taken over, however old it is. That is the
// difference between a shelf that settles down and one that churns: every
// re-claim rewrites job.json and appends to log.jsonl INSIDE the family's Drive
// folder, which Drive then re-uploads and re-mirrors to every device. Three
// kinds owe nothing —
//   done       the walk finished (content-worker.js settles `published` to it)
//   published  a hub that stopped between the manifest and the settle
//   permanent  a key the provider refused; asking again only buys the same
//              answer (store.owedState returns null for it)
// — and a scan half an hour later must find nothing to do with any of them.
function takeable(job, now) {
  if (!job || job.state === "done" || job.state === "published") return false;
  if (store.owedState(job) === null) return false;
  // A book waiting for a spent allowance keeps its claim but stops beating, so
  // half an hour later it looks exactly like an abandoned one. Taking it over
  // buys nothing — the worker reads the same pause and holds again — and it
  // costs a job.json rewrite and a log line inside the family's Drive folder
  // every thirty minutes until the quota comes back. The pause is a MOMENT
  // (content-providers.js F6), so this wakes the book the first scan after it
  // passes rather than at some local midnight.
  //
  // A PAUSE IS ITS OWN ANSWER, and the heartbeat has nothing to add to it. The
  // book that held wrote a FRESH heartbeat as it held (content-worker.js
  // holdHere) precisely so no other device would treat it as abandoned — so if
  // the stale window still had to pass on top, a 429 answered with "come back
  // in 47 seconds" cost half an hour of waiting instead of a minute, which is
  // most of what the pause was written to recover. A job carrying a pausedUntil
  // is parked by definition (a finished step deletes it, holdHere writes it),
  // so the moment it names is the whole rule for it.
  if (job.pausedUntil != null && job.pausedUntil !== "")
    return !pauseHolds(job.pausedUntil, now);
  const beat = Date.parse(job.heartbeat);
  return !(beat >= 0) || now - beat > STALE_MS;
}

// Every book folder under `<folderPath>/books`, each with the slug it owns.
// books-index.js is the ONE place a slug is assigned — the shelf server.js
// serves calls the same function over its own root — so the URL in a Settings
// link, in the board's review link and in POST /content/run always names the
// book the reader actually serves.
function shelfOf(st) {
  const root = path.join(st.folderPath, "books");
  return { root, list: booksIndex.bookDirs(root).list };
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

  const { root, list: shelf } = shelfOf(st);
  const books = [], claimed = [];
  for (const { slug, dir: name } of shelf) {
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
    const b = { name, slug, images: list.count, inbox,
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
                    slug: job.slug, name: job.name || null, step: job.step || null,
                    // One page, for the review page's "Re-narrate this page".
                    // Null (the normal case) means the whole book.
                    page: Number.isInteger(job.page) ? job.page : null,
                    // The pages the review page's "Read the photos again" wants
                    // read AGAIN (spec §5). Null means "whatever the step owes",
                    // which for the transcriber is every page with no words yet.
                    pages: Array.isArray(job.pages) ? job.pages.slice() : null },
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

// Two runs are the same run when they are the same step of the same book — and
// the pages count: re-narrating page four is not the run that re-narrates page
// seven, and reading two pages again is not the run that reads one of them, so
// joining either to the other would leave a parent's second press silently
// unanswered.
const keyOf = (job) => job.dir + "|" + (job.step || "") + "|" +
                       (Number.isInteger(job.page) ? job.page : "") + "|" +
                       (Array.isArray(job.pages) ? job.pages.join(",") : "");

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
      // Before the next book in the queue starts (a transcription is minutes
      // long, and this book is finished now).
      announce(job, result);
      const next = queue.shift();
      if (next) begin(next.job).then(r => next.waiters.forEach(w => w(r)));
      return result;
    });
  inflight = p;
  return p;
}

// A BOOK THAT PUBLISHED IS NOT YET ON THE SHELF (F5, 9/4). The walk writes
// manifest.json inside the family's Drive folder; the Reader serves
// <DATA>/books, and the only thing that carried a package across was the
// ten-minute mirror or a hand on "Sync now" — a parent watched the card say
// "finished", opened the Reader, and the book was not there.
//
// So a run that published says so, once, through the same one-property shape
// drive.onSynced uses: server.js hangs the copy off it (drive.mirrorBook — that
// book and no more; a whole sync would fire onSynced's clothing leg and spend
// vision quota on every publish), and nothing in this file has to know that the
// mirror exists. Unset — every test that drives content.js directly — it is a
// no-op, and a hook that throws is the hook's problem, never the book's.
function announce(job, result) {
  const steps = result && Array.isArray(result.steps) ? result.steps : [];
  if (!steps.some(s => s && s.published)) return;
  const hook = module.exports.onPublished;
  if (typeof hook !== "function") return;
  try {
    hook({ kind: job.kind, slug: job.slug, dir: job.dir,
           name: job.name || path.basename(job.dir) });
  } catch (e) {
    console.error("[content] " + job.slug + ": " + store.redact(e.message));
  }
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

// books/<Title> for a slug, or null. books-index.js owns the translation
// between what a URL says and what is on disk — the same function server.js's
// serveBook resolves through — so a slug can never name one folder here and
// another one on the shelf. A slug that matches no folder is refused; nothing
// is created from a URL.
function bookFor(slug, st) {
  const root = path.join(st.folderPath, "books");
  const name = booksIndex.dirFor(root, slug);
  return name ? { name, dir: path.join(root, name) } : null;
}

// What one book folder looks like from outside, and NOTHING else: no absolute
// path (a status page is not a map of the family's disk), no claimedBy device
// name, no key — content.js never reads one and this payload is public.
// The book's title is the one identifying thing in here, and it is the one
// thing a parent needs to recognise their own book.
function jobFor(name, dir, slug) {
  const job = store.readJob(dir);
  const text = store.readText(dir);
  const narr = store.readJson(narrationPath(dir));
  const narrated = new Set(((narr && narr.pages) || []).map(p => p.index));
  const pages = (text && text.pages) || [];
  // How many pages the BOOK has, which is not how many have been read yet: the
  // card renders "N of M pages read" and the board "page N of M", so counting
  // only text.json's entries makes M chase N and a twelve-page book part-way
  // through says "4 of 4" — finished, when it is a third done. The built pages
  // are the honest total (ingest's own record, or pages/ for a folder built by
  // hand); before ingest has run, the pile of photos is.
  let built = [];
  try { built = pagesOf(dir); } catch {}
  const count = Math.max(built.length, pages.length, (listing(dir) || { count: 0 }).count);
  // TWO COUNTS, because there are two kinds of mark and they are not the same
  // sentence to a parent. `flags` is WORDS somebody was unsure of, the ones the
  // review page highlights inside the page's own text; `pageFlags` is whole
  // PAGES to come and look at (a page nobody could check, a disagreement with
  // no word to point at) and those name no word at all. Counting the second as
  // the first told a parent "30 words the AI was unsure of" and then showed
  // them a book with nothing highlighted anywhere in it (E2, 9/4).
  let characters = 0, spent = 0, transcribed = 0, flags = 0, pageFlags = 0;
  for (const p of pages) {
    const n = p.text.length;
    characters += n;
    if (n) transcribed++;
    if (narrated.has(p.index)) spent += n;
    for (const f of p.flags) { if (f && f.word) flags++; else pageFlags++; }
  }
  const owed = job ? store.owedState(job) : "inbox";
  const last = job && (job.errors || [])[job.errors.length - 1];
  // Worth showing while the book is stopped for good, and while the step it is
  // ON gave up part-way (job.held === "retry", written by content-worker.js for
  // a page the provider would not read). A finished step clears the hold, so a
  // book that has since moved on stops showing it — a card that keeps printing
  // yesterday's error under a book that has since published is a card nobody
  // believes. A quota pause is not this: it has its own sentence and nothing to
  // press.
  const stuck = !!last && (job.state === "failed" || job.held === "retry");
  return {
    kind: "books",
    slug: slug || booksIndex.slugFor(path.dirname(dir), name) || "book",
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
    pageFlags,
    pausedUntil: (job && job.pausedUntil) || null,
    note: (job && job.pausedNote) || null,
    published: fs.existsSync(path.join(dir, "manifest.json")),
    // job.errors is a history kept on purpose (a book that fell over twice for
    // two reasons is the one a parent needs the whole story of); `error` is only
    // the current one. Settings turns it into a sentence — the raw provider
    // text stays in log.jsonl, where it is for us and not for the family.
    error: stuck ? last.msg : null,
  };
}

// Every book folder, cheapest-first: three small reads per book and no walk of
// pages/. The running job's live step wins over the one job.json owes, so the
// card follows the work rather than lagging a whole step behind it.
function jobs() {
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return [];
  const { root, list: shelf } = shelfOf(st);
  const out = [];
  for (const { slug, dir: name } of shelf) {
    const dir = path.join(root, name);
    let j;
    // A folder that vanished mid-read, or a hand-edited text.json the schema
    // refuses: one bad book must never blank the whole card.
    try { j = jobFor(name, dir, slug); } catch { continue; }
    if (running && running.dir === dir && progress && progress.step) j.step = progress.step;
    out.push(j);
  }
  return out;
}

// The sentence a parent meets when they press "Re-narrate this page" on a hub
// that has never been given a voice. Words, not a status code and not a step
// name: the Voice card is where the fix is, so the message points at it.
const NO_VOICE = "New ERA has no voice yet — add an ElevenLabs key to the Voice card in Settings, then ask for this page again.";
// The same deal for "Read the photos again": reading a page costs a vision
// call, and a hub with no AI helper key would simply hold and change nothing.
const NO_VISION = "New ERA cannot read pages yet — add a key to the AI helper card in Settings, then ask for this book again.";
// And the one case where the button is right to do nothing: every page of the
// book is a page a grown-up typed, and they asked us to keep those.
const ALL_EDITED = "Every page of this book has words you typed yourself, and you asked to keep them — so there is nothing to read again.";

// WHICH PAGES "Read the photos again" ASKS FOR (spec §5 "Rebuild text", T3.4).
// The transcriber never re-reads a page that already has words — that rule is
// what makes a book resumable over several days on a free key — so a re-read
// has to name the pages it wants read a second time.
//
// `keepEdits` (the tick, on by default) leaves out every page a grown-up typed
// themselves: their words are the whole point of this page, and a button that
// threw them away next to the button that saved them would be a trap. Unticked,
// the photos win everywhere and the parent's words go with the rest.
//
// The list is the union of the pages that were BUILT and the pages text.json
// knows about, so a photo that was never read (a book that ran out of free
// quota half way) is picked up by the same press.
function rebuildPages(dir, keepEdits) {
  let text = null;
  try { text = store.readText(dir); } catch { return null; }
  const pages = (text && text.pages) || [];
  // Nothing has been read yet: the ordinary step does exactly the right thing,
  // so it is asked for nothing in particular.
  if (!pages.length) return null;
  let built = [];
  try { built = pagesOf(dir); } catch {}
  const keep = new Set(keepEdits ? pages.filter(p => p.edited).map(p => p.index) : []);
  const all = new Set([...built.map(p => p.index), ...pages.map(p => p.index)]);
  return [...all].filter(i => !keep.has(i)).sort((a, b) => a - b);
}

// POST /content/run's whole decision, kept here so the route stays four lines
// and so the same validation is available to anything else that kicks a build.
// Returns {started:true}, {skipped:"needs-local-drive"} (409) or {error} (400).
// An omitted step means "carry on from wherever this book is"; `page` names one
// page for a step that can do one (narrate — the review page's button, spec §5).
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

  // ONE PAGE. Checked here rather than inside the worker for one reason: every
  // refusal has to happen before a thread is spawned and a provider is called,
  // because by then the family has already been billed for whatever it did.
  const page = req.page == null ? null : req.page;
  if (page !== null) {
    // Narration is the only step that can be done to one page: ingest,
    // transcribe and publish all read the whole folder. A page handed to one of
    // those would be silently ignored, and a parent would be left watching a
    // button that did nothing.
    if (step !== store.STEP_OWED.reviewing)
      return { error: "that step works on the whole book, not one page" };
    let text;
    try { text = store.readText(found.dir); }
    catch { return { error: "this book's text.json needs fixing by hand" }; }
    const pages = (text && text.pages) || [];
    if (!Number.isInteger(page) || !pages.some(p => p.index === page))
      return { error: "that is not a page of this book" };
  }
  // Nothing to record with. A step the WALK reaches with no key is a deliberate
  // empty outcome (the book publishes with text and no audio, spec §4), but a
  // parent who has just pressed a button is owed an answer instead of a book
  // that quietly does not change.
  if (step === store.STEP_OWED.reviewing && !(DATA && haveRoles(DATA).elevenlabs))
    return { error: NO_VOICE };

  // "READ THE PHOTOS AGAIN" (spec §5). Only the reading step can be asked to go
  // over pages it has already read — every other step either has nothing to
  // re-do or does the whole book anyway — and every refusal happens here, before
  // a thread is spawned, for the reason above: after that the family is billed.
  let pages = null;
  if (req.rebuild) {
    if (step !== store.STEP_OWED.transcribing)
      return { error: "only the reading step can be run again over pages it has already read" };
    if (page !== null) return { error: "reading the photos again is done to the whole book" };
    if (!(DATA && haveRoles(DATA).vision)) return { error: NO_VISION };
    pages = rebuildPages(found.dir, req.keepEdits !== false);
    if (pages && !pages.length) return { error: ALL_EDITED };
  }
  // A parent pressing "start this book" must not have to wait for the quiet
  // period they have just decided is over: an unclaimed folder is claimed here
  // and then built, exactly as scan() would have done in its own time.
  const job = store.readJob(found.dir);
  if (!job) claim(found.dir, null, Date.now());
  // A parent pressing "try this book again" is a deliberate decision, and it is
  // the ONLY thing that lifts a permanent failure. A scan never retries one —
  // asking a key the provider refused only buys the same refusal — but by the
  // time a parent presses this they have usually just fixed the key the card
  // told them about, so the job goes back on the step it fell over on.
  //
  // `retry` IS THE PRESS, and nothing else is. Every accepted write on the
  // review page re-publishes the book through this same door, so without the
  // flag a parent fixing one typo would put a refused book back on the
  // half-hourly walk against the key the provider had already turned down —
  // for ever, and started by somebody who never asked for it.
  else if (req.retry === true && job.state === "failed" && store.owedState(job) === null)
    store.writeJob(found.dir, store.transition(job, job.failedFrom || "inbox"));
  run({ kind: req.kind, slug: req.slug, name: found.name, dir: found.dir,
        dataDir: DATA, step, page, pages }).catch(() => {});
  return { started: true };
}

// ---------------------------------------- "not while it is being built" (§5)

// A worker owns a book's folder outright while it has it: content-providers.js
// reads the whole of text.json into memory at the top of a transcription and
// writes the whole array back from that snapshot minutes later. So a write that
// lands in between is not a write at all — it is thrown away silently, and the
// parent who made it was told "Saved ✓".
//
// Every door that writes into a book folder asks this first, and they all say
// the same two sentences, because to a parent "it is building" and "it is about
// to build" are the same answer: come back in a minute.
// Returns {error} for a folder that is spoken for, or null.
function busyWith(dir) {
  const at = path.resolve(dir);
  if (running && path.resolve(running.dir) === at)
    return { error: "New ERA is working on this book right now — try again in a minute." };
  if (queue.some(q => path.resolve(q.job.dir) === at))
    return { error: "New ERA is about to work on this book — try again in a minute." };
  return null;
}

// ------------------------------------------------------- "Remove this book"

// THE ONE DOOR IN THE SUITE THAT DELETES A FAMILY'S OWN FILES (spec §5). It
// removes the book's folder inside the family's Drive folder; the Phase 1 mirror
// then takes the copy in <DATA> away on its next pass, so there is exactly one
// delete and it happens where the parent can see it in their own Drive.
//
// Three rules, and the button does not ship without all three:
//   1. A SLUG IS NEVER A PATH. bookFor() answers only with a directory NAME
//      books-index.js read off the disk, so "../.." names no book at all. The
//      resolved path is re-checked below anyway: the whole licence to delete
//      rests on that one property, and a jail worth having is one that does not
//      depend on a function three modules away staying the way it is today.
//   2. NOT WHILE IT IS BEING BUILT. A worker with the folder open would write
//      job.json back underneath us and leave half a book behind.
//   3. NOTHING IS LOGGED INTO THE FOLDER. It is about to go; the record goes to
//      the hub's own console (and never names anything but the book's title).
//
// Returns {removed, slug, title}, {skipped:"needs-local-drive"} (409) or
// {error} (400).
function removeBook(o) {
  const req = o || {};
  if (!KINDS.includes(req.kind)) return { error: "unknown kind" };
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };
  if (typeof req.slug !== "string" || !req.slug) return { error: "unknown book" };
  const found = bookFor(req.slug, st);
  if (!found) return { error: "unknown book" };
  const root = path.resolve(st.folderPath, "books");
  const dir = path.resolve(root, found.name);
  // A DIRECT CHILD of books/, and nothing else: not books/ itself, not a
  // grandchild, not a sideways step out of it.
  if (path.dirname(dir) !== root || dir === root) return { error: "unknown book" };
  const busy = busyWith(dir);
  if (busy) return busy;
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) {
    // The reason belongs in the hub's own console, not in the answer: rmSync's
    // message carries the whole path it fell over on, and store.redact only
    // takes out things that look like keys. A status page is not a map of the
    // family's disk (jobFor's law, six lines above it), and this door is the
    // one place that had been handing one out.
    console.error("[content] could not remove " + found.name + ": " + store.redact(e.message));
    return { error: "That book could not be removed — close anything that has its "
                  + "folder open on this computer and try again." };
  }
  seen.delete(found.dir);                       // no quiet clock for a folder that is gone
  console.log("[content] removed the book folder " + found.name + " (a grown-up asked)");
  return { removed: true, slug: req.slug, title: found.name };
}

// ------------------------------------------------------- the review page (§5)

// THE ORDER OF A BOOK. text.json's ARRAY order is the reading order; a page's
// `index` is its identity — the photo it was made from, and the audio, the
// flags and the characters already bought for it. A parent dragging page four
// to the front permutes the array and touches nothing else, so nothing that
// was paid for is lost and no file is renamed inside the family's Drive folder
// (which would hand Drive every page to re-upload). content-publish.js reads
// the same array order, so the shelf follows the drag.

// Every page of one book, for the strip the review page draws. Same law as
// jobFor(): no absolute path, no claim, nothing key-shaped — the photo comes
// back as a URL onto the route below, never as a path on the family's disk.
function pagesFor(slug) {
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };
  if (typeof slug !== "string" || !slug) return { error: "unknown book" };
  const found = bookFor(slug, st);
  if (!found) return { error: "unknown book" };
  // A hand-edited text.json the schema refuses must say so plainly, not 500:
  // the parent who broke it in power mode is the one reading this page.
  let text;
  try { text = store.readText(found.dir) || { pages: [] }; }
  catch { return { error: "this book's text.json needs fixing by hand" }; }
  let built = new Map();
  try { built = new Map(pagesOf(found.dir).map(p => [p.index, p])); } catch {}
  const job = store.readJob(found.dir);
  return {
    slug, title: found.name,
    state: job ? job.state : "inbox",
    published: fs.existsSync(path.join(found.dir, "manifest.json")),
    pages: text.pages.map(p => ({
      index: p.index, text: p.text, flags: p.flags, cover: p.cover,
      // Null for a page text.json knows about but no photo was built for — the
      // card draws its own empty frame rather than an <img> onto a 404.
      image: built.has(p.index)
        ? "/content/page?slug=" + encodeURIComponent(slug) + "&index=" + p.index : null,
    })),
  };
}

// The file behind one page's photo. The path NEVER comes from the URL: the
// index is looked up in ingest's own record (content-providers.pagesOf) and the
// answer is re-checked to be inside this book's pages/ before it is served.
// Straight from the build folder rather than through /books/<slug>/, because
// the Drive mirror runs every ten minutes and a book being reviewed is nearly
// always newer than the mirror's copy.
function pageFile(slug, index) {
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };
  if (typeof slug !== "string" || !slug) return { error: "unknown book" };
  if (!Number.isInteger(index)) return { error: "unknown page" };
  const found = bookFor(slug, st);
  if (!found) return { error: "unknown book" };
  let page = null;
  try { page = pagesOf(found.dir).find(p => p.index === index) || null; } catch {}
  if (!page) return { error: "unknown page" };
  const file = path.resolve(found.dir, page.image);
  const jail = path.resolve(found.dir, "pages") + path.sep;
  if (!file.startsWith(jail)) return { error: "unknown page" };
  try { if (!fs.statSync(file).size) return { error: "unknown page" }; }
  catch { return { error: "unknown page" }; }
  return { file };
}

// POST /content/text's whole decision: the new reading order and which page
// wears the cover. Refused outright unless `order` names every page of THIS
// book exactly once — a half-applied order would lose a page out of the book,
// and the parent's only sign of it would be a shorter shelf entry.
// Returns {saved}, {skipped:"needs-local-drive"} (409) or {error} (400).
function saveOrder(o) {
  const req = o || {};
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };
  if (typeof req.slug !== "string" || !req.slug) return { error: "unknown book" };
  const found = bookFor(req.slug, st);
  if (!found) return { error: "unknown book" };
  // The same rule the remove door has, and for the same reason: a drag made
  // while "Read the photos again" is running is a drag the transcriber writes
  // back over without either of them noticing.
  const busy = busyWith(found.dir);
  if (busy) return busy;
  let text;
  try { text = store.readText(found.dir); }
  catch { return { error: "this book's text.json needs fixing by hand" }; }
  const pages = (text && text.pages) || [];
  if (!pages.length) return { error: "no pages yet" };

  const by = new Map(pages.map(p => [p.index, p]));
  const order = req.order == null ? pages.map(p => p.index) : req.order;
  if (!Array.isArray(order)) return { error: "the new order must be a list of pages" };
  if (order.length !== pages.length || new Set(order).size !== order.length
      || !order.every(i => Number.isInteger(i) && by.has(i)))
    return { error: "the new order must name every page of this book, once" };

  // An omitted cover keeps whichever page has it (the first page if none does);
  // an explicit null means the same thing. content-publish.writeCover() reads
  // exactly one `cover:true`, so exactly one is what is written.
  const keep = pages.find(p => p.cover);
  let cover = req.cover === undefined || req.cover === null
    ? (keep ? keep.index : order[0]) : req.cover;
  if (!Number.isInteger(cover) || !by.has(cover)) return { error: "unknown cover page" };

  const next = order.map(i => ({ ...by.get(i), cover: i === cover }));
  store.writeText(found.dir, { pages: next });
  store.appendLog(found.dir, "review",
    "a grown-up set the page order and the cover (" + next.length + " page(s), cover " + cover + ")");
  return { saved: true, pages: next.length, cover,
           published: fs.existsSync(path.join(found.dir, "manifest.json")) };
}

// A page of a picture book is a sentence or two. This is a sanity bound on what
// arrives over HTTP, not a rule about writing — the route's own body cap is the
// other half of it.
const MAX_PAGE_TEXT = 4000;

// POST /content/text's other half (T3.3, spec §5): ONE page's own words, and
// the flags on it. The order and the cover are saveOrder's; this touches
// neither, so a parent fixing a word cannot lose their page order to a race
// with their own drag.
//
// FLAGS ARE ANSWERED HERE, NEVER AUTHORED. A flag says "the model was not sure
// of this word", and only the transcriber may say that — a door that could
// invent one could put a mark under any word in the family's own book. So the
// only list this takes is the empty one.
//
// Returns {saved}, {skipped:"needs-local-drive"} (409) or {error} (400).
function savePage(o) {
  const req = o || {};
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };
  if (typeof req.slug !== "string" || !req.slug) return { error: "unknown book" };
  const found = bookFor(req.slug, st);
  if (!found) return { error: "unknown book" };
  if (!Number.isInteger(req.page)) return { error: "the page must be a whole number" };
  // As above: the words a parent types while the transcriber holds this book
  // are words the transcriber writes back over.
  const busy = busyWith(found.dir);
  if (busy) return busy;
  let text;
  try { text = store.readText(found.dir); }
  catch { return { error: "this book's text.json needs fixing by hand" }; }
  const pages = (text && text.pages) || [];
  const at = pages.findIndex(p => p.index === req.page);
  if (at < 0) return { error: "that is not a page of this book" };

  const words = req.text !== undefined, flags = req.flags !== undefined;
  if (!words && !flags) return { error: "nothing to change on that page" };
  if (words && typeof req.text !== "string") return { error: "a page's words must be text" };
  if (words && req.text.length > MAX_PAGE_TEXT)
    return { error: "that is more words than a page of a picture book holds" };
  if (flags && !(Array.isArray(req.flags) && req.flags.length === 0))
    return { error: "flags can only be cleared here" };

  const next = pages.slice();
  const p = { ...next[at] };
  if (words) {
    // THE AUDIO NO LONGER SAYS WHAT THE PAGE SAYS. Narration is bought per page
    // and never re-checked against the words it was bought for (content-narrate
    // rule 2), so a page republished now would SHOW the corrected line and SPEAK
    // — and highlight — the misread one, for ever: the next narrate walk would
    // reuse the mp3 too. The entry goes, the page publishes silent, and the walk
    // (or the Re-narrate button beside this one) buys the right recording.
    // Only when the words actually changed: a parent who opened the field and
    // typed nothing must not be charged for the page a second time.
    if (req.text !== p.text) forgetPage(found.dir, req.page);
    p.text = req.text;
    // WHOSE WORDS THESE ARE. The button next to this one reads the photos
    // again, and it keeps the pages a grown-up typed themselves (spec §5, the
    // "keep my edits" tick) — so the page has to remember that it was typed.
    p.edited = true;
    // A flag is a question ("did I read this word right?") and a parent who has
    // just retyped the line has answered it. Left behind, the Settings card
    // would go on counting words the model was unsure of under words the model
    // never wrote.
    p.flags = [];
    // And these are nobody's reading: `read` says which model produced the
    // words and who checked them (F7), and the words are now the parent's own.
    // `edited` is the provenance of a typed page.
    delete p.read;
  }
  if (flags) p.flags = [];
  next[at] = p;
  store.writeText(found.dir, { pages: next });
  store.appendLog(found.dir, "review", words
    ? "a grown-up rewrote page " + req.page + " (" + p.text.length + " character(s))"
    : "a grown-up cleared the flags on page " + req.page);
  return { saved: true, page: req.page, text: p.text, flags: p.flags,
           published: fs.existsSync(path.join(found.dir, "manifest.json")) };
}

// The one door the review page writes through. Which half of it a request means
// is decided by whether it names a page — a whole-book write (the drag, the
// cover) never names one, and a per-page write always does.
function saveText(o) {
  const req = o || {};
  return req.page == null ? saveOrder(req) : savePage(req);
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
  // Set by server.js: {kind, slug, name, dir} for a book that just published.
  // One property, one owner — the same shape (and the same warning about a slot
  // with two owners) as drive.onSynced.
  onPublished: null,
  start, scan, tick, run, runJob, runStep, isBuilding, idle, status, beat, claim,
  jobs, jobFor, bookFor, pagesFor, pageFile, saveOrder, savePage, saveText,
  rebuildPages, removeBook,
  KINDS, QUIET_MS, STALE_MS, MAX_PAGE_TEXT, NO_VOICE, NO_VISION, ALL_EDITED,
  _testReset: () => {
    running = null; inflight = null; queue = []; seen = new Map();
    progress = null; lastScan = null;
    module.exports.runJob = runJob;
    module.exports.onPublished = null;
  },
};
