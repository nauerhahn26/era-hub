// packs.js — what each optional app puts on disk, in ONE place. The
// installer's checkboxes (tools/installer.nsi mirrors this list by hand — a
// gate test keeps them equal), the hub's enable-later download, the
// Settings "remove" path and the self-update overlay all read it, so an app
// the family did not tick is never laid down by a side door.
//
// The Clothing Picker's garment cut-out (ONNX runtime + u2netp model + the
// HEIC decoder, ~21 MB) belongs to its pack, not the engine: dad 9/3, on the
// installer's components page — "when you reduce the apps you install the
// size stays the same". Now unticking Clothing/Music/Movies really drops it.
"use strict";
const fs = require("fs");
const path = require("path");

// pack id -> paths relative to the suite root; the FIRST entry is the pack's
// presence marker (what "installed" means).
const PACKS = {
  pencil: ["public/pencil"],
  reader: ["public/reader"],
  board: ["public/board", "vendor/onnxruntime-web", "vendor/models", "vendor/libheif.js"],
};

function packPaths(pack) { return PACKS[pack] || []; }
function packInstalled(root, pack) {
  const p = packPaths(pack);
  return p.length > 0 && fs.existsSync(path.join(root, ...p[0].split("/")));
}
// is `rel` (a path relative to the suite root, either separator) inside a pack?
// returns the pack id or null.
function packOf(rel) {
  const r = rel.split(path.sep).join("/");
  for (const [id, paths] of Object.entries(PACKS))
    if (paths.some(p => r === p || r.startsWith(p + "/"))) return id;
  return null;
}

module.exports = { PACKS, packPaths, packInstalled, packOf };
