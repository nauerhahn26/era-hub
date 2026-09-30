// drawings.test.mjs — the Drawing app's hub half (spec docs/superpowers/specs/2026-09-30-drawing-design.md):
// the vendored stickers (§6), the drawings.js module (§4) and its routes (§5). Synthetic fixtures only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRAW = path.join(HUB, "public", "drawing");
const TABLE = JSON.parse(fs.readFileSync(path.join(DRAW, "stickers.json"), "utf8"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-drawings-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ---- §6 the stickers ---------------------------------------------------------
test("the eight stickers sit in their fixed seats: ground things left, sky things then the splat right", () => {
  assert.deepEqual(TABLE.stickers.map(s => s.id), ["house", "horse", "tree", "person", "sun", "cloud", "star", "splat"]);
  assert.deepEqual(TABLE.stickers.map(s => s.at.join(",")), ["1,1", "2,1", "3,1", "4,1", "1,3", "2,3", "3,3", "4,3"]);
  assert.deepEqual(TABLE.stickers.map(s => s.word), ["House", "Horse", "Tree", "Person", "Sun", "Cloud", "Star", "Splat"]);
  assert.deepEqual(TABLE.stickers.map(s => s.zone), ["ground", "ground", "ground", "ground", "sky", "sky", "sky", "any"]);
  assert.equal(TABLE.stickers.find(s => s.id === "person").plural, "people");
});

test("every image sticker is vendored, matches its sha256 pin and is at least 256 px; the splat has no asset", () => {
  execFileSync(process.execPath, [path.join(HUB, "tools", "drawing-fetch-stickers.mjs"), "--check"], { stdio: "pipe" });
  for (const s of TABLE.stickers) {
    if (s.id === "splat") { assert.equal(s.src, null); continue; }
    const b = fs.readFileSync(path.join(DRAW, s.src));
    assert.equal(b.readUInt32BE(0), 0x89504e47, s.id + " is a PNG");
    assert.ok(b.readUInt32BE(16) >= 256 && b.readUInt32BE(20) >= 256, s.id + " is at least 256 px");
    assert.match(s.source, /^https:\/\/raw\.githubusercontent\.com\/microsoft\/fluentui-emoji\/[0-9a-f]{40}\/assets\//);
    assert.match(s.sha256, /^[0-9a-f]{64}$/);
  }
});

test("the MIT licence travels beside the stickers", () => {
  const lic = fs.readFileSync(path.join(DRAW, "stickers", "LICENSE"), "utf8");
  assert.match(lic, /MIT License/);
  assert.match(lic, /Microsoft Corporation/);
});

test("zones: 0-1 slots, sky above the horizon, ground bases on the grass, centre first; scales as the spec", () => {
  assert.equal(TABLE.horizon, 0.58);
  assert.equal(TABLE.lapOffset, 0.04);
  assert.deepEqual(TABLE.aspect, [16, 9]);
  for (const s of TABLE.zones.sky.slots) assert.ok(s.x > 0 && s.x < 1 && s.y > 0 && s.y < TABLE.horizon, JSON.stringify(s));
  for (const s of TABLE.zones.ground.slots) assert.ok(s.x > 0 && s.x < 1 && s.base > TABLE.horizon && s.base <= 1, JSON.stringify(s));
  for (const s of TABLE.zones.any.slots) assert.ok(s.x > 0 && s.x < 1 && s.y > 0 && s.y < 1, JSON.stringify(s));
  assert.equal(TABLE.zones.ground.slots.length, 7);
  assert.equal(TABLE.zones.sky.slots.length, 7);
  assert.equal(TABLE.zones.any.slots.length, 12);
  assert.equal(TABLE.zones.ground.slots[0].x, 0.5, "ground fills centre-out");
  assert.equal(TABLE.zones.sky.slots[0].x, 0.5, "sky fills centre-out");
  const scale = Object.fromEntries(TABLE.stickers.map(s => [s.id, s.scale]));
  assert.deepEqual(scale, { house: 0.26, horse: 0.20, tree: 0.28, person: 0.22, sun: 0.16, cloud: 0.14, star: 0.10, splat: [0.12, 0.18] });
});
