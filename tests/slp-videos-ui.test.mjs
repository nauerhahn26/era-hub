import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const require=createRequire(import.meta.url);
const PUBLIC=new URL('../public/',import.meta.url).pathname;
const CORE=new URL('../../era-core/',import.meta.url).pathname;
let server,browser,base,dir;
before(async()=>{
  const { createSlpVideos }=require('../slp-videos.js');
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'era-slp-ui-'));
  const api=createSlpVideos({dataDir:dir,serveMedia(req,res,root,name){res.end(fs.readFileSync(path.join(root,name)));}});
  server=http.createServer((req,res)=>{
    if(api.handle(req,res))return;
    const p=new URL(req.url,'http://fixture.invalid').pathname;
    if(p==='/settings'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({dwellMs:900,settleMs:600,musicVolCap:50,pauseGoes:'tdsnap'}));return;}
    if(p.startsWith('/kiosk/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({action:p.endsWith('pause')?'paused':'closed'}));return;}
    let file=path.join(PUBLIC,p);
    if(p.endsWith('/'))file=path.join(file,'index.html');
    if(!fs.existsSync(file)&&['/dwell.js','/speech.js'].includes(p))file=path.join(CORE,path.basename(p));
    try{res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));}
    catch{res.writeHead(404).end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));if(dir)fs.rmSync(dir,{recursive:true,force:true});});

test('side by side layout, real camera mirror, explicit local recording and cleanup',async()=>{
 const context=await browser.newContext({permissions:['camera','microphone'],viewport:{width:1280,height:720}});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/slp-videos/');
 await page.getByText('No practice videos yet.').waitFor();
 assert.equal(await page.evaluate(()=>window.Dwell.config.settleMs),600);
 assert.equal(await page.locator('#model').evaluate(e=>e.volume),.5);
 await page.getByRole('button',{name:'Partner controls',exact:true}).click();
 await page.locator('#importFiles').setInputFiles({name:'Practice.mp4',mimeType:'video/mp4',buffer:Buffer.from('synthetic media')});
 await page.getByRole('button',{name:'Practice',exact:true}).waitFor();
 await page.getByRole('button',{name:'Start camera',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#mirror').srcObject?.getVideoTracks()[0]?.readyState==='live');
 assert.equal(await page.locator('#mirror').evaluate(e=>e.muted),true);
 assert.match(await page.locator('#mirror').evaluate(e=>getComputedStyle(e).transform),/-1/);
 const partner=await page.locator('#partnerToggle').boundingBox(),lock=await page.locator('.app-lock-control').boundingBox();
 assert.ok(partner.x+partner.width<=lock.x,'Partner controls leave the shared lock unobscured');
 const left=await page.locator('#modelPanel').boundingBox(),right=await page.locator('#mirrorPanel').boundingBox();
 assert.ok(left.x+left.width<=right.x+2);assert.ok(Math.abs(left.width-right.width)<3);
 assert.ok(await page.locator('#play').evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=44),'video commands meet the shared minimum text size');
 assert.ok(await page.locator('.commands').evaluate(e=>parseFloat(getComputedStyle(e).columnGap)>=14),'command gaps meet the shared minimum');
 await page.getByRole('button',{name:'Record Ellie',exact:true}).click();
 await page.getByText('Recording Ellie', {exact:true}).waitFor();
 await page.waitForTimeout(1400);
 await page.getByRole('button',{name:'Stop and save',exact:true}).click();
 await page.getByText('Recording saved on this device.',{exact:true}).waitFor();
 const saved=await (await page.request.get(base+'/api/slp-videos/recordings')).json();assert.equal(saved.recordings.length,1);
 assert.ok(fs.statSync(path.join(dir,'slp-videos','recordings',saved.recordings[0].id)).size>100);
 await page.getByRole('button',{name:'Stop camera',exact:true}).click();
 assert.equal(await page.locator('#mirror').evaluate(e=>e.srcObject),null);
 for(const viewport of [{width:1280,height:800},{width:1920,height:1080}]){
  await page.setViewportSize(viewport);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }
 assert.deepEqual(errors,[]);await context.close();
});

test('denied camera keeps library and Exit available; no recording starts automatically',async()=>{
 const context=await browser.newContext();const page=await context.newPage();
 await page.addInitScript(()=>{Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{throw new DOMException('Denied','NotAllowedError');}});});
 await page.goto(base+'/slp-videos/');
 await page.getByRole('button',{name:'Partner controls',exact:true}).click();
 await page.getByRole('button',{name:'Start camera',exact:true}).click();
 await page.getByText(/Camera access was denied/).waitFor();
 assert.equal(await page.locator('#barDoor').isVisible(),true);
 assert.equal(await page.locator('#record').isDisabled(),true);
 await context.close();
});


test('lock interrupts the live camera; Talk saves a recording before handing over',async()=>{
 const context=await browser.newContext({permissions:['camera','microphone']});const page=await context.newPage();
 await page.goto(base+'/slp-videos/');
 await page.getByRole('button',{name:'Partner controls',exact:true}).click();
 await page.getByRole('button',{name:'Start camera',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#mirror').srcObject);
 await page.evaluate(()=>window.AppLock.get('slp-videos').lock());
 await page.waitForFunction(()=>!document.querySelector('#mirror').srcObject);
 assert.equal(await page.locator('.app-lock-curtain').isVisible(),true);
 await page.evaluate(()=>window.AppLock.get('slp-videos').requestUnlock());
 await page.waitForFunction(()=>document.querySelector('#mirror').srcObject);
 await page.getByRole('button',{name:'Record Ellie',exact:true}).click();
 await page.getByText('Recording Ellie',{exact:true}).waitFor();await page.waitForTimeout(1200);
 const before=(await (await page.request.get(base+'/api/slp-videos/recordings')).json()).recordings.length;
 await page.route('**/api/slp-videos/recordings',async route=>{if(route.request().method()==='POST')await new Promise(r=>setTimeout(r,2000));await route.continue();});
 const handed=page.waitForRequest(r=>r.url().endsWith('/kiosk/pause'));
 await page.locator('#barTalk').click();await handed;
 assert.equal((await (await page.request.get(base+'/api/slp-videos/recordings')).json()).recordings.length,before+1,'saved before handoff');
 await page.getByText('Recording saved on this device.',{exact:true}).waitFor();
 assert.equal(await page.locator('#mirror').evaluate(e=>e.srcObject),null);
 await context.close();
});

test('actual shared dwell plays video once per look and requires moving away to rearm',async()=>{
 const context=await browser.newContext({permissions:['camera','microphone'],viewport:{width:1280,height:720}});
 await context.addInitScript(()=>{
  const sockets=[];
  window.WebSocket=class{
   constructor(){this.readyState=1;sockets.push(this);setTimeout(()=>this.onopen?.({}),0);}
   send(){} close(){this.readyState=3;} addEventListener(t,h){this['on'+t]=h;}
  };
  setInterval(()=>{for(const socket of sockets)socket.onmessage?.({data:JSON.stringify({gazePoint:{x:.5,y:.5},validity:1})});},80);
 });
 const page=await context.newPage();await page.goto(base+'/slp-videos/');
 const bytes=await page.evaluate(async()=>{
  const stream=await navigator.mediaDevices.getUserMedia({video:true});
  const recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];
  const done=new Promise(resolve=>{recorder.ondataavailable=e=>chunks.push(e.data);recorder.onstop=resolve;});
  recorder.start();await new Promise(r=>setTimeout(r,400));recorder.stop();await done;stream.getTracks().forEach(t=>t.stop());
  return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
 });
 await page.getByRole('button',{name:'Partner controls',exact:true}).click();
 await page.locator('#importFiles').setInputFiles({name:'Playable.webm',mimeType:'video/webm',buffer:Buffer.from(bytes)});
 await page.getByRole('button',{name:'Playable',exact:true}).click();
 await page.getByRole('button',{name:'Partner controls',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#model').readyState>=2);
 await page.locator('#model').evaluate(e=>{e.loop=true;});
 await page.waitForFunction(()=>window.Dwell&&!window.Dwell.state().suppressedMs);
 const b=await page.locator('#play').boundingBox();await page.mouse.move(1,100);await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:3});
 await page.waitForFunction(()=>!document.querySelector('#model').paused,null,{timeout:5000});
 await page.waitForTimeout(2000);assert.equal(await page.locator('#model').evaluate(e=>e.paused),false,'holding the same target does not toggle it back');
 await page.mouse.move(1,100);await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:3});
 await page.waitForFunction(()=>document.querySelector('#model').paused,null,{timeout:5000});
 await context.close();
});

test('late camera permission after leaving releases all acquired tracks',async()=>{
 const context=await browser.newContext({permissions:['camera']});const page=await context.newPage();
 await page.addInitScript(()=>{
  const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async constraints=>{window.pendingCamera=await original(constraints);await new Promise(r=>window.releaseCamera=r);return window.pendingCamera;};
 });
 await page.goto(base+'/slp-videos/');await page.getByRole('button',{name:'Partner controls',exact:true}).click();
 await page.getByRole('button',{name:'Start camera',exact:true}).click();await page.waitForFunction(()=>window.releaseCamera);
 await page.evaluate(()=>{dispatchEvent(new Event('pagehide'));window.releaseCamera();});
 await page.waitForFunction(()=>window.pendingCamera.getTracks().every(t=>t.readyState==='ended'));
 assert.equal(await page.locator('#mirror').evaluate(e=>e.srcObject),null);await context.close();
});
