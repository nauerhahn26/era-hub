// The hub relaunches its own kiosk window (button press to ask, design
// 2026-10-27 §4.2 case 3; plan decision 2). Until now only start-hub.bat
// launched the kiosk; this is the same launch from node, with the bat's flags
// and the bat's browser order (tests/kiosk-launch.test.mjs derives both from
// the bat's text, so the two cannot drift apart).
//
// The browser exe is spawned directly: a relaunch through the command shell
// was refused under Defender ("spawn EPERM", update.js), and the payload ships
// no PowerShell files. Closing the old kiosk and settling the new window in
// front are the hub's existing helpers (closeKiosk, psSettleKiosk), injected,
// as is kioskGone (the process list read by the profile marker): the spawn
// waits until the old kiosk's processes are gone, up to 5 s.
// Off Windows there is no window: the relaunch records {would: args}.
'use strict';
const fs = require('node:fs');
const childProcess = require('node:child_process');

// start-hub.bat probes Edge, then Chrome, then Chrome (x86), and the LAST one
// that exists wins; this list is that order, best first.
const BROWSERS = Object.freeze([
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]);

function findBrowser(exists = fs.existsSync) {
  for (const file of BROWSERS) { try { if (exists(file)) return file; } catch { /* unreadable is absent */ } }
  return null;
}

// The kiosk line's arguments, as the browser receives them. `dir` is the
// install folder (the bat's %~dp0); the profile marker is what closeKiosk and
// the gaze engine recognise as the hub's own kiosk.
function kioskArgs(open, { port, dir, cdp } = {}) {
  const root = String(dir || '').replace(/[\\/]+$/, '') + '\\';
  const args = ['--force-device-scale-factor=1', '--hide-crash-restore-bubble', '--kiosk', 'http://127.0.0.1:' + port + open,
    '--edge-kiosk-type=fullscreen', '--user-data-dir=' + root + 'data\\kiosk-profile', '--no-first-run', '--disable-pinch',
    '--overscroll-history-navigation=0', '--autoplay-policy=no-user-gesture-required'];
  // QA only, as in the bat: the VM e2e drives the window over DevTools.
  if (/^\d{1,5}$/.test(String(cdp || ''))) args.push('--remote-debugging-port=' + cdp);
  return args;
}

// A browser started on a profile the dying kiosk still holds joins that
// instance (the single-instance hand-off) instead of starting a kiosk, so the
// spawn waits for the old processes to be gone; past the budget it is logged
// and the spawn goes ahead anyway.
const GONE_MS = 5000;
const POLL_MS = 250;

function createKioskLauncher(options = {}) {
  const { port, dir, cdp } = options;
  const platform = options.platform || process.platform;
  const exists = options.exists || fs.existsSync;
  const spawn = options.spawn || childProcess.spawn;
  const closeKiosk = options.closeKiosk || (async () => {});
  const settle = options.settle || (async () => {});
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const log = options.log || (() => {});
  const now = options.now || Date.now;
  // true = no kiosk process left, false = some still running, null = unknown
  const kioskGone = options.kioskGone || null;
  let last = null;

  async function oldKioskGone() {
    const t0 = now();
    for (;;) {
      let gone = null;
      if (kioskGone) { try { gone = await kioskGone(); } catch { gone = null; } }
      if (gone === true) return;
      if (gone !== false) {
        if (kioskGone) log('relaunch: cannot list the kiosk processes; pausing 1 s');
        await wait(1000);
        return;
      }
      if (now() - t0 >= GONE_MS) { log('relaunch: the old kiosk is still running after 5 s; launching anyway'); return; }
      await wait(POLL_MS);
    }
  }

  async function relaunch(open) {
    const args = kioskArgs(open, { port, dir, cdp });
    if (platform !== 'win32') { last = { would: args }; log('relaunch (would) ' + args.join(' ')); return last; }
    const exe = findBrowser(exists);
    if (!exe) { last = { ok: false, reason: 'no-browser' }; log('relaunch: no browser found'); return last; }
    try {
      // The old kiosk goes first: a second launch on the same profile joins the
      // running browser and drops out of kiosk (start-hub.bat, dad 9/6).
      await closeKiosk();
      await oldKioskGone();
      // No windowsHide: the browser has no console to hide, and the flag can
      // start the kiosk hidden, where settleKiosk (MainWindowHandle -ne 0)
      // never finds it.
      const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
      child.on?.('error', error => log('relaunch: ' + error.message));
      child.unref();
    } catch (error) {
      last = { ok: false, reason: error.message }; log('relaunch: ' + error.message); return last;
    }
    last = { ok: true, exe };
    log('relaunched ' + open);
    try { await settle(); } catch (error) { log('relaunch settle: ' + error.message); }
    return last;
  }
  return { relaunch, last: () => last };
}

module.exports = { kioskArgs, findBrowser, createKioskLauncher, BROWSERS, GONE_MS, POLL_MS };
