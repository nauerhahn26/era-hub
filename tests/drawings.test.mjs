// drawings.test.mjs — the Drawing app's hub half (spec docs/superpowers/specs/2026-09-30-drawing-design.md):
// the vendored stickers (§6), the drawings.js module (§4) and its routes (§5). Synthetic fixtures only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRAW = path.join(HUB, "public", "drawing");
const TABLE = JSON.parse(fs.readFileSync(path.join(DRAW, "stickers.json"), "utf8"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-drawings-"));

// ---- §6 the stickers ---------------------------------------------------------
test("the eight stickers sit in their fixed seats: ground things left, sky things then the splat right", () => {
  assert.deepEqual(TABLE.stickers.map(s => s.id), ["house", "horse", "tree", "person", "sun", "cloud", "star", "splat"]);
  assert.deepEqual(TABLE.stickers.map(s => s.at.join(",")), ["1,1", "2,1", "3,1", "4,1", "1,3", "2,3", "3,3", "4,3"]);
  assert.deepEqual(TABLE.stickers.map(s => s.word), ["House", "Horse", "Tree", "Person", "Sun", "Cloud", "Star", "Splat"]);
  assert.deepEqual(TABLE.stickers.map(s => s.zone), ["ground", "ground", "ground", "ground", "sky", "sky", "sky", "any"]);
  assert.equal(TABLE.stickers.find(s => s.id === "person").plural, "people");
});

test("every image sticker is vendored, matches its sha256 pin and is at least 256 px; the splat has no asset", () => {
  execFileSync(process.execPath, [path.join(HUB, "tools", "drawing-fetch-stickers.mjs"), "--check"], { stdio: "pipe" });
  for (const s of TABLE.stickers) {
    if (s.id === "splat") { assert.equal(s.src, null); continue; }
    const b = fs.readFileSync(path.join(DRAW, s.src));
    assert.equal(b.readUInt32BE(0), 0x89504e47, s.id + " is a PNG");
    assert.ok(b.readUInt32BE(16) >= 256 && b.readUInt32BE(20) >= 256, s.id + " is at least 256 px");
    assert.match(s.source, /^https:\/\/raw\.githubusercontent\.com\/microsoft\/fluentui-emoji\/[0-9a-f]{40}\/assets\//);
    assert.match(s.sha256, /^[0-9a-f]{64}$/);
  }
});

test("the MIT licence travels beside the stickers", () => {
  const lic = fs.readFileSync(path.join(DRAW, "stickers", "LICENSE"), "utf8");
  assert.match(lic, /MIT License/);
  assert.match(lic, /Microsoft Corporation/);
});

test("zones: 0-1 slots, sky above the horizon, ground bases on the grass, centre first; scales as the spec", () => {
  assert.equal(TABLE.horizon, 0.58);
  assert.equal(TABLE.lapOffset, 0.04);
  assert.deepEqual(TABLE.aspect, [16, 9]);
  for (const s of TABLE.zones.sky.slots) assert.ok(s.x > 0 && s.x < 1 && s.y > 0 && s.y < TABLE.horizon, JSON.stringify(s));
  for (const s of TABLE.zones.ground.slots) assert.ok(s.x > 0 && s.x < 1 && s.base > TABLE.horizon && s.base <= 1, JSON.stringify(s));
  for (const s of TABLE.zones.any.slots) assert.ok(s.x > 0 && s.x < 1 && s.y > 0 && s.y < 1, JSON.stringify(s));
  assert.equal(TABLE.zones.ground.slots.length, 7);
  assert.equal(TABLE.zones.sky.slots.length, 7);
  assert.equal(TABLE.zones.any.slots.length, 12);
  assert.equal(TABLE.zones.ground.slots[0].x, 0.5, "ground fills centre-out");
  assert.equal(TABLE.zones.sky.slots[0].x, 0.5, "sky fills centre-out");
  const scale = Object.fromEntries(TABLE.stickers.map(s => [s.id, s.scale]));
  assert.deepEqual(scale, { house: 0.26, horse: 0.20, tree: 0.28, person: 0.22, sun: 0.16, cloud: 0.14, star: 0.10, splat: [0.12, 0.18] });
});

// ---- v2 (spec 2026-10-02 §1-§5): the mode row, the crayons, the places --------------
const SEAT_KEYS = ["1,1", "2,1", "3,1", "4,1", "1,3", "2,3", "3,3", "4,3"];
test("v2 tables: four modes in their row-5 seats, eight crayons and eight places in fixed seats, no partner red", () => {
  assert.deepEqual(TABLE.modes.map(m => [m.id, m.word, m.seat]),
    [["draw", "Draw", 1], ["people", "People", 2], ["stickers", "Stickers", 4], ["places", "Places", 5]]);
  assert.deepEqual(TABLE.crayons.map(c => c.at.join(",")), SEAT_KEYS);
  assert.deepEqual(TABLE.crayons.map(c => [c.word, c.hex]), [["Black", "#1b1b1b"], ["Blue", "#0F7C8A"], ["Green", "#2E7D5B"],
    ["Yellow", "#B7822B"], ["Red-orange", "#DE7B52"], ["Purple", "#6a4fb3"], ["Pink", "#d96fa6"], ["White", "#f7f7f7"]]);
  assert.equal(TABLE.crayonDefault, "#0F7C8A", "Blue first");
  assert.ok(!TABLE.crayons.some(c => c.hex.toLowerCase() === "#b23a48"), "partner red is never a crayon");
  assert.deepEqual(TABLE.backdrops.map(b => [b.id, b.word]), [["meadow", "Meadow"], ["beach", "Beach"], ["night", "Night"],
    ["snow", "Snow"], ["sunset", "Sunset"], ["forest", "Forest"], ["city", "City"], ["rainbow", "Rainbow"]]);
  assert.deepEqual(TABLE.backdrops.map(b => b.at.join(",")), SEAT_KEYS);
  assert.deepEqual(TABLE.stickers.map(s => s.at.join(",")), SEAT_KEYS, "the stickers already sit in the same seats");
  assert.equal(TABLE.horizon, 0.58, "the slot tables are written against the meadow's horizon");
});

test("every mode glyph is vendored and pinned like the stickers; Stickers reuses the star", () => {
  execFileSync(process.execPath, [path.join(HUB, "tools", "drawing-fetch-stickers.mjs"), "--check"], { stdio: "pipe" });
  for (const m of TABLE.modes) {
    const b = fs.readFileSync(path.join(DRAW, m.src));
    assert.equal(b.readUInt32BE(0), 0x89504e47, m.id + " is a PNG");
    assert.ok(b.readUInt32BE(16) >= 256 && b.readUInt32BE(20) >= 256, m.id + " is at least 256 px");
    assert.match(m.source, /^https:\/\/raw\.githubusercontent\.com\/microsoft\/fluentui-emoji\/[0-9a-f]{40}\/assets\//);
    assert.equal(crypto.createHash("sha256").update(b).digest("hex"), m.sha256, m.id + " matches its pin");
  }
  assert.equal(TABLE.modes.find(m => m.id === "stickers").src, TABLE.stickers.find(s => s.id === "star").src);
});

// trash mode (dad 10/4): the 🗑 tile in the door bar's top-right corner wears Fluent's Wastebasket,
// vendored and pinned at the same commit as every other glyph.
test("the bar's Trash glyph is vendored and pinned like the stickers, at the same Fluent commit", () => {
  execFileSync(process.execPath, [path.join(HUB, "tools", "drawing-fetch-stickers.mjs"), "--check"], { stdio: "pipe" });
  assert.deepEqual((TABLE.bar || []).map(b => [b.id, b.word, b.src]), [["trash", "Trash", "stickers/bar-trash.png"]]);
  for (const t of TABLE.bar) {
    const b = fs.readFileSync(path.join(DRAW, t.src));
    assert.equal(b.readUInt32BE(0), 0x89504e47, t.id + " is a PNG");
    assert.ok(b.readUInt32BE(16) >= 256 && b.readUInt32BE(20) >= 256, t.id + " is at least 256 px");
    assert.equal(t.source, `https://raw.githubusercontent.com/microsoft/fluentui-emoji/${TABLE.source.commit}/assets/Wastebasket/3D/wastebasket_3d.png`);
    assert.equal(crypto.createHash("sha256").update(b).digest("hex"), t.sha256, t.id + " matches its pin");
  }
});

// ---- §4 the module ------------------------------------------------------------
const require = createRequire(path.join(HUB, "server.js"));
const drive = require("./drive.js");
const drawings = require("./drawings.js");

const UNIT = path.join(TMP, "unit");                                 // this device's <DATA>
const MOUNT = path.join(TMP, "My Drive", "New ERA Content");          // the family's Drive folder
const H = { s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" };
let clock = new Date("2026-09-30T17:15:42Z");

// mode: "mount" (folder there) | "offline" (drive.json names a folder that is not there) | "none"
function freshUnit(mode, tz = "UTC") {
  fs.rmSync(UNIT, { recursive: true, force: true });
  fs.rmSync(path.join(TMP, "My Drive"), { recursive: true, force: true });
  fs.mkdirSync(UNIT, { recursive: true });
  if (mode !== "none") fs.writeFileSync(path.join(UNIT, "drive.json"), JSON.stringify({ mode: "local", folderPath: MOUNT }));
  if (mode === "mount") fs.mkdirSync(MOUNT, { recursive: true });
  drive.start(UNIT);
  drawings.start(UNIT, { deviceId: "kitchen-pc-3f9a", tz: () => tz, now: () => clock });
}
const onShelf = (id) => path.join(UNIT, "drawings", id);
const inDrive = (id) => path.join(MOUNT, "drawings", id);

test("an id is the date, the time (hub zone) and this device, and a taken one is never reused", () => {
  freshUnit("none");
  const a = drawings.create().id;
  assert.equal(a, "2026-09-30-171542-kitchen-pc-3f9a");
  assert.equal(drawings.create().id, a + "-2", "same second, same device: a second folder, not the first one again");
  freshUnit("none", "America/Los_Angeles");
  assert.equal(drawings.newId(), "2026-09-30-101542-kitchen-pc-3f9a", "the family's clock, not UTC");
  assert.equal(drawings.shortDevice("kitchen-pc-3f9a"), "kitchen-pc-3f9a");
  assert.equal(drawings.shortDevice("desktop-abcdefghijkl-7f3k"), "desktop-abc-7f3k", "long ids keep their random tail");
  for (const ok of [a, a + "-2", "2026-01-01-000000-gate"]) assert.equal(drawings.isId(ok), true, ok);
  for (const bad of ["../x", "2026-09-30-171542-", "2026-9-30-171542-x", "2026-09-30-171542-X",
                     "2026-09-30-171542-a/b", "index.json", "2026-09-30-171542-dev (1)", "", null])
    assert.equal(drawings.isId(bad), false, String(bad));
});

test("validation: unknown stickers, out-of-range numbers, bad splats, too many items and other versions are refused", () => {
  freshUnit("none");
  const ok = drawings.validateScene({ v: 1, backdrop: "meadow", items: [H] });
  assert.equal(ok.ok, true);
  for (const [why, items] of [
    ["unknown sticker", [{ ...H, s: "dragon" }]],
    ["x over 1", [{ ...H, x: 1.2 }]],
    ["y under 0", [{ ...H, y: -0.01 }]],
    ["w zero", [{ ...H, w: 0 }]],
    ["x a string", [{ ...H, x: "0.5" }]],
    ["by someone else", [{ ...H, by: "robot" }]],
    ["splat colour", [{ s: "splat", x: 0.5, y: 0.5, w: 0.15, by: "ellie", c: "red", seed: 3 }]],
    ["splat seed", [{ s: "splat", x: 0.5, y: 0.5, w: 0.15, by: "ellie", c: "#0F7C8A", seed: -1 }]],
    ["an item that is not an object", [7]],
  ]) assert.equal(drawings.validateScene({ v: 1, backdrop: "meadow", items }).ok, false, why);
  const many = Array.from({ length: 201 }, () => ({ s: "star", x: 0.5, y: 0.2, w: 0.1, by: "ellie" }));
  assert.equal(drawings.validateScene({ v: 1, backdrop: "meadow", items: many }).ok, false, "201 items");
  assert.equal(drawings.validateScene({ v: 1, backdrop: "meadow", items: many.slice(1) }).ok, true, "200 is the cap, not over it");
  assert.equal(drawings.validateScene({ v: 2, backdrop: "meadow", items: [] }).ok, false, "v2");
  assert.equal(drawings.validateScene({ v: 1, backdrop: "beach", items: [] }).scene.backdrop, "beach", "eight places in v2");
  assert.equal(drawings.validateScene([]).ok, false);
  assert.equal(drawings.validateScene(null).ok, false);
  const norm = drawings.validateScene({ v: 1, backdrop: "meadow",
    items: [{ ...H, c: "#000000", extra: 1 }, { s: "splat", x: 0.3, y: 0.3, w: 0.15, c: "#DE7B52", seed: 9 }] });
  assert.deepEqual(norm.scene.items, [H, { s: "splat", x: 0.3, y: 0.3, w: 0.15, by: "ellie", c: "#DE7B52", seed: 9 }],
    "only known keys, in one order; colour and seed only on splats; by defaults to ellie");
});

test("with a Drive folder: the write lands in it (.part-atomic) and on this shelf at once, and the ledger owns it", () => {
  freshUnit("mount");
  const { id } = drawings.create();
  assert.ok(fs.existsSync(path.join(inDrive(id), "scene.json")), "canonical = the family's Drive folder");
  assert.ok(fs.existsSync(path.join(onShelf(id), "scene.json")), "mirrorDrawing put it on this shelf");
  assert.ok(!fs.existsSync(path.join(onShelf(id), ".local")));
  const w = drawings.writeScene(id, { v: 1, backdrop: "meadow", items: [H] });
  assert.equal(w.ok, true);
  assert.equal(w.mount, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(onShelf(id), "scene.json"), "utf8")).items.length, 1);
  assert.deepEqual(fs.readdirSync(inDrive(id)).filter(n => n.endsWith(".part")), [], "no .part left behind");
  const ledger = JSON.parse(fs.readFileSync(path.join(UNIT, "drawings", ".mirrored.json"), "utf8"));
  assert.ok(ledger.includes(id + "/scene.json"));
});

test("with no Drive folder (or an offline one): the write stays on this device, marked .local; the family folder is never created", () => {
  for (const mode of ["none", "offline"]) {
    freshUnit(mode);
    const { id } = drawings.create();
    assert.ok(fs.existsSync(path.join(onShelf(id), "scene.json")), mode);
    assert.ok(fs.existsSync(path.join(onShelf(id), ".local")), mode + ": marked as this device's own");
    assert.equal(fs.existsSync(MOUNT), false, mode + ": no folder conjured for the family");
    assert.equal(drawings.writeScene(id, { v: 1, backdrop: "meadow", items: [H] }).mount, false);
  }
});

test("the hub keeps created, device and mailedHash; a body cannot rewrite them; updated moves with every save", () => {
  freshUnit("none");
  const { id, scene } = drawings.create();
  clock = new Date("2026-09-30T17:20:00Z");
  const w = drawings.writeScene(id, { v: 1, backdrop: "meadow", items: [H],
    id: "2000-01-01-000000-evil", created: "1999-01-01T00:00:00Z", device: "evil", mailedHash: "x", updated: "1999" });
  assert.equal(w.ok, true);
  const s = drawings.readScene(id);
  assert.equal(s.id, id);
  assert.equal(s.created, scene.created);
  assert.equal(s.device, "kitchen-pc-3f9a");
  assert.equal(s.mailedHash, null);
  assert.equal(s.updated, "2026-09-30T17:20:00.000Z");
  assert.equal(drawings.writeScene("../x", { v: 1, backdrop: "meadow", items: [] }).error, "bad-id");
  assert.equal(drawings.writeScene(id, { v: 1, backdrop: "meadow", items: [{ ...H, s: "dragon" }] }).error, "bad-scene");
  clock = new Date("2026-09-30T17:15:42Z");
});

test("a write that cannot land says so in a word and never throws", () => {
  freshUnit("none");
  const { id } = drawings.create();
  fs.chmodSync(onShelf(id), 0o555);
  try {
    let r;
    assert.doesNotThrow(() => { r = drawings.writeScene(id, { v: 1, backdrop: "meadow", items: [H] }); });
    assert.equal(r.error, "write-failed");
  } finally { fs.chmodSync(onShelf(id), 0o755); }
});

// Review Focus 4: junk in the folder never reaches her shelf and never breaks it.
test("list: non-empty pictures only, newest change first; Drive conflict copies, half-written and foreign folders skipped", () => {
  freshUnit("none");
  const put = (id, items, updated, raw) => {
    fs.mkdirSync(onShelf(id), { recursive: true });
    fs.writeFileSync(path.join(onShelf(id), "scene.json"), raw || JSON.stringify(
      { v: 1, id, created: "2026-09-29T08:00:00Z", updated, device: "dev-b", backdrop: "meadow", items, mailedHash: null }));
  };
  put("2026-09-29-080000-dev-a", [H], "2026-09-30T10:00:00Z");
  put("2026-09-29-080000-dev-b", [H, H], "2026-09-30T11:00:00Z");
  put("2026-09-29-080000-dev-c", [], "2026-09-30T12:00:00Z");                    // empty: not listed
  put("2026-09-29-080000-dev-d", [H], "2026-09-30T13:00:00Z", '{"v":1,"items":[');  // half-written
  put("2026-09-29-080000-dev-b (1)", [H], "2026-09-30T14:00:00Z");                 // a Drive conflict copy
  put("2026-09-29-080000-dev-e", [{ ...H, s: "dragon" }], "2026-09-30T15:00:00Z"); // from a future version
  fs.mkdirSync(onShelf("2026-09-29-080000-dev-f"), { recursive: true });           // no scene at all
  fs.mkdirSync(onShelf("notes"), { recursive: true });
  fs.writeFileSync(path.join(UNIT, "drawings", "stray.txt"), "x");
  let l;
  assert.doesNotThrow(() => { l = drawings.list(); });
  assert.deepEqual(l.map(p => p.id), ["2026-09-29-080000-dev-b", "2026-09-29-080000-dev-a"]);
  assert.deepEqual(Object.keys(l[0]).sort(), ["created", "device", "id", "items", "scene", "updated"]);
  assert.equal(l[0].items, 2);
  assert.equal(l[0].scene.items.length, 2, "the scene rides inline so the shelf draws in one request");
});

test("cleanup: empty pictures older than a day go from both places; new, non-empty and unreadable ones stay", () => {
  freshUnit("mount");
  // every picture here is this device's own (review 9/30 #2: cleanup judges no other device's)
  const mk = (root, id, items, created, raw) => {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, "scene.json"), raw || JSON.stringify({ v: 1, id, created, device: "kitchen-pc-3f9a", items }));
  };
  const drv = path.join(MOUNT, "drawings"), mine = path.join(UNIT, "drawings");
  mk(drv, "2026-09-28-080000-dev-a", [], "2026-09-28T08:00:00Z");       // empty, two days old: goes
  mk(mine, "2026-09-28-080000-dev-a", [], "2026-09-28T08:00:00Z");      // …and its mirror copy
  mk(mine, "2026-09-28-090000-dev-a", [], "2026-09-28T09:00:00Z");      // .local-style, empty and old: goes
  mk(drv, "2026-09-30-170000-dev-a", [], "2026-09-30T17:00:00Z");       // empty but 15 minutes old: stays
  mk(drv, "2026-09-20-080000-dev-a", [H], "2026-09-20T08:00:00Z");      // old but she drew on it: stays
  mk(drv, "2026-09-21-080000-dev-a", null, null, "{broken");           // unreadable: never ours to delete
  const r = drawings.cleanupEmpty();
  assert.deepEqual(r.removed.sort(), ["2026-09-28-080000-dev-a", "2026-09-28-080000-dev-a", "2026-09-28-090000-dev-a"]);
  assert.ok(!fs.existsSync(path.join(drv, "2026-09-28-080000-dev-a")));
  assert.ok(!fs.existsSync(path.join(mine, "2026-09-28-080000-dev-a")));
  for (const id of ["2026-09-30-170000-dev-a", "2026-09-20-080000-dev-a", "2026-09-21-080000-dev-a"])
    assert.ok(fs.existsSync(path.join(drv, id)), id + " stayed");
});

// review 9/30 #2: this device's copy of the Drive folder may be stale, so it never deletes another
// device's picture there; and a blank is aged by its last change, so a picture the partner Cleared a
// minute ago (born days ago) is not taken at the next boot.
test("cleanup: only this device's own blanks, aged by their last change — another device's and a fresh Clear stay", () => {
  freshUnit("mount");
  const mk = (root, id, sc) => {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, "scene.json"), JSON.stringify({ v: 1, id, items: [], ...sc }));
  };
  const drv = path.join(MOUNT, "drawings"), mine = path.join(UNIT, "drawings");
  const theirs = "2026-09-27-080000-dev-b", cleared = "2026-09-27-090000-kitchen-pc-3f9a", old = "2026-09-27-100000-kitchen-pc-3f9a";
  const t = { created: "2026-09-27T08:00:00Z", updated: "2026-09-27T08:00:00Z", device: "dev-b" };
  mk(drv, theirs, t);                                                     // another device's, old: not ours to judge
  mk(mine, theirs, t);                                                    // …nor its mirror copy here
  mk(drv, cleared, { created: "2026-09-27T09:00:00Z", updated: "2026-09-30T17:14:00Z", device: "kitchen-pc-3f9a" });
  mk(drv, old, { created: "2026-09-27T10:00:00Z", updated: "2026-09-28T10:00:00Z", device: "kitchen-pc-3f9a" });
  const r = drawings.cleanupEmpty();
  assert.deepEqual(r.removed, [old], "only this device's own blank, untouched for over a day");
  assert.ok(fs.existsSync(path.join(drv, theirs)), "another device's blank stays in the family's folder");
  assert.ok(fs.existsSync(path.join(mine, theirs)), "and on this shelf");
  assert.ok(fs.existsSync(path.join(drv, cleared)), "cleared a minute ago: its last change is fresh");
  assert.ok(!fs.existsSync(path.join(drv, old)));
});

// review 9/30 #10: drive.status() scans every drive letter and lists folders; a save asked it twice
// and a Done four times. Where a picture lives is one read of drive.json and one stat.
test("where a picture lives is drive.json plus one stat: drawings never calls drive.status", () => {
  const real = drive.status;
  drive.status = () => { throw new Error("drawings.js called drive.status"); };
  try {
    freshUnit("mount");
    assert.equal(drive.localFolder(), MOUNT);
    const { id } = drawings.create();
    assert.ok(drawings.isId(id));
    const w = drawings.writeScene(id, { v: 1, backdrop: "meadow", items: [H] });
    assert.deepEqual([w.ok, w.mount], [true, true]);
    assert.deepEqual(drawings.readScene(id).items, [H]);
    assert.ok(fs.existsSync(path.join(inDrive(id), "scene.json")));
    drawings.cleanupEmpty();
    freshUnit("offline");
    assert.equal(drive.localFolder(), null, "a folder that is not there is no mount");
    assert.equal(drawings.create().id.endsWith("kitchen-pc-3f9a"), true);
    freshUnit("none");
    assert.equal(drive.localFolder(), null);
  } finally { drive.status = real; }
});

// ---- v2 (spec 2026-10-02 §3-§5, §7): strokes, crayons, places, people -------------------
// A tiny real PNG (RGBA, one colour) — family images never enter this repo (spec §4).
function tinyPng(w, h, rgba = [51, 102, 204, 255]) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 4).fill(Buffer.from(rgba))]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
const CH = () => path.join(UNIT, "characters");
function library(people, pngs = people.map((p) => p.slug)) {
  fs.mkdirSync(CH(), { recursive: true });
  for (const s of pngs) fs.writeFileSync(path.join(CH(), s + ".png"), tinyPng(16, 32));
  fs.writeFileSync(path.join(CH(), "characters.json"), JSON.stringify({ v: 1, people }));
}
const S1 = { s: "stroke", c: "#d96fa6", w: 0.014, pts: [[0.1, 0.2], [0.3, 0.4]], by: "ellie" };
const P = (slug) => ({ s: "person:" + slug, x: 0.5, y: 0.77, w: 0.3, by: "ellie" });

test("v2 validation: strokes, crayons and places; unknown place → meadow, unknown crayon → Blue", () => {
  freshUnit("none");
  const v = drawings.validateScene({ v: 1, backdrop: "city", crayon: "#d96fa6", items: [S1, H] });
  assert.deepEqual(v, { ok: true, scene: { v: 1, backdrop: "city", crayon: "#d96fa6", items: [S1, H] } });
  assert.equal(drawings.validateScene({ v: 1, backdrop: "volcano", items: [] }).scene.backdrop, "meadow");
  assert.equal(drawings.validateScene({ v: 1, crayon: "#B23A48", items: [] }).scene.crayon, "#0F7C8A", "partner red is never a crayon");
  assert.equal(drawings.validateScene({ v: 1, items: [] }).scene.crayon, "#0F7C8A");
  for (const [why, it] of [
    ["one point", { ...S1, pts: [[0.1, 0.2]] }], ["401 points", { ...S1, pts: Array.from({ length: 401 }, () => [0.5, 0.5]) }],
    ["a point outside", { ...S1, pts: [[0.1, 0.2], [1.2, 0.4]] }], ["a point not a pair", { ...S1, pts: [[0.1, 0.2], [0.3]] }],
    ["not a crayon", { ...S1, c: "#B23A48" }], ["too thin", { ...S1, w: 0.004 }], ["too thick", { ...S1, w: 0.06 }],
    ["pts not a list", { ...S1, pts: "M0 0" }], ["by a robot", { ...S1, by: "robot" }],
  ]) assert.equal(drawings.validateScene({ v: 1, items: [it] }).ok, false, why);
  assert.equal(drawings.validateScene({ v: 1, items: [{ ...S1, c: "#D96FA6" }] }).ok, true, "hex compared case-insensitively");
  assert.equal(drawings.validateScene({ v: 1, items: Array(201).fill(S1) }).ok, false, "a stroke is one item toward the 200");
  assert.equal(drawings.validateScene({ v: 1, items: [P("maya")] }).ok, true, "a person is checked by shape only (review 10/3 #5)");
  assert.equal(drawings.validateScene({ v: 1, items: [{ ...P("maya"), s: "person:Maya!" }] }).ok, false, "a slug is a-z0-9-");
  assert.equal(drawings.validateScene({ v: 1, items: [{ ...P("maya"), x: 2 }] }).ok, false, "a person is placed like a sticker");
});

// The built-in People library (dad 10/7): eight generic people shipped in public/drawing/people/, what
// a family without its own characters/ sees. Never real people.
const DEF_DIR = path.join(HUB, "public", "drawing", "people");
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(DEF_DIR, "characters.json"), "utf8")).people
  .map(({ slug, word, scale }) => ({ slug, word, scale }));
const DEFAULT_SLUGS = ["mom", "dad", "girl", "boy", "grandma", "grandpa", "baby", "friend"];

test("the characters library: dad's order, only with a PNG, junk skipped; absent or broken → the default library", () => {
  freshUnit("none");
  assert.deepEqual(drawings.characters(), DEFAULTS, "no folder: the eight built-in people");
  library([{ slug: "sam", word: "Sam" }, { slug: "maya", word: " Maya ", scale: 0.25 }, { slug: "nopic", word: "No pic" },
    { slug: "Bad Slug", word: "x" }, { slug: "maya", word: "Again" }, { slug: "tall", word: "Tall", scale: 0.9 },
    { slug: "noword" }, 7, { slug: "long", word: "x".repeat(25) }], ["sam", "maya", "tall", "noword", "long"]);
  assert.deepEqual(drawings.characters(), [{ slug: "sam", word: "Sam", scale: 0.3 }, { slug: "maya", word: "Maya", scale: 0.25 },
    { slug: "tall", word: "Tall", scale: 0.3 }]);
  fs.writeFileSync(path.join(CH(), "characters.json"), "{ not json");
  assert.deepEqual(drawings.characters(), DEFAULTS);
  fs.writeFileSync(path.join(CH(), "characters.json"), JSON.stringify({ v: 1, people: "nope" }));
  assert.deepEqual(drawings.characters(), DEFAULTS);
});

test("the default People library: eight generic people, shown until the family has one of its own — never merged (dad 10/7)", () => {
  freshUnit("none");
  assert.deepEqual(DEFAULTS.map((p) => p.slug), DEFAULT_SLUGS, "mom, dad, girl, boy, grandma, grandpa, baby, friend — in that order");
  for (const p of DEFAULTS) {
    assert.ok(p.word && p.word.length <= 24 && p.scale >= 0.1 && p.scale <= 0.6, JSON.stringify(p));
    const b = fs.readFileSync(path.join(DEF_DIR, p.slug + ".png"));
    assert.equal(b.readUInt32BE(0), 0x89504e47, p.slug + ".png is a PNG");
  }
  assert.deepEqual(drawings.characters(), DEFAULTS, "every one shows: each has its PNG");
  assert.deepEqual(drawings.charactersLibrary(), { source: "default", dir: DEF_DIR, people: DEFAULTS });
  library([{ slug: "maya", word: "Maya" }]);
  assert.deepEqual(drawings.characters(), [{ slug: "maya", word: "Maya", scale: 0.3 }], "the family's own library hides every default");
  assert.deepEqual(drawings.charactersLibrary(), { source: "family", dir: CH(), people: drawings.characters() });
  library([{ slug: "kai", word: "Kai" }], []);
  assert.deepEqual(drawings.characters(), DEFAULTS, "a family library with nothing that shows (no PNG yet) keeps the defaults");
  library([]);
  assert.deepEqual(drawings.characters(), DEFAULTS, "an empty family library keeps the defaults");
  // the default assets missing (a broken install): no people at all — the page's "No people yet"
  const empty = path.join(TMP, "no-default-people");
  fs.mkdirSync(empty, { recursive: true });
  fs.rmSync(CH(), { recursive: true, force: true });
  drawings.start(UNIT, { deviceId: "kitchen-pc-3f9a", now: () => clock, defaultPeopleDir: empty });
  assert.deepEqual(drawings.characters(), []);
  freshUnit("none");
  assert.deepEqual(drawings.characters(), DEFAULTS, "start() without the seam is the shipped library again");
});

// review 10/3 #5: a library check made pictures unsaveable (a person removed while the page was open,
// a browser-only copy naming a person this hub never had) and protected nothing — the renderer skips
// unknown people and the slug's shape confines any path. A person is checked by shape only.
test("a person the library lacks — left it, or never reached this device — never stops a picture saving; a bad slug does (review 10/3 #5)", () => {
  freshUnit("none");
  library([{ slug: "maya", word: "Maya" }, { slug: "sam", word: "Sam" }]);
  const { id } = drawings.create();
  assert.equal(drawings.writeScene(id, { v: 1, items: [P("maya"), P("sam")] }).ok, true);
  fs.rmSync(path.join(CH(), "sam.png"));
  library([{ slug: "maya", word: "Maya" }], ["maya"]);
  assert.equal(drawings.writeScene(id, { v: 1, items: [P("maya"), P("sam"), H] }).ok, true, "sam left the library");
  assert.equal(drawings.writeScene(id, { v: 1, items: [P("maya"), P("sam"), P("kai")] }).ok, true, "kai never reached this device");
  assert.deepEqual(drawings.readScene(id).items.map((i) => i.s), ["person:maya", "person:sam", "person:kai"], "kept");
  const fresh = drawings.create().id;
  assert.equal(drawings.writeScene(fresh, { v: 1, items: [P("kai")] }).ok, true, "even on a picture that never held them");
  assert.equal(drawings.writeScene(fresh, { v: 1, items: [{ ...P("kai"), s: "person:../kai" }] }).error, "bad-scene", "the shape still holds");
});

test("the shelf keeps a picture's place and crayon, thins strokes to 60 points, and never hides another device's people", () => {
  freshUnit("none");
  const { id } = drawings.create();
  const pts = Array.from({ length: 400 }, (_, k) => [0.1, +(0.1 + k / 1000).toFixed(3)]);
  drawings.writeScene(id, { v: 1, backdrop: "night", crayon: "#f7f7f7", items: [{ s: "stroke", c: "#f7f7f7", w: 0.014, pts, by: "ellie" }] });
  const row = drawings.list().find((p) => p.id === id);
  assert.deepEqual([row.items, row.scene.backdrop, row.scene.crayon], [1, "night", "#f7f7f7"]);
  const th = row.scene.items[0].pts;
  assert.equal(th.length, 60);
  assert.deepEqual([th[0], th.at(-1)], [pts[0], pts[399]]);
  assert.equal(drawings.readScene(id).items[0].pts.length, 400, "the picture itself stays whole");
  const other = "2026-10-02-100000-other-dev";
  fs.mkdirSync(onShelf(other), { recursive: true });
  fs.writeFileSync(path.join(onShelf(other), "scene.json"), JSON.stringify({ v: 1, id: other, items: [P("gone")] }));
  assert.ok(drawings.list().some((p) => p.id === other), "a person this device lacks never hides the picture");
});

// ---- §5 the routes: the REAL server.js on a scratch port ------------------------
// 8477 (hub) + 8479 (fake Resend, used by T5): swept free 9/30 across all five repos' tests/ and
// every open worktree, and not listening (ss -ltn). The hub's Drive folder is a temp dir.
const PORT = Number(process.env.ERA_TEST_DRAWINGS_PORT) || 8477;
const FAKE = 8479;
const BASE = `http://127.0.0.1:${PORT}`;
const RT = path.join(TMP, "routes");
const RT_MOUNT = path.join(TMP, "Route Drive", "New ERA Content");
const SEAMS = {
  ERA_AI_URL: "http://127.0.0.1:1", ERA_ELEVEN_URL: "http://127.0.0.1:1", ERA_FAL_URL: "http://127.0.0.1:1",
  ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1",
  ERA_GEOCODE_URL: "http://127.0.0.1:1/geocode", ERA_TMDB_URL: "http://127.0.0.1:1",
  ERA_STREAMING_URL: "http://127.0.0.1:1",
};
const got = [];            // every email the fake provider accepted
let fakeMode = "ok";       // ok | down
let child, fake;

before(async () => {
  fake = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (fakeMode === "down") { res.writeHead(500).end("boom"); return; }
      got.push(JSON.parse(b));
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"id":"x"}');
    });
  });
  await new Promise((r) => fake.listen(FAKE, "127.0.0.1", r));
  fs.mkdirSync(RT, { recursive: true });
  fs.mkdirSync(RT_MOUNT, { recursive: true });
  fs.writeFileSync(path.join(RT, "profile.json"), JSON.stringify({ childName: "Maya" }));
  fs.writeFileSync(path.join(RT, "drive.json"), JSON.stringify({ mode: "local", folderPath: RT_MOUNT }));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: RT, ERA_BIND: "127.0.0.1", ERA_DEVICE_ID: "test-dev", ERA_NO_UPDATE: "1",
           ...SEAMS, ERA_RESEND_URL: `http://127.0.0.1:${FAKE}/emails` },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server never came up");
});
after(() => {
  if (child) child.kill("SIGKILL");
  if (fake) fake.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const call = (method, url, body, headers = {}) => fetch(BASE + url, { method,
  headers: { "Content-Type": "application/json", ...headers },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const sceneOf = (items) => ({ v: 1, backdrop: "meadow", items });
const newPic = async () => (await (await call("POST", "/drawings", {})).json()).id;

test("POST /drawings allocates a picture in the family's Drive folder; a blank one is not on the shelf", async () => {
  const r = await call("POST", "/drawings", {});
  assert.equal(r.status, 200);
  const { id } = await r.json();
  assert.match(id, /^\d{4}-\d{2}-\d{2}-\d{6}-test-dev(-\d+)?$/);
  assert.ok(fs.existsSync(path.join(RT_MOUNT, "drawings", id, "scene.json")), "canonical = the Drive folder");
  assert.deepEqual(await (await fetch(BASE + "/drawings/index.json")).json(), []);
  const sc = await (await fetch(`${BASE}/drawings/${id}/scene.json`)).json();
  assert.deepEqual(sc.items, []);
  assert.equal(sc.device, "test-dev");
});

test("PUT scene.json validates and saves, and the shelf lists the picture with its scene inline", async () => {
  const id = await newPic();
  let r = await call("PUT", `/drawings/${id}/scene.json`, sceneOf([H]));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.match(j.updated, /^\d{4}-\d{2}-\d{2}T/);
  const row = (await (await fetch(BASE + "/drawings/index.json")).json()).find((p) => p.id === id);
  assert.equal(row.items, 1);
  assert.deepEqual(row.scene.items, [H]);
  r = await call("PUT", `/drawings/${id}/scene.json`, sceneOf([{ ...H, s: "dragon" }]));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "bad-scene");
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, "{not json")).status, 400);
  assert.equal((await call("PUT", "/drawings/not-an-id/scene.json", sceneOf([H]))).status, 404);
  const big = JSON.stringify(sceneOf([H])) + " ".repeat(257 * 1024);
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, big)).status, 413);
});

test("the doors: a page on another site, or a body that is not JSON, cannot create or overwrite a picture", async () => {
  const id = await newPic();
  assert.equal((await call("POST", "/drawings", {}, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await fetch(BASE + "/drawings", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 403);
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, sceneOf([H]), { "Sec-Fetch-Site": "cross-site" })).status, 403);
});

test("PUT takes a scene up to 256 KB and refuses a bigger body with 413", async () => {
  const id = await newPic();
  const pts = Array.from({ length: 400 }, (_, k) => [0.123, +(0.1 + k / 1000).toFixed(3)]);
  const S = { s: "stroke", c: "#0F7C8A", w: 0.014, pts, by: "ellie" };
  const ok = JSON.stringify({ v: 1, items: Array(44).fill(S) });
  assert.ok(ok.length > 64 * 1024 && ok.length < 256 * 1024, String(ok.length));
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, ok)).status, 200);
  const big = JSON.stringify({ v: 1, items: Array(50).fill(S) });
  assert.ok(big.length > 256 * 1024, String(big.length));
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, big)).status, 413);
});

test("GET /characters/index.json lists the library (the default one with none), PNGs are path-jailed, and a PUT checks people by shape only", async () => {
  const CHR = path.join(RT, "characters");
  fs.rmSync(CHR, { recursive: true, force: true });
  let r = await fetch(BASE + "/characters/index.json");
  assert.deepEqual([r.status, r.headers.get("x-characters-source"), await r.json()], [200, "default", DEFAULTS],
    "no family library: the eight built-in people, the same shape of list");
  r = await fetch(BASE + "/characters/mom.png");
  assert.deepEqual([r.status, r.headers.get("content-type")], [200, "image/png"]);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(fs.readFileSync(path.join(DEF_DIR, "mom.png"))), "served from public/drawing/people/");
  assert.equal((await fetch(BASE + "/characters/characters.json")).status, 200);
  for (const bad of ["/characters/Mom.png", "/characters/mom.txt", "/characters/people/mom.png", "/characters/..%2Fstickers.json",
                     "/characters/..%2F..%2F..%2Fdrawings.js", "/characters/%2e%2e/stickers.json", "/characters/stickers.json"])
    assert.notEqual((await fetch(BASE + bad)).status, 200, "jailed in the default library too: " + bad);
  fs.mkdirSync(CHR, { recursive: true });
  fs.writeFileSync(path.join(CHR, "maya.png"), tinyPng(16, 32));
  fs.writeFileSync(path.join(CHR, "characters.json"), JSON.stringify({ v: 1, people: [{ slug: "maya", word: "Maya" }] }));
  r = await fetch(BASE + "/characters/index.json");
  assert.deepEqual([r.headers.get("x-characters-source"), await r.json()], ["family", [{ slug: "maya", word: "Maya", scale: 0.3 }]],
    "the family's own library hides the defaults");
  assert.equal((await fetch(BASE + "/characters/mom.png")).status, 404, "never merged: a default is not served beside a family library");
  r = await fetch(BASE + "/characters/maya.png");
  assert.deepEqual([r.status, r.headers.get("content-type"), r.headers.get("cache-control")], [200, "image/png", "no-cache"]);
  assert.equal((await fetch(BASE + "/characters/characters.json")).status, 200);
  for (const bad of ["/characters/Maya.png", "/characters/maya.txt", "/characters/sub/maya.png", "/characters/..%2Fdrive.json"])
    assert.notEqual((await fetch(BASE + bad)).status, 200, bad);
  const id = await newPic();
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, { v: 1, items: [P("maya")] })).status, 200);
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, { v: 1, items: [P("maya"), P("kai")] })).status, 200,
    "a person the library lacks still saves (review 10/3 #5)");
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, { v: 1, items: [{ ...P("kai"), s: "person:Kai!" }] })).status, 400);
});

test("GET is path-jailed: an id's scene.json and picture.png, nothing beside or above them", async () => {
  const id = await newPic();
  assert.equal((await fetch(`${BASE}/drawings/${id}/scene.json`)).status, 200);
  assert.equal((await fetch(`${BASE}/drawings/${id}/picture.png`)).status, 404, "no Done yet");
  for (const bad of [`/drawings/${id}/.local`, `/drawings/${id}/scene.json.part`, "/drawings/notes/scene.json",
                     "/drawings/..%2fdrive.json/scene.json", "/drawings/%2e%2e/scene.json"])
    assert.ok([403, 404].includes((await fetch(BASE + bad)).status), bad);
});

// ---- §5 Done: save the PNG, mail it only when it changed --------------------------

const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const finish = (id, body = PNG_1x1, headers = {}) => fetch(`${BASE}/drawings/${id}/done`,
  { method: "POST", headers: { "Content-Type": "image/png", ...headers }, body });
async function pictureWith(items) {
  const id = await newPic();
  if (items) assert.equal((await call("PUT", `/drawings/${id}/scene.json`, sceneOf(items))).status, 200);
  return id;
}

// review 9/30 #1: the write to the Drive folder landed; copying it onto this shelf threw (ENOTDIR,
// EACCES, EIO). That is one console line, never an exception out of the route: the hub has no
// uncaughtException handler, so a throw there was the whole hub going down.
test("a save whose copy onto this shelf throws still answers 200, and the hub stays up", async () => {
  const id = await newPic();
  const shelf = path.join(RT, "drawings"), aside = shelf + ".aside";
  fs.renameSync(shelf, aside);
  fs.writeFileSync(shelf, "a file where the shelf folder should be");      // every copy onto this shelf: ENOTDIR
  try {
    const r = await call("PUT", `/drawings/${id}/scene.json`, sceneOf([H]));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(RT_MOUNT, "drawings", id, "scene.json"), "utf8")).items, [H],
      "the family's folder has it");
    assert.equal((await call("POST", "/drawings", {})).status, 200, "a new picture too");
    assert.equal((await fetch(BASE + "/drawings/index.json")).status, 200, "and the hub is still answering");
  } finally { fs.rmSync(shelf, { force: true }); fs.renameSync(aside, shelf); }
  assert.equal((await fetch(`${BASE}/drawings/${id}/scene.json`)).status, 200);
});

// review 10/2: a file the Drive mirror prunes between the hub's stat and its open made the read stream
// throw with no listener and took the whole hub down. A file that stats but cannot be opened (mode 000)
// is the same race made deterministic: the hub answers an error status and keeps serving.
test("a picture that vanishes between stat and open is answered with an error, and the hub stays up", async () => {
  const CHR = path.join(RT, "characters");
  fs.mkdirSync(CHR, { recursive: true });
  const f = path.join(CHR, "vanish.png");
  fs.writeFileSync(f, tinyPng(16, 32));
  fs.chmodSync(f, 0o000);
  try {
    const r = await fetch(BASE + "/characters/vanish.png");
    assert.ok([404, 500].includes(r.status), "an error status, not a 200 with no body: " + r.status);
    await r.arrayBuffer();
  } finally { fs.chmodSync(f, 0o644); fs.rmSync(f, { force: true }); }
  assert.equal((await fetch(BASE + "/drawings/index.json")).status, 200, "the hub is still answering");
  fs.writeFileSync(f, tinyPng(16, 32));
  const g = await fetch(BASE + "/characters/vanish.png");
  assert.equal(g.status, 200, "and a readable file serves again");
  assert.equal(Buffer.from(await g.arrayBuffer()).readUInt32BE(0), 0x89504e47);
  fs.rmSync(f, { force: true });
});

// review 9/30 #7: a Drive folder this device may not write (a view-only share; Windows refusing a
// rename over a file Drive holds open) must not make New picture silently do nothing. The write
// falls back to this device (.local, carried up later), and the hub reads that newer copy first.
test("a Drive folder that refuses the write: the picture is kept on this device, marked .local, and Done reads it", async () => {
  const drv = path.join(RT_MOUNT, "drawings");
  fs.mkdirSync(drv, { recursive: true });
  fs.chmodSync(drv, 0o555);
  let id;
  try {
    const r = await call("POST", "/drawings", {});
    assert.equal(r.status, 200, "New picture still opens");
    id = (await r.json()).id;
    assert.ok(fs.existsSync(path.join(RT, "drawings", id, "scene.json")), "kept on this device");
    assert.ok(fs.existsSync(path.join(RT, "drawings", id, ".local")), "marked as this device's own, to go up later");
    assert.equal((await call("PUT", `/drawings/${id}/scene.json`, sceneOf([H]))).status, 200);
  } finally { fs.chmodSync(drv, 0o755); }
  // the picture is in the family's folder, then its own folder there refuses a rewrite
  const pic = await pictureWith(null);
  fs.chmodSync(path.join(drv, pic), 0o555);
  try {
    assert.equal((await call("PUT", `/drawings/${pic}/scene.json`, sceneOf([H]))).status, 200);
    assert.ok(fs.existsSync(path.join(RT, "drawings", pic, ".local")));
    assert.deepEqual(await (await finish(pic)).json(), { saved: true, mail: "no-email" },
      "Done judges the copy she just made, not the stale blank in the Drive folder");
  } finally { fs.chmodSync(path.join(drv, pic), 0o755); }
});

// review 9/30 #11a: every Done rewrites picture.png, so it is never served as immutable.
test("picture.png is revalidated, never cached as immutable (Done rewrites it)", async () => {
  const id = await pictureWith([H]);
  assert.equal((await finish(id)).status, 200);
  const g = await fetch(`${BASE}/drawings/${id}/picture.png`);
  assert.equal(g.status, 200);
  assert.doesNotMatch(g.headers.get("cache-control") || "", /immutable|max-age=[1-9]/);
  assert.match(g.headers.get("cache-control") || "", /no-cache/);
});

test("Done saves the PNG where the scene lives and says no-email while no family email is set up", async () => {
  const id = await pictureWith([H]);
  const r = await finish(id);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { saved: true, mail: "no-email" });
  assert.ok(fs.readFileSync(path.join(RT_MOUNT, "drawings", id, "picture.png")).equals(PNG_1x1), "in the family's Drive folder");
  assert.ok(fs.existsSync(path.join(RT, "drawings", id, "picture.png")), "and on this device's shelf");
  const g = await fetch(`${BASE}/drawings/${id}/picture.png`);
  assert.equal(g.status, 200);
  assert.match(g.headers.get("content-type") || "", /image\/png/);
  assert.equal(got.length, 0, "nothing was mailed");
});

test("Done refuses what is not a PNG, what is too big, a picture that does not exist, and another site", async () => {
  const id = await pictureWith([H]);
  let r = await finish(id, Buffer.from("GIF89a, not a png"));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "not-png");
  // readBinaryBody pauses (never resets) an over-cap body so this 413 is readable (server.js:1512-1545)
  r = await finish(id, Buffer.concat([PNG_1x1, Buffer.alloc(4 * 1024 * 1024)]));
  assert.equal(r.status, 413);
  assert.equal((await finish("2026-01-01-000000-nobody")).status, 404);
  assert.equal((await finish(id, PNG_1x1, { "Sec-Fetch-Site": "cross-site" })).status, 403);
});

test("a blank picture is saved and never mailed", async () => {
  const id = await pictureWith(null);
  assert.deepEqual(await (await finish(id)).json(), { saved: true, mail: "empty" });
  assert.ok(fs.existsSync(path.join(RT_MOUNT, "drawings", id, "picture.png")));
});

test("with a family email: sent with the PNG attached; unchanged on a second Done; sent again after a change", async () => {
  const cfg = await call("POST", "/mail-config", { email: "family@example.com", apiKey: "re_test_key" });
  assert.equal((await cfg.json()).ok, true, "the fake provider took the test email");
  const before = got.length;
  const id = await pictureWith([H]);
  assert.deepEqual(await (await finish(id)).json(), { saved: true, mail: "sent" });
  assert.equal(got.length, before + 1);
  const m = got[got.length - 1];
  assert.equal(m.subject, "🎨 Maya made a picture");
  assert.equal(m.from, "The Pencil <onboarding@resend.dev>");
  assert.deepEqual(m.to, ["family@example.com"]);
  assert.deepEqual(m.attachments, [{ filename: id + ".png", content: PNG_1x1.toString("base64") }]);
  assert.match(m.html, /Maya made a picture/);
  const stored = JSON.parse(fs.readFileSync(path.join(RT_MOUNT, "drawings", id, "scene.json"), "utf8"));
  assert.match(stored.mailedHash, /^[0-9a-f]{40}$/);
  assert.deepEqual(await (await finish(id)).json(), { saved: true, mail: "unchanged" });
  assert.equal(got.length, before + 1, "the same picture is not mailed twice");
  await call("PUT", `/drawings/${id}/scene.json`, sceneOf([H, { s: "star", x: 0.5, y: 0.17, w: 0.1, by: "ellie" }]));
  assert.deepEqual(await (await finish(id)).json(), { saved: true, mail: "sent" });
  assert.equal(got.length, before + 2);
});

test("a send that fails still saves, says failed with the reason, and the next Done tries again", async () => {
  const id = await pictureWith([H]);
  fakeMode = "down";
  try {
    const r = await (await finish(id)).json();
    assert.equal(r.saved, true);
    assert.equal(r.mail, "failed");
    assert.match(r.reason, /Resend answered 500/);
  } finally { fakeMode = "ok"; }
  assert.ok(fs.existsSync(path.join(RT_MOUNT, "drawings", id, "picture.png")));
  assert.deepEqual(await (await finish(id)).json(), { saved: true, mail: "sent" }, "a failed mail recorded no mailedHash");
});
