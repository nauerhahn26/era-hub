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
//  2. NOTHING IS RE-NARRATED FOR FREE — AND NOTHING SPEAKS THE WRONG WORDS.
//     Every call costs the family characters, so a page whose mp3 and timings
//     are already on disk is reused, and a re-run of the step after a crash
//     resumes rather than starts over. The one page that IS bought again is the
//     page whose words have changed since it spoke: every entry records the
//     fingerprint of the text it was bought for (`said`), and a page whose
//     fingerprint disagrees owes a new recording. `only:[index]` (the review
//     page's "Re-narrate this page") pays again on request.
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
const crypto = require("crypto");
const store = require("./content-store.js");
const words = require("./words.js");
const { aiRoles, DEFAULT_MODEL_ID } = require("./ai-config.js");

// The model is the FAMILY'S, off the Voice card, and ai-config.js's elevenRole
// now carries it here (it did not until 9/4, so this module fell through to a
// preference of its own — eleven_multilingual_v2 — and the 3-page run was read,
// and credited in the manifest, in a model the card does not name). There is one
// default now and it is the card's own: ai-config.DEFAULT_MODEL_ID, the same
// eleven_flash_v2_5 server.js's loadTtsCfg() starts every card at. A family who
// wants the richer multilingual voice picks it there, once, for everything the
// hub speaks in.
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

// WHAT THIS PAGE SAID. Rule 2 above used to be decided by one question — is
// there an mp3? — and that question cannot tell a page that is already narrated
// from a page whose WORDS HAVE CHANGED since it was. forgetPage() below is the
// answer for the one writer that knows it changed them (the review page's edit
// button); it is not the only writer of text.json — "read the photos again"
// rewrites every unedited page, power mode lets a parent edit the file by hand,
// and a future step can too. None of those can be relied on to say so. So the
// entry carries the fingerprint of the exact text it was bought for and the walk
// asks the words themselves: a page whose fingerprint disagrees is re-narrated,
// and content-publish.js will not name audio whose fingerprint disagrees (e2e
// 9/4: a book published showing a grown-up's correction and SPEAKING — and
// highlighting, word by word — the sentence it replaced, on all three pages).
// Sixteen hex characters tell two versions of one page apart and keep
// narration.json small enough for Drive to mirror on every publish.
const said = (text) => crypto.createHash("sha1")
  .update(String(text == null ? "" : text)).digest("hex").slice(0, 16);

// BILL IT WHILE YOU SPEND IT (L5, the 16-page live run of 9/4). The characters
// a page cost cannot be read back off the page afterwards: a page corrected on
// the review page and read again was bought twice and sits on disk once, and
// the card that added the pages up said 4614 while ElevenLabs had been sent
// 4986. So every accepted call writes its own charge onto the job the moment it
// lands, before anything else can rewrite the words it was bought for.
//
// Per call rather than once at the end, for the same reason the mp3 lands per
// page: a worker killed half way through a free key's long afternoon has still
// spent every character it sent, and a ledger that only exists in memory would
// hand the family back a book that looks free.
//
// Never throws and never creates a job: narrateBook is also driven straight
// from a test and from power mode, on a folder with no claim in it at all. A
// note in the margin is not worth losing a book over — the same law appendLog
// lives by.
function bill(dir, chars) {
  try {
    const job = store.readJob(dir);
    if (job) store.writeJob(dir, store.addSpend(job, "narrate", chars));
  } catch (e) {
    console.error("[content-narrate] ledger write failed: " + e.message);
  }
}

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

// {provider, model, voice, pages[{index, audio, words}]}. The three credits are
// the record of what actually spoke, written here because the publish step must
// not read them off the Voice card — a family who changed voices last week
// would have every older book claim the new one. A book narrated by an older
// hub has no credits and says so (nulls), rather than claiming a voice.
function readNarration(dir) {
  const raw = store.readJson(narrationPath(dir));
  if (!raw || !Array.isArray(raw.pages)) return { provider: null, model: null, voice: null, pages: [] };
  return {
    provider: typeof raw.provider === "string" ? raw.provider : null,
    model: typeof raw.model === "string" ? raw.model : null,
    voice: typeof raw.voice === "string" ? raw.voice : null,
    pages: raw.pages.filter(p => p && Number.isInteger(p.index)),
  };
}

// forgetPage(dir, index) — "this page's audio speaks words that are no longer
// on this page." Drops ONE page's entry from narration.json and nothing else.
//
// Rule 2 of this module is "never pay twice": a page with an entry and an mp3 is
// done for ever, and no walk here compares the mp3 against the words it was
// bought for. That is exactly right while the words come off the photos — and
// exactly wrong the moment a grown-up retypes a line on the review page, because
// the book would then be published showing the corrected words while speaking
// (and highlighting) the misread ones, for ever. So the door that changes a
// page's words says so here, and the page publishes SILENT until it is narrated
// again — a shape content-publish.js already handles, and one that costs the
// family nothing on its own.
//
// The mp3 is left where it is: publish reads narration.json and never the audio
// directory, so an orphan file says nothing to anybody, and the next narrate
// walk overwrites it atomically. The book's credits (provider, model, voice)
// stay — they are the record of what spoke the pages that DID keep their audio.
//
// Returns true when something was actually dropped, false when there was
// nothing to drop (no narration yet, or a page it never knew about) — a caller
// on a hot path must not rewrite a file inside the family's Drive folder for
// nothing, because Drive re-uploads every byte of it to every device.
function forgetPage(dir, index) {
  const raw = store.readJson(narrationPath(dir));
  if (!raw || !Array.isArray(raw.pages)) return false;
  const pages = raw.pages.filter(p => !(p && p.index === index));
  if (pages.length === raw.pages.length) return false;
  store.writeAtomic(narrationPath(dir), { ...raw, pages });
  return true;
}

// narrateBook(dir, opts) — narrate every page of `dir` that has text.
//
//   opts.cfg      {apiKey, voiceId, modelId} — for a caller that already has it
//   opts.dataDir  <DATA>, to read the Voice card instead (the worker's way in)
//   opts.only     [index, …] pay again for exactly these pages
//   opts.text     an already-loaded text.json (skips the read)
//   opts.now      pinned clock for the log
//
// Returns {narrated, reused, chars, pages:[{index, audio, words}], errors:[…]},
// where `chars` is what THIS run sent (the book's running total is the job's
// own ledger — store.addSpend, written per call by bill() above), plus
// {skipped:"no-eleven-key"} when there is no key and {permanent:true} when the
// provider refused the key outright.
//
// INTERFACE NOTE for the wiring task (T2.4/T2.8): the word timings cannot live
// in text.json — that file's schema is fixed at {index, source, text, flags,
// cover} and is the hand-editable interop point. They go in
// .build/narration.json as {pages:[{index, audio, words, said}]}, written
// atomically, which is also what makes rule 2 (never pay twice) possible across
// a crash. The publish step reads it with readNarration(dir) and copies `audio`
// and `words` onto the manifest's pages; a page missing from it — or one whose
// `said` no longer matches its words — publishes silent.
async function narrateBook(dir, opts) {
  const o = opts || {};
  const cfg = o.cfg || (o.dataDir ? aiRoles(o.dataDir).elevenlabs : null);
  if (!cfg || !cfg.apiKey) {
    // Not an error, and deliberately not logged as one: this is the whole
    // free-tier story, and a parent who never bought a voice should not meet a
    // red line in their book's log every single run.
    store.appendLog(dir, "narrate", "no ElevenLabs key - the book will publish with text and no audio", { now: o.now });
    return { skipped: "no-eleven-key", narrated: 0, reused: 0, chars: 0, pages: [], errors: [] };
  }
  const text = o.text || store.readText(dir);
  if (!text) throw new Error("narrate: no text.json in " + path.basename(dir));

  const only = Array.isArray(o.only) ? new Set(o.only) : null;
  const have = new Map(readNarration(dir).pages.map(p => [p.index, p]));
  const out = [];
  const errors = [];
  // The characters THIS run sent, for the caller's summary; the book's running
  // total lives on the job (bill() above) because a run is not a book.
  let narrated = 0, reused = 0, spent = 0, permanent = false;

  // The entry AND the file have to be there for a page to count as narrated: an
  // mp3 someone deleted (or a Drive mirror that never landed) must be re-done,
  // or publish points the reader at a 404 forever.
  const kept = (i) => {
    const d = have.get(i);
    return d && fs.existsSync(path.join(dir, "audio", pad3(i) + ".mp3"))
      ? { index: i, audio: audioRel(i), words: d.words || [], said: d.said } : null;
  };

  let stoppedAt = -1;
  for (let i = 0; i < text.pages.length; i++) {
    const page = text.pages[i];
    // A page with no words is a picture page: silent by design, no call, no
    // entry, and the reader already knows how to show one.
    if (!page.text || !page.text.trim()) { have.delete(page.index); continue; }
    const mp3 = path.join(dir, "audio", pad3(page.index) + ".mp3");
    const done = have.get(page.index);
    // A page whose words were rewritten since it spoke owes a new recording —
    // that is the one page a family WANTS to pay for again. A book narrated by
    // an older hub carries no fingerprint at all, and is never re-narrated for
    // that (those recordings are bought, and for a page nobody edited they are
    // also right), so the test is "there is one AND it disagrees".
    const rewritten = !!done && !!done.said && done.said !== said(page.text);
    const doneOk = !!done && fs.existsSync(mp3) && !rewritten;
    const forced = !!only && only.has(page.index);
    if (doneOk && !forced) {
      // ADOPTION, the same first-sight rule the mirror ledger uses: a page
      // narrated before fingerprints existed takes one now, from the words it is
      // sitting beside. It is NOT re-narrated for it — nothing about what that
      // page says changed just because we started writing it down — but from
      // here on the book is guarded like any other, instead of staying
      // unguarded until every page happens to be narrated again.
      out.push({ index: page.index, audio: audioRel(page.index),
                 words: done.words || [], said: done.said || said(page.text) });
      reused++;
      continue;
    }
    // Asked for one page, and this is not it: leave the others alone rather
    // than quietly spending on them.
    if (only && !forced) continue;
    try {
      const r = await narratePage(page.text, cfg);
      // The provider has been paid by the time it answers, so the ledger is
      // written before anything that could still go wrong here.
      bill(dir, page.text.length);
      spent += page.text.length;
      // The mp3 lands before the entry that points at it, and both land
      // atomically: a torn write here is a page that plays static.
      store.writeAtomic(mp3, r.audio);
      out.push({ index: page.index, audio: audioRel(page.index), words: r.words,
                 said: said(page.text) });
      narrated++;
      store.appendLog(dir, "narrate", "page " + page.index + ": " + r.words.length + " words", { now: o.now });
    } catch (e) {
      const msg = store.redact(e && e.message ? e.message : String(e));
      errors.push(msg);
      store.appendLog(dir, "narrate", "page " + page.index + " failed: " + msg, { now: o.now });
      // A failed attempt leaves the page exactly as it was. If it already had
      // audio (a re-narrate that the provider refused), the old mp3 and its
      // timings stay in the manifest — the book keeps reading aloud, and the
      // family is not billed again for a page they already own.
      const k = kept(page.index);
      if (k) { out.push(k); reused++; }
      // A refused key will refuse every remaining page too. Stop; a transient
      // one only costs this page, and the next run picks it up.
      if (/^permanent:/.test(msg)) { permanent = true; stoppedAt = i; break; }
    }
  }

  // Stopping early must not COST anything. The pages past the break were never
  // looked at, so their entries are still good — carry them through, or the
  // rewrite below would erase timings the family already paid for and the next
  // run would buy them a second time.
  if (stoppedAt >= 0) {
    for (let i = stoppedAt + 1; i < text.pages.length; i++) {
      const p = text.pages[i];
      if (!p.text || !p.text.trim()) continue;
      const k = kept(p.index);
      if (k) { out.push(k); reused++; }
    }
  }

  out.sort((a, b) => a.index - b.index);
  // Written even when nothing changed: it is also the record of which pages are
  // deliberately silent, and publish reads it rather than the audio directory.
  // The voice id is not a secret (it travels in the request URL and sits in
  // tts-config.json already); the key it was called with never comes near here.
  store.writeAtomic(narrationPath(dir), {
    provider: "elevenlabs", model: cfg.modelId || DEFAULT_MODEL_ID, voice: cfg.voiceId,
    pages: out,
  });
  const res = { narrated, reused, chars: spent, pages: out, errors };
  if (permanent) res.permanent = true;
  return res;
}

module.exports = {
  DEFAULT_MODEL_ID, OUTPUT_FORMAT, TIMEOUT_MS,
  elevenBase, pad3, audioRel, narrationPath, readNarration, forgetPage, said,
  narratePage, narrateBook,
};
