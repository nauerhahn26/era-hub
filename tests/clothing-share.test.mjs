// clothing-share.test.mjs — the family's devices learn from each other with no
// server (spec §5, §1 row S1).
//
// Everything rides in `clothing/.era/` inside the folder Google Drive for
// Desktop already mirrors: this device appends its picks, offers and tags
// under its OWN id, and reads every other device's back. The rules that make
// that safe are the ones this suite exists to hold:
//
//   * the local canonical is written FIRST and the mount second; the hub never
//     writes under <DATA>/clothing/.era, which belongs to the mirror (A4-9);
//   * an own write never CREATES <folder>/clothing — an absent source folder
//     means "leave the wardrobe alone" and an empty one means "prune it" (W8);
//   * lines this device wrote, mirrored back, are skipped in favour of the
//     local file — a divergent copy must never win;
//   * a tag is paid for ONCE per family: by id, else by content hash;
//   * and with the same logs, the same day and the same band, two devices deal
//     the identical board without talking to each other.
//
// Ports 8458 (hub A) and 8459 (its fake AI) per plan §B. Every id, name and
// colour is invented; no key is ever spent — the only "AI" here is a local
// fake that counts what it is shown.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { materialize, idFor } from "./synthetic-wardrobe.mjs";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const { dayKey, yesterdayOf } = require("./clothing-rank.js");
const { resolveDeviceId } = require("./device-id.js");
const drive = require("./drive.js");
const clothing = require("./clothing.js");

const PORT = 8458, AI_PORT = 8459;             // plan §B
const BASE = `http://127.0.0.1:${PORT}`;
// One clock for the suite, and deliberately neither of the two wrong answers a
// worker can give: not this box's own zone and not the module's default (see
// tests/clothing.test.mjs for the full reasoning).
const ZONE = (() => {
  const now = Date.now();
  const box = dayKey(now, "UTC"), mod = dayKey(now, "America/Los_Angeles");
  const ends = ["Pacific/Kiritimati", "Etc/GMT+12"];
  return ends.find(z => dayKey(now, z) !== box && dayKey(now, z) !== mod)
      || ends.find(z => dayKey(now, z) !== box) || ends[0];
})();
const today = () => dayKey(Date.now(), ZONE);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-share-"));
const DRIVE = path.join(TMP, "drive");          // the family's Drive folder
const DATA_A = path.join(TMP, "A"), DATA_B = path.join(TMP, "B");
const DRIVE_C = path.join(TMP, "drive-c"), DATA_C = path.join(TMP, "C");
let ai, child, calls = 0, idA = "", idB = "";

const SEAMS = {
  ERA_ELEVEN_URL: "http://127.0.0.1:1", ERA_FAL_URL: "http://127.0.0.1:1",
  ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1",
  ERA_RESEND_URL: "http://127.0.0.1:1", ERA_TMDB_URL: "http://127.0.0.1:1",
  ERA_STREAMING_URL: "http://127.0.0.1:1", ERA_BIND: "127.0.0.1",
  // §B: any hub that could hold a key gets the SUITE's fake, never a provider.
  ERA_AI_URL: `http://127.0.0.1:${AI_PORT}`,
  ERA_AI_SPACING_MS: "50",
};

// ---- small helpers ---------------------------------------------------------
const era = (root, ...p) => path.join(root, "clothing", ".era", ...p);
const line = (o) => JSON.stringify(o) + "\n";
function put(root, rel, ...lines) {
  const f = era(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.map(line).join(""));
  return f;
}
function withKey(dir) {
  fs.writeFileSync(path.join(dir, "ai-config.json"),
    JSON.stringify({ provider: "anthropic", apiKey: "sk-not-a-real-key" }));
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
// Every outfit of every "today" board, board order then slot order — the
// 21-for-21 comparator. A lexicographic sort of `load` would put confirm_10
// before confirm_2 and compare two boards in the same wrong order.
function allCombos(dataDir) {
  const r = readJson(path.join(dataDir, "recipes", "today.json"));
  return r.boards.filter(b => /^today(_\d+)?$/.test(b.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap(b => b.buttons.filter(x => x.type === "outfit")
      .sort((x, y) => Number(x.load.split("_")[1]) - Number(y.load.split("_")[1]))
      .map(x => x.combo.join("+")));
}
const page1Of = (dataDir) => {
  const r = readJson(path.join(dataDir, "recipes", "today.json"));
  const b = r.boards.find(x => x.id === "today");
  return b.buttons.filter(x => x.type === "outfit").map(x => x.combo.join("+"));
};
// Deal for one device, in process: drive.js and clothing.js are module-global,
// so a device is "started" and then built, one at a time.
async function build(dataDir, deviceId) {
  drive.start(dataDir);
  clothing.start(dataDir, { noTimers: true, tz: () => ZONE, deviceId });
  return clothing.regenerate(true);
}
async function syncInto(dataDir) { drive.start(dataDir); return drive.sync(); }

before(async () => {
  for (const k of Object.keys(SEAMS)) process.env[k] = SEAMS[k];
  // A fake vision model that COUNTS. Nothing here is a provider: the answer is
  // fixed, and the number of requests is the assertion.
  ai = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      calls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({
        name: "Clover tee", category: "top", warmth: "warm", top_side: "top",
        crop: { x: 0, y: 0, w: 1, h: 1 },
        colors: ["blue"], pattern: "solid", statement: false, palette: "cool", vibe: "basic",
      }) }] }));
    });
  });
  await new Promise(r => ai.listen(AI_PORT, "127.0.0.1", r));

  fs.mkdirSync(path.join(DRIVE, "clothing"), { recursive: true });
  fs.mkdirSync(DATA_A, { recursive: true });
  fs.writeFileSync(path.join(DATA_A, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: DRIVE }));
  // Hub A boots with no wardrobe at all: these first cases are about the
  // device's NAME and about one Yes, and a wardrobe would only buy a build
  // this suite has to wait for.
  const env = { ...process.env, ...SEAMS, ERA_DATA_DIR: DATA_A };
  delete env.ERA_DEVICE_ID;   // the gate exports a private env; this hub must name ITSELF
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"], env,
  });
  for (let i = 0; i < 200; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("hub A never came up");
});
after(() => {
  if (child) child.kill("SIGKILL");
  if (ai) ai.close();
  for (const k of Object.keys(SEAMS)) delete process.env[k];
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---- the device's own name (spec §5 "Device id") ---------------------------

test("a hub names itself once, and the name is a directory-safe slug", () => {
  idA = fs.readFileSync(path.join(DATA_A, "device-id"), "utf8").trim();
  assert.match(idA, /^[a-z0-9-]{1,32}$/, "the id is a slug — it becomes a folder name");
  assert.notEqual(idA, "hub", "not the product's name: two devices would share every file");
});

// ---- one Yes: canonical first, mount second, mirror never (A4-9) ----------

test("a Yes is recorded locally AND shared, and never written into the mirror's own copy", async () => {
  const combo = ["item_aaaa1111", "item_bbbb2222"];
  const r = await fetch(`${BASE}/outfit-event`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "yes", combo }) });
  assert.equal(r.status, 204, "the board's contract is 204 with an empty body");
  assert.equal((await r.text()), "", "…an empty body");

  // 1. the local canonical
  const h = readJson(path.join(DATA_A, "wardrobe", "history.json"));
  const day = Object.keys(h.events)[0];
  assert.deepEqual(h.events[day][0].combo, combo, "the pick is in this device's own memory");

  // 2. the family's folder, under THIS device's id
  const shared = path.join(DRIVE, "clothing", ".era", "picks", idA, day + ".jsonl");
  const shown = fs.readFileSync(shared, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(shown.at(-1).combo, combo, "…and in the family's folder");
  assert.equal(shown.at(-1).kind, "yes");

  // 3. NOT under <DATA>/clothing/.era — that is the mirror's to write (A4-9)
  assert.ok(!fs.existsSync(era(DATA_A)), "the hub never writes into the mirror's destination");
});

test("the same device answers to the same name on its next boot", async () => {
  child.kill("SIGKILL");
  await new Promise(r => setTimeout(r, 500));
  const env = { ...process.env, ...SEAMS, ERA_DATA_DIR: DATA_A };
  delete env.ERA_DEVICE_ID;
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"], env,
  });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    try { await fetch(`${BASE}/settings`); up = true; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(up, "hub A came back");
  assert.equal(fs.readFileSync(path.join(DATA_A, "device-id"), "utf8").trim(), idA,
    "a new name every boot would look like a new device to every other one");
  child.kill("SIGKILL");                     // the rest of this suite runs in process
  await new Promise(r => setTimeout(r, 500));
  child = null;

  // From here on both devices hold the same synthetic wardrobe.
  materialize({ dataDir: DATA_A, n: 14, driveFolder: DRIVE });
  materialize({ dataDir: DATA_B, n: 14, driveFolder: DRIVE });
  fs.writeFileSync(path.join(DATA_B, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: DRIVE }));
  idB = resolveDeviceId(DATA_B, { env: {}, profile: {}, hostname: "Second-Tablet" });
  assert.notEqual(idB, idA, "two devices, two names");
});

// ---- the mirror carries the log, and takes nothing away --------------------

test("a sync carries the shared log onto the other device and prunes no photos", async () => {
  const photosBefore = fs.readdirSync(path.join(DATA_B, "clothing")).length;
  await syncInto(DATA_B);
  const day = Object.keys(readJson(path.join(DATA_A, "wardrobe", "history.json")).events)[0];
  assert.ok(fs.existsSync(era(DATA_B, "picks", idA, day + ".jsonl")),
    "device A's Yes reached device B");
  assert.equal(fs.readdirSync(path.join(DATA_B, "clothing")).filter(f => f.endsWith(".jpg")).length,
    photosBefore, "and the wardrobe it arrived beside is untouched");
});

// §5: "own device-id lines in the mirror are skipped in favour of the local
// file". A's own lines come back to A on the next sync; if the mirrored copy
// were read, a line that diverged (a half-synced file, an edit on another
// machine) would outvote A's own memory.
test("this device's own lines, mirrored back, are ignored in favour of its own memory", async () => {
  await syncInto(DATA_A);
  const day = Object.keys(readJson(path.join(DATA_A, "wardrobe", "history.json")).events)[0];
  const mine = era(DATA_A, "picks", idA, day + ".jsonl");
  assert.ok(fs.existsSync(mine), "A's own line came back through the mirror");
  fs.appendFileSync(mine, line({ t: new Date().toISOString(), kind: "yes", combo: ["item_ffff9999"] }));

  const { openLog } = require("./clothing-log.js");
  const log = openLog({ dataDir: DATA_A, driveFolder: DRIVE, deviceId: idA, tz: ZONE });
  const merged = log.readMerged(today());
  const seen = Object.values(merged.picksEvents).flat().map(e => e.combo.join("+"));
  assert.ok(!seen.includes("item_ffff9999"), "the divergent mirrored copy is not read");
  assert.ok(!seen.includes("item_aaaa1111+item_bbbb2222"), "…nor is A's own line double-counted");
});

test("a torn line in a mirrored file does not stop the other device dealing", async () => {
  const y = yesterdayOf(today());
  const f = put(DRIVE, `picks/dev-b/${y}.jsonl`,
    { t: y + "T09:00:00Z", kind: "yes", combo: ["item_aaaa1111"] });
  fs.appendFileSync(f, '{"t":"' + y + 'T10:00:00Z","ki');
  await syncInto(DATA_B);
  const r = await build(DATA_B, idB);
  assert.equal(r.mode, "cataloged", "the board was dealt");
  assert.ok(allCombos(DATA_B).length > 0);
  fs.rmSync(path.join(DRIVE, "clothing", ".era", "picks", "dev-b"), { recursive: true, force: true });
  fs.rmSync(era(DATA_B, "picks", "dev-b"), { recursive: true, force: true });
});

// spec §5 "same board everywhere": identical tags (both wardrobes were
// materialized from the same names), identical picks and offers (merged), the
// same date and the same band -> the same 21, with no coordination at all.
test("two devices with the same logs deal the identical board, look for look", async () => {
  await syncInto(DATA_A);
  await build(DATA_A, idA);
  await syncInto(DATA_B);
  await build(DATA_B, idB);
  const a = allCombos(DATA_A), b = allCombos(DATA_B);
  assert.equal(a.length, 21, "a full three pages");
  assert.deepEqual(a, b, "the same looks, in the same order, on both devices");

  // …and each of them told the family what it showed (spec §6 step 1), which
  // is what bars those looks from page 1 everywhere tomorrow.
  for (const [dataDir, id] of [[DATA_A, idA], [DATA_B, idB]]) {
    const f = path.join(DRIVE, "clothing", ".era", "offers", id, today() + ".jsonl");
    const last = fs.readFileSync(f, "utf8").trim().split("\n").map(JSON.parse).at(-1);
    assert.deepEqual(last.page1.map(c => c.join("+")), page1Of(dataDir),
      "the offers line is the page 1 that was actually dealt");
  }
});

// ---- what the worker READS: cases the "identical 21" above cannot catch ----
// A worker that ignored the mirror entirely would still pass the test above
// (both devices ignore it identically). These three are the proof that the
// merged log reaches the deal.

test("another device's Yes seats that look as today's staple", async () => {
  fs.mkdirSync(path.join(DRIVE_C, "clothing"), { recursive: true });
  materialize({ dataDir: DATA_C, n: 14, driveFolder: DRIVE_C });
  fs.writeFileSync(path.join(DATA_C, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: DRIVE_C }));
  const idC = resolveDeviceId(DATA_C, { env: {}, profile: {}, hostname: "Third-Tablet" });
  await syncInto(DATA_C);
  await build(DATA_C, idC);
  const base = allCombos(DATA_C);
  assert.equal(base.length, 21);
  const wanted = base[10];                     // a look from a deeper page
  assert.ok(!page1Of(DATA_C).includes(wanted), "…which page 1 did not hold");

  // dev-b said Yes to it on each of the last two days. Two credits is "loved",
  // and a picked look is what the staple slots are for.
  const y1 = yesterdayOf(today()), y2 = yesterdayOf(y1);
  for (const d of [y1, y2])
    put(DRIVE_C, `picks/dev-b/${d}.jsonl`, { t: d + "T18:00:00Z", kind: "yes", combo: wanted.split("+") });
  await syncInto(DATA_C);
  await build(DATA_C, idC);
  assert.equal(allCombos(DATA_C)[0], wanted,
    "the other tablet's favourite leads this one's board");
  fs.rmSync(path.join(DRIVE_C, "clothing", ".era", "picks"), { recursive: true, force: true });
  fs.rmSync(era(DATA_C, "picks"), { recursive: true, force: true });
});

test("another device's page 1 yesterday sits out page 1 here today, and opens page 2", async () => {
  const idC = fs.readFileSync(path.join(DATA_C, "device-id"), "utf8").trim();
  const base = allCombos(DATA_C);
  const demoted = base[9];
  const y = yesterdayOf(today());
  put(DRIVE_C, `offers/dev-b/${y}.jsonl`,
    { t: y + "T06:00:00Z", band: null, page1: [demoted.split("+")] });
  await syncInto(DATA_C);
  await build(DATA_C, idC);

  const now = allCombos(DATA_C);
  assert.equal(page1Of(DATA_C).length, 7, "a full page 1");
  assert.ok(!page1Of(DATA_C).includes(demoted), "a look another device showed yesterday waits a day");
  assert.equal(now[7], demoted, "…and it is the first thing on page 2 (dad's 8/5 ruling)");
  fs.rmSync(path.join(DRIVE_C, "clothing", ".era", "offers"), { recursive: true, force: true });
  fs.rmSync(era(DATA_C, "offers"), { recursive: true, force: true });
});

test("a pair the grown-ups marked 'never together' is offered on neither device", async () => {
  const idC = fs.readFileSync(path.join(DATA_C, "device-id"), "utf8").trim();
  await syncInto(DATA_C);
  await build(DATA_C, idC);
  const base = allCombos(DATA_C);
  const banned = base.find(c => c.includes("+"));
  assert.ok(banned, "there is a two-piece look to ban");

  put(DRIVE_C, "pairs/studio.jsonl",
    { t: today() + "T00:00:00Z", kind: "avoid", combo: banned.split("+").reverse() });
  await syncInto(DATA_C);
  await build(DATA_C, idC);
  assert.ok(!allCombos(DATA_C).includes(banned),
    "the avoid pair is gone from all three pages, whichever order it was written in");
  assert.ok(allCombos(DATA_C).length >= 20, "…and the board is still a board");
});

// ---- the family pays the AI once (spec §3.1 item 1, §5) -------------------

test("a garment another device already described costs no call here — matched by content, not by name", async () => {
  const rgb = [7, 111, 222];
  const jpeg = require("./vendor/jpeg-js");
  const body = (() => {
    const [w, h] = [320, 480];
    const data = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255; }
    return Buffer.from(jpeg.encode({ data, width: w, height: h }, 85).data);
  })();
  const hash = crypto.createHash("sha256").update(body).digest("hex");

  // A photo only device A has, and a key on A.
  fs.writeFileSync(path.join(DATA_A, "clothing", "a-new-top.jpg"), body);
  withKey(DATA_A);
  const beforeA = calls;
  await build(DATA_A, idA);
  assert.equal(calls - beforeA, 1, "one call for one new photo");
  const tagFile = path.join(DRIVE, "clothing", ".era", "tags", idA + ".jsonl");
  const tag = fs.readFileSync(tagFile, "utf8").trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(tag.hash, hash, "the tag line carries the photo's own sha256");
  assert.equal(tag.id, idFor("a-new-top.jpg"));
  assert.equal(tag.colors[0], "blue", "…and what the model said");

  // The SAME picture on device B under a different filename — a different id,
  // so only the content hash can find it. B has a key too and must not use it.
  fs.writeFileSync(path.join(DATA_B, "clothing", "b-other-name.jpg"), body);
  withKey(DATA_B);
  await syncInto(DATA_B);
  const beforeB = calls;
  await build(DATA_B, idB);
  assert.equal(calls - beforeB, 0, "the family had already paid for this garment");

  const catB = readJson(path.join(DATA_B, "wardrobe.json")).items["b-other-name.jpg"];
  assert.ok(catB && catB.ok, "B catalogued it all the same");
  assert.equal(catB.id, idFor("b-other-name.jpg"), "under its own id — the match was by hash");
  assert.deepEqual(catB.colors, ["blue"], "with the attributes the other device paid for");
  assert.ok(fs.statSync(path.join(DATA_B, "wardrobe-items", catB.id + ".jpg")).size > 0,
    "and the tile is drawn HERE — only the question was free");
  fs.rmSync(path.join(DATA_A, "ai-config.json"));
  fs.rmSync(path.join(DATA_B, "ai-config.json"));
});

// ---- the two ways there is nowhere to write (spec §5, W8) -----------------

test("a Drive folder with no clothing/ is left alone, and a sync prunes nothing", async () => {
  const D = path.join(TMP, "D"), FOLDER = path.join(TMP, "drive-empty");
  fs.mkdirSync(FOLDER, { recursive: true });
  materialize({ dataDir: D, n: 4 });                  // photos on this device only
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: FOLDER }));
  const idD = resolveDeviceId(D, { env: {}, profile: {}, hostname: "Fourth-Tablet" });

  const { openLog } = require("./clothing-log.js");
  const log = openLog({ dataDir: D, driveFolder: FOLDER, deviceId: idD, tz: ZONE });
  assert.equal(log.appendPick(today(), { kind: "yes", combo: ["item_aaaa1111"] }), false);
  assert.ok(!fs.existsSync(path.join(FOLDER, "clothing")),
    "an own write must never create clothing/ — an empty one is a prune order (W8)");

  const photos = fs.readdirSync(path.join(D, "clothing")).length;
  await syncInto(D);
  assert.equal(fs.readdirSync(path.join(D, "clothing")).length, photos,
    "and the local-only wardrobe survives the sync");
});

// Settings has TWO doors that set the local mount: "choose the folder"
// (/integrations/drive/localfolder) and the one-click "make the folder"
// (dad 8/29). The shared log is opened once at boot with the folder of the
// moment, so a door that sets a folder and does not re-open it leaves this
// hub writing nothing to the family until someone restarts it — silently, and
// only for her picks (the worker re-resolves the folder at every build, so
// offers and tags would keep flowing). Driven through the real route on a real
// hub, because the bug is the wiring and nothing below it can see it.
test("the one-click 'make the folder' button starts sharing straight away, with no restart", async () => {
  // 8458 is the suite's one hub port (§B) and hub A gave it up three cases
  // ago; a single-case run has not been through those, so make sure.
  if (child) { child.kill("SIGKILL"); child = null; await new Promise(r => setTimeout(r, 500)); }
  const D = path.join(TMP, "F");                      // a hub with no drive.json at all
  const ROOT = path.join(TMP, "mount");               // …and a mount root to make it in
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(D, { recursive: true });
  const env = { ...process.env, ...SEAMS, ERA_DATA_DIR: D, ERA_DRIVE_LOCAL_ROOTS: ROOT };
  delete env.ERA_DEVICE_ID;
  const hub = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"], env,
  });
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { await fetch(`${BASE}/settings`); up = true; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(up, "the folderless hub came up");

    const made = await (await fetch(`${BASE}/integrations/drive/create-folder`, { method: "POST" })).json();
    assert.equal(made.ok, true, "the button made the family's content folder");
    assert.equal(made.folderPath, path.join(ROOT, "New ERA Content"));

    const combo = ["item_cccc3333", "item_dddd4444"];
    const r = await fetch(`${BASE}/outfit-event`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "yes", combo }) });
    assert.equal(r.status, 204);

    const id = fs.readFileSync(path.join(D, "device-id"), "utf8").trim();
    const mine = path.join(made.folderPath, "clothing", ".era", "picks", id);
    const files = fs.existsSync(mine) ? fs.readdirSync(mine) : [];
    assert.equal(files.length, 1, "her Yes reached the folder the button just made");
    const last = fs.readFileSync(path.join(mine, files[0]), "utf8").trim().split("\n").map(JSON.parse).at(-1);
    assert.deepEqual(last.combo, combo);
  } finally {
    hub.kill("SIGKILL");
    await new Promise(r => setTimeout(r, 500));
  }
});

test("a device on Drive's API mode keeps its picks to itself, quietly", async () => {
  const D = path.join(TMP, "E");
  fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({
    mode: "api", folderId: "F0",
    token: { access_token: "fake-for-the-test", refresh_token: "fake-for-the-test" },
  }));
  const { openLog } = require("./clothing-log.js");
  const log = openLog({ dataDir: D, driveFolder: null, deviceId: "api-dev", tz: ZONE });
  assert.equal(log.appendPick(today(), { kind: "yes", combo: ["item_aaaa1111"] }), false);
  assert.equal(log.appendTag({ id: "item_aaaa1111", category: "top" }), false);
  assert.deepEqual(log.readMerged(today()).picksEvents, {}, "…and reads an empty family");
});
