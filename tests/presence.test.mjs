// presence.test.mjs — the presence beacon and its receiver (spec 2026-10-20
// §4.5). A device that wakes for a short window was missed by an operator who
// only polls, and the end-of-day mail then said it never came online. With
// `beaconUrl` set in app-settings.json a hub tells the operator's hub the
// minute it boots (and wakes, and every ERA_BEACON_MS while up); the receiver
// writes <DATA>/presence/<device>.json and runs ERA_PRESENCE_HOOK so the
// operator's queue can act within seconds. And "idle" once per idle stretch:
// no tap AND no change to any idleWatchFiles file for ERA_BEACON_IDLE_MS.
// Two checkout hubs on loopback.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopHubOnPort } from "./hub-port.mjs";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RX_PORT = 8486;   // the operator's hub (receiver)
const TX_PORT = 8487;   // a device's hub (sender)
const RX = `http://127.0.0.1:${RX_PORT}`;
const BEACON_MS = 600;
const IDLE_MS = 1200;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-presence-"));
const RX_DATA = path.join(TMP, "rx"), TX_DATA = path.join(TMP, "tx");
const HOOK = path.join(TMP, "hook.sh"), HOOK_LOG = path.join(TMP, "hook.log");
const WATCHED = path.join(TMP, "pageset.file");   // stands in for another app's working file
const SEAMS = {
  ERA_AI_URL: "http://127.0.0.1:1", ERA_ELEVEN_URL: "http://127.0.0.1:1",
  ERA_FAL_URL: "http://127.0.0.1:1", ERA_GEO_URL: "http://127.0.0.1:1/geo",
  ERA_WEATHER_URL: "http://127.0.0.1:1", ERA_GEOCODE_URL: "http://127.0.0.1:1/geocode",
  ERA_NWS_URL: "http://127.0.0.1:1", ERA_TMDB_URL: "http://127.0.0.1:1",
  ERA_STREAMING_URL: "http://127.0.0.1:1", ERA_RESEND_URL: "http://127.0.0.1:1",
  ERA_UPDATE_URL: "http://127.0.0.1:1", ERA_BIND: "127.0.0.1", ERA_CONSOLE: "1",
};
let rx, tx;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hookLines = () => { try { return fs.readFileSync(HOOK_LOG, "utf8").split("\n").filter(Boolean); } catch { return []; } };
const list = async () => (await (await fetch(`${RX}/presence`)).json()).devices;
const post = (body, raw) => fetch(`${RX}/presence`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: raw !== undefined ? raw : JSON.stringify(body) });
async function up(port) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/version`)).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error("hub on " + port + " never came up");
}

before(async () => {
  // a crashed earlier run's hubs may still hold the ports: stopped by pid once
  // their command line proves they are `server.js <port>` (tests/hub-port.mjs)
  for (const p of [RX_PORT, TX_PORT]) await stopHubOnPort(p);
  fs.mkdirSync(RX_DATA, { recursive: true });
  fs.mkdirSync(TX_DATA, { recursive: true });
  fs.writeFileSync(HOOK, `#!/bin/sh\necho "$1 $2" >> "${HOOK_LOG}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(TX_DATA, "app-settings.json"), JSON.stringify({ beaconUrl: `${RX}/presence`, idleWatchFiles: [WATCHED, path.join(TMP, "missing.file")] }));
  fs.writeFileSync(WATCHED, "x");

  rx = spawn("node", ["server.js", String(RX_PORT)], { cwd: HUB, stdio: "ignore",
    env: { ...process.env, ...SEAMS, ERA_DATA_DIR: RX_DATA, ERA_DEVICE_ID: "operator-test",
           ERA_PRESENCE_HOOK: HOOK, ERA_BEACON_MS: String(BEACON_MS) } });
  await up(RX_PORT);
  tx = spawn("node", ["server.js", String(TX_PORT)], { cwd: HUB, stdio: "ignore",
    env: { ...process.env, ...SEAMS, ERA_DATA_DIR: TX_DATA, ERA_DEVICE_ID: "device-test",
           ERA_BEACON_MS: String(BEACON_MS), ERA_BEACON_IDLE_MS: String(IDLE_MS) } });
  await up(TX_PORT);
});

after(() => {
  rx?.kill("SIGKILL"); tx?.kill("SIGKILL");
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("a hub with beaconUrl says boot within seconds of listening; the receiver files it", async () => {
  let rec;
  for (let i = 0; i < 50 && !rec; i++) {
    rec = (await list()).find(d => d.device === "device-test");
    if (!rec) await sleep(100);
  }
  assert.ok(rec, "the receiver has a record for the device");
  assert.equal(rec.build, "dev", "the sender's running build (a checkout)");
  assert.ok(["boot", "alive"].includes(rec.event));
  assert.ok(!Number.isNaN(Date.parse(rec.lastSeen)), "lastSeen is a timestamp");
  assert.ok(String(rec.from).includes("127.0.0.1") || rec.from === "::1", "from is the socket peer");
  assert.ok("idleMs" in rec);
  const file = JSON.parse(fs.readFileSync(path.join(RX_DATA, "presence", "device-test.json"), "utf8"));
  assert.equal(file.device, "device-test");
  await sleep(300);
  assert.ok(hookLines().includes("device-test boot"), "the hook ran with the device id and the event");
});

test("alive every ERA_BEACON_MS while up", async () => {
  await sleep(BEACON_MS * 4);
  const alive = hookLines().filter(l => l === "device-test alive").length;
  assert.ok(alive >= 2, "several alive beacons: " + alive);
  assert.equal((await list()).find(d => d.device === "device-test").event, "alive", "newest wins");
});

test("the hook runs exactly once per beacon, and a beacon is not her using the board", async () => {
  for (let i = 0; i < 3; i++)
    assert.equal((await post({ device: "manual-test", build: "x", event: "wake", idleMs: 5, at: new Date().toISOString() })).status, 204);
  await sleep(500);
  assert.equal(hookLines().filter(l => l === "manual-test wake").length, 3);
  const rec = (await list()).find(d => d.device === "manual-test");
  assert.equal(rec.event, "wake");
  assert.equal(rec.idleMs, 5);
  assert.equal((await (await fetch(`${RX}/version`)).json()).idleMs, null, "POST /presence does not stamp interaction");
});

test("a bad device id, event or body is 400 and writes nothing", async () => {
  const ok = { device: "x-test", build: "b", event: "boot", idleMs: null, at: new Date().toISOString() };
  for (const bad of [{ ...ok, device: "../etc" }, { ...ok, device: "" }, { ...ok, device: "a".repeat(65) },
                     { ...ok, device: "a b" }, { ...ok, event: "reboot" }, { ...ok, idleMs: "soon" }])
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  assert.equal((await post(null, "{not json")).status, 400, "bad JSON");
  assert.equal((await post(null, JSON.stringify({ ...ok, build: "x".repeat(5000) }))).status, 400, "over 4 KB");
  assert.ok(!(await list()).some(d => d.device === "x-test" || d.device === "a b"));
  assert.ok(!fs.existsSync(path.join(RX_DATA, "etc.json")) && !fs.existsSync(path.join(TMP, "etc.json")));
});

test("GET /presence lists every device; a hub with no beaconUrl sends nothing", async () => {
  const names = (await list()).map(d => d.device);
  assert.deepEqual(names, [...names].sort(), "sorted by device");
  assert.ok(names.includes("device-test") && names.includes("manual-test"));
  assert.ok(!names.includes("operator-test"), "the receiver (no beaconUrl) never beaconed");
});

const TX = `http://127.0.0.1:${TX_PORT}`;
const tapTx = () => fetch(`${TX}/log`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app: "presence-test", event: "tap" }) });
const idles = () => hookLines().filter(l => l === "device-test idle").length;

test("idle fires ONCE after the last tap, and not again until a new tap re-arms it", async () => {
  await tapTx();
  const n0 = idles();
  await sleep(IDLE_MS / 2);
  assert.equal(idles(), n0, "not idle yet");
  await sleep(IDLE_MS * 3);
  assert.equal(idles(), n0 + 1, "one idle beacon for the stretch");
  await sleep(IDLE_MS * 2);
  assert.equal(idles(), n0 + 1, "still one: edge-triggered, not repeated");
  await tapTx();
  await sleep(IDLE_MS * 3);
  assert.equal(idles(), n0 + 2, "a new tap re-armed it");
});

test("a change to a watched file postpones idle (she is in another app)", async () => {
  await tapTx();
  const n0 = idles();
  const until = Date.now() + IDLE_MS * 3;
  while (Date.now() < until) { fs.writeFileSync(WATCHED, String(Date.now())); await sleep(200); }
  assert.equal(idles(), n0, "no idle while the watched file keeps changing");
  await sleep(IDLE_MS * 3);
  assert.equal(idles(), n0 + 1, "idle once the file has rested too");
  const rec = (await list()).find(d => d.device === "device-test");
  assert.equal(typeof rec.idleMs, "number");
});

// The operator sets beaconUrl on a RUNNING hub that may not reboot for days:
// it must start beaconing without a restart. The receiver itself started with
// none (the case above proves it sent nothing); now it is pointed at itself.
test("beaconUrl set through POST /settings takes effect live, no restart; GET shows it with deviceId; bad values are 400", async () => {
  const pid0 = (await (await fetch(`${RX}/version`)).json()).pid;
  const r = await fetch(`${RX}/settings`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ beaconUrl: `${RX}/presence`, idleWatchFiles: [WATCHED] }) });
  assert.equal(r.status, 204);
  const saved = JSON.parse(fs.readFileSync(path.join(RX_DATA, "app-settings.json"), "utf8"));
  assert.equal(saved.beaconUrl, `${RX}/presence`, "stored");
  assert.deepEqual(saved.idleWatchFiles, [WATCHED], "stored");
  let rec;
  for (let i = 0; i < 40 && !rec; i++) {
    await sleep(BEACON_MS / 2);
    rec = (await list()).find(d => d.device === "operator-test");
  }
  assert.ok(rec, "a beacon arrived within a few ticks");
  assert.ok(["boot", "alive", "idle"].includes(rec.event), rec.event);
  assert.equal((await (await fetch(`${RX}/version`)).json()).pid, pid0, "same process");
  // GET /settings shows both, and the device id the presence file is named by
  const g = await (await fetch(`${RX}/settings`)).json();
  assert.equal(g.beaconUrl, `${RX}/presence`);
  assert.deepEqual(g.idleWatchFiles, [WATCHED]);
  assert.equal(g.deviceId, "operator-test");
  // a bad URL or a relative path is 400 and leaves the stored values untouched
  for (const bad of [{ beaconUrl: "ftp://nowhere" }, { beaconUrl: 7 }, { idleWatchFiles: ["relative/path"] },
                     { idleWatchFiles: [7] }, { idleWatchFiles: "/not/an/array" },
                     { idleWatchFiles: Array.from({ length: 17 }, (_, i) => "/f" + i) }]) {
    const rb = await fetch(`${RX}/settings`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bad) });
    assert.equal(rb.status, 400, JSON.stringify(bad).slice(0, 60));
  }
  const kept = JSON.parse(fs.readFileSync(path.join(RX_DATA, "app-settings.json"), "utf8"));
  assert.equal(kept.beaconUrl, `${RX}/presence`);
  assert.deepEqual(kept.idleWatchFiles, [WATCHED]);
  // an empty string clears the beacon
  await fetch(`${RX}/settings`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ beaconUrl: "" }) });
  assert.ok(!JSON.parse(fs.readFileSync(path.join(RX_DATA, "app-settings.json"), "utf8")).beaconUrl, "cleared");
});
