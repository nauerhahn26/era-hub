// The real settings DOM, with network boundaries stubbed: navigation must not
// save a setting, start work, or replace a form while it is being edited.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://settings.test';
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });
async function open(fragment = '', width = 1280, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: 860 }, reducedMotion: 'reduce' });
  const writes = [], errors = [];
  const payloads = {
    '/apps': { apps: [{ id: 'reader', title: 'Book Reader', sub: 'books', enabled: true, installed: true }] },
    '/voices': { voices: [], enabled: false }, '/mail-config': { writings: Array.from({length:options.writingCount||0},(_,i)=>({text:'Sample writing '+i})) },
    '/movies/keys': {}, '/fal-key': { perClipPrice: 0.2 },
    '/settings': { dwellMs: 1200, pencilDwellMs: 1500 },
    '/clothing/status': { aiConfigured: false },
    '/content/status': { local:true,jobs:Array.from({length:options.bookCount||0},(_,i)=>({slug:'sample-book-'+i,title:'Sample book '+(i+1),state:'done',published:true,progress:{pages:12,transcribed:12,narrated:12}})),narration:null },
    '/version': { build: 'test', disk: 'test', updater: false },
    '/integrations/drive/status': { localRoots: [], folderPath:'sample-folder', content:{books:true}, appInstalled:true, signedIn:true, lastSync:{files:0,skipped:0,when:'2026-10-01T12:00:00Z'} },
    '/config': { radius: 0, graceMs: 400 }, '/status': { paused: false },
    '/volcap': { device:{enabled:true,cap:45} }
  };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET') { writes.push({ method: request.method(), path: url.pathname }); return route.fulfill({ status: 204 }); }
    const pathname = url.pathname;
    const relative = pathname === '/settings/' ? 'public/settings/index.html' : pathname.startsWith('/settings/') ? 'public' + pathname : pathname.startsWith('/lib/') ? 'public' + pathname : null;
    if (relative) {
      const filename = path.join(ROOT, relative);
      if (pathname.endsWith('/settings-layout.js') && options.layoutDelay) await new Promise(resolve=>setTimeout(resolve,options.layoutDelay));
      if (!fs.existsSync(filename)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.js') ? 'application/javascript' : 'text/html', body: fs.readFileSync(filename) });
    }
    if (pathname==='/content/status' && options.contentDelay) await new Promise(resolve=>setTimeout(resolve,options.contentDelay));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payloads[pathname] || {}) });
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/settings/' + fragment);
  return { context, page, writes, errors };
}
async function ready(page) { await page.locator('#settingsNav').waitFor({ state:'attached',timeout: 2500 }); }
async function current(page, section) { await page.waitForFunction(section => document.querySelector('#settingsNav a[aria-current="page"]')?.getAttribute('href') === '#' + section, section, { timeout: 2500 }); }

test('eight sections organize original controls without starting work', async () => {
  const {context, page, writes, errors} = await open();
  try {
    await ready(page);
    assert.equal(await page.locator('#settingsNav a').count(), 8);
    const controls = { gaze:'dwellUp', sound:'deviceVolumeCap', apps:'appsList', books:'content', clothing:'wxWindow', media:'writings', connections:'aiKey', system:'updCheck' };
    for (const [section,id] of Object.entries(controls)) {
      await page.locator(`#settingsNav a[href="#${section}"]`).click();
      await current(page, section);
      await page.locator('#'+id).waitFor({state:'visible',timeout:2500});
      assert.equal(await page.locator('.settings-section:not([hidden])').count(), 1);
    }
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('legacy fragments reveal their actual control and survive reload', async () => {
  const destinations = { content:['books','content'], integrations:['connections','integrations'], voice:['sound','voice'], ai:['connections','ai'], fal:['connections','fal'], movies:['connections','movies'], writing:['media','writings'], exit:['apps','exit'], weekVideos:['media','weekVideos'], lock:['apps','lock'], updates:['system','updates'] };
  for (const [fragment,[section,id]] of Object.entries(destinations)) {
    const {context,page} = await open('#'+fragment);
    try { await ready(page); await current(page,section); assert.equal(await page.locator('#'+id).isVisible(),true); await page.reload(); await current(page,section); }
    finally { await context.close(); }
  }
});

test('history and section changes preserve unsaved credentials and DOM identity', async () => {
  const {context,page,writes} = await open('#ai');
  try {
    await ready(page);
    await page.locator('#aiKey').fill('pending sample text');
    await page.evaluate(() => { window.savedKeyNode = document.getElementById('aiKey'); });
    await page.locator('#settingsNav a[href="#gaze"]').click(); await current(page,'gaze');
    await page.goBack(); await current(page,'connections');
    assert.equal(await page.locator('#aiKey').inputValue(),'pending sample text');
    assert.equal(await page.evaluate(() => window.savedKeyNode === document.getElementById('aiKey')),true);
    await page.goForward(); await current(page,'gaze');
    assert.deepEqual(writes,[]);
  } finally { await context.close(); }
});

test('settings search finds named controls and never searches private input values', async () => {
  const {context,page} = await open('#ai');
  try {
    await ready(page);
    await page.locator('#aiKey').fill('private-sample-needle');
    await page.getByRole('searchbox',{name:'Search settings'}).fill('volume');
    const results=page.locator('#settingsSearchResults a');
    assert.ok(await results.count() >= 2);
    await results.first().click(); await current(page,'sound');
    await page.getByRole('searchbox',{name:'Search settings'}).fill('private-sample-needle');
    assert.equal(await page.locator('#settingsSearchResults a').count(),0);
    await page.getByRole('searchbox',{name:'Search settings'}).fill('weather');
    await page.locator('#settingsSearchResults a').first().click(); await current(page,'clothing');
    await page.getByRole('searchbox',{name:'Search settings'}).fill('flic');
    assert.equal(await page.locator('#settingsSearchResults a').first().textContent().then(t => /Buttons/.test(t)), true);
    await page.locator('#settingsSearchResults a').first().click(); await current(page,'connections');
    assert.equal(await page.locator('#buttons').isVisible(), true);
  } finally { await context.close(); }
});

test('mixed forms have one authoritative home and named contextual links', async () => {
  const {context,page} = await open('#connections');
  try {
    await ready(page);
    const sectionOf = id => page.locator('#'+id).evaluate(n => n.closest('.settings-section')?.dataset.section);
    assert.equal(await sectionOf('ttsKey'),'connections');
    assert.equal(await sectionOf('voices'),'sound');
    assert.equal(await sectionOf('mailTo'),'connections');
    assert.equal(await sectionOf('writings'),'media');
    assert.equal(await sectionOf('picksStatus'),'clothing');
    assert.equal(await sectionOf('stopBtn'),'system');
    assert.equal(await sectionOf('paused'),'gaze');
    assert.equal(await sectionOf('buttons'),'connections');
    assert.equal(await page.locator('#aiKey').count(),1);
  } finally { await context.close(); }
});

test('narrow navigation is operable by keyboard and does not overflow the page', async () => {
  const {context,page} = await open('#books',390);
  try {
    await ready(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    assert.equal(await page.locator('#settingsSidebar').isVisible(),false);
    await page.getByRole('button',{name:'Open sections'}).click();
    assert.equal(await page.locator('#settingsSidebar').isVisible(),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settingsSidebar').isVisible(),false);
    assert.equal(await page.getByRole('button',{name:'Open sections'}).evaluate(n=>n===document.activeElement),true);
    await page.getByRole('button',{name:'Open sections'}).click();
    await page.locator('#settingsNav a[href="#sound"]').click(); await current(page,'sound');
    assert.equal(await page.locator('#settingsSidebar').isVisible(),false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  } finally { await context.close(); }
});


test('mobile settings search keeps results operable inside the open drawer', async () => {
  const {context,page,writes} = await open('#books',390);
  try {
    await ready(page);
    await page.getByRole('button',{name:'Open sections'}).click();
    await page.getByRole('searchbox',{name:'Search settings'}).fill('volume');
    const result=page.locator('#settingsSidebar #settingsSearchResults a').first();
    await result.waitFor({state:'visible'});
    assert.equal(await result.evaluate(el=>!!el.closest('[inert]')),false);
    await result.click(); await current(page,'sound');
    assert.equal(await page.locator('#settingsSidebar').isVisible(),false);
    assert.equal(await page.locator('#settingsSearchResults').isVisible(),false);
    assert.deepEqual(writes,[]);
  } finally { await context.close(); }
});

test('saved-writing pagination follows the list when it loads before the shell', async () => {
  const {context,page} = await open('#writing',1280,{layoutDelay:300,writingCount:16});
  try {
    await ready(page); await current(page,'media');
    await page.locator('#writingPageCount').waitFor({state:'visible'});
    assert.equal(await page.locator('#writingPageCount').evaluate(el=>el.closest('.settings-section').dataset.section),'media');
    assert.match(await page.locator('#writingPageCount').innerText(),/of 16 writings/);
  } finally { await context.close(); }
});


test('a full library return restores section scroll after asynchronous books arrive', async () => {
  const {context,page} = await open('#content',1280,{bookCount:16,contentDelay:150});
  try {
    await ready(page); await current(page,'books');
    await page.locator('.settings-book-row').first().waitFor({state:'visible'});
    await page.evaluate(()=>{document.getElementById('settingsMain').scrollTop=240;});
    await page.waitForFunction(()=>document.getElementById('settingsMain').scrollTop>=230);
    await page.reload();
    await ready(page); await current(page,'books');
    await page.locator('.settings-book-row').first().waitFor({state:'visible'});
    await page.waitForFunction(()=>document.getElementById('settingsMain').scrollTop>=230,null,{timeout:2500});
    await page.evaluate(()=>window.ERASettingsLayout.navigate('ai'));
    await current(page,'connections');
    assert.equal(await page.locator('#ai').isVisible(),true,'a specific service link still takes precedence');
  } finally { await context.close(); }
});
