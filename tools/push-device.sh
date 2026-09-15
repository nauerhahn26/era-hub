#!/usr/bin/env bash
# push-device.sh <host> <dist-dir> [--dry-run] — put ONE built dist onto ONE
# device without publishing anything (dev-flow spec §5.2, plan Phase 5).
#
# Usage:
#   bash tools/push-device.sh i13 dist/release-v0.33.3
#   bash tools/push-device.sh i13 dist/release-v0.33.3 --dry-run   # open the
#        tunnels, read the device's build, change nothing
#
# What it does: serves <dist-dir> on a loopback-only python http.server, opens
# ONE ssh session carrying two forwards — `-R <R>` so the device can fetch the
# feed from us, `-L <L>` so we can talk to the device's hub on 127.0.0.1:8377 —
# then POSTs {"feed":"http://127.0.0.1:<R>"} to the device's /update/check and
# polls /version until the new build is running. The device pulls; we never
# copy files onto it, never restart its hub, never touch its install any other
# way.
#
# PORT RULE (9/15 memory, non-negotiable): the local feed binds the first free
# port in 8480-8499 and the two tunnel ports are the first free in 8500-8599.
# NOTHING here may ever bind 8377-8462: those are the live hub, the suites and
# the gate's scratch hubs, and a tunnel squatting one of them answers HTTP as
# somebody else's hub (8381 reddened the gate 8/30; 8431 broke ai-key 9/14).
# Ports are checked with `ss -ltn` before binding, and other sessions' tunnels
# (8502/8503 on 9/15) are skipped the same way.
#
# LOOPBACK-ONLY RULE: the hub honours a {feed} override only when the request's
# SOCKET peer is the machine itself (server.js → updater.isLoopback). That is
# why the POST goes through the `-L` forward — it arrives at the device as a
# connection from 127.0.0.1 — and never to the device's LAN/Tailscale address,
# where the body would be silently ignored and the public feed checked instead.
# The route is ungated and reachable on the LAN; an unrestricted override would
# let anyone on a school network install code on the Tobii.
#
# THE DEVICE NEVER DOWNGRADES: the updater only moves when the feed's `build`
# stamp sorts strictly after the installed one, so pushing an older dist is a
# no-op. This script refuses before it opens anything when the device is
# already on a build >= the dist's.
#
# CHICKEN-AND-EGG: a device honours the override only once it runs a hub that
# has the §5.3 change, so the FIRST delivery of that hub is a normal release
# (patch or signed). An older hub ignores the body, runs a normal GitHub check
# and answers without a `feed` key — this script says so plainly instead of
# pretending the push happened.
set -euo pipefail

HUB="$(cd "$(dirname "$0")/.." && pwd)"
GREEN="${ERA_GATE_STAMPS:-/tmp/era-gate-green}"
DEVPORT=8377          # the hub's port on every device
FEED_LO=8480; FEED_HI=8499
TUN_LO=8500;  TUN_HI=8599

die() { echo "$*" >&2; exit 1; }

# ---------------------------------------------------------------- arguments
HOST=""; DIST=""; DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -*) die "unknown flag $a — usage: push-device.sh <host> <dist-dir> [--dry-run]" ;;
    *) if [ -z "$HOST" ]; then HOST="$a"; elif [ -z "$DIST" ]; then DIST="$a";
       else die "too many arguments — usage: push-device.sh <host> <dist-dir> [--dry-run]"; fi ;;
  esac
done
[ -n "$HOST" ] && [ -n "$DIST" ] || die "usage: push-device.sh <host> <dist-dir> [--dry-run]"

# ------------------------------------------------------- 1. preconditions
# host: an alias that actually exists in ~/.ssh/config. Typing a hostname or a
# typo would otherwise fail much later, after the feed and the tunnels are up.
ALIASES="$(awk 'tolower($1)=="host"{for(i=2;i<=NF;i++) if ($i !~ /[*?]/) print $i}' "$HOME/.ssh/config" 2>/dev/null | sort -u)"
case $'\n'"$ALIASES"$'\n' in
  *$'\n'"$HOST"$'\n'*) ;;
  *) die "unknown device '$HOST' — ssh aliases available: $(echo "$ALIASES" | tr '\n' ' ')" ;;
esac

[ -d "$DIST" ] || die "no such dist dir: $DIST"
DIST="$(cd "$DIST" && pwd)"
for f in latest.json new-era-suite.tar.gz checksums.txt; do
  [ -f "$DIST/$f" ] || die "dist is incomplete — $DIST/$f is missing (build it with tools/build-dist.sh)"
done

# tiny JSON readers: python3 rather than grep, so a reshaped latest.json or a
# hub error page fails loudly instead of matching by luck.
jget() { python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
k=sys.argv[1]
sys.stdout.write("" if not isinstance(d,dict) or d.get(k) is None else str(d[k]))
' "$1"; }
jhas() { python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
sys.exit(0 if isinstance(d,dict) and sys.argv[1] in d else 1)
' "$1"; }

DISTBUILD="$(jget build <"$DIST/latest.json")"
DISTVER="$(jget version <"$DIST/latest.json")"
DISTSHA="$(jget sha256 <"$DIST/latest.json")"
[ -n "$DISTBUILD" ] || die "latest.json has no build stamp — $DIST/latest.json is not a release feed"

REALSHA="$(sha256sum "$DIST/new-era-suite.tar.gz" | cut -d' ' -f1)"
[ "$REALSHA" = "$DISTSHA" ] || die "tarball does not match latest.json — sha256 is $REALSHA, latest.json says ${DISTSHA:-<none>}; rebuild the dist"

# The tree this dist was built from (build-dist.sh writes $DIST/TREE). Without
# it we can only ask git what THIS checkout is on, which may have moved.
if [ -s "$DIST/TREE" ]; then
  IFS= read -r TREE <"$DIST/TREE" || TREE=""
else
  TREE="$(git -C "$HUB" rev-parse 'HEAD^{tree}' 2>/dev/null || true)"
  echo "WARNING: $DIST/TREE is missing — using this checkout's tree ${TREE:0:7}; the dist may not match the checkout"
fi
[ -n "$TREE" ] || die "cannot determine the dist's tree sha (no $DIST/TREE and $HUB is not a git checkout)"

# Green stamp, same acceptance rule as release.sh step 1: it exists, its first
# line is a green summary, and its at= is under 2 h old. No pipes (a `grep -q`
# under pipefail is how the signing rail learned about SIGPIPE, 9/5).
stamp_ok() {
  local first at now
  [ -f "$1" ] || return 1
  IFS= read -r first <"$1" || return 1
  case "$first" in *" 0 failed"*) ;; *) return 1;; esac
  at="$(awk -F= '/^at=/{print $2; exit}' "$1")"
  [ -n "$at" ] || return 1
  now="$(date +%s)"
  [ $(( now - at )) -lt 7200 ]
}
stamp_ok "$GREEN/$TREE" || die "no green gate under 2 h for tree ${TREE:0:7} — run \`bash tools/era-gate.sh\` in the worktree"
STAMPAT="$(awk -F= '/^at=/{print $2; exit}' "$GREEN/$TREE")"
echo "gated tree ${TREE:0:7}, green $(date -d "@$STAMPAT" +%H:%M) — $(sed -n 1p "$GREEN/$TREE")"

# ------------------------------------------------------------- 2. ports
# `ss -ltn` is a snapshot, so the picker also refuses the forbidden band
# outright rather than trusting the range constants alone.
USED="$(ss -ltn 2>/dev/null | awk 'NR>1{p=$4; sub(/.*:/,"",p); print p}' | sort -u)"
TAKEN=""
# Assigns to the variable NAMED in $1 rather than echoing: a command
# substitution would run this in a subshell and every call would hand back the
# same port ($TAKEN never coming back). -R and -L living on the same number
# happens to work (different machines) but reads as one port and would collide
# the moment a third forward is added.
pick_port() {
  local var="$1" lo="$2" hi="$3" p
  for (( p=lo; p<=hi; p++ )); do
    [ "$p" -ge 8377 ] && [ "$p" -le 8462 ] && continue   # live hub / suites / scratch hubs
    case $'\n'"$USED"$'\n' in *$'\n'"$p"$'\n'*) continue;; esac
    case " $TAKEN " in *" $p "*) continue;; esac
    TAKEN="$TAKEN $p"; printf -v "$var" '%s' "$p"; return 0
  done
  return 1
}
pick_port P "$FEED_LO" "$FEED_HI" || die "no free port in $FEED_LO-$FEED_HI for the local feed"
pick_port R "$TUN_LO" "$TUN_HI"   || die "no free port in $TUN_LO-$TUN_HI for the reverse tunnel"
pick_port L "$TUN_LO" "$TUN_HI"   || die "no free port in $TUN_LO-$TUN_HI for the forward tunnel"

WORK="$(mktemp -d /tmp/push-device.XXXXXX)"
FEED_PID=""; SSH_PID=""; DEVBUILD=""
cleanup() {
  local rc=$?
  [ -n "$SSH_PID" ]  && kill "$SSH_PID"  2>/dev/null || true   # by pid, never pkill -f (9/x)
  [ -n "$FEED_PID" ] && kill "$FEED_PID" 2>/dev/null || true
  [ -n "$SSH_PID" ]  && wait "$SSH_PID"  2>/dev/null || true
  [ -n "$FEED_PID" ] && wait "$FEED_PID" 2>/dev/null || true
  rm -rf "$WORK"
  if [ -n "$DEVBUILD" ]; then
    echo "$HOST is on $DEVBUILD — the public feed will move it to the next published build; nothing was published"
  fi
  exit "$rc"
}
trap cleanup EXIT

echo "== feed: serving $DIST on 127.0.0.1:$P =="
python3 -m http.server "$P" --bind 127.0.0.1 --directory "$DIST" >"$WORK/feed.log" 2>&1 &
FEED_PID=$!
for _ in $(seq 1 50); do
  curl -fsS -m 2 "http://127.0.0.1:$P/latest.json" >/dev/null 2>&1 && break
  kill -0 "$FEED_PID" 2>/dev/null || die "local feed died on :$P — $(cat "$WORK/feed.log")"
  sleep 0.2
done
curl -fsS -m 2 "http://127.0.0.1:$P/latest.json" >/dev/null || die "local feed never answered on :$P"

# ------------------------------------------------------------ 3. tunnels
echo "== tunnels: -R $R → feed :$P, -L $L → $HOST:$DEVPORT =="
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
    -R "$R:127.0.0.1:$P" -L "$L:127.0.0.1:$DEVPORT" "$HOST" >"$WORK/ssh.log" 2>&1 &
SSH_PID=$!

VJSON=""
for _ in $(seq 1 30); do
  if ! kill -0 "$SSH_PID" 2>/dev/null; then
    case "$(cat "$WORK/ssh.log")" in
      *"remote port forwarding failed"*) die "ssh -R $R refused by $HOST (remote port forwarding failed) — pick another tunnel port or check sshd_config GatewayPorts/AllowTcpForwarding" ;;
    esac
    die "ssh session to $HOST died: $(cat "$WORK/ssh.log")"
  fi
  VJSON="$(curl -fsS -m 3 "http://127.0.0.1:$L/version" 2>/dev/null || true)"
  [ -n "$VJSON" ] && break
  sleep 1
done
[ -n "$VJSON" ] || die "no answer from $HOST's hub on 127.0.0.1:$DEVPORT through -L $L after 30 s — is the hub running? ($(cat "$WORK/ssh.log"))"

DEVBUILD="$(jget build <<<"$VJSON")"
DEVVER="$(jget version <<<"$VJSON")"
[ -n "$DEVBUILD" ] || die "$HOST's /version carries no build stamp: $VJSON"
echo "device: $HOST on build $DEVBUILD${DEVVER:+ ($DEVVER)}"

# No downgrade — the updater compares build stamps as strings and only moves
# forward, so an older or equal dist would be a silent no-op.
if ! [[ "$DISTBUILD" > "$DEVBUILD" ]]; then
  die "device already on $DEVBUILD ≥ $DISTBUILD — nothing to push"
fi

# Prove the reverse leg from the device's own side before asking it to update:
# if the device cannot reach our feed, /update/check would answer feed-error.
RFEED="$(ssh -o BatchMode=yes "$HOST" "curl.exe -s http://127.0.0.1:$R/latest.json" 2>"$WORK/rcurl.log" || true)"
RBUILD="$(jget build <<<"$RFEED")"
[ "$RBUILD" = "$DISTBUILD" ] || die "device cannot reach the feed through -R $R — $HOST fetched '${RFEED:-<nothing>}' ($(cat "$WORK/rcurl.log"))"
echo "reverse leg: $HOST reads our feed on :$R and sees build $RBUILD"

# ------------------------------------------------------------ 4. dry run
if [ "$DRY" = 1 ]; then
  echo "DRY RUN: $HOST on $DEVBUILD, would push $DISTBUILD (tree ${TREE:0:7}) via -R $R ← :$P"
  exit 0
fi

# ------------------------------------------------------------- 5. the push
echo "== update: POST /update/check {\"feed\":\"http://127.0.0.1:$R\"} through -L $L =="
RESP="$(curl -sS -m 300 -X POST -H 'content-type: application/json' \
        --data "{\"feed\":\"http://127.0.0.1:$R\"}" \
        "http://127.0.0.1:$L/update/check" || true)"
echo "$RESP"
[ -n "$RESP" ] || die "no answer from /update/check"

if ! jhas feed <<<"$RESP"; then
  die "device hub predates the feed override — deliver v0.33.3 first (it ignored the body and ran a normal public-feed check)"
fi
STATUS="$(jget status <<<"$RESP")"
[ "$STATUS" = "updated" ] || die "update did not apply: status=$STATUS — nothing changed on $HOST"

# ------------------------------------------------------------- 6. confirm
# The hub restarts ~1 s after answering "updated", so curl failures here are
# expected for a few seconds — keep polling rather than giving up on the first.
echo "== confirm: polling /version for $DISTBUILD (up to 90 s) =="
NOW=""
for _ in $(seq 1 30); do
  sleep 3
  VJSON="$(curl -fsS -m 3 "http://127.0.0.1:$L/version" 2>/dev/null || true)"
  [ -n "$VJSON" ] || continue
  NOW="$(jget build <<<"$VJSON")"
  [ -n "$NOW" ] || continue
  DEVBUILD="$NOW"
  if [ "$NOW" = "$DISTBUILD" ]; then
    NOWVER="$(jget version <<<"$VJSON")"
    echo "pushed: $HOST now on $NOW (${NOWVER:-$DISTVER})"
    echo "note: app packs still come from the public feed (server.js downloads packs from updater.FEED)"
    exit 0
  fi
done
die "timed out after 90 s — $HOST last reported build ${NOW:-<no answer>}, wanted $DISTBUILD"
