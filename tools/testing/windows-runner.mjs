import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import net from 'node:net';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {prepareSnapshot,verifyOrigins} from './parallel-snapshot.mjs';
import {atomicJSON,runtimeManifest,verifyRuntime} from './parallel-worker.mjs';

const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const within=(child,parent)=>child===parent || child.startsWith(parent+path.sep);
function regular(file) {
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink())throw Error('Artifact must be a regular file');
  return fs.readFileSync(file);
}
function absolute(file) {
  if(!path.isAbsolute(file))throw Error('An absolute path is required');
  return path.resolve(file);
}
function canonicalDestination(file) {
  let ancestor=file;const missing=[];
  while(!fs.existsSync(ancestor)){missing.unshift(path.basename(ancestor));ancestor=path.dirname(ancestor);}
  return path.join(fs.realpathSync(ancestor),...missing);
}

export function freezeArtifacts({source,destination}) {
  source=absolute(source);destination=absolute(destination);
  if(fs.lstatSync(source).isSymbolicLink())throw Error('Artifact directory must not be an alias');
  source=fs.realpathSync(source);destination=canonicalDestination(destination);
  if(within(destination,source) || within(source,destination))throw Error('Artifact copy overlaps its source');
  if(fs.existsSync(destination))throw Error('Artifact destination already exists');
  const feed=JSON.parse(regular(path.join(source,'latest.json')));
  if(!/^v\d+\.\d+\.\d+$/.test(feed.version || '') || !/^\d{8}\.\d{4}$/.test(feed.build || ''))throw Error('Invalid artifact version/build');
  const patch=/^v(\d+)\.(\d+)\.([1-9]\d*)$/.exec(feed.version);
  if(!patch || feed.installer!==`v${patch[1]}.${patch[2]}.0`)throw Error('This driver supports the complete patch baseline only');
  if(!/^[a-f0-9]{64}$/.test(feed.sha256 || ''))throw Error('Missing payload digest');
  const installer=feed.installer_file || 'New-ERA-Setup.exe';
  if(!/^[A-Za-z0-9._-]+\.exe$/.test(installer))throw Error('Unsafe installer name');
  const names=['HEAD','TREE','latest.json','checksums.txt',installer,'new-era-suite.tar.gz',`new-era-suite-${feed.version}.tar.gz`,'new-era-suite.zip'];
  const originals=Object.fromEntries(names.map(name=>[name,regular(path.join(source,name))]));
  for(const name of ['HEAD','TREE'])if(!/^[a-f0-9]{40}$/.test(originals[name].toString().trim()))throw Error('Invalid artifact source identity');
  if(digest(originals['new-era-suite.tar.gz'])!==feed.sha256 || digest(originals[`new-era-suite-${feed.version}.tar.gz`])!==feed.sha256)throw Error('Payload does not match its feed/versioned alias');
  fs.mkdirSync(destination,{recursive:true,mode:0o700});
  const files={};
  for(const [name,bytes] of Object.entries(originals)) {
    fs.writeFileSync(path.join(destination,name),bytes,{flag:'wx',mode:0o400});
    const sha256=digest(bytes);files[name]={sha256,bytes:bytes.length};
    if(digest(regular(path.join(source,name)))!==sha256)throw Error('Artifact changed while preparing');
  }
  return {version:1,source,destination,versionTag:feed.version,build:feed.build,head:originals.HEAD.toString().trim(),tree:originals.TREE.toString().trim(),files};
}

export function verifyArtifactCopies(manifest) {
  const reasons=[];
  try {
    if(manifest.version!==1 || Object.keys(manifest.files).length!==8)throw Error('Incomplete artifact manifest');
    for(const [name,row] of Object.entries(manifest.files)) {
      if(path.basename(name)!==name)throw Error('Artifact path escapes its directory');
      for(const root of [manifest.source,manifest.destination]) {
        const bytes=regular(path.join(root,name));
        if(bytes.length!==row.bytes || digest(bytes)!==row.sha256)reasons.push(`Artifact bytes changed: ${name}`);
      }
    }
  }catch(error){reasons.push(error.message);}
  return {valid:reasons.length===0,reasons};
}

export function freezeApplication({manifest,destination}) {
  manifest=absolute(manifest);destination=canonicalDestination(absolute(destination));
  if(fs.realpathSync(manifest)!==manifest)throw Error('Application manifest must not be an alias');
  const bytes=regular(manifest),plan=JSON.parse(bytes),source=path.dirname(manifest);
  if(plan.version!==1 || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(plan.id || '') || !Array.isArray(plan.files) || !plan.files.length)throw Error('Invalid application manifest');
  const relative=name=>typeof name==='string' && /^[A-Za-z0-9._/-]+$/.test(name) && name.split('/').every(part=>part && part!=='.' && part!=='..');
  if(!relative(plan.entry) || !plan.entry.endsWith('.mjs') || !plan.files.includes(plan.entry) || new Set(plan.files).size!==plan.files.length || !plan.files.every(relative))throw Error('Application files must be an explicit relative closure including its entry');
  if(within(destination,source) || within(source,destination) || fs.existsSync(destination))throw Error('Application copy overlaps existing inputs');
  const files={};
  for(const name of plan.files) {
    const file=path.join(source,name);
    if(fs.realpathSync(file)!==file)throw Error('Application file must not be an alias');
    files[name]={sha256:copyRegular(file,path.join(destination,name)),bytes:fs.statSync(file).size};
  }
  const frozen={id:plan.id,entry:plan.entry,source,root:destination,manifest,manifestDigest:digest(bytes),files,runtime:runtimeManifest(destination)};
  const checked=verifyApplication(frozen);if(!checked.valid)throw Error(checked.reasons.join('; '));
  return frozen;
}
export function verifyApplication(application) {
  if(!application)return {valid:true,reasons:[]};
  const reasons=[];
  try {
    if(fs.realpathSync(application.manifest)!==application.manifest || digest(regular(application.manifest))!==application.manifestDigest)throw Error('Application manifest changed');
    const plan=JSON.parse(regular(application.manifest));
    if(plan.version!==1 || plan.id!==application.id || plan.entry!==application.entry || application.source!==path.dirname(application.manifest) ||
      !Array.isArray(plan.files) || new Set(plan.files).size!==plan.files.length || !plan.files.includes(plan.entry) ||
      JSON.stringify([...plan.files].sort())!==JSON.stringify(Object.keys(application.files).sort()))throw Error('Application metadata differs from its pinned manifest');
    for(const [name,row] of Object.entries(application.files)) {
      if(path.isAbsolute(name) || name.split('/').some(part=>!part || part==='.' || part==='..'))throw Error('Application input escapes its root');
      for(const root of [application.source,application.root]) {
        const file=path.join(root,name),bytes=regular(file);
        if(fs.realpathSync(file)!==file || bytes.length!==row.bytes || digest(bytes)!==row.sha256)throw Error('Application input changed: '+name);
      }
    }
    if(!verifyRuntime(application.root,application.runtime).valid)throw Error('Application copied closure changed');
  }catch(error){reasons.push(error.message);}
  return {valid:reasons.length===0,reasons};
}

export function validateWindowsTap(text,expectedCount) {
  const counts={},reasons=[];
  if(!Number.isSafeInteger(expectedCount) || expectedCount<=0)reasons.push('Expected case count must be positive');
  for(const key of ['tests','pass','fail','cancelled','skipped','todo']) {
    const matches=[...text.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`,'gm'))];
    if(matches.length!==1){reasons.push(`Missing or duplicate TAP ${key}`);continue;}
    counts[key]=Number(matches[0][1]);
  }
  if(counts.tests!==expectedCount || counts.pass!==expectedCount)reasons.push('Windows case inventory differs');
  for(const key of ['fail','cancelled','skipped','todo'])if(counts[key]!==0)reasons.push(`Windows ${key} is not zero`);
  if(/^\s*not ok\b|^\s*(?:not )?ok\b[^\n]*#\s*(?:SKIP|TODO)\b/im.test(text))reasons.push('Windows failure or omitted case');
  return {valid:reasons.length===0,counts,reasons};
}

export function bindVmLibrary(source,toolsDirectory) {
  absolute(toolsDirectory);
  const declaration=/^const VMTOOLS = path\.join\(path\.dirname\(HUB\), "era-family", "tools", "vm"\);$/gm;
  if([...source.matchAll(declaration)].length!==1)throw Error('Unsupported VM transport binding');
  return source.replace(declaration,`const VMTOOLS = ${JSON.stringify(toolsDirectory)};`);
}

export function bindVmRunner(source) {
  const replace=(pattern,replacement)=>{
    const matches=typeof pattern==='string'?source.split(pattern).length-1:[...source.matchAll(new RegExp(pattern.source,pattern.flags.includes('g')?pattern.flags:pattern.flags+'g'))].length;
    if(matches!==1)throw Error('Unsupported Windows control format');
    source=source.replace(pattern,replacement);
  };
  // the stock run-slot block (shared /tmp slot locks) becomes the job's own lock
  replace(/^# ---- run slot [^\n]*\n[\s\S]*?^# ---- end of run slot ----$/m,'exec 9>"$WINDOWS_JOB_DIR/vm.lock"\nflock -w 7200 9 || { echo "vm-e2e: another run holds the VM lock"; exit 1; }');
  replace('OUT="$HUB/gate/vm-e2e"; rm -rf "$OUT"; mkdir -p "$OUT"','OUT="$WINDOWS_JOB_DIR/vm-out"; [ ! -e "$OUT" ] || { echo "owned output already exists"; exit 2; }; mkdir -p "$OUT"');
  replace(/^bash "\$VMT\/qa.sh" up[^\n]*$/m,line=>line+'\npython3 -B "$WINDOWS_TRANSPORT" bootstrap || exit 3');
  replace('qa_release(){ bash "$VMT/qa.sh" down || true; }','qa_release(){ :; } # The managed worker owns host teardown after every required phase.');
  const bareRsync='rsync -q -e "ssh -i $VM_SSH_KEY"';
  if(source.split(bareRsync).length<3)throw Error('Unsupported Windows artifact transport');
  source=source.replaceAll(bareRsync,'rsync -q -e "ssh -F /dev/null -i $VM_SSH_KEY -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -o UserKnownHostsFile=$QA_KNOWN_HOSTS -o GlobalKnownHostsFile=/dev/null"');
  replace(/^  \$DROP "pkill -f[^\n]*\n    \| grep[^\n]*$/m,'  python3 -B "$WINDOWS_TRANSPORT" feed || { echo "owned feed failed"; exit 3; }');
  const start=source.indexOf('# ---- the DevTools tunnel ');

  const end=source.indexOf('trap cleanup EXIT',start);
  if(start<0 || end<start)throw Error('Unsupported Windows tunnel lifecycle');
  const replacement=`# windows-transport.py owns this job's tunnel and feed exclusively.
echo "-- owned DevTools tunnel :$VM_CDP_PORT (local) -> own QA host :9223"
python3 -B "$WINDOWS_TRANSPORT" local || { echo "owned tunnel failed"; exit 3; }
cleanup() {
  local status=$?
  trap - EXIT
  if [ "\${WINDOWS_APPLICATION_PENDING:-0}" != 1 ]; then python3 -B "$WINDOWS_TRANSPORT" cleanup || status=1; fi
  qa_release || status=1
  exit "$status"
}
trap cleanup EXIT`;
  source=source.slice(0,start)+replacement+source.slice(end+'trap cleanup EXIT'.length);
  if(/\bpkill\b|\bkillall\b/.test(source))throw Error('Unowned process cleanup remains in Windows control');
  return source;
}

const driverTools=fileURLToPath(new URL('../',import.meta.url));
const shell=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
export function bindVmEnvironment(helper) {
  absolute(helper);
  return '#!/bin/bash\n. '+shell(helper)+' || exit $?\ncase "${WINDOWS_PHASE:-baseline}" in\n  application) VM_OUT="$QA_JOB_DIR/application-out";;\n  preparation) VM_OUT="$QA_JOB_DIR/preparation-out";;\nesac\nexport VM_OUT\n';
}
export function bindVmRevert({original,node,cli,directory}) {
  for(const file of [original,node,cli,directory])absolute(file);
  return '#!/bin/bash\nbash '+shell(original)+' "$@" || exit $?\nexec '+shell(node)+' '+shell(cli)+' _initialize '+shell(directory)+'\n';
}
export const windowsState=()=>path.join(os.homedir(),'.local','state','era-windows-gates');
function copyRegular(source,destination,mode=0o400) {
  const bytes=regular(source);fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
  fs.writeFileSync(destination,bytes,{mode,flag:'wx'});return digest(bytes);
}
function processIdentity(pid=process.pid) {
  const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').at(-1).split(' ');
  return {pid,startTicks:stat[19],commandHash:digest(fs.readFileSync(`/proc/${pid}/cmdline`))};
}

export function prepareWindowsRun({hub,dist,familyTools,suffix='',state=windowsState(),cdpPort=8511,slot='managed',applicationManifest=null,preparationManifest=null}) {
  if(!['managed','legacy'].includes(slot))throw Error('Unknown Windows capacity slot');
  if(!Number.isSafeInteger(cdpPort) || cdpPort<8500 || cdpPort>8599)throw Error('Managed CDP port must be8500–8599');
  for(const file of [hub,dist,familyTools,state])absolute(file);
  const id='win-'+new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z')+'-'+crypto.randomBytes(4).toString('hex');
  const directory=path.join(state,'jobs',id);fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(fs.realpathSync(directory)!==directory || fs.statSync(directory).uid!==process.getuid())throw Error('Job directory must be owned and unaliased');
  const seedDir=path.join(path.dirname(hub),'era-family/test-data');
  const manifest=prepareSnapshot({hub,suffix,workspace:path.join(directory,'workspace'),seedDir});
  const artifacts=freezeArtifacts({source:dist,destination:path.join(directory,'dist')});
  if(artifacts.head!==manifest.origins['era-hub'].head || artifacts.tree!==manifest.origins['era-hub'].tree)throw Error('Artifact source differs from selected hub; no automatic equivalence exception');
  const control=path.join(directory,'control'),helpers=path.join(manifest.workspace,'era-family/tools/vm');
  const executionRoot=path.join(directory,'execution'),executionHub=path.join(executionRoot,'era-hub');
  fs.mkdirSync(executionRoot,{recursive:true,mode:0o700});
  fs.cpSync(manifest.hub,executionHub,{recursive:true,filter:file=>path.basename(file)!=='.git'});
  fs.symlinkSync(path.join(manifest.workspace,'era-family'),path.join(executionRoot,'era-family'));
  fs.mkdirSync(helpers,{recursive:true,mode:0o700});
  const inputs={};
  for(const name of ['parallel-qa.py','parallel-env.sh','vm.sh','ship.sh','revert.sh','feed.py']) {
    inputs['family/'+name]=copyRegular(path.join(familyTools,name),path.join(helpers,name),0o500);
  }
  fs.writeFileSync(path.join(helpers,'qa.sh'),'#!/bin/bash\n[ "${1:-}" != up ] || set -- status\nexec python3 -B '+shell(path.join(helpers,'parallel-qa.py'))+' "$@"\n',{mode:0o500,flag:'wx'});
  fs.writeFileSync(path.join(helpers,'env.sh'),bindVmEnvironment(path.join(helpers,'parallel-env.sh')),{mode:0o500,flag:'wx'});
  const vmFile=path.join(helpers,'vm.sh');fs.chmodSync(vmFile,0o700);
  const vmSource=fs.readFileSync(vmFile,'utf8'),cdp=/^  cdp-forward\).*$/gm;
  if([...vmSource.matchAll(cdp)].length!==1)throw Error('Unsupported private VM bridge');
  fs.writeFileSync(vmFile,vmSource.replace(cdp,'  cdp-forward) exec python3 -B "$WINDOWS_TRANSPORT" cdp;;'));fs.chmodSync(vmFile,0o500);
  for(const relative of ['windows-gate.mjs','testing/windows-runner.mjs','testing/windows-transport.py','testing/windows-process.py','testing/parallel-snapshot.mjs','testing/parallel-worker.mjs']) {
    copyRegular(path.join(driverTools,relative),path.join(control,'tools',relative),0o500);
  }
  const library=path.join(executionHub,'tests-vm/lib/vm.mjs'),originalLibrary=fs.readFileSync(library,'utf8');
  const boundLibrary=bindVmLibrary(originalLibrary,helpers);fs.writeFileSync(library,boundLibrary);
  const originalRunner=fs.readFileSync(path.join(manifest.hub,'tools/vm-e2e.sh'),'utf8');
  const runner=path.join(executionHub,'tools/vm-e2e.sh');fs.writeFileSync(runner,bindVmRunner(originalRunner));fs.chmodSync(runner,0o500);
  // Windows uses the real guest browser. Only its host-side protocol library is needed.
  const require=createRequire(import.meta.url),modules=path.join(executionRoot,'node_modules');fs.mkdirSync(modules);
  for(const name of ['playwright','playwright-core']) {
    const source=path.dirname(require.resolve(name+'/package.json'));
    fs.cpSync(source,path.join(modules,name),{recursive:true,dereference:false});
  }
  copyRegular(process.execPath,path.join(control,'node'),0o500);
  const testSource=fs.readFileSync(path.join(manifest.hub,'tests-vm/leg-b-update.e2e.mjs'),'utf8');
  const expectedCases=[...testSource.matchAll(/^test\(/gm)].length;
  if(!expectedCases || /\btest\.(only|skip|todo)\s*\(/.test(testSource))throw Error('Unsupported Windows case inventory');
  const binding={library:{original:digest(originalLibrary),executed:digest(boundLibrary)},runner:{original:digest(originalRunner),executed:digest(fs.readFileSync(runner))},familyInputs:inputs};
  atomicJSON(path.join(directory,'bindings.json'),binding);
  const application=applicationManifest?freezeApplication({manifest:applicationManifest,destination:path.join(executionRoot,'application')}):null;
  const preparation=preparationManifest?freezeApplication({manifest:preparationManifest,destination:path.join(executionRoot,'preparation')}):null;
  if(preparation) {
    const revert=path.join(helpers,'revert.sh'),original=path.join(helpers,'revert-original.sh');
    fs.renameSync(revert,original);
    fs.writeFileSync(revert,bindVmRevert({original,node:path.join(control,'node'),cli:path.join(control,'tools/windows-gate.mjs'),directory}),{mode:0o500,flag:'wx'});
  }
  const job={version:2,id,directory,manifest,artifacts,application,preparation,cdpPort,slot,expectedCases,only:'b',helpers,runner,control,executionHub,controlInputs:runtimeManifest(control),helperInputs:runtimeManifest(helpers),moduleInputs:runtimeManifest(modules),caseInputs:runtimeManifest(path.join(executionHub,'tests-vm')),fixtureInputs:runtimeManifest(path.join(executionHub,'tests/fixtures')),runnerDigest:digest(fs.readFileSync(runner)),created:new Date().toISOString(),completeReleaseEvidence:false};
  atomicJSON(path.join(directory,'job.json'),job);atomicJSON(path.join(directory,'status.json'),{status:'prepared'});return job;
}

export function claimWindowsJob(directory) {
  const file=path.join(absolute(directory),'worker.claim');
  const descriptor=fs.openSync(file,'wx',0o600);
  fs.writeFileSync(descriptor,JSON.stringify({launcher:processIdentity(),at:new Date().toISOString()})+'\n');fs.closeSync(descriptor);
}
export async function probeFreeLoopback(port) {
  if(!Number.isSafeInteger(port) || port<1 || port>65535)throw Error('Invalid loopback port');
  await new Promise((resolve,reject)=>{
    const probe=net.createServer();probe.once('error',reject);
    probe.listen({host:'127.0.0.1',port,exclusive:true},()=>probe.close(error=>error?reject(error):resolve()));
  });
}
export async function requireFreeCdp(port) {
  if(!Number.isSafeInteger(port) || port<8500 || port>8599)throw Error('Invalid managed CDP port');
  await probeFreeLoopback(port);
}

export function verifyWindowsInputs(job) {
  const reasons=[...verifyOrigins(job.manifest).reasons,...verifyArtifactCopies(job.artifacts).reasons,...verifyApplication(job.application).reasons,...verifyApplication(job.preparation).reasons];
  for(const phase of ['application','preparation'])if(job[phase] && job[phase].root!==path.join(path.dirname(job.executionHub),phase))reasons.push('Pinned phase root differs from the job');
  if(job.version!==2 || !['managed','legacy'].includes(job.slot))reasons.push('Unsupported job schema or capacity slot');
  if(job.artifacts.head!==job.manifest.origins['era-hub'].head || job.artifacts.tree!==job.manifest.origins['era-hub'].tree)reasons.push('Artifact does not belong to selected hub source');
  for(const [directory,expected] of [[job.control,job.controlInputs],[job.helpers,job.helperInputs],
    [path.join(path.dirname(job.executionHub),'node_modules'),job.moduleInputs],
    [path.join(job.executionHub,'tests-vm'),job.caseInputs],[path.join(job.executionHub,'tests/fixtures'),job.fixtureInputs]]) {
    if(!verifyRuntime(directory,expected).valid)reasons.push('Pinned Windows control or runtime changed');
  }
  try{
    if(digest(regular(job.runner))!==job.runnerDigest)reasons.push('Managed runner changed');
    const source=regular(path.join(job.manifest.hub,'tests-vm/leg-b-update.e2e.mjs')).toString();
    if([...source.matchAll(/^test\(/gm)].length!==job.expectedCases || job.expectedCases<=0)reasons.push('Windows case inventory changed');
  }catch(error){reasons.push(error.message);}
  return {valid:reasons.length===0,reasons};
}

async function executeOwned({program,args,cwd,environment,log,captureChildIdentity=processIdentity,onCapture=()=>{}}) {
  let child,done,permitSent=false,completed=false;
  const output=fs.openSync(log,'a',0o600);
  try {
    try{child=spawn('bash',['-c','IFS= read -r permit\n[ "$permit" = run ] || exit 2\nexec "$@"','windows-worker',program,...args],{cwd,env:environment,stdio:['pipe',output,output]});}
    finally{fs.closeSync(output);}
    done=new Promise(resolve=>{
      let error=null;child.once('error',value=>{error=value.message;});
      child.stdin?.on('error',value=>{error ||= value.message;});
      child.once('close',(code,signal)=>{completed=true;resolve({code,signal,error});});
    });
    if(!Number.isSafeInteger(child.pid) || child.pid<=1)throw Error('Windows child failed before identity capture');
    const launchIdentity=captureChildIdentity(child.pid);
    const execution={argv:[program,...args],commandHash:digest(Buffer.from([program,...args].join('\0')+'\0'))};
    let identity={...launchIdentity,captureStage:'launch',launchIdentity,execution};onCapture(identity);
    child.stdin.end('run\n');permitSent=true;
    // exec preserves PID/start while replacing the waiting shell's command.
    // Keep both receipts; never treat its pre-permit hash as the running argv.
    for(let attempt=0;attempt<100 && !completed;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,1));
      let observed;try{observed=processIdentity(child.pid);}catch(error){if(error.code==='ENOENT' || error.code==='ESRCH')break;throw error;}
      if(observed.startTicks!==launchIdentity.startTicks)throw Error('Owned Windows child identity changed during exec');
      if(observed.commandHash===execution.commandHash) {
        identity={...observed,captureStage:'execution',launchIdentity,execution};onCapture(identity);break;
      }
    }
    return {...await done,identity};
  }finally{if(done){if(!permitSent)child.stdin?.end();await done;}}
}
function phaseEnvironment(job,phase,environment=process.env) {
  const library=path.join(job.executionHub,'tests-vm/lib/vm.mjs');
  return {...environment,PYTHONDONTWRITEBYTECODE:'1',WINDOWS_JOB_DIR:job.directory,QA_JOB_DIR:job.directory,QA_RUN_ID:job.id,
    WINDOWS_PHASE:phase,VM_OUT:path.join(job.directory,phase+'-out'),
    ERA_VM_MODULE:library,ERA_VM_MODULE_SHA256:digest(regular(library)),
    VM_DIST:job.artifacts.destination,VM_CANDIDATE_VERSION:job.artifacts.versionTag,VM_CANDIDATE_BUILD:job.artifacts.build,
    PATH:job.control+':'+process.env.PATH};
}
export async function runWindowsPreparation(directory,{verifyInputs=verifyWindowsInputs,verifyContext=null}={}) {
  directory=absolute(directory);const job=JSON.parse(regular(path.join(directory,'job.json')));
  if(job.directory!==directory || !job.preparation)throw Error('No pinned preparation for this job');
  const check=verifyInputs(job);if(!check.valid)throw Error(check.reasons.join('; '));
  const env=phaseEnvironment(job,'preparation');
  const context=verifyContext?verifyContext(job,env):spawnSync('python3',['-B',path.join(job.helpers,'parallel-qa.py'),'_env-check',path.join(directory,'private/vm.env')],{env,stdio:'ignore'}).status===0;
  if(!context)throw Error('Preparation private context was refused');
  const claim=fs.openSync(path.join(directory,'preparation.claim'),'wx',0o600);fs.closeSync(claim);
  const output=env.VM_OUT;fs.mkdirSync(output,{mode:0o700});
  let exit=null,failure=null;
  try {
    exit=await executeOwned({program:path.join(job.control,'node'),args:[path.join(job.preparation.root,job.preparation.entry)],cwd:job.preparation.root,environment:env,log:path.join(directory,'preparation.log')});
    if(exit.code!==0 || exit.signal || exit.error)throw Error('Pinned native preparation failed');
    const after=verifyInputs(job);if(!after.valid)throw Error(after.reasons.join('; '));
  }catch(error){failure=error.message;}
  const result={version:1,runId:job.id,id:job.preparation.id,manifestDigest:job.preparation.manifestDigest,valid:!failure,error:failure,
    exitCode:exit?.code,signal:exit?.signal,child:exit?.identity,output,acceptanceClaim:false,finished:new Date().toISOString()};
  atomicJSON(path.join(directory,'preparation.json'),result);return result;
}

export async function runWindowsJob(directory,{secretEnv,apiEnv,leaseDir,verifyInputs=verifyWindowsInputs,captureChildIdentity=processIdentity,checkCdp=requireFreeCdp}) {
  directory=absolute(directory);const job=JSON.parse(regular(path.join(directory,'job.json')));
  if(job.directory!==directory || job.version!==2 || job.only!=='b' || !['managed','legacy'].includes(job.slot))throw Error('Job identity or supported phase changed');
  const status=(state,extra={})=>atomicJSON(path.join(directory,'status.json'),{status:state,updated:new Date().toISOString(),...extra});
  const owner=processIdentity(),started=new Date().toISOString();
  status('checking',{started,owner});
  const transport=path.join(job.control,'tools/testing/windows-transport.py'),manager=path.join(job.helpers,'parallel-qa.py');
  const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',WINDOWS_JOB_DIR:directory,QA_JOB_DIR:directory,
    QA_RUN_ID:job.id,QA_CONTEXT_FILE:path.join(directory,'private/vm.env'),QA_OWNER_PID:String(owner.pid),QA_OWNER_START_TICKS:owner.startTicks,
    QA_SECRET_ENV_FILE:absolute(secretEnv),QA_API_ENV_FILE:absolute(apiEnv),QA_SLOT:job.slot,
    QA_LEASE_DIR:absolute(leaseDir),VM_CDP_PORT:String(job.cdpPort),VM_FEED_PORT:'8427',
    VM_FEED_SOURCE:path.join(job.helpers,'feed.py'),VM_FEED_DIR:'/root/qa/feed',WINDOWS_TRANSPORT:transport,
    VM_CDP:`http://127.0.0.1:${job.cdpPort}`,VM_OUT:path.join(directory,'vm-out'),PATH:job.control+':'+process.env.PATH,
    VM_DIST:job.artifacts.destination,VM_CANDIDATE_VERSION:job.artifacts.versionTag,VM_CANDIDATE_BUILD:job.artifacts.build,
    WINDOWS_PHASE:'baseline',WINDOWS_APPLICATION_PENDING:job.application?'1':'0'};
  // The copied interpreter is named node so child leg invocations use its pinned bytes.
  const call=(args)=>{
    const stdio=job.slot==='legacy'?['ignore','pipe','pipe','ignore','ignore','ignore',6]:['ignore','pipe','pipe'];
    const result=spawnSync('python3',['-B',...args],{env,stdio,encoding:'utf8',timeout:400000});
    return {code:result.status,stdout:result.stdout || '',output:(result.stdout || '')+(result.stderr || ''),error:result.error?.message};
  };
  const resources=path.join(directory,'private/resource.json');let failure=null,tap=null,allocation=null,childIdentity=null,baselineExit=null,preparationResult=null,applicationResult=null,baselineDigest=null,teardown=[];
  const execute=async({program,args,cwd,environment,log,phase})=>{
    return executeOwned({program,args,cwd,environment,log,captureChildIdentity,onCapture:identity=>{childIdentity=identity;status('running',{started,owner,phase,child:identity});}});
  };
  try {
    let checked=verifyInputs(job);if(!checked.valid)throw Error(checked.reasons.join('; '));
    await checkCdp(job.cdpPort);
    status('waiting',{started,owner});const deadline=Date.now()+7200000;
    while(true) {
      const result=call([manager,'up']);
      fs.appendFileSync(path.join(directory,'manager.log'),result.output,{mode:0o600});
      if(result.code===0){
        allocation=JSON.parse(result.stdout);
        if(allocation.ready!==true || allocation.status!=='ready' || allocation.runId!==job.id || allocation.slot!==job.slot || !/^[1-9]\d*$/.test(String(allocation.resourceId)) || allocation.owner?.pid!==owner.pid || allocation.owner?.startTicks!==owner.startTicks || !fs.existsSync(resources))throw Error('Host allocation did not prove the expected ready resource');
        if(!/^[A-Za-z0-9_.-]+$/.test(allocation.guestUser || ''))throw Error('Host context did not provide its validated guest account');
        env.VM_GUEST_USER=allocation.guestUser;
        break;
      }
      if(result.code!==6 || Date.now()>deadline)throw Error('Managed host allocation failed; inspect private manager log');
      if(!verifyOrigins(job.manifest).valid)throw Error('Queued Windows source moved');
      await new Promise(resolve=>setTimeout(resolve,5000));
    }
    checked=verifyInputs(job);if(!checked.valid)throw Error(checked.reasons.join('; '));
    status('running',{started,owner});
    const exit=await execute({program:'bash',args:[job.runner,job.artifacts.destination,'--only','b'],cwd:job.executionHub,environment:env,log:path.join(directory,'runner.log'),phase:'baseline'});baselineExit=exit;
    if(exit.code!==0 || exit.signal || exit.error)throw Error('Windows runner failed; retain the complete log before cleanup');
    tap=validateWindowsTap(regular(path.join(directory,'vm-out/leg-b.log')).toString(),job.expectedCases);
    if(!tap.valid)throw Error(tap.reasons.join('; '));
    baselineDigest=digest(regular(path.join(directory,'vm-out/leg-b.log')));
    checked=verifyInputs(job);if(!checked.valid)throw Error(checked.reasons.join('; '));
    if(job.preparation) {
      preparationResult=JSON.parse(regular(path.join(directory,'preparation.json')));
      if(preparationResult.valid!==true || preparationResult.exitCode!==0 || preparationResult.runId!==job.id || preparationResult.id!==job.preparation.id || preparationResult.manifestDigest!==job.preparation.manifestDigest)throw Error('Required native preparation was not proved');
    }
    if(job.application) {
      const output=path.join(directory,'application-out');fs.mkdirSync(output,{mode:0o700});
      const applicationEnv={...phaseEnvironment(job,'application',env),WINDOWS_APPLICATION_DIR:job.application.root};
      const applicationExit=await execute({program:path.join(job.control,'node'),args:[path.join(job.application.root,job.application.entry)],cwd:job.application.root,environment:applicationEnv,log:path.join(directory,'application.log'),phase:'application'});
      applicationResult={id:job.application.id,executed:true,exitCode:applicationExit.code,signal:applicationExit.signal,error:applicationExit.error,child:applicationExit.identity,output,acceptanceClaim:false};
      if(applicationExit.code!==0 || applicationExit.signal || applicationExit.error)throw Error('Required application phase failed; retain its complete log and receipts');
      checked=verifyInputs(job);if(!checked.valid)throw Error(checked.reasons.join('; '));
      if(digest(regular(path.join(directory,'vm-out/leg-b.log')))!==baselineDigest)throw Error('Application phase changed the baseline evidence');
    }
  }catch(error){failure=error.message;}
  finally {
    status('cleaning',{started,owner,child:childIdentity,error:failure});
    if(fs.existsSync(resources)) {
      if(fs.existsSync(path.join(directory,'transport/bootstrap.json'))) {
        const result=call([transport,'cleanup']);teardown.push({phase:'transport',code:result.code});
        fs.appendFileSync(path.join(directory,'cleanup.log'),result.output,{mode:0o600});
        if(result.code!==0)failure ||= 'Owned transport cleanup failed';
      }
      const result=call([manager,'down']);teardown.push({phase:'host',code:result.code});
      fs.appendFileSync(path.join(directory,'cleanup.log'),result.output,{mode:0o600});
      if(result.code!==0)failure ||= 'Owned host cleanup failed; recovery record retained';
      else {
        let receipt;try{receipt=JSON.parse(result.stdout);}catch{}
        if(receipt?.status!=='deleted' || receipt?.runId!==job.id || allocation && receipt?.resourceId!==allocation.resourceId)failure ||= 'Host deletion was not confirmed by its owned receipt';
      }
    }
    else if(allocation)failure ||= 'Allocated resource record disappeared before cleanup';
  }
  const result={version:1,id:job.id,started,finished:new Date().toISOString(),valid:!failure && !!tap?.valid,error:failure,
    requestedPhases:[...(job.preparation?[job.preparation.id]:[]),'b',...(job.application?[job.application.id]:[])],expectedCases:job.expectedCases,tap,baselineDigest,baselineExit,preparation:preparationResult,application:applicationResult,allocation,owner,child:childIdentity,teardown,
    artifactOrigin:{head:job.artifacts.head,tree:job.artifacts.tree,version:job.artifacts.versionTag,build:job.artifacts.build},
    sourceOrigins:job.manifest.origins,completeReleaseEvidence:false,
    scope:'Complete patch Windows baseline and optional pinned application process execution. Application acceptance receipts, Linux acceptance, integration and publication require separate review.'};
  atomicJSON(path.join(directory,'result.json'),result);status(result.valid?'passed':'failed',{started,owner,finished:result.finished,error:failure});return result;
}
