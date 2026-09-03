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

# A full disk makes makensis die with SIGBUS and no message (9/3: 46 MB free,
# rc=1 after "== installer =="). A cut needs ~300 MB; insist on 2 GB headroom.
FREE_MB="$(df -Pm "$(dirname "$DIST")" | awk 'NR==2 {print $4}')"
if [ "$FREE_MB" -lt 2048 ]; then
  echo "only ${FREE_MB} MB free under $(dirname "$DIST") — clear old dist/release-* dirs first; no build."
  exit 1
fi

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
# Full output goes to makensis.log; the console gets the interesting lines, and
# the log's tail on failure (the grep used to swallow the reason).
# Whole-MB sizes for the components page's hover text (installer.nsi): the
# engine (everything but the app packs) and the shared board pack.
mb() { du -sb "$@" 2>/dev/null | awk '{s+=$1} END {printf "%d", (s + 524288) / 1048576}'; }
P="$DIST/new-era-suite"
SZ_BOARD="$(mb "$P/public/board" "$P/vendor/onnxruntime-web" "$P/vendor/models" "$P/vendor/libheif.js")"
SZ_CORE=$(( $(mb "$P") - SZ_BOARD - $(mb "$P/public/pencil" "$P/public/reader") ))
if NSISDIR="$NSIS/usr/share/nsis" "$NSIS/usr/bin/makensis" \
  -DPAYLOAD="$DIST/new-era-suite" -DOUTFILE="$DIST/New-ERA-Setup.exe" -DVERSION="$V" \
  -DSZ_CORE="$SZ_CORE" -DSZ_BOARD="$SZ_BOARD" \
  -DSIGN="$HUB/tools/sign-installer.sh" \
  "$HUB/tools/installer.nsi" > "$DIST/makensis.log" 2>&1; then
  grep -E "^sign:|Total size|[Ee]rror" "$DIST/makensis.log" || true
else
  RC=$?
  echo "makensis failed (rc=$RC) — tail of $DIST/makensis.log:"; tail -n 20 "$DIST/makensis.log"
  exit 1
fi
[ -s "$DIST/New-ERA-Setup.exe" ] || { echo "New-ERA-Setup.exe missing or empty — no release."; exit 1; }
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
