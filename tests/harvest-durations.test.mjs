// harvest-durations.mjs turns green gate directories into the per-suite wall
// time table the lane scheduler orders by (plan item 0.3). Every case builds a
// synthetic gate directory in a temp dir and runs the tool as a child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/testing/harvest-durations.mjs');
const T0 = 1790000000; // fixed epoch seconds for synthetic mtimes
const STAMP = '2026-01-02T03:04:05.000Z';

const REGISTRY = {
  version: 1,
  suites: [
    { id: 'era-hub:tests/alpha.test.mjs' },
    { id: 'era-pencil:tests/pencil.js' },
    { id: 'era-making-words:tests/run.js' },
    { id: 'era-hub:tests/never-ran.test.mjs' },
  ],
};

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-harvest-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify(REGISTRY));
  return { dir, registry };
}

const tap = (ms, { fail = 0 } = {}) =>
  `TAP version 13\nok 1 - works\n  ---\n  duration_ms: 1.5\n  ...\n${fail ? 'not ok 2 - breaks\n' : ''}` +
  `1..${1 + fail}\n# tests ${1 + fail}\n# suites 0\n` +
  `# pass 1\n# fail ${fail}\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms ${ms}\n`;
const receipt = (passed, failed = 0) => `A) something\n  PASS  it works\n\n${passed} passed, ${failed} failed\n`;

// outputs: [{ name: 'alpha.test.mjs' | 'pencil.js', text, mtime }]
function gate(dir, outputs, { plan = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (plan !== null) {
    const file = path.join(dir, '.execution-plan.tsv');
    fs.writeFileSync(file, outputs.map(o => `x:tests/${o.name}\t${o.name}\tdigest`).join('\n') + '\n');
    fs.utimesSync(file, plan, plan);
  }
  for (const o of outputs) {
    fs.writeFileSync(path.join(dir, o.name), '// suite copy\n');
    const out = path.join(dir, o.name.replace(/\.(?:mjs|js)$/, '.out'));
    if (o.text === null) continue; // planned but never produced output
    fs.writeFileSync(out, o.text);
    fs.utimesSync(out, o.mtime, o.mtime);
  }
  return dir;
}

function job(root, id, status, outputs, options) {
  const jobDir = path.join(root, 'jobs', id);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'status.json'), JSON.stringify({ status }));
  return gate(path.join(jobDir, 'workspace', 'era-hub', 'gate'), outputs, options);
}

// Run A: a legacy serial gate dir with a frozen plan; run.js is first and is
// anchored by the plan's mtime. Run B: a passed parallel job without a plan
// (older gate), so its first suite has no anchor and yields no sample.
function greenRuns(dir) {
  const a = gate(path.join(dir, 'era-hub--wt-a', 'gate'), [
    { name: 'run.js', text: receipt(28), mtime: T0 + 10 },
    { name: 'pencil.js', text: receipt(24), mtime: T0 + 40 },
    { name: 'alpha.test.mjs', text: tap(2000), mtime: T0 + 42 },
    { name: 'zeta.test.mjs', text: tap(500), mtime: T0 + 43 },
  ], { plan: T0 });
  const b = job(dir, 'gate-b', 'passed', [
    { name: 'run.js', text: receipt(28), mtime: T0 + 1012 },
    { name: 'pencil.js', text: receipt(24), mtime: T0 + 1062 },
    { name: 'alpha.test.mjs', text: tap(4000), mtime: T0 + 1066 },
  ]);
  return [a, b];
}

const EXPECTED_SUITES = {
  'era-hub:tests/alpha.test.mjs': { max_s: 4, mean_s: 3, median_s: 3, min_s: 2, samples: 2, source: 'tap' },
  'era-making-words:tests/run.js': { max_s: 10, mean_s: 10, median_s: 10, min_s: 10, samples: 1, source: 'mtime' },
  'era-pencil:tests/pencil.js': { max_s: 50, mean_s: 40, median_s: 40, min_s: 30, samples: 2, source: 'mtime' },
};

function harvest(registry, args, env = {}) {
  const result = spawnSync(process.execPath, [TOOL, '--registry', registry, '--generated-at', STAMP, ...args],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  return result;
}

test('two green runs yield medians, sample counts, mtime-sourced legacy times and default_s', t => {
  const { dir, registry } = scratch(t);
  const out = path.join(dir, 'durations.json');
  const result = harvest(registry, ['--out', out, ...greenRuns(dir)]);
  assert.equal(result.status, 0, result.stderr);
  const table = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(table.suites, EXPECTED_SUITES);
  assert.equal(table.default_s, 17.667); // mean of medians 3, 10, 40
  assert.equal(table.generatedAt, STAMP);
  assert.equal(table.sources.length, 2);
  assert.match(result.stderr, /registry suite has no sample: era-hub:tests\/never-ran\.test\.mjs/);
  assert.match(result.stderr, /sample has no registry entry: zeta\.test\.mjs/);
});

test('red, unfinished and unknown-status runs contribute nothing', t => {
  const { dir, registry } = scratch(t);
  const red = [
    job(dir, 'gate-failed', 'failed', [{ name: 'alpha.test.mjs', text: tap(99000), mtime: T0 + 5000 }]),
    job(dir, 'gate-nostatus', 'passed', [{ name: 'alpha.test.mjs', text: tap(99000), mtime: T0 + 5000 }]),
    gate(path.join(dir, 'tap-red', 'gate'), [{ name: 'alpha.test.mjs', text: tap(99000, { fail: 1 }), mtime: T0 + 6000 }]),
    gate(path.join(dir, 'legacy-red', 'gate'), [
      { name: 'alpha.test.mjs', text: tap(99000), mtime: T0 + 7000 },
      { name: 'pencil.js', text: receipt(23, 1), mtime: T0 + 7500 },
    ]),
    gate(path.join(dir, 'unfinished', 'gate'), [
      { name: 'alpha.test.mjs', text: tap(99000), mtime: T0 + 8000 },
      { name: 'pencil.js', text: null },
    ], { plan: T0 + 7900 }),
  ];
  fs.rmSync(path.join(dir, 'jobs', 'gate-nostatus', 'status.json'));
  const out = path.join(dir, 'durations.json');
  const result = harvest(registry, ['--out', out, ...greenRuns(dir), ...red]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).suites, EXPECTED_SUITES);
  assert.equal((result.stderr.match(/^skip /gm) || []).length, red.length, result.stderr);
});

test('a symlinked alias of a gate dir is counted once', t => {
  const { dir, registry } = scratch(t);
  const [a, b] = greenRuns(dir);
  const alias = path.join(dir, 'jobs', 'gate-b', 'workspace', 'era-hub--wt-b');
  fs.symlinkSync('era-hub', alias);
  const out = path.join(dir, 'durations.json');
  const result = harvest(registry, ['--out', out, a, b, path.join(alias, 'gate')]);
  assert.equal(result.status, 0, result.stderr);
  const table = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(table.suites, EXPECTED_SUITES);
  assert.equal(table.sources.length, 2);
});

test('output is byte-identical across runs and argument order, with sorted keys', t => {
  const { dir, registry } = scratch(t);
  const dirs = greenRuns(dir);
  const first = path.join(dir, 'first.json'), second = path.join(dir, 'second.json');
  const r1 = harvest(registry, ['--out', first, ...dirs]);
  const r2 = harvest(registry, ['--out', second, ...[...dirs].reverse()]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);
  const text = fs.readFileSync(first, 'utf8');
  assert.equal(fs.readFileSync(second, 'utf8'), text);
  const sortKeys = value => Array.isArray(value) ? value.map(sortKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;
  assert.equal(text, JSON.stringify(sortKeys(JSON.parse(text)), null, 2) + '\n');
});

test('results.jsonl passes add samples; other statuses are ignored; mixed sources report the weaker', t => {
  const { dir, registry } = scratch(t);
  const results = path.join(dir, 'results.jsonl');
  fs.writeFileSync(results, [
    { suite: 'era-hub:tests/never-ran.test.mjs', status: 'pass', seconds: 7 },
    { suite: 'era-hub:tests/never-ran.test.mjs', status: 'pass', seconds: 9 },
    { suite: 'era-hub:tests/never-ran.test.mjs', status: 'fail', seconds: 900 },
    { suite: 'era-pencil:tests/pencil.js', status: 'passed', seconds: 60 },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  const out = path.join(dir, 'durations.json');
  const result = harvest(registry, ['--out', out, '--results', results, ...greenRuns(dir)]);
  assert.equal(result.status, 0, result.stderr);
  const table = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(table.suites['era-hub:tests/never-ran.test.mjs'],
    { max_s: 9, mean_s: 8, median_s: 8, min_s: 7, samples: 2, source: 'results' });
  assert.deepEqual(table.suites['era-pencil:tests/pencil.js'],
    { max_s: 60, mean_s: 46.667, median_s: 50, min_s: 30, samples: 3, source: 'mtime' });
  assert.doesNotMatch(result.stderr, /no sample: era-hub:tests\/never-ran/);
});

test('nothing qualifying leaves the existing table untouched and exits non-zero', t => {
  const { dir, registry } = scratch(t);
  const out = path.join(dir, 'durations.json');
  fs.writeFileSync(out, 'previous\n');
  const red = job(dir, 'gate-failed', 'failed', [{ name: 'alpha.test.mjs', text: tap(99000), mtime: T0 }]);
  const result = harvest(registry, ['--out', out, red]);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), 'previous\n');
  assert.match(result.stderr, /no qualifying samples/);
});
