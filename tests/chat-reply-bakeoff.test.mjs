// Reply-model bake-off tool (real-time chat plan, phase 0): the streamed
// choice parser, the quality scorer and the whole run against the tool's own
// fake streaming server. No credential, no network beyond loopback port 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChoiceStream, scoreChoices, summarize, percentile, PROTOCOLS }
  from '../tools/chat-reply-bakeoff.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'chat-reply-bakeoff.mjs');

test('choices are emitted one by one as each object closes, whatever the chunking', () => {
  const text = JSON.stringify({ choices: [
    { label: 'Say "hi" {x}', say: 'A brace } and a bracket ] in a string.' },
    { label: 'Back\\slash', say: 'Escaped \\" quote, then [more].' },
    { label: 'Third', say: 'Done.' }] });
  for (const size of [1, 2, 7, text.length]) {
    const seen = [], marks = [];
    const stream = createChoiceStream({ onChoice: c => { seen.push(c); marks.push('choice'); }, onClose: () => marks.push('close') });
    for (let i = 0; i < text.length; i += size) stream.push(text.slice(i, i + size));
    assert.equal(seen.length, 3, `chunk size ${size}`);
    assert.equal(seen[0].label, 'Say "hi" {x}');
    assert.equal(seen[1].say, 'Escaped \\" quote, then [more].');
    assert.deepEqual(marks, ['choice', 'choice', 'choice', 'close']);
    assert.equal(stream.text(), text);
  }
});

test('the first choice is visible before the rest of the reply has arrived', () => {
  const seen = [];
  const stream = createChoiceStream({ onChoice: c => seen.push(c) });
  stream.push('{"choices":[{"label":"Yes","say":"Yes please."},{"label":"N');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].say, 'Yes please.');
});

test('scoring: either/or extraction, invented facts, negation, ownership and an open option', () => {
  const question = { id: 'q', text: 'Would you like music or a story?', context: [],
    expect: { include: [['music'], ['story']], open: true } };
  assert.equal(scoreChoices(question, [{ label: 'Music', say: 'Music please.' },
    { label: 'Story', say: 'A story please.' }, { label: 'Neither', say: 'Something else.' }]).pass, true);
  const missing = scoreChoices(question, [{ label: 'Music', say: 'Music please.' }, { label: 'Yes', say: 'Yes.' }]);
  assert.equal(missing.pass, false);
  assert.ok(missing.failures.some(f => f.startsWith('include')));
  assert.ok(missing.failures.includes('open'));

  const invented = { id: 'h', text: 'What did you do last weekend?', context: [], expect: { forbid: ['\\bI (played|went)\\b'] } };
  assert.deepEqual(scoreChoices(invented, [{ label: 'Park', say: 'I went to the park.' }, { label: 'Clue', say: 'Give me a clue?' }]).failures, ['forbid']);

  const owner = { id: 'o', text: 'I lost my drawing. Can you help me?', context: [], expect: {} };
  const result = scoreChoices(owner, [{ label: 'Mine', say: 'I lost my drawing too.' }, { label: 'Help', say: 'I can help you look.' }]);
  assert.ok(result.failures.includes('ownership'), 'the shipped ownership check is applied');
  assert.equal(scoreChoices(owner, null).failures[0], 'invalid');
});

test('summaries report nearest-rank p50/p95 and per-turn cost at the supplied prices', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  const runs = [1, 2, 3].map(n => ({ candidate: 'c', question: 'q', ok: true, firstTokenMs: n, firstChoiceMs: n * 2,
    choicesMs: n * 3, totalMs: n * 4, usage: { input: 1000, cached: 0, output: 100, reasoning: 0 },
    score: { pass: n === 1, failures: n === 1 ? [] : n === 2 ? ['forbid'] : ['open'] } }));
  const [row] = summarize(runs, [{ id: 'c', price: { input: 1, cachedInput: 0.1, output: 10 } }]);
  assert.equal(row.firstChoiceMs.p50, 4);
  assert.equal(row.costPerTurnUsd, 0.002);
  assert.equal(row.qualityPass, 1);
  assert.equal(row.qualityHardPass, 2, 'a missing decline/other option alone is a soft failure');
  assert.equal(row.okRuns, 3);
});

test('--rescore re-applies the current expectations to recorded turns without a network call', async () => {
  const fs = await import('node:fs'), os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rescore-'));
  try {
    const q = { id: 'q', text: 'What did you do?', expect: { forbid: ['park'] } };
    const turn = { candidate: 'c', question: 'q', ok: true, firstChoiceMs: 1, choicesMs: 2, totalMs: 3, firstTokenMs: 1,
      choices: [{ label: 'Park', say: 'I went to the park.' }, { label: 'Clue', say: 'A clue?' }], score: { pass: true, failures: [] } };
    fs.writeFileSync(path.join(dir, 'reply-results.json'), JSON.stringify({ at: 'x', runs: 1, warmup: 0, candidates: [{ id: 'c', protocol: 'responses' }], questions: [], results: [turn] }));
    fs.writeFileSync(path.join(dir, 'q.json'), JSON.stringify([q]));
    const run = spawnSync(process.execPath, [tool, '--rescore', dir, '--questions', path.join(dir, 'q.json')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(run.status, 0, run.stderr);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'reply-results.json'), 'utf8'));
    assert.deepEqual(after.results[0].score.failures, ['forbid']);
    assert.equal(after.summary[0].qualityHardPass, 0);
    assert.ok(fs.existsSync(path.join(dir, 'reply-results.scored-before-rescore.json')), 'the first scoring is kept');
    assert.match(fs.readFileSync(path.join(dir, 'reply-report.md'), 'utf8'), /\| c \|/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every wire shape is named by protocol, not by vendor', () => {
  assert.deepEqual(Object.keys(PROTOCOLS).sort(),
    ['chat-completions-stream', 'generate-content-stream', 'responses', 'responses-stream']);
});

test('--self-test runs the whole bake-off against a fake streaming server on port 0', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const run = spawnSync(process.execPath, [tool, '--self-test'], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /self-test ok/);
});
