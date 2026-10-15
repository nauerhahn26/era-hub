#!/usr/bin/env bash
# pool-doctor.sh <pool-dir> — health checks for a family data pool (contract v1).
# Detects the failure modes a folder-synced pool can develop BEFORE an end user
# notices: missing structure, devices gone quiet (heartbeat), stale mirror.
# Output: POOL-OK / POOL-WARN lines; exit 1 if any WARN.
set -u
POOL="${1:?usage: pool-doctor.sh <pool-dir>}"
warn=0
w() { echo "POOL-WARN: $*"; warn=1; }
ok() { echo "POOL-OK: $*"; }
now=$(date +%s)

[ -f "$POOL/.pool-version" ] || w "missing .pool-version (not a pool, or syncer dropped it)"
[ -d "$POOL/events" ] || w "missing events/ dir"

# heartbeats: a device silent >26h is gone (26h tolerates DST + slow syncers)
if [ -d "$POOL/devices" ]; then
  n=0
  for hb in "$POOL"/devices/*.json; do
    [ -e "$hb" ] || continue
    n=$((n+1))
    age=$(( (now - $(stat -c %Y "$hb")) / 3600 ))
    dev=$(basename "$hb" .json)
    if [ "$age" -gt 26 ]; then w "device '$dev' heartbeat is ${age}h old"; else ok "device '$dev' alive (${age}h)"; fi
  done
  [ "$n" -eq 0 ] && w "no device heartbeats at all"
else
  w "missing devices/ dir"
fi

# mirror stamp: if this pool is mirrored, the stamp must be <26h old
if [ -f "$POOL/.last-mirror.json" ]; then
  age=$(( (now - $(stat -c %Y "$POOL/.last-mirror.json")) / 3600 ))
  if [ "$age" -gt 26 ]; then w "mirror is ${age}h stale (pool-mirror failing?)"; else ok "mirror fresh (${age}h)"; fi
fi

# torn/oversized event files (a syncer conflict artifact like "file (1).jsonl")
find "$POOL/events" -name "*conflict*" -o -name "* (1)*" 2>/dev/null | while read -r f; do
  w "syncer conflict artifact: $f"
done

exit $warn
