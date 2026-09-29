#!/usr/bin/env node
// clothing-simulate.mjs — deal a wardrobe across temperatures and judge every
// deal against what the board may offer at that temperature, in dad's words
// (spec docs/superpowers/specs/2026-09-29-warmth-coherence-and-dress-up.md §2
// D2). Dad, 9/29: "go through a process of simulating different weathers and
// make sure that they're coherent … some sort of testing for deploys."
//
//   node tools/clothing-simulate.mjs --wardrobe <path/to/wardrobe.json>
//        [--temps 45,58,65,72,79,85,95] [--seed YYYY-MM-DD] [--days N]
//        [--strip-fit]
//
// The wardrobe is a hub's clothing/wardrobe.json ({items: {file: entry}}) —
// copy the device's down over ssh and run this before a push — or the
// fixture tests/fixtures/wardrobe-shape.json. --strip-fit drops coverage /
// weight / legs first: the board a catalogue refit has not reached, judged by
// the weaker legacy set (§2). --days runs N consecutive days from --seed with
// the page-1 memory carried between them, as the tablet does; the one
// variety verdict (spec §2 †, "shorts and pants both present") is judged only
// from day 2, every coherence verdict on every day. Exit 0 when
// every verdict passes, 1 when one fails, 2 on a usage error.
//
// Pure engine, shared with tests/clothing-fit.test.mjs (the acceptance test):
// simulate() calls clothing-rank.js buildCandidates exactly as the worker's
// buildCataloged does — same door (ok, not hidden), same six-or-seven page,
// three pages — minus the tile check, which a copied wardrobe.json cannot make.
// It prints garment names; a real wardrobe's stay on the machine that runs it.
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
// Each piece through the same resolver the gate uses (fitAttrs), so the
// verdicts read what the deal read — the legacy fallback included.
const attrs = p => R.fitAttrs(p) || {};
const sleevesOf = p => { const a = attrs(p); return a.role === "top" || a.role === "single" ? a.coverage : null; };
const isTopHalf = p => sleevesOf(p) !== null;
const longSleeve = p => sleevesOf(p) === "long";
const shortSleeve = p => sleevesOf(p) === "short";
const sleeveless = p => sleevesOf(p) === "sleeveless";
// a long bottom: pants, or a single whose legs are covered
const longBottom = p => { const a = attrs(p); return (a.role === "bottom" && a.coverage === "long") || (a.role === "single" && a.legs === "covered"); };
const isShorts = p => { const a = attrs(p); return a.role === "bottom" && a.coverage === "short"; };
const isPants = p => { const a = attrs(p); return a.role === "bottom" && a.coverage === "long"; };
const bareSingle = p => { const a = attrs(p); return a.role === "single" && a.legs === "bare"; };
const heavier = p => longSleeve(p) && (attrs(p).weight === "mid" || attrs(p).weight === "heavy");
const lightLong = p => longSleeve(p) && attrs(p).weight === "light";
const isFancy = p => typeof p.occasion === "string" && p.occasion.trim().toLowerCase() === "fancy";
const word = p => (typeof p.warmth === "string" ? p.warmth.trim().toLowerCase() : p.warmth);

const pieces = looks => looks.flatMap(l => l.pieces);
const names = list => [...new Set(list.map(p => p.name || p.id))].join(", ");
const none = (list, pred, what) => {
  const bad = list.filter(pred);
  return { pass: bad.length === 0, detail: bad.length ? `${what}: ${names(bad)}` : "none" };
};
const countLooks = (looks, pred) => looks.filter(l => l.pieces.some(pred)).length;

// ---- the threshold table (spec §2 D2) — LAW; tune the model, never this ------
// mode "fit": the deal as refit leaves it. mode "legacy": the weaker set a
// catalogue with no coverage/weight/legs must still hold.
const THRESHOLDS = [
  { mode: "fit", rule: "any: at least one full page", applies: () => true,
    check: ({ looks, perPage }) => ({ pass: looks.length >= perPage, detail: `${looks.length} looks, page ${perPage}` }) },
  { mode: "fit", rule: "any: no fancy garment, ever", applies: () => true,
    check: ({ looks }) => none(pieces(looks), isFancy, "fancy") },
  { mode: "fit", rule: "≥ 86: no long-sleeve top; no long bottom", applies: t => t >= 86,
    check: ({ looks }) => {
      const a = none(pieces(looks), longSleeve, "long sleeve"), b = none(pieces(looks), longBottom, "long bottom");
      return { pass: a.pass && b.pass, detail: `${a.detail}; ${b.detail}` };
    } },
  { mode: "fit", rule: "≥ 78: no long-sleeve top", applies: t => t >= 78,
    check: ({ looks }) => none(pieces(looks), longSleeve, "long sleeve") },
  { mode: "fit", rule: "≥ 78: long bottoms ≤ 1 on page 1 and ≤ 3 in the deal", applies: t => t >= 78,
    check: ({ looks, perPage }) => {
      const p1 = countLooks(looks.slice(0, perPage), longBottom), all = countLooks(looks, longBottom);
      return { pass: p1 <= 1 && all <= 3, detail: `${p1} on page 1, ${all} in the deal` };
    } },
  { mode: "fit", rule: "72-77: no mid/heavy long sleeve", applies: t => t >= 72 && t <= 77,
    check: ({ looks }) => none(pieces(looks), heavier, "mid/heavy long sleeve") },
  // (†) a VARIETY verdict (spec §2, ruled 9/29): judged only on a day that
  // carries a memory. On a memoryless first day freshness is equal for every
  // look and the fit term legitimately sweeps one bottom kind (72 °F → all
  // leggings, 77 °F → all shorts); every real morning has a memory. Every
  // other row is a COHERENCE verdict and holds on day 1 too.
  { mode: "fit", rule: "72-77: shorts and pants both present", variety: true, applies: t => t >= 72 && t <= 77,
    check: ({ looks }) => {
      const s = countLooks(looks, isShorts), p = countLooks(looks, isPants);
      return { pass: s > 0 && p > 0, detail: `${s} shorts looks, ${p} pants looks` };
    } },
  { mode: "fit", rule: "62-71: no sleeveless top on page 1", applies: t => t >= 62 && t <= 71,
    check: ({ looks, perPage }) => none(pieces(looks.slice(0, perPage)), sleeveless, "sleeveless on page 1") },
  { mode: "fit", rule: "62-71: no heavy", applies: t => t >= 62 && t <= 71,
    check: ({ looks }) => none(pieces(looks), p => attrs(p).weight === "heavy", "heavy") },
  { mode: "fit", rule: "< 62: no shorts", applies: t => t < 62,
    check: ({ looks }) => none(pieces(looks), isShorts, "shorts") },
  { mode: "fit", rule: "< 62: no bare-legged single", applies: t => t < 62,
    check: ({ looks }) => none(pieces(looks), bareSingle, "bare-legged single") },
  { mode: "fit", rule: "< 62: no sleeveless top", applies: t => t < 62,
    check: ({ looks }) => none(pieces(looks), sleeveless, "sleeveless") },
  { mode: "fit", rule: "< 54: no short-sleeve top on page 1 (long sleeves lead)", applies: t => t < 54,
    check: ({ looks, perPage }) => none(pieces(looks.slice(0, perPage)), shortSleeve, "short sleeve on page 1") },
  // "mid/heavy before light": no light long sleeve takes a page-1 seat while a
  // mid/heavy one the deal holds waits for a later page.
  { mode: "fit", rule: "< 54: mid/heavy before light", applies: t => t < 54,
    check: ({ looks, perPage }) => {
      const p1 = pieces(looks.slice(0, perPage));
      const waiting = pieces(looks.slice(perPage)).filter(p => heavier(p) && !p1.includes(p));
      const light = p1.filter(lightLong);
      const bad = light.length && waiting.length;
      return { pass: !bad, detail: bad ? `light on page 1 (${names(light)}) while ${names(waiting)} wait` : "ok" };
    } },
  { mode: "legacy", rule: "legacy: never empty", applies: () => true,
    check: ({ looks }) => ({ pass: looks.length > 0, detail: `${looks.length} looks` }) },
  { mode: "legacy", rule: "legacy: no fancy", applies: () => true,
    check: ({ looks }) => none(pieces(looks), isFancy, "fancy") },
  { mode: "legacy", rule: "legacy ≥ 78: no cool/cold-tagged top", applies: t => t >= 78,
    check: ({ looks }) => none(pieces(looks), p => isTopHalf(p) && (word(p) === "cool" || word(p) === "cold" || word(p) === 2 || word(p) === 3), "cool/cold-tagged top") },
  { mode: "legacy", rule: "legacy < 54: no hot-tagged garment", applies: t => t < 54,
    check: ({ looks }) => none(pieces(looks), p => word(p) === "hot", "hot-tagged") },
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
//   {perPage, cap, mode, results: [{temp, admitted: {top, bottom, single},
//     looks, verdicts, days: [{seed, looks, verdicts}]}]}
// `looks` / `verdicts` are the first day's; `days` holds every day. Each look
// is {key, pieces, sleeves, legs}. Every temperature starts from an empty
// memory, so one temperature's deal never leans on another's.
function simulate({ items, temps, seed, days = 1, stripFit = false }) {
  if (typeof seed !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(seed)) throw new TypeError("simulate: seed must be a YYYY-MM-DD day key");
  const pool = (stripFit ? strip(items) : items).filter(i => i.hidden !== true);
  // the worker's `present`: an accessory kind with at least one dealt-from item
  const hasAccessory = pool.some(i => R.isAccessory(i));
  const perPage = hasAccessory ? PER_PAGE - 1 : PER_PAGE;
  const cap = perPage * PAGES;
  const mode = stripFit ? "legacy" : "fit";
  const rules = THRESHOLDS.filter(th => th.mode === mode);
  // what the door lets through, for the admitted counts (buildCandidates
  // applies the same door itself)
  const door = pool.filter(i => !R.isAccessory(i) && !isFancy(i));
  const results = [];
  for (const temp of temps) {
    const admitted = {};
    for (const role of ["top", "bottom", "single"]) admitted[role] = R.eligible(door, role, temp).length;
    let history = { days: {}, events: {} };
    const out = [];
    for (let d = 0; d < days; d++) {
      const day = plus(seed, d);
      // a memory = any page 1 recorded before this day (what freshness reads)
      const memory = Object.keys(history.days).some(k => k < day);
      const dealt = R.buildCandidates({ items: pool, temp, band: null, cap, seed: day, history, perPage });
      history = R.recordOffer(history, day, dealt, perPage, null);
      const looks = dealt.map(c => ({ key: c.key, pieces: c.pieces, ...wordsOf(c.pieces) }));
      const verdicts = rules.filter(th => th.applies(temp)).map(th => (th.variety && !memory
        ? { rule: th.rule, pass: true, skipped: true, detail: "not judged: a variety verdict on a day with no memory (spec §2 †)" }
        : { rule: th.rule, ...th.check({ temp, looks, perPage }) }));
      out.push({ seed: day, memory, looks, verdicts });
    }
    results.push({ temp, admitted, looks: out[0].looks, verdicts: out[0].verdicts, days: out });
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
function report(run, out = console.log) {
  let failed = 0;
  out(`mode: ${run.mode === "legacy" ? "legacy fallback (coverage/weight/legs stripped)" : "fit (coverage/weight/legs as catalogued)"} · ${run.perPage} a page, ${run.cap} looks`);
  for (const r of run.results) {
    out("");
    out(`== ${r.temp} °F — admitted top ${r.admitted.top} · bottom ${r.admitted.bottom} · single ${r.admitted.single} ==`);
    for (const d of r.days) {
      if (r.days.length > 1) out(`-- ${d.seed}`);
      d.looks.forEach((l, i) => {
        const page = Math.floor(i / run.perPage) + 1;
        out(`  p${page} ${String(i + 1).padStart(2)}  ${l.pieces.map(tag).join(" + ")}`);
      });
      for (const v of d.verdicts) {
        if (!v.pass) failed += 1;
        out(`  ${v.skipped ? "SKIP" : v.pass ? "PASS" : "FAIL"}  ${v.rule} — ${v.detail}`);
      }
    }
  }
  out("");
  out(failed ? `== ${failed} verdict(s) FAILED ==` : "== every verdict passed ==");
  return failed;
}

function main(argv) {
  const args = { temps: [45, 58, 65, 72, 79, 85, 95], seed: new Date().toISOString().slice(0, 10), days: 1, stripFit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wardrobe") args.wardrobe = argv[++i];
    else if (a === "--temps") args.temps = String(argv[++i]).split(",").map(Number);
    else if (a === "--seed") args.seed = argv[++i];
    else if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--strip-fit") args.stripFit = true;
    else { process.stderr.write(`unknown argument: ${a}\n`); return 2; }
  }
  if (!args.wardrobe) {
    process.stderr.write("usage: node tools/clothing-simulate.mjs --wardrobe <wardrobe.json> [--temps 45,58,65,72,79,85,95] [--seed YYYY-MM-DD] [--days N] [--strip-fit]\n");
    return 2;
  }
  if (args.temps.some(t => !Number.isFinite(t)) || !(args.days >= 1)) { process.stderr.write("--temps takes numbers, --days a count ≥ 1\n"); return 2; }
  const items = loadWardrobe(args.wardrobe);
  const run = simulate({ items, temps: args.temps, seed: args.seed, days: args.days, stripFit: args.stripFit });
  return report(run) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

export { simulate, loadWardrobe, itemsOf, THRESHOLDS, report };
