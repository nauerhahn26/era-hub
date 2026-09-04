#!/usr/bin/env node
// OCR bake-off CLI. Node 18+ stdlib only - no npm dependencies, by house rule.
//
//   node tools/ocr-bakeoff/bakeoff.mjs <subcommand> [flags]
//
// Subcommands: build-dataset | discover | probe-quota | run | score | report
// See tools/ocr-bakeoff/README.md. Secrets are read from env by NAME only and are
// never printed, logged, or written to any output file.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { buildDataset, loadDataset, imageFor, selectPages, CONDITIONS } from './lib/dataset.mjs';
import { selectCandidates, CANDIDATES, REVIEW_PLAN, AGREE_PLAN, CANDIDATES_BY_ID } from './lib/candidates.mjs';
import { getProvider, CONCURRENCY } from './lib/providers/index.mjs';
import { isRetryable, looksLikeDailyQuota, retryDelaySeconds, quotaFacts, sleep } from './lib/providers/util.mjs';
import { PROMPT_VERSION, transcribePrompt, reviewPrompt } from './lib/prompts.mjs';
import { loadPricing, callCost, modelPriced } from './lib/cost.mjs';
import { scorePage, aggregate, agreePolicy, normalizeLoose } from './lib/score.mjs';
import { cachePath, candidateFingerprint } from './lib/cache.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- arg parsing
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

const nz = (x, d = 4) => (x == null || Number.isNaN(x) ? '-' : Number(x).toFixed(d));
const pct = (x) => (x == null ? '-' : `${(x * 100).toFixed(1)}%`);
const usd = (x) => (x == null ? '-' : `$${Number(x).toFixed(x < 0.01 ? 5 : 4)}`);

// ---------------------------------------------------------------- incidents
function appendIncident(datasetDir, incident) {
  const f = path.join(datasetDir, 'incidents.json');
  let list = [];
  if (fs.existsSync(f)) {
    try {
      list = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      list = [];
    }
  }
  list.push({ at: new Date().toISOString(), ...incident });
  fs.writeFileSync(f, JSON.stringify(list, null, 2));
}

// ---------------------------------------------------------------- cache paths
// Path layout and its fingerprint live in lib/cache.mjs (unit-tested there).
const cacheFile = (datasetDir, spec) => cachePath(datasetDir, { ...spec, promptVersion: PROMPT_VERSION });

function readCache(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// ---------------------------------------------------------------- build-dataset
function cmdBuildDataset(args) {
  const rowsPath = args.rows || die('--rows <gt-rows.json> required');
  const outDir = args.out || die('--out <dataset dir> required');
  console.log(`build-dataset: ${rowsPath} -> ${outDir}`);
  const { dataset, built, reused, problems } = buildDataset({ rowsPath, outDir });
  console.log(`  pages:      ${dataset.count}`);
  console.log(`  books:      ${Object.entries(dataset.books).map(([k, v]) => `${k}(${v})`).join(' ')}`);
  console.log(`  images:     ${built} built, ${reused} reused (long edge 2048, q~85)`);
  console.log(`  empty-gt:   ${dataset.emptyGtPages.length ? dataset.emptyGtPages.join(', ') : 'none'}`);
  let resolvable = 0;
  const unresolved = [];
  for (const p of dataset.pages) {
    const missing = CONDITIONS.filter((c) => !imageFor(p, c));
    if (missing.length) unresolved.push(`${p.id}: ${missing.join(',')}`);
    else resolvable++;
  }
  console.log(`  conditions: ${resolvable}/${dataset.count} pages resolve all of ${CONDITIONS.join(', ')}`);
  if (unresolved.length) console.log(`  UNRESOLVED: ${unresolved.join(' | ')}`);
  if (problems.length) console.log(`  problems:   ${problems.join(' | ')}`);
  console.log(`  wrote ${path.join(outDir, 'dataset.json')}`);
  if (unresolved.length || problems.length) process.exitCode = 2;
}

// ---------------------------------------------------------------- discover
async function cmdDiscover(args) {
  const out = { at: new Date().toISOString(), openai: null, gemini: null };
  if (process.env.OPENAI_API_KEY) {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    const j = await res.json();
    out.openai = (j.data || [])
      .map((m) => ({ id: m.id, created: m.created }))
      .sort((a, b) => b.created - a.created);
    console.log(`openai: ${out.openai.length} models (newest first)`);
    for (const m of out.openai.slice(0, 40)) console.log(`  ${new Date(m.created * 1000).toISOString().slice(0, 10)} ${m.id}`);
  } else console.log('openai: OPENAI_API_KEY not set - skipped');

  if (process.env.GOOGLE_AI_STUDIO_KEY) {
    const gem = await getProvider('gemini').listModels();
    out.gemini = gem.map((m) => ({ id: m.name.replace('models/', ''), displayName: m.displayName }));
    console.log(`gemini: ${out.gemini.length} generateContent models`);
    for (const m of out.gemini) console.log(`  ${m.id}`);
  } else console.log('gemini: GOOGLE_AI_STUDIO_KEY not set - skipped');

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
    console.log(`wrote ${args.out}`);
  }
  console.log('\nRegistered candidates (lib/candidates.mjs):');
  for (const c of CANDIDATES) console.log(`  [${c.tier.padEnd(6)}] ${c.id}`);
}

// ---------------------------------------------------------------- probe-quota
async function cmdProbeQuota(args) {
  const datasetDir = args.dataset || die('--dataset <dir> required');
  const dataset = loadDataset(datasetDir);
  const page = dataset.pages[0];
  const img = imageFor(page, 'raw2048') || die('no raw2048 image to probe with');
  const cands = selectCandidates(args.candidates || 'gemini');
  const runId = crypto.randomUUID();
  console.log(`probe-quota: 1 call per candidate (${cands.length}) on one page, condition raw2048 (run id ${runId})`);
  const results = [];
  for (const c of cands) {
    const prov = getProvider(c.provider);
    const t0 = Date.now();
    try {
      const r = await prov.transcribe({
        model: c.model,
        imagePath: img,
        prompt: transcribePrompt(),
        mode: 'transcribe',
        options: c.options,
      });
      const row = {
        candidate: c.id,
        ok: true,
        httpStatus: r.httpStatus,
        latencyMs: r.latencyMs,
        chars: r.text.length,
        modelReturned: r.modelReturned,
      };
      results.push(row);
      console.log(`  ok    ${c.id} ${r.latencyMs}ms status=${r.httpStatus} chars=${row.chars}`);
    } catch (e) {
      const daily = looksLikeDailyQuota(e);
      const row = {
        candidate: c.id,
        ok: false,
        httpStatus: e.status ?? null,
        error: e.message,
        dailyQuota: daily,
        quota: quotaFacts(e),
        retryAfterSeconds: retryDelaySeconds(e),
        latencyMs: Date.now() - t0,
      };
      results.push(row);
      console.log(`  FAIL  ${c.id} status=${e.status ?? '-'} dailyQuota=${daily} :: ${e.message.slice(0, 240)}`);
      appendIncident(datasetDir, {
        runId,
        kind: daily ? 'daily-quota' : 'probe-error',
        candidate: c.id,
        status: e.status ?? null,
        message: e.message,
        quota: quotaFacts(e),
        retryAfterSeconds: retryDelaySeconds(e),
      });
    }
  }
  const f = path.join(datasetDir, 'quota-probe.json');
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), runId, promptVersion: PROMPT_VERSION, results }, null, 2));
  console.log(`wrote ${f}`);
}

// ---------------------------------------------------------------- run
async function runOne({ candidate, condition, page, datasetDir, pricing, mode, draft, reviewOf, state, total }) {
  const file = cacheFile(datasetDir, { candidate, condition, pageId: page.id, mode, reviewOf });
  const incident = (inc) => appendIncident(datasetDir, { runId: state.runId, ...inc });
  const cachedAny = readCache(file);
  // Successes are never re-billed. Failures ARE retried by default: a 429/503 is
  // usually transient, and a failed call cost nothing, so caching it forever would
  // silently drop a candidate. --keep-failures pins them for offline re-scoring.
  const cached = cachedAny && (cachedAny.ok || state.keepFailures) ? cachedAny : null;
  if (cached) {
    state.done++;
    state.cached++;
    if (cached.ok) state.spend[candidate.id] = (state.spend[candidate.id] || 0) + (cached.costUsd || 0);
    console.log(
      `[${state.done}/${total}] ${candidate.id} ${condition} ${page.id} cached ${cached.ok ? 'ok' : 'ERR'}`,
    );
    return cached;
  }

  // A candidate stopped by the cost cap or a daily quota must leave a RECORD, not a
  // hole: otherwise it is aggregated over a smaller, arbitrary page subset than its
  // neighbours while being sorted next to them as if comparable.
  if (state.stopped.has(candidate.id)) {
    state.done++;
    const reason = state.stopReason.get(candidate.id) || 'candidate stopped';
    const rec = {
      ok: false,
      candidate: candidate.id,
      provider: candidate.provider,
      model: candidate.model,
      options: candidate.options || {},
      promptVersion: PROMPT_VERSION,
      mode,
      reviewOf: reviewOf || null,
      condition,
      pageId: page.id,
      skipped: true,
      error: `candidate stopped: ${reason}`,
      httpStatus: null,
      attempts: 0,
      at: new Date().toISOString(),
    };
    writeCache(file, rec);
    console.log(`[${state.done}/${total}] ${candidate.id} ${condition} ${page.id} SKIPPED (${reason})`);
    return rec;
  }

  const img = imageFor(page, condition);
  if (!img) {
    state.done++;
    const rec = { ok: false, error: `no image for condition ${condition}`, candidate: candidate.id, condition, pageId: page.id };
    writeCache(file, rec);
    console.log(`[${state.done}/${total}] ${candidate.id} ${condition} ${page.id} NO-IMAGE`);
    return rec;
  }

  const prov = getProvider(candidate.provider);
  const prompt = mode === 'review' ? reviewPrompt(draft) : transcribePrompt();

  let attempt = 0;
  let lastErr = null;
  let dailyQuotaStop = false;
  while (attempt < 5) {
    try {
      const r = await prov.transcribe({
        model: candidate.model,
        imagePath: img,
        prompt,
        mode,
        draft,
        options: candidate.options || {},
      });
      const cost = callCost({ provider: candidate.provider, model: candidate.model, usage: r.usage }, pricing);
      const rec = {
        ok: true,
        candidate: candidate.id,
        provider: candidate.provider,
        model: candidate.model,
        modelReturned: r.modelReturned,
        // the settings this number was produced under - the cache path forks on them,
        // and storing them makes a stale hit detectable months later
        options: candidate.options || {},
        optionsFingerprint: candidateFingerprint(candidate),
        promptVersion: PROMPT_VERSION,
        mode,
        reviewOf: reviewOf || null,
        condition,
        pageId: page.id,
        imagePath: img,
        text: r.text,
        uncertain: r.uncertain,
        parseError: r.parseError,
        incomplete: r.incomplete,
        usage: r.usage,
        costUsd: cost.usd,
        costPriced: cost.priced,
        latencyMs: r.latencyMs,
        httpStatus: r.httpStatus,
        attempts: attempt + 1,
        at: new Date().toISOString(),
        raw: r.raw,
      };
      writeCache(file, rec);
      state.done++;
      state.spend[candidate.id] = (state.spend[candidate.id] || 0) + (cost.usd || 0);
      console.log(
        `[${state.done}/${total}] ${candidate.id} ${condition} ${page.id} ok ${r.latencyMs}ms ` +
          `in=${r.usage.inputTokens ?? '-'} out=${r.usage.outputTokens ?? '-'} ${usd(cost.usd)} ` +
          `chars=${r.text.length}${r.parseError ? ' PARSE-ERR' : ''}${r.incomplete ? ` INCOMPLETE(${r.incomplete})` : ''}`,
      );
      // An UNPRICED call adds 0 to the spend, so --max-usd could never fire for a model
      // with no pricing.json row: the run would bill without limit and print "-" for the
      // cost. A cap that cannot be enforced is worse than no cap, so stop the candidate.
      if (state.maxUsd != null && !cost.priced) {
        state.stopped.add(candidate.id);
        state.stopReason.set(candidate.id, 'unpriced (no pricing.json row) with --max-usd set');
        console.log(
          `!! UNPRICED: ${candidate.id} has no price row for model "${candidate.model}", so --max-usd cannot be ` +
            `enforced - STOPPING this candidate. Add a row to lib/pricing.json (or drop --max-usd).`,
        );
        incident({ kind: 'unpriced', candidate: candidate.id, model: candidate.model, maxUsd: state.maxUsd });
      } else if (state.maxUsd != null && state.spend[candidate.id] > state.maxUsd) {
        state.stopped.add(candidate.id);
        state.stopReason.set(candidate.id, `cost cap (${usd(state.spend[candidate.id])} > ${usd(state.maxUsd)})`);
        console.log(
          `!! COST CAP: ${candidate.id} spent ${usd(state.spend[candidate.id])} > --max-usd ${usd(state.maxUsd)} ` +
            `- STOPPING this candidate. Remaining pages will be skipped (not silently capped).`,
        );
        incident({
          kind: 'cost-cap',
          candidate: candidate.id,
          spentUsd: state.spend[candidate.id],
          maxUsd: state.maxUsd,
        });
      }
      return rec;
    } catch (e) {
      lastErr = e;
      const daily = e.status === 429 && looksLikeDailyQuota(e);
      if (daily) {
        state.stopped.add(candidate.id);
        state.stopReason.set(candidate.id, 'daily quota');
        dailyQuotaStop = true; // one incident per event: do NOT also log call-failure below
        incident({
          kind: 'daily-quota',
          candidate: candidate.id,
          condition,
          pageId: page.id,
          status: e.status,
          message: e.message,
          quota: quotaFacts(e),
          retryAfterSeconds: retryDelaySeconds(e),
        });
        console.log(
          `!! DAILY QUOTA: ${candidate.id} hit a per-day quota (status ${e.status}) - not retrying, stopping this candidate.`,
        );
        break;
      }
      if (!isRetryable(e) || attempt === 4) break;
      const asked = retryDelaySeconds(e);
      const backoff = Math.max(
        Math.round(1000 * 2 ** attempt * (1 + Math.random() * 0.3)),
        asked != null ? Math.round(asked * 1000) + 1000 : 0,
      );
      console.log(
        `   retry ${attempt + 1}/4 ${candidate.id} ${condition} ${page.id} status=${e.status ?? '-'} in ${backoff}ms :: ${String(
          e.message,
        ).slice(0, 160)}`,
      );
      await sleep(backoff);
      attempt++;
    }
  }

  const rec = {
    ok: false,
    candidate: candidate.id,
    provider: candidate.provider,
    model: candidate.model,
    options: candidate.options || {},
    promptVersion: PROMPT_VERSION,
    mode,
    reviewOf: reviewOf || null,
    condition,
    pageId: page.id,
    dailyQuota: dailyQuotaStop,
    error: String(lastErr?.message || lastErr),
    httpStatus: lastErr?.status ?? null,
    attempts: attempt + 1,
    at: new Date().toISOString(),
  };
  writeCache(file, rec);
  state.done++;
  console.log(
    `[${state.done}/${total}] ${candidate.id} ${condition} ${page.id} FAIL status=${rec.httpStatus ?? '-'} :: ${rec.error.slice(0, 200)}`,
  );
  // A daily-quota event already wrote its own incident above; logging it a second time
  // as 'call-failure' made the report's quota section claim API failures that never
  // happened (every call-failure row in the first smoke run was a duplicate).
  if (!dailyQuotaStop) {
    incident({
      kind: 'call-failure',
      candidate: candidate.id,
      condition,
      pageId: page.id,
      status: rec.httpStatus,
      message: rec.error,
    });
  }
  return rec;
}

/** Run `jobs` with at most `limit` in flight. */
async function pool(jobs, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (i < jobs.length) {
      const idx = i++;
      await worker(jobs[idx]);
    }
  });
  await Promise.all(runners);
}

async function cmdRun(args) {
  const datasetDir = args.dataset || die('--dataset <dir> required');
  const dataset = loadDataset(datasetDir);
  const cands = selectCandidates(args.candidates || 'all');
  const conditions = String(args.conditions || 'raw2048')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of conditions) if (!CONDITIONS.includes(c)) die(`unknown condition "${c}" (have ${CONDITIONS.join(', ')})`);
  const pages = selectPages(dataset, args.pages || 'all');
  const pricing = loadPricing();
  const maxUsd = args['max-usd'] != null && args['max-usd'] !== true ? Number(args['max-usd']) : null;
  const withReview = Boolean(args['with-review']);

  const runId = crypto.randomUUID();
  const total = cands.length * conditions.length * pages.length;
  console.log(
    `run: ${cands.length} candidates x ${conditions.length} conditions x ${pages.length} pages = ${total} calls ` +
      `(prompt ${PROMPT_VERSION}; cached calls are free and never re-billed)`,
  );
  console.log(`  run id:     ${runId}`);
  console.log(`  candidates: ${cands.map((c) => c.id).join(', ')}`);
  console.log(`  conditions: ${conditions.join(', ')}`);
  console.log(`  max-usd:    ${maxUsd == null ? 'none' : usd(maxUsd)} per candidate`);

  // Preflight: a candidate with no price row bills without limit and reports "-".
  // Warn always; refuse to start when a cap was asked for and could not be honoured.
  const unpriced = cands.filter((c) => !modelPriced(c.provider, c.model, pricing));
  if (unpriced.length) {
    console.log(`!! UNPRICED candidates (no lib/pricing.json row): ${unpriced.map((c) => c.id).join(', ')}`);
    console.log('   Their cost columns will read "-" and they contribute $0 to any spend cap.');
    if (maxUsd != null && !args['allow-unpriced']) {
      die(
        `--max-usd cannot be enforced for ${unpriced.map((c) => c.id).join(', ')}. ` +
          'Add price rows to lib/pricing.json, drop --max-usd, or pass --allow-unpriced to run them uncapped.',
      );
    }
  }

  const state = {
    runId,
    done: 0,
    cached: 0,
    spend: {},
    stopped: new Set(),
    stopReason: new Map(),
    maxUsd,
    keepFailures: Boolean(args['keep-failures']),
  };

  // Group jobs by provider so each provider gets its own concurrency budget.
  const byProvider = new Map();
  for (const c of cands) {
    for (const cond of conditions) {
      for (const p of pages) {
        if (!byProvider.has(c.provider)) byProvider.set(c.provider, []);
        byProvider.get(c.provider).push({ candidate: c, condition: cond, page: p });
      }
    }
  }

  await Promise.all(
    [...byProvider.entries()].map(([prov, jobs]) =>
      pool(jobs, CONCURRENCY[prov] ?? 2, (job) =>
        runOne({ ...job, datasetDir, pricing, mode: 'transcribe', state, total }),
      ),
    ),
  );

  if (withReview) {
    console.log('\nreview pass (run plan pairings only):');
    const reviewJobs = [];
    for (const { draftFrom, reviewer } of REVIEW_PLAN) {
      const rc = CANDIDATES_BY_ID[reviewer];
      const dc = CANDIDATES_BY_ID[draftFrom];
      if (!rc || !dc) continue;
      if (!cands.some((c) => c.id === reviewer) || !cands.some((c) => c.id === draftFrom)) continue;
      for (const cond of conditions) {
        for (const p of pages) {
          const draftRec = readCache(cacheFile(datasetDir, { candidate: dc, condition: cond, pageId: p.id }));
          if (!draftRec?.ok) continue;
          reviewJobs.push({ candidate: rc, condition: cond, page: p, draft: draftRec.text, reviewOf: draftFrom });
        }
      }
    }
    const revTotal = state.done + reviewJobs.length;
    const byProv2 = new Map();
    for (const j of reviewJobs) {
      if (!byProv2.has(j.candidate.provider)) byProv2.set(j.candidate.provider, []);
      byProv2.get(j.candidate.provider).push(j);
    }
    await Promise.all(
      [...byProv2.entries()].map(([prov, jobs]) =>
        pool(jobs, CONCURRENCY[prov] ?? 2, (job) =>
          runOne({ ...job, datasetDir, pricing, mode: 'review', state, total: revTotal }),
        ),
      ),
    );
  }

  console.log('\nspend by candidate (this run + cached):');
  for (const c of cands) {
    const stopped = state.stopped.has(c.id) ? `  [STOPPED EARLY: ${state.stopReason.get(c.id) || 'stopped'}]` : '';
    console.log(`  ${c.id.padEnd(34)} ${usd(state.spend[c.id] || 0)}${stopped}`);
  }
  console.log(`cached hits: ${state.cached}/${state.done}`);
  console.log(`run id: ${runId} (incidents from this run are tagged with it)`);
}

// ---------------------------------------------------------------- score
function walkCache(datasetDir) {
  const root = path.join(datasetDir, 'cache');
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) stack.push(f);
      else if (e.name.endsWith('.json')) out.push(f);
    }
  }
  return out;
}

function cmdScore(args) {
  const datasetDir = args.dataset || die('--dataset <dir> required');
  const outDir = args.out || die('--out <results dir> required');
  const dataset = loadDataset(datasetDir);
  const pricing = loadPricing();
  fs.mkdirSync(outDir, { recursive: true });

  const gtById = Object.fromEntries(dataset.pages.map((p) => [p.id, p.gt]));
  const files = walkCache(datasetDir);
  const rows = [];
  for (const f of files) {
    const rec = readCache(f);
    if (!rec || !rec.pageId) continue;
    const gt = gtById[rec.pageId];
    if (gt == null) continue;
    const key = rec.mode === 'review' ? `${rec.candidate}<-${rec.reviewOf}` : rec.candidate;
    // Results produced under DIFFERENT prompt versions are different experiments and
    // must never be blended into one leaderboard row: the cache forks on prompt
    // version, so the scorer has to as well (it walks the whole cache tree).
    const promptVersion = rec.promptVersion || 'unknown';
    // Settings fork the cache; they must fork the leaderboard too, or a re-run after a
    // settings change silently averages the old settings' results into the new row.
    const optionsKey =
      rec.optionsFingerprint ??
      (rec.options
        ? candidateFingerprint({ id: rec.candidate, provider: rec.provider, model: rec.model, options: rec.options })
        : '');
    if (!rec.ok) {
      rows.push({
        key,
        candidate: rec.candidate,
        promptVersion,
        optionsKey,
        options: rec.options ?? null,
        mode: rec.mode || 'transcribe',
        reviewOf: rec.reviewOf || null,
        condition: rec.condition,
        pageId: rec.pageId,
        ok: false,
        skipped: Boolean(rec.skipped),
        error: rec.error,
        httpStatus: rec.httpStatus ?? null,
      });
      continue;
    }
    // Recompute cost from stored usage so a pricing.json update re-prices for free.
    const cost = callCost({ provider: rec.provider, model: rec.model, usage: rec.usage }, pricing);
    rows.push({
      key,
      candidate: rec.candidate,
      provider: rec.provider,
      model: rec.model,
      modelReturned: rec.modelReturned ?? null,
      promptVersion,
      optionsKey,
      options: rec.options ?? null,
      optionsFingerprint: rec.optionsFingerprint ?? null,
      mode: rec.mode || 'transcribe',
      reviewOf: rec.reviewOf || null,
      condition: rec.condition,
      pageId: rec.pageId,
      slug: rec.pageId.replace(/-p\d+$/, ''),
      ok: true,
      parseError: Boolean(rec.parseError),
      incomplete: rec.incomplete ?? null,
      uncertain: rec.uncertain || [],
      usage: rec.usage,
      costUsd: cost.usd,
      costPriced: cost.priced,
      costFreeUnitsPerMonth: cost.freeUnitsPerMonth ?? null,
      latencyMs: rec.latencyMs,
      httpStatus: rec.httpStatus,
      hyp: rec.text,
      score: scorePage(gt, rec.text),
    });
  }

  // summary: prompt version x key x condition
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.promptVersion}||${r.optionsKey ?? ''}||${r.key}||${r.condition}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const summary = [];
  for (const [k, list] of groups) {
    const [promptVersion, optionsKey, key, condition] = k.split('||');
    const first = list.find((r) => r.ok) || list[0];
    summary.push({
      key,
      candidate: first.candidate,
      provider: first.provider ?? CANDIDATES_BY_ID[first.candidate]?.provider ?? null,
      model: first.model ?? CANDIDATES_BY_ID[first.candidate]?.model ?? null,
      tier: CANDIDATES_BY_ID[first.candidate]?.tier ?? null,
      promptVersion,
      optionsKey,
      options: first.options ?? null,
      mode: first.mode,
      reviewOf: first.reviewOf,
      condition,
      freeUnitsPerMonth: list.find((r) => r.costFreeUnitsPerMonth != null)?.costFreeUnitsPerMonth ?? null,
      ...aggregate(list),
    });
  }
  summary.sort((a, b) => (a.microWerLoose ?? 9) - (b.microWerLoose ?? 9) || (a.costPerPageUsd ?? 9) - (b.costPerPageUsd ?? 9));

  // derived policies: agree(A,B) -> else S, per prompt version x condition
  const policies = [];
  const conds = [...new Set(rows.map((r) => r.condition))];
  const promptVersions = [...new Set(rows.map((r) => r.promptVersion))];
  for (const pv of promptVersions) {
    for (const cond of conds) {
      for (const plan of AGREE_PLAN) {
        const pick = (cid) =>
          Object.fromEntries(
            rows
              .filter((r) => r.ok && r.mode === 'transcribe' && r.promptVersion === pv && r.candidate === cid && r.condition === cond)
              .map((r) => [r.pageId, { text: r.hyp, costUsd: r.costUsd, ok: r.ok }]),
          );
        const A = pick(plan.a);
        const B = pick(plan.b);
        const S = pick(plan.s);
        const byPage = {};
        for (const pid of Object.keys(A)) {
          if (!B[pid] || !S[pid]) continue;
          byPage[pid] = { gt: gtById[pid], a: A[pid], b: B[pid], s: S[pid] };
        }
        const res = agreePolicy(byPage);
        if (res) policies.push({ kind: 'agree-or-escalate', promptVersion: pv, condition: cond, ...plan, ...res });
      }
    }
  }
  policies.sort((a, b) => (a.microWerLoose ?? 9) - (b.microWerLoose ?? 9));

  // possible ground-truth errors: >=3 DISTINCT candidates from >=2 providers agree
  // (loose) with each other but disagree with GT.
  // The same model under raw / raw2048 / processed is one opinion, not three: counting
  // condition-variants as separate voters collapsed the bar to "2 models agree" on the
  // 3-condition grid and sent a human re-verifying reference pages for nothing.
  const gtSuspects = [];
  for (const page of dataset.pages) {
    const hyps = rows.filter((r) => r.ok && r.mode === 'transcribe' && r.pageId === page.id);
    if (hyps.length < 3) continue;
    const buckets = new Map();
    for (const h of hyps) {
      const n = normalizeLoose(h.hyp);
      if (!buckets.has(n)) buckets.set(n, []);
      buckets.get(n).push(h);
    }
    for (const [norm, members] of buckets) {
      const distinctCandidates = new Set(members.map((m) => m.candidate));
      const providers = new Set(members.map((m) => m.provider));
      if (distinctCandidates.size >= 3 && providers.size >= 2 && norm !== normalizeLoose(page.gt)) {
        gtSuspects.push({
          pageId: page.id,
          candidates: [...distinctCandidates],
          // per-condition provenance is kept, but it is not what met the threshold
          agreeing: members.map((m) => `${m.candidate}/${m.condition}@${m.promptVersion}`),
          providers: [...providers],
          consensusText: members[0].hyp, // PRIVATE results dir only
          gtText: page.gt, //               PRIVATE results dir only
        });
        break;
      }
    }
  }

  // Incidents recorded during run(s). incidents.json is an append-only log across
  // every run and probe ever made against this dataset, so it is grouped by runId
  // rather than reported as if it were one run's worth of trouble.
  const incFile = path.join(datasetDir, 'incidents.json');
  const incidents = fs.existsSync(incFile) ? JSON.parse(fs.readFileSync(incFile, 'utf8')) : [];
  fs.writeFileSync(path.join(outDir, 'incidents.json'), JSON.stringify(incidents, null, 2));
  const incidentsByRun = [];
  for (const i of incidents) {
    const id = i.runId || '(before run ids existed)';
    let row = incidentsByRun.find((r) => r.runId === id);
    if (!row) {
      row = { runId: id, first: i.at, last: i.at, count: 0, kinds: {}, candidates: [] };
      incidentsByRun.push(row);
    }
    row.last = i.at;
    row.count++;
    row.kinds[i.kind] = (row.kinds[i.kind] || 0) + 1;
    if (i.candidate && !row.candidates.includes(i.candidate)) row.candidates.push(i.candidate);
  }

  const meta = {
    scoredAt: new Date().toISOString(),
    datasetDir,
    currentPromptVersion: PROMPT_VERSION,
    // every prompt version present in the cache - rows are grouped by it, never merged
    promptVersions,
    pricingAsOf: pricing.asOf,
    pages: dataset.count,
    // Reference amendments applied by loadDataset from the dataset's amendments.json.
    // Every rate below was computed against the AMENDED references, so the count has to
    // travel with the numbers - a reader comparing two reports must be able to see that
    // the corpus itself changed.
    amendedPages: dataset.amendedPages?.length ?? 0,
    amendedPageIds: dataset.amendedPages ?? [],
    conditions: conds,
    keys: [...new Set(rows.map((r) => r.key))],
  };
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ meta, rows }, null, 2));
  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    JSON.stringify({ meta, summary, policies, gtSuspects, incidents, incidentsByRun }, null, 2),
  );
  console.log(
    `score: ${rows.length} call results -> ${summary.length} prompt-version x candidate x condition groups ` +
      `(prompt versions in cache: ${promptVersions.join(', ')})`,
  );
  console.log(`  wrote ${path.join(outDir, 'results.json')}`);
  console.log(`  wrote ${path.join(outDir, 'summary.json')}`);
  console.log(`  wrote ${path.join(outDir, 'incidents.json')} (${incidents.length} incidents)`);
  console.log(`  ${meta.amendedPages} reference amendments applied`);
  console.log(`  possible ground-truth errors flagged: ${gtSuspects.length}`);
}

// ---------------------------------------------------------------- report
function table(headers, rows) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => `| ${cells.map((c, i) => String(c ?? '').padEnd(w[i])).join(' | ')} |`;
  return [line(headers), `|${w.map((n) => '-'.repeat(n + 2)).join('|')}|`, ...rows.map(line)].join('\n');
}

function cmdReport(args) {
  const resDir = args.results || die('--results <dir> required');
  const { meta, summary, policies, gtSuspects, incidents, incidentsByRun = [] } = JSON.parse(
    fs.readFileSync(path.join(resDir, 'summary.json'), 'utf8'),
  );
  const out = [];
  out.push('# OCR bake-off report');
  out.push('');
  out.push(
    `Scored ${meta.scoredAt} - current prompt \`${meta.currentPromptVersion ?? meta.promptVersion}\`, ` +
      `prompt versions present in the cache: ${(meta.promptVersions ?? [meta.promptVersion]).join(', ')}, ` +
      `pricing as of ${meta.pricingAsOf}, ${meta.pages} ground-truth pages available, ` +
      `conditions run: ${meta.conditions.join(', ')}.`,
  );
  out.push('');
  // The corpus itself can change between reports. Say so on its own line, next to the
  // numbers it moved, rather than leaving it in the dataset directory to be discovered.
  out.push(
    `${meta.amendedPages ?? 0} reference amendments applied` +
      (meta.amendedPages ? ` (${(meta.amendedPageIds ?? []).length} pages, from the dataset's amendments.json).` : '.'),
  );
  if ((meta.promptVersions ?? []).length > 1) {
    out.push('');
    out.push(
      '> **Mixed prompt versions.** Rows are grouped by prompt version and never merged, ' +
        'but rows from different versions answered different instructions - compare them with that in mind.',
    );
  }
  out.push('');
  out.push('**Acceptance target:** ~99.9% word accuracy, i.e. loose micro-WER <= 0.001, with a high perfect-page rate.');
  out.push('A single wrong word in narration is a family-facing failure.');
  out.push('');
  out.push('> This file lives in the PRIVATE results directory and may quote page text.');
  out.push('> Never copy it into the public era-hub repo.');
  out.push('');

  out.push('## Leaderboard (sorted by loose micro-WER, then cost/page)');
  out.push('');
  // Two different things can make a row non-comparable, and they need separate names:
  //   1. it was STOPPED (cost cap / daily quota), so some attempted pages have no
  //      answer - visible per row as pagesFailed > 0, since a stopped page now leaves
  //      a record instead of a hole;
  //   2. it simply covers FEWER PAGES than the widest row of the same prompt version
  //      and condition - a different experiment, not a worse model.
  const widest = {};
  for (const s of summary) {
    const g = `${s.promptVersion}||${s.condition}||${s.mode}`;
    widest[g] = Math.max(widest[g] ?? 0, s.pagesOk);
  }
  const narrower = [];
  out.push(
    table(
      ['candidate', 'prompt', 'cond', 'mode', 'WERl(mi)', 'WERl(ma)', 'bagWERl(mi)', 'WERs(mi)', 'CERl(mi)', 'perfect(l)', 'perfect(s)', 'order-only', 'pages', 'scored', 'empty-ref', 'fail', 'run', '$/page', '$/16pp', 'lat p50', 'lat p95'],
      summary.map((s) => {
        const full = widest[`${s.promptVersion}||${s.condition}||${s.mode}`] ?? s.pagesOk;
        if (s.pagesOk < full) {
          narrower.push(
            `${s.candidate} (${s.promptVersion}, ${s.condition}): ${s.pagesOk} pages vs ${full} for the widest row of that prompt version`,
          );
        }
        return [
          s.mode === 'review' ? `${s.candidate} <- ${s.reviewOf}` : s.candidate,
          s.promptVersion ?? '-',
          s.condition,
          s.mode,
          nz(s.microWerLoose),
          nz(s.macroWerLoose),
          nz(s.microBagWerLoose),
          nz(s.microWerStrict),
          nz(s.microCerLoose),
          pct(s.perfectLoosePct),
          pct(s.perfectStrictPct),
          `${s.orderOnlyPages ?? 0}`,
          `${s.pagesOk}`,
          `${s.pagesScored ?? '-'}`,
          `${s.pagesEmptyRef ?? '-'}`,
          `${s.pagesFailed}`,
          s.pagesFailed ? `STOPPED/ERR ${s.pagesOk}/${s.pagesRun}` : 'complete',
          usd(s.costPerPageUsd),
          usd(s.costPer16PageBookUsd),
          s.latencyMsMedian ?? '-',
          s.latencyMsP95 ?? '-',
        ];
      }),
    ),
  );
  out.push('');
  out.push('WERl = loose word error rate (are the spoken words right); WERs = strict (punctuation + case, what the TTS hears).');
  out.push('mi = micro (total errors / total reference words); ma = macro (mean of per-page rates).');
  out.push('bagWERl = the same loose comparison with reading ORDER ignored (multiset of words). WERl >> bagWERl means the model read the right words in a different order - typically a cover, where title and byline can legitimately be read either way.');
  out.push('"order-only" counts pages whose every word is right but whose block order differs from the reference.');
  out.push('Pages with EMPTY ground truth carry no denominator and are excluded from every rate above - the two perfect-page columns included. `pages` is what the candidate answered, `scored` is what the rates are computed over, `empty-ref` is the difference; those pages appear as phantom pages/words and as the clean-canary count in the next table.');
  const looseOverStrict = summary.reduce((a, s) => a + (s.looseOverStrictPages ?? 0), 0);
  out.push(
    `Scoring sanity: loose is a relaxation of strict, so loose word errors should never exceed strict ones. Rows where a page broke that: **${looseOverStrict}** (a page can do it honestly when loose splits a hypothesis token on punctuation strict kept whole; a jump here means the normaliser changed, not the models).`,
  );
  out.push('');
  out.push('The `run` column reads `complete` only when every page the candidate was ASKED for produced an answer. `STOPPED/ERR n/m` means a cost cap, a daily quota or an API error cost it pages, so its micro-WER was computed over whatever survived - not over the same pages as the row above it.');
  out.push('');
  if (narrower.length) {
    out.push('> **These rows cover fewer pages than their neighbours.** Micro-WER over different page subsets is a');
    out.push('> different measurement; do not read these against the wider rows as if they were the same experiment:');
    out.push([...new Set(narrower)].map((p) => `> - ${p}`).join('\n'));
    out.push('');
  }
  const freeTier = summary.filter((s) => s.freeUnitsPerMonth);
  if (freeTier.length) {
    out.push('> **Free tiers change the cost ranking at family volume.** The $/page column is the marginal price after');
    out.push('> the free allowance, which a family reading a few books a month never exhausts:');
    for (const s of freeTier) {
      out.push(`> - ${s.candidate}: first ${s.freeUnitsPerMonth} pages/month are $0.00 (then ${usd(s.costPerPageUsd)}/page).`);
    }
    out.push('');
  }

  // Settings are part of the measurement: reasoning/thinking tokens bill at the OUTPUT
  // rate, so a model left thinking by default is compared against models pinned not to
  // think. Disclose the settings in the same document as the cost column they move.
  const settingsRows = [];
  for (const s of summary) {
    if (s.mode !== 'transcribe') continue;
    if (settingsRows.some((r) => r[0] === s.candidate && r[1] === (s.promptVersion ?? '-'))) continue;
    settingsRows.push([s.candidate, s.promptVersion ?? '-', s.options ? JSON.stringify(s.options) : '(not recorded)']);
  }
  if (settingsRows.length) {
    out.push('### Settings each candidate ran under');
    out.push('');
    out.push('Reasoning and thinking tokens bill at the **output** rate, so these settings move the cost column as much as the model choice does.');
    out.push('');
    out.push(table(['candidate', 'prompt', 'options'], settingsRows));
    out.push('');
  }

  out.push('## Self-flagging (does the model tell you when it is unsure?)');
  out.push('');
  out.push(
    table(
      ['candidate', 'cond', 'precision', 'recall', 'TP', 'FP', 'FN', 'phantom pages', 'phantom words', 'empty-ref pages', 'empty-ref clean', 'parse errors'],
      summary.map((s) => [
        s.mode === 'review' ? `${s.candidate} <- ${s.reviewOf}` : s.candidate,
        s.condition,
        pct(s.selfFlag.precision),
        pct(s.selfFlag.recall),
        s.selfFlag.truePositives,
        s.selfFlag.falsePositives,
        s.selfFlag.falseNegatives,
        s.phantomPages,
        s.phantomWords ?? '-',
        s.pagesEmptyRef ?? '-',
        s.emptyRefCleanPages ?? '-',
        s.parseErrors,
      ]),
    ),
  );
  out.push('');
  out.push('Recall is the number that matters: it is the fraction of wrong pages the model itself asked a human to check.');
  out.push('"phantom pages"/"phantom words" = pages whose ground truth is empty but the model produced text (illustration junk), and how many words it invented. "empty-ref clean" is the other side of the same canary: empty-reference pages the model correctly left empty. These pages are deliberately kept OUT of every column in the leaderboard, perfect-page rate included - an empty reference has no denominator, so folding their insertions into a micro rate would let one canary page swamp the whole corpus, and crediting them as perfect pages would pay a model up to 6.5pp of perfect(l) for producing nothing.');
  out.push('');

  out.push('## Derived policies (computed offline - no extra API calls)');
  out.push('');
  if (!policies.length) out.push('_No policy could be evaluated: needs A, B and S results on the same pages/condition._');
  else {
    out.push(
      table(
        ['policy', 'prompt', 'cond', 'A', 'B', 'escalate to S', 'disagree', 'WERl(mi)', 'perfect(l)', '$/page', '$/16pp'],
        policies.map((p) => [
          p.kind,
          p.promptVersion ?? '-',
          p.condition,
          p.a,
          p.b,
          p.s,
          pct(p.disagreeRate),
          nz(p.microWerLoose),
          pct(p.perfectLoosePct),
          usd(p.costPerPageUsd),
          usd(p.costPer16PageBookUsd),
        ]),
      ),
    );
    out.push('');
    out.push('Expected cost = cost(A) + cost(B) + P(disagree) x cost(S), measured on the pages actually run.');
    out.push('A `-` in a cost column means at least one member model has no price row in `lib/pricing.json`, so the policy cost is unknown - it is never reported as a partial sum, which would read as "cheaper".');
    out.push('');
    const reviews = summary.filter((s) => s.mode === 'review');
    out.push('### Review policies (real second-pass runs)');
    out.push('');
    if (!reviews.length) out.push('_No review runs in this results set (run with `--with-review`)._');
    else
      out.push(
        table(
          ['reviewer <- draft', 'cond', 'WERl(mi)', 'perfect(l)', '$/page (review call only)'],
          reviews.map((s) => [`${s.candidate} <- ${s.reviewOf}`, s.condition, nz(s.microWerLoose), pct(s.perfectLoosePct), usd(s.costPerPageUsd)]),
        ),
      );
  }
  out.push('');

  out.push('## Quota and rate-limit incidents');
  out.push('');
  if (!incidents.length) out.push('_None recorded._');
  else {
    out.push('`incidents.json` is an append-only log across every run and probe made against this dataset, so it is broken out per run rather than presented as one run\'s trouble.');
    out.push('');
    const byKind = {};
    for (const i of incidents) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
    out.push(`All runs: ${Object.entries(byKind).map(([k, v]) => `**${k}** ${v}`).join(', ')}`);
    out.push('');
    if (incidentsByRun.length) {
      out.push(
        table(
          ['run id', 'first', 'last', 'total', 'by kind', 'candidates'],
          incidentsByRun.map((r) => [
            r.runId,
            r.first,
            r.last,
            r.count,
            Object.entries(r.kinds).map(([k, v]) => `${k}:${v}`).join(' '),
            r.candidates.join(' '),
          ]),
        ),
      );
      out.push('');
    }
    out.push(
      table(
        ['at', 'kind', 'candidate', 'status', 'message'],
        incidents.slice(0, 60).map((i) => [i.at, i.kind, i.candidate ?? '-', i.status ?? '-', String(i.message ?? '').slice(0, 160)]),
      ),
    );
  }
  out.push('');

  out.push('## Possible ground-truth errors');
  out.push('');
  out.push('Pages where at least 3 DISTINCT candidates from at least 2 different providers agree with each other (loose) but disagree with the stored ground truth. Each one is a candidate for a human re-check of the ground truth, not automatically a model win.');
  out.push('One model run under several conditions counts once: it is one opinion, not three.');
  out.push('');
  if (!gtSuspects.length) out.push('_None._');
  else
    for (const g of gtSuspects) {
      out.push(`### ${g.pageId}`);
      out.push(`Agreeing models (${(g.candidates ?? []).length}): ${(g.candidates ?? []).join(', ')} (providers: ${g.providers.join(', ')})`);
      out.push(`Individual runs: ${g.agreeing.join(', ')}`);
      out.push('');
      out.push('Consensus:');
      out.push('```');
      out.push(g.consensusText);
      out.push('```');
      out.push('Ground truth:');
      out.push('```');
      out.push(g.gtText);
      out.push('```');
      out.push('');
    }

  out.push('## What to re-check in 6 months');
  out.push('');
  out.push('1. **Model list.** Run `bakeoff.mjs discover`. Every model here may be retired or superseded; the newest cheap tier is usually the biggest mover. Update `lib/candidates.mjs`.');
  out.push('2. **Prices.** Re-fetch the three URLs in `lib/pricing.json.sources` and bump `asOf`. Gemini 3.6/3.7/3.8 Flash promotional pricing ends 2026-12-31 and doubles - a policy that is cheapest today may not be in January.');
  out.push('3. **Free-tier reality.** Re-run `probe-quota`. Family users bring free AI Studio keys; the per-day limit is the product constraint, not the price.');
  out.push('4. **Claude.** The `anthropic` adapter is written but has never run (no API key in this environment). If a key exists, add a candidate row and re-run - it costs one line.');
  out.push('5. **Ground truth.** Work through the "possible ground-truth errors" list before trusting a sub-0.001 WER; at that accuracy the remaining errors are as likely to be in the reference as in the model.');
  out.push('6. **Conditions.** If the in-app builder stops doing a manual crop/deskew step, the `processed` column stops being reachable in production - decide on `raw` vs `raw2048` numbers alone.');
  out.push('7. **Prompt version.** Rows are grouped by prompt version and never blended. If the cache holds more than one version, either re-run the old candidates under the current prompt or read their rows as a separate experiment. `v2` pinned the cover reading order (title block first, top-to-bottom as printed); check `bagWERl` vs `WERl` and the "order-only" column to see whether that convention is still the thing separating candidates.');
  out.push('8. **Settings parity.** Check the "settings each candidate ran under" table before comparing cost: OpenAI reasoning is pinned off and Gemini thinking is pinned to 0 for the like-for-like rows. `gemini:gemini-3.6-flash-thinking` is the deliberate control that leaves thinking on; if it is not measurably more accurate, thinking is pure cost.');
  out.push('');

  const f = path.join(resDir, 'report.md');
  fs.writeFileSync(f, out.join('\n'));
  console.log(`report: wrote ${f} (${summary.length} rows, ${policies.length} policies, ${gtSuspects.length} gt suspects)`);
}

// ---------------------------------------------------------------- main
const USAGE = `ocr-bakeoff - which vision API should the Book Reader call?

  node ${path.relative(process.cwd(), path.join(HERE, 'bakeoff.mjs'))} <subcommand> [flags]

  build-dataset --rows <gt-rows.json> --out <dataset dir>
  discover      [--out <file.json>]
  probe-quota   --dataset <dir> [--candidates gemini]
  run           --dataset <dir> [--candidates all] [--conditions raw,raw2048,processed]
                [--pages all|N|<slug>] [--max-usd <n>] [--with-review] [--keep-failures]
                [--allow-unpriced]
  score         --dataset <dir> --out <results dir>
  report        --results <results dir>

Keys are read from the environment by name: OPENAI_API_KEY, GOOGLE_AI_STUDIO_KEY,
GOOGLE_VISION_SA_JSON_B64 (and ANTHROPIC_API_KEY when one exists).`;

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (cmd === 'build-dataset') cmdBuildDataset(args);
  else if (cmd === 'discover') await cmdDiscover(args);
  else if (cmd === 'probe-quota') await cmdProbeQuota(args);
  else if (cmd === 'run') await cmdRun(args);
  else if (cmd === 'score') cmdScore(args);
  else if (cmd === 'report') cmdReport(args);
  else {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  die(e.stack || e.message);
}
