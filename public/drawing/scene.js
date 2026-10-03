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

// A sticker from stickers.json, or a person from the library (withPeople): one lookup for both.
export const stickerById = (table, id) => (table && table.stickers || []).find((s) => s.id === id)
  || (table && table.people || []).find((p) => p.id === id) || null;
export const itemWord = (table, s) => { const st = stickerById(table, s); return st ? st.word : ""; };

// People (spec 2026-10-02 §4): her family, cut out, from the private library the hub serves at
// /characters/. A person is a ground sticker whose scale and word come from characters.json.
export function withPeople(table, people) {
  return { ...table, people: (people || []).map((p) => ({ id: "person:" + p.slug, word: p.word, plural: p.word,
    zone: "ground", scale: p.scale, src: "/characters/" + encodeURIComponent(p.slug) + ".png", person: true })) };
}

// The pen (spec 2026-10-02 §3, EyeDraw's look-look adapted): it follows her gaze through an
// exponential smoother and keeps a point every minStep scene WIDTHS (dy is in heights, so it counts
// 9/16). Points have 3 decimals — at most 14 bytes of JSON each ("[0.123,0.456],") — and byteSoft
// keeps a whole scene under the hub's 256 KB, so her ink can never make a save fail (deviation 11).
export const PEN = { alpha: 0.35, minStep: 0.006, maxPts: 400, width: 0.014, byteSoft: 240 * 1024, ptBytes: 14 };
const r3 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
export function penStart(x, y, room = PEN.maxPts) {
  return { sx: x, sy: y, room: Math.min(PEN.maxPts, room), pts: [[r3(x), r3(y)]] };
}
export function penMove(pen, x, y) {
  pen.sx += PEN.alpha * (x - pen.sx);
  pen.sy += PEN.alpha * (y - pen.sy);
  if (pen.pts.length >= pen.room) return false;
  const last = pen.pts[pen.pts.length - 1];
  if (Math.hypot(pen.sx - last[0], (pen.sy - last[1]) / ASPECT) < PEN.minStep) return false;
  pen.pts.push([r3(pen.sx), r3(pen.sy)]);
  return true;
}
export function penEnd(pen, landing) {
  const pts = pen.pts.slice();
  if (landing && pts.length < pen.room) {
    const p = [r3(landing.x), r3(landing.y)], last = pts[pts.length - 1];
    if (p[0] !== last[0] || p[1] !== last[1]) pts.push(p);
  }
  return pts;
}
export const penRoom = (jsonLength) => Math.min(PEN.maxPts, Math.floor((PEN.byteSoft - jsonLength - 96) / PEN.ptBytes));
export function strokePath(pts) {
  const f = (v) => String(Math.round(v * 10) / 10);
  return pts.map(([x, y], k) => (k ? "L" : "M") + f(x * 1600) + " " + f(y * 900)).join("");
}

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

// What she DID (spec 2026-09-30 §2.3; 2026-10-02 §4): counted, in the order she first placed each,
// "a, b and c". A person is named by their word, once. Strokes and ids this table does not know (a
// person who left the library, a newer version's sticker) are not in the sentence.
export function describe(items, table) {
  const order = [], count = new Map();
  for (const it of items || []) {
    if (!it || it.s === "stroke" || !stickerById(table, it.s)) continue;
    if (!count.has(it.s)) order.push(it.s);
    count.set(it.s, (count.get(it.s) || 0) + 1);
  }
  const parts = order.map((id) => {
    const st = stickerById(table, id), n = count.get(id);
    if (st.person) return st.word;
    return n === 1 ? "a " + st.word.toLowerCase() : (NUMBER[n] || String(n)) + " " + st.plural;
  });
  if (!parts.length) return "You made a picture!";
  const list = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  return "You made a picture with " + list + "!";
}

// The one geometry: every item's box as fractions of the scene's width (left, width) and height
// (top, height). A stroke covers the whole picture and carries its path in 1600x900 units.
// Unknown ids (a newer version's sticker, a person who left the library) are skipped, never thrown on.
export function sceneOps(scene, table) {
  const out = [];
  (scene && scene.items || []).forEach((it, i) => {
    if (it && it.s === "stroke") {
      if (!Array.isArray(it.pts) || it.pts.length < 2) return;
      out.push({ i, s: "stroke", kind: "stroke", d: strokePath(it.pts), stroke: it.c, lineWidth: it.w * 900,
                 left: 0, top: 0, width: 1, height: 1 });
      return;
    }
    const st = stickerById(table, it && it.s);
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

// One stroke as DOM: the ring's strokes (renderScene) and the live pen (drawing.js) are this element.
export function strokeSvg(d, colour, w) {
  const el = document.createElementNS(SVGNS, "svg");
  el.setAttribute("viewBox", "0 0 1600 900");
  el.setAttribute("preserveAspectRatio", "none");
  const p = document.createElementNS(SVGNS, "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", colour);
  p.setAttribute("stroke-width", String(Math.round(w * 900 * 10) / 10));
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
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
      if (op.kind === "stroke") {
        target.save();
        target.scale(W / 1600, H / 900);
        target.strokeStyle = op.stroke;
        target.lineWidth = op.lineWidth;
        target.lineCap = "round";
        target.lineJoin = "round";
        target.stroke(new Path2D(op.d));
        target.restore();
      } else if (op.kind === "splat") {
        target.save();
        target.translate(x + w / 2, y + h / 2);
        target.scale(w / 2, h / 2);
        target.fillStyle = op.fill;
        target.fill(new Path2D(op.d));
        target.restore();
      } else if (images && images[op.s] && images[op.s].complete && images[op.s].naturalWidth) {
        const im = images[op.s];                     // contain, bottom-aligned: a figure is never stretched
        const f = Math.min(w / im.naturalWidth, h / im.naturalHeight), dw = im.naturalWidth * f, dh = im.naturalHeight * f;
        target.drawImage(im, x + (w - dw) / 2, y + h - dh, dw, dh);
      }
    }
    return target;
  }
  target.style.background = "";
  const kids = ops.map((op) => {
    let el;
    if (op.kind === "stroke") {
      el = strokeSvg(op.d, op.stroke, op.lineWidth / 900);
    } else if (op.kind === "splat") {
      el = splatSvg(op.d, op.fill);
    } else {
      el = document.createElement("img");
      el.src = op.src;
      el.alt = "";
      el.draggable = false;
    }
    el.setAttribute("class", op.kind === "stroke" ? "item stroke" : "item");
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

// A dwell target for a placed item (spec 2026-10-02 §6, deviation 2): its art box in px, grown to
// at least F x F about its centre, then SHIFTED — never shrunk — to lie inside the W x H picture.
export function hitBox(op, W, H, F) {
  const w = Math.max(op.width * W, F), h = Math.max(op.height * H, F);
  const cx = (op.left + op.width / 2) * W, cy = (op.top + op.height / 2) * H;
  const fit = (c, size, max) => Math.min(Math.max(0, c - size / 2), Math.max(0, max - size));
  return { left: fit(cx, w, W), top: fit(cy, h, H), width: w, height: h };
}
