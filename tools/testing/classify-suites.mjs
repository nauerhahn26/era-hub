#!/usr/bin/env node
// classify-suites.mjs: derive each registered suite's scheduling classes from
// its source and write them into registry.json (gate-speed plan 2026-10-26,
// item 1.5; design section 3.1).
//
//   node tools/testing/classify-suites.mjs            rewrite registry.json in place
//   node tools/testing/classify-suites.mjs --check    exit 1, listing every field that differs
//   [--registry FILE] [--hub DIR]                     another registry copy or hub checkout
//
// Re-runnable by design: run it after any sync, merge or suite edit. It reads
// every suite where the gate collects it (resolveRoots, so ERA_WT_SUFFIX
// selects sibling worktrees exactly as the gate's sib() does), never runs one,
// and writes nothing when nothing changed. tests/suite-classes.test.mjs fails
// the gate when the committed registry and this derivation disagree, so a
// class cannot drift from its source: change the source or the table below,
// rerun, review the diff.
//
// Fields, appended to every suite in this order after its reviewed fields:
//   hub       "none" | "own" | "shared-reader" | "shared-writer". "shared" =
//             the suite connects to the gate's shared hub (a call such as
//             goto/fetch/get/post whose first argument is a live-hub URL
//             literal, an identifier built from one, or a helper module that
//             does so without the suite pointing the helper's env seam
//             elsewhere first); "writer" when any such call is a non-GET
//             (method: POST/PUT/PATCH/DELETE or a post/put/patch/delete call).
//             "own" = it spawns server.js itself. A suite that does both is
//             shared (what the scheduler must respect) and lists both hubs
//             in `resources`. Page-originated writes (a page on the shared hub
//             posting /log on its own) are not visible to a static read; the
//             route-stub registry test (plan 3.5) guards those.
//   ports     every fixed listener port the source claims, by the same
//             extractor tests/suite-ports.test.mjs uses (suite-source.mjs),
//             plus the gaze engine's bus port (49155) when the suite stands a
//             stand-in engine up on it (claimsEngine): kiosk-pause and routes
//             share it by design, so the lanes must never run them together.
//   browsers  browser launch call sites (.launch( / .launchPersistentContext()
//             in code, not in comments or strings). Call sites, not runtime
//             launches: one in a loop counts once.
//   heavy     loads the garment segmentation runtime directly (a require,
//             import or Worker of segment.js or clothing-worker.js), or has at
//             least HEAVY_BROWSERS launch sites, or is named in OVERRIDES.
//   solo      only from OVERRIDES: suites that assert latency on a loaded host,
//             or hold a host-wide resource other suites' hubs read (the gaze
//             engine's bus).
//   quiet     only from OVERRIDES: suites whose fixed dwell or timer windows
//             fail under CPU starvation. The summary lists timing-dense suites
//             that are not quiet as candidates; promotion is evidence-led
//             (plan 2.5), not a density threshold.
//   retry     a reviewed decision, never derived: kept as found, false when
//             absent. `owner` names who answers for a retried suite and is ""
//             unless retry is true; this transform refuses to write either
//             half without the other.
// `resources`: the gate-lock/shared-assembly/fixed-ports triple that 133
// suites carried said nothing per suite. No tool reads its values (the
// inventory check only requires an array), so a list made only of words from
// that triple and the DERIVED_RESOURCES vocabulary (an empty list included) is
// rewritten from the classes; any list with another word in it was written by
// a reviewer and is kept verbatim (tests/suite-classes.test.mjs checks that it
// still agrees with the derived browser count).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blank, claims, claimsEngine, ENGINE_PORT } from './suite-source.mjs';
import { REGISTRY_FILE, resolveRoots } from './suite-runner.mjs';

export const CLASS_FIELDS = ['hub', 'ports', 'browsers', 'heavy', 'solo', 'quiet', 'retry', 'owner'];
export const HUBS = ['none', 'own', 'shared-reader', 'shared-writer'];
export const BOILERPLATE = ['gate-lock', 'shared-assembly', 'fixed-ports'];
export const DERIVED_RESOURCES = ['shared-hub', 'own-hub', 'browser', 'fixed-ports', 'temporary-data', 'in-process'];
// Ten launch sites is a suite that starts a fresh Chromium for nearly every
// case; each start costs most of a core for about a second. Six suites today.
export const HEAVY_BROWSERS = 10;
// Fixed waits at which the summary names a suite as a quiet candidate.
const WAITS_ADVISORY = 8;
// The live hub's port, written as a sum like the suites write it: the gate
// rewrites the literal in every collected file.
const LIVE = 8300 + 77;

// The judgment calls. Each entry sets classes the source cannot show by
// itself, says why, and carries a witness: a pattern that must still match the
// suite's code (comments blanked) or the transform stops, so an entry cannot
// outlive its reason. An entry naming an unregistered suite also stops it.
const suite = (name) => `era-hub:tests/${name}.test.mjs`;
export const OVERRIDES = [
  // solo: runs with nothing else running (lanes.mjs starts solo suites first).
  { id: suite('clothing-responsive'), set: { solo: true, heavy: true },
    why: 'asserts every page answers under 900 ms while a slow-AI ingest of six photos runs (six segmentation cut-outs, measured 10/26); a neighbour lane is exactly the load it measures',
    witness: /slowest\s*<\s*900/ },
  // A stand-in engine on 127.0.0.1:49155 is seen by every hub on the host:
  // each hub's GET /settings probes that port to place the door (doorGoes and
  // pauseGoes flip from "home" to "tdsnap"), so a suite in another lane that
  // reads /settings from the gate hub or its own would see this suite's
  // engine. Both suites bind the bus for about a second; solo costs that.
  { id: suite('kiosk-pause'), set: { solo: true },
    why: 'holds a stand-in engine on 49155, which every hub\'s GET /settings probes to place the door, so hubs in other lanes would see it',
    witness: /\.listen\(\s*49155\b/ },
  { id: suite('routes'), set: { solo: true },
    why: 'holds a stand-in engine on 49155, which every hub\'s GET /settings probes to place the door, so hubs in other lanes would see it',
    witness: /\.listen\(\s*49155\b/ },
  // heavy: segmentation reached through a hub or clothing.js build, which a
  // static read cannot see. Measured 10/26 with a preload hook that logged every
  // segment.js cutOut call per suite run (clothing.test.mjs, 24 cut-outs in
  // 350 s, requires segment.js itself and is derived). Not heavy on that measurement: clothing-weather (1
  // cut-out in 44 s), clothing-share (2 in 55 s), clothing-attrs, -refit,
  // -status, -sync-rebuild, -item (0), and chat-native-speech (loads the ONNX
  // runtime for its 2 s activity model, no segmentation).
  { id: suite('clothing-accessories'), set: { heavy: true },
    why: 'drives full clothing builds with a live fake AI, so every new photo goes through the wasm cut-out',
    witness: /ERA_AI_URL:\s*`http:\/\/127\.0\.0\.1:\$\{AI_PORT\}`/ },
  // quiet: at most one at a time, never beside a heavy suite.
  { id: suite('games-ui'), set: { quiet: true },
    why: 'real dwell engine at a 900 ms dwell and 17 fixed waits; a starved page misses its window',
    witness: /dwellMs\s*:\s*900/ },
  { id: suite('math-ui'), set: { quiet: true },
    why: 'real dwell engine at a 900 ms dwell between fixed waits',
    witness: /dwellMs\s*:\s*900/ },
  { id: suite('play-ui'), set: { quiet: true },
    why: 'real dwell plus answers armed only after the question is read (ARM_CAP_MS)',
    witness: /ARM_CAP_MS\s*=\s*\d+/ },
  { id: suite('drawing-ui'), set: { quiet: true },
    why: '19 fixed waits of up to 1.5 s around real dwell and retry timers',
    witness: /page\.waitForTimeout\(1[25]00\)/ },
  { id: suite('presence'), set: { quiet: true },
    why: 'beacon every 600 ms and an idle window of 1.2 s, asserted on the wall clock',
    witness: /ERA_BEACON_IDLE_MS:\s*String\(IDLE_MS\)/ },
  { id: suite('update-boot'), set: { quiet: true },
    why: 'boot, tick and quiet-window timers shrunk to 400-1500 ms and asserted on the wall clock',
    witness: /ERA_UPDATE_QUIET_MS:\s*String\(QUIET_MS\)/ },
  // hub: where the static reading is right about the code but wrong about the gate.
  { id: suite('icons'), set: { hub: 'shared-reader' },
    why: 'its one non-GET (POST /setup) runs only for a profile-less hub under ICONS_SEED_PROFILE=1, which the gate never sets (plan 1.4); without it the case fails instead of writing',
    witness: /assert\.ok\(SEED_PROFILE,\s*NO_PROFILE\)/ },
  { id: suite('suite-ports'), set: { hub: 'none' },
    why: 'the "server.js" it spawns is a ten-line stand-in written to a temp dir, on a kernel-assigned port',
    witness: /path\.join\(tmp,\s*"server\.js"\)/ },
];

// ---- a small scanner over code whose comments are blanked and strings kept --

function skipQuoted(code, i) {
  const q = code[i];
  let j = i + 1;
  while (j < code.length && code[j] !== q && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
  return j + 1;
}
function skipTemplate(code, i) {
  let j = i + 1;
  while (j < code.length && code[j] !== '`') {
    if (code[j] === '\\') { j += 2; continue; }
    if (code[j] === '$' && code[j + 1] === '{') { j = skipGroup(code, j + 1); continue; }
    j++;
  }
  return j + 1;
}
// code[i] opens a bracket; the index just past its match.
function skipGroup(code, i) {
  let depth = 0, j = i;
  while (j < code.length) {
    const c = code[j];
    if (c === '"' || c === "'") { j = skipQuoted(code, j); continue; }
    if (c === '`') { j = skipTemplate(code, j); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return j + 1;
    j++;
  }
  return code.length;
}
// Top-level pieces of `text` separated by `stop` characters.
function topLevel(text, stops) {
  const out = [];
  let start = 0, j = 0;
  while (j < text.length) {
    const c = text[j];
    if (c === '"' || c === "'") { j = skipQuoted(text, j); continue; }
    if (c === '`') { j = skipTemplate(text, j); continue; }
    if (c === '(' || c === '[' || c === '{') { j = skipGroup(text, j); continue; }
    if (stops.includes(c)) {
      out.push(text.slice(start, j)); start = j + 1;
      if (c !== ',') return out;
    }
    j++;
  }
  out.push(text.slice(start));
  return out;
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentions(text, names) {
  if (!names.size) return false;
  return new RegExp(`(?<![\\w$.])(?:${[...names].map(escape).join('|')})(?![\\w$])`).test(text);
}
const lineOf = (code, index) => code.slice(0, index).split('\n').length;

// Each `name = value` in code: the value up to the end of its statement.
function assignments(code, bare) {
  const out = [];
  for (const m of bare.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) {
    const start = m.index + m[0].length;
    out.push({ name: m[1], value: topLevel(code.slice(start), [';', '\n', ','])[0] });
  }
  return out;
}
// Each call of a callee matching `callee` in code: its name, line and arguments.
function calls(code, bare, callee) {
  const out = [];
  for (const m of bare.matchAll(new RegExp(String.raw`(?<![\w$])(${callee})\s*\(`, 'g'))) {
    const open = m.index + m[0].length - 1, close = skipGroup(code, open);
    const text = code.slice(open + 1, close - 1);
    out.push({ callee: m[1], line: lineOf(code, m.index), text, args: topLevel(text, [',']) });
  }
  return out;
}
// Names whose values satisfy `seed`, closed over names built from them.
function tainted(assigns, seed) {
  const names = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const a of assigns) {
      if (names.has(a.name) || !(seed(a.value) || mentions(a.value, names))) continue;
      names.add(a.name); grew = true;
    }
  }
  return names;
}

const LIVE_URL = new RegExp(String.raw`(?:https?|wss?)://(?:localhost|127\.0\.0\.1|\[::1\]):${LIVE}(?!\d)`);
const CONNECT = 'goto|fetch|request|get|post|put|patch|delete|head|waitFor[A-Za-z]*|connect|EventSource|WebSocket';
const NON_GET = /\bmethod\s*:\s*["'`](?:POST|PUT|PATCH|DELETE)\b/i;
const SPAWN = 'spawn|spawnSync|fork|execFile|execFileSync|exec|execSync';
const SEGMENTATION = /(?<![\w-])(?:segment|clothing-worker)\.js\b/;

// What one source shows by itself, plus what its ./ helper modules contribute.
// `helper(name)` returns a helper's source or null.
export function analyseSource(src, { helper = () => null, seen = new Set() } = {}) {
  const code = blank(src, { keepStrings: true }), bare = blank(src);
  const assigns = assignments(code, bare);

  // the shared hub: live-URL roots, their env seams, and names built from them
  const roots = assigns.filter((a) => LIVE_URL.test(a.value));
  const seams = [...new Set(roots.flatMap((a) => [...a.value.matchAll(/process\.env\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1])))].sort();
  const base = tainted(assigns, (v) => LIVE_URL.test(v));
  const relative = (arg) => /^\s*["'`]\//.test(arg);
  const connections = calls(code, bare, CONNECT);
  const toShared = connections.filter((c) => c.args[0] !== undefined && (LIVE_URL.test(c.args[0]) || mentions(c.args[0], base)));
  let shared = toShared.length > 0;
  const write = (c) => /^(?:post|put|patch|delete)$/.test(c.callee) || NON_GET.test(c.text);
  // a relative URL is the page's own origin: the shared hub, once the suite drives one
  const writes = [...toShared, ...(shared ? connections.filter((c) => relative(c.args[0] || '')) : [])]
    .filter(write).map((c) => ({ line: c.line, text: `${c.callee}(${c.text.replace(/\s+/g, ' ').slice(0, 120)})` }));

  // its own hub: a spawned server.js, directly or through names built from it
  const entry = tainted(assigns, (v) => /(?<![\w$.-])server\.js\b/.test(v) && !/^\s*createRequire\s*\(/.test(v));
  let own = calls(code, bare, SPAWN).some((c) => /(?<![\w$.-])server\.js\b/.test(c.text) || mentions(c.text, entry));

  // helper modules next to the suite (the gate copies them beside it)
  const helpers = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)(["'`])\.\/([^"'`]+)\1/g)].map((m) => m[2]);
  for (const name of [...new Set(helpers)]) {
    if (seen.has(name)) continue;
    const text = helper(name);
    if (text == null) continue;
    const h = analyseSource(text, { helper, seen: new Set([...seen, name]) });
    const pointedAway = h.seams.length && h.seams.every((s) => new RegExp(`process\\.env\\.${escape(s)}\\s*=(?![=>])`).test(bare));
    if (h.shared && !pointedAway) {
      shared = true;
      writes.push(...h.writes.map((w) => ({ ...w, text: `${name}:${w.line} ${w.text}` })));
    }
    own ||= h.own;
  }

  const segmentation = calls(code, bare, 'require|import|Worker').some((c) => SEGMENTATION.test(c.args[0] || '')) ||
    [...code.matchAll(/\bimport\b[^;'"`]*?\bfrom\s*(["'`])([^"'`]+)\1/g)].some((m) => SEGMENTATION.test(m[2]));
  return {
    shared, writes, seams, own,
    ports: [...new Set([...claims(src).map((c) => c.port), ...(claimsEngine(src) ? [ENGINE_PORT] : [])])].sort((a, b) => a - b),
    browsers: (bare.match(/\.\s*launch(?:PersistentContext)?\s*\(/g) || []).length,
    segmentation,
    waits: (bare.match(/\bwaitForTimeout\s*\(/g) || []).length,
    temporary: /\bmkdtemp(?:Sync)?\s*\(|\btmpdir\s*\(/.test(bare),
  };
}

function splitID(id) {
  const colon = id.indexOf(':'), repo = id.slice(0, colon), relative = id.slice(colon + 1);
  if (colon < 1 || !relative.startsWith('tests/') || relative.split('/').some((p) => p === '..' || p === '.')) throw new Error(`Invalid suite ID: ${id}`);
  return { repo, relative };
}

// Reads `<repo>:tests/<file>` from the resolved checkouts; null when absent.
export function sourceReader(roots) {
  return (id) => {
    const { repo, relative } = splitID(id);
    if (!roots[repo]) return null;
    try { return fs.readFileSync(path.join(roots[repo], relative), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
}

const ownedResources = (list) => Array.isArray(list) &&
  list.every((r) => DERIVED_RESOURCES.includes(r) || BOILERPLATE.includes(r));
function derivedResources(facts, cls) {
  const shared = cls.hub.startsWith('shared'), own = cls.hub === 'own' || (shared && facts.own);
  const out = [];
  if (shared) out.push('shared-hub');
  if (own) out.push('own-hub');
  if (cls.browsers) out.push('browser');
  if (cls.ports.length) out.push('fixed-ports');
  if (facts.temporary) out.push('temporary-data');
  return out.length ? out : ['in-process'];
}

export function validateClasses(registry) {
  const problems = [];
  for (const s of registry.suites) {
    if ('retry' in s && typeof s.retry !== 'boolean') problems.push(`${s.id}: retry must be true or false`);
    if ('owner' in s && typeof s.owner !== 'string') problems.push(`${s.id}: owner must be a string`);
    const owner = typeof s.owner === 'string' ? s.owner.trim() : '';
    if (s.retry === true && !owner) problems.push(`${s.id}: retry is true but no owner is named`);
    if (s.retry !== true && owner) problems.push(`${s.id}: owner ${JSON.stringify(s.owner)} is set but retry is not`);
  }
  return problems;
}

// The registry with every suite's classes derived afresh. Pure: `read(id)`
// supplies sources (suites and their helpers), `overrides` the table above.
export function classifyRegistry(registry, { read, overrides = OVERRIDES }) {
  const out = structuredClone(registry), notes = { overridden: [], writers: [], quietCandidates: [] };
  const known = new Set(out.suites.map((s) => s.id));
  for (const o of overrides) if (!known.has(o.id)) throw new Error(`override for ${o.id}: not registered (drop it from OVERRIDES)`);
  const repos = registry.repositories || [...new Set(out.suites.map((s) => splitID(s.id).repo))];
  for (const s of out.suites) {
    const { repo } = splitID(s.id), src = read(s.id);
    if (src == null) throw new Error(`${s.id}: source not found`);
    // a helper resolves like the gate's flat copy: this repo first, then the others
    const helper = (name) => [repo, ...repos.filter((r) => r !== repo)].map((r) => read(`${r}:tests/${name}`)).find((t) => t != null) ?? null;
    const facts = analyseSource(src, { helper });
    const cls = {
      hub: facts.shared ? (facts.writes.length ? 'shared-writer' : 'shared-reader') : facts.own ? 'own' : 'none',
      ports: facts.ports, browsers: facts.browsers,
      heavy: facts.segmentation || facts.browsers >= HEAVY_BROWSERS,
      solo: false, quiet: false,
    };
    if (facts.writes.length) notes.writers.push({ id: s.id, writes: facts.writes });
    const code = blank(src, { keepStrings: true });
    for (const o of overrides.filter((o) => o.id === s.id)) {
      if (!o.witness.test(code)) throw new Error(`${s.id}: override witness ${o.witness} no longer matches the source (${o.why})`);
      for (const [field, value] of Object.entries(o.set)) {
        if (!(field in cls)) throw new Error(`${s.id}: override sets ${field}, which is not a derived class`);
        if (cls[field] !== value) notes.overridden.push(`${s.id}: ${field} ${JSON.stringify(cls[field])} -> ${JSON.stringify(value)} (${o.why})`);
        cls[field] = value;
      }
    }
    if (!cls.quiet && facts.waits >= WAITS_ADVISORY) notes.quietCandidates.push(`${s.id} (${facts.waits} fixed waits)`);
    const retry = typeof s.retry === 'boolean' ? s.retry : false, owner = typeof s.owner === 'string' ? s.owner : '';
    if (ownedResources(s.resources)) s.resources = derivedResources(facts, cls);
    for (const field of CLASS_FIELDS) delete s[field];
    Object.assign(s, cls, { retry, owner });
  }
  const problems = validateClasses(out);
  if (problems.length) throw new Error(problems.join('\n'));
  return { registry: out, notes };
}

export const serialize = (registry) => JSON.stringify(registry, null, 2) + '\n';

function differences(before, after) {
  const was = new Map(before.suites.map((s) => [s.id, s])), lines = [];
  for (const s of after.suites) {
    const old = was.get(s.id) || {};
    for (const key of new Set([...Object.keys(old), ...Object.keys(s)])) {
      if (JSON.stringify(old[key]) !== JSON.stringify(s[key])) lines.push(`${s.id}: ${key} ${JSON.stringify(old[key])} -> ${JSON.stringify(s[key])}`);
    }
    if (JSON.stringify(Object.keys(old)) !== JSON.stringify(Object.keys(s)) && !lines.some((l) => l.startsWith(s.id + ':'))) lines.push(`${s.id}: key order`);
  }
  return lines;
}

function summary(registry, notes) {
  const count = (pred) => registry.suites.filter(pred).length;
  const named = (field) => registry.suites.filter((s) => s[field]).map((s) => s.id.replace(/:tests\//, ':')).join(', ') || '-';
  const lines = [
    `suites ${registry.suites.length}: ${HUBS.map((h) => `${h} ${count((s) => s.hub === h)}`).join(', ')}`,
    `browsers: ${count((s) => s.browsers > 0)} suites launch one (${registry.suites.reduce((n, s) => n + s.browsers, 0)} launch sites); fixed ports: ${count((s) => s.ports.length)} suites`,
    `heavy: ${named('heavy')}`, `solo: ${named('solo')}`, `quiet: ${named('quiet')}`,
  ];
  for (const w of notes.writers) lines.push(`static non-GET to the shared hub: ${w.id}: ${w.writes.map((x) => `line ${x.line} ${x.text}`).join('; ')}`);
  for (const o of notes.overridden) lines.push(`override: ${o}`);
  if (notes.quietCandidates.length) lines.push(`timing-dense, not quiet (candidates for plan 2.5): ${notes.quietCandidates.join(', ')}`);
  return lines.join('\n');
}

async function main(argv) {
  const option = (name) => { const at = argv.indexOf(name); return at < 0 ? null : argv[at + 1]; };
  const file = path.resolve(option('--registry') || REGISTRY_FILE);
  const hub = path.resolve(option('--hub') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const original = fs.readFileSync(file, 'utf8'), registry = JSON.parse(original);
  const { registry: derived, notes } = classifyRegistry(registry, { read: sourceReader(resolveRoots(hub)) });
  const text = serialize(derived);
  console.log(summary(derived, notes));
  if (text === original) { console.log(`${path.relative(process.cwd(), file) || file}: unchanged`); return 0; }
  const changed = differences(registry, derived);
  if (argv.includes('--check')) {
    console.log(`${file} differs from the sources in ${changed.length} field(s):\n  ${changed.slice(0, 60).join('\n  ')}${changed.length > 60 ? `\n  ... ${changed.length - 60} more` : ''}`);
    return 1;
  }
  const mode = fs.statSync(file).mode & 0o777, temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode }); fs.chmodSync(temp, mode); fs.renameSync(temp, file);
  console.log(`${file}: rewrote ${changed.length} field(s)`);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (error) => { console.error(`classify-suites: ${error.message}`); process.exitCode = 2; });
}
