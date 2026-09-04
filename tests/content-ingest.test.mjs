// content-ingest.test.mjs — step 1 of the book builder (spec §4.1): the loose
// photos a parent dropped into books/<Title>/ become sources/ plus an ordered,
// upright, downscaled pages/NNN.jpg set. Pure disk work in a temp folder: no
// server, no port, no network, no key, no spawn (plan Gap 7 — the resize is
// the hub's own vendored JPEG path, not ImageMagick).
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
const ingest = require(path.join(HUB, "content-ingest.js"));
const imageUtil = require(path.join(HUB, "image-util.js"));
const store = require(path.join(HUB, "content-store.js"));

const book = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), "era-ingest-" + tag + "-"));

// A solid-colour photo: shade encodes which page it is, so page order can be
// read straight off the written pixels.
function photo(w, h, shade) {
  const data = Buffer.alloc(w * h * 4, 255);
  for (let i = 0; i < w * h; i++) { data[i * 4] = shade; data[i * 4 + 1] = shade; data[i * 4 + 2] = shade; }
  return imageUtil.encodeJpg({ data, width: w, height: h }, 92);
}

// IFD0 { ExifIFDPointer } → ExifIFD { DateTimeOriginal }, spliced in as APP1 —
// the shape a phone writes. (image-util.test.mjs builds the same block; this
// suite needs it to prove ordering, not parsing.)
function withDate(jpg, stamp) {
  const s = Buffer.from(stamp + "\0", "latin1");
  const ifd0 = 8, sub = ifd0 + 18, strAt = sub + 18;
  const t = Buffer.alloc(strAt + s.length);
  t.write("II", 0, "latin1"); t.writeUInt16LE(0x2A, 2); t.writeUInt32LE(8, 4);
  t.writeUInt16LE(1, ifd0);
  t.writeUInt16LE(0x8769, ifd0 + 2); t.writeUInt16LE(4, ifd0 + 4);
  t.writeUInt32LE(1, ifd0 + 6); t.writeUInt32LE(sub, ifd0 + 10);
  t.writeUInt32LE(0, ifd0 + 14);
  t.writeUInt16LE(1, sub);
  t.writeUInt16LE(0x9003, sub + 2); t.writeUInt16LE(2, sub + 4);
  t.writeUInt32LE(s.length, sub + 6); t.writeUInt32LE(strAt, sub + 10);
  t.writeUInt32LE(0, sub + 14);
  s.copy(t, strAt);
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1, 0, 0]), Buffer.from("Exif\0\0", "latin1"), t]);
  app1.writeUInt16BE(app1.length - 2, 2);
  return Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]);
}

const drop = (dir, name, buf) => fs.writeFileSync(path.join(dir, name), buf);
const pageShade = (dir, n) => imageUtil.readJpg(path.join(dir, "pages", n)).data[0];
const logLines = (dir) => store.readLog(dir).map(l => l.msg).join("\n");

// ------------------------------------------------------------------- basics

test("loose photos become sources/ plus ordered pages/NNN.jpg", () => {
  const dir = book("basic");
  drop(dir, "a.jpg", photo(20, 30, 10));
  drop(dir, "b.jpg", photo(20, 30, 200));
  const out = ingest.ingest(dir);

  assert.deepEqual(fs.readdirSync(path.join(dir, "sources")).sort(), ["a.jpg", "b.jpg"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "pages")).sort(), ["001.jpg", "002.jpg"]);
  assert.equal(fs.existsSync(path.join(dir, "a.jpg")), false, "the original was MOVED, not copied");
  assert.equal(out.pages.length, 2);
  assert.deepEqual(out.pages[0], { index: 1, source: "sources/a.jpg", image: "pages/001.jpg", copied: false });
  assert.equal(out.skipped, false);
  assert.ok(pageShade(dir, "001.jpg") < 60 && pageShade(dir, "002.jpg") > 150, "page 1 is a.jpg");
});

test("a big photo is scaled to a long edge of 2048; a small one is left alone", () => {
  const dir = book("scale");
  drop(dir, "wide.jpg", photo(3000, 60, 90));
  drop(dir, "small.jpg", photo(40, 20, 90));
  ingest.ingest(dir);
  const wide = imageUtil.readJpg(path.join(dir, "pages", "002.jpg"));   // "wide" sorts after "small"
  assert.equal(wide.width, 2048);
  const small = imageUtil.readJpg(path.join(dir, "pages", "001.jpg"));
  assert.deepEqual([small.width, small.height], [40, 20]);
});

// ----------------------------------------------------------------- ordering

test("EXIF DateTimeOriginal beats the filename", () => {
  const dir = book("exif-order");
  drop(dir, "a.jpg", withDate(photo(20, 20, 10), "2026:09:04 10:00:00"));
  drop(dir, "b.jpg", withDate(photo(20, 20, 200), "2026:09:04 09:00:00"));
  const out = ingest.ingest(dir);
  assert.deepEqual(out.pages.map(p => p.source), ["sources/b.jpg", "sources/a.jpg"]);
  assert.ok(pageShade(dir, "001.jpg") > 150, "the earlier shot is page 1 even though it sorts second");
});

test("no timestamps: natural filename order, so img2 comes before img10", () => {
  const dir = book("name-order");
  drop(dir, "img10.jpg", photo(20, 20, 10));
  drop(dir, "img2.jpg", photo(20, 20, 200));
  const out = ingest.ingest(dir);
  assert.deepEqual(out.pages.map(p => p.source), ["sources/img2.jpg", "sources/img10.jpg"]);
});

test("one missing timestamp drops the whole book back to filename order", () => {
  const dir = book("mixed-order");
  drop(dir, "p1.jpg", withDate(photo(20, 20, 10), "2026:09:04 12:00:00"));
  drop(dir, "p2.jpg", photo(20, 20, 200));                      // no EXIF at all
  const out = ingest.ingest(dir);
  assert.deepEqual(out.pages.map(p => p.source), ["sources/p1.jpg", "sources/p2.jpg"]);
  assert.match(logLines(dir), /filename order/i);
});

test("orderPages is a pure function over {name, taken}", () => {
  const by = (l) => ingest.orderPages(l).map(e => e.name);
  assert.deepEqual(by([{ name: "b.jpg", taken: 1 }, { name: "a.jpg", taken: 2 }]), ["b.jpg", "a.jpg"]);
  assert.deepEqual(by([{ name: "b.jpg", taken: null }, { name: "a.jpg", taken: 2 }]), ["a.jpg", "b.jpg"]);
  assert.deepEqual(by([{ name: "x2.jpg", taken: 5 }, { name: "x10.jpg", taken: 5 }]), ["x2.jpg", "x10.jpg"]);
});

// ----------------------------------------------------------------- fallback

test("a photo that will not decode is copied through untouched and the log says why", () => {
  const dir = book("corrupt");
  const junk = Buffer.from("this is not a JPEG, it is a note from a parent");
  drop(dir, "a.jpg", photo(20, 20, 10));
  drop(dir, "broken.jpg", junk);
  const out = ingest.ingest(dir);

  assert.equal(out.pages.length, 2);
  assert.equal(out.copied, 1);
  assert.equal(out.pages[1].copied, true);
  assert.deepEqual(fs.readFileSync(path.join(dir, "pages", "002.jpg")), junk, "byte-for-byte the original");
  assert.match(logLines(dir), /broken\.jpg/);
  assert.match(logLines(dir), /original/i);
});

// -------------------------------------------------------------- idempotence

test("re-running with unchanged inputs is a no-op", () => {
  const dir = book("idem");
  drop(dir, "a.jpg", photo(20, 30, 10));
  drop(dir, "b.jpg", photo(20, 30, 200));
  const first = ingest.ingest(dir);
  const stamp = (n) => fs.statSync(path.join(dir, "pages", n)).mtimeMs;
  const before = [stamp("001.jpg"), stamp("002.jpg")];

  const again = ingest.ingest(dir);
  assert.equal(again.skipped, true);
  assert.equal(again.wrote, 0);
  assert.deepEqual(again.pages, first.pages);
  assert.deepEqual([stamp("001.jpg"), stamp("002.jpg")], before, "nothing was rewritten");
  assert.deepEqual(fs.readdirSync(path.join(dir, "pages")).sort(), ["001.jpg", "002.jpg"], "no .tmp litter");
});

test("a new photo re-runs the step and renumbers; a vanished page is swept", () => {
  const dir = book("renumber");
  drop(dir, "b.jpg", photo(20, 20, 200));
  ingest.ingest(dir);
  drop(dir, "a.jpg", photo(20, 20, 10));
  const out = ingest.ingest(dir);
  assert.equal(out.skipped, false);
  assert.deepEqual(out.pages.map(p => p.image), ["pages/001.jpg", "pages/002.jpg"]);
  assert.ok(pageShade(dir, "001.jpg") < 60, "the newcomer took page 1");

  fs.unlinkSync(path.join(dir, "sources", "b.jpg"));
  const shrunk = ingest.ingest(dir);
  assert.equal(shrunk.pages.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, "pages")), ["001.jpg"], "page 2 was swept");
});

test("a page missing from disk is rebuilt even when the listing is unchanged", () => {
  const dir = book("heal");
  drop(dir, "a.jpg", photo(20, 20, 10));
  ingest.ingest(dir);
  fs.unlinkSync(path.join(dir, "pages", "001.jpg"));
  const out = ingest.ingest(dir);
  assert.equal(out.skipped, false);
  assert.equal(fs.existsSync(path.join(dir, "pages", "001.jpg")), true);
});

// ------------------------------------------------------------ what it leaves

test("everything that is not a photo is left where it is", () => {
  const dir = book("bystanders");
  fs.mkdirSync(path.join(dir, ".build"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".build", "job.json"), "{}");
  fs.writeFileSync(path.join(dir, "notes.txt"), "read this one at bedtime");
  drop(dir, "a.jpg", photo(20, 20, 10));
  const out = ingest.ingest(dir);
  assert.equal(out.pages.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), "read this one at bedtime");
  assert.equal(fs.readFileSync(path.join(dir, ".build", "job.json"), "utf8"), "{}");
});

test("a folder with no photos at all is a no-op, not a crash", () => {
  const dir = book("empty");
  const out = ingest.ingest(dir);
  assert.deepEqual(out.pages, []);
  assert.equal(out.skipped, true);
  assert.equal(fs.existsSync(path.join(dir, "pages")), false);
});

test("a loose photo whose name is already taken in sources/ keeps both", () => {
  const dir = book("collide");
  drop(dir, "a.jpg", photo(20, 20, 10));
  ingest.ingest(dir);
  drop(dir, "a.jpg", photo(20, 20, 200));            // a second phone, same camera name
  const out = ingest.ingest(dir);
  assert.equal(out.pages.length, 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, "sources")).sort(), ["a-2.jpg", "a.jpg"]);
});
