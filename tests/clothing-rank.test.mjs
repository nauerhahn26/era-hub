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
