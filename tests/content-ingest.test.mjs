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

test("loose photos become sources/ plus ordered pages/NNN.jpg", async () => {
  const dir = book("basic");
  drop(dir, "a.jpg", photo(20, 30, 10));
  drop(dir, "b.jpg", photo(20, 30, 200));
  const out = await ingest.ingest(dir);

  assert.deepEqual(fs.readdirSync(path.join(dir, "sources")).sort(), ["a.jpg", "b.jpg"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "pages")).sort(), ["001.jpg", "002.jpg"]);
  assert.equal(fs.existsSync(path.join(dir, "a.jpg")), false, "the original was MOVED, not copied");
  assert.equal(out.pages.length, 2);
  assert.deepEqual(out.pages[0], { index: 1, source: "sources/a.jpg", image: "pages/001.jpg", copied: false });
  assert.equal(out.skipped, false);
  assert.ok(pageShade(dir, "001.jpg") < 60 && pageShade(dir, "002.jpg") > 150, "page 1 is a.jpg");
});

test("a big photo is scaled to a long edge of 2048; a small one is left alone", async () => {
  const dir = book("scale");
  drop(dir, "wide.jpg", photo(3000, 60, 90));
  drop(dir, "small.jpg", photo(40, 20, 90));
  await ingest.ingest(dir);
  const wide = imageUtil.readJpg(path.join(dir, "pages", "002.jpg"));   // "wide" sorts after "small"
  assert.equal(wide.width, 2048);
  const small = imageUtil.readJpg(path.join(dir, "pages", "001.jpg"));
  assert.deepEqual([small.width, small.height], [40, 20]);
});

// ----------------------------------------------------------------- ordering

test("EXIF DateTimeOriginal beats the filename", async () => {
  const dir = book("exif-order");
  drop(dir, "a.jpg", withDate(photo(20, 20, 10), "2026:09:04 10:00:00"));
  drop(dir, "b.jpg", withDate(photo(20, 20, 200), "2026:09:04 09:00:00"));
  const out = await ingest.ingest(dir);
  assert.deepEqual(out.pages.map(p => p.source), ["sources/b.jpg", "sources/a.jpg"]);
  assert.ok(pageShade(dir, "001.jpg") > 150, "the earlier shot is page 1 even though it sorts second");
});

test("no timestamps: natural filename order, so img2 comes before img10", async () => {
  const dir = book("name-order");
  drop(dir, "img10.jpg", photo(20, 20, 10));
  drop(dir, "img2.jpg", photo(20, 20, 200));
  const out = await ingest.ingest(dir);
  assert.deepEqual(out.pages.map(p => p.source), ["sources/img2.jpg", "sources/img10.jpg"]);
});

test("one missing timestamp drops the whole book back to filename order", async () => {
  const dir = book("mixed-order");
  drop(dir, "p1.jpg", withDate(photo(20, 20, 10), "2026:09:04 12:00:00"));
  drop(dir, "p2.jpg", photo(20, 20, 200));                      // no EXIF at all
  const out = await ingest.ingest(dir);
  assert.deepEqual(out.pages.map(p => p.source), ["sources/p1.jpg", "sources/p2.jpg"]);
  assert.match(logLines(dir), /filename order/i);
});

test("orderPages is a pure function over {name, taken}", async () => {
  const by = (l) => ingest.orderPages(l).map(e => e.name);
  assert.deepEqual(by([{ name: "b.jpg", taken: 1 }, { name: "a.jpg", taken: 2 }]), ["b.jpg", "a.jpg"]);
  assert.deepEqual(by([{ name: "b.jpg", taken: null }, { name: "a.jpg", taken: 2 }]), ["a.jpg", "b.jpg"]);
  assert.deepEqual(by([{ name: "x2.jpg", taken: 5 }, { name: "x10.jpg", taken: 5 }]), ["x2.jpg", "x10.jpg"]);
});

// ----------------------------------------------------------------- fallback

test("a photo that will not decode is copied through untouched and the log says why", async () => {
  const dir = book("corrupt");
  const junk = Buffer.from("this is not a JPEG, it is a note from a parent");
  drop(dir, "a.jpg", photo(20, 20, 10));
  drop(dir, "broken.jpg", junk);
  const out = await ingest.ingest(dir);

  assert.equal(out.pages.length, 2);
  assert.equal(out.copied, 1);
  assert.equal(out.pages[1].copied, true);
  assert.deepEqual(fs.readFileSync(path.join(dir, "pages", "002.jpg")), junk, "byte-for-byte the original");
  assert.match(logLines(dir), /broken\.jpg/);
  assert.match(logLines(dir), /original/i);
});

// -------------------------------------------------------------- idempotence

test("re-running with unchanged inputs is a no-op", async () => {
  const dir = book("idem");
  drop(dir, "a.jpg", photo(20, 30, 10));
  drop(dir, "b.jpg", photo(20, 30, 200));
  const first = await ingest.ingest(dir);
  const stamp = (n) => fs.statSync(path.join(dir, "pages", n)).mtimeMs;
  const before = [stamp("001.jpg"), stamp("002.jpg")];

  const again = await ingest.ingest(dir);
  assert.equal(again.skipped, true);
  assert.equal(again.wrote, 0);
  assert.deepEqual(again.pages, first.pages);
  assert.deepEqual([stamp("001.jpg"), stamp("002.jpg")], before, "nothing was rewritten");
  assert.deepEqual(fs.readdirSync(path.join(dir, "pages")).sort(), ["001.jpg", "002.jpg"], "no .tmp litter");
});

// The builder's OWN output sits in the book root beside the parent's photos:
// content-publish.js writes cover.jpg there. Swallowing it into sources/ would
// make it page 1 and shift every page index by one, orphaning every text.json
// entry and every audio/NNN.mp3 — and the shelf would lose its cover.
test("the cover the publish step wrote is never taken in as a page", async () => {
  const dir = book("cover");
  drop(dir, "a.jpg", photo(20, 30, 10));
  drop(dir, "b.jpg", photo(20, 30, 200));
  const first = await ingest.ingest(dir);
  // what publish does next: page 1's bytes, copied to the book root
  fs.copyFileSync(path.join(dir, "pages", "001.jpg"), path.join(dir, "cover.jpg"));

  const again = await ingest.ingest(dir);
  assert.equal(again.skipped, true, "a published book re-ingests to nothing at all");
  assert.deepEqual(again.pages, first.pages);
  assert.deepEqual(fs.readdirSync(path.join(dir, "sources")).sort(), ["a.jpg", "b.jpg"],
    "cover.jpg must never land in sources/");
  assert.ok(fs.existsSync(path.join(dir, "cover.jpg")), "and the shelf's cover stays where it was");
});

test("a new photo re-runs the step and renumbers; a vanished page is swept", async () => {
  const dir = book("renumber");
  drop(dir, "b.jpg", photo(20, 20, 200));
  await ingest.ingest(dir);
  drop(dir, "a.jpg", photo(20, 20, 10));
  const out = await ingest.ingest(dir);
  assert.equal(out.skipped, false);
  assert.deepEqual(out.pages.map(p => p.image), ["pages/001.jpg", "pages/002.jpg"]);
  assert.ok(pageShade(dir, "001.jpg") < 60, "the newcomer took page 1");

  fs.unlinkSync(path.join(dir, "sources", "b.jpg"));
  const shrunk = await ingest.ingest(dir);
  assert.equal(shrunk.pages.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, "pages")), ["001.jpg"], "page 2 was swept");
});

test("a page missing from disk is rebuilt even when the listing is unchanged", async () => {
  const dir = book("heal");
  drop(dir, "a.jpg", photo(20, 20, 10));
  await ingest.ingest(dir);
  fs.unlinkSync(path.join(dir, "pages", "001.jpg"));
  const out = await ingest.ingest(dir);
  assert.equal(out.skipped, false);
  assert.equal(fs.existsSync(path.join(dir, "pages", "001.jpg")), true);
});

// ------------------------------------------------------------ what it leaves

test("everything that is not a photo is left where it is", async () => {
  const dir = book("bystanders");
  fs.mkdirSync(path.join(dir, ".build"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".build", "job.json"), "{}");
  fs.writeFileSync(path.join(dir, "notes.txt"), "read this one at bedtime");
  drop(dir, "a.jpg", photo(20, 20, 10));
  const out = await ingest.ingest(dir);
  assert.equal(out.pages.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), "read this one at bedtime");
  assert.equal(fs.readFileSync(path.join(dir, ".build", "job.json"), "utf8"), "{}");
});

test("a folder with no photos at all is a no-op, not a crash", async () => {
  const dir = book("empty");
  const out = await ingest.ingest(dir);
  assert.deepEqual(out.pages, []);
  assert.equal(out.skipped, true);
  assert.equal(fs.existsSync(path.join(dir, "pages")), false);
});

test("a loose photo whose name is already taken in sources/ keeps both", async () => {
  const dir = book("collide");
  drop(dir, "a.jpg", photo(20, 20, 10));
  await ingest.ingest(dir);
  drop(dir, "a.jpg", photo(20, 20, 200));            // a second phone, same camera name
  const out = await ingest.ingest(dir);
  assert.equal(out.pages.length, 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, "sources")).sort(), ["a-2.jpg", "a.jpg"]);
});

// ------------------------------------------------ iPhone photos (HEIC), 9/7
// Every one of the seventeen photos dad dropped into books/ that day was a
// .HEIC, and until 9/7 the two halves of the hub disagreed about them:
// content.js counted them (clothing-photos.js has listed HEIC since 8/31),
// claimed the folder and wrote a job.json — and this step called them
// "strangers" and made no pages at all. A book that was started and then built
// nothing, with a card that said it was reading the photos.
//
// The decoder itself is clothing-worker's libheif, which rides in the BOARD
// pack. There is no HEIC ENCODER anywhere in the suite, so a synthetic .heic
// cannot be built and a real one is a photograph of a page of this family's
// own book — which never comes near a test. So the decoder is stood in for
// (ingest.decodeHeic / ingest.heifReady, replaceable in one place the way
// content.js's runJob is) and what is proved here is this file's own rules.

const heicBytes = Buffer.from("ftypheic — not a real HEIC, and it never has to be");
const withHeif = (decode) => {
  ingest.heifReady = () => true;
  ingest.decodeHeic = decode;
};
const noHeif = () => { ingest.heifReady = () => false; };
const realHeif = () => { ingest.heifReady = heifReadyWas; ingest.decodeHeic = decodeHeicWas; };
const heifReadyWas = ingest.heifReady, decodeHeicWas = ingest.decodeHeic;
const rgba = (w, h, shade) => {
  const data = Buffer.alloc(w * h * 4, 255);
  for (let i = 0; i < w * h; i++) { data[i * 4] = shade; data[i * 4 + 1] = shade; data[i * 4 + 2] = shade; }
  return { data, width: w, height: h };
};

test("iPhone photos with no decoder installed: the book waits, and keeps every photo", async () => {
  const dir = book("heic-nopack");
  noHeif();
  drop(dir, "IMG_0001.HEIC", heicBytes);
  drop(dir, "IMG_0002.HEIC", heicBytes);
  const out = await ingest.ingest(dir);
  realHeif();

  assert.equal(out.hold, "needs-photo-decoder", "a hold, not a failure and not a silent nothing");
  assert.deepEqual(fs.readdirSync(path.join(dir, "sources")).sort(), ["IMG_0001.HEIC", "IMG_0002.HEIC"],
    "both photos are kept, exactly as they were");
  assert.equal(fs.existsSync(path.join(dir, "pages")), false, "and no half-built book is left behind");
  assert.equal(fs.existsSync(path.join(dir, ".build", "ingest.json")), false,
    "nothing is recorded as built");
  assert.match(logLines(dir), /HEIC/);
});

test("an iPhone photo becomes a JPEG page, in order beside the JPEGs", async () => {
  const dir = book("heic-ok");
  withHeif(async () => rgba(20, 30, 200));
  drop(dir, "img1.jpg", photo(20, 30, 10));
  drop(dir, "img2.HEIC", heicBytes);
  const out = await ingest.ingest(dir);
  realHeif();

  assert.equal(out.hold, undefined);
  assert.equal(out.pages.length, 2);
  assert.deepEqual(out.pages.map(p => p.source), ["sources/img1.jpg", "sources/img2.HEIC"]);
  assert.deepEqual(out.pages.map(p => p.image), ["pages/001.jpg", "pages/002.jpg"]);
  assert.ok(pageShade(dir, "002.jpg") > 150, "the HEIC's pixels came through as a real JPEG page");
});

test("a HEIC that will not open is not a page — and it is NEVER copied through", async () => {
  const dir = book("heic-broken");
  withHeif(async (buf) => {
    if (buf.equals(heicBytes)) throw new Error("this HEIC could not be opened");
    return rgba(20, 30, 200);
  });
  drop(dir, "a.HEIC", heicBytes);                    // the one that fails
  drop(dir, "b.HEIC", Buffer.from("a different one"));
  const out = await ingest.ingest(dir);
  realHeif();

  assert.equal(out.lost, 1);
  assert.equal(out.pages.length, 1, "the book is built without it, not stopped by it");
  assert.equal(out.pages[0].index, 1, "and the pages that did work are numbered 1..N");
  assert.equal(out.pages[0].source, "sources/b.HEIC");
  assert.deepEqual(fs.readdirSync(path.join(dir, "pages")), ["001.jpg"]);
  // The copy-through law is a JPEG law: a .heic renamed .jpg is a page no
  // browser shows and no vision provider accepts.
  assert.notDeepEqual(fs.readFileSync(path.join(dir, "pages", "001.jpg")), heicBytes);
  assert.match(logLines(dir), /a\.HEIC/);
});

test("every photo failed: the book waits rather than recording that it has none", async () => {
  const dir = book("heic-all-broken");
  withHeif(async () => { throw new Error("this HEIC could not be opened"); });
  drop(dir, "a.HEIC", heicBytes);
  const out = await ingest.ingest(dir);
  realHeif();

  assert.equal(out.hold, "unreadable-photos");
  assert.equal(fs.existsSync(path.join(dir, ".build", "ingest.json")), false);
  assert.deepEqual(fs.readdirSync(path.join(dir, "sources")), ["a.HEIC"], "the photo is still there");
});

test("a folder of files we have no decoder for is not an empty folder", async () => {
  const dir = book("only-png");
  drop(dir, "page1.png", Buffer.from("PNG, and the hub ships no PNG decoder"));
  const out = await ingest.ingest(dir);
  assert.equal(out.hold, "unreadable-photos", "it says so rather than walking on with nothing");
  assert.deepEqual(out.strangers, ["page1.png"]);
  assert.equal(fs.existsSync(path.join(dir, "page1.png")), true, "and the file is left where it is");
});
