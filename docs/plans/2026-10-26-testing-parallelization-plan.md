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

- [x] 0.1 Land or sync `era-hub--wt-era-gaze-launcher` (unmerged edits to
      `registry.json`, `server.js`, `docs/dev-flow.md`), then `worktree.sh sync`
      this worktree to master (26+ commits behind). Done 10/26: the launcher
      fix landed as 5fe553d (gate 158/0); this worktree merged master at
      5fe553d (fe6fb81); the registry now lists 158 suites.
- [ ] 0.2 (four of ten closed 10/26: testing-suite-rollout, windows-parallel,
      games-save, math — merged, clean, no session inside; still open: chat,
      games, weekly-runs, pictures and testing-suite hold a live agent session
      each, so their owners close them; games-g2 and youtube-videos carry one
      unlanded commit each — a Math fixture stabilisation and a docs tick — for
      their owners to land or drop.) Close `feat/testing-suite` as superseded (its gate tooling reached
      master through the rollout; its branch carries unpublished Chat source
      and is never landed) and close the stale worktrees from outside them:
      testing-suite-rollout, windows-parallel, chat, games, games-save,
      games-g2, math, weekly-runs, pictures (all behind master with no unique
      commits, or superseded). Open an `aac-board-builder` worktree for the
      house-repo edits in 2.6, 3.8, 3.10 and 4.3.
- [x] 0.3 (built 10/26: `harvest-durations.mjs`, 6/6, table of 158 suites from the
      five green isolated jobs plus the launcher landing gate; registry ids are
      the `era-hub:tests/x.test.mjs` form; legacy scripts timed by output
      mtime gaps, 14 to 23 ms over true wall time.) Harvest durations: `tools/testing/harvest-durations.mjs` reads
      `# duration_ms` from the `.out` files of the last green runs (job
      workspaces under `~/.local/state/era-parallel-gates/jobs/*/workspace/era-hub/gate/`
      and the rollout gate dir; legacy scripts by mtime gap) and writes
      `tools/testing/durations.json` (median, sample count; mean for unknown
      suites). After phase 2 it reads `results.jsonl` instead; refreshed on
      every green master gate, committed weekly. Test: a synthetic gate dir
      yields the expected table.
- [x] 0.4 (first pass 10/26 on the landing gate, 989 samples at 2 s: host
      MemAvailable 4.28 GiB at start, 3.25 GiB at the floor, so the whole gate
      drew at most 1.03 GiB above the idle host. Draw by suite, start minus
      the suite's lowest MemAvailable: clothing 1.03 GiB, clothing-accessories
      0.76, weather-location 0.71, clothing-responsive 0.56, clothing-weather
      0.53, reader-ui 0.49, clothing-share 0.47, suite-classes 0.45,
      update-boot 0.42, pencil 0.40, clothing-attrs 0.30, book-review-ui 0.30,
      settings-ui 0.28; everything else under 0.26. Host-level deltas, so
      other activity is folded in; the sampler's process-tree RSS column was
      empty on this run (a shell bug, fixed) and the next landing gate gives
      the exact per-tree figure. Reading: two heavy clothing suites side by
      side cost about 1.8 GiB, three lanes of ordinary suites under 1 GiB;
      with the host floor at 3.25 GiB today, two lanes always fit and three
      fit whenever no two heavy suites coincide, which the heavy class
      already prevents.) Memory profile: one instrumented serial run (`ERA_GATE_LANES=1`, a
      sampler recording tree RSS per running suite) to learn the per-suite
      peak; record the ten heaviest here. Expected: the clothing family
      (wasm), board suites with 13 to 15 Chromium launches, drawing-ui,
      play-ui. This number decides whether 3 lanes is ever on the table.
- [x] 0.5 Baseline, from the five green isolated-runner jobs of 10/26 (each
      job's own memory observations, about 1000 samples per gate):

      | job (UTC) | peak tree RSS | host MemAvailable min | swap used max | swap added | PSI some avg10 max |
      | --- | --- | --- | --- | --- | --- |
      | 01:54 | 1.36 GiB | 2.53 GiB | 2.45 GiB | 0.12 GiB | 2.7 |
      | 03:49 | 1.26 GiB | 3.21 GiB | 2.60 GiB | 0.13 GiB | 1.4 |
      | 07:12 | 1.33 GiB | 3.09 GiB | 2.75 GiB | 0.27 GiB | 2.8 |
      | 08:59 | 1.33 GiB | 3.30 GiB | 3.09 GiB | 0.32 GiB | 5.1 |
      | 15:04 | 1.30 GiB | 3.20 GiB | 3.27 GiB | 0.38 GiB | 20.7 |

      Wall times 2131, 2056, 2033 s serial. Up to 423 processes in the gate's
      tree at peak. Swap in use by resident agent sessions grew from 2.45 to
      3.27 GiB across the day and memory pressure with it: the 2 GiB floor in
      the lane scheduler is a hard need, not a nicety.

- [x] 0.6 (resolved 10/26: the QA template boots at 1024x768; at that width
      Chat's "Reactions" tile needs 210 px for its word in a 208 px box at the
      44 px floor, so the check fails every time. Every green Chat proof had
      first set the desktop to 1280x800 through a private setup step the Chat
      and Games work kept outside the public harness. Leg B now sets the real
      desktop mode itself after the guest goes quiet and before the kiosk
      opens (`tests-vm/lib/native-display.{cs,mjs}`, `vm.nativeDisplay()`),
      the assertion reports every offending tile with its metrics and the
      screen size, and the measurement waits one animation frame. Fresh QA
      host, no private step: 11/11 on the v1.0.22 bytes. Decision left open:
      Chat at 1024x768 would need a styling change; both family devices are
      larger, so the floor stays 1280x800. Runbook line for the house repo:
      the template boots at 1024x768 and leg B sets 1280x800 itself.)
      Resolve the Windows leg B red that blocked `release.sh --patch` for
      v1.0.22: `tests-vm/leg-b-update.e2e.mjs` subtests 9 and 10 fail at
      `chat-ui-smoke.mjs:264` ("pictures and complete words fit at the readable
      font floor"), identically twice and on the published v1.0.21 bytes as a
      control, so a host or harness cause is expected. The assertion prints no
      per-tile metrics; at minimum it must. Root cause first, then the fix;
      the 44 px floor is product law and is not loosened. Re-prove leg B.

## Phase 1: prerequisites (one and a half to two days; six small landings through the serial gate)

- [x] 1.1 (done 10/26: settings-ui 8424 to 8399, content-animate 8441 to 8429,
      reader-strip 8469 to 8408; `suite-ports.test.mjs` 7/7 scans suite sources
      with comments and strings blanked. The 8480-and-up ban could not be met
      as written: presence 8486/8487 and gaze-status 8489/8491 already sit in
      the push-device feed band and only three ports in 8390-8479 are free, so
      the test carries a shrink-only list of exactly those four; moving them
      needs a new band below 8377, a follow-up for 1.5. The gate collects five
      repos, not six.) Fix the three port collisions: settings-ui's fake ElevenLabs off
      8424, content-animate's fake fal off 8441, reader-strip off 8469
      (reader-share keeps it). New ports chosen from the suite band after a
      grep of all five repos' `tests/` (candidates 8399, 8408, 8429; 8471 and
      8472 are live listeners on this host and excluded). Registry test:
      refuses any duplicate fixed listener across the six repos' suites and
      any `ports:` entry in 8377, 8378, 8380-8389, 8388, 8480 and up.
- [x] 1.2 (done 10/26: `tests/hub-port.mjs` finds the LISTEN socket's owner in
      /proc, checks its command line is `server.js <port>`, signals that pid and
      repeats until the port is free; four of the six sites stop a hub the test
      never spawned, so "the child they spawned" was the wrong description.
      presence 8/8, update 11/11, update-boot 6/6; a planted leftover hub on
      8410 was cleared.) Replace `pkill -f "server[.]js <port>"` in presence, update and
      update-boot with pid-tracked kills of the child they spawned (house law;
      gate-stamp already pins that the gate itself has no pkill).
- [ ] 1.3 Per-suite speedups (added 10/26 after dad asked "nothing to speed up
      the existing tests?"). Eight profilers and eight skeptics (Opus) audited
      the twelve longest suites, 1632 s of the 2120 s gate. Verified: 772 s
      is removable without changing what a test proves; 850 s is real work.
      Verified by family (now / removable / floor, seconds): clothing 369 /
      233 / 136; clothing-accessories 194 / 124 / 70; clothing-share, -attrs,
      -weather, -responsive, -refit 233 / 80 / 145; drawing-ui 122 / 60 / 62;
      play-ui, games-ui, math-ui, watch-ui 191 / 62 / 129; reader-ui and
      reader-share 107 / 52 / 55; pencil, run, narrow, parts 183 / 115 / 68;
      the 111 small suites 232 / 46 / 185.

      Where the time went. clothing.test pays 25 photo-loop sleeps of a literal
      5 s (clothing-worker.js:1052; `usedAi` is set before the provider call,
      so failed attempts sleep too) and 14 quick-retry gaps of 3 s (:567): 167 s
      of sleep against a stand-in provider, in one 35-case file. The remaining
      long poles are real compute (one cut-out inference about 2.4 s, a WASM
      session load about 0.9 s, a full board redraw about 0.15 s per outfit)
      and fixed waits in browser suites (400 ms audit settles in
      invariants.mjs, 300 ms in-page sleeps, 2 s finger holds that are
      product law, pencil's 450 ms park sleep).

      Decision taken by the overseer, flagged for dad: review r1 ruled that
      "a stray ERA_AI_SPACING_MS must not be able to remove" the 5 s defence.
      That ruling stands for environment variables. The seam built here is an
      explicit `pacing` option passed through `clothing.start()` by test code
      only; server.js never passes it, no environment variable reaches it, and
      a unit test pins all three facts. Production defaults are unchanged.

      Not done, by the skeptics' blockers: the segmentation skip (changes
      what two cut-out cases prove, needs a per-build toggle); fake clocks in
      play-ui and watch-ui (their negative "unchanged after 900 ms" checks
      flake with a running clock); any change to her dwell timings (law);
      merging the legacy scripts (their list is hard-coded in eight places
      across two repos); the update exit seam (would stop exercising the
      bind-retry path a real self-update depends on).

      Intra-suite concurrency (dad: "can the tests themselves run some in
      parallel too?"): possible in node:test by moving cases under a
      `describe` with a concurrency option, but no long suite is written for
      it. Each shares one hub and one data directory per file, several share
      one page, and the browser suites share Chromium's speech queue. Making
      cases independent means a hub, a data dir and a port per case (or
      hubs on port 0), 80 to 250 MB per concurrent case, on a host whose
      memory is the binding limit. The verified gain is 8 s for the hub
      suites and only drawing-ui would gain more, at the cost of moving 84
      cases under describe blocks. Decision: not now; lanes between suites
      plus the seams above deliver the win, and the split is revisited once
      the per-suite floors dominate.

      New fact for phase 2: kiosk-pause and routes bind a stand-in gaze
      engine on 127.0.0.1:49155, and every reader hub, pencil page and
      dwell.js browser suite talks to 49155 when ERA_GAZE is not pointed
      elsewhere. The port extractor misses it (a listen on a literal inside a
      helper). 49155 must become an exclusive resource in the registry before
      any two of those suites share a gate run.

      Batch S1 (era-hub only, one landing): the pacing option and the
      pacing-zero calls in every clothing suite that starts the module in
      process; makeJpg memoisation in synthetic-wardrobe.mjs (byte-identical
      fixtures); clothing-responsive seeds 2 photos, not 6, and asserts the
      rounds it measured; clothing-item polls `building` every 50 ms once;
      an opt-in `ready` predicate in invariants.mjs for drawing states;
      reducedMotion on play-ui's two Sort-shuffle cases; an event-waited
      positive hold in reader-share; a shorter settle in drive-launch; and
      the shared-hub tick seam below. DONE 10/26: measured one suite at a
      time, clothing 353 to 188 s, clothing-accessories 184 to 121,
      clothing-responsive 60 to 12 (2 photos, still 10 latency rounds inside
      the build), clothing-weather 45 to 24, clothing-attrs 36 to 18,
      clothing-refit 19 to 6, clothing-item 9.5 to 1.4, drawing-ui 105 to 96,
      play-ui 83 to 77, reader-share 33 to 29, drive-launch 6 to 2.6,
      invariants 25 to 21; every pass count unchanged; two new suites
      (clothing-pacing 1 s, clothing-schedule 22.5 s on port 8425). About
      370 s net off the serial gate, not the audit's 450 to 550: clothing-share
      spends its time in hubs that never ask the provider about photos, and
      the shared hub's awaited build never rewrites the seed's today.json
      (the seed has no wardrobe), so board-input and board-pixel read the
      seed's own recipe as they always did. Dad 10/26: "Don't wait 5s in the
      testing environment." Implemented as a rule, not an env: the worker
      waits 0 when ERA_AI_URL names this machine (127.0.0.1, localhost,
      [::1]) because there is no real provider to protect, 5 s and 3 s for
      any other or no URL; ERA_AI_SPACING_MS reaches neither; an explicit
      clothing.start({aiPacing}) from test code wins over both; a family's
      hub never sets ERA_AI_URL. clothing-pacing pins every branch, including
      lookalike hosts. The worker posts its pacing once at load so the test
      can read it without sleeping.
      Batch S2 (DONE 10/26, committed in `era-pencil--wt-testing-parallelization`
      and `era-making-words--wt-testing-parallelization`; the era-hub gate
      must run with ERA_WT_SUFFIX=--wt-testing-parallelization to collect
      them): pencil.js drops the 450 ms park sleep (25 a run, waited for
      nothing: re-arming is distance-only and the park spot is not a dwell
      target) and reads predictions after their single paint; run, parts and
      narrow wait for the event each sleep stood for (the engine's
      dwell:activate on the gazed element, lessons and runway loaded, the
      phase reached, the /runway or /log row landed, viewport plus two
      frames), every wait bounded and falling through to the original
      checks. Measured against a scratch hub with the gate's port rewrite:
      run 33 to 11 s, parts 25 to 5, narrow 25 to 4, pencil 84 to 73; same
      pass lines (28, 15, 9, 24), identical check details. 76 s saved, not
      the audit's 100: the speech self-test fails in 18 to 56 ms headless,
      not 3 s, so stubbing it was worth nothing, and the rest of pencil's
      hold margins (about 16 s) were not in scope. The audit also missed
      that parts' first 300 ms and run's 900 ms door wait covered real
      events; both now have explicit waits.
      Later, if wanted: the segmentation skip (about 60 s more on clothing).

- [ ] 1.3a Shared-hub background rebuild seam: `ERA_CLOTHING_TICK_MS` (0
      disables the 20 s one-shot and the 15 min interval); the gate exports 0
      for its shared hub and performs one awaited `POST /clothing/regenerate`
      after readiness, before any suite starts. The env prefix stays on the
      continuation line before `"$NODE_BIN"` so chat-api's launch-line regex
      still matches. Tests: the hub honours the seam; the clothing tick tests
      pass with the default; board-input and board-pixel pass against the
      regenerated `today.json`; record here which `today.json` the readers see.
- [x] 1.4 (done 10/26: opt-in seeding; against a profile-less scratch hub the
      old suite silently wrote profile.json, the new one fails naming the env.
      The route-stub registry test waits for the shared-state guard in 3.5.)
      icons: make the `/setup` POST explicit (`ICONS_SEED_PROFILE=1`) so
      no suite can write to the shared hub by accident. Registry test: fails
      if the seed loses `profile.json` or if any shared-reader suite's route
      stubs stop covering `/log`, `/outfit-event`, `/music-event`,
      `/kiosk/pause`, `/runway` and `POST /settings`.
- [x] 1.5 (done 10/26: `classify-suites.mjs` + `suite-classes.test.mjs` 15/15;
      161 suites: hub none 72, own 54, shared-reader 35, shared-writer 0;
      60 launch Chromium (180 call sites), 60 claim fixed ports; heavy 9 =
      three segmentation suites (clothing 24 cut-outs in 350 s,
      clothing-accessories 11, clothing-responsive 6, measured with a preload
      probe) plus six board/dwell suites with 10 or more browser launch sites;
      quiet = the plan's six; solo = clothing-responsive. Nothing read the
      boilerplate `resources` triple, so it became the derived list. A sibling
      repo's suite edit that changes a class fails era-hub's gate until the
      transform is rerun, like an unregistered suite does today. Quiet
      candidates for 2.5: doorbar 16 fixed waits, board-lock, pencil-ui 12,
      reader-share 10, board-edit, board-input, reader-ui 9.) Registry classes
      replace the boilerplate triple for all 156 suites
      (hub use: none | own | shared-reader | shared-writer; fixed ports;
      browser launches; heavy; solo; quiet; retry; owner), applied by a
      re-runnable transform script over `registry.json` so it re-applies after
      any sync. The eight master-only suites (chat-browser, chat-metrics,
      chat-storage-ui, chat-storage, chat-store, chat-symbols, chat-voice,
      windows-parallel) are classified by reading them. Tests: every suite has
      every field; `solo` = clothing-responsive; `heavy` = the segmentation
      suites; `quiet` = games-ui, math-ui, play-ui, drawing-ui, presence,
      update-boot; `retry: true` requires `owner`.
- [ ] 1.6 (first landing 10/26 20:12 UTC: gate 161/0 in 33 min 16 s (19:38:53 to
      20:12:09), landed as master 3a783fe with hygiene, harvester, classes and
      the Windows leg B fix. Revised: three landings, not six — hygiene + harvester + classes
      in one gate once the Windows leg B fix is in; seams + per-suite speedups
      in a second; anything the speedup review adds in a third.) Land each
      batch on its own green gate; record the gate times here.

## Phase 2: lanes inside one gate (two to three days)

Progress 10/26 (built in one evening in its own worktree, `era-hub--wt-gate-lanes`,
after dad's "what can we deploy today"): `tools/testing/lanes.mjs` replaces the
serial loop; ERA_GATE_LANES default 2, 1 is the serial loop byte for byte;
solo first, then longest known duration first; never two heavy, never quiet
beside heavy, never two claimants of one fixed port including the gaze
engine's bus 49155, which the classifier now records for kiosk-pause and
routes; those two also run solo, because every hub's settings probe that
port to place the door and a stand-in engine held by one suite would be seen
by hubs in other lanes. MemAvailable floor 2 GiB holds a lane, never the
last one running. Each suite is re-hashed against its frozen digest at
start; RUN, PASS and FAIL lines, the summary and the stamp are unchanged;
`results.jsonl` records one line per suite; TERM or INT stops every suite by
pid within seconds. 13 scheduler tests with a fake node; every pinned gate
shape green. Modelled on the pre-speedup durations: 35.5 min serial, 18.3 at
two lanes, 14.4 at three, and three equals four because the heavy suites
form a chain. Not built: the PSI pressure hold, the two-lane cap while an
isolated lease is held, archiving results.jsonl into the job dir; the
harvester must read results.jsonl once lanes are on (its mtime method
assumes serial runs); the progress readers in parallel-worker and
suite-runner show only the last RUN line (cosmetic). The first two-lane gate
on the merged tree is the proof run and the landing gate at once.

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

Landed 10/26 22:13 UTC as era-hub master e4d44c7: the first two-lane gate on
the merged tree ran 164 suites green in 14 min 10 s (21:59:21 to 22:13:31),
0 memory holds, host MemAvailable never under 2.95 GiB, gate tree RSS peak
2.03 GiB; suite time 1661 s, so the two lanes were busy 98 % of the wall.
The same day's serial gate after the suite speedups took 26 min 39 s and the
morning's 33 min 16 s. One merge fix on the way: gate-safety's new ordering
case had to learn that "the suites" now start at the lanes runner. A stopped
gate marks the suites it killed as FAIL; a `stopped` state is a follow-up.
`durations.json` still holds pre-speedup medians and must be regenerated
from `results.jsonl` (`harvest-durations.mjs --results`) at the next landing
that touches tools/; the mtime method is wrong under lanes.

## Phase 2b: gates in their own namespaces; admission instead of exclusion (added 10/26 23:40)

Dad, after two sessions queued behind each other for an evening: "This locking
out is really annoying ... figure out how we get to two lanes already." The
testing-suite session's isolated runner already gives a second gate lane in
private namespaces, but on two CPUs at the lowest priority, one job at a time,
with the choice of who gets which lane and the landing order made in a chat
rather than by the tool. The lock-out is the main lane's exclusive flock.

- [x] 2b.1 (built 10/27 00:30: `unshare --user --map-current-user --keep-caps --net`, loopback up plus a dummy link with a test address so the LAN-socket case still runs, then `setpriv` dropping every capability; the process is replaced, so a detached launch's pid file stays right; no PID or mount namespace. Refused unshare falls back to the exclusive lock, loudly. A gate inside the isolated runner neither unshares again nor takes a slot.) `era-gate.sh` re-executes itself inside a private network namespace
      (the isolated runner's approach and preflight), so two main-lane gates
      never collide on suite ports or the 8378 hub; stamps still land on the
      host; a gate already inside the isolated runner does not unshare again.
      Refused unshare falls back to today's exclusive lock, loudly.
- [x] 2b.2 (built: the registry lock is `/tmp/era-gate-slots/.lock`; admitted gates hold `/tmp/era-gate.lock` SHARED for the run, so a gate from a branch older than tonight, or one that cannot isolate, still takes it exclusively and queues as before; this matters because branches before feafab0 still `pkill` hubs by name, which without a PID namespace could reach another gate's hubs. New gates stand back while an exclusive request is queued. Lanes = min(asked, floor(MemAvailable/1 GiB) - 1): two lanes need 3 GiB, one needs 2; one more gate in the same checkout is refused; slots of dead pids are dropped; ERA_GATE_CANCEL_FILE honoured while waiting.) Admission replaces exclusion: the flock guards only a slot registry
      (`/tmp/era-gate-slots/<pid>`); a gate starts when fewer than
      ERA_GATE_MAX_GATES (default 2) run and MemAvailable covers its lanes
      (1 GiB a lane plus 1 GiB reserve; measured: one lane peaks 1.3 GiB, two
      lanes 2 GiB); otherwise it waits and says so once a minute; when memory
      admits one lane it runs one lane rather than waiting. The lane
      scheduler's 2 GiB floor stays as the in-flight guard.
- [x] 2b.3 (gate-admission 19 cases; gate-safety, gate-stamp, chat-api, assemble-suffix, lanes, parallel-gate, suite-ports, suite-classes, test-suite, integration-queue all green, also from inside a gate's own namespace. Follow-ups in flight: young slots' lane budgets subtracted at admission (ramp-up race), the isolated runner's gate counted as a slot, operator access through `nsenter --user --net -t <pid>`, house-repo docs.) Tests: gate-admission (fake meminfo, temp slot dir, stale pids,
      namespace smoke with two listeners on one port), every pinned gate shape
      green, the isolated runner unchanged.
- [ ] 2b.4 Memory is the ceiling: two gates at two lanes each need about 4 GiB
      free; resident agent sessions hold about 3 GiB in swap. Dad closes idle
      sessions during release windows; then two features gate at 14 min each,
      side by side. Landing stays merge-only: the second lander syncs and
      re-gates (14 min now; minutes after Phase 3 for test-only merges).

## Phase 3: per-suite reuse, rerun-failed, restamp

Progress 10/27 01:00 (built in one sitting in `era-hub--wt-gate-reuse`,
committed there, not landed): `tools/testing/reuse.mjs` holds the run store
under `$ERA_GATE_RUNS`, a nine-part key per suite (runtime manifest by
content, the private scanner copies, collected helpers, harness, node and
Playwright with browser revisions, suite environment, the suite's frozen
digest, its registry entry or the whole registry for suites that read it),
the qualifying rule (identical key, a plain pass, under 24 h, no guard
change), the failure ledger and the shared-hub guard. `era-gate.sh` gains
`--no-cache`, `--rerun-failed RUN`, `--restamp RUN`, `--only`; the hub starts
only when something runs; a receipt line and receipt.json precede the
unchanged stamp and summary. `lanes.mjs` skips REUSE and refused suites,
retries one failed suite once, alone, at the end (never a timeout, a kill,
an out-of-memory or an EADDRINUSE), prints FLAKY and appends flakes.jsonl.
24 tests with fake suites; every pinned gate shape green. A real gate has
not run it yet. Decisions taken: a FLAKY on a key that failed in an
earlier gate uses the one retry and stays FLAKY until the key changes or a
`--no-cache` gate passes it; `--no-cache` ignores the ledger; the coarse
helper rule stays (any helper change reruns everything; per-consumer
invalidation is v2); root-level *.md count as docs; the signed release
flow passes `--no-cache`. Costs now: a wrong suite file, fixed, is a minute
plus that suite; a race on identical inputs costs the suite once more
inside the same gate; a resource failure `--rerun-failed`; an expired stamp
`--restamp` in seconds; a shared helper or fixture change is still a full
14 minute gate. The retry fields `retry`/`owner` in the registry are
unused: every suite gets the one retry, by dad's decision. Still to do:
land and release print the receipt (house repo); the isolated runner's
validator learns REUSE and FLAKY before its jobs get a store; a signed cut
run with `--skip-gate` or `--resume-sign` accepts any green stamp under 2 h,
which may have been composed from reused passes, so "signed cuts run fresh"
holds only on the normal signed path until the stamp or receipt carries a
freshness mark the release script checks.
 (three to four days)

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

Interim, 10/26 evening, after phases 0, 1 and 2 landed in one day.

- What moved the number: three things, in this order of size. Removing sleeps
  that waited on nothing (a stand-in provider's rate limit, parks, settles,
  speech self-tests that fail in 20 ms): 33 to 26.6 minutes serial. Lanes:
  26.6 to 14.2. The hygiene before both (one port per suite, pid-only kills,
  classes) made lanes safe rather than fast.
- What the plan got wrong: the lane model was built on the pre-speedup
  durations and on a three-lane hope that the heavy rule caps anyway; the
  speedup audit's estimates ran 25 to 40 % high where a skeptic had not
  measured; "six small landings" became three; the one-day Phase 0 was an
  evening, the two-to-three-day Phase 2 a few hours in its own worktree once
  the gate ran elsewhere. Dad's "that timeline is ridiculous" was right: the
  padding was sequential gates and a benchmark night, not work.
- What the process got right: adversarial review before building (the first
  draft would have reversed a review ruling by env var and would have run the
  weekly gate in the main checkout); a skeptic per profiler (four
  overstatements caught, the 49155 door-probe hazard found); every builder
  on the house laws, test first, nothing committed by an agent.
- Windows leg B: a red that two sessions wrote off as "harness" was a QA
  template booting at 1024x768 and a private setup step nobody had put in
  the public harness. An assertion that prints nothing but "did not fit"
  cost a day; it now prints every tile.
- Still open: Phase 3 (reuse, rerun-failed, restamp) and Phase 4 (gate-wait,
  no-polling law); the shrink-only list of four suites in the push-device
  band; the pencil hold margins (about 16 s); the segmentation skip (about
  60 s); a `stopped` state for killed suites; durations.json regeneration
  from results.jsonl.
