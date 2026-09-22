// clothing-worker.js — the Clothing Picker pipeline, run in a worker thread
// (dad 8/31: the pixel work on the main thread froze every hub page — even
// Settings' "Back to apps" — for minutes while photos converted). clothing.js
// is the thin shell that spawns this per run; progress flows back as messages.
//
//  INGEST (needs the family's AI key, once per new photo): name / categorize
//  (top/pants/shorts/dress/set) / warmth / upright / crop via a small vision
//  model -> data/wardrobe.json + one clean square tile per item.
//  DAILY GENERATION (no AI, pure local — same as Ellie's runs today):
//  weather -> suitable items -> novel least-recently-shown combos ->
//  composites -> her exact board graph (today -> confirm_N -> cat_* -> build).
//  NO CATALOG YET -> no board at all: a {guidance} result tells the board's
//  splash to coach the next step (add key / add photos), instead of the old
//  raw "This one" photo tiles (dad 8/31: novices need to be walked through).
"use strict";
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const segment = require("./segment.js");
const { exifOrientation, rotateRgba, upright } = require("./image-orient.js");
const { aiRoles } = require("./ai-config.js");

// Bring-your-own key, any of the big three (dad 8/30: "preferred LLM").
// Account LOGIN is not offered because the providers forbid it for
// third-party products (Anthropic's credential-use policy is explicit);
// keys are the sanctioned path. Cheapest vision model per provider, one
// call per new photo. ERA_AI_URL overrides every base URL (test seam).
// Each provider carries a LIST of models, tried in order. Model availability
// is not static: a hardcoded id 404s for new accounts, a -latest alias can be
// rate-limited (429) for hours while a sibling answers instantly — both seen
// live on the family's own free key (QA 9/1). The first model that answers
// wins and is remembered for the rest of the run.
const PROVIDERS = {
  anthropic: { base: "https://api.anthropic.com",
    models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"] },
  openai: { base: "https://api.openai.com",
    models: ["gpt-5-mini", "gpt-4o-mini"] },
  google: { base: "https://generativelanguage.googleapis.com",
    // gemini-2.5-flash is gone for accounts created now ("no longer available
    // to new users") — keeping it only spent a request per photo (9/2)
    // Google's free tier is 20 requests per day PER MODEL (429 body 9/2:
    // GenerateRequestsPerDayPerProjectPerModel-FreeTier = 20), so every model
    // listed here is another 20 photos a day for a family on a free key.
    models: ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-3.5-flash-lite"] },
};
let chosenModel = null;   // sticky once a model answers
const spentModels = new Set();   // models whose daily allowance is gone

const DATA = workerData.dataDir;
let ingesting = null; // {done, total} while naming photos — relayed to the shell

const CLOTHING = () => path.join(DATA, "clothing");
// Photos as paths relative to clothing/, subfolders included: a family that
// drops a whole album folder into Drive's clothing/ (QA 9/2 — Settings said
// "15 new", the board said "No content yet") must get a board like anyone else.
const { listPhotos, photoSet, PHOTOSET_FILE } = require("./clothing-photos");
const { dayKey, buildCandidates, toWorkerShape, attributes, accessoryOrder,
        GARMENT_KINDS, ACCESSORY_KINDS, CATEGORIES, OCCASIONS } = require("./clothing-rank.js");
const { openLog, mergeHistory } = require("./clothing-log.js");
// The family's day, in the family's zone — the stamp every "we have already
// asked about this garment" marker carries (spec §3.2, plan A4-5/A4-8).
const todayKey = () => dayKey(Date.now(), workerData.tz);

// ---- the family's shared taste (clothing-log.js, spec §5) ------------------
// The Drive folder and this device's name are resolved by the SHELL at spawn
// (plan W10): a drive.js of its own in here would read the config behind the
// main thread's back and arm a second set of sync timers. Both the log and the
// merged read are made once per build and reused — ingest and the deal want
// the same answer, and the mirror does not change under one run.
let sharedLog = null, mergedLog = null;
function log() {
  if (!sharedLog) sharedLog = openLog({ dataDir: DATA, driveFolder: workerData.driveFolder,
                                        deviceId: workerData.deviceId, tz: workerData.tz });
  return sharedLog;
}
function shared() {
  if (!mergedLog) mergedLog = log().readMerged(todayKey());
  return mergedLog;
}
const WEB = () => path.join(DATA, "clothing-web");
const ITEMS = () => path.join(DATA, "wardrobe-items");
// Is this item's picture actually on disk? A catalogue entry alone is not
// enough to draw anything (QA 9/2).
function hasTile(id) {
  try { return fs.statSync(path.join(ITEMS(), id + ".jpg")).size > 0; } catch { return false; }
}
const OUTFITS = () => path.join(DATA, "wardrobe-outfits");
const CATALOG = () => path.join(DATA, "wardrobe.json");
const RECIPES = () => path.join(DATA, "recipes");

// One reader for every key the hub holds (ai-config.js), so the flat
// {provider, apiKey} file and the role-keyed one both keep working here.
function aiCfg() { return aiRoles(DATA).vision; }
function aiKey() { const c = aiCfg(); return c ? c.apiKey : ""; }
function loadCatalog() {
  try { return JSON.parse(fs.readFileSync(CATALOG(), "utf8")); } catch { return { items: {} }; }
}
function saveCatalog(c) { fs.writeFileSync(CATALOG(), JSON.stringify(c, null, 1)); }
// The deal's memory (which looks led page 1 on which day, her Yeses) is
// wardrobe/history.json {days, events} — the shell writes it (A4-1), this
// thread only reads it. A file that is not there yet is simply no memory. A
// file that IS there and will not open is not: dealing "no memory" gives her a
// board with no staples, no yesterday bar and no freshness — and the shell's
// recorder throws on the same bytes, so the day is never recorded either,
// while recipes/today.json is rewritten and that board then STANDS as the
// day's work. So: retry the read (a backup or a scanner holds a 5 KB file for
// milliseconds), and if it still will not come, tell the shell (r3).
const HISTORY = () => path.join(DATA, "wardrobe", "history.json");
const READ_TRIES = 3, READ_WAIT_MS = 100;
let historyUnread = false;   // this build dealt without her memory
function napMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function readHistory() {
  for (let tryN = 1; ; tryN++) {
    let raw;
    try { raw = fs.readFileSync(HISTORY(), "utf8"); }
    catch (e) {
      if (e.code === "ENOENT") return {};        // no memory yet: the first build makes it
      if (tryN < READ_TRIES) { napMs(READ_WAIT_MS); continue; }
      historyUnread = true;
      console.error("[clothing] history.json would not open (" + e.code + ") — dealing without her memory");
      return {};
    }
    // Same shape contract as the shell's reader (clothing.js): a plain object,
    // or no memory. An array is neither (review r1). Bytes that will not parse
    // are the shell's to set aside, not this thread's to write.
    try { const h = JSON.parse(raw); return h && typeof h === "object" && !Array.isArray(h) ? h : {}; }
    catch { return {}; }
  }
}

// ---- image plumbing (vendored decoders; RGBA in Buffers throughout) ----
// The JPEG half (decode / upright / scale / encode) lives in image-util.js now
// that the book ingest step needs exactly the same four operations — one
// resampler, one place a sideways photo can hide. What stays here is what is
// the Clothing Picker's alone: HEIC (libheif ships in the board pack, packs.js,
// and is loaded only when a HEIC actually turns up), cropping, padding and the
// background flood.
let libheif = null;
function ensureHeif() {
  if (!libheif) libheif = require("./vendor/libheif.js")();
}
const { decodeJpg, scaleRgba, writeJpg } = require("./image-util.js");

function cropRgba(img, frac) {
  const { data, width: w, height: h } = img;
  let x0 = Math.max(0, Math.floor((frac.x || 0) * w)), y0 = Math.max(0, Math.floor((frac.y || 0) * h));
  let cw = Math.min(w - x0, Math.ceil((frac.w || 1) * w)), ch = Math.min(h - y0, Math.ceil((frac.h || 1) * h));
  if (cw < 40 || ch < 40) { x0 = 0; y0 = 0; cw = w; ch = h; }
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++)
    data.copy(out, y * cw * 4, ((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4);
  return { data: out, width: cw, height: ch };
}

// scale to fit inside dim with a small margin, centered on white
function padSquare(img, dim) {
  const s = scaleRgba(img, dim - 24);
  const out = Buffer.alloc(dim * dim * 4, 255);
  const ox = Math.floor((dim - s.width) / 2), oy = Math.floor((dim - s.height) / 2);
  for (let y = 0; y < s.height; y++)
    s.data.copy(out, ((oy + y) * dim + ox) * 4, y * s.width * 4, (y + 1) * s.width * 4);
  return { data: out, width: dim, height: dim };
}

function readImageRgba(file, bytes) {
  const buf = bytes || fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  if ([".heic", ".heif"].includes(ext)) {
    ensureHeif();
    const images = new libheif.HeifDecoder().decode(buf);
    if (!images.length) throw new Error("no image in heic");
    const im = images[0];
    const w = im.get_width(), h = im.get_height();
    return new Promise((resolve, reject) => {
      im.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, (d) => {
        im.free();
        d ? resolve({ data: Buffer.from(d.data.buffer), width: w, height: h })
          : reject(new Error("heic decode failed"));
      });
    });
  }
  // jpeg-js hands back the sensor's pixels; turn them the way the phone's
  // EXIF Orientation says (image-orient.js). libheif already does this for HEIC.
  return Promise.resolve(upright(decodeJpg(buf, { maxMemoryUsageInMB: 1024 }), exifOrientation(buf)));
}

// Orientation a JPEG on disk carries (1 = none); HEIC/others report 1
// because their decoder already turns them.
function photoOrientation(file, bytes) {
  if (![".jpg", ".jpeg"].includes(path.extname(file).toLowerCase())) return 1;
  try { return exifOrientation(bytes || fs.readFileSync(file)); } catch { return 1; }
}

// Composites follow Ellie's generator exactly (outfit_set.py fit/compose):
// crop each photo to the garment (strip white margins), scale to nearly FILL
// its half (pad 6), 840x560 landscape, top LEFT / bottom RIGHT. Dad 9/1: the
// old version scaled the padded photo, so tall narrow bottoms looked tiny.
// Trim to the garment (dad: "it trimmed every image"). Ellie's photos are
// laid on floors and tables, not white sweeps, so a white-margin test finds
// nothing (QA 9/1: every tile showed wood floor). Instead: sample the frame
// border to learn the background colour, then shrink to the box of pixels
// that differ from it. Falls back to the whole image when the garment fills
// the frame or the background is not uniform.
// Background REMOVAL, not just cropping (dad 9/1: "no trim was performed" —
// his tiles showed the wood floor while Ellie's tablet shows garments cut out
// on white). Her pipeline uses rembg/u2netp in Python; we have neither Python
// nor a model here, so: flood the background inward from the frame border,
// growing region-by-region so a wood grain's gradual variation is followed
// while the garment's hard edge stops it. Everything reached from the border
// becomes white; the garment (never border-connected) survives untouched.
function removeBackground(img) {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const NEAR = 30;      // max per-channel step between touching pixels
  const SEED = 74;      // max drift from a seed colour
  const bg = new Uint8Array(n);
  const border = [];
  for (let x = 0; x < w; x++) { border.push(x); border.push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { border.push(y * w); border.push(y * w + w - 1); }

  const close = (a, b, lim) =>
    Math.abs(data[a] - data[b]) <= lim &&
    Math.abs(data[a + 1] - data[b + 1]) <= lim &&
    Math.abs(data[a + 2] - data[b + 2]) <= lim;

  // Floors are rarely one tone (pale board + dark grain), so flood in PASSES:
  // each pass re-seeds from the border pixels still unclaimed. Two tones of
  // wood used to survive as slabs beside the garment (QA 9/1).
  for (let pass = 0; pass < 3; pass++) {
    const rest = border.filter(i => !bg[i]);
    if (!rest.length) break;
    const med = [0, 1, 2].map(c => {
      const v = rest.map(i => data[i * 4 + c]).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)];
    });
    const nearSeed = (o) =>
      Math.abs(data[o] - med[0]) <= SEED &&
      Math.abs(data[o + 1] - med[1]) <= SEED &&
      Math.abs(data[o + 2] - med[2]) <= SEED;
    const stack = [];
    for (const i of rest) if (nearSeed(i * 4)) { bg[i] = 1; stack.push(i); }
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0, o = i * 4;
      const step = (j) => {
        if (bg[j]) return;
        const oj = j * 4;
        if (close(o, oj, NEAR) && nearSeed(oj)) { bg[j] = 1; stack.push(j); }
      };
      if (x > 0) step(i - 1);
      if (x < w - 1) step(i + 1);
      if (y > 0) step(i - w);
      if (y < h - 1) step(i + w);
    }
  }

  let painted = 0;
  for (let i = 0; i < n; i++) if (bg[i]) painted++;
  // Too little removed = we never found the background. Too much = the flood
  // walked INTO a garment whose colour matches the floor (mint shorts, QA 9/1)
  // and would hand a child a shredded picture. Either way, don't touch it.
  if (painted < n * 0.05 || painted > n * 0.88) return img;

  // keep the largest surviving blob — the garment (her keep_largest_blob)
  const label = new Int32Array(n).fill(-1);
  let best = -1, bestSize = 0, cur = 0, kept = 0;
  const q = [];
  for (let i = 0; i < n; i++) {
    if (bg[i] || label[i] !== -1) continue;
    let size = 0; q.length = 0; q.push(i); label[i] = cur;
    while (q.length) {
      const j = q.pop(); size++;
      const x = j % w, y = (j / w) | 0;
      const visit = (k) => { if (!bg[k] && label[k] === -1) { label[k] = cur; q.push(k); } };
      if (x > 0) visit(j - 1);
      if (x < w - 1) visit(j + 1);
      if (y > 0) visit(j - w);
      if (y < h - 1) visit(j + w);
    }
    kept += size;
    if (size > bestSize) { bestSize = size; best = cur; }
    cur++;
  }
  // A garment survives as ONE piece. If the biggest blob is only a fraction of
  // what remains, the flood shredded it — leave the photo alone.
  if (!kept || bestSize / kept < 0.60) return img;
  if (bestSize < n * 0.04) return img;
  // Shape check: a garment is a solid shape, so its outline is short relative
  // to its area. A flood that walked into fabric leaves a lace-like fringe with
  // an enormous perimeter (the mint shorts, QA 9/1) — refuse those outright.
  let perim = 0;
  for (let i = 0; i < n; i++) {
    if (bg[i] || label[i] !== best) continue;
    const x = i % w, y = (i / w) | 0;
    if (x === 0 || x === w - 1 || y === 0 || y === h - 1 ||
        bg[i - 1] || bg[i + 1] || bg[i - w] || bg[i + w] ||
        label[i - 1] !== best || label[i + 1] !== best ||
        label[i - w] !== best || label[i + w] !== best) perim++;
  }
  const compactness = perim / (2 * Math.sqrt(Math.PI * bestSize));
  if (compactness > 2.6) return img;

  const out = Buffer.from(data);
  for (let i = 0; i < n; i++) {
    if (!bg[i] && label[i] === best) continue;
    const o = i * 4;
    out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = 255;
  }
  return { data: out, width: w, height: h };
}

// `tol`/`need` default to a real photo's floor: a row or column is garment
// only when a clear 2% of its pixels differ from the border colour by more
// than 34 a channel. On a CUT-OUT or a tile the background is pure white and
// the garment's thinnest parts — a pale cuff, a sleeve tie, a strap — are a
// handful of pixels a column; the photo thresholds threw those away and the
// leopard top lost its sleeves below the elbow (dad 9/3: "over trimmed
// shirt"). WHITE_BG is the setting for that case: anything visibly off-white,
// two samples a line, is garment.
const WHITE_BG = { tol: 14, need: 2 };
function cropToContent(img, tol, need_) {
  const { data, width: w, height: h } = img;
  const T = tol || 34;
  // background = median-ish sample of the outer 3% frame
  const px = [];
  const m = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  for (let x = 0; x < w; x += 3) {
    for (const y of [0, 1, h - 2, h - 1]) px.push((y * w + x) * 4);
  }
  for (let y = 0; y < h; y += 3) {
    for (const x of [0, 1, w - 2, w - 1]) px.push((y * w + x) * 4);
  }
  const chan = (o) => [data[o], data[o + 1], data[o + 2]];
  const med = [0, 1, 2].map((c) => {
    const v = px.map((o) => data[o + c]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  });
  const differs = (o) => {
    const [r, g, b] = chan(o);
    return Math.abs(r - med[0]) + Math.abs(g - med[1]) + Math.abs(b - med[2]) > T * 3;
  };
  // a row/column counts as garment when enough of its pixels differ
  const need = need_ || Math.max(3, Math.round(Math.min(w, h) * 0.02));
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x += 2) if (differs((y * w + x) * 4)) n++;
    if (n >= need) { if (y < y0) y0 = y; y1 = y; }
  }
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y += 2) if (differs((y * w + x) * 4)) n++;
    if (n >= need) { if (x < x0) x0 = x; x1 = x; }
  }
  if (x1 < 0 || y1 < 0) return img;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  if (cw < w * 0.15 || ch < h * 0.15) return img;   // implausible: keep all
  const pad = Math.round(Math.min(cw, ch) * 0.02);
  return cropRgba(img, {
    x: Math.max(0, x0 - pad) / w, y: Math.max(0, y0 - pad) / h,
    w: Math.min(w, cw + 2 * pad) / w, h: Math.min(h, ch + 2 * pad) / h });
}

function fitBox(img, boxW, boxH) {
  const pad = 6;
  const im = cropToContent(img, WHITE_BG.tol, WHITE_BG.need);   // a tile: garment on white
  const scale = Math.min((boxW - 2 * pad) / im.width, (boxH - 2 * pad) / im.height);
  const nw = Math.max(1, Math.round(im.width * scale)), nh = Math.max(1, Math.round(im.height * scale));
  const scaled = exactScale(im, nw, nh);
  const out = Buffer.alloc(boxW * boxH * 4, 255);
  const ox = Math.floor((boxW - nw) / 2), oy = Math.floor((boxH - nh) / 2);
  for (let y = 0; y < nh; y++)
    scaled.data.copy(out, ((oy + y) * boxW + ox) * 4, y * nw * 4, (y + 1) * nw * 4);
  return { data: out, width: boxW, height: boxH };
}

function exactScale(img, nw, nh) {
  const { data, width: w, height: h } = img;
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(y * h / nh));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(x * w / nw));
      const si = (sy * w + sx) * 4, di = (y * nw + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh };
}

function composite(fileA, fileB, dest) {
  const W = 840, H = 560;
  const out = { data: Buffer.alloc(W * H * 4, 255), width: W, height: H };
  const place = (file, ox, boxW) => {
    const f = fitBox(decodeJpg(fs.readFileSync(file)), boxW, H);
    for (let y = 0; y < H; y++)
      f.data.copy(out.data, (y * W + ox) * 4, y * boxW * 4, (y + 1) * boxW * 4);
  };
  if (fileB) { place(fileA, 0, 420); place(fileB, 420, 420); }
  else place(fileA, 0, 840);
  writeJpg(out, dest, 88);
}

// ---- ingest: one small vision call per new photo ----
// Orientation is asked as WHERE the garment's top lies, not as an angle. The
// old "rotate_deg clockwise" answer was a coin toss on a sideways photo: the
// i13 wardrobe (dad 9/3) had two of three sideways shorts answered 90 when
// 270 was right — the model can see a waistband on the right edge, it just
// cannot do the mental turn. We do the turn (SIDE_DEG).
// The same one call also asks what the garment LOOKS like: the taste rules
// (never two loud pieces, a statement piece wants a plain partner, palettes
// that clash) are what made the original's boards feel chosen rather than
// shuffled, and they read colours, pattern, statement, palette and vibe
// (spec §3.1 item 2). Every word of the vocabulary is whitelisted on the way
// in (clothing-rank.attributes), so a model that invents a value simply
// leaves that field absent — attributes degrade, they never exclude.
const ATTRS_ASK =
  '"colors": 1-3 plain colour words, ' +
  '"pattern": one of "solid","denim","stripes","floral","graphic","print", ' +
  '"statement": true if it is a loud print/graphic piece that wants a plain partner, ' +
  '"palette": one of "warm","cool","neutral","pastel", ' +
  '"vibe": one of "sweet","sporty","graphic","basic"';
// The eleven words, written out of clothing-rank's own lists (accessories spec
// §3.3, preflight 1): the prompt, the whitelist below and the pools all read
// the SAME list, so a kind cannot be asked for and then filed as a "top" — the
// drift the inline whitelist at the item writer used to invite. The jacket
// definition is the sentence that decides most of a real wardrobe: without it
// the model calls a hoodie a top (which is exactly what happened to the
// family's own, spec §3.5), and a pullover sweater IS a top.
const KIND_WORDS = [...GARMENT_KINDS, ...ACCESSORY_KINDS.map(k => k.id)]
  .map(w => '"' + w + '"').join(",");
const CATEGORY_ASK =
  '"category": one of ' + KIND_WORDS + ' — ' +
  '"jacket" is an outer layer worn over another top and taken off indoors ' +
  '(jacket, coat, hoodie, cardigan, zip fleece, vest; a pullover sweater is a "top"); ' +
  '"set" is a matching top and bottom; "hair" is a hair accessory (clip, band, bow); ' +
  '"jewelry" is a necklace, bracelet, ring or earrings, ' +
  '"occasion": "fancy" only if it is party, holiday or dress-up wear, else "everyday", ';
const INGEST_PROMPT =
  'This photo shows one clothing item, accessory or matching set laid flat. Reply with ONLY a JSON object, no prose: ' +
  '{"name": a SHORT name, 2-3 words max, like "Pink leggings" or "Daisy tee" (a child picks by picture; long names do not fit the button), ' +
  CATEGORY_ASK +
  '"warmth": which daytime weather suits it best, one of "hot","warm","cool","cold","any", ' +
  '"top_side": which EDGE of this photo the garment\'s top is nearest - the neckline/shoulders of a top or dress, the WAISTBAND of pants or shorts - one of "top","bottom","left","right", ' +
  '"crop": {"x":0-1,"y":0-1,"w":0-1,"h":0-1} fractions of the image bounding the garment - exclude floor, table, carpet, but never cut into the garment, ' +
  ATTRS_ASK + '}';
// The same questions for a garment the hub already knows by name: its tile is
// on disk, only the taste attributes are missing (the needs-attributes pass,
// spec §3.1 item 3). Nothing is asked twice.
const ATTRS_PROMPT =
  'This picture shows one clothing item (or a matching set) on a white background. ' +
  'Reply with ONLY a JSON object, no prose: {' + ATTRS_ASK + '}';
// clockwise turn that brings that edge to the top
const SIDE_DEG = { top: 0, left: 90, bottom: 180, right: 270 };
function turnFor(meta) {
  if (meta && SIDE_DEG[meta.top_side] !== undefined) return SIDE_DEG[meta.top_side];
  return [90, 180, 270].includes(meta && meta.rotate_deg) ? meta.rotate_deg : 0;   // older answers / catalogues
}
// The model's box is a hint, not a cut: it comes off a 384px probe and lands
// short of a sleeve or a cuff (the leopard top, dad 9/3: "over trimmed").
// Take it only when it is a well-formed box; malformed answers ({"y":2.7},
// {"box_2d":...}, a missing side) mean "no box".
function saneCrop(c) {
  if (!c || typeof c !== "object") return null;
  const v = ["x", "y", "w", "h"].map(k => c[k]);
  if (!v.every(n => typeof n === "number" && n >= 0 && n <= 1)) return null;
  const [x, y, w, h] = v;
  if (w < 0.1 || h < 0.1 || x + w > 1.02 || y + h > 1.02) return null;
  return { x, y, w, h };
}

async function askModel(cfg, jpgFile, prompt) {
  // A 429 retires THAT model for the rest of this build — the allowance is
  // per model, so the next one in the list is a fresh 20 photos. Once every
  // model is spent, stop asking: with a retry each, one photo could fire
  // EIGHT requests into a wall and eat tomorrow's headroom (dad 9/2 asked how
  // many photos a free key manages). Live 9/2: the sticky model 429'd after 7
  // photos and the old "one 429 = day over" rule left 12 photos and three
  // untouched models on the table.
  const p = PROVIDERS[cfg.provider];
  const order = chosenModel ? [chosenModel, ...p.models.filter(m => m !== chosenModel)] : p.models;
  const list = order.filter(m => !spentModels.has(m));
  if (!list.length) throw new Error("ai(" + cfg.provider + ") 429 daily allowance spent");
  let lastErr = "";
  for (const model of list) {
    try {
      const out = await callModel(cfg, jpgFile, model, prompt);
      chosenModel = model;                       // this one works; stay on it
      return out;
    } catch (e) {
      lastErr = e.message;
      if (/\bpermanent\b/.test(e.message)) throw e;   // bad key etc: stop
      if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(e.message)) spentModels.add(model);
      console.error("[clothing] model " + model + ": " + e.message);
    }
  }
  throw new Error(lastErr || "no model answered");
}

async function callModel(cfg, jpgFile, model, prompt) {
  const ask = prompt || INGEST_PROMPT;
  const b64 = fs.readFileSync(jpgFile).toString("base64");
  const p = PROVIDERS[cfg.provider];
  const base = process.env.ERA_AI_URL || p.base;
  let url, headers, body, extract;
  if (cfg.provider === "openai") {
    url = base + "/v1/chat/completions";
    headers = { "Authorization": "Bearer " + cfg.apiKey, "content-type": "application/json" };
    // 480, not 300: the reply gained colours, pattern, statement, palette and
    // vibe (spec §3.1 item 2) and a truncated one is a JSON.parse throw — a
    // generic error the ladder answers by spending the next model (W6).
    // The accessories cut (9/17) lengthened the PROMPT, not the answer: the
    // reply gained one short field ("occasion":"everyday", ~8 tokens) on an
    // answer measured at 245 bytes / ~70 tokens, so the cap is untouched in
    // all three provider blocks.
    body = { model, max_completion_tokens: 480,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } },
        { type: "text", text: ask } ] }] };
    extract = (j) => j.choices[0].message.content;
  } else if (cfg.provider === "google") {
    url = base + "/v1beta/models/" + model + ":generateContent";
    headers = { "x-goog-api-key": cfg.apiKey, "content-type": "application/json" };
    body = { contents: [{ parts: [
        { inline_data: { mime_type: "image/jpeg", data: b64 } },
        { text: ask } ] }],
      // thinking off: -latest aliases resolve to thinking models that burn
      // the whole token budget and 45s+ reasoning about a t-shirt (QA 9/1)
      generationConfig: { maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } } };
    extract = (j) => j.candidates[0].content.parts.map(x => x.text || "").join("");
  } else {
    url = base + "/v1/messages";
    headers = { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
    body = { model, max_tokens: 480,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: ask } ] }] };
    extract = (j) => j.content.map(c => c.text || "").join("");
  }
  // Providers throttle (Google 503 "high demand" hit EVERY call on the free
  // tier, live QA 9/1) and a whole wardrobe must not die on a transient.
  // Retry with backoff on 429/5xx; a permanent error (bad key, 404 model)
  // fails fast so the family sees a real message.
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 3000));   // one quick retry, then next model
    let r;
    try {
      r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000) });
    } catch (e) {
      // Say so. This retry sends the same picture again and used to leave no
      // trace at all: the provider had already received (and counted) the
      // request, so a run showed two requests for one photo with nothing in
      // the log to attribute them to (review r4).
      last = e.message;
      console.error("[clothing] model " + model + " did not answer (" + e.message + ") — asking once more");
      continue;                                        // timeout/network: retry
    }
    if (r.ok) {
      const txt = extract(await r.json());
      return JSON.parse(txt.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
    }
    last = r.status + " " + (await r.text()).slice(0, 120);
    if (r.status === 401 || r.status === 403) throw new Error("permanent: bad key (" + r.status + ")");
    if (r.status === 429) break;     // no point retrying a spent allowance
    if (r.status !== 429 && r.status < 500) break;      // 400/404: try next model
  }
  throw new Error("ai(" + cfg.provider + "/" + model + ") " + last);
}

// A photo that left clothing/ leaves the wardrobe: the family deletes what no
// longer fits (dad 9/2: "all that should just work by adding to the clothing
// directory") and the garment must not keep turning up in outfits. Entry and
// tile go here; outfit images are redrawn every build anyway. Needs no AI key
// — a family whose key lapsed can still take things out.
function prune(files) {
  const cat = loadCatalog();
  const have = new Set(files);
  let gone = 0;
  for (const f of Object.keys(cat.items)) {
    if (have.has(f)) continue;
    const id = cat.items[f].id;
    delete cat.items[f];
    if (id) try { fs.rmSync(path.join(ITEMS(), id + ".jpg"), { force: true }); } catch {}
    gone++;
  }
  if (gone) { saveCatalog(cat); console.log("[clothing] " + gone + " photo(s) left the folder -> out of the wardrobe"); }
  return gone;
}

// ---- the needs-attributes pass (spec §3.1 item 3) -------------------------
// A garment the hub already knows by name but has never described. One call
// each, through the SAME provider ladder the photos use (one `chosenModel`,
// one `spentModels`), from the tile that is already on disk — never a second
// HEIC decode (I12).
//
// The marker is `attrsAt` (plan A4-5), never "colours empty": a model that
// answers with nothing usable still stamps it, so a garment it has nothing to
// say about is not asked again every morning for ever. `attrsTriedAt` is the
// day's stamp and goes on BEFORE the answer is known — parsed, unparsable,
// 429 or 503 alike — so the ladder is spent at most once per garment per day
// across every intra-day door: a regenerate, a Sync now, the morning tick
// (plan A4-8).
// The pass's spacing, and its test seam. The PHOTO loop keeps its literal 5 s
// (`namePhotos`): that one is a rate-limit defence with an incident behind it,
// and an env var meant to shorten a suite must not be able to take it away.
const ATTRS_SPACING_MS = Number(process.env.ERA_AI_SPACING_MS) || 5000;
// How many garments in a row may fail through a healthy-looking ladder before
// the pass calls the PROVIDER the problem and stops for the day. A 429 retires
// a model (`spentModels`) and is caught by the "allowance spent" stop below; a
// 503, a refused key or a reply that will not parse retire nothing, so without
// this every garment re-walks the whole ladder — ~140 requests and minutes of
// backoff on the family's 35-garment upgrade morning (review r1). Two in a row
// is enough: a provider overloaded for two garments is overloaded for the
// wardrobe, and `attrsTriedAt` means tomorrow tries again from scratch.
const ATTRS_MAX_MISSES = 2;
// A4-13, decided in T4.3 and written up in spec §3.1 item 3 + §7: `attrsAt` is
// a ONE-WAY door. A garment this device has described is never re-opened, so a
// `tags/` line arriving on a later Drive pull cannot replace what the local
// model said — spec §3.1's "shared tags first" holds only if the migration
// tool's output is in the mirrored folder before this hub's first build, which
// is the documented operator order. The rejected alternative (a sweep in which
// a tag whose `t` is newer than `attrsAt` wins) does not even cover the case it
// was proposed for: the tool stamps `t` when the operator RUNS it, hours before
// the upgraded hub boots, so the sweep would read an older tag and keep the
// model's answer anyway.
function needsAttributes(it) {
  if (it.attrsAt) return false;                                    // already described
  if (Array.isArray(it.colors) && it.colors.length) return false;  // ...or plainly already has them
  return !it.pattern;
}
// Another device may have paid for this garment already (spec §3.1 item 1:
// by id, else by content hash). A hit is what makes the family pay the AI
// ONCE for a garment rather than once per device (spec §5).
function tagsFor(id, hash) { return log().tagsFor(shared(), id, hash); }
// One catalogue entry, written out as a shared tag line (spec §5). Sent only
// after a REAL model answer — a garment described from someone else's line is
// already in the log. `rotate_deg`/`crop` ride along (W5) so the device that
// skips the call can still draw the tile the right way up; every other field
// has already been through the whitelist on its way into wardrobe.json.
function shareTag(it) {
  if (!it || !it.id) return;
  // `occasion` rides along like every other answer (spec §3.4); `hidden`,
  // `manualAt` and `manual` deliberately do NOT — this is the MODEL's line,
  // and only the route that a parent pressed writes a manual one (spec §5.1).
  log().appendTag({ id: it.id, hash: it.hash, name: it.name, category: it.category,
    occasion: it.occasion,
    warmth: it.warmth, colors: it.colors, pattern: it.pattern, statement: it.statement,
    palette: it.palette, vibe: it.vibe, rotate_deg: it.rotate_deg || 0, crop: it.crop || {} });
}
// The picture the pass sends: the 640 tile, scaled to the same 384 px single
// billing tile the photo probe uses. The photo itself is never opened again.
function attrsProbe(id) {
  const tile = decodeJpg(fs.readFileSync(path.join(ITEMS(), id + ".jpg")), { maxMemoryUsageInMB: 1024 });
  const probe = path.join(ITEMS(), "_attrs.jpg");
  writeJpg(scaleRgba(tile, 384), probe, 78);
  return probe;
}

async function describeCatalogued(cfg, cat) {
  const day = todayKey();
  // A probe a killed pass left behind is litter in the family's
  // wardrobe-items folder and a permanent +1 on the build signature's tile
  // count, so it is swept whether or not there is anything to describe.
  const sweepProbe = () => { try { fs.rmSync(path.join(ITEMS(), "_attrs.jpg"), { force: true }); } catch {} };
  // Entries, not values: the key is the photo's path under clothing/, and the
  // hash backfill below needs it.
  const todo = Object.entries(cat.items).filter(([, it]) =>
    it && it.ok && hasTile(it.id) && needsAttributes(it) && it.attrsTriedAt !== day);
  if (!todo.length) { sweepProbe(); return { attrsDone: 0, attrsLeft: 0 }; }
  let done = 0;
  let misses = 0;                 // garments in a row whose model call failed
  // Its OWN progress field, not `ingesting` (I16): Settings says "naming 3 of
  // 12 photos" for one loop and something else for the other.
  const post = () => { if (parentPort) parentPort.postMessage({ attrs: { done, total: todo.length } }); };
  post();
  // Stop for the day: stamp every garment the pass has not reached, so no
  // later door today walks the same wall garment by garment (I13, A4-8).
  const giveUp = (i) => {
    for (const [, rest] of todo.slice(i + 1)) rest.attrsTriedAt = day;
    saveCatalog(cat);
  };
  try {
    for (let i = 0; i < todo.length; i++) {
      const [file, it] = todo[i];
      // The photo's own sha256 is how another device's shared tag finds this
      // garment when the filename differs (spec §3.1 item 1). A wardrobe
      // catalogued before this field existed already has its tile, so it
      // never goes back through the photo loop that computes it — this pass
      // is the one place that opens the photo again, and without it the
      // "else by hash" half of the match is dead for exactly the wardrobe the
      // pass exists to serve. One read, once ever (review r1).
      if (!it.hash) {
        try { it.hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(CLOTHING(), file))).digest("hex"); }
        catch { /* photo gone, tile survives: the id path still matches */ }
      }
      const shared = tagsFor(it.id, it.hash);
      if (shared) {   // paid for on another device: no call, no spacing
        // Attributes ONLY — deliberately not the tag's `rotate_deg`/`crop`,
        // which the photo loop does take (W5). This pass runs on garments whose
        // tile already exists and is not redrawn here, and it was cut with THIS
        // device's own turn: adopting a foreign geometry without redrawing
        // would turn a correct tile wrong (the 9/3 upside-down-shorts failure)
        // instead of righting a wrong one.
        Object.assign(it, attributes(shared), { attrsAt: day });
        saveCatalog(cat); done++; post();
        continue;
      }
      it.attrsTriedAt = day;          // stamped before the outcome is known
      saveCatalog(cat);
      let meta = null, calledModel = false;
      try {
        const probe = attrsProbe(it.id);     // an unreadable tile asks nobody anything
        calledModel = true;
        meta = await askModel(cfg, probe, ATTRS_PROMPT);
        misses = 0;
      } catch (e) {
        console.error("[clothing] attributes " + it.id + ": " + e.message);
        if (calledModel) misses++;
        // Nothing left to ask WITH — every model spent, or a key the provider
        // refuses — is one garment's evidence and answers for the whole
        // wardrobe. Everything else (a busy provider, a reply that will not
        // parse) takes ATTRS_MAX_MISSES garments in a row before the pass
        // believes the provider rather than the garment: a 503 is transient by
        // definition, and stopping on the first one cost all thirty-five their
        // day over one blip (review r2). Two in a ROW is the whole gate — a
        // success clears the counter — so a provider that answers every other
        // garment never trips it and the pass deliberately runs the wardrobe
        // out: half of it gets described, at ~2.5 requests a garment instead
        // of 1 (measured, review r3 nit). The documented failure is the
        // constant one, a free tier answering 503 to everything, and that one
        // still stops after two garments.
        const spent = /\bpermanent\b/.test(e.message) || /allowance spent/.test(e.message);
        if (spent || misses >= ATTRS_MAX_MISSES) { giveUp(i); break; }
      }
      // An answer that parses but carries nothing usable still counts as
      // described: attributes degrade, they never exclude (spec §3.1 item 4).
      if (meta) {
        Object.assign(it, attributes(meta), { attrsAt: day });
        done++;
        saveCatalog(cat);        // nothing changed since the stamp write otherwise
        // The family paid for this answer once; every other device reads it
        // from here instead of buying it again (spec §5 "tags pay once").
        shareTag(it);
      }
      if (calledModel) await new Promise(r => setTimeout(r, ATTRS_SPACING_MS));
      post();
    }
  } finally {
    sweepProbe();
    if (parentPort) parentPort.postMessage({ attrs: null });
  }
  if (done) console.log("[clothing] described " + done + " garment(s) the taste rules had no colours for");
  return { attrsDone: done, attrsLeft: todo.length - done };
}

// Ingest is TWO loops (W7). The first names the photos nobody has named; the
// second describes the garments nobody has described (spec §3.1 item 3) — the
// family's own wardrobe on the morning of the upgrade has no new photos at
// all, and an early `return {done: 0}` there would have meant it never got the
// attributes the taste rules read.
async function ingest() {
  const cfg = aiCfg();
  if (!cfg) return { skipped: "no-ai-key" };
  const cat = loadCatalog();
  const files = listPhotos(CLOTHING());
  // Re-do a photo when it is new, when it failed before, OR when its tile has
  // gone missing while the catalogue entry survived. Without the last case the
  // item is skipped forever and the board can never heal itself (QA 9/2: a
  // wipe that landed mid-run left 20 catalogued items with 5 tiles, and every
  // later run said "nothing to do"). The repair costs NO AI call — the name,
  // category and warmth are already known, so only the pixels are redone.
  // ...and once more, without AI, for a garment catalogued before we honoured
  // EXIF orientation (no `exif` field) whose photo carries a turn: its tile
  // was drawn from sideways pixels (dad 9/3, the upside-down tees).
  const legacyTurn = (f) => cat.items[f] && cat.items[f].ok && cat.items[f].exif === undefined &&
    photoOrientation(path.join(CLOTHING(), f)) !== 1;
  const todo = files.filter(f => !cat.items[f] || !cat.items[f].ok || !hasTile(cat.items[f].id) || legacyTurn(f));
  const named = todo.length ? await namePhotos(cfg, cat, todo)
    : { done: 0, landed: 0, left: 0, quotaHit: false, busy: false, quota: false };
  // The pass never touches the photo counters above: `holdDay`, the board's
  // "allowance used up" coaching and the hourly leftovers retry are all about
  // PHOTOS, and a pass that ran out of requests must not silence any of them
  // (plan A4-8, blocker B1-c).
  return { ...named, ...await describeCatalogued(cfg, cat) };
}

async function namePhotos(cfg, cat, todo) {
  fs.mkdirSync(ITEMS(), { recursive: true });
  ingesting = { done: 0, total: todo.length };
  let busyCount = 0, quotaCount = 0, landed = 0;
  if (parentPort) parentPort.postMessage({ ingesting });
  try {
    for (const f of todo) {
      let usedAi = false;
      try {
        // The photo's bytes, read ONCE: the decoder, the EXIF probe and the
        // content hash all want them, and a phone HEIC is several megabytes.
        const bytes = fs.readFileSync(path.join(CLOTHING(), f));
        const hash = crypto.createHash("sha256").update(bytes).digest("hex");
        const full = await readImageRgba(path.join(CLOTHING(), f), bytes);
        const work = scaleRgba(full, 1100);
        // 384px, not 700: providers bill images by tile, and at this size a
        // photo is a SINGLE tile (~258 tokens on Gemini). The model only has
        // to name and categorise now — u2netp does the cut-out — so the extra
        // pixels bought nothing and spent a family's free daily allowance
        // faster (dad 9/2: keep it frugal even when paying a little).
        // Known garment, missing tile: redraw from what we already learned.
        const known = cat.items[f] && cat.items[f].ok ? cat.items[f] : null;
        const orient = photoOrientation(path.join(CLOTHING(), f), bytes);
        // The id is the md5 of the photo's path under clothing/, so it is the
        // same on every device that has the same file — the first half of the
        // shared-tag match (spec §3.1 item 1). It is needed BEFORE the model
        // is asked now, not after.
        const id = "item_" + crypto.createHash("md5").update(f).digest("hex").slice(0, 10);
        let meta, sharedTag = null;
        if (known) {
          // A pre-EXIF entry's rotate_deg was the model compensating for the
          // sideways decode; now that the photo is turned as shot, drop it.
          const legacy = known.exif === undefined && orient !== 1;
          // Everything the entry already carries, attributes included: this
          // path rebuilds the entry from `meta`, so a meta that forgot them
          // would hand the garment back to the needs-attributes pass and buy
          // them a second time (W4).
          meta = { name: known.name, category: known.category, warmth: known.warmth,
                   occasion: known.occasion,
                   rotate_deg: legacy ? 0 : known.rotate_deg || 0, crop: known.crop || {},
                   colors: known.colors, pattern: known.pattern, statement: known.statement,
                   palette: known.palette, vibe: known.vibe };
        } else if ((sharedTag = tagsFor(id, hash))) {
          // Another device in the family already asked about this garment —
          // by id (same filename) or by content hash (the same photo saved
          // under another name). The tile is still drawn HERE; only the
          // question is free. `top_side` is not in a tag line, so the turn
          // comes from the rotate_deg the tagging device wrote (W5) — without
          // it a sideways photo would draw a sideways tile on this device.
          meta = { name: sharedTag.name, category: sharedTag.category, warmth: sharedTag.warmth,
                   occasion: sharedTag.occasion,
                   rotate_deg: sharedTag.rotate_deg || 0, crop: sharedTag.crop || {},
                   colors: sharedTag.colors, pattern: sharedTag.pattern, statement: sharedTag.statement,
                   palette: sharedTag.palette, vibe: sharedTag.vibe };
          console.log("[clothing] " + f + " was already described by another device — no AI call");
        } else {
          const probe = path.join(ITEMS(), "_probe.jpg");
          writeJpg(scaleRgba(work, 384), probe, 78);
          usedAi = true;
          meta = await askModel(cfg, probe);
        }
        const rot = turnFor(meta);
        // Trim on the FULL upright photo — its border really is floor/table, so
        // the background sample is honest. (Doing this after the model's crop
        // sampled the GARMENT and trimmed nothing: wood floor survived onto the
        // board, QA 9/1.)
        // Cut the garment out with the model (same one her Python pipeline
        // uses); the colour-flood heuristic remains the fallback for a machine
        // without the runtime, where it trims what it safely can.
        const rotated = rotateRgba(work, rot);
        let cutOut = null;
        try { cutOut = await segment.cutOut(rotated); } catch (e) { console.error("[segment] " + e.message); }
        const cut = cutOut || removeBackground(rotated);
        const trimmed = cutOut ? cropToContent(cut, WHITE_BG.tol, WHITE_BG.need) : cropToContent(cut);
        // A cut-out already IS the garment: the box around its pixels is the
        // whole garment and nothing else. The model's box only helps the
        // fallback, where the flood may have left floor around the garment —
        // and even then only when it is tighter. Letting it win over the
        // cut-out sliced sleeves and cuffs off (dad 9/3: "over trimmed shirt").
        const hint = saneCrop(meta.crop);
        const area = (im) => im.width * im.height;
        let best = trimmed;
        if (!cutOut && hint) {
          const modelCrop = cropRgba(cut, hint);
          if (area(modelCrop) < area(trimmed)) best = modelCrop;
        }
        writeJpg(padSquare(best, 640), path.join(ITEMS(), id + ".jpg"), 85);
        // Keep the geometry: a later tile repair can then reproduce the same
        // picture without asking the model again.
        // `...known` first so a repair keeps what this path does not recompute
        // (the described-on day, an earlier pass's marker); `hash` is the
        // sha256 of the photo's own bytes, which is how another device's
        // shared tag finds this garment when the filename differs (spec §3.1
        // item 1). attrsAt is stamped only when a model actually answered.
        // `hidden` and `manualAt` are carried by the `...known` spread alone:
        // they are a PARENT's fields (accessories spec §3.2) and nothing on
        // this path — not the model, not another device's tag — may write them.
        // `category` and `occasion` are rewritten from `meta`, which on a
        // redraw is the entry's own word (so a parent's "jacket" survives a
        // tile repair) and on a shared tag is the family's.
        cat.items[f] = { ...(known || {}), id, ok: true, name: shortLabel(meta.name),
          rotate_deg: rot, crop: hint || {}, exif: orient,
          category: CATEGORIES.has(meta.category) ? meta.category : "top",
          occasion: OCCASIONS.includes(meta.occasion) ? meta.occasion : "everyday",
          warmth: ["hot", "warm", "cool", "cold", "any"].includes(meta.warmth) ? meta.warmth : "any",
          ...attributes(meta), hash, ...(usedAi || sharedTag ? { attrsAt: todayKey() } : {}) };
        saveCatalog(cat);   // survive a crash mid-batch: each item lands as it finishes
        // Only a real answer is worth sharing: a garment described FROM the
        // shared log is already in it, and a tile repair learned nothing new.
        if (usedAi) shareTag(cat.items[f]);
        landed++;
        console.log("[clothing] " + (known ? "redrew " : "cataloged ") + f +
          " -> " + cat.items[f].name + " (" + cat.items[f].category + ")");
      } catch (e) {
        console.error("[clothing] ingest " + f + ": " + e.message);
        if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(e.message)) quotaCount++;
        else if (/\b(503|502|500|high demand|timeout)\b/i.test(e.message)) busyCount++;
      }
      ingesting.done++;
      // Free tiers cap REQUESTS PER MINUTE (~10-15 for Flash). At 1.5s plus a
      // few seconds of cut-out we were running right at that ceiling and
      // tripping 429/503 constantly (dad 9/1-9/2). 5s keeps a family
      // comfortably under it: a 40-item wardrobe still finishes in ~5 minutes,
      // once, in the background.
      // ...but a tile repair asked nobody anything, so it need not wait.
      // Literal, not the pass's seam: this 5 s is the defence, and a stray
      // ERA_AI_SPACING_MS must not be able to remove it (review r1).
      if (usedAi) await new Promise(r => setTimeout(r, 5000));

      if (parentPort) parentPort.postMessage({ ingesting });
    }
  } finally {
    try { fs.rmSync(path.join(ITEMS(), "_probe.jpg"), { force: true }); } catch {}
    ingesting = null;
    if (parentPort) parentPort.postMessage({ ingesting });
  }
  return { done: todo.length, landed, left: todo.length - landed, quotaHit: quotaCount > 0,
    busy: busyCount > 0 && (busyCount + quotaCount) === todo.length,
    quota: quotaCount > 0 && (busyCount + quotaCount) === todo.length && quotaCount >= busyCount };
}

// ---- the manual sweep (accessories spec §3.4) ------------------------------
// A parent LOOKED at the garment; the model guessed at it. So a manual
// correction outranks the model for ever, on every device — and the only way
// to mean "for ever" is to re-apply it at the top of every build, a full one
// and a weather re-sort alike (preflight 3), before a single look is dealt.
//
// Two places a correction comes from, read the same way:
//   * <DATA>/wardrobe/edits.json — this device's own, written by the route the
//     parent pressed (spec §5.1). A device never reads its OWN lines back out
//     of the mirror (A4-9), which is the whole reason its own edits need a
//     local file as well as a shared line.
//   * the merged tags map — every other device's manual lines, already reduced
//     to the newest manual line per id/hash (clothing-log's `beats`).
// The newer `t` of the two wins, it applies only if it is newer than the stamp
// the entry already carries, and it stamps `manualAt` with its own clock.
//
// `manualAt` is the winning edit's OWN `t`, a full ISO instant — not the
// `YYYY-MM-DD` spec §3.2 asked for (T4, measured). A day stamp is the family's
// day, `dayKey(t, tz)`, and in a zone ahead of UTC that day is TOMORROW's date
// for the last hours of the evening: the stamp "2026-09-18" then sits above
// every `t` a parent can produce until midnight UTC, and the second correction
// of the evening — the parent fixing a mistake twice in one minute, which is
// the ordinary case — is silently refused. An instant compares exactly, in any
// zone, and still begins with the day it happened, so `manualAt >= dayKey(t)`
// (the route's 60-day prune rule, T6) reads the same. The apply is idempotent
// — a field is written only when it differs — so the same edit re-winning
// tomorrow costs a string compare and no write.
const EDITS = () => path.join(DATA, "wardrobe", "edits.json");
// READ-ONLY, always (spec §7 and the plan's choice, T4): the route owns this
// file and prunes it on its own next write, so there is never a second writer.
// A file that will not open or will not parse is one log line and an empty
// map — deleting a parent's corrections because a syncer caught the file
// mid-write is not a trade this family would make.
function readEdits() {
  let raw;
  try { raw = fs.readFileSync(EDITS(), "utf8"); }
  catch (e) {
    if (e.code !== "ENOENT") console.error("[clothing] edits.json would not open (" + e.code + ") — building without this device's own edits");
    return {};
  }
  try {
    const e = JSON.parse(raw);
    if (e && typeof e === "object" && !Array.isArray(e)) return e;
  } catch {}
  console.error("[clothing] edits.json is not a map of edits — building without this device's own edits");
  return {};
}
// What a manual line is allowed to say. Same rule as the shared log's
// (clothing-log normalizeTag): a malformed field is DROPPED and the rest of
// the correction stands, so `hidden: "yes"` costs that writer its hide and not
// the family its category.
function manualFields(src) {
  const out = {};
  if (CATEGORIES.has(src.category)) out.category = src.category;
  if (OCCASIONS.includes(src.occasion)) out.occasion = src.occasion;
  if (typeof src.hidden === "boolean") out.hidden = src.hidden;
  return out;
}
function applyManual(cat) {
  const edits = readEdits();
  let changed = 0;
  for (const it of Object.values(cat.items)) {
    if (!it || !it.ok || !it.id) continue;
    const own = edits[it.id];
    const tag = tagsFor(it.id, it.hash);          // by id, else by hash (spec §3.1 item 1)
    const cands = [];
    if (own && typeof own === "object" && typeof own.t === "string") cands.push(own);
    // Only a MANUAL winner: an ordinary tag line is the model talking, and the
    // model does not get to stamp manualAt (clothing-log carries `manual`/`t`
    // on a manual winner alone).
    if (tag && tag.manual === true && typeof tag.t === "string") cands.push(tag);
    if (!cands.length) continue;
    const win = cands.reduce((a, b) => (b.t > a.t ? b : a));
    if (it.manualAt && win.t <= it.manualAt) continue;
    if (!Number.isFinite(Date.parse(win.t))) continue;   // a stamp nobody can read is not a clock
    const fields = manualFields(win);
    if (!Object.keys(fields).length) continue;    // nothing usable was said
    fields.manualAt = win.t;
    let touched = false;
    for (const [k, v] of Object.entries(fields)) if (it[k] !== v) { it[k] = v; touched = true; }
    if (touched) changed++;
  }
  if (changed) {
    saveCatalog(cat);
    console.log("[clothing] " + changed + " garment(s) follow the family's own word, not the model's");
  }
  return changed;
}

// ---- weather (keyless; cached 3h; null offline = board just has no tile) ----
// The HOURS she is out, not the day's peak (dad 9/5: she dresses for a
// morning at school, and the afternoon high we used to show is hours away —
// "so it's not perfectly useful"). One
// window applies every day; unset = the whole day, which is what the daily
// maximum used to give. Settings writes it, the worker reads it from the same
// app-settings.json every other knob lives in.
const WCACHE = () => path.join(DATA, ".weather-cache.json");
function weatherWindow() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DATA, "app-settings.json"), "utf8"));
    const w = s && s.weatherWindow;
    if (w && Number.isInteger(w.from) && Number.isInteger(w.to) &&
        w.from >= 0 && w.to <= 23 && w.from < w.to) return { from: w.from, to: w.to };
  } catch {}
  return null;
}
// Both ends INCLUSIVE: "2 PM-5 PM" is the hours 14, 15, 16 and 17.
function inWindow(hour, win) { return !win || (hour >= win.from && hour <= win.to); }
async function weather() {
  const win = weatherWindow();
  const key = win ? win.from + "-" + win.to : "all";
  try {
    const c = JSON.parse(fs.readFileSync(WCACHE(), "utf8"));
    // a record computed for OTHER hours answers a different question
    if (Date.now() - c.at < 3 * 3600e3 && (c.window || "all") === key) return c.w;
  } catch {}
  try {
    let geo = null;
    const lookups = process.env.ERA_GEO_URL
      ? [process.env.ERA_GEO_URL] : ["https://ipapi.co/json/", "https://ipwho.is/"];
    for (const u of lookups) {
      try {
        const g = await (await fetch(u, { signal: AbortSignal.timeout(6000) })).json();
        if (g && typeof g.latitude === "number") { geo = g; break; }
      } catch {}
    }
    if (!geo) return null;
    // hourly, not daily: timezone=auto makes the hourly stamps local to those
    // coordinates, so hour 10 in the answer is 10 AM where the family lives.
    const q = `latitude=${geo.latitude}&longitude=${geo.longitude}` +
      "&hourly=temperature_2m,weather_code&temperature_unit=fahrenheit&forecast_days=1&timezone=auto";
    const base = process.env.ERA_WEATHER_URL || "https://api.open-meteo.com";
    const wr = await (await fetch(base + "/v1/forecast?" + q,
      { signal: AbortSignal.timeout(6000) })).json();
    const h = wr.hourly;
    let t = null, code = 0;
    for (let i = 0; i < h.time.length; i++) {
      const hour = Number(String(h.time[i]).slice(11, 13));
      if (!inWindow(hour, win)) continue;
      const temp = h.temperature_2m[i];
      if (typeof temp === "number" && (t === null || temp > t)) t = temp;   // the warmest hour she is out
      const c = h.weather_code[i];
      if (typeof c === "number" && c > code) code = c;                      // ...dressed for the worst of them
    }
    if (t === null) return null;
    t = Math.round(t);
    const band = t >= 78 ? "hot" : t >= 66 ? "warm" : t >= 54 ? "cool" : "cold";
    const w = { t, band, symbol: code <= 1 ? "sun" : code <= 67 ? "cloud" : "cold", window: win };
    try { fs.writeFileSync(WCACHE(), JSON.stringify({ at: Date.now(), window: key, w })); } catch {}
    return w;
  } catch { return null; }
}
// 0 -> "12 AM", 12 -> "12 PM", 13 -> "1 PM" — how a parent says an hour.
function hourLabel(h) {
  return (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? " AM" : " PM");
}

// ---- the daily board: her exact graph ----
// Which garments the band admits, and the order of the day's 21, is the
// original's deal (clothing-rank.js, ported from outfit_set.py): tops never
// gated, bottoms widened to the neighbouring band when the exact one leaves
// fewer than two, band null (weather offline) gates nothing.
// Button plates are small by design (the PHOTO is the message) — a long name
// clipped mid-word on the board (QA 9/1). Keep names to ~3 words / 22 chars,
// dropping leading adjectives rather than truncating a word.
function shortLabel(raw) {
  let n = String(raw || "Clothes").trim().replace(/\s+/g, " ");
  n = n.charAt(0).toUpperCase() + n.slice(1);   // never start a tile lowercase (QA 9/1)
  if (n.length <= 22) return n;
  // Squeeze the MIDDLE, never the ends: the first word is usually the colour
  // and the last is the garment, so "Light wash denim shorts" becomes "Light
  // denim shorts" (which is exactly what a parent would have written).
  const w = n.split(" ");
  while (w.length > 3 && w.join(" ").length > 22) w.splice(1, 1);
  n = w.join(" ");
  if (n.length <= 26) return n;
  const tail = w.slice(-2).join(" ");
  return (w[0] + " " + tail).length <= 26 ? w[0] + " " + tail : tail;
}

function shortName(item) {
  const words = item.name.split(" ");
  const n = words.length <= 2 ? item.name : words.slice(-2).join(" ");
  return n.charAt(0).toUpperCase() + n.slice(1);   // never start a tile lowercase
}

// The two halves of a combo are named independently, so the plate can run to
// 30 characters, wrap to a third line, and get CLIPPED by the tile (QA 9/2:
// "Ribbed camisole + Green shorts" lost "Green shorts" off the bottom, while
// "Ribbed cami + Green shorts" at 26 fitted). Budget the WHOLE label: drop
// leading words from whichever half is longer, never below its last word —
// the garment noun at the end is what tells two outfits apart.
// 28 is measured, not guessed: "Ribbed cami + Green shorts" (26) sits on two
// lines, "Ribbed camisole + Green shorts" (30) needs three and clips.
const COMBO_MAX = 28;
function comboLabel(top, bottom) {
  const a = shortName(top).split(" ");
  const b = shortName(bottom).split(" ");
  const len = () => a.join(" ").length + 3 + b.join(" ").length;
  // Shrink the TOP half first. Trimming either half costs a word like "Green"
  // or "Crinkle", but two pairs of shorts are told apart by their colour far
  // more often than two tops are, and a board full of "... + Shorts" tells a
  // parent nothing (QA 9/2, first attempt at this).
  while (len() > COMBO_MAX && (a.length > 1 || b.length > 1)) {
    if (a.length > 1) a.shift(); else b.shift();
  }
  const cap = (w) => { const s = w.join(" "); return s.charAt(0).toUpperCase() + s.slice(1); };
  return cap(a) + " + " + cap(b);
}

// What a tile is MADE OF, for the board's hold sheet: it names the rows under
// a finger from these objects instead of parsing a label (spec §4). Four
// fields, nothing of the deal's private business (colours, warmth, hashes) —
// and `occasion` is answered even for a garment described before the word
// existed, because a chip with no value selected is a sheet that cannot save.
function itemRef(it) {
  return { id: it.id, name: it.name, category: it.category, occasion: it.occasion || "everyday" };
}

// The cells a 3x4 page leaves for CONTENT, in reading order: everything but
// Back/weather [1,1], More [3,1], the bottom-right corner [3,4] and the two
// CENTER rest cells [2,2][2,3] (lib contract restCells: "center"). Today pages
// and browse pages share it, which is why it lives above both of them.
const SLOTS = [[1,2],[1,3],[1,4],[2,1],[2,4],[3,2],[3,3]];

// 3x4 browse pages per ux-contract: Back top-left [1,1], More bottom-LEFT
// [3,1], the two CENTER cells [2,2][2,3] left black (lib contract restCells:
// "center"), and a garment in EVERY cell that is left — the today page's own
// slot list plus [3,4], which is the original generator's item_slots
// (outfit_set.py:839) garment for garment. Any cell a short page does not
// reach stays black; the slots never move, so one layout serves every page.
// `extra` (optional) is one button repeated on EVERY page at [3,4] — the
// corner today pages give Build my own — because she can be standing on page 3
// of the tops when she wants a jacket (spec §4.1); it costs that page its
// eighth garment, never a centre cell. Dad's 9/3 ruling below ("fill the black
// 2 bottom tiles and the middle-right tile ... when enough available",
// overruling the 9/1 six-per-page cap) reached the today pages and stopped
// there: until 9/22 these grids still dealt the 9/1 six, into the centre pair
// and nowhere near the edges — every cat_* and every acc_* page, inverted.
// Eight tiles + Back + More = ten targets, the same as a today page and under
// the contract's comfortable 12.
function gridPages(id, name, items, backLoad, extra) {
  const pages = [];
  const CELLS = extra ? SLOTS : [...SLOTS, [3,4]];
  const per = CELLS.length;
  for (let p = 0; p * per < items.length || p === 0; p++) {
    const pid = p === 0 ? id : id + "_" + (p + 1);
    const buttons = [{ label: "Back", type: "back", glyph: "\u2190",
      load: p === 0 ? backLoad : (p === 1 ? id : id + "_" + p), row: 1, col: 1 }];
    items.slice(p * per, (p + 1) * per).forEach((it, k) => {
      buttons.push({ label: it.name, say: it.name, type: "clothing",
        image: "wardrobe-items/" + it.id + ".jpg", items: [itemRef(it)],
        row: CELLS[k][0], col: CELLS[k][1] });
    });
    if ((p + 1) * per < items.length)
      buttons.push({ label: "More", type: "control", symbol: "more", load: id + "_" + (p + 2), row: 3, col: 1 });
    if (extra) buttons.push({ ...extra, row: 3, col: 4 });
    pages.push({ id: pid, name, rows: 3, columns: 4, buttons });
    if ((p + 1) * per >= items.length) break;
  }
  return pages;
}

// today pages take those same slots, with Build my own in the corner [3,4].
// SLOTS' [3,3] is LAST on purpose: it is the cell the accessories door takes
// when the family has any (dad 9/17), so a page with accessories is that list
// minus its tail — six looks — and a page without one is all seven, unchanged.
const ACC_CELL = [3,3];
const todaySlots = (present) =>
  present.length ? SLOTS.filter(([r, c]) => !(r === ACC_CELL[0] && c === ACC_CELL[1])) : SLOTS;
const PAGES = 3;   // how many "More" pages a day gets at most

// The one door she has to learn, wherever it turns up: today [3,3], "This
// one?" [3,2], every browse page [3,4], Build my own's last cell when the
// kinds outgrow it. "accessories" is an ARASAAC bestsearch word (25634, the
// fashion-accessories pictogram — checked 9/17), the worker's own convention
// for a category tile.
const accDoor = (row, col) =>
  ({ label: "Accessories", type: "category", symbol: "accessories", load: "acc", row, col });

// The words a parent sees on a chip: ONE garment, so singular — the grids'
// plural names ("Tops", "Dresses") name a page, not a thing you can hold.
// Accessory kinds keep the label clothing-rank gives them, so the two lists
// cannot drift (preflight 1).
const GARMENT_LABEL = { top: "Top", pants: "Pants", shorts: "Shorts", dress: "Dress", set: "Set" };
const RECIPE_CATEGORIES = [
  ...GARMENT_KINDS.map(id => ({ id, label: GARMENT_LABEL[id] })),
  ...ACCESSORY_KINDS.map(k => ({ id: k.id, label: k.label })),
];

async function buildCataloged(cat) {
  const w = await weather();
  const band = w ? w.band : null;
  // A catalogued item whose tile is gone cannot be drawn. Leave it out rather
  // than let one missing file empty the whole board (QA 9/2: every outfit died
  // on "composite: ENOENT" and Ellie got a black screen). Ingest repairs the
  // tile on the next run; the board stays usable meanwhile.
  // ...and a garment a parent hid is not drawn at all: dropped HERE, before
  // the deal, the grids and `present` (spec §4.1). The entry itself is kept —
  // hiding is not deleting, and the sheet can put it back.
  const items = Object.values(cat.items).filter(i => i.ok && i.hidden !== true && hasTile(i.id));
  // The accessory kinds the family really has, in ACCESSORY_KINDS order: at
  // least one ok, un-hidden item WITH A TILE, so a picture that never landed
  // cannot produce an empty grid (spec §7). T5 draws the entry tile, the `acc`
  // menu and the `acc_<kind>` grids from exactly this list.
  const present = ACCESSORY_KINDS.map(k => k.id).filter(id => items.some(i => i.category === id));
  // While she has accessories the seventh outfit slot IS the door, so the
  // whole build — the deal's cap, the page size, the lineup the memory keeps
  // and the "More" arithmetic — follows this one number and never a constant.
  const slots = todaySlots(present);
  const per = slots.length;

  // The day's 21, dealt by the original's rules (spec §3.5): page 1 is her
  // staples then fresh, garment-distinct looks; yesterday's page 1 opens page
  // 2; the seed is the family's day, so a same-day rebuild (weather re-sort,
  // sync, restart) deals the same 21 in the same order — nothing random here.
  // The memory is BOTH halves (spec §5, §6 step 4): this device's own
  // history.json — the local canonical, one writer — merged with every other
  // device's picks and offers as the mirror delivered them. Curated pairs and
  // hearts come from the same shared folder (the migration tool writes the
  // family's; there is no UI for them this cut).
  const seed = dayKey(Date.now(), workerData.tz);
  const m = shared();
  const today = buildCandidates({
    items, band, cap: per * PAGES, seed,
    pairing: m.pairing, favorites: m.favorites,
    history: mergeHistory(readHistory(), m), perPage: per,
  }).map(toWorkerShape);

  // The page-1 lineup goes to the shell FIRST (I9): it is the memory tomorrow's
  // deal reads, and a composite that fails must not lose it. ONE writer for
  // wardrobe/history.json — the shell's recordOffer, never this thread (A4-1).
  const page1 = today.slice(0, per).map(c => c.one ? [c.one.id] : [c.top.id, c.bottom.id]);
  if (parentPort) parentPort.postMessage({ offer: { date: seed, band, page1 } });
  // ...and the same lineup to the family, so tomorrow every device bars what
  // any of them showed today. The MOUNT only — <DATA>/clothing/.era belongs to
  // the mirror (A4-9) — and never a reason to fail a build. The same guard the
  // local recorder has (clothing.js recordOffer): a build that could draw
  // nothing deals an empty page 1, and publishing THAT would replace this
  // date's real lineup with none on every other device (review r1). The log
  // refuses it too; the rule is written at both writers so a reader comparing
  // them sees one rule, not two. The offer is posted to the shell first and
  // appended here on the same tick, so the shell's recordOffer lands after this
  // line — harmless, since own lines are never read back.
  if (page1.length) log().appendOffer(seed, { band, page1 });

  fs.mkdirSync(OUTFITS(), { recursive: true });
  // Layout per ux-contract.md placement LAW (dad 9/1: "follow the docs"):
  // More = bottom-LEFT [3,1] (TD-Snap muscle memory), Build/exit = bottom-
  // RIGHT [3,4], Back/weather top-left [1,1], rest cells = the two CENTER
  // cells [2,2][2,3]. The other seven cells hold outfits when the wardrobe
  // has them (dad 9/3, I-13 photo: "fill the black 2 bottom tiles and the
  // middle-right tile with outfits on each page when enough available" -
  // this overrules the 9/1 six-per-page cap and the bottom-row rest strip);
  // cells left over stay black. Ten targets = under the contract's
  // comfortable 12.
  const boards = [];
  const pages = Math.max(1, Math.ceil(today.length / per));
  for (let pg = 0; pg < pages; pg++) {
    const pid = pg === 0 ? "today" : "today_" + (pg + 1);
    const buttons = [];
    if (pg === 0) {
      if (w) {
        // With a window the tile has to say WHICH hours it is talking about,
        // or a parent reads "72\u00b0" as the whole day again (dad 9/5).
        const span = w.window ? hourLabel(w.window.from) + "-" + hourLabel(w.window.to) : null;
        buttons.push({ label: w.t + "\u00b0  " + w.band, type: "control", symbol: w.symbol,
          say: span
            ? "Between " + hourLabel(w.window.from) + " and " + hourLabel(w.window.to) +
              " it is " + w.band + ", about " + w.t + " degrees."
            : "Today it is " + w.band + ", about " + w.t + " degrees.",
          footnote: (span ? "for " + span + " \u00b7 " : "") + "updated " +
            new Date().toLocaleString("en-US",
              { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
          row: 1, col: 1 });
      }
    } else {
      buttons.push({ label: "Back", type: "back", glyph: "\u2190",
        load: pg === 1 ? "today" : "today_" + pg, row: 1, col: 1 });
    }
    today.slice(pg * per, (pg + 1) * per).forEach((c, k) => {
      const i = pg * per + k;
      const label = c.one ? c.one.name : comboLabel(c.top, c.bottom);
      const say = c.one ? c.one.name : c.top.name + " and " + c.bottom.name;
      const img = "outfit_" + i + ".jpg";
      try {
        composite(path.join(ITEMS(), (c.one || c.top).id + ".jpg"),
          c.one ? null : path.join(ITEMS(), c.bottom.id + ".jpg"), path.join(OUTFITS(), img));
      } catch (e) { console.error("[clothing] composite: " + e.message); return; }
      const combo = c.one ? [c.one.id] : [c.top.id, c.bottom.id];
      // The same two halves the label is made of, as objects: `combo` is what
      // the decision log wants, `items` is what a parent holding the tile
      // wants (spec §4) — the ids agree, in the same order.
      const made = c.one ? [itemRef(c.one)] : [itemRef(c.top), itemRef(c.bottom)];
      buttons.push({ label, say, type: "outfit", image: "wardrobe-outfits/" + img,
        load: "confirm_" + i, say_on_load: true, combo, items: made,
        row: slots[k][0], col: slots[k][1] });
      boards.push({ id: "confirm_" + i, name: "This one?", rows: 3, columns: 2, buttons: [
        { label, say, type: "outfit", image: "wardrobe-outfits/" + img, combo, items: made, row: 1, col: 1 },
        { label: "Yes", type: "yes", glyph: "\u2713", say: "Yes", combo, row: 1, col: 2 },
        { label: "Change top", type: "category", symbol: "shirt", load: "cat_top", row: 2, col: 1 },
        { label: "Change bottoms", type: "category", symbol: "trousers", load: "choose_bottom", row: 2, col: 2 },
        { label: "Back", type: "back", glyph: "\u2190", load: pid, row: 3, col: 1 },
        // …and the door on the one empty cell "This one?" has had all along:
        // she changes her mind about the top AFTER she picked the look, so the
        // jacket has to be reachable from here too (dad 9/17).
        ...(present.length ? [accDoor(3, 2)] : []),
      ]});
    });
    if ((pg + 1) * per < today.length)
      buttons.push({ label: "More", type: "control", symbol: "more", load: "today_" + (pg + 2), row: 3, col: 1 });
    if (present.length) buttons.push(accDoor(ACC_CELL[0], ACC_CELL[1]));
    buttons.push({ label: "Build my own", type: "category", symbol: "clothes", load: "build", row: 3, col: 4 });
    boards.push({ id: pid, name: "What will I wear today?", rows: 3, columns: 4, buttons });
  }
  // hoist today pages to the front so `today` is the root board in order
  boards.sort((a, b) => (a.id.startsWith("today") ? 0 : 1) - (b.id.startsWith("today") ? 0 : 1));
  // Build my own is a 3x4 board with the two CENTRE cells black, always —
  // accessories or none (dad 9/17), so the four garment doors never move under
  // her when a jacket arrives. Ten edge cells, filled clockwise from the
  // contract's back anchor: Back, Tops, Bottoms, Dresses, Outfits, then the
  // present kinds. Empty edge cells stay black, like every other rest cell.
  const kinds = ACCESSORY_KINDS.filter(k => present.includes(k.id));
  const KIND_CELLS = [[2,4],[3,1],[3,2],[3,3],[3,4]];
  const kindTile = (k, row, col) =>
    ({ label: k.label, type: "category", symbol: k.symbol, load: "acc_" + k.id, row, col });
  const buildButtons = [
    { label: "Back", type: "back", glyph: "←", load: "today", row: 1, col: 1 },
    { label: "Tops", type: "category", symbol: "shirt", load: "cat_top", row: 1, col: 2 },
    { label: "Bottoms", type: "category", symbol: "trousers", load: "choose_bottom", row: 1, col: 3 },
    { label: "Dresses", type: "category", symbol: "dress", load: "cat_dress", row: 1, col: 4 },
    { label: "Outfits", type: "category", symbol: "clothes", load: "cat_outfit", row: 2, col: 1 },
  ];
  KIND_CELLS.forEach(([row, col], i) => {
    if (i >= kinds.length) return;
    // Six kinds can never fit five cells: the LAST cell becomes the door to
    // the menu rather than the fifth kind, so nothing is ever unreachable.
    const overflow = i === KIND_CELLS.length - 1 && kinds.length > KIND_CELLS.length;
    buildButtons.push(overflow ? accDoor(row, col) : kindTile(kinds[i], row, col));
  });
  boards.push({ id: "build", name: "Build my own", rows: 3, columns: 4, buttons: buildButtons });
  // The menu behind the door: the same shape, Back top-left, one tile per
  // present kind over the nine remaining edge cells. Six kinds is the most
  // there can ever be (ACCESSORY_KINDS), so it always fits on one page.
  if (kinds.length) {
    const MENU_CELLS = [[1,2],[1,3],[1,4],[2,1],[2,4],[3,1],[3,2],[3,3],[3,4]];
    boards.push({ id: "acc", name: "Accessories", rows: 3, columns: 4, buttons: [
      { label: "Back", type: "back", glyph: "←", load: "today", row: 1, col: 1 },
      ...kinds.map((k, i) => kindTile(k, MENU_CELLS[i][0], MENU_CELLS[i][1])),
    ]});
  }
  boards.push({ id: "choose_bottom", name: "Pants or shorts?", rows: 2, columns: 2, buttons: [
    { label: "Pants", type: "category", symbol: "trousers", load: "cat_pants" },
    // "shorts" has no ARASAAC bestsearch hit; 13638 IS the shorts pictogram
    // (dad 9/1: "the shorts image are pants" — both tiles wore the same jeans)
    { label: "Shorts", type: "category", symbol: "13638", load: "cat_shorts" },
    { label: "Back", type: "back", glyph: "←", load: "today" },
  ]});
  // Every browse page carries the door at [3,4] — she can be on page 3 of the
  // tops when she decides she wants a jacket (spec §4.1).
  const door = present.length ? accDoor(3, 4) : null;
  boards.push(...gridPages("cat_top", "Tops", items.filter(i => i.category === "top"), "today", door));
  boards.push(...gridPages("cat_pants", "Pants", items.filter(i => i.category === "pants"), "choose_bottom", door));
  boards.push(...gridPages("cat_shorts", "Shorts", items.filter(i => i.category === "shorts"), "choose_bottom", door));
  boards.push(...gridPages("cat_dress", "Dresses", items.filter(i => i.category === "dress"), "build", door));
  boards.push(...gridPages("cat_outfit", "Outfits", items.filter(i => i.category === "set"), "build", door));
  // Every browse grid above asks for a GARMENT word, so an accessory falls
  // into none of them (preflight 2): each present kind gets its own pages.
  // Back goes to `today` — the door can be entered from anywhere, so the one
  // place she is always happy to land is home. The day's band only RE-ORDERS
  // these pages (accessoryOrder): on a cold morning the coats lead, but no
  // accessory is ever weather-hidden (spec §4.1). No door on these pages: she
  // is already behind it.
  for (const k of kinds)
    boards.push(...gridPages("acc_" + k.id, k.label,
      accessoryOrder(items.filter(i => i.category === k.id), band), "today"));
  return { boards, present };
}

// No catalog yet -> no board. Decide which coaching state the splash shows.
// A stale v1 "plain photo tiles" recipe (no confirm_ boards) is removed so
// the guidance can appear instead of raw "This one" tiles.
function clearPlainRecipe() {
  const f = path.join(RECIPES(), "today.json");
  try {
    const r = JSON.parse(fs.readFileSync(f, "utf8"));
    if (r.home_label === "Clothing" && !r.boards.some(b => String(b.id).startsWith("confirm_")))
      fs.rmSync(f, { force: true });
  } catch {}
}

const SIG = () => path.join(DATA, ".clothing-sig");
// The signature and, beside it, the photo set this build saw (names + sizes):
// the shell's start() reads that back so a photo removed while the hub was
// down is a change to the first tick after boot (I23).
function storeSig(sig) {
  try { fs.writeFileSync(SIG(), sig); } catch {}
  try { fs.writeFileSync(path.join(DATA, PHOTOSET_FILE), photoSet(CLOTHING())); } catch {}
}

async function regenerate(force) {
  // The worker's private least-recently-shown file is retired (9/5): memory is
  // wardrobe/history.json alone. Clear the old one so nothing stale lingers.
  fs.rmSync(path.join(DATA, "clothing-history.json"), { force: true });
  const files = listPhotos(CLOTHING());
  const photos = files;
  prune(files);               // what left the folder leaves the wardrobe (before the tile count below)
  // Tile count is part of the signature: if pictures disappear, the day's work
  // is NOT "already done", even though the photos have not changed (QA 9/2).
  let tiles = 0;
  try { tiles = fs.readdirSync(ITEMS()).filter(f => f.endsWith(".jpg")).length; } catch {}
  const sig = new Date().toDateString() + "|" + (aiKey() ? "ai" : "none") + "|t" + tiles + "|" + files.map(f => {
    try { return f + fs.statSync(path.join(CLOTHING(), f)).size; } catch { return f; }
  }).join(",");
  let prevSig = ""; try { prevSig = fs.readFileSync(SIG(), "utf8"); } catch {}
  if (!force && sig === prevSig) return { unchanged: true };

  // rebuildOnly = re-sort what is already catalogued (the weather changed, not
  // the wardrobe): never look at a new photo, never spend an AI request.
  const ing = workerData.rebuildOnly ? null
            : await ingest(); // no-op without a key or when everything is already cataloged
  const busy = !!(ing && ing.busy);
  const quota = !!(ing && ing.quota);
  // What the shell needs to decide on a same-day retry: how many photos are
  // still waiting, and whether this build ran into the day's allowance.
  const tally = { landed: (ing && ing.landed) || 0, left: (ing && ing.left) || 0, quotaHit: !!(ing && ing.quotaHit),
    // The needs-attributes pass keeps its own two counters (plan T3.2). They
    // are reported, never acted on: `left`/`quotaHit` above are the PHOTO
    // counters the shell's holdDay and the board's coaching read, and the pass
    // has no say over either (A4-8).
    attrsDone: (ing && ing.attrsDone) || 0, attrsLeft: (ing && ing.attrsLeft) || 0 };
  const cat = loadCatalog();
  // The family's own word, re-applied before anything is dealt — on BOTH build
  // paths, because the one the route asks for is the re-sort (preflight 3).
  applyManual(cat);
  const haveCatalog = Object.values(cat.items).some(i => i.ok);
  if (!haveCatalog) {
    clearPlainRecipe();
    // A re-sort skipped ingest, so it has no evidence about the day's allowance
    // or a busy provider — it must NOT answer the "why is there no board?"
    // question. Saying "ingest-failed" here would wipe the board's "Today's
    // free AI allowance is used up" coaching for the rest of the day (9/5).
    if (workerData.rebuildOnly) return { rebuildOnly: true, photos: photos.length };
    const guidance = !photos.length ? (aiCfg() ? "no-photos" : "nothing")
                   : (aiCfg() ? (quota ? "ai-quota" : busy ? "ai-busy" : "ingest-failed") : "no-key");
    storeSig(sig);
    return { guidance, photos: photos.length, ...tally };
  }
  const { boards, present } = await buildCataloged(cat);
  fs.mkdirSync(RECIPES(), { recursive: true });
  // `categories` is the whole filing cabinet, not this wardrobe's corner of
  // it: the board's hold sheet names its chips from here (spec §4.2), and a
  // parent moving a hoodie to "Jackets" needs the chip to exist on a device
  // that has never seen a jacket. Always written, whatever `present` says.
  fs.writeFileSync(path.join(RECIPES(), "today.json"), JSON.stringify({
    locale: "en-US", root: "today", home_label: "Clothing",
    categories: RECIPE_CATEGORIES, boards }, null, 1));
  storeSig(sig);
  console.log("[clothing] board built (" + boards.length + " boards)" +
    (tally.left ? ", " + tally.left + " photo(s) still waiting" + (tally.quotaHit ? " (daily allowance)" : "") : ""));
  // historyUnread only when it really happened: the shell reads it as "this
  // board is not the day's work, build again on the next tick" (r3).
  // `accessories` is the kinds this build could really offer (spec §4.1
  // `present`), reported the way every other build fact is — the shell hands
  // the whole object back to whoever asked for the build.
  return { built: boards.length, mode: "cataloged", photos: photos.length, ...tally,
           accessories: present,
           ...(historyUnread ? { historyUnread: true } : {}) };
}

regenerate(!!workerData.force)
  .then((r) => { if (parentPort) parentPort.postMessage({ done: r }); })
  .catch((e) => {
    console.error("[clothing] worker: " + e.message);
    if (parentPort) parentPort.postMessage({ done: { error: e.message } });
  });
