#!/usr/bin/env node
// drawing-default-people.mjs — the built-in People library's files (dad 10/7; docs/drawing.md "People").
// public/drawing/people/characters.json lists eight generic characters; each needs <slug>.png beside it.
// The real art is generic (no real people) and dropped in by hand; until it arrives, synthetic
// placeholders keep the library — and every test — whole.
//   node tools/drawing-default-people.mjs --placeholders          write a placeholder for every entry
//                                                                 WITHOUT a real PNG (a real cut-out is
//                                                                 never overwritten; --force does)
//   node tools/drawing-default-people.mjs --check                 every entry has a PNG; lists each one's
//                                                                 size and whether it is still a placeholder
// A placeholder carries a tEXt chunk "era-placeholder": a simple figure (head + body) on transparency,
// person-shaped (taller than wide), one calm colour each.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(HUB, "public", "drawing", "people");
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;                 // drawings.js SLUG_RE
const MARK = "era-placeholder";
// tokens.css's calm colours (never red), one a figure
const COLOURS = [[15, 124, 138], [46, 125, 91], [183, 130, 43], [106, 79, 179], [222, 123, 82], [27, 94, 140], [217, 111, 166], [90, 107, 115]];

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
  return Buffer.concat([len, td, crc]);
}
// A figure w x h: a round head on a rounded body, transparent around it, feet on the bottom row.
export function placeholderPng(w, h, rgb) {
  const head = w * 0.22, hx = w / 2, hy = head + 2, top = hy + head + 2, rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) {
      const inHead = (x - hx) ** 2 + (y - hy) ** 2 <= head * head;
      const half = w * 0.42 * Math.min(1, 0.6 + (y - top) / (h * 0.5));
      const inBody = y >= top && Math.abs(x + 0.5 - hx) <= half;
      if (inHead || inBody) { const o = 1 + x * 4; row[o] = rgb[0]; row[o + 1] = rgb[1]; row[o + 2] = rgb[2]; row[o + 3] = 255; }
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from("Comment\0" + MARK)), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
const pngSize = (b) => (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
const isPlaceholder = (b) => b.includes(Buffer.from("Comment\0" + MARK));

function entries() {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, "characters.json"), "utf8"));
  return (j.people || []).map((p) => ({ ...p, file: path.join(DIR, p.slug + ".png") }));
}

const args = process.argv.slice(2);
if (args.includes("--placeholders")) {
  const force = args.includes("--force");
  entries().forEach((p, k) => {
    if (!SLUG_RE.test(p.slug)) { console.error(`${p.slug}: not a slug — skipped`); return; }
    if (fs.existsSync(p.file) && !isPlaceholder(fs.readFileSync(p.file)) && !force) {
      console.log(`${p.slug}.png: a real cut-out — kept (--force overwrites)`);
      return;
    }
    // adults and children person-shaped (taller than wide); the baby smaller and squatter
    const [w, h] = p.slug === "baby" ? [112, 128] : (p.scale || 0.3) >= 0.33 ? [96, 256] : [96, 208];
    fs.writeFileSync(p.file, placeholderPng(w, h, COLOURS[k % COLOURS.length]));
    console.log(`${p.slug}.png: placeholder ${w}x${h}`);
  });
} else if (args.includes("--check")) {
  let bad = 0;
  for (const p of entries()) {
    let b = null;
    try { b = fs.readFileSync(p.file); } catch {}
    const s = b && pngSize(b);
    if (!SLUG_RE.test(p.slug) || !s) { bad++; console.error(`${p.slug}: ${!b ? "no PNG" : !s ? "not a PNG" : "not a slug"}`); continue; }
    console.log(`${p.slug}.png ${s.w}x${s.h} ${isPlaceholder(b) ? "PLACEHOLDER" : "real"} (${b.length} bytes)`);
  }
  process.exit(bad ? 1 : 0);
} else {
  console.error("usage: node tools/drawing-default-people.mjs --placeholders [--force] | --check");
  process.exit(2);
}
