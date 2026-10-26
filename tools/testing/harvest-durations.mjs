#!/usr/bin/env node
// harvest-durations.mjs: per-suite wall times from green gate directories, for
// the lane scheduler's longest-first order and the result store (plan 0.3).
//
//   node tools/testing/harvest-durations.mjs [--out tools/testing/durations.json]
//     [--registry FILE] [--results results.jsonl]... [--generated-at ISO] <gate-dir>...
//
// A gate dir is what tools/era-gate.sh leaves in <hub>/gate: collected suite
// copies beside their outputs (X.test.mjs -> X.test.out, legacy X.js -> X.out).
// A parallel job's gate (<job>/workspace/<hub>/gate) counts only when the job's
// status.json says "passed". Every dir must also be green by the parallel
// validator's own output rules and, when .execution-plan.tsv exists, complete;
// otherwise the whole run is skipped, since a red run's times are not
// representative. Symlinked aliases of one dir count once.
//
// node --test suites report their trailer `# duration_ms <n>` (source "tap").
// Legacy scripts have none: the gate runs suites strictly in series, so a
// script's wall time is its .out mtime minus the previous suite .out's mtime,
// or minus .execution-plan.tsv's mtime for the first suite (source "mtime",
// lower confidence; no anchor, no sample). --results reads one JSON object per
// line ({suite, status, seconds}); only "pass"/"passed" lines count.
//
// Output keys are sorted at every level, so the table diffs cleanly; pass
// --generated-at to pin the only field that otherwise changes between runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RANK = { tap: 0, results: 1, mtime: 2 }; // higher = lower confidence
const USAGE = 'usage: harvest-durations.mjs [--out FILE] [--registry FILE] [--results FILE]... ' +
  '[--generated-at ISO] <gate-dir>...';

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { out: null, registry: path.join(HERE, 'registry.json'), results: [], generatedAt: null, dirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--out') opts.out = value();
    else if (arg === '--registry') opts.registry = value();
    else if (arg === '--results') opts.results.push(value());
    else if (arg === '--generated-at') opts.generatedAt = value();
    else if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
    else opts.dirs.push(arg);
  }
  if (!opts.dirs.length && !opts.results.length) throw new UsageError('name at least one gate dir or --results file');
  const stamp = new Date(opts.generatedAt ?? Date.now());
  if (Number.isNaN(stamp.getTime())) throw new UsageError('--generated-at must be a date');
  opts.generatedAt = stamp.toISOString();
  return opts;
}

const lastMatch = (text, pattern) => [...text.matchAll(pattern)].at(-1);
const tapCount = (text, key) => {
  const match = lastMatch(text, new RegExp(`^# ${key} (\\d+)$`, 'gm'));
  return match ? Number(match[1]) : null;
};

// The same green rules tools/testing/parallel-snapshot.mjs applies to outputs.
function tapSeconds(text) {
  const trailer = lastMatch(text, /^# duration_ms (\d+(?:\.\d+)?)$/gm);
  const green = tapCount(text, 'pass') >= 1 && tapCount(text, 'fail') === 0 &&
    tapCount(text, 'cancelled') === 0 && !/^\s*not ok\b/m.test(text);
  return green && trailer ? Number(trailer[1]) / 1000 : null;
}
function legacyGreen(text) {
  const receipt = lastMatch(text, /(\d+) passed,\s*(\d+) failed/g);
  return Boolean(receipt) && Number(receipt[1]) >= 1 && Number(receipt[2]) === 0;
}

function jobStatus(real) {
  const workspace = path.dirname(path.dirname(real));
  if (path.basename(workspace) !== 'workspace') return null; // a legacy serial gate dir
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(workspace), 'status.json'), 'utf8')).status ?? 'unknown'; }
  catch { return 'unknown'; }
}

// -> { samples: [{ name, seconds, source }] } or { skip: reason }
function readGate(real) {
  const status = jobStatus(real);
  if (status !== null && status !== 'passed') return { skip: `job status ${status}` };
  const outputs = [];
  for (const file of fs.readdirSync(real).filter(name => name.endsWith('.out')).sort()) {
    const stem = file.slice(0, -'.out'.length);
    const modern = stem.endsWith('.test') && fs.existsSync(path.join(real, `${stem}.mjs`));
    const name = modern ? `${stem}.mjs` : `${stem}.js`;
    if (!modern && !fs.existsSync(path.join(real, name))) continue; // not a suite output
    const full = path.join(real, file);
    const text = fs.readFileSync(full, 'utf8');
    const seconds = modern ? tapSeconds(text) : null;
    if (modern ? seconds === null : !legacyGreen(text)) return { skip: `red or incomplete output: ${name}` };
    outputs.push({ name, modern, seconds, mtime: fs.statSync(full).mtimeMs });
  }
  if (!outputs.length) return { skip: 'no suite outputs' };
  const planFile = path.join(real, '.execution-plan.tsv');
  let anchor = null;
  if (fs.existsSync(planFile)) {
    const planned = fs.readFileSync(planFile, 'utf8').split('\n').filter(Boolean).map(line => line.split('\t')[1]);
    const produced = new Set(outputs.map(output => output.name));
    const missing = planned.filter(name => !produced.has(name));
    if (missing.length) return { skip: `incomplete: ${missing.length} of ${planned.length} planned suites have no output` };
    anchor = fs.statSync(planFile).mtimeMs;
  }
  outputs.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : 1));
  const samples = [];
  let previous = anchor;
  for (const output of outputs) {
    if (output.modern) samples.push({ name: output.name, seconds: output.seconds, source: 'tap' });
    else if (previous !== null && output.mtime > previous) {
      samples.push({ name: output.name, seconds: (output.mtime - previous) / 1000, source: 'mtime' });
    }
    previous = output.mtime;
  }
  return { samples };
}

function readResults(file) {
  const samples = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    let row;
    try { row = JSON.parse(line); } catch { throw new Error(`${file}:${index + 1}: not JSON`); }
    if (row.status !== 'pass' && row.status !== 'passed') return;
    const name = row.suite ?? row.id;
    if (typeof name !== 'string' || !Number.isFinite(row.seconds) || row.seconds <= 0) {
      throw new Error(`${file}:${index + 1}: a pass needs suite and positive seconds`);
    }
    samples.push({ name, seconds: row.seconds, source: 'results' });
  });
  return samples;
}

const round = value => Math.round(value * 1000) / 1000;
const shown = file => {
  const home = os.homedir();
  return file === home || file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file;
};
const sortKeys = value => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;

function main(argv) {
  const opts = parseArgs(argv);
  const registry = JSON.parse(fs.readFileSync(opts.registry, 'utf8'));
  const ids = new Set(registry.suites.map(suite => suite.id));
  const byBasename = new Map([...ids].map(id => [id.replace(/^[^:]+:tests\//, ''), id]));
  const resolve = name => ids.has(name) ? name : byBasename.get(name);

  const collected = [], sources = new Set(), seen = new Set(), skipped = [];
  for (const dir of opts.dirs) {
    let real;
    try { real = fs.realpathSync(dir); } catch { skipped.push([dir, 'missing']); continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    const run = readGate(real);
    if (run.skip) { skipped.push([real, run.skip]); continue; }
    collected.push(...run.samples);
    sources.add(shown(real));
  }
  for (const file of opts.results) {
    collected.push(...readResults(file));
    sources.add(shown(fs.realpathSync(file)));
  }
  for (const [dir, reason] of skipped) process.stderr.write(`skip ${shown(dir)}: ${reason}\n`);

  const bySuite = new Map(), unknown = new Map();
  for (const sample of collected) {
    const id = resolve(sample.name);
    if (!id) { unknown.set(sample.name, (unknown.get(sample.name) ?? 0) + 1); continue; }
    if (!bySuite.has(id)) bySuite.set(id, []);
    bySuite.get(id).push(sample);
  }
  if (!bySuite.size) {
    process.stderr.write('FATAL: no qualifying samples; table left unchanged\n');
    return 1;
  }
  for (const id of [...ids].sort()) if (!bySuite.has(id)) process.stderr.write(`warning: registry suite has no sample: ${id}\n`);
  for (const name of [...unknown.keys()].sort()) {
    process.stderr.write(`warning: sample has no registry entry: ${name} (${unknown.get(name)} samples)\n`);
  }

  const suites = {}, medians = [];
  for (const [id, samples] of bySuite) {
    const values = samples.map(sample => sample.seconds).sort((a, b) => a - b);
    const mid = values.length >> 1;
    const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    medians.push(median);
    suites[id] = {
      median_s: round(median),
      mean_s: round(values.reduce((sum, value) => sum + value, 0) / values.length),
      min_s: round(values[0]),
      max_s: round(values.at(-1)),
      samples: values.length,
      source: samples.map(sample => sample.source).reduce((a, b) => RANK[b] > RANK[a] ? b : a),
    };
  }
  const table = sortKeys({
    generatedAt: opts.generatedAt,
    sources: [...sources].sort(),
    suites,
    default_s: round(medians.reduce((sum, value) => sum + value, 0) / medians.length),
  });
  const text = JSON.stringify(table, null, 2) + '\n';
  if (!opts.out) { process.stdout.write(text); return 0; }
  const temporary = `${opts.out}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, opts.out);
  process.stdout.write(`durations: ${bySuite.size} suites from ${sources.size} sources ` +
    `(${skipped.length} skipped) -> ${opts.out}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(error instanceof UsageError ? `${error.message}\n${USAGE}\n` : `FATAL: ${error.message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
