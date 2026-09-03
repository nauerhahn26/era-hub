// update.js — self-updater for INSTALLED payloads (the website download).
// The hub checks the release feed's latest.json {version, build, sha256};
// when the remote build is newer than ./VERSION it downloads the suite
// tarball, verifies the sha256, copies it over this install (never data/,
// never the in-use node/ runtime), and restarts itself. Guards: only runs
// when a VERSION file sits next to server.js AND this is not a git checkout
// (dev servers and the test gate run from checkouts and must never touch
// themselves). ERA_NO_UPDATE=1 force-disables; ERA_UPDATE_URL points the
// feed elsewhere (tests use a local fake release server).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const packs = require("./packs.js");

const HERE = __dirname;
const VERSION_FILE = path.join(HERE, "VERSION");
const FEED = process.env.ERA_UPDATE_URL ||
  "https://github.com/nauerhahn26/new-era-releases/releases/latest/download";

const enabled = !process.env.ERA_NO_UPDATE &&
  fs.existsSync(VERSION_FILE) && !fs.existsSync(path.join(HERE, ".git"));

function currentBuild() {
  try { return fs.readFileSync(VERSION_FILE, "utf8").trim(); } catch { return "dev"; }
}
// The build this PROCESS is running (frozen at boot). After an update lands
// on disk the two differ until the restart — /version exposes both so the
// FE only reloads once new code is actually serving.
const runningBuild = currentBuild();

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Relaunch: spawn the new hub directly (no shell — shells proved fragile in
// kiosk/scheduled-task contexts) and exit shortly after. The new process
// retry-binds until this one releases the port (server.js EADDRINUSE loop).
// If even that spawn is refused, the update stays applied on disk and the
// next launcher press serves the new build (the app bats ensure-start the
// hub) — report "deferred" instead of pretending.
function scheduleRestart(port) {
  try {
    // Log where the family (and we) can find it: with stdio "ignore" the
    // restarted hub wrote nothing anywhere, so every message after an update
    // was lost — including the ones that explain a failed photo (9/2).
    let out = "ignore";
    try {
      fs.mkdirSync(path.join(HERE, "data", "logs"), { recursive: true });
      out = fs.openSync(path.join(HERE, "data", "logs", "hub.log"), "a");
    } catch {}
    spawn(process.execPath, ["server.js", String(port)],
      { cwd: HERE, detached: true,
        stdio: out === "ignore" ? "ignore" : ["ignore", out, out] }).unref();
    setTimeout(() => process.exit(0), 800);
    return "restarting";
  } catch (e) {
    console.log("[update] restart spawn refused (" + e.message + ") — new build serves on next launch");
    return "deferred";
  }
}

let inFlight = false;
// One full check-and-apply pass. Returns a status object; when it returns
// {status:"updated"} a restart is already scheduled (~1s out) — respond to
// the client first, the exit comes after.
async function check(port) {
  if (!enabled) return { status: "disabled" };
  if (inFlight) return { status: "busy" };
  inFlight = true;
  try {
    const local = currentBuild();
    const r = await fetch(FEED + "/latest.json", { cache: "no-store", redirect: "follow" });
    if (!r.ok) return { status: "feed-error", code: r.status, build: local };
    const latest = await r.json();
    if (!latest.build || !(String(latest.build) > local))
      return { status: "up-to-date", build: local, latest: latest.version || "" };

    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "era-update-"));
    try {
      const tarball = path.join(stage, "suite.tar.gz");
      const dl = await fetch(FEED + "/new-era-suite.tar.gz", { redirect: "follow" });
      if (!dl.ok) return { status: "download-error", code: dl.status, build: local };
      fs.writeFileSync(tarball, Buffer.from(await dl.arrayBuffer()));
      if (latest.sha256 && sha256(tarball) !== latest.sha256)
        return { status: "bad-checksum", build: local };

      const ex = path.join(stage, "x"); fs.mkdirSync(ex);
      const t = spawnSync("tar", ["-xzf", tarball, "-C", ex]);
      if (t.status !== 0) return { status: "extract-error", build: local };
      const top = fs.readdirSync(ex);
      const root = top.length === 1 ? path.join(ex, top[0]) : ex;

      // Overlay onto this install. Never data/ (not in the tarball anyway,
      // belt+braces) and never node/ — node.exe is the running binary and is
      // locked on Windows; a runtime bump lands on the next fresh install.
      // App packs (packs.js): refresh the ones on disk, never lay down one
      // the family did not choose — an update must not undo the installer's
      // checkboxes (dad 9/3). Enabling later still installs from the feed.
      const absent = Object.keys(packs.PACKS).filter(id => !packs.packInstalled(HERE, id));
      fs.cpSync(root, HERE, { recursive: true, force: true, filter: (src) => {
        const rel = path.relative(root, src);
        if (rel === "data" || rel.startsWith("data" + path.sep) ||
            rel === "node" || rel.startsWith("node" + path.sep)) return false;
        const pack = packs.packOf(rel);
        return !(pack && absent.includes(pack));
      }});
      const now = currentBuild();
      const restart = scheduleRestart(port);
      console.log("[update] " + local + " -> " + now + " (" + (latest.version || "") + "); " + restart);
      return { status: "updated", from: local, to: now, version: latest.version || "", restart };
    } finally {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    }
  } catch (e) {
    return { status: "error", message: String(e && e.message) };
  } finally {
    inFlight = false;
  }
}

// Quiet background cadence: first look shortly after boot (let the network
// settle), then every 6 hours. Failures just wait for the next tick.
// `ready()` says whether the hub may restart itself right now: the boot
// check used to fire 90 s in, which on a first launch is mid-wizard — the
// hub restarted under the family's "Go" and the wizard stuck with its button
// greyed (VM leg B, 9/3). A manual POST /update/check is never gated.
const BOOT_MS = Number(process.env.ERA_UPDATE_BOOT_MS) || 90 * 1000;
function start(port, ready = () => true) {
  if (!enabled) return;
  const boot = () => {
    if (!ready()) { setTimeout(boot, BOOT_MS).unref(); return; }
    check(port).then(r => {
      if (r.status !== "up-to-date") console.log("[update] boot check: " + r.status);
    });
  };
  setTimeout(boot, BOOT_MS).unref();
  setInterval(() => { if (ready()) check(port); }, 6 * 60 * 60 * 1000).unref();
}

module.exports = { enabled, currentBuild, runningBuild, check, start, FEED };
