// Conservative development selection and durable jobs around the existing gate.
// Deliberately no result cache, release action, direct suite runner or process kill.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REGISTRY_FILE=fileURLToPath(new URL('./registry.json',import.meta.url));
export const CLI_FILE=fileURLToPath(new URL('../test-suite.mjs',import.meta.url));
const LEGACY=new Set(['run','parts','transfer','mistakes','pencil','narrow','sortfix','fltest','bargein','sortbugs','rhymecount','transfercount','phonetic'].map(n=>`${n}.js`));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});
export const defaultJobsDir=()=>process.env.ERA_TEST_JOBS || path.join(os.homedir(),'.local','state','era-tests');
export function loadRegistry(file=REGISTRY_FILE) { return readJSON(file); }
export function atomicJSON(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600}); fs.renameSync(temp,file);
}
export function resolveRoots(hub,suffix=process.env.ERA_WT_SUFFIX || '') {
  hub=path.resolve(hub); const parent=path.dirname(hub), roots={};
  for(const name of ['era-core','era-making-words','era-pencil','era-board','era-gaze']) {
    const feature=path.join(parent,name+suffix);
    roots[name]=suffix && fs.existsSync(feature)?feature:path.join(parent,name);
    if(!fs.existsSync(roots[name])) throw new Error(`Missing source repository: ${name}`);
  }
  roots['era-hub']=hub; return roots;
}
function splitID(id) {
  if(typeof id!=='string' || !/^[a-z][a-z0-9-]*:tests\/[^\0]+$/.test(id)) throw new Error(`Invalid suite ID: ${id}`);
  const colon=id.indexOf(':'), repo=id.slice(0,colon), relative=id.slice(colon+1);
  if(relative.split('/').some(p=>p==='..'||p==='.') || path.isAbsolute(relative)) throw new Error(`Invalid suite path: ${id}`);
  return {repo,relative};
}
export function checkInventory(roots,registry=loadRegistry()) {
  if(registry.version!==1 || !Array.isArray(registry.suites)) throw new Error('Invalid suite registry');
  const byID=new Map(), destinations=new Map();
  for(const suite of registry.suites) {
    const {repo,relative}=splitID(suite.id), basename=path.basename(relative);
    if(!basename.endsWith('.test.mjs') && !LEGACY.has(basename)) throw new Error(`Unsupported executable filename under gate rules: ${suite.id}`);
    if(byID.has(suite.id)) throw new Error(`Duplicate suite ID: ${suite.id}`);
    if(destinations.has(basename)) throw new Error(`Gate destination collision: ${destinations.get(basename)} and ${suite.id}`);
    if(!suite.purpose || !suite.group || !suite.lane || !Array.isArray(suite.dependencies) || !suite.dependencies.length || !Array.isArray(suite.resources)) throw new Error(`Incomplete suite metadata: ${suite.id}`);
    if(!roots[repo] || !fs.existsSync(path.join(roots[repo],relative))) throw new Error(`Missing registered suite: ${suite.id}`);
    if(path.dirname(relative)!=='tests') throw new Error(`Nested registered executable is not run by the flat gate: ${suite.id}`);
    byID.set(suite.id,suite); destinations.set(basename,suite.id);
  }
  const discovered=new Set();
  for(const repo of registry.repositories || [...new Set(registry.suites.map(s=>splitID(s.id).repo))]) {
    if(!roots[repo] || !fs.existsSync(path.join(roots[repo],'tests'))) throw new Error(`Missing suite repository: ${repo}`);
    function visit(directory,relative='tests') {
      for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
        const local=`${relative}/${entry.name}`, absolute=path.join(directory,entry.name);
        if(entry.isDirectory()) { visit(absolute,local); continue; }
        if(relative==='tests' && entry.name.endsWith('.js') && !LEGACY.has(entry.name)) throw new Error(`Unsupported executable filename under gate rules: ${repo}:${local}`);
        if(!entry.name.endsWith('.test.mjs') && !(relative==='tests' && (LEGACY.has(entry.name)||entry.name.endsWith('.js')))) {
          if(relative==='tests' && entry.name.endsWith('.mjs') && !(registry.support || []).some(s=>s.id===`${repo}:${local}`)) throw new Error(`Unclassified test support module: ${repo}:${local}`);
          continue;
        }
        const id=`${repo}:${local}`;
        if(relative!=='tests') throw new Error(`Nested executable is not run by the flat gate: ${id}`);
        if(!byID.has(id)) throw new Error(`Unregistered executable suite: ${id}`);
        discovered.add(id);
      }
    }
    visit(path.join(roots[repo],'tests'));
  }
  for(const id of byID.keys()) if(!discovered.has(id)) throw new Error(`Registered source is not executable under gate rules: ${id}`);
  return [...byID.values()].sort((a,b)=>a.id.localeCompare(b.id));
}
function matches(file,pattern) {
  // Deliberately small glob language: ** includes directories, * one segment.
  let expression='';
  for(let i=0;i<pattern.length;i++) {
    if(pattern[i]==='*' && pattern[i+1]==='*') {
      i++; if(pattern[i+1]==='/') { expression+='(?:.*/)?'; i++; } else expression+='.*';
    } else if(pattern[i]==='*') expression+='[^/]*';
    else expression+=pattern[i].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  }
  return new RegExp(`^${expression}$`).test(file);
}
function changedFiles(root,baseline) {
  git(root,'rev-parse','--verify',`${baseline}^{commit}`);
  const tokens=git(root,'diff','--name-status','-z','--find-renames',baseline,'--').split('\0'), files=new Set();
  for(let i=0;i<tokens.length && tokens[i];) {
    const status=tokens[i++], first=tokens[i++]; if(first) files.add(first);
    if(/^[RC]/.test(status)) { const second=tokens[i++]; if(second) files.add(second); }
  }
  for(const file of git(root,'ls-files','--others','--exclude-standard','-z').split('\0')) if(file) files.add(file);
  return [...files].sort();
}
export function planChanges({roots,registry=loadRegistry(),baseline='master',previousFailures=[],requested=[]}) {
  const suites=checkInventory(roots,registry), selected=new Map(), changes=[], fallback=[];
  const select=(id,reason)=>{
    if(!suites.some(s=>s.id===id)) throw new Error(`Unknown requested suite: ${id}`);
    if(!selected.has(id)) selected.set(id,[]);
    if(!selected.get(id).includes(reason)) selected.get(id).push(reason);
  };
  for(const id of registry.always || []) select(id,'Required shared access smoke');
  for(const id of previousFailures) select(id,'Previously failing suite');
  for(const id of requested) select(id,'Explicit operator request');
  for(const [repo,root] of Object.entries(roots)) {
    let paths; try { paths=changedFiles(root,baseline); }
    catch { fallback.push(`Missing or invalid baseline ${baseline} in ${repo}`); continue; }
    for(const file of paths) {
      const change={repo,path:file}; changes.push(change);
      const force=(registry.full || []).find(rule=>rule.repo===repo && rule.paths.some(p=>matches(file,p)));
      if(force) { fallback.push(`${repo}:${file}: ${force.reason}`); continue; }
      const suite=suites.find(s=>s.id===`${repo}:${file}`);
      if(suite) { select(suite.id,`Changed test: ${repo}:${file}`); continue; }
      const support=(registry.support || []).find(s=>s.id===`${repo}:${file}`);
      if(support && Array.isArray(support.consumers)) {
        for(const id of support.consumers) select(id,`Changed helper ${repo}:${file}`);
        continue;
      }
      const rules=(registry.rules || []).filter(rule=>rule.repo===repo && rule.paths.some(p=>matches(file,p)));
      if(!rules.length) { fallback.push(`Unknown changed path: ${repo}:${file}`); continue; }
      for(const rule of rules) for(const id of rule.suites) select(id,`${rule.reason}: ${repo}:${file}`);
    }
  }
  const mode=fallback.length?'full':'affected';
  if(mode==='full') for(const suite of suites) select(suite.id,'Complete fallback: dependency scope is uncertain');
  return {
    version:1, baseline, mode, completeEvidence:false,
    changes, fallback:[...new Set(fallback)], roots,
    selected:suites.filter(s=>selected.has(s.id)).map(s=>({...s,reasons:selected.get(s.id)})),
    omitted:suites.filter(s=>!selected.has(s.id)).map(s=>s.id),
    note:'A plan or selected pass is development feedback and never supplies a complete gate stamp.',
  };
}
function canonicalPath(value) {
  let ancestor=path.resolve(value); const missing=[];
  while(!fs.existsSync(ancestor)) {
    const parent=path.dirname(ancestor); if(parent===ancestor) break;
    missing.unshift(path.basename(ancestor)); ancestor=parent;
  }
  return path.join(fs.realpathSync(ancestor),...missing);
}
function outputOutsideSources(directory,roots) {
  const resolved=canonicalPath(directory);
  for(const root of Object.values(roots)) if(resolved===canonicalPath(root) || resolved.startsWith(canonicalPath(root)+path.sep)) throw new Error('Job output directory must be outside source repositories');
  return resolved;
}
function snapshotTree(file) {
  let stat; try { stat=fs.lstatSync(file); } catch(error) { if(error.code==='ENOENT') return {kind:'missing'}; throw error; }
  if(stat.isSymbolicLink()) return {kind:'symlink',target:fs.readlinkSync(file)};
  if(stat.isFile()) return {kind:'file',hash:hash(fs.readFileSync(file)),executable:!!(stat.mode&0o111)};
  if(!stat.isDirectory()) throw new Error(`Unsupported material input: ${file}`);
  const entries={}; for(const entry of fs.readdirSync(file).sort()) entries[entry]=snapshotTree(path.join(file,entry));
  return {kind:'directory',hash:hash(JSON.stringify(entries)),entries};
}
function materialConfiguration(roots,overrides={}) {
  const seedDir=overrides.seedDir || process.env.ERA_GATE_SEED_DIR || process.env.ERA_DATA_DIR || path.join(path.dirname(roots['era-hub']),'era-family','test-data');
  const resolved=canonicalPath(seedDir), parent=path.dirname(roots['era-hub']);
  for(const candidate of [path.join(parent,'era-family','data'),path.join(parent,'era-hub','data'),path.join(roots['era-hub'],'data')]) {
    const live=canonicalPath(candidate);
    if(resolved===live || resolved.startsWith(live+path.sep) || live.startsWith(resolved+path.sep)) throw new Error('Unsafe test seed contains or enters a live data path');
  }
  return {seedDir:resolved,testPort:String(overrides.testPort || process.env.ERA_TEST_PORT || '8378'),suffix:overrides.suffix ?? process.env.ERA_WT_SUFFIX ?? '',mode:overrides.mode || process.env.ERA_GATE_MODE || 'full'};
}
function servedFarm(roots,configuration) {
  const targets={
    'lib':roots['era-core'] && path.join(roots['era-core'],'lib'),
    'dwell.js':roots['era-core'] && path.join(roots['era-core'],'dwell.js'),
    'speech.js':roots['era-core'] && path.join(roots['era-core'],'speech.js'),
    'index.html':roots['era-making-words'] && path.join(roots['era-making-words'],'app/index.html'),
    'studio.js':roots['era-making-words'] && path.join(roots['era-making-words'],'app/studio.js'),
    'pencil':roots['era-pencil'] && path.join(roots['era-pencil'],'app'),
    'board':roots['era-board'] && path.join(roots['era-board'],'app'),
  };
  const farm={}, mutableData=canonicalPath(process.env.ERA_DATA_DIR || configuration.seedDir);
  for(const name of [...Object.keys(targets),'lessons.json','sentences.json','runway.json']) {
    const file=path.join(roots['era-hub'],'public',name), key=`public/${name}`;
    let stat; try { stat=fs.lstatSync(file); } catch(error) { if(error.code==='ENOENT') {farm[key]={kind:'missing'}; continue;} throw error; }
    if(!stat.isSymbolicLink()) {farm[key]=snapshotTree(file); continue;}
    const resolved=canonicalPath(file), dataFile=['lessons.json','sentences.json','runway.json'].includes(name);
    if(dataFile && resolved===path.join(mutableData,'content',name)) {
      // Scratch data paths differ by run; identify the served seed-relative bytes.
      farm[key]={kind:'seed-link',source:`content/${name}`,content:snapshotTree(resolved)};
    } else if(targets[name] && resolved===canonicalPath(targets[name])) {
      farm[key]={kind:'source-link',target:resolved,content:snapshotTree(resolved)};
    } else {
      // Record an unexpected target without reading arbitrary external content.
      farm[key]={kind:'unexpected-link',target:resolved,link:fs.readlinkSync(file)};
    }
  }
  return farm;
}
export function captureInputs(roots,{baseline='master',testConfiguration}={}) {
  const repositories={};
  for(const [repo,root] of Object.entries(roots).sort(([a],[b])=>a.localeCompare(b))) {
    const head=git(root,'rev-parse','HEAD').trim();
    const names=[...new Set(git(root,'ls-files','--cached','--others','--exclude-standard','-z').split('\0').filter(Boolean))].sort();
    const files={};
    for(const name of names) {
      const file=path.join(root,name);
      try {
        const stat=fs.lstatSync(file);
        if(stat.isSymbolicLink()) files[name]={kind:'symlink',hash:hash(fs.readlinkSync(file))};
        else if(stat.isFile()) files[name]={kind:'file',hash:hash(fs.readFileSync(file)),executable:!!(stat.mode&0o111)};
        else throw new Error(`Unsupported source input: ${repo}:${name}`);
      } catch(error) {
        if(error.code==='ENOENT') files[name]={kind:'deleted'}; else throw error;
      }
    }
    const index=hash(git(root,'ls-files','--stage','-z'));
    let integrationBase; try { integrationBase=git(root,'rev-parse','--verify',`${baseline}^{commit}`).trim(); } catch { integrationBase=null; }
    repositories[repo]={root:canonicalPath(root),head,index,integrationBase,files};
  }
  // The optional gate configuration is an input too; retain only its digest.
  const gateEnvironment=roots['era-hub'] && path.join(path.dirname(roots['era-hub']),'era-family','gate-env.sh');
  const material=materialConfiguration(roots,testConfiguration);
  const configuration={...material,seed:snapshotTree(material.seedDir),gateEnvironment:gateEnvironment && fs.existsSync(gateEnvironment)?hash(fs.readFileSync(gateEnvironment)):null};
  const identity={version:2,node:process.version,platform:process.platform,arch:process.arch,baseline,repositories,configuration,servedFarm:servedFarm(roots,material)};
  // An integration ref can move without changing any byte this candidate tests.
  // Preserve it for queue freshness, outside the executed-source identity.
  const physical={...identity,repositories:Object.fromEntries(Object.entries(repositories).map(([name,value])=>{
    const {integrationBase,...inputs}=value; return [name,inputs];
  }))};
  delete physical.baseline;
  return {...identity,hash:hash(JSON.stringify(physical))};
}
export function verifyInputs(expected,roots,options={}) {
  const actual=captureInputs(roots,{baseline:expected?.baseline || 'master',...options}), changes=[],integrationChanges=[];
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  if(expected?.version!==2) changes.push('Input manifest version changed');
  for(const repo of new Set([...Object.keys(expected?.repositories || {}),...Object.keys(actual.repositories)])) {
    const before=expected?.repositories?.[repo], after=actual.repositories[repo];
    if(!before || !after) {changes.push(`${repo}: selected source repository changed`);continue;}
    if(before.root!==after.root) changes.push(`${repo}: source path changed`);
    if(before.head!==after.head) changes.push(`${repo}: HEAD moved`);
    if(before.integrationBase!==after.integrationBase) integrationChanges.push(`${repo}: ${actual.baseline} integration baseline moved`);
    if(before.index!==after.index) changes.push(`${repo}: staged snapshot changed`);
    for(const name of new Set([...Object.keys(before.files),...Object.keys(after.files)])) if(!equal(before.files[name],after.files[name])) changes.push(`${repo}:${name} changed`);
  }
  for(const name of new Set([...Object.keys(expected?.servedFarm || {}),...Object.keys(actual.servedFarm)])) if(!equal(expected?.servedFarm?.[name],actual.servedFarm[name])) changes.push(`Served runtime ${name} changed`);
  for(const name of new Set([...Object.keys(expected?.configuration || {}),...Object.keys(actual.configuration)])) if(!equal(expected?.configuration?.[name],actual.configuration[name])) changes.push(`Test configuration ${name} changed`);
  return {valid:expected?.version===2 && expected.hash===actual.hash,integrationFresh:!integrationChanges.length,expected:expected?.hash,actual:actual.hash,changes:changes.slice(0,100),integrationChanges};
}
function processIdentity(pid) {
  try {
    const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8'), fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
    return {pid,startTicks:fields[19],commandHash:hash(fs.readFileSync(`/proc/${pid}/cmdline`))};
  } catch { return {pid,startTicks:null,commandHash:null}; }
}
function jobDefinition(directory) {
  const job=readJSON(path.join(directory,'job.json'));
  if(job.version!==1 || job.id!==path.basename(directory) || !path.isAbsolute(job.hub || '') || !job.roots || !['full','affected'].includes(job.mode)) throw new Error('Invalid job definition');
  return job;
}
function updateStatus(directory,status,extra={}) {
  let current={}; try { current=readJSON(path.join(directory,'status.json')); } catch {}
  atomicJSON(path.join(directory,'status.json'),{...current,status,updated:new Date().toISOString(),...extra});
}
export function enqueueJob({hub,roots=resolveRoots(hub),registry=loadRegistry(),baseline='master',mode='full',jobsDir=defaultJobsDir(),startWorker=true,requested=[],previousFailures}) {
  hub=path.resolve(hub);
  if(!['full','affected'].includes(mode)) throw new Error('Mode must be full or affected');
  jobsDir=outputOutsideSources(jobsDir,roots);
  const plan=planChanges({roots,registry,baseline,requested,previousFailures:previousFailures || previousFailuresFor(roots,jobsDir)});
  if(mode==='affected' && plan.mode==='full') mode='full';
  const inputs=captureInputs(roots,{baseline,testConfiguration:{mode}}), id=`${new Date().toISOString().replace(/[:.]/g,'-')}-${crypto.randomBytes(4).toString('hex')}`;
  const directory=path.join(path.resolve(jobsDir),id); fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const selected=mode==='full'?registry.suites.map(s=>s.id):plan.selected.map(s=>s.id);
  const job={version:1,id,hub,roots,mode,baseline,created:new Date().toISOString(),suffix:process.env.ERA_WT_SUFFIX || '',inputHash:inputs.hash,selected};
  atomicJSON(path.join(directory,'job.json'),job); atomicJSON(path.join(directory,'inputs.json'),inputs);
  atomicJSON(path.join(directory,'plan.json'),plan); atomicJSON(path.join(directory,'selected.json'),selected);
  updateStatus(directory,'queued');
  if(startWorker) {
    const log=fs.openSync(path.join(directory,'worker.log'),'a',0o600);
    const worker=spawn(process.execPath,[CLI_FILE,'_worker',directory],{detached:true,stdio:['ignore',log,log],env:{...process.env,ERA_TEST_JOBS:path.resolve(jobsDir)}});
    fs.closeSync(log);
    worker.on('error',error=>{
      atomicJSON(path.join(directory,'outcome.json'),{version:1,executed:false,error:error.message,finished:new Date().toISOString(),completeEvidence:false});
      updateStatus(directory,'failed');
    });
    updateStatus(directory,readJSON(path.join(directory,'status.json')).status,{worker:processIdentity(worker.pid)}); worker.unref();
  }
  return {id,directory,mode,selected:selected.length,inputHash:inputs.hash};
}
export function readJob(directory) {
  const job=jobDefinition(directory), status=readJSON(path.join(directory,'status.json'));
  let outcome; try { outcome=readJSON(path.join(directory,'outcome.json')); } catch {}
  return {...job,...status,directory,outcome};
}
export function listJobs(jobsDir=defaultJobsDir()) {
  if(!fs.existsSync(jobsDir)) return [];
  return fs.readdirSync(jobsDir).filter(n=>/^\d{4}-/.test(n)).sort().map(name=>{
    const directory=path.join(jobsDir,name);
    try { return readJob(directory); } catch(error) { return {id:name,status:'invalid',error:error.message,directory}; }
  });
}
export function previousFailuresFor(roots,jobsDir=defaultJobsDir()) {
  const results=new Map();
  const identity=JSON.stringify(Object.entries(roots).sort(([a],[b])=>a.localeCompare(b)));
  const jobs=listJobs(jobsDir).filter(job=>job.roots && JSON.stringify(Object.entries(job.roots).sort(([a],[b])=>a.localeCompare(b)))===identity && job.outcome)
    .sort((a,b)=>(a.outcome.finished || '').localeCompare(b.outcome.finished || ''));
  for(const job of jobs) for(const suite of job.outcome.suites || []) {
    if(suite.status==='pass' || suite.status==='fail') results.set(suite.id,suite.status);
  }
  return [...results].filter(([,status])=>status==='fail').map(([id])=>id).sort();
}
export function requestCancellation(directory) {
  const job=readJob(directory);
  outputOutsideSources(directory,job.roots);
  if(job.status==='running') throw new Error('Running job cannot be terminated safely: active suite processes have no complete cancellation contract');
  if(!['queued','waiting','cancel-requested'].includes(job.status)) throw new Error(`Job is already ${job.status}`);
  fs.writeFileSync(path.join(directory,'cancel.request'),`${job.id}\n`,{mode:0o600});
  updateStatus(directory,'cancel-requested');
  return {id:job.id,status:'cancel-requested',note:'No process was signalled. A gate still waiting will stop after acquiring its lock; already active work may finish.'};
}
export async function runJob(directory,{registry=loadRegistry(),roots,watchInterval=5000}={}) {
  directory=path.resolve(directory); const job=jobDefinition(directory); roots=roots || job.roots;
  directory=outputOutsideSources(directory,roots);
  try { fs.mkdirSync(path.join(directory,'worker.claim')); }
  catch(error) { if(error.code==='EEXIST') throw new Error('Job is already claimed by a worker'); throw error; }
  const finish=(status,outcome)=>{
    const result={version:1,mode:job.mode,completeEvidence:false,finished:new Date().toISOString(),...outcome};
    atomicJSON(path.join(directory,'outcome.json'),result); updateStatus(directory,status,{finished:result.finished}); return result;
  };
  if(fs.existsSync(path.join(directory,'cancel.request'))) return finish('cancelled',{executed:false});
  const expected=readJSON(path.join(directory,'inputs.json'));
  const verification=()=>verifyInputs(expected,roots,{testConfiguration:{mode:job.mode}});
  try {
    checkInventory(roots,registry);
    const checked=verification();
    if(!checked.valid || !checked.integrationFresh) return finish('stale',{executed:false,reason:'Queued source or integration base changed',changes:[...checked.changes,...checked.integrationChanges]});
  } catch(error) { return finish('failed',{executed:false,error:error.message}); }
  const env={...process.env,ERA_WT_SUFFIX:job.suffix,ERA_GATE_MODE:job.mode,ERA_GATE_INPUTS:path.join(directory,'inputs.json'),ERA_GATE_CANCEL_FILE:path.join(directory,'cancel.request'),ERA_GATE_JOB_DIR:directory};
  if(job.mode==='affected') env.ERA_GATE_SELECTED=path.join(directory,'selected.json'); else delete env.ERA_GATE_SELECTED;
  updateStatus(directory,'waiting',{started:new Date().toISOString(),worker:processIdentity(process.pid)});
  const output=fs.createWriteStream(path.join(directory,'gate.log'),{flags:'a',mode:0o600});
  const child=spawn('bash',[path.join(job.hub,'tools','era-gate.sh')],{cwd:job.hub,env,stdio:['ignore','pipe','pipe']});
  updateStatus(directory,'waiting',{child:processIdentity(child.pid)});
  let buffer='', spawnError=null, running=false, executing=false, staleWhileWaiting=null; const outcomes=[];
  const consume=data=>{
    output.write(data); buffer+=data.toString();
    let newline;
    while((newline=buffer.indexOf('\n'))>=0) {
      const line=buffer.slice(0,newline); buffer=buffer.slice(newline+1);
      if(line==='== era-gate: lock acquired ==') {running=true;if(!staleWhileWaiting) updateStatus(directory,'running');}
      const started=/^RUN ([^ ]+)/.exec(line);
      if(started) {executing=true;updateStatus(directory,'running',{activeSuite:started[1]});}
      // REUSE (a qualifying earlier pass) and FLAKY (a pass after a failure on
      // the same inputs; it replaces that suite's first FAIL) are passes.
      const match=/^(PASS|FAIL|REUSE|FLAKY) ([^ ]+)/.exec(line);
      if(match) {
        const suite=registry.suites.find(s=>path.basename(splitID(s.id).relative)===match[2] || path.basename(splitID(s.id).relative,'.js')===match[2]);
        const id=suite?.id || match[2];
        if(match[1]==='FLAKY') { const first=outcomes.findIndex(o=>o.id===id && o.status==='fail'); if(first>=0) outcomes.splice(first,1); }
        outcomes.push({id,status:match[1]==='FAIL'?'fail':'pass',...(match[1]==='REUSE'?{reused:true}:{}),...(match[1]==='FLAKY'?{flaky:true}:{})});
        updateStatus(directory,readJSON(path.join(directory,'status.json')).status,{activeSuite:null,lastSuite:match[2],completedSuites:outcomes.length});
      }
    }
  };
  child.stdout.on('data',consume); child.stderr.on('data',consume);
  const watcher=setInterval(()=>{
    if(running || staleWhileWaiting) return;
    try {
      const result=verification();
      if(result.valid && result.integrationFresh) return;
      staleWhileWaiting=[...result.changes,...result.integrationChanges];
    } catch(error) {staleWhileWaiting=[error.message];}
    fs.writeFileSync(path.join(directory,'cancel.request'),`${job.id}: stale inputs\n`,{mode:0o600});
    updateStatus(directory,'stale',{reason:'Queued inputs changed; waiting gate will refuse execution',changes:staleWhileWaiting});
  },watchInterval);
  const ended=await new Promise(resolve=>{
    child.on('error',error=>{spawnError=error.message;});
    child.on('close',(code,signal)=>resolve({exitCode:code,signal}));
  });
  clearInterval(watcher);
  await new Promise(resolve=>output.end(resolve));
  let checked; try { checked=verification(); } catch(error) {checked={valid:false,changes:[error.message]};}
  if(staleWhileWaiting || !checked.valid) return finish('stale',{...ended,executed:executing,suites:outcomes,reason:staleWhileWaiting?'Source inputs changed while waiting':'Source inputs changed while running',changes:staleWhileWaiting || checked.changes});
  if(fs.existsSync(path.join(directory,'cancel.request')) && ended.exitCode!==0) return finish('cancelled',{...ended,executed:true,suites:outcomes});
  const missingSuites=job.selected.filter(id=>!outcomes.some(s=>s.id===id));
  const failedSuites=outcomes.filter(s=>s.status==='fail').map(s=>s.id);
  return finish(ended.exitCode===0 && !missingSuites.length && !failedSuites.length?'passed':'failed',{...ended,executed:true,suites:outcomes,missingSuites,failedSuites,integrationStale:!checked.integrationFresh,integrationChanges:checked.integrationChanges,testedInputHash:expected.hash,error:spawnError});
}
