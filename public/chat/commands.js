// The hub's command stream for this page (button press to ask, design
// 2026-10-27 §4.2; plan T2.1). Opened at load, before any session: the hub
// pushes `ask {pressAt, key, nonce?}`, `end` and `cancel` when the partner's
// button is pressed. A kiosk the hub relaunched for a press opens
// /chat/?ask=<nonce>; the nonce goes to the hub once with the connection (the
// hub replays that press as `ask` exactly once) and is stripped from the
// address, so a reload never asks again. The page reports whether it can be
// seen, at connect and on every change: the hub brings a hidden page forward
// before it asks. A newer Chat page replaces this one on the stream; this one
// then stops listening rather than fight for it.
const COMMANDS = '/chat/api/commands';
const NONCE = /^[0-9a-f]{16}$/;

export function connectCommands({ onCommand, location = window.location, history = window.history, doc = document,
  EventSourceClass = globalThis.EventSource, fetcher = (...args) => fetch(...args) } = {}) {
  const params = new URLSearchParams(location.search);
  const nonce = NONCE.test(params.get('ask') || '') ? params.get('ask') : null;
  const visible = () => doc.visibilityState === 'visible';
  let claimed = !params.has('ask');
  // The press is the hub's to replay once; the address never carries it again.
  function strip() {
    if (claimed) return;
    claimed = true; params.delete('ask');
    const search = params.toString();
    try { history.replaceState(history.state, '', location.pathname + (search ? '?' + search : '') + location.hash); } catch { /* the hub already spent it */ }
  }
  const report = () => fetcher(`${COMMANDS}/visibility`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visible: visible() }) }).catch(() => {});
  const query = new URLSearchParams({ visible: visible() ? '1' : '0', ...(nonce ? { nonce } : {}) });
  const source = new EventSourceClass(`${COMMANDS}?${query}`);
  // A reconnect carries the spent nonce and the visibility of load time: say it again.
  source.onopen = () => { strip(); report(); };
  source.onmessage = event => {
    let command; try { command = JSON.parse(event.data); } catch { return; }
    if (!command || typeof command.type !== 'string' || command.type === 'ping') return;
    if (command.type === 'replaced') { source.close(); doc.removeEventListener('visibilitychange', report); return; }
    if (command.type === 'ask' && command.nonce) strip();
    try { onCommand?.(command); } catch { /* a command never breaks the stream */ }
  };
  doc.addEventListener('visibilitychange', report);
  return { nonce, close() { source.close(); doc.removeEventListener('visibilitychange', report); } };
}
