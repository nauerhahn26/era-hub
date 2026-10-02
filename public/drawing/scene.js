// scene.js — Drawing's scene: where a sticker lands, what a splat looks like, what the celebration
// says, and THE scene renderer (spec 2026-09-30 §2.1, §2.3, §3). ONE renderScene() draws the ring,
// every shelf thumbnail and the 1600x900 PNG that is mailed, from one geometry (sceneOps), one
// place (backdrops.js) and one splat (splatPath) — so what she sees, what the shelf shows and what her
// family receives can never drift apart. Plain ES module, no DOM at import time: node tests import
// it; the page puts it on window.DrawingScene through the module shim in index.html.
// Coordinates: x of the scene WIDTH, y of the scene HEIGHT, both the item's CENTRE; w = its square
// box as a fraction of the scene HEIGHT.
import { backdropSvg, paintBackdrop } from "./backdrops.js";
export { horizonOf } from "./backdrops.js";

export const ASPECT = 16 / 9;
// tokens.css: --c-teal, --c-vowel, --c-good-literacy, --c-confetti-gold. Never red (palette law).
export const SPLAT_COLOURS = ["#0F7C8A", "#DE7B52", "#2E7D5B", "#B7822B"];
const NUMBER = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

export const stickerById = (table, id) => (table && table.stickers || []).find((s) => s.id === id) || null;

// Rounded to 4 decimals INWARD: a plain round could put an edge item 0.00005 outside (caught by
// the "however many laps" test), and the hub refuses nothing inside 0-1 but the box must stay in.
export function clampItem({ x, y, w }) {
  const hx = w / ASPECT / 2, hy = w / 2;
  const lo = (h) => Math.ceil(h * 1e4) / 1e4, hi = (h) => Math.floor((1 - h) * 1e4) / 1e4;
  const fit = (v, h) => Math.min(hi(h), Math.max(lo(h), round(v, 4)));
  return { x: fit(x, hx), y: fit(y, hy) };
}

// Horizon-relative slots (spec 2026-10-02 §5): stickers.json's slot numbers are written against the
// reference horizon table.horizon (0.58, the meadow). A place with another horizon h carries them:
// a ground base keeps its share of the ground band [h,1], a sky y its share of the sky band [0,h], a
// splat ("any") goes anywhere. At h = ref this is v1 exactly.
export function slotY(zone, slot, w, h, ref) {
  if (zone === "ground") return h + (slot.base - ref) * (1 - h) / (1 - ref) - w / 2;
  if (zone === "sky") return slot.y * h / ref;
  return slot.y;
}

// "Pick and it lands" (spec 2026-09-30 §2.1). Sky/ground: the n-th sticker of a zone takes slot n % 7,
// one lap later everything shifts +lapOffset in x and y. Any (the splat): a random slot.
// horizon: the current place's (backdrops.js horizonOf); omitted = the reference horizon.
export function landing(id, items, table, rand = Math.random, horizon) {
  const st = stickerById(table, id);
  if (!st || !table.zones || !table.zones[st.zone]) return null;
  const slots = table.zones[st.zone].slots;
  if (st.zone === "any") {
    const slot = slots[Math.min(slots.length - 1, Math.floor(rand() * slots.length))];
    const [lo, hi] = Array.isArray(st.scale) ? st.scale : [st.scale, st.scale];
    const w = round(lo + rand() * (hi - lo), 3);
    const c = SPLAT_COLOURS[Math.min(SPLAT_COLOURS.length - 1, Math.floor(rand() * SPLAT_COLOURS.length))];
    const seed = Math.floor(rand() * 2147483647);
    return { ...clampItem({ x: slot.x, y: slot.y, w }), w, c, seed };
  }
  const ref = table.horizon || 0.58;
  const h = Number.isFinite(horizon) ? horizon : ref;
  const n = items.filter((it) => { const s = stickerById(table, it.s); return s && s.zone === st.zone; }).length;
  const slot = slots[n % slots.length];
  const off = Math.floor(n / slots.length) * (table.lapOffset || 0);
  const w = st.scale;
  return { ...clampItem({ x: slot.x + off, y: slotY(st.zone, slot, w, h, ref) + off, w }), w };
}

// A procedural paint splat (spec §2.1): 8-12 control points at random radii from a seeded PRNG,
// joined by quadratic curves through their midpoints. Path in the box -1..1 (viewBox "-1 -1 2 2").
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function splatPath(seed) {
  const r = mulberry32(seed >>> 0);
  const n = 8 + Math.floor(r() * 5);
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + (r() - 0.5) * (Math.PI / n);
    const rad = 0.55 + r() * 0.45;
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
  }
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const f = (v) => v.toFixed(3);
  const m0 = mid(pts[n - 1], pts[0]);
  let d = "M" + f(m0[0]) + " " + f(m0[1]);
  for (let k = 0; k < n; k++) {
    const p = pts[k], m = mid(p, pts[(k + 1) % n]);
    d += "Q" + f(p[0]) + " " + f(p[1]) + " " + f(m[0]) + " " + f(m[1]);
  }
  return d + "Z";
}

// What she DID (spec §2.3): counted, in the order she first placed each, "a, b and c".
export function describe(items, table) {
  const order = [], count = new Map();
  for (const it of items || []) {
    if (!count.has(it.s)) order.push(it.s);
    count.set(it.s, (count.get(it.s) || 0) + 1);
  }
  const parts = order.map((id) => {
    const st = stickerById(table, id), n = count.get(id);
    const word = st ? st.word.toLowerCase() : id;
    return n === 1 ? "a " + word : (NUMBER[n] || String(n)) + " " + (st ? st.plural : id + "s");
  });
  if (!parts.length) return "You made a picture!";
  const list = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  return "You made a picture with " + list + "!";
}

// The one geometry: every item's box as fractions of the scene's width (left, width) and height
// (top, height). Unknown stickers (a newer version's) are skipped, never thrown on.
export function sceneOps(scene, table) {
  const out = [];
  (scene && scene.items || []).forEach((it, i) => {
    const st = stickerById(table, it.s);
    if (!st) return;
    const hx = it.w / ASPECT / 2, hy = it.w / 2;
    const splat = it.s === "splat";
    out.push({ i, s: it.s, kind: splat ? "splat" : "img", src: splat ? null : st.src,
               d: splat ? splatPath(it.seed) : null, fill: splat ? it.c : null,
               left: it.x - hx, top: it.y - hy, width: 2 * hx, height: 2 * hy });
  });
  return out;
}

const SVGNS = "http://www.w3.org/2000/svg";
// One splat as DOM: the ring's and the thumbnails' splats (renderScene) and the Splat tile's sample
// (drawing.js) are all this element. d = splatPath(seed), in the box -1..1.
export function splatSvg(d, fill) {
  const el = document.createElementNS(SVGNS, "svg");
  el.setAttribute("viewBox", "-1 -1 2 2");
  const p = document.createElementNS(SVGNS, "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", fill);
  el.appendChild(p);
  return el;
}
// THE renderer. target = a CanvasRenderingContext2D (the PNG) or an element (the ring's #scene, a
// shelf thumbnail, the New picture tile). opts.images = { stickerId: loaded HTMLImageElement } for
// the canvas. Returns target.
export function renderScene(target, scene, { table, images } = {}) {
  const ops = sceneOps(scene, table);
  if (target && typeof target.drawImage === "function") {
    const W = target.canvas.width, H = target.canvas.height;
    paintBackdrop(target, (scene && scene.backdrop) || "meadow", W, H);
    for (const op of ops) {
      const x = op.left * W, y = op.top * H, w = op.width * W, h = op.height * H;
      if (op.kind === "splat") {
        target.save();
        target.translate(x + w / 2, y + h / 2);
        target.scale(w / 2, h / 2);
        target.fillStyle = op.fill;
        target.fill(new Path2D(op.d));
        target.restore();
      } else if (images && images[op.s] && images[op.s].complete && images[op.s].naturalWidth) {
        target.drawImage(images[op.s], x, y, w, h);
      }
    }
    return target;
  }
  target.style.background = "";
  const kids = ops.map((op) => {
    let el;
    if (op.kind === "splat") {
      el = splatSvg(op.d, op.fill);
    } else {
      el = document.createElement("img");
      el.src = op.src;
      el.alt = "";
      el.draggable = false;
    }
    el.setAttribute("class", "item");
    el.setAttribute("data-i", String(op.i));
    el.style.left = op.left * 100 + "%";
    el.style.top = op.top * 100 + "%";
    el.style.width = op.width * 100 + "%";
    el.style.height = op.height * 100 + "%";
    return el;
  });
  target.replaceChildren(backdropSvg((scene && scene.backdrop) || "meadow"), ...kids);
  return target;
}
