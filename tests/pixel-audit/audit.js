/* Pixel audit for Making Words Studio + The Pencil */
const { chromium } = require('playwright');
const fs = require('fs');
const DIR = '/tmp/claude-1001/-home-claude-aac-board-builder/b6872cea-c339-4522-96d1-9ffa5f2289ba/scratchpad/pixel-audit';

const MEASURE = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width>2 && r.height>2 && cs.display!=="none" && cs.visibility!=="hidden" && r.bottom>0 && r.top<vh && r.right>0 && r.left<vw; };
  const lbl = el => el.id || (el.textContent||'').trim().slice(0,12) || el.className;
  const targets = [...document.querySelectorAll('.dwell')].filter(el => vis(el) && !el.hasAttribute('data-dwell-disabled'));
  const rects = targets.map(el => ({ el, r: el.getBoundingClientRect(), label: lbl(el) }));
  const offscreen = [];
  for (const {r,label} of rects)
    if (r.left < -0.5 || r.top < -0.5 || r.right > vw+0.5 || r.bottom > vh+0.5)
      offscreen.push({label, l:+r.left.toFixed(1), t:+r.top.toFixed(1), r:+r.right.toFixed(1), b:+r.bottom.toFixed(1)});
  const hscroll = document.documentElement.scrollWidth > vw+1 || document.body.scrollWidth > vw+1;
  const occluded = [];
  for (const {el,r,label} of rects) {
    const cx = Math.min(vw-1, Math.max(1,(r.left+r.right)/2)), cy = Math.min(vh-1, Math.max(1,(r.top+r.bottom)/2));
    const top = document.elementsFromPoint(cx, cy)[0];
    if (top && top !== el && !el.contains(top) && !top.contains(el)) occluded.push({label, by: top.id || String(top.className).slice(0,30)});
  }
  let minGap = Infinity, minPair = null; const riskyPairs = [];
  for (let i=0;i<rects.length;i++) for (let j=i+1;j<rects.length;j++) {
    const a = rects[i].r, b = rects[j].r;
    const dx = Math.max(a.left-b.right, b.left-a.right), dy = Math.max(a.top-b.bottom, b.top-a.bottom);
    const d = (dx<0 && dy<0) ? Math.max(dx,dy) : Math.hypot(Math.max(dx,0), Math.max(dy,0));
    if (d < minGap) { minGap = d; minPair = [rects[i].label, rects[j].label]; }
    if (d < 34) riskyPairs.push({a:rects[i].label, b:rects[j].label, gap:+d.toFixed(1)});
  }
  const rows = [];
  const rowEls = [];
  for (const [name,sel] of Object.entries({tray:'#tray',slots:'#slots',model:'#model',predict:'#predict',utils:'#utils'})) {
    const el = document.querySelector(sel); if (el && vis(el) && [...el.children].some(vis)) rowEls.push([name, el]);
  }
  const cols = document.querySelector('#cols');
  if (cols && vis(cols) && cols.children.length) rowEls.push(['sortheads', cols]);
  document.querySelectorAll('.keyrow').forEach((el,i)=>{ if (vis(el)) rowEls.push(['keyrow'+i, el]); });
  document.querySelectorAll('.screen.show .row').forEach((el,i)=>{ if (vis(el) && el.children.length) rowEls.push(['btnrow'+i, el]); });
  for (const [name, el] of rowEls) {
    let kids = [...el.children].filter(vis);
    if (name==='sortheads') kids = [...el.querySelectorAll('.colhead')].filter(vis);
    if (!kids.length) continue;
    const first = kids[0].getBoundingClientRect(), last = kids[kids.length-1].getBoundingClientRect();
    const span = last.right - first.left;
    const k0 = kids[0], kr = k0.getBoundingClientRect();
    let gap = null;
    if (kids.length>1){ const r2 = kids[1].getBoundingClientRect(); gap = +(r2.left - kr.right).toFixed(1); }
    rows.push({ name, n: kids.length, elemW:+kr.width.toFixed(1), elemH:+kr.height.toFixed(1),
      font: +parseFloat(getComputedStyle(k0).fontSize).toFixed(1), gap, span:+span.toFixed(1),
      util: +((span/(vw-120))*100).toFixed(1) });
  }
  const overflow = [];
  document.querySelectorAll('#prompt .text,#prompt .sub,.colhead,.colword,.pword,.slot,.m,.letter,.key .big,.letterkey,.util,.title,.subtitle,#sortword,#text .word,.action,#big,.chip').forEach(el=>{
    if (!vis(el)) return;
    if (el.scrollWidth > el.clientWidth+1) overflow.push({label:(String(el.className)||el.id)+':'+(el.textContent||'').trim().slice(0,16), sw:el.scrollWidth, cw:el.clientWidth});
  });
  const vertOverlap = [];
  const bands = ['#prompt','#model','#sortwordWrap','#slots','#cols','#alsoMade','#tray','#paper','#predict','#keys','#utils']
    .map(s=>document.querySelector(s)).filter(el=>el && vis(el) && (el.children.length || (el.textContent||'').trim()));
  for (let i=0;i<bands.length;i++) for (let j=i+1;j<bands.length;j++) {
    const a=bands[i].getBoundingClientRect(), b=bands[j].getBoundingClientRect();
    const ov = Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
    const hov = Math.min(a.right,b.right)-Math.max(a.left,b.left);
    if (ov>1 && hov>1) vertOverlap.push({a:bands[i].id, b:bands[j].id, overlapPx:+ov.toFixed(1)});
  }
  const belowFold = [];
  document.querySelectorAll('.dwell,.colword,#text,.m').forEach(el=>{
    const cs = getComputedStyle(el); if (cs.display==='none') return;
    const r = el.getBoundingClientRect();
    if (r.height>2 && r.bottom > vh+0.5) belowFold.push({label: el.id||lbl(el), bottom:+r.bottom.toFixed(1)});
  });
  const cssVars = {};
  for (const v of ['--letterSize','--trayGap','--slotW','--slotGap','--colW','--colGap','--colFont'])
    cssVars[v] = document.documentElement.style.getPropertyValue(v) || null;
  return { vw, vh, nTargets: rects.length, offscreen, hscroll, occluded,
    minGap: rects.length>1 ? +minGap.toFixed(1) : null, minPair, riskyPairs, rows, overflow, vertOverlap, belowFold, cssVars };
})()`;

const STUDIO_PRE = `
  const db = await (await fetch('lessons.json')).json();
  const L = n => db.lessons.find(l => l.lesson === n);
  S.tts = false;
  document.getElementById('adultBar').style.display = 'none';
`;

const STATES = [
  { name:'studio-L02-make1-as', url:'/', setup: STUDIO_PRE + `
      S.lesson = L(2); show('stage'); buildTray(S.lesson.letters, true);
      S.wordIdx = 0; await startMakeWord();` },
  { name:'studio-L69-make-saturday', url:'/', setup: STUDIO_PRE + `
      S.lesson = L(69); show('stage'); buildTray(S.lesson.letters, true);
      S.wordIdx = 11; await startMakeWord();` },
  { name:'studio-L58-secret-coats', url:'/', setup: STUDIO_PRE + `
      S.lesson = L(58); show('stage'); buildTray(S.lesson.letters, true);
      await startSecret();` },
  { name:'studio-L41-sort3', url:'/', setup: STUDIO_PRE + `
      S.lesson = L(41); show('stage'); await startSort();` },
  { name:'studio-L41-transfer-jam-model-ram', url:'/', setup: STUDIO_PRE + `
      S.lesson = L(41); show('stage'); await startTransfer();` },
  { name:'studio-L43-sort3', url:'/', setup: STUDIO_PRE + `
      S.lesson = L(43); show('stage'); await startSort();` },
  { name:'studio-L36-sort5', url:'/', setup: STUDIO_PRE + `
      S.lesson = L(36); show('stage'); await startSort();` },
  { name:'studio-L32-transfer-chin', url:'/', setup: STUDIO_PRE + `
      S.lesson = L(32); show('stage'); await startTransfer();` },
  { name:'studio-L02-fix-sand', url:'/', setup: STUDIO_PRE + `
      S.lesson = L(2); show('stage'); buildTray(S.lesson.letters, true);
      S.wordIdx = 6; await startMakeWord();
      await pickLetter('s'); await pickLetter('a'); await pickLetter('d'); await pickLetter('n');` },
  { name:'studio-L22-transfer-thermostat', url:'/', setup: STUDIO_PRE + `
      S.lesson = L(22); S.lesson.transfer = { type:'words', words:['thermostat'] };
      show('stage'); await startTransfer();` },
  { name:'pencil-groups', url:'/pencil/', setup: `
      S.tts = false; showScreen('page'); renderGroups(); renderText();` },
  { name:'pencil-letters-ijklmn', url:'/pencil/', setup: `
      S.tts = false; showScreen('page'); renderGroups(); renderText(); openGroup(2);` },
  { name:'pencil-predict-ba', url:'/pencil/', setup: `
      S.tts = false; showScreen('page'); renderGroups(); S.partial='ba'; renderText();` },
  { name:'pencil-longtext-2line', url:'/pencil/', setup: `
      S.tts = false; showScreen('page'); renderGroups();
      S.words = ['my','favorite','sparkly','dress','is','beautiful','today']; S.partial=''; renderText();` },
  { name:'pencil-send-confirm', url:'/pencil/', setup: `
      S.tts = false; showScreen('page'); renderGroups();
      S.words = ['my','favorite','sparkly','dress','is','beautiful','today']; S.partial=''; renderText();
      await publish();` },
  { name:'pencil-clear-confirm', url:'/pencil/', setup: `
      S.tts = false; showScreen('page'); renderGroups(); renderText(); showScreen('sClearConfirm');` },
];

(async () => {
  const browser = await chromium.launch();
  const results = [];
  for (const vp of [{w:1920,h:1080},{w:1280,h:720}]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    await ctx.route('**/log', r => r.fulfill({ status: 204, body: '' }));
    await ctx.route('**/runway', r => r.fulfill({ status: 204, body: '' }));
    await ctx.route('**/voices', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":false,"voices":[]}' }));
    await ctx.route('**/tts*', r => r.fulfill({ status: 503, body: '' }));
    await ctx.route('**/settings', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await ctx.route('**/publish', r => r.fulfill({ status: 204, body: '' }));
    const page = await ctx.newPage();
    page.on('pageerror', e => console.error('PAGEERROR', e.message));
    for (const st of STATES) {
      try {
        await page.goto('http://127.0.0.1:8377' + st.url, { waitUntil: 'load' });
        await page.evaluate(() => localStorage.clear());
        await page.waitForFunction(() => window.S !== undefined && (!location.pathname.startsWith('/pencil') ? S.lesson !== null : true), null, { timeout: 8000 }).catch(()=>{});
        await page.evaluate(code => eval('(async()=>{' + code + '})()'), st.setup);
        await page.waitForTimeout(400);
        const m = await page.evaluate(MEASURE);
        const shot = `${st.name}_${vp.w}x${vp.h}.png`;
        await page.screenshot({ path: `${DIR}/${shot}` });
        results.push({ state: st.name, viewport: `${vp.w}x${vp.h}`, shot, ...m });
        console.log('OK', st.name, vp.w + 'x' + vp.h, 'minGap=' + m.minGap, 'targets=' + m.nTargets);
      } catch (e) {
        console.error('FAIL', st.name, vp.w + 'x' + vp.h, e.message.slice(0, 300));
        results.push({ state: st.name, viewport: `${vp.w}x${vp.h}`, error: e.message.slice(0, 300) });
      }
    }
    await ctx.close();
  }
  fs.writeFileSync(DIR + '/results.json', JSON.stringify(results, null, 1));
  await browser.close();
  console.log('DONE', results.length, 'measurements');
})();
