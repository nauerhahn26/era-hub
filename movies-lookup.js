// movies-lookup.js — "ada twist" in, "on Netflix, and here is the link" out
// (spec §6 "Streaming availability", plan T5.3). One interface, three
// behaviours, and WHICH ONE a family gets is decided by two things and nothing
// else: a config value and which keys they have typed.
//
//   lookupTitle(query, region) -> [{title, year, tmdbId?, providers:[{name,
//                                   deepLink}], poster, similar?[]}]
//
// THE THREE ADAPTERS, poorest first, because that is the order a family meets
// them (research memo §9):
//
//   none       returns []. The family has no key, so nothing is searched and
//              nothing is spent. The sheet still works — a parent pastes the
//              film's link and movies-add.js writes the tile. This is the
//              DEFAULT, and it is why a fresh hub can never accidentally spend
//              a key it was never given.
//   tmdb       the key the family already needed for posters. TMDB is the
//              metadata spine: title, year, tmdbId, poster, and — from
//              /watch/providers — WHERE a title streams. It cannot give a deep
//              link and never will ("we do not return full deep links on the
//              API"), so the grid says "on Netflix" and the tile is written
//              PENDING until a grown-up pastes the real address.
//   watchmode  one extra free key (2,500 requests a month, a web form, no
//              card) turns every "on Netflix" into a link the kiosk opens,
//              and brings `us_rating` and `similar_titles[]` with it. This is
//              the only adapter that produces a tile a six-year-old can press.
//
// FOUR LAWS THIS FILE IS BUILT ON.
//
//  1. THE PROVIDER IS A CONFIG VALUE, NOT CODE (spec §7 "provider drift").
//     <DATA>/content-config.json {movies:{provider, region}}. `provider` is
//     "none" | "tmdb" | "watchmode", or ABSENT — and absent is the default,
//     meaning "the keys decide": no TMDB key is the null adapter, a TMDB key
//     is `tmdb`, and a Watchmode key on top is `watchmode`. A family never has
//     to edit a JSON file to get what their keys already buy, and a name in
//     that file still pins the answer when a provider drifts.
//  2. A MISSING KEY IS NEVER AN ERROR. Every path here degrades: no key at all
//     is the null adapter plus a hint that names Settings and names the thing
//     that DOES work; a TMDB key without a Watchmode key is provider names
//     with no links; a provider having a bad day is a shorter answer. Nothing
//     in this file throws at a caller and nothing returns an error code — a
//     parent standing at the sheet gets a grid or gets the paste box.
//  3. NOTHING LEAVES THE BOX EXCEPT THROUGH A SEAM. TMDB's base is
//     ERA_TMDB_URL (the seam movies-add.js already proved), its images
//     ERA_TMDB_IMG_URL, and the availability provider's is ERA_STREAMING_URL.
//     All three are read FRESH on every call, so no test can reach a real
//     provider on the family's key. The whole hunt shares ONE budget and every
//     body has a byte cap: a wedged host must not hold a sheet open.
//  4. A KEY IS READ, NEVER RETURNED. tmdbKey()/watchmodeKey() below are the
//     one place either key is read (movies-add.js's poster hunt calls the
//     first one), and neither is ever logged, echoed in a result, or written
//     into the catalog.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO. It never picks. A name typed into
// the sheet becomes a GRID a grown-up chooses from (spec §6: "results appear
// as a selection grid ... picking one adds it"), because the first hit for
// "peter rabbit" is not the one a family means often enough to put on a
// child's board unasked. The chosen row is posted to /movies/add, which is the
// only writer of the catalog.
//
// COST, so nobody has to re-derive it: a search is one TMDB call plus one call
// per result (five at most). On Watchmode that per-result call is a details
// lookup BY TMDB ID with one append — 2 credits + 1 = 3 — so a search costs at
// most 15 of the free tier's 2,500 a month, about 160 searches. On TMDB alone
// it costs nothing that matters (~40 requests a second is the soft cap).
"use strict";
const fs = require("fs");
const path = require("path");

// <DATA> is this device's shelf. A key and a provider choice belong to a
// MACHINE, not to the family's Drive folder — read fresh, so a key typed a
// minute ago works without a restart.
function dataDir() { return process.env.ERA_DATA_DIR || path.join(__dirname, "data"); }

const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";      // the width the posters use
const WATCHMODE_API = "https://api.watchmode.com/v1";

function tmdbBase() { return (process.env.ERA_TMDB_URL || TMDB_API).replace(/\/+$/, ""); }
function tmdbImgBase() { return (process.env.ERA_TMDB_IMG_URL || TMDB_IMG).replace(/\/+$/, ""); }
function streamingBase() { return (process.env.ERA_STREAMING_URL || WATCHMODE_API).replace(/\/+$/, ""); }

// Two minutes is far too long for a parent at a sheet, and one second is too
// short for a cold TMDB. Twelve is the same budget the poster hunt uses.
const BUDGET_MS = 12000;
const JSON_MAX_BYTES = 1024 * 1024;
// Five posters is a grid a person can read at a glance, and it is also the
// Watchmode credit ceiling (five details calls, 15 credits).
const MAX_RESULTS = 5;
const MAX_QUERY = 200;

// ------------------------------------------------------------------ the keys

function trimmed(v) { return typeof v === "string" && v.trim() ? v.trim() : ""; }

// Two homes, in the order the Voice card's key uses: the file a Settings card
// writes, then the operator's environment.
function cardKeys() {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), "ai-config.json"), "utf8")) || {}; }
  catch { return {}; }
}
// Both keys from one read of the card file. The Watchmode one is OPTIONAL and
// always will be: everything below works without it, less well.
function keys() {
  const c = cardKeys();
  return { tmdb: trimmed(c.tmdb && c.tmdb.apiKey) || trimmed(process.env.TMDB_API_KEY),
           watchmode: trimmed(c.watchmode && c.watchmode.apiKey) ||
                      trimmed(process.env.WATCHMODE_API_KEY) };
}
function tmdbKey() { return keys().tmdb; }
function watchmodeKey() { return keys().watchmode; }
// WHETHER a key is saved, never which one (Law 4). The Settings card needs to
// say "saved ✓" beside a box a parent just typed into, and that is the whole
// of what it may be told.
function held() { const k = keys(); return { tmdb: !!k.tmdb, watchmode: !!k.watchmode }; }

// ---------------------------------------------------------------- the config

// Law 1. Defaults live in one object so a provider change is one edit.
const CONFIG_FILE = "content-config.json";
const ADAPTERS = ["none", "tmdb", "watchmode"];
const DEFAULTS = { provider: null, region: "US" };

function loadConfig() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(dataDir(), CONFIG_FILE), "utf8")); } catch {}
  const m = (raw && typeof raw.movies === "object" && raw.movies) || {};
  // An unknown provider name is a typo, not an outage: fall through to "the
  // keys decide" rather than turning a family's search off without a word.
  const provider = ADAPTERS.includes(m.provider) ? m.provider : DEFAULTS.provider;
  return { provider, region: region(m.region) || DEFAULTS.region };
}

// Two letters, upper case. Anything else is not a region and is ignored.
function region(v) {
  return typeof v === "string" && /^[a-z]{2}$/i.test(v.trim()) ? v.trim().toUpperCase() : null;
}

// Which adapter is actually going to run: the pinned one, else the best the
// family's keys can buy. A pinned adapter still degrades — "watchmode" without
// a Watchmode key is TMDB, and TMDB without a TMDB key is nothing — because a
// config file must never be able to promise a key the machine does not hold.
function chooseAdapter(cfg, held) {
  const k = held || keys();
  const have = { tmdb: !!k.tmdb, watchmode: !!k.watchmode };
  let want = cfg.provider;
  if (want === "none") return "none";
  if (!want) want = have.watchmode && have.tmdb ? "watchmode" : have.tmdb ? "tmdb" : "none";
  if (want === "watchmode" && !(have.tmdb && have.watchmode)) want = have.tmdb ? "tmdb" : "none";
  if (want === "tmdb" && !have.tmdb) want = "none";
  return want;
}

// Law 2's other half: what to SAY when the answer is an empty grid. One
// sentence, in the words a parent reads, naming where to fix it and naming the
// thing that already works.
const HINTS = {
  none: "New ERA can look films up by name once a grown-up adds a TMDB key in Settings. " +
        "Until then, paste the film's link and the tile still goes up.",
  tmdb: "New ERA can say where a film streams, but not open it directly. Add the optional " +
        "Watchmode key in Settings for a tile that plays, or paste the film's link.",
  watchmode: "",
};

// status(region?) -> {provider, region, ready, deepLinks, hint}. What the door
// and a Settings card need, and NOTHING a key could be read out of. The
// optional argument is the same override lookupTitle takes, so a caller can
// report the region a search ACTUALLY ran in without validating it twice.
function status(reg) {
  const cfg = loadConfig();
  const provider = chooseAdapter(cfg);
  return { provider, region: region(reg) || cfg.region, ready: provider !== "none",
           deepLinks: provider === "watchmode", hint: HINTS[provider] };
}

// ------------------------------------------------------------- the services
//
// ONE TABLE, matched two ways. TMDB names a service with a `provider_id`
// (8 Netflix, 9 Prime, 337 Disney+, 350 Apple TV — the same numbers JustWatch
// calls packageId, because TMDB's feed IS JustWatch). Watchmode does NOT share
// that id space — its own sample has Netflix as source_id 203 — so a Watchmode
// source is matched on its NAME instead, folded to letters and digits. A
// service in neither list is not an error: it keeps the name it came with.
const SERVICES = [
  { id: 8, slug: "netflix", name: "Netflix", re: /^netflix/ },
  { id: 337, slug: "disney", name: "Disney+", re: /^disney/ },
  { id: 9, slug: "prime", name: "Prime Video", re: /^(amazon)?prime/ },
  { id: 350, slug: "apple", name: "Apple TV+", re: /^appletv/ },
  { id: 15, slug: "hulu", name: "Hulu", re: /^hulu/ },
  { id: 1899, slug: "max", name: "Max", re: /^(hbo)?max/ },
  { id: 531, slug: "paramount", name: "Paramount+", re: /^paramount/ },
  { id: 386, slug: "peacock", name: "Peacock", re: /^peacock/ },
  { id: 192, slug: "youtube", name: "YouTube", re: /^youtube/ },
];
const fold = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
function serviceByName(name) {
  const f = fold(name);
  return SERVICES.find(s => s.re.test(f)) || null;
}
function serviceById(id) {
  return SERVICES.find(s => s.id === id) || null;
}

// ------------------------------------------------------------- the deep link
//
// A link that goes on a child's board is not the link a provider hands out.
// Three shapes are pinned here because a provider changing one must fail a
// test rather than fail a six-year-old (research §5.3, all probed live):
//
//   Netflix    /title/{id} and /watch/{id} carry the SAME numeric id and
//              /watch 302s to /title when logged out. The kiosk is signed in,
//              so /watch/{id} is the form that plays.
//   Disney+    /play/{uuid} now 308s to /browse/entity-{uuid}. Store the
//              canonical one.
//   Prime      watch.amazon.com/detail?gti=… bounces through a THIRD id space
//              and must never be stored. The ASIN lives in the Roku deep link
//              (contentID=B0…), and primevideo.com/detail/{ASIN} is the form
//              the board already uses and the only one that answers 200. No
//              ASIN, no link — a name with no link beats a link that 404s.
//
// And every link is stripped of tracking first: the availability feeds are
// monetised (Amazon `tag=`, Apple `at=`/`ct=`/`itsc*`, Fubo `irmp=`/`irad=`),
// and an affiliate tag has no business in a child's board.
const TRACKING = /^(tag|at|ct|itscg|itsct|irmp|irad|src|trkid|utm_[a-z_]+|fromwatch)$/i;

function clean(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hash = "";
  return u;
}

function asinFrom(source) {
  for (const v of [source.roku_url, source.web_url, source.android_url, source.ios_url]) {
    const m = /(?:contentid=|\/detail\/|\/dp\/)([A-Z0-9]{10})\b/i.exec(String(v || ""));
    if (m) return m[1].toUpperCase();
  }
  return null;
}

// deepLink(slug, source) -> a URL string the kiosk can open, or null.
function deepLink(slug, source) {
  const u = clean(source.web_url);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (slug === "netflix") {
    const m = /\/(?:title|watch)\/(\d+)/.exec(u.pathname);
    return m ? "https://www.netflix.com/watch/" + m[1] : null;
  }
  if (slug === "disney") {
    const m = /\/(?:play\/|browse\/entity-)([0-9a-f-]{16,})/i.exec(u.pathname);
    return m ? "https://www.disneyplus.com/browse/entity-" + m[1].toLowerCase() : null;
  }
  if (slug === "prime") {
    const asin = asinFrom(source);
    return asin ? "https://www.primevideo.com/detail/" + asin : null;
  }
  // Everything else keeps the address it was given, minus the tracking. A
  // trailing "?" left by the strip is noise on a stored link.
  return u.href.replace(/\?$/, "");
}

// ------------------------------------------------------------------ fetching

// One GET, bounded by what is left of the shared budget and by a byte cap, and
// null for every unhappy answer there is (Law 2). Nothing is logged: a search
// that came back thin is not an incident.
// A KEY IN A HEADER NEVER FOLLOWS A REDIRECT (Law 4, review 9/5). undici
// strips only authorization, cookie, proxy-authorization and host when a
// redirect crosses origins — a custom header like Watchmode's X-API-Key is
// re-sent to whatever answers, so following one hands the family's key to
// another host. TMDB's key is a query parameter and would travel the same way.
// A 3xx is simply not `ok`, so the whole thing degrades into the shorter answer
// Law 2 already promises.
async function getJson(href, headers, deadline) {
  const left = deadline - Date.now();
  if (!href || left <= 0) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), left);
  try {
    const r = await fetch(href, { signal: ctl.signal, redirect: "manual",
                                  headers: { "User-Agent": "New ERA hub (family use)",
                                             Accept: "application/json", ...(headers || {}) } });
    if (!r.ok) { if (r.body) r.body.cancel().catch(() => {}); return null; }
    const claimed = Number(r.headers.get("content-length"));
    if (Number.isFinite(claimed) && claimed > JSON_MAX_BYTES) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > JSON_MAX_BYTES) return null;
    return JSON.parse(buf.toString("utf8"));
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------- TMDB search

// The spine. /search/multi answers films, shows AND people in one list, so the
// people are dropped here — a search for "paddington" matching an actor must
// not put a face on a films board.
async function searchTmdb(query, key, deadline) {
  let u;
  try { u = new URL(tmdbBase() + "/search/multi"); } catch { return []; }
  u.searchParams.set("api_key", key);
  u.searchParams.set("query", query);
  u.searchParams.set("include_adult", "false");
  const body = await getJson(u.href, null, deadline);
  const rows = Array.isArray(body && body.results) ? body.results : [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const type = r.media_type || (r.first_air_date || r.name ? "tv" : "movie");
    if (type !== "movie" && type !== "tv") continue;
    const title = trimmed(r.title) || trimmed(r.name);
    if (!title || !Number.isFinite(r.id)) continue;
    const date = trimmed(r.release_date) || trimmed(r.first_air_date);
    const year = /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
    out.push({
      title, year, tmdbId: r.id, tmdbType: type,
      kind: type === "tv" ? "show" : "movie",
      poster: typeof r.poster_path === "string" && r.poster_path
        ? tmdbImgBase() + r.poster_path : null,
      providers: [], ageRating: null, providerRef: {},
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

// TMDB names the service and nothing more. The response carries every country
// on Earth, so the family's own is sliced out here and the rest is thrown
// away — never cached, never stored (TMDB's terms cap its data at six months
// and this is a per-search read, not a cache).
async function tmdbProviders(hit, key, reg, deadline) {
  let u;
  try { u = new URL(`${tmdbBase()}/${hit.tmdbType}/${hit.tmdbId}/watch/providers`); }
  catch { return []; }
  u.searchParams.set("api_key", key);
  const body = await getJson(u.href, null, deadline);
  const here = body && body.results && typeof body.results === "object" ? body.results[reg] : null;
  // flatrate ONLY: rent and buy must never surface as a tile
  // (era-gaze movie-player rule), and `free`/`ads` are not what this family
  // subscribes to.
  const rows = Array.isArray(here && here.flatrate) ? here.flatrate : [];
  const seen = new Set(), out = [];
  for (const p of rows) {
    if (!p || typeof p !== "object") continue;
    const known = serviceById(p.provider_id);
    const name = known ? known.name : trimmed(p.provider_name);
    const slug = known ? known.slug : fold(p.provider_name);
    if (!name || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ name, slug, providerId: Number.isFinite(p.provider_id) ? p.provider_id : null,
               deepLink: null });
  }
  return out;
}

// -------------------------------------------------------------- Watchmode

// One call per title, by TMDB id, with the sources appended — 3 credits, and
// it carries the age rating and the similar-title seed as well as the links.
// The Watchmode id it returns is stored as the handle a weekly re-check uses,
// so a title is never searched for twice.
async function watchmodeDetails(hit, key, reg, deadline) {
  const id = (hit.tmdbType === "tv" ? "tv-" : "movie-") + hit.tmdbId;
  let u;
  try { u = new URL(`${streamingBase()}/title/${id}/details`); } catch { return null; }
  u.searchParams.set("append_to_response", "sources");
  u.searchParams.set("regions", reg);
  return getJson(u.href, { "X-API-Key": key }, deadline);
}

// A TitleSource list into the providers a tile can be made from. `sub` and
// `free` are watchable; `rent` and `buy` are not tiles. One row per service,
// and a service that turns up twice keeps the first row that HAS a link.
function providersFrom(details, reg) {
  const rows = Array.isArray(details && details.sources) ? details.sources : [];
  const by = new Map();
  for (const s of rows) {
    if (!s || typeof s !== "object") continue;
    if (s.type !== "sub" && s.type !== "free") continue;
    if (trimmed(s.region).toUpperCase() !== reg) continue;
    const known = serviceByName(s.name);
    const slug = known ? known.slug : fold(s.name);
    if (!slug) continue;
    const row = { name: known ? known.name : trimmed(s.name), slug,
                  providerId: known ? known.id : null, deepLink: deepLink(slug, s) };
    const had = by.get(slug);
    if (!had || (!had.deepLink && row.deepLink)) by.set(slug, row);
  }
  return [...by.values()];
}

// ------------------------------------------------------------------ the door

// lookupTitle(query, region) -> [{title, year, tmdbId?, providers:[{name,
// deepLink}], poster, similar?[]}]. Never throws, never returns an error: the
// worst day this has is an empty array (Law 2).
async function lookupTitle(query, reg) {
  const q = trimmed(query).slice(0, MAX_QUERY);
  if (!q) return [];
  const cfg = loadConfig();
  const held = keys();
  const adapter = chooseAdapter(cfg, held);
  if (adapter === "none") return [];
  const where = region(reg) || cfg.region;
  const deadline = Date.now() + BUDGET_MS;
  const key = held.tmdb;

  const hits = await searchTmdb(q, key, deadline);
  if (!hits.length) return [];

  const wmKey = adapter === "watchmode" ? held.watchmode : "";
  // Sequential on purpose: a household's search is five small calls, and a
  // burst of parallel ones is exactly what a rate limit is for. The shared
  // deadline means a slow provider costs later titles their availability, not
  // the whole grid.
  for (const hit of hits) {
    if (wmKey) {
      const d = await watchmodeDetails(hit, wmKey, where, deadline);
      if (d) {
        hit.providers = providersFrom(d, where);
        if (trimmed(d.us_rating) && where === "US") hit.ageRating = trimmed(d.us_rating);
        else if (d.content_ratings && trimmed(d.content_ratings[where]))
          hit.ageRating = trimmed(d.content_ratings[where]);
        if (Number.isFinite(d.id)) hit.providerRef = { watchmode: d.id };
        const similar = Array.isArray(d.similar_titles)
          ? d.similar_titles.filter(x => Number.isFinite(x)) : [];
        if (similar.length) hit.similar = similar;
      }
    } else {
      hit.providers = await tmdbProviders(hit, key, where, deadline);
    }
  }
  return hits;
}

module.exports = { lookupTitle, status, tmdbKey, watchmodeKey, held, SERVICES };
