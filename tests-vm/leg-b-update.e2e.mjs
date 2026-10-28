// leg B — the family already has the PREVIOUS release; the candidate arrives
// as a self-update, not a reinstall (dad 9/3: "can it see a new version and
// pull it down without a full install? How seamless?"). Previous installer
// → wizard → an app's pack removed (the packs law) → the hub finds the
// candidate on the feed, overlays it, restarts itself; the kiosk window
// never closes, the family's profile survives, the removed pack stays
// removed, the apps still work. docs/e2e-deploy-gate-plan.md.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "./lib/vm.mjs";
import { checkInstalledChatUI, checkRestoredChatState } from "./lib/chat-ui-smoke.mjs";

// vm.INSTDIR is live: the previous installer may be a New ERA one, and a
// self-update never moves the folder (only the new installer's .onInit does)
const { GUEST_HOME } = vm;
const VER = process.env.VM_CANDIDATE_VERSION || "";
const BUILD = process.env.VM_CANDIDATE_BUILD || "";
let browser, page, prevBuild, prevLink;
// the packs law (an update never lays down a pack the family did not choose)
// is enforced by the updater that RUNS the update — the previous release's.
// Releases before v0.31.4 predate it; the law is asserted only once the
// previous release carries it, and the removal of the pack's vendor/ runtime
// with it (packs.js, dad 9/3).
let prevHasPacksLaw = false;

const FEED = `http://127.0.0.1:${process.env.VM_FEED_PORT || 8427}`;
const feed = (what) => vm.host(`curl -s -X POST ${FEED}/${what}`);

test("VM: pristine snapshot, PREVIOUS release installed silently", { timeout: 1200000 }, async () => {   // 493 s, then >600 s, on the starved 9/6 host
  // the family downloaded the newest release there was: nothing newer sits
  // on the feed while they answer the wizard. Held, /latest.json answers 503
  // and the previous release's 90 s boot check waits its 6 hours — that
  // check DID fire under the wizard once (9/3) and the candidate now defers
  // its own until a profile exists (tests/update-boot.test.mjs)
  assert.match(feed("hold"), /"held":true/, "candidate held off the feed");
  vm.revert();
  vm.push("qa/prev.exe", "setup.exe");
  await vm.installSilently("setup.exe");
  prevBuild = vm.guestFile(vm.INSTDIR + "\\VERSION").trim();
  prevHasPacksLaw = /packOf/.test(vm.guestFile(vm.INSTDIR + "\\update.js"));
  console.log(`# previous build ${prevBuild}; packs law in its updater: ${prevHasPacksLaw}; installed into ${vm.INSTDIR}`);
  // the previous release's home shortcut: the old name is legitimate HERE only,
  // before the candidate has touched this install
  prevLink = vm.desktopLink({ allowOld: true });
  assert.ok(prevLink, "the previous installer put a home shortcut on the Desktop (" + vm.HOME_LINK + " or " + vm.OLD_HOME_LINK + ")");
  assert.ok(prevBuild && prevBuild < BUILD, `previous build ${prevBuild} is older than the candidate ${BUILD}`);
});

test("previous release: wizard → launcher, the board pack removed (the family never chose it)", { timeout: 1800000 }, async () => {
  // the template boots at 1024x768, below any family screen and Chat's smallest
  // supported viewport: the kiosk opens on a real 1280x800 desktop (native-display.mjs)
  await vm.nativeDisplay();
  await vm.launchKiosk();
  ({ browser, page } = await vm.kiosk());
  await page.locator("#setup").waitFor({ state: "visible", timeout: 60000 });
  await page.fill("#name", "Ellie");
  for (const cb of await page.locator("#pickApps input[type=checkbox]").all()) {
    const id = await cb.getAttribute("data-id");
    await cb.setChecked(id === "making-words" || id === "pencil" || id === "reader");
  }
  await page.click("#go");
  await page.locator("#launcher").waitFor({ state: "visible", timeout: 60000 });
  const del = await vm.api(page, "/apps/delete", "POST", { id: "board" });
  assert.equal(del.status, 204, "board pack removed — " + del.text);
  assert.ok(!vm.exists(vm.INSTDIR + "\\public\\board\\index.html"), "public\\board gone");
  if (prevHasPacksLaw) assert.ok(!vm.exists(vm.INSTDIR + "\\vendor\\models"), "the 21 MB cut-out runtime gone with it");
  const v = vm.hubGet("/version");
  assert.equal(v.build, prevBuild); assert.equal(v.updater, true, "the updater is armed on an installed hub");
  vm.shot("prev-launcher");
});

test("self-update: the hub finds the candidate on the feed, applies it and restarts — the kiosk stays open", { timeout: 420000 }, async () => {
  // a new release is published; the hub's next look (its 6 h tick, or the
  // boot check on the next launch — the same check() as this POST) finds it
  assert.match(feed("release"), /"held":false/, "candidate now on the feed");
  const r = await vm.api(page, "/update/check", "POST");
  assert.equal(r.json?.status, "updated", "update applied — " + r.text);
  assert.equal(r.json.from, prevBuild); assert.equal(r.json.to, BUILD); assert.equal(r.json.version, VER);
  const v = await vm.waitFor(() => { const v = vm.hubGet("/version"); return v && v.build === BUILD && v; },
    { timeout: 180000, every: 3000, what: "the restarted hub to report the candidate build" });
  assert.equal(v.disk, BUILD);
  assert.ok(!page.isClosed(), "the kiosk window is still there");
  // the home page notices the new build within its 60 s tick and reloads
  await vm.waitFor(async () => /Build /.test(await page.locator("#devnote").innerText()) &&
    (await page.locator("#devnote").innerText()).includes(BUILD) && { ok: 1 }, { timeout: 120000, every: 5000, what: "home to show the new build" });
  assert.match(await page.locator("#devnote").innerText(), /Updated just now/, "the family gets a small 'updated' note");
  vm.shot("updated-home");
});

test("after the update: profile intact, removed pack still absent, chosen packs refreshed, apps and doors work", { timeout: 240000 }, async () => {
  assert.equal(vm.hubGet("/settings").hasProfile, true);
  assert.equal(await page.locator("#hello").innerText(), "Hi, Ellie's family!");
  if (prevHasPacksLaw) {
    assert.ok(!vm.exists(vm.INSTDIR + "\\public\\board\\index.html"), "an update never lays down a pack the family did not choose (dad 9/3)");
    assert.ok(!vm.exists(vm.INSTDIR + "\\vendor\\models"), "…nor its runtime");
  } else console.log("# previous updater predates the packs law — board pack after update: " + vm.exists(vm.INSTDIR + "\\public\\board\\index.html"));
  assert.ok(vm.exists(vm.INSTDIR + "\\public\\pencil\\index.html") && vm.exists(vm.INSTDIR + "\\public\\reader\\index.html"), "chosen packs present");
  assert.equal(vm.guestFile(vm.INSTDIR + "\\VERSION").trim(), BUILD);
  // the candidate's boot pass rewrites the home shortcut under the new name and
  // deletes the old one (spec R1: Desktop shows only Our Era Comms.lnk)
  await vm.waitFor(() => vm.desktopLink() === vm.HOME_LINK && !vm.exists(GUEST_HOME + "\\Desktop\\" + vm.OLD_HOME_LINK) && { ok: 1 },
    { timeout: 120000, every: 5000, what: "the Desktop to show " + vm.HOME_LINK + " only (it had " + prevLink + ")" });
  // the hub's logon start (spec 2026-10-19 §4.2): the candidate's boot pass lays
  // Startup\Our Era Comms.lnk -> start-hub.bat 8377 --hub-only, so a reboot never
  // leaves the hub dead until a tile tap. Read the way leg A reads its .lnk files.
  const hubLink = await vm.waitFor(() => {
    vm.bat("lnk-hub", [
      `powershell -NoProfile -Command "$p = Join-Path ([Environment]::GetFolderPath('Startup')) 'Our Era Comms.lnk'; if (Test-Path $p) { $l = (New-Object -ComObject WScript.Shell).CreateShortcut($p); Write-Output ($l.TargetPath + '|' + $l.Arguments + '|' + $l.WorkingDirectory) } else { Write-Output 'missing' }" > ${GUEST_HOME}\\lnk-hub.txt`,
    ]);
    const t = vm.guestText("lnk-hub.txt").trim();
    return t && t !== "missing" && t;
  }, { timeout: 120000, every: 5000, what: "Startup\\Our Era Comms.lnk (the hub's logon start)" });
  const [hubTarget, hubArgs, hubWd] = hubLink.split("|");
  assert.ok(/\\start-hub\.bat$/i.test(hubTarget), "the Startup link runs start-hub.bat — got " + JSON.stringify(hubLink));
  assert.equal(hubTarget.toLowerCase(), (vm.INSTDIR + "\\start-hub.bat").toLowerCase(), "…the installed one");
  assert.equal(hubArgs, "8377 --hub-only", "the Startup link starts the hub only, no page — got " + JSON.stringify(hubLink));
  assert.equal((hubWd || "").toLowerCase(), vm.INSTDIR.toLowerCase(), "it runs in the install folder");
  const apps = vm.hubGet("/apps").apps;
  assert.deepEqual(apps.filter((a) => a.enabled).map((a) => a.id), ["making-words", "pencil", "reader"]);
  for (const [tile, url] of [["The Pencil", /\/pencil\//], ["Book Reader", /\/reader\//]]) {
    await vm.home(page);
    await vm.openTile(page, tile, url);
    vm.shot("post-update-" + tile.toLowerCase().replace(/\s+/g, "-"));
  }
  await vm.home(page);
  // the previous release compiled and started ERAgaze uninvited (bug 38);
  // the candidate's boot reconcile stops what the family never chose —
  // else the first door hands the kiosk to it (run 2, 9/3: /kiosk/exit
  // answered "closed" on a PC with no eye tracker)
  await vm.waitFor(() => !vm.processRunning("ERAgaze.exe") && { ok: 1 },   // exact image name, never a substring (9/8)
    { timeout: 60000, every: 3000, what: "the unchosen engine to be stopped" });
  // and the new build's door law is live: the hub now answers /kiosk/exit
  const ex = await vm.api(page, "/kiosk/exit", "POST");
  assert.equal(ex.json?.action, "home", "/kiosk/exit (new in the candidate) answers home with no engine — " + ex.text);
});

test("after the update: Settings sections, search and legacy links work in the installed kiosk", { timeout: 120000 }, async () => {
  try {
    await page.goto(new URL("/settings/#content", page.url()).href, { waitUntil: "load", timeout: 60000 });
    await page.locator("#settings-section-books").waitFor({ state: "visible", timeout: 30000 });
    assert.equal(await page.locator("#settingsHeading").innerText(), "Books");
    assert.equal(await page.locator("#settingsNav a").count(), 8, "all settings sections shipped in the update");
    await page.waitForFunction(() => getComputedStyle(document.body).overflow === "hidden" &&
      document.querySelector(".settings-books-tabs") &&
      getComputedStyle(document.querySelector(".settings-books-tabs")).display === "flex");

    await page.locator('[data-books-view="setup"]').click();
    await page.locator("#booksSetup").waitFor({ state: "visible" });
    assert.equal(await page.locator("#contentTiers").isVisible(), true, "book setup is reachable without starting a build");

    if (!await page.locator("#settingsSearch").isVisible()) await page.locator("#settingsMenu").click();
    await page.fill("#settingsSearch", "volume");
    await page.waitForFunction(() => document.querySelectorAll(".settings-search-result").length >= 2);
    await page.locator(".settings-search-result").first().click();
    await page.locator("#settings-section-sound").waitFor({ state: "visible" });
    assert.equal(await page.locator('#settingsNav a[href="#sound"]').getAttribute("aria-current"), "page");

    await page.evaluate(() => { location.hash = "system"; });
    await page.locator("#settings-section-system").waitFor({ state: "visible" });
    assert.equal(await page.locator("#updCheck").isVisible(), true, "the update control is reachable without pressing it");

    await page.goto(new URL("/settings/#integrations", page.url()).href, { waitUntil: "load", timeout: 60000 });
    await page.locator("#settings-section-connections").waitFor({ state: "visible" });
    assert.equal(await page.locator("#integrations").isVisible(), true, "the legacy Drive link opens Connections");
    vm.shot("settings-after-update");
  } finally { await vm.home(page); }
});

test("after the update: response voice pace saves and reloads on this device", { timeout: 120000 }, async () => {
  const original = vm.hubGet("/settings").responseVoiceSpeed;
  assert.equal(original, 0.8, "a new device defaults to the gentler response pace");
  try {
    await page.goto(new URL("/settings/#sound", page.url()).href, { waitUntil: "load", timeout: 60000 });
    await page.locator("#settings-section-sound").waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.getElementById("responseVoiceSpeedSave").disabled);
    assert.equal(await page.inputValue("#responseVoiceSpeed"), "80");
    await page.fill("#responseVoiceSpeed", "90");
    await page.click("#responseVoiceSpeedSave");
    await page.waitForFunction(() => document.getElementById("responseVoiceSpeedStatus").textContent.includes("Saved on this device: 90%"));
    assert.equal(vm.hubGet("/settings").responseVoiceSpeed, 0.9);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => !document.getElementById("responseVoiceSpeedSave").disabled);
    assert.equal(await page.inputValue("#responseVoiceSpeed"), "90");
    vm.shot("response-voice-pace-after-update");
  } finally {
    await vm.api(page, "/settings", "POST", { responseVoiceSpeed: original });
    await vm.home(page);
  }
});

test("after the update: Math opens from Home and preserves a number partition", { timeout: 180000 }, async () => {
  const appsBefore = vm.hubGet("/apps").apps;
  const math = appsBefore.find(a => a.id === "math");
  assert.ok(math?.installed, "Math's core files arrived with the update");
  assert.equal(math.enabled, false, "the update preserves the family's earlier app choice");
  const enabledBefore = appsBefore.filter(a => a.enabled).map(a => a.id).sort();
  await vm.home(page);
  // This is only the disposable VM's math workspace; other app state is untouched.
  const previousMathState = await page.evaluate(() => {
    const saved = localStorage.getItem("era.math.v1");
    localStorage.removeItem("era.math.v1");
    return saved;
  });
  try {
    const enable = await vm.api(page, "/apps", "POST", { id: "math", enabled: true });
    assert.equal(enable.status, 204, "Math can be enabled after updating — " + enable.text);
    await page.reload({ waitUntil: "commit", timeout: 60000 });
    await vm.home(page);
    await vm.openTile(page, "Math", /\/math\//);
    await page.waitForFunction(() => window.MathApp?.state().ready, undefined, { timeout: 30000 });
    await page.locator('[data-action="numbers"]').click();
    assert.equal(await page.evaluate(() => MathApp.state().number), 7);
    await page.locator('[data-action="more"]').click();
    assert.equal(await page.evaluate(() => MathApp.state().number), 8);
    assert.equal(await page.locator(".math-counter").count(), 8, "the installed quantity matches the numeral");
    await page.locator('[data-action="fewer"]').click();
    assert.equal(await page.evaluate(() => MathApp.state().number), 7);
    await page.locator('[data-action="back"]').click();
    await page.locator('[data-action="partners"]').click();
    await page.locator('[data-action="pick"]').click();
    assert.equal(await page.locator('[data-number="10"]').count(), 1, "ten is available on the first partner page");
    assert.equal(await page.locator('[data-number="11"]').count(), 0);
    await page.locator('[data-number="10"]').click();
    assert.equal(await page.evaluate(() => MathApp.state().whole), 10);
    await page.locator('[data-action="pick"]').click();
    await page.locator('[data-action="ranges"]').click();
    assert.equal(await page.locator('[data-range]').count(), 0, "Other numbers opens the next page directly");
    assert.deepEqual(await page.locator('[data-number]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.number))),
      [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    await page.locator('[data-number="20"]').click();
    await page.locator('[data-action="move-left"]').click();
    assert.equal(await page.locator(".math-equation").innerText(), "11 + 9 = 20");
    await page.reload({ waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => window.MathApp?.state().ready, undefined, { timeout: 30000 });
    const state = await page.evaluate(() => {
      const s = MathApp.state();
      return { view: s.view, whole: s.whole, left: s.left, right: s.right };
    });
    assert.deepEqual(state, { view: "partners", whole: 20, left: 11, right: 9 }, "reopening retains the explored partition");
    assert.equal(await page.locator(".math-counter").count(), 20, "moving an object preserves the whole");
    vm.shot("math-after-update");
  } finally {
    // Leave Math before restoring its storage: pagehide saves the active workspace.
    await vm.home(page);
    await page.evaluate(saved => {
      if (saved === null) localStorage.removeItem("era.math.v1");
      else localStorage.setItem("era.math.v1", saved);
    }, previousMathState);
    const restore = await vm.api(page, "/apps", "POST", { id: "math", enabled: math.enabled });
    assert.equal(restore.status, 204, "the previous Math app choice is restored");
    assert.deepEqual(vm.hubGet("/apps").apps.filter(a => a.enabled).map(a => a.id).sort(), enabledBefore);
  }
});

test("after the update: the picture worker and WebP decoder run without native tools", { timeout: 120000 }, async () => {
  const fixture = fs.readFileSync(new URL("../tests/fixtures/music-storyboard.webp", import.meta.url)).toString("base64");
  const code = "const p=require('./music-pictures.js');Promise.all([p.decodeSheet(Buffer.from('" + fixture +
    "','base64')),p.buildPictures({cfg:null})]).then(([i,r])=>console.log('PICTURES='+i.width+'x'+i.height+';WORKER='+r.pictureStatus))" +
    ".catch(e=>{console.error(e.message);process.exitCode=1;})";
  const out = vm.bat("song-pictures-runtime", [
    `cd /d "${vm.INSTDIR}"`,
    `"node\\node.exe" -e "${code}"`,
  ]);
  assert.match(out, /PICTURES=200x20;WORKER=needs-helper/, "the installed runtime decodes WebP and starts its picture worker");
});

test("after the update: enabling Chat installs its shared activity runtime and release-ended speech works", { timeout: 300000 }, async () => {
  // Deliberately AFTER the removed-pack assertions: choosing Chat now must
  // restore its shared board runtime through the normal install-later route.
  const enabled = await vm.api(page, "/apps", "POST", { id: "chat", enabled: true });
  assert.ok([200, 204].includes(enabled.status), "Chat can be enabled in the updated install");
  await vm.waitFor(() => vm.hubGet("/apps")?.apps.find(app => app.id === "chat")?.installed && { ok: 1 },
    { timeout: 180000, every: 3000, what: "Chat's shared pack to finish installing" });
  for (const relative of ["chat-speech-worker.js", "vendor\\models\\chat-activity.onnx", "vendor\\onnxruntime-web\\dist\\ort.node.min.js"])
    assert.ok(vm.exists(vm.INSTDIR + "\\" + relative), relative + " present in the installed payload");
  vm.ship(fileURLToPath(new URL("lib/chat-speech-smoke.cjs", import.meta.url)));
  vm.ship(fileURLToPath(new URL("fixtures/chat-choice.wav", import.meta.url)));
  const out = vm.bat("chat-installed-speech", [
    `"${vm.INSTDIR}\\node\\node.exe" "${GUEST_HOME}\\chat-speech-smoke.cjs" "${vm.INSTDIR}" "${GUEST_HOME}\\chat-choice.wav"`,
  ]);
  const line = out.split(/\r?\n/).find(line => line.startsWith('{"ok":'));
  assert.ok(line, "the installed Node worker produced a smoke receipt");
  const report = JSON.parse(line);
  assert.equal(report.ok, true, "installed speech/activity smoke succeeds");
  assert.equal(report.platform, "win32");
  assert.equal(report.silenceRejected, true);
  assert.equal(report.uploadsBeforeRelease, 0);
  assert.equal(report.releaseFinals, 1);
  assert.equal(report.cancelClosedTransport, true);
  assert.equal(report.staleFinals, 0);
  assert.equal(report.recoveredAfterCancel, true);
  console.log("# installed Chat: actual activity inference and release/cancel transport verified; recognition is a local mock, not an accuracy test");
});

test("after the update: Chat pictures, private timing export and deliberately selected saved audio work", { timeout: 240000 }, async () => {
  await vm.home(page);
  const report = await checkInstalledChatUI(page, { timeout: 60000, screenshot: () => vm.shot("chat-ui-after-update") });
  assert.equal(report.ok, true);
  assert.equal(report.typedTurn.status, "completed");
  assert.equal(report.actualAudio.playCalls, 1);
  assert.equal(report.actualAudio.playing, 1);
  assert.equal(report.actualAudio.ended, 1);
  assert.equal(report.actualAudio.deviceCalls, 0);
  assert.equal(report.audioSessions, 0); // Chat asks for the microphone by itself; the check refuses it
  console.log("# installed Chat UI: " + JSON.stringify(report));
});

test("after the update: Chat state survives closing the whole kiosk and restarting the installed hub", { timeout: 900000 }, async () => {
  await vm.home(page);
  const prepared = await checkInstalledChatUI(page, { timeout: 60000, prepareRestart: true });
  const before = vm.hubGet("/version");
  async function restart() {
    // Capture and verify this install's hub identity before stopping its PID.
    // The guest is disposable QA; no host or other installed runtime is touched.
    const nodePath = vm.INSTDIR + "\\node\\node.exe";
    const captured = vm.bat("chat-capture-hub", [
      `powershell -NoProfile -Command "$p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.ExecutablePath -eq '${nodePath}' -and $_.CommandLine -match 'server[.]js.*8377' }); if ($p.Count -ne 1) { throw 'Expected one owned installed hub' }; @{ pid = $p[0].ProcessId; created = $p[0].CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress"`,
    ]);
    const line = captured.split(/\r?\n/).find(line => line.startsWith('{'));
    assert.ok(line, "the installed hub PID and creation time were captured");
    const identity = JSON.parse(line); assert.ok(Number.isInteger(identity.pid) && identity.pid > 0);
    const session = await browser.newBrowserCDPSession();
    // Browser.close closes every kiosk window and its InPrivate context. A
    // mere page reload or a detached controller would leave the defect hidden.
    await session.send("Browser.close").catch(error => {
      if (!/closed|disconnected/i.test(error.message)) throw error;
    });
    try { await browser.close(); } catch {}
    browser = null; page = null;
    await vm.waitFor(() => !vm.processRunning("msedge.exe") && { ok: 1 },
      { timeout: 60000, every: 2000, what: "all kiosk browser processes to close" });
    vm.bat("chat-stop-owned-hub", [
      `powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${identity.pid}'; if (!$p -or $p.ExecutablePath -ne '${nodePath}' -or $p.CreationDate.ToUniversalTime().ToString('o') -ne '${identity.created}' -or $p.CommandLine -notmatch 'server[.]js.*8377') { throw 'Owned hub identity changed' }; Stop-Process -Id ${identity.pid} -ErrorAction Stop"`,
    ]);
    await vm.waitFor(() => !vm.hubGet("/version") && { ok: 1 },
      { timeout: 60000, every: 1000, what: "the captured installed hub process to stop" });
    await vm.launchKiosk();
    ({ browser, page } = await vm.kiosk());
    assert.equal(vm.hubGet("/version")?.build, before.build, "the same installed candidate restarts");
  }
  await restart();
  const disk = JSON.parse(vm.guestFile(vm.INSTDIR + "\\data\\chat-state.json"));
  assert.deepEqual(disk.value, prepared.restartState, "the installed state file contains the UI's acknowledged preferences, story and numeric rows");
  const cleared = await checkRestoredChatState(page, prepared.restartState, { timeout: 60000, clear: true });
  await restart();
  await checkRestoredChatState(page, cleared, { timeout: 60000 });
  console.log("# installed Chat durability: full kiosk and hub restarted twice; state restored from the installed data file and UI clears remained cleared");
});

// Button press to ask (design 2026-10-27 §4.1, §4.3; plan T5.8). The updated
// hub compiles buttons/EraButtons.cs with the guest's own csc and keeps it
// running while Chat is on (enabled above). A partner's button is a keyboard
// to Windows, so a 20-line SendInput helper (lib/sendkey.cs), run in the
// interactive desktop where the hotkeys live, stands in for it: F13 must reach
// /buttons/press and bring Chat up at /chat/, and Ctrl+Alt+F9 (the I-13's
// Square button) must do the same.
// A relaunch REPLACES the kiosk: the hub closes the start-hub.bat kiosk (the
// kiosk-profile marker) and spawns its own. The press is recorded the moment
// the relaunch is fired, while the old kiosk still stands, so a DevTools
// session attached then lands on the old window and keeps its last URL after
// that window dies (VM 10/28: "now /home/" for 120 s). The proof is the way
// production sees it: the guest's process list holds exactly one kiosk
// browser, launched at /chat/?ask=, and the screen shows it. Only then is
// DevTools re-attached, to the new instance (the hub carries the QA launcher's
// ERA_QA_CDP onto its own kiosk line, kiosk-launch.js).
test("after the update: a button press reaches Chat through the device listener, F13 and Ctrl+Alt+F9", { timeout: 900000 }, async () => {
  const ALL = ["F13", "F14", "Ctrl+Alt+F9", "Ctrl+Alt+F10", "Ctrl+Alt+F11"];
  const buttons = () => vm.hubGet("/status")?.buttons;
  const listening = await vm.waitFor(() => { const b = buttons(); return b && b.state === "running" && b.keys.registered.length === 5 && b; },
    { timeout: 300000, every: 3000, what: "the button listener to compile and hold its five keys" })
    .catch((e) => { throw new Error(e.message + " — /status.buttons: " + JSON.stringify(buttons())); });
  console.log("# button listener: " + JSON.stringify(listening));
  assert.deepEqual([...listening.keys.registered].sort(), [...ALL].sort());
  assert.deepEqual(listening.keys.failed, [], "no other program holds a key on the pristine guest");
  assert.ok(Number.isInteger(listening.pid) && listening.pid > 0);
  assert.ok(vm.exists(vm.INSTDIR + "\\buttons\\EraButtons.exe"), "compiled on the guest from the shipped source");
  // what the installed hub itself said (server.js logs to <data>\logs\hub.log)
  const hubLog = () => {
    const out = vm.bat("buttons-hub-log", [`findstr /l /c:"[buttons]" "${vm.INSTDIR}\\data\\logs\\hub.log"`], { soft: true }) || "";
    console.log(out.split(/\r?\n/).filter((l) => l.trim()).map((l) => "# hub log: " + l).join("\n") || "# hub log: no [buttons] lines");
  };
  hubLog();
  // W3 closed 10/28 (the hub cannot write the policy unelevated): the record
  // keeps only whether the relaunched kiosk has the microphone without a touch
  const w3 = { permission: null };
  const writeW3 = () => fs.writeFileSync(path.join(vm.OUT, "buttons-w3.json"), JSON.stringify({ ...w3, at: new Date().toISOString() }, null, 2) + "\n");

  // the kiosk browsers on the guest: main processes only (no --type= child),
  // found by the same marker the hub's closeKiosk uses
  const kioskBrowsers = () => {
    const out = vm.bat("buttons-kiosk-procs", [
      `powershell -NoProfile -Command "$k = @(Get-CimInstance Win32_Process -Filter 'Name=''msedge.exe'' or Name=''chrome.exe''' | Where-Object { $_.CommandLine -like '*kiosk-profile*' -and $_.CommandLine -notlike '*--type=*' }); @{ count = $k.Count; lines = @($k | ForEach-Object { [string]$_.CommandLine }) } | ConvertTo-Json -Compress"`,
    ], { soft: true }) || "";
    const line = out.split(/\r?\n/).find((l) => l.startsWith("{"));
    return line ? JSON.parse(line) : null;
  };
  // after a relaunch: exactly one kiosk, on /chat/?ask=; the screen shows it;
  // then DevTools re-attaches to that NEW instance when it carries the port
  async function relaunchedKiosk(shotName) {
    let seen = null;
    const k = await vm.waitFor(() => { seen = kioskBrowsers(); return seen && seen.count === 1 && /\/chat\/\?ask=[0-9a-f]+/.test(seen.lines[0]) && seen; },
      { timeout: 90000, every: 2000, what: "exactly one kiosk browser launched at /chat/?ask=" })
      .catch((e) => { throw new Error(e.message + " — kiosk browsers: " + JSON.stringify(seen)); });
    console.log("# relaunched kiosk: " + k.lines[0]);
    await new Promise((r) => setTimeout(r, 3000));   // the window is drawn, then shot
    vm.shot(shotName);
    try { await browser?.close(); } catch {}
    browser = null; page = null;
    if (!/--remote-debugging-port=\d+/.test(k.lines[0])) { console.log("# relaunched kiosk has no DevTools port: checked by its process line only"); return; }
    ({ browser, page } = await vm.kiosk());
    await vm.waitFor(() => new URL(page.url()).pathname === "/chat/" && { ok: 1 }, { timeout: 120000, every: 1000, what: "the relaunched kiosk's tab at /chat/" })
      .catch((e) => { throw new Error(e.message + " (now " + page.url() + ")"); });
  }

  // The stand-in keyboard leaves nothing behind: its task and helper go at the end, pass or fail.
  try {
    vm.ship(fileURLToPath(new URL("lib/sendkey.cs", import.meta.url)));
    const built = vm.bat("sendkey-build", [`if exist ${GUEST_HOME}\\sendkey.exe del ${GUEST_HOME}\\sendkey.exe`,
      `C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe /nologo /target:winexe /out:${GUEST_HOME}\\sendkey.exe ${GUEST_HOME}\\sendkey.cs`,
      `if exist ${GUEST_HOME}\\sendkey.exe (echo SENDKEY_BUILT=1) else (echo SENDKEY_BUILT=0)`], { soft: true, timeout: 180000 });
    assert.match(built, /SENDKEY_BUILT=1/, "sendkey.exe did not build in the guest: " + built);
    // one chord from the desktop session; resolves with the press the hub recorded
    async function pressKey(key, accept) {
      const before = buttons()?.lastPress?.at || "";
      vm.interactive("sendkey", [], { tr: `${GUEST_HOME}\\sendkey.exe ${key}` });
      const p = await vm.waitFor(() => { const lp = buttons()?.lastPress; return lp && lp.key === key && lp.at !== before && lp; },
        { timeout: 60000, every: 1000, what: key + " to reach /buttons/press" });
      console.log(`# ${key}: ${JSON.stringify(p)}`);
      assert.ok(accept.includes(p.dispatch), `${key} dispatched ${p.dispatch}, wanted one of ${accept.join("/")}`);
      return p;
    }

    // From Home no Chat page listens: F13 relaunches the kiosk at /chat/?ask=<nonce>.
    await vm.home(page);
    console.log("# kiosk browsers before the press: " + JSON.stringify(kioskBrowsers()));
    const f13 = await pressKey("F13", ["relaunch", "visible"]);
    w3.f13 = f13.dispatch;
    if (f13.dispatch === "relaunch") await relaunchedKiosk("chat-after-press");
    else vm.shot("chat-after-press");
    if (page) {
      assert.equal(new URL(page.url()).pathname, "/chat/", "a press lands on Chat");
      // does the relaunched kiosk have the microphone without a touch?
      w3.permission = await page.evaluate(() => navigator.permissions.query({ name: "microphone" }).then((s) => s.state)).catch((e) => "error: " + e.message);
      console.log(`# microphone in the relaunched kiosk: ${w3.permission}`);
    }
    // a held Flic (F14) closes whatever the ask opened, so the next press starts afresh
    await new Promise((r) => setTimeout(r, 5000));
    await pressKey("F14", ["cancel", "none"]);
    // the Square button's key, with Chat on the screen
    const square = await pressKey("Ctrl+Alt+F9", ["visible", "foreground", "relaunch"]);
    if (square.dispatch === "relaunch") await relaunchedKiosk("chat-after-square-relaunch");
    if (page) assert.equal(new URL(page.url()).pathname, "/chat/");
    else { const k = kioskBrowsers(); assert.ok(k?.count === 1 && /\/chat\//.test(k.lines[0]), "the one kiosk is Chat — " + JSON.stringify(k)); }
    await pressKey("F14", ["cancel", "none"]);
    vm.shot("buttons-after-square");
  } finally {
    // the W3 record and the hub's own words, pass or fail
    try { writeW3(); } catch (e) { console.log("# buttons-w3.json not written: " + e.message); }
    try { hubLog(); } catch {}
    try { vm.bat("sendkey-cleanup", ["schtasks /delete /tn era-qa-sendkey /f >nul 2>&1",
      `del /f /q ${GUEST_HOME}\\sendkey.exe ${GUEST_HOME}\\sendkey.cs >nul 2>&1`, "echo cleaned"], { soft: true }); } catch {}
  }
});

test("shut down: hub and kiosk stop cleanly", { timeout: 60000 }, async () => {
  try { await browser?.close(); } catch {}
  vm.bat("stop", ["taskkill /IM msedge.exe /F >nul 2>&1", "taskkill /IM node.exe /F >nul 2>&1", "echo stopped"]);
});
