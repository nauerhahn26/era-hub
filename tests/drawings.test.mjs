// drawings.test.mjs — the Drawing app's hub half (spec docs/superpowers/specs/2026-09-30-drawing-design.md):
// the vendored stickers (§6), the drawings.js module (§4) and its routes (§5). Synthetic fixtures only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRAW = path.join(HUB, "public", "drawing");
const TABLE = JSON.parse(fs.readFileSync(path.join(DRAW, "stickers.json"), "utf8"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-drawings-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

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
  assert.equal(drawings.validateScene({ v: 1, backdrop: "beach", items: [] }).ok, false, "one backdrop in v1");
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
  const mk = (root, id, items, created, raw) => {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, "scene.json"), raw || JSON.stringify({ v: 1, id, created, items }));
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
