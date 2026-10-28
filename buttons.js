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
//   cancel                                   close an open window, else nothing
//   Chat turned off                          409, nothing happens
//
// Every dependency is injected (the command stream lives in chat-api.js, the
// kiosk helpers in server.js and kiosk-launch.js), so the dispatcher is tested
// without a hub, a browser or Windows.
'use strict';

// The keys the device listener holds (design §4.1, §6). Fixed in this release.
const KEYS = Object.freeze({ 'F13': 'ask', 'Ctrl+Alt+F9': 'ask', 'Ctrl+Alt+F10': 'ask', 'F14': 'cancel', 'Ctrl+Alt+F11': 'cancel' });
const BODY_BYTES = 1024;

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
  let lastPress = null;

  async function dispatch(action, key, at) { // eslint-disable-line no-unused-vars
    return 'none';
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
