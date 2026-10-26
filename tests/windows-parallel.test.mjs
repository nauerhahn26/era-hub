import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { freezeArtifacts, verifyArtifactCopies, freezeApplication, verifyApplication, validateWindowsTap, bindVmLibrary, bindVmRunner, bindVmEnvironment, bindVmRevert, claimWindowsJob, probeFreeLoopback, requireFreeCdp, runWindowsJob, runWindowsPreparation } from '../tools/testing/windows-runner.mjs';
import net from 'node:net';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'era-windows-proof-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'dist');fs.mkdirSync(source);
  const feed={version:'v1.2.3',build:'20261026.0001',installer:'v1.2.0',installer_file:'Our-Era-Comms-Setup.exe',sha256:sha('payload')};
  const files={'HEAD':'1'.repeat(40),'TREE':'2'.repeat(40),'latest.json':JSON.stringify(feed),'checksums.txt':'fixture','Our-Era-Comms-Setup.exe':'installer','new-era-suite.tar.gz':'payload','new-era-suite-v1.2.3.tar.gz':'payload','new-era-suite.zip':'zip'};
  for(const [name,bytes] of Object.entries(files))fs.writeFileSync(path.join(source,name),bytes);
  return {root,source,destination:path.join(root,'frozen'),feed};
}
test('artifact snapshots preserve all eight inputs and detect later source or copy mutation',t=>{
  const f=fixture(t),manifest=freezeArtifacts(f);
  assert.equal(Object.keys(manifest.files).length,8);assert.equal(verifyArtifactCopies(manifest).valid,true);
  fs.writeFileSync(path.join(f.source,'new-era-suite.zip'),'changed');
  assert.equal(verifyArtifactCopies(manifest).valid,false);
  fs.writeFileSync(path.join(f.source,'new-era-suite.zip'),'zip');
  assert.equal(verifyArtifactCopies(manifest).valid,true);
  fs.chmodSync(path.join(f.destination,'HEAD'),0o600);
  fs.writeFileSync(path.join(f.destination,'HEAD'),'changed');
  assert.equal(verifyArtifactCopies(manifest).valid,false);
});
test('artifact preparation refuses aliases, missing files and mismatched payload bytes',t=>{
  for(const mode of ['symlink','missing','wrong hash','wrong versioned payload']) {
    const f=fixture(t),file=path.join(f.source,'new-era-suite.tar.gz');
    if(mode==='symlink'){fs.renameSync(file,file+'.real');fs.symlinkSync(file+'.real',file);}
    else if(mode==='missing')fs.unlinkSync(file);
    else if(mode==='wrong hash')fs.writeFileSync(file,'wrong');
    else fs.writeFileSync(path.join(f.source,'new-era-suite-v1.2.3.tar.gz'),'wrong');
    assert.throws(()=>freezeArtifacts(f),undefined,mode);
  }
});
test('artifact preparation refuses writing into the original dist',t=>{
  const f=fixture(t);assert.throws(()=>freezeArtifacts({...f,destination:path.join(f.source,'copy')}));
});
test('unsupported signed cuts refuse before copying or allocating anything',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.source,'latest.json'),JSON.stringify({...f.feed,version:'v1.2.0'}));
  assert.throws(()=>freezeArtifacts(f),/patch baseline only/);assert.equal(fs.existsSync(f.destination),false);
});
test('optional application closure pins its manifest, entry and imported files in both locations',t=>{
  const f=fixture(t),source=path.join(f.root,'application');fs.mkdirSync(source);
  fs.writeFileSync(path.join(source,'run.mjs'),'import "./helper.mjs";');fs.writeFileSync(path.join(source,'helper.mjs'),'export const fixture=true;');
  const manifest=path.join(source,'manifest.json');fs.writeFileSync(manifest,JSON.stringify({version:1,id:'installed-games',entry:'run.mjs',files:['run.mjs','helper.mjs']}));
  const frozen=freezeApplication({manifest,destination:path.join(f.root,'copied-application')});
  assert.equal(verifyApplication(frozen).valid,true);
  assert.equal(verifyApplication({...frozen,entry:'helper.mjs'}).valid,false,'the selected entry must remain the one declared in the pinned manifest');
  fs.writeFileSync(path.join(source,'helper.mjs'),'changed');assert.equal(verifyApplication(frozen).valid,false);
  fs.writeFileSync(path.join(source,'helper.mjs'),'export const fixture=true;');assert.equal(verifyApplication(frozen).valid,true);
  const copied=path.join(frozen.root,'helper.mjs');fs.chmodSync(copied,0o600);fs.writeFileSync(copied,'changed');assert.equal(verifyApplication(frozen).valid,false);
  fs.writeFileSync(copied,'export const fixture=true;');fs.chmodSync(copied,0o400);assert.equal(verifyApplication(frozen).valid,true);
  fs.writeFileSync(manifest,'{}');assert.equal(verifyApplication(frozen).valid,false);
});
test('application closure refuses escape paths, aliases, omitted entries and duplicate files',t=>{
  for(const mode of ['escape','alias','omitted','duplicate']) {
    const f=fixture(t),source=path.join(f.root,'application');fs.mkdirSync(source);
    fs.writeFileSync(path.join(source,'run.mjs'),'fixture');
    const files=mode==='escape'?['../outside.mjs']:mode==='omitted'?['helper.mjs']:mode==='duplicate'?['run.mjs','run.mjs']:['run.mjs'];
    if(mode==='alias'){fs.renameSync(path.join(source,'run.mjs'),path.join(source,'actual.mjs'));fs.symlinkSync('actual.mjs',path.join(source,'run.mjs'));}
    const manifest=path.join(source,'manifest.json');fs.writeFileSync(manifest,JSON.stringify({version:1,id:'fixture',entry:'run.mjs',files}));
    assert.throws(()=>freezeApplication({manifest,destination:path.join(f.root,'copied')}),undefined,mode);
  }
});
test('complete Windows TAP requires the exact positive count and zero failure or omissions',()=>{
  const tap=n=>`1..${n}\n# tests ${n}\n# pass ${n}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  assert.equal(validateWindowsTap(tap(9),9).valid,true);
  for(const text of [tap(8),tap(0),tap(9).replace('# skipped 0','# skipped 1'),tap(9).replace('# cancelled 0','# cancelled 1'),tap(9)+'not ok 10 - failure\n',tap(9)+tap(9)])assert.equal(validateWindowsTap(text,9).valid,false);
});
test('VM library binding changes only its reviewed transport-directory declaration',()=>{
  const original='const HUB = "source";\nconst VMTOOLS = path.join(path.dirname(HUB), "era-family", "tools", "vm");\nexport const assertion = 42;\n';
  const bound=bindVmLibrary(original,'/owned/job/helpers');
  assert.match(bound,/const VMTOOLS = "\/owned\/job\/helpers";/);
  assert.equal(bound.split('\n')[2],original.split('\n')[2]);
  assert.throws(()=>bindVmLibrary(original+original,'/owned/job/helpers'));
  assert.throws(()=>bindVmLibrary('unknown helper format','/owned/job/helpers'));
});
test('staged environment refusal exits callers that did not enable shell error handling',t=>{
  const f=fixture(t),environment=path.join(f.root,'env.sh'),invalid=path.join(f.root,'invalid.sh'),marker=path.join(f.root,'marker');
  fs.writeFileSync(invalid,'return 7\n');fs.writeFileSync(environment,bindVmEnvironment(invalid));
  const result=spawnSync('bash',['-c','. "$1"\nprintf reached > "$2"','caller',environment,marker]);
  assert.equal(result.status,7);assert.equal(fs.existsSync(marker),false);
});
test('preparation adapter invokes the stock revert first and stops on revert refusal',t=>{
  const f=fixture(t),original=path.join(f.root,'revert-original.sh'),cli=path.join(f.root,'cli.mjs'),events=path.join(f.root,'events');
  fs.writeFileSync(cli,"import fs from 'node:fs';fs.appendFileSync(process.argv[3]+'/events','preparation\\n');");
  const bound=bindVmRevert({original,node:process.execPath,cli,directory:f.root});
  fs.writeFileSync(original,'printf "revert\\n" >> "'+events+'"\nexit 3\n');
  assert.equal(spawnSync('bash',[],{input:bound}).status,3);assert.equal(fs.readFileSync(events,'utf8'),'revert\n');
  fs.writeFileSync(original,'printf "revert\\n" >> "'+events+'"\n');
  assert.equal(spawnSync('bash',[],{input:bound}).status,0);assert.equal(fs.readFileSync(events,'utf8'),'revert\nrevert\npreparation\n');
});
test('stock VM control adaptation removes shared tunnel cleanup and binds only owned resources',()=>{
  const original=fs.readFileSync(new URL('../tools/vm-e2e.sh',import.meta.url),'utf8');
  const bound=bindVmRunner(original);
  assert.doesNotMatch(bound,/pkill|killall/);
  assert.doesNotMatch(bound,/exec 9>\/tmp\/era-vm-e2e.lock/);
  assert.match(bound,/WINDOWS_JOB_DIR/);assert.match(bound,/windows-transport.py/);
  assert.equal(/rsync[^\n]*-e "ssh -i/.test(bound),false,'artifact transfer must use its own SSH trust file');
  assert.equal(/rsync[^\n]*UserKnownHostsFile=\$QA_KNOWN_HOSTS/.test(bound),true);
  const leg=source=>source.slice(source.indexOf('run_leg()'),source.indexOf('if [ "$POST" = 1 ]; then\n  run_leg'));
  assert.equal(leg(bound),leg(original),'test execution body is unchanged');
  assert.equal(spawnSync('bash',['-n'],{input:bound}).status,0);
  assert.throws(()=>bindVmRunner('unrecognized control script'));
});
test('Python transport and owned-process negative checks pass without cloud access',()=>{
  const result=spawnSync('python3',['-B',new URL('../tools/testing/test/windows_transport_test.py',import.meta.url).pathname],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
test('job launch is claimed once and occupied CDP ports are refused without stopping listeners',async t=>{
  const f=fixture(t);claimWindowsJob(f.root);assert.throws(()=>claimWindowsJob(f.root));
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  t.after(()=>listener.close());await assert.rejects(probeFreeLoopback(listener.address().port),{code:'EADDRINUSE'});assert.equal(listener.listening,true);
  for(const port of [0,8499,8600])await assert.rejects(requireFreeCdp(port),/Invalid managed CDP port/);
});
function workerFixture(t,{skip=false,cleanupFailure=false,application=false,applicationFailure=false,applicationTamper=false,hold=false}={}) {
  const f=fixture(t),job=f.root,control=path.join(job,'control'),helpers=path.join(job,'helpers'),executionHub=path.join(job,'execution');
  for(const p of [path.join(control,'tools/testing'),helpers,executionHub])fs.mkdirSync(p,{recursive:true});
  const manager=`import json,os,pathlib,sys\np=pathlib.Path(os.environ['WINDOWS_JOB_DIR']);a=sys.argv[1]\nwith (p/'events').open('a') as f:f.write(a+'\\n')\nif a=='up':\n (p/'private').mkdir(exist_ok=True);(p/'private/resource.json').write_text('{}');(p/'transport').mkdir();(p/'transport/bootstrap.json').write_text('{}')\nif a=='down' and ${cleanupFailure?'True':'False'}:sys.exit(3)\nprint(json.dumps({'runId':os.environ['QA_RUN_ID'],'slot':os.environ['QA_SLOT'],'status':'ready' if a=='up' else 'deleted','ready':a=='up','resourceId':'123','guestUser':'fixture-user','owner':{'pid':int(os.environ['QA_OWNER_PID']),'startTicks':os.environ['QA_OWNER_START_TICKS']}}))\n`;
  fs.writeFileSync(path.join(helpers,'parallel-qa.py'),manager);
  fs.writeFileSync(path.join(control,'tools/testing/windows-transport.py'),"import os,pathlib\np=pathlib.Path(os.environ['WINDOWS_JOB_DIR'])\nwith (p/'events').open('a') as f:f.write('transport\\n')\n");
  const runner=path.join(job,'runner.sh');
  fs.writeFileSync(runner,`#!/bin/bash\nmkdir -p "$WINDOWS_JOB_DIR/vm-out"\nprintf ran > "$WINDOWS_JOB_DIR/ran"\ncat > "$WINDOWS_JOB_DIR/vm-out/leg-b.log" <<'TAP'\n1..9\n# tests9\n# pass9\n# fail0\n# cancelled0\n# skipped${skip?1:0}\n# todo0\nTAP\n`.replaceAll(/# (tests|pass|fail|cancelled|skipped|todo)(\d)/g,'# $1 $2'));
  if(hold)fs.appendFileSync(runner,'cat "/proc/$$/cmdline" > "$WINDOWS_JOB_DIR/executed-argv"\nsleep 0.08\n');
  const meta={version:2,id:path.basename(job),directory:job,slot:'managed',only:'b',cdpPort:8595,expectedCases:9,control,helpers,executionHub,runner,manifest:{origins:{}},artifacts:{destination:f.source,head:'1'.repeat(40),tree:'2'.repeat(40),versionTag:'v1.2.3',build:'20261026.0001'}};
  if(application) {
    const root=path.join(job,'application');fs.mkdirSync(root);fs.symlinkSync(process.execPath,path.join(control,'node'));
    const library=path.join(executionHub,'tests-vm/lib/vm.mjs');fs.mkdirSync(path.dirname(library),{recursive:true});fs.writeFileSync(library,'export const fixture=true;');
    fs.writeFileSync(path.join(root,'run.mjs'),`import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';\nassert.equal(process.env.VM_GUEST_USER,'fixture-user');assert.equal(process.env.VM_CANDIDATE_BUILD,'20261026.0001');assert.equal(process.env.VM_DIST,${JSON.stringify(f.source)});assert.equal(process.env.WINDOWS_PHASE,'application');assert.ok(process.env.ERA_VM_MODULE_SHA256);assert.equal(process.env.VM_OUT,path.join(process.env.WINDOWS_JOB_DIR,'application-out'));assert.ok(fs.existsSync(path.join(process.env.WINDOWS_JOB_DIR,'vm-out/leg-b.log')));fs.appendFileSync(path.join(process.env.WINDOWS_JOB_DIR,'events'),'application\\n');process.exitCode=${applicationFailure?1:0};`);
    if(applicationTamper)fs.appendFileSync(path.join(root,'run.mjs'),"fs.appendFileSync(path.join(process.env.WINDOWS_JOB_DIR,'vm-out/leg-b.log'),'changed\\n');");
    meta.application={id:'fixture',root,entry:'run.mjs'};
  }
  fs.writeFileSync(path.join(job,'job.json'),JSON.stringify(meta));
  return {job,options:{secretEnv:path.join(job,'secret.env'),apiEnv:path.join(job,'api.env'),leaseDir:path.join(job,'leases'),verifyInputs:()=>({valid:true,reasons:[]}),checkCdp:async()=>{}}};
}
test('an occupied-port preflight failure stops the worker before any allocation',async t=>{
  const f=workerFixture(t),result=await runWindowsJob(f.job,{...f.options,checkCdp:async()=>{throw Error('owned port busy');}});
  assert.equal(result.valid,false);assert.equal(result.error,'owned port busy');assert.equal(fs.existsSync(path.join(f.job,'events')),false);
  assert.equal(result.completeReleaseEvidence,false);
});
test('worker waits for its actual complete TAP then tears down transport before host',async t=>{
  const f=workerFixture(t),result=await runWindowsJob(f.job,f.options);
  assert.equal(result.valid,true,result.error);assert.equal(result.completeReleaseEvidence,false);
  assert.equal(fs.readFileSync(path.join(f.job,'events'),'utf8'),'up\ntransport\ndown\n');
  assert.equal(result.tap.counts.tests,9);assert.ok(result.child.pid>1);
});
test('worker receipts distinguish the permit wrapper from its observed executed command',async t=>{
  const f=workerFixture(t,{hold:true}),result=await runWindowsJob(f.job,f.options);
  assert.equal(result.valid,true,result.error);
  const identity=result.baselineExit.identity;
  assert.equal(identity.captureStage,'execution');
  assert.equal(identity.commandHash,sha(fs.readFileSync(path.join(f.job,'executed-argv'))));
  assert.equal(identity.execution.commandHash,identity.commandHash);
  assert.equal(identity.startTicks,identity.launchIdentity.startTicks);
  assert.notEqual(identity.commandHash,identity.launchIdentity.commandHash);
});
test('worker refuses skipped cases and cleanup failure despite a zero child exit',async t=>{
  for(const options of [{skip:true},{cleanupFailure:true}]) {
    const f=workerFixture(t,options),result=await runWindowsJob(f.job,f.options);
    assert.equal(result.valid,false);assert.equal(result.completeReleaseEvidence,false);
    assert.equal(fs.readFileSync(path.join(f.job,'events'),'utf8'),'up\ntransport\ndown\n');
  }
});
test('failure before the execution permit closes and reaps its owned shell before cleanup',async t=>{
  const f=workerFixture(t),result=await runWindowsJob(f.job,{...f.options,captureChildIdentity:()=>{throw Error('capture refused');}});
  assert.equal(result.valid,false);assert.equal(result.error,'capture refused');assert.equal(fs.existsSync(path.join(f.job,'ran')),false);
  assert.equal(fs.readFileSync(path.join(f.job,'events'),'utf8'),'up\ntransport\ndown\n');
});
test('pinned application runs after complete baseline and before owned teardown',async t=>{
  const f=workerFixture(t,{application:true}),result=await runWindowsJob(f.job,f.options);
  assert.equal(result.valid,true,result.error);assert.equal(result.completeReleaseEvidence,false);
  assert.equal(fs.readFileSync(path.join(f.job,'events'),'utf8'),'up\napplication\ntransport\ndown\n');
  assert.equal(result.application.executed,true);assert.equal(result.application.exitCode,0);
  assert.equal(fs.existsSync(path.join(f.job,'application-out')),true);
});
test('application failure still cleans up and incomplete baseline never starts the application',async t=>{
  for(const options of [{application:true,applicationFailure:true},{application:true,skip:true}]) {
    const f=workerFixture(t,options),result=await runWindowsJob(f.job,f.options);
    assert.equal(result.valid,false);assert.equal(result.completeReleaseEvidence,false);
    assert.equal(fs.readFileSync(path.join(f.job,'events'),'utf8'),options.skip?'up\ntransport\ndown\n':'up\napplication\ntransport\ndown\n');
  }
});
test('native preparation runs once with its own output and records a verified phase receipt',async t=>{
  const f=workerFixture(t,{application:true}),file=path.join(f.job,'job.json'),job=JSON.parse(fs.readFileSync(file));
  job.preparation=job.application;job.application=null;
  fs.writeFileSync(path.join(job.preparation.root,'run.mjs'),"import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(process.env.WINDOWS_PHASE,'preparation');assert.ok(process.env.VM_OUT.endsWith('/preparation-out'));fs.writeFileSync(process.env.VM_OUT+'/native.json','fixture');");
  fs.writeFileSync(file,JSON.stringify(job));
  const result=await runWindowsPreparation(f.job,{verifyInputs:f.options.verifyInputs,verifyContext:()=>true});
  assert.equal(result.valid,true,result.error);assert.equal(result.acceptanceClaim,false);assert.equal(result.exitCode,0);
  assert.equal(fs.existsSync(path.join(f.job,'preparation-out/native.json')),true);
  await assert.rejects(runWindowsPreparation(f.job,{verifyInputs:f.options.verifyInputs,verifyContext:()=>true}),/exist/);
});
test('preparation context refusal or failed entry cannot produce a successful receipt',async t=>{
  for(const badContext of [true,false]) {
    const f=workerFixture(t,{application:true}),file=path.join(f.job,'job.json'),job=JSON.parse(fs.readFileSync(file));job.preparation=job.application;job.application=null;
    fs.writeFileSync(path.join(job.preparation.root,'run.mjs'),'process.exitCode=3;');fs.writeFileSync(file,JSON.stringify(job));
    const options={verifyInputs:f.options.verifyInputs,verifyContext:()=>!badContext};
    if(badContext){await assert.rejects(runWindowsPreparation(f.job,options),/context.*refused/);assert.equal(fs.existsSync(path.join(f.job,'preparation.claim')),false);}
    else{const result=await runWindowsPreparation(f.job,options);assert.equal(result.valid,false);assert.equal(result.exitCode,3);assert.equal(result.acceptanceClaim,false);}
  }
});
test('a complete baseline cannot pass a required but unexecuted preparation',async t=>{
  const f=workerFixture(t,{application:true}),file=path.join(f.job,'job.json'),job=JSON.parse(fs.readFileSync(file));job.preparation=job.application;job.application=null;fs.writeFileSync(file,JSON.stringify(job));
  const result=await runWindowsJob(f.job,f.options);assert.equal(result.valid,false);assert.equal(result.completeReleaseEvidence,false);
  assert.equal(fs.readFileSync(path.join(f.job,'events'),'utf8'),'up\ntransport\ndown\n');
});
test('application execution cannot overwrite a previously complete baseline log',async t=>{
  const f=workerFixture(t,{application:true,applicationTamper:true}),result=await runWindowsJob(f.job,f.options);
  assert.equal(result.valid,false);assert.match(result.error,/changed the baseline evidence/);assert.equal(result.application.acceptanceClaim,false);
  assert.equal(fs.readFileSync(path.join(f.job,'events'),'utf8'),'up\napplication\ntransport\ndown\n');
});
