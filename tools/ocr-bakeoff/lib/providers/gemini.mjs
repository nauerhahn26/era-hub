// Gemini adapter (AI Studio, generativelanguage.googleapis.com v1beta).
// Key: env GOOGLE_AI_STUDIO_KEY. Sent as a query parameter by the API's own design;
// it is never logged or written to a result file.

import fs from 'node:fs';
import { parseModelJson, HttpError } from './util.mjs';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const name = 'gemini';

export function haveKey() {
  return Boolean(process.env.GOOGLE_AI_STUDIO_KEY);
}

export async function transcribe({ model, imagePath, prompt, mode = 'transcribe', draft, options = {}, signal }) {
  if (!haveKey()) throw new Error('GOOGLE_AI_STUDIO_KEY not set');
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const generationConfig = {
    temperature: options.temperature ?? 0,
    responseMimeType: 'application/json',
    maxOutputTokens: options.maxOutputTokens || 8192,
  };
  if (options.thinkingBudget != null) generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget };

  const body = {
    contents: [
      { role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] },
    ],
    generationConfig,
  };

  const url = `${BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(
    process.env.GOOGLE_AI_STUDIO_KEY,
  )}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

  const cand = json.candidates?.[0];
  let out = '';
  for (const p of cand?.content?.parts || []) if (typeof p.text === 'string' && p.thought !== true) out += p.text;
  const parsed = parseModelJson(out);
  const u = json.usageMetadata || {};
  return {
    text: parsed.text,
    uncertain: parsed.uncertain,
    parseError: parsed.parseError,
    usage: {
      inputTokens: u.promptTokenCount ?? null,
      outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) || (u.candidatesTokenCount ?? null),
      candidatesTokens: u.candidatesTokenCount ?? null,
      thoughtsTokens: u.thoughtsTokenCount ?? 0,
      cachedInputTokens: u.cachedContentTokenCount ?? 0,
      totalTokens: u.totalTokenCount ?? null,
    },
    latencyMs,
    httpStatus: res.status,
    modelReturned: json.modelVersion || null,
    incomplete: cand?.finishReason && cand.finishReason !== 'STOP' ? cand.finishReason : null,
    raw: json,
    mode,
    usedDraft: Boolean(draft),
  };
}

/** List models that support generateContent (used by candidate discovery). */
export async function listModels() {
  if (!haveKey()) throw new Error('GOOGLE_AI_STUDIO_KEY not set');
  const res = await fetch(`${BASE}/models?pageSize=200&key=${encodeURIComponent(process.env.GOOGLE_AI_STUDIO_KEY)}`);
  if (!res.ok) throw new HttpError(res.status, 'model list failed', 0, await res.text());
  const json = await res.json();
  return (json.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'));
}

export default { name, haveKey, transcribe, listModels };
