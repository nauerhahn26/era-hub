import test from 'node:test';
import assert from 'node:assert/strict';
import { makeChatToneWav, assertContentFreeMetrics, makeChatStateDiagnostic, waitForChatState, assertChatTilesFit, settleRoute, rewriteSettingsRoute } from './lib/chat-ui-smoke.mjs';

test('Chat UI audio fixture is a small valid PCM WAV with real samples', () => {
  const wav = makeChatToneWav();
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt16LE(20), 1); assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data'); assert.equal(wav.readUInt32LE(40), wav.length - 44);
  assert.ok(wav.length > 44 && wav.length < 16000);
  assert.ok([...wav.subarray(44)].some(value => value !== 0));
});

const sample = () => ({ version: 1, retention: 40,
  turns: [{ kind: 'typed', status: 'completed', timings: { transcriptToChoicesMs: 10, selectionToPlaybackMs: 8, playbackMs: 320, totalMs: 500 } }],
  summary: { counts: { open: 0, completed: 1, cancelled: 0, failed: 0 },
    groups: { typed: { playbackMs: { samples: 1, medianMs: null, p95Ms: null } } }, medianMinimumSamples: 3, p95MinimumSamples: 20 } });

test('Chat UI privacy check accepts timing numbers and permitted outcome categories', () => {
  assert.doesNotThrow(() => assertContentFreeMetrics(sample()));
});

test('Chat UI privacy check rejects content, unexpected fields and invalid numbers in exported records', () => {
  const badField = sample(); badField.turns[0].question = 'A private question';
  const badValue = sample(); badValue.turns[0].kind = 'A private reply';
  const badTiming = sample(); badTiming.turns[0].timings.playbackMs = 'Music please';
  const badSummary = sample(); badSummary.summary.groups.typed.playbackMs.label = 'A private name';
  const badNumber = sample(); badNumber.turns[0].timings.totalMs = Infinity;
  for (const value of [badField, badValue, badTiming, badSummary, badNumber]) assert.throws(() => assertContentFreeMetrics(value));
});

test('state failure diagnostics retain only bounded timing rows, counts, revision and storage outcome', () => {
  const secret = 'private words with an identity and https://example.invalid/private';
  const state = { revision: 7, value: { stories: [{ label: secret, say: secret }], voicePreference: secret,
    timings: [{ kind: 'typed', status: 'completed', question: secret, timings: { totalMs: 5, transcript: secret, playbackMs: Infinity } }] } };
  const value = makeChatStateDiagnostic(state, { counts: { recent: 1, completed: 1, identity: secret }, storageState: 'unsaved', text: secret });
  assert.deepEqual(value, { version: 1, lastRevision: 7, backendRows: [{ kind: 'typed', status: 'completed', timings: { totalMs: 5 } }], ui: { counts: { recent: 1, completed: 1 }, storageState: 'unsaved' } });
  assert.equal(JSON.stringify(value).includes(secret), false);
  const bounded = makeChatStateDiagnostic({ revision: secret, value: { timings: Array(1000).fill({ kind: 'hold', status: 'cancelled', reason: 'closed', timings: { holdMs: 3 } }) } }, { counts: { recent: secret, open: -1 }, storageState: secret });
  assert.equal(bounded.backendRows.length, 40); assert.equal(bounded.lastRevision, null);
  assert.deepEqual(bounded.ui, { counts: {}, storageState: 'unknown' });
  assert.equal(JSON.stringify(bounded).includes(secret), false);
});

test('a state wait reports the last backend rows and UI outcome without retaining private state', async () => {
  const secret = 'private story, spoken words and identity';
  const state = { version: 1, revision: 8, value: { stories: [{ label: secret, say: secret }], timings: [{ kind: 'typed', status: 'open', timings: { totalMs: 4 }, question: secret }] } };
  let calls = 0;
  const page = { evaluate: async () => ++calls === 1 ? { status: 200, body: state } : { counts: { recent: 1, completed: 1 }, storageState: 'unsaved', text: secret } };
  await assert.rejects(waitForChatState(page, () => false, -1), error => {
    assert.equal(error.chatStateDiagnostic.lastRevision, 8);
    assert.equal(error.chatStateDiagnostic.backendRows[0].status, 'open');
    assert.deepEqual(error.chatStateDiagnostic.ui, { counts: { recent: 1, completed: 1 }, storageState: 'unsaved' });
    assert.equal(error.message.includes(secret), false); return true;
  });
  assert.equal(calls, 2);
});

test('an unresponsive UI cannot block the bounded state failure diagnostic', async () => {
  let calls = 0;
  const state = { version: 1, revision: 9, value: { stories: [], timings: [] } };
  const page = { evaluate: () => ++calls === 1 ? Promise.resolve({ status: 200, body: state }) : new Promise(() => {}) };
  const started = Date.now();
  await assert.rejects(waitForChatState(page, () => false, -1), error => {
    assert.equal(error.chatStateDiagnostic.lastRevision, 9);
    assert.deepEqual(error.chatStateDiagnostic.ui, { counts: {}, storageState: 'unknown' }); return true;
  });
  assert.ok(Date.now() - started < 1500, 'diagnostic returns after its half-second observation limit');
});

// The leg B red of 10/26 (v1.0.21 and v1.0.22): the QA guest's native 1024x768
// desktop left "Reactions" 210 px wide at the 44 px floor in a 208 px label box,
// and the assertion said only that something did not fit.
const tile = (text, extra = {}) => ({ text, font: 44, clientWidth: 208, scrollWidth: 120, available: 150, scrollHeight: 48, fits: true, ...extra });
const qaScreen = { innerWidth: 1024, innerHeight: 768, screenWidth: 1024, screenHeight: 768, devicePixelRatio: 1, frame: true };

test('the Chat fit check passes when every measured tile keeps the 44 px floor and fits', () => {
  assert.doesNotThrow(() => assertChatTilesFit({ viewport: { ...qaScreen, innerWidth: 1280, innerHeight: 800, screenWidth: 1280, screenHeight: 800 },
    tiles: [tile('yes'), tile('Reactions', { clientWidth: 272, scrollWidth: 210 }), tile('Help me say it', { scrollHeight: 96 })] }));
});

test('a Chat fit failure names each offending tile with its metrics and the screen it was measured on', () => {
  const tiles = [tile('yes'), tile('Reactions', { scrollWidth: 210, fits: false }), tile('Music', { font: 40 })];
  assert.throws(() => assertChatTilesFit({ viewport: qaScreen, tiles }), error => {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert.match(error.message, /^pictures and complete words fit at the readable font floor/, 'the original message still leads');
    assert.match(error.message, /2 of 3 tiles/);
    assert.match(error.message, /"text":"Reactions","font":44,"clientWidth":208,"scrollWidth":210,"available":150,"scrollHeight":48/);
    assert.match(error.message, /"text":"Music","font":40/);
    assert.match(error.message, /1024x768 viewport \(screen 1024x768, DPR 1\)/);
    assert.match(error.message, /below 1280x800/, 'a screen below the smallest supported Chat viewport is called out');
    assert.match(error.message, /every tile: .*"text":"yes"/, 'every tile is reported, not only the offending ones');
    return true;
  });
});

test('a Chat fit check that measured no tiles fails instead of passing vacuously', () => {
  assert.throws(() => assertChatTilesFit({ viewport: qaScreen, tiles: [] }), /no Chat tiles were measured/);
});

test('Chat fit diagnostics are bounded: long labels are cut and a missing animation frame is reported', () => {
  const long = 'x'.repeat(500);
  assert.throws(() => assertChatTilesFit({ viewport: { ...qaScreen, frame: false }, tiles: [tile(long, { fits: false })] }), error => {
    assert.equal(error.message.includes('x'.repeat(41)), false);
    assert.match(error.message, /no animation frame/);
    return true;
  });
});

// v1.0.36 leg B: a /settings request still in flight when the check unrouted
// rejected route.fulfill with "Route is already handled!" after the test ended.
const raced = message => Object.assign(new Error(message), { name: 'Error' });
function fakeRoute({ fetchError, fulfillError, body = { dwellMs: 1200, chatPromptMs: 12000, chatName: 'Sam' } } = {}) {
  const calls = [];
  const response = { json: async () => body };
  return { calls, route: {
    fetch: async () => { calls.push('fetch'); if (fetchError) throw raced(fetchError); return response; },
    fulfill: async options => { calls.push(['fulfill', options]); if (fulfillError) throw raced(fulfillError); },
    continue: async () => { calls.push('continue'); if (fulfillError) throw raced(fulfillError); },
  } };
}

test('the smoke check turns the options reading off for its own page: /settings is answered with chatPromptMs 0', async () => {
  const { route, calls } = fakeRoute();
  await rewriteSettingsRoute(route);
  assert.equal(calls[0], 'fetch');
  assert.deepEqual(calls[1][1].json, { dwellMs: 1200, chatPromptMs: 0, chatName: 'Sam' });
});

test('a route the check no longer owns (already handled, page or browser closed) settles quietly; anything else still fails', async () => {
  for (const message of ['route.fulfill: Route is already handled!', 'route.fetch: Target page, context or browser has been closed', 'route.continue: Request context disposed.']) {
    for (const where of ['fetchError', 'fulfillError']) {
      const { route } = fakeRoute({ [where]: message });
      await assert.doesNotReject(rewriteSettingsRoute(route), `${where}: ${message}`);
    }
    await assert.doesNotReject(settleRoute(Promise.reject(raced(message))), message);
  }
  const { route } = fakeRoute({ body: null });
  await rewriteSettingsRoute(route);
  await assert.rejects(settleRoute(Promise.reject(raced('route.fulfill: something else broke'))), /something else broke/);
  assert.equal(await settleRoute(Promise.resolve(7)), 7);
});
