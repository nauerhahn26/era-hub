# Media lock — implementation plan

Spec: `docs/superpowers/specs/2026-09-14-media-lock-design.md` (approved 9/14).
Repos: era-hub (this worktree, branch `feat/audit-fixes`) and era-board
(`/home/claude/new-era/era-board`, separate commits). era-core untouched.

Every task: TDD (`superpowers:test-driven-development` — failing test first),
verification command listed, STOP conditions listed. Builders are Opus agents
(`model:'opus'`); Fable reviews at each phase gate.

## §A Preflight (9/14)

| # | Finding | Class | Mitigation → task |
|---|---------|-------|-------------------|
| 1 | Tiles have no DOM type attribute (`board-render.js:310` stamps only `dwellMs`/`dwellSay`) | warn | render stamps `el.dataset.tileType = type`; lock selects `[data-tile-type]` ∈ {song, full, stop, movie, episode} → T3 |
| 2 | `freezeBoard`/`thawBoard` share one module-level `frozen` list scoped to the partner sheet (`board-partner.js:61-78`) | warn | lock owns its own list (`applyLock`/`releaseLock`), never touches `frozen`; re-applies after each `render()` → T3 |
| 3 | `onTile()` is the only place playback starts (`board-render.js:688-739`); `LAUNCH_TYPES` = movie/episode; `show` is nav | info | gate `song/full/stop` + `LAUNCH_TYPES` there when locked; `show`, nav, door untouched → T3 |
| 4 | Splash mounts the strip with `arrange:false` and no music (`board.js:198`) | info | lock button mounts there too; `music` may be null → T3 |
| 5 | `music` lives in board.js (`window.Music` hook at :478) | info | pass `music` into `mountLockButton`; fall back to `window.Music` → T3 |
| 6 | dwell.js long-press rescue covers only `.dwell` (`era-core/dwell.js:267-288`); Windows long-press → contextmenu | info | pointerdown/up timer + `preventDefault` on pointerdown & contextmenu → T3 |
| 7 | `board-input.test.mjs:142-163` asserts `.msgbar` children = `barDoor` (+ one `partnerStrip`) and door = only `.dwell` | info | button lives inside `#partnerStrip`, no `.dwell` → assertion holds; T3 verifies |
| 8 | Hub UI suites own ports: 8423/8424 settings-ui, up to 8449 taken; board suites stub routes, no port | info | no new port needed; add rows to `settings-ui.test.mjs` (8423) |
| 9 | Settings page has no WebCrypto use yet | info | `crypto.subtle.digest("SHA-256", …)` — fine on 127.0.0.1 (secure context) → T2 |

No blockers.

## §B Tasks

### Phase 1 — hub (era-hub)

**T1 — settings keys** · posture: implementing
- `server.js` GET `/settings` defaults: `lockMinutes: 45, lockPasscodeHash: ""`.
- POST `/settings` allowlist: `lockMinutes` integer clamp 0–1440 (`Math.round`);
  `lockPasscodeHash` accepted iff `""` or `/^[0-9a-f]{64}$/`; anything else ignored.
- Tests first in `tests/routes.test.mjs`: defaults present; clamp (−5→0, 99999→1440,
  45.6→46); hash `""`/64-hex stored, `"1234"`/uppercase/65 chars ignored; other
  keys untouched by a lock-only POST.
- Verify: `node --test tests/routes.test.mjs`.
- STOP if: `routes.test.mjs` has no settings section to extend (then create `tests/lock-settings.test.mjs` on the same server-spawn shape as `settings-ui.test.mjs:29-49`).

**T2 — Settings page Lock card** · posture: implementing
- `public/settings/index.html`: card "Lock" after the music volume row.
  - "Lock for": ± stepper over `[5,10,15,30,45,60,90,120,180,240,480,720,1440,0]`
    (0 last = "Until unlocked"); description "45 minutes" / "2 hours" / "24 hours" /
    "until a grown-up unlocks it"; POST on tap + `toast()` like dwell (`:442-456`).
  - "Passcode": `<input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6">`,
    Save (4–6 digits else inline "4 to 6 digits") → SHA-256 hex via
    `crypto.subtle` → POST `{lockPasscodeHash}`; Clear → POST `{lockPasscodeHash:""}`.
    Status line "Passcode set ✓" / "No passcode" from `hash !== ""` on load and after save.
- Tests first in `tests/settings-ui.test.mjs`: card renders with 45; stepper tap
  posts 60 then wraps to 0 → "Until unlocked"; Save "1234" posts a 64-hex hash
  equal to `sha256("1234")` and never the digits; Save "12" posts nothing;
  Clear posts `""`; status text tracks.
- Verify: `node --test tests/settings-ui.test.mjs`.
- STOP if: the page's save helper can't carry a string value (then add a
  minimal `postSetting(obj)` beside it, don't fork the toast path).

**Gate 1:** `rae-flow:reviewing` on the era-hub diff; T1+T2 green; commit
(prose message, trailers). Retro note appended to §C.

### Phase 2 — board (era-board)

**T3 — lock core** · posture: implementing (STOP conditions below)
- New `app/board-lock.js`:
  - `KEY = "era.lock"`; `readLock()` → `{until}` or null (parse errors → null);
    `writeLock(until)`; `clearLock()`; `isLocked(now = Date.now())` (until 0 → true;
    until < now → clear + false).
  - `mountLockButton({ strip, mk, settings, music, onChange })`: appends
    `mk("stripLock", "🔒")` (no `.dwell`, no `data-dwell-*`). Hold = `holds.navMin`
    from `contract.js`; `pointerdown` with `pointerType==="touch"` only →
    `preventDefault()`, start timer, add `.holding` (CSS fill ring via
    `--hold-ms`); `pointerup`/`pointercancel`/`pointerleave` before the timer →
    cancel; timer fires → toggle (lock: `writeLock(lockMinutes ? now+min*60e3 : 0)`,
    `music?.stop()`; unlock: no passcode → `clearLock()`, passcode → T4 keypad).
    `contextmenu` on the button → `preventDefault()`. Mouse/pen pointerdown ignored.
  - `applyLock(root)`: own list; for each `[data-tile-type]` in {song, full, stop,
    movie, episode} with `.dwell` (skip `#barDoor`): remove `.dwell`, set
    `data-dwell-disabled`. Idempotent. `releaseLock()`: restore only its own list,
    then `window.Dwell?.suppress(600)`. Banner `#lockWarn` (style of `#launchWarn`,
    no `.dwell`): "Locked until 3:45 pm" (`toLocaleTimeString` h:mm) / "Locked".
  - Expiry timer set at apply; `storage` event on `era.lock` → re-sync;
    `window.__lockTest = { readLock, writeLock, clearLock, holdMs }`.
- `board-render.js`: stamp `el.dataset.tileType = type` at :310; in `onTile()`, after
  `sp.stop()`, `if (isLocked() && (type==="song"||type==="full"||type==="stop"||LAUNCH_TYPES.has(type))) return;`
  Export a post-render hook (or call `syncLock()` at the end of `render()`) so a
  rebuilt grid is re-disarmed — same place/shape as whatever re-runs
  `refreezeIfOpen` today.
- `board-partner.js` `mountPartnerStrip`: accept `music`, call `mountLockButton`
  after Add/Arrange; return `lockBtn`.
- `board.js`: pass `music` at :450; splash :198 unchanged (null music).
- `board.css`: `.stripbtn#stripLock.holding` ring (conic-gradient over
  `var(--hold-ms)`), `.locked` state, `#lockWarn`.
- Tests first: `tests/board-lock.test.mjs` on the `board-partner-strip.test.mjs`
  `open()` shape (`hasTouch:true`, routes stubbed, `/settings` stub returns
  `lockMinutes`/`lockPasscodeHash` per case):
  1. touch hold 1600 ms locks (`era.lock` set, `#stripLock.locked`, banner text has a time);
  2. touch tap (200 ms) does nothing; mouse hold 2 s does nothing;
  3. locked: song tiles lack `.dwell` and have `data-dwell-disabled`; dispatching the
     tile's activate does not call `window.Music.play` (spy via `__musicTest`);
  4. door still `.dwell` and still the only `.dwell` in `.msgbar`; door activate still exits;
  5. `lockMinutes:0` → banner "Locked"; `until` in the past → unlocked on load, key cleared;
  6. re-render (navigate to a song page and back) keeps tiles disarmed;
  7. hold again with no passcode → unlocked, tiles `.dwell` again.
- Verify: `node --test tests/board-lock.test.mjs tests/board-input.test.mjs tests/board-partner-strip.test.mjs tests/board-pixel.test.mjs` from era-board.
- STOP if: (a) no single post-render seam exists and adding one touches more than
  `render()`'s tail; (b) `hasTouch` `page.touchscreen` can't hold (then drive
  `pointerdown`/`pointerup` with `pointerType:"touch"` via `dispatchEvent` and say so
  in the test header); (c) `board-pixel` snapshot changes for reasons beyond the
  new strip button.

**T4 — passcode keypad** · posture: implementing
- `board-lock.js` `openKeypad({hash, onOk})`: overlay `#lockPad` (no `.dwell`),
  digits 0–9 / ⌫ / ✓ as `.stripbtn`-styled buttons ≥ 90 px, masked dots row, Cancel.
  ✓ or 6th digit → `sha256(entry)` via `crypto.subtle` → equal → `onOk()`, else
  `.shake` + clear. Any outside tap/Cancel closes, still locked. Touch/click both fine
  here (it is a grown-up surface behind a hold).
- Tests appended to `board-lock.test.mjs`: hash set → hold opens `#lockPad`; wrong
  → still locked, entry cleared; right → unlocked, pad gone; Cancel → locked; every
  `#lockPad button` box ≥ 90×90; no `.dwell` inside `#lockPad`.
- Verify: same command as T3 plus `node tests/invariants.mjs` from era-hub gate (or
  whatever the gate does for invariants — `tools/era-gate.sh` shows it).
- STOP if: `crypto.subtle` is undefined in the Playwright context (then a tiny
  pure-JS sha256 in `board-lock.js`, and tell the reviewer).

**Gate 2:** `rae-flow:reviewing` on the era-board diff; full era-board suite green;
commit in era-board. Retro note in §C.

### Phase 3 — behavioral verification (mandatory)

**T5 — run the real thing** · posture: implementing
1. `tools/era-gate.sh` from era-hub → all green (14/14-style tally reported verbatim).
2. Scratch hub (`ERA_DATA_DIR` throwaway, port 8425+ per memory), `playwright-cli`
   with touch emulation, record a video:
   - `/settings/` → Lock card: set 5 min, passcode 2468 → "Passcode set ✓".
   - `/board/?recipe=songs` (or the real splash if the scratch has no songs): hold 🔒
     → banner "Locked until …", tap a song tile → silence, door still leaves.
   - hold 🔒 → keypad → 1111 shakes → 2468 → unlocked.
   - reload while locked → still locked.
   - set "Until unlocked" → banner "Locked".
3. Attach the recording path + the gate tally to §C. Not done until this runs.

Publish (v0.32.4, signed build, VM 14/14, i13 self-update) is a separate call for
dad — not part of this plan.

## §C Evidence / retros
(appended as work lands)
