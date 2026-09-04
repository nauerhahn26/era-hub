// Google Cloud Vision adapter - DOCUMENT_TEXT_DETECTION, the raw-OCR baseline.
// No prompt is used: this is the "dumb OCR" floor the LLMs must beat.
//
// Credential: env GOOGLE_VISION_SA_JSON_B64 (base64 of a service-account JSON).
// The JSON is decoded in memory only; the private key never touches disk or a log.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { HttpError } from './util.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ANNOTATE_URL = 'https://vision.googleapis.com/v1/images:annotate';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export const name = 'gcv';

export function haveKey() {
  return Boolean(process.env.GOOGLE_VISION_SA_JSON_B64);
}

function sa() {
  const raw = Buffer.from(process.env.GOOGLE_VISION_SA_JSON_B64, 'base64').toString('utf8');
  const j = JSON.parse(raw);
  if (!j.client_email || !j.private_key) throw new Error('GOOGLE_VISION_SA_JSON_B64 is not a service-account JSON');
  return j;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

let cachedToken = null; // {token, expMs}

async function accessToken() {
  if (cachedToken && cachedToken.expMs - Date.now() > 60_000) return cachedToken.token;
  const creds = sa();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({ iss: creds.client_email, scope: SCOPE, aud: TOKEN_URL, exp, iat }),
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = b64url(signer.sign(creds.private_key));
  const assertion = `${header}.${claim}.${sig}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = await res.text();
  if (!res.ok) throw new HttpError(res.status, `token exchange failed (${body.slice(0, 200)})`, 0);
  const json = JSON.parse(body);
  cachedToken = { token: json.access_token, expMs: Date.now() + (json.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

export async function transcribe({ model = 'documentTextDetection', imagePath, mode = 'transcribe', signal }) {
  if (!haveKey()) throw new Error('GOOGLE_VISION_SA_JSON_B64 not set');
  if (mode === 'review') throw new Error('gcv has no review mode (raw OCR baseline, no prompt)');
  const token = await accessToken();
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const body = {
    requests: [
      {
        image: { content: b64 },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints: ['en'] },
      },
    ],
  };
  const t0 = Date.now();
  const res = await fetch(ANNOTATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
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
  const r = json.responses?.[0] || {};
  if (r.error) throw new HttpError(200, r.error.message || 'annotate error', latencyMs, r.error);

  // Keep the response small on disk: the full annotation carries a bounding box for
  // every symbol on the page (megabytes). We store the text plus page confidences.
  const pages = (r.fullTextAnnotation?.pages || []).map((p) => ({
    confidence: p.confidence,
    width: p.width,
    height: p.height,
    blocks: p.blocks?.length ?? null,
  }));
  return {
    text: r.fullTextAnnotation?.text || '',
    uncertain: [], // GCV has no self-flagging channel; per-symbol confidence is not a word list
    parseError: false,
    usage: { units: 1, inputTokens: null, outputTokens: null },
    latencyMs,
    httpStatus: res.status,
    modelReturned: 'DOCUMENT_TEXT_DETECTION',
    incomplete: null,
    raw: { pages, detectedLanguages: r.fullTextAnnotation?.pages?.[0]?.property?.detectedLanguages || [] },
    mode,
  };
}

export default { name, haveKey, transcribe };
