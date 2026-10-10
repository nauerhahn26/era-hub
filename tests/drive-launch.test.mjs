// drive-launch.test.mjs — Google Drive for Desktop installed, signed in, and
// simply not running: the hub starts it.
//
// The school device, 10/8: the Drawing People strip showed the eight built-in
// generic people instead of the family's own. Drive for Desktop was installed
// and signed in (an account folder under %LOCALAPPDATA%\Google\DriveFS\<digits>,
// its Run entry present) but had not launched after the last two reboots, so
// there was no G:\My Drive, every ten-minute pass reported files:0, and the hub
// sat there quietly forever. The hub runs in the person's own Windows session,
// so it can launch the app itself — drive.js maybeLaunchDrive().
//
// Seams (drive.js header): ERA_DRIVE_FS_EXE is the program to launch (here a
// small node script that plays Drive: it mounts a folder and leaves a "running"
// marker), ERA_DRIVE_FS_ACCOUNTS the folder holding the digits-only account
// dir, ERA_DRIVE_FS_RUNNING the marker file that means "running" in place of
// tasklist, ERA_DRIVE_FS_LAUNCH_SPACING_MS the ten-minute spacing between
// launches. Unset, a family's hub behaves exactly as before.
//
// Port 8455 (this suite's own). Grepped tests/ of era-core, era-board,
// era-making-words, era-pencil, era-hub and every era-hub--wt-* worktree on
// 10/8: no suite names 8455, and `ss -ltn` showed nothing listening there.
// 8380-8389 avoided: docs/dev-flow.md reserves that band for MANUAL test hubs
// (ERA_TEST_PORT), and a suite there can collide with a hand-started hub.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8455;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-drv-launch-"));
const FAKE = path.join(TMP, "fake-drive.mjs");
let child = null;
let out = "";

// What Google Drive for Desktop does when it starts, as far as the hub can
// see: the mount appears (with the family's folder already synced down), and
// the process is there. FAKE_DRIVE_MODE=crash is the Drive that dies on launch.
fs.writeFileSync(FAKE, `
import fs from "node:fs";
import path from "node:path";
fs.appendFileSync(process.env.FAKE_DRIVE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.FAKE_DRIVE_MODE !== "crash") {
  const people = path.join(process.env.FAKE_DRIVE_ROOT, "My Drive", "New ERA Content", "characters");
  fs.mkdirSync(people, { recursive: true });
  fs.writeFileSync(path.join(people, "one.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  fs.writeFileSync(path.join(people, "characters.json"),
    JSON.stringify({ people: [{ slug: "one", word: "One" }] }));
  fs.writeFileSync(process.env.ERA_DRIVE_FS_RUNNING, "running");
}
`);

// A per-case world: the Drive root (absent until the fake mounts it), the
// accounts folder (with or without a digits-only account dir), the running
// marker, the fake's invocation log and a data dir.
function world(name, { account = true, running = false } = {}) {
  const dir = path.join(TMP, name);
  const accounts = path.join(dir, "DriveFS");
  fs.mkdirSync(accounts, { recursive: true });
  if (account) fs.mkdirSync(path.join(accounts, "1234567890123456789"));
  fs.mkdirSync(path.join(accounts, "Crashpad"));            // a non-account sibling Drive keeps there
  const marker = path.join(dir, "running.marker");
  if (running) fs.writeFileSync(marker, "running");
  const data = path.join(dir, "data");
  fs.mkdirSync(data);
  return { dir, accounts, marker, data, log: path.join(dir, "fake.log"),
           myDrive: path.join(dir, "My Drive"), folder: path.join(dir, "My Drive", "New ERA Content") };
}
const seams = (w, extra = {}) => ({
  ERA_DRIVE_FS_EXE: FAKE, ERA_DRIVE_FS_ACCOUNTS: w.accounts, ERA_DRIVE_FS_RUNNING: w.marker,
  ERA_DRIVE_LOCAL_ROOTS: w.myDrive, FAKE_DRIVE_ROOT: w.dir, FAKE_DRIVE_LOG: w.log, ...extra,
});

async function startHub(w, env, cfg) {
  await stopHub();          // a case that failed mid-way left its hub up: never probe IT as ours
  if (cfg) fs.writeFileSync(path.join(w.data, "drive.json"), JSON.stringify(cfg));
  out = "";
  // Everything ERA_DRIVE_FS_* is stripped from the parent env first: the
  // "seams unset" case has to mean unset, whatever the shell running the suite holds.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ERA_DRIVE_")));
  child = spawn(process.execPath, ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "pipe", "inherit"],
    env: { ...base, ERA_DATA_DIR: w.data, ERA_BIND: "127.0.0.1", ...env },
  });
  child.stdout.on("data", (b) => { out += b; process.stdout.write(b); });
  const me = child;
  for (let i = 0; i < 100; i++) {
    if (me.exitCode !== null) throw new Error("hub exited during startup");
    try { await fetch(`${BASE}/integrations/drive/status`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server never came up");
}
async function stopHub() {
  if (!child) return;
  const c = child; child = null;
  const gone = new Promise(r => c.once("exit", r));
  c.kill("SIGKILL");
  await gone;
}
after(async () => { await stopHub(); fs.rmSync(TMP, { recursive: true, force: true }); });

const status = () => fetch(`${BASE}/integrations/drive/status`, { cache: "no-store" }).then(r => r.json());
const syncNow = () => fetch(`${BASE}/integrations/drive/sync`, { method: "POST" }).then(r => r.json());
const launches = (w) => { try { return fs.readFileSync(w.log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
async function until(what, ok, ms = 10000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    if (await ok()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for " + what);
}
const settle = () => new Promise(r => setTimeout(r, 700));   // long enough for a spawned node to log

test("installed + signed in + not running + no mount: the hub starts Drive, and the next pass mirrors the family's People", async () => {
  const w = world("launch");
  // The school device: configured long ago, its folder on a G: that is not there today.
  await startHub(w, seams(w), { mode: "local", folderPath: w.folder });

  const before = await status();
  assert.equal(before.appInstalled, true, "the seam's program counts as the installed app");
  assert.equal(before.signedIn, false, "no mount yet");
  assert.equal(before.driveLaunched, null);
  assert.equal(before.driveLaunches, 0);
  assert.equal((await fetch(`${BASE}/characters/index.json`)).headers.get("x-characters-source"), "default",
    "what the school device showed: the built-in people");

  const first = await syncNow();
  assert.equal(first.files, 0, "the pass that launched Drive had nothing to copy yet — lastSync keeps its shape");
  await until("the fake Drive to mount", () => fs.existsSync(w.marker));
  assert.deepEqual(launches(w), [["--startup_mode"]], "launched once, the way its Run entry does");
  assert.match(out, /\[drive\] launched Google Drive for Desktop \(installed, signed in, not running\) — the mirror resumes when it mounts/);

  const s = await status();
  assert.equal(s.driveLaunches, 1);
  assert.ok(!Number.isNaN(Date.parse(s.driveLaunched)), "driveLaunched is an ISO time: " + s.driveLaunched);
  assert.equal(s.signedIn, true, "and now the mount is there");

  const second = await syncNow();
  assert.ok(second.files >= 2, "the next pass mirrored it: " + JSON.stringify(second));
  const r = await fetch(`${BASE}/characters/index.json`);
  assert.equal(r.headers.get("x-characters-source"), "family", "the family's own People are back");
  assert.deepEqual((await r.json()).map(p => p.slug), ["one"]);
  await settle();
  assert.equal(launches(w).length, 1, "a running, mounted Drive is never launched again");
  assert.equal((await status()).driveLaunches, 1);
  await stopHub();
});

test("Drive already running (no mount yet — still signing in): no launch", async () => {
  const w = world("running", { running: true });
  await startHub(w, seams(w, { ERA_DRIVE_FS_LAUNCH_SPACING_MS: "0" }), { mode: "local", folderPath: w.folder });
  await syncNow(); await syncNow();
  await settle();
  assert.deepEqual(launches(w), []);
  const s = await status();
  assert.equal(s.driveLaunches, 0);
  assert.equal(s.driveLaunched, null);
  await stopHub();
});

test("installed but never signed in (no account folder): no launch — that is step 2 of the checklist, a person's job", async () => {
  const w = world("no-account", { account: false });
  await startHub(w, seams(w, { ERA_DRIVE_FS_LAUNCH_SPACING_MS: "0" }));   // unconfigured hub too
  await syncNow(); await syncNow();
  await settle();
  assert.deepEqual(launches(w), []);
  assert.equal((await status()).driveLaunches, 0);
  await stopHub();
});

test("a Drive that will not stay up is launched three times, then never again until restart", async () => {
  const w = world("crash");
  await startHub(w, seams(w, { FAKE_DRIVE_MODE: "crash", ERA_DRIVE_FS_LAUNCH_SPACING_MS: "0" }),
                 { mode: "local", folderPath: w.folder });
  for (let i = 1; i <= 3; i++) {
    await syncNow();
    await until("launch " + i, () => launches(w).length === i);
  }
  for (let i = 0; i < 3; i++) await syncNow();
  await settle();
  assert.equal(launches(w).length, 3, "no fourth launch");
  const s = await status();
  assert.equal(s.driveLaunches, 3);
  const giveUp = out.split("\n").filter(l => l.includes("[drive] Google Drive for Desktop will not stay up — giving up until restart"));
  assert.equal(giveUp.length, 1, "said once, not once per pass");
  await stopHub();
});

test("the ten-minute spacing holds by default: a second pass right after a launch does not launch again", async () => {
  const w = world("spacing");
  await startHub(w, seams(w, { FAKE_DRIVE_MODE: "crash" }), { mode: "local", folderPath: w.folder });
  await syncNow();
  await until("the first launch", () => launches(w).length === 1);
  await syncNow(); await syncNow();
  await settle();
  assert.equal(launches(w).length, 1);
  assert.equal((await status()).driveLaunches, 1);
  await stopHub();
});

test("seams unset (a family's hub off Windows): no launch, no error", async () => {
  const w = world("unset");
  // Only the fake's own variables — nothing that tells the hub where Drive is.
  await startHub(w, { ERA_DRIVE_LOCAL_ROOTS: w.myDrive, FAKE_DRIVE_ROOT: w.dir, FAKE_DRIVE_LOG: w.log },
                 { mode: "local", folderPath: w.folder });
  const r = await syncNow();
  assert.equal(r.files, 0);
  assert.equal(r.error, undefined);
  await settle();
  assert.deepEqual(launches(w), [], "the fake was never invoked");
  const s = await status();
  assert.equal(s.driveLaunches, 0);
  assert.equal(s.driveLaunched, null);
  assert.equal(s.appInstalled, false, "nothing installed here, same as before");
  await stopHub();
});

test("Settings: the Drive checklist says the hub started Drive and is waiting for it", () => {
  const html = fs.readFileSync(path.join(HUB, "public", "settings", "index.html"), "utf8");
  assert.match(html, /s\.driveLaunched && !s\.signedIn/, "shown only while launched and not yet mounted");
  assert.match(html, /Drive was not running; started it at /);
});
