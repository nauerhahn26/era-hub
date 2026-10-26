import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inspectCapacity, acquireLease, readLease, releaseLease, readHostResources, LIMITS } from '../parallel-capacity.mjs';

const GiB=1024**3;
const resources=(extra={})=>({meminfoText:'MemTotal: 8388608 kB\nMemAvailable: 4194304 kB\n',allowedCpusText:'0-3',freeDiskBytes:4*GiB,...extra});
const owner={pid:98765,startTicks:'123456',uid:process.getuid()};
const active=()=>({state:'active',...owner});
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'era-capacity-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const leaseDir=path.join(root,'capacity');
  const options={leaseDir,jobId:'job-a',ownerPid:owner.pid,ownerStartTicks:owner.startTicks,readOwner:active,readResources:()=>resources()};
  return {root,leaseDir,options};
}

test('fixed admission leaves one legacy slot, one CPU and one GiB headroom',()=>{
  const check=inspectCapacity(resources());
  assert.equal(check.admissible,true);
  assert.equal(check.resources.cpu,3); assert.deepEqual(check.resources.allowedCpus,[0,1,2,3]);
  assert.equal(check.resources.nice,19); assert.equal(check.resources.memoryLimitBytes,2*GiB);
  assert.equal(check.resources.memoryReserveBytes,GiB);
  assert.equal(check.limits.maxIsolatedWorkers,1); assert.equal(check.limits.reservedLegacySlots,1);
  assert.equal(check.limits.totalSlots,2);
  assert.equal(inspectCapacity(resources({meminfoText:'MemTotal: 8388608 kB\nMemAvailable: 3145728 kB\n',freeDiskBytes:3*GiB})).admissible,true);
});

test('memory and disk shortfalls refuse admission independently',()=>{
  const memory=inspectCapacity(resources({meminfoText:'MemTotal: 8388608 kB\nMemAvailable: 3145727 kB\n'}));
  assert.equal(memory.admissible,false); assert.match(memory.reasons.join(' '),/memory/i);
  const disk=inspectCapacity(resources({freeDiskBytes:3*GiB-1}));
  assert.equal(disk.admissible,false); assert.match(disk.reasons.join(' '),/disk/i);
});

test('unknown, inconsistent and malformed host observations fail closed',()=>{
  for(const change of [
    {meminfoText:''}, {meminfoText:'MemTotal: 4 kB\nMemAvailable: 8 kB\n'},
    {meminfoText:'MemTotal: 8388608 kB\nMemAvailable: unknown\n'},
    {allowedCpusText:''}, {allowedCpusText:'3-1'}, {allowedCpusText:'0-99999'},
    {freeDiskBytes:NaN}, {freeDiskBytes:undefined}, {freeDiskBytes:-1},
  ]) assert.equal(inspectCapacity(resources(change)).admissible,false,JSON.stringify(change));
});

test('sparse CPU affinity chooses its highest member and a single CPU cannot admit a worker',()=>{
  const check=inspectCapacity(resources({allowedCpusText:'Cpus_allowed_list:\t0,2,7-8'}));
  assert.equal(check.admissible,true); assert.equal(check.resources.cpu,8);
  assert.equal(inspectCapacity(resources({allowedCpusText:'3'})).admissible,false);
  assert.equal(Object.isFrozen(LIMITS),true);
});

test('one lease is admitted and a second cannot consume the legacy reservation',t=>{
  const f=fixture(t), first=acquireLease(f.options);
  assert.equal(first.acquired,true); assert.match(first.lease.token,/^[a-f0-9]{64}$/);
  assert.equal(first.lease.resources.cpu,3); assert.equal(first.lease.limits.maxIsolatedWorkers,1);
  const second=acquireLease({...f.options,jobId:'job-b'});
  assert.equal(second.acquired,false); assert.match(second.reason,/occupied|reserved/i);
  assert.equal(readLease({leaseDir:f.leaseDir,readOwner:active}).lease.jobId,'job-a');
  const released=releaseLease({...f.options,token:first.lease.token});
  assert.equal(released.released,true);
  assert.equal(acquireLease({...f.options,jobId:'job-b'}).acquired,true);
});

test('resources are read again while an exclusive admission reservation exists',t=>{
  const f=fixture(t); let observed=false;
  const result=acquireLease({...f.options,readResources:()=>{
    observed=fs.existsSync(path.join(f.leaseDir,'transition.lock')) && fs.existsSync(path.join(f.leaseDir,'slot.json'));
    return resources({freeDiskBytes:0});
  }});
  assert.equal(observed,true); assert.equal(result.acquired,false);
  assert.equal(readLease({leaseDir:f.leaseDir,readOwner:active}).state,'free');
  assert.equal(acquireLease({...f.options,readResources:()=>{throw new Error('Host probe unavailable');}}).acquired,false);
  assert.equal(readLease({leaseDir:f.leaseDir,readOwner:active}).state,'free');
});

test('wrong tokens and unrelated owner identities cannot release another job',t=>{
  const f=fixture(t), first=acquireLease(f.options), file=path.join(f.leaseDir,'slot.json');
  const original=fs.readFileSync(file,'utf8');
  assert.equal(releaseLease({...f.options,token:'0'.repeat(64)}).released,false);
  assert.equal(releaseLease({...f.options,token:first.lease.token,ownerStartTicks:'other'}).released,false);
  assert.equal(fs.readFileSync(file,'utf8'),original);
});

test('dead or reused owner PIDs remain occupied until explicit verified recovery',t=>{
  const f=fixture(t), first=acquireLease(f.options);
  const dead=()=>({state:'dead'});
  const status=readLease({leaseDir:f.leaseDir,readOwner:dead});
  assert.equal(status.ownerState,'dead'); assert.equal(status.recoveryRequired,true);
  assert.equal(acquireLease({...f.options,jobId:'job-b',readOwner:dead}).acquired,false);
  assert.equal(releaseLease({...f.options,token:first.lease.token,readOwner:dead}).released,false);
  const replaced=()=>({...owner,startTicks:'999999',state:'active'});
  assert.equal(readLease({leaseDir:f.leaseDir,readOwner:replaced}).ownerState,'replaced');
  assert.equal(releaseLease({...f.options,token:first.lease.token,readOwner:replaced}).released,false);
});

test('unknown owner identity refuses admission and never guesses an owner is dead',t=>{
  const f=fixture(t), unknown=()=>({state:'unknown',reason:'permission denied'});
  assert.equal(acquireLease({...f.options,readOwner:unknown}).acquired,false);
  const first=acquireLease(f.options); assert.equal(first.acquired,true);
  const state=readLease({leaseDir:f.leaseDir,readOwner:unknown});
  assert.equal(state.ownerState,'unknown'); assert.equal(state.recoveryRequired,true);
  assert.equal(releaseLease({...f.options,token:first.lease.token,readOwner:unknown}).released,false);
});

test('corrupt and symlinked slot files are retained and cannot become free capacity',t=>{
  const f=fixture(t); fs.mkdirSync(f.leaseDir,{mode:0o700});
  fs.writeFileSync(path.join(f.leaseDir,'slot.json'),'not a lease');
  assert.equal(acquireLease(f.options).acquired,false);
  assert.equal(readLease({leaseDir:f.leaseDir,readOwner:active}).state,'unknown');
  fs.unlinkSync(path.join(f.leaseDir,'slot.json'));
  const keep=path.join(f.root,'keep.txt'); fs.writeFileSync(keep,'preserve\n');
  fs.symlinkSync(keep,path.join(f.leaseDir,'slot.json'));
  assert.equal(acquireLease(f.options).acquired,false);
  assert.equal(fs.readFileSync(keep,'utf8'),'preserve\n');
});

test('an abandoned transition reservation blocks mutation instead of being stolen',t=>{
  const f=fixture(t); fs.mkdirSync(f.leaseDir,{mode:0o700});
  fs.writeFileSync(path.join(f.leaseDir,'transition.lock'),JSON.stringify({owner,token:'kept'}));
  const before=fs.readFileSync(path.join(f.leaseDir,'transition.lock'),'utf8');
  assert.equal(acquireLease(f.options).acquired,false);
  assert.equal(readLease({leaseDir:f.leaseDir,readOwner:active}).state,'transition');
  assert.equal(fs.readFileSync(path.join(f.leaseDir,'transition.lock'),'utf8'),before);
});

test('invalid jobs, missing start times and unsafe lease directories fail before admission',t=>{
  const f=fixture(t);
  assert.equal(acquireLease({...f.options,jobId:'../wrong'}).acquired,false);
  assert.equal(acquireLease({...f.options,ownerStartTicks:''}).acquired,false);
  assert.equal(fs.existsSync(f.leaseDir),false);
  const target=path.join(f.root,'target'); fs.mkdirSync(target); fs.symlinkSync(target,f.leaseDir);
  assert.equal(acquireLease(f.options).acquired,false); assert.deepEqual(fs.readdirSync(target),[]);
});

test('status and filesystem resource inspection never create a missing state path',t=>{
  const f=fixture(t), absent=path.join(f.root,'new','state');
  assert.equal(readLease({leaseDir:absent,readOwner:active}).state,'free');
  const observed=readHostResources({diskPath:absent});
  assert.ok(Number.isSafeInteger(observed.freeDiskBytes));
  assert.equal(fs.existsSync(path.join(f.root,'new')),false);
});
