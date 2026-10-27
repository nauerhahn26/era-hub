// gate-admission.test.mjs — admission instead of exclusion (gate-speed plan
// 2026-10-26, phase 2b).
//
// era-gate.sh used to hold a machine-wide exclusive flock for a whole run, so
// two feature worktrees could never gate at once. Now a gate re-executes
// itself in a private network namespace (its 8378 hub and every fixed suite
// port are its own), and the lock guards only admission: a slot registry
// under /tmp/era-gate-slots, one file per running gate, checked against
// ERA_GATE_MAX_GATES and MemAvailable (1 GiB a lane plus 1 GiB reserve).
//
// The admission functions are lifted out of the shipped script TEXT and run
// under bash against a temp slot dir, a temp lock and a fake meminfo, so no
// test here touches the host's registry, lock or memory reading. The
// namespace cases run the gate's own namespace launcher; the end-to-end cases
// run the shipped script in a private test namespace (its own /tmp, a bound
// fake /proc/meminfo, its own network), so even they never see the host's
// gates. Without unprivileged user namespaces those cases skip and say why.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE_FILE = path.join(HUB, 'tools/era-gate.sh');
const gate = fs.readFileSync(GATE_FILE, 'utf8');
const GIB = 1048576;                      // kB, as /proc/meminfo counts
const PYTHON = path.join(HUB, 'tools/testing/parallel-worker.py');
const now = () => Math.floor(Date.now() / 1000);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fn(name) {
  const found = gate.match(new RegExp(`^${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm'));
  assert.ok(found, `era-gate.sh defines ${name}`);
  return found[0];
}
const ADMISSION = ['gate_error', 'gate_process_identity', 'gate_start_ticks', 'gate_mem_available_kib',
  'gate_gib', 'gate_live_slots', 'gate_admission_decision', 'gate_exclusive_waiting',
  'gate_register_slot', 'gate_release_slot', 'gate_admit'];
const ISOLATION = ['gate_error', 'gate_isolation_state', 'gate_namespace_argv', 'gate_isolation_probe'];
const FINISH = ['gate_wait_process', 'gate_process_matches', 'gate_cleanup_server', 'gate_stop_lanes',
  'gate_refresh_data_links', 'gate_archive_reports', 'gate_finish'];
const functions = (names) => ['set -uo pipefail', ...[...new Set(names)].map(fn)].join('\n');

// The suite's own environment may be a gate's (ERA_GATE_*, an isolation
// marker, the isolated runner's job dir): none of it may leak into a case.
function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^ERA_/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-gate-admission-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const writeMem = (file, kb) => fs.writeFileSync(file, `MemTotal:  8131784 kB\nMemFree:  100000 kB\nMemAvailable:  ${kb} kB\n`);
function bench(t, availableKb, extra = {}) {
  const dir = scratch(t);
  const b = {
    dir, slots: path.join(dir, 'slots'), lock: path.join(dir, 'gate.lock'), meminfo: path.join(dir, 'meminfo'),
    hub: path.join(dir, 'era-hub--wt-this'),
  };
  writeMem(b.meminfo, availableKb);
  b.env = cleanEnv({ SLOTS: b.slots, LOCK: b.lock, MEMINFO: b.meminfo, HUB: b.hub,
    GATE_ADMIT_POLL: '0.1', GATE_ADMIT_LOG_EVERY: '0', GATE_ADMIT_RAMP: '120', ERA_GATE_LANES: '2', ERA_GATE_MAX_GATES: '2', ...extra });
  return b;
}
function run(script, env) {
  return spawnSync('bash', ['-c', script], { env, encoding: 'utf8', timeout: 20000 });
}
function ok(result) {
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
// A bash case that keeps running (a waiting gate): its output so far, a wait
// for a line, its exit. Stopped by its own pid if a case fails half way.
function launch(t, script, env) {
  const child = spawn('bash', ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const c = { child, out: '', err: '' };
  child.stdout.on('data', (d) => { c.out += d; });
  child.stderr.on('data', (d) => { c.err += d; });
  c.exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  c.until = async (re, ms = 10000) => {
    const end = Date.now() + ms;
    while (!re.test(c.out)) {
      if (child.exitCode !== null || Date.now() > end) throw new Error(`no ${re}\nstdout:\n${c.out}\nstderr:\n${c.err}`);
      await delay(20);
    }
  };
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  return c;
}
// A live process a slot can name: a sleep this test owns and stops by pid.
// Slots are written as gates admitted ten minutes ago (past the ramp-up
// window) unless a case says otherwise.
function sleeper(t) {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return child;
}
function startTicks(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
}
function slot(b, pid, fields = {}) {
  fs.mkdirSync(b.slots, { recursive: true });
  const f = { pid, start: startTicks(pid), lanes: 2, at: now() - 600, hub: '/elsewhere/era-hub--wt-other', isolated: 1, ...fields };
  fs.writeFileSync(path.join(b.slots, String(pid)), Object.entries(f).map(([k, v]) => `${k}=${v}\n`).join(''));
}
const readSlot = (file) => Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const pidFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)) : []);
// Holds (or queues for) the gate lock from ONE process this test owns, so
// stopping that pid drops the hold or the queued request with it.
const HOLD = 'import fcntl, sys, time\nf = open(sys.argv[1], "w")\n' +
  'fcntl.flock(f, fcntl.LOCK_EX if sys.argv[2] == "-x" else fcntl.LOCK_SH)\nprint("held", flush=True)\ntime.sleep(60)\n';
function holder(t, lock, mode) {
  const child = spawn('python3', ['-I', '-c', HOLD, lock, mode], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  child.ready = new Promise((resolve) => child.stdout.once('data', resolve));
  return child;
}

// ---- the decision ----------------------------------------------------------

test('admission counts gates, the checkout and memory: a lane is 1 GiB plus a 1 GiB reserve', () => {
  const decide = (running, same, kb, lanes, max) => {
    const r = run(`${functions(['gate_admission_decision'])}\ngate_admission_decision ${running} ${same} ${kb} ${lanes} ${max}`, cleanEnv());
    ok(r);
    return r.stdout.trim();
  };
  assert.equal(decide(0, 0, 4 * GIB, 2, 2), 'admit 2');
  assert.equal(decide(1, 0, 3 * GIB, 2, 2), 'admit 2', 'two lanes need exactly 3 GiB');
  assert.equal(decide(1, 0, 3 * GIB - 1, 2, 2), 'admit 1', 'just under: memory admits one lane');
  assert.equal(decide(0, 0, 2 * GIB, 2, 2), 'admit 1', 'one lane needs 2 GiB');
  assert.match(decide(0, 0, 2 * GIB - 1, 2, 2), /^wait .*2 GiB/, 'under 2 GiB nothing is admitted');
  assert.equal(decide(2, 0, 8 * GIB, 2, 2), 'wait ERA_GATE_MAX_GATES=2 reached', 'ERA_GATE_MAX_GATES gates already run');
  assert.match(decide(0, 0, 8 * GIB, 1, 1), /^admit 1$/);
  assert.match(decide(1, 0, 8 * GIB, 1, 1), /^wait /);
  assert.match(decide(0, 1, 8 * GIB, 2, 2), /^wait .*checkout/, 'one gate per checkout: gate/ and public/ are its own');
  assert.equal(decide(0, 0, 6 * GIB, 4, 2), 'admit 4');
  assert.equal(decide(0, 0, 4 * GIB, 4, 2), 'admit 3', 'more lanes asked than memory covers: as many as it covers');
});

// ---- admission against a temp registry --------------------------------------

test('with memory for both lanes the gate is admitted at two, records its slot and holds the lock shared', (t) => {
  const b = bench(t, 4 * GIB);
  const r = run(`${functions(ADMISSION)}
gate_admit 0 1 || exit 9
echo "lanes=$ERA_GATE_LANES pid=$$ start=$(gate_start_ticks $$) slot=$GATE_SLOT"
if flock -x -n "$LOCK" true; then echo exclusive-free; else echo exclusive-refused; fi
if flock -s -n "$LOCK" true; then echo shared-free; fi`, b.env);
  ok(r);
  assert.match(r.stdout, /^== era-gate: admitted: 2 lanes; 0 other gates running, 4\.0 GiB free ==$/m);
  const [, lanes, pid, start, file] = /^lanes=(\d+) pid=(\d+) start=(\d+) slot=(\S+)$/m.exec(r.stdout);
  assert.equal(lanes, '2');
  assert.equal(file, path.join(b.slots, pid));
  const s = readSlot(file);
  assert.deepEqual([s.pid, s.start, s.lanes, s.hub, s.isolated], [pid, start, '2', b.hub, '1']);
  assert.match(s.at, /^\d{10}$/);
  assert.match(r.stdout, /^exclusive-refused$/m, 'an admitted gate holds the gate lock shared: an unisolated gate waits');
  assert.match(r.stdout, /^shared-free$/m, 'another isolated gate can still share it');
});

test('when memory admits only one lane the gate runs one lane and says so', (t) => {
  const b = bench(t, 2.5 * GIB);
  const r = run(`${functions(ADMISSION)}\ngate_admit 0 1 || exit 9\necho "lanes=$ERA_GATE_LANES"\ncat "$GATE_SLOT"`, b.env);
  ok(r);
  assert.match(r.stdout, /^== era-gate: admitted: 1 lane; 0 other gates running, 2\.5 GiB free ==$/m);
  assert.match(r.stdout, /^== era-gate: memory admits 1 of 2 lanes: this gate runs 1 lane ==$/m);
  assert.equal(r.stdout.match(/^lanes=1$/gm).length, 2, 'exported to the runner and recorded in the slot');
  assert.match(r.stdout, /^isolated=1$/m);
});

test('under 2 GiB free the gate waits, saying so, and starts once memory comes back', async (t) => {
  const b = bench(t, 1.5 * GIB);
  const c = launch(t, `${functions(ADMISSION)}\ngate_admit 0 1 || exit 9\necho "lanes=$ERA_GATE_LANES"`, b.env);
  await c.until(/^== era-gate: waiting for a slot: 0 gates running, 1\.5 GiB free \(.*2 GiB.*\) ==$/m);
  assert.deepEqual(pidFiles(b.slots), [], 'a waiting gate has no slot');
  writeMem(b.meminfo, 4 * GIB);
  assert.equal(await c.exited, 0, c.err);
  assert.match(c.out, /^== era-gate: admitted: 2 lanes; 0 other gates running, 4\.0 GiB free ==$/m);
  assert.deepEqual(pidFiles(b.slots), [String(c.child.pid)]);
});

test('ERA_GATE_MAX_GATES running gates hold the next one until one of them ends', async (t) => {
  const b = bench(t, 4 * GIB);
  const one = sleeper(t), two = sleeper(t);
  slot(b, one.pid, { hub: '/elsewhere/era-hub--wt-one' });
  slot(b, two.pid, { hub: '/elsewhere/era-hub--wt-two' });
  const c = launch(t, `${functions(ADMISSION)}\ngate_admit 0 1 || exit 9`, b.env);
  await c.until(/^== era-gate: waiting for a slot: 2 gates running, 4\.0 GiB free \(ERA_GATE_MAX_GATES=2 reached\) ==$/m);
  assert.equal(pidFiles(b.slots).length, 2, 'the waiting gate registered nothing');
  one.kill('SIGKILL');
  assert.equal(await c.exited, 0, c.err);
  assert.match(c.out, /^== era-gate: admitted: 2 lanes; 1 other gate running, 4\.0 GiB free ==$/m);
  assert.deepEqual(pidFiles(b.slots).sort(), [String(two.pid), String(c.child.pid)].sort(),
    'the ended gate\'s slot was dropped; the survivor and the newcomer remain');
});

test('a gate admitted under 120 s ago has its lanes\' memory set aside: it has not reached its peak yet', async (t) => {
  // young: admitted 10 s ago at two lanes, so 2 of the 4 GiB free are its own
  const young = bench(t, 4 * GIB);
  const one = sleeper(t);
  slot(young, one.pid, { at: now() - 10, lanes: 2 });
  let r = run(`${functions(ADMISSION)}\ngate_admit 0 1 || exit 9\necho "lanes=$ERA_GATE_LANES"`, young.env);
  ok(r);
  assert.match(r.stdout, /^== era-gate: admitted: 1 lane; 1 other gate running, 4\.0 GiB free, 2 GiB kept for gates still starting ==$/m);
  assert.match(r.stdout, /^== era-gate: memory admits 1 of 2 lanes: this gate runs 1 lane ==$/m);
  assert.match(r.stdout, /^lanes=1$/m);

  // past the window its use is in MemAvailable already: nothing is set aside
  const settled = bench(t, 4 * GIB);
  slot(settled, one.pid, { at: now() - 200, lanes: 2 });
  r = run(`${functions(ADMISSION)}\ngate_admit 0 1 || exit 9`, settled.env);
  ok(r);
  assert.match(r.stdout, /^== era-gate: admitted: 2 lanes; 1 other gate running, 4\.0 GiB free ==$/m);

  // 3 GiB free less 2 kept: under one lane's 2 GiB, so it waits until the
  // starting gate is past its window
  const tight = bench(t, 3 * GIB);
  slot(tight, one.pid, { at: now() - 10, lanes: 2 });
  const c = launch(t, `${functions(ADMISSION)}\ngate_admit 0 1 || exit 9`, tight.env);
  await c.until(/^== era-gate: waiting for a slot: 1 gate running, 3\.0 GiB free, 2 GiB kept for gates still starting \(one lane needs 2 GiB free\) ==$/m);
  slot(tight, one.pid, { at: now() - 200, lanes: 2 });
  assert.equal(await c.exited, 0, c.err);
  assert.match(c.out, /^== era-gate: admitted: 2 lanes; 1 other gate running, 3\.0 GiB free ==$/m);
});

test('a job in the isolated runner holds a slot the host gates count toward ERA_GATE_MAX_GATES', async (t) => {
  // The runner's gate runs behind a private /tmp and PID namespace, so the
  // runner's host worker registers the job (tools/testing/parallel-worker.py),
  // keyed by its namespace launcher's host pid; here a sleep stands in for it.
  const b = bench(t, 8 * GIB, { ERA_GATE_MAX_GATES: '1' });
  const launcher = sleeper(t);
  const python = (call) => {
    const r = spawnSync('python3', ['-c', `import pathlib, runpy, sys
w = runpy.run_path(sys.argv[1]); slots = pathlib.Path(sys.argv[2])
record = w['identity'](int(sys.argv[3]))
${call}`, PYTHON, b.slots, String(launcher.pid)], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(r.status, 0, r.stderr);
  };
  python("w['register_gate_slot'](record, 1, '/owned/job/workspace/era-hub', 'gate-20261027T000000Z-0123abcd', slots)");
  const c = launch(t, `${functions(ADMISSION)}\ngate_admit 0 1 || exit 9`, b.env);
  await c.until(/^== era-gate: waiting for a slot: 1 gate running, 8\.0 GiB free, 1 GiB kept for gates still starting \(ERA_GATE_MAX_GATES=1 reached\) ==$/m);
  assert.ok(fs.existsSync(path.join(b.slots, String(launcher.pid))), 'the waiting gate left the runner\'s live slot alone');
  python("w['release_gate_slot'](record, slots)");
  assert.equal(await c.exited, 0, c.err);
  assert.match(c.out, /^== era-gate: admitted: 2 lanes; 0 other gates running, 8\.0 GiB free ==$/m);
});

test('stale slots are dropped: a dead pid and a reused pid; anything else in the directory is left alone', (t) => {
  const b = bench(t, 4 * GIB, { ERA_GATE_MAX_GATES: '1' });
  const gone = spawnSync('true');
  fs.mkdirSync(b.slots, { recursive: true });
  fs.writeFileSync(path.join(b.slots, String(gone.pid)), `pid=${gone.pid}\nstart=1\nlanes=2\nat=1\nhub=/x\nisolated=1\n`);
  const reused = sleeper(t);
  slot(b, reused.pid, { start: Number(startTicks(reused.pid)) + 1 });
  fs.writeFileSync(path.join(b.slots, 'notes.txt'), 'not a slot');
  const r = run(`${functions(ADMISSION)}\ngate_admit 0 1 || exit 9\necho "pid=$$"`, b.env);
  ok(r);
  assert.match(r.stdout, /^== era-gate: admitted: 2 lanes; 0 other gates running/m, 'with ERA_GATE_MAX_GATES=1 only stale slots stood in the way');
  const pid = /^pid=(\d+)$/m.exec(r.stdout)[1];
  assert.deepEqual(pidFiles(b.slots), [pid]);
  assert.ok(fs.existsSync(path.join(b.slots, 'notes.txt')));
});

test('a second gate in the same checkout waits for the first', async (t) => {
  const b = bench(t, 8 * GIB);
  const first = sleeper(t);
  slot(b, first.pid, { hub: b.hub });
  const c = launch(t, `${functions(ADMISSION)}\ngate_admit 0 1 || exit 9`, b.env);
  await c.until(/^== era-gate: waiting for a slot: 1 gate running, 8\.0 GiB free \(.*this checkout.*\) ==$/m);
  first.kill('SIGKILL');
  assert.equal(await c.exited, 0, c.err);
});

test('an unisolated gate holding the gate lock, or queued for it, holds admission back', async (t) => {
  const b = bench(t, 8 * GIB);
  fs.writeFileSync(b.lock, '');
  // (a) an exclusive holder: today's gate, or one that fell back to the lock
  const exclusive = holder(t, b.lock, '-x');
  await exclusive.ready;
  const c = launch(t, `${functions(ADMISSION)}\ngate_admit 0 1 || exit 9`, b.env);
  await c.until(/^== era-gate: waiting for a slot: 0 gates running, 8\.0 GiB free \(.*holds the gate lock.*\) ==$/m);
  exclusive.kill('SIGKILL');
  assert.equal(await c.exited, 0, c.err);

  // (b) an exclusive waiter behind a shared holder: new isolated gates stand
  // back so the waiter is not starved (a shared lock would still be granted)
  const shared = holder(t, b.lock, '-s');
  await shared.ready;
  const waiter = holder(t, b.lock, '-x');
  const queued = new RegExp(`-> FLOCK +ADVISORY +WRITE +\\S+ +[0-9a-f]+:[0-9a-f]+:${fs.statSync(b.lock).ino} `);
  for (let i = 0; i < 250 && !queued.test(fs.readFileSync('/proc/locks', 'utf8')); i++) await delay(20);
  assert.match(fs.readFileSync('/proc/locks', 'utf8'), queued, 'the exclusive request is queued behind the shared holder');
  const d = launch(t, `${functions(ADMISSION)}\ngate_admit 0 1 || exit 9`, { ...b.env, HUB: b.hub + '-2' });
  await d.until(/^== era-gate: waiting for a slot: \d+ gates? running, 8\.0 GiB free \(.*queued for the gate lock.*\) ==$/m);
  waiter.kill('SIGKILL');
  assert.equal(await d.exited, 0, d.err);
  shared.kill('SIGKILL');
});

test('an exclusive gate (the fallback, or an inherited integration lock) is admitted without a shared hold', (t) => {
  const b = bench(t, 4 * GIB);
  fs.writeFileSync(b.lock, '');
  const r = run(`${functions(ADMISSION)}
exec 9>"$LOCK"; flock -x 9 || exit 8
gate_admit 1 0 || exit 9
cat "$GATE_SLOT"`, b.env);
  ok(r);
  assert.match(r.stdout, /^== era-gate: admitted: 2 lanes;/m);
  assert.match(r.stdout, /^isolated=0$/m);
});

test('ERA_GATE_MAX_GATES must be a whole number from 1 to 9', (t) => {
  for (const max of ['0', '10', 'two', '2; exit 0', '-1']) {
    const b = bench(t, 4 * GIB, { ERA_GATE_MAX_GATES: max });
    const r = run(`${functions(ADMISSION)}\ngate_admit 0 1`, b.env);
    assert.notEqual(r.status, 0, max);
    assert.match(r.stderr, /ERA_GATE_MAX_GATES/);
    assert.deepEqual(pidFiles(b.slots), []);
  }
});

test('a cancel request is honoured while the gate waits for a slot', async (t) => {
  const b = bench(t, 1 * GIB);
  const cancel = path.join(b.dir, 'cancel.request');
  const c = launch(t, `${functions(ADMISSION)}\ngate_admit 0 1 || exit 9`, { ...b.env, ERA_GATE_CANCEL_FILE: cancel });
  await c.until(/waiting for a slot/);
  fs.writeFileSync(cancel, 'stale\n');
  assert.equal(await c.exited, 130);
  assert.match(c.out, /^== era-gate: cancelled before execution ==$/m);
  assert.deepEqual(pidFiles(b.slots), []);
});

test('the slot file goes when the gate exits, through the EXIT trap gate_finish runs', (t) => {
  assert.match(fn('gate_finish'), /\n\s*gate_release_slot\n/, 'gate_finish releases the slot');
  for (const [how, status] of [['exit 3', 3], ['kill -TERM $$', 143]]) {
    const b = bench(t, 4 * GIB);
    const r = run(`${functions([...ADMISSION, ...FINISH])}
gate_admit 0 1 || exit 9
[ -f "$GATE_SLOT" ] && echo "registered $GATE_SLOT"
trap 'gate_finish "$?"' EXIT
trap 'exit 143' TERM
${how}`, b.env);
    assert.equal(r.status, status, r.stderr);
    assert.match(r.stdout, /^registered /m);
    assert.deepEqual(pidFiles(b.slots), [], `${how}: no slot is left behind`);
  }
});

test('a slot that names another process is never removed by this gate', (t) => {
  const b = bench(t, 4 * GIB);
  const other = sleeper(t);
  slot(b, other.pid);
  const r = run(`${functions(ADMISSION)}\nGATE_SLOT="$SLOTS/${other.pid}"\ngate_release_slot\necho done`, b.env);
  ok(r);
  assert.ok(fs.existsSync(path.join(b.slots, String(other.pid))));
});

// ---- where the gate runs ------------------------------------------------------

test('the gate knows whether it is on the host, inside its own namespace or inside the isolated runner', (t) => {
  const dir = scratch(t);
  const initial = path.join(dir, 'uid_map.initial'), mapped = path.join(dir, 'uid_map.mapped');
  fs.writeFileSync(initial, '         0          0 4294967295\n');
  fs.writeFileSync(mapped, `      ${process.getuid()}       ${process.getuid()}          1\n`);
  const here = fs.readlinkSync('/proc/self/ns/net');
  const state = (env) => {
    const r = run(`${functions(ISOLATION)}\ngate_isolation_state`, cleanEnv(env));
    ok(r);
    return r.stdout.trim();
  };
  assert.equal(state({ UID_MAP: initial }), 'host');
  assert.equal(state({ UID_MAP: mapped }), 'host', 'a user namespace alone is not the runner');
  assert.equal(state({ UID_MAP: initial, ERA_PARALLEL_JOB_DIR: '/owned/job' }), 'host',
    'the runner\'s job dir outside any user namespace is an operator\'s stray setting');
  assert.equal(state({ UID_MAP: mapped, ERA_PARALLEL_JOB_DIR: '/owned/job' }), 'runner');
  assert.equal(state({ UID_MAP: initial, ERA_GATE_ISOLATED: here }), 'entered');
  assert.equal(state({ UID_MAP: initial, ERA_GATE_ISOLATED: 'net:[1]' }), 'host', 'a marker naming another namespace is ignored');
});

// ---- the namespace itself (needs unprivileged user namespaces) ----------------

const userNamespaces = spawnSync('unshare', ['--user', '--map-current-user', '--keep-caps', '--mount', '--net', '--', 'true'], { encoding: 'utf8' });
const NS_SKIP = userNamespaces.status === 0 ? false
  : `unprivileged user namespaces are unavailable here (${(userNamespaces.stderr || String(userNamespaces.error)).trim()}); the gate falls back to its exclusive lock`;
const IP = ['/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip', '/bin/ip'].find((p) => fs.existsSync(p));

test('two gates\' namespaces bind one port side by side, beside a host listener on it', { skip: NS_SKIP }, async (t) => {
  const host = net.createServer();
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => host.close(resolve)));
  const port = host.address().port;
  const listen = `
const fs = require('node:fs'), net = require('node:net'), os = require('node:os');
const s = net.createServer().listen(Number(process.argv[1]), '127.0.0.1', () => {
  const caps = /^CapEff:\\s+(\\S+)/m.exec(fs.readFileSync('/proc/self/status', 'utf8'))[1];
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).length;
  console.log(JSON.stringify({ net: fs.readlinkSync('/proc/self/ns/net'), pid: process.pid, uid: process.getuid(), caps, lan,
    marker: process.env.ERA_GATE_ISOLATED }));
});
process.stdin.resume(); process.stdin.on('end', () => s.close(() => process.exit(0)));`;
  const probe = run(`${functions(ISOLATION)}\ngate_isolation_probe || { echo "$GATE_ISOLATION_REFUSED" >&2; exit 1; }`, cleanEnv());
  ok(probe);
  const gates = [0, 1].map(() => {
    const child = spawn('bash', ['-c', `${functions(ISOLATION)}
gate_namespace_argv || exit 2
exec "\${GATE_NS_ARGV[@]}" "" "$NODE" -e "$LISTEN" "$PORT"`],
    { env: cleanEnv({ NODE: process.execPath, LISTEN: listen, PORT: String(port) }), stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const exited = new Promise((resolve) => child.on('close', resolve));
    const bound = (async () => {
      for (let i = 0; i < 500 && !out.includes('\n'); i++) {
        if (child.exitCode !== null) break;
        await delay(20);
      }
      assert.ok(out.includes('\n'), `a namespaced listener did not bind ${port}: ${err}`);
      return JSON.parse(out);
    })();
    return { child, bound, exited };
  });
  const [a, b] = await Promise.all(gates.map((g) => g.bound));
  const hostNet = fs.readlinkSync('/proc/self/ns/net');
  assert.notEqual(a.net, b.net, 'each gate has its own network');
  assert.ok(a.net !== hostNet && b.net !== hostNet, 'neither is the host network');
  for (const [inside, g] of [[a, gates[0]], [b, gates[1]]]) {
    assert.equal(inside.pid, g.child.pid, 'the gate keeps its pid through unshare and setpriv (the detached pid file stays true)');
    assert.equal(inside.uid, process.getuid(), 'the same nonzero uid, mapped');
    assert.equal(BigInt('0x' + inside.caps), 0n, 'no capabilities: permission cases are not bypassed');
    assert.ok(inside.lan >= 1, 'a non-loopback test link exists for the LAN-socket cases');
    assert.equal(inside.marker, inside.net, 'the marker names the namespace the gate is in');
  }
  for (const g of gates) g.child.stdin.end();
  assert.deepEqual(await Promise.all(gates.map((g) => g.exited)), [0, 0]);
  assert.equal(host.listening, true, 'the host listener on the same port was never disturbed');
});

// The shipped script, end to end, in a private test namespace: its /tmp is a
// fresh tmpfs (so the registry, lock and slots are the test's own), a fake
// meminfo is bound over /proc/meminfo, and a listener holds the gate's own
// default port in the test namespace's network. A gate that enters its own
// namespace finds that port free; one that does not finds it occupied. The
// fake workspace has no tools/test-suite.mjs, so a gate that got that far
// stops at its inventory check with status 1.
const GATE_PORT = /^PORT="\$\{ERA_TEST_PORT:-(\d+)\}"$/m.exec(gate)[1];
const TEST_NS = `set -u
mount -t tmpfs -o mode=1777 tmpfs /tmp
printf 'MemTotal: 8131784 kB\\nMemAvailable: %s kB\\n' "$1" >/tmp/meminfo
mount --bind /tmp/meminfo /proc/meminfo
"$2" link set lo up
mkdir -p /tmp/ws/era-hub/tools /tmp/ws/era-family/test-data /tmp/fakebin
cp -- "$3" /tmp/ws/era-hub/tools/era-gate.sh
printf '#!/bin/sh\\necho "unshare: unshare failed: Operation not permitted" >&2\\nexit 1\\n' >/tmp/fakebin/unshare
chmod +x /tmp/fakebin/unshare
"$4" -e 'require("net").createServer().listen(Number(process.argv[1]),"127.0.0.1")' "$5" & holder=$!
for i in $(seq 100); do [ -n "$(ss -H -ltn "sport = :$5")" ] && break; sleep 0.05; done
cd /tmp/ws/era-hub
setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -c "$6"
echo "gate-exit=$?"
kill "$holder"; wait "$holder" 2>/dev/null
echo "slots:$(ls -A /tmp/era-gate-slots 2>/dev/null | tr '\\n' ' ')"
`;
function endToEnd(availableKb, script, env = {}) {
  const r = spawnSync('unshare', ['--user', '--map-current-user', '--keep-caps', '--mount', '--net', '--propagation', 'private',
    '--', 'bash', '-c', TEST_NS, 'gate-admission-e2e', String(availableKb), IP, GATE_FILE, process.execPath, GATE_PORT, script],
  { env: cleanEnv(env), encoding: 'utf8', timeout: 60000 });
  assert.equal(r.error, undefined, String(r.error));
  return { ...r, all: r.stdout + r.stderr };
}

test('end to end: the gate is admitted, enters its namespace keeping its pid, and leaves no slot', { skip: NS_SKIP }, () => {
  const r = endToEnd(4 * GIB, 'bash tools/era-gate.sh');
  assert.match(r.stdout, /^== era-gate: admitted: 2 lanes; 0 other gates running, 4\.0 GiB free ==$/m, r.all);
  assert.match(r.stdout, /^== era-gate: entering a private network namespace/m, r.all);
  assert.match(r.stdout, /^== era-gate: lock acquired ==$/m, 'the namespaced gate adopted the slot its own pid registered');
  assert.doesNotMatch(r.all, /occupied|in use/i, 'the gate\'s port was its own, not the test network\'s');
  assert.match(r.all, /test-suite\.mjs/, 'it ran on to the inventory check');
  assert.match(r.stdout, /^gate-exit=1$/m);
  assert.match(r.stdout, /^slots:\.lock $/m, 'the slot went with the gate');
});

// The gate that plans reuse is the one re-executed in the namespace, so the
// options it was started with must reach it: a signed cut's --no-cache dropped
// at the exec would let it reuse earlier passes. A stand-in test-suite.mjs, the
// first tool the namespaced gate runs, prints that gate's own command line; an
// --only exported before the exec would make the namespaced gate refuse it.
test('end to end: the namespaced gate keeps the options it was started with', { skip: NS_SKIP }, () => {
  const stub = 'import fs from "node:fs"; const argv = fs.readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\\0").filter(Boolean);\n' +
    'console.log("gate-argv: " + argv.slice(1).join(" ")); process.exit(1);\n';
  const r = endToEnd(4 * GIB, 'printf "%s" "$STUB" >tools/test-suite.mjs && bash tools/era-gate.sh --no-cache --only lanes', { STUB: stub });
  assert.match(r.stdout, /^== era-gate: entering a private network namespace/m, r.all);
  assert.match(r.stdout, /^== era-gate: lock acquired ==$/m, r.all);
  assert.doesNotMatch(r.all, /ERA_GATE_MODE must stay full/, 'the namespaced gate parsed --only again without an inherited affected mode');
  assert.match(r.stdout, /^gate-argv: \S*tools\/era-gate\.sh --no-cache --only lanes$/m, r.all);
  assert.match(r.stdout, /^gate-exit=1$/m);
});

test('end to end: too little memory for two lanes runs one, and says so', { skip: NS_SKIP }, () => {
  const r = endToEnd(2.5 * GIB, 'bash tools/era-gate.sh');
  assert.match(r.stdout, /^== era-gate: memory admits 1 of 2 lanes: this gate runs 1 lane ==$/m, r.all);
  assert.match(r.stdout, /^== era-gate: lock acquired ==$/m, r.all);
});

test('end to end: inside the isolated runner the gate neither unshares again nor waits for admission', { skip: NS_SKIP }, () => {
  // 1 GiB free: a gate that ran admission here would wait, never reach its lock
  const r = endToEnd(1 * GIB, 'bash tools/era-gate.sh', { ERA_PARALLEL_JOB_DIR: '/tmp/job', ERA_GATE_LANES: '1' });
  assert.doesNotMatch(r.stdout, /admitted|entering|waiting for a slot/, r.all);
  assert.match(r.stdout, /^== era-gate: lock acquired ==$/m, r.all);
  assert.match(r.all, /test port is occupied/, 'it stayed in the runner\'s network (here: the test\'s), so the held port is seen');
  assert.match(r.stdout, /^slots:$/m, 'the gate wrote no slot of its own: the runner\'s host worker holds the job\'s');
});

test('end to end: a refused unshare falls back to the exclusive lock and says so', { skip: NS_SKIP }, () => {
  const r = endToEnd(4 * GIB, 'PATH="/tmp/fakebin:$PATH" bash tools/era-gate.sh');
  assert.match(r.stdout, /^== era-gate: network isolation unavailable \(unshare: unshare failed: Operation not permitted\); falling back to the exclusive lock ==$/m, r.all);
  assert.match(r.stdout, /^== era-gate: admitted: 2 lanes;/m, r.all);
  assert.doesNotMatch(r.stdout, /entering a private network namespace/);
  assert.match(r.all, /test port is occupied/, 'unisolated: it shares the test network and sees the held port');
  assert.match(r.stdout, /^slots:\.lock $/m, 'its slot went with it');
});
