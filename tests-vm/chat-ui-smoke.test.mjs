import test from 'node:test';
import assert from 'node:assert/strict';
import { makeChatToneWav, assertContentFreeMetrics } from './lib/chat-ui-smoke.mjs';

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
