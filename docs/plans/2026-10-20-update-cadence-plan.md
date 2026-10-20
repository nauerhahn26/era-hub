# Self-update cadence — Implementation Plan

> **For agentic workers:** REQUIRED WORKFLOW: one fresh-context builder, the overseer reviews. Steps use `- [ ]` checkboxes. TDD: each test is written and SEEN red before the code.

**Goal:** the installed hub updates itself inside a 20-minute awake window and within about a minute of waking from sleep, with no help from outside and no extra cost when nothing is new.

**Spec:** `docs/specs/2026-10-20-update-cadence-design.md`. Preflight (overseer, 10/20): `update.js start()` is the only scheduling entry and already carries the `ERA_UPDATE_BOOT_MS` seam and the `inFlight` guard; `tests/update-boot.test.mjs` boots a real install on 8423 with a fake feed on 8424 and ends with the hub serving `NEW_BUILD` — the cadence case slots after it; `ERA_WEATHER_RETRY_MS` shows where seams are closed (`tools/era-gate.sh`) and listed (the seam-parity test).

**Architecture:** `update.js` gains `EVERY_MS` (30 min, `ERA_UPDATE_EVERY_MS`), a 30-s heartbeat with the pure `wokeUp()` decision and a single delayed wake check; `start()` wires both under the existing `ready()` gate. No change to `check()`, `runCheck()`, `scheduleRestart()`, `server.js` or the POST route.

**Tech stack:** Node 22 hub (no deps), `node --test` from `~/new-era/node_modules`.

**Worktree:** `~/new-era/era-hub--wt-update-cadence` on `fix/update-cadence`, synced to master `7e6a98f`. Never edit the main checkout. Gate: `bash tools/era-gate.sh` from the worktree under `setsid nohup` (it outruns the 10-minute tool ceiling), sentinel file + background wait.

**Discipline:** TDD. No "while I'm here". STOP and report instead of improvising when: a test outside this plan starts failing; an assertion would have to be weakened; the change would touch the wizard gate, the restart path, the loopback rule or the pack filter; a new port looks necessary (8423/8424 are this suite's; a pure unit test needs none); more than two new seams look necessary.

**Commits:** house style `<area>: <what> — <why> (spec 2026-10-20 §N)`; vendor-neutral wording (no AI vendor or model names anywhere); author is the user, NO Co-Authored-By and NO session trailers. `git add` exact paths, never `-A`. The pre-commit scan runs: no family names but Ellie, no infra terms, no IPs but loopback, no towns.

---

## Task Skeleton

### Phase 1: the cadence (spec §4.1, §5)
**Posture hint:** implementing

1. [ ] **Periodic check every 30 min, test first** — `tests/update-boot.test.mjs`, `update.js`
   - **Acceptance:** with `ERA_UPDATE_EVERY_MS` small (hundreds of ms) the third case publishes `NEWER_BUILD` on the fake feed after the second case and, with no POST, `/version` serves `NEWER_BUILD` from a new pid within ~20 intervals; the first two cases are unchanged and green; the default interval in `update.js` is 30 minutes and the 6-hour literal is gone.
   - **Tests to write first (red):** the third case (the feed handler serves a mutable `latest`/tarball; the hub's env in `before` gains `ERA_UPDATE_EVERY_MS`). Run `node --test tests/update-boot.test.mjs` → the new case fails (the hub never updates without a POST because 6 h never elapses).
   - **Verification:** `node --test tests/update-boot.test.mjs` → 3 pass. Check `ss -ltn` shows 8423/8424 free before running.
   - **Guardrails:** the interval tick stays gated by `ready()`; `inFlight` unchanged.

2. [ ] **Wake detection, test first** — `update.js` (`wokeUp`, heartbeat, delayed wake check), `tests/update-wake.test.mjs` (pure, no ports)
   - **Acceptance:** `wokeUp(prev, now, hb, gap)` is exported; false when `now - prev <= hb + gap`; true above; true for `now < prev` (clock went backwards); the heartbeat in `start()` calls it every `HEARTBEAT_MS` and on true schedules exactly one `check()` after `WAKE_DELAY_MS` (20 s), gated by `ready()`, with a log line `[update] wake check: <status>` when not up-to-date; a second wake while one wake check is pending does not schedule another.
   - **Tests to write first (red):** the unit test file importing `wokeUp` from `../update.js` (fails: not exported).
   - **Verification:** `node --test tests/update-wake.test.mjs tests/update-boot.test.mjs tests/update.test.mjs` → all pass.
   - **Guardrails:** timers `.unref()` like the existing ones; `WAKE_DELAY_MS` and `HEARTBEAT_MS` need no seams unless an integration test drives them — prefer none.

3. [ ] **Seams closed and listed** — `tools/era-gate.sh`, the seam-parity test
   - **Acceptance:** every new `ERA_UPDATE_*` seam is in the gate's close list and in the parity test's list; the parity test passes.
   - **Verification:** `grep -n ERA_UPDATE_EVERY_MS tools/era-gate.sh tests/*.mjs`; run the parity suite alone.

### Phase 2: gate, land, release (overseer)
**Posture hint:** implementing

4. [ ] **Full gate in the worktree** — `== era-gate: N passed, 0 failed ==`, N ≥ 124 (one new suite); green stamp for this tree.
5. [ ] **Land** — `bash ~/aac-board-builder/tools/worktree.sh land /home/ai/new-era/era-hub update-cadence`.
6. [ ] **Patch release (on dad's word)** — `qa.sh up` → `qa-template-repair.py` → `release.sh v1.0.6 --patch --skip-gate` (stamp < 2 h) from the main checkout under `setsid nohup`, `USER` exported.

### Phase 3 (final): Behavioral verification on a real device
**Posture hint:** implementing (overseer; read-only on the device except the self-update POST)

7. [ ] **Home i13 on v1.0.6, then a later patch lands by the hub alone** — after the next release after v1.0.6 is published, do NOT POST; within 30 minutes `/version` on the home i13 shows the new build and hub.log carries `[update] ... restarting` with no preceding `/update/check` request. (Until then: hub.log shows no `[update]` errors every 30 min; the interval is visible as the hub's `latest.json` requests in the fake-feed test only.)
8. [ ] **School i13** — the next time it appears, `/version` shows ≥ v1.0.6 (delivered by the ops nudge); the following release reaches it inside its first awake window with no nudge in the ops log.
9. [ ] **Docs + memory** — status doc entry, memory note, this plan ticked.

---

## Phase retrospectives

## Outbox
### Follow-ups
- [ ] The school device's own sleep timer (10 min on battery) and the wake-window task are device-runbook matters; the ops probe armed 10/19 is collecting evidence on whether the wake task fires.
