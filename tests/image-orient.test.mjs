// image-orient.test.mjs — EXIF Orientation is honoured (dad 9/3: upside-down
// garments on the i13 board). Pure-buffer checks of the helper the Clothing
// Picker decodes through; clothing.test.mjs proves the pipeline end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const { exifOrientation, upright, rotateRgba } = require("./image-orient.js");
const jpeg = require("./vendor/jpeg-js");

// 2x3 image with a unique colour per pixel: R = x*100, G = y*100
function grid() {
  const w = 2, h = 3, data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; data[i] = x * 100; data[i + 1] = y * 100; data[i + 2] = 0; data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}
const at = (img, x, y) => [img.data[(y * img.width + x) * 4], img.data[(y * img.width + x) * 4 + 1]];

function withExif(jpg, orientation, bigEndian = false) {
  const t = Buffer.alloc(26);
  if (bigEndian) {
    t.write("MM", 0, "latin1"); t.writeUInt16BE(0x2A, 2); t.writeUInt32BE(8, 4); t.writeUInt16BE(1, 8);
    t.writeUInt16BE(0x0112, 10); t.writeUInt16BE(3, 12); t.writeUInt32BE(1, 14); t.writeUInt16BE(orientation, 18);
  } else {
    t.write("II", 0, "latin1"); t.writeUInt16LE(0x2A, 2); t.writeUInt32LE(8, 4); t.writeUInt16LE(1, 8);
    t.writeUInt16LE(0x0112, 10); t.writeUInt16LE(3, 12); t.writeUInt32LE(1, 14); t.writeUInt16LE(orientation, 18);
  }
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1, 0, 0]), Buffer.from("Exif\0\0", "latin1"), t]);
  app1.writeUInt16BE(app1.length - 2, 2);
  return Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]);
}

test("orientation is read from APP1 in either byte order; absent or junk reads as 1", () => {
  const plain = jpeg.encode(grid(), 90).data;
  assert.equal(exifOrientation(plain), 1, "no EXIF");
  assert.equal(exifOrientation(withExif(plain, 6)), 6, "little-endian");
  assert.equal(exifOrientation(withExif(plain, 8, true)), 8, "big-endian");
  assert.equal(exifOrientation(withExif(plain, 3)), 3);
  assert.equal(exifOrientation(withExif(plain, 9)), 1, "out-of-range value is ignored");
  assert.equal(exifOrientation(Buffer.from("not a jpeg")), 1);
  assert.equal(exifOrientation(Buffer.alloc(0)), 1);
  assert.equal(exifOrientation(withExif(plain, 6).subarray(0, 20)), 1, "truncated header does not throw");
});

test("upright() turns the pixels the way a viewer would for every orientation", () => {
  const g = grid();                       // (x,y) → colour [x*100, y*100]
  assert.deepEqual(at(upright(g, 1), 0, 0), [0, 0]);
  assert.deepEqual(at(upright(g, 2), 0, 0), [100, 0], "2: mirrored — top-right pixel moves to top-left");
  const r180 = upright(g, 3);
  assert.equal(r180.width, 2); assert.deepEqual(at(r180, 0, 0), [100, 200], "3: bottom-right comes to top-left");
  assert.deepEqual(at(upright(g, 4), 0, 0), [0, 200], "4: flipped vertically");
  const r90 = upright(g, 6);
  assert.equal(r90.width, 3); assert.equal(r90.height, 2, "6: portrait becomes landscape");
  assert.deepEqual(at(r90, 2, 0), [0, 0], "6: 90° clockwise — old top-left is now top-right");
  assert.deepEqual(at(r90, 0, 0), [0, 200], "6: old bottom-left is now top-left");
  const r270 = upright(g, 8);
  assert.equal(r270.width, 3);
  assert.deepEqual(at(r270, 0, 0), [100, 0], "8: 270° clockwise — old top-right is now top-left");
  assert.deepEqual(at(upright(g, 5), 0, 0), [0, 0], "5: transpose keeps the corner");
  assert.deepEqual(at(upright(g, 5), 1, 0), [0, 100], "5: transpose swaps x and y");
  assert.deepEqual(at(upright(g, 7), 0, 0), [100, 200], "7: transverse");
  assert.deepEqual(at(upright(g, 42), 0, 0), [0, 0], "unknown value leaves it alone");
});

test("rotateRgba four turns of 90 is the identity", () => {
  let g = grid();
  for (let i = 0; i < 4; i++) g = rotateRgba(g, 90);
  assert.deepEqual([...g.data], [...grid().data]);
});
