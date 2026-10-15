// Shared helpers for provider adapters.

export class HttpError extends Error {
  constructor(status, message, latencyMs, body) {
    super(`http ${status}: ${message}`);
    this.name = 'HttpError';
    this.status = status;
    this.latencyMs = latencyMs;
    this.body = body;
  }
}

/** True for statuses worth retrying with backoff. */
export function isRetryable(err) {
  if (err?.name === 'HttpError') return err.status === 429 || (err.status >= 500 && err.status < 600);
  // fetch/network/abort errors
  return err?.name === 'TypeError' || err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT' || err?.name === 'AbortError';
}

/**
 * Seconds the provider asked us to wait, from either the RetryInfo detail or the
 * "Please retry in 46.5s" sentence Gemini appends. null when it did not say.
 */
export function retryDelaySeconds(err) {
  const body = err?.body;
  const details = body?.error?.details || [];
  for (const d of details) {
    const v = d?.retryDelay;
    if (typeof v === 'string') {
      const m = v.match(/^([\d.]+)s$/);
      if (m) return Number(m[1]);
    }
  }
  const m = String(err?.message || '').match(/retry in ([\d.]+)\s*s/i);
  return m ? Number(m[1]) : null;
}

/**
 * Structured quota facts from a Google QuotaFailure detail, e.g.
 *   { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20',
 *     quotaMetric: '...generate_content_free_tier_requests', model: 'gemini-3.8-flash' }
 * This is the evidence that says "free tier, N requests per day" rather than a guess.
 */
export function quotaFacts(err) {
  const details = err?.body?.error?.details || [];
  const out = [];
  for (const d of details) {
    if (!String(d?.['@type'] || '').endsWith('QuotaFailure')) continue;
    for (const v of d.violations || []) {
      out.push({
        quotaId: v.quotaId ?? null,
        quotaMetric: v.quotaMetric ?? null,
        quotaValue: v.quotaValue ?? null,
        model: v.quotaDimensions?.model ?? null,
      });
    }
  }
  return out;
}

/**
 * Does this 429 look like a per-DAY quota rather than a per-minute rate limit?
 * Only a daily quota should stop a candidate; a per-minute limit is just backoff.
 * Signals, strongest first:
 *   - the metric or message names a day / RPD
 *   - the free-tier limit is literally 0 (the model is not on the free tier at all)
 *   - the provider asks us to wait more than 5 minutes
 */
export function looksLikeDailyQuota(err) {
  const s = JSON.stringify(err?.body ?? '') + ' ' + String(err?.message ?? '');
  const t = s.toLowerCase();
  if (/per\s*day|perday|requests_per_day|\brpd\b|daily limit|per_day/.test(t)) return true;
  if (/limit:\s*0\b/.test(t)) return true; // e.g. free_tier_requests, limit: 0
  const d = retryDelaySeconds(err);
  return d != null && d > 300;
}

/**
 * Robustly pull {text, uncertain} out of a model reply.
 * Strips markdown fences, tolerates leading prose, and on total failure keeps the
 * whole reply as `text` with parseError=true (so a chatty model still gets scored).
 */
export function parseModelJson(raw) {
  const fallback = (t) => ({ text: String(t ?? '').trim(), uncertain: [], parseError: true });
  if (raw == null) return fallback('');
  let s = String(raw).trim();
  if (!s) return { text: '', uncertain: [], parseError: false };

  // ```json ... ``` or ``` ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1].trim();

  const tryParse = (candidate) => {
    try {
      const o = JSON.parse(candidate);
      if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.text === 'string') {
        const unc = Array.isArray(o.uncertain) ? o.uncertain.map((x) => String(x)) : [];
        return { text: o.text, uncertain: unc, parseError: false };
      }
    } catch {
      /* fall through */
    }
    return null;
  };

  let hit = tryParse(s);
  if (hit) return hit;

  // Largest {...} span in the reply.
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    hit = tryParse(s.slice(first, last + 1));
    if (hit) return hit;
  }
  return fallback(s);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default { HttpError, isRetryable, looksLikeDailyQuota, parseModelJson, sleep };
