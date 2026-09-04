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
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-drv-"));
const DATA = path.join(TMP, "data");
const API_DATA = path.join(TMP, "data-api");   // the API-mode half keeps its own dir
const SRC = path.join(TMP, "My Drive", "New ERA Content");   // what Drive for Desktop shows
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

before(async () => {
  api = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const media = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (media && u.searchParams.get("alt") === "media") {
      downloads.push(media[1]);
      res.writeHead(200).end("xx");
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
    ["books", "music", "movies", "content", "clothing"]);
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
