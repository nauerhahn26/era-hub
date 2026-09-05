#!/usr/bin/env bash
# era-gate.sh — the L0/L1 parity gate for the New ERA workspace.
# Collects every sibling repo's test suite into gate/ (copies, port re-pointed
# to the test instance), starts the hub server on $ERA_TEST_PORT (default 8378,
# NEVER the live 8377), runs the suites, reports.
set -uo pipefail
HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
DATA="${ERA_DATA_DIR:-$ROOT/era-family/test-data}"  # gate NEVER points at live data
PORT="${ERA_TEST_PORT:-8378}"
GATE="$HUB/gate"
# optional private env (e.g. ERA_GAZE_SRC until era-gaze is imported)
[ -f "$ROOT/era-family/gate-env.sh" ] && . "$ROOT/era-family/gate-env.sh"

# one gate at a time, machine-wide: concurrent runs (e.g. two feature worktrees)
# thrash CPU and can fight over default ports — the second run WAITS its turn.
# (Born of the 8/24 two-session collision; see aac-board-builder
# docs/parallel-worktrees.md.)
LOCK="/tmp/era-gate.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "== era-gate: another gate run is active — queued, waiting… =="; flock 9; }

# a fresh worktree checkout has a bare public/ (the symlink farm is untracked)
# — assemble it against the gate's data dir so the test hub serves the apps.
[ -e "$HUB/public/pencil" ] || ERA_DATA_DIR="$DATA" bash "$HUB/tools/assemble.sh"

rm -rf "$GATE"; mkdir -p "$GATE"
# era-hub's own suites come from THIS checkout ($HUB) so a feature-worktree
# gate runs the worktree's new/changed suites, not the main checkout's copy
# (identical when run from the main checkout, where $HUB = $ROOT/era-hub).
for repo in era-core era-making-words era-pencil era-board era-hub; do
  # era-hub's suites come from THIS checkout — in a worktree gate, a suite
  # added on the feature branch must run too (8/28: routes.test.mjs silently
  # skipped because the collector only looked at the main checkout).
  src="$ROOT/$repo"; [ "$repo" = "era-hub" ] && src="$HUB"
  [ -d "$src/tests" ] || continue
  for f in "$src"/tests/*; do
    base="$(basename "$f")"
    [ -d "$f" ] && { cp -r "$f" "$GATE/$base"; continue; }
    cp "$f" "$GATE/$base"
  done
done
# re-point the live-server port in the gate copies only
grep -rlZ "8377" "$GATE" 2>/dev/null | xargs -0 -r sed -i "s/8377/$PORT/g"

# Every provider seam points at a closed port, gate-wide: the gate's data dir
# holds a REAL ElevenLabs credential, and a hub reaches out on its own — the
# /content/status poll asks ElevenLabs for the month's voice left (T6b.1), the
# 20 s clothing tick asks ipapi/Open-Meteo for the weather, a Resend send is a
# real email, fal spends per press. Since 9/5 (Phase 7 review) that is true for
# every hub a suite spawns with `...process.env`, not just the shared one —
# the "no test spends a key" guarantee used to rest on the data dir happening
# to hold no vision/fal/TMDB key. Answered by the kernel (connection refused);
# the hub logs it and serves `narration: null`. Every suite that needs a seam
# to WORK stands up its own stand-in, which overrides these. ERA_AI_URL stays
# unset gate-wide (unset means "the provider's real base" in
# content-providers.js and suites test that shape); the shared hub plugs it.
export ERA_ELEVEN_URL="http://127.0.0.1:1" ERA_FAL_URL="http://127.0.0.1:1" \
  ERA_GEO_URL="http://127.0.0.1:1/geo" ERA_WEATHER_URL="http://127.0.0.1:1" \
  ERA_RESEND_URL="http://127.0.0.1:1" ERA_TMDB_URL="http://127.0.0.1:1" \
  ERA_STREAMING_URL="http://127.0.0.1:1"

# start the hub test instance (killing any stale holder of the TEST port first —
# a survivor from a killed session otherwise fails every live-server suite with
# EADDRINUSE; bracket trick so pkill never matches this script's own cmdline)
pkill -f "[n]ode .*server.js $PORT" 2>/dev/null; sleep 0.5
ERA_DATA_DIR="$DATA" ERA_BIND=127.0.0.1 ERA_AI_URL="http://127.0.0.1:1" \
  node "$HUB/server.js" "$PORT" >"$GATE/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/settings" >/dev/null && break; sleep 0.3; done
curl -sf "http://127.0.0.1:$PORT/settings" >/dev/null || { echo "FATAL: test server did not start"; cat "$GATE/server.log"; exit 1; }

cd "$GATE"
pass=0; fail=0; failed=""
# legacy CJS playwright suites (same set as aac-studio tests/all.sh)
for t in run parts transfer mistakes pencil narrow sortfix fltest bargein sortbugs rhymecount transfercount phonetic; do
  [ -f "$t.js" ] || continue
  if timeout 420 node "$t.js" >"$t.out" 2>&1; then pass=$((pass+1)); echo "PASS $t";
  else fail=$((fail+1)); failed="$failed $t"; echo "FAIL $t (see gate/$t.out)"; fi
done
# node:test suites
# 900 s, not 600: clothing.test.mjs decodes and re-encodes real photographs and
# takes ~607 s on this box, so the old ceiling cut it mid-subtest and the gate
# went red with no `not ok` and no assertion in the .out file — a failure that
# looks like a bug and is only a stopwatch. A suite that genuinely wedges still
# stops the gate, five minutes later.
for t in *.test.mjs; do
  if timeout 900 node --test "$t" >"${t%.mjs}.out" 2>&1; then pass=$((pass+1)); echo "PASS $t";
  else fail=$((fail+1)); failed="$failed $t"; echo "FAIL $t (see gate/${t%.mjs}.out)"; fi
done
echo "== era-gate: $pass passed, $fail failed${failed:+ →$failed} =="
[ "$fail" -eq 0 ]
