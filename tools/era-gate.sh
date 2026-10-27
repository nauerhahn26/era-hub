#!/usr/bin/env bash
# era-gate.sh — the L0/L1 parity gate for the Our Era Comms workspace.
# Collects every sibling repo's test suite into gate/ (copies, port re-pointed
# to the test instance), starts the hub server on $ERA_TEST_PORT (default 8378,
# NEVER the live 8377), runs the suites, reports. Each gate runs in its own
# network namespace and starts when admitted (a free slot and the memory for
# its lanes), so gates in different worktrees run side by side.
# Flow: docs/dev-flow.md
#
# A full gate is cache-aware (design 2026-10-26 3.2; tools/testing/reuse.mjs):
# every frozen suite gets a key, a suite whose key holds a qualifying pass in
# the run store ($ERA_GATE_RUNS, default ~/.local/state/era-gate-runs) prints
# REUSE instead of running, the rest run in lanes, one failed suite may run
# once more at the end (FLAKY), and the 4-line stamp is composed from both.
#   --no-cache            run every suite fresh (the run is still recorded)
#   --rerun-failed RUN    run only what failed or did not finish in RUN (a run
#                         id under the store, its directory, or latest); refused
#                         when a suite that passed there cannot be reused now
#   --restamp RUN         every suite reused from RUN's evidence: no hub, no
#                         suite, a fresh stamp; refused otherwise
#   --only SUITE[,...]    those suites (IDs or file names) only; no stamp, no store
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

gate_parse_options() {
  local chosen=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-cache) GATE_NO_CACHE=1 ;;
      --rerun-failed|--restamp|--only)
        [ "$#" -ge 2 ] && [ -n "$2" ] && [ "${2#--}" = "$2" ] || { gate_error "$1 needs a value"; return 1; }
        case "$1" in --rerun-failed) GATE_RERUN="$2" ;; --restamp) GATE_RESTAMP="$2" ;; *) GATE_ONLY="$2" ;; esac
        shift ;;
      *) gate_error "unknown option: $1"; return 1 ;;
    esac
    shift
  done
  [ -z "$GATE_RERUN" ] || chosen=$((chosen+1))
  [ -z "$GATE_RESTAMP" ] || chosen=$((chosen+1))
  [ -z "$GATE_ONLY" ] || chosen=$((chosen+1))
  [ "$chosen" -le 1 ] || { gate_error "--rerun-failed, --restamp and --only exclude one another"; return 1; }
  [ "$GATE_NO_CACHE" = 0 ] || [ -z "$GATE_RERUN$GATE_RESTAMP" ] || {
    gate_error "--no-cache reads no earlier run; it cannot rerun or restamp one"; return 1;
  }
  [ "$chosen" = 0 ] || [ "${ERA_GATE_MODE:-full}" = full ] || { gate_error "an option names its own selection; ERA_GATE_MODE must stay full"; return 1; }
}

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

# ---- admission and isolation (gate-speed plan phase 2b) ----------------------
# A gate no longer holds LOCK exclusively for its whole run. It re-executes
# itself inside a private network namespace (gate_namespace_argv), where its
# hub and every suite's fixed port are its own, and a slot registry decides
# when it may start: one file per running gate under SLOTS (pid, start ticks,
# lanes, start time, checkout, isolated), pruned and written under SLOTS/.lock,
# which is held for milliseconds. Rules (gate_admission_decision): fewer than
# ERA_GATE_MAX_GATES (default 2) other gates run, none in this checkout (gate/
# and public/ belong to the checkout), and MemAvailable covers the lanes at
# 1 GiB each plus a 1 GiB reserve; room for fewer lanes than asked runs fewer
# (one lane needs 2 GiB), room for none waits. A gate admitted under
# GATE_ADMIT_RAMP (120) seconds ago has its lanes' 1 GiB each taken off
# MemAvailable first: it has not reached its peak yet. Jobs of the isolated
# runner hold slots too (its host worker writes them), so they count. A
# waiting gate polls every GATE_ADMIT_POLL seconds and says why every
# GATE_ADMIT_LOG_EVERY seconds.
# An admitted isolated gate holds LOCK shared for its run, so a gate that runs
# unisolated (the fallback when unshare is refused, or a branch whose
# era-gate.sh predates admission) still takes LOCK exclusively and waits for
# every isolated gate, exactly as one gate waited for another before; while
# such a gate is queued for LOCK, new isolated gates stand back so it is not
# starved (flock grants new shared holds past a queued exclusive request).

gate_start_ticks() {
  local identity
  identity="$(gate_process_identity "$1")" || return 1
  printf '%s\n' "${identity#*:}"
}

gate_mem_available_kib() {
  local key value rest
  while read -r key value rest; do
    if [ "$key" = MemAvailable: ] && [[ "$value" =~ ^[0-9]+$ ]]; then printf '%s\n' "$value"; return 0; fi
  done <"$MEMINFO"
  gate_error "cannot read MemAvailable"
}

gate_gib() {
  printf '%d.%d\n' "$(($1 / 1048576))" "$(($1 * 10 / 1048576 % 10))"
}

# Prints "<other gates running> <1 when one runs in this checkout, else 0>
# <lanes of those admitted under GATE_ADMIT_RAMP seconds ago>". A young gate
# has not reached its peak yet (collection, the clothing build), so the caller
# sets 1 GiB a lane of its memory aside: two gates admitted a minute apart do
# not both count the same free memory. A slot whose pid has ended, is a
# zombie, or now names another process (its start ticks differ) is a gate
# that died without cleaning up: dropped.
gate_live_slots() {
  local file pid key value start hub at lanes current now running=0 same=0 young=0
  now="$(date +%s)"
  for file in "$SLOTS"/*; do
    pid="${file##*/}"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [ -f "$file" ] && [ "$pid" != "$$" ] || continue
    start=""; hub=""; at=""; lanes=""
    while IFS='=' read -r key value; do
      case "$key" in start) start="$value" ;; hub) hub="$value" ;; at) at="$value" ;; lanes) lanes="$value" ;; esac
    done <"$file"
    current="$(gate_start_ticks "$pid")" || current=""
    if [ -z "$current" ] || [ "$current" != "$start" ]; then rm -f -- "$file"; continue; fi
    running=$((running + 1))
    [ "$hub" != "$HUB" ] || same=1
    [[ "$lanes" =~ ^[1-9]$ ]] || lanes=1
    if [[ "$at" =~ ^[0-9]+$ ]] && [ $((now - at)) -lt "$GATE_ADMIT_RAMP" ]; then young=$((young + lanes)); fi
  done
  printf '%s %s %s\n' "$running" "$same" "$young"
}

# $1 other gates running, $2 1 when one runs in this checkout, $3 MemAvailable
# in kB, $4 lanes asked, $5 ERA_GATE_MAX_GATES. Prints "admit <lanes>" or
# "wait <reason>".
gate_admission_decision() {
  local running="$1" same="$2" available="$3" asked="$4" max="$5" fit
  if [ "$same" = 1 ]; then echo "wait another gate is running in this checkout"; return 0; fi
  if [ $((running + 1)) -gt "$max" ]; then echo "wait ERA_GATE_MAX_GATES=$max reached"; return 0; fi
  fit=$((available / 1048576 - 1))
  if [ "$fit" -lt 1 ]; then echo "wait one lane needs 2 GiB free"; return 0; fi
  [ "$fit" -lt "$asked" ] || fit="$asked"
  echo "admit $fit"
}

# True while a process is blocked asking for LOCK exclusively (an unisolated
# gate, a verify-and-land run): /proc/locks lists a blocked request with "->".
gate_exclusive_waiting() {
  local inode
  inode="$(stat -Lc %i -- "$LOCK" 2>/dev/null)" || return 1
  grep -Eq "^[0-9]+: -> FLOCK +ADVISORY +WRITE +[^ ]+ +[0-9a-f]+:[0-9a-f]+:$inode " /proc/locks
}

gate_register_slot() {
  local start temp="$SLOTS/.$$.tmp"
  start="$(gate_start_ticks "$$")" || { gate_error "cannot read this gate's process identity"; return 1; }
  if ! printf 'pid=%s\nstart=%s\nlanes=%s\nat=%s\nhub=%s\nisolated=%s\n' \
      "$$" "$start" "$1" "$(date +%s)" "$HUB" "$2" >"$temp" || ! mv -f -- "$temp" "$SLOTS/$$"; then
    rm -f -- "$temp"; gate_error "cannot write the gate slot registry"; return 1
  fi
  GATE_SLOT="$SLOTS/$$"
}

# Only this gate's own slot, by its own pid: never another gate's.
gate_release_slot() {
  if [ -n "${GATE_SLOT:-}" ] && [ "$GATE_SLOT" = "$SLOTS/$$" ]; then rm -f -- "$GATE_SLOT"; fi
  GATE_SLOT=""
  return 0
}

# The re-executed gate inside its namespace has the pid that registered.
gate_adopt_slot() {
  local start
  if ! start="$(gate_start_ticks "$$")" || [ ! -f "$SLOTS/$$" ] || ! grep -qx "start=$start" "$SLOTS/$$"; then
    gate_error "this namespaced gate has no admission slot of its own"; return 1
  fi
  GATE_SLOT="$SLOTS/$$"
}

# $1 1 when this gate already holds LOCK exclusively (the fallback, or an
# inherited integration lock), else 0: an admitted gate then holds LOCK shared
# on GATE_SHARED_FD, which stays open across the exec into its namespace.
# $2 1 when the gate will run isolated (recorded in its slot). Exports the
# admitted ERA_GATE_LANES.
gate_admit() {
  local held="$1" isolated="$2" asked="$ERA_GATE_LANES" max="${ERA_GATE_MAX_GATES:-2}"
  local registry live running same young available usable kept decision lanes reason logged="" s
  [[ "$max" =~ ^[1-9]$ ]] || { gate_error "ERA_GATE_MAX_GATES must be a whole number from 1 to 9"; return 1; }
  mkdir -p "$SLOTS" || { gate_error "cannot create the gate slot registry"; return 1; }
  while :; do
    if [ -n "${ERA_GATE_CANCEL_FILE:-}" ] && [ -f "$ERA_GATE_CANCEL_FILE" ]; then
      echo "== era-gate: cancelled before execution =="; exit 130
    fi
    running="?"; available=""; kept=""; reason=""
    exec {registry}>"$SLOTS/.lock" || { gate_error "cannot open the gate slot registry"; return 1; }
    if flock -w "$GATE_ADMIT_POLL" "$registry"; then
      read -r running same young <<<"$(gate_live_slots)"
      available="$(gate_mem_available_kib)" || { exec {registry}>&-; return 1; }
      usable=$((available - young * 1048576)); [ "$usable" -ge 0 ] || usable=0
      [ "$young" = 0 ] || kept=", $young GiB kept for gates still starting"
      decision="$(gate_admission_decision "$running" "$same" "$usable" "$asked" "$max")"
      lanes="${decision#admit }"
      if [ "$decision" != "admit $lanes" ]; then
        reason="${decision#wait }"
      elif [ "$held" != 1 ]; then
        if gate_exclusive_waiting; then
          reason="an unisolated gate is queued for the gate lock"
        else
          exec {GATE_SHARED_FD}>"$LOCK" || { exec {registry}>&-; gate_error "cannot open the gate lock"; return 1; }
          if ! flock -s -n "$GATE_SHARED_FD"; then
            exec {GATE_SHARED_FD}>&-; GATE_SHARED_FD=""
            reason="an unisolated gate holds the gate lock"
          fi
        fi
      fi
      if [ -z "$reason" ]; then
        gate_register_slot "$lanes" "$isolated" || { exec {registry}>&-; return 1; }
        exec {registry}>&-
        export ERA_GATE_LANES="$lanes"
        s=s; [ "$lanes" != 1 ] || s=""
        echo "== era-gate: admitted: $lanes lane$s; $running other gate$([ "$running" = 1 ] || echo s) running, $(gate_gib "$available") GiB free$kept =="
        [ "$lanes" = "$asked" ] || echo "== era-gate: memory admits $lanes of $asked lanes: this gate runs $lanes lane$s =="
        return 0
      fi
    else
      reason="the slot registry is busy"
    fi
    exec {registry}>&-
    if [ -z "$logged" ] || [ $((SECONDS - logged)) -ge "$GATE_ADMIT_LOG_EVERY" ]; then
      echo "== era-gate: waiting for a slot: $running gate$([ "$running" = 1 ] || echo s) running, $([ -n "$available" ] && gate_gib "$available" || echo '?') GiB free$kept ($reason) =="
      logged="$SECONDS"
    fi
    sleep "$GATE_ADMIT_POLL"
  done
}

# "entered": this gate re-executed itself into its namespace (the marker names
# the network it is in). "runner": the isolated runner started it inside its
# own namespaces, private /tmp and admission (tools/testing/parallel-worker.py
# sets ERA_PARALLEL_JOB_DIR; a user namespace confirms it). "host" otherwise.
gate_isolation_state() {
  local net first second count
  net="$(readlink /proc/self/ns/net 2>/dev/null)" || net=""
  if [ -n "${ERA_GATE_ISOLATED:-}" ] && [ "$ERA_GATE_ISOLATED" = "$net" ]; then echo entered; return 0; fi
  if [ -n "${ERA_PARALLEL_JOB_DIR:-}" ] && read -r first second count <"$UID_MAP" &&
     ! { [ "$first" = 0 ] && [ "$second" = 0 ] && [ "$count" = 4294967295 ]; }; then
    echo runner; return 0
  fi
  echo host
}

# The namespace, built as the isolated runner builds its own
# (tools/testing/parallel-worker.py): a user namespace that maps only this
# uid, a network namespace with loopback up plus a dummy test link on a
# documentation address (TEST-NET-1, so the LAN-socket cases have a
# non-loopback IPv4 and still no route out), then every capability dropped
# under no_new_privs, so permission cases are not bypassed. No PID or mount
# namespace: the gate stops only pids it started, stamps and job dirs stay on
# the host's paths, and unshare and setpriv exec in place, so the gate keeps
# its pid (a detached launch's pid file stays true). Sets GATE_NS_ARGV, to be
# followed by the slot to drop if setup fails ('' for none) and the command.
gate_namespace_argv() {
  local tool ip_bin address
  GATE_NS_ARGV=()
  for tool in unshare setpriv readlink; do
    type -P "$tool" >/dev/null || { GATE_ISOLATION_REFUSED="$tool is not installed"; return 1; }
  done
  ip_bin="$(PATH="$PATH:/usr/sbin:/sbin" type -P ip)" || { GATE_ISOLATION_REFUSED="ip is not installed"; return 1; }
  printf -v address '%d.%d.%d.%d' 192 0 2 1
  GATE_NS_ARGV=(unshare --user --map-current-user --keep-caps --net -- bash -c '
ip_bin="$1" address="$2" slot="$3"; shift 3
if "$ip_bin" link set lo up && "$ip_bin" link add test-link type dummy &&
   "$ip_bin" addr add "$address/24" dev test-link && "$ip_bin" link set test-link up &&
   ERA_GATE_ISOLATED="$(readlink /proc/self/ns/net)"; then
  export ERA_GATE_ISOLATED
  exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs -- "$@"
fi
[ -z "$slot" ] || rm -f -- "$slot"
echo "FATAL: cannot prepare the gate network namespace" >&2
exit 1' era-gate-namespace "$ip_bin" "$address")
}

# Rehearses the exact entry with `true` in place of the gate. On refusal
# GATE_ISOLATION_REFUSED says why (the first line the refusal printed).
gate_isolation_probe() {
  local output
  GATE_ISOLATION_REFUSED=""
  gate_namespace_argv || return 1
  if output="$("${GATE_NS_ARGV[@]}" "" true 2>&1)"; then return 0; fi
  GATE_ISOLATION_REFUSED="${output%%$'\n'*}"
  [ -n "$GATE_ISOLATION_REFUSED" ] || GATE_ISOLATION_REFUSED="the namespace probe failed"
  return 1
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

# The shared hub starts with ERA_CLOTHING_TICK_MS=0: no clothing build 20 s
# after boot and no 15-minute check, because a build at a moment no suite chose
# can rewrite recipes/today.json (and its ETag) under the board suites reading
# it (gate-speed plan 1.3a). Its board is built here instead: once, after
# readiness, before the first suite, and the gate waits for that build to
# finish. One POST and one round of polling are enough: unless a Drive folder
# is connected through the API, drive.sync() returns without waiting, so the
# hub spawns the worker in the same turn that answers the POST and the first
# status already says building; and a queued run respawns on the old worker's
# exit, so "not building" is never the gap between two builds.
gate_build_clothing() {
  local port="$1" tries="${2:-3000}" attempt status
  curl --max-time 5 -sf -X POST "http://127.0.0.1:$port/clothing/regenerate" >/dev/null || {
    gate_error "the shared hub refused the clothing build"; return 1;
  }
  for ((attempt=0; attempt<tries; attempt++)); do
    status="$(curl --max-time 2 -sf "http://127.0.0.1:$port/clothing/status")" || {
      gate_error "the shared hub stopped answering during the clothing build"; return 1;
    }
    case "$status" in *'"building":false'*) return 0 ;; esac
    sleep 0.1
  done
  gate_error "the shared hub's clothing build did not finish"
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

# $2: the digest the lane runner hashed as it started the suite. Without it
# the collected copy is hashed here, now.
gate_record_execution() {
  local index="$1" started="${2:-}" id name digest
  [[ "$index" =~ ^[0-9]+$ ]] && [ -n "${EXPECTED_FILES[$index]:-}" ] || {
    gate_error "unexpected suite execution"; return 1;
  }
  id="${EXPECTED_IDS[$index]}"; name="${EXPECTED_FILES[$index]}"
  [ "${EXECUTED_COUNT["$id"]:-0}" = 0 ] || { gate_error "duplicate suite execution: $id"; return 1; }
  if [ -n "$started" ]; then
    digest="$started"
  else
    [ -f "$GATE/$name" ] || { gate_error "missing collected suite: $id"; return 1; }
    digest="$(sha256sum -- "$GATE/$name")" || return 1
  fi
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

# The lane runner's tally (tools/testing/lanes.mjs writes .lane-results.tsv: one
# row per suite it reached, in the frozen order: state, plan index, the digest
# it hashed at start or "missing", source ID), counted exactly as the serial
# loop counted: a pass once; a failure once, by its label; a copy refused as
# missing or changed once, by its file name, and never recorded as executed.
# A reused pass (its key holds the frozen digest) and a FLAKY pass count as
# passes; a suite refused for two failures on its key counts as a failure.
# $1 is the runner's exit status: anything but 0 or 1 means it did not finish.
gate_record_results() {
  local status="$1" state index digest id t label
  if [ -f "$GATE/.lane-results.tsv" ]; then
    while IFS=$'\t' read -r state index digest id; do
      t=""; [[ "$index" =~ ^[0-9]+$ ]] && t="${EXPECTED_FILES[$index]:-}"
      [ -n "$t" ] && [ "$id" = "${EXPECTED_IDS[$index]}" ] || {
        gate_error "unexpected lane result: $id"; fail=$((fail+1)); failed="$failed lanes"; continue;
      }
      if [[ "$t" = *.test.mjs ]]; then label="$t"; else label="${t%.js}"; fi
      case "$state" in
        pass|fail|reused|flaky|blocked)
          gate_record_execution "$index" "$digest" || { fail=$((fail+1)); failed="$failed $t"; continue; }
          case "$state" in
            pass|reused|flaky) pass=$((pass+1)) ;;
            *) fail=$((fail+1)); failed="$failed $label" ;;
          esac ;;
        changed)
          if [ "$digest" = missing ]; then gate_error "missing collected suite: $id"
          else gate_error "collected suite changed before execution: $id"; fi
          fail=$((fail+1)); failed="$failed $t" ;;
        *) gate_error "unknown lane result for $id: $state"; fail=$((fail+1)); failed="$failed lanes" ;;
      esac
    done <"$GATE/.lane-results.tsv"
  fi
  [ "$status" = 0 ] || [ "$status" = 1 ] || { fail=$((fail+1)); failed="$failed lanes"; }
}

# The run's record in the store (tools/testing/reuse.mjs record): outputs, the
# guard's second look at the shared hub's data, the flake ledger, receipt.json
# and the receipt line, all before the summary line. Only a full gate whose
# plan found a writable store; a record that cannot be written costs later
# gates their reuse, never this gate its verdict.
gate_record_run() {
  [ "${ERA_GATE_MODE:-full}" = full ] || return 0
  [ -f "$GATE/.reuse.json" ] || return 0
  node "$HUB/tools/testing/reuse.mjs" record "$GATE" --data "$DATA" \
    --checks "inputs=$CHECK_INPUTS,hub=$CHECK_HUB,execution=$CHECK_EXECUTION" --pass "$pass" --fail "$fail" \
    --summary "== era-gate: $pass passed, $fail failed${failed:+ →$failed} ==" ||
    echo "reuse: WARNING: this run's record could not be written; later gates will not reuse it"
}

# An early exit (TERM or INT while suites run) stops the lane runner: only the
# pid this gate started, while it is still this shell's child, never by name or
# group. The runner stops its suites by their pids and exits; it gets ten
# seconds before KILL.
gate_stop_lanes() {
  local pid="${LANES_PID:-}" identity="${LANES_ID:-}" attempt
  [ -n "$pid" ] && [ -n "$identity" ] || return 0
  case "$identity" in "$$":*) ;; *) return 0 ;; esac
  [ "$(gate_process_identity "$pid")" = "$identity" ] || return 0
  kill -TERM "$pid" 2>/dev/null || return 0
  for attempt in {1..100}; do
    [ "$(gate_process_identity "$pid")" = "$identity" ] || break
    sleep 0.1
  done
  if [ "$(gate_process_identity "$pid")" = "$identity" ]; then kill -KILL "$pid" 2>/dev/null || true; fi
  wait "$pid" 2>/dev/null || true
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
  gate_stop_lanes
  gate_cleanup_server "${SRV:-}" "${SRV_ID:-}" "${SRV_ARGS:-}"
  if [ "${REPORTS_SAVED:-0}" != 1 ]; then gate_archive_reports || status=1; fi
  [ -z "${OWN_INPUTS:-}" ] || rm -f -- "$OWN_INPUTS"
  if [ -n "${OWN_DATA:-}" ]; then
    gate_refresh_data_links "$ERA_GATE_SEED_DIR" || status=1
    rm -rf -- "$OWN_DATA" || status=1
  fi
  gate_release_slot
  trap - EXIT
  exit "$status"
}

HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
DATA="${ERA_GATE_SEED_DIR:-${ERA_DATA_DIR:-$ROOT/era-family/test-data}}"  # immutable seed, never live data
PORT="${ERA_TEST_PORT:-8378}"
GATE="$HUB/gate"
OWN_DATA=""; OWN_INPUTS=""; SRV=""; SRV_ID=""; SRV_ARGS=""; GATE_PREPARED=0; LANES_PID=""; LANES_ID=""
GATE_NO_CACHE=0; GATE_RERUN=""; GATE_RESTAMP=""; GATE_ONLY=""
# Parsed (and refused) before admission, so a wrong option never waits for a
# slot. A gate that enters its namespace hands the same options on and parses
# them again there; what --only implies is exported after admission.
gate_parse_options "$@" || exit 1
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
# How many suites run at once (tools/testing/lanes.mjs). 1 is the serial loop
# exactly: the frozen order, one suite at a time. Validated here, before
# admission (which lowers it to what free memory admits), and exported so the
# runner reads the value this gate checked.
export ERA_GATE_LANES="${ERA_GATE_LANES:-2}"
[[ "$ERA_GATE_LANES" =~ ^[1-8]$ ]] || { gate_error "ERA_GATE_LANES must be a whole number from 1 to 8"; exit 1; }
gate_validate_port "$PORT" || exit 1
gate_export_test_data || exit 1
export ERA_GATE_SEED_DIR="$DATA"

# Admission, not exclusion (10/27; functions and rules under "admission and
# isolation" above). Until then one gate ran at a time, machine-wide, because
# concurrent runs fought over the fixed suite ports and the 8378 hub (the 8/24
# two-session collision; aac-board-builder docs/parallel-worktrees.md). Now each
# gate runs in its own network namespace, where those ports are its own, and
# starts when a slot is free: ERA_GATE_MAX_GATES gates (default 2) and the
# memory for their lanes; otherwise it WAITS its turn and says why once a
# minute. Where unshare is refused the gate says so and falls back to the old
# exclusive lock: it waits for every other gate and runs alone. Inside the
# isolated runner it does neither (the runner isolated and admitted it). There
# is no mount namespace: stamps, gate/ and job dirs are the host's own paths.
# A green run leaves a stamp at $ERA_GATE_STAMPS/<HEAD^{tree}> (default
# /tmp/era-gate-green; see write_green_stamp below) so anything that needs "is
# THIS tree gated?" can ask by tree sha instead of trusting one global file two
# worktrees overwrite: release.sh --skip-gate, worktree.sh land, push-device.sh
# all read it, and they honour the same ERA_GATE_STAMPS seam so a test run can
# point the whole rail at a scratch dir.
LOCK="/tmp/era-gate.lock"
SLOTS="/tmp/era-gate-slots"
MEMINFO="/proc/meminfo"
UID_MAP="/proc/self/uid_map"
GATE_ADMIT_POLL=10
GATE_ADMIT_LOG_EVERY=60
GATE_ADMIT_RAMP=120
GATE_SLOT=""
case "$(gate_isolation_state)" in
  entered)
    # The re-executed gate: the same pid, so its slot and shared hold came along.
    gate_adopt_slot || exit 1 ;;
  runner)
    # The runner's /tmp is private: this lock is the job's own, as before.
    gate_acquire_lock || exit 1 ;;
  *)
    gate_held=0
    if [ -n "${ERA_GATE_LOCK_FD:-}" ]; then gate_acquire_lock || exit 1; gate_held=1; fi
    if gate_isolation_probe; then gate_isolated=1; else
      gate_isolated=0
      echo "== era-gate: network isolation unavailable ($GATE_ISOLATION_REFUSED); falling back to the exclusive lock =="
      if [ "$gate_held" = 0 ]; then gate_acquire_lock || exit 1; gate_held=1; fi
    fi
    trap 'gate_release_slot' EXIT
    gate_admit "$gate_held" "$gate_isolated" || exit 1
    if [ "$gate_isolated" = 1 ]; then
      echo "== era-gate: entering a private network namespace: the $PORT hub and every suite port are this gate's own =="
      exec "${GATE_NS_ARGV[@]}" "$GATE_SLOT" bash "$HUB/tools/era-gate.sh" "$@"
    fi ;;
esac
trap 'gate_release_slot' EXIT
# --only is the affected mode with a selection written once gate/ exists.
# Exported only here, past the exec above: the re-executed gate parses --only
# again, and an inherited ERA_GATE_MODE=affected would refuse it.
if [ -n "$GATE_ONLY" ]; then
  export ERA_GATE_MODE=affected ERA_GATE_SELECTED="$GATE/.only-selection.json"
fi
# The line tools/testing/suite-runner.mjs reads as "this gate is now running".
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
if [ -n "$GATE_ONLY" ]; then
  node "$HUB/tools/testing/reuse.mjs" select "$GATE_ONLY" "$ERA_GATE_SELECTED" || exit 1
fi
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
# ERA_CLOTHING_TICK_MS likewise: the shared hub below gets it on its own
# command line, and a suite's own hub keeps the clothing schedule a family has.
# ERA_RECONCILE_DELAY_MS and ERA_CLOTHING_BOOT_MS (the boot reconcile's 5 s and
# the clothing startup build's 20 s) too: a suite that shortens one sets it on
# the hub it spawns (reconcile, clothing-schedule), every other hub keeps the
# family's timing.
unset ERA_UPDATE_EVERY_MS ERA_UPDATE_QUIET_MS ERA_BEACON_MS ERA_BEACON_IDLE_MS ERA_PRESENCE_HOOK ERA_CLOTHING_TICK_MS ERA_RECONCILE_DELAY_MS ERA_CLOTHING_BOOT_MS
# Test hubs never inherit a real speech runtime or generation adapter.
for chat_setting in "${!ERA_CHAT_@}"; do unset "$chat_setting"; done
export ERA_CHAT_CONFIG_DISABLED=1

# Reuse (design 3.2; tools/testing/reuse.mjs plan): with the suites' environment
# now final, a full gate keys every frozen suite, prints the key's parts, and
# decides per suite: reuse a qualifying pass from the run store, run it, or
# refuse it (two failures on its key). It writes gate/.reuse.json for the lane
# runner. Without a writable store it says so and plans nothing. --only and
# affected runs neither read nor write the store.
GATE_HUB=1
if [ "${ERA_GATE_MODE:-full}" = full ]; then
  # the gate's pid goes into the run's keys.json: tools/gate-wait.sh <pid>
  GATE_REUSE_ARGS=(--gate-pid "$$")
  [ "$GATE_NO_CACHE" = 0 ] || GATE_REUSE_ARGS+=(--no-cache)
  [ -z "$GATE_RERUN" ] || GATE_REUSE_ARGS+=(--rerun-failed "$GATE_RERUN")
  [ -z "$GATE_RESTAMP" ] || GATE_REUSE_ARGS+=(--restamp "$GATE_RESTAMP")
  node "$HUB/tools/testing/reuse.mjs" plan "$GATE" "$ERA_GATE_INPUTS" "${GATE_REUSE_ARGS[@]}" || exit 1
  # nothing left to run (every suite reused, as a restamp is): no shared hub
  [ "$(cat "$GATE/.reuse-to-run" 2>/dev/null)" != 0 ] || GATE_HUB=0
fi

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
# ERA_DEVICE_ID: the gate's DATA is era-family/test-data (a PRIVATE repo's
# working tree). Without a name given here the hub would generate one from
# this build box's hostname and write <DATA>/device-id into that repo — a
# side effect the clothing-migration plan forbids (device-id.js, plan T4.1).
# Refuse a race for the test endpoint. A stale or foreign hub belongs to its
# owner; neither its command name nor its port authorizes this run to kill it.
if [ "$GATE_HUB" = 1 ]; then
  gate_port_available "$PORT" || exit 1
  require_free_test_port || exit 1
  NODE_BIN="$(type -P node)" || exit 1
  SRV_ARGS="$NODE_BIN $HUB/server.js $PORT"
  # ERA_CLOTHING_TICK_MS=0: the shared hub's clothing board is built once, by
  # gate_build_clothing below, never by its own timers mid-run.
  ERA_DATA_DIR="$DATA" ERA_BIND=127.0.0.1 ERA_AI_URL="http://127.0.0.1:1" ERA_DEVICE_ID=gate ERA_CLOTHING_TICK_MS=0 \
    "$NODE_BIN" "$HUB/server.js" "$PORT" >"$GATE/server.log" 2>&1 &
  SRV=$!
  SRV_ID="$(gate_process_identity "$SRV")" || SRV_ID=""
  gate_wait_process "$SRV" "$SRV_ID" "$SRV_ARGS" || { gate_error "owned test server did not enter its expected command"; exit 1; }
  gate_wait_server "$SRV" "$SRV_ID" "$SRV_ARGS" "$PORT" || { cat "$GATE/server.log"; exit 1; }
  gate_build_clothing "$PORT" || { cat "$GATE/server.log"; exit 1; }
  # The shared-state guard's first look: the owned data after the one awaited
  # build, before the first suite. The record takes the second after the last.
  [ ! -f "$GATE/.reuse.json" ] || node "$HUB/tools/testing/reuse.mjs" guard "$DATA" "$GATE/.guard-start.json" || exit 1
else
  echo "reuse: nothing to run; the shared hub is not started"
fi

cd "$GATE"
pass=0; fail=0; failed=""
# glibc malloc, for every suite the runner starts (and what they start): a
# block from 128 KiB up is its own mapping, unmapped when freed, and free
# space above 128 KiB at the top of a heap is trimmed. With the defaults a
# suite process kept the native memory its earlier work had freed: measured
# 10/27 on clothing.test.mjs, 350-440 MB of malloc arenas held at its peak;
# with these, peak 1115 MB to 870 MB alone, and 770 MB to 613 MB (high-water
# mark 781 to 647) once its segmentation check ran in a thread of its own;
# the same 35 cases pass. The Linux test environment only: the product and
# the Windows legs never read it. The isolated runner's environment list
# carries the same two (tools/testing/parallel-worker.mjs executionEnvironment).
export MALLOC_MMAP_THRESHOLD_=131072 MALLOC_TRIM_THRESHOLD_=131072
# The complete executable set was frozen before any suite ran. A previous
# suite cannot delete or rewrite a later file and silently shrink acceptance:
# the lane runner re-hashes each copy against its frozen digest as it starts
# it and refuses a missing or changed one. It runs ERA_GATE_LANES suites at
# once, each with the serial loop's command (timeout 900 node --test ./X.test.mjs,
# timeout 420 node ./X.js), cwd, environment, stdin and X.out, prints RUN/PASS/
# FAIL, and writes results.jsonl and .lane-results.tsv (header of
# tools/testing/lanes.mjs). It runs in the background so a TERM or INT reaches
# this shell at once; gate_finish then stops it by its pid.
node "$HUB/tools/testing/lanes.mjs" "$GATE" <&0 &
LANES_PID=$!
LANES_ID="$(gate_process_identity "$LANES_PID")" || LANES_ID=""
wait "$LANES_PID"; lanes_status=$?
LANES_PID=""; LANES_ID=""
gate_record_results "$lanes_status"
CHECK_INPUTS=ok; CHECK_HUB=none; CHECK_EXECUTION=ok
gate_verify_execution || { fail=$((fail+1)); failed="$failed execution-set"; CHECK_EXECUTION=incomplete; }
node "$HUB/tools/test-suite.mjs" verify-inputs "$ERA_GATE_INPUTS" --phase running || {
  fail=$((fail+1)); failed="$failed inputs-changed"; CHECK_INPUTS=changed;
}
if [ "$GATE_HUB" = 1 ]; then
  gate_wait_server "$SRV" "$SRV_ID" "$SRV_ARGS" "$PORT" 1 || {
    fail=$((fail+1)); failed="$failed shared-hub-identity"; CHECK_HUB=lost;
  }
  [ "$CHECK_HUB" = lost ] || CHECK_HUB=ok
fi
gate_archive_reports || { fail=$((fail+1)); failed="$failed report-archive"; }
REPORTS_SAVED=1
if [ "${ERA_GATE_MODE:-full}" = full ]; then
  gate_record_run
  [ "$fail" -eq 0 ] && write_green_stamp
  echo "== era-gate: $pass passed, $fail failed${failed:+ →$failed} =="
else
  echo "== affected tests: $pass passed; failures=$fail; no full stamp${failed:+ →$failed} =="
fi
[ "$fail" -eq 0 ]
