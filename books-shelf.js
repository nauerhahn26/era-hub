// books-shelf.js — the Book Reader shelf's two small stores (spec
// docs/superpowers/specs/2026-09-30-book-shelf-layout-design.md).
//
// The shelf is a TD Snap page now: a rail of sections (This Week, Favorites,
// Storybooks, All) over a 3×4 centre-black grid. Two of those sections need a
// fact no manifest carries, and both facts are THIS HUB'S, not the book's:
//
//   FIRST SEEN  This Week is "newest week first", and a manifest cannot say
//               which week a book belongs to. `exportedAt` moves every time the
//               hub re-publishes a book (a review edit, a rename, every Animate
//               clip — content-publish.js law 4), and the weekly maker writes no
//               week field. So the hub writes down, per slug, the first moment
//               its shelf index saw the package: seeded from the manifest's
//               exportedAt when there is one (so books already on a shelf the
//               day this ships sort sensibly), otherwise now — and NEVER
//               rewritten afterwards. A manifest that one day carries an
//               explicit `weekOf` beats it on the reader's side; that field is
//               published beside this one, not merged into it.
//
//   FAVORITES   A grown-up's finger hold on a cover gives a book her ♥. It lives
//               on the hub so a browser reset does not lose it, keyed by slug
//               (slugs are a package's for life — books-index.js). A slug whose
//               book is gone is simply ignored by the index; nothing prunes it,
//               so a book that comes back comes back a favourite.
//
// BOTH LIVE IN THE HUB'S DATA DIR, NEVER UNDER <DATA>/books. That directory is
// the Drive mirror's: its prune would delete a file it did not put there, and
// anything written into it is one bad sync from being another device's.
//
// Every read degrades: a missing or unreadable file is an empty store, never a
// throw — the shelf index must never 500 over a sidecar (the 8/19 law). Writes
// go through a temp file and a rename, so a power cut mid-write leaves the old
// file, not half of a new one.
"use strict";
const fs = require("fs");
const path = require("path");

const FAVORITES_FILE = "book-favorites.json";
const FIRST_SEEN_FILE = "book-first-seen.json";

function readMap(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

function writeMap(file, obj) {
  const tmp = file + ".tmp-" + process.pid;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

// An ISO timestamp for a manifest date, or null. Normalised through Date so
// the stored and published form is one shape whatever the maker wrote.
function isoOf(v) {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// `weekOf` is published as the maker wrote it (a date string it can read back),
// but only when it IS a date — a garbage field must not sort a book anywhere.
function weekOfOf(v) {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
}

function create(dataDir) {
  const favFile = path.join(dataDir, FAVORITES_FILE);
  const seenFile = path.join(dataDir, FIRST_SEEN_FILE);

  // rows: [{slug, exportedAt}] -> Map(slug -> ISO). One read, and at most ONE
  // write per index call — only when a slug is seen for the first time.
  function firstSeen(rows, now) {
    const map = readMap(seenFile);
    let added = false;
    const out = new Map();
    for (const { slug, exportedAt } of rows) {
      let at = isoOf(map[slug]);
      if (!at) {
        at = isoOf(exportedAt) || new Date(now == null ? Date.now() : now).toISOString();
        map[slug] = at;
        added = true;
      }
      out.set(slug, at);
    }
    if (added) writeMap(seenFile, map);
    return out;
  }

  function favorites() {
    return new Set(Object.keys(readMap(favFile)).filter(Boolean));
  }

  // Returns true when the store now says what was asked. Setting a ♥ that is
  // already set keeps its original timestamp.
  function setFavorite(slug, on, now) {
    const map = readMap(favFile);
    if (on) {
      if (map[slug]) return true;
      map[slug] = new Date(now == null ? Date.now() : now).toISOString();
    } else {
      if (!(slug in map)) return true;
      delete map[slug];
    }
    return writeMap(favFile, map);
  }

  return { firstSeen, favorites, setFavorite };
}

module.exports = { create, weekOfOf, FAVORITES_FILE, FIRST_SEEN_FILE };
