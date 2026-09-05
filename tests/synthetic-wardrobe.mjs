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
// CLI (the materialize half — tiles, photos, wardrobe.json — lands in T4.4):
//   node tests/synthetic-wardrobe.mjs                   # print the items as JSON
//   node tests/synthetic-wardrobe.mjs --materialize <DATA> [n]
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

// makeItems({n, seed}) → hub-shaped garments: {id, name, category, warmth,
// colors, pattern, statement, palette, vibe}. Deterministic for a seed.
export function makeItems({ n = 35, seed = 1 } = {}) {
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--materialize");
  if (at >= 0) {
    // T4.4 adds the materialize half (tiles + photos + wardrobe.json).
    process.stderr.write("synthetic-wardrobe: --materialize is not implemented yet (plan T4.4)\n");
    process.exit(2);
  }
  const n = Number(args[0]) || 35;
  process.stdout.write(JSON.stringify(makeItems({ n }), null, 1) + "\n");
}
