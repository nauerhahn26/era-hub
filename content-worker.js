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
// small mistake is tolerable; a book that never appears is not"). Animation
// (spec §4, optional) plugs in after "published" the same way.
//
// A step whose `run` is still null is not an error and not a failure: the walk
// stops there and says which step it was waiting for, leaving the claim, the
// heartbeat and every byte already built exactly where they are. That is the
// safe half of the deal while the pipeline is being written a step at a time.
//
// A step that RAN may ask for the same treatment by returning {hold}: it did
// what it could and the job still owes this step. Two live cases:
//   {hold:"no-ai-key"}   nothing to spend yet — the book waits in the folder.
//   {hold:"quota", pausedUntil:"YYYY-MM-DD"}   a free key's daily allowance is
//     gone. The day is recorded on the job so tomorrow's run knows not to
//     knock before then, the state stays exactly where it was, and the book is
//     NEVER marked failed for it (spec §4 step 2, §7 risks).
// A hold keeps the claim and does not advance the state; the pages already
// built are kept, and the next scan picks the book up where it stopped.
//
// Nothing here reads a key. The steps that spend money take their config from
// ai-config.js at the moment they need it, and content-store.js redacts every
// message that reaches job.json or log.jsonl.
"use strict";
const { parentPort, workerData } = require("worker_threads");
const path = require("path");
const store = require("./content-store.js");
const { ingest } = require("./content-ingest.js");
const { narrateBook } = require("./content-narrate.js");
const { transcribeBook } = require("./content-providers.js");
const { publishBook } = require("./content-publish.js");

const DIR = workerData.dir;
const DATA = workerData.dataDir;
const SLUG = workerData.slug || path.basename(DIR || "");
// The folder name as the parent typed it ("Tabby McTat") — the book's title.
// The slug is the URL; this is what a reader sees on the shelf.
const NAME = workerData.name || path.basename(DIR || "");
const ONLY = workerData.step || null;   // POST /content/run {step}: re-run one step

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
    run: (c) => transcribeBook(c.dir, { dataDir: c.dataDir, job: c.job }) },
  { name: store.STEP_OWED.reviewing,    owes: "reviewing",    then: "narrating",
    run: (c) => narrateBook(c.dir, { dataDir: c.dataDir }) },
  { name: store.STEP_OWED.narrating,    owes: "narrating",    then: "published",
    run: (c) => publishBook(c.dir, { slug: c.slug, title: c.name }) },
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
  for (const k of ["pages", "wrote", "copied", "transcribed", "escalated", "calls",
                   "narrated", "reused", "skipped", "silent", "flagged", "blank"]) {
    const v = r[k];
    if (Array.isArray(v)) out[k] = v.length;
    else if (v != null) out[k] = v;
  }
  return out;
}

// A finished step drops the pause it was waiting under.
function unpause(job) {
  const out = { ...job };
  delete out.pausedUntil; delete out.pausedNote;
  return out;
}

// The job stays exactly where it is: same state, same claim, fresh heartbeat
// (so no other device mistakes a waiting book for an abandoned one), plus the
// day it may try again and the sentence Settings shows meanwhile.
function holdHere(job, step, hold, steps) {
  if (job) {
    const held = store.transition(job, job.state);
    if (hold.pausedUntil) { held.pausedUntil = hold.pausedUntil; held.pausedNote = hold.note || null; }
    store.writeJob(DIR, held);
  }
  const out = { slug: SLUG, state: job ? job.state : null, steps, held: hold.hold, step: step.name };
  if (hold.pausedUntil) { out.pausedUntil = hold.pausedUntil; out.note = hold.note || null; }
  return out;
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
    if (!step) return { slug: SLUG, state: job.state, steps, finished: true };
    if (!step.run) return { slug: SLUG, state: job.state, steps, pending: step.name };

    post({ step: step.name, state: job.state, slug: SLUG });
    const result = await step.run({ dir: DIR, dataDir: DATA, job, slug: SLUG, name: NAME });

    // Re-read: the step just wrote to .build/ itself, and the heartbeat may
    // have moved under us while it worked.
    const now = store.readJob(DIR);
    const hold = result && typeof result === "object" && result.hold ? result : null;
    if (hold) return holdHere(now, step, hold, steps);
    steps.push(summary(step.name, result));

    // A named step re-run out of order (a parent re-narrating page 7) must
    // never walk the job backwards — it only advances the state it owed.
    // A step that finished also clears any pause it was under: the allowance
    // came back, so nothing must keep telling the family it has not.
    if (owedState(now) === step.owes) store.writeJob(DIR, unpause(store.transition(now, step.then)));
    if (ONLY) return { slug: SLUG, state: store.readJob(DIR).state, steps, finished: true };
  }
  return { slug: SLUG, state: store.readJob(DIR).state, steps, finished: true };
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
