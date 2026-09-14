# Media lock: a hold-to-lock button for the Songs and Movies boards

Date: 2026-09-14. Status: design approved in conversation (dad, 9/14); this is
the written record. Implementation plan follows via `superpowers:writing-plans`.

## 1. Goal and non-goals

**Goal.** A grown-up can stop music and movies on the device — in class, or
when her brother is poking the tablet and the music has to stop — by holding
one button in the board's top bar. The lock lasts a configurable period
(default 45 min) or until a grown-up unlocks it, and unlocking can require a
passcode so a sibling can't just copy what they saw us do.

**This is deterrence, not security** (dad, 9/14). It is fine that another
device is not locked, that clearing the browser profile clears the lock, and
that the passcode is only hashed, not secret. Everything stays on the rails the
board already has.

**Non-goals.** No server state, no new hub routes, no PIN escalation/lockout,
no schedules ("class hours"), no locking of Reader / Pencil / Making Words, no
per-board locks, no stopping a movie already fullscreen in the external app
(the board isn't on screen then — exit the app as today, then lock).

## 2. Where it lives

- **Button:** a 🔒 `.stripbtn` appended to the touch-only partner strip
  (`era-board/app/board-partner.js` `mountPartnerStrip`) on the Songs and
  Movies boards and on the splash. Nowhere else. This sits inside the 9/4
  amendment: grown-up controls may live in the header only as a touch/click
  strip; **`#barDoor` stays the bar's only `.dwell`.** The lock button carries
  no `.dwell` and no `data-dwell-*`.
- **State:** `localStorage["era.lock"]` = `{ "until": <epoch ms> }`, where
  `until: 0` means "until unlocked". Absent or `until` in the past (and not 0)
  = unlocked. Same-origin, so the Songs board, the Movies board and the splash
  share it; a `storage` event updates any board already open. No polling.
- **Settings** (two new keys in `app-settings.json`, through the existing
  `POST /settings` allowlist in `server.js`):
  - `lockMinutes` — integer, clamped 0–1440, default **45**. `0` = until
    unlocked.
  - `lockPasscodeHash` — `""` (none) or 64 lowercase hex chars: SHA-256 of the
    4–6 digit passcode, computed in the Settings page with WebCrypto. Never
    the digits themselves. `GET /settings` returns it like any other key.

## 3. Behaviour

**Hold to lock.** Touch only: `pointerType === "touch"` on `pointerdown`,
own timer, `preventDefault()` on `pointerdown` and `contextmenu` (Windows turns
a long press into a right-click; dwell.js's long-press rescue only covers
`.dwell`). Hold length = `holds.navMin` (1600 ms) from
`era-core/lib/contract.json` — no invented number. A fill ring on the button
shows progress; releasing early cancels; a tap does nothing. Mouse/gaze do
nothing (ERAgaze moves the real cursor, so gaze == mouse at the DOM level).

**On lock.** `music.stop()` if a player exists; write `era.lock`; apply the
locked state (below). The button shows locked (🔒 filled / accent).

**Locked state** ("reachable but inert"): the board renders and navigates as
normal — nav tiles and the door keep working — but tiles of type `song`,
`full`, `stop`, `movie`/`episode` are disarmed with the `freezeBoard` pattern
(`.dwell` removed, `data-dwell-disabled` set) and `onTile()` refuses those
actions while locked (belt and braces, so a touch on a disarmed tile does
nothing either). Re-applied after any re-render (`refreezeIfOpen` shape). A
touch-only banner in the existing `#launchWarn` style reads
"Locked until 3:45 pm" (local time) or "Locked" when `until` is 0.

**Expiry.** A timer on the board fires at `until` and thaws in place (with
`window.Dwell.suppress(600)` as arrange mode does); a board opened after
`until` treats the key as absent and clears it.

**Hold to unlock.** Same hold on the same button.
- No passcode set → clear `era.lock`, thaw.
- Passcode set → a touch-only keypad overlay: digits 0–9, ⌫, ✓; every target
  ≥ 90 px (invariants law 1); no `.dwell`; masked dots for entered digits.
  ✓ (or 6 digits) hashes the entry with WebCrypto and compares with
  `lockPasscodeHash`. Match → clear + thaw. Mismatch → shake, clear entry,
  stay. A cancel/outside tap closes the keypad and stays locked.

## 4. Settings page (`public/settings/index.html`)

A "Lock" card:
- **Lock for** — stepper through 5 · 10 · 15 · 30 · 45 · 60 · 90 · 120 · 180 ·
  240 · 480 · 720 · 1440 min → "Until unlocked" (`0`). Saves on tap with a
  toast, like the dwell row. Live description ("45 minutes", "24 hours",
  "until a grown-up unlocks it").
- **Passcode** — `type="password"`, `inputmode="numeric"`, 4–6 digits;
  Save hashes and posts `lockPasscodeHash`; Clear posts `""`. The row shows
  "Passcode set ✓" / "No passcode" from whether the hash is non-empty; the
  digits are never shown back.

## 5. Code shape

- `era-board/app/board-lock.js` (new): `readLock()`, `writeLock(until)`,
  `isLocked()`, `mountLockButton({strip, settings, music, refreeze})`,
  `applyLock(root)` / `releaseLock(root)`, keypad overlay. One module, no
  dependencies beyond `contract.js`, `window.Dwell`, and the freeze helpers.
- `board-partner.js`: call `mountLockButton` from `mountPartnerStrip`.
- `board-render.js`: `onTile()` early-return for media actions when locked;
  re-apply lock after render.
- `board.css`: `.stripbtn.lock` states, fill ring, `#lockWarn`, `#lockPad`
  (no `.dwell` anywhere, targets ≥ 90 px).
- `server.js` `POST /settings` allowlist: `lockMinutes` (int clamp 0–1440),
  `lockPasscodeHash` (`""` or `/^[0-9a-f]{64}$/`). `GET /settings` default
  `lockMinutes: 45, lockPasscodeHash: ""`.
- `public/settings/index.html`: the Lock card.
- Test hook: `window.__lockTest = { readLock, writeLock, holdMs }`.

## 6. Tests

- `era-hub/tests/routes.test.mjs`: `lockMinutes` clamp + default,
  `lockPasscodeHash` accepts `""`/64-hex and rejects junk.
- `era-hub/tests/settings-ui.test.mjs`: Lock card renders, stepper saves,
  passcode Save posts a 64-hex hash (never digits), Clear posts `""`.
- `era-board/tests/board-lock.test.mjs` (Playwright, `hasTouch: true`, hub
  routes stubbed like `board-partner-strip.test.mjs`): touch hold ≥ 1600 ms
  locks; short tap does not; mouse hold does not; locked → song tiles have no
  `.dwell` and `onTile` doesn't start music; door still exits; banner shows
  time; `until` in the past thaws on load; unlock without passcode; unlock
  with passcode (wrong then right); keypad targets ≥ 90 px; `#barDoor` still
  the only `.dwell` in `.msgbar`.
- Existing gates must stay green: `board-input.test.mjs` (bar children),
  `board-pixel.test.mjs`, `tests/invariants.mjs`.

Board changes are a separate commit in the era-board repo; hub changes here.
