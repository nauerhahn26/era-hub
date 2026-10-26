#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {prepareWindowsRun,runWindowsJob,runWindowsPreparation,windowsState,verifyWindowsInputs,claimWindowsJob} from './testing/windows-runner.mjs';
import {atomicJSON} from './testing/parallel-worker.mjs';

const args=process.argv.slice(2),command=args.shift();
const option=(name,fallback)=>{const at=args.indexOf(name);return at<0?fallback:args[at+1];};
const output=value=>console.log(JSON.stringify(value,null,2));
try {
  if(command==='prepare') {
    const job=prepareWindowsRun({hub:option('--hub'),dist:option('--dist'),familyTools:option('--family-tools'),
      suffix:option('--suffix',''),state:option('--state',windowsState()),cdpPort:Number(option('--cdp-port','8511')),slot:option('--slot','managed'),applicationManifest:option('--application-manifest',null),preparationManifest:option('--preparation-manifest',null)});
    output({id:job.id,directory:job.directory,status:'prepared',expectedCases:job.expectedCases,provisioned:false});
  }else if(command==='run') {
    const directory=path.resolve(args[0]),secret=option('--secret-env'),api=option('--api-env'),leases=option('--lease-dir');
    if(!path.isAbsolute(secret || '') || !path.isAbsolute(api || '') || !path.isAbsolute(leases || ''))throw Error('Explicit private secret/API/legacy-lease paths required');
    const job=JSON.parse(fs.readFileSync(path.join(directory,'job.json'),'utf8'));
    const state=JSON.parse(fs.readFileSync(path.join(directory,'status.json'),'utf8'));
    if(state.status!=='prepared')throw Error('Only a fresh prepared job can launch');
    const check=verifyWindowsInputs(job);if(!check.valid)throw Error(check.reasons.join('; '));
    claimWindowsJob(directory);atomicJSON(path.join(directory,'status.json'),{status:'launching',updated:new Date().toISOString()});
    const log=fs.openSync(path.join(directory,'worker.log'),'a',0o600);
    const node=path.join(job.control,'node'),cli=path.join(job.control,'tools/windows-gate.mjs');
    const workerArgs=[cli,'_run',directory,'--secret-env',secret,'--api-env',api,'--lease-dir',leases];
    const legacy='exec 6>/tmp/era-vm-e2e.lock\nif ! flock -n 6; then exec "$1" "$2" _blocked "$4"; fi\nexport QA_VM_LOCK_FD=6\nexec "$@"';
    const child=job.slot==='legacy'?spawn('bash',['-c',legacy,'windows-legacy',node,...workerArgs],{detached:true,stdio:['ignore',log,log],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}):spawn(node,workerArgs,{detached:true,stdio:['ignore',log,log],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    fs.closeSync(log);child.unref();output({id:job.id,directory,workerPid:child.pid});
  }else if(command==='_run') {
    const result=await runWindowsJob(args[0],{secretEnv:option('--secret-env'),apiEnv:option('--api-env'),leaseDir:option('--lease-dir')});output(result);process.exitCode=result.valid?0:1;
  }else if(command==='_initialize') {
    const result=await runWindowsPreparation(args[0]);output(result);process.exitCode=result.valid?0:1;
  }else if(command==='_blocked') {
    atomicJSON(path.join(path.resolve(args[0]),'status.json'),{status:'blocked',error:'Legacy Windows slot is occupied; no host allocated'});process.exitCode=75;
  }else if(command==='status') {
    const directory=path.resolve(args[0]),job=JSON.parse(fs.readFileSync(path.join(directory,'job.json'),'utf8'));
    output({id:job.id,...JSON.parse(fs.readFileSync(path.join(directory,'status.json'),'utf8')),currentInputs:verifyWindowsInputs(job),result:fs.existsSync(path.join(directory,'result.json'))?JSON.parse(fs.readFileSync(path.join(directory,'result.json'),'utf8')):null});
  }else console.log('Usage: windows-gate.mjs prepare --hub ABS --dist ABS --family-tools ABS [--suffix SUFFIX] [--cdp-port 8511] [--slot managed|legacy] [--preparation-manifest ABS] [--application-manifest ABS]\n  run JOB --secret-env ABS --api-env ABS --lease-dir ABS\n  status JOB\nRuns the complete patch baseline B, optional native initialization after pristine revert, and an optional application entry on the same host. It never publishes or writes a Linux green stamp; application receipts require owner review.');
}catch(error){console.error('windows-gate: '+error.message);process.exitCode=1;}
