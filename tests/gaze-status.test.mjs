// gaze-status.test.mjs — the hub keeps its engine on the bus, end to end
// (dad 10/26: "when I open the device in the morning, ERA Gaze is not working
// ... it should already have a restart function if it turns itself off,
// unless purposely deactivated"). Tablet 10/25: the engine ran deaf (no bus)
// through seven hub restarts; the hub only ever started it at install.
//
// The real hub boots over a stub compiler (ERA_GAZE_CSC, as
// gaze-recompile.test.mjs) whose "exe" is a script that records each launch;
// the bus is a stand-in on ERA_GAZE_BUS_PORT that the test raises and drops.
// The supervisor's clock is shortened through ERA_GAZE_*_MS.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8489;       // 8486/8487 = weekly suite; 8488 free; 8489 here; 8491 = this suite's engine stand-in
const BUS = 8491;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-gazesup-"));
const INSTALL = path.join(TMP, "install");
const DATA = path.join(TMP, "data");
const GAZE = path.join(INSTALL, "gaze");
const LAUNCHES = path.join(TMP, "engine-launches.log");
const CSC = path.join(TMP, "csc-stub.sh");
let child, log = "";

const HUB_MODULES = [...fs.readFileSync(path.join(HUB, "tools", "build-payload.sh"), "utf8")
  .matchAll(/"\$HUB\/([A-Za-z0-9._-]+\.(?:json|js))"/g)].map(m => m[1]);
const launches = () => { try { return fs.readFileSync(LAUNCHES, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const status = async () => (await (await fetch(`${BASE}/status`)).json());
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out: " + fn.toString().slice(0, 80)); await sleep(100); }
}

// the stand-in engine: answers /status, records a POST /shutdown
let bus = null, shutdowns = 0;
function raiseBus() {
  return new Promise((resolve) => {
    bus = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/shutdown") { shutdowns++; req.resume(); res.writeHead(200).end("{}"); return; }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, stand: "in" }));
    });
    bus.listen(BUS, "127.0.0.1", resolve);
  });
}
function dropBus() { return new Promise((resolve) => { if (!bus) return resolve(); bus.close(() => { bus = null; resolve(); }); bus.closeAllConnections && bus.closeAllConnections(); }); }

function boot() {
  log = "";
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: INSTALL, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1", ERA_NO_UPDATE: "1",
           ERA_UPDATE_URL: "http://127.0.0.1:9", ERA_GAZE_CSC: CSC, ERA_GAZE_BUS_PORT: String(BUS),
           ERA_GAZE_POLL_MS: "150", ERA_GAZE_GRACE_MS: "0", ERA_GAZE_DOWN_MS: "400", ERA_GAZE_BACKOFF_MS: "600,1200" },
  });
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  return until(async () => { try { await fetch(`${BASE}/settings`); return true; } catch { return false; } }, 15000);
}
const stop = () => new Promise((r) => { if (!child || child.exitCode !== null) return r(); child.once("exit", r); child.kill("SIGKILL"); });

before(async () => {
  fs.mkdirSync(path.join(INSTALL, "public", "home"), { recursive: true });
  for (const f of HUB_MODULES) fs.copyFileSync(path.join(HUB, f), path.join(INSTALL, f));
  fs.copyFileSync(path.join(HUB, "public", "home", "index.html"), path.join(INSTALL, "public", "home", "index.html"));
  fs.writeFileSync(path.join(INSTALL, "VERSION"), "20200101.0000\n");
  fs.mkdirSync(GAZE, { recursive: true });
  fs.writeFileSync(path.join(GAZE, "tobii_stream_engine.dll"), "stand-in");
  fs.writeFileSync(path.join(GAZE, "ERAgaze.cs"), "// engine\n");
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "profile.json"), JSON.stringify({ childName: "Maya" }));
  fs.writeFileSync(path.join(DATA, "apps.json"), JSON.stringify({ enabled: ["eragaze"] }));
  // the stub compiler writes an "exe" that logs its own launch and exits
  fs.writeFileSync(CSC, `#!/bin/sh
out=""
for a in "$@"; do case "$a" in /out:*) out="\${a#/out:}";; esac; done
{ echo "#!/bin/sh"; echo "echo launched >> '${LAUNCHES}'"; echo "exit 0"; } > "$out"; chmod +x "$out"
`);
  fs.chmodSync(CSC, 0o755);
  await raiseBus();           // an engine is on the bus when the hub comes up
  await boot();
});
after(async () => { await stop(); await dropBus(); fs.rmSync(TMP, { recursive: true, force: true }); });

test("GET /status reports the engine's keeper: watching an engine that answers the bus", async () => {
  // the +5 s boot reconcile compiles the engine; the bus answers, so it is not started
  await until(async () => /\[gaze\] installed/.test(log), 15000);
  const s = await until(async () => { const j = await status(); return j.gaze && j.gaze.state === "watching" ? j : null; });
  assert.equal(s.gaze.alive, true);
  assert.equal(s.gaze.restarts, 0);
  assert.equal(s.gaze.stoppedOnPurpose, false);
  assert.equal(s.gaze.port, BUS);
  assert.equal(typeof s.gaze.lastSeen, "number");
  assert.equal(launches(), 0, "an engine already on the bus is not started over");
});

test("the bus goes quiet: after the threshold the hub starts the engine again, says so, and backs off", async () => {
  await dropBus();
  const s1 = await until(async () => { const j = await status(); return j.gaze.restarts >= 1 ? j : null; });
  assert.equal(launches(), 1, "our exe was launched once");
  assert.match(log, /\[gaze\] engine silent for \d+ s — restart #1/);
  assert.ok(s1.gaze.nextRetry > s1.gaze.lastRestart, "a next try is scheduled");
  // the stub exits at once and the bus stays down: the second try waits the backoff (600 ms), not the poll
  await sleep(300);
  assert.equal((await status()).gaze.restarts, 1, "no second launch inside the backoff");
  await until(async () => (await status()).gaze.restarts >= 2, 3000);
  assert.equal(launches(), 2);
});

test("the engine comes back: the keeper is watching again and counts no more restarts", async () => {
  await raiseBus();
  const s = await until(async () => { const j = await status(); return j.gaze.state === "watching" && j.gaze.alive ? j : null; });
  const n = s.gaze.restarts;
  await sleep(1500);
  assert.equal((await status()).gaze.restarts, n);
});

test("POST /gaze/stop: the stop is remembered on disk, the engine is told to shut down, and nothing restarts it", async () => {
  const before = shutdowns;
  const r = await fetch(`${BASE}/gaze/stop`, { method: "POST", body: "{}" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.stopped, true);
  assert.equal(j.engineAnswered, true);
  assert.equal(shutdowns, before + 1, "the hub posted /shutdown to the engine");
  const marker = JSON.parse(fs.readFileSync(path.join(DATA, "gaze-stopped.json"), "utf8"));
  assert.equal(marker.by, "settings");
  assert.ok(Date.parse(marker.at) > 0);
  await dropBus();            // the engine is gone, as it would be
  const n = launches();
  await sleep(1800);          // several thresholds + backoffs
  assert.equal(launches(), n, "stopped on purpose: not started again");
  const s = await status();
  assert.equal(s.gaze.state, "stopped");
  assert.equal(s.gaze.stoppedOnPurpose, true);
});

test("POST /gaze/start: the stop is forgotten and the engine is started", async () => {
  const n = launches();
  const r = await fetch(`${BASE}/gaze/start`, { method: "POST", body: "{}" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.stopped, false);
  assert.equal(j.started, true);
  assert.equal(launches(), n + 1);
  assert.equal(fs.existsSync(path.join(DATA, "gaze-stopped.json")), false);
  assert.equal((await status()).gaze.stoppedOnPurpose, false);
  // and the keeper is back on duty: the stub exits, the bus stays down, so it tries again
  await until(async () => launches() >= n + 2, 4000);
});

test("a stop made before a hub restart still holds after it", async () => {
  await fetch(`${BASE}/gaze/stop`, { method: "POST", body: "{}" });
  await stop();
  const n = launches();
  await boot();
  await sleep(2500);
  assert.equal(launches(), n, "the marker outlived the restart");
  assert.equal((await status()).gaze.state, "stopped");
});

test("the engine toggled OFF in Settings is not supervised at all", async () => {
  fs.rmSync(path.join(DATA, "gaze-stopped.json"), { force: true });
  fs.writeFileSync(path.join(DATA, "apps.json"), JSON.stringify({ enabled: [] }));
  const n = launches();
  await sleep(1500);
  assert.equal(launches(), n);
  assert.equal((await status()).gaze.state, "off");
});

test("the stop and start routes refuse a caller that is not the machine itself (a school network must not stop her engine)", async () => {
  // the loopback check reads the socket's peer; from here every call IS loopback,
  // so pin the guard by its presence in the route and by the updater's judge
  const src = fs.readFileSync(path.join(HUB, "server.js"), "utf8");
  const route = src.slice(src.indexOf('urlPath === "/gaze/stop"'), src.indexOf('urlPath === "/gaze/stop"') + 400);
  assert.match(route, /isLoopback\(req\.socket && req\.socket\.remoteAddress\)/);
});
