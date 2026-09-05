// movies-add.js — "+ Add" for films and shows, the one writer of the family's
// movie catalog (spec §6 Movies, plan T5.1). A parent pastes a deep link (or
// types a name) from the board's partner strip and the tile is on the board
// before they walk away.
//
// THE LAW THIS FILE EXISTS FOR (plan Gap 3). The design drew a catalog entry as
// {title, year, tmdbId, link, provider, poster, addedBy}. That is NOT what the
// board reads: moviesRecipe() (server.js) keeps only titles with an `id`
// matching /^[a-z0-9-]{1,64}$/ and a `kind` of "movie" or "show", launches from
// `launch.url`, orders by `tier` + `rank`, and joins posters as
// "movies/" + poster. A title written in the design's shape is dropped by that
// filter WITHOUT A WORD: the add says it worked and Ellie's board never
// changes. So this writes the shape the recipe reads, and carries the design's
// provenance fields alongside it. tests/movies-add.test.mjs ends every case at
// /recipes/movies.json for exactly that reason.
//
// The rest is the same five laws music-add.js opens with, and for the same
// reasons:
//
//   1. WHERE. Titles are written into the family's Drive content folder
//      (drive.status().folderPath + "/movies"), never into <DATA>. <DATA> is
//      this device's shelf, which the mirror fills from Drive — a catalog
//      written there would exist on one PC and be pruned on the next pass
//      (drive.js MIRROR_DELETES covers movies).
//   2. A SLUG IS A NAME, NOT A PATH. The id is [a-z0-9-] and at most 64
//      characters (the rule moviesRecipe enforces and slug.js MAX_SLUG
//      matches), because it is spelled into a poster's filename and into a
//      board button's id. A title becomes one through slugify(); an id a
//      caller sends is checked and refused, never repaired.
//   3. NOTHING THE FAMILY ALREADY HAS IS DESTROYED BY A TRY. A catalog that
//      cannot be READ is never WRITTEN over — a half-synced catalog.json
//      (Google Drive for Desktop writes one) or a Windows EBUSY must not
//      become a one-title library. Same rule, same words as music-add.js,
//      learned there the hard way (review 9/5).
//   4. A RE-ADD KEEPS ITS TILE. An id already in the catalog is updated in
//      place at the rank it has: a title fixed a week later must not jump to
//      the end of a board Ellie has learned.
//   5. THE HUB NEVER SERVES VIDEO (D57). Nothing here downloads anything —
//      a movie is a link the ERAgaze kiosk opens, and that is all it ever is.
//
// NOT IN THIS FILE, deliberately: the poster fetch (plan T5.2) and the
// streaming-availability lookup that turns a typed name into a real link
// (T5.3). Until those land a typed name is written PENDING — `launch.url` null,
// which moviesRecipe counts into meta.pendingCount and draws nowhere — so a
// parent's list is kept without ever putting an unlaunchable tile in front of
// Ellie. No key is read in this file and it reaches no network.
"use strict";
const path = require("path");
const drive = require("./drive.js");
const { slugify } = require("./slug.js");
const { writeAtomic } = require("./content-store.js");
const fs = require("fs");

// Law 2. The id rule is moviesRecipe()'s own filter, spelled once more here so
// a refusal happens at the door instead of a silent drop at render time.
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const KINDS = ["movie", "show"];

// Which service a link belongs to. `service` is a label the board sends back
// with a launch event (board-render.js) and the family's own catalog already
// uses these words — ERAgaze routes on the URL itself, so an unknown host is
// not an error, it is just its own name.
const SERVICES = [
  [/(^|\.)netflix\.com$/, "netflix"],
  [/(^|\.)disneyplus\.com$/, "disney"],
  [/(^|\.)primevideo\.com$/, "prime"],
  [/(^|\.)amazon\.[a-z.]+$/, "prime"],
  [/(^|\.)apple\.com$/, "apple"],
  [/(^|\.)youtube\.com$/, "youtube"],
  [/(^|\.)youtu\.be$/, "youtube"],
  [/(^|\.)max\.com$/, "max"],
  [/(^|\.)hulu\.com$/, "hulu"],
  [/(^|\.)paramountplus\.com$/, "paramount"],
  [/(^|\.)peacocktv\.com$/, "peacock"],
  [/(^|\.)bbc\.co\.uk$/, "bbc"],
  [/(^|\.)itv\.com$/, "itv"],
  [/(^|\.)channel4\.com$/, "channel4"],
];

// Route words, not names: every streaming site spells one of these into the
// path, and none of them belongs on a tile.
const NOT_A_NAME = new Set(["title", "titles", "watch", "browse", "detail",
  "details", "video", "videos", "movie", "movies", "film", "show", "shows",
  "series", "tv", "episode", "episodes", "season", "play", "player", "program",
  "programme", "entity", "gp", "dp", "us", "gb", "uk", "en", "en-gb", "en-us", "www"]);

// ------------------------------------------------------------------ the link

function parseUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return u;
  } catch { return null; }
}

function serviceOf(u) {
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const [re, name] of SERVICES) if (re.test(host)) return name;
  // "iplayer.example.co.uk" -> "example": the label under the public suffix is
  // the closest thing to a service name a stranger's link ever gives us.
  const parts = host.split(".").filter(Boolean);
  const i = parts.length >= 3 && /^(co|com|org|net|gov|ac)$/.test(parts[parts.length - 2])
    ? parts.length - 3 : parts.length - 2;
  return slugify(parts[i >= 0 ? i : 0] || "") || null;
}

// The name a link carries, or null. Streaming URLs are one of two kinds:
// .../title/the-gruffalo (a name we can read) or .../watch/81002370 (an id we
// cannot). Scanning from the end and skipping route words and opaque ids finds
// the first kind and gives up honestly on the second — an add with no name to
// show is refused (need-title) rather than labelling Ellie's board
// "Watch 81002370". Anything with an upper-case letter or a dot is an id
// (Disney's "4uKGzAJi3ROz", Prime's ASIN, Apple's "umc.cmc.…"), never a name.
function titleFromUrl(u) {
  const segs = u.pathname.split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    let s;
    try { s = decodeURIComponent(segs[i]); } catch { s = segs[i]; }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) continue;      // an id, or not a slug at all
    if ((s.match(/[a-z]/g) || []).length < 3) continue;  // "81002370", "s2"
    if (NOT_A_NAME.has(s)) continue;
    return s.split("-").filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  return null;
}

// ---------------------------------------------------------------- the folder

// Law 1: the family's Drive folder, or null when there is no local one. Read
// live on every call — a parent can pick the folder while the sheet is open.
function moviesDir() {
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return null;
  return path.join(st.folderPath, "movies");
}

// --------------------------------------------------------------- the catalog

// The catalog as it stands, and never a throw — but "there is no catalog yet"
// and "I could not read the catalog" are DIFFERENT ANSWERS (Law 3, music-add.js
// readManifest for the incident). Only ENOENT is an empty catalog; everything
// else says `unreadable` and every caller refuses rather than writing over what
// it could not read.
function readCatalog(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, "catalog.json"), "utf8"); }
  catch (e) {
    if (e && e.code === "ENOENT") return { c: {}, titles: [] };   // the family's first film
    return { c: {}, titles: [], unreadable: true };
  }
  let c;
  try { c = JSON.parse(raw); } catch { return { c: {}, titles: [], unreadable: true }; }
  // an empty file, a `null`, a bare array: not a catalog, and not an excuse to
  // start a new one over the top of whatever was there.
  if (!c || typeof c !== "object" || Array.isArray(c)) return { c: {}, titles: [], unreadable: true };
  const titles = Array.isArray(c.titles) ? c.titles.filter(t => t && typeof t === "object") : [];
  return { c, titles };
}

const UNREADABLE = { error: "catalog-unreadable",
  message: "New ERA could not read the list of films just now. Try again in a minute." };

// The next tile nobody is standing on. Ranks run per tier in the recipe, but
// one number past the highest is free in either of them, and a rank collision
// only ever changes the order of two tiles — never which ones exist.
function nextRank(titles) {
  let max = 0;
  for (const t of titles) if (Number.isFinite(t.rank) && t.rank > max) max = t.rank;
  return max + 1;
}

// Law 4: upsert by id, atomically (content-store's tmp + rename, so a device
// never mirrors half a catalog). New titles are appended — the file keeps the
// order the family added things in, and the recipe does the sorting.
function upsert(dir, fields) {
  const { c, titles, unreadable } = readCatalog(dir);
  if (unreadable) throw new Error(UNREADABLE.message);
  const at = titles.findIndex(t => t.id === fields.id);
  const old = at >= 0 ? titles[at] : null;
  const rank = old && Number.isFinite(old.rank) ? old.rank : nextRank(titles);
  // A re-add carries no poster yet (T5.2 fetches one) and a show carries its
  // harvested seasons: neither may be dropped by writing the new fields over.
  const entry = { ...(old || {}), ...fields, rank,
                  poster: fields.poster || (old && old.poster) || null };
  if (entry.kind === "show" && !Array.isArray(entry.seasons)) entry.seasons = [];
  if (at >= 0) titles[at] = entry; else titles.push(entry);
  writeAtomic(path.join(dir, "catalog.json"), { ...c, schemaVersion: 1, titles });
  return entry;
}

// Carry what we just wrote from the family's Drive folder to this device's
// shelf, and SAY whether it arrived — the board is generated from the shelf, so
// without this the tile would appear at the next ten-minute sync, long after
// the parent walked away. drive.sync() reports failure by ANSWERING rather than
// throwing (syncLocal collects per-file errors), which is how a sibling door
// came to say "saved" over a board that had not moved (review 9/5).
async function mirror() {
  try {
    const r = await drive.sync();
    return !(r && (r.error || (Array.isArray(r.errors) && r.errors.length)));
  } catch { return false; }
}

// ------------------------------------------------------------------- the add

// add(body) -> {ok, id, title, kind, rank, pending, mirrored} | {error, message}
//
// body: {url?, title?, id?, kind?, year?, tmdbId?, addedBy?}. Either a link or
// a name is enough; a link with a readable name in it needs nothing else.
// Unlike the song door this answers when it is done — there is nothing to
// download, just one small file and a mirror of a folder the family already
// has locally, so the sheet can wait and know the board is right.
async function add(body) {
  const b = body && typeof body === "object" ? body : {};
  const url = typeof b.url === "string" ? b.url.trim() : "";
  const asked = typeof b.title === "string" ? b.title.trim() : "";
  const u = url ? parseUrl(url) : null;
  if (url && !u)
    return { error: "bad-url", message: "That does not look like a web link. Paste the whole address, or type the name instead." };
  if (!url && !asked)
    return { error: "need-url-or-title", message: "Paste a link to the film, or type its name." };

  const kind = b.kind == null ? "movie" : b.kind;
  if (!KINDS.includes(kind))
    return { error: "bad-kind", message: "New ERA can add a film or a show, and that was neither." };

  const title = asked || (u ? titleFromUrl(u) : "");
  if (!title)
    return { error: "need-title", message: "That link does not say what it is called. Type the name as well." };

  // Law 2. An id the sheet chose (a parent naming a title themselves) is
  // checked, never repaired: it becomes a poster's filename and a board
  // button's id, so "../evil" is a refusal, not something to sanitise into
  // silence. Absent, the title provides one.
  let id;
  if (b.id != null) {
    if (typeof b.id !== "string" || !SLUG_RE.test(b.id))
      return { error: "bad-id", message: "A film's short name can only use small letters, numbers and dashes." };
    id = b.id;
  } else {
    id = slugify(title);
    // A name with no Latin letters at all ("♪♪♪") slugifies to nothing. The
    // parent is standing right there, so ask rather than invent.
    if (!SLUG_RE.test(id))
      return { error: "bad-id", message: "That name does not make a short name we can save - type one yourself." };
  }

  const dir = moviesDir();
  if (!dir)
    return { error: "needs-local-drive",
             message: "New ERA saves new films into the family's Drive folder, so every device gets them. Choose that folder in Settings first." };
  // Refuse BEFORE anything is written: a catalog we cannot read is not a
  // catalog we may write a single title over (Law 3).
  if (readCatalog(dir).unreadable) return UNREADABLE;

  const entry = {
    id, kind, title, say: title,
    service: u ? serviceOf(u) : null,
    tier: "core",                                  // the exploration slot is a curation choice, never an add
    poster: null,                                  // T5.2 fetches one; a title without art still renders
    launch: { url: u ? u.href : null },            // null = pending, counted and drawn nowhere
    // provenance the design asked for (spec §6). addedBy is how the title got
    // here: a pasted link, or a name a grown-up typed for the search to resolve.
    addedBy: b.addedBy === "search" || !u ? "search" : "url",
  };
  if (Number.isFinite(b.year)) entry.year = b.year;
  if (b.tmdbId != null && (typeof b.tmdbId === "string" || Number.isFinite(b.tmdbId)))
    entry.tmdbId = b.tmdbId;

  const written = upsert(dir, entry);
  return { ok: true, id: written.id, title: written.title, kind: written.kind,
           rank: written.rank, pending: !(written.launch && written.launch.url),
           mirrored: await mirror() };
}

module.exports = { add, SLUG_RE };
