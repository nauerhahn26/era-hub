// drawing-scene.test.mjs — Drawing's scene logic (spec 2026-09-30 §2.1, §2.3, §3): where a sticker
// lands, what a splat looks like, what the celebration says, and the ONE geometry the ring, the
// shelf thumbnails and the mailed PNG all draw from. Pure: no hub, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASPECT, SPLAT_COLOURS, clampItem, landing, slotY, splatPath, describe, sceneOps, renderScene,
  PEN, penStart, penMove, penEnd, penRoom, strokePath, withPeople, itemWord, stickerById }
  from "../public/drawing/scene.js";
import { BACKDROPS, backdropById, horizonOf, backdropMarkup, paintBackdrop } from "../public/drawing/backdrops.js";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = JSON.parse(fs.readFileSync(path.join(HUB, "public", "drawing", "stickers.json"), "utf8"));
const put = (items, id) => { const at = landing(id, items, T); items.push({ s: id, ...at, by: "ellie" }); return at; };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

// A canvas that records what it was asked to draw (node has no canvas). Path2D is the browser's; a
// stand-in that keeps its path string is all the painters need.
globalThis.Path2D ??= class { constructor(d) { this.d = d; } };
function fakeCtx(calls, W = 1600, H = 900) {
  return { canvas: { width: W, height: H }, fillStyle: null, strokeStyle: null, lineWidth: 1, lineCap: "butt", lineJoin: "miter",
    save() {}, restore() {}, translate() {}, beginPath() {},
    scale(sx, sy) { calls.push(["scale", sx, sy]); },
    createLinearGradient(x0, y0, x1, y1) { const g = { stops: [] }; g.addColorStop = (at, c) => g.stops.push([at, c]); return g; },
    fillRect(x, y, w, h) { calls.push(["band", y, y + h, JSON.stringify(this.fillStyle.stops)]); },
    arc(cx, cy, r) { this._arc = [cx, cy, r]; },
    fill(p) { calls.push(p ? ["path", p.d, this.fillStyle] : ["circle", ...this._arc, this.fillStyle]); },
    stroke(p) { calls.push(["line", p.d, this.strokeStyle, this.lineWidth, this.lineCap]); },
    drawImage(im, x, y, w, h) { calls.push(["img", x, y, w, h]); } };
}

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

// ---- v2 (spec 2026-10-02 §5): the eight places --------------------------------------
test("eight places with stickers.json's ids, each horizon where its ground band starts; unknown is the meadow", () => {
  assert.deepEqual(BACKDROPS.map(b => b.id), T.backdrops.map(b => b.id));
  for (const b of BACKDROPS) {
    const ground = b.shapes.filter(s => s.k === "band").at(-1);
    assert.equal(ground.y1, 900, b.id + ": the ground band reaches the bottom");
    near(ground.y0 / 900, b.horizon, b.id + ": horizon");
  }
  assert.equal(backdropById("volcano").id, "meadow");
  assert.equal(horizonOf("city"), 0.72);
  assert.equal(horizonOf(undefined), 0.58);
});

test("no red in any place: every colour is calm (no saturated hue within 15 degrees of red), never partner red", () => {
  const hues = [];
  for (const b of BACKDROPS) for (const s of b.shapes)
    for (const c of [s.fill, s.stroke, ...(s.stops || []).map(([, c]) => c)].filter(Boolean)) hues.push([b.id, c]);
  for (const [id, c] of hues) {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl), d = mx - mn, l = (mx + mn) / 2;
    const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let hue = d === 0 ? 0 : mx === r ? 60 * (((g - bl) / d) % 6) : mx === g ? 60 * ((bl - r) / d + 2) : 60 * ((r - g) / d + 4);
    if (hue < 0) hue += 360;
    assert.ok(!(sat > 0.4 && (hue >= 345 || hue < 15)), `${id} ${c}: hue ${hue.toFixed(0)}`);
    assert.notEqual(c.toLowerCase(), "#b23a48");
  }
});

test("one geometry: the SVG markup and the canvas paint the same shapes with the same numbers", () => {
  for (const b of BACKDROPS) {
    const m = backdropMarkup(b.id);
    const grads = [...m.matchAll(/<linearGradient[^>]*>(.*?)<\/linearGradient>/g)]
      .map(([, inner]) => JSON.stringify([...inner.matchAll(/offset="([^"]+)" stop-color="([^"]+)"/g)].map(([, at, c]) => [+at, c])));
    let gi = 0;
    const fromSvg = [...m.matchAll(/<(rect|circle|path)([^>]*)\/>/g)].map(([, tag, a]) => {
      const at = (n) => (new RegExp(` ${n}="([^"]*)"`).exec(a) || [])[1];
      if (tag === "rect") return ["band", +at("y"), +at("y") + +at("height"), grads[gi++]];
      if (tag === "circle") return ["circle", +at("cx"), +at("cy"), +at("r"), at("fill")];
      return at("fill") === "none" ? ["line", at("d"), at("stroke"), +at("stroke-width"), "butt"] : ["path", at("d"), at("fill")];
    });
    const calls = [];
    paintBackdrop(fakeCtx(calls), b.id, 800, 450);
    assert.deepEqual(calls[0], ["scale", 0.5, 0.5], b.id + ": the canvas paints in 1600x900 units");
    assert.deepEqual(calls.slice(1), fromSvg, b.id);
    assert.equal(fromSvg.length, b.shapes.length, b.id + ": every shape drawn once");
  }
  const a = backdropMarkup("meadow"), z = backdropMarkup("meadow");
  assert.notEqual(a.match(/id="([^"]+)"/)[1], z.match(/id="([^"]+)"/)[1], "gradient ids never repeat in one page");
});

test("the PNG paints the picture's place first, then the items over it", () => {
  const calls = [];
  renderScene(fakeCtx(calls), { v: 1, backdrop: "city", items: [{ s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" }] },
    { table: T, images: { horse: { complete: true, naturalWidth: 256, naturalHeight: 256 } } });
  assert.deepEqual(calls[0], ["scale", 1, 1]);
  assert.equal(calls.filter(c => c[0] === "band").length, BACKDROPS.find(b => b.id === "city").shapes.filter(s => s.k === "band").length);
  assert.equal(calls.at(-1)[0], "img", "the horse is painted last");
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

// ---- v2 (spec 2026-10-02 §3): the pen ------------------------------------------------
test("the pen: smoothing is deterministic, a point every 0.6% of the width, 3 decimals, never past its room", () => {
  const pen = penStart(0.2, 0.5);
  assert.deepEqual([pen.pts, pen.room], [[[0.2, 0.5]], 400]);
  assert.equal(penMove(pen, 0.3, 0.5), true, "a jump is smoothed, not copied");
  assert.deepEqual(pen.pts[1], [0.235, 0.5]);                       // 0.2 + 0.35 * 0.1
  const still = penStart(0.5, 0.5);
  assert.equal(penMove(still, 0.505, 0.5), false, "a wobble under the step adds nothing");
  const run = () => { const p = penStart(0.1, 0.1); for (let k = 1; k <= 60; k++) penMove(p, 0.1 + k * 0.01, 0.1 + (k % 5) * 0.03); return p.pts; };
  const a = run();
  assert.deepEqual(a, run(), "the same gaze gives the same line");
  for (let k = 0; k < a.length; k++) {
    for (const v of a[k]) { assert.equal(v, Math.round(v * 1000) / 1000); assert.ok(v >= 0 && v <= 1); }
    if (k) assert.ok(Math.hypot(a[k][0] - a[k - 1][0], (a[k][1] - a[k - 1][1]) / ASPECT) >= PEN.minStep - 0.001, "spaced " + k);
  }
  const full = penStart(0, 0, 3);
  for (let k = 1; k < 100; k++) penMove(full, k / 100, 0);
  assert.equal(full.pts.length, 3, "never past its room");
  assert.equal(penStart(0, 0, 9999).room, 400, "never past 400");
});

test("penEnd lands on the dwell dot; penRoom keeps a scene under the soft cap", () => {
  const p = penStart(0.1, 0.1);
  penMove(p, 0.5, 0.1);
  assert.deepEqual(penEnd(p, { x: 0.6, y: 0.4 }).at(-1), [0.6, 0.4]);
  assert.equal(p.pts.length, 2, "penEnd does not touch the live pen");
  assert.deepEqual(penEnd(penStart(0.1, 0.1), null), [[0.1, 0.1]], "a dwell without movement is one point (the page drops it)");
  assert.deepEqual(penEnd(penStart(0.1, 0.1), { x: 0.1, y: 0.1 }), [[0.1, 0.1]], "a landing on the start adds nothing");
  assert.equal(penRoom(1000), 400);
  assert.equal(penRoom(PEN.byteSoft - 96 - 14 * 10), 10);
  assert.ok(penRoom(PEN.byteSoft) < 2, "a full picture has no room for a stroke");
});

test("a stroke is one path in 1600x900 units — the same string for the ring and the PNG", () => {
  assert.equal(strokePath([[0, 0], [0.5, 0.5], [1, 1]]), "M0 0L800 450L1600 900");
  assert.equal(strokePath([[0.123, 0.456], [0.2, 0.2]]), "M196.8 410.4L320 180");
  const S1 = { s: "stroke", c: "#d96fa6", w: 0.014, pts: [[0.1, 0.2], [0.3, 0.4]], by: "ellie" };
  const ops = sceneOps({ v: 1, backdrop: "meadow", items: [{ s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" }, S1, { ...S1, pts: [[0.1, 0.1]] }] }, T);
  assert.equal(ops.length, 2, "a one-point stroke is never drawn");
  const op = ops[1];
  assert.deepEqual([op.i, op.kind, op.d, op.stroke, op.left, op.top, op.width, op.height],
    [1, "stroke", strokePath(S1.pts), "#d96fa6", 0, 0, 1, 1]);
  near(op.lineWidth, 12.6, "1.4% of the height");
  const calls = [];
  renderScene(fakeCtx(calls), { v: 1, backdrop: "meadow", items: [S1] }, { table: T, images: {} });
  assert.deepEqual(calls.at(-1), ["line", strokePath(S1.pts), "#d96fa6", op.lineWidth, "round"]);
});

// ---- v2 (spec 2026-10-02 §4): people --------------------------------------------------
const PEOPLE = [{ slug: "maya", word: "Maya", scale: 0.3 }, { slug: "sam", word: "Sam", scale: 0.25 }];
test("people are ground stickers named by their word, scaled from the library, drawn from /characters/", () => {
  const TP = withPeople(T, PEOPLE);
  assert.equal(TP.stickers, T.stickers, "the sticker table is untouched");
  const m = stickerById(TP, "person:maya");
  assert.deepEqual([m.zone, m.scale, m.word, m.src, m.person], ["ground", 0.3, "Maya", "/characters/maya.png", true]);
  assert.deepEqual(landing("person:maya", [], TP), { x: 0.5, y: 0.77, w: 0.3 }, "the first ground slot, feet on the grass");
  const items = [{ s: "horse", ...landing("horse", [], TP), by: "ellie" }];
  assert.equal(landing("person:sam", items, TP).x, 0.35, "people and stickers share the ground slots");
  assert.deepEqual([itemWord(TP, "person:sam"), itemWord(TP, "horse"), itemWord(TP, "person:gone")], ["Sam", "Horse", ""]);
  const ops = sceneOps({ v: 1, items: [{ s: "person:maya", x: 0.5, y: 0.77, w: 0.3, by: "ellie" },
                                        { s: "person:gone", x: 0.5, y: 0.5, w: 0.3, by: "ellie" }] }, TP);
  assert.equal(ops.length, 1, "a person who left the library is drawn as nothing — never an error");
  assert.deepEqual([ops[0].kind, ops[0].src, ops[0].s], ["img", "/characters/maya.png", "person:maya"]);
});

test("the PNG draws a person into its box without stretching: contain, bottom on the box's bottom", () => {
  const calls = [];
  renderScene(fakeCtx(calls), { v: 1, backdrop: "meadow", items: [{ s: "person:maya", x: 0.5, y: 0.5, w: 0.4, by: "ellie" }] },
    { table: withPeople(T, PEOPLE), images: { "person:maya": { complete: true, naturalWidth: 64, naturalHeight: 128 } } });
  const [, x, y, w, h] = calls.find((c) => c[0] === "img");
  // the box: 0.4 x 900 = 360 px square centred at (800, 450); a 1:2 figure fills its height, 180 px wide
  for (const [got, want, what] of [[x, 710, "x"], [y, 270, "y"], [w, 180, "w"], [h, 360, "h"]]) near(got, want, what);
});

test("the celebration names people by their word, once each, and never counts strokes", () => {
  const TP = withPeople(T, PEOPLE);
  const I = (...ids) => ids.map((s) => ({ s }));
  assert.equal(describe(I("person:maya", "horse", "person:maya", "person:sam"), TP), "You made a picture with Maya, a horse and Sam!");
  assert.equal(describe(I("stroke", "stroke"), TP), "You made a picture!");
  assert.equal(describe(I("stroke", "star", "stroke", "star"), TP), "You made a picture with two stars!");
  assert.equal(describe(I("person:gone", "sun"), TP), "You made a picture with a sun!", "a vanished person is not named");
});
