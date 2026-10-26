// update-boot.test.mjs — the updater's OWN timers never restart the hub under
// the welcome wizard (VM leg B, 9/3): the boot check fired 90 s after launch,
// which on a first run is exactly when the family presses Go; the hub went
// away under the POST and the wizard stuck with a grey button. The boot
// check waits for a profile; the moment the wizard is answered it runs and
// the new build takes over. (A manual POST /update/check is never gated —
// update.test.mjs covers that path.) Then the cadence (spec 2026-10-20 §4.1):
// a still newer build published to the feed lands by the periodic tick alone,
// with no POST — the 6-hour tick never met a 20-minute awake window. And the
// quiet gate (§4.4): while the board is in use a newer build only STAGES; it
// applies once the hub has heard nothing from her for ERA_UPDATE_QUIET_MS, and
// a build left staged applies at the next boot before the hub serves.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopHubOnPort } from "./hub-port.mjs";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8423;      // hub under test (8391-8422 held by sibling suites)
const FEED_PORT = 8424; // fake release server
const BASE = `http://127.0.0.1:${PORT}`;
const OLD_BUILD = "20200101.0000";
const NEW_BUILD = "20991231.2359";
const NEWER_BUILD = "20991231.2400";
const NEWEST_BUILD = "20991231.2401";
const STAGED_BUILD = "20991231.2402";
const BOOT_MS = 700;    // the 90 s boot delay, shrunk for the test
const EVERY_MS = 400;   // the 30-minute periodic tick, shrunk for the test
const QUIET_MS = 1500;  // the 90 s "nobody is using it" window, shrunk for the test

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-updboot-"));
const INSTALL = path.join(TMP, "install");
const DATADIR = path.join(TMP, "data");
const STAGED = path.join(INSTALL, ".update-staged");
let feed, child;
// What the fake feed serves right now; publish() switches it to another build.
let latest = "", tarball = Buffer.alloc(0);

// The hub's own modules, read from build-payload.sh's copy list instead of
// duplicated here. A hand-kept fourth copy of that list is a fourth way for a
// new module to go missing from an install, and this suite is the only thing
// that boots a real one (9/4: content.js grew two new requires and this list
// did not, so the installed hub died on its first line and only the gate said
// so — the very failure tools/build-payload.sh's own guard exists to prevent).
const HUB_MODULES = [...fs.readFileSync(path.join(HUB, "tools", "build-payload.sh"), "utf8")
  .matchAll(/"\$HUB\/([A-Za-z0-9._-]+\.(?:json|js))"/g)].map(m => m[1]);

function makeInstall(dir, build) {
  fs.mkdirSync(path.join(dir, "public", "home"), { recursive: true });
  for (const f of HUB_MODULES)
    fs.copyFileSync(path.join(HUB, f), path.join(dir, f));
  fs.copyFileSync(path.join(HUB, "public", "home", "index.html"), path.join(dir, "public", "home", "index.html"));
  for (const f of ["public/pencil/index.html", "vendor/jpeg-js/index.js"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), build + "\n");
  }
  fs.writeFileSync(path.join(dir, "VERSION"), build + "\n");
}
// Build a release tarball for `build` and make the fake feed advertise it.
function publish(build, ver) {
  const relDir = path.join(TMP, "rel-" + build);
  makeInstall(path.join(relDir, "new-era-suite"), build);
  const tgz = path.join(TMP, "suite-" + build + ".tar.gz");
  execFileSync("tar", ["-czf", tgz, "-C", relDir, "new-era-suite"]);
  tarball = fs.readFileSync(tgz);
  const sha = crypto.createHash("sha256").update(tarball).digest("hex");
  latest = JSON.stringify({ version: ver, build, sha256: sha });
}
const version = async () => { try { return await (await fetch(`${BASE}/version`)).json(); } catch { return null; } };

before(async () => {
  // a crashed earlier run's hub (or its self-restarted successor) may still
  // hold the port: stopped by pid once its command line proves it is
  // `server.js <port>`, and the port is free when this returns
  await stopHubOnPort(PORT);
  makeInstall(INSTALL, OLD_BUILD);
  // a fresh install: apps chosen at install time, NO profile yet (wizard pending)
  fs.mkdirSync(DATADIR, { recursive: true });
  fs.writeFileSync(path.join(DATADIR, "apps.json"), JSON.stringify({ enabled: ["making-words", "pencil"] }));

  publish(NEW_BUILD, "v99.0.0");
  feed = http.createServer((req, res) => {
    if (req.url === "/latest.json") { res.writeHead(200).end(latest); return; }
    if (req.url === "/new-era-suite.tar.gz") { res.writeHead(200).end(tarball); return; }
    res.writeHead(404).end();
  });
  await new Promise(r => feed.listen(FEED_PORT, "127.0.0.1", r));

  child = spawn("node", ["server.js", String(PORT)], {
    cwd: INSTALL, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: DATADIR, ERA_BIND: "127.0.0.1",
           ERA_UPDATE_URL: `http://127.0.0.1:${FEED_PORT}`, ERA_NO_UPDATE: "", ERA_UPDATE_BOOT_MS: String(BOOT_MS),
           ERA_UPDATE_EVERY_MS: String(EVERY_MS), ERA_UPDATE_QUIET_MS: String(QUIET_MS) },
  });
  for (let i = 0; i < 100; i++) {
    if (await version()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("hub never came up");
});

after(async () => {
  // the hub on the port is a self-restarted one by now — its pid comes from
  // the port's owner, never from spawn — and `child` is the first process
  await stopHubOnPort(PORT);
  if (child) child.kill("SIGKILL");
  if (feed) feed.close();
});

test("with the wizard unanswered, a newer release on the feed does NOT restart the hub", async () => {
  const pid0 = (await version()).pid;
  await new Promise(r => setTimeout(r, BOOT_MS * 5));   // several boot ticks
  const v = await version();
  assert.ok(v, "hub still answering");
  assert.equal(v.build, OLD_BUILD, "still the build the family launched");
  assert.equal(v.pid, pid0, "same process — no restart under the wizard");
  assert.equal(fs.readFileSync(path.join(INSTALL, "VERSION"), "utf8").trim(), OLD_BUILD, "nothing landed on disk either");
});

test("the moment the wizard is answered, the deferred boot check runs and the new build takes over", async () => {
  const pid0 = (await version()).pid;
  const r = await fetch(`${BASE}/setup`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ childName: "Ellie", dwellMs: 1000, apps: ["making-words", "pencil"] }) });
  assert.ok(r.ok, "wizard saved");
  let build = "", pid = pid0;
  for (let i = 0; i < 120; i++) {
    await new Promise(rr => setTimeout(rr, 250));
    const v = await version();
    if (v) { build = v.build; pid = v.pid; if (build === NEW_BUILD && pid !== pid0) break; }
  }
  assert.equal(build, NEW_BUILD, "restarted hub serves the new build");
  assert.notEqual(pid, pid0, "a fresh process took over the port");
  assert.ok(fs.existsSync(path.join(DATADIR, "profile.json")), "the profile the family just made survives");
});

test("a newer build on the feed lands by the periodic tick alone — no POST (spec 2026-10-20 §4.1)", async () => {
  // let the restarted hub's own boot check run (and find nothing) first, so
  // only the periodic tick can be what finds the newer build
  await new Promise(rr => setTimeout(rr, BOOT_MS * 3));
  const v0 = await version();
  assert.equal(v0.build, NEW_BUILD, "starts on the build the previous case left");
  publish(NEWER_BUILD, "v99.0.1");
  let build = "", pid = v0.pid;
  for (let i = 0; i < 40; i++) {               // ~20 intervals
    await new Promise(rr => setTimeout(rr, EVERY_MS / 2));
    const v = await version();
    if (v) { build = v.build; pid = v.pid; if (build === NEWER_BUILD && pid !== v0.pid) break; }
  }
  assert.equal(build, NEWER_BUILD, "the periodic tick found and applied the newer build");
  assert.notEqual(pid, v0.pid, "a fresh process serves it");
});

const tap = () => fetch(`${BASE}/log`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app: "update-boot-test", event: "tap" }) }).catch(() => {});

test("/version.idleMs is null before any interaction and resets on a POST /log; polls do not count (§4.4)", async () => {
  const v0 = await version();
  assert.ok("idleMs" in v0, "/version carries idleMs");
  assert.equal(v0.idleMs, null, "a fresh process has heard nothing from her yet");
  await fetch(`${BASE}/settings`);                 // a poll, not an interaction
  assert.equal((await version()).idleMs, null, "GET /settings and /version are not interaction");
  await tap();
  const v1 = await version();
  assert.equal(typeof v1.idleMs, "number");
  assert.ok(v1.idleMs >= 0 && v1.idleMs < 1000, "just tapped: " + v1.idleMs);
  await new Promise(rr => setTimeout(rr, 400));
  const v2 = await version();
  assert.ok(v2.idleMs >= v1.idleMs + 300, "idleMs climbs while nobody taps: " + v2.idleMs);
  await tap();
  assert.ok((await version()).idleMs < 300, "a tap resets it");
});

test("while the board is in use a newer build STAGES and waits; when she stops, it lands (§4.4)", async () => {
  const v0 = await version();
  assert.equal(v0.build, NEWER_BUILD);
  let tapping = true;
  const loop = (async () => { while (tapping) { await tap(); await new Promise(rr => setTimeout(rr, 300)); } })();
  try {
    await new Promise(rr => setTimeout(rr, 600));
    publish(NEWEST_BUILD, "v99.0.2");
    await new Promise(rr => setTimeout(rr, EVERY_MS * 8));     // several periodic ticks
    const v = await version();
    assert.equal(v.build, NEWER_BUILD, "no restart while she is using it");
    assert.equal(v.pid, v0.pid, "same process");
    assert.equal(fs.readFileSync(path.join(INSTALL, "VERSION"), "utf8").trim(), NEWER_BUILD, "nothing overlaid into the live tree");
    assert.ok(fs.existsSync(path.join(STAGED, NEWEST_BUILD, "VERSION")), "the new build is staged beside the install");
  } finally {
    tapping = false;
    await loop;
  }
  let build = "", pid = v0.pid;
  for (let i = 0; i < 60; i++) {               // QUIET_MS + a few ticks, generously
    await new Promise(rr => setTimeout(rr, 250));
    const v = await version();
    if (v) { build = v.build; pid = v.pid; if (build === NEWEST_BUILD && pid !== v0.pid) break; }
  }
  assert.equal(build, NEWEST_BUILD, "the staged build applied once the board went quiet");
  assert.notEqual(pid, v0.pid, "from a fresh process");
  assert.ok(!fs.existsSync(path.join(STAGED, NEWEST_BUILD)), "the staging dir is removed after apply");
});

test("a build left staged applies at the next boot, before the hub serves (§4.4)", async () => {
  await stopHubOnPort(PORT);                       // the self-restarted hub, by pid
  for (let i = 0; i < 50 && await version(); i++) await new Promise(rr => setTimeout(rr, 100));
  assert.equal(await version(), null, "hub is down");
  makeInstall(path.join(STAGED, STAGED_BUILD), STAGED_BUILD);    // what a deferred check leaves behind
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: INSTALL, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: DATADIR, ERA_BIND: "127.0.0.1",
           ERA_UPDATE_URL: `http://127.0.0.1:${FEED_PORT}`, ERA_NO_UPDATE: "", ERA_UPDATE_BOOT_MS: String(BOOT_MS),
           ERA_UPDATE_EVERY_MS: String(EVERY_MS), ERA_UPDATE_QUIET_MS: String(QUIET_MS) },
  });
  let first = null;
  for (let i = 0; i < 100 && !first; i++) {
    first = await version();
    if (!first) await new Promise(rr => setTimeout(rr, 100));
  }
  assert.ok(first, "hub came up");
  assert.equal(first.build, STAGED_BUILD, "the very first answer is already the staged build");
  assert.equal(fs.readFileSync(path.join(INSTALL, "VERSION"), "utf8").trim(), STAGED_BUILD);
  assert.ok(!fs.existsSync(path.join(STAGED, STAGED_BUILD)), "the staging dir is removed after apply");
});
