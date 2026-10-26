import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveSources, captureOrigins, freezeSeed, prepareSnapshot, verifyOrigins,
  validateGateResults, promoteStamps } from '../parallel-snapshot.mjs';

const REPOS = ['era-core', 'era-making-words', 'era-pencil', 'era-board', 'era-gaze', 'era-hub'];
const LEGACY = ['run','parts','transfer','mistakes','pencil','narrow','sortfix',
  'fltest','bargein','sortbugs','rhymecount','transfercount','phonetic'];
function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'era-parallel-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputs = path.join(root, 'inputs');
  fs.mkdirSync(inputs);
  for (const repo of REPOS) {
    const directory = path.join(inputs, repo);
    fs.mkdirSync(directory);
    git(directory, 'init', '-q');
    fs.writeFileSync(path.join(directory, 'identity.txt'), repo);
    fs.writeFileSync(path.join(directory, '.gitignore'), 'gate/\npublic/\n');
    if (repo !== 'era-gaze') {
      fs.mkdirSync(path.join(directory, 'tests'));
      fs.writeFileSync(path.join(directory, 'tests', repo + '.test.mjs'), '// fixture test\n');
    }
    for (const name of LEGACY.filter(name => repo === (name === 'pencil' ? 'era-pencil' : 'era-making-words'))) {
      fs.writeFileSync(path.join(directory, 'tests', name + '.js'), '// legacy fixture\n');
    }
    if (repo === 'era-hub') {
      fs.mkdirSync(path.join(directory, 'tools'));
      fs.writeFileSync(path.join(directory, 'tools/era-gate.sh'), `#!/bin/bash
for repo in era-core era-making-words era-pencil era-board era-hub; do :; done
for t in ${LEGACY.join(' ')}; do :; done
for t in *.test.mjs; do node --test "$t"; done
`);
    }
    git(directory, 'add', '.');
    git(directory, 'commit', '-qm', 'Initial fixture');
  }
  const hub = path.join(inputs, 'era-hub');
  const baseline = git(hub, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(hub, 'tests/history.test.mjs'), `// git show historical fixture ${baseline}\n`);
  git(hub, 'add', '.'); git(hub, 'commit', '-qm', 'History fixture');
  const seedDir = path.join(inputs, 'era-family/test-data');
  fs.mkdirSync(path.join(seedDir, 'content'), { recursive: true });
  fs.mkdirSync(path.join(seedDir, 'logs'));
  fs.writeFileSync(path.join(seedDir, 'logs/churn.jsonl'), 'temporary log');
  fs.writeFileSync(path.join(seedDir, 'content/lessons.json'), '{"lessons":[]}');
  fs.writeFileSync(path.join(seedDir, 'tts-config.json'), JSON.stringify({ apiKey: 'credential-fixture', enabled: true }));
  fs.writeFileSync(path.join(seedDir, 'profile.json'), JSON.stringify({ childName: 'Fixture', email: 'fixture@example.invalid', tz: 'UTC' }));
  return { root, inputs, hub, seedDir, baseline, workspace: path.join(root, 'job/workspace') };
}
function outputs(manifest) {
  const directory = path.join(manifest.hub, 'gate');
  fs.mkdirSync(directory, { recursive: true });
  const summary = `== era-gate: ${manifest.expectedSuites.length} passed, 0 failed ==`;
  const lines = [];
  for (const suite of manifest.expectedSuites) {
    lines.push(`PASS ${suite.kind === 'legacy' ? suite.basename.slice(0, -3) : suite.basename}`);
    const file = path.join(directory, suite.basename.replace(/\.(?:mjs|js)$/, '.out'));
    fs.writeFileSync(file, suite.kind === 'legacy' ? '3 passed, 0 failed\n' :
      'TAP version 13\nok 1 - fixture behavior\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n');
  }
  const gateLog = path.join(path.dirname(manifest.workspace), 'gate.log');
  fs.writeFileSync(gateLog, lines.join('\n') + '\n' + summary + '\n');
  const stampsDir = path.join(path.dirname(manifest.workspace), 'stamps');
  fs.mkdirSync(stampsDir);
  const repos = manifest.suffix ? REPOS : ['era-hub'];
  for (const repo of repos) {
    const origin = manifest.origins[repo];
    const extra = repo === 'era-hub' ? '' : `repo=${path.join(manifest.workspace, repo + manifest.suffix)}\n`;
    fs.writeFileSync(path.join(stampsDir, origin.tree), `${summary}\nhead=${origin.head}\nat=${Math.floor(Date.now()/1000)}\nhub=${manifest.hub}\n${extra}`);
  }
  return { manifest, workspace: manifest.workspace, gateExitCode: 0, stampsDir, gateLog };
}

test('snapshot pins six clean origins, canonical aliases, complete history and sanitized seed', t => {
  const f = fixture(t);
  const sources = resolveSources(f.hub, { suffix: '--wt-unit' });
  const first = captureOrigins(sources, { seedDir: f.seedDir, suffix: '--wt-unit' });
  assert.equal(first.hash, captureOrigins(sources, { seedDir: f.seedDir, suffix: '--wt-unit' }).hash);
  const manifest = prepareSnapshot({ ...f, suffix: '--wt-unit' });
  assert.equal(manifest.hash, first.hash);
  assert.equal(manifest.expectedSuites.length, 19);
  for (const repo of REPOS) {
    assert.equal(fs.realpathSync(path.join(f.workspace, repo + '--wt-unit')), path.join(f.workspace, repo));
    assert.equal(git(path.join(f.workspace, repo), 'rev-parse', 'HEAD'), first.origins[repo].head);
    assert.equal(fs.existsSync(path.join(f.workspace, repo, '.git/objects/info/alternates')), false);
  }
  assert.equal(git(manifest.hub, 'show', f.baseline + ':identity.txt'), 'era-hub');
  assert.equal(JSON.parse(fs.readFileSync(path.join(manifest.seedDir, 'tts-config.json'))).apiKey, undefined);
  assert.equal(fs.existsSync(path.join(manifest.seedDir, 'logs')), false);
  assert.match(fs.readFileSync(path.join(f.seedDir, 'tts-config.json'), 'utf8'), /credential-fixture/);
  assert.equal(manifest.environment.ERA_DATA_DIR, manifest.seedDir);
  assert.equal(verifyOrigins(manifest).valid, true);
});

test('dirty inputs are refused before snapshot files are created', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.hub, 'identity.txt'), ' changed');
  assert.throws(() => prepareSnapshot(f), /dirty/i);
  assert.equal(fs.existsSync(f.workspace), false);
});

test('an origin head move invalidates an existing snapshot', t => {
  const f = fixture(t), manifest = prepareSnapshot(f);
  fs.appendFileSync(path.join(f.hub, 'identity.txt'), ' next');
  git(f.hub, 'add', '.'); git(f.hub, 'commit', '-qm', 'Next fixture');
  assert.equal(verifyOrigins(manifest).valid, false);
});

test('live-data paths and seed symlinks are refused', t => {
  const f = fixture(t);
  const live = path.join(f.inputs, 'era-family/data');
  fs.mkdirSync(live);
  assert.throws(() => prepareSnapshot({ ...f, seedDir: live }), /live data/i);
  fs.symlinkSync(path.join(f.seedDir, 'content/lessons.json'), path.join(f.seedDir, 'alias'));
  assert.throws(() => prepareSnapshot(f), /symlink/i);
});

test('new feature tests join the actual collector inventory and missing legacy coverage fails', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.hub, 'tests/new-feature.test.mjs'), '// additional candidate coverage');
  git(f.hub, 'add', '.'); git(f.hub, 'commit', '-qm', 'Add candidate suite');
  assert.ok(prepareSnapshot(f).expectedSuites.some(suite => suite.id === 'era-hub:tests/new-feature.test.mjs'));
  fs.unlinkSync(path.join(f.inputs, 'era-pencil/tests/pencil.js'));
  git(path.join(f.inputs, 'era-pencil'), 'add', '.');
  git(path.join(f.inputs, 'era-pencil'), 'commit', '-qm', 'Remove required fixture');
  assert.throws(() => prepareSnapshot({ ...f, workspace: path.join(f.root, 'other/workspace') }), /legacy|missing/i);
});

test('full outputs and genuine stamps validate and expose unchanged bytes only inside the job', t => {
  const f = fixture(t), manifest = prepareSnapshot({ ...f, suffix: '--wt-unit' });
  const result = outputs(manifest), checked = validateGateResults(result);
  assert.equal(checked.valid, true, checked.reasons.join('; '));
  const destination = path.join(path.dirname(f.workspace), 'exposed-stamps');
  const promoted = promoteStamps({ ...result, destination });
  assert.equal(promoted.length, REPOS.length);
  for (const file of promoted) assert.deepEqual(fs.readFileSync(file), fs.readFileSync(path.join(result.stampsDir, path.basename(file))));
  assert.throws(() => promoteStamps({ ...result, destination: path.join(f.root, 'global-stamps') }), /destination|job/i);
});

test('missing suite output or execution evidence prevents exposure even with a green gate summary', t => {
  const f = fixture(t), manifest = prepareSnapshot(f), result = outputs(manifest);
  const suite = manifest.expectedSuites.find(suite => suite.kind === 'modern');
  fs.unlinkSync(path.join(manifest.hub, 'gate', suite.basename.replace(/\.mjs$/, '.out')));
  assert.equal(validateGateResults(result).valid, false);
  assert.throws(() => promoteStamps({ ...result, destination: path.join(path.dirname(f.workspace), 'exposed-stamps') }), /invalid|missing|output/i);
});

test('root permission and missing-network skips cannot become accepted full evidence', t => {
  const f = fixture(t), manifest = prepareSnapshot(f), result = outputs(manifest);
  const suite = manifest.expectedSuites.find(suite => suite.kind === 'modern');
  fs.writeFileSync(path.join(manifest.hub, 'gate', suite.basename.replace(/\.mjs$/, '.out')),
    'TAP version 13\nok 1 - permission behavior # SKIP root writes every directory\n# tests 1\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n');
  const checked = validateGateResults(result);
  assert.equal(checked.valid, false);
  assert.match(checked.reasons.join('; '), /permission|skip/i);
});

test('private scanner parity uses only the pinned approved scanner fixture', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.hub, 'tests/era-scan-parity.test.mjs'), '// scanner parity fixture');
  git(f.hub, 'add', '.'); git(f.hub, 'commit', '-qm', 'Scanner parity fixture');
  const scanner = path.join(f.inputs, 'era-family/tools/era-scan.sh');
  fs.mkdirSync(path.dirname(scanner));
  fs.writeFileSync(scanner, '#!/bin/bash\nPATTERNS=fixture\n');
  fs.writeFileSync(path.join(f.inputs, 'era-family/gate-env.sh'), 'PRIVATE_CONFIGURATION=credential-fixture\n');
  const manifest = prepareSnapshot(f);
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'era-family/tools/era-scan.sh')), fs.readFileSync(scanner));
  assert.equal(fs.existsSync(path.join(f.workspace, 'era-family/gate-env.sh')), false);
  fs.appendFileSync(scanner, '# changed\n');
  assert.equal(verifyOrigins(manifest).valid, false);
});

test('existing exposure symlinks cannot redirect writes into an original source', t => {
  const f = fixture(t), manifest = prepareSnapshot(f), result = outputs(manifest);
  const destination = path.join(path.dirname(f.workspace), 'exposed-stamps');
  fs.mkdirSync(destination);
  const original = path.join(f.hub, 'identity.txt'), before = fs.readFileSync(original);
  fs.symlinkSync(original, path.join(destination, manifest.origins['era-hub'].tree));
  assert.throws(() => promoteStamps({ ...result, destination }), /symlink|existing|destination/i);
  assert.deepEqual(fs.readFileSync(original), before);
});

test('queued seed freeze is independent of subsequent legacy seed mutations', t => {
  const f = fixture(t), sources = resolveSources(f.hub);
  const frozen = freezeSeed({ seedDir: f.seedDir, sources, destination: path.join(f.root, 'job/seed-parent/test-data') });
  const captured = captureOrigins(sources, { seedDir: frozen.path });
  fs.writeFileSync(path.join(f.seedDir, 'content/lessons.json'), '{"lessons":["later"]}');
  assert.equal(verifyOrigins(captured).valid, true);
  assert.equal(frozen.digest, captured.seed.digest);
  assert.match(fs.readFileSync(path.join(frozen.path, 'content/lessons.json'), 'utf8'), /"lessons":\[\]/);
});

test('full acceptance rejects every skipped or todo modern case', t => {
  const f = fixture(t), manifest = prepareSnapshot(f), result = outputs(manifest);
  const suite = manifest.expectedSuites.find(suite => suite.kind === 'modern');
  const file = path.join(manifest.hub, 'gate', suite.basename.replace(/\.mjs$/, '.out'));
  for (const kind of ['SKIP', 'TODO']) {
    fs.writeFileSync(file, `TAP version 13\nok 1 - fixture behavior\nok 2 - deferred fixture # ${kind} optional\n# tests 2\n# pass 1\n# fail 0\n# cancelled 0\n# skipped ${kind === 'SKIP' ? 1 : 0}\n# todo ${kind === 'TODO' ? 1 : 0}\n`);
    assert.equal(validateGateResults(result).valid, false);
  }
});
