import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const file of ['chat-speech-runtime.py', 'chat-speech-benchmark.py']) test(`speech contracts: ${file}`, () => {
  const result = spawnSync('python3', [fileURLToPath(new URL(file, import.meta.url))], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
