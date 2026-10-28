import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const load = async file => import(`data:text/javascript;base64,${Buffer.from(await readFile(new URL(file, import.meta.url), 'utf8')).toString('base64')}`);
const { createTurnMetrics } = await load('../public/chat/metrics.js');
const { createChatController } = await load('../public/chat/controller.js');
function setup(options = {}) {
  let time = 0, saved = '';
  const storage = { getItem: () => saved || null, setItem: (_key, value) => { saved = value; }, removeItem: () => { saved = ''; } };
  const metrics = createTurnMetrics({ now: () => time, storage, ...options });
  return { metrics, storage, at(value) { time = value; }, get saved() { return saved; } };
}

test('turn stages separate transport, recognition, generation, reveal and actual playback', () => {
  const s = setup(), t = s.metrics.begin('hold');
  for (const [stage, at] of [['release', 1000], ['drained', 1100], ['finishSent', 1120], ['finishAck', 1150], ['transcript', 2500], ['choicesReady', 2900], ['revealed', 4000], ['selected', 5000], ['playbackStart', 5100], ['playbackEnd', 5600]]) { s.at(at); s.metrics.mark(t, stage); }
  s.metrics.observe(t, { activityMs: 12, cloudMs: 1300, finalDecodeMs: 1312, audioMs: 900, choicesServerMs: 350 });
  s.metrics.end(t, 'completed');
  const row = s.metrics.snapshot().turns[0];
  assert.equal(row.status, 'completed');
  assert.deepEqual(row.timings, { holdMs: 1000, releaseToDrainedMs: 100, drainToFinishSentMs: 20, finishRoundTripMs: 30,
    finishToTranscriptMs: 1380, releaseToTranscriptMs: 1500, transcriptToChoicesMs: 400, choicesToRevealMs: 1100,
    revealToSelectMs: 1000, selectionToPlaybackMs: 100, playbackMs: 500, releaseToPlaybackMs: 4100,
    workerActivityMs: 12, workerCloudMs: 1300, workerFinalMs: 1312, audioMs: 900, choicesServerMs: 350, totalMs: 5600 });
});

test('storage and export contain only allowed enums and finite durations, never supplied content', () => {
  const s = setup(), t = s.metrics.begin('hold'); s.metrics.mark(t, 'private-question');
  s.metrics.observe(t, { activityMs: -1, cloudMs: Infinity, finalDecodeMs: 5, text: 'secret question', session: 'private-session', label: 'private-name' });
  s.metrics.end(t, 'failed', 'a private failure containing a name');
  const exported = s.metrics.exportJSON();
  for (const value of ['secret', 'private', 'question', 'session', 'label']) assert.equal(exported.includes(value), false);
  assert.deepEqual(s.metrics.snapshot().turns[0].timings, { workerFinalMs: 5, totalMs: 0 });
  assert.equal(s.metrics.snapshot().turns[0].reason, 'other'); assert.equal(s.saved, exported);
});

test('cancelled and failed turns stay separate from completed timing aggregates', () => {
  const s = setup(); let at = 0;
  for (const duration of [100, 200, 300]) {
    s.at(at); const t = s.metrics.begin('hold'); s.metrics.mark(t, 'release'); s.at(at + duration); s.metrics.mark(t, 'transcript'); s.metrics.end(t, 'completed'); at += 1000;
  }
  const cancelled = s.metrics.begin('hold'); s.metrics.mark(cancelled, 'release'); s.at(at + 10000); s.metrics.mark(cancelled, 'transcript'); s.metrics.end(cancelled, 'cancelled', 'cancel');
  const failed = s.metrics.begin('typed'); s.metrics.end(failed, 'failed', 'choices');
  const summary = s.metrics.snapshot().summary;
  assert.deepEqual(summary.counts, { open: 0, completed: 3, cancelled: 1, failed: 1 });
  assert.deepEqual(summary.groups.hold.releaseToTranscriptMs, { samples: 3, medianMs: 200, p95Ms: null });
  assert.equal(summary.groups.typed, undefined);
});

test('tail statistics require twenty completed samples; medians require three', () => {
  const s = setup();
  for (let i = 0; i < 20; i++) { s.at(i * 100); const t = s.metrics.begin('hold'); s.metrics.mark(t, 'release'); s.at(i * 100 + i); s.metrics.mark(t, 'transcript'); s.metrics.end(t, 'completed'); }
  assert.deepEqual(s.metrics.snapshot().summary.groups.hold.releaseToTranscriptMs, { samples: 20, medianMs: 9.5, p95Ms: 18.1 });
  const one = setup(), t = one.metrics.begin('fixed'); one.metrics.mark(t, 'selected'); one.at(25); one.metrics.mark(t, 'playbackStart'); one.metrics.end(t, 'completed');
  assert.deepEqual(one.metrics.snapshot().summary.groups.fixed.selectionToPlaybackMs, { samples: 1, medianMs: null, p95Ms: null });
});

test('retention, stale callbacks, missing playback events, reload recovery and clear stay bounded', () => {
  const s = setup({ limit: 3 }), old = s.metrics.begin('hold'); s.metrics.end(old, 'cancelled', 'cancel');
  s.metrics.mark(old, 'playbackStart');
  for (let i = 0; i < 4; i++) s.metrics.begin('typed');
  assert.equal(s.metrics.snapshot().turns.length, 3);
  const restored = createTurnMetrics({ storage: s.storage, limit: 3, now: () => 0 });
  assert.ok(restored.snapshot().turns.every(row => row.status === 'cancelled' && row.reason === 'reload'));
  assert.ok(restored.snapshot().turns.every(row => !('selectionToPlaybackMs' in row.timings)));
  restored.clear(); assert.equal(restored.snapshot().turns.length, 0); assert.equal(s.saved, '');
});

test('malformed or content-bearing stored rows are sanitized and storage failures never stop communication', () => {
  const storage = { getItem: () => JSON.stringify({ turns: [{ kind: 'hold', status: 'completed', text: 'private', session: 'private', timings: { totalMs: 5, raw: 'private', holdMs: -2 } }] }), setItem() { throw Error('full'); }, removeItem() { throw Error('blocked'); } };
  const m = createTurnMetrics({ storage }); const t = m.begin('fixed'); m.end(t, 'completed'); m.clear();
  assert.equal(m.snapshot().turns.length, 0);
  const restored = createTurnMetrics({ storage });
  assert.deepEqual(restored.snapshot().turns[0], { kind: 'hold', status: 'completed', timings: { totalMs: 5 } });
});

test('controller emits timing-only events only for current ready/reveal/valid selection', async () => {
  const events = [], c = createChatController({ requestChoices: async () => ({ choices: [{ label: 'private label', say: 'private answer' }] }), speak: async () => true, onTiming: name => events.push(name) });
  await c.prepare('private question');
  assert.deepEqual(events, ['choicesReady', 'revealed']);
  assert.equal(await c.select('old-invalid-id'), false); await c.select(c.state.choices[0].id);
  assert.deepEqual(events, ['choicesReady', 'revealed', 'selected', 'speechRequested']);
  assert.equal(JSON.stringify(events).includes('private'), false);
});

test('late choices never emit metrics for a replacement turn; metric callbacks cannot break communication', async () => {
  let resolve; const pending = new Promise(r => { resolve = r; }); const events = [];
  const c = createChatController({ requestChoices: () => pending, onTiming: name => events.push(name) });
  const prepare = c.prepare('old'); c.stop(); resolve({ choices: [{ label: 'old', say: 'old' }] }); await prepare;
  assert.deepEqual(events, []);
  const safe = createChatController({ onTiming() { throw Error('metrics unavailable'); }, speak: async () => true });
  assert.equal(await safe.sayFixed('still speaks'), true);
});

test('saved voice failure offers an explicit device-voice choice without exposing raw errors', async () => {
  const c = createChatController({ speak: async () => { throw Object.assign(new Error('private transport detail'), { code: 'saved-voice-unavailable' }); } });
  await c.sayFixed('an answer');
  assert.match(c.state.error, /choose device voice/i); assert.equal(c.state.error.includes('private'), false);
});

test('an explicit speech retry clears the obsolete saved-voice error and preserves reply choices', async () => {
  let attempt = 0;
  const c = createChatController({ requestChoices: async () => ({ choices: [{ label: 'an answer', say: 'an answer' }] }),
    speak: async () => { if (!attempt++) throw Object.assign(new Error('private error'), { code: 'saved-voice-unavailable' }); return true; } });
  await c.prepare('a question'); const choices = c.state.choices;
  await c.select(choices[0].id); assert.match(c.state.error, /choose device voice/i);
  await c.select(choices[0].id); assert.equal(c.state.error, ''); assert.equal(c.state.choices, choices);
});

test('local audio drain has a real deadline and clears its timer on success or failure', async () => {
  const source = await readFile(new URL('../public/chat/app.js', import.meta.url), 'utf8');
  const helper = source.match(/^function waitForAudioDrain\([\s\S]*?^\}/m)?.[0];
  assert.ok(helper, 'the application uses a bounded audio drain');
  const context = vm.createContext({ Promise, Error, setTimeout, clearTimeout }); vm.runInContext(helper, context);
  await assert.rejects(context.waitForAudioDrain(new Promise(() => {}), 10), /audio.*finish|finish.*audio/i);
  await context.waitForAudioDrain(Promise.resolve(), 1000);
  await assert.rejects(context.waitForAudioDrain(Promise.reject(new Error('upload failed')), 1000), /upload failed/);
});

test('Preparing paints as Preparing: there is no hidden "Replies ready" batch to look for', async () => {
  const source = await readFile(new URL('../public/chat/app.js', import.meta.url), 'utf8');
  const helper = source.match(/^function paintPhase\([\s\S]*?^\}/m)?.[0]; assert.ok(helper);
  const element = { textContent: '' }, state = { phase: 'Preparing' };
  const context = vm.createContext({ $: () => element, controller: { state }, remoteStreaming: false, mode: 'blocked', questionSending: false, press: null });
  vm.runInContext(helper, context); context.paintPhase();
  assert.equal(element.textContent, 'Preparing');
  context.paintPhase({ phase: 'Preparing', staged: true }); assert.equal(element.textContent, 'Preparing');
  assert.equal(/Replies ready|black space/.test(source), false, 'no staged-batch wording remains');
  // A button-press window paints its own phase while it is open.
  const pressed = vm.createContext({ $: () => element, controller: { state: { phase: 'Preparing' } }, remoteStreaming: false, mode: 'blocked', questionSending: false, press: { closed: false, listening: true } });
  vm.runInContext(helper, pressed); pressed.paintPhase(); assert.equal(element.textContent, 'Listening');
  pressed.press = { closed: false, listening: false }; pressed.paintPhase(); assert.equal(element.textContent, 'Starting to listen');
});
