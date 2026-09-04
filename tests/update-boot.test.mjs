// update-boot.test.mjs — the updater's OWN timers never restart the hub under
// the welcome wizard (VM leg B, 9/3): the boot check fired 90 s after launch,
// which on a first run is exactly when the family presses Go; the hub went
// away under the POST and the wizard stuck with a grey button. The boot
// check waits for a profile; the moment the wizard is answered it runs and
// the new build takes over. (A manual POST /update/check is never gated —
// update.test.mjs covers that path.)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8423;      // hub under test (8391-8422 held by sibling suites)
const FEED_PORT = 8424; // fake release server
const BASE = `http://127.0.0.1:${PORT}`;
const OLD_BUILD = "20200101.0000";
const NEW_BUILD = "20991231.2359";
const BOOT_MS = 700;    // the 90 s boot delay, shrunk for the test

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-updboot-"));
const INSTALL = path.join(TMP, "install");
const DATADIR = path.join(TMP, "data");
let feed, child;

function makeInstall(dir, build) {
  fs.mkdirSync(path.join(dir, "public", "home"), { recursive: true });
  for (const f of ["server.js", "update.js", "packs.js", "drive.js", "clothing.js", "clothing-worker.js", "clothing-photos.js", "slug.js", "pool.js", "predict.js", "predict-model.json", "image-orient.js", "image-util.js", "ai-config.js"])
    fs.copyFileSync(path.join(HUB, f), path.join(dir, f));
  fs.copyFileSync(path.join(HUB, "public", "home", "index.html"), path.join(dir, "public", "home", "index.html"));
  for (const f of ["public/pencil/index.html", "vendor/jpeg-js/index.js"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), build + "\n");
  }
  fs.writeFileSync(path.join(dir, "VERSION"), build + "\n");
}
const version = async () => { try { return await (await fetch(`${BASE}/version`)).json(); } catch { return null; } };

before(async () => {
  spawnSync("pkill", ["-f", `server[.]js ${PORT}`]);
  await new Promise(r => setTimeout(r, 300));
  makeInstall(INSTALL, OLD_BUILD);
  // a fresh install: apps chosen at install time, NO profile yet (wizard pending)
  fs.mkdirSync(DATADIR, { recursive: true });
  fs.writeFileSync(path.join(DATADIR, "apps.json"), JSON.stringify({ enabled: ["making-words", "pencil"] }));

  const relDir = path.join(TMP, "rel");
  makeInstall(path.join(relDir, "new-era-suite"), NEW_BUILD);
  execFileSync("tar", ["-czf", path.join(TMP, "new-era-suite.tar.gz"), "-C", relDir, "new-era-suite"]);
  const tarball = fs.readFileSync(path.join(TMP, "new-era-suite.tar.gz"));
  const sha = crypto.createHash("sha256").update(tarball).digest("hex");
  const latest = JSON.stringify({ version: "v99.0.0", build: NEW_BUILD, sha256: sha });
  feed = http.createServer((req, res) => {
    if (req.url === "/latest.json") { res.writeHead(200).end(latest); return; }
    if (req.url === "/new-era-suite.tar.gz") { res.writeHead(200).end(tarball); return; }
    res.writeHead(404).end();
  });
  await new Promise(r => feed.listen(FEED_PORT, "127.0.0.1", r));

  child = spawn("node", ["server.js", String(PORT)], {
    cwd: INSTALL, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: DATADIR, ERA_BIND: "127.0.0.1",
           ERA_UPDATE_URL: `http://127.0.0.1:${FEED_PORT}`, ERA_NO_UPDATE: "", ERA_UPDATE_BOOT_MS: String(BOOT_MS) },
  });
  for (let i = 0; i < 100; i++) {
    if (await version()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("hub never came up");
});

after(() => {
  if (child) child.kill("SIGKILL");
  spawnSync("pkill", ["-f", `server[.]js ${PORT}`]);
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
