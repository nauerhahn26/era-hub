// content-narrate.js — step 3 of the book pipeline: give the page a voice.
//
// ElevenLabs' `/with-timestamps` endpoint returns the mp3 AND the per-character
// timing in ONE call, which is why this replaces the old TTS + Whisper pair:
// one call per page, one charge per page, and the timings are the provider's
// own rather than a second model's guess at them. Grouping those characters
// into the reader's `words[{word,start,end}]` is words.js, a faithful port of
// the script that narrated the family's existing books.
//
// Three rules this step lives by:
//
//  1. NO KEY IS AN EMPTY OUTCOME, NOT A FAILURE. A family on a free vision key
//     and no Voice card still gets their book — with text and no audio (spec §4
//     "free Google" row). narrateBook() returns {skipped:"no-eleven-key"} and
//     the job walks on to publish.
//  2. NOTHING IS RE-NARRATED FOR FREE. Every call costs the family characters,
//     so a page whose mp3 and timings are already on disk is reused, and a
//     re-run of the step after a crash resumes rather than starts over. Only
//     `only:[index]` (the review page's "Re-narrate this page") pays again.
//  3. NO KEY REACHES DISK. ElevenLabs' error bodies echo the request back at
//     you, so every message that lands in narration.json, log.jsonl or a return
//     value goes through content-store's redact() first.
//
// Test seam: ERA_ELEVEN_URL, the same one server.js's Voice card uses
// (server.js:973). It is read FRESH on every call, never captured at load, so a
// suite can point it at a stand-in after this module is required. Nothing in
// tests/ may ever reach the real host — the family's card is on it.
"use strict";
const fs = require("fs");
const path = require("path");
const store = require("./content-store.js");
const words = require("./words.js");
const { aiRoles } = require("./ai-config.js");

// The voice model her other books were narrated with (verified from the live
// event log of the existing packages): multilingual v2, not the cheaper flash
// the board's chat coach uses — a story is read once and listened to fifty
// times, so the better voice is worth the characters.
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";
// mp3 at 44.1 kHz / 128 kbps: what `with-timestamps` is documented to align
// against, and what the reader's <audio> already plays.
const OUTPUT_FORMAT = "mp3_44100_128";
// One page of a picture book is a sentence or two. Two minutes is generous for
// that and still short enough that a wedged provider does not hold the worker.
const TIMEOUT_MS = 120000;

function elevenBase() { return process.env.ERA_ELEVEN_URL || "https://api.elevenlabs.io"; }

// Media paths in the manifest are zero-padded three digits (spec §2:
// pages/001.jpg, audio/001.mp3, video/001.mp4).
function pad3(n) { return String(n).padStart(3, "0"); }

function audioRel(index) { return "audio/" + pad3(index) + ".mp3"; }
function narrationPath(dir) { return path.join(store.buildDir(dir), "narration.json"); }

// ------------------------------------------------------------------ one page

// narratePage(text, cfg) -> {audio: Buffer, words: [{word,start,end}]}
// cfg = {apiKey, voiceId, modelId?}. Throws "permanent: …" for a refusal that
// retrying cannot fix (a bad or revoked key), plain Errors for everything else.
async function narratePage(text, cfg) {
  const c = cfg || {};
  if (!c.apiKey) throw new Error("permanent: no ElevenLabs key");
  if (!c.voiceId) throw new Error("permanent: no ElevenLabs voice");
  const url = elevenBase() + "/v1/text-to-speech/" + encodeURIComponent(c.voiceId) +
              "/with-timestamps?output_format=" + OUTPUT_FORMAT;
  const r = await fetch(url, {
    method: "POST",
    // The key travels as a header, never as a query parameter: a URL ends up in
    // logs and error bodies, and this one is billable.
    headers: { "xi-api-key": c.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: c.modelId || DEFAULT_MODEL_ID }),
    signal: AbortSignal.timeout(c.timeoutMs || TIMEOUT_MS),
  });
  if (!r.ok) {
    const body = store.redact((await r.text().catch(() => "")).slice(0, 200));
    if (r.status === 401 || r.status === 403)
      throw new Error("permanent: ElevenLabs did not accept that key (" + r.status + ") " + body);
    throw new Error("elevenlabs " + r.status + " " + body);
  }
  const reply = await r.json();
  const w = words.wordsFromAlignment(reply);
  // No timings means no highlighting, and a silent-but-timed page is not a
  // thing the reader can show. Fail the page rather than publish half of it.
  if (!w) throw new Error("elevenlabs reply carried no alignment");
  if (typeof reply.audio_base64 !== "string" || !reply.audio_base64)
    throw new Error("elevenlabs reply carried no audio");
  return { audio: Buffer.from(reply.audio_base64, "base64"), words: w };
}

// ---------------------------------------------------------------- one book

function readNarration(dir) {
  const raw = store.readJson(narrationPath(dir));
  if (!raw || !Array.isArray(raw.pages)) return { pages: [] };
  return { pages: raw.pages.filter(p => p && Number.isInteger(p.index)) };
}

// narrateBook(dir, opts) — narrate every page of `dir` that has text.
//
//   opts.cfg      {apiKey, voiceId, modelId} — for a caller that already has it
//   opts.dataDir  <DATA>, to read the Voice card instead (the worker's way in)
//   opts.only     [index, …] pay again for exactly these pages
//   opts.text     an already-loaded text.json (skips the read)
//   opts.now      pinned clock for the log
//
// Returns {narrated, reused, pages:[{index, audio, words}], errors:[…]}, plus
// {skipped:"no-eleven-key"} when there is no key and {permanent:true} when the
// provider refused the key outright.
//
// INTERFACE NOTE for the wiring task (T2.4/T2.8): the word timings cannot live
// in text.json — that file's schema is fixed at {index, source, text, flags,
// cover} and is the hand-editable interop point. They go in
// .build/narration.json as {pages:[{index, audio, words}]}, written atomically,
// which is also what makes rule 2 (never pay twice) possible across a crash.
// The publish step reads it with readNarration(dir) and copies `audio` and
// `words` onto the manifest's pages; a page missing from it publishes silent.
async function narrateBook(dir, opts) {
  const o = opts || {};
  const cfg = o.cfg || (o.dataDir ? aiRoles(o.dataDir).elevenlabs : null);
  if (!cfg || !cfg.apiKey) {
    // Not an error, and deliberately not logged as one: this is the whole
    // free-tier story, and a parent who never bought a voice should not meet a
    // red line in their book's log every single run.
    store.appendLog(dir, "narrate", "no ElevenLabs key - the book will publish with text and no audio", { now: o.now });
    return { skipped: "no-eleven-key", narrated: 0, reused: 0, pages: [], errors: [] };
  }
  const text = o.text || store.readText(dir);
  if (!text) throw new Error("narrate: no text.json in " + path.basename(dir));

  const only = Array.isArray(o.only) ? new Set(o.only) : null;
  const have = new Map(readNarration(dir).pages.map(p => [p.index, p]));
  const out = [];
  const errors = [];
  let narrated = 0, reused = 0, permanent = false;

  for (const page of text.pages) {
    // A page with no words is a picture page: silent by design, no call, no
    // entry, and the reader already knows how to show one.
    if (!page.text || !page.text.trim()) { have.delete(page.index); continue; }
    const mp3 = path.join(dir, "audio", pad3(page.index) + ".mp3");
    const done = have.get(page.index);
    // The entry AND the file: an mp3 someone deleted (or a Drive mirror that
    // never landed) has to be re-narrated, or publish points the reader at a
    // 404 forever.
    const doneOk = !!done && fs.existsSync(mp3);
    const forced = !!only && only.has(page.index);
    if (doneOk && !forced) {
      out.push({ index: page.index, audio: audioRel(page.index), words: done.words || [] });
      reused++;
      continue;
    }
    // Asked for one page, and this is not it: leave the others alone rather
    // than quietly spending on them.
    if (only && !forced) continue;
    try {
      const r = await narratePage(page.text, cfg);
      // The mp3 lands before the entry that points at it, and both land
      // atomically: a torn write here is a page that plays static.
      store.writeAtomic(mp3, r.audio);
      out.push({ index: page.index, audio: audioRel(page.index), words: r.words });
      narrated++;
      store.appendLog(dir, "narrate", "page " + page.index + ": " + r.words.length + " words", { now: o.now });
    } catch (e) {
      const msg = store.redact(e && e.message ? e.message : String(e));
      errors.push(msg);
      store.appendLog(dir, "narrate", "page " + page.index + " failed: " + msg, { now: o.now });
      // A refused key will refuse every remaining page too. Stop; a transient
      // one only costs this page, and the next run picks it up.
      if (/^permanent:/.test(msg)) { permanent = true; break; }
    }
  }

  out.sort((a, b) => a.index - b.index);
  // Written even when nothing changed: it is also the record of which pages are
  // deliberately silent, and publish reads it rather than the audio directory.
  store.writeAtomic(narrationPath(dir), { pages: out });
  const res = { narrated, reused, pages: out, errors };
  if (permanent) res.permanent = true;
  return res;
}

module.exports = {
  DEFAULT_MODEL_ID, OUTPUT_FORMAT, TIMEOUT_MS,
  elevenBase, pad3, audioRel, narrationPath, readNarration,
  narratePage, narrateBook,
};
