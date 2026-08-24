// era-hub server — serves the New ERA app modules + local APIs (settings, TTS
// proxy/cache, prediction, logging, board recipes). Local-first: binds
// 127.0.0.1 unless ERA_BIND says otherwise.
//   node server.js [port]     (default 8377)
// All state lives under the data dir (ERA_DATA_DIR, default ./data) — the
// family overlay. Logs append to <data>/logs/YYYY-MM-DD.jsonl.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.argv[2], 10) || 8377;
const BIND = process.env.ERA_BIND || "127.0.0.1";
const PUB = path.join(__dirname, "public");
const DATA = process.env.ERA_DATA_DIR || path.join(__dirname, "data");
const LOGS = path.join(DATA, "logs");
const TTS_CACHE = path.join(DATA, "tts-cache");
fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(TTS_CACHE, { recursive: true });
const crypto = require("crypto");
const predictor = require("./predict");

// child/family profile (name for messages, publish email, timezone) — overlay data
let PROFILE = {}, HAS_PROFILE = false, TZ = "America/Los_Angeles";
function loadProfile() {
  try {
    PROFILE = JSON.parse(fs.readFileSync(path.join(DATA, "profile.json"), "utf8"));
    HAS_PROFILE = true;
  } catch { PROFILE = {}; HAS_PROFILE = false; }
  TZ = PROFILE.tz || "America/Los_Angeles";
}
loadProfile();

// ---- family data pool (shared-data contract v1; see pool.js) ----
// Transition rule: legacy stores (logs/, wardrobe/history.json) stay canonical;
// the pool is DOUBLE-WRITTEN so it accrues real data before readers migrate.
const DEVICE_ID = process.env.ERA_DEVICE_ID || PROFILE.deviceId || "hub";
const pool = require("./pool").initPool(DATA, DEVICE_ID);
pool.heartbeat({ service: "era-hub" });
setInterval(() => pool.heartbeat({ service: "era-hub" }), 60 * 60 * 1000).unref();

// ---- board data paths: overlay data, read-only, path-jailed ----
const RECIPE_PATHS = [
  path.join(DATA, "recipes", "today.json"),
];
// ELLIE_WARDROBE_DIR: test override only — route tests point POST /outfit-event
// at a temp dir so they never touch the live history.json.
const WARDROBE_DIR = process.env.ELLIE_WARDROBE_DIR || path.join(DATA, "wardrobe");
const GEN_ASSETS_DIR = path.join(DATA, "gen-assets");
const BOOKS_DIR = path.join(DATA, "books");   // book packages (era-book-reader M3)
const MUSIC_DIR = path.join(DATA, "music");   // songs overlay (Songs Board 8/24)
const SYMBOLS_CACHE = path.join(DATA, "symbols-cache");
fs.mkdirSync(SYMBOLS_CACHE, { recursive: true });

// ARASAAC lookup ported from packages/generator/aac_board_designer.py
const ARASAAC_API = "https://api.arasaac.org/api/pictograms/en/bestsearch/";
const ARASAAC_IMG = "https://static.arasaac.org/pictograms/{id}/{id}_300.png";
const PREWARM = ["sun", "cloud", "cold", "more", "shirt", "trousers", "dress",
                 "clothes", "house", "clock", "snack", "back", "yes"];

// Serve a file from a jail dir if it exists, has an allowed extension, and does
// not escape the jail. `rest` is the raw (already URL-decoded) sub-path.
function serveJailed(res, dir, rest, allowedExts) {
  if (rest.includes("\0")) { res.writeHead(400).end(); return; }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(rest)) { res.writeHead(400).end(); return; }
  const file = path.normalize(path.join(dir, rest));
  if (file !== dir && !file.startsWith(dir + path.sep)) { res.writeHead(400).end(); return; }
  const ext = path.extname(file).toLowerCase();
  if (!allowedExts.includes(ext)) { res.writeHead(404).end("not found"); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream",
                         "Cache-Control": "no-cache" });
    res.end(data);
  });
}

// ---- book packages (era-book-reader M3): <DATA>/books/<slug>/ ----
// A package is complete iff manifest.json exists and parses (manifest written
// LAST by the exporter); manifest-less/unparseable dirs are skipped silently.
// Degraded law: missing books dir -> [] — never a crash.
function booksIndex() {
  let dirs = [];
  try { dirs = fs.readdirSync(BOOKS_DIR, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, d.name, "manifest.json"), "utf8"));
      const pages = Array.isArray(m.pages) ? m.pages : [];
      out.push({ slug: d.name, title: String(m.title || d.name),
                 cover: "/books/" + d.name + "/" + (m.cover || "cover.jpg"),
                 pages: pages.length, hasVideo: pages.some(p => p && p.video) });
    } catch {}   // incomplete package: skip silently
  }
  return out;
}

// GET /books/<slug>/... and /music/... — path-jailed static with an allowlist.
// Content is immutable, so media gets a long immutable Cache-Control; JSON
// manifests no-cache. A/V files get single-range HTTP Range support and are
// ALWAYS streamed (createReadStream), never buffered whole.
const BOOK_AV_EXTS = [".mp3", ".mp4", ".wav"];
const BOOK_EXTS = [".json", ".jpg", ".jpeg", ".png", ...BOOK_AV_EXTS];
const MUSIC_AV_EXTS = [".m4a", ".mp3", ".wav", ".webm", ".opus"];
const MUSIC_EXTS = [".json", ".jpg", ".jpeg", ".png", ".webp", ...MUSIC_AV_EXTS];
function serveBook(req, res, rest) { serveMediaJail(req, res, BOOKS_DIR, rest, BOOK_EXTS, BOOK_AV_EXTS); }
function serveMediaJail(req, res, jailDir, rest, allowedExts, avExts) {
  if (rest.includes("\0")) { res.writeHead(400).end(); return; }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(rest)) { res.writeHead(403).end(); return; }
  const file = path.normalize(path.join(jailDir, rest));
  if (file !== jailDir && !file.startsWith(jailDir + path.sep)) { res.writeHead(403).end(); return; }
  const ext = path.extname(file).toLowerCase();
  if (!allowedExts.includes(ext)) { res.writeHead(404).end("not found"); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("not found"); return; }
    const type = MIME[ext] || "application/octet-stream";
    if (ext === ".json") {                       // manifest.json: small, mutable view
      fs.readFile(file, (e, data) => {
        if (e) { res.writeHead(404).end("not found"); return; }
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
        res.end(data);
      });
      return;
    }
    const headers = { "Content-Type": type, "Cache-Control": "max-age=86400, immutable" };
    if (!avExts.includes(ext)) {                 // images: full streamed 200
      headers["Content-Length"] = st.size;
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
      return;
    }
    headers["Accept-Ranges"] = "bytes";
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (m && (m[1] !== "" || m[2] !== "")) {     // single range; malformed -> full 200
      let start, end;
      if (m[1] === "") {                         // suffix form: last N bytes
        const n = parseInt(m[2], 10);
        start = st.size - n; end = st.size - 1;
        if (n === 0) start = st.size;            // bytes=-0 is unsatisfiable
        if (start < 0) start = 0;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === "" ? st.size - 1 : Math.min(parseInt(m[2], 10), st.size - 1);
      }
      if (start >= st.size || start > end) {
        res.writeHead(416, { "Content-Range": "bytes */" + st.size }).end();
        return;
      }
      headers["Content-Range"] = "bytes " + start + "-" + end + "/" + st.size;
      headers["Content-Length"] = end - start + 1;
      res.writeHead(206, headers);
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    headers["Content-Length"] = st.size;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

// Pick whichever recipe path exists with the newest mtime; serve with ETag/304.
function serveRecipe(req, res) {
  let best = null;
  for (const p of RECIPE_PATHS) {
    try { const st = fs.statSync(p); if (!best || st.mtimeMs > best.st.mtimeMs) best = { p, st }; }
    catch {}
  }
  if (!best) { res.writeHead(404).end("not found"); return; }
  const etag = '"' + Math.floor(best.st.mtimeMs) + "-" + best.st.size + '"';
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-cache",
                    "ETag": etag, "Access-Control-Allow-Origin": "*" };
  if ((req.headers["if-none-match"] || "") === etag) { res.writeHead(304, headers).end(); return; }
  if (req.method === "HEAD") { res.writeHead(200, headers).end(); return; }
  fs.readFile(best.p, (err, data) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, headers); res.end(data);
  });
}

// ---- Songs Board recipe: GENERATED from <DATA>/music/manifest.json ----
// v2 (dad's 8/24 feedback round). GRID pages: 3x4, 7 song doors per page in
// rank order at the learned cells, center rests unpinned, More bottom-left,
// back (big <- glyph) top-left on later pages — NO Stop and NO exit tile on
// the grid (playback only happens inside a song page, so leaving it IS stop;
// the msgbar door remains the app exit). Each song door opens its SONG PAGE:
// the cover hero fills the LEFT HALF (row/col spans), right column = back
// arrow / Stop / Full song, far-right column all rest black (eye rest).
// Default play is a CLIP_MS clip (school: scratch the itch, not the day);
// "Full song" un-caps the running clip (or replays full) — deliberate extra
// effort by design. Per-song `v` = audio file mtime (client IDB cache key).
// ETag = manifest stat + RECIPE_REV (bump the rev when this generator's
// OUTPUT changes without a manifest change, or boards keep their 304 cache).
// page 1 has no chrome tiles at the corners (v3, dad 8/24): 9 songs. Later
// pages keep (1,1) for back, (3,4) rests: 7 songs.
const SONG_CELLS_P1 = [[1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [2, 4], [3, 2], [3, 3], [3, 4]];
const SONG_CELLS_PN = [[1, 2], [1, 3], [1, 4], [2, 1], [2, 4], [3, 2], [3, 3]];
const CLIP_MS = 40000;
const RECIPE_REV = 3;
const STOP_SYMBOL = "8289";   // exact ARASAAC id: the red STOP sign (bestsearch "stop" = a bus stop)
const FULL_SYMBOL = "music";  // sheet-music notes (verified via /symbol/music)
function songsRecipe() {
  const mp = path.join(MUSIC_DIR, "manifest.json");
  const st = fs.statSync(mp);                    // throws -> caller 404s
  const manifest = JSON.parse(fs.readFileSync(mp, "utf8"));
  const songs = (Array.isArray(manifest.songs) ? manifest.songs : [])
    .filter(s => s && s.id && s.audio)
    .map(s => {
      let v = 0;
      try { v = Math.floor(fs.statSync(path.join(MUSIC_DIR, s.audio)).mtimeMs); }
      catch { return null; }                     // audio file missing: skip the song
      return { ...s, v };
    })
    .filter(Boolean)
    .sort((a, b) => (a.rank || 0) - (b.rank || 0));
  const perP1 = SONG_CELLS_P1.length, perPN = SONG_CELLS_PN.length;
  const pages = songs.length <= perP1 ? 1 : 1 + Math.ceil((songs.length - perP1) / perPN);
  const boards = [];
  for (let p = 0; p < pages; p++) {
    const id = p === 0 ? "songs" : "songs-" + (p + 1);
    const cells = p === 0 ? SONG_CELLS_P1 : SONG_CELLS_PN;
    const from = p === 0 ? 0 : perP1 + (p - 1) * perPN;
    const buttons = [];
    if (p > 0) {
      buttons.push({ label: "Back", say: "back", type: "back", glyph: "←",
                     load: p === 1 ? "songs" : "songs-" + p, row: 1, col: 1 });
    }
    songs.slice(from, from + cells.length).forEach((s, i) => {
      const [row, col] = cells[i];
      buttons.push({ label: s.title, say: s.title, type: "song", song_id: s.id,
                     audio: "music/" + s.audio, v: s.v, clip_ms: CLIP_MS,
                     image: s.cover ? "music/" + s.cover : undefined,
                     load: "song-" + s.id,
                     duration: s.duration || 0, row, col });
    });
    if (p < pages - 1)
      buttons.push({ label: "More", type: "more", load: "songs-" + (p + 2), row: 3, col: 1 });
    boards.push({ id, name: "What do I want to hear?", rows: 3, columns: 4, buttons });
  }
  // one page per song: hero left half; back / Stop / Full song down col 3;
  // col 4 stays unpinned -> a full black rest column.
  songs.forEach((s, i) => {
    const gridPage = i < perP1 ? "songs"
                   : "songs-" + (Math.floor((i - perP1) / perPN) + 2);
    boards.push({
      id: "song-" + s.id, name: s.title, rows: 3, columns: 4,
      buttons: [
        { label: s.title, say: s.title, type: "song", song_id: s.id,
          audio: "music/" + s.audio, v: s.v, clip_ms: CLIP_MS,
          image: s.cover ? "music/" + s.cover : undefined,
          duration: s.duration || 0, row: 1, col: 1, row_span: 3, col_span: 2 },
        { label: "Back", say: "back", type: "back", glyph: "←",
          load: gridPage, row: 1, col: 3 },
        { label: "Stop", say: "stop", type: "stop", symbol: STOP_SYMBOL, row: 2, col: 3 },
        { label: "Full song", say: "full song", type: "full", song_id: s.id,
          symbol: FULL_SYMBOL,
          audio: "music/" + s.audio, v: s.v, row: 3, col: 3 },
      ],
    });
  });
  return {
    recipe: { locale: "en-US", root: "songs", home_label: "Songs", boards },
    etag: '"' + Math.floor(st.mtimeMs) + "-" + st.size + "-r" + RECIPE_REV + '"',
  };
}
function serveSongsRecipe(req, res) {
  let out;
  try { out = songsRecipe(); }
  catch { res.writeHead(404).end("not found"); return; }   // no music overlay: honest 404
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-cache",
                    "ETag": out.etag, "Access-Control-Allow-Origin": "*" };
  if ((req.headers["if-none-match"] || "") === out.etag) { res.writeHead(304, headers).end(); return; }
  if (req.method === "HEAD") { res.writeHead(200, headers).end(); return; }
  res.writeHead(200, headers);
  res.end(JSON.stringify(out.recipe));
}

// Fetch one symbol PNG from ARASAAC into the disk cache. Returns the file path
// on success, null on any failure (never throws).
async function fetchSymbolToCache(name) {
  const file = path.join(SYMBOLS_CACHE, name + ".png");
  try {
    let id;
    if (/^\d+$/.test(name)) {
      id = name;   // exact ARASAAC pictogram id (recipes pin one when bestsearch
                   // guesses wrong — "stop" finds a bus stop; 8289 IS the stop sign)
    } else {
      const r = await fetch(ARASAAC_API + encodeURIComponent(name));
      if (!r.ok) return null;
      const hits = await r.json();
      if (!Array.isArray(hits) || !hits.length) return null;
      id = hits[0]._id;
    }
    const img = await fetch(ARASAAC_IMG.replace(/\{id\}/g, String(id)));
    if (!img.ok) return null;
    const buf = Buffer.from(await img.arrayBuffer());
    fs.writeFileSync(file, buf);
    return file;
  } catch (e) {
    console.error("[symbol] lookup failed for '" + name + "': " + e.message);
    return null;
  }
}

// GET /symbol/:name — cached PNG, fetching from ARASAAC on a miss.
async function serveSymbol(res, name) {
  if (!/^[a-z0-9-]+$/.test(name)) { res.writeHead(404).end("not found"); return; }
  const file = path.join(SYMBOLS_CACHE, name + ".png");
  let cached = fs.existsSync(file);
  if (!cached) {
    const got = await fetchSymbolToCache(name);
    if (!got) { console.error("[symbol] no match for '" + name + "'"); res.writeHead(404).end("not found"); return; }
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400",
                         "X-Symbol-Cache": cached ? "hit" : "miss" });
    res.end(data);
  });
}

// ---- ElevenLabs TTS (proxied + cached; falls back to Windows TTS client-side) ----
// Key: put ELEVENLABS_API_KEY=... in tts-config.json ("apiKey") or the environment.
const TTS_CFG_PATH = path.join(DATA, "tts-config.json");
const CURATED_VOICES = [
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica — playful American" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah — soft & warm" },
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel — calm narrator" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda — friendly" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily — warm British" }
];
function loadTtsCfg() {
  let cfg = { apiKey: process.env.ELEVENLABS_API_KEY || "", voiceId: CURATED_VOICES[0].id,
              modelId: "eleven_flash_v2_5" };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(TTS_CFG_PATH, "utf8")) }; } catch {}
  if (!cfg.apiKey && process.env.ELEVENLABS_API_KEY) cfg.apiKey = process.env.ELEVENLABS_API_KEY;
  return cfg;
}
function saveTtsCfg(cfg) { fs.writeFileSync(TTS_CFG_PATH, JSON.stringify(cfg, null, 2)); }
async function elevenTts(cfg, text) {
  const key = crypto.createHash("sha1").update(cfg.voiceId + "|" + cfg.modelId + "|" + text).digest("hex");
  const file = path.join(TTS_CACHE, key + ".mp3");
  if (fs.existsSync(file)) return fs.readFileSync(file);       // repeat lines are free
  const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + cfg.voiceId +
                        "?output_format=mp3_22050_32", {
    method: "POST",
    headers: { "xi-api-key": cfg.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: cfg.modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
  });
  if (!r.ok) throw new Error("elevenlabs " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
               ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
               ".woff2": "font/woff2", ".mp3": "audio/mpeg",
               ".mp4": "video/mp4", ".wav": "audio/wav",
               ".m4a": "audio/mp4", ".webm": "audio/webm", ".opus": "audio/ogg",
               ".webp": "image/webp",
               ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

// ---- email published writing to the family (optional; Resend key + recipient
// come from the overlay data dir, never from this repo) ----
function resendKey() {
  try {
    const env = fs.readFileSync(path.join(DATA, "credentials.env"), "utf8");
    const m = env.match(/^RESEND_API_KEY=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}
async function emailWriting(rec) {
  const key = resendKey(), to = PROFILE.publishEmail;
  if (!key || !to) { console.error("[mail] no RESEND_API_KEY/publishEmail configured; writing saved only"); return; }
  const who = PROFILE.childName || "your writer";
  const when = new Date(rec.t || Date.now()).toLocaleString("en-US", { timeZone: TZ });
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "The Pencil <onboarding@resend.dev>",
      to: [to],
      subject: "✏️ " + who + " wrote: \u201C" + String(rec.text).slice(0, 60) + "\u201D",
      html: "<div style=\"font-family:Georgia,serif\">" +
            "<p style=\"font-size:28px;line-height:1.5\">\u201C" + String(rec.text) + "\u201D</p>" +
            "<p style=\"color:#777\">— " + who + ", with The Pencil · " + when + "</p>" +
            "<p style=\"color:#999;font-size:13px\">Write back — a young writer loves an audience that answers.</p></div>"
    })
  });
  if (!r.ok) throw new Error("resend " + r.status + " " + (await r.text()).slice(0, 120));
  console.log("[mail] sent:", String(rec.text).slice(0, 40));
}

function safeDecode(u) {
  try { return decodeURIComponent(u); } catch { return null; }
}
// ---- Book Reader dwell mirror (one knob) ----
// Book Reader (separate Next.js/Vercel stack) keeps its own per-child dwell
// in Supabase; its HTTPS pages cannot fetch this HTTP server (mixed content),
// so the ONE dwell knob propagates the other way — a settings-page change
// pushes dwell_ms into child_profiles server-side. Fire-and-forget: the
// reader falls back to its stored value whenever this fails. Creds are read
// at call time from Book-Reader's own .env.local (never committed here).
const READER_ENV = process.env.ERA_READER_ENV || require("path").join(DATA, "reader.env");
function pushReaderDwell(ms) {
  let env = {};
  try {
    for (const line of fs.readFileSync(READER_ENV, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch { return; }
  const url = env.NEXT_PUBLIC_SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  fetch(url + "/rest/v1/child_profiles?id=not.is.null", {
    method: "PATCH",
    headers: { apikey: key, Authorization: "Bearer " + key,
               "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ dwell_ms: Math.max(600, Math.min(3000, ms)) }),
  }).then(r => { if (!r.ok) console.error("reader dwell push failed:", r.status); })
    .catch(e => console.error("reader dwell push failed:", e.message));
}

const server = http.createServer((req, res) => {
  // shared app settings (dwell time, chosen voice) — apps read at boot
  if (req.method === "GET" && req.url === "/settings") {
    let s = { dwellMs: 1200, settleMs: 250, voiceId: loadTtsCfg().voiceId,
              childName: PROFILE.childName || "friend", hasProfile: HAS_PROFILE,
              personalWords: [] };
    try {
      const lex = JSON.parse(fs.readFileSync(path.join(DATA, "personal-lexicon.json"), "utf8"));
      if (Array.isArray(lex)) s.personalWords = lex.map(w => typeof w === "string" ? w : w.word).filter(Boolean);
    } catch {}
    try { s = { ...s, ...JSON.parse(fs.readFileSync(path.join(DATA, "app-settings.json"), "utf8")) }; } catch {}
    s.voiceId = loadTtsCfg().voiceId;
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(s));
    return;
  }
  if (req.method === "POST" && req.url === "/settings") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const inc = JSON.parse(body);
        let s = {};
        try { s = JSON.parse(fs.readFileSync(path.join(DATA, "app-settings.json"), "utf8")); } catch {}
        if (typeof inc.dwellMs === "number") s.dwellMs = Math.max(600, Math.min(3000, inc.dwellMs));
        if (typeof inc.settleMs === "number") s.settleMs = Math.max(0, Math.min(2000, inc.settleMs));
        fs.writeFileSync(path.join(DATA, "app-settings.json"), JSON.stringify(s, null, 2));
        // one knob: mirror a dwell change into Book Reader's profile store
        if (typeof inc.dwellMs === "number") pushReaderDwell(s.dwellMs);
        if (inc.voiceId && CURATED_VOICES.some(v => v.id === inc.voiceId)) {
          const cfg = loadTtsCfg(); cfg.voiceId = inc.voiceId; saveTtsCfg(cfg);
        }
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  // first-run wizard: create the family profile (idempotent — updates too)
  if (req.method === "POST" && req.url === "/setup") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const inc = JSON.parse(body);
        const name = String(inc.childName || "").trim().slice(0, 40);
        if (!name) { res.writeHead(400).end("childName required"); return; }
        let cur = {};   // merge from DISK — other tools may have written keys
        try { cur = JSON.parse(fs.readFileSync(path.join(DATA, "profile.json"), "utf8")); } catch {}
        const prof = { ...cur, childName: name };
        if (inc.tz && typeof inc.tz === "string") prof.tz = inc.tz.slice(0, 60);
        if (inc.deviceId && /^[a-z0-9-]{1,32}$/.test(inc.deviceId)) prof.deviceId = inc.deviceId;
        fs.writeFileSync(path.join(DATA, "profile.json"), JSON.stringify(prof, null, 2) + "\n");
        loadProfile();
        if (typeof inc.dwellMs === "number") {
          let a = {}; try { a = JSON.parse(fs.readFileSync(path.join(DATA, "app-settings.json"), "utf8")); } catch {}
          a.dwellMs = Math.max(600, Math.min(3000, inc.dwellMs));
          fs.writeFileSync(path.join(DATA, "app-settings.json"), JSON.stringify(a, null, 2));
        }
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  if (req.method === "GET" && req.url === "/voices") {
    const cfg = loadTtsCfg();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ enabled: !!cfg.apiKey, current: cfg.voiceId, voices: CURATED_VOICES }));
    return;
  }
  if (req.method === "POST" && req.url === "/voice") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const { voiceId } = JSON.parse(body);
        if (!CURATED_VOICES.some(v => v.id === voiceId)) { res.writeHead(400).end(); return; }
        const cfg = loadTtsCfg(); cfg.voiceId = voiceId; saveTtsCfg(cfg);
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/tts") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on("end", async () => {
      try {
        const { text } = JSON.parse(body);
        const cfg = loadTtsCfg();
        if (!cfg.apiKey || !text || text.length > 600) { res.writeHead(503).end(); return; }
        const buf = await elevenTts(cfg, String(text));
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "max-age=86400" });
        res.end(buf);
      } catch (e) { res.writeHead(502).end(); }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/runway") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const { pointer } = JSON.parse(body);
        const rp = path.join(PUB, "runway.json");
        const rw = JSON.parse(fs.readFileSync(rp, "utf8"));
        if (typeof pointer !== "number" || pointer < 0 || pointer >= rw.sequence.length) { res.writeHead(400).end(); return; }
        rw.pointer = pointer;
        fs.writeFileSync(rp, JSON.stringify(rw, null, 1));
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/publish") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 65536) req.destroy(); });
    req.on("end", async () => {
      try {
        const rec = JSON.parse(body);
        const dir = path.join(DATA, "writings");
        fs.mkdirSync(dir, { recursive: true });
        const name = new Date().toISOString().replace(/[:.]/g, "-") + ".json";
        fs.writeFileSync(path.join(dir, name), JSON.stringify(rec, null, 2));
        res.writeHead(204).end();          // never make her wait on email delivery
        emailWriting(rec).catch(e => console.error("[mail]", e.message));
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  // ---- board outfit events: picks -> history.json (feeds the generator) ----
  // The 6:35 generator derives wear from these (a Yes = confirmed; otherwise the
  // day's last select is inferred at half weight) to seat the staple slots.
  if (req.method === "POST" && req.url === "/outfit-event") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const { kind, combo } = JSON.parse(body);
        const ok = (kind === "select" || kind === "yes") &&
          Array.isArray(combo) && combo.length >= 1 && combo.length <= 2 &&
          combo.every(id => typeof id === "string" && /^item_[0-9a-f]{4,32}$/.test(id));
        if (!ok) { res.writeHead(400).end(); return; }
        const day = new Date().toLocaleDateString("en-CA", { timeZone: TZ });  // family-profile tz buckets the day
        const hp = path.join(WARDROBE_DIR, "history.json");
        let h = {};
        try { h = JSON.parse(fs.readFileSync(hp, "utf8")); } catch {}
        if (typeof h !== "object" || h === null || Array.isArray(h)) h = {};
        h.events = h.events || {};
        const evs = h.events[day] = h.events[day] || [];
        // cap per day: a stuck client can't grow the file unboundedly
        if (evs.length < 200) evs.push({ kind, combo, at: new Date().toISOString() });
        fs.writeFileSync(hp, JSON.stringify(h, null, 2) + "\n");
        pool.append("outfit-" + kind, { combo });
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  // ---- songs board events: play/stop/end -> family pool (usage visibility) ----
  if (req.method === "POST" && req.url === "/music-event") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const { songId, action } = JSON.parse(body);
        const ok = ["play", "stop", "end", "full"].includes(action) &&
          typeof songId === "string" && /^[a-z0-9-]{1,64}$/.test(songId);
        if (!ok) { res.writeHead(400).end(); return; }
        pool.append("music-" + action, { songId });
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/log") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 65536) req.destroy(); });
    req.on("end", () => {
      try {
        JSON.parse(body); // validate
        const day = new Date().toISOString().slice(0, 10);
        fs.appendFileSync(path.join(LOGS, day + ".jsonl"), body.replace(/\n/g, " ") + "\n");
        pool.append("app-log", { entry: JSON.parse(body) });
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  // ---- board data routes (GET/HEAD, read-only, path-jailed) ----
  const urlPath = safeDecode((req.url || "/").split("?")[0]);
  if (urlPath === null) { res.writeHead(400).end(); return; }
  // ---- word prediction (Pencil; see predict.js — her writing > her lexicon > corpus) ----
  if (req.method === "GET" && urlPath === "/predict") {
    try {
      const q = new URL(req.url, "http://x").searchParams;
      const n = Math.min(8, parseInt(q.get("n"), 10) || 3);
      const words = predictor.predict(q.get("left") || "", q.get("prefix") || "", n);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ words }));
    } catch (e) {
      console.error("[predict] " + e.message);
      try { res.writeHead(200, { "Content-Type": "application/json" }).end('{"words":[]}'); } catch {}
    }
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && urlPath === "/recipes/today.json") {
    serveRecipe(req, res); return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && urlPath === "/recipes/songs.json") {
    serveSongsRecipe(req, res); return;
  }
  if (req.method === "GET" && urlPath.startsWith("/music/")) {
    serveMediaJail(req, res, MUSIC_DIR, urlPath.slice("/music/".length), MUSIC_EXTS, MUSIC_AV_EXTS);
    return;
  }
  if (req.method === "GET" && urlPath.startsWith("/wardrobe/")) {
    serveJailed(res, WARDROBE_DIR, urlPath.slice("/wardrobe/".length), [".jpg", ".jpeg", ".png"]);
    return;
  }
  if (req.method === "GET" && urlPath.startsWith("/gen-assets/")) {
    serveJailed(res, GEN_ASSETS_DIR, urlPath.slice("/gen-assets/".length), [".png"]);
    return;
  }
  // ---- book packages: shelf index (rebuilt per request) + jailed files ----
  if (req.method === "GET" && urlPath === "/books/index.json") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(booksIndex()));
    return;
  }
  if (req.method === "GET" && urlPath.startsWith("/books/")) {
    serveBook(req, res, urlPath.slice("/books/".length));
    return;
  }
  if (req.method === "GET" && urlPath.startsWith("/symbol/")) {
    serveSymbol(res, urlPath.slice("/symbol/".length)).catch((e) => {
      console.error("[symbol] route error: " + e.message);
      try { res.writeHead(500).end(); } catch {}
    });
    return;
  }

  // static
  let p = safeDecode((req.url || "/").split("?")[0]);
  if (p === null) { res.writeHead(400).end(); return; }
  if (p.endsWith("/")) p += "index.html";
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
                         "Cache-Control": "no-cache" });
    res.end(data);
  });
});
server.listen(PORT, BIND, () => {
  console.log("era-hub on http://" + BIND + ":" + PORT);
  // Pre-warm the outfit symbol set in the background (non-blocking, best-effort).
  for (const name of PREWARM) {
    if (fs.existsSync(path.join(SYMBOLS_CACHE, name + ".png"))) continue;
    fetchSymbolToCache(name).then(f => { if (f) console.log("[symbol] pre-warmed " + name); });
  }
});
