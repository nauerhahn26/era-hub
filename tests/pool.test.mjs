// pool.test.mjs — the family-pool contract (shared-data v1).
// Spawns the REAL server.js on a TEST port with a throwaway ERA_DATA_DIR and
// proves: double-write (legacy stores untouched-in-behavior + pool accrues),
// device tagging, heartbeat, cross-device merge, torn-line tolerance.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { initPool } = require(path.join(HUB, "pool.js"));

// never the live port. A SEAM for the same reason clothing.test.mjs's fake AI
// got one (plan §B): 8393-8395 are inside the range this repo's port rule tells
// a reviewer never to bind, so the suite's own evidence could not otherwise be
// reproduced by the person reviewing it. The default is unchanged (r3).
const PORT = Number(process.env.ERA_TEST_HUB_PORT) || 8393;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-pool-"));
const DAY = new Date().toISOString().slice(0, 10);          // pool files: UTC day
// history.json buckets by the family tz (server default America/Los_Angeles);
// distinct from DAY across the UTC-midnight window — the 8/20 gate flake.
const HDAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
let child;

before(async () => {
  // NO wardrobe/ up front: a fresh install has none, and the route must make
  // it — until 9/2 every pick on a new install 400'd and was dropped
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_DEVICE_ID: "test-dev" },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server never came up");
});
after(() => { if (child) child.kill("SIGKILL"); });

test("POST /log double-writes: legacy jsonl AND device-tagged pool event", async () => {
  const r = await fetch(`${BASE}/log`, { method: "POST", body: JSON.stringify({ app: "mw", ev: "pick" }) });
  assert.equal(r.status, 204);
  const legacy = fs.readFileSync(path.join(TMP, "logs", DAY + ".jsonl"), "utf8");
  assert.match(legacy, /"ev":"pick"/, "legacy log line present");
  const poolFile = path.join(TMP, "pool", "events", "test-dev", DAY + ".jsonl");
  const e = JSON.parse(fs.readFileSync(poolFile, "utf8").trim().split("\n").pop());
  assert.equal(e.kind, "app-log");
  assert.equal(e.device, "test-dev", "pool event carries the device id");
  assert.equal(e.entry.ev, "pick");
  assert.ok(e.t, "timestamped");
});

test("POST /outfit-event double-writes: history.json AND pool event", async () => {
  const r = await fetch(`${BASE}/outfit-event`, {
    method: "POST", body: JSON.stringify({ kind: "yes", combo: ["item_abcd"] }) });
  assert.equal(r.status, 204);
  const h = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe", "history.json"), "utf8"));
  assert.equal(h.events[HDAY].length, 1, "legacy history event kept (generator still reads it)");
  const poolFile = path.join(TMP, "pool", "events", "test-dev", DAY + ".jsonl");
  const evs = fs.readFileSync(poolFile, "utf8").trim().split("\n").map(JSON.parse);
  const y = evs.find(e => e.kind === "outfit-yes");
  assert.ok(y, "pool has the outfit-yes event");
  assert.deepEqual(y.combo, ["item_abcd"]);
});

// An unreadable history.json holds a parent's picks (or half of them). It is
// set aside under a .bad- name for a hand to look at, never overwritten with
// {} — and the pick that arrived still lands (plan T2.2).
test("a corrupt history.json is set aside, never overwritten", async () => {
  const hp = path.join(TMP, "wardrobe", "history.json");
  fs.writeFileSync(hp, "{ not json");
  const r = await fetch(`${BASE}/outfit-event`, {
    method: "POST", body: JSON.stringify({ kind: "select", combo: ["item_abcd", "item_ef01"] }) });
  assert.equal(r.status, 204);
  // the producer (clothing.js) adds a -N when a name is already taken, so the
  // pattern here follows it rather than only its first form (r3)
  const bad = fs.readdirSync(path.join(TMP, "wardrobe")).filter(f => /^history\.json\.bad-\d+(-\d+)?$/.test(f));
  assert.equal(bad.length, 1, "the unreadable file was renamed, not lost");
  assert.equal(fs.readFileSync(path.join(TMP, "wardrobe", bad[0]), "utf8"), "{ not json");
  const h = JSON.parse(fs.readFileSync(hp, "utf8"));
  assert.equal(h.events[HDAY].length, 1, "a fresh history starts with this pick");
  assert.deepEqual(h.events[HDAY][0].combo, ["item_abcd", "item_ef01"]);
  assert.ok(!fs.existsSync(path.join(TMP, "wardrobe", "history.tmp")), "writeAtomic left no tmp behind");
});

// ...and the other half of the same promise: a file whose BYTES never arrived
// (a backup or the virus scanner holding it, a mode change) is not "no memory
// yet". Answering {} there and writing it back replaces 60 days of page-1
// lineups and every Yes with one pick. The pick is dropped instead — one look
// against sixty days (review r1).
test("a history.json that will not open is left alone and the pick is refused", {
  skip: process.getuid && process.getuid() === 0 ? "root reads every file" : false,
}, async () => {
  const hp = path.join(TMP, "wardrobe", "history.json");
  const before = fs.readFileSync(hp, "utf8");
  const asideBefore = fs.readdirSync(path.join(TMP, "wardrobe")).filter(f => f.startsWith("history.json.bad-")).length;
  const poolFile = path.join(TMP, "pool", "events", "test-dev", DAY + ".jsonl");
  const poolBefore = fs.readFileSync(poolFile, "utf8").trim().split("\n").length;
  fs.chmodSync(hp, 0o000);
  try {
    const r = await fetch(`${BASE}/outfit-event`, {
      method: "POST", body: JSON.stringify({ kind: "yes", combo: ["item_beef"] }) });
    assert.equal(r.status, 400, "the pick is refused rather than answered from an empty memory");
  } finally { fs.chmodSync(hp, 0o644); }
  assert.equal(fs.readFileSync(hp, "utf8"), before, "the memory is byte-for-byte what it was");
  // ...and the OTHER store still gets the pick: the pool is a different file
  // with a different failure mode, and no reason to share history.json's bad
  // day (r3). One look is lost from the memory, not from everywhere.
  const poolEvents = fs.readFileSync(poolFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(poolEvents.length, poolBefore + 1, "the pool event was written even though the memory could not be");
  assert.deepEqual(poolEvents.pop().combo, ["item_beef"]);
  const aside = fs.readdirSync(path.join(TMP, "wardrobe")).filter(f => f.startsWith("history.json.bad-")).length;
  assert.equal(aside, asideBefore, "nothing is wrong with the bytes, so nothing is set aside either");
});

// The pick's day key comes from the shell's VALIDATED zone (clothing.zone()).
// A profile.json naming a zone this computer cannot resolve ("Pacific Time" is
// not an IANA name) made dayKey throw RangeError inside the route, so every Yes
// and every select was answered 400 — for ever, silently, and favourites could
// never be learned (review r2). Pinned here on a real hub, where the route
// contract lives, rather than by a grep over server.js (r3).
test("a profile zone this computer cannot resolve still records the pick, on the fallback day", async () => {
  const T3 = fs.mkdtempSync(path.join(os.tmpdir(), "era-pool-tz-"));
  fs.writeFileSync(path.join(T3, "profile.json"), JSON.stringify({ tz: "Pacific Time" }));
  const PORT3 = PORT + 2;
  const c3 = spawn("node", ["server.js", String(PORT3)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: T3, ERA_BIND: "127.0.0.1", ERA_DEVICE_ID: "tz-dev",
           ERA_GEO_URL: "http://127.0.0.1:1", ERA_WEATHER_URL: "http://127.0.0.1:1",
           ERA_AI_URL: "http://127.0.0.1:1" },
  });
  try {
    let up = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(`http://127.0.0.1:${PORT3}/settings`); up = true; break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(up, "the hub with the unresolvable zone came up");
    const r = await fetch(`http://127.0.0.1:${PORT3}/outfit-event`, {
      method: "POST", body: JSON.stringify({ kind: "yes", combo: ["item_abcd"] }) });
    assert.equal(r.status, 204, "her Yes is recorded, not refused because of the zone");
    const h = JSON.parse(fs.readFileSync(path.join(T3, "wardrobe", "history.json"), "utf8"));
    assert.deepEqual(Object.keys(h.events), [HDAY], "bucketed by the America/Los_Angeles fallback day");
    assert.deepEqual(h.events[HDAY][0].combo, ["item_abcd"]);
  } finally { c3.kill("SIGKILL"); }
});

test("heartbeat file exists and is fresh", () => {
  const hb = JSON.parse(fs.readFileSync(path.join(TMP, "pool", "devices", "test-dev.json"), "utf8"));
  assert.equal(hb.device, "test-dev");
  assert.ok(Date.now() - Date.parse(hb.lastSeen) < 60_000, "heartbeat < 1 min old");
});

test("merge reader: events from a second device interleave, sorted by time", () => {
  const other = path.join(TMP, "pool", "events", "other-dev");
  fs.mkdirSync(other, { recursive: true });
  fs.appendFileSync(path.join(other, DAY + ".jsonl"),
    JSON.stringify({ t: "2000-01-01T00:00:00Z", device: "other-dev", kind: "app-log", entry: { ev: "old" } }) + "\n");
  const pool = initPool(TMP, "reader-only");
  const merged = pool.readMerged({ day: DAY, kind: "app-log" });
  assert.ok(merged.length >= 2, "sees both devices");
  assert.equal(merged[0].device, "other-dev", "oldest first across devices");
  const devices = new Set(merged.map(e => e.device));
  assert.ok(devices.has("test-dev") && devices.has("other-dev"));
});

test("torn line (syncer mid-flight) is skipped, not fatal", () => {
  const other = path.join(TMP, "pool", "events", "other-dev");
  fs.appendFileSync(path.join(other, DAY + ".jsonl"), '{"t":"2000-01-02T00:00:00Z","device":"other-dev","ki');
  const pool = initPool(TMP, "reader-only");
  const merged = pool.readMerged({ day: DAY });
  assert.ok(merged.length >= 2, "reader survives a partial line");
});

test("one writer per file: appends land only under this device's dir", () => {
  const pool = initPool(TMP, "writer-x");
  pool.append("app-log", { entry: { ev: "x" } });
  const mine = fs.readFileSync(path.join(TMP, "pool", "events", "writer-x", DAY + ".jsonl"), "utf8");
  assert.match(mine, /"ev":"x"/);
  const other = fs.readFileSync(path.join(TMP, "pool", "events", "other-dev", DAY + ".jsonl"), "utf8");
  assert.ok(!other.includes('"ev":"x"'), "never writes into another device's file");
});

test("LAW: pool unavailable at boot — server still runs, apps still serve, legacy log intact", async () => {
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), "era-nopool-"));
  fs.mkdirSync(path.join(TMP2, "wardrobe"), { recursive: true });
  const PORT2 = PORT + 1;
  // unwritable parent → mkdir throws fast → pool must degrade, server must live.
  // (NOT a network/procfs path: those can HANG sync fs calls — pool dirs must be
  // local folders that a syncer mirrors, never mounts.)
  const RO = path.join(TMP2, "ro"); fs.mkdirSync(RO); fs.chmodSync(RO, 0o444);
  const c2 = spawn("node", ["server.js", String(PORT2)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP2, ERA_BIND: "127.0.0.1",
           ERA_POOL_DIR: path.join(RO, "pool") },
  });
  try {
    let up = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(`http://127.0.0.1:${PORT2}/settings`); up = true; break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(up, "server boots with an unavailable pool");
    const l = await fetch(`http://127.0.0.1:${PORT2}/log`, { method: "POST", body: JSON.stringify({ ev: "z" }) });
    assert.equal(l.status, 204, "logging route still works");
    assert.match(fs.readFileSync(path.join(TMP2, "logs", DAY + ".jsonl"), "utf8"), /"ev":"z"/, "legacy log still written");
    const app = await fetch(`http://127.0.0.1:${PORT2}/`);
    assert.equal(app.status, 200, "apps still serve");
  } finally { c2.kill("SIGKILL"); }
});
