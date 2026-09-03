#!/usr/bin/env bash
# sign-installer.sh <exe> — Authenticode-sign one Windows executable in place.
# Called by makensis for BOTH the uninstaller stub and Setup.exe (see the
# !uninstfinalize / !finalize lines in installer.nsi), so every release is
# either fully signed or honestly unsigned — never half.
#
# No certificate yet (era-family/data/signing.env absent): print UNSIGNED and
# exit 0, so builds keep working exactly as today.
# Certificate present: sign with osslsigncode (vendored deb in
# era-family/cache/osslsigncode — no root on the build box) through the Certum
# SimplySign PKCS#11 module, RFC-3161 timestamp at Certum, then verify. Any
# failure exits non-zero and fails the release (docs/signing-plan.md §3:
# "an unsigned Setup.exe fails the release" once the cert exists).
#
# signing.env keys (gitignored; era-family/data is never committed):
#   SIGN_PKCS11_MODULE=/opt/proCertumSmartSign/libcryptoCertum3PKCS.so
#   SIGN_PKCS11_PIN=<SimplySign PIN>
#   SIGN_CERT_PEM=/home/claude/new-era/era-family/data/certum-oss.pem   (public cert chain)
#   SIGN_KEY_URI='pkcs11:token=…;object=…'   (from `p11tool --list-all`; optional — first key if unset)
#   SIGN_TSA=http://time.certum.pl                                       (optional)
# Alternative (PFX exported from a card/cloud tool — same env file):
#   SIGN_PFX=/home/claude/new-era/era-family/data/certum-oss.pfx  SIGN_PFX_PASS=…
set -euo pipefail
EXE="${1:?usage: sign-installer.sh <file.exe>}"
HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
ENV="$ROOT/era-family/data/signing.env"
OSSL="$ROOT/era-family/cache/osslsigncode/usr/bin/osslsigncode"

if [ ! -f "$ENV" ]; then
  echo "sign: UNSIGNED $(basename "$EXE") (no era-family/data/signing.env — see docs/signing-plan.md)"
  exit 0
fi
set -a; . "$ENV"; set +a
[ -x "$OSSL" ] || { echo "sign: osslsigncode missing at $OSSL"; exit 1; }

TSA="${SIGN_TSA:-http://time.certum.pl}"
COMMON=(-n "New ERA" -i "https://neweracommunications.org" -h sha256 -ts "$TSA")
TMP="$EXE.signed"
if [ -n "${SIGN_PFX:-}" ]; then
  "$OSSL" sign -pkcs12 "$SIGN_PFX" -pass "$SIGN_PFX_PASS" "${COMMON[@]}" -in "$EXE" -out "$TMP"
else
  "$OSSL" sign -pkcs11module "$SIGN_PKCS11_MODULE" -certs "$SIGN_CERT_PEM" \
    ${SIGN_KEY_URI:+-key "$SIGN_KEY_URI"} -pass "$SIGN_PKCS11_PIN" \
    "${COMMON[@]}" -in "$EXE" -out "$TMP"
fi
mv -f "$TMP" "$EXE"
# verify chains to the system CA bundle (Certum Trusted Network CA is in it)
"$OSSL" verify -in "$EXE" | grep -q "Signature verification: ok" \
  || { echo "sign: verification FAILED for $EXE"; exit 1; }
echo "sign: SIGNED $(basename "$EXE") (timestamped at $TSA)"
