import test from 'node:test';
import assert from 'node:assert/strict';
import { cachePath, candidateFingerprint } from '../lib/cache.mjs';
import { callCost, modelPriced } from '../lib/cost.mjs';

const cand = (over = {}) => ({
  id: 'openai:gpt-5.6-sol',
  provider: 'openai',
  model: 'gpt-5.6-sol',
  options: {},
  ...over,
});
const p = (c, over = {}) =>
  cachePath('/ds', { candidate: c, condition: 'raw2048', pageId: 'x-p03', promptVersion: 'v2', ...over });

test('a plain candidate keeps a readable, un-hashed path', () => {
  assert.equal(p(cand()), '/ds/cache/openai/gpt-5.6-sol/v2/transcribe/raw2048/x-p03.json');
});

test('different options mean a different cache entry', () => {
  const none = p(cand({ options: { reasoningEffort: 'none' } }));
  const low = p(cand({ options: { reasoningEffort: 'low' } }));
  assert.notEqual(none, low, 'changing a setting must not silently reuse the old answer');
  // and re-running with the same settings must hit the same file
  assert.equal(none, p(cand({ options: { reasoningEffort: 'none' } })));
});

test('option key order does not change the cache entry', () => {
  const a = p(cand({ options: { reasoningEffort: 'none', temperature: 0 } }));
  const b = p(cand({ options: { temperature: 0, reasoningEffort: 'none' } }));
  assert.equal(a, b);
});

test('two candidate rows on one model do not collide', () => {
  // the real case: gemini-3.6-flash with thinking pinned off vs left on
  const off = p(cand({ id: 'gemini:gemini-3.6-flash', provider: 'gemini', model: 'gemini-3.6-flash', options: { thinkingBudget: 0 } }));
  const on = p(cand({ id: 'gemini:gemini-3.6-flash-thinking', provider: 'gemini', model: 'gemini-3.6-flash', options: {} }));
  assert.notEqual(off, on);
});

test('two ids on one model with identical options still do not collide', () => {
  const a = p(cand({ id: 'openai:gpt-5.6-sol' }));
  const b = p(cand({ id: 'openai:gpt-5.6-sol-experiment' }));
  assert.notEqual(a, b);
  assert.equal(candidateFingerprint(cand()), '', 'the default id with no options stays unhashed');
  assert.match(candidateFingerprint(cand({ id: 'openai:gpt-5.6-sol-experiment' })), /^@[0-9a-f]{8}$/);
});

test('prompt version, condition, page and review pairing all fork the path', () => {
  assert.notEqual(p(cand()), p(cand(), { promptVersion: 'v1' }));
  assert.notEqual(p(cand()), p(cand(), { condition: 'raw' }));
  assert.notEqual(p(cand()), p(cand(), { pageId: 'x-p04' }));
  assert.equal(
    p(cand(), { mode: 'review', reviewOf: 'gcv:documentTextDetection' }),
    '/ds/cache/openai/gpt-5.6-sol/v2/review__gcv_documentTextDetection/raw2048/x-p03.json',
  );
});

// ---------------------------------------------------------------- cost model

const PRICING = {
  models: { 'gpt-5.6-sol': { inputPerM: 4, outputPerM: 20, cachedInputPerM: 0.4 } },
  gcv: { freeUnitsPerMonth: 1000, perUnitAfterFree: 0.0015 },
};

test('an unpriced model is reported as unpriced, never as free', () => {
  const c = callCost({ provider: 'openai', model: 'gpt-6-ultra', usage: { inputTokens: 900000 } }, PRICING);
  assert.equal(c.usd, null);
  assert.equal(c.priced, false);
  assert.equal(modelPriced('openai', 'gpt-6-ultra', PRICING), false);
  assert.equal(modelPriced('openai', 'gpt-5.6-sol', PRICING), true);
  assert.equal(modelPriced('gcv', 'documentTextDetection', PRICING), true);
});

test('input tokens are the total prompt: cached tokens are billed once, at the cached rate', () => {
  const c = callCost(
    { provider: 'openai', model: 'gpt-5.6-sol', usage: { inputTokens: 10000, cachedInputTokens: 9000, outputTokens: 500 } },
    PRICING,
  );
  // 1000 fresh @ $4/M + 9000 cached @ $0.40/M + 500 out @ $20/M
  assert.ok(Math.abs(c.usd - (1000 * 4 + 9000 * 0.4 + 500 * 20) / 1e6) < 1e-15);
});

test('cache writes are billed above the fresh input rate, not as plain input', () => {
  const c = callCost(
    { provider: 'openai', model: 'gpt-5.6-sol', usage: { inputTokens: 10000, cacheWriteInputTokens: 4000, outputTokens: 0 } },
    PRICING,
  );
  assert.ok(Math.abs(c.usd - (6000 * 4 + 4000 * 5) / 1e6) < 1e-15);
});

test('the GCV free allowance travels with the price', () => {
  const c = callCost({ provider: 'gcv', model: 'documentTextDetection', usage: { units: 1 } }, PRICING);
  assert.equal(c.usd, 0.0015);
  assert.equal(c.priced, true);
  assert.equal(c.freeUnitsPerMonth, 1000, 'the report needs this to rank the baseline at family volume');
});
