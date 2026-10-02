// drawings.test.mjs — the Drawing app's hub half (spec docs/superpowers/specs/2026-09-30-drawing-design.md):
// the vendored stickers (§6), the drawings.js module (§4) and its routes (§5). Synthetic fixtures only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
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
  const big = JSON.stringify(sceneOf([H])) + " ".repeat(66 * 1024);
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, big)).status, 413);
});

test("the doors: a page on another site, or a body that is not JSON, cannot create or overwrite a picture", async () => {
  const id = await newPic();
  assert.equal((await call("POST", "/drawings", {}, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await fetch(BASE + "/drawings", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 403);
  assert.equal((await call("PUT", `/drawings/${id}/scene.json`, sceneOf([H]), { "Sec-Fetch-Site": "cross-site" })).status, 403);
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
