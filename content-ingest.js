// content-ingest.js — step 1 of the book builder (spec §4.1). A parent drops
// the photos of a picture book into their Drive folder, in whatever order the
// phone named them; this turns that pile into the two folders every later step
// reads:
//
//   books/<Title>/sources/       the originals, moved aside untouched
//   books/<Title>/pages/001.jpg  upright, long edge 2048, in reading order
//
// Three rules it is built around:
//
//  1. PURE JS, NO SPAWN. The resize is the hub's own vendored JPEG path
//     (image-util.js over vendor/jpeg-js) — the same one the Clothing Picker
//     has used since 8/31. No ImageMagick, no ffmpeg, no PowerShell: nothing
//     to install on a family's fresh Windows box and nothing to branch on for
//     the QA Linux box (plan Gap 7).
//  2. THE ORIGINAL IS NEVER LOST. Originals are moved, not converted in place,
//     and a JPEG the decoder chokes on is copied through byte for byte as its
//     own page. A page that is merely too big is better than a book that
//     stops. The transcription providers downscale server-side anyway, so
//     nothing downstream depends on this step having succeeded. (A HEIC is the
//     one exception to the copy-through, and only to the copy-through: neither
//     a browser nor a vision provider takes one, so a HEIC that will not open
//     is not made into a page at all — it stays in sources/ and is counted.)
//  3. RE-RUNNABLE. The book is built IN PLACE inside the family's Drive
//     folder, so this step runs again on every scan and on every second
//     device. Unchanged inputs = no writes at all, or Drive would mirror the
//     same twenty megabytes every ten minutes.
//
// No network, no key, no clock beyond mtime: everything here is disk and
// pixels. The step table in content-worker.js calls ingest() and nothing else.
"use strict";
const fs = require("fs");
const path = require("path");
const { readJpg, scaleRgba, encodeJpg, exifDate } = require("./image-util.js");
const { writeAtomic, readJson, appendLog, buildDir } = require("./content-store.js");

// Long edge of a page image. 2048 is the size the vision providers resize to
// anyway, and it still prints and zooms well in the reader.
const MAX_DIM = 2048;
const QUALITY = 85;

// What becomes a page. JPEG, through the vendored jpeg-js path — and, since
// 9/7, HEIC.
//
// HEIC IS NOT AN EDGE CASE, IT IS THE DEFAULT. Every one of the seventeen
// photos dad put in books/ that day was a .HEIC, because that is what an iPhone
// writes. Until this they were "strangers": named in the log, left where they
// were, never paged — while content.js's own photo list (clothing-photos.js
// EXT, which HAS counted HEIC since the Clothing Picker shipped) happily saw
// them, claimed the folder and wrote a job.json. The two lists disagreeing is
// what made a book that was claimed, started, and then quietly built nothing at
// all: seventeen photos, zero pages, a card that said it was reading them.
//
// The decoder is clothing-worker's: libheif, which rides in the BOARD pack
// (packs.js), not the core. A hub without it must say so and stop — see
// NO_DECODER below — rather than build a book with the HEIC pages missing and
// freeze that loss into the manifest.
const PAGE_EXTS = [".jpg", ".jpeg"];
const HEIC_EXTS = [".heic", ".heif"];
const PAGEABLE_EXTS = PAGE_EXTS.concat(HEIC_EXTS);
// Still nothing we can open: the hub ships no PNG or WebP decoder. Named in the
// log and left alone, exactly as HEIC used to be.
const OTHER_IMAGE_EXTS = [".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"];

// The two holds this step can park a book on. A hold keeps the claim, the
// state and every byte already built (content-worker.js), and — unlike walking
// on with nothing — it gives /content/status a WORD the Settings card and the
// Book Reader's shelf can turn into a sentence a parent can act on.
const NO_DECODER = "needs-photo-decoder";   // iPhone HEIC, and no board pack
const UNREADABLE = "unreadable-photos";     // files we have no decoder for at all

const SOURCES = "sources";
const PAGES = "pages";
const STATE = "ingest.json";                 // in .build/, beside job.json
// The one .jpg in the book root that is NOT a photo a parent dropped in: the
// publish step writes it there (content-publish.COVER) from page 1's bytes. It
// is our own output, so taking it in would make it page 1 on the next run and
// shift every page index by one — orphaning every text.json entry and every
// audio/NNN.mp3, and stealing the shelf's cover off the disk while it was at it.
const OURS = ["cover.jpg"];

const ext = (f) => path.extname(f).toLowerCase();
const isPage = (f) => PAGEABLE_EXTS.includes(ext(f));
const isHeic = (f) => HEIC_EXTS.includes(ext(f));
const pageName = (i) => String(i).padStart(3, "0") + ".jpg";

// libheif, loaded ONCE and only when a HEIC actually turns up (the same deal
// clothing-worker.js:138 makes with it). It is ~2 MB of wasm in the board pack;
// a family that installed the Book Reader on its own does not have it, and
// asking is how we find out.
let libheif = null, askedHeif = false;
function heifReady() {
  if (!askedHeif) {
    askedHeif = true;
    try { libheif = require("./vendor/libheif.js")(); } catch { libheif = null; }
  }
  return !!libheif;
}

// One HEIC to RGBA. Lifted from clothing-worker.readImageRgba, which has been
// opening this family's photos since 8/31 — same decoder, same call, same
// free(). libheif applies the phone's irot/imir itself, so a HEIC arrives
// upright and image-orient.js has nothing to do to it.
function decodeHeic(buf) {
  const images = new libheif.HeifDecoder().decode(buf);
  if (!images.length) throw new Error("there is no image inside this HEIC");
  const im = images[0];
  const w = im.get_width(), h = im.get_height();
  return new Promise((resolve, reject) => {
    im.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, (d) => {
      im.free();
      d ? resolve({ data: Buffer.from(d.data.buffer), width: w, height: h })
        : reject(new Error("this HEIC could not be opened"));
    });
  });
}

// A source photo, decoded and upright, whatever the phone wrote.
// Both hops go through module.exports, the way content.js reaches its worker:
// a test can stand in for the decoder (there is no HEIC encoder anywhere in the
// suite, so a synthetic .heic fixture cannot be built) without a real photo of
// a real family's book ever coming near a test.
async function readPage(file) {
  if (isHeic(file)) return module.exports.decodeHeic(fs.readFileSync(file));
  return readJpg(file);                       // decoded + turned the way EXIF says
}

// "img2" before "img10": a phone numbers its shots without padding, and a
// plain string sort would put page 10 second. Digit runs compare as numbers,
// everything else compares as lower-case text.
function naturalCmp(a, b) {
  const re = /(\d+)|(\D+)/g;
  const A = String(a).toLowerCase().match(re) || [], B = String(b).toLowerCase().match(re) || [];
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const x = A[i], y = B[i];
    const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return A.length - B.length;
}

// Reading order for [{name, taken}] where `taken` is an EXIF timestamp in ms or
// null. When EVERY photo carries a timestamp the shots are ordered by when they
// were taken (spec §4.1) — that survives a camera that restarts its numbering
// mid-book. The moment one is missing the whole book falls back to filename
// order: a book half in shot order and half in name order is worse than one
// consistently in the order the parent can see in their file browser.
// Pure — no disk, no clock — so the rule can be tested on its own.
function orderPages(entries) {
  const list = entries.slice();
  const dated = list.length > 0 && list.every(e => typeof e.taken === "number" && Number.isFinite(e.taken));
  list.sort((a, b) => (dated ? (a.taken - b.taken) : 0) || naturalCmp(a.name, b.name));
  return list;
}

// A free name inside sources/. Two phones both call their shot "IMG_0001.jpg";
// neither may overwrite the other (that is a lost page of a book that only
// exists on paper).
function freeName(dir, name) {
  const e = path.extname(name), base = path.basename(name, e);
  if (!fs.existsSync(path.join(dir, name))) return name;
  for (let n = 2; n < 1000; n++) {
    const alt = base + "-" + n + e;
    if (!fs.existsSync(path.join(dir, alt))) return alt;
  }
  return base + "-" + Date.now() + e;
}

// Move, falling back to copy+unlink: sources/ and the loose photo can sit on
// different volumes once a parent points the hub at a mapped drive.
function moveIn(from, to) {
  try { fs.renameSync(from, to); }
  catch { fs.copyFileSync(from, to); fs.unlinkSync(from); }
}

// Everything about the inputs that could change the outputs: name, size, mtime
// (a re-shot page keeps its name), plus the two knobs. Cheap enough to compute
// on every scan; a hash of twenty photos is not.
function signature(dir, names, maxDim, quality) {
  const parts = names.map(n => {
    let s = { size: -1, mtimeMs: -1 };
    try { s = fs.statSync(path.join(dir, SOURCES, n)); } catch {}
    return [n, s.size, Math.round(s.mtimeMs)];
  });
  return JSON.stringify({ v: 1, maxDim, quality, parts });
}

// The step. `dir` is the book folder. Returns
// {pages:[{index, source, image, copied}], wrote, copied, lost, skipped}, or
// {hold} for the two things a parent has to fix before there can be any pages
// at all (NO_DECODER / UNREADABLE above).
//
// ASYNC since 9/7: libheif hands its pixels back through a callback, so opening
// an iPhone photo cannot be done on the way past. content-worker.js awaits every
// step's result and always did, so nothing above this had to change.
async function ingest(dir, opts) {
  const o = opts || {};
  const maxDim = o.maxDim || MAX_DIM, quality = o.quality || QUALITY;
  const srcDir = path.join(dir, SOURCES), pageDir = path.join(dir, PAGES);
  const log = (msg) => appendLog(dir, "ingest", msg, { now: o.now });

  // 1. loose photos move into sources/ ------------------------------------
  let loose = [];
  try { loose = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name); }
  catch { return { pages: [], wrote: 0, copied: 0, skipped: true }; }
  const incoming = loose.filter(f => isPage(f) && !OURS.includes(f.toLowerCase())).sort(naturalCmp);
  const strangers = loose.filter(f => OTHER_IMAGE_EXTS.includes(ext(f)));
  if (strangers.length)
    log(strangers.length + " file(s) left as they are — a page has to be a JPEG or an "
        + "iPhone photo (HEIC): " + strangers.slice(0, 8).join(", "));
  if (incoming.length) {
    fs.mkdirSync(srcDir, { recursive: true });
    for (const f of incoming) {
      const name = freeName(srcDir, f);
      if (name !== f) log("two photos are called " + f + "; the newcomer is kept as " + name);
      moveIn(path.join(dir, f), path.join(srcDir, name));
    }
    log("took in " + incoming.length + " photo(s)");
  }

  // 2. reading order -------------------------------------------------------
  let names = [];
  try { names = fs.readdirSync(srcDir).filter(isPage); } catch { names = []; }
  if (!names.length) {
    // A folder of files we have no decoder for is not an empty folder, and the
    // difference matters: one is a parent who has not finished uploading, the
    // other is a parent who has finished and will never see a book. Walking on
    // from here published nothing and said nothing (dad 9/7).
    if (strangers.length) {
      log("nothing here can be made into a page yet");
      return { hold: UNREADABLE, strangers: strangers.slice(0, 8),
               pages: [], wrote: 0, copied: 0, lost: 0, skipped: true };
    }
    return { pages: [], wrote: 0, copied: 0, lost: 0, skipped: true };
  }
  // THE DECODER HAS TO BE THERE BEFORE THE FIRST PAGE IS WRITTEN. libheif is in
  // the board pack; a hub that has the Book Reader and not the Board cannot open
  // an iPhone photo at all. Building the JPEGs anyway and leaving the HEICs out
  // would publish a book with pages missing and freeze that into the manifest —
  // so the whole book waits, keeping every photo, and the card says which pack
  // to add (or to re-save the photos as JPEG).
  if (names.some(isHeic) && !module.exports.heifReady()) {
    const heics = names.filter(isHeic);
    log(heics.length + " iPhone photo(s) (HEIC) and no photo decoder installed — "
        + "the book is waiting rather than leaving those pages out");
    return { hold: NO_DECODER, strangers: heics.slice(0, 8),
             pages: [], wrote: 0, copied: 0, lost: 0, skipped: true };
  }
  const entries = names.map(name => {
    let taken = null;
    // Only a JPEG carries the APP1 block exifDate reads, and a phone's HEIC is
    // several megabytes: reading seventeen of them to find nothing is a whole
    // album off the disk for no answer. A book of HEICs orders by filename,
    // which for IMG_0001…IMG_0017 is the order they were taken in anyway.
    if (!isHeic(name)) { try { taken = exifDate(fs.readFileSync(path.join(srcDir, name))); } catch {} }
    return { name, taken };
  });
  const ordered = orderPages(entries);
  if (!ordered.every(e => typeof e.taken === "number"))
    log("some photos carry no date taken — using filename order");

  // 3. nothing changed? do nothing ----------------------------------------
  const sig = signature(dir, ordered.map(e => e.name), maxDim, quality);
  const statePath = path.join(buildDir(dir), STATE);
  const prev = readJson(statePath);
  const built = (p) => { try { return fs.statSync(path.join(dir, p)).size > 0; } catch { return false; } };
  if (prev && prev.sig === sig && Array.isArray(prev.pages) && prev.pages.every(p => built(p.image)))
    return { pages: prev.pages, wrote: 0, copied: 0, lost: 0, skipped: true };

  // 4. write the pages -----------------------------------------------------
  //
  // A PAGE NUMBER IS A PLACE IN THE BOOK, NOT A COUNT OF WHAT WORKED. Every
  // step after this one is keyed by the index written here: text.json's entries
  // (content-providers.js reuses the words stored against a page rather than
  // paying to read it twice), audio/NNN.mp3 (content-narrate.js), and the
  // manifest that pairs the three (content-publish.js). So the numbering has to
  // be a function of the SOURCE SET and nothing else — if it also depended on
  // which photos happened to DECODE, then one iPhone photo that would not open
  // this time (a half-synced file, a decoder that was not there) would shift
  // every page after it down by one, and the next pass would put page 4's words
  // and page 4's paid-for narration under page 5's picture: Ellie sees one page
  // and hears another, silently and for good. Numbering by position leaves a
  // GAP where a lost photo would have been, and the sweep below is written in
  // terms of the pages that exist rather than how many there are.
  fs.mkdirSync(pageDir, { recursive: true });
  const pages = [];
  let wrote = 0, copied = 0, lost = 0, at = 0;
  for (const e of ordered) {
    const index = ++at;                              // its place in `ordered`, whatever happens below
    const src = path.join(srcDir, e.name), out = path.join(pageDir, pageName(index));
    let asIs = false;
    try {
      const img = await readPage(src);               // decoded + upright, JPEG or HEIC
      writeAtomic(out, encodeJpg(scaleRgba(img, maxDim), quality));
    } catch (err) {
      // A HEIC IS NOT COPIED THROUGH. The fallback below hands the original's
      // bytes over as the page image, which works for a JPEG the decoder choked
      // on (every browser and every vision provider still reads it) and is a
      // dead end for a HEIC: the reader shows a broken image and the provider
      // refuses the upload. So a HEIC we cannot open is not a page at all — it
      // is said in the log, counted in `lost`, and the rest of the book is
      // built rather than stopped.
      if (isHeic(e.name)) {
        lost++;
        log("could not open " + e.name + " (" + err.message + ") — it is not a page of this book");
        continue;
      }
      // A page that is too big beats a book that stops (spec §4.1: "if a decode
      // fails the original is used as the page image and the log says so").
      asIs = true;
      writeAtomic(out, fs.readFileSync(src));
      log("could not open " + e.name + " (" + err.message + ") — kept the original as page " + index);
    }
    asIs ? copied++ : wrote++;
    pages.push({ index, source: SOURCES + "/" + e.name, image: PAGES + "/" + pageName(index), copied: asIs });
  }

  // 5. sweep pages this book no longer has ---------------------------------
  // By NUMBER, not by count: the numbering above leaves a gap where a photo
  // could not be opened, so "anything past the end" would have deleted the last
  // real page of the book every time one was lost.
  const kept = new Set(pages.map(p => p.index));
  for (const f of fs.readdirSync(pageDir)) {
    if (!/^\d{3}\.jpg$/.test(f)) continue;
    if (!kept.has(Number(f.slice(0, 3)))) { try { fs.unlinkSync(path.join(pageDir, f)); } catch {} }
  }

  // EVERY photo failed to open, and they were all HEICs the decoder is there
  // for: that is a folder of files that are not really photos, not a book. Hold
  // rather than write an ingest.json saying this book has no pages — the state
  // would then be "built, nothing in it" for ever.
  if (!pages.length)
    return { hold: UNREADABLE, strangers: ordered.slice(0, 8).map(e => e.name),
             pages: [], wrote: 0, copied: 0, lost, skipped: true };

  writeAtomic(statePath, { sig, pages });
  log("built " + pages.length + " page(s)" + (copied ? ", " + copied + " kept as the original" : "")
      + (lost ? ", " + lost + " photo(s) could not be opened at all" : ""));
  return { pages, wrote, copied, lost, skipped: false };
}

module.exports = { ingest, orderPages, naturalCmp, heifReady, decodeHeic,
                   PAGE_EXTS, HEIC_EXTS, PAGEABLE_EXTS, OTHER_IMAGE_EXTS,
                   NO_DECODER, UNREADABLE, MAX_DIM, QUALITY };
