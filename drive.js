// drive.js — Google Drive content integration (Settings > Integrations).
// A family (or Ellie's dad) connects a Google account with the DEVICE-CODE
// flow (no browser redirect dance: Settings shows "go to google.com/device,
// enter this code"), points at one Drive folder, and the hub mirrors that
// folder's known subfolders into the data dir on demand and every 6 hours:
//   <folder>/books/...  -> <DATA>/books/...   (book packages)
//   <folder>/music/...  -> <DATA>/music/...   (songs + manifest)
//   <folder>/content/... -> <DATA>/content/... (lessons overrides)
// Read-only scope; nothing is ever uploaded. Config in <DATA>/drive.json:
//   { clientId, clientSecret, folderId, token:{...} } — clientId/secret come
// from the family's own Google Cloud OAuth client (Settings explains).
// Test seams: ERA_DRIVE_OAUTH / ERA_DRIVE_API point at fake servers.
"use strict";
const fs = require("fs");
const path = require("path");

const OAUTH = process.env.ERA_DRIVE_OAUTH || "https://oauth2.googleapis.com";
const API = process.env.ERA_DRIVE_API || "https://www.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
// clothing: raw outfit photos staged for the wardrobe pipeline (dad 8/29 -
// created + mirrored now, processed by a later milestone)
const MIRROR_SUBDIRS = ["books", "music", "content", "clothing"];

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

async function mirrorDir(tok, folderId, destDir, stats) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of await listChildren(tok, folderId)) {
    const safe = f.name.replace(/[\\/:*?"<>|]/g, "_");
    const dest = path.join(destDir, safe);
    if (f.mimeType === "application/vnd.google-apps.folder") {
      await mirrorDir(tok, f.id, dest, stats);
      continue;
    }
    if (f.mimeType.startsWith("application/vnd.google-apps")) continue; // native docs: skip
    try {
      if (fs.existsSync(dest) && f.size && fs.statSync(dest).size === Number(f.size)) { stats.skipped++; continue; }
      const r = await fetch(API + "/drive/v3/files/" + f.id + "?alt=media",
        { headers: { Authorization: "Bearer " + tok } });
      if (!r.ok) throw new Error("download " + r.status);
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      stats.files++;
    } catch (e) { stats.errors.push(safe + ": " + e.message); }
  }
}

// Mirror the configured folder's known subfolders into DATA. Never deletes.
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
  const stats = { files: 0, skipped: 0, errors: [] };
  try {
    const top = await listChildren(tok, c.folderId);
    for (const f of top) {
      if (f.mimeType !== "application/vnd.google-apps.folder") continue;
      const name = f.name.toLowerCase();
      if (!MIRROR_SUBDIRS.includes(name)) continue;
      await mirrorDir(tok, f.id, path.join(DATA, name), stats);
    }
    lastSync = { when: new Date().toISOString(), ...stats };
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
    try { if (fs.statSync(p).isDirectory()) appInstalled = true; } catch {}
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

function copyTreeLocal(src, dest, stats) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    try {
      if (e.isDirectory()) { copyTreeLocal(s, d, stats); continue; }
      if (!e.isFile()) continue;
      if (fs.existsSync(d) && fs.statSync(d).size === fs.statSync(s).size) { stats.skipped++; continue; }
      fs.copyFileSync(s, d);
      stats.files++;
    } catch (err) { stats.errors.push(e.name + ": " + err.message); }
  }
}

function syncLocal(cfg) {
  const stats = { files: 0, skipped: 0, errors: [] };
  for (const sub of MIRROR_SUBDIRS) {
    const src = path.join(cfg.folderPath, sub);
    try { if (!fs.statSync(src).isDirectory()) continue; } catch { continue; }
    copyTreeLocal(src, path.join(DATA, sub), stats);
  }
  lastSync = { when: new Date().toISOString(), ...stats };
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
  if ((c.mode === "local" && c.folderPath) || (c.token && c.folderId)) {
    setTimeout(() => { sync(); }, 2 * 60 * 1000).unref();       // after boot settles
    setInterval(() => { sync(); }, 6 * 60 * 60 * 1000).unref(); // same cadence as updates
  }
}

module.exports = { start, status, connect, sync, setFolder, listFolders, detectLocal, browseLocal, setLocalFolder, openInExplorer, createContentFolder };
