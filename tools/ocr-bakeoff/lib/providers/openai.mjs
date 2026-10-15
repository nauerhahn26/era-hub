// OpenAI adapter (Responses API, /v1/responses).
// Key: env OPENAI_API_KEY. Never logged, never written to disk.

import fs from 'node:fs';
import { parseModelJson, HttpError } from './util.mjs';

const ENDPOINT = 'https://api.openai.com/v1/responses';

export const name = 'openai';

export function haveKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function transcribe({ model, imagePath, prompt, mode = 'transcribe', draft, options = {}, signal }) {
  if (!haveKey()) throw new Error('OPENAI_API_KEY not set');
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const body = {
    model,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${b64}`, detail: options.detail || 'high' },
        ],
      },
    ],
    max_output_tokens: options.maxOutputTokens || 8192,
    store: false,
  };
  // Reasoning models: minimal effort for transcription (we want reading, not thinking).
  if (options.reasoningEffort) body.reasoning = { effort: options.reasoningEffort };
  if (options.temperature != null) body.temperature = options.temperature;

  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
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
  if (!res.ok) {
    const msg = json?.error?.message || `http ${res.status}`;
    throw new HttpError(res.status, msg, latencyMs, json);
  }

  let out = '';
  if (typeof json.output_text === 'string' && json.output_text) out = json.output_text;
  else {
    for (const item of json.output || []) {
      if (item.type !== 'message') continue;
      for (const c of item.content || []) if (c.type === 'output_text') out += c.text;
    }
  }
  const parsed = parseModelJson(out);
  const u = json.usage || {};
  return {
    text: parsed.text,
    uncertain: parsed.uncertain,
    parseError: parsed.parseError,
    usage: {
      inputTokens: u.input_tokens ?? null,
      outputTokens: u.output_tokens ?? null,
      cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
      totalTokens: u.total_tokens ?? null,
    },
    latencyMs,
    httpStatus: res.status,
    modelReturned: json.model || null,
    incomplete: json.status === 'incomplete' ? json.incomplete_details?.reason || 'incomplete' : null,
    raw: json,
    mode,
    usedDraft: Boolean(draft),
  };
}

export default { name, haveKey, transcribe };
