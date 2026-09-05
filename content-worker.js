// content-worker.js — the book builder's engine room, run in a WORKER THREAD
// for the reason clothing-worker.js was (dad 8/31: the pixel work on the main
// thread froze every hub page for minutes). content.js is the thin shell that
// decides WHICH folder to build and spawns exactly one of these at a time;
// this file decides WHAT to do to it and reports back as it goes.
//
// THE STEP TABLE. A book's state in job.json is the name of the step it still
// OWES, so the table below reads straight down the state machine
// content-store.js defines:
//
//   inbox        owes ingest       -> transcribing   (content-ingest.js)
//   transcribing owes transcribe   -> reviewing      (content-providers.js)
//   reviewing    owes narrate      -> narrating      (content-narrate.js)
//   narrating    owes publish      -> published      (content-publish.js)
//
// "reviewing" owes narration because review never blocks a book: a flagged
// page publishes anyway and a parent fixes it afterwards (ruling 9/4 — "a
// small mistake is tolerable; a book that never appears is not").
//
// ANIMATION IS IN THE TABLE BUT NOT IN THE WALK. It is the one step that spends
// dollars, so no state owes it: it has `owes: null`, which means the walk above
// can never select it and content.js's half-hourly scan can never reach it. The
// only way in is being named — POST /content/run {step:"animate"} — which is to
// say a parent pressing a button that quoted the book first (spec §4 step 5).
//
// A step whose `run` is still null is not an error and not a failure: the walk
// stops there and says which step it was waiting for, leaving the claim, the
// heartbeat and every byte already built exactly where they are. That is the
// safe half of the deal while the pipeline is being written a step at a time.
//
// A step that RAN may ask for the same treatment by returning {hold}: it did
// what it could and the job still owes this step. Two live cases:
//   {hold:"no-ai-key"}   nothing to spend yet — the book waits in the folder.
//   {hold:"quota", pausedUntil:"<ISO timestamp>"}   a free key's allowance is
//     gone. The MOMENT it is expected back (content-providers.js F6: the 429's
//     own RetryInfo, else midnight where the allowance is counted, which is
//     California and not this computer) is recorded on the job so neither the
//     next run nor the scan knocks before then, the state stays where it was,
//     and the book is NEVER marked failed for it (spec §4 step 2, §7 risks).
// A hold keeps the claim and does not advance the state; the pages already
// built are kept, and the next scan picks the book up where it stopped.
//
// A step that DID work but lost pages on the way reports them in `errors[]`,
// and this walk keeps them on the job (content-store.noteErrors) so
// /content/status and the Settings card can say so. Two outcomes follow:
//   errors[] and no `permanent`  the step still owes those pages, so the walk
//     holds ({hold:"retry"}) rather than advancing — publishing now would
//     freeze the loss into the book, and every page already bought is kept.
//   permanent:true               a key the provider refused. The book stops and
//     names the reason; a scan never retries it (the same refusal costs the
//     same), but a parent who fixes the key can (content.js runStep).
// A DELIBERATE empty outcome is neither: no key at all, or a page the model
// correctly read as wordless, reports no error and the walk carries on.
//
// The last state is `done`: `published` owes no step, so a walk that stopped
// there would leave every finished book looking claimable half an hour later,
// for ever. settle() below writes that last transition.
//
// ONE STEP, ONE PAGE (spec §5, the review page's "Re-narrate this page"). A run
// may name a step and a page. Both narrow the walk to a repair rather than a
// pass of the pipeline, and both change what happens afterwards: a named page
// never ticks the book's step off (it only did one page of it), and a named
// step on a book that is already on the shelf is followed by a publish, because
// the manifest is the only thing the reader ever reads.
// A run may instead name a LIST of pages ("Read the photos again"): that is the
// whole step, done to the pages it names, so it does tick the step off.
//
// Nothing here reads a key. The steps that spend money take their config from
// ai-config.js at the moment they need it, and content-store.js redacts every
// message that reaches job.json or log.jsonl.
"use strict";
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const store = require("./content-store.js");
const { ingest } = require("./content-ingest.js");
const { narrateBook, said } = require("./content-narrate.js");
const { animateBook } = require("./content-animate.js");
const { transcribeBook } = require("./content-providers.js");
const { publishBook } = require("./content-publish.js");

const DIR = workerData.dir;
const DATA = workerData.dataDir;
const SLUG = workerData.slug || path.basename(DIR || "");
// The folder name as the parent typed it ("Tabby McTat") — the book's title.
// The slug is the URL; this is what a reader sees on the shelf.
const NAME = workerData.name || path.basename(DIR || "");
const ONLY = workerData.step || null;   // POST /content/run {step}: re-run one step
// POST /content/run {step, page}: the review page's "Re-narrate this page". A
// named page is a REPAIR, not the book's step — see the two rules it changes in
// walk() below. `null` (the normal case) means the whole book.
const PAGE = Number.isInteger(workerData.page) ? workerData.page : null;
// POST /content/run {step:"transcribe", rebuild:true}: the review page's "Read
// the photos again". A LIST of pages to read a SECOND time — the transcriber
// otherwise skips every page that already has words, which is what makes a book
// resumable on a free key. content.js decides the list (which pages a grown-up
// typed themselves, and whether they asked to keep them); this only carries it.
// null (the normal case) means "whatever the step owes".
const PAGES = Array.isArray(workerData.pages)
  ? workerData.pages.filter(Number.isInteger) : null;

// How often a step in flight refreshes the claim. Well inside content.js's
// thirty-minute stale window, so a long transcription is never mistaken for a
// laptop that was closed mid-book.
const BEAT_EVERY = 60 * 1000;

// Names come from content-store.STEP_OWED so this table and the one
// /content/status names (and POST /content/run validates against) can never
// drift apart — the state machine's owner names its own steps.
const STEPS = [
  { name: store.STEP_OWED.inbox,        owes: "inbox",        then: "transcribing",
    run: (c) => ingest(c.dir) },
  { name: store.STEP_OWED.transcribing, owes: "transcribing", then: "reviewing",
    // `only` is what makes "Read the photos again" pay for exactly the pages a
    // parent asked to have read again, and for no others — the pages they typed
    // themselves keep the words they typed (content.rebuildPages).
    run: (c) => transcribeBook(c.dir, { dataDir: c.dataDir, job: c.job, only: c.pages }) },
  { name: store.STEP_OWED.reviewing,    owes: "reviewing",    then: "narrating",
    // `only` is what keeps a re-narrate to ONE page: every other page of the
    // book keeps the audio and the timings already bought for it, untouched and
    // unpaid-for a second time (content-narrate.js rule 2). `c.only` is the
    // same knob for a LIST — renarrate() below hands it the pages a re-read
    // rewrote — and it is never set by the walk itself.
    run: (c) => narrateBook(c.dir, { dataDir: c.dataDir,
                                     only: c.only || (c.page == null ? null : [c.page]) }) },
  { name: store.STEP_OWED.narrating,    owes: "narrating",    then: "published",
    run: (c) => publishBook(c.dir, { slug: c.slug, title: c.name }) },
  // THE OPTIONAL STEP, AND THE ONLY ONE THAT SPENDS DOLLARS (T6.2, spec §4
  // step 5). `owes: null` is the whole of "off by default": no state owes it,
  // so the walk above can never select it and neither can content.js's
  // half-hourly scan — it is reachable ONLY by name, which is to say only by
  // POST /content/run {step:"animate"}, which is to say only by a parent
  // pressing a button that says what the book will cost. It never ticks a state
  // off either (`then: null`): a published book stays published, and settle()
  // still walks it to `done` because nothing here owes "published".
  //
  // `optional` is the other half: a clip that could not be made is one page's
  // loss, never the book's. It must not hold the job (there is no state to
  // resume) and a key fal refuses must not mark a FINISHED book failed — see
  // the two guards in walk().
  { name: store.STEP_ANIMATE, owes: null, then: null, optional: true,
    run: (c) => animateBook(c.dir, { dataDir: c.dataDir, slug: c.slug, name: c.name,
                                     only: c.only || (c.page == null ? null : [c.page]) }) },
];

const byName = (n) => STEPS.find(s => s.name === n);
const post = (m) => { if (parentPort) parentPort.postMessage(m); };

// A book that fell over transiently resumes at the step it fell over on, and a
// permanent failure is left alone: content-store.js owns that rule now, so
// /content/status shows the family exactly the step this walk would take.
const owedState = store.owedState;

// What the shell (and later /content/status) is told about a finished step.
// Deliberately small and JSON-safe: a step's own result can carry page arrays
// megabytes wide, and none of that belongs in a status payload.
function summary(step, result) {
  const r = result && typeof result === "object" ? result : {};
  const out = { step };
  // `published` is in the list for the shell rather than for the card: content.js
  // reads it to tell whoever is listening that a finished book is sitting in the
  // family's Drive folder and is not on the Reader's shelf yet (F5).
  for (const k of ["pages", "wrote", "copied", "transcribed", "escalated", "calls",
                   "narrated", "reused", "chars", "skipped", "silent", "flagged", "blank",
                   "animated", "clips", "published", "errors"]) {
    const v = r[k];
    if (Array.isArray(v)) out[k] = v.length;
    else if (v != null) out[k] = v;
  }
  return out;
}

// A finished step drops the pause — and the hold — it was waiting under: the
// allowance came back, or the page it lost was read this time, so nothing must
// keep telling the family otherwise.
function unpause(job) {
  const out = { ...job };
  delete out.pausedUntil; delete out.pausedNote; delete out.held;
  return out;
}

// The job stays exactly where it is: same state, same claim, fresh heartbeat
// (so no other device mistakes a waiting book for an abandoned one), plus the
// day it may try again and the sentence Settings shows meanwhile.
function holdHere(job, step, hold, steps) {
  if (job) {
    const held = store.transition(job, job.state);
    // Why it stopped here, kept on the job so the next reader knows: a resumed
    // book that is merely waiting must not look like a book that fell over
    // (content.js reads this to decide whether to show the last error).
    held.held = hold.hold;
    if (hold.pausedUntil) { held.pausedUntil = hold.pausedUntil; held.pausedNote = hold.note || null; }
    store.writeJob(DIR, held);
  }
  const out = { slug: SLUG, state: job ? job.state : null, steps, held: hold.hold, step: step.name };
  if (hold.pausedUntil) { out.pausedUntil = hold.pausedUntil; out.note = hold.note || null; }
  return out;
}

// The end of the road. `published` owes no step (animation is optional and has
// no step yet), so a walk that simply stopped there left every finished book in
// a state content.js's claim rules still consider live: re-claimed and
// re-spawned every half hour for ever, rewriting job.json and log.jsonl inside
// the family's Drive folder each time, for Drive to re-upload and re-mirror.
// `done` is the state nothing takes back. Written from the step table itself,
// so the day an animate step owes `published` this stops firing on its own.
function settle(job) {
  if (!job) return null;
  if (owedState(job) === "published" && !STEPS.some(s => s.owes === "published"))
    return store.writeJob(DIR, store.transition(job, "done")).state;
  return job.state;
}

// A single step re-run on a book that is ALREADY on Ellie's shelf has to be
// followed by a publish. The manifest is the only thing the reader reads, so a
// correction that stops at text.json is a correction she never hears — and
// `exportedAt` is the reader's cache-bust (public/reader/reader.js), so without
// a fresh publish she keeps yesterday's audio for a whole day.
//
// A book that has NOT published yet is deliberately left alone: freezing a
// half-built book into a package she could open is worse than making her wait
// for the walk to reach publish in its own time.
// THE WORDS AS THEY STAND, page by page: {index -> fingerprint}, in the very
// shape content-narrate.js records against the audio it buys (`said`). Taken
// before a step that can rewrite them and again after, it is the whole of
// renarrate()'s question — which pages actually moved — and it asks the same
// module the narrate walk asks, so the two can never disagree about what
// "changed" means.
function wordsNow() {
  const out = new Map();
  let text = null;
  try { text = store.readText(DIR); } catch {}
  for (const p of (text && text.pages) || []) out.set(p.index, said(p.text));
  return out;
}

// "READ THE PHOTOS AGAIN" DOES NOT END AT THE WORDS (F5, 9/4). Since E6 a page
// whose text moved publishes SILENT — its mp3 speaks the sentence it replaced,
// and naming it would highlight one sentence while saying another to a child
// who cannot read. Nothing then re-narrated it, so a re-read left the family
// with a book that had quietly lost its voice on exactly the pages they asked
// to have read again.
//
// So the repair walks on, through the step table's own narrate step — the one
// the state that owes narrate names — rather than a side path of its own, and
// it pays for EXACTLY the pages whose fingerprint moved. Not the book: a book
// that published silent for want of a Voice card must not be bought outright
// because a grown-up pressed a button about the PHOTOS. `before` is the
// fingerprint map from before the re-read; a page nobody rewrote is not in
// `changed` and is not asked for.
//
// What it could not record goes on the job's history rather than failing the
// book: this is a repair to a package that is already on the shelf, and the
// pages it could not buy publish silent (content-publish.js), which is the
// honest shape and the one the next walk mends.
async function renarrate(before, steps) {
  const nar = STEPS.find(s => s.owes === "reviewing");
  if (!before || !nar || !nar.run || ONLY === nar.name) return;
  const after = wordsNow();
  const changed = [];
  for (const [index, fingerprint] of after)
    if (before.has(index) && before.get(index) !== fingerprint) changed.push(index);
  if (!changed.length) return;
  post({ step: nar.name, state: (store.readJob(DIR) || {}).state || null, slug: SLUG });
  const r = await nar.run({ dir: DIR, dataDir: DATA, job: store.readJob(DIR),
                            slug: SLUG, name: NAME, only: changed });
  steps.push(summary(nar.name, r));
  const errors = r && Array.isArray(r.errors) ? r.errors.filter(Boolean) : [];
  const job = store.readJob(DIR);
  if (errors.length && job) store.writeJob(DIR, store.noteErrors(job, errors));
}

async function republish(steps) {
  const pub = STEPS.find(s => s.owes === "narrating");
  if (!pub || ONLY === pub.name) return;                 // publish just ran
  if (!fs.existsSync(path.join(DIR, "manifest.json"))) return;
  post({ step: pub.name, state: (store.readJob(DIR) || {}).state || null, slug: SLUG });
  const r = await pub.run({ dir: DIR, dataDir: DATA, job: store.readJob(DIR), slug: SLUG, name: NAME });
  steps.push(summary(pub.name, r));
}

async function walk() {
  const steps = [];
  // One pass per step at most: every step either moves the job forward or ends
  // the walk, so a table that somehow cycled could never spin here.
  for (let i = 0; i <= STEPS.length; i++) {
    const job = store.readJob(DIR);
    if (!job) throw new Error("no job.json in " + path.basename(DIR));
    const owed = owedState(job);
    if (owed === null) return { slug: SLUG, state: job.state, steps, failed: true };
    const step = ONLY ? byName(ONLY) : STEPS.find(s => s.owes === owed);
    if (ONLY && !step) throw new Error("no such build step: " + ONLY);
    if (!step) return { slug: SLUG, state: settle(job), steps, finished: true };
    if (!step.run) return { slug: SLUG, state: job.state, steps, pending: step.name };

    post({ step: step.name, state: job.state, slug: SLUG });
    // The words BEFORE this step, for the one step that rewrites them: a
    // re-read has to be followed by the narration the new words owe, and only
    // for the pages that actually changed (renarrate below).
    const wordsBefore = ONLY && step.owes === "transcribing" ? wordsNow() : null;
    const result = await step.run({ dir: DIR, dataDir: DATA, job, slug: SLUG, name: NAME,
                                    page: PAGE, pages: PAGES });

    // Re-read: the step just wrote to .build/ itself, and the heartbeat may
    // have moved under us while it worked.
    let now = store.readJob(DIR);
    const hold = result && typeof result === "object" && result.hold ? result : null;
    if (hold) return holdHere(now, step, hold, steps);
    steps.push(summary(step.name, result));

    // WHAT THE STEP COULD NOT DO. A step reports the pages it lost in
    // `errors[]`, and `permanent:true` when the provider refused outright.
    // Neither used to be read at all, so a page whose call 500'd was left
    // wordless or silent, the job walked on to published, and nothing in
    // job.json, /content/status or the Settings card ever said so.
    const errors = result && Array.isArray(result.errors) ? result.errors.filter(Boolean) : [];
    const permanent = !!(result && result.permanent);
    // fail() writes the last message itself, so it is not noted twice — unless
    // this is the optional step, which never calls fail().
    const keep = permanent && !step.optional ? errors.slice(0, -1) : errors;
    if (keep.length && now) now = store.writeJob(DIR, store.noteErrors(now, keep));

    // THE OPTIONAL STEP IS NEVER THE BOOK'S PROBLEM. Animation is the one step
    // no state owes, so neither of the two answers below fits it: there is no
    // state to hold in (the book is already published, and holding would park a
    // finished book on a "retry" the card would print under it for ever), and a
    // key fal refused must not mark a FINISHED book failed — the family's book
    // is on the shelf and reads perfectly; it is the moving pictures that did
    // not happen. What went wrong is kept on the job's history (above) and in
    // log.jsonl, and the review page tells the parent how many pages actually
    // gained a clip.
    if (step.optional) {
      // The animate step re-publishes after every single clip itself, so the
      // walk only steps in when that could not happen: a run that changed
      // nothing must not hand Google Drive a fresh manifest to re-upload to
      // every device in the family for nothing.
      if (result && result.animated && !result.publishes) await republish(steps);
      return { slug: SLUG, state: settle(store.readJob(DIR)), steps, finished: true };
    }

    // A refusal will refuse every retry too (a key the provider will not take),
    // so the book stops and says why. It is not a dead end: content-store keeps
    // failedFrom, and a parent pressing "try this book again" after fixing the
    // key resumes at this very step (content.js runStep).
    if (permanent && now) {
      const why = errors.length ? errors[errors.length - 1] : "the provider refused";
      store.writeJob(DIR, store.fail(now, /^permanent:/.test(why) ? why : "permanent: " + why));
      return { slug: SLUG, state: "failed", steps, failed: true, step: step.name };
    }
    // Something transient went wrong and this step still owes those pages. Hold
    // rather than advance: publishing now would freeze the loss into the book,
    // and the step is resumable — every page already bought is kept, so the
    // next scan only pays for the ones that are still missing.
    if (errors.length) return holdHere(now, step, { hold: "retry" }, steps);

    // A named step re-run out of order (a parent re-narrating page 7) must
    // never walk the job backwards — it only advances the state it owed.
    // A step that finished also clears any pause it was under: the allowance
    // came back, so nothing must keep telling the family it has not.
    //
    // ONE PAGE IS NOT THE STEP. A run for a single page did what was asked of
    // it and no more, so it must not tick the book's step off: a book waiting
    // for its narration whose parent re-recorded page one would otherwise walk
    // straight on to publish with every other page silent, for ever.
    if (PAGE == null && owedState(now) === step.owes)
      store.writeJob(DIR, unpause(store.transition(now, step.then)));
    if (ONLY) {
      await renarrate(wordsBefore, steps);
      await republish(steps);
      return { slug: SLUG, state: settle(store.readJob(DIR)), steps, finished: true };
    }
  }
  return { slug: SLUG, state: settle(store.readJob(DIR)), steps, finished: true };
}

const beat = setInterval(() => {
  try {
    const job = store.readJob(DIR);
    if (job) store.writeJob(DIR, store.transition(job, job.state));
  } catch {}
}, BEAT_EVERY);
beat.unref();

walk()
  .then((r) => { clearInterval(beat); post({ done: r }); })
  .catch((e) => {
    clearInterval(beat);
    const msg = store.redact(e.message);
    console.error("[content] " + SLUG + ": " + msg);
    // The book keeps its error history so the next device to pick it up knows
    // what it walked into; the message is redacted on the way in either way.
    try {
      const job = store.readJob(DIR);
      if (job) store.writeJob(DIR, store.fail(job, msg));
      store.appendLog(DIR, "build", msg);
    } catch {}
    post({ done: { slug: SLUG, error: msg } });
  });
