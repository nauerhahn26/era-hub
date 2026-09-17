// clothing-rank.js — the Clothing Picker's ranking and page assembly, a pure
// port of the original studio generator (dad's outfit_set.py, docs/plans/
// outfit-variety-plan.md, his 8/5 ruling: variety is prioritisation, never
// exclusion). Migrated 9/5 after dad found the hub's deal less varied and
// blind to her picks (spec: docs/superpowers/specs/2026-09-05-clothing-picker-
// migration-design.md).
//
// Pure: no file access, no clock reads, no randomness. Everything the deal
// depends on comes in as an argument — the items, the weather band, the seed (the
// family's calendar day) and the history — so a same-day rebuild on any
// device reproduces the same 21, and the variety gate runs in memory.
//
// Original line ranges reproduced here (aac-studio/packages/generator/
// outfit_set.py):
//   :61-73    NEUTRALS
//   :181      BAND_WARMTH
//   :242-252  is_neutral, harmonizes
//   :263-285  style_score
//   :293-299  rotation constants     :316-317 YES/INFERRED weights
//   :302-303  combo_key              :320-357 derive_picks
//   :364-373  record_offer           :376-557 build_candidates
//
// The ONLY two deviations from the original, both labelled where they live:
//   (I5)  isNeutral: a garment with no colours, no pattern and statement false
//         counts as neutral (spec §3.1 item 4 "degrade, never exclude"; the
//         original's is_neutral is false for that garment).
//   (W1)  buildCandidates sorts items by id before pooling, so rank ties break
//         the same way on every device (the original's ties break by catalogue
//         order, which the hub does not share between devices).
//
// Two more places take a hub-side default where the original's input cannot
// occur here (the hub tags warmth with a word and only emits the four bands);
// unreachable on hub data today, but a parity audit should know them:
//   (D1)  WARMTH_LEVELS: an unknown or missing warmth word is level {1,2,3} —
//         never gated out (spec §3.1 item 4). The original (:397, :402) tags
//         an untagged bottom level 2 and an untagged dress/set level 1.
//   (D2)  eligible: an unknown band word gates nothing, like band null. The
//         original (:394) defaults an unknown band to levels {1,2}.
//
// Added 9/17 with no counterpart in the original (accessories spec
// docs/superpowers/specs/2026-09-17-accessories-design.md §3.1, §4.1): the
// eleven category kinds (GARMENT_KINDS / ACCESSORY_KINDS / CATEGORIES /
// OCCASIONS / isAccessory), the "accessory" role, buildCandidates dropping
// accessories and `hidden` items at its one door, and accessoryOrder. The
// deal itself is untouched — a wardrobe holding neither deals what it dealt
// on 9/5, garment for garment.
"use strict";
const crypto = require("crypto");

// ---- constants (outfit_set.py:61-73, :181, :293-299, :316-317) -------------
const NEUTRALS = new Set([
  "white", "cream", "beige", "tan", "gray", "grey", "black", "navy", "denim",
  "light blue", "blue",
]);

const HISTORY_DAYS_KEPT = 60;
const FRESH_CAP_DAYS = 8;      // freshness saturates after this long off page 1
const FRESH_PTS_PER_DAY = 6;   // yesterday = +6 ... 8+ days absent = +48
const LOVED_PTS = 12;          // a combo she has picked twice floats back up
const JITTER_PTS = 16;         // small date-seeded tiebreak (freshness does the real work)
const STAPLE_SLOTS = 2;        // page-1 slots for proven favourites
const STAPLE_POOL = 5;         // rotate staples among the top N so none squats daily
const YES_WEIGHT = 1.0;        // she gazed Yes on the confirm page: a confirmed wear
const INFERRED_WEIGHT = 0.5;   // no Yes that day: her last-selected outfit, inferred
const SINGLE_STYLE = 55;       // a dress/set's style score (outfit_set.py:435, :465)

// allowed warmth LEVEL of the bottom/dress per band (outfit_set.py:181);
// tops are never gated
const BAND_WARMTH = {
  hot: new Set([1]), warm: new Set([1, 2]), cool: new Set([2, 3]), cold: new Set([3]),
};
// the hub tags warmth with a word; the original with a level. spec §3.4:
// hot 1, warm 1, cool 2, cold 3, any = every level. A migrated tag may still
// carry the level as an int (W3) — accepted as-is.
const WORD_LEVELS = {
  hot: [1], warm: [1], cool: [2], cold: [3], any: [1, 2, 3],
};
// Word tables are indexed by caller strings (a band, a warmth word, a
// category — after T3 also a mirror line from another device): only the
// table's own keys count, never Object.prototype's ("constructor").
const lookup = (table, k) => (Object.hasOwn(table, k) ? table[k] : undefined);
function WARMTH_LEVELS(w) {
  if (w === 1 || w === 2 || w === 3) return new Set([w]);
  const lv = lookup(WORD_LEVELS, String(w || "").toLowerCase());
  return new Set(lv || [1, 2, 3]);   // (D1) untagged = never gated out
}

// ---- hashing (outfit_set.py:430-432) --------------------------------------
// int(sha256("|".join((seed, *parts))).hexdigest(), 16) — the full 256-bit
// value as a BigInt so `% n` and ordering agree with Python exactly.
function h(seed, ...parts) {
  const raw = [seed, ...parts].join("|");
  return BigInt("0x" + crypto.createHash("sha256").update(raw, "utf8").digest("hex"));
}
function hmod(seed, n, ...parts) {
  return Number(h(seed, ...parts) % BigInt(n));
}

// ---- the family's calendar day (spec §3.2) --------------------------------
// YYYY-MM-DD in the family's zone; flips at that zone's midnight. `now` is
// a ms timestamp or a Date — never read from the clock in here.
function dayKey(now, tz) {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: tz || "UTC" });
}
// The day before a day key, by calendar arithmetic on the key itself (never
// now − 86400e3 formatted in a DST zone — I6).
function yesterdayOf(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

// ---- garment attributes (spec §3.1 item 2, I14) ----------------------------
// The whitelist the model's answer (or a shared tag line) passes through
// before it reaches wardrobe.json. Unknown values are absent, never kept.
const PATTERNS = new Set(["solid", "denim", "stripes", "floral", "graphic", "print"]);
const PALETTES = new Set(["warm", "cool", "neutral", "pastel"]);
const VIBES = new Set(["sweet", "sporty", "graphic", "basic"]);
// A word is a STRING. `["warm"]` is a shape the prompt never asks for, and
// stringifying it would walk it straight through a whitelist written to refuse
// anything the prompt did not ask for (review r1 nit).
const word = (v, allowed) => {
  if (typeof v !== "string") return undefined;
  const w = v.trim().toLowerCase();
  return allowed.has(w) ? w : undefined;
};
// "light blue" is a colour; a sentence is not. Colours are only ever compared
// against NEUTRALS, so a long one is dead weight in wardrobe.json rather than
// a bug — but the whitelist is where a reply's size is bounded.
const MAX_COLOR_LEN = 24;
function colorList(v) {
  // A colour is a STRING, like every other whitelisted word: `String({})`
  // would write "[object object]" into the family's wardrobe.json (r2 nit).
  const split = (s) => s.split(/\s*(?:,|\/|&)\s*|\s+and\s+/i);
  const parts = Array.isArray(v) ? v.filter(c => typeof c === "string").flatMap(split)
    : typeof v === "string" ? split(v) : [];
  const out = [];
  for (const p of parts) {
    const c = p.trim().toLowerCase().replace(/\s+/g, " ");   // "light blue" stays one entry
    if (c && c.length <= MAX_COLOR_LEN && !out.includes(c)) out.push(c);
    if (out.length === 3) break;
  }
  return out;
}
function attributes(meta) {
  const m = meta && typeof meta === "object" ? meta : {};
  const out = { colors: colorList(m.colors), statement: m.statement === true };
  const pattern = word(m.pattern, PATTERNS); if (pattern) out.pattern = pattern;
  const palette = word(m.palette, PALETTES); if (palette) out.palette = palette;
  const vibe = word(m.vibe, VIBES); if (vibe) out.vibe = vibe;
  return out;
}

// ---- taste rules (outfit_set.py:242-252, :263-285) -------------------------
const colorsOf = g => Array.isArray(g.colors) ? g.colors : [];
function isNeutral(g) {
  // outfit_set.py:243
  if (g.pattern === "solid" || g.pattern === "denim") return true;
  if (colorsOf(g).some(c => NEUTRALS.has(c))) return true;
  // HUB DEVIATION (I5, spec §3.1 item 4): the original is false here. A
  // garment the model has not described yet (no colours, no pattern) counts
  // as neutral unless it is a statement piece — attributes degrade, they
  // never keep a garment off the board.
  return colorsOf(g).length === 0 && !g.pattern && g.statement !== true;
}
// Hard rule: never two statement/loud pieces together (outfit_set.py:246-252).
function harmonizes(top, bottom) {
  if (top.statement === true && bottom.statement === true) return false;
  return isNeutral(top) || isNeutral(bottom) || !(top.statement === true || bottom.statement === true);
}
// Curated pairs are keyed by the UNORDERED pair — the original compares
// set(pair) == {top.id, bottom.id} (outfit_set.py:266-269).
function pairKey(a, b) { return a < b ? a + "+" + b : b + "+" + a; }
// {"great": [[id,id],..], "avoid": [..]} (the pairing.json shape, or the
// pairs/ log after T4.2) → {great:Set<pairKey>, avoid:Set<pairKey>}.
// A one-id entry keys as id+id — the original's frozenset({id}) membership
// (outfit_set.py:462-463) lets a curated single seat a dress as a staple;
// longer or empty entries never match anything there either and are dropped.
// A side that is already a Set of pair keys passes through as-is; a Set of
// pair arrays is normalised like a list (never let a reader's slip pass).
const isKeySet = v => v instanceof Set && [...v].every(x => typeof x === "string");
function normalizePairing(p) {
  const entryKey = pr => (Array.isArray(pr) && pr.length === 2) ? pairKey(String(pr[0]), String(pr[1]))
    : (Array.isArray(pr) && pr.length === 1) ? pairKey(String(pr[0]), String(pr[0])) : null;
  const toSet = list => {
    if (isKeySet(list)) return list;
    if (list instanceof Set) return new Set([...list].map(x => typeof x === "string" ? x : entryKey(x)).filter(Boolean));
    return new Set((Array.isArray(list) ? list : []).map(entryKey).filter(Boolean));
  };
  if (p && isKeySet(p.great) && isKeySet(p.avoid)) return p;
  return { great: toSet(p && p.great), avoid: toSet(p && p.avoid) };
}
const EMPTY_PAIRING = { great: new Set(), avoid: new Set() };
// How well two pieces go together, 0-100-ish (outfit_set.py:263-285). The
// favourite lift (+10) is rank()'s, not this function's (outfit_set.py:436).
function styleScore(top, bottom, pairing) {
  const p = pairing || EMPTY_PAIRING;
  let s = 50.0;
  const key = pairKey(top.id, bottom.id);
  if (p.avoid.has(key)) return -1000;          // curated: never offer
  if (p.great.has(key)) s += 30;               // curated: a known-great look
  const ts = top.statement === true, bs = bottom.statement === true;
  if (ts !== bs) s += 15;                      // statement piece over a basic = the classic combo
  else if (!ts && !bs) s += 5;                 // two basics: fine, a bit plain
  // palette harmony (neutral goes with everything)
  if (top.palette && bottom.palette) {
    if (top.palette === "neutral" || bottom.palette === "neutral" || top.palette === bottom.palette) s += 10;
    else if ((top.palette === "warm" && bottom.palette === "cool") || (top.palette === "cool" && bottom.palette === "warm")) s -= 10;
  }
  // matching vibes get a nudge (sporty+sporty, sweet+sweet)
  if (top.vibe && top.vibe === bottom.vibe) s += 5;
  return s;
}

// ---- memory: wardrobe/history.json {days, events} (outfit_set.py:302-373) --
// days:   {date: {band, page1: [[ids]…]}} — page-1 lineups, written at build
//         time by recordOffer.
// events: {date: [{kind: select|yes, combo: [ids]}]} — raw board events
//         appended by POST /outfit-event; derivePicks turns them into wear
//         weights.
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const daysOf = hist => (hist && hist.days && typeof hist.days === "object") ? hist.days : {};
const eventsOf = hist => (hist && hist.events && typeof hist.events === "object") ? hist.events : {};
// Calendar days from day key a to day key b (b − a).
function daysBetween(a, b) {
  const utc = k => { const [y, m, d] = String(k).split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((utc(b) - utc(a)) / 86400000);
}
function comboKey(pieces) { return pieces.map(p => p.id).join("+"); }

// Wear signal from board events, one credit per day per combo
// (outfit_set.py:320-357). Dad (8/5): this is a TREND LINE of her go-to
// outfits, not a perfect wear record. She confirms with Yes maybe 2 of 3
// days; on the others the last outfit she selected (opened the confirm page
// for) is the best guess, at reduced weight. She may gaze Yes repeatedly —
// the per-day set collapses that to one credit — and a Yes on two different
// outfits credits both. Only days strictly before `before` count, so a
// same-date regeneration never scores this morning's own events.
// Ids are not validated here (I10): only /outfit-event validates the shape.
function derivePicks(events, before) {
  const picks = {};
  const key = e => (e && typeof e === "object" && Array.isArray(e.combo) && e.combo.length) ? e.combo.join("+") : "";
  for (const [dstr, evs] of Object.entries(events && typeof events === "object" ? events : {})) {
    if (!DATE_KEY.test(dstr) || dstr >= before) continue;
    if (!Array.isArray(evs)) continue;
    const yes = new Set(evs.filter(e => e && e.kind === "yes" && key(e)).map(key));
    if (yes.size) {
      for (const k of yes) picks[k] = (picks[k] || 0) + YES_WEIGHT;
    } else {
      const sel = evs.filter(e => e && e.kind === "select" && key(e));
      if (sel.length) { const k = key(sel[sel.length - 1]); picks[k] = (picks[k] || 0) + INFERRED_WEIGHT; }
    }
  }
  return picks;
}

// Bounded growth for events (spec §3.2, I7 — the original never pruned
// them): once `days` holds its 60, events older than the oldest kept day
// go too. While `days` is younger than that (a fresh install, the
// migration's first weeks) the events keep their 60 most recent dates
// instead — the oldest-kept-day cutoff would otherwise wipe every pick
// made before the first recorded offer. Keys that are not dates are left
// alone (skipped, as derivePicks skips them).
function pruneEvents(hist) {
  const days = daysOf(hist), events = eventsOf(hist);
  const dayKeys = Object.keys(days).filter(k => DATE_KEY.test(k)).sort();
  const eventKeys = Object.keys(events).filter(k => DATE_KEY.test(k)).sort();
  let cutoff;
  if (dayKeys.length >= HISTORY_DAYS_KEPT) cutoff = dayKeys[0];
  else if (eventKeys.length > HISTORY_DAYS_KEPT) cutoff = eventKeys[eventKeys.length - HISTORY_DAYS_KEPT];
  if (cutoff) for (const k of eventKeys) if (k < cutoff) delete events[k];
  return hist;
}

// Record the page-1 lineup. Same-date reruns overwrite: idempotent
// (outfit_set.py:364-373). Mutates and returns `history`. Combos come in
// either shape — buildCandidates' {pieces} or the worker's {top,bottom}/{one}
// (toWorkerShape) — so the board route can record what it dealt.
const piecesOf = c => Array.isArray(c.pieces) ? c.pieces : [c.one || c.top, c.bottom].filter(Boolean);
function recordOffer(history, date, combos, perPage, band) {
  const hist = history && typeof history === "object" ? history : {};
  if (!hist.days || typeof hist.days !== "object") hist.days = {};
  if (!hist.events || typeof hist.events !== "object") hist.events = {};
  hist.days[date] = {
    band: band == null ? null : band,
    page1: combos.slice(0, perPage).map(c => piecesOf(c).map(p => p.id)),
  };
  const keys = Object.keys(hist.days).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - HISTORY_DAYS_KEPT))) delete hist.days[old];
  return pruneEvents(hist);
}

// garment id -> the last day (strictly before `before`) it was on page 1
// (outfit_set.py:415-423). Today/future entries are ignored so a same-date
// rerun stays stable.
function lastPage1(history, before) {
  const last = {};
  for (const [dstr, entry] of Object.entries(daysOf(history))) {
    if (!DATE_KEY.test(dstr) || dstr >= before) continue;
    const page1 = entry && Array.isArray(entry.page1) ? entry.page1 : [];
    for (const ids of page1) {
      if (!Array.isArray(ids)) continue;
      for (const gid of ids) if (!(gid in last) || dstr > last[gid]) last[gid] = dstr;
    }
  }
  return last;
}
// The Set of combo keys that sat on page 1 yesterday (outfit_set.py:424-428).
function yesterdayPage1(history, day) {
  const entry = daysOf(history)[yesterdayOf(day)];
  const page1 = entry && Array.isArray(entry.page1) ? entry.page1 : [];
  return new Set(page1.filter(Array.isArray).map(ids => ids.join("+")));
}

// ---- the band gate (spec §3.4, plan W3) ------------------------------------
//
// outfit_set.py:397-402 gates bottoms and singles by BAND_WARMTH and never
// gates tops. The hub composes that with its own "widen when < 2" rule
// (clothing-worker.js forBand): a gated category with fewer than two exact
// matches takes the neighbour band's levels too, and if that is still empty
// the whole category is dealt — the board is never emptied by the weather.

const BANDS = ["hot", "warm", "cool", "cold"];

// ---- the eleven kinds (accessories spec §3.1, 9/17 — no original) -----------
//
// Five GARMENT kinds are pooled into looks exactly as outfit_set.py pooled
// them; six ACCESSORY kinds are never pooled — she taps one on its own page
// and the board speaks its name. This list is the ONE place the kinds live:
// the model prompt, the worker's whitelist and the board's chips all read it,
// so the words cannot drift apart (preflight 1).
//
// `symbol` follows the worker's own convention for a category tile
// (clothing-worker.js "Tops"/"Bottoms"/"Build my own"): an ARASAAC bestsearch
// WORD, or a pinned pictogram id when bestsearch has no good hit (the
// "shorts" → 13638 case). Each word below was checked against
// api.arasaac.org/api/pictograms/en/bestsearch on 9/17 (jacket 2319,
// shoes 2622, jewelry 29088, hat 2572, hair 2851, make up 8626).
const GARMENT_KINDS = ["top", "pants", "shorts", "dress", "set"];
const ACCESSORY_KINDS = [
  { id: "jacket", label: "Jackets", symbol: "jacket" },
  { id: "shoes", label: "Shoes", symbol: "shoes" },
  { id: "jewelry", label: "Jewelry", symbol: "jewelry" },
  { id: "hat", label: "Hats", symbol: "hat" },
  { id: "hair", label: "Hair", symbol: "hair" },
  { id: "makeup", label: "Makeup", symbol: "makeup" },
];
const CATEGORIES = new Set([...GARMENT_KINDS, ...ACCESSORY_KINDS.map(k => k.id)]);
const OCCASIONS = ["everyday", "fancy"];

const CATEGORY = { top: "top", pants: "bottom", shorts: "bottom", dress: "single", set: "single" };
for (const k of ACCESSORY_KINDS) CATEGORY[k.id] = "accessory";

// The pool role of an item: "top" | "bottom" | "single" | "accessory", or null
// for a word the hub does not know (the model's unknowns become "top" before
// they ever reach here — clothing-worker.js).
function categoryOf(item) {
  return lookup(CATEGORY, String(item.category || "").toLowerCase()) || null;
}
// A category WORD (or an item carrying one) that belongs to an accessory kind.
const isAccessory = cat => categoryOf(cat && typeof cat === "object" ? cat : { category: cat }) === "accessory";

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function levelsMeet(item, allowed) {
  for (const l of WARMTH_LEVELS(item.warmth)) if (allowed.has(l)) return true;
  return false;
}

// eligible(items, cat, band): the items of `cat` ("top" | "bottom" | "single")
// that the band admits, in the order given. Tops are never gated; band null
// (weather offline) or an unknown band word (D2) gates nothing.
function eligible(items, cat, band) {
  const ofCat = items.filter(i => categoryOf(i) === cat);
  const levels = band == null ? undefined : lookup(BAND_WARMTH, band);
  if (cat === "top" || !levels) return ofCat;
  const exact = ofCat.filter(i => levelsMeet(i, levels));
  if (exact.length >= 2) return exact;
  const idx = BANDS.indexOf(band);
  const wide = new Set(levels);
  for (const nb of [BANDS[idx - 1], BANDS[idx + 1]]) if (nb) for (const l of BAND_WARMTH[nb]) wide.add(l);
  const near = ofCat.filter(i => levelsMeet(i, wide));
  return near.length ? near : ofCat;
}

// ---- the rank (outfit_set.py:434-451, minus dress_bonus — no "dressy" here) --
//
// ctx = {seed, pairing (normalised), favorites (Set of ids), picks, lastP1}.
// fresh: the look is as fresh as its LEAST fresh piece; a piece never on page
// 1 counts as FRESH_CAP_DAYS + 1 days old. Every term is an integer, so the
// sort below is exact.
function rankOf(pieces, ctx) {
  const style = pieces.length === 2 ? styleScore(pieces[0], pieces[1], ctx.pairing) : SINGLE_STYLE;
  const fav = pieces.some(p => ctx.favorites.has(p.id)) ? 10 : 0;   // W2: favourites Set
  let gap = null;
  for (const p of pieces) {
    const d = p.id in ctx.lastP1 ? daysBetween(ctx.lastP1[p.id], ctx.seed) : FRESH_CAP_DAYS + 1;
    if (gap === null || d < gap) gap = d;
  }
  const fresh = Math.min(gap, FRESH_CAP_DAYS) * FRESH_PTS_PER_DAY;
  const key = comboKey(pieces);
  const loved = (ctx.picks[key] || 0) >= 2 ? LOVED_PTS : 0;
  return style + fav + fresh + loved + hmod(ctx.seed, JITTER_PTS, key);
}

function cmpHash(a, b) {   // I4: BigInt comparison, never subtraction
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- buildCandidates (outfit_set.py:376-557) --------------------------------
//
// Returns the flat ordered list of {key, pieces} for the day: page 1 first
// (staples, the coverage slot, the freshest fill — garment-distinct), then
// the deeper pages. Pure: same inputs → same list.
function buildCandidates(opts) {
  const seed = opts.seed;
  // The seed is the family's day key and nothing else: a Date, a timestamp or
  // a number would hash to a different deal than the day's on another device.
  if (typeof seed !== "string" || !DATE_KEY.test(seed)) throw new TypeError("buildCandidates: seed must be a YYYY-MM-DD day key");
  const band = opts.band == null ? null : opts.band;
  const cap = opts.cap == null ? 21 : opts.cap;
  const perPage = opts.perPage == null ? 7 : opts.perPage;
  const pairing = normalizePairing(opts.pairing || { great: [], avoid: [] });
  const favorites = opts.favorites instanceof Set ? opts.favorites : new Set(opts.favorites || []);
  const history = opts.history || {};
  // W1: catalogue order = id order. This is also the one door the wardrobe
  // comes through, so it is where the two kinds of non-garment are dropped
  // (accessories spec §4.1): an accessory is never pooled into a look, and a
  // hidden item is out of the deal entirely. Everything below reads `items`
  // and nothing else, so no pool can hold one. A wardrobe with neither deals
  // exactly what it dealt before (the variety gate's 35 garments).
  const items = [...(opts.items || [])]
    .filter(i => i.hidden !== true && categoryOf(i) !== "accessory")
    .sort(byId);
  const pageCap = Math.min(perPage, cap);

  // :397-410 — the pool: singles (standalone) then tops × bottoms.
  const tops = eligible(items, "top", band);
  const bottoms = eligible(items, "bottom", band);
  const singles = eligible(items, "single", band).map(g => [g]);
  const pairs = [];
  for (const t of tops)
    for (const b of bottoms)
      if (harmonizes(t, b) && styleScore(t, b, pairing) > 0) pairs.push([t, b]);
  // HUB DEVIATION (spec §3.4's rule, §3.1 item 4): the taste gate has the same
  // floor the weather gate has — "a wardrobe must never empty the board". A
  // model that calls EVERY garment a statement piece leaves no harmonizing
  // pair at all (a loud piece only goes with a plain partner), and the board
  // would deal nothing but the dresses. When that happens the harmony rule
  // steps aside for this deal: `avoid` and the ranking still stand, so a
  // loud-on-loud look simply sinks to the bottom rather than vanishing.
  //
  // The floor opens whenever the honest deal cannot fill ONE page, not only
  // when it is empty (A4-12, review r3). The board is min(cap, pool.length)
  // looks, so `pairs + singles < pageCap` is exactly "this deal comes up short
  // of a page". Measured on the 35-garment synthetic wardrobe, one plain top
  // among 34 loud ones: `cool`/`cold` gate the bottoms to four, all loud, so
  // the honest deal was 4 pairs + 2 dresses = SIX looks — fewer than the
  // all-loud wardrobe's full 21, for a wardrobe described one garment better.
  // Above the page the floor stays shut (`hot` 12, `warm`/band-null 18 are
  // unchanged), so a board that already holds a page of harmonizing looks is
  // never padded with loud-on-loud ones.
  if (pairs.length + singles.length < pageCap && tops.length && bottoms.length) {
    const already = new Set(pairs.map(comboKey));   // a harmonizing pair is not dealt twice
    for (const t of tops)
      for (const b of bottoms)
        if (!already.has(comboKey([t, b])) && styleScore(t, b, pairing) > 0) pairs.push([t, b]);
  }
  const pool = singles.concat(pairs);

  // :412-427 — memory as of today (today's own entries ignored: same-date reruns stay stable).
  const picks = derivePicks(eventsOf(history), seed);
  const lastP1 = lastPage1(history, seed);
  const yP1 = yesterdayPage1(history, seed);
  const ctx = { seed, pairing, favorites, picks, lastP1 };

  // :434-453 — rank every look once; stable sort, descending.
  const key = comboKey;
  const score = new Map();
  for (const o of pool) score.set(key(o), rankOf(o, ctx));
  const ranked = [...pool].sort((a, b) => score.get(key(b)) - score.get(key(a)));

  // :459-482 — staples: most-picked combos, else the curated great looks.
  let staplePool = pool.filter(o => (picks[key(o)] || 0) > 0);
  staplePool.sort((a, b) => picks[key(b)] - picks[key(a)]);
  if (!staplePool.length) {
    staplePool = pool.filter(o => pairing.great.has(o.length === 2 ? pairKey(o[0].id, o[1].id) : pairKey(o[0].id, o[0].id)));
    const styleOf = o => (o.length === 2 ? styleScore(o[0], o[1], pairing) : SINGLE_STYLE);
    staplePool.sort((a, b) => styleOf(b) - styleOf(a));
  }
  const top = [];
  const topUsed = new Set();
  for (const o of staplePool) {
    if (top.length >= STAPLE_POOL) break;
    if (!o.some(p => topUsed.has(p.id))) {
      top.push(o);
      for (const p of o) topUsed.add(p.id);
    }
  }
  const stapleHash = new Map(top.map(o => [key(o), h(seed, "staple", key(o))]));
  top.sort((a, b) => cmpHash(stapleHash.get(key(a)), stapleHash.get(key(b))));

  const chosen = [];
  const chosenKeys = new Set();
  const used = new Set();
  const take = o => {
    chosen.push(o);
    chosenKeys.add(key(o));
    for (const p of o) used.add(p.id);
  };
  for (const o of top) {                                   // :483-492
    if (chosen.length >= STAPLE_SLOTS) break;
    if (yP1.has(key(o))) continue;
    if (!o.some(p => used.has(p.id))) take(o);
  }

  // :497-518 — coverage: the single longest-unseen garment, in its best look.
  const age = g => (g.id in lastP1 ? daysBetween(lastP1[g.id], seed) : 1e6);
  const bandIds = new Set();
  for (const o of pool) for (const p of o) bandIds.add(p.id);
  const agedHash = new Map();
  const aged = items.filter(g => bandIds.has(g.id) && !used.has(g.id));
  for (const g of aged) agedHash.set(g.id, h(seed, "aged", g.id));
  aged.sort((a, b) => age(b) - age(a) || cmpHash(agedHash.get(a.id), agedHash.get(b.id)));
  if (aged.length && chosen.length < pageCap) {
    const want = aged[0].id;
    const best = ranked.find(o => o.some(p => p.id === want) && !chosenKeys.has(key(o)) && !yP1.has(key(o)) && !o.some(p => used.has(p.id)));
    if (best) take(best);
  }

  // :522-533 — fill page 1 (yesterday's looks sit out), then tiny-pool relaxation.
  for (const o of ranked) {
    if (chosen.length >= pageCap) break;
    if (!chosenKeys.has(key(o)) && !yP1.has(key(o)) && !o.some(p => used.has(p.id))) take(o);
  }
  for (const o of ranked) {
    if (chosen.length >= pageCap) break;
    if (!chosenKeys.has(key(o)) && !o.some(p => used.has(p.id))) take(o);
  }

  // :538-556 — deeper pages: yesterday's page 1 leads page 2; a garment once per page.
  const demoted = ranked.filter(o => yP1.has(key(o)));
  const deepOrder = demoted.concat(ranked.filter(o => !yP1.has(key(o))));
  while (chosen.length < Math.min(cap, pool.length)) {
    const pageUsed = new Set();
    let pageCount = 0;
    for (const o of deepOrder) {
      if (pageCount >= perPage || chosen.length >= cap) break;
      if (chosenKeys.has(key(o)) || o.some(p => pageUsed.has(p.id))) continue;
      chosen.push(o);
      chosenKeys.add(key(o));
      for (const p of o) pageUsed.add(p.id);
      pageCount += 1;
    }
    if (pageCount === 0) break;
  }
  return chosen.slice(0, cap).map(pieces => ({ key: key(pieces), pieces }));
}

// ---- accessoryOrder (accessories spec §4.1, 9/17 — no original) ------------
//
// One accessory kind's items, warmest-for-today first: on a cold morning the
// coats lead the Jackets grid. Distance is the SMALLEST gap between the item's
// warmth levels (WARMTH_LEVELS) and the band's (BAND_WARMTH), so a warmth
// "any" — or an untagged item, which is every level (D1) — is distance 0 to
// every band and sorts with the exact matches. Ties break by id, so two
// devices lay the grid out the same way. No band (weather offline) or a band
// word the hub does not know (D2): catalogue order, i.e. by id.
//
// Unlike `eligible` this NEVER drops an item: an accessory is never weather-
// hidden (spec §4.1), the weather only reorders the page.
function accessoryOrder(items, band) {
  const list = [...(items || [])];
  const levels = band == null ? undefined : lookup(BAND_WARMTH, band);
  if (!levels) return list.sort(byId);
  const distance = (item) => {
    let best = Infinity;
    for (const l of WARMTH_LEVELS(item.warmth)) for (const b of levels) best = Math.min(best, Math.abs(l - b));
    return best;
  };
  const d = new Map(list.map(i => [i, distance(i)]));
  return list.sort((a, b) => d.get(a) - d.get(b) || byId(a, b));
}

// The worker's combo shape: a single is {key, one}; a pair is {key, top, bottom}.
function toWorkerShape(combo) {
  return combo.pieces.length === 1
    ? { key: combo.key, one: combo.pieces[0] }
    : { key: combo.key, top: combo.pieces[0], bottom: combo.pieces[1] };
}

module.exports = {
  NEUTRALS, HISTORY_DAYS_KEPT, FRESH_CAP_DAYS, FRESH_PTS_PER_DAY, LOVED_PTS,
  JITTER_PTS, STAPLE_SLOTS, STAPLE_POOL, YES_WEIGHT, INFERRED_WEIGHT, SINGLE_STYLE,
  BAND_WARMTH, WARMTH_LEVELS,
  GARMENT_KINDS, ACCESSORY_KINDS, CATEGORIES, OCCASIONS, isAccessory, accessoryOrder,
  h, hmod, dayKey, yesterdayOf, daysBetween, comboKey,
  attributes, isNeutral, harmonizes, styleScore, pairKey, normalizePairing,
  derivePicks, recordOffer, pruneEvents, lastPage1, yesterdayPage1,
  categoryOf, eligible, rankOf, buildCandidates, toWorkerShape,
};
