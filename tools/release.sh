#!/usr/bin/env bash
# release.sh <version> [--patch] [--prerelease] [--dry-run] [--skip-gate] — cut a New ERA suite release.
# Two shapes (docs/superpowers/specs/2026-09-15-dev-flow-worktrees-and-patch-releases-design.md §4):
#
#   SIGNED (default, normally vX.Y.0 — a new installer)
#     1/5 gate       era-gate fully green (no release on a red gate, ever)
#     2/5 build      build-dist.sh --unsigned: payload WITH bundled node, tarball,
#                    zip, checksums, latest.json, and an UNSIGNED Setup.exe
#     3/5 VM e2e     legs A+B on those very files, pristine Windows 10 (vm-e2e.sh)
#     4/5 sign       ONLY now is the SimplySign code wanted: sign-installer.sh --check
#                    then build-dist.sh --sign-only (makensis again WITH -DSIGN over the
#                    same payload — signing lives inside makensis, so the uninstaller
#                    stub is signed too; the tarball is asserted unchanged)
#     5/5 publish    tag + GitHub Release (six assets), then leg C against the real
#                    download URL; a red leg C says PULL THE RELEASE and exits 1 —
#                    it deletes nothing, because a pulled release 404s the website
#
#   PATCH (--patch, vX.Y.Z with Z>=1 — a new tarball under the SAME installer)
#     1/4 gate    2/4 build (build-dist.sh --patch: no makensis; the signed installer
#     named by the live latest.json is downloaded and re-attached, signature verified)
#     3/4 VM e2e  vm-e2e.sh --only b: that installer, fresh on the VM, self-updating to
#     the candidate tarball — the only path a patch takes on any device
#     4/4 publish tag + Release with notes naming the installer tag. No signing, no code.
#
# Flags
#   --patch       the patch shape above; $V must share X.Y with the installer it carries
#   --prerelease  hidden from the website and from the updater (legal with --patch too)
#   --dry-run     SIGNED: stop after the VM, with an unsigned exe, before asking for a
#                 code. PATCH: stop after the VM, before the tag. Publishes nothing.
#   --skip-gate   re-cut after a failure PAST a green gate (a lapsed login, a starved
#                 VM host) — allowed only on the strength of a green stamp
#                 (/tmp/era-gate-green/<tree>, written by era-gate.sh on every green run
#                 from any checkout) under 2 h old: either this HEAD's own tree, or a
#                 stamped HEAD whose tree differs from ours only under tools/, tests-vm/
#                 and docs/ (the build and the VM legs run again regardless). Never a
#                 way past a red gate. Legal in both shapes.
#   --gate-check  (hidden, with --skip-gate) evaluate the gate step only and exit 0/1 —
#                 nothing is built, signed or published.
# The website's download links point at the latest release assets.
set -euo pipefail
V="${1:?usage: release.sh vX.Y.Z [--patch] [--prerelease] [--dry-run] [--skip-gate]}"; shift
PRE=""; DRY=0; SKIPGATE=0; GATECHECK=0; PATCH=0
for a in "$@"; do case "$a" in --prerelease) PRE=1;; --dry-run) DRY=1;; --skip-gate) SKIPGATE=1;; --gate-check) GATECHECK=1;; --patch) PATCH=1;; *) echo "release.sh: unknown flag $a"; exit 2;; esac; done
if [ "$GATECHECK" = 1 ] && [ "$SKIPGATE" = 0 ]; then
  echo "release.sh: --gate-check only makes sense with --skip-gate (it must never start a gate)"; exit 2
fi
HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
DIST="$ROOT/dist/release-$V"
HEAD="$(git -C "$HUB" rev-parse HEAD)"
REPO=nauerhahn26/new-era-releases
if [ "$PATCH" = 1 ]; then N=4; else N=5; fi

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

echo "== 1/$N gate =="
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

# the app list is server.js APPS — keep the two in step
APPS="New ERA suite $V — free eye-gaze apps for a child on a Tobii device, all running on the family's own PC: Making Words, The Pencil, Clothing Picker, Music, Movies, Book Reader, plus the ERAgaze engine for PCs without one. Bundled Node runtime; nothing about your child leaves the machine."
TAIL="Every release is installed and driven end to end on a clean Windows 10 before it is published. sha256 in checksums.txt."

if [ "$PATCH" = 1 ]; then
  echo "== 2/4 build (payload, zip, checksums, latest.json; the published signed installer re-attached) =="
  bash "$HUB/tools/build-dist.sh" "$V" "$DIST" --patch
  TAG="$(python3 -c "import json;print(json.load(open('$DIST/latest.json'))['installer'])")"

  echo "== 3/4 VM e2e (leg B: $TAG's installer fresh on a pristine Windows 10, self-updating to $V — the only path a patch takes) =="
  bash "$HUB/tools/vm-e2e.sh" "$DIST" --only b | tee /tmp/era-release-vm-e2e.txt | tail -20
  grep -q "^== vm-e2e: .* 0 failed ==" /tmp/era-release-vm-e2e.txt || { echo "VM E2E NOT GREEN — no release. Evidence: $HUB/gate/vm-e2e/"; exit 1; }

  if [ "$DRY" = 1 ]; then echo "DRY RUN: built + gated $V (patch, installer $TAG) in $DIST — not tagged, not published."; exit 0; fi
  echo "== 4/4 tag + release =="
  NOTES="$APPS
Installer: $TAG (code-signed, Certum). Installed copies update themselves to $V on first run; a fresh install from the website gets $TAG and updates itself within minutes.
$TAIL"
else
  echo "== 2/5 build (payload, zip, checksums, latest.json, UNSIGNED installer — it is signed after the VM) =="
  bash "$HUB/tools/build-dist.sh" "$V" "$DIST" --unsigned

  echo "== 3/5 VM e2e (the candidate installed and driven on a pristine Windows 10; the previous release self-updating to it) =="
  bash "$HUB/tools/vm-e2e.sh" "$DIST" | tee /tmp/era-release-vm-e2e.txt | tail -20
  grep -q "^== vm-e2e: .* 0 failed ==" /tmp/era-release-vm-e2e.txt || { echo "VM E2E NOT GREEN — no release. Evidence: $HUB/gate/vm-e2e/"; exit 1; }

  if [ "$DRY" = 1 ]; then echo "DRY RUN: built + gated $V in $DIST with an UNSIGNED installer — signing not attempted, not published."; exit 0; fi

  echo "== 4/5 sign =="
  echo "VM green — ready for the SimplySign code (stage it now)."
  bash "$HUB/tools/sign-installer.sh" --check || { echo "SIGNING NOT READY — no release (log in, then re-run with --skip-gate against the green stamp)."; exit 1; }
  bash "$HUB/tools/build-dist.sh" "$V" "$DIST" --sign-only

  echo "== 5/5 tag + release =="
  NOTES="$APPS
Install: download New-ERA-Setup.exe and double-click it, then pick your apps on the welcome screen. The installer is code-signed (Certum; right-click › Properties › Digital Signatures shows the publisher) — Windows may still ask once while the new signature earns its reputation: choose More info, then Run anyway. The portable .zip works too. Installed copies update themselves; Uninstall never touches your data.
$TAIL"
fi

git -C "$HUB" tag -f "$V"
git -C "$HUB" push -q origin "refs/tags/$V" --force
gh release create "$V" --repo "$REPO" --title "New ERA suite $V" \
  --notes "$NOTES" ${PRE:+--prerelease} \
  "$DIST/new-era-suite-$V.tar.gz" "$DIST/new-era-suite.tar.gz" "$DIST/new-era-suite.zip" "$DIST/New-ERA-Setup.exe" "$DIST/checksums.txt" "$DIST/latest.json"
echo "RELEASED: $V"

if [ "$PATCH" = 0 ]; then
  echo "== post-publish: leg C (the website's own download, in a browser, opened by the shell) =="
  if ! bash "$HUB/tools/vm-e2e.sh" "$DIST" --post-publish; then
    echo "LEG C RED — PULL THE RELEASE: gh release delete $V --repo $REPO --yes  (and re-attach the previous installer first if the website must stay up)"
    exit 1
  fi
fi
