#!/usr/bin/env node
// drawing-fetch-stickers.mjs — vendors the Drawing app's sticker PNGs (spec 2026-09-30 §6).
// Microsoft Fluent Emoji, 3D style (MIT), fetched by COMMIT-pinned raw URL and refused unless the
// bytes match the sha256 pinned in public/drawing/stickers.json and the PNG is at least 256 px.
//   node tools/drawing-fetch-stickers.mjs          download, verify, write public/drawing/stickers/*
//   node tools/drawing-fetch-stickers.mjs --check  verify what is vendored, offline (the test uses this)
// Re-pick a sticker = change its `source` + `sha256` in stickers.json, then run without --check.
// v2 (spec 2026-10-02 §1): also the mode glyphs (modes[] — Pencil, People hugging, National park).
// Trash mode (dad 10/4): also the door bar's tiles (bar[] — Wastebasket for the 🗑 Trash tile).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(HUB, "public", "drawing");
const table = JSON.parse(fs.readFileSync(path.join(DIR, "stickers.json"), "utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const pngSize = (b) => (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47)
  ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;

// A mode glyph that is also a sticker (Stickers = the star) is one file with one pin: fetched once.
const stickerDests = new Set(table.stickers.filter(s => s.src).map(s => s.src));
const files = [
  ...table.stickers.filter(s => s.src).map(s => ({ what: s.id, url: s.source, pin: s.sha256, dest: s.src, png: true })),
  ...(table.modes || []).filter(m => !stickerDests.has(m.src))
    .map(m => ({ what: "mode " + m.id, url: m.source, pin: m.sha256, dest: m.src, png: true })),
  ...(table.bar || []).map(b => ({ what: "bar " + b.id, url: b.source, pin: b.sha256, dest: b.src, png: true })),
  { what: "LICENSE", url: table.source.licenseUrl, pin: table.source.licenseSha256, dest: table.source.licenseFile, png: false },
];
function verify(f, buf) {
  const got = sha(buf);
  if (got !== f.pin) return `${f.what}: sha256 ${got} is not the pin ${f.pin}`;
  if (f.png) {
    const s = pngSize(buf);
    if (!s) return `${f.what}: not a PNG`;
    if (s.w < 256 || s.h < 256) return `${f.what}: ${s.w}x${s.h} is under 256 px — pick an alternate (see the plan)`;
  }
  return null;
}

const check = process.argv.includes("--check");
let bad = 0;
for (const f of files) {
  const dest = path.join(DIR, f.dest);
  let buf;
  if (check) {
    try { buf = fs.readFileSync(dest); } catch { console.error("missing " + f.dest); bad++; continue; }
  } else {
    const r = await fetch(f.url);
    if (!r.ok) { console.error(`${f.what}: HTTP ${r.status} ${f.url}`); bad++; continue; }
    buf = Buffer.from(await r.arrayBuffer());
  }
  const err = verify(f, buf);
  if (err) { console.error(err); bad++; continue; }
  if (!check) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf); }
  console.log((check ? "ok    " : "wrote ") + f.dest);
}
if (bad) { console.error(bad + " file(s) failed"); process.exit(1); }
