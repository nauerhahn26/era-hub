#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDirectory,jobPath,readJSON,queueGate,readStatus,allStatuses,internal,inspectRuntime,runPreflight,runReversePreflight,estimateQueue } from './testing/parallel-worker.mjs';
const args=process.argv.slice(2),command=args.shift() || 'help';
const print=value=>console.log(JSON.stringify(value,null,2));
function option(name) {const at=args.indexOf(name);return at<0?undefined:args[at+1];}
try {
  if(command==='help' || command==='--help') console.log('Usage: node /absolute/path/tools/parallel-gate.mjs inspect [--preflight]\n  queue --hub <clean owning worktree> [--suffix <worktree suffix>] [--seed <owned test-data>]\n  status [job-id]\n  log <job-id> [--lines 40]\nOne isolated full gate plus one reserved legacy lane. Candidate gate scripts are never changed. Full pilot validation is required before claiming availability.');
  else if(command.startsWith('_')) print(await internal(command,args[0]));
  else if(command==='inspect') {
    const state=stateDirectory();
    const runtime=inspectRuntime(),capacity=await import('./testing/parallel-capacity.mjs');
    const resources=await capacity.readHostResources({diskPath:state});
    const statuses=await allStatuses(state);
    const result={version:1,capacity:await capacity.inspectCapacity(resources),lease:await capacity.readLease({leaseDir:path.join(state,'parallel-capacity')}),runtime,jobs:statuses,fullPilotValidated:statuses.some(job=>job.status==='passed'),eta:estimateQueue(statuses.map(job=>({status:job.status,gateSeconds:job.result?.gateSeconds})),statuses.filter(job=>['queued','waiting','preparing','running'].includes(job.status)).length)};
    if(args.includes('--preflight')) {
      result.preflight=runPreflight(path.join(state,'preflight',crypto.randomBytes(8).toString('hex')));
      result.reversePreflight=runReversePreflight(path.join(state,'preflight',crypto.randomBytes(8).toString('hex')));
    }
    print(result);
  } else if(command==='queue') {
    const hub=option('--hub');if(!hub) throw Error('queue requires the consenting candidate --hub path');
    print(await queueGate({hub,suffix:option('--suffix'),seedDir:option('--seed')}));
  } else if(command==='status') print(args[0]?await readStatus(jobPath(args[0],stateDirectory())):await allStatuses());
  else if(command==='log') {
    const directory=jobPath(args[0],stateDirectory()),file=path.join(directory,fs.existsSync(path.join(directory,'gate.log'))?'gate.log':'worker.log');
    const lines=Number(option('--lines') || 40);if(!Number.isInteger(lines) || lines<1 || lines>10000) throw Error('lines must be a whole number from1 to10000');
    console.log(fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').slice(-lines).join('\n'):'Worker has not written a log yet.');
  } else throw Error('Unknown parallel-gate command');
} catch(error) {console.error('parallel-gate: '+error.message);process.exitCode=1;}
