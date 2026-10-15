const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  for (const vp of [{w:1920,h:1080},{w:1280,h:720}]) {
    const ctx = await browser.newContext({ viewport: vp.w ? {width:vp.w,height:vp.h} : undefined });
    await ctx.route('**/log', r => r.fulfill({status:204, body:''}));
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:8377/pencil/');
    await page.evaluate(() => { localStorage.clear(); S.tts=false; showScreen('page'); renderGroups();
      S.words=['my','favorite','sparkly','dress','is','beautiful','today']; S.partial=''; renderText(); });
    await page.waitForTimeout(200);
    console.log(vp.w+'x'+vp.h, JSON.stringify(await page.evaluate(() => {
      const p=document.getElementById('paper'), t=document.getElementById('text');
      const cs=getComputedStyle(t);
      const words=[...t.querySelectorAll('.word')].map(w=>({w:w.textContent, top:Math.round(w.getBoundingClientRect().top)}));
      const lines=[...new Set(words.map(w=>w.top))].length;
      return { paperH:p.getBoundingClientRect().height, paperClientH:p.clientHeight,
        textScrollH:t.scrollHeight, font:cs.fontSize, lineH:cs.lineHeight,
        visibleLines:+( (p.clientHeight-44) / (parseFloat(cs.fontSize)*1.3)).toFixed(2),
        totalLines:lines, scrolled:p.scrollTop, hOverflow:t.scrollWidth>t.clientWidth };
    })));
    await ctx.close();
  }
  await browser.close();
})();
