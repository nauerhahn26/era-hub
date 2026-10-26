#!/usr/bin/env bash
# era-gate.sh — the L0/L1 parity gate for the Our Era Comms workspace.
# Collects every sibling repo's test suite into gate/ (copies, port re-pointed
# to the test instance), starts the hub server on $ERA_TEST_PORT (default 8378,
# NEVER the live 8377), runs the suites, reports.
# Flow: docs/dev-flow.md
set -uo pipefail

# These guards are also exercised against synthetic workspaces and owned local
# stand-ins. They do not acquire the real gate lock when tested independently.
gate_error() {
  printf 'FATAL: %s\n' "$*" >&2
  return 1
}

gate_capabilities() {
  printf '%s\n' '{"inheritedGateLock":1}'
}

# Capability discovery must be read-only even on an unassembled checkout.
if [ "${1:-}" = --capabilities ]; then gate_capabilities; exit 0; fi

gate_acquire_lock() {
  local descriptor="${ERA_GATE_LOCK_FD:-}" expected actual
  if [ -n "$descriptor" ]; then
    [[ "$descriptor" =~ ^[0-9]{1,6}$ ]] && [ "$descriptor" -ge 3 ] || {
      gate_error "invalid inherited gate lock descriptor"; return 1;
    }
    expected="$(stat -Lc '%d:%i' -- "$LOCK" 2>/dev/null)" &&
      actual="$(stat -Lc '%d:%i' -- "/proc/$$/fd/$descriptor" 2>/dev/null)" &&
      [ "$actual" = "$expected" ] || {
        gate_error "inherited gate lock descriptor does not name the gate lock"; return 1;
      }
    flock -n "$descriptor" || { gate_error "inherited gate lock cannot establish an exclusive lease"; return 1; }
    return 0
  fi
  exec 9>"$LOCK" || { gate_error "cannot open gate lock"; return 1; }
  if flock -n 9; then return 0; fi
  echo "== era-gate: another gate run is active — queued, waiting… =="
  flock 9 || { gate_error "cannot acquire gate lock"; return 1; }
}

gate_validate_port() {
  case "$1" in
    8378|838[0-9]) return 0 ;;
    *) gate_error "test port must be 8378 or 8380-8389" ;;
  esac
}

gate_export_test_data() {
  local resolved live candidate
  [ -n "$DATA" ] || { gate_error "unsafe data directory: empty path"; return 1; }
  resolved="$(realpath -m -- "$DATA")" || { gate_error "unsafe data directory"; return 1; }
  for candidate in "$ROOT/era-family/data" "$ROOT/era-hub/data" "$HUB/data"; do
    live="$(realpath -m -- "$candidate")" || return 1
    case "$resolved/" in "$live/"*) gate_error "live data directory is forbidden for tests"; return 1 ;; esac
    case "$live/" in "$resolved/"*) gate_error "unsafe data directory contains a live-data path"; return 1 ;; esac
  done
  DATA="$resolved"
  export ERA_DATA_DIR="$DATA"
}

gate_prepare_owned_data() {
  local unsupported
  [ -d "$DATA" ] || { gate_error "test seed directory is missing"; return 1; }
  unsupported="$(find "$DATA" \( -type l -o \( ! -type f ! -type d \) \) -print -quit)" || {
    gate_error "cannot inspect test seed"; return 1;
  }
  [ -z "$unsupported" ] || { gate_error "test seed contains a symlink or unsupported entry"; return 1; }
  export ERA_GATE_SEED_DIR="$DATA"
  OWN_DATA="$(mktemp -d "${TMPDIR:-/tmp}/era-gate-data.XXXXXX")" || return 1
  cp -a -- "$ERA_GATE_SEED_DIR/." "$OWN_DATA/" && chmod 700 "$OWN_DATA" || {
    gate_error "cannot copy test seed"; return 1;
  }
  diff -qr -- "$ERA_GATE_SEED_DIR" "$OWN_DATA" >/dev/null || {
    gate_error "test seed changed while copying"; return 1;
  }
  DATA="$OWN_DATA"
  export ERA_DATA_DIR="$DATA"
}

gate_refresh_data_links() {
  local directory="$1" link target
  for link in lessons.json sentences.json runway.json; do
    if [ -e "$HUB/public/$link" ] && [ ! -L "$HUB/public/$link" ]; then
      gate_error "unowned generated content link: $link"; return 1;
    fi
    [ ! -L "$HUB/public/$link" ] || rm -- "$HUB/public/$link" || return 1
    target="$directory/content/$link"
    if [ -f "$target" ]; then
      ln -s -- "$target" "$HUB/public/$link" || return 1
    fi
  done
}

gate_refresh_farm() {
  local pair link repo want
  [ ! -L "$HUB/public" ] || { gate_error "unowned served farm directory"; return 1; }
  mkdir -p "$HUB/public" || return 1
  for pair in "pencil:era-pencil" "board:era-board" "lib:era-core" "studio.js:era-making-words" \
              "dwell.js:era-core" "speech.js:era-core" "index.html:era-making-words"; do
    link="${pair%%:*}"; repo="${pair#*:}"
    want="../../$(basename "$(sib "$repo")")"
    case "$link" in pencil|board) want="$want/app" ;; lib) want="$want/lib" ;;
      studio.js) want="$want/app/studio.js" ;; index.html) want="$want/app/index.html" ;;
      *) want="$want/$link" ;; esac
    [ -e "$HUB/public/$want" ] || { gate_error "selected farm source is missing: $link"; return 1; }
    if [ -e "$HUB/public/$link" ] && [ ! -L "$HUB/public/$link" ]; then
      gate_error "unowned generated runtime link: $link"; return 1;
    fi
    if [ ! -L "$HUB/public/$link" ] || [ "$(readlink "$HUB/public/$link")" != "$want" ]; then
      ln -sfn -- "$want" "$HUB/public/$link" || return 1
    fi
  done
  gate_refresh_data_links "$DATA"
}

gate_port_available() {
  local listeners
  listeners="$(ss -H -ltn "sport = :$1")" || { gate_error "cannot inspect test port"; return 1; }
  [ -z "$listeners" ] || { gate_error "test port is occupied; its owner was left running"; return 1; }
}

gate_process_identity() {
  local pid="$1" stat rest
  local -a fields
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [ -r "/proc/$pid/stat" ] || return 1
  IFS= read -r stat <"/proc/$pid/stat" || return 1
  rest="${stat##*) }"
  read -r -a fields <<<"$rest"
  [ "${#fields[@]}" -ge 20 ] || return 1
  [ "${fields[0]}" != Z ] || return 1
  printf '%s:%s\n' "${fields[1]}" "${fields[19]}"
}

gate_process_matches() {
  local pid="$1" expected="$2" arguments="$3" identity current
  [ -n "$expected" ] && [ -n "$arguments" ] || return 1
  identity="$(gate_process_identity "$pid")" || return 1
  [ "$identity" = "$expected" ] || return 1
  # A matching command alone cannot authorize taking over another session's PID.
  case "$identity" in "$$":*) ;; *) return 1 ;; esac
  current="$(ps -ww -p "$pid" -o args=)" || return 1
  [ "$current" = "$arguments" ]
}

gate_wait_process() {
  local pid="$1" identity="$2" arguments="$3" tries="${4:-50}" attempt current
  for ((attempt=0; attempt<tries; attempt++)); do
    current="$(gate_process_identity "$pid")" || return 1
    [ "$current" = "$identity" ] || return 1
    case "$current" in "$$":*) ;; *) return 1 ;; esac
    gate_process_matches "$pid" "$identity" "$arguments" && return 0
    sleep 0.02
  done
  return 1
}

gate_cleanup_server() {
  local pid="$1" identity="$2" arguments="$3" attempt
  gate_wait_process "$pid" "$identity" "$arguments" 20 || return 0
  kill "$pid" 2>/dev/null || return 0
  for attempt in {1..20}; do
    gate_process_matches "$pid" "$identity" "$arguments" || break
    sleep 0.05
  done
  if gate_process_matches "$pid" "$identity" "$arguments"; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

gate_listener_owned() {
  local port="$1" pid="$2" listeners line
  listeners="$(ss -H -ltnp "sport = :$port")" || return 1
  [ -n "$listeners" ] || return 1
  while IFS= read -r line; do
    case "$line" in *"pid=$pid,"*) ;; *) return 1 ;; esac
  done <<<"$listeners"
}

gate_wait_server() {
  local pid="$1" identity="$2" arguments="$3" port="$4" tries="${5:-30}" attempt
  for ((attempt=0; attempt<tries; attempt++)); do
    gate_process_matches "$pid" "$identity" "$arguments" || {
      gate_error "owned test server exited or changed before readiness"; return 1;
    }
    if gate_listener_owned "$port" "$pid" &&
       curl --max-time 1 -sf "http://127.0.0.1:$port/settings" >/dev/null &&
       gate_process_matches "$pid" "$identity" "$arguments" &&
       gate_listener_owned "$port" "$pid"; then return 0; fi
    sleep 0.1
  done
  gate_error "owned test server readiness could not be established"
}

gate_collect_entry() {
  local src="$1" dest="$2" repo="$3" relative="$4" child base
  if [ -d "$src" ] && [ ! -L "$src" ]; then
    [ ! -e "$dest" ] || [ -d "$dest" ] || {
      gate_error "duplicate collected path: $relative"; return 1;
    }
    [ ! -L "$dest" ] || { gate_error "duplicate collected path: $relative"; return 1; }
    mkdir -p "$dest" || { gate_error "cannot create collection directory"; return 1; }
    for child in "$src"/* "$src"/.[!.]* "$src"/..?*; do
      [ -e "$child" ] || [ -L "$child" ] || continue
      base="$(basename "$child")"
      gate_collect_entry "$child" "$dest/$base" "$repo" "$relative/$base" || return 1
    done
  else
    [ ! -e "$dest" ] && [ ! -L "$dest" ] || {
      gate_error "duplicate collected path: $relative"; return 1;
    }
    cp -r -- "$src" "$dest" || { gate_error "copy failed while collecting $repo/tests/$relative"; return 1; }
    printf '%s\t%s\n' "$repo:tests/$relative" "$relative" >>"$GATE/.source-map.tsv" || return 1
  fi
}

gate_collect_suites() {
  local repo src f base name
  : >"$GATE/.source-map.tsv" || { gate_error "cannot write collection source map"; return 1; }
  for repo in era-core era-making-words era-pencil era-board era-hub; do
    src="$(sib "$repo")"; [ "$repo" = "era-hub" ] && src="$HUB"
    [ -d "$src/tests" ] || { gate_error "missing required tests directory: $repo/tests"; return 1; }
    for f in "$src/tests"/* "$src/tests"/.[!.]* "$src/tests"/..?*; do
      [ -e "$f" ] || [ -L "$f" ] || continue
      base="$(basename "$f")"
      gate_collect_entry "$f" "$GATE/$base" "$repo" "$base" || return 1
    done
  done
  for name in run parts transfer mistakes pencil narrow sortfix fltest bargein sortbugs rhymecount transfercount phonetic; do
    [ -f "$GATE/$name.js" ] || { gate_error "missing required legacy suite: $name.js"; return 1; }
  done
}

gate_prepare_selection() {
  case "${ERA_GATE_MODE:-full}" in
    full)
      [ -z "${ERA_GATE_SELECTED:-}" ] || { gate_error "selection requires affected mode"; return 1; }
      return 0 ;;
    affected) ;;
    *) gate_error "unknown gate selection mode"; return 1 ;;
  esac
  [ -n "${ERA_GATE_SELECTED:-}" ] || { gate_error "selection file is required"; return 1; }
  node - "$ERA_GATE_SELECTED" "$GATE/.source-map.tsv" "$GATE/.selected-basename" <<'JS'
const fs = require('node:fs'), path = require('node:path');
try {
  const [file, mapFile, output] = process.argv.slice(2);
  if (!path.isAbsolute(file)) throw Error('selection file must be absolute');
  const wanted = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(wanted) || !wanted.length) throw Error('selection must be a nonempty array');
  const legacy = new Set(['run','parts','transfer','mistakes','pencil','narrow','sortfix',
    'fltest','bargein','sortbugs','rhymecount','transfercount','phonetic'].map(x => x + '.js'));
  const known = new Map(fs.readFileSync(mapFile, 'utf8').trim().split('\n').map(line => line.split('\t')));
  const selected = new Set();
  for (const id of wanted) {
    const name = known.get(id);
    if (typeof id !== 'string' || !name || name.includes('/') ||
      (!name.endsWith('.test.mjs') && !legacy.has(name))) throw Error('selection names an unknown executable suite');
    if (selected.has(name)) throw Error('selection contains a duplicate suite');
    selected.add(name);
  }
  fs.writeFileSync(output, [...selected].join('\n') + '\n');
  } catch (error) {
  process.stderr.write('FATAL: invalid selection: ' + error.message + '\n');
  process.exitCode = 1;
  }
JS
}

gate_suite_selected() {
  [ "${ERA_GATE_MODE:-full}" = full ] || grep -Fxq -- "$1" "$GATE/.selected-basename"
}

gate_freeze_execution() {
  local id name digest
  node - "$HUB/tools/testing/registry.json" "$GATE" "${ERA_GATE_MODE:-full}" <<'JS'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
try {
  const [registryFile, directory, mode] = process.argv.slice(2);
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  const required = new Set(registry.suites.map(suite => suite.id));
  const legacy = ['run','parts','transfer','mistakes','pencil','narrow','sortfix',
    'fltest','bargein','sortbugs','rhymecount','transfercount','phonetic'].map(name => name + '.js');
  const rows = fs.readFileSync(path.join(directory, '.source-map.tsv'), 'utf8').trim().split('\n')
    .map(line => line.split('\t')).filter(([, name]) => name && !name.includes('/') &&
      (name.endsWith('.test.mjs') || legacy.includes(name)));
  const collected = new Set(rows.map(([id]) => id));
  if (collected.size !== rows.length || collected.size !== required.size ||
    [...required].some(id => !collected.has(id))) throw Error('registered suite collection is incomplete');
  const selected = mode === 'full' ? null : new Set(fs.readFileSync(path.join(directory, '.selected-basename'), 'utf8').trim().split('\n'));
  const planned = rows.filter(([, name]) => !selected || selected.has(name)).sort((a, b) => {
    const ai = legacy.indexOf(a[1]), bi = legacy.indexOf(b[1]);
    return ai >= 0 || bi >= 0 ? (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) : a[1].localeCompare(b[1]);
  });
  if (!planned.length) throw Error('no executable suites selected');
  const lines = planned.map(([id, name]) => {
    if (/\s|\\/.test(name)) throw Error('unsupported executable suite name');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex');
    return [id, name, digest].join('\t');
  });
  fs.writeFileSync(path.join(directory, '.execution-plan.tsv'), lines.join('\n') + '\n');
  } catch (error) {
    process.stderr.write('FATAL: cannot freeze execution: ' + error.message + '\n');
    process.exitCode = 1;
  }
JS
  [ "$?" = 0 ] || return 1
  EXPECTED_IDS=(); EXPECTED_FILES=(); EXPECTED_HASHES=()
  declare -gA EXECUTED_COUNT=()
  while IFS=$'\t' read -r id name digest; do
    EXPECTED_IDS+=("$id"); EXPECTED_FILES+=("$name"); EXPECTED_HASHES+=("$digest")
  done <"$GATE/.execution-plan.tsv"
}

gate_record_execution() {
  local index="$1" id name digest
  [[ "$index" =~ ^[0-9]+$ ]] && [ -n "${EXPECTED_FILES[$index]:-}" ] || {
    gate_error "unexpected suite execution"; return 1;
  }
  id="${EXPECTED_IDS[$index]}"; name="${EXPECTED_FILES[$index]}"
  [ "${EXECUTED_COUNT["$id"]:-0}" = 0 ] || { gate_error "duplicate suite execution: $id"; return 1; }
  [ -f "$GATE/$name" ] || { gate_error "missing collected suite: $id"; return 1; }
  digest="$(sha256sum -- "$GATE/$name")" || return 1
  [ "${digest%% *}" = "${EXPECTED_HASHES[$index]}" ] || { gate_error "collected suite changed before execution: $id"; return 1; }
  EXECUTED_COUNT["$id"]=1
}

gate_verify_execution() {
  local id
  for id in "${EXPECTED_IDS[@]}"; do
    [ "${EXECUTED_COUNT["$id"]:-0}" = 1 ] || { gate_error "missing suite execution: $id"; return 1; }
  done
  [ "${#EXECUTED_COUNT[@]}" = "${#EXPECTED_IDS[@]}" ] || { gate_error "unexpected suite execution count"; return 1; }
}

gate_archive_reports() {
  local file
  [ -n "${ERA_GATE_JOB_DIR:-}" ] || return 0
  [ "${GATE_PREPARED:-0}" = 1 ] || return 0
  case "$ERA_GATE_JOB_DIR" in /*) ;; *) gate_error "job report directory must be absolute"; return 1 ;; esac
  mkdir -p "$ERA_GATE_JOB_DIR/suites" || return 1
  for file in "$GATE"/*.out "$GATE"/server.log; do
    [ -f "$file" ] || continue
    cp -- "$file" "$ERA_GATE_JOB_DIR/suites/" || return 1
  done
}

gate_finish() {
  local status="$1"
  gate_cleanup_server "${SRV:-}" "${SRV_ID:-}" "${SRV_ARGS:-}"
  if [ "${REPORTS_SAVED:-0}" != 1 ]; then gate_archive_reports || status=1; fi
  [ -z "${OWN_INPUTS:-}" ] || rm -f -- "$OWN_INPUTS"
  if [ -n "${OWN_DATA:-}" ]; then
    gate_refresh_data_links "$ERA_GATE_SEED_DIR" || status=1
    rm -rf -- "$OWN_DATA" || status=1
  fi
  trap - EXIT
  exit "$status"
}

HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
DATA="${ERA_GATE_SEED_DIR:-${ERA_DATA_DIR:-$ROOT/era-family/test-data}}"  # immutable seed, never live data
PORT="${ERA_TEST_PORT:-8378}"
GATE="$HUB/gate"
OWN_DATA=""; OWN_INPUTS=""; SRV=""; SRV_ID=""; SRV_ARGS=""; GATE_PREPARED=0
# ERA_WT_SUFFIX (9/17): a multi-repo feature keeps sibling worktrees
# (<repo>--wt-<slug>); when set and that directory exists, source the
# sibling from there, else from the main checkout as before. Without it a
# hub-worktree gate would collect MASTER's era-core/board/pencil/words suites
# and never run the feature's — the same blind spot as the 8/28 one below,
# one repo over. era-family remains the private data checkout.
sib() { local d="$ROOT/$1${ERA_WT_SUFFIX:-}"; [ -d "$d" ] && echo "$d" || echo "$ROOT/$1"; }
# optional private env (e.g. ERA_GAZE_SRC until era-gaze is imported)
[ -f "$ROOT/era-family/gate-env.sh" ] && . "$ROOT/era-family/gate-env.sh"
export ERA_GAZE_SRC="$(sib era-gaze)"
export ERA_HUB_SRC="$HUB"
gate_validate_port "$PORT" || exit 1
gate_export_test_data || exit 1
export ERA_GATE_SEED_DIR="$DATA"

# one gate at a time, machine-wide: concurrent runs (e.g. two feature worktrees)
# thrash CPU and can fight over default ports — the second run WAITS its turn.
# (Born of the 8/24 two-session collision; see aac-board-builder
# docs/parallel-worktrees.md.)
# A green run leaves a stamp at $ERA_GATE_STAMPS/<HEAD^{tree}> (default
# /tmp/era-gate-green; see write_green_stamp below) so anything that needs "is
# THIS tree gated?" can ask by tree sha instead of trusting one global file two
# worktrees overwrite: release.sh --skip-gate, worktree.sh land, push-device.sh
# all read it, and they honour the same ERA_GATE_STAMPS seam so a test run can
# point the whole rail at a scratch dir.
LOCK="/tmp/era-gate.lock"
gate_acquire_lock || exit 1
echo "== era-gate: lock acquired =="
[ -z "${ERA_GATE_CANCEL_FILE:-}" ] || [ ! -f "$ERA_GATE_CANCEL_FILE" ] || {
  echo "== era-gate: cancelled before execution =="; exit 130;
}
gate_port_available "$PORT" || exit 1
if [ -n "${ERA_GATE_INPUTS:-}" ]; then
  node "$HUB/tools/test-suite.mjs" verify-inputs "$ERA_GATE_INPUTS" || exit 1
fi
trap 'gate_finish "$?"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node "$HUB/tools/test-suite.mjs" check --json || exit 1

# the green stamp (dev-flow spec §3.1): called ONLY on a fully green run, so a
# red gate never writes one and never disturbs another tree's. Keyed by the
# tree sha of HEAD — two worktrees on different code leave two stamps.
# Stamp shape, 4 lines when the tree is clean:
#   1 == era-gate: <n> passed, <n> failed ==   (the summary line, verbatim)
#   2 head=<HEAD sha>
#   3 at=<unix seconds>
#   4 hub=<checkout path>
# plus a 5th line `dirty=1` when the gate ran over uncommitted TRACKED changes.
# Dirtiness is tracked modifications only (`status --untracked-files=no`):
# untracked files — vendor/ artefacts, gate/ leftovers — are not the tested
# content changing, so they never mark a stamp dirty. A dirty stamp still gets
# written (the run really did happen) but readers refuse it: the tested content
# was not the committed tree the key names. The WARNING is printed BEFORE the
# summary line because release.sh reads the gate's `tail -1`; that is also why
# the refusal has to live IN the stamp — a stripped warning cannot stop anyone.
#
# SIBLING WORKTREES (9/17): with ERA_WT_SUFFIX set this run collected — and ran
# — the suites of each sibling worktree sib() resolved, against that worktree's
# code. `worktree.sh land` is per repo and keys on THAT repo's branch tree, so a
# hub-only stamp left every sibling land refused ("no green gate under 2 h for
# this tree") right after the 20-minute run that had just gated it. So each
# sibling worktree the gate sourced gets its own stamp, same shape plus a
# `repo=<path>` line and its own dirty= verdict (one worktree can be dirty while
# the others are clean). Main checkouts reached through sib()'s fallback are NOT
# stamped: this run changed nothing on master's tree, and land never merges
# master into itself. Readers tolerate the extra line — worktree.sh land greps
# head=/at=/dirty=1, release.sh and push-device.sh read only the first line,
# head= and at=, and a foreign repo's head= sha simply doesn't resolve in the hub
# (release.sh's --skip-gate scan drops it), so a sibling stamp can never stand in
# for the hub's.
stamp_tree() {
  # $1 = checkout to stamp, $2 = sibling label (empty for the hub itself)
  local d="$1" label="${2:-}" tree dir at dirty
  tree="$(git -C "$d" rev-parse 'HEAD^{tree}' 2>/dev/null || true)"
  if [ -z "$tree" ]; then
    [ -n "$label" ] || echo "WARNING: not a git checkout — no green stamp written"
    return 0
  fi
  dir="${ERA_GATE_STAMPS:-/tmp/era-gate-green}"
  mkdir -p "$dir" || return 0
  dirty="$(git -C "$d" status --porcelain --untracked-files=no 2>/dev/null || true)"
  at="$(date +%s)"
  if [ -n "$dirty" ]; then
    echo "WARNING: ${label:+$label: }working tree has uncommitted tracked changes — stamp marked dirty=1; release.sh/land/push-device will refuse it until you commit and re-gate:"
    echo "$dirty"
  fi
  {
    printf '%s\n%s\n%s\n%s\n' \
      "== era-gate: $pass passed, $fail failed${failed:+ →$failed} ==" \
      "head=$(git -C "$d" rev-parse HEAD)" \
      "at=$at" \
      "hub=$HUB"
    [ -n "$label" ] && printf 'repo=%s\n' "$d"
    [ -n "$dirty" ] && printf 'dirty=1\n'
  } >"$dir/$tree"
  [ -n "$label" ] && echo "stamp: $label ${tree:0:7}"
  return 0
}

write_green_stamp() {
  local repo d
  stamp_tree "$HUB"
  for repo in era-core era-making-words era-pencil era-board era-gaze; do
    d="$(sib "$repo")"
    [ "$d" = "$ROOT/$repo" ] && continue   # the main checkout — this run gated no tree of its own there
    [ -d "$d/.git" ] || [ -f "$d/.git" ] || continue
    stamp_tree "$d" "$(basename "$d")"
  done
  return 0
}

# Each run owns its mutable data. All generated served links are checked, and
# content absent from the seed cannot leave a link to another data directory.
gate_prepare_owned_data || exit 1
gate_refresh_farm || exit 1
if [ -n "${ERA_GATE_INPUTS:-}" ]; then
  node "$HUB/tools/test-suite.mjs" verify-inputs "$ERA_GATE_INPUTS" || exit 1
else
  OWN_INPUTS="$(mktemp /tmp/era-gate-inputs.XXXXXX.json)" || exit 1
  ERA_GATE_INPUTS="$OWN_INPUTS"
  node "$HUB/tools/test-suite.mjs" capture-inputs "$ERA_GATE_INPUTS" || exit 1
fi

rm -rf "$GATE" && mkdir -p "$GATE" || exit 1
GATE_PREPARED=1
# era-hub's own suites come from THIS checkout ($HUB) so a feature-worktree
# gate runs the worktree's new/changed suites, not the main checkout's copy
# (identical when run from the main checkout, where $HUB = $ROOT/era-hub).
gate_collect_suites || exit 1
gate_prepare_selection || exit 1
# re-point the live-server port in the gate copies only
grep -rlZ "8377" "$GATE" >"$GATE/.port-files"; rewrite_status=$?
[ "$rewrite_status" -le 1 ] || { gate_error "cannot inspect test port references"; exit 1; }
xargs -0 -r sed -i "s/8377/$PORT/g" <"$GATE/.port-files" || { gate_error "test port rewrite failed"; exit 1; }
gate_freeze_execution || exit 1

# Every provider seam points at a closed port, gate-wide: the gate's data dir
# holds a REAL ElevenLabs credential, and a hub reaches out on its own — the
# /content/status poll asks ElevenLabs for the month's voice left (T6b.1), the
# 20 s clothing tick asks ipapi/Open-Meteo (and weather.gov, its second rung
# since 10/10) for the weather, a Resend send is a
# real email, fal spends per press. Since 9/5 (Phase 7 review) that is true for
# every hub a suite spawns with `...process.env`, not just the shared one —
# the "no test spends a key" guarantee used to rest on the data dir happening
# to hold no vision/fal/TMDB key. Answered by the kernel (connection refused);
# the hub logs it and serves `narration: null`. Every suite that needs a seam
# to WORK stands up its own stand-in, which overrides these. ERA_AI_URL stays
# unset gate-wide (unset means "the provider's real base" in
# content-providers.js and suites test that shape); the shared hub plugs it.
export ERA_ELEVEN_URL="http://127.0.0.1:1" ERA_FAL_URL="http://127.0.0.1:1" \
  ERA_GEO_URL="http://127.0.0.1:1/geo" ERA_WEATHER_URL="http://127.0.0.1:1" \
  ERA_GEOCODE_URL="http://127.0.0.1:1/geocode" ERA_NWS_URL="http://127.0.0.1:1" \
  ERA_RESEND_URL="http://127.0.0.1:1" ERA_TMDB_URL="http://127.0.0.1:1" \
  ERA_STREAMING_URL="http://127.0.0.1:1" \
  ERA_SYMBOL_SEARCH_URL="http://127.0.0.1:1/search/" \
  ERA_SYMBOL_IMAGE_URL="http://127.0.0.1:1/images/{id}.png"
# Updater timing seams (spec 2026-10-20 §4.1/§4.4) and the presence beacon's
# seam and hook (§4.5) never leak from the shell that runs the gate: a suite
# that needs one sets it on the hub it spawns. An operator's shell that names
# ERA_PRESENCE_HOOK would otherwise run its real queue hook from test hubs.
unset ERA_UPDATE_EVERY_MS ERA_UPDATE_QUIET_MS ERA_BEACON_MS ERA_BEACON_IDLE_MS ERA_PRESENCE_HOOK
# Test hubs never inherit a real speech runtime or generation adapter.
for chat_setting in "${!ERA_CHAT_@}"; do unset "$chat_setting"; done
export ERA_CHAT_CONFIG_DISABLED=1

# ERA_DEVICE_ID: the gate's DATA is era-family/test-data (a PRIVATE repo's
# working tree). Without a name given here the hub would generate one from
# this build box's hostname and write <DATA>/device-id into that repo — a
# side effect the clothing-migration plan forbids (device-id.js, plan T4.1).
# Refuse a race for the test endpoint. A stale or foreign hub belongs to its
# owner; neither its command name nor its port authorizes this run to kill it.
gate_port_available "$PORT" || exit 1
# Also prove that the endpoint is bindable before launching our owned child.
require_free_test_port() {
  node -e '
    const server = require("node:net").createServer();
    server.once("error", () => {
      console.error("FATAL: test port " + process.argv[1] + " in use or unavailable; choose another test port");
      process.exitCode = 1;
    });
    server.listen(Number(process.argv[1]), "127.0.0.1", () => server.close());
  ' "$PORT"
}
require_free_test_port || exit 1
NODE_BIN="$(type -P node)" || exit 1
SRV_ARGS="$NODE_BIN $HUB/server.js $PORT"
ERA_DATA_DIR="$DATA" ERA_BIND=127.0.0.1 ERA_AI_URL="http://127.0.0.1:1" ERA_DEVICE_ID=gate \
  "$NODE_BIN" "$HUB/server.js" "$PORT" >"$GATE/server.log" 2>&1 &
SRV=$!
SRV_ID="$(gate_process_identity "$SRV")" || SRV_ID=""
gate_wait_process "$SRV" "$SRV_ID" "$SRV_ARGS" || { gate_error "owned test server did not enter its expected command"; exit 1; }
gate_wait_server "$SRV" "$SRV_ID" "$SRV_ARGS" "$PORT" || { cat "$GATE/server.log"; exit 1; }

cd "$GATE"
pass=0; fail=0; failed=""
# The complete executable set was frozen before any suite ran. A previous
# suite cannot delete or rewrite a later file and silently shrink acceptance.
for index in "${!EXPECTED_FILES[@]}"; do
  t="${EXPECTED_FILES[$index]}"
  if ! gate_record_execution "$index"; then
    fail=$((fail+1)); failed="$failed $t"; echo "FAIL $t (collected suite missing or changed)"; continue
  fi
  echo "RUN $t"
  if [[ "$t" = *.test.mjs ]]; then
    label="$t"; output="${t%.mjs}.out"
    timeout 900 node --test "./$t" >"$output" 2>&1; result=$?
  else
    label="${t%.js}"; output="$label.out"
    timeout 420 node "./$t" >"$output" 2>&1; result=$?
  fi
  if [ "$result" = 0 ]; then pass=$((pass+1)); echo "PASS $label";
  else fail=$((fail+1)); failed="$failed $label"; echo "FAIL $label (see gate/$output)"; fi
done
gate_verify_execution || { fail=$((fail+1)); failed="$failed execution-set"; }
node "$HUB/tools/test-suite.mjs" verify-inputs "$ERA_GATE_INPUTS" --phase running || {
  fail=$((fail+1)); failed="$failed inputs-changed";
}
gate_wait_server "$SRV" "$SRV_ID" "$SRV_ARGS" "$PORT" 1 || {
  fail=$((fail+1)); failed="$failed shared-hub-identity";
}
gate_archive_reports || { fail=$((fail+1)); failed="$failed report-archive"; }
REPORTS_SAVED=1
if [ "${ERA_GATE_MODE:-full}" = full ]; then
  [ "$fail" -eq 0 ] && write_green_stamp
  echo "== era-gate: $pass passed, $fail failed${failed:+ →$failed} =="
else
  echo "== affected tests: $pass passed; failures=$fail; no full stamp${failed:+ →$failed} =="
fi
[ "$fail" -eq 0 ]
