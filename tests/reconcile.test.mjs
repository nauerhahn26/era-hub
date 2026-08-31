// reconcile.test.mjs — apps chosen at install time really install (dad's
// cold test 8/29: the ERAgaze checkbox wrote apps.json but nothing acted on
// it at first boot). A hub that boots with an app ENABLED in apps.json but
// missing on disk pulls its pack from the release feed by itself.
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
const PORT = 8414;      // 8391-8413 held by sibling suites
const FEED_PORT = 8415;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-rec-"));
const INSTALL = path.join(TMP, "install");
let feed, child;

before(async () => {
  // minimal install: hub js + home page, NO reader pack, apps.json wants reader
  fs.mkdirSync(path.join(INSTALL, "public", "home"), { recursive: true });
  for (const f of ["server.js", "update.js", "drive.js", "clothing.js", "clothing-worker.js", "pool.js", "predict.js", "predict-model.json"])
    fs.copyFileSync(path.join(HUB, f), path.join(INSTALL, f));
  fs.copyFileSync(path.join(HUB, "public", "home", "index.html"),
                  path.join(INSTALL, "public", "home", "index.html"));
  fs.writeFileSync(path.join(INSTALL, "VERSION"), "20200101.0000\n");
  const dataDir = path.join(TMP, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "apps.json"), JSON.stringify({ enabled: ["reader"] }));

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

  child = spawn("node", ["server.js", String(PORT)], {
    cwd: INSTALL, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: dataDir, ERA_BIND: "127.0.0.1",
           ERA_UPDATE_URL: `http://127.0.0.1:${FEED_PORT}`, ERA_NO_UPDATE: "1" },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("hub never came up");
});
after(() => { if (child) child.kill("SIGKILL"); if (feed) feed.close(); });

test("boot reconcile installs an enabled-but-missing pack by itself", async () => {
  let installed = false;
  for (let i = 0; i < 60 && !installed; i++) {       // reconcile fires ~5s after boot
    await new Promise(r => setTimeout(r, 500));
    const { apps } = await (await fetch(`${BASE}/apps`, { cache: "no-store" })).json();
    installed = apps.find(a => a.id === "reader").installed;
  }
  assert.ok(installed, "reader pack self-installed after boot");
  assert.ok(fs.existsSync(path.join(INSTALL, "public", "reader", "index.html")));
});
