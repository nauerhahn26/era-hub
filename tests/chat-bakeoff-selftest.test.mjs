// chat-bakeoff-selftest.test.mjs: the streaming transcription bake-off tool's
// offline self-test (real-time chat plan, phase 0). The tool is a uv script;
// its --self-test plays a short tone to fake WebSocket and HTTP servers on
// loopback (ephemeral ports, no credentials, no outside host) for every wire
// protocol it speaks and checks the query, headers, frames, finalize/close
// order, partials, final text and scoring.
//
// uv resolves the script's dependencies from its cache (--offline, so the
// gate's network namespace never matters). Only a missing uv or an
// unresolvable offline cache skips, and only before the self-test has
// started; once it prints its start line any failure fails the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../tools/chat-bakeoff.py', import.meta.url));

test('chat-bakeoff --self-test: every wire protocol against loopback fakes', (t) => {
  const result = spawnSync('uv', ['run', '--offline', '--quiet', '--script', TOOL, '--self-test'], {
    encoding: 'utf8', timeout: 180000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const started = (result.stdout || '').includes('self-test: start');
  if (!started && (result.error?.code === 'ENOENT' ||
      /offline|network|No solution found|Failed to (download|fetch)|not found in the cache/i.test(output))) {
    t.skip(`uv or its offline package cache is unavailable: ${output.split('\n')[0] || result.error}`);
    return;
  }
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /self-test: (\d+) passed, 0 failed/);
  assert.doesNotMatch(result.stdout, /^not ok/m);
});
