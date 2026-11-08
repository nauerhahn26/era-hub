// Installed Games acceptance through ordinary controls and an actual kiosk restart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const copy = value => structuredClone(value);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function gamesProgress(state) {
  return copy({ version: state.version, view: state.view, fashion: state.fashion,
    connect4: state.connect4, tiles: state.tiles, tictactoe: state.tictactoe });
}

export function assertGamesNativeGeometry(view) {
  assert.equal(view.screenWidth, 1280, 'the actual Windows desktop is 1280 pixels wide');
  assert.equal(view.screenHeight, 800, 'the actual Windows desktop is 800 pixels high');
  assert.equal(view.width, 1280);
  assert.ok(view.height === 799 || view.height === 800, 'the kiosk fills the actual desktop');
  assert.equal(view.screenX, 0);
  assert.equal(view.screenY, 0);
  assert.equal(view.dpr, 1);
  assert.equal(view.visualScale, 1);
  assert.ok(['1', 'normal'].includes(view.htmlZoom));
  assert.ok(['1', 'normal'].includes(view.bodyZoom));
}

export function assertFreshGamesBrowser(before, after, closed) {
  assert.equal(closed.method, 'Browser.close');
  assert.equal(closed.allBrowserProcessesGone, true);
  assert.equal(closed.guestCdpUnavailable, true);
  assert.ok(Number.isInteger(before.browserPid) && before.browserPid > 0);
  assert.ok(Number.isInteger(after.browserPid) && after.browserPid > 0);
  assert.notEqual(after.browserPid, before.browserPid, 'the restarted browser has a new PID');
  assert.notEqual(after.created, before.created, 'the browser process has a new creation identity');
  assert.notEqual(after.cdp, before.cdp, 'the browser has a new CDP identity');
  assert.equal(after.hubPid, before.hubPid, 'the same installed hub and data remain running');
  assert.equal(after.installedDir, before.installedDir);
}

function browserProcesses(vm) {
  const output = vm.bat('games-browser-processes', [
    `powershell -NoProfile -Command "$rows = @(Get-CimInstance Win32_Process -Filter 'Name=''msedge.exe'' or Name=''chrome.exe''' -ErrorAction Stop | ForEach-Object { @{ pid = [int]$_.ProcessId; created = $_.CreationDate.ToUniversalTime().ToString('o') } }); 'GAMES_PROCESSES=' + (@{ processes = $rows } | ConvertTo-Json -Depth 4 -Compress)"`,
  ], { timeout: 30000 });
  const match = /GAMES_PROCESSES=(\{[^\r\n]+\})/.exec(output);
  assert.ok(match, 'Windows returned the complete browser process inventory');
  const rows = JSON.parse(match[1]).processes;
  assert.ok(Array.isArray(rows));
  for (const row of rows) {
    assert.ok(Number.isInteger(row.pid) && row.pid > 0);
    assert.ok(typeof row.created === 'string' && row.created.length > 10);
  }
  return rows;
}

function guestCdp(vm) {
  const output = vm.guest('curl.exe -sf --max-time 3 http://127.0.0.1:9222/json/version',
    { soft: true, timeout: 15000 });
  if (!output) return null;
  return JSON.parse(output);
}

async function browserIdentity(vm, browser) {
  const session = await browser.newBrowserCDPSession();
  let root;
  try {
    const result = await session.send('SystemInfo.getProcessInfo');
    root = result.processInfo.find(process => process.type === 'browser');
  } finally { await session.detach(); }
  assert.ok(root, 'CDP reports the actual browser process');
  const processes = browserProcesses(vm);
  const process = processes.find(row => row.pid === root.id);
  assert.ok(process, 'the CDP browser is present in the native Windows process inventory');
  const endpoint = guestCdp(vm);
  const hub = vm.hubGet('/version');
  assert.ok(endpoint?.webSocketDebuggerUrl && Number.isInteger(hub?.pid));
  return { browserPid: process.pid, created: process.created, processes,
    cdp: endpoint.webSocketDebuggerUrl, hubPid: hub.pid, installedDir: vm.resolveInstdir() };
}

async function geometry(page) {
  const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
    screenWidth: screen.width, screenHeight: screen.height, screenX, screenY,
    dpr: devicePixelRatio, visualScale: visualViewport.scale,
    htmlZoom: getComputedStyle(document.documentElement).zoom,
    bodyZoom: getComputedStyle(document.body).zoom }));
  assertGamesNativeGeometry(view);
  return view;
}

export async function checkInstalledGamesUI(vm, { browser, page, expectedVersion, expectedBuild }) {
  const report = { version: 1, startedAt: new Date().toISOString(), ok: false,
    expectedVersion, expectedBuild, physicalTrackerTested: false,
    input: 'ordinary installed Windows kiosk pointer actions',
    talkScope: 'mocked Talk acknowledgment with the real shared button and paused game timer',
    phases: [], screenshots: [], errors: [], appSelectionRestored: false };
  let originalGamesEnabled = null;
  let enabledBefore = null;
  let settingsRoute = null;
  let pauseRoute = null;
  const state = () => page.evaluate(() => window.GamesApp.state());
  const command = (action, value) => page.locator(`[data-action="${action}"]${value === undefined ? '' : `[data-value="${value}"]`}`).first();
  const park = () => page.mouse.move(1276, 796);
  const click = async (action, value) => {
    await command(action, value).click({ timeout: 15000 });
    await park();
  };
  const ready = () => page.waitForFunction(() => window.GamesApp?.state().ready, undefined, { timeout: 30000 });
  const saved = () => page.waitForFunction(() => document.querySelector('#saveNotice')?.textContent === 'Saved', undefined, { timeout: 30000 });
  const note = name => { report.phases.push({ name, at: new Date().toISOString() }); };
  const menu = async () => {
    for (let count = 0; count < 8 && (await state()).view !== 'menu'; count++) await click('back');
    assert.equal((await state()).view, 'menu', 'ordinary Back controls return to the Games menu');
  };
  async function setGamesEnabled(enabled) {
    await vm.home(page);
    const manager = page.locator('#appMgr');
    await manager.waitFor({ state: 'visible', timeout: 30000 });
    if (!await manager.evaluate(element => element.open)) await manager.locator('summary').click();
    const checkbox = page.locator('#appMgrList label').filter({ hasText: /^Games$/ }).locator('input');
    if (await checkbox.isChecked() === enabled) return;
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url() === vm.HUB_URL + '/apps' && response.request().method() === 'POST'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
      checkbox.setChecked(enabled),
    ]);
    assert.equal(response.status(), 204, 'the Home app manager saves the Games selection');
  }
  async function screenshot(name) {
    const file = path.join(vm.OUT, 'games-' + name + '.png');
    await page.screenshot({ path: file, timeout: 30000 });
    report.screenshots.push({ file, sha256: hash(fs.readFileSync(file)) });
  }
  async function layout(name) {
    const record = await page.evaluate(() => {
      const targets = [...document.querySelectorAll('button.dwell')].filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
      });
      const boxes = targets.map(element => {
        const rect = element.getBoundingClientRect();
        return { action: element.dataset.action || element.id, value: element.dataset.value,
          x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height, font: parseFloat(getComputedStyle(element).fontSize) };
      });
      const corner = document.elementFromPoint(innerWidth - 3, innerHeight - 3);
      return { boxes, inertCorner: !!corner?.classList.contains('game-rest'),
        cornerColor: corner ? getComputedStyle(corner).backgroundColor : '' };
    });
    assert.equal(record.inertCorner, true);
    assert.equal(record.cornerColor, 'rgb(0, 0, 0)');
    for (const box of record.boxes) {
      assert.ok(box.x >= 0 && box.y >= 0 && box.right <= 1280 && box.bottom <= 800, 'a command fits the actual kiosk');
      if (!['barDoor', 'barTalk'].includes(box.action)) assert.ok(box.font >= 74, 'Games command text remains 74 pixels');
    }
    report.layouts ||= [];
    report.layouts.push({ name, ...record });
  }
  try {
    // The baseline's button journey may have replaced its browser. Reopen the
    // installed Home launcher through the same helper used by every baseline.
    await vm.launchKiosk();
    ({ browser, page } = await vm.kiosk());
    page.on('pageerror', error => report.errors.push(error.message));
    const installed = vm.hubGet('/version');
    assert.equal(installed.build, expectedBuild);
    assert.equal(installed.disk, expectedBuild);
    const dist = process.env.VM_DIST;
    const feed = JSON.parse(fs.readFileSync(path.join(dist, 'latest.json'), 'utf8'));
    assert.equal(feed.version, expectedVersion);
    assert.equal(feed.build, expectedBuild);
    assert.equal(hash(fs.readFileSync(path.join(dist, 'new-era-suite.tar.gz'))), feed.sha256);
    report.artifact = { head: fs.readFileSync(path.join(dist, 'HEAD'), 'utf8').trim(),
      tree: fs.readFileSync(path.join(dist, 'TREE'), 'utf8').trim(), tarballSha256: feed.sha256 };
    report.nativeViewport = await geometry(page);
    const apps = vm.hubGet('/apps').apps;
    const games = apps.find(app => app.id === 'games');
    assert.equal(games?.installed, true, 'Games arrives in the core update');
    originalGamesEnabled = games.enabled;
    enabledBefore = apps.filter(app => app.enabled).map(app => app.id).sort();
    await setGamesEnabled(true);
    await vm.openTile(page, 'Games', /\/games\/?$/);
    await ready();
    assert.equal(await page.evaluate(() => typeof window.GamesApp.test), 'undefined');
    await menu();
    for (const game of ['tictactoe', 'fashion', 'connect4', 'tiles']) assert.equal(await command('open', game).isVisible(), true);
    await layout('menu');
    note('installed-update-and-home-entry');

    await click('open', 'tictactoe');
    assert.equal((await state()).tictactoe.mode, 'local');
    assert.deepEqual((await state()).tictactoe.board, Array(9).fill(0));
    const lastSquare = await command('tictactoe-place', 8).elementHandle();
    await layout('tictactoe');
    for (const square of [0, 3, 1, 4, 2]) await click('tictactoe-place', square);
    assert.equal((await state()).tictactoe.status, 'won');
    assert.equal((await state()).tictactoe.winner, 1);
    assert.deepEqual((await state()).tictactoe.board, [1, 1, 1, 2, 2, 0, 0, 0, 0]);
    assert.equal(await page.evaluate(element => element === document.querySelector('[data-action="tictactoe-place"][data-value="8"]'), lastSquare), true);
    assert.equal(await page.locator('[data-action="tictactoe-place"]:enabled').count(), 0);
    await screenshot('tictactoe-win');
    await click('undo');
    assert.equal((await state()).tictactoe.status, 'playing');
    const previousBoard = (await state()).tictactoe.board;
    await click('restart');
    await click('cancel');
    assert.deepEqual((await state()).tictactoe.board, previousBoard);
    await click('restart');
    await click('confirm');
    assert.deepEqual((await state()).tictactoe.board, Array(9).fill(0));
    for (const square of [0, 1, 2, 4, 3, 5, 7, 6, 8]) await click('tictactoe-place', square);
    assert.equal((await state()).tictactoe.status, 'draw');
    assert.equal((await state()).tictactoe.winner, 0);
    note('local-win-draw-stable-squares-undo-confirmed-restart');

    await click('tictactoe-mode', 'computer');
    await click('confirm');
    await click('tictactoe-place', 0);
    await page.waitForFunction(() => GamesApp.state().tictactoe.board.filter(Boolean).length === 2, undefined, { timeout: 15000 });
    assert.equal((await state()).tictactoe.board[4], 2, 'the computer takes the available center');
    await click('undo');
    assert.deepEqual((await state()).tictactoe.board, Array(9).fill(0), 'Undo reverses the complete computer round');

    settingsRoute = async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), pauseGoes: 'tdsnap' } });
    };
    pauseRoute = async route => {
      assert.equal(route.request().method(), 'POST');
      assert.equal(route.request().postDataJSON().path, '/games/');
      report.mockedTalkRequests = (report.mockedTalkRequests || 0) + 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ action: 'paused' }) });
    };
    await page.route('**/settings', settingsRoute);
    await page.route('**/kiosk/pause', pauseRoute);
    await saved();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await ready();
    await page.locator('#barTalk').waitFor({ state: 'visible', timeout: 15000 });
    await click('tictactoe-place', 0);
    await page.locator('#barTalk').click();
    await park();
    await page.waitForFunction(() => GamesApp.state().paused, undefined, { timeout: 5000 });
    const paused = (await state()).tictactoe;
    assert.equal(paused.pendingComputer, true);
    assert.equal(paused.board.filter(Boolean).length, 1);
    await page.waitForTimeout(900);
    assert.deepEqual((await state()).tictactoe, paused, 'Talk freezes the pending computer turn');
    assert.equal(report.mockedTalkRequests, 1);
    await saved();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await ready();
    await page.waitForFunction(() => !GamesApp.state().paused && GamesApp.state().tictactoe.board.filter(Boolean).length === 2, undefined, { timeout: 15000 });
    await page.unroute('**/settings', settingsRoute);
    await page.unroute('**/kiosk/pause', pauseRoute);
    settingsRoute = null;
    pauseRoute = null;
    note('computer-round-undo-and-mocked-talk-pause');

    await menu();
    await click('open', 'fashion');
    await click('fashion-resume');
    await click('fashion-edit', 'pattern');
    await click('option', 'stars');
    await click('fashion-save');
    assert.equal((await state()).fashion.looks.length, 1);
    assert.equal((await state()).fashion.draft.pattern, 'stars');
    await menu();
    await click('open', 'connect4');
    await click('connect4-drop', 0);
    assert.equal((await state()).connect4.board[5][0], 1);
    await menu();
    await click('open', 'tiles');
    for (const direction of ['left', 'up', 'right', 'down']) {
      if ((await state()).tiles.history.length) break;
      await click('tiles-move', direction);
    }
    assert.ok((await state()).tiles.history.length > 0);
    await menu();
    await click('open', 'tictactoe');
    await click('tictactoe-place', 1);
    await page.waitForFunction(() => !GamesApp.state().tictactoe.pendingComputer, undefined, { timeout: 15000 });
    await saved();
    const durable = gamesProgress(await state());
    const acknowledged = await vm.api(page, '/games/state');
    assert.equal(acknowledged.status, 200);
    assert.deepEqual(gamesProgress(acknowledged.json), durable);
    report.savedProgress = durable;
    await screenshot('tictactoe-before-restart');
    note('all-four-games-and-acknowledged-durable-state');

    report.beforeBrowser = await browserIdentity(vm, browser);
    const session = await browser.newBrowserCDPSession();
    await session.send('Browser.close').catch(error => {
      if (!/closed|disconnected|terminated/i.test(error.message)) throw error;
    });
    browser = null;
    page = null;
    report.closed = await vm.waitFor(() => {
      const processes = browserProcesses(vm);
      const cdp = guestCdp(vm);
      return processes.length === 0 && !cdp && { method: 'Browser.close',
        allBrowserProcessesGone: true, guestCdpUnavailable: true };
    }, { timeout: 60000, every: 1000, what: 'every kiosk browser process and its guest CDP listener to close' });
    assert.equal(vm.hubGet('/version').pid, report.beforeBrowser.hubPid);
    note('whole-browser-process-closed');
    await vm.launchKiosk();
    ({ browser, page } = await vm.kiosk());
    page.on('pageerror', error => report.errors.push(error.message));
    report.afterBrowser = await browserIdentity(vm, browser);
    assertFreshGamesBrowser(report.beforeBrowser, report.afterBrowser, report.closed);
    report.restoredNativeViewport = await geometry(page);
    await vm.home(page);
    await vm.openTile(page, 'Games', /\/games\/?$/);
    await ready();
    assert.deepEqual(gamesProgress(await state()), durable, 'all four workspaces return in a whole new browser');
    const disk = JSON.parse(vm.guestFile(vm.INSTDIR + '\\data\\games\\state.json'));
    assert.deepEqual(gamesProgress(disk), durable, 'the same installed data folder holds the acknowledged Games state');
    assert.equal(await page.evaluate(() => typeof window.GamesApp.test), 'undefined');
    await screenshot('tictactoe-restored');
    note('new-browser-same-hub-restored-all-four-games');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) {
    report.errors.push(String(error));
    throw error;
  } finally {
    try {
      if (originalGamesEnabled !== null && page && !page.isClosed()) {
        if (settingsRoute) await page.unroute('**/settings', settingsRoute);
        if (pauseRoute) await page.unroute('**/kiosk/pause', pauseRoute);
        await setGamesEnabled(originalGamesEnabled);
        assert.deepEqual(vm.hubGet('/apps').apps.filter(app => app.enabled).map(app => app.id).sort(), enabledBefore);
        report.appSelectionRestored = true;
      }
    } catch (error) {
      report.ok = false;
      report.errors.push('App selection restoration failed. ' + error);
      throw error;
    } finally {
      report.completedAt = new Date().toISOString();
      fs.writeFileSync(path.join(vm.OUT, 'games-ui-smoke.json'), JSON.stringify(report, null, 2) + '\n');
    }
  }
  assert.equal(report.appSelectionRestored, true);
  return { browser, page, report };
}
