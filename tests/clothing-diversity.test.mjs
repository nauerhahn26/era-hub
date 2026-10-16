// Weekly returns for favourites, not a Monday/Wednesday/Friday loop.
// Invented wardrobes only; no server, network, keys or private history.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const R = require(path.join(HUB, "clothing-rank.js"));
const { simulateDiversity } = await import(path.join(HUB, "tools/clothing-diversity.mjs"));
const { loadWardrobe, VERDICTS, stock, wantAt } = await import(path.join(HUB, "tools/clothing-simulate.mjs"));
const fixture = loadWardrobe(path.join(HUB, "tests/fixtures/wardrobe-shape.json"));
const seed = "2026-10-16";
const plus = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const keys = looks => looks.map(o => o.key);

describe("exact-combination memory", () => {
  test("reads the newest prior offer, including shared unions, and ignores today/future/malformed rows", () => {
    assert.deepEqual(R.lastComboPage1({ days: {
      "2026-10-14": { page1: [["a", "b"], ["c"]] },
      "2026-10-12": { page1: [["a", "b"], ["d"]] },
      "2026-10-15": { page1: [["c"], ["e", "f"], [], null, "x"] },
      "2026-10-16": { page1: [["a", "b"], ["today"]] },
      "2026-10-20": { page1: [["future"]] },
      garbage: { page1: [["bad-date"]] },
      "2026-10-01": {},
    } }, seed), { "a+b": "2026-10-14", c: "2026-10-15", d: "2026-10-12", "e+f": "2026-10-15" });
    assert.deepEqual(R.lastComboPage1({}, seed), {});
  });
  test("the preference lift survives spacing and returns at full strength after a week", () => {
    const p = { id: "dress", category: "dress", warmth: "warm" };
    const ctx = { seed, pairing: R.normalizePairing({}), favorites: new Set(),
      picks: { dress: 2 }, lastP1: {}, lastComboP1: {} };
    const unseen = R.rankOf([p], ctx);
    const at = days => R.rankOf([p], { ...ctx, lastComboP1: { dress: plus(seed, -days) } });
    assert.ok(at(2) < at(4) && at(4) < at(6) && at(6) < at(7));
    assert.equal(at(7), unseen);
    assert.equal(at(14), unseen);
    assert.equal(at(7) - R.rankOf([p], { ...ctx, picks: {}, lastComboP1: { dress: plus(seed, -7) } }), 12);
  });
});

// A broad, equally compatible wardrobe exposes selection feedback without
// weather weights/style accidentally doing the job of the preference signal.
const broad = Array.from({ length: 24 }, (_, n) => ({ id: `item_${n}`,
  ok: true, category: n < 12 ? "top" : "shorts", coverage: "short", warmth: "warm",
  colors: ["white"], pattern: "solid", palette: "neutral", vibe: "basic" }));
const preferred = [{ key: "item_0+item_12", pieces: [broad[0], broad[12]] },
  { key: "item_1+item_13", pieces: [broad[1], broad[13]] }];
const picked = { days: {}, events: {
  "2026-10-12": preferred.map(o => ({ kind: "yes", combo: o.pieces.map(p => p.id) })),
  "2026-10-13": preferred.map(o => ({ kind: "yes", combo: o.pieces.map(p => p.id) })),
} };

describe("favourites distributed across a month", () => {
  const run = simulateDiversity({ items: broad, seed, days: 42, history: picked,
    choose: looks => looks.find(o => preferred.some(p => p.key === o.key)) });
  test("favourites are still first-class options and return approximately weekly", () => {
    assert.deepEqual(new Set(keys(run.lineups[0].page1.slice(0, 2))), new Set(preferred.map(o => o.key)));
    for (const o of preferred) {
      const dates = run.appearances[o.key] || [];
      assert.ok(dates.length >= 5 && dates.length <= 8, `favourite returns ${dates.length} times in six weeks`);
      for (let i = 1; i < dates.length; i++) {
        const gap = R.daysBetween(dates[i - 1], dates[i]);
        assert.ok(gap >= 5 && gap <= 9, `favourite gap ${gap} days`);
      }
    }
    const quiet = simulateDiversity({ items: broad, seed, days: 42 });
    const remembered = simulateDiversity({ items: broad, seed, days: 42, history: picked });
    for (const o of preferred) {
      assert.ok(remembered.appearances[o.key].length > (quiet.appearances[o.key]?.length || 0),
        "learned favourites return more often even without further Yes events");
    }
  });
  test("the rest of page one changes, even when the same favourite is chosen from More", () => {
    assert.equal(run.summary.overlap[1].combos, 0);
    assert.ok(run.summary.overlap[2].combos <= 0.25);
    assert.ok(run.summary.overlap[3].combos <= 0.5);
    assert.equal(run.summary.uniqueOrderedPages, 42);
    assert.equal(run.summary.meanPageSize, 7);
  });
  test("a newly liked deep-page combination gets a turn tomorrow", () => {
    const first = R.buildCandidates({ items: broad, seed, temp: 74, perPage: 7, cap: 21 });
    const deep = first[10];
    const h = R.recordOffer({}, seed, first, 7, null);
    h.events[seed] = [{ kind: "yes", combo: deep.pieces.map(p => p.id) }];
    const next = R.buildCandidates({ items: broad, seed: plus(seed, 1), temp: 74, perPage: 7, cap: 21, history: h });
    assert.equal(next[0].key, deep.key);
  });
  test("same-day rebuilding and added same-day choices preserve order on every page", () => {
    const input = { items: broad, seed, temp: 74, perPage: 7, cap: 21, history: structuredClone(picked) };
    const first = R.buildCandidates(input);
    R.recordOffer(input.history, seed, first, 7, null);
    input.history.events[seed] = [{ kind: "yes", combo: first[8].pieces.map(p => p.id) }];
    assert.deepEqual(keys(R.buildCandidates(input)), keys(first));
    assert.deepEqual(keys(R.buildCandidates({ ...input, items: [...broad].reverse() })), keys(first));
  });
});

describe("spacing stays subordinate to wardrobe availability and weather", () => {
  test("a tiny wardrobe still offers its only favourite every day", () => {
    const items = [broad[0], broad[12]];
    const run = simulateDiversity({ items, seed, days: 14, perPage: 6, history: picked,
      choose: looks => looks[0] });
    for (const day of run.lineups) assert.deepEqual(keys(day.page1), [preferred[0].key]);
  });
  test("sparse builds remember the last actual offer, even with no yesterday entry", () => {
    const run = simulateDiversity({ items: broad, seed, days: 21, step: 2, history: picked });
    assert.equal(run.summary.overlap[1].comparisons, 0);
    assert.equal(run.summary.overlap[1].combos, null);
    assert.ok(run.summary.overlap[2].combos <= 0.25);
  });
  for (const temp of [45, 60, 70, 74, 80, 88, 95, null]) {
    test(`${temp ?? "offline"} F: full pages and weather shares hold with daily learned choices`, () => {
      const run = simulateDiversity({ items: fixture, seed, temp, days: 21,
        choose: looks => looks[0] });
      const door = fixture.filter(i => !i.hidden && !R.isAccessory(i) && i.occasion !== "fancy");
      const st = stock(door), want = temp == null ? null : wantAt(temp, st);
      for (const day of run.lineups) {
        for (const v of VERDICTS.filter(v => v.applies(temp))) {
          const result = v.check({ temp, looks: day.looks, perPage: run.summary.perPage, want, st });
          assert.ok(result.pass, `${day.date} ${v.rule}: ${result.detail}`);
        }
        assert.equal(new Set(keys(day.looks)).size, day.looks.length);
        const pieces = day.page1.flatMap(o => o.pieces.map(p => p.id));
        assert.equal(new Set(pieces).size, pieces.length, "no garment twice on page one");
      }
      if (temp === 74 || temp === 88) {
        assert.ok(run.summary.overlap[2].combos <= 0.5, "no alternate-day loop with realistic wardrobe shape");
        assert.ok(run.summary.uniqueOrderedPages >= 20);
      }
    });
  }
});
