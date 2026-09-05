// content-animate.js — step 5, the optional one: a page of the book becomes a
// five-second moving picture (spec §4 step 5, plan T6.2).
//
// This is the ONLY step in the product that spends real dollars per press
// ($0.35 a clip, ai-config.DEFAULT_CLIP_PRICE), so it lives by three rules the
// free steps do not need:
//
//  1. NOTHING HERE EVER STARTS ITSELF. There is no state that owes "animate":
//     content-worker.js keeps it out of the walk table's `owes` column and
//     content.js's scan can therefore never reach it. The only way in is a
//     parent pressing "Animate this book (≈ $x)" on the review page, which
//     posts POST /content/run {step:"animate"} — and content.js refuses that
//     press outright unless a fal key is saved and the book has published.
//  2. NOTHING IS BOUGHT TWICE. A page whose video/NNN.mp4 is already on disk is
//     skipped, so a second press after a failure pays only for what is missing,
//     and a run killed half way resumes rather than starts over. Every accepted
//     submission is written onto the job's ledger the moment fal takes it
//     (store.addSpend, unit: clips), because a worker that dies after the
//     submit has still spent the money.
//  3. THE BOOK GAINS ITS CLIPS AS THEY ARRIVE. content-publish.js is re-run
//     after EVERY clip, so a sixteen-page book animated over half an hour shows
//     moving pictures on page one while page nine is still rendering, and a run
//     that stops half way leaves a book that is whole — just partly still.
//
// A clip that fails is one page's loss and never the book's: the error is
// logged, the walk carries on, and the page publishes as a still picture (which
// is what every page of every book already is). The one thing that stops the
// run is fal REFUSING the key, because the next page would buy the same answer.
//
// WHAT IS SENT, AND WHAT IS NOT. The prompting is ported from the proven Kling
// scripting (Book-Reader/docs/book-ingest-policies.md §"Hero pages" and
// §"Video scripting system" v4/v1, ellie-this-week's book/animate.py): model
// `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`, duration "5", the
// standing negative prompt, one style anchor per book, one motion script per
// page, ≤900 characters, motion verbs only. Upstream a model authors each
// page's script from the art; this hub has no author and must not buy one, so
// it sends the TEMPLATE with the page's energy filled in (ambient / story-beat
// / hero / duel, classified from the page's own words HERE, on this computer)
// and lets Kling read the actors off the image itself. THE FAMILY'S OWN WORDS
// ARE NEVER SENT: the page's text is read only to choose a template, and the
// only thing that travels is the page's photo and a motion script about it.
//
// Test seam: ERA_FAL_URL, the same one the Settings card's probe uses
// (server.js's verifyFalKey). Read FRESH on every call, never captured at load.
// Nothing in tests/ may ever reach the real queue — it bills by the clip.
"use strict";
const fs = require("fs");
const path = require("path");
const store = require("./content-store.js");
const { pagesOf } = require("./content-providers.js");
const { publishBook } = require("./content-publish.js");
const { aiRoles } = require("./ai-config.js");

// The bake-off winner, and the only model this step has ever been proven on
// (policies §"Model verdict": 43/50, style preservation near-perfect, printed
// text still legible, panel boundaries respected — the two things a picture
// book cannot lose).
const MODEL = "fal-ai/kling-video/v2.5-turbo/pro/image-to-video";
// "5" and not "10": ten seconds gives longer motion and a mushy ending, and
// costs twice as much (policies §"Hero pages" 4).
const DURATION = "5";
// The standing list, sent on EVERY page whatever it depicts. Kling's coherence
// budget is per-actor, and without this the last second and a half of a clip
// dissolves characters, merges them, or walks them out of frame.
const NEGATIVE_PROMPT = "characters disappearing, characters dissolving, characters morphing, " +
  "characters merging together, characters leaving the frame, empty scene, extra people appearing, " +
  "objects moving between panels, large white foam, splash filling the screen, style change, " +
  "photorealistic drift, 3D render, blur, distortion, low quality";
// What a confrontation page adds to it (policies §"Hero pages" 3): the failure
// mode there is the loser winning, or the pair leaving the frame mid-tussle.
const DUEL_NEGATIVE = "the loser winning, the winner defeated, no clear outcome, " +
  "characters flying out of frame";
// How often the queue is asked whether a clip is ready, and how long a clip may
// take before it is this page's failure rather than everyone's wait. Kling's
// own five-second renders land inside a couple of minutes; six is the upstream
// deadline and is generous enough that a busy queue is not a lost page.
const POLL_MS = 4000;
const TIMEOUT_MS = 6 * 60 * 1000;
// One submit or one poll. Not the whole clip: that is TIMEOUT_MS above.
const HTTP_MS = 60000;
// A page's photo travels as bytes and comes back as an mp4; both are bounded so
// a wrong URL cannot fill the family's Drive folder.
const MAX_IMAGE = 12 * 1024 * 1024;
const MAX_CLIP = 200 * 1024 * 1024;

// The QUEUE host, which is not the account host the Settings card probes
// (api.fal.ai): fal runs generation through queue.fal.run. One seam covers both
// because a test stands in for the whole of fal.
function falBase() { return process.env.ERA_FAL_URL || "https://queue.fal.run"; }

function pad3(n) { return String(n).padStart(3, "0"); }
function videoRel(index) { return "video/" + pad3(index) + ".mp4"; }

// ------------------------------------------------------------------ the script
//
// Per page: [style anchor] + [the motion beats its energy asks for] + [one
// gentle camera move] + [a defined end state] + [the constraints clause]
// (policies §"Video scripting system" v1, kept for exactly these clauses).

const STYLE_ANCHOR = "Hold this picture-book illustration exactly as it is drawn: same medium, " +
  "same palette, same line quality, same character designs, and keep any printed text and the " +
  "page edges perfectly still.";
const CAMERA = "At most one slow, gentle camera move.";
// A defined end state is what stops Kling improvising through the last second
// and a half (policies §"Video scripting system" v4).
const END_STATE = "In the final moment every character eases back toward its starting pose.";
const CONSTRAINTS = "No new characters, no photorealism or 3D drift, no style change, " +
  "subtle looping-friendly motion.";

// A page whose art depicts a confrontation, chase or escape: the duel template.
const DUEL_WORDS = /\b(fight|fights|fought|fighting|chase[sd]?|chasing|caught|catch|escap\w*|batt\w+|attack\w*|roar\w*|snap(?:ped)?|grab(?:bed)?|pounce[sd]?|wrestl\w+|snatch\w*|swoop\w*|gobble[sd]?|hunt\w*)\b/i;
// A page where the story's own action happens on screen.
const HERO_WORDS = /\b(ran|run[s]?|racing|raced|jump\w*|leap\w*|flew|fly|flies|climb\w*|swam|swim\w*|danc\w+|threw|throw[sn]?|push\w*|pull\w*|shout\w*|splash\w*|slid|slide[sd]?|crash\w*|burst|tumbl\w+|hop(?:ped|s)?|kick\w*|dug|dig[s]?|dive[sd]?|dived|spun|spin[s]?)\b/i;
// A quieter page that still has something happening in it.
const BEAT_WORDS = /\b(walk\w*|open\w*|look\w*|smil\w+|wav\w+|reach\w*|point\w*|turn\w*|sat|sit[s]?|stood|stand[s]?|carr\w+|held|hold[s]?|gave|give[sn]?|took|take[sn]?|ate|eat[s]?|drank|drink[s]?|read|sang|sing[s]?|call\w*|knock\w*|paint\w*|build[s]?|built)\b/i;

// The three motion shapes, in the words the scripting rules use. The one thing
// they all share is the same sentence about everybody who is NOT acting: a
// third scripted performer is what buys last-second entropy.
const HOLD_STILL = "Every other character holds still, breathing in place.";
const BEATS = {
  ambient: "Bring the scene to life with ambient micro-motion only: air, water, leaves, cloth and " +
    "hair drift gently. Every character holds still, breathing in place.",
  "story-beat": "ONE character makes the page's own small movement, once and gently. " + HOLD_STILL,
  hero: "ONE hero character performs the page's action clearly, from start to finish; at most one " +
    "supporting character adds a small motion. " + HOLD_STILL,
  duel: "TWO characters are locked in ONE joint exchange, in three beats: challenge, struggle, then " +
    "a clear winner celebrates while the loser reacts comically with huge surprised eyes and a " +
    "tumble away. The winner is still on screen, celebrating, in the last frame. " + HOLD_STILL,
};

// Which of the four a page is, decided HERE and from the page's own words —
// which are never sent anywhere. A page with no words at all is a picture page:
// ambient is exactly right for it.
function energyOf(text) {
  const s = String(text == null ? "" : text);
  if (DUEL_WORDS.test(s)) return "duel";
  if (HERO_WORDS.test(s)) return "hero";
  if (BEAT_WORDS.test(s)) return "story-beat";
  return "ambient";
}

// scriptFor(page) -> {energy, prompt, negative}. `page` is text.json's own
// shape; only its `text` is looked at, and only to pick a template.
function scriptFor(page) {
  const energy = energyOf(page && page.text);
  const parts = [STYLE_ANCHOR, BEATS[energy], CAMERA, END_STATE, CONSTRAINTS];
  // ≤900 characters is the scripting rules' own ceiling; the templates are well
  // inside it, and the clamp is here so a later edit cannot quietly break it.
  const prompt = parts.join(" ").slice(0, 900);
  const negative = energy === "duel" ? NEGATIVE_PROMPT + ", " + DUEL_NEGATIVE : NEGATIVE_PROMPT;
  return { energy, prompt, negative };
}

// ------------------------------------------------------------------ the quote
//
// THE COST GATE (spec §4 step 5), and it is mandatory: a book that cannot be
// quoted is a book whose button stays disabled. Returns null rather than a
// zero, so "we do not know" can never render as "free".
function quote(pages, perClipPrice) {
  const n = Number(pages), p = Number(perClipPrice);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(p) || p <= 0) return null;
  return { pages: n, perClip: p, total: Math.round(n * p * 100) / 100 };
}

// How many pages of this book already have their clip — what the review page
// turns into "4 of 16 pages have moving pictures", and the only way a parent
// can see that a run did anything (a published book must not start wearing a
// red error line because one optional clip failed).
function animatedCount(dir) {
  let names = [];
  try { names = fs.readdirSync(path.join(dir, "video")); } catch { return 0; }
  let n = 0;
  for (const f of names) {
    if (!/^\d{3}\.mp4$/i.test(f)) continue;
    try { if (fs.statSync(path.join(dir, "video", f)).size > 0) n++; } catch {}
  }
  return n;
}

// ------------------------------------------------------------------- one clip

// The page's own photo, as the request's `image_url`. Upstream hands fal a
// signed URL out of cloud storage; this hub is a laptop on a home network with
// no public address at all, so the bytes travel inline as a data URI (which fal
// documents and accepts). Nothing about the family's disk goes with them.
function dataUri(file) {
  const bytes = fs.readFileSync(file);
  if (!bytes.length) throw new Error("that page's photo is empty");
  if (bytes.length > MAX_IMAGE) throw new Error("that page's photo is too big to animate");
  return "data:image/jpeg;base64," + bytes.toString("base64");
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function ask(url, cfg, opts) {
  return fetch(url, {
    // The key travels as a header and only as a header: a URL ends up in logs,
    // in error bodies and in this module's own return values, and this one is
    // billable.
    headers: { Authorization: "Key " + cfg.apiKey },
    signal: AbortSignal.timeout((opts && opts.httpMs) || HTTP_MS),
  });
}

// animateClip(imageFile, script, cfg, opts) -> Buffer (the mp4)
//
// cfg = {apiKey}. Throws "permanent: …" for a refusal retrying cannot fix (a
// key fal will not take), plain Errors for everything else.
//
// `onCharged` is called — once, before anything else can throw — the moment fal
// accepts the job, because that is the moment the family is committed to the
// clip. See the ledger note in rule 2 of the header.
async function animateClip(imageFile, script, cfg, opts) {
  const o = opts || {};
  const c = cfg || {};
  if (!c.apiKey) throw new Error("permanent: no fal key");
  const body = {
    prompt: script.prompt,
    image_url: dataUri(imageFile),
    duration: DURATION,
    negative_prompt: script.negative,
  };
  const submit = async () => fetch(falBase() + "/" + MODEL, {
    method: "POST",
    headers: { Authorization: "Key " + c.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(o.httpMs || HTTP_MS),
  });
  let r = await submit();
  // Some fal models want "5s" rather than "5"; upstream learned this the hard
  // way and retries once with the suffix rather than losing the page.
  if (r.status === 422) { body.duration = DURATION + "s"; r = await submit(); }
  if (!r.ok) {
    const text = store.redact((await r.text().catch(() => "")).slice(0, 200));
    if (r.status === 401 || r.status === 403)
      throw new Error("permanent: fal did not accept that key (" + r.status + ") " + text);
    throw new Error("fal " + r.status + " " + text);
  }
  const sub = await r.json().catch(() => null);
  if (!sub || !sub.request_id) throw new Error("fal took the job but named no request");
  // ACCEPTED IS BOUGHT. Everything below can still lose the page, and every one
  // of those paths would otherwise unwind past the ledger with fal already
  // rendering (and billing) the clip.
  if (o.onCharged) o.onCharged();
  // fal's OWN queue URLs, used verbatim. A hand-built path breaks for every
  // model with subpaths in its name — which this one has (…/pro/image-to-video).
  const statusUrl = sub.status_url || falBase() + "/" + MODEL + "/requests/" + sub.request_id + "/status";
  const responseUrl = sub.response_url || falBase() + "/" + MODEL + "/requests/" + sub.request_id;

  const pollMs = o.pollMs == null ? POLL_MS : o.pollMs;
  const deadline = Date.now() + (o.timeoutMs || TIMEOUT_MS);
  let ready = false;
  for (let first = true; Date.now() < deadline; first = false) {
    if (!first) await sleep(pollMs);
    const s = await ask(statusUrl, c, o);
    if (s.status === 401 || s.status === 403)
      throw new Error("permanent: fal did not accept that key (" + s.status + ")");
    let state = null;
    // A transient non-JSON body (an empty 502 from the queue's own front door)
    // is a reason to ask again, not to lose a clip that is already paid for.
    try { state = (await s.json()).status; } catch { state = null; }
    if (state === "COMPLETED") { ready = true; break; }
    if (state === "FAILED" || state === "ERROR" || state === "CANCELLED")
      throw new Error("fal could not finish this clip (" + state + ")");
  }
  // Said as itself rather than falling through to "named no video": a queue
  // that is merely slow today is a page to try again, and the next press pays
  // for this page and no other (nothing was written, so nothing is skipped).
  if (!ready) throw new Error("fal did not finish this clip in time");
  const res = await ask(responseUrl, c, o);
  if (!res.ok) throw new Error("fal " + res.status + " asking for the finished clip");
  const j = await res.json().catch(() => null);
  const url = (j && j.video && j.video.url) || (j && j.video_url) || null;
  if (!url) throw new Error("fal finished but named no video");
  // The clip itself comes off fal's own CDN on a signed URL — no key goes with
  // this one, because it does not need one and a URL is not a secret channel.
  const v = await fetch(url, { signal: AbortSignal.timeout(o.clipMs || TIMEOUT_MS) });
  if (!v.ok) throw new Error("the finished clip could not be fetched (" + v.status + ")");
  // Asked BEFORE the body is read: a five-second clip is a few megabytes, and a
  // URL that answers with something else entirely must not be buffered whole
  // into a hub that also has a child's board open on it.
  const said = Number(v.headers.get("content-length"));
  if (Number.isFinite(said) && said > MAX_CLIP)
    throw new Error("the finished clip was implausibly large");
  const buf = Buffer.from(await v.arrayBuffer());
  if (!buf.length) throw new Error("the finished clip was empty");
  if (buf.length > MAX_CLIP) throw new Error("the finished clip was implausibly large");
  return buf;
}

// ------------------------------------------------------------------ one book

// A charge on the job the moment fal takes the work, in the step's own unit:
// CLIPS, not characters (content-store.addSpend's note). Never throws and never
// creates a job — animateBook is also driven straight from a test and from
// power mode, on a folder with no claim in it at all.
function bill(dir) {
  try {
    const job = store.readJob(dir);
    if (job) store.writeJob(dir, store.addSpend(job, "animate", 1));
  } catch (e) {
    console.error("[content-animate] ledger write failed: " + e.message);
  }
}

// animateBook(dir, opts) — a five-second clip for every page of `dir` that has
// not got one.
//
//   opts.cfg      {apiKey, perClipPrice} — for a caller that already has it
//   opts.dataDir  <DATA>, to read the fal card instead (the worker's way in)
//   opts.slug     the book's slug and title, for the re-publish after each clip
//   opts.name
//   opts.only     [index, …] animate exactly these pages, again if need be
//   opts.now      pinned clock for the log
//
// Returns {animated, reused, clips, publishes, pages:[…], errors:[…]}, plus
// {skipped:"no-fal-key"} when there is no key and {permanent:true} when fal
// refused the one there is.
async function animateBook(dir, opts) {
  const o = opts || {};
  const cfg = o.cfg || (o.dataDir ? aiRoles(o.dataDir).fal : null);
  const log = (msg) => store.appendLog(dir, "animate", msg, { now: o.now });
  if (!cfg || !cfg.apiKey) {
    // Not an error and not logged as one: every book in the product is allowed
    // to be a book of still pictures, and most of them will be.
    log("no fal key - this book stays as still pictures");
    return { skipped: "no-fal-key", animated: 0, reused: 0, clips: 0, publishes: 0,
             pages: [], errors: [] };
  }
  let text = null;
  try { text = store.readText(dir); } catch {}
  const words = new Map((((text && text.pages) || [])).map(p => [p.index, p]));
  const only = Array.isArray(o.only) ? new Set(o.only) : null;
  const built = pagesOf(dir).sort((a, b) => a.index - b.index);

  const pages = [], errors = [];
  let animated = 0, reused = 0, clips = 0, publishes = 0, permanent = false;

  for (const b of built) {
    const rel = videoRel(b.index);
    const file = path.join(dir, rel);
    const forced = !!only && only.has(b.index);
    if (only && !forced) continue;
    // ALREADY BOUGHT. The clip on disk is the one the family paid for; a second
    // press must only pay for what is missing.
    let have = 0;
    try { have = fs.statSync(file).size; } catch {}
    if (have > 0 && !forced) { pages.push(rel); reused++; continue; }
    const photo = path.join(dir, b.image);
    try {
      const script = scriptFor(words.get(b.index) || null);
      const mp4 = await animateClip(photo, script, cfg, {
        ...o, onCharged: () => { bill(dir); clips++; },
      });
      store.writeAtomic(file, mp4);
      pages.push(rel);
      animated++;
      log("page " + b.index + ": a " + DURATION + "-second clip (" + script.energy + ")");
      // AFTER EVERY CLIP (spec §4 step 5). The manifest is the only thing the
      // reader reads and `exportedAt` is its cache-bust, so a book animated over
      // half an hour gains its moving pictures page by page instead of all at
      // the end — and a run that stops half way still leaves a whole book.
      try { publishBook(dir, { slug: o.slug, title: o.name }); publishes++; }
      catch (e) { log("page " + b.index + ": published clip, but the manifest was not rewritten: "
                      + store.redact(e.message)); }
    } catch (e) {
      const msg = store.redact(e && e.message ? e.message : String(e));
      errors.push(msg);
      log("page " + b.index + " has no clip: " + msg);
      // A refused key refuses every remaining page too, and each attempt would
      // cost the same nothing-at-all twice over. Everything already made stays.
      if (/^permanent:/.test(msg)) { permanent = true; break; }
    }
  }

  const res = { animated, reused, clips, publishes, pages, errors };
  if (permanent) res.permanent = true;
  return res;
}

module.exports = {
  MODEL, DURATION, NEGATIVE_PROMPT, DUEL_NEGATIVE, POLL_MS, TIMEOUT_MS,
  STYLE_ANCHOR, BEATS, falBase, pad3, videoRel,
  energyOf, scriptFor, quote, animatedCount, dataUri, animateClip, animateBook,
};
