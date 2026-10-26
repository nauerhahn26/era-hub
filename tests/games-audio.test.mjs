// Music lifecycle contracts use a deferred audio context; no speaker is exercised.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PUBLIC=path.join(ROOT,'public');
const sibling=path.resolve(ROOT,'..','era-core'+(process.env.ERA_WT_SUFFIX||''));
const CORE=fs.existsSync(sibling)?sibling:path.resolve(ROOT,'..','era-core');
let server,browser,base;
before(async()=>{
  server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture.invalid');
    if(url.pathname==='/settings'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({musicVolCap:40,pauseGoes:'tdsnap'}));return;}
    if(url.pathname==='/voices'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({enabled:false,voices:[]}));return;}
    if(url.pathname.startsWith('/kiosk/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({action:'paused'}));return;}
    if(url.pathname==='/log'){res.writeHead(204);res.end();return;}
    if(url.pathname==='/tts'){res.writeHead(503);res.end();return;}
    let target=path.resolve(PUBLIC,'.'+url.pathname);
    if(!target.startsWith(PUBLIC+path.sep)){res.writeHead(403);res.end();return;}
    if(fs.existsSync(target)&&fs.statSync(target).isDirectory())target=path.join(target,'index.html');
    if(!fs.existsSync(target)&&['/dwell.js','/speech.js'].includes(url.pathname))target=path.join(CORE,path.basename(url.pathname));
    try{res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.svg':'image/svg+xml','.css':'text/css'})[path.extname(target)]||'application/octet-stream');res.end(fs.readFileSync(target));}
    catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch();
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

async function open(){
  const context=await browser.newContext({viewport:{width:1920,height:1080},reducedMotion:'reduce'});
  await context.addInitScript(()=>{
    window.__testHooks=true;
    const stats=window.__audioStats={created:0,resumes:0,suspends:0,started:0,cancelled:0,disconnected:0,peaks:[]};
    const pending=[];
    class Audio {
      constructor(){this.state='suspended';this.currentTime=0;this.destination={};stats.created++;}
      resume(){stats.resumes++;return new Promise(resolve=>pending.push(()=>{this.state='running';resolve();}));}
      suspend(){stats.suspends++;this.state='suspended';return Promise.resolve();}
      createOscillator(){return {frequency:{value:0},connect(){},disconnect(){stats.disconnected++;},start(){stats.started++;},stop(at){if(at===undefined)stats.cancelled++;}};}
      createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(value){stats.peaks.push(value);},exponentialRampToValueAtTime(){}},connect(){},disconnect(){stats.disconnected++;}};}
    }
    window.AudioContext=Audio;window.webkitAudioContext=Audio;
    window.__resolveAudio=()=>{for(const done of pending.splice(0))done();};
  });
  const page=await context.newPage();await page.goto(base+'/games/');
  await page.waitForFunction(()=>window.GamesApp?.state().ready);
  await page.evaluate(async()=>{
    const {createState}=await import('/games/state.js');const s=createState();
    s.view='fashion';s.fashion.view='show';s.fashion.stage.music='pulse';
    s.fashion.looks=[{id:'look-1',outfit:{...s.fashion.draft}}];s.fashion.nextLookId=2;
    s.fashion.selectedLookId='look-1';s.fashion.lineup=['look-1'];s.fashion.show.phase='hold';
    window.GamesApp.test.setState(s);
  });
  return {context,page};
}
const stats=page=>page.evaluate(()=>({...window.__audioStats,peaks:[...window.__audioStats.peaks]}));
const click=(page,action)=>page.locator(`[data-action="${action}"]`).first().click();

test('restoring a show never arms or resumes music by itself',async()=>{
  const {context,page}=await open();try{
    await page.waitForTimeout(100);assert.equal((await stats(page)).created,0);
    await page.reload();await page.waitForFunction(()=>window.GamesApp?.state().ready);
    assert.equal((await stats(page)).created,0);
    assert.equal((await page.evaluate(()=>GamesApp.state())).fashion.stage.music,'pulse');
  }finally{await context.close();}
});

test('a deferred audio resume cannot create notes after Talk interrupts it',async()=>{
  const {context,page}=await open();try{
    await click(page,'show-encore');assert.ok((await stats(page)).resumes>0);
    assert.equal((await stats(page)).started,0,'wait for resume before starting a note');
    await page.locator('#barTalk').click();assert.equal((await page.evaluate(()=>GamesApp.state())).paused,true);
    await page.evaluate(()=>window.__resolveAudio());await page.waitForTimeout(80);
    assert.equal((await stats(page)).started,0);assert.ok((await stats(page)).suspends>0);
  }finally{await context.close();}
});

test('explicit show music respects the shared cap and navigation cancels live notes',async()=>{
  const {context,page}=await open();try{
    await click(page,'show-encore');await page.evaluate(()=>window.__resolveAudio());
    await page.waitForFunction(()=>window.__audioStats.started>0);
    const playing=await stats(page);
    assert.ok(playing.peaks.every(value=>value>0&&value<=.035*.4+Number.EPSILON));
    await click(page,'fashion-collection');
    const stopped=await stats(page);assert.ok(stopped.cancelled>0,'scheduled notes are stopped immediately');
    assert.ok(stopped.disconnected>0);assert.ok(stopped.suspends>0);
    await page.waitForTimeout(700);assert.equal((await stats(page)).started,stopped.started);
  }finally{await context.close();}
});
