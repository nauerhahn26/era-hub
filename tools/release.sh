#!/usr/bin/env bash
# release.sh <version> [--prerelease] — cut a New ERA suite release.
# Server-driven (the machine that already runs the gate + holds the siblings):
#   1. era-gate must be fully green (no release on a red gate, ever)
#   2. build the payload WITH bundled node (era-scan enforced inside the build)
#   3. checksums
#   4. tag era-hub + GitHub Release with tarball + checksums + notes
# The website's download links point at the latest release assets.
set -euo pipefail
V="${1:?usage: release.sh vX.Y.Z [--prerelease]}"
PRE="${2:-}"
HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
DIST="$ROOT/dist/release-$V"

echo "== 1/4 gate =="
bash "$HUB/tools/era-gate.sh" | tail -1 | tee /tmp/era-release-gate.txt
grep -q " 0 failed" /tmp/era-release-gate.txt || { echo "GATE NOT GREEN — no release."; exit 1; }

echo "== 2/4 payload =="
bash "$HUB/tools/build-payload.sh" "$DIST/new-era-suite" --with-node
TARBALL="$(ls -t "$DIST"/new-era-suite-*.tar.gz | head -1)"
mv "$TARBALL" "$DIST/new-era-suite-$V.tar.gz"

echo "== 2b/4 zip (what the website hands to Windows; Win10 can't open .tar.gz) =="
( cd "$DIST" && python3 -m zipfile -c "new-era-suite.zip" new-era-suite/ )

echo "== 3/4 checksums =="
( cd "$DIST" && sha256sum "new-era-suite-$V.tar.gz" "new-era-suite.zip" > checksums.txt && cat checksums.txt )
# latest.json = the self-update feed: installed hubs poll releases/latest/
# download/latest.json and update themselves when `build` is newer.
BUILD="$(cat "$DIST/new-era-suite/VERSION")"
SHA="$(head -1 "$DIST/checksums.txt" | cut -d' ' -f1)"   # tarball line = the updater's asset
printf '{"version":"%s","build":"%s","sha256":"%s"}\n' "$V" "$BUILD" "$SHA" > "$DIST/latest.json"
cat "$DIST/latest.json"

echo "== 4/4 tag + release =="
git -C "$HUB" tag -f "$V"
git -C "$HUB" push -q origin "refs/tags/$V" --force
NOTES="New ERA suite $V — hub + Gaze-ready apps (Making Words, The Pencil, Morning Outfit Picker board, Music board with 40-second clips and offline playback) with bundled Node runtime.
Install: download the .zip, right-click > Extract All, then double-click INSTALL.bat and pick your apps. Uninstall never touches your data.
sha256 in checksums.txt."
cp "$DIST/new-era-suite-$V.tar.gz" "$DIST/new-era-suite.tar.gz"   # stable name = the website's direct-download URL
gh release create "$V" --repo nauerhahn26/new-era-releases --title "New ERA suite $V" \
  --notes "$NOTES" ${PRE:+--prerelease} \
  "$DIST/new-era-suite-$V.tar.gz" "$DIST/new-era-suite.tar.gz" "$DIST/new-era-suite.zip" "$DIST/checksums.txt" "$DIST/latest.json"
echo "RELEASED: $V"
