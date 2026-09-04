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

// The hub's own modules, read from build-payload.sh's copy list instead of
// duplicated here. A hand-kept fourth copy of that list is a fourth way for a
// new module to go missing from an install, and this suite is the only thing
// that boots a real one (9/4: content.js grew two new requires and this list
// did not, so the installed hub died on its first line and only the gate said
// so — the very failure tools/build-payload.sh's own guard exists to prevent).
const HUB_MODULES = [...fs.readFileSync(path.join(HUB, "tools", "build-payload.sh"), "utf8")
  .matchAll(/"\$HUB\/([A-Za-z0-9._-]+\.(?:json|js))"/g)].map(m => m[1]);

// A minimal but real install: the hub's own js + a tiny public tree.
function makeInstall(dir, build, marker) {
  fs.mkdirSync(path.join(dir, "public", "home"), { recursive: true });
  for (const f of HUB_MODULES)
    fs.copyFileSync(path.join(HUB, f), path.join(dir, f));
  fs.copyFileSync(path.join(HUB, "public", "home", "index.html"),
                  path.join(dir, "public", "home", "index.html"));
  fs.writeFileSync(path.join(dir, "VERSION"), build + "\n");
  if (marker) fs.writeFileSync(path.join(dir, "public", "updated-marker.txt"), marker);
}
// Pack files as the release ships them (packs.js): the pencil pack, the
// reader pack, the board pack with its cut-out runtime under vendor/, and the
// media-tools pack (yt-dlp, the "add a song from the web" downloader);
// jpeg-js is core. Each file's content names the build it came from.
const PACK_FILES = ["public/pencil/index.html", "public/reader/index.html", "public/board/index.html",
  "vendor/onnxruntime-web/dist/ort.node.min.js", "vendor/models/u2netp.onnx", "vendor/libheif.js",
  "vendor/yt-dlp/yt-dlp.exe", "vendor/jpeg-js/index.js"];
function layPacks(dir, build, only) {
  for (const f of PACK_FILES) {
    if (only && !only.includes(f)) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), build + "\n");
  }
}
const at = (f) => path.join(INSTALL, f);
const has = (f) => fs.existsSync(at(f));

before(async () => {
  // a prior run's self-restarted hub may still hold the port (it outlives its
  // parent by design) — clear it, same pattern as era-gate's port pre-kill
  spawnSync("pkill", ["-f", `server[.]js ${PORT}`]);
  await new Promise(r => setTimeout(r, 300));
  makeInstall(INSTALL, OLD_BUILD, null);
  // the family ticked Making Words + The Pencil at install: only the pencil
  // pack (and the core's jpeg-js) is on disk, and apps.json says so — else
  // the boot reconcile would pull every pack from the feed below
  layPacks(INSTALL, OLD_BUILD, ["public/pencil/index.html", "vendor/jpeg-js/index.js"]);
  fs.mkdirSync(DATADIR, { recursive: true });
  fs.writeFileSync(path.join(DATADIR, "apps.json"), JSON.stringify({ enabled: ["making-words", "pencil"] }));

  // The "newer release": same install shape, new VERSION + a marker file,
  // tar'd with the payload's real top-dir name.
  const relDir = path.join(TMP, "rel");
  makeInstall(path.join(relDir, "new-era-suite"), NEW_BUILD, "hello from the new build\n");
  layPacks(path.join(relDir, "new-era-suite"), NEW_BUILD);
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

// Dad 9/3: the installer's "Space required" never moved when apps were
// unticked — the cut-out runtime rode with the core, and a self-update then
// re-laid every pack the family had declined. The overlay refreshes what is
// installed and leaves the rest alone.
test("the update refreshes installed packs and never lays down unchosen ones", () => {
  assert.equal(fs.readFileSync(at("public/pencil/index.html"), "utf8"), NEW_BUILD + "\n", "installed pack refreshed");
  assert.equal(fs.readFileSync(at("vendor/jpeg-js/index.js"), "utf8"), NEW_BUILD + "\n", "core vendor refreshed");
  for (const f of ["public/reader", "public/board", "vendor/onnxruntime-web", "vendor/models", "vendor/libheif.js",
                   "vendor/yt-dlp"])
    assert.ok(!has(f), f + " stays absent (its app was not chosen)");
});

test("enabling Clothing later installs the board pack WITH its cut-out runtime; removing drops all of it", async () => {
  let r = await fetch(`${BASE}/apps`, { method: "POST", body: JSON.stringify({ id: "board", enabled: true }) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { installing: true }, "enable kicks off the pack download");
  let installed = false;
  for (let i = 0; i < 100 && !installed; i++) {
    await new Promise(rr => setTimeout(rr, 100));
    const { apps } = await (await fetch(`${BASE}/apps`)).json();
    installed = apps.find(a => a.id === "board").installed;
  }
  assert.ok(installed, "board pack installed from the release feed");
  for (const f of ["public/board/index.html", "vendor/onnxruntime-web/dist/ort.node.min.js", "vendor/models/u2netp.onnx", "vendor/libheif.js"])
    assert.equal(fs.readFileSync(at(f), "utf8"), NEW_BUILD + "\n", f + " landed");
  assert.ok(!has("public/reader"), "the reader pack is still not on disk");

  r = await fetch(`${BASE}/apps/delete`, { method: "POST", body: JSON.stringify({ id: "board" }) });
  assert.equal(r.status, 409, "still enabled: refuse");
  await fetch(`${BASE}/apps`, { method: "POST", body: JSON.stringify({ id: "board", enabled: false }) });
  r = await fetch(`${BASE}/apps/delete`, { method: "POST", body: JSON.stringify({ id: "board" }) });
  assert.equal(r.status, 204);
  for (const f of ["public/board", "vendor/onnxruntime-web", "vendor/models", "vendor/libheif.js"])
    assert.ok(!has(f), f + " removed with the pack");
  assert.ok(has("vendor/jpeg-js/index.js"), "core vendor untouched by pack removal");
  const { apps } = await (await fetch(`${BASE}/apps`)).json();
  assert.equal(apps.find(a => a.id === "board").installed, false);
});

test("a second check is a no-op: up-to-date", async () => {
  const r = await (await fetch(`${BASE}/update/check`, { method: "POST" })).json();
  assert.equal(r.status, "up-to-date");
  assert.equal(r.build, NEW_BUILD);
});

// Settings has a "Check for updates now" button (dad 9/3: a hub that has been
// up since morning only notices an afternoon release at its 6-hour tick, and
// closing/reopening New ERA does not restart the hub). The button POSTs the
// same route as the timer and must have a plain-English line for every
// status the route can answer — an unknown status falls into the generic
// "couldn't fetch" line, never a blank card.
test("Settings' 'Check for updates now' hits /update/check and speaks every status", () => {
  const html = fs.readFileSync(path.join(HUB, "public", "settings", "index.html"), "utf8");
  assert.match(html, /id="updCheck"/, "the button exists");
  assert.match(html, /fetch\("\/update\/check",\{method:"POST"\}\)/, "the button POSTs the updater's route");
  assert.match(html, /fetch\("\/version"/, "the card shows the running build");
  const src = fs.readFileSync(path.join(HUB, "update.js"), "utf8");
  const statuses = new Set([...src.matchAll(/status: *"([a-z-]+)"/g)].map(m => m[1]));
  for (const s of ["updated", "up-to-date", "busy", "disabled"]) {
    assert.ok(statuses.has(s), `update.js still answers ${s}`);
    assert.ok(html.includes(`r.status==="${s}"`), `settings speaks "${s}"`);
  }
  assert.match(html, /Couldn't fetch an update/, "every other status gets the generic try-again line");
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
