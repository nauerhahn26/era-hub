// Selection is development feedback; complete gates retain acceptance authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  checkInventory, planChanges, captureInputs, verifyInputs, enqueueJob,
  runJob, readJob, listJobs, requestCancellation, previousFailuresFor,
} from '../tools/testing/suite-runner.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim();
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-suite-test-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const hub = path.join(dir, 'era-hub'), core = path.join(dir, 'era-core');
  const roots = { 'era-hub':hub, 'era-core':core };
  for (const root of Object.values(roots)) {
    fs.mkdirSync(path.join(root, 'tests'), { recursive:true });
    git(root, 'init', '-b', 'master');
    git(root, 'config', 'user.name', 'Test Maintainer');
    git(root, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(root, '.gitignore'), 'gate/\n');
  }
  const write = (file, content='// fixture\n') => {
    fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, content);
  };
  write(path.join(hub, 'public/math/state.js'));
  write(path.join(hub, 'public/other/state.js'));
  write(path.join(hub, 'tests/math.test.mjs'));
  write(path.join(hub, 'tests/other.test.mjs'));
  write(path.join(hub, 'tests/helper.mjs'));
  write(path.join(core, 'tests/access.test.mjs'));
  write(path.join(core, 'lib/dwell.js'));
  for (const root of Object.values(roots)) { git(root, 'add', '.'); git(root, 'commit', '-m', 'initial'); }
  const registry = {
    version:1,
    repositories:['era-hub','era-core'],
    suites:[
      { id:'era-hub:tests/math.test.mjs', purpose:'Quantity conservation', group:'math', dependencies:['public/math/**'], lane:'linux', resources:['gate-lock'] },
      { id:'era-hub:tests/other.test.mjs', purpose:'Other behavior', group:'other', dependencies:['public/other/**'], lane:'linux', resources:['gate-lock'] },
      { id:'era-core:tests/access.test.mjs', purpose:'Escape access', group:'smoke', dependencies:['lib/**'], lane:'linux', resources:['gate-lock'] },
    ],
    always:['era-core:tests/access.test.mjs'],
    support:[{id:'era-hub:tests/helper.mjs',purpose:'Shared fixture helper',consumers:['era-hub:tests/math.test.mjs','era-hub:tests/other.test.mjs']}],
    rules:[
      { repo:'era-hub', paths:['public/math/**'], suites:['era-hub:tests/math.test.mjs'], reason:'Reviewed isolated math state and page boundary' },
      { repo:'era-hub', paths:['tests/helper.mjs'], suites:['era-hub:tests/math.test.mjs','era-hub:tests/other.test.mjs'], reason:'Declared helper consumers' },
    ],
    full:[ { repo:'era-core', paths:['lib/**'], reason:'Shared access runtime' } ],
  };
  return { dir,hub,roots,registry,write,jobsDir:path.join(dir,'jobs') };
}

test('inventory requires every discovered suite, every registered source and unique destination names', t => {
  const f=fixture(t);
  assert.equal(checkInventory(f.roots,f.registry).length,3);
  f.write(path.join(f.hub,'tests/new.test.mjs'));
  assert.throws(()=>checkInventory(f.roots,f.registry),/unregistered.*new\.test/is);
  fs.unlinkSync(path.join(f.hub,'tests/new.test.mjs'));
  fs.unlinkSync(path.join(f.hub,'tests/math.test.mjs'));
  assert.throws(()=>checkInventory(f.roots,f.registry),/missing.*math\.test/is);
  f.write(path.join(f.hub,'tests/math.test.mjs'));
  f.write(path.join(f.roots['era-core'],'tests/math.test.mjs'));
  f.registry.suites.push({...f.registry.suites[0],id:'era-core:tests/math.test.mjs'});
  assert.throws(()=>checkInventory(f.roots,f.registry),/collision/i);
});

test('nested executable tests cannot silently disappear from the flat gate', t => {
  const f=fixture(t); f.write(path.join(f.hub,'tests/nested/lost.test.mjs'));
  assert.throws(()=>checkInventory(f.roots,f.registry),/nested|unregistered/i);
});

test('new helper modules require an explicit support declaration', t => {
  const f=fixture(t); f.write(path.join(f.hub,'tests/new-helper.mjs'));
  assert.throws(()=>checkInventory(f.roots,f.registry),/unclassified.*support/i);
});

test('planner uses cumulative baseline changes, unstaged files, staged files and new files', t => {
  const f=fixture(t);
  f.write(path.join(f.hub,'public/math/state.js'),'// committed change\n');
  git(f.hub,'add','.'); git(f.hub,'commit','-m','feature');
  f.write(path.join(f.hub,'public/math/view.js'));
  git(f.hub,'add','public/math/view.js');
  f.write(path.join(f.hub,'public/math/input.js'));
  const p=planChanges({...f,baseline:'HEAD~1'});
  assert.equal(p.mode,'full','missing sibling baseline is a full fallback');
  git(f.roots['era-core'],'tag','baseline'); git(f.hub,'tag','baseline','HEAD~1');
  const selected=planChanges({...f,baseline:'baseline'});
  assert.equal(selected.mode,'affected');
  assert.deepEqual(selected.selected.map(s=>s.id).sort(),['era-core:tests/access.test.mjs','era-hub:tests/math.test.mjs']);
  assert.deepEqual(selected.changes.filter(c=>c.repo==='era-hub').map(c=>c.path).sort(),['public/math/input.js','public/math/state.js','public/math/view.js']);
});

test('unknown, shared and missing-baseline changes expand to the entire inventory', t => {
  const f=fixture(t);
  f.write(path.join(f.hub,'unknown.js'));
  let p=planChanges({...f,baseline:'master'});
  assert.equal(p.mode,'full'); assert.equal(p.selected.length,3); assert.match(p.fallback.join(' '),/unknown/i);
  fs.unlinkSync(path.join(f.hub,'unknown.js'));
  f.write(path.join(f.roots['era-core'],'lib/dwell.js'),'// shared change\n');
  p=planChanges({...f,baseline:'master'});
  assert.equal(p.mode,'full'); assert.match(p.fallback.join(' '),/Shared access/i);
  assert.equal(planChanges({...f,baseline:'absent'}).mode,'full');
});

test('renames inspect both old and new dependency identities', t => {
  const f=fixture(t);
  git(f.hub,'mv','public/other/state.js','public/math/moved.js');
  const p=planChanges({...f,baseline:'master'});
  assert.equal(p.mode,'full','unknown old dependency cannot vanish because destination is understood');
  assert.ok(p.changes.some(c=>c.path==='public/other/state.js'));
  assert.ok(p.changes.some(c=>c.path==='public/math/moved.js'));
});

test('changed suites, helper consumers and previous failures are explicit selection reasons', t => {
  const f=fixture(t);
  f.write(path.join(f.hub,'tests/helper.mjs'),'// changed helper\n');
  f.write(path.join(f.hub,'tests/math.test.mjs'),'// changed suite\n');
  const p=planChanges({...f,baseline:'master',previousFailures:['era-hub:tests/other.test.mjs']});
  assert.equal(p.mode,'affected');
  assert.match(p.selected.find(s=>s.id.endsWith('/math.test.mjs')).reasons.join(' '),/Changed test|helper/i);
  assert.match(p.selected.find(s=>s.id.endsWith('/other.test.mjs')).reasons.join(' '),/previous/i);
  assert.throws(()=>planChanges({...f,baseline:'master',requested:['unregistered:tests/no.test.mjs']}),/unknown.*suite/i);
});

test('deleted source selects its consumers and filenames with spaces remain intact', t => {
  const f=fixture(t);
  fs.unlinkSync(path.join(f.hub,'public/math/state.js'));
  f.write(path.join(f.hub,'public/math/space name.js'));
  const p=planChanges({...f,baseline:'master'});
  assert.equal(p.mode,'affected');
  assert.ok(p.changes.some(c=>c.path==='public/math/state.js'));
  assert.ok(p.changes.some(c=>c.path==='public/math/space name.js'));
});

test('fingerprints bind staged, unstaged, untracked and sibling contents, not just HEAD', t => {
  const f=fixture(t), before=captureInputs(f.roots);
  assert.equal(verifyInputs(before,f.roots).valid,true);
  f.write(path.join(f.roots['era-core'],'lib/dwell.js'),'// changed\n');
  assert.equal(verifyInputs(before,f.roots).valid,false);
  git(f.roots['era-core'],'checkout','--','lib/dwell.js');
  f.write(path.join(f.hub,'new.js'));
  assert.equal(verifyInputs(before,f.roots).valid,false);
  fs.unlinkSync(path.join(f.hub,'new.js'));
  assert.equal(verifyInputs(before,f.roots).valid,true);
});

test('queued jobs retain input evidence and source changes invalidate before execution', async t => {
  const f=fixture(t);
  f.write(path.join(f.hub,'tools/era-gate.sh'),'#!/bin/bash\nexit 99\n');
  const job=enqueueJob({...f,baseline:'master',startWorker:false});
  f.write(path.join(f.hub,'public/math/state.js'),'// changed while queued\n');
  await runJob(job.directory,{registry:f.registry,roots:f.roots});
  const result=readJob(job.directory);
  assert.equal(result.status,'stale');
  assert.equal(result.outcome.executed,false);
  assert.equal(listJobs(f.jobsDir).length,1);
});

test('complete jobs keep separate logs, owned child identities and complete outcomes', async t => {
  const f=fixture(t);
  f.write(path.join(f.hub,'tools/era-gate.sh'),'#!/bin/bash\necho "== era-gate: lock acquired =="\necho "RUN math.test.mjs"\necho "PASS math.test.mjs"\necho "PASS other.test.mjs"\necho "PASS access.test.mjs"\necho "== era-gate: 3 passed, 0 failed =="\n');
  const job=enqueueJob({...f,baseline:'master',startWorker:false});
  await runJob(job.directory,{registry:f.registry,roots:f.roots});
  const result=readJob(job.directory);
  assert.equal(result.status,'passed');
  assert.equal(result.outcome.exitCode,0);
  assert.equal(result.outcome.mode,'full');
  assert.ok(result.child.pid>0); assert.ok(result.child.startTicks);
  assert.match(fs.readFileSync(path.join(job.directory,'gate.log'),'utf8'),/PASS math/);
  assert.equal(fs.existsSync(path.join(job.directory,'outcome.json')),true);
});

test('a changing source invalidates an otherwise successful run', async t => {
  const f=fixture(t);
  f.write(path.join(f.hub,'tools/era-gate.sh'),'#!/bin/bash\necho "== era-gate: lock acquired =="\necho changed > public/math/state.js\nexit 0\n');
  const job=enqueueJob({...f,baseline:'master',startWorker:false});
  await runJob(job.directory,{registry:f.registry,roots:f.roots});
  assert.equal(readJob(job.directory).status,'stale');
});

test('affected jobs pass only validated source IDs and cannot create complete evidence', async t => {
  const f=fixture(t);
  const previousMode=process.env.ERA_GATE_MODE, previousPort=process.env.ERA_TEST_PORT;
  delete process.env.ERA_GATE_MODE;
  t.after(()=>{
    if(previousMode===undefined) delete process.env.ERA_GATE_MODE; else process.env.ERA_GATE_MODE=previousMode;
    if(previousPort===undefined) delete process.env.ERA_TEST_PORT; else process.env.ERA_TEST_PORT=previousPort;
  });
  f.write(path.join(f.hub,'tools/era-gate.sh'),'#!/bin/bash\necho "$ERA_GATE_MODE"\ncat "$ERA_GATE_SELECTED"\necho "PASS math.test.mjs"\necho "PASS access.test.mjs"\n');
  git(f.hub,'add','.'); git(f.hub,'commit','-m','fixture gate');
  f.write(path.join(f.hub,'public/math/state.js'),'// changed\n');
  const job=enqueueJob({...f,baseline:'master',mode:'affected',startWorker:false});
  await runJob(job.directory,{registry:f.registry,roots:f.roots});
  const result=readJob(job.directory);
  assert.equal(result.status,'passed'); assert.equal(result.outcome.mode,'affected');
  assert.equal(result.outcome.completeEvidence,false);
  assert.match(fs.readFileSync(path.join(job.directory,'gate.log'),'utf8'),/affected/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(job.directory,'selected.json'),'utf8')).sort(),['era-core:tests/access.test.mjs','era-hub:tests/math.test.mjs']);
  const second=enqueueJob({...f,baseline:'master',mode:'affected',startWorker:false});
  process.env.ERA_TEST_PORT=previousPort==='8381'?'8382':'8381';
  await runJob(second.directory,{registry:f.registry,roots:f.roots});
  const stale=readJob(second.directory);
  assert.equal(stale.status,'stale');
  assert.match(stale.outcome.changes.join(' '),/testPort/,'only the frozen job mode is supplied; product configuration changes remain visible');
});

test('queued cancellation writes a job-owned request and never signals any process', async t => {
  const f=fixture(t);
  f.write(path.join(f.hub,'tools/era-gate.sh'),'#!/bin/bash\nexit 99\n');
  const job=enqueueJob({...f,baseline:'master',startWorker:false});
  requestCancellation(job.directory);
  await runJob(job.directory,{registry:f.registry,roots:f.roots});
  const result=readJob(job.directory);
  assert.equal(result.status,'cancelled'); assert.equal(result.outcome.executed,false);
  assert.equal(fs.existsSync(path.join(job.directory,'cancel.request')),true);
});

test('running cancellation refuses unsafe termination and corrupt jobs are not trusted', t => {
  const f=fixture(t);
  f.write(path.join(f.hub,'tools/era-gate.sh'),'#!/bin/bash\nexit 0\n');
  const job=enqueueJob({...f,baseline:'master',startWorker:false});
  fs.writeFileSync(path.join(job.directory,'status.json'),JSON.stringify({status:'running'}));
  assert.throws(()=>requestCancellation(job.directory),/running.*safe|safe.*running/i);
  fs.writeFileSync(path.join(job.directory,'job.json'),'{}');
  assert.throws(()=>readJob(job.directory),/invalid.*job/i);
});

test('successful child exit cannot conceal missing registered suite results', async t => {
  const f=fixture(t);
  f.write(path.join(f.hub,'tools/era-gate.sh'),'#!/bin/bash\necho "PASS math.test.mjs"\nexit 0\n');
  const job=enqueueJob({...f,baseline:'master',startWorker:false});
  await runJob(job.directory,{registry:f.registry,roots:f.roots});
  const result=readJob(job.directory);
  assert.equal(result.status,'failed');
  assert.equal(result.outcome.missingSuites.length,2);
});

test('previous failures persist until an explicit later passing result for that suite', t => {
  const f=fixture(t);
  f.write(path.join(f.hub,'tools/era-gate.sh'),'#!/bin/bash\nexit 0\n');
  const first=enqueueJob({...f,baseline:'master',startWorker:false});
  fs.writeFileSync(path.join(first.directory,'outcome.json'),JSON.stringify({finished:'2026-01-01T00:00:00Z',suites:[{id:'era-hub:tests/other.test.mjs',status:'fail'}]}));
  assert.deepEqual(previousFailuresFor(f.roots,f.jobsDir),['era-hub:tests/other.test.mjs']);
  const second=enqueueJob({...f,baseline:'master',startWorker:false});
  fs.writeFileSync(path.join(second.directory,'outcome.json'),JSON.stringify({finished:'2026-01-02T00:00:00Z',suites:[{id:'era-hub:tests/math.test.mjs',status:'pass'}]}));
  assert.deepEqual(previousFailuresFor(f.roots,f.jobsDir),['era-hub:tests/other.test.mjs']);
  fs.writeFileSync(path.join(second.directory,'outcome.json'),JSON.stringify({finished:'2026-01-02T00:00:00Z',suites:[{id:'era-hub:tests/other.test.mjs',status:'pass'}]}));
  assert.deepEqual(previousFailuresFor(f.roots,f.jobsDir),[]);
});

test('a job cannot execute twice or create its output inside a source repository', async t => {
  const f=fixture(t);
  f.write(path.join(f.hub,'tools/era-gate.sh'),'#!/bin/bash\necho "PASS math.test.mjs"\necho "PASS other.test.mjs"\necho "PASS access.test.mjs"\n');
  assert.throws(()=>enqueueJob({...f,jobsDir:path.join(f.hub,'jobs'),startWorker:false}),/outside source/i);
  const job=enqueueJob({...f,startWorker:false});
  await runJob(job.directory,{registry:f.registry,roots:f.roots});
  await assert.rejects(runJob(job.directory,{registry:f.registry,roots:f.roots}),/already claimed/i);
});

test('a changed staged snapshot invalidates inputs even when working files match again', t => {
  const f=fixture(t), before=captureInputs(f.roots), file=path.join(f.hub,'public/math/state.js');
  f.write(file,'// staged variant\n'); git(f.hub,'add','public/math/state.js');
  f.write(file,'// fixture\n');
  assert.equal(verifyInputs(before,f.roots).valid,false);
});

test('registering an unsupported JavaScript filename cannot pretend the gate executes it', t => {
  const f=fixture(t), id='era-hub:tests/extra.js';
  f.write(path.join(f.hub,'tests/extra.js'));
  f.registry.suites.push({...f.registry.suites[0],id});
  assert.throws(()=>checkInventory(f.roots,f.registry),/unsupported.*extra\.js/i);
});

test('job-directory symlinks and nonexistent descendants cannot enter ignored source output', t => {
  const f=fixture(t), gate=path.join(f.hub,'gate');
  fs.mkdirSync(gate); f.write(path.join(gate,'keep.txt'),'preserve this data\n');
  const link=path.join(f.dir,'jobs-link'); fs.symlinkSync(gate,link);
  assert.throws(()=>enqueueJob({...f,jobsDir:path.join(link,'new','jobs'),startWorker:false}),/outside source/i);
  assert.deepEqual(fs.readdirSync(gate),['keep.txt']);
  assert.equal(fs.readFileSync(path.join(gate,'keep.txt'),'utf8'),'preserve this data\n');
});

test('ignored served runtime files and followed source farm contents remain material inputs', t => {
  const f=fixture(t), ignored=path.join(f.hub,'public/dwell.js');
  fs.appendFileSync(path.join(f.hub,'.gitignore'),'public/dwell.js\n');
  f.write(ignored,'// first served implementation\n');
  const before=captureInputs(f.roots);
  f.write(ignored,'// changed ignored implementation\n');
  const result=verifyInputs(before,f.roots);
  assert.equal(result.valid,false);
  assert.match(result.changes.join(' '),/public\/dwell\.js/);
  fs.unlinkSync(ignored);
  fs.appendFileSync(path.join(f.roots['era-core'],'.gitignore'),'lib/generated.js\n');
  f.write(path.join(f.roots['era-core'],'lib/generated.js'),'// first ignored source artifact\n');
  fs.symlinkSync(path.join(f.roots['era-core'],'lib'),path.join(f.hub,'public/lib'));
  const linked=captureInputs(f.roots);
  f.write(path.join(f.roots['era-core'],'lib/generated.js'),'// changed ignored source artifact\n');
  assert.equal(verifyInputs(linked,f.roots).valid,false);
});

test('integration baseline freshness is separate from unchanged physical feature inputs', t => {
  const f=fixture(t), original=git(f.hub,'rev-parse','HEAD');
  git(f.hub,'checkout','-b','feature');
  const before=captureInputs(f.roots);
  f.write(path.join(f.hub,'later.js')); git(f.hub,'add','.'); git(f.hub,'commit','-m','later integration');
  const newer=git(f.hub,'rev-parse','HEAD');
  git(f.hub,'reset','--hard',original); git(f.hub,'update-ref','refs/heads/master',newer);
  const result=verifyInputs(before,f.roots);
  assert.equal(result.valid,true);
  assert.equal(result.integrationFresh,false);
  assert.match(result.integrationChanges.join(' '),/master.*moved/i);
});

test('material test configuration and immutable seed contents are bound separately from run output', t => {
  const f=fixture(t), seed=path.join(f.dir,'seed');
  f.write(path.join(seed,'content/lessons.json'),'[1]\n');
  const config={seedDir:seed,testPort:'8380',suffix:''};
  const before=captureInputs(f.roots,{testConfiguration:config});
  assert.equal(verifyInputs(before,f.roots,{testConfiguration:config}).valid,true);
  assert.equal(verifyInputs(before,f.roots,{testConfiguration:{...config,testPort:'8381'}}).valid,false);
  f.write(path.join(seed,'content/lessons.json'),'[2]\n');
  const changed=verifyInputs(before,f.roots,{testConfiguration:config});
  assert.equal(changed.valid,false); assert.match(changed.changes.join(' '),/seed/i);
});

test('inputs becoming stale while waiting are marked promptly with a cause and no process signal', async t => {
  const f=fixture(t);
  f.write(path.join(f.hub,'tools/era-gate.sh'),'#!/bin/bash\nwhile [ ! -e "$ERA_GATE_CANCEL_FILE" ]; do sleep 0.02; done\nexit 130\n');
  const job=enqueueJob({...f,startWorker:false});
  const running=runJob(job.directory,{registry:f.registry,roots:f.roots,watchInterval:20});
  setTimeout(()=>f.write(path.join(f.hub,'public/math/state.js'),'// changed while waiting\n'),30);
  await running;
  const outcome=readJob(job.directory);
  assert.equal(outcome.status,'stale');
  assert.match(outcome.outcome.changes.join(' '),/public\/math\/state\.js/);
});

test('live data paths and their ancestors are refused before seed collection', t => {
  const f=fixture(t), live=path.join(f.hub,'data');
  f.write(path.join(live,'keep.txt'),'preserve this data\n');
  assert.throws(()=>captureInputs(f.roots,{testConfiguration:{seedDir:live}}),/live data|unsafe.*seed/i);
  assert.throws(()=>captureInputs(f.roots,{testConfiguration:{seedDir:f.dir}}),/live data|unsafe.*seed/i);
  assert.equal(fs.readFileSync(path.join(live,'keep.txt'),'utf8'),'preserve this data\n');
});

test('identical seed bytes served from owned scratch preserve logical data farm identity', t => {
  const f=fixture(t), seed=path.join(f.dir,'seed'), scratch=path.join(f.dir,'scratch');
  f.write(path.join(seed,'content/lessons.json'),'[{"lesson":"synthetic"}]\n');
  fs.appendFileSync(path.join(f.hub,'.gitignore'),'public/lessons.json\n');
  fs.symlinkSync(path.join(seed,'content/lessons.json'),path.join(f.hub,'public/lessons.json'));
  const previous=process.env.ERA_DATA_DIR;
  try {
    process.env.ERA_DATA_DIR=seed;
    const before=captureInputs(f.roots,{testConfiguration:{seedDir:seed}});
    fs.cpSync(seed,scratch,{recursive:true});
    fs.unlinkSync(path.join(f.hub,'public/lessons.json'));
    fs.symlinkSync(path.join(scratch,'content/lessons.json'),path.join(f.hub,'public/lessons.json'));
    process.env.ERA_DATA_DIR=scratch;
    assert.equal(verifyInputs(before,f.roots,{testConfiguration:{seedDir:seed}}).valid,true);
    f.write(path.join(scratch,'content/lessons.json'),'[{"lesson":"different"}]\n');
    assert.equal(verifyInputs(before,f.roots,{testConfiguration:{seedDir:seed}}).valid,false);
  } finally {
    if(previous===undefined) delete process.env.ERA_DATA_DIR; else process.env.ERA_DATA_DIR=previous;
  }
});

test('a baseline-only move before execution refuses queued work and reports integration cause', async t => {
  const f=fixture(t), original=git(f.hub,'rev-parse','HEAD');
  git(f.hub,'checkout','-b','feature');
  f.write(path.join(f.hub,'future.js')); git(f.hub,'add','.'); git(f.hub,'commit','-m','future integration');
  const future=git(f.hub,'rev-parse','HEAD'); git(f.hub,'reset','--hard',original);
  f.write(path.join(f.hub,'tools/era-gate.sh'),'#!/bin/bash\nexit 99\n');
  const job=enqueueJob({...f,startWorker:false});
  git(f.hub,'update-ref','refs/heads/master',future);
  await runJob(job.directory,{registry:f.registry,roots:f.roots});
  const result=readJob(job.directory);
  assert.equal(result.status,'stale'); assert.equal(result.outcome.executed,false);
  assert.match(result.outcome.changes.join(' '),/integration baseline moved/);
});

test('a running stable candidate keeps its actual pass when only the integration ref advances', async t => {
  const f=fixture(t), original=git(f.hub,'rev-parse','HEAD');
  git(f.hub,'checkout','-b','feature');
  f.write(path.join(f.hub,'future.js')); git(f.hub,'add','.'); git(f.hub,'commit','-m','future integration');
  const future=git(f.hub,'rev-parse','HEAD'); git(f.hub,'reset','--hard',original);
  f.write(path.join(f.hub,'tools/era-gate.sh'),`#!/bin/bash\necho "== era-gate: lock acquired =="\necho "RUN math.test.mjs"\ngit update-ref refs/heads/master ${future}\necho "PASS math.test.mjs"\necho "PASS other.test.mjs"\necho "PASS access.test.mjs"\n`);
  const job=enqueueJob({...f,startWorker:false});
  await runJob(job.directory,{registry:f.registry,roots:f.roots});
  const result=readJob(job.directory);
  assert.equal(result.status,'passed');
  assert.equal(result.outcome.integrationStale,true);
  assert.match(result.outcome.integrationChanges.join(' '),/integration baseline moved/);
});

test('internal worker and cancellation entrypoints also reject relocated jobs inside source output', async t => {
  const f=fixture(t);
  f.write(path.join(f.hub,'tools/era-gate.sh'),'#!/bin/bash\nexit 0\n');
  const job=enqueueJob({...f,startWorker:false}), relocated=path.join(f.hub,'gate',job.id);
  fs.cpSync(job.directory,relocated,{recursive:true});
  await assert.rejects(runJob(relocated,{registry:f.registry,roots:f.roots}),/outside source/i);
  assert.throws(()=>requestCancellation(relocated),/outside source/i);
  assert.equal(fs.existsSync(path.join(relocated,'worker.claim')),false);
  assert.equal(fs.existsSync(path.join(relocated,'cancel.request')),false);
});
