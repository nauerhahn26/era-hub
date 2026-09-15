#!/usr/bin/env bash
# build-dist.sh <version> <dist dir> [--patch|--unsigned|--sign-only] — everything a
# release publishes, built into <dist dir>: payload with bundled node, tarball, zip,
# New-ERA-Setup.exe, checksums, latest.json (which now names the installer's tag).
#   (no flag)     full cut, installer built by makensis WITH -DSIGN and verified
#   --unsigned    same, installer built WITHOUT -DSIGN (release.sh's step 2: the VM
#                 drives an unsigned exe, then --sign-only re-cuts it signed)
#   --sign-only   ONLY the installer (makensis with -DSIGN) + checksums + latest.json
#                 over an existing <dist dir>; asserts the tarball's sha is unchanged
#   --patch       no makensis at all: the signed installer named by the live
#                 latest.json is downloaded from its release and re-attached
# The VM e2e (tools/vm-e2e.sh) takes the same <dist dir> as its candidate, so what
# is tested is byte-for-byte what is published (the signed exe of a signed cut is
# re-made after the VM — that is leg C's job).
set -euo pipefail
V="${1:?usage: build-dist.sh vX.Y.Z <dist dir> [--patch|--unsigned|--sign-only]}"
DIST="${2:?usage: build-dist.sh vX.Y.Z <dist dir> [--patch|--unsigned|--sign-only]}"
case "${3:-}" in
  "")           MODE=signed;;
  --patch)      MODE=patch;;
  --unsigned)   MODE=unsigned;;
  --sign-only)  MODE=sign-only;;
  *) echo "build-dist.sh: unknown flag ${3}"; exit 2;;
esac
HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
REPO="nauerhahn26/new-era-releases"
OSSL="$ROOT/era-family/cache/osslsigncode/usr/bin/osslsigncode"
NSIS="$ROOT/era-family/cache/nsis"

# A full disk makes makensis die with SIGBUS and no message (9/3: 46 MB free,
# rc=1 after "== installer =="). A cut needs ~300 MB; insist on 2 GB headroom.
DISTPARENT="$(dirname "$DIST")"
# df on a path that does not exist prints an error and an empty NR==2, and the
# arithmetic test below then dies with an unhelpful "integer expression expected".
[ -d "$DISTPARENT" ] || {
  echo "$DISTPARENT does not exist — <dist dir> must sit inside a real directory (there is no disk to measure, let alone build into); no build."
  exit 1; }
FREE_MB="$(df -Pm "$DISTPARENT" | awk 'NR==2 {print $4}')"
if [ "$FREE_MB" -lt 2048 ]; then
  echo "only ${FREE_MB} MB free under $DISTPARENT — clear old dist/release-* dirs first; no build."
  exit 1
fi

# captured, never `| grep -q`: the early pipe close + pipefail turns a good
# signature into a false FAILED (the 9/5 SIGPIPE lesson).
verify_signature() {   # <exe> — 0 only on "Signature verification: ok"
  local exe="$1" out
  [ -x "$OSSL" ] || { echo "osslsigncode missing at $OSSL — a signature cannot be proved."; return 1; }
  out="$("$OSSL" verify -in "$exe" 2>&1)" && grep -q "^Signature verification: ok" <<<"$out" \
    || { echo "$out" | tail -20; return 1; }
  grep -E "^Signature verification|Timestamp time" <<<"$out"
}

build_payload() {
  echo "== payload =="
  bash "$HUB/tools/build-payload.sh" "$DIST/new-era-suite" --with-node
  local tarball; tarball="$(ls -t "$DIST"/new-era-suite-*.tar.gz | head -1)"
  mv "$tarball" "$DIST/new-era-suite-$V.tar.gz"
  echo "== zip (what the website hands to Windows; Win10 can't open .tar.gz) =="
  ( cd "$DIST" && python3 -m zipfile -c "new-era-suite.zip" new-era-suite/ )
}

# makensis over the payload already in $DIST. --sign adds -DSIGN, which is how
# signing happens at all: installer.nsi's !uninstfinalize / !finalize hand the
# uninstaller stub AND the finished Setup.exe to sign-installer.sh. A signature
# bolted onto Setup.exe afterwards would leave the embedded uninstaller unsigned,
# so "sign later" means running this function again, not signing the file.
build_installer() {   # [--sign]
  local sign=0
  if [ "${1:-}" = "--sign" ]; then sign=1; fi
  if [ "$sign" = 1 ]; then
    echo "== installer (New-ERA-Setup.exe, signed inside makensis) =="
  else
    echo "== installer (New-ERA-Setup.exe, UNSIGNED by request) =="
  fi
  # Whole-MB sizes for the components page's hover text (installer.nsi): the
  # engine (everything but the app packs), the shared board pack, and the
  # media-tools pack (yt-dlp). Every path in packs.js PACKS must appear here or
  # its megabytes are counted as engine — tests/packs.test.mjs keeps the two
  # lists equal.
  mb() { du -sb "$@" 2>/dev/null | awk '{s+=$1} END {printf "%d", (s + 524288) / 1048576}'; }
  local P="$DIST/new-era-suite" SZ_BOARD SZ_MEDIA SZ_CORE
  [ -d "$P" ] || { echo "no payload at $P — nothing to wrap."; exit 1; }
  SZ_BOARD="$(mb "$P/public/board" "$P/vendor/onnxruntime-web" "$P/vendor/models" "$P/vendor/libheif.js")"
  SZ_MEDIA="$(mb "$P/vendor/yt-dlp")"
  SZ_CORE=$(( $(mb "$P") - SZ_BOARD - SZ_MEDIA - $(mb "$P/public/pencil" "$P/public/reader") ))
  local args=( -DPAYLOAD="$P" -DOUTFILE="$DIST/New-ERA-Setup.exe" -DVERSION="$V"
               -DSZ_CORE="$SZ_CORE" -DSZ_BOARD="$SZ_BOARD" -DSZ_MEDIA="$SZ_MEDIA" )
  if [ "$sign" = 1 ]; then args+=( -DSIGN="$HUB/tools/sign-installer.sh" ); fi
  # Full output goes to makensis.log; the console gets the interesting lines, and
  # the log's tail on failure (the grep used to swallow the reason).
  if NSISDIR="$NSIS/usr/share/nsis" "$NSIS/usr/bin/makensis" "${args[@]}" \
    "$HUB/tools/installer.nsi" > "$DIST/makensis.log" 2>&1; then
    grep -E "^sign:|Total size|[Ee]rror" "$DIST/makensis.log" || true
  else
    local RC=$?
    echo "makensis failed (rc=$RC) — tail of $DIST/makensis.log:"; tail -n 20 "$DIST/makensis.log"
    exit 1
  fi
  [ -s "$DIST/New-ERA-Setup.exe" ] || { echo "New-ERA-Setup.exe missing or empty — no release."; exit 1; }
  if [ "$sign" = 1 ]; then
    # HALF-SIGNED IS THE DANGEROUS CASE (P4/P5 review, 9/15). makensis swallows
    # the exit code of its !uninstfinalize / !finalize commands, so a
    # sign-installer.sh that died on the uninstaller stub (a lapsed SimplySign
    # login mid-cut, a timestamp timeout) still yields a Setup.exe that verifies
    # — osslsigncode cannot see the unsigned stub packed inside it, and the
    # family meets it months later at Uninstall. sign-installer.sh prints exactly
    # one `sign: SIGNED <file> (timestamped at …)` line per file it signs, and a
    # -DSIGN cut signs two: the stub, then Setup.exe. Anything but two is a
    # failed release, not a warning.
    local n
    n="$(grep -c '^sign: SIGNED ' "$DIST/makensis.log" || true)"
    [ "${n:-0}" = 2 ] || {
      echo "installer: SIGNING INCOMPLETE (${n:-0}/2 signed) — no release."
      echo "-- sign lines in $DIST/makensis.log:"; grep -E '^sign:' "$DIST/makensis.log" || echo "(none)"
      exit 1; }
    verify_signature "$DIST/New-ERA-Setup.exe" \
      || { echo "installer: SIGNING WAS REQUESTED BUT Setup.exe DID NOT VERIFY — no release."; exit 1; }
    echo "installer: signed and verified (uninstaller stub + Setup.exe, 2/2)"
  else
    echo "installer: UNSIGNED (by request)"
  fi
}

# The tag whose Setup.exe the published release currently serves. Today's live
# latest.json predates the field — fall back to its version.
installer_tag_from_feed() {
  local json
  json="$(curl -sL --fail "https://github.com/$REPO/releases/latest/download/latest.json")" \
    || { echo "cannot read the live latest.json — no patch." >&2; return 1; }
  printf '%s' "$json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("installer") or d["version"])'
}

write_checksums() {
  echo "== checksums =="
  ( cd "$DIST" && sha256sum "new-era-suite-$V.tar.gz" "new-era-suite.zip" "New-ERA-Setup.exe" > checksums.txt && cat checksums.txt )
}

# latest.json = the self-update feed: installed hubs poll releases/latest/
# download/latest.json and update themselves when `build` is newer. `installer`
# is the tag whose Setup.exe this release serves — the website's download, and
# what the next --patch re-attaches.
write_latest() {   # <installer tag>
  local build sha
  build="$(cat "$DIST/new-era-suite/VERSION")"
  sha="$(head -1 "$DIST/checksums.txt" | cut -d' ' -f1)"   # tarball line = the updater's asset
  printf '{"version":"%s","build":"%s","sha256":"%s","installer":"%s"}\n' "$V" "$build" "$sha" "$1" > "$DIST/latest.json"
  cat "$DIST/latest.json"
}

case "$MODE" in
  patch)
    # Resolve and refuse BEFORE anything is written: a refused patch must not
    # leave half a build behind.
    TAG="$(installer_tag_from_feed)"
    if [ "${V%.*}" != "${TAG%.*}" ]; then
      echo "patch $V cannot carry installer $TAG — cut a signed ${V%.*}.0 first"
      exit 1
    fi
    build_payload
    echo "== installer ($TAG's signed Setup.exe re-attached; NO makensis) =="
    rm -f "$DIST/New-ERA-Setup.exe"
    gh release download "$TAG" -p New-ERA-Setup.exe --repo "$REPO" -D "$DIST" \
      || { echo "could not download New-ERA-Setup.exe from $TAG — no patch."; exit 1; }
    [ -s "$DIST/New-ERA-Setup.exe" ] || { echo "downloaded New-ERA-Setup.exe is empty — no patch."; exit 1; }
    verify_signature "$DIST/New-ERA-Setup.exe" \
      || { echo "installer: $TAG's Setup.exe DID NOT VERIFY — a patch never re-attaches an unsigned exe."; exit 1; }
    echo "installer: $TAG re-attached, signature ok"
    write_checksums
    write_latest "$TAG"
    ;;
  unsigned)
    build_payload
    build_installer
    write_checksums
    write_latest "$V"
    ;;
  signed)
    build_payload
    build_installer --sign
    write_checksums
    write_latest "$V"
    ;;
  sign-only)
    # The payload and the tarball are already here and must not move: the tarball
    # is what every installed device receives, and it went through the VM as it is.
    for f in "new-era-suite/VERSION" "new-era-suite-$V.tar.gz" "new-era-suite.zip" "new-era-suite.tar.gz" "latest.json"; do
      [ -e "$DIST/$f" ] || { echo "--sign-only: $DIST/$f missing — this mode signs an existing build, it does not make one."; exit 1; }
    done
    WAS="$(python3 -c "import json;print(json.load(open('$DIST/latest.json'))['sha256'])")"
    NOW="$(sha256sum "$DIST/new-era-suite-$V.tar.gz" | cut -d' ' -f1)"
    [ "$WAS" = "$NOW" ] || { echo "--sign-only: the tarball changed since the VM drove it ($WAS -> $NOW) — no release."; exit 1; }
    # The stable name is the URL every installed hub fetches. The versioned
    # tarball is the one just proved unchanged, so re-assert the copy from it
    # rather than trusting whatever has been sitting under the stable name since
    # the unsigned cut (this mode is the only one that skipped the cp below).
    cp "$DIST/new-era-suite-$V.tar.gz" "$DIST/new-era-suite.tar.gz"
    build_installer --sign
    write_checksums
    write_latest "$V"
    ;;
esac

if [ "$MODE" != "sign-only" ]; then
  cp "$DIST/new-era-suite-$V.tar.gz" "$DIST/new-era-suite.tar.gz"   # stable name = the website's + the updater's URL
fi
# push-device.sh reads TREE to look up this build's green gate stamp.
git -C "$HUB" rev-parse 'HEAD^{tree}' > "$DIST/TREE"
git -C "$HUB" rev-parse HEAD > "$DIST/HEAD"
