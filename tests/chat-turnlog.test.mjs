// Chat test mode's client half (public/chat/turnlog.js, spec 2026-10-27 §5):
// the turn record is assembled beside the production timing rows, never in
// them, and what it posts is exactly what the hub's strict schema accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const load = async file => import(`data:text/javascript;base64,${Buffer.from(await readFile(new URL(file, import.meta.url), 'utf8')).toString('base64')}`);
const { createTurnLog, observeMetrics, micLevel, stageChoices } = await load('../public/chat/turnlog.js');
const { createTurnMetrics } = await load('../public/chat/metrics.js');
const { validateTurn } = createRequire(import.meta.url)('../chat-turns.js');
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function setup({ on = true, health = async at => ({ cpuBusy: 0.25, load1: null, freeMemBytes: 1e9, totalMemBytes: 8e9, eventLoopLagMs: 2, gaze: 'running', rtt: { transcription: 30, reply: null } }) } = {}) {
  let clock = 1000, enabled = on, ids = 0;
  const requests = [];
  const log = createTurnLog({ enabled: () => enabled, now: () => clock, wallClock: () => Date.UTC(2026, 9, 27, 18), health,
    randomId: () => ID.slice(0, -1) + (ids++ % 10),
    fetch: async (url, init) => { requests.push({ url, init }); return new Response('{}', { status: 201 }); } });
  const storage = new Map();
  const metrics = createTurnMetrics({ now: () => clock, storage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) } });
  return { log, metrics, wrapped: observeMetrics(metrics, log), requests, tick(ms) { clock += ms; }, set(value) { enabled = value; } };
}
function heldTurn(s) {
  const m = s.wrapped, h = m.begin('hold');
  s.log.set(h, { mode: 'one-shot', session: '9b2c1a7e-1111-4222-8333-944455556666' });
  s.tick(300); s.log.audio(h, new Int16Array([1000, -1000, 32767, 0]).buffer); s.log.audio(h, new Int16Array([100, -100]).buffer);
  s.log.partial(h, 'would you'); s.tick(100); s.log.partial(h, 'would you like');
  s.tick(500); m.mark(h, 'release'); s.log.sample(h, 'release');
  s.tick(40); m.mark(h, 'drained'); m.mark(h, 'finishSent'); s.tick(30); m.mark(h, 'finishAck');
  s.tick(400); m.mark(h, 'transcript');
  m.observe(h, { activityMs: 3, cloudMs: 380, finalDecodeMs: 390, audioMs: 900, captureWallMs: 930, turnMs: 410, finalizeMs: 12 });
  s.log.content(h, { transcript: 'Would you like music or a story?' });
  s.tick(600); m.mark(h, 'choicesReady');
  s.log.staged(h, [{ id: '3:0', label: 'Music', say: 'Music' }, { id: '3:1', label: 'A story', say: 'A story' }], { kind: 'generated', usage: { model: 'reply-model-x', inputTokens: 700, cachedTokens: 0, outputTokens: 40 } });
  s.log.fetched(h, 5, 'Music'); s.log.fetched(h, 7, 'A story'); s.log.fetched(h, 10, 'Warm words');
  s.tick(800); m.mark(h, 'revealed'); s.log.sample(h, 'reveal');
  s.tick(900); s.log.content(h, { selected: { id: '3:0', label: 'Music', say: 'Music' } }); m.mark(h, 'selected');
  s.log.content(h, { spoken: 'Music' }); s.log.usage(h, { voice: { chars: 5, cache: 'hit' } });
  s.tick(150); m.mark(h, 'playbackStart'); s.tick(700); m.mark(h, 'playbackEnd');
  m.end(h, 'completed');
  return h;
}

test('off: nothing is recorded or posted and the production rows are byte-for-byte what metrics alone writes', async () => {
  const off = setup({ on: false }), plain = setup({ on: false });
  heldTurn(off);
  // The same marks straight through metrics, with no test-mode wrapper at all.
  const m = plain.metrics, h = m.begin('hold');
  plain.tick(900); m.mark(h, 'release'); plain.tick(40); m.mark(h, 'drained'); m.mark(h, 'finishSent'); plain.tick(30); m.mark(h, 'finishAck');
  plain.tick(400); m.mark(h, 'transcript'); m.observe(h, { activityMs: 3, cloudMs: 380, finalDecodeMs: 390, audioMs: 900, captureWallMs: 930, turnMs: 410, finalizeMs: 12 });
  plain.tick(600); m.mark(h, 'choicesReady'); plain.tick(800); m.mark(h, 'revealed'); plain.tick(900); m.mark(h, 'selected');
  plain.tick(150); m.mark(h, 'playbackStart'); plain.tick(700); m.mark(h, 'playbackEnd'); m.end(h, 'completed');
  await flush();
  assert.equal(off.requests.length, 0);
  assert.deepEqual(off.log.recent(), []);
  assert.deepEqual(off.metrics.snapshot(), plain.metrics.snapshot());
});

test('on: the production rows are still identical and content-free; the record goes its own way', async () => {
  const on = setup(), off = setup({ on: false });
  heldTurn(on); heldTurn(off); await flush();
  assert.deepEqual(on.metrics.snapshot(), off.metrics.snapshot());
  assert.doesNotMatch(JSON.stringify(on.metrics.snapshot()), /music|story|would you|reply-model|running/i);
});

test('on: a held turn posts one record with the full timeline, words, usage, health and mic level, accepted by the hub schema', async () => {
  const s = setup(); heldTurn(s); await flush();
  const posts = s.requests.filter(r => r.url === '/chat/api/turns');
  assert.equal(posts.length, 1);
  const { init } = posts[0];
  assert.equal(init.method, 'POST'); assert.equal(init.keepalive, true); assert.equal(init.headers['Content-Type'], 'application/json');
  const record = JSON.parse(init.body);
  assert.deepEqual(validateTurn(record), record);
  assert.equal(record.id, ID.slice(0, -1) + '0'); assert.equal(record.kind, 'hold'); assert.equal(record.mode, 'one-shot');
  assert.equal(record.startedAt, '2026-10-27T18:00:00.000Z'); assert.equal(record.outcome, 'completed'); assert.equal('reason' in record, false);
  assert.deepEqual(record.stages.map(x => x.name), ['begin', 'firstPartial', 'partial', 'partial', 'release', 'drained', 'finishSent', 'finishAck', 'transcript',
    'choicesReady', 'firstChoiceStaged', 'choiceStaged', 'choiceStaged', 'batchSealed', 'revealed', 'selected', 'playbackStart', 'firstAudio', 'playbackEnd']);
  const at = name => record.stages.find(x => x.name === name).ms;
  assert.equal(at('begin'), 0); assert.equal(at('release'), 900); assert.equal(at('transcript'), 1370); assert.equal(at('playbackEnd'), 4520);
  assert.deepEqual(record.stages.filter(x => x.name === 'partial').map(x => [x.ms, x.text]), [[300, 'would you'], [400, 'would you like']]);
  assert.deepEqual(record.stages.filter(x => x.name === 'choiceStaged').map(x => x.text), ['Music', 'A story']);
  assert.deepEqual(record.worker, { activityMs: 3, cloudMs: 380, finalDecodeMs: 390, audioMs: 900, captureWallMs: 930, turnMs: 410, finalizeMs: 12 });
  assert.deepEqual(record.content, { partials: ['would you', 'would you like'], transcript: 'Would you like music or a story?', choiceKind: 'generated',
    choices: [{ id: '3:0', label: 'Music', say: 'Music' }, { id: '3:1', label: 'A story', say: 'A story' }],
    selected: { id: '3:0', label: 'Music', say: 'Music' }, spoken: 'Music', keyterms: null });
  assert.deepEqual(record.usage, { reply: { model: 'reply-model-x', inputTokens: 700, cachedTokens: 0, outputTokens: 40 }, audioSeconds: 0.9, socketSeconds: null,
    voice: { chars: 5, cache: 'hit', fetchedChars: 12 } });
  assert.equal(record.health.release.gaze, 'running'); assert.equal(record.health.reveal.cpuBusy, 0.25);
  assert.equal(record.mic.frames, 2); assert.equal(record.mic.clipped, 1); assert.ok(record.mic.peakRms > 0.5 && record.mic.peakRms <= 1);
  const audio = s.requests.filter(r => r.url === `/chat/api/turns/${record.id}/audio`);
  assert.equal(audio.length, 1); assert.equal(audio[0].init.method, 'PUT'); assert.equal(audio[0].init.headers['Content-Type'], 'application/octet-stream');
  assert.deepEqual([...new Int16Array(await new Blob([audio[0].init.body]).arrayBuffer())], [1000, -1000, 32767, 0, 100, -100]);
  assert.equal(s.log.recent().length, 1); assert.equal(s.log.recent()[0].content.transcript, 'Would you like music or a story?');
});

test('cancelled and failed turns post their reason and error text; a hold never finished keeps no audio', async () => {
  const s = setup(), m = s.wrapped;
  const h = m.begin('hold'); s.log.audio(h, new Int16Array(1600).buffer); s.tick(200);
  m.end(h, 'cancelled', 'cancel'); await flush();
  const failed = m.begin('typed'); m.mark(failed, 'transcript'); s.log.error(failed, 'Replies are unavailable. Chat is off. Your phrases still work.');
  m.end(failed, 'failed', 'choices'); await flush();
  const records = s.requests.filter(r => r.url === '/chat/api/turns').map(r => JSON.parse(r.init.body));
  assert.deepEqual(records.map(r => [r.kind, r.mode, r.outcome, r.reason]), [['hold', 'one-shot', 'cancelled', 'cancel'], ['typed', 'typed', 'failed', 'choices']]);
  assert.equal(records[1].error, 'Replies are unavailable. Chat is off. Your phrases still work.');
  for (const record of records) assert.deepEqual(validateTurn(record), record);
  assert.equal(s.requests.some(r => r.url.endsWith('/audio')), false, 'only a released and submitted hold keeps its audio');
});

test('bounds: 15 s of audio, 100 partials, 300 stages, long text cut, and a slow health sample never holds the record past its wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup({ health: () => new Promise(() => {}) }), m = s.wrapped, h = m.begin('hold');
  for (let i = 0; i < 200; i++) s.log.audio(h, new Int16Array(1600).buffer);
  for (let i = 0; i < 400; i++) s.log.partial(h, 'p'.repeat(3000));
  s.log.content(h, { transcript: 't'.repeat(5000), spoken: 's'.repeat(900) });
  m.mark(h, 'release'); s.log.sample(h, 'release'); m.mark(h, 'drained'); m.mark(h, 'finishSent');
  m.end(h, 'completed');
  await flush(); assert.equal(s.requests.length, 0, 'waits briefly for the health sample');
  t.mock.timers.tick(1600); await flush();
  const record = JSON.parse(s.requests.find(r => r.url === '/chat/api/turns').init.body);
  assert.deepEqual(validateTurn(record), record);
  assert.equal(record.health, undefined);
  const body = s.requests.find(r => r.url === '/chat/api/turns').init.body;
  assert.ok(body.length < 65536, 'a record fits the hub body cap: oldest partials go first');
  assert.ok(record.content.partials.length >= 1 && record.content.partials.length <= 100);
  assert.equal(record.content.transcript.length, 2000); assert.equal(record.content.spoken.length, 600);
  assert.ok(record.stages.length <= 300);
  const audio = s.requests.find(r => r.url.endsWith('/audio'));
  assert.equal((await new Blob([audio.init.body]).arrayBuffer()).byteLength, 480000);
  const short = m.begin('hold');
  for (let i = 0; i < 150; i++) s.log.partial(short, 'p' + i);
  m.end(short, 'cancelled', 'cancel'); await flush();
  const second = JSON.parse(s.requests.filter(r => r.url === '/chat/api/turns')[1].init.body);
  assert.equal(second.content.partials.length, 100); assert.equal(second.content.partials.at(-1), 'p149');
  assert.equal(second.stages.filter(x => x.name === 'partial').length, 100);
});

test('the live timeline counts from release and the recent list keeps ten', async () => {
  const s = setup(), seen = [];
  s.log.subscribe(value => seen.push(value));
  const h = s.wrapped.begin('hold'); s.tick(500); s.wrapped.mark(h, 'release'); s.tick(250); s.wrapped.mark(h, 'drained');
  assert.equal(seen.length, 1, 'marks add no synchronous work: listeners hear about them after the current task');
  await flush();
  assert.equal(seen.length, 2, 'several marks in one task are one redraw');
  assert.equal(typeof Object.getOwnPropertyDescriptor(seen[1], 'recent').get, 'function', 'the recent list is built only when read');
  const live = s.log.live();
  assert.deepEqual(live.stages.map(x => [x.name, x.sinceRelease]), [['begin', null], ['release', 0], ['drained', 250]]);
  s.wrapped.end(h, 'completed'); await flush();
  assert.equal(s.log.live(), null);
  for (let i = 0; i < 12; i++) { const x = s.wrapped.begin('fixed'); s.wrapped.end(x, 'completed'); }
  await flush();
  assert.equal(s.log.recent().length, 10);
  s.set(false); s.wrapped.end(s.wrapped.begin('fixed'), 'completed'); await flush();
  assert.equal(s.log.recent().length, 10, 'turned off, a new turn is not recorded');
});

test('micLevel reads PCM16 frames', () => {
  assert.deepEqual(micLevel(new Int16Array([0, 0]).buffer), { rms: 0, clipped: 0 });
  const loud = micLevel(new Int16Array([32767, -32768]).buffer);
  assert.equal(loud.clipped, 2); assert.ok(loud.rms > 0.99);
});

test('the body cap is counted in bytes, so words outside ASCII still fit the hub', async () => {
  const s = setup(), h = s.wrapped.begin('hold');
  for (let i = 0; i < 40; i++) s.log.partial(h, '€'.repeat(700));
  s.wrapped.end(h, 'cancelled', 'cancel'); await flush();
  const { init } = s.requests.find(r => r.url === '/chat/api/turns');
  assert.ok(Buffer.byteLength(init.body) < 65536, `${Buffer.byteLength(init.body)} bytes`);
  assert.equal(init.keepalive, true);
  const record = JSON.parse(init.body); assert.deepEqual(validateTurn(record), record);
});

test('staging hook: no work when the turn is not recorded, and a throwing picture lookup never reaches the caller', () => {
  const s = setup(), h = s.wrapped.begin('hold'); let looked = 0;
  const choices = [{ id: '1:0', label: 'Music', say: 'Music' }];
  assert.doesNotThrow(() => stageChoices(s.log, h, choices, { kind: 'generated' }, () => { looked++; throw new Error('picture table broken'); }));
  assert.equal(looked, 1);
  const off = setup({ on: false }), other = off.wrapped.begin('hold');
  stageChoices(off.log, other, choices, {}, () => { looked++; return 'x'; });
  assert.equal(looked, 1, 'nothing is computed for a turn that is not recorded');
  assert.doesNotThrow(() => stageChoices(null, h, choices, {}, () => 'x'));
});

test('a stage past the one-hour bound is clamped, never dropping the record', async () => {
  const s = setup(), h = s.wrapped.begin('fixed');
  s.tick(4000000); s.wrapped.mark(h, 'selected'); s.wrapped.end(h, 'completed'); await flush();
  const record = JSON.parse(s.requests.find(r => r.url === '/chat/api/turns').init.body);
  assert.deepEqual(validateTurn(record), record);
  assert.equal(record.stages.find(x => x.name === 'selected').ms, 3600000);
});

test('a keepalive post the browser refuses is sent once more without keepalive', async () => {
  const calls = [];
  const log = createTurnLog({ enabled: () => true, randomId: () => ID, health: async () => null,
    fetch: async (url, init) => { calls.push(init.keepalive); if (init.keepalive) throw new TypeError('keepalive refused'); return new Response('{}', { status: 201 }); } });
  const h = {}; log.begin(h, 'fixed'); log.end(h, 'completed'); await flush();
  assert.deepEqual(calls, [true, false]);
});

test('only this turn\'s own clips are charged to it: its staged choices and its spoken words', async () => {
  const s = setup(), h = s.wrapped.begin('typed');
  s.log.fetched(h, 10, 'Warm words');
  s.log.staged(h, [{ label: 'Yes', say: 'Yes please' }]); s.log.fetched(h, 10, 'Yes please');
  s.log.content(h, { spoken: 'Something else' }); s.log.fetched(h, 14, 'Something else');
  s.wrapped.end(h, 'completed'); await flush();
  const record = JSON.parse(s.requests.find(r => r.url === '/chat/api/turns').init.body);
  assert.equal(record.usage.voice.fetchedChars, 24);
});

test('staged choices keep the hub picture word and pictogram id, and the hub schema accepts them', async () => {
  const s = setup(), h = s.wrapped.begin('typed');
  const choices = [{ id: '1:0', label: 'Pizza', say: 'Pizza please.', symbol: 'pizza', symbolId: 2527 },
    { id: '1:1', label: 'Not now', say: 'Not now.', symbol: 'not now', symbolId: 13080 }, { id: '1:2', label: 'Hmm', say: 'Hmm.' }];
  stageChoices(s.log, h, choices, { kind: 'generated' }, choice => choice.symbol || 'chat');
  s.wrapped.mark(h, 'selected'); s.wrapped.end(h, 'completed'); await flush();
  const record = JSON.parse(s.requests.find(r => r.url === '/chat/api/turns').init.body);
  assert.deepEqual(record.content.choices.map(choice => [choice.symbol, choice.symbolId]), [['pizza', 2527], ['not now', 13080], ['chat', undefined]]);
  assert.deepEqual(validateTurn(record), record);
  assert.throws(() => validateTurn({ ...record, content: { ...record.content, choices: [{ label: 'x', say: 'x', symbolId: -1 }] } }), /invalid-turn/);
});

test('a streamed turn records the phase-2 marks: socket, settled, speculation, each staged choice once, socket seconds and the keyterm count', async () => {
  const s = setup(), m = s.wrapped, h = m.begin('hold');
  s.log.set(h, { mode: 'stream', session: '9b2c1a7e-1111-4222-8333-944455556666' });
  s.tick(20); s.log.mark(h, 'socketConnect');
  s.tick(300); s.log.partial(h, 'what should we');
  s.tick(300); s.log.mark(h, 'speculativeStart'); s.tick(100); s.log.mark(h, 'speculativeDiscard'); s.log.mark(h, 'speculativeStart');
  s.tick(200); m.mark(h, 'release'); m.mark(h, 'drained'); m.mark(h, 'finishSent'); s.tick(10); m.mark(h, 'finishAck');
  s.tick(120); s.log.mark(h, 'settled'); s.tick(200); m.mark(h, 'transcript');
  m.observe(h, { audioMs: 1100, firstPartialMs: 300, finalizeMs: 320, connectMs: 0, settledMs: 120, wordsSettledMs: 100, turnMs: 1450 });
  s.log.set(h, { mode: 'stream', setting: 'fallback' }); s.log.usage(h, { stream: { socketSeconds: 41.5, keytermsFired: 2 } });
  s.log.mark(h, 'speculativeKeep');
  s.tick(30); s.log.stagedOne(h, { label: 'Play', say: 'Let us play.' }); s.tick(40); s.log.stagedOne(h, { label: 'Read', say: 'I want to read.' });
  s.tick(5); m.mark(h, 'choicesReady');
  s.log.staged(h, [{ id: '4:0', label: 'Play', say: 'Let us play.' }, { id: '4:1', label: 'Read', say: 'I want to read.' }], { kind: 'generated' });
  m.mark(h, 'revealed'); m.end(h, 'cancelled', 'superseded');
  await flush();
  const record = JSON.parse(s.requests.find(r => r.url === '/chat/api/turns').init.body);
  assert.deepEqual(validateTurn(record), record);
  const names = record.stages.map(x => x.name);
  assert.deepEqual(names.filter(n => /^speculative/.test(n)), ['speculativeStart', 'speculativeDiscard', 'speculativeStart', 'speculativeKeep']);
  assert.ok(names.includes('socketConnect') && names.includes('settled'));
  assert.deepEqual(record.stages.filter(x => x.name === 'choiceStaged').map(x => [x.ms, x.text]), [[1280, 'Play'], [1320, 'Read']]);
  assert.equal(names.filter(n => n === 'firstChoiceStaged').length, 1);
  assert.equal(record.mode, 'stream'); assert.equal(record.setting, 'fallback');
  assert.equal(record.usage.socketSeconds, 41.5); assert.equal(record.content.keytermsFired, 2); assert.equal(record.content.keyterms, null, 'counts only, never the words');
  assert.equal(record.worker.connectMs, 0); assert.equal(record.worker.settledMs, 120);
});

test('a batch whose model pictures the hub rejected records the count only, and the hub schema accepts it', async () => {
  const s = setup(), h = s.wrapped.begin('typed');
  const choices = [{ id: '1:0', label: 'Meatballs', say: 'Meatballs, please.', symbol: 'meat', symbolId: 2316 },
    { id: '1:1', label: 'Beef mushrooms', say: 'Beef and mushrooms, please.', symbol: 'food', symbolId: 4610 }];
  stageChoices(s.log, h, choices, { kind: 'generated', symbolRejected: 1 }, choice => choice.symbol);
  s.wrapped.mark(h, 'selected'); s.wrapped.end(h, 'completed'); await flush();
  const record = JSON.parse(s.requests.find(r => r.url === '/chat/api/turns').init.body);
  assert.equal(record.content.symbolRejected, 1);
  assert.deepEqual(validateTurn(record), record);
  assert.throws(() => validateTurn({ ...record, content: { ...record.content, symbolRejected: 'monday' } }), /invalid-turn/);
  assert.throws(() => validateTurn({ ...record, content: { ...record.content, symbolRejected: 7 } }), /invalid-turn/);
  // No rejection, no field.
  const t2 = setup(), h2 = t2.wrapped.begin('typed');
  stageChoices(t2.log, h2, choices, { kind: 'generated', symbolRejected: 0 }, choice => choice.symbol);
  t2.wrapped.end(h2, 'completed'); await flush();
  assert.equal('symbolRejected' in JSON.parse(t2.requests.find(r => r.url === '/chat/api/turns').init.body).content, false);
});

test('the pictures the hub warmed for a hold are a count in the record, and the hub schema bounds it', async () => {
  const s = setup(), h = s.wrapped.begin('typed');
  const choices = [{ id: '1:0', label: 'Lasagna', say: 'Lasagna, please.', symbol: 'lasagna', symbolId: 9051 }];
  stageChoices(s.log, h, choices, { kind: 'alternatives', pictureWarm: 3 }, choice => choice.symbol);
  s.wrapped.mark(h, 'selected'); s.wrapped.end(h, 'completed'); await flush();
  const record = JSON.parse(s.requests.find(r => r.url === '/chat/api/turns').init.body);
  assert.equal(record.content.pictureWarm, 3);
  assert.deepEqual(validateTurn(record), record);
  assert.deepEqual(validateTurn({ ...record, content: { ...record.content, pictureWarm: 0 } }).content.pictureWarm, 0);
  assert.throws(() => validateTurn({ ...record, content: { ...record.content, pictureWarm: 13 } }), /invalid-turn/);
  assert.throws(() => validateTurn({ ...record, content: { ...record.content, pictureWarm: 'lasagna' } }), /invalid-turn/);
  const t2 = setup(), h2 = t2.wrapped.begin('typed');
  stageChoices(t2.log, h2, choices, { kind: 'alternatives', pictureWarm: 'lasagna' }, choice => choice.symbol);
  t2.wrapped.end(h2, 'completed'); await flush();
  assert.equal('pictureWarm' in JSON.parse(t2.requests.find(r => r.url === '/chat/api/turns').init.body).content, false, 'never anything but a count');
});

// A hold let go too soon (under 400 ms, or before any audio) is cancelled with its own reason, "short",
// in the production timing row and the test-mode record alike; the hub schema accepts it.
test('a hold let go too soon is cancelled with reason "short" in the timing row and the posted record', async () => {
  const s = setup(), m = s.wrapped;
  const h = m.begin('hold'); s.log.set(h, { mode: 'stream', session: '9b2c1a7e-1111-4222-8333-944455556666' }); s.tick(241);
  m.end(h, 'cancelled', 'short'); await flush();
  const record = s.requests.filter(r => r.url === '/chat/api/turns').map(r => JSON.parse(r.init.body))[0];
  assert.equal(record.outcome, 'cancelled'); assert.equal(record.reason, 'short');
  assert.deepEqual(validateTurn(record), record);
  assert.equal(s.metrics.snapshot().turns.at(-1).reason, 'short');
});

test('an open-ended question\'s shape and a thrown-out recall batch are category words in the record, and the hub schema bounds them', async () => {
  const s = setup(), h = s.wrapped.begin('typed');
  const choices = [{ id: '1:0', label: 'Give me a clue', say: 'Can you give me a clue?', symbol: 'clue', symbolId: 6531 }];
  stageChoices(s.log, h, choices, { kind: 'guarded', shape: 'recall', recallRejected: true, likes: ['draw'] }, choice => choice.symbol);
  s.wrapped.mark(h, 'selected'); s.wrapped.end(h, 'completed'); await flush();
  const record = JSON.parse(s.requests.find(r => r.url === '/chat/api/turns').init.body);
  assert.equal(record.content.shape, 'recall');
  assert.equal(record.content.recallRejected, true);
  assert.ok(!JSON.stringify(record).includes('draw'), 'the likes never go in a record');
  assert.deepEqual(validateTurn(record), record);
  assert.deepEqual(validateTurn({ ...record, content: { ...record.content, shape: null } }).content.shape, null);
  assert.throws(() => validateTurn({ ...record, content: { ...record.content, shape: 'wonder' } }), /invalid-turn/);
  assert.throws(() => validateTurn({ ...record, content: { ...record.content, recallRejected: 'yes' } }), /invalid-turn/);
  const t2 = setup(), h2 = t2.wrapped.begin('typed');
  stageChoices(t2.log, h2, choices, { kind: 'generated', shape: 'wonder', recallRejected: 'yes' }, choice => choice.symbol);
  t2.wrapped.end(h2, 'completed'); await flush();
  const plain = JSON.parse(t2.requests.find(r => r.url === '/chat/api/turns').init.body).content;
  assert.equal('shape' in plain, false); assert.equal('recallRejected' in plain, false);
});

test('her world\'s size, never its text, is in the record, and the hub schema bounds it', async () => {
  const s = setup(), h = s.wrapped.begin('typed');
  const choices = [{ id: '1:0', label: 'Magnets', say: 'Learning about magnets.', symbol: 'chat', symbolId: 6531 }];
  stageChoices(s.log, h, choices, { kind: 'generated', shape: 'open', world: { weeks: 2, days: 3, chars: 5900, text: 'Magnets!' } }, choice => choice.symbol);
  s.wrapped.mark(h, 'selected'); s.wrapped.end(h, 'completed'); await flush();
  const record = JSON.parse(s.requests.find(r => r.url === '/chat/api/turns').init.body);
  assert.deepEqual(record.content.world, { weeks: 2, days: 3, chars: 5900 });
  assert.ok(!JSON.stringify(record).includes('Magnets!'), 'the text never goes in a record');
  assert.deepEqual(validateTurn(record), record);
  assert.deepEqual(validateTurn({ ...record, content: { ...record.content, world: { weeks: 1, chars: 10 } } }).content.world, { weeks: 1, chars: 10 }, 'days may be absent');
  for (const world of [{ weeks: 2 }, { weeks: -1, chars: 1 }, { weeks: 1, chars: 6001 }, { weeks: 1, days: -1, chars: 5 }, { weeks: 1, days: 32, chars: 5 }, { weeks: 1, chars: 10, text: 'x' }, 'Magnets'])
    assert.throws(() => validateTurn({ ...record, content: { ...record.content, world } }), /invalid-turn/, JSON.stringify(world));
  const t2 = setup(), h2 = t2.wrapped.begin('typed');
  stageChoices(t2.log, h2, choices, { kind: 'generated', world: { weeks: 'two', chars: 5 } }, choice => choice.symbol);
  t2.wrapped.end(h2, 'completed'); await flush();
  assert.equal('world' in JSON.parse(t2.requests.find(r => r.url === '/chat/api/turns').init.body).content, false);
});

test('the stable frame\'s uses are in the record: the mode she swapped to, the page she opened, Something else (spec 2026-10-28 §4)', async () => {
  const s = setup(), h = s.wrapped.begin('typed');
  s.log.content(h, { mode: 'ask' }); s.log.content(h, { page: 'about' }); s.log.content(h, { again: true });
  s.log.content(h, { mode: 'comment' }); // the last swap wins
  s.wrapped.end(h, 'completed'); await flush();
  const record = JSON.parse(s.requests.find(r => r.url === '/chat/api/turns').init.body);
  assert.equal(record.content.mode, 'comment'); assert.equal(record.content.page, 'about'); assert.equal(record.content.again, true);
  const t = setup(), h2 = t.wrapped.begin('typed');
  t.log.content(h2, { mode: 'shout', page: 'diary', again: 'yes' });
  t.log.content(h2, { mode: 7, page: null, again: false });
  t.wrapped.end(h2, 'completed'); await flush();
  const plain = JSON.parse(t.requests.find(r => r.url === '/chat/api/turns').init.body).content;
  for (const key of ['mode', 'page', 'again']) assert.equal(key in plain, false, key);
  const off = setup({ on: false }), h3 = off.wrapped.begin('typed');
  off.log.content(h3, { mode: 'ask', page: 'questions', again: true }); off.wrapped.end(h3, 'completed'); await flush();
  assert.equal(off.requests.length, 0, 'nothing is written in production mode');
});
