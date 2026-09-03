// era-hub server — serves the New ERA app modules + local APIs (settings, TTS
// proxy/cache, prediction, logging, board recipes). Local-first: binds
// 127.0.0.1 unless ERA_BIND says otherwise.
//   node server.js [port]     (default 8377)
// All state lives under the data dir (ERA_DATA_DIR, default ./data) — the
// family overlay. Logs append to <data>/logs/YYYY-MM-DD.jsonl.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const updater = require("./update");
const drive = require("./drive");
const clothing = require("./clothing");

const PORT = parseInt(process.argv[2], 10) || 8377;
const BIND = process.env.ERA_BIND || "127.0.0.1";
const PUB = path.join(__dirname, "public");
const DATA = process.env.ERA_DATA_DIR || path.join(__dirname, "data");
const LOGS = path.join(DATA, "logs");
const TTS_CACHE = path.join(DATA, "tts-cache");
fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(TTS_CACHE, { recursive: true });

// On Windows a double-clicked launch would live in a black console window
// (dad 8/29: weird for a novice). Re-spawn with NO window, log to
// <data>/logs/hub.log, and let the visible parent exit. ERA_CONSOLE=1
// keeps the console for debugging.
if (process.platform === "win32" && !process.env.ERA_CONSOLE && !process.env.ERA_HIDDEN) {
  try {
    const { spawn } = require("child_process");
    const out = fs.openSync(path.join(LOGS, "hub.log"), "a");
    spawn(process.execPath, [__filename, String(PORT)], {
      detached: true, windowsHide: true, stdio: ["ignore", out, out],
      env: { ...process.env, ERA_HIDDEN: "1" },
    }).unref();
    process.exit(0);
  } catch { /* visible console beats no hub */ }
}
const crypto = require("crypto");
const predictor = require("./predict");

// child/family profile (name for messages, publish email, timezone) — overlay data
let PROFILE = {}, HAS_PROFILE = false, TZ = "America/Los_Angeles";
function loadProfile() {
  try {
    PROFILE = JSON.parse(fs.readFileSync(path.join(DATA, "profile.json"), "utf8"));
    HAS_PROFILE = true;
  } catch { PROFILE = {}; HAS_PROFILE = false; }
  TZ = PROFILE.tz || "America/Los_Angeles";
}
loadProfile();

// ---- family data pool (shared-data contract v1; see pool.js) ----
// Transition rule: legacy stores (logs/, wardrobe/history.json) stay canonical;
// the pool is DOUBLE-WRITTEN so it accrues real data before readers migrate.
const DEVICE_ID = process.env.ERA_DEVICE_ID || PROFILE.deviceId || "hub";
const pool = require("./pool").initPool(DATA, DEVICE_ID);
pool.heartbeat({ service: "era-hub" });
setInterval(() => pool.heartbeat({ service: "era-hub" }), 60 * 60 * 1000).unref();

// ---- board data paths: overlay data, read-only, path-jailed ----
const RECIPE_PATHS = [
  path.join(DATA, "recipes", "today.json"),
];
// ELLIE_WARDROBE_DIR: test override only — route tests point POST /outfit-event
// at a temp dir so they never touch the live history.json.
const WARDROBE_DIR = process.env.ELLIE_WARDROBE_DIR || path.join(DATA, "wardrobe");
const GEN_ASSETS_DIR = path.join(DATA, "gen-assets");
const BOOKS_DIR = path.join(DATA, "books");   // book packages (era-book-reader M3)
const MUSIC_DIR = path.join(DATA, "music");   // songs overlay (Songs Board 8/24)
const MOVIES_DIR = path.join(DATA, "movies"); // movie catalog + posters (movie-player P1, 8/29)
const SYMBOLS_CACHE = path.join(DATA, "symbols-cache");
fs.mkdirSync(SYMBOLS_CACHE, { recursive: true });

// ---- app registry (install-with-checkboxes, 8/29): one engine, apps chosen
// at install and togglable later from the home screen. Enabled set lives in
// <DATA>/apps.json ({"enabled":[ids]}); absent file = everything (existing
// installs keep all their apps). Settings is not an app — always present.
const APPS = [
  { id: "making-words", title: "Making Words", sub: "guided word building", path: "/", pack: null },
  { id: "pencil", title: "The Pencil", sub: "free writing with prediction", path: "/pencil/", pack: "pencil" },
  { id: "board", title: "Clothing Picker", sub: "daily outfits, checked against the weather", path: "/board/", pack: "board" },
  { id: "music", title: "Music", sub: "favorite songs, audio only", path: "/board/?recipe=songs", pack: "board" },
  { id: "movies", title: "Movies", sub: "shows & movies, her picks", path: "/board/?recipe=movies", pack: "board" },
  { id: "reader", title: "Book Reader", sub: "picture books, read aloud", path: "/reader/", pack: "reader" },
  // engine, not a page: no home tile; enabling compiles our public ERAgaze.cs
  // on-device (Windows' built-in csc) and pairs it with the Tobii runtime
  // already on Tobii devices (official NuGet as fallback for other PCs)
  { id: "eragaze", title: "ERAgaze", sub: "eye-gaze cursor + dwell for Tobii trackers", path: null, pack: null, engine: true },
];
// pack = the public/ subdir an app needs on disk (null = rides with the core;
// board/music/movies share one pack). The installer lays down only chosen
// packs; enabling later REALLY installs the pack (dad 8/29: never
// install-everything-and-hide) by pulling it from the release tarball.
function appInstalled(app) {
  if (app.engine) return gazeCompiled();
  return !app.pack || fs.existsSync(path.join(PUB, app.pack));
}
const appInstalling = {};   // id -> true while a pack download runs
// Anything enabled (installer checkboxes, wizard, restored apps.json) but not
// on disk gets installed — runs at boot and after /setup. Dad's cold test
// 8/29: the ERAgaze checkbox did nothing because only the Settings toggle
// triggered installs.
function reconcileApps() {
  const enabled = loadEnabledApps();
  for (const app of APPS) {
    if (!enabled.includes(app.id) || appInstalled(app) || appInstalling[app.id]) continue;
    appInstalling[app.id] = true;
    (app.engine ? installGaze() : installPack(app))
      .then(() => console.log("[apps] reconciled " + app.id))
      .catch(e => console.error("[apps] reconcile " + app.id + ": " + e.message))
      .finally(() => { delete appInstalling[app.id]; });
  }
}
async function installPack(app) {
  const os = require("os");
  const { spawnSync } = require("child_process");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "era-pack-"));
  try {
    const r = await fetch(updater.FEED + "/new-era-suite.tar.gz", { redirect: "follow" });
    if (!r.ok) throw new Error("download " + r.status);
    const tarball = path.join(stage, "suite.tar.gz");
    fs.writeFileSync(tarball, Buffer.from(await r.arrayBuffer()));
    const t = spawnSync("tar", ["-xzf", tarball, "-C", stage,
      "new-era-suite/public/" + app.pack], { windowsHide: true });
    if (t.status !== 0) throw new Error("extract failed");
    fs.cpSync(path.join(stage, "new-era-suite", "public", app.pack),
      path.join(PUB, app.pack), { recursive: true, force: true });
    console.log("[apps] installed pack " + app.pack);
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
  }
}
function loadEnabledApps() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, "apps.json"), "utf8"));
    if (Array.isArray(j.enabled)) return j.enabled.filter(id => APPS.some(a => a.id === id));
  } catch {}
  // no apps.json: every APP on, but never auto-enable the ENGINE — existing
  // installs (and Ellie's device, which runs its own ERAgaze) must not grow
  // a second gaze engine uninvited
  return APPS.filter(a => !a.engine).map(a => a.id);
}
// A gaze engine is "there" if ours is compiled OR any engine answers the bus
// (Ellie's device runs the family build — never fight it).
function gazeBusAlive() {
  return new Promise((resolve) => {
    const req2 = http.get({ host: "127.0.0.1", port: 49155, path: "/status", timeout: 900 },
      (r) => { r.resume(); resolve(true); });
    req2.on("error", () => resolve(false));
    req2.on("timeout", () => { req2.destroy(); resolve(false); });
  });
}
const GAZE_DIR = path.join(__dirname, "gaze");
// The engine is compiled ON the device, so a source fix shipped by the updater
// only lands if we notice the .cs is newer than the .exe (dad 9/1: the exit-door
// fix could never have reached an installed machine otherwise).
function gazeNeedsCompile() {
  const exe = path.join(GAZE_DIR, "ERAgaze.exe");
  const src = path.join(GAZE_DIR, "ERAgaze.cs");
  try {
    if (!fs.existsSync(exe)) return true;
    return fs.statSync(src).mtimeMs > fs.statSync(exe).mtimeMs;
  } catch { return !fs.existsSync(exe); }
}
function gazeCompiled() { return fs.existsSync(path.join(GAZE_DIR, "ERAgaze.exe")); }
async function installGaze() {
  if (process.platform !== "win32") throw new Error("windows only");
  const { spawnSync, spawn } = require("child_process");
  // 1. the Tobii runtime: prefer the copy already on this (Tobii) device
  const dllDest = path.join(GAZE_DIR, "tobii_stream_engine.dll");
  if (!fs.existsSync(dllDest)) {
    let found = null;
    for (const base of ["C:\\Program Files\\Tobii", "C:\\Program Files\\Tobii Dynavox",
                        "C:\\Program Files (x86)\\Tobii", "C:\\Program Files (x86)\\Tobii Dynavox"]) {
      const stack = [base];
      while (stack.length && !found) {
        const dir = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.name.toLowerCase() === "tobii_stream_engine.dll" && !p.includes("x86")) found = p;
        }
      }
      if (found) break;
    }
    if (found) fs.copyFileSync(found, dllDest);
    else {
      // non-Tobii PC: official Tobii package from NuGet (user pulls from
      // Tobii's own distribution; we never redistribute their binaries)
      const os = require("os");
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), "era-tobii-"));
      const r = await fetch("https://api.nuget.org/v3-flatcontainer/tobii.streamengine.native/2.2.2.363/tobii.streamengine.native.2.2.2.363.nupkg");
      if (!r.ok) throw new Error("tobii runtime download failed");
      const pkg = path.join(stage, "t.zip");
      fs.writeFileSync(pkg, Buffer.from(await r.arrayBuffer()));
      spawnSync("tar", ["-xf", pkg, "-C", stage], { windowsHide: true });
      fs.copyFileSync(path.join(stage, "build", "native", "lib", "x64", "tobii_stream_engine.dll"), dllDest);
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    }
  }
  // 2. compile our engine with Windows' built-in compiler (also on UPDATE,
  // when the shipped source is newer than the exe on disk)
  if (gazeNeedsCompile()) {
    const exePath = path.join(GAZE_DIR, "ERAgaze.exe");
    const fresh = !fs.existsSync(exePath);
    // keep the working build so a bad compile is one rename from recovery
    if (!fresh) { try { fs.copyFileSync(exePath, path.join(GAZE_DIR, "ERAgaze.prev.exe")); } catch {} }
    const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    const out = fresh ? exePath : path.join(GAZE_DIR, "ERAgaze.new.exe");
    const c = spawnSync(csc, ["/nologo", "/target:winexe", "/platform:x64",
      "/out:" + out,
      "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll",
      "/r:System.Web.Extensions.dll", "/r:System.Management.dll",
      path.join(GAZE_DIR, "ERAgaze.cs")], { windowsHide: true });
    if (c.status !== 0) throw new Error("compile failed: " + String(c.stderr || c.stdout));
    if (!fresh) {
      // A running engine holds its exe open; swap when we can, otherwise leave
      // the new build staged and let the next logon pick it up.
      try { fs.renameSync(out, exePath); console.log("[gaze] recompiled from updated source"); }
      catch { console.log("[gaze] new engine staged (running build is locked); it starts at next logon"); }
    }
  }
  // 3. shortcuts + autostart + start it (skip start when another engine runs)
  appShortcut({ title: "ERAgaze", path: null, exe: path.join(GAZE_DIR, "ERAgaze.exe") }, true);
  if (!(await gazeBusAlive())) {
    spawn(path.join(GAZE_DIR, "ERAgaze.exe"), [], { cwd: GAZE_DIR, detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
  console.log("[gaze] installed");
}
// Keep desktop/start-menu shortcuts in step with an app toggle (Windows only,
// best-effort — the home tile is the source of truth, the .lnk a convenience).
// Minimize our kiosk windows so an externally opened window (browser page,
// Explorer) is actually visible — background processes cannot steal the
// foreground on Windows, but we can step aside (dad 8/29).
function stepAsideFromKiosk() {
  if (process.platform !== "win32") return;
  const { spawn } = require("child_process");
  // Shaped exactly like appShortcut's call — the one powershell spawn PROVEN
  // to work from the production (detached, console-less) hub: -Command, not
  // detached, windowsHide. No double quotes anywhere in the script (node's
  // arg re-quoting mangled them and the CIM filter matched nothing, VM QA
  // 9/1); WQL strings use PS single-quote doubling instead. Output lands in
  // logs/stepaside.log so any future failure explains itself.
  const ps =
    "Add-Type -Name W -Namespace U -MemberDefinition '[DllImport(" + JSON.stringify("user32.dll") + ")] public static extern bool ShowWindow(IntPtr h, int n);'; " +
    "Get-CimInstance Win32_Process -Filter 'Name=" + "''" + "chrome.exe" + "''" + " or Name=" + "''" + "msedge.exe" + "''" + "' | " +
    "Where-Object { $_.CommandLine -like '*kiosk-profile*' } | ForEach-Object { " +
    "$p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; " +
    "if ($p -and $p.MainWindowHandle -ne 0) { 'minimized ' + $_.ProcessId + ' rc ' + [U.W]::ShowWindow($p.MainWindowHandle, 6) } }";
  try {
    const out = fs.openSync(path.join(LOGS, "stepaside.log"), "a");
    fs.writeSync(out, new Date().toISOString() + " step-aside\n");
    const c = spawn("powershell.exe", ["-NoProfile", "-Command", ps],
      { stdio: ["ignore", out, out], windowsHide: true });
    c.on("exit", (code) => { try { fs.writeSync(out, "exit " + code + "\n"); fs.closeSync(out); } catch {} });
    c.unref();
  } catch {}
}

// One-time stage-clearing at the very first boot after install (dad 9/1:
// the welcome kiosk opened BEHIND the browser the family had just downloaded
// with — "did anything happen?"). Windows won't let a background process
// foreground our window, but it will let us MINIMIZE the covering browsers;
// the kiosk is then the visible surface. Same proven spawn shape as
// stepAsideFromKiosk, inverted filter (non-kiosk browser windows), logged.
function clearStageOnce() {
  if (process.platform !== "win32") return;
  const marker = path.join(DATA, ".first-launch-done");
  if (fs.existsSync(marker)) return;
  try { fs.writeFileSync(marker, new Date().toISOString()); } catch {}
  const { spawn } = require("child_process");
  const ps =
    "Add-Type -Name W -Namespace U -MemberDefinition '[DllImport(" + JSON.stringify("user32.dll") + ")] public static extern bool ShowWindow(IntPtr h, int n);'; " +
    "Get-CimInstance Win32_Process -Filter 'Name=" + "''" + "chrome.exe" + "''" + " or Name=" + "''" + "msedge.exe" + "''" + "' | " +
    "Where-Object { $_.CommandLine -notlike '*kiosk-profile*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { " +
    "$p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; " +
    "if ($p -and $p.MainWindowHandle -ne 0) { 'cleared ' + $_.ProcessId + ' rc ' + [U.W]::ShowWindow($p.MainWindowHandle, 6) } }";
  setTimeout(() => {
    try {
      const out = fs.openSync(path.join(LOGS, "stepaside.log"), "a");
      fs.writeSync(out, new Date().toISOString() + " clear-stage (first launch)\n");
      const c = spawn("powershell.exe", ["-NoProfile", "-Command", ps],
        { stdio: ["ignore", out, out], windowsHide: true });
      c.on("exit", (code) => { try { fs.writeSync(out, "exit " + code + "\n"); fs.closeSync(out); } catch {} });
      c.unref();
    } catch {}
  }, 9000);   // the kiosk browser needs a moment to exist before the stage clears
}

function appShortcut(app, enabled) {
  if (process.platform !== "win32") return;
  const { spawn } = require("child_process");
  const target = app.exe || path.join(__dirname, "start-hub.bat");
  const dirs = app.exe
    ? `@([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'), [Environment]::GetFolderPath('Startup'))`
    : `@([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'))`;
  const script = enabled
    ? `$w = New-Object -ComObject WScript.Shell;` +
      `foreach ($d in ${dirs}) {` +
      `$l = $w.CreateShortcut((Join-Path $d '${app.title}.lnk'));` +
      `$l.TargetPath = '${target}';` +
      (app.exe ? `` : `$l.Arguments = '${PORT} "${app.path}"';`) +
      `$l.WorkingDirectory = '${__dirname}';` +
      // every shortcut wore a generic gear (QA 9/1) — carry the suite icon so
      // a parent can find the app on a crowded desktop
      `$l.IconLocation = '${path.join(__dirname, "public", "favicon.ico")},0';` +
      `$l.WindowStyle = 7; $l.Save() }` +   // 7 = minimized: the launcher console never pops up
      ``
    : `foreach ($d in ${dirs}) {` +
      `Remove-Item (Join-Path $d '${app.title}.lnk') -Force -ErrorAction SilentlyContinue }`;
  try {
    // windowsHide: dad watched PowerShell windows appear for every shortcut
    spawn("powershell.exe", ["-NoProfile", "-Command", script],
      { stdio: "ignore", windowsHide: true })
      .on("error", (e) => console.error("[apps] shortcut: " + e.message));
  } catch (e) { console.error("[apps] shortcut: " + e.message); }
}

// ARASAAC lookup ported from packages/generator/aac_board_designer.py
const ARASAAC_API = "https://api.arasaac.org/api/pictograms/en/bestsearch/";
const ARASAAC_IMG = "https://static.arasaac.org/pictograms/{id}/{id}_300.png";
const PREWARM = ["sun", "cloud", "cold", "more", "shirt", "trousers", "13638", "dress",
                 "clothes", "house", "clock", "snack", "back", "yes"];

// Serve a file from a jail dir if it exists, has an allowed extension, and does
// not escape the jail. `rest` is the raw (already URL-decoded) sub-path.
function serveJailed(res, dir, rest, allowedExts) {
  if (rest.includes("\0")) { res.writeHead(400).end(); return; }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(rest)) { res.writeHead(400).end(); return; }
  const file = path.normalize(path.join(dir, rest));
  if (file !== dir && !file.startsWith(dir + path.sep)) { res.writeHead(400).end(); return; }
  const ext = path.extname(file).toLowerCase();
  if (!allowedExts.includes(ext)) { res.writeHead(404).end("not found"); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream",
                         "Cache-Control": "no-cache" });
    res.end(data);
  });
}

// ---- book packages (era-book-reader M3): <DATA>/books/<slug>/ ----
// A package is complete iff manifest.json exists and parses (manifest written
// LAST by the exporter); manifest-less/unparseable dirs are skipped silently.
// Degraded law: missing books dir -> [] — never a crash.
function booksIndex() {
  let dirs = [];
  try { dirs = fs.readdirSync(BOOKS_DIR, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try {
      const mPath = path.join(BOOKS_DIR, d.name, "manifest.json");
      const m = JSON.parse(fs.readFileSync(mPath, "utf8"));
      const pages = Array.isArray(m.pages) ? m.pages : [];
      // ?v= cache-bust: media is served immutable/24h, so a re-exported package
      // must change its URLs (manifest mtime = the package version; the CSS
      // stale-cache law generalized — clients cache the bare URL hard)
      const v = Math.floor(fs.statSync(mPath).mtimeMs / 1000).toString(36);
      out.push({ slug: d.name, title: String(m.title || d.name),
                 cover: "/books/" + d.name + "/" + (m.cover || "cover.jpg") + "?v=" + v,
                 pages: pages.length, hasVideo: pages.some(p => p && p.video),
                 authored: m.authored === true, v });
    } catch {}   // incomplete package: skip silently
  }
  return out;
}

// GET /books/<slug>/... and /music/... — path-jailed static with an allowlist.
// Content is immutable, so media gets a long immutable Cache-Control; JSON
// manifests no-cache. A/V files get single-range HTTP Range support and are
// ALWAYS streamed (createReadStream), never buffered whole.
const BOOK_AV_EXTS = [".mp3", ".mp4", ".wav"];
const BOOK_EXTS = [".json", ".jpg", ".jpeg", ".png", ...BOOK_AV_EXTS];
const MUSIC_AV_EXTS = [".m4a", ".mp3", ".wav", ".webm", ".opus"];
const MUSIC_EXTS = [".json", ".jpg", ".jpeg", ".png", ".webp", ...MUSIC_AV_EXTS];
// movies jail: images + json ONLY — the hub NEVER serves video for this
// feature (D57: pixels come from the streaming services, always).
const MOVIE_EXTS = [".json", ".jpg", ".webp", ".png"];
function serveBook(req, res, rest) { serveMediaJail(req, res, BOOKS_DIR, rest, BOOK_EXTS, BOOK_AV_EXTS); }
function serveMediaJail(req, res, jailDir, rest, allowedExts, avExts) {
  if (rest.includes("\0")) { res.writeHead(400).end(); return; }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(rest)) { res.writeHead(403).end(); return; }
  const file = path.normalize(path.join(jailDir, rest));
  if (file !== jailDir && !file.startsWith(jailDir + path.sep)) { res.writeHead(403).end(); return; }
  const ext = path.extname(file).toLowerCase();
  if (!allowedExts.includes(ext)) { res.writeHead(404).end("not found"); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("not found"); return; }
    const type = MIME[ext] || "application/octet-stream";
    if (ext === ".json") {                       // manifest.json: small, mutable view
      fs.readFile(file, (e, data) => {
        if (e) { res.writeHead(404).end("not found"); return; }
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
        res.end(data);
      });
      return;
    }
    const headers = { "Content-Type": type, "Cache-Control": "max-age=86400, immutable" };
    if (!avExts.includes(ext)) {                 // images: full streamed 200
      headers["Content-Length"] = st.size;
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
      return;
    }
    headers["Accept-Ranges"] = "bytes";
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (m && (m[1] !== "" || m[2] !== "")) {     // single range; malformed -> full 200
      let start, end;
      if (m[1] === "") {                         // suffix form: last N bytes
        const n = parseInt(m[2], 10);
        start = st.size - n; end = st.size - 1;
        if (n === 0) start = st.size;            // bytes=-0 is unsatisfiable
        if (start < 0) start = 0;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === "" ? st.size - 1 : Math.min(parseInt(m[2], 10), st.size - 1);
      }
      if (start >= st.size || start > end) {
        res.writeHead(416, { "Content-Range": "bytes */" + st.size }).end();
        return;
      }
      headers["Content-Range"] = "bytes " + start + "-" + end + "/" + st.size;
      headers["Content-Length"] = end - start + 1;
      res.writeHead(206, headers);
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    headers["Content-Length"] = st.size;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

// Pick whichever recipe path exists with the newest mtime; serve with ETag/304.
function serveRecipe(req, res) {
  let best = null;
  for (const p of RECIPE_PATHS) {
    try { const st = fs.statSync(p); if (!best || st.mtimeMs > best.st.mtimeMs) best = { p, st }; }
    catch {}
  }
  if (!best) { res.writeHead(404).end("not found"); return; }
  const etag = '"' + Math.floor(best.st.mtimeMs) + "-" + best.st.size + '"';
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-cache",
                    "ETag": etag, "Access-Control-Allow-Origin": "*" };
  if ((req.headers["if-none-match"] || "") === etag) { res.writeHead(304, headers).end(); return; }
  if (req.method === "HEAD") { res.writeHead(200, headers).end(); return; }
  fs.readFile(best.p, (err, data) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, headers); res.end(data);
  });
}

// ---- Songs Board recipe: GENERATED from <DATA>/music/manifest.json ----
// v2 (dad's 8/24 feedback round). GRID pages: 3x4, 7 song doors per page in
// rank order at the learned cells, center rests unpinned, More bottom-left,
// back (big <- glyph) top-left on later pages — NO Stop and NO exit tile on
// the grid (playback only happens inside a song page, so leaving it IS stop;
// the msgbar door remains the app exit). Each song door opens its SONG PAGE:
// the cover hero fills the LEFT HALF (row/col spans), right column = back
// arrow / Stop / Full song, far-right column all rest black (eye rest).
// Default play is a CLIP_MS clip (school: scratch the itch, not the day);
// "Full song" un-caps the running clip (or replays full) — deliberate extra
// effort by design. Per-song `v` = audio file mtime (client IDB cache key).
// ETag = manifest stat + RECIPE_REV (bump the rev when this generator's
// OUTPUT changes without a manifest change, or boards keep their 304 cache).
// page 1 has no chrome tiles at the corners (v3, dad 8/24): 9 songs. Later
// pages keep (1,1) for back but use the (3,4) corner too (dad r4): 8 songs.
const SONG_CELLS_P1 = [[1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [2, 4], [3, 2], [3, 3], [3, 4]];
const SONG_CELLS_PN = [[1, 2], [1, 3], [1, 4], [2, 1], [2, 4], [3, 2], [3, 3], [3, 4]];
const CLIP_MS = 40000;
const RECIPE_REV = 4;
const STOP_SYMBOL = "8289";   // exact ARASAAC id: the red STOP sign (bestsearch "stop" = a bus stop)
const FULL_SYMBOL = "music";  // sheet-music notes (verified via /symbol/music)
function songsRecipe() {
  const mp = path.join(MUSIC_DIR, "manifest.json");
  const st = fs.statSync(mp);                    // throws -> caller 404s
  const manifest = JSON.parse(fs.readFileSync(mp, "utf8"));
  const songs = (Array.isArray(manifest.songs) ? manifest.songs : [])
    .filter(s => s && s.id && s.audio)
    .map(s => {
      let v = 0;
      try { v = Math.floor(fs.statSync(path.join(MUSIC_DIR, s.audio)).mtimeMs); }
      catch { return null; }                     // audio file missing: skip the song
      return { ...s, v };
    })
    .filter(Boolean)
    .sort((a, b) => (a.rank || 0) - (b.rank || 0));
  const perP1 = SONG_CELLS_P1.length, perPN = SONG_CELLS_PN.length;
  const pages = songs.length <= perP1 ? 1 : 1 + Math.ceil((songs.length - perP1) / perPN);
  const boards = [];
  for (let p = 0; p < pages; p++) {
    const id = p === 0 ? "songs" : "songs-" + (p + 1);
    const cells = p === 0 ? SONG_CELLS_P1 : SONG_CELLS_PN;
    const from = p === 0 ? 0 : perP1 + (p - 1) * perPN;
    const buttons = [];
    if (p > 0) {
      buttons.push({ label: "Back", say: "back", type: "back", glyph: "←",
                     load: p === 1 ? "songs" : "songs-" + p, row: 1, col: 1 });
    }
    songs.slice(from, from + cells.length).forEach((s, i) => {
      const [row, col] = cells[i];
      buttons.push({ label: s.title, say: s.title, type: "song", song_id: s.id,
                     audio: "music/" + s.audio, v: s.v, clip_ms: CLIP_MS,
                     image: s.cover ? "music/" + s.cover : undefined,
                     load: "song-" + s.id,
                     duration: s.duration || 0, row, col });
    });
    if (p < pages - 1)   // exactly the outfit board's More (teal control + ARASAAC "more")
      buttons.push({ label: "More", type: "control", symbol: "more",
                     load: "songs-" + (p + 2), row: 3, col: 1 });
    boards.push({ id, name: "What do I want to hear?", rows: 3, columns: 4, buttons });
  }
  // one page per song: hero left half; back / Stop / Full song down col 3;
  // col 4 stays unpinned -> a full black rest column.
  songs.forEach((s, i) => {
    const gridPage = i < perP1 ? "songs"
                   : "songs-" + (Math.floor((i - perP1) / perPN) + 2);
    boards.push({
      id: "song-" + s.id, name: s.title, rows: 3, columns: 4,
      buttons: [
        { label: s.title, say: s.title, type: "song", song_id: s.id,
          audio: "music/" + s.audio, v: s.v, clip_ms: CLIP_MS,
          image: s.cover ? "music/" + s.cover : undefined,
          duration: s.duration || 0, row: 1, col: 1, row_span: 3, col_span: 2 },
        { label: "Back", say: "back", type: "back", glyph: "←",
          load: gridPage, row: 1, col: 3 },
        { label: "Stop", say: "stop", type: "stop", symbol: STOP_SYMBOL, row: 2, col: 3 },
        { label: "Full song", say: "full song", type: "full", song_id: s.id,
          symbol: FULL_SYMBOL,
          audio: "music/" + s.audio, v: s.v, row: 3, col: 3 },
      ],
    });
  });
  return {
    recipe: { locale: "en-US", root: "songs", home_label: "Songs", boards },
    etag: '"' + Math.floor(st.mtimeMs) + "-" + st.size + "-r" + RECIPE_REV + '"',
  };
}
function serveSongsRecipe(req, res) {
  let out;
  try { out = songsRecipe(); }
  catch { res.writeHead(404).end("not found"); return; }   // no music overlay: honest 404
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-cache",
                    "ETag": out.etag, "Access-Control-Allow-Origin": "*" };
  if ((req.headers["if-none-match"] || "") === out.etag) { res.writeHead(304, headers).end(); return; }
  if (req.method === "HEAD") { res.writeHead(200, headers).end(); return; }
  res.writeHead(200, headers);
  res.end(JSON.stringify(out.recipe));
}

// ---- Movies Board recipe: GENERATED from <DATA>/movies/catalog.json ----
// (movie-player P1; spec docs/superpowers/specs/2026-08-29-movie-player-design.md
// §2). 3x4 GRID pages with FROZEN slots (spatial memory, contract navAnchors):
//   (1,1) = continue on page 1 (back arrow on later pages)
//   six core-title cells in reading order: (1,2)(1,3)(1,4)(2,1)(3,2)(3,3)
//   (2,4) = THE exploration slot — exactly ONE tier:"discovery" title per grid
//           page (comfort titles NEVER sit here; a comfort-flagged discovery
//           title joins the core flow instead)
//   (3,1) = More on non-last pages; (3,4) = All-done exit on EVERY grid page
//   (2,2)/(2,3) stay unpinned -> the renderer's black rest cells
// Show tiles are DOORS (board: <titleId>) -> episode pages (8/page, back
// top-left, More bottom-left) + a "<titleId>-next" what-next board: the
// post-episode choice screen that replaces autoplay (next / watch again /
// something else / all done).
// GENERATOR RULE: only titles/episodes with a non-null launch.url appear;
// every null launch is counted in meta.pendingCount (curation backlog
// visibility). Missing/empty/unparseable catalog -> a VALID EMPTY recipe and
// the server stays alive (degrade like /books/index.json, NOT like songs' 404
// — the real v0 catalog ships all-null and the board must still boot).
// ETag = catalog mtime + size + MOVIE_RECIPE_REV (bump the rev when this
// generator's OUTPUT changes without a catalog change, or boards keep 304s).
// D57b (dad 8/29): grid pages carry NO exit tile — the msgbar door is the
// app exit (songs D56a convention); (3,4) seats content like songs v3.
const MOVIE_CORE_CELLS = [[1, 2], [1, 3], [1, 4], [2, 1], [3, 2], [3, 3], [3, 4]];
const MOVIE_EP_CELLS = [[1, 2], [1, 3], [1, 4], [2, 1], [2, 4], [3, 2], [3, 3], [3, 4]];
const MOVIE_RECIPE_REV = 4;
// season/episode order flattened; keeps null-launch episodes so the caller can
// both filter and count them (pendingCount).
function movieEpisodesOf(t) {
  const out = [];
  const seasons = (Array.isArray(t.seasons) ? t.seasons : [])
    .slice().sort((a, b) => (a && a.n || 0) - (b && b.n || 0));
  for (const s of seasons) {
    if (!s) continue;
    const eps = (Array.isArray(s.episodes) ? s.episodes : [])
      .slice().sort((a, b) => (a && a.n || 0) - (b && b.n || 0));
    for (const e of eps) {
      if (!e) continue;
      out.push({ s: s.n, e: e.n, title: e.title, url: (e.launch && e.launch.url) || null });
    }
  }
  return out;
}
function moviesRecipe() {
  const cp = path.join(MOVIES_DIR, "catalog.json");
  let st = null, catalog = null;
  try {
    st = fs.statSync(cp);
    catalog = JSON.parse(fs.readFileSync(cp, "utf8"));
  } catch {}                                     // degraded: valid empty recipe below
  const etag = '"' + (st ? Math.floor(st.mtimeMs) + "-" + st.size : "0-0") +
               "-r" + MOVIE_RECIPE_REV + '"';
  const titles = (catalog && Array.isArray(catalog.titles) ? catalog.titles : [])
    .filter(t => t && typeof t.id === "string" && /^[a-z0-9-]{1,64}$/.test(t.id));
  let pending = 0;                               // null launch.urls awaiting curation
  const playable = [];
  for (const t of titles) {
    if (t.kind === "movie") {
      const url = (t.launch && t.launch.url) || null;
      if (url) playable.push({ ...t, url });
      else pending++;
    } else if (t.kind === "show") {
      const eps = movieEpisodesOf(t);
      pending += eps.filter(e => !e.url).length;
      if (!eps.length) pending++;                // seasons:[] = the whole show is pending
      const ok = eps.filter(e => e.url);
      if (ok.length) playable.push({ ...t, episodes: ok });
    }
  }
  const byRank = (a, b) => (a.rank || 0) - (b.rank || 0) || String(a.id).localeCompare(String(b.id));
  // comfort go-tos stay accessible but never occupy the exploration slot
  const core = playable.filter(t => t.tier !== "discovery" || t.comfort === true).sort(byRank);
  const discovery = playable.filter(t => t.tier === "discovery" && t.comfort !== true).sort(byRank);
  // P3-SEAM(recommender): v1 "continue" is the most trivial deterministic rule
  // — the first show (core first, then rank order) that has a playable episode;
  // its "next" = the first playable episode. P3 replaces this pick (and the
  // what-next next/again picks below) with lib/recommend.js output — history-
  // driven next-unwatched of the most recently watched show — WITHOUT touching
  // the cell contract.
  const contShow = core.concat(discovery).find(t => t.kind === "show") || null;

  // ---- cell contract (the board agent builds against exactly this) ----
  function showCell(t, row, col) {
    const c = { type: "show", label: t.title, board: t.id, row, col };
    if (t.poster) c.image = "movies/" + t.poster;
    return c;
  }
  function movieCell(t, row, col) {
    const c = { type: "movie", label: t.title, titleId: t.id, service: t.service,
                url: t.url, row, col };
    if (t.poster) c.image = "movies/" + t.poster;
    return c;
  }
  function episodeCell(t, ep, row, col, mark) {
    const c = { type: "episode", label: ep.title || ("S" + ep.s + " E" + ep.e),
                titleId: t.id, service: t.service, url: ep.url,
                episode: { s: ep.s, e: ep.e }, row, col };
    if (mark) c.mark = mark;                     // "next" | "again"
    if (t.poster) c.image = "movies/" + t.poster; // the show's art (continue tile incl.)
    return c;
  }
  const exitCell = () => ({ label: "All done", say: "all done", type: "exit", row: 3, col: 4 });

  const boards = [];
  const doorPage = {};                           // titleId -> grid board id (for Back doors)
  // D57c (dad 8/28, photo review): ONLY the middle pair (2,2)(2,3) ever rests
  // black — when a page has no discovery title, (2,4) joins the core flow.
  let ci = 0, p = 0;
  while (p === 0 || ci < core.length || discovery[p]) {
    const id = p === 0 ? "movies" : "movies-" + (p + 1);
    const buttons = [];
    if (p === 0) {
      if (contShow)                              // pinned slot 1: continue
        buttons.push(episodeCell(contShow, contShow.episodes[0], 1, 1, "next"));
    } else {
      buttons.push({ label: "Back", say: "back", type: "back", glyph: "←",
                     load: p === 1 ? "movies" : "movies-" + p, row: 1, col: 1 });
    }
    const disc = discovery[p];
    const cells = disc ? MOVIE_CORE_CELLS : MOVIE_CORE_CELLS.concat([[2, 4]]);
    for (const [row, col] of cells) {
      const t = core[ci]; if (!t) break;
      ci++;
      doorPage[t.id] = id;
      buttons.push(t.kind === "show" ? showCell(t, row, col) : movieCell(t, row, col));
    }
    if (disc) {                                  // the exploration slot, one per page
      doorPage[disc.id] = id;
      buttons.push(disc.kind === "show" ? showCell(disc, 2, 4) : movieCell(disc, 2, 4));
    }
    const morePages = ci < core.length || discovery[p + 1];
    if (morePages)                               // exactly the songs board's More
      buttons.push({ label: "More", type: "control", symbol: "more",
                     load: "movies-" + (p + 2), row: 3, col: 1 });
    // no exit tile (D57b): the msgbar door exits, like every other board
    boards.push({ id, name: "What do I want to watch?", rows: 3, columns: 4, buttons });
    p++;
    if (!morePages) break;
  }

  // per-show episode pages + the "<show>-next" what-next board
  for (const t of core.concat(discovery)) {
    if (t.kind !== "show") continue;
    const eps = t.episodes, per = MOVIE_EP_CELLS.length;
    const epPages = Math.ceil(eps.length / per);
    for (let p = 0; p < epPages; p++) {
      const id = p === 0 ? t.id : t.id + "-" + (p + 1);
      const buttons = [{ label: "Back", say: "back", type: "back", glyph: "←",
                         load: p === 0 ? (doorPage[t.id] || "movies")
                             : (p === 1 ? t.id : t.id + "-" + p),
                         row: 1, col: 1 }];
      eps.slice(p * per, (p + 1) * per).forEach((ep, i) => {
        const [row, col] = MOVIE_EP_CELLS[i];
        buttons.push(episodeCell(t, ep, row, col));
      });
      if (p < epPages - 1)
        buttons.push({ label: "More", type: "control", symbol: "more",
                       load: t.id + "-" + (p + 2), row: 3, col: 1 });
      boards.push({ id, name: t.title, rows: 3, columns: 4, buttons });
    }
    // the post-episode choice screen (replaces autoplay; spec beat 6).
    // P3-SEAM(recommender): v1 next = first playable, again = LAST playable
    // (deterministic stand-ins for next-unwatched / last-watched).
    boards.push({
      id: t.id + "-next", name: "What next?", rows: 3, columns: 4,
      buttons: [
        episodeCell(t, eps[0], 1, 2, "next"),
        episodeCell(t, eps[eps.length - 1], 1, 3, "again"),
        { label: "Something else", say: "something else", type: "control",
          load: "movies", row: 3, col: 2 },
        exitCell(),
      ],
    });
  }
  return {
    recipe: { locale: "en-US", root: "movies", home_label: "Movies",
              meta: { pendingCount: pending }, boards },
    etag,
  };
}
function serveMoviesRecipe(req, res) {
  let out;
  try { out = moviesRecipe(); }
  catch (e) {   // belt & braces: even a generator bug degrades to empty-but-alive
    console.error("[movies] recipe failed: " + e.message);
    out = { recipe: { locale: "en-US", root: "movies", home_label: "Movies",
                      meta: { pendingCount: 0 },
                      boards: [{ id: "movies", name: "What do I want to watch?",
                                 rows: 3, columns: 4,
                                 buttons: [{ label: "All done", say: "all done",
                                             type: "exit", row: 3, col: 4 }] }] },
            etag: '"err-' + Date.now() + '"' };
  }
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-cache",
                    "ETag": out.etag, "Access-Control-Allow-Origin": "*" };
  if ((req.headers["if-none-match"] || "") === out.etag) { res.writeHead(304, headers).end(); return; }
  if (req.method === "HEAD") { res.writeHead(200, headers).end(); return; }
  res.writeHead(200, headers);
  res.end(JSON.stringify(out.recipe));
}

// Fetch one symbol PNG from ARASAAC into the disk cache. Returns the file path
// on success, null on any failure (never throws).
async function fetchSymbolToCache(name) {
  const file = path.join(SYMBOLS_CACHE, name + ".png");
  try {
    let id;
    if (/^\d+$/.test(name)) {
      id = name;   // exact ARASAAC pictogram id (recipes pin one when bestsearch
                   // guesses wrong — "stop" finds a bus stop; 8289 IS the stop sign)
    } else {
      const r = await fetch(ARASAAC_API + encodeURIComponent(name));
      if (!r.ok) return null;
      const hits = await r.json();
      if (!Array.isArray(hits) || !hits.length) return null;
      id = hits[0]._id;
    }
    const img = await fetch(ARASAAC_IMG.replace(/\{id\}/g, String(id)));
    if (!img.ok) return null;
    const buf = Buffer.from(await img.arrayBuffer());
    fs.writeFileSync(file, buf);
    return file;
  } catch (e) {
    console.error("[symbol] lookup failed for '" + name + "': " + e.message);
    return null;
  }
}

// GET /symbol/:name — cached PNG, fetching from ARASAAC on a miss.
async function serveSymbol(res, name) {
  if (!/^[a-z0-9-]+$/.test(name)) { res.writeHead(404).end("not found"); return; }
  const file = path.join(SYMBOLS_CACHE, name + ".png");
  let cached = fs.existsSync(file);
  if (!cached) {
    const got = await fetchSymbolToCache(name);
    if (!got) { console.error("[symbol] no match for '" + name + "'"); res.writeHead(404).end("not found"); return; }
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400",
                         "X-Symbol-Cache": cached ? "hit" : "miss" });
    res.end(data);
  });
}

// ---- ElevenLabs TTS (proxied + cached; falls back to Windows TTS client-side) ----
// Key: put ELEVENLABS_API_KEY=... in tts-config.json ("apiKey") or the environment.
const TTS_CFG_PATH = path.join(DATA, "tts-config.json");
const CURATED_VOICES = [
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica — playful American" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah — soft & warm" },
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel — calm narrator" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda — friendly" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily — warm British" }
];
// Is this ElevenLabs key real? (cheap call, no synthesis, no quota spend)
async function verifyTtsKey(key) {
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/user/subscription",
      { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      let tier = "";
      try { tier = (await r.json()).tier || ""; } catch {}
      return { ok: true, tier };
    }
    if (r.status === 401) return { ok: false, error: "ElevenLabs did not recognise that key - check for a missing character" };
    return { ok: false, error: "ElevenLabs replied " + r.status };
  } catch (e) { return { ok: false, error: "could not reach ElevenLabs (offline?)" }; }
}

function loadTtsCfg() {
  let cfg = { apiKey: process.env.ELEVENLABS_API_KEY || "", voiceId: CURATED_VOICES[0].id,
              modelId: "eleven_flash_v2_5" };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(TTS_CFG_PATH, "utf8")) }; } catch {}
  if (!cfg.apiKey && process.env.ELEVENLABS_API_KEY) cfg.apiKey = process.env.ELEVENLABS_API_KEY;
  return cfg;
}
function saveTtsCfg(cfg) { fs.writeFileSync(TTS_CFG_PATH, JSON.stringify(cfg, null, 2)); }
async function elevenTts(cfg, text) {
  const key = crypto.createHash("sha1").update(cfg.voiceId + "|" + cfg.modelId + "|" + text).digest("hex");
  const file = path.join(TTS_CACHE, key + ".mp3");
  if (fs.existsSync(file)) return fs.readFileSync(file);       // repeat lines are free
  const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + cfg.voiceId +
                        "?output_format=mp3_22050_32", {
    method: "POST",
    headers: { "xi-api-key": cfg.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: cfg.modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
  });
  if (!r.ok) throw new Error("elevenlabs " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
               ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
               ".woff2": "font/woff2", ".mp3": "audio/mpeg",
               ".mp4": "video/mp4", ".wav": "audio/wav",
               ".m4a": "audio/mp4", ".webm": "audio/webm", ".opus": "audio/ogg",
               ".webp": "image/webp",
               ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
               ".ico": "image/x-icon" };

// ---- email published writing to the family (optional; Resend key + recipient
// come from the overlay data dir, never from this repo) ----
// Audit 9/2: nothing in the product ever WROTE these two values, so on every
// public install The Pencil said "Sent! Your words are on their way" while the
// hub logged "writing saved only". Settings now has a card for them
// (POST /mail-config, which proves the pair by sending a real test email),
// /publish reports honestly whether the words were mailed, and unsent
// writings are retried so a flaky moment never loses her message.
const RESEND_URL = process.env.ERA_RESEND_URL || "https://api.resend.com/emails";
const WRITINGS = () => path.join(DATA, "writings");
function resendKey() {
  try {
    const env = fs.readFileSync(path.join(DATA, "credentials.env"), "utf8");
    const m = env.match(/^RESEND_API_KEY=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}
function saveResendKey(key) {
  const f = path.join(DATA, "credentials.env");
  let env = ""; try { env = fs.readFileSync(f, "utf8"); } catch {}
  env = env.split(/\r?\n/).filter(l => l && !l.startsWith("RESEND_API_KEY=")).join("\n");
  fs.writeFileSync(f, (env ? env + "\n" : "") + "RESEND_API_KEY=" + key + "\n", { mode: 0o600 });
}
function mailConfigured() { return !!(resendKey() && PROFILE.publishEmail); }
// Resend's own error text is developer-speak; say what a parent can act on.
function mailErrorFor(status, text) {
  if (status === 401) return "Resend did not recognise that key — check for a missing character";
  if (status === 403 || /own email|testing emails/i.test(text))
    return "Resend's free sender only delivers to the email address you signed up to Resend with — use that one here";
  if (status === 422) return "Resend did not accept that email address";
  if (status === 429) return "Resend says too many emails for now — try again in a minute";
  return "Resend answered " + status + " — try again in a minute";
}
async function resendSend(key, to, subject, html) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(RESEND_URL, {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "The Pencil <onboarding@resend.dev>", to: [to], subject, html })
    });
    if (!r.ok) { const t = (await r.text()).slice(0, 200); return { ok: false, error: mailErrorFor(r.status, t), detail: t }; }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "could not reach Resend (" + (e.name === "AbortError" ? "timed out" : "no connection") + ")" };
  } finally { clearTimeout(timer); }
}
function writingHtml(rec, who, when) {
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
  return "<div style=\"font-family:Georgia,serif\">" +
    "<p style=\"font-size:28px;line-height:1.5\">“" + esc(rec.text) + "”</p>" +
    "<p style=\"color:#777\">— " + esc(who) + ", with The Pencil · " + esc(when) + "</p>" +
    "<p style=\"color:#999;font-size:13px\">Write back — a young writer loves an audience that answers.</p></div>";
}
// Send one saved writing. Returns {ok, error}; never throws. The writing file
// carries `mailed` so a failed send is retried later, not forgotten.
async function emailWriting(rec, file) {
  const key = resendKey(), to = PROFILE.publishEmail;
  let v;
  if (!key || !to) { console.log("[mail] no family email set up; writing saved for Settings"); v = { ok: false, error: "not configured" }; }
  else {
    const who = PROFILE.childName || "your writer";
    const when = new Date(rec.t || Date.now()).toLocaleString("en-US", { timeZone: TZ });
    v = await resendSend(key, to,
      "✏️ " + who + " wrote: “" + String(rec.text).slice(0, 60) + "”", writingHtml(rec, who, when));
    if (v.ok) console.log("[mail] sent:", String(rec.text).slice(0, 40));
    else console.error("[mail] not sent:", v.error, v.detail || "");
  }
  if (file) {
    try {
      const cur = JSON.parse(fs.readFileSync(file, "utf8"));
      cur.mailed = v.ok ? new Date().toISOString() : false;
      if (v.ok) delete cur.mailError; else cur.mailError = v.error;
      fs.writeFileSync(file, JSON.stringify(cur, null, 2));
    } catch {}
  }
  return v;
}
function listWritings(limit) {
  let out = [];
  try {
    out = fs.readdirSync(WRITINGS()).filter(f => f.endsWith(".json")).sort().reverse().slice(0, limit || 20)
      .map(f => { try { return { file: f, ...JSON.parse(fs.readFileSync(path.join(WRITINGS(), f), "utf8")) }; } catch { return null; } })
      .filter(r => r && typeof r.text === "string");
  } catch {}
  return out.map(r => ({ file: r.file, t: r.t, text: r.text, mailed: r.mailed || false, mailError: r.mailError }));
}
// Retry writings that never went out (boot + every 30 min): a send that failed
// because the wifi blinked, or one written before the family set up email,
// must not stay "Saved" forever once mail works.
let mailRetryBusy = false;
async function retryUnsentWritings() {
  if (mailRetryBusy || !mailConfigured()) return;
  mailRetryBusy = true;
  try {
    for (const r of listWritings(50).filter(r => !r.mailed).reverse()) {
      const v = await emailWriting(r, path.join(WRITINGS(), r.file));
      if (!v.ok) break;   // provider down or key bad — try again next time
    }
  } finally { mailRetryBusy = false; }
}
setTimeout(() => retryUnsentWritings().catch(() => {}), 20000).unref();
setInterval(() => retryUnsentWritings().catch(() => {}), 30 * 60 * 1000).unref();

function safeDecode(u) {
  try { return decodeURIComponent(u); } catch { return null; }
}
// ---- Book Reader dwell mirror (one knob) ----
// Book Reader (separate Next.js/Vercel stack) keeps its own per-child dwell
// in Supabase; its HTTPS pages cannot fetch this HTTP server (mixed content),
// so the ONE dwell knob propagates the other way — a settings-page change
// pushes dwell_ms into child_profiles server-side. Fire-and-forget: the
// reader falls back to its stored value whenever this fails. Creds are read
// at call time from Book-Reader's own .env.local (never committed here).
const READER_ENV = process.env.ERA_READER_ENV || require("path").join(DATA, "reader.env");
function pushReaderDwell(ms) {
  let env = {};
  try {
    for (const line of fs.readFileSync(READER_ENV, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch { return; }
  const url = env.NEXT_PUBLIC_SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  fetch(url + "/rest/v1/child_profiles?id=not.is.null", {
    method: "PATCH",
    headers: { apikey: key, Authorization: "Bearer " + key,
               "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ dwell_ms: Math.max(600, Math.min(3000, ms)) }),
  }).then(r => { if (!r.ok) console.error("reader dwell push failed:", r.status); })
    .catch(e => console.error("reader dwell push failed:", e.message));
}

const server = http.createServer((req, res) => {
  // shared app settings (dwell time, chosen voice) — apps read at boot
  if (req.method === "GET" && req.url === "/settings") {
    let s = { dwellMs: 1200, settleMs: 250, musicVolCap: 100,
              voiceId: loadTtsCfg().voiceId,
              childName: PROFILE.childName || "friend", hasProfile: HAS_PROFILE,
              personalWords: [] };
    try {
      const lex = JSON.parse(fs.readFileSync(path.join(DATA, "personal-lexicon.json"), "utf8"));
      if (Array.isArray(lex)) s.personalWords = lex.map(w => typeof w === "string" ? w : w.word).filter(Boolean);
    } catch {}
    try { s = { ...s, ...JSON.parse(fs.readFileSync(path.join(DATA, "app-settings.json"), "utf8")) }; } catch {}
    s.voiceId = loadTtsCfg().voiceId;
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(s));
    return;
  }
  if (req.method === "POST" && req.url === "/settings") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const inc = JSON.parse(body);
        let s = {};
        try { s = JSON.parse(fs.readFileSync(path.join(DATA, "app-settings.json"), "utf8")); } catch {}
        if (typeof inc.dwellMs === "number") s.dwellMs = Math.max(600, Math.min(3000, inc.dwellMs));
        if (typeof inc.settleMs === "number") s.settleMs = Math.max(0, Math.min(2000, inc.settleMs));
        // music loudness cap, % of speaker volume (Songs Board; dad 8/24)
        if (typeof inc.musicVolCap === "number")
          s.musicVolCap = Math.max(1, Math.min(100, Math.round(inc.musicVolCap)));
        fs.writeFileSync(path.join(DATA, "app-settings.json"), JSON.stringify(s, null, 2));
        // one knob: mirror a dwell change into Book Reader's profile store
        if (typeof inc.dwellMs === "number") pushReaderDwell(s.dwellMs);
        if (inc.voiceId && CURATED_VOICES.some(v => v.id === inc.voiceId)) {
          const cfg = loadTtsCfg(); cfg.voiceId = inc.voiceId; saveTtsCfg(cfg);
        }
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  // first-run wizard: create the family profile (idempotent — updates too)
  if (req.method === "POST" && req.url === "/setup") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const inc = JSON.parse(body);
        const name = String(inc.childName || "").trim().slice(0, 40);
        if (!name) { res.writeHead(400).end("childName required"); return; }
        let cur = {};   // merge from DISK — other tools may have written keys
        try { cur = JSON.parse(fs.readFileSync(path.join(DATA, "profile.json"), "utf8")); } catch {}
        const prof = { ...cur, childName: name };
        if (inc.tz && typeof inc.tz === "string") prof.tz = inc.tz.slice(0, 60);
        if (inc.deviceId && /^[a-z0-9-]{1,32}$/.test(inc.deviceId)) prof.deviceId = inc.deviceId;
        fs.writeFileSync(path.join(DATA, "profile.json"), JSON.stringify(prof, null, 2) + "\n");
        loadProfile();
        if (typeof inc.dwellMs === "number") {
          let a = {}; try { a = JSON.parse(fs.readFileSync(path.join(DATA, "app-settings.json"), "utf8")); } catch {}
          a.dwellMs = Math.max(600, Math.min(3000, inc.dwellMs));
          fs.writeFileSync(path.join(DATA, "app-settings.json"), JSON.stringify(a, null, 2));
        }
        // the wizard's app chooser (the package ships no installer script —
        // shortcuts are made HERE for the chosen apps)
        if (Array.isArray(inc.apps)) {
          const chosen = APPS.filter(a => inc.apps.includes(a.id));
          fs.writeFileSync(path.join(DATA, "apps.json"),
            JSON.stringify({ enabled: chosen.map(a => a.id) }, null, 2));
          for (const a of APPS) appShortcut(a, chosen.some(c => c.id === a.id));
          appShortcut({ title: "New ERA", path: "/home/" }, true);   // the home door
          reconcileApps();   // chosen-but-missing apps (the gaze engine) install now
        }
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  if (req.method === "GET" && req.url === "/voices") {
    const cfg = loadTtsCfg();
    res.writeHead(200, { "Content-Type": "application/json" });
    // enabled means "this key actually works", not "a key is present": a
    // mistyped key used to show 'Premium voices active' and then say nothing
    // out loud (QA 9/1). cfg.keyOk is set when the key is saved/verified.
    res.end(JSON.stringify({ enabled: !!cfg.apiKey && cfg.keyOk !== false,
      keyPresent: !!cfg.apiKey, keyOk: cfg.keyOk === true,
      keyError: cfg.keyError || "", current: cfg.voiceId, voices: CURATED_VOICES }));
    return;
  }
  if (req.method === "POST" && req.url === "/voice") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const { voiceId } = JSON.parse(body);
        if (!CURATED_VOICES.some(v => v.id === voiceId)) { res.writeHead(400).end(); return; }
        const cfg = loadTtsCfg(); cfg.voiceId = voiceId; saveTtsCfg(cfg);
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/tts") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on("end", async () => {
      try {
        const { text } = JSON.parse(body);
        const cfg = loadTtsCfg();
        if (!cfg.apiKey || !text || text.length > 600) { res.writeHead(503).end(); return; }
        const buf = await elevenTts(cfg, String(text));
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "max-age=86400" });
        res.end(buf);
      } catch (e) { res.writeHead(502).end(); }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/runway") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const { pointer } = JSON.parse(body);
        const rp = path.join(PUB, "runway.json");
        const rw = JSON.parse(fs.readFileSync(rp, "utf8"));
        if (typeof pointer !== "number" || pointer < 0 || pointer >= rw.sequence.length) { res.writeHead(400).end(); return; }
        rw.pointer = pointer;
        fs.writeFileSync(rp, JSON.stringify(rw, null, 1));
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/publish") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 65536) req.destroy(); });
    req.on("end", async () => {
      try {
        const rec = JSON.parse(body);
        if (typeof rec.text !== "string" || !rec.text.trim()) { res.writeHead(400).end(); return; }
        fs.mkdirSync(WRITINGS(), { recursive: true });
        const name = new Date().toISOString().replace(/[:.]/g, "-") + ".json";
        const file = path.join(WRITINGS(), name);
        fs.writeFileSync(file, JSON.stringify({ ...rec, mailed: false }, null, 2));
        // Her words are safe on disk before anything else. Then tell The Pencil
        // the truth: mailed (a real Resend accept, ≤8s), saved-for-Settings
        // (no family email set up), or saved-and-will-retry (send failed).
        const v = mailConfigured() ? await emailWriting(rec, file) : { ok: false, error: "not configured" };
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ saved: true, mailed: v.ok,
          reason: v.ok ? undefined : (v.error === "not configured" ? "not configured" : "failed") }));
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  // ---- family email for The Pencil (Settings card) ----
  if (req.method === "GET" && req.url === "/mail-config") {
    let st = {}; try { st = JSON.parse(fs.readFileSync(path.join(DATA, "mail-status.json"), "utf8")); } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ email: PROFILE.publishEmail || "", hasKey: !!resendKey(),
      ok: st.ok, error: st.error || "", writings: listWritings(10) }));
    return;
  }
  if (req.method === "POST" && req.url === "/mail-config") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", async () => {
      try {
        const inc = JSON.parse(body);
        const email = String(inc.email || "").trim().slice(0, 120);
        const key = typeof inc.apiKey === "string" ? inc.apiKey.trim().slice(0, 200) : "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.writeHead(400).end("email"); return; }
        if (!key && !resendKey()) { res.writeHead(400).end("key"); return; }
        let cur = {}; try { cur = JSON.parse(fs.readFileSync(path.join(DATA, "profile.json"), "utf8")); } catch {}
        fs.writeFileSync(path.join(DATA, "profile.json"), JSON.stringify({ ...cur, publishEmail: email }, null, 2) + "\n");
        if (key) saveResendKey(key);
        loadProfile();
        // Prove the pair the way /tts-key proves a voice key: a real send. The
        // family sees the test email land, or a reason they can act on.
        const who = PROFILE.childName || "your child";
        const v = await resendSend(resendKey(), email, "✏️ The Pencil is connected",
          "<div style=\"font-family:Georgia,serif\"><p style=\"font-size:22px\">When " +
          who.replace(/[&<>]/g, "") + " sends a message from The Pencil, it will arrive here.</p></div>");
        fs.writeFileSync(path.join(DATA, "mail-status.json"), JSON.stringify({ ok: v.ok, error: v.error || "", at: new Date().toISOString() }));
        if (v.ok) retryUnsentWritings().catch(() => {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: v.ok, error: v.error }));
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  // ---- board outfit events: picks -> history.json (feeds the generator) ----
  // The 6:35 generator derives wear from these (a Yes = confirmed; otherwise the
  // day's last select is inferred at half weight) to seat the staple slots.
  if (req.method === "POST" && req.url === "/outfit-event") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const { kind, combo } = JSON.parse(body);
        const ok = (kind === "select" || kind === "yes") &&
          Array.isArray(combo) && combo.length >= 1 && combo.length <= 2 &&
          combo.every(id => typeof id === "string" && /^item_[0-9a-f]{4,32}$/.test(id));
        if (!ok) { res.writeHead(400).end(); return; }
        const day = new Date().toLocaleDateString("en-CA", { timeZone: TZ });  // family-profile tz buckets the day
        const hp = path.join(WARDROBE_DIR, "history.json");
        let h = {};
        try { h = JSON.parse(fs.readFileSync(hp, "utf8")); } catch {}
        if (typeof h !== "object" || h === null || Array.isArray(h)) h = {};
        h.events = h.events || {};
        const evs = h.events[day] = h.events[day] || [];
        // cap per day: a stuck client can't grow the file unboundedly
        if (evs.length < 200) evs.push({ kind, combo, at: new Date().toISOString() });
        // a fresh install has no wardrobe/ yet — without this every pick 400'd
        // and the board dropped it, so favourites were never learned (QA 9/2)
        fs.mkdirSync(WARDROBE_DIR, { recursive: true });
        fs.writeFileSync(hp, JSON.stringify(h, null, 2) + "\n");
        pool.append("outfit-" + kind, { combo });
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  // ---- songs board events: play/stop/end -> family pool (usage visibility) ----
  if (req.method === "POST" && req.url === "/music-event") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const { songId, action } = JSON.parse(body);
        const ok = ["play", "stop", "end", "full"].includes(action) &&
          typeof songId === "string" && /^[a-z0-9-]{1,64}$/.test(songId);
        if (!ok) { res.writeHead(400).end(); return; }
        pool.append("music-" + action, { songId });
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  // ---- movies board events: launch/playing/pause/end/abandon/alldone ->
  // family pool (movie-player P1). Feeds the P3 recommender read-side and
  // dad's curation/demotion review; clone of /music-event. ----
  if (req.method === "POST" && req.url === "/movie-event") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const { titleId, action, service, episode } = JSON.parse(body);
        const ok = ["launch", "playing", "pause", "end", "abandon", "alldone"].includes(action) &&
          typeof titleId === "string" && /^[a-z0-9-]{1,64}$/.test(titleId) &&
          ["disney", "netflix", "prime"].includes(service) &&
          (episode === undefined ||
            (episode !== null && typeof episode === "object" &&
             Number.isInteger(episode.s) && Number.isInteger(episode.e) &&
             episode.s >= 0 && episode.s <= 999 && episode.e >= 0 && episode.e <= 999));
        if (!ok) { res.writeHead(400).end(); return; }
        const rec = { titleId, service };
        if (episode !== undefined) rec.episode = { s: episode.s, e: episode.e };
        pool.append("movie-" + action, rec);
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/log") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 65536) req.destroy(); });
    req.on("end", () => {
      try {
        JSON.parse(body); // validate
        const day = new Date().toISOString().slice(0, 10);
        fs.appendFileSync(path.join(LOGS, day + ".jsonl"), body.replace(/\n/g, " ") + "\n");
        pool.append("app-log", { entry: JSON.parse(body) });
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  // ---- board data routes (GET/HEAD, read-only, path-jailed) ----
  const urlPath = safeDecode((req.url || "/").split("?")[0]);
  if (urlPath === null) { res.writeHead(400).end(); return; }
  // ---- word prediction (Pencil; see predict.js — her writing > her lexicon > corpus) ----
  if (req.method === "GET" && urlPath === "/predict") {
    try {
      const q = new URL(req.url, "http://x").searchParams;
      const n = Math.min(8, parseInt(q.get("n"), 10) || 3);
      const words = predictor.predict(q.get("left") || "", q.get("prefix") || "", n);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ words }));
    } catch (e) {
      console.error("[predict] " + e.message);
      try { res.writeHead(200, { "Content-Type": "application/json" }).end('{"words":[]}'); } catch {}
    }
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && urlPath === "/recipes/today.json") {
    serveRecipe(req, res); return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && urlPath === "/recipes/songs.json") {
    serveSongsRecipe(req, res); return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && urlPath === "/recipes/movies.json") {
    serveMoviesRecipe(req, res); return;
  }
  if (req.method === "GET" && urlPath.startsWith("/music/")) {
    serveMediaJail(req, res, MUSIC_DIR, urlPath.slice("/music/".length), MUSIC_EXTS, MUSIC_AV_EXTS);
    return;
  }
  // movies static jail: posters + catalog only (no AV extensions — the hub
  // never serves video; av list empty so nothing gets Range handling)
  if (req.method === "GET" && urlPath.startsWith("/movies/")) {
    serveMediaJail(req, res, MOVIES_DIR, urlPath.slice("/movies/".length), MOVIE_EXTS, []);
    return;
  }
  if (req.method === "GET" && urlPath.startsWith("/clothing-web/")) {
    serveJailed(res, path.join(DATA, "clothing-web"), safeDecode(urlPath.slice("/clothing-web/".length)) || "", [".jpg", ".jpeg", ".png", ".webp"]);
    return;
  }
  if (req.method === "GET" && urlPath.startsWith("/wardrobe/")) {
    serveJailed(res, WARDROBE_DIR, urlPath.slice("/wardrobe/".length), [".jpg", ".jpeg", ".png"]);
    return;
  }
  // cataloged item tiles + daily composite outfits (clothing.js ingest output)
  if (req.method === "GET" && urlPath.startsWith("/wardrobe-items/")) {
    serveJailed(res, path.join(DATA, "wardrobe-items"), safeDecode(urlPath.slice("/wardrobe-items/".length)) || "", [".jpg"]);
    return;
  }
  if (req.method === "GET" && urlPath.startsWith("/wardrobe-outfits/")) {
    serveJailed(res, path.join(DATA, "wardrobe-outfits"), safeDecode(urlPath.slice("/wardrobe-outfits/".length)) || "", [".jpg"]);
    return;
  }
  if (req.method === "GET" && urlPath.startsWith("/gen-assets/")) {
    serveJailed(res, GEN_ASSETS_DIR, urlPath.slice("/gen-assets/".length), [".png"]);
    return;
  }
  // ---- book packages: shelf index (rebuilt per request) + jailed files ----
  if (req.method === "GET" && urlPath === "/books/index.json") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(booksIndex()));
    return;
  }
  if (req.method === "GET" && urlPath.startsWith("/books/")) {
    serveBook(req, res, urlPath.slice("/books/".length));
    return;
  }
  if (req.method === "GET" && urlPath.startsWith("/symbol/")) {
    serveSymbol(res, urlPath.slice("/symbol/".length)).catch((e) => {
      console.error("[symbol] route error: " + e.message);
      try { res.writeHead(500).end(); } catch {}
    });
    return;
  }

  // ---- app picker: which apps this install offers (install-with-checkboxes,
  // 8/29 ruling: everything, one, or a few) ----
  if (req.method === "GET" && urlPath === "/apps") {
    const enabled = loadEnabledApps();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ apps: APPS.map(a => ({ id: a.id, title: a.title, sub: a.sub, path: a.path,
      engine: !!a.engine, enabled: enabled.includes(a.id), installed: appInstalled(a),
      installing: !!appInstalling[a.id],
      building: a.id === "board" ? clothing.isBuilding() : false })) }));
    return;
  }
  if (req.method === "POST" && req.url === "/apps") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const { id, enabled } = JSON.parse(body);
        const app = APPS.find(a => a.id === id);
        if (!app || typeof enabled !== "boolean") { res.writeHead(400).end(); return; }
        let set = loadEnabledApps().filter(x => x !== id);
        if (enabled) set.push(id);
        fs.writeFileSync(path.join(DATA, "apps.json"),
          JSON.stringify({ enabled: APPS.map(a => a.id).filter(x => set.includes(x)) }, null, 2));
        appShortcut(app, enabled);   // Windows: desktop/start-menu .lnk follows the toggle
        // enabling an app whose files were never installed REALLY installs it
        if (enabled && !appInstalled(app) && !appInstalling[app.id]) {
          appInstalling[app.id] = true;
          (app.engine ? installGaze() : installPack(app))
            .catch(e => console.error("[apps] pack install failed: " + e.message))
            .finally(() => { delete appInstalling[app.id]; });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ installing: true }));
          return;
        }
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }

  // ---- open an external site in a NORMAL browser window (URL bar and all)
  // — kiosk windows trap novices on web logins (dad 8/29) ----
  if (req.method === "POST" && req.url === "/open-url") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 1024) req.destroy(); });
    req.on("end", () => {
      try {
        const { url } = JSON.parse(body);
        // every "Open my … keys page" button in Settings must be here, or the
        // page falls back to window.open INSIDE the kiosk — dad hit that on
        // Resend during his 9/3 novice run ("match the way Drive/ElevenLabs
        // work, they come to the front")
        const ALLOW = ["https://www.google.com/drive/", "https://elevenlabs.io/",
                       "https://resend.com/", "https://console.anthropic.com/",
                       "https://platform.openai.com/", "https://aistudio.google.com/"];
        if (typeof url !== "string" || !ALLOW.some(a => url.startsWith(a))) { res.writeHead(400).end(); return; }
        if (process.platform === "win32") {
          const { spawn } = require("child_process");
          const browsers = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
                            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"];
          const b = browsers.find(p => fs.existsSync(p));
          if (b) {
            spawn(b, ["--new-window", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
            setTimeout(stepAsideFromKiosk, 1200);   // our kiosk yields; the new window shows
            res.writeHead(200, { "Content-Type": "application/json" }).end('{"opened":true}');
            return;
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"opened":false}');
      } catch { res.writeHead(400).end(); }
    });
    return;
  }

  // ---- per-app file removal (dad 8/29: uncheck hides; delete should exist) ----
  if (req.method === "POST" && req.url === "/apps/delete") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const { id } = JSON.parse(body);
        const app = APPS.find(a => a.id === id);
        if (!app) { res.writeHead(400).end(); return; }
        const enabled = loadEnabledApps();
        if (enabled.includes(id)) { res.writeHead(409).end("disable first"); return; }
        if (app.engine) {
          try { fs.rmSync(GAZE_DIR, { recursive: true, force: true }); } catch {}
        } else if (app.pack) {
          // the board pack is shared: only removable when board+music+movies are ALL off
          const sharers = APPS.filter(a => a.pack === app.pack).map(a => a.id);
          if (sharers.some(x => enabled.includes(x))) { res.writeHead(409).end("pack in use"); return; }
          try { fs.rmSync(path.join(PUB, app.pack), { recursive: true, force: true }); } catch {}
        } else { res.writeHead(400).end("core app"); return; }
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/integrations/drive/create-folder") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(drive.createContentFolder()));
    return;
  }

  // ---- Settings > Voice: ElevenLabs key entry (never echoed back) ----
  if (req.method === "POST" && req.url === "/tts-key") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const { apiKey } = JSON.parse(body);
        if (typeof apiKey !== "string" || apiKey.length > 200) { res.writeHead(400).end(); return; }
        const cfg = loadTtsCfg();
        cfg.apiKey = apiKey.trim(); cfg.keyOk = undefined; cfg.keyError = "";
        saveTtsCfg(cfg);
        // Ask ElevenLabs whether the key is real before telling the family it
        // is. A dropped character otherwise reads as success and then silence.
        verifyTtsKey(cfg.apiKey).then((v) => {
          const c = loadTtsCfg();
          c.keyOk = v.ok; c.keyError = v.error || ""; saveTtsCfg(c);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(v));
        }).catch(() => { res.writeHead(200, { "Content-Type": "application/json" })
          .end('{"ok":false,"error":"could not reach ElevenLabs"}'); });
      } catch { res.writeHead(400).end(); }
    });
    return;
  }

  // ---- exit door fallback: close this app's kiosk window ----
  // The apps ask ERAgaze to close them (it also foregrounds TD Snap), but an
  // engine compiled before 9/1 swept only chrome.exe and matched the wrong
  // tag, so the app stayed running behind TD Snap (dad 9/1, Making Words and
  // The Pencil). The hub is always present and can always close its own kiosk.
  if (req.method === "POST" && urlPath === "/kiosk/close") {
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    if (process.platform === "win32") {
      const { spawn } = require("child_process");
      const ps =
        "Get-CimInstance Win32_Process -Filter 'Name=" + "''" + "chrome.exe" + "''" +
        " or Name=" + "''" + "msedge.exe" + "''" + "' | " +
        "Where-Object { $_.CommandLine -like '*kiosk-profile*' } | ForEach-Object { " +
        "Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; 'closed ' + $_.ProcessId }";
      try {
        const out = fs.openSync(path.join(LOGS, "stepaside.log"), "a");
        fs.writeSync(out, new Date().toISOString() + " kiosk-close\n");
        const c = spawn("powershell.exe", ["-NoProfile", "-Command", ps],
          { stdio: ["ignore", out, out], windowsHide: true });
        c.on("exit", (code) => { try { fs.writeSync(out, "exit " + code + "\n"); fs.closeSync(out); } catch {} });
        c.unref();
      } catch {}
    }
    return;
  }

  // ---- Settings > AI helper: family's own model key (never echoed back).
  // Used by the Clothing Picker's photo ingest today; book-reader QA later.
  if (req.method === "POST" && req.url === "/ai-key") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const { apiKey, provider } = JSON.parse(body);
        if (typeof apiKey !== "string" || apiKey.length > 300) { res.writeHead(400).end(); return; }
        const prov = ["anthropic", "openai", "google"].includes(provider) ? provider : "google";
        fs.writeFileSync(path.join(DATA, "ai-config.json"),
          JSON.stringify({ provider: prov, apiKey: apiKey.trim() }, null, 1));
        res.writeHead(204).end();
        // a key arriving is the cue to catalog waiting photos right away
        setTimeout(() => clothing.regenerate(true).catch(() => {}), 500);
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  if (req.method === "GET" && urlPath === "/clothing/status") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(clothing.status()));
    return;
  }

  // ---- Settings > Integrations: Google Drive content (drive.js) ----
  if (req.method === "GET" && urlPath === "/integrations/drive/status") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(drive.status()));
    return;
  }
  if (req.method === "POST" && req.url === "/integrations/drive/connect") {
    drive.connect().then(r => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
    }).catch(e => { res.writeHead(502).end(String(e.message)); });
    return;
  }
  if (req.method === "POST" && req.url === "/integrations/drive/sync") {
    drive.sync().then(r => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
    }).catch(e => { res.writeHead(502).end(String(e.message)); });
    return;
  }
  if (req.method === "GET" && urlPath === "/integrations/drive/detect") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(drive.detectLocal()));
    return;
  }
  if (req.method === "POST" && req.url === "/integrations/drive/open") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 512) req.destroy(); });
    req.on("end", () => {
      try {
        const { target } = JSON.parse(body || "{}");
        const r = drive.openInExplorer(target === "folder" ? "folder" : "root");
        if (r.ok) setTimeout(stepAsideFromKiosk, 900);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  if (req.method === "GET" && urlPath === "/integrations/drive/browse") {
    const q = new URL(req.url, "http://x").searchParams;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(drive.browseLocal(q.get("path") || "")));
    return;
  }
  if (req.method === "POST" && req.url === "/integrations/drive/localfolder") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 2048) req.destroy(); });
    req.on("end", () => {
      try {
        const { folderPath } = JSON.parse(body);
        const r = drive.setLocalFolder(String(folderPath || ""));
        if (r.error) { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify(r)); return; }
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  if (req.method === "GET" && urlPath === "/integrations/drive/folders") {
    drive.listFolders().then(r => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
    }).catch(e => { res.writeHead(502).end(String(e.message)); });
    return;
  }
  if (req.method === "POST" && req.url === "/integrations/drive/folder") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 2048) req.destroy(); });
    req.on("end", () => {
      try {
        const { folderId } = JSON.parse(body);
        if (typeof folderId !== "string" || folderId.length > 128) { res.writeHead(400).end(); return; }
        drive.setFolder(folderId);
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }

  // ---- self-update: version probe (FE polls it) + on-demand check ----
  if (req.method === "GET" && urlPath === "/version") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ build: updater.runningBuild, disk: updater.currentBuild(),
                             updater: updater.enabled, pid: process.pid }));
    return;
  }
  if (req.method === "POST" && req.url === "/update/check") {
    updater.check(PORT).then((r) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
    });
    return;
  }

  // static
  let p = safeDecode((req.url || "/").split("?")[0]);
  if (p === null) { res.writeHead(400).end(); return; }
  // /pencil -> /pencil/ (301, query kept): app dirs typed without the trailing
  // slash used to 404 with a bare "not found" (install QA 8/28).
  if (!p.endsWith("/") && !path.extname(p)) {
    const dir = path.normalize(path.join(PUB, p));
    if (dir.startsWith(PUB) && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const q = (req.url || "").split("?")[1];
      res.writeHead(301, { Location: p + "/" + (q ? "?" + q : "") }).end();
      return;
    }
  }
  if (p.endsWith("/")) p += "index.html";
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
                         "Cache-Control": "no-cache" });
    res.end(data);
  });
});
// After a self-update the fresh hub starts while the old one is still
// letting its last responses drain — retry the bind until the port frees.
let bindTries = 0;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && bindTries++ < 40) {
    setTimeout(() => server.listen(PORT, BIND), 500);
    return;
  }
  throw e;
});
server.on("listening", () => {
  console.log("era-hub on http://" + BIND + ":" + PORT);
  updater.start(PORT);   // installed payloads only; checkouts are a no-op
  drive.start(DATA);     // Google Drive content mirror (no-op until connected)
  drive.onSynced = () => clothing.regenerate(true).catch(() => {});   // fresh photos -> fresh board
  clothing.start(DATA);  // the Clothing Picker generator (no-op without photos)
  clearStageOnce();      // first boot after install: minimize covering browsers
  setTimeout(reconcileApps, 5000).unref();   // installer-chosen apps install at first boot
  // Pre-warm the outfit symbol set in the background (non-blocking, best-effort).
  for (const name of PREWARM) {
    if (fs.existsSync(path.join(SYMBOLS_CACHE, name + ".png"))) continue;
    fetchSymbolToCache(name).then(f => { if (f) console.log("[symbol] pre-warmed " + name); });
  }
});
server.listen(PORT, BIND);
