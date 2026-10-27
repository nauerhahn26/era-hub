#!/usr/bin/env node
// reuse.mjs: the gate's run store, per-suite result reuse, the retry ledger and
// the shared-state guard (gate-speed plan 2026-10-26, phase 3; design 3.2).
// era-gate.sh calls it; the rules are pure functions so a test can hold each
// one without running a gate.
//
//   reuse.mjs plan <gate-dir> <inputs.json> [--no-cache] [--rerun-failed RUN | --restamp RUN] [--gate-pid PID]
//   reuse.mjs guard <data-dir> <snapshot.json>
//   reuse.mjs record <gate-dir> [--data DIR] [--checks inputs=ok,hub=ok,execution=ok] [--pass N] [--fail N] [--summary LINE]
//   reuse.mjs select <suite[,suite...]> <selection.json>
//   [--hub DIR] [--registry FILE] [--store DIR]                    other inputs (tests)
//
// The store is $ERA_GATE_RUNS, default $HOME/.local/state/era-gate-runs. With
// neither, or when it cannot be written (the isolated runner's home is a
// read-only tmpfs), `plan` says so in one line and writes no .reuse.json: every
// suite runs fresh, nothing is retried, nothing is recorded. One directory per
// gate run, named <UTC time>-<hub tree sha, 7 chars>: keys.json (each suite's key
// and its parts), inputs.json, plan.tsv, env.json, results.jsonl (lanes.mjs
// appends one line per attempt as it ends), suites/*.out, receipt.json.
// flakes.jsonl sits beside the runs. A plan prunes runs older than 72 h and
// beyond the newest 60.
//
// The key of a suite. Change any part and the key changes; change anything else
// and it does not:
//   runtime     the gate's inputs manifest by content only: every file of the six
//               repos except tests/ of the five collected ones (their content is
//               in `suite` and `helpers`), docs/ and every repo root's *.md
//               (README.md, AGENTS.md and the like) of all six, registry.json and
//               durations.json; the seed's contents; the served farm's contents;
//               the private gate-env.sh digest. No root path, port or mode.
//   external    files outside the six roots that a suite reads: the private
//               scanner and the main checkouts' scanners (era-scan-parity)
//   helpers     every collected file that is not a suite, after the port rewrite.
//               Coarse on purpose: any helper or fixture change reruns everything.
//   harness     tools/era-gate.sh, tools/test-suite.mjs, tools/testing/*.mjs
//   node        the version that runs the suites
//   playwright  playwright and playwright-core versions and the chromium and
//               headless-shell revisions they launch
//   env         ERA_* as exported to suites (not ERA_GATE_*, ERA_WT_SUFFIX or
//               ERA_TEST_JOBS, which only steer the harness; root and data paths
//               written as placeholders), TZ, LANG, LC_ALL, NODE_OPTIONS
//   suite       the frozen sha256 of the collected copy (so a pass at one test
//               port is not evidence for another)
//   registry    the suite's own registry entry; the whole registry and
//               durations.json for a suite whose source names either file
//   scans       only for a suite whose registry entry has `keyInputs`: the
//               manifest's entries (content and mode) for every file that
//               matches one of its "<repo>:<glob>" patterns. tests/ is outside
//               `runtime` so an unrelated test edit reruns nothing else, but a
//               suite that reads the other suites (suite-ports, suite-classes)
//               has them as inputs: without this a neighbour's fix left it
//               refused on an unchanged key, and its pass would be reused past
//               a newly added pkill or duplicate port.
//
// A pass qualifies for reuse when its key is identical, it passed first time
// (never a FLAKY pass), it ended under 24 h ago and after every recorded
// failure on that key, and its run did not see its inputs or execution set
// change. A shared-reader pass also needs a run that finished with its shared
// hub alive and the hub's data unchanged (the guard); shared-writer passes
// never qualify.
//
// The retry ledger is the store: a suite that has failed twice on one key (not
// counting resource failures) is not run again on that key, and the plan and
// the lanes say what its key covers and how to run it anyway (`refusal`); one that failed
// once is run, and a pass then is FLAKY. lanes.mjs does the one in-gate retry.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MAX_AGE_MS = 24 * 3600 * 1000;
export const RETRY_BUDGET = 1;
export const KEEP_RUNS = 60;
export const KEEP_MS = 72 * 3600 * 1000;
export const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-z]{7}(?:-\d+)?$/;
const LEGACY = new Set(['run', 'parts', 'transfer', 'mistakes', 'pencil', 'narrow', 'sortfix',
  'fltest', 'bargein', 'sortbugs', 'rhymecount', 'transfercount', 'phonetic'].map((n) => `${n}.js`));
const COLLECTED = new Set(['era-core', 'era-making-words', 'era-pencil', 'era-board', 'era-hub']);
const SCHEDULING = new Set(['era-hub:tools/testing/registry.json', 'era-hub:tools/testing/durations.json']);
export const EXTERNAL = ['era-family/tools/era-scan.sh', 'era-core/.github/era-scan.sh', 'era-board/.github/era-scan.sh',
  'era-pencil/.github/era-scan.sh', 'era-making-words/.github/era-scan.sh'];
const HARNESS_ONLY = new Set(['ERA_WT_SUFFIX', 'ERA_TEST_JOBS']);
const ENV_ALWAYS = ['TZ', 'LANG', 'LC_ALL', 'NODE_OPTIONS'];
// The shared hub's own bookkeeping, which it writes whatever the suites do.
export const GUARD_ALLOW = ['logs/**', 'pool/devices/*.json', 'pool/version', 'recipes/today.json', 'wardrobe.json',
  '.clothing-sig', '.clothing-photos', '.weather-cache.json', 'this-week/.tmp/**', 'presence/**', 'tts-cache/**',
  'symbols-cache/**'];
export const PART_NAMES = {
  runtime: 'product files', external: 'the private scanner', helpers: 'test helpers', harness: 'the gate harness',
  node: 'node', playwright: 'playwright', env: 'the environment', suite: 'the suite', registry: 'its registry entry',
  scans: 'the files it scans',
};
const PARTS = Object.keys(PART_NAMES);

export const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
const fileDigest = (file) => { try { return sha(fs.readFileSync(file)); } catch { return null; } };
const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const tryJSON = (file) => { try { return readJSON(file); } catch { return null; } };
const readLines = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const jsonLines = (file) => readLines(file).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const isSuiteName = (name) => !name.includes('/') && (name.endsWith('.test.mjs') || LEGACY.has(name));
export const labelOf = (name) => (name.endsWith('.test.mjs') ? name : name.replace(/\.js$/, ''));
export const outputOf = (name) => (name.endsWith('.test.mjs') ? `${name.slice(0, -4)}.out` : `${labelOf(name)}.out`);

export function planRows(gate) {
  return readLines(path.join(gate, '.execution-plan.tsv')).map((line, index) => {
    const [id, name, digest] = line.split('\t');
    return { index, id, name, digest };
  });
}

// ---- the key ----------------------------------------------------------------------

export function runtimeView(manifest) {
  const repositories = {};
  for (const [repo, value] of Object.entries(manifest.repositories || {})) {
    const files = {};
    for (const [name, file] of Object.entries(value.files || {})) {
      const docs = name.startsWith('docs/') || (!name.includes('/') && name.endsWith('.md'));
      if (docs || (COLLECTED.has(repo) && name.startsWith('tests/')) || SCHEDULING.has(`${repo}:${name}`)) continue;
      files[name] = file;
    }
    repositories[repo] = files;
  }
  const configuration = manifest.configuration || {};
  const farm = {};
  for (const [name, entry] of Object.entries(manifest.servedFarm || {})) {
    const { target, ...content } = entry || {};
    farm[name] = content;
  }
  return { version: manifest.version ?? null, platform: manifest.platform ?? null, arch: manifest.arch ?? null,
    repositories, seed: configuration.seed?.hash ?? null, gateEnvironment: configuration.gateEnvironment ?? null, servedFarm: farm };
}
export const runtimeHash = (manifest) => sha(canonical(runtimeView(manifest)));

export function externalDigest(root) {
  return sha(canonical(Object.fromEntries(EXTERNAL.map((rel) => [rel, fileDigest(path.join(root, rel))]))));
}

export function helpersDigest(gate) {
  const helpers = readLines(path.join(gate, '.source-map.tsv')).map((line) => line.split('\t')[1])
    .filter((rel) => rel && !isSuiteName(rel)).sort();
  return sha(helpers.map((rel) => `${rel}\0${fileDigest(path.join(gate, rel)) ?? 'missing'}`).join('\n'));
}

export function harnessDigest(hub) {
  let testing = [];
  try { testing = fs.readdirSync(path.join(hub, 'tools/testing')).filter((n) => n.endsWith('.mjs')).sort(); } catch { /* none */ }
  const files = ['tools/era-gate.sh', 'tools/test-suite.mjs', ...testing.map((n) => `tools/testing/${n}`)];
  return sha(files.map((f) => `${f}\0${fileDigest(path.join(hub, f)) ?? 'missing'}`).join('\n'));
}

// What the suites in <from> get when they import playwright.
export function playwrightIdentity(from) {
  const req = createRequire(path.join(from, 'reuse-probe.js'));
  const pkg = (name) => { try { return req.resolve(`${name}/package.json`); } catch { return null; } };
  const version = (name) => { const f = pkg(name); return f ? tryJSON(f)?.version ?? null : null; };
  const core = pkg('playwright-core');
  const browsers = core ? tryJSON(path.join(path.dirname(core), 'browsers.json'))?.browsers || [] : [];
  const revision = (name) => browsers.find((b) => b.name === name)?.revision ?? 'none';
  return `${version('playwright') ?? 'none'}/${version('playwright-core') ?? 'none'}` +
    `/chromium-${revision('chromium')}/headless-${revision('chromium-headless-shell')}`;
}

export function envBlock(env, manifest) {
  const places = Object.entries(manifest.repositories || {}).filter(([, v]) => v?.root).map(([repo, v]) => [v.root, `<${repo}>`]);
  const hubRoot = manifest.repositories?.['era-hub']?.root;
  if (hubRoot) places.push([path.dirname(hubRoot), '<root>']);
  if (env.ERA_DATA_DIR) places.push([env.ERA_DATA_DIR, '<data>']);
  places.sort((a, b) => b[0].length - a[0].length);
  const plain = (value) => places.reduce((v, [place, mark]) => v.split(place).join(mark), String(value));
  const block = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('ERA_') || name.startsWith('ERA_GATE_') || HARNESS_ONLY.has(name)) continue;
    block[name] = plain(value);
  }
  for (const name of ENV_ALWAYS) block[name] = env[name] ?? null;
  return block;
}

export function sharedParts({ gate, hub, manifest, env, node = process.version }) {
  const hubRoot = manifest.repositories?.['era-hub']?.root || hub;
  return {
    runtime: runtimeHash(manifest), external: externalDigest(path.dirname(hubRoot)), helpers: helpersDigest(gate),
    harness: harnessDigest(hub), node, playwright: playwrightIdentity(gate), env: sha(canonical(envBlock(env, manifest))),
  };
}
const READS_REGISTRY = /registry\.json|durations\.json/;
// keyInputs: "<repo>:<glob>" over the inputs manifest's files (** any depth, *
// within one path segment). Sorted paths, content and mode, like `runtime`.
export const KEY_INPUT = /^[a-z][a-z0-9-]*:[^\0\s:]+$/;
export function scansDigest(manifest, patterns) {
  const tests = patterns.map((p) => { const at = p.indexOf(':'); return { repo: p.slice(0, at), re: globRegex(p.slice(at + 1)) }; });
  const files = {};
  for (const [repo, value] of Object.entries(manifest.repositories || {})) {
    for (const [name, file] of Object.entries(value.files || {})) {
      if (tests.some((t) => t.repo === repo && t.re.test(name))) files[`${repo}:${name}`] = file;
    }
  }
  return sha(canonical({ patterns: [...patterns].sort(), files }));
}
export function suiteParts({ row, entry, gate, wholeRegistry, manifest = {} }) {
  let source = '';
  try { source = fs.readFileSync(path.join(gate, row.name), 'utf8'); } catch { /* the runner refuses a missing copy */ }
  const own = { suite: row.digest, registry: READS_REGISTRY.test(source) ? `whole:${wholeRegistry}` : sha(canonical(entry ?? null)) };
  // absent, not null, without keyInputs: such a suite keeps the key it always had
  if (Array.isArray(entry?.keyInputs) && entry.keyInputs.length) own.scans = scansDigest(manifest, entry.keyInputs);
  return own;
}
export const suiteKey = (shared, own) => sha(canonical({ v: 1, ...shared, ...own }));

// Every planned suite's key: { shared, suites: { id: { file, key, suite, registry, hub } } }.
export function computeKeys({ gate, hub, manifest, env, registryFile, node }) {
  const registryText = fs.readFileSync(registryFile, 'utf8');
  const registry = JSON.parse(registryText);
  let durations = '';
  try { durations = fs.readFileSync(path.join(path.dirname(registryFile), 'durations.json'), 'utf8'); } catch { /* none */ }
  const wholeRegistry = sha(`${registryText}\0${durations}`);
  const byId = new Map(registry.suites.map((s) => [s.id, s]));
  const shared = sharedParts({ gate, hub, manifest, env, node });
  const suites = {};
  for (const row of planRows(gate)) {
    const entry = byId.get(row.id);
    const own = suiteParts({ row, entry, gate, wholeRegistry, manifest });
    suites[row.id] = { file: row.name, key: suiteKey(shared, own), ...own, hub: entry?.hub || 'none' };
  }
  return { shared, suites };
}

// ---- the store ----------------------------------------------------------------------

export function storeDir(env = process.env) {
  if (env.ERA_GATE_RUNS) return path.resolve(env.ERA_GATE_RUNS);
  return env.HOME ? path.join(env.HOME, '.local', 'state', 'era-gate-runs') : null;
}
export function storeWritable(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}
export function listRuns(store) {
  let names = [];
  try { names = fs.readdirSync(store, { withFileTypes: true }).filter((e) => e.isDirectory() && RUN_ID.test(e.name)).map((e) => e.name); } catch { /* empty */ }
  return names.sort().reverse();
}
export function loadRun(store, id) {
  const dir = path.join(store, id);
  return { id, dir, keys: tryJSON(path.join(dir, 'keys.json')), receipt: tryJSON(path.join(dir, 'receipt.json')),
    results: jsonLines(path.join(dir, 'results.jsonl')) };
}
export function newRunId(store, tree, now) {
  const base = `${iso(now).replace(/:/g, '-')}-${(tree || 'notree').slice(0, 7).padEnd(7, '0')}`;
  let id = base;
  for (let n = 2; fs.existsSync(path.join(store, id)); n++) id = `${base}-${n}`;
  return id;
}
export function pruneRuns(store, keep, now) {
  for (const [at, id] of listRuns(store).entries()) {
    if (id === keep) continue;
    const time = Date.parse(id.slice(0, 20).replace(/T(\d{2})-(\d{2})-(\d{2})Z/, 'T$1:$2:$3Z'));
    if (at >= KEEP_RUNS || !(now - time < KEEP_MS)) fs.rmSync(path.join(store, id), { recursive: true, force: true });
  }
}
// A run named on the command line: an id under the store, its absolute path,
// or latest (the newest run of this checkout; the store is shared by worktrees).
export function resolveRun(store, ref, checkout = null) {
  const ids = listRuns(store);
  const id = ref === 'latest' ? ids.find((r) => !checkout || tryJSON(path.join(store, r, 'keys.json'))?.checkout === checkout)
    : path.isAbsolute(ref) && path.dirname(path.resolve(ref)) === store ? path.basename(ref) : ref;
  if (!id || !RUN_ID.test(id) || !ids.includes(id)) {
    throw new Error(ref === 'latest' ? `no earlier gate run of ${checkout} under ${store}` : `no gate run ${JSON.stringify(ref)} under ${store}`);
  }
  const run = loadRun(store, id);
  if (!run.keys) throw new Error(`${id} has no keys.json; it is not a gate run record`);
  return run;
}

// Non-resource failures per key, across every stored run: [{run, line}].
export function failureLedger(runs) {
  const ledger = new Map();
  for (const run of runs) for (const line of run.results) {
    if (line.status !== 'fail' || line.resource || !line.key) continue;
    if (!ledger.has(line.key)) ledger.set(line.key, []);
    ledger.get(line.key).push({ run: run.id, line });
  }
  for (const list of ledger.values()) list.sort((a, b) => Date.parse(b.line.endedAt) - Date.parse(a.line.endedAt));
  return ledger;
}

// ---- what qualifies ---------------------------------------------------------------

// null when this stored pass may stand in for a fresh run; else why not.
export function qualifies(line, run, { hub = 'none', now = Date.now(), maxAgeMs = MAX_AGE_MS, lastFailure = null } = {}) {
  if (line.status !== 'pass') return line.status === 'fail' ? `it failed in ${run.id}` : `it did not pass in ${run.id}`;
  if (line.flaky) return `its pass in ${run.id} came after a failure (FLAKY)`;
  const ended = Date.parse(line.endedAt);
  if (!Number.isFinite(ended) || ended > now + 60_000) return `its time in ${run.id} is not believable`;
  if (now - ended >= maxAgeMs) return `its pass in ${run.id} is older than ${Math.round(maxAgeMs / 3600_000)} h`;
  if (lastFailure != null && ended <= lastFailure) return `it failed on these inputs after its pass in ${run.id}`;
  if (hub === 'shared-writer') return 'a suite that writes to the shared hub is never reused';
  const receipt = run.receipt;
  if (receipt && receipt.checks?.inputs !== 'ok') return `${run.id}'s inputs changed while it ran`;
  if (receipt && receipt.checks?.execution !== 'ok') return `${run.id}'s execution set was incomplete`;
  if (hub === 'shared-reader') {
    if (!receipt) return `${run.id} did not finish, so its shared hub's state is unknown`;
    if (receipt.checks?.hub !== 'ok') return `${run.id} lost its shared hub`;
    if (receipt.guard?.changed?.length) return `the shared hub's data changed during ${run.id}`;
  }
  return null;
}

// The newest qualifying pass of <id> on <key> among <runs> (newest first).
export function lookup({ id, key, hub, runs, ledger, now, maxAgeMs }) {
  const failures = ledger.get(key) || [];
  const lastFailure = failures.length ? Date.parse(failures[0].line.endedAt) : null;
  for (const run of runs) {
    for (const line of [...run.results].reverse()) {
      if (line.suite !== id || line.key !== key || line.status !== 'pass') continue;
      if (!qualifies(line, run, { hub, now, maxAgeMs, lastFailure })) return { run, line };
    }
  }
  return null;
}

// Why <id> runs: what its newest record in <runs> says, against the current key.
export function explain({ id, key, own, shared, hub, runs, now, maxAgeMs, ledger }) {
  for (const run of runs) {
    const line = [...run.results].reverse().find((l) => l.suite === id && l.status !== 'blocked');
    if (!line) continue;
    if (line.key !== key) {
      const before = { ...(run.keys?.shared || {}), ...(run.keys?.suites?.[id] || {}) };
      const current = { ...shared, ...own };
      const part = PARTS.find((p) => before[p] !== current[p]);
      return `${part ? PART_NAMES[part] : 'its key'} changed since ${run.id}`;
    }
    if (line.status === 'fail') return line.resource ? `it failed for want of a resource in ${run.id}` : `it failed in ${run.id}`;
    const failures = ledger.get(key) || [];
    return qualifies(line, run, { hub, now, maxAgeMs, lastFailure: failures.length ? Date.parse(failures[0].line.endedAt) : null })
      || `no qualifying pass on these inputs`;
  }
  return 'no earlier run of it';
}

// Why a suite is refused (two failures on this key), in words the lanes repeat:
// what changed since its last pass on another key, and the way out when the
// fix is something its key cannot see.
export function refusal({ id, key, own, shared, runs, ledger, label }) {
  const last = (ledger.get(key) || [])[0];
  let since = '';
  for (const run of runs) {
    const line = [...run.results].reverse().find((l) => l.suite === id && l.status === 'pass' && l.key && l.key !== key);
    if (!line) continue;
    const before = { ...(run.keys?.shared || {}), ...(run.keys?.suites?.[id] || {}) }, current = { ...shared, ...own };
    const parts = PARTS.filter((p) => before[p] !== current[p]).map((p) => PART_NAMES[p]);
    since = `; since its last pass (${run.id}) ${parts.length ? listNames(parts) : 'its key'} changed`;
    break;
  }
  return `its key is the same at both failures${last ? ` (last in ${last.run})` : ''}${since}; ` +
    `if what you fixed is not in its key, run it with --only ${label} or the gate with --no-cache`;
}

// One suite's decision: reuse (a qualifying pass), blocked (two failures on this
// key), or run (priorFailures > 0 makes its pass FLAKY and its failure final).
export function decide({ id, key, hub, runs, ledger, noCache = false, now = Date.now(), maxAgeMs = MAX_AGE_MS }) {
  if (noCache) return { decision: 'run', priorFailures: 0 };
  const found = lookup({ id, key, hub, runs, ledger, now, maxAgeMs });
  if (found) return { decision: 'reuse', from: found.run.id, endedAt: found.line.endedAt };
  const failures = ledger.get(key) || [];
  const last = failures[0];
  const lastFailure = last ? { run: last.run, endedAt: last.line.endedAt, seconds: last.line.seconds, exit: last.line.exit, file: last.line.file } : null;
  if (failures.length >= 2) return { decision: 'blocked', priorFailures: failures.length, lastFailure };
  return { decision: 'run', priorFailures: failures.length, lastFailure };
}

// A failure that says nothing about the suite: never retried, never in the ledger.
export function classifyFailure({ exit, output = '' }) {
  if (exit === 124) return { resource: true, why: 'it timed out (exit 124)' };
  if (exit === 137) return { resource: true, why: 'it was killed (exit 137)' };
  if (/out of memory/i.test(output)) return { resource: true, why: "'out of memory' in its output" };
  if (/EADDRINUSE/.test(output)) return { resource: true, why: 'EADDRINUSE in its output' };
  return { resource: false, why: null };
}

// ---- the plan ------------------------------------------------------------------------

const listNames = (names, max = 8) => (names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', '));
const short = (value) => (/^[0-9a-f]{64}$/.test(value) ? value.slice(0, 8) : value);

export function planGate({ gate, inputs, hub = path.resolve(HERE, '../..'), registryFile = path.join(HERE, 'registry.json'),
  env = process.env, store = storeDir(env), noCache = false, rerun = null, restamp = null, now = Date.now(), node,
  maxAgeMs = MAX_AGE_MS, gatePid = null }) {
  const out = [], refuse = (lines) => ({ ok: false, out, errors: lines });
  if (!store || !storeWritable(store)) {
    if (rerun || restamp) return refuse([`${rerun ? '--rerun-failed' : '--restamp'} needs the run store, and ${store || '$ERA_GATE_RUNS (HOME is not set)'} is not available here`]);
    out.push(`reuse: no writable run store (${store || 'neither ERA_GATE_RUNS nor HOME is set'}); every suite runs fresh, nothing is retried or recorded`);
    return { ok: true, out, active: false };
  }
  const manifest = readJSON(inputs);
  const { shared, suites } = computeKeys({ gate, hub, manifest, env, registryFile, node });
  const git = (...args) => { try { return execFileSync('git', ['-C', hub, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const tree = git('rev-parse', 'HEAD^{tree}'), head = git('rev-parse', 'HEAD');
  const id = newRunId(store, tree, now);
  const all = listRuns(store).map((r) => loadRun(store, r));
  const ledger = failureLedger(all);
  let runs = all, from = null;
  const mode = rerun ? 'rerun-failed' : restamp ? 'restamp' : 'full';
  if (rerun || restamp) {
    try { from = resolveRun(store, rerun || restamp, hub); } catch (error) { return refuse([`${mode === 'restamp' ? '--restamp' : '--rerun-failed'}: ${error.message}`]); }
    const cited = new Set([from.id, ...Object.values(from.receipt?.suites || {}).map((s) => s.run).filter(Boolean)]);
    runs = all.filter((r) => cited.has(r.id));
  }
  const decisions = {};
  for (const [suiteId, s] of Object.entries(suites)) {
    decisions[suiteId] = decide({ id: suiteId, key: s.key, hub: s.hub, runs, ledger, noCache, now, maxAgeMs });
  }
  const label = (suiteId) => labelOf(suites[suiteId].file);
  for (const [suiteId, d] of Object.entries(decisions)) {
    if (d.decision === 'blocked') d.refusal = refusal({ id: suiteId, key: suites[suiteId].key, own: suites[suiteId], shared, runs, ledger, label: label(suiteId) });
  }
  const why = (suiteId) => explain({ id: suiteId, key: suites[suiteId].key, own: suites[suiteId], shared, hub: suites[suiteId].hub, runs, now, maxAgeMs, ledger });

  if (rerun) {
    // Only what failed or did not finish there runs; a pass there that cannot
    // stand now is a refusal, never a silent rerun.
    const stale = [];
    for (const suiteId of Object.keys(suites)) {
      const fresh = from.results.filter((l) => l.suite === suiteId).at(-1);
      const passed = from.receipt?.suites?.[suiteId]?.result === 'reused' || (fresh && fresh.status === 'pass' && !fresh.flaky);
      if (passed && decisions[suiteId].decision !== 'reuse') stale.push(`  ${label(suiteId)}: ${why(suiteId)}`);
    }
    if (stale.length) return refuse([`--rerun-failed ${from.id}: ${stale.length} suite${stale.length === 1 ? '' : 's'} that passed there cannot be reused now; run the gate without it, which reruns exactly what changed:`, ...stale.slice(0, 20), ...(stale.length > 20 ? [`  and ${stale.length - 20} more`] : [])]);
  }
  if (restamp) {
    const missing = Object.keys(suites).filter((s) => decisions[s].decision !== 'reuse');
    if (missing.length) return refuse([`--restamp ${from.id}: ${missing.length} suite${missing.length === 1 ? ' has' : 's have'} no qualifying pass, so a stamp needs a run:`, ...missing.slice(0, 20).map((s) => `  ${label(s)}: ${decisions[s].decision === 'blocked' ? 'it failed twice on these inputs' : why(s)}`), ...(missing.length > 20 ? [`  and ${missing.length - 20} more`] : [])]);
  }

  // The run's record starts now: a gate that dies still leaves its keys.
  const runDir = path.join(store, id);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  // pid: the gate's own, so tools/gate-wait.sh finds this run from the pid a
  // detached launch recorded, also after the gate has ended
  const keys = { version: 1, run: id, checkout: hub, pid: gatePid, tree, head, createdAt: iso(now), mode, from: from?.id ?? null, noCache, shared, suites };
  fs.writeFileSync(path.join(runDir, 'keys.json'), JSON.stringify(keys, null, 1) + '\n');
  fs.copyFileSync(inputs, path.join(runDir, 'inputs.json'));
  fs.copyFileSync(path.join(gate, '.execution-plan.tsv'), path.join(runDir, 'plan.tsv'));
  fs.writeFileSync(path.join(runDir, 'env.json'), JSON.stringify(envBlock(env, manifest), null, 1) + '\n');
  try { pruneRuns(store, id, now); } catch { /* pruning is housekeeping */ }

  const reuse = { version: 1, store, run: id, runDir, mode, from: from?.id ?? null, noCache, tree, head, createdAt: iso(now),
    budget: RETRY_BUDGET, suites: {} };
  const counts = { reuse: 0, run: 0, blocked: 0 }, reasons = new Map();
  for (const [suiteId, s] of Object.entries(suites)) {
    const d = decisions[suiteId];
    reuse.suites[suiteId] = { key: s.key, ...d };
    counts[d.decision]++;
    if (d.decision !== 'run') continue;
    const reason = noCache ? '--no-cache' : why(suiteId);
    if (!reasons.has(reason)) reasons.set(reason, []);
    reasons.get(reason).push(label(suiteId));
  }
  reuse.toRun = counts.run;
  fs.writeFileSync(path.join(gate, '.reuse.json'), JSON.stringify(reuse, null, 1) + '\n');
  fs.writeFileSync(path.join(gate, '.reuse-to-run'), `${counts.run}\n`);

  out.push(`reuse: store ${store}; this run ${id}${from ? ` (${mode} from ${from.id})` : ''}`);
  out.push(`reuse: key = runtime ${short(shared.runtime)} + external ${short(shared.external)} + helpers ${short(shared.helpers)}` +
    ` + harness ${short(shared.harness)} + node ${shared.node} + playwright ${shared.playwright} + env ${short(shared.env)}` +
    ' + each suite\'s collected copy and registry entry (and the files its keyInputs name)');
  out.push(`reuse: ${counts.reuse} suite${counts.reuse === 1 ? '' : 's'} reused, ${counts.run} to run` +
    `${counts.blocked ? `, ${counts.blocked} refused (failed twice on these inputs)` : ''}`);
  for (const [suiteId, d] of Object.entries(decisions)) if (d.refusal) out.push(`reuse: refused ${label(suiteId)}: ${d.refusal}`);
  for (const [reason, names] of [...reasons].sort((a, b) => b[1].length - a[1].length)) out.push(`reuse: to run, ${reason}: ${listNames(names)}`);
  if (restamp) out.push(`reuse: restamp: every suite has a qualifying pass; nothing runs`);
  return { ok: true, out, active: true, reuse, keys };
}

// ---- the shared-state guard -------------------------------------------------------

export function snapshotData(dir) {
  const files = {};
  const walk = (abs, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const a = path.join(abs, entry.name), r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(a, r);
      else if (entry.isSymbolicLink()) { try { files[r] = `link:${fs.readlinkSync(a)}`; } catch { /* gone */ } }
      else if (entry.isFile()) files[r] = fileDigest(a) ?? 'unreadable';
      else files[r] = 'special';
    }
  };
  walk(dir, '');
  return files;
}
const globRegex = (pattern) => new RegExp(`^${pattern.split('**').map((part) => part.split('*')
  .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
const ALLOWED = GUARD_ALLOW.map(globRegex);
export const guardAllowed = (rel) => ALLOWED.some((re) => re.test(rel));
export function guardChanges(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((rel) => before[rel] !== after[rel] && !guardAllowed(rel)).sort();
}

// ---- the record and the receipt -------------------------------------------------

function tail(file, count = 20) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l, i, all) => l || i < all.length - 1).slice(-count); } catch { return []; }
}

export function recordRun({ gate, data = null, checks = {}, pass = null, fail = null, summary = null, now = Date.now() }) {
  const reuse = readJSON(path.join(gate, '.reuse.json'));
  const runDir = reuse.runDir, out = [];
  fs.mkdirSync(path.join(runDir, 'suites'), { recursive: true });
  const tally = readLines(path.join(gate, '.lane-results.tsv')).map((l) => l.split('\t'));
  const results = jsonLines(path.join(gate, 'results.jsonl'));

  let changed = [];
  const start = tryJSON(path.join(gate, '.guard-start.json'));
  if (start && data) {
    changed = guardChanges(start, snapshotData(data));
    if (changed.length) out.push(`guard: the shared hub's data changed during the run (${listNames(changed)}); this run's shared-reader passes will not be reused`);
  }

  for (const name of fs.readdirSync(gate)) {
    if (/\.out(?:\.attempt1)?$/.test(name) || name === 'server.log') {
      try { fs.copyFileSync(path.join(gate, name), path.join(runDir, 'suites', name)); } catch { /* best effort */ }
    }
  }

  const flakes = [];
  for (const line of results.filter((l) => l.status === 'pass' && l.flaky)) {
    const entry = reuse.suites[line.suite] || {};
    const first = line.attempt === 2
      ? results.find((l) => l.suite === line.suite && l.attempt === 1)
      : entry.lastFailure ? { ...entry.lastFailure, run: entry.lastFailure.run } : null;
    const firstOut = line.attempt === 2 ? path.join(gate, `${outputOf(line.file)}.attempt1`)
      : first?.run ? path.join(reuse.store, first.run, 'suites', outputOf(line.file)) : null;
    flakes.push({ at: iso(now), suite: line.suite, file: line.file, key: line.key, run: reuse.run,
      kind: line.attempt === 2 ? 'passed on retry' : 'passed after an earlier failure on these inputs',
      first: { run: line.attempt === 2 ? reuse.run : first?.run ?? null, seconds: first?.seconds ?? null, exit: first?.exit ?? null,
        endedAt: first?.endedAt ?? null, tail: firstOut ? tail(firstOut) : [] },
      pass: { run: reuse.run, seconds: line.seconds, endedAt: line.endedAt } });
  }
  if (flakes.length) fs.appendFileSync(path.join(reuse.store, 'flakes.jsonl'), flakes.map((f) => JSON.stringify(f)).join('\n') + '\n');

  const suites = {};
  for (const [state, , , id] of tally) {
    const entry = reuse.suites[id] || {};
    if (state === 'reused') { suites[id] = { result: 'reused', run: entry.from, endedAt: entry.endedAt }; continue; }
    const attempts = results.filter((l) => l.suite === id);
    suites[id] = { result: state, run: reuse.run, seconds: attempts.at(-1)?.seconds ?? null, attempts: attempts.length };
  }
  const values = Object.values(suites);
  const reused = values.filter((s) => s.result === 'reused');
  const flaky = values.filter((s) => s.result === 'flaky').length;
  const oldest = reused.map((s) => s.endedAt).filter(Boolean).sort()[0] ?? null;
  const receipt = { version: 1, run: reuse.run, mode: reuse.mode, from: reuse.from, noCache: reuse.noCache, tree: reuse.tree,
    head: reuse.head, startedAt: reuse.createdAt, composedAt: iso(now), pass, fail, green: fail === 0,
    checks: { inputs: checks.inputs || 'unknown', hub: checks.hub || 'unknown', execution: checks.execution || 'unknown' },
    guard: { changed }, counts: { suites: values.length, reused: reused.length, fresh: values.length - reused.length, flaky },
    oldestEvidence: oldest, suites };
  const age = oldest ? ` (${((now - Date.parse(oldest)) / 3600_000).toFixed(1)} h old)` : '';
  const line = `receipt: ${reused.length} reused, ${values.length - reused.length} run fresh${flaky ? ` (${flaky} FLAKY)` : ''}` +
    `${oldest ? `; oldest reused evidence ${oldest}${age}` : ''}; ${path.join(runDir, 'receipt.json')}`;
  // the gate's summary line and this receipt line, as printed: what
  // tools/gate-wait.sh repeats once the gate has ended
  receipt.summary = summary;
  receipt.line = line;
  const text = JSON.stringify(receipt, null, 1) + '\n';
  fs.writeFileSync(path.join(runDir, 'receipt.json'), text);
  fs.writeFileSync(path.join(gate, 'receipt.json'), text);
  out.push(line);
  return { out, receipt, flakes };
}

// --only: suite IDs or collected file names (x.test.mjs, x.js, or x) to IDs.
export function selectSuites(list, registry) {
  const ids = registry.suites.map((s) => s.id), chosen = [];
  for (const item of String(list).split(',').map((s) => s.trim()).filter(Boolean)) {
    const id = ids.find((x) => x === item) || [item, `${item}.test.mjs`, `${item}.js`].map((n) => ids.find((x) => path.basename(x) === n)).find(Boolean);
    if (!id) throw new Error(`unknown suite: ${item}`);
    if (!chosen.includes(id)) chosen.push(id);
  }
  if (!chosen.length) throw new Error('--only names no suite');
  return chosen;
}

// ---- the command line ------------------------------------------------------------

function main(argv) {
  const [command, ...rest] = argv;
  const option = (name) => { const at = rest.indexOf(name); return at < 0 ? null : rest[at + 1]; };
  const valued = new Set(['--rerun-failed', '--restamp', '--hub', '--registry', '--store', '--data', '--checks', '--pass', '--fail',
    '--gate-pid', '--summary']);
  const positional = rest.filter((arg, i) => !arg.startsWith('--') && !valued.has(rest[i - 1]));
  const registryFile = option('--registry') || path.join(HERE, 'registry.json');
  const print = (lines, stream = process.stdout) => { if (lines.length) stream.write(lines.join('\n') + '\n'); };
  if (command === 'plan') {
    const [gate, inputs] = positional;
    if (!gate || !inputs) throw new Error('usage: reuse.mjs plan <gate-dir> <inputs.json> [--no-cache] [--rerun-failed RUN | --restamp RUN]');
    const env = option('--store') ? { ...process.env, ERA_GATE_RUNS: option('--store') } : process.env;
    const result = planGate({ gate: path.resolve(gate), inputs: path.resolve(inputs), hub: option('--hub') ? path.resolve(option('--hub')) : undefined,
      registryFile, env, store: storeDir(env), noCache: rest.includes('--no-cache'), rerun: option('--rerun-failed'), restamp: option('--restamp'),
      gatePid: /^[1-9]\d*$/.test(option('--gate-pid') || '') ? Number(option('--gate-pid')) : null });
    print(result.out);
    if (!result.ok) { print(result.errors.map((l, i) => (i ? l : `FATAL: ${l}`)), process.stderr); return 1; }
    return 0;
  }
  if (command === 'guard') {
    const [data, file] = positional;
    if (!data || !file) throw new Error('usage: reuse.mjs guard <data-dir> <snapshot.json>');
    fs.writeFileSync(file, JSON.stringify(snapshotData(path.resolve(data))) + '\n');
    return 0;
  }
  if (command === 'record') {
    const [gate] = positional;
    if (!gate) throw new Error('usage: reuse.mjs record <gate-dir> [--data DIR] [--checks ...] [--pass N] [--fail N]');
    const checks = Object.fromEntries((option('--checks') || '').split(',').filter(Boolean).map((kv) => kv.split('=')));
    const number = (name) => (option(name) == null ? null : Number(option(name)));
    print(recordRun({ gate: path.resolve(gate), data: option('--data'), checks, pass: number('--pass'), fail: number('--fail'),
      summary: option('--summary') }).out);
    return 0;
  }
  if (command === 'select') {
    const [list, file] = positional;
    if (!list || !file) throw new Error('usage: reuse.mjs select <suite[,suite...]> <selection.json>');
    fs.writeFileSync(file, JSON.stringify(selectSuites(list, readJSON(registryFile))) + '\n');
    return 0;
  }
  throw new Error('usage: reuse.mjs plan|guard|record|select ...');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`FATAL: reuse: ${error.message}\n`); process.exitCode = 1; }
}
