// The same self-contained harness is shipped to the Windows guest by leg B.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('installed Chat speech harness exercises real bundled activity and mock-only recognition', { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('lib/chat-speech-smoke.cjs', import.meta.url)), root,
    fileURLToPath(new URL('fixtures/chat-choice.wav', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stdout + stderr);
  const report = JSON.parse(stdout.trim());
  assert.equal(report.ok, true); assert.equal(report.silenceRejected, true);
  assert.equal(report.uploadsBeforeRelease, 0); assert.equal(report.releaseFinals, 1);
  assert.equal(report.cancelClosedTransport, true); assert.equal(report.staleFinals, 0);
  assert.equal(report.fixtureAcceptedByActivity, true); assert.equal(report.wakeAdvertised, false);
  assert.equal(stderr, '');
});
