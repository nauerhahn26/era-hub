# Button press to ask — plan (2026-10-28)

Status: drafted 10/28 from the approved design; nothing built yet.
Design: [button press to ask](../specs/2026-10-27-button-press-to-ask-design.md)
(approved; §5 choices are decided below under Decisions).
Worktree `era-hub--wt-flic`, branch `feat/flic`, from master `0636956` (Chat
v1.0.25 with the streaming pipeline). Builders: agents, test first; the
overseer scopes, reviews and decides. The gate runs detached with its pid
recorded and one `bash tools/gate-wait.sh <pid>` call. Release shape: patch.
Publishing waits for dad's word. The touch "Hold to ask" path stays byte for
byte (T0.3 pins it).

Order: 0 preflight fixes → 1 hub press route + command stream → 2 page →
3 window machine → 4 replacement batches → 5 device listener → 6 gate,
release, rollout. 5 is independent of 2-4 once 1 has landed `/status.buttons`.

Every task: what · Accept · Verify (a command) · Guard (TDD: the named test is
red before the code; STOP conditions). Posture: **implementing** = heads-down,
the spec decides; **collaborating** = judgment calls or hardware in the loop.

## Preflight (design validated against the code, 10/28)

Blocker
- B1 `chat-api.js` DEFAULTS `turnBytes: 512000` (16 s of PCM16) and the page's
  15 s `askTimer` cap one hold; a 60 s window needs its own byte budget
  (`windowBytes`, ~2 MB) and the hub, not the page, owning the utterance cap.
  Fixed in T3.2; without it every window dies at 16 s with `audio-limit`.
- B2 `chat-stream.js` finalizes a turn by sending `ForceEndpoint`+`Terminate`
  (`ws-streaming-turns`, `closesAfterTurn: true`) or `Finalize`. A window must
  NOT finalize per utterance. `end_of_turn` already arrives (handler line ~61)
  but is only re-emitted as a partial; the outlet has no turn-end hook. T3.1
  adds `out.turnEnd(text)` → stream event `'turn-end'` and a `window` mode
  where the socket stays open across utterances.

Warning
- W1 The hub never launches the kiosk today; `start-hub.bat` does
  (`tools/build-payload.sh` ~182-271). update.js's comment records a cmd
  relaunch refused under Defender ("spawn EPERM"), so the relaunch spawns the
  browser exe directly from node (T1.4), never `cmd.exe start-hub.bat`.
- W2 Speech activity: the ONNX `SpeechActivity` lives in the per-session
  worker child (`chat-speech-worker.js`), and in stream mode PCM bypasses it
  (`acceptPcm` → transcriber). Only the worker's energy gate (`measure`,
  variance floor .003²) is portable into the hub process. The 1.5 s fallback
  is therefore the hub's own energy gate over the frames it already receives
  (T3.3); the page reports nothing.
- W3 Chrome/Edge per-user audio-capture policy (`HKCU\Software\Policies\
  Google\Chrome\AudioCaptureAllowedUrls`, `...\Microsoft\Edge\
  AudioCaptureAllowedUrls`, REG_SZ value `1` = `http://127.0.0.1:<port>`):
  whether an unmanaged Windows machine honours HKCU policies for this key is
  **unverified** on Linux. T5.6 writes both; the VM case T5.8 proves or
  disproves it; the design's "touch Start Chat once" line is the fallback.
- W4 `RegisterHotKey` works only in the interactive desktop session that the
  hub's child inherits. The hub must be the Startup-link hub in her session
  (the 10/19 boot pass); a hub started from the ssh user (school lessons)
  registers hotkeys in a desktop nobody sees. T6.4 checks `/status.buttons`
  on the device, not only on the host.
- W5 The hidden page shuts its session down on `visibilitychange`
  (`app.js` ~733) and `startChat()` refuses while hidden. Dispatcher case 2
  must foreground first and wait for the page's own `visible` report (T1.3).

Info
- I1 Runtime `powershell.exe -Command` spawns from the hub are proven and
  allowed (`closeKiosk`, `foregroundKiosk`, `stopGazeProcess`); the law
  forbids `.ps1` files and launcher lines (`tests/start-hub-bat.test.mjs`).
- I2 Loopback gate = `update.isLoopback(req.socket.remoteAddress)` (server.js
  2376, 3901, 3995); `chat-api.ownRequest` adds Host/Origin/Sec-Fetch-Site
  checks — a C# `HttpWebRequest` with no browser headers passes it.
- I3 `NOT_INTERACTION` (server.js 1787) stays as is: a press is activity.
  Chat enabled = `loadEnabledApps().includes("chat")` (APPS id `chat`).
- I4 `/status` (server.js 3890) has only `gaze`; Settings has no Buttons card;
  `settings-layout.js` builds `connections` from `original.*` cards.
- I5 `tools/testing/registry.json` has no `tests-vm` entries: VM legs run from
  `tools/vm-e2e.sh` (`leg-b-update.e2e.mjs`), so the Windows case is a new
  `test()` there, not a registered suite. New `tests/*.test.mjs` suites are
  registered by `node tools/testing/classify-suites.mjs`.
- I6 Ports 8494/8495 have no claim in any of the five repos' `tests/`,
  `tests-vm/`, `tools/` (checked 10/28; `tests/suite-ports.test.mjs` is the
  arbiter). 8480+ is the scratch band but 8486-8491 are already suite ports.
- I7 `chat-turns.js` KINDS/STAGES/TEXT_STAGES and `turnlog.js` MULTI are
  closed sets: new stages are schema changes with tests (T3.6).
- I8 `window.Dwell.state()` (era-core `dwell.js` 380) exposes `target` and
  `progress`: the page can tell "no dwell in progress" (T4.3).

## Phase 0 — preflight fixes and pins (implementing)

- [x] **T0.1** `chat-stream.js`: add `turnEnd` to the outlet and a
      `window: true` turn option under which `finalize()` is never implied by a
      turn end and `closesAfterTurn` sockets are not terminated per utterance.
      Accept: `ws-streaming-turns` emits `'turn-end' {text}` on `end_of_turn`;
      `ws-listen-query` emits it when `speech_final === true` (unverified field;
      absent → never, the silence fallback covers it). Verify:
      `node --test tests/chat-stream.test.mjs`. Guard: tests first; existing
      hold behaviour byte for byte (every current test stays green).
- [x] **T0.2** `chat-api.js`: `windowBytes` limit (default 2 000 000) applied
      when `session.turn.window` is set; `turnBytes` unchanged for holds.
      Verify: `node --test tests/chat-api.test.mjs`. Guard: a hold still hits
      `audio-limit` at 512000.
- [x] **T0.3** Pin the touch path: `tests/chat-hold-path.test.mjs` hashes the
      text of `beginAsk`, `finishAsk`, `cancelAsk` and the
      `touchButton($('ask'), beginAsk, finishAsk, cancelAsk)` line in
      `public/chat/app.js` against `tests/fixtures/chat-hold-path.sha256`.
      Accept: fails with "the hold path changed — design §2 says it stays as
      shipped". Verify: `node --test tests/chat-hold-path.test.mjs`. Guard:
      the fixture is written once, now, before any phase-2 edit. STOP if a
      later task needs to change these functions: amend the design first.

## Phase 1 — hub: command stream, `/buttons/press`, dispatcher (implementing)

- [x] **T1.1** `buttons.js` (new hub module, shipped in build-payload's module
      list): `createButtons({ port, enabledChat, kiosk, log, clock })` with
      `press({key, action})` → `{ ok, dispatch }` and the command stream
      registry. Accept: exports `KEYS` = F13, Ctrl+Alt+F9, Ctrl+Alt+F10 → ask;
      F14, Ctrl+Alt+F11 → cancel. Verify: `node --test tests/buttons.test.mjs`
      (unit, no hub). Guard: tests first; unknown key → 400.
- [x] **T1.2** Command stream: `GET /chat/api/commands[?nonce=]` SSE in
      chat-api (ownRequest-gated), `: connected`, `ping` every 15 s, one
      subscriber (a newer connection replaces the older with `{type:'replaced'}`);
      `POST /chat/api/commands/visibility {visible}` from the page. Events:
      `ask {pressAt, key, nonce?}`, `end`, `cancel`. A nonce given at connect is
      replayed as `ask` once and marked spent (30 s TTL, 16 hex chars from
      `crypto.randomBytes(8)`). Verify: `node --test tests/chat-commands.test.mjs`.
      Guard: a nonce replays once (reconnect with it → nothing); a request from a
      non-loopback peer → 403.
- [x] **T1.3** (port 8470, both hubs in turn: suite-ports reserves 8480+) Dispatcher in `buttons.js` per design §4.2: visible → push
      `ask`; hidden → `foregroundKiosk()` then wait ≤3 s for the page's
      `visible` report, else relaunch; nobody listening → relaunch with nonce;
      Chat off → 409 `{error:'chat-off'}`; `cancel` with no window → `{ok:true,
      dispatch:'none'}`; `ask` while a window is open → `end` (second press).
      Verify: `node --test tests/buttons-press.test.mjs` (real hub child on
      8494, second hub on 8495 with `ERA_FAKE_KIOSK_WINDOW=0`, as
      `tests/kiosk-pause.test.mjs`). Guard: the `/buttons/press` route in
      server.js is three lines (loopback gate, body, `buttons.press`); logic
      lives in buttons.js. STOP if 8494/8495 fail `suite-ports`: pick again.
- [x] **T1.4** `kiosk-launch.js`: `kioskArgs(open, { port, dir })` and
      `findBrowser()` with the exact flags and browser order of start-hub.bat's
      kiosk line; `relaunchKiosk(path)` = `closeKiosk()` → 1 s → `spawn(exe,
      args, {detached, stdio:'ignore', windowsHide})` → `psSettleKiosk(6)`
      settle. Accept: `tests/kiosk-launch.test.mjs` derives the expected flags
      from the bat text (as `start-hub-bat.test.mjs` does) and they match; off
      Windows the relaunch records `{would: args}` and resolves. Guard: never
      `cmd.exe`, never a `.ps1`; `tests/start-hub-bat.test.mjs` stays green.
- [x] **T1.5** `/status` gains `buttons: { state, pid, keys:{registered,
      failed}, lastPress:{at,key,action,dispatch}, restarts, lastError,
      micPolicy }` (states filled by phase 5; `unsupported` off Windows).
      Verify: `curl -s 127.0.0.1:8494/status | jq .buttons` in the T1.3 suite.
- [x] **T1.6** (five: chat-hold-path too; buttons-press holds `ports: [8470]`) Register the four new suites: `node tools/testing/classify-suites.mjs`
      then `node --test tests/suite-classes.test.mjs tests/suite-ports.test.mjs`.
      Guard: `ports: [8494, 8495]` on buttons-press only.

## Phase 2 — page: ask from a push or a nonce, no touch (implementing)

- [ ] **T2.1** `public/chat/commands.js`: opens `EventSource('/chat/api/commands'
      + nonce)` at load (before any session), reports visibility on
      `visibilitychange`, strips `?ask=` with `history.replaceState` once
      claimed. Verify: `node --test tests/chat-commands-browser.test.mjs`
      (Playwright fixture copied from `tests/chat-stream-browser.test.mjs`:
      fake audio device, CDP touch). Guard: a reload after the claim never asks.
- [ ] **T2.2** `askFromButton(cmd)` in `app.js`: a new function beside
      `startChat`/`beginAsk` (those stay untouched, T0.3): if no session →
      `startChat` body factored into `openSession()` that both call; when
      `engineReady` → `control('window', {context})`, then tone, then
      `mic.begin()` 200 ms after the tone ends; "Listening" in `#phase`.
      Accept: no touch anywhere; `document.body.dataset.listening === 'true'`.
      Verify: same suite, test "an ask push starts a session with no touch".
      Guard: `startChat` must keep refusing while hidden; `askFromButton`
      does too (the hub foregrounds first).
- [ ] **T2.3** Lines: no stream settings (`config.runtime` lacks
      `capabilities.streaming` / `ready.capabilities.remoteStreaming !== true`)
      → notice "Streaming speech is not set up on this device", no tone;
      `NotAllowedError` → "Touch Start Chat once to allow the microphone", no
      tone; window closed with nothing said → "Didn't hear a question" for 4 s.
      Verify: same suite, three tests. Guard: wording as written here.
- [ ] **T2.4** `public/chat/tones.js`: WebAudio oscillator, listening tone
      660→880 Hz 180 ms, done tone 880→660 Hz 180 ms, gain 0.15, through the
      page's own `AudioContext` (the kiosk's `--autoplay-policy` flag applies;
      the fixture passes the same flag). Accept: a browser test counts two
      `createOscillator` calls per window (spy installed before load); nothing
      is spoken during a window (`/tts` requests = 0 while listening).
      Guard: no audio files added to the payload.

## Phase 3 — hub window state machine (implementing; W2 is the one judgment call)

- [ ] **T3.1** `chat-window.js`: `createWindow({ clock, limits, seal, close })`
      pure machine; inputs `speech(frameEnergetic)`, `turnEnd(text)`,
      `partial(text)`, `press()`, `cancel()`, `pick()`; constants 1.5 s
      utterance silence, 15 s utterance cap, 10 s window silence, 60 s cap.
      Accept: `tests/chat-window.test.mjs` drives every row of design §4.4 with
      an injected clock: end-of-turn seals; silence after speech seals; cap
      seals and keeps listening; 10 s silence closes `silence`; 60 s closes
      `cap`; second press closes `press`; cancel closes `cancel` with no seal;
      pick closes `pick`; nothing said closes `nothing-said` with zero seals.
      Guard: tests first; the machine never touches sockets or the page.
- [ ] **T3.2** Wire it in chat-api: control type `window` begins a stream turn
      with `window: true` (B1 limit, B2 socket kept), `session.window` runs the
      machine; each seal runs `runChoices(session, windowText)` (whole window
      text) and the sealed batch is emitted as `batch-sealed {windowId, seq}`
      (`seq` 1 = first, >1 = replacement); SSE adds `window-open`,
      `utterance-sealed {seq, text, windowText}`, `window-closed {reason}`;
      close finalizes or cancels the transcriber and sets `mode: 'paused'`.
      Verify: `node --test tests/chat-window-hub.test.mjs` (fake streaming
      service from `tests/chat-stream-hub.test.mjs`). Guard: a `finish` or
      `ask` control on a windowed session → 409 `window-open`.
- [ ] **T3.3** Silence fallback (W2): `chat-window.js` exports `energyGate()`
      ported from the worker's `measure` (100 ms frames, variance ≥ .003²);
      chat-api feeds every accepted window frame to it; "1.5 s silence" = 15
      consecutive quiet frames after ≥ 2 energetic ones. Provider turn-end wins
      when it arrives first. Verify: unit test with synthetic PCM (tone then
      zeros). Guard: the ONNX model is not loaded in the hub process.
- [ ] **T3.4** Second press and cancel reach the machine through
      `buttons.press` → `chatApi.window(sessionId).press()/cancel()`; pick:
      the page's `select` sends `control('pick')` before speaking. Verify:
      T3.2 suite. Guard: a pick always wins over a pending seal.
- [ ] **T3.5** Latency stages: `pressAt` travels in the `ask` command; the
      page marks `press` (from pressAt), `tone`, `listening`; the hub marks
      `utteranceSealed` (MULTI, text), `batchReplaced` (MULTI), `windowClosed`
      (text = reason). New turn kind `press`. Accept: `tests/chat-turns.test.mjs`
      and `tests/chat-turnlog.test.mjs` accept the new rows and reject an
      unknown stage. Guard: TEXT_STAGES/MULTI extended explicitly; the record
      stays content-free when test mode is off.
- [ ] **T3.6** Browser test: "a question with a pause inside it stays one
      utterance" (fake service holds end_of_turn; silence < 1.5 s), "a second
      utterance adds a batch" and "the done tone fires at close" in
      `tests/chat-commands-browser.test.mjs`. Guard: all through the command
      stream, no touch.

## Phase 4 — replacement batches (implementing)

- [ ] **T4.1** `controller.js`: `replace(choices)` stages a pending
      replacement (a newer one supersedes it unseen, `timing('replacementSuperseded')`);
      `neutral()` in `'Your turn'` swaps it in; `select()` discards pending;
      sealed batches stay frozen (`Object.freeze`). Accept: `tests/chat-ui.test.mjs`
      gains tests for supersede, swap-only-on-neutral, pick-discards-pending.
      Guard: `prepare()`/first reveal behaviour unchanged (existing tests green).
- [ ] **T4.2** Position stability: each choice carries `cell` 0-3; on swap an
      unchanged label keeps its cell, new labels take free cells in order,
      removed labels leave `null` cells; `renderGrid` honours `cell` and draws
      an empty `waiting` tile in a vacated cell. Accept: unit test "chicken and
      fish stay put when pasta arrives"; "removed leaves an empty cell".
      Guard: the four `positions` in `renderGrid` stay the cell table.
- [ ] **T4.3** Neutral moment in `app.js`: pending replacement swaps when the
      gaze/mouse pointer is in `.rest`, or is on no `.tile:not(.rest)` and
      `window.Dwell?.state().target == null`; checked on `pointermove` and once
      250 ms after the replacement arrives. Guard: a pointer resting on a tile
      waits with no upper bound (test asserts no swap after 5 s, then swap on
      leaving the tile).
- [ ] **T4.4** Browser tests: "a second utterance replaces the batch only after
      a neutral move", "a pick during a pending replacement wins (spoken text =
      the shown tile, pending discarded, window closed)". Guard: in
      `chat-commands-browser`; the hold suites untouched.

## Phase 5 — device button listener (collaborating: Windows, hotkeys, policy)

- [ ] **T5.1** `buttons/EraButtons.cs` (hub repo, shipped by build-payload.sh
      to `$OUT/buttons/`): WinForms message-only window, `RegisterHotKey` ids
      1-5 for F13, F14, Ctrl+Alt+F9/F10/F11 with `MOD_NOREPEAT`; on `WM_HOTKEY`
      `POST http://127.0.0.1:<port>/buttons/press {"key","action"}` (2 s
      timeout, fire and forget); prints one JSON line
      `{"registered":[...],"failed":[...]}` on stdout at start; named mutex
      `Local\OurEraComms.Buttons` (retry 5 s, then exit 3); exits when the hub
      pid from argv[2] is gone (2 s poll). No window, no tray, no files.
      Verify: `tests/buttons-payload.test.mjs`: the .cs is in the payload list,
      contains the five keys and no `powershell`; payload ships no `.ps1`.
      Guard: compile attempted on the VM in T5.8 before any device.
- [ ] **T5.2** Compile/start in `buttons.js` mirroring `installGaze`: csc
      `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo
      /target:winexe /platform:x64 /r:System.Windows.Forms.dll`, source hash in
      `buttons/EraButtons.exe.src-sha256` (content, not mtime), build to
      `.new.exe` and swap after stopping ours by path, failed compile keeps the
      old exe; seam `ERA_BUTTONS_CSC` for the stub compiler (as `ERA_GAZE_CSC`).
      Verify: `node --test tests/buttons-recompile.test.mjs` (shape of
      `tests/gaze-recompile.test.mjs`; port 8495 reused only if 8494 suite does
      not run them concurrently — else take 8496 after a suite-ports check).
- [ ] **T5.3** Keeper: the hub spawns the exe as its own child (`stdio:
      ['ignore','pipe','ignore']`, `windowsHide`), parses the registration
      line into `/status.buttons.keys`, restarts on exit with backoff 5/15/60/
      300 s, ladder reset after 10 min alive; `enabled` = win32 (or the seam)
      AND Chat enabled; Chat turned off → stop ours by path. Verify:
      `node --test tests/buttons-keeper.test.mjs` with an injected clock
      (shape of `tests/gaze-supervisor.test.mjs`). Guard: the keeper never
      kills by name; `tests/suite-ports` kill-by-name scan stays green.
- [ ] **T5.4** Settings → Connections → **Buttons** card: `<div class="card"
      id="buttons">` in `public/settings/index.html`, `put(original.buttons,
      'connections')` and a search row `['connections','buttons','Buttons',
      'Flic, button, press, ask, square']` in `settings-layout.js`; painted from
      `/status.buttons` every 5 s while the section is `connections` (pattern
      at index.html ~1243). Copy: "Listener running · holds F13, F14,
      Ctrl+Alt+F9/F10/F11 · last press 18:04 F13 (ask)"; "Chat is off — the
      buttons do nothing until Chat is enabled"; setup note: "Flic app:
      Keyboard mode, click → F13, hold → F14, double click empty; pair in
      Windows Bluetooth as a keyboard. Square button: Hardware Settings →
      Send Keyboard Key → Ctrl+Alt+F9, then restart the device." Verify:
      `node --test tests/settings-ui.test.mjs tests/settings-navigation.test.mjs`.
- [ ] **T5.5** Microphone policy write at boot (W3): `reg.exe add <key>
      /v 1 /t REG_SZ /d http://127.0.0.1:<port> /f` for both browsers, result in
      `/status.buttons.micPolicy` (`written|failed|n/a`). Verify: unit test
      asserts the two argv arrays; no PowerShell. Guard: runs only when Chat is
      enabled; never on a non-win32 host.
- [ ] **T5.6** Boot wiring in server.js: after `reconcileApps()`,
      `buttons.start()`; `appInstalling`-style guard so a compile never runs
      twice; `/status` filled. Verify: T1.3 suite re-run shows `state` moving
      `compiling → running` with the stub. Guard: a compile failure logs once
      and leaves Chat working.
- [ ] **T5.7** Payload guard: `tests/start-hub-bat.test.mjs` unchanged;
      `tests/buttons-payload.test.mjs` asserts `tools/build-payload.sh` copies
      `buttons/EraButtons.cs` and the Chat test-mode guard still passes; the
      Chat test-mode and era-scan steps unchanged.
- [ ] **T5.8** Windows case (quiet profile) as a new `test()` in
      `tests-vm/leg-b-update.e2e.mjs` after the Chat case: enable Chat, wait
      for `/status.buttons.state === 'running'` and five registered keys;
      ship a 15-line C# `sendkey.cs` (compiled with the guest csc as
      `vm.windows()` does) that injects F13 via `SendInput` from
      `vm.interactive()`; assert `/status.buttons.lastPress.key === 'F13'`
      and `dispatch` ∈ {relaunch, visible}; repeat with Ctrl+Alt+F9; assert
      the kiosk URL via CDP is `/chat/`; assert `navigator.permissions.query
      ({name:'microphone'})` is `granted` in the fresh kiosk profile (W3), or
      record `prompt` as the verdict. Verify: `bash tools/vm-e2e.sh <dist>
      --only b --profile quiet` (detached, sentinel). Guard: STOP and report
      if the policy verdict is `prompt`: the design's one-touch fallback then
      becomes a rollout step, not a code change.

## Phase 6 — gate, patch release, rollout (collaborating: dad and hardware)

- [ ] **T6.1** Full gate: `setsid nohup bash tools/era-gate.sh >"$LOG" 2>&1 &
      echo $! >"$PIDFILE"; bash tools/gate-wait.sh "$(cat "$PIDFILE")"`.
      Accept: `== era-gate: N passed, 0 failed ==` and a stamp. Guard: no polling.
- [ ] **T6.2** Land and cut: `bash $W land ~/new-era/era-hub flic`, then on
      dad's word `bash tools/release.sh v1.0.x --patch` (VM leg B on quiet).
      Accept: `gh release view v1.0.x` lists the six assets.
- [ ] **T6.3** Home I-13 first: `bash tools/push-device.sh i13 ~/new-era/dist/
      release-v1.0.x` (or wait for the 30-min self-check). Verify over a tunnel
      (8510 is in the tunnel band): `ssh -N -L 8510:127.0.0.1:8377 i13 &` then
      `curl -s http://127.0.0.1:8510/status | jq '.buttons | {state,keys,
      micPolicy}'` → `state: "running"`, `keys.registered` has all five,
      `micPolicy: "written"`. STOP if `state` is `unsupported` or `keys.failed`
      names F13: another program holds the key; report before pairing.
- [ ] **T6.4** Software press from the host (loopback through `-L`, as
      `/update/check`): `curl -s -X POST -H 'Content-Type: application/json'
      -d '{"key":"F13","action":"ask"}' http://127.0.0.1:8510/buttons/press`
      → `{"ok":true,"dispatch":"relaunch"}` the first time, Chat on the screen
      with "Listening" and the tone (dad watches); a second curl within the
      window → `{"ok":true,"dispatch":"end"}`. From another LAN host → 403.
- [ ] **T6.5** Turn log check (test mode on for the evening): on the device
      `type "%LOCALAPPDATA%\Our Era Comms\data\logs\chat-turns\<day>.jsonl"`
      → a line with `"kind":"press"` and stages `press, tone, listening,
      utteranceSealed, batchSealed, windowClosed`; `press→tone` under the
      design's budget row for that dispatch (1.5/2.5/4/7 s).
- [ ] **T6.6** Dad's hardware steps (collaborating): Flic app → Keyboard mode,
      click F13, hold F14, double click empty; pair keyboard-only in Windows
      Bluetooth; if keys never arrive, add the least harmful mouse action to
      double click and check on screen that it does nothing to her board.
      Tobii Hardware Settings → Square = Send Keyboard Key Ctrl+Alt+F9 →
      device restart. Accept: `/status.buttons.lastPress.key` shows `F13` after
      a real click and `Ctrl+Alt+F9` after the Square button.
- [ ] **T6.7** Dad confirms the §1 moment on the home I-13 ("chicken or fish",
      then "or pasta": pasta joins, chicken and fish stay put, her pick speaks,
      microphone closes). Then stream settings to the tablet and the school
      device (operator-managed `ai.env`, configuration only), `push-device.sh
      tablet …`, school at its next awake window; T6.3's curl on each.
- [ ] **T6.8** Retrospective below; design §5 marked decided; memory note on
      the policy verdict (W3) and the Flic pairing outcome.

## Decisions (design §5 and the builder's calls)

1. End-of-turn: `ws-streaming-turns` `end_of_turn` and `ws-listen-query`
   `speech_final` (if present) are the provider signals; the 1.5 s fallback is
   the hub's energy gate (the worker's variance floor) over the window's frames,
   15 quiet 100 ms frames after ≥ 2 energetic ones; the provider wins when first.
2. Relaunch: `kiosk-launch.js` spawns the browser exe directly with
   start-hub.bat's flags (parity test), after `closeKiosk()` + 1 s, then
   `psSettleKiosk(6)` to foreground. Never cmd.exe, never a `.ps1`. Nonce =
   16 hex chars, 30 s TTL, spent on first claim; the page strips the query.
3. Hidden page: `foregroundKiosk()` then ≤ 3 s for the page's `visible` report;
   else relaunch. Visibility is reported by the page over
   `POST /chat/api/commands/visibility`.
4. Listener supervision: a child of the hub (not detached) restarted on exit
   with 5/15/60/300 s backoff; named mutex for single instance; exits when the
   hub pid is gone; stopped by path when Chat is turned off. Not the bus-probe
   gaze supervisor (nothing to probe).
5. State to `/status.buttons` and Settings → Connections → Buttons (card id
   `buttons`, painted every 5 s while the section shows).
6. Microphone grant: `reg.exe` writes both browsers' `AudioCaptureAllowedUrls`
   value `1` for `http://127.0.0.1:<port>` at boot; the VM case decides whether
   the kiosk honours it; the one-touch fallback stands either way.
7. Tones: WebAudio oscillators in the page, 180 ms each, gain 0.15; frames
   start 200 ms after the listening tone ends so the tone is never transcribed.
8. Turn log: kind `press`; stages `press`, `tone`, `listening`,
   `utteranceSealed` (repeatable, text), `batchReplaced` (repeatable),
   `windowClosed` (text = reason).
9. Film playing: a press does what it does elsewhere (Chat relaunches over the
   engine's streaming kiosk, which `closeKiosk` never touches); the film's
   audio may be heard. Recorded as allowed by the design's non-goal.
10. Position stability: `cell` 0-3 on each choice; removed choices leave an
    empty `waiting` tile until the next replacement.
11. Ports 8494/8495 for the new hub suites (8496 if a third hub is needed),
    confirmed by `suite-ports` before the first run.
12. The hub keeps `/buttons/press` as activity (not in `NOT_INTERACTION`).

## Retrospective

(to be written after T6.8)
