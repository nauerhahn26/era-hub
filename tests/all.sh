#!/usr/bin/env bash
# Full regression for Making Words Studio + The Pencil.
# Prereq: the studio server running locally →  node ../server.js 8377
# Run from this directory:  bash all.sh
set -u
cd "$(dirname "$0")"
pass=0; fail=0
for t in run parts transfer mistakes pencil narrow sortfix fltest bargein sortbugs rhymecount transfercount phonetic; do
  echo "== $t =="
  if timeout 420 node "$t.js"; then pass=$((pass+1)); else fail=$((fail+1)); fi
done
# node:test engine + contract suites (playwright against the live :8377 server).
# lib-contract is optional — skipped (not counted) if it isn't present yet.
for m in speech-overlap speech-engine dwell-engine lib-contract predict board-events invariants; do
  if [ ! -f "$m.test.mjs" ]; then echo "== $m == (skipped: not present)"; continue; fi
  echo "== $m =="
  if timeout 420 node --test "$m.test.mjs"; then pass=$((pass+1)); else fail=$((fail+1)); fi
done
echo "----------------------------------------"
echo "suites: $pass passed, $fail failed"
exit $fail
