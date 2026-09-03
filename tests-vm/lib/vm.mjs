// tests-vm/lib/vm.mjs — the unattended Windows e2e's hands (docs/e2e-deploy-
// gate-plan.md, dad 9/3: "a full e2e FE testing suite to pass and deploy").
// tools/vm-e2e.sh provisions the QA VM (pristine snapshot, real installer,
// real kiosk launched with ERA_QA_CDP=9222, ssh tunnel local :9222 → QA host
// :9223 → the guest's sshd → the kiosk's :9222); these helpers drive the REAL
// kiosk window over the Chrome DevTools Protocol and talk to the guest over
// ssh. Nothing here types over VNC (vm-qa-driving-
// lessons: the agent wedges); screenshots come from the QEMU monitor.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VMTOOLS = path.join(path.dirname(HUB), "era-family", "tools", "vm");
export const OUT = process.env.VM_OUT || path.join(HUB, "gate", "vm-e2e");
export const HUB_URL = "http://127.0.0.1:8377";
export const CDP_URL = process.env.VM_CDP || "http://127.0.0.1:9222";
export const GUEST_USER = process.env.VM_GUEST_USER || "family";
export const GUEST_HOME = "C:\\Users\\" + GUEST_USER;
export const INSTDIR = GUEST_HOME + "\\AppData\\Local\\New ERA";
fs.mkdirSync(OUT, { recursive: true });

let shotN = Number(process.env.VM_SHOT_START || 0);
function sh(args, opts = {}) {
  const r = spawnSync("bash", [path.join(VMTOOLS, args[0]), ...args.slice(1)],
    { encoding: "utf8", timeout: opts.timeout || 60000, env: { ...process.env, VM_OUT: OUT } });
  if (r.status !== 0 && !opts.soft) throw new Error(args.join(" ") + " failed: " + (r.stderr || r.stdout));
  return (r.stdout || "").trim();
}
/** run a one-liner inside the Windows guest (cmd.exe, ssh session); returns stdout.
 *  Keep it quote-free — it crosses two ssh hops. Anything richer goes through bat(). */
export const guest = (cmd, opts) => sh(["vm.sh", "guest", cmd], opts);
/** numbered screenshot of the VM's real screen -> OUT/NN-name.png */
export function shot(name) {
  const n = String(++shotN).padStart(2, "0") + "-" + name.replace(/[^a-z0-9-]+/gi, "-");
  return sh(["vm.sh", "shot", n], { soft: true });
}
/** copy a local file into the guest's home (a .bat/.ps1 is also run there, in the ssh session) */
export const ship = (file, ...args) => sh(["ship.sh", file, ...args], { timeout: 300000 });
/** write lines as <name>.bat, ship, run it in the ssh session; returns its stdout */
export function bat(name, lines, opts = {}) {
  const f = path.join(OUT, name + ".bat");
  fs.writeFileSync(f, "@echo off\r\n" + lines.join("\r\n") + "\r\n");
  return sh(["ship.sh", f], { timeout: 300000, ...opts });
}
/** run lines in the INTERACTIVE desktop session (schtasks /it /rl highest — the
 *  only way a GUI or a foreground-window query works from ssh, vm-qa lessons).
 *  Returns once the task has been fired; poll for effects with waitFor(). */
export function interactive(name, lines, { tr } = {}) {
  if (!tr) {
    const f = path.join(OUT, name + ".cmd");            // .cmd: shipped, not run
    fs.writeFileSync(f, "@echo off\r\n" + lines.join("\r\n") + "\r\n");
    ship(f);
    tr = `${GUEST_HOME}\\${name}.cmd`;
  }
  return bat(name + "-task", [
    `schtasks /delete /tn era-qa-${name} /f >nul 2>&1`,
    `schtasks /create /tn era-qa-${name} /tr "${tr}" /sc once /st 00:00 /it /rl highest /f`,
    `schtasks /run /tn era-qa-${name}`,
  ]);
}
/** copy /root/<file> on the QA host into the guest's home as <name> */
export const push = (file, name) => sh(["vm.sh", "push", file, name], { timeout: 300000 });
/** run a command on the QA host itself */
export const host = (cmd, opts) => sh(["vm.sh", "host", cmd], opts);
/** roll the VM back to the pristine snapshot, wait for the guest's ssh, and
 *  take the VM's own noise out of the run (prepGuest) */
export function revert() { const out = sh(["revert.sh"], { timeout: 400000 }); prepped = false; prepGuest(); return out; }
/** the pristine snapshot (8/31) is a disk image cold-booted on every revert:
 *  Windows Update wants its backlog straight away and TrustedInstaller/TiWorker
 *  then own the emulated disk for the better part of an hour — Edge crawled
 *  for 12 min without a window and the Pencil never painted its door (9/3).
 *  The display also goes dark after 10 idle minutes. Neither is a New ERA
 *  property, so the run switches both off; Defender (quiet()) stays real. */
let prepped = false;
export function prepGuest() {
  if (prepped) return;
  const out = bat("prep", ["sc stop UsoSvc >nul 2>&1", "sc stop wuauserv >nul 2>&1",
    "sc config wuauserv start= disabled >nul", "sc config UsoSvc start= disabled >nul",
    "powercfg /change monitor-timeout-ac 0", "powercfg /change monitor-timeout-dc 0", "echo PREPPED"], { soft: true });
  if (!/PREPPED/.test(out)) throw new Error("guest prep (Windows Update off, display stays on) did not run: " + out);
  prepped = true;
}

/** silent-install an installer already pushed as <exe> in the guest's home;
 *  resolves when start-hub.bat exists and no setup process is left */
export async function installSilently(exe) {
  const out = bat("install", [`start /wait "" ${GUEST_HOME}\\${exe} /S`, `echo INSTALL_EXIT=%ERRORLEVEL%`]);
  await waitFor(() => exists(INSTDIR + "\\start-hub.bat") && { ok: 1 },
    { timeout: 180000, every: 5000, what: "start-hub.bat after silent install" });
  await waitFor(() => !new RegExp(exe, "i").test(guest("tasklist | findstr /i " + exe, { soft: true })) && { ok: 1 },
    { timeout: 60000, every: 3000, what: "installer process to exit" });
  return out;
}
/** does a path exist in the guest? (quotes survive only inside a shipped .bat) */
export const exists = (p) => /EXISTS=1/.test(bat("exists", [`if exist "${p}" (echo EXISTS=1) else (echo EXISTS=0)`]));

/** launch the installed hub + kiosk on the desktop with the QA environment:
 *  CDP on 9222 (forwarded to the QA host's :9223 through the guest's sshd),
 *  update feed + Resend pointed at the QA host's feed.py. Resolves once the
 *  hub answers and the forward is up; a hub that dies on start fails here
 *  with its own stderr (9/3: v0.31.4-qa shipped without packs.js). */
export async function launchKiosk({ feedPort = Number(process.env.VM_FEED_PORT || 8427) } = {}) {
  prepGuest();
  await quiet();
  warmEdge();
  // wake a display Windows turned off (an Edge launched onto it sat as a
  // 9 MB stub, 9/3) and clear any such stub before starting another
  sh(["vm.sh", "wake"], { soft: true });
  guest("taskkill /IM msedge.exe /F", { soft: true });
  const t0 = Date.now();
  // releases before v0.31.4 predate the launcher's ERA_QA_CDP hook: for those
  // the hub and the kiosk are started here, flag for flag like start-hub.bat
  const hooked = /ERA_QA_CDP/.test(guestFile(INSTDIR + "\\start-hub.bat"));
  const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const kioskFlags = `--kiosk "http://127.0.0.1:8377/home/" --edge-kiosk-type=fullscreen --user-data-dir="${INSTDIR}\\data\\kiosk-profile" --no-first-run --disable-pinch --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required --remote-debugging-port=9222`;
  const env = ["ERA_QA_CDP=9222", `ERA_UPDATE_URL=http://10.0.2.2:${feedPort}`, `ERA_RESEND_URL=http://10.0.2.2:${feedPort}/resend`];
  const scheduled = () => interactive("launch", [
    ...env.map((e) => "set " + e),
    ...(hooked
      ? [`call "${INSTDIR}\\start-hub.bat" 8377 /home/`]
      : [`cd /d "${INSTDIR}"`, `set ERA_DATA_DIR=${INSTDIR}\\data`,
         `start "New ERA hub" /min "${INSTDIR}\\node\\node.exe" server.js 8377`,
         "ping -n 4 127.0.0.1 >nul", `start "" "${EDGE}" ${kioskFlags}`]),
  ]);
  let launched = false;
  if (hooked) {
    // The family's own gesture: a double-click on the Desktop "New ERA" icon.
    // Explorer starts start-hub.bat with the right to put its window in
    // FRONT — a scheduled task never has that right, so a kiosk launched
    // that way always measured "Program Manager" as the foreground (runs 7-8,
    // 9/3) and the in-front test could never pass. setx makes the QA
    // environment Explorer's (it takes the change broadcast at once); the
    // icon sits third down the pristine desktop (Recycle Bin, Edge, New ERA).
    interactive("qa-env", env.map((e) => `setx ${e.replace("=", " ")} >nul`));
    // the task's console sits over the icon until setx is done (3 s was not
    // enough on the emulated disk — the double-click landed on the console)
    await waitFor(() => !/Running/.test(bat("qa-env-q", ["schtasks /query /tn era-qa-qa-env /fo list"], { soft: true })) && { ok: 1 },
      { timeout: 120000, every: 2000, what: "the setx task to finish" });
    await new Promise((r) => setTimeout(r, 2000));
    sh(["vm.sh", "dclick", "38", "235"], { soft: true });
    launched = !!(await waitFor(() => hubGet("/version") || hubGet("/settings"), { timeout: 90000, every: 3000, what: "the hub" }).catch(() => null));
    if (!launched) console.log("# WARNING: the Desktop icon did not start the hub within 90 s — launching by scheduled task instead");
  }
  if (!launched) scheduled();
  try {
    await waitFor(() => hubGet("/version") || hubGet("/settings"), { timeout: 300000, every: 3000, what: "the hub" });
  } catch {
    // start /min swallowed the hub's death: run it once more in the ssh
    // session to get the reason in front of whoever reads the log
    const why = bat("hub-why", [`cd /d "${INSTDIR}"`, `set ERA_DATA_DIR=${INSTDIR}\\data`,
      `start "" /b cmd /c ""${INSTDIR}\\node\\node.exe" server.js 8399 > ${GUEST_HOME}\\hub-why.log 2>&1"`,
      "ping -n 6 127.0.0.1 >nul", `type ${GUEST_HOME}\\hub-why.log`, "taskkill /IM node.exe /F >nul 2>&1"], { soft: true });
    throw new Error("the installed hub never answered on 8377 — run by hand it says:\n" + why);
  }
  console.log(`# hub up ${((Date.now() - t0) / 1000).toFixed(0)} s after launch`);
  // a cold Edge on the emulated guest has taken 8 min (9/3, Defender still
  // busy after the signature update): the budget is generous, the time logged
  await cdpForward(600000);
  console.log(`# kiosk DevTools up ${((Date.now() - t0) / 1000).toFixed(0)} s after launch`);
}
/** (re)make the QA-host-side forward to the kiosk's DevTools port */
export const cdpForward = (timeout = 60000) =>
  waitFor(() => sh(["vm.sh", "cdp-forward"], { soft: true, timeout: 30000 }).includes("cdp forwarded") && { ok: 1 },
    { timeout, every: 5000, what: "the kiosk's DevTools port (forwarded through the guest's sshd)" });
/** wait until the guest is not busy with Defender's signature update / first
 *  scan (MpSigStub) — it pegs every vCPU for minutes after a revert of the
 *  pristine snapshot and made an 8-minute Edge start look like a hang (9/3) */
export async function quiet() {
  const t0 = Date.now();
  // TiWorker: a servicing job already running when prepGuest stopped Windows
  // Update finishes on its own — it is what starved Edge for 12 min (9/3)
  const busy = () => /MpSigStub|OneDriveSetup|TiWorker/i.test(guest("tasklist", { soft: true }));
  if (!busy()) return;
  try { await waitFor(() => !busy() && { ok: 1 }, { timeout: 900000, every: 10000, what: "Defender's signature update / a servicing job to finish" }); }
  catch { console.log("# still busy after 15 min — carrying on"); }
  console.log(`# waited ${((Date.now() - t0) / 1000).toFixed(0)} s for the guest to go quiet`);
}
/** read Edge's binaries once so the guest's page cache holds them. The first
 *  Edge start after a boot of the emulated guest pages ~250 MB of msedge.dll
 *  in per child process from a cold disk, the children blow Chromium's
 *  15-second connect deadline ("Terminating current process after 15 seconds
 *  with no connection"), the network service dies with them and takes the
 *  kiosk's very first navigation along: a windowed Edge on about:blank for
 *  good (runs 6 and 8, 9/3 — the Edge log said so). The same launch three
 *  minutes later, DLLs warm, navigated in 4 s. A family PC keeps Edge warm
 *  itself (Startup Boost, and they downloaded the installer with it). */
export function warmEdge() {
  const t0 = Date.now();
  bat("warm", [`for /r "C:\\Program Files (x86)\\Microsoft\\Edge\\Application" %%f in (*.dll *.exe *.pak *.bin *.dat) do @type "%%f" >nul 2>&1`],
    { soft: true, timeout: 600000 });
  console.log(`# Edge binaries read once (${((Date.now() - t0) / 1000).toFixed(0)} s) so its child processes start warm`);
}
/** contents of any guest file (quotes survive inside a shipped .bat); "" when absent */
export const guestFile = (p) => bat("cat", [`if exist "${p}" type "${p}"`]);

/** read a text file from the guest's home ("" when absent) */
export const guestText = (file) => guest(`type ${GUEST_HOME}\\${file}`, { soft: true });
/** hub JSON via the guest's own curl (GET; survives hub restarts, needs no kiosk) */
export function hubGet(p) {
  try { return JSON.parse(guest(`curl -s ${HUB_URL}${p}`, { soft: true })); } catch { return null; }
}
/** hub JSON through the kiosk page itself (any method/body — no shell quoting) */
export const api = (page, p, method = "GET", body) => page.evaluate(async ([p, method, body]) => {
  const r = await fetch(p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
}, [p, method, body]);

export async function waitFor(fn, { timeout = 60000, every = 1000, what = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch {}
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, every));
  }
}

/** the launcher, from wherever the kiosk is (a navigation waits for "commit":
 *  the QEMU guest's Edge can take a while to reach "load" on a cold page) */
export async function home(page) {
  if (!/\/home\/?(\?|#|$)/.test(page.url())) await page.goto(HUB_URL + "/home/", { waitUntil: "commit", timeout: 60000 });
  await page.locator("#launcher").waitFor({ state: "visible", timeout: 90000 });
}
/** click an app tile on the launcher and wait for the app's door (its page is up) */
export async function openTile(page, title, urlRe) {
  const t0 = Date.now();
  await page.click(`#appGrid a.app:has-text('${title}')`);
  await page.waitForURL(urlRe, { waitUntil: "commit", timeout: 60000 });
  await page.locator("#door:visible, #exit:visible, [data-dwell-say*='back to']:visible").first().waitFor({ state: "visible", timeout: 120000 });
  console.log(`# ${title}: door up ${((Date.now() - t0) / 1000).toFixed(1)} s after the tile`);
}
/** attach to the kiosk window over CDP; returns { browser, page } (page = the kiosk tab) */
export async function kiosk({ timeout = 120000 } = {}) {
  const browser = await waitFor(async () => {
    try { return await chromium.connectOverCDP(CDP_URL, { timeout: 5000 }); } catch { return null; }
  }, { timeout, every: 3000, what: "CDP on " + CDP_URL });
  // DevTools answers before the kiosk tab has left about:blank — a cold Edge
  // on the emulated guest sat there 2+ min (9/3); time logged when it is slow
  const t0 = Date.now();
  let seen = "", shots = 0;
  const page = await waitFor(async () => {
    const urls = [];
    for (const c of browser.contexts()) for (const p of c.pages()) { urls.push(p.url()); if (p.url().startsWith(HUB_URL)) return p; }
    // what Edge is showing instead — logged on change, a screenshot at 30 s and 5 min
    const now = urls.join(" | ") || "(no pages)";
    if (now !== seen) { seen = now; console.log(`# kiosk tabs: ${now}`); }
    const waited = Date.now() - t0;
    if ((shots === 0 && waited > 30000) || (shots === 1 && waited > 300000)) { shots++; shot(`kiosk-waiting-${shots}`); }
    return null;
  }, { timeout: 600000, every: 3000, what: "the kiosk tab (a page on " + HUB_URL + ")" })
    .catch((e) => { throw new Error(e.message + " — tabs: " + seen); });
  if (Date.now() - t0 > 15000) console.log(`# kiosk tab reached the hub ${((Date.now() - t0) / 1000).toFixed(0)} s after DevTools answered`);
  // the real thing is a full-screen kiosk window: its viewport IS the screen.
  // (outerWidth/outerHeight lied — a maximized normal window with the taskbar
  // showing passed that test on run 8, 9/3.) Edge's first start on a fresh
  // kiosk-profile came up as exactly such a window, on about:blank.
  // Position matters as much as size: on run 10 (9/3) a first Desktop-icon
  // launch was screen-sized but sat at (10,10) with the taskbar over its
  // bottom edge — the screenshots showed it, the size check did not.
  const { fullscreen, win } = await geometry(page);
  return { browser, page, fullscreen, win };
}

/** what the family does after a site opened in its own window: closes that
 *  window (its X) and clicks the kiosk back up from the taskbar — it stepped
 *  aside (minimized) so the site could show. Without this every later
 *  screenshot is of the site's window (run 11, 9/3). Non-kiosk Edge
 *  processes are ended; then the family's own gesture — a click on the
 *  kiosk's taskbar button (the pristine taskbar: pinned Edge, Explorer,
 *  Store, Mail, then the running kiosk at x≈686) — brings it back FULL-
 *  SCREEN. A scripted ShowWindow 9 + SetForegroundWindow from a desktop-
 *  session task also brought it to the front but left the taskbar drawn
 *  over its bottom row (run 13, 9/3); it stays only as the fallback. */
export async function closeSiteWindow() {
  bat("close-site", [`wmic process where "name='msedge.exe' and not commandline like '%%kiosk-profile%%'" call terminate >nul 2>&1`, "echo closed"], { soft: true });
  await new Promise((r) => setTimeout(r, 3000));
  sh(["vm.sh", "click", process.env.VM_KIOSK_TASKBAR_X || "686", "748"], { soft: true });
  await new Promise((r) => setTimeout(r, 4000));
  const front = await frontTitle();
  if (/New ERA|ERAgaze/.test(front)) { console.log("# taskbar click restored the kiosk: " + JSON.stringify(front)); return; }
  console.log("# WARNING: the taskbar click left " + JSON.stringify(front) + " in front — restoring the kiosk by script (expect the taskbar over it)");
  // shipped as .txt (ship.sh RUNS a .ps1 in the ssh session, where no window
  // handle is visible and its 'done' would land first), renamed in the guest
  const ps = path.join(OUT, "restore-kiosk.txt");
  fs.writeFileSync(ps, [
    `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'`,
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*kiosk-profile*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object {`,
    `  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue`,
    `  if ($p -and $p.MainWindowHandle -ne 0) { 'restored ' + [U.W]::ShowWindow($p.MainWindowHandle, 9) + ' fg ' + [U.W]::SetForegroundWindow($p.MainWindowHandle) | Out-File -Append "$env:USERPROFILE\\restore-kiosk.log" }`,
    `}`,
    `'done' | Out-File -Append "$env:USERPROFILE\\restore-kiosk.log"`,
  ].join("\r\n") + "\r\n");
  ship(ps);
  bat("restore-prep", [`copy /y ${GUEST_HOME}\\restore-kiosk.txt ${GUEST_HOME}\\restore-kiosk.ps1 >nul`, `del ${GUEST_HOME}\\restore-kiosk.log 2>nul`, "echo prepped"]);
  interactive("restore-kiosk", [`powershell -NoProfile -ExecutionPolicy Bypass -File "${GUEST_HOME}\\restore-kiosk.ps1"`]);
  const log = await waitFor(() => { const l = guestText("restore-kiosk.log"); return /done/.test(l) && l; },
    { timeout: 300000, every: 5000, what: "the kiosk to be restored (restore-kiosk.log)" });
  console.log("# restore-kiosk: " + log.replace(/\s+/g, " ").trim());
  await new Promise((r) => setTimeout(r, 3000));
}

/** the kiosk viewport against the screen — re-measured after the hub's
 *  first-launch settle (clearStageOnce), which is what fixes the (10,10) case */
export async function geometry(page) {
  const win = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, x: window.screenX, y: window.screenY, sw: screen.width, sh: screen.height }));
  const fullscreen = win.w >= win.sw && win.h >= win.sh && win.x === 0 && win.y === 0;
  if (!fullscreen) console.log(`# WARNING: kiosk viewport is ${win.w}x${win.h} at (${win.x},${win.y}) on a ${win.sw}x${win.sh} screen — not full-screen`);
  return { fullscreen, win };
}

/** what the guest shows IN FRONT: the top-level window under the screen's
 *  centre (User32 WindowFromPoint), plus the foreground (focused) window's
 *  title — the "opens in its own window, in front" law (dad 9/2). They differ:
 *  a kiosk started from the Desktop icon is drawn on top of everything while
 *  the desktop ("Program Manager") keeps the focus (9/3), and what the family
 *  sees is the window on top. A 20-line C# helper compiled ONCE per VM with
 *  Windows' own csc (the same one the hub uses for ERAgaze) as a windowless
 *  exe: no console of its own to steal the foreground (the PowerShell version
 *  answered "Administrator: cmd.exe" to itself), and no Add-Type compile per
 *  call (210 s cold on the QEMU guest, 9/3). Runs in the desktop session. */
let fgBuilt = false;
export async function windows() {
  if (!fgBuilt) {
    const cs = path.join(OUT, "fg.cs");
    fs.writeFileSync(cs, `using System; using System.IO; using System.Text; using System.Runtime.InteropServices;
class P { [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
 [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
 static string T(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
 static string E(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return ""; } }
 static void Main(string[] a) { var p = new POINT(); p.x = GetSystemMetrics(0) / 2; p.y = GetSystemMetrics(1) / 2;
  var top = GetAncestor(WindowFromPoint(p), 2);
  File.WriteAllText(a[0], "TITLE=" + T(GetForegroundWindow()) + "\\r\\nTOP=" + T(top) + "\\r\\nTOPEXE=" + E(top) + "\\r\\n"); } }
`);
    ship(cs);
    const out = bat("fg-build", [`if exist ${GUEST_HOME}\\fg.exe del ${GUEST_HOME}\\fg.exe`,
      `C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe /nologo /target:winexe /out:${GUEST_HOME}\\fg.exe ${GUEST_HOME}\\fg.cs`,
      `if exist ${GUEST_HOME}\\fg.exe (echo FG_BUILT=1) else (echo FG_BUILT=0)`], { soft: true, timeout: 180000 });
    if (!/FG_BUILT=1/.test(out)) throw new Error("fg.exe did not build in the guest: " + out);
    fgBuilt = true;
  }
  guest(`del ${GUEST_HOME}\\fg.txt`, { soft: true });
  interactive("fg", [], { tr: `${GUEST_HOME}\\fg.exe ${GUEST_HOME}\\fg.txt` });
  const r = await waitFor(() => {
    const t = guestText("fg.txt"); const m = t.match(/^TITLE=(.*)$/m), n = t.match(/^TOP=(.*)$/m), e = t.match(/^TOPEXE=(.*)$/m);
    return m && n && e && { fg: m[1].trim(), top: n[1].trim(), topExe: e[1].trim() };
  }, { timeout: 90000, every: 2000, what: "fg.txt" });
  console.log(`# in front: ${JSON.stringify(r.top)} (${r.topExe}) — focused: ${JSON.stringify(r.fg)}`);
  return r;
}
/** the window the family sees in front (title of the top-level window under
 *  the screen's centre; a title can be empty — Edge's first-run welcome is) */
export const frontTitle = async () => (await windows()).top;
/** the focused window's title (GetForegroundWindow) */
export const foregroundTitle = async () => (await windows()).fg;
