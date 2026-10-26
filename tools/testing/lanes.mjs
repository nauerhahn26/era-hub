#!/usr/bin/env node
// lanes.mjs: run the gate's frozen suites in lanes (gate-speed plan 2026-10-26,
// phase 2; design section 3.1). era-gate.sh starts it in place of its serial
// loop, from the gate dir, after the freeze and the shared hub's start.
//
//   node tools/testing/lanes.mjs <gate-dir>       run the plan; ERA_GATE_LANES lanes (default 2)
//   node tools/testing/lanes.mjs --simulate [--lanes 1,2,3]
//                                                  print the modelled wall time for the
//                                                  committed registry and durations
//   [--lanes N] [--registry FILE] [--durations FILE]           other inputs (tests)
//   [--meminfo FILE] [--floor-mb N] [--hold-ms N] [--grace-ms N] memory and stop seams (tests)
//
// Inputs: <gate>/.execution-plan.tsv (source ID, collected file, sha256 per
// suite, in the frozen order), the registry's classes, durations.json's
// median seconds (default_s for a suite with none).
//
// Order: one lane keeps the frozen order exactly, which is the serial loop.
// More lanes: solo suites first, then the longest known duration first, ties
// in the frozen order; whenever a lane is free it starts the first queued
// suite that may run beside every suite already running:
//   - a solo suite runs with nothing else running;
//   - two heavy suites never run together;
//   - a quiet suite never runs beside a heavy one;
//   - two suites that claim one fixed port never run together. The registry's
//     `ports` plus the gaze engine's bus (49155) when the collected copy stands
//     an engine up on it (suite-source.mjs claimsEngine; the classifier
//     records it too, this reads it from the copy so a stale registry cannot
//     put two engines side by side).
// Shared-hub readers run beside anything. Before starting a suite beside
// others the runner reads MemAvailable; under the floor (2048 MiB) it holds
// that lane and looks again every 2 s. The last running lane is never held:
// with nothing running, the next suite always starts, so the gate cannot stall.
//
// Each suite starts exactly as the serial loop started it: re-hashed against
// its frozen digest first (a missing or changed copy is refused, never run),
// then `timeout 900 node --test ./X.test.mjs` or `timeout 420 node ./X.js`,
// cwd the gate dir, the gate's environment and stdin, stdout and stderr into
// X.test.out or X.out. Lines: `RUN X` at start, `PASS label` or `FAIL label
// (see gate/out)` at the end (lanes interleave whole lines), and with more
// than one lane a `lanes:` header plus one `lanes: hold` / `lanes: resume`
// line per memory hold. One lane prints exactly what the serial loop printed.
//
// Outputs: <gate>/results.jsonl, one line per suite as it finishes
// ({suite, file, status pass|fail|changed, exit, seconds, lane, startedAt,
// endedAt}), and <gate>/.lane-results.tsv for era-gate.sh's tally (state,
// plan index, the digest hashed at start or "missing", source ID; frozen
// order). Exit 0 when every suite passed, 1 otherwise, 2 on bad input.
// Once lanes are on, harvest-durations.mjs must read gate/results.jsonl
// (--results): its .out-mtime method for legacy scripts assumes serial runs.
//
// SIGTERM or SIGINT: every suite's process tree is read from /proc and
// signalled by pid (TERM, then KILL after a bounded wait), never by name or
// group; the partial tally is written and the runner exits 143 or 130.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimsEngine, ENGINE_PORT } from './suite-source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LANES = 2;
export const MAX_LANES = 8;
export const FLOOR_MIB = 2048;
export const HOLD_MS = 2000;
export const GRACE_MS = 5000;

// ---- the plan and the classes -----------------------------------------------

export function readPlan(gate) {
  return fs.readFileSync(path.join(gate, '.execution-plan.tsv'), 'utf8').split('\n').filter(Boolean).map((line, index) => {
    const [id, name, digest] = line.split('\t');
    if (!id || !name || name.includes('/') || !/^[0-9a-f]{64}$/.test(digest || '')) throw new Error(`malformed execution plan line ${index + 1}`);
    return { index, id, name, digest };
  });
}

// Each plan row with its registry classes; `sourceOf(name)` (the collected
// copy) adds the engine's bus when the copy stands an engine up on it.
export function classesFor(plan, { registry, sourceOf = null }) {
  const byId = new Map(registry.suites.map((s) => [s.id, s]));
  return plan.map((row) => {
    const s = byId.get(row.id) || {};
    const ports = new Set(Array.isArray(s.ports) ? s.ports : []);
    if (sourceOf) {
      let src = null;
      try { src = sourceOf(row.name); } catch { /* a missing copy is refused when its turn comes */ }
      if (src != null && claimsEngine(src)) ports.add(ENGINE_PORT);
    }
    return { ...row, hub: s.hub || 'none', heavy: s.heavy === true, solo: s.solo === true, quiet: s.quiet === true,
      ports: [...ports].sort((a, b) => a - b) };
  });
}

export function estimate(suites, durations) {
  const fallback = Number.isFinite(durations?.default_s) ? durations.default_s : 0;
  return suites.map((s) => {
    const median = durations?.suites?.[s.id]?.median_s;
    return { ...s, seconds: Number.isFinite(median) ? median : fallback };
  });
}

export function queueOrder(suites, lanes) {
  if (lanes === 1) return [...suites];
  return [...suites].sort((a, b) => (b.solo - a.solo) || (b.seconds - a.seconds) || (a.index - b.index));
}

export function conflicts(a, b) {
  if (a.solo || b.solo) return true;
  if (a.heavy && b.heavy) return true;
  if ((a.heavy && b.quiet) || (a.quiet && b.heavy)) return true;
  return a.ports.some((port) => b.ports.includes(port));
}
export const canStart = (candidate, running) => !running.some((other) => conflicts(candidate, other));
export const pickNext = (queue, running) => queue.findIndex((suite) => canStart(suite, running));

// The same policy on estimated durations, memory aside: the modelled wall time.
export function simulate(suites, lanes) {
  const queue = queueOrder(suites, lanes), running = [], schedule = [];
  const freeLane = () => { for (let lane = 1; lane <= lanes; lane++) if (!running.some((r) => r.lane === lane)) return lane; return 0; };
  let now = 0;
  while (queue.length || running.length) {
    for (let lane = freeLane(); lane && queue.length; lane = freeLane()) {
      const at = pickNext(queue, running.map((r) => r.suite));
      if (at < 0) break;
      const [suite] = queue.splice(at, 1);
      const row = { id: suite.id, suite, lane, start: now, end: now + suite.seconds };
      running.push(row); schedule.push(row);
    }
    if (!running.length) throw new Error('the scheduler stalled'); // unreachable: an idle host accepts any suite
    running.sort((a, b) => a.end - b.end);
    now = running[0].end;
    while (running.length && running[0].end === now) running.shift();
  }
  return { makespan: now, schedule };
}

// ---- the host ------------------------------------------------------------------

export function memAvailableMiB(file = '/proc/meminfo') {
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? Math.floor(Number(m[1]) / 1024) : null;
  } catch { return null; }
}

// A pid's kernel start time; null once it is gone or a zombie. A pid is only
// signalled while its start time still matches the one recorded, so a reused
// pid is never touched.
function startTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? null : fields[19];
  } catch { return null; }
}
// pid and every live descendant with its start time, read from /proc (a browser
// in a session of its own included).
function processTree(root) {
  const tree = new Map(), stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    if (tree.has(pid)) continue;
    const start = startTime(pid);
    if (start == null) continue;
    tree.set(pid, start);
    let tasks = [];
    try { tasks = fs.readdirSync(`/proc/${pid}/task`); } catch { continue; }
    for (const task of tasks) {
      let children = '';
      try { children = fs.readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8'); } catch { /* exited */ }
      for (const child of children.split(/\s+/).filter(Boolean)) stack.push(Number(child));
    }
  }
  return tree;
}
function signalPids(pids, signal) {
  for (const [pid, start] of pids) {
    if (pid > 0 && startTime(pid) === start) { try { process.kill(pid, signal); } catch { /* already gone */ } }
  }
}

// The serial loop's command, label and output file for a collected suite.
export function command(name) {
  if (name.endsWith('.test.mjs')) return { argv: ['timeout', '900', 'node', '--test', `./${name}`], label: name, output: `${name.slice(0, -4)}.out` };
  const label = name.replace(/\.js$/, '');
  return { argv: ['timeout', '420', 'node', `./${name}`], label, output: `${label}.out` };
}

// ---- the runner ------------------------------------------------------------------

const writeLine = (line) => { try { fs.writeSync(1, line + '\n'); } catch { /* nobody is listening */ } };

export function runLanes({ gate, lanes, registry, durations, meminfo = '/proc/meminfo', floorMiB = FLOOR_MIB,
  holdMs = HOLD_MS, graceMs = GRACE_MS, env = process.env, print = writeLine }) {
  const plan = readPlan(gate);
  const suites = estimate(classesFor(plan, { registry, sourceOf: (name) => fs.readFileSync(path.join(gate, name), 'utf8') }), durations);
  const queue = queueOrder(suites, lanes), running = new Map(), verdicts = new Array(plan.length).fill(null);
  const resultsFile = path.join(gate, 'results.jsonl');
  fs.writeFileSync(resultsFile, '');
  let failures = 0, holding = false, holdTimer = null, stopping = null, swept = false, settle;
  const finished = new Promise((resolve) => { settle = resolve; });

  const record = (suite, row, digest) => {
    fs.appendFileSync(resultsFile, JSON.stringify({ suite: suite.id, file: suite.name, ...row }) + '\n');
    verdicts[suite.index] = [row.status, digest];
    if (row.status !== 'pass') failures++;
  };
  const writeTally = () => {
    const rows = plan.filter((row) => verdicts[row.index])
      .map((row) => { const [state, digest] = verdicts[row.index]; return [state, row.index, digest, row.id].join('\t') + '\n'; });
    fs.writeFileSync(path.join(gate, '.lane-results.tsv'), rows.join(''));
  };
  let settled = false;
  const done = (code) => {
    if (settled) return;
    settled = true;
    process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInt);
    writeTally(); settle(code);
  };
  const freeLane = () => { for (let lane = 1; lane <= lanes; lane++) if (!running.has(lane)) return lane; return 0; };

  const start = (suite) => {
    let digest;
    try { digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(gate, suite.name))).digest('hex'); }
    catch { digest = 'missing'; }
    if (digest !== suite.digest) {
      print(`FAIL ${suite.name} (collected suite missing or changed)`);
      const at = new Date().toISOString();
      record(suite, { status: 'changed', exit: null, seconds: 0, lane: null, startedAt: at, endedAt: at }, digest);
      return;
    }
    const lane = freeLane(), { argv, label, output } = command(suite.name);
    print(`RUN ${suite.name}`);
    const startedAt = new Date(), fd = fs.openSync(path.join(gate, output), 'w');
    let child;
    try { child = spawn(argv[0], argv.slice(1), { cwd: gate, env, stdio: ['inherit', fd, fd] }); }
    finally { fs.closeSync(fd); }
    running.set(lane, { suite, child });
    let ended = false;
    const end = (code, signal) => {
      if (ended) return;
      ended = true;
      running.delete(lane);
      const endedAt = new Date(), exit = code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1);
      print(exit === 0 ? `PASS ${label}` : `FAIL ${label} (see gate/${output})`);
      record(suite, { status: exit === 0 ? 'pass' : 'fail', exit, seconds: (endedAt - startedAt) / 1000, lane,
        startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() }, digest);
      if (!stopping) dispatch();
      else if (swept && !running.size) done(stopping === 'SIGINT' ? 130 : 143);
    };
    child.once('exit', end);
    child.once('error', () => end(127, null));
  };

  const dispatch = () => {
    clearTimeout(holdTimer); holdTimer = null;
    while (queue.length && running.size < lanes) {
      const at = pickNext(queue, [...running.values()].map((r) => r.suite));
      if (at < 0) break;
      if (running.size) {
        const mem = memAvailableMiB(meminfo);
        if (mem != null && mem < floorMiB) {
          if (!holding) print(`lanes: hold: MemAvailable ${mem} MiB under the ${floorMiB} MiB floor; ${running.size} running`);
          holding = true;
          holdTimer = setTimeout(dispatch, holdMs);
          break;
        }
        if (holding) { print(`lanes: resume: MemAvailable ${mem ?? '?'} MiB`); holding = false; }
      }
      start(queue.splice(at, 1)[0]);
    }
    if (!queue.length && !running.size) done(failures ? 1 : 0);
  };

  const stop = (signal) => {
    if (stopping) return;
    stopping = signal;
    clearTimeout(holdTimer);
    // every process of every running suite, and anything they start meanwhile;
    // a pid keeps the start time it was first seen with
    const pids = new Map();
    const learn = () => {
      const roots = [...[...running.values()].map(({ child }) => child.pid).filter(Boolean),
        ...[...pids].filter(([pid, start]) => startTime(pid) === start).map(([pid]) => pid)];
      for (const root of roots) for (const [pid, start] of processTree(root)) if (!pids.has(pid)) pids.set(pid, start);
    };
    learn();
    signalPids(pids, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    const sweep = () => {
      learn();
      const left = [...pids].filter(([pid, start]) => startTime(pid) === start);
      if (left.length && Date.now() < deadline) { setTimeout(sweep, 50); return; }
      signalPids(left, 'SIGKILL');
      swept = true;
      if (!running.size) done(signal === 'SIGINT' ? 130 : 143);
    };
    sweep();
  };
  const onTerm = () => stop('SIGTERM'), onInt = () => stop('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);

  if (lanes > 1) print(`lanes: ${lanes} (memory floor ${floorMiB} MiB)`);
  dispatch();
  return finished;
}

// ---- the command line ----------------------------------------------------------

export function parseLanes(value) {
  const text = value == null || value === '' ? String(DEFAULT_LANES) : String(value);
  if (!/^[1-9]$/.test(text) || Number(text) > MAX_LANES) throw new Error(`ERA_GATE_LANES must be a whole number from 1 to ${MAX_LANES} (got ${JSON.stringify(text)})`);
  return Number(text);
}

function simulateReport(registryFile, durationsFile, laneList) {
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  const durations = JSON.parse(fs.readFileSync(durationsFile, 'utf8'));
  const plan = registry.suites.map((s, index) => ({ index, id: s.id, name: path.basename(s.id.slice(s.id.indexOf(':') + 1)) }));
  const suites = estimate(classesFor(plan, { registry }), durations);
  const unknown = suites.filter((s) => !Number.isFinite(durations?.suites?.[s.id]?.median_s)).length;
  const lines = [`${suites.length} suites, ${Math.round(suites.reduce((n, s) => n + s.seconds, 0))} s of suite time` +
    ` (${unknown} without a recorded duration take default_s ${durations.default_s} s); memory holds and setup not modelled`];
  for (const lanes of laneList) {
    const { makespan } = simulate(suites, lanes);
    lines.push(`${lanes} lane${lanes === 1 ? ' ' : 's'}: ${Math.round(makespan)} s (${(makespan / 60).toFixed(1)} min)`);
  }
  return lines.join('\n');
}

async function main(argv) {
  const option = (name) => { const at = argv.indexOf(name); return at < 0 ? null : argv[at + 1]; };
  const number = (name, fallback) => { const v = option(name); if (v == null) return fallback; if (!/^\d+$/.test(v)) throw new Error(`${name} needs a whole number`); return Number(v); };
  const registryFile = option('--registry') || path.join(HERE, 'registry.json');
  const durationsFile = option('--durations') || path.join(HERE, 'durations.json');
  if (argv.includes('--simulate')) {
    const list = (option('--lanes') || '1,2,3').split(',').map(parseLanes);
    console.log(simulateReport(registryFile, durationsFile, list));
    return 0;
  }
  const lanes = parseLanes(option('--lanes') ?? process.env.ERA_GATE_LANES);
  const flags = new Set(['--lanes', '--registry', '--durations', '--meminfo', '--floor-mb', '--hold-ms', '--grace-ms']);
  const gate = argv.find((arg, i) => !arg.startsWith('--') && !flags.has(argv[i - 1]));
  if (!gate) throw new Error('usage: lanes.mjs <gate-dir> | --simulate');
  return runLanes({
    gate: path.resolve(gate), lanes,
    registry: JSON.parse(fs.readFileSync(registryFile, 'utf8')),
    durations: JSON.parse(fs.readFileSync(durationsFile, 'utf8')),
    meminfo: option('--meminfo') || '/proc/meminfo',
    floorMiB: number('--floor-mb', FLOOR_MIB), holdMs: number('--hold-ms', HOLD_MS), graceMs: number('--grace-ms', GRACE_MS),
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (error) => { process.stderr.write(`FATAL: lanes: ${error.message}\n`); process.exitCode = 2; });
}
