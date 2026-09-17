// synthetic-wardrobe.mjs — an invented wardrobe for the clothing suites.
// A helper, not a suite (no ".test." in the name, so the gate glob skips it);
// importable as ./synthetic-wardrobe.mjs from the gate's flat copy of tests/.
//
// Every garment, name, colour and id here is made up. The shape mirrors the
// original wardrobe the variety gate ran on (variety_test.py:16 "the REAL
// wardrobe catalog"): 35 garments — 17 tops / 12 bottoms / 3 dresses / 3 sets,
// 9 statement pieces, 28 at warmth level 1 (hot/warm) and 7 at level 2 (cool)
// — so the ported gate exercises the same pool sizes and band gating.
//
// CLI:
//   node tests/synthetic-wardrobe.mjs                   # print the items as JSON
//   node tests/synthetic-wardrobe.mjs --materialize <DATA> [n] [--drive <folder>]
//                                     [--accessories jacket=3,shoes=1]
//
// `--materialize` lays a whole catalogued wardrobe on disk — photos, tiles and
// wardrobe.json — so a hub boots straight into "35 garments, no AI key needed".
// The ids are md5 of the photo's path under clothing/, exactly as the worker
// computes them, so two data dirs materialized from the same names agree on
// every id and can be compared board-for-board.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// mulberry32: a tiny seeded PRNG so a wardrobe is reproducible from its seed
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADJ = ["Sunny", "Pond", "Maple", "Comet", "Pebble", "Breezy", "Marble", "Tidal", "Clover", "Ember",
  "Fern", "Harbor", "Meadow", "Orchard", "Quill", "Ripple", "Saffron", "Thistle", "Willow", "Zephyr",
  "Acorn", "Bramble", "Cobalt", "Dune", "Echo", "Foxglove", "Glacier", "Heron", "Iris", "Juniper",
  "Kestrel", "Lantern", "Moss", "Nimbus", "Otter"];
const NOUN = { top: ["tee", "blouse", "polo", "sweater", "shirt"], pants: ["pants", "leggings"], shorts: ["shorts"], dress: ["dress"], set: ["set"] };
// Accessories (spec 2026-09-17 §4.1) — OPTIONAL, and never invented unless a
// suite asks for them by name, so the 17/12/3/3 garment wardrobe every other
// suite measures stays byte-for-byte what it was. The kinds are listed in
// clothing-rank's ACCESSORY_KINDS order, so `{shoes: 1, jacket: 1}` lays the
// same photos down as `{jacket: 1, shoes: 1}` and two data dirs agree on ids.
const ACC_NOUN = {
  jacket: ["jacket", "coat", "parka"], shoes: ["sneakers", "boots"],
  jewelry: ["necklace", "bracelet"], hat: ["hat", "beanie"],
  hair: ["bow", "clip"], makeup: ["lip gloss", "blush"],
};
// Cycled per kind so `accessoryOrder` has something to sort: on a cold band the
// coat leads, the "any" piece ties with it (it suits every band), and the warm
// one falls to the back.
const ACC_WARMTH = ["cold", "cool", "any", "warm"];
const LOUD_COLORS = ["pink", "orange", "red", "purple", "yellow", "teal", "green", "coral", "lime", "magenta"];
const QUIET_COLORS = ["navy", "black", "white", "gray", "blue", "cream", "beige", "tan", "light blue"];
// Patterns are the hub's whitelist words only (clothing-rank.js PATTERNS), so
// every garment here is one wardrobe.json can hold; `pick` spends one rnd()
// per call whatever the list length, so the ids stay the same.
const LOUD_PATTERNS = ["floral", "graphic", "print"];
const QUIET_PATTERNS = ["solid", "stripes"];
const PALETTES = ["warm", "cool", "neutral", "pastel"];
const VIBES = ["sweet", "sporty", "graphic", "basic"];

// Which of the 35 are statement pieces / level-2 (cool) pieces — fixed slots
// so the 9 / 7 counts hold and the mix is spread across categories.
const STATEMENT_SLOTS = new Set([1, 4, 7, 10, 13, 19, 24, 30, 32]);          // 5 tops, 2 bottoms, 1 dress, 1 set
const COOL_SLOTS = new Set([16, 20, 23, 26, 28, 31, 34]);                    // 1 top, 4 bottoms, 1 dress, 1 set

export function categoriesFor(n) {
  const top = Math.round(n * 17 / 35), bottom = Math.round(n * 12 / 35), dress = Math.round(n * 3 / 35);
  return { top, bottom, dress, set: Math.max(0, n - top - bottom - dress) };
}

// makeItems({n, seed, accessories}) → hub-shaped garments: {id, name, category,
// warmth, colors, pattern, statement, palette, vibe}. Deterministic for a seed.
// `accessories` is an optional count per kind ({jacket: 3, shoes: 1}); they are
// appended AFTER the n garments, so with none asked for the output is exactly
// what it was before accessories existed.
export function makeItems({ n = 35, seed = 1, accessories = null } = {}) {
  const rnd = prng(seed);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const hex = () => { let s = ""; for (let i = 0; i < 10; i++) s += Math.floor(rnd() * 16).toString(16); return s; };
  const counts = categoriesFor(n);
  const cats = [];
  for (let i = 0; i < counts.top; i++) cats.push("top");
  for (let i = 0; i < counts.bottom; i++) cats.push(i % 2 ? "shorts" : "pants");
  for (let i = 0; i < counts.dress; i++) cats.push("dress");
  for (let i = 0; i < counts.set; i++) cats.push("set");
  const seen = new Set();
  const items = [];
  cats.forEach((category, i) => {
    let id;
    do id = "item_" + hex(); while (seen.has(id));
    seen.add(id);
    const statement = STATEMENT_SLOTS.has(i);
    const cool = COOL_SLOTS.has(i);
    const colors = statement
      ? [pick(LOUD_COLORS)].concat(rnd() < 0.5 ? [pick(LOUD_COLORS)] : [])
      : [pick(rnd() < 0.6 ? QUIET_COLORS : LOUD_COLORS)];
    items.push({
      id,
      name: `${ADJ[i % ADJ.length]} ${pick(NOUN[category])}`,
      category,
      warmth: cool ? "cool" : (rnd() < 0.5 ? "hot" : "warm"),
      colors: [...new Set(colors)],
      pattern: statement ? pick(LOUD_PATTERNS) : pick(QUIET_PATTERNS),
      statement,
      palette: pick(PALETTES),
      vibe: pick(VIBES),
    });
  });
  // The accessories a suite asked for, drawn from the same stream once every
  // garment is made — a wardrobe with none spends not a single extra rnd().
  let slot = cats.length;
  for (const kind of Object.keys(ACC_NOUN)) {
    const count = (accessories && accessories[kind]) || 0;
    for (let j = 0; j < count; j++, slot++) {
      let id;
      do id = "item_" + hex(); while (seen.has(id));
      seen.add(id);
      items.push({
        id,
        name: `${ADJ[slot % ADJ.length]} ${ACC_NOUN[kind][j % ACC_NOUN[kind].length]}`,
        category: kind,
        warmth: ACC_WARMTH[j % ACC_WARMTH.length],
        colors: [pick(QUIET_COLORS)],
        pattern: pick(QUIET_PATTERNS),
        statement: false,
        palette: pick(PALETTES),
        vibe: pick(VIBES),
      });
    }
  }
  return items;
}

// makePairing(items) → {great: [[id,id]…×14], avoid: [[id,id]…×1]} over the
// wardrobe's ids, the shape of the original's curated pairing.json. Great
// pairs are basic-over-basic (two quiet pieces always harmonize), so every
// one of them is really in the pool; the avoid pair is a quiet pair too, so
// the avoid rule — not harmonizes — is what removes it.
export function makePairing(items = makeItems(), { seed = 2 } = {}) {
  const rnd = prng(seed);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const tops = items.filter(g => g.category === "top" && !g.statement);
  const bottoms = items.filter(g => (g.category === "pants" || g.category === "shorts") && !g.statement);
  const great = [], used = new Set();
  while (great.length < 14) {
    const t = pick(tops), b = pick(bottoms), k = t.id + "+" + b.id;
    if (used.has(k)) continue;
    used.add(k);
    great.push([t.id, b.id]);
  }
  let avoid;
  do { const t = pick(tops), b = pick(bottoms); avoid = [b.id, t.id]; } while (used.has(avoid[1] + "+" + avoid[0]));
  return { great, avoid: [avoid] };
}

// Strip every attribute the model would have written: the "no attributes"
// wardrobe of spec §3.1 item 4 (I5) — the hub must still fill 21.
export function stripAttributes(items) {
  return items.map(({ id, name, category, warmth }) => ({ id, name, category, warmth }));
}

// ---- materialize: the same wardrobe, on disk ------------------------------
// The hub's id for a photo is md5 of its path under clothing/ (the worker's
// own rule), so the FILENAME decides the id — and two devices that hold the
// same filenames deal the same board. `makeItems`' own ids are replaced here
// for exactly that reason.
const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const photoName = (i) => "g" + String(i + 1).padStart(2, "0") + ".jpg";
export const idFor = (rel) => "item_" + crypto.createHash("md5").update(rel).digest("hex").slice(0, 10);

// A flat colour JPEG. Every garment gets its own colour, so no two photos
// share a byte-for-byte body — a hash-keyed match must not collide (I15).
function makeJpg(file, w, h, r, g, b) {
  const jpeg = require("./vendor/jpeg-js");
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jpeg.encode({ data, width: w, height: h }, 85).data);
}
const rgbFor = (i) => [(i * 37) % 200 + 20, (i * 71) % 200 + 20, (i * 113) % 200 + 20];

// materialize({dataDir, n, seed, driveFolder}) → the items as they were written.
// Photos land in <DATA>/clothing (and in <folder>/clothing when one is given,
// which is what a Drive-mirrored family looks like); tiles in
// <DATA>/wardrobe-items; the catalogue in <DATA>/wardrobe.json, already
// described (`attrsAt`) so no build ever needs a key.
export function materialize({ dataDir, n = 35, seed = 1, driveFolder = null, day = "2026-01-01",
                              accessories = null } = {}) {
  const items = makeItems({ n, seed, accessories }).map((g, i) => ({ ...g, id: idFor(photoName(i)) }));
  const catalog = { items: {} };
  items.forEach((g, i) => {
    const rel = photoName(i);
    const [r, gg, b] = rgbFor(i);
    const photo = path.join(dataDir, "clothing", rel);
    makeJpg(photo, 320, 480, r, gg, b);
    if (driveFolder) makeJpg(path.join(driveFolder, "clothing", rel), 320, 480, r, gg, b);
    makeJpg(path.join(dataDir, "wardrobe-items", g.id + ".jpg"), 640, 640, r, gg, b);
    catalog.items[rel] = {
      id: g.id, ok: true, name: g.name, category: g.category, warmth: g.warmth,
      rotate_deg: 0, crop: {}, exif: 1,
      colors: g.colors, pattern: g.pattern, statement: g.statement,
      palette: g.palette, vibe: g.vibe,
      hash: crypto.createHash("sha256").update(fs.readFileSync(photo)).digest("hex"),
      attrsAt: day,          // already described: the needs-attributes pass is a no-op
    };
  });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "wardrobe.json"), JSON.stringify(catalog, null, 1));
  return items;
}

// "jacket=3,shoes=1" → {jacket: 3, shoes: 1}; nothing asked for stays null, so
// the CLI's wardrobe is the garments-only one unless a hand types otherwise.
function parseAccessories(s) {
  if (!s) return null;
  const out = {};
  for (const part of String(s).split(",")) {
    const [kind, n] = part.split("=");
    if (kind && Number(n) > 0) out[kind.trim()] = Number(n);
  }
  return Object.keys(out).length ? out : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--materialize");
  const a = args.indexOf("--accessories");
  const accessories = a >= 0 ? parseAccessories(args[a + 1]) : null;
  if (at >= 0) {
    const dataDir = args[at + 1];
    if (!dataDir) {
      process.stderr.write("usage: --materialize <DATA> [n] [--drive <folder>] [--accessories jacket=3,shoes=1]\n");
      process.exit(2);
    }
    const d = args.indexOf("--drive");
    const driveFolder = d >= 0 ? args[d + 1] : null;
    const skip = new Set([at, at + 1, d, d + 1, a, a + 1].filter(i => i >= 0));
    const rest = args.filter((_, i) => !skip.has(i));
    const n = Number(rest[0]) || 35;
    const items = materialize({ dataDir, n, driveFolder, accessories });
    process.stdout.write("materialized " + items.length + " items in " + dataDir +
      (driveFolder ? " (+ " + driveFolder + "/clothing)" : "") + "\n");
    process.exit(0);
  }
  const n = Number(args.filter(x => !x.startsWith("--") && x !== args[a + 1])[0]) || 35;
  process.stdout.write(JSON.stringify(makeItems({ n, accessories }), null, 1) + "\n");
}
