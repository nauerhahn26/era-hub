// drawing-scene.test.mjs — Drawing's scene logic (spec 2026-09-30 §2.1, §2.3, §3): where a sticker
// lands, what a splat looks like, what the celebration says, and the ONE geometry the ring, the
// shelf thumbnails and the mailed PNG all draw from. Pure: no hub, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASPECT, MEADOW, SPLAT_COLOURS, clampItem, landing, slotY, splatPath, describe, meadowCss, sceneOps }
  from "../public/drawing/scene.js";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = JSON.parse(fs.readFileSync(path.join(HUB, "public", "drawing", "stickers.json"), "utf8"));
const put = (items, id) => { const at = landing(id, items, T); items.push({ s: id, ...at, by: "ellie" }); return at; };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

test("the first ground sticker lands in the first centre-out slot, its bottom edge on the grass", () => {
  const at = landing("horse", [], T);
  assert.deepEqual(at, { x: 0.5, y: 0.82, w: 0.2 });           // base 0.92 - w/2
});

test("a zone fills centre-out, counts only its own stickers, then laps with +0.04", () => {
  const items = [];
  put(items, "sun"); put(items, "cloud");                        // sky things do not use ground slots
  const xs = [];
  for (let k = 0; k < 7; k++) xs.push(put(items, "horse").x);
  assert.deepEqual(xs, [0.5, 0.35, 0.65, 0.2, 0.8, 0.07, 0.93].map(x => clampItem({ x, y: 0.5, w: 0.2 }).x));
  const lap = put(items, "horse");
  near(lap.x, 0.54, "second lap x"); near(lap.y, 0.86, "second lap y");
});

test("sun, cloud and star share the sky slots, all above the horizon", () => {
  const items = [];
  assert.deepEqual(put(items, "sun"), { x: 0.5, y: 0.17, w: 0.16 });
  assert.deepEqual(put(items, "star"), { x: 0.33, y: 0.25, w: 0.1 });
  for (let k = 0; k < 5; k++) { const at = put(items, "cloud"); assert.ok(at.y + at.w / 2 < T.horizon, JSON.stringify(at)); }
});

test("nothing ever lands outside the picture, however many laps", () => {
  const items = [];
  for (let k = 0; k < 60; k++) {
    const at = put(items, "tree");
    const hx = at.w / ASPECT / 2, hy = at.w / 2;
    assert.ok(at.x >= hx - 1e-9 && at.x <= 1 - hx + 1e-9 && at.y >= hy - 1e-9 && at.y <= 1 - hy + 1e-9, JSON.stringify(at));
  }
});

test("a splat takes a slot from the fixed list, a size 0.12-0.18, a palette colour and a seed", () => {
  const seq = [0.99, 0.5, 0.26, 0.4];                            // slot 11, size .15, colour 1, seed
  let k = 0;
  const at = landing("splat", [], T, () => seq[k++]);
  const slot = T.zones.any.slots[11];
  assert.deepEqual({ x: at.x, y: at.y }, clampItem({ x: slot.x, y: slot.y, w: at.w }));
  near(at.w, 0.15, "size");
  assert.equal(at.c, SPLAT_COLOURS[1]);
  assert.equal(at.seed, Math.floor(0.4 * 2147483647));
  assert.ok(!SPLAT_COLOURS.some(c => /^#(b2|c0|d0|e0|ff)[0-3]/i.test(c)), "no red in her palette");
});

test("splatPath is deterministic, 8-12 points, inside the unit box", () => {
  assert.equal(splatPath(7), splatPath(7));
  assert.notEqual(splatPath(7), splatPath(8));
  for (const seed of [0, 1, 7, 99, 123456, 2147483646]) {
    const d = splatPath(seed);
    const n = (d.match(/Q/g) || []).length;
    assert.ok(n >= 8 && n <= 12, seed + ": " + n + " points");
    for (const v of d.match(/-?\d+\.\d+/g).map(Number)) assert.ok(v >= -1 && v <= 1, seed + ": " + v);
    assert.match(d, /^M.*Z$/);
  }
});

test("the celebration names what she made, counted, in the order she made it", () => {
  const I = (...ids) => ids.map(s => ({ s }));
  assert.equal(describe([], T), "You made a picture!");
  assert.equal(describe(I("horse"), T), "You made a picture with a horse!");
  assert.equal(describe(I("horse", "house"), T), "You made a picture with a horse and a house!");
  assert.equal(describe(I("horse", "house", "star", "star"), T), "You made a picture with a horse, a house and two stars!");
  assert.equal(describe(I("person", "person", "person"), T), "You made a picture with three people!");
  assert.equal(describe(I(...Array(13).fill("splat")), T), "You made a picture with 13 splats!");
  assert.doesNotMatch(describe(I("sun"), T), /sent|wrong/i);
});

test("one geometry for the ring, the thumbnails and the PNG: boxes in scene fractions", () => {
  const ops = sceneOps({ v: 1, backdrop: "meadow", items: [
    { s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" },
    { s: "splat", x: 0.45, y: 0.33, w: 0.15, by: "ellie", c: "#DE7B52", seed: 5 },
    { s: "dragon", x: 0.5, y: 0.5, w: 0.2, by: "ellie" },                 // a sticker this version does not know
  ] }, T);
  assert.equal(ops.length, 2, "unknown stickers are skipped, never thrown on");
  const [h, sp] = ops;
  assert.equal(h.kind, "img"); assert.equal(h.src, "stickers/horse.png"); assert.equal(h.i, 0);
  near(h.width, 0.2 / ASPECT, "width in scene widths"); near(h.height, 0.2, "height in scene heights");
  near(h.left, 0.5 - 0.1 / ASPECT, "left"); near(h.top, 0.72, "top");
  assert.equal(sp.kind, "splat"); assert.equal(sp.fill, "#DE7B52"); assert.equal(sp.d, splatPath(5)); assert.equal(sp.i, 1);
});

test("the meadow: sky over grass, the horizon at 0.58, the same stops for CSS and canvas", () => {
  assert.equal(MEADOW.find(([at, c]) => c === "#A9D69A")[0], 0.58);
  assert.equal(meadowCss(), "linear-gradient(to bottom, #BFE3F2 0%, #E4F3F7 57.5%, #A9D69A 58%, #78BD6E 100%)");
});

// ---- v2 (spec 2026-10-02 §5): slots move with the place's horizon -------------------
test("slots are horizon-relative: the meadow's horizon keeps v1's landings, a higher horizon moves both bands", () => {
  assert.deepEqual(landing("horse", [], T, Math.random, 0.58), { x: 0.5, y: 0.82, w: 0.2 }, "v1 exactly");
  assert.deepEqual(landing("sun", [], T, Math.random, 0.58), { x: 0.5, y: 0.17, w: 0.16 }, "v1 exactly");
  near(landing("horse", [], T, Math.random, 0.72).y, 0.8467, "ground base keeps its share of [h,1]");   // 0.72 + 0.34*0.28/0.42 - 0.1
  near(landing("sun", [], T, Math.random, 0.72).y, 0.211, "sky y keeps its share of [0,h]");          // 0.17 * 0.72 / 0.58
  for (const h of [0.58, 0.6, 0.62, 0.64, 0.66, 0.7, 0.72]) {
    for (const s of T.zones.ground.slots) { const y = slotY("ground", s, 0, h, T.horizon); assert.ok(y > h && y <= 1, `${h} ground ${y}`); }
    for (const s of T.zones.sky.slots) { const y = slotY("sky", s, 0, h, T.horizon); assert.ok(y > 0 && y < h, `${h} sky ${y}`); }
  }
  assert.equal(slotY("any", { x: 0.3, y: 0.85 }, 0.15, 0.72, 0.58), 0.85, "a splat goes anywhere, whatever the place");
  const items = [];
  for (let k = 0; k < 8; k++) { const at = landing("tree", items, T, Math.random, 0.72); items.push({ s: "tree", ...at, by: "ellie" }); }
  near(items[7].x, 0.54, "the lap offset still applies after the mapping");
});
