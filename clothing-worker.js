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
    models: ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash"] },
};
let chosenModel = null;   // sticky once a model answers

const DATA = workerData.dataDir;
let ingesting = null; // {done, total} while naming photos — relayed to the shell

const CLOTHING = () => path.join(DATA, "clothing");
const WEB = () => path.join(DATA, "clothing-web");
const ITEMS = () => path.join(DATA, "wardrobe-items");
const OUTFITS = () => path.join(DATA, "wardrobe-outfits");
const CATALOG = () => path.join(DATA, "wardrobe.json");
const HISTORY = () => path.join(DATA, "clothing-history.json");
const RECIPES = () => path.join(DATA, "recipes");

function aiCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(DATA, "ai-config.json"), "utf8"));
    if (typeof c.apiKey !== "string" || !c.apiKey) return null;
    return { apiKey: c.apiKey, provider: PROVIDERS[c.provider] ? c.provider : "google" };
  } catch { return null; }
}
function aiKey() { const c = aiCfg(); return c ? c.apiKey : ""; }
function loadCatalog() {
  try { return JSON.parse(fs.readFileSync(CATALOG(), "utf8")); } catch { return { items: {} }; }
}
function saveCatalog(c) { fs.writeFileSync(CATALOG(), JSON.stringify(c, null, 1)); }
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY(), "utf8")); } catch { return { shown: {} }; }
}
function saveHistory(h) { fs.writeFileSync(HISTORY(), JSON.stringify(h, null, 1)); }

// ---- image plumbing (vendored decoders; RGBA in Buffers throughout) ----
let libheif = null, jpeg = null;
function ensureCodecs() {
  if (!libheif) libheif = require("./vendor/libheif.js")();
  if (!jpeg) jpeg = require("./vendor/jpeg-js");
}

function scaleRgba(img, maxDim) {
  const { data, width: w, height: h } = img;
  if (Math.max(w, h) <= maxDim) return img;
  const s = maxDim / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.round(y / s));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.round(x / s));
      const si = (sy * w + sx) * 4, di = (y * nw + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh };
}

function rotateRgba(img, deg) {
  const { data, width: w, height: h } = img;
  if (!deg) return img;
  const [nw, nh] = deg === 180 ? [w, h] : [h, w];
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let nx, ny;
    if (deg === 90) { nx = h - 1 - y; ny = x; }
    else if (deg === 180) { nx = w - 1 - x; ny = h - 1 - y; }
    else { nx = y; ny = w - 1 - x; }
    const si = (y * w + x) * 4, di = (ny * nw + nx) * 4;
    out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255;
  }
  return { data: out, width: nw, height: nh };
}

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

function readImageRgba(file) {
  ensureCodecs();
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  if ([".heic", ".heif"].includes(ext)) {
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
  const d = jpeg.decode(buf, { maxMemoryUsageInMB: 1024, formatAsRGBA: true });
  return Promise.resolve({ data: Buffer.from(d.data), width: d.width, height: d.height });
}

function writeJpg(img, file, q) { ensureCodecs(); fs.writeFileSync(file, jpeg.encode(img, q || 85).data); }

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

function cropToContent(img, tol) {
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
  const need = Math.max(3, Math.round(Math.min(w, h) * 0.02));
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
  const im = cropToContent(img);
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
  ensureCodecs();
  const W = 840, H = 560;
  const out = { data: Buffer.alloc(W * H * 4, 255), width: W, height: H };
  const place = (file, ox, boxW) => {
    const d = jpeg.decode(fs.readFileSync(file), { formatAsRGBA: true });
    const f = fitBox({ data: Buffer.from(d.data), width: d.width, height: d.height }, boxW, H);
    for (let y = 0; y < H; y++)
      f.data.copy(out.data, (y * W + ox) * 4, y * boxW * 4, (y + 1) * boxW * 4);
  };
  if (fileB) { place(fileA, 0, 420); place(fileB, 420, 420); }
  else place(fileA, 0, 840);
  writeJpg(out, dest, 88);
}

// ---- ingest: one small vision call per new photo ----
const INGEST_PROMPT =
  'This photo shows one clothing item (or a matching set) laid flat. Reply with ONLY a JSON object, no prose: ' +
  '{"name": a SHORT name, 2-3 words max, like "Pink leggings" or "Daisy tee" (a child picks by picture; long names do not fit the button), ' +
  '"category": one of "top","pants","shorts","dress","set", ' +
  '"warmth": which daytime weather suits it best, one of "hot","warm","cool","cold","any", ' +
  '"rotate_deg": 0, 90, 180 or 270 clockwise so the item stands upright, ' +
  '"crop": {"x":0-1,"y":0-1,"w":0-1,"h":0-1} fractions of the UPRIGHT image bounding the garment TIGHTLY - exclude floor, table, carpet and every background pixel you can, touching the garment edges}';

let quotaSpent = false;   // provider said "out of quota" — stop asking

async function askModel(cfg, jpgFile) {
  // Once the daily allowance is gone, every extra call is wasted: with four
  // models and a retry each, one photo could fire EIGHT requests into a wall
  // and eat the next day's headroom (dad 9/2 asked how many photos a free key
  // manages — this is why the answer was smaller than it should be).
  if (quotaSpent) throw new Error("ai(" + cfg.provider + ") 429 daily allowance spent");
  const p = PROVIDERS[cfg.provider];
  const list = chosenModel ? [chosenModel] : p.models;
  let lastErr = "", quotaTally = 0;
  for (const model of list) {
    try {
      const out = await callModel(cfg, jpgFile, model);
      chosenModel = model;                       // this one works; stay on it
      return out;
    } catch (e) {
      lastErr = e.message;
      if (/\bpermanent\b/.test(e.message)) throw e;   // bad key etc: stop
      if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(e.message)) quotaTally++;
      console.error("[clothing] model " + model + ": " + e.message);
    }
  }
  // every model refused for quota — the key is done for today
  if (quotaTally >= list.length) quotaSpent = true;
  throw new Error(lastErr || "no model answered");
}

async function callModel(cfg, jpgFile, model) {
  const b64 = fs.readFileSync(jpgFile).toString("base64");
  const p = PROVIDERS[cfg.provider];
  const base = process.env.ERA_AI_URL || p.base;
  let url, headers, body, extract;
  if (cfg.provider === "openai") {
    url = base + "/v1/chat/completions";
    headers = { "Authorization": "Bearer " + cfg.apiKey, "content-type": "application/json" };
    body = { model, max_completion_tokens: 300,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } },
        { type: "text", text: INGEST_PROMPT } ] }] };
    extract = (j) => j.choices[0].message.content;
  } else if (cfg.provider === "google") {
    url = base + "/v1beta/models/" + model + ":generateContent";
    headers = { "x-goog-api-key": cfg.apiKey, "content-type": "application/json" };
    body = { contents: [{ parts: [
        { inline_data: { mime_type: "image/jpeg", data: b64 } },
        { text: INGEST_PROMPT } ] }],
      // thinking off: -latest aliases resolve to thinking models that burn
      // the whole token budget and 45s+ reasoning about a t-shirt (QA 9/1)
      generationConfig: { maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } } };
    extract = (j) => j.candidates[0].content.parts.map(x => x.text || "").join("");
  } else {
    url = base + "/v1/messages";
    headers = { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
    body = { model, max_tokens: 300,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: INGEST_PROMPT } ] }] };
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
    } catch (e) { last = e.message; continue; }        // timeout/network: retry
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

async function ingest() {
  const cfg = aiCfg();
  if (!cfg) return { skipped: "no-ai-key" };
  const cat = loadCatalog();
  let files = [];
  try { files = fs.readdirSync(CLOTHING()).filter(f =>
    [".heic", ".heif", ".jpg", ".jpeg", ".png"].includes(path.extname(f).toLowerCase())); } catch {}
  const todo = files.filter(f => !cat.items[f] || !cat.items[f].ok);
  if (!todo.length) return { done: 0 };
  fs.mkdirSync(ITEMS(), { recursive: true });
  ingesting = { done: 0, total: todo.length };
  let busyCount = 0, quotaCount = 0;
  if (parentPort) parentPort.postMessage({ ingesting });
  try {
    for (const f of todo) {
      try {
        const full = await readImageRgba(path.join(CLOTHING(), f));
        const work = scaleRgba(full, 1100);
        // 384px, not 700: providers bill images by tile, and at this size a
        // photo is a SINGLE tile (~258 tokens on Gemini). The model only has
        // to name and categorise now — u2netp does the cut-out — so the extra
        // pixels bought nothing and spent a family's free daily allowance
        // faster (dad 9/2: keep it frugal even when paying a little).
        const probe = path.join(ITEMS(), "_probe.jpg");
        writeJpg(scaleRgba(work, 384), probe, 78);
        const meta = await askModel(cfg, probe);
        const rot = [90, 180, 270].includes(meta.rotate_deg) ? meta.rotate_deg : 0;
        const id = "item_" + crypto.createHash("md5").update(f).digest("hex").slice(0, 10);
        // Trim on the FULL upright photo — its border really is floor/table, so
        // the background sample is honest. (Doing this after the model's crop
        // sampled the GARMENT and trimmed nothing: wood floor survived onto the
        // board, QA 9/1.) Keep whichever box is tighter.
        // Cut the garment out with the model (same one her Python pipeline
        // uses); the colour-flood heuristic remains the fallback for a machine
        // without the runtime, where it trims what it safely can.
        const rotated = rotateRgba(work, rot);
        let cutOut = null;
        try { cutOut = await segment.cutOut(rotated); } catch (e) { console.error("[segment] " + e.message); }
        const upright = cutOut || removeBackground(rotated);
        const trimmed = cropToContent(upright);
        const modelCrop = cropRgba(upright, meta.crop || {});
        const area = (im) => im.width * im.height;
        const best = area(trimmed) <= area(modelCrop) ? trimmed : modelCrop;
        writeJpg(padSquare(best, 640), path.join(ITEMS(), id + ".jpg"), 85);
        cat.items[f] = { id, ok: true, name: shortLabel(meta.name),
          category: ["top", "pants", "shorts", "dress", "set"].includes(meta.category) ? meta.category : "top",
          warmth: ["hot", "warm", "cool", "cold", "any"].includes(meta.warmth) ? meta.warmth : "any" };
        saveCatalog(cat);   // survive a crash mid-batch: each item lands as it finishes
        console.log("[clothing] cataloged " + f + " -> " + cat.items[f].name + " (" + cat.items[f].category + ")");
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
      await new Promise(r => setTimeout(r, 5000));

      if (parentPort) parentPort.postMessage({ ingesting });
    }
  } finally {
    try { fs.rmSync(path.join(ITEMS(), "_probe.jpg"), { force: true }); } catch {}
    ingesting = null;
    if (parentPort) parentPort.postMessage({ ingesting });
  }
  return { done: todo.length,
    busy: busyCount > 0 && (busyCount + quotaCount) === todo.length,
    quota: quotaCount > 0 && (busyCount + quotaCount) === todo.length && quotaCount >= busyCount };
}

// ---- weather (keyless; cached 3h; null offline = board just has no tile) ----
const WCACHE = () => path.join(DATA, ".weather-cache.json");
async function weather() {
  try {
    const c = JSON.parse(fs.readFileSync(WCACHE(), "utf8"));
    if (Date.now() - c.at < 3 * 3600e3) return c.w;
  } catch {}
  try {
    let geo = null;
    for (const u of ["https://ipapi.co/json/", "https://ipwho.is/"]) {
      try {
        const g = await (await fetch(u, { signal: AbortSignal.timeout(6000) })).json();
        if (g && typeof g.latitude === "number") { geo = g; break; }
      } catch {}
    }
    if (!geo) return null;
    const q = `latitude=${geo.latitude}&longitude=${geo.longitude}` +
      "&daily=temperature_2m_max,weather_code&temperature_unit=fahrenheit&forecast_days=1&timezone=auto";
    const wr = await (await fetch("https://api.open-meteo.com/v1/forecast?" + q,
      { signal: AbortSignal.timeout(6000) })).json();
    const t = Math.round(wr.daily.temperature_2m_max[0]);
    const code = wr.daily.weather_code[0];
    const band = t >= 78 ? "hot" : t >= 66 ? "warm" : t >= 54 ? "cool" : "cold";
    const w = { t, band, symbol: code <= 1 ? "sun" : code <= 67 ? "cloud" : "cold" };
    try { fs.writeFileSync(WCACHE(), JSON.stringify({ at: Date.now(), w })); } catch {}
    return w;
  } catch { return null; }
}

// ---- the daily board: her exact graph ----
// exact band first; too few choices -> widen to the neighboring band; a
// wardrobe must never make an empty board just because the weather moved
const BANDS = ["hot", "warm", "cool", "cold"];
function forBand(items, band) {
  if (!band) return items;
  const dist = i => i.warmth === "any" ? 0 : Math.abs(BANDS.indexOf(i.warmth) - BANDS.indexOf(band));
  const exact = items.filter(i => dist(i) === 0);
  if (exact.length >= 2) return exact;
  const near = items.filter(i => dist(i) <= 1);
  return near.length ? near : items;
}
// Button plates are small by design (the PHOTO is the message) — a long name
// clipped mid-word on the board (QA 9/1). Keep names to ~3 words / 22 chars,
// dropping leading adjectives rather than truncating a word.
function shortLabel(raw) {
  let n = String(raw || "Clothes").trim().replace(/\s+/g, " ");
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

// 3x4 browse pages per ux-contract: Back top-left [1,1], up to 6 items in
// fixed slots, More bottom-LEFT [3,1]; empties become center/bottom rest cells.
function gridPages(id, name, items, backLoad) {
  const pages = [];
  const per = 6;
  const CELLS = [[1,2],[1,3],[1,4],[2,1],[2,2],[2,3]];
  for (let p = 0; p * per < items.length || p === 0; p++) {
    const pid = p === 0 ? id : id + "_" + (p + 1);
    const buttons = [{ label: "Back", type: "back", glyph: "\u2190",
      load: p === 0 ? backLoad : (p === 1 ? id : id + "_" + p), row: 1, col: 1 }];
    items.slice(p * per, (p + 1) * per).forEach((it, k) => {
      buttons.push({ label: it.name, say: it.name, type: "clothing",
        image: "wardrobe-items/" + it.id + ".jpg",
        row: CELLS[k][0], col: CELLS[k][1] });
    });
    if ((p + 1) * per < items.length)
      buttons.push({ label: "More", type: "control", symbol: "more", load: id + "_" + (p + 2), row: 3, col: 1 });
    pages.push({ id: pid, name, rows: 3, columns: 4, buttons });
    if ((p + 1) * per >= items.length) break;
  }
  return pages;
}

async function buildCataloged(cat) {
  const w = await weather();
  const band = w ? w.band : null;
  const items = Object.values(cat.items).filter(i => i.ok);
  const tops = forBand(items.filter(i => i.category === "top"), band);
  const bottoms = forBand(items.filter(i => i.category === "pants" || i.category === "shorts"), band);
  const ones = forBand(items.filter(i => i.category === "dress" || i.category === "set"), band);

  // novel combos, least-recently-shown first (her rotation), no repeated
  // top or bottom within today's slots while alternatives remain
  const hist = loadHistory();
  const combos = [];
  for (const t of tops) for (const b of bottoms) combos.push({ key: t.id + "+" + b.id, top: t, bottom: b });
  for (const d of ones) combos.push({ key: d.id, one: d });
  combos.sort((a, b) =>
    (hist.shown[a.key] || "").localeCompare(hist.shown[b.key] || "") || Math.random() - 0.5);
  const today = [];
  const usedTop = new Set(), usedBottom = new Set();
  for (const c of combos) {
    if (today.length >= 12) break;
    if (c.top && (usedTop.has(c.top.id) || usedBottom.has(c.bottom.id))) continue;
    today.push(c);
    if (c.top) { usedTop.add(c.top.id); usedBottom.add(c.bottom.id); }
  }
  for (const c of combos) {
    if (today.length >= 12) break;
    if (!today.includes(c)) today.push(c);
  }
  for (const c of today) hist.shown[c.key] = new Date().toISOString();
  saveHistory(hist);

  fs.mkdirSync(OUTFITS(), { recursive: true });
  // Layout per ux-contract.md placement LAW (dad 9/1: "follow the docs"):
  // More = bottom-LEFT [3,1] (TD-Snap muscle memory), Build/exit = bottom-
  // RIGHT [3,4], Back/weather top-left [1,1], rest cells = the two CENTER
  // cells [2,2][2,3]; outfit_set.py caps outfits at 4 per page.
  const SLOTS = [[1,2],[1,3],[1,4],[2,1]];
  const boards = [];
  const pages = Math.max(1, Math.ceil(today.length / 4));
  for (let pg = 0; pg < pages; pg++) {
    const pid = pg === 0 ? "today" : "today_" + (pg + 1);
    const buttons = [];
    if (pg === 0) {
      if (w) buttons.push({ label: w.t + "\u00b0  " + w.band, type: "control", symbol: w.symbol,
        say: "Today it is " + w.band + ", about " + w.t + " degrees.",
        footnote: "updated " + new Date().toLocaleString("en-US",
          { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
        row: 1, col: 1 });
    } else {
      buttons.push({ label: "Back", type: "back", glyph: "\u2190",
        load: pg === 1 ? "today" : "today_" + pg, row: 1, col: 1 });
    }
    today.slice(pg * 4, pg * 4 + 4).forEach((c, k) => {
      const i = pg * 4 + k;
      const label = c.one ? c.one.name : shortName(c.top) + " + " + shortName(c.bottom);
      const say = c.one ? c.one.name : c.top.name + " and " + c.bottom.name;
      const img = "outfit_" + i + ".jpg";
      try {
        composite(path.join(ITEMS(), (c.one || c.top).id + ".jpg"),
          c.one ? null : path.join(ITEMS(), c.bottom.id + ".jpg"), path.join(OUTFITS(), img));
      } catch (e) { console.error("[clothing] composite: " + e.message); return; }
      const combo = c.one ? [c.one.id] : [c.top.id, c.bottom.id];
      buttons.push({ label, say, type: "outfit", image: "wardrobe-outfits/" + img,
        load: "confirm_" + i, say_on_load: true, combo,
        row: SLOTS[k][0], col: SLOTS[k][1] });
      boards.push({ id: "confirm_" + i, name: "This one?", rows: 3, columns: 2, buttons: [
        { label, say, type: "outfit", image: "wardrobe-outfits/" + img, combo, row: 1, col: 1 },
        { label: "Yes", type: "yes", glyph: "\u2713", say: "Yes", combo, row: 1, col: 2 },
        { label: "Change top", type: "category", symbol: "shirt", load: "cat_top", row: 2, col: 1 },
        { label: "Change bottoms", type: "category", symbol: "trousers", load: "choose_bottom", row: 2, col: 2 },
        { label: "Back", type: "back", glyph: "\u2190", load: pid, row: 3, col: 1 },
      ]});
    });
    if ((pg + 1) * 4 < today.length)
      buttons.push({ label: "More", type: "control", symbol: "more", load: "today_" + (pg + 2), row: 3, col: 1 });
    buttons.push({ label: "Build my own", type: "category", symbol: "clothes", load: "build", row: 3, col: 4 });
    boards.push({ id: pid, name: "What will I wear today?", rows: 3, columns: 4, buttons });
  }
  // hoist today pages to the front so `today` is the root board in order
  boards.sort((a, b) => (a.id.startsWith("today") ? 0 : 1) - (b.id.startsWith("today") ? 0 : 1));
  boards.push({ id: "build", name: "Build my own", rows: 3, columns: 2, buttons: [
    { label: "Tops", type: "category", symbol: "shirt", load: "cat_top" },
    { label: "Bottoms", type: "category", symbol: "trousers", load: "choose_bottom" },
    { label: "Dresses", type: "category", symbol: "dress", load: "cat_dress" },
    { label: "Outfits", type: "category", symbol: "clothes", load: "cat_outfit" },
    { label: "Back", type: "back", glyph: "←", load: "today" },
  ]});
  boards.push({ id: "choose_bottom", name: "Pants or shorts?", rows: 2, columns: 2, buttons: [
    { label: "Pants", type: "category", symbol: "trousers", load: "cat_pants" },
    // "shorts" has no ARASAAC bestsearch hit; 13638 IS the shorts pictogram
    // (dad 9/1: "the shorts image are pants" — both tiles wore the same jeans)
    { label: "Shorts", type: "category", symbol: "13638", load: "cat_shorts" },
    { label: "Back", type: "back", glyph: "←", load: "today" },
  ]});
  boards.push(...gridPages("cat_top", "Tops", items.filter(i => i.category === "top"), "today"));
  boards.push(...gridPages("cat_pants", "Pants", items.filter(i => i.category === "pants"), "choose_bottom"));
  boards.push(...gridPages("cat_shorts", "Shorts", items.filter(i => i.category === "shorts"), "choose_bottom"));
  boards.push(...gridPages("cat_dress", "Dresses", items.filter(i => i.category === "dress"), "build"));
  boards.push(...gridPages("cat_outfit", "Outfits", items.filter(i => i.category === "set"), "build"));
  return boards;
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

async function regenerate(force) {
  let files = [];
  try { files = fs.readdirSync(CLOTHING()).sort(); } catch {}
  const photos = files.filter(f =>
    [".heic", ".heif", ".jpg", ".jpeg", ".png"].includes(path.extname(f).toLowerCase()));
  const sig = new Date().toDateString() + "|" + (aiKey() ? "ai" : "none") + "|" + files.map(f => {
    try { return f + fs.statSync(path.join(CLOTHING(), f)).size; } catch { return f; }
  }).join(",");
  let prevSig = ""; try { prevSig = fs.readFileSync(SIG(), "utf8"); } catch {}
  if (!force && sig === prevSig) return { unchanged: true };

  const ing = await ingest(); // no-op without a key or when everything is already cataloged
  const busy = !!(ing && ing.busy);
  const quota = !!(ing && ing.quota);
  const cat = loadCatalog();
  const haveCatalog = Object.values(cat.items).some(i => i.ok);
  if (!haveCatalog) {
    clearPlainRecipe();
    const guidance = !photos.length ? (aiCfg() ? "no-photos" : "nothing")
                   : (aiCfg() ? (quota ? "ai-quota" : busy ? "ai-busy" : "ingest-failed") : "no-key");
    try { fs.writeFileSync(SIG(), sig); } catch {}
    return { guidance, photos: photos.length };
  }
  const boards = await buildCataloged(cat);
  fs.mkdirSync(RECIPES(), { recursive: true });
  fs.writeFileSync(path.join(RECIPES(), "today.json"), JSON.stringify({
    locale: "en-US", root: "today", home_label: "Clothing", boards }, null, 1));
  try { fs.writeFileSync(SIG(), sig); } catch {}
  console.log("[clothing] board built (" + boards.length + " boards)");
  return { built: boards.length, mode: "cataloged", photos: photos.length };
}

regenerate(!!workerData.force)
  .then((r) => { if (parentPort) parentPort.postMessage({ done: r }); })
  .catch((e) => {
    console.error("[clothing] worker: " + e.message);
    if (parentPort) parentPort.postMessage({ done: { error: e.message } });
  });
