// Candidate table for the OCR bake-off.
//
// Chosen on 2026-09-04 from the LIVE model lists (OpenAI GET /v1/models, Gemini GET
// /v1beta/models) - see `node bakeoff.mjs discover` to regenerate the raw lists.
// Rule of thumb: cover every price tier of every current vision-capable general
// family rather than many near-duplicates of one tier. Cap ~12 model candidates:
// 12 distinct models here, plus ONE extra row that re-runs an existing model under a
// different setting (the thinking control) - a setting experiment, not a 13th model.
//
// tier: 'cheap'  - the price floor a family on a free/hobby key would actually use
//       'mid'    - the workhorse
//       'strong' - the escalation target for a two-model policy
//
// options are passed straight to the provider adapter:
//   reasoningEffort  OpenAI reasoning models - the LOWEST effort each model accepts
//                    (we want the model to READ, not deliberate; reasoning tokens bill
//                    at the output rate). Verified live on 2026-09-04: the gpt-5.6
//                    family and gpt-5.4-mini reject 'minimal' (400: supported values
//                    are none/low/medium/high/xhigh[/max]) and take 'none'; gpt-5-nano
//                    predates that change and takes 'minimal'.
//   temperature      0 where the provider accepts it (OpenAI reasoning models reject
//                    an explicit temperature, so it is omitted for them).
//   maxOutputTokens  8192 - the longest ground-truth page is under 150 words, but
//                    reasoning tokens share this budget.
//   thinkingBudget   Gemini thinkingConfig.thinkingBudget, pinned to 1 - the LOWEST
//                    each model accepts, exactly as reasoningEffort is above. Verified
//                    live 2026-09-04: a budget of literally 0 is rejected with 400
//                    "Request contains an invalid argument" by gemini-3.6-flash and
//                    gemini-3.5-flash-lite (gemini-3.1-flash-lite does accept 0), while
//                    any budget >= 1 is accepted by all of them. At budget 1 the Lite
//                    models emit 0 thought tokens; gemini-3.6-flash still emits ~57,
//                    which is its floor - and 1/35th of the ~2k it spends by default.
//                    thinkingLevel:'low' is NOT the parity setting: it made
//                    gemini-3.1-flash-lite think MORE (60 tokens vs 0 by default).
//                    The pin exists for PARITY with the OpenAI rows above:
//                    thought tokens bill at the OUTPUT rate, and gemini-3.6-flash spent
//                    ~1.98k of them on a 63-token answer - 84% of that call's cost -
//                    while every OpenAI row was forbidden to reason at all. Comparing
//                    those $/16pp figures compares settings, not models, and cost is
//                    the tiebreak after accuracy. `gemini:gemini-3.6-flash-thinking` is
//                    kept as the deliberate control: same model, thinking left on, so
//                    the question "does thinking buy accuracy?" has an answer instead
//                    of an assumption.

export const CANDIDATES = [
  // ---- OpenAI -------------------------------------------------------------
  {
    id: 'openai:gpt-5.6-sol',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    tier: 'strong',
    options: { reasoningEffort: 'none' },
    notes: 'Newest strong OpenAI family (2026-06-23). $4/$20 per M. Escalation target for agree-or-escalate policies.',
  },
  {
    id: 'openai:gpt-5.6-terra',
    provider: 'openai',
    model: 'gpt-5.6-terra',
    tier: 'mid',
    options: { reasoningEffort: 'none' },
    notes: 'Mid tier of the newest OpenAI family. $2/$12 per M.',
  },
  {
    id: 'openai:gpt-5.6-luna',
    provider: 'openai',
    model: 'gpt-5.6-luna',
    tier: 'cheap',
    options: { reasoningEffort: 'none' },
    notes: 'Cheap tier of the newest OpenAI family. $0.20/$1.20 per M.',
  },
  {
    id: 'openai:gpt-5.4-mini',
    provider: 'openai',
    model: 'gpt-5.4-mini',
    tier: 'mid',
    options: { reasoningEffort: 'none' },
    notes: 'Previous-generation mini (2026-03). $0.75/$4.50 per M. Sanity check that 5.6 is actually better.',
  },
  {
    id: 'openai:gpt-5-nano',
    provider: 'openai',
    model: 'gpt-5-nano',
    tier: 'cheap',
    options: { reasoningEffort: 'minimal' },
    notes: 'OpenAI price floor, $0.05/$0.40 per M. Takes reasoningEffort minimal (not none). Note it bills ~5.1k input tokens for the same 2048px page that the 5.6 family bills at ~3.4k - its image tokeniser is coarser, so it is less cheap than the sticker price suggests.',
  },
  {
    id: 'openai:gpt-4.1-mini',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    tier: 'cheap',
    options: { temperature: 0 },
    notes: 'Non-reasoning vision workhorse, $0.40/$1.60 per M. Control for "does reasoning help OCR at all".',
  },

  // ---- Gemini (AI Studio key - the key shape a family would bring) --------
  // Availability probed live 2026-09-04 on this key (see quota-probe.json):
  //   3.5/3.1 flash-lite, 3.6/3.5 flash, 3-flash-preview  -> 200 OK
  //   3.1-pro-preview, gemini-pro-latest                  -> 429, free-tier limit 0
  //   3.8/3.7 flash                                       -> 503 "high demand"
  //   the whole 2.5 family                                -> 404, retired for new users
  {
    id: 'gemini:gemini-3.1-pro-preview',
    provider: 'gemini',
    model: 'gemini-3.1-pro-preview',
    tier: 'strong',
    // No thinkingBudget: it could not be probed, because this model returns 429 on
    // this key before it ever runs (see notes). If a paid key ever reaches it, pin the
    // lowest budget it accepts before comparing its cost with anything else.
    options: {},
    notes: 'Strongest Gemini in the list. $2/$12 per M (<=200k prompt). KEPT DELIBERATELY EVEN THOUGH IT FAILS: on a free AI Studio key it returns 429 with "free_tier_requests, limit: 0" - Pro is not merely rate-limited on the free tier, it is unavailable. That is a product finding, and the run stops this candidate after one call.',
  },
  {
    id: 'gemini:gemini-3.8-flash',
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    tier: 'mid',
    options: { thinkingBudget: 1 },
    notes: 'Newest Flash (promo $0.75/$3.75 per M through 2026-12-31, then double). Returned 503 "high demand" on every probe on 2026-09-04; the runner retries with backoff, so re-run later before concluding anything.',
  },
  {
    id: 'gemini:gemini-3.6-flash',
    provider: 'gemini',
    model: 'gemini-3.6-flash',
    tier: 'mid',
    options: { thinkingBudget: 1 },
    notes: 'Newest Flash that actually answers on this key. Same promo price as 3.8 ($0.75/$3.75 per M). Thinking pinned to the minimum for parity with the OpenAI rows; by default it spends ~2k thought tokens on a 63-token answer, which was 84% of the call cost and made its $/16pp incomparable to models forbidden to reason. At budget 1 it still emits ~57 thought tokens - that is its floor, not a setting we chose.',
  },
  {
    id: 'gemini:gemini-3.6-flash-thinking',
    provider: 'gemini',
    model: 'gemini-3.6-flash',
    tier: 'mid',
    options: {},
    notes: 'SAME MODEL as gemini:gemini-3.6-flash with thinking left at the provider default. The control for "does thinking buy accuracy, and is it worth ~6x the cost?". Two rows on one model only work because the cache key forks on the candidate id and options.',
  },
  {
    id: 'gemini:gemini-3.5-flash-lite',
    provider: 'gemini',
    model: 'gemini-3.5-flash-lite',
    tier: 'cheap',
    options: { thinkingBudget: 1 },
    notes: 'Current cheap Flash-Lite, $0.30/$2.50 per M. The successor Google names in the 2.5-flash-lite retirement notice, so this is the realistic "family brings a free key" model.',
  },
  {
    id: 'gemini:gemini-3.1-flash-lite',
    provider: 'gemini',
    model: 'gemini-3.1-flash-lite',
    tier: 'cheap',
    options: { thinkingBudget: 1 },
    notes: 'Gemini price floor among reachable models, $0.25/$1.50 per M.',
  },

  // ---- Raw-OCR baseline ---------------------------------------------------
  {
    id: 'gcv:documentTextDetection',
    provider: 'gcv',
    model: 'documentTextDetection',
    tier: 'cheap',
    options: {},
    notes: 'Google Cloud Vision DOCUMENT_TEXT_DETECTION. No prompt: this is the floor the LLMs must beat, and it is what produced the first draft of the ground truth. $1.50 per 1000 units after 1000 free/month.',
  },

  // ---- Not runnable here --------------------------------------------------
  // Claude has NO API key in this environment. The anthropic adapter is written and
  // ready; add a row like the one below once ANTHROPIC_API_KEY exists. Until then
  // Claude is "untested via API" and was measured separately through Claude Code's
  // own image reading.
  // { id: 'anthropic:<model>', provider: 'anthropic', model: '<model>', tier: 'strong',
  //   options: { temperature: 0 }, notes: 'requires ANTHROPIC_API_KEY' },
  // NOTE: lib/pricing.json has NO anthropic rows (prices must be fetched live, not
  // recalled), so a run with --max-usd will refuse to start until one is added -
  // deliberately, because an unpriced candidate cannot be cost-capped.
];

export const CANDIDATES_BY_ID = Object.fromEntries(CANDIDATES.map((c) => [c.id, c]));

/** Resolve a --candidates value: 'all' | comma list of ids | comma list of providers. */
export function selectCandidates(spec) {
  if (!spec || spec === 'all') return CANDIDATES;
  const wanted = String(spec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const w of wanted) {
    if (CANDIDATES_BY_ID[w]) {
      out.push(CANDIDATES_BY_ID[w]);
      continue;
    }
    const byProvider = CANDIDATES.filter((c) => c.provider === w);
    if (byProvider.length) {
      out.push(...byProvider);
      continue;
    }
    const byTier = CANDIDATES.filter((c) => c.tier === w);
    if (byTier.length) {
      out.push(...byTier);
      continue;
    }
    throw new Error(`--candidates: unknown "${w}" (ids: ${CANDIDATES.map((c) => c.id).join(', ')})`);
  }
  return [...new Map(out.map((c) => [c.id, c])).values()];
}

/**
 * Review pairings actually run by `run --with-review`. Keep this list short: a
 * review call costs a second full image upload plus the draft.
 */
// Chosen from the raw2048 full-corpus leaderboard of 2026-09-04 (120 pages, prompt v2):
//   cheapest transcriber        gemini:gemini-3.1-flash-lite  (WERl 0.0268, $0.0086/16pp)
//                               - it is also the single most accurate row, and NO
//                                 candidate reached the WERl <= 0.02 bar the run plan
//                                 asked for, so "cheapest under 0.02" degenerates to
//                                 "cheapest of the accurate tier".
//   best strong model           openai:gpt-5.6-sol            (WERl 0.0427, best bagWERl
//                                 0.0240 - its residual is mostly ordering, not
//                                 misreading, which is what a reviewer can fix)
// The three pairings answer: does a second pass by the SAME cheap model help; does
// escalating the cheap draft to the strong model help; and does the strong model
// improve on its own draft (the ceiling of self-review).
export const REVIEW_PLAN = [
  { draftFrom: 'gemini:gemini-3.1-flash-lite', reviewer: 'gemini:gemini-3.1-flash-lite' },
  { draftFrom: 'gemini:gemini-3.1-flash-lite', reviewer: 'openai:gpt-5.6-sol' },
  { draftFrom: 'openai:gpt-5.6-sol', reviewer: 'openai:gpt-5.6-sol' },
];

/** Cheap pairs + strong escalation target for the offline agree-or-escalate policy. */
export const AGREE_PLAN = [
  { a: 'openai:gpt-5.6-luna', b: 'gemini:gemini-3.5-flash-lite', s: 'openai:gpt-5.6-sol' },
  { a: 'openai:gpt-5.6-luna', b: 'gemini:gemini-3.1-flash-lite', s: 'openai:gpt-5.6-sol' },
  { a: 'openai:gpt-4.1-mini', b: 'gemini:gemini-3.5-flash-lite', s: 'openai:gpt-5.6-terra' },
  { a: 'gcv:documentTextDetection', b: 'openai:gpt-5.6-luna', s: 'openai:gpt-5.6-sol' },
  { a: 'openai:gpt-5-nano', b: 'gemini:gemini-3.1-flash-lite', s: 'openai:gpt-5.6-sol' },
];

export default { CANDIDATES, CANDIDATES_BY_ID, selectCandidates, REVIEW_PLAN, AGREE_PLAN };
