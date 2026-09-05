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
function WARMTH_LEVELS(w) {
  if (w === 1 || w === 2 || w === 3) return new Set([w]);
  const lv = WORD_LEVELS[String(w || "").toLowerCase()];
  return new Set(lv || [1, 2, 3]);   // untagged = never gated out
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
const word = (v, allowed) => {
  const w = String(v == null ? "" : v).trim().toLowerCase();
  return allowed.has(w) ? w : undefined;
};
function colorList(v) {
  const parts = Array.isArray(v) ? v.flatMap(c => String(c).split(/\s*(?:,|\/|&)\s*|\s+and\s+/i))
    : typeof v === "string" ? v.split(/\s*(?:,|\/|&)\s*|\s+and\s+/i) : [];
  const out = [];
  for (const p of parts) {
    const c = p.trim().toLowerCase().replace(/\s+/g, " ");   // "light blue" stays one entry
    if (c && !out.includes(c)) out.push(c);
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
function normalizePairing(p) {
  const toSet = list => new Set((Array.isArray(list) ? list : [])
    .filter(pr => Array.isArray(pr) && pr.length === 2).map(pr => pairKey(String(pr[0]), String(pr[1]))));
  if (p && p.great instanceof Set && p.avoid instanceof Set) return p;
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

module.exports = {
  NEUTRALS, HISTORY_DAYS_KEPT, FRESH_CAP_DAYS, FRESH_PTS_PER_DAY, LOVED_PTS,
  JITTER_PTS, STAPLE_SLOTS, STAPLE_POOL, YES_WEIGHT, INFERRED_WEIGHT, SINGLE_STYLE,
  BAND_WARMTH, WARMTH_LEVELS,
  h, hmod, dayKey, yesterdayOf,
  attributes, isNeutral, harmonizes, styleScore, pairKey, normalizePairing,
};
