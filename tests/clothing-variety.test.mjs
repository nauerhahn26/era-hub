// clothing-variety.test.mjs — the original's variety regression gate
// (aac-studio/packages/generator/tests/variety_test.py) ported onto the pure
// module, run on the synthetic wardrobe. No server, no port, no network, no
// key, no family data. (Port table: this suite claims none — plan §B.)
//
// 14 consecutive days × {warm, hot}, recordOffer between days, asserting
// variety_test.py:89-132 exactly, then the hub's own guarantees: same-day
// rebuild stability (spec §3.3), same board from any item order (§5 / W1),
// deep pages garment-once (§1 V3), and the labelled I5 deviation.
//
// DRIVEN BY TEMPERATURE since 9/29 (warmth coherence spec 2026-09-29 §2, §3):
// buildCandidates gates and ranks by the planning °F and ignores the band, so
// "band warm" and "band hot" are now a warm and a hot morning — 74 °F and
// 82 °F. Every intent below is the original's; only the knob moved. The
// synthetic wardrobe carries no coverage/weight/legs, so the deal reads the
// legacy fallback from each garment's warmth word (spec §2 D1).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { makeItems, makePairing, stripAttributes } from "./synthetic-wardrobe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const R = require(path.join(HUB, "clothing-rank.js"));

// variety_test.py:45-49
const DAYS = 14;
const PER_PAGE = 7;
const CAP = 21;
const COVERAGE_DAYS = 10;
const MIN_CARRYOVER = 0.8;
const BANDS = ["warm", "hot"];
// The morning each band's gate now runs on: the middle of the old warm band
// (66-77) and a hot afternoon above it. What each admits is spelled out from
// the fixture below, not read off the module.
const TEMP = { warm: 74, hot: 82 };

const plus = (key, n) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const DATES = Array.from({ length: DAYS }, (_, d) => plus("2026-08-05", d));   // variety_test.py:63
const keysOf = list => list.map(c => c.key);
const idsOf = list => list.flatMap(c => c.pieces.map(p => p.id));
const distinct = list => new Set(idsOf(list)).size === idsOf(list).length;

const ITEMS = makeItems({ n: 35, seed: 1 });
const PAIRING = makePairing(ITEMS);
// The two bands above are the ported gate's (variety_test.py:49). Every kind
// of morning the picker can meet — including null, weather offline — is what
// the floor tests below must sweep: a cool and a cold morning gate the
// bottoms down to a handful, which is exactly where a board can come up short
// (review r3). One temperature per old band: hot 82, warm 74, cool 60, cold 48.
const ALL_TEMPS = [82, 74, 60, 48, null];
// At 60 °F the fit gate leaves this wardrobe 11 tops, the 6 pants and no
// dress (16/6/4 at 82, all 35 at 74 and null); at 48 it admits nothing at all
// — no garment here is made for 48 — and the floor widens the cold-side edge
// until the page fills. Either way page 1 runs out of garment-distinct looks
// and finishes through the tiny-pool relaxation (outfit_set.py:527-533) — a
// repeat there is the port working, not a variety failure, so only the roomy
// mornings assert page-1 distinctness.
const TIGHT_TEMPS = new Set([60, 48]);

function build(items, temp, seed, history, pairing = PAIRING, perPage = PER_PAGE) {
  return R.buildCandidates({ items, temp, cap: CAP, seed, pairing, favorites: new Set(), history, perPage });
}

// variety_test.py:60-73 — 14 days, recording page 1 each day. Keeps a
// snapshot of the history each day saw so later tests can re-rank.
function simulate(band, items = ITEMS) {
  let history = { days: {}, events: {} };
  const lineups = [], seen = [];
  for (const date of DATES) {
    seen.push(structuredClone(history));
    const out = build(items, TEMP[band], date, history);
    lineups.push(out);
    history = R.recordOffer(history, date, out, PER_PAGE, band);
  }
  return { lineups, seen };
}

const SIM = Object.fromEntries(BANDS.map(b => [b, simulate(b)]));

describe("the synthetic wardrobe has the original's shape", () => {
  test("35 garments: 17 tops / 12 bottoms / 3 dresses / 3 sets, 9 statement, 28 level-1 + 7 level-2", () => {
    const by = c => ITEMS.filter(g => g.category === c).length;
    assert.equal(ITEMS.length, 35);
    assert.equal(by("top"), 17);
    assert.equal(by("pants") + by("shorts"), 12);
    assert.equal(by("dress"), 3);
    assert.equal(by("set"), 3);
    assert.equal(ITEMS.filter(g => g.statement).length, 9);
    assert.equal(ITEMS.filter(g => g.warmth === "cool").length, 7);
    assert.equal(ITEMS.filter(g => g.warmth === "hot" || g.warmth === "warm").length, 28);
    for (const g of ITEMS) {
      assert.match(g.id, /^item_[0-9a-f]{10}$/);
      assert.ok(g.name && g.colors.length && g.pattern && g.palette && g.vibe, g.id);
    }
    assert.equal(new Set(ITEMS.map(g => g.id)).size, 35);
    assert.equal(PAIRING.great.length, 14);
    assert.equal(PAIRING.avoid.length, 1);
  });
  test("every garment's attributes survive the hub's whitelist (spec §3.1 item 2): the wardrobe only wears what wardrobe.json can hold", () => {
    for (const g of ITEMS) {
      const { colors, pattern, statement, palette, vibe } = g;
      assert.deepEqual(R.attributes(g), { colors, pattern, statement, palette, vibe }, `${g.id} ${g.pattern}`);
    }
  });
  test("makeItems is deterministic per seed and differs across seeds", () => {
    assert.deepEqual(makeItems({ n: 35, seed: 1 }), ITEMS);
    assert.notDeepEqual(makeItems({ n: 35, seed: 2 }).map(g => g.id), ITEMS.map(g => g.id));
  });
});

for (const band of BANDS) {
  describe(`variety gate — band ${band}, ${TEMP[band]} °F (variety_test.py:89-132)`, () => {
    const { lineups } = SIM[band];
    const temp = TEMP[band];
    // The set to cover comes from the FIXTURE, not from the module under
    // test (review r2), read through spec 2026-09-29 §2 by hand: with no
    // coverage words a `cool` top or dress is a light long sleeve (58-77 °F)
    // and every pair of pants is long and light (58-77), shorts are 72 and up
    // and a hot/warm top is sleeveless or short. So at 74 everything is in —
    // 35, the old warm gate's number — and at 82 the long sleeves and every
    // pair of pants are out: 16 tops + 6 shorts + 4 singles = 26. (Tops ARE
    // gated now — dad 9/23, 9/29 — which is why hot is no longer 17 + 8 + 4.)
    const ADMITS = {
      warm: () => true,
      hot: g => g.category === "shorts" || (g.category !== "pants" && g.warmth !== "cool"),
    };
    const eligibleIds = new Set(ITEMS.filter(ADMITS[band]).map(g => g.id));

    test("deterministic for a fixed date + history (day 1, two calls deep-equal)", () => {
      const a = build(ITEMS, temp, DATES[0], { days: {}, events: {} });
      const b = build(ITEMS, temp, DATES[0], { days: {}, events: {} });
      assert.deepEqual(keysOf(a), keysOf(b));
      assert.deepEqual(keysOf(a), keysOf(lineups[0]));
    });
    test(`every eligible garment reaches page 1 within ${COVERAGE_DAYS} days`, () => {
      const onP1 = new Set();
      for (const day of lineups.slice(0, COVERAGE_DAYS)) for (const id of idsOf(day.slice(0, PER_PAGE))) onP1.add(id);
      const missing = [...eligibleIds].filter(id => !onP1.has(id)).sort();
      assert.deepEqual(missing, [], `${eligibleIds.size} eligible; missing ${missing.join(",")}`);
      assert.equal(eligibleIds.size, band === "hot" ? 26 : 35, "the fixture's per-morning count (16/17 tops + 6/12 bottoms + 4/6 singles)");
      // and the module's gate agrees with the fixture's reading of spec 2026-09-29 §2
      assert.deepEqual(new Set(["top", "bottom", "single"].flatMap(cat => R.eligible(ITEMS, cat, temp).map(g => g.id))), eligibleIds);
    });
    test("no combo on page 1 two consecutive days (zero overlap)", () => {
      const p1 = lineups.map(day => new Set(keysOf(day.slice(0, PER_PAGE))));
      const overlaps = [];
      for (let i = 1; i < p1.length; i++) overlaps.push([...p1[i - 1]].filter(k => p1[i].has(k)).length);
      assert.equal(Math.max(...overlaps), 0, `overlaps: ${overlaps.join(",")}`);
    });
    test(`≥ ${MIN_CARRYOVER * 100}% of yesterday's page 1 still offered today — demotion, not exclusion`, () => {
      const p1 = lineups.map(day => keysOf(day.slice(0, PER_PAGE)));
      const all = lineups.map(day => new Set(keysOf(day)));
      const carry = [];
      for (let i = 1; i < lineups.length; i++) carry.push(p1[i - 1].filter(k => all[i].has(k)).length / Math.max(1, p1[i - 1].length));
      const mean = carry.reduce((a, b) => a + b, 0) / carry.length;
      assert.ok(mean >= MIN_CARRYOVER, `${(mean * 100).toFixed(0)}% carried`);
    });
    test("page 1 is garment-distinct every day", () => {
      DATES.forEach((date, i) => assert.ok(distinct(lineups[i].slice(0, PER_PAGE)), `${date}: page 1 repeats a garment`));
    });
    test(`${CAP} outfits offered every day (3 pages deep)`, () => {
      for (const day of lineups) assert.equal(day.length, CAP);
      for (const day of lineups) assert.equal(new Set(keysOf(day)).size, CAP, "no look dealt twice");
    });
  });
}

describe("picks → staples (variety_test.py:135-196)", () => {
  test("two picked combos (2.0 and 1.5) hold the page-1 staple slots; today's own events do not count", () => {
    const day1 = build(ITEMS, TEMP.warm, "2026-08-05", { days: {}, events: {} });
    const x = day1[0];
    const y = day1.find(o => !o.pieces.some(p => x.pieces.some(q => q.id === p.id)));
    const ids = o => o.pieces.map(p => p.id);
    const events = {
      "2026-08-01": [{ kind: "select", combo: ids(x) }, { kind: "yes", combo: ids(x) }],
      "2026-08-02": [{ kind: "yes", combo: ids(x) }, { kind: "yes", combo: ids(x) }, { kind: "yes", combo: ids(x) }, { kind: "yes", combo: ids(y) }],
      "2026-08-03": [{ kind: "select", combo: ids(y) }],
      "2026-08-05": [{ kind: "yes", combo: ids(y) }],
    };
    const picks = R.derivePicks(events, "2026-08-05");
    assert.equal(picks[x.key], 2.0);
    assert.equal(picks[y.key], 1.5);
    assert.equal(Object.keys(picks).length, 2);
    const day = build(ITEMS, TEMP.warm, "2026-08-05", { days: {}, events });
    const p1 = keysOf(day.slice(0, PER_PAGE));
    assert.ok(p1.includes(x.key) && p1.includes(y.key), "both picked combos hold the page-1 staple slots");
    assert.deepEqual(new Set(p1.slice(0, 2)), new Set([x.key, y.key]), "…and they are the first two");
  });
  test("a Yes from a deep page (never on page 1) is seated on page 1 as the staple the next day", () => {
    for (const band of BANDS) {
      const { lineups, seen } = SIM[band];
      const deep = lineups[0][15];
      assert.ok(!keysOf(lineups[0].slice(0, PER_PAGE)).includes(deep.key));
      const history = structuredClone(seen[1]);               // day 1 recorded, nothing else
      history.events[DATES[0]] = [{ kind: "yes", combo: deep.pieces.map(p => p.id) }];
      const day2 = build(ITEMS, TEMP[band], DATES[1], history);
      assert.equal(day2[0].key, deep.key, band);
    }
  });
});

describe("same-day rebuild is stable (spec §3.3)", () => {
  test("same seed + same history → identical list, also after today's own events were added", () => {
    for (const band of BANDS) {
      const { lineups, seen } = SIM[band];
      for (const i of [3, 9]) {
        const again = build(ITEMS, TEMP[band], DATES[i], structuredClone(seen[i]));
        assert.deepEqual(keysOf(again), keysOf(lineups[i]), `${band} ${DATES[i]}`);
        const withToday = structuredClone(seen[i]);
        withToday.events[DATES[i]] = [{ kind: "select", combo: lineups[i][4].pieces.map(p => p.id) }, { kind: "yes", combo: lineups[i][9].pieces.map(p => p.id) }];
        withToday.days[DATES[i]] = { band, page1: lineups[i].slice(0, PER_PAGE).map(c => c.pieces.map(p => p.id)) };
        assert.deepEqual(keysOf(build(ITEMS, TEMP[band], DATES[i], withToday)), keysOf(lineups[i]), `${band} ${DATES[i]} with today's events`);
      }
    }
  });
});

describe("yesterday's page 1 leads page 2 (outfit_set.py:538-556)", () => {
  test("indices 7-13 are yesterday's page-1 combos in today's ranked order", () => {
    for (const band of BANDS) {
      const { lineups, seen } = SIM[band];
      for (let i = 1; i < DAYS; i++) {
        const yKeys = keysOf(lineups[i - 1].slice(0, PER_PAGE));
        const page2 = lineups[i].slice(PER_PAGE, 2 * PER_PAGE);
        assert.deepEqual(new Set(keysOf(page2)), new Set(yKeys), `${band} ${DATES[i]}`);
        const ctx = { seed: DATES[i], pairing: R.normalizePairing(PAIRING), favorites: new Set(), picks: R.derivePicks(seen[i].events, DATES[i]), lastP1: R.lastPage1(seen[i], DATES[i]), temp: TEMP[band] };
        const scores = page2.map(c => R.rankOf(c.pieces, ctx));
        for (let k = 1; k < scores.length; k++) assert.ok(scores[k - 1] >= scores[k], `${band} ${DATES[i]}: page 2 in ranked order`);
      }
    }
  });
});

describe("deep pages (spec §1 V3 / §3.2, outfit_set.py:543-556)", () => {
  test("garment-once per page: slices 7-14 and 14-21 are garment-distinct every day, both bands", () => {
    for (const band of BANDS)
      SIM[band].lineups.forEach((day, i) => {
        assert.ok(distinct(day.slice(PER_PAGE, 2 * PER_PAGE)), `${band} ${DATES[i]}: page 2 repeats a garment`);
        // 82 °F leaves this wardrobe six bottoms (the shorts) and four singles,
        // and a single is dealt once a DAY, not once a page — so by page 3 at
        // most six garment-distinct looks are left, the algorithmic page runs
        // one short and the rendered seventh spills into the next one, where a
        // pair of shorts may return (the I11 spill clothing-attrs.test.mjs
        // names; the old hot band admitted eight bottoms and never met it).
        // The rule itself is what the next test pins, on every page.
        if (band !== "hot")
          assert.ok(distinct(day.slice(2 * PER_PAGE, 3 * PER_PAGE)), `${band} ${DATES[i]}: page 3 repeats a garment`);
      });
  });
  test("…and at 82 °F, a repeat on page 3 is only ever that spill: the algorithm's own pages are garment-distinct", () => {
    // Re-cut the hot days into the loop's own pages: a new page starts when a
    // look would repeat a garment already on the current one. Every day must
    // cut into exactly one page more than it renders — the spill — and no
    // more, i.e. only the LAST rendered page ever straddles two.
    SIM.hot.lineups.forEach((day, i) => {
      const deep = day.slice(PER_PAGE);
      let pages = 1, used = new Set();
      for (const c of deep) {
        const ids = c.pieces.map(p => p.id);
        if (ids.some(id => used.has(id))) { pages++; used = new Set(); }
        for (const id of ids) used.add(id);
      }
      assert.ok(pages <= 3, `hot ${DATES[i]}: the deep pages cut into ${pages} garment-distinct runs`);
      assert.ok(distinct(day.slice(PER_PAGE, 2 * PER_PAGE)), `hot ${DATES[i]}: page 2 never straddles`);
    });
  });
});

describe("hub deviation (W1, A4-4): the same board from any item order", () => {
  test("shuffled item order → identical key list, every day, both bands", () => {
    const rev = [...ITEMS].reverse();
    const rot = ITEMS.slice(11).concat(ITEMS.slice(0, 11));
    for (const band of BANDS) {
      const a = simulate(band, rev), b = simulate(band, rot);
      for (let i = 0; i < DAYS; i++) {
        assert.deepEqual(keysOf(a.lineups[i]), keysOf(SIM[band].lineups[i]), `${band} ${DATES[i]} reversed`);
        assert.deepEqual(keysOf(b.lineups[i]), keysOf(SIM[band].lineups[i]), `${band} ${DATES[i]} rotated`);
      }
    }
  });
});

describe("hub deviation (I5, spec §3.1 item 4): a wardrobe with no attributes still fills the board", () => {
  test("no attributes: 21 looks, page 1 garment-distinct, every two-piece pool entry styleScore 55", () => {
    const bare = stripAttributes(ITEMS);
    const empty = { great: [], avoid: [] };
    const tops = bare.filter(g => g.category === "top");
    const bottoms = bare.filter(g => g.category === "pants" || g.category === "shorts");
    for (const t of tops) for (const b of bottoms) {
      assert.ok(R.harmonizes(t, b), `${t.id}+${b.id} harmonizes`);
      assert.equal(R.styleScore(t, b, R.normalizePairing(empty)), 55);
    }
    for (const temp of ALL_TEMPS) {
      const out = build(bare, temp, "2026-08-05", { days: {}, events: {} }, empty);
      assert.equal(out.length, CAP, String(temp));
      if (!TIGHT_TEMPS.has(temp))
        assert.ok(distinct(out.slice(0, PER_PAGE)), `${temp}: page 1 garment-distinct`);
    }
  });
});

// The mirror image of the case above. There the model had said NOTHING and the
// degradation clause carried the wardrobe; here it has spoken, and said "loud"
// about every single garment — the one answer that can empty tops × bottoms,
// because a statement piece only harmonizes with a plain partner. Spec §3.4
// states the principle for the weather gate ("a wardrobe must never empty the
// board") and widens the band to keep it; the taste gate needs the same floor,
// or a hub whose model has a bad morning deals a board with no outfits on it.
describe("taste floor (spec §3.4's rule, §3.1 item 4): a wardrobe described as all-loud still fills the board", () => {
  test("every garment a statement piece: 21 looks, page 1 garment-distinct", () => {
    const loud = ITEMS.map(g => ({ ...g, statement: true, pattern: "graphic", colors: ["magenta"] }));
    const empty = { great: [], avoid: [] };
    const tops = loud.filter(g => g.category === "top");
    const bottoms = loud.filter(g => g.category === "pants" || g.category === "shorts");
    for (const t of tops) for (const b of bottoms)
      assert.equal(R.harmonizes(t, b), false, `${t.id}+${b.id}: two loud pieces never harmonize`);
    for (const temp of ALL_TEMPS) {
      const out = build(loud, temp, "2026-08-05", { days: {}, events: {} }, empty);
      assert.equal(out.length, CAP, String(temp));
      if (!TIGHT_TEMPS.has(temp))
        assert.ok(distinct(out.slice(0, PER_PAGE)), `${temp}: page 1 garment-distinct`);
    }
  });
  // Weather-offline only, on purpose: on a cool or a cold morning the gate can
  // leave this plain bottom out of the pool, so the eligible bottoms are loud
  // again and the floor is right to open there.
  test("the floor is a last resort: one plain bottom is enough to keep it shut", () => {
    const loud = ITEMS.map(g => ({ ...g, statement: true, pattern: "graphic", colors: ["magenta"] }));
    const oneQuiet = loud.map(g => g.id === loud.find(x => x.category === "pants").id
      ? { ...g, statement: false, pattern: "solid" } : g);
    const out = build(oneQuiet, null, "2026-08-05", { days: {}, events: {} }, { great: [], avoid: [] });
    const pairs = out.filter(c => c.pieces.length === 2);
    const quietId = loud.find(x => x.category === "pants").id;
    for (const c of pairs)
      assert.ok(c.pieces.some(p => p.id === quietId), c.key + ": only the plain bottom pairs while any pair harmonizes");
  });
  // The same rule from the other side, and the answer to "the worst wardrobe
  // deals a longer board than a slightly better one" (review r2 nit, re-measured
  // across all five bands in r3, and across the five mornings on 9/29). One
  // plain TOP gives every pair the same top, so page 1 fills garment-distinct
  // and stops short (A4-11) and each deeper page carries one pair. Where the
  // honest deal still fills a page — 82 °F 10 (the six shorts and four
  // singles), 74 °F and weather-offline 18 — that shorter board is the
  // garment-once-per-page rule and the floor must stay SHUT, or a board with
  // honest pairs is padded with loud-on-loud ones. Where the gate leaves the
  // plain top six loud pants and no dress — 60 °F, six pairs — or nothing at
  // all — 48 °F — the honest deal is less than one page, and the floor opens
  // (A4-12).
  //
  // The lengths are pinned per morning, not asserted `> 0`: a six-look cold
  // morning walks straight through a `> 0` row, and that is the regression
  // this test exists to catch.
  const PLAIN_TOP_BOARD = { 82: 10, 74: 18, 60: CAP, 48: CAP, null: 18 };
  const FLOOR_SHUT = new Set(["82", "74", "null"]);
  test("one plain top: never fewer than a page, and no loud-on-loud pair while the deal fills one", () => {
    const loud = ITEMS.map(g => ({ ...g, statement: true, pattern: "graphic", colors: ["magenta"] }));
    const quietId = loud.find(g => g.category === "top").id;
    const oneQuiet = loud.map(g => g.id === quietId ? { ...g, statement: false, pattern: "solid" } : g);
    for (const temp of ALL_TEMPS) {
      const out = build(oneQuiet, temp, "2026-08-05", { days: {}, events: {} }, { great: [], avoid: [] });
      assert.ok(out.length >= PER_PAGE, `${temp}: a full page at least, dealt ${out.length}`);
      assert.equal(out.length, PLAIN_TOP_BOARD[String(temp)], `${temp}: board length`);
      if (!FLOOR_SHUT.has(String(temp))) continue;
      for (const c of out.filter(x => x.pieces.length === 2))
        assert.ok(c.pieces.some(p => p.id === quietId),
          `${temp} ${c.key}: only the plain top pairs while the honest deal fills a page`);
    }
  });
});

describe("purity of clothing-rank.js", () => {
  test("no Math.random, Date.now or fs in the module", () => {
    const src = fs.readFileSync(path.join(HUB, "clothing-rank.js"), "utf8");
    assert.doesNotMatch(src, /Math\.random|Date\.now|require\(.fs.\)/);
  });
});
