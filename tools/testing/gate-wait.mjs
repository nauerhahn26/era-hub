#!/usr/bin/env node
// gate-wait.mjs: the body of tools/gate-wait.sh (gate-speed plan phase 4;
// design 3.3). Waits, without polling, for one era-gate run to end, then prints
// what the gate printed that matters: its summary line, its receipt line, its
// FAIL and FLAKY lines, and the stamp path when green.
//
//   bash tools/gate-wait.sh <gate pid> | --latest | --run <run-dir or run id>  [--timeout S]
//
// Exit 0 green, 1 red (a gate that ended without a receipt is red), 2 when no
// such gate or run can be found, 124 when the gate is still running after S
// seconds (default 570, under a tool call's 10 minutes; 0 looks once). On a
// timeout it prints one progress line; call it again.
//
// Finding the gate. A pid: its slot /tmp/era-gate-slots/<pid> (written at
// admission, removed as the gate exits), or, before admission, a live process
// running some checkout's tools/era-gate.sh. A gate that has already ended is
// found by the pid its run recorded in keys.json. --latest: a live gate of
// this checkout (slot, then process), else this checkout's newest run in the
// store. --run: that run; while the pid in its keys.json lives, wait for it.
// The store is the gate's own $ERA_GATE_RUNS (read from the live gate's
// environment, else this shell's, else ~/.local/state/era-gate-runs), the
// stamps $ERA_GATE_STAMPS likewise (default /tmp/era-gate-green).
//
// Ended: the pid is gone or names another process, or its slot was seen and
// is gone. Then the run's receipt.json (summary, receipt line), results.jsonl
// (each suite's last verdict line) and the stamp give the report; the gate's
// stdout log (its fd 1, when that is a file) fills in for a run without a
// store record, such as --only.
//
// Why no polling: agents spent a quarter to a third of their tokens this week
// re-reading gate logs in sleep loops. This process blocks inside one tool
// call instead. It sleeps on inotify (node's fs.watch: the slot directory, the
// run store, the run directory once it exists; inotify-tools is not installed
// on this host, node always is), armed BEFORE each check so no change between
// check and wait is lost, and looks again at least every 15 s because a gate
// killed outright (SIGKILL, out of memory) leaves its slot and no file event.
// Where watching fails it falls back to a plain 15 s sleep, never faster:
// a 15-minute gate needs no finer grain, and a faster loop would only burn the
// host's CPU beside the suites.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_ID, labelOf, outputOf } from './reuse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT = path.resolve(HERE, '../..');
export const RECHECK_MS = 15_000;
export const DEFAULT_TIMEOUT_S = 570;
const USAGE = 'usage: gate-wait.sh <gate pid> | --latest | --run <run-dir> [--timeout S]';

const tryJSON = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const readLines = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const jsonLines = (file) => readLines(file).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const mtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return null; } };

// ---- processes ---------------------------------------------------------------------

// The kernel's start time of a pid (clock ticks after boot); null once it is
// gone or a zombie.
export function startTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? null : fields[19];
  } catch { return null; }
}
// Start time in epoch ms (/proc reports ticks at USER_HZ, 100 on Linux).
function startEpoch(ticks) {
  const btime = /^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
  return btime ? Number(btime[1]) * 1000 + Number(ticks) * 10 : 0;
}
// The checkout whose tools/era-gate.sh this pid runs, or null.
export function gateCheckout(pid) {
  let argv, cwd;
  try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return null; }
  try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { cwd = '/'; }
  for (const arg of argv) {
    if (path.basename(arg) !== 'era-gate.sh') continue;
    const tools = path.dirname(path.resolve(cwd, arg));
    if (path.basename(tools) === 'tools') return path.dirname(tools);
  }
  return null;
}
function environOf(pid) {
  try {
    return Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  } catch { return null; }
}
function logOf(pid) {
  try {
    const target = fs.readlinkSync(`/proc/${pid}/fd/1`);
    return path.isAbsolute(target) && fs.statSync(target).isFile() ? target : null;
  } catch { return null; }
}
export function readSlot(file) {
  const slot = {};
  for (const line of readLines(file)) { const at = line.indexOf('='); if (at > 0) slot[line.slice(0, at)] = line.slice(at + 1); }
  return slot.pid ? slot : null;
}

// ---- the store ----------------------------------------------------------------------

export function storeOf(env) {
  if (env.ERA_GATE_RUNS) return path.resolve(env.ERA_GATE_RUNS);
  return env.HOME ? path.join(env.HOME, '.local', 'state', 'era-gate-runs') : null;
}
const runIds = (store) => {
  try { return fs.readdirSync(store).filter((n) => RUN_ID.test(n)).sort().reverse(); } catch { return []; }
};
// Run ids start with their UTC time: a run of a gate that started at `since`
// is named at or after it (a few seconds' grace for the clock's rounding).
const idTime = (id) => Date.parse(id.slice(0, 20).replace(/T(\d{2})-(\d{2})-(\d{2})Z/, 'T$1:$2:$3Z'));
export function findRun(store, { pid = null, checkout = null, since = 0 } = {}) {
  for (const id of runIds(store)) {
    if (since && !(idTime(id) >= since - 5000)) break;
    const keys = tryJSON(path.join(store, id, 'keys.json'));
    if (!keys) continue;
    if (pid != null && keys.pid !== pid) continue;
    if (checkout != null && keys.checkout !== checkout) continue;
    return path.join(store, id);
  }
  return null;
}

// ---- the report -----------------------------------------------------------------------

const SUMMARY = /^== (era-gate: \d+ passed, \d+ failed|affected tests: \d+ passed; failures=\d+).*==$/;
const greenSummary = (line) => /^== era-gate: \d+ passed, 0 failed ==$/.test(line) || /^== affected tests: \d+ passed; failures=0;/.test(line);

// Each suite's last verdict line, in the order they ended.
export function verdictLines(results) {
  const last = new Map();
  for (const row of results) { last.delete(row.suite); last.set(row.suite, row); }
  const lines = [];
  for (const row of last.values()) {
    let line = row.line;
    if (!line) {
      const label = labelOf(row.file || path.basename(String(row.suite)));
      if (row.status === 'pass') line = row.flaky ? `FLAKY ${label}` : null;
      else if (row.status === 'changed') line = `FAIL ${row.file} (collected suite missing or changed)`;
      else if (row.status === 'blocked') line = `FAIL ${label} (failed twice on these inputs)`;
      else line = `FAIL ${label} (see gate/${outputOf(row.file || label)})`;
    }
    if (line && /^(FAIL|FLAKY) /.test(line)) lines.push(line);
  }
  return lines;
}

function stampLine(stamps, receipt, summary) {
  const file = path.join(stamps, String(receipt.tree));
  const text = readLines(file);
  if (!receipt.tree || !text.length) return `stamp: none at ${file} (the gate wrote no stamp for this tree)`;
  if (!text.includes(`head=${receipt.head}`)) return `stamp: none at ${file} (it names another commit; the tree was gated again since)`;
  if (text.includes('dirty=1')) return `stamp: ${file} (dirty=1: land, release and push-device refuse it; commit and gate again)`;
  if (summary && text[0] !== summary) return `stamp: ${file} (written by a later gate of the same tree)`;
  return `stamp: ${file}`;
}

// -> { lines, code }
export function report({ runDir = null, log = null, stamps, pid = null, since = 0, checkout = null }) {
  const logLines = log ? readLines(log) : [];
  const fromLog = logLines.filter((l) => SUMMARY.test(l)).at(-1) ?? null;
  const receipt = runDir ? tryJSON(path.join(runDir, 'receipt.json')) : null;
  if (receipt) {
    const summary = receipt.summary ?? fromLog ?? `== era-gate: ${receipt.pass} passed, ${receipt.fail} failed ==`;
    const c = receipt.counts || {};
    const line = receipt.line ?? `receipt: ${c.reused} reused, ${c.fresh} run fresh${c.flaky ? ` (${c.flaky} FLAKY)` : ''}; ${path.join(runDir, 'receipt.json')}`;
    const lines = [summary, line, ...verdictLines(jsonLines(path.join(runDir, 'results.jsonl')))];
    if (receipt.green) lines.push(stampLine(stamps, receipt, receipt.summary ?? null));
    return { lines, code: receipt.green ? 0 : 1 };
  }
  if (fromLog) {
    // a run with no store record (--only, no writable store): the log is the record
    const verdicts = [];
    for (const l of logLines) if (/^(FAIL|FLAKY) /.test(l)) verdicts.push(l);
    return { lines: [fromLog, ...verdicts], code: greenSummary(fromLog) ? 0 : 1 };
  }
  const who = pid ? `gate ${pid}` : `run ${path.basename(runDir || '?')}`;
  const lines = [`gate-wait: ${who} ended without a receipt (killed, out of memory, or stopped before its record)`];
  const gateDir = checkout ? path.join(checkout, 'gate') : null;
  const fresh = (file) => { const t = mtime(file); return t != null && t >= since - 5000; };
  const candidates = [runDir && path.join(runDir, 'results.jsonl'), gateDir && path.join(gateDir, 'results.jsonl'),
    gateDir && path.join(gateDir, '.lane-results.tsv')].filter(Boolean);
  const source = candidates.find((f) => readLines(f).length && (f.startsWith(runDir || '\0') || fresh(f)));
  if (source) {
    const plan = readLines(path.join(runDir || gateDir, runDir ? 'plan.tsv' : '.execution-plan.tsv')).length;
    const rows = readLines(source);
    lines.push(`last results (${source}${plan ? `; ${rows.length} of ${plan} planned suites` : ''}):`);
    for (const raw of rows.slice(-5)) {
      let row = null; try { row = JSON.parse(raw); } catch { /* a tally row */ }
      lines.push(`  ${row ? row.line ?? `${row.status} ${row.file}` : raw}`);
    }
  } else lines.push('no suite had finished');
  if (logLines.length) lines.push(`last lines of ${log}:`, ...logLines.slice(-5).map((l) => `  ${l}`));
  return { lines, code: 1 };
}

function progress({ pid, checkout, runDir, waited }) {
  const head = `gate-wait: still running after ${waited} s: gate ${pid} in ${checkout ?? 'an unknown checkout'}`;
  if (!runDir) return `${head}; no run record yet (admission, collection or setup)`;
  const results = jsonLines(path.join(runDir, 'results.jsonl'));
  const done = new Map(results.map((r) => [r.suite, r]));
  const failed = [...done.values()].filter((r) => r.status !== 'pass').length;
  const planned = readLines(path.join(runDir, 'plan.tsv')).length;
  const reuse = checkout ? tryJSON(path.join(checkout, 'gate', '.reuse.json')) : null;
  const reused = reuse && reuse.run === path.basename(runDir)
    ? Object.values(reuse.suites || {}).filter((s) => s.decision === 'reuse').length : 0;
  return `${head}; ${done.size + reused} of ${planned} suites done${reused ? ` (${reused} reused)` : ''}, ${failed} failed so far; run ${runDir}`;
}

// ---- waiting --------------------------------------------------------------------------

// Resolves on the first change under any of `paths`, or after `ms`. The
// watchers are armed before `check` runs, so nothing between them is missed.
async function waitForChange(paths, ms, noWatch) {
  const watchers = [];
  let wake;
  const woken = new Promise((resolve) => { wake = resolve; });
  if (!noWatch) {
    for (const p of paths) {
      try { const w = fs.watch(p, { persistent: false }, () => wake()); w.on('error', () => wake()); watchers.push(w); } catch { /* gone or unwatchable */ }
    }
  }
  // the caller passes 15 s (less only at its own deadline): with no watch this is the plain sleep
  const timer = setTimeout(wake, ms);
  return { woken, close: () => { clearTimeout(timer); for (const w of watchers) w.close(); } };
}

export async function main(argv, env = process.env, print = (l) => process.stdout.write(l + '\n')) {
  let target = null, timeout = DEFAULT_TIMEOUT_S;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--timeout') {
      if (!/^\d+$/.test(argv[i + 1] || '')) { print(`gate-wait: --timeout needs whole seconds\n${USAGE}`); return 2; }
      timeout = Number(argv[++i]);
    } else if (arg === '--latest') target = { latest: true };
    else if (arg === '--run') {
      if (!argv[i + 1]) { print(`gate-wait: --run needs a run directory\n${USAGE}`); return 2; }
      target = { run: argv[++i] };
    } else if (/^[1-9]\d*$/.test(arg)) target = { pid: Number(arg) };
    else { print(`gate-wait: unknown argument ${arg}\n${USAGE}`); return 2; }
  }
  if (!target) { print(USAGE); return 2; }
  const slots = env.ERA_GATE_SLOTS || '/tmp/era-gate-slots';
  const noWatch = env.ERA_GATE_WAIT_NO_WATCH === '1';
  let store = storeOf(env), stamps = env.ERA_GATE_STAMPS || '/tmp/era-gate-green';

  // a live gate: { pid, start, checkout, slot, since }
  const liveSlot = (pid) => {
    const slot = readSlot(path.join(slots, String(pid)));
    return slot && startTicks(pid) === slot.start ? slot : null;
  };
  const live = (pid) => {
    const slot = liveSlot(pid);
    if (slot) return { pid, start: slot.start, checkout: slot.hub, since: Number(slot.at) * 1000 || 0 };
    const start = startTicks(pid), checkout = start && gateCheckout(pid);
    return checkout ? { pid, start, checkout, since: startEpoch(start) } : null;
  };
  let gate = null, runDir = null;
  if (target.pid) {
    gate = live(target.pid);
    if (!gate) {
      if (startTicks(target.pid)) { print(`gate-wait: pid ${target.pid} is not an era-gate`); return 2; }
      runDir = store && findRun(store, { pid: target.pid });
      if (!runDir) { print(`gate-wait: no gate with pid ${target.pid}: no slot under ${slots}, no such process, no run of it under ${store}`); return 2; }
    }
  } else if (target.latest) {
    let names = [];
    try { names = fs.readdirSync(slots).filter((n) => /^[1-9]\d*$/.test(n)); } catch { /* none */ }
    const pid = names.map(Number).find((p) => liveSlot(p)?.hub === CHECKOUT);
    gate = pid ? live(pid) : null;
    if (!gate) {
      // a gate of this checkout still waiting for admission has no slot yet
      for (const name of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
        if (Number(name) !== process.pid && gateCheckout(name) === CHECKOUT) { gate = live(Number(name)); if (gate) break; }
      }
    }
    if (!gate) {
      runDir = store && findRun(store, { checkout: CHECKOUT });
      if (!runDir) { print(`gate-wait: no running gate and no gate run of ${CHECKOUT} under ${store}`); return 2; }
    }
  } else {
    const ref = target.run;
    runDir = path.isAbsolute(ref) || ref.includes('/') ? path.resolve(ref) : store ? path.join(store, ref) : ref;
    const keys = tryJSON(path.join(runDir, 'keys.json'));
    if (!keys) { print(`gate-wait: ${runDir} is not a gate run (no keys.json)`); return 2; }
    store = path.dirname(runDir);
    if (Number.isInteger(keys.pid)) gate = live(keys.pid);
    if (gate && gate.checkout !== keys.checkout) gate = null;
    if (gate == null && !Number.isInteger(keys.pid) && !fs.existsSync(path.join(runDir, 'receipt.json'))) {
      // a run recorded before gate pids were: its checkout's live gate, if any
      let names = [];
      try { names = fs.readdirSync(slots).filter((n) => /^[1-9]\d*$/.test(n)); } catch { /* none */ }
      const pid = names.map(Number).find((p) => liveSlot(p)?.hub === keys.checkout);
      gate = pid ? live(pid) : null;
    }
  }

  let log = null;
  if (gate) {
    const genv = environOf(gate.pid);
    if (genv) { store = storeOf(genv) ?? store; stamps = genv.ERA_GATE_STAMPS || stamps; }
    log = logOf(gate.pid);
    const deadline = Date.now() + timeout * 1000;
    let slotSeen = false;
    for (;;) {
      if (!runDir && store) runDir = findRun(store, { pid: gate.pid, since: gate.since });
      const watched = [slots, store, runDir].filter(Boolean);
      const left = deadline - Date.now();
      const waiter = await waitForChange(watched, Math.max(0, Math.min(RECHECK_MS, left)), noWatch);
      const slotNow = fs.existsSync(path.join(slots, String(gate.pid)));
      slotSeen ||= slotNow;
      if (startTicks(gate.pid) !== gate.start || (slotSeen && !slotNow)) { waiter.close(); break; }
      if (left <= 0) {
        waiter.close();
        print(progress({ pid: gate.pid, checkout: gate.checkout, runDir, waited: timeout }));
        return 124;
      }
      await waiter.woken;
      waiter.close();
    }
    if (!runDir && store) runDir = findRun(store, { pid: gate.pid, since: gate.since });
  }
  const keys = runDir ? tryJSON(path.join(runDir, 'keys.json')) : null;
  const { lines, code } = report({ runDir, log, stamps, pid: gate?.pid ?? keys?.pid ?? null, since: gate?.since ?? 0,
    checkout: gate?.checkout ?? keys?.checkout ?? null });
  for (const line of lines) print(line);
  return code;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (error) => { process.stderr.write(`gate-wait: ${error.message}\n`); process.exitCode = 2; });
}
