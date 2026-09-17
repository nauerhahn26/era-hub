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

Dad's answers at go (9/17): the Reader's header is **thin like the music
board's** (`barHeight(innerHeight)` = min(124 px, 9 % of the viewport) — no
taller); §A-9 settled — **Making Words' chooser tiles take normal dwell** like
every other control.

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

**Gate 0 (T0+T1, 9/17).** era-core 2b8f326, aac-board-builder 09cc54e, hub 9895c06.
- §A-7 undersold the interim red: the apps do not carry bare literals, they `import { holdForDoor }` BY NAME from contract.js, so removing the export is a module-link error — Making Words and the Pencil are dead pages (targets=0), the board writes `data-dwell-ms="undefined"` on its door, until T5/T7/T8 swap the import. Sequencing already covers it (Gate 2 runs era-board after T5; the full gate is Gate 3), but any hub-worktree browser suite run between now and then (pencil-ui, MW suites) is red for that reason and no other. Land order in T10 stands: era-core never lands alone.
- Review added: `holdFor("talk")` (the ruling names two doors), `HOLD_RETIRED` violation for 1600/1800/2200 checked AFTER set membership (2×800=1600 stays legal) so a missed markup literal is red not a warn, 5 s timeout on the /settings fetch (GET /settings waits on the gaze-bus probe), only `ERR_MODULE_NOT_FOUND` swallowed by the two-path import.
- `tools/gen-contract-json.mjs` named by the sync test does not exist; contract.json is hand-edited. Follow-up, not this feature.
- Pre-existing, untouched: `/reader/` has `FONT_MIN btnExit 24<44` (tile T6 deletes); contract.js header still says "not yet imported by any app".

**Gate 1 (T2+T3, 9/17).** hub 6e616de. 99/99 across kiosk-pause, start-hub-bat, routes, book-review-ui, fal-key, content-animate in ONE parallel `node --test`.
- §A/T2 assigned the suite **8440/8441 — both already taken** (book-review-ui FAKE; fal-key + content-animate). The serial gate hid it; a parallel run proved 8 failures. Now 8463/8464. Rule: grep `84[0-9][0-9]` in tests/ before assigning, never count from the table's top.
- Plan deviation, deliberate: `foregroundKiosk()` does not call into `clearStageOnce`; both share PowerShell *string builders* (`psWindowPrelude`, `psSettleKiosk(tries)`), so the first-launch script stays byte-identical apart from a no-sleep-after-last-try tweak and the `found`/`none` last line. T2's STOP-if anticipated exactly this.
- The pause gate is `doorGoes()` (Settings AND an engine on the bus), not bare `exitTarget()` — spec §3.1 was right, the T2 prompt was loose. GET /settings now computes doorGoes/pauseGoes through the same helper.
- Review caught a silent tablet-only failure: stdout+stderr in one buffer with the answer parsed off the tail — a late Add-Type warning would have turned every successful restore into a relaunch, invisible to the Linux gate. Split.
- `--max-time` 4 → 8: the hub's own foreground kill is 6 s, curl must outlast it so the hub is always the decider (else curl 28 → wmic kills the window PowerShell is restoring). Cost: a wedged hub (first Drive mirror) makes a tile press wait 8 s instead of 4, once per install.
- hub path match strips case + trailing slash only, never `#` → bar posts `pathname + search` (T4 doc-commented and tested).

**Gate 2 (T4+T5, 9/17).** era-core fac7336 (doorbar.js/.css), era-board 43b9968. 107/107 across all 17 board suites, one at a time.
- T4 deviation: `mountDoorBar(mount, {appPath, onLeave, onPause, onResume, exitTo})` returns `{bar, doorBtn, talkBtn, sizeBar, setPause, setDwell, destroy}` — the plan's signature had no `setDwell`/`setPause`/`destroy`; every app calls the first two after `/settings`, and `destroy()` exists because the board's splash bar is torn out by `innerHTML = ""`. `tokens.css` lost its bar rules to doorbar.css.
- Review found three real defects, all proven red first: **F1** 💬 while a song's blob was still loading — `pauseForTalk()` bailed on `audio.paused`, the blob landed under TD Snap and the song played at full volume, `resume()` no-op'd (fix: guard on the PICK, and `play()` returns after `currentTime = 0` when `pausedByBar`); **F2** the ETag idle-reload fired on the minimized page (five reloads in 1.2 s) — now `visibilityState === "visible"`; **F3** the splash's bar was never destroyed: two `visibilitychange` listeners → two 600 ms settle windows on her return (not "the board's onResume never runs" as the review first said — the listeners are independent; the test pins the double suppression).
- F8 as written (`animationName` resolves) could not detect a missing doorbar.css; the test walks `document.styleSheets` for the `dwellOnset` keyframes instead.
- `freezeBoard` exempts both bar doors (`BAR_DOORS`); board-pixel's allow-list is `["barDoor","barTalk"]`; `board-splash-door` and `board-talk-door` (11 rows, incl. `{action:"home"}` fall-through and the `Dwell.suppress(600)` spy) are new/extra test files beyond the plan.
- **board-events 3/8 "flake" root cause:** port 8391 double-booked with era-hub's `reader-ui` — the gate flattens five repos' suites into one directory, and a hub outliving `after()` satisfied the next suite's `/settings` probe while its child died on EADDRINUSE. Moved to 8451. Still shared: hub `settings-ui` + `update-boot` on 8423 (follow-up). The port rule now spans all five repos' `tests/`.
- Spec §5's "docs/board-design-rules" line points at a file era-board does not have; the amendment lives in ux-contract §B (aac-board-builder). Spec text left as is.
- Not in this feature (follow-ups): `board-routes.test.mjs:14` resolves `../era-hub` flat (spawns MASTER's hub under a worktree gate); `barHeight` re-export from board-render is transitional; Chrome minimize → `innerHeight 0` → negative `availH` in board-render's resize debounce (self-corrects on restore; watch on the tablet in T9).

**Gate 3 (T6+T7+T8, 9/17).** hub 1b2f527 (Reader), era-making-words 4cf1469 + 8ba21be, era-pencil da24e83. Per-suite: reader-ui+sizing 52/52; MW layout 299/299 + 110 CJS; pencil-ui 15/15 + pencil.js 24 + phonetic 4; invariants 0 violations.
- Review found one BLOCKER, proven by probe: Reader `reader.js` — a build finishing under an open ask never `closeAsk()`ed on the else legs, so `.msgbar .dwell` went to **0** and both doors were dead for the rest of the session. Fixed; pinned.
- Reader's conic-ring/blank-fill rules leaked onto the bar doors (`.dwell .dwell-ring` unscoped): the ring showed ungated progress from frame one. Scoped `.dwell:not(.bardoor)` in CSS and in `el.closest()`. Ruling stands: the bar wears era-core's fill everywhere; the Reader's conic look is for its own cards only.
- **Silence under TD Snap:** MW's and the Pencil's `say()` now return early while `S.paused` — the prompt chain (`checkAttempt` → recap → next word…) was still speaking into the minimized kiosk. The Pencil's finding as written did not close it: `pickLetter` called `Speech.say` directly, bypassing `say()`; routed through. MW keeps ONE exception, `sayNow()`, used only by `repeatPrompt()` (partner 🔁 + her `#replay`): a grown-up holding ⏸ who presses 🔁 must hear it. Nothing chained may use it.
- `S.paused` collided with the partner ⏸ in both apps: a 💬 round trip un-paused a partner pause. Latched (`wasPaused` / `pausedBeforeTalk`).
- Partner tuning now `setDwell`s the bar in MW and the Pencil (doors stayed at the old 2×). MW gained a `resize` listener for the bar (it had none); its own tray/slot layout is still not re-laid on resize — pre-existing, follow-up (debounce like board-render's).
- Pencil `#partnerTab` sat flush under the 💬 → `+12px`. The 12 px sliver comes from doorbar.css's 10 px padding + 2 px border vs the contract's 14 px gapFloor; follow-up = padding-bottom 12 in era-core (only the Pencil hits it today).
- Invariants went red on the full gate only: MW `#spell`/`#sort` — 🔊 `#replay` occluded by `#adultBar`. Both now share one offset under the bar; on master `26px` vs `20px` left the tile's centre **1 px** clear of the adult bar, and the audit enters a lesson through `show("stage")`, skipping the session-start line that hides the adult bar. `show("stage")` hides it itself now (8ba21be).
- Dropped on purpose, tell dad: the goodbye line on the MW/Pencil 🚪 exit (the hub's hand-off is immediate), and `clearAll`/`btnDel`/`✓ send` hold plain dwell like everything else.
- **Gate flake, not this feature:** `board-arrange` test 3 (a 6 px touch press in arrange mode saw one native click; 0 rescues) failed once in three full runs and passed 3/3 in isolation on the same hub; the suite's only change here is a comment. Follow-up: the CDP touch drag races Chrome's tap window under load.
- Process: one fix-up agent ran `git checkout --` on uncommitted Reader files (it assumed T6 was committed) and restored them from a copy it had taken seconds earlier — byte-identical, verified, but commit each build before its review from now on. Running the gate's `until kill -0` wait as a background tool call gets stopped within a minute; block in the foreground on the log's summary line instead.
- Gate 3 tally (third full run, `ERA_WT_SUFFIX=--wt-pause-to-talk bash tools/era-gate.sh`): `== era-gate: 98 passed, 0 failed ==` (run 1: 97/1 invariants — the adultBar occlusion above; run 2: 97/1 board-arrange flake; run 3 clean). Stamp written for the hub tree — and that stamp turned out to be the only one (next block).

**Gate 3½ — a §A miss, found before T9 (9/17).** `worktree.sh land` is per repo and keys the green stamp on THAT repo's branch tree (worktree.sh:150); `write_green_stamp` stamped the hub tree only. The four sibling lands of T10 would all have died with "no green gate under 2 h for this tree" right after the run that gated them. §A row 1 saw the collector's blind spot and missed the stamp's. Fix in the gate itself (honest: the run really did execute each sibling worktree's suites against its code): `stamp_tree <dir> [label]`, called for `$HUB` and then for every sibling `sib()` resolved to a suffixed worktree — same 4-line shape plus `repo=<path>` and that worktree's own `dirty=1` verdict; main checkouts reached by the fallback are never stamped (nothing on master's tree was gated by this run, and land never merges master into itself). `tests/gate-stamp.test.mjs` lifts `sib`/`stamp_tree`/`write_green_stamp` out of the script text and runs them under `bash -c` over a fake `$ROOT` of one-commit git repos (5/5, ~1 s; hub stamp byte-identical without the suffix). release.sh's `--skip-gate` scan and land's docs-only scan both drop a foreign `head=` (the sha does not resolve in that repo → `continue`), so a sibling stamp can never stand in for another repo's. `docs/dev-flow.md` got its `ERA_WT_SUFFIX` paragraph here rather than at T10. tools/ changed → full re-gate before landing (Gate 4 below).

**T9 step 2 — the real thing on a scratch hub (9/17).** Hub 8480 from this worktree over a throwaway copy of the gate's data dir plus a synthetic four-page book (sine narration, 6 s/page), engine stand-in on 49155 → GET `/settings` answered `"doorGoes":"tdsnap","pauseGoes":"tdsnap"` for real; Playwright with `recordVideo`, touch context, `click()` on the doors (touch parity).
- Songs (`?recipe=songs`, Settings dwell 1000): bar holds `2000/2000`, song tile `1000`. test-song-1 at t=1.012 → 💬 → element paused at t=1.049, `playingId` and the tile ring kept; hub log `[kiosk] paused /board?recipe=songs — handing the screen to her talker` (the NORMALIZED path — no trailing slash, so the launcher's `%OPEN%` spelling matches; my first assertion looked for the slash and was the run's only red); `visibilitychange` → playing again at t=1.152, 2.55 a second and a half later. Clip: `scratchpad/t9-videos/t9-songs-pause-resume.webm` (5.6 s).
- Reader: bar `2000/2000`, 💬 up. Luna the Fox → page 3 (index 2, `003.wav`) narrating at t=2.006 → 💬 → paused at t=2.048, page kept; hub log `[kiosk] paused /reader`; `visibilitychange` → page 3 still, `003.wav` from t=0.010, 1.92 two seconds later. Clip: `t9-reader-page3-pause-resume.webm` (7.2 s).
- The resume leg in the launcher's own shape (`text/plain`, bare path, curl): pause songs → resume `/board/?recipe=movies` → **409** `launch`, log `resume /board?recipe=movies: a different app — forgetting /board?recipe=songs`; pause reader → resume `/Reader` (bat case, no slash) → **200** `resumed`; resume again → **409** `nothing is paused`. The stand-in saw one `POST /app/park` per pause (4/4). Kiosk minimize/foreground are Windows-only and untested here — that is step 3.
