// shortcuts.js — the Windows .lnk files the hub owns (Desktop, Start Menu,
// and Startup for the gaze engine), written through ONE PowerShell script.
//
// Two callers: server.js's appShortcut (a toggle, the wizard) and the boot
// pass reconcileShortcuts (rename spec R1). The boot pass rewrites every link
// the hub owns with the CURRENT install folder and titles, and removes the
// old-name "New ERA.lnk": after the installer or the device runbook moves the
// folder, the old links point at a path that no longer holds the hub, and
// nothing else would ever fix them (self-update never touched a .lnk).
"use strict";
const path = require("path");
const fs = require("fs");

const HOME_TITLE = "Our Era Comms";
const OLD_HOME_TITLE = "New ERA";   // links left by builds before the rename

// PowerShell single-quoted string: the only escape is '' for '. A title with an
// apostrophe ("Ellie's ...") would otherwise end the string mid-name.
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

// Where each link lives. The names are symbolic (the plan is readable off
// Windows); the PowerShell expression resolves the real folder on the device.
const DIRS = {
  Desktop: "[Environment]::GetFolderPath('Desktop')",
  "StartMenu\\Programs": "(Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs')",
  Startup: "[Environment]::GetFolderPath('Startup')",
};
// An engine (exe) also starts at logon; a page app never does.
function dirsFor(app) {
  return app.exe ? ["Desktop", "StartMenu\\Programs", "Startup"] : ["Desktop", "StartMenu\\Programs"];
}
function targetOf(app, dir) { return app.exe || path.win32.join(dir, "start-hub.bat"); }
function iconOf(app, dir, iconFor) {
  const own = iconFor ? iconFor(app) : null;
  return own || path.win32.join(dir, "public", "favicon.ico");
}
// default icon lookup: public/icons/<id>.ico beside this file, when it exists
function defaultIconFor(app) {
  const f = app.id ? path.join(__dirname, "public", "icons", app.id + ".ico") : "";
  return f && fs.existsSync(f) ? f : null;
}

// The script that writes (enabled) or removes (not) one app's links.
function shortcutScript(app, enabled, { dir, port, iconFor } = {}) {
  const dirs = "@(" + dirsFor(app).map(d => DIRS[d]).join(", ") + ")";
  const lnk = psQuote(app.title + ".lnk");
  if (!enabled) {
    return `foreach ($d in ${dirs}) {` +
      `Remove-Item (Join-Path $d ${lnk}) -Force -ErrorAction SilentlyContinue }`;
  }
  return `$w = New-Object -ComObject WScript.Shell;` +
    `foreach ($d in ${dirs}) {` +
    `$l = $w.CreateShortcut((Join-Path $d ${lnk}));` +
    `$l.TargetPath = ${psQuote(targetOf(app, dir))};` +
    (app.exe ? `` : `$l.Arguments = ${psQuote(port + ' "' + app.path + '"')};`) +
    `$l.WorkingDirectory = ${psQuote(dir)};` +
    // every shortcut wore a generic gear (QA 9/1) — carry an icon so a
    // parent can find the app on a crowded desktop
    `$l.IconLocation = ${psQuote(iconOf(app, dir, iconFor) + ",0")};` +
    `$l.WindowStyle = 7; $l.Save() }`;   // 7 = minimized: the launcher console never pops up
}

function runPowerShell(script, spawn) {
  try {
    // windowsHide: dad watched PowerShell windows appear for every shortcut.
    // -Command, not detached: the one spawn shape proven from the
    // console-less production hub.
    const c = spawn("powershell.exe", ["-NoProfile", "-Command", script],
      { stdio: "ignore", windowsHide: true });
    if (c && c.on) c.on("error", (e) => console.error("[apps] shortcut: " + e.message));
  } catch (e) { console.error("[apps] shortcut: " + e.message); }
}

// One app's links on or off (Windows only, best-effort — the home tile is the
// source of truth, the .lnk a convenience).
function applyShortcut(app, enabled, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== "win32") return;
  runPowerShell(shortcutScript(app, enabled, opts), opts.spawn || require("child_process").spawn);
}

// The boot pass. `apps` = the links the hub owns right now: each ENABLED app
// (and the engine only when it is installed — the caller passes it with its
// exe). The home door is always added. Returns the plan
// [{action: "write"|"delete", path, target}]; runs nothing off Windows or
// with dryRun.
function reconcileShortcuts({ apps = [], homeTitle = HOME_TITLE, dryRun = false, dir = __dirname,
  port = 8377, platform = process.platform, spawn, iconFor = defaultIconFor, returnScript = false } = {}) {
  const owned = [{ title: homeTitle, path: "/home/" }, ...apps.filter(a => a && a.title && (a.exe || a.path))];
  const plan = [];
  for (const app of owned) {
    for (const d of dirsFor(app)) plan.push({ action: "write", path: d + "\\" + app.title + ".lnk", target: targetOf(app, dir) });
  }
  const old = { title: OLD_HOME_TITLE, exe: "(old home door)" };   // exe: so Startup is swept too
  if (homeTitle !== OLD_HOME_TITLE) {
    for (const d of dirsFor(old)) plan.push({ action: "delete", path: d + "\\" + OLD_HOME_TITLE + ".lnk", target: null });
  }
  const script = [
    ...owned.map(a => shortcutScript(a, true, { dir, port, iconFor })),
    ...(homeTitle !== OLD_HOME_TITLE ? [shortcutScript(old, false)] : []),
  ].join("; ");
  if (!dryRun && platform === "win32") runPowerShell(script, spawn || require("child_process").spawn);
  return returnScript ? { plan, script } : plan;
}

module.exports = { HOME_TITLE, OLD_HOME_TITLE, psQuote, shortcutScript, applyShortcut, reconcileShortcuts };
