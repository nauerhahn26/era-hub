import openai from './openai.mjs';
import gemini from './gemini.mjs';
import gcv from './gcv.mjs';
import anthropic from './anthropic.mjs';

export const providers = { openai, gemini, gcv, anthropic };

/** Max in-flight calls per provider (tuned to stay under per-minute rate limits). */
export const CONCURRENCY = { openai: 4, gemini: 2, gcv: 4, anthropic: 2 };

export function getProvider(id) {
  const p = providers[id];
  if (!p) throw new Error(`unknown provider "${id}" (have: ${Object.keys(providers).join(', ')})`);
  return p;
}

export default { providers, CONCURRENCY, getProvider };
