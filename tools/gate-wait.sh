#!/usr/bin/env bash
# gate-wait.sh — wait for a running era-gate without polling, then print its
# verdict: the summary line, the receipt line, any FAIL and FLAKY lines (with
# their `see gate/...` paths) and, when green, the stamp path.
#
#   bash tools/gate-wait.sh <gate pid> | --latest | --run <run-dir> [--timeout S]
#
# Exit 0 green, 1 red (or the gate ended without a receipt), 2 no such gate,
# 124 still running after S seconds (default 570, inside a 10-minute tool
# call; call it again). The no-polling law (AGENTS.md, docs/dev-flow.md
# "Waiting for a gate"): start the gate detached with its pid recorded, then
#   setsid nohup bash tools/era-gate.sh >"$LOG" 2>&1 & echo $! >"$PIDFILE"
#   bash tools/gate-wait.sh "$(cat "$PIDFILE")"
# How it blocks, finds the gate and reads the run: tools/testing/gate-wait.mjs.
exec node "$(dirname "$0")/testing/gate-wait.mjs" "$@"
