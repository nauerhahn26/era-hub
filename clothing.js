// clothing.js — the Clothing Picker generator (dad 8/29: the board IS the
// clothing picker; every device generates its own board each morning from
// the photos in the family's Drive `clothing` folder, checked against the
// weather; picks are logged for sharing across devices).
//
// Pipeline, all local:
//   data/clothing/*.heic|jpg|png|webp  ->  data/clothing-web/*.jpg (HEIC
//   decoded with vendored libheif (LGPL, see NOTICE) + jpeg-js, downscaled)
//   ->  data/recipes/today.json in the board renderer's own schema (weather
//   tile + outfit tiles; the open board picks changes up by ETag poll).
// Weather: IP geolocation + Open-Meteo, both keyless; skipped gracefully
// offline (the board just has no weather tile that day).
"use strict";
const fs = require("fs");
const path = require("path");

let DATA = null;
let building = false;
let lastSig = "";

const CLOTHING = () => path.join(DATA, "clothing");
const WEB = () => path.join(DATA, "clothing-web");
const RECIPES = () => path.join(DATA, "recipes");

function isBuilding() { return building; }

// ---- HEIC -> JPG (vendored decoders; lazy-loaded, ~2MB asm.js) ----
let libheif = null, jpeg = null;
function ensureCodecs() {
  if (!libheif) libheif = require("./vendor/libheif.js")();
  if (!jpeg) jpeg = require("./vendor/jpeg-js");
}

function downscale(rgba, w, h, maxDim) {
  if (Math.max(w, h) <= maxDim) return { data: rgba, width: w, height: h };
  const s = maxDim / Math.max(w, h);
  const nw = Math.round(w * s), nh = Math.round(h * s);
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.round(y / s));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.round(x / s));
      const si = (sy * w + sx) * 4, di = (y * nw + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2]; out[di + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh };
}

async function heicToJpg(src, dest) {
  ensureCodecs();
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(fs.readFileSync(src));
  if (!images.length) throw new Error("no image in heic");
  const img = images[0];
  const w = img.get_width(), h = img.get_height();
  const rgba = await new Promise((resolve, reject) => {
    img.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h },
      (d) => d ? resolve(Buffer.from(d.data.buffer)) : reject(new Error("decode failed")));
  });
  img.free();
  const small = downscale(rgba, w, h, 900);
  fs.writeFileSync(dest, jpeg.encode(small, 82).data);
}

async function convertAll() {
  fs.mkdirSync(WEB(), { recursive: true });
  let entries = [];
  try { entries = fs.readdirSync(CLOTHING()); } catch { return []; }
  const out = [];
  for (const f of entries) {
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f, path.extname(f));   // strip the REAL extension (iPhones say .HEIC)
    const src = path.join(CLOTHING(), f);
    try {
      if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
        const dest = path.join(WEB(), f);
        if (!fs.existsSync(dest) || fs.statSync(dest).mtimeMs < fs.statSync(src).mtimeMs)
          fs.copyFileSync(src, dest);
        out.push(f);
      } else if ([".heic", ".heif"].includes(ext)) {
        const dest = path.join(WEB(), base + ".jpg");
        if (!fs.existsSync(dest) || fs.statSync(dest).mtimeMs < fs.statSync(src).mtimeMs)
          await heicToJpg(src, dest);
        out.push(base + ".jpg");
      }
    } catch (e) { console.error("[clothing] convert " + f + ": " + e.message); }
  }
  return out.sort();
}

// ---- weather (keyless; cached 3h; null when offline) ----
let weatherCache = null;
async function weather() {
  if (weatherCache && Date.now() - weatherCache.at < 3 * 3600e3) return weatherCache.tile;
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
    const w = await (await fetch("https://api.open-meteo.com/v1/forecast?" + q,
      { signal: AbortSignal.timeout(6000) })).json();
    const t = Math.round(w.daily.temperature_2m_max[0]);
    const code = w.daily.weather_code[0];
    const band = t >= 78 ? "hot" : t >= 66 ? "warm" : t >= 54 ? "cool" : "cold";
    const symbol = code <= 1 ? "sun" : code <= 48 ? "cloud" : code <= 67 ? "cloud" : "cold";
    const tile = {
      label: t + "° " + band, type: "control", symbol,
      say: "Today it is " + band + ", about " + t + " degrees.",
      footnote: "updated " + new Date().toLocaleString("en-US",
        { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      row: 1, col: 1,
    };
    weatherCache = { at: Date.now(), tile };
    return tile;
  } catch { return null; }
}

// ---- the board (renderer's own schema; 3x4 pages, rest cells left empty) ----
async function regenerate(force) {
  let files = [];
  try { files = fs.readdirSync(CLOTHING()).sort(); } catch {}
  const sig = new Date().toDateString() + "|" + files.map(f => {
    try { return f + fs.statSync(path.join(CLOTHING(), f)).size; } catch { return f; }
  }).join(",");
  if (!force && sig === lastSig) return { unchanged: true };
  if (!files.length) return { empty: true };
  building = true;
  try {
    const images = await convertAll();
    if (!images.length) return { empty: true };
    const wtile = await weather();
    const boards = [];
    const perPage = 9;   // 3x4 grid minus weather/back/More corners
    const pages = Math.max(1, Math.ceil(images.length / perPage));
    for (let p = 0; p < pages; p++) {
      const id = p === 0 ? "clothing" : "clothing-" + (p + 1);
      const buttons = [];
      if (p === 0 && wtile) buttons.push(wtile);
      if (p > 0) buttons.push({ label: "Back", say: "back", type: "back", glyph: "←",
        load: p === 1 ? "clothing" : "clothing-" + p, row: 1, col: 1 });
      const slice = images.slice(p * perPage, (p + 1) * perPage);
      let cell = 1;   // cells r1c2..r3c4 in reading order, skipping r3c1 (More)
      for (const img of slice) {
        const row = Math.floor(cell / 4) + 1, col = (cell % 4) + 1;
        buttons.push({ label: "This one", say: "I want to wear this one",
          type: "outfit", image: "clothing-web/" + img, row, col });
        cell++;
        if (cell === 8) cell++;   // r3c1 reserved for More
      }
      if (p < pages - 1) buttons.push({ label: "More", type: "control", symbol: "more",
        load: "clothing-" + (p + 2), row: 3, col: 1 });
      boards.push({ id, name: "What will I wear today?", rows: 3, columns: 4, buttons });
    }
    fs.mkdirSync(RECIPES(), { recursive: true });
    fs.writeFileSync(path.join(RECIPES(), "today.json"), JSON.stringify({
      locale: "en-US", root: "clothing", home_label: "Clothing", boards,
    }, null, 1));
    lastSig = sig;
    console.log("[clothing] board built: " + images.length + " outfits, " + pages + " page(s)" +
      (wtile ? ", weather " + wtile.label : ", no weather"));
    return { built: images.length };
  } finally { building = false; }
}

function start(dataDir) {
  DATA = dataDir;
  setTimeout(() => { regenerate(false).catch(e => console.error("[clothing] " + e.message)); }, 20 * 1000).unref();
  setInterval(() => { regenerate(false).catch(() => {}); }, 30 * 60 * 1000).unref();
}

module.exports = { start, regenerate, isBuilding };
