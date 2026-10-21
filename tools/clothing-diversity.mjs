#!/usr/bin/env node
// Calendar-day simulation of page-one recurrence, including learned picks.
// No worker, server, AI requests or writes to the input wardrobe/history.
// node tools/clothing-diversity.mjs --wardrobe <wardrobe.json>
//   [--history <history.json>] [--pairing <pairing.json>] [--temp 88|offline]
//   [--days 42] [--step 1] [--seed YYYY-MM-DD] [--pick first]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadWardrobe } from "./clothing-simulate.mjs";

const require = createRequire(import.meta.url);
const R = require("../clothing-rank.js");
const plus = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const intersect = (a, b) => [...a].filter(k => b.has(k)).length;

// choose(looks, day) optionally supplies a simulated confirmed choice from
// ANY page; recording an offer alone is not evidence of a preference.
function simulateDiversity({ items, seed, days = 42, step = 1, temp = 74,
  history = {}, pairing, favorites, choose, perPage }) {
  if (!Number.isInteger(days) || days < 1 || !Number.isInteger(step) || step < 1)
    throw new TypeError("days and step must be positive integers");
  if (typeof seed !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(seed))
    throw new TypeError("seed must be a YYYY-MM-DD day key");
  if (!(temp === null || (typeof temp === "number" && Number.isFinite(temp))))
    throw new TypeError("temp must be a finite number or null");
  const usable = items.filter(i => i.ok !== false && i.hidden !== true);
  const per = perPage ?? (usable.some(i => R.isAccessory(i) ||
    String(i.occasion || "").trim().toLowerCase() === "fancy") ? 6 : 7);
  if (!Number.isInteger(per) || per < 1) throw new TypeError("perPage must be a positive integer");
  let memory = structuredClone(history);
  const lineups = [];
  for (let i = 0; i < days; i++) {
    const date = plus(seed, i * step);
    const looks = R.buildCandidates({ items: usable, seed: date, temp,
      perPage: per, cap: per * 3, history: memory, pairing, favorites });
    const page1 = looks.slice(0, per);
    lineups.push({ date, looks, page1 });
    memory = R.recordOffer(memory, date, looks, per, null);
    const pick = choose?.(looks, date);
    if (pick) {
      if (!looks.some(o => o.key === pick.key)) throw new Error("simulated pick was not offered");
      (memory.events[date] ||= []).push({ kind: "yes", combo: pick.pieces.map(p => p.id) });
    }
  }
  const byDate = new Map(lineups.map(d => [d.date, d]));
  const overlap = {};
  for (const lag of [1, 2, 3, 7, 14]) {
    const pairs = lineups.flatMap(d => {
      const prev = byDate.get(plus(d.date, -lag));
      return prev ? [[d, prev]] : [];
    });
    overlap[lag] = { comparisons: pairs.length,
      combos: mean(pairs.map(([a, b]) => intersect(new Set(a.page1.map(o => o.key)), new Set(b.page1.map(o => o.key))))),
      garments: mean(pairs.map(([a, b]) => intersect(new Set(a.page1.flatMap(o => o.pieces.map(p => p.id))), new Set(b.page1.flatMap(o => o.pieces.map(p => p.id)))))),
      samePosition: mean(pairs.map(([a, b]) => a.page1.filter((o, j) => o.key === b.page1[j]?.key).length)) };
  }
  const appearances = {};
  for (const d of lineups) for (const o of d.page1) (appearances[o.key] ||= []).push(d.date);
  const summary = { days, step, temp, perPage: per,
    uniqueCombos: Object.keys(appearances).length,
    uniqueOrderedPages: new Set(lineups.map(d => d.page1.map(o => o.key).join("|"))).size,
    meanPageSize: mean(lineups.map(d => d.page1.length)), overlap,
    // Sorted counts avoid printing garment ids/names from a private wardrobe.
    mostFrequent: Object.values(appearances).map(dates => dates.length).sort((a, b) => b - a).slice(0, 10) };
  return { summary, lineups, appearances, history: memory };
}

function main(argv) {
  const args = {};
  const allowed = new Set(["wardrobe", "history", "pairing", "temp", "days", "step", "seed", "pick"]);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || !allowed.has(key) || !argv[i + 1]) throw new Error("unknown or missing argument: " + argv[i]);
    args[key] = argv[++i];
  }
  if (!args.wardrobe) throw new Error("usage: clothing-diversity.mjs --wardrobe <wardrobe.json> [--history <history.json>] [--temp 88|offline] [--days 42] [--step 1] [--seed YYYY-MM-DD] [--pick first]");
  if (args.pick && args.pick !== "first") throw new Error("--pick accepts first");
  const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
  const run = simulateDiversity({ items: loadWardrobe(args.wardrobe),
    seed: args.seed || new Date().toISOString().slice(0, 10), days: Number(args.days || 42), step: Number(args.step || 1),
    temp: args.temp === "offline" ? null : Number(args.temp ?? 74),
    history: args.history ? read(args.history) : {}, pairing: args.pairing ? read(args.pairing) : undefined,
    choose: args.pick === "first" ? looks => looks[0] : undefined });
  console.log(JSON.stringify(run.summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 2; }
}
export { simulateDiversity };
