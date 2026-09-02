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

const PORT = 8393; // never the live port
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
  const PORT2 = 8394;
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
