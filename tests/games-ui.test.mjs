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
  assert.ok(fs.existsSync(path.join(PUBLIC,'games','index.html')),'the Games page must exist');
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

async function open({width=1920,height=1080,hooks=true,motion='reduce'}={}) {
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,hasTouch:true,reducedMotion:motion});
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
  await page.goto(base+'/games/');
  await page.waitForFunction(()=>window.GamesApp?.state().ready,{},{timeout:5000});
  return {context,page,errors,external:requests};
}
const state=page=>page.evaluate(()=>window.GamesApp.state());
const command=(page,name,value)=>page.locator(`[data-action="${name}"]${value===undefined?'':`[data-value="${value}"]`}`);

test('Games opens three local games with shared doors and a passive preview',async()=>{
  const {context,page,errors,external}=await open();
  try {
    assert.equal((await state(page)).view,'menu');
    for(const game of ['fashion','connect4','tiles'])assert.equal(await command(page,'open',game).isVisible(),true);
    assert.equal(await page.locator('#barDoor').isVisible(),true);
    assert.equal(await page.locator('#barTalk').isVisible(),true);
    await command(page,'open','fashion').tap();
    assert.equal((await state(page)).view,'fashion');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  } finally {await context.close();}
});

test('deterministic mutation setup is absent in normal use',async()=>{
  const {context,page}=await open({hooks:false});
  try {
    assert.deepEqual(await page.evaluate(()=>['test','action','reset','setState'].map(key=>typeof window.GamesApp[key])),
      ['undefined','undefined','undefined','undefined']);
    assert.equal(await page.evaluate(()=>{
      const snapshot=window.GamesApp.state();snapshot.view='credits';snapshot.fashion.draft.color='invalid';
      const current=window.GamesApp.state();return current.view==='menu'&&current.fashion.draft.color!=='invalid';
    }),true,'readback cannot mutate the running game');
  }
  finally {await context.close();}
});

const setup=async(page,change)=>{
  const s=await state(page);change(s);
  await page.evaluate(s=>window.GamesApp.test.setState(s),s);
};
async function click(page,name,value){await command(page,name,value).click();}
async function settle(page){await page.waitForFunction(()=>!window.Dwell.state().suppressedMs);}
async function look(page,name,value){
  await settle(page);const size=page.viewportSize();await page.mouse.move(1,size.height-2);
  const b=await command(page,name,value).boundingBox();
  assert.ok(b,`visible command ${name} ${value}`);
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:3});
}
async function saveShot(page,name){
  if(SHOTS){fs.mkdirSync(SHOTS,{recursive:true});await page.screenshot({path:path.join(SHOTS,`games-${name}-${page.viewportSize().width}.png`)});}
}

// The rig must change in the delivered browser, not merely in saved JSON.
test('fashion choices change the passive garment preview only after selection and survive reload',async()=>{
  const {context,page,errors}=await open();
  try {
    await click(page,'open','fashion');await click(page,'fashion-new');
    const preview=page.locator('[data-testid="fashion-preview"]');
    assert.equal(await preview.evaluate(e=>!!e.closest('button,a,.dwell,[data-action]')),false);
    const original=await preview.screenshot();
    await click(page,'fashion-edit','color');
    const draftBefore=(await state(page)).fashion.draft;
    const alternative=await command(page,'option').evaluateAll((nodes,current)=>nodes.find(n=>n.dataset.value!==current)?.dataset.value,draftBefore.color);
    assert.ok(alternative,'at least one different colour is offered');
    await command(page,'option',alternative).hover();
    assert.deepEqual((await state(page)).fashion.draft,draftBefore,'looking does not apply or preview an option');
    await click(page,'option',alternative);
    assert.equal((await state(page)).fashion.draft.color,alternative);
    const recolored=await preview.screenshot();
    assert.equal(original.equals(recolored),false,'actual garment paint changes');
    await click(page,'fashion-shape');await click(page,'fashion-edit','cut');
    const cutBefore=(await state(page)).fashion.draft.cut;
    const nextCut=await command(page,'option').evaluateAll((nodes,current)=>nodes.find(n=>n.dataset.value!==current)?.dataset.value,cutBefore);
    await click(page,'option',nextCut);
    assert.equal((await state(page)).fashion.draft.cut,nextCut);
    const changed=await preview.screenshot();
    assert.equal(recolored.equals(changed),false,'actual garment silhouette changes');
    await click(page,'undo');
    assert.equal((await state(page)).fashion.draft.cut,cutBefore);
    const saved=(await state(page)).fashion.draft;
    await page.reload();await page.waitForFunction(()=>window.GamesApp?.state().ready);
    assert.deepEqual((await state(page)).fashion.draft,saved);
    assert.deepEqual(errors,[]);
  } finally {await context.close();}
});

test('Four in a Row keeps fixed column nodes, resolves a strategy, undoes and confirms restart',async()=>{
  const {context,page}=await open();
  try {
    await click(page,'open','connect4');
    await page.evaluate(()=>window.__columnNodes=[...document.querySelectorAll('[data-action="connect4-drop"]')]);
    for(const column of [0,1,0,1,0,1,0])await click(page,'connect4-drop',column);
    const won=(await state(page)).connect4;
    assert.equal(won.status,'won');assert.equal(won.winner,1);
    assert.equal(await page.evaluate(()=>window.__columnNodes.every((n,i)=>n===document.querySelectorAll('[data-action="connect4-drop"]')[i]&&n.isConnected)),true,'moves preserve dwell node identity');
    await click(page,'undo');assert.equal((await state(page)).connect4.status,'playing');
    const before=(await state(page)).connect4.board;
    await click(page,'restart');assert.deepEqual((await state(page)).connect4.board,before);
    await command(page,'cancel').first().click();assert.deepEqual((await state(page)).connect4.board,before);
    await click(page,'restart');await click(page,'confirm');
    assert.equal((await state(page)).connect4.board.flat().every(v=>v===0),true);
    await setup(page,s=>{
      s.connect4.mode='computer';s.connect4.turn=1;
      s.connect4.board[5][0]=2;s.connect4.board[4][0]=2;s.connect4.board[3][0]=2;
      s.connect4.board[5][1]=1;s.connect4.board[5][3]=1;s.connect4.board[5][5]=1;
    });
    await click(page,'connect4-drop',6);
    await page.waitForFunction(()=>window.GamesApp.state().connect4.status==='won',{},{timeout:3000});
    assert.equal((await state(page)).connect4.winner,2,'computer takes an immediate winning column');
  } finally {await context.close();}
});

test('Number Tiles invalid move does not spawn and Undo restores board, score and randomness',async()=>{
  const {context,page}=await open();
  try {
    await click(page,'open','tiles');
    await setup(page,s=>{s.tiles.board=[[2,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];s.tiles.score=0;s.tiles.history=[];s.tiles.rng=12345;});
    const before=(await state(page)).tiles;
    await click(page,'tiles-move','left');
    assert.deepEqual((await state(page)).tiles,before);
    await click(page,'tiles-move','right');
    const moved=(await state(page)).tiles;
    assert.notDeepEqual(moved.board,before.board);
    assert.equal(moved.board.flat().filter(Boolean).length,2);
    await click(page,'undo');
    const undo=(await state(page)).tiles;
    assert.deepEqual(undo.board,before.board);assert.equal(undo.score,before.score);assert.equal(undo.rng,before.rng);
    await click(page,'tiles-move','right');
    assert.deepEqual((await state(page)).tiles.board,moved.board,'replaying after undo produces the same spawn');
  } finally {await context.close();}
});

test('real dwell requires movement to repeat a column and freezes during lost tracking',async()=>{
  const {context,page}=await open();
  try {
    await click(page,'open','connect4');
    await look(page,'connect4-drop',0);
    await page.waitForFunction(()=>window.GamesApp.state().connect4.board.flat().filter(Boolean).length===1,{},{timeout:2500});
    await page.waitForTimeout(1200);
    assert.equal((await state(page)).connect4.board.flat().filter(Boolean).length,1);
    await look(page,'connect4-drop',0);
    await page.waitForFunction(()=>window.Dwell.state().progress>.12);
    await page.evaluate(()=>window.__gazeSample(0));
    const progress=await page.evaluate(()=>window.Dwell.state().progress);
    await page.waitForTimeout(1100);
    assert.equal((await state(page)).connect4.board.flat().filter(Boolean).length,1);
    assert.ok(Math.abs((await page.evaluate(()=>window.Dwell.state().progress))-progress)<.05);
    await page.evaluate(()=>window.__gazeSample(1));
    await page.waitForFunction(()=>window.GamesApp.state().connect4.board.flat().filter(Boolean).length===2,{},{timeout:2500});
  } finally {await context.close();}
});

test('Talk freezes a pending computer turn and the shared doors use twice ordinary dwell',async()=>{
  const {context,page}=await open();
  try {
    await click(page,'open','connect4');
    const values=await page.evaluate(()=>({ms:window.Dwell.config.ms,door:document.querySelector('#barDoor').dataset.dwellMs,talk:document.querySelector('#barTalk').dataset.dwellMs}));
    assert.deepEqual(values,{ms:900,door:'1800',talk:'1800'});
    const before=await page.evaluate(()=>{
      const s=window.GamesApp.state();s.connect4.mode='computer';s.connect4.turn=2;s.connect4.pendingComputer=true;
      s.connect4.board[5][0]=1;
      window.GamesApp.test.setState(s);document.querySelector('#barTalk').click();
      return s.connect4.board;
    });
    await page.waitForTimeout(1000);
    assert.equal((await state(page)).paused,true);
    assert.deepEqual((await state(page)).connect4.board,before,'no delayed computer turn during communication');
    await page.reload();await page.waitForFunction(()=>window.GamesApp?.state().ready);
    assert.equal((await state(page)).paused,false,'a fresh page clears transient communication suspension');
    await page.waitForFunction(()=>window.GamesApp.state().connect4.turn===1,{},{timeout:2500});
  } finally {await context.close();}
});

test('page changes settle before gaze activation while touch and partner setup remain deliberate',async()=>{
  const {context,page}=await open();
  try {
    await click(page,'open','fashion');await settle(page);
    const remaining=await page.evaluate(()=>{
      window.GamesApp.test.action('fashion-new');return window.Dwell.state().suppressedMs;
    });
    assert.ok(remaining>0&&remaining<=CONTRACT.dwellEngine.settleMs+5);
    await command(page,'fashion-shape').tap();
    assert.equal(await command(page,'fashion-edit','cut').isVisible(),true,'touch remains available during settling');
    await page.locator('.partner-button').click();
    assert.equal(await page.locator('.partner-panel').isVisible(),true);
    assert.equal(await page.locator('.partner-button.dwell,.partner-panel .dwell').count(),0,'partner setup is never a dwell target');
  } finally {await context.close();}
});

async function assertLayout(page,label){
  const {width,height}=page.viewportSize();
  await saveShot(page,label);
  const geometry=await page.evaluate(()=>{
    const targets=[...document.querySelectorAll('button.dwell')].filter(e=>e.getBoundingClientRect().width&&getComputedStyle(e).visibility!=='hidden');
    const boxes=targets.map(e=>{const r=e.getBoundingClientRect();return {id:e.id,action:e.dataset.action,label:e.innerText,x:r.x,y:r.y,right:r.right,bottom:r.bottom};});
    const text=[];
    for(const button of targets.filter(e=>!['barDoor','barTalk'].includes(e.id))){
      const b=button.getBoundingClientRect(),walker=document.createTreeWalker(button,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()){
        const n=walker.currentNode;if(!n.textContent.trim())continue;
        const range=document.createRange();range.selectNodeContents(n);
        for(const r of range.getClientRects())text.push({text:n.textContent,font:parseFloat(getComputedStyle(n.parentElement).fontSize),fits:r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1});
      }
    }
    const corner=document.elementFromPoint(innerWidth*.995,innerHeight*.995);
    let opaque=corner;while(opaque&&getComputedStyle(opaque).backgroundColor==='rgba(0, 0, 0, 0)')opaque=opaque.parentElement;
    const passiveText=[...document.querySelectorAll('.game-heading h1,.game-status,.look-label,.scene-caption,.empty-caption,.board-column-number')].filter(e=>e.getBoundingClientRect().width&&e.textContent.trim()).map(e=>{
      const range=document.createRange();range.selectNodeContents(e);
      const clips=[];let parent=e;
      while(parent){if(/hidden|clip|auto|scroll/.test(getComputedStyle(parent).overflow))clips.push(parent.getBoundingClientRect());parent=parent.parentElement;}
      return {text:e.textContent,font:parseFloat(getComputedStyle(e).fontSize),fits:[...range.getClientRects()].every(r=>r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1&&clips.every(b=>r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1))};
    });
    return {boxes,text,passiveText,cornerAction:!!corner.closest('button,a,.dwell,[data-action]'),cornerColor:opaque&&getComputedStyle(opaque).backgroundColor,
      scroll:document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight,
      passive:[...document.querySelectorAll('.connect-cell,.board-column-number,.number-tile,[data-testid="fashion-preview"]')].every(e=>!e.closest('button,a,.dwell,[data-action]'))};
  });
  assert.equal(geometry.scroll,false,label+' scrolls outside the viewport');
  assert.equal(geometry.passive,true,label+' game content is passive');
  assert.ok(geometry.boxes.length>2,label+' has child commands');
  for(const b of geometry.boxes)assert.ok(b.x>=-1&&b.y>=-1&&b.right<=width+1&&b.bottom<=height+1,label+' '+JSON.stringify(b));
  for(let i=0;i<geometry.boxes.length;i++)for(let j=i+1;j<geometry.boxes.length;j++){
    const a=geometry.boxes[i],b=geometry.boxes[j];
    const horizontalGap=Math.max(a.x-b.right,b.x-a.right),verticalGap=Math.max(a.y-b.bottom,b.y-a.bottom);
    assert.ok(horizontalGap>=13||verticalGap>=13,label+' targets lack 14px gap: '+a.label+' / '+b.label);
  }
  for(const text of geometry.text){
    assert.ok(text.font>=74,label+' command label too small: '+JSON.stringify(text));
    assert.equal(text.fits,true,label+' clipped command: '+text.text);
  }
  // Passive headings/status identify the workspace and game result. Their
  // explicit fit exception is 44px; they are never an activation target.
  for(const text of geometry.passiveText){
    assert.ok(text.font>=44,label+' passive label too small: '+JSON.stringify(text));
    assert.equal(text.fits,true,label+' clipped passive label: '+text.text);
  }
  if(label==='connect4'){
    const mapping=await page.evaluate(()=>{
      const labels=[...document.querySelectorAll('.board-column-number')],cells=[...document.querySelectorAll('.connect-cell')].slice(0,7);
      return labels.map((label,i)=>{
        const a=label.getBoundingClientRect(),b=cells[i].getBoundingClientRect();
        return {label:label.textContent,centerOffset:Math.abs(a.x+a.width/2-b.x-b.width/2),above:a.bottom<=b.top};
      });
    });
    assert.deepEqual(mapping.map(x=>x.label),['1','2','3','4','5','6','7']);
    assert.ok(mapping.every(x=>x.centerOffset<1&&x.above),'passive column numbers align with the actual board columns');
  }
  assert.equal(geometry.cornerAction,false,label+' rest corner activates a command');
  assert.equal(geometry.cornerColor,'rgb(0, 0, 0)',label+' rest corner is not black');
  const before=await state(page);await page.mouse.click(width*.995,height*.995);
  assert.deepEqual(await state(page),before,label+' rest click changes state');
  await saveShot(page,label);
}

for(const [width,height] of [[1920,1080],[1280,720]])test(`all child workspaces fit ${width}×${height} with readable fixed commands and an inert corner`,async()=>{
  const {context,page,errors}=await open({width,height});
  try {
    const failures=[];
    const inspect=async label=>{try{await assertLayout(page,label);}catch(error){failures.push(error.message);}};
    await inspect('menu');
    for(const game of ['connect4','tiles']){
      await setup(page,s=>{s.view=game;});await inspect(game);
    }
    for(const view of ['studio','workbench','styling','collection','stage','show']){
      await setup(page,s=>{
        s.view='fashion';s.fashion.view=view;
        const outfit={...s.fashion.draft};s.fashion.looks=[{id:'look-1',outfit},{id:'look-2',outfit:{...outfit,color:'coral'}}];
        s.fashion.selectedLookId='look-1';s.fashion.lineup=['look-1','look-2'];s.fashion.nextLookId=3;
        s.fashion.show.phase='hold';
      });
      await inspect(view);
    }
    await setup(page,s=>{s.view='fashion';s.fashion.view='options';s.fashion.editField='color';});
    await inspect('options');
    await setup(page,s=>{s.view='tiles';});await click(page,'restart');await inspect('confirmation');
    assert.deepEqual(errors,[]);
    assert.deepEqual(failures,[],failures.join('\n'));
  } finally {await context.close();}
});

for(const [width,height] of [[1920,1080],[1280,720]])test(`three distinct looks can be created, ordered and shown through commands at ${width}×${height}`,async()=>{
  const {context,page,errors,external}=await open({width,height});
  try {
    const catalog=await page.evaluate(async()=> (await import('/games/state.js')).CATALOG);
    const edit=async(field,value)=>{
      if(['cut','sleeves'].includes(field))await click(page,'fashion-shape');
      if(['detail','detailPosition'].includes(field))await click(page,'fashion-details');
      await click(page,'fashion-edit',field);
      if(catalog[field].findIndex(o=>o.value===value)>=4)await click(page,'option-page',1);
      await click(page,'option',value);
    };
    await click(page,'open','fashion');await saveShot(page,'flow-studio');
    await click(page,'fashion-new');
    await edit('cut','dress');await edit('sleeves','flutter');await edit('pattern','stars');
    await edit('detail','daisy');await edit('color','coral');await saveShot(page,'flow-workbench');
    await click(page,'fashion-edit','color');await saveShot(page,'flow-options');await click(page,'back');
    await click(page,'back');await click(page,'fashion-style');
    await edit('hair','braids');await edit('shoes','boots');await saveShot(page,'flow-styling');
    await click(page,'fashion-save');
    const first=(await state(page)).fashion.looks[0];
    assert.equal(first.outfit.cut,'dress');assert.equal(first.outfit.detail,'daisy');
    await click(page,'collection-actions');await click(page,'lineup-add');
    await click(page,'collection-actions');await click(page,'fashion-new');
    await edit('cut','tunic');await edit('sleeves','long');await edit('color','plum');
    await edit('pattern','waves');await edit('detail','bow');
    await click(page,'back');await click(page,'fashion-style');
    await edit('hair','short');await edit('shoes','sandals');await edit('model','deep');
    await click(page,'fashion-save');
    const second=(await state(page)).fashion.looks[1];assert.notEqual(second.id,first.id);
    await click(page,'collection-actions');await click(page,'lineup-add');
    await click(page,'collection-actions');await click(page,'fashion-new');
    await edit('cut','tshirt');await edit('sleeves','sleeveless');await edit('color','sunshine');
    await edit('pattern','stripes');await edit('detail','heart');
    await click(page,'back');await click(page,'fashion-style');
    await edit('hair','curls');await edit('shoes','flats');await edit('bottoms','skirt');
    await click(page,'fashion-save');
    const third=(await state(page)).fashion.looks[2];
    assert.equal(third.outfit.color,'sunshine');
    assert.deepEqual((await state(page)).fashion.looks[0],first,'saved dress remains unchanged while new looks are edited');
    await saveShot(page,'flow-collection');
    await click(page,'collection-actions');await click(page,'lineup-add');
    assert.deepEqual((await state(page)).fashion.lineup,[first.id,second.id,third.id]);
    await click(page,'stage');await click(page,'lineup-order');await click(page,'lineup-up');
    assert.deepEqual((await state(page)).fashion.lineup,[first.id,third.id,second.id]);
    await saveShot(page,'flow-order');await click(page,'back');
    await click(page,'stage-venue');await click(page,'option','garden');
    assert.equal((await state(page)).fashion.stage.venue,'garden');await saveShot(page,'flow-stage');
    await click(page,'show-start');
    await page.waitForFunction(()=>window.GamesApp.state().fashion.show.phase==='hold',{},{timeout:3000});
    assert.equal((await state(page)).fashion.show.index,0);
    await click(page,'show-pose');
    const posed=(await state(page)).fashion.show;
    assert.notEqual(posed.pose,'stand');
    assert.equal(await page.locator('.character').evaluate(e=>getComputedStyle(e).animationName),'none','reduced motion disables animated entrance');
    await page.waitForTimeout(450);assert.deepEqual((await state(page)).fashion.show,posed,'the pose waits for a choice');
    await saveShot(page,'flow-show');
    await click(page,'show-next');await page.waitForFunction(()=>window.GamesApp.state().fashion.show.phase==='hold');
    assert.equal((await state(page)).fashion.show.index,1);
    await click(page,'show-encore');await page.waitForFunction(()=>window.GamesApp.state().fashion.show.phase==='hold');
    assert.equal((await state(page)).fashion.show.encores,1);
    await click(page,'show-pause');assert.equal((await state(page)).fashion.show.paused,true);
    const preserved=(await state(page)).fashion;
    await page.locator('#barTalk').click();await page.waitForTimeout(500);
    assert.deepEqual((await state(page)).fashion,preserved,'Talk preserves exact outfits, order, pose and show index');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  } finally {await context.close();}
});

test('every offered catalog page fits at 1280 and fabric, cut, pattern and detail choices have distinct rendered results',async()=>{
  const {context,page}=await open({width:1280,height:720});
  try {
    await click(page,'open','fashion');await click(page,'fashion-new');
    const catalog=await page.evaluate(async()=> (await import('/games/state.js')).CATALOG);
    const baseState=await state(page),failures=[];
    const setOptions=async(field,optionPage=0)=>{
      const fixture=structuredClone(baseState);
      fixture.fashion.view='options';fixture.fashion.editField=field;fixture.fashion.optionPage=optionPage;
      if(field==='detailPosition')fixture.fashion.draft.detail='daisy';
      await page.evaluate(s=>window.GamesApp.test.setState(s),fixture);
    };
    for(const [field,options] of Object.entries(catalog)){
      if(['venue','music'].includes(field)){
        await setup(page,s=>{s.view='fashion';s.fashion.view='stage';});
        await click(page,`stage-${field}`);
        try{await assertLayout(page,`catalog-${field}`);}catch(error){failures.push(error.message);}
        assert.deepEqual(await command(page,'option').evaluateAll(nodes=>nodes.map(n=>n.dataset.value)),options.map(o=>o.value));
        continue;
      }
      const signatures=[];
      for(let optionPage=0;optionPage<Math.ceil(options.length/4);optionPage++){
        await setOptions(field,optionPage);
        try{await assertLayout(page,`catalog-${field}-${optionPage}`);}catch(error){failures.push(error.message);}
        const offered=options.slice(optionPage*4,optionPage*4+4);
        assert.deepEqual(await command(page,'option').evaluateAll(nodes=>nodes.map(n=>n.dataset.value)),offered.map(o=>o.value));
        if(['color','cut','pattern','detail','detailPosition'].includes(field))for(const option of offered){
          await setOptions(field,optionPage);await click(page,'option',option.value);
          assert.equal((await state(page)).fashion.draft[field],option.value);
          signatures.push((await page.locator('[data-testid="fashion-preview"]').screenshot()).toString('base64'));
        }
      }
      if(signatures.length)assert.equal(new Set(signatures).size,options.length,`${field}: each choice must change the visible garment`);
    }
    assert.deepEqual(failures,[],failures.join('\n'));
  } finally {await context.close();}
});

// Headless tabs remain visible when another tab is fronted. Override only the
// document's reported lifecycle state, then exercise the real DOM listeners,
// doorbar callbacks, timer cancellation and CSS animations together.
async function visibility(page,hidden){
  await page.evaluate(hidden=>{
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>hidden?'hidden':'visible'});
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
    document.dispatchEvent(new Event('visibilitychange'));
  },hidden);
}

test('document lifecycle freezes a pending computer turn and resumes it exactly once after hidden or Talk',async()=>{
  const {context,page}=await open();
  try {
    const fixture=await state(page);fixture.view='connect4';fixture.connect4.mode='computer';
    fixture.connect4.board[5][0]=1;fixture.connect4.turn=2;fixture.connect4.pendingComputer=true;
    for(const reason of ['hidden','Talk']){
      await page.evaluate(s=>window.GamesApp.test.setState(s),fixture);
      if(reason==='Talk'){await page.locator('#barTalk').click();await page.waitForTimeout(80);}
      await visibility(page,true);
      await page.waitForTimeout(750);
      assert.deepEqual((await state(page)).connect4.board,fixture.connect4.board,reason+' freezes the pending turn');
      await visibility(page,false);
      await page.waitForFunction(()=>window.GamesApp.state().connect4.board.flat().filter(Boolean).length===2,{},{timeout:2500});
      await page.waitForTimeout(650);
      const resumed=await state(page);
      assert.equal(resumed.paused,false);assert.equal(resumed.hidden,false);
      assert.equal(resumed.connect4.board.flat().filter(Boolean).length,2,reason+' resumes exactly one computer turn');
      assert.equal(resumed.connect4.turn,1);
    }
  } finally {await context.close();}
});

test('normal-motion entrance pauses through document hiding and Talk without replacing or restarting the model',async()=>{
  const {context,page}=await open({motion:'no-preference'});
  try {
    const fixture=await state(page);fixture.view='fashion';fixture.fashion.view='show';
    fixture.fashion.looks=[{id:'look-1',outfit:{...fixture.fashion.draft,cut:'dress',pattern:'stars'}}];
    fixture.fashion.nextLookId=2;fixture.fashion.selectedLookId='look-1';fixture.fashion.lineup=['look-1'];fixture.fashion.show.phase='entrance';
    await page.evaluate(s=>window.GamesApp.test.setState(s),fixture);
    await page.waitForTimeout(220);
    await page.evaluate(()=>window.__entranceRig=document.querySelector('.character'));
    const animation=()=>page.locator('.character').evaluate(e=>{
      const a=e.getAnimations().find(a=>a.animationName==='entrance');return a?{time:a.currentTime,state:a.playState}:null;
    });
    await visibility(page,true);await page.waitForTimeout(80);
    const hidden=await animation();assert.ok(hidden&&hidden.time>0);assert.equal(hidden.state,'paused');
    await page.waitForTimeout(400);
    assert.ok(Math.abs((await animation()).time-hidden.time)<35,'hidden CSS animation does not advance');
    assert.equal((await state(page)).fashion.show.phase,'entrance');
    await visibility(page,false);await page.waitForTimeout(140);
    assert.ok((await animation()).time>hidden.time+60,'visible resumes the same entrance time');
    assert.equal(await page.evaluate(()=>document.querySelector('.character')===window.__entranceRig),true);
    await page.locator('#barTalk').click();await page.waitForTimeout(80);
    const talking=await animation();assert.equal(talking.state,'paused');
    await page.waitForTimeout(350);
    assert.ok(Math.abs((await animation()).time-talking.time)<35,'Talk holds CSS pose and entrance time');
    await visibility(page,true);await visibility(page,false);
    await page.waitForTimeout(100);
    assert.equal((await state(page)).paused,false);
    assert.equal(await page.evaluate(()=>document.querySelector('.character')===window.__entranceRig),true,'resume preserves the model node');
    assert.ok((await animation()).time>=talking.time,'entrance never resets to its start');
    await page.waitForFunction(()=>window.GamesApp.state().fashion.show.phase==='hold',{},{timeout:3000});
    const arrived=(await state(page)).fashion.show;
    await page.waitForTimeout(450);assert.deepEqual((await state(page)).fashion.show,arrived,'one entrance completes into a held pose');
    await click(page,'show-pose');assert.notEqual((await state(page)).fashion.show.pose,'stand');
  } finally {await context.close();}
});

test('removal and full-collection replacement show the exact saved target and wait for confirmation',async()=>{
  const {context,page}=await open({width:1280,height:720});
  try {
    await setup(page,s=>{
      s.view='fashion';s.fashion.view='collection';
      const outfit={...s.fashion.draft};
      s.fashion.looks=[{id:'look-1',outfit},{id:'look-2',outfit:{...outfit,cut:'dress',color:'coral',detail:'daisy'}},{id:'look-3',outfit:{...outfit,cut:'hoodie',color:'plum'}}];
      s.fashion.selectedLookId='look-2';s.fashion.nextLookId=4;s.fashion.lineup=['look-1','look-2','look-3'];
    });
    const original=(await state(page)).fashion.looks;
    await click(page,'look-select','look-2');await click(page,'collection-actions');await click(page,'look-delete');
    assert.equal((await state(page)).pending.id,'look-2');
    const preview=page.locator('[data-testid="confirm-look-preview"]');
    assert.equal(await preview.locator('.confirm-look-label').innerText(),'Look 2');
    assert.equal(await preview.locator('.character').getAttribute('data-cut'),'dress');
    assert.equal(await preview.locator('.character').getAttribute('data-detail'),'daisy');
    const targetFabric=await preview.locator('.character').evaluate(e=>getComputedStyle(e).getPropertyValue('--fabric'));
    await page.waitForTimeout(450);assert.deepEqual((await state(page)).fashion.looks,original,'confirmation never times out into removal');
    await command(page,'cancel').first().click();assert.deepEqual((await state(page)).fashion.looks,original);
    await click(page,'collection-actions');await click(page,'look-edit');
    await click(page,'fashion-edit','color');await click(page,'option','plum');await click(page,'fashion-save');
    assert.deepEqual((await state(page)).pending,{type:'look-replace',id:'look-2'});
    assert.equal(await preview.locator('.confirm-look-label').innerText(),'Look 2');
    assert.equal(await preview.locator('.character').evaluate(e=>getComputedStyle(e).getPropertyValue('--fabric')),targetFabric,'replacement shows the old saved outfit that will be replaced');
    await assertLayout(page,'replace-look-confirmation');
    await click(page,'confirm');
    const replaced=(await state(page)).fashion.looks;
    assert.equal(replaced[1].outfit.color,'plum');assert.deepEqual(replaced[0],original[0]);assert.deepEqual(replaced[2],original[2]);
    await click(page,'undo');assert.deepEqual((await state(page)).fashion.looks,original,'Undo restores the replaced look');
  } finally {await context.close();}
});
