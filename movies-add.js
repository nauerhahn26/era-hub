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
//      the end of a board Ellie has learned. Two halves of that, both learned
//      the hard way (review 9/5): it keeps what the new add could not supply
//      (a body with no url must never blank a working launch.url — the search
//      grid sends exactly that body whenever a family has only a TMDB key),
//      and it only applies to THE SAME FILM: "Cinderella" 1950 and 2015
//      slugify alike, and the second takes the year as its surname rather than
//      deleting the first.
//   5. THE HUB NEVER SERVES VIDEO (D57). Nothing here downloads anything —
//      a movie is a link the ERAgaze kiosk opens, and that is all it ever is.
//
// NOT IN THIS FILE, deliberately: the streaming-availability lookup itself
// (movies-lookup.js, T5.3). A typed name is SEARCHED by the sheet through
// POST /movies/lookup and a grown-up picks a row; the pick arrives here as an
// ordinary add carrying the link the lookup found and the provenance it came
// with (`providerRef`, `ageRating` — "the picked row", below). This file never
// picks and never searches: the first hit for "peter rabbit" is not the one a
// family means often enough to put on a child's board unasked.
//
// A name with NO link is still written PENDING — `launch.url` null, which
// moviesRecipe counts into meta.pendingCount and draws nowhere — so a parent's
// list is kept (a family with no key, or a title nobody streams) without ever
// putting an unlaunchable tile in front of Ellie.
//
// The poster fetch (T5.2) IS here, under "the poster" below, with the rules
// that make a network call safe in a door a parent is standing in front of: it
// is BOUNDED (one budget for the whole hunt, a byte cap on every body), it
// FAILS SILENTLY (no art is not an error — the tile goes up with its name),
// what comes back is CHECKED before it is saved, and — Rule 4, the one this
// file learned last — the ADDRESS ITSELF is judged before every hop, because
// the `og:image` a stranger's page names is fetched by this server and served
// to the family afterwards.
"use strict";
const path = require("path");
const drive = require("./drive.js");
const { slugify } = require("./slug.js");
const { writeAtomic } = require("./content-store.js");
const { tmdbKey } = require("./movies-lookup.js");
const fs = require("fs");
const dns = require("dns").promises;

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
//
// THE SEGMENT IS NOT THE UNIT — the dash-words inside it are (review 9/5).
// Disney's canonical link, the one shape the plan pins as the form to store, is
// /browse/entity-4e2c9f1a-8b2c-4d5e-9f01-1234567890ab: a route word this file
// already knows, glued to a uuid, and as a whole segment it looks exactly like
// a hyphenated name. It put "Entity 4e2c9f1a 8b2c 4d5e 9f01 1234567890ab" on a
// six-year-old's board, spoken aloud. So each word is judged: a word that mixes
// letters and digits is an id, and a route word in front of anything that is
// not word-like is a route word with an id behind it.
const WORDY = /^([a-z]{2,}|\d{1,4})$/;               // "snail", "broom", "2"

function titleFromUrl(u) {
  const segs = u.pathname.split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    let s;
    try { s = decodeURIComponent(segs[i]); } catch { s = segs[i]; }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) continue;      // an id, or not a slug at all
    if ((s.match(/[a-z]/g) || []).length < 3) continue;  // "81002370", "s2"
    if (NOT_A_NAME.has(s)) continue;
    const words = s.split("-").filter(Boolean);
    // "4e2c9f1a", "b08xyz1234": letters AND digits in one word is a handle a
    // machine made, never a word a person would read out.
    if (words.some(w => /[a-z]/.test(w) && /[0-9]/.test(w))) continue;
    // "entity-…", "title-…": the route word is not the name, so whatever
    // follows it has to look like words before this counts as one.
    if (NOT_A_NAME.has(words[0]) && !words.slice(1).every(w => WORDY.test(w))) continue;
    return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  return null;
}

// ---------------------------------------------------------------- the poster
//
// A film tile Ellie can read is a PICTURE. The words under it are for the
// grown-up, so a catalog of bare labels is a movies board she cannot use — and
// the family's own posters have always come from two places, so this door uses
// the same two: the `og:image` of the page the parent pasted (every streaming
// site serves one, no key, no terms to honour), and TMDB when the family has
// configured a key (era-family/tools/fetch-posters.mjs, which this replaces for
// anything added from the board).
//
// THREE RULES, because this is the first thing in this file that leaves the
// box, and a parent is standing in front of the sheet waiting for it:
//
//   1. ONE BUDGET FOR THE WHOLE HUNT. A page, its image, a TMDB search and its
//      image are four requests; a wedged host on any of them must not hold the
//      add. They share POSTER_BUDGET_MS between them and whatever is left when
//      one finishes is all the next one gets.
//   2. FAILING IS NORMAL. Every path here returns null rather than throwing:
//      no art is not a failed add (spec §6 — "failure is silent: the title is
//      added with poster:null and still renders"). Nothing is logged either;
//      an add that quietly worked must not leave a scary line in the console.
//   3. WHAT COMES BACK IS CHECKED BEFORE IT IS SAVED. A cap on every body, and
//      a picture must LOOK like one (magic bytes) as well as claim to be one:
//      a login wall answering 200 text/html is the common case, not the odd
//      one, and "posters/x.jpg" holding an error page is a broken tile.
//
// Poster files keep the family's own convention — `posters/<slug>.jpg`, the
// name fetch-posters.mjs writes and the recipe joins as "movies/" + poster.
// The extension is that convention, not a claim about the bytes: this hub has
// no image library (stdlib only) and re-encodes nothing, so a PNG or WebP
// og:image is stored as it arrived. The board is Chrome, which draws an <img>
// by what the bytes are.
const POSTER_BUDGET_MS = 12000;
const POSTER_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;          // only <head> is ever read
const JSON_MAX_BYTES = 1 * 1024 * 1024;
const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";   // the width fetch-posters uses

// TMDB's terms are personal/family use WITH ATTRIBUTION, in these words
// (era-family/tools/fetch-posters.mjs, header). An attribution nobody ever
// reads is not one, so this is a VALUE: it comes back with the add for the
// sheet to print and it is written beside the catalog it belongs to — never
// into a log file.
const TMDB_ATTRIBUTION = "Poster art from TMDB. This product uses the TMDB API " +
  "but is not endorsed or certified by TMDB.";

// The key, read fresh (a key typed a minute ago must work without a restart)
// and never returned to a caller, never logged. ONE reader for the whole
// feature, in movies-lookup.js: the poster hunt here and the search there use
// the same key from the same two homes, and a second copy of that rule is a
// second place for it to drift.

// The seam every request in this section goes through. ERA_POSTER_PAGE_URL is
// set by tests ONLY: it keeps the path and swaps the ORIGIN, so a fixture that
// pastes a netflix.com link is answered by a fake web on loopback and no test
// can reach a real site whatever a page's `og:image` points at. Unset — every
// hub a family ever runs — the address is used exactly as it came.
function viaSeam(href) {
  const seam = process.env.ERA_POSTER_PAGE_URL;
  if (!seam) return href;
  try {
    const t = new URL(href), s = new URL(seam);
    const prefix = s.pathname === "/" ? "" : s.pathname.replace(/\/+$/, "");
    return new URL(prefix + t.pathname + t.search, s.origin).href;
  } catch { return null; }
}

// ---------------------------------------------- RULE 4: WHERE A FETCH MAY GO
//
// This is the only place in the hub where an address a STRANGER chose is
// fetched by the server and the bytes are kept: the pasted page names its own
// `og:image`, and what comes back is written into the family's Drive folder,
// mirrored to this device, and served at /movies/posters/<slug>.jpg. So a page
// that advertises its art on loopback, on the family's router, or on a .local
// name would pull THAT picture onto Ellie's board (review 9/5) — and every
// redirect is one more chance to name one.
//
//   1. The address is judged BEFORE it is fetched, and again at every hop.
//   2. Redirects are followed BY HAND, three at most: `redirect: "follow"`
//      hides the hop that mattered.
//
// The seam origins are the one exception, and they are only ever set by tests:
// ERA_POSTER_PAGE_URL and the two TMDB seams ARE loopback on purpose, and a
// request to them never leaves the box.
const MAX_HOPS = 3;

function seamOrigins() {
  const out = [];
  for (const v of [process.env.ERA_POSTER_PAGE_URL, process.env.ERA_TMDB_URL,
                   process.env.ERA_TMDB_IMG_URL]) {
    if (!v) continue;
    try { out.push(new URL(v).origin); } catch {}
  }
  return out;
}

// The literal address in a host, or null when the host is a name to be looked
// up. Bracketed IPv6 loses its brackets.
function ipLiteral(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h;
  return h.includes(":") ? h : null;
}

// Everything a family's own network can be reached at, plus the ranges nobody
// on the internet answers from. Anything unparseable is private: this decides
// whether to fetch, so the safe answer is no.
function privateAddr(ip) {
  const v = String(ip || "").toLowerCase();
  if (v.includes(":")) {
    if (v === "::1" || v === "::") return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
    if (mapped) return privateAddr(mapped[1]);
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);   // unique-local, link-local
  }
  const p = v.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
         (a === 100 && b >= 64 && b < 128) ||          // carrier NAT
         (a === 169 && b === 254) ||                   // link-local
         (a === 172 && b >= 16 && b < 32) ||
         (a === 192 && (b === 168 || b === 0)) ||
         (a === 198 && (b === 18 || b === 19));
}

// The half of the judgement that costs nothing and needs no resolver: the
// protocol, a literal address, and the host names that mean "this house".
// Used on the address a PAGE named, before the seam rewrites it — that is the
// address the family's hub would really have fetched.
function literalOk(href) {
  let u;
  try { u = new URL(href); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (/(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(host)) return false;
  const ip = ipLiteral(host);
  return ip ? !privateAddr(ip) : true;
}

// The whole judgement, including the name lookup a literal cannot need. A name
// that will not resolve is not fetched: no art is never an error here (Rule 2).
async function reachable(href) {
  let u;
  try { u = new URL(href); } catch { return false; }
  // The seam first: it IS loopback, so every check below would refuse it.
  if (seamOrigins().includes(u.origin)) return true;
  if (!literalOk(href)) return false;
  const host = u.hostname.toLowerCase();
  if (ipLiteral(host)) return true;                    // literalOk already ruled on it
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every(a => !privateAddr(a.address));
  } catch { return false; }
}

// One GET, bounded by what is left of the budget and by maxBytes, and null for
// every unhappy answer there is (Rule 2). Content-Length is trusted to refuse
// early and re-checked against the bytes that actually arrived, because a
// header is a claim. Redirects are walked by hand so Rule 4 can judge each one.
async function getCapped(href, maxBytes, deadline) {
  let target = href;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const left = deadline - Date.now();
    if (!target || left <= 0) return null;
    if (!(await reachable(target))) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(1, deadline - Date.now()));
    try {
      const r = await fetch(target, { signal: ctl.signal, redirect: "manual",
                                      headers: { "User-Agent": "New ERA hub (family use)" } });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (r.body) r.body.cancel().catch(() => {});
        if (!loc) return null;
        try { target = new URL(loc, target).href; } catch { return null; }
        continue;
      }
      if (!r.ok) return null;
      const claimed = Number(r.headers.get("content-length"));
      if (Number.isFinite(claimed) && claimed > maxBytes) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > maxBytes) return null;
      return { type: (r.headers.get("content-type") || "").toLowerCase(), buf };
    } catch { return null; }
    finally { clearTimeout(timer); }
  }
  return null;                                         // a redirect loop is not art
}

// Rule 3. Both halves must agree: the server says image/*, and the first bytes
// are one of the three formats a browser draws from a file called .jpg.
function isPicture(got) {
  if (!got || got.buf.length < 64 || !/^image\//.test(got.type)) return false;
  const b = got.buf;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;              // jpeg
  if (b.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return true;            // png
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return true;
  return false;
}

// The `og:image` a page advertises, as an absolute address, or null. Written
// against what streaming sites actually serve: `property=` or `name=`, quotes
// of either kind or none, a relative path, and `&amp;` in the query (an HTML
// attribute is entity-encoded, and a poster URL is mostly query string).
function ogImage(html, pageHref) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const prop = /\b(?:property|name)\s*=\s*["']?\s*([^"'\s>]+)/i.exec(tag);
    if (!prop || !/^og:image(:url|:secure_url)?$/i.test(prop[1])) continue;
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const raw = c && (c[1] != null ? c[1] : c[2] != null ? c[2] : c[3]);
    if (!raw || !raw.trim()) continue;
    const src = raw.trim().replace(/&(amp|#38|#x26);/gi, "&")
                          .replace(/&(quot|#34);/gi, '"').replace(/&(#39|apos);/gi, "'");
    try {
      const abs = new URL(src, pageHref);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") return null;
      return abs.href;
    } catch { return null; }
  }
  return null;
}

// The pasted page's own art. Two hops: the page, then the picture it names.
//
// Both addresses are judged as the FAMILY'S hub would see them — the pasted
// link itself, and the og:image resolved against it — and only then rewritten
// through the test seam. Judging the rewritten address instead would ask the
// wrong question twice: under test everything is loopback, and in a family's
// house the seam does not exist.
async function posterFromPage(u, deadline) {
  if (!literalOk(u.href)) return null;
  const page = await getCapped(viaSeam(u.href), PAGE_MAX_BYTES, deadline);
  if (!page || !/^(text\/html|application\/xhtml)/.test(page.type)) return null;
  const src = ogImage(page.buf.toString("utf8"), u.href);
  if (!src || !literalOk(src)) return null;      // a page may name any host it likes
  const img = await getCapped(viaSeam(src), POSTER_MAX_BYTES, deadline);
  return isPicture(img) ? img.buf : null;
}

// TMDB, and only when the family has configured a key — no key is not an error,
// it is a family that has not set TMDB up (spec §7: URL paste works without a
// key). Search then image, the same two calls fetch-posters.mjs makes, and the
// first result WITH art wins: TMDB happily returns matches that have none.
async function posterFromTmdb(entry, deadline) {
  const key = tmdbKey();
  if (!key) return null;
  const api = (process.env.ERA_TMDB_URL || TMDB_API).replace(/\/+$/, "");
  const img = (process.env.ERA_TMDB_IMG_URL || TMDB_IMG).replace(/\/+$/, "");
  const type = entry.kind === "show" ? "tv" : "movie";
  let u;
  try { u = new URL(api + "/search/" + type); } catch { return null; }
  u.searchParams.set("api_key", key);
  u.searchParams.set("query", entry.title);
  if (Number.isFinite(entry.year))
    u.searchParams.set(type === "movie" ? "primary_release_year" : "first_air_date_year",
                       String(entry.year));
  const res = await getCapped(u.href, JSON_MAX_BYTES, deadline);
  if (!res || !/^application\/json/.test(res.type)) return null;
  let body;
  try { body = JSON.parse(res.buf.toString("utf8")); } catch { return null; }
  const hit = (Array.isArray(body && body.results) ? body.results : [])
    .find(x => x && typeof x.poster_path === "string" && x.poster_path);
  if (!hit) return null;
  const art = await getCapped(img + hit.poster_path, POSTER_MAX_BYTES, deadline);
  return isPicture(art) ? art.buf : null;
}

// poster(dir, entry, u) -> {rel, from} | null. The page first (it is the art
// for THIS link, and it costs nobody a key), TMDB second. Written atomically
// like everything else in the family's folder, so Drive never mirrors half a
// picture.
async function poster(dir, entry, u) {
  const deadline = Date.now() + POSTER_BUDGET_MS;
  let buf = null, from = null;
  if (u) { buf = await posterFromPage(u, deadline); if (buf) from = "og"; }
  if (!buf) { buf = await posterFromTmdb(entry, deadline); if (buf) from = "tmdb"; }
  if (!buf) return null;
  const rel = "posters/" + entry.id + ".jpg";
  try { writeAtomic(path.join(dir, rel), buf); } catch { return null; }
  return { rel, from };
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

// Every episode a show carries, in one flat list. The recipe draws a show from
// these and from nothing else (server.js moviesRecipe), so this is also how
// "will the board draw it" is answered below.
function episodesOf(entry) {
  const out = [];
  for (const s of Array.isArray(entry && entry.seasons) ? entry.seasons : []) {
    if (!s) continue;
    for (const e of Array.isArray(s.episodes) ? s.episodes : []) if (e) out.push(e);
  }
  return out;
}

// Are these two entries the same film? Law 4 ("a re-add keeps its tile") was
// written for the SAME title being fixed a week later. Two different films
// whose names slugify the same are not that — "Cinderella" (1950) and
// "Cinderella" (2015) — and letting one replace the other loses a tile the
// family had, under a poster that belongs to the other film (review 9/5).
// Only what BOTH carry can disagree: a title with no year and no tmdbId is
// simply the same title, being filled in.
function sameFilm(old, fields) {
  if (!old || !fields) return true;
  if (old.tmdbId != null && fields.tmdbId != null &&
      String(old.tmdbId) !== String(fields.tmdbId)) return false;
  if (Number.isFinite(old.year) && Number.isFinite(fields.year) &&
      old.year !== fields.year) return false;
  return true;
}

// Law 4: upsert by id, atomically (content-store's tmp + rename, so a device
// never mirrors half a catalog). New titles are appended — the file keeps the
// order the family added things in, and the recipe does the sorting.
function upsert(dir, fields, credit) {
  const { c, titles, unreadable } = readCatalog(dir);
  if (unreadable) throw new Error(UNREADABLE.message);
  const at = titles.findIndex(t => t.id === fields.id);
  const old = at >= 0 ? titles[at] : null;
  const rank = old && Number.isFinite(old.rank) ? old.rank : nextRank(titles);
  const same = sameFilm(old, fields);
  const entry = { ...(old || {}), ...fields, rank };
  // WHAT A RE-ADD MAY NOT DESTROY (Law 3 again, review 9/5). An add cannot
  // always supply everything, and the sheet's own search is the proof: with
  // only a TMDB key every row comes back WITHOUT a deep link, so picking one
  // posts a name, a year and a tmdbId and no url at all. The recipe draws only
  // titles that HAVE a url — so spreading that body over the entry would take a
  // film the family was watching off Ellie's board, silently. Each field below
  // keeps what it had unless the new add really brought a better one.
  entry.launch = fields.launch && fields.launch.url ? fields.launch
               : (old && old.launch && old.launch.url) ? old.launch
               : (fields.launch || { url: null });
  entry.service = fields.service || (old && old.service) || null;
  entry.tier = (old && old.tier) || fields.tier;      // curation is never undone by an add
  // A re-add whose poster hunt came back empty keeps the art it already had —
  // but never across a change of film (the right name over the wrong picture).
  entry.poster = fields.poster || (same && old && old.poster) || null;
  if (!entry.poster) delete entry.posterFrom;
  if (entry.kind === "show") {
    if (!Array.isArray(entry.seasons)) entry.seasons = [];
    // A show is drawn from its EPISODES. A show written with none — which is
    // every show the search grid produces, because nothing harvests episodes
    // yet — was a title the hub said it had added, counted as pending, and the
    // board never drew, while the sheet told the parent it was on the board
    // (review 9/5). Most of what a six-year-old watches is a series, so that
    // was the normal path. Its own deep link IS its first episode until an
    // episode harvest knows better; a show that already has episodes keeps
    // exactly the ones it had.
    const url = entry.launch && entry.launch.url;
    if (url && !episodesOf(entry).length)
      entry.seasons = [{ n: 1, episodes: [{ n: 1, title: entry.title, launch: { url } }] }];
  }
  if (at >= 0) titles[at] = entry; else titles.push(entry);
  // The credit line lives WITH the catalog it belongs to, so anything that
  // shows the family's films — the sheet today, a future export — has it to
  // hand. Once earned it stays: the posters are still TMDB's.
  const out = { ...c, schemaVersion: 1, titles };
  if (credit) out.attribution = TMDB_ATTRIBUTION;
  writeAtomic(path.join(dir, "catalog.json"), out);
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

// A provider's own handle for this title, or null. Small on purpose: a
// provider name and a short id, nothing nested, nothing long — this is a
// refresh handle, not a place to park a payload in the family's catalog.
function cleanRef(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  for (const k of Object.keys(v).slice(0, 4)) {
    if (!/^[a-z][a-z0-9]{0,15}$/.test(k)) continue;
    const val = v[k];
    if (Number.isFinite(val)) out[k] = val;
    else if (typeof val === "string" && val.trim() && val.length <= 64) out[k] = val.trim();
  }
  return Object.keys(out).length ? out : null;
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

  // The kind a caller SENT is checked here; the kind a caller left out is
  // decided further down, where the catalog is open — a re-add that says
  // nothing about it must not turn the family's show back into a film.
  if (b.kind != null && !KINDS.includes(b.kind))
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
  const shelf = readCatalog(dir);
  if (shelf.unreadable) return UNREADABLE;

  // What this id already means to the family, if anything. Two things are
  // decided from it, and both are Law 4 read properly: an id the caller did not
  // choose that lands on a DIFFERENT film takes the year as its surname rather
  // than replacing what is there, and a kind the caller did not send is the
  // kind the family's entry already has.
  let had = shelf.titles.find(t => t.id === id) || null;
  if (had && b.id == null && !sameFilm(had, { tmdbId: b.tmdbId, year: b.year })) {
    const alt = Number.isFinite(b.year) ? id + "-" + b.year : null;
    if (alt && SLUG_RE.test(alt)) {
      id = alt;
      had = shelf.titles.find(t => t.id === id) || null;
    }
  }
  const kind = b.kind != null ? b.kind
             : (had && KINDS.includes(had.kind) ? had.kind : "movie");

  const entry = {
    id, kind, title, say: title,
    service: u ? serviceOf(u) : null,
    tier: "core",                                  // the exploration slot is a curation choice, never an add
    poster: null,                                  // filled in below when there is art to be had
    launch: { url: u ? u.href : null },            // null = pending, counted and drawn nowhere
    // provenance the design asked for (spec §6). addedBy is how the title got
    // here: a pasted link, or a name a grown-up typed for the search to
    // resolve. A caller that SAYS which is believed; otherwise a title already
    // in the catalog keeps the answer it has, because a body with no url is not
    // evidence that nobody ever pasted one (review 9/5).
    addedBy: b.addedBy === "search" || b.addedBy === "url" ? b.addedBy
           : (had && had.addedBy) || (u ? "url" : "search"),
  };
  if (Number.isFinite(b.year)) entry.year = b.year;
  if (b.tmdbId != null && (typeof b.tmdbId === "string" || Number.isFinite(b.tmdbId)))
    entry.tmdbId = b.tmdbId;

  // THE PICKED ROW (spec §6). A row chosen from the search grid carries three
  // more things worth keeping, and each is CHECKED, never trusted: this is a
  // JSON door, and the sheet is only the usual caller.
  //   ageRating          "TV-Y", "PG" — the one field that says whether a
  //                      title belongs in front of a six-year-old at all.
  //   providerRef        the availability provider's own handle, so the weekly
  //                      re-check (spec §6 "marks moved titles 'ask a
  //                      grown-up'") costs one cheap call instead of a search.
  //   availabilityCheckedAt  stamped HERE, never taken from the caller: it is
  //                      a claim about when the hub last knew this was true,
  //                      and only the hub can make it. A date without a
  //                      providerRef would be a claim nobody checked, so the
  //                      two arrive together or not at all.
  // Bad provenance is DROPPED, never a refusal: none of it is the tile, and a
  // parent must not lose an add over a field they never saw.
  const rating = typeof b.ageRating === "string" ? b.ageRating.trim() : "";
  if (rating && /^[A-Za-z0-9+\-/ ]{1,16}$/.test(rating)) entry.ageRating = rating;
  const ref = cleanRef(b.providerRef);
  if (ref) {
    entry.providerRef = ref;
    entry.availabilityCheckedAt = new Date().toISOString().slice(0, 10);
  }

  // The art, before the catalog is written, so the tile and its picture arrive
  // on Ellie's board in the same mirror. Nothing here can fail the add.
  const art = await poster(dir, entry, u);
  if (art) { entry.poster = art.rel; entry.posterFrom = art.from; }

  const written = upsert(dir, entry, !!(art && art.from === "tmdb"));
  // `pending` means THE BOARD WILL NOT DRAW THIS, which is not the same
  // question as "is there a launch.url": a show is drawn from its episodes.
  // Answering the easy question instead is what let the sheet tell a parent
  // "<Title> is on the board" over a show that was nowhere (review 9/5).
  const drawn = written.kind === "show"
    ? episodesOf(written).some(e => e.launch && e.launch.url)
    : !!(written.launch && written.launch.url);
  return { ok: true, id: written.id, title: written.title, kind: written.kind,
           rank: written.rank, pending: !drawn,
           mirrored: await mirror(),
           // What the sheet needs to draw the result: the art it just got, and
           // TMDB's credit when the art is TMDB's (a re-add whose old poster
           // came from TMDB still owes it).
           poster: written.poster || null,
           attribution: written.posterFrom === "tmdb" ? TMDB_ATTRIBUTION : null };
}

module.exports = { add, SLUG_RE, TMDB_ATTRIBUTION };
