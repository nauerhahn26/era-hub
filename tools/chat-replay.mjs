#!/usr/bin/env node
// chat-replay.mjs — re-run one Chat test-mode turn's recorded question through
// any configured transcription setting (real-time chat spec 2026-10-27 §5),
// using the phase-0 bake-off as the harness: a one-clip manifest whose
// reference is the turn's own final transcript, then
//   uv run tools/chat-bakeoff.py --configs <names> --manifest <file> --clips turn-<id>
//
//   node tools/chat-replay.mjs --turn <id> --configs <name[,name]> [--dir DATA] [--dry-run]
//
// The audio exists only on the device that recorded it (never in the pool), so
// DIR is that device's data folder (or a copy of it). --dry-run prints the
// command and manifest as JSON and runs nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRecords } from './chat-turns.mjs';

const hub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fail(message) { console.error(message); process.exit(2); }
const args = { dir: null, turn: null, configs: null, dryRun: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dir') args.dir = argv[++i];
  else if (argv[i] === '--turn') args.turn = argv[++i];
  else if (argv[i] === '--configs') args.configs = argv[++i];
  else if (argv[i] === '--dry-run') args.dryRun = true;
  else fail('unknown argument ' + argv[i]);
}
if (!args.turn || !args.configs) fail('usage: node tools/chat-replay.mjs --turn <id> --configs <name[,name]> [--dir DATA] [--dry-run]');
if (!/^[0-9a-f-]{36}$/.test(args.turn)) fail('a turn id looks like 0f8fad5b-d9cb-469f-a165-70867728950e');
if (!/^[A-Za-z0-9_.,-]+$/.test(args.configs)) fail('--configs takes bake-off setting ids, comma-separated');
const dir = path.resolve(args.dir || process.env.ERA_DATA_DIR || path.join(hub, 'data'));
const { source, logs, records } = loadRecords(dir);
if (source === 'pool') fail('the audio stays on the device: point --dir at the data folder of the device that recorded the turn');
const wav = path.join(logs, 'audio', args.turn + '.wav');
if (!fs.existsSync(wav)) fail(`no recording for turn ${args.turn} in ${path.dirname(wav)} (only released holds recorded in test mode keep audio, the newest 200)`);
const record = records.find(item => item.id === args.turn);
const clip = 'turn-' + args.turn;
const manifest = [{ id: clip, path: wav, text: record?.content?.transcript || '', kind: 'replay' }];
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'era-chat-replay-')), 'manifest.json');
fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
const command = ['uv', 'run', 'tools/chat-bakeoff.py', '--configs', args.configs, '--manifest', file, '--clips', clip];
if (args.dryRun) { console.log(JSON.stringify({ command, manifest }, null, 2)); process.exit(0); }
const result = spawnSync(command[0], command.slice(1), { cwd: hub, stdio: 'inherit' });
fs.rmSync(path.dirname(file), { recursive: true, force: true });
process.exit(result.status ?? 1);
