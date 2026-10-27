// Host tools over Chat test-mode records (spec 2026-10-27 §5): the report reads
// a device's logs or a synced pool; the replay re-sends one turn's audio through
// the phase-0 bake-off. Fixtures only; the bake-off itself is never run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hub = fileURLToPath(new URL('../', import.meta.url));
const run = (tool, args, env = {}) => spawnSync(process.execPath, [path.join(hub, 'tools', tool), ...args], { cwd: hub, encoding: 'utf8', env: { ...process.env, ...env } });
const ID = n => `${String(n).padStart(8, '0')}-d9cb-469f-a165-70867728950e`;
function record(n, build, transcriptMs, extra = {}) {
  return { version: 1, id: ID(n), kind: 'hold', mode: 'one-shot', session: null, startedAt: '2026-10-27T18:00:00.000Z', outcome: 'completed',
    stages: [{ name: 'begin', ms: 0 }, { name: 'release', ms: 1000 }, { name: 'partial', ms: 800, text: 'would' }, { name: 'transcript', ms: 1000 + transcriptMs },
      { name: 'firstChoiceStaged', ms: 1000 + transcriptMs + 700, text: 'Music' }, { name: 'playbackStart', ms: 4000 }],
    content: { transcript: 'Would you like music or a story?', choices: [{ label: 'Music', say: 'Music' }], selected: { label: 'Music', say: 'Music' }, spoken: 'Music', keyterms: null },
    health: { release: { cpuBusy: 0.2, load1: null, freeMemBytes: 2e9, totalMemBytes: 8e9, eventLoopLagMs: 3, gaze: 'running', rtt: { transcription: 40, reply: null } } },
    mic: { peakRms: 0.31, clipped: 0, frames: 8 },
    receivedAt: '2026-10-27T18:00:05.000Z', day: '2026-10-27', build, device: 'test-device', models: { reply: 'reply-model-x', transcription: null },
    cost: { currency: 'USD', reply: 0.001, transcription: 0, voice: 0, total: 0.001, complete: true }, ...extra };
}
async function fixtures(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-tools-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'data', 'logs', 'chat-turns');
  await fs.mkdir(path.join(logs, 'audio'), { recursive: true });
  const records = [record(1, 'b1', 300), record(2, 'b1', 500), record(3, 'b2', 900, { receivedAt: '2026-10-28T09:00:00.000Z', day: '2026-10-28', cost: null }),
    record(4, 'b1', 100, { outcome: 'cancelled', reason: 'cancel' })];
  await fs.writeFile(path.join(logs, '2026-10-27.jsonl'), records.slice(0, 2).map(r => JSON.stringify(r)).join('\n') + '\n{"torn":\n');
  await fs.writeFile(path.join(logs, '2026-10-28.jsonl'), records.slice(2).map(r => JSON.stringify(r)).join('\n') + '\n');
  await fs.writeFile(path.join(logs, 'audio', ID(1) + '.wav'), 'RIFF');
  const pool = path.join(dir, 'pool', 'events', 'test-device');
  await fs.mkdir(pool, { recursive: true });
  await fs.writeFile(path.join(pool, '2026-10-27.jsonl'), [
    { t: '2026-10-27T18:00:05.000Z', device: 'test-device', kind: 'app-log', entry: { app: 'board' } },
    ...records.map(turn => ({ t: turn.receivedAt, device: 'test-device', kind: 'chat-turn', turn })),
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  return { dir, data: path.join(dir, 'data'), logs, pool: path.join(dir, 'pool') };
}

test('chat-turns report: p50/p95 per stage per build from release, outcomes by reason, cost per day', async t => {
  const f = await fixtures(t);
  for (const dir of [f.logs, f.data, f.pool]) {
    const result = run('chat-turns.mjs', ['--dir', dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /4 turns: 3 completed, 1 cancelled, 0 failed/);
    assert.match(result.stdout, /b1 · hold · 3 turns/);
    assert.match(result.stdout, /transcript\s+400\s+490\s+2\b/);
    assert.match(result.stdout, /b2 · hold · 1 turns/);
    assert.match(result.stdout, /cancelled: cancel 1/);
    assert.match(result.stdout, /2026-10-27\s+0\.003 USD\s+3 turns/);
    assert.match(result.stdout, /2026-10-28\s+0 USD\s+1 turns \(1 unpriced\)/);
    assert.doesNotMatch(result.stdout, /Would you like/, 'the summary prints numbers, not words');
    const json = JSON.parse(run('chat-turns.mjs', ['--dir', dir, '--json']).stdout);
    assert.deepEqual(json.builds.b1.hold.stages.transcript, { n: 2, p50: 400, p95: 490 });
  }
  const env = { ERA_DATA_DIR: f.data };
  assert.match(run('chat-turns.mjs', [], env).stdout, /4 turns/, 'defaults to this hub\'s data folder');
});

test('chat-turns --turn prints one timeline with words, health and cost', async t => {
  const f = await fixtures(t);
  const result = run('chat-turns.mjs', ['--dir', f.pool, '--turn', ID(2)]);
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  assert.match(out, new RegExp(`turn ${ID(2)} · hold · one-shot · completed · build b1 · device test-device`));
  assert.ok(out.indexOf('partial') < out.indexOf('release') && out.indexOf('release') < out.indexOf('transcript'), 'stages in time order');
  assert.match(out, /transcript\s+\+500 ms/);
  assert.match(out, /partial\s+-200 ms\s+“would”/);
  assert.match(out, /heard: Would you like music or a story\?/);
  assert.match(out, /health at release: cpu 20% · free memory 2\.0 GB · loop lag 3 ms · gaze running · round trip transcription 40 ms, reply –/);
  assert.match(out, /estimated cost 0\.001 USD/);
  const missing = run('chat-turns.mjs', ['--dir', f.pool, '--turn', ID(9)]);
  assert.equal(missing.status, 1); assert.match(missing.stderr, /no turn/);
});

test('chat-replay builds a one-clip manifest from the stored wav and shells out to the bake-off', async t => {
  const f = await fixtures(t);
  const result = run('chat-replay.mjs', ['--dir', f.data, '--turn', ID(1), '--configs', 'turn-pro', '--dry-run'], { TMPDIR: f.dir });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.command.slice(0, 6), ['uv', 'run', 'tools/chat-bakeoff.py', '--configs', 'turn-pro', '--manifest']);
  assert.deepEqual(plan.command.slice(7), ['--clips', 'turn-' + ID(1)]);
  assert.ok(plan.command[6].startsWith(f.dir), 'the manifest is a temporary file');
  assert.deepEqual(JSON.parse(await fs.readFile(plan.command[6], 'utf8')), plan.manifest);
  assert.deepEqual(plan.manifest, [{ id: 'turn-' + ID(1), path: path.join(f.logs, 'audio', ID(1) + '.wav'), text: 'Would you like music or a story?', kind: 'replay' }]);
  const noAudio = run('chat-replay.mjs', ['--dir', f.data, '--turn', ID(2), '--configs', 'turn-pro', '--dry-run']);
  assert.equal(noAudio.status, 2); assert.match(noAudio.stderr, /no recording/);
  const pool = run('chat-replay.mjs', ['--dir', f.pool, '--turn', ID(1), '--configs', 'turn-pro', '--dry-run']);
  assert.equal(pool.status, 2); assert.match(pool.stderr, /audio stays on the device/);
  const usage = run('chat-replay.mjs', ['--turn', ID(1)]);
  assert.equal(usage.status, 2); assert.match(usage.stderr, /--configs/);
});
