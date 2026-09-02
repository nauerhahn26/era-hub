// drive-mirror.test.mjs — the Drive folder IS the wardrobe (dad 9/2: "delete
// clothes from the library that no longer fit or add new clothes and all that
// should just work by adding to the clothing directory"). The Drive-for-
// Desktop mirror copies new photos in AND drops photos that left the folder,
// then tells the clothing pipeline so the board follows the same day.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-drv-"));
const DATA = path.join(TMP, "data");
const SRC = path.join(TMP, "My Drive", "New ERA Content");   // what Drive for Desktop shows
const require = createRequire(path.join(HUB, "server.js"));
let drive;
const synced = [];

before(() => {
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
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

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
