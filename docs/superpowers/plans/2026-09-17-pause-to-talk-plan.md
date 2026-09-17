# Pause to talk — implementation plan

Spec: `docs/superpowers/specs/2026-09-17-pause-to-talk-design.md` (dad, 9/17).
Repos: era-hub (this worktree, `feat/pause-to-talk`), era-core, era-board,
era-making-words, era-pencil — each on its own `feat/pause-to-talk` worktree
(T0). The gaze engine is untouched.

Every task: TDD (`superpowers:test-driven-development` — failing test first),
verification command listed, STOP conditions listed. Builders are Opus agents
(`model:'opus'`); Fable reviews at each gate. Ports: new hub suite on **8440**
(free; 8377/8378/8425/8427/8450-8462 never; suites reach 8449).

## §A Preflight (9/17, four Explore agents + two checks by hand)

| # | Finding | Class | Mitigation → task |
|---|---------|-------|-------------------|
| 1 | `assemble.sh:14-20`, `era-gate.sh:77-84`, `build-payload.sh:96-109` all source the siblings from `$ROOT/<repo>` = the **main checkouts**; a feature branch in a sibling worktree is invisible to the hub worktree's gate and dist | **warn** | `ERA_WT_SUFFIX` seam in the three scripts: `sib(){ d="$ROOT/$1${ERA_WT_SUFFIX:-}"; [ -d "$d" ] && echo "$d" \|\| echo "$ROOT/$1"; }` → T0 |
| 2 | Hub has minimize (`stepAsideFromKiosk` 302-325) but restore+foreground lives only inside one-shot `clearStageOnce` 340-375 (SetWindowPos / SetForegroundWindow / 6→9 trick, `.first-launch-done` marker) | warn | extract `foregroundKiosk()` → Promise<boolean>; `clearStageOnce` calls it → T2 |
| 3 | Only engine GET is `gazeBusAlive()` (`/status`); no `engineGet`; `enginePost` is hard-coded 127.0.0.1:49155, body must be a string | info | add `engineGet(path, ms=1500)` → parsed JSON or null → T2 |
| 4 | No in-memory kiosk state; no `ERA_NO_SPAWN` seam — Windows branches are `process.platform !== "win32"` no-ops | info | `paused` module-level; on non-win32 `foregroundKiosk()` returns `process.env.ERA_FAKE_KIOSK_WINDOW !== "0"` (test seam for the "window gone" leg) → T2 |
| 5 | `tests/routes.test.mjs:129-158` engine stand-in binds a real server on 49155 and skips when busy; gate runs suites sequentially (`era-gate.sh:134`) | info | new `tests/kiosk-pause.test.mjs` copies that shape, serves `/status`, `/config` (`{"ForegroundApp":"shell:AppsFolder\\X!App"}`), records `/app/park` → T2 |
| 6 | `start-hub-bat.test.mjs` laws: no `powershell`, no `%` in `rem` lines, `wmic` before kiosk line with `timeout` between, `%~2` quoting. `%OPEN%` carries `?`/`=` and cmd ignores `\` inside quotes, so `--data "{\"path\":\"%OPEN%\"}"` is fragile quoting | warn | body is **plain text**: `--data "%OPEN%"`, `Content-Type: text/plain`; hub accepts JSON `{path}` or raw text; spec §4 amended → T3 |
| 7 | `holds.*` consumers: board-render 75-78 (`content/navMin/navBonus/exit`), board-lock:52 (`navMin`), studio.js (`backspace`, `answer`×5, `exit`×2 chooser tiles, `floor/tuneMax`), pencil.js:259 (`navMin`), :497 (`floor/tuneMax/content`), invariants.mjs:57-59 ladder, lib-contract.test.mjs; `holdForDoor` imported by MW/pencil html but never called; `DWELL_SPEAK/CLEAR` already gone from board code | info | T1 keeps `floor`, `tuneMax`, `boardRuntimeMin`, `supportRead`, `content`, adds `holdForExit`; removes the rest; each app task swaps its reads |
| 8 | `invariants.mjs:163-172` law 2 validates every `data-dwell-ms` against a fixed ladder; a 2×dwell door (e.g. 2×1300=2600) is `HOLD_ODD`, 2×1600 is `HOLD_OOR` | warn | law 2 becomes: value ∈ {dwell, 2·dwell, supportRead 1000, prediction 2000} with `dwell` read from the hub's `/settings` → T1 |
| 9 | MW chooser tiles (`studio.js:823,1026`) use `holds.exit` 2400 for "reading a card must not select it" — the prediction-slot rationale, not consequence | warn | **decision for dad in the summary**; default per the ruling = normal dwell → T7 |
| 10 | "door is the bar's only dwell target" pinned at `board-input.test.mjs:161-164`, `board-partner-strip.test.mjs` ×8 (`barShape`), `board-pixel.test.mjs:152-157,239-245` (`BAR_DWELL_EXTRAS`) | info | assertions allow `["barDoor"]` or `["barDoor","barTalk"]`; pixel allow-list gains `barTalk` → T5 |
| 11 | era-board links no core CSS (`index.html:7` only board.css); MW/pencil link `lib/tokens.css` | info | `doorbar.css` linked from all four app pages; `.msgbar`/`.bardoor` rules move out of board.css → T4/T5 |
| 12 | Board `/settings` is a one-shot boot fetch (`board.js:410-425`) before `mountBoard`; tiles get `data-dwell-ms` at render; splash bar mounts before settings | info | `setDwell`/`setPause` called after settings on both bar mounts → T5 |
| 13 | `music-player.js` has no `pause/resume`; `stop()` records `resume={id,pos,full}`, fires `onState(null)`, posts a "stop" event; 40 s clip limit is a timer | warn | new `pause()`/`resume()` on the player: pause the `<audio>` in place, keep `onState`, re-arm the clip remainder on resume → T5 |
| 14 | Reader: no header, two `inset:0` fixed screens (`index.html:40-41`), `.reader-shell` 100dvh; `reader.js` is a sync classic script (`index.html:590-591`), `#narration` is a body-level singleton, `stopMedia()` zeroes `currentTime`; no `visibilitychange` anywhere in the five repos | info | one body-level bar, both screens + shell `top/height` on `--bar-h`; `reader.js` becomes `defer` behind a module shim (MW/pencil precedent); pause hook pauses without zeroing → T6 |
| 15 | `reader-ui.test.mjs` pins `.shelf-tdsnap-button` + `"2400"` (:142-144), "named for the real destination" (:153-194), `#btnExit` dataset survives repaint (:584-630), freeze/thaw of `#btnExit` (:704-737); `reader-sizing.test.mjs` pins `fullyVisible >= 10` (:197) and arrow `y===16` viewport coords (:210-212) | warn | re-point at `#barDoor`; `freezeShelf` covers `.msgbar .dwell`; sizing re-derived — **STOP-if** the shelf drops under 10 at 1080 → T6 |
| 16 | MW: `#door` is a 170×110 fixed tile at 26,26; `#replay` (26,26 right), `#adultBar` (20,20 right), `#ttsWarn` (top:0 centre — the 💬 spot); `layoutTray/vs()` use raw `innerHeight`; `/settings` fetched only on "Let's play" (`studio.js:1402`); `layout.test.mjs:252-268` DOOR floor 170×110 on every `.dwell`; `run.js:40,121,126` pin `#door`/`2400` | warn | `--bar-h` on `#stage/.screen/#colStacks`, chrome moved under the bar, `usableH()`; settings fetched at boot; layout test gets the `.msgbar` exception → T7 |
| 17 | Pencil: `#door` is a ring cell in `#colL` (24%×23%); `#partnerTab` at top:0; `tellPark()` posts the rest-block centre at boot/resize; `pencil.js:45` pins `#door`/`2400`; `pencil-ui.test.mjs:160,173` click `#door` | info | door cell removed (`#btnRead` takes the column), `#page/.screen` on `--bar-h`, `#partnerTab` under the bar, `tellPark()` after mount and on resume → T8 |
| 18 | `visibilitychange` on minimize/restore of a `--kiosk` Chrome is expected but unproven on the tablet | warn | device phase tests it first; fallback = also listen to `window` `focus` → T9 STOP-if |

No blockers.

## §B Tasks

### Phase 0 — worktrees and the contract

**T0 — sibling worktrees + `ERA_WT_SUFFIX`** · posture: implementing
- `bash $W open /home/claude/new-era/<repo> pause-to-talk` for era-core, era-board,
  era-making-words, era-pencil (`W=/home/claude/aac-board-builder/tools/worktree.sh`).
- era-hub `tools/assemble.sh`, `tools/era-gate.sh`, `tools/build-payload.sh`: one
  `sib()` helper each (§A-1); default unchanged when the suffixed dir is absent.
  Re-run `ERA_WT_SUFFIX=--wt-pause-to-talk bash tools/assemble.sh` in this worktree
  and confirm `readlink public/lib` points at the era-core worktree.
- Test first: `tests/assemble-suffix.test.mjs` — runs assemble with a fake
  `$ROOT` (tmp dir with `era-core` and `era-core--wt-x`) and asserts the symlink
  target with and without the suffix.
- Verify: `node --test tests/assemble-suffix.test.mjs`; `bash tools/era-gate.sh`
  still green with no suffix set.
- STOP if: `worktree.sh open` refuses for a sibling (then branch in place and say so).

**T1 — two speeds (ux-contract §C, contract.js, invariants law 2)** · posture: implementing
- `aac-board-builder/knowledge/ux-contract.md` §C first: the hold table becomes
  three rows — content/nav/every control = `dwell` (600–3000, Settings);
  doors that leave the screen (🚪, 💬) = `2 × dwell`; reading targets:
  support-read 1000, prediction 2000. §B:336 board-door row → `2×dwell`, plus the
  9/17 board-law line (two doors, nothing else). Note dad's 9/17 ruling by date.
- era-core `lib/contract.js`: `export function holdForExit(contentMs) { return 2 * contentMs; }`;
  `HOLDS = { supportRead:1000, content:1200, floor:800, tuneMax:3000, boardRuntimeMin:600, holdForExit }`;
  delete `holdForDoor`, `navBonus`, `navMin`, `answer`, `backspace`, `clear`,
  `send`, `exit`. `holdFor(role, dwell)` → exit: `holdForExit(dwell)`;
  supportRead: 1000; prediction: 2000; anything else: `dwell`. `contract.json` in sync.
- `tests/lib-contract.test.mjs`: `holdForExit(1200)===2400`, `(600)===1200`;
  removed keys are `undefined`; `holdFor("send", 900)===900`; json sync.
- era-hub `tests/invariants.mjs` law 2: fetch `/settings` once, ladder =
  `{dwell, 2*dwell, 1000, 2000}`; keep `HOLD_OOR` for outside `[floor, tuneMax]`.
- Verify: `node --test tests/lib-contract.test.mjs` from the hub gate layout
  (it imports `../public/lib/contract.js`); `node tests/invariants.mjs` against a
  scratch hub (8480+) — expect the same violations as master (none new).
- STOP if: any consumer outside §A-7 imports a removed key (grep the five repos).

**Gate 0:** `rae-flow:reviewing` on era-core + the ux-contract diff. Nothing lands.

### Phase 1 — hub (era-hub)

**T2 — `/kiosk/pause`, `/kiosk/resume`, `pauseGoes`** · posture: implementing
- `server.js`: `engineGet(path)`; `foregroundKiosk()` extracted from
  `clearStageOnce` (same PowerShell, `windowsHide`, log to `LOGS/foreground.log`,
  resolves true iff a kiosk-profile main window was found); `minimizeKiosk()`
  = today's `stepAsideFromKiosk` body; `let paused = null`.
- `POST /kiosk/pause` body JSON `{path}` (spec §3.1): `exitTarget()==="home"` →
  `{action:"home"}`, nothing else; else set `paused`, `enginePost("/app/park","{}")`,
  minimize, `explorer.exe <ForegroundApp>` from `engineGet("/config")` with the
  TD Snap default, answer `{action:"paused"}`.
- `POST /kiosk/resume` body JSON `{path}` **or raw text path** (§A-6): normalise
  (trim, lower-case, strip trailing `/`, keep the query); mismatch/none → 409
  `{action:"launch"}` and clear `paused`; match → `foregroundKiosk()` true → clear,
  200 `{action:"resumed"}`; false → clear, 409.
- `/kiosk/exit` clears `paused`. GET `/settings` adds `pauseGoes` (= `doorGoes`).
- Tests first, `tests/kiosk-pause.test.mjs` (port **8440**, routes.test spawn
  shape, 49155 stand-in with `/status`, `/config`, `/app/park` recorder):
  pause with stand-in up → `paused`, park hit; pause without stand-in → `home`;
  resume same path (`/board/?recipe=songs` vs `/BOARD/?recipe=songs`) → 200;
  different path → 409 and a following same-path resume → 409 (cleared);
  raw-text body works; `ERA_FAKE_KIOSK_WINDOW=0` → 409; exit clears; `pauseGoes`
  tracks the stand-in; `stepAsideFromKiosk` callers unchanged.
- Verify: `node --test tests/kiosk-pause.test.mjs tests/routes.test.mjs`.
- STOP if: `clearStageOnce`'s PowerShell can't be split from its marker logic
  without changing first-launch behaviour (then leave it and add a parallel helper,
  and say so in the review).

**T3 — launcher line** · posture: implementing
- `tools/build-payload.sh` start-hub.bat heredoc, after the `:open` probe and
  before the `wmic` line:
  ```bat
  rem Paused app? (talk door, 9/17) The hub brings the paused kiosk forward when
  rem this is the SAME app she paused; anything else answers 4xx and we launch below.
  curl.exe -s -f -o NUL --max-time 4 -X POST -H "Content-Type: text/plain" --data "%OPEN%" http://127.0.0.1:%PORT%/kiosk/resume
  if not errorlevel 1 goto done
  ```
  (`rem` lines carry no `%`; no emoji in the bat — cmd code pages.)
- Spec §4 amended to the text body. `tests/start-hub-bat.test.mjs`: line
  byte-for-byte, after `:open`, before `wmic`; existing laws still pass.
- Verify: `node --test tests/start-hub-bat.test.mjs`.
- STOP if: the heredoc's `:open` label ordering differs from spec §4's assumption.

**Gate 1:** `rae-flow:reviewing` on the era-hub diff; T2+T3 green; commit. Retro → §C.

### Phase 2 — the shared bar (era-core)

**T4 — `lib/doorbar.js` + `lib/doorbar.css`** · posture: implementing
- `mountDoorBar(mount, { appPath, onLeave, onPause, onResume, exitTo })` →
  `{ bar, doorBtn, talkBtn, sizeBar, setPause(on), setDwell(ms), destroy }`.
  `.msgbar` with `#barDoor.bardoor.dwell` (🚪, left) and `#barTalk.bardoor.dwell`
  (💬, absolutely centred, hidden until `setPause(true)`), both
  `data-dwell-ms = holdForExit(dwell)`, `data-dwell-say` door/talk, aria-labels.
  🚪 click → `onLeave()`, `POST /kiosk/exit`, `/home/` unless `closed` (today's
  `exitToTDSnap`). 💬 click → `onPause()`, `POST /kiosk/pause {path: appPath}`;
  not `paused` → 🚪 path. `visibilitychange`→visible with the bar's own
  `pausedFlag` → `Dwell.suppress(600)`, `onResume()`, clear the flag.
  `sizeBar()` as today (`--bar-inner`, both doors 2×inner wide).
- `doorbar.css`: `.msgbar`, `.bardoor`, `.bardoor.talk` rules moved from
  board.css:31-44 verbatim plus the centre door; dwell-fill overrides come along.
- Tests first, `era-core/tests/doorbar.test.mjs`: Playwright over a tiny static
  server (MW `layout.test.mjs:65-84` shape, OS port) serving a fixture page:
  two `.dwell` in the bar; 💬 hidden until `setPause(true)`; `setDwell(900)` → both
  `1800`; 💬 click hits `/kiosk/pause` with the path and calls `onPause`; a
  dispatched `visibilitychange` (override `document.visibilityState`) calls
  `onResume` only after a pause; `/kiosk/pause` answering `home` falls through
  to `/kiosk/exit`; centre door and a 300 px right strip don't overlap at 1280×720.
- Verify: `node --test tests/doorbar.test.mjs` from the era-core worktree.
- STOP if: `visibilityState` can't be overridden in the fixture (then expose
  `__doorbarTest.simulateVisible()` and say so in the header).

### Phase 3 — the boards (era-board)

**T5 — shared bar, music pause, tiles on `dwell`** · posture: implementing
- `board.js:173` and `board-render.js:531` import `mountDoorBar` from
  `../lib/doorbar.js`; delete the local one (`board-render.js:125-167`), keep
  `barHeight` and `exitToTDSnap` (or move the latter into doorbar). `index.html`
  links `../lib/doorbar.css`; board.css drops the moved rules.
  After settings: `setDwell(dwellMs)`, `setPause(st.pauseGoes === "tdsnap")` on
  both mounts. `appPath` = `location.pathname + location.search`.
- `music-player.js`: `pause()` (audio.pause, remember `pausedByBar`, stop the
  clip timer with its remainder) and `resume()` (`audio.play()` iff `pausedByBar`,
  re-arm the remainder); `onState` untouched. Header comment updated.
  Board hooks: `onPause` = `sp.stop(); music?.pause()`; `onResume` = `music?.resume()`.
- Holds: `tileDwellMs` → `type === EXIT_TYPE ? holdForExit(dwellMs) : dwellMs`;
  `board-lock.js:52` `HOLD_MS` → `2 * dwellMs` at mount? **No** — the lock is a
  touch hold, not a gaze hold; keep 1600 as a local constant with a comment.
  `CONFIG.DWELL_NAV_*`/`DWELL_EXIT` removed.
- Board law: `board-partner.js:561-572`, `board.css:46-52` prose and
  `board-render.js` header cite the 9/17 amendment and era-core.
- Tests first (`board-partner-strip.test.mjs` `open()` shape, `/settings` stubbed
  with `pauseGoes`): new `tests/board-talk-door.test.mjs` — two `.dwell` in the
  bar, 💬 absent on `pauseGoes:"home"`, both holds = `2×dwellMs` (stub 900 → 1800),
  song tile at 900, nav door at 900, 💬 click pauses `window.Music._audio` at its
  position and POSTs `/kiosk/pause`, simulated visible → `_audio` playing from
  the kept `currentTime`, without a pause nothing; 1280×720 no overlap with the
  strip. Amend §A-10 assertions; `board-input.test.mjs:218` reads `2*dwell`
  from `/settings`; `board-splash-door.test.mjs:42` likewise.
- Verify: `node --test tests/board-talk-door.test.mjs tests/board-input.test.mjs tests/board-partner-strip.test.mjs tests/board-pixel.test.mjs tests/board-music.test.mjs tests/board-lock.test.mjs tests/board-splash-door.test.mjs` (gate hub up on 8378 or a scratch hub; suites target 8377 → run inside the gate, or start a scratch hub and sed the copies as the gate does).
- STOP if: (a) the clip-limit timer can't be paused cleanly (then let the clip
  finish on resume and note it); (b) `board-pixel` reports anything beyond
  `barTalk`; (c) board-lock's touch hold is derived from `holds.navMin` in more
  than the one line.

**Gate 2:** `rae-flow:reviewing` on era-core + era-board diffs; full era-board
suite green; commits in both worktrees. Retro → §C.

### Phase 4 — the Book Reader (era-hub)

**T6 — header + hooks + tiles on `dwell`** · posture: implementing
- `public/reader/index.html`: `<link ../lib/doorbar.css>`; module shim importing
  `mountDoorBar`/`holdForExit` onto `window.DoorBar`/`window.EllieContract`;
  `reader.js` → `defer`. One `#bar` mount before `#sShelf`; `#sShelf.show`,
  `#sRead.show` `top: var(--bar-h)`; `.reader-shell` height
  `calc(100dvh - var(--bar-h))`. `--bar-h` set by `sizeBar` from `barHeight`.
- `reader.js`: mount the bar in `boot()` before `/settings`; after settings
  `setDwell`, `setPause`; delete the shelf exit tile (`:491-509`) and `exitApp()`;
  `#btnExit` id retired — tests re-pointed. `onPause`: `S.paused=true`, pause
  `narration`/`video` **without** zeroing (`pauseMedia()` beside `stopMedia()`,
  latch `ignorePause`), stop pulse. `onResume`: if `video` had `src` → `video.play()`;
  else if narration was playing → `narration.currentTime = 0; play()` (re-narrate
  the page, spec §6); `S.paused=false`. `freezeShelf`/`thawShelf` cover
  `.msgbar .dwell`. Tiles carry no `data-dwell-ms` (already true).
- Tests first in `reader-ui.test.mjs` (page-route `/settings` with `pauseGoes`):
  bar present on shelf and page; no `.shelf-tdsnap-button`; `#barDoor` named
  for the destination and driving `/kiosk/exit` (re-point :153-194);
  door hold = `2×dwell`; ask-open freezes both doors; 💬 mid-narration pauses
  `#narration` at its time, POSTs `/kiosk/pause` with `/reader/`, simulated
  visible → narration restarts from 0 on the same page; mid-outro → video resumes.
  `reader-sizing.test.mjs`: arrows at `16 + barH`; `fullyVisible` re-derived.
- Verify: `node --test tests/reader-ui.test.mjs tests/reader-sizing.test.mjs`.
- STOP if: `fullyVisible` at 1920×1080 drops below 10 with the bar (report the
  number; dad decides shelf density — do not shrink cards silently).

### Phase 5 — Making Words and the Pencil

**T7 — Making Words** · posture: implementing
- `index.html`: link `lib/doorbar.css`; import `mountDoorBar`; delete `#door`
  (:222 + css :145-149); `#stage`, `.screen`, `#colStacks` `top: var(--bar-h)`;
  `#replay`/`#adultBar` `top: calc(var(--bar-h) + 12px)`; `#ttsWarn` `top: var(--bar-h)`.
  Every literal `data-dwell-ms` (:223, :261, :294-296) removed → inherit `dwell`.
- `studio.js`: fetch `/settings` at `boot()` (keep the start-time re-fetch),
  mount the bar with `onLeave` = today's door handler minus the goodbye
  (`Speech.stop()` first), `onPause` = `Speech.stop(); S.paused=true`,
  `onResume` = `S.paused=false`. `usableH()` = `innerHeight - barH` in
  `layoutTray`/`vs()`. `EC.holds.backspace/answer` → no attribute; chooser tiles
  (:823, :1026) → no attribute (§A-9 default; one-line switch if dad rules
  otherwise). Partner tune clamp keeps `floor/tuneMax`.
- Tests first: `run.js:40` → `2×settings.dwellMs`, `:121,126` → `#barDoor`;
  `layout.test.mjs`: `.msgbar .dwell` exempt from the 170×110 floor with its own
  law (fills bar inner height, ≥2× as wide as tall); chrome list gains `#barDoor`,
  `#barTalk`, loses `#door`; new checks: bar present on every screen, 💬 click
  stops speech (spy `Speech.stop`) and hits `/kiosk/pause` with `/`.
- Verify: `node --test tests/layout.test.mjs`; `node tests/run.js` and
  `tests/bargein.js` against the gate hub.
- STOP if: `#prompt`'s `vh` caps make the tray overflow at 1280×672 with the bar.

**T8 — The Pencil** · posture: implementing
- `index.html`: link `../lib/doorbar.css`; `#door` cell removed; `#page`,
  `.screen` `top: var(--bar-h)`; `#partnerTab` `top: var(--bar-h)`; literal
  holds (:150-151, :159-160, :168, :176, :184, :186, :189) removed → `dwell`;
  `.pword` keeps `EC.prediction.holdMs`; `#seatA` back → no attribute.
- `pencil.js`: mount the bar in `bootSession()` before `/settings`; `setDwell`,
  `setPause` after; `exitDoor()` becomes `onLeave` (goodbye dropped, `Speech.stop()`);
  `onPause` = `Speech.stop(); S.paused=true`; `onResume` = `S.paused=false; tellPark()`.
  `tellPark()` also after the bar mounts.
- Tests first: `era-pencil/tests/pencil.js:45` → `#barDoor` at `2×dwell`;
  `pencil-ui.test.mjs:160,173` → `#barDoor`; new rows: `#btnDel`/`#btnSend` carry
  no `data-dwell-ms`; 💬 stops speech and hits `/kiosk/pause` with `/pencil/`;
  `#btnRead` fills `#colL`; `#btnSend` font still equals `#btnRead` (:86-95).
- Verify: `node --test tests/pencil-ui.test.mjs`; `node tests/pencil.js` in the gate.
- STOP if: the invariants' park-override law (`data-park-override="center"`) fails
  once `#restBlock` moves.

**Gate 3:** `rae-flow:reviewing` on era-hub (reader) + MW + pencil diffs;
`bash tools/era-gate.sh` with `ERA_WT_SUFFIX=--wt-pause-to-talk` → green tally
verbatim. Commits in all five worktrees. Retro → §C.

### Phase 6 — behavioral verification (mandatory)

**T9 — the real thing** · posture: collaborating (device work with dad)
1. Gate green (tally in §C).
2. Scratch hub (8480+, throwaway `ERA_DATA_DIR`, 49155 stand-in up so
   `pauseGoes` is `tdsnap`), `playwright-cli` video: Songs mid-song → 💬 →
   `/kiosk/pause` logged, audio paused; simulate visible → same second continues.
   Reader page 3 mid-narration → 💬 → visible → page 3 narrates from the top.
3. Tablet: `bash tools/build-dist.sh --dry-run` with the suffix, `push-device tablet`.
   From TD Snap: Songs mid-song → 💬 → TD Snap in front → Songs tile → same song
   continues (no relaunch: hub log shows `resumed`). Reader mid-book → same.
   Movies → 💬 → Songs tile → 409 `launch`, Movies kiosk gone, Songs fresh.
   Pencil and Making Words: 💬 → back → letters where she left them. Hold
   lengths: Settings dwell 900 → doors 1800, tiles 900.
4. Record the hub log lines and the ffmpeg-trimmed clips' paths in §C.
- STOP if: the `visible` event never arrives on the tablet after `resumed`
  (then add `window` `focus` as a second trigger in doorbar.js — one line — and
  re-test); or `foregroundKiosk` leaves TD Snap on top (then the engine-side
  `/app/pause` from spec §10 is back on the table — stop and say so).

### Phase 7 — land and release

**T10** · posture: implementing
- Land in dependency order, same sitting: era-core → era-board →
  era-making-words → era-pencil → era-hub (`$W land` each); never restart live
  8377 between them. `docs/dev-flow.md` gains the `ERA_WT_SUFFIX` paragraph.
- Patch release `v0.33.6` (`release.sh --patch`) after dad has used it a day;
  push to the i13 when it is home.

## §C Retro (appended per gate)

_(empty until Gate 0)_
