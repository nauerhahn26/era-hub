// clothing.js — the Clothing Picker, ported from Ellie's system (dad 8/29:
// "exactly like that"). Two halves:
//
//  INGEST (needs the family's AI key, once per new photo): each photo in
//  data/clothing is named, categorized (top/pants/shorts/dress/set), warmth-
//  rated, straightened, and tightly cropped by a small vision model; results
//  live in data/wardrobe.json plus one clean square tile per item. Without a
//  key the board falls back to plain photo tiles (v1 behavior).
//
//  DAILY GENERATION (no AI, pure local — same as Ellie's runs today):
//  weather (keyless APIs) -> suitable items -> novel top+bottom combos with
//  least-recently-shown rotation -> composite outfit images -> the exact
//  board graph her picker uses: today pages -> confirm_N (Yes / Change top /
//  Change bottoms) -> category boards -> Build my own.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const AI_URL = process.env.ERA_AI_URL || "https://api.anthropic.com";
const AI_MODEL = "claude-haiku-4-5-20251001"; // vision, cheap: one call per new photo

let DATA = null;
let building = false;
let ingesting = null; // {done, total} while naming photos
let lastSig = "";

const CLOTHING = () => path.join(DATA, "clothing");
const WEB = () => path.join(DATA, "clothing-web");
const ITEMS = () => path.join(DATA, "wardrobe-items");
const OUTFITS = () => path.join(DATA, "wardrobe-outfits");
const CATALOG = () => path.join(DATA, "wardrobe.json");
const HISTORY = () => path.join(DATA, "clothing-history.json");
const RECIPES = () => path.join(DATA, "recipes");

function isBuilding() { return building || !!ingesting; }
function status() {
  return { building, ingesting,
    cataloged: Object.values(loadCatalog().items || {}).filter(i => i.ok).length,
    aiConfigured: !!aiKey() };
}

function aiKey() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, "ai-config.json"), "utf8")).apiKey || ""; }
  catch { return ""; }
}
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

// side-by-side composite, her outfit-tile look: top on the left, bottom right
function composite(fileA, fileB, dest) {
  ensureCodecs();
  const W = 880, H = 460, HALF = 440;
  const out = { data: Buffer.alloc(W * H * 4, 255), width: W, height: H };
  const place = (file, ox) => {
    const d = jpeg.decode(fs.readFileSync(file), { formatAsRGBA: true });
    const s = scaleRgba({ data: Buffer.from(d.data), width: d.width, height: d.height }, 420);
    const oy = Math.floor((H - s.height) / 2), oxx = ox + Math.floor((HALF - s.width) / 2);
    for (let y = 0; y < s.height; y++)
      s.data.copy(out.data, ((oy + y) * W + oxx) * 4, y * s.width * 4, (y + 1) * s.width * 4);
  };
  place(fileA, 0);
  if (fileB) place(fileB, HALF);
  writeJpg(out, dest, 85);
}

// ---- ingest: one small vision call per new photo ----
async function askModel(key, jpgFile) {
  const b64 = fs.readFileSync(jpgFile).toString("base64");
  const r = await fetch(AI_URL + "/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: AI_MODEL, max_tokens: 300,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text:
          'This photo shows one clothing item (or a matching set) laid flat. Reply with ONLY a JSON object, no prose: ' +
          '{"name": short shopping-style name like "Pink leggings" or "Heart print tee", ' +
          '"category": one of "top","pants","shorts","dress","set", ' +
          '"warmth": which daytime weather suits it best, one of "hot","warm","cool","cold","any", ' +
          '"rotate_deg": 0, 90, 180 or 270 clockwise so the item stands upright, ' +
          '"crop": {"x":0-1,"y":0-1,"w":0-1,"h":0-1} fractions of the UPRIGHT image tightly around the item with a little margin}' } ] }],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error("ai " + r.status + " " + (await r.text()).slice(0, 160));
  const txt = (await r.json()).content.map(c => c.text || "").join("");
  return JSON.parse(txt.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
}

async function ingest() {
  const key = aiKey();
  if (!key) return { skipped: "no-ai-key" };
  const cat = loadCatalog();
  let files = [];
  try { files = fs.readdirSync(CLOTHING()).filter(f =>
    [".heic", ".heif", ".jpg", ".jpeg", ".png"].includes(path.extname(f).toLowerCase())); } catch {}
  const todo = files.filter(f => !cat.items[f] || !cat.items[f].ok);
  if (!todo.length) return { done: 0 };
  fs.mkdirSync(ITEMS(), { recursive: true });
  ingesting = { done: 0, total: todo.length };
  try {
    for (const f of todo) {
      try {
        const full = await readImageRgba(path.join(CLOTHING(), f));
        const work = scaleRgba(full, 1100);
        const probe = path.join(ITEMS(), "_probe.jpg");
        writeJpg(scaleRgba(work, 700), probe, 80);
        const meta = await askModel(key, probe);
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
    }
  } finally {
    try { fs.rmSync(path.join(ITEMS(), "_probe.jpg"), { force: true }); } catch {}
    ingesting = null;
  }
  return { done: todo.length };
}

// ---- weather (keyless; cached 3h; null offline = board just has no tile) ----
let weatherCache = null;
async function weather() {
  if (weatherCache && Date.now() - weatherCache.at < 3 * 3600e3) return weatherCache.w;
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
    weatherCache = { at: Date.now(), w };
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
    if (today.length >= 7) break;
    if (c.top && (usedTop.has(c.top.id) || usedBottom.has(c.bottom.id))) continue;
    today.push(c);
    if (c.top) { usedTop.add(c.top.id); usedBottom.add(c.bottom.id); }
  }
  for (const c of combos) {
    if (today.length >= 7) break;
    if (!today.includes(c)) today.push(c);
  }
  for (const c of today) hist.shown[c.key] = new Date().toISOString();
  saveHistory(hist);

  fs.mkdirSync(OUTFITS(), { recursive: true });
  const boards = [];
  const todayButtons = [];
  if (w) todayButtons.push({ label: w.t + "°  " + w.band, type: "control", symbol: w.symbol,
    say: "Today it is " + w.band + ", about " + w.t + " degrees.",
    footnote: "updated " + new Date().toLocaleString("en-US",
      { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    row: 1, col: 1 });
  today.forEach((c, i) => {
    const label = c.one ? c.one.name : shortName(c.top) + " + " + shortName(c.bottom);
    const say = c.one ? c.one.name : c.top.name + " and " + c.bottom.name;
    const img = "outfit_" + i + ".jpg";
    try {
      composite(path.join(ITEMS(), (c.one || c.top).id + ".jpg"),
        c.one ? null : path.join(ITEMS(), c.bottom.id + ".jpg"), path.join(OUTFITS(), img));
    } catch (e) { console.error("[clothing] composite: " + e.message); return; }
    const combo = c.one ? [c.one.id] : [c.top.id, c.bottom.id];
    todayButtons.push({ label, say, type: "outfit", image: "wardrobe-outfits/" + img,
      load: "confirm_" + i, say_on_load: true, combo });
    boards.push({ id: "confirm_" + i, name: "This one?", rows: 3, columns: 2, buttons: [
      { label, say, type: "outfit", image: "wardrobe-outfits/" + img, combo },
      { label: "Yes", type: "yes", symbol: "yes", say: "Yes", combo },
      { label: "Change top", type: "category", symbol: "shirt", load: "cat_top" },
      { label: "Change bottoms", type: "category", symbol: "trousers", load: "choose_bottom" },
      { label: "Back", type: "back", glyph: "←", load: "today" },
    ]});
  });
  todayButtons.push({ label: "Build my own", type: "category", symbol: "clothes", load: "build", row: 3, col: 4 });
  boards.unshift({ id: "today", name: "What will I wear today?", rows: 3, columns: 4, buttons: todayButtons });

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

// fallback when no AI key yet: plain photo tiles (v1 behavior)
async function convertPlain() {
  fs.mkdirSync(WEB(), { recursive: true });
  let entries = [];
  try { entries = fs.readdirSync(CLOTHING()); } catch { return []; }
  const out = [];
  for (const f of entries) {
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f, path.extname(f));
    try {
      if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
        const dest = path.join(WEB(), f);
        if (!fs.existsSync(dest)) fs.copyFileSync(path.join(CLOTHING(), f), dest);
        out.push(f);
      } else if ([".heic", ".heif"].includes(ext)) {
        const dest = path.join(WEB(), base + ".jpg");
        if (!fs.existsSync(dest)) writeJpg(scaleRgba(await readImageRgba(path.join(CLOTHING(), f)), 900), dest, 82);
        out.push(base + ".jpg");
      }
    } catch (e) { console.error("[clothing] convert " + f + ": " + e.message); }
  }
  return out.sort();
}

async function buildPlain() {
  const images = await convertPlain();
  if (!images.length) return null;
  const w = await weather();
  const boards = [];
  const perPage = 9;
  const pages = Math.max(1, Math.ceil(images.length / perPage));
  for (let p = 0; p < pages; p++) {
    const id = p === 0 ? "today" : "today_" + (p + 1);
    const buttons = [];
    if (p === 0 && w) buttons.push({ label: w.t + "°  " + w.band, type: "control", symbol: w.symbol,
      say: "Today it is " + w.band + ", about " + w.t + " degrees.", row: 1, col: 1 });
    if (p > 0) buttons.push({ label: "Back", type: "back", glyph: "←",
      load: p === 1 ? "today" : "today_" + p, row: 1, col: 1 });
    let cell = 1;
    for (const img of images.slice(p * perPage, (p + 1) * perPage)) {
      buttons.push({ label: "This one", say: "I want to wear this one", type: "outfit",
        image: "clothing-web/" + img, row: Math.floor(cell / 4) + 1, col: (cell % 4) + 1 });
      cell++;
    }
    if (p < pages - 1) buttons.push({ label: "More", type: "control", symbol: "more",
      load: "today_" + (p + 2), row: 3, col: 4 });
    boards.push({ id, name: "What will I wear today?", rows: 3, columns: 4, buttons });
  }
  return boards;
}

async function regenerate(force) {
  let files = [];
  try { files = fs.readdirSync(CLOTHING()).sort(); } catch {}
  const sig = new Date().toDateString() + "|" + (aiKey() ? "ai" : "plain") + "|" + files.map(f => {
    try { return f + fs.statSync(path.join(CLOTHING(), f)).size; } catch { return f; }
  }).join(",");
  if (!force && sig === lastSig) return { unchanged: true };
  if (!files.length) return { empty: true };
  building = true;
  try {
    await ingest(); // no-op without a key or when everything is already cataloged
    const cat = loadCatalog();
    const haveCatalog = Object.values(cat.items).some(i => i.ok);
    const boards = haveCatalog ? await buildCataloged(cat) : await buildPlain();
    if (!boards || !boards.length) return { empty: true };
    fs.mkdirSync(RECIPES(), { recursive: true });
    fs.writeFileSync(path.join(RECIPES(), "today.json"), JSON.stringify({
      locale: "en-US", root: "today", home_label: "Clothing", boards }, null, 1));
    lastSig = sig;
    console.log("[clothing] board built (" + (haveCatalog ? "cataloged" : "plain") + ", " + boards.length + " boards)");
    return { built: boards.length, mode: haveCatalog ? "cataloged" : "plain" };
  } finally { building = false; }
}

function start(dataDir) {
  DATA = dataDir;
  setTimeout(() => { regenerate(false).catch(e => console.error("[clothing] " + e.message)); }, 20 * 1000).unref();
  setInterval(() => { regenerate(false).catch(() => {}); }, 30 * 60 * 1000).unref();
}

module.exports = { start, regenerate, isBuilding, status };
