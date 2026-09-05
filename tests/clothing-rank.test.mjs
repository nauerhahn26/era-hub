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

// ---- T1.3 derivePicks(), recordOffer(), lastPage1(), yesterdayPage1() ------

// A combo the way buildCandidates returns it: {key, pieces}.
const combo = (...ids) => ({ key: ids.join("+"), pieces: ids.map(id => ({ id })) });
// N calendar days after a day key.
const plus = (key, n) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

describe("derivePicks — parity with variety_test.py:135-189 (outfit_set.py:320-357)", () => {
  const x = ["item_x1", "item_x2"], y = ["item_y1", "item_y2"];
  const events = {
    // two Yes days for X (a confirmed favourite, weight 2.0)...
    "2026-08-01": [{ kind: "select", combo: x }, { kind: "yes", combo: x }],
    // ...a day she said Yes to X three times AND Yes to Y (repeat Yes = ONE
    // credit for that day; Yes on two outfits = both credited)
    "2026-08-02": [
      { kind: "yes", combo: x }, { kind: "yes", combo: x }, { kind: "yes", combo: x },
      { kind: "yes", combo: y },
    ],
    // ...one no-Yes day: last select = Y, inferred at half weight
    "2026-08-03": [{ kind: "select", combo: x }, { kind: "select", combo: y }],
    // today's own events must NOT count (same-date rerun stability)
    "2026-08-05": [{ kind: "yes", combo: y }],
  };
  test("repeat Yes collapses: 2 Yes days -> 2.0, not 4.0", () => {
    assert.equal(R.derivePicks(events, "2026-08-05")[x.join("+")], 2.0);
  });
  test("second Yes outfit that day counts too, no-Yes day infers at 0.5: 1.5", () => {
    assert.equal(R.derivePicks(events, "2026-08-05")[y.join("+")], 1.5);
  });
  test("today's own events are excluded from scoring", () => {
    assert.equal(Object.keys(R.derivePicks(events, "2026-08-05")).length, 2);
    assert.equal(Object.keys(R.derivePicks(events, "2026-08-06")).length, 2);
    assert.equal(R.derivePicks(events, "2026-08-06")[y.join("+")], 2.5);
  });
  test("combo key keeps the ids in the order given (never re-sorted)", () => {
    const p = R.derivePicks({ "2026-08-01": [{ kind: "yes", combo: ["item_b", "item_a"] }] }, "2026-08-05");
    assert.deepEqual(p, { "item_b+item_a": 1.0 });
  });
  test("garbage keys, non-list days, empty combos and a missing map are skipped", () => {
    assert.deepEqual(R.derivePicks({ garbage: [{ kind: "yes", combo: ["a"] }], "2026-09-01": "x" }, "2026-09-05"), {});
    assert.deepEqual(R.derivePicks({ "2026-09-01": [{ kind: "yes", combo: [] }, null, { kind: "yes" }, "yes"] }, "2026-09-05"), {});
    assert.deepEqual(R.derivePicks(undefined, "2026-09-05"), {});
    assert.deepEqual(R.derivePicks({ "2026-09-1": [{ kind: "yes", combo: ["a"] }] }, "2026-09-05"), {});
  });
  test("a select-only day credits only the LAST select", () => {
    const p = R.derivePicks({ "2026-09-01": [{ kind: "select", combo: ["a"] }, { kind: "select", combo: ["b"] }, { kind: "select", combo: ["a"] }] }, "2026-09-05");
    assert.deepEqual(p, { a: 0.5 });
  });
});

describe("recordOffer — parity (outfit_set.py:364-373) + the events prune (spec §3.2, I7)", () => {
  test("writes days[date] = {band, page1: first perPage combos as id lists} and returns the history", () => {
    const combos = [combo("a", "b"), combo("c"), combo("d", "e"), combo("f", "g")];
    const hist = { days: {}, events: {} };
    const out = R.recordOffer(hist, "2026-09-05", combos, 3, "warm");
    assert.equal(out, hist);
    assert.deepEqual(hist.days["2026-09-05"], { band: "warm", page1: [["a", "b"], ["c"], ["d", "e"]] });
  });
  test("a bare {} history works: days and events are created", () => {
    const hist = R.recordOffer({}, "2026-09-05", [combo("a", "b")], 7, null);
    assert.deepEqual(hist, { days: { "2026-09-05": { band: null, page1: [["a", "b"]] } }, events: {} });
  });
  test("same-date reruns overwrite: idempotent", () => {
    const hist = R.recordOffer({}, "2026-09-05", [combo("a", "b")], 7, "warm");
    R.recordOffer(hist, "2026-09-05", [combo("c", "d")], 7, "hot");
    assert.deepEqual(hist.days["2026-09-05"], { band: "hot", page1: [["c", "d"]] });
  });
  test("61 days keeps the 60 latest and drops events older than the oldest kept day", () => {
    const hist = { days: {}, events: {} };
    const d0 = "2026-07-01";
    for (let i = 0; i < 61; i++) {
      const d = plus(d0, i);
      hist.events[d] = [{ kind: "yes", combo: ["a", "b"] }];
      R.recordOffer(hist, d, [combo("a", "b")], 7, "warm");
    }
    const kept = Object.keys(hist.days).sort();
    assert.equal(kept.length, 60);
    assert.equal(kept[0], plus(d0, 1));
    assert.equal(kept[59], plus(d0, 60));
    assert.ok(!(d0 in hist.days));
    assert.ok(!(d0 in hist.events), "the event before the oldest kept day is gone");
    assert.equal(Object.keys(hist.events).length, 60);
    assert.ok(plus(d0, 1) in hist.events);
  });
  test("a young days map (fewer than 60) never prunes recent events; garbage event keys are left alone", () => {
    const hist = { days: {}, events: { "2026-08-01": [{ kind: "yes", combo: ["a"] }], "2026-09-01": [{ kind: "yes", combo: ["a"] }], garbage: [] } };
    R.recordOffer(hist, "2026-09-05", [combo("a", "b")], 7, "warm");
    assert.deepEqual(Object.keys(hist.events).sort(), ["2026-08-01", "2026-09-01", "garbage"]);
  });
  test("with no days, events keep their 60 most recent dates", () => {
    const hist = { days: {}, events: {} };
    for (let i = 0; i < 70; i++) hist.events[plus("2026-05-01", i)] = [{ kind: "yes", combo: ["a"] }];
    R.pruneEvents(hist);
    const keys = Object.keys(hist.events).sort();
    assert.equal(keys.length, 60);
    assert.equal(keys[0], plus("2026-05-01", 10));
  });
});

describe("lastPage1 / yesterdayPage1 — the page-1 memory (outfit_set.py:415-428)", () => {
  const hist = {
    days: {
      "2026-09-01": { band: "warm", page1: [["a", "b"], ["c"]] },
      "2026-09-03": { band: "warm", page1: [["a", "d"]] },
      "2026-09-04": { band: "hot", page1: [["e", "f"], ["g"]] },
      "2026-09-05": { band: "hot", page1: [["z", "y"]] },   // today: ignored
    },
  };
  test("lastPage1 gives each garment its latest page-1 day strictly before `before`", () => {
    assert.deepEqual(R.lastPage1(hist, "2026-09-05"), { a: "2026-09-03", b: "2026-09-01", c: "2026-09-01", d: "2026-09-03", e: "2026-09-04", f: "2026-09-04", g: "2026-09-04" });
    assert.deepEqual(R.lastPage1({}, "2026-09-05"), {});
    assert.deepEqual(R.lastPage1({ days: { "2026-09-04": {} } }, "2026-09-05"), {});
  });
  test("yesterdayPage1 is the Set of yesterday's combo keys (ids joined +)", () => {
    assert.deepEqual([...R.yesterdayPage1(hist, "2026-09-05")].sort(), ["e+f", "g"]);
    assert.deepEqual([...R.yesterdayPage1(hist, "2026-09-03")], []);
    assert.deepEqual([...R.yesterdayPage1({}, "2026-09-03")], []);
  });
  test("daysBetween is calendar days between two day keys", () => {
    assert.equal(R.daysBetween("2026-09-01", "2026-09-05"), 4);
    assert.equal(R.daysBetween("2026-03-07", "2026-03-09"), 2);   // across spring-forward
    assert.equal(R.daysBetween("2025-12-31", "2026-01-01"), 1);
  });
});

// ---- T1.4 eligible(), buildCandidates(), toWorkerShape() -------------------

const SEED = "2026-09-05";
const top = (id, over = {}) => g(id, { category: "top", colors: ["red"], pattern: "stripes", ...over });
const bottom = (id, over = {}) => g(id, { category: "pants", colors: ["navy"], pattern: "solid", ...over });
const keysOf = list => list.map(c => c.key);
const idsIn = list => new Set(list.flatMap(c => c.pieces.map(p => p.id)));

describe("eligible — the band gate (spec §3.4, W3): tops never, bottoms/singles by level with widening", () => {
  const cold = bottom("item_cold", { warmth: "cold" });
  test("hot band, 3 hot + 1 cold bottoms: the cold bottom is absent", () => {
    const items = [bottom("item_h1", { warmth: "hot" }), bottom("item_h2", { warmth: "hot" }), bottom("item_h3", { warmth: "hot" }), cold];
    assert.deepEqual(R.eligible(items, "bottom", "hot").map(i => i.id), ["item_h1", "item_h2", "item_h3"]);
  });
  test("hot band, 1 hot + 2 warm bottoms: all three are EXACT matches (warm = level 1 too, spec §3.4); a cold one absent", () => {
    // Not the widen rule: hot and warm both map to level 1, so the exact
    // gate admits the warm bottoms on its own (review r1).
    const items = [bottom("item_h1", { warmth: "hot" }), bottom("item_w1", { warmth: "warm" }), bottom("item_w2", { warmth: "warm" }), cold];
    assert.deepEqual(R.eligible(items, "bottom", "hot").map(i => i.id), ["item_h1", "item_w1", "item_w2"]);
  });
  test("widen to the neighbour band (spec §3.4, W3): hot band, 1 hot + 2 cool + 1 cold bottoms → the cool ones join, the cold one stays out", () => {
    // exact = [h1] (< 2) → hot{1} ∪ neighbour warm{1,2} = {1,2}: the cool
    // (level 2) bottoms join; cold (level 3) is still out. A port that skips
    // the union step and falls straight through to all-of-category deals
    // the cold one too.
    const items = [bottom("item_h1", { warmth: "hot" }), bottom("item_o1", { warmth: "cool" }), bottom("item_o2", { warmth: "cool" }), bottom("item_c1", { warmth: "cold" })];
    assert.deepEqual(R.eligible(items, "bottom", "hot").map(i => i.id), ["item_h1", "item_o1", "item_o2"]);
    // and from the other end: cold band, 1 cold + 1 cool + 2 warm →
    // cold{3} ∪ neighbour cool{2,3} = {2,3}: the cool bottom joins; the warm
    // ones (level 1) stay out.
    const items2 = [bottom("item_c1", { warmth: "cold" }), bottom("item_o1", { warmth: "cool" }), bottom("item_w1", { warmth: "warm" }), bottom("item_w2", { warmth: "warm" })];
    assert.deepEqual(R.eligible(items2, "bottom", "cold").map(i => i.id), ["item_c1", "item_o1"]);
  });
  test("widen applies to singles the same way: hot band, 1 hot + 1 cool dress → both dealt, a cold one not", () => {
    const items = [g("item_d1", { category: "dress", warmth: "hot" }), g("item_d2", { category: "dress", warmth: "cool" }), g("item_d3", { category: "dress", warmth: "cold" })];
    assert.deepEqual(R.eligible(items, "single", "hot").map(i => i.id), ["item_d1", "item_d2"]);
  });
  test("a warmth 'any' bottom is eligible in all four bands", () => {
    const items = [bottom("item_any", { warmth: "any" }), bottom("item_h1", { warmth: "hot" }), bottom("item_h2", { warmth: "hot" }), bottom("item_c1", { warmth: "cold" }), bottom("item_c2", { warmth: "cold" })];
    for (const b of ["hot", "warm", "cool", "cold"])
      assert.ok(R.eligible(items, "bottom", b).some(i => i.id === "item_any"), b);
  });
  test("an int warmth 3 behaves as cold (migrated tag)", () => {
    const items = [bottom("item_h1", { warmth: "hot" }), bottom("item_h2", { warmth: "hot" }), bottom("item_h3", { warmth: "hot" }), bottom("item_i3", { warmth: 3 })];
    assert.ok(!R.eligible(items, "bottom", "hot").some(i => i.id === "item_i3"));
    assert.ok(R.eligible(items, "bottom", "cold").some(i => i.id === "item_i3"));
  });
  test("hot band with only two cold bottoms: widen → all, both eligible", () => {
    const items = [bottom("item_c1", { warmth: "cold" }), bottom("item_c2", { warmth: "cold" })];
    assert.deepEqual(R.eligible(items, "bottom", "hot").map(i => i.id), ["item_c1", "item_c2"]);
  });
  test("band null (weather offline) gates nothing", () => {
    const items = [bottom("item_c1", { warmth: "cold" }), bottom("item_h1", { warmth: "hot" }), bottom("item_h2", { warmth: "hot" }), bottom("item_h3", { warmth: "hot" })];
    assert.equal(R.eligible(items, "bottom", null).length, 4);
    assert.equal(R.eligible(items, "bottom", undefined).length, 4);
  });
  test("tops are never gated: eligible('top', 'cold') returns every top incl. warmth hot", () => {
    const items = [top("item_t1", { warmth: "hot" }), top("item_t2", { warmth: "hot" }), top("item_t3", { warmth: "cold" }), bottom("item_b1", { warmth: "cold" })];
    assert.deepEqual(R.eligible(items, "top", "cold").map(i => i.id), ["item_t1", "item_t2", "item_t3"]);
    assert.deepEqual(R.eligible(items, "top", "hot").map(i => i.id), ["item_t1", "item_t2", "item_t3"]);
  });
  test("categories: pants|shorts → bottom, dress|set → single, top → top", () => {
    const items = [top("item_t1"), bottom("item_p1"), bottom("item_s1", { category: "shorts" }), g("item_d1", { category: "dress" }), g("item_e1", { category: "set" })];
    assert.deepEqual(R.eligible(items, "bottom", null).map(i => i.id), ["item_p1", "item_s1"]);
    assert.deepEqual(R.eligible(items, "single", null).map(i => i.id), ["item_d1", "item_e1"]);
    assert.deepEqual(R.eligible(items, "top", null).map(i => i.id), ["item_t1"]);
  });
  test("shorts count as bottoms for the widen rule (bottoms counted as one category)", () => {
    const items = [bottom("item_p1", { warmth: "hot" }), bottom("item_s1", { category: "shorts", warmth: "hot" }), bottom("item_c1", { warmth: "cold" })];
    assert.deepEqual(R.eligible(items, "bottom", "hot").map(i => i.id), ["item_p1", "item_s1"]);
  });
});

describe("rankOf — style + fav + fresh + loved + jitter (outfit_set.py:434-451)", () => {
  const ctx = over => ({ seed: SEED, pairing: pairing(), favorites: new Set(), picks: {}, lastP1: {}, ...over });
  const jit = key => R.hmod(SEED, R.JITTER_PTS, key);
  const t = top("item_t"), b = bottom("item_b");
  test("a never-seen garment: fresh 48 (9 days → capped at 8 × 6)", () => {
    assert.equal(R.rankOf([t, b], ctx()), 55 + 48 + jit("item_t+item_b"));
  });
  test("an 8-day-old garment: fresh 48; a 3-day-old one: 18 (min over the pieces)", () => {
    assert.equal(R.rankOf([t, b], ctx({ lastP1: { item_t: "2026-08-28", item_b: "2026-08-28" } })), 55 + 48 + jit("item_t+item_b"));
    assert.equal(R.rankOf([t, b], ctx({ lastP1: { item_t: "2026-09-02" } })), 55 + 18 + jit("item_t+item_b"));
    assert.equal(R.rankOf([t, b], ctx({ lastP1: { item_t: "2026-09-04", item_b: "2026-08-01" } })), 55 + 6 + jit("item_t+item_b"));
  });
  test("loved applies at 2.0 picks, not at 1.5", () => {
    assert.equal(R.rankOf([t, b], ctx({ picks: { "item_t+item_b": 1.5 } })), 55 + 48 + jit("item_t+item_b"));
    assert.equal(R.rankOf([t, b], ctx({ picks: { "item_t+item_b": 2.0 } })), 55 + 48 + 12 + jit("item_t+item_b"));
  });
  test("a favourite garment lifts the look by 10 (favorites Set, W2)", () => {
    assert.equal(R.rankOf([t, b], ctx({ favorites: new Set(["item_b"]) })), 55 + 10 + 48 + jit("item_t+item_b"));
  });
  test("a single scores SINGLE_STYLE 55 and never goes through styleScore", () => {
    const d = g("item_d", { category: "dress", statement: true, colors: ["pink"], pattern: "floral" });
    assert.equal(R.rankOf([d], ctx()), 55 + 48 + jit("item_d"));
  });
});

describe("buildCandidates — the pool (outfit_set.py:393-410)", () => {
  test("an avoid pair is absent from the pool; every other harmonizing pair is present", () => {
    const items = [top("item_t1"), top("item_t2"), bottom("item_b1"), bottom("item_b2")];
    const out = R.buildCandidates({ items, band: null, cap: 21, seed: SEED, pairing: { great: [], avoid: [["item_b2", "item_t1"]] }, history: {}, perPage: 7 });
    assert.deepEqual(keysOf(out).sort(), ["item_t1+item_b1", "item_t2+item_b1", "item_t2+item_b2"]);
  });
  test("two statement pieces never pool together; a statement single is in the pool anyway (singles bypass harmonizes)", () => {
    const loud = { statement: true, colors: ["pink"], pattern: "floral" };
    const items = [top("item_t1", loud), bottom("item_b1", { ...loud, colors: ["orange"] }), g("item_d1", { category: "dress", ...loud })];
    const out = R.buildCandidates({ items, band: null, cap: 21, seed: SEED, history: {}, perPage: 7 });
    assert.deepEqual(keysOf(out), ["item_d1"]);
  });
  test("every combo is {key, pieces:[garment…]} with the ids joined by +; toWorkerShape maps it", () => {
    const items = [top("item_t1"), bottom("item_b1"), g("item_d1", { category: "dress" })];
    const out = R.buildCandidates({ items, band: null, cap: 21, seed: SEED, history: {}, perPage: 7 });
    for (const c of out) assert.equal(c.key, c.pieces.map(p => p.id).join("+"));
    const pair = out.find(c => c.pieces.length === 2), one = out.find(c => c.pieces.length === 1);
    assert.deepEqual(R.toWorkerShape(pair), { key: "item_t1+item_b1", top: pair.pieces[0], bottom: pair.pieces[1] });
    assert.deepEqual(R.toWorkerShape(one), { key: "item_d1", one: one.pieces[0] });
  });
  test("a curated favourite garment reaches the rank through buildCandidates (+10, spec §4 / W2): its look moves forward; the array form works too", () => {
    // Six tops × six bottoms, no history: every look is 55 + 48 + jitter,
    // so the +10 for a favourite garment decides the order. Take the LAST
    // look of a favourite-free build and mark one of its garments a
    // favourite: the key list changes and that look moves forward. A
    // buildCandidates that drops `favorites` on the floor deals the same
    // 21 both times.
    const items = [];
    for (let i = 1; i <= 6; i++) items.push(top("item_t" + i));
    for (let i = 1; i <= 6; i++) items.push(bottom("item_b" + i));
    const base = { items, band: null, cap: 21, seed: SEED, history: {}, perPage: 7 };
    const plain = R.buildCandidates(base);
    const last = plain[plain.length - 1];
    const fav = last.pieces[0].id;
    const withFav = R.buildCandidates({ ...base, favorites: new Set([fav]) });
    assert.notDeepEqual(keysOf(withFav), keysOf(plain), "the favourite changed the deal");
    assert.ok(keysOf(withFav).indexOf(last.key) < plain.length - 1, "the favourite's look moved forward");
    // the documented array-accepting form (clothing-rank.js: `new Set(opts.favorites || [])`)
    assert.deepEqual(keysOf(R.buildCandidates({ ...base, favorites: [fav] })), keysOf(withFav));
  });
  test("cap bounds the list; the list is at most the pool", () => {
    const items = [top("item_t1"), top("item_t2"), top("item_t3"), bottom("item_b1"), bottom("item_b2"), bottom("item_b3")];
    assert.equal(R.buildCandidates({ items, band: null, cap: 4, seed: SEED, history: {}, perPage: 2 }).length, 4);
    assert.equal(R.buildCandidates({ items, band: null, cap: 21, seed: SEED, history: {}, perPage: 7 }).length, 9);
  });
});

describe("buildCandidates — gating end to end (spec §3.4)", () => {
  test("hot band: the cold bottom is absent from every combo of the 21 (3 hot + 1 cold)", () => {
    const items = [top("item_t1"), top("item_t2"), top("item_t3"), top("item_t4"), top("item_t5"), top("item_t6"),
      bottom("item_h1", { warmth: "hot" }), bottom("item_h2", { warmth: "hot" }), bottom("item_h3", { warmth: "hot" }), bottom("item_cold", { warmth: "cold" })];
    const out = R.buildCandidates({ items, band: "hot", cap: 21, seed: SEED, history: {}, perPage: 7 });
    assert.equal(out.length, 18);   // 6 tops × 3 hot bottoms — the cold bottom's 6 looks are gone
    assert.ok(!idsIn(out).has("item_cold"));
  });
  test("hot band: 1 hot + 2 warm bottoms are all dealt (exact gate — warm is level 1 too); a cold one is not", () => {
    const items = [top("item_t1"), top("item_t2"),
      bottom("item_h1", { warmth: "hot" }), bottom("item_w1", { warmth: "warm" }), bottom("item_w2", { warmth: "warm" }), bottom("item_cold", { warmth: "cold" })];
    const out = R.buildCandidates({ items, band: "hot", cap: 21, seed: SEED, history: {}, perPage: 7 });
    const ids = idsIn(out);
    assert.ok(ids.has("item_w1") && ids.has("item_w2") && ids.has("item_h1"));
    assert.ok(!ids.has("item_cold"));
  });
  test("hot band: 1 hot + 2 cool bottoms → the cool ones are dealt (widen to the neighbour band, W3); the cold one is in no combo", () => {
    const items = [top("item_t1"), top("item_t2"),
      bottom("item_h1", { warmth: "hot" }), bottom("item_o1", { warmth: "cool" }), bottom("item_o2", { warmth: "cool" }), bottom("item_cold", { warmth: "cold" })];
    const out = R.buildCandidates({ items, band: "hot", cap: 21, seed: SEED, history: {}, perPage: 7 });
    assert.equal(out.length, 6, "2 tops × 3 admitted bottoms");
    const ids = idsIn(out);
    assert.ok(ids.has("item_o1") && ids.has("item_o2") && ids.has("item_h1"));
    assert.ok(!ids.has("item_cold"));
  });
  test("a cold single is gated the same way; band null deals everything", () => {
    const items = [top("item_t1"), bottom("item_h1", { warmth: "hot" }), bottom("item_h2", { warmth: "hot" }),
      g("item_d1", { category: "dress", warmth: "hot" }), g("item_d2", { category: "dress", warmth: "hot" }), g("item_dc", { category: "dress", warmth: "cold" })];
    assert.ok(!idsIn(R.buildCandidates({ items, band: "hot", cap: 21, seed: SEED, history: {}, perPage: 7 })).has("item_dc"));
    assert.ok(idsIn(R.buildCandidates({ items, band: null, cap: 21, seed: SEED, history: {}, perPage: 7 })).has("item_dc"));
  });
});

describe("buildCandidates — staples, coverage, fill (outfit_set.py:455-536)", () => {
  test("the coverage slot tries only the single oldest garment: when its only look is blocked, the slot goes to the fill (I3)", () => {
    // T0+B is her staple (two Yes days). Q is the oldest garment (never on
    // page 1) and its only harmonizing look is with B — which the staple
    // already used. R is next-oldest (20 days) with a low-ranked look R+B2.
    // The original tries aged[0] only: page 1 = [T0+B, T3+B2]; a port that
    // fell back to aged[1] would seat R+B2 instead of T3+B2.
    const items = [
      top("item_t0"),
      top("item_q", { statement: true, colors: ["pink"], pattern: "floral" }),
      top("item_r", { palette: "warm" }),
      top("item_t3", { vibe: "sporty" }),
      bottom("item_b"),                                                   // neutral (solid)
      bottom("item_b2", { colors: ["orange"], pattern: "stripes", palette: "cool", vibe: "sporty" }),
    ];
    const history = {
      days: {
        "2026-08-16": { band: "warm", page1: [["item_r", "item_b"]] },
        "2026-09-02": { band: "warm", page1: [["item_t3", "item_b2"]] },
      },
      events: {
        "2026-09-01": [{ kind: "yes", combo: ["item_t0", "item_b"] }],
        "2026-09-03": [{ kind: "yes", combo: ["item_t0", "item_b"] }],
      },
    };
    const out = R.buildCandidates({ items, band: null, cap: 21, seed: SEED, pairing: { great: [["item_t3", "item_b2"]], avoid: [] }, history, perPage: 3 });
    assert.deepEqual(keysOf(out).slice(0, 2), ["item_t0+item_b", "item_t3+item_b2"]);
    assert.equal(out.length, 7, "the pool (7 looks) is all dealt across the pages");
    assert.ok(keysOf(out).includes("item_q+item_b"), "Q's look is still offered on a deeper page");
  });
  test("staples: the most-picked combos take the first slots, garment-distinct, skipped when on yesterday's page 1", () => {
    const items = [top("item_t1"), top("item_t2"), top("item_t3"), bottom("item_b1"), bottom("item_b2"), bottom("item_b3")];
    const yes = combo => ({ kind: "yes", combo });
    const history = {
      days: { "2026-09-04": { band: "warm", page1: [["item_t2", "item_b2"]] } },
      events: {
        "2026-09-01": [yes(["item_t1", "item_b1"]), yes(["item_t2", "item_b2"]), yes(["item_t3", "item_b3"])],
        "2026-09-02": [yes(["item_t1", "item_b1"]), yes(["item_t2", "item_b2"])],
        "2026-09-03": [yes(["item_t2", "item_b2"])],
      },
    };
    const out = R.buildCandidates({ items, band: null, cap: 21, seed: SEED, history, perPage: 7 });
    // Three bottoms, page 1 garment-distinct, t2's looks all blocked (b1/b3
    // used, t2+b2 barred) → page 1 is exactly the two staples; page 2 opens
    // with yesterday's most-picked look.
    const p1 = keysOf(out).slice(0, 2);
    assert.ok(p1.includes("item_t1+item_b1"), "picked twice → staple");
    assert.ok(p1.includes("item_t3+item_b3"), "picked once → staple");
    assert.ok(!p1.includes("item_t2+item_b2"), "most-picked but on yesterday's page 1 → not on page 1");
    assert.equal(keysOf(out)[2], "item_t2+item_b2", "…it leads page 2 instead");
  });
  test("the staple pool is garment-distinct BEFORE the date rotation (outfit_set.py:483-489): a lesser-picked look sharing a garment never displaces the favourite", () => {
    // t1+b1 picked 3×, t1+b2 2×, t2+b3 1×. The pool keeps t1+b1 and t2+b3
    // (t1 already used), THEN rotates by hash. The hash puts t1+b2 ahead of
    // t1+b1 — so a port that rotated first and de-duplicated later would seat
    // t1+b2 instead of her favourite.
    assert.ok(R.h(SEED, "staple", "item_t1+item_b2") < R.h(SEED, "staple", "item_t1+item_b1"), "precondition: hash order");
    const items = [top("item_t1"), top("item_t2"), top("item_t3"), bottom("item_b1"), bottom("item_b2"), bottom("item_b3")];
    const yes = combo => ({ kind: "yes", combo });
    const events = {
      "2026-09-01": [yes(["item_t1", "item_b1"]), yes(["item_t1", "item_b2"]), yes(["item_t2", "item_b3"])],
      "2026-09-02": [yes(["item_t1", "item_b1"]), yes(["item_t1", "item_b2"])],
      "2026-09-03": [yes(["item_t1", "item_b1"])],
    };
    const out = R.buildCandidates({ items, band: null, cap: 21, seed: SEED, history: { days: {}, events }, perPage: 7 });
    assert.deepEqual(new Set(keysOf(out).slice(0, 2)), new Set(["item_t1+item_b1", "item_t2+item_b3"]));
  });
  test("the staple pool is ordered by pick weight BEFORE the garment-distinct top-5 (outfit_set.py:460): a heavier look later in pool order beats a lighter one sharing its garment", () => {
    // Pool (id order) puts t1+b1 before t2+b1. Weights: t2+b1 3.0 (three
    // Yes days), t1+b1 1.0. The weight sort seats t2+b1 first and the
    // garment-distinct pass drops t1+b1 (b1 taken). Without the sort the
    // greedy pass walks pool order, seats t1+b1 and drops her favourite.
    const items = [top("item_t1"), top("item_t2"), bottom("item_b1"), bottom("item_b2")];
    const yes = combo => ({ kind: "yes", combo });
    const events = {
      "2026-09-01": [yes(["item_t2", "item_b1"]), yes(["item_t1", "item_b1"])],
      "2026-09-02": [yes(["item_t2", "item_b1"])],
      "2026-09-03": [yes(["item_t2", "item_b1"])],
    };
    const picks = R.derivePicks(events, SEED);
    assert.equal(picks["item_t2+item_b1"], 3.0);
    assert.equal(picks["item_t1+item_b1"], 1.0);
    const out = R.buildCandidates({ items, band: null, cap: 21, seed: SEED, history: { days: {}, events }, perPage: 7 });
    assert.equal(out[0].key, "item_t2+item_b1", "her most-picked look is the staple");
  });
  test("the curated-great fallback pool is ordered by style BEFORE the garment-distinct top-5 (outfit_set.py:464-467)", () => {
    // No picks → staples come from `great`. Both great looks share b1; the
    // higher-style one (t2+b1: same vibe, 50+30+5+5 = 90) sits AFTER the
    // lower one (t1+b1: 85) in pool order. The style sort seats t2+b1; a
    // port that skipped it would seat t1+b1 and drop t2+b1 (b1 taken).
    const items = [top("item_t1"), top("item_t2", { vibe: "sporty" }), bottom("item_b1", { vibe: "sporty" }), bottom("item_b2")];
    const pairing = { great: [["item_t1", "item_b1"], ["item_t2", "item_b1"]], avoid: [] };
    assert.equal(R.styleScore(items[0], items[2], R.normalizePairing(pairing)), 85);
    assert.equal(R.styleScore(items[1], items[2], R.normalizePairing(pairing)), 90);
    const out = R.buildCandidates({ items, band: null, cap: 21, seed: SEED, pairing, history: {}, perPage: 7 });
    assert.equal(out[0].key, "item_t2+item_b1", "the best-styled great look is the staple");
  });
  test("yesterday's page-1 looks are barred from page 1 and lead page 2 in ranked order; deep pages are garment-once", () => {
    const items = [];
    for (let i = 1; i <= 5; i++) items.push(top("item_t" + i));
    for (let i = 1; i <= 5; i++) items.push(bottom("item_b" + i));
    const y = R.yesterdayOf(SEED);
    const first = R.buildCandidates({ items, band: null, cap: 21, seed: y, history: {}, perPage: 5 });
    const history = R.recordOffer({}, y, first, 5, null);
    const yKeys = new Set(keysOf(first).slice(0, 5));
    const out = R.buildCandidates({ items, band: null, cap: 21, seed: SEED, history, perPage: 5 });
    const keys = keysOf(out);
    assert.equal(keys.length, 21);
    assert.ok(keys.slice(0, 5).every(k => !yKeys.has(k)), "nothing from yesterday's page 1 on page 1");
    assert.deepEqual(new Set(keys.slice(5, 10)), yKeys, "page 2 IS yesterday's page 1");
    // Parity note (outfit_set.py:538-556): a deep page runs SHORT when the
    // leftover pool cannot fill it garment-distinct (only `page_count >=
    // per_page` ends a page early), so with 25 looks the fourth page is 4
    // long and slice 15-20 straddles two pages. The first three pages of 5
    // are exact.
    for (const [a, b] of [[0, 5], [5, 10], [10, 15]]) {
      const ids = out.slice(a, b).flatMap(c => c.pieces.map(p => p.id));
      assert.equal(new Set(ids).size, ids.length, `page ${a / 5 + 1} is garment-distinct`);
    }
    assert.equal(new Set(keys).size, 21, "no look is dealt twice");
  });
  test("tiny pool: yesterday's looks come back rather than a short page 1", () => {
    const items = [top("item_t1"), bottom("item_b1")];
    const y = R.yesterdayOf(SEED);
    const history = { days: { [y]: { band: null, page1: [["item_t1", "item_b1"]] } } };
    assert.deepEqual(keysOf(R.buildCandidates({ items, band: null, cap: 21, seed: SEED, history, perPage: 7 })), ["item_t1+item_b1"]);
  });
});

describe("hub deviation (W1, A4-4): items are sorted by id before pooling", () => {
  test("a shuffled item list deals the identical key list", () => {
    const items = [];
    for (let i = 1; i <= 6; i++) items.push(top("item_t" + i, i % 2 ? { vibe: "sporty" } : {}));
    for (let i = 1; i <= 6; i++) items.push(bottom("item_b" + i, i % 3 ? { palette: "warm" } : {}));
    const a = R.buildCandidates({ items, band: null, cap: 21, seed: SEED, history: {}, perPage: 7 });
    const rev = [...items].reverse();
    const b = R.buildCandidates({ items: rev, band: null, cap: 21, seed: SEED, history: {}, perPage: 7 });
    const rot = items.slice(4).concat(items.slice(0, 4));
    const c = R.buildCandidates({ items: rot, band: null, cap: 21, seed: SEED, history: {}, perPage: 7 });
    assert.deepEqual(keysOf(a), keysOf(b));
    assert.deepEqual(keysOf(a), keysOf(c));
  });
});
