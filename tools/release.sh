#!/usr/bin/env bash
# release.sh <version> [--prerelease] [--dry-run] [--skip-gate] — cut a New ERA suite release.
# Server-driven (the machine that already runs the gate + holds the siblings):
#   0. the signing login must be live (sign-installer.sh --check) — asked
#      BEFORE the gate: SimplySign Desktop's login lapses after ~2 h and on
#      9/6 a 50-min green gate ended in "not logged in" at the cut
#   1. era-gate must be fully green (no release on a red gate, ever)
#   2. build: payload WITH bundled node (era-scan enforced inside), zip,
#      installer, checksums, latest.json  (tools/build-dist.sh)
#   3. VM e2e must be fully green: the very files about to be published,
#      installed and driven on a pristine Windows 10 (tools/vm-e2e.sh)
#   4. tag era-hub + GitHub Release with tarball + checksums + notes
#   --dry-run: stop after 3 (build + both gates), publish nothing
#   --skip-gate: re-cut after a failure PAST a green gate (a lapsed login, a
#      starved VM host) — allowed only on the strength of a green stamp
#      (/tmp/era-gate-green/<tree>, written by era-gate.sh on every green run
#      from any checkout) under 2 h old: either this HEAD's own tree, or a
#      stamped HEAD whose tree differs from ours only under tools/, tests-vm/
#      and docs/ (the build and the VM legs run again regardless). Never a way
#      past a red gate.
#   --gate-check (hidden, with --skip-gate): evaluate step 1 only and exit 0/1 —
#      nothing is built, signed or published.
# The website's download links point at the latest release assets.
set -euo pipefail
V="${1:?usage: release.sh vX.Y.Z [--prerelease] [--dry-run] [--skip-gate]}"; shift
PRE=""; DRY=0; SKIPGATE=0; GATECHECK=0
for a in "$@"; do case "$a" in --prerelease) PRE=1;; --dry-run) DRY=1;; --skip-gate) SKIPGATE=1;; --gate-check) GATECHECK=1;; *) echo "release.sh: unknown flag $a"; exit 2;; esac; done
if [ "$GATECHECK" = 1 ] && [ "$SKIPGATE" = 0 ]; then
  echo "release.sh: --gate-check only makes sense with --skip-gate (it must never start a gate)"; exit 2
fi
HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
DIST="$ROOT/dist/release-$V"
HEAD="$(git -C "$HUB" rev-parse HEAD)"

if [ "$GATECHECK" = 0 ]; then
  echo "== 0/4 signing =="
  bash "$HUB/tools/sign-installer.sh" --check || { echo "SIGNING NOT READY — no release (log in first, the gate takes 50 min)."; exit 1; }
fi

# A green stamp counts when it exists, its first line is a green summary and its
# at= is under 2 h old. No pipes here: `… | grep -q` under pipefail is how the
# signing rail learned about SIGPIPE (9/5).
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

echo "== 1/4 gate =="
if [ "$SKIPGATE" = 1 ]; then
  GREEN=/tmp/era-gate-green
  TREE="$(git -C "$HUB" rev-parse 'HEAD^{tree}')"
  S=""
  if stamp_ok "$GREEN/$TREE"; then
    S="$GREEN/$TREE"                      # this exact tree went green, anywhere
  else
    # No stamp for our tree: accept a stamped HEAD whose tree differs from ours
    # only under tools/, tests-vm/ and docs/ — the old --skip-gate rule, kept
    # because nothing the suites exercise moved (build + VM legs run again).
    for f in "$GREEN"/*; do
      stamp_ok "$f" || continue
      g="$(awk -F= '/^head=/{print $2; exit}' "$f")"
      [ -n "$g" ] || continue
      git -C "$HUB" diff --quiet "$g" "$HEAD" -- . ':(exclude)tools' ':(exclude)tests-vm' ':(exclude)docs' 2>/dev/null || continue
      S="$f"; break
    done
  fi
  [ -n "$S" ] || { echo "--skip-gate: no green stamp under 2 h old for tree ${TREE:0:7} (nor for a tree differing only under tools/, tests-vm/, docs/) — run without it."; exit 1; }
  ST="$(basename "$S")"; SH="$(awk -F= '/^head=/{print $2; exit}' "$S")"; SAT="$(awk -F= '/^at=/{print $2; exit}' "$S")"
  echo "gated tree ${ST:0:7} from ${SH:0:7}, green $(date -d "@$SAT" +%H:%M) — gate skipped: $(head -1 "$S")"
else
  bash "$HUB/tools/era-gate.sh" | tail -1 | tee /tmp/era-release-gate.txt
  grep -q " 0 failed" /tmp/era-release-gate.txt || { echo "GATE NOT GREEN — no release."; exit 1; }
  # DEPRECATED, written one more release because the i13 runbooks name these two
  # files: the truth is now era-gate.sh's /tmp/era-gate-green/<tree> stamp.
  echo "$HEAD" >/tmp/era-release-gate.head
fi
if [ "$GATECHECK" = 1 ]; then exit 0; fi

echo "== 2/4 build (payload, zip, installer, checksums, latest.json) =="
bash "$HUB/tools/build-dist.sh" "$V" "$DIST"

echo "== 3/4 VM e2e (the candidate installed and driven on a pristine Windows 10; the previous release self-updating to it) =="
bash "$HUB/tools/vm-e2e.sh" "$DIST" | tee /tmp/era-release-vm-e2e.txt | tail -20
grep -q "^== vm-e2e: .* 0 failed ==" /tmp/era-release-vm-e2e.txt || { echo "VM E2E NOT GREEN — no release. Evidence: $HUB/gate/vm-e2e/"; exit 1; }

if [ "$DRY" = 1 ]; then echo "DRY RUN: built + gated $V in $DIST — not tagged, not published."; exit 0; fi
echo "== 4/4 tag + release =="
git -C "$HUB" tag -f "$V"
git -C "$HUB" push -q origin "refs/tags/$V" --force
# the app list is server.js APPS — keep the two in step
NOTES="New ERA suite $V — free eye-gaze apps for a child on a Tobii device, all running on the family's own PC: Making Words, The Pencil, Clothing Picker, Music, Movies, Book Reader, plus the ERAgaze engine for PCs without one. Bundled Node runtime; nothing about your child leaves the machine.
Install: download New-ERA-Setup.exe and double-click it, then pick your apps on the welcome screen. The installer is code-signed (Certum; right-click › Properties › Digital Signatures shows the publisher) — Windows may still ask once while the new signature earns its reputation: choose More info, then Run anyway. The portable .zip works too. Installed copies update themselves; Uninstall never touches your data.
Every release is installed and driven end to end on a clean Windows 10 before it is published. sha256 in checksums.txt."
gh release create "$V" --repo nauerhahn26/new-era-releases --title "New ERA suite $V" \
  --notes "$NOTES" ${PRE:+--prerelease} \
  "$DIST/new-era-suite-$V.tar.gz" "$DIST/new-era-suite.tar.gz" "$DIST/new-era-suite.zip" "$DIST/New-ERA-Setup.exe" "$DIST/checksums.txt" "$DIST/latest.json"
echo "RELEASED: $V"
