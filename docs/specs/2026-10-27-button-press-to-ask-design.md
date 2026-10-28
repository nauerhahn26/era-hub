# Button press to ask — design (2026-10-27)

Dad, 10/27: "I bought 3 flic devices, I think they'd be perfect for this, but I
want it to work without a hub and work as a command to launch speech to text
if I put it as an adhesive on the eye gaze device. Separately, I'm not using
all the buttons on the bottom of the TD-13 so we could use the square to
launch it too."

The experience he described: "I press the button and it activates the speech
to text listener and I ask a question like 'do you want chicken or fish'.
Ideally it could be one touch and smart enough to shut off (so you don't have
to hold) after the question was completed. Today in Chat the speech is
processed and then a response, visual tiles, come back: a chicken tile and a
fish tile." It must work "from anywhere", and "if the question feels complete
by the system processing it, it should render options, and if more data comes
in it can render more options or modify existing ones." The listening ends on
a "second press, silence or some time cap."

This record extends the [hold-button design](2026-10-25-chat-hold-button.md),
whose "physical Bluetooth mapping is deferred until its hardware is known"
line it closes, and builds on the [real-time chat design](2026-10-27-real-time-chat-design.md)
(streaming recogniser, speculative choices, sealed batches).

## 1. The moment

Dad is beside her. She is on the I-13, in any app, or in TD Snap. He presses
the Flic stuck to the device's frame (or the I-13's Square button). Within a
breath the device gives a short listening tone and Chat is on her screen with
a visible "Listening" state. He says "do you want chicken or fish". He stops
talking. A beat later the chicken and fish tiles are on her board. He adds
"or pasta": a pasta tile joins them, chicken and fish stay where they were.
She looks at fish and holds; the device says "fish". The microphone is closed.

He never holds anything, never touches the screen, never waits for a "Start
Chat" step. If nothing is said, the device closes the microphone by itself.

## 2. Goals, non-goals, anti-goals

Goals

- One press, from anywhere on the device, starts a Chat question with no
  other gesture: open Chat if needed, start the session, listen.
- The question ends by itself when he stops talking; he can also end it with
  a second press; it always ends on a time cap.
- Choices appear as soon as a question sounds complete and can grow or change
  when he keeps talking, without ever moving under her gaze.
- Works with no Flic Hub, no phone in the loop after a one-time setup, and
  with the I-13's own Square button through the same path.
- Same build on all three devices (home I-13, tablet, school I-13); each
  device owns the buttons paired to it.

Non-goals

- The button as her access method (switch scanning, switch select). This is
  the partner's button. Nothing she does with it is designed here.
- Flic Hub, Flic Twist, the wired 3.5 mm switch jacks. The jacks can "start a
  program" and may be a later path; not now.
- Changing the touch "Hold to ask" path. It stays exactly as shipped.
- Opening Chat over the gaze engine's streaming kiosk (a video playing). A
  press while a film plays is not designed; the builder may let it do what a
  press does elsewhere or ignore it, and must say which.
- Pairing a button at school. The software supports it; whether a Flic lives
  at school is dad's later call.

Anti-goals (a failure even if it "works")

- A tile that changes, moves or appears while her gaze is filling a tile.
- Anything that starts listening from her gaze or her touch.
- Audio captured outside a listening window, or a question submitted that he
  never asked (a press with no speech must submit nothing).
- A press from anything but the device itself (the hub route is loopback
  only; the school network must never be able to trigger it).
- Speech from the device during listening (it would be captured).
- Shipping PowerShell files or editing Tobii's own configuration files.

## 3. Constraints and laws that apply

- era-hub AGENTS.md laws: worktree, gate, no PowerShell in the payload, no
  family names or device identifiers, vendor-neutral code and commits.
- Board design rules: black rest cells, a reply is revealed only on a neutral
  gaze (the "fresh move into the black centre" rule and its 10/27 "resting
  counts" relaxation), immutable sealed batches, nothing speaks unless she
  selects it. The [prototype design](2026-10-25-chat-prototype.md) invariants
  stand.
- Loopback-only routes are gated the way `/gaze/stop` and `/update/check`
  are (`update.isLoopback` on the socket peer).
- The I-13's Hardware Settings file belongs to Tobii Dynavox; dad sets the
  Square button in their GUI (a device restart is required by their tool).
  The hub never writes that file.
- Chat is an optional app, off by default. The button does nothing while Chat
  is off, and Settings says so.

## 4. The decided design

### 4.1 Button transport: keyboard mode, caught as a global hotkey

Recon (10/27): there is no Flic app for Windows. The official Windows SDK is
a closed binary with unresolved reconnect complaints; the open-protocol
libraries need Python or Rust on the device. But a Flic 2 can be set to
**keyboard mode** once from the phone app (Shortcut Labs: "configured as a
Keyboard, HID over BLE, directly in the Flic app and then paired to the
Windows system using Bluetooth"). After that it is a Bluetooth keyboard to
Windows: no hub, no phone, Windows reconnects it itself.

Decided:

- Each Flic is programmed once in the phone app: **click → F13**,
  **hold → F14**, double click unassigned. A Flic with a double-click action
  delays every single click until its double-click window has passed, which
  would eat into the latency budget unseen, so double click stays empty; a
  hold sends its key once (no repeat), which is all cancel needs. Then the
  button is paired to one device through Windows Bluetooth settings,
  **keyboard-only**: no mouse action is assigned, because a mouse click would
  land at her gaze cursor and could select a tile. One field report says a
  keyboard-only Flic showed as "other device" in Windows until a mouse action
  was added; the first pairing on the home I-13 verifies whether keys arrive
  without one. If they do not, the setup note names the least harmful mouse
  action, assigned to double click, and the rollout step checks on screen
  that it does nothing to her board before the button is left with her.
- If the phone app's keyboard mode cannot emit F13 or F14, the fallback keys
  are **Ctrl+Alt+F10** (ask) and **Ctrl+Alt+F11** (cancel). The listener
  registers both sets from the first release, so no re-release is needed
  whichever the app allows.
- The I-13 Square button is set in Tobii Dynavox Hardware Settings to **Send
  Keyboard Key**. Their key list stops at F12 and offers Ctrl/Alt/Shift/Win
  modifiers; the default the device listener registers for it is
  **Ctrl+Alt+F9**. This is dad's one-time step, then a device restart.
- A small **device button listener** runs in her Windows session on every
  device and registers these as global hotkeys (`RegisterHotKey`: it receives
  the key whatever window is in front, kiosk Chrome or TD Snap). On a hotkey
  it POSTs to the hub: `POST /buttons/press` `{"key":"F13","action":"ask"}`.
  F13 and Ctrl+Alt+F9 mean **ask** (Ctrl+Alt+F10 too); F14 means **cancel**
  (Ctrl+Alt+F11 too).
- The listener is a C# source shipped in the payload and compiled on the
  device by the hub exactly as `ERAgaze.cs` is (framework `csc`, hash-guarded
  recompile), started by the hub at boot and restarted by the hub if it dies.
  It lives in era-hub, not in the gaze engine, because the tablet has no
  engine. It never shows a window.
- Keys are fixed in this release; no key editor in Settings.

Rejected: the official FlicSDK.exe (closed, reconnect bug reports, its own
pairing wizard); a Flic Hub (dad's requirement); folding the listener into
ERAgaze (not on the tablet); a keystroke delivered straight to the Chat page
(only the focused window would see it).

### 4.2 The hub's ask command

`POST /buttons/press` is loopback-only and counts as activity (a partner is
present). It drives one dispatcher:

1. **Chat page connected and visible.** The Chat page opens a hub command
   stream the moment it loads, before any session exists (today the only
   stream is per session). The hub pushes `ask` on it; the page acts (4.3).
2. **Chat page connected but hidden** (the talk door minimised the kiosk
   behind TD Snap; the page refuses to start a session while hidden). The hub
   brings the kiosk to the front with its existing resume helper and then
   pushes `ask`; if the window is not visible within 3 s it falls through to
   relaunch.
3. **No Chat page listening.** The hub brings Chat up: it closes its own
   kiosk window if one is open (whatever page it shows, TD Snap in front or
   not) and launches it again at `/chat/?ask=<nonce>` with the same command
   line `start-hub.bat` uses. The page consumes the nonce once (a reload does
   not ask again) and acts as in (1). The builder may use the existing
   foreground/resume helpers to make sure the new window is in front.
4. **Chat disabled** in settings: 409, nothing happens, and the Settings
   buttons panel shows "Chat is off".
5. **cancel** (F14): if a listening window is open, close it and discard
   everything; otherwise nothing.

A second `ask` while a window is open is the **second press**: it ends the
current utterance and the window (4.4).

Latency budget, measured and recorded in the turn log as a stage:

| from a press to the listening tone | budget |
| --- | --- |
| Chat up and session ready | 1.5 s |
| Chat page up, no session yet | 2.5 s |
| Chat page hidden behind TD Snap, foregrounded | 4 s |
| kiosk relaunched | 7 s |

### 4.3 Session start without a touch

On `ask` the page does what "Start Chat" does today with no touch: microphone,
session, worker warm-up, then straight into listening when ready. The tone
plays when listening actually starts, not at the press.

Microphone permission is the one thing a page cannot grant itself. First
decided: the hub pre-grants it by writing the browser's per-user
audio-capture allow-list policy. AMENDED 10/28 after the VM run: that key
(`HKCU\Software\Policies\...`) is admin-protected and the hub runs
unelevated ("Access is denied"), so the hub does not write it. The mechanism
is the browser profile remembering the grant from the first touch on Chat's
microphone control; that one touch is a rollout step per device (the home
I-13 already has it from Chat use). If permission is still missing when a
press arrives, Chat shows one plain line
naming its touch-only control ("Touch Try again once to allow the
microphone" since v1.0.31, where Chat gets ready by itself and has no Start
Chat), plays no tone, and the press is otherwise wasted; after that one
touch, presses work. The builder
verifies the kiosk profile keeps the grant across restarts.

### 4.4 The listening window

The window needs the **streaming recogniser** (the per-device stream
settings the real-time chat design introduced): utterance ends, choices on
the whole window text and replacement batches all ride on it. The window
state machine lives in the hub, where end-of-turn, the silence fallback and
the second press all arrive. On a device without stream settings a press
still opens Chat, which shows "Streaming speech is not set up on this
device" and plays no tone; delivering the stream settings to the tablet and
the school device is a rollout step (configuration, no code).

A press opens a **window**. Inside it, speech is cut into utterances; each
utterance that sounds complete is sent for choices and becomes a batch.

- **Listening.** Frames stream to the recogniser as during a hold today.
  Partials drive speculation as today.
- **Utterance end.** The question "feels complete" when the recogniser's
  end-of-turn arrives, or, if the provider gives none, when the local speech
  activity model reports silence for **1.5 s** after speech. Either seals the
  utterance: its final text joins the window's text so far, and a choice
  request runs on the **whole window text** ("do you want chicken or fish, or
  pasta"), so later words can modify earlier choices. One utterance is capped
  at 15 s as today: at the cap it is sealed and listening continues.
- **Still listening.** After a batch seals, the microphone stays open.
- **The window closes** on the first of: her **pick** of a tile; a **second
  press**; **10 s of silence** after the last sealed utterance; **60 s** since
  the press. Closing plays a short done tone, closes the microphone, and
  leaves Chat in its ready state with the last batch showing (a pick speaks
  it, as today).
- **Nothing said.** No speech within 10 s of the press: the window closes,
  nothing is submitted, Chat shows "Didn't hear a question" for a few seconds.
- **Cancel** (a 1 s hold) discards the window and any staged batch.
- The window's text, its batches and its timings go to the turn log like a
  hold does.

### 4.5 Replacement batches without moving under her

Today a shown batch is immutable and cannot be replaced until a new turn.
This design adds a **replacement batch** inside one window, with these rules:

- A sealed batch is still immutable; a replacement is a new sealed batch.
- The first batch is revealed by Chat's current rule. AMENDED 10/28 at the
  merge of v1.0.26–v1.0.31: replies show the moment the batch is sealed,
  behind the 250 ms page-settle dwell pause, replacing any tiles left from an
  earlier turn; the "fresh move into the black centre" rule is gone from Chat.
- A replacement is swapped in only at a **neutral moment**: her gaze is in a
  black rest cell, or is not inside any tile and no dwell is in progress. If
  her gaze is on a tile, the replacement waits until it leaves. There is no
  upper bound on the wait; it is the tile that holds still.
- **Position stability.** A choice whose label is unchanged keeps its cell;
  new choices take free cells; removed choices leave their cells empty until
  the next replacement. So chicken and fish stay put when pasta arrives.
- **A pick wins.** Her selection of any shown tile speaks it, closes the
  window and discards any pending replacement.
- At most one replacement is pending; a newer one supersedes it unseen.

### 4.6 What the partner hears and sees

- A short listening tone when listening starts and a short done tone when
  the window closes. These are the hub's own sounds, distinct from the dwell
  chime (which the apps keep off), quiet, under half a second. Nothing is
  spoken during a window.
- The Chat page shows "Listening", then its usual choice states. Settings →
  Connections → **Buttons** shows: listener running or not, which keys it
  holds, the last press (time and key), and a one-line setup note for the
  Flic app mapping and the Square button.

### 4.7 Three buttons, three devices

Bluetooth pairing is per device: each Flic pairs to one. The same build runs
everywhere; the listener and the hotkeys are identical. Nothing is shared
through Drive. The two spare Flics may be paired to the tablet and parked for
school.

### 4.8 Tests, gate and release

- Unit: the window state machine (utterance end, 10 s silence, 60 s cap,
  second press, cancel, pick wins, nothing said); the replacement neutral
  rule and position stability; `/buttons/press` loopback gating, 409 when
  Chat is off, nonce consumed once; the listener source is in the payload and
  the payload still ships no `.ps1`.
- Browser (Playwright with the fake audio device, as the Chat suites do): an
  `ask` push starts a session with no touch, a question with a pause inside
  it stays one utterance, a second utterance replaces the batch only after a
  neutral move, a pick during a pending replacement wins, the done tone
  fires, the hold path is unchanged.
- Windows (tests-vm, quiet profile): the listener compiles, registers its
  keys, and an injected F13 reaches `/buttons/press`; a Ctrl+Alt+F9 does the
  same; the kiosk relaunch lands on `/chat/`.
- New suites are registered in `tools/testing/registry.json`.
- Release shape: patch (no installer change). Rollout: home I-13 with the
  first Flic, dad confirms the moment in §1, then tablet, then school.

## 5. Left to the builder

- Which end-of-turn signal to prefer per provider and how the 1.5 s local
  silence fallback is measured (the speech activity model already gates what
  is sent).
- The exact kiosk relaunch mechanics and how the new window is foregrounded;
  the nonce format.
- How the listener is supervised (reuse the gaze supervisor's shape or a
  simpler restart) and how its state reaches `/status` and Settings.
- The policy keys for the microphone grant and the verification that the
  kiosk profile keeps it.
- Tone design, Settings copy, the setup note's wording.
- Turn-log stage names for the press, the tone, each seal and each swap.

## 6. Calls made here (dad can overrule)

- After a pick the device stays in Chat; her exit door returns her to TD Snap
  as in every app. The press does not remember where she was.
- Hold (1 s) is cancel; double click does nothing, so a click is never
  delayed.
- F13 / F14 for the Flic (fallback Ctrl+Alt+F10 / F11), Ctrl+Alt+F9 for the
  Square button, fixed; the listener holds all five.
- The window needs the streaming recogniser; the rollout delivers its
  settings to the tablet and school rather than building a second path.
- A hidden Chat page is foregrounded (3 s) before the hub resorts to a
  relaunch.
- 1.5 s utterance silence, 10 s window silence, 60 s window cap, 15 s
  utterance cap.
- A press while Chat is off does nothing rather than enabling Chat.
- Removed choices leave empty cells rather than reflowing the grid.
