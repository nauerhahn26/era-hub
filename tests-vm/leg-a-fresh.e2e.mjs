// leg A — a novice's first install of the CANDIDATE on a pristine Windows 10:
// silent install → the kiosk's welcome wizard → Making Words + The Pencil →
// each app and its door → Settings (door target, "opens in its own window in
// front") → an app added later pulls its pack from the feed. Every step is
// the real installer, the real hub, the real Edge kiosk (driven over CDP)
// and ends with a screenshot in gate/vm-e2e/. docs/e2e-deploy-gate-plan.md.
import test from "node:test";
import assert from "node:assert/strict";
import * as vm from "./lib/vm.mjs";

const { INSTDIR, GUEST_HOME } = vm;
// the hub's logs live under its DATA dir (server.js: LOGS = DATA\logs), not
// INSTDIR\logs — run 8 waited 30 s on a file that never existed
const STEPASIDE = INSTDIR + "\\data\\logs\\stepaside.log";
const VER = process.env.VM_CANDIDATE_VERSION || "";
const BUILD = process.env.VM_CANDIDATE_BUILD || "";
let browser, page;
// VM_RESUME=1: debugging only — skip revert/install/launch and drive the
// kiosk already running on the VM (a release run always starts pristine)
const RESUME = process.env.VM_RESUME ? "VM_RESUME: driving the VM as it stands" : false;
// every journey starts from the launcher: a failed step never cascades into the next
const home = () => vm.home(page);

test("VM: pristine snapshot, candidate installer in the guest", { timeout: 480000, skip: RESUME }, () => {
  vm.revert();
  vm.push("qa/candidate.exe", "setup.exe");
  assert.ok(vm.exists(GUEST_HOME + "\\setup.exe"), "setup.exe landed");
  assert.ok(!vm.exists(INSTDIR + "\\start-hub.bat"), "pristine: no New ERA installed");
});

test("silent install (/S): core + node + shortcuts land, the hub does NOT auto-launch", { timeout: 300000, skip: RESUME }, async () => {
  await vm.installSilently("setup.exe");
  for (const f of ["start-hub.bat", "server.js", "node\\node.exe", "VERSION", "public\\favicon.ico", "Uninstall.exe", "data\\apps.json"])
    assert.ok(vm.exists(INSTDIR + "\\" + f), f + " installed");
  assert.equal(vm.guestFile(INSTDIR + "\\VERSION").trim(), BUILD, "VERSION = the candidate build");
  assert.ok(vm.exists(GUEST_HOME + "\\Desktop\\New ERA.lnk"), "desktop shortcut");
  // /S must never start the hub (the finish page's tick does that) — nothing listens on 8377
  assert.equal(vm.hubGet("/settings"), null, "no hub running after a silent install");
  assert.ok(!/node\.exe/i.test(vm.guest("tasklist | findstr /i node.exe", { soft: true })), "no node.exe running");
  vm.shot("installed-desktop");
});

let wizardSeen = true;   // RESUME on a VM that already has a profile lands on the launcher
test("first launch: the kiosk opens on the welcome wizard, in front", { timeout: 1800000 }, async () => {
  if (!RESUME || !vm.hubGet("/version")) await vm.launchKiosk(); else await vm.cdpForward();
  let win;
  ({ browser, page, win } = await vm.kiosk());
  console.log(`# kiosk window as it first appeared: ${JSON.stringify(win)}`);
  await page.locator("#setup:visible, #launcher:visible").first().waitFor({ state: "visible", timeout: 90000 });
  if (RESUME && await page.locator("#launcher").isVisible()) { wizardSeen = false; console.log("# RESUME: profile exists, launcher up — wizard steps skipped"); return; }
  await page.locator("#setup").waitFor({ state: "visible", timeout: 60000 });
  assert.ok(await page.locator("#launcher").isHidden(), "launcher hidden until the wizard is done");
  const ids = await page.locator("#pickApps input[type=checkbox]").evaluateAll((cs) => cs.map((c) => c.dataset.id));
  for (const id of ["making-words", "pencil", "board", "reader"]) assert.ok(ids.includes(id), "wizard offers " + id);
  // clearStageOnce fires at +9 s and SETTLES the kiosk (a cold first launch
  // sometimes lands at (10,10) under the taskbar, unfocused — 9/3); its
  // PowerShell can take minutes cold on the emulated guest, so wait for its
  // verdict in the log rather than a fixed 11 s
  const settle = await vm.waitFor(() => { const l = vm.guestFile(STEPASIDE) || ""; return /settle front|settle: no/.test(l) && l; },
    { timeout: 300000, every: 5000, what: "the first-launch settle to report (stepaside.log)" });
  console.log("# stepaside.log: " + settle.replace(/\s+/g, " ").trim());
  assert.match(settle, /settle \d+ pos True/, "the settle found the kiosk window");
  const { fullscreen, win: after } = await vm.geometry(page);
  assert.ok(fullscreen, "the kiosk window fills the screen after the settle — " + JSON.stringify(after));
  const front = await vm.frontTitle();
  assert.match(front, /New ERA/, "the kiosk is the window in front (dad 9/1: it opened BEHIND the browser) — got " + JSON.stringify(front));
  vm.shot("welcome-wizard");
});

test("wizard: name + dwell + Making Words & The Pencil only → the launcher greets the family", { timeout: 120000 }, async () => {
  if (!wizardSeen) return;
  await page.fill("#name", "Ellie");
  await page.locator("#dwell").evaluate((el) => { el.value = 1200; el.dispatchEvent(new Event("input")); });
  for (const cb of await page.locator("#pickApps input[type=checkbox]").all()) {
    const id = await cb.getAttribute("data-id");
    await cb.setChecked(id === "making-words" || id === "pencil");
  }
  await page.click("#go");
  await page.locator("#launcher").waitFor({ state: "visible", timeout: 60000 });
  assert.equal(await page.locator("#hello").innerText(), "Hi, Ellie's family!");
  const tiles = await page.locator("#appGrid a.app").allInnerTexts();
  const names = tiles.map((t) => t.split("\n")[0]);
  assert.deepEqual(names, ["Making Words", "The Pencil", "Settings"], "exactly the chosen apps, Settings last — got " + names.join(" | "));
  const s = vm.hubGet("/settings");
  assert.equal(s.dwellMs, 1200);
  const apps = vm.hubGet("/apps").apps;
  assert.deepEqual(apps.filter((a) => a.enabled).map((a) => a.id), ["making-words", "pencil"]);
  assert.ok(!apps.find((a) => a.id === "eragaze").enabled, "the gaze engine stays off unless chosen");
  vm.shot("launcher");
});

test("Making Words: opens from its tile, the door returns home (no engine → home)", { timeout: 240000 }, async () => {
  await home();
  await vm.openTile(page, "Making Words", /127\.0\.0\.1:8377\/(\?.*)?$/);
  vm.shot("making-words");
  await page.click("#door");
  await page.waitForURL(/\/home\//, { waitUntil: "commit", timeout: 60000 });
  await page.locator("#launcher").waitFor({ state: "visible", timeout: 60000 });
});

test("The Pencil: opens, the door returns home", { timeout: 240000 }, async () => {
  await home();
  await vm.openTile(page, "The Pencil", /\/pencil\//);
  vm.shot("pencil");
  await page.click("#door");
  await page.waitForURL(/\/home\//, { waitUntil: "commit", timeout: 60000 });
  await page.locator("#launcher").waitFor({ state: "visible", timeout: 60000 });
});

test("Settings: 'Where the door goes' persists; a site opens in its OWN window, in front", { timeout: 300000 }, async () => {
  await home();
  await page.click("#appGrid a.app:has-text('Settings')");
  await page.waitForURL(/\/settings\//, { waitUntil: "commit", timeout: 60000 });
  await page.locator("#exitTo").waitFor({ state: "visible", timeout: 30000 });
  await page.click("#exitTo button[data-exit=home]");
  await vm.waitFor(() => vm.hubGet("/settings")?.exitTo === "home" && { ok: 1 }, { what: "exitTo=home on disk" });
  await page.reload();
  await page.locator("#exitTo").waitFor({ state: "visible", timeout: 30000 });
  assert.ok(await page.locator("#exitTo button[data-exit=home]").evaluate((b) => b.classList.contains("sel")), "selection survives a reload");
  vm.shot("settings-door");

  // dad 9/2: Drive / ElevenLabs / Resend / AI Studio must all open the same
  // way — a normal browser window that comes to the FRONT of the kiosk
  const before = vm.guestFile(STEPASIDE);
  const r = await vm.api(page, "/open-url", "POST", { url: "https://elevenlabs.io/app/settings/api-keys" });
  assert.equal(r.json?.opened, true, "/open-url answered opened:true — " + r.text);
  await vm.waitFor(() => /step-aside/.test(vm.guestFile(STEPASIDE).slice(before.length)) && { ok: 1 },
    { timeout: 30000, what: "stepAsideFromKiosk log line" });
  await new Promise((r) => setTimeout(r, 8000));
  const w = await vm.windows();
  vm.shot("open-url-front");
  // on a PC whose Edge has never been opened outside the kiosk, what is in
  // front is Edge's own first-run welcome (an untitled window) with the site
  // behind ONE click of "Start without your data" — Edge's doing, not ours
  // (run 9, 9/3); a used Edge shows the site itself
  assert.equal(w.topExe, "msedge", "a browser window is in front — " + JSON.stringify(w));
  assert.ok(!/New ERA|ERAgaze Settings/.test(w.top), "…and it is not the kiosk — in front: " + JSON.stringify(w.top));
  const log = vm.guestFile(STEPASIDE).slice(before.length);
  assert.match(log, /minimized \d+/, "the kiosk stepped aside — " + log);
  // the family is done with the site: its window closed, the kiosk back
  await vm.closeSiteWindow();
  // the kiosk is still on Settings, whose document title is "ERAgaze Settings"
  // (run 12 failed on /New ERA/ alone while the product had done the right thing)
  const back = await vm.frontTitle();
  assert.match(back, /New ERA|ERAgaze Settings/, "the kiosk is back in front once the site's window is closed — got " + JSON.stringify(back));
  vm.shot("kiosk-back-after-site");
});

test("apps later: an app's pack is removed, then re-added from the feed by the launcher's manager", { timeout: 300000 }, async () => {
  // reader is on disk (the silent install took every component) but off;
  // Settings' remove really deletes its pack...
  await home();
  const del = await vm.api(page, "/apps/delete", "POST", { id: "reader" });
  assert.equal(del.status, 204, "reader pack removed");
  assert.ok(!vm.exists(INSTDIR + "\\public\\reader\\index.html"), "public\\reader gone");
  // ...and ticking it in the launcher's manager pulls it back from the release feed
  await home();
  await page.locator("#appMgr summary").click();
  await page.locator("#appMgrList label:has-text('Book Reader') input").setChecked(true);
  await vm.waitFor(() => vm.hubGet("/apps")?.apps.find((a) => a.id === "reader")?.installed && { ok: 1 },
    { timeout: 180000, every: 3000, what: "reader pack to download from the feed" });
  const hits = vm.host(`curl -s http://127.0.0.1:${process.env.VM_FEED_PORT || 8427}/hits`);
  assert.match(hits, /GET \/new-era-suite\.tar\.gz/, "the pack came from the feed — " + hits);
  await vm.waitFor(async () => (await page.locator("#appGrid a.app").allInnerTexts()).some((t) => /Book Reader/.test(t)) && { ok: 1 },
    { timeout: 60000, what: "Book Reader tile" });
  await vm.openTile(page, "Book Reader", /\/reader\//);
  vm.shot("reader-added-later");
  assert.ok(vm.exists(INSTDIR + "\\public\\reader\\index.html"), "public\\reader is back");
});

test("shut down: hub and kiosk stop cleanly", { timeout: 60000 }, async () => {
  try { await browser?.close(); } catch {}
  vm.bat("stop", ["taskkill /IM msedge.exe /F >nul 2>&1", "taskkill /IM node.exe /F >nul 2>&1", "echo stopped"]);
});
