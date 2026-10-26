import test from 'node:test';
import assert from 'node:assert/strict';
import { makeChatToneWav, assertContentFreeMetrics, makeChatStateDiagnostic, waitForChatState } from './lib/chat-ui-smoke.mjs';

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
