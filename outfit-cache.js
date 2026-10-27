// outfit-cache.js — the content-keyed store of outfit composites.
//
// Every board build draws one 840x560 picture per dealt look (clothing-worker
// composite), and almost every one of them is the same picture the last build
// drew: a weather re-sort, a sync, a restart, tomorrow's deal sharing most of
// today's pairs. Decoding two tiles, fitting and re-encoding is the expensive
// part, so a picture is drawn once per CONTENT and copied after that.
//
// Key: a digest of the layout constant, tile A's bytes and tile B's bytes (or
// "solo"), so a re-ingested or re-rotated tile is a new key, never a stale hit.
// Store: <outfits>/.cache/<key>.jpg, written to a temp name and renamed. A look
// is produced by COPYING the stored file to outfit_<i>.jpg (plain files, no
// hardlinks: the folder may be mirrored). The store is never fed from an
// outfit_<i>.jpg: the build overwrites those in place (the new outfit_0 may be
// the old outfit_5 while the new outfit_5 is the old outfit_0).
// Index: <outfits>/.composites.json records the keys this build and the build
// before it used; finish() keeps exactly those (so a day-to-day flip does not
// thrash) and never more than `cap` files, oldest-used first.
// Any cache failure — an unreadable index, a missing or empty stored file, a
// store that cannot be written — falls back to drawing the look straight to
// its destination, as before the cache existed. It never leaves a look
// missing or black (QA 9/2: a missing composite was a black screen).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const INDEX = ".composites.json";
const STORE = ".cache";
const CAP = 400;
const KEY_FILE = /^[0-9a-f]{64}\.jpg$/;
const STALE_TMP_MS = 10 * 60 * 1000;

function compositeKey(layout, bufA, bufB) {
  const h = crypto.createHash("sha256");
  h.update(String(layout)); h.update("\0");
  h.update(bufA); h.update("\0");
  if (bufB) h.update(bufB); else h.update("solo");
  return h.digest("hex");
}

function readIndex(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j || typeof j !== "object") return null;
    const keys = (a) => Array.isArray(a) ? a.filter(k => typeof k === "string" && /^[0-9a-f]{64}$/.test(k)) : [];
    const entries = j.entries && typeof j.entries === "object" && !Array.isArray(j.entries) ? j.entries : {};
    return { last: keys(j.last), prev: keys(j.prev), entries };
  } catch { return null; }
}

// openCompositeCache(outfitsDir, { layout, cap }) -> { produce, finish }
//   produce(fileA, fileB|null, dest, draw): draw(bufA, bufB|null, file) writes
//     the picture to `file`. Returns "reused" or "drawn". Throws only what
//     reading a tile or drawing throws — the caller's error path, unchanged.
//   finish(): prune and write the index; returns { drawn, reused }.
function openCompositeCache(dir, opts = {}) {
  const layout = opts.layout || "";
  const cap = Number.isInteger(opts.cap) && opts.cap > 0 ? opts.cap : CAP;
  const store = path.join(dir, STORE);
  const indexFile = path.join(dir, INDEX);
  const old = readIndex(indexFile) || { last: [], prev: [], entries: {} };
  const used = [];                 // this build's keys, in first-use order
  const seen = new Set();
  const entries = {};              // key -> { size, at } for this build's keys
  let drawn = 0, reused = 0;
  let storeOk = true;
  try { fs.mkdirSync(store, { recursive: true }); } catch { storeOk = false; }

  const remember = (key, size) => {
    entries[key] = { size, at: Date.now() };
    if (!seen.has(key)) { seen.add(key); used.push(key); }
  };

  function produce(fileA, fileB, dest, draw) {
    const bufA = fs.readFileSync(fileA);
    const bufB = fileB ? fs.readFileSync(fileB) : null;
    const key = compositeKey(layout, bufA, bufB);
    const cached = path.join(store, key + ".jpg");
    if (storeOk) {
      try {
        const st = fs.statSync(cached);
        const want = old.entries[key] && old.entries[key].size;
        if (st.isFile() && st.size > 0 && (!Number.isInteger(want) || want === st.size)) {
          fs.copyFileSync(cached, dest);
          remember(key, st.size);
          reused++;
          return "reused";
        }
      } catch { /* a miss */ }
      try {
        const tmp = path.join(store, key + "." + process.pid + "-" + crypto.randomBytes(4).toString("hex") + ".tmp");
        try {
          draw(bufA, bufB, tmp);
          const size = fs.statSync(tmp).size;
          if (!(size > 0)) throw new Error("empty composite");
          fs.renameSync(tmp, cached);
          fs.copyFileSync(cached, dest);
          remember(key, size);
          drawn++;
          return "drawn";
        } finally { try { fs.unlinkSync(tmp); } catch { /* renamed or never written */ } }
      } catch { /* the store failed: draw straight to the look below */ }
    }
    draw(bufA, bufB, dest);
    drawn++;
    return "drawn";
  }

  function finish() {
    if (!storeOk) return { drawn, reused };
    try {
      // The same set again (a re-sort, a restart) is not a new generation:
      // keep the generation before it, or two same-day builds would forget
      // yesterday.
      const sameAsLast = used.length === old.last.length && old.last.every(k => seen.has(k));
      const prev = sameAsLast ? old.prev : old.last;
      const prevSet = new Set(prev);
      let names = [];
      try { names = fs.readdirSync(store); } catch { names = []; }
      const present = new Set(names.filter(n => KEY_FILE.test(n)).map(n => n.slice(0, -4)));
      const at = (k) => (entries[k] || old.entries[k] || {}).at || 0;
      const keep = [...used.filter(k => present.has(k)),
                    ...prev.filter(k => !seen.has(k) && present.has(k)).sort((a, b) => at(b) - at(a))]
        .slice(0, cap);
      const keepSet = new Set(keep);
      const now = Date.now();
      for (const n of names) {
        const p = path.join(store, n);
        if (KEY_FILE.test(n)) { if (!keepSet.has(n.slice(0, -4))) { try { fs.unlinkSync(p); } catch {} } continue; }
        // a temp a crashed build left behind; a fresh one may be a live draw
        try { if (now - fs.statSync(p).mtimeMs > STALE_TMP_MS) fs.rmSync(p, { recursive: true, force: true }); } catch {}
      }
      const idx = { v: 1, layout, last: used.filter(k => keepSet.has(k)),
                    prev: prev.filter(k => keepSet.has(k) && !seen.has(k)), entries: {} };
      for (const k of keep) {
        const e = entries[k] || old.entries[k];
        if (e && Number.isInteger(e.size)) idx.entries[k] = { size: e.size, at: e.at || 0 };
      }
      const tmp = indexFile + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(idx));
      fs.renameSync(tmp, indexFile);
    } catch { /* an index that cannot be written is a cold cache next time, nothing worse */ }
    return { drawn, reused };
  }

  return { produce, finish };
}

module.exports = { openCompositeCache, compositeKey, CAP, INDEX, STORE };
