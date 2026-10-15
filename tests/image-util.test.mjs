// image-util.test.mjs — the shared pure-JS JPEG path (decode → turn upright →
// scale → encode) that the Clothing Picker has used since 8/31 and the book
// ingest step now shares. Pixels only: no server, no port, no network, no key.
// (Port table: this suite claims none — plan §B, Gap 21.)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const img = require(path.join(HUB, "image-util.js"));
const jpeg = require(path.join(HUB, "vendor/jpeg-js"));

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), "era-imgutil-" + tag + "-"));

// A w×h image whose every pixel is unique: R = x, G = y — the same trick
// image-orient.test.mjs uses, so a turn is visible in one pixel read.
function grid(w, h) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    data[i] = x % 256; data[i + 1] = y % 256; data[i + 2] = 0; data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}
const solid = (w, h, r) => {
  const data = Buffer.alloc(w * h * 4, 255);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = 0; data[i * 4 + 2] = 0; }
  return { data, width: w, height: h };
};

// Splice an APP1/Exif block carrying the given IFD0 entries into a JPEG.
// entries: [{tag, type, count, value}] where value is already the 4-byte
// inline field (SHORT) — enough for Orientation and an Exif-IFD pointer.
function withExif(jpg, build) {
  const t = build();                        // TIFF block, offsets relative to its own start
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1, 0, 0]), Buffer.from("Exif\0\0", "latin1"), t]);
  app1.writeUInt16BE(app1.length - 2, 2);
  return Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]);
}

// IFD0 { Orientation } — byte order picked by the caller, like a real phone.
function orientationTiff(orientation, bigEndian = false) {
  const t = Buffer.alloc(26);
  if (bigEndian) {
    t.write("MM", 0, "latin1"); t.writeUInt16BE(0x2A, 2); t.writeUInt32BE(8, 4); t.writeUInt16BE(1, 8);
    t.writeUInt16BE(0x0112, 10); t.writeUInt16BE(3, 12); t.writeUInt32BE(1, 14); t.writeUInt16BE(orientation, 18);
  } else {
    t.write("II", 0, "latin1"); t.writeUInt16LE(0x2A, 2); t.writeUInt32LE(8, 4); t.writeUInt16LE(1, 8);
    t.writeUInt16LE(0x0112, 10); t.writeUInt16LE(3, 12); t.writeUInt32LE(1, 14); t.writeUInt16LE(orientation, 18);
  }
  return t;
}

// IFD0 { ExifIFDPointer } → ExifIFD { DateTimeOriginal }, the shape a phone
// actually writes (the timestamp lives in the sub-IFD, not in IFD0).
function dateTiff(stamp, bigEndian = false, tag = 0x9003) {
  const s = Buffer.from(stamp + "\0", "latin1");             // ASCII, NUL-terminated
  const head = 8, ifd0 = 8, ifd0Len = 2 + 12 + 4;            // one entry + next-IFD
  const sub = ifd0 + ifd0Len, subLen = 2 + 12 + 4;
  const strAt = sub + subLen;
  const t = Buffer.alloc(strAt + s.length);
  const le = !bigEndian;
  const w16 = (o, v) => le ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o);
  const w32 = (o, v) => le ? t.writeUInt32LE(v, o) : t.writeUInt32BE(v, o);
  t.write(le ? "II" : "MM", 0, "latin1"); w16(2, 0x2A); w32(4, head);
  w16(ifd0, 1);
  w16(ifd0 + 2, 0x8769); w16(ifd0 + 4, 4); w32(ifd0 + 6, 1); w32(ifd0 + 10, sub);
  w32(ifd0 + 2 + 12, 0);
  w16(sub, 1);
  w16(sub + 2, tag); w16(sub + 4, 2); w32(sub + 6, s.length); w32(sub + 10, strAt);
  w32(sub + 2 + 12, 0);
  s.copy(t, strAt);
  return t;
}

// ---------------------------------------------------------------- decode/encode

test("a 1x1 JPEG survives the round trip", () => {
  const dir = tmp("tiny");
  const file = path.join(dir, "one.jpg");
  img.writeJpg({ data: Buffer.from([200, 10, 10, 255]), width: 1, height: 1 }, file, 90);
  const back = img.readJpg(file);
  assert.equal(back.width, 1);
  assert.equal(back.height, 1);
  assert.equal(back.data.length, 4);
  assert.ok(back.data[0] > 150, "a red pixel stays red-ish through a lossy codec");
});

test("readJpg hands back a real Buffer, not the codec's view", () => {
  const dir = tmp("buf");
  const file = path.join(dir, "g.jpg");
  img.writeJpg(grid(8, 8), file, 92);
  const a = img.readJpg(file);
  assert.ok(Buffer.isBuffer(a.data));
  a.data[0] = 1;                                   // mutating one read must not touch the next
  assert.notEqual(img.readJpg(file).data[0], 1);
});

test("decodeJpg reads a buffer without touching the disk", () => {
  const buf = img.encodeJpg(grid(4, 4), 90);
  const d = img.decodeJpg(buf);
  assert.equal(d.width, 4);
  assert.equal(d.height, 4);
  assert.ok(Buffer.isBuffer(d.data));
});

// ---------------------------------------------------------------- scaleRgba

test("scaleRgba caps the long edge and leaves smaller images alone", () => {
  const wide = solid(3000, 100, 12);
  const s = img.scaleRgba(wide, 2048);
  assert.equal(s.width, 2048);
  assert.equal(s.height, Math.max(1, Math.round(100 * 2048 / 3000)));
  assert.equal(s.data.length, s.width * s.height * 4);
  const tall = solid(50, 4000, 7);
  assert.equal(img.scaleRgba(tall, 2048).height, 2048);
  const small = grid(10, 10);
  assert.equal(img.scaleRgba(small, 2048), small, "under the cap the same object comes back");
});

// ---------------------------------------------------------------- orientation

test("readJpg turns the pixels the way EXIF Orientation 6 says", () => {
  const dir = tmp("orient");
  const plain = jpeg.encode(grid(2, 3), 100).data;
  const turned = path.join(dir, "turned.jpg");
  fs.writeFileSync(turned, withExif(plain, () => orientationTiff(6)));
  const out = img.readJpg(turned);
  assert.equal(out.width, 3, "a portrait shot becomes landscape");
  assert.equal(out.height, 2);
  const flat = path.join(dir, "flat.jpg");
  fs.writeFileSync(flat, plain);
  assert.equal(img.readJpg(flat).width, 2, "no EXIF, no turn");
});

// ---------------------------------------------------------------- exifDate

test("exifDate reads DateTimeOriginal in either byte order", () => {
  const plain = jpeg.encode(grid(2, 2), 90).data;
  const le = img.exifDate(withExif(plain, () => dateTiff("2026:09:04 08:13:15")));
  assert.equal(le, Date.UTC(2026, 8, 4, 8, 13, 15));
  const be = img.exifDate(withExif(plain, () => dateTiff("2019:01:02 03:04:05", true)));
  assert.equal(be, Date.UTC(2019, 0, 2, 3, 4, 5));
});

test("exifDate falls back to IFD0 DateTime and returns null when there is none", () => {
  const plain = jpeg.encode(grid(2, 2), 90).data;
  assert.equal(img.exifDate(plain), null, "no EXIF at all");
  assert.equal(img.exifDate(withExif(plain, () => orientationTiff(6))), null, "EXIF without a stamp");
  assert.equal(img.exifDate(Buffer.from("not a jpeg")), null);
  assert.equal(img.exifDate(Buffer.alloc(0)), null);
  const junk = img.exifDate(withExif(plain, () => dateTiff("hello there")));
  assert.equal(junk, null, "an unparseable stamp is no stamp");
  const truncated = withExif(plain, () => dateTiff("2026:09:04 08:13:15")).subarray(0, 24);
  assert.equal(img.exifDate(truncated), null, "a truncated header does not throw");
});
