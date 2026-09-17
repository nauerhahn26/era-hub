// leg C — the family's real first contact with a PUBLISHED release: the website's
// "Download all" button, in a browser, on a pristine Windows 10, opened with a
// double-click. It exists because the 9/6 v0.32.2 post-publish check reported
// "Defender + SmartScreen clean" and dad's I-13 then showed "Windows protected
// your PC — Microsoft Defender SmartScreen prevented an unrecognized app from
// starting" on the very same bytes.
//
// The 9/6 check was blind in two independent ways, and this leg fixes both:
//
//   1. It stamped Zone.Identifier BY HAND after an Invoke-WebRequest
//      (`Set-Content -Stream Zone.Identifier`). A hand-written MOTW proves the
//      file is marked; it proves nothing about the download a family performs,
//      and it skips the browser's own download-reputation prompt entirely.
//      -> here the file is fetched by clicking the site's own button in Edge,
//         and the leg asserts the MOTW it finds was written by the BROWSER
//         (a HostUrl on the release asset host — nothing else writes that).
//
//   2. It launched the exe with `schtasks /tr smartscreen.cmd /it /rl highest`
//      -> cmd.exe -> `start "" <exe>`. The Mark-of-the-Web is consulted by
//      ShellExecute, not by CreateProcess: "MotW files invoked by non-shell
//      means (e.g. cmd.exe or PowerShell) do not trigger security checks or
//      prompts" (Eric Lawrence, textslashplain.com/2016/04/04/downloads-and-
//      the-mark-of-the-web, and .../2023/08/23/smartscreen-application-
//      reputation-in-pictures). A cmd launch was never going to show anything,
//      whatever the file was. `/rl highest` is wrong for a second reason: it
//      hands the process a full admin token, and this installer is
//      RequestExecutionLevel user — a family runs it with a filtered one.
//      -> here the file is opened through Shell.Application (that COM server
//         lives in explorer.exe, so it IS the shell opening the file, exactly
//         as a double-click is) from a task with NO /rl highest.
//
// The leg does NOT fail because the interstitial appears: a fresh publisher
// certificate has no SmartScreen reputation and will show it for weeks
// (learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation).
// It fails on the things that would actually hurt a family, and on any state
// that would make the check blind again:
//   - SmartScreen switched off on the guest (a check that cannot fire)
//   - a MOTW we wrote ourselves instead of the browser
//   - bytes that are not the published bytes
//   - a signature Windows does not call Valid, or with no timestamp
//   - an interstitial with NO publisher name (that is what "unsigned" looks
//     like) or with no "Run anyway" (a family with no way through)
//   - Defender recording a threat
//
// Post-publish by nature: it downloads the real asset from the real URL, so
// release.sh should run it as a step 5 AFTER `gh release create`, and a red
// result means pull the release. Wiring (tools/ is out of scope for this
// branch — one line):   run_leg c leg-c-smartscreen.e2e.mjs
// Env: VM_EXPECTED_SHA256 (or VM_DIST holding checksums.txt) — required;
//      VM_SITE_URL (default https://neweracommunications.org/),
//      VM_DOWNLOAD_SELECTOR (default a.dl-all).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import * as vm from "./lib/vm.mjs";

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "lib");
const { GUEST_HOME } = vm;
const SITE = process.env.VM_SITE_URL || "https://neweracommunications.org/";
const SELECTOR = process.env.VM_DOWNLOAD_SELECTOR || "a.dl-all";
const DOWNLOADS = GUEST_HOME + "\\Downloads";
const EXE = DOWNLOADS + "\\New-ERA-Setup.exe";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE = GUEST_HOME + "\\smartscreen-profile";

function expectedSha() {
  if (process.env.VM_EXPECTED_SHA256) return process.env.VM_EXPECTED_SHA256.trim().toLowerCase();
  const dist = process.env.VM_DIST;
  if (!dist) return "";
  const line = (fs.readFileSync(path.join(dist, "checksums.txt"), "utf8").split("\n")
    .find((l) => /New-ERA-Setup\.exe\s*$/.test(l)) || "").trim();
  return (line.split(/\s+/)[0] || "").toLowerCase();
}
const SHA = expectedSha();

/** KEY=value lines from smartscreen-facts.ps1 (last value wins) */
function facts() {
  const out = vm.ship(path.join(LIB, "smartscreen-facts.ps1"));
  assert.match(out, /FACTS_DONE/, "smartscreen-facts.ps1 ran to the end — got:\n" + out);
  const f = {};
  for (const l of out.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) f[m[1]] = m[2].trim(); }
  return f;
}

let browser, dl = {}, probe = "";

test("VM: pristine snapshot, SmartScreen on, the check can actually fire", { timeout: 900000 }, async () => {
  assert.ok(SHA, "VM_EXPECTED_SHA256 (or VM_DIST with checksums.txt) must be set — a check that cannot compare the bytes is not a check");
  vm.revert();
  await vm.quiet();
  const f = facts();
  console.log("# guest SmartScreen: explorer=" + f.SS_EXPLORER + " policy=" + f.SS_POLICY + " apphost=" + f.SS_APPHOST + " binary=" + f.SS_BINARY);
  assert.equal(f.PRESENT, "0", "pristine: nothing downloaded yet");
  assert.equal(f.SS_BINARY, "True", "smartscreen.exe is present on the guest");
  // "unset" is the shipping default (on); only an explicit Off/0 is fatal
  assert.doesNotMatch(f.SS_EXPLORER || "", /^Off$/i, "Explorer's SmartScreenEnabled must not be Off — this leg would pass blind");
  assert.notEqual(f.SS_POLICY, "0", "the EnableSmartScreen policy must not be 0 — this leg would pass blind");
  assert.notEqual(f.SS_APPHOST, "0", "EnableWebContentEvaluation must not be 0 — this leg would pass blind");
  assert.equal(f.DEF_RTP, "True", "Defender real-time protection is on");
  console.log("# Defender: RTP=" + f.DEF_RTP + " MAPS=" + f.DEF_MAPS + " cloudBlock=" + f.DEF_CLOUDBLOCK + " threats=" + f.DEF_THREATS);
});

test("the family's download: the website's own button, in a browser", { timeout: 1800000 }, async () => {
  vm.prepGuest();
  vm.warmEdge();
  vm.wake();
  vm.guest("taskkill /IM msedge.exe /F", { soft: true });
  // unelevated, like the family's browser; CDP so the click is a real click on
  // the real page rather than a curl of a URL we guessed
  vm.interactive("ss-edge", [
    `start "" "${EDGE}" --user-data-dir="${PROFILE}" --no-first-run --no-default-browser-check --remote-debugging-port=9222 "${SITE}"`,
  ], { elevated: false });
  await vm.cdpForward(600000);
  browser = await vm.waitFor(async () => {
    try { return await chromium.connectOverCDP(vm.CDP_URL, { timeout: 5000 }); } catch { return null; }
  }, { timeout: 300000, every: 3000, what: "CDP on " + vm.CDP_URL });
  const page = await vm.waitFor(() => {
    for (const c of browser.contexts()) for (const p of c.pages()) if (/neweracommunications/.test(p.url())) return p;
    return null;
  }, { timeout: 300000, every: 3000, what: "the site's tab (" + SITE + ")" });
  await page.locator(SELECTOR).first().waitFor({ state: "visible", timeout: 120000 });
  const href = await page.locator(SELECTOR).first().getAttribute("href");
  console.log("# the site's download button points at " + href);
  assert.match(href, /New-ERA-Setup\.exe$/, "the site hands the family the one-file installer");
  vm.shot("site-download-button");
  // connectOverCDP pointed Edge's downloads at a Playwright directory on THIS
  // machine (Browser.setDownloadBehavior allowAndName): the guest's Edge cannot
  // write there and shows "<guid> — Couldn't download - Download error" (9/17,
  // v0.34.0's first leg C). Hand Edge its own Downloads folder — and its own
  // download-reputation prompt — back before the family's click.
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: false });
  await cdp.detach();
  await page.locator(SELECTOR).first().click();
  // Edge parks an unrecognised download behind Keep / Keep anyway. Give the
  // plain download a chance first, then press it the way the site tells families to.
  let landed = await vm.waitFor(() => vm.exists(EXE) && { ok: 1 }, { timeout: 240000, every: 5000, what: "the download to land" }).catch(() => null);
  if (!landed) {
    vm.shot("edge-download-warning");
    console.log("# the download did not land on its own — pressing Edge's own Keep, as the website tells families to");
    shipProbe();
    vm.interactive("ss-keep", [`powershell -NoProfile -ExecutionPolicy Bypass -File "${GUEST_HOME}\\smartscreen-probe.ps1" -Stage keep`], { elevated: false });
    await vm.waitFor(() => /PROBE_DONE/.test(vm.guestText("smartscreen-probe.log")) && { ok: 1 },
      { timeout: 300000, every: 5000, what: "the Keep probe" });
    console.log(vm.guestText("smartscreen-probe.log").split(/\r?\n/).map((l) => "# keep: " + l).join("\n"));
    landed = await vm.waitFor(() => vm.exists(EXE) && { ok: 1 }, { timeout: 300000, every: 5000, what: "the download to land after Keep" });
  }
  assert.ok(landed, "New-ERA-Setup.exe is in the family's Downloads folder");
  vm.shot("downloaded");
  // hands off the browser before the double-click, so nothing of ours is in front
  vm.guest("taskkill /IM msedge.exe /F", { soft: true });
});

test("what landed is the published, signed installer — and the browser marked it", { timeout: 300000 }, () => {
  dl = facts();
  console.log("# " + ["FILE", "BYTES", "SHA256", "MOTW", "SIG_STATUS", "SIG_SUBJECT", "SIG_ISSUER", "SIG_TIMESTAMPER", "SIG_NOTAFTER"]
    .map((k) => k + "=" + dl[k]).join("\n# "));
  assert.equal(dl.PRESENT, "1", "the installer is on disk");
  assert.equal(dl.SHA256, SHA, "the bytes a family downloads are the bytes we published and gated");
  // Mark-of-the-Web the BROWSER wrote. ZoneId=3 alone is not evidence — anyone
  // can Set-Content a Zone.Identifier; a HostUrl on the asset host is what a
  // real download leaves behind, and only a marked file is ever evaluated.
  assert.match(dl.MOTW, /ZoneId=3/, "the download carries Mark-of-the-Web (ZoneId=3) — without it SmartScreen never looks");
  assert.match(dl.MOTW, /HostUrl=https?:\/\/[^ |]*githubusercontent\.com|HostUrl=https?:\/\/[^ |]*github\.com/i,
    "the MOTW was written by the browser (HostUrl on the release asset host), not stamped by the test");
  assert.equal(dl.SIG_STATUS, "Valid", "Windows itself calls the signature Valid — " + dl.SIG_MESSAGE);
  assert.ok(dl.SIG_SUBJECT, "the signature carries a publisher subject");
  assert.match(dl.SIG_ISSUER, /Certum|Asseco/i, "issued under the Certum chain we sign with");
  assert.ok(dl.SIG_TIMESTAMPER, "the signature is timestamped — without it every copy dies with the certificate");
});

test("the family's gesture: a double-click, unelevated — and what Windows says", { timeout: 1800000 }, async () => {
  shipProbe();
  fs.writeFileSync(path.join(vm.OUT, "smartscreen-target.txt"), EXE + "\r\n");
  vm.ship(path.join(vm.OUT, "smartscreen-target.txt"));
  vm.guest(`del ${GUEST_HOME}\\smartscreen-probe.log`, { soft: true });
  vm.wake();
  // NO /rl highest: the whole point is the token a family has
  vm.interactive("ss-run", [`powershell -NoProfile -ExecutionPolicy Bypass -File "${GUEST_HOME}\\smartscreen-probe.ps1" -Stage run`], { elevated: false });
  let shots = 0;
  await vm.waitFor(() => {
    const l = vm.guestText("smartscreen-probe.log") || "";
    if (shots === 0 && /SHELLEXECUTE fired/.test(l)) { shots++; vm.shot("after-double-click"); }
    if (shots === 1 && /SMARTSCREEN=/.test(l)) { shots++; vm.shot("smartscreen-verdict"); }
    return /PROBE_DONE/.test(l) && l;
  }, { timeout: 900000, every: 5000, what: "the double-click probe (smartscreen-probe.log)" });
  probe = vm.guestText("smartscreen-probe.log");
  fs.writeFileSync(path.join(vm.OUT, "smartscreen-probe.log"), probe);
  console.log(probe.split(/\r?\n/).filter(Boolean).map((l) => "# " + l).join("\n"));
  vm.shot("after-run-anyway");

  const val = (k) => (probe.match(new RegExp("^.*\\b" + k + "=(.*)$", "m")) || [])[1]?.trim() || "";
  // the regression guard: an elevated task is how 9/6 saw nothing
  assert.match(probe, /ELEVATED False/, "the probe ran with the family's FILTERED token (an elevated task hides both UAC and SmartScreen)");
  assert.match(probe, /SHELLEXECUTE fired/, "the file was opened by Explorer (Shell.Application), the only launch SmartScreen can see");

  const shown = val("SMARTSCREEN") === "shown";
  console.log(`# VERDICT SmartScreen interstitial: ${shown ? "SHOWN" : "not shown"} — publisher ${JSON.stringify(val("PUBLISHER"))}, UAC ${val("UAC")}`);
  if (shown) {
    // Expected while the certificate is young: reputation is per-publisher and
    // per-hash and builds from downloads over weeks. What must be true is that
    // the family sees WHO signed it and has a way through.
    const pub = val("PUBLISHER");
    assert.notEqual(pub, "not-shown", "the interstitial names a publisher — a blank one is what UNSIGNED looks like");
    assert.doesNotMatch(pub, /unknown/i, "the publisher is a name, not 'Unknown publisher' — the signature reached the family");
    assert.ok(dl.SIG_SUBJECT.includes(pub) || pub.includes("New ERA") || dl.SIG_SUBJECT.includes("CN=" + pub),
      `the name Windows shows (${JSON.stringify(pub)}) is the certificate's (${JSON.stringify(dl.SIG_SUBJECT)})`);
    assert.equal(val("RUNANYWAY"), "clicked", "the interstitial offered More info -> Run anyway (an enterprise policy that removes it locks the family out)");
  }
  assert.equal(val("INSTALLER"), "up", "the installer's own window came up — the family got through to Choose Components");
  vm.shot("installer-choose-components");
});

test("Defender recorded nothing against the published installer", { timeout: 300000 }, () => {
  const after = facts();
  console.log("# Defender after the run: threats=" + after.DEF_THREATS + " RTP=" + after.DEF_RTP);
  assert.equal(after.DEF_THREATS, "0", "Defender recorded no threat for the published installer");
  assert.equal(after.DEF_THREAT_NAME, undefined, "no active Defender threat named");
});

after(async () => { try { await browser?.close(); } catch {} });

/** ship the UIA probe as .txt and rename it in the guest: ship.sh RUNS a .ps1
 *  in the ssh session, where session 0 has no desktop and no dialog exists */
function shipProbe() {
  vm.ship(path.join(LIB, "smartscreen-probe.ps1.txt"));
  vm.bat("ss-probe-prep", [
    `copy /y ${GUEST_HOME}\\smartscreen-probe.ps1.txt ${GUEST_HOME}\\smartscreen-probe.ps1 >nul`,
    "echo prepped",
  ]);
}
