// clothing-rank.js — the Clothing Picker's ranking and page assembly, a pure
// port of the original studio generator (dad's outfit_set.py, docs/plans/
// outfit-variety-plan.md, his 8/5 ruling: variety is prioritisation, never
// exclusion). Migrated 9/5 after dad found the hub's deal less varied and
// blind to her picks (spec: docs/superpowers/specs/2026-09-05-clothing-picker-
// migration-design.md).
//
// Pure: no file access, no clock reads, no randomness. Everything the deal
// depends on comes in as an argument — the items, the planning °F, the seed (the
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
// One place takes a hub-side default where the original's input cannot occur
// here (the hub tags warmth with a word); a parity audit should know it:
//   (D1)  WARMTH_LEVELS: an unknown or missing warmth word is level {1,2,3}
//         (spec §3.1 item 4). The original (:397, :402) tags an untagged
//         bottom level 2 and an untagged dress/set level 1. Since 9/29 only
//         accessoryOrder reads levels; the deal does not.
//
// REPLACED 9/29, a deliberate break from the port (dad 9/23: "all clothing
// should be gated by the weather, including tops"; 9/29, after an 81 °F board
// dealt 7 long sleeves and 11 leggings in 18 looks — spec docs/superpowers/
// specs/2026-09-29-warmth-coherence-and-dress-up.md §1-§2, amending
// 2026-09-23-warmth-model-design.md §2-§3): the band gate (outfit_set.py
// :181, :394-402 — tops never gated, bottoms/singles by BAND_WARMTH level, the
// hub's neighbour-band widen, and the old (D2) unknown-band rule).
//
// REPLACED AGAIN 9/29 PM (spec §7, dad: "the code shouldn't be all or nothing
// logic … a spectrum … should handle every #"): the §2 replacement was itself
// a gate — a °F comfort range per garment, a one-sided EDGE, a FLOOR_EDGES
// widen — and dealt cliffs (no pants at 78, no shorts at 63). With a planning
// °F the deal now refuses no garment by weather; one logistic curve per
// boundary gives each KIND of look (top-half coverage × legs side) its share
// of the day, kinds under 5 % are zero, and each page's slots are apportioned
// across the kinds by largest remainder (sharesAt / quotasFor below). Inside a
// kind the port's rank decides — staples, the coverage slot, freshness, loved,
// style — plus a fit term that orders weights. Weather offline (temp null) is
// the port's deal exactly. `occasion "fancy"` is dropped at the door (§2 D3).
// BAND_WARMTH stays: accessoryOrder reads it; buildCandidates accepts `band`
// and ignores it.
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

// allowed warmth LEVEL per band (outfit_set.py:181). Since 9/29 the deal no
// longer reads it (the spectrum below replaced it); accessoryOrder does.
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

// ---- the fit words (spec 2026-09-29 §2 D1, 9/23 §2) -------------------------
//
// A garment's warmth is how much it covers times how thick it is (9/23 §2),
// so each garment carries `coverage` (sleeve or leg length — shape, which
// vision reads well) and, on the rungs where it matters, `weight`. Since the
// 9/29 PM amendment (spec §7) coverage decides which KIND of look a garment
// makes — its cell — and the day's curve decides how many looks of each kind
// the board deals. Weight only ranks, inside a kind.
const COVERAGES = {
  top: new Set(["sleeveless", "short", "long"]),
  bottom: new Set(["short", "long"]),
  single: new Set(["sleeveless", "short", "long"]),   // its top half
};
const WEIGHTS = new Set(["light", "mid", "heavy"]);   // `unsure` is not one: it resolves to light
const LEGS = new Set(["bare", "covered"]);

// ---- the spectrum (spec 2026-09-29 §7, dad 9/29 PM) -------------------------
//
// Dad, 9/29, after the §2 gate was built: "the code shouldn't be all or
// nothing logic. At 70 should be an even mix of shorts and pants for instance.
// by 80 it should be 90% shorts, by 60 should be 90% pants, a spectrum is the
// logic/probabilities … should handle every #." The gate it replaces admitted
// or refused each garment by a °F range, which is a cliff by construction: no
// pants at all at 78, no shorts at all at 63. Now nothing is refused by the
// weather except a whole kind the curve gives under 5 %; the day's °F sets the
// SHARE of each kind of look, and each page's slots are split to match.
//
// One logistic curve, σ((t − crossover) / K), per boundary between kinds:
//   legs         shorts-side σ((t − 70) / K), pants-side the rest   (dad's 70)
//   top half     sleeveless  σ((t − 80) / K)                         (9/23 consensus: tank ≥ 80)
//                long sleeve 1 − σ((t − 63) / K)                     (9/23: short sleeve + pants 60-66
//                                                                    vs long sleeve + pants 50-60)
//                short sleeve what is left, clamped at 0
// K = 10 / ln 9 puts 10 °F from a crossover at exactly 90 / 10 — dad's own
// numbers. Tuning is moving one of these, and tests/clothing-fit.test.mjs
// (dad's 60 / 70 / 80, every °F 45-95) is what a move must keep green.
const SPECTRUM_K = 10 / Math.log(9);
const LEGS_CROSSOVER_F = 70;
const LONG_SLEEVE_CROSSOVER_F = 63;
const SLEEVELESS_CROSSOVER_F = 80;
// A kind whose share is under 5 % is zero for the day and the rest are
// renormalised (dad 9/29, "go"). It is what keeps a long sleeve out of a 78 °F
// deal (3.6 %) and a lone pair of shorts out of a 54 °F one (2.9 %): she
// cannot take a layer off, and one look in 18 is not a share, it is a mistake.
const SHARE_FLOOR = 0.05;
const TOP_KINDS = ["sleeveless", "short", "long"];
const LEG_SIDES = ["shorts", "pants"];
const sigmoid = x => 1 / (1 + Math.exp(-x));

// sharesAt(t) → {raw, top, legs}: the curve's shares at the planning °F, raw
// and with the floor applied (each dimension renormalised to 1). A dimension
// the floor would empty — it cannot, the curve always leaves one kind above
// 5 % — keeps its raw shares rather than deal nothing.
function sharesAt(t) {
  const shorts = sigmoid((t - LEGS_CROSSOVER_F) / SPECTRUM_K);
  const sleeveless = sigmoid((t - SLEEVELESS_CROSSOVER_F) / SPECTRUM_K);
  const long = 1 - sigmoid((t - LONG_SLEEVE_CROSSOVER_F) / SPECTRUM_K);
  const raw = {
    top: { sleeveless, short: Math.max(0, 1 - sleeveless - long), long },
    legs: { shorts, pants: 1 - shorts },
  };
  return { raw, top: floored(raw.top, TOP_KINDS), legs: floored(raw.legs, LEG_SIDES) };
}
// The floor and the renormalisation, over the kinds in `present` (all of them
// unless a wardrobe lacks some: spec §7.2, "renormalised over the non-empty
// cells"). `floor` 0 is the never-empty retry.
function floored(raw, kinds, present = null, floor = SHARE_FLOOR) {
  const out = {};
  let sum = 0;
  for (const k of kinds) {
    out[k] = (!present || present.has(k)) && raw[k] >= floor ? raw[k] : 0;
    sum += out[k];
  }
  for (const k of kinds) out[k] = sum > 0 ? out[k] / sum : 0;
  return out;
}

// lookCell(pieces) → {top, legs}: the kind of look, spec §7.2. A pair is its
// top's sleeves over its bottom's legs (short → shorts-side, long → pants-
// side); a single is its own top half and its legs (bare → shorts-side,
// covered → pants-side). Read through fitAttrs, so a garment refit has not
// reached yet is placed by the legacy fallback (§2 D1) — the curve holds for
// it too (§7.3).
function lookCell(pieces) {
  if (pieces.length === 1) {
    const a = fitAttrs(pieces[0]);
    return { top: a.coverage, legs: a.legs === "covered" ? "pants" : "shorts" };
  }
  let top = null, legs = null;
  for (const p of pieces) {
    const a = fitAttrs(p);
    if (a && a.role === "top") top = a.coverage;
    else if (a && a.role === "bottom") legs = a.coverage === "short" ? "shorts" : "pants";
  }
  return { top, legs };
}
const cellKey = c => c.top + "|" + c.legs;

// ---- fit: the rank inside a kind (spec §2 D2, kept by §7.2) -----------------
//
// FIT holds the °F each (role, coverage, weight) is best at. Since §7 it
// gates nothing — the curve decides the kinds — and only orders looks of the
// same kind: a mid long sleeve leads a light one on a cold morning and the
// light one leads on a warm one (§7.2). The numbers are the centres of the
// 9/29 §2 comfort ranges they replace (an open range's centre 10 °F inside its
// closed end), so the ladder the harness tuned that afternoon still orders a
// kind the same way. The sleeveless / short / shorts cells hold one weight in
// practice (weight is asked only of long sleeves and jackets, 9/23 §2); their
// mid/heavy cells exist so the table is total over anything a model writes.
const FIT = {
  top: {
    sleeveless: { light: 90, mid: 90, heavy: 90 },
    short: { light: 76, mid: 75, heavy: 75 },
    long: { light: 67.5, mid: 52, heavy: 48 },
  },
  bottom: {
    short: { light: 82, mid: 82, heavy: 82 },
    long: { light: 67.5, mid: 60, heavy: 50 },
  },
};
// The fit term's weight in rankOf, per °F a look's two halves sit from their
// centres. 3 (swept 2-12 on 9/29 for the §2 table) keeps the mid/light gap of
// 15.5 °F worth ~46 points — more than a day's freshness (6) or the jitter
// (0-15) — so the right weight leads its kind; within a kind of one weight
// the term is equal for every look and freshness decides, as in the port.
const FIT_PTS_PER_DEG = 3;

const isTemp = t => typeof t === "number" && Number.isFinite(t);
const fitWord = (v, allowed) => {
  if (typeof v !== "string") return undefined;
  const w = v.trim().toLowerCase();
  return allowed.has(w) ? w : undefined;
};
// The legacy fallback (spec §2 D1): until refit reaches a garment the deal
// reads its old warmth word — measured right for 59 of her 63 on 9/29. A word
// the hub does not know ("any", missing, junk) is the modal top, a short
// sleeve: degrade, never exclude by a guess (the spirit of D1 above). A
// migrated int tag (W3): 1 is the hot/warm level → short, 2 and 3 → long.
function legacyCoverage(warmth) {
  if (warmth === 2 || warmth === 3) return "long";
  const w = typeof warmth === "string" ? warmth.trim().toLowerCase() : "";
  if (w === "hot") return "sleeveless";
  if (w === "cool" || w === "cold") return "long";
  return "short";
}
const isColdWord = w => w === 3 || (typeof w === "string" && w.trim().toLowerCase() === "cold");

// fitAttrs(item) → {role, coverage, weight[, legs]} — the words the deal
// reads, each one resolved: a real value when the item carries one that fits
// its role, the fallback otherwise. null for anything that is not a garment
// (an accessory is never weather-gated, accessories spec §4.1).
//   coverage  top/single: the item's, else by warmth word (D1);
//             pants → long, shorts → short (the category IS the coverage).
//   weight    light|mid|heavy, else light — `unsure` is the row's modal
//             weight biased light, never `mid` blindly (9/23 §2).
//   legs      single only: bare|covered, else bare unless tagged cold (D1).
function fitAttrs(item) {
  const role = categoryOf(item);
  if (role !== "top" && role !== "bottom" && role !== "single") return null;
  const coverage = fitWord(item.coverage, COVERAGES[role])
    || (role === "bottom" ? (String(item.category).toLowerCase() === "shorts" ? "short" : "long") : legacyCoverage(item.warmth));
  const out = { role, coverage, weight: fitWord(item.weight, WEIGHTS) || "light" };
  if (role === "single") out.legs = fitWord(item.legs, LEGS) || (isColdWord(item.warmth) ? "covered" : "bare");
  return out;
}

// The FIT rows a garment is made of: one for a top or a bottom, two for a
// single (its top half, then its legs as the bottom row they stand for: bare =
// shorts, covered = long pants of its weight) — so a sundress and the
// tank-and-shorts it stands for rank alike.
function rowsOf(a) {
  if (a.role !== "single") return [FIT[a.role][a.coverage][a.weight]];
  return [FIT.top[a.coverage][a.weight], a.legs === "covered" ? FIT.bottom.long[a.weight] : FIT.bottom.short[a.weight]];
}

// fitFields(meta, category, {parent}) → the subset of {coverage, weight, legs}
// a catalogue entry, a shared tag line or a manual edit may carry for a garment
// of `category` (spec 2026-09-29 §3). The ingest prompt, the refit pass and the
// hold sheet's route all go through it, so the words the deal reads can only
// ever be words the deal knows — the same rule attributes() keeps for taste
// (which deliberately stays taste-only: a refit must never re-open a colour).
// Each field is a word from its own list, folded like every other whitelist;
// anything else is ABSENT, never guessed, and the legacy fallback (D1) covers
// the gap:
//   coverage  top / dress / set / jacket: sleeveless|short|long;
//             pants / shorts: short|long (a capri is a short pant).
//   legs      a dress or a set only: bare|covered.
//   weight    light|mid|heavy, or the model's `unsure` (→ light in fitAttrs,
//             9/23 §2) — never from a parent ({parent: true}, the sheet has no
//             such chip, D4). Kept only where the prompt asks it: a jacket, or a
//             garment whose coverage is long (pants are long unless told
//             otherwise). A heavy TEE is a word nobody asked for — 9/23 §2
//             measured the difference at half a degree — and in FIT it would
//             rank a tee a notch colder than its kind, so it is dropped rather
//             than obeyed.
// opts.coverage is the entry's stored coverage, for an edit that sends a
// weight alone. Returns {} for anything that is neither a garment nor a jacket.
const FIT_COVERAGE = {
  top: COVERAGES.top, dress: COVERAGES.single, set: COVERAGES.single, jacket: COVERAGES.top,
  pants: COVERAGES.bottom, shorts: COVERAGES.bottom,
};
const MODEL_WEIGHTS = new Set([...WEIGHTS, "unsure"]);
function fitFields(meta, category, opts = {}) {
  const m = meta && typeof meta === "object" ? meta : {};
  const cat = String(category || "").toLowerCase();
  const allowed = lookup(FIT_COVERAGE, cat);
  if (!allowed) return {};
  const out = {};
  const coverage = fitWord(m.coverage, allowed);
  if (coverage) out.coverage = coverage;
  // opts.coverage: the entry's stored word, for an edit that names the weight
  // alone (the sheet sends only the rows a parent changed, D4).
  const cov = coverage || fitWord(opts.coverage, allowed) || (cat === "pants" ? "long" : "");
  const long = cat === "jacket" || cov === "long";
  const weight = fitWord(m.weight, opts.parent ? WEIGHTS : MODEL_WEIGHTS);
  if (weight && long) out.weight = weight;
  if (cat === "dress" || cat === "set") { const legs = fitWord(m.legs, LEGS); if (legs) out.legs = legs; }
  return out;
}
// Is this a piece the fit words describe at all — a garment, or a jacket (its
// weight)? The refit pass asks about these and nothing else, and
// /clothing/status counts them, so the two can never disagree about what
// "pending" means.
const fitTarget = item => !!(item && lookup(FIT_COVERAGE, String(item.category || "").toLowerCase()));
// The words themselves, for a door that has to name them back to a parent
// (server.js /clothing/item) — the lists above, never a copy.
const FIT_WORDS = {
  coverage: cat => (lookup(FIT_COVERAGE, String(cat || "").toLowerCase()) ? [...lookup(FIT_COVERAGE, String(cat).toLowerCase())] : []),
  weight: [...WEIGHTS], legs: [...LEGS],
};

// ---- the rank (outfit_set.py:434-451, minus dress_bonus — no "dressy" here) --
//
// ctx = {seed, pairing (normalised), favorites (Set of ids), picks, lastP1,
// temp}. fresh: the look is as fresh as its LEAST fresh piece; a piece never
// on page 1 counts as FRESH_CAP_DAYS + 1 days old. fit (9/29, no original —
// spec 2026-09-29 §2 D2; since §7 it ranks inside a kind and gates nothing):
// −FIT_PTS_PER_DEG per °F the look's two halves sit from their FIT centres,
// summed, rounded. Every look is a top half and a
// bottom half — a pair's two pieces, a single's two rows — so a sundress and
// the tank-and-shorts it stands for rank alike. (The worst piece alone, like
// fresh, was tried and failed the sweep: on a cold day the light pants' 20 °F
// hid the difference between a sweatshirt and a thin long sleeve.) No temp
// (weather offline) is no fit term, so every rank is the port's. Every term
// is an integer, so the sort below is exact.
function fitPts(pieces, temp) {
  if (!isTemp(temp)) return 0;
  let d = 0;
  for (const p of pieces) {
    const a = fitAttrs(p);
    if (a) for (const c of rowsOf(a)) d += Math.abs(temp - c);
  }
  return -Math.round(FIT_PTS_PER_DEG * d);
}
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
  return style + fav + fresh + loved + fitPts(pieces, ctx.temp) + hmod(ctx.seed, JITTER_PTS, key);
}

function cmpHash(a, b) {   // I4: BigInt comparison, never subtraction
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- the pool (outfit_set.py:397-410) ----------------------------------------
//
// singles (standalone) then tops × bottoms. The weather refuses no garment
// here since §7: `keep` (from the day's shares) drops only the looks of a kind
// the curve zeroed — under the 5 % floor — so the floor below counts what
// the day can actually deal.
// Case-folded like every other word the hub reads off a catalogue entry: a
// shared line from another device is the same fancy as the hold sheet's.
const isFancy = i => typeof i.occasion === "string" && i.occasion.trim().toLowerCase() === "fancy";
const ofRole = (items, role) => items.filter(i => categoryOf(i) === role);
function poolOf(items, pairing, pageCap, keep = () => true) {
  const tops = ofRole(items, "top");
  const bottoms = ofRole(items, "bottom");
  const singles = ofRole(items, "single").map(g => [g]).filter(keep);
  const pairs = [];
  for (const t of tops)
    for (const b of bottoms)
      if (harmonizes(t, b) && styleScore(t, b, pairing) > 0 && keep([t, b])) pairs.push([t, b]);
  // HUB DEVIATION (spec §3.4's rule, §3.1 item 4): the taste gate has the same
  // floor the weather has — "a wardrobe must never empty the board". A
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
  // Above the page the floor stays shut, so a board that already holds a page
  // of harmonizing looks is never padded with loud-on-loud ones.
  if (pairs.length + singles.length < pageCap && tops.length && bottoms.length) {
    const already = new Set(pairs.map(comboKey));   // a harmonizing pair is not dealt twice
    for (const t of tops)
      for (const b of bottoms)
        if (!already.has(comboKey([t, b])) && styleScore(t, b, pairing) > 0 && keep([t, b])) pairs.push([t, b]);
  }
  return singles.concat(pairs);
}

// ---- the day's shares over her wardrobe (spec §7.1, §7.2) -------------------
//
// spectrumOf(items, temp, pairing, pageCap) → {pool, top, legs, cellOf} or
// null. The kinds are renormalised over the ones her wardrobe can make at all
// (a wardrobe with no sleeveless top gives its sleeveless share to the other
// sleeves, not to nothing). Never empty (§7.2): if the floor leaves no look,
// the floor is dropped; if there is still none, null — the caller deals the
// whole wardrobe as the port did.
function spectrumOf(items, temp, pairing, pageCap) {
  const all = poolOf(items, pairing, pageCap);
  const cells = new Map(all.map(o => [comboKey(o), lookCell(o)]));
  const present = { top: new Set(), legs: new Set() };
  for (const c of cells.values()) { present.top.add(c.top); present.legs.add(c.legs); }
  const { raw } = sharesAt(temp);
  for (const floor of [SHARE_FLOOR, 0]) {
    const top = floored(raw.top, TOP_KINDS, present.top, floor);
    const legs = floored(raw.legs, LEG_SIDES, present.legs, floor);
    const keep = o => { const c = lookCell(o); return top[c.top] > 0 && legs[c.legs] > 0; };
    const pool = poolOf(items, pairing, pageCap, keep);
    if (pool.length) return { pool, top, legs, cellOf: o => cellKey(lookCell(o)) };
  }
  return null;
}

// Largest remainder of `slots` over `exact` (a {kind: fractional seats} map
// summing to `slots`): every kind its floor, the seats left to the largest
// remainders. A remainder tie breaks by h(seed, "cell", …, page) so 70 °F,
// seven slots, gives the odd one to shorts on some days and to pants on
// others rather than always to one side (spec §7.2).
const EPS = 1e-9;
function largestRemainder(slots, exact, seed, ...tag) {
  const kinds = Object.keys(exact);
  const out = {};
  let left = slots;
  for (const k of kinds) { out[k] = Math.floor(exact[k] + EPS); left -= out[k]; }
  const rem = k => exact[k] - out[k];
  const tie = new Map(kinds.map(k => [k, h(seed, "cell", ...tag, k)]));
  const order = kinds.filter(k => exact[k] > EPS)
    .sort((a, b) => (Math.abs(rem(b) - rem(a)) > EPS ? rem(b) - rem(a) : cmpHash(tie.get(b), tie.get(a))));
  for (let i = 0; left > 0 && order.length; i = (i + 1) % order.length, left--) out[order[i]] += 1;
  return out;
}

// quotasFor(spec, slots, dealt, page, seed) → {quota, exact} per cell key.
// Each dimension is apportioned on its own — legs over shorts / pants, the top
// half over sleeveless / short / long — so page 1's counts ARE the
// apportionment of dad's curve in both (the harness asserts exactly that);
// then each sleeve row's seats are split between the two legs sides in the
// legs' proportion, largest remainder down each column, which meets both sets
// of totals. Deeper pages are apportioned the same way over what is left:
// each kind's target is its share of every slot dealt so far, less what it
// already has, so the whole deal tracks the curve rather than drifting a
// page's rounding at a time (§7.3: ±10 points across the deal).
function quotasFor(spec, slots, dealt, page, seed) {
  const done = Object.values(dealt.top).reduce((a, b) => a + b, 0);
  const marginal = (dim, kinds) => {
    const exact = {};
    let sum = 0;
    for (const k of kinds) { exact[k] = spec[dim][k] > 0 ? Math.max(0, (done + slots) * spec[dim][k] - dealt[dim][k]) : 0; sum += exact[k]; }
    for (const k of kinds) exact[k] = sum > 0 ? exact[k] * slots / sum : slots * spec[dim][k];
    return largestRemainder(slots, exact, seed, dim, String(page));
  };
  const T = marginal("top", TOP_KINDS), L = marginal("legs", LEG_SIDES);
  const quota = {}, exact = {}, margin = { top: T, legs: L };
  const shortsExact = {};
  for (const r of TOP_KINDS) {
    shortsExact[r] = slots > 0 ? (T[r] * L.shorts) / slots : 0;
    exact[r + "|shorts"] = shortsExact[r];
    exact[r + "|pants"] = T[r] - shortsExact[r];
  }
  const shorts = largestRemainder(L.shorts, shortsExact, seed, "column", String(page));
  for (const r of TOP_KINDS) {
    quota[r + "|shorts"] = Math.min(shorts[r], T[r]);
    quota[r + "|pants"] = T[r] - quota[r + "|shorts"];
  }
  return { quota, exact, margin };
}

// ---- buildCandidates (outfit_set.py:376-557) --------------------------------
//
// Returns the flat ordered list of {key, pieces} for the day: page 1 first
// (staples, the coverage slot, the freshest fill — garment-distinct), then
// the deeper pages. Pure: same inputs → same list.
//
// opts.temp is the planning °F (the window's maximum, 9/23 §4 — the worker's
// `w.t`); null means the weather is offline, and the deal is the port's,
// exactly: no shares, no apportionment (spec §7.2). opts.band is still
// accepted — the worker's offer record carries it — and decides nothing here
// since 9/29 (spec 2026-09-29 §3).
//
// With a temp, each page's slots are apportioned across the kinds of look
// (quotasFor), and every step of the port's page assembly takes a look only
// while its kind has a slot left: a staple or the coverage slot takes a
// page-1 slot only from its own kind's quota (§7.2). Inside a kind the port's
// rank decides, as it always did. A kind that runs dry on a page gives its
// slots to the kind furthest below its exact share that can still take one.
function buildCandidates(opts) {
  const seed = opts.seed;
  // The seed is the family's day key and nothing else: a Date, a timestamp or
  // a number would hash to a different deal than the day's on another device.
  if (typeof seed !== "string" || !DATE_KEY.test(seed)) throw new TypeError("buildCandidates: seed must be a YYYY-MM-DD day key");
  const temp = isTemp(opts.temp) ? opts.temp : null;
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
  // Since 9/29 a garment a parent marked fancy goes the same way (spec
  // 2026-09-29 §2 D3): it lives on the Dress up page and is never dealt — not
  // even by the never-empty rule, which only ever reads `items`.
  const items = [...(opts.items || [])]
    .filter(i => i.hidden !== true && categoryOf(i) !== "accessory" && !isFancy(i))
    .sort(byId);
  const pageCap = Math.min(perPage, cap);

  const spec = temp == null ? null : spectrumOf(items, temp, pairing, pageCap);
  const pool = spec ? spec.pool : poolOf(items, pairing, pageCap);

  // :412-427 — memory as of today (today's own entries ignored: same-date reruns stay stable).
  const picks = derivePicks(eventsOf(history), seed);
  const lastP1 = lastPage1(history, seed);
  const yP1 = yesterdayPage1(history, seed);
  const ctx = { seed, pairing, favorites, picks, lastP1, temp };

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
  // The page's quotas (spec §7.2). Offline there are none and `room` is always
  // true, so every loop below is the port's, look for look.
  const dealt = { top: Object.fromEntries(TOP_KINDS.map(k => [k, 0])), legs: Object.fromEntries(LEG_SIDES.map(k => [k, 0])) };
  let page = null;
  const openPage = (n, index) => {
    page = spec ? { ...quotasFor(spec, n, dealt, index, seed), taken: {}, row: {}, col: {} } : null;
  };
  const room = o => {
    if (!page) return true;
    const c = spec.cellOf(o);
    return (page.taken[c] || 0) < (page.quota[c] || 0);
  };
  const count = o => {
    if (!page) return;
    const c = spec.cellOf(o);
    page.taken[c] = (page.taken[c] || 0) + 1;
    const cell = lookCell(o);
    dealt.top[cell.top] += 1;
    dealt.legs[cell.legs] += 1;
    page.row[cell.top] = (page.row[cell.top] || 0) + 1;
    page.col[cell.legs] = (page.col[cell.legs] || 0) + 1;
  };
  // A kind that ran dry gives its slots away (§7.2): one at a time, to the
  // cell that still has a look it can take and is furthest below the page's
  // apportionment — first by its sleeve row's and legs side's shortfall
  // together, so a dry row's slot stays on its own legs side (one long sleeve
  // in the wardrobe at 60 °F must not turn the page's pants slots into
  // shorts: the legs are not dry), then by the cell's own exact share, then
  // by the day's hash, like every other tie here.
  const spill = (order, takeable, take, full) => {
    if (!page) return;
    while (!full()) {
      const best = new Map();
      for (const o of order) {
        if (!takeable(o)) continue;
        const c = spec.cellOf(o);
        if (!best.has(c)) best.set(c, o);
      }
      if (!best.size) return;
      const short = c => {
        const [r, l] = c.split("|");
        return (page.margin.top[r] - (page.row[r] || 0)) + (page.margin.legs[l] - (page.col[l] || 0));
      };
      const need = c => (page.exact[c] || 0) - (page.taken[c] || 0);
      const cells = [...best.keys()].sort((a, b) => short(b) - short(a)
        || (Math.abs(need(b) - need(a)) > EPS ? need(b) - need(a) : cmpHash(h(seed, "cell", "spill", b), h(seed, "cell", "spill", a))));
      page.quota[cells[0]] = (page.quota[cells[0]] || 0) + 1;
      take(best.get(cells[0]));
    }
  };

  const used = new Set();
  const take = o => {
    chosen.push(o);
    chosenKeys.add(key(o));
    for (const p of o) used.add(p.id);
    count(o);
  };
  openPage(pageCap, 1);
  for (const o of top) {                                   // :483-492
    if (chosen.length >= STAPLE_SLOTS) break;
    if (yP1.has(key(o))) continue;
    if (!o.some(p => used.has(p.id)) && room(o)) take(o);
  }

  // :497-518 — coverage: the single longest-unseen garment, in its best look
  // (with a temp: its best look of a kind with a slot left).
  const age = g => (g.id in lastP1 ? daysBetween(lastP1[g.id], seed) : 1e6);
  const bandIds = new Set();
  for (const o of pool) for (const p of o) bandIds.add(p.id);
  const agedHash = new Map();
  const aged = items.filter(g => bandIds.has(g.id) && !used.has(g.id));
  for (const g of aged) agedHash.set(g.id, h(seed, "aged", g.id));
  aged.sort((a, b) => age(b) - age(a) || cmpHash(agedHash.get(a.id), agedHash.get(b.id)));
  if (aged.length && chosen.length < pageCap) {
    const want = aged[0].id;
    const best = ranked.find(o => o.some(p => p.id === want) && !chosenKeys.has(key(o)) && !yP1.has(key(o)) && !o.some(p => used.has(p.id)) && room(o));
    if (best) take(best);
  }

  // :522-533 — fill page 1 (yesterday's looks sit out), then tiny-pool relaxation.
  for (const o of ranked) {
    if (chosen.length >= pageCap) break;
    if (!chosenKeys.has(key(o)) && !yP1.has(key(o)) && !o.some(p => used.has(p.id)) && room(o)) take(o);
  }
  for (const o of ranked) {
    if (chosen.length >= pageCap) break;
    if (!chosenKeys.has(key(o)) && !o.some(p => used.has(p.id)) && room(o)) take(o);
  }
  const free1 = o => !chosenKeys.has(key(o)) && !o.some(p => used.has(p.id));
  spill(ranked.filter(o => !yP1.has(key(o))).concat(ranked.filter(o => yP1.has(key(o)))), free1, take, () => chosen.length >= pageCap);

  // :538-556 — deeper pages: yesterday's page 1 leads page 2; a garment once per page.
  const demoted = ranked.filter(o => yP1.has(key(o)));
  const deepOrder = demoted.concat(ranked.filter(o => !yP1.has(key(o))));
  let index = 1;
  while (chosen.length < Math.min(cap, pool.length)) {
    const pageUsed = new Set();
    let pageCount = 0;
    index += 1;
    const slots = Math.min(perPage, cap - chosen.length);
    openPage(slots, index);
    const put = o => {
      chosen.push(o);
      chosenKeys.add(key(o));
      for (const p of o) pageUsed.add(p.id);
      pageCount += 1;
      count(o);
    };
    for (const o of deepOrder) {
      if (pageCount >= perPage || chosen.length >= cap) break;
      if (chosenKeys.has(key(o)) || o.some(p => pageUsed.has(p.id)) || !room(o)) continue;
      put(o);
    }
    spill(deepOrder, o => !chosenKeys.has(key(o)) && !o.some(p => pageUsed.has(p.id)), put,
      () => pageCount >= slots || chosen.length >= cap);
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
// Like the deal since §7, this NEVER drops an item: an accessory is never weather-
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
  BAND_WARMTH, WARMTH_LEVELS, FIT, FIT_PTS_PER_DEG, fitAttrs, fitFields, fitTarget, FIT_WORDS,
  SPECTRUM_K, LEGS_CROSSOVER_F, LONG_SLEEVE_CROSSOVER_F, SLEEVELESS_CROSSOVER_F, SHARE_FLOOR, sharesAt, lookCell,
  GARMENT_KINDS, ACCESSORY_KINDS, CATEGORIES, OCCASIONS, isAccessory, accessoryOrder,
  h, hmod, dayKey, yesterdayOf, daysBetween, comboKey,
  attributes, isNeutral, harmonizes, styleScore, pairKey, normalizePairing,
  derivePicks, recordOffer, pruneEvents, lastPage1, yesterdayPage1,
  categoryOf, rankOf, buildCandidates, toWorkerShape,
};
