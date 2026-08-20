// /predict endpoint — the n-gram layer behind the Pencil's prediction slots.
// Runs against the live :8377 server like the other engine suites.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const q = async (left, prefix) => {
  const r = await fetch(`http://127.0.0.1:8377/predict?left=${encodeURIComponent(left)}&prefix=${encodeURIComponent(prefix)}&n=3`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.words));
  return j.words;
};

test("next-word: context yields words with no prefix typed", async () => {
  const w = await q("i like", "");
  assert.ok(w.length >= 1 && w.every(x => typeof x === "string" && x.length > 0), JSON.stringify(w));
});

test("completion: the exact typed word is offered ('be')", async () => {
  const w = await q("i like", "be");
  assert.ok(w.map(x => x.toLowerCase()).includes("be"), JSON.stringify(w));
});

test("personal lexicon surfaces with display case", async (t) => {
  // self-contained: this test builds its OWN lexicon fixture in a temp
  // ERA_DATA_DIR and drives the predictor module directly — it must never
  // depend on names living in the live/private data dir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "era-predict-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "personal-lexicon.json"),
    JSON.stringify(["Luna", "Milo", "mom", "dad"]));
  process.env.ERA_DATA_DIR = dir;
  const { predict, load } = createRequire(import.meta.url)("../predict.js");
  load();
  const w = predict("", "lu", 3);
  assert.ok(w.includes("Luna"), JSON.stringify(w));   // display case kept, not "luna"
});

test("sentence start offers starters, not junk", async () => {
  const w = await q("", "");
  assert.ok(w.length === 3, JSON.stringify(w));
});

test("gibberish prefix degrades to empty, never errors", async () => {
  const w = await q("", "zzqxv");
  assert.ok(w.length === 0, JSON.stringify(w));
});
