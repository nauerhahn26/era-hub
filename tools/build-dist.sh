#!/usr/bin/env bash
# build-dist.sh <version> <dist dir> — everything a release publishes, built
# into <dist dir>: payload with bundled node, tarball, zip, New-ERA-Setup.exe
# (signed iff era-family/data/signing.env exists), checksums, latest.json.
# release.sh calls this after the gate; the VM e2e (tools/vm-e2e.sh) takes the
# same <dist dir> as its candidate, so what is tested is byte-for-byte what
# is published.
set -euo pipefail
V="${1:?usage: build-dist.sh vX.Y.Z <dist dir>}"
DIST="${2:?usage: build-dist.sh vX.Y.Z <dist dir>}"
HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"

echo "== payload =="
bash "$HUB/tools/build-payload.sh" "$DIST/new-era-suite" --with-node
TARBALL="$(ls -t "$DIST"/new-era-suite-*.tar.gz | head -1)"
mv "$TARBALL" "$DIST/new-era-suite-$V.tar.gz"

echo "== zip (what the website hands to Windows; Win10 can't open .tar.gz) =="
( cd "$DIST" && python3 -m zipfile -c "new-era-suite.zip" new-era-suite/ )

echo "== installer (New-ERA-Setup.exe; signed iff era-family/data/signing.env exists — docs/signing-plan.md) =="
NSIS="$ROOT/era-family/cache/nsis"
# -DSIGN: makensis hands the uninstaller stub and the finished Setup.exe to
# sign-installer.sh (!uninstfinalize / !finalize). Without a cert it prints
# UNSIGNED and the build proceeds; with one, a signing failure fails the cut.
NSISDIR="$NSIS/usr/share/nsis" "$NSIS/usr/bin/makensis" \
  -DPAYLOAD="$DIST/new-era-suite" -DOUTFILE="$DIST/New-ERA-Setup.exe" -DVERSION="$V" \
  -DSIGN="$HUB/tools/sign-installer.sh" \
  "$HUB/tools/installer.nsi" | grep -E "^sign:|Total size|[Ee]rror"
if [ -f "$ROOT/era-family/data/signing.env" ]; then
  "$ROOT/era-family/cache/osslsigncode/usr/bin/osslsigncode" verify -in "$DIST/New-ERA-Setup.exe" | grep -q "Signature verification: ok" \
    || { echo "SIGNING CONFIGURED BUT Setup.exe NOT VERIFIED — no release."; exit 1; }
fi

echo "== checksums =="
( cd "$DIST" && sha256sum "new-era-suite-$V.tar.gz" "new-era-suite.zip" "New-ERA-Setup.exe" > checksums.txt && cat checksums.txt )
# latest.json = the self-update feed: installed hubs poll releases/latest/
# download/latest.json and update themselves when `build` is newer.
BUILD="$(cat "$DIST/new-era-suite/VERSION")"
SHA="$(head -1 "$DIST/checksums.txt" | cut -d' ' -f1)"   # tarball line = the updater's asset
printf '{"version":"%s","build":"%s","sha256":"%s"}\n' "$V" "$BUILD" "$SHA" > "$DIST/latest.json"
cat "$DIST/latest.json"
cp "$DIST/new-era-suite-$V.tar.gz" "$DIST/new-era-suite.tar.gz"   # stable name = the website's + the updater's URL
