// drive-mirror.test.mjs — the Drive folder IS the wardrobe (dad 9/2: "delete
// clothes from the library that no longer fit or add new clothes and all that
// should just work by adding to the clothing directory"). The Drive-for-
// Desktop mirror copies new photos in AND drops photos that left the folder,
// then tells the clothing pipeline so the board follows the same day.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-drv-"));
const DATA = path.join(TMP, "data");
const API_DATA = path.join(TMP, "data-api");   // the API-mode half keeps its own dir
const SRC = path.join(TMP, "My Drive", "New ERA Content");   // what Drive for Desktop shows
// the provenance half (below): a data dir with a library the family already had
// and a brand-new, EMPTY content folder — exactly what "Create it for me" makes
const OLD_DATA = path.join(TMP, "data-preexisting");
const NEW_SRC = path.join(TMP, "My Drive", "Fresh Content");
const require = createRequire(path.join(HUB, "server.js"));
let drive, api;
const synced = [];
const downloads = [];   // every alt=media the fake Drive API served, in order

// A fake Drive folder tree, listed manifest-FIRST on purpose: readdir/list
// order is what the ordering fix has to survive.
const TREE = {
  F0: [{ id: "F1", name: "books", mimeType: "application/vnd.google-apps.folder" }],
  F1: [{ id: "F2", name: "Story", mimeType: "application/vnd.google-apps.folder" }],
  F2: [{ id: "m1", name: "manifest.json", mimeType: "application/json", size: "2" },
       { id: "a1", name: "a.jpg", mimeType: "image/jpeg", size: "3" },
       { id: "F3", name: "pages", mimeType: "application/vnd.google-apps.folder" }],
  F3: [{ id: "m2", name: "manifest.json", mimeType: "application/json", size: "2" },
       { id: "p1", name: "p1.jpg", mimeType: "image/jpeg", size: "3" }],
};
// What the fake serves for a file id, when "xx" will not do (the .era case
// below needs two DIFFERENT bodies of the SAME length).
const MEDIA = {};

before(async () => {
  api = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const media = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (media && u.searchParams.get("alt") === "media") {
      downloads.push(media[1]);
      res.writeHead(200).end(MEDIA[media[1]] === undefined ? "xx" : MEDIA[media[1]]);
      return;
    }
    const parent = (u.searchParams.get("q") || "").match(/'([^']+)' in parents/);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ files: (parent && TREE[parent[1]]) || [] }));
  });
  await new Promise(r => api.listen(0, "127.0.0.1", r));
  process.env.ERA_DRIVE_API = `http://127.0.0.1:${api.address().port}`;   // never a real key, never a real call

  fs.mkdirSync(path.join(SRC, "clothing", "summer"), { recursive: true });
  fs.mkdirSync(path.join(SRC, "books"), { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(SRC, "clothing", "tee.jpg"), "tee");
  fs.writeFileSync(path.join(SRC, "clothing", "summer", "shorts.jpg"), "shorts");
  fs.writeFileSync(path.join(SRC, "books", "cat.pdf"), "book");
  fs.writeFileSync(path.join(DATA, "drive.json"), JSON.stringify({ mode: "local", folderPath: SRC }));
  drive = require("./drive.js");
  drive.onSynced = (r) => synced.push(r);
  drive.start(DATA);   // timers are unref'd; we call sync() directly
});
after(() => {
  if (api) api.close();
  delete process.env.ERA_DRIVE_API;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const local = (...p) => path.join(DATA, ...p);

test("new photos in the Drive clothing folder land in data/clothing, folders included", async () => {
  const r = await drive.sync();
  assert.equal(r.files, 3, "three files copied");
  assert.ok(fs.existsSync(local("clothing", "tee.jpg")));
  assert.ok(fs.existsSync(local("clothing", "summer", "shorts.jpg")));
  assert.ok(fs.existsSync(local("books", "cat.pdf")));
  assert.equal(synced.length, 1, "the clothing pipeline was told");
});

test("a photo deleted from the Drive clothing folder is deleted from data/clothing", async () => {
  fs.rmSync(path.join(SRC, "clothing", "tee.jpg"));                   // no longer fits
  fs.rmSync(path.join(SRC, "clothing", "summer"), { recursive: true }); // whole album gone
  const r = await drive.sync();
  assert.equal(r.removed, 2, "two photos dropped");
  assert.ok(!fs.existsSync(local("clothing", "tee.jpg")), "tee gone");
  assert.ok(!fs.existsSync(local("clothing", "summer")), "empty album folder gone too");
  assert.ok(fs.existsSync(local("books", "cat.pdf")), "other libraries untouched");
  assert.equal(synced.length, 2, "the clothing pipeline was told again");
});

test("hub-made files beside the photos are never mirrored away", async () => {
  // The hub keeps nothing of its own inside clothing/ today, but dotfiles are
  // Drive/macOS droppings the photo walker already ignores — leave them be.
  fs.writeFileSync(local("clothing", ".DS_Store"), "x");
  fs.writeFileSync(path.join(SRC, "clothing", "dress.heic"), "dress");
  const r = await drive.sync();
  assert.equal(r.files, 1);
  assert.equal(r.removed, 0);
  assert.ok(fs.existsSync(local("clothing", ".DS_Store")));
  assert.ok(fs.existsSync(local("clothing", "dress.heic")));
});

test("when the Drive folder is unreachable nothing is deleted", async () => {
  fs.renameSync(path.join(SRC, "clothing"), path.join(SRC, "clothing-offline"));
  const r = await drive.sync();
  assert.equal(r.removed || 0, 0, "an absent source is not an empty source");
  assert.ok(fs.existsSync(local("clothing", "dress.heic")), "the local library survives");
  fs.renameSync(path.join(SRC, "clothing-offline"), path.join(SRC, "clothing"));
});

// The manifest is the "this package is ready" signal. Mirrored first, a device
// shows a book whose pages have not arrived yet — so it goes last, after the
// files AND the subfolders of its directory, in both mirrors.
test("one ordering rule: manifest.json and catalog.json go last, everything else keeps its order", () => {
  const names = (l) => drive.manifestsLast(l).map(e => e.name);
  assert.deepEqual(
    names([{ name: "manifest.json" }, { name: "a.jpg" }, { name: "pages" },
           { name: "catalog.json" }, { name: "b.jpg" }]),
    ["a.jpg", "pages", "b.jpg", "manifest.json", "catalog.json"]);
  assert.deepEqual(names([{ name: "a.jpg" }, { name: "b.jpg" }]), ["a.jpg", "b.jpg"]);
  // job.json is byte-compared like a manifest (below) but is NOT one: it is the
  // claim latch, and the sooner the other computers see it the smaller the
  // window in which two of them build the same book. It keeps its place.
  assert.deepEqual(
    names([{ name: "job.json" }, { name: "manifest.json" }, { name: "log.jsonl" }]),
    ["job.json", "log.jsonl", "manifest.json"]);
});

test("local mode: a book's manifest is copied after its pages, at every level", async () => {
  const book = path.join(SRC, "books", "Story");
  fs.mkdirSync(path.join(book, "pages"), { recursive: true });
  fs.writeFileSync(path.join(book, "a.jpg"), "jpg");
  fs.writeFileSync(path.join(book, "manifest.json"), "{}");
  fs.writeFileSync(path.join(book, "pages", "p1.jpg"), "jpg");
  fs.writeFileSync(path.join(book, "pages", "manifest.json"), "{}");

  // readdir order is filesystem luck, so force the bad case (manifest first)
  // and record what actually got copied — the assertion is the order itself.
  const realRead = fs.readdirSync, realCopy = fs.copyFileSync;
  const copied = [];
  fs.readdirSync = (dir, opts) => {
    const ents = realRead(dir, opts);
    if (!String(dir).startsWith(SRC) || !opts || !opts.withFileTypes) return ents;
    return [...ents].sort((a, b) => (b.name === "manifest.json") - (a.name === "manifest.json"));
  };
  fs.copyFileSync = (s, d) => { if (String(s).startsWith(book)) copied.push(path.relative(book, s)); return realCopy(s, d); };
  try { await drive.sync(); } finally { fs.readdirSync = realRead; fs.copyFileSync = realCopy; }

  assert.deepEqual(copied, ["a.jpg", path.join("pages", "p1.jpg"),
                            path.join("pages", "manifest.json"), "manifest.json"]);
});

// The Drive folder is the library for BOOKS and SONGS and MOVIES too, not just
// clothes: a book the parent removes there has to leave every device, or the
// shelf only ever grows. Same rails, same three safety rules (dotfiles kept,
// absent source prunes nothing, empty folders go with their last file).
test("a book folder deleted in Drive is deleted from data/books", async () => {
  fs.rmSync(path.join(SRC, "books", "Story"), { recursive: true });
  const r = await drive.sync();
  assert.equal(r.removed, 4, "the book's four files went");
  assert.ok(!fs.existsSync(local("books", "Story")), "the empty package folder went too");
  assert.ok(fs.existsSync(local("books", "cat.pdf")), "the rest of the shelf stayed");
});

test("a song removed from Drive is removed from data/music; the rest of the album stays", async () => {
  fs.mkdirSync(path.join(SRC, "music"), { recursive: true });
  fs.writeFileSync(path.join(SRC, "music", "one.mp3"), "one");
  fs.writeFileSync(path.join(SRC, "music", "two.mp3"), "two");
  fs.writeFileSync(path.join(SRC, "music", "manifest.json"), "{}");
  await drive.sync();
  assert.ok(fs.existsSync(local("music", "one.mp3")));

  fs.rmSync(path.join(SRC, "music", "one.mp3"));
  const r = await drive.sync();
  assert.equal(r.removed, 1, "just the one song");
  assert.ok(!fs.existsSync(local("music", "one.mp3")), "one.mp3 gone");
  assert.ok(fs.existsSync(local("music", "two.mp3")), "two.mp3 stayed");
  assert.ok(fs.existsSync(local("music", "manifest.json")), "so did the manifest");
});

// movies/ was never in the mirror set at all, so a title a parent added lived on
// one device and vanished on reinstall (audit 9/4).
test("movies mirrors, catalog and posters, and the Settings checklist can see it", async () => {
  fs.mkdirSync(path.join(SRC, "movies", "posters"), { recursive: true });
  fs.writeFileSync(path.join(SRC, "movies", "posters", "moana.jpg"), "poster");
  fs.writeFileSync(path.join(SRC, "movies", "catalog.json"), "{}");
  await drive.sync();
  assert.ok(fs.existsSync(local("movies", "catalog.json")), "catalog mirrored");
  assert.ok(fs.existsSync(local("movies", "posters", "moana.jpg")), "poster mirrored");

  // contentReady(), createContentFolder() and syncLocal() all walk the one
  // MIRROR_SUBDIRS list, so pinning what the checklist reports pins all three.
  assert.deepEqual(Object.keys(drive.status().content),
    ["books", "music", "movies", "content", "clothing", "drawings", "characters"]);
  assert.equal(drive.status().content.movies, true, "the checklist ticks for movies");

  fs.rmSync(path.join(SRC, "movies", "posters", "moana.jpg"));
  const r = await drive.sync();
  assert.equal(r.removed, 1, "a dropped poster is dropped here too");
  assert.ok(fs.existsSync(local("movies", "catalog.json")), "the catalog stayed");
});

test("an absent books folder in Drive prunes nothing", async () => {
  fs.renameSync(path.join(SRC, "books"), path.join(SRC, "books-offline"));
  const r = await drive.sync();
  assert.equal(r.removed || 0, 0, "an absent source is not an empty source");
  assert.ok(fs.existsSync(local("books", "cat.pdf")), "the shelf survives");
  fs.renameSync(path.join(SRC, "books-offline"), path.join(SRC, "books"));
});

test("the hub's own .build/ inside a book package is never pruned", async () => {
  // .build/job.json is the claim the builder writes; it is a dotfile, and
  // pruneTree leaves dotfiles alone, so a package mid-build cannot lose it.
  fs.mkdirSync(path.join(SRC, "books", "Draft"), { recursive: true });
  fs.writeFileSync(path.join(SRC, "books", "Draft", "IMG_0001.jpg"), "img");
  await drive.sync();
  fs.mkdirSync(local("books", "Draft", ".build"), { recursive: true });
  fs.writeFileSync(local("books", "Draft", ".build", "job.json"), "{}");
  const r = await drive.sync();
  assert.equal(r.removed, 0);
  assert.ok(fs.existsSync(local("books", "Draft", ".build", "job.json")), "the claim survived");
});

// ---- provenance: a mirror may only delete what a mirror put there ----------
// The audit's blocker (9/4): "✨ Create it for me" makes five EMPTY subfolders
// and Settings syncs the moment it returns. With books/music/movies following
// deletions, an empty source folder read as "everything was deleted" would take
// the 8 book packages, the songs and the movie catalog a family had before they
// ever pointed the hub at Drive. Those files are not the mirror's to prune.
test("a library the family already had is never pruned by an empty Drive folder", async () => {
  fs.mkdirSync(path.join(OLD_DATA, "books", "tabby-mctat"), { recursive: true });
  fs.mkdirSync(path.join(OLD_DATA, "movies", "posters"), { recursive: true });
  fs.mkdirSync(path.join(OLD_DATA, "music"), { recursive: true });
  fs.writeFileSync(path.join(OLD_DATA, "books", "tabby-mctat", "manifest.json"), "{}");
  fs.writeFileSync(path.join(OLD_DATA, "music", "beyond.mp3"), "song");
  fs.writeFileSync(path.join(OLD_DATA, "movies", "catalog.json"), "[]");
  fs.writeFileSync(path.join(OLD_DATA, "movies", "posters", "moana.jpg"), "poster");
  for (const sub of ["books", "music", "movies", "content", "clothing"])
    fs.mkdirSync(path.join(NEW_SRC, sub), { recursive: true });   // createContentFolder()
  fs.writeFileSync(path.join(OLD_DATA, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: NEW_SRC }));
  drive.start(OLD_DATA);   // re-points DATA; timers are unref'd

  const r = await drive.sync();
  assert.equal(r.removed, 0, "an empty Drive folder is not a delete-everything order");
  for (const p of [["books", "tabby-mctat", "manifest.json"], ["music", "beyond.mp3"],
                   ["movies", "catalog.json"], ["movies", "posters", "moana.jpg"]])
    assert.ok(fs.existsSync(path.join(OLD_DATA, ...p)), p.join("/") + " survived");
});

test("the mirror still prunes what the mirror wrote, and only that", async () => {
  const src = path.join(NEW_SRC, "books", "New Book");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "manifest.json"), "{}");
  await drive.sync();
  assert.ok(fs.existsSync(path.join(OLD_DATA, "books", "New Book", "manifest.json")));

  fs.rmSync(src, { recursive: true });
  const r = await drive.sync();
  assert.equal(r.removed, 1, "the package the mirror wrote went with it");
  assert.ok(!fs.existsSync(path.join(OLD_DATA, "books", "New Book")), "folder and all");
  assert.ok(fs.existsSync(path.join(OLD_DATA, "books", "tabby-mctat", "manifest.json")),
    "the family's own shelf is still outside the mirror's jurisdiction");
});

// The reader cache-busts on exportedAt, and an ISO stamp is always the same
// length — so a size-equal skip means "fix a page and re-publish" never leaves
// the building device.
test("a re-published manifest of the same byte length still reaches the device", async () => {
  const src = path.join(NEW_SRC, "books", "Re Published");
  fs.mkdirSync(src, { recursive: true });
  const stamped = (d) => JSON.stringify({ schemaVersion: 1, exportedAt: d, pages: [] });
  fs.writeFileSync(path.join(src, "manifest.json"), stamped("2026-09-04T00:00:00Z"));
  await drive.sync();
  fs.writeFileSync(path.join(src, "manifest.json"), stamped("2026-09-05T11:22:33Z"));
  await drive.sync();
  const got = JSON.parse(fs.readFileSync(
    path.join(OLD_DATA, "books", "Re Published", "manifest.json"), "utf8"));
  assert.equal(got.exportedAt, "2026-09-05T11:22:33Z", "the cache-bust key actually changed");
});

// A manifest carries every page's words[]; copying straight onto the live path
// truncates it first, so a shelf load or a reader fetch mid-copy sees half a
// book. Rename within a directory is atomic on NTFS and ext4 alike.
test("a manifest lands atomically: copied to a .part sibling, then renamed into place", async () => {
  const src = path.join(NEW_SRC, "books", "Atomic");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "manifest.json"), '{"pages":[]}');
  const realCopy = fs.copyFileSync, realRename = fs.renameSync;
  const dests = [], renames = [];
  fs.copyFileSync = (s, d) => { dests.push(String(d)); return realCopy(s, d); };
  fs.renameSync = (a, b) => { renames.push([String(a), String(b)]); return realRename(a, b); };
  try { await drive.sync(); } finally { fs.copyFileSync = realCopy; fs.renameSync = realRename; }

  const live = path.join(OLD_DATA, "books", "Atomic", "manifest.json");
  assert.ok(!dests.includes(live), "the live manifest is never written in place");
  assert.ok(dests.includes(live + ".part"), "copied to a .part sibling first");
  assert.deepEqual(renames.find(([, b]) => b === live), [live + ".part", live], "then renamed");
  assert.deepEqual(JSON.parse(fs.readFileSync(live, "utf8")), { pages: [] });
});

// pruneTree skips dotfiles (that is what keeps a .build/ claim alive mid-build),
// so a package deleted in Drive used to leave an empty-but-for-.build/ folder
// behind forever — a permanent orphan still holding the package's slug.
test("a package deleted in Drive leaves no .build orphan holding its slug", async () => {
  const src = path.join(NEW_SRC, "books", "Orphan");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "IMG_0001.jpg"), "img");
  await drive.sync();
  fs.mkdirSync(path.join(OLD_DATA, "books", "Orphan", ".build"), { recursive: true });
  fs.writeFileSync(path.join(OLD_DATA, "books", "Orphan", ".build", "job.json"), "{}");

  fs.rmSync(src, { recursive: true });
  await drive.sync();
  assert.ok(!fs.existsSync(path.join(OLD_DATA, "books", "Orphan")),
    "the folder went, .build and all");
  assert.ok(fs.existsSync(path.join(OLD_DATA, "books", "tabby-mctat", "manifest.json")),
    "and nothing of the family's went with it");
});

test("API mode: the manifest is downloaded after the media it names", async () => {
  fs.mkdirSync(API_DATA, { recursive: true });
  fs.writeFileSync(path.join(API_DATA, "drive.json"), JSON.stringify({
    mode: "api", folderId: "F0",
    token: { access_token: "fake-for-the-test", refresh_token: "fake-for-the-test",
             expiry: Date.now() + 3600e3 },   // never refreshed: no OAuth call at all
  }));
  drive.start(API_DATA);   // re-point DATA; timers are unref'd
  const r = await drive.sync();
  assert.equal(r.files, 4, "four files came down");
  assert.deepEqual(downloads, ["a1", "p1", "m2", "m1"], "media first, nested manifest, then the book's");
  assert.ok(fs.existsSync(path.join(API_DATA, "books", "Story", "manifest.json")));
});

// The ledger's own upgrade gap: clothing has been a TRUE mirror since 9/2, so
// everything in <DATA>/clothing got there through this mirror. Starting its
// ledger empty would make a photo deleted in Drive while the hub was down an
// orphan forever, quietly breaking dad's "clothes that no longer fit" rule.
// books/music/movies get NO such adoption — that content predates the mirror.
test("clothing adopts what it already mirrored; the other libraries do not", async () => {
  const D = path.join(TMP, "data-wardrobe"), S = path.join(TMP, "My Drive", "Wardrobe Content");
  fs.mkdirSync(path.join(D, "clothing"), { recursive: true });
  fs.mkdirSync(path.join(D, "books", "tiddler"), { recursive: true });
  fs.writeFileSync(path.join(D, "clothing", "tee.jpg"), "tee");     // mirrored by an older build
  fs.writeFileSync(path.join(D, "clothing", "dress.jpg"), "dress");
  fs.writeFileSync(path.join(D, "books", "tiddler", "manifest.json"), "{}");
  fs.mkdirSync(path.join(S, "clothing"), { recursive: true });
  fs.mkdirSync(path.join(S, "books"), { recursive: true });
  fs.writeFileSync(path.join(S, "clothing", "dress.jpg"), "dress");  // tee.jpg left the folder
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);

  const r = await drive.sync();
  assert.equal(r.removed, 1, "just the photo that left the wardrobe");
  assert.ok(!fs.existsSync(path.join(D, "clothing", "tee.jpg")), "tee.jpg went on the first sync");
  assert.ok(fs.existsSync(path.join(D, "clothing", "dress.jpg")), "dress.jpg stayed");
  assert.ok(fs.existsSync(path.join(D, "books", "tiddler", "manifest.json")),
    "and the shelf is still nobody's to prune");
});

// ---- the shared clothing log rides inside this mirror (spec §5) -------------
// clothing/.era/ carries every device's picks, offers and tags. Three mirror
// properties make that safe, and all three are load-bearing:
//   * it is COPIED (dotfiles are, in both copy paths),
//   * it is never PRUNED (pruneTree skips dot entries),
//   * and a rewrite of the SAME LENGTH still reaches the other device — the
//     migration tool rewrites tags/studio.jsonl wholesale, and the size-equal
//     skip would strand it on the device that ran the tool (W9).
test("local mode: .era is mirrored, byte-compared, and never pruned", async () => {
  const D = path.join(TMP, "data-era"), S = path.join(TMP, "My Drive", "Era Content");
  const line = (t, id) => JSON.stringify({ t, kind: "yes", combo: [id] }) + "\n";
  const rel = path.join("clothing", ".era", "picks", "dev-b", "2026-09-01.jsonl");
  fs.mkdirSync(path.join(S, "clothing", ".era", "picks", "dev-b"), { recursive: true });
  fs.writeFileSync(path.join(S, "clothing", "tee.jpg"), "tee");
  fs.writeFileSync(path.join(S, rel), line("2026-09-01T09:00:00Z", "item_aaaa"));
  fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);

  await drive.sync();
  assert.ok(fs.existsSync(path.join(D, rel)), "another device's picks reached this one");

  // A same-LENGTH rewrite: one id swapped for another of the same width. Under
  // the size-equal skip this is invisible and the line never crosses.
  const rewritten = line("2026-09-01T09:00:00Z", "item_bbbb");
  assert.equal(rewritten.length, line("2026-09-01T09:00:00Z", "item_aaaa").length, "the rewrite is the same size");
  fs.writeFileSync(path.join(S, rel), rewritten);
  await drive.sync();
  assert.equal(fs.readFileSync(path.join(D, rel), "utf8"), rewritten,
    "a same-size rewrite of a .era file is copied anyway (W9)");

  // ...and the prune leaves it alone even when the wardrobe beside it shrinks.
  fs.rmSync(path.join(S, "clothing", "tee.jpg"));
  const r = await drive.sync();
  assert.equal(r.removed, 1, "the photo that left the wardrobe went");
  assert.ok(fs.existsSync(path.join(D, rel)), "the shared log is nobody's to prune");
});

test("API mode: a .era file that changed without changing size is downloaded again", async () => {
  const D = path.join(TMP, "data-era-api");
  const body1 = JSON.stringify({ t: "2026-09-01T09:00:00Z", kind: "yes", combo: ["item_aaaa"] }) + "\n";
  const body2 = JSON.stringify({ t: "2026-09-01T09:00:00Z", kind: "yes", combo: ["item_bbbb"] }) + "\n";
  assert.equal(body1.length, body2.length);
  const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
  MEDIA.e1 = body1;
  // Its OWN root id, not F0's: overwriting the shared tree would hand every
  // API-mode case added after this one a wardrobe-only Drive (review r1 nit).
  TREE.G0 = [{ id: "C1", name: "clothing", mimeType: "application/vnd.google-apps.folder" }];
  TREE.C1 = [{ id: "C2", name: ".era", mimeType: "application/vnd.google-apps.folder" }];
  TREE.C2 = [{ id: "C3", name: "picks", mimeType: "application/vnd.google-apps.folder" }];
  TREE.C3 = [{ id: "C4", name: "dev-b", mimeType: "application/vnd.google-apps.folder" }];
  TREE.C4 = [{ id: "e1", name: "2026-09-01.jsonl", mimeType: "application/json",
               size: String(body1.length), md5Checksum: md5(body1) }];
  const dest = path.join(D, "clothing", ".era", "picks", "dev-b", "2026-09-01.jsonl");

  fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({
    mode: "api", folderId: "G0",
    token: { access_token: "fake-for-the-test", refresh_token: "fake-for-the-test",
             expiry: Date.now() + 3600e3 },
  }));
  drive.start(D);
  await drive.sync();
  assert.equal(fs.readFileSync(dest, "utf8"), body1);

  MEDIA.e1 = body2;
  TREE.C4[0].md5Checksum = md5(body2);
  await drive.sync();
  assert.equal(fs.readFileSync(dest, "utf8"), body2,
    "the checksum, not the byte count, decides whether a .era file is re-fetched (W9)");
});

// I20: <DATA>/clothing/.era is content the hub itself made. A family with no
// photos at all must not see the Settings checklist tick "clothing" because
// their first Yes wrote a log line.
test("the Settings checklist counts photos, not the hub's own dot-folder", async () => {
  const D = path.join(TMP, "data-ready"), S = path.join(TMP, "My Drive", "Ready Content");
  fs.mkdirSync(path.join(S, "clothing", ".era", "picks", "dev-b"), { recursive: true });
  fs.writeFileSync(path.join(S, "clothing", ".era", "picks", "dev-b", "2026-09-01.jsonl"), "{}\n");
  fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);
  assert.equal(drive.status().content.clothing, false, "a log line is not a wardrobe");
  fs.writeFileSync(path.join(S, "clothing", "tee.jpg"), "tee");
  assert.equal(drive.status().content.clothing, true, "…a photo is");
});

// ---- the mirror shelves COMPLETE books only (spec §14) ---------------------
// The weekly book is built somewhere else entirely and arrives through Drive
// desktop, which downloads a folder in whatever order it likes. Uploading the
// manifest last (the maker's two rclone passes) settles the order going UP and
// nothing settles it coming DOWN — so the manifests-last rule above, which is
// only about the order WE copy in, is not enough on its own: a manifest can be
// sitting in the source folder with half the pages still on their way.
// manifest.json is the reader's "this package is ready" signal, so it waits
// until every file it names is here with bytes in it. Ten more minutes is
// nothing; a book that opens on a missing picture is the thing she remembers.
const capture = async (fn) => {
  const said = [], real = console.log;
  console.log = (...a) => said.push(a.map(String).join(" "));
  try { await fn(); } finally { console.log = real; }
  return said;
};

test("a manifest is copied only once every file it names is in the source", async () => {
  const D = path.join(TMP, "data-half"), S = path.join(TMP, "My Drive", "Half Content");
  const src = path.join(S, "books", "Half Arrived");
  fs.mkdirSync(path.join(src, "pages"), { recursive: true });
  fs.mkdirSync(path.join(src, "audio"), { recursive: true });
  fs.writeFileSync(path.join(src, "cover.jpg"), "cover");
  fs.writeFileSync(path.join(src, "pages", "001.jpg"), "page one");
  // Drive lands a big file as a zero-length placeholder first, so "there is a
  // file with that name" is not the question — "does it have bytes" is.
  fs.writeFileSync(path.join(src, "audio", "001.mp3"), "");
  fs.writeFileSync(path.join(src, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: "b1", slug: "half-arrived", title: "Half Arrived",
    exportedAt: "2026-09-09T20:00:00.000Z", cover: "cover.jpg", authored: true,
    pages: [{ index: 1, image: "pages/001.jpg", text: "one", audio: "audio/001.mp3" },
            { index: 2, image: "pages/002.jpg", text: "two" }],
  }));
  fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);

  const said = await capture(async () => { await drive.sync(); await drive.sync(); });
  const dest = path.join(D, "books", "Half Arrived");
  assert.ok(fs.existsSync(path.join(dest, "pages", "001.jpg")), "what HAS arrived is mirrored");
  assert.ok(!fs.existsSync(path.join(dest, "manifest.json")), "…but the ready signal is not");
  assert.equal(said.filter(l => l.includes("Half Arrived")).length, 1,
    "said once for the book, not once per ten-minute pass");

  // The rest of the upload lands: the very next pass shelves the whole book.
  fs.writeFileSync(path.join(src, "pages", "002.jpg"), "page two");
  fs.writeFileSync(path.join(src, "audio", "001.mp3"), "mp3");
  await drive.sync();
  const got = JSON.parse(fs.readFileSync(path.join(dest, "manifest.json"), "utf8"));
  assert.equal(got.pages.length, 2, "the manifest arrived whole, with the book under it");
  assert.equal(got.authored, true, "and it is still the week's book");
});

// The other half of the same rule: waiting must never look like deleting. The
// manifest is in the source the whole time it is being skipped, so it stays in
// the source's file list — otherwise the prune below would read "the parent
// deleted it" and take a finished book off the shelf while a re-drop uploads.
test("a book already on the shelf is not taken off it while its source is incomplete", async () => {
  const D = path.join(TMP, "data-redrop"), S = path.join(TMP, "My Drive", "Redrop Content");
  const src = path.join(S, "books", "Re Dropped");
  fs.mkdirSync(path.join(src, "pages"), { recursive: true });
  fs.writeFileSync(path.join(src, "pages", "001.jpg"), "one");
  fs.writeFileSync(path.join(src, "pages", "002.jpg"), "two");
  const manifest = JSON.stringify({ schemaVersion: 1, pages: [
    { index: 1, image: "pages/001.jpg", text: "one" },
    { index: 2, image: "pages/002.jpg", text: "two" }] });
  fs.writeFileSync(path.join(src, "manifest.json"), manifest);
  fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);
  await drive.sync();
  const dest = path.join(D, "books", "Re Dropped");
  assert.ok(fs.existsSync(path.join(dest, "manifest.json")), "shelved whole");

  fs.rmSync(path.join(src, "pages", "002.jpg"));   // mid re-upload
  const r = await drive.sync();
  assert.equal(r.removed, 1, "the page that left the source left the device");
  assert.ok(fs.existsSync(path.join(dest, "manifest.json")),
    "the manifest is skipped, never pruned — the book she has stays readable");
});

// job.json is the anti-rebuild latch and the claim. It has to cross devices on
// its BYTES: a heartbeat a minute later, or `state` going from building to
// done, is the same number of characters as the line before it, and the
// size-equal skip would strand the news on the computer that wrote it — two
// devices then disagree about who owns the book, which is the one thing the
// build door asks.
test("a job.json rewritten to the same length still reaches the other computer", async () => {
  const D = path.join(TMP, "data-latch"), S = path.join(TMP, "My Drive", "Latch Content");
  const src = path.join(S, "books", "Latched");
  fs.mkdirSync(path.join(src, ".build"), { recursive: true });
  fs.writeFileSync(path.join(src, "IMG_0001.jpg"), "img");
  const job = (hb) => JSON.stringify({ state: "building", claimedBy: "kitchen-pc:4120",
                                       startedAt: "2026-09-09T10:00:00.000Z", heartbeat: hb });
  const first = job("2026-09-09T10:00:00.000Z"), later = job("2026-09-09T10:31:00.000Z");
  assert.equal(first.length, later.length, "a heartbeat never changes the file's length");
  fs.writeFileSync(path.join(src, ".build", "job.json"), first);
  fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);

  const dest = path.join(D, "books", "Latched", ".build", "job.json");
  await drive.sync();
  assert.equal(fs.readFileSync(dest, "utf8"), first, "the claim crossed");
  fs.writeFileSync(path.join(src, ".build", "job.json"), later);
  await drive.sync();
  assert.equal(fs.readFileSync(dest, "utf8"), later,
    "the bytes, not the byte count, decide whether the latch is re-copied");
});

// ---- drawings (spec 2026-09-30 §4): a picture made on one device is on every device's shelf,
// a parent deleting its folder in Drive removes it everywhere, and a picture made with no Drive
// folder (.local) is never pruned and goes UP the moment a folder is there.
const PIC = (root, id) => path.join(root, "drawings", id);
const sceneOf = (id, s) => JSON.stringify({ v: 1, id, items: [{ s, x: 0.5, y: 0.5, w: 0.2, by: "ellie" }] });

test("drawings mirror in, a same-length scene.json rewrite still crosses, and a picture deleted in Drive leaves", async () => {
  const D = path.join(TMP, "data-drawings"), S = path.join(TMP, "My Drive", "Drawings Content");
  const id = "2026-09-30-101500-dev-b";
  fs.mkdirSync(PIC(S, id), { recursive: true });
  fs.writeFileSync(path.join(PIC(S, id), "scene.json"), sceneOf(id, "horse"));
  fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);

  await drive.sync();
  const got = path.join(PIC(D, id), "scene.json");
  assert.ok(fs.existsSync(got), "another device's picture reached this shelf");

  fs.writeFileSync(path.join(PIC(S, id), "scene.json"), sceneOf(id, "house"));   // horse -> house: same length
  await drive.sync();
  assert.match(fs.readFileSync(got, "utf8"), /"house"/, "scene.json is compared by content, not by size");

  fs.rmSync(PIC(S, id), { recursive: true });
  const r = await drive.sync();
  assert.equal(r.removed, 1);
  assert.ok(!fs.existsSync(PIC(D, id)), "a picture folder deleted in Drive is deleted here");
});

test("drawings adopt what is already there (it all came through the mirror); a .local picture stays hers", async () => {
  const D = path.join(TMP, "data-drawings-adopt"), S = path.join(TMP, "My Drive", "Adopt Content");
  const old = "2026-09-01-080000-dev-b", mine = "2026-09-02-090000-dev-a";
  fs.mkdirSync(PIC(D, old), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, old), "scene.json"), sceneOf(old, "star"));   // mirrored by an earlier sync, no ledger yet
  fs.mkdirSync(PIC(D, mine), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, mine), "scene.json"), sceneOf(mine, "tree"));
  fs.writeFileSync(path.join(PIC(D, mine), ".local"), "{}");
  fs.mkdirSync(path.join(S, "drawings"), { recursive: true });     // a folder that no longer holds `old`
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);

  await drive.sync();
  assert.ok(!fs.existsSync(PIC(D, old)), "adopted as the mirror's, then pruned: Drive does not have it");
  assert.ok(fs.existsSync(path.join(PIC(D, mine), "scene.json")), "the .local picture is hers, not the mirror's");
});

test("a .local picture is copied up on the next sync (creating <folder>/drawings is allowed) and loses its marker", async () => {
  const D = path.join(TMP, "data-drawings-up"), S = path.join(TMP, "My Drive", "Up Content");
  const owned = "2026-09-29-090000-dev-b", mine = "2026-09-30-120000-dev-a";
  fs.mkdirSync(PIC(D, owned), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, owned), "scene.json"), "{}");
  fs.writeFileSync(path.join(D, "drawings", ".mirrored.json"), JSON.stringify([owned + "/scene.json"]));
  fs.mkdirSync(PIC(D, mine), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, mine), "scene.json"), '{"v":1}');
  fs.writeFileSync(path.join(PIC(D, mine), "picture.png"), "png");
  fs.writeFileSync(path.join(PIC(D, mine), "scene.json.part"), "crash leftover");
  fs.writeFileSync(path.join(PIC(D, mine), ".local"), "{}");
  fs.mkdirSync(S, { recursive: true });                            // the family folder exists; drawings/ does not yet
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);

  const r = await drive.sync();
  assert.deepEqual(r.errors, []);
  assert.equal(fs.readFileSync(path.join(PIC(S, mine), "scene.json"), "utf8"), '{"v":1}', "her picture went up");
  assert.ok(fs.existsSync(path.join(PIC(S, mine), "picture.png")));
  assert.ok(!fs.existsSync(path.join(PIC(S, mine), ".local")), "the marker never travels");
  assert.ok(!fs.existsSync(path.join(PIC(S, mine), "scene.json.part")), "nor does a .part leftover");
  assert.ok(!fs.existsSync(path.join(PIC(D, mine), ".local")), "the mirror owns it now");
  assert.ok(fs.existsSync(path.join(PIC(D, mine), "scene.json")), "and it is still on this shelf");
  // review 9/30 #5: drawings/ was ABSENT when this pass began (absent = leave ours alone); the copy-up
  // made it, and a folder this pass made is not yet Drive's word on what the family has.
  assert.ok(fs.existsSync(PIC(D, owned)), "nothing is pruned against a drawings/ folder this very pass created");
  const r2 = await drive.sync();
  assert.deepEqual(r2.errors, []);
  assert.ok(!fs.existsSync(PIC(D, owned)), "the mirror's copy of a picture Drive no longer has went — on the next pass");
  assert.ok(fs.existsSync(path.join(PIC(D, mine), "scene.json")), "hers stays");
});

// review 9/30 #6: a .local marker inside a picture folder IN DRIVE (a folder copied by hand) must never
// come down: here it would make the picture "made with no folder", so every pass would copy it up again
// and rewrite scene.json in the family's folder.
test("a .local marker in the Drive folder never comes down, so nothing ping-pongs back up", async () => {
  const D = path.join(TMP, "data-drawings-marker"), S = path.join(TMP, "My Drive", "Marker Content");
  const id = "2026-09-30-160000-dev-c";
  fs.mkdirSync(PIC(S, id), { recursive: true });
  fs.writeFileSync(path.join(PIC(S, id), "scene.json"), sceneOf(id, "cloud"));
  fs.writeFileSync(path.join(PIC(S, id), ".local"), "{}");
  fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);
  await drive.sync();
  assert.ok(fs.existsSync(path.join(PIC(D, id), "scene.json")), "the picture came down");
  assert.ok(!fs.existsSync(path.join(PIC(D, id), ".local")), "its marker did not");
  const r = await drive.sync();
  assert.deepEqual([r.files, r.errors], [0, []], "an unchanged picture is copied neither up nor down");
  assert.ok(!fs.existsSync(path.join(PIC(D, id), ".local")));
});

test("a .local picture the copy-up could not carry keeps its marker and is never pruned, even if a ledger claims it", async () => {
  const D = path.join(TMP, "data-drawings-stuck"), S = path.join(TMP, "My Drive", "Stuck Content");
  const mine = "2026-09-30-130000-dev-a";
  fs.mkdirSync(PIC(D, mine), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, mine), "scene.json"), '{"v":1}');
  fs.writeFileSync(path.join(PIC(D, mine), ".local"), "{}");
  fs.writeFileSync(path.join(D, "drawings", ".mirrored.json"), JSON.stringify([mine + "/scene.json"]));
  fs.mkdirSync(path.join(S, "drawings"), { recursive: true });
  fs.chmodSync(path.join(S, "drawings"), 0o555);                   // a read-only Drive folder: the copy-up fails
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);
  try {
    const r = await drive.sync();
    assert.ok(r.errors.some(e => e.includes(mine)), "the failed copy-up is reported, not swallowed: " + JSON.stringify(r.errors));
    assert.ok(fs.existsSync(path.join(PIC(D, mine), "scene.json")), "provenance loses to the marker");
    assert.ok(fs.existsSync(path.join(PIC(D, mine), ".local")), "and the marker stays until a copy-up succeeds");
  } finally { fs.chmodSync(path.join(S, "drawings"), 0o755); }
});

// review 9/30 #7: a rewrite the Drive folder refused waits here, .local, for a copy-up. While it waits,
// the Drive folder's OLDER copy of the same picture must never be copied down over it.
test("a picture waiting to go up (.local) is never overwritten by the older copy in the Drive folder", async () => {
  const D = path.join(TMP, "data-drawings-waiting"), S = path.join(TMP, "My Drive", "Waiting Content");
  const id = "2026-09-30-170000-dev-a";
  fs.mkdirSync(PIC(S, id), { recursive: true });
  fs.writeFileSync(path.join(PIC(S, id), "scene.json"), sceneOf(id, "horse"));       // what Drive has
  fs.mkdirSync(PIC(D, id), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, id), "scene.json"), sceneOf(id, "house"));       // her newer rewrite
  fs.writeFileSync(path.join(PIC(D, id), ".local"), "{}");
  fs.chmodSync(PIC(S, id), 0o555);                                                   // and Drive still refuses it
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);
  try {
    const r = await drive.sync();
    assert.ok(r.errors.some((e) => e.includes(id)), "the copy-up failed: " + JSON.stringify(r.errors));
    assert.match(fs.readFileSync(path.join(PIC(D, id), "scene.json"), "utf8"), /"house"/, "her rewrite stands");
    assert.ok(fs.existsSync(path.join(PIC(D, id), ".local")));
  } finally { fs.chmodSync(PIC(S, id), 0o755); }
  await drive.sync();
  assert.match(fs.readFileSync(path.join(PIC(S, id), "scene.json"), "utf8"), /"house"/, "and goes up once Drive takes it");
  assert.ok(!fs.existsSync(path.join(PIC(D, id), ".local")));
});

test("mirrorDrawing: one picture onto this shelf now, ledger merged not replaced, blocked without a local folder", () => {
  const D = path.join(TMP, "data-drawings-one"), S = path.join(TMP, "My Drive", "One Content");
  const id = "2026-09-30-140000-dev-a", other = "2026-09-01-080000-dev-b";
  fs.mkdirSync(PIC(S, id), { recursive: true });
  fs.writeFileSync(path.join(PIC(S, id), "scene.json"), sceneOf(id, "sun"));
  fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "off" }));
  drive.start(D);
  assert.equal(drive.mirrorDrawing(id).blocked, "needs-local-drive");

  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  fs.mkdirSync(path.join(D, "drawings"), { recursive: true });
  fs.writeFileSync(path.join(D, "drawings", ".mirrored.json"), JSON.stringify([other + "/scene.json"]));
  const r = drive.mirrorDrawing(id);
  assert.equal(r.picture, id);
  assert.equal(r.files, 1);
  assert.deepEqual(r.errors, []);
  assert.ok(fs.existsSync(path.join(PIC(D, id), "scene.json")));
  const ledger = JSON.parse(fs.readFileSync(path.join(D, "drawings", ".mirrored.json"), "utf8"));
  assert.ok(ledger.includes(id + "/scene.json"), "this picture is the mirror's now");
  assert.ok(ledger.includes(other + "/scene.json"), "merged, never replaced");
  assert.equal(drive.mirrorDrawing("../books").error, "unknown picture");
  assert.equal(drive.mirrorDrawing(".local").error, "unknown picture");
  assert.equal(drive.mirrorDrawing("2026-09-30-999999-nope").error, "unknown picture");
  assert.equal(drive.LOCAL_MARKER, ".local");
  assert.equal(typeof drive.atomically, "function");
});

// The skip in listTree is only visible where an ADOPTED set is persisted: mirrorDrawing writes the
// ledger it loaded (sync writes the source's files instead). Without the skip her .local picture
// would be recorded as the mirror's, and pruned the day it left the source.
test("adoption never claims a .local picture: the first ledger a mirrorDrawing writes names only what the mirror owns", () => {
  const D = path.join(TMP, "data-drawings-ledger"), S = path.join(TMP, "My Drive", "Ledger Content");
  const old = "2026-09-01-080000-dev-b", mine = "2026-09-02-090000-dev-a", id = "2026-09-30-150000-dev-a";
  fs.mkdirSync(PIC(D, old), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, old), "scene.json"), sceneOf(old, "star"));      // came through the mirror, no ledger yet
  fs.mkdirSync(PIC(D, mine), { recursive: true });
  fs.writeFileSync(path.join(PIC(D, mine), "scene.json"), sceneOf(mine, "tree"));
  fs.writeFileSync(path.join(PIC(D, mine), ".local"), "{}");                      // made here with no folder
  fs.mkdirSync(PIC(S, id), { recursive: true });
  fs.writeFileSync(path.join(PIC(S, id), "scene.json"), sceneOf(id, "sun"));
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);
  assert.deepEqual(drive.mirrorDrawing(id).errors, []);
  const ledger = JSON.parse(fs.readFileSync(path.join(D, "drawings", ".mirrored.json"), "utf8")).sort();
  assert.deepEqual(ledger, [old + "/scene.json", id + "/scene.json"].sort(), "her .local picture is not the mirror's to prune later");
});

// ---- characters (spec 2026-10-02 §4): Drawing's People library rides the mirror like drawings —
// it all arrives through the mirror (adopted on the first sync), a person removed in Drive leaves
// every device, and characters.json is compared by its bytes (dad edits words of the same length).
test("characters mirror in, adopt what is there, follow deletions, and a same-length characters.json edit still crosses", async () => {
  const D = path.join(TMP, "data-characters"), S = path.join(TMP, "My Drive", "Characters Content");
  const src = (f) => path.join(S, "characters", f), here = (f) => path.join(D, "characters", f);
  fs.mkdirSync(path.join(S, "characters"), { recursive: true });
  fs.writeFileSync(src("maya.png"), "png-a");
  fs.writeFileSync(src("sam.png"), "png-b");
  const j1 = JSON.stringify({ v: 1, people: [{ slug: "maya", word: "Maya" }, { slug: "sam", word: "Sam" }] });
  fs.writeFileSync(src("characters.json"), j1);
  fs.mkdirSync(path.join(D, "characters"), { recursive: true });
  fs.writeFileSync(here("old.png"), "an earlier sync's copy");       // no ledger yet: adopted, so it follows Drive
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: S }));
  drive.start(D);
  await drive.sync();
  assert.ok(fs.existsSync(here("maya.png")) && fs.existsSync(here("sam.png")), "the library reached this device");
  assert.ok(!fs.existsSync(here("old.png")), "adopted on the first sync");
  const j2 = j1.replace('"Sam"', '"Kai"');
  assert.equal(j2.length, j1.length);
  fs.writeFileSync(src("characters.json"), j2);
  await drive.sync();
  assert.equal(fs.readFileSync(here("characters.json"), "utf8"), j2, "compared by content, not by size");
  fs.rmSync(src("sam.png"));
  await drive.sync();
  assert.ok(!fs.existsSync(here("sam.png")), "a person removed in Drive leaves this device");
  assert.ok(fs.existsSync(here("maya.png")));
});
