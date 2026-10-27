# Testing parallelization: faster gates, same acceptance, restart without a full rerun

Status: PROPOSED 2026-10-26, revised the same day after an adversarial review
(three independent reads: false-green risk, feasibility, house law). Awaiting
dad's decisions (section 8). Nothing built.
Plan: `docs/plans/2026-10-26-testing-parallelization-plan.md`. Predecessors:
`docs/specs/2026-10-25-testing-strategy-design.md` (registry, dev planner,
isolated full-gate lane), `docs/research/2026-10-26-test-speed-and-recovery.md`
(the testing-suite session's follow-up list), `docs/plans/2026-10-25-parallel-gate-adoption.md`.

## 1. What the record shows

Measured on this host (4 CPUs, 7.9 GB RAM) from gate outputs, job records and
the three feature sessions' transcripts of 2026-10-25/26.

Where a gate's 35 minutes go:

| Fact | Number | Source |
| --- | --- | --- |
| Suites in the gate today | 156, run strictly in series | master registry; job `gate-20261026T150437Z` |
| Serial suite time / gate wall | 2120 s / 2131 s (35.5 min); harness overhead about 12 s | the same job's `.out` files and `gate-exit.json` |
| Suites under 10 s | 103 to 105 suites, about 210 s together | two green runs |
| Longest suite | clothing.test 370 s; then accessories 194, drawing-ui 122, play-ui 88, pencil 84 | same |
| The clothing family | 15 suites, 843 s (40 % of the gate) | same |
| CPU use of a running gate | about one core; nine isolated gates pinned to two CPUs at nice 19 ran as fast as the legacy lane | `top`; job records |
| Peak process-tree RSS of one gate | 1.20 to 1.46 GiB | `memory-observations.json`, 11 jobs |
| Host memory with one serial gate running | `MemAvailable` fell to 2.2 to 3.3 GiB in 11 jobs; memory pressure `full avg10` reached 15 | same |
| Host memory at rest | 4.3 to 4.6 GB available, 3.2 of 4 GB swap in use, held by resident agent sessions (0.3 to 1.3 GB each) | `free`, `ps` |

What the gates bought in the 17-hour release window (22 full Linux gates, about 12.5 h of gate time):

| Outcome | Count |
| --- | --- |
| Red because a test fixture was wrong (music pictogram fetch, reader-shelf reload race and tie order, chat-api launch-text assertion, chat-browser route race, math-ui pause-ack race, reader-ui readiness) | 7 |
| Green reruns forced by those reds | about 3 |
| Reruns or aborts caused only by master moving, the 2-hour stamp window or ordering | about 6 |
| Product bugs caught by a Linux gate | 0 |
| Product bugs caught elsewhere (code review, a Windows leg) | 2 |

Roughly 10 of the 22 gates (about 5.7 h) existed because one test file was
wrong and the rule said "run all 150 again". Games alone ran five full gates
for two legitimate candidates; its own suites never failed. Four of the seven
fixture reds were single-suite races (reader-shelf tie, chat-browser route,
math-ui ack, reader-ui readiness): a plain retry would have passed them, and
the source fixes that made them deterministic would never have been forced.
That is the argument for a strict retry policy, below.

What the waiting cost in agent usage: the feature sessions spent 24 to 35 % of
their main-thread input tokens watching gates (sleep loops at 30 to 45 s,
status reads every 1 to 3 min, one watcher sub-agent issued 282 waits of 45 s).
Across the testing-suite, Chat and Games threads that is about 2.0 billion
input tokens in two days, 98 % cache reads, most of it re-reading a long
context to learn that a gate was still running.

What is already in place and stays: the inputs manifest (every tracked and
untracked-unignored file of six repos, the seed tree, the served farm links
and their targets, the gate-env digest, node version; captured before and
re-verified after each gate), the frozen per-suite execution plan with a
sha256 per collected file, the isolated namespace runner (one extra full gate
beside the legacy lane), the two Windows hosts, the registry, the 4-line green
stamp and its readers.

Two findings from reading every suite (108 hub suites and 40 sibling suites),
confirmed by the reviewers against master:

- Only 35 suites touch the gate's shared hub at all: 32 read static pages,
  `/settings` and seed recipes; icons POSTs `/setup` only when the seed has no
  profile (it has one); board-splash-door POSTs `/kiosk/exit`, which only
  clears in-memory state. No suite depends on state another suite left in the
  hub, and the legacy-first alphabetical order carries no precondition. Every
  other suite spawns its own hub or none and writes only inside its own temp
  dir.
- Fixed listener ports are disjoint across suites by convention, with exactly
  three collisions (8424 update-boot and settings-ui, 8441 fal-key and
  content-animate, 8469 reader-strip and reader-share) hidden by serial order.
  Three suites kill hubs by command-line pattern (presence, update,
  update-boot). The isolated runner's own `pkill` runs inside its private PID
  namespace and can only match its own children; it stays.

## 2. Goals and non-goals

Goals, in dad's order: a clean release with appropriate testing first; faster
gates with the same reliability; as much parallelism as the host carries;
after a failure, restart only what is necessary; focused testing while
developing; room for more suites over time; far less agent usage spent waiting.

What this plan does not yet do, said plainly: a product change anywhere (the
hub, a board file, a pencil file) still runs all 156 suites, only faster.
Skipping suites by declared dependency, which is what "don't run tests that
have no chance of catching anything" ultimately asks for, is phase 5 and needs
the shadow-selection validation the strategy spec describes (run the selected
set, then the full set, compare).

Non-goals: no suite is deleted or weakened; the meaning of a green stamp
("every registered suite passed on exactly these inputs") does not change; the
Windows legs, the live hub on 8377 and the release shapes are untouched; the
house laws (worktree per feature, land on a stamp under 2 h, kill by pid only,
never run a gate in the main checkout) stay.

## 3. Design

Three mechanisms, in build order. Lanes (3.1) stand alone. Reuse (3.2) needs
the per-suite records that the lane runner writes.

### 3.1 Lanes inside one gate

`era-gate.sh` keeps everything before and after its loop (lock, port check,
owned data copy, farm links, collection, port rewrite, freeze, provider seams,
shared hub start, post-run verification, stamp). The serial loop is replaced by
a small scheduler, `tools/testing/lanes.mjs`, which:

- takes the frozen plan (`gate/.execution-plan.tsv`), a committed duration
  table (`tools/testing/durations.json`, harvested from green runs, mean for
  unknown suites) and a lane count (`ERA_GATE_LANES`);
- orders the queue longest-known-duration first (longest-first list
  scheduling is within 4/3 of optimal and is what every timing-aware test
  splitter does) and lets each lane pull the next suite when it frees;
- re-hashes each collected copy against the frozen digest immediately before
  starting it (this check moves from bash into the runner, which is the
  process that starts suites; bash keeps the freeze and the final
  every-id-exactly-once verification);
- runs every suite with the same command, cwd, timeout and environment as
  today (`timeout 900 node --test ./X.test.mjs`, `timeout 420 node ./X.js`);
- honours three registry classes: `solo` (drain the other lanes first; today
  clothing-responsive, which asserts page latency under 900 ms while photos
  ingest), `heavy` (single-threaded wasm segmentation; at most two at once,
  each pins a core) and `quiet` (real dwell timers or sub-second windows:
  games-ui, math-ui, play-ui, drawing-ui, presence, update-boot; at most one
  running, never beside a heavy suite);
- holds a lane when `MemAvailable` drops under a floor (2 GiB, tunable, with
  hysteresis: resume at floor plus 512 MiB) or when memory pressure
  `full avg10` exceeds 0.5; never holds the last running lane; logs every hold;
- raises `oom_score_adj` on each suite's process tree (an unprivileged
  process can only raise it), so the kernel prefers a suite's browser over the
  shared hub;
- while an isolated job holds the parallel-gates lease, caps the legacy gate
  at two lanes so the niced two-CPU worker is not starved;
- prints `RUN` at start and `PASS` or `FAIL` at completion, so every existing
  parser keeps working, and writes `gate/results.jsonl` incrementally (one
  record per suite: id, frozen digest, lane, start, end, exit code, TAP
  counts, skip lines, output sha, memory and pressure at the time) plus
  `gate/status.json` with the set of running suites and an ETA;
- on SIGTERM or SIGINT kills only its recorded child pids (TERM, then KILL
  after a bounded wait), writes the partial results and exits 143 or 130;
- never stops the other lanes when one suite fails.

Why lanes are safe without touching 100 suites: the gate's load is waits
(dwell timers, Playwright `waitForTimeout`, provider retry sleeps), not CPU;
suites own their data; fixed ports are disjoint once the three collisions are
fixed; shared-hub users are readers. The one shared mutable thing, the gate
hub's own clothing rebuild (a one-shot 20 s after boot and every 15 min, which
rewrites `today.json` and flips its ETag), gets a seam
(`ERA_CLOTHING_TICK_MS=0` for the gate hub) and the gate instead performs one
awaited `POST /clothing/regenerate` after readiness, so board-input and
board-pixel still exercise the current worker's output, deterministically,
before any suite starts.

Model wall time for the current 156 suites (longest-first with the solo and
heavy constraints, plus 40 s setup) and what contention does to it:

| Lanes | Model | At 1.3x per-suite inflation | At 1.5x | Realistic target |
| --- | --- | --- | --- | --- |
| 1 (today) | 36.0 min | | | 35 to 36 min |
| 2 | 18.8 min | 24 min | 28 min | 19 to 21 min; the host's default as it stands |
| 3 | 13.1 min | 17 min | 19 min | 14 to 17 min, only once the per-suite memory profile shows three suites fit above the floor |
| 4 | 10.2 min | 13 min | 15 min | not on this host without freeing memory |

The honest statement: with three resident agent sessions holding about 3.4 GB
of RSS and 3.3 GB of swap, a single serial gate already pulls `MemAvailable`
to 2.2 to 2.7 GiB in half the recorded jobs. A 2 GiB floor will clamp three
lanes to about two most of the time. The third lane is bought by fewer
resident sessions (section 8), not by code. Below five lanes the bound is the
sum of suite time divided by lanes, not the longest suite, so splitting
clothing.test does not help on this host and is dropped.

Two gates on the host at once (legacy plus isolated) share the memory floor
and the CPU: the pair figure in section 6 is a model until one measured pair
run exists; the benchmark includes it.

### 3.2 Per-suite result reuse and rerun-failed

A gate run leaves a durable record under `$ERA_GATE_RUNS/<run-id>/` (the
legacy wrapper sets `ERA_GATE_RUNS` to `~/.local/state/era-gate-runs`; the
isolated runner bind-mounts that directory into its namespace and sets the
variable; when it is unset there is no store and no reuse, never an error):
the inputs manifest, the frozen plan, `results.jsonl`, every `.out`, the hub
log, the per-repo `git status --porcelain` including untracked files, the
environment block, and the summary. Each suite result is keyed by

```
K(suite) = H( runtime-hash                       inputs manifest restricted to files not under
                                                 tests/ or docs/ in any of the six repos, by
                                                 content only (no root paths, no port)
            | frozen collected digest             the suite copy after the port rewrite, so a
                                                 pass at 8378 is not evidence for 8388
            | collected helpers                   every non-suite file collected from the six
                                                 repos' tests/ (fixtures, invariants.mjs,
                                                 synthetic-wardrobe.mjs, pixel-audit/**)
            | the suite's own registry entry      not the whole registry; durations.json excluded
            | harness code                        era-gate.sh, lanes.mjs, reuse.mjs,
                                                 suite-runner.mjs, test-suite.mjs
            | runtime                             node version; playwright and playwright-core
                                                 versions and resolved paths; the chromium
                                                 revision and the sha256 of the browser binaries
                                                 actually present
            | environment block                   the gate exports fixed TZ and LANG and records
                                                 them; unsets ERA_AI_URL and
                                                 PLAYWRIGHT_BROWSERS_PATH unless passed explicitly
            | era-family/tools/era-scan.sh digest  read by era-scan-parity, outside the six roots )
```

This is the Bazel and Nx rule: a cached pass is as good as a fresh run exactly
when the key covers everything the suite can observe. What the key cannot
cover (system libraries, fonts, the wall-clock date that 38 suites read) is
bounded by age: a pass is reusable for at most 24 hours
(`ERA_GATE_MAX_EVIDENCE_AGE`, dad picks the number), the receipt records the
oldest evidence used, and a weekly uncached full gate catches drift.

What counts as a reusable pass: exit 0, TAP `fail`, `cancelled` and `todo`
all zero, `pass` equal to `tests`, no mandatory-coverage skip, the run's own
post-run checks passed (inputs unchanged, hub identity unchanged, execution
set complete, shared state clean), no untracked files under `tests/`,
`public/`, `app/` or `lib/` of any repo at the time, and not a pass after a
retry. Other suites failing in the same run do not disqualify a suite's pass;
that is the whole point. Legacy `.js` suites are reusable on exit 0 with a
parsed `0 failed`, and never retryable (no TAP to classify).

The key is deliberately coarse: any non-test, non-doc change anywhere
invalidates every suite, and 8 of the 11 landings since this worktree opened
touched such files. So reuse is not a typical landing's shortcut; it exists
for the cases that burned the time above:

| Situation | Today | With reuse |
| --- | --- | --- |
| One test file was wrong; fixed test-only | full gate, 35 min | that suite only, then compose: about 1 min plus the suite's own duration (17 s to 6 min; the median suite is under 10 s) |
| One suite failed on identical inputs | full gate | retry that suite once: same cost, recorded FLAKY |
| Docs-only change, or stamp expired while waiting | full gate or the docs-only exception | re-verify inputs, reuse every pass under 24 h old, restamp: under 1 min |
| Master moved by docs and tests of other features | full gate | only suites whose key changed |
| Gate died half way (host, memory, kill) | full gate | reuse the passes recorded before the crash whose post-suite guard snapshot was clean; else a lanes gate |
| New suite added | full gate | the new suite plus the always-on smoke set |
| Any product change (hub, board, pencil, core, words) | full gate | full gate, now 14 to 21 min |

Commands: `era-gate.sh` (full, cache-aware when a store is configured:
reuses passes whose key matches, runs the rest, composes),
`--rerun-failed <run-id>` (same inputs required; retries eligible failed
suites once), `--no-cache` (fresh everything), and `--restamp` (no suite may
need running; refreshes the stamp after verifying the manifest, within the
evidence age).

Acceptance meaning is preserved by construction: a stamp is written only when
every registered suite has a qualifying pass whose key matches the current
inputs, and the stamp keeps its exact 4-line form so `land`, `release.sh`,
`push-device.sh` and the isolated validator need no format change. Provenance
(which suites ran, which were reused from which run, which were retried, the
oldest evidence time) goes to `gate/receipt.json` and the run store;
`worktree.sh land` prints the receipt line, and `release.sh` prints it before
building. `at=` is the composition time; what binds the stamp to the inputs is
the manifest re-verification at that moment, which is stronger than the tree
sha the readers key on, plus the 24-hour evidence bound.

Retry policy (dad decides the numbers, section 8):

- a failed suite may be retried once, only on identical inputs, only if its
  output shows an assertion or timeout (never a collection, inputs or harness
  error), in a fresh shared hub;
- a failure recorded while the host was under pressure (`MemAvailable` below
  the floor or `full avg10` above 0.5 at the time) is classed `resource`: it
  is rerun with one lane fewer as a harness event and is never a flaky pass;
- a pass after a failure counts for the stamp but is recorded FLAKY in the
  receipt and in `$ERA_GATE_RUNS/flakes.jsonl` with the original output kept;
- more than one flaky suite in a gate turns it red;
- the ledger is keyed by `K(suite)`: a suite with two recorded failures on an
  identical key is no longer retry-eligible and stays red until its key
  changes or a `--no-cache` gate is green, so retry-until-green across
  invocations is impossible by construction;
- a flaky suite gets an owner and a deadline: a ledger entry older than seven
  days without a resolving commit removes that suite's retry eligibility
  (it must pass first time or be fixed), and the weekly report lists it;
- quarantine, if ever used, means "still runs, does not block", never
  "deleted".

This is the Surefire, Bazel and Playwright convention (pass-after-retry is
green, never silently, and budgeted) with two teeth the predecessor's
"do not retry until green" rule asked for: the ledger stops the second retry,
and the deadline stops the indefinite one.

Two guards back the composition argument:

- Static: the inventory in section 1. Registering a suite that writes to the
  shared hub requires `hub: shared-writer`, which excludes it from reuse and
  runs it solo. A registry test fails if the seed loses `profile.json` or if a
  shared-reader suite's route stubs stop covering the write paths.
- Dynamic: after the shared hub has warmed up and the awaited regenerate has
  run, the gate hashes the owned data copy; after each suite it takes a cheap
  mtime-and-size snapshot and after the last suite a full hash, ignoring an
  allowlist of hub-owned paths (logs, pool device heartbeats, the clothing
  worker's own files, weather and this-week caches, presence, tts and symbol
  caches). A difference outside the allowlist fails the gate, names the paths
  and marks the run non-reusable. `GET /settings` and `/clothing/status` are
  snapshotted before and after as a cheap check on in-memory state.

### 3.3 Focused development runs and agents that do not poll

Development: `era-gate.sh --only <suite...>` runs named suites in lanes with
no stamp and no reuse writes (the dev planner's affected mode already exists
and expands to full on any unknown path; it stays). Because the full gate is
cache-aware, the focused loop is: run the suites you are touching while you
work, then one cache-aware full gate, which costs only the keys that changed.

Agents: `tools/testing/gate-wait.sh <run-id|latest> [--max 570]` blocks until
the gate finishes or the time is up and prints one line (the running set and
done count, or the summary). A 20-minute gate is three calls; a 35-minute gate
is four. Sessions with a background-task facility use it instead. The house
rules gain: never poll a gate more often than every five minutes, never hand
a sub-agent a watch loop, start a full gate detached with a sentinel (the
parallel-worktrees corollary "never park a gate in a chat you're leaving" was
written when this box slept; it has been up for ten days, so the corollary is
re-verified and reconciled in the same change).

### 3.4 Composite cache

Product-side, not gate-side: 659 of 712 outfit composites a gate drew were
byte-identical redraws (about 90-130 CPU-s a gate), and every family rebuild
redraws the same looks. `outfit-cache.js` keys a look on its content: a
sha256 of a layout constant (size, split, padding, white-background crop,
quality; bump it when the drawing changes), tile A's bytes and tile B's bytes
or "solo", so a re-ingested or re-rotated tile is a new key. Pictures live in
`wardrobe-outfits/.cache/<key>.jpg`, written to a temp name and renamed;
`outfit_<i>.jpg` is a plain copy of one (no hardlinks), and the store is never
fed from an `outfit_<i>.jpg`, which the build overwrites in place while looks
swap places. `wardrobe-outfits/.composites.json` (written atomically) records
the keys this build and the build before it used; after a build everything
else is pruned (a rebuild of the same set does not start a new generation, so
yesterday survives a re-sort) and at most 400 files stay, this build's first,
then the oldest-used go. A torn index, a missing, empty or wrong-sized stored
file, or a store that cannot be written means drawing the look as before;
the build logs `[clothing] composites: N drawn, M reused`.

## 4. What changes where

| Piece | Change | Tests pinning it today |
| --- | --- | --- |
| `tools/era-gate.sh` | loop replaced by `lanes.mjs`; run store seam; `--rerun-failed`, `--restamp`, `--only`, `--no-cache`; awaited regenerate; data-dir guard; environment block | gate-safety (function names 13-18, digest and selection pins 281-304 and 376-449), gate-stamp (exact 4-line stamp, no pkill), chat-api 631-649 (launch line), assemble-suffix 104-143, parallel-gate (imports parallel-snapshot's validator) |
| `tools/testing/lanes.mjs` (new) | scheduler, classes, memory and pressure hold, lease coordination, results.jsonl, status.json, signal handling | new suite |
| `tools/testing/reuse.mjs` (new) | key computation, run store, qualifying-pass predicate, compose, flake ledger, evidence age | new suite with a negative case per key component |
| `tools/testing/durations.json` (new) | harvested durations; after lanes land, harvested from `results.jsonl` of green master gates | registry test |
| `tools/testing/registry.json` | real per-suite classes replacing the boilerplate triple (hub use, fixed ports, browser launches, heavy, solo, quiet, retry, owner), applied by a re-runnable transform | test-suite.test (validator accepts extra fields) |
| `tools/testing/parallel-worker.py`, `inside-worker.py`, `enter.sh` | bind-mount the run store read-write into the namespace; pass `ERA_GATE_RUNS` and `ERA_GATE_LANES`; `parseProgress` and `parallel-snapshot` accept `REUSE` lines and the receipt | parallel-gate.test, parallel-capacity.test |
| `server.js` / `clothing.js` | `ERA_CLOTHING_TICK_MS` seam only (hub port 0 is dropped: not needed for lanes) | routes, clothing tests |
| tests | 3 port collisions (new ports chosen from the suite band after a five-repo grep; candidates 8399, 8408, 8429); 3 `pkill` sites to pid kills; icons `/setup` made explicit | the suites themselves; a new registry test refuses duplicate ports and any port in 8377, 8378, 8380-8389, 8388, 8480 and up |
| `tools/testing/gate-wait.sh`, `tools/testing/flakes.mjs` (new) | blocking wait and one-line status; weekly flake report | new tests |
| `tools/release.sh` | prints the receipt before building; signed cuts run `--no-cache` unless the maintainer accepts a receipt explicitly | release tests |
| House repo (`aac-board-builder`, own worktree) | `worktree.sh land` prints the receipt line; parallel-worktrees page (lanes, reuse, docs-only exception superseded, rule 2 corollary reconciled); AGENTS router no-polling law; hygiene sweep carries the weekly gate result; `status.md` per landed phase; `system-map.html` flow | worktree.test.sh |
| docs here | dev-flow, strategy spec "future reuse" section marked implemented with the key, the two research notes marked superseded with a pointer, the two READMEs under `tools/testing/`, AGENTS laws | era-scan parity |

Not changed: stamp format, stamp readers' parsing, release shapes, Windows
runner and hosts, era-family, the live hub.

## 5. Risks and how they are held

| Risk | Mitigation |
| --- | --- |
| Memory pressure with lanes beside a second gate (host already swaps 3 GB) | memory floor with hysteresis and a pressure hold; per-suite RSS profiled before the default is fixed; suites' processes made more killable than the hub; legacy capped at two lanes while an isolated job is leased; dad's decision on resident sessions |
| Timing-sensitive suites flake under contention | `quiet`, `solo` and `heavy` classes; the benchmark keeps one-lane control runs and counts only failures that reproduce at a lane count and not in the control; twenty `--only` runs of the quiet set per lane count |
| A cache key that misses an input gives a false green | key covers all non-test, non-doc source, the collected copy, helpers, harness code, runtime, environment and the private scanner; untracked files block reuse; 24-hour evidence bound; a negative test per component; a weekly uncached gate in a dedicated worktree; `--no-cache` on demand |
| A retry hides a real race | one retry, budget of one, resource failures never flaky, two failures on one key end eligibility, seven-day owner deadline, ledger with the original output, receipt printed by land and release |
| Text-coupled tests and parsers break on the new loop | `RUN`, `PASS`, `FAIL`, `lock acquired` and the summary stay byte-compatible; the status parsers learn a running set; every pin is listed in the plan and updated with its intent intact |
| The gate in the main checkout re-points the live hub's `public/` links | unchanged law: no gate ever runs in the main checkout; the weekly uncached gate runs in a dedicated worktree, and its test refuses a non-worktree path |
| Sibling worktrees editing the same files | `era-gaze-launcher` carries unmerged edits to `registry.json`, `server.js` and `dev-flow.md` and is landed or synced before phase 1; `feat/testing-suite` is closed as superseded (its gate tooling reached master through the rollout); the stale worktrees are closed from outside them |

## 6. Expected results

| Scenario | Today | After phase 2 (lanes) | After phase 3 (reuse) |
| --- | --- | --- | --- |
| Clean full gate | 35 min | 19 to 21 min at 2 lanes; 14 to 17 at 3 once memory allows | same |
| Fixture-only fix after a red | 35 min | 19 to 21 min | about 1 min plus the suite |
| Single flaky failure | 35 min | 19 to 21 min | about 1 min plus the suite |
| Stamp expired, nothing changed, evidence under 24 h | 35 min | 19 to 21 min | under 1 min |
| Product change anywhere | 35 min | 19 to 21 min | 19 to 21 min |
| Two features gating at once (legacy + isolated) | about 36 min for the pair | unverified until measured; the legacy gate drops to two lanes while the isolated job runs | same, with reuse per feature |
| Agent tokens spent watching a gate | 24 to 35 % of a session | roughly half | a few percent |

A release candidate's path (Linux gate, build, Windows leg about 16 min, which
already overlaps the Linux run) drops from about 35 min of Linux plus Windows
to the Windows leg plus a few minutes, because the Linux gate finishes first.

## 7. Order of work and realistic effort

Phase 0 measure, sync and clear the ground (one day). Phase 1 prerequisites
(one and a half to two days; six small landings through today's 35-minute
gate). Phase 2 lanes, pins and the overnight benchmark (two to three days; the
first visible win). Phase 3 run store, reuse, rerun-failed, restamp, ledger,
isolated-runner plumbing, release and land receipts, docs (three to four
days). Phase 4 gate-wait, the no-polling law, `--only`, registry classes in
their final form (one day). Phase 5 later: declared dependencies with
selection validation; the Windows follow-ups the testing-suite session listed.
Seven to eleven agent-days in all, plus about ten landing gates. Details and
task boxes in the plan.

## 8. Decisions for dad

Each of the first three overturns a rule the testing-suite session wrote down
with reasons. Both sides are given.

1. **Retry.** Prior rule (strategy spec, "Do not retry until green. Preserve the
   initial failure"; speed-and-recovery note, priority 4): a pass after a
   retry hides races, and the only product bugs found this week were timing
   races. Proposed: one retry on identical inputs counts for landing, recorded
   FLAKY, budget of one per gate, resource failures never count as flaky, two
   failures on one key end eligibility, a seven-day owner deadline, and the
   receipt is printed by land and release. Recommended: yes. The prior rule
   cost about 5.7 hours of gates this week and found no product bug; the teeth
   above keep its intent.
2. **Composed stamps.** Prior rule (strategy spec: "must respect receipt age
   instead of refreshing the time of an old result"; gate-reuse-eligibility
   note: "approves no exception"): the readers can only check a tree sha and
   a time, so a refreshed time is a lie. Proposed: a stamp may be composed
   from reused passes plus fresh runs when the full inputs manifest matches,
   with `at=` at composition time, every reused pass under 24 hours old, and
   the provenance in a receipt that land and release print. Recommended: yes.
   The manifest check is stronger than the tree sha, and the age bound keeps
   what the 2-hour window was protecting.
3. **Restamp.** Prior rule as above. Proposed: a gate whose every suite is
   reused may refresh the stamp without running anything, inside the 24-hour
   evidence bound, replacing the docs-only exception with the general rule.
   Recommended: yes.
4. **Releases.** Proposed: patch cuts accept a cache-aware gate with the receipt
   printed; signed cuts run `--no-cache` unless the maintainer accepts a
   receipt explicitly; a weekly uncached full gate runs in a dedicated
   worktree and its result goes into the hygiene report. Recommended: yes.
5. **Memory.** The third lane is bought by memory, and the memory is held by
   resident agent sessions (0.3 to 1.3 GB each, 3.3 GB in swap). Proposed:
   close idle sessions before and during release windows; the benchmark then
   picks the lane default by its own rule, which is not a decision for dad.
   Recommended: yes.
6. **Agent rule.** Add the no-polling law to the house router and to
   `AGENTS.md`, and reconcile the "run the gate in the foreground" corollary.
   Recommended: yes.
