// drive.js — Google Drive content integration (Settings > Integrations).
// A family (or Ellie's dad) connects a Google account with the DEVICE-CODE
// flow (no browser redirect dance: Settings shows "go to google.com/device,
// enter this code"), points at one Drive folder, and the hub mirrors that
// folder's known subfolders into the data dir on demand and every 6 hours:
//   <folder>/books/...  -> <DATA>/books/...   (book packages)
//   <folder>/music/...  -> <DATA>/music/...   (songs + manifest)
//   <folder>/movies/... -> <DATA>/movies/...  (catalog + posters)
//   <folder>/content/... -> <DATA>/content/... (lessons overrides)
// Read-only scope; nothing is ever uploaded. Config in <DATA>/drive.json:
//   { clientId, clientSecret, folderId, token:{...} } — clientId/secret come
// from the family's own Google Cloud OAuth client (Settings explains).
// Test seams: ERA_DRIVE_OAUTH / ERA_DRIVE_API point at fake servers.
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
const MIRROR_SUBDIRS = ["books", "music", "movies", "content", "clothing"];

let DATA = null;
let pendingDevice = null;   // {device_code, user_code, verification_url, interval, expires}
let lastSync = null;        // {when, files, errors} | {when, error}
let syncing = false;

const cfgPath = () => path.join(DATA, "drive.json");
function loadCfg() { try { return JSON.parse(fs.readFileSync(cfgPath(), "utf8")); } catch { return {}; } }
function saveCfg(c) { fs.writeFileSync(cfgPath(), JSON.stringify(c, null, 2)); }

function status() {
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
const MIRROR_DELETES = ["clothing", "books", "music", "movies"];

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
const ADOPT_ON_FIRST_SYNC = ["clothing"];
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
    if (e.isDirectory()) listTree(dir, r, out);
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

const isManifest = (name) => MANIFEST_NAMES.includes(String(name).toLowerCase());
const md5 = (p) => crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex");

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
      // is content-addressed enough by size.
      if (fs.existsSync(dest) && (isManifest(safe)
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
// login and syncing, we just read files. detect() finds the mount; the
// person picks a folder in Settings; sync() copies its books/music/content
// subfolders into the data dir. No OAuth client needed anywhere.
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
    try { out[sub] = fs.readdirSync(path.join(c.folderPath, sub)).length > 0; } catch {}
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

function setLocalFolder(p) {
  const check = browseLocal(p);
  if (check.error) return check;
  const c = loadCfg();
  c.mode = "local"; c.folderPath = path.normalize(p);
  saveCfg(c);
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
      have.files.add(r);
      // Manifests compare by BYTES, not size: a re-publish that only bumps
      // exportedAt keeps the same length, and exportedAt is the reader's
      // cache-bust key — size-equal would strand every fix on the one device.
      if (fs.existsSync(d) && (isManifest(e.name)
            ? fs.readFileSync(d).equals(fs.readFileSync(s))
            : fs.statSync(d).size === fs.statSync(s).size)) { stats.skipped++; continue; }
      atomically(d, (tmp) => fs.copyFileSync(s, tmp));
      stats.files++;
    } catch (err) { stats.errors.push(e.name + ": " + err.message); }
  }
}

function syncLocal(cfg) {
  const stats = { files: 0, skipped: 0, removed: 0, errors: [] };
  for (const sub of MIRROR_SUBDIRS) {
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
function createContentFolder() {
  const { roots } = detectLocal();
  if (!roots.length) return { error: "no-mount" };
  const base = path.join(roots[0], "New ERA Content");
  try {
    for (const sub of MIRROR_SUBDIRS) fs.mkdirSync(path.join(base, sub), { recursive: true });
  } catch (e) { return { error: String(e.message) }; }
  const c = loadCfg();
  c.mode = "local"; c.folderPath = base;
  saveCfg(c);
  return { ok: true, folderPath: base };
}

function setFolder(folderId) {
  const c = loadCfg();
  c.folderId = String(folderId || "").trim();
  saveCfg(c);
}

function start(dataDir) {
  DATA = dataDir;
  const c = loadCfg();
  if (c.mode === "local" && c.folderPath) {
    setTimeout(() => { sync(); }, 60 * 1000).unref();
    setInterval(() => { sync(); }, 10 * 60 * 1000).unref();  // local copy: cheap, keep it fresh
  } else if (c.token && c.folderId) {
    setTimeout(() => { sync(); }, 2 * 60 * 1000).unref();
    setInterval(() => { sync(); }, 6 * 60 * 60 * 1000).unref();
  }
}

module.exports = { start, status, connect, sync, setFolder, listFolders, detectLocal, browseLocal, setLocalFolder, openInExplorer, createContentFolder, manifestsLast };
