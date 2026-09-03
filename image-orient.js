// image-orient.js — phone photos arrive sideways. A JPEG from a phone is
// stored the way the sensor saw it and carries an EXIF Orientation tag that
// says how to turn it; every viewer applies the tag, our decoder (jpeg-js)
// does not. Ignoring it fed the Clothing Picker sideways and upside-down
// garments, and the vision model — the only correction we had — is a coin
// toss on a flat-laid tee at 180° (dad 9/3: "some upside down images").
// HEIC is not affected: libheif applies irot/imir itself while decoding.
// Pure buffer math, no dependencies, so tests can drive it directly.
"use strict";

// EXIF Orientation (1..8) of a JPEG buffer; 1 when absent or unreadable.
// Walks the marker segments up to the scan and reads IFD0 tag 0x0112.
function exifOrientation(buf) {
  try {
    if (!buf || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return 1;
    let i = 2;
    while (i + 4 <= buf.length && buf[i] === 0xFF) {
      const marker = buf[i + 1];
      if (marker === 0xDA || marker === 0xD9) break;        // scan / end: no more headers
      const len = buf.readUInt16BE(i + 2);
      if (marker === 0xE1 && buf.toString("latin1", i + 4, i + 10) === "Exif\0\0") {
        const t = i + 10;                                   // TIFF header
        const end = Math.min(buf.length, i + 2 + len);
        const order = buf.toString("latin1", t, t + 2);
        if (order !== "II" && order !== "MM") return 1;
        const le = order === "II";
        const u16 = (o) => o + 2 <= end ? (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : 0;
        const u32 = (o) => o + 4 <= end ? (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)) : 0;
        if (u16(t + 2) !== 0x2A) return 1;
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (e + 12 > end) break;
          if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
        }
        return 1;
      }
      i += 2 + len;
    }
  } catch {}
  return 1;
}

// Rotate an RGBA image clockwise by 0/90/180/270.
function rotateRgba(img, deg) {
  const { data, width: w, height: h } = img;
  if (!deg) return img;
  const [nw, nh] = deg === 180 ? [w, h] : [h, w];
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let nx, ny;
    if (deg === 90) { nx = h - 1 - y; ny = x; }
    else if (deg === 180) { nx = w - 1 - x; ny = h - 1 - y; }
    else { nx = y; ny = w - 1 - x; }
    const si = (y * w + x) * 4, di = (ny * nw + nx) * 4;
    out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255;
  }
  return { data: out, width: nw, height: nh };
}

// Mirror left-right.
function flipRgba(img) {
  const { data, width: w, height: h } = img;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (y * w + x) * 4, di = (y * w + (w - 1 - x)) * 4;
    out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255;
  }
  return { data: out, width: w, height: h };
}

// Turn a decoded image the way its EXIF Orientation says a viewer would.
// 1 as-is · 2 mirror · 3 turn 180 · 4 mirror+180 · 5 mirror+270 · 6 turn 90
// clockwise · 7 mirror+90 · 8 turn 270 clockwise.
const UPRIGHT = { 1: [0, false], 2: [0, true], 3: [180, false], 4: [180, true],
                  5: [270, true], 6: [90, false], 7: [90, true], 8: [270, false] };
function upright(img, orientation) {
  const [deg, mirror] = UPRIGHT[orientation] || UPRIGHT[1];
  let out = mirror ? flipRgba(img) : img;
  return rotateRgba(out, deg);
}

module.exports = { exifOrientation, rotateRgba, flipRgba, upright };
