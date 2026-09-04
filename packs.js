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
  // Adding a song from the web: yt-dlp, one standalone ~18 MB binary. Its own
  // pack because Music works fine without it (the songs already in the Drive
  // folder play), and a family that never adds one should not carry it. Not
  // in the repo — tools/yt-dlp.pin says which release, and the build fetches
  // and hash-checks it.
  "media-tools": ["vendor/yt-dlp"],
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

// Where the media-tools binary lives, and the two arguments every yt-dlp call
// on a family's PC needs. yt-dlp solves YouTube's JavaScript challenges in a
// real JS runtime; only "deno" is enabled by default and no family PC has one
// — but every New ERA install ships its own Node (node\node.exe, v22: above
// yt-dlp's 22.0.0 floor), and that is the very Node running this hub, so
// process.execPath IS the runtime.
// The option is RUNTIME[:PATH] and yt-dlp splits the value on its FIRST colon
// and uses the rest verbatim as the program to run — so the path is NOT
// quoted (a quote would become part of the filename) and "C:\..." survives.
// The space in "...\New ERA\node\node.exe" is safe because we spawn an argv
// array, never a shell command line.
function ytDlp(root, platform = process.platform) {
  const exe = platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  return {
    bin: path.join(root, "vendor", "yt-dlp", exe),
    args: ["--js-runtimes", "node:" + process.execPath],
  };
}

module.exports = { PACKS, packPaths, packInstalled, packOf, ytDlp };
