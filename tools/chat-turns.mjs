#!/usr/bin/env node
// chat-turns.mjs — read Chat test-mode records (real-time chat spec 2026-10-27
// §5) and print what dad's testing measured: p50/p95 per stage per build
// (milliseconds from release), outcomes by reason and estimated cost per day.
//
//   node tools/chat-turns.mjs [--dir DIR] [--json]
//   node tools/chat-turns.mjs [--dir DIR] --turn <id>      one turn's timeline
//
// DIR is a device's data folder, its logs/chat-turns folder, or a synced family
// data pool (the folder holding events/<device>/<day>.jsonl). Default: this
// hub's data folder ($ERA_DATA_DIR, else ./data). Read-only.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { summarize } = require('../chat-turns.js');

function lines(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* a torn line mid-sync */ } }
  return out;
}
const jsonl = dir => { try { return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort().map(name => path.join(dir, name)); } catch { return []; } };
export function loadRecords(dir) {
  if (fs.existsSync(path.join(dir, 'events'))) {
    const out = [];
    for (const device of fs.readdirSync(path.join(dir, 'events')).sort())
      for (const file of jsonl(path.join(dir, 'events', device)))
        for (const line of lines(file)) if (line && line.kind === 'chat-turn' && line.turn && typeof line.turn === 'object') out.push(line.turn);
    return { source: 'pool', logs: null, records: out };
  }
  const logs = fs.existsSync(path.join(dir, 'logs', 'chat-turns')) ? path.join(dir, 'logs', 'chat-turns') : dir;
  return { source: 'device', logs, records: jsonl(logs).flatMap(lines).filter(record => record && typeof record.id === 'string') };
}

const pad = (value, width) => String(value).padEnd(width);
export function report(records) {
  const value = summarize(records), out = [];
  const count = outcome => records.filter(record => record.outcome === outcome).length;
  out.push(`Chat test mode: ${records.length} turns: ${count('completed')} completed, ${count('cancelled')} cancelled, ${count('failed')} failed`);
  for (const [build, kinds] of Object.entries(value.builds)) for (const [kind, group] of Object.entries(kinds)) {
    out.push('', `${build} · ${kind} · ${group.turns} turns (completed turns; ms from release)`, `  ${pad('stage', 20)}${pad('p50', 9)}${pad('p95', 9)}n`);
    const order = Object.entries(group.stages).sort((a, b) => a[1].p50 - b[1].p50);
    for (const [stage, stat] of order) out.push(`  ${pad(stage, 20)}${pad(stat.p50, 9)}${pad(stat.p95, 9)}${stat.n}`);
  }
  out.push('', 'Outcomes by reason', `  completed ${value.outcomes.completed}`);
  for (const outcome of ['cancelled', 'failed']) {
    const reasons = Object.entries(value.outcomes[outcome]);
    if (reasons.length) out.push(`  ${outcome}: ${reasons.map(([reason, n]) => `${reason} ${n}`).join(', ')}`);
  }
  const currency = records.find(record => record.cost && record.cost.currency)?.cost.currency || 'USD';
  out.push('', 'Estimated cost per day (from the private price table; unpriced turns count 0)');
  for (const [day, cost] of Object.entries(value.costPerDay).sort())
    out.push(`  ${day}  ${cost.usd} ${currency}  ${cost.turns} turns${cost.unpriced ? ` (${cost.unpriced} unpriced)` : ''}`);
  return out.join('\n');
}

const ms = value => (Number.isFinite(value) ? `${Math.round(value)} ms` : '–');
export function timeline(record) {
  const out = [`turn ${record.id} · ${record.kind} · ${record.mode} · ${record.outcome}${record.reason ? ` (${record.reason})` : ''} · build ${record.build || '?'} · device ${record.device || '?'} · ${record.startedAt}`];
  if (record.error) out.push(`error: ${record.error}`);
  const stages = [...(record.stages || [])].sort((a, b) => a.ms - b.ms);
  const release = stages.find(stage => stage.name === 'release');
  for (const stage of stages) {
    const offset = release ? stage.ms - release.ms : stage.ms;
    out.push(`  ${pad(stage.name, 20)}${pad((release && offset >= 0 ? '+' : '') + Math.round(offset) + ' ms', 12)}${stage.text ? `“${stage.text}”` : ''}`.trimEnd());
  }
  const content = record.content || {};
  out.push(`heard: ${content.transcript || '–'}`, `replies: ${(content.choices || []).map(choice => `${choice.label}${choice.symbol ? ` [${choice.symbol}]` : ''}`).join(' | ') || '–'}`,
    `chose: ${content.selected?.label || '–'}; said: ${content.spoken || '–'}`);
  if (record.worker) out.push(`worker: ${Object.entries(record.worker).map(([key, value]) => `${key} ${value === null ? '–' : value}`).join(', ')}`);
  const usage = record.usage || {};
  const parts = [];
  if (usage.reply) parts.push(`reply ${usage.reply.model || '?'}: ${usage.reply.inputTokens} in (${usage.reply.cachedTokens} cached), ${usage.reply.outputTokens} out`);
  if (Number.isFinite(usage.audioSeconds)) parts.push(`audio ${usage.audioSeconds} s`);
  if (usage.voice) parts.push(`saved voice ${usage.voice.chars ?? '–'} chars (${usage.voice.cache || '–'}), ${usage.voice.fetchedChars || 0} chars fetched`);
  if (parts.length) out.push(`usage: ${parts.join('; ')}`);
  for (const at of ['release', 'reveal']) {
    const h = record.health?.[at]; if (!h) continue;
    out.push(`health at ${at}: cpu ${h.cpuBusy === null ? '–' : Math.round(h.cpuBusy * 100) + '%'} · free memory ${h.freeMemBytes ? (h.freeMemBytes / 1e9).toFixed(1) + ' GB' : '–'} · loop lag ${ms(h.eventLoopLagMs)} · gaze ${h.gaze || '–'} · round trip transcription ${ms(h.rtt?.transcription)}, reply ${ms(h.rtt?.reply)}`);
  }
  if (record.mic) out.push(`microphone: peak level ${record.mic.peakRms}, clipped samples ${record.mic.clipped}, frames ${record.mic.frames}`);
  out.push(record.cost ? `estimated cost ${record.cost.total} ${record.cost.currency}${record.cost.complete ? '' : ' (some parts unpriced)'}` : 'estimated cost: no price table');
  return out.join('\n');
}

export function parseArgs(argv) {
  const args = { dir: null, turn: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--turn') args.turn = argv[++i];
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else throw new Error('unknown argument ' + argv[i]);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  if (args.help) { console.log('node tools/chat-turns.mjs [--dir DATA|LOGS|POOL] [--json] [--turn ID]'); process.exit(0); }
  const dir = path.resolve(args.dir || process.env.ERA_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'));
  const { records } = loadRecords(dir);
  if (args.turn) {
    const record = records.find(item => item.id === args.turn);
    if (!record) { console.error(`no turn ${args.turn} in ${dir}`); process.exit(1); }
    console.log(timeline(record));
  } else console.log(args.json ? JSON.stringify(summarize(records), null, 2) : report(records));
}
