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

### Phase 1 — hub (9/14) — landed era-hub `261a2dd`
- `server.js` defaults + allowlist (`lockMinutes` 0–1440 round, `lockPasscodeHash`
  `""` | 64-hex); Settings "🔒 Lock" card (stepper over 14 stops, passcode Save/Clear
  hashing in-page with WebCrypto). routes.test +1, settings-ui.test +2 — green.
- Retro: the card's first draft named the wrong child as the tablet-poker; fixed to
  "a sibling" in the card, the spec and a builder comment before commit. Copy about
  the family is reviewed word by word, not skimmed.

### Phase 2 — board (9/14) — landed era-board `25a3334`, `6f13658`
- `board-lock.js` (new) + strip/render/boot/css hooks per §B; `board-lock.test.mjs`
  11 → 12 tests; partner-strip labels updated.
- Builder-found and fixed before review: `writeLock(until | 0)` truncated the epoch
  to 32 bits (the lock "expired" in 1970) → `Math.round`; the keypad closed itself on
  the release click of the hold that opened it → backdrop dismisses on `pointerdown`.
- `board-arrange` 8 red / `board-music` 2 red when run straight against the live
  8377 — environmental (live data, live `musicVolCap`); both PASS under the gate.

### Phase 3 — behavioral verification (9/14)
- **Gate** (`tools/era-gate.sh`, fixture data, 8378): `== era-gate: 81 passed,
  1 failed → ai-key.test.mjs ==`. The one FAIL is `listen EADDRINUSE 127.0.0.1:8431`
  — a two-day-old `ssh -f -N -L 8431:127.0.0.1:8377 i13` tunnel (pid 1171678, not
  this session's; left running) sits on ai-key's fake-provider port. Not a code
  failure; the memory now says tunnels go on 8500+ (the suite table reaches 8449).
  Every lock/board suite PASS.
- **Recorded run**, scratch hub 8460 over a copy of `era-family/test-data`, Playwright
  `hasTouch` + CDP `Input.dispatchTouchEvent` for the finger (script, log, seven
  screenshots and the video in `~/new-era/dist/qa/2026-09-14-media-lock/`,
  `media-lock-e2e.webm`):
  1. `/settings/` → stepper 45 → 5 minutes; passcode 2468 → "Passcode set ✓";
     `GET /settings` = `lockMinutes: 5`, 64-hex hash, digits absent from the body.
  2. `/board/?recipe=songs`: 9 song tiles, all `.dwell`. A **tap** on 🔒 → not locked.
     A **1.9 s finger** → `era.lock` written, banner "Locked until 10:50 PM",
     until−now = 5 min; every song tile lost `.dwell` and gained
     `data-dwell-disabled`; `#barDoor` still `.dwell` and the ONLY `.dwell` in
     `.msgbar`.
  3. Finger on a song tile while locked → `Music.play` calls = 0, `playingId` null.
  4. Reload while locked → still locked, same banner, tiles still inert.
  5. Hold 🔒 → keypad. 1111 ✓ → keypad stays, still locked (shake). 2468 ✓ → keypad
     gone, unlocked, all 9 tiles `.dwell` again.
  6. `lockMinutes: 0`, no passcode → hold → banner "Locked", `until: 0`; hold again
     → unlocked. No page errors across the run.
- **Found by the recording, fixed, re-recorded:** `#lockWarn` painted ON `#ttsWarn`
  at the shared `bottom:6px` ("…check the speakers or W[Locked until 10:45 PM]") —
  the same overlap review 9/5 cured for `#launchWarn`. Same cure (measure the
  standing footers, sit 6 px above; `#lockWarn.show` joins board-render's
  `STANDING_FOOTERS`; re-measure on resize since a lock outlives a rotation) —
  era-board `6f13658`, +1 test (12/12, partner-strip 14/14, movies 12/12). The
  re-run's `03-board-locked.png` shows both banners readable.

### Follow-ups (not in this plan)
- A board reads `lockMinutes` / `lockPasscodeHash` once at mount; a Settings change
  reaches an open board on its next reload. Fine for a kiosk that reboots nightly.
- A footer that APPEARS while the lock banner already stands (a `#contentNote` from
  the content poll) paints under it until the next `setWarn`; `#launchWarn` has the
  same gap and survives it by being transient. A MutationObserver on the footers
  would close it for both — queue line, not a quiet widening here.
- Spec non-goal restated: a movie already fullscreen in the external app can't be
  stopped from the board; exit the app as today, then lock.
- Publish (v0.32.4 signed build, VM 14/14, i13 self-update) is dad's call.
