// books-index.js — one function assigns every book's slug.
//
// A book package's directory is whatever a parent typed on their phone ("Tabby
// McTat"), while its URL is a slug (/books/tabby-mctat/). Two different places
// need that translation and they must never disagree:
//
//   server.js   the shelf (booksIndex) and the reader (serveBook), over <DATA>/books
//   content.js  the builder's status card and POST /content/run, over the
//               family's Drive folder, <folderPath>/books
//
// slugify() alone cannot do the job. "Tabby McTat" and "Tabby, McTat!" both
// slugify to `tabby-mctat` — one of the two books would be unreachable — and a
// title with no Latin letters slugifies to the empty string, which is not a URL
// at all. So this module resolves collisions (`-2`, `-3`, …), falls back to
// "book" for a title that slugifies to nothing, and WRITES DOWN who owns which
// slug so a package keeps its URL for life: the reader saves reading positions
// per slug and the board links by slug, so a package that got moved to
// <slug>-2 by a newcomer would lose a child's place in their book.
//
// Ownership lives in `<root>/.slugs.json`, a dotfile so the Drive mirror's
// prune leaves it be. A read-only root just means ownership is not remembered —
// never a crash, never a 500 on a shelf load.
//
// Cached per root on that directory's mtime (adding or removing a package bumps
// it) and rebuilt on demand, so a package that lands mid-second is reachable.
"use strict";
const fs = require("fs");
const path = require("path");
const { slugify } = require("./slug.js");

const SLUGS_FILE = ".slugs.json";

// root -> {at, idx}. Two roots at once is the normal case on a family PC: the
// Drive folder the builder writes and the <DATA> copy the mirror serves.
const cache = new Map();

function slugsPath(root) { return path.join(root, SLUGS_FILE); }

function loadSlugs(root) {
  try {
    const j = JSON.parse(fs.readFileSync(slugsPath(root), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

// Written only when the map actually changed: creating the file bumps the root's
// mtime once (one extra rebuild), rewriting it does not, so the mtime cache
// above stays stable.
function saveSlugs(root, bySlug) {
  const next = {};
  for (const [s, n] of [...bySlug].sort()) next[s] = n;
  const cur = loadSlugs(root);
  const same = Object.keys(next).length === Object.keys(cur).length &&
               Object.entries(next).every(([s, n]) => cur[s] === n);
  if (same) return;
  try { fs.writeFileSync(slugsPath(root), JSON.stringify(next, null, 2)); } catch {}
}

// bookDirs(root) -> {list:[{slug, dir}], bySlug: Map(slug -> dir)}, where `dir`
// is the directory NAME under `root`, not a path. A missing or unreadable root
// is an empty index, never a throw.
function bookDirs(root, force) {
  if (!root) return { list: [], bySlug: new Map() };
  let at = -1;
  try { at = fs.statSync(root).mtimeMs; } catch { cache.delete(root); return { list: [], bySlug: new Map() }; }
  const had = cache.get(root);
  if (!force && had && had.at === at) return had.idx;
  // Dot-directories are not books: they are the mirror's and the builder's own
  // scratch, and slugify() would happily hand one a URL by dropping the dot.
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith(".")).map(d => d.name).sort();
  } catch { return { list: [], bySlug: new Map() }; }
  const bySlug = new Map(), slugOf = new Map();
  const claim = (s, n) => { bySlug.set(s, n); slugOf.set(n, s); };
  // Pass 0: whoever already owns a slug keeps it. Entries whose directory is
  // gone are dropped, which frees the slug for the next package that wants it.
  const have = new Set(names);
  for (const [s, n] of Object.entries(loadSlugs(root)))
    if (have.has(n) && !bySlug.has(s) && !slugOf.has(n)) claim(s, n);
  // Pass 1: an unclaimed folder already named as its own slug keeps that name.
  const rest = [];
  for (const n of names) {
    if (slugOf.has(n)) continue;
    if (slugify(n) === n && !bySlug.has(n)) claim(n, n); else rest.push(n);
  }
  // Pass 2: the rest in name order; a taken slug gets -2, -3, ... Two folders
  // must never collapse onto one slug — that would hide a whole book.
  for (const n of rest) {
    const base = slugify(n) || "book";
    let s = base;
    for (let i = 2; bySlug.has(s); i++) s = base + "-" + i;
    if (s !== base) console.warn("[books] slug " + base + " is taken; " + n + " serves as " + s);
    claim(s, n);
  }
  saveSlugs(root, bySlug);
  const idx = { list: names.map(n => ({ slug: slugOf.get(n), dir: n })), bySlug };
  cache.set(root, { at, idx });
  return idx;
}

// The directory NAME a slug belongs to, or null. A miss is retried against a
// forced rebuild once: a book folder created a moment ago is still addressable.
function dirFor(root, slug) {
  return bookDirs(root).bySlug.get(slug) ?? bookDirs(root, true).bySlug.get(slug) ?? null;
}

// The slug a directory name owns, or null if `root` does not hold it.
function slugFor(root, name) {
  const found = bookDirs(root).list.find(e => e.dir === name);
  return found ? found.slug : null;
}

module.exports = { bookDirs, dirFor, slugFor, SLUGS_FILE };
