// Installed Chat UI proof, shared by Windows leg B and the closed host fixture.
// Recognition and voice services are not under test: one deterministic typed
// question uses the local parser; voice requests receive a tiny synthetic WAV.
// Playback itself uses the browser's real HTMLAudioElement and native events.
import assert from 'node:assert/strict';

const QUESTION = 'Would you like music or a story?';
const STORAGE_KEYS = ['chat:voicePreference', 'chat:timings:v1', 'chat:stories'];
const RESTART_STORY = { label: 'A library visit', say: 'We read a new story together.' };
const EMPTY_STATE = { voicePreference: 'saved', stories: [], timings: [] };
const DURATIONS = ['holdMs', 'releaseToDrainedMs', 'drainToFinishSentMs', 'finishRoundTripMs',
  'finishToTranscriptMs', 'releaseToTranscriptMs', 'transcriptToChoicesMs', 'choicesToRevealMs',
  'revealToSelectMs', 'selectionToPlaybackMs', 'playbackMs', 'releaseToPlaybackMs',
  'workerActivityMs', 'workerCloudMs', 'workerFinalMs', 'audioMs', 'choicesServerMs', 'totalMs'];
const FIELDS = new Set(['version', 'retention', 'turns', 'summary', 'counts', 'groups', 'medianMinimumSamples',
  'p95MinimumSamples', 'kind', 'status', 'reason', 'timings', 'open', 'completed', 'cancelled', 'failed',
  'hold', 'typed', 'fixed', 'reply', 'samples', 'medianMs', 'p95Ms', ...DURATIONS]);
const CATEGORIES = new Set(['hold', 'typed', 'fixed', 'reply', 'open', 'completed', 'cancelled', 'failed',
  'cancel', 'closed', 'interrupted', 'superseded', 'reload', 'timeout', 'capture', 'recognition', 'choices',
  'speech', 'connection', 'other']);

export function makeChatToneWav() {
  const rate = 16000, samples = Math.round(rate * .32), wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / rate) * 1200), 44 + i * 2);
  return wav;
}

export function assertContentFreeMetrics(value) {
  assert.equal(value?.version, 1); assert.ok(Array.isArray(value.turns));
  assert.ok(Number.isInteger(value.retention) && value.retention > 0 && value.retention <= 40);
  function inspect(item) {
    if (item === null) return;
    if (typeof item === 'number') { assert.ok(Number.isFinite(item) && item >= 0); return; }
    if (typeof item === 'string') { assert.ok(CATEGORIES.has(item), 'timing export contains an unexpected string'); return; }
    if (Array.isArray(item)) { item.forEach(inspect); return; }
    assert.ok(item && typeof item === 'object', 'timing export contains an unexpected value');
    for (const [key, child] of Object.entries(item)) {
      assert.ok(FIELDS.has(key), 'timing export contains an unexpected field'); inspect(child);
    }
  }
  inspect(value);
  for (const row of value.turns) {
    assert.ok(['hold', 'typed', 'fixed', 'reply'].includes(row.kind));
    assert.ok(['open', 'completed', 'cancelled', 'failed'].includes(row.status));
    assert.ok(row.timings && typeof row.timings === 'object');
    for (const [key, number] of Object.entries(row.timings)) assert.ok(DURATIONS.includes(key) && typeof number === 'number' && Number.isFinite(number) && number >= 0);
  }
}

export async function readChatState(page) {
  const result = await page.evaluate(async () => {
    const response = await fetch('/chat/api/state', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(result.status, 200, 'the real durable Chat state endpoint answers');
  assert.equal(result.body.version, 1); assert.ok(Number.isInteger(result.body.revision));
  assert.ok(Array.isArray(result.body.value?.stories)); assert.ok(Array.isArray(result.body.value?.timings));
  return result.body;
}

async function replaceChatState(page, value) {
  const state = await readChatState(page);
  const result = await page.evaluate(async body => {
    const response = await fetch('/chat/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { version: 1, expectedRevision: state.revision, patch: value });
  assert.equal(result.status, 200, 'the owned test state is saved without a revision conflict');
  return result.body;
}

export async function waitForChatState(page, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await readChatState(page);
    if (predicate(state.value)) return state;
    assert.ok(Date.now() < deadline, 'timed out waiting for acknowledged durable Chat state');
    await page.waitForTimeout(25);
  }
}

async function readyChat(page, timeout) {
  await page.waitForFunction(() => document.body.dataset.storageReady === 'true', null, { timeout });
  assert.equal(await page.locator('body').getAttribute('data-storage-available'), 'true', 'Chat has loaded the local durable store');
}

function installInstrumentation(origin) {
  if (location.origin !== origin || !location.pathname.startsWith('/chat/')) return;
  const state = { playCalls: 0, playing: 0, ended: 0, deviceCalls: 0, microphoneCalls: 0, nativeAudio: true, exports: [], exportClicks: 0 };
  Object.defineProperty(window, '__chatUISmoke', { value: state, configurable: true });
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    state.playCalls++; state.nativeAudio &&= this instanceof HTMLAudioElement;
    this.addEventListener('playing', () => { state.playing++; }, { once: true });
    this.addEventListener('ended', () => { state.ended++; }, { once: true });
    return nativePlay.apply(this, args);
  };
  if (window.speechSynthesis) speechSynthesis.speak = () => { state.deviceCalls++; throw new Error('Unexpected device voice in saved voice check'); };
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => { state.microphoneCalls++; return Promise.reject(new Error('This check uses a typed question')); };
  const blobs = new Map(), nativeURL = URL.createObjectURL;
  URL.createObjectURL = function (blob) {
    const url = nativeURL.call(URL, blob);
    if (blob.type === 'application/json') blobs.set(url, blob);
    return url;
  };
  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download === 'chat-timings.json') {
      state.exportClicks++;
      const blob = blobs.get(this.href);
      if (blob) state.exports.push(blob.text());
      // Verify the actual generated export without writing a download into the
      // remote kiosk's profile or the controller's CDP download directory.
      return;
    }
    return nativeClick.call(this);
  };
}

export async function checkInstalledChatUI(page, options = {}) {
  const timeout = options.timeout || 30000, originalURL = page.url();
  const base = new URL(options.baseURL || originalURL).origin;
  assert.equal(new URL(originalURL).origin, base, 'the UI check starts on the hub origin');
  const savedStorage = await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), STORAGE_KEYS);
  const savedState = await readChatState(page);
  const wav = makeChatToneWav(), requests = { voices: 0, clips: 0, choices: 0, blocked: 0 };
  const cdp = await page.context().newCDPSession(page);
  let script;
  const routeHandler = async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { requests.blocked++; return route.abort(); }
    if (url.pathname === '/voices') {
      requests.voices++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, current: 'configured' }) });
    }
    if (url.pathname === '/tts') {
      requests.clips++; return route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
    }
    if (url.pathname.startsWith('/chat/api/')) {
      if (request.method() === 'GET' && url.pathname === '/chat/api/config') return route.continue();
      if (['GET', 'PUT'].includes(request.method()) && url.pathname === '/chat/api/state') return route.continue();
      if (request.method() === 'POST' && url.pathname === '/chat/api/choices') {
        let input; try { input = request.postDataJSON(); } catch {}
        if (input?.text === QUESTION && Array.isArray(input.context) && input.context.length === 0) { requests.choices++; return route.continue(); }
      }
      requests.blocked++; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unexpected-test-request"}' });
    }
    return route.continue();
  };
  async function openPartner() {
    await page.locator('#partnerOpen').click({ timeout });
    await page.locator('#partnerDialog').waitFor({ state: 'visible', timeout });
  }
  async function openChat() {
    await page.goto(new URL('/chat/', base).href, { waitUntil: 'load', timeout });
    await readyChat(page, timeout);
    await page.locator('#grid .chat-symbol').first().waitFor({ state: 'visible', timeout });
  }
  const audio = () => page.evaluate(() => {
    const { playCalls, playing, ended, deviceCalls, microphoneCalls, nativeAudio } = window.__chatUISmoke;
    return { playCalls, playing, ended, deviceCalls, microphoneCalls, nativeAudio };
  });
  try {
    await page.route('**/*', routeHandler);
    await cdp.send('Page.enable');
    ({ identifier: script } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installInstrumentation.toString()})(${JSON.stringify(base)})` }));
    await page.evaluate(keys => keys.forEach(key => localStorage.removeItem(key)), STORAGE_KEYS);
    await replaceChatState(page, EMPTY_STATE);
    const warmed = page.waitForResponse(response => new URL(response.url()).pathname === '/tts', { timeout });
    await openChat(); await warmed;
    assert.equal(await page.locator('#voicePreference').inputValue(), 'saved', 'saved voice is the default');
    assert.equal((await audio()).playCalls, 0, 'warming prepared phrases cannot play audio');
    await openPartner(); await page.locator('#voicePreference').selectOption('local', { timeout });
    await waitForChatState(page, value => value.voicePreference === 'local', timeout);
    await openChat();
    assert.equal(await page.locator('#voicePreference').inputValue(), 'local', 'explicit device voice choice persists');
    await openPartner(); await page.locator('#voicePreference').selectOption('saved', { timeout });
    await waitForChatState(page, value => value.voicePreference === 'saved', timeout);
    await openChat();
    assert.equal(await page.locator('#voicePreference').inputValue(), 'saved', 'saved voice choice persists');
    assert.equal((await audio()).playCalls, 0, 'preference changes and reloads do not speak');

    const restBefore = await page.locator('.tile.rest').evaluateAll(nodes => nodes.map(node => ({
      bounds: node.getBoundingClientRect().toJSON(), background: getComputedStyle(node).backgroundColor,
      symbols: node.querySelectorAll('.chat-symbol').length,
    })));
    assert.equal(restBefore.length, 2);
    for (const rest of restBefore) { assert.equal(rest.background, 'rgb(0, 0, 0)'); assert.equal(rest.symbols, 0); }
    const iconCount = await page.locator('#grid button.tile').evaluateAll(nodes => nodes.map(node => node.querySelectorAll('.chat-symbol').length));
    assert.ok(iconCount.length >= 10 && iconCount.every(count => count === 1), 'each fixed phrase and route has one symbol');

    await openPartner(); await page.locator('#testing > summary').click({ timeout });
    await page.locator('#typedQuestion').fill(QUESTION, { timeout });
    await page.locator('#typedAsk').click({ timeout });
    await page.waitForFunction(() => document.querySelector('#notice')?.textContent.includes('Replies ready'), null, { timeout });
    assert.equal(await page.locator('.response').count(), 0, 'ready replies remain hidden before a fresh neutral movement');
    assert.equal((await audio()).playCalls, 0, 'preparing replies cannot play their cached audio');
    const rest = await page.locator('.tile.rest').first().boundingBox(); assert.ok(rest);
    await page.mouse.move(0, 0); await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2);
    await page.locator('.response').first().waitFor({ state: 'visible', timeout });
    assert.deepEqual((await page.locator('.response .label').allTextContents()).map(text => text.trim()), ['Music', 'A story']);
    assert.equal(await page.getByRole('button', { name: 'Music', exact: true }).getAttribute('data-symbol'), 'music');
    assert.equal(await page.getByRole('button', { name: 'A story', exact: true }).getAttribute('data-symbol'), 'book');
    const restAfter = await page.locator('.tile.rest').evaluateAll(nodes => nodes.map(node => ({
      bounds: node.getBoundingClientRect().toJSON(), background: getComputedStyle(node).backgroundColor,
      symbols: node.querySelectorAll('.chat-symbol').length,
    })));
    assert.deepEqual(restAfter, restBefore, 'revealing replies does not change the black rest slots');
    const fit = await page.locator('#grid button.tile').evaluateAll(nodes => nodes.map(node => {
      const label = node.querySelector('.label'), icon = node.querySelector('.chat-symbol'), style = getComputedStyle(node);
      const available = node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
        - (icon ? icon.getBoundingClientRect().height + parseFloat(style.rowGap) : 0);
      return { font: parseFloat(style.fontSize), fits: label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= available + 1 };
    }));
    assert.ok(fit.every(item => item.font >= 44 && item.fits), 'pictures and complete words fit at the readable font floor');
    await options.screenshot?.();
    assert.equal((await audio()).playCalls, 0, 'revealing replies does not speak');
    await page.getByRole('button', { name: 'Music', exact: true }).click({ timeout });
    await page.waitForFunction(() => window.__chatUISmoke.ended === 1 || document.querySelector('#notice')?.textContent.includes('unavailable'), null, { timeout });
    const actualAudio = await audio();
    assert.deepEqual(actualAudio, { playCalls: 1, playing: 1, ended: 1, deviceCalls: 0, microphoneCalls: 0, nativeAudio: true },
      'a deliberate selection plays the real saved clip to completion without device speech');
    const completedState = await waitForChatState(page, value => value.timings.length === 1 && value.timings[0].status === 'completed', timeout);
    await openPartner(); await page.locator('#turnTimings > summary').click({ timeout });
    await page.locator('#exportTimings').click({ timeout });
    const exported = await page.evaluate(async () => ({ clicks: window.__chatUISmoke.exportClicks, values: await Promise.all(window.__chatUISmoke.exports) }));
    assert.equal(exported.clicks, 1); assert.equal(exported.values.length, 1);
    const savedMetrics = JSON.parse(exported.values[0]);
    assertContentFreeMetrics(savedMetrics);
    assert.deepEqual(savedMetrics.turns, completedState.value.timings, 'the generated timing export contains exactly the durable content-free records');
    const typedTurn = savedMetrics.turns[0]; assert.equal(typedTurn.kind, 'typed');
    for (const name of ['transcriptToChoicesMs', 'choicesToRevealMs', 'revealToSelectMs', 'selectionToPlaybackMs', 'playbackMs', 'totalMs'])
      assert.ok(Number.isFinite(typedTurn.timings[name]) && typedTurn.timings[name] >= 0, name + ' is measured');
    assert.ok(typedTurn.timings.playbackMs > 0);
    for (const name of ['holdMs', 'releaseToTranscriptMs', 'workerFinalMs', 'workerActivityMs', 'workerCloudMs'])
      assert.equal(typedTurn.timings[name], undefined, 'a typed turn must not claim recognition timing');
    for (const group of Object.values(savedMetrics.summary.groups.typed)) { assert.equal(group.medianMs, null); assert.equal(group.p95Ms, null); }
    assert.equal(requests.choices, 1); assert.equal(requests.blocked, 0); assert.ok(requests.voices > 0 && requests.clips > 0);
    let restartState;
    if (options.prepareRestart) {
      await page.locator('#storyLabel').fill(RESTART_STORY.label, { timeout });
      await page.locator('#storyMessage').fill(RESTART_STORY.say, { timeout });
      await page.locator('#saveStory').click({ timeout });
      await page.locator('#voicePreference').selectOption('local', { timeout });
      restartState = (await waitForChatState(page, value => value.voicePreference === 'local' && value.stories.length === 1 && value.stories[0].say === RESTART_STORY.say, timeout)).value;
      assert.deepEqual(restartState.stories, [RESTART_STORY], 'the intended story label and full spoken message were saved');
      assert.deepEqual(restartState.timings, savedMetrics.turns);
    }
    return { ok: true, evidence: 'Typed local alternatives; service audio mocked; native browser playback observed. No microphone or recognition accuracy test.',
      symbols: true, restUnchanged: true, savedDefaultAndPersistence: true, exportContentFree: true, typedTurn,
      exportedTurns: savedMetrics.turns.length, actualAudio, microphoneCalls: actualAudio.microphoneCalls, ...(restartState ? { restartState } : {}) };
  } finally {
    if (script) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script });
    try {
      await page.goto(originalURL, { waitUntil: 'load', timeout });
      if (!options.prepareRestart) await replaceChatState(page, savedState.value);
      await page.evaluate(saved => {
        for (const [key, value] of Object.entries(saved)) if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
      }, savedStorage);
    } finally { await page.unroute('**/*', routeHandler); await cdp.detach(); }
  }
}

// The caller owns a complete browser and hub restart between preparation and
// this check. No browser profile or storageState is passed across that boundary.
export async function checkRestoredChatState(page, expected, options = {}) {
  const timeout = options.timeout || 30000, base = new URL(options.baseURL || page.url()).origin;
  const originalURL = page.url(), cdp = await page.context().newCDPSession(page);
  const routeHandler = route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    if (url.pathname === '/voices') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":true,"current":"configured"}' });
    if (url.pathname === '/tts') return route.fulfill({ status: 200, contentType: 'audio/wav', body: makeChatToneWav() });
    return route.continue();
  };
  let script;
  try {
    await page.route('**/*', routeHandler);
    await cdp.send('Page.enable');
    ({ identifier: script } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installInstrumentation.toString()})(${JSON.stringify(base)})` }));
    assert.deepEqual((await readChatState(page)).value, expected, 'a fresh store instance serves the exact acknowledged state');
    await page.goto(base + '/chat/', { waitUntil: 'load', timeout }); await readyChat(page, timeout);
    assert.equal(await page.locator('#voicePreference').inputValue(), expected.voicePreference, 'the explicit voice choice survives a full browser restart');
    await page.getByRole('button', { name: 'My news', exact: true }).click({ timeout });
    for (const story of expected.stories) await page.getByRole('button', { name: story.label, exact: true }).waitFor({ state: 'visible', timeout });
    if (!expected.stories.length) assert.equal(await page.locator('.emptyStory').first().textContent(), 'Your stories go here');
    await page.locator('#partnerOpen').click({ timeout });
    await page.locator('#turnTimings > summary').click({ timeout });
    assert.ok((await page.locator('#timingSummary').textContent()).startsWith(`${expected.timings.length} recent turns:`), 'the UI restores the durable timing count');
    await page.locator('#exportTimings').click({ timeout });
    const values = await page.evaluate(() => Promise.all(window.__chatUISmoke.exports));
    assert.equal(values.length, 1); const metrics = JSON.parse(values[0]); assertContentFreeMetrics(metrics);
    assert.deepEqual(metrics.turns, expected.timings, 'a fresh browser exports the original timing rows');
    assert.equal(await page.evaluate(() => window.__chatUISmoke.playCalls), 0, 'restoring state never speaks');
    if (options.clear) {
      await page.locator('#clearStories').click({ timeout });
      await page.locator('#clearTimings').click({ timeout });
      await page.locator('#voicePreference').selectOption('saved', { timeout });
      const state = await waitForChatState(page, value => value.stories.length === 0 && value.timings.length === 0 && value.voicePreference === 'saved', timeout);
      assert.deepEqual(state.value, EMPTY_STATE, 'UI clear actions remove stories and timing rows from the real store');
      return state.value;
    }
    return expected;
  } finally {
    if (script) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script });
    try { await page.goto(originalURL, { waitUntil: 'load', timeout }); }
    finally { await page.unroute('**/*', routeHandler); await cdp.detach(); }
  }
}
