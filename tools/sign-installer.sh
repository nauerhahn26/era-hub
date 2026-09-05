#!/usr/bin/env bash
# sign-installer.sh <exe> — Authenticode-sign one Windows executable in place.
# Called by makensis for BOTH the uninstaller stub and Setup.exe (see the
# !uninstfinalize / !finalize lines in installer.nsi), so every release is
# either fully signed or honestly unsigned — never half.
#
# No certificate yet (era-family/data/signing.env absent): print UNSIGNED and
# exit 0, so builds keep working exactly as today.
# Certificate present: sign with osslsigncode (vendored deb in
# era-family/cache/osslsigncode — no root on the build box) through Certum's
# SimplySign cloud PKCS#11 module, RFC-3161 timestamp at Certum, then verify.
# Any failure exits non-zero and fails the release (docs/signing-plan.md §3:
# "an unsigned Setup.exe fails the release" once the cert exists).
#
# The cloud module only shows a token while SimplySign Desktop is running AND
# logged in (era-family/tools/simplysign.sh up / login / token — one phone code
# a session); "no slots" here means it is not, and the cut fails saying so.
#
# signing.env keys (gitignored; era-family/data is never committed):
#   SIGN_PKCS11_MODULE=…/cache/simplysign/dists/SSD-2.9.14-dist/SimplySignPKCS_64-MS-1.0.20.so
#                       (default; the CLOUD module — libcryptoCertum3PKCS.so is the smart-card one)
#   SIGN_PKCS11_ENGINE=…/cache/simplysign/syslibs/usr/lib/x86_64-linux-gnu/engines-3/pkcs11.so
#                       (default; osslsigncode 2.8 needs the libp11 engine, extracted deb)
#   SIGN_PKCS11_CERT='pkcs11:model=SimplySign%20C'   (default; cert read from the token)
#   SIGN_KEY_URI='pkcs11:…'         optional — same object as the cert if unset
#   SIGN_CERT_PEM=…/certum-oss.pem  optional — use this chain instead of the token's
#   SIGN_PKCS11_PIN=…               optional — only if the token asks for a PIN
#   SIGN_TSA=http://time.certum.pl  optional
# Alternative (PFX exported from a card/cloud tool — same env file):
#   SIGN_PFX=/home/claude/new-era/era-family/data/certum-oss.pfx  SIGN_PFX_PASS=…
set -euo pipefail
EXE="${1:?usage: sign-installer.sh <file.exe>}"
HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
ENV="$ROOT/era-family/data/signing.env"
OSSL="$ROOT/era-family/cache/osslsigncode/usr/bin/osslsigncode"
SS="$ROOT/era-family/cache/simplysign"

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
  MODULE="${SIGN_PKCS11_MODULE:-$SS/dists/SSD-2.9.14-dist/SimplySignPKCS_64-MS-1.0.20.so}"
  ENGINE="${SIGN_PKCS11_ENGINE:-$SS/syslibs/usr/lib/x86_64-linux-gnu/engines-3/pkcs11.so}"
  CERT_URI="${SIGN_PKCS11_CERT:-pkcs11:model=SimplySign%20C}"
  [ -f "$MODULE" ] || { echo "sign: PKCS#11 module missing at $MODULE"; exit 1; }
  [ -f "$ENGINE" ] || { echo "sign: pkcs11 engine missing at $ENGINE"; exit 1; }
  # the module's own libs (bundled OpenSSL 1.0) and the extracted debs
  export LD_LIBRARY_PATH="$(dirname "$MODULE"):$SS/syslibs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  P11="$SS/syslibs/usr/bin/pkcs11-tool"
  if [ -x "$P11" ] && { "$P11" --module "$MODULE" -L 2>&1 || true; } | grep -q "No slots"; then   # (exits 1 with no slots)
    echo "sign: SimplySign Desktop is not logged in (no token) — era-family/tools/simplysign.sh login/token, then re-cut"
    exit 1
  fi
  if [ -n "${SIGN_CERT_PEM:-}" ]; then CERTARGS=(-certs "$SIGN_CERT_PEM" -key "${SIGN_KEY_URI:-$CERT_URI}")
  else CERTARGS=(-pkcs11cert "$CERT_URI" ${SIGN_KEY_URI:+-key "$SIGN_KEY_URI"}); fi
  "$OSSL" sign -pkcs11engine "$ENGINE" -pkcs11module "$MODULE" "${CERTARGS[@]}" \
    ${SIGN_PKCS11_PIN:+-pass "$SIGN_PKCS11_PIN"} \
    "${COMMON[@]}" -in "$EXE" -out "$TMP"
fi
mv -f "$TMP" "$EXE"
# verify chains to the system CA bundle (Certum Trusted Network CA is in it)
"$OSSL" verify -in "$EXE" | grep -q "Signature verification: ok" \
  || { echo "sign: verification FAILED for $EXE"; exit 1; }
echo "sign: SIGNED $(basename "$EXE") (timestamped at $TSA)"
