// Math exploration: quantities, conservation and reversible navigation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, restoreState, serializeState, navigate, step, transfer,
  selectNumber, numberWord, quantityGroups, pickerNumbers } from '../public/math/state.js';

const numbers = () => navigate(createState(), 'numbers');
const partners = () => navigate(createState(), 'partners');
const picked = (s, n) => selectNumber(navigate(s, 'pick'), n);
const math = s => ({ number:s.number, whole:s.whole, left:s.left });

test('new math exploration offers the menu with independent workspace quantities', () => {
  const s = createState();
  assert.equal(s.version, 1);
  assert.equal(s.view, 'menu');
  assert.deepEqual(math(s), { number:7, whole:7, left:3 });
  assert.notEqual(createState(), s, 'each exploration owns its state');
});

test('one more and one fewer change exactly one unit, with no wrap at zero or fifty', () => {
  for (let n=0;n<=50;n++) {
    const s = picked(numbers(), n), before = structuredClone(s);
    const up=step(s,1), down=step(s,-1);
    assert.equal(up.number, Math.min(50,n+1), `more at ${n}`);
    assert.equal(down.number, Math.max(0,n-1), `fewer at ${n}`);
    assert.deepEqual(s,before,'updates do not mutate the caller');
    assert.deepEqual([up.whole,up.left],[s.whole,s.left]);
    if(n<50) assert.equal(step(up,-1).number,n);
    if(n>0) assert.equal(step(down,1).number,n);
  }
  const s=numbers();
  for(const bad of [0,2,-2,NaN,Infinity,'1',null]) assert.deepEqual(step(s,bad),s);
  assert.deepEqual(step(partners(),1),partners(),'ordinary quantity changes cannot change a fixed whole');
});

test('every partition of every whole through twenty transfers one counter and conserves the whole', () => {
  for(let whole=0;whole<=20;whole++) {
    let s=picked(partners(),whole);
    for(let i=0;i<whole;i++)s=transfer(s,'right');
    assert.equal(s.left,0);
    assert.deepEqual(transfer(s,'right'),s,'zero left part cannot go negative');
    for(let left=0;left<=whole;left++) {
      const before=structuredClone(s);
      assert.equal(s.whole,whole);
      assert.equal(s.left,left);
      assert.equal(s.left+(s.whole-s.left),whole);
      const next=transfer(s,'left');
      assert.equal(next.left,Math.min(whole,left+1));
      assert.equal(next.whole,whole);
      assert.equal(next.number,7,'the separate Numbers workspace is preserved');
      assert.deepEqual(s,before);
      if(left<whole) assert.deepEqual(transfer(next,'right'),s);
      s=next;
    }
    assert.deepEqual(transfer(s,'left'),s,'zero right part cannot go negative');
  }
  assert.deepEqual(transfer(numbers(),'left'),numbers());
  assert.deepEqual(transfer(partners(),'up'),partners());
});

test('structured collections contain exactly the quantity, including an empty zero frame', () => {
  for(let n=0;n<=50;n++) {
    const groups=quantityGroups(n);
    assert.equal(groups.reduce((a,b)=>a+b,0),n);
    assert.ok(groups.every(g=>Number.isInteger(g)&&g>=0&&g<=10));
    assert.ok(groups.length<=5);
    for(const full of groups.slice(0,-1))assert.equal(full,10,'full tens precede the remainder');
  }
  assert.deepEqual(quantityGroups(0),[0]);
  assert.deepEqual(quantityGroups(23),[10,10,3]);
  assert.deepEqual(quantityGroups(50),[10,10,10,10,10]);
  for(const [n,w] of [[0,'zero'],[7,'seven'],[10,'ten'],[14,'fourteen'],[20,'twenty'],[21,'twenty one'],[40,'forty'],[50,'fifty']])
    assert.equal(numberWord(n).replaceAll('-',' '),w);
});

test('Numbers keeps decade seats while partners offers zero through ten, then eleven through twenty', () => {
  for(let start=0;start<=50;start+=10) {
    const seats=pickerNumbers(start,'numbers');
    assert.equal(seats.length,10);
    for(let i=0;i<10;i++)assert.equal(seats[i],start+i<=50?start+i:null);
  }
  assert.deepEqual(pickerNumbers(0,'partners'),[0,1,2,3,4,5,6,7,8,9,10]);
  assert.deepEqual(pickerNumbers(11,'partners'),[11,12,13,14,15,16,17,18,19,20]);
});

test('range browsing and both cancel paths preserve an unusual partition and the other workspace', () => {
  let s=picked(numbers(),42);
  s=navigate(navigate(s,'back'),'partners');
  s=transfer(transfer(s,'left'),'left');
  assert.equal(s.left,5);
  const original=structuredClone(s);
  s=navigate(s,'pick');
  assert.equal(s.view,'picker');
  assert.equal(s.returnView,'partners');
  s=navigate(s,'ranges');
  assert.equal(s.view,'picker');
  assert.equal(s.rangeStart,11,'Other numbers opens the second page directly');
  assert.deepEqual(math(s),math(original));
  s=navigate(s,'back');
  assert.equal(s.view,'partners');
  assert.deepEqual(math(s),math(original));
  s=navigate(navigate(s,'pick'),'ranges');
  assert.equal(s.view,'picker');
  s=navigate(s,'ranges');
  assert.equal(s.rangeStart,0,'Other numbers returns directly to the first page');
  assert.deepEqual(math(navigate(s,'back')),math(original));
});

test('selection returns to its caller and gives a predictable partition without changing Numbers', () => {
  for(let n=0;n<=20;n++) {
    const s=picked(partners(),n);
    assert.equal(s.view,'partners');
    assert.deepEqual([s.whole,s.left,s.number],[n,Math.floor(n/2),7]);
  }
  const p=navigate(partners(),'pick');
  for(const invalid of [-1,21,50,1.5,NaN,'7',null])assert.deepEqual(selectNumber(p,invalid),p);
  const n=navigate(numbers(),'pick');
  for(const invalid of [-1,51,1.5,NaN,'7',null])assert.deepEqual(selectNumber(n,invalid),n);
  assert.deepEqual(selectNumber(partners(),3),partners(),'a passive displayed numeral is not selection');
});

test('versioned restore preserves both workspaces and a picker cancellation round trip', () => {
  let s=picked(numbers(),49);
  s=navigate(navigate(s,'back'),'partners');
  s=transfer(s,'right');
  s=navigate(navigate(s,'pick'),'ranges');
  const restored=restoreState(serializeState(s));
  assert.deepEqual(restored,s);
  assert.deepEqual(restoreState(structuredClone(s)),s);
  assert.deepEqual(math(navigate(restored,'back')),math(s));
});

test('partners twenty opens its second picker page and persists across workspace and menu transitions', () => {
  let s=picked(partners(),20);
  s=transfer(s,'left');
  const original=math(s);
  s=navigate(s,'pick');
  assert.deepEqual([s.view,s.rangeStart],['picker',11]);
  for(const action of ['back','back','numbers']) {
    s=navigate(s,action);
    assert.deepEqual(restoreState(serializeState(s)),s,'retained partner page is valid after '+action);
    assert.deepEqual(math(s),original);
  }
  s=navigate(s,'pick');
  assert.deepEqual([s.view,s.returnView,s.rangeStart],['picker','numbers',0],'Numbers still opens a decade page');
  const ten=navigate(picked(partners(),10),'pick');
  assert.equal(ten.rangeStart,0,'ten stays on the first partner page');
});

test('legacy partner picker and range states migrate without losing quantities or a partition', () => {
  for(const view of ['picker','ranges','partners','menu']) {
    const old={...createState(),view,number:42,whole:7,left:5,returnView:'partners',rangeStart:10};
    const migrated=restoreState(JSON.stringify(old));
    assert.deepEqual(math(migrated),math(old));
    assert.equal(migrated.rangeStart,0,'legacy lonely ten maps to the first page');
    assert.equal(migrated.view,view==='ranges'?'picker':view);
    assert.deepEqual(restoreState(serializeState(migrated)),migrated);
    if(['picker','ranges'].includes(view))assert.deepEqual(math(navigate(migrated,'back')),math(old));
  }
});

test('malformed, unsupported-version and impossible persisted states fall back safely', () => {
  const d=createState();
  const invalid=[undefined,null,'','{broken','null','[]',{},[],
    {...d,version:0},{...d,version:2},{...d,view:'missing'},
    {...d,number:-1},{...d,number:51},{...d,number:7.5},{...d,number:'7'},
    {...d,whole:21},{...d,whole:-1},{...d,left:-1},{...d,left:8},
    {...d,left:NaN},{...d,returnView:'menu'},{...d,rangeStart:3},
    {...d,view:'picker',returnView:'partners',rangeStart:50}];
  for(const raw of invalid) assert.deepEqual(restoreState(raw),d,JSON.stringify(raw));
});
