// Chat test mode (real-time chat spec 2026-10-27 §5): the per-turn record
// writer, its strict schema, bounded files and audio, the delete control, the
// price table and the device health sample. No hub, credentials or paid calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createChatTurns, validateTurn, estimateCost, summarize, testModeOn, applyTestModeSetting, localDay } = require('../chat-turns.js');
const { initPool } = require('../pool.js');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
function turnRecord(patch = {}) {
  return {
    version: 1, id: ID, kind: 'hold', mode: 'one-shot', session: '9b2c1a7e-1111-4222-8333-944455556666',
    startedAt: '2026-10-27T18:00:00.000Z', outcome: 'completed',
    stages: [{ name: 'release', ms: 900 }, { name: 'firstPartial', ms: 1000, text: 'would you' }, { name: 'partial', ms: 1000, text: 'would you' },
      { name: 'drained', ms: 950 }, { name: 'finishSent', ms: 955 }, { name: 'finishAck', ms: 990 }, { name: 'transcript', ms: 1500 },
      { name: 'choicesReady', ms: 2300 }, { name: 'firstChoiceStaged', ms: 2300, text: 'Music' }, { name: 'choiceStaged', ms: 2300, text: 'Music' },
      { name: 'choiceStaged', ms: 2300, text: 'A story' }, { name: 'batchSealed', ms: 2900 }, { name: 'revealed', ms: 2900 },
      { name: 'selected', ms: 4000 }, { name: 'playbackStart', ms: 4200 }, { name: 'firstAudio', ms: 4200 }, { name: 'playbackEnd', ms: 5000 }],
    worker: { audioMs: 800, captureWallMs: 830, activityMs: 3, cloudMs: 500, finalDecodeMs: 510, turnMs: 540, firstPartialMs: null },
    content: { transcript: 'Would you like music or a story?', partials: ['would you'], choiceKind: 'alternatives',
      choices: [{ id: '3:0', label: 'Music', say: 'Music', symbol: null }, { id: '3:1', label: 'A story', say: 'A story' }],
      selected: { id: '3:0', label: 'Music', say: 'Music' }, spoken: 'Music', keyterms: null },
    usage: { reply: { model: 'reply-model-x', inputTokens: 900, cachedTokens: 100, outputTokens: 60 }, audioSeconds: 0.8, socketSeconds: null,
      voice: { chars: 5, cache: 'hit', fetchedChars: 12 } },
    health: { release: { cpuBusy: 0.2, load1: null, freeMemBytes: 1e9, totalMemBytes: 8e9, eventLoopLagMs: 3, gaze: 'running', rtt: { transcription: 40, reply: null } } },
    mic: { peakRms: 0.31, clipped: 0, frames: 8 },
    ...patch,
  };
}
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-turns-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
const exists = file => fs.stat(file).then(() => true, () => false);
// Day files are named by the device's LOCAL day; the pool (pool.js) keeps its own UTC day files.
const pad2 = n => String(n).padStart(2, '0');
const day = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const poolDay = () => new Date().toISOString().slice(0, 10);

async function service(t, options = {}) {
  const dataDir = options.dataDir || await directory(t);
  const pool = options.pool === undefined ? initPool(dataDir, 'test-device') : options.pool;
  let on = options.on ?? true;
  const turns = createChatTurns({ dataDir, pool, deviceId: 'test-device', build: () => '20261027.1800', enabled: () => on,
    env: () => options.env || {}, gaze: () => 'running', ...options.extra });
  const server = http.createServer((req, res) => { if (!turns.handle(req, res)) res.writeHead(418).end(); });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  t.after(async () => { turns.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://localhost:${server.address().port}/chat/api`;
  const post = (body, headers = {}) => fetch(base + '/turns', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const audio = (id, bytes, headers = {}) => fetch(`${base}/turns/${id}/audio`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...headers }, body: bytes });
  return { dataDir, pool, turns, base, post, audio, setOn(value) { on = value; }, logDir: path.join(dataDir, 'logs', 'chat-turns') };
}

test('the schema accepts a complete turn and returns an equal copy', () => {
  const record = turnRecord();
  assert.deepEqual(validateTurn(record), record);
  for (const outcome of ['cancelled', 'failed']) assert.equal(validateTurn(turnRecord({ outcome, reason: 'cancel', error: 'Question canceled.' })).outcome, outcome);
  assert.equal(validateTurn(turnRecord({ kind: 'typed', mode: 'typed', session: null, stages: [{ name: 'transcript', ms: 0 }] })).kind, 'typed');
});

test('the schema rejects unknown fields, unknown stages, unbounded text and unsafe ids', () => {
  const big = 'x'.repeat(2001);
  const bad = [
    { secret: 1 }, { id: '../../escape' }, { id: ID.toUpperCase() }, { version: 2 }, { kind: 'other' }, { mode: 'cloud' },
    { outcome: 'open' }, { outcome: 'cancelled' }, { reason: 'cancel' }, { outcome: 'failed', reason: 'whatever' },
    { startedAt: 'yesterday' }, { session: 'a/b' }, { error: 'x'.repeat(301) },
    { stages: [{ name: 'madeUp', ms: 1 }] }, { stages: [{ name: 'release', ms: -1 }] }, { stages: [{ name: 'release', ms: 3600001 }] },
    { stages: [{ name: 'release', ms: 1, text: 'only partials and staged choices carry text' }] },
    { stages: [{ name: 'partial', ms: 1, text: big }] }, { stages: [{ name: 'release', ms: 1, extra: true }] },
    { stages: Array(301).fill({ name: 'partial', ms: 1, text: 'a' }) },
    { worker: { audioMs: 1, url: 'https://x.invalid' } }, { worker: { audioMs: '1' } },
    { content: { transcript: big } }, { content: { transcript: 'a\u0000b' } }, { content: { question: 'private' } },
    { content: { choices: Array(7).fill({ label: 'a', say: 'a' }) } }, { content: { choices: [{ label: 'a', say: 'a', url: 'x' }] } },
    { content: { partials: Array(101).fill('a') } }, { content: { selected: { say: 'a', extra: 1 } } },
    { usage: { reply: { model: 'm', inputTokens: -1, cachedTokens: 0, outputTokens: 0 } } }, { usage: { token: 'secret' } },
    { usage: { voice: { chars: 1, cache: 'warm' } } },
    { health: { boot: {} } }, { health: { release: { cpuBusy: 2 } } }, { health: { release: { rtt: { transcription: 1, url: 2 } } } },
    { mic: { peakRms: 1.5, clipped: 0, frames: 1 } }, { mic: { peakRms: 0.1, clipped: 0.5, frames: 1 } },
    { build: 'forged' }, { device: 'forged' }, { cost: { total: 0 } },
  ];
  for (const patch of bad) assert.throws(() => validateTurn(turnRecord(patch)), e => e.status === 400 && e.code === 'invalid-turn', JSON.stringify(patch).slice(0, 120));
  assert.throws(() => validateTurn(null), e => e.code === 'invalid-turn');
  assert.throws(() => validateTurn([]), e => e.code === 'invalid-turn');
});

test('test mode is off by default: every route is a 404 and nothing is written', async t => {
  const s = await service(t, { on: false });
  assert.equal((await s.post(turnRecord())).status, 404);
  assert.equal((await s.audio(ID, Buffer.alloc(3200))).status, 404);
  assert.equal((await fetch(s.base + '/turns')).status, 404);
  assert.equal((await fetch(s.base + '/health')).status, 404);
  assert.equal(await exists(s.logDir), false);
  assert.deepEqual(s.pool.readMerged({ kind: 'chat-turn' }), []);
  assert.equal(s.turns.lagActive(), false, 'off: no event-loop timer runs');
  assert.equal(testModeOn(s.dataDir), false, 'no app-settings file means off');
  await fs.writeFile(path.join(s.dataDir, 'app-settings.json'), JSON.stringify({ chatTestMode: 'true' }));
  assert.equal(testModeOn(s.dataDir), false, 'only the boolean true turns it on');
  await fs.writeFile(path.join(s.dataDir, 'app-settings.json'), '{broken');
  assert.equal(testModeOn(s.dataDir), false);
  await fs.writeFile(path.join(s.dataDir, 'app-settings.json'), JSON.stringify({ chatTestMode: true }));
  assert.equal(testModeOn(s.dataDir), true);
});

test('the settings switch takes only a real boolean', () => {
  assert.deepEqual(applyTestModeSetting({ dwellMs: 900 }, { chatTestMode: true }), { dwellMs: 900, chatTestMode: true });
  assert.deepEqual(applyTestModeSetting({ chatTestMode: true }, { chatTestMode: false }), { chatTestMode: false });
  for (const junk of ['true', 1, null, 'yes', {}]) assert.deepEqual(applyTestModeSetting({ chatTestMode: false }, { chatTestMode: junk }), { chatTestMode: false });
  assert.deepEqual(applyTestModeSetting({ a: 1 }, {}), { a: 1 });
  // A cross-site page steering the browser never moves it; a tool with no header, or the page itself, does.
  for (const site of ['cross-site', 'same-site']) assert.deepEqual(applyTestModeSetting({}, { chatTestMode: true }, site), {});
  for (const site of [undefined, 'same-origin', 'none']) assert.deepEqual(applyTestModeSetting({}, { chatTestMode: true }, site), { chatTestMode: true });
});

test('a turn writes one line to the day file and the same record to the pool, stamped by the hub', async t => {
  const env = { ERA_CHAT_TEXT_URL: 'https://reply.invalid/v1/responses', ERA_CHAT_TEXT_MODEL: 'reply-model-x', ERA_CHAT_TEXT_TOKEN: 'secret-reply-token',
    ERA_CHAT_SPEECH_URL: 'https://speech.invalid/v1/audio', ERA_CHAT_SPEECH_MODEL: 'speech-model-y', ERA_CHAT_SPEECH_TOKEN: 'secret-speech-token' };
  const s = await service(t, { env });
  const response = await s.post(turnRecord());
  assert.equal(response.status, 201);
  const reply = await response.json(); assert.equal(reply.id, ID); assert.equal(reply.cost, null);
  const text = await fs.readFile(path.join(s.logDir, day() + '.jsonl'), 'utf8');
  const lines = text.trim().split('\n'); assert.equal(lines.length, 1);
  const written = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(written).filter(key => !(key in turnRecord())).sort(), ['build', 'cost', 'day', 'device', 'models', 'receivedAt']);
  assert.equal(written.day, day()); assert.equal(written.day, localDay(new Date(written.receivedAt)));
  assert.equal(written.build, '20261027.1800'); assert.equal(written.device, 'test-device');
  assert.deepEqual(written.models, { reply: 'reply-model-x', transcription: 'speech-model-y' });
  assert.equal(written.cost, null);
  assert.doesNotMatch(text, /secret|invalid|https?:/, 'ids only: never a credential or a service URL');
  const pooled = s.pool.readMerged({ kind: 'chat-turn' });
  assert.equal(pooled.length, 1);
  assert.deepEqual(Object.keys(pooled[0]).sort(), ['device', 'kind', 't', 'turn']);
  assert.equal(pooled[0].device, 'test-device');
  assert.deepEqual(pooled[0].turn, written, 'the pool carries the same record');
  await s.post(turnRecord({ id: '1f8fad5b-d9cb-469f-a165-70867728950e', outcome: 'cancelled', reason: 'cancel' }));
  assert.equal((await fs.readFile(path.join(s.logDir, day() + '.jsonl'), 'utf8')).trim().split('\n').length, 2);
});

test('request bounds: json only, 64 KB bodies, a full day file stops writing, foreign callers refused', async t => {
  const s = await service(t, { extra: { limits: { dayBytes: 3000 } } });
  assert.equal((await s.post(turnRecord(), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await s.post('{"x":' + '1'.repeat(70000) + '}')).status, 413);
  assert.equal((await s.post('{broken')).status, 400);
  assert.equal((await s.post(turnRecord({ secret: 1 }))).status, 400);
  assert.equal((await s.post(turnRecord())).status, 201);
  assert.equal((await s.post(turnRecord())).status, 507, 'a day file over its cap takes no more lines');
  assert.equal((await fs.readFile(path.join(s.logDir, day() + '.jsonl'), 'utf8')).trim().split('\n').length, 1);
  for (const headers of [{ Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }])
    assert.equal((await s.post(turnRecord(), headers)).status, 403);
  assert.equal((await fetch(s.base + '/turns', { method: 'PATCH' })).status, 405);
  assert.equal((await fetch(s.base + '/elsewhere')).status, 418, 'other Chat routes are not this module\'s');
});

test('turn audio is stored as a 16 kHz mono wav, bounded to 15 s, rotated to the newest N and never pooled', async t => {
  const s = await service(t, { extra: { limits: { audioTurns: 3 } } });
  const pcm = Buffer.alloc(32000); pcm.writeInt16LE(1234, 0);
  assert.equal((await s.audio(ID, pcm)).status, 404, 'no recording for a turn the hub never recorded: no orphan wavs');
  assert.equal(await exists(path.join(s.logDir, 'audio')), false);
  await s.post(turnRecord());
  assert.equal((await s.audio(ID, pcm)).status, 201);
  const wav = await fs.readFile(path.join(s.logDir, 'audio', ID + '.wav'));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1, 'mono'); assert.equal(wav.readUInt32LE(24), 16000, '16 kHz'); assert.equal(wav.readUInt16LE(34), 16, 'PCM16');
  assert.equal(wav.readUInt32LE(40), pcm.length); assert.equal(wav.readInt16LE(44), 1234);
  assert.equal((await s.audio(ID, pcm)).status, 409, 'a turn has one recording');
  for (const prefix of ['2f', '3f', '4f']) await s.post(turnRecord({ id: ID.replace('0f', prefix) }));
  assert.equal((await s.audio(ID.replace('0f', '2f'), Buffer.alloc(480002))).status, 413, 'over 15 s');
  assert.equal((await s.audio(ID.replace('0f', '3f'), Buffer.alloc(31))).status, 400, 'odd byte count');
  assert.equal((await s.audio(ID.replace('0f', '3f'), Buffer.alloc(0))).status, 400, 'empty');
  assert.equal((await s.audio('..%2F..%2Fescape', pcm)).status, 404);
  assert.equal((await s.audio(ID.replace('0f', '4f'), pcm, { 'content-type': 'audio/wav' })).status, 415);
  const ids = ['a', 'b', 'c', 'd'].map(c => c.repeat(8) + ID.slice(8));
  for (const id of ids) { await s.post(turnRecord({ id })); assert.equal((await s.audio(id, pcm)).status, 201); await new Promise(r => setTimeout(r, 15)); }
  const restarted = createChatTurns({ dataDir: s.dataDir, enabled: () => true, env: () => ({}) });
  t.after(() => restarted.close());
  assert.equal(await restarted.knowsTurn(ids[0]), true, 'a restarted hub finds the turn in its day file');
  assert.equal(await restarted.knowsTurn(ID.replace('0f', '9f')), false);
  assert.deepEqual((await fs.readdir(path.join(s.logDir, 'audio'))).sort(), ids.slice(1).map(id => id + '.wav').sort());
  const poolFiles = await fs.readdir(s.pool.root, { recursive: true });
  assert.equal(poolFiles.some(name => name.endsWith('.wav')), false);
});

test('the delete control removes recordings and day files whether test mode is on or off; turning off deletes nothing', async t => {
  const s = await service(t);
  await s.post(turnRecord()); await s.audio(ID, Buffer.alloc(3200));
  s.setOn(false);
  assert.equal((await s.post(turnRecord())).status, 404, 'off stops writing');
  assert.ok(await exists(path.join(s.logDir, day() + '.jsonl')), 'off keeps what was written');
  assert.ok(await exists(path.join(s.logDir, 'audio', ID + '.wav')));
  await fs.writeFile(path.join(s.logDir, 'notes.txt'), 'not ours to delete');
  const response = await fetch(s.base + '/turns', { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: { days: 1, recordings: 1, poolLines: 1, failed: [] } });
  assert.deepEqual(await fs.readdir(s.logDir), ['notes.txt']);
  assert.equal((await fetch(s.base + '/turns', { method: 'DELETE', headers: { Origin: 'https://foreign.invalid' } })).status, 403);
});

test('the delete control strips only this device\'s chat-turn lines from its own pool files, atomically, keeping every other kind', async t => {
  const dataDir = await directory(t), pool = initPool(dataDir, 'test-device');
  const s = await service(t, { dataDir, pool });
  pool.append('app-log', { entry: { app: 'board', n: 1 } });
  await s.post(turnRecord());
  pool.append('presence', { entry: { event: 'alive' } });
  await s.post(turnRecord({ id: '1f8fad5b-d9cb-469f-a165-70867728950e' }));
  const mine = path.join(pool.root, 'events', 'test-device');
  // an older day of this device, with a torn line that is not ours to judge
  await fs.writeFile(path.join(mine, '2026-10-01.jsonl'), [JSON.stringify({ t: 'x', device: 'test-device', kind: 'chat-turn', turn: { id: 'old' } }),
    '{"torn', JSON.stringify({ t: 'x', device: 'test-device', kind: 'outfit-wear', combo: 1 })].join('\n') + '\n');
  // another device's file in the same pool is never touched
  const other = path.join(pool.root, 'events', 'other-device');
  await fs.mkdir(other, { recursive: true });
  const otherLine = JSON.stringify({ t: 'x', device: 'other-device', kind: 'chat-turn', turn: { id: 'theirs' } }) + '\n';
  await fs.writeFile(path.join(other, poolDay() + '.jsonl'), otherLine);
  const response = await fetch(s.base + '/turns', { method: 'DELETE' });
  assert.deepEqual(await response.json(), { deleted: { days: 1, recordings: 0, poolLines: 3, failed: [] } });
  assert.deepEqual(pool.readMerged({ kind: 'chat-turn' }).map(line => line.device), ['other-device']);
  const today = (await fs.readFile(path.join(mine, poolDay() + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).kind);
  assert.deepEqual(today, ['app-log', 'presence']);
  assert.equal(await fs.readFile(path.join(mine, '2026-10-01.jsonl'), 'utf8'),
    '{"torn\n' + JSON.stringify({ t: 'x', device: 'test-device', kind: 'outfit-wear', combo: 1 }) + '\n');
  assert.equal(await fs.readFile(path.join(other, poolDay() + '.jsonl'), 'utf8'), otherLine);
  assert.deepEqual((await fs.readdir(mine)).filter(name => !name.endsWith('.jsonl')), [], 'no temporary file is left behind');
  pool.append('app-log', { entry: { after: true } });
  assert.equal((await fs.readFile(path.join(mine, poolDay() + '.jsonl'), 'utf8')).trim().split('\n').length, 3, 'the pool keeps appending afterwards');
  const again = await (await fetch(s.base + '/turns', { method: 'DELETE' })).json();
  assert.deepEqual(again, { deleted: { days: 0, recordings: 0, poolLines: 0, failed: [] } });
});

test('recent turns and per-build summaries are served only while on', async t => {
  const s = await service(t);
  for (let i = 0; i < 12; i++) await s.post(turnRecord({ id: String(i).padStart(8, '0') + ID.slice(8) }));
  const value = await (await fetch(s.base + '/turns')).json();
  assert.equal(value.turns.length, 10); assert.equal(value.turns.at(-1).id, '00000011' + ID.slice(8));
  assert.equal(value.turns[0].content.transcript, 'Would you like music or a story?');
  assert.equal(value.summary.builds['20261027.1800'].hold.turns, 12);
  assert.equal(value.summary.builds['20261027.1800'].hold.stages.transcript.p50, 600);
});

test('cost: null without a price table; per-part estimate with one; unpriced parts are marked', async t => {
  const record = { ...turnRecord(), models: { reply: 'reply-model-x', transcription: 'speech-model-y' } };
  assert.equal(estimateCost(record, null), null);
  const prices = { version: 1, currency: 'USD',
    reply: { 'reply-model-x': { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 } },
    transcription: { 'speech-model-y': { perAudioMinute: 0.006 } }, voice: { perThousandChars: 0.3 } };
  const cost = estimateCost(record, prices);
  // reply: 800 * 2 + 100 * 0.5 + 60 * 8 = 2130 per million; audio 0.8 s; voice 12 chars fetched
  assert.deepEqual(cost, { currency: 'USD', reply: 0.00213, transcription: 0.00008, voice: 0.0036, total: 0.00581, complete: true });
  const unpriced = estimateCost({ ...record, usage: { ...record.usage, reply: { ...record.usage.reply, model: 'other-model' } } }, prices);
  assert.equal(unpriced.reply, null); assert.equal(unpriced.complete, false); assert.equal(unpriced.total, 0.00368);
  for (const mode of ['local', 'typed', 'none'])
    assert.equal(estimateCost({ ...record, mode }, prices).transcription, 0, mode + ' transcription costs nothing');
  const noCalls = estimateCost({ ...record, usage: {} }, prices);
  assert.deepEqual(noCalls, { currency: 'USD', reply: 0, transcription: 0, voice: 0, total: 0, complete: true });

  const s = await service(t, { env: { ERA_CHAT_TEXT_MODEL: 'reply-model-x', ERA_CHAT_SPEECH_MODEL: 'speech-model-y', ERA_CHAT_STREAM_MODEL: 'stream-model-z' } });
  await fs.writeFile(path.join(s.dataDir, 'chat-prices.json'), JSON.stringify(prices));
  assert.equal((await (await s.post(turnRecord())).json()).cost.total, 0.00581);
  // The transcription model is the one configured for the turn's mode.
  const streamed = await (await s.post(turnRecord({ id: ID.replace('0f', '5f'), mode: 'stream' }))).json();
  assert.equal(streamed.cost.transcription, null, 'the stream model has no price here'); assert.equal(streamed.cost.complete, false);
  const lines = (await fs.readFile(path.join(s.logDir, day() + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.models.transcription), ['speech-model-y', 'stream-model-z']);
  const local = await (await s.post(turnRecord({ id: ID.replace('0f', '6f'), mode: 'local' }))).json();
  assert.equal(local.cost.transcription, 0);
  await fs.writeFile(path.join(s.dataDir, 'chat-prices.json'), '{broken');
  assert.equal((await (await s.post(turnRecord())).json()).cost, null, 'an unreadable table is no table');
});

test('health: cpu, memory, event-loop lag, gaze and cached service round trips, never a URL', async t => {
  let hits = 0;
  const fixture = http.createServer((req, res) => { hits++; assert.equal(req.method, 'HEAD'); res.writeHead(404).end(); });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const port = fixture.address().port;
  const closed = http.createServer(); await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const gone = closed.address().port; await new Promise(resolve => closed.close(resolve));
  const s = await service(t, { env: { ERA_CHAT_SPEECH_URL: `http://127.0.0.1:${port}/v1/audio?key=x`, ERA_CHAT_TEXT_URL: `http://127.0.0.1:${gone}/unreachable` } });
  assert.equal(s.turns.lagActive(), false, 'no lag timer until test mode asks for health');
  const before = await (await fetch(s.base + '/health')).json();
  assert.deepEqual(before.rtt, { transcription: null, reply: null }, 'a health sample sends nothing to the services');
  assert.equal(hits, 0);
  assert.equal(s.turns.lagActive(), true);
  const warm = await fetch(s.base + '/health/warm');
  assert.equal(warm.status, 202);
  for (let i = 0; i < 100 && (hits === 0 || !(await (await fetch(s.base + '/health')).json()).rtt.transcription); i++) await new Promise(r => setTimeout(r, 20));
  const response = await fetch(s.base + '/health');
  assert.equal(response.status, 200);
  const text = await response.text(), value = JSON.parse(text);
  assert.deepEqual(Object.keys(value).sort(), ['cpuBusy', 'eventLoopLagMs', 'freeMemBytes', 'gaze', 'load1', 'rtt', 'totalMemBytes']);
  assert.ok(value.cpuBusy >= 0 && value.cpuBusy <= 1);
  assert.ok(value.freeMemBytes > 0 && value.totalMemBytes >= value.freeMemBytes);
  assert.ok(value.eventLoopLagMs >= 0);
  assert.equal(value.gaze, 'running');
  assert.ok(process.platform === 'win32' ? value.load1 === null : value.load1 >= 0);
  assert.ok(value.rtt.transcription >= 0, 'a service that answers anything has a round trip');
  assert.equal(value.rtt.reply, null, 'an unreachable service has none');
  assert.doesNotMatch(text, new RegExp(String(port)));
  assert.doesNotMatch(text, /127\.0\.0\.1|key=|http/);
  await fetch(s.base + '/health/warm'); await fetch(s.base + '/health');
  assert.equal(hits, 1, 'round trips are cached for 30 s');
  s.setOn(false);
  assert.equal((await fetch(s.base + '/health')).status, 404);
  assert.equal((await fetch(s.base + '/health/warm')).status, 404);
  assert.equal(s.turns.lagActive(), false, 'the switch reading off stops the lag timer');
  assert.equal(validateTurn(turnRecord({ health: { release: value, reveal: value } })).health.reveal.gaze, 'running', 'the record schema takes what the route serves');
});

test('summarize: p50/p95 per stage per build from release, outcomes by reason, cost per day', () => {
  const at = (ms, extra = {}) => turnRecord({ stages: [{ name: 'release', ms: 1000 }, { name: 'transcript', ms: 1000 + ms }], ...extra });
  const records = [
    ...[100, 200, 300, 400].map(ms => ({ ...at(ms), build: 'b1', receivedAt: '2026-10-27T01:00:00.000Z', cost: { total: 0.001, complete: true } })),
    { ...at(900), build: 'b2', receivedAt: '2026-10-28T01:00:00.000Z', cost: null },
    { ...at(50, { outcome: 'cancelled', reason: 'cancel' }), build: 'b1', receivedAt: '2026-10-27T02:00:00.000Z', cost: null },
    { ...at(50, { outcome: 'failed', reason: 'choices' }), build: 'b1', receivedAt: '2026-10-27T02:00:00.000Z', cost: null },
  ];
  for (const record of records) record.day = record.receivedAt.slice(0, 10);
  const value = summarize(records);
  assert.deepEqual(value.builds.b1.hold.stages.transcript, { n: 4, p50: 250, p95: 385 });
  assert.equal(value.builds.b1.hold.turns, 6);
  assert.deepEqual(value.builds.b2.hold.stages.transcript, { n: 1, p50: 900, p95: 900 });
  assert.equal(value.builds.b1.hold.stages.release.p50, 0);
  assert.deepEqual(value.outcomes, { completed: 5, cancelled: { cancel: 1 }, failed: { choices: 1 } });
  assert.deepEqual(value.costPerDay, { '2026-10-27': { usd: 0.004, turns: 6, unpriced: 2 }, '2026-10-28': { usd: 0, turns: 1, unpriced: 1 } });
});

test('earlier device ids: only lines of turns this device recorded are stripped from an older id\'s folder', async t => {
  const dataDir = await directory(t), pool = initPool(dataDir, 'test-device');
  const s = await service(t, { dataDir, pool });
  await s.post(turnRecord());
  const earlier = path.join(pool.root, 'events', 'old-name');
  await fs.mkdir(earlier, { recursive: true });
  const keep = [JSON.stringify({ t: 'x', device: 'old-name', kind: 'chat-turn', turn: { id: 'someone-else' } }), JSON.stringify({ t: 'x', device: 'old-name', kind: 'app-log', entry: {} })];
  await fs.writeFile(path.join(earlier, '2026-10-02.jsonl'), [JSON.stringify({ t: 'x', device: 'old-name', kind: 'chat-turn', turn: { id: ID } }), ...keep].join('\n') + '\n');
  const result = await (await fetch(s.base + '/turns', { method: 'DELETE' })).json();
  assert.equal(result.deleted.poolLines, 2);
  assert.equal(await fs.readFile(path.join(earlier, '2026-10-02.jsonl'), 'utf8'), keep.join('\n') + '\n');
});

test('a pool file that cannot be replaced is named in the answer, and the rest still go', async t => {
  const dataDir = await directory(t), pool = initPool(dataDir, 'test-device');
  const failing = { renameSync: (from, to) => { if (to.endsWith('2026-10-03.jsonl')) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fsSync.renameSync(from, to); } };
  const s = await service(t, { dataDir, pool, extra: { io: failing } });
  await s.post(turnRecord());
  const mine = path.join(pool.root, 'events', 'test-device');
  const stuck = JSON.stringify({ t: 'x', device: 'test-device', kind: 'chat-turn', turn: { id: 'x' } }) + '\n';
  await fs.writeFile(path.join(mine, '2026-10-03.jsonl'), stuck);
  const result = await (await fetch(s.base + '/turns', { method: 'DELETE' })).json();
  assert.deepEqual(result.deleted.failed, ['test-device/2026-10-03.jsonl']);
  assert.equal(result.deleted.poolLines, 1);
  assert.equal(await fs.readFile(path.join(mine, '2026-10-03.jsonl'), 'utf8'), stuck);
  assert.deepEqual((await fs.readdir(mine)).filter(name => !name.endsWith('.jsonl')), [], 'the temporary file is cleaned up');
});
