// FUNCTIONAL check: at every rect-overlap between partnerTab and a util/letter,
// what does elementFromPoint actually return? Content must win.
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch();
  let bad = 0;
  for (const vp of [{width:1920,height:1080},{width:1280,height:720}]) {
    const page = await b.newPage({ viewport: vp });
    await page.route('**/log', r => r.fulfill({status:204,body:''}));
    await page.route('**/voices', r => r.fulfill({status:200,contentType:'application/json',body:'{"enabled":false,"voices":[]}'}));
    await page.route('**/tts', r => r.fulfill({status:503,body:''}));
    await page.goto('http://127.0.0.1:8377/pencil/'); await sleep(700);
    await page.evaluate(() => { S.tts=false; showScreen('page'); renderGroups(); });
    await sleep(300);
    const res = await page.evaluate(() => {
      const tab = document.getElementById('partnerTab').getBoundingClientRect();
      const out = [];
      for (const u of document.querySelectorAll('#utils .util')) {
        const r = u.getBoundingClientRect();
        const ox = Math.min(tab.right, r.right) - Math.max(tab.left, r.left);
        const oy = Math.min(tab.bottom, r.bottom) - Math.max(tab.top, r.top);
        if (ox > 2 && oy > 2) {
          const px = Math.max(tab.left, r.left) + ox/2, py = Math.max(tab.top, r.top) + oy/2;
          const hit = document.elementFromPoint(px, py);
          out.push({ overlap: Math.round(ox)+'x'+Math.round(oy), winner: hit === u || u.contains(hit) ? 'UTIL (correct)' : (hit.id || hit.className) });
        }
      }
      return out;
    });
    for (const r of res) { console.log(vp.width + ':', r.overlap, '->', r.winner); if (!/correct/.test(r.winner)) bad++; }
    if (!res.length) console.log(vp.width + ': no overlap at all');
    await page.close();
  }
  await b.close();
  console.log(bad ? 'TAPS LOST: ' + bad : 'ALL TAPS WIN CORRECTLY');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(2); });
