// leg A — a novice's first install of the CANDIDATE on a pristine Windows 10:
// silent install → the kiosk's welcome wizard → Making Words + The Pencil →
// each app and its door → Settings (door target, "opens in its own window in
// front") → an app added later pulls its pack from the feed. Every step is
// the real installer, the real hub, the real Edge kiosk (driven over CDP)
// and ends with a screenshot in gate/vm-e2e/. docs/e2e-deploy-gate-plan.md.
import test from "node:test";
import assert from "node:assert/strict";
import * as vm from "./lib/vm.mjs";

// vm.INSTDIR is live (the folder the guest's install really is in): never destructured
const { GUEST_HOME } = vm;
// the hub's logs live under its DATA dir (server.js: LOGS = DATA\logs), not
// INSTDIR\logs — run 8 waited 30 s on a file that never existed
const stepaside = () => vm.INSTDIR + "\\data\\logs\\stepaside.log";
const VER = process.env.VM_CANDIDATE_VERSION || "";
const BUILD = process.env.VM_CANDIDATE_BUILD || "";
let browser, page;
// VM_RESUME=1: debugging only — skip revert/install/launch and drive the
// kiosk already running on the VM (a release run always starts pristine)
const RESUME = process.env.VM_RESUME ? "VM_RESUME: driving the VM as it stands" : false;
// every journey starts from the launcher: a failed step never cascades into the next
const home = () => vm.home(page);

test("VM: pristine snapshot, candidate installer in the guest", { timeout: 600000, skip: RESUME }, () => {   // 390 s on the starved 9/6 host
  vm.revert();
  vm.push("qa/candidate.exe", "setup.exe");
  assert.ok(vm.exists(GUEST_HOME + "\\setup.exe"), "setup.exe landed");
  assert.ok(!vm.exists(vm.NEW_INSTDIR + "\\start-hub.bat") && !vm.exists(vm.OLD_INSTDIR + "\\start-hub.bat"),
    "pristine: nothing installed under either name");
});

// 600 s like leg B's same step: installSilently alone budgets 2 × 180 s, and on
// 9/6 (QA host 31–44 % CPU steal from a noisy neighbour) the install that took
// 118 s the day before blew a 300 s cap while every later step still passed
test("silent install (/S): core + node + shortcuts land, the hub does NOT auto-launch", { timeout: 600000, skip: RESUME }, async () => {
  await vm.installSilently("setup.exe");
  for (const f of ["start-hub.bat", "server.js", "node\\node.exe", "VERSION", "public\\favicon.ico", "Uninstall.exe", "data\\apps.json"])
    assert.ok(vm.exists(vm.INSTDIR + "\\" + f), f + " installed");
  assert.equal(vm.guestFile(vm.INSTDIR + "\\VERSION").trim(), BUILD, "VERSION = the candidate build");
  assert.equal(vm.INSTDIR, vm.NEW_INSTDIR, "the candidate installs into Our Era Comms");
  assert.equal(vm.desktopLink(), vm.HOME_LINK, "desktop shortcut, under the new name");
  assert.ok(!vm.exists(GUEST_HOME + "\\Desktop\\" + vm.OLD_HOME_LINK), "and no old-name shortcut");
  assert.ok(vm.uninstallKey("OurEraComms") && !vm.uninstallKey("NewERA"), "one Apps & features entry, OurEraComms");
  // /S must never start the hub (the finish page's tick does that) — nothing listens on 8377
  assert.equal(vm.hubGet("/settings"), null, "no hub running after a silent install");
  assert.ok(!vm.processRunning("node.exe"), "no node.exe running");   // exact image name, never a substring (9/8)
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
  const settle = await vm.waitFor(() => { const l = vm.guestFile(stepaside()) || ""; return /settle front|settle: no/.test(l) && l; },
    { timeout: 300000, every: 5000, what: "the first-launch settle to report (stepaside.log)" });
  console.log("# stepaside.log: " + settle.replace(/\s+/g, " ").trim());
  assert.match(settle, /settle \d+ pos True/, "the settle found the kiosk window");
  const { fullscreen, win: after } = await vm.geometry(page);
  assert.ok(fullscreen, "the kiosk window fills the screen after the settle — " + JSON.stringify(after));
  const front = await vm.frontTitle();
  assert.match(front, vm.KIOSK_TITLE, "the kiosk is the window in front (dad 9/1: it opened BEHIND the browser) — got " + JSON.stringify(front));
  // the rename reached the page the family sees first (spec Verification)
  assert.match(await page.title(), /Our Era/, "the hub's home page is titled Our Era — got " + JSON.stringify(await page.title()));
  vm.shot("welcome-wizard");
});

test("wizard: name + dwell + Making Words & The Pencil only → the launcher greets the family", { timeout: 240000 }, async () => {
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
  // the chosen apps' desktop shortcuts wear their own icons — Ellie's originals
  // (dad 9/3), not the suite favicon every .lnk used to carry
  await vm.waitFor(() => vm.exists(GUEST_HOME + "\\Desktop\\Making Words.lnk") && { ok: 1 }, { what: "Making Words.lnk on the desktop" });
  vm.bat("lnk-icons", [
    `powershell -NoProfile -Command "$w = New-Object -ComObject WScript.Shell; foreach ($n in 'Making Words','The Pencil') { $l = $w.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) ($n + '.lnk'))); Write-Output ($n + '=' + $l.IconLocation) }" > ${GUEST_HOME}\\lnk-icons.txt`,
  ]);
  const icons = vm.guestText("lnk-icons.txt");
  assert.match(icons, /Making Words=.*\\public\\icons\\making-words\.ico,0/, "Making Words shortcut icon — got " + JSON.stringify(icons));
  assert.match(icons, /The Pencil=.*\\public\\icons\\pencil\.ico,0/, "The Pencil shortcut icon — got " + JSON.stringify(icons));
  assert.ok(vm.exists(vm.INSTDIR + "\\public\\icons\\pencil.ico"), "the icon file the shortcut points at is installed");
  vm.shot("launcher");
});

test("Making Words: opens from its tile, the door returns home (no engine → home)", { timeout: 240000 }, async () => {
  await home();
  await vm.openTile(page, "Making Words", /127\.0\.0\.1:8377\/(\?.*)?$/);
  vm.shot("making-words");
  await page.click(vm.DOOR);
  await page.waitForURL(/\/home\//, { waitUntil: "commit", timeout: 60000 });
  await page.locator("#launcher").waitFor({ state: "visible", timeout: 60000 });
});

test("The Pencil: opens, the door returns home", { timeout: 240000 }, async () => {
  await home();
  await vm.openTile(page, "The Pencil", /\/pencil\//);
  vm.shot("pencil");
  await page.click(vm.DOOR);
  await page.waitForURL(/\/home\//, { waitUntil: "commit", timeout: 60000 });
  await page.locator("#launcher").waitFor({ state: "visible", timeout: 60000 });
});

test("Settings: 'Where the door goes' persists; a site opens in its OWN window, in front", { timeout: 600000 }, async () => {
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
  const before = vm.guestFile(stepaside());
  const r = await vm.api(page, "/open-url", "POST", { url: "https://elevenlabs.io/app/settings/api-keys" });
  assert.equal(r.json?.opened, true, "/open-url answered opened:true — " + r.text);
  await vm.waitFor(() => /step-aside/.test(vm.guestFile(stepaside()).slice(before.length)) && { ok: 1 },
    { timeout: 30000, what: "stepAsideFromKiosk log line" });
  await new Promise((r) => setTimeout(r, 8000));
  const w = await vm.windows();
  vm.shot("open-url-front");
  // on a PC whose Edge has never been opened outside the kiosk, what is in
  // front is Edge's own first-run welcome (an untitled window) with the site
  // behind ONE click of "Start without your data" — Edge's doing, not ours
  // (run 9, 9/3); a used Edge shows the site itself
  assert.equal(w.topExe, "msedge", "a browser window is in front — " + JSON.stringify(w));
  assert.ok(!vm.KIOSK_TITLE.test(w.top), "…and it is not the kiosk — in front: " + JSON.stringify(w.top));
  const log = vm.guestFile(stepaside()).slice(before.length);
  assert.match(log, /minimized \d+/, "the kiosk stepped aside — " + log);
  // the family is done with the site: its window closed, the kiosk back
  await vm.closeSiteWindow();
  // the kiosk is still on Settings, whose document title is "ERAgaze Settings"
  // (run 12 failed on the product name alone while the product had done the right thing)
  const back = await vm.frontTitle();
  assert.match(back, vm.KIOSK_TITLE, "the kiosk is back in front once the site's window is closed — got " + JSON.stringify(back));
  vm.shot("kiosk-back-after-site");
});

test("apps later: an app's pack is removed, then re-added from the feed by the launcher's manager", { timeout: 300000 }, async () => {
  // reader is on disk (the silent install took every component) but off;
  // Settings' remove really deletes its pack...
  await home();
  const del = await vm.api(page, "/apps/delete", "POST", { id: "reader" });
  assert.equal(del.status, 204, "reader pack removed");
  assert.ok(!vm.exists(vm.INSTDIR + "\\public\\reader\\index.html"), "public\\reader gone");
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
  assert.ok(vm.exists(vm.INSTDIR + "\\public\\reader\\index.html"), "public\\reader is back");
});

test("shut down: hub and kiosk stop cleanly", { timeout: 60000 }, async () => {
  try { await browser?.close(); } catch {}
  vm.bat("stop", ["taskkill /IM msedge.exe /F >nul 2>&1", "taskkill /IM node.exe /F >nul 2>&1", "echo stopped"]);
});

// ---- upgrade over an old install (the 9/26 rename, R1) ----------------------
// A family PC that ran the OLD installer: New ERA\ with its hub running, the
// NewERA Apps entry, "New ERA.lnk" on the Desktop. The candidate installer run
// over it must move the whole folder (data\ included) to Our Era Comms in
// .onInit, leave a junction at the old path so every tile and shortcut that
// names it still works, and leave ONE Apps entry and only the new shortcut.
// Needs the old installer: tools/vm-e2e.sh ships $DIST/prev/New-ERA-Setup.exe
// (release.sh downloads it on a signed cut) as qa/old.exe and sets VM_UPGRADE_OLD.
const UPGRADE = process.env.VM_UPGRADE_OLD ? false
  : "no $DIST/prev/New-ERA-Setup.exe - the upgrade-over-old step needs the old-name installer";
const MARKER = "qa-upgrade-marker.txt";

test("upgrade: pristine snapshot, the OLD installer installed, its hub running", { timeout: 1800000, skip: UPGRADE }, async () => {
  vm.revert();
  vm.push("qa/old.exe", "old-setup.exe");
  await vm.installSilently("old-setup.exe");
  assert.equal(vm.INSTDIR, vm.OLD_INSTDIR, "the old installer installs into New ERA");
  assert.ok(vm.uninstallKey("NewERA"), "the old Apps entry exists");
  // something of the family's in data\, to find again after the move
  vm.bat("marker", [`echo upgrade-marker> "${vm.OLD_INSTDIR}\\data\\${MARKER}"`]);
  const v = await vm.startHubOnly(vm.OLD_INSTDIR, "the old hub");
  console.log("# old hub up: " + JSON.stringify(v));
  assert.ok(vm.processRunning("node.exe"), "the old hub is running when the new installer starts");
  vm.shot("upgrade-old-installed");
});

test("upgrade: the candidate installed silently over it moves the folder and leaves a junction", { timeout: 1200000, skip: UPGRADE }, async () => {
  vm.push("qa/candidate.exe", "setup.exe");
  await vm.installSilently("setup.exe");
  const NEW = vm.NEW_INSTDIR, OLD = vm.OLD_INSTDIR;
  assert.equal(vm.INSTDIR, NEW, "the install now lives in Our Era Comms");
  assert.ok(vm.exists(NEW + "\\start-hub.bat"), "Our Era Comms\\start-hub.bat exists");
  assert.equal(vm.guestFile(NEW + "\\VERSION").trim(), BUILD, "…and it is the candidate's");
  assert.ok(vm.exists(NEW + "\\data\\" + MARKER), "data\\ rode along with the folder");
  assert.ok(vm.isJunction(OLD), "New ERA is a junction (ReparsePoint) now");
  assert.ok(vm.exists(OLD + "\\start-hub.bat"), "…and the old path still reaches start-hub.bat through it");
  assert.ok(vm.uninstallKey("OurEraComms"), "the OurEraComms Apps entry exists");
  assert.ok(!vm.uninstallKey("NewERA"), "the NewERA Apps entry is gone: ONE entry");
  assert.equal(vm.desktopLink(), vm.HOME_LINK, "Our Era Comms.lnk on the Desktop");
  assert.ok(!vm.exists(GUEST_HOME + "\\Desktop\\" + vm.OLD_HOME_LINK), "New ERA.lnk is gone");
  const v = await vm.startHubOnly(NEW, "the upgraded hub");
  assert.equal(v.build, BUILD, "the hub in the moved folder answers /version with the candidate build");
  vm.shot("upgrade-over-old");
  vm.bat("stop", ["taskkill /IM node.exe /F >nul 2>&1", "echo stopped"]);
});
