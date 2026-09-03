// reconcile.test.mjs — apps chosen at install time really install (dad's
// cold test 8/29: the ERAgaze checkbox wrote apps.json but nothing acted on
// it at first boot). A hub that boots with an app ENABLED in apps.json but
// missing on disk pulls its pack from the release feed by itself — once the
// wizard has been answered. Until then the installer's ticks are only the
// wizard's pre-fill (VM 9/3: a silent install ticks everything, the gaze
// engine compiled and started before the family unticked it, and the first
// door handed their kiosk to an engine they never chose).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8414;      // 8391-8413 held by sibling suites
const FEED_PORT = 8415;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-rec-"));
const INSTALL = path.join(TMP, "install");
const DATA = path.join(TMP, "data");
const READER = path.join(INSTALL, "public", "reader", "index.html");
let feed, child, log = "";

function boot() {
  log = "";
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: INSTALL, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1",
           ERA_UPDATE_URL: `http://127.0.0.1:${FEED_PORT}`, ERA_NO_UPDATE: "1" },
  });
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  return (async () => {
    for (let i = 0; i < 100; i++) {
      try { await fetch(`${BASE}/settings`); return; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("hub never came up");
  })();
}
const stop = () => new Promise((r) => { if (!child) return r(); child.once("exit", r); child.kill("SIGKILL"); });
const readerInstalled = async () =>
  (await (await fetch(`${BASE}/apps`, { cache: "no-store" })).json()).apps.find(a => a.id === "reader").installed;
async function waitReader(want, ms) {
  for (let i = 0; i < ms / 500; i++) {
    if (await readerInstalled() === want) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return await readerInstalled() === want;
}

before(async () => {
  // minimal install: hub js + home page, NO reader pack, NO profile (the
  // wizard is still to come); apps.json = the installer's ticks: reader + the engine
  fs.mkdirSync(path.join(INSTALL, "public", "home"), { recursive: true });
  for (const f of ["server.js", "update.js", "packs.js", "drive.js", "clothing.js", "clothing-worker.js", "clothing-photos.js", "pool.js", "predict.js", "predict-model.json"])
    fs.copyFileSync(path.join(HUB, f), path.join(INSTALL, f));
  fs.copyFileSync(path.join(HUB, "public", "home", "index.html"),
                  path.join(INSTALL, "public", "home", "index.html"));
  fs.writeFileSync(path.join(INSTALL, "VERSION"), "20200101.0000\n");
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "apps.json"), JSON.stringify({ enabled: ["reader", "eragaze"] }));

  // feed tarball carrying the reader pack
  const rel = path.join(TMP, "rel", "new-era-suite");
  fs.mkdirSync(path.join(rel, "public", "reader"), { recursive: true });
  fs.writeFileSync(path.join(rel, "public", "reader", "index.html"), "<p>reader</p>");
  execFileSync("tar", ["-czf", path.join(TMP, "suite.tar.gz"), "-C", path.join(TMP, "rel"), "new-era-suite"]);
  const tarball = fs.readFileSync(path.join(TMP, "suite.tar.gz"));
  feed = http.createServer((req, res) => {
    if (req.url === "/new-era-suite.tar.gz") { res.writeHead(200).end(tarball); return; }
    res.writeHead(404).end();
  });
  await new Promise(r => feed.listen(FEED_PORT, "127.0.0.1", r));
  await boot();
});
after(async () => { await stop(); if (feed) feed.close(); });

test("before the wizard is answered the installer's ticks install nothing — not the engine (VM 9/3)", async () => {
  await new Promise(r => setTimeout(r, 7500));          // boot reconcile would fire at +5 s
  assert.equal(await readerInstalled(), false, "reader pack not pulled yet");
  assert.ok(!fs.existsSync(READER));
  assert.match(log, /\[apps\] reconcile deferred/, log);
  assert.doesNotMatch(log, /reconcile eragaze|\[gaze\]/, "no engine install attempted — " + log);
});

test("the wizard's answer installs what it chose and turns off the engine it unticked", async () => {
  const r = await fetch(`${BASE}/setup`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ childName: "Maya", dwellMs: 1200, apps: ["reader"] }) });
  assert.equal(r.status, 204);
  assert.ok(await waitReader(true, 30000), "reader pack self-installed after the wizard");
  assert.ok(fs.existsSync(READER));
  assert.match(log, /\[gaze\] turned off/, "an engine already up is stopped — " + log);
  assert.doesNotMatch(log, /reconcile eragaze/, "the unticked engine is not installed — " + log);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA, "apps.json"), "utf8")).enabled, ["reader"]);
});

test("boot reconcile installs an enabled-but-missing pack by itself once a profile exists (8/29)", async () => {
  await stop();
  fs.rmSync(path.dirname(READER), { recursive: true, force: true });
  await boot();
  assert.ok(await waitReader(true, 30000), "reader pack self-installed after boot");
  assert.ok(fs.existsSync(READER));
  assert.doesNotMatch(log, /reconcile deferred/, log);
});

// Leg B 9/3: v0.31.3 compiled and started the engine uninvited (bug 38) and
// put it in Startup; after the self-update it was still running and the first
// door handed the kiosk to it. The boot reconcile now enforces the OFF side.
test("boot reconcile stops an engine that is compiled but not chosen (left by an older build)", async () => {
  await stop();
  fs.mkdirSync(path.join(INSTALL, "gaze"), { recursive: true });
  fs.writeFileSync(path.join(INSTALL, "gaze", "ERAgaze.exe"), "stand-in");   // "compiled"
  await boot();
  await new Promise(r => setTimeout(r, 7500));          // boot reconcile at +5 s
  assert.match(log, /\[gaze\] turned off/, "the unchosen engine is stopped at boot — " + log);
  assert.doesNotMatch(log, /reconcile eragaze/, log);
  fs.rmSync(path.join(INSTALL, "gaze"), { recursive: true, force: true });
});

test("Settings: turning the engine off stops it", async () => {
  const r = await fetch(`${BASE}/apps`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "eragaze", enabled: false }) });
  assert.equal(r.status, 204);
  assert.match(log, /\[gaze\] turned off/, log);
});
