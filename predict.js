/*
 * predict.js — the studio word predictor behind GET /predict.
 *
 * Three layers, strongest first:
 *   1. HER OWN WRITING — every word she has ever committed in the Pencil (logs/)
 *      builds a personal unigram/bigram layer that outranks everything.
 *   2. personal-lexicon.json — her people/places/things (display case preserved:
 *      "Luna", not "luna").
 *   3. predict-model.json — bigrams over ~8k words of public-domain children's
 *      classics (built by tools/build-predict-model.mjs; committed, no runtime deps).
 *
 * The server does LITERAL matching only. Phonetic tolerance for invented spelling
 * (kidKey: "kat"->cat, "frend"->friend) stays in pencil.js on the client, which
 * merges these results with its own — and works alone if this endpoint is down.
 * Method law still applies downstream: predictions are offered, never applied.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const MODEL_PATH = path.join(__dirname, "predict-model.json");
const DATA = process.env.ERA_DATA_DIR || path.join(__dirname, "data");
const LEX_PATH = path.join(DATA, "personal-lexicon.json");
const LOGS = path.join(DATA, "logs");

let model = null;                 // corpus n-grams
let vocabMax = 1;
let personal = [];                // display forms
let personalSet = new Set();      // lowercase
let her = { uni: new Map(), bi: new Map() };

function load() {
  try { model = JSON.parse(fs.readFileSync(MODEL_PATH, "utf8")); }
  catch { model = { vocab: {}, bi: {}, start: [] }; }
  vocabMax = Math.max(1, ...Object.values(model.vocab).slice(0, 50));
  try { personal = JSON.parse(fs.readFileSync(LEX_PATH, "utf8")); } catch { personal = []; }
  personalSet = new Set(personal.map(w => w.toLowerCase()));
  learnFromLogs();
  // her layer refreshes itself — new writing shows up within the hour
  setInterval(learnFromLogs, 60 * 60 * 1000).unref();
}

function learnFromLogs() {
  const uni = new Map(), bi = new Map();
  const last = new Map();                       // session -> previous word
  let files = [];
  try { files = fs.readdirSync(LOGS).filter(f => f.endsWith(".jsonl")).sort(); } catch {}
  for (const f of files) {
    let lines;
    try { lines = fs.readFileSync(path.join(LOGS, f), "utf8").split("\n"); } catch { continue; }
    for (const line of lines) {
      if (!line.includes('"pencil"') || !line.includes('"word"')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.app !== "pencil" || e.event !== "word" || typeof e.word !== "string") continue;
      const w = e.word.toLowerCase();
      if (!/^[a-z]+(?:'[a-z]+)?$/.test(w) || w.length > 14) continue;
      uni.set(w, (uni.get(w) || 0) + 1);
      const prev = last.get(e.session);
      if (prev) bi.set(prev + " " + w, (bi.get(prev + " " + w) || 0) + 1);
      last.set(e.session, w);
    }
  }
  her = { uni, bi };
}

function display(w) {
  if (w === "i" || w.startsWith("i'")) return "I" + w.slice(1);
  for (const p of personal) if (p.toLowerCase() === w) return p;
  return w;
}

/** Top-n display words for (left text, current-word prefix). */
function predict(left, prefix, n) {
  if (!model) load();
  const ctx = ((left || "").toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || []).pop() || "";
  prefix = (prefix || "").toLowerCase();
  const cand = new Map();
  const add = (w, s) => cand.set(w, (cand.get(w) || 0) + s);

  // context: her bigrams dominate, corpus bigrams follow (scaled within the row)
  if (ctx) {
    const row = model.bi[ctx] || [];
    const rowMax = row.length ? row[0][1] : 1;
    for (const [w, c] of row) add(w, 100 * c / rowMax);
    for (const [k, c] of her.bi) {
      if (k.startsWith(ctx + " ")) add(k.slice(ctx.length + 1), 300 * Math.min(c, 5));
    }
  } else if (!prefix && model.start.length) {
    const sMax = model.start[0][1];
    for (const [w, c] of model.start.slice(0, 15)) add(w, 100 * c / sMax);
  }

  if (prefix) {
    // literal completion: context candidates keep their scores; pool widens to
    // vocabulary + her lexicon + her own words, weighted personal-first
    for (const w of [...cand.keys()]) if (!w.startsWith(prefix)) cand.delete(w);
    for (const [w, c] of Object.entries(model.vocab)) {
      if (w.startsWith(prefix)) add(w, 30 * Math.min(c, vocabMax) / vocabMax + 1);
    }
    for (const p of personalSet) if (p.startsWith(prefix)) add(p, 40);
    for (const [w, c] of her.uni) if (w.startsWith(prefix)) add(w, 20 + 60 * Math.min(c, 5) / 5);
    // the exact word she has typed is always a legitimate word to commit —
    // it must never lose a photo-finish to a fuzzier neighbor
    if (cand.has(prefix)) add(prefix, 60);
  }
  for (const w of cand.keys()) if (personalSet.has(w)) add(w, 15);

  return [...cand.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => display(w));
}

module.exports = { predict, load, learnFromLogs };
