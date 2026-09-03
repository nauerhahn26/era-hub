// leg B — the family already has the PREVIOUS release; the candidate arrives
// as a self-update, not a reinstall (dad 9/3: "can it see a new version and
// pull it down without a full install? How seamless?"). Previous installer
// → wizard → an app's pack removed (the packs law) → the hub finds the
// candidate on the feed, overlays it, restarts itself; the kiosk window
// never closes, the family's profile survives, the removed pack stays
// removed, the apps still work. docs/e2e-deploy-gate-plan.md.
import test from "node:test";
import assert from "node:assert/strict";
import * as vm from "./lib/vm.mjs";

const { INSTDIR, GUEST_HOME } = vm;
const VER = process.env.VM_CANDIDATE_VERSION || "";
const BUILD = process.env.VM_CANDIDATE_BUILD || "";
let browser, page, prevBuild;
// the packs law (an update never lays down a pack the family did not choose)
// is enforced by the updater that RUNS the update — the previous release's.
// Releases before v0.31.4 predate it; the law is asserted only once the
// previous release carries it, and the removal of the pack's vendor/ runtime
// with it (packs.js, dad 9/3).
let prevHasPacksLaw = false;

const FEED = `http://127.0.0.1:${process.env.VM_FEED_PORT || 8427}`;
const feed = (what) => vm.host(`curl -s -X POST ${FEED}/${what}`);

test("VM: pristine snapshot, PREVIOUS release installed silently", { timeout: 600000 }, async () => {
  // the family downloaded the newest release there was: nothing newer sits
  // on the feed while they answer the wizard. Held, /latest.json answers 503
  // and the previous release's 90 s boot check waits its 6 hours — that
  // check DID fire under the wizard once (9/3) and the candidate now defers
  // its own until a profile exists (tests/update-boot.test.mjs)
  assert.match(feed("hold"), /"held":true/, "candidate held off the feed");
  vm.revert();
  vm.push("qa/prev.exe", "setup.exe");
  await vm.installSilently("setup.exe");
  prevBuild = vm.guestFile(INSTDIR + "\\VERSION").trim();
  prevHasPacksLaw = /packOf/.test(vm.guestFile(INSTDIR + "\\update.js"));
  console.log(`# previous build ${prevBuild}; packs law in its updater: ${prevHasPacksLaw}`);
  assert.ok(prevBuild && prevBuild < BUILD, `previous build ${prevBuild} is older than the candidate ${BUILD}`);
});

test("previous release: wizard → launcher, the board pack removed (the family never chose it)", { timeout: 1800000 }, async () => {
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
  assert.ok(!vm.exists(INSTDIR + "\\public\\board\\index.html"), "public\\board gone");
  if (prevHasPacksLaw) assert.ok(!vm.exists(INSTDIR + "\\vendor\\models"), "the 21 MB cut-out runtime gone with it");
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
    assert.ok(!vm.exists(INSTDIR + "\\public\\board\\index.html"), "an update never lays down a pack the family did not choose (dad 9/3)");
    assert.ok(!vm.exists(INSTDIR + "\\vendor\\models"), "…nor its runtime");
  } else console.log("# previous updater predates the packs law — board pack after update: " + vm.exists(INSTDIR + "\\public\\board\\index.html"));
  assert.ok(vm.exists(INSTDIR + "\\public\\pencil\\index.html") && vm.exists(INSTDIR + "\\public\\reader\\index.html"), "chosen packs present");
  assert.equal(vm.guestFile(INSTDIR + "\\VERSION").trim(), BUILD);
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
  await vm.waitFor(() => !/ERAgaze\.exe/i.test(vm.guest("tasklist", { soft: true })) && { ok: 1 },
    { timeout: 60000, every: 3000, what: "the unchosen engine to be stopped" });
  // and the new build's door law is live: the hub now answers /kiosk/exit
  const ex = await vm.api(page, "/kiosk/exit", "POST");
  assert.equal(ex.json?.action, "home", "/kiosk/exit (new in the candidate) answers home with no engine — " + ex.text);
});

test("shut down: hub and kiosk stop cleanly", { timeout: 60000 }, async () => {
  try { await browser?.close(); } catch {}
  vm.bat("stop", ["taskkill /IM msedge.exe /F >nul 2>&1", "taskkill /IM node.exe /F >nul 2>&1", "echo stopped"]);
});
