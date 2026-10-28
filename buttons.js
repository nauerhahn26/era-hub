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

  // /status.buttons. The listener fields are filled by the device listener's
  // keeper (plan phase 5); off Windows there is no listener at all.
  function status() {
    return { state: platform === 'win32' ? 'stopped' : 'unsupported', pid: null, keys: { registered: [], failed: [] },
      lastPress: lastPress && { ...lastPress }, restarts: 0, lastError: null, micPolicy: 'n/a' };
  }

  return { press, status, readBody };
}

module.exports = { createButtons, KEYS, readBody };
