// drive.js — Google Drive content integration (Settings > Integrations).
// A family (or Ellie's dad) connects a Google account with the DEVICE-CODE
// flow (no browser redirect dance: Settings shows "go to google.com/device,
// enter this code"), points at one Drive folder, and the hub mirrors that
// folder's known subfolders into the data dir on demand and every 6 hours:
//   <folder>/books/...  -> <DATA>/books/...   (book packages)
//   <folder>/music/...  -> <DATA>/music/...   (songs + manifest)
//   <folder>/movies/... -> <DATA>/movies/...  (catalog + posters)
//   <folder>/content/... -> <DATA>/content/... (lessons overrides)
//   <folder>/drawings/... -> <DATA>/drawings/... (Drawing's pictures; .local = made with no folder)
// Read-only Google scope (API mode uploads nothing). In local mode the one thing
// this mirror ever writes into the family's folder is a .local Drawing picture
// going up (uploadLocal). Config in <DATA>/drive.json:
//   { clientId, clientSecret, folderId, token:{...} } — clientId/secret come
// from the family's own Google Cloud OAuth client (Settings explains).
// The default family path is LOCAL mode, not that OAuth client — see the
// block above detectLocal(). There the folder need not be pointed at at all:
// adoptLocal() takes a "New ERA Content" a mount already holds, so the second
// device and every reinstall just work (dad 9/15).
// Test seams: ERA_DRIVE_OAUTH / ERA_DRIVE_API point at fake servers, and
// ERA_DRIVE_LOCAL_ROOTS names extra local mount roots (path.delimiter-
// separated) so the local-mode door is drivable off Windows — see detectLocal().
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OAUTH = process.env.ERA_DRIVE_OAUTH || "https://oauth2.googleapis.com";
const API = process.env.ERA_DRIVE_API || "https://www.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
// clothing: raw outfit photos staged for the wardrobe pipeline (dad 8/29 -
// created + mirrored now, processed by a later milestone)
// movies: added 9/4 - it was the one library that never mirrored, so a title a
// parent added lived on one device and vanished on the next reinstall.
// This ONE list is the mirror set: syncLocal(), sync()'s subfolder filter,
// createContentFolder()'s one-tap setup and the Settings checklist all walk it.
// drawings: added 9/30 - Drawing's pictures, made on any device and shown on every shelf (spec 2026-09-30 §4).
const MIRROR_SUBDIRS = ["books", "music", "movies", "content", "clothing", "drawings"];
// The name "✨ Create it for me" gives the family's folder — and, since 9/15,
// the name adoptLocal() goes looking for in a mount somebody else's computer
// already filled. One constant so the two can never drift.
const CONTENT_FOLDER = "New ERA Content";
// Rename spec (9/26): the software is Our Era Comms, but the family's Drive
// library is not split this release — creation keeps CONTENT_FOLDER, while
// adoption (and "create it for me" finding one already there) takes either
// name, the new one first, so renaming the folder inside Drive by hand later
// is a zero-code act.
const CONTENT_FOLDER_NAMES = ["Our Era Comms Content", CONTENT_FOLDER];

let DATA = null;
let pendingDevice = null;   // {device_code, user_code, verification_url, interval, expires}
let lastSync = null;        // {when, files, errors} | {when, error}
let syncing = false;

const cfgPath = () => path.join(DATA, "drive.json");
function loadCfg() { try { return JSON.parse(fs.readFileSync(cfgPath(), "utf8")); } catch { return {}; } }
function saveCfg(c) { fs.writeFileSync(cfgPath(), JSON.stringify(c, null, 2)); }

function status() {
  // Settings repaints this every 5 s and content.js/clothing.js read it on
  // every tick, which makes it the one place a folder that appears while the
  // app is running is noticed promptly. adoptLocal() returns on the first line
  // once drive.json names a folder, so an already-configured hub pays one more
  // read of that small file and nothing else; only an UNCONFIGURED one goes on
  // to stat a handful of candidate paths, and it stops doing that the moment it
  // finds one. Nothing is cached across calls — drive.json is the whole memory.
  adoptLocal();
  const c = loadCfg();
  const local = detectLocal();
  return {
    mode: c.mode || (c.token ? "api" : "local"),
    appInstalled: local.appInstalled,
    signedIn: local.signedIn,
    content: contentReady(),
    localInstalled: local.installed,
    localRoots: local.roots,
    folderPath: c.folderPath || "",
    configured: !!(c.clientId && c.clientSecret),
    connected: !!(c.token && c.token.refresh_token),
    folderId: c.folderId || "",
    pending: pendingDevice ? { user_code: pendingDevice.user_code,
                               verification_url: pendingDevice.verification_url } : null,
    lastSync,
    syncing,
  };
}

// Start the device-code flow; background-polls the token endpoint until the
// person finishes on their phone/laptop. Returns what Settings must display.
async function connect() {
  const c = loadCfg();
  if (!c.clientId || !c.clientSecret) return { error: "not-configured" };
  const r = await fetch(OAUTH + "/device/code", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, scope: SCOPE }),
  });
  if (!r.ok) return { error: "device-code-failed", code: r.status };
  const d = await r.json();
  pendingDevice = { ...d, expires: Date.now() + (d.expires_in || 600) * 1000 };
  pollToken(c, d);
  return { user_code: d.user_code, verification_url: d.verification_url || d.verification_uri };
}

function pollToken(c, d) {
  const iv = setInterval(async () => {
    if (!pendingDevice || Date.now() > pendingDevice.expires) { clearInterval(iv); pendingDevice = null; return; }
    try {
      const r = await fetch(OAUTH + "/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret,
          device_code: d.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      });
      const j = await r.json();
      if (j.access_token) {
        const cur = loadCfg();
        cur.token = { ...j, expiry: Date.now() + (j.expires_in || 3600) * 1000 };
        saveCfg(cur);
        clearInterval(iv); pendingDevice = null;
        console.log("[drive] connected");
      } else if (j.error && j.error !== "authorization_pending" && j.error !== "slow_down") {
        clearInterval(iv); pendingDevice = null;
        console.log("[drive] device flow ended: " + j.error);
      }
    } catch { /* transient; next tick */ }
  }, ((d.interval || 5) + 1) * 1000);
  iv.unref();
}

async function accessToken() {
  const c = loadCfg();
  if (!c.token) return null;
  if (c.token.expiry && Date.now() < c.token.expiry - 60000) return c.token.access_token;
  const r = await fetch(OAUTH + "/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret,
      refresh_token: c.token.refresh_token, grant_type: "refresh_token" }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  c.token = { ...c.token, ...j, expiry: Date.now() + (j.expires_in || 3600) * 1000 };
  saveCfg(c);
  return c.token.access_token;
}

async function listChildren(tok, folderId) {
  const out = []; let pageToken = "";
  do {
    const q = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, md5Checksum, size)",
      pageSize: "200", ...(pageToken ? { pageToken } : {}),
    });
    const r = await fetch(API + "/drive/v3/files?" + q, { headers: { Authorization: "Bearer " + tok } });
    if (!r.ok) throw new Error("list " + r.status);
    const j = await r.json();
    out.push(...(j.files || []));
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

// Which libraries are a TRUE mirror — a file deleted in Drive is deleted here
// too. clothing/ must be (dad 9/2: "delete clothes that no longer fit … all
// that should just work"): a garment that stays on disk stays in the outfits.
// books/music/movies join it 9/4, now that the Drive folder is where those are
// BUILT and not just dropped: the shelf a parent tidies has to be the shelf the
// tablet shows, or it only ever grows. content/ stays copy-only — it is lesson
// overrides layered on what ships in the box, not a library.
// Four safety rules keep this from eating anything: an absent source folder
// prunes nothing (syncLocal, and a failed listing throws before the prune in
// sync()), dotfiles are never pruned (pruneTree — that is what keeps a
// package's .build/ claim alive mid-build), only a listing that SUCCEEDED may
// prune, and — the one the 9/4 audit added — a mirror may only delete what a
// MIRROR PUT THERE (the ledger below).
// drawings joins 9/30: a parent deleting a picture folder in Drive removes it everywhere (spec 2026-09-30 §4).
const MIRROR_DELETES = ["clothing", "books", "music", "movies", "drawings"];

// PROVENANCE LEDGER. <DATA>/<sub>/.mirrored.json lists, one relative path per
// entry, the files this mirror has actually mirrored into that library. It is a
// dotfile, so pruneTree never touches it.
//
// Why it exists: "✨ Create it for me" makes five EMPTY subfolders in the Drive
// folder and Settings syncs the moment it returns. Without a ledger, an empty
// source read as "the parent deleted everything" would take the 8 book
// packages, the songs and the movie catalog a family had BEFORE they ever
// pointed the hub at Drive — none of which the mirror put there. (Skipping the
// prune for an empty source is NOT enough on its own and is wrong besides: dad
// 9/2's clothing rule means an emptied wardrobe folder really does empty the
// wardrobe. The rule is provenance, not emptiness.)
//
// So: a path in the ledger is the mirror's to delete when it leaves the source;
// a path that is not is the family's, and stays. The first sync after an
// upgrade finds no ledger, prunes nothing, and adopts what the source holds.
const LEDGER_NAME = ".mirrored.json";
// The one library that gets a ledger for free the first time. clothing has been
// a TRUE mirror since 9/2, so everything under <DATA>/clothing arrived through
// this mirror: starting its ledger empty would make a photo deleted in Drive
// while the hub was down an orphan forever. books/music/movies get no such
// adoption — that content predates the mirror by weeks.
// drawings (spec 2026-09-30 §4): everything under <DATA>/drawings arrived through this mirror or is
// this device's own .local work (never pruned, see LOCAL_MARKER), so the ledger may own it from day one.
const ADOPT_ON_FIRST_SYNC = ["clothing", "drawings"];
const relKey = (base, abs) => path.relative(base, abs).split(path.sep).join("/");
function loadLedger(dest, sub) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dest, LEDGER_NAME), "utf8"));
    if (Array.isArray(j)) return new Set(j);
  } catch { /* no ledger yet: fall through to adoption */ }
  return ADOPT_ON_FIRST_SYNC.includes(sub) ? listTree(dest) : new Set();
}
// Every non-dot file under dir, as relative "/"-joined paths.
function listTree(dir, rel = "", out = new Set()) {
  let ents = [];
  try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) { if (!hasLocalMarker(path.join(dir, r))) listTree(dir, r, out); }
    else if (e.isFile()) out.add(r);
  }
  return out;
}
function saveLedger(dest, rels) {
  try {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, LEDGER_NAME), JSON.stringify([...rels].sort()));
  } catch { /* read-only data dir: worst case we adopt again next sync */ }
}
// A folder holding LOCAL_MARKER is this device's own work made while it had no Drive folder
// (drawings.js rule 3). It is never the mirror's to judge: listTree skips it (so adoption never
// claims it) and pruneTree never enters it (so a ledger that somehow names it cannot delete it).
// syncLocal copies it UP first (uploadLocal) and only a folder that went up whole loses the marker.
const LOCAL_MARKER = ".local";
const UPLOAD_LOCAL = ["drawings"];
function hasLocalMarker(dir) {
  try { return fs.statSync(path.join(dir, LOCAL_MARKER)).isFile(); } catch { return false; }
}

// Remove from dest what the source no longer has. keep(rel, isDir) says whether
// that relative path may stay. Dotfiles are left alone (Drive/macOS droppings,
// plus our own .build/ claim, never ours to judge); an emptied album folder goes
// with its last photo. Callers only prune when the source listing SUCCEEDED —
// an offline Drive is not an empty one.
function pruneTree(dest, keep, stats, rel = "") {
  let ents = [];
  try { ents = fs.readdirSync(path.join(dest, rel), { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? rel + "/" + e.name : e.name;
    const abs = path.join(dest, r);
    if (e.isDirectory()) {
      if (hasLocalMarker(abs)) continue;          // this device's own work, never the mirror's (LOCAL_MARKER)
      pruneTree(dest, keep, stats, r);
      try {
        const left = fs.readdirSync(abs);
        if (!left.length) fs.rmdirSync(abs);
        // The source dropped this folder and the prune took everything the
        // mirror owned in it; what is left is only our own scratch (.build/,
        // which pruneTree skips). Left alone it lives forever and keeps holding
        // the package's slug — so take it wholesale. Never when something of
        // the family's survived the prune: that is a library, not a leftover.
        else if (!keep(r, true) && left.every(n => n.startsWith(".")))
          fs.rmSync(abs, { recursive: true, force: true });
      } catch {}
    } else if (e.isFile() && !keep(r, false)) {
      try { fs.rmSync(abs); stats.removed++; } catch (err) { stats.errors.push(e.name + ": " + err.message); }
    }
  }
}

// A manifest is a package's "I am ready" signal: the reader opens the book the
// moment manifest.json lands. Listed in readdir/Drive order it can arrive
// before the pages it names, and the device shows a half-mirrored book. So in
// every directory the manifests go LAST — after that directory's files AND its
// subfolders. One rule, used by both mirrors, so they cannot drift apart.
const MANIFEST_NAMES = ["manifest.json", "catalog.json"];
function manifestsLast(entries) {
  const rest = [], last = [];
  for (const e of entries) (MANIFEST_NAMES.includes(String(e.name).toLowerCase()) ? last : rest).push(e);
  return rest.concat(last);
}

// TWO QUESTIONS, TWO LISTS. One constant used to answer both and they are not
// the same question: "does this file go last" (the ready signal, above) and
// "is this file compared by its BYTES rather than its length" (the skip below).
// job.json is the second without being the first. It is the build claim and the
// anti-rebuild latch, and every line of it — a heartbeat a minute later, `state`
// going from building to done — is the same number of characters as the line
// before, so under a size-equal skip the news never leaves the computer that
// wrote it and two devices disagree about who owns a book. It must NOT wait for
// the end of its directory though: the sooner the other computers can read the
// claim, the smaller the window in which two of them build the same pile.
// scene.json (Drawing): a sticker swapped for one with an id of the same length ("horse" -> "house")
// or a moved sticker is a same-size rewrite; under the size skip the other devices would never see it.
const BYTE_COMPARE = MANIFEST_NAMES.concat(["job.json", "scene.json"]);
const byteCompared = (name) => BYTE_COMPARE.includes(String(name).toLowerCase());
const md5 = (p) => crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex");

// THE READY SIGNAL WAITS FOR THE BOOK. manifestsLast settles the order WE copy
// in; it cannot settle the order Drive desktop downloads in. The weekly book is
// assembled somewhere else and uploaded manifest-last, and the family's Drive
// folder still shows us that manifest with half the pages on their way — so
// before manifest.json is copied, every file it names must be here with bytes
// in it. Otherwise it is left where it is and the next pass (ten minutes) picks
// it up: the shelf shows the book whole or not at all, and a book that opens on
// a missing picture is the thing she remembers.
//
// Only manifest.json, and only the keys the hub's own publisher writes (`cover`
// and each page's `image`/`audio`/`video`, content-publish.js:133-157).
// catalog.json is a movie list and a music manifest names songs — neither is a
// package whose parts can arrive after it. And "there is a file with that name"
// is not the question: Drive lands a big mp4 as a zero-length placeholder
// first, so it is bytes, exactly as `present()` asks on the publishing side.
// A manifest we cannot even parse is mid-write by definition and waits too.
// (API mode's mirrorDir has no such guard: the maker delivers into the family's
// Drive FOLDER, which is local mode. An API-mode hub keeps today's behaviour.)
const BOOK_MANIFEST = "manifest.json";
const isBookManifest = (name) => String(name).toLowerCase() === BOOK_MANIFEST;
function missingFrom(bookDir) {
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(bookDir, BOOK_MANIFEST), "utf8")); }
  catch { return BOOK_MANIFEST; }              // half-written: not a signal yet
  if (!m || typeof m !== "object") return "";
  const named = [];
  if (typeof m.cover === "string") named.push(m.cover);
  if (Array.isArray(m.pages)) for (const p of m.pages) {
    if (!p || typeof p !== "object") continue;
    for (const k of ["image", "audio", "video"]) if (typeof p[k] === "string") named.push(p[k]);
  }
  for (const rel of named) {
    if (!rel) continue;
    try { if (fs.statSync(path.join(bookDir, rel)).size > 0) continue; } catch {}
    return rel;
  }
  return "";
}
// Once per book, not once per pass: the mirror runs every ten minutes, a big
// upload can span several of them, and a log that repeats itself is a log
// nobody reads. The book is forgotten the moment it is shelved, so a re-drop
// that goes incomplete again says so again.
const waitingBooks = new Set();
function noteWaiting(bookDir, missing) {
  if (waitingBooks.has(bookDir)) return;
  waitingBooks.add(bookDir);
  console.log("[drive] " + path.basename(bookDir) + ": manifest.json names " + missing +
              ", which is not here yet - leaving the book off the shelf until it is");
}

// The family's shared clothing log (clothing-log.js, spec §5) lives at
// <folder>/clothing/.era/**. Like a manifest, it must be compared by CONTENT,
// not by byte count: the migration tool rewrites tags/studio.jsonl wholesale
// and a device's own re-run can land a file of exactly the same length, which
// the size-equal skip below would never copy (W9). Two devices would then
// disagree about the family's taste for ever, silently. It is also a DOT
// entry, so pruneTree never touches it — a log line is nobody's to delete.
const SHARED_LOG_DIR = ".era";
const inSharedLog = (p) => String(p).split(path.sep).includes(SHARED_LOG_DIR);

// Write through a .part sibling, then rename. copyFileSync/writeFileSync
// truncate the destination and only then fill it, so a shelf load or a reader
// fetch that lands mid-copy reads half a manifest — the very failure the
// manifests-LAST ordering exists to prevent. A rename inside one directory is
// atomic on NTFS and ext4 alike. (.part is in no serve allowlist; a crash
// mid-copy leaves one behind and the next sync overwrites it.)
function atomically(dest, write) {
  const tmp = dest + ".part";
  try { write(tmp); fs.renameSync(tmp, dest); }
  catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}

async function mirrorDir(tok, folderId, destDir, stats, have) {
  fs.mkdirSync(destDir, { recursive: true });
  have.dirs.add(destDir);
  for (const f of manifestsLast(await listChildren(tok, folderId))) {
    const safe = f.name.replace(/[\\/:*?"<>|]/g, "_");
    const dest = path.join(destDir, safe);
    if (f.mimeType === "application/vnd.google-apps.folder") {
      await mirrorDir(tok, f.id, dest, stats, have);
      continue;
    }
    if (f.mimeType.startsWith("application/vnd.google-apps")) continue; // native docs: skip
    have.files.add(dest);   // still in Drive (even if this download fails) -> never pruned
    try {
      // A re-publish that only bumps exportedAt does not change the manifest's
      // LENGTH (an ISO stamp is always the same size), so the size-equal skip
      // would keep the old one forever — and exportedAt is exactly the reader's
      // cache-bust key. Manifests compare by checksum instead; everything else
      // is content-addressed enough by size. (job.json rides the same rail —
      // BYTE_COMPARE — for the same reason: a same-length rewrite of the latch.)
      if (fs.existsSync(dest) && ((byteCompared(safe) || inSharedLog(dest))
            ? (f.md5Checksum && md5(dest) === f.md5Checksum)
            : (f.size && fs.statSync(dest).size === Number(f.size)))) { stats.skipped++; continue; }
      const r = await fetch(API + "/drive/v3/files/" + f.id + "?alt=media",
        { headers: { Authorization: "Bearer " + tok } });
      if (!r.ok) throw new Error("download " + r.status);
      const body = Buffer.from(await r.arrayBuffer());
      atomically(dest, (tmp) => fs.writeFileSync(tmp, body));
      stats.files++;
    } catch (e) { stats.errors.push(safe + ": " + e.message); }
  }
}

// Mirror the configured folder's known subfolders into DATA. Copy-only,
// except MIRROR_DELETES, which follow deletions too.
async function sync() {
  if (syncing) return { error: "busy" };
  const c = loadCfg();
  if (c.mode === "local" && c.folderPath) {
    syncing = true;
    try { return syncLocal(c); } finally { syncing = false; }
  }
  if (!c.folderId) return { error: "no-folder" };
  const tok = await accessToken();
  if (!tok) return { error: "not-connected" };
  syncing = true;
  const stats = { files: 0, skipped: 0, removed: 0, errors: [] };
  try {
    const top = await listChildren(tok, c.folderId);
    for (const f of top) {
      if (f.mimeType !== "application/vnd.google-apps.folder") continue;
      const name = f.name.toLowerCase();
      if (!MIRROR_SUBDIRS.includes(name)) continue;
      const dest = path.join(DATA, name);
      const have = { files: new Set(), dirs: new Set() };   // absolute dest paths still in Drive
      await mirrorDir(tok, f.id, dest, stats, have);   // a listing failure throws -> no prune below
      if (!MIRROR_DELETES.includes(name)) continue;
      const owned = loadLedger(dest, name);
      pruneTree(dest, (r, isDir) => {
        const abs = path.join(dest, r);
        return isDir ? have.dirs.has(abs) : (have.files.has(abs) || !owned.has(r));
      }, stats);
      saveLedger(dest, [...have.files].map(a => relKey(dest, a)));
    }
    lastSync = { when: new Date().toISOString(), ...stats };
    if (module.exports.onSynced) try { module.exports.onSynced(lastSync); } catch {}
    return lastSync;
  } catch (e) {
    lastSync = { when: new Date().toISOString(), error: String(e.message) };
    return lastSync;
  } finally { syncing = false; }
}

// ---- LOCAL MODE (the default family path, dad 8/29): Google Drive for
// Windows makes the person's Drive a local folder — Google's own app does
// login and syncing, we just read files. detect() finds the mount; the folder
// inside it is either ADOPTED (adoptLocal, below — the second device and every
// reinstall) or picked/made by hand in Settings; sync() copies its
// books/music/content subfolders into the data dir. No OAuth client needed
// anywhere.
function detectLocal() {
  const os = require("os");
  // the Drive app can be installed but not yet signed in (no mount yet) —
  // the Settings checklist shows those as two separate live checks
  let appInstalled = false;
  for (const p of ["C:\\Program Files\\Google\\Drive File Stream",
                   "C:\\Program Files (x86)\\Google\\Drive File Stream"]) {
    // an uninstall leaves locked leftovers until reboot — only a version dir
    // that still holds GoogleDriveFS.exe counts as installed
    try {
      for (const d of fs.readdirSync(p)) {
        if (fs.existsSync(path.join(p, d, "GoogleDriveFS.exe"))) appInstalled = true;
      }
    } catch {}
  }
  const roots = [];
  for (let c = 68; c <= 90; c++) {              // D:..Z:
    const p = String.fromCharCode(c) + ":\\My Drive";
    try { if (fs.statSync(p).isDirectory()) roots.push(p); } catch {}
  }
  for (const p of [path.join(os.homedir(), "Google Drive"),
                   path.join(os.homedir(), "Google Drive", "My Drive")]) {
    try { if (fs.statSync(p).isDirectory()) roots.push(p); } catch {}
  }
  // Test seam, in the shape ERA_DRIVE_OAUTH / ERA_DRIVE_API already have
  // (header): extra mount roots, path.delimiter-separated, read FRESH on every
  // call — the Settings checklist re-reads detect() live, so a root that turns
  // up after boot has to be seen. Both probes above are Windows-and-a-real-
  // Drive-app only, so off Windows the roots list was empty, browseLocal()
  // jailed against nothing, and POST /integrations/drive/localfolder answered
  // 400 outside-drive for EVERY path: on the QA box (and in CI) the whole book
  // pipeline was unreachable through its own door, the one a family uses. This
  // is a seam, not a loosened jail — unset, a family's hub behaves exactly as
  // it does today, and set, the jail still admits only what the variable names.
  for (const raw of String(process.env.ERA_DRIVE_LOCAL_ROOTS || "").split(path.delimiter)) {
    if (!raw) continue;
    // A pasted path usually carries a trailing separator, and normalize() keeps
    // it — browseLocal() compares against a normalize()d pick with none, so
    // "…/My Drive/" would match nothing at all. Fail open-eyed, not shut.
    // (a drive/filesystem root IS its separator — "C:\" and "/" keep theirs)
    let n = path.normalize(raw);
    const stem = path.parse(n).root;
    while (n.length > stem.length && (n.endsWith(path.sep) || n.endsWith("/"))) n = n.slice(0, -1);
    try { if (fs.statSync(n).isDirectory() && !roots.includes(n)) roots.push(n); } catch {}
  }
  return { installed: roots.length > 0, appInstalled: appInstalled || roots.length > 0,
           signedIn: roots.length > 0, roots };
}

// Deep link: open Explorer at the mount root (create your folder there) or
// at the chosen content folder (drop books/music in). Windows only.
function openInExplorer(target) {
  const c = loadCfg();
  const { roots } = detectLocal();
  const p = target === "folder" && c.folderPath ? c.folderPath : roots[0];
  if (!p) return { error: "nothing-to-open" };
  if (process.platform === "win32") {
    const { spawn } = require("child_process");
    spawn("explorer.exe", [p], { detached: true, stdio: "ignore" }).unref();
  }
  return { ok: true, opened: p };
}

// Live content check for the checklist: which known subfolders of the chosen
// folder actually have something in them.
function contentReady() {
  const c = loadCfg();
  const out = {};
  for (const sub of MIRROR_SUBDIRS) {
    out[sub] = false;
    if (!c.folderPath) continue;
    // Dot entries do not count as content (I20): clothing/.era is the hub's
    // OWN shared log, and a family with no photos at all would otherwise see
    // the checklist tick "clothing" the moment their first Yes wrote a line.
    try { out[sub] = fs.readdirSync(path.join(c.folderPath, sub)).some(n => !n.startsWith(".")); } catch {}
  }
  return out;
}

function browseLocal(dir) {
  const { roots } = detectLocal();
  const norm = path.normalize(dir || "");
  if (!roots.some(r => norm === r || norm.startsWith(r + path.sep)))
    return { error: "outside-drive" };
  try {
    const dirs = fs.readdirSync(norm, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith("."))
      .map(d => d.name).slice(0, 200);
    return { path: norm, dirs };
  } catch (e) { return { error: String(e.message) }; }
}

// ARMING THE MIRROR. start() used to be the only place the local timers were
// set, and it sets them only when drive.json ALREADY names a folder — so a
// family that picked one (or tapped "✨ Create it for me") got the single sync
// the Settings page fires by hand and then nothing until the app was next
// restarted. Books finished on the other computer, songs a parent uploaded
// from their phone: none of it arrived, and no screen said why. Every door that
// can set folderPath calls this now.
//
// Once per process, because those doors can be walked more than once (pick a
// folder, change your mind, pick another) and each walk would otherwise leave
// another ten-minute timer behind, syncing the same folder N times an hour.
// The timers read drive.json at fire time, so one pair covers every folder the
// hub is ever pointed at. Unref'd: the suites spawn hubs and SIGKILL them, and
// a live handle is a hub that will not exit on its own.
let localArmed = false;
function armLocal() {
  if (localArmed) return false;
  localArmed = true;
  setTimeout(() => { sync(); }, 60 * 1000).unref();
  setInterval(() => { sync(); }, 10 * 60 * 1000).unref();  // local copy: cheap, keep it fresh
  return true;
}
// Exported probe, not an ERA_DRIVE_* timing seam: a test needs to know the
// mirror was armed, and how long a family's hub waits between passes is not a
// thing a test should be able to move.
const timersArmed = () => localArmed;

// ADOPTION (dad 9/15, home tablet, fresh v0.33.1 install): Drive for Desktop
// signed in, G:\My Drive\New ERA Content fully synced down with books, music
// and movies in it — and every app on the tablet empty, because folderPath is
// written by a tap in Settings and this was the family's SECOND device. Dad:
// "Please fix and then when I update the app it should just work."
//
// So: no folder of our own and nobody else's OAuth in play, and one of the
// mounts holds a "New ERA Content" with a library already inside it — take it.
//
// A KNOWN SUBFOLDER IS REQUIRED, not just the name. A bare folder of that name
// is somebody's empty lookalike, or the one this hub is about to create, and
// silently mirroring an empty source is how a prune eats a shelf (see the
// provenance ledger above). One directory from MIRROR_SUBDIRS is the family
// saying "this is the one".
//
// Skipped for a hub that is on, or is being put on, the API: mode "api" is a
// device-code flow half finished, and flipping it to local under the person
// would be the app undoing what they are in the middle of doing.
function adoptLocal() {
  if (!DATA) return null;                       // before start(): no drive.json to write
  const c = loadCfg();
  if (c.folderPath || c.token || c.mode === "api") return null;
  for (const root of detectLocal().roots) {
    // per root, the first name whose folder already holds a library wins
    const base = CONTENT_FOLDER_NAMES.map(n => path.join(root, n)).find(b => MIRROR_SUBDIRS.some(sub => {
      try { return fs.statSync(path.join(b, sub)).isDirectory(); } catch { return false; }
    }));
    if (!base) continue;
    c.mode = "local"; c.folderPath = base;
    saveCfg(c);                                 // on disk BEFORE anyone is told
    console.log("[drive] adopted " + base);
    armLocal();
    // server.js hangs openClothingLog() here: its clothing log is the one
    // consumer that caches the folder instead of re-reading drive.json, so
    // without this the picks made between now and the next restart would be
    // shared with nobody, silently (the same bug review r1 found on the
    // create-folder door).
    if (module.exports.onAdopted) try { module.exports.onAdopted(base); } catch {}
    return base;
  }
  return null;
}

function setLocalFolder(p) {
  const check = browseLocal(p);
  if (check.error) return check;
  const c = loadCfg();
  c.mode = "local"; c.folderPath = path.normalize(p);
  saveCfg(c);
  armLocal();     // Settings fires one sync; this is every pass after it
  return { ok: true };
}

// have = {files, dirs}: the relative paths the SOURCE holds right now. It is
// what the prune keeps and what the ledger records — one walk, no re-statting.
function copyTreeLocal(src, dest, stats, have, rel = "") {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of manifestsLast(fs.readdirSync(src, { withFileTypes: true }))) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    const r = rel ? rel + "/" + e.name : e.name;
    try {
      if (e.isDirectory()) { have.dirs.add(r); copyTreeLocal(s, d, stats, have, r); continue; }
      if (!e.isFile()) continue;
      // In have.files BEFORE the wait below, and that order is load-bearing:
      // have.files is what the prune keeps, so a manifest we are declining to
      // copy this pass must still read as "the source has it". Left out, a
      // re-drop that is halfway uploaded would look like a parent deleting the
      // manifest and the book she is reading would leave the shelf.
      have.files.add(r);
      if (isBookManifest(e.name)) {
        const missing = missingFrom(src);           // see the block on missingFrom
        if (missing) { noteWaiting(src, missing); continue; }
        waitingBooks.delete(src);                   // whole again
      }
      // Manifests compare by BYTES, not size: a re-publish that only bumps
      // exportedAt keeps the same length, and exportedAt is the reader's
      // cache-bust key — size-equal would strand every fix on the one device.
      // The clothing log under .era/ is compared the same way, for the same
      // reason (W9 — a wholesale rewrite of the same length), and job.json for
      // its own (BYTE_COMPARE).
      if (fs.existsSync(d) && ((byteCompared(e.name) || inSharedLog(d))
            ? fs.readFileSync(d).equals(fs.readFileSync(s))
            : fs.statSync(d).size === fs.statSync(s).size)) { stats.skipped++; continue; }
      atomically(d, (tmp) => fs.copyFileSync(s, tmp));
      stats.files++;
    } catch (err) { stats.errors.push(e.name + ": " + err.message); }
  }
}

function syncLocal(cfg) {
  const stats = { files: 0, skipped: 0, removed: 0, errors: [] };
  let mounted = false;
  try { mounted = fs.statSync(cfg.folderPath).isDirectory(); } catch {}
  for (const sub of MIRROR_SUBDIRS) {
    // .local work goes UP before anything comes down or is pruned (spec §4 rule 3). Never when the
    // family folder itself is missing: an offline mount is not an empty one, and the family folder
    // is never ours to create.
    if (mounted && UPLOAD_LOCAL.includes(sub)) uploadLocal(cfg.folderPath, sub, stats);
    const src = path.join(cfg.folderPath, sub);
    try { if (!fs.statSync(src).isDirectory()) continue; } catch { continue; }   // absent/offline: leave ours alone
    const dest = path.join(DATA, sub);
    const have = { files: new Set(), dirs: new Set() };
    copyTreeLocal(src, dest, stats, have);
    if (!MIRROR_DELETES.includes(sub)) continue;
    const owned = loadLedger(dest, sub);
    pruneTree(dest, (r, isDir) =>
      isDir ? have.dirs.has(r) : (have.files.has(r) || !owned.has(r)), stats);
    saveLedger(dest, have.files);
  }
  lastSync = { when: new Date().toISOString(), ...stats };
  if (module.exports.onSynced) try { module.exports.onSynced(lastSync); } catch {}
  return lastSync;
}

// mirrorBook(name) — ONE finished book, from the family's Drive folder onto the
// Reader's shelf, right now (F5, 9/4).
//
// The book builder works IN PLACE inside <folderPath>/books/<Title> because
// that is what Google Drive for Windows uploads to the family's other devices
// (content.js's first law). The Reader, though, serves <DATA>/books — so until
// this existed the ONLY thing that carried a finished package across was the
// ten-minute mirror above, or a parent's hand on "Sync now": the Settings card
// said "finished" and the shelf did not change for up to ten minutes.
//
// WHY NOT JUST CALL sync(). Because sync() ends in onSynced, and the fan-out
// server.js hangs there starts clothing.regenerate(true) — a vision spend, on
// every book publish, for photos nobody touched. This is the narrow version of
// the same copy: one book folder, no prune, no onSynced, nothing else read.
//
// The ledger still learns about the files (a book mirrored this way is the
// mirror's to take away again when the parent deletes the folder in Drive);
// everything else is copyTreeLocal's, manifest LAST and .part-atomic included.
// Returns {book, files, skipped, removed, errors} or {error}/{blocked:"…"}.
//
// `blocked` is a WORD and `skipped` is a COUNT, and they are separate keys
// because one key meant both for a day: `skipped` is the number of files that
// had not changed and did not need re-copying, so on the second publish of a
// book (a repair, a re-read — the common case) the caller read the count as the
// reason and printed "is built but not shelved: 1" over a book sitting happily
// on the shelf. Anything that stops the copy from being possible at all says so
// in `blocked`; anything that went wrong inside it is in `errors`.
function mirrorBook(name) {
  if (!DATA) return { error: "not-started" };
  const c = loadCfg();
  if (c.mode !== "local" || !c.folderPath) return { blocked: "needs-local-drive" };
  // A NAME, never a path: this walks a folder inside the family's Drive and
  // writes into the data dir, and the caller is a hook two modules away.
  const safe = path.basename(String(name || ""));
  if (!safe || safe === "." || safe === "..") return { error: "unknown book" };
  const src = path.join(c.folderPath, "books", safe);
  try { if (!fs.statSync(src).isDirectory()) return { error: "unknown book" }; }
  catch { return { error: "unknown book" }; }
  const dest = path.join(DATA, "books", safe);
  const stats = { files: 0, skipped: 0, removed: 0, errors: [] };
  const have = { files: new Set(), dirs: new Set() };
  copyTreeLocal(src, dest, stats, have);
  // The ledger is kept for the whole books library, so this book's paths go in
  // under its folder name. Merged, never replaced: the other books on the shelf
  // are still the mirror's.
  const lib = path.join(DATA, "books");
  const owned = loadLedger(lib, "books");
  for (const r of have.files) owned.add(safe + "/" + r);
  saveLedger(lib, owned);
  return { book: safe, ...stats };
}

// uploadLocal — carry every LOCAL_MARKER folder of <DATA>/<sub> up to <folderPath>/<sub>/<name>.
// Files only (a picture folder has no subfolders), never dotfiles and never a .part leftover, each
// .part-atomic. Creating <folderPath>/<sub> is allowed here (spec §4 rule 2: nothing family-only
// lives under <DATA>/drawings, so an empty source can only ever remove mirror-owned copies).
function uploadLocal(folderPath, sub, stats) {
  const root = path.join(DATA, sub);
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const from = path.join(root, e.name);
    if (!hasLocalMarker(from)) continue;
    const to = path.join(folderPath, sub, e.name);
    let ok = true;
    try {
      fs.mkdirSync(to, { recursive: true });
      for (const f of fs.readdirSync(from, { withFileTypes: true })) {
        if (!f.isFile() || f.name.startsWith(".") || f.name.endsWith(".part")) continue;
        atomically(path.join(to, f.name), (tmp) => fs.copyFileSync(path.join(from, f.name), tmp));
        stats.files++;
      }
    } catch (err) { ok = false; stats.errors.push(e.name + " (up): " + err.message); }
    if (ok) { try { fs.rmSync(path.join(from, LOCAL_MARKER)); } catch {} }
  }
}

// mirrorDrawing(id) — ONE picture from the family's Drive folder onto this device's shelf, now
// (the mirrorBook shape, spec §4): an own write lands in <folderPath>/drawings/<id>, and without
// this the shelf would wait up to ten minutes for it. One folder, copyTreeLocal (.part-atomic,
// scene.json byte-compared), ledger MERGED, no prune, no onSynced.
function mirrorDrawing(id) {
  if (!DATA) return { error: "not-started" };
  const c = loadCfg();
  if (c.mode !== "local" || !c.folderPath) return { blocked: "needs-local-drive" };
  const safe = path.basename(String(id || ""));          // a NAME, never a path
  if (!safe || safe.startsWith(".")) return { error: "unknown picture" };
  const src = path.join(c.folderPath, "drawings", safe);
  try { if (!fs.statSync(src).isDirectory()) return { error: "unknown picture" }; }
  catch { return { error: "unknown picture" }; }
  const dest = path.join(DATA, "drawings", safe);
  const stats = { files: 0, skipped: 0, removed: 0, errors: [] };
  const have = { files: new Set(), dirs: new Set() };
  copyTreeLocal(src, dest, stats, have);
  const lib = path.join(DATA, "drawings");
  const owned = loadLedger(lib, "drawings");
  for (const r of have.files) owned.add(safe + "/" + r);
  saveLedger(lib, owned);
  return { picture: safe, ...stats };
}

// Folders the person can pick in Settings (no ID pasting): own + shared,
// top 100 by name. The picker is the babysat step dad asked for.
async function listFolders() {
  const tok = await accessToken();
  if (!tok) return { error: "not-connected" };
  const q = new URLSearchParams({
    q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: "files(id, name)", pageSize: "100", orderBy: "name",
  });
  const r = await fetch(API + "/drive/v3/files?" + q, { headers: { Authorization: "Bearer " + tok } });
  if (!r.ok) return { error: "list-failed", code: r.status };
  const j = await r.json();
  return { folders: (j.files || []).map(f => ({ id: f.id, name: f.name })) };
}

// One-click setup (dad 8/29: "run a job to add the folder - smarter"): the
// mount is a real folder, so we create New ERA Content + one subfolder per
// program right in it; the Drive app syncs it up. Also selects it.
//
// `existed` is for the SENTENCE Settings says, not for the work: mkdirSync
// recursive has always been happy to find the folder already there, and
// adoptLocal takes that case before anyone taps. But dad stopped at step 3 on
// the tablet 9/15 because the button read "makes New ERA Content in your
// Drive" over a Drive that already had one, and that sounds like a duplicate.
// So the hub says which of the two things it did and the toast follows.
function createContentFolder() {
  const { roots } = detectLocal();
  if (!roots.length) return { error: "no-mount" };
  // an existing folder under either name beats creating a second one beside it
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const found = CONTENT_FOLDER_NAMES.map(n => path.join(roots[0], n)).find(isDir);
  const base = found || path.join(roots[0], CONTENT_FOLDER);
  const existed = !!found;
  try {
    for (const sub of MIRROR_SUBDIRS) fs.mkdirSync(path.join(base, sub), { recursive: true });
  } catch (e) { return { error: String(e.message) }; }
  const c = loadCfg();
  c.mode = "local"; c.folderPath = base;
  saveCfg(c);
  armLocal();     // as with setLocalFolder: Settings' one sync is not a mirror
  return { ok: true, folderPath: base, existed };
}

function setFolder(folderId) {
  const c = loadCfg();
  c.folderId = String(folderId || "").trim();
  saveCfg(c);
}

function start(dataDir) {
  DATA = dataDir;
  adoptLocal();          // a folder another device already made (9/15) — arms too
  const c = loadCfg();
  if (c.mode === "local" && c.folderPath) {
    armLocal();
  } else if (c.token && c.folderId) {
    setTimeout(() => { sync(); }, 2 * 60 * 1000).unref();
    setInterval(() => { sync(); }, 6 * 60 * 60 * 1000).unref();
  } else {
    // Nothing configured yet. Google Drive for Desktop signs in minutes after
    // the hub boots — on the 9/15 tablet the mount was not there at first boot
    // at all — and a hub that only looked at start() would sit empty until
    // somebody restarted the app. Settings' own paint calls status() (which
    // adopts) every 5 s, but nobody is standing at Settings; this is the poll
    // for the tablet propped on a kitchen counter. It clears itself the moment
    // it finds the folder, so an adopted hub runs no timer it does not need.
    const iv = setInterval(() => { if (adoptLocal()) clearInterval(iv); }, 60 * 1000);
    iv.unref();
  }
}

module.exports = { start, status, connect, sync, mirrorBook, mirrorDrawing, atomically, LOCAL_MARKER, setFolder, listFolders, detectLocal, browseLocal, setLocalFolder, openInExplorer, createContentFolder, manifestsLast, adoptLocal, timersArmed,
  CONTENT_FOLDER, CONTENT_FOLDER_NAMES };
