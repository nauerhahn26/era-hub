// shortcuts.test.mjs — the boot pass (rename spec R1): every .lnk the hub
// owns is rewritten at boot with the current install folder and the current
// titles, and the old-name "New ERA.lnk" goes. A folder move (installer
// .onInit, device runbook) leaves links pointing at the old path; this pass is
// what self-heals them. Nothing here may run PowerShell off Windows.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { reconcileShortcuts, shortcutScript, psQuote, HOME_TITLE, OLD_HOME_TITLE } = require("../shortcuts.js");

const DIR = "C:\\Users\\A\\AppData\\Local\\Our Era Comms";
const APPS = [
  { id: "making-words", title: "Making Words", path: "/" },
  { id: "reader", title: "Book Reader", path: "/reader/" },
  { id: "eragaze", title: "ERAgaze", path: null, exe: DIR + "\\gaze\\ERAgaze.exe" },
];

test("the home door is called Our Era Comms", () => {
  assert.equal(HOME_TITLE, "Our Era Comms");
  assert.equal(OLD_HOME_TITLE, "New ERA");
});

test("dryRun plan: home door + each enabled app + ERAgaze Startup, all under the current folder", () => {
  const plan = reconcileShortcuts({ apps: APPS, dryRun: true, dir: DIR, port: 8377 });
  const writes = plan.filter(p => p.action === "write");
  const bat = DIR + "\\start-hub.bat";
  // home door on Desktop + Start Menu, never Startup. The Startup link that
  // shares its name is the hub's logon start (spec 2026-10-19 §4.2), not the
  // door, so the door is selected outside Startup\.
  const home = writes.filter(p => p.path.endsWith("\\Our Era Comms.lnk") && !p.path.startsWith("Startup\\"));
  assert.deepEqual(home.map(p => p.path).sort(),
    ["Desktop\\Our Era Comms.lnk", "StartMenu\\Programs\\Our Era Comms.lnk"]);
  for (const h of home) assert.equal(h.target, bat);
  // a page app: Desktop + Start Menu, target start-hub.bat
  const reader = writes.filter(p => p.path.endsWith("\\Book Reader.lnk"));
  assert.equal(reader.length, 2);
  for (const r of reader) assert.equal(r.target, bat);
  // the engine: Desktop + Start Menu + Startup, target the exe
  const gaze = writes.filter(p => p.path.endsWith("\\ERAgaze.lnk"));
  assert.deepEqual(gaze.map(p => p.path).sort(),
    ["Desktop\\ERAgaze.lnk", "StartMenu\\Programs\\ERAgaze.lnk", "Startup\\ERAgaze.lnk"]);
  for (const g of gaze) assert.equal(g.target, DIR + "\\gaze\\ERAgaze.exe");
  // nothing for an app that was not passed in (disabled)
  assert.ok(!writes.some(p => /Clothing Picker/.test(p.path)));
});

test("dryRun plan deletes the old-name link on Desktop, Start Menu and Startup", () => {
  const plan = reconcileShortcuts({ apps: [], dryRun: true, dir: DIR, port: 8377 });
  const dels = plan.filter(p => p.action === "delete").map(p => p.path).sort();
  assert.deepEqual(dels,
    ["Desktop\\New ERA.lnk", "StartMenu\\Programs\\New ERA.lnk", "Startup\\New ERA.lnk"]);
});

test("apostrophes are doubled inside PowerShell single-quoted strings", () => {
  assert.equal(psQuote("Ellie's Day"), "'Ellie''s Day'");
  const s = shortcutScript({ id: "x", title: "Ellie's Books", path: "/reader/" }, true,
    { dir: "C:\\O'Brien\\Our Era Comms", port: 8377 });
  assert.match(s, /'Ellie''s Books\.lnk'/);
  assert.match(s, /'C:\\O''Brien\\Our Era Comms\\start-hub\.bat'/);
  // no lone apostrophe left inside a quoted value: strip every '' pair and
  // every quoted string, and no stray quote may remain
  const stripped = s.replace(/'(?:[^']|'')*'/g, "");
  assert.ok(!stripped.includes("'"), "unbalanced quote in: " + s);
  const all = reconcileShortcuts({ apps: [{ id: "y", title: "Ellie's Songs", path: "/" }], dryRun: true,
    dir: "C:\\O'Brien", port: 8377, returnScript: true });
  assert.ok(!all.script.replace(/'(?:[^']|'')*'/g, "").includes("'"));
});

test("off Windows nothing runs, even without dryRun, and the plan comes back", () => {
  let spawned = 0;
  const plan = reconcileShortcuts({ apps: APPS, dir: DIR, port: 8377, platform: "linux",
    spawn: () => { spawned++; return { on() { return this; } }; } });
  assert.equal(spawned, 0);
  assert.ok(Array.isArray(plan) && plan.length > 0);
});

test("on Windows (not dryRun) it spawns exactly one PowerShell for the whole pass", () => {
  const calls = [];
  reconcileShortcuts({ apps: APPS, dir: DIR, port: 8377, platform: "win32",
    spawn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() { return this; } }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "powershell.exe");
  assert.equal(calls[0].opts.windowsHide, true);
  const script = calls[0].args[calls[0].args.length - 1];
  assert.match(script, /'Our Era Comms\.lnk'/);
  assert.match(script, /Remove-Item .*'New ERA\.lnk'/);
  // dryRun on Windows runs nothing either
  const before = calls.length;
  reconcileShortcuts({ apps: APPS, dir: DIR, port: 8377, platform: "win32", dryRun: true,
    spawn: () => { calls.push(1); return { on() { return this; } }; } });
  assert.equal(calls.length, before);
});

test("server.js calls the boot pass after reconcileApps and appShortcut reuses the module's script", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(src, /reconcileApps\(\);\s*\n\s*reconcileBootShortcuts\(\);/);
  assert.match(src, /function appShortcut\(app, enabled\) \{\s*(\/\/.*\n\s*)?shortcuts\.applyShortcut\(/);
  assert.ok(!/CreateShortcut/.test(src), "the .lnk script lives in shortcuts.js only");
});

test("a Drawing shortcut opens /drawing/ and wears its own icon, not the generic one", () => {
  const { plan, script } = reconcileShortcuts({ apps: [{ id: "drawing", title: "Drawing", path: "/drawing/" }],
    dryRun: true, dir: DIR, port: 8377, returnScript: true });
  assert.deepEqual(plan.filter(p => p.action === "write" && p.path.endsWith("\\Drawing.lnk")).map(p => p.path).sort(),
    ["Desktop\\Drawing.lnk", "StartMenu\\Programs\\Drawing.lnk"]);
  assert.match(script, /'8377 "\/drawing\/"'/);
  assert.match(script, /drawing\.ico,0'/);
});

// ---- the hub survives a reboot (spec 2026-10-19 §4.2) ------------------------
// Startup\Our Era Comms.lnk -> start-hub.bat <port> --hub-only: at logon the
// launcher starts the hub and opens nothing. It rides with the home door —
// written by the boot pass AND by the wizard's own home-door script — so a
// fresh install has it before its first reboot. The door itself stays exactly
// Desktop + Start Menu.
const hubLinkRx = (title, port) => new RegExp(
  "\\$l = \\$w\\.CreateShortcut\\(\\(Join-Path \\(\\[Environment\\]::GetFolderPath\\('Startup'\\)\\) '" + title + "\\.lnk'\\)\\);" +
  "\\$l\\.TargetPath = '" + (DIR + "\\start-hub.bat").replace(/\\/g, "\\\\") + "';" +
  "\\$l\\.Arguments = '" + port + " --hub-only';" +
  "\\$l\\.WorkingDirectory = '" + DIR.replace(/\\/g, "\\\\") + "';" +
  "\\$l\\.IconLocation = '" + (DIR + "\\public\\favicon.ico").replace(/\\/g, "\\\\") + ",0';" +
  "\\$l\\.WindowStyle = 7; \\$l\\.Save\\(\\)");

test("the boot pass lays exactly one Startup hub link: start-hub.bat <port> --hub-only", () => {
  const { plan, script } = reconcileShortcuts({ apps: APPS, dryRun: true, dir: DIR, port: 8377,
    iconFor: () => null, returnScript: true });
  const writes = plan.filter(p => p.action === "write");
  const hub = writes.filter(p => p.path === "Startup\\Our Era Comms.lnk");
  assert.equal(hub.length, 1, "one Startup hub link in the plan");
  assert.deepEqual(hub[0], { action: "write", path: "Startup\\Our Era Comms.lnk", target: DIR + "\\start-hub.bat" });
  // the plan grows by exactly one: door 2 + reader 2 + making words 2 + engine 3 + hub 1
  assert.equal(writes.length, 10);
  assert.match(script, hubLinkRx("Our Era Comms", 8377));
  // only the hub link carries the flag
  assert.equal(script.split("--hub-only").length - 1, 1, "the flag appears once in the pass");
  // the port is the hub's own
  const other = reconcileShortcuts({ apps: [], dryRun: true, dir: DIR, port: 8401, iconFor: () => null, returnScript: true });
  assert.match(other.script, hubLinkRx("Our Era Comms", 8401));
});

test("the hub link wears the home door's title, so a rename sweeps it with the door", () => {
  const { plan, script } = reconcileShortcuts({ apps: [], homeTitle: "Comms Test", dryRun: true, dir: DIR,
    port: 8377, iconFor: () => null, returnScript: true });
  assert.ok(plan.some(p => p.action === "write" && p.path === "Startup\\Comms Test.lnk"));
  assert.match(script, hubLinkRx("Comms Test", 8377));
});

test("the wizard's home-door script writes the Startup hub link too; turning the door off removes it", () => {
  const home = { title: HOME_TITLE, path: "/home/" };
  const on = shortcutScript(home, true, { dir: DIR, port: 8377, iconFor: () => null });
  assert.match(on, hubLinkRx("Our Era Comms", 8377));
  assert.ok(!on.replace(/'(?:[^']|'')*'/g, "").includes("'"), "quotes balanced: " + on);
  const off = shortcutScript(home, false, { dir: DIR, port: 8377 });
  assert.match(off, /Remove-Item \(Join-Path \(\[Environment\]::GetFolderPath\('Startup'\)\) 'Our Era Comms\.lnk'\) -Force/);
  // a page app's script never touches Startup, and never carries the flag
  const reader = shortcutScript(APPS[1], true, { dir: DIR, port: 8377 });
  assert.ok(!/Startup/.test(reader) && !/--hub-only/.test(reader), "page apps stay off Startup");
  const readerOff = shortcutScript(APPS[1], false, { dir: DIR, port: 8377 });
  assert.ok(!/Startup/.test(readerOff), "and removing one never touches Startup");
});

test("the wizard path still spawns one PowerShell for the home door (hub link included)", async () => {
  const { applyShortcut } = require("../shortcuts.js");
  const calls = [];
  applyShortcut({ title: HOME_TITLE, path: "/home/" }, true, { dir: DIR, port: 8377, platform: "win32",
    spawn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() { return this; } }; } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[calls[0].args.length - 1], /--hub-only/);
  // off Windows the wizard path runs nothing
  applyShortcut({ title: HOME_TITLE, path: "/home/" }, true, { dir: DIR, port: 8377, platform: "linux",
    spawn: () => { calls.push(1); return { on() { return this; } }; } });
  assert.equal(calls.length, 1);
});
