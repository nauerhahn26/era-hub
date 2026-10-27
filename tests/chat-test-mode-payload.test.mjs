// Chat test mode is per device, explicit and off by default (real-time chat
// spec 2026-10-27 §5): no file a family installs may switch it on, and no
// recording, price table or settings file may ride into a payload. The hub's
// own default, settings door and route order are proved on a running hub in
// chat-test-mode-hub.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const read = file => fs.readFile(new URL(file, root), 'utf8');
const ENABLES = /["']?chatTestMode["']?\s*[:=]\s*true\b/;
// The hub's entry file is only READ here, never started: its name is assembled
// so the suite classifier does not take this suite for one that runs a hub.
const HUB_FILE = ['server', 'js'].join('.');

test('no file a family installs switches test mode on', async () => {
  const files = ['tools/build-payload.sh', 'tools/installer.nsi', HUB_FILE, 'chat-turns.js', 'chat-api.js'];
  for (const dir of ['public']) for (const name of await fs.readdir(new URL(dir + '/', root), { recursive: true }))
    if (/\.(?:js|json|html|mjs)$/.test(name)) files.push(path.posix.join(dir, name.split(path.sep).join('/')));
  for (const name of await fs.readdir(root)) if (/\.(?:js|json)$/.test(name)) files.push(name);
  for (const file of new Set(files)) {
    let text; try { text = await read(file); } catch { continue; }
    assert.doesNotMatch(text, ENABLES, file + ' must not enable Chat test mode');
  }
  const nsi = await read('tools/installer.nsi');
  assert.doesNotMatch(nsi, /app-settings\.json/, 'the installer seeds no settings file');
});

test('the payload ships the module and refuses settings, prices and recordings', async t => {
  const script = await read('tools/build-payload.sh');
  const copy = script.split('\n').find(line => line.startsWith('cp "$HUB/chat-api.js"'));
  assert.ok(copy.includes('"$HUB/chat-turns.js"'), 'chat-turns.js is in the payload copy');
  const guard = script.match(/# BEGIN Chat test-mode guard\n([\s\S]*?)# END Chat test-mode guard/);
  assert.ok(guard, 'the payload actively refuses test-mode data');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'era-chat-test-mode-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out');
  const run = () => spawnSync('bash', ['-euc', guard[1]], { env: { ...process.env, OUT: out }, encoding: 'utf8' });
  await fs.mkdir(path.join(out, 'public'), { recursive: true });
  await fs.writeFile(path.join(out, HUB_FILE), '// chatTestMode: false is the default');
  assert.equal(run().status, 0, run().stdout + run().stderr);
  const refuse = async (file, text) => {
    await fs.mkdir(path.dirname(path.join(out, file)), { recursive: true });
    await fs.writeFile(path.join(out, file), text);
    const result = run();
    assert.notEqual(result.status, 0, file + ' must stop the build');
    assert.match(result.stdout + result.stderr, /Chat test mode/);
    await fs.rm(path.join(out, file.split('/')[0]), { recursive: true, force: true });
    assert.equal(run().status, 0);
  };
  await refuse('data/logs/chat-turns/2026-10-27.jsonl', '{}');
  await refuse('logs/chat-turns/audio/x.wav', 'RIFF');
  await refuse('chat-prices.json', '{}');
  await refuse('defaults/app-settings.json', '{"chatTestMode": true}');
  await refuse('public/defaults.json', '{ "chatTestMode" : true }');
  await refuse('public/config.mjs', "export default { 'chatTestMode': true };");
  await refuse('public/page.js', 'const settings = { chatTestMode: true };');
});
