#!/usr/bin/env bash
# release.sh <version> [--prerelease] [--dry-run] — cut a New ERA suite release.
# Server-driven (the machine that already runs the gate + holds the siblings):
#   1. era-gate must be fully green (no release on a red gate, ever)
#   2. build: payload WITH bundled node (era-scan enforced inside), zip,
#      installer, checksums, latest.json  (tools/build-dist.sh)
#   3. VM e2e must be fully green: the very files about to be published,
#      installed and driven on a pristine Windows 10 (tools/vm-e2e.sh)
#   4. tag era-hub + GitHub Release with tarball + checksums + notes
#   --dry-run: stop after 3 (build + both gates), publish nothing
# The website's download links point at the latest release assets.
set -euo pipefail
V="${1:?usage: release.sh vX.Y.Z [--prerelease] [--dry-run]}"; shift
PRE=""; DRY=0
for a in "$@"; do case "$a" in --prerelease) PRE=1;; --dry-run) DRY=1;; *) echo "release.sh: unknown flag $a"; exit 2;; esac; done
HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
DIST="$ROOT/dist/release-$V"

echo "== 1/4 gate =="
bash "$HUB/tools/era-gate.sh" | tail -1 | tee /tmp/era-release-gate.txt
grep -q " 0 failed" /tmp/era-release-gate.txt || { echo "GATE NOT GREEN — no release."; exit 1; }

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
