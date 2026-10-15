// Per-call cache addressing.
//
// The cache is the reason a re-run costs $0, so its key must name EVERY input that
// changes the answer. It used to be provider/model/promptVersion/mode/condition/page,
// which silently ignored two of them:
//   * the candidate's `options` (reasoningEffort, temperature, thinkingBudget). Flip a
//     model from reasoningEffort 'none' to 'low', re-run, and the old numbers came back
//     from cache labelled as the new settings, for $0, with nothing recorded to catch it.
//   * the candidate `id`. Two candidate rows on the same model - the obvious
//     "does thinking help?" experiment - collided, and the second one silently reported
//     the first one's results.
// Both now go into the path via a short fingerprint, and `options` is also written into
// the cached record so a stale hit is detectable after the fact.

import path from 'node:path';
import crypto from 'node:crypto';

export const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

/** Stable JSON: key order must not change the hash. */
function stable(obj) {
  if (obj == null || typeof obj !== 'object') return JSON.stringify(obj ?? null);
  if (Array.isArray(obj)) return `[${obj.map(stable).join(',')}]`;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
    .join(',')}}`;
}

/**
 * '' for a plain candidate (default id, no options) so the common path stays readable;
 * '@<8 hex>' otherwise. Any change to id or options forks the cache instead of
 * silently reusing it.
 */
export function candidateFingerprint(candidate) {
  const options = candidate.options && Object.keys(candidate.options).length ? candidate.options : null;
  const defaultId = `${candidate.provider}:${candidate.model}`;
  if (!options && candidate.id === defaultId) return '';
  const h = crypto
    .createHash('sha1')
    .update(stable({ id: candidate.id, options: options || {} }))
    .digest('hex')
    .slice(0, 8);
  return `@${h}`;
}

/**
 * <dataset>/cache/<provider>/<model>[@fp]/<promptVersion>/<mode>/<condition>/<pageId>.json
 */
export function cachePath(datasetDir, { candidate, condition, pageId, mode = 'transcribe', reviewOf = null, promptVersion }) {
  const modeDir = mode === 'review' ? `review__${safe(reviewOf)}` : 'transcribe';
  return path.join(
    datasetDir,
    'cache',
    safe(candidate.provider),
    `${safe(candidate.model)}${candidateFingerprint(candidate)}`,
    safe(promptVersion),
    modeDir,
    safe(condition),
    `${safe(pageId)}.json`,
  );
}

export default { safe, candidateFingerprint, cachePath };
