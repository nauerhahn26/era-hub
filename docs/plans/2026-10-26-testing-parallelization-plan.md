# Testing parallelization plan

Design: `docs/specs/2026-10-26-testing-parallelization-design.md`. Status:
PROPOSED 2026-10-26, revised after adversarial review the same day, nothing
built, awaiting dad's six decisions (spec §8). Owner: this worktree
(`era-hub--wt-testing-parallelization`). Agents write all code and tests, test
first; the overseer scopes and reviews. Phase 3 depends on phase 2 (it
consumes `results.jsonl`); phase 1 is landable through today's serial gate
without touching any pinned test.

## Ground truth the plan rests on (measured 2026-10-26)

- Gate: 156 suites, 2120 s of suite time, 2131 s wall, serial, one shared hub;
  harness overhead about 12 s.
- Longest-first model with the solo and heavy constraints: 2 lanes 18.8 min,
  3 lanes 13.1 min, 4 lanes 10.2 min; at 1.3x per-suite inflation 24 / 17 / 13.
- Host: 4 CPUs, a gate uses about one core; 7.9 GB RAM; with one serial gate
  `MemAvailable` fell to 2.2 to 3.3 GiB across 11 jobs; 3.2 GB swap in use by
  resident agent sessions; one gate's tree peaks at 1.2 to 1.5 GiB.
- 35 suites use the shared hub, all read-only in practice; 3 fixed-port
  collisions; 3 suites use `pkill -f`; the isolated runner's `pkill` is
  namespace-scoped and stays.
- 22 full gates in the last release window, 7 red for fixture defects, 0
  product bugs caught by Linux gates; about 5.7 h of gates traced to fixtures;
  4 of the 7 reds were single-suite races a retry would have passed.
- Agent sessions spent 24 to 35 % of main-thread input tokens watching gates.
- Since this worktree opened, 8 of 11 landings touched non-test, non-doc
  files; reuse is for recoveries, not for ordinary landings.

## Phase 0: measure, sync, clear the ground (one day)

- [ ] 0.1 Land or sync `era-hub--wt-era-gaze-launcher` (unmerged edits to
      `registry.json`, `server.js`, `docs/dev-flow.md`), then `worktree.sh sync`
      this worktree to master (26+ commits behind).
- [ ] 0.2 Close `feat/testing-suite` as superseded (its gate tooling reached
      master through the rollout; its branch carries unpublished Chat source
      and is never landed) and close the stale worktrees from outside them:
      testing-suite-rollout, windows-parallel, chat, games, games-save,
      games-g2, math, weekly-runs, pictures (all behind master with no unique
      commits, or superseded). Open an `aac-board-builder` worktree for the
      house-repo edits in 2.6, 3.8, 3.10 and 4.3.
- [ ] 0.3 Harvest durations: `tools/testing/harvest-durations.mjs` reads
      `# duration_ms` from the `.out` files of the last green runs (job
      workspaces under `~/.local/state/era-parallel-gates/jobs/*/workspace/era-hub/gate/`
      and the rollout gate dir; legacy scripts by mtime gap) and writes
      `tools/testing/durations.json` (median, sample count; mean for unknown
      suites). After phase 2 it reads `results.jsonl` instead; refreshed on
      every green master gate, committed weekly. Test: a synthetic gate dir
      yields the expected table.
- [ ] 0.4 Memory profile: one instrumented serial run (`ERA_GATE_LANES=1`, a
      sampler recording tree RSS per running suite) to learn the per-suite
      peak; record the ten heaviest here. Expected: the clothing family
      (wasm), board suites with 13 to 15 Chromium launches, drawing-ui,
      play-ui. This number decides whether 3 lanes is ever on the table.
- [ ] 0.5 Record the baseline here: three serial gates' wall times from the
      job store (2131, 2056, 2033 s), host memory figures, and `MemAvailable`
      minima per job.

## Phase 1: prerequisites (one and a half to two days; six small landings through the serial gate)

- [ ] 1.1 Fix the three port collisions: settings-ui's fake ElevenLabs off
      8424, content-animate's fake fal off 8441, reader-strip off 8469
      (reader-share keeps it). New ports chosen from the suite band after a
      grep of all five repos' `tests/` (candidates 8399, 8408, 8429; 8471 and
      8472 are live listeners on this host and excluded). Registry test:
      refuses any duplicate fixed listener across the six repos' suites and
      any `ports:` entry in 8377, 8378, 8380-8389, 8388, 8480 and up.
- [ ] 1.2 Replace `pkill -f "server[.]js <port>"` in presence, update and
      update-boot with pid-tracked kills of the child they spawned (house law;
      gate-stamp already pins that the gate itself has no pkill).
- [ ] 1.3 Shared-hub background rebuild seam: `ERA_CLOTHING_TICK_MS` (0
      disables the 20 s one-shot and the 15 min interval); the gate exports 0
      for its shared hub and performs one awaited `POST /clothing/regenerate`
      after readiness, before any suite starts. The env prefix stays on the
      continuation line before `"$NODE_BIN"` so chat-api's launch-line regex
      still matches. Tests: the hub honours the seam; the clothing tick tests
      pass with the default; board-input and board-pixel pass against the
      regenerated `today.json`; record here which `today.json` the readers see.
- [ ] 1.4 icons: make the `/setup` POST explicit (`ICONS_SEED_PROFILE=1`) so
      no suite can write to the shared hub by accident. Registry test: fails
      if the seed loses `profile.json` or if any shared-reader suite's route
      stubs stop covering `/log`, `/outfit-event`, `/music-event`,
      `/kiosk/pause`, `/runway` and `POST /settings`.
- [ ] 1.5 Registry classes replace the boilerplate triple for all 156 suites
      (hub use: none | own | shared-reader | shared-writer; fixed ports;
      browser launches; heavy; solo; quiet; retry; owner), applied by a
      re-runnable transform script over `registry.json` so it re-applies after
      any sync. The eight master-only suites (chat-browser, chat-metrics,
      chat-storage-ui, chat-storage, chat-store, chat-symbols, chat-voice,
      windows-parallel) are classified by reading them. Tests: every suite has
      every field; `solo` = clothing-responsive; `heavy` = the segmentation
      suites; `quiet` = games-ui, math-ui, play-ui, drawing-ui, presence,
      update-boot; `retry: true` requires `owner`.
- [ ] 1.6 Land each item on its own green gate; record the six gate times here.

## Phase 2: lanes inside one gate (two to three days)

- [ ] 2.1 `tools/testing/lanes.mjs`: input plan + durations + lane count +
      classes; longest-first queue; per-suite re-hash before start; same
      command, cwd, timeout and env as the serial loop; `solo` drains lanes;
      at most two `heavy`; at most one `quiet`, never beside a heavy; memory
      floor (`ERA_GATE_MEM_FLOOR_MB`, default 2048) with hysteresis (+512) and
      a pressure hold (`full avg10` > 0.5), never holding the last running
      lane, every hold logged; `oom_score_adj` raised on each suite's tree;
      legacy capped at two lanes while `~/.local/state/era-parallel-gates/slot.json`
      is leased; `RUN` at start, `PASS`/`FAIL` at completion; incremental
      `gate/results.jsonl` (id, digest, lane, start, end, exit, TAP counts,
      skip lines, output sha, memory and pressure) and `gate/status.json`
      (`running: []`, done, ETA); SIGTERM/SIGINT kills only recorded child
      pids (TERM then KILL), writes partial results, exits 143/130; exit code
      = any failure. Tests (synthetic suites in a temp dir): ordering, lane
      cap, solo draining, heavy and quiet caps, memory and pressure hold with
      a fake `/proc` seam, last-lane rule, lease cap, failure isolation, hash
      mismatch refused, timeout honoured, signal cleanup with a long synthetic
      suite, output lines byte-compatible with the serial loop.
- [ ] 2.2 `era-gate.sh`: first step, the serial loop writes `results.jsonl`
      (so phase 3 can proceed if the benchmark stalls); then the loop is
      replaced by `lanes.mjs`; bash keeps the freeze and
      `gate_verify_execution` over `results.jsonl`; the environment block
      (TZ, LANG exported and recorded; `ERA_AI_URL`, `PLAYWRIGHT_BROWSERS_PATH`
      unset unless passed); `ERA_GATE_LANES` default 1 until the benchmark,
      then the chosen value; the isolated runner passes its own value.
- [ ] 2.3 Update the pinned tests and parsers that read gate text, each with
      its intent intact: gate-safety (function names 13-18; selection and
      digest pins 281-304, 376-449, nine usages of the freeze/record/verify
      functions rewritten against `lanes.mjs` where the digest check moved),
      gate-stamp (31-37, 87-97, 140-168), chat-api (631-649),
      assemble-suffix (104-143), test-suite, parallel-gate (imports
      parallel-snapshot's validator), suite-runner `consume()` and
      parallel-worker `parseProgress` (running set instead of one active
      suite), the parallel-worker.py progress writer.
- [ ] 2.4 Benchmark, one overnight block announced to the other sessions
      (about 4 h of the machine-wide lock, split in two detached halves so a
      release can take the lane between them): three gates each at 1, 2, 3
      and 4 lanes, the 1-lane runs as control; plus twenty `--only` runs of
      the quiet set per lane count. Record wall time, per-suite duration
      inflation versus `durations.json`, first-pass failures with the failing
      `.out` attributed, peak tree RSS and minimum `MemAvailable`, hold
      counts, and one measured legacy-plus-isolated pair. Default = the
      largest lane count with no failure that reproduces at that count and
      does not occur in the control, and `MemAvailable` never under the floor.
      Record the table here. Budget: one night plus half a day of analysis.
- [ ] 2.5 Promote any suite that failed only under contention to `quiet` or
      `solo` (or fix its wait) and rerun that lane count once.
- [ ] 2.6 Docs: dev-flow (lanes, `ERA_GATE_LANES`, the environment block), the
      gate header comment, `tools/testing/suite-runner.README.md`; in the
      house worktree: parallel-worktrees (gates still self-serialize per
      checkout; lanes live inside; rule 2's corollary about parking gates
      re-verified against the host's uptime), `status.md`,
      `system-map.html` flow and republish.
- [ ] 2.7 Land. Expected: a clean full gate in 19 to 21 min at 2 lanes, 14 to
      17 at 3 if 0.4 and the benchmark allow it.

## Phase 3: per-suite reuse, rerun-failed, restamp (three to four days)

- [ ] 3.1 Run store under `$ERA_GATE_RUNS/<run-id>/` (seam, never `$HOME`;
      unset means no store and no reuse): `inputs.json`, `plan.tsv`,
      `results.jsonl` (appended as suites finish), `suites/*.out` (copied as
      they finish), `server.log`, `status.txt` (per-repo `git status
      --porcelain` with untracked files), `env.json`, `summary`,
      `receipt.json` (records the run-id). Pruning keeps the last 20 runs and
      every run named in a receipt under the stamp directory.
- [ ] 3.2 `tools/testing/reuse.mjs`: `runtimeHash(manifest)` (manifest minus
      `tests/**` and `docs/**` per repo, content only, no root paths, no port),
      `suiteKey(suite)` per spec §3.2 (frozen collected digest, collected
      helpers, the suite's registry entry, harness code, node and playwright
      versions and resolved paths, chromium revision and binary sha256,
      environment block, era-scan.sh digest), `qualifies(record)` (exit 0,
      TAP fail/cancelled/todo zero, pass = tests, no mandatory skip, run's
      post-run checks passed, no untracked files under tests/ public/ app/
      lib/, not a retry pass, age under `ERA_GATE_MAX_EVIDENCE_AGE` default
      24 h), `lookup(key)`, `compose(current, reused)`. Negative tests, one
      per component: a byte change in server.js, a board app file, a fixture,
      a helper, era-gate.sh, lanes.mjs, the suite's registry entry, the seed,
      node version, playwright version, the chromium binary, TZ, the private
      scanner, the port, each changes the affected keys; a change in one test
      file changes only that suite's key; a change in durations.json or
      another suite's registry entry changes nothing; a flaky pass, a failed
      run, a run with untracked files, a pass older than the bound, and a run
      whose post-run checks failed are never reused.
- [ ] 3.3 `era-gate.sh` cache-aware full run: compute keys after freeze; mark
      reused suites `REUSE <id> (run <run-id>)` on stdout; run the rest in
      lanes; compose; stamp only when every registered id has a qualifying
      pass; write `receipt.json` (fresh, reused with source run, retried,
      flaky, oldest evidence). `--no-cache` disables lookup. Tests:
      composition requires the full inventory; a reused pass with a stale key
      or beyond the age bound is refused; the stamp bytes are identical in
      form to a fresh gate's.
- [ ] 3.4 `--rerun-failed <run-id>`: refuse unless the inputs manifest hash is
      identical; retry only suites whose `.out` shows an assertion or timeout,
      that are `retry: true` with an owner, and that have fewer than two
      failures recorded on this key; legacy `.js` suites never; failures
      recorded under pressure are classed `resource` and rerun with one lane
      fewer, never flaky; once per suite; fresh shared hub; budget
      `ERA_GATE_FLAKE_BUDGET` (default 1) else red; append to `flakes.jsonl`
      with the original `.out` path; a ledger entry older than seven days
      without a resolving commit removes eligibility. Tests: second failure
      on the same key stays red; harness failures are not retryable; budget
      exceeded is red; resource failures are not flaky; the deadline removes
      eligibility; the ledger entry is complete.
- [ ] 3.5 `--restamp`: verify the manifest, require every key reused inside
      the age bound, write the stamp, print the receipt. Test: any suite
      needing a run refuses; evidence past the bound refuses.
- [ ] 3.6 Shared-state guard: full hash of the owned data dir after the
      awaited regenerate; mtime-and-size snapshot after each suite; full hash
      after the last; allowlist = `logs/**`, `pool/devices/*.json`,
      `pool/version`, `recipes/today.json`, `wardrobe.json`, `.clothing-sig`,
      the photoset file, `.weather-cache.json`, `this-week/.tmp/**`,
      `presence/**`, `tts-cache/**`, `symbols-cache/**`; denied includes
      `app-settings.json`, `profile.json`, `apps.json`, `pool/<device>/*.jsonl`,
      `wardrobe/history.json`, `content/*.json`, `writings/**`,
      `mail-status.json`, `music/**`, `movies/**`; `GET /settings` and
      `/clothing/status` snapshotted before and after. A difference outside
      the allowlist fails the gate, names the paths and marks the run
      non-reusable. Test with a synthetic writer suite.
- [ ] 3.7 Isolated runner: `parallel-worker.py`, `inside-worker.py` and
      `enter.sh` bind-mount the host run store read-write into the namespace
      and export `ERA_GATE_RUNS` and `ERA_GATE_LANES` in `gate-env.json`;
      `validateGateResults` accepts `REUSE` lines and the receipt. This
      control-code change lands on master before any isolated candidate
      relies on reuse; until then isolated gates run without a store. Tests
      in parallel-gate and parallel-capacity.
- [ ] 3.8 Receipts visible: `tools/release.sh` prints the receipt before
      building and runs `--no-cache` for signed cuts unless `--accept-receipt`
      is passed; in the house worktree `worktree.sh land` prints the receipt
      line after the summary. Tests: release refuses a signed cut with a
      reused receipt without the flag; land's output includes the line.
- [ ] 3.9 Weekly uncached full gate: a dedicated worktree
      (`era-hub--wt-weekly-gate`), the cron runs `worktree.sh sync` then
      `era-gate.sh --no-cache` there through the same environment wrapper the
      interactive gates use, detached with a sentinel, and writes its summary
      into the hygiene report (the sweep sends no mail; `/seal` surfaces the
      report). Test: the script the cron calls passes `--no-cache` and refuses
      a working directory that is not a `--wt-` path.
- [ ] 3.10 `tools/testing/flakes.mjs report`: unresolved entries, age, owner,
      for the weekly sweep. Test with a synthetic ledger.
- [ ] 3.11 Docs: dev-flow (reuse, rerun-failed, restamp, flake ledger, the
      key), the strategy spec's "future reuse" section marked implemented
      with the key definition, `docs/research/2026-10-26-gate-reuse-eligibility.md`
      and `2026-10-26-test-speed-and-recovery.md` marked superseded with a
      pointer, `tools/testing/parallel-worker.README.md` and
      `suite-runner.README.md`, AGENTS laws (a flaky suite gets an owner and
      a deadline; quarantine never deletes); in the house worktree:
      parallel-worktrees (docs-only exception superseded), `status.md`,
      `system-map.html`; a memory note on the new laws.
- [ ] 3.12 Land. Expected: fixture-only fix or single flake recovers in about
      1 min plus the suite; restamp under 1 min.

## Phase 4: agents stop polling; dev loop (one day)

- [ ] 4.1 `tools/testing/gate-wait.sh <run-id|latest> [--max 570]`: blocks on
      the run's done sentinel, prints one line; `status.json` carries the ETA.
      Test with a synthetic run dir.
- [ ] 4.2 `era-gate.sh --only <suite...>`: named suites in lanes, no stamp,
      no reuse writes. Test: never stamps; refuses unknown ids.
- [ ] 4.3 No-polling law in `AGENTS.md` here and in the house router: never
      poll a gate more often than every five minutes; never give a sub-agent
      a watch loop; use `gate-wait` or a background task with a sentinel; a
      full gate is started detached (reconciled with parallel-worktrees rule
      2's corollary in 2.6).
- [ ] 4.4 Land. Expected: watching a gate costs a few percent of a session.

## Phase 5: later, separately specced

- Declared per-suite dependencies in the registry with selection validation
  (run selected, then full, compare failure sets) to narrow "board-only
  change" gates to minutes. This is what fully answers "don't run tests that
  have no chance of catching anything".
- The testing-suite session's Windows follow-ups: mandatory native display
  prerequisite, failure packet before cleanup, cold-readiness measurement.
- Per-suite port injection for the 50 suites with fixed listeners, so the
  same suite can run twice on one host outside a namespace.
- Splitting clothing.test, only if the host ever runs six or more lanes.

## Recovery under specific circumstances (what dad can expect)

| Circumstance | Action | Time |
| --- | --- | --- |
| Gate red, one suite, the test was wrong | fix the test; the next cache-aware gate reruns that suite and composes | about 1 min plus the suite (17 s to 6 min; median under 10 s) |
| Gate red, one suite, nothing changed | `--rerun-failed <run>`; green if it passes, logged FLAKY; a second failure stays red and the suite gets an owner | same |
| Gate red, several suites | fix; the next gate reruns only the changed keys | minutes to a full lanes gate |
| Gate died (memory, host, kill) | reuse the passes recorded before the crash with a clean guard snapshot; else a lanes gate | the remainder, or 19 to 21 min |
| Stamp expired while waiting for dad, evidence under 24 h | `--restamp` | under 1 min |
| Master moved before landing | `sync`; the next gate reruns only the suites whose key changed (docs and tests of others: none; product files: all) | 0 min to a full lanes gate |
| Product change anywhere (hub or a sibling repo) | full gate in lanes | 19 to 21 min at 2 lanes, 14 to 17 at 3 |
| Two features gating at once | legacy lane at two lanes beside the isolated lane; the memory floor arbitrates | unverified until the benchmark's pair run |

## Retrospective

To be written at close.
