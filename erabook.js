// erabook.js — the .erabook file, both directions. The only zip code in the
// suite (spec §3, §6.3).
//
// A shared book is ONE file: a real zip, so a parent who renames it .zip can
// open it in Explorer and see what they sent. Inside are the package's own
// files under the package's own names — `manifest.json` and `cover.jpg` at the
// root, `pages/001.jpg`, `audio/001.wav`, `video/002.mp4` beneath — plus one
// small envelope, `.erabook.json`, which is the first thing the receiving hub
// reads.
//
// The laws, and what each of them prevents:
//
//  1. THE MANIFEST IS THE INVENTORY. Only files the manifest names travel, and
//     every one of them is stat'd on the way in. `sources/` (the originals a
//     parent dropped in, often ten times the rest of the package), `.build/`
//     (the builder's scratch) and `.slugs.json` (the sending family's ownership
//     map) are not named by a manifest and so are not in the archive — not by a
//     deny list here, but because nothing ever added them. content-publish.js's
//     law is that a manifest never names a file that is not there; this module
//     trusts that law and checks it anyway, because a package half-mirrored by
//     Drive would otherwise ship as a book with a hole in it.
//
//  2. STORED, NEVER DEFLATED. Every entry is compression method 0. JPEG, MP3
//     and MP4 are already compressed: deflating them costs a tablet real CPU
//     and saves about one percent. The only text is two small JSONs. A stored
//     zip is a valid zip everywhere, and on the way back in it means the bytes
//     we write are the bytes we read — there is no decompressor here to be the
//     next bug.
//
//  3. THE ENVELOPE IS READABLE WITHOUT THE BOOK. `.erabook.json` is found
//     through the central directory and read on its own, so a file that is not
//     a New ERA book, or is one from a NEWER New ERA, is refused after a couple
//     of hundred bytes instead of after forty megabytes of somebody's holiday
//     video. It carries {v, title, slug, pages, exportedAt, from} and nothing
//     else — in particular no child's name, because an envelope that carried
//     one would put one family's daughter in another family's file for no
//     benefit.
//
//  4. NOTHING IN AN ARCHIVE IS TRUSTED. An imported .erabook is the first thing
//     this hub ever writes to disk on somebody else's say-so. So: entry names
//     are validated as relative POSIX paths before they are joined to anything
//     (no backslash, no leading slash, no drive letter, no NUL, no `.` or `..`
//     segment, at most four segments deep) and the resolved path is re-checked
//     against the destination after path.normalize, exactly the way
//     serveMediaJail does — belt and braces, because the day a name slips past
//     the first check is the day the second one is the only thing standing
//     between a stranger's file and C:\Windows. Extensions are an allowlist.
//     Declared sizes are checked against the bytes actually written and CRCs
//     against the bytes actually read — a header is a claim, not a fact.
//     Directory and symlink entries are refused rather than followed, and
//     external attributes are otherwise ignored completely: every entry lands
//     as a plain file with a default mode, so no archive can hand itself an
//     executable bit or a link out of the jail. Intermediate directories are
//     created only where a validated entry name implies them.
//
//  5. NEVER HALF A BOOK. A refusal anywhere unwinds what was written. The
//     caller unpacks into a temp directory and renames it into place
//     (content-publish.js's law restated for a different writer), but this
//     module leaves nothing behind on its own account either, and writes
//     manifest.json LAST — the manifest's presence IS the package, and a
//     directory that announces a book it does not yet hold is a shelf entry
//     that opens onto a 404.
//
// REFUSAL CODES. Every refusal is an Error with a stable `.code` string;
// books-share.js maps these to the sentences a parent reads, so they are part
// of this module's contract and must not be renamed lightly:
//
//   not-a-zip          no EOCD, or not a file at all — this is not an archive
//   no-envelope        no .erabook.json, or one that is not JSON we understand
//   future-version     the envelope's `v` is newer than this hub knows
//   truncated          the archive ends before an entry's declared bytes
//   damaged            a structural disagreement (bad record, a local header
//                      that contradicts the central directory, zip64 fields)
//   crc-mismatch       the bytes do not match the recorded checksum
//   size-mismatch      fewer or more bytes than the entry declared
//   compressed-entry   a method other than 0 (see law 2)
//   encrypted          a password-protected entry
//   bad-name           an entry name the path jail refuses (law 4)
//   bad-extension      an extension outside the allowlist
//   not-a-file         a directory or symlink entry
//   duplicate-entry    two entries with one name; the second would overwrite
//   too-many-entries   over the entry cap
//   too-big           over the compressed or uncompressed cap
//   missing-file       (pack) the manifest names a file that is not on disk
//   bad-manifest       (pack) a manifest with no pages array to walk
//
// No dependency, no package.json, nothing vendored: zlib.crc32 (node >= 22.2.0,
// devices ship 22.23.2) is the only checksum, and tests/erabook.test.mjs
// asserts it exists so a runtime downgrade fails on the build box rather than
// on a family's tablet.
//
// pack() streams, because a forty-megabyte response must never be a Buffer in
// a hub that also has to answer the board. unpack() is synchronous: it runs
// once, on a grown-up's tap, against a file already on local disk, and every
// refusal is simpler to prove when nothing is in flight.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Readable } = require("stream");

const ENVELOPE = ".erabook.json";
const MANIFEST = "manifest.json";
const ENVELOPE_VERSION = 1;

// The books media jail's list (server.js BOOK_EXTS), which export and import
// both inherit. Phase 2 moves the one copy into books-share.js and everybody
// imports it from there; one rule stated twice is a rule that drifts.
const EXTS = [".json", ".jpg", ".jpeg", ".png", ".mp3", ".mp4", ".wav"];

const LIMITS = {
  maxArchiveBytes: 200 * 1024 * 1024,   // the file itself
  maxUnpackedBytes: 400 * 1024 * 1024,  // what it claims to become
  maxEntries: 2000,                     // a 16-page book has about 35
  maxDepth: 4,                          // `pages/001.jpg` is 2
  maxNameBytes: 255,
  maxEnvelopeBytes: 64 * 1024,
};

const CODES = Object.freeze({
  notAZip: "not-a-zip", noEnvelope: "no-envelope", futureVersion: "future-version",
  truncated: "truncated", damaged: "damaged", crcMismatch: "crc-mismatch",
  sizeMismatch: "size-mismatch", compressed: "compressed-entry", encrypted: "encrypted",
  badName: "bad-name", badExtension: "bad-extension", notAFile: "not-a-file",
  duplicate: "duplicate-entry", tooManyEntries: "too-many-entries", tooBig: "too-big",
  missingFile: "missing-file", badManifest: "bad-manifest", escapesDest: "escapes-dest",
  writeFailed: "write-failed",
});

class RefusalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ErabookRefusal";
    this.code = code;
  }
}
const refuse = (code, message) => new RefusalError(code, message);

// ---------------------------------------------------------------- the jail
//
// Called on the way OUT as well as the way in. A name a hostile archive could
// not use is a name our own export must not produce either: the export walks a
// manifest whose title and paths came from a parent's keyboard, and the day one
// of those holds "../" is the day we would otherwise have written the attack
// ourselves and signed it.
function segmentsOf(name) {
  if (typeof name !== "string" || name === "")
    throw refuse(CODES.badName, "an entry with no name");
  if (Buffer.byteLength(name) > LIMITS.maxNameBytes)
    throw refuse(CODES.badName, "entry name is too long");
  if (name.includes("\0"))
    throw refuse(CODES.badName, "entry name holds a NUL");
  // A backslash in a zip name is never legitimate — the format says `/` — so it
  // is either a Windows-authored lie or somebody hoping we join it on a machine
  // where `\` is the separator.
  if (name.includes("\\"))
    throw refuse(CODES.badName, "entry name holds a backslash: " + name);
  if (name.startsWith("/"))
    throw refuse(CODES.badName, "entry name is absolute: " + name);
  if (/^[A-Za-z]:/.test(name))
    throw refuse(CODES.badName, "entry name names a drive: " + name);
  const segs = name.split("/");
  if (segs.length > LIMITS.maxDepth)
    throw refuse(CODES.badName, "entry name is nested deeper than a book is: " + name);
  for (const s of segs) {
    // An empty segment is a trailing slash (a directory entry) or a doubled
    // one; `.` and `..` are the traversal itself.
    if (s === "" || s === "." || s === "..")
      throw refuse(CODES.badName, "entry name is not a plain relative path: " + name);
  }
  const ext = path.extname(name).toLowerCase();
  if (name !== ENVELOPE && !EXTS.includes(ext))
    throw refuse(CODES.badExtension, "a book holds no " + (ext || "extensionless file") + ": " + name);
  return segs;
}

// The second check, after path.normalize, the way serveMediaJail does it. The
// name test above should make this impossible; it stays because "should" is not
// a guarantee and this is the last thing between a stranger's file and the rest
// of the disk.
function insideJail(destDir, segs) {
  const root = path.resolve(destDir);
  const file = path.normalize(path.join(root, ...segs));
  if (file !== root && !file.startsWith(root + path.sep))
    throw refuse(CODES.escapesDest, "entry resolves outside the destination: " + segs.join("/"));
  return file;
}

// ------------------------------------------------------------ zip records
//
// Stored entries, no zip64: the caps above keep every number inside 32 bits and
// the entry count inside 16. The timestamp is a constant (1980-01-01, the
// earliest a DOS date can express) rather than each file's mtime, so the same
// book packs to the same bytes twice — the date a family cares about is
// exportedAt, and it is in the envelope and the manifest.
const DOS_TIME = 0, DOS_DATE = 33;
const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_EOCD = 0x06054b50;
const LOCAL_LEN = 30, CENTRAL_LEN = 46, EOCD_LEN = 22;
// Bit 11 says the name is UTF-8. Book folders are named by parents, so "Rae's
// Día" is a normal thing to find in one.
const FLAG_UTF8 = 0x0800;

function localHeader(nameBuf, crc, size) {
  const b = Buffer.alloc(LOCAL_LEN);
  b.writeUInt32LE(SIG_LOCAL, 0);
  b.writeUInt16LE(20, 4); b.writeUInt16LE(FLAG_UTF8, 6); b.writeUInt16LE(0, 8);
  b.writeUInt16LE(DOS_TIME, 10); b.writeUInt16LE(DOS_DATE, 12);
  b.writeUInt32LE(crc >>> 0, 14); b.writeUInt32LE(size, 18); b.writeUInt32LE(size, 22);
  b.writeUInt16LE(nameBuf.length, 26); b.writeUInt16LE(0, 28);
  return b;
}

function centralRecord(nameBuf, crc, size, offset) {
  const b = Buffer.alloc(CENTRAL_LEN);
  b.writeUInt32LE(SIG_CENTRAL, 0);
  // "made by" stays MS-DOS and the external attributes stay 0: we claim no unix
  // mode, so nothing we write can be read back as a symlink or an executable.
  b.writeUInt16LE(20, 4); b.writeUInt16LE(20, 6);
  b.writeUInt16LE(FLAG_UTF8, 8); b.writeUInt16LE(0, 10);
  b.writeUInt16LE(DOS_TIME, 12); b.writeUInt16LE(DOS_DATE, 14);
  b.writeUInt32LE(crc >>> 0, 16); b.writeUInt32LE(size, 20); b.writeUInt32LE(size, 24);
  b.writeUInt16LE(nameBuf.length, 28); b.writeUInt16LE(0, 30); b.writeUInt16LE(0, 32);
  b.writeUInt16LE(0, 34); b.writeUInt16LE(0, 36); b.writeUInt32LE(0, 38);
  b.writeUInt32LE(offset, 42);
  return b;
}

function eocd(count, cdSize, cdOffset) {
  const b = Buffer.alloc(EOCD_LEN);
  b.writeUInt32LE(SIG_EOCD, 0);
  b.writeUInt16LE(0, 4); b.writeUInt16LE(0, 6);
  b.writeUInt16LE(count, 8); b.writeUInt16LE(count, 10);
  b.writeUInt32LE(cdSize, 12); b.writeUInt32LE(cdOffset, 16);
  b.writeUInt16LE(0, 20);
  return b;
}

// ------------------------------------------------------------------- pack

// Everything the manifest names, once each, in reading order, with the two
// JSONs first. The envelope leads so that a reader streaming the archive can
// refuse a wrong file from its opening bytes; the manifest follows it.
function planEntries(dir, manifest, opts) {
  const o = opts || {};
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.pages))
    throw refuse(CODES.badManifest, "a manifest with no pages to walk");

  const envelope = Buffer.from(JSON.stringify({
    v: ENVELOPE_VERSION,
    title: typeof manifest.title === "string" ? manifest.title : "",
    slug: typeof manifest.slug === "string" ? manifest.slug : "",
    pages: manifest.pages.length,
    exportedAt: manifest.exportedAt || null,
    // The sending hub, never the sending child: {app, build}.
    from: o.from || { app: "New ERA", build: null },
  }));

  const entries = [{ name: ENVELOPE, bytes: envelope }];
  const seen = new Set([ENVELOPE]);
  // manifest.json travels as the package's OWN bytes, not a re-serialisation of
  // the object we were handed: the receiving hub must read the file the sending
  // hub published, down to its key order and its whitespace.
  const named = [MANIFEST];
  if (manifest.cover) named.push(manifest.cover);
  for (const p of manifest.pages)
    for (const rel of [p && p.image, p && p.audio, p && p.video]) if (rel) named.push(rel);

  let total = envelope.length;
  for (const rel of named) {
    const segs = segmentsOf(rel);
    const name = segs.join("/");
    if (seen.has(name)) continue;            // a cover that is also a page, say
    seen.add(name);
    const file = path.join(dir, ...segs);
    let st;
    try { st = fs.lstatSync(file); }
    catch { throw refuse(CODES.missingFile, "the manifest names " + name + ", which is not on disk"); }
    // lstat, not stat: a package of our own with a symlink in it is not a
    // package we can vouch for, and we will not resolve one on the way out.
    if (!st.isFile()) throw refuse(CODES.notAFile, name + " is not a plain file");
    entries.push({ name, file, size: st.size });
    total += st.size;
  }

  if (entries.length > LIMITS.maxEntries)
    throw refuse(CODES.tooManyEntries, entries.length + " entries is not a book");
  // Stored entries make the archive its contents plus a little bookkeeping, so
  // both caps are answered by the same sum.
  const overhead = entries.reduce((n, e) => n + LOCAL_LEN + CENTRAL_LEN + 2 * Buffer.byteLength(e.name), EOCD_LEN);
  if (total > LIMITS.maxUnpackedBytes || total + overhead > LIMITS.maxArchiveBytes)
    throw refuse(CODES.tooBig, "this book is bigger than a book is allowed to be");
  return entries;
}

// A first pass for the checksum and the true size, a second for the bytes. A
// stored local header states its CRC BEFORE its data, and the alternative —
// holding the file in memory, or writing a data descriptor some tools read
// badly — is worse than reading a page twice off a local disk.
async function crcOfFile(file) {
  let crc = 0, size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    crc = zlib.crc32(chunk, crc);
    size += chunk.length;
  }
  return { crc: crc >>> 0, size };
}

async function* emit(entries) {
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    let crc, size;
    if (e.bytes) { crc = zlib.crc32(e.bytes) >>> 0; size = e.bytes.length; }
    else ({ crc, size } = await crcOfFile(e.file));
    yield localHeader(nameBuf, crc, size);
    yield nameBuf;
    if (e.bytes) yield e.bytes;
    else {
      let sent = 0;
      for await (const chunk of fs.createReadStream(e.file)) {
        sent += chunk.length;
        // The header above has already promised `size`. A file that grew
        // between the two passes (a Drive mirror finishing underneath us) would
        // otherwise corrupt every offset after it.
        if (sent > size) throw refuse(CODES.sizeMismatch, e.name + " changed while it was being packed");
        yield chunk;
      }
      if (sent !== size) throw refuse(CODES.sizeMismatch, e.name + " changed while it was being packed");
    }
    // The record and the name it describes: a central directory entry is the
    // fixed 46 bytes PLUS its name, and a reader walks it by that length.
    central.push(centralRecord(nameBuf, crc, size, offset), nameBuf);
    offset += LOCAL_LEN + nameBuf.length + size;
  }
  const cd = Buffer.concat(central);
  yield cd;
  yield eocd(entries.length, cd.length, offset);
}

// pack(dir, manifest, {from}) -> a readable stream of the .erabook bytes.
//
// `manifest` is the inventory (the caller has already read and parsed it);
// `dir` is the package it belongs to. Everything that can be refused is
// refused here, synchronously, before the first byte leaves — a response that
// has already begun cannot become a sentence a parent can act on.
function pack(dir, manifest, opts) {
  return Readable.from(emit(planEntries(dir, manifest, opts)));
}

// ----------------------------------------------------------------- unpack

function openArchive(file) {
  let st;
  try { st = fs.statSync(file); }
  catch { throw refuse(CODES.notAZip, "there is no file there"); }
  if (!st.isFile()) throw refuse(CODES.notAZip, "that is not a file");
  // Before the open, not after: the cap exists so a forty-gigabyte "book" costs
  // us a stat and nothing else.
  if (st.size > LIMITS.maxArchiveBytes) throw refuse(CODES.tooBig, "that file is far too big to be a book");
  if (st.size < EOCD_LEN) throw refuse(CODES.notAZip, "too small to be an archive");
  return { fd: fs.openSync(file, "r"), size: st.size };
}

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, b, got, len - got, pos + got);
    if (n <= 0) throw refuse(CODES.truncated, "the archive ends sooner than it says it does");
    got += n;
  }
  return b;
}

// The central directory is the authority on what is in the archive — that is
// what every zip reader uses, and it is what lets the envelope be read without
// walking the payload. Each local header is checked against it at extract time.
function centralDirectory(fd, size) {
  const tailLen = Math.min(size, EOCD_LEN + 0xffff);
  const tail = readAt(fd, size - tailLen, tailLen);
  let at = -1;
  for (let i = tail.length - EOCD_LEN; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
    if (tail.readUInt16LE(i + 20) !== tail.length - i - EOCD_LEN) continue;
    at = i;
    break;
  }
  if (at === -1) throw refuse(CODES.notAZip, "no end-of-archive record: this is not a zip");
  const total = tail.readUInt16LE(at + 10);
  const cdSize = tail.readUInt32LE(at + 12);
  const cdOffset = tail.readUInt32LE(at + 16);
  // 0xffff / 0xffffffff mean "look in a zip64 record". We never write one and a
  // book can never need one, so an archive that wants one is not ours.
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw refuse(CODES.damaged, "a zip64 archive is not a book");
  if (total > LIMITS.maxEntries)
    throw refuse(CODES.tooManyEntries, total + " entries is not a book");
  if (cdOffset + cdSize > size - tailLen + at)
    throw refuse(CODES.truncated, "the central directory is not all there");
  const cd = readAt(fd, cdOffset, cdSize);

  const entries = [];
  let p = 0;
  for (let i = 0; i < total; i++) {
    if (p + CENTRAL_LEN > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL)
      throw refuse(CODES.damaged, "the central directory does not parse");
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    if (p + CENTRAL_LEN + nameLen + extraLen + commentLen > cd.length)
      throw refuse(CODES.damaged, "the central directory does not parse");
    entries.push({
      madeBy: cd.readUInt16LE(p + 4),
      flags: cd.readUInt16LE(p + 8),
      method: cd.readUInt16LE(p + 10),
      crc: cd.readUInt32LE(p + 16),
      csize: cd.readUInt32LE(p + 20),
      usize: cd.readUInt32LE(p + 24),
      attrs: cd.readUInt32LE(p + 38),
      offset: cd.readUInt32LE(p + 42),
      name: cd.subarray(p + CENTRAL_LEN, p + CENTRAL_LEN + nameLen).toString("utf8"),
    });
    p += CENTRAL_LEN + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Everything that can be known from the directory alone, decided before a
// single byte is written: names, extensions, what each entry claims to be, and
// the two caps a header can blow on its own.
function validate(entries, size) {
  const seen = new Set();
  let claimed = 0;
  for (const e of entries) {
    if (e.flags & 0x0001) throw refuse(CODES.encrypted, "a book is not password-protected");
    if (e.method !== 0) throw refuse(CODES.compressed, "every entry in a book is stored, not deflated");
    if (e.csize === 0xffffffff || e.usize === 0xffffffff || e.offset === 0xffffffff)
      throw refuse(CODES.damaged, "a zip64 entry is not a book");
    if (e.csize !== e.usize) throw refuse(CODES.damaged, "a stored entry cannot change size");
    e.segs = segmentsOf(e.name);
    // External attributes are read for exactly one purpose — to refuse — and
    // are never applied. A book holds no directories of its own (the names
    // imply them) and no links at all, so an entry claiming to be either is
    // somebody hoping we will follow it somewhere.
    if ((e.madeBy >> 8) === 3) {
      const type = (e.attrs >>> 16) & 0xf000;
      if (type === 0xa000) throw refuse(CODES.notAFile, e.name + " says it is a symlink");
      if (type === 0x4000) throw refuse(CODES.notAFile, e.name + " says it is a directory");
    }
    if (seen.has(e.name)) throw refuse(CODES.duplicate, "two entries called " + e.name);
    seen.add(e.name);
    claimed += e.usize;
    if (claimed > LIMITS.maxUnpackedBytes)
      throw refuse(CODES.tooBig, "this archive claims to unpack to more than a book can be");
    if (e.offset + LOCAL_LEN > size)
      throw refuse(CODES.truncated, e.name + " starts past the end of the archive");
  }
}

// One entry's bytes, checked against everything the archive says about them.
// `sink` takes each chunk; the caller decides whether that is a file or memory.
function entryData(fd, size, e, sink) {
  const head = readAt(fd, e.offset, LOCAL_LEN);
  if (head.readUInt32LE(0) !== SIG_LOCAL)
    throw refuse(CODES.damaged, e.name + " has no local header where the directory says it does");
  const nameLen = head.readUInt16LE(26), extraLen = head.readUInt16LE(28);
  const nameBuf = readAt(fd, e.offset + LOCAL_LEN, nameLen);
  // A local header that disagrees with the central directory is the oldest zip
  // trick there is: one name for the reader that checks, another for the reader
  // that extracts.
  if (nameBuf.toString("utf8") !== e.name)
    throw refuse(CODES.damaged, "the two headers for " + e.name + " do not agree on its name");
  if (head.readUInt16LE(8) !== e.method || head.readUInt32LE(14) !== e.crc ||
      head.readUInt32LE(18) !== e.csize || head.readUInt32LE(22) !== e.usize)
    throw refuse(CODES.damaged, "the two headers for " + e.name + " do not agree");
  const at = e.offset + LOCAL_LEN + nameLen + extraLen;
  if (at + e.csize > size)
    throw refuse(CODES.truncated, e.name + " claims more bytes than the archive holds");

  const buf = Buffer.alloc(Math.min(e.usize, 1024 * 1024) || 1);
  let left = e.usize, pos = at, crc = 0, written = 0;
  while (left > 0) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, left), pos);
    if (n <= 0) throw refuse(CODES.truncated, e.name + " ends sooner than it says it does");
    const chunk = buf.subarray(0, n);
    crc = zlib.crc32(chunk, crc);
    sink(chunk);
    written += n; pos += n; left -= n;
  }
  // The bytes that landed, against the size that was claimed and the checksum
  // that was recorded — never the header on its own.
  if (written !== e.usize)
    throw refuse(CODES.sizeMismatch, e.name + " is not the size it said it was");
  if ((crc >>> 0) !== (e.crc >>> 0))
    throw refuse(CODES.crcMismatch, e.name + " does not match its checksum");
}

function envelopeOf(fd, size, entries) {
  const e = entries.find(x => x.name === ENVELOPE);
  if (!e) throw refuse(CODES.noEnvelope, "no " + ENVELOPE + ": this is not a New ERA book");
  if (e.method !== 0 || e.usize > LIMITS.maxEnvelopeBytes)
    throw refuse(CODES.noEnvelope, ENVELOPE + " is not one we can read");
  const parts = [];
  entryData(fd, size, e, (c) => parts.push(Buffer.from(c)));
  let env;
  try { env = JSON.parse(Buffer.concat(parts).toString("utf8")); }
  catch { throw refuse(CODES.noEnvelope, ENVELOPE + " is not JSON"); }
  if (!env || typeof env !== "object" || Array.isArray(env))
    throw refuse(CODES.noEnvelope, ENVELOPE + " is not an envelope");
  if (env.v !== ENVELOPE_VERSION) {
    if (typeof env.v === "number" && env.v > ENVELOPE_VERSION)
      throw refuse(CODES.futureVersion, "this book was made by a newer New ERA (v" + env.v + ")");
    throw refuse(CODES.noEnvelope, ENVELOPE + " does not say which version it is");
  }
  return env;
}

// readEnvelope(file) -> {v, title, slug, pages, exportedAt, from}
//
// The 200-byte answer to "is this even a book, and can this hub read it?". The
// import door asks this first, so the forty-megabyte refusals are the rare ones.
function readEnvelope(file) {
  const { fd, size } = openArchive(file);
  try { return envelopeOf(fd, size, centralDirectory(fd, size)); }
  finally { fs.closeSync(fd); }
}

// Directories are created only because a validated entry name implies them —
// never because the archive asked for one.
function mkdirp(root, segs, made) {
  let at = root;
  for (const s of segs.slice(0, -1)) {
    at = path.join(at, s);
    if (fs.existsSync(at)) continue;
    fs.mkdirSync(at);
    made.dirs.push(at);
  }
}

// Whatever we wrote before the refusal, unwritten. The caller unpacks into a
// temp directory it will delete anyway, but a module that leaves half a book
// behind on its own account is one bad caller away from a shelf entry that
// opens onto a 404.
function undo(made) {
  for (const f of made.files) { try { fs.unlinkSync(f); } catch {} }
  for (const d of made.dirs.slice().sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(d); } catch {} }
}

// unpack(file, destDir) -> {title, envelope, files}
//
// `files` is every entry written, in the archive's own order, including
// manifest.json and .erabook.json — the caller checks the manifest's agreement
// with that list (spec §6.3) and it cannot do so from a filtered one.
function unpack(file, destDir) {
  const { fd, size } = openArchive(file);
  const made = { files: [], dirs: [] };
  try {
    const entries = centralDirectory(fd, size);
    // The envelope first, before anything else is trusted: "that book was made
    // by a newer New ERA" is a sentence a parent can act on, and we would lose
    // it by refusing some entry of a future format as damaged.
    const env = envelopeOf(fd, size, entries);
    validate(entries, size);
    const root = path.resolve(destDir);
    // manifest.json LAST: its presence is what makes a directory a package.
    const order = entries.filter(e => e.name !== MANIFEST).concat(entries.filter(e => e.name === MANIFEST));
    for (const e of order) {
      const target = insideJail(root, e.segs);
      mkdirp(root, e.segs, made);
      let out;
      // "wx": an entry that would overwrite something already in the
      // destination is refused rather than landing on top of it.
      try { out = fs.openSync(target, "wx"); }
      catch (err) {
        if (err && err.code === "EEXIST") throw refuse(CODES.duplicate, "two entries called " + e.name);
        throw refuse(CODES.writeFailed, "there was no room to save the book");
      }
      made.files.push(target);
      try {
        entryData(fd, size, e, (chunk) => { fs.writeSync(out, chunk); });
      } finally { fs.closeSync(out); }
    }
    return { title: typeof env.title === "string" ? env.title : "", envelope: env,
             files: entries.map(e => e.name) };
  } catch (err) {
    undo(made);
    throw err;
  } finally { fs.closeSync(fd); }
}

module.exports = {
  pack, unpack, readEnvelope,
  RefusalError, CODES, LIMITS, EXTS, ENVELOPE, MANIFEST, ENVELOPE_VERSION,
};
