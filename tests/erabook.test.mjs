// erabook.test.mjs — the .erabook file format, both directions (plan T1.1).
//
// What this file proves, and why each half matters:
//
//  1. A BOOK SURVIVES THE ROUND TRIP. A package is not a flat pile of files —
//     the real shape (tests/reader-ui.test.mjs:93) is manifest.json + cover.jpg
//     at the root and `pages/001.jpg`, `audio/001.wav`, `video/002.mp4`
//     underneath, and the manifest names those nested paths directly. Pack then
//     unpack must give the receiving family the same bytes under the same
//     names, manifest.json BYTE FOR BYTE, or the book they open is not the book
//     that was sent.
//
//  2. THE ARCHIVE IS A REAL ZIP. Rename it .zip and Explorer opens it. Proven
//     here by reading the signatures the format demands (local headers, a
//     central directory, an EOCD, method 0 everywhere) and, outside this file,
//     by `unzip -l` on a packed fixture — a round trip only our own reader
//     accepts would be a private format wearing a zip's name.
//
//  3. THE JAIL HOLDS. This is the first thing in the hub that takes a file from
//     OUTSIDE the family and writes it to disk, so every refusal below is
//     written as an attack first and is seen to fail before the code exists:
//     `../evil.jpg`, `pages/../../evil.jpg`, `/etc/evil.jpg`, `C:\evil.jpg`,
//     `pages\..\evil.jpg`, a NUL, a directory entry, a symlink entry, an
//     extension off the allowlist, a lying size, a broken CRC, a truncated
//     archive, and the three zip-bomb caps. A jail test that never failed
//     proves nothing about a jail.
//
// The hostile archives are built HERE, by hand, out of raw zip records
// (`rawZip` below) — never by asking erabook.js to make them. A test that can
// only express the attacks its subject is willing to write down is not a test.
//
// No server, no port, no network, no provider: the format is pure bytes on
// disk. Fixture content is synthetic throughout — never a real book.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const erabook = require("./erabook.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-erabook-"));
let n = 0;
const scratch = (what) => {
  const d = path.join(TMP, what + "-" + (++n));
  fs.mkdirSync(d, { recursive: true });
  return d;
};

// ------------------------------------------------------------- the fixture
//
// The shape of a real package, copied from the reader's own fixture: four
// pages, one of them silent, one of them animated, a cover beside the
// manifest. Synthetic bytes — the format never decodes an image or an mp3.
const JPEG = (k) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(48, k)]);
const WAV = (k) => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40, k)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(24, 9)]);

function fixture(opts) {
  const o = opts || {};
  const dir = scratch("book");
  fs.mkdirSync(path.join(dir, "pages"));
  fs.mkdirSync(path.join(dir, "audio"));
  fs.mkdirSync(path.join(dir, "video"));
  for (const p of ["001", "002", "003", "004"]) fs.writeFileSync(path.join(dir, "pages", p + ".jpg"), JPEG(+p));
  for (const p of ["001", "002", "004"]) fs.writeFileSync(path.join(dir, "audio", p + ".wav"), WAV(+p));
  fs.writeFileSync(path.join(dir, "video", "002.mp4"), MP4);
  fs.writeFileSync(path.join(dir, "cover.jpg"), JPEG(0));
  const manifest = {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000002",
    slug: "luna-the-fox",
    title: "Luna the Fox",
    authored: true,
    exportedAt: "2026-08-24T00:00:00Z",
    narration: { provider: "synthetic", model: "fixture", voice: "none" },
    cover: "cover.jpg",
    pages: [
      { index: 0, image: "pages/001.jpg", text: "Luna naps now.", audio: "audio/001.wav",
        words: [{ word: "Luna", start: 0.1, end: 0.8 }] },
      { index: 1, image: "pages/002.jpg", text: "The fox sleeps.", audio: "audio/002.wav",
        video: "video/002.mp4" },
      { index: 2, image: "pages/003.jpg", text: "", audio: null },   // a silent page
      { index: 3, image: "pages/004.jpg", text: "Good night fox.", audio: "audio/004.wav" },
    ],
    ...(o.manifest || {}),
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  // The two directories the export must never carry (spec §3): the originals a
  // parent dropped in, and the builder's scratch.
  fs.mkdirSync(path.join(dir, "sources"));
  fs.writeFileSync(path.join(dir, "sources", "IMG_0001.jpg"), JPEG(7));
  fs.mkdirSync(path.join(dir, ".build"));
  fs.writeFileSync(path.join(dir, ".build", "text.json"), '{"pages":[]}');
  fs.writeFileSync(path.join(dir, "notes.json"), '{"nobody":"named me"}');
  return { dir, manifest };
}

const FROM = { app: "New ERA", build: "20260922.1200" };

async function packToBuffer(dir, manifest, opts) {
  const chunks = [];
  for await (const c of erabook.pack(dir, manifest, opts || { from: FROM })) chunks.push(c);
  return Buffer.concat(chunks);
}

function packedFile(dir, manifest, opts) {
  return packToBuffer(dir, manifest, opts).then((buf) => {
    const f = path.join(scratch("out"), "book.erabook");
    fs.writeFileSync(f, buf);
    return f;
  });
}

const refusal = (code) => (e) => {
  assert.equal(e.code, code, "expected refusal " + code + ", got " + e.code + " (" + e.message + ")");
  return true;
};

// ------------------------------------------------------- hostile zip writer
//
// Every field a real zip carries, settable per entry, so a test can lie in
// exactly one place: a name the jail must refuse, a CRC that does not match
// the bytes, a size larger than the archive holds, a local header that
// disagrees with the central directory, a unix mode that says "symlink".
function rawZip(entries, opts) {
  const o = opts || {};
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "binary");
    const data = e.data || Buffer.alloc(0);
    const crc = e.crc === undefined ? zlib.crc32(data) : e.crc;
    const csize = e.csize === undefined ? data.length : e.csize;
    const usize = e.usize === undefined ? data.length : e.usize;
    const method = e.method === undefined ? 0 : e.method;
    const flags = e.flags === undefined ? 0x0800 : e.flags;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(33, 12);
    lh.writeUInt32LE((e.localCrc === undefined ? crc : e.localCrc) >>> 0, 14);
    lh.writeUInt32LE(e.localCsize === undefined ? csize : e.localCsize, 18);
    lh.writeUInt32LE(e.localUsize === undefined ? usize : e.localUsize, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(e.madeBy === undefined ? 20 : e.madeBy, 4);
    ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(33, 14);
    ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(e.attrs === undefined ? 0 : e.attrs, 38);
    ch.writeUInt32LE(e.offset === undefined ? offset : e.offset, 42);
    parts.push(lh, name, data);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(o.count === undefined ? entries.length : o.count, 8);
  eocd.writeUInt16LE(o.count === undefined ? entries.length : o.count, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, eocd]);
}

const envelopeBytes = (over) => Buffer.from(JSON.stringify({
  v: 1, title: "Luna the Fox", slug: "luna-the-fox", pages: 4,
  exportedAt: "2026-08-24T00:00:00Z", from: FROM, ...(over || {}),
}));
const envelopeEntry = (over) => ({ name: ".erabook.json", data: envelopeBytes(over) });

// An otherwise perfectly good archive with ONE hostile entry in it, written to
// disk and offered to unpack.
function attack(entry, opts) {
  const f = path.join(scratch("raw"), "attack.erabook");
  fs.writeFileSync(f, rawZip([envelopeEntry(), ...(opts && opts.before || []), entry], opts));
  return f;
}

// ---------------------------------------------------------------- the gate

// Stored entries still need a CRC, and the hub has no package.json and vendors
// nothing: zlib.crc32 (node >= 22.2.0) is the only checksum on the devices.
// Asserted here so a runtime downgrade fails on the build box rather than on a
// family's tablet, weeks later, mid-import.
test("zlib.crc32 is on this runtime", () => {
  assert.equal(typeof require("zlib").crc32, "function");
});

// ------------------------------------------------------------ the round trip

test("a book with nested pages, audio and video comes back byte for byte", async () => {
  const { dir, manifest } = fixture();
  const file = await packedFile(dir, manifest);
  const dest = scratch("dest");
  const out = erabook.unpack(file, dest);

  assert.equal(out.title, "Luna the Fox");
  // the nesting the reader's own fixture has — flattening these would break
  // every manifest in the family
  assert.deepEqual(out.files.slice().sort(), [
    ".erabook.json", "audio/001.wav", "audio/002.wav", "audio/004.wav",
    "cover.jpg", "manifest.json",
    "pages/001.jpg", "pages/002.jpg", "pages/003.jpg", "pages/004.jpg",
    "video/002.mp4",
  ]);
  for (const rel of out.files) {
    if (rel === ".erabook.json") continue;
    assert.ok(fs.statSync(path.join(dest, ...rel.split("/"))).isFile(), rel + " must be a plain file");
    assert.ok(fs.readFileSync(path.join(dest, ...rel.split("/")))
      .equals(fs.readFileSync(path.join(dir, ...rel.split("/")))), rel + " changed in transit");
  }
  // manifest.json is the package's OWN bytes, not a re-serialisation: the
  // receiving hub reads it with the same eyes the sending one did
  assert.ok(fs.readFileSync(path.join(dest, "manifest.json"))
    .equals(fs.readFileSync(path.join(dir, "manifest.json"))));
  // the silent page bought no audio entry, and page 3 has no video
  assert.ok(!fs.existsSync(path.join(dest, "audio", "003.wav")));
});

test("only what the manifest names travels: no sources/, no .build/, no strays", async () => {
  const { dir, manifest } = fixture();
  const file = await packedFile(dir, manifest);
  const out = erabook.unpack(file, scratch("dest"));
  for (const rel of out.files) {
    assert.ok(!rel.startsWith("sources/"), "the originals a parent dropped in are not theirs to have");
    assert.ok(!rel.startsWith(".build/"), "the builder's scratch is not part of the book");
    assert.notEqual(rel, "notes.json", "the manifest is the inventory, not the directory listing");
  }
});

test("the envelope carries the book's shape and no child's name", async () => {
  const { dir, manifest } = fixture();
  const file = await packedFile(dir, manifest);
  const env = erabook.readEnvelope(file);
  assert.deepEqual(env, {
    v: 1, title: "Luna the Fox", slug: "luna-the-fox", pages: 4,
    exportedAt: "2026-08-24T00:00:00Z", from: FROM,
  });
});

// The whole point of the envelope: a wrong file is refused after ~200 bytes,
// not after 40 MB. Proven by shredding every media byte in the archive and
// reading the envelope anyway — it cannot be walking the payload.
test("the envelope reads out of an archive whose pages are shredded", async () => {
  const { dir, manifest } = fixture();
  const file = await packedFile(dir, manifest);
  const buf = fs.readFileSync(file);
  const at = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  assert.ok(at > 0, "the fixture's jpeg bytes are in there somewhere");
  buf.fill(0x5a, at, at + 40);
  fs.writeFileSync(file, buf);
  assert.equal(erabook.readEnvelope(file).title, "Luna the Fox");
  assert.throws(() => erabook.unpack(file, scratch("dest")), refusal("crc-mismatch"));
});

test("the archive is a real zip: stored entries, central directory, EOCD", async () => {
  const { dir, manifest } = fixture();
  const buf = await packToBuffer(dir, manifest);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "a local file header opens the file");
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50, "an EOCD closes it");
  const count = buf.readUInt16LE(buf.length - 12);
  assert.equal(count, 11);
  const cdOff = buf.readUInt32LE(buf.length - 6);
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central directory record " + i);
    assert.equal(buf.readUInt16LE(p + 10), 0, "STORED: a tablet must not burn CPU deflating a JPEG");
    assert.equal(buf.readUInt32LE(p + 20), buf.readUInt32LE(p + 24), "stored: compressed == uncompressed");
    assert.equal(buf.readUInt32LE(p + 38), 0, "we claim no unix mode of our own");
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  assert.equal(p, buf.length - 22, "the central directory ends where the EOCD begins");
  // the envelope is the FIRST entry, so a reader that streams can refuse early
  assert.equal(buf.subarray(30, 30 + 13).toString(), ".erabook.json");
});

// ------------------------------------------------------- what pack refuses
//
// content-publish.js's law is that a manifest never names a file that is not
// there. Export trusts that law and checks it anyway: a package half-mirrored
// by Drive would otherwise ship as a book with a hole in it.
test("pack refuses a manifest that names a file that is not on disk", async () => {
  const { dir, manifest } = fixture();
  fs.rmSync(path.join(dir, "audio", "002.wav"));
  await assert.rejects(() => packToBuffer(dir, manifest), refusal("missing-file"));
});

test("pack refuses a poisoned manifest: we do not build the attack either", async () => {
  const { dir, manifest } = fixture();
  manifest.pages[0].image = "../../evil.jpg";
  await assert.rejects(() => packToBuffer(dir, manifest), refusal("bad-name"));
  const two = fixture();
  two.manifest.cover = "cover.exe";
  await assert.rejects(() => packToBuffer(two.dir, two.manifest), refusal("bad-extension"));
});

// ------------------------------------------------------------- the path jail

test("a name that climbs out of the destination is refused, and writes nothing", () => {
  const dest = scratch("dest");
  const outside = path.join(path.dirname(dest), "evil.jpg");
  for (const name of [
    "../evil.jpg",
    "pages/../../evil.jpg",
    "/etc/evil.jpg",
    "C:\\evil.jpg",
    "pages\\..\\evil.jpg",
    "\\\\server\\share\\evil.jpg",
    "./evil.jpg",
    "pages/./001.jpg",
    "pages//001.jpg",
    "a/b/c/d/e.jpg",                       // deeper than any package is
    "pages/001.jpg\0.exe",
    "",
  ]) {
    const f = attack({ name, data: JPEG(1) });
    assert.throws(() => erabook.unpack(f, dest), refusal("bad-name"), JSON.stringify(name));
  }
  assert.ok(!fs.existsSync(outside), "not one byte landed beside the destination");
  assert.deepEqual(fs.readdirSync(dest), [], "and none landed inside it either");
});

test("an extension off the allowlist is refused", () => {
  for (const name of ["evil.exe", "evil.lnk", "evil.html", "evil.js", "evil", "evil.jpg.exe"])
    assert.throws(() => erabook.unpack(attack({ name, data: Buffer.from("x") }), scratch("dest")),
      refusal("bad-extension"), name);
  // and the allowlist itself round-trips, uppercase included
  for (const name of ["a.json", "a.jpg", "a.JPEG", "a.png", "a.mp3", "a.mp4", "a.wav"]) {
    const dest = scratch("dest");
    const out = erabook.unpack(attack({ name, data: Buffer.from("ok") }), dest);
    assert.ok(out.files.includes(name), name);
  }
});

test("a directory entry is refused, never created", () => {
  assert.throws(() => erabook.unpack(attack({ name: "pages/" }), scratch("dest")), refusal("bad-name"));
  // …and one that says "directory" only in its unix mode
  assert.throws(() => erabook.unpack(
    attack({ name: "pages.json", madeBy: (3 << 8) | 20, attrs: 0x41ed0000 }), scratch("dest")),
    refusal("not-a-file"));
});

// A zip entry can claim to be a symlink in its external attributes. We ignore
// those attributes when WRITING (every entry lands as a plain file, default
// mode, no link is ever created) and read them only to refuse: a book has no
// symlinks in it, so one in the archive is somebody hoping we will follow it
// out of the destination directory.
test("a symlink entry is refused and never followed", () => {
  const dest = scratch("dest");
  const f = attack({ name: "evil.jpg", data: Buffer.from("/etc/passwd"),
                     madeBy: (3 << 8) | 20, attrs: 0xa1ff0000 });
  assert.throws(() => erabook.unpack(f, dest), refusal("not-a-file"));
  assert.deepEqual(fs.readdirSync(dest), []);
});

// ------------------------------------------------------ bytes, not promises

test("an entry whose bytes do not match its CRC is refused", () => {
  const f = attack({ name: "pages/001.jpg", data: JPEG(1), crc: 0xdeadbeef, localCrc: 0xdeadbeef });
  assert.throws(() => erabook.unpack(f, scratch("dest")), refusal("crc-mismatch"));
});

test("a declared size the archive cannot back is refused", () => {
  const data = JPEG(1);
  const f = attack({ name: "pages/001.jpg", data, csize: data.length + 4096, usize: data.length + 4096,
                     localCsize: data.length + 4096, localUsize: data.length + 4096 });
  assert.throws(() => erabook.unpack(f, scratch("dest")), refusal("truncated"));
});

test("a local header that disagrees with the central directory is refused", () => {
  const data = JPEG(1);
  assert.throws(() => erabook.unpack(
    attack({ name: "pages/001.jpg", data, localUsize: 3 }), scratch("dest")), refusal("damaged"));
  assert.throws(() => erabook.unpack(
    attack({ name: "pages/001.jpg", data, localCrc: 1 }), scratch("dest")), refusal("damaged"));
});

test("a file cut short is refused", async () => {
  const { dir, manifest } = fixture();
  const buf = await packToBuffer(dir, manifest);
  const f = path.join(scratch("raw"), "short.erabook");
  fs.writeFileSync(f, buf.subarray(0, buf.length - 200));
  assert.throws(() => erabook.unpack(f, scratch("dest")), refusal("not-a-zip"));
  // and an entry whose local header sits past the end of the file
  const g = attack({ name: "pages/001.jpg", data: JPEG(1), offset: 900000 });
  assert.throws(() => erabook.unpack(g, scratch("dest")), refusal("truncated"));
});

test("something that is not a zip at all is refused", () => {
  const f = path.join(scratch("raw"), "holiday.jpg");
  fs.writeFileSync(f, Buffer.alloc(4096, 0x41));
  assert.throws(() => erabook.unpack(f, scratch("dest")), refusal("not-a-zip"));
  assert.throws(() => erabook.readEnvelope(f), refusal("not-a-zip"));
});

test("a deflated or encrypted entry is not our format", () => {
  assert.throws(() => erabook.unpack(
    attack({ name: "pages/001.jpg", data: JPEG(1), method: 8 }), scratch("dest")),
    refusal("compressed-entry"));
  assert.throws(() => erabook.unpack(
    attack({ name: "pages/001.jpg", data: JPEG(1), flags: 0x0801 }), scratch("dest")),
    refusal("encrypted"));
});

test("two entries with one name are refused: the second would overwrite the first", () => {
  const f = attack({ name: "pages/001.jpg", data: JPEG(2) },
                   { before: [{ name: "pages/001.jpg", data: JPEG(1) }] });
  assert.throws(() => erabook.unpack(f, scratch("dest")), refusal("duplicate-entry"));
});

// ----------------------------------------------------------- the envelope

test("a zip with no envelope is not a New ERA book", () => {
  const f = path.join(scratch("raw"), "holiday.zip");
  fs.writeFileSync(f, rawZip([{ name: "a.jpg", data: JPEG(1) }]));
  assert.throws(() => erabook.unpack(f, scratch("dest")), refusal("no-envelope"));
  // …nor is one whose envelope is not JSON
  const g = path.join(scratch("raw"), "torn.erabook");
  fs.writeFileSync(g, rawZip([{ name: ".erabook.json", data: Buffer.from("{oops") }]));
  assert.throws(() => erabook.unpack(g, scratch("dest")), refusal("no-envelope"));
});

test("a book from a newer New ERA says so before anything is unpacked", () => {
  const dest = scratch("dest");
  const f = path.join(scratch("raw"), "newer.erabook");
  fs.writeFileSync(f, rawZip([envelopeEntry({ v: 2 }), { name: "cover.jpg", data: JPEG(1) }]));
  assert.throws(() => erabook.unpack(f, dest), refusal("future-version"));
  assert.throws(() => erabook.readEnvelope(f), refusal("future-version"));
  assert.deepEqual(fs.readdirSync(dest), []);
});

// ------------------------------------------------------------- the caps

test("the three caps refuse a bomb", () => {
  // entry count
  const many = [envelopeEntry()];
  for (let i = 0; i < erabook.LIMITS.maxEntries; i++) many.push({ name: "p" + i + ".json", data: Buffer.from("{}") });
  const f = path.join(scratch("raw"), "many.erabook");
  fs.writeFileSync(f, rawZip(many));
  assert.throws(() => erabook.unpack(f, scratch("dest")), refusal("too-many-entries"));

  // an entry that CLAIMS half a gigabyte is refused on the claim, before a
  // single byte of it is written
  const g = attack({ name: "pages/001.jpg", data: JPEG(1), usize: 500 * 1024 * 1024,
                     csize: 500 * 1024 * 1024, localUsize: 500 * 1024 * 1024,
                     localCsize: 500 * 1024 * 1024 });
  assert.throws(() => erabook.unpack(g, scratch("dest")), refusal("too-big"));

  // and an archive over the compressed cap never gets opened at all (sparse:
  // this test costs no disk)
  const h = path.join(scratch("raw"), "huge.erabook");
  const fd = fs.openSync(h, "w");
  fs.ftruncateSync(fd, erabook.LIMITS.maxArchiveBytes + 1);
  fs.closeSync(fd);
  assert.throws(() => erabook.unpack(h, scratch("dest")), refusal("too-big"));
  assert.throws(() => erabook.readEnvelope(h), refusal("too-big"));
});

// ------------------------------------------------------------ never half a book

test("a refusal part-way through leaves nothing behind", () => {
  const dest = scratch("dest");
  const good = [
    { name: "manifest.json", data: Buffer.from('{"pages":[]}') },
    { name: "cover.jpg", data: JPEG(1) },
    { name: "pages/001.jpg", data: JPEG(2) },
  ];
  const f = path.join(scratch("raw"), "half.erabook");
  const bad = JPEG(3);
  fs.writeFileSync(f, rawZip([envelopeEntry(), ...good,
    { name: "pages/002.jpg", data: bad, crc: 0x01020304, localCrc: 0x01020304 }]));
  assert.throws(() => erabook.unpack(f, dest), refusal("crc-mismatch"));
  assert.deepEqual(fs.readdirSync(dest), [], "a book is all of it or none of it");
});
