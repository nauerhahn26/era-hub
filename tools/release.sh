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
#      starved VM host) — allowed only while the gated files are byte-identical
#      to the tree that last went green here (/tmp/era-release-gate.head) and
#      that gate is under 2 h old; tools/, tests-vm/ and docs/ may differ (the
#      build and the VM legs run again regardless). Never a way past a red gate.
# The website's download links point at the latest release assets.
set -euo pipefail
V="${1:?usage: release.sh vX.Y.Z [--prerelease] [--dry-run] [--skip-gate]}"; shift
PRE=""; DRY=0; SKIPGATE=0
for a in "$@"; do case "$a" in --prerelease) PRE=1;; --dry-run) DRY=1;; --skip-gate) SKIPGATE=1;; *) echo "release.sh: unknown flag $a"; exit 2;; esac; done
HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
DIST="$ROOT/dist/release-$V"
HEAD="$(git -C "$HUB" rev-parse HEAD)"

echo "== 0/4 signing =="
bash "$HUB/tools/sign-installer.sh" --check || { echo "SIGNING NOT READY — no release (log in first, the gate takes 50 min)."; exit 1; }

echo "== 1/4 gate =="
if [ "$SKIPGATE" = 1 ]; then
  G="$(cat /tmp/era-release-gate.head 2>/dev/null || true)"
  [ -n "$G" ] && grep -q " 0 failed" /tmp/era-release-gate.txt 2>/dev/null \
    && [ $(( $(date +%s) - $(stat -c %Y /tmp/era-release-gate.txt) )) -lt 7200 ] \
    && git -C "$HUB" diff --quiet "$G" "$HEAD" -- . ':(exclude)tools' ':(exclude)tests-vm' ':(exclude)docs' \
    || { echo "--skip-gate: no green gate under 2 h old on these gated files (last: ${G:-none}) — run without it."; exit 1; }
  echo "gated files identical to ${G:0:7}, green $(date -r /tmp/era-release-gate.txt +%H:%M) — gate skipped: $(cat /tmp/era-release-gate.txt)"
else
  bash "$HUB/tools/era-gate.sh" | tail -1 | tee /tmp/era-release-gate.txt
  grep -q " 0 failed" /tmp/era-release-gate.txt || { echo "GATE NOT GREEN — no release."; exit 1; }
  echo "$HEAD" >/tmp/era-release-gate.head
fi

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
