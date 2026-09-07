// content-gather.js — the pile of photos a parent dropped straight into
// `books/` without making a folder first (dad, 9/7: "I didn't put into, like, a
// folder and name it. I think that the system should be smart enough to say,
// okay, these all belong to a single book, because I just uploaded a bunch —
// you should assume they are, and let me say otherwise").
//
// Until this, `books/` was a list of folders and nothing else: content.js walked
// books-index.js's directory list, loose files were invisible, no job was ever
// claimed, nothing was built, and the Book Reader kept showing "Add books with
// Google Drive — set it up in Settings" at a family whose Drive was set up
// perfectly. This module is the missing step: ONE pile becomes ONE book folder.
//
// Everything here is DISK ONLY — no network, no key, no model, no clock beyond
// the one it is handed. The guess about which book these photos are (the title)
// is content-providers.titleOf's, taken after ingest has made a page image out
// of the cover; this file only ever writes the placeholder name that folder is
// born with and does the renaming afterwards.
//
// FOUR RULES, and each of them is a way to lose a family's only copy of a
// photograph of a page of a paper book:
//
//  1. A PHOTO IS MOVED, NEVER DELETED, NEVER CONVERTED. `moveIn` renames, and
//     falls back to copy+unlink for a folder on another volume — the same two
//     lines content-ingest.js moves originals into `sources/` with. Nothing in
//     this file calls unlink on anything it has not already copied.
//  2. THE HUB NEVER CREATES `books/` (the rule clothing-log.js:2 keeps for
//     `clothing/`). drive.syncLocal reads an ABSENT source folder as "leave the
//     local library alone" and an EMPTY one as "the parent deleted everything",
//     so a side-effect mkdir turns the first into the second. We only ever act
//     on a `books/` that already exists and already holds the photos.
//  3. A HALF-DONE MOVE IS FINISHED, NOT RESTARTED. Twenty photos move one file
//     at a time; a hub that stops in the middle would, on the next scan, see the
//     eight files still loose and make them a SECOND book. So the target folder
//     is written down in `books/.gather.json` BEFORE the first file moves, and
//     a hub that finds that marker carries the same move on into the same
//     folder. A dotfile, in the directory books-index.js already keeps
//     `.slugs.json` in: drive.js copies dotfiles and its prune never touches
//     them, so the marker survives a sync and is nobody's to delete.
//  4. THE NAME IS A FOLDER NAME ON WINDOWS. A title the model read off a cover
//     goes through safeTitle() before it is ever handed to mkdir or rename:
//     the characters NTFS refuses, the device names it reserves, the trailing
//     dot it silently eats, and a leading dot (which would make the finished
//     book invisible — books-index.js skips dot directories) are all the
//     difference between a book and an exception in the middle of a build.
"use strict";
const fs = require("fs");
const path = require("path");
const { EXT: PHOTO_EXT } = require("./clothing-photos.js");

// Written in `books/` while a pile is being moved (rule 3). {dir, startedAt}.
const MARKER = ".gather.json";
// What a book is called until the cover says otherwise. Deliberately a sentence
// a parent recognises as ours rather than a code word: it is what they will see
// on the Settings card and on the shelf for the minute or two before the title
// arrives, and it is what the book KEEPS if there is no AI key to ask.
const FALLBACK_PREFIX = "New book";
// Long enough for a picture book's title, short enough that the whole path
// stays well inside Windows' 260-character ceiling once `sources/IMG_0001.jpg`
// is hung off it.
const MAX_TITLE = 60;
// Windows keeps these for its own devices, in every directory, with or without
// an extension. mkdir succeeds and then nothing can open the folder.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const iso = (now) => (typeof now === "string" ? now : new Date(now == null ? Date.now() : now).toISOString());

// The photos sitting DIRECTLY in `books/` — not in a book folder, not a
// dotfile, not the `.slugs.json`/`.gather.json` the builder keeps there.
// clothing-photos.js owns "what counts as a photo" for the whole suite, so a
// HEIC counts here exactly as it counts in a book folder (content.js:90).
// Sorted, so a resumed move and a fresh one walk the pile the same way.
function looseNames(root) {
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (e.name.startsWith(".") || !e.isFile()) continue;
    if (!PHOTO_EXT.has(path.extname(e.name).toLowerCase())) continue;
    out.push(e.name);
  }
  return out.sort();
}

// "New book 2026-09-07", in the parent's own day rather than UTC: this string
// is read by a person standing at the computer, and a pile dropped in at nine in
// the evening in California must not be filed under tomorrow.
function fallbackTitle(now) {
  const d = new Date(now == null ? Date.now() : now);
  const p = (n) => String(n).padStart(2, "0");
  return FALLBACK_PREFIX + " " + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// A model's answer turned into a folder name, or "" when there is nothing left
// of it worth using (rule 4). "" is never an error: the book simply keeps the
// placeholder name it was born with, and a parent can rename it.
function safeTitle(raw) {
  let s = String(raw == null ? "" : raw);
  // A model asked for one line sometimes sends the byline on a second one.
  s = (s.split(/[\r\n]+/).map(x => x.trim()).filter(Boolean)[0] || "");
  s = s.normalize("NFC")
       .replace(/[\u0000-\u001f\u007f]/g, " ")             // control characters
       .replace(/[<>:"/\\|?*]/g, " ")                   // what NTFS refuses outright
       .replace(/\s+/g, " ")
       .trim();
  if (s.length > MAX_TITLE) {
    const cut = s.slice(0, MAX_TITLE);
    const gap = cut.lastIndexOf(" ");
    s = (gap > MAX_TITLE / 2 ? cut.slice(0, gap) : cut).trim();
  }
  // Windows quietly drops a trailing dot or space, so a folder called "Hop."
  // is created as "Hop" and every path we wrote down is wrong by one character.
  s = s.replace(/[. ]+$/, "").trim();
  // A leading dot would make the finished book INVISIBLE: books-index.js skips
  // dot directories (they are the builder's and the mirror's own scratch), so
  // the book would build perfectly and never reach a shelf.
  s = s.replace(/^\.+/, "").trim();
  if (!s || RESERVED.test(s)) return "";
  return s;
}

// A directory name inside `root` that is not taken. Never overwrites, never
// merges: two books that happen to share a title are two books.
function freeDirName(root, name) {
  const base = name || FALLBACK_PREFIX;
  if (!fs.existsSync(path.join(root, base))) return base;
  for (let n = 2; n < 1000; n++) {
    const alt = base + " (" + n + ")";
    if (!fs.existsSync(path.join(root, alt))) return alt;
  }
  return base + " (" + Date.now() + ")";
}

// A free file name inside the new book folder. Twin of content-ingest.freeName
// (two phones both call their shot "IMG_0001.jpg"; neither may overwrite the
// other — that is a lost page of a book that only exists on paper).
function freeFileName(dir, name) {
  const e = path.extname(name), base = path.basename(name, e);
  if (!fs.existsSync(path.join(dir, name))) return name;
  for (let n = 2; n < 1000; n++) {
    const alt = base + "-" + n + e;
    if (!fs.existsSync(path.join(dir, alt))) return alt;
  }
  return base + "-" + Date.now() + e;
}

// Move, falling back to copy+unlink. Twin of content-ingest.moveIn, and
// deliberately copied rather than imported: requiring content-ingest.js here
// would drag the vendored JPEG decoder into the hub's MAIN process for four
// lines (content.js:97 keeps the same distance from it for the same reason).
function moveIn(from, to) {
  try { fs.renameSync(from, to); }
  catch { fs.copyFileSync(from, to); fs.unlinkSync(from); }
}

function markerPath(root) { return path.join(root, MARKER); }

// The folder a move that did not finish was filling, or null (rule 3). A marker
// naming a folder that is no longer there is stale and says so: the parent
// deleted it, and the pile is free to start again.
function pending(root) {
  let m = null;
  try { m = JSON.parse(fs.readFileSync(markerPath(root), "utf8")); } catch { return null; }
  if (!m || typeof m !== "object" || typeof m.dir !== "string" || !m.dir) return null;
  if (m.dir !== path.basename(m.dir) || m.dir.startsWith(".")) return null;   // a name, never a path
  try { if (!fs.statSync(path.join(root, m.dir)).isDirectory()) return null; } catch { return null; }
  return m.dir;
}

function clearMarker(root) { try { fs.unlinkSync(markerPath(root)); } catch {} }

// gather(root, opts) — turn the loose pile in `books/` into ONE book folder.
//
//   opts.now    pinned clock (tests), for the placeholder name and the marker
//   opts.name   a name to use instead of today's placeholder (nothing calls
//               this yet; it is the seam a "these are two books" split needs)
//
// Returns {dir, name, moved, resumed} or null when there is nothing to gather.
// Throws only for a disk that will not take the folder at all — content.js logs
// that and leaves the photos exactly where the parent put them.
function gather(root, opts) {
  const o = opts || {};
  const now = o.now == null ? Date.now() : o.now;
  // RULE 2: we act on a books/ that is already there, and never make one.
  try { if (!fs.statSync(root).isDirectory()) return null; } catch { return null; }

  const names = looseNames(root);
  let name = pending(root);                       // a move that did not finish
  const resumed = !!name;
  if (!names.length && !resumed) { clearMarker(root); return null; }
  if (!name) {
    name = freeDirName(root, safeTitle(o.name) || fallbackTitle(now));
    // NOT recursive: if books/ went away between the stat above and here, this
    // throws rather than quietly creating the folder rule 2 forbids.
    fs.mkdirSync(path.join(root, name));
    // Written BEFORE the first file moves (rule 3).
    fs.writeFileSync(markerPath(root), JSON.stringify({ dir: name, startedAt: iso(now) }, null, 2) + "\n");
  }
  const dir = path.join(root, name);
  let moved = 0;
  for (const f of names) {
    try { moveIn(path.join(root, f), path.join(dir, freeFileName(dir, f))); moved++; }
    // One photo the disk would not move is one photo left loose, not a build
    // that stops: it joins the NEXT pile, and the pages that did move are still
    // a book. The marker is only cleared once the walk is over.
    catch (e) { console.error("[content] could not gather " + f + ": " + e.message); }
  }
  clearMarker(root);
  return { dir, name, moved, resumed };
}

// rename(root, from, to) — the folder a book lives in, renamed. `to` is a TITLE
// (a person's or a model's), not a name: it goes through safeTitle and then
// through freeDirName, so this can never overwrite another book and can never
// make an invisible one.
//
// Returns {name, dir, renamed} — `renamed:false` when the title was unusable or
// was the name the folder already has, which is not a failure and not a reason
// to stop a build. Throws only if the rename itself fails.
function rename(root, from, to) {
  const want = safeTitle(to);
  if (!want || want === from) return { name: from, dir: path.join(root, from), renamed: false };
  const name = freeDirName(root, want);
  fs.renameSync(path.join(root, from), path.join(root, name));
  return { name, dir: path.join(root, name), renamed: true };
}

module.exports = {
  MARKER, FALLBACK_PREFIX, MAX_TITLE,
  looseNames, fallbackTitle, safeTitle, freeDirName, freeFileName,
  pending, clearMarker, gather, rename,
};
