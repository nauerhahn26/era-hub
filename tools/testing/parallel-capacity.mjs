// Host admission only. This module launches nothing and never signals processes.
// One isolated lease leaves the other execution slot permanently for legacy gates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const GiB=1024**3;
export const LIMITS=Object.freeze({totalSlots:2,reservedLegacySlots:1,maxIsolatedWorkers:1,minFreeDiskBytes:3*GiB});
// These are admission budgets. The child runner owns enforcement and peak-RSS
// measurement; a successful read-only check is not a hard host memory limit.
const MEMORY_LIMIT=2*GiB, MEMORY_RESERVE=GiB, NICE=19;
// The budget covers one suite at a time: era-gate.sh defaults to two lanes, and a second
// two-lane gate beside the legacy one would push the host into swap.
export const GATE_LANES=1;
export const defaultLeaseDir=()=>path.join(os.homedir(),'.local','state','era-parallel-gates','parallel-capacity');
const safeInteger=value=>Number.isSafeInteger(value) && value>=0;
const ownUid=()=>typeof process.getuid==='function'?process.getuid():null;

function memoryField(text,name) {
  if(typeof text!=='string') throw new Error('Host memory observations are unavailable');
  const lines=text.split('\n').filter(line=>line.startsWith(name+':'));
  if(lines.length!==1) throw new Error(`Host memory ${name} is missing or ambiguous`);
  const match=new RegExp(`^${name}:\\s+([0-9]+) kB\\s*$`).exec(lines[0]);
  if(!match || !safeInteger(Number(match[1])*1024)) throw new Error(`Host memory ${name} is invalid`);
  return Number(match[1])*1024;
}
function cpusFrom(text) {
  if(typeof text!=='string') throw new Error('Allowed CPUs are unknown');
  text=text.trim().replace(/^Cpus_allowed_list:\s*/, '');
  if(!text) throw new Error('Allowed CPUs are unknown');
  const cpus=new Set();
  for(const part of text.split(',')) {
    const match=/^(\d+)(?:-(\d+))?$/.exec(part);
    if(!match) throw new Error('Allowed CPU list is invalid');
    const low=Number(match[1]), high=Number(match[2] ?? match[1]);
    if(!safeInteger(low) || !safeInteger(high) || low>high || high>4095) throw new Error('Allowed CPU range is invalid');
    for(let cpu=low;cpu<=high;cpu++) cpus.add(cpu);
  }
  return [...cpus].sort((a,b)=>a-b);
}

export function readHostResources({diskPath=defaultLeaseDir()}={}) {
  // All observations are read-only and come from the host parent namespace.
  const status=fs.readFileSync('/proc/self/status','utf8');
  const matches=status.split('\n').filter(line=>line.startsWith('Cpus_allowed_list:'));
  if(matches.length!==1) throw new Error('Cannot determine allowed host CPUs');
  let probe=path.resolve(diskPath);
  while(!fs.existsSync(probe)) {
    const parent=path.dirname(probe); if(parent===probe) throw new Error('Cannot locate the snapshot filesystem'); probe=parent;
  }
  const stat=fs.statfsSync(probe,{bigint:true}), available=stat.bavail*stat.bsize;
  if(available>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Available disk capacity exceeds a safe integer');
  return {meminfoText:fs.readFileSync('/proc/meminfo','utf8'),allowedCpusText:matches[0],freeDiskBytes:Number(available),observedAt:new Date().toISOString()};
}

export function inspectCapacity(observed={}) {
  const reasons=[]; let total,available,allowed=[];
  try {
    total=memoryField(observed.meminfoText,'MemTotal'); available=memoryField(observed.meminfoText,'MemAvailable');
    if(available>total) throw new Error('Host available memory exceeds total memory');
    if(available<MEMORY_LIMIT+MEMORY_RESERVE) reasons.push('Available memory must cover the 2 GiB worker budget and 1 GiB host reserve');
  } catch(error) {reasons.push(error.message);}
  try {
    allowed=cpusFrom(observed.allowedCpusText);
    if(allowed.length<2) reasons.push('At least two allowed CPUs are needed to retain legacy execution capacity');
  } catch(error) {reasons.push(error.message);}
  if(!safeInteger(observed.freeDiskBytes)) reasons.push('Available disk capacity is unknown or invalid');
  else if(observed.freeDiskBytes<LIMITS.minFreeDiskBytes) reasons.push('Available disk capacity must be at least 3 GiB before creating a snapshot');
  // Four or more allowed CPUs can share at most two with an isolated worker.
  // Keep at least half (and at least two on that host size) outside its affinity.
  const cpuCount=Math.min(2,Math.floor(allowed.length/2));
  const cpus=cpuCount?allowed.slice(-cpuCount):[];
  return {
    admissible:reasons.length===0,reasons,limits:LIMITS,
    resources:{cpu:cpus.length?cpus.at(-1):null,cpus,reservedCpus:allowed.filter(cpu=>!cpus.includes(cpu)),allowedCpus:allowed,nice:NICE,gateLanes:GATE_LANES,memoryBudgetBytes:MEMORY_LIMIT,memoryLimitBytes:MEMORY_LIMIT,memoryReserveBytes:MEMORY_RESERVE,memAvailableBytes:available ?? null,memTotalBytes:total ?? null,freeDiskBytes:safeInteger(observed.freeDiskBytes)?observed.freeDiskBytes:null},
  };
}

export function readProcessIdentity(pid) {
  if(!Number.isSafeInteger(pid) || pid<1) return {state:'unknown',reason:'Invalid owner PID'};
  try {
    const owner=fs.statSync(`/proc/${pid}`), stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
    const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/), startTicks=fields[19];
    if(['Z','X','x'].includes(fields[0])) return {state:'dead',pid};
    if(!/^\d+$/.test(startTicks || '')) return {state:'unknown',reason:'Owner start time is unavailable'};
    return {state:'active',pid,startTicks,uid:owner.uid};
  } catch(error) {
    return error.code==='ENOENT'?{state:'dead',pid}:{state:'unknown',pid,reason:'Owner identity cannot be inspected'};
  }
}
function verifiedOwner(expected,readOwner) {
  let actual; try {actual=readOwner(expected.pid);} catch {return 'unknown';}
  if(actual?.state==='dead') return 'dead';
  if(actual?.state!=='active' || !/^\d+$/.test(actual.startTicks || '') || !Number.isInteger(actual.uid)) return 'unknown';
  if(actual.pid!==expected.pid || actual.startTicks!==expected.startTicks) return 'replaced';
  if(actual.uid!==expected.uid || actual.uid!==ownUid()) return 'unknown';
  return 'active';
}
function validOwner(pid,startTicks) {
  return Number.isSafeInteger(pid) && pid>0 && typeof startTicks==='string' && /^\d+$/.test(startTicks) && ownUid()!==null;
}
function directory(leaseDir,create=false) {
  leaseDir=path.resolve(leaseDir);
  let stat;
  try {stat=fs.lstatSync(leaseDir);} catch(error) {
    if(error.code!=='ENOENT') throw error;
    if(!create) return {leaseDir,exists:false};
    fs.mkdirSync(leaseDir,{recursive:true,mode:0o700}); stat=fs.lstatSync(leaseDir);
  }
  if(!stat.isDirectory() || stat.isSymbolicLink() || stat.uid!==ownUid() || (stat.mode&0o077)!==0) throw new Error('Capacity lease directory must be private and owned by the current host user');
  if(fs.realpathSync(leaseDir)!==leaseDir) throw new Error('Capacity lease directory cannot traverse symbolic links');
  return {leaseDir,exists:true};
}
function safeRecord(file) {
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.uid!==ownUid()) throw new Error('Capacity lease is not an owned regular file');
  return {record:JSON.parse(fs.readFileSync(file,'utf8')),stat};
}
function validLease(record) {
  return record?.version===1 && /^[a-f0-9]{64}$/.test(record.token || '') && typeof record.jobId==='string' && validOwner(record.owner?.pid,record.owner?.startTicks) && record.owner.uid===ownUid()
    && record.limits?.totalSlots===2 && record.limits.reservedLegacySlots===1 && record.limits.maxIsolatedWorkers===1
    && record.resources?.nice===NICE && record.resources.memoryLimitBytes===MEMORY_LIMIT && record.resources.memoryReserveBytes===MEMORY_RESERVE;
}
function slotStatus(leaseDir,readOwner) {
  try {
    const {record:lease}=safeRecord(path.join(leaseDir,'slot.json'));
    if(!validLease(lease)) throw new Error('Capacity lease record is invalid');
    const ownerState=verifiedOwner(lease.owner,readOwner);
    return {state:'occupied',lease,ownerState,recoveryRequired:ownerState!=='active',reason:ownerState==='active'?'Isolated worker slot is occupied; the legacy slot remains reserved':'Isolated lease owner is not verifiably active; explicit verified recovery is required'};
  } catch(error) {
    return error.code==='ENOENT'?{state:'free'}:{state:'unknown',recoveryRequired:true,reason:error.message};
  }
}
export function readLease({leaseDir=defaultLeaseDir(),readOwner=readProcessIdentity}={}) {
  try {
    const location=directory(leaseDir);
    if(!location.exists) return {state:'free',limits:LIMITS};
    try {
      const guard=path.join(location.leaseDir,'transition.lock'),stat=fs.lstatSync(guard);
      if(stat) {
        let ownerState='unknown',owner;
        try {const {record}=safeRecord(guard); owner=record.owner; if(record.version===1 && validOwner(owner?.pid,owner?.startTicks)) ownerState=verifiedOwner(owner,readOwner);} catch {}
        return {state:'transition',owner,ownerState,recoveryRequired:ownerState!=='active',reason:ownerState==='active'?'Capacity admission or release is in progress; retry':'Capacity transition owner cannot be verified; explicit recovery is required',limits:LIMITS};
      }
    } catch(error) {if(error.code!=='ENOENT') throw error;}
    return {...slotStatus(location.leaseDir,readOwner),limits:LIMITS};
  } catch(error) {return {state:'unknown',recoveryRequired:true,reason:error.message,limits:LIMITS};}
}
function unlinkOwned(file,ownedStat) {
  const current=fs.lstatSync(file);
  if(!current.isFile() || current.dev!==ownedStat.dev || current.ino!==ownedStat.ino) throw new Error('Capacity reservation ownership changed; refusing to remove it');
  fs.unlinkSync(file);
}
function transition(leaseDir,operation) {
  let guard,guardStat;
  const file=path.join(leaseDir,'transition.lock');
  try {
    guard=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    guardStat=fs.fstatSync(guard);
    fs.writeFileSync(guard,JSON.stringify({version:1,owner:readProcessIdentity(process.pid),createdAt:new Date().toISOString()})+'\n');
    return operation();
  } finally {
    if(guard!==undefined) {
      try {unlinkOwned(file,guardStat);} finally {fs.closeSync(guard);}
    }
  }
}

export function acquireLease({leaseDir=defaultLeaseDir(),jobId,ownerPid,ownerStartTicks,diskPath,readOwner=readProcessIdentity,readResources=readHostResources}={}) {
  if(typeof jobId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)) return {acquired:false,reason:'Invalid isolated job identity'};
  if(!validOwner(ownerPid,ownerStartTicks)) return {acquired:false,reason:'Host worker PID and exact start time are required'};
  const owner={pid:ownerPid,startTicks:ownerStartTicks,uid:ownUid()};
  if(verifiedOwner(owner,readOwner)!=='active') return {acquired:false,reason:'Host worker ownership cannot be verified'};
  try {
    const location=directory(leaseDir,true); leaseDir=location.leaseDir;
    return transition(leaseDir,()=>{
      const current=slotStatus(leaseDir,readOwner);
      if(current.state!=='free') return {acquired:false,reason:current.reason,status:current};
      const file=path.join(leaseDir,'slot.json');
      const slot=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600), slotStat=fs.fstatSync(slot);
      let committed=false;
      try {
        const decision=inspectCapacity(readResources({diskPath:diskPath || leaseDir}));
        if(!decision.admissible) return {acquired:false,reason:decision.reasons.join('; '),decision};
        if(verifiedOwner(owner,readOwner)!=='active') return {acquired:false,reason:'Host worker identity changed during admission'};
        const lease={version:1,token:crypto.randomBytes(32).toString('hex'),jobId,owner,createdAt:new Date().toISOString(),resources:decision.resources,limits:LIMITS};
        fs.writeFileSync(slot,JSON.stringify(lease,null,2)+'\n'); fs.fsyncSync(slot); committed=true;
        return {acquired:true,lease};
      } finally {
        try {if(!committed) unlinkOwned(file,slotStat);} finally {fs.closeSync(slot);}
      }
    });
  } catch(error) {
    return {acquired:false,reason:error.code==='EEXIST'?'Capacity admission transition is occupied; no reservation was stolen':`Capacity admission refused: ${error.message}`};
  }
}

export function releaseLease({leaseDir=defaultLeaseDir(),token,ownerPid,ownerStartTicks,readOwner=readProcessIdentity}={}) {
  if(!/^[a-f0-9]{64}$/.test(token || '') || !validOwner(ownerPid,ownerStartTicks)) return {released:false,reason:'Lease token and exact owner identity are required'};
  try {
    const location=directory(leaseDir);
    if(!location.exists) return {released:false,reason:'Isolated lease is absent'};
    return transition(location.leaseDir,()=>{
      const file=path.join(location.leaseDir,'slot.json'), {record:lease,stat}=safeRecord(file);
      if(!validLease(lease) || lease.token!==token || lease.owner.pid!==ownerPid || lease.owner.startTicks!==ownerStartTicks) return {released:false,reason:'Isolated lease token or owner does not match'};
      if(verifiedOwner(lease.owner,readOwner)!=='active') return {released:false,reason:'Lease owner is not verifiably active; explicit recovery is required'};
      unlinkOwned(file,stat);
      return {released:true,jobId:lease.jobId};
    });
  } catch(error) {return {released:false,reason:error.code==='EEXIST'?'Capacity transition is occupied; lease was retained':`Capacity release refused: ${error.message}`};}
}
