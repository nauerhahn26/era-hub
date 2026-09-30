// drawings.js — Drawing's pictures on the hub (spec docs/superpowers/specs/2026-09-30-drawing-design.md §4-§5).
//
// A picture is a folder drawings/<id>/ holding scene.json (the truth: backdrop + items) and, after
// Done, picture.png (for the family's mail and for a parent opening the Drive folder; the app
// never reads it). Ids are <YYYY-MM-DD>-<HHMMSS>-<device short> so two devices never make the
// same folder.
//
// THE FOUR RULES (clothing-log.js's laws, applied — spec §4). Each is a way to lose her picture.
//  1. OWN WRITES GO TO THE MOUNT when drive.json is local mode with a folderPath that exists:
//     <folderPath>/drawings/<id>/, .part + rename, then drive.mirrorDrawing(id) puts it on this
//     shelf at once. <DATA>/drawings is the mirror's destination.
//  2. CREATING <folderPath>/drawings/ IS ALLOWED (unlike clothing): nothing family-only ever lives
//     under <DATA>/drawings, so an empty source can only remove mirror-owned copies (drive.js).
//  3. NO MOUNT (Drive off, a fresh install, an offline mount): write <DATA>/drawings/<id>/ and mark
//     it .local. drive.js never prunes that folder and copies it up once a mount appears.
//  4. NOTHING HERE THROWS TO HER: a failed write is one console line and an {error} word; the
//     ring keeps the picture in memory + localStorage and retries on the next change.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const drive = require("./drive.js");

const ID_RE = /^\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9][a-z0-9-]{0,39}$/;
const LIMITS = { items: 200, sceneBytes: 64 * 1024, pngBytes: 4 * 1024 * 1024 };
const DAY = 24 * 60 * 60 * 1000;
const HEX = /^#[0-9a-fA-F]{6}$/;
const BY = ["ellie", "partner"];

let DATA = null;
let DEVICE = "hub";
let TZ = () => "UTC";
let NOW = () => new Date();
let TABLE = null;

function start(dataDir, opts = {}) {
  DATA = dataDir;
  if (opts.deviceId) DEVICE = String(opts.deviceId);
  if (typeof opts.tz === "function") TZ = opts.tz;
  if (typeof opts.now === "function") NOW = opts.now;
  const r = cleanupEmpty();
  if (r.removed.length) console.log("[drawings] cleared " + r.removed.length + " empty picture(s) older than a day");
  return r;
}

const isId = (s) => typeof s === "string" && ID_RE.test(s);
function shortDevice(id) {
  const s = String(id || "hub");
  return s.length <= 16 ? s : s.slice(0, 11).replace(/-+$/, "") + "-" + s.slice(-4);
}
// The same file the page draws its tiles from: one list of what a sticker may be.
function stickerTable() {
  if (TABLE) return TABLE;
  try { TABLE = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "drawing", "stickers.json"), "utf8")); }
  catch (e) { console.error("[drawings] stickers.json unreadable: " + e.message); return { stickers: [] }; }
  return TABLE;
}
const stamp = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : 0; };
const iso = () => NOW().toISOString();

// ---------------------------------------------------------------- where it lives
function mountRoot() {
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return null;
  try { if (!fs.statSync(st.folderPath).isDirectory()) return null; } catch { return null; }
  return path.join(st.folderPath, "drawings");
}
const shelfRoot = () => path.join(DATA, "drawings");
function taken(id) {
  return [mountRoot(), shelfRoot()].filter(Boolean).some((r) => fs.existsSync(path.join(r, id)));
}
function newId() {
  let p;
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ(), year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(NOW()).map((x) => [x.type, x.value]));
  } catch { return newIdUtc(); }
  return free(`${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}${p.second}-${shortDevice(DEVICE)}`);
}
function newIdUtc() {
  const s = NOW().toISOString();   // 2026-09-30T17:15:42.000Z
  return free(s.slice(0, 10) + "-" + s.slice(11, 13) + s.slice(14, 16) + s.slice(17, 19) + "-" + shortDevice(DEVICE));
}
function free(base) {
  for (let n = 1; n < 100; n++) { const id = n === 1 ? base : base + "-" + n; if (!taken(id)) return id; }
  return base + "-" + crypto.randomBytes(2).toString("hex");
}

// Rule 1 / rule 3 in one place. Never throws (rule 4).
function writeFile(id, name, buf) {
  const m = mountRoot();
  const dir = path.join(m || shelfRoot(), id);
  try {
    fs.mkdirSync(dir, { recursive: true });                  // rule 2: <folderPath>/drawings may be created
    if (!m) {
      const mk = path.join(dir, drive.LOCAL_MARKER);
      if (!fs.existsSync(mk)) fs.writeFileSync(mk, JSON.stringify({ device: DEVICE, since: iso() }) + "\n");
    }
    drive.atomically(path.join(dir, name), (tmp) => fs.writeFileSync(tmp, buf));
  } catch (e) {
    console.error("[drawings] " + id + "/" + name + " not written: " + e.message);
    return { ok: false };
  }
  if (m) {
    const r = drive.mirrorDrawing(id) || {};
    if (r.error || r.blocked || (r.errors || []).length)
      console.error("[drawings] " + id + " is in Drive but not on this shelf yet: " + (r.error || r.blocked || r.errors.join("; ")));
  }
  return { ok: true, mount: !!m };
}
const sceneBytes = (scene) => Buffer.from(JSON.stringify(scene, null, 1) + "\n");

function readScene(id) {
  if (!isId(id) || !DATA) return null;
  for (const root of [mountRoot(), shelfRoot()].filter(Boolean)) {
    try {
      const sc = JSON.parse(fs.readFileSync(path.join(root, id, "scene.json"), "utf8"));
      if (sc && typeof sc === "object" && !Array.isArray(sc)) return sc;
    } catch { /* not here, or half-written: try the next place */ }
  }
  return null;
}

// ---------------------------------------------------------------- validation
const num01 = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
function validateScene(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, why: "not an object" };
  if (obj.v !== 1) return { ok: false, why: "v must be 1" };
  if (obj.backdrop !== undefined && obj.backdrop !== "meadow") return { ok: false, why: "unknown backdrop" };
  if (!Array.isArray(obj.items)) return { ok: false, why: "items must be a list" };
  if (obj.items.length > LIMITS.items) return { ok: false, why: "more than " + LIMITS.items + " items" };
  const known = new Set(stickerTable().stickers.map((s) => s.id));
  const items = [];
  for (let i = 0; i < obj.items.length; i++) {
    const it = obj.items[i];
    if (!it || typeof it !== "object" || Array.isArray(it)) return { ok: false, why: `item ${i} is not an object` };
    if (!known.has(it.s)) return { ok: false, why: `item ${i}: unknown sticker` };
    if (!num01(it.x) || !num01(it.y)) return { ok: false, why: `item ${i}: x/y outside 0-1` };
    if (!num01(it.w) || it.w === 0) return { ok: false, why: `item ${i}: w outside (0,1]` };
    const by = it.by === undefined ? "ellie" : it.by;
    if (!BY.includes(by)) return { ok: false, why: `item ${i}: by` };
    const out = { s: it.s, x: it.x, y: it.y, w: it.w, by };
    if (it.s === "splat") {
      if (typeof it.c !== "string" || !HEX.test(it.c)) return { ok: false, why: `item ${i}: splat colour` };
      if (!Number.isInteger(it.seed) || it.seed < 0 || it.seed > 0xFFFFFFFF) return { ok: false, why: `item ${i}: splat seed` };
      out.c = it.c; out.seed = it.seed;
    }
    items.push(out);
  }
  return { ok: true, scene: { v: 1, backdrop: "meadow", items } };
}
const itemsHash = (items) => crypto.createHash("sha1").update(JSON.stringify(items)).digest("hex");

// ---------------------------------------------------------------- create / write
function create() {
  const id = newId(), t = iso();
  const scene = { v: 1, id, created: t, updated: t, device: DEVICE, backdrop: "meadow", items: [], mailedHash: null };
  return writeFile(id, "scene.json", sceneBytes(scene)).ok ? { id, scene } : { error: "write-failed" };
}
// The body brings backdrop + items; the hub owns id, created, device, updated and mailedHash.
function writeScene(id, body) {
  if (!isId(id)) return { error: "bad-id" };
  const v = validateScene(body);
  if (!v.ok) return { error: "bad-scene", why: v.why };
  const prev = readScene(id);
  const scene = { v: 1, id, created: (prev && prev.created) || iso(), updated: iso(),
                  device: (prev && prev.device) || DEVICE, backdrop: "meadow", items: v.scene.items,
                  mailedHash: (prev && prev.mailedHash) || null };
  const w = writeFile(id, "scene.json", sceneBytes(scene));
  return w.ok ? { ok: true, scene, mount: w.mount } : { error: "write-failed" };
}

// ---------------------------------------------------------------- the shelf
function list() {
  let names = [];
  try { names = fs.readdirSync(shelfRoot()); } catch { return []; }
  const out = [];
  for (const id of names) {
    if (!isId(id)) continue;                                   // conflict copies, notes, strays
    let sc;
    try { sc = JSON.parse(fs.readFileSync(path.join(shelfRoot(), id, "scene.json"), "utf8")); } catch { continue; }
    const v = validateScene(sc);
    if (!v.ok || !v.scene.items.length) continue;              // unreadable, foreign, or blank
    out.push({ id, created: sc.created || null, updated: sc.updated || sc.created || null,
               device: sc.device || null, items: v.scene.items.length, scene: { ...sc, items: v.scene.items } });
  }
  return out.sort((a, b) => stamp(b.updated) - stamp(a.updated) || stamp(b.created) - stamp(a.created)
                          || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

// A "New picture" she left blank never clutters any shelf: at boot, an EMPTY picture older than a
// day goes from the Drive folder and from this device. Anything unreadable is left alone.
function cleanupEmpty({ olderThanMs = DAY } = {}) {
  const removed = [];
  if (!DATA) return { removed };
  const now = NOW().getTime();
  for (const root of [mountRoot(), shelfRoot()].filter(Boolean)) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const id of names) {
      if (!isId(id)) continue;
      const dir = path.join(root, id);
      let sc;
      try { sc = JSON.parse(fs.readFileSync(path.join(dir, "scene.json"), "utf8")); } catch { continue; }
      if (!sc || !Array.isArray(sc.items) || sc.items.length) continue;
      let born = stamp(sc.created);
      if (!born) { try { born = fs.statSync(dir).mtimeMs; } catch { continue; } }
      if (now - born < olderThanMs) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(id); }
      catch (e) { console.error("[drawings] could not clear " + id + ": " + e.message); }
    }
  }
  return { removed };
}

module.exports = { ID_RE, LIMITS, start, isId, shortDevice, stickerTable, newId, validateScene, itemsHash,
                   mountRoot, readScene, create, writeScene, list, cleanupEmpty };
