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

rm -rf "$GATE"; mkdir -p "$GATE"
for repo in era-core era-making-words era-pencil era-board era-hub; do
  [ -d "$ROOT/$repo/tests" ] || continue
  for f in "$ROOT/$repo"/tests/*; do
    base="$(basename "$f")"
    [ -d "$f" ] && { cp -r "$f" "$GATE/$base"; continue; }
    cp "$f" "$GATE/$base"
  done
done
# re-point the live-server port in the gate copies only
grep -rlZ "8377" "$GATE" 2>/dev/null | xargs -0 -r sed -i "s/8377/$PORT/g"

# start the hub test instance (killing any stale holder of the TEST port first —
# a survivor from a killed session otherwise fails every live-server suite with
# EADDRINUSE; bracket trick so pkill never matches this script's own cmdline)
pkill -f "[n]ode .*server.js $PORT" 2>/dev/null; sleep 0.5
ERA_DATA_DIR="$DATA" ERA_BIND=127.0.0.1 node "$HUB/server.js" "$PORT" >"$GATE/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/settings" >/dev/null && break; sleep 0.3; done
curl -sf "http://127.0.0.1:$PORT/settings" >/dev/null || { echo "FATAL: test server did not start"; cat "$GATE/server.log"; exit 1; }

cd "$GATE"
pass=0; fail=0; failed=""
# legacy CJS playwright suites (same set as aac-studio tests/all.sh)
for t in run parts transfer mistakes pencil narrow sortfix fltest bargein sortbugs rhymecount transfercount phonetic; do
  [ -f "$t.js" ] || continue
  if node "$t.js" >"$t.out" 2>&1; then pass=$((pass+1)); echo "PASS $t";
  else fail=$((fail+1)); failed="$failed $t"; echo "FAIL $t (see gate/$t.out)"; fi
done
# node:test suites
for t in *.test.mjs; do
  if node --test "$t" >"${t%.mjs}.out" 2>&1; then pass=$((pass+1)); echo "PASS $t";
  else fail=$((fail+1)); failed="$failed $t"; echo "FAIL $t (see gate/${t%.mjs}.out)"; fi
done
echo "== era-gate: $pass passed, $fail failed${failed:+ →$failed} =="
[ "$fail" -eq 0 ]
