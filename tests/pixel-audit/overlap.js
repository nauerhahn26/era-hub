// Rect-INTERSECTION sweep: fixed chrome (door/clear/replay/banner/adult bar) vs
// every visible content element, full rectangles not centers. Both apps, key states.
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const SWEEP = async (page, name) => {
  const hits = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.05; };
    const chrome = ['door','clearAll','replay','ttsWarn','adultBar','partnerTab']
      .map(id => document.getElementById(id)).filter(e => e && vis(e));
    const content = [...document.querySelectorAll('#paper,#predict .pword,#keys .key,#utils .util,#prompt > div,#slots .slot,#model .m,#tray .letter,.colhead,#sortword,#sortMethod,#alsoMade,.title,.subtitle,.action,#big')]
      .filter(vis);
    const out = [];
    for (const c of chrome) {
      const a = c.getBoundingClientRect();
      for (const el of content) {
        if (c.contains(el) || el.contains(c)) continue;
        const b = el.getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 2 && oy > 2) out.push(c.id + ' ∩ ' + (el.id || el.className.split(' ')[0]) + ' by ' + Math.round(ox) + 'x' + Math.round(oy));
      }
    }
    return out;
  });
  if (hits.length) { bad += hits.length; console.log('OVERLAP', name, JSON.stringify(hits)); }
  else console.log('clean  ', name);
};
(async () => {
  const b = await chromium.launch();
  for (const vp of [{width:1920,height:1080},{width:1280,height:720}]) {
    const page = await b.newPage({ viewport: vp });
    for (const u of ['**/log','**/runway']) await page.route(u, r => r.fulfill({status:204,body:''}));
    await page.route('**/voices', r => r.fulfill({status:200,contentType:'application/json',body:'{"enabled":false,"voices":[]}'}));
    await page.route('**/tts', r => r.fulfill({status:503,body:''}));
    // PENCIL states
    await page.goto('http://127.0.0.1:8377/pencil/'); await sleep(700);
    await SWEEP(page, `pencil-start ${vp.width}`);
    await page.evaluate(() => { S.tts=false; showScreen('page'); renderGroups();
      S.words=['my','favorite','sparkly','dress']; S.partial='ba'; renderText(); });
    await sleep(400); await SWEEP(page, `pencil-typing ${vp.width}`);
    await page.evaluate(() => openGroup(2)); await sleep(300); await SWEEP(page, `pencil-letters ${vp.width}`);
    await page.evaluate(() => { document.getElementById('confirmSub').textContent='"my favorite sparkly dress ba"'; showScreen('sConfirm'); });
    await sleep(300); await SWEEP(page, `pencil-confirm ${vp.width}`);
    // caret spacing check
    await page.evaluate(() => { showScreen('page'); renderText(); });
    const caretGap = await page.evaluate(() => {
      const partial = document.querySelector('#text .partial');
      const caret = document.getElementById('caret');
      if (!partial || !caret) return -1;
      return Math.round(caret.getBoundingClientRect().left - partial.getBoundingClientRect().right);
    });
    console.log(`caret gap after partial (${vp.width}):`, caretGap, 'px', caretGap <= 6 ? 'OK' : 'TOO WIDE'); if (caretGap > 6) bad++;
    // STUDIO states
    await page.goto('http://127.0.0.1:8377/'); await sleep(900);
    await SWEEP(page, `studio-start ${vp.width}`);
    await page.evaluate(async () => {
      const db = await (await fetch('lessons.json')).json();
      S.lesson = db.lessons.find(l=>l.lesson===69); S.tts=false;
      document.getElementById('adultBar').style.display='none'; show('stage'); buildTray(S.lesson.letters, true); S.wordIdx=0; await startMakeWord();
    });
    await sleep(400); await SWEEP(page, `studio-make-L69 ${vp.width}`);
    await page.evaluate(async () => { S.sortIdx = 0; await startSort(); });
    await sleep(500); await SWEEP(page, `studio-sort ${vp.width}`);
    await page.close();
  }
  await b.close();
  console.log(bad ? `\n${bad} OVERLAPS FOUND` : '\nALL CLEAN');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(2); });
