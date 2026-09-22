// books-share.js — a book, person to person (spec §4-§6, plan T2.2).
// erabook.js is the FORMAT; this is everything the format is not allowed to
// decide: which books may leave, where a share goes, what an arriving file is
// allowed to be, what it is allowed to be called, and which of the hub's own
// machinery is nudged afterwards. server.js's three routes are thin and call
// in here; every refusal that reaches a parent is written in this file.
//
// Five laws, and everything here is one of them:
//
//   1. WHERE. An imported book is written into the family's Drive content
//      folder (drive.status().folderPath + "/books"), never into <DATA>.
//      <DATA> is this one device's shelf, which the mirror FILLS from Drive: a
//      book written there would exist on one PC, would never reach the tablet
//      in the kitchen, and the next mirror prune would eat it (drive.js
//      MIRROR_DELETES). music-add.js's law #1, content.js's first law, and the
//      reason the import ends with a mirror rather than a copy.
//
//   2. mirrorBook, NEVER sync(). The shelf is nudged with drive.mirrorBook(dir)
//      — one finished book, manifest last, .part-atomic, no prune. drive.sync()
//      would read the same bytes and then end in onSynced, whose fan-out in
//      server.js starts clothing.regenerate(true): AN AI VISION SPEND, ON EVERY
//      IMPORT, FOR PHOTOS NOBODY TOUCHED. The spec asked for sync() until
//      preflight read the module (9/22). mirrorBook was written for exactly
//      this caller, and its {blocked:"needs-local-drive"} is also the word this
//      file uses for "there is no content folder on this computer" — one state,
//      one vocabulary.
//
//   3. THE MANIFEST IS THE INVENTORY, BOTH WAYS. Going out, only files the
//      manifest names are packed, so `sources/` (the originals a parent dropped
//      in — often ten times the rest of the package, and full of their own
//      child), `.build/` and `.slugs.json` simply never enter the archive. A
//      manifest that NAMES something under a denied directory is refused rather
//      than obeyed: BOOK_DENY_DIRS is the serve side's law and it is this
//      side's too, or one hand-edited manifest mails a stranger a family's
//      photographs. Coming in, the manifest and what was actually unpacked must
//      agree in BOTH directions — nothing named is missing, nothing unpacked is
//      unnamed — and disagreement either way refuses the whole book. Never half
//      a book.
//
//   4. A TITLE FROM ANOTHER FAMILY'S COMPUTER IS NOT A FOLDER NAME. It is
//      cleaned as a jail, not as a nicety: every path separator, colon and
//      control character removed, dots and spaces trimmed from BOTH ends
//      (Windows silently drops a trailing dot, so the folder you then write to
//      is not the one you made), capped at 64 characters, and the Windows
//      reserved device names — CON PRN AUX NUL COM1-9 LPT1-9, with or without
//      an extension — refused, because a directory called CON cannot be created
//      on the machine this hub mostly runs on. Unpaired UTF-16 surrogates go
//      too, and the cap is re-checked for one it may have just cut in half:
//      they are not text, they have no UTF-8 encoding, and the header encoder
//      used to THROW on one rather than refuse — which was not a refusal a
//      parent read but a dead hub (9/22 review; see disposition()). What is
//      left falls back to the
//      sending hub's slug, then to "book", which is books-index.js's own
//      fallback for the same problem. The SLUG is books-index's business, not
//      ours: an imported book is exactly the newcomer that machinery was
//      written for, and it resolves -2, -3 by itself.
//
//   5. EVERY REFUSAL IS A SENTENCE. A parent is standing at a tablet holding a
//      file somebody sent them. They get one line they can act on (§5.2's
//      table) — never a stack, never a code, never a 500. `error` is the code
//      the sheet switches on; `message` is the only thing anyone reads.
//
// TWO DEPARTURES FROM §5.2'S DRAFT TABLE, both because Phase 1 split codes the
// spec had lumped: "envelope missing" gets "That file isn't a New ERA book."
// rather than "made by a newer New ERA" — a zip of somebody's holiday photos
// has no envelope and is not from the future — and `future-version` keeps the
// update sentence on its own. The plan calls that table "the draft, not the
// law"; the routing is one line of MESSAGES to put back.
//
// unpack() is SYNCHRONOUS and stays that way (a considered choice, not an
// oversight): it runs once, on a grown-up's tap, against a file already on this
// device's local disk, and this hub already blocks HTTP on a synchronous Drive
// mirror for minutes at a time. pack() streams, because a forty-megabyte
// response must never be a Buffer in the process that also answers the board.
"use strict";
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const drive = require("./drive.js");
const erabook = require("./erabook.js");
const booksIndex = require("./books-index.js");
const update = require("./update.js");

// THE ONE LIST (spec §7). The books media jail's extensions live in erabook.js
// because the format needs them before anything else is loaded; server.js
// imports them back from here so export, import and serving can never drift
// apart. The denied directories are this file's own — the format never meets
// one, since nothing puts them in an archive — and serveBook reads them here.
const BOOK_EXTS = erabook.EXTS;
const BOOK_DENY_DIRS = ["sources", ".build"];

const EXT = ".erabook";
// The outbox (spec §4.2). Deliberately NOT in drive.js's MIRROR_SUBDIRS: it is
// a folder of files for the humans to send each other, not content for the hub
// to mirror back down into <DATA> — a shared book would otherwise arrive on
// this family's own shelf as a second copy of a book they already have.
const SHARED = "shared";
const MAX_DIR_NAME = 64;
// What a POST may carry before the door stops reading it. The format's own cap
// on an archive: a bigger body cannot be a book whatever it claims to be.
const MAX_UPLOAD = erabook.LIMITS.maxArchiveBytes;

let DATA = null;
function start(dataDir) { DATA = dataDir; }

// This device's shelf — what the reader serves and what a slug is resolved
// against. Export reads from here; import never writes here (law 1).
const shelfDir = () => path.join(DATA, "books");

// Law 1: the family's Drive folder, or null when this computer has none. Read
// live on every call — a parent can pick the folder while the sheet is open.
function contentFolder() {
  const st = drive.status();
  return st.mode === "local" && st.folderPath ? st.folderPath : null;
}

// ------------------------------------------------------------- the sentences

// Law 5. The left column is spec §5.2's table; the codes on the way in are
// erabook.js's contract (its header lists them) plus this file's own.
const MESSAGES = {
  // §5.2 row 1 — and `no-envelope`, which the draft table lumped with row 2.
  "not-a-zip": "That file isn't a New ERA book.",
  "no-envelope": "That file isn't a New ERA book.",
  // row 2
  "future-version": "That book was made by a newer New ERA. Update this computer and try again.",
  // row 3 — every structural disagreement a stranger's file can have. A parent
  // cannot repair any of them, and the only useful next step is the same one.
  "damaged": "That book's file is damaged - ask them to send it again.",
  // row 4
  "too-big": "That file is too big to be a book.",
  // row 5 — drive.mirrorBook's own word for this state (law 2).
  "needs-local-drive": "New ERA keeps books in the family's content folder in Google Drive, so every device gets them. Set up your content folder first.",
  // row 6
  "write-failed": "There wasn't room to save the book.",
  // The sending half. These are read by the grown-up who is holding a finger
  // on their OWN book, so they say what is wrong with that book.
  "no-such-book": "New ERA could not find that book.",
  "not-finished": "This book isn't finished yet.",
  "missing-file": "Some of this book's files are missing, so New ERA did not send it.",
  "private-file": "This book's list of pages points outside the book, so New ERA did not send it.",
  "bad-source": "New ERA does not know how to add a book from there.",
  // Not a row in §5.2's table, because §5.2 lists what we predicted. This is
  // the one for what we did not: the catch-all the send half returns when
  // something in there throws rather than refusing. It says only what a parent
  // can act on, which is "it didn't go" — the stack goes to the log.
  "send-failed": "Something went wrong with that book, so New ERA did not send it.",
};
// Everything erabook.js can refuse with that is not one of the rows above is a
// structural fault in somebody else's file, and row 3 is what a parent can do
// about all of them. An UNKNOWN code lands here too: a refusal nobody wrote a
// sentence for must still be a sentence, never an error object on a screen.
const messageFor = (code) => MESSAGES[code] || MESSAGES.damaged;
const TOO_BIG = ["too-big", "too-many-entries"];
const NOT_A_BOOK = ["not-a-zip", "no-envelope", "future-version"];

function refuse(code, extra) {
  const out = { error: code, message: messageFor(code) };
  // Spec §5.2: this row is the only one with somewhere to send them.
  if (code === "needs-local-drive") out.settings = "/settings/#integrations";
  return Object.assign(out, extra || {});
}

// erabook.js's refusal codes arrive on the Error; anything else that escaped it
// is a fault of ours and must not be shown to a family as itself.
function codeOf(e) {
  const code = e && typeof e.code === "string" ? e.code : "";
  if (TOO_BIG.includes(code)) return "too-big";
  if (NOT_A_BOOK.includes(code)) return code;
  if (code === "write-failed") return "write-failed";
  if (!code) console.error("[books-share] " + String((e && e.message) || e));
  return "damaged";
}

// ------------------------------------------------------- what the manifest names

// Law 3. Every file a manifest claims, once each, and whether any of them
// reaches into a directory this hub will not serve. Used on BOTH sides: going
// out it decides what is packed, coming in it decides what may have been
// unpacked, so the two can never answer differently.
function inventory(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      !Array.isArray(manifest.pages)) return { bad: true };
  const named = new Set();
  if (manifest.cover) named.add(String(manifest.cover));
  for (const p of manifest.pages)
    for (const rel of [p && p.image, p && p.audio, p && p.video]) if (rel) named.add(String(rel));
  // Compared the way serveMediaJail compares: lower-cased and with a
  // component's trailing dots and spaces dropped, because that is what the
  // family's filesystem resolves "SOURCES./IMG.jpg" and "sources /IMG.jpg" to.
  for (const rel of named) {
    const segs = rel.split(/[\\/]/).map(s => s.toLowerCase().replace(/[. ]+$/, ""));
    if (segs.some(s => BOOK_DENY_DIRS.includes(s))) return { named, leak: rel };
  }
  return { named };
}

// ------------------------------------------------------------ the folder name

// Law 4. The Windows device names, with or without an extension: CON.txt opens
// the console on Windows exactly as CON does, which is why everything from the
// first dot is dropped before the comparison rather than after — and "CON .txt"
// is the console too, because Windows trims the trailing space first.
//
// erabook.js's, not a second copy of it: the format applies the same rule to
// every segment INSIDE an archive (9/22 review — it had no such check at all,
// so "pages/con.json" reached fs.openSync), and a book whose folder name we
// refuse while its pages sail through is the drift this hub keeps warning
// itself about.
const isReservedDevice = erabook.isReservedDevice;

// A JavaScript string is UTF-16 CODE UNITS, and nothing makes the ones in
// another family's manifest paired: JSON.stringify writes a lone surrogate as
// the escape "\ud800" and JSON.parse hands it straight back, so one rides
// through a .erabook intact and arrives here as a title. It is not text — it
// has no UTF-8 encoding, and encodeURIComponent THROWS URIError on one rather
// than refusing it.
//
// STRIPPED, never substituted. U+FFFD would answer the crash and leave the
// other half of the problem: this name is about to be a directory in the
// family's Drive folder and mirror to every device they own, and a "�" in a
// folder name is no more readable, typable or deletable than a "\ud800" is.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const wellFormed = (s) => s.replace(LONE_SURROGATE, "");

// A title from another family's computer, as a directory name this hub may
// create — or "" when nothing usable survives. Never throws: the caller has a
// fallback chain and an empty answer is how this says "use the next one".
function cleanName(raw) {
  let s = String(raw == null ? "" : raw);
  // Separators and the rest of the set Windows refuses outright, then every
  // control character — a newline in a folder name is a name no parent can
  // ever type, delete or see the whole of.
  s = s.replace(/[\\/:*?"<>|]/g, "").replace(/[\u0000-\u001f\u007f]/g, "");
  s = wellFormed(s);
  s = s.replace(/\s+/g, " ");
  // BOTH ends. A trailing dot or space is the one Windows drops silently, so
  // the directory we created and the directory we then write into would be two
  // different directories — and the manifest would land beside the book rather
  // than in it.
  s = s.replace(/^[. ]+/, "").replace(/[. ]+$/, "");
  // Capped BEFORE the second trim: cutting at 64 can leave a new trailing dot.
  // And cutting at 64 CODE UNITS can land in the middle of a surrogate pair and
  // MANUFACTURE a lone one out of a title that was perfectly well-formed — a
  // book called "L…L🦊" is nobody's attack and was a crash all the same — so the
  // strip runs again after the cut, not only before it.
  if (s.length > MAX_DIR_NAME)
    s = wellFormed(s.slice(0, MAX_DIR_NAME)).replace(/[. ]+$/, "");
  if (!s || isReservedDevice(s)) return "";
  return s;
}

// The name on disk. The sending hub's slug is the first fallback (spec §5.3)
// and "book" the last, which is books-index.js's own fallback for a title that
// makes no name. A numeric suffix resolves a name already there — two families
// send the same book and the shelf holds both, because a silent overwrite of a
// book a child is halfway through is not a thing a parent can see.
function freeDirName(root, title, slug) {
  const base = cleanName(title) || cleanName(slug) || "book";
  let name = base;
  for (let i = 2; fs.existsSync(path.join(root, name)); i++) name = base + "-" + i;
  return name;
}

// ---------------------------------------------------------------- the header

// A title is family text and this puts it in an HTTP HEADER, so it is sanitized
// for one: no CR, no LF, no quote — a title with a newline in it would
// otherwise split the response and let a book name write headers of its own.
// The plain filename= is ASCII (a byte over 0x7f is not portable through every
// proxy and browser, and Node refuses one over 0xff outright); the real name
// rides in RFC 5987's filename*, since "Rae's Día" is a normal book here.
//
// PERCENT-ENCODED FROM A BUFFER, not with encodeURIComponent, and that is the
// whole point of the rewrite rather than a style preference. encodeURIComponent
// THROWS URIError on a lone surrogate — not a refusal, not an
// erabook.RefusalError, nothing exportBook's catch was ever looking for — and
// the GET /books/<slug>.erabook route cannot wrap this in a try and still
// stream, so the throw escaped the http.createServer callback and killed the
// hub. A book that imported without a word was a delayed kill switch.
//
// cleanName() strips lone surrogates now and that is the real fix. This is the
// other half: Buffer.from() SUBSTITUTES the replacement character's bytes for
// an unpaired surrogate instead of throwing, so the encoder below cannot throw
// on any string whatever — including one cleanName stopped stripping after some
// later refactor. Nothing between here and the wire is allowed to be one edit
// away from taking her voice out.
//
// The kept set is exactly encodeURIComponent's minus ' ( ) * — the same bytes
// the old line produced, so no well-formed title's header moves.
const ATTR_CHAR = /[A-Za-z0-9!\-._~]/;
function percentEncode(name) {
  let out = "";
  for (const b of Buffer.from(name, "utf8")) {
    const c = String.fromCharCode(b);
    out += ATTR_CHAR.test(c) ? c : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function disposition(title) {
  const name = (cleanName(title) || "book") + EXT;
  const ascii = name.replace(/[^\u0020-\u007e]/g, "_").replace(/["\\]/g, "_");
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + percentEncode(name);
}

// ------------------------------------------------------------------- export

// exportBook(slug) -> {title, dir, filename, disposition, stream} | {error, message}
//
// Which books may be shared: FINISHED ONES. The manifest's presence IS the
// package (booksIndex skips a folder without one), so a manifest that does not
// read is a book still being built, not a damaged one — and the sheet says so
// in dad's own sentence rather than showing a parent a parse error.
//
// Everything that can be refused is refused HERE, before a byte leaves: a
// response that has already begun cannot become a sentence anyone can act on.
//
// EVERY PATH OUT OF THIS FUNCTION IS A RETURN, never a throw — see the wrapper
// below, which is what makes that true of the helpers too.
function packageFor(slug) {
  const root = shelfDir();
  // dirFor, never the directory name: a package has exactly one URL and the
  // parent's folder name is not a second (serveBook's rule).
  const dir = booksIndex.dirFor(root, String(slug == null ? "" : slug));
  if (!dir) return refuse("no-such-book");
  const pkg = path.join(root, dir);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(pkg, erabook.MANIFEST), "utf8")); }
  catch { return refuse("not-finished"); }
  const inv = inventory(manifest);
  if (inv.bad) return refuse("not-finished");
  if (inv.leak) return refuse("private-file");
  // The name and the header BEFORE the stream exists. Both are made out of a
  // title that came off somebody else's computer, so both are the sort of thing
  // that can refuse or fault — and if either did so after pack() had opened the
  // book, the guard below would be returning a sentence while an unread stream
  // held a file handle open for the rest of the process's life.
  const title = String(manifest.title || dir);
  const filename = (cleanName(title) || "book") + EXT;
  const header = disposition(title);
  let stream;
  try {
    // The REAL build stamp, not the module's {build:null} default: a receiving
    // hub that has to tell a family "that came from a newer New ERA" can only
    // do it if the envelope says which one it came from. update.js is the one
    // place that knows (it reads the VERSION file beside server.js); in a
    // checkout it answers "dev", which is the honest answer there.
    stream = erabook.pack(pkg, manifest, { from: { app: "New ERA", build: update.currentBuild() } });
  } catch (e) {
    // missing-file is its own sentence: the sender can rebuild the book, which
    // is a different act from asking somebody to send a file again.
    if (e && e.code === "missing-file") return refuse("missing-file");
    return refuse(codeOf(e));
  }
  return { title, dir, filename, disposition: header, stream };
}

// The guard, and the reason it is here rather than in the route: the GET
// /books/<slug>.erabook route CANNOT wrap this call in a try and still hand a
// parent a sentence, because by the time anything goes wrong mid-stream the
// response has already begun. So everything that can be decided is decided
// here, and this catch is what makes "everything" true of the helpers as well
// as of the checks — a title from another family's computer reaches a dozen of
// them, and trusting each one never to throw is how a URIError escaped the
// http.createServer callback and took the hub down with it (9/22 review).
//
// NOT a process-level handler. This is one door, closed at the door.
function exportBook(slug) {
  try { return packageFor(slug); }
  catch (e) {
    // Nobody wrote a sentence for this one because nobody expected it. The
    // parent still gets a line they can act on, and the hub still answers the
    // next request — which on this device is a child asking for something.
    console.error("[books-share] export " + String(slug) + ": " +
                  String((e && e.stack) || e));
    return refuse("send-failed");
  }
}

// ---------------------------------------------------------- put it in my Drive

// shareToDrive(slug) -> {path, name} | {error, message}
//
// The out that survives a forty-megabyte book (spec §4.2): the bytes land in
// <folderPath>/shared/<Title>.erabook and Google Drive for Windows uploads them
// on its own, so the sheet can tell a parent WHERE it is rather than handing
// them a download they then have to find.
//
// Written under a .part name and renamed, for the same reason every other
// writer in this hub does: Drive is watching this folder and would otherwise
// start uploading a half-written archive the moment it appeared.
async function shareToDrive(slug) {
  const folder = contentFolder();
  if (!folder) return refuse("needs-local-drive");
  const out = exportBook(slug);
  if (out.error) return out;
  const dir = path.join(folder, SHARED);
  // Created on demand: createContentFolder() may make it one day, but nothing
  // here depends on that, and a family whose folder predates this feature must
  // still be able to send a book.
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch { out.stream.destroy(); return refuse("write-failed"); }
  const file = path.join(dir, out.filename);
  const part = file + ".part";
  try {
    await pipeline(out.stream, fs.createWriteStream(part));
    fs.renameSync(part, file);
  } catch (e) {
    try { fs.unlinkSync(part); } catch {}
    // A refusal the format raised while streaming (a page that changed
    // underneath us) is not a disk problem and should not say it is. Told
    // apart by CLASS, not by whether the error carries a `code` — every fs
    // error carries one too, and ENOENT is exactly the disk problem this
    // branch must not swallow.
    if (e instanceof erabook.RefusalError) return refuse(codeOf(e));
    console.error("[books-share] share-to-drive: " + String((e && e.message) || e));
    return refuse("write-failed");
  }
  return { path: file, name: out.filename, title: out.title };
}

// ------------------------------------------------------------------- import

// Law 3, coming in. `files` is every entry unpack() wrote, in the archive's own
// order — INCLUDING manifest.json and .erabook.json, which are the package's
// own bookkeeping and are named by no manifest. They are subtracted here; a
// check that forgot to would refuse every single import, including its own
// export from five seconds earlier.
function agreement(manifest, files) {
  const inv = inventory(manifest);
  if (inv.bad) return "bad-manifest";
  if (inv.leak) return "manifest-mismatch";
  const got = new Set(files.filter(f => f !== erabook.MANIFEST && f !== erabook.ENVELOPE));
  for (const rel of inv.named) if (!got.has(rel)) return "manifest-mismatch";
  for (const rel of got) if (!inv.named.has(rel)) return "manifest-mismatch";
  return null;
}

function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

let seq = 0;

// importBook(file, {source}) -> {ok, dir, slug, title, mirrored} | {error, message}
//
// `file` is a local path the CALLER owns: server.js streamed the request body
// to it and removes it on every path, success or refusal. Nothing here deletes
// it, because a module that deleted its caller's file would make a retry
// impossible.
//
// UNPACKED TO A SIBLING OF THE DESTINATION, then renamed into place. A sibling
// because a rename across filesystems is a copy, and the whole point of the
// rename is that the package appears complete or not at all — content-publish's
// law restated for a different writer, and for the same reason: Google Drive
// mirrors this folder to the family's other devices WHILE WE WORK, and a
// half-written package is a shelf entry that opens onto a 404. The temp name
// starts with a dot so books-index.js skips it even in the seconds it exists.
function importBook(file, opts) {
  const o = opts || {};
  const folder = contentFolder();
  if (!folder) return refuse("needs-local-drive");

  // The envelope first, from a couple of hundred bytes: a file that is not a
  // New ERA book at all is refused without unpacking forty megabytes of
  // somebody's holiday video, and "that came from a newer New ERA" survives as
  // its own sentence instead of being lost as some later entry's damage.
  try { erabook.readEnvelope(file); }
  catch (e) { return refuse(codeOf(e)); }

  const books = path.join(folder, "books");
  try { fs.mkdirSync(books, { recursive: true }); }
  catch { return refuse("write-failed"); }
  const temp = path.join(books, ".import-" + process.pid + "-" +
                                Date.now().toString(36) + "-" + (++seq));
  try { fs.mkdirSync(temp); } catch { return refuse("write-failed"); }

  let unpacked, manifest;
  try {
    unpacked = erabook.unpack(file, temp);
    manifest = JSON.parse(fs.readFileSync(path.join(temp, erabook.MANIFEST), "utf8"));
  } catch (e) {
    rmrf(temp);
    // A manifest that does not parse is not the format's business — unpack()
    // only ever promised the bytes — so it is decided here.
    return refuse(e instanceof SyntaxError ? "bad-manifest" : codeOf(e));
  }
  // Disagreement either way refuses the WHOLE book and takes the temp
  // directory with it. Never half a book.
  const wrong = agreement(manifest, unpacked.files);
  if (wrong) { rmrf(temp); return refuse(wrong); }

  // The title the BOOK carries, not the envelope's: the manifest is what the
  // reader will show, and a folder named from anything else would disagree
  // with the shelf.
  const title = String(manifest.title || unpacked.title || "");
  const name = freeDirName(books, title, manifest.slug);
  // The rename is also the last guard on the name: rename() onto a directory
  // that is not empty fails on every filesystem this hub runs on, so two
  // imports racing for the same free name end in a refusal rather than one of
  // them quietly landing on top of the other's book.
  try { fs.renameSync(temp, path.join(books, name)); }
  catch (e) {
    rmrf(temp);
    console.error("[books-share] import rename: " + String((e && e.message) || e));
    return refuse("write-failed");
  }

  // Law 2: ONE book onto this device's shelf, right now, so dad's "should land
  // arrive on their bookshelf ready to read" is true in seconds rather than at
  // the next ten-minute tick. NEVER drive.sync() — read the law.
  let mirrored = false;
  try {
    const r = drive.mirrorBook(name);
    mirrored = !!(r && !r.error && !r.blocked && (!r.errors || !r.errors.length));
  } catch (e) { console.error("[books-share] mirror: " + String((e && e.message) || e)); }

  // The slug is books-index's, over the shelf the reader actually serves. A
  // forced rebuild because the directory is younger than the index's mtime
  // cache; null when the mirror has not put it there yet, which is a fact the
  // sheet can show rather than a number we invent.
  booksIndex.bookDirs(shelfDir(), true);
  const slug = booksIndex.slugFor(shelfDir(), name);
  return { ok: true, dir: name, slug, title: title || name, mirrored,
           source: typeof o.source === "string" ? o.source : "file" };
}

module.exports = {
  start, exportBook, shareToDrive, importBook, disposition, messageFor, refuse,
  BOOK_EXTS, BOOK_DENY_DIRS, MAX_UPLOAD, SHARED, EXT,
};
