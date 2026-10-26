import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const HERE=path.dirname(fileURLToPath(import.meta.url));
export const CLI=path.resolve(HERE,'../parallel-gate.mjs');
export const PYTHON=path.join(HERE,'parallel-worker.py');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
export const defaultState=()=>path.join(os.homedir(),'.local','state','era-parallel-gates');
export function atomicJSON(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=`${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temporary,file);
}
export const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export function stateDirectory() {
  const state=defaultState();fs.mkdirSync(path.join(state,'jobs'),{recursive:true,mode:0o700});
  if(fs.lstatSync(state).isSymbolicLink() || fs.statSync(state).uid!==process.getuid()) throw Error('Parallel state must be owned by the current user');
  return fs.realpathSync(state);
}
export function jobPath(id,state=defaultState()) {
  if(!/^gate-\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(id || '')) throw Error('Invalid parallel job ID');
  const jobs=path.resolve(state,'jobs'),directory=path.join(jobs,id);
  if(!fs.existsSync(directory)) throw Error('Unknown parallel job');
  if(fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory)!==directory || !fs.realpathSync(directory).startsWith(fs.realpathSync(jobs)+path.sep)) throw Error('Job alias is outside its owned path');
  return directory;
}
export function runtimeManifest(root) {
  root=fs.realpathSync(root);const files={};
  function walk(directory) {
    for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)) {
      const file=path.join(directory,entry.name),relative=path.relative(root,file),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink()) {
        const target=fs.readlinkSync(file),resolved=path.resolve(path.dirname(file),target);
        if(!resolved.startsWith(root+path.sep)) throw Error('Runtime link escapes its owned root');
        files[relative]={link:target};
      } else if(stat.isDirectory()) walk(file);
      else if(stat.isFile()) files[relative]={hash:digest(fs.readFileSync(file)),mode:stat.mode&0o777};
      else throw Error('Unsupported runtime input');
    }
  }
  walk(root);return {version:1,files,hash:digest(JSON.stringify(files))};
}
export function verifyRuntime(root,expected) {
  try {const current=runtimeManifest(root);return {valid:expected?.version===1 && expected.hash===current.hash,hash:current.hash};}
  catch(error) {return {valid:false,error:error.message};}
}
export function copyControlBundle(directory,files) {
  const target=path.join(directory,'control');fs.mkdirSync(target,{recursive:true,mode:0o700});
  const copied=[];
  for(const file of files) {
    const relative=file===CLI?'parallel-gate.mjs':path.join('testing',path.basename(file));
    const destination=path.join(target,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});
    fs.copyFileSync(file,destination);fs.chmodSync(destination,0o444);copied.push(destination);
  }
  return {directory:target,files:copied,manifest:runtimeManifest(target)};
}
export function inspectRuntime() {
  const require=createRequire(import.meta.url);
  const packages=['playwright','playwright-core'].map(name=>({name,source:fs.realpathSync(path.dirname(require.resolve(name+'/package.json')))}));
  const executable=require('playwright').chromium.executablePath();
  if(!fs.existsSync(executable)) throw Error('Installed browser runtime is missing');
  let browser=path.dirname(executable);
  while(!/^chromium(?:_headless_shell)?-\d+$/.test(path.basename(browser))) {
    const parent=path.dirname(browser);if(parent===browser) throw Error('Unsupported browser cache layout');browser=parent;
  }
  const browsersRoot=path.dirname(browser);
  const revision=path.basename(browser).split('-').at(-1);
  const browsers=fs.readdirSync(browsersRoot).filter(name=>name==='chromium-'+revision || name==='chromium_headless_shell-'+revision || /^ffmpeg-\d+$/.test(name)).map(name=>({name,source:path.join(browsersRoot,name)}));
  return {node:fs.realpathSync(process.execPath),nodeVersion:process.version,packages,browsers};
}
export function executionEnvironment({directory,manifest}) {
  const runtime=path.join(directory,'runtime');
  return {
    PATH:path.join(runtime,'bin')+':/usr/sbin:/usr/bin:/sbin:/bin',
    LD_LIBRARY_PATH:path.join(runtime,'lib'),PLAYWRIGHT_BROWSERS_PATH:path.join(runtime,'browsers'),
    LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',TMPDIR:'/tmp',
    XDG_CONFIG_HOME:'/tmp/config',XDG_CACHE_HOME:'/tmp/cache',
    ERA_DATA_DIR:manifest.seedDir,ERA_WT_SUFFIX:manifest.suffix || '',ERA_TEST_PORT:'8388',
    ERA_GATE_STAMPS:path.join(directory,'issued-stamps'),
    ERA_PARALLEL_JOB_DIR:directory,ERA_GAZE_SRC:manifest.clones?.['era-gaze'] || path.join(manifest.workspace,'era-gaze'),
    ERA_CHAT_CONFIG_DISABLED:'1',
    GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',
  };
}
export function parseProgress(text) {
  const outcomes=[];let activeSuite=null,summary=null;
  for(const line of text.split('\n')) {
    const start=/^RUN (\S+)/.exec(line);if(start) activeSuite=start[1];
    const result=/^(PASS|FAIL) (\S+)/.exec(line);
    if(result) {outcomes.push({name:result[2],status:result[1].toLowerCase()});activeSuite=null;}
    const complete=/^== era-gate: (\d+) passed, (\d+) failed(?: .*?)? ==$/.exec(line);
    if(complete) summary={passed:Number(complete[1]),failed:Number(complete[2])};
  }
  return {completed:outcomes.length,failed:outcomes.filter(row=>row.status==='fail').length,lastSuite:outcomes.at(-1)?.name || null,activeSuite,summary};
}
export function estimateQueue(results,ahead) {
  const seconds=results.filter(row=>row.status==='passed' && Number.isFinite(row.gateSeconds) && row.gateSeconds>0).map(row=>row.gateSeconds).sort((a,b)=>a-b);
  if(!seconds.length) return {seconds:null,samples:0,note:'No validated complete parallel gate has finished; ETA is not established'};
  const median=seconds.length%2?seconds[(seconds.length-1)/2]:(seconds[seconds.length/2-1]+seconds[seconds.length/2])/2;
  return {seconds:Math.round(median*ahead),samples:seconds.length,note:'Estimate from completed full gates; source scope and host load may differ'};
}
function processAlive(worker) {
  if(!worker?.pid || !worker.startTicks) return false;
  try {const text=fs.readFileSync(`/proc/${worker.pid}/stat`,'utf8');return text.slice(text.lastIndexOf(')')+2).split(' ')[19]===worker.startTicks;}
  catch {return false;}
}
export async function readStatus(directory,{refresh=true}={}) {
  const request=readJSON(path.join(directory,'request.json'));
  let status;try {status=readJSON(path.join(directory,'status.json'));}catch {status={status:'queued'};}
  let result;try {result=readJSON(path.join(directory,'result.json'));}catch {}
  let worker;try {worker=readJSON(path.join(directory,'worker.json'));}catch {}
  if(worker && !processAlive(worker) && !['passed','failed','stale'].includes(status.status)) status={...status,status:'interrupted',reason:'Owned worker exited before completing its durable result'};
  let exposed=null;
  if(refresh && status.status==='passed') {
    try {
      if(!verifyRuntime(path.join(directory,'control'),request.control).valid) throw Error('Pinned control inputs changed');
      const runtime=readJSON(path.join(directory,'runtime-inputs.json'));
      if(!verifyRuntime(path.join(directory,'runtime'),runtime.runtime).valid || !verifyRuntime(path.join(directory,'workspace/node_modules'),runtime.modules).valid) throw Error('Pinned runtime inputs changed');
      const snapshot=await import(pathToFileURL(path.join(directory,'control/testing/parallel-snapshot.mjs')).href),manifest=readJSON(path.join(directory,'manifest.json'));
      const origin=await snapshot.verifyOrigins(manifest);
      if(!origin.valid) throw Error((origin.reasons || []).join('; '));
      const validation=await snapshot.validateGateResults({manifest,workspace:manifest.workspace,gateExitCode:result.gateExitCode,stampsDir:path.join(directory,'issued-stamps')});
      if(!validation.valid) throw Error((validation.reasons || []).join('; '));
      await snapshot.promoteStamps({manifest,workspace:manifest.workspace,gateExitCode:result.gateExitCode,stampsDir:path.join(directory,'issued-stamps'),destination:path.join(directory,'exposed-stamps')});
      exposed=path.join(directory,'exposed-stamps');
    } catch(error) {status={...status,status:'stale',reason:error.message};}
    if(!exposed) fs.rmSync(path.join(directory,'exposed-stamps'),{recursive:true,force:true});
  }
  let progress={};try {progress=readJSON(path.join(directory,'progress.json'));}catch {}
  return {id:request.id,directory,...status,worker,progress,result,stamps:exposed,hub:request.hub,created:request.created};
}
export async function allStatuses(state=stateDirectory()) {
  const jobs=path.join(state,'jobs');if(!fs.existsSync(jobs)) return [];
  const result=[];
  for(const id of fs.readdirSync(jobs).filter(name=>/^gate-/.test(name)).sort()) {
    try {result.push(await readStatus(jobPath(id,state)));}catch(error) {result.push({id,status:'invalid',reason:error.message});}
  }
  return result;
}
export async function queueGate({hub,suffix,seedDir}) {
  const state=stateDirectory(),snapshot=await import('./parallel-snapshot.mjs');
  suffix=suffix===undefined?(path.basename(path.resolve(hub)).match(/(--wt-[a-z0-9][a-z0-9-]*)$/)?.[1] || ''):suffix;
  const sources=await snapshot.resolveSources(hub,{suffix});
  seedDir=seedDir || path.join(path.dirname(sources['era-hub']),'era-family','test-data');
  const runtime=inspectRuntime();
  const id='gate-'+new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z')+'-'+crypto.randomBytes(4).toString('hex');
  const directory=path.join(state,'jobs',id);fs.mkdirSync(directory,{mode:0o700});
  const seed=await snapshot.freezeSeed({seedDir,sources,destination:path.join(directory,'seed-parent/test-data')});
  const origins=await snapshot.captureOrigins(sources,{seedDir:seed.path,suffix});
  const control=copyControlBundle(directory,[CLI,PYTHON,fileURLToPath(import.meta.url),path.join(HERE,'parallel-snapshot.mjs'),path.join(HERE,'parallel-capacity.mjs'),path.join(HERE,'parallel_monitor.py')]);
  const request={version:1,id,directory,state,hub:origins.hub || sources['era-hub'],suffix,seedDir:seed.path,seedProvenance:seed,origins,runtime,control:control.manifest,created:new Date().toISOString()};
  atomicJSON(path.join(directory,'request.json'),request);atomicJSON(path.join(directory,'status.json'),{status:'queued',updated:request.created});
  const output=fs.openSync(path.join(directory,'worker.log'),'a',0o600);
  const worker=spawn('python3',[path.join(control.directory,'testing','parallel-worker.py'),'run',directory],{detached:true,stdio:['ignore',output,output],env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC'}});
  fs.closeSync(output);worker.unref();
  worker.on('error',error=>atomicJSON(path.join(directory,'status.json'),{status:'failed',reason:error.message,updated:new Date().toISOString()}));
  atomicJSON(path.join(directory,'launcher.json'),{pid:worker.pid,at:new Date().toISOString()});
  return {id,directory,status:'queued',note:'Full candidate gate will run unchanged in its own namespaces after resource admission'};
}
export async function internal(command,directory) {
  directory=jobPath(path.basename(directory),path.dirname(path.dirname(path.resolve(directory))));
  const request=readJSON(path.join(directory,'request.json'));
  if(request.directory!==directory || request.state!==stateDirectory()) throw Error('Unowned parallel job definition');
  if(!verifyRuntime(path.join(directory,'control'),request.control).valid) throw Error('Job control inputs changed');
  const snapshot=await import('./parallel-snapshot.mjs');
  if(command==='_runtime') {
    atomicJSON(path.join(directory,'runtime-inputs.json'),{runtime:runtimeManifest(path.join(directory,'runtime')),modules:runtimeManifest(path.join(directory,'workspace/node_modules'))});
    return {pinned:true};
  }
  if(command==='_prepare') {
    const sources=await snapshot.resolveSources(request.hub,{suffix:request.suffix});
    const current=await snapshot.captureOrigins(sources,{seedDir:request.seedDir,suffix:request.suffix});
    if(current.hash!==request.origins.hash) throw Error('Queued source tuple or test seed is stale');
    const manifest=await snapshot.prepareSnapshot({hub:request.hub,suffix:request.suffix,workspace:path.join(directory,'workspace'),seedDir:request.seedDir});
    atomicJSON(path.join(directory,'manifest.json'),manifest);
    atomicJSON(path.join(directory,'gate-env.json'),executionEnvironment({directory,manifest}));return {prepared:true};
  }
  if(command==='_admit' || command==='_release') {
    const capacity=await import('./parallel-capacity.mjs'),owner=readJSON(path.join(directory,'worker.json'));
    const leaseDir=path.join(request.state,'parallel-capacity');
    if(command==='_release') {
      const lease=readJSON(path.join(directory,'lease.json'));
      return capacity.releaseLease({leaseDir,token:lease.token,ownerPid:owner.pid,ownerStartTicks:owner.startTicks});
    }
    const admitted=await capacity.acquireLease({leaseDir,jobId:request.id,ownerPid:owner.pid,ownerStartTicks:owner.startTicks,diskPath:request.state});
    if(admitted.acquired) atomicJSON(path.join(directory,'lease.json'),admitted.lease);
    return admitted;
  }
  if(command==='_validate') {
    const manifest=readJSON(path.join(directory,'manifest.json')),gate=readJSON(path.join(directory,'gate-exit.json'));
    const runtime=readJSON(path.join(directory,'runtime-inputs.json'));
    if(!verifyRuntime(path.join(directory,'runtime'),runtime.runtime).valid || !verifyRuntime(path.join(directory,'workspace/node_modules'),runtime.modules).valid) throw Error('Pinned runtime inputs changed');
    const origin=await snapshot.verifyOrigins(manifest);
    if(!origin.valid) return {valid:false,stale:true,reasons:origin.reasons};
    const result=await snapshot.validateGateResults({manifest,workspace:manifest.workspace,gateExitCode:gate.code,stampsDir:path.join(directory,'issued-stamps')});
    return {...result,gateExitCode:gate.code};
  }
  throw Error('Unknown internal parallel command');
}
function runProbe(directory,mode) {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const run=spawnSync('python3',[PYTHON,mode,directory,process.execPath],{encoding:'utf8',timeout:30000,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC'}});
  if(run.status!==0) throw Error(`Namespace preflight failed: ${run.stderr || run.stdout || run.error?.message}`);
  return JSON.parse(run.stdout);
}
export const runPreflight=directory=>runProbe(directory,'preflight');
export const runReversePreflight=directory=>runProbe(directory,'reverse-preflight');
