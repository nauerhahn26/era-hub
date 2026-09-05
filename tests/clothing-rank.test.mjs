// clothing-rank.test.mjs — the pure ranking module (clothing-rank.js), a port
// of the original outfit_set.py lines 61-73 and 242-557. No server, no port,
// no network, no key, no family data: every garment here is invented.
// (Port table: this suite claims none — plan §B.)
//
// Parity cases cite outfit_set.py line numbers; the two labelled deviations
// (I5 degrade-never-exclude, W1 items sorted by id) sit in their own
// "hub deviation" blocks so a parity audit can skip them.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const R = require(path.join(HUB, "clothing-rank.js"));

// ---- T1.1 constants, h(), dayKey(), yesterdayOf() ---------------------------

describe("constants (outfit_set.py:61-73, 181, 293-299, 316-317)", () => {
  test("NEUTRALS has the original's 11 colour words incl. light blue", () => {
    assert.equal(R.NEUTRALS.size, 11);
    for (const c of ["white", "cream", "beige", "tan", "gray", "grey", "black", "navy", "denim", "light blue", "blue"])
      assert.ok(R.NEUTRALS.has(c), c);
  });
  test("rotation + weight constants match the original", () => {
    assert.equal(R.HISTORY_DAYS_KEPT, 60);
    assert.equal(R.FRESH_CAP_DAYS, 8);
    assert.equal(R.FRESH_PTS_PER_DAY, 6);
    assert.equal(R.LOVED_PTS, 12);
    assert.equal(R.JITTER_PTS, 16);
    assert.equal(R.STAPLE_SLOTS, 2);
    assert.equal(R.STAPLE_POOL, 5);
    assert.equal(R.YES_WEIGHT, 1.0);
    assert.equal(R.INFERRED_WEIGHT, 0.5);
    assert.equal(R.SINGLE_STYLE, 55);   // outfit_set.py:435, :465
  });
  test("BAND_WARMTH is the original's level table (outfit_set.py:181)", () => {
    const lv = b => [...R.BAND_WARMTH[b]].sort();
    assert.deepEqual(lv("hot"), [1]);
    assert.deepEqual(lv("warm"), [1, 2]);
    assert.deepEqual(lv("cool"), [2, 3]);
    assert.deepEqual(lv("cold"), [3]);
  });
  test("WARMTH_LEVELS maps the hub's words to levels (spec §3.4); ints pass through", () => {
    const lv = w => [...R.WARMTH_LEVELS(w)].sort();
    assert.deepEqual(lv("hot"), [1]);
    assert.deepEqual(lv("warm"), [1]);
    assert.deepEqual(lv("cool"), [2]);
    assert.deepEqual(lv("cold"), [3]);
    assert.deepEqual(lv("any"), [1, 2, 3]);
    assert.deepEqual(lv(3), [3]);          // migrated tag (W3)
    assert.deepEqual(lv(1), [1]);
  });
});

describe("h() — sha256(seed|parts) as a BigInt (outfit_set.py:430-432)", () => {
  test("h(\"2026-09-05\",\"item_a+item_b\") % 16n reproduces Python's int(hexdigest,16) % 16", () => {
    // python3 -c 'import hashlib; print(int(hashlib.sha256(b"2026-09-05|item_a+item_b").hexdigest(),16) % 16)'
    // → 11   (hexdigest a62f61fad4221a3844070a2613149c696d944f89bc681deb75c3acce023734ab)
    const v = R.h("2026-09-05", "item_a+item_b");
    assert.equal(typeof v, "bigint");
    assert.equal(v, BigInt("0xa62f61fad4221a3844070a2613149c696d944f89bc681deb75c3acce023734ab"));
    assert.equal(v % 16n, 11n);
    assert.equal(R.hmod("2026-09-05", 16, "item_a+item_b"), 11);
  });
  test("multi-part keys join with | exactly as the original (staple / aged)", () => {
    // python3: int(sha256(b"2026-08-05|staple|item_x+item_y").hexdigest(),16) % 1000 → 369
    assert.equal(R.hmod("2026-08-05", 1000, "staple", "item_x+item_y"), 369);
    // python3: int(sha256(b"2026-08-05|aged|item_q").hexdigest(),16) % 97 → 26
    assert.equal(R.hmod("2026-08-05", 97, "aged", "item_q"), 26);
  });
  test("hmod returns a Number and differs per seed (the date-seeded jitter)", () => {
    const a = R.hmod("2026-09-05", 16, "item_a+item_b");
    const b = R.hmod("2026-09-06", 16, "item_a+item_b");
    assert.equal(typeof a, "number");
    assert.ok(a >= 0 && a < 16);
    assert.ok(a !== b || R.hmod("2026-09-07", 16, "item_a+item_b") !== a);
  });
});

describe("dayKey() / yesterdayOf() — the family's calendar day (spec §3.2, I6)", () => {
  test("dayKey flips at the zone's midnight, not UTC's", () => {
    assert.equal(R.dayKey(Date.UTC(2026, 8, 5, 6, 30), "America/Los_Angeles"), "2026-09-04");
    assert.equal(R.dayKey(Date.UTC(2026, 8, 5, 7, 30), "America/Los_Angeles"), "2026-09-05");
    assert.equal(R.dayKey(new Date(Date.UTC(2026, 8, 5, 7, 30)), "UTC"), "2026-09-05");
  });
  test("yesterdayOf is calendar arithmetic (spring-forward day, month edge, year edge)", () => {
    assert.equal(R.yesterdayOf("2026-03-09"), "2026-03-08");
    assert.equal(R.yesterdayOf("2026-03-01"), "2026-02-28");
    assert.equal(R.yesterdayOf("2026-01-01"), "2025-12-31");
    assert.equal(R.yesterdayOf("2028-03-01"), "2028-02-29");
  });
});

// ---- T1.2 attributes(), isNeutral(), harmonizes(), styleScore() -----------

// Invented garments. `g(id, over)` = a plain basic; every field explicit so a
// case reads like the original's Garment defaults (outfit_set.py:76-91).
const g = (id, over = {}) => ({
  id, category: "top", warmth: "any", colors: [], pattern: "", statement: false,
  palette: "", vibe: "", ...over,
});
const pairing = (great = [], avoid = []) => R.normalizePairing({ great, avoid });

describe("attributes() whitelist (spec §3.1 item 2, I14)", () => {
  test("colours: array or string split on , / & and; lowercased; light blue survives; cap 3", () => {
    assert.deepEqual(R.attributes({ colors: "pink and white, Light Blue" }).colors, ["pink", "white", "light blue"]);
    assert.deepEqual(R.attributes({ colors: ["Navy", " white "] }).colors, ["navy", "white"]);
    assert.deepEqual(R.attributes({ colors: "red/green & blue and yellow" }).colors, ["red", "green", "blue"]);
    assert.deepEqual(R.attributes({}).colors, []);
    assert.deepEqual(R.attributes({ colors: 42 }).colors, []);
  });
  test("statement is boolean true only; the string \"true\" is false", () => {
    assert.equal(R.attributes({ statement: "true" }).statement, false);
    assert.equal(R.attributes({ statement: true }).statement, true);
    assert.equal(R.attributes({}).statement, false);
  });
  test("pattern / palette / vibe are enum-checked; unknowns absent", () => {
    const a = R.attributes({ pattern: "Floral", palette: "warm", vibe: "sporty" });
    assert.equal(a.pattern, "floral");
    assert.equal(a.palette, "warm");
    assert.equal(a.vibe, "sporty");
    const b = R.attributes({ pattern: "plaid", palette: "loud", vibe: "grumpy" });
    assert.ok(!("pattern" in b));
    assert.ok(!("palette" in b));
    assert.ok(!("vibe" in b));
    for (const p of ["solid", "denim", "stripes", "floral", "graphic", "print"])
      assert.equal(R.attributes({ pattern: p }).pattern, p);
    for (const p of ["warm", "cool", "neutral", "pastel"])
      assert.equal(R.attributes({ palette: p }).palette, p);
    for (const v of ["sweet", "sporty", "graphic", "basic"])
      assert.equal(R.attributes({ vibe: v }).vibe, v);
  });
  test("nothing but the five attribute keys comes out", () => {
    const a = R.attributes({ name: "Sunny tee", category: "top", colors: ["yellow"], hash: "x" });
    assert.deepEqual(Object.keys(a).sort(), ["colors", "statement"]);
  });
});

describe("isNeutral / harmonizes — parity (outfit_set.py:242-252)", () => {
  test("solid or denim pattern, or any colour exactly in NEUTRALS, is neutral", () => {
    assert.equal(R.isNeutral(g("a", { pattern: "solid", colors: ["pink"] })), true);
    assert.equal(R.isNeutral(g("a", { pattern: "denim", colors: ["pink"] })), true);
    assert.equal(R.isNeutral(g("a", { pattern: "floral", colors: ["pink", "navy"] })), true);
    assert.equal(R.isNeutral(g("a", { pattern: "floral", colors: ["light blue"] })), true);
    assert.equal(R.isNeutral(g("a", { pattern: "floral", colors: ["pink"] })), false);
    assert.equal(R.isNeutral(g("a", { pattern: "floral", colors: ["blueish"] })), false);
  });
  test("two statement pieces never harmonize", () => {
    const t = g("t", { statement: true, colors: ["white"], pattern: "solid" });
    const b = g("b", { statement: true, colors: ["black"], pattern: "solid" });
    assert.equal(R.harmonizes(t, b), false);
  });
  test("a statement piece needs a neutral partner", () => {
    const loud = g("t", { statement: true, colors: ["pink"], pattern: "floral" });
    assert.equal(R.harmonizes(loud, g("b", { colors: ["orange"], pattern: "stripes" })), false);
    assert.equal(R.harmonizes(loud, g("b", { colors: ["navy"], pattern: "stripes" })), true);
    assert.equal(R.harmonizes(g("b", { colors: ["orange"], pattern: "stripes" }), loud), false);
    assert.equal(R.harmonizes(g("b", { pattern: "denim", colors: ["orange"] }), loud), true);
  });
  test("two basics always harmonize, neutral or not", () => {
    assert.equal(R.harmonizes(g("t", { colors: ["orange"], pattern: "stripes" }), g("b", { colors: ["purple"], pattern: "floral" })), true);
  });
});

describe("styleScore — parity (outfit_set.py:263-285)", () => {
  const basic = (id, over = {}) => g(id, { colors: ["red"], pattern: "stripes", ...over });
  test("two basics, nothing else: 50 + 5 = 55", () => {
    assert.equal(R.styleScore(basic("t"), basic("b"), pairing()), 55);
  });
  test("statement over a basic: 50 + 15 = 65", () => {
    assert.equal(R.styleScore(basic("t", { statement: true }), basic("b"), pairing()), 65);
  });
  test("curated great over two basics: 50 + 30 + 5 = 85", () => {
    assert.equal(R.styleScore(basic("t"), basic("b"), pairing([["b", "t"]])), 85);
  });
  test("curated avoid is −1000 immediately, even when also great", () => {
    assert.equal(R.styleScore(basic("t"), basic("b"), pairing([["t", "b"]], [["b", "t"]])), -1000);
  });
  test("pairing keys are unordered: [b,t] hits the pair (t,b)", () => {
    const p = pairing([["b", "t"]]);
    assert.ok(p.great.has(R.pairKey("t", "b")));
    assert.equal(R.styleScore(basic("t"), basic("b"), p), 85);
  });
  test("palette: neutral-or-same +10 → 65; warm vs cool −10 → 45; one side unset → 55", () => {
    assert.equal(R.styleScore(basic("t", { palette: "warm" }), basic("b", { palette: "warm" }), pairing()), 65);
    assert.equal(R.styleScore(basic("t", { palette: "neutral" }), basic("b", { palette: "cool" }), pairing()), 65);
    assert.equal(R.styleScore(basic("t", { palette: "warm" }), basic("b", { palette: "cool" }), pairing()), 45);
    assert.equal(R.styleScore(basic("t", { palette: "pastel" }), basic("b", { palette: "cool" }), pairing()), 55);
    assert.equal(R.styleScore(basic("t", { palette: "warm" }), basic("b"), pairing()), 55);
  });
  test("same non-empty vibe +5 → 60; different or empty vibes add nothing", () => {
    assert.equal(R.styleScore(basic("t", { vibe: "sporty" }), basic("b", { vibe: "sporty" }), pairing()), 60);
    assert.equal(R.styleScore(basic("t", { vibe: "sporty" }), basic("b", { vibe: "sweet" }), pairing()), 55);
    assert.equal(R.styleScore(basic("t"), basic("b"), pairing()), 55);
  });
  test("missing pairing argument means no curated pairs", () => {
    assert.equal(R.styleScore(basic("t"), basic("b")), 55);
  });
});

describe("hub deviation (I5, spec §3.1 item 4): missing attributes degrade, never exclude", () => {
  test("no colours, no pattern, statement false → neutral (the original says false)", () => {
    assert.equal(R.isNeutral(g("a")), true);
    assert.equal(R.isNeutral({ id: "a" }), true);   // fields absent entirely
  });
  test("no colours, no pattern but statement true → not neutral", () => {
    assert.equal(R.isNeutral(g("a", { statement: true })), false);
  });
  test("a garment with no attributes at all pairs with a statement piece", () => {
    const loud = g("t", { statement: true, colors: ["pink"], pattern: "floral" });
    assert.equal(R.harmonizes(loud, { id: "b" }), true);
    assert.equal(R.harmonizes({ id: "b" }, loud), true);
  });
  test("a wardrobe with no attributes scores every pair as two basics: 55", () => {
    assert.equal(R.styleScore({ id: "t" }, { id: "b" }), 55);
  });
});
