// update.test.mjs — self-updater contract (install QA 8/28): an INSTALLED
// hub (VERSION file, no .git) polls the release feed's latest.json, and when
// the remote build is newer it downloads the tarball, sha256-verifies it,
// overlays this install (never data/, never node/), and restarts itself on
// the same port with the new build. A checkout hub reports the updater
// disabled and never touches itself.
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
const PORT = 8410;      // hub under test (8391-8409 held by sibling suites)
const FEED_PORT = 8411; // fake release server
const BASE = `http://127.0.0.1:${PORT}`;
const OLD_BUILD = "20200101.0000";
const NEW_BUILD = "20991231.2359";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-upd-"));
const INSTALL = path.join(TMP, "install");
const DATADIR = path.join(TMP, "data");
let feed, child;

// A minimal but real install: the hub's own js + a tiny public tree.
function makeInstall(dir, build, marker) {
  fs.mkdirSync(path.join(dir, "public", "home"), { recursive: true });
  for (const f of ["server.js", "update.js", "pool.js", "predict.js", "predict-model.json"])
    fs.copyFileSync(path.join(HUB, f), path.join(dir, f));
  fs.copyFileSync(path.join(HUB, "public", "home", "index.html"),
                  path.join(dir, "public", "home", "index.html"));
  fs.writeFileSync(path.join(dir, "VERSION"), build + "\n");
  if (marker) fs.writeFileSync(path.join(dir, "public", "updated-marker.txt"), marker);
}

before(async () => {
  // a prior run's self-restarted hub may still hold the port (it outlives its
  // parent by design) — clear it, same pattern as era-gate's port pre-kill
  spawnSync("pkill", ["-f", `server[.]js ${PORT}`]);
  await new Promise(r => setTimeout(r, 300));
  makeInstall(INSTALL, OLD_BUILD, null);

  // The "newer release": same install shape, new VERSION + a marker file,
  // tar'd with the payload's real top-dir name.
  const relDir = path.join(TMP, "rel");
  makeInstall(path.join(relDir, "new-era-suite"), NEW_BUILD, "hello from the new build\n");
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
           ERA_UPDATE_URL: `http://127.0.0.1:${FEED_PORT}`, ERA_NO_UPDATE: "" },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("hub never came up");
});

after(() => {
  if (child) child.kill("SIGKILL");
  spawnSync("pkill", ["-f", `server[.]js ${PORT}`]); // the self-restarted hub
  if (feed) feed.close();
});

test("installed hub reports its build and an enabled updater", async () => {
  const v = await (await fetch(`${BASE}/version`)).json();
  assert.equal(v.build, OLD_BUILD);
  assert.equal(v.updater, true);
});

test("check applies a newer release and the hub restarts on the new build", async () => {
  const pid0 = (await (await fetch(`${BASE}/version`)).json()).pid;
  const r = await (await fetch(`${BASE}/update/check`, { method: "POST" })).json();
  assert.equal(r.status, "updated");
  assert.equal(r.from, OLD_BUILD);
  assert.equal(r.to, NEW_BUILD);

  // files landed (marker from the new tarball), data dir untouched
  assert.equal(fs.readFileSync(path.join(INSTALL, "public", "updated-marker.txt"), "utf8"),
               "hello from the new build\n");
  assert.ok(fs.existsSync(path.join(DATADIR, "logs")), "data dir survives");

  // the old process exits, a NEW process binds the port with the new build
  let build = "", pid = pid0;
  for (let i = 0; i < 120; i++) {
    await new Promise(rr => setTimeout(rr, 250));
    try {
      const v = await (await fetch(`${BASE}/version`)).json();
      build = v.build; pid = v.pid;
      if (build === NEW_BUILD && pid !== pid0) break;
    } catch { /* between old exit and new bind */ }
  }
  assert.equal(build, NEW_BUILD, "restarted hub serves the new build");
  assert.notEqual(pid, pid0, "a fresh process took over the port");
});

test("a second check is a no-op: up-to-date", async () => {
  const r = await (await fetch(`${BASE}/update/check`, { method: "POST" })).json();
  assert.equal(r.status, "up-to-date");
  assert.equal(r.build, NEW_BUILD);
});

test("a checkout hub keeps the updater disabled", async () => {
  const PORT2 = 8412;
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "era-upd2-"));
  const c2 = spawn("node", ["server.js", String(PORT2)], {
    cwd: HUB, stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ERA_DATA_DIR: tmp2, ERA_BIND: "127.0.0.1",
           ERA_UPDATE_URL: `http://127.0.0.1:${FEED_PORT}` },
  });
  try {
    let up = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(`http://127.0.0.1:${PORT2}/settings`); up = true; break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(up, "checkout hub came up");
    const v = await (await fetch(`http://127.0.0.1:${PORT2}/version`)).json();
    assert.equal(v.updater, false);
    const r = await (await fetch(`http://127.0.0.1:${PORT2}/update/check`, { method: "POST" })).json();
    assert.equal(r.status, "disabled");
  } finally { c2.kill("SIGKILL"); }
});
