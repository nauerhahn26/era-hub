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

// Is this socket's peer the machine itself? The ONLY addresses node reports
// for a loopback connection, spelled out — no prefix matching, no DNS name,
// no header. Callers pass req.socket.remoteAddress and nothing else: an
// X-Forwarded-For can say anything, and on a hub opened to the LAN by
// ERA_BIND that would be an open door to installing code on the device
// (dev-flow spec §5.3).
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function isLoopback(addr) {
  return typeof addr === "string" && LOOPBACK.has(addr);
}

// Stage, then apply when quiet (spec 2026-10-20 §4.4). A restart takes about
// two seconds and a tap that lands in them fails, so a check only STAGES a
// newer build (download, verify, extract into <HERE>/.update-staged/<build>,
// never into the live tree) and the overlay + restart wait until the hub has
// heard nothing from her for QUIET_MS — or for the next boot, or for an
// operator's manual POST /update/check (force). One staged build at a time:
// the dir name IS the build; a dot-prefixed dir is an extraction in progress
// and is never taken as staged.
const STAGE_ROOT = path.join(HERE, ".update-staged");
const QUIET_MS = Number(process.env.ERA_UPDATE_QUIET_MS) || 90 * 1000;
const QUIET_POLL_MS = Math.min(15 * 1000, QUIET_MS);
let lastInteractionAt = () => null;   // server.js hands its clock to start()
let readyFn = () => true;
let quietTimer = null;
let stagedVersion = "";               // the feed's version label, for the log line

function idleMs() {
  const at = lastInteractionAt();
  return at == null ? null : Date.now() - at;
}
// Quiet: nothing from her for QUIET_MS — or nothing at all since this process
// started (a fresh hub has no tap to protect).
function quiet() {
  const idle = idleMs();
  return idle == null || idle >= QUIET_MS;
}
// The staged build waiting, or null. Newest wins if more than one is there.
function stagedBuild() {
  try {
    const b = fs.readdirSync(STAGE_ROOT).filter(n => !n.startsWith(".") &&
      fs.existsSync(path.join(STAGE_ROOT, n, "VERSION"))).sort();
    return b.length ? b[b.length - 1] : null;
  } catch { return null; }
}
function clearStaged() {
  try { fs.rmSync(STAGE_ROOT, { recursive: true, force: true }); } catch {}
}

// Overlay the staged build onto this install and restart. Never data/ (not in
// the tarball anyway, belt+braces) and never node/ — node.exe is the running
// binary and is locked on Windows; a runtime bump lands on the next fresh
// install. App packs (packs.js): refresh the ones on disk, never lay down one
// the family did not choose — an update must not undo the installer's
// checkboxes (dad 9/3). Enabling later still installs from the feed.
function applyStaged(port, build, version) {
  const root = path.join(STAGE_ROOT, build);
  const local = currentBuild();
  const absent = Object.keys(packs.PACKS).filter(id => !packs.packInstalled(HERE, id));
  fs.cpSync(root, HERE, { recursive: true, force: true, filter: (src) => {
    const rel = path.relative(root, src);
    if (rel === "data" || rel.startsWith("data" + path.sep) ||
        rel === "node" || rel.startsWith("node" + path.sep)) return false;
    const pack = packs.packOf(rel);
    return !(pack && absent.includes(pack));
  }});
  clearStaged();
  if (quietTimer) { clearInterval(quietTimer); quietTimer = null; }
  const now = currentBuild();
  const restart = scheduleRestart(port);
  console.log("[update] " + local + " -> " + now + " (" + (version || "") + "); " + restart);
  return { status: "updated", from: local, to: now, version: version || "", restart };
}

// ONE short timer while a build waits: it applies the moment the board has
// been quiet for QUIET_MS. Gated by ready() like every automatic path.
function armQuietTimer(port) {
  if (quietTimer) return;
  quietTimer = setInterval(() => {
    if (inFlight || !readyFn() || !quiet()) return;
    const b = stagedBuild();
    if (!b || !(b > currentBuild())) { clearInterval(quietTimer); quietTimer = null; return; }
    inFlight = true;
    try { applyStaged(port, b, stagedVersion); }
    catch (e) { console.log("[update] apply failed: " + (e && e.message)); }
    finally { inFlight = false; }
  }, QUIET_POLL_MS);
  quietTimer.unref();
}

let inFlight = false;
// One full check pass. Returns a status object; when it returns
// {status:"updated"} a restart is already scheduled (~1s out) — respond to
// the client first, the exit comes after. {status:"staged"} means a newer
// build waits beside the install for a quiet moment (or the next boot).
//
// `feed` overrides the release feed for THIS call only (push-device.sh sends
// one build to one device over an ssh tunnel); the boot check and the
// periodic tick pass no feed and keep using FEED. When an override is used
// the answer carries it back, so the operator can see which feed served.
// `force` (the manual POST route) applies at once, quiet or not.
async function check(port, feed = FEED, { force = false } = {}) {
  const r = await runCheck(port, feed, force);
  return feed === FEED ? r : { ...r, feed };
}

async function runCheck(port, feed, force) {
  if (!enabled) return { status: "disabled" };
  if (inFlight) return { status: "busy" };
  inFlight = true;
  try {
    const local = currentBuild();
    const r = await fetch(feed + "/latest.json", { cache: "no-store", redirect: "follow" });
    if (!r.ok) return { status: "feed-error", code: r.status, build: local };
    const latest = await r.json();
    if (!latest.build || !(String(latest.build) > local)) {
      if (stagedBuild()) clearStaged();   // nothing newer to wait with
      return { status: "up-to-date", build: local, latest: latest.version || "" };
    }
    const want = String(latest.build);

    // FETCH + STAGE — skipped when this very build already waits.
    if (stagedBuild() !== want) {
      const st = await stage(feed, want, latest.sha256, local);
      if (st) return st;
      console.log("[update] staged " + want);
    }
    stagedVersion = latest.version || "";

    // APPLY — only when quiet, or when the operator asked.
    if (force || quiet()) return applyStaged(port, want, stagedVersion);
    armQuietTimer(port);
    return { status: "staged", build: want, idleMs: idleMs() };
  } catch (e) {
    return { status: "error", message: String(e && e.message) };
  } finally {
    inFlight = false;
  }
}

// Download, verify and extract `build` into STAGE_ROOT/<build>. Returns null
// on success, else the status to answer with. Nothing is ever half-written:
// the extraction lands in a dot-dir and is renamed into place only whole; a
// bad checksum or a full disk leaves no staged build behind.
async function stage(feed, build, sha, local) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "era-update-"));
  let incoming = null;
  try {
    const tarball = path.join(tmp, "suite.tar.gz");
    const dl = await fetch(feed + "/new-era-suite.tar.gz", { redirect: "follow" });
    if (!dl.ok) return { status: "download-error", code: dl.status, build: local };
    try { fs.writeFileSync(tarball, Buffer.from(await dl.arrayBuffer())); }
    catch (e) { return { status: "stage-error", message: String(e && e.message), build: local }; }
    if (sha && sha256(tarball) !== sha) { clearStaged(); return { status: "bad-checksum", build: local }; }

    clearStaged();   // one staged build at a time
    try {
      fs.mkdirSync(STAGE_ROOT, { recursive: true });
      incoming = fs.mkdtempSync(path.join(STAGE_ROOT, ".incoming-"));
    } catch (e) { return { status: "stage-error", message: String(e && e.message), build: local }; }
    const t = spawnSync("tar", ["-xzf", tarball, "-C", incoming]);
    if (t.status !== 0) { clearStaged(); return { status: "extract-error", build: local }; }
    const top = fs.readdirSync(incoming);
    const root = top.length === 1 ? path.join(incoming, top[0]) : incoming;
    try {
      if (root === incoming) fs.renameSync(incoming, path.join(STAGE_ROOT, build));
      else fs.renameSync(root, path.join(STAGE_ROOT, build));
    } catch (e) { clearStaged(); return { status: "stage-error", message: String(e && e.message), build: local }; }
    return null;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    if (incoming) try { fs.rmSync(incoming, { recursive: true, force: true }); } catch {}
  }
}

// At boot, before the hub serves: a build left staged (she never paused while
// the device was awake) applies now. The old process overlays and hands over
// through the same restart as any update, and never listens itself — this
// server.js was loaded before the overlay, so serving from it would mix two
// builds. Returns true when a restart is under way (the caller must not
// listen). Nobody is using a hub that is not serving yet, so this path needs
// no quiet moment; a staged build is only ever there because a ready() path
// staged it.
function applyStagedAtBoot(port) {
  if (!enabled) return false;
  const b = stagedBuild();
  if (!b) return false;
  if (!(b > currentBuild())) { clearStaged(); return false; }
  try {
    const r = applyStaged(port, b, "");
    return r.restart === "restarting";
  } catch (e) {
    console.log("[update] boot apply failed: " + (e && e.message));
    return false;
  }
}

// Quiet background cadence: first look shortly after boot (let the network
// settle), then every 30 minutes. Failures just wait for the next tick. A
// device that sleeps after 10 idle minutes is awake in 20-60 minute windows;
// a 6-hour tick almost never landed in one (spec 2026-10-20 §4.1). A check
// that finds nothing costs one small GET of latest.json.
// `ready()` says whether the hub may restart itself right now: the boot
// check used to fire 90 s in, which on a first launch is mid-wizard — the
// hub restarted under the family's "Go" and the wizard stuck with its button
// greyed (VM leg B, 9/3). A manual POST /update/check is never gated.
const BOOT_MS = Number(process.env.ERA_UPDATE_BOOT_MS) || 90 * 1000;
const EVERY_MS = Number(process.env.ERA_UPDATE_EVERY_MS) || 30 * 60 * 1000;

// Wake detection (spec 2026-10-20 §4.2). A heartbeat every HEARTBEAT_MS
// records the time; a gap longer than HEARTBEAT_MS + WAKE_GAP_MS between two
// beats means the machine slept (or the clock jumped), so the hub checks ONCE,
// WAKE_DELAY_MS later (let Wi-Fi settle — the Clothing Picker's wake delay).
// A wake check does not reset the periodic tick. A clock that went backwards
// counts as a wake: one extra check is harmless.
const HEARTBEAT_MS = 30 * 1000;
const WAKE_GAP_MS = 2 * 60 * 1000;
const WAKE_DELAY_MS = 20 * 1000;
function wokeUp(prevMs, nowMs, heartbeatMs, gapMs) {
  return nowMs < prevMs || nowMs - prevMs > heartbeatMs + gapMs;
}

function start(port, ready = () => true, interactionAt = () => null) {
  readyFn = ready;
  lastInteractionAt = interactionAt;
  if (!enabled) return;
  const boot = () => {
    if (!ready()) { setTimeout(boot, BOOT_MS).unref(); return; }
    check(port).then(r => {
      if (r.status !== "up-to-date") console.log("[update] boot check: " + r.status);
    });
  };
  setTimeout(boot, BOOT_MS).unref();
  setInterval(() => { if (ready()) check(port); }, EVERY_MS).unref();
  let prev = Date.now(), wakePending = false;
  setInterval(() => {
    const now = Date.now();
    if (wokeUp(prev, now, HEARTBEAT_MS, WAKE_GAP_MS) && !wakePending) {
      wakePending = true;   // one wake check at a time, never a storm
      setTimeout(() => {
        wakePending = false;
        if (!ready()) return;
        check(port).then(r => {
          if (r.status !== "up-to-date") console.log("[update] wake check: " + r.status);
        });
      }, WAKE_DELAY_MS).unref();
    }
    prev = now;
  }, HEARTBEAT_MS).unref();
}

module.exports = { enabled, currentBuild, runningBuild, check, start, FEED, isLoopback, wokeUp,
                   applyStagedAtBoot };
