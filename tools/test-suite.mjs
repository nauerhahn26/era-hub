#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadRegistry, resolveRoots, checkInventory, planChanges, captureInputs,
  verifyInputs, atomicJSON, enqueueJob, runJob, listJobs, readJob,
  requestCancellation, defaultJobsDir,
  previousFailuresFor,
} from './testing/suite-runner.mjs';

const hub=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2), command=args.shift() || 'help';
function option(name,fallback) { const at=args.indexOf(name); return at<0?fallback:args[at+1]; }
const json=args.includes('--json');
const print=value=>console.log(JSON.stringify(value,null,2));
try {
  if(command==='help' || command==='--help') {
    console.log('Usage: node tools/test-suite.mjs check|list|plan|queue|status|cancel\n  plan [--base master] [--json]\n  queue [--affected] [--base master]  (complete gate by default)\n  status [job-id] [--json]\n  cancel <job-id>  (queued requests only; never kills processes)\n  list [--json]\nDevelopment selections never write complete green stamps. Existing gates remain serialized.');
  } else if(command==='capture-inputs') {
    const file=args[0]; if(!file || !path.isAbsolute(file)) throw new Error('capture-inputs needs an absolute output path');
    const inputs=captureInputs(resolveRoots(hub)); atomicJSON(file,inputs); print({hash:inputs.hash});
  } else if(command==='verify-inputs') {
    const file=args[0]; if(!file || !path.isAbsolute(file)) throw new Error('verify-inputs needs an absolute manifest path');
    const result=verifyInputs(JSON.parse(fs.readFileSync(file,'utf8')),resolveRoots(hub));
    if(!result.valid) throw new Error(`Gate inputs are stale: ${result.changes.join('; ')}`);
    if(!result.integrationFresh && option('--phase','queued')!=='running') throw new Error(`Gate integration base changed before execution: ${result.integrationChanges.join('; ')}`);
    print(result);
  } else if(command==='_worker') {
    if(!args[0]) throw new Error('Missing job directory'); await runJob(args[0]);
  } else if(command==='status') {
    const jobs=args[0] && !args[0].startsWith('--')?[readJob(path.join(defaultJobsDir(),path.basename(args[0])))]:listJobs();
    if(json) print(jobs);
    else if(!jobs.length) console.log('No queued or completed test jobs.');
    else for(const job of jobs) {
      console.log(`${job.id}  ${job.status}  ${job.mode || '?'}  ${job.completedSuites || 0} finished  ${job.activeSuite || ''}\n  ${path.join(job.directory,'gate.log')}`);
      const cause=job.changes || job.outcome?.changes;
      if(cause?.length) console.log(`  ${cause.slice(0,5).join('; ')}${cause.length>5?`; ${cause.length-5} more changes`:''}`);
      else if(job.outcome?.integrationStale) console.log(`  Tested candidate passed; integration needs refresh: ${job.outcome.integrationChanges.join('; ')}`);
      else if(job.outcome?.error) console.log(`  ${job.outcome.error}`);
    }
  } else if(command==='cancel') {
    if(!args[0] || path.basename(args[0])!==args[0]) throw new Error('cancel needs a job ID');
    print(requestCancellation(path.join(defaultJobsDir(),args[0])));
  } else {
    const registry=loadRegistry(), roots=resolveRoots(hub), baseline=option('--base','master');
    if(command==='check') print({valid:true,suites:checkInventory(roots,registry).length,roots});
    else if(command==='list') {
      const suites=checkInventory(roots,registry); if(json) print(suites); else for(const suite of suites) console.log(`${suite.id}  [${suite.group}; ${suite.lane}] ${suite.purpose}`);
    } else if(command==='plan') {
      const plan=planChanges({roots,registry,baseline,previousFailures:previousFailuresFor(roots)});
      if(json) print(plan); else {
        console.log(`${plan.mode.toUpperCase()}: ${plan.selected.length} selected; ${plan.omitted.length} omitted; baseline ${baseline}`);
        for(const reason of plan.fallback) console.log(`FULL: ${reason}`);
        for(const suite of plan.selected) console.log(`${suite.id}\n  ${suite.reasons.join('; ')}`);
        console.log(plan.note);
      }
    } else if(command==='queue') print(enqueueJob({hub,roots,registry,baseline,mode:args.includes('--affected')?'affected':'full'}));
    else throw new Error(`Unknown command: ${command}`);
  }
} catch(error) { console.error(`test-suite: ${error.message}`); process.exitCode=1; }
