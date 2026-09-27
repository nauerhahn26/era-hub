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
  // home door on Desktop + Start Menu, never Startup
  const home = writes.filter(p => p.path.endsWith("\\Our Era Comms.lnk"));
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
