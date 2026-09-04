// Anthropic adapter - COMPLETE but UNTESTED: there is no ANTHROPIC_API_KEY in this
// environment, so Claude was measured separately through Claude Code's own image
// reading rather than through this code path. The adapter is written so that the
// bake-off can include Claude the moment a key exists: set ANTHROPIC_API_KEY, add a
// row to lib/candidates.mjs, AND add a price row to lib/pricing.json (there is none
// today - prices must be fetched from the live pricing page, never recalled from
// memory). Without a price row the run refuses to start under --max-usd, because an
// unpriced candidate cannot be capped. Until then every call throws.

import fs from 'node:fs';
import { parseModelJson, HttpError } from './util.mjs';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export const name = 'anthropic';

export function haveKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function transcribe({ model, imagePath, prompt, mode = 'transcribe', draft, options = {}, signal }) {
  if (!haveKey()) throw new Error('ANTHROPIC_API_KEY not set');
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const body = {
    model,
    max_tokens: options.maxOutputTokens || 8192,
    temperature: options.temperature ?? 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  };
  if (options.thinkingBudget) body.thinking = { type: 'enabled', budget_tokens: options.thinkingBudget };

  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(body),
    signal,
  });
  const latencyMs = Date.now() - t0;
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new HttpError(res.status, `non-JSON response (${text.slice(0, 200)})`, latencyMs);
  }
  if (!res.ok) throw new HttpError(res.status, json?.error?.message || `http ${res.status}`, latencyMs, json);

  let out = '';
  for (const c of json.content || []) if (c.type === 'text') out += c.text;
  const parsed = parseModelJson(out);
  const u = json.usage || {};
  return {
    text: parsed.text,
    uncertain: parsed.uncertain,
    parseError: parsed.parseError,
    // Token convention: lib/cost.mjs expects inputTokens to be the TOTAL prompt,
    // cached tokens included (that is what OpenAI and Gemini report). The Anthropic
    // Messages API reports input_tokens EXCLUDING cache reads and cache writes, so
    // they are added back here - otherwise cost.mjs subtracts them a second time and
    // undercounts every cached call. (Latent until a cache_control block is sent.)
    usage: {
      inputTokens:
        (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? null,
      cachedInputTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteInputTokens: u.cache_creation_input_tokens ?? 0,
      totalTokens:
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.output_tokens ?? 0),
    },
    latencyMs,
    httpStatus: res.status,
    modelReturned: json.model || null,
    incomplete: json.stop_reason && json.stop_reason !== 'end_turn' ? json.stop_reason : null,
    raw: json,
    mode,
    usedDraft: Boolean(draft),
  };
}

export default { name, haveKey, transcribe };
