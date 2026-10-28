// The hub's half of "button press to ask" (design 2026-10-27 §4.1-§4.2).
//
// A partner's button — a Flic in keyboard mode, the I-13's Square button set
// to send a key — is caught on the device as a global hotkey and posted here
// as POST /buttons/press {"key":"F13","action":"ask"}. The route is loopback
// only (a press from the school network never reaches this) and counts as
// activity. press() validates the key and drives one dispatcher:
//
//   ask, Chat page connected and visible     push `ask` on its command stream
//   ask, Chat page connected but hidden      foreground the kiosk, wait for the
//                                            page to say it is visible, push
//   ask, no Chat page listening              relaunch the kiosk at /chat/?ask=<nonce>
//   ask while a listening window is open     the second press: end the window
//   ask while another press is in flight     busy (one dispatch per hub)
//   cancel                                   close an open window, else abort a
//                                            press still in flight and revoke
//                                            its nonce, else nothing
//   Chat turned off                          409, nothing happens
//
// Every dependency is injected (the command stream lives in chat-api.js, the
// kiosk helpers in server.js and kiosk-launch.js), so the dispatcher is tested
// without a hub, a browser or Windows.
'use strict';

// The keys the device listener holds (design §4.1, §6). Fixed in this release.
const KEYS = Object.freeze({ 'F13': 'ask', 'Ctrl+Alt+F9': 'ask', 'Ctrl+Alt+F10': 'ask', 'F14': 'cancel', 'Ctrl+Alt+F11': 'cancel' });
const BODY_BYTES = 1024;
const ABORTED = Symbol('aborted');
// A relaunched kiosk is up within the 7 s budget (design §4.2); 2 s more and a
// page that never connected is not coming: the next press dispatches afresh.
const COMING_MS = 7000 + 2000;

// The press body: small JSON, anything else is null (and then a 400).
function readBody(req, cap = BODY_BYTES) {
  return new Promise(resolve => {
    let body = '', over = false;
    req.on('data', chunk => { if (over) return; body += chunk; if (body.length > cap) { over = true; body = ''; } });
    req.on('end', () => { if (over) return resolve(null); try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

function createButtons(options = {}) {
  const enabledChat = options.enabledChat || (() => false);
  const log = options.log || (() => {});
  const clock = options.clock || Date.now;
  const platform = options.platform || process.platform;
  const commands = options.commands;
  const kiosk = options.kiosk || { foreground: async () => false, relaunch: async () => ({}) };
  const openWindow = options.window || (() => null);
  const visibleWaitMs = options.visibleWaitMs ?? 3000;
  let lastPress = null;
  let coming = null;   // the nonce of a relaunch still coming up
  let comingAt = 0;    // when it was launched (the injected clock)
  // The one press being dispatched (foregrounding a hidden page, waiting for
  // it to be seen). A second press while it runs is `busy` (or `end` once a
  // window exists): two presses falling through to relaunch would close and
  // spawn twice on one profile. A cancel aborts it before any relaunch.
  let inFlight = null;

  function relaunch(key, at) {
    const nonce = commands.issue({ pressAt: at, key });
    coming = nonce; comingAt = clock();
    Promise.resolve().then(() => kiosk.relaunch('/chat/?ask=' + nonce))
      .then(result => { if (result && result.ok === false) throw new Error(result.reason || 'not launched'); })
      .catch(error => {
        log('relaunch failed: ' + (error && error.message));
        // Nothing is coming up: the next press may try again at once.
        if (coming === nonce) { commands.revoke(nonce); coming = null; }
      });
    return 'relaunch';
  }
  async function dispatch(action, key, at) {
    const window = openWindow();
    if (coming && !commands.pending(coming)) coming = null;
    // Past the relaunch budget the page is not coming: revoke its nonce (it can
    // never ask late) and stop answering busy.
    if (coming && clock() - comingAt > COMING_MS) { commands.revoke(coming); coming = null; }
    if (action === 'cancel') {
      if (window) { window.cancel(); commands.push({ type: 'cancel' }); return 'cancel'; }
      if (inFlight || coming) {
        if (inFlight) inFlight.abort();
        if (coming) { commands.revoke(coming); coming = null; }
        return 'cancel';
      }
      return 'none';
    }
    // A second press while a listening window is open ends it (design §4.4).
    if (window) { window.press(); commands.push({ type: 'end' }); return 'end'; }
    // An earlier press is still being dispatched, or the kiosk is already
    // coming up for it: that press asks.
    if (inFlight || coming) return 'busy';
    const ask = { type: 'ask', pressAt: at, key };
    const page = commands.state();
    if (page.connected && page.visible === true && commands.push(ask)) return 'visible';
    if (!page.connected) return relaunch(key, at);
    // Hidden behind TD Snap (the talk door) or not yet reported: bring the
    // kiosk forward and wait for the page itself to say it can be seen; a
    // hidden page refuses to start a session. A cancel meanwhile ends the wait
    // at once and nothing is relaunched.
    let abort;
    const aborted = new Promise(resolve => { abort = () => resolve(ABORTED); });
    const flight = inFlight = { abort };
    try {
      const found = await Promise.race([kiosk.foreground(), aborted]);
      if (found === ABORTED) return 'cancelled';
      const seen = found && await Promise.race([commands.waitVisible(visibleWaitMs), aborted]);
      if (seen === ABORTED) return 'cancelled';
      if (seen && commands.push(ask)) return 'foreground';
      return relaunch(key, at);
    } finally {
      if (inFlight === flight) inFlight = null;
    }
  }

  async function press(body) {
    const key = body && typeof body === 'object' ? body.key : undefined;
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(KEYS, key)) return { status: 400, ok: false, error: 'unknown-key' };
    const action = KEYS[key];
    if (body.action !== undefined && body.action !== action) return { status: 400, ok: false, error: 'wrong-action' };
    const at = clock();
    if (!enabledChat()) {
      lastPress = { at: new Date(at).toISOString(), key, action, dispatch: 'chat-off' };
      log('press ' + key + ' (' + action + '): Chat is off');
      return { status: 409, ok: false, error: 'chat-off' };
    }
    const how = await dispatch(action, key, at);
    lastPress = { at: new Date(at).toISOString(), key, action, dispatch: how };
    log('press ' + key + ' (' + action + '): ' + how);
    return { status: 200, ok: true, dispatch: how };
  }

  // /status.buttons: the device listener's fields from its keeper
  // (createListener below), and the last press. Off Windows there is no
  // listener at all.
  function status() {
    const listener = options.listener ? options.listener.status()
      : { state: platform === 'win32' ? 'stopped' : 'unsupported', pid: null, keys: { registered: [], failed: [] }, restarts: 0, lastError: null, micPolicy: 'n/a', micPolicyError: null };
    return { state: listener.state, pid: listener.pid, keys: listener.keys,
      lastPress: lastPress && { ...lastPress }, restarts: listener.restarts, lastError: listener.lastError,
      micPolicy: listener.micPolicy, micPolicyError: listener.micPolicyError ?? null };
  }

  return { press, status, readBody };
}

// ---- the device listener (design §4.1, §4.3; plan T5.2, T5.3, T5.5) ----
//
// buttons/EraButtons.cs ships as source and is compiled on the device with
// Windows' own csc, exactly as the gaze engine is (server.js installGaze): the
// sha256 of the source each exe was built from sits beside it, a changed
// source recompiles at the next boot, the new build goes to EraButtons.new.exe
// and replaces the exe only after ours is stopped (by its full path, never by
// a process name), and a failed compile leaves the old exe and its hash alone.
//
// The keeper (decision 4) runs the exe as the hub's own child, not detached:
// it inherits her desktop session, which RegisterHotKey needs (W4). Its one
// stdout line says which keys it holds. When it exits it is started again
// after 5, 15, 60, then every 300 s; ten minutes alive resets that ladder.
// It runs only while Chat is on: Chat turned off stops our child, then ours by
// path. The listener itself leaves when the hub's pid is gone.
//
// The microphone (decision 6, W3): a press must start Chat without a touch,
// and only a policy can pre-grant the microphone. Both browsers' per-user
// AudioCaptureAllowedUrls get value 1 = this hub's origin, written with
// reg.exe once per boot while Chat is on. Whether an unmanaged machine honours
// it is the VM case's verdict; the one-touch line on the page stands either way.
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const BACKOFF_MS = Object.freeze([5000, 15000, 60000, 300000]);
const HEALTHY_MS = 10 * 60 * 1000;
const POLICY_KEYS = Object.freeze([
  'HKCU\\Software\\Policies\\Google\\Chrome\\AudioCaptureAllowedUrls',
  'HKCU\\Software\\Policies\\Microsoft\\Edge\\AudioCaptureAllowedUrls',
]);
const FILES = Object.freeze({ source: 'EraButtons.cs', exe: 'EraButtons.exe', next: 'EraButtons.new.exe', hash: 'EraButtons.exe.src-sha256' });

function cscArgs(out, source) {
  return ['/nologo', '/target:winexe', '/platform:x64', '/out:' + out, '/r:System.Windows.Forms.dll', source];
}
// reg.exe by its full path: never whatever a PATH lookup finds first.
const REG = 'C:\\Windows\\System32\\reg.exe';
// A refused policy write is tried once more this long after (a profile not yet
// loaded at boot is a plausible cause), then left alone until the next boot.
const POLICY_RETRY_MS = 30 * 1000;
function micPolicyArgs(port) {
  return POLICY_KEYS.map(key => ['add', key, '/v', '1', '/t', 'REG_SZ', '/d', 'http://127.0.0.1:' + port, '/f']);
}
// The listener's start line, or null: two arrays of known key names.
function parseRegistration(line) {
  let j;
  try { j = JSON.parse(String(line).trim()); } catch { return null; }
  const known = list => Array.isArray(list) && list.every(k => typeof k === 'string' && Object.prototype.hasOwnProperty.call(KEYS, k));
  if (!j || typeof j !== 'object' || !known(j.registered) || !known(j.failed)) return null;
  return { registered: [...j.registered], failed: [...j.failed] };
}
// Ours, by full path (the gaze engine's stop, server.js gazeStopScript). Same
// quoting law as the hub's other window scripts: single quotes only, doubled.
function stopScript(exe) {
  return "Get-Process EraButtons -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '" + String(exe).replace(/'/g, "''") + "' } | Stop-Process -Force";
}
function defaultRun(cmd, args, { timeout = 120000 } = {}) {
  return new Promise(resolve => {
    try {
      require('node:child_process').execFile(cmd, args, { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 1 << 20 },
        (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr, error }));
    } catch (error) { resolve({ status: 1, stdout: '', stderr: '', error }); }
  });
}
// A runtime powershell.exe -Command spawn, as the gaze engine's stop: allowed
// (plan I1); the payload law forbids .ps1 files, not this.
function defaultStopByPath(exe, platform) {
  if (platform !== 'win32') return Promise.resolve();
  return defaultRun('powershell.exe', ['-NoProfile', '-Command', stopScript(exe)], { timeout: 20000 });
}

function createListener(options = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const platform = options.platform || process.platform;
  const dir = options.dir;
  const port = options.port;
  const hubPid = options.hubPid ?? process.pid;
  const enabled = options.enabled || (() => false);
  const now = options.now || Date.now;
  const log = options.log || (() => {});
  const run = options.run || defaultRun;
  const spawn = options.spawn || require('node:child_process').spawn;
  const stopByPath = options.stopByPath || (exe => defaultStopByPath(exe, platform));
  const backoffMs = options.backoffMs || BACKOFF_MS;
  const healthyMs = options.healthyMs ?? HEALTHY_MS;
  // csc is Windows' own; a stub compiler (ERA_BUTTONS_CSC) lets the hub's
  // suites run the whole path elsewhere, as ERA_GAZE_CSC does for the engine.
  const supported = platform === 'win32' || !!options.csc;
  const cscCmd = options.csc || CSC;
  const canPolicy = platform === 'win32' || !!options.reg;
  const regCmd = options.reg || REG;
  const source = path.join(dir, FILES.source), exe = path.join(dir, FILES.exe);
  const next = path.join(dir, FILES.next), hashFile = path.join(dir, FILES.hash);
  const empty = () => ({ registered: [], failed: [] });

  let started = false;
  let state = supported ? 'stopped' : 'unsupported';
  let child = null, pid = null, keys = empty(), startedAt = 0;
  let restarts = 0, step = 0, nextAt = 0, lastError = null;
  let micPolicy = 'n/a', micPolicyError = null, policyWriting = null, policyFailedAt = 0, policyRetried = false;
  let compiling = null, failedHash = null;

  const sourceHash = () => crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  function needsCompile() {
    if (!fs.existsSync(exe)) return true;
    try { return fs.readFileSync(hashFile, 'utf8').trim() !== sourceHash(); } catch { return true; }
  }

  function writePolicy() {
    if (!canPolicy) return policyWriting;
    // one retry, POLICY_RETRY_MS after a refusal; then the refusal stands
    if (policyWriting && micPolicy === 'failed' && !policyRetried && now() - policyFailedAt >= POLICY_RETRY_MS) {
      policyRetried = true; policyWriting = null;
      log('microphone policy: trying once more');
    }
    if (policyWriting) return policyWriting;
    policyWriting = Promise.all(micPolicyArgs(port).map(args => Promise.resolve(run(regCmd, args, { timeout: 20000 }))
      .catch(error => ({ status: 1, stdout: '', stderr: '', error }))))
      .then(results => {
        const bad = results.find(r => r.status !== 0);
        micPolicy = bad ? 'failed' : 'written';
        micPolicyError = bad ? ((String(bad.stdout || '') + String(bad.stderr || '')).trim() || (bad.error && bad.error.message) || 'status ' + bad.status).replace(/\s+/g, ' ').trim().slice(0, 200) : null;
        if (bad) { policyFailedAt = now(); log('microphone policy not written: ' + micPolicyError); }
        else log('microphone policy written for http://127.0.0.1:' + port);
      });
    return policyWriting;
  }

  async function compile() {
    const srcHash = sourceHash();
    const fresh = !fs.existsSync(exe);
    try { fs.rmSync(next, { force: true }); } catch {}
    const r = await run(cscCmd, cscArgs(next, source), { timeout: 120000 });
    if (r.status !== 0 || !fs.existsSync(next)) {
      try { fs.rmSync(next, { force: true }); } catch {}
      // csc reports on stdout (the gaze engine's lesson)
      const why = (String(r.stdout || '') + String(r.stderr || '')).trim() || (r.error && r.error.message) || 'status ' + r.status;
      // this source is not tried again until the next boot: one line, once
      failedHash = srcHash;
      lastError = 'compile failed: ' + why.replace(/\s+/g, ' ').slice(0, 400);
      log(lastError);
      return false;
    }
    if (!fresh) {
      // a running listener holds its exe open: stop ours (by path), then swap
      stopChild();
      await stopByPath(exe);
    }
    try { fs.renameSync(next, exe); }
    catch (error) {
      try { fs.rmSync(next, { force: true }); } catch {}
      failedHash = srcHash;
      log('the rebuilt listener could not replace the running one (' + (error.code || error.message) + '); retrying next boot');
      return false;
    }
    fs.writeFileSync(hashFile, srcHash + '\n');
    failedHash = null;
    log(fresh ? 'listener compiled' : 'recompiled from updated source');
    return true;
  }

  function stopChild() {
    if (!child) return false;
    const c = child;
    c.stopping = true;
    child = null; pid = null; keys = empty();
    try { c.kill(); } catch {}
    return true;
  }

  function spawnChild() {
    const at = now();
    let c;
    try { c = spawn(exe, [String(port), String(hubPid)], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
    catch (error) { c = null; failed(null, error, at); return; }
    child = c; pid = c.pid ?? null; startedAt = at; state = 'starting'; keys = empty();
    let buffer = '', seen = false, done = false;
    if (c.stdout) c.stdout.on('data', data => {
      if (seen) return;
      buffer += data;
      let cut;
      while (!seen && (cut = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
        const parsed = parseRegistration(line);
        if (parsed && child === c) {
          seen = true; keys = parsed; state = 'running';
          log('listener running: holds ' + (parsed.registered.join(', ') || 'no keys') + (parsed.failed.length ? '; refused ' + parsed.failed.join(', ') : ''));
        }
      }
      if (buffer.length > 4096) buffer = '';
    });
    const end = (code, error) => {
      if (done) return; done = true;
      if (child !== c || c.stopping) return;   // stopped on purpose: not a crash
      child = null; pid = null; keys = empty();
      failed(code, error, startedAt);
    };
    c.on('error', error => end(null, error));
    c.on('exit', (code, signal) => end(code ?? signal, null));
  }
  // An exit (or a start that never happened): the next rung of the ladder.
  function failed(code, error, since) {
    const t = now();
    if (t - since >= healthyMs) step = 0;
    const delay = backoffMs[Math.min(step, backoffMs.length - 1)];
    step++; restarts++; nextAt = t + delay; state = 'restarting';
    lastError = error ? 'start: ' + error.message : code === 3 ? 'another listener holds the keys' : 'exited (' + code + ')';
    log('listener ' + lastError + '; next start in ' + Math.round(delay / 1000) + ' s');
  }

  // The hub calls tick() every few seconds (and when Chat is toggled); start()
  // arms it once the boot reconcile has run.
  async function tick() {
    if (!started) return;
    if (!supported) { state = 'unsupported'; return; }
    if (!enabled()) {
      if (stopChild()) {
        log('Chat turned off: listener stopped');
        Promise.resolve(stopByPath(exe)).catch(() => {});
      }
      if (!compiling) state = 'off';
      return;
    }
    writePolicy();
    if (compiling) return compiling;
    if (child) {
      if (now() - startedAt >= healthyMs) step = 0;
      return policyWriting;
    }
    if (fs.existsSync(source) && needsCompile() && sourceHash() !== failedHash) {
      compiling = (async () => { state = 'compiling'; await compile(); })()
        .catch(error => { lastError = 'compile failed: ' + error.message; log(lastError); })
        .finally(() => { compiling = null; });
      await compiling;
    }
    if (!child && enabled()) {
      if (!fs.existsSync(exe)) state = failedHash ? 'failed' : 'stopped';
      else if (now() < nextAt) state = 'restarting';
      else spawnChild();
    }
    if (policyWriting) await policyWriting;
  }
  function start() { started = true; return tick(); }
  function stop() { started = false; stopChild(); if (supported) state = 'stopped'; }
  function status() {
    return { state, pid, keys: { registered: [...keys.registered], failed: [...keys.failed] }, restarts, lastError, micPolicy, micPolicyError };
  }
  return { start, tick, stop, status, compile, paths: { source, exe, next, hash: hashFile } };
}

module.exports = { createButtons, KEYS, readBody, createListener, cscArgs, micPolicyArgs, parseRegistration, stopScript, CSC, REG, POLICY_RETRY_MS, BACKOFF_MS, HEALTHY_MS, POLICY_KEYS };
