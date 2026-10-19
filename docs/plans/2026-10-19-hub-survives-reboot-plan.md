# The hub survives a reboot — Implementation Plan

> **For agentic workers:** REQUIRED WORKFLOW: subagent-driven development (one fresh-context builder per task, the overseer reviews between tasks). Steps use `- [ ]` checkboxes. TDD on every task: the test is written and SEEN red before the code.

**Goal:** After any reboot of a family device, the hub is back within a minute of her logon with nobody touching a tile, quietly (no page, no window), and a weather answer served from the stored week keeps being retried until a live forecast lands.

**Spec:** `docs/specs/2026-10-19-hub-survives-reboot-design.md` (commit `4fae161`). Part A = §4 (the logon start), Part B = §5 (stale-week weather is still blind). Preflight (a reviewer read the spec against the code, 10/19) found and the spec now carries: the launcher branch sits after `:open`; the Startup link has two write sites (boot pass + the wizard's home-door script); the shortcuts test's home-door filter must exclude `Startup\`; Part B's tests live in `tests/weather-location.test.mjs` because only that suite fakes BOTH providers.

**Architecture:** Three files carry the change. `tools/build-payload.sh` (the `start-hub.bat` heredoc) gains a `--hub-only` branch. `shortcuts.js` lays `Startup\Our Era Comms.lnk` → `start-hub.bat <port> --hub-only` from both the boot pass and the home-door script. `clothing-worker.js weather()` marks a rung-3 answer `stale`, the build result reports `weatherStale`, and `clothing.js` treats it like `weatherless` for the 14-minute retry. The VM legs A and B assert the link on the guest.

**Tech stack:** Node 22 hub (no deps), `node --test` from `~/new-era/node_modules`; batch text pinned by static tests; PowerShell only from Node (never from the payload).

**Worktree:** `~/new-era/era-hub--wt-weather` on `fix/weather`, synced to master `c99501a`. Never edit the main checkout. Gate: `bash tools/era-gate.sh` from the worktree under `setsid nohup` (it outruns the 10-minute tool ceiling), sentinel file + Monitor.

**Discipline:** TDD every task. A fresh builder per task. No "while I'm here". STOP and report instead of improvising when: a test outside this plan starts failing; an assertion would have to be weakened; the change would need PowerShell in the payload; the launcher change would move or alter the kiosk line, the wmic line or the `/kiosk/resume` POST; the weather change would alter the band thresholds, the rung order or the footnote; a new seam or port looks necessary.

**Commits:** house style `<area>: <what> — <why> (spec 2026-10-19 §N)`; vendor-neutral wording (no AI vendor or model names anywhere in code, docs or messages); author is the user, NO Co-Authored-By and NO session trailers. `git add` exact paths, never `-A`. The pre-commit era-scan runs: no family names but Ellie, no infra terms, no IPs but loopback, no towns.

---

## Task Skeleton

### Phase 1: the launcher (Part A, §4.1)
**Posture hint:** implementing

1. [x] **`start-hub.bat --hub-only`** — `tools/build-payload.sh` heredoc + `tests/start-hub-bat.test.mjs`
   - **Acceptance:** With `--hub-only` as the second argument the file runs the already-running guard and (if needed) the node start, reaches `:open`, and jumps to `:done` BEFORE the `/kiosk/resume` curl; it never reaches the wmic line or the `--kiosk` line. Without the flag the file is byte-for-byte what it was (diff shows only the new lines). No PowerShell anywhere in the payload.
   - **Tests to write first (red):** the hub-only branch exists between the `:open` label and the first `curl … /kiosk/resume`; it jumps to `:done`; the existing kiosk/wmic/PowerShell laws still pass; `%~2` is compared with the exact token (the test pins the token).
   - **Verification:** `node --test tests/start-hub-bat.test.mjs` → all pass; `bash -n tools/build-payload.sh`; `grep -c -- "--hub-only" tools/build-payload.sh` ≥ 2 (branch + a rem line explaining why).
   - **Guardrails:** cmd quirks the file already documents (no `%` in `rem` lines; `%~2` strips quotes); keep the two-line comment style of the file.
   - **Gate:** overseer reads the diff of the heredoc.

### Phase 2: the Startup link (Part A, §4.2)
**Posture hint:** implementing

2. [x] **`shortcuts.js` lays `Startup\<homeTitle>.lnk`** from both write sites + `tests/shortcuts.test.mjs`
   - **Acceptance:** (a) `reconcileShortcuts` dry-run plan has exactly one `Startup\Our Era Comms.lnk` write with target `<dir>\start-hub.bat`; the returned script sets that link's `Arguments` to `'<port> --hub-only'`, `WorkingDirectory` `<dir>`, the suite icon, `WindowStyle = 7`. (b) The home door still has exactly `Desktop` + `StartMenu\Programs` (the test's filter now excludes `Startup\`). (c) `shortcutScript(home, true)` — the wizard path — also writes the Startup hub link; `shortcutScript(home, false)` removes it. (d) One PowerShell per boot pass; nothing runs off Windows; the old-name deletion set is unchanged; the plan count rises by one and `server.js`'s log line needs no change.
   - **Tests to write first (red):** the four acceptance points above, plus the existing apostrophe-balance test still passes with the new arguments.
   - **Verification:** `node --test tests/shortcuts.test.mjs tests/apps.test.mjs` → all pass.
   - **Guardrails:** the hub link is a third kind of owned entry (not a change to what `exe`/page-app mean); keep `dirsFor()`'s meaning for apps; the title is `homeTitle` (so a rename sweeps it like the home door).
   - **Gate:** overseer reads the diff; `/reviewing` against §4.2.

3. [x] **VM legs assert the link** — `tests-vm/leg-a-fresh.e2e.mjs`, `tests-vm/leg-b-update.e2e.mjs`
   - **Acceptance:** after leg A's wizard and after leg B's self-update, the guest's `Startup\Our Era Comms.lnk` exists and its `TargetPath` ends with `start-hub.bat` and `Arguments` contains `--hub-only` (read the way leg A already reads .lnk files via PowerShell on the guest). A missing or wrong link fails the leg.
   - **Verification:** `node --check` on both files; the legs run for real only inside `release.sh` (VM); a dry read of the new assertion against the existing helper's shape by the overseer.
   - **Guardrails:** mirror the existing .lnk read helper exactly; no new guest-side tooling.
   - **Gate:** overseer reads the diff. (The real proof is the release's VM run.)

### Phase 3: stale-week weather is still blind (Part B, §5)
**Posture hint:** implementing

4. [x] **`weather()` marks rung 3, the shell keeps retrying** — `clothing-worker.js`, `clothing.js`, `tests/weather-location.test.mjs`, spec §7.3 note in `docs/specs/2026-09-23-weather-location-design.md`
   - **Acceptance:** (a) a rung-3 answer (both providers failed, the store covers today) carries `stale: true`; a provider answer or an under-3-h store does not. (b) The build result reports `weatherStale: true` when the deal used a stale answer; a `weatherRetry` build that gets a stale answer again returns `{ rebuildOnly: true, weatherStale: true, retried: true }` and redraws nothing. (c) `clothing.js` sets `weatherBlind` on `weatherless` OR `weatherStale`, so the existing 14-minute retry (`ERA_WEATHER_RETRY_MS`) walks the ladder; when a provider answers, the retry re-deals, the store is rewritten and the flag clears. (d) The footnote, the bands, the rung order and the §7.3 spacing law are untouched.
   - **Tests to write first (red):** in `tests/weather-location.test.mjs` next to the existing "both fail, the store covers today" case: the result reports `weatherStale`; with `ERA_WEATHER_RETRY_MS=0` a following tick re-walks the ladder (the fake providers count calls); providers restored → the next tick re-deals on fresh numbers and a further tick does nothing; an under-3-h store is served with zero provider calls and is not stale.
   - **Verification:** `node --test tests/weather-location.test.mjs tests/clothing-weather.test.mjs tests/clothing.test.mjs tests/clothing-accessories.test.mjs` → all pass.
   - **Guardrails:** no new seam; port stays 8401; keep the `[clothing] weather: …` log lines (the rung-3 line already names the fetch time); spec §7.3 gets a dated two-line amendment, not a rewrite.
   - **Gate:** `/reviewing` against §5.

### Phase 4: gate, land, release (overseer)
**Posture hint:** implementing

5. [ ] **Full gate in the worktree** — `setsid nohup bash tools/era-gate.sh > <scratch>/gate-reboot.log 2>&1; echo $? > <scratch>/gate-reboot.log.done`, pid captured, Monitor on the sentinel
   - **Acceptance:** `== era-gate: N passed, 0 failed ==` with N ≥ 123; a green stamp for this tree under `/tmp/era-gate-green/`.
   - **Verification:** `tail -3 <scratch>/gate-reboot.log`; a single-suite flake is re-run alone once and the gate re-run if it was a flake.
6. [ ] **Land** — `bash ~/aac-board-builder/tools/worktree.sh land /home/ai/new-era/era-hub weather`
   - **Acceptance:** master fast-forwards to the land commit; `git log origin/master -1` shows it after push.
7. [ ] **Patch release (on dad's word)** — `bash tools/release.sh v1.0.5 --patch` from the main checkout under `setsid nohup`, stamp < 2 h
   - **Acceptance:** VM leg B 5/5 including the new Startup assertion; `RELEASED: v1.0.5`.

### Phase 5 (final): Behavioral verification on a real device
**Posture hint:** implementing (overseer, read-only on the device except the self-update POST)

8. [ ] **Tablet and home i13 on v1.0.5, link laid in HER profile**
   - **Verification:** `ssh <dev> 'curl.exe -s -X POST http://127.0.0.1:8377/update/check'` → `{"status":"updated",…,"version":"v1.0.5"}`; then `/version` shows the new build. Read `C:\Users\<her>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Our Era Comms.lnk` via PowerShell on the device: TargetPath `…\Our Era Comms\start-hub.bat`, Arguments `8377 --hub-only`, WorkingDirectory the install folder. Confirm the hub's node process owner is her account (`Get-CimInstance Win32_Process | GetOwner`).
   - **Expected:** link present with those values; owner = her account; hub log shows `[apps] shortcuts reconciled (N+1 links)` for the restarted hub.
9. [ ] **Hub-only run by hand while the hub is up (tablet)**
   - **Verification:** `ssh tablet 'cmd /c ""C:\Users\<her>\AppData\Local\Our Era Comms\start-hub.bat" 8377 --hub-only"'` → exits within ~3 s; `/version` pid unchanged; no new msedge kiosk process (`Get-Process msedge` count unchanged); hub log gains no `[kiosk]` line.
   - **Expected:** exactly that. (A true reboot is dad's to schedule; this plus the VM legs is the proof.)
10. [ ] **Docs + memory** — status doc entry in `aac-board-builder/docs/status.md`, memory note; the plan's checkboxes ticked.

---

## Phase retrospectives
- Phases 1-3 (10/19): built by two builders in parallel on disjoint files; commits 8c11082, e9ed4ba, 011959c, 2022ec7. Surprises: a bare `[Environment]::GetFolderPath(...)` inside `Join-Path` is a string in PowerShell argument mode, not a call — the folder expression needs its own parentheses (pinned by a test); the launcher test selects the kiosk and resume lines by their first match, so new comments must not contain `--kiosk` or `/kiosk/resume`; the VM legs assert the exact arguments `8377 --hub-only` and poll up to 120 s because the link is written in the background. The tick log reason became "no fresh weather" to cover a stale board.

## Outbox
### Follow-ups
- [ ] Windows auto-logon on each device (device runbook, not code) — without it the hub starts at the first logon, which still precedes any tile tap.
- [ ] The school i13 receives this through its queued update like every patch; its hub currently runs in her session (10/15 memory), so the link lands in the right profile.
