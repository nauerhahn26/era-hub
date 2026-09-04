// Scoring core for the OCR bake-off.
//
// Two normalisations:
//   strict - what the TTS engine actually sees (case + punctuation drive prosody)
//   loose  - "are the spoken words right" (case- and punctuation-insensitive)
//
// Everything else (WER/CER, aggregates, derived policies) is built on these.
// All literal typography is written as \u escapes so the file survives any editor.

const CURLY_SINGLE = /[‘’‚‛′´`]/g;
const CURLY_DOUBLE = /[“”„‟″«»]/g;
const DASHES = /[‐‑‒–—―−]/g;
const ELLIPSIS = /…/g;
// Spaced dots: ". . ." with any run of whitespace between - INCLUDING newlines and
// carriage returns, because a provider that emits a layout break mid-ellipsis (GCV
// does, at every detected line break) would otherwise leave ".\n.\n." untouched and pay
// 3 strict word errors for it. The general \s+ collapse below runs AFTER this rule,
// so the class cannot rely on it.
const SPACED_DOTS = /\.[ \t\r\n\u00A0\u2000-\u200A\u202F\u205F]*\.[ \t\r\n\u00A0\u2000-\u200A\u202F\u205F]*\./g;
const EXOTIC_SPACE = /[   -   　]/g;
const ZERO_WIDTH = /[​‌‍⁠﻿­]/g;

/** NFKC + unify the typographic variants that no listener can hear apart. */
export function normalizeStrict(t) {
  if (t == null) return '';
  let s = String(t).normalize('NFKC');
  s = s.replace(CURLY_SINGLE, "'");
  s = s.replace(CURLY_DOUBLE, '"');
  s = s.replace(DASHES, '-');
  s = s.replace(ELLIPSIS, '...');
  s = s.replace(SPACED_DOTS, '...');
  s = s.replace(/\.{3,}/g, '...');
  s = s.replace(EXOTIC_SPACE, ' ');
  s = s.replace(ZERO_WIDTH, '');
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

/**
 * strict, then case- and punctuation-insensitive (keeps INTRA-word apostrophes).
 *
 * DASH POLICY (loose only; normalizeStrict still folds every dash to "-"):
 *   a dash BETWEEN two alphanumerics DISAPPEARS, so "better-at", "better—at" and
 *   "betterat" are one and the same token, and "well-known" == "wellknown".
 *   Every other dash was already dropped as punctuation.
 * Loose must be a RELAXATION of strict, so a dash may never change how many tokens a
 * side has relative to the other side. Joining does that symmetrically; splitting does
 * not, because normalizeStrict has already folded en, em and hyphen-minus to the same
 * character - the reference prints an em dash exactly where the models print "-", so a
 * rule that splits one and not the other charges word errors for typography no listener
 * can hear. Measured over the 2,900 cached calls, against the amended reference:
 *   join (this rule)          12,189 loose word errors, 0 records worse than no rule
 *   no dash rule at all       12,193
 *   split every dash          12,205  (17 records worse: compounds become two tokens)
 *   split em/en dash only     12,222  (16 records worse, and 19 records where loose
 *                                      errors EXCEED strict errors, up from 2)
 * Joining also leaves the loose token count <= the strict token count on both sides,
 * which is what keeps loose <= strict for dash typography. aggregate() carries
 * looseOverStrictPages as the standing regression check on that.
 */
export function normalizeLoose(t) {
  let s = normalizeStrict(t).toLowerCase();
  // Anything that is not a letter, digit, space, apostrophe or hyphen -> space.
  s = s.replace(/[^\p{L}\p{N}\s'\-]/gu, ' ');
  // Drop apostrophes/hyphens that are NOT intra-word (alnum required on both sides).
  s = s.replace(/(^|[^\p{L}\p{N}])['\-]+/gu, '$1');
  s = s.replace(/['\-]+(?![\p{L}\p{N}])/gu, '');
  // Intra-word dashes join rather than split: they leave no trace at all.
  s = s.replace(/(?<=[\p{L}\p{N}])-+(?=[\p{L}\p{N}])/gu, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

export function words(s) {
  const t = String(s).trim();
  return t === '' ? [] : t.split(' ');
}

/** Levenshtein distance over an array of tokens (words) or characters. */
export function levenshtein(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[m];
}

/**
 * Error rate for one hypothesis against one reference.
 * Returns {errors, refLen, hypLen, rate, phantom}.
 *  - empty ref & empty hyp        -> 0 errors, rate 0
 *  - empty ref & non-empty hyp    -> every hyp token is an insertion; rate capped
 *    at 1 (no denominator exists) and `phantom` carries the raw insertion count so
 *    the report can call "phantom text" out separately instead of burying it.
 */
export function rate(refTokens, hypTokens) {
  const refLen = refTokens.length;
  const hypLen = hypTokens.length;
  if (refLen === 0 && hypLen === 0) return { errors: 0, refLen: 0, hypLen: 0, rate: 0, phantom: 0 };
  if (refLen === 0) return { errors: hypLen, refLen: 0, hypLen, rate: 1, phantom: hypLen };
  const errors = levenshtein(refTokens, hypTokens);
  return { errors, refLen, hypLen, rate: errors / refLen, phantom: 0 };
}

/**
 * Order-INSENSITIVE error between two token bags.
 * WER is order-sensitive, which is right for narration but wrong for a book cover:
 * a model that reads the byline before the title gets every word right and still
 * scores WER ~= 0.9. This separates "wrong words" from "right words, wrong order":
 *   errors = max(tokens missing from hyp, tokens hyp added) - the same pairing WER
 *   uses for substitutions, minus the position constraint.
 * Returns the same shape as rate() so it aggregates identically.
 */
export function bagRate(refTokens, hypTokens) {
  const refLen = refTokens.length;
  const hypLen = hypTokens.length;
  if (refLen === 0 && hypLen === 0) return { errors: 0, refLen: 0, hypLen: 0, rate: 0, phantom: 0 };
  if (refLen === 0) return { errors: hypLen, refLen: 0, hypLen, rate: 1, phantom: hypLen };
  const counts = new Map();
  for (const t of refTokens) counts.set(t, (counts.get(t) || 0) + 1);
  for (const t of hypTokens) counts.set(t, (counts.get(t) || 0) - 1);
  let missing = 0;
  let extra = 0;
  for (const v of counts.values()) {
    if (v > 0) missing += v;
    else extra -= v;
  }
  const errors = Math.max(missing, extra);
  return { errors, refLen, hypLen, rate: errors / refLen, phantom: 0, missing, extra };
}

export const werStrict = (ref, hyp) => rate(words(normalizeStrict(ref)), words(normalizeStrict(hyp)));
export const werLoose = (ref, hyp) => rate(words(normalizeLoose(ref)), words(normalizeLoose(hyp)));
export const cerStrict = (ref, hyp) => rate([...normalizeStrict(ref)], [...normalizeStrict(hyp)]);
export const cerLoose = (ref, hyp) => rate([...normalizeLoose(ref)], [...normalizeLoose(hyp)]);
export const bagWerLoose = (ref, hyp) => bagRate(words(normalizeLoose(ref)), words(normalizeLoose(hyp)));

/** Full per-page score record. */
export function scorePage(gt, hyp) {
  const ws = werStrict(gt, hyp);
  const wl = werLoose(gt, hyp);
  const cs = cerStrict(gt, hyp);
  const cl = cerLoose(gt, hyp);
  const bl = bagWerLoose(gt, hyp);
  const sameMultisetLoose = bl.errors === 0 && bl.hypLen === bl.refLen;
  return {
    bagWerLoose: bl.rate,
    bagWerLooseErrors: bl.errors,
    // Right words, wrong order: WER punishes it, the bag metric does not. Covers
    // are where this happens (title vs byline first), and it must be visible as a
    // separate thing from a genuinely misread word.
    sameMultisetLoose,
    orderOnlyLoose: sameMultisetLoose && wl.errors > 0,
    werStrict: ws.rate,
    werStrictErrors: ws.errors,
    werStrictRefWords: ws.refLen,
    werLoose: wl.rate,
    werLooseErrors: wl.errors,
    werLooseRefWords: wl.refLen,
    cerStrict: cs.rate,
    cerStrictErrors: cs.errors,
    cerStrictRefChars: cs.refLen,
    cerLoose: cl.rate,
    cerLooseErrors: cl.errors,
    cerLooseRefChars: cl.refLen,
    phantomWords: wl.phantom,
    // Loose is a RELAXATION of strict, so on a page with a reference it must not cost
    // MORE word errors than strict. It can still happen honestly (loose splits a
    // hypothesis token on punctuation strict kept whole), which is why this is a
    // reported count rather than a throw - but a normaliser change that moves it is a
    // regression in the normaliser, not a finding about the models.
    looseOverStrict: wl.refLen > 0 && wl.errors > ws.errors,
    perfectStrict: normalizeStrict(gt) === normalizeStrict(hyp),
    perfectLoose: normalizeLoose(gt) === normalizeLoose(hyp),
  };
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/**
 * Aggregate per-page records into one candidate x condition summary.
 * Each record: {pageId, ok, error?, parseError?, uncertain, costUsd, latencyMs, score}.
 */
export function aggregate(pages) {
  const ok = pages.filter((p) => p.ok);
  const failed = pages.filter((p) => !p.ok);
  const sum = (f) => ok.reduce((a, p) => a + (f(p) || 0), 0);

  // Pages with an EMPTY reference (the phantom-text canary) have no denominator.
  // Counting their insertions in a micro rate adds an unbounded numerator over a
  // zero denominator - one such page can push a word-perfect corpus several times
  // past the 0.001 acceptance target - and macro would meanwhile use the capped
  // rate 1.0, so the two aggregates would describe the same page differently.
  // They are therefore excluded from EVERY rate, per metric, INCLUDING the two
  // perfect-page rates, and surface only as phantomPages / phantomWords and as
  // emptyRefCleanPages (the canary result: how many of them the model correctly left
  // empty). perfect-page % used to include them on the grounds that the effect was
  // bounded; it was, at ONE empty page in 120. The amendment pass took that to 11 in
  // 120, which moved a candidate's perfect(l) by up to 6.5pp for producing nothing,
  // and perfect-page rate is a stated acceptance criterion. One rule now: an empty
  // reference is scored as the canary it is and never as a rate over the corpus.
  const withRef = (refKey) => ok.filter((p) => (p.score[refKey] || 0) > 0);
  const micro = (errKey, refKey) => {
    const rel = withRef(refKey);
    const errs = rel.reduce((a, p) => a + (p.score[errKey] || 0), 0);
    const refs = rel.reduce((a, p) => a + (p.score[refKey] || 0), 0);
    return refs > 0 ? errs / refs : null;
  };
  const macro = (rateKey, refKey) => mean(withRef(refKey).map((p) => p.score[rateKey]));

  // Self-flag quality: a page "flagged itself" if it listed >= 1 uncertain word;
  // it is "wrong" if it has any loose word error or produced phantom text.
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const p of ok) {
    const flagged = Array.isArray(p.uncertain) && p.uncertain.length > 0;
    const wrong = p.score.werLooseErrors > 0 || p.score.phantomWords > 0;
    if (flagged && wrong) tp++;
    else if (flagged && !wrong) fp++;
    else if (!flagged && wrong) fn++;
  }

  // the pages every rate below is computed over, named once so the perfect-page rates
  // and the WER/CER rates can never drift apart again
  const scoredPages = withRef('werLooseRefWords');
  const emptyRefPages = ok.filter((p) => (p.score.werLooseRefWords || 0) === 0);

  const latencies = ok.map((p) => p.latencyMs).filter((x) => typeof x === 'number');
  const totalCost = ok.reduce((a, p) => a + (p.costUsd || 0), 0);
  const costKnown = ok.filter((p) => typeof p.costUsd === 'number').length;

  return {
    pagesRun: pages.length,
    pagesOk: ok.length,
    pagesFailed: failed.length,
    // pages that actually carry a reference and therefore drive EVERY rate below
    pagesScored: scoredPages.length,
    pagesEmptyRef: emptyRefPages.length,
    // the canary result, reported instead of folded into perfect-page %: empty-reference
    // pages where the model correctly produced nothing
    emptyRefCleanPages: emptyRefPages.filter((p) => p.score.phantomWords === 0).length,
    failures: failed.map((p) => ({ pageId: p.pageId, error: p.error })),
    microWerLoose: micro('werLooseErrors', 'werLooseRefWords'),
    microWerStrict: micro('werStrictErrors', 'werStrictRefWords'),
    microCerLoose: micro('cerLooseErrors', 'cerLooseRefChars'),
    microCerStrict: micro('cerStrictErrors', 'cerStrictRefChars'),
    // order-insensitive twin of microWerLoose: same words, any order
    microBagWerLoose: micro('bagWerLooseErrors', 'werLooseRefWords'),
    macroWerLoose: macro('werLoose', 'werLooseRefWords'),
    macroWerStrict: macro('werStrict', 'werStrictRefWords'),
    macroCerLoose: macro('cerLoose', 'cerLooseRefChars'),
    macroCerStrict: macro('cerStrict', 'cerStrictRefChars'),
    macroBagWerLoose: macro('bagWerLoose', 'werLooseRefWords'),
    perfectLoosePct: scoredPages.length ? scoredPages.filter((p) => p.score.perfectLoose).length / scoredPages.length : null,
    perfectStrictPct: scoredPages.length
      ? scoredPages.filter((p) => p.score.perfectStrict).length / scoredPages.length
      : null,
    // standing regression check on the normalisers: loose is meant to be a relaxation
    // of strict, so this should stay at its floor. It is a property of the scoring
    // code, not of the candidate - if a normaliser change moves it, the change is wrong.
    looseOverStrictPages: scoredPages.filter((p) => p.score.looseOverStrict).length,
    // pages whose every word is right but whose block order differs from the
    // reference - a reading-order convention question, not a transcription error
    orderOnlyPages: ok.filter((p) => p.score.orderOnlyLoose).length,
    phantomPages: ok.filter((p) => p.score.phantomWords > 0).length,
    phantomWords: sum((p) => p.score.phantomWords),
    parseErrors: ok.filter((p) => p.parseError).length,
    totalCostUsd: totalCost,
    costPagesKnown: costKnown,
    costPerPageUsd: costKnown ? totalCost / costKnown : null,
    costPer16PageBookUsd: costKnown ? (totalCost / costKnown) * 16 : null,
    latencyMsMedian: median(latencies),
    latencyMsP95: percentile(latencies, 95),
    selfFlag: {
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      precision: tp + fp ? tp / (tp + fp) : null,
      recall: tp + fn ? tp / (tp + fn) : null,
    },
  };
}

/**
 * Derived policy "agree(A,B) -> accept A, else escalate to strong S".
 * Computed offline from results already on disk; costs nothing extra to evaluate.
 * byPage: pageId -> {gt, a:{text,costUsd,ok}, b:{...}, s:{...}}
 */
export function agreePolicy(byPage) {
  const pages = Object.entries(byPage).filter(([, v]) => v.a?.ok && v.b?.ok && v.s?.ok);
  if (!pages.length) return null;
  let disagreements = 0;
  let cost = 0;
  // A policy whose members include a model with no pricing.json row must not report
  // a confident $/page built from a silent 0. Count the pages where every call the
  // policy actually PAYS for is priced (an escalation the policy never makes costs
  // nothing, so S's price only matters on disagreement pages), and report null
  // costs - rendered "-" - unless coverage is complete. aggregate() already guards
  // its own cost path this way; these two must not disagree.
  let costPagesKnown = 0;
  const scored = [];
  for (const [pageId, v] of pages) {
    const agree = normalizeLoose(v.a.text) === normalizeLoose(v.b.text);
    if (!agree) disagreements++;
    const chosen = agree ? v.a.text : v.s.text;
    const paid = agree ? [v.a.costUsd, v.b.costUsd] : [v.a.costUsd, v.b.costUsd, v.s.costUsd];
    if (paid.every((x) => typeof x === 'number')) {
      costPagesKnown++;
      cost += paid.reduce((a, b) => a + b, 0);
    }
    scored.push({ pageId, ok: true, uncertain: [], costUsd: 0, latencyMs: null, score: scorePage(v.gt, chosen) });
  }
  const agg = aggregate(scored);
  const fullyPriced = costPagesKnown === pages.length;
  return {
    pages: pages.length,
    disagreeRate: disagreements / pages.length,
    costPagesKnown,
    costPriced: fullyPriced,
    totalCostUsd: fullyPriced ? cost : null,
    costPerPageUsd: fullyPriced ? cost / pages.length : null,
    costPer16PageBookUsd: fullyPriced ? (cost / pages.length) * 16 : null,
    microWerLoose: agg.microWerLoose,
    macroWerLoose: agg.macroWerLoose,
    microBagWerLoose: agg.microBagWerLoose,
    perfectLoosePct: agg.perfectLoosePct,
    perfectStrictPct: agg.perfectStrictPct,
  };
}

export default {
  normalizeStrict,
  normalizeLoose,
  words,
  levenshtein,
  rate,
  bagRate,
  werStrict,
  werLoose,
  cerStrict,
  cerLoose,
  bagWerLoose,
  scorePage,
  aggregate,
  agreePolicy,
  mean,
  median,
  percentile,
};
