// backdrops.js — Drawing's eight places (spec 2026-10-02 §5). Procedural: no assets, no licences.
// Each place is DATA — { id, horizon, shapes } in 1600x900 units — and two painters read the SAME
// shapes: backdropMarkup()/backdropSvg() for the ring and every thumbnail, paintBackdrop() for the
// mailed PNG. So what she sees and what her family receives cannot drift apart. horizon = where the
// ground band starts (0-1 of the height): scene.js's slotY moves the sticker slots with it.
// Words and seats live in stickers.json (backdrops[]), which the hub validates against.
// Calm palette, never red (palette law): the reddest colour here is the vowel orange #DE7B52.
export const VIEW = [1600, 900];
const SKY = [[0, "#BFE3F2"], [1, "#E4F3F7"]];
const GRASS = [[0, "#A9D69A"], [1, "#78BD6E"]];
const star = (cx, cy, r) => ({ k: "circle", cx, cy, r, fill: "#FFF6D5" });
const arc = (r, stroke) => ({ k: "line", d: `M${800 - r} 522 A${r} ${r} 0 0 1 ${800 + r} 522`, stroke, width: 36 });

export const BACKDROPS = [
  { id: "meadow", horizon: 0.58, shapes: [
    { k: "band", y0: 0, y1: 522, stops: SKY },
    { k: "band", y0: 522, y1: 900, stops: GRASS } ] },
  { id: "beach", horizon: 0.66, shapes: [
    { k: "band", y0: 0, y1: 432, stops: [[0, "#9ED8F0"], [1, "#DDF2FA"]] },
    { k: "circle", cx: 1330, cy: 150, r: 70, fill: "#F6CF5C" },
    { k: "band", y0: 432, y1: 594, stops: [[0, "#4FA3C7"], [1, "#7CC4DC"]] },
    { k: "band", y0: 594, y1: 900, stops: [[0, "#F1DDAE"], [1, "#E2C489"]] } ] },
  { id: "night", horizon: 0.62, shapes: [
    { k: "band", y0: 0, y1: 558, stops: [[0, "#14213D"], [1, "#2C3E66"]] },
    { k: "circle", cx: 1250, cy: 170, r: 70, fill: "#F2EBC9" },
    star(220, 120, 6), star(430, 260, 5), star(640, 90, 6), star(860, 220, 5), star(1040, 80, 6), star(1460, 330, 5),
    { k: "band", y0: 558, y1: 900, stops: [[0, "#2F4A3A"], [1, "#1F3328"]] } ] },
  { id: "snow", horizon: 0.60, shapes: [
    { k: "band", y0: 0, y1: 540, stops: [[0, "#CFE3EE"], [1, "#EEF5F8"]] },
    { k: "path", d: "M0 540 Q400 430 800 540 Q1200 450 1600 540 L1600 560 L0 560 Z", fill: "#F4F8FA" },
    { k: "band", y0: 540, y1: 900, stops: [[0, "#FFFFFF"], [1, "#E3ECF1"]] } ] },
  { id: "sunset", horizon: 0.64, shapes: [
    { k: "band", y0: 0, y1: 576, stops: [[0, "#5B5B9E"], [0.6, "#E9A3C9"], [1, "#F6B66B"]] },
    { k: "circle", cx: 800, cy: 576, r: 110, fill: "#F7C266" },
    { k: "band", y0: 576, y1: 900, stops: [[0, "#4C6B46"], [1, "#2F4A2E"]] } ] },
  { id: "forest", horizon: 0.70, shapes: [
    { k: "band", y0: 0, y1: 630, stops: [[0, "#B9E0F0"], [1, "#E6F4F8"]] },
    { k: "path", d: "M0 630 L90 400 L180 630 Z M150 630 L260 360 L370 630 Z M330 630 L430 420 L530 630 Z " +
                    "M1070 630 L1170 410 L1270 630 Z M1230 630 L1340 350 L1450 630 Z M1410 630 L1510 420 L1600 600 L1600 630 Z",
      fill: "#2E7D5B" },
    { k: "band", y0: 630, y1: 900, stops: [[0, "#7DBB6A"], [1, "#4F8F45"]] } ] },
  { id: "city", horizon: 0.72, shapes: [
    { k: "band", y0: 0, y1: 648, stops: [[0, "#BFD7EA"], [1, "#E8F0F6"]] },
    { k: "path", d: "M60 648 L60 380 L220 380 L220 648 Z M260 648 L260 300 L400 300 L400 648 Z " +
                    "M1180 648 L1180 340 L1320 340 L1320 648 Z M1360 648 L1360 420 L1540 420 L1540 648 Z", fill: "#8A9BA8" },
    { k: "path", d: "M150 648 L150 470 L300 470 L300 648 Z M1260 648 L1260 480 L1420 480 L1420 648 Z", fill: "#6E8291" },
    { k: "band", y0: 648, y1: 900, stops: [[0, "#B9BEC2"], [1, "#9EA4A8"]] } ] },
  { id: "rainbow", horizon: 0.58, shapes: [
    { k: "band", y0: 0, y1: 522, stops: SKY },
    arc(420, "#DE7B52"), arc(385, "#F2A65A"), arc(350, "#E8C547"), arc(315, "#2E7D5B"), arc(280, "#0F7C8A"), arc(245, "#6A4FB3"),
    { k: "band", y0: 522, y1: 900, stops: GRASS } ] },
];

export const backdropById = (id) => BACKDROPS.find((b) => b.id === id) || BACKDROPS[0];
export const horizonOf = (id) => backdropById(id).horizon;

// Gradient ids must be unique in the document: the ring and every shelf thumbnail draw a place.
let UID = 0;
export function backdropMarkup(id) {
  const b = backdropById(id), u = "bd" + (++UID);
  let defs = "", body = "";
  b.shapes.forEach((s, k) => {
    if (s.k === "band") {
      defs += `<linearGradient id="${u}-${k}" x1="0" y1="0" x2="0" y2="1">` +
        s.stops.map(([at, c]) => `<stop offset="${at}" stop-color="${c}"/>`).join("") + "</linearGradient>";
      body += `<rect x="0" y="${s.y0}" width="1600" height="${s.y1 - s.y0}" fill="url(#${u}-${k})"/>`;
    } else if (s.k === "circle") body += `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${s.fill}"/>`;
    else if (s.k === "path") body += `<path d="${s.d}" fill="${s.fill}"/>`;
    else if (s.k === "line") body += `<path d="${s.d}" fill="none" stroke="${s.stroke}" stroke-width="${s.width}"/>`;
  });
  return `<defs>${defs}</defs>${body}`;
}
export function backdropSvg(id) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 1600 900");
  el.setAttribute("preserveAspectRatio", "none");
  el.setAttribute("class", "backdrop");
  el.setAttribute("data-backdrop", backdropById(id).id);
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = backdropMarkup(id);
  return el;
}
export function paintBackdrop(ctx, id, W, H) {
  const b = backdropById(id);
  ctx.save();
  ctx.scale(W / 1600, H / 900);
  for (const s of b.shapes) {
    if (s.k === "band") {
      const g = ctx.createLinearGradient(0, s.y0, 0, s.y1);
      for (const [at, c] of s.stops) g.addColorStop(at, c);
      ctx.fillStyle = g;
      ctx.fillRect(0, s.y0, 1600, s.y1 - s.y0);
    } else if (s.k === "circle") {
      ctx.beginPath(); ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2); ctx.fillStyle = s.fill; ctx.fill();
    } else if (s.k === "path") {
      ctx.fillStyle = s.fill; ctx.fill(new Path2D(s.d));
    } else if (s.k === "line") {
      ctx.strokeStyle = s.stroke; ctx.lineWidth = s.width; ctx.lineCap = "butt"; ctx.stroke(new Path2D(s.d));
    }
  }
  ctx.restore();
}
