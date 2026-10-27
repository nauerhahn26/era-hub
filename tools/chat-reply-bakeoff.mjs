#!/usr/bin/env node
// chat-reply-bakeoff.mjs: phase-0 reply-model bake-off for real-time Chat
// (docs/plans/2026-10-27-real-time-chat-plan.md, design section 3.3).
//
//   node tools/chat-reply-bakeoff.mjs --candidates FILE --questions FILE --prices FILE --out DIR
//        [--runs 10] [--warmup 2] [--limit N] [--only id,id] [--timeout-ms 20000]
//   node tools/chat-reply-bakeoff.mjs --rescore DIR --questions FILE   (re-apply expectations, no network)
//   node tools/chat-reply-bakeoff.mjs --self-test
//
// Every candidate gets the shipped instruction prefix and strict schema from
// chat-choices.js, read verbatim from that file (phase 0 changes no product
// code, and a copy here could drift). Streamed text is parsed as it arrives,
// so the time to the FIRST complete choice is measured, not just the total.
//
// Candidates file (private, never in the repo): a JSON list of
//   { id, protocol, url | urlEnv, model | modelEnv, tokenEnv, authHeader?,
//     reasoning?, maxOutputTokens? (450), extra? (merged into the body), priceKey? }
// protocol is a wire shape: responses, responses-stream, chat-completions-stream,
// generate-content-stream. A url may hold {model}. authHeader names a raw-key
// header; without it the token is sent as a bearer token.
// Questions file: a JSON list of { id, kind, text, context?, expect? } where
// expect = { include: [[pattern, ...], ...], forbid: [pattern], open: bool }.
// Prices file: { "<priceKey or model>": { input, cachedInput, output } } in USD
// per million tokens. Results: <out>/reply-results.json and reply-report.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const choicesPath = path.join(here, '..', 'chat-choices.js');

function loadShipped() {
  const source = fs.readFileSync(choicesPath, 'utf8') +
    '\n;module.exports.__bakeoff = { INSTRUCTIONS, SCHEMA, inputData, guardedChoices, changesOwnership, parseChoices };';
  const module = { exports: {} };
  vm.compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: choicesPath })(
    module.exports, createRequire(choicesPath), module, choicesPath, path.dirname(choicesPath));
  return module.exports.__bakeoff;
}
export const shipped = loadShipped();

// ---- incremental parse of {"choices":[{...},{...}]} -------------------------
export function createChoiceStream({ onChoice = () => {}, onClose = () => {} } = {}) {
  let buffer = '', stack = [], inString = false, escaped = false, start = -1, closed = false;
  return {
    push(chunk) {
      const from = buffer.length; buffer += chunk;
      for (let i = from; i < buffer.length; i++) {
        const ch = buffer[i];
        if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{' || ch === '[') {
          if (ch === '{' && stack.length === 2 && stack[1] === '[') start = i;
          stack.push(ch);
        } else if (ch === '}' || ch === ']') {
          stack.pop();
          if (ch === '}' && stack.length === 2 && start >= 0) {
            let value = null;
            try { value = JSON.parse(buffer.slice(start, i + 1)); } catch { /* left for the final check */ }
            start = -1;
            if (value && typeof value.label === 'string' && typeof value.say === 'string') onChoice(value);
          } else if (ch === ']' && stack.length === 1 && !closed) { closed = true; onClose(); }
        }
      }
    },
    text: () => buffer,
  };
}

// ---- server-sent events -----------------------------------------------------
async function* sse(body) {
  const decoder = new TextDecoder(); let pending = '';
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let cut;
    while ((cut = pending.indexOf('\n\n')) >= 0) {
      const block = pending.slice(0, cut); pending = pending.slice(cut + 2);
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield data;
    }
  }
  if (pending.trim().startsWith('data:')) yield pending.trim().slice(5).trim();
}

// ---- wire shapes -------------------------------------------------------------
const num = v => (Number.isFinite(v) ? v : 0);
function merge(target, extra) {
  for (const [k, v] of Object.entries(extra || {}))
    target[k] = v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' ? merge({ ...target[k] }, v) : v;
  return target;
}
function responsesBody(c, data, stream) {
  return merge({ model: c.model, store: false, instructions: shipped.INSTRUCTIONS, input: JSON.stringify(data),
    max_output_tokens: c.maxOutputTokens || 450, ...(c.reasoning ? { reasoning: { effort: c.reasoning } } : {}),
    text: { format: { type: 'json_schema', name: 'choices', strict: true, schema: shipped.SCHEMA } }, ...(stream ? { stream: true } : {}) }, c.extra);
}
const responsesUsage = u => ({ input: num(u?.input_tokens), cached: num(u?.input_tokens_details?.cached_tokens),
  output: num(u?.output_tokens), reasoning: num(u?.output_tokens_details?.reasoning_tokens) });

export const PROTOCOLS = {
  responses: {
    body: (c, data) => responsesBody(c, data, false),
    async read(response, sink) {
      const body = await response.json();
      sink.usage(responsesUsage(body.usage));
      const choices = shipped.parseChoices(body);
      const text = JSON.stringify({ choices });
      sink.text(text);
    },
  },
  'responses-stream': {
    body: (c, data) => responsesBody(c, data, true),
    async read(response, sink) {
      for await (const data of sse(response.body)) {
        if (data === '[DONE]') break;
        const event = JSON.parse(data);
        if (event.type === 'response.output_text.delta') sink.text(event.delta);
        else if (event.type === 'response.refusal.delta') sink.fail('generation-refused');
        else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          sink.usage(responsesUsage(event.response?.usage));
          if (event.type === 'response.incomplete') sink.fail('generation-incomplete');
        } else if (event.type === 'response.failed' || event.type === 'error') sink.fail('generation-failed');
      }
    },
  },
  'chat-completions-stream': {
    body: (c, data) => merge({ model: c.model, stream: true, stream_options: { include_usage: true },
      max_completion_tokens: c.maxOutputTokens || 450, ...(c.reasoning ? { reasoning_effort: c.reasoning } : {}),
      messages: [{ role: 'system', content: shipped.INSTRUCTIONS }, { role: 'user', content: JSON.stringify(data) }],
      response_format: { type: 'json_schema', json_schema: { name: 'choices', strict: true, schema: shipped.SCHEMA } } }, c.extra),
    async read(response, sink) {
      for await (const data of sse(response.body)) {
        if (data === '[DONE]') break;
        const event = JSON.parse(data);
        const delta = event.choices?.[0]?.delta;
        if (delta?.refusal) sink.fail('generation-refused');
        if (typeof delta?.content === 'string' && delta.content) sink.text(delta.content);
        if (event.usage) sink.usage({ input: num(event.usage.prompt_tokens), cached: num(event.usage.prompt_tokens_details?.cached_tokens),
          output: num(event.usage.completion_tokens), reasoning: num(event.usage.completion_tokens_details?.reasoning_tokens) });
      }
    },
  },
  'generate-content-stream': {
    body: (c, data) => merge({ systemInstruction: { parts: [{ text: shipped.INSTRUCTIONS }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(data) }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: shipped.SCHEMA, maxOutputTokens: c.maxOutputTokens || 450 } }, c.extra),
    async read(response, sink) {
      for await (const data of sse(response.body)) {
        const event = JSON.parse(data);
        if (event.error) sink.fail('generation-failed');
        for (const part of event.candidates?.[0]?.content?.parts || []) if (typeof part.text === 'string' && !part.thought && part.text) sink.text(part.text);
        const u = event.usageMetadata;
        if (u) sink.usage({ input: num(u.promptTokenCount), cached: num(u.cachedContentTokenCount),
          output: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount), reasoning: num(u.thoughtsTokenCount) });
        const finish = event.candidates?.[0]?.finishReason;
        if (finish && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(finish)) sink.fail('generation-' + finish.toLowerCase());
      }
    },
  },
};

// ---- one turn -----------------------------------------------------------------
export function resolveCandidate(spec, env) {
  const model = spec.model || env[spec.modelEnv];
  const url = (spec.url || env[spec.urlEnv] || '').replaceAll('{model}', encodeURIComponent(model || ''));
  const token = env[spec.tokenEnv];
  if (!PROTOCOLS[spec.protocol]) throw Error(`${spec.id}: unknown protocol ${spec.protocol}`);
  if (!model || !url || !token) throw Error(`${spec.id}: model, url and token (${spec.tokenEnv}) are required`);
  return { ...spec, model, url, token };
}

export async function runTurn(candidate, question, { timeoutMs = 20000, clock = () => performance.now() } = {}) {
  const data = shipped.inputData({ text: question.text, context: question.context || [] });
  const protocol = PROTOCOLS[candidate.protocol];
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = clock(), result = { candidate: candidate.id, question: question.id, ok: false, streamed: [] };
  let usage = null, failure = null;
  const stream = createChoiceStream({
    onChoice: choice => { result.streamed.push(Math.round((clock() - t0) * 10) / 10); if (result.firstChoiceMs === undefined) result.firstChoiceMs = clock() - t0; },
    onClose: () => { result.choicesMs = clock() - t0; },
  });
  const sink = {
    text: delta => { if (result.firstTokenMs === undefined) result.firstTokenMs = clock() - t0; stream.push(delta); },
    usage: value => { usage = value; },
    fail: code => { failure = failure || code; },
  };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (candidate.authHeader) headers[candidate.authHeader] = candidate.token; else headers.Authorization = 'Bearer ' + candidate.token;
    const response = await fetch(candidate.url, { method: 'POST', redirect: 'error', signal: controller.signal, headers,
      body: JSON.stringify(protocol.body(candidate, data)) });
    result.headersMs = clock() - t0;
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 240);
      throw Object.assign(Error('http-' + response.status), { detail });
    }
    await protocol.read(response, sink);
    result.totalMs = clock() - t0;
    if (failure) throw Error(failure);
    const choices = shipped.parseChoices({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: stream.text() }] }] });
    result.choices = choices; result.ok = true;
    if (result.choicesMs === undefined) result.choicesMs = result.totalMs;
    if (result.firstChoiceMs === undefined) result.firstChoiceMs = result.choicesMs;
  } catch (error) {
    result.error = controller.signal.aborted ? 'timeout' : error.code || error.message || 'error';
    if (error.detail) result.detail = error.detail;
    if (!result.ok && stream.text()) result.text = stream.text().slice(0, 1000);
  } finally { clearTimeout(timer); }
  result.usage = usage;
  for (const key of ['headersMs', 'firstTokenMs', 'firstChoiceMs', 'choicesMs', 'totalMs'])
    if (result[key] !== undefined) result[key] = Math.round(result[key] * 10) / 10;
  result.preGuarded = !!shipped.guardedChoices(data);
  result.score = scoreChoices(question, result.ok ? result.choices : null);
  return result;
}

// ---- quality --------------------------------------------------------------------
const OPEN = /\b(not sure|don'?t know|do not know|something else|another|other|later|not now|no thanks|don'?t want|do not want|clue|maybe|neither|different|not really|no\b|not\b|ask)/i;
export function scoreChoices(question, choices) {
  if (!Array.isArray(choices)) return { pass: false, failures: ['invalid'] };
  const expect = question.expect || {}, failures = [];
  const texts = choices.map(c => `${c.label} ${c.say}`);
  for (const [n, group] of (expect.include || []).entries())
    if (!texts.some(t => group.some(p => new RegExp(p, 'i').test(t)))) failures.push(`include:${n}`);
  if ((expect.forbid || []).some(p => choices.some(c => new RegExp(p, 'i').test(c.say)))) failures.push('forbid');
  const data = { question: question.text.trim().replace(/\s+/g, ' '), context: question.context || [] };
  if (shipped.changesOwnership(data, choices)) failures.push('ownership');
  if (expect.open && !texts.some(t => OPEN.test(t))) failures.push('open');
  return { pass: failures.length === 0, failures };
}

// ---- summary ----------------------------------------------------------------------
export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}
// 'open' (no decline/other option) is the one soft check: the shipped prompt
// asks for it only where it fits the question naturally.
const hardPass = score => !!score && score.failures.every(f => f === 'open');
const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round = (v, d = 1) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
export function turnCost(usage, price) {
  if (!usage || !price) return null;
  return ((usage.input - usage.cached) * price.input + usage.cached * (price.cachedInput ?? price.input) + usage.output * price.output) / 1e6;
}
export function summarize(runs, candidates) {
  return candidates.map(c => {
    const mine = runs.filter(r => r.candidate === c.id), ok = mine.filter(r => r.ok);
    const stat = key => ({ p50: round(percentile(ok.map(r => r[key]), 50)), p95: round(percentile(ok.map(r => r[key]), 95)) });
    const usage = ok.map(r => r.usage).filter(Boolean);
    const costs = ok.map(r => turnCost(r.usage, c.price)).filter(v => v !== null);
    const reached = mine.filter(r => !r.preGuarded);
    const errors = {};
    for (const r of mine.filter(x => !x.ok)) errors[r.error] = (errors[r.error] || 0) + 1;
    return { id: c.id, protocol: c.protocol, model: c.model, runs: mine.length, okRuns: ok.length, errors,
      headersMs: stat('headersMs'), firstTokenMs: stat('firstTokenMs'), firstChoiceMs: stat('firstChoiceMs'),
      choicesMs: stat('choicesMs'), totalMs: stat('totalMs'),
      firstChoiceUnder800: ok.length ? round(ok.filter(r => r.firstChoiceMs <= 800).length / ok.length, 3) : null,
      tokens: { input: round(mean(usage.map(u => u.input))), cached: round(mean(usage.map(u => u.cached))),
        output: round(mean(usage.map(u => u.output))), reasoning: round(mean(usage.map(u => u.reasoning))) },
      costPerTurnUsd: costs.length ? round(mean(costs), 6) : null,
      qualityPass: mine.filter(r => r.score?.pass).length, qualityTotal: mine.length,
      qualityHardPass: mine.filter(r => hardPass(r.score)).length,
      qualityPassReached: reached.filter(r => r.score?.pass).length, qualityTotalReached: reached.length };
  });
}

// ---- report -----------------------------------------------------------------------
const ms = s => (s.p50 === null ? '-' : `${Math.round(s.p50)} / ${Math.round(s.p95)}`);
export function report(summary, runs, questions, meta) {
  const lines = [`# Reply-model bake-off ${meta.at}`, '', `Runs per question: ${meta.runs}; warm-up turns per candidate: ${meta.warmup}; questions: ${questions.length}.`,
    'Times are ms from request start, p50 / p95 nearest rank over successful turns. Cost is the mean per turn at the private list prices.',
    'Quality all = every check passed; hard checks = no invalid reply, forbidden (invented or negated) content, missing alternative or ownership change; "open" (no decline/other option) is the soft check.',
    'Model-reached = questions the shipped pre-generation guard does not answer itself.', '',
    '| Candidate | Protocol | OK | First token | First choice | All choices | Total | ≤800 ms first | In / cached / out (reasoning) | USD per turn | Quality all | Hard checks | Quality model-reached |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const s of summary) lines.push(`| ${s.id} | ${s.protocol} | ${s.okRuns}/${s.runs} | ${ms(s.firstTokenMs)} | ${ms(s.firstChoiceMs)} | ${ms(s.choicesMs)} | ${ms(s.totalMs)} | ${s.firstChoiceUnder800 === null ? '-' : Math.round(s.firstChoiceUnder800 * 100) + '%'} | ${s.tokens.input} / ${s.tokens.cached} / ${s.tokens.output} (${s.tokens.reasoning}) | ${s.costPerTurnUsd ?? '-'} | ${s.qualityPass}/${s.qualityTotal} | ${s.qualityHardPass}/${s.qualityTotal} | ${s.qualityPassReached}/${s.qualityTotalReached} |`);
  lines.push('', '## Errors', '');
  for (const s of summary) if (Object.keys(s.errors).length) lines.push(`- ${s.id}: ${JSON.stringify(s.errors)}`);
  const details = runs.filter(r => r.detail).slice(0, 6);
  for (const r of details) lines.push(`  - ${r.candidate} ${r.error}: ${r.detail}`);
  lines.push('', '## Quality failures by question', '', '| Question | Kind | ' + summary.map(s => s.id).join(' | ') + ' |', '| --- | --- | ' + summary.map(() => '---').join(' | ') + ' |');
  for (const q of questions) {
    const cells = summary.map(s => {
      const mine = runs.filter(r => r.candidate === s.id && r.question === q.id), bad = mine.filter(r => !r.score.pass);
      const reasons = [...new Set(bad.flatMap(r => r.score.failures))].join(',');
      return bad.length ? `${bad.length}/${mine.length} ${reasons}` : `0/${mine.length}`;
    });
    lines.push(`| ${q.id}${runs.find(r => r.question === q.id)?.preGuarded ? ' (pre-guarded)' : ''} | ${q.kind || ''} | ${cells.join(' | ')} |`);
  }
  lines.push('', '## First-pass choices (for reading)', '');
  for (const q of questions) {
    lines.push(`### ${q.id}: ${q.text}`, q.context?.length ? `Context: ${q.context.join(' / ')}` : '', '');
    for (const s of summary) {
      const r = runs.find(x => x.candidate === s.id && x.question === q.id);
      lines.push(`- ${s.id}: ${r?.ok ? r.choices.map(c => `[${c.label}] ${c.say}`).join(' · ') : r?.error || '-'}${r && !r.score.pass ? `  **FAIL ${r.score.failures.join(',')}**` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function runBakeoff({ candidates, questions, prices = {}, runs = 10, warmup = 2, out, env = process.env, timeoutMs = 20000, log = () => {} }) {
  const resolved = [], skipped = [];
  for (const spec of candidates) {
    try { const c = resolveCandidate(spec, env); c.price = prices[c.priceKey || c.model] || null; resolved.push(c); }
    catch (error) { skipped.push({ id: spec.id, reason: error.message }); }
  }
  const strip = c => ({ ...c, token: undefined, url: undefined });
  for (const c of resolved) for (let i = 0; i < warmup; i++) {
    const r = await runTurn(c, questions[i % questions.length], { timeoutMs });
    log(`warm ${c.id} ${r.ok ? Math.round(r.totalMs) + ' ms' : r.error + (r.detail ? ' ' + r.detail : '')}`);
  }
  const results = [];
  for (let pass = 0; pass < runs; pass++)
    for (const [qi, question] of questions.entries()) {
      const shift = (pass + qi) % resolved.length;
      for (const c of [...resolved.slice(shift), ...resolved.slice(0, shift)]) {
        const r = await runTurn(c, question, { timeoutMs }); r.pass = pass; results.push(r);
        log(`${pass} ${question.id} ${c.id} ${r.ok ? `first ${Math.round(r.firstChoiceMs)} all ${Math.round(r.choicesMs)}` : r.error} ${r.score.pass ? '' : r.score.failures.join(',')}`);
      }
    }
  const summary = summarize(results, resolved);
  const meta = { at: new Date().toISOString(), runs, warmup, skipped };
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'reply-results.json'), JSON.stringify({ ...meta, candidates: resolved.map(strip), questions, summary, results }, null, 1));
    fs.writeFileSync(path.join(out, 'reply-report.md'), report(summary, results, questions, meta) +
      (skipped.length ? '\n\n## Skipped\n\n' + skipped.map(s => `- ${s.id}: ${s.reason}`).join('\n') + '\n' : ''));
  }
  return { summary, results, skipped };
}

// ---- fake streaming server (self-test) ----------------------------------------------
export function startFakeServer({ thinkMs = 30, gapMs = 4, chunk = 6 } = {}) {
  const seen = [];
  const reply = { choices: [{ label: 'Music', say: 'Music, please.' }, { label: 'Story', say: 'A story, please.' }, { label: 'Not sure', say: 'I am not sure.' }] };
  const text = JSON.stringify(reply), wait = n => new Promise(r => setTimeout(r, n));
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const request = JSON.parse(body); seen.push({ url: req.url, headers: req.headers, body: request });
    await wait(thinkMs);
    const pieces = []; for (let i = 0; i < text.length; i += chunk) pieces.push(text.slice(i, i + chunk));
    const send = async (events) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const e of events) { res.write(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`); await wait(gapMs); }
      res.end();
    };
    if (req.url.startsWith('/responses') && !request.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
        usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 60, output_tokens_details: { reasoning_tokens: 0 } } }));
    }
    if (req.url.startsWith('/responses')) return send([...pieces.map(delta => ({ type: 'response.output_text.delta', delta })),
      { type: 'response.completed', response: { usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 768 }, output_tokens: 60 } } }]);
    if (req.url.startsWith('/chat/completions')) return send([...pieces.map(content => ({ choices: [{ delta: { content } }] })),
      { choices: [], usage: { prompt_tokens: 900, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 60 } }, '[DONE]']);
    if (req.url.includes(':streamGenerateContent')) return send(pieces.map((t, i) => ({ candidates: [{ content: { parts: [{ text: t }] },
      ...(i === pieces.length - 1 ? { finishReason: 'STOP' } : {}) }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 60, thoughtsTokenCount: 5 } })));
    res.writeHead(404); res.end();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

export function rescore(dir, questions) {
  const file = path.join(dir, 'reply-results.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keep = path.join(dir, 'reply-results.scored-before-rescore.json');
  if (!fs.existsSync(keep)) fs.copyFileSync(file, keep);
  const byId = Object.fromEntries(questions.map(q => [q.id, q]));
  for (const r of saved.results) if (byId[r.question]) r.score = scoreChoices(byId[r.question], r.ok ? r.choices : null);
  const used = questions.filter(q => saved.results.some(r => r.question === q.id));
  saved.questions = used; saved.summary = summarize(saved.results, saved.candidates); saved.rescoredAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(saved, null, 1));
  fs.writeFileSync(path.join(dir, 'reply-report.md'), report(saved.summary, saved.results, used, saved) +
    `\n\nRescored ${saved.rescoredAt} with the current question expectations; the first scoring is kept in reply-results.scored-before-rescore.json.\n`);
  return saved.summary;
}

async function selfTest() {
  const fake = await startFakeServer();
  const base = `http://127.0.0.1:${fake.port}`;
  const env = { BAKEOFF_FAKE_TOKEN: 'fake-token' };
  const candidates = [
    { id: 'one-shot', protocol: 'responses', url: base + '/responses', model: 'fake-small', tokenEnv: 'BAKEOFF_FAKE_TOKEN', reasoning: 'none' },
    { id: 'responses-stream', protocol: 'responses-stream', url: base + '/responses', model: 'fake-small', tokenEnv: 'BAKEOFF_FAKE_TOKEN' },
    { id: 'chat-stream', protocol: 'chat-completions-stream', url: base + '/chat/completions', model: 'fake-tiny', tokenEnv: 'BAKEOFF_FAKE_TOKEN' },
    { id: 'content-stream', protocol: 'generate-content-stream', url: base + '/models/{model}:streamGenerateContent?alt=sse', model: 'fake-lite',
      tokenEnv: 'BAKEOFF_FAKE_TOKEN', authHeader: 'x-fake-key', extra: { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } } },
    { id: 'no-token', protocol: 'responses-stream', url: base + '/responses', model: 'fake-small', tokenEnv: 'BAKEOFF_MISSING' },
  ];
  const questions = [
    { id: 'either-or', kind: 'either/or', text: 'Would you like music or a story?', expect: { include: [['music'], ['story']], open: true } },
    { id: 'invented', kind: 'history', text: 'What did you sing today?', expect: { forbid: ['\\bmusic\\b'] } },
  ];
  const prices = { 'fake-small': { input: 1, cachedInput: 0.1, output: 10 }, 'fake-tiny': { input: 1, output: 10 }, 'fake-lite': { input: 1, output: 10 } };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-bakeoff-'));
  const check = (ok, what) => { if (!ok) throw Error('self-test: ' + what); };
  try {
    const { summary, results, skipped } = await runBakeoff({ candidates, questions, prices, runs: 2, warmup: 1, out, env });
    check(skipped.length === 1 && skipped[0].id === 'no-token', 'a candidate without its token is skipped, not sent');
    check(results.length === 16 && results.every(r => r.ok), 'every turn parses: ' + JSON.stringify(results.filter(r => !r.ok).map(r => [r.candidate, r.error])));
    for (const r of results) {
      check(r.firstTokenMs <= r.firstChoiceMs && r.firstChoiceMs <= r.choicesMs && r.choicesMs <= r.totalMs, 'timings are ordered for ' + r.candidate);
      if (r.candidate !== 'one-shot') check(r.firstChoiceMs < r.choicesMs && r.streamed.length === 3, 'choices arrive one by one for ' + r.candidate);
    }
    const by = Object.fromEntries(summary.map(s => [s.id, s]));
    check(by['responses-stream'].tokens.cached === 768 && by['content-stream'].tokens.output === 65, 'usage is read per wire shape');
    check(by['responses-stream'].costPerTurnUsd === round((132 * 1 + 768 * 0.1 + 60 * 10) / 1e6, 6), 'cached input is priced separately');
    check(by['one-shot'].qualityPass === 2 && by['one-shot'].qualityTotal === 4, 'quality scoring counts forbidden words');
    const content = fake.seen.find(s => s.url.includes(':streamGenerateContent'));
    check(content.url.includes('/models/fake-lite:') && content.headers['x-fake-key'] === 'fake-token' && !content.headers.authorization, 'raw-key header and model in the url');
    check(content.body.generationConfig.thinkingConfig.thinkingBudget === 0 && content.body.generationConfig.responseJsonSchema, 'extra merges into the body');
    check(fake.seen.every(s => JSON.stringify(s.body).includes(shipped.INSTRUCTIONS.slice(0, 60).replace(/'/g, "'"))), 'every request carries the shipped instruction prefix');
    check(fake.seen.filter(s => s.url.startsWith('/responses')).every(s => s.headers.authorization === 'Bearer fake-token'), 'bearer token by default');
    const written = fs.readFileSync(path.join(out, 'reply-report.md'), 'utf8');
    check(/\| responses-stream \| responses-stream \| 4\/4 \|/.test(written), 'report table written');
    check(!fs.readFileSync(path.join(out, 'reply-results.json'), 'utf8').includes('fake-token'), 'no token in the results file');
    console.log('self-test ok');
  } finally { fake.server.close(); fs.rmSync(out, { recursive: true, force: true }); }
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (['self-test', 'help'].includes(key)) out[key] = true; else out[key] = argv[++i];
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = args(process.argv.slice(2));
  const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  if (opt.help) console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split("\n").slice(1, 24).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  else if (opt.rescore) {
    if (!opt.questions) { console.error('--rescore DIR needs --questions FILE.'); process.exit(2); }
    for (const s of rescore(opt.rescore, readJson(opt.questions))) console.log(`${s.id}: quality ${s.qualityPass}/${s.qualityTotal} hard ${s.qualityHardPass}/${s.qualityTotal}`);
  } else if (opt['self-test']) selfTest().catch(error => { console.error(error.message); process.exitCode = 1; });
  else {
    if (!opt.candidates || !opt.questions || !opt.out) { console.error('Need --candidates, --questions and --out (see --help).'); process.exit(2); }
    let questions = readJson(opt.questions);
    if (opt.only) questions = questions.filter(q => opt.only.split(',').includes(q.id));
    if (opt.limit) questions = questions.slice(0, Number(opt.limit));
    let candidates = readJson(opt.candidates);
    if (opt.use) candidates = candidates.filter(c => opt.use.split(',').includes(c.id));
    runBakeoff({ candidates, questions, prices: opt.prices ? readJson(opt.prices) : {}, runs: Number(opt.runs || 10),
      warmup: Number(opt.warmup ?? 2), out: opt.out, timeoutMs: Number(opt['timeout-ms'] || 20000), log: line => console.log(line) })
      .then(({ summary, skipped }) => {
        for (const s of skipped) console.log(`skipped ${s.id}: ${s.reason}`);
        for (const s of summary) console.log(`${s.id}: ok ${s.okRuns}/${s.runs} first choice ${ms(s.firstChoiceMs)} all ${ms(s.choicesMs)} quality ${s.qualityPass}/${s.qualityTotal} ${JSON.stringify(s.errors)}`);
        console.log('wrote ' + opt.out);
      })
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
