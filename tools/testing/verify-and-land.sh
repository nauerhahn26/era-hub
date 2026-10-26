#!/usr/bin/env bash
# Explicit owner operation: sync, complete verification and land under one
# cooperative integration reservation. Test jobs never invoke this implicitly.
set -euo pipefail

die() { printf 'refusing: %s\n' "$*" >&2; exit 1; }
[ "$#" = 2 ] || die 'usage: verify-and-land.sh <main-era-hub-checkout> <feature-slug>'
[ -d "$1" ] || die 'main repository is missing'
MAIN="$(cd "$1" && pwd -P)"
[ "$(basename "$MAIN")" = era-hub ] || die 'this transaction supports the hub only; land dependencies manually in their required order'
SLUG="$2"
[[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die 'invalid feature slug'
ROOT="$(dirname "$MAIN")"
WT="$MAIN--wt-$SLUG"
TOOL="${ERA_WORKTREE_TOOL:-$HOME/aac-board-builder/tools/worktree.sh}"
[[ "$TOOL" = /* ]] && [ -f "$TOOL" ] || die 'worktree helper must be an existing absolute path'
[ -d "$WT" ] && [ -f "$WT/tools/era-gate.sh" ] || die 'chosen hub feature or complete gate is missing'
GATE_LOCK="${ERA_GATE_LOCK:-/tmp/era-gate.lock}"
LAND_LOCK="${ERA_LAND_LOCK:-/tmp/era-land.lock}"
[[ "$GATE_LOCK" = /* ]] && [[ "$LAND_LOCK" = /* ]] || die 'reservation lock paths must be absolute'

has_capability() {
  node -e 'try { const c=JSON.parse(process.argv[1]); process.exit(c[process.argv[2]]===1?0:1); } catch { process.exit(1); }' "$1" "$2"
}
helper_capable() {
  local capabilities
  capabilities="$(bash "$TOOL" capabilities)" || die 'worktree helper lacks the integration reservation capability'
  has_capability "$capabilities" inheritedLandLock && has_capability "$capabilities" landChecksUnderLock \
    || die 'worktree helper lacks the required locked-check capabilities; update it before this operation'
}
gate_capable() {
  local capabilities
  capabilities="$(bash "$WT/tools/era-gate.sh" --capabilities)" || die 'chosen complete gate lacks the inherited-lock capability'
  has_capability "$capabilities" inheritedGateLock || die 'chosen complete gate lacks the inherited-lock capability'
  if [ "$GATE_LOCK" != /tmp/era-gate.lock ]; then
    has_capability "$capabilities" customGateLock || die 'the complete gate requires its canonical machine lock; custom gate locks are refused'
  fi
}
clean() {
  local dirt
  dirt="$(git -C "$1" status --porcelain)" || die "cannot inspect $1"
  [ -z "$dirt" ] || die "$1 must be clean before an integration transaction"
}
paired_sources_landed() {
  local repo paired source
  for repo in era-core era-making-words era-pencil era-board era-gaze; do
    source="$ROOT/$repo"
    if [ -d "$source" ]; then
      clean "$source"
      [ "$(git -C "$source" rev-parse --abbrev-ref HEAD)" = master ] || die "selected sibling $repo must be on clean master"
    fi
    paired="$ROOT/$repo--wt-$SLUG"
    [ -d "$paired" ] || continue
    clean "$paired"
    git -C "$paired" merge-base --is-ancestor HEAD master \
      || die "matching sibling $repo has an unlanded dependency; its owner must land it first"
  done
}

# Refuse old components before opening locks or changing a source tree.
helper_capable
gate_capable
echo 'integration: waiting for the complete gate reservation'
exec 7>"$GATE_LOCK"
flock -n 7 || flock 7
echo 'integration: waiting for the landing reservation'
exec 8>"$LAND_LOCK"
flock -n 8 || flock 8
export ERA_LAND_LOCK="$LAND_LOCK" ERA_LAND_LOCK_FD=8

# Every mutable assertion is made again after both reservations are held.
helper_capable
gate_capable
[ "$(git -C "$MAIN" rev-parse --abbrev-ref HEAD)" = master ] || die 'main checkout must be on master'
clean "$MAIN"
clean "$WT"
[ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" != HEAD ] || die 'chosen feature is detached'
paired_sources_landed

bash "$TOOL" sync "$MAIN" "$SLUG"
clean "$WT"
gate_capable
HEAD_BEFORE="$(git -C "$WT" rev-parse HEAD)"
TREE_BEFORE="$(git -C "$WT" rev-parse 'HEAD^{tree}')"

# Matching dependencies were already landed by their owners. Verify their
# current main sources, not potentially older feature-worktree copies.
export ERA_WT_SUFFIX='' ERA_GATE_MODE=full ERA_GATE_LOCK_FD=7
unset ERA_GATE_SELECTED ERA_GATE_INPUTS ERA_GATE_CANCEL_FILE ERA_GATE_JOB_DIR
(cd "$WT" && bash tools/era-gate.sh)
[ "$(git -C "$WT" rev-parse HEAD)" = "$HEAD_BEFORE" ] || die 'feature HEAD changed during verification'
clean "$WT"
STAMP="${ERA_GATE_STAMPS:-/tmp/era-gate-green}/$TREE_BEFORE"
[ -f "$STAMP" ] || die 'complete gate did not produce an exact-tree stamp'
summary="$(head -1 "$STAMP")"
[[ "$summary" =~ ^==\ era-gate:\ [0-9]+\ passed,\ 0\ failed\ ==$ ]] || die 'exact-tree stamp is not a complete green gate'
! grep -qx 'dirty=1' "$STAMP" || die 'complete gate stamped dirty inputs'
[ "$(sed -n 's/^head=//p' "$STAMP" | head -1)" = "$HEAD_BEFORE" ] || die 'complete gate stamp names another candidate'
at="$(sed -n 's/^at=//p' "$STAMP" | head -1)"
[[ "$at" =~ ^[0-9]+$ ]] || die 'complete gate stamp has no valid time'
age=$(( $(date +%s) - at ))
[ "$age" -ge 0 ] && [ "$age" -lt 7200 ] || die 'complete gate stamp is outside the existing acceptance window'

# The capable helper revalidates main, ancestry and stamp while reusing FD8.
bash "$TOOL" land "$MAIN" "$SLUG"
echo 'integration: verified candidate landed; release publication remains separate'
