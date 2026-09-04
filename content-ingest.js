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
//     and a photo the decoder chokes on is copied through byte for byte as its
//     own page. A page that is merely too big is better than a book that
//     stops. The transcription providers downscale server-side anyway, so
//     nothing downstream depends on this step having succeeded.
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

// What becomes a page. JPEG only, because that is what the decoder that ships
// with the core reads. HEIC (an iPhone's default) needs libheif, which rides in
// the board pack, not the core — those files are named in the log and left
// exactly where the parent put them rather than moved somewhere they look
// handled. Follow-up: lend the ingest step clothing-worker's HEIC path.
const PAGE_EXTS = [".jpg", ".jpeg"];
const OTHER_IMAGE_EXTS = [".heic", ".heif", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"];

const SOURCES = "sources";
const PAGES = "pages";
const STATE = "ingest.json";                 // in .build/, beside job.json

const ext = (f) => path.extname(f).toLowerCase();
const isPage = (f) => PAGE_EXTS.includes(ext(f));
const pageName = (i) => String(i).padStart(3, "0") + ".jpg";

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
// {pages:[{index, source, image, copied}], wrote, copied, skipped}.
function ingest(dir, opts) {
  const o = opts || {};
  const maxDim = o.maxDim || MAX_DIM, quality = o.quality || QUALITY;
  const srcDir = path.join(dir, SOURCES), pageDir = path.join(dir, PAGES);
  const log = (msg) => appendLog(dir, "ingest", msg, { now: o.now });

  // 1. loose photos move into sources/ ------------------------------------
  let loose = [];
  try { loose = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name); }
  catch { return { pages: [], wrote: 0, copied: 0, skipped: true }; }
  const incoming = loose.filter(isPage).sort(naturalCmp);
  const strangers = loose.filter(f => OTHER_IMAGE_EXTS.includes(ext(f)));
  if (strangers.length)
    log(strangers.length + " file(s) left as they are — only JPEG photos become pages: " +
        strangers.slice(0, 8).join(", "));
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
  if (!names.length) return { pages: [], wrote: 0, copied: 0, skipped: true };
  const entries = names.map(name => {
    let taken = null;
    try { taken = exifDate(fs.readFileSync(path.join(srcDir, name))); } catch {}
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
    return { pages: prev.pages, wrote: 0, copied: 0, skipped: true };

  // 4. write the pages -----------------------------------------------------
  fs.mkdirSync(pageDir, { recursive: true });
  const pages = [];
  let wrote = 0, copied = 0;
  ordered.forEach((e, i) => {
    const index = i + 1;
    const src = path.join(srcDir, e.name), out = path.join(pageDir, pageName(index));
    let asIs = false;
    try {
      const img = readJpg(src);                      // decoded + turned the way EXIF says
      writeAtomic(out, encodeJpg(scaleRgba(img, maxDim), quality));
    } catch (err) {
      // A page that is too big beats a book that stops (spec §4.1: "if a decode
      // fails the original is used as the page image and the log says so").
      asIs = true;
      writeAtomic(out, fs.readFileSync(src));
      log("could not open " + e.name + " (" + err.message + ") — kept the original as page " + index);
    }
    asIs ? copied++ : wrote++;
    pages.push({ index, source: SOURCES + "/" + e.name, image: PAGES + "/" + pageName(index), copied: asIs });
  });

  // 5. sweep pages a shorter book no longer has ----------------------------
  for (const f of fs.readdirSync(pageDir)) {
    if (!/^\d{3}\.jpg$/.test(f)) continue;
    if (Number(f.slice(0, 3)) > pages.length) { try { fs.unlinkSync(path.join(pageDir, f)); } catch {} }
  }

  writeAtomic(statePath, { sig, pages });
  log("built " + pages.length + " page(s)" + (copied ? ", " + copied + " kept as the original" : ""));
  return { pages, wrote, copied, skipped: false };
}

module.exports = { ingest, orderPages, naturalCmp, PAGE_EXTS, MAX_DIM, QUALITY };
