// clothing-fit.test.mjs — the coherence harness: what the board deals at each
// temperature, in dad's numbers (spec docs/superpowers/specs/2026-09-29-
// warmth-coherence-and-dress-up.md §7, which superseded the §2 gate and its
// threshold table the same evening). Dad, 9/29: "the code shouldn't be all or
// nothing logic. At 70 should be an even mix of shorts and pants for
// instance. by 80 it should be 90% shorts, by 60 should be 90% pants, a
// spectrum is the logic/probabilities. This is just an example, but should
// handle every #."
//
// This is the acceptance test for the deal, not for any table inside it. The
// curve's constants may move (spec §7.1: "tuning is moving a number"); what
// is asserted here is that the board deals the curve, at every integer °F
// from 45 to 95, over seven consecutive days with the memory running between
// them (so freshness and the coverage slot move the deal the way they do on
// the tablet, and no lucky day can pass it), twice: as refit leaves the
// catalogue (coverage/weight/legs) and stripped, the way a catalogue refit
// has not reached yet (the legacy fallback, §2 D1 — §7.3: it "must hold the
// same curve").
//
// The input is tests/fixtures/wardrobe-shape.json — the exact shape of her
// wardrobe (63 items, generic names). The engine is tools/clothing-simulate.mjs
// — the same one the CLI runs over a device's real wardrobe.json before a
// push; the curve in it is written from the spec, not read off the module.
// No server, no port, no network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(__dirname, "..");
const TOOL = path.join(HUB, "tools", "clothing-simulate.mjs");
const FIXTURE = path.join(__dirname, "fixtures", "wardrobe-shape.json");
const require = createRequire(import.meta.url);
const R = require(path.join(HUB, "clothing-rank.js"));
const { simulate, loadWardrobe, VERDICTS, curve, wantAt, stock, apportion, cellOf, K } = await import(TOOL);

const ITEMS = loadWardrobe(FIXTURE);
// the fixture without its jackets: seven looks a page instead of six (the
// accessories door takes the seventh cell while she has any), which is the
// page dad's "1/7, 3-4/7, 6/7" is counted on
const NO_ACCESSORIES = ITEMS.filter(i => !R.isAccessory(i));
const TEMPS = [];
for (let t = 45; t <= 95; t++) TEMPS.push(t);
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
const dryCells = run => {
  const out = new Set();
  for (const r of run.results) for (const d of r.days) for (const v of d.verdicts) if (v.dry) out.add(`${r.temp} °F ${v.rule}: ${v.detail}`);
  return [...out];
};

describe("dad's curve (spec §7.1) — the harness's own, written from the spec", () => {
  test("K = 10 / ln 9: ten degrees from a crossover is exactly 90 / 10", () => {
    assert.ok(Math.abs(K - 10 / Math.log(9)) < 1e-12);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(curve(60).legs.shorts, 0.1), "60 °F: 10 % shorts-side");
    assert.ok(near(curve(70).legs.shorts, 0.5), "70 °F: an even mix");
    assert.ok(near(curve(80).legs.shorts, 0.9), "80 °F: 90 % shorts-side");
    assert.ok(near(curve(53).top.long, 0.9) && near(curve(73).top.long, 0.1), "long sleeve crosses at 63");
    assert.ok(near(curve(80).top.sleeveless, 0.5) && near(curve(90).top.sleeveless, 0.9), "sleeveless crosses at 80");
  });
  test("the 5 % floor: 78 °F deals no long sleeve (3.6 %), 54 °F no shorts (2.9 %); the rest renormalise", () => {
    const st = stock(ITEMS.filter(i => !R.isAccessory(i) && i.occasion !== "fancy"));
    const raw78 = curve(78).top.long, raw54 = curve(54).legs.shorts;
    assert.ok(raw78 > 0.03 && raw78 < 0.05, `raw long sleeve at 78: ${raw78}`);
    assert.ok(raw54 > 0.02 && raw54 < 0.05, `raw shorts at 54: ${raw54}`);
    assert.equal(wantAt(78, st).top.long, 0);
    assert.equal(wantAt(54, st).legs.shorts, 0);
    assert.equal(wantAt(54, st).legs.pants, 1);
    const w78 = wantAt(78, st).top;
    assert.ok(Math.abs(w78.sleeveless + w78.short - 1) < 1e-12, "renormalised");
    // the floor's own edges: the raw curve crosses 5 % at 63 + K·ln 19 ≈ 76.4
    // (long sleeve) and 70 − K·ln 19 ≈ 56.6 (shorts), so the kind is last in at
    // 76 and first in at 57 — the 78 / 54 of §7.3 sit two degrees inside
    assert.ok(wantAt(76, st).top.long > 0 && wantAt(77, st).top.long === 0, "long sleeve: in at 76, out at 77");
    assert.ok(wantAt(57, st).legs.shorts > 0 && wantAt(56, st).legs.shorts === 0, "shorts: out at 56, in at 57");
  });
  test("clothing-rank.js deals from the same curve: its shares agree with the spec's at every °F", () => {
    for (let t = 40; t <= 100; t += 0.5) {
      const mine = curve(t), its = R.sharesAt(t);
      for (const dim of ["top", "legs"]) for (const k of Object.keys(mine[dim]))
        assert.ok(Math.abs(mine[dim][k] - its.raw[dim][k]) < 1e-9, `${t} ${dim} ${k}: ${its.raw[dim][k]} vs ${mine[dim][k]}`);
    }
  });
});

describe("spec §7.3 over her wardrobe's shape, every integer °F 45-95, seven consecutive days", () => {
  for (const stripFit of [false, true]) {
    const mode = stripFit ? "stripped (the legacy fallback, before refit)" : "with coverage/weight/legs (after refit)";
    test(mode, () => {
      const run = simulate({ items: ITEMS, temps: TEMPS, seed: SEED, days: DAYS, stripFit });
      assert.equal(run.results.length, TEMPS.length);
      assert.equal(run.perPage, 6, "the accessories door takes the seventh slot");
      for (const r of run.results) {
        assert.equal(r.days.length, DAYS, `${r.temp}: seven days`);
        for (const d of r.days) assert.equal(d.verdicts.length, 6 + (r.temp >= 78) + (r.temp <= 54), `${r.temp} ${d.seed}: every verdict judged`);
      }
      const dry = dryCells(run);
      if (dry.length) console.log(`# ${mode} — DRY (her wardrobe cannot fill the apportionment):\n# ${dry.join("\n# ")}`);
      const bad = failures(run);
      assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
    });
  }
});

describe("the anchors, by name (spec §7.3): shorts-side ≈ 10 % at 60, 50 % at 70, 90 % at 80", () => {
  // page 1 of seven looks (the fixture without jackets): 1/7, 3-4/7, 6/7 —
  // and of six (as her board stands, jackets and all): 1/6, 3/6, 5/6
  for (const stripFit of [false, true]) {
    test(stripFit ? "stripped" : "after refit", () => {
      const shortsOnP1 = (items, temp) => simulate({ items, temps: [temp], seed: SEED, days: DAYS, stripFit })
        .results[0].days.map(d => d.page1.legs.shorts);
      const seven = { 60: [1], 70: [3, 4], 80: [6] }, six = { 60: [1], 70: [3], 80: [5] };
      for (const t of [60, 70, 80]) {
        for (const n of shortsOnP1(NO_ACCESSORIES, t)) assert.ok(seven[t].includes(n), `${t} °F, seven a page: ${n}/7 shorts-side`);
        for (const n of shortsOnP1(ITEMS, t)) assert.ok(six[t].includes(n), `${t} °F, six a page: ${n}/6 shorts-side`);
      }
      // …and across the whole deal, every day
      const run = simulate({ items: ITEMS, temps: [60, 70, 80], seed: SEED, days: DAYS, stripFit });
      const want = { 60: 0.1, 70: 0.5, 80: 0.9 };
      for (const r of run.results) for (const d of r.days) {
        const share = d.deal.legs.shorts / d.looks.length;
        assert.ok(Math.abs(share - want[r.temp]) <= 0.10, `${r.temp} °F ${d.seed}: ${Math.round(share * 100)} % shorts-side in the deal`);
      }
    });
  }
  test("the floors, by name: zero long sleeve at ≥ 78, zero shorts-side at ≤ 54, in any look of any page", () => {
    const run = simulate({ items: ITEMS, temps: [45, 50, 54, 78, 85, 95], seed: SEED, days: DAYS });
    for (const r of run.results) for (const d of r.days) {
      if (r.temp >= 78) assert.equal(d.deal.top.long, 0, `${r.temp} ${d.seed}: long sleeve`);
      if (r.temp <= 54) assert.equal(d.deal.legs.shorts, 0, `${r.temp} ${d.seed}: shorts-side`);
    }
  });
});

describe("70 °F on consecutive days alternates which side gets the odd slot (spec §7.2: the tie breaks by the day's hash)", () => {
  test("seven a page: both 4/3 and 3/4 happen across the week, and no day is anything else", () => {
    const run = simulate({ items: NO_ACCESSORIES, temps: [70], seed: SEED, days: DAYS });
    assert.equal(run.perPage, 7);
    const splits = run.results[0].days.map(d => `${d.page1.legs.shorts}/${d.page1.legs.pants}`);
    for (const s of splits) assert.ok(s === "4/3" || s === "3/4", `a 70 °F page 1 is 4/3 or 3/4: ${s}`);
    assert.ok(splits.includes("4/3") && splits.includes("3/4"), `both sides get the odd slot: ${splits.join(", ")}`);
  });
});

describe("weather offline (temp null) is the port's deal, exactly as before §7 (spec §7.2)", () => {
  // Pinned 9/29 from the pre-§7 module on this fixture: seven days from the
  // receipt's morning, six a page, eighteen looks. Offline never read a fit
  // word, so the stripped fixture deals the same list.
  const DAY1 = ["item_4d8e07f2b4+item_f8febddd5a", "item_4d6504ab1e+item_47d1d8e12f", "item_178521ef10+item_36bb3f8631",
    "item_8b8348d5d8+item_2a1f658ac1", "item_4d3da45986+item_4466d62ed7", "item_cfd6a258b5+item_f8a022e604",
    "item_42e46a25f2+item_f8febddd5a", "item_14cccc4701+item_36bb3f8631", "item_4d3da45986+item_d8b8d5cde6",
    "item_37a93d3c63+item_8919a44241", "item_3a815f6855+item_10808c4c69", "item_4d6504ab1e+item_eea35ac381",
    "item_86aeba7072+item_f8febddd5a", "item_3a815f6855+item_40b24aea1b", "item_4d3da45986+item_10808c4c69",
    "item_7a4df9167d+item_f8a022e604", "item_8b8348d5d8+item_5bf563c2b5", "item_097b9a61fa+item_eea35ac381"];
  const WEEK_SHA256 = "8eb89ec784e024c248ec4c6f77e93285b7c88a35ba3b559b830aeb56fcd64c8a";
  for (const stripFit of [false, true]) {
    test(stripFit ? "stripped" : "after refit", () => {
      const run = simulate({ items: ITEMS, temps: [null], seed: SEED, days: DAYS, stripFit });
      const week = run.results[0].days.map(d => d.looks.map(l => l.key));
      assert.deepEqual(week[0], DAY1);
      assert.equal(crypto.createHash("sha256").update(JSON.stringify(week)).digest("hex"), WEEK_SHA256);
      assert.deepEqual(failures(run), []);
    });
  }
});

describe("the harness checks what it claims (a verdict that cannot fail proves nothing)", () => {
  // Each verdict is fed a deal that breaks it; it must say so. Built from the
  // fixture's own garments so the words are the real ones.
  const byName = n => ITEMS.find(i => i.name === n);
  const look = (...names) => { const pieces = names.map(byName); return { key: pieces.map(p => p.id).join("+"), pieces }; };
  const st = stock(ITEMS.filter(i => !R.isAccessory(i) && i.occasion !== "fancy"));
  const judge = (temp, looks, perPage = 6) => VERDICTS.filter(v => v.applies(temp))
    .map(v => ({ rule: v.rule, ...v.check({ temp, looks, perPage, want: wantAt(temp, st), st }) }));
  const failed = (vs, re) => vs.some(v => !v.pass && re.test(v.rule));
  const passed = (vs, re) => vs.some(v => v.pass && re.test(v.rule));
  const rep = (n, l) => Array.from({ length: n }, () => l);
  test("the fixture reads as it should: the cells the harness sees", () => {
    assert.deepEqual(cellOf(look("top 03", "shorts 01")), { top: "sleeveless", legs: "shorts" });
    assert.deepEqual(cellOf(look("top 05", "pants 01")), { top: "long", legs: "pants" });
    assert.deepEqual(cellOf(look("top 01", "shorts 01")), { top: "short", legs: "shorts" });
  });
  test("an all-shorts page at 60 (the 9/29 gate's cliff, mirrored); an all-pants page at 78", () => {
    const shorts60 = judge(60, rep(18, look("top 05", "shorts 01")));
    assert.ok(failed(shorts60, /page 1 = the apportionment: legs/));
    assert.ok(failed(shorts60, /±10 points of the curve: legs/));
    const pants78 = judge(78, rep(18, look("top 01", "pants 01")));
    assert.ok(failed(pants78, /page 1 = the apportionment: legs/), "78 °F apportions 5 shorts-side of 6");
    assert.ok(failed(pants78, /±10 points of the curve: legs/));
  });
  test("a long sleeve at 78, a pair of shorts at 54; a fancy dress anywhere; a short board", () => {
    assert.ok(failed(judge(78, [look("top 05", "shorts 01")]), /no long sleeve/));
    assert.ok(failed(judge(54, [look("top 05", "shorts 01")]), /no shorts-side/));
    const vs = judge(70, [look("dress 02")]);
    assert.ok(failed(vs, /fancy/));
    assert.ok(failed(vs, /full page/));
  });
  test("off by one is excused only where the kind is dry, and the verdict names it", () => {
    // 95 °F wants six sleeveless of six; her five tanks and a tee is off by
    // one — and the fixture has four sleeveless dresses the page could have used.
    const tanks = ["top 03", "top 15", "top 17", "top 19", "top 27"];
    const page = [...tanks.map((t, k) => look(t, "shorts 0" + (k + 1))), look("top 01", "shorts 06")];
    assert.ok(failed(judge(95, page), /page 1 = the apportionment: top half/), "not dry: the dresses were there");
    // take the dresses away and the same page is the wardrobe's best: DRY, named
    const noDresses = stock(ITEMS.filter(i => !R.isAccessory(i) && i.occasion !== "fancy" && i.category !== "dress"));
    const v = VERDICTS.find(x => /top half/.test(x.rule) && /page 1/.test(x.rule))
      .check({ temp: 95, looks: page, perPage: 6, want: wantAt(95, noDresses), st: noDresses });
    assert.equal(v.pass, true, v.detail);
    assert.deepEqual(v.dry, ["top:sleeveless"]);
    assert.match(v.detail, /DRY: top sleeveless/);
  });
  test("the right mix passes: 80 °F, five shorts-side and one pants-side, three sleeveless and three short", () => {
    const page = [look("top 03", "shorts 01"), look("top 15", "shorts 03"), look("dress 01"),
      look("top 01", "shorts 04"), look("top 09", "shorts 05"), look("top 10", "pants 01")];
    const vs = judge(80, page);
    assert.ok(passed(vs, /page 1 = the apportionment: legs/), JSON.stringify(vs));
    assert.ok(passed(vs, /page 1 = the apportionment: top half/), JSON.stringify(vs));
    assert.ok(passed(vs, /no long sleeve/));
  });
  test("apportion: largest remainder, a tie is a range either side may take", () => {
    assert.deepEqual(apportion(7, { shorts: 0.5, pants: 0.5 }).range, { shorts: [3, 4], pants: [3, 4] });
    assert.deepEqual(apportion(6, { shorts: 0.5, pants: 0.5 }).range, { shorts: [3, 3], pants: [3, 3] });
    assert.deepEqual(apportion(7, { shorts: 0.9, pants: 0.1 }).range, { shorts: [6, 6], pants: [1, 1] });
    assert.deepEqual(apportion(6, { shorts: 0.1, pants: 0.9 }).range, { shorts: [1, 1], pants: [5, 5] });
  });
});

describe("tools/clothing-simulate.mjs — the deploy check dad asked for", () => {
  test("simulate() reads the fixture like the worker: fancy and accessories never dealt, six to a page while jackets exist", () => {
    const run = simulate({ items: ITEMS, temps: [72], seed: SEED });
    assert.equal(run.perPage, 6, "the accessories door takes the seventh slot");
    assert.equal(run.cap, 18);
    const r = run.results[0];
    assert.deepEqual(Object.keys(r.want).sort(), ["legs", "top"]);
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
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /58 °F/);
      assert.match(r.stdout, /81 °F/);
      assert.match(r.stdout, /curve/);
      assert.match(r.stdout, /\[(sleeveless|short|long)/);
      assert.match(r.stdout, /PASS/);
      assert.doesNotMatch(r.stdout, /FAIL/);
      const s = spawnSync(process.execPath, [TOOL, "--wardrobe", f, "--temps", "81", "--strip-fit"], { encoding: "utf8" });
      assert.equal(s.status, 0, s.stdout + s.stderr);
      assert.match(s.stdout, /legacy/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  test("the deploy check's table: --temps 45-95 --table prints one row per °F, the curve's share beside the dealt share for every kind", () => {
    const r = spawnSync(process.execPath, [TOOL, "--wardrobe", FIXTURE, "--temps", "45-95", "--days", "7", "--seed", SEED, "--table"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /°F.*shorts-side.*long sleeve.*sleeveless.*short sleeve/);
    const rows = r.stdout.split("\n").filter(l => /^\s*\d+ │/.test(l));
    assert.equal(rows.length, 51, "45 through 95");
    // 70 °F: the curve's 50 % beside the deal's, and the verdicts' tally
    const at70 = rows.find(l => /^\s*70 │/.test(l));
    assert.match(at70, /50% +50%/, at70);
    assert.match(at70, /ok$/);
    assert.doesNotMatch(r.stdout, /\[(sleeveless|short|long)/, "--table leaves out the per-look listing");
    // a range and a list mix; a bad range is a usage error
    const bad = spawnSync(process.execPath, [TOOL, "--wardrobe", FIXTURE, "--temps", "95-45"], { encoding: "utf8" });
    assert.equal(bad.status, 2);
  });
  test("the CLI exits non-zero on a verdict that fails, and on a missing --wardrobe", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "era-clo-sim-"));
    try {
      // a wardrobe of nothing but long sleeves and long pants cannot dress
      // her for 95 °F: never-empty deals it anyway, and the verdict says FAIL
      const items = {};
      for (let i = 1; i <= 7; i++) items[`t${i}.jpg`] = { id: `item_t${i}`, ok: true, name: `top ${i}`, category: "top", coverage: "long", weight: "mid" };
      for (let i = 1; i <= 3; i++) items[`p${i}.jpg`] = { id: `item_p${i}`, ok: true, name: `pants ${i}`, category: "pants", coverage: "long", weight: "mid" };
      items["s1.jpg"] = { id: "item_s1", ok: true, name: "shorts 1", category: "shorts" };
      const f = path.join(tmp, "wardrobe.json");
      fs.writeFileSync(f, JSON.stringify({ items }));
      const r = spawnSync(process.execPath, [TOOL, "--wardrobe", f, "--temps", "95"], { encoding: "utf8" });
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout, /FAIL/);
      const u = spawnSync(process.execPath, [TOOL], { encoding: "utf8" });
      assert.equal(u.status, 2);
      assert.match(u.stderr, /--wardrobe/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
