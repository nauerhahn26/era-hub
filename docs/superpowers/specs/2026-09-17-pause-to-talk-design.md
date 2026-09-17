# Pause to talk — design

**Date:** 2026-09-17 · **Asked by:** dad ("new feature: pause to talk") ·
**Branch:** `feat/pause-to-talk` (era-hub), with matching branches in
era-core, era-board, era-making-words, era-pencil.

## 1. The ask

She is in the middle of an app — a song half played, a book open at page
six, a word half spelled — and needs to say something. Today the only way to
TD Snap is the 🚪, and the 🚪 closes the app: when she comes back the app
starts over. Dad wants a second door, **💬, top centre of the header**, that
takes her straight to TD Snap and *pauses* the app instead, so that picking
the same app's tile in TD Snap brings her back **exactly where she left off**
— the song picks up mid-song, the book on the same page.

Every app gets it: the boards (songs, movies, outfits), the Book Reader,
Making Words, The Pencil. The Reader has no header today and gains one.

## 2. Today's round trip (what changes)

| | today | after |
|---|---|---|
| leaving | 🚪 → `POST /kiosk/exit` → hub asks ERAgaze `/app/exit` (foregrounds TD Snap) **and kills the kiosk browser** | unchanged for 🚪. 💬 → `POST /kiosk/pause` → hub foregrounds TD Snap and **leaves the kiosk alive, minimized** |
| coming back | TD Snap tile → `RaeGaze\<App>.bat` → `start-hub.bat`, which `wmic`-kills any kiosk and launches a fresh one at the app's URL | `start-hub.bat` first asks the hub `POST /kiosk/resume`; if **that app** is paused the hub brings its window forward and the bat stops. Otherwise the bat does exactly what it does today |

Nothing in the gaze engine changes. The engine is on both devices as
compiled C#; everything here is hub, launcher and app code.

## 3. The hub (era-hub `server.js`)

### 3.1 `POST /kiosk/pause`  body `{ "path": "/board/?recipe=songs" }`

1. Remember `paused = { path, when: Date.now() }` — in memory only; a hub
   restart forgets it (the kiosk it named is gone too).
2. `enginePost("/app/park", "{}")` — drop the app's park override so the
   corner park returns while she is in TD Snap (exactly what `/kiosk/exit`
   does on the "home" leg).
3. Minimize our kiosk windows: the existing `stepAsideFromKiosk()` shape
   (PowerShell over `Win32_Process … -like '*kiosk-profile*'`, `ShowWindow
   MINIMIZE`). Windows only; on other platforms step 3–4 are no-ops and the
   answer is still `paused`.
4. Foreground the AAC app: `explorer.exe <ForegroundApp>`, where
   `ForegroundApp` is read from the engine's `GET /config` (it is the value
   `/app/exit` itself uses, and a family may have changed it in
   ERAgaze.json); default `shell:AppsFolder\TobiiDynavox.Snap_626b2w651dr5w!App`
   when the engine does not answer.
5. Answer `{ "action": "paused" }`.

`exitTarget()` gate: when the door goes "home" (Settings, or no engine on the
bus — VM, dev browser), pause is meaningless (home lives in the same kiosk),
so the hub answers `{ "action": "home" }` and does none of the above. The
apps never mount 💬 in that case (§5), so this leg is a belt for a stray
POST, not a path she can reach.

### 3.2 `POST /kiosk/resume`  body `{ "path": "/board/?recipe=songs" }`

- No `paused`, or `paused.path` ≠ body path (compared after trimming and
  lower-casing — `/reader/` vs `/reader` are the same app) → **409**
  `{ "action": "launch" }`. The launcher then kills-and-launches as today,
  which also disposes of any paused app that is *not* the one she picked.
- Match → restore + foreground the kiosk window (`ShowWindow RESTORE` +
  `SetForegroundWindow` on the first kiosk-profile process with a main window
  — the shape the welcome-page "settle" already uses at server.js ~L359),
  clear `paused`, answer **200** `{ "action": "resumed" }`.
- Match but no kiosk window found (someone closed it by hand) → clear
  `paused`, **409** `launch`.

Neither endpoint is `ownDoor`-guarded, like `/kiosk/exit`: the launcher
calls `/kiosk/resume` from `curl` (no `Sec-Fetch-Site`), and neither door
can delete or spend anything — the worst a hostile tab could do is park her
in TD Snap, which the 🚪 already allows.

### 3.3 `GET /settings`

Adds `pauseGoes: "tdsnap" | "home"` — the same probe as `doorGoes` (it *is*
`doorGoes`; a separate key so an app can tell "no pause here" apart from an
old hub that never heard of it: an older hub omits the key and the apps
treat a missing key as `home`).

## 4. The launcher (`tools/build-payload.sh` → `start-hub.bat`)

Between the "already running? just open the page" probe and the `wmic`
terminate, one guarded step:

```bat
curl.exe -s -f -o NUL --max-time 8 -X POST -H "Content-Type: text/plain" --data "%OPEN%" http://127.0.0.1:%PORT%/kiosk/resume
if not errorlevel 1 goto done
```

(with a `rem` paragraph above it, in the bat's own voice: no `%` in a `rem`
line and no emoji anywhere in the file — cmd expands `%` in comments too, and
the bat is read as a Windows code page.)

- **Plain text body, not JSON** (amended 9/17 from the JSON shape above):
  `%OPEN%` carries `?` and `=`, and `--data "{\"path\":\"%OPEN%\"}"` puts
  backslash-escaped quotes inside a cmd argument — the same class of quoting
  that left the Music and Movies icons dead (T7.6b). The bare path needs no
  escaping at all. §3.2's hub route therefore accepts **either** a JSON
  `{path}` body or a raw text path.
- `curl -f` exits 22 on a 4xx/5xx, 7 on a refused connection and 28 on the
  timeout, so `if not errorlevel 1` is exactly "resumed"; every other outcome
  falls through to today's kill-and-launch.
- **`--max-time 8`, not 4**: the hub's own `foregroundKiosk()` kills its
  PowerShell at 6 s and then answers, so curl must outlast it — otherwise a
  slow restore times out here and the bat sweeps away the very window the hub
  was bringing back. The hub is always the decider. The trade-off: a hub that
  is genuinely wedged (the first Drive mirror blocks HTTP for minutes) now
  costs her 8 seconds of a dead-looking tile instead of 4 before the launch
  goes ahead anyway.
- No hub running → the earlier probe already failed and the hub is starting;
  the resume call fails too and the normal launch follows. Correct: a fresh
  hub has nothing paused.
- `goto done` lands on the bat's existing final label, past both the `wmic`
  terminate and the kiosk `start` — a resumed window must not be swept.
- Still plain `curl.exe` + `wmic`, no scripted shell (the Defender law
  pinned by `tests/start-hub-bat.test.mjs`, which gains assertions that the
  resume line sits *after* the `:open` label and *before* the `wmic`
  terminate, that its body is the bare variable with no `{`, and that every
  line of every generated bat — `start-hub.bat`, `INSTALL.bat`,
  `UNINSTALL.bat` — is 7-bit ASCII).
- `curl.exe` has shipped with Windows since 10 1803; both devices are
  Windows 11.

## 5. The bar (era-core `lib/doorbar.js` + `doorbar.css`)

`mountDoorBar` moves out of era-board's `board-render.js` into era-core so
all five apps share one bar. Same look and law as today, plus one door:

- **🚪** top-left, as today: hold = `holdForExit(dwell)` (§5.1), silent,
  `onLeave` then `/kiosk/exit`.
- **💬** **top centre** (absolutely centred in the bar, same height as 🚪,
  same 2:1 width): the same hold as 🚪 — it takes her off the screen, the
  same consequence. `data-dwell-say="talk"`, `aria-label="talk"`.
  Click → `onPause()` (the app's hook, §6) then `POST /kiosk/pause` with the
  app's path; on `{action:"paused"}` nothing more — the window is about to
  be minimized under her. On anything else (`home`, network error) fall back
  to the 🚪 behaviour: `onLeave()` + `/kiosk/exit`. The app must not be
  left silent *and* on screen.
- 💬 is mounted only when `/settings` says `pauseGoes === "tdsnap"`. The bar
  is mounted before `/settings` returns on the splash (the board's 9/3 rule:
  a door from the first paint), so the bar exposes `setPause(on)` and the
  app calls it once settings land; 💬 appears then. On the VM and in a dev
  browser the bar looks exactly as it does today.
- `sizeBar()` sizes both doors from the same `--bar-inner`; the partner
  strip keeps its right-hand slot (board-partner.js reads `--bar-inner`,
  unchanged). Centre and right must not overlap at 1280 px: the strip is
  right-anchored and ≤ a third of the bar wide today; the 💬 is 2×inner
  ≈ 2×(9 % of 720) ≈ 130 px. Pinned by a layout test.

**Board law amended (dad, 9/17):** *the message bar carries the two doors —
🚪 and 💬 — and nothing else; they are its only dwell targets.* The 9/4
partner-strip amendment stands. `docs/board-design-rules` (era-board) gets
the line; `board-render.js`'s header comment points at era-core.

### 5.1 Holds: two speeds, both hers (dad's ruling, 9/17)

Dad caught that the exit door was a flat 2400 ms whatever Settings said,
and asked what the field does. The field ships **one** dwell time per user
(TD Snap, Grid 3, Communicator; Grid 3 allows a per-cell override as a
therapist's tool). Our content < nav < clear < send < exit ladder was our
own invention. Ruling:

- **the two doors that leave the screen — 🚪 and 💬 — hold `2 × dwell`;**
- **everything else holds `dwell`** — nav doors (category, back, more,
  show, board loads, movie/episode launches), Speak, clear, backspace,
  send, the reader's tiles, the Pencil's and Making Words' controls;
- no floors, no bonuses, no fixed numbers. `dwell` is the Settings value
  (600–3000). At today's 1200 the doors stay at 2400 — nothing she has
  learned moves.

Left alone, on purpose, because they are about *reading vs selecting*, not
consequence: the support-read (a glance reads a word aloud, under `dwell`
so it never commits) and the prediction slots (held above `dwell` so
reading the three suggestions cannot pick one).

Where it lives: `era-core/lib/contract.js` — `holds.exit` becomes
`holdForExit(contentMs) = 2 * contentMs`; `holdForDoor`, `navBonus`,
`navMin`, `answer`, `backspace`, `clear`, `send` are **removed** (the
whitelist principle cuts both ways: a rung nobody may use must not exist
to be reached for). `aac-board-builder/knowledge/ux-contract.md` §C is
rewritten first, as its header demands. Each app's hard-coded rung
(`board-render` `tileDwellMs`, `DWELL_SPEAK`/`DWELL_CLEAR`; `studio.js`
backspace 1800 / clear / send; `pencil.js`; `reader.js` `"2400"`) is
replaced by `dwell` or `holdForExit(dwell)`, and every app re-applies the
holds when `/settings` lands (the bar exposes `setDwell(contentMs)` for
its two doors; the board already re-renders on settings).

## 6. In each app

One contract, five implementations. Each app registers two hooks with the
bar and one listener:

- `onPause()` — stop making sound, remember where you are, set
  `S.paused = true`. Called before `/kiosk/pause`.
- `onResume()` — pick up where you were, re-post your park override (what
  you posted at boot), `S.paused = false`.
- `document.addEventListener("visibilitychange", …)`: on `visible`, **only
  if `S.paused`**, call `onResume()`. A hidden→visible flip that was *not*
  a pause (the movies picker under a streaming kiosk, a partner alt-tabbing)
  changes nothing.

Per app:

| app | `onPause` | `onResume` |
|---|---|---|
| **boards** (era-board) | `music-player.js`: pause the `<audio>`, keep the element and position (it already keeps a paused spot per clip); stop speech | `audio.play()` on the kept element; nothing if nothing was playing |
| **Book Reader** (era-hub) | stop narration/clip, keep `S.page`; stop speech | resume the clip from its kept `currentTime`, else re-narrate the current page from the top (a half-read sentence is not a place a child wants to resume at) |
| **Making Words** (era-making-words) | stop speech; the lesson state is already in memory | nothing — the letters are where she left them |
| **The Pencil** (era-pencil) | stop speech | nothing — the page is as she left it |

`dwell.js` gets no changes: a minimized window receives no pointer events,
and on return the bar calls `Dwell.suppress(600)` (the partner sheet's
settle window) so a gaze parked where the 💬 was does not fire it twice.

### 6.1 The Reader's new header (era-hub `public/reader/`)

The Reader has no header today; its 🚪 is a "Back to TD Snap" tile on the
shelf. It mounts the shared bar on **both** the shelf and the page view,
takes `barHeight(innerHeight)` off the top of its layout the way the board
does (`--bar-h` custom property; shelf grid and page canvas both `top:
var(--bar-h)`), and the shelf's exit tile is **removed** — the header door
replaces it, one door per screen. The book-page's own nav (page turn, back
to shelf) is untouched.

## 7. Edges, decided

- **Different app while paused:** she pauses Songs, picks Movies → 409,
  the bat kills the Songs kiosk and launches Movies. Only the same app
  resumes. `paused` is cleared whenever it can no longer be true: on a
  refused resume for a different path (that launch kills the paused kiosk)
  and on every `/kiosk/exit`.
- **Long pause:** no expiry in v1. A minimized Chrome costs memory and
  nothing else; if it ever bites, `lockMinutes`-style expiry is a one-line
  follow-up in `/kiosk/resume`.
- **Hub restarts while paused:** `paused` is gone; the tile launches fresh.
  The orphan kiosk is killed by the bat's `wmic` line as today.
- **She hits 💬 with nothing playing:** still a valid pause — the point is
  the *place*, not the sound.
- **Partner strip / media lock while paused:** untouched; a locked board
  resumes locked (lock state is localStorage).
- **🚪 while paused:** unreachable — the kiosk is not in front.
- **Two doors, one bar, gaze in the middle of the screen:** the 💬 sits in
  the top-centre strip, above the grid's top row and its centre column;
  dwell targets never overlap (the bar is its own box, as today).

## 8. Testing

- **era-hub unit** (`tests/`): `/kiosk/pause` and `/kiosk/resume` with the
  engine and `spawn` stubbed — records/clears `paused`, 200 vs 409, path
  normalisation, `home` gate, `ForegroundApp` from `/config` with default.
- **`tests/start-hub-bat.test.mjs`:** the resume line, its position, no
  scripted shell.
- **era-core contract:** `holdForExit(1200) === 2400`, `holdForExit(600)
  === 1200`; the removed rungs are gone (a test that imports them fails
  to compile is the point).
- **holds, every app:** with `/settings` at 900 ms, every grid/tray tile
  reads `data-dwell-ms="900"` (nav doors, Speak, clear, backspace, send
  included) and both bar doors read `1800`; support-read and the
  prediction slots keep their own values.
- **era-board Playwright:** the bar carries exactly two `.dwell` targets;
  💬 absent when `pauseGoes` is `home`; 💬 hold = 🚪 hold = 2 × dwell; 💬 click
  pauses audio + POSTs `/kiosk/pause`; a `visibilitychange` to visible
  with `S.paused` resumes the audio at the kept position; without `S.paused`
  does nothing; centre door and partner strip do not overlap at 1280×720.
- **Reader Playwright:** header on shelf and page; no shelf exit tile;
  narration pause/resume by page.
- **Making Words / Pencil:** their own suites — bar present, two doors,
  speech stops on 💬.
- **Device:** `push-device` to the tablet (dry-run dist); a real round trip
  from a TD Snap tile: Songs mid-song → 💬 → TD Snap → Songs tile → same
  song continues. Then Reader mid-book; then Movies → 💬 → Songs tile
  (different app) → Songs opens fresh, Movies gone.

## 9. Order of work

1. ux-contract.md §C rewritten (two speeds), then era-core `contract.js`:
   `holdForExit`, rungs removed — tests. Nothing imports the removed
   rungs until step 3–5 land in the same push, so this is done on the
   feature branches together, not landed alone.
2. era-hub: `/kiosk/pause`, `/kiosk/resume`, `pauseGoes`, launcher line —
   with tests. Landable on its own (no app uses it yet).
3. era-core: `lib/doorbar.js` + css, two doors, `setPause`, `setDwell`,
   hooks — tests.
4. era-board: import the shared bar, delete its own `mountDoorBar`, music
   hooks, every tile on `dwell` — tests; board law amended in its docs.
5. era-hub Reader: header + hooks, shelf tile removed, tiles on `dwell` —
   tests.
6. era-making-words, era-pencil: bar + hooks, controls on `dwell` — tests.
7. Gate, `push-device` to the tablet, the device round trips of §8.
8. Release as a patch (v0.33.x) once dad has used it.

## 10. Out of scope

- Pausing an external streaming app (Disney+/Prime) — the board never plays
  video and the engine's watch mode owns those kiosks.
- An engine-side `/app/pause` — not needed; revisit only if foregrounding
  from the hub proves flaky on a device.
- Expiry of a paused app (§7).
