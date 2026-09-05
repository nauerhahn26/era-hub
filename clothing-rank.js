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

module.exports = {
  NEUTRALS, HISTORY_DAYS_KEPT, FRESH_CAP_DAYS, FRESH_PTS_PER_DAY, LOVED_PTS,
  JITTER_PTS, STAPLE_SLOTS, STAPLE_POOL, YES_WEIGHT, INFERRED_WEIGHT, SINGLE_STYLE,
  BAND_WARMTH, WARMTH_LEVELS,
  h, hmod, dayKey, yesterdayOf,
};
