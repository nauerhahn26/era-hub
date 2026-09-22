# Book sharing — one file, person to person (design)

**Date:** 2026-09-22 · **Branch:** `feat/book-sharing` (era-hub) · **Base:** `ac69eeb`
**Origin:** dad, 9/18: "I want a way to share a book with another family using book
reader app. Not public. Person to person sharing. A link to download. Idk. Should land
arrive on their bookshelf ready to read." Then, on the UX (9/19): "this is something only
a touch user would use. So you would hold to touch the book and it would give you the
option to share … and then we have the header now and we already have the ability kind of
with the music player on the top right to add a book … there's like a few other reading
tools there that we could eventually allow people to add books through so let's start
with the file system but just something to think about."

Decisions taken with dad, three rounds:

1. **One-off per book, not a shared shelf.** No standing connection between two
   families, no account, no server. A book becomes a file; the file travels by whatever
   the two families already use to talk.
2. **Send = hold a finger on the cover.** Not a Settings row. `board-edit.js`'s hold,
   touch-only, on Rae's own shelf — where the book actually is.
3. **Receive = "+ Add a book" in the reader's header**, the music board's `+ Add` in the
   place the same hand already reaches for. One source today (a file); the door is shaped
   so other sources fit later without a redesign.
4. **Scanned books share too** (dad, 9/22: "scanned books are fine for sharing person to
   person"). No wording gate, no distinction between a book the family made and one it
   photographed. Lending a file is lending a book.

## 1. Goal and non-goals

**Goal.** A grown-up holds a finger on a book on Rae's shelf, sends the file to another
family however they like, and that family taps one button and has the book — read-aloud,
word timings, video pages and all — on their own shelf, on every device in their house.

**Non-goals, stated so nobody builds them:**

- **No hosting.** Nothing uploads to era-website, Cloudflare, R2 or anywhere else. The
  whole point of this hub is that a family's pictures of their own child stay in their own
  Drive; a share relay would be the first thing that ever left. Approach 2 in the 9/18
  brainstorm (an expiring link via Workers + R2) is deliberately not built.
- **No subscription.** Sharing a book does not connect two shelves. A second book is a
  second send.
- **No public library.** Not a catalogue, not a directory, nothing discoverable.
- **No re-editing.** The receiving family gets a finished book, not a rebuildable project:
  no `sources/`, no `.build/`, no re-narration. Their hub never runs a builder step on it
  and never spends their AI allowance on it.
- **Not a Rae-facing feature.** She has no way to reach either door. Every control added
  here is a grown-up's: a finger-only hold, and a strip button with no `.dwell`.

## 2. What exists (verified 9/22 against `ac69eeb`)

**The package.** A published book is `<DATA>/books/<dir>/` holding `manifest.json` (the
presence of which *is* the package — `booksIndex()` skips a folder without one), a cover,
and the media the manifest names. `content-publish.js` writes the manifest last and
atomically, and its law is that **it never names a file that is not there**: every image,
mp3 and mp4 is `stat`'d on the way in. That law is what makes a package safe to zip — the
manifest is an honest inventory, not a wish list.

**Serving.** `serveBook()` → `serveMediaJail()` with `BOOK_EXTS = [.json .jpg .jpeg .png
.mp3 .mp4 .wav]` and `BOOK_DENY_DIRS = ["sources", ".build"]`. Those two directories live
*inside* the package on purpose (Drive mirrors them between a family's own devices) and
are denied by name on the way out. **Export inherits both lists**: the same extensions, the
same two denied directories. One rule, stated twice, is a rule that drifts — so §7 has
them imported from one place.

**Identity.** `books-index.js` owns slugs and writes `.slugs.json` so a package keeps its
URL for life (the reader saves reading positions per slug). It already resolves collisions
`-2`, `-3`, … and already falls back to `"book"` for a title that slugifies to nothing.
**An imported book is exactly the newcomer that machinery was written for.** Import adds no
slug logic of its own.

**Where a book is written.** `music-add.js`'s law #1: new content goes to the family's
Drive content folder (`drive.status().folderPath + "/<kind>"`), **never** `<DATA>`. `<DATA>`
is this one device's shelf, which the mirror fills from Drive; a book written there would
exist on one PC and the next mirror prune would eat it (`drive.js` `MIRROR_DELETES`).
Import obeys this law. So does the `.erabook` an export leaves behind (§5.2).

**The shelf.** `renderShelf()` (`public/reader/reader.js`) draws each row of
`/books/index.json` as `.shelf-card > .dwell.dwell-button.shelf-card-button[data-dwell-say]`.
Tapping it opens the book. Cards for books still being built (`notYetCard()`) are already
`data-dwell-disabled` and are a different shape.

**The bar.** Both reader screens sit under era-core's `lib/doorbar.js` strip (🚪 leave,
💬 pause to talk). Its header comment already sanctions what we need: *"a touch-only strip
may sit at the bar's right end (it is never `.dwell`)"* — and warns that the 🚪 is centred
so **a board growing a strip must not move her motor plan for the talk door.** The board's
`mountPartnerStrip()` (`board-partner.js`, era-board) is that strip's only user today:
buttons made with **deliberately no `.dwell`, no `data-dwell-*`**, mouse or finger.

**The hold.** `board-edit.js` (era-board) is the reference: `HOLD_MS = 1600`,
`pointerType === "touch"` as *the entire filter* ("ERAgaze drives the real cursor, so gaze
== mouse at the DOM"), `preventDefault`, its own `contextmenu` suppression, and — load
bearing — it drops the `.dwell` class while armed, because `dwell.js` has a **tap-rescue**
that fires `el.click()` 150 ms after a long touch is released. Without that, every
completed hold would also open the book underneath it.

**Request bodies.** Every `POST` in `server.js` accumulates a **string** with a small cap
(4 KB / 8 KB / 64 KB) and `req.destroy()`s past it. There is no multipart parser and no
binary upload path anywhere in the hub. Import needs a new one (§6.2) — and it must stream
to disk, because string-accumulating a 40 MB zip both corrupts it and holds it in memory.

**Runtime.** Devices ship `node/node.exe` v22.23.2 (`tools/build-payload.sh --with-node`
from `era-family/cache/node-22-win-x64.exe`); the build box is v22.22.2. `zlib.crc32` (Node
≥ 22.2.0) is therefore available on both. **No new dependency is added** — the hub has no
`package.json` and vendors only what it must.

## 3. The file

A shared book is **one file**, named `<Title>.erabook`, which **is a zip** — rename it
`.zip` and Windows Explorer opens it. Choosing our own extension buys two things: the
import door can recognise what it is given, and a double-click does not open a folder of
JPEGs that looks like something to tidy up.

**Entries**, all at the root of the archive, no nesting beyond the package's own shape:

```
manifest.json          the package's own, byte for byte
cover.jpg              (whatever `manifest.cover` names)
p01.jpg, p01.mp3, …    exactly the files the manifest's pages name
.erabook.json          {v:1, title, slug, pages, exportedAt, from}
```

`.erabook.json` is the envelope: one small JSON the import reads **first**, before it
trusts anything else, so a wrong file is refused by reading 200 bytes rather than by
unpacking 40 MB and finding out. `from` is the sending family's child-name-free label —
`{app:"New ERA", build:"<build stamp>"}` — because an envelope that carried a child's name
would put one family's daughter in another family's file for no benefit.

**Stored, not deflated.** Every entry is written with compression method 0. JPEG, MP3 and
MP4 are already compressed; deflating them costs CPU on a tablet and saves ~1%. The only
text entries are two small JSONs. A stored zip is still a valid zip everywhere.

**What is left out**, deliberately: `sources/` and `.build/` (§2 — the originals a parent
dropped in, often 10× the rest of the package, and the builder's scratch), `.slugs.json`
(the sending family's ownership map, meaningless and slightly revealing elsewhere), and any
file the manifest does not name. **The manifest is the inventory**; the zip is the manifest
walked.

## 4. Sending

### 4.1 The hold

On a finished book's card only. `public/reader/reader-share.js`, modelled line for line on
`board-edit.js`:

- `pointerdown` with `pointerType === "touch"`; anything else returns immediately. A
  mouse is a gaze here.
- 1600 ms — the same number, and the comment says it is the twin of `board-edit.js`'s
  `HOLD_MS` and of `board-lock.js`'s, which are already each other's twins.
- While armed: `preventDefault()`, `.holding` class for the fill animation
  (`--hold-ms` published the way `board-edit.js` publishes it), **`.dwell` removed from the
  card's button** and restored on release — the tap-rescue, per §2.
- A short press is untouched: the browser's own click still opens the book. Her shelf is
  not hold-only.
- `contextmenu` suppressed on the card while armed, so Windows' press-and-hold does not
  put a right-click menu on Rae's shelf.
- On a card that is **not** a finished book (a pile, a book being built): the hold fires,
  and the sheet it opens says only *"This book isn't finished yet."* with a way out. Dad,
  9/19. A half-built package has no manifest to walk.

### 4.2 The sheet

A grown-up's sheet over the shelf, the shape the Build ask already uses — while it is open
the shelf beneath it is **asleep** (`LIVE_TARGETS`, `freezeShelf`/`thawShelf`, bar doors
included), because a full-screen backdrop hides nothing from `targetAt()`. Reuses the
reader's existing freeze; does not invent a second one.

Head: the book's cover and title. Then the three outs, **in this order**, which is the
order of how well the hardware actually delivers them:

1. **"Send it now"** — `navigator.share({files:[File]})`, the Windows share sheet:
   WhatsApp, Mail, Teams. **Drawn only when `navigator.canShare({files:[f]})` is true**
   (checked with a real `File`, since `canShare` without arguments answers a different
   question). Never a button that does nothing. Not expected to be there on the i13's Edge;
   when it is, it is the nicest path in the house.
2. **"Put it in my Drive"** — always. Writes `<folderPath>/shared/<Title>.erabook`, which
   Google Drive for Windows uploads on its own, and the sheet then says **where**: *"It's in
   your Google Drive, in **New ERA Content › shared**. Open Drive on your phone and send it
   to them."* This is the out that survives a 40 MB book, and it is the one dad named
   ("saves it somewhere for sharing").
3. **"Save a copy"** — a plain download of the same bytes, for a grown-up who is browsing
   the hub from their own phone or PC rather than standing at Rae's tablet.

While the zip is being written: one line, *"Getting the book ready…"*, and the three
buttons disabled. Export of a 40 MB book off a tablet's disk is a second or two, not
instant. If it fails, the sheet says so in a sentence a parent can act on and stays open.

`shared/` is a new subfolder in the family's content folder and **is not added to
`MIRROR_SUBDIRS`** — it is an outbox for the humans, not content for the hub to mirror
back down into `<DATA>`. A future prune must leave it alone; the one-tap
`createContentFolder()` may make it, but nothing depends on its existing (the export
creates it on demand).

## 5. Receiving

### 5.1 The door

`public/reader/reader-strip.js` mounts a touch-only strip at the right end of the reader's
door bar — the same construction as `mountPartnerStrip()`, deliberately no `.dwell` and no
`data-dwell-*`, mouse **or** finger (a grown-up may be at a keyboard; only the *hold* is
finger-only, because only the hold shares a surface with her gaze). One button: **"+ Add a
book"**. It is mounted on the **shelf screen only** — while a book is open the bar belongs
to 🚪 and 💬.

The 🚪 must not move (§2). The strip rides at the bar's right end exactly as the board's
does, and a gate test asserts the door's centre is where it was.

### 5.2 The sheet

Titled *"Add a book"*, listing **sources**. Today there is one:

- **📁 Choose a file** — a file input, `accept=".erabook,.zip"`, which on Windows opens
  Explorer and on a phone opens the file picker.

The list is a list of one, but it is a **list**, and `POST /books/import` takes a
`source` from the first commit. Dad, 9/19: *"there's like a few other reading tools there
that we could eventually allow people to add books through."* When one of those arrives it
is a new row here and a new `source` there — not a redesign. **Nothing speculative is built
for them now**: no adapter interface, no registry, no second source stubbed out.

After the file is chosen: *"Adding <Title>…"*, then either the book's cover with *"<Title>
is on the shelf."* (and the shelf behind it repaints with it there), or one refusal
sentence in a parent's words. The refusals, all of them, in the words they get:

| What happened | What the sheet says |
|---|---|
| not a zip / not an `.erabook` | "That file isn't a New ERA book." |
| envelope missing or `v` > 1 | "That book was made by a newer New ERA. Update this computer and try again." |
| manifest unreadable, or names files the zip does not hold | "That book's file is damaged — ask them to send it again." |
| over the caps (§6.3) | "That file is too big to be a book." |
| no Drive content folder on this computer | "Set up your content folder first" + the link Settings already uses. |
| disk full / unwritable | "There wasn't room to save the book." |

A book the family **already has** (same slug in `.slugs.json`) is not a refusal and not an
overwrite: `books-index.js` gives it the next free slug and both sit on the shelf. Two
copies is a thing a parent can see and delete; a silent overwrite of a book Rae is halfway
through is not.

### 5.3 Where it lands

`<folderPath>/books/<dir>/` — the family's Drive content folder, the same place their own
builder writes (§2's law). Then the import **nudges the mirror** (`drive.sync()`, the same
call `POST /integrations/drive/sync` makes) so the book is in `<DATA>/books/` and on the
shelf in seconds rather than at the next ten-minute tick. Dad's "should land arrive on
their bookshelf ready to read" is this sentence.

`<dir>` is made from the manifest's title, and the title came from **another family's
computer**, so cleaning it is a jail and not a nicety: strip every path separator, colon
and control character, trim dots and spaces from both ends (Windows silently drops a
trailing dot and the folder you then write to is not the one you made), cap at 64
characters, and refuse the **Windows reserved device names** — `CON PRN AUX NUL COM1-9
LPT1-9`, with or without an extension — by falling back to the slug. An empty result after
all that falls back to `"book"`, which is `books-index.js`'s own fallback for the same
problem. A numeric suffix resolves a name already on disk. The **slug** is
books-index's business, not ours.

**Unpack atomically**: everything goes to a sibling temp directory, `manifest.json` is
written **last**, and only then is the directory renamed into place. This is
`content-publish.js`'s law #1 restated for a different writer, and for the same reason —
Google Drive mirrors this folder to the family's other devices *while we work*, and a
half-written package is a shelf entry that opens onto a 404.

## 6. Server

### 6.1 Export — `GET /books/<slug>.erabook`

Streams the zip, `Content-Type: application/octet-stream`, `Content-Disposition:
attachment; filename="<Title>.erabook"`. A title is family text and goes into a **header**
here, so it is sanitized for one: no CR, no LF, no quotes — a title with a newline in it
would otherwise split the response. RFC 5987 `filename*=UTF-8''…` alongside the plain
`filename=`, since a book called "Rae's Día" is normal here. Built from the package's own
manifest. Unknown slug → 404 (via `booksIndex_.dirFor`, so the parent's folder name is not
a second URL, per `serveBook`'s rule).

`POST /books/<slug>/share-to-drive` writes the same bytes to `<folderPath>/shared/` and
answers `{path}` for the sheet's sentence, or `{error}`.

The route must be matched **before** `/books/` static (`server.js:2091`), since
`<slug>.erabook` would otherwise fall into the media jail and 403 on its extension.

### 6.2 Import — `POST /books/import?source=file`

The hub's first binary body. It **streams to a temp file** — `req.pipe()` to a
`createWriteStream` in `os.tmpdir()` — counting bytes and destroying the request past the
cap. It never accumulates a string and never holds the archive in memory. `Content-Type:
application/octet-stream`; the browser sends the `File` as the raw body
(`fetch(url,{method:"POST",body:file})`), so **no multipart parser is written**.

Answers `{ok:true, slug, title}` or `{error:"<code>"}` → the table in §5.2. The temp file
is removed on every path, success or failure.

### 6.3 Untrusted bytes

The import is the first thing in this hub that takes a file from outside the family and
writes it to disk. Every one of these is a test:

- **Path jail.** An entry name containing `..`, a leading `/` or `\`, a drive letter, a
  NUL, or any path separator at all is refused — **entries are flat by construction (§3),
  so a name with a separator in it is already a lie.** The resolved path is re-checked
  against the destination directory after `path.normalize`, the way `serveMediaJail` does.
- **Extension allowlist** — `BOOK_EXTS` plus `.erabook.json`, imported from the one place
  `server.js` already keeps it. No `.exe`, no `.lnk`, no `.html`, no `.js`.
- **Zip bomb.** Caps on the compressed file (**200 MB**), the uncompressed total
  (**400 MB**), and the entry count (**2000**). Stored entries make the first two nearly the
  same number, and the declared sizes are checked against the bytes actually written, not
  trusted from the header.
- **Symlinks and directories** in the archive: refused, not followed. Zip external
  attributes are ignored entirely; every entry is written as a plain file.
- **Manifest agreement.** After unpacking: the manifest parses, its `cover` and every page
  file it names is present in what we unpacked, and nothing was unpacked that the manifest
  does not name. Disagreement either way → refuse the whole book and delete the temp
  directory. **Never half a book.**
- **Nothing executes.** No shelling out, no `tar`, no unzip binary — the reader in §7 is
  ours and does nothing but read bytes.

## 7. Code shape

New, all in era-hub:

| File | ~Lines | What it is |
|---|---|---|
| `erabook.js` | 200 | The format, both directions: `pack(dir, manifest) → stream` and `unpack(file, destDir) → {title, files}`. The only zip code in the suite. Stored entries, `zlib.crc32`, local headers + central directory + EOCD. |
| `books-share.js` | 150 | Policy: which books may be shared, where a share goes in Drive, what an import is allowed to be (§6.3), where it lands, the mirror nudge. `server.js` routes call this; it owns the refusal codes. |
| `public/reader/reader-share.js` | 180 | The hold and the send sheet (§4). |
| `public/reader/reader-strip.js` | 120 | The header strip and the add sheet (§5.1–5.2). |

Changed: `server.js` (three routes + the binary body reader, ~60 lines) and
`public/reader/index.html` (two script tags, sheet markup, styles).

**Build (checked 9/22, not assumed).** The two *reader* files need no build change:
`tools/build-payload.sh:119` copies `public/reader` wholesale, and `packs.js` marks the
`reader` pack by that same directory, so they ship — and are removed with the pack — for
free. The two *engine* files do: `build-payload.sh:30` is an **explicit list**, and
`erabook.js` + `books-share.js` must be added to it. Forgetting is not silent — the
require-scan at :38 fails the build with "required by the hub but not in the payload",
the guard added after `packs.js` shipped a hub that died on its first line (9/3). It is
still a real edit, and it belongs in the same commit as the modules.

`BOOK_EXTS` and `BOOK_DENY_DIRS` move out of `server.js` into `books-share.js` (or a
small shared module) and are imported back, so export, import and serving read **one**
list. This is the targeted improvement this feature earns; nothing else is refactored.

## 8. Tests

Unit (`tests/`, the gate):

- `erabook.test.mjs` — pack → unpack round-trip byte-for-byte; a package with video; a
  silent page (no audio); CRC mismatch refused; truncated file refused; the four §6.3
  attacks (`../` name, absolute name, bomb caps, entry-count cap); an archive with a
  symlink entry.
- `books-share.test.mjs` — `sources/` and `.build/` are not in the archive; a file the
  manifest does not name is not in the archive; a manifest naming a missing file refuses;
  import lands in the Drive folder and **not** `<DATA>`; a second import of the same book
  gets `-2` and the first book's reading position is untouched; no Drive folder → the
  right refusal; every refusal code in §5.2's table has a test.
- `reader-share.test.mjs` — `reader-ui.test.mjs`'s harness exactly: the real `server.js`
  on a scratch port with a throwaway `ERA_DATA_DIR` and the **synthetic "Luna the Fox"
  fixture** (never real book content), driven with Playwright. The hold needs a context
  with `hasTouch: true` so `page.touchscreen` emits `pointerType === "touch"` — a
  `page.mouse` press must be shown to do **nothing**, which is the whole point of the
  filter. Proves: a touch hold opens the sheet; a mouse hold does not; a short touch still
  opens the book; the card is not `.dwell` while armed and is again after; an unfinished
  card's hold says the "not finished" sentence; **the sheet's open state freezes the bar's
  doors**; "Send it now" is absent when `navigator.canShare` is stubbed false.
- A gate assertion that `typeof require("zlib").crc32 === "function"`, so a runtime
  downgrade fails the gate on the build box rather than on a family's tablet.
- The door-bar assertion (§5.1): the 🚪's centre does not move when the strip mounts.

End-to-end (`tests/`, two scratch hubs): export from hub A over HTTP, import into hub B,
`GET /books/index.json` on B has the book, `GET` its cover and first mp3 → 200.

**Ports:** the suite band has holes and spans all five repos' `tests/`; `grep` every repo
before assigning (`tunnel-ports-never-test-ports`). Two new ports are needed for the
two-hub test.

VM (`tests-vm/`): not this cut. Nothing here touches the installer, signing or Defender.
The e2e above covers the wire; a VM leg would only re-prove it slowly.

## 9. Later, not now

- **Other sources** in the Add sheet (§5.2) — dad's reading tools. The `source` parameter
  is the seam and nothing more is built.
- **A real link** (the 9/18 Approach 2): upload + expiring URL via the era-website rail.
  Held until the file format has proven itself and a family has actually asked.
- **Sharing a book Rae is reading, with her position.** Deliberately not: a reading
  position belongs to a child, not to a book.
