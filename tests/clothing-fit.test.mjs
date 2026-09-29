// clothing-fit.test.mjs — the coherence harness: what the board may deal at
// each temperature, in dad's words (spec docs/superpowers/specs/2026-09-29-
// warmth-coherence-and-dress-up.md §2 D2). This is the acceptance test for
// the fit model, not the FIT table: the table, EDGE and FIT_PTS_PER_DEG are
// free to move; the thresholds are not. Loosen one and the 81 °F morning of
// 9/29 (7 long sleeves, 11 leggings, a fancy dress in 18 looks) comes back.
//
// The input is tests/fixtures/wardrobe-shape.json — the exact shape of her
// wardrobe (63 items, generic names) — swept 40-100 °F in steps of 2 plus the
// odd degree under every threshold boundary, over seven consecutive days with
// the memory running between them (so freshness and the coverage slot move
// the deal the way they do on the tablet, and no lucky jitter can pass it),
// twice: as refit leaves it (coverage/weight/legs) and stripped, the way a
// catalogue refit has not reached yet (the legacy fallback, §2 D1).
// "72-77: shorts and pants both present" is a VARIETY verdict (spec §2 †,
// ruled 9/29): judged from day 2, when a memory exists — the first day of a
// run has none, and the fit term there legitimately sweeps one bottom kind.
// Every other verdict (coherence) is judged on all seven days, day 1 included.
//
// The engine is tools/clothing-simulate.mjs — the same one the CLI runs over
// a device's real wardrobe.json before a push. No server, no port, no network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(__dirname, "..");
const TOOL = path.join(HUB, "tools", "clothing-simulate.mjs");
const FIXTURE = path.join(__dirname, "fixtures", "wardrobe-shape.json");
const { simulate, loadWardrobe, THRESHOLDS } = await import(TOOL);

const ITEMS = loadWardrobe(FIXTURE);
const TEMPS = [];
for (let t = 40; t <= 100; t += 2) TEMPS.push(t);
TEMPS.push(53, 61, 71, 77, 85);   // one degree under each boundary of the §2 table
TEMPS.sort((a, b) => a - b);
const SEED = "2026-09-29";        // the receipt's morning; days run 9/29 → 10/5
const DAYS = 7;

// every failing verdict, as one readable list, so a red run says what the
// board did rather than "false !== true"
function failures(run) {
  const out = [];
  for (const r of run.results)
    for (const d of r.days)
      for (const v of d.verdicts)
        if (!v.pass) out.push(`${r.temp} °F ${d.seed} — ${v.rule}: ${v.detail}`);
  return out;
}

describe("the §2 threshold table over her wardrobe's shape, 40-100 °F, seven consecutive days", () => {
  for (const stripFit of [false, true]) {
    const mode = stripFit ? "stripped (the legacy fallback, before refit)" : "with coverage/weight/legs (after refit)";
    test(mode, () => {
      const run = simulate({ items: ITEMS, temps: TEMPS, seed: SEED, days: DAYS, stripFit });
      assert.equal(run.results.length, TEMPS.length);
      for (const r of run.results) {
        assert.equal(r.days.length, DAYS, `${r.temp}: seven days`);
        for (const d of r.days) assert.ok(d.verdicts.length >= 2, `${r.temp} ${d.seed}: the always-rules are checked`);
      }
      const bad = failures(run);
      assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
    });
  }
});

describe("spec §2 (†): the variety verdict waits for a memory; coherence never does", () => {
  test("day 1 skips only 'shorts and pants both present'; days 2-7 judge it; every coherence verdict is judged on day 1", () => {
    const run = simulate({ items: ITEMS, temps: [72, 81], seed: SEED, days: 3 });
    for (const r of run.results) {
      const [d1, d2, d3] = r.days;
      assert.equal(d1.memory, false);
      assert.equal(d2.memory, true);
      assert.equal(d3.memory, true);
      for (const v of d1.verdicts) assert.equal(v.skipped === true, /shorts and pants/.test(v.rule), `${r.temp} day 1: ${v.rule}`);
      for (const d of [d2, d3]) for (const v of d.verdicts) assert.notEqual(v.skipped, true, `${r.temp} ${d.seed}: ${v.rule} judged`);
    }
    // the variety row applies at 72 only; at 81 nothing is ever skipped
    assert.ok(run.results[0].days[0].verdicts.some(v => v.skipped));
    assert.ok(!run.results[1].days[0].verdicts.some(v => v.skipped));
  });
  test("a one-day CLI run says SKIP for the variety verdict, never PASS", () => {
    const r = spawnSync(process.execPath, [TOOL, "--wardrobe", FIXTURE, "--temps", "74", "--seed", SEED], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /SKIP {2}72-77: shorts and pants both present/);
  });
});

describe("the harness checks what it claims (a verdict that cannot fail proves nothing)", () => {
  // Each rule is fed a deal that breaks it; the verdict must say so. Built
  // from the fixture's own garments so the words are the real ones.
  const byName = n => ITEMS.find(i => i.name === n);
  const look = (...names) => ({ pieces: names.map(byName) });
  const judge = (temp, looks, perPage = 6, stripFit = false) => THRESHOLDS
    .filter(th => th.mode === (stripFit ? "legacy" : "fit") && th.applies(temp))
    .map(th => ({ rule: th.rule, ...th.check({ temp, looks, perPage }) }));
  const failed = (vs, re) => vs.some(v => !v.pass && re.test(v.rule));
  test("a long sleeve at 81, a fancy dress at any temperature, a short board", () => {
    const vs = judge(81, [look("top 05", "shorts 01"), look("dress 02")]);
    assert.ok(failed(vs, /long-sleeve/), "long sleeve at 81");
    assert.ok(failed(vs, /fancy/), "fancy dress");
    assert.ok(failed(vs, /full page/), "two looks is not a page");
  });
  test("four long bottoms at 80; two on page 1", () => {
    const looks = [look("top 01", "pants 01"), look("top 07", "pants 03"), look("top 09", "shorts 01"),
      look("top 10", "shorts 02"), look("top 11", "shorts 03"), look("top 12", "shorts 04"),
      look("top 13", "pants 04"), look("top 16", "pants 06")];
    assert.ok(failed(judge(80, looks), /long bottoms/));
  });
  test("a mid long sleeve at 74; no shorts at 74", () => {
    const vs = judge(74, [look("top 02", "pants 01")]);
    assert.ok(failed(vs, /mid\/heavy long sleeve/));
    assert.ok(failed(vs, /shorts and pants/));
  });
  test("a tank on page 1 at 66; shorts and a bare-legged dress at 58; a tee leading at 50", () => {
    assert.ok(failed(judge(66, [look("top 03", "pants 01")]), /sleeveless/));
    const cool = judge(58, [look("top 05", "shorts 01"), look("dress 01")]);
    assert.ok(failed(cool, /no shorts/));
    assert.ok(failed(cool, /bare-legged/));
    assert.ok(failed(judge(50, [look("top 01", "pants 01")]), /short-sleeve/));
  });
  test("light before mid at 50: a light long sleeve on page 1 while an admitted mid one waits", () => {
    const looks = [look("top 05", "pants 01"), look("top 08", "pants 03"), look("top 14", "pants 04"),
      look("top 24", "pants 06"), look("top 28", "pants 07"), look("top 29", "pants 08"),
      look("top 02", "pants 09")];
    assert.ok(failed(judge(50, looks), /mid\/heavy before light/));
  });
  test("legacy: a cool-tagged top at 80, a hot-tagged garment at 50, an empty board", () => {
    assert.ok(failed(judge(80, [look("top 05", "shorts 01")], 6, true), /cool\/cold-tagged/));
    assert.ok(failed(judge(50, [look("top 03", "pants 01")], 6, true), /hot-tagged/));
    assert.ok(failed(judge(70, [], 6, true), /never empty/));
  });
});

describe("tools/clothing-simulate.mjs — the deploy check dad asked for", () => {
  test("simulate() reads the fixture like the worker: fancy and accessories never dealt, six to a page while jackets exist", () => {
    const run = simulate({ items: ITEMS, temps: [72], seed: SEED });
    assert.equal(run.perPage, 6, "the accessories door takes the seventh slot");
    assert.equal(run.cap, 18);
    const r = run.results[0];
    assert.deepEqual(Object.keys(r.admitted).sort(), ["bottom", "single", "top"]);
    for (const l of r.looks) for (const p of l.pieces) {
      assert.notEqual(p.occasion, "fancy");
      assert.ok(["top", "pants", "shorts", "dress", "set"].includes(p.category), p.category);
    }
    for (const l of r.looks) assert.equal(typeof l.sleeves, "string");
  });
  test("the CLI prints each temperature, its looks with sleeve/leg words and every verdict — from a hub's {items: {file: entry}} wardrobe.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "era-clo-sim-"));
    try {
      const f = path.join(tmp, "wardrobe.json");
      fs.copyFileSync(FIXTURE, f);
      const r = spawnSync(process.execPath, [TOOL, "--wardrobe", f, "--temps", "58,81", "--seed", SEED], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /58 °F/);
      assert.match(r.stdout, /81 °F/);
      assert.match(r.stdout, /admitted/);
      assert.match(r.stdout, /\[(sleeveless|short|long)/);
      assert.match(r.stdout, /PASS/);
      assert.doesNotMatch(r.stdout, /FAIL/);
      const s = spawnSync(process.execPath, [TOOL, "--wardrobe", f, "--temps", "81", "--strip-fit"], { encoding: "utf8" });
      assert.equal(s.status, 0, s.stderr);
      assert.match(s.stdout, /legacy/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  test("the CLI exits non-zero on a verdict that fails, and on a missing --wardrobe", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "era-clo-sim-"));
    try {
      // a wardrobe of nothing but long sleeves and long pants cannot dress
      // her for 95 °F: the floor deals it anyway, and the verdict says FAIL
      const items = {};
      for (let i = 1; i <= 7; i++) items[`t${i}.jpg`] = { id: `item_t${i}`, ok: true, name: `top ${i}`, category: "top", coverage: "long", weight: "mid" };
      for (let i = 1; i <= 3; i++) items[`p${i}.jpg`] = { id: `item_p${i}`, ok: true, name: `pants ${i}`, category: "pants", coverage: "long", weight: "mid" };
      const f = path.join(tmp, "wardrobe.json");
      fs.writeFileSync(f, JSON.stringify({ items }));
      const r = spawnSync(process.execPath, [TOOL, "--wardrobe", f, "--temps", "95"], { encoding: "utf8" });
      assert.equal(r.status, 1);
      assert.match(r.stdout, /FAIL/);
      const u = spawnSync(process.execPath, [TOOL], { encoding: "utf8" });
      assert.equal(u.status, 2);
      assert.match(u.stderr, /--wardrobe/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
