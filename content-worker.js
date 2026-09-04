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
//   transcribing owes transcribe   -> reviewing      (T2.6)
//   reviewing    owes narrate      -> narrating      (content-narrate.js)
//   narrating    owes publish      -> published      (T2.8)
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
// Nothing here reads a key. The steps that spend money take their config from
// ai-config.js at the moment they need it, and content-store.js redacts every
// message that reaches job.json or log.jsonl.
"use strict";
const { parentPort, workerData } = require("worker_threads");
const path = require("path");
const store = require("./content-store.js");
const { ingest } = require("./content-ingest.js");
const { narrateBook } = require("./content-narrate.js");

const DIR = workerData.dir;
const DATA = workerData.dataDir;
const SLUG = workerData.slug || path.basename(DIR || "");
const ONLY = workerData.step || null;   // POST /content/run {step}: re-run one step

// How often a step in flight refreshes the claim. Well inside content.js's
// thirty-minute stale window, so a long transcription is never mistaken for a
// laptop that was closed mid-book.
const BEAT_EVERY = 60 * 1000;

const STEPS = [
  { name: "ingest",     owes: "inbox",        then: "transcribing",
    run: (c) => ingest(c.dir) },
  { name: "transcribe", owes: "transcribing", then: "reviewing",    run: null },
  { name: "narrate",    owes: "reviewing",    then: "narrating",
    run: (c) => narrateBook(c.dir, { dataDir: c.dataDir }) },
  { name: "publish",    owes: "narrating",    then: "published",    run: null },
];

const byName = (n) => STEPS.find(s => s.name === n);
const post = (m) => { if (parentPort) parentPort.postMessage(m); };

// A book that fell over transiently resumes at the step it fell over on:
// content-store.js keeps `failedFrom`, so "failed" is not a dead end. A
// PERMANENT failure (a key the provider refused, the convention
// content-narrate.js already uses) is left alone — re-running it every half
// hour would only spend the family's allowance on the same refusal.
function owedState(job) {
  if (job.state !== "failed") return job.state;
  const last = (job.errors || [])[job.errors.length - 1];
  if (last && /^permanent:/.test(String(last.msg || ""))) return null;
  return job.failedFrom || "inbox";
}

// What the shell (and later /content/status) is told about a finished step.
// Deliberately small and JSON-safe: a step's own result can carry page arrays
// megabytes wide, and none of that belongs in a status payload.
function summary(step, result) {
  const r = result && typeof result === "object" ? result : {};
  const out = { step };
  for (const k of ["pages", "wrote", "copied", "narrated", "reused", "skipped"]) {
    const v = r[k];
    if (Array.isArray(v)) out[k] = v.length;
    else if (v != null) out[k] = v;
  }
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
    const result = await step.run({ dir: DIR, dataDir: DATA, job, slug: SLUG });
    steps.push(summary(step.name, result));

    // Re-read: the step just wrote to .build/ itself, and the heartbeat may
    // have moved under us while it worked.
    const now = store.readJob(DIR);
    // A named step re-run out of order (a parent re-narrating page 7) must
    // never walk the job backwards — it only advances the state it owed.
    if (owedState(now) === step.owes) store.writeJob(DIR, store.transition(now, step.then));
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
