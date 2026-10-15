// clothing-photos.js — the one place that knows what counts as a wardrobe
// photo and where to look. Shared by the worker (ingest/regenerate) and the
// status shell so they can never disagree about the count. Walks subfolders:
// people drop an album folder into Drive's clothing/, not loose files (QA
// 9/2). Returns paths RELATIVE to the clothing dir, forward-slashed, sorted —
// they double as the catalogue keys, so they must be stable across runs.
"use strict";
const fs = require("fs");
const path = require("path");

const EXT = new Set([".heic", ".heif", ".jpg", ".jpeg", ".png"]);

function listPhotos(dir) {
  const out = [];
  const walk = (rel) => {
    let ents = [];
    try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;   // Drive/macOS droppings (.DS_Store, ._IMG)
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && EXT.has(path.extname(e.name).toLowerCase())) out.push(r);
    }
  };
  walk("");
  return out.sort();
}

// The folder's photos as one string (names + sizes, one per line): what the
// shell's tick compares between looks, and what the worker stores beside
// .clothing-sig so a hub that reboots still sees a photo removed while it
// was down (I23). One function, so the two can never disagree by a byte.
function photoSet(dir) {
  return listPhotos(dir).map(f => {
    try { return f + ":" + fs.statSync(path.join(dir, f)).size; } catch { return f; }
  }).join("\n");
}
const PHOTOSET_FILE = ".clothing-photos";   // written by the worker next to .clothing-sig

module.exports = { listPhotos, photoSet, PHOTOSET_FILE, EXT };
