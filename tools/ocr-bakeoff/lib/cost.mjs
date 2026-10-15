// Cost model. Prices come from lib/pricing.json (fetched from the official pages;
// see README "Updating pricing"). Cost is computed from the usage the API actually
// reported, so re-scoring after a price change never needs a re-run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadPricing(file = path.join(HERE, 'pricing.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Can this candidate be priced at all? Used as a run preflight: an unpriced candidate
 * contributes $0 to the spend accumulator, which would make --max-usd unenforceable.
 */
export function modelPriced(provider, model, pricing) {
  if (provider === 'gcv') return pricing.gcv?.perUnitAfterFree != null;
  const row = pricing.models?.[model];
  return Boolean(row && row.inputPerM != null && row.outputPerM != null);
}

/**
 * USD for one call. Returns {usd, priced, freeUnitsPerMonth?} - priced=false when we
 * have no price row (cost then reads as null in the report rather than a silent zero).
 *
 * `usage.inputTokens` is the TOTAL prompt size INCLUDING any cached tokens, matching
 * OpenAI's and Gemini's own reporting; each adapter is responsible for normalising to
 * that convention (Anthropic reports the uncached remainder, so its adapter adds the
 * cache tokens back in).
 */
export function callCost({ provider, model, usage }, pricing) {
  if (provider === 'gcv') {
    const p = pricing.gcv?.perUnitAfterFree;
    if (p == null) return { usd: null, priced: false, note: 'no gcv price' };
    // usd is the MARGINAL price after the free allowance. The allowance is returned
    // alongside it because at family volume (tens of pages a month) it is the whole
    // story: reporting $0.0015/page as if it were the real cost misranks the baseline.
    return {
      usd: (usage?.units ?? 1) * p,
      priced: true,
      freeUnitsPerMonth: pricing.gcv.freeUnitsPerMonth ?? null,
      note: `first ${pricing.gcv.freeUnitsPerMonth}/month are free`,
    };
  }
  const row = pricing.models?.[model];
  if (!row || row.inputPerM == null || row.outputPerM == null) {
    return { usd: null, priced: false, note: `no price row for ${model}` };
  }
  const inTok = usage?.inputTokens ?? 0;
  const cached = usage?.cachedInputTokens ?? 0;
  const cacheWrite = usage?.cacheWriteInputTokens ?? 0;
  const fresh = Math.max(0, inTok - cached - cacheWrite);
  const outTok = usage?.outputTokens ?? 0;
  const cachedRate = row.cachedInputPerM ?? row.inputPerM;
  // Cache WRITES are billed above the fresh input rate (Anthropic: 1.25x for a 5m TTL);
  // without this they would be billed as plain input, i.e. undercounted.
  const cacheWriteRate = row.cacheWritePerM ?? row.inputPerM * 1.25;
  const usd =
    (fresh * row.inputPerM + cached * cachedRate + cacheWrite * cacheWriteRate + outTok * row.outputPerM) / 1e6;
  return { usd, priced: true, freeUnitsPerMonth: row.freeUnitsPerMonth ?? null, note: null };
}

export default { loadPricing, callCost, modelPriced };
