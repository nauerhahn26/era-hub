import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../tools/testing/test/parallel-capacity.test.mjs';
import '../tools/testing/test/parallel-snapshot.test.mjs';
import {
  jobPath, executionEnvironment, parseProgress, estimateQueue, recordedGateStats,
  runtimeManifest, verifyRuntime, copyControlBundle, runPreflight, runReversePreflight, stateDirectory, readStatus, PYTHON,
} from '../tools/testing/parallel-worker.mjs';
import { inspectCapacity } from '../tools/testing/parallel-capacity.mjs';

function scratch(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'parallel-gate-test-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  return directory;
}

test('read-only memory monitor keeps process identity and shared-host observations accurate',()=>{
  const file=fileURLToPath(new URL('../tools/testing/test/parallel_monitor_test.py',import.meta.url));
  const result=spawnSync('python3',[file],{encoding:'utf8',env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(result.status,0,result.stderr || result.stdout || result.error?.message);
});

test('job lookup refuses traversal and aliases outside the owned jobs root',t=>{
  const root=scratch(t),jobs=path.join(root,'jobs');fs.mkdirSync(jobs);
  const id='gate-20261025T120000Z-aabbccdd';fs.mkdirSync(path.join(jobs,id));
  assert.equal(jobPath(id,root),path.join(jobs,id));
  for(const name of ['../outside','/absolute','not-a-job','gate-20261025T120000Z-aabbccdd/extra'])
    assert.throws(()=>jobPath(name,root),/job|path/i);
  fs.rmSync(path.join(jobs,id),{recursive:true});
  fs.mkdirSync(path.join(root,'outside'));fs.symlinkSync(path.join(root,'outside'),path.join(jobs,id));
  assert.throws(()=>jobPath(id,root),/owned|outside|alias/i);
});

test('candidate execution receives owned data, stamps and runtime without operator settings',()=>{
  const env=executionEnvironment({directory:'/owned/job',manifest:{workspace:'/owned/job/workspace',hub:'/owned/job/workspace/era-hub',suffix:'--wt-feature',seedDir:'/owned/job/workspace/era-family/test-data'}});
  assert.equal(env.ERA_DATA_DIR,'/owned/job/workspace/era-family/test-data');
  assert.equal(env.ERA_GATE_STAMPS,'/owned/job/issued-stamps');
  assert.equal(env.ERA_WT_SUFFIX,'--wt-feature');
  assert.equal(env.ERA_TEST_PORT,'8388');
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH,'/owned/job/runtime/browsers');
  assert.ok(env.PATH.startsWith('/owned/job/runtime/bin:'));
  for(const key of ['HOME','NODE_OPTIONS','ERA_GATE_MODE','ERA_GATE_SELECTED','ERA_PRESENCE_HOOK','ERA_CHAT_RUNTIME','API_KEY'])
    assert.equal(Object.hasOwn(env,key),false,key+' must not be inherited');
});

test('the isolated gate runs one lane, the lane count its admission budget records',()=>{
  // era-gate.sh defaults to two lanes; a second two-lane gate beside the legacy one would swap.
  const env=executionEnvironment({directory:'/owned/job',manifest:{workspace:'/owned/job/workspace',hub:'/owned/job/workspace/era-hub',suffix:'',seedDir:'/owned/job/workspace/era-family/test-data'}});
  assert.equal(env.ERA_GATE_LANES,'1');
  const admission=inspectCapacity({meminfoText:'MemTotal: 8388608 kB\nMemAvailable: 4194304 kB\n',allowedCpusText:'0-3',freeDiskBytes:4*1024**3});
  assert.equal(env.ERA_GATE_LANES,String(admission.resources.gateLanes));
});

test('progress keeps source gate outcomes and never treats a partial summary as complete',()=>{
  const p=parseProgress('PASS run\nRUN sample.test.mjs\nFAIL sample.test.mjs (see report)\n== affected tests: 1 passed; failures=0; no full stamp ==\n');
  assert.equal(p.completed,2);assert.equal(p.failed,1);assert.equal(p.lastSuite,'sample.test.mjs');
  assert.equal(p.summary,null);
  assert.equal(parseProgress('== era-gate: 2 passed, 0 failed ==\n').summary.passed,2);
});

test('queue estimates remain unknown until an actual completed full gate exists',()=>{
  assert.equal(estimateQueue([],2).seconds,null);
  const result=estimateQueue([
    {status:'stale',reason:'Origin HEAD moved',result:{valid:true,gateExitCode:0,summary:'== era-gate: 140 passed, 0 failed ==',gateSeconds:1200}},
    {status:'failed',result:{valid:false,gateExitCode:1,summary:'== era-gate: 139 passed, 1 failed ==',gateSeconds:2}},
    {status:'passed',result:{valid:true,gateExitCode:0,summary:'== era-gate: 143 passed, 0 failed ==',gateSeconds:1800}},
  ],2);
  assert.equal(result.samples,2);assert.equal(result.seconds,3000);
});

test('historical full pilot reporting survives stale origins without accepting incomplete proof',()=>{
  const result={valid:true,gateExitCode:0,summary:'== era-gate: 140 passed, 0 failed ==',gateSeconds:2042};
  const stale={status:'stale',reason:'Origin HEAD moved',stamps:null,result};
  assert.deepEqual(recordedGateStats([stale],1),{fullPilotValidated:true,eta:estimateQueue([stale],1)});
  assert.equal(stale.status,'stale');assert.equal(stale.stamps,null);
  for(const invalid of [
    {...result,valid:false}, {...result,gateExitCode:1}, {...result,summary:'== affected tests: 1 passed; failures=0; no full stamp =='},
    {...result,summary:null}, {...result,summary:'== era-gate: 0 passed, 0 failed =='}, {...result,summary:'== era-gate: 139 passed, 1 failed =='},
    {...result,gateSeconds:0}, {...result,gateSeconds:NaN}, {...result,gateSeconds:undefined},
  ]) {
    const stats=recordedGateStats([{status:'passed',result:invalid}],2);
    assert.equal(stats.fullPilotValidated,false);assert.equal(stats.eta.samples,0);assert.equal(stats.eta.seconds,null);
  }
  assert.equal(recordedGateStats([{status:'passed'}],1).fullPilotValidated,false);
  assert.equal(recordedGateStats([{status:'failed',result:{...result,valid:false}}],1).fullPilotValidated,false);
});

test('runtime identity covers file bytes, links and mode, and rejects escaping links',t=>{
  const root=scratch(t);fs.mkdirSync(path.join(root,'bin'));fs.writeFileSync(path.join(root,'bin/tool'),'fixed');fs.chmodSync(path.join(root,'bin/tool'),0o755);
  fs.symlinkSync('bin/tool',path.join(root,'tool'));
  const manifest=runtimeManifest(root);assert.equal(verifyRuntime(root,manifest).valid,true);
  fs.chmodSync(path.join(root,'bin/tool'),0o644);assert.equal(verifyRuntime(root,manifest).valid,false);
  fs.chmodSync(path.join(root,'bin/tool'),0o755);fs.writeFileSync(path.join(root,'bin/tool'),'changed');assert.equal(verifyRuntime(root,manifest).valid,false);
  fs.symlinkSync('/unowned/secret',path.join(root,'escape'));
  assert.throws(()=>runtimeManifest(root),/escape|outside/i);
});

test('job control code is copied under the job and cannot reference a mutable driver',t=>{
  const root=scratch(t),source=path.join(root,'source'),job=path.join(root,'job');fs.mkdirSync(source);fs.mkdirSync(job);
  fs.writeFileSync(path.join(source,'a.mjs'),'first');fs.writeFileSync(path.join(source,'b.py'),'second');
  const copied=copyControlBundle(job,[path.join(source,'a.mjs'),path.join(source,'b.py')]);
  fs.writeFileSync(path.join(source,'a.mjs'),'changed');
  assert.equal(fs.readFileSync(copied.files[0],'utf8'),'first');
  assert.ok(copied.files.every(file=>file.startsWith(job+path.sep)));
});

test('the actual Python worker imports its monitor without changing frozen control bytes',t=>{
  const directory=scratch(t),emptyJob=path.join(directory,'empty-job');fs.mkdirSync(emptyJob);
  const monitor=fileURLToPath(new URL('../tools/testing/parallel_monitor.py',import.meta.url));
  const control=copyControlBundle(directory,[PYTHON,monitor]);
  const result=spawnSync('python3',[path.join(control.directory,'testing/parallel-worker.py'),'run',emptyJob],{encoding:'utf8',env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin'}});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/request\.json/,'the worker must have passed its monitor import before refusing the absent request');
  assert.equal(verifyRuntime(control.directory,control.manifest).valid,true,'imports must not create bytecode inside frozen control');
});

test('worker cleanup joins only its captured child before releasing admission',()=>{
  const program=`
import pathlib,runpy,subprocess,sys,tempfile
worker=runpy.run_path(sys.argv[1]);release=[]
child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])
record=worker['identity'](child.pid)
def released(job,command):
    assert command=='_release'
    assert child.poll() is not None, 'lease released before owned child exit'
    release.append(command)
    return {'released':True}
try:
    function=worker['release_owned_job'];function.__globals__['run_internal']=released
    wrong={**record,'startTicks':str(int(record['startTicks'])+1)}
    try:function(pathlib.Path(tempfile.gettempdir()),child,wrong,True)
    except RuntimeError:pass
    else:raise AssertionError('changed child identity was accepted')
    assert child.poll() is None and not release, 'unknown child was signalled or admission released'
    function(pathlib.Path(tempfile.gettempdir()),child,record,True)
    assert child.poll() is not None and release==['_release']
finally:
    worker['stop_owned'](child,record)
`;
  const result=spawnSync('python3',['-c',program,PYTHON],{encoding:'utf8',timeout:15000,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin'}});
  assert.equal(result.status,0,result.stderr || result.stdout || result.error?.message);
});

test('a running isolated job holds a host gate slot, and cleanup removes only its own',t=>{
  // Host gates (tools/era-gate.sh) count it toward ERA_GATE_MAX_GATES; the gate
  // inside cannot write it, behind a private /tmp and PID namespace.
  const slots=path.join(scratch(t),'slots');
  const program=`
import pathlib,runpy,subprocess,sys
worker=runpy.run_path(sys.argv[1]);slots=pathlib.Path(sys.argv[2])
child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])
try:
    record=worker['identity'](child.pid)
    file=worker['register_gate_slot'](record,1,'/owned/job/workspace/era-hub','gate-x',slots)
    lines=file.read_text().splitlines()
    assert file==slots/str(child.pid),file
    assert lines[:3]==['pid='+str(child.pid),'start='+record['startTicks'],'lanes=1'],lines
    for line in ['hub=/owned/job/workspace/era-hub','isolated=1','runner=gate-x']:assert line in lines,lines
    assert any(line.startswith('at=') and line[3:].isdigit() for line in lines),lines
    worker['release_gate_slot']({**record,'startTicks':str(int(record['startTicks'])+1)},slots)
    assert file.exists(),'a slot naming another process was removed'
    worker['release_gate_slot'](record,slots);assert not file.exists()
    worker['release_gate_slot'](record,slots)
finally:
    child.kill();child.wait()
`;
  const result=spawnSync('python3',['-c',program,PYTHON,slots],{encoding:'utf8',timeout:15000,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin'}});
  assert.equal(result.status,0,result.stderr || result.stdout || result.error?.message);
  const source=fs.readFileSync(PYTHON,'utf8'),worker=source.slice(source.indexOf('def worker('));
  const launched=worker.indexOf('namespace_record=identity(child.pid)'),registered=worker.indexOf('register_gate_slot(');
  assert.ok(launched>0 && registered>launched,'the job registers once its namespace launcher is captured');
  assert.ok(worker.indexOf('release_gate_slot(',worker.indexOf('finally:'))>0,'and releases its slot in cleanup');
});

test('isolated legacy cleanup cannot see the host and keeps its port and temporary lock independent',t=>{
  const directory=fs.mkdtempSync(path.join(process.env.ERA_PARALLEL_JOB_DIR || stateDirectory(),'namespace-test-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const proof=runPreflight(directory);
  assert.notEqual(proof.uid,0);assert.equal(BigInt('0x'+proof.capEff),0n);
  for(const key of ['freshProc','noEgress','fixedPortIndependent','temporaryLockIndependent','ownedInnerCanaryStopped','hostCanarySurvived','homeMasked','runMasked']) assert.equal(proof[key],true,key);
  assert.equal(proof.hostCanaryVisible,false);
  assert.equal(proof.hostHomeProbeVisible,false);
});

test('simulated host legacy cleanup leaves the isolated gate canary alive',t=>{
  const directory=fs.mkdtempSync(path.join(process.env.ERA_PARALLEL_JOB_DIR || stateDirectory(),'reverse-test-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const proof=runReversePreflight(directory);
  assert.equal(proof.hostLegacyPort,8378);assert.equal(proof.legacyControlPort,8387);assert.equal(proof.isolatedGatePort,8388);
  assert.equal(proof.hostLegacyPatternMatched,false);
  assert.equal(proof.legacyHostCanaryStopped,true);
  assert.equal(proof.isolatedGateCanarySurvived,true);
  assert.equal(proof.freshProc,true);assert.equal(proof.homeMasked,true);
});

test('changed pinned control inputs revoke exposed proof during status refresh',async t=>{
  const directory=scratch(t),control=path.join(directory,'control');fs.mkdirSync(control);
  fs.writeFileSync(path.join(control,'driver'),'original');
  fs.writeFileSync(path.join(directory,'request.json'),JSON.stringify({id:'owned',control:runtimeManifest(control)}));
  fs.writeFileSync(path.join(directory,'status.json'),JSON.stringify({status:'passed'}));
  fs.mkdirSync(path.join(directory,'exposed-stamps'));fs.writeFileSync(path.join(directory,'exposed-stamps','receipt'),'old');
  fs.writeFileSync(path.join(control,'driver'),'changed');
  const result=await readStatus(directory);
  assert.equal(result.status,'stale');assert.equal(result.stamps,null);
  assert.equal(fs.existsSync(path.join(directory,'exposed-stamps')),false);
});
