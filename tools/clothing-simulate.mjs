#!/usr/bin/env node
// clothing-simulate.mjs — deal a wardrobe across temperatures and judge every
// deal against dad's curve (spec docs/superpowers/specs/2026-09-29-warmth-
// coherence-and-dress-up.md §7). Dad, 9/29: "go through a process of
// simulating different weathers and make sure that they're coherent … some
// sort of testing for deploys" — and, that evening, "at 70 should be an even
// mix of shorts and pants … by 80 it should be 90% shorts, by 60 should be 90%
// pants, a spectrum … should handle every #."
//
//   node tools/clothing-simulate.mjs --wardrobe <path/to/wardrobe.json>
//        [--temps 45,58,65,72,79,85,95|45-95|offline] [--seed YYYY-MM-DD]
//        [--days N] [--strip-fit] [--table]
//
// The deploy check: `--temps 45-95 --days 7 --table` (and again with
// --strip-fit) prints one row per °F — the curve's share beside the dealt
// share for shorts-side, long sleeve, sleeveless and short sleeve, page 1's
// legs split, and the verdicts. Without --table every look is listed too.
//
// The wardrobe is a hub's clothing/wardrobe.json ({items: {file: entry}}) —
// copy the device's down over ssh and run this before a push — or the
// fixture tests/fixtures/wardrobe-shape.json. --strip-fit drops coverage /
// weight / legs first: the board a catalogue refit has not reached, which
// must hold the same curve through the legacy fallback (§7.3). --days runs N
// consecutive days from --seed with the page-1 memory carried between them,
// as the tablet does. Every verdict holds on every day. A verdict that passes
// only because her wardrobe runs a kind dry on one page says DRY and names it.
// Exit 0 when every verdict passes, 1 when one fails, 2 on a usage error.
//
// Pure engine, shared with tests/clothing-fit.test.mjs (the acceptance test):
// simulate() calls clothing-rank.js buildCandidates exactly as the worker's
// buildCataloged does — same door (ok, not hidden), same six-or-seven page,
// three pages — minus the tile check, which a copied wardrobe.json cannot make.
// The curve itself is written out below from the spec, not imported, so the
// module cannot grade its own homework. It prints garment names; a real
// wardrobe's stay on the machine that runs it.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const R = require(path.join(__dirname, "..", "clothing-rank.js"));

// clothing-worker.js SLOTS / todaySlots / PAGES: seven looks a page, six while
// she has accessories (the door takes the seventh cell), three pages a day.
const PER_PAGE = 7;
const PAGES = 3;

// ---- the words a deal is judged by ------------------------------------------
// Each piece through the same resolver the deal uses (fitAttrs), so the
// verdicts read what the deal read — the legacy fallback included.
const attrs = p => R.fitAttrs(p) || {};
const sleevesOf = p => { const a = attrs(p); return a.role === "top" || a.role === "single" ? a.coverage : null; };
const isTopHalf = p => sleevesOf(p) !== null;
const isFancy = p => typeof p.occasion === "string" && p.occasion.trim().toLowerCase() === "fancy";

// ---- dad's curve (spec §7.1) — written out HERE from the spec, never read off
// clothing-rank.js, so a wrong constant in the module cannot pass its own
// harness. Dad 9/29: "at 70 should be an even mix of shorts and pants … by 80
// it should be 90% shorts, by 60 should be 90% pants … should handle every #."
// K = 10 / ln 9 makes 10 °F from a crossover exactly 90 / 10. Legs cross at 70
// (dad), long sleeve at 63 and sleeveless at 80 (the 9/23 consensus chart).
// A kind under 5 % is zero for the day and the rest renormalise (dad 9/29, "go").
const K = 10 / Math.log(9);
const CROSS = { legs: 70, long: 63, sleeveless: 80 };
const FLOOR = 0.05;
const TOP_KINDS = ["sleeveless", "short", "long"];
const LEG_KINDS = ["shorts", "pants"];
const DIMS = { top: TOP_KINDS, legs: LEG_KINDS };
const sigma = x => 1 / (1 + Math.exp(-x));
function curve(t) {
  const shorts = sigma((t - CROSS.legs) / K);
  const sleeveless = sigma((t - CROSS.sleeveless) / K);
  const long = 1 - sigma((t - CROSS.long) / K);
  return { legs: { shorts, pants: 1 - shorts }, top: { sleeveless, short: Math.max(0, 1 - sleeveless - long), long } };
}

// A look's cell (spec §7.2): its top half's coverage and its legs side. A pair
// is its top's sleeves over its bottom (short → shorts-side); a single is its
// own top half and its legs (bare → shorts-side, covered → pants-side).
function cellOf(look) {
  const ps = look.pieces || look;
  if (ps.length === 1) {
    const a = attrs(ps[0]);
    return { top: a.coverage, legs: a.legs === "covered" ? "pants" : "shorts" };
  }
  const up = ps.find(p => attrs(p).role === "top"), down = ps.find(p => attrs(p).role === "bottom");
  return { top: up ? attrs(up).coverage : null, legs: down && attrs(down).coverage === "short" ? "shorts" : "pants" };
}

// What the wardrobe (past the door) can put in each kind: garments per kind,
// for the "present" set and for the one-page capacity a dry verdict cites.
function stock(door) {
  const tops = { sleeveless: 0, short: 0, long: 0 }, bottoms = { shorts: 0, pants: 0 };
  const singles = {};
  for (const i of door) {
    const a = R.fitAttrs(i);
    if (!a) continue;
    if (a.role === "top") tops[a.coverage] += 1;
    else if (a.role === "bottom") bottoms[a.coverage === "short" ? "shorts" : "pants"] += 1;
    else { const k = a.coverage + "|" + (a.legs === "covered" ? "pants" : "shorts"); singles[k] = (singles[k] || 0) + 1; }
  }
  const single = (top, legs) => singles[top + "|" + legs] || 0;
  const anyBottom = bottoms.shorts + bottoms.pants > 0, anyTop = tops.sleeveless + tops.short + tops.long > 0;
  const present = {
    top: new Set(TOP_KINDS.filter(k => (tops[k] && anyBottom) || LEG_KINDS.some(l => single(k, l)))),
    legs: new Set(LEG_KINDS.filter(l => (bottoms[l] && anyTop) || TOP_KINDS.some(k => single(k, l)))),
  };
  return { tops, bottoms, single, present };
}

// The day's shares: the curve, the 5 % floor, renormalised over the kinds the
// wardrobe holds at all. Never empty (spec §7.2): a dimension the floor would
// empty keeps its raw shares.
function wantAt(t, st) {
  const raw = curve(t), out = {};
  for (const [dim, kinds] of Object.entries(DIMS)) {
    const pick = floor => {
      const v = {};
      let sum = 0;
      for (const k of kinds) { v[k] = st.present[dim].has(k) && raw[dim][k] >= floor ? raw[dim][k] : 0; sum += v[k]; }
      if (sum > 0) for (const k of kinds) v[k] /= sum;
      return sum > 0 ? v : null;
    };
    out[dim] = pick(FLOOR) || pick(0) || Object.fromEntries(kinds.map(k => [k, 0]));
  }
  return out;
}

// Largest remainder of n slots over shares → per kind the count it must get,
// as a range: [n, n] normally, [floor, floor + 1] for a kind whose remainder
// ties the boundary (the module breaks that tie by the seed hash; either side
// is the apportionment).
const EPS = 1e-9;
function apportion(n, shares) {
  const kinds = Object.keys(shares);
  const exact = Object.fromEntries(kinds.map(k => [k, n * shares[k]]));
  const base = Object.fromEntries(kinds.map(k => [k, Math.floor(exact[k] + EPS)]));
  const left = n - kinds.reduce((a, k) => a + base[k], 0);
  const rem = k => exact[k] - base[k];
  const sorted = [...kinds].sort((a, b) => rem(b) - rem(a));
  const range = Object.fromEntries(kinds.map(k => [k, [base[k], base[k]]]));
  if (left > 0) {
    const cut = rem(sorted[left - 1]), next = left < sorted.length ? rem(sorted[left]) : -1;
    const tie = Math.abs(cut - next) < EPS;
    for (const k of kinds) {
      if (rem(k) > cut + EPS || (!tie && rem(k) >= cut - EPS)) range[k] = [base[k] + 1, base[k] + 1];
      else if (tie && Math.abs(rem(k) - cut) < EPS) range[k] = [base[k], base[k] + 1];
    }
  }
  return { exact, range };
}

const countBy = (looks, dim) => {
  const c = Object.fromEntries(DIMS[dim].map(k => [k, 0]));
  for (const l of looks) { const k = cellOf(l)[dim]; if (k in c) c[k] += 1; }
  return c;
};
const fmt = c => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(" · ");
const pct = x => `${Math.round(x * 100)}%`;

// How many looks of `kind` one page can hold at most — garment-distinct, from
// the kinds the other dimension allows today. Harmony is ignored, so this
// over-states rather than under-states: a dry verdict it grants is real.
function capacity(st, want, dim, kind) {
  const topOk = TOP_KINDS.filter(k => want.top[k] > 0), legOk = LEG_KINDS.filter(l => want.legs[l] > 0);
  if (dim === "top") {
    const pairs = legOk.some(l => st.bottoms[l] > 0) ? st.tops[kind] : 0;
    return pairs + legOk.reduce((a, l) => a + st.single(kind, l), 0);
  }
  const tops = topOk.reduce((a, k) => a + st.tops[k], 0);
  return Math.min(st.bottoms[kind], tops) + topOk.reduce((a, k) => a + st.single(k, kind), 0);
}

// Page 1's counts per kind of one dimension against the apportionment (spec
// §7.3): exact, or ±1 only where her wardrobe runs a kind dry on one page —
// and then the verdict names the dry kind rather than hide it.
function page1Verdict(dim, { looks, perPage, want, st }) {
  const p1 = looks.slice(0, perPage);
  const got = countBy(p1, dim);
  const { range } = apportion(perPage, want[dim]);
  const off = DIMS[dim].filter(k => got[k] < range[k][0] || got[k] > range[k][1]);
  const expect = DIMS[dim].map(k => `${k} ${range[k][0] === range[k][1] ? range[k][0] : range[k].join("-")}`).join(" · ");
  if (!off.length) return { pass: true, detail: `${fmt(got)} (apportioned ${expect})` };
  const dry = DIMS[dim].filter(k => got[k] < range[k][0] && capacity(st, want, dim, k) <= got[k]);
  const byOne = off.every(k => got[k] >= range[k][0] - 1 && got[k] <= range[k][1] + 1);
  if (byOne && dry.length) {
    const cells = dry.map(k => `${dim} ${k} (one page holds ${capacity(st, want, dim, k)})`).join(", ");
    return { pass: true, dry: dry.map(k => `${dim}:${k}`), detail: `${fmt(got)} (apportioned ${expect}) — DRY: ${cells}` };
  }
  return { pass: false, detail: `${fmt(got)}, apportioned ${expect}${dry.length ? "" : " — no kind is dry, the wardrobe could have"}` };
}
// The whole deal, each dimension within ±10 points of the curve (spec §7.3).
const DEAL_TOLERANCE = 0.10;
function dealVerdict(dim, { looks, want }) {
  const got = countBy(looks, dim), n = looks.length || 1;
  const bad = DIMS[dim].filter(k => Math.abs(got[k] / n - want[dim][k]) > DEAL_TOLERANCE + EPS);
  const detail = DIMS[dim].map(k => `${k} ${pct(got[k] / n)} (curve ${pct(want[dim][k])})`).join(" · ");
  return { pass: bad.length === 0, detail: bad.length ? `off by more than 10 points: ${bad.join(", ")} — ${detail}` : detail };
}
const noneOf = (looks, pred, what) => {
  const bad = looks.filter(pred);
  return { pass: bad.length === 0, detail: bad.length ? `${bad.length} ${what}: ${bad.map(l => l.key).join(", ")}` : "none" };
};

// ---- the verdicts (spec §7.3) — LAW; tune the curve's constants, never these.
// Every one holds on every day, in both modes (refit's words and the legacy
// fallback). `temp` null (weather offline) is judged by the always-rules only:
// it is the port's deal, pinned by the harness against a golden.
const VERDICTS = [
  { rule: "never empty: at least one full page", applies: () => true,
    check: ({ looks, perPage }) => ({ pass: looks.length >= perPage, detail: `${looks.length} looks, page ${perPage}` }) },
  { rule: "never fancy, hidden or an accessory", applies: () => true,
    check: ({ looks }) => noneOf(looks, l => l.pieces.some(p => isFancy(p) || p.hidden === true || R.isAccessory(p)), "looks") },
  { rule: "page 1 = the apportionment: legs", applies: t => t != null, check: ctx => page1Verdict("legs", ctx) },
  { rule: "page 1 = the apportionment: top half", applies: t => t != null, check: ctx => page1Verdict("top", ctx) },
  { rule: "the deal within ±10 points of the curve: legs", applies: t => t != null, check: ctx => dealVerdict("legs", ctx) },
  { rule: "the deal within ±10 points of the curve: top half", applies: t => t != null, check: ctx => dealVerdict("top", ctx) },
  { rule: "≥ 78: no long sleeve (the 5% floor)", applies: t => t != null && t >= 78,
    check: ({ looks }) => noneOf(looks, l => cellOf(l).top === "long", "long-sleeve looks") },
  { rule: "≤ 54: no shorts-side look (the 5% floor)", applies: t => t != null && t <= 54,
    check: ({ looks }) => noneOf(looks, l => cellOf(l).legs === "shorts", "shorts-side looks") },
];

// ---- input ------------------------------------------------------------------
// A hub wardrobe.json ({items: {file: entry}}), the same with an array, or a
// bare array. Only what the worker would deal from: `ok` entries (a failed
// ingest is never drawn), each carrying its id.
function itemsOf(doc) {
  const raw = Array.isArray(doc) ? doc : doc && doc.items ? (Array.isArray(doc.items) ? doc.items : Object.values(doc.items)) : [];
  return raw.filter(i => i && typeof i === "object" && i.ok && i.id);
}
function loadWardrobe(file) {
  return itemsOf(JSON.parse(fs.readFileSync(file, "utf8")));
}
const STRIP = ["coverage", "weight", "legs"];
const strip = items => items.map(i => { const c = { ...i }; for (const k of STRIP) delete c[k]; return c; });

const plus = (key, n) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

// simulate({items, temps, seed, days = 1, stripFit}) →
//   {perPage, cap, mode, results: [{temp, want, looks, verdicts,
//     days: [{seed, memory, looks, verdicts, page1, deal}]}]}
// `want` is the curve's share per kind after the floor ({top, legs}, null when
// the weather is offline); `page1` / `deal` count the dealt looks per kind.
// `looks` / `verdicts` are the first day's; `days` holds every day. Each look
// is {key, pieces, sleeves, legs, cell}. Every temperature starts from an
// empty memory, so one temperature's deal never leans on another's.
function simulate({ items, temps, seed, days = 1, stripFit = false }) {
  if (typeof seed !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(seed)) throw new TypeError("simulate: seed must be a YYYY-MM-DD day key");
  const pool = (stripFit ? strip(items) : items).filter(i => i.hidden !== true);
  // the worker's `present`: an accessory kind with at least one dealt-from item
  const hasAccessory = pool.some(i => R.isAccessory(i));
  const perPage = hasAccessory ? PER_PAGE - 1 : PER_PAGE;
  const cap = perPage * PAGES;
  const mode = stripFit ? "legacy" : "fit";
  // what the door lets through (buildCandidates applies the same door itself)
  const door = pool.filter(i => !R.isAccessory(i) && !isFancy(i));
  const st = stock(door);
  const results = [];
  for (const temp of temps) {
    const want = temp == null ? null : wantAt(temp, st);
    let history = { days: {}, events: {} };
    const out = [];
    for (let d = 0; d < days; d++) {
      const day = plus(seed, d);
      // a memory = any page 1 recorded before this day (what freshness reads)
      const memory = Object.keys(history.days).some(k => k < day);
      const dealt = R.buildCandidates({ items: pool, temp, band: null, cap, seed: day, history, perPage });
      history = R.recordOffer(history, day, dealt, perPage, null);
      const looks = dealt.map(c => ({ key: c.key, pieces: c.pieces, ...wordsOf(c.pieces), cell: cellOf(c) }));
      const verdicts = VERDICTS.filter(v => v.applies(temp)).map(v => ({ rule: v.rule, ...v.check({ temp, looks, perPage, want, st }) }));
      const page1 = { top: countBy(looks.slice(0, perPage), "top"), legs: countBy(looks.slice(0, perPage), "legs") };
      const deal = { top: countBy(looks, "top"), legs: countBy(looks, "legs") };
      out.push({ seed: day, memory, looks, verdicts, page1, deal });
    }
    results.push({ temp, want, looks: out[0].looks, verdicts: out[0].verdicts, days: out });
  }
  return { perPage, cap, mode, results };
}
// A look's sleeve and leg words: the top half's coverage, and the bottom's
// (short | long) or the single's legs (bare | covered).
function wordsOf(ps) {
  const up = ps.find(isTopHalf);
  const down = ps.find(p => attrs(p).role === "bottom") || ps.find(p => attrs(p).role === "single");
  const a = down ? attrs(down) : {};
  return { sleeves: up ? sleevesOf(up) : "", legs: a.role === "single" ? a.legs : a.coverage || "" };
}

// ---- the CLI ------------------------------------------------------------------
function tag(p) {
  const a = attrs(p);
  const w = (a.role === "top" || a.role === "single") && a.coverage === "long" ? "/" + a.weight
    : a.role === "bottom" && a.coverage === "long" ? "/" + a.weight : "";
  const legs = a.role === "single" ? ", legs " + a.legs : "";
  return `${p.name || p.id} [${a.coverage}${w}${legs}]`;
}
// The deploy check's table (spec §7.3): one row per °F, for every kind the
// curve's share (after the 5 % floor, over the kinds the wardrobe holds)
// beside the share the board dealt — the whole deal, averaged over the days
// run — then page 1's legs split and the verdicts' tally. A DRY row names the
// kind her wardrobe could not fill; a FAIL row is a push to stop.
const COLUMNS = [["legs", "shorts", "shorts-side"], ["top", "long", "long sleeve"], ["top", "sleeveless", "sleeveless"], ["top", "short", "short sleeve"]];
function table(run, out = console.log) {
  const cell = (a, b) => `${pct(a).padStart(4)} ${pct(b).padStart(5)}`;
  out(`  °F │ ${COLUMNS.map(c => c[2].padEnd(12)).join(" │ ")} │ page 1  │ verdicts`);
  out(`     │ ${COLUMNS.map(() => "curve dealt ").join(" │ ")} │ sh/pa   │`);
  for (const r of run.results) {
    if (r.temp == null) { out(`  offline — the port's deal, no curve`); continue; }
    const looks = r.days.reduce((a, d) => a + d.looks.length, 0) || 1;
    const dealt = (dim, k) => r.days.reduce((a, d) => a + d.deal[dim][k], 0) / looks;
    const p1 = r.days.map(d => `${d.page1.legs.shorts}/${d.page1.legs.pants}`);
    const splits = [...new Set(p1)].join(",");
    const vs = r.days.flatMap(d => d.verdicts);
    const fails = vs.filter(v => !v.pass).length, dry = [...new Set(vs.filter(v => v.dry).flatMap(v => v.dry))];
    const tally = fails ? `FAIL ${fails}` : dry.length ? `DRY ${dry.join(",")}` : "ok";
    out(`${String(r.temp).padStart(4)} │ ${COLUMNS.map(([dim, k]) => cell(r.want[dim][k], dealt(dim, k)).padEnd(12)).join(" │ ")} │ ${splits.padEnd(7)} │ ${tally}`);
  }
}
function report(run, out = console.log, { tableOnly = false } = {}) {
  let failed = 0;
  out(`mode: ${run.mode === "legacy" ? "legacy fallback (coverage/weight/legs stripped)" : "fit (coverage/weight/legs as catalogued)"} · ${run.perPage} a page, ${run.cap} looks · ${run.results[0] ? run.results[0].days.length : 0} day(s)`);
  for (const r of run.results) {
    for (const d of r.days) for (const v of d.verdicts) if (!v.pass) failed += 1;
    if (tableOnly) continue;
    out("");
    out(`== ${r.temp} °F${r.want ? ` — curve: top ${fmt(Object.fromEntries(TOP_KINDS.map(k => [k, pct(r.want.top[k])])))} · legs ${fmt(Object.fromEntries(LEG_KINDS.map(k => [k, pct(r.want.legs[k])])))}` : " — weather offline: the port's deal"} ==`);
    for (const d of r.days) {
      if (r.days.length > 1) out(`-- ${d.seed}`);
      d.looks.forEach((l, i) => {
        const page = Math.floor(i / run.perPage) + 1;
        out(`  p${page} ${String(i + 1).padStart(2)}  ${l.pieces.map(tag).join(" + ")}`);
      });
      for (const v of d.verdicts) out(`  ${v.pass ? (v.dry ? "DRY " : "PASS") : "FAIL"}  ${v.rule} — ${v.detail}`);
    }
  }
  out("");
  table(run, out);
  out("");
  out(failed ? `== ${failed} verdict(s) FAILED ==` : "== every verdict passed ==");
  return failed;
}

function main(argv) {
  const args = { temps: [45, 58, 65, 72, 79, 85, 95], seed: new Date().toISOString().slice(0, 10), days: 1, stripFit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wardrobe") args.wardrobe = argv[++i];
    else if (a === "--temps") args.temps = temps(String(argv[++i]));
    else if (a === "--table") args.table = true;
    else if (a === "--seed") args.seed = argv[++i];
    else if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--strip-fit") args.stripFit = true;
    else { process.stderr.write(`unknown argument: ${a}\n`); return 2; }
  }
  if (!args.wardrobe) {
    process.stderr.write("usage: node tools/clothing-simulate.mjs --wardrobe <wardrobe.json> [--temps 45,58,65,72,79,85,95|45-95|offline] [--seed YYYY-MM-DD] [--days N] [--strip-fit] [--table]\n");
    return 2;
  }
  if (!args.temps || args.temps.some(t => t !== null && !Number.isFinite(t)) || !(args.days >= 1)) { process.stderr.write("--temps takes numbers, rising ranges (45-95) or offline; --days a count ≥ 1\n"); return 2; }
  const items = loadWardrobe(args.wardrobe);
  const run = simulate({ items, temps: args.temps, seed: args.seed, days: args.days, stripFit: args.stripFit });
  return report(run, console.log, { tableOnly: args.table }) ? 1 : 0;
}
// "45,58,72" · "45-95" (every integer °F, rising) · "offline" · any mix; null
// for a range that runs downhill, so a typo is a usage error, not an empty run.
function temps(spec) {
  const out = [];
  for (const part of spec.split(",")) {
    const m = /^(\d+)-(\d+)$/.exec(part.trim());
    if (m) {
      const [lo, hi] = [Number(m[1]), Number(m[2])];
      if (hi < lo) return null;
      for (let t = lo; t <= hi; t++) out.push(t);
    } else out.push(part.trim() === "offline" ? null : Number(part));
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

export { simulate, loadWardrobe, itemsOf, VERDICTS, report, table, curve, wantAt, stock, apportion, cellOf, K, CROSS, FLOOR };
