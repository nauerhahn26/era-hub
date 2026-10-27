// Adult app management uses the same state, passcode and expiry as every app.
import { APP_LOCKS, getAppLock, refreshLockSettings } from '/lib/app-lock.js';
const host = document.getElementById('appLocks');
if (host) {
  const rows = new Map();
  function status(id) {
    const row = rows.get(id); if (!row) return;
    const lock = row.controller.read();
    row.status.textContent = lock ? (lock.until ? 'Locked until ' + new Date(lock.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Locked until unlocked') : 'Available';
    if (row.controller.message) row.status.textContent += '. ' + row.controller.message;
    row.button.textContent = lock ? 'Unlock' : 'Lock';
    row.button.setAttribute('aria-label', (lock ? 'Unlock ' : 'Lock ') + row.title);
  }
  async function load() {
    try {
      const response = await fetch('/apps', { cache: 'no-store' });
      if (!response.ok) throw new Error('App list could not be loaded.');
      const { apps } = await response.json();
      if (!Array.isArray(apps)) throw new Error('App list could not be loaded.');
      await refreshLockSettings();
      host.textContent = '';
      for (const app of APP_LOCKS) {
        const installed = apps.find(item => item.id === app.id);
        if (!installed || !installed.installed) continue;
        const controller = getAppLock(app.id);
        const row = document.createElement('div'); row.className = 'row'; row.dataset.appLockId = app.id;
        row.style.cssText = 'justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);flex-wrap:wrap';
        const label = document.createElement('div'); label.style.flex = '1';
        const title = document.createElement('strong'); title.textContent = app.title;
        const detail = document.createElement('div'); detail.className = 'hint'; detail.setAttribute('role', 'status');
        const button = document.createElement('button'); button.type = 'button';
        label.append(title, detail); row.append(label, button); host.append(row);
        rows.set(app.id, { controller, status: detail, button, title: app.title });
        controller.subscribe(() => status(app.id));
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { if (controller.isLocked()) await controller.requestUnlock(); else await controller.lock(); }
          finally { button.disabled = false; status(app.id); }
        });
      }
      if (!rows.size) host.textContent = 'No installed apps to lock.';
    } catch (error) {
      host.textContent = error.message + ' Reopen this section to try again.';
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Try again';
      retry.onclick = () => { retry.disabled = true; void load(); }; host.append(retry);
    }
  }
  window.addEventListener('app-lock:status', event => status(event.detail.id));
  void load();
}
