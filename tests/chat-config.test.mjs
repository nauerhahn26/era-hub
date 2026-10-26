import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadChatEnvironment } = require('../chat-api.js');

function config(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-chat-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ai.env'); fs.writeFileSync(file, source); return file;
}

test('private environment accepts literal Chat assignments only and process values win', t => {
  const file = config(t, [
    '# private Chat settings', 'export ERA_CHAT_SPEECH_URL=https://speech.example/transcribe',
    'ERA_CHAT_SPEECH_MODEL="configured"', "ERA_CHAT_SPEECH_TOKEN='private-value'", 'OTHER_PRIVATE_KEY=not-chat',
    "ERA_CHAT_RUNTIME_ARGS='[\"--worker\"]'", 'ERA_CHAT_TEXT_MODEL=$(do-not-execute)',
    'not an assignment', 'ERA_CHAT_BAD="unterminated',
  ].join('\n'));
  const result = loadChatEnvironment({ file, env: { ERA_CHAT_SPEECH_MODEL: 'process-value', PATH: 'not-chat', OTHER_PRIVATE_KEY: 'also-not-chat' } });
  assert.equal(result.ERA_CHAT_SPEECH_URL, 'https://speech.example/transcribe');
  assert.equal(result.ERA_CHAT_SPEECH_MODEL, 'process-value');
  assert.equal(result.ERA_CHAT_SPEECH_TOKEN, 'private-value');
  assert.equal(result.ERA_CHAT_RUNTIME_ARGS, '["--worker"]');
  assert.equal(result.ERA_CHAT_TEXT_MODEL, '$(do-not-execute)');
  assert.ok(!('OTHER_PRIVATE_KEY' in result) && !('PATH' in result) && !('ERA_CHAT_BAD' in result));
});

test('disabled, missing and oversized private configuration never imports secrets', t => {
  const file = config(t, 'ERA_CHAT_SPEECH_TOKEN=private-value\n');
  assert.deepEqual(loadChatEnvironment({ file, env: { ERA_CHAT_CONFIG_DISABLED: '1', ERA_CHAT_SPEECH_MODEL: 'process-value' } }),
    { ERA_CHAT_CONFIG_DISABLED: '1', ERA_CHAT_SPEECH_MODEL: 'process-value' });
  fs.writeFileSync(file, 'ERA_CHAT_SPEECH_TOKEN=private-value\n' + '#'.repeat(70000));
  assert.deepEqual(loadChatEnvironment({ file, env: {} }), {});
  assert.deepEqual(loadChatEnvironment({ file: file + '.missing', env: {} }), {});
});

test('environment parsing does not expand shell values or evaluate commands', t => {
  const file = config(t, ["ERA_CHAT_RUNTIME='$(never-run)'", "ERA_CHAT_TEXT_TOKEN='${UNRELATED_PRIVATE_KEY}'", 'ERA_CHAT_SPEECH_MODEL=`never-run`'].join('\n'));
  const result = loadChatEnvironment({ file, env: {} });
  assert.equal(result.ERA_CHAT_RUNTIME, '$(never-run)');
  assert.equal(result.ERA_CHAT_TEXT_TOKEN, '${UNRELATED_PRIVATE_KEY}');
  assert.equal(result.ERA_CHAT_SPEECH_MODEL, '`never-run`');
});
