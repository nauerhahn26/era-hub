// clothing-composite.test.mjs — the outfit composite cache (outfit-cache.js),
// on its own.
//
// Every board build drew every dealt look again, and nearly all of them were
// the same picture as last time. The cache draws a look once per CONTENT (the
// bytes of its tiles plus the layout) and copies it after that. What must
// hold, because each is a way to show her the wrong picture or none:
//
//   * a changed tile is a new picture, never a stale hit;
//   * the store is never fed from an outfit_<i>.jpg (the build overwrites those
//     in place, and looks swap places from one build to the next);
//   * a broken cache — torn index, missing or empty stored file, a store that
//     cannot be written — draws the look as before, never leaves it missing;
//   * plain files only (no hardlinks), and a bounded store.
//
// Pure: temp dirs, no ports, no hub, no worker. The draw is a stand-in that
// writes a real JPEG from the tiles' bytes and counts its calls; the real
// drawing through the worker is pinned in clothing.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const { openCompositeCache, compositeKey, INDEX, STORE } = require("./outfit-cache.js");
const { encodeJpg } = require("./image-util.js");
const crypto = require("crypto");

const LAYOUT = "test-layout/1";

function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "era-composite-"));
  const items = path.join(root, "items"), outfits = path.join(root, "outfits");
  fs.mkdirSync(items); fs.mkdirSync(outfits);
  return { root, items, outfits };
}

// A tile is any bytes; its colour stands in for its content.
function tile(dir, name, r, g, b) {
  const w = 16, h = 16, data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  const f = path.join(dir, name + ".jpg");
  fs.writeFileSync(f, encodeJpg({ data, width: w, height: h }, 85));
  return f;
}

// A deterministic draw: a 24x16 JPEG whose colour is derived from both tiles.
let draws = 0;
function draw(bufA, bufB, file) {
  draws++;
  const d = crypto.createHash("sha256").update(bufA).update(bufB || "solo").digest();
  const w = 24, h = 16, data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = d[0]; data[i * 4 + 1] = d[1]; data[i * 4 + 2] = d[2]; data[i * 4 + 3] = 255; }
  fs.writeFileSync(file, encodeJpg({ data, width: w, height: h }, 88));
}
// What the look's bytes would be with no cache at all.
function uncached(fileA, fileB) {
  const f = path.join(os.tmpdir(), "era-composite-ref-" + process.pid + ".jpg");
  const before = draws;
  draw(fs.readFileSync(fileA), fileB ? fs.readFileSync(fileB) : null, f);
  draws = before;
  const b = fs.readFileSync(f); fs.unlinkSync(f);
  return b;
}

// One build: looks = [[fileA, fileB|null], ...] -> outfit_<i>.jpg
function build(outfits, looks, opts = {}) {
  const cache = openCompositeCache(outfits, { layout: LAYOUT, ...opts });
  const how = looks.map(([a, b], i) => cache.produce(a, b, path.join(outfits, "outfit_" + i + ".jpg"), draw));
  return { how, ...cache.finish() };
}
const out = (outfits, i) => fs.readFileSync(path.join(outfits, "outfit_" + i + ".jpg"));
const stored = (outfits) => fs.readdirSync(path.join(outfits, STORE)).filter(n => n.endsWith(".jpg")).sort();

test("the same tiles twice: the second build reuses every look, bytes identical", () => {
  const { items, outfits } = fresh();
  const top = tile(items, "t1", 200, 30, 30), pants = tile(items, "p1", 30, 30, 200), dress = tile(items, "d1", 240, 220, 20);
  const looks = [[top, pants], [dress, null]];
  draws = 0;
  const first = build(outfits, looks);
  assert.deepEqual(first.how, ["drawn", "drawn"]);
  assert.deepEqual([first.drawn, first.reused], [2, 0]);
  assert.equal(draws, 2);
  const bytes = [out(outfits, 0), out(outfits, 1)];
  const second = build(outfits, looks);
  assert.deepEqual(second.how, ["reused", "reused"]);
  assert.deepEqual([second.drawn, second.reused], [0, 2]);
  assert.equal(draws, 2, "nothing was drawn again");
  assert.ok(out(outfits, 0).equals(bytes[0]));
  assert.ok(out(outfits, 1).equals(bytes[1]));
});

test("a tile whose bytes change is drawn again, never a stale hit", () => {
  const { items, outfits } = fresh();
  const top = tile(items, "t1", 200, 30, 30), pants = tile(items, "p1", 30, 30, 200);
  build(outfits, [[top, pants]]);
  const before = out(outfits, 0);
  tile(items, "t1", 30, 200, 30);          // re-ingested: same id, new picture
  draws = 0;
  const r = build(outfits, [[top, pants]]);
  assert.deepEqual(r.how, ["drawn"]);
  assert.equal(draws, 1);
  assert.ok(!out(outfits, 0).equals(before));
  assert.ok(out(outfits, 0).equals(uncached(top, pants)));
});

test("the key reads the layout, both tiles and which one is which", () => {
  const a = Buffer.from("tile a"), b = Buffer.from("tile b");
  const k = compositeKey(LAYOUT, a, b);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(compositeKey(LAYOUT, a, b), k);
  assert.notEqual(compositeKey("other-layout/1", a, b), k);
  assert.notEqual(compositeKey(LAYOUT, b, a), k);
  assert.notEqual(compositeKey(LAYOUT, a, null), k);
  assert.notEqual(compositeKey(LAYOUT, a, Buffer.from("tile c")), k);
});

test("the same pair at another index is reused; swapped looks never read an outfit file", () => {
  const { items, outfits } = fresh();
  const t1 = tile(items, "t1", 200, 30, 30), p1 = tile(items, "p1", 30, 30, 200);
  const t2 = tile(items, "t2", 20, 160, 60), p2 = tile(items, "p2", 90, 90, 90);
  build(outfits, [[t1, p1], [t2, p2]]);
  const A = uncached(t1, p1), B = uncached(t2, p2);
  draws = 0;
  // the day's order flips: new outfit_0 is old outfit_1 and the other way round
  const r = build(outfits, [[t2, p2], [t1, p1], [t2, p2]]);
  assert.deepEqual(r.how, ["reused", "reused", "reused"]);
  assert.equal(draws, 0);
  assert.ok(out(outfits, 0).equals(B));
  assert.ok(out(outfits, 1).equals(A));
  assert.ok(out(outfits, 2).equals(B));
  // the index and the store name only content keys, never an outfit file
  const idx = fs.readFileSync(path.join(outfits, INDEX), "utf8");
  assert.doesNotMatch(idx, /outfit_/);
  for (const n of stored(outfits)) assert.match(n, /^[0-9a-f]{64}\.jpg$/);
});

test("prune keeps this build's and the previous build's looks, drops older ones", () => {
  const { items, outfits } = fresh();
  const k = (look) => compositeKey(LAYOUT, fs.readFileSync(look[0]), look[1] ? fs.readFileSync(look[1]) : null) + ".jpg";
  const g1 = [tile(items, "a", 250, 0, 0), null];
  const g2 = [tile(items, "b", 0, 250, 0), null];
  const g3 = [tile(items, "c", 0, 0, 250), null];
  build(outfits, [g1]);
  build(outfits, [g2]);
  assert.deepEqual(stored(outfits), [k(g1), k(g2)].sort());
  build(outfits, [g3]);
  assert.deepEqual(stored(outfits), [k(g2), k(g3)].sort(), "the build before last is gone");
  // the same set again (a re-sort, a restart) is not a new generation:
  // yesterday's look survives two same-day builds
  build(outfits, [g3]);
  build(outfits, [g3]);
  assert.deepEqual(stored(outfits), [k(g2), k(g3)].sort());
  // ...so flipping back to it is a hit
  draws = 0;
  assert.deepEqual(build(outfits, [g2]).how, ["reused"]);
  assert.equal(draws, 0);
});

test("the hard cap holds, this build's looks first", () => {
  const { items, outfits } = fresh();
  const many = Array.from({ length: 6 }, (_, i) => [tile(items, "x" + i, 40 * i, 10, 10), null]);
  const r = build(outfits, many, { cap: 4 });
  assert.equal(r.drawn, 6);
  assert.equal(stored(outfits).length, 4);
  const next = Array.from({ length: 3 }, (_, i) => [tile(items, "y" + i, 10, 40 * i, 200), null]);
  build(outfits, next, { cap: 4 });
  const keys = new Set(stored(outfits));
  assert.equal(keys.size, 4);
  for (const [a] of next) assert.ok(keys.has(compositeKey(LAYOUT, fs.readFileSync(a), null) + ".jpg"));
  // every look of both builds was still written
  for (let i = 0; i < 3; i++) assert.ok(out(outfits, i).equals(uncached(next[i][0], null)));
});

test("a torn index, a deleted or empty stored file: the look is still drawn right", () => {
  const { items, outfits } = fresh();
  const top = tile(items, "t1", 200, 30, 30), pants = tile(items, "p1", 30, 30, 200);
  const want = uncached(top, pants);
  build(outfits, [[top, pants]]);
  const cached = path.join(outfits, STORE, stored(outfits)[0]);

  fs.writeFileSync(path.join(outfits, INDEX), "{ not json");
  let r = build(outfits, [[top, pants]]);
  assert.equal(r.how.length, 1);
  assert.ok(out(outfits, 0).equals(want), "torn index");
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(outfits, INDEX), "utf8")), "rewritten whole");

  fs.unlinkSync(cached);
  fs.writeFileSync(path.join(outfits, "outfit_0.jpg"), "");      // no help from the old look either
  draws = 0;
  r = build(outfits, [[top, pants]]);
  assert.deepEqual(r.how, ["drawn"]);
  assert.equal(draws, 1);
  assert.ok(out(outfits, 0).equals(want), "deleted stored file");

  fs.writeFileSync(cached, "");
  r = build(outfits, [[top, pants]]);
  assert.deepEqual(r.how, ["drawn"], "an empty stored file is a miss");
  assert.ok(out(outfits, 0).equals(want));

  fs.writeFileSync(cached, want.subarray(0, 100));                 // torn by a crash
  r = build(outfits, [[top, pants]]);
  assert.deepEqual(r.how, ["drawn"], "a stored file of the wrong size is a miss");
  assert.ok(out(outfits, 0).equals(want));
});

test("a store that cannot be written: every look is drawn straight to its file", () => {
  const { items, outfits } = fresh();
  fs.writeFileSync(path.join(outfits, STORE), "a file where the store should be");
  const top = tile(items, "t1", 200, 30, 30), dress = tile(items, "d1", 240, 220, 20);
  draws = 0;
  const r = build(outfits, [[top, null], [dress, null]]);
  assert.deepEqual(r.how, ["drawn", "drawn"]);
  assert.equal(draws, 2);
  assert.ok(out(outfits, 0).equals(uncached(top, null)));
  assert.ok(out(outfits, 1).equals(uncached(dress, null)));
});

test("a missing tile throws to the caller's error path, as before the cache", () => {
  const { items, outfits } = fresh();
  const cache = openCompositeCache(outfits, { layout: LAYOUT });
  assert.throws(() => cache.produce(path.join(items, "gone.jpg"), null, path.join(outfits, "outfit_0.jpg"), draw), /ENOENT/);
  assert.ok(!fs.existsSync(path.join(outfits, "outfit_0.jpg")));
  cache.finish();
});

test("plain files only: no hardlinks, and a hit is byte-identical to the uncached look", () => {
  const { items, outfits } = fresh();
  const top = tile(items, "t1", 200, 30, 30), pants = tile(items, "p1", 30, 30, 200);
  build(outfits, [[top, pants]]);
  build(outfits, [[top, pants]]);
  assert.equal(fs.statSync(path.join(outfits, "outfit_0.jpg")).nlink, 1);
  for (const n of stored(outfits)) assert.equal(fs.statSync(path.join(outfits, STORE, n)).nlink, 1);
  assert.ok(out(outfits, 0).equals(uncached(top, pants)));
  // no temp left behind
  assert.deepEqual(fs.readdirSync(path.join(outfits, STORE)).filter(n => !n.endsWith(".jpg")), []);
  assert.deepEqual(fs.readdirSync(outfits).filter(n => n.endsWith(".tmp")), []);
});
