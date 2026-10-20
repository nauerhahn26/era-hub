# Self-update cadence — Implementation Plan

> **For agentic workers:** REQUIRED WORKFLOW: one fresh-context builder, the overseer reviews. Steps use `- [ ]` checkboxes. TDD: each test is written and SEEN red before the code.

**Goal:** the installed hub updates itself inside a 20-minute awake window and within about a minute of waking from sleep, with no help from outside and no extra cost when nothing is new — and the restart that completes an update never lands while Ellie is using the board (spec §4.4).

**Spec:** `docs/specs/2026-10-20-update-cadence-design.md`. Preflight (overseer, 10/20): `update.js start()` is the only scheduling entry and already carries the `ERA_UPDATE_BOOT_MS` seam and the `inFlight` guard; `tests/update-boot.test.mjs` boots a real install on 8423 with a fake feed on 8424 and ends with the hub serving `NEW_BUILD` — the cadence case slots after it; `ERA_WEATHER_RETRY_MS` shows where seams are closed (`tools/era-gate.sh`) and listed (the seam-parity test).

**Architecture:** `update.js` gains `EVERY_MS` (30 min, `ERA_UPDATE_EVERY_MS`), a 30-s heartbeat with the pure `wokeUp()` decision and a single delayed wake check; `runCheck()` splits into stage (download, verify, extract to `.update-staged/`) and apply (overlay + restart, only when quiet or forced, and at boot when a staged build waits); `server.js` stamps `lastInteractionAt` on user-driven requests, exposes it to the updater, adds `idleMs` to `/version`, and passes `force` from the manual POST route. `scheduleRestart()`, the loopback rule and the pack filter are untouched.

**Tech stack:** Node 22 hub (no deps), `node --test` from `~/new-era/node_modules`.

**Worktree:** `~/new-era/era-hub--wt-update-cadence` on `fix/update-cadence`, synced to master `7e6a98f`. Never edit the main checkout. Gate: `bash tools/era-gate.sh` from the worktree under `setsid nohup` (it outruns the 10-minute tool ceiling), sentinel file + background wait.

**Discipline:** TDD. No "while I'm here". STOP and report instead of improvising when: a test outside this plan starts failing; an assertion would have to be weakened; the change would touch the wizard gate, the restart path, the loopback rule or the pack filter; a new port looks necessary (8423/8424 are this suite's; a pure unit test needs none); more than two new seams look necessary.

**Commits:** house style `<area>: <what> — <why> (spec 2026-10-20 §N)`; vendor-neutral wording (no AI vendor or model names anywhere); author is the user, NO Co-Authored-By and NO session trailers. `git add` exact paths, never `-A`. The pre-commit scan runs: no family names but Ellie, no infra terms, no IPs but loopback, no towns.

---

## Task Skeleton

### Phase 1: the cadence (spec §4.1, §5)
**Posture hint:** implementing

1. [x] **Periodic check every 30 min, test first** — `tests/update-boot.test.mjs`, `update.js`
   - **Acceptance:** with `ERA_UPDATE_EVERY_MS` small (hundreds of ms) the third case publishes `NEWER_BUILD` on the fake feed after the second case and, with no POST, `/version` serves `NEWER_BUILD` from a new pid within ~20 intervals; the first two cases are unchanged and green; the default interval in `update.js` is 30 minutes and the 6-hour literal is gone.
   - **Tests to write first (red):** the third case (the feed handler serves a mutable `latest`/tarball; the hub's env in `before` gains `ERA_UPDATE_EVERY_MS`). Run `node --test tests/update-boot.test.mjs` → the new case fails (the hub never updates without a POST because 6 h never elapses).
   - **Verification:** `node --test tests/update-boot.test.mjs` → 3 pass. Check `ss -ltn` shows 8423/8424 free before running.
   - **Guardrails:** the interval tick stays gated by `ready()`; `inFlight` unchanged.

2. [x] **Wake detection, test first** — `update.js` (`wokeUp`, heartbeat, delayed wake check), `tests/update-wake.test.mjs` (pure, no ports)
   - **Acceptance:** `wokeUp(prev, now, hb, gap)` is exported; false when `now - prev <= hb + gap`; true above; true for `now < prev` (clock went backwards); the heartbeat in `start()` calls it every `HEARTBEAT_MS` and on true schedules exactly one `check()` after `WAKE_DELAY_MS` (20 s), gated by `ready()`, with a log line `[update] wake check: <status>` when not up-to-date; a second wake while one wake check is pending does not schedule another.
   - **Tests to write first (red):** the unit test file importing `wokeUp` from `../update.js` (fails: not exported).
   - **Verification:** `node --test tests/update-wake.test.mjs tests/update-boot.test.mjs tests/update.test.mjs` → all pass.
   - **Guardrails:** timers `.unref()` like the existing ones; `WAKE_DELAY_MS` and `HEARTBEAT_MS` need no seams unless an integration test drives them — prefer none.

3. [x] **Seams closed and listed** — `tools/era-gate.sh`, the seam-parity test
   - **Acceptance:** every new `ERA_UPDATE_*` seam is in the gate's close list and in the parity test's list; the parity test passes.
   - **Verification:** `grep -n ERA_UPDATE_EVERY_MS tools/era-gate.sh tests/*.mjs`; run the parity suite alone.

4. [x] **Stage, then apply when quiet (spec §4.4), test first** — `update.js`, `server.js`, `tests/update-boot.test.mjs` (+ a boot-applies-staged case)
   - **Acceptance:** (a) `server.js` stamps `lastInteractionAt` for every POST except `/update/check`, `/kiosk/resume`, `/kiosk/close`, and for GET `/tts*` and `/predict*`; `/version` carries `idleMs` (null before any interaction). (b) `runCheck()` stages into `<HERE>/.update-staged/<build>` and applies only when `idleMs >= QUIET_MS` (`ERA_UPDATE_QUIET_MS`, default 90 s) or when called with `force` (the manual POST route passes `force: true`); when it defers it answers `{status:"staged", build, idleMs}` and arms one 15-s timer that applies as soon as quiet; a second check while staged does not re-download (same build already staged) and does not arm a second timer. (c) On boot, a staged build newer than `VERSION` is applied before the server listens (overlay + continue, no restart needed, or restart — builder's call, documented). (d) Logs: `[update] staged <build>` and the existing `->` line on apply. (e) The 2026-10-19 Startup link / wizard gate behaviour is untouched; `ready()` still gates the automatic paths.
   - **Tests to write first (red):** in `update-boot.test.mjs`: a case that keeps POSTing `/log` every 300 ms while a newer build is published, asserts after several intervals that the hub still serves the old build and the staged dir exists, stops posting, then sees the new build from a new pid within `ERA_UPDATE_QUIET_MS` (set to ~1500 ms) + a few ticks; `idleMs` assertions; a boot-with-staged case. Ensure the existing manual-POST case in `tests/update.test.mjs` still updates immediately (force).
   - **Verification:** `node --test tests/update-boot.test.mjs tests/update.test.mjs tests/update-wake.test.mjs tests/settings-ui.test.mjs tests/routes.test.mjs` → all pass (routes/settings suites pin `/version`'s shape — extend, never break).
   - **Guardrails:** never overlay into the live tree from the stage path except in apply; never apply with the wizard unanswered (automatic paths) — the manual POST is the one exception as today; the staging dir is removed after apply and on a bad checksum; disk full → `{status:"stage-error"}`, nothing half-written in the live tree.

5. [x] **Presence beacon + `/presence` receiver (spec §4.5), test first** — `server.js` (route, hook spawn, `beaconUrl` setting), `update.js` or a small `beacon.js` (sender), `tests/presence.test.mjs`
   - **Acceptance:** with `beaconUrl` set the hub sends `boot` after listening, `wake` from the §4.2 detector, `alive` every `ERA_BEACON_MS` (seam; default 5 min), `idle` once per idle stretch after `ERA_BEACON_IDLE_MS` (default 5 min) of BOTH no interaction and no change to any file in the `idleWatchFiles` setting (stat every 30 s; missing file = idle; the body's idleMs is the smaller of the two); 5-s timeout, one in flight, one log line per failure class; the receiver writes `<DATA>/presence/<id>.json`, appends a pool event, spawns `ERA_PRESENCE_HOOK <id> <event>` detached when set; id/body validation → 400; `GET /presence` lists; unset `beaconUrl` → no sender timer at all.
   - **Tests to write first (red):** `tests/presence.test.mjs` on a NEW port pair chosen after grepping `tests/` of era-hub, era-board, era-core, era-pencil, era-making-words and era-gaze for the number (the port memory: the suite band has holes; never 8377/8378/8425/8427/8450-8462/8463/8464/8471-8474); the parity test lists `ERA_BEACON_MS` and `ERA_BEACON_IDLE_MS`; idle-beacon cases: fires once after the last `/log`, not again until a new `/log`, postponed by touching a watched file.
   - **Verification:** `node --test tests/presence.test.mjs tests/routes.test.mjs tests/settings-ui.test.mjs` → pass; `grep -n ERA_BEACON_MS tools/era-gate.sh`.
   - **Guardrails:** no address or host name anywhere in code, tests or docs (loopback only); the setting has no default; the hook is spawned with `windowsHide` and `detached`, never awaited; the route never reads the hook output.

### Phase 2: gate, land, release (overseer)
**Posture hint:** implementing

4. [ ] **Full gate in the worktree** — `== era-gate: N passed, 0 failed ==`, N ≥ 125 (two new suites); green stamp for this tree.
5. [ ] **Land** — `bash ~/aac-board-builder/tools/worktree.sh land /home/ai/new-era/era-hub update-cadence`.
6. [ ] **Patch release (on dad's word)** — `qa.sh up` → `qa-template-repair.py` → `release.sh v1.0.6 --patch --skip-gate` (stamp < 2 h) from the main checkout under `setsid nohup`, `USER` exported.

### Phase 3 (final): Behavioral verification on a real device
**Posture hint:** implementing (overseer; read-only on the device except the self-update POST)

7. [ ] **Home i13 on v1.0.6, then a later patch lands by the hub alone, quietly** — after the next release after v1.0.6 is published, do NOT POST; within 30 minutes `/version` on the home i13 shows the new build and hub.log carries `[update] ... restarting` with no preceding `/update/check` request. (Until then: hub.log shows no `[update]` errors; `/version.idleMs` on the tablet climbs while nobody touches it and resets on a tap.) Also: while the board is in active use (tap every few seconds by hand), a published build STAGES and does not restart until the taps stop.
8. [ ] **School i13** — the next time it appears, `/version` shows ≥ v1.0.6 (delivered by the ops nudge); the following release reaches it inside its first awake window with no nudge in the ops log.
9. [ ] **Operator side (ops repo, separate worker):** school board-sync idle gate 15 → 5 min with the pixel gates unchanged (dad 10/20: "5 min is right to check if TD Snap is on screen and try"); the watcher treats a fresh `presence/school.json` as online; a hook script kicks the queue on a beacon and, on an `idle` beacon, runs board-sync at once in priority mode (the device certified idle; pixel gates stay); a queued job sets `beaconUrl` on the school hub once it serves ≥ v1.0.6; the end-of-day mail reads presence too; runbook updated. Dad restarts the operator hub on the new build by hand.
10. [ ] **Docs + memory** — status doc entry, memory note, this plan ticked.

---

## Phase retrospectives

## Outbox
### Follow-ups
- [ ] The school device's own sleep timer (10 min on battery) and the wake-window task are device-runbook matters; the ops probe armed 10/19 is collecting evidence on whether the wake task fires.
