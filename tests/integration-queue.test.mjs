// The explicit transaction reserves integration; ordinary test jobs never merge.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const wrapper=fileURLToPath(new URL('../tools/testing/verify-and-land.sh',import.meta.url));
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'era-integration-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const main=path.join(root,'era-hub'), bin=path.join(root,'bin'), helper=path.join(root,'worktree.sh');
  fs.mkdirSync(path.join(main,'tools'),{recursive:true}); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'tmux'),'#!/bin/sh\nexit 99\n',{mode:0o755});
  const realFlock=execFileSync('which',['flock'],{encoding:'utf8'}).trim();
  fs.writeFileSync(path.join(bin,'flock'),`#!/bin/bash\nif [ "$#" = 1 ] && [[ "$1" =~ ^[0-9]+$ ]]; then exec "${realFlock}" -w 3 "$1"; fi\nexec "${realFlock}" "$@"\n`,{mode:0o755});
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,GIT_CONFIG_GLOBAL:path.join(root,'gitconfig'),GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Test Maintainer',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test Maintainer',GIT_COMMITTER_EMAIL:'test@example.invalid',ERA_GATE_LOCK:path.join(root,'gate.lock'),ERA_LAND_LOCK:path.join(root,'land.lock'),ERA_GATE_STAMPS:path.join(root,'stamps'),ERA_WORKTREE_TOOL:helper,EVENT_LOG:path.join(root,'events.log')};
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL,''); fs.mkdirSync(env.ERA_GATE_STAMPS);
  git(main,'init','-b','master'); git(main,'config','user.name','Test Maintainer'); git(main,'config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(main,'base.txt'),'base\n');
  fs.writeFileSync(path.join(main,'tools/era-gate.sh'),`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = --capabilities ]; then echo '{"inheritedGateLock":1,"customGateLock":1}'; exit; fi
[ "\${ERA_GATE_MODE:-}" = full ] && [ "\${ERA_GATE_LOCK_FD:-}" = 7 ]
[ -z "\${ERA_WT_SUFFIX:-}" ]
[ -z "\${ERA_GATE_SELECTED+x}" ] && [ -z "\${ERA_GATE_INPUTS+x}" ] && [ -z "\${ERA_GATE_CANCEL_FILE+x}" ] && [ -z "\${ERA_GATE_JOB_DIR+x}" ]
[ "$(stat -Lc '%d:%i' "/proc/$$/fd/7")" = "$(stat -Lc '%d:%i' "$ERA_GATE_LOCK")" ]
flock -n 7
slug="\${PWD##*--wt-}"
printf 'gate:%s:%s\\n' "$slug" "$(git ls-files '*.feature' | sort | tr '\\n' ',')" >>"$EVENT_LOG"
[ "\${FAIL_GATE:-}" != "$slug" ] || exit 9
[ "\${SLOW_GATE:-}" != "$slug" ] || sleep 0.3
[ "\${NO_STAMP:-}" != "$slug" ] || exit 0
mkdir -p "$ERA_GATE_STAMPS"
{ echo '== era-gate: 1 passed, 0 failed =='; echo "head=$(git rev-parse HEAD)"; echo "at=$(date +%s)"; } >"$ERA_GATE_STAMPS/$(git rev-parse 'HEAD^{tree}')"
`);
  fs.writeFileSync(helper,`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = capabilities ]; then echo '{"inheritedLandLock":1,"landChecksUnderLock":1}'; exit; fi
cmd="$1"; main="$2"; slug="$3"; wt="$main--wt-$slug"
printf '%s:%s\\n' "$cmd" "$slug" >>"$EVENT_LOG"
case "$cmd" in
 sync) git -C "$wt" merge --no-edit master ;;
 land)
   [ "\${ERA_LAND_LOCK_FD:-}" = 8 ]
   [ "$(stat -Lc '%d:%i' "/proc/$$/fd/8")" = "$(stat -Lc '%d:%i' "$ERA_LAND_LOCK")" ]
   flock -n 8
   branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD)"
   git -C "$main" merge-base --is-ancestor master "$branch"
   git -C "$main" merge --no-ff --no-edit "$branch" ;;
 *) exit 90 ;;
esac
`);
  git(main,'add','.'); git(main,'commit','-m','initial');
  const feature=slug=>{
    const wt=main+'--wt-'+slug;
    git(main,'worktree','add','-b','feat/'+slug,wt,'master');
    fs.writeFileSync(path.join(wt,slug+'.feature'),slug+'\n'); git(wt,'add','.'); git(wt,'commit','-m',slug);
    return wt;
  };
  const run=(slug,extra={})=>spawnSync('bash',[wrapper,main,slug],{env:{...env,...extra},encoding:'utf8',timeout:8000});
  const events=()=>fs.existsSync(env.EVENT_LOG)?fs.readFileSync(env.EVENT_LOG,'utf8').trim().split('\n'):[];
  return {root,main,helper,env,feature,run,events};
}
function launch(f,slug,extra={}) {
  const child=spawn('bash',[wrapper,f.main,slug],{env:{...f.env,...extra},stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',d=>{output+=d;}); child.stderr.on('data',d=>{output+=d;});
  return {child,done:new Promise(resolve=>child.on('close',code=>resolve({code,get output(){return output;}})))};
}
async function until(predicate) {
  const limit=Date.now()+4000;
  while(!predicate()) { if(Date.now()>limit) throw new Error('Synthetic transaction did not reach its expected state'); await new Promise(r=>setTimeout(r,10)); }
}

test('old helper capability is refused before locks, sync or source changes', t=>{
  const f=fixture(t), wt=f.feature('a'), before=git(wt,'rev-parse','HEAD');
  fs.writeFileSync(f.helper,"#!/bin/sh\necho '{}'\n");
  const r=f.run('a'); assert.notEqual(r.status,0); assert.match(r.stderr,/capabilit|helper/i);
  assert.equal(git(wt,'rev-parse','HEAD'),before); assert.deepEqual(f.events(),[]);
  assert.equal(fs.existsSync(f.env.ERA_GATE_LOCK),false);
});

test('explicit transaction forces a new complete gate and lands its exact candidate', t=>{
  const f=fixture(t), wt=f.feature('a');
  const r=f.run('a',{ERA_GATE_MODE:'affected',ERA_GATE_SELECTED:'/unused',ERA_GATE_INPUTS:'/unused',ERA_GATE_CANCEL_FILE:'/unused',ERA_GATE_JOB_DIR:'/unused'});
  assert.equal(r.status,0,r.stderr || r.stdout);
  assert.deepEqual(f.events(),['sync:a','gate:a:a.feature,','land:a']);
  assert.equal(git(f.main,'merge-base','--is-ancestor',git(wt,'rev-parse','HEAD'),'master'),'');
});

test('failed verification and missing complete stamp never land', t=>{
  for(const mode of ['FAIL_GATE','NO_STAMP']) {
    const f=fixture(t); f.feature('a'); const before=git(f.main,'rev-parse','HEAD');
    const r=f.run('a',{[mode]:'a'});
    assert.notEqual(r.status,0); assert.equal(git(f.main,'rev-parse','HEAD'),before);
    assert.ok(f.events().some(e=>e.startsWith('gate:a:')),'the negative result comes from the invoked gate');
    assert.equal(f.events().some(e=>e==='land:a'),false);
  }
});

test('feature dirt and unlanded matching siblings are refused without synchronization', t=>{
  const f=fixture(t), wt=f.feature('a');
  fs.writeFileSync(path.join(wt,'uncommitted.txt'),'keep\n');
  assert.notEqual(f.run('a').status,0); assert.deepEqual(f.events(),[]);
  fs.unlinkSync(path.join(wt,'uncommitted.txt'));
  const sibling=path.join(f.root,'era-core'); fs.mkdirSync(sibling);
  git(sibling,'init','-b','master'); git(sibling,'config','user.name','Test Maintainer'); git(sibling,'config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(sibling,'base.txt'),'base\n'); git(sibling,'add','.'); git(sibling,'commit','-m','initial');
  const paired=sibling+'--wt-a'; git(sibling,'worktree','add','-b','feat/a',paired,'master');
  fs.writeFileSync(path.join(paired,'new.txt'),'pending dependency\n');
  assert.notEqual(f.run('a').status,0); assert.deepEqual(f.events(),[]);
  git(paired,'add','.'); git(paired,'commit','-m','pending dependency');
  const r=f.run('a'); assert.notEqual(r.status,0); assert.match(r.stderr,/paired|sibling|dependency/i); assert.deepEqual(f.events(),[]);
});

test('a real-style gate cannot opt out of the canonical machine gate lock', t=>{
  const f=fixture(t), wt=f.feature('a'), file=path.join(wt,'tools/era-gate.sh');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(',"customGateLock":1',''));
  git(wt,'add','.'); git(wt,'commit','-m','canonical gate contract');
  const r=f.run('a'); assert.notEqual(r.status,0); assert.match(r.stderr,/canonical|custom.*lock/i); assert.deepEqual(f.events(),[]);
});

test('two transactions verify and land cumulative candidates in reservation order', async t=>{
  const f=fixture(t), first=f.feature('a'), second=f.feature('b');
  const a=launch(f,'a',{SLOW_GATE:'a'});
  await until(()=>f.events().some(e=>e.startsWith('gate:a:')));
  const b=launch(f,'b');
  const [ra,rb]=await Promise.all([a.done,b.done]);
  assert.equal(ra.code,0,ra.output); assert.equal(rb.code,0,rb.output);
  assert.deepEqual(f.events(),['sync:a','gate:a:a.feature,','land:a','sync:b','gate:b:a.feature,b.feature,','land:b']);
  assert.equal(fs.existsSync(path.join(f.main,'a.feature')),true); assert.equal(fs.existsSync(path.join(f.main,'b.feature')),true);
  assert.equal(git(second,'merge-base','--is-ancestor',git(first,'rev-parse','HEAD'),'HEAD'),'');
});
