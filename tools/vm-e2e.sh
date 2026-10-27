#!/usr/bin/env bash
# vm-e2e.sh <candidate dist dir> [<previous installer .exe>] [--only a|b] [--post-publish] [--profile full|quiet]
# Tier 2 of the deploy gate (docs/e2e-deploy-gate-plan.md, dad 9/3): the
# candidate release installed on a pristine Windows 10 VM and driven through
# the REAL kiosk window — install, welcome wizard, apps, door, settings,
# packs-later, open-url (leg A); the previous release self-updating to the
# candidate without a reinstall (leg B). Unattended; release.sh runs it after
# the payload is built and refuses to publish on anything but 0 failed.
#   candidate dist dir = tools/release.sh's $DIST: latest.json, the installer it
#                        names (`installer_file`: Our-Era-Comms-Setup.exe since
#                        the 9/26 rename; a latest.json without the field is a
#                        New-ERA-Setup.exe cut), new-era-suite.tar.gz
#   previous installer = the release the family already has (leg B's start);
#                        default: the LIVE installer release.sh downloaded into
#                        $DIST/prev/ (by the live latest.json's installer_file);
#                        else the newest dist/release-*/ whose version is
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
#                        the re-attached one IS what the family already has.
#                        Every dist's installer is found by the name ITS OWN
#                        latest.json records, never by a loose *Setup.exe glob
#                        (9/9: OneDriveSetup.exe contains "setup.exe")
#   $DIST/prev/New-ERA-Setup.exe, when present: leg A also installs that OLD
#                        installer on a fresh snapshot and runs the candidate
#                        over it — the rename's upgrade path (.onInit moves the
#                        folder, leaves a junction, one Apps entry). Absent: that
#                        step skips and says so.
#   --post-publish     leg C only (the published download fetched in Edge on the
#                      guest and opened by the shell): run AFTER gh release create
#   --profile full|quiet  the Windows guest the legs drive (default full).
#                      full  = the pristine template snapshot as a family PC has it:
#                              Defender on, its post-restore signature update and scan
#                              waited out (vm.quiet(), ~7 min). Every SIGNED cut, legs
#                              A, B and C: a signed installer was hash-flagged once.
#                      quiet = the template's separately named quiet snapshot: the
#                              same Windows with Defender (real-time protection,
#                              scheduled and update scans, signature updates) and
#                              Windows Update off for the life of the leg; the wait is a
#                              bounded readiness check. release.sh --patch picks it: a
#                              patch ships no installer, only app files under the signed
#                              one. Leg C refuses it. tests-vm/lib/guest-profile.mjs.
# Needs era-family/data/vm.env (QA host + guest credentials) and the driver
# scripts in era-family/tools/vm. Output: gate/vm-e2e/ (screenshots, logs).
#
# TWO RUNS AT ONCE (10/27): up to QA_MAX_HOSTS (default 2) runs from different trees
# go side by side, each on its own QA host (qa.sh up makes a second host when the first
# is held). A run takes a numbered run slot (/tmp/era-vm-e2e.lock is slot 1, as before;
# slot n>1 is /tmp/era-vm-e2e.<n>.lock), drives THE host qa.sh up named on its last line
# (QA_HOST=..., exported as VM_DROPLET, which env.sh keeps over data/vm.env's), and opens
# its own DevTools tunnel on a local port of its own (9222 for slot 1, 9232 for slot 2,
# the next free one when taken), handed to the legs as VM_CDP; cleanup kills that
# tunnel's pid and nothing else. One run at a time per tree (gate/vm-e2e) and per dist
# dir ($DIST/VM-GREEN): a second one waits.
#
# VM-GREEN — the marker release.sh will not publish without. A run that finishes
# with 0 failed writes $DIST/VM-GREEN naming the legs that actually ran
# (legs=a,b for a full run, legs=b for the patch shape's --only b), the sha256 of
# the new-era-suite-<V>.tar.gz those legs drove, the epoch it happened and the
# guest profile they drove (profile=full|quiet; a signed cut publishes only on
# full, and a marker without the line predates profiles, so it was full). Every
# run except --post-publish deletes a stale marker BEFORE it starts, so the file
# can only ever describe the run that just finished. release.sh refuses to sign
# (--resume-sign) or to publish (step 5/5 and 4/4) without one whose sha is the
# tarball being published — that is what stops a bare `build-dist.sh --unsigned`
# from walking into a release the VM never drove.
set -uo pipefail
HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
VMT="$ROOT/era-family/tools/vm"
DIST="${1:?usage: vm-e2e.sh <candidate dist dir> [prev Setup.exe] [--only a|b] [--post-publish] [--profile full|quiet]}"; shift
# ---- arguments (tests/vm-e2e.test.mjs runs this block as bash) ----
PREV=""; ONLY=""; PREV_UNTAGGED=""; PREV_LIVE=""; POST=0; PROFILE=full
while [ $# -gt 0 ]; do case "$1" in --only) ONLY="${2:?--only needs a|b|c}"; shift 2;; --post-publish) POST=1; ONLY=c; shift;; --profile) PROFILE="${2:-}"; shift $(( $# > 1 ? 2 : 1 ));; *) PREV="$1"; shift;; esac; done
case "$PROFILE" in full|quiet) ;; *) echo "vm-e2e: --profile is full or quiet, not '$PROFILE'"; exit 2;; esac
if [ "$POST" = 1 ] && [ "$PROFILE" != full ]; then
  echo "vm-e2e: leg C (--post-publish) measures what Windows shows a family, SmartScreen and Defender included: it runs on the full profile only"; exit 2
fi
# ---- end of arguments ----
FEED_PORT=8427
# one run at a time per tree (it owns gate/vm-e2e) and per dist dir (it owns $DIST/VM-GREEN)
VM_LOCKS="${ERA_VM_E2E_LOCKS:-/tmp}"   # a seam for tests/vm-e2e.test.mjs; the real locks live in /tmp
lock_key() { printf '%s' "$(realpath -m "$1")" | sha256sum | cut -c1-16; }
exec 7>"$VM_LOCKS/era-vm-e2e-tree-$(lock_key "$HUB").lock"
flock -w 7200 7 || { echo "vm-e2e: another run from this tree ($HUB) holds gate/vm-e2e"; exit 1; }
exec 8>"$VM_LOCKS/era-vm-e2e-dist-$(lock_key "$DIST").lock"
flock -w 7200 8 || { echo "vm-e2e: another run on $DIST holds its VM-GREEN"; exit 1; }
OUT="$HUB/gate/vm-e2e"; rm -rf "$OUT"; mkdir -p "$OUT"
# The marker describes the run that is about to happen and nothing else: a stale
# one from an earlier cut of the same version would otherwise vouch for bytes
# this run is replacing. (--post-publish drives the PUBLISHED download; it neither
# proves nor disproves the dist, so it leaves the marker alone.)
[ "$POST" = 1 ] || rm -f "$DIST/VM-GREEN"
# The installer a dist carries, by the name its own latest.json records; a feed
# that predates the field (before the 9/26 rename) is a New-ERA-Setup.exe cut.
exe_of() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("installer_file") or "New-ERA-Setup.exe")' "$1/latest.json" 2>/dev/null || echo New-ERA-Setup.exe; }

# ---- run slot (tests/vm-e2e.test.mjs runs this block as bash) ----
# One run per QA host (the 8/24 two-session lesson), up to QA_MAX_HOSTS hosts at once:
# a run holds slot n's lock for its whole life (slot 1 = the historic /tmp/era-vm-e2e.lock,
# which the windows runner's legacy slot also holds); all slots busy = wait, up to 2 h.
SLOTS="${QA_MAX_HOSTS:-2}"; SLOT=""; slot_t0=$(date +%s); slot_said=""; slot_wait="${ERA_VM_SLOT_WAIT:-7200}"
while :; do
  for n in $(seq 1 "$SLOTS"); do
    if [ "$n" = 1 ]; then slot_lock="${VM_LOCKS:-/tmp}/era-vm-e2e.lock"; else slot_lock="${VM_LOCKS:-/tmp}/era-vm-e2e.$n.lock"; fi
    exec 9>"$slot_lock"
    if flock -n 9; then SLOT=$n; break; fi
    exec 9>&-
  done
  [ -n "$SLOT" ] && break
  [ -n "$slot_said" ] || { echo "vm-e2e: all $SLOTS VM run slots are busy (QA_MAX_HOSTS=$SLOTS) - waiting"; slot_said=1; }
  [ $(( $(date +%s) - slot_t0 )) -ge "$slot_wait" ] && { echo "vm-e2e: all $SLOTS VM run slots stayed busy for $(( slot_wait / 60 )) min (QA_MAX_HOSTS=$SLOTS)"; exit 1; }
  sleep 20
done
echo "-- vm-e2e run slot $SLOT of $SLOTS"
# ---- end of run slot ----

if [ "$POST" = 1 ]; then
  # leg C downloads the PUBLISHED asset from the real website; all it needs from
  # $DIST is the sha256 it must match (checksums.txt, read by the leg itself).
  [ -f "$DIST/checksums.txt" ] || { echo "vm-e2e: $DIST/checksums.txt missing — leg C has nothing to compare the bytes against"; exit 2; }
else
for f in latest.json new-era-suite.tar.gz; do
  [ -f "$DIST/$f" ] || { echo "vm-e2e: $DIST/$f missing"; exit 2; }
done
# ---- leg B's starting installer (tests/vm-e2e.test.mjs runs this block as bash) ----
CAND_EXE="$(exe_of "$DIST")"
# A patch release re-attaches a previous cut's signed installer, and $DIST's own
# Setup.exe IS therefore the one the family already runs — leg B starts from it.
PATCH_INSTALLER="$(python3 -c "import json;d=json.load(open('$DIST/latest.json'));i=d.get('installer');print(i if i and i!=d['version'] else '')" 2>/dev/null || true)"
if [ -z "$PREV" ] && [ -n "$PATCH_INSTALLER" ]; then PREV="$DIST/$CAND_EXE"; fi
# A signed cut: release.sh downloaded the LIVE installer (whatever the published
# latest.json's installer_file names) into $DIST/prev/ — that is exactly what a
# family downloads today, so it beats any local dist dir.
if [ -z "$PREV" ]; then
  for p in "$DIST"/prev/*.exe; do [ -f "$p" ] && { PREV="$p"; PREV_LIVE=1; break; }; done
fi
if [ -z "$PREV" ]; then
  # every other cut's installer under the name its own latest.json records, newest first
  prev_exes() {
    local d e
    for d in "$ROOT"/dist/release-*; do
      [ "$d" = "${DIST%/}" ] && continue
      e="$d/$(exe_of "$d")"; [ -f "$e" ] && printf '%s\n' "$e"
    done | xargs -r -d '\n' ls -dt 2>/dev/null
  }
  while IFS= read -r p; do
    v="$(basename "$(dirname "$p")")"; v="${v#release-}"
    if git -C "$HUB" tag -l "$v" | grep -qx "$v"; then PREV="$p"; break; fi
  done < <(prev_exes)
  if [ -z "$PREV" ]; then
    # the pre-9/5 pick, and it says so: the "previous" banner line alone did
    # not catch the v0.32.0 mistake, so the fallback gets a line of its own
    PREV="$(prev_exes | head -1)"
    [ -n "$PREV" ] && { PREV_UNTAGGED=1; echo "vm-e2e: WARNING no TAGGED dist/release-* under $ROOT/dist - falling back to the UNTAGGED $PREV; leg B self-updates from a build no family has (pass the family's installer as the 2nd argument)"; }
  fi
  [ -n "$PREV" ] || { echo "vm-e2e: no previous installer found under $ROOT/dist"; exit 2; }
fi
# ---- end of leg B's starting installer ----
[ -f "$DIST/$CAND_EXE" ] || { echo "vm-e2e: $DIST/$CAND_EXE missing (the installer $DIST/latest.json names)"; exit 2; }
[ -f "$PREV" ] || { echo "vm-e2e: previous installer $PREV missing"; exit 2; }
fi

# The Windows QA host is an on-demand server (10/5, era-family/tools/vm/qa.sh): bring it
# up (reuses one that is already running) BEFORE env.sh reads its address, and destroy it
# on any exit — unless the caller holds it (release.sh sets QA_KEEP=1 across its legs).
QA_UP="$OUT/qa-up.txt"
bash "$VMT/qa.sh" up | tee "$QA_UP" || { echo "vm-e2e: could not bring the QA host up (era-family/tools/vm/qa.sh)"; exit 3; }
qa_release(){ bash "$VMT/qa.sh" down || true; }
trap qa_release EXIT
# ---- the QA host this run leased (tests/vm-e2e.test.mjs runs this block as bash) ----
# qa.sh up's last line names THE host it leased to this run; exported, VM_DROPLET beats
# data/vm.env's in env.sh (a scripted up no longer rewrites that shared file: two runs
# would point each other at the wrong host). No such line: env.sh's file value stands.
QA_LINE="$(grep '^QA_HOST=' "$QA_UP" | tail -1)"
QA_HOST="$(sed -n 's/^QA_HOST=\([^ ]*\).*/\1/p' <<< "$QA_LINE")"
QA_HOST_ID="$(sed -n 's/.* QA_HOST_ID=\([^ ]*\).*/\1/p' <<< "$QA_LINE")"
if [ -n "$QA_HOST" ]; then
  export VM_DROPLET="$QA_HOST"
  echo "-- QA host ${QA_HOST_ID:-?} leased to this run"
else
  echo "vm-e2e: qa.sh up named no host (no QA_HOST= line) - env.sh takes the address from data/vm.env"
fi
# ---- end of the QA host this run leased ----
. "$VMT/env.sh" || exit 2
if [ "$POST" = 1 ]; then
  echo "== vm-e2e: post-publish leg C only — the published download, fetched and opened on the guest; expected sha from $DIST/checksums.txt =="
else
  VER="$(python3 -c "import json;print(json.load(open('$DIST/latest.json'))['version'])")"
  BUILD="$(python3 -c "import json;print(json.load(open('$DIST/latest.json'))['build'])")"
  # the VM-GREEN marker names this exact file, so refuse now rather than after
  # twenty minutes of VM driving with nothing to record the run against
  [ -f "$DIST/new-era-suite-$VER.tar.gz" ] || { echo "vm-e2e: $DIST/new-era-suite-$VER.tar.gz missing — the VM-GREEN marker names the versioned tarball the legs drove"; exit 2; }
  if [ -n "$PATCH_INSTALLER" ]; then PREV_NOTE=" (installer $PATCH_INSTALLER re-attached)"; else PREV_NOTE="${PREV_UNTAGGED:+ (UNTAGGED - not a published release)}${PREV_LIVE:+ (the live published installer)}"; fi
  echo "== vm-e2e: candidate $VER ($BUILD) from $DIST; previous = $PREV$PREV_NOTE =="

  echo "-- assets -> QA host"
  $DROP "mkdir -p /root/qa/feed && rm -f /root/qa/feed/hits.log /root/qa/feed/hold" || exit 3
  rsync -q -e "ssh -i $VM_SSH_KEY" "$DIST/$CAND_EXE" root@$VM_DROPLET:/root/qa/candidate.exe || exit 3
  rsync -q -e "ssh -i $VM_SSH_KEY" "$PREV" root@$VM_DROPLET:/root/qa/prev.exe || exit 3
  # leg A's upgrade-over-old step: an install made by the OLD-name installer,
  # then the candidate over it (the .onInit folder move). Only that exact file
  # makes the step meaningful — a same-name previous installer never takes the
  # rename path.
  VM_UPGRADE_OLD=""
  if [ "$ONLY" != "b" ]; then
    if [ -f "$DIST/prev/New-ERA-Setup.exe" ]; then
      rsync -q -e "ssh -i $VM_SSH_KEY" "$DIST/prev/New-ERA-Setup.exe" root@$VM_DROPLET:/root/qa/old.exe || exit 3
      VM_UPGRADE_OLD=1
      echo "-- leg A will also run the candidate over an old New ERA install ($DIST/prev/New-ERA-Setup.exe)"
    else
      echo "vm-e2e: no $DIST/prev/New-ERA-Setup.exe - leg A's upgrade-over-old step will skip (release.sh downloads it on a signed cut)"
    fi
  fi
  rsync -q -e "ssh -i $VM_SSH_KEY" "$DIST/latest.json" "$DIST/new-era-suite.tar.gz" root@$VM_DROPLET:/root/qa/feed/ || exit 3
  rsync -q -e "ssh -i $VM_SSH_KEY" "$VMT/feed.py" root@$VM_DROPLET:/root/qa/feed.py || exit 3

  echo "-- feed + Resend stand-in on the QA host :$FEED_PORT"
  $DROP "pkill -f '^python3 /root/qa/feed.py' ; sleep 0.5; nohup python3 /root/qa/feed.py /root/qa/feed $FEED_PORT >/root/qa/feed.log 2>&1 & sleep 1; curl -sf http://127.0.0.1:$FEED_PORT/latest.json" \
    | grep -q "$VER" || { echo "vm-e2e: feed did not come up"; exit 3; }
fi

# ---- the DevTools tunnel (tests/vm-e2e.test.mjs runs this block as bash) ----
# local :CDP_PORT -> QA host :9223 -> (vm.sh cdp-forward, through the guest's sshd,
# re-made after every kiosk launch) -> the kiosk's DevTools port. The local port is this
# run's own (9222 for slot 1, 9232 for slot 2; the next free one when taken, checked with
# ss) and the tunnel is this run's own ssh child: cleanup kills THAT pid and nothing else
# (a pattern kill would take another run's tunnel down). The QA host side (feed.py, the
# guest -L 9223 forward) is per host, so its pkill over $DROP touches this run's host only.
cdp_port_free() { ! ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; }
TUNNEL_PID=""; CDP_PORT=$(( ${VM_CDP_BASE:-9222} + 10 * (${SLOT:-1} - 1) ))

for try in 1 2 3 4 5; do
  while ! cdp_port_free "$CDP_PORT"; do CDP_PORT=$((CDP_PORT + 1)); done
  ssh -N -L "127.0.0.1:$CDP_PORT:127.0.0.1:9223" -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -i "$VM_SSH_KEY" root@$VM_DROPLET </dev/null &
  TUNNEL_PID=$!
  for i in $(seq 1 100); do cdp_port_free "$CDP_PORT" || break; kill -0 "$TUNNEL_PID" 2>/dev/null || break; sleep 0.2; done
  kill -0 "$TUNNEL_PID" 2>/dev/null && ! cdp_port_free "$CDP_PORT" && break
  kill "$TUNNEL_PID" 2>/dev/null; TUNNEL_PID=""; CDP_PORT=$((CDP_PORT + 1))   # taken under us: next port
done
[ -n "$TUNNEL_PID" ] || { echo "vm-e2e: tunnel failed"; exit 3; }
echo "-- DevTools tunnel :$CDP_PORT (local, ssh pid $TUNNEL_PID) -> QA host :9223"
export VM_CDP="http://127.0.0.1:$CDP_PORT"
cleanup() { [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null; $DROP "pkill -f '^python3 /root/qa/feed.py'; pkill -f '^ssh -p $VM_GUEST_SSH_PORT .*-L 9223:'" 2>/dev/null; qa_release; }
trap cleanup EXIT
# ---- end of the DevTools tunnel ----


export VM_OUT="$OUT" VM_GUEST_USER VM_CANDIDATE_VERSION="${VER:-}" VM_CANDIDATE_BUILD="${BUILD:-}" VM_FEED_PORT="$FEED_PORT"
export VM_DIST="$DIST"   # leg C reads the expected sha256 out of $DIST/checksums.txt
export VM_GUEST_PROFILE="$PROFILE"   # vm.mjs reverts and readies the guest by it
case "$PROFILE" in
  quiet) PROFILE_NOTE="the template's quiet snapshot: Defender and Windows Update off, a bounded readiness check instead of the quiet wait";;
  *)     PROFILE_NOTE="the template's pristine snapshot: Defender on, its post-restore update and scan waited out";;
esac
echo "-- guest profile: $PROFILE ($PROFILE_NOTE)"
# leg C: the file name the published latest.json names (the site's button must
# point at exactly it); leg A: whether $DIST/prev/ holds an old-name installer
export VM_INSTALLER_FILE="$(exe_of "$DIST")" VM_UPGRADE_OLD="${VM_UPGRADE_OLD:-}"
pass=0; fail=0; RAN=""
run_leg() {
  local name="$1" file="$2"
  [ -n "$ONLY" ] && [ "$ONLY" != "$name" ] && return 0
  RAN="${RAN:+$RAN,}$name"
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
# The marker release.sh reads (see the header). Written ONLY on a green run of
# the candidate, never by --post-publish, and it names the bytes: a later
# rebuild of the same version changes the tarball's sha and the marker stops
# matching, so a publish of those new bytes needs a new VM run.
if [ "$POST" != 1 ] && [ $fail -eq 0 ] && [ -n "$RAN" ]; then
  printf 'legs=%s\ntarball=%s\nat=%s\nprofile=%s\n' \
    "$RAN" "$(sha256sum "$DIST/new-era-suite-$VER.tar.gz" | cut -d' ' -f1)" "$(date +%s)" "$PROFILE" > "$DIST/VM-GREEN"
  echo "vm-e2e: wrote $DIST/VM-GREEN (legs=$RAN, profile=$PROFILE)"
fi
[ $fail -eq 0 ]
