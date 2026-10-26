// Exercise gate guards without taking the real gate lock or starting an app hub.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = fs.readFileSync(path.join(HUB, 'tools/era-gate.sh'), 'utf8');
const names = ['gate_error', 'gate_capabilities', 'gate_acquire_lock', 'gate_validate_port', 'gate_export_test_data',
  'gate_prepare_owned_data', 'gate_refresh_data_links', 'gate_refresh_farm',
  'gate_port_available', 'gate_process_identity', 'gate_process_matches',
  'gate_wait_process', 'gate_cleanup_server', 'gate_listener_owned', 'gate_wait_server', 'gate_build_clothing',
  'gate_collect_entry',
  'gate_collect_suites', 'gate_prepare_selection', 'gate_suite_selected',
  'gate_freeze_execution', 'gate_record_execution', 'gate_verify_execution'];
function functions() {
  return names.map(name => {
    const found = gate.match(new RegExp(`^${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm'));
    assert.ok(found, `gate defines ${name}`);
    return found[0];
  }).join('\n');
}
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-gate-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(script, env = {}) {
  return spawnSync('bash', ['-c', `set -uo pipefail\n${functions()}\n${script}`], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000,
  });
}
function ok(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function refused(result, reason) {
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, reason);
}

test('the gate capability query describes inherited lock support without running a gate', () => {
  const result = run('gate_capabilities');
  ok(result);
  assert.deepEqual(JSON.parse(result.stdout), { inheritedGateLock: 1 });
});

test('a valid inherited lock keeps the same exclusively leased open description', t => {
  const root = scratch(t), lock = path.join(root, 'lock');
  ok(run(`
exec 7>"$LOCK"
flock -x 7 || exit
gate_acquire_lock || exit
if flock -n "$LOCK" -c :; then exit 84; fi
`, { LOCK: lock, ERA_GATE_LOCK_FD: '7' }));
});

test('an inherited descriptor for another inode is refused', t => {
  const root = scratch(t), lock = path.join(root, 'lock');
  fs.writeFileSync(lock, '');
  refused(run('exec 7>"$OTHER_LOCK"\nflock -x 7\ngate_acquire_lock', {
    LOCK: lock, OTHER_LOCK: path.join(root, 'other-lock'), ERA_GATE_LOCK_FD: '7',
  }), /inherited.*lock|lock.*descriptor/i);
});

test('an unleased inherited descriptor cannot bypass a competing exclusive lock', t => {
  const root = scratch(t), lock = path.join(root, 'lock');
  refused(run('exec 7>"$LOCK"\nexec 8>"$LOCK"\nflock -x 8\ngate_acquire_lock', {
    LOCK: lock, ERA_GATE_LOCK_FD: '7',
  }), /inherited.*lock|lock.*lease/i);
});

test('invalid inherited lock descriptor values fail without opening a fallback lock', t => {
  const root = scratch(t), lock = path.join(root, 'lock');
  for (const fd of ['2', '-1', 'unknown', '7; exit 0', '999999']) {
    refused(run('gate_acquire_lock', { LOCK: lock, ERA_GATE_LOCK_FD: fd }), /inherited.*lock|lock.*descriptor/i);
  }
  assert.equal(fs.existsSync(lock), false);
});

test('the shared gate port accepts only its dedicated port and approved manual range', () => {
  for (const port of ['8378', ...Array.from({ length: 10 }, (_, i) => String(8380 + i))]) {
    ok(run('gate_validate_port "$PORT"', { PORT: port }));
  }
  for (const port of ['', String(8300 + 77), '8379', '8390', '8425', '8427', '8451', '0', '65536',
    '08378', '8378x', '8378; exit 0']) {
    refused(run('gate_validate_port "$PORT"', { PORT: port }), /test port/i);
  }
});

test('the test data path is canonical and exported to suite subprocesses', t => {
  const root = scratch(t);
  const data = path.join(root, 'era-family', 'test-data');
  fs.mkdirSync(data, { recursive: true });
  const result = run('gate_export_test_data || exit; bash -c \'printf "%s" "$ERA_DATA_DIR"\'', {
    ROOT: root, HUB: path.join(root, 'era-hub--wt-test'), DATA: data + '/../test-data',
  });
  ok(result);
  assert.equal(result.stdout, data);
});

test('live data, descendants and symlink aliases are rejected before execution', t => {
  const root = scratch(t);
  const live = path.join(root, 'era-family', 'data');
  fs.mkdirSync(live, { recursive: true });
  const alias = path.join(root, 'alias');
  fs.symlinkSync(live, alias);
  for (const data of [live, live + '/child', alias, path.join(root, 'era-hub', 'data'), root]) {
    refused(run('gate_export_test_data', {
      ROOT: root, HUB: path.join(root, 'era-hub--wt-test'), DATA: data,
    }), /live data|unsafe data/i);
  }
});

test('an occupied listener is refused and left running', async t => {
  const server = http.createServer((req, res) => res.end('unrelated'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  refused(run('gate_port_available "$PORT"', { PORT: String(server.address().port) }), /occupied/i);
  assert.equal(server.listening, true);
});

test('a free ephemeral endpoint passes the availability guard', async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  ok(run('gate_port_available "$PORT"', { PORT: String(port) }));
});

test('cleanup refuses an identity mismatch and then stops only its verified owned child', () => {
  ok(run(`
sleep 30 & owned=$!
identity=$(gate_process_identity "$owned")
arguments=$(ps -ww -p "$owned" -o args=)
trap 'gate_cleanup_server "$owned" "$identity" "$arguments"' EXIT
gate_cleanup_server "$owned" "wrong-identity" "$arguments"
kill -0 "$owned" || exit 40
gate_cleanup_server "$owned" "$identity" "wrong-command"
kill -0 "$owned" || exit 41
gate_cleanup_server "$owned" "$identity" "$arguments"
if kill -0 "$owned" 2>/dev/null; then exit 42; fi
trap - EXIT
`));
});

test('another process cannot be adopted for cleanup by recording its identity', () => {
  ok(run(`
identity=$(gate_process_identity "$FOREIGN_PID")
arguments=$(ps -ww -p "$FOREIGN_PID" -o args=)
gate_cleanup_server "$FOREIGN_PID" "$identity" "$arguments"
kill -0 "$FOREIGN_PID"
`, { FOREIGN_PID: String(process.pid) }));
});

test('an owned child is verified against its expected command after a delayed exec', () => {
  ok(run(`
bash -c 'sleep 0.12; exec sleep 30' & owned=$!
identity=$(gate_process_identity "$owned")
arguments='sleep 30'
trap 'gate_cleanup_server "$owned" "$identity" "$arguments"' EXIT
gate_wait_process "$owned" "$identity" "$arguments" 40 || exit 43
gate_process_matches "$owned" "$identity" "$arguments"
`));
});

test('readiness cannot be borrowed from a foreign responder while the owned child stays alive', async t => {
  const server = http.createServer((req, res) => res.end('{}'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = run(`
sleep 30 & owned=$!
identity=$(gate_process_identity "$owned")
arguments=$(ps -ww -p "$owned" -o args=)
trap 'gate_cleanup_server "$owned" "$identity" "$arguments"' EXIT
gate_wait_server "$owned" "$identity" "$arguments" "$PORT" 2
`, { PORT: String(server.address().port) });
  refused(result, /owned test server|readiness/i);
  assert.equal(server.listening, true);
});

test('readiness accepts the captured child that actually owns the listener', t => {
  const root = scratch(t);
  const fixture = path.join(root, 'stand-in.cjs');
  const portFile = path.join(root, 'port');
  fs.writeFileSync(fixture, `const fs=require('node:fs'),http=require('node:http');
const server=http.createServer((req,res)=>res.end('{}'));
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[2],String(server.address().port)));
`);
  ok(run(`
node "$FIXTURE" "$PORT_FILE" & owned=$!
identity=$(gate_process_identity "$owned")
arguments=$(ps -ww -p "$owned" -o args=)
trap 'gate_cleanup_server "$owned" "$identity" "$arguments"' EXIT
for attempt in {1..50}; do [ -s "$PORT_FILE" ] && break; sleep 0.02; done
port=$(cat "$PORT_FILE")
gate_wait_server "$owned" "$identity" "$arguments" "$port" 3
`, { FIXTURE: fixture, PORT_FILE: portFile }));
});

// The shared hub's clothing board (plan 1.3a). The hub starts with no clothing
// schedule (ERA_CLOTHING_TICK_MS=0), so its today.json is not rewritten by a
// 20 s or 15-minute timer while board suites read it; the gate builds it once
// instead, after readiness, and waits for that build to finish before any
// suite starts. The stand-in plays the hub's two clothing doors and writes down
// every request it was sent, and what it answered.
const clothingHub = `const fs=require('node:fs'),http=require('node:http');
const [portFile,logFile,mode]=process.argv.slice(2);
let posted=false,polls=0;
const server=http.createServer((req,res)=>{
  if(req.method==='POST'&&req.url==='/clothing/regenerate'){
    fs.appendFileSync(logFile,'POST regenerate\\n');
    if(mode==='refuses'){res.writeHead(500);res.end();return;}
    posted=true;res.writeHead(202,{'Content-Type':'application/json'});res.end('{"started":true}');
    if(mode==='dies')setTimeout(()=>process.exit(0),20);
    return;
  }
  if(req.method==='GET'&&req.url==='/clothing/status'){
    const building=posted&&(mode==='never'||++polls<=3);
    fs.appendFileSync(logFile,'GET status '+building+'\\n');
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({building,ingesting:null,cataloged:0,photos:0}));return;
  }
  res.writeHead(404);res.end();
});
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(portFile,String(server.address().port)));
`;
function buildClothing(t, mode, tries = '') {
  const root = scratch(t);
  const fixture = path.join(root, 'clothing-hub.cjs'), log = path.join(root, 'requests.log');
  fs.writeFileSync(fixture, clothingHub);
  const result = run(`
node "$FIXTURE" "$PORT_FILE" "$LOG" "$MODE" & owned=$!
trap 'kill "$owned" 2>/dev/null; wait "$owned" 2>/dev/null' EXIT
for attempt in {1..100}; do [ -s "$PORT_FILE" ] && break; sleep 0.02; done
gate_build_clothing "$(cat "$PORT_FILE")" ${tries}
`, { FIXTURE: fixture, PORT_FILE: path.join(root, 'port'), LOG: log, MODE: mode });
  const requests = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  return { result, requests };
}

test('the shared hub\'s clothing board is built once, and the gate waits until the build has finished', t => {
  const { result, requests } = buildClothing(t, 'settles');
  ok(result);
  assert.equal(requests[0], 'POST regenerate', 'the build is asked for before anything is polled');
  assert.equal(requests.filter(r => r === 'POST regenerate').length, 1, 'exactly one build');
  assert.deepEqual(requests.slice(1), ['GET status true', 'GET status true', 'GET status true', 'GET status false'],
    'polled while it built, and returned on the first answer that said it had finished');
});

test('a clothing build the shared hub refuses, never finishes or stops answering fails the gate', t => {
  refused(buildClothing(t, 'refuses').result, /clothing build/i);
  const never = buildClothing(t, 'never', 5);
  refused(never.result, /clothing build.*(finish|settle)/i);
  assert.equal(never.requests.filter(r => r.startsWith('GET')).length, 5, 'bounded by its tries');
  refused(buildClothing(t, 'dies').result, /clothing build|stopped answering/i);
});

test('the shared hub runs without a clothing schedule and its board is built before the first suite', () => {
  const launch = gate.match(/^([^\n]*\\)\n[ \t]*"\$NODE_BIN" "\$HUB\/server\.js" "\$PORT" >"\$GATE\/server\.log" 2>&1 &$/m);
  assert.ok(launch, 'the shared hub launch, with its env prefix on the continuation line before it');
  assert.match(launch[1], /(^|[ \t])ERA_CLOTHING_TICK_MS=0([ \t]|$)/, 'the shared hub starts with no clothing timers');
  const unset = gate.match(/^unset [^\n]*$/m);
  assert.ok(unset && /\bERA_CLOTHING_TICK_MS\b/.test(unset[0]),
    "an operator's shell cannot hand the seam to a suite's own hubs");
  assert.ok(unset.index < launch.index, 'cleared before the shared hub starts');
  const ready = gate.indexOf('gate_wait_server "$SRV" "$SRV_ID" "$SRV_ARGS" "$PORT" ||');
  const build = gate.indexOf('gate_build_clothing "$PORT"');
  // the suites start when the lane runner does (tools/testing/lanes.mjs); a
  // comment that names it does not count, only the command at a line's start
  const runner = gate.search(/^node "\$HUB\/tools\/testing\/lanes\.mjs" "\$GATE"/m);
  assert.ok(runner > 0, 'the lane runner starts the suites');
  assert.ok(ready > launch.index && build > ready && runner > build,
    'launch, then readiness, then the one awaited build, then the suites');
  assert.match(gate.slice(build, runner), /gate_build_clothing "\$PORT" \|\| \{[^}]*exit 1; \}/,
    'a build that does not finish stops the gate');
});

const repos = ['era-core', 'era-making-words', 'era-pencil', 'era-board', 'era-hub'];
const legacy = ['run', 'parts', 'transfer', 'mistakes', 'pencil', 'narrow', 'sortfix',
  'fltest', 'bargein', 'sortbugs', 'rhymecount', 'transfercount', 'phonetic'];
function workspace(t) {
  const root = scratch(t);
  for (const repo of repos) {
    fs.mkdirSync(path.join(root, repo, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, repo, 'tests', repo + '.test.mjs'), '// synthetic\n');
  }
  for (const name of legacy) {
    const repo = name === 'pencil' ? 'era-pencil' : 'era-making-words';
    fs.writeFileSync(path.join(root, repo, 'tests', name + '.js'), '// synthetic\n');
  }
  const env = { ROOT: root, HUB: path.join(root, 'era-hub'), GATE: path.join(root, 'gate') };
  fs.mkdirSync(env.GATE);
  fs.mkdirSync(path.join(env.HUB, 'tools/testing'), { recursive: true });
  fs.writeFileSync(path.join(env.HUB, 'tools/testing/registry.json'), JSON.stringify({
    suites: [
      ...repos.map(repo => ({ id: `${repo}:tests/${repo}.test.mjs` })),
      ...legacy.map(name => ({ id: `${name === 'pencil' ? 'era-pencil' : 'era-making-words'}:tests/${name}.js` })),
    ],
  }));
  return { root, env };
}
const collect = 'sib() { printf "%s/%s" "$ROOT" "$1"; }\ngate_collect_suites';

test('collection preserves all registered sources and fixture directories', t => {
  const { root, env } = workspace(t);
  fs.mkdirSync(path.join(root, 'era-hub/tests/fixtures'));
  fs.writeFileSync(path.join(root, 'era-hub/tests/fixtures/synthetic.txt'), 'fixture');
  ok(run(collect, env));
  assert.equal(fs.readFileSync(path.join(env.GATE, 'fixtures/synthetic.txt'), 'utf8'), 'fixture');
  for (const repo of repos) assert.ok(fs.existsSync(path.join(env.GATE, repo + '.test.mjs')));
  for (const name of legacy) assert.ok(fs.existsSync(path.join(env.GATE, name + '.js')));
});

test('a missing required repository tests directory fails collection', t => {
  const { root, env } = workspace(t);
  fs.rmSync(path.join(root, 'era-board/tests'), { recursive: true });
  refused(run(collect, env), /missing.*tests|tests.*missing/i);
});

test('a missing required legacy suite fails collection', t => {
  const { root, env } = workspace(t);
  fs.unlinkSync(path.join(root, 'era-pencil/tests/pencil.js'));
  refused(run(collect, env), /missing.*pencil\.js/i);
});

test('duplicate suite basenames fail rather than overwrite an earlier source', t => {
  const { root, env } = workspace(t);
  fs.writeFileSync(path.join(root, 'era-board/tests/era-core.test.mjs'), 'duplicate');
  refused(run(collect, env), /duplicate.*era-core\.test\.mjs/i);
  assert.equal(fs.readFileSync(path.join(env.GATE, 'era-core.test.mjs'), 'utf8'), '// synthetic\n');
});

test('a failed copy cannot be mistaken for complete collection', t => {
  const { env } = workspace(t);
  refused(run('cp() { return 73; }\n' + collect, env), /copy|collect/i);
});

test('shared fixture directory names merge disjoint files and reject relative-file collisions', t => {
  const { root, env } = workspace(t);
  for (const repo of ['era-board', 'era-hub']) {
    fs.mkdirSync(path.join(root, repo, 'tests/fixtures'));
    fs.writeFileSync(path.join(root, repo, 'tests/fixtures', repo + '.txt'), repo);
  }
  ok(run(collect, env));
  for (const repo of ['era-board', 'era-hub']) {
    assert.equal(fs.readFileSync(path.join(env.GATE, 'fixtures', repo + '.txt'), 'utf8'), repo);
  }
  fs.rmSync(env.GATE, { recursive: true });
  fs.mkdirSync(env.GATE);
  fs.writeFileSync(path.join(root, 'era-hub/tests/fixtures/era-board.txt'), 'duplicate');
  refused(run(collect, env), /duplicate.*fixtures\/era-board\.txt/i);
});

test('affected mode validates source-qualified executable IDs and selects complete files', t => {
  const { root, env } = workspace(t);
  const selected = path.join(root, 'selected.json');
  fs.writeFileSync(selected, JSON.stringify(['era-hub:tests/era-hub.test.mjs']));
  ok(run(collect + `
gate_prepare_selection || exit
gate_suite_selected era-hub.test.mjs || exit 70
if gate_suite_selected run.js; then exit 71; fi
`, { ...env, ERA_GATE_MODE: 'affected', ERA_GATE_SELECTED: selected }));
});

test('unknown, duplicate and non-executable affected selections cannot produce partial success', t => {
  for (const requested of [['era-hub:tests/missing.test.mjs'],
    ['era-hub:tests/era-hub.test.mjs', 'era-hub:tests/era-hub.test.mjs'],
    ['era-hub:tests/helper.mjs'], []]) {
    const { root, env } = workspace(t);
    fs.writeFileSync(path.join(root, 'era-hub/tests/helper.mjs'), '// helper');
    const selected = path.join(root, 'selected.json');
    fs.writeFileSync(selected, JSON.stringify(requested));
    refused(run(collect + '\ngate_prepare_selection', {
      ...env, ERA_GATE_MODE: 'affected', ERA_GATE_SELECTED: selected,
    }), /selection/i);
  }
});

test('immutable seed data is copied to owned scratch before suites can write', t => {
  const { root, env } = workspace(t);
  const seed = path.join(root, 'era-family/test-data');
  fs.mkdirSync(path.join(seed, 'content'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'content/lessons.json'), '{"fixture":true}');
  const result = run(`
gate_export_test_data || exit
gate_prepare_owned_data || exit
trap 'rm -rf -- "$OWN_DATA"' EXIT
[ "$DATA" != "$ERA_GATE_SEED_DIR" ] || exit 80
printf changed >"$DATA/content/lessons.json"
printf '%s' "$ERA_GATE_SEED_DIR"
`, { ...env, DATA: seed, TMPDIR: root });
  ok(result);
  assert.equal(result.stdout, seed);
  assert.equal(fs.readFileSync(path.join(seed, 'content/lessons.json'), 'utf8'), '{"fixture":true}');
});

test('seed symlinks cannot carry external mutable inputs into test data', t => {
  const { root, env } = workspace(t);
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(root, 'outside'), 'external');
  fs.symlinkSync(path.join(root, 'outside'), path.join(seed, 'alias'));
  refused(run('gate_export_test_data && gate_prepare_owned_data', { ...env, DATA: seed, TMPDIR: root }), /seed.*symlink|seed.*unsupported/i);
});

function farmWorkspace(t) {
  const state = workspace(t), { root, env } = state;
  fs.mkdirSync(path.join(env.HUB, 'public'));
  for (const [repo, relative] of [['era-core', 'lib'], ['era-pencil', 'app'], ['era-board', 'app']]) {
    fs.mkdirSync(path.join(root, repo, relative), { recursive: true });
  }
  fs.mkdirSync(path.join(root, 'era-making-words/app'), { recursive: true });
  for (const [repo, relative] of [['era-core', 'dwell.js'], ['era-core', 'speech.js'],
    ['era-making-words', 'app/index.html'], ['era-making-words', 'app/studio.js']]) {
    fs.writeFileSync(path.join(root, repo, relative), '// selected');
  }
  const data = path.join(root, 'seed');
  fs.mkdirSync(path.join(data, 'content'), { recursive: true });
  fs.writeFileSync(path.join(data, 'content/lessons.json'), '{"selected":true}');
  env.DATA = data;
  return state;
}

test('all generated runtime links refresh and absent test content removes stale live links', t => {
  const { root, env } = farmWorkspace(t);
  for (const name of ['lib', 'dwell.js', 'speech.js', 'index.html', 'studio.js', 'pencil', 'board',
    'lessons.json', 'sentences.json', 'runway.json']) {
    fs.symlinkSync(path.join(root, 'unrelated', name), path.join(env.HUB, 'public', name));
  }
  ok(run('sib() { printf "%s/%s" "$ROOT" "$1"; }\ngate_refresh_farm', env));
  for (const [name, repo, relative] of [['lib', 'era-core', 'lib'], ['dwell.js', 'era-core', 'dwell.js'],
    ['speech.js', 'era-core', 'speech.js'], ['index.html', 'era-making-words', 'app/index.html'],
    ['studio.js', 'era-making-words', 'app/studio.js'], ['pencil', 'era-pencil', 'app'], ['board', 'era-board', 'app']]) {
    assert.equal(fs.realpathSync(path.join(env.HUB, 'public', name)), path.join(root, repo, relative));
  }
  assert.equal(fs.realpathSync(path.join(env.HUB, 'public/lessons.json')), path.join(env.DATA, 'content/lessons.json'));
  for (const name of ['sentences.json', 'runway.json']) {
    assert.equal(fs.existsSync(path.join(env.HUB, 'public', name)), false);
    assert.throws(() => fs.lstatSync(path.join(env.HUB, 'public', name)), { code: 'ENOENT' });
  }
});

test('plain runtime directories cannot masquerade as the selected source farm', t => {
  const { env } = farmWorkspace(t);
  fs.mkdirSync(path.join(env.HUB, 'public/lib'));
  refused(run('sib() { printf "%s/%s" "$ROOT" "$1"; }\ngate_refresh_farm', env), /generated.*link|unowned.*farm/i);
});

test('a later collected suite removed after freezing is a missing execution, never a complete pass', t => {
  const { env } = workspace(t);
  refused(run(collect + `
gate_prepare_selection || exit
gate_freeze_execution || exit
for index in "\${!EXPECTED_FILES[@]}"; do
  if [ "\${EXPECTED_FILES[$index]}" = era-hub.test.mjs ]; then
    rm -- "$GATE/era-hub.test.mjs"
    gate_record_execution "$index"
    exit $?
  fi
done
exit 81
`, { ...env, ERA_GATE_MODE: 'full', ERA_GATE_SELECTED: '' }), /missing.*suite|suite.*missing/i);
});

test('execution reconciliation requires every frozen source ID exactly once', t => {
  const { env } = workspace(t);
  const initial = 'rm -rf -- "$GATE"; mkdir "$GATE"\n' + collect + '\ngate_prepare_selection || exit\ngate_freeze_execution || exit\n';
  refused(run(initial + 'gate_record_execution 0 || exit\ngate_verify_execution', {
    ...env, ERA_GATE_MODE: 'full', ERA_GATE_SELECTED: '',
  }), /execution.*missing|missing.*execution/i);
  refused(run(initial + 'gate_record_execution 0 || exit\ngate_record_execution 0', {
    ...env, ERA_GATE_MODE: 'full', ERA_GATE_SELECTED: '',
  }), /duplicate.*execution|execution.*twice/i);
  refused(run(initial + 'printf changed >>"$GATE/run.js"\ngate_record_execution 0', {
    ...env, ERA_GATE_MODE: 'full', ERA_GATE_SELECTED: '',
  }), /suite changed before execution/i);
  ok(run(initial + 'for index in "${!EXPECTED_FILES[@]}"; do gate_record_execution "$index" || exit; done\ngate_verify_execution', {
    ...env, ERA_GATE_MODE: 'full', ERA_GATE_SELECTED: '',
  }));
});

test('port guard behavior survives the gate copy rewrite', t => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, 'tools'));
  fs.copyFileSync(path.join(HUB, 'tools/era-gate.sh'), path.join(root, 'tools/era-gate.sh'));
  const collected = path.join(root, 'gate');
  fs.mkdirSync(collected);
  const copied = path.join(collected, 'gate-safety.test.mjs');
  const original = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const start = gate.indexOf('# re-point the live-server port in the gate copies only');
  const end = gate.indexOf('\ngate_freeze_execution', start);
  assert.ok(start >= 0 && end > start, 'the shipped port rewrite block is available');
  const rewrite = gate.slice(start, end);
  assert.match(rewrite, /xargs -0 -r sed -i/, 'exercise the gate collector rewrite');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const port of ['8378', '8388']) {
    for (const control of [true, false]) {
      // The deliberately fragile control proves that a rewritten live-port
      // literal becomes an approved port and makes this same guard test fail.
      const source = control ? original.replace('String(8300 + 77)', JSON.stringify(String(8300 + 77))) : original;
      fs.writeFileSync(copied, source);
      fs.writeFileSync(path.join(collected, 'port-marker.txt'), String(8300 + 77));
      const rewritten = spawnSync('bash', ['-c', `set -uo pipefail\n${rewrite}`], {
        env: { ...env, GATE: collected, PORT: port }, encoding: 'utf8', timeout: 10000,
      });
      ok(rewritten);
      assert.equal(fs.readFileSync(path.join(collected, 'port-marker.txt'), 'utf8'), port);
      const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=^the shared gate port accepts', copied], {
        env, encoding: 'utf8', timeout: 10000,
      });
      if (control) {
        assert.notEqual(result.status, 0, 'a port literal must fail this rewritten control');
        assert.match(result.stdout, /operator: 'notStrictEqual'/);
        assert.match(result.stdout, /# fail 1\b/);
      } else {
        ok(result);
        assert.match(result.stdout, /# pass 1\b/);
      }
    }
  }
});
