const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  for (const vp of [{w:1920,h:1080},{w:1280,h:720}]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    await ctx.route('**/log', r => r.fulfill({ status: 204, body: '' }));
    await ctx.route('**/voices', r => r.fulfill({ status: 200, contentType:'application/json', body: '{"enabled":false,"voices":[]}' }));
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:8377/pencil/');
    await page.evaluate(() => { localStorage.clear(); S.tts=false; showScreen('page'); renderGroups(); S.partial='ba'; renderText(); });
    await page.waitForTimeout(300);
    const out = await page.evaluate(() => {
      const g = s => { const el = document.querySelector(s); if(!el) return null; const r = el.getBoundingClientRect();
        return [s, Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
      const chips = [...document.querySelectorAll('.pword')].map(el=>{const r=el.getBoundingClientRect();return [el.textContent,Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)];});
      return { paper: g('#paper'), predict: g('#predict'), keys: g('#keys'), utils: g('#utils'),
        door: g('#door'), clearAll: g('#clearAll'), chips,
        keyrow0kid: g('.keyrow .key') };
    });
    console.log(vp.w+'x'+vp.h, JSON.stringify(out, null, 1));
    await ctx.close();
  }
  await browser.close();
})();
