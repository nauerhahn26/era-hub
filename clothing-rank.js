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
// hub's neighbour-band widen, and the old (D2) unknown-band rule). The deal
// now gates EVERY role by the planning °F against a comfort range derived
// from each garment's (role, coverage, weight) — FIT / fitOf / eligible below
// — with the edge on the cold side only, ranks by fit, and drops `occasion
// "fancy"` at its door (spec §2 D3). BAND_WARMTH stays: accessoryOrder reads
// it; buildCandidates accepts `band` and ignores it.
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
// longer reads it (the fit gate below replaced it); accessoryOrder does.
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

// ---- the fit gate (spec 2026-09-29 §2 D1/D2, amending 2026-09-23 §2-§3) ----
//
// A garment's warmth is how much it covers times how thick it is (9/23 §2),
// so each garment carries `coverage` (sleeve or leg length — shape, which
// vision reads well) and, on the rungs where it matters, `weight`. FIT turns
// (role, coverage, weight) into a comfort range in °F. The table lives HERE:
// dad tunes garments on the hold sheet, never the table (9/23). What is fixed
// is not these numbers but what the board may deal at each temperature — the
// threshold table in spec 2026-09-29 §2 D2, asserted over her wardrobe's shape
// by tests/clothing-fit.test.mjs. Move a row, run the harness.
//
// Starting point: the 9/23 §3 table, itself the published consensus (tank ≥ 80,
// tee + shorts 72-80, short sleeve + pants 60-66, long sleeve + pants 50-60,
// jacket + warm pants 40-50). Open ends are ±Infinity. Rows moved 9/29 by
// the harness sweep (40-100 °F, seven days running, seven start weeks), each
// for one threshold and each inside the charts' own spread:
//   top sleeveless   78 → ∞   →  80 → ∞   the consensus number itself (tank ≥ 80
//                                          ±2); at 78 the cold edge reached 70
//                                          and a sundress took page 1 at 70-71
//                                          ("62-71: no sleeveless on page 1").
//   top long light   55 → 75  →  58 → 77  hi: a thin long sleeve is still fair at
//                                          76-77 ("72-77" forbids only mid/heavy);
//                                          lo: its centre moves up and away from
//                                          the mid row's (below).
//   top long mid     48 → 68  →  42 → 62  "long sleeve + pants 50-60" is the thin
//                                          one's rung; a sweatshirt is the rung
//                                          under it ("jacket + warm pants 40-50"
//                                          ±3). The 15 °F between the two centres
//                                          is what lets "< 54: mid/heavy before
//                                          light" beat a day's freshness (42 pts).
//   bottom long light 58 → 85 → 58 → 77  "tee + shorts 72-80": light pants are
//                                          the 60-76 bottom. At 85 they dealt 4-9
//                                          pants looks at 78-84 (freshness floods
//                                          back yesterday's unseen pants); dad
//                                          9/29: at 79 "maybe one pant outfit".
// Unchanged: short (the 66-72 rung stays interpolated, 9/23 §9), long heavy,
// shorts 72 → ∞, pants mid/heavy.
const COVERAGES = {
  top: new Set(["sleeveless", "short", "long"]),
  bottom: new Set(["short", "long"]),
  single: new Set(["sleeveless", "short", "long"]),   // its top half
};
const WEIGHTS = new Set(["light", "mid", "heavy"]);   // `unsure` is not one: it resolves to light
const LEGS = new Set(["bare", "covered"]);
const INF = Infinity;
const FIT = {
  top: {
    // weight is never asked of a sleeveless or short-sleeve top (9/23 §2: a
    // light vs heavy tee is ~0.5 °F, beneath the forecast's own noise); the
    // mid/heavy cells exist so the table is total over anything a model writes
    sleeveless: { light: [80, INF], mid: [80, INF], heavy: [80, INF] },
    short: { light: [66, INF], mid: [62, 88], heavy: [62, 88] },
    long: { light: [58, 77], mid: [42, 62], heavy: [-INF, 58] },
  },
  bottom: {
    short: { light: [72, INF], mid: [72, INF], heavy: [72, INF] },
    long: { light: [58, 77], mid: [48, 72], heavy: [-INF, 60] },
  },
};
// How far BELOW its range a garment is still admitted (9/23 §3: the largest
// published disagreement between the charts, so the gate is never more sure
// than the evidence). One-sided since 9/29 (spec §2 D2): below its range a
// garment is merely too light — nothing a jacket cannot fix; above it, it is
// too warm, and that is the error she cannot undo. No warm-side edge at all.
const EDGE = 8;
// The fit term's weight in rankOf, per °F of distance from the range's centre.
// Spec §2 D2 asks it to be large enough that the better-suited looks fill the
// pages before freshness (0-48) and jitter (0-15) decide. Swept 2-12 on 9/29:
// the "72-77: shorts and pants both present" row needs the pants/shorts gap
// SMALL (that gap swings 2 °F per °F across the band), the "< 54" row needs
// the mid/light gap LARGE; 3 is where the two meet best. At every k swept the
// first day with no memory deals one bottom kind only at 72 / 77 (freshness is
// equal for every look, so fit alone decides); every later day passes. Ruled
// 9/29 (spec §2 †): that row is a VARIETY verdict, judged on days with a
// memory — every real morning — rather than a page-1 slot dad never asked for.
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

// fitAttrs(item) → {role, coverage, weight[, legs]} — the words the gate
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

// fitOf(item) → {lo, hi, centre} in °F, or null for a non-garment. A single
// is its top half AND its legs (bare = shorts, covered = long pants of its
// weight): comfortable where both halves are, so its range is the overlap.
// Two halves that never overlap (a heavy long-sleeve dress with bare legs)
// meet in the gap between them — the compromise zone, still ordered on the
// ladder. The centre is the midpoint, or 10 °F inside an open range's closed
// end (spec §2 D2).
// The FIT rows a garment is made of: one for a top or a bottom, two for a
// single (its top half, then its legs as the bottom row they stand for).
function rowsOf(a) {
  if (a.role !== "single") return [FIT[a.role][a.coverage][a.weight]];
  return [FIT.top[a.coverage][a.weight], a.legs === "covered" ? FIT.bottom.long[a.weight] : FIT.bottom.short[a.weight]];
}
const centreOf = ([lo, hi]) => (lo === -INF ? hi - 10 : hi === INF ? lo + 10 : (lo + hi) / 2);
function fitOf(item) {
  const a = fitAttrs(item);
  if (!a) return null;
  const rows = rowsOf(a);
  let lo = Math.max(...rows.map(r => r[0])), hi = Math.min(...rows.map(r => r[1]));
  if (lo >= hi) [lo, hi] = [hi, lo];
  return { lo, hi, centre: centreOf([lo, hi]) };
}

// eligible(items, cat, temp, edge = EDGE): the items of `cat` ("top" |
// "bottom" | "single") whose range admits the planning °F, in the order
// given: inside [lo, hi], or up to `edge` degrees below lo — never above hi,
// however wide the edge. temp null / not a finite number (weather offline; a
// band word is not a temperature) gates nothing, as band null did. The floor
// that keeps the board from emptying is the deal's, not a category's (a
// category with nothing suitable is fine while the others fill a page) — it
// lives in buildCandidates and widens `edge`.
function eligible(items, cat, temp, edge = EDGE) {
  const ofCat = items.filter(i => categoryOf(i) === cat);
  if (!isTemp(temp)) return ofCat;
  return ofCat.filter(i => { const f = fitOf(i); return temp <= f.hi && temp >= f.lo - edge; });
}

// fitFields(meta, category, {parent}) → the subset of {coverage, weight, legs}
// a catalogue entry, a shared tag line or a manual edit may carry for a garment
// of `category` (spec 2026-09-29 §3). The ingest prompt, the refit pass and the
// hold sheet's route all go through it, so the words the gate reads can only
// ever be words the gate knows — the same rule attributes() keeps for taste
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
//             close a tee's hot end, so it is dropped rather than obeyed.
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
// spec 2026-09-29 §2 D2): −FIT_PTS_PER_DEG per °F the look's two halves sit
// from their rows' centres, summed, rounded. Every look is a top half and a
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
    if (a) for (const r of rowsOf(a)) d += Math.abs(temp - centreOf(r));
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
// singles (standalone) then tops × bottoms, every role through the fit gate at
// `edge`. buildCandidates calls this once per step of its floor.
const FLOOR_EDGES = [EDGE, 2 * EDGE, 3 * EDGE, 4 * EDGE, Infinity];
// Case-folded like every other word the hub reads off a catalogue entry: a
// shared line from another device is the same fancy as the hold sheet's.
const isFancy = i => typeof i.occasion === "string" && i.occasion.trim().toLowerCase() === "fancy";
function poolAt(items, temp, edge, pairing, pageCap) {
  const tops = eligible(items, "top", temp, edge);
  const bottoms = eligible(items, "bottom", temp, edge);
  const singles = eligible(items, "single", temp, edge).map(g => [g]);
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
  return singles.concat(pairs);
}

// ---- buildCandidates (outfit_set.py:376-557) --------------------------------
//
// Returns the flat ordered list of {key, pieces} for the day: page 1 first
// (staples, the coverage slot, the freshest fill — garment-distinct), then
// the deeper pages. Pure: same inputs → same list.
//
// opts.temp is the planning °F (the window's maximum, 9/23 §4 — the worker's
// `w.t`); null means the weather is offline and nothing is gated. opts.band is
// still accepted — the worker's offer record carries it — and decides nothing
// here since 9/29 (spec 2026-09-29 §3).
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
  // even by the never-empty floor, which only ever reads `items`.
  const items = [...(opts.items || [])]
    .filter(i => i.hidden !== true && categoryOf(i) !== "accessory" && !isFancy(i))
    .sort(byId);
  const pageCap = Math.min(perPage, cap);

  // The floor (9/23 §3, kept in spirit 9/29): "never empty the board". A day
  // whose honest pool cannot fill ONE page widens the cold-side edge a step at
  // a time — a garment too light for the day is nothing a jacket cannot fix —
  // until a page fills or nothing colder is left to admit. Only a pool that
  // is still EMPTY then deals the whole category, too-warm garments and all:
  // one honest look beats any number of garments she cannot take off. The
  // widen is deal-wide on purpose: a role with nothing suitable is fine while
  // the others fill a page (no sundress at 45 °F just because singles are
  // empty).
  let pool = [];
  for (const edge of temp == null ? [0] : FLOOR_EDGES) {
    pool = poolAt(items, temp, edge, pairing, pageCap);
    if (pool.length >= pageCap) break;
  }
  if (!pool.length && temp != null) pool = poolAt(items, null, 0, pairing, pageCap);

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
  BAND_WARMTH, WARMTH_LEVELS, FIT, EDGE, FIT_PTS_PER_DEG, fitAttrs, fitOf, fitFields, fitTarget, FIT_WORDS,
  GARMENT_KINDS, ACCESSORY_KINDS, CATEGORIES, OCCASIONS, isAccessory, accessoryOrder,
  h, hmod, dayKey, yesterdayOf, daysBetween, comboKey,
  attributes, isNeutral, harmonizes, styleScore, pairKey, normalizePairing,
  derivePicks, recordOffer, pruneEvents, lastPage1, yesterdayPage1,
  categoryOf, eligible, rankOf, buildCandidates, toWorkerShape,
};
