// image-util.js — the hub's pure-JS picture path, shared. Decode a JPEG, turn
// it the way its EXIF says a viewer would, scale it, encode it again. No spawn,
// no native module, no ImageMagick, no ffmpeg: the same four lines run on the
// family's Windows box and on the QA Linux box, and a machine with no Visual
// C++ runtime is not a special case (the lesson the ONNX native binding taught
// us on the QA machine 9/1).
//
// It is all lifted verbatim out of clothing-worker.js, where it grew for the
// Clothing Picker (dad 8/31) — the book ingest step needs exactly the same
// four operations, and a second copy of a resampler is a second place for a
// sideways photo to hide. clothing-worker.js keeps the parts that are its own:
// HEIC (libheif rides in the board pack, not the core), cropping, padding and
// the background flood.
//
// Everything here is synchronous and pure except the two that touch a file.
// The decoder is required lazily so a hub that never opens a picture never
// pays for it.
"use strict";
const fs = require("fs");
const { exifOrientation, upright } = require("./image-orient.js");

// jpeg-js rides with the core (vendor/, see NOTICE-vendor.txt).
let jpeg = null;
function ensureCodecs() {
  if (!jpeg) jpeg = require("./vendor/jpeg-js");
  return jpeg;
}

// ------------------------------------------------------------------ decode

// RGBA out of a JPEG buffer. The codec hands back a view onto its own arena,
// so the pixels are copied into a Buffer of our own before anyone can mutate
// them (or before the arena is reused by the next decode).
function decodeJpg(buf, opts) {
  ensureCodecs();
  const d = jpeg.decode(buf, Object.assign({ formatAsRGBA: true }, opts || {}));
  return { data: Buffer.from(d.data), width: d.width, height: d.height };
}

// A JPEG on disk, decoded and turned upright. jpeg-js hands back the pixels the
// sensor saw; every viewer applies EXIF Orientation and so must we, or a phone
// photo arrives sideways (dad 9/3: upside-down garments on the board).
// maxMemoryUsageInMB is the clothing pipeline's own ceiling, kept so a 12 MP
// photo still decodes here.
function readJpg(file) {
  const buf = fs.readFileSync(file);
  return upright(decodeJpg(buf, { maxMemoryUsageInMB: 1024 }), exifOrientation(buf));
}

// ------------------------------------------------------------------- scale

// Nearest-neighbour box scale down to a long edge of maxDim. Already small
// enough: the very same object comes back, so callers can compare by identity
// and skip a copy.
function scaleRgba(img, maxDim) {
  const { data, width: w, height: h } = img;
  if (Math.max(w, h) <= maxDim) return img;
  const s = maxDim / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.round(y / s));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.round(x / s));
      const si = (sy * w + sx) * 4, di = (y * nw + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh };
}

// ------------------------------------------------------------------ encode

function encodeJpg(img, q) { ensureCodecs(); return jpeg.encode(img, q || 85).data; }
function writeJpg(img, file, q) { fs.writeFileSync(file, encodeJpg(img, q)); }

// ---------------------------------------------------------------- exif date

// When the photo was taken, in ms, or null. The page order of a book scanned
// on a phone is the order the pages were shot (spec §4 step 1), and that is
// the only place it is written down: DateTimeOriginal (0x9003) lives in the
// Exif sub-IFD that IFD0's 0x8769 pointer leads to, not in IFD0 itself. IFD0's
// own DateTime (0x0132) is the fallback — a scanner or an edited copy may
// carry only that one.
// Same walk as image-orient.js's exifOrientation, same rule: anything we do not
// fully understand reads as "no stamp", never as a throw.
function exifDate(buf) {
  try {
    if (!buf || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
    let i = 2;
    while (i + 4 <= buf.length && buf[i] === 0xFF) {
      const marker = buf[i + 1];
      if (marker === 0xDA || marker === 0xD9) break;          // scan / end: no more headers
      const len = buf.readUInt16BE(i + 2);
      if (marker === 0xE1 && buf.toString("latin1", i + 4, i + 10) === "Exif\0\0") {
        const t = i + 10;                                     // TIFF header
        const end = Math.min(buf.length, i + 2 + len);
        const order = buf.toString("latin1", t, t + 2);
        if (order !== "II" && order !== "MM") return null;
        const le = order === "II";
        const u16 = (o) => o + 2 <= end ? (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : 0;
        const u32 = (o) => o + 4 <= end ? (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)) : 0;
        if (u16(t + 2) !== 0x2A) return null;
        const ifd0 = t + u32(t + 4);
        // One IFD entry is tag(2) type(2) count(4) value(4); an ASCII string
        // longer than four bytes lives at an offset from the TIFF header.
        const entry = (ifd, tag) => {
          if (ifd + 2 > end) return null;
          const n = u16(ifd);
          for (let k = 0; k < n; k++) {
            const e = ifd + 2 + k * 12;
            if (e + 12 > end) break;
            if (u16(e) === tag) return e;
          }
          return null;
        };
        const ascii = (ifd, tag) => {
          const e = entry(ifd, tag);
          if (e == null) return "";
          const count = u32(e + 4);
          if (count < 2 || count > 64) return "";
          const at = count <= 4 ? e + 8 : t + u32(e + 8);
          if (at < 0 || at + count > end) return "";
          return buf.toString("latin1", at, at + count - 1);   // drop the NUL
        };
        let stamp = "";
        const ptr = entry(ifd0, 0x8769);
        if (ptr != null) stamp = ascii(t + u32(ptr + 8), 0x9003);
        if (!stamp) stamp = ascii(ifd0, 0x0132);
        return parseExifStamp(stamp);
      }
      i += 2 + len;
    }
  } catch {}
  return null;
}

// "2026:09:04 08:13:15" — EXIF has no timezone, so it is read as UTC. Only the
// ORDER of the pages matters here, and every photo in one book carries the same
// (missing) zone, so a shift cannot reorder them.
function parseExifStamp(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || "").trim());
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m.map(Number);
  const ms = Date.UTC(Y, Mo - 1, D, H, Mi, S);
  return Number.isFinite(ms) ? ms : null;
}

module.exports = { ensureCodecs, decodeJpg, readJpg, scaleRgba, encodeJpg, writeJpg, exifDate };
