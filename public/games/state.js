// Local Games state. All edits are immutable; rendering, timers and storage live outside this module.
import {createTiles,spawnTile,moveTiles,validTilesBoard,tilesCanMove} from './tiles-engine.js';
import {createConnect4,validConnect4Board,connect4Winner,connect4Winners,dropConnect4,chooseComputerColumn} from './connect4-engine.js';
export {moveTiles,tilesCanMove,connect4Winner,chooseComputerColumn};
export const STORAGE_KEY='era.games.v1';
export const HISTORY_LIMIT=30;
const TOP_VIEWS=['menu','fashion','connect4','tiles','credits'];
const FASHION_VIEWS=['studio','workbench','options','styling','collection','stage','show'];
const POSES=['stand','wave','turn','hands'];
const clone=value=>structuredClone(value);
const integer=(n,lo,hi)=>Number.isSafeInteger(n)&&n>=lo&&n<=hi;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const choices=items=>Object.freeze(items.map(([value,label])=>Object.freeze({value,label})));
export const CATALOG=Object.freeze({
  cut:choices([['tshirt','T-shirt'],['tunic','Tunic'],['dress','Dress'],['hoodie','Hoodie']]),
  sleeves:choices([['short','Short'],['long','Long'],['sleeveless','Sleeveless'],['flutter','Flutter']]),
  color:choices([['teal','Teal'],['coral','Coral'],['plum','Plum'],['sunshine','Sunshine'],['sky','Sky'],['rose','Rose'],['midnight','Midnight'],['mint','Mint']]),
  pattern:choices([['plain','Plain'],['stars','Stars'],['stripes','Stripes'],['dots','Dots'],['flowers','Flowers'],['waves','Waves'],['checks','Checks'],['sparkle','Sparkle']]),
  detail:choices([['none','None'],['pocket','Pocket'],['bow','Bow'],['daisy','Daisy'],['star','Star'],['heart','Heart'],['belt','Belt'],['collar','Collar']]),
  detailPosition:choices([['chest','Chest'],['hem','Hem'],['shoulder','Shoulder'],['waist','Waist']]),
  bottoms:choices([['trousers','Trousers'],['shorts','Shorts'],['skirt','Skirt'],['leggings','Leggings']]),
  shoes:choices([['trainers','Trainers'],['boots','Boots'],['sandals','Sandals'],['flats','Flats']]),
  hair:choices([['bob','Bob'],['curls','Curls'],['braids','Braids'],['short','Short']]),
  model:choices([['warm','Warm'],['deep','Deep'],['light','Light'],['olive','Olive']]),
  venue:choices([['studio','Studio'],['garden','Garden'],['moonlight','Moonlight'],['theatre','Theatre']]),
  music:choices([['none','No music'],['pulse','Pulse'],['glow','Glow'],['drift','Drift']]),
});
const catalogValue=(field,value)=>Object.hasOwn(CATALOG,field)&&CATALOG[field].some(x=>x.value===value);
const OUTFIT_FIELDS=['cut','sleeves','color','pattern','detail','detailPosition','bottoms','shoes','hair','model'];
const freshDraft=()=>({cut:'tshirt',sleeves:'short',color:'teal',pattern:'plain',detail:'none',detailPosition:'chest',bottoms:'trousers',shoes:'trainers',hair:'bob',model:'warm'});
const freshShow=()=>({index:0,phase:'ready',pose:'stand',paused:false,encores:0});
const freshFashion=()=>({view:'studio',draft:freshDraft(),looks:[],selectedLookId:null,lineup:[],stage:{venue:'studio',music:'none'},show:freshShow(),editField:null,optionPage:0,optionReturnView:'workbench',nextLookId:1,history:[]});
export function createState(){return {version:1,view:'menu',paused:false,hidden:false,pending:null,fashion:freshFashion(),connect4:createConnect4(),tiles:createTiles()};}

function outfit(raw) {
  if(!object(raw)||!OUTFIT_FIELDS.every(field=>catalogValue(field,raw[field])))throw Error('Invalid outfit');
  return Object.fromEntries(OUTFIT_FIELDS.map(field=>[field,raw[field]]));
}

function fashionSnapshot(raw) {
  if(!object(raw)||!FASHION_VIEWS.includes(raw.view)||!Array.isArray(raw.looks)||raw.looks.length>3||
    !Array.isArray(raw.lineup)||raw.lineup.length>3||!integer(raw.nextLookId,1,999999999))throw Error('Invalid fashion collection');
  const looks=raw.looks.map(look=>{
    if(!object(look)||typeof look.id!=='string'||!/^look-[1-9]\d{0,8}$/.test(look.id))throw Error('Invalid look identity');
    return {id:look.id,outfit:outfit(look.outfit)};
  });
  const ids=looks.map(look=>look.id);
  if(new Set(ids).size!==ids.length||ids.some(id=>Number(id.slice(5))>=raw.nextLookId)||
    (raw.selectedLookId!==null&&!ids.includes(raw.selectedLookId))||
    raw.lineup.some(id=>!ids.includes(id))||new Set(raw.lineup).size!==raw.lineup.length)throw Error('Invalid collection reference');
  if(!object(raw.stage)||!catalogValue('venue',raw.stage.venue)||!catalogValue('music',raw.stage.music))throw Error('Invalid stage');
  const show=raw.show;
  if(!object(show)||!integer(show.index,0,Math.max(0,raw.lineup.length-1))||
    !['ready','entrance','hold'].includes(show.phase)||!POSES.includes(show.pose)||
    typeof show.paused!=='boolean'||!integer(show.encores,0,999999999)||
    (raw.view==='show'&&!raw.lineup.length))throw Error('Invalid show');
  if(raw.editField!==null&&!OUTFIT_FIELDS.includes(raw.editField))throw Error('Invalid options field');
  if(!['workbench','styling'].includes(raw.optionReturnView)||!integer(raw.optionPage,0,1)||
    (raw.view==='options'&&raw.editField===null)||
    (raw.editField!==null&&raw.optionPage>=Math.ceil(CATALOG[raw.editField].length/4)))throw Error('Invalid options page');
  return {view:raw.view,draft:outfit(raw.draft),looks,selectedLookId:raw.selectedLookId,lineup:raw.lineup.slice(),
    stage:{venue:raw.stage.venue,music:raw.stage.music},show:{index:show.index,phase:show.phase,pose:show.pose,paused:show.paused,encores:show.encores},
    editField:raw.editField,optionPage:raw.optionPage,optionReturnView:raw.optionReturnView,nextLookId:raw.nextLookId};
}

function readFashion(raw) {
  const result=fashionSnapshot(raw);
  if(!Array.isArray(raw.history)||raw.history.length>HISTORY_LIMIT)throw Error('Invalid fashion recovery');
  return {...result,history:raw.history.map(fashionSnapshot)};
}

function connectSnapshot(raw) {
  if(!object(raw)||!validConnect4Board(raw.board)||!['local','computer'].includes(raw.mode)||
    ![1,2].includes(raw.turn)||!['playing','won','draw'].includes(raw.status)||![0,1,2].includes(raw.winner)||
    typeof raw.pendingComputer!=='boolean')throw Error('Invalid Four in a Row');
  const board=raw.board.map(row=>row.slice());let one=0,two=0;
  for(let c=0;c<7;c++){let gap=false;for(let r=5;r>=0;r--){const n=board[r][c];if(!n)gap=true;else if(gap)throw Error('Floating counter');if(n===1)one++;if(n===2)two++;}}
  const winners=connect4Winners(board),winner=winners[0]||0,full=one+two===42;
  if(!(one===two||one===two+1)||winners.length>1||(winner===1&&one!==two+1)||(winner===2&&one!==two))throw Error('Invalid turn count');
  const status=winner?'won':full?'draw':'playing';
  const turn=status==='playing'?(one===two?1:2):winner||2;
  if(raw.status!==status||raw.winner!==winner||raw.turn!==turn||
    raw.pendingComputer!==(raw.mode==='computer'&&status==='playing'&&turn===2))throw Error('Invalid game outcome');
  // A winning board must admit a legal final winning counter.
  if(winner&&!Array.from({length:7},(_,c)=>c).some(c=>{const r=board.findIndex(row=>row[c]!==0);if(r<0||board[r][c]!==winner)return false;const previous=board.map(row=>row.slice());previous[r][c]=0;return !connect4Winner(previous);} ))throw Error('Counters after a win');
  return {board,turn,mode:raw.mode,status,winner,pendingComputer:raw.pendingComputer};
}

function readConnect4(raw) {
  const result=connectSnapshot(raw);
  if(!Array.isArray(raw.history)||raw.history.length>42)throw Error('Invalid counter recovery');
  return {...result,history:raw.history.map(connectSnapshot)};
}

function tilesSnapshot(raw) {
  if(!object(raw)||!validTilesBoard(raw.board)||!integer(raw.score,0,Number.MAX_SAFE_INTEGER)||
    !integer(raw.rng,0,0xffffffff)||typeof raw.won!=='boolean'||typeof raw.over!=='boolean')throw Error('Invalid Number Tiles');
  return {board:raw.board.map(row=>row.slice()),score:raw.score,rng:raw.rng,
    won:raw.won||raw.board.some(row=>row.some(n=>n>=2048)),over:!tilesCanMove(raw.board)};
}

function readTiles(raw) {
  const result=tilesSnapshot(raw);
  if(!Array.isArray(raw.history)||raw.history.length>HISTORY_LIMIT)throw Error('Invalid tiles recovery');
  return {...result,history:raw.history.map(tilesSnapshot)};
}

function canonical(raw,{restore=false}={}) {
  if(!object(raw)||raw.version!==1||!TOP_VIEWS.includes(raw.view))throw Error('Unsupported saved Games state');
  return {version:1,view:raw.view,paused:restore?false:typeof raw.paused==='boolean'?raw.paused:false,
    hidden:restore?false:typeof raw.hidden==='boolean'?raw.hidden:false,pending:null,
    fashion:readFashion(raw.fashion),connect4:readConnect4(raw.connect4),tiles:readTiles(raw.tiles)};
}

export function readSavedState(raw) {
  try {
    if(typeof raw==='string'&&raw.length>524288)throw Error('Saved Games state is too large');
    return {state:canonical(typeof raw==='string'?JSON.parse(raw):raw,{restore:true}),valid:true,reason:''};
  } catch(error) {return {state:createState(),valid:false,reason:error.message};}
}
export function restoreState(raw){return readSavedState(raw).state;}
export function serializeState(state){return JSON.stringify(canonical(state));}

const snapshot=value=>{const {history,...rest}=value;return clone(rest);};
function fashionChange(s,change) {
  const current=s.fashion, next=change(clone(current));
  if(!next||JSON.stringify(snapshot(next))===JSON.stringify(snapshot(current)))return s;
  const previous=snapshot(current);
  // Undo an applied choice at its workspace, rather than reopening its picker.
  if(previous.view==='options'){previous.view=previous.optionReturnView;previous.editField=null;previous.optionPage=0;}
  return {...s,fashion:{...next,history:[...current.history,previous].slice(-HISTORY_LIMIT)}};
}
function fashionView(s,view){return {...s,fashion:{...s.fashion,view,editField:null,optionPage:0}};}
const active=s=>!s.paused&&!s.hidden;
const showActive=s=>s.view==='fashion'&&s.fashion.view==='show'&&active(s)&&!s.fashion.show.paused;
const request=(s,pending)=>({...s,pending});

function playCounter(s,column,computer=false) {
  const current=s.connect4;
  if(!active(s)||s.view!=='connect4'||current.status!=='playing'||
    (computer?!current.pendingComputer:current.pendingComputer))return s;
  const board=dropConnect4(current.board,column,current.turn);if(!board)return s;
  const winner=connect4Winner(board),status=winner?'won':board[0].every(Boolean)?'draw':'playing';
  const turn=status==='playing'?3-current.turn:current.turn;
  return {...s,connect4:{...current,board,turn,status,winner,
    pendingComputer:current.mode==='computer'&&status==='playing'&&turn===2,
    history:computer?current.history:[...current.history,snapshot(current)].slice(-42)}};
}

function confirm(s) {
  const pending=s.pending;if(!pending)return s;
  const base={...s,pending:null};
  if(pending.type==='restart')return pending.game==='connect4'?{...base,connect4:createConnect4(s.connect4.mode)}:
    pending.game==='tiles'?{...base,tiles:createTiles(s.tiles.rng)}:base;
  if(pending.type==='connect4-mode')return {...base,connect4:createConnect4(pending.mode)};
  if(pending.type==='look-delete')return fashionChange(base,f=>{
    f.looks=f.looks.filter(look=>look.id!==pending.id);f.lineup=f.lineup.filter(id=>id!==pending.id);
    f.selectedLookId=f.looks[0]?.id||null;f.view='collection';f.show=freshShow();return f;});
  if(pending.type==='look-replace')return fashionChange(base,f=>{
    const look=f.looks.find(look=>look.id===pending.id);if(!look)return null;
    look.outfit=clone(f.draft);f.selectedLookId=look.id;f.view='collection';return f;});
  return base;
}

export function reduce(s,action) {
  if(!object(action)||typeof action.type!=='string')return s;
  const {type,value}=action;
  if(type==='suspend'&&typeof value==='boolean')return s.paused===value?s:{...s,paused:value};
  if(type==='hidden'&&typeof value==='boolean')return s.hidden===value?s:{...s,hidden:value};
  if(type==='cancel')return s.pending?{...s,pending:null}:s;
  if(type==='confirm')return active(s)?confirm(s):s;
  if(s.pending||!active(s))return s;
  if(type==='open'&&TOP_VIEWS.includes(value))return s.view===value?s:{...s,view:value};
  if(type==='back') {
    if(s.view!=='fashion')return s.view==='menu'?s:{...s,view:'menu'};
    const f=s.fashion;
    if(f.view==='options')return fashionView(s,f.optionReturnView);
    if(f.view==='show')return fashionView(s,'stage');
    if(f.view==='stage')return fashionView(s,'collection');
    if(f.view!=='studio')return fashionView(s,'studio');
    return {...s,view:'menu'};
  }
  if(type==='undo') {
    const key=s.view==='fashion'?'fashion':s.view==='connect4'?'connect4':s.view==='tiles'?'tiles':null;
    if(!key||!s[key].history.length)return s;
    const history=s[key].history.slice(),previous=clone(history.pop());
    return {...s,[key]:{...previous,history}};
  }
  if(type==='restart'&&['connect4','tiles'].includes(s.view))return request(s,{type:'restart',game:s.view});
  if(s.view==='connect4') {
    if(type==='connect4-mode'&&['local','computer'].includes(value)&&value!==s.connect4.mode)
      return s.connect4.board.some(row=>row.some(Boolean))?request(s,{type:'connect4-mode',mode:value}):{...s,connect4:createConnect4(value)};
    if(type==='connect4-drop')return playCounter(s,value);
    if(type==='connect4-computer')return playCounter(s,chooseComputerColumn(s.connect4.board),true);
    return s;
  }
  if(s.view==='tiles') {
    if(type!=='tiles-move'||s.tiles.over)return s;
    const moved=moveTiles(s.tiles.board,value);if(!moved.moved)return s;
    const spawned=spawnTile(moved.board,s.tiles.rng);
    const score=s.tiles.score+moved.score;if(!Number.isSafeInteger(score))return s;
    return {...s,tiles:{...s.tiles,...spawned,score,won:s.tiles.won||moved.board.some(row=>row.some(n=>n>=2048)),
      over:!tilesCanMove(spawned.board),history:[...s.tiles.history,snapshot(s.tiles)].slice(-HISTORY_LIMIT)}};
  }
  if(s.view!=='fashion')return s;
  const f=s.fashion;
  if(type==='fashion-view'&&['studio','workbench','styling','collection'].includes(value))return fashionView(s,value);
  if(type==='fashion-collection')return fashionView(s,'collection');
  if(type==='fashion-edit'&&OUTFIT_FIELDS.includes(value))return {...s,fashion:{...f,view:'options',editField:value,optionPage:0,optionReturnView:f.view==='styling'?'styling':'workbench'}};
  if(type==='option-page'&&f.view==='options'&&[1,-1].includes(value)) {
    const page=f.optionPage+value,max=Math.ceil(CATALOG[f.editField].length/4)-1;
    return page<0||page>max?s:{...s,fashion:{...f,optionPage:page}};
  }
  if(type==='option'&&f.view==='options'&&catalogValue(f.editField,value)) {
    const next=fashionChange(s,next=>{next.draft[f.editField]=value;return next;});
    return fashionView(next,f.optionReturnView);
  }
  if(type==='fashion-save') {
    if(f.looks.length===3)return request(s,{type:'look-replace',id:f.selectedLookId||f.looks[0].id});
    return fashionChange(s,next=>{const id='look-'+next.nextLookId++;next.looks.push({id,outfit:clone(next.draft)});next.selectedLookId=id;next.view='collection';return next;});
  }
  if(type==='look-select'&&f.looks.some(look=>look.id===value))return f.selectedLookId===value?s:{...s,fashion:{...f,selectedLookId:value}};
  const selected=f.looks.find(look=>look.id===(value||f.selectedLookId));
  if(type==='look-edit'&&selected)return fashionChange(s,next=>{next.draft=clone(selected.outfit);next.view='workbench';next.editField=null;next.optionPage=0;return next;});
  if(type==='look-delete'&&selected)return request(s,{type:'look-delete',id:selected.id});
  if(type==='look-replace'&&selected)return request(s,{type:'look-replace',id:selected.id});
  if(type==='look-restore')return reduce(s,{type:'undo'});
  if(type==='lineup-add'&&selected&&!f.lineup.includes(selected.id)&&f.lineup.length<3)
    return fashionChange(s,next=>{next.lineup.push(selected.id);next.show=freshShow();return next;});
  if(type==='lineup-remove'&&f.lineup.includes(value))return fashionChange(s,next=>{next.lineup=next.lineup.filter(id=>id!==value);next.show=freshShow();return next;});
  if(['lineup-up','lineup-down'].includes(type)) {
    const index=f.lineup.indexOf(value||f.selectedLookId),target=index+(type==='lineup-up'?-1:1);
    if(index<0||target<0||target>=f.lineup.length)return s;
    return fashionChange(s,next=>{[next.lineup[index],next.lineup[target]]=[next.lineup[target],next.lineup[index]];next.show=freshShow();return next;});
  }
  if(type==='stage')return fashionView(s,'stage');
  if(['venue','music'].includes(type)&&catalogValue(type,value))return fashionChange(s,next=>{next.stage[type]=value;return next;});
  if(type==='show-start'&&f.lineup.length)return {...s,fashion:{...f,view:'show',show:{...freshShow(),phase:'entrance'}}};
  if(type==='show-pause'&&f.view==='show')return {...s,fashion:{...f,show:{...f.show,paused:!f.show.paused}}};
  if(!showActive(s))return s;
  if(type==='show-arrived'&&f.show.phase==='entrance')return {...s,fashion:{...f,show:{...f.show,phase:'hold'}}};
  if(type==='show-next')return {...s,fashion:{...f,show:{...f.show,index:(f.show.index+1)%f.lineup.length,phase:'entrance',pose:'stand'}}};
  if(type==='show-pose'&&(value===undefined||POSES.includes(value)))return {...s,fashion:{...f,show:{...f.show,phase:'hold',pose:value||POSES[(POSES.indexOf(f.show.pose)+1)%POSES.length]}}};
  if(type==='show-encore')return {...s,fashion:{...f,show:{...freshShow(),phase:'entrance',encores:Math.min(999999999,f.show.encores+1)}}};
  return s;
}
