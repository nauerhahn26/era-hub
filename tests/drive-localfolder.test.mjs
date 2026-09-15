// drive-localfolder.test.mjs — the Drive door, driven from outside on a box
// that has no Google Drive for Windows mount (the QA Linux box, and CI).
//
// detectLocal() only ever probed D:..Z:\My Drive and ~/Google Drive, so off
// Windows the roots list was empty, browseLocal() jailed against nothing, and
// POST /integrations/drive/localfolder answered 400 outside-drive for EVERY
// path — the whole book pipeline was unreachable through the one door a family
// actually uses. ERA_DRIVE_LOCAL_ROOTS names extra mount roots
// (path.delimiter-separated), in the shape ERA_DRIVE_OAUTH/ERA_DRIVE_API
// already have. It is a seam, not a loosened jail: unset, nothing changes, and
// set, the jail still admits only what the variable names.
//
// Port 8442 (this suite's own; 8377-8441 are held by siblings and live hubs).
// No key is in play here: no provider is ever reached.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8442;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-drv-local-"));
const ROOT = path.join(TMP, "My Drive");                  // the named mount
const ROOT2 = path.join(TMP, "Second Drive");             // a second one, after the delimiter
const INSIDE = path.join(ROOT, "New ERA Content");        // what the family picks
const INSIDE2 = path.join(ROOT2, "New ERA Content");
const OUTSIDE = path.join(TMP, "Not Drive");              // a plain sibling
const LOOKALIKE = ROOT + " Backup";                       // starts with ROOT, is not inside it
// Auto-adoption (9/15): the second device. ADOPT_ROOT already holds a New ERA
// Content another computer made and Drive synced down; LATE_ROOT is bare at
// boot and grows one while the hub is running (Drive signing in late).
const ADOPT_ROOT = path.join(TMP, "Adopted Drive");
const ADOPTED = path.join(ADOPT_ROOT, "New ERA Content");
const LATE_ROOT = path.join(TMP, "Late Drive");
const LATE = path.join(LATE_ROOT, "New ERA Content");
const require = createRequire(path.join(HUB, "server.js"));
let child = null;

// One port, one hub at a time: the "variable unset" case is a different process
// (env is fixed at spawn), so the suite restarts the server between halves.
async function startHub(extraEnv) {
  const data = fs.mkdtempSync(path.join(TMP, "data-"));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: data, ERA_BIND: "127.0.0.1", ...extraEnv },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/integrations/drive/status`); return data; } catch {}
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
const pick = (folderPath) => fetch(`${BASE}/integrations/drive/localfolder`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ folderPath }),
});
const driveStatus = () => fetch(`${BASE}/integrations/drive/status`, { cache: "no-store" }).then(r => r.json());

before(() => {
  for (const d of [INSIDE, INSIDE2, OUTSIDE, LOOKALIKE, LATE_ROOT]) fs.mkdirSync(d, { recursive: true });
  // what a second device's Drive shows: the folder, with a library in it
  fs.mkdirSync(path.join(ADOPTED, "books", "The Bramblewick Bus"), { recursive: true });
  fs.writeFileSync(path.join(ADOPTED, "books", "The Bramblewick Bus", "page.txt"), "hello");
});
after(async () => {
  await stopHub();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("with the variable naming a root, the door takes a folder inside it", async () => {
  // trailing separator on purpose: a pasted path usually has one, and a root
  // that only matches when it is spelled without one is a seam that fails shut.
  await startHub({ ERA_DRIVE_LOCAL_ROOTS: ROOT + path.sep + path.delimiter + ROOT2 });

  const before = await driveStatus();
  assert.deepEqual(before.localRoots, [ROOT, ROOT2], "both named roots, delimiter-split, no trailing sep");
  assert.equal(before.signedIn, true, "a named root is a mount as far as the checklist is concerned");
  // …and it stays empty: both roots hold a BARE "New ERA Content", and
  // auto-adoption (below) only takes a folder with a library already in it. A
  // lookalike nobody has put anything in is not the family's content folder.
  assert.equal(before.folderPath, "", "nothing picked yet");

  const r = await pick(INSIDE);
  assert.equal(r.status, 204, "the folder inside the named root is accepted");
  assert.equal((await driveStatus()).folderPath, INSIDE, "and it is what the hub now mirrors");

  const r2 = await pick(INSIDE2);
  assert.equal(r2.status, 204, "the root after the delimiter counts too");
  assert.equal((await driveStatus()).folderPath, INSIDE2);
});

test("a folder outside every named root is still refused", async () => {
  for (const [what, p] of [["a plain sibling", OUTSIDE],
                           // "…/My Drive Backup" starts with "…/My Drive" as a
                           // string but is not inside it — a prefix is not a jail
                           ["a name-prefix lookalike", LOOKALIKE],
                           ["the parent of the root", TMP]]) {
    const r = await pick(p);
    assert.equal(r.status, 400, what + " is refused");
    assert.deepEqual(await r.json(), { error: "outside-drive" }, what + " says why");
  }
  assert.equal((await driveStatus()).folderPath, INSIDE2, "and the good pick is untouched");
});

test("with the variable unset nothing changes: every folder is outside the drive", async () => {
  await stopHub();
  await startHub({});   // exactly a family's hub on a box with no Drive mount

  const s = await driveStatus();
  assert.deepEqual(s.localRoots, [], "no mount, no roots");
  assert.equal(s.localInstalled, false);
  for (const p of [INSIDE, INSIDE2, OUTSIDE]) {
    const r = await pick(p);
    assert.equal(r.status, 400, p + " is outside-drive again");
    assert.deepEqual(await r.json(), { error: "outside-drive" });
  }
  assert.equal((await driveStatus()).folderPath, "", "nothing was ever picked");
});

// ------------------------------------------------------- the second device
//
// Home tablet, dad's fresh v0.33.1 install, 9/15: Drive for Desktop signed in,
// G:\My Drive\New ERA Content fully synced down with books/music/movies — and
// every app empty, because folderPath was only ever written by a tap in
// Settings and nobody taps it twice. Dad: "when I update the app it should just
// work". So a hub that finds the family's folder already sitting in the mount
// takes it, and says so in drive.json.
test("a hub that boots beside a folder another device made adopts it, with nobody at the keyboard", async () => {
  await stopHub();
  const data = await startHub({ ERA_DRIVE_LOCAL_ROOTS: ADOPT_ROOT });

  const s = await driveStatus();
  assert.equal(s.folderPath, ADOPTED, "the folder was found without a single tap");
  assert.equal(s.mode, "local");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, "drive.json"), "utf8")),
    { mode: "local", folderPath: ADOPTED }, "written down, so the next boot is not a search");

  // and it is a real mount, not just a string: the mirror runs from it.
  await fetch(`${BASE}/integrations/drive/sync`, { method: "POST" });
  assert.equal(fs.readFileSync(path.join(data, "books", "The Bramblewick Bus", "page.txt"), "utf8"),
    "hello", "the second device's shelf filled itself");
});

// Google Drive for Desktop signs in minutes after the hub boots (and on the
// tablet it was hours). Adoption that only ran at start() would leave that
// family exactly where the 9/15 one was until someone restarted the app.
test("a folder that turns up after boot is adopted on the next status paint, no restart", async () => {
  await stopHub();
  const data = await startHub({ ERA_DRIVE_LOCAL_ROOTS: LATE_ROOT });
  assert.equal((await driveStatus()).folderPath, "", "nothing to adopt yet: the mount is bare");

  fs.mkdirSync(path.join(LATE, "music"), { recursive: true });
  assert.equal((await driveStatus()).folderPath, LATE, "the very next paint finds it");
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, "drive.json"), "utf8")).folderPath, LATE);
});

// The seam is read on every call, not captured at require time: the Settings
// checklist re-reads detect() live, and a root that appeared after boot (or a
// test that sets the variable after loading the module) has to be seen.
test("the variable is read fresh on every call, never cached at load", () => {
  const drive = require("./drive.js");
  delete process.env.ERA_DRIVE_LOCAL_ROOTS;
  assert.deepEqual(drive.detectLocal().roots, [], "unset: the probes find nothing here");
  try {
    process.env.ERA_DRIVE_LOCAL_ROOTS = ROOT;
    assert.deepEqual(drive.detectLocal().roots, [ROOT], "set after load and still seen");
    process.env.ERA_DRIVE_LOCAL_ROOTS = path.join(TMP, "no-such-folder");
    assert.deepEqual(drive.detectLocal().roots, [], "a named root that is not a folder is not a root");
  } finally { delete process.env.ERA_DRIVE_LOCAL_ROOTS; }
  assert.deepEqual(drive.detectLocal().roots, [], "unset again: back to today's behaviour exactly");
});

// ------------------------------------------------ arming the ten-minute mirror
//
// start() was the ONLY place that armed the local mirror, and it arms it only
// when drive.json already names a folder. So the family that picked one (or
// tapped "✨ Create it for me") got the single sync the Settings page fires by
// hand and then nothing at all until the app was restarted — the quiet half of
// the 9/15 tablet report. Both doors arm it themselves now. timersArmed() is a
// probe, deliberately not an ERA_DRIVE_* timing seam: the delays a family's hub
// waits are not a thing a test should be able to move.
//
// Must run before anything else in this process arms them (the guard is
// once-per-process, as it has to be: start() is called again on every
// drive.json rewrite in the suites below).
test("picking a folder arms the ten-minute mirror there and then", () => {
  const drive = require("./drive.js");
  const data = fs.mkdtempSync(path.join(TMP, "arm-data-"));
  const folder = path.join(TMP, "Arm Drive", "New ERA Content");
  fs.mkdirSync(folder, { recursive: true });            // bare: nothing to adopt
  process.env.ERA_DRIVE_LOCAL_ROOTS = path.join(TMP, "Arm Drive");
  try {
    drive.start(data);
    assert.equal(drive.timersArmed(), false, "an unconfigured hub has no mirror to run");
    assert.deepEqual(drive.setLocalFolder(folder), { ok: true });
    assert.equal(drive.timersArmed(), true, "the pick armed it, with no restart");
  } finally { delete process.env.ERA_DRIVE_LOCAL_ROOTS; }
});

// Step 3's button read "Create your content folder … makes New ERA Content in
// your Drive", which is why dad stopped at it on the tablet: the folder was
// already there and the sentence sounded like it would make a duplicate. It
// never did — mkdirSync recursive is happy to find it — so the fix is the
// hub saying WHICH of the two things it just did, and Settings toasting that.
test("'create it for me' on a folder that is already there connects it instead of claiming to make it", () => {
  const drive = require("./drive.js");
  const data = fs.mkdtempSync(path.join(TMP, "made-data-"));
  const root = path.join(TMP, "Made Drive");
  fs.mkdirSync(root, { recursive: true });
  process.env.ERA_DRIVE_LOCAL_ROOTS = root;
  try {
    drive.start(data);
    const first = drive.createContentFolder();
    assert.equal(first.ok, true);
    assert.equal(first.folderPath, path.join(root, "New ERA Content"));
    assert.equal(first.existed, false, "nothing was there: the tap really did make it");
    const again = drive.createContentFolder();
    assert.equal(again.ok, true);
    assert.equal(again.existed, true, "…and a second tap connects what is already there");
  } finally { delete process.env.ERA_DRIVE_LOCAL_ROOTS; }
});

// server.js caches ONE clothing log at boot (the folder of the moment), and it
// is the one consumer that does not re-read drive.json live — so adoption has
// to tell it. Once, and never before drive.json is on disk: the hook's first
// act is drive.status(), and a hook that fired early would re-open the log on
// the folder the hub booted without.
test("adoption saves drive.json first, then tells server.js — exactly once", () => {
  const drive = require("./drive.js");
  const data = fs.mkdtempSync(path.join(TMP, "adopt-data-"));
  const root = path.join(TMP, "Adopt Drive");
  const folder = path.join(root, "New ERA Content");
  fs.mkdirSync(path.join(folder, "clothing"), { recursive: true });
  process.env.ERA_DRIVE_LOCAL_ROOTS = root;
  const seen = [];
  drive.onAdopted = (p) => seen.push([p, (() => {
    try { return JSON.parse(fs.readFileSync(path.join(data, "drive.json"), "utf8")).folderPath; }
    catch { return "no drive.json yet"; }
  })()]);
  try {
    drive.start(data);
    assert.equal(drive.status().folderPath, folder, "adopted at boot");
    assert.deepEqual(seen, [[folder, folder]], "told once, with drive.json already saved");
    drive.status(); drive.status();
    assert.equal(seen.length, 1, "a hub that has a folder never adopts again");
  } finally { drive.onAdopted = null; delete process.env.ERA_DRIVE_LOCAL_ROOTS; }
});

// ------------------------------------------------- shelving one finished book
//
// mirrorBook() is the hook server.js hangs off content.onPublished (F5): the
// book that has just been written into the family's Drive folder is copied
// straight onto the Reader's shelf instead of waiting for the ten-minute
// mirror. The hook has to be able to tell three answers apart, and until this
// it could not: `skipped` was BOTH the count of files that had not changed and
// the word "needs-local-drive", so a second publish — a repair, a re-read, the
// common case — came back {files:1, skipped:1} and the hub printed "is built
// but not shelved: 1" over a book that was on the shelf. `blocked` is the
// answer to "could this be shelved at all", and it never counts anything.
test("shelving one book: a re-publish is a success, and only a hub with no local Drive is blocked", () => {
  const drive = require("./drive.js");
  const data = fs.mkdtempSync(path.join(TMP, "shelf-data-"));
  const folder = fs.mkdtempSync(path.join(TMP, "shelf-drive-"));
  const src = path.join(folder, "books", "The Bramblewick Bus");
  fs.mkdirSync(path.join(src, "pages"), { recursive: true });
  fs.writeFileSync(path.join(src, "pages", "001.jpg"), Buffer.alloc(16, 3));
  fs.writeFileSync(path.join(src, "manifest.json"), JSON.stringify({ schemaVersion: 1, pages: [] }));

  // No local Drive folder yet: nothing to shelve FROM, and the hub has to say
  // so in a word no counter can ever be mistaken for.
  fs.writeFileSync(path.join(data, "drive.json"), JSON.stringify({ mode: "off" }));
  drive.start(data);
  const off = drive.mirrorBook("The Bramblewick Bus");
  assert.equal(off.blocked, "needs-local-drive");
  assert.equal(off.skipped, undefined, "'blocked' is a reason, never a count");

  fs.writeFileSync(path.join(data, "drive.json"),
                   JSON.stringify({ mode: "local", folderPath: folder }));
  drive.start(data);
  const first = drive.mirrorBook("The Bramblewick Bus");
  assert.equal(first.blocked, undefined, "a book that WAS shelved is not blocked");
  assert.equal(first.files, 2);
  assert.deepEqual(first.errors, []);
  assert.ok(fs.existsSync(path.join(data, "books", "The Bramblewick Bus", "manifest.json")));

  // The re-publish: only the manifest moved, so the photo is not copied again —
  // and the book is on the shelf just the same.
  fs.writeFileSync(path.join(src, "manifest.json"),
                   JSON.stringify({ schemaVersion: 1, pages: [], exportedAt: "2026-09-04T12:00:00.000Z" }));
  const again = drive.mirrorBook("The Bramblewick Bus");
  assert.equal(again.blocked, undefined, "an unchanged file is not a book that failed to shelve");
  assert.equal(again.files, 1, "the manifest, and nothing that had not changed");
  assert.equal(again.skipped, 1, "the count is still there — it is just not the reason");
  assert.deepEqual(again.errors, []);

  const unknown = drive.mirrorBook("No Such Book");
  assert.equal(unknown.error, "unknown book");
  assert.equal(unknown.blocked, undefined);
});
