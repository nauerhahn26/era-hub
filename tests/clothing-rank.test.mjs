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
