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

// Bring-your-own key, any of the big three (dad 8/30: "preferred LLM").
// Account LOGIN is not offered because the providers forbid it for
// third-party products (Anthropic's credential-use policy is explicit);
// keys are the sanctioned path. Cheapest vision model per provider, one
// call per new photo. ERA_AI_URL overrides every base URL (test seam).
const PROVIDERS = {
  anthropic: { base: "https://api.anthropic.com", model: "claude-haiku-4-5-20251001" },
  openai: { base: "https://api.openai.com", model: "gpt-5-mini" },
  google: { base: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash" },
};

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
    return { apiKey: c.apiKey, provider: PROVIDERS[c.provider] ? c.provider : "anthropic" };
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
function cropToContent(img, tol) {
  const { data, width: w, height: h } = img;
  const t = 255 - (tol || 16);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (data[i] < t || data[i + 1] < t || data[i + 2] < t) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return img;   // all white
  return cropRgba(img, { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h });
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
  '{"name": short shopping-style name like "Pink leggings" or "Heart print tee", ' +
  '"category": one of "top","pants","shorts","dress","set", ' +
  '"warmth": which daytime weather suits it best, one of "hot","warm","cool","cold","any", ' +
  '"rotate_deg": 0, 90, 180 or 270 clockwise so the item stands upright, ' +
  '"crop": {"x":0-1,"y":0-1,"w":0-1,"h":0-1} fractions of the UPRIGHT image tightly around the item with a little margin}';

async function askModel(cfg, jpgFile) {
  const b64 = fs.readFileSync(jpgFile).toString("base64");
  const p = PROVIDERS[cfg.provider];
  const base = process.env.ERA_AI_URL || p.base;
  let url, headers, body, extract;
  if (cfg.provider === "openai") {
    url = base + "/v1/chat/completions";
    headers = { "Authorization": "Bearer " + cfg.apiKey, "content-type": "application/json" };
    body = { model: p.model, max_completion_tokens: 300,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } },
        { type: "text", text: INGEST_PROMPT } ] }] };
    extract = (j) => j.choices[0].message.content;
  } else if (cfg.provider === "google") {
    url = base + "/v1beta/models/" + p.model + ":generateContent";
    headers = { "x-goog-api-key": cfg.apiKey, "content-type": "application/json" };
    body = { contents: [{ parts: [
        { inline_data: { mime_type: "image/jpeg", data: b64 } },
        { text: INGEST_PROMPT } ] }],
      generationConfig: { maxOutputTokens: 300 } };
    extract = (j) => j.candidates[0].content.parts.map(x => x.text || "").join("");
  } else {
    url = base + "/v1/messages";
    headers = { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
    body = { model: p.model, max_tokens: 300,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: INGEST_PROMPT } ] }] };
    extract = (j) => j.content.map(c => c.text || "").join("");
  }
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error("ai(" + cfg.provider + ") " + r.status + " " + (await r.text()).slice(0, 160));
  const txt = extract(await r.json());
  return JSON.parse(txt.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
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
  if (parentPort) parentPort.postMessage({ ingesting });
  try {
    for (const f of todo) {
      try {
        const full = await readImageRgba(path.join(CLOTHING(), f));
        const work = scaleRgba(full, 1100);
        const probe = path.join(ITEMS(), "_probe.jpg");
        writeJpg(scaleRgba(work, 700), probe, 80);
        const meta = await askModel(cfg, probe);
        const rot = [90, 180, 270].includes(meta.rotate_deg) ? meta.rotate_deg : 0;
        const id = "item_" + crypto.createHash("md5").update(f).digest("hex").slice(0, 10);
        writeJpg(padSquare(cropRgba(rotateRgba(work, rot), meta.crop || {}), 640),
          path.join(ITEMS(), id + ".jpg"), 85);
        cat.items[f] = { id, ok: true, name: String(meta.name || "Clothes").slice(0, 40),
          category: ["top", "pants", "shorts", "dress", "set"].includes(meta.category) ? meta.category : "top",
          warmth: ["hot", "warm", "cool", "cold", "any"].includes(meta.warmth) ? meta.warmth : "any" };
        saveCatalog(cat);   // survive a crash mid-batch: each item lands as it finishes
        console.log("[clothing] cataloged " + f + " -> " + cat.items[f].name + " (" + cat.items[f].category + ")");
      } catch (e) { console.error("[clothing] ingest " + f + ": " + e.message); }
      ingesting.done++;
      if (parentPort) parentPort.postMessage({ ingesting });
    }
  } finally {
    try { fs.rmSync(path.join(ITEMS(), "_probe.jpg"), { force: true }); } catch {}
    ingesting = null;
    if (parentPort) parentPort.postMessage({ ingesting });
  }
  return { done: todo.length };
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
function shortName(item) {
  const words = item.name.split(" ");
  return words.length <= 2 ? item.name : words.slice(-2).join(" ");
}

// 3x4 item pages (her cat_* style): Back r1c1, up to 11 items, More chains pages
function gridPages(id, name, items, backLoad) {
  const pages = [];
  const per = 11;
  for (let p = 0; p * per < items.length || p === 0; p++) {
    const pid = p === 0 ? id : id + "_" + (p + 1);
    const buttons = [{ label: "Back", type: "back", glyph: "←",
      load: p === 0 ? backLoad : (p === 1 ? id : id + "_" + p), row: 1, col: 1 }];
    let cell = 1;
    for (const it of items.slice(p * per, (p + 1) * per)) {
      buttons.push({ label: it.name, say: it.name, type: "clothing",
        image: "wardrobe-items/" + it.id + ".jpg",
        row: Math.floor(cell / 4) + 1, col: (cell % 4) + 1 });
      cell++;
    }
    if ((p + 1) * per < items.length)
      buttons.push({ label: "More", type: "control", symbol: "more", load: id + "_" + (p + 2), row: 3, col: 4 });
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
  // Layout per board-design-rules.md (dad 9/1): HARD CAP 6 outfits per page
  // (few real choices), STABLE slots so buttons never move, and empties form
  // the calm rest strip along the bottom row — never scattered mid-grid.
  //   [1,1] weather (Back on later pages)   [1,2][1,3][1,4] outfits 1-3
  //   [2,1][2,2][2,3] outfits 4-6           [2,4] More (when needed)
  //   [3,1..3,3] rest boxes                 [3,4] Build my own, every page
  const SLOTS = [[1,2],[1,3],[1,4],[2,1],[2,2],[2,3]];
  const boards = [];
  const pages = Math.max(1, Math.ceil(today.length / 6));
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
    today.slice(pg * 6, pg * 6 + 6).forEach((c, k) => {
      const i = pg * 6 + k;
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
    if ((pg + 1) * 6 < today.length)
      buttons.push({ label: "More", type: "control", symbol: "more", load: "today_" + (pg + 2), row: 2, col: 4 });
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
    { label: "Shorts", type: "category", symbol: "trousers", load: "cat_shorts" },
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

  await ingest(); // no-op without a key or when everything is already cataloged
  const cat = loadCatalog();
  const haveCatalog = Object.values(cat.items).some(i => i.ok);
  if (!haveCatalog) {
    clearPlainRecipe();
    const guidance = !photos.length ? (aiCfg() ? "no-photos" : "nothing")
                   : (aiCfg() ? "ingest-failed" : "no-key");
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
