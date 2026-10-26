import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY, CATALOG, createState, readSavedState, restoreState, serializeState, reduce,
  connect4Winner, chooseComputerColumn, moveTiles } from '../public/games/state.js';

const act = (s,type,value) => reduce(s,{type,value});
const fashion = () => act(createState(),'open','fashion');
const connect = () => act(createState(),'open','connect4');
const tiles = () => act(createState(),'open','tiles');
const clone = s => structuredClone(s);
const empty = () => Array.from({length:6},()=>Array(7).fill(0));
const saved = (s,color) => {
  s=act(s,'fashion-edit','color'); s=act(s,'option',color);
  return act(s,'fashion-save');
};

test('versioned independent workspaces and immutable catalog defaults', () => {
  const s=createState(), t=createState();
  assert.equal(STORAGE_KEY,'era.games.v1');
  assert.equal(s.version,1); assert.equal(s.view,'menu');
  assert.equal(s.fashion.looks.length,0);
  assert.equal(s.connect4.board.length,6); assert.equal(s.tiles.board.flat().filter(Boolean).length,2);
  s.fashion.draft.color='coral'; assert.equal(t.fashion.draft.color,'teal');
  for(const field of Object.keys(t.fashion.draft)) {
    assert.ok(CATALOG[field].some(x=>x.value===t.fashion.draft[field]));
    assert.ok(Object.isFrozen(CATALOG[field]));
  }
});

test('fashion options apply one selected value, return predictably and undo', () => {
  let s=act(fashion(),'fashion-view','workbench'); const before=clone(s);
  s=act(s,'fashion-edit','pattern'); assert.equal(s.fashion.view,'options');
  s=act(s,'option-page',1); assert.equal(s.fashion.optionPage,1);
  s=act(s,'option','stars'); assert.equal(s.fashion.draft.pattern,'stars');
  assert.equal(s.fashion.view,'workbench'); assert.deepEqual(before.fashion.draft,createState().fashion.draft);
  s=act(s,'undo'); assert.equal(s.fashion.draft.pattern,'plain');
  assert.equal(s.fashion.view,'workbench','undo stays at the completed edit destination');
  const original=clone(s); assert.equal(act(s,'option','<img>'),s);
  assert.equal(act(s,'fashion-edit','url'),s); assert.deepEqual(s,original);
});

test('styling fields use the same validated choices without changing other garments', () => {
  let s=act(fashion(),'fashion-view','styling');
  s=act(s,'fashion-edit','hair'); s=act(s,'option','braids');
  assert.equal(s.fashion.view,'styling'); assert.equal(s.fashion.draft.hair,'braids');
  assert.equal(s.fashion.draft.cut,'tshirt');
});

test('three looks are independent snapshots and editing starts a copy', () => {
  let s=saved(fashion(),'coral'); const first=s.fashion.looks[0].id;
  s=saved(s,'plum'); s=saved(s,'sky'); assert.equal(s.fashion.looks.length,3);
  s=act(s,'look-select',first); s=act(s,'look-edit');
  s=act(act(s,'fashion-edit','color'),'option','sunshine');
  assert.equal(s.fashion.looks[0].outfit.color,'coral');
  const before=clone(s); s=act(s,'fashion-save');
  assert.equal(s.pending.type,'look-replace'); assert.deepEqual(s.fashion.looks,before.fashion.looks);
  s=act(s,'cancel'); assert.equal(s.pending,null); assert.equal(s.fashion.looks[0].outfit.color,'coral');
  s=act(act(s,'look-replace'),'confirm');
  assert.equal(s.fashion.looks[0].outfit.color,'sunshine');
  s=act(s,'undo'); assert.equal(s.fashion.looks[0].outfit.color,'coral');
});

test('confirmed deletion and bounded persistent recovery preserve a collection', () => {
  let s=saved(fashion(),'coral'); const id=s.fashion.looks[0].id;
  s=act(s,'lineup-add',id); s=act(s,'look-delete');
  assert.equal(s.fashion.looks.length,1); assert.equal(s.pending.type,'look-delete');
  s=act(s,'confirm'); assert.equal(s.fashion.looks.length,0); assert.deepEqual(s.fashion.lineup,[]);
  s=restoreState(serializeState(s)); s=act(s,'undo');
  assert.equal(s.fashion.looks[0].id,id); assert.deepEqual(s.fashion.lineup,[id]);
  for(let i=0;i<90;i++)s=act(act(s,'fashion-edit','color'),'option',i%2?'coral':'plum');
  assert.ok(s.fashion.history.length<=30);
});

test('lineup has stable identities, deliberate reorder and immutable show position', () => {
  let s=saved(saved(fashion(),'coral'),'plum'); const [a,b]=s.fashion.looks.map(x=>x.id);
  s=act(act(s,'lineup-add',a),'lineup-add',b); assert.equal(act(s,'lineup-add',a),s);
  s=act(s,'lineup-up',b); assert.deepEqual(s.fashion.lineup,[b,a]);
  s=act(s,'lineup-down',b); assert.deepEqual(s.fashion.lineup,[a,b]);
  s=act(s,'stage'); s=act(s,'venue','garden'); s=act(s,'show-start');
  assert.equal(s.fashion.view,'show'); assert.equal(s.fashion.show.phase,'entrance');
  s=act(s,'show-arrived'); assert.equal(s.fashion.show.phase,'hold');
  s=act(s,'show-pose','wave'); assert.equal(s.fashion.show.pose,'wave');
  const before=clone(s); let paused=act(s,'suspend',true);
  assert.equal(act(paused,'show-next'),paused); assert.equal(act(paused,'show-arrived'),paused);
  paused=act(paused,'suspend',false); assert.deepEqual(paused,before);
  s=act(s,'show-next'); assert.equal(s.fashion.show.index,1);
  s=act(s,'show-arrived'); s=act(s,'show-pause'); assert.equal(act(s,'show-next'),s);
  s=act(s,'show-pause'); s=act(s,'show-encore'); assert.equal(s.fashion.show.index,0);
  assert.equal(s.fashion.show.phase,'entrance'); assert.deepEqual(s.fashion.lineup,[a,b]);
});

test('local storage round trip keeps canonical progress and discards unknown properties', () => {
  let s=saved(fashion(),'coral'); s.secret='<script>'; s.fashion.draft.url='https://invalid.test';
  const round=restoreState(serializeState(s));
  assert.equal(round.fashion.looks[0].outfit.color,'coral');
  assert.equal(Object.hasOwn(round,'secret'),false); assert.equal(Object.hasOwn(round.fashion.draft,'url'),false);
  round.fashion.looks[0].outfit.color='sky'; assert.equal(s.fashion.looks[0].outfit.color,'coral');
  for(const bad of [null,'{',[],{version:2},'<script>','x'.repeat(600000)])
    assert.deepEqual(restoreState(bad),createState());
});

test('saved state rejects malformed catalogs, boards, references and unbounded histories', () => {
  for(const poison of [
    s=>s.fashion.draft.color='<img onerror=1>',
    s=>s.fashion.lineup=['missing'],
    s=>s.fashion.looks=[{id:'look-1',outfit:{}}],
    s=>s.fashion.history=Array(1000).fill({}),
    s=>s.connect4.board[0][0]=1,
    s=>s.tiles.board[0][0]=3,
    s=>s.tiles.rng=-1,
    s=>s.tiles.board[0]=Array(4),
    s=>s.connect4.board[0]=Array(7),
    s=>s.tiles.history=Array(1000).fill({}),
  ]){const s=createState();poison(s);assert.deepEqual(restoreState(s),createState());}
});

test('reload cancels transient Talk/hidden/pending state without losing drafts or game progress', () => {
  let s=saved(fashion(),'coral');s=act(s,'open','connect4');s=act(s,'connect4-drop',0);
  s=act(s,'restart');s=act(s,'suspend',true);s=act(s,'hidden',true);
  const restored=restoreState(serializeState(s));
  assert.equal(restored.paused,false);assert.equal(restored.hidden,false);assert.equal(restored.pending,null);
  assert.equal(restored.fashion.looks[0].outfit.color,'coral');
  assert.equal(restored.connect4.board[5][0],1);
  assert.equal(act(restored,'connect4-drop',1).connect4.board[5][1],2);
  const invalid=readSavedState('{');assert.equal(invalid.valid,false);assert.ok(invalid.reason);
  assert.equal(readSavedState(serializeState(restored)).valid,true);
  const broken=clone(restored);broken.fashion.draft.cut='<script>';
  assert.throws(()=>serializeState(broken),'invalid live state must not silently become empty progress');
});

test('connect four applies gravity and rejects unavailable columns without changing state', () => {
  let s=connect(); const before=clone(s);
  for(let i=0;i<6;i++)s=act(s,'connect4-drop',0);
  assert.deepEqual(s.connect4.board.map(r=>r[0]),[2,1,2,1,2,1]);
  assert.equal(act(s,'connect4-drop',0),s); assert.equal(act(s,'connect4-drop',7),s);
  assert.equal(act(s,'connect4-drop','0'),s); assert.deepEqual(before,connect());
  s=act(s,'undo'); assert.equal(s.connect4.board[0][0],0); assert.equal(s.connect4.turn,2);
});

test('connect four identifies vertical, horizontal and both diagonal wins', () => {
  for(const [r,c,dr,dc] of [[5,0,0,1],[5,0,-1,0],[5,0,-1,1],[2,0,1,1]]){
    const board=empty(); for(let i=0;i<4;i++)board[r+i*dr][c+i*dc]=2;
    assert.equal(connect4Winner(board),2);
  }
  let s=connect(); for(const col of [0,1,0,1,0,1,0])s=act(s,'connect4-drop',col);
  assert.equal(s.connect4.status,'won');assert.equal(s.connect4.winner,1);
  assert.equal(act(s,'connect4-drop',2),s);s=act(s,'undo');assert.equal(s.connect4.status,'playing');
});

test('a full legal nonwinning board is a draw and undo permits its last move again', () => {
  const moves=[0,6,4,1,4,2,1,5,3,1,0,6,0,6,3,5,4,5,1,1,5,0,3,5,0,3,3,2,6,4,0,6,5,4,1,2,3,6,2,2,4,2];
  let s=connect();for(const column of moves)s=act(s,'connect4-drop',column);
  assert.equal(s.connect4.status,'draw');assert.equal(s.connect4.winner,0);
  assert.equal(s.connect4.board.flat().filter(Boolean).length,42);
  assert.equal(readSavedState(serializeState(s)).valid,true);
  assert.equal(act(s,'connect4-drop',0),s);
  const undone=act(s,'undo');assert.equal(undone.connect4.status,'playing');
  assert.deepEqual(act(undone,'connect4-drop',moves.at(-1)).connect4,s.connect4);
});

test('computer prioritizes a win, then block, then center and never uses full columns', () => {
  let board=empty(); board[5]=[2,2,2,0,1,1,1];assert.equal(chooseComputerColumn(board),3);
  board=empty();board[5]=[1,1,1,0,0,0,0];assert.equal(chooseComputerColumn(board),3);
  assert.equal(chooseComputerColumn(empty()),3);
  board=Array.from({length:6},()=>Array(7).fill(1));assert.equal(chooseComputerColumn(board),null);
});

test('computer move is a separate action, cannot run hidden, paused or outside its game', () => {
  let s=act(connect(),'connect4-mode','computer');
  s=act(s,'connect4-drop',0);assert.equal(s.connect4.pendingComputer,true);
  assert.equal(act(s,'connect4-drop',1),s);
  let p=act(s,'hidden',true);assert.equal(act(p,'connect4-computer'),p);
  p=act(s,'suspend',true);assert.equal(act(p,'connect4-computer'),p);
  p=act(s,'open','fashion');assert.equal(act(p,'connect4-computer'),p);
  s=act(s,'connect4-computer');assert.equal(s.connect4.board[5][3],2);
  assert.equal(s.connect4.pendingComputer,false);assert.equal(s.connect4.turn,1);
  s=act(s,'undo');assert.equal(s.connect4.board.flat().filter(Boolean).length,0,'undo reverses a complete computer round');
});

test('restart and mode changes require confirmation after play, and cancel is harmless', () => {
  let s=act(connect(),'connect4-drop',0);const board=clone(s.connect4.board);
  s=act(s,'restart');assert.deepEqual(s.connect4.board,board);assert.equal(s.pending.type,'restart');
  assert.equal(act(s,'connect4-drop',1),s);s=act(s,'cancel');assert.deepEqual(s.connect4.board,board);
  s=act(act(s,'restart'),'confirm');assert.equal(s.connect4.board.flat().filter(Boolean).length,0);
  s=act(s,'connect4-drop',0);s=act(s,'connect4-mode','computer');
  assert.equal(s.pending.type,'connect4-mode');s=act(s,'confirm');assert.equal(s.connect4.mode,'computer');
  assert.equal(s.connect4.board.flat().filter(Boolean).length,0);
});

test('2048 merges each tile at most once and preserves directional movement rules', () => {
  const board=[[2,2,2,2],[4,0,4,0],[0,0,0,0],[0,0,0,0]];
  assert.deepEqual(moveTiles(board,'left'),{board:[[4,4,0,0],[8,0,0,0],[0,0,0,0],[0,0,0,0]],score:16,moved:true});
  assert.deepEqual(moveTiles(board,'right').board[0],[0,0,4,4]);
  const vertical=[[2,0,0,0],[2,0,0,0],[2,0,0,0],[2,0,0,0]];
  assert.deepEqual(moveTiles(vertical,'up').board.map(r=>r[0]),[4,4,0,0]);
  assert.deepEqual(moveTiles(vertical,'down').board.map(r=>r[0]),[0,0,4,4]);
  assert.equal(moveTiles(board,'invalid').moved,false);
});

test('2048 legal movement spawns exactly one tile; undo restores random state and replay', () => {
  let s=tiles();s.tiles.board=[[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  const before=clone(s);const next=act(s,'tiles-move','left');
  assert.equal(next.tiles.score,4);assert.equal(next.tiles.board.flat().filter(Boolean).length,2);
  assert.notEqual(next.tiles.rng,s.tiles.rng);assert.deepEqual(s,before);
  const undone=act(next,'undo');assert.deepEqual(undone.tiles,before.tiles);
  assert.deepEqual(act(undone,'tiles-move','left').tiles,next.tiles);
});

test('ineffective 2048 moves do not spawn, consume random state, score or undo history', () => {
  let s=tiles();s.tiles.board=[[2,4,8,16],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  assert.equal(act(s,'tiles-move','left'),s);
  const paused=act(s,'suspend',true);assert.equal(act(paused,'tiles-move','right'),paused);
});

test('2048 winning can continue and its restart remains confirmed', () => {
  let s=tiles();s.tiles.board=[[1024,1024,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  s=act(s,'tiles-move','left');assert.equal(s.tiles.won,true);assert.equal(s.tiles.over,false);
  const continuing=act(s,'tiles-move','right');assert.notEqual(continuing,s);
  const pending=act(continuing,'restart');assert.deepEqual(pending.tiles,continuing.tiles);
  const restarted=act(pending,'confirm');assert.equal(restarted.tiles.score,0);assert.equal(restarted.tiles.won,false);
});

test('full Number Tiles boards identify lack of moves and survive local persistence', () => {
  let s=tiles();s.tiles.board=[[2,4,8,16],[32,64,128,256],[512,1024,2,4],[8,16,32,64]];
  s=restoreState(serializeState(s));assert.equal(s.tiles.over,true);
  for(const direction of ['up','down','left','right'])assert.equal(act(s,'tiles-move',direction),s);
  assert.equal(readSavedState(serializeState(s)).valid,true);
});

test('unknown and offscreen actions are no-ops, and deep-frozen state remains usable', () => {
  const freeze=o=>{if(o&&typeof o==='object'){Object.freeze(o);for(const v of Object.values(o))freeze(v);}return o;};
  const s=freeze(createState()); assert.equal(reduce(s,{type:'unknown'}),s);
  assert.equal(reduce(s,null),s);assert.equal(act(s,'connect4-drop',0),s);
  assert.equal(act(s,'tiles-move','left'),s); assert.equal(act(s,'show-start'),s);
  assert.equal(act(s,'open','fashion').view,'fashion');
});
