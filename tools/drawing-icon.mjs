#!/usr/bin/env node
// drawing-icon.mjs — Drawing's app icon: public/icons/drawing.png (256, the home tile) and
// public/icons/drawing.ico (256/48/32/16, the desktop shortcut). The other app icons are her i13's
// own .ico files (9/3) and Music/Movies were drawn to match; this one is drawn here, in the same
// flat style — a white card holding a tiny meadow, a sun, a tree and a splat — so it can be
// re-cut without a design tool. sharp (with librsvg) resolves from /home/claude/new-era/node_modules
// at tool time only; nothing ships but the two files.
//   node tools/drawing-icon.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(HUB, "public", "icons");
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect x="10" y="10" width="236" height="236" rx="30" fill="#FFFFFF" stroke="#D8E0DE" stroke-width="6"/>
  <clipPath id="c"><rect x="28" y="28" width="200" height="200" rx="18"/></clipPath>
  <g clip-path="url(#c)">
    <rect x="28" y="28" width="200" height="118" fill="#BFE3F2"/>
    <rect x="28" y="146" width="200" height="82" fill="#78BD6E"/>
    <circle cx="178" cy="78" r="26" fill="#F2B632"/>
    <rect x="72" y="118" width="14" height="62" rx="4" fill="#7A5230"/>
    <circle cx="79" cy="108" r="34" fill="#2E7D5B"/>
    <path d="M142 172 q12 -22 34 -10 q22 -10 28 12 q16 12 -2 26 q-6 18 -28 10 q-20 8 -28 -10 q-18 -10 -4 -28 z" fill="#DE7B52"/>
  </g>
</svg>`;
// An ICO whose every entry is a PNG (Windows Vista+ reads PNG entries at any size).
function ico(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let off = head.length;
  entries.forEach(({ size, buf }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  return Buffer.concat([head, ...entries.map((x) => x.buf)]);
}
const png = (size) => sharp(Buffer.from(SVG), { density: 72 * size / 256 * 4 }).resize(size, size).png().toBuffer();
const sizes = [256, 48, 32, 16];
const bufs = await Promise.all(sizes.map(png));
fs.writeFileSync(path.join(OUT, "drawing.png"), bufs[0]);
fs.writeFileSync(path.join(OUT, "drawing.ico"), ico(sizes.map((size, i) => ({ size, buf: bufs[i] }))));
console.log("wrote public/icons/drawing.png (" + bufs[0].length + " bytes) and public/icons/drawing.ico");
