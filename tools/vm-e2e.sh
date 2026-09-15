#!/usr/bin/env bash
# vm-e2e.sh <candidate dist dir> [<previous New-ERA-Setup.exe>] [--only a|b] [--post-publish]
# Tier 2 of the deploy gate (docs/e2e-deploy-gate-plan.md, dad 9/3): the
# candidate release installed on a pristine Windows 10 VM and driven through
# the REAL kiosk window — install, welcome wizard, apps, door, settings,
# packs-later, open-url (leg A); the previous release self-updating to the
# candidate without a reinstall (leg B). Unattended; release.sh runs it after
# the payload is built and refuses to publish on anything but 0 failed.
#   candidate dist dir = tools/release.sh's $DIST: New-ERA-Setup.exe,
#                        latest.json, new-era-suite.tar.gz
#   previous installer = the release the family already has (leg B's start);
#                        default: the newest dist/release-*/ whose version is
#                        TAGGED here (release.sh tags only when it publishes,
#                        so a dry-run artefact is never "what the family has" —
#                        9/5: v0.32.1's leg B picked the unpublished v0.32.0
#                        cut over the v0.31.7 in the field); newest of all
#                        when none is tagged — LOUDLY (a WARNING line and an
#                        UNTAGGED mark in the banner): that is the pre-9/5
#                        behaviour back again, and a green leg B from a build
#                        no family has is not the family's upgrade path (a
#                        pruned dist/, as after the 9/3 disk-full, or a
#                        checkout without its tags, is how it happens);
#                        in PATCH mode (latest.json's `installer` names another
#                        release's exe) the default is $DIST's own Setup.exe —
#                        the re-attached one IS what the family already has
#   --post-publish     leg C only (the published download fetched in Edge on the
#                      guest and opened by the shell): run AFTER gh release create
# Needs era-family/data/vm.env (QA host + guest credentials) and the driver
# scripts in era-family/tools/vm. Output: gate/vm-e2e/ (screenshots, logs).
set -uo pipefail
HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
VMT="$ROOT/era-family/tools/vm"
DIST="${1:?usage: vm-e2e.sh <candidate dist dir> [prev Setup.exe] [--only a|b] [--post-publish]}"; shift
PREV=""; ONLY=""; PREV_UNTAGGED=""; POST=0
while [ $# -gt 0 ]; do case "$1" in --only) ONLY="$2"; shift 2;; --post-publish) POST=1; ONLY=c; shift;; *) PREV="$1"; shift;; esac; done
FEED_PORT=8427
OUT="$HUB/gate/vm-e2e"; rm -rf "$OUT"; mkdir -p "$OUT"

# machine-wide: one VM, one run at a time (the 8/24 two-session lesson)
exec 9>/tmp/era-vm-e2e.lock
flock -w 7200 9 || { echo "vm-e2e: another run holds the VM lock"; exit 1; }

if [ "$POST" = 1 ]; then
  # leg C downloads the PUBLISHED asset from the real website; all it needs from
  # $DIST is the sha256 it must match (checksums.txt, read by the leg itself).
  [ -f "$DIST/checksums.txt" ] || { echo "vm-e2e: $DIST/checksums.txt missing — leg C has nothing to compare the bytes against"; exit 2; }
else
for f in New-ERA-Setup.exe latest.json new-era-suite.tar.gz; do
  [ -f "$DIST/$f" ] || { echo "vm-e2e: $DIST/$f missing"; exit 2; }
done
# A patch release re-attaches a previous cut's signed installer, and $DIST's own
# Setup.exe IS therefore the one the family already runs — leg B starts from it.
PATCH_INSTALLER="$(python3 -c "import json;d=json.load(open('$DIST/latest.json'));i=d.get('installer');print(i if i and i!=d['version'] else '')" 2>/dev/null || true)"
if [ -z "$PREV" ] && [ -n "$PATCH_INSTALLER" ]; then PREV="$DIST/New-ERA-Setup.exe"; fi
if [ -z "$PREV" ]; then
  for p in $(ls -dt "$ROOT"/dist/release-*/New-ERA-Setup.exe 2>/dev/null | grep -v "^$DIST/"); do
    v="$(basename "$(dirname "$p")")"; v="${v#release-}"
    if git -C "$HUB" tag -l "$v" | grep -qx "$v"; then PREV="$p"; break; fi
  done
  if [ -z "$PREV" ]; then
    # the pre-9/5 pick, and it says so: the "previous" banner line alone did
    # not catch the v0.32.0 mistake, so the fallback gets a line of its own
    PREV="$(ls -dt "$ROOT"/dist/release-*/New-ERA-Setup.exe 2>/dev/null | grep -v "^$DIST/" | head -1)"
    [ -n "$PREV" ] && { PREV_UNTAGGED=1; echo "vm-e2e: WARNING no TAGGED dist/release-* under $ROOT/dist - falling back to the UNTAGGED $PREV; leg B self-updates from a build no family has (pass the family's installer as the 2nd argument)"; }
  fi
  [ -n "$PREV" ] || { echo "vm-e2e: no previous installer found under $ROOT/dist"; exit 2; }
fi
[ -f "$PREV" ] || { echo "vm-e2e: previous installer $PREV missing"; exit 2; }
fi

. "$VMT/env.sh" || exit 2
if [ "$POST" = 1 ]; then
  echo "== vm-e2e: post-publish leg C only — the published download, fetched and opened on the guest; expected sha from $DIST/checksums.txt =="
else
  VER="$(python3 -c "import json;print(json.load(open('$DIST/latest.json'))['version'])")"
  BUILD="$(python3 -c "import json;print(json.load(open('$DIST/latest.json'))['build'])")"
  if [ -n "$PATCH_INSTALLER" ]; then PREV_NOTE=" (installer $PATCH_INSTALLER re-attached)"; else PREV_NOTE="${PREV_UNTAGGED:+ (UNTAGGED - not a published release)}"; fi
  echo "== vm-e2e: candidate $VER ($BUILD) from $DIST; previous = $PREV$PREV_NOTE =="

  echo "-- assets -> QA host"
  $DROP "mkdir -p /root/qa/feed && rm -f /root/qa/feed/hits.log /root/qa/feed/hold" || exit 3
  rsync -q -e "ssh -i $VM_SSH_KEY" "$DIST/New-ERA-Setup.exe" root@$VM_DROPLET:/root/qa/candidate.exe || exit 3
  rsync -q -e "ssh -i $VM_SSH_KEY" "$PREV" root@$VM_DROPLET:/root/qa/prev.exe || exit 3
  rsync -q -e "ssh -i $VM_SSH_KEY" "$DIST/latest.json" "$DIST/new-era-suite.tar.gz" root@$VM_DROPLET:/root/qa/feed/ || exit 3
  rsync -q -e "ssh -i $VM_SSH_KEY" "$VMT/feed.py" root@$VM_DROPLET:/root/qa/feed.py || exit 3

  echo "-- feed + Resend stand-in on the QA host :$FEED_PORT"
  $DROP "pkill -f '^python3 /root/qa/feed.py' ; sleep 0.5; nohup python3 /root/qa/feed.py /root/qa/feed $FEED_PORT >/root/qa/feed.log 2>&1 & sleep 1; curl -sf http://127.0.0.1:$FEED_PORT/latest.json" \
    | grep -q "$VER" || { echo "vm-e2e: feed did not come up"; exit 3; }
fi

# local :9222 -> QA host :9223 -> (vm.sh cdp-forward, through the guest's sshd,
# re-made after every kiosk launch) -> the kiosk's DevTools port
echo "-- DevTools tunnel :9222 (local) -> QA host :9223"
pkill -f "^ssh -f -N -L 9222:127.0.0.1:9223" 2>/dev/null; sleep 0.5
ssh -f -N -L 9222:127.0.0.1:9223 -o ExitOnForwardFailure=yes -i "$VM_SSH_KEY" root@$VM_DROPLET || { echo "vm-e2e: tunnel failed"; exit 3; }
cleanup() { pkill -f "^ssh -f -N -L 9222:127.0.0.1:9223" 2>/dev/null; $DROP "pkill -f '^python3 /root/qa/feed.py'; pkill -f '^ssh -p $VM_GUEST_SSH_PORT .*-L 9223:'" 2>/dev/null; }
trap cleanup EXIT

export VM_OUT="$OUT" VM_GUEST_USER VM_CANDIDATE_VERSION="${VER:-}" VM_CANDIDATE_BUILD="${BUILD:-}" VM_FEED_PORT="$FEED_PORT"
export VM_DIST="$DIST"   # leg C reads the expected sha256 out of $DIST/checksums.txt
pass=0; fail=0
run_leg() {
  local name="$1" file="$2"
  [ -n "$ONLY" ] && [ "$ONLY" != "$name" ] && return 0
  echo "-- leg $name: $file"
  # `node <file>` (not `node --test <file>`): the runner buffers a whole file's
  # TAP until it ends; run directly, node:test streams every ok/not ok live
  ( cd "$HUB" && node "tests-vm/$file" ) > "$OUT/leg-$name.log" 2>&1
  local rc=$? p f
  p="$(sed -n 's/^# pass \([0-9]*\)$/\1/p' "$OUT/leg-$name.log" | tail -1)"; f="$(sed -n 's/^# fail \([0-9]*\)$/\1/p' "$OUT/leg-$name.log" | tail -1)"
  pass=$((pass + ${p:-0})); fail=$((fail + ${f:-0}))
  if [ $rc -eq 0 ] && [ "${f:-1}" = 0 ]; then echo "PASS leg $name (${p:-0} tests)"
  else [ "${f:-0}" = 0 ] && fail=$((fail+1)); echo "FAIL leg $name (see $OUT/leg-$name.log)"; grep -E "^not ok|error:|Error:" "$OUT/leg-$name.log" | head -20; fi
}
if [ "$POST" = 1 ]; then
  run_leg c leg-c-smartscreen.e2e.mjs
else
  run_leg a leg-a-fresh.e2e.mjs
  run_leg b leg-b-update.e2e.mjs
  $SCP_DROP root@$VM_DROPLET:/root/qa/feed/hits.log "$OUT/feed-hits.log" 2>/dev/null
fi
echo "== vm-e2e: $pass passed, $fail failed =="
[ $fail -eq 0 ]
