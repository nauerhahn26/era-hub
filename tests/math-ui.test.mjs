// Real shared dwell/speech, an ephemeral static fixture, and no running hub.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { CONTRACT } from '../public/lib/contract.js';

const HUB=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PUBLIC=path.join(HUB,'public');
const sibling=path.resolve(HUB,'..','era-core'+(process.env.ERA_WT_SUFFIX||''));
const CORE=fs.existsSync(sibling)?sibling:path.resolve(HUB,'..','era-core');
const SHOTS=process.env.ERA_SHOTS;
const SETTINGS={dwellMs:900,pauseGoes:'tdsnap',childName:'Ellie'};
let server,browser,base;

before(async()=>{
  assert.ok(fs.existsSync(path.join(PUBLIC,'math','index.html')),'the math page must exist');
  server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://fixture.invalid').pathname;
    if(pathname==='/settings'||pathname==='/voices'||pathname.startsWith('/kiosk/')) {
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify(pathname==='/settings'?SETTINGS:pathname==='/voices'?{enabled:false,voices:[]}:{action:pathname.endsWith('pause')?'paused':'closed'})); return;
    }
    if(pathname==='/log'){res.writeHead(204);res.end();return;}
    if(pathname==='/tts'){res.writeHead(503);res.end();return;}
    let target=path.resolve(PUBLIC,'.'+decodeURIComponent(pathname));
    if(!target.startsWith(PUBLIC+path.sep)){res.writeHead(403);res.end();return;}
    if(fs.existsSync(target)&&fs.statSync(target).isDirectory())target=path.join(target,'index.html');
    // An unassembled worktree has no top-level shared scripts. A gate/payload does.
    if(!fs.existsSync(target)&&['/dwell.js','/speech.js'].includes(pathname))target=path.join(CORE,path.basename(pathname));
    try {
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
      res.setHeader('Content-Type',types[path.extname(target)]||'application/octet-stream');
      res.end(fs.readFileSync(target));
    } catch {res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch();
});
after(async()=>{
  if(browser)await browser.close();
  if(server)await new Promise(resolve=>server.close(resolve));
});

async function open({width=1920,height=1080,hooks=true}={}) {
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,hasTouch:true,reducedMotion:'reduce'});
  await context.addInitScript(({hooks})=>{
    window.__testHooks=hooks;
    // Exercise the actual dwell validity gate without a connection to a tracker.
    window.__gazeValidity=1;
    window.__gazeSockets=[];
    window.WebSocket=class {
      constructor(){this.readyState=1;window.__gazeSockets.push(this);setTimeout(()=>this.onopen?.({}),0);}
      send(){}
      close(){this.readyState=3;this.onclose?.({});}
      addEventListener(type,handler){this['on'+type]=handler;}
    };
    window.__gazeSample=validity=>{
      window.__gazeValidity=validity;
      for(const socket of window.__gazeSockets)socket.onmessage?.({data:JSON.stringify({gazePoint:{x:.5,y:.5},validity})});
    };
    setInterval(()=>window.__gazeSample(window.__gazeValidity),80);
  },{hooks});
  const requests=[],errors=[];
  await context.route('**/*',route=>{
    if(route.request().url().startsWith(base+'/'))return route.continue();
    requests.push(route.request().url());return route.abort();
  });
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/math/');
  await page.waitForFunction(()=>window.MathApp?.state().ready,{},{timeout:5000});
  return {context,page,errors,external:requests};
}
const state=page=>page.evaluate(()=>window.MathApp.state());
const action=(page,name,arg)=>page.evaluate(([name,arg])=>window.MathApp.action(name,arg),[name,arg]);
const control=(page,name)=>page.locator(`[data-action="${name}"]`);
async function choose(page,n) {
  await control(page,'pick').click();
  await control(page,'ranges').click();
  await page.locator(`[data-range="${Math.floor(n/10)*10}"]`).click();
  await page.locator(`[data-number="${n}"]`).click();
}
async function settle(page) {await page.waitForFunction(()=>!window.Dwell.state().suppressedMs);}
async function look(page,name) {
  await settle(page);
  await page.mouse.move(1,1070);
  const b=await control(page,name).boundingBox();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:3});
}
const inventory=page=>page.locator('.math-counter').count();
const quantities=s=>({view:s.view,number:s.number,whole:s.whole,left:s.left});

test('menu has the two available explorations; touch changes quantities and counters remain passive',async()=>{
  const {context,page,errors,external}=await open();
  try {
    assert.equal((await state(page)).view,'menu');
    assert.ok(await control(page,'numbers').isVisible());
    assert.ok(await control(page,'partners').isVisible());
    assert.equal(await control(page,'stories').count(),0);
    await control(page,'numbers').tap();
    assert.equal((await state(page)).number,7);
    await control(page,'more').tap();
    assert.equal((await state(page)).number,8);
    await control(page,'fewer').tap();
    assert.equal(await inventory(page),7);
    const passive=await page.locator('.math-counter').evaluateAll(nodes=>nodes.every(n=>!n.closest('button,a,.dwell,[data-action]')&&
      ![...n.attributes].some(a=>a.name.startsWith('data-dwell'))));
    assert.equal(passive,true);
    await page.locator('.math-counter').first().tap();
    assert.equal((await state(page)).number,7);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    assert.doesNotMatch(await page.locator('body').innerText(),/score|points|wrong|try again|unlock/i);
  } finally {await context.close();}
});

test('quantity changes preserve the actual command nodes, locations and boundary seats',async()=>{
  const {context,page}=await open();
  try {
    await control(page,'numbers').click();
    await choose(page,49);
    await page.evaluate(()=>{window.__mathRefs=[...document.querySelectorAll('[data-action]')].map(node=>({node,action:node.dataset.action,rect:node.getBoundingClientRect().toJSON()}));});
    await control(page,'more').click();
    assert.equal(await inventory(page),50);
    assert.equal((await state(page)).number,50);
    assert.equal(await control(page,'more').isDisabled(),true);
    assert.equal(await page.evaluate(()=>window.__mathRefs.every(({node,action,rect})=>{
      const current=document.querySelector(`[data-action="${action}"]`);const box=node.getBoundingClientRect();
      return current===node&&node.isConnected&&Math.abs(box.x-rect.x)<1&&Math.abs(box.y-rect.y)<1&&Math.abs(box.width-rect.width)<1&&Math.abs(box.height-rect.height)<1;
    })),true,'no replacement that could defeat dwell move-to-rearm');
    await choose(page,0);
    assert.equal(await inventory(page),0);
    assert.equal(await control(page,'fewer').isDisabled(),true);
    await control(page,'more').click();assert.equal(await inventory(page),1);
  } finally {await context.close();}
});

test('partners has one inventory, transfers one object, includes zero parts and cancels browsing without repartitioning',async()=>{
  const {context,page}=await open();
  try {
    await control(page,'partners').click();
    await control(page,'move-left').click();
    assert.deepEqual((s=>[s.whole,s.left])(await state(page)),[7,4]);
    assert.equal(await inventory(page),7,'there is no duplicate whole collection');
    await control(page,'pick').click();await control(page,'ranges').click();
    assert.deepEqual(await page.locator('[data-range]').evaluateAll(els=>els.map(e=>Number(e.dataset.range))),[0,10]);
    await control(page,'back').click();await control(page,'back').click();
    assert.deepEqual((s=>[s.view,s.whole,s.left])(await state(page)),['partners',7,4]);
    for(let i=0;i<4;i++)await control(page,'move-right').click();
    assert.equal((await state(page)).left,0);
    assert.equal(await control(page,'move-right').isDisabled(),true);
    assert.equal(await inventory(page),7);
    for(let i=0;i<7;i++)await control(page,'move-left').click();
    assert.equal((await state(page)).left,7);
    assert.equal(await control(page,'move-left').isDisabled(),true);
    await choose(page,0);assert.equal(await inventory(page),0);
    assert.equal(await control(page,'move-left').isDisabled(),true);
    assert.equal(await control(page,'move-right').isDisabled(),true);
  } finally {await context.close();}
});

test('ten full numeral seats retain their positions across ranges, Back stays anchored, selection returns to caller',async()=>{
  const {context,page}=await open();
  try {
    await control(page,'numbers').click();
    const back=await control(page,'back').boundingBox();
    await control(page,'pick').click();
    const pickerBack=await control(page,'back').boundingBox();
    assert.ok(Math.abs(back.x-pickerBack.x)<1&&Math.abs(back.y-pickerBack.y)<1);
    const seats=await page.locator('[data-number]').evaluateAll(els=>els.map(e=>({n:Number(e.dataset.number),x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y})));
    assert.deepEqual(seats.map(s=>s.n),[0,1,2,3,4,5,6,7,8,9]);
    await control(page,'ranges').click();await page.locator('[data-range="10"]').click();
    const next=await page.locator('[data-number]').evaluateAll(els=>els.map(e=>({n:Number(e.dataset.number),x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y})));
    assert.deepEqual(next.map(s=>s.n),[10,11,12,13,14,15,16,17,18,19]);
    for(let i=0;i<10;i++)assert.deepEqual([next[i].x,next[i].y],[seats[i].x,seats[i].y]);
    await page.locator('[data-number="14"]').tap();
    assert.deepEqual((s=>[s.view,s.number])(await state(page)),['numbers',14]);
    assert.equal(await inventory(page),14);
  } finally {await context.close();}
});

test('reload and Talk preserve both workspaces and an unfinished partition',async()=>{
  const {context,page}=await open();
  try {
    await control(page,'numbers').click();await choose(page,23);await control(page,'back').click();
    await control(page,'partners').click();await control(page,'move-left').click();
    const expected=quantities(await state(page));
    const pause=page.waitForRequest(r=>new URL(r.url()).pathname==='/kiosk/pause');
    await page.locator('#barTalk').tap();await pause;
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    assert.deepEqual(quantities(await state(page)),expected);
    await page.reload();await page.waitForFunction(()=>window.MathApp?.state().ready);
    assert.deepEqual(quantities(await state(page)),expected);
    assert.equal(await inventory(page),7);
    await control(page,'back').click();await control(page,'numbers').click();
    assert.equal((await state(page)).number,23);
    assert.equal(await inventory(page),23);
  } finally {await context.close();}
});

test('Talk freezes all math input until resume and never restarts an interrupted Count',async()=>{
  const {context,page}=await open();
  let releasePause;
  const heldPause=new Promise(resolve=>{releasePause=resolve;});
  try {
    await context.route('**/kiosk/pause',async route=>{await heldPause;await route.fulfill({status:200,contentType:'application/json',body:'{"action":"paused"}'});});
    await control(page,'partners').click();
    await control(page,'move-left').click();
    await control(page,'count').click();
    await page.waitForFunction(()=>window.MathApp.state().counting);
    const expected=quantities(await state(page));
    const requested=page.waitForRequest(r=>new URL(r.url()).pathname==='/kiosk/pause');
    const paused=page.waitForResponse(r=>new URL(r.url()).pathname==='/kiosk/pause');
    await page.locator('#barTalk').tap();await requested;
    assert.equal((await state(page)).counting,false);
    // A background window can still receive an input event; the action boundary must guard it.
    await control(page,'move-left').click();
    assert.deepEqual(quantities(await state(page)),expected,'touch cannot mutate a paused exploration');
    await action(page,'move-right');
    assert.deepEqual(quantities(await state(page)),expected,'the action boundary also guards queued commands');
    await look(page,'move-left');
    await page.waitForTimeout(1100);
    assert.deepEqual(quantities(await state(page)),expected,'background gaze cannot mutate a paused exploration');
    releasePause();await paused;
    const suppressed=await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));return window.Dwell.state().suppressedMs;});
    assert.ok(suppressed>=500,'the shared return window is not shortened by the page visibility handler');
    await settle(page);
    assert.equal((await state(page)).counting,false,'returning does not restart a model');
    await control(page,'move-left').click();
    assert.equal((await state(page)).left,expected.left+1,'normal input works after return');
  } finally {releasePause();await context.close();}
});

test('missing voice does not lock counting or ordinary actions behind audio',async()=>{
  const {context,page,errors}=await open();
  try {
    await control(page,'numbers').click();
    await page.evaluate(()=>{window.Speech.say=()=>Promise.reject(new Error('Voice unavailable'));window.Speech.mode=()=> 'off';});
    await control(page,'count').tap();
    await page.waitForFunction(()=>window.MathApp.state().counting);
    await control(page,'more').tap();
    assert.equal((await state(page)).number,8);
    assert.equal((await state(page)).counting,false);
    await page.waitForTimeout(550);
    assert.equal(await inventory(page),8);
    assert.deepEqual(errors,[]);
  } finally {await context.close();}
});

test('Exit remains gaze accessible while a visible Talk handoff is stalled',async()=>{
  const {context,page}=await open();
  let releasePause;
  const heldPause=new Promise(resolve=>{releasePause=resolve;});
  try {
    await context.route('**/kiosk/pause',async route=>{
      await heldPause;
      await route.fulfill({status:200,contentType:'application/json',body:'{"action":"paused"}'}).catch(()=>{});
    });
    await control(page,'partners').click();
    const expected=quantities(await state(page));
    const requested=page.waitForRequest(r=>new URL(r.url()).pathname==='/kiosk/pause');
    await page.locator('#barTalk').tap();await requested;
    await control(page,'move-left').click();
    assert.deepEqual(quantities(await state(page)),expected,'math stays blocked during the stalled handoff');
    await settle(page);
    const exit=await page.locator('#barDoor').boundingBox();
    await page.mouse.move(1,1070);
    let exitRequested=false;
    const leaving=page.waitForRequest(r=>new URL(r.url()).pathname==='/kiosk/exit',{timeout:3500}).then(request=>{exitRequested=true;return request;});
    await page.mouse.move(exit.x+exit.width/2,exit.y+exit.height/2,{steps:3});
    await page.waitForTimeout(SETTINGS.dwellMs+150);
    assert.equal(exitRequested,false,'Exit still requires the doubled door hold');
    await leaving;
    assert.deepEqual(quantities(await state(page)),expected,'the Exit door does not change the mathematics');
    assert.equal((await state(page)).counting,false);
  } finally {releasePause();await context.close();}
});

test('Count reads the existing inventory once and another action cancels highlights and queued speech',async()=>{
  const {context,page,errors}=await open();
  try {
    await control(page,'numbers').click();await choose(page,50);
    await control(page,'count').click();
    await page.waitForFunction(()=>window.MathApp.state().counting&&window.MathApp.state().countIndex>=0);
    assert.equal(await inventory(page),50);
    // Queue a long utterance behind a letter echo in the REAL shared speech engine.
    await page.evaluate(()=>{
      window.Speech.say('Hold this letter echo while an action interrupts it','letter');
      window.Speech.say('stale math narration','long');
    });
    await control(page,'fewer').tap();
    assert.equal((await state(page)).number,49);
    assert.equal((await state(page)).counting,false);
    assert.equal((await state(page)).countIndex,-1);
    const length=await page.evaluate(()=>window.__speechEngineLog.length);
    await page.waitForTimeout(650);
    assert.equal((await state(page)).counting,false);
    assert.equal(await inventory(page),49);
    const events=await page.evaluate(()=>window.__speechEngineLog);
    assert.ok(events.some(e=>e.ev==='stop'));
    assert.equal(events.some(e=>e.ev==='start'&&e.text==='stale math narration'),false,'queued old narration never starts');
    assert.equal(events.slice(length).some(e=>e.ev==='say'),false,'the cancelled count schedules no later utterances');
    assert.deepEqual(errors,[]);
  } finally {await context.close();}
});

test('partners Count traverses one continuous inventory and leaves the partition unchanged',async()=>{
  const {context,page}=await open();
  try {
    await control(page,'partners').click();
    const before=quantities(await state(page));
    await page.evaluate(()=>{window.__speechEngineLog.length=0;window.__countSeen=[];const timer=setInterval(()=>{
      const s=window.MathApp.state();if(s.counting&&s.countIndex>=0&&!window.__countSeen.includes(s.countIndex))window.__countSeen.push(s.countIndex);
    },5);window.__countObserverTimer=timer;});
    await control(page,'count').click();
    await page.waitForFunction(()=>window.MathApp.state().counting);
    await page.waitForFunction(()=>!window.MathApp.state().counting,{},{timeout:8000});
    assert.deepEqual(quantities(await state(page)),before);
    assert.deepEqual(await page.evaluate(()=>window.__countSeen),[0,1,2,3,4,5,6]);
    const spoken=await page.evaluate(()=>window.__speechEngineLog.filter(e=>e.ev==='say').map(e=>e.text));
    assert.deepEqual(spoken.slice(0,7),['one','two','three','four','five','six','seven'],'spoken counting continues across both parts');
    assert.match(spoken.at(-1),/seven.*altogether/i);
    assert.equal(await inventory(page),7);
  } finally {await context.close();}
});

test('settings determine ordinary dwell and only the two shared doors hold twice that duration',async()=>{
  const {context,page}=await open();
  try {
    await control(page,'numbers').click();
    const holds=await page.evaluate(()=>({ms:window.Dwell.config.ms,config:window.Dwell.config,
      controls:[...document.querySelectorAll('button.dwell')].map(e=>({id:e.id,action:e.dataset.action,hold:Number(e.dataset.dwellMs)||window.Dwell.config.ms}))}));
    assert.equal(holds.ms,SETTINGS.dwellMs);
    for(const c of holds.controls)assert.equal(c.hold,['barDoor','barTalk'].includes(c.id)?1800:900,c.id||c.action);
    assert.equal(holds.config.audioPreview,false);assert.equal(holds.config.chime,false);
    const bar=await page.locator('.msgbar').boundingBox(),talk=await page.locator('#barTalk').boundingBox(),exit=await page.locator('#barDoor').boundingBox();
    assert.ok(bar.height<=Math.min(124,Math.round(1080*.09)));
    assert.ok(Math.abs(talk.x+talk.width/2-960)<1,'Talk is centered on the bar');
    assert.ok(exit.x<30,'Exit stays at the top-left');
  } finally {await context.close();}
});

test('one stationary dwell changes one unit; leaving the activation spot permits the next action',async()=>{
  const {context,page}=await open();
  try {
    await control(page,'numbers').click();await look(page,'more');
    await page.waitForFunction(()=>window.MathApp.state().number===8,{},{timeout:2500});
    await page.waitForTimeout(1350);
    assert.equal((await state(page)).number,8,'stationary gaze must not repeat after repaint');
    await look(page,'more');
    await page.waitForFunction(()=>window.MathApp.state().number===9,{},{timeout:2500});
    assert.equal(await inventory(page),9);
  } finally {await context.close();}
});

test('tracking loss freezes a partial dwell and cannot complete a selection',async()=>{
  const {context,page}=await open();
  try {
    await control(page,'numbers').click();await look(page,'more');
    await page.waitForFunction(()=>window.Dwell.state().progress>.12);
    await page.evaluate(()=>window.__gazeSample(0));
    const progress=await page.evaluate(()=>window.Dwell.state().progress);
    await page.waitForTimeout(1100);
    assert.equal((await state(page)).number,7);
    const frozen=await page.evaluate(()=>window.Dwell.state());
    assert.equal(frozen.paused,true);
    assert.ok(Math.abs(frozen.progress-progress)<.05,'partial progress holds rather than filling or decaying');
    await page.evaluate(()=>window.__gazeSample(1));
    await page.waitForFunction(()=>window.MathApp.state().number===8,{},{timeout:2500});
  } finally {await context.close();}
});

test('navigation starts a fresh settle window while touch remains available',async()=>{
  const {context,page}=await open();
  try {
    await control(page,'numbers').tap();await settle(page);
    const result=await page.evaluate(()=>{
      window.MathApp.action('pick');
      const remaining=window.Dwell.state().suppressedMs;
      const target=document.querySelector('[data-number="8"]'),r=target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));
      return {remaining,target:window.Dwell.state().target};
    });
    assert.ok(result.remaining>0&&result.remaining<=CONTRACT.dwellEngine.settleMs+5);
    assert.equal(result.target,null,'new page cannot inherit a gaze activation');
    await page.locator('[data-number="8"]').tap();
    assert.deepEqual((s=>[s.view,s.number])(await state(page)),['numbers',8]);
  } finally {await context.close();}
});

for(const [width,height] of [[1920,1080],[1280,720]])test(`math views fit ${width}×${height}, keep readable body labels and a literal black inert corner`,async()=>{
  const {context,page,errors}=await open({width,height});
  try {
    for(const view of ['menu','numbers','partners','picker','ranges']) {
      if(view==='numbers'||view==='partners')await action(page,view);
      if(view==='numbers')await choose(page,50);
      if(view==='partners')await choose(page,10);
      if(view==='picker')await action(page,'pick');
      if(view==='ranges')await action(page,'ranges');
      const geometry=await page.evaluate(()=>{
        const targets=[...document.querySelectorAll('button.dwell')].filter(e=>e.getBoundingClientRect().width);
        const body=targets.filter(e=>!['barDoor','barTalk'].includes(e.id));
        const boxes=targets.map(e=>{const r=e.getBoundingClientRect();return {label:e.innerText||e.getAttribute('aria-label'),x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};});
        const text=[];
        for(const button of body){const walker=document.createTreeWalker(button,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const n=walker.currentNode;if(n.textContent.trim()){
          const range=document.createRange();range.selectNodeContents(n);const r=range.getBoundingClientRect(),b=button.getBoundingClientRect();
          text.push({text:n.textContent,font:parseFloat(getComputedStyle(n.parentElement).fontSize),fits:r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1});
        }}}
        const stage=document.getElementById('mathStage'),stageBox=stage?.getBoundingClientRect();
        const passive=stage?[...stage.querySelectorAll('.math-counter,.ten-frame,.part-tray,.math-numeral,.math-number-word,.math-equation,.part-number,.whole-number,.place-value')].map(e=>{
          const b=e.getBoundingClientRect();return {class:e.className,fits:b.left>=stageBox.left-1&&b.right<=stageBox.right+1&&b.top>=stageBox.top-1&&b.bottom<=stageBox.bottom+1};
        }):[];
        const corner=document.elementFromPoint(innerWidth*.995,innerHeight*.995);
        let opaque=corner;while(opaque&&getComputedStyle(opaque).backgroundColor==='rgba(0, 0, 0, 0)')opaque=opaque.parentElement;
        return {boxes,text,passive,cornerTarget:!!corner.closest('button,a,.dwell,[data-action]'),cornerColor:opaque&&getComputedStyle(opaque).backgroundColor,
          scroll:document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight};
      });
      assert.equal(geometry.scroll,false,view+' has no hidden overflow');
      assert.ok(geometry.boxes.length<=16);
      for(const b of geometry.boxes)assert.ok(b.x>=-1&&b.y>=-1&&b.right<=width+1&&b.bottom<=height+1,view+' '+JSON.stringify(b));
      for(let i=0;i<geometry.boxes.length;i++)for(let j=i+1;j<geometry.boxes.length;j++) {
        const a=geometry.boxes[i],b=geometry.boxes[j];
        assert.ok(Math.min(a.right,b.right)-Math.max(a.x,b.x)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)<=1,view+' targets overlap');
      }
      for(const label of geometry.text){assert.ok(label.font>=(width===1920?74:44),view+' '+JSON.stringify(label));assert.equal(label.fits,true,view+' clipped text '+label.text);}
      for(const object of geometry.passive)assert.equal(object.fits,true,view+' clipped math '+object.class);
      if(width===1920&&view==='numbers')assert.ok(await page.locator('.place-value').evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=74),'visible place-value text stays readable at native size');
      assert.equal(geometry.cornerTarget,false,view+' literal corner has no action');
      assert.equal(geometry.cornerColor,'rgb(0, 0, 0)',view+' literal corner is black');
      const before=quantities(await state(page));
      await page.mouse.click(width*.995,height*.995);
      assert.deepEqual(quantities(await state(page)),before);
      if(SHOTS){fs.mkdirSync(SHOTS,{recursive:true});await page.screenshot({path:path.join(SHOTS,`math-${view}-${width}.png`)});}
    }
    assert.deepEqual(errors,[]);
  } finally {await context.close();}
});

for(const [width,height] of [[1920,1080],[1280,720]])test(`structured quantities 14 and 50 remain visible and readable at ${width}×${height}`,async()=>{
  const {context,page}=await open({width,height});
  try {
    await control(page,'numbers').click();
    for(const quantity of [14,50]) {
      await choose(page,quantity);
      const display=await page.evaluate(()=>{
        const canvas=document.getElementById('mathStage'),bounds=canvas.getBoundingClientRect();
        const inside=r=>r.left>=bounds.left-1&&r.right<=bounds.right+1&&r.top>=bounds.top-1&&r.bottom<=bounds.bottom+1;
        return {
          counters:[...canvas.querySelectorAll('.math-counter')].map(e=>{
            const r=e.getBoundingClientRect(),paint=getComputedStyle(e),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
            return {w:r.width,h:r.height,inside:inside(r),visible:paint.visibility!=='hidden'&&Number(paint.opacity)>0,
              unobscured:!!hit&&(hit===e||hit.contains(e)||e.contains(hit))};
          }),
          frames:[...canvas.querySelectorAll('.ten-frame')].map(e=>inside(e.getBoundingClientRect())),
          labels:[...canvas.querySelectorAll('.math-number-word,.place-value')].map(e=>({text:e.innerText,font:parseFloat(getComputedStyle(e).fontSize),inside:inside(e.getBoundingClientRect())})),
        };
      });
      assert.equal(display.counters.length,quantity);
      assert.equal(display.frames.length,Math.ceil(quantity/10));
      assert.ok(display.frames.every(Boolean),'the last frame cannot be clipped by the canvas');
      for(const counter of display.counters) {
        assert.equal(counter.inside,true);assert.equal(counter.visible,true);assert.equal(counter.unobscured,true);
        assert.ok(Math.min(counter.w,counter.h)>=32*width/1920,'counters stay large enough to distinguish');
        assert.ok(Math.abs(counter.w/counter.h-1)<.12,'counters retain their circular shape');
      }
      assert.equal(display.labels.length,2);
      for(const label of display.labels){assert.ok(label.font>=74*width/1920,label.text+' stays readable');assert.equal(label.inside,true,label.text+' stays visible');}
      if(SHOTS){fs.mkdirSync(SHOTS,{recursive:true});await page.screenshot({path:path.join(SHOTS,`math-quantity-${quantity}-${width}.png`)});}
    }
  } finally {await context.close();}
});
