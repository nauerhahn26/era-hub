// Immutable source preparation and full-gate evidence for isolated workers.
// This module never runs a gate or changes an original checkout.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const REPOS = ['era-core', 'era-making-words', 'era-pencil', 'era-board', 'era-gaze', 'era-hub'];
const LEGACY = ['run','parts','transfer','mistakes','pencil','narrow','sortfix',
  'fltest','bargein','sortbugs','rhymecount','transfercount','phonetic'];
const SEED_AREAS = new Set(['content','gen-assets','recipes','wardrobe','music','movies','symbols-cache',
  'profile.json','app-settings.json','personal-lexicon.json','tts-config.json']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const within = (file, directory) => file === directory || file.startsWith(directory + path.sep);
const canonical = file => fs.realpathSync(path.resolve(file));
function futurePath(file) {
  let parent = path.resolve(file);
  const missing = [];
  while (!fs.existsSync(parent)) {
    try { if (fs.lstatSync(parent).isSymbolicLink()) throw new Error('Output path contains a dangling symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    missing.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) throw new Error('Output path cannot be resolved');
    parent = next;
  }
  return path.join(canonical(parent), ...missing);
}
function emptyOutput(directory, inputs) {
  directory = path.resolve(directory);
  if (futurePath(directory) !== directory) throw new Error('Output path cannot traverse a symlink');
  for (const input of inputs) {
    if (within(directory, input) || within(input, directory)) throw new Error('Output overlaps an input');
  }
  if (fs.existsSync(directory) && (!fs.statSync(directory).isDirectory() || fs.readdirSync(directory).length)) throw new Error('Output directory must be empty');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}
function git(directory, args, { optional = false } = {}) {
  const result = spawnSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8', maxBuffer: 32 << 20, timeout: 180000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status !== 0) {
    if (optional) return null;
    throw new Error(`Git ${args[0]} failed in ${directory}: ${result.error?.message || result.stderr.trim()}`);
  }
  return result.stdout.trim();
}
function tuple(origin) {
  origin = canonical(origin);
  if (canonical(git(origin, ['rev-parse', '--show-toplevel'])) !== origin) throw new Error('Source must be a repository root');
  if (git(origin, ['status', '--porcelain', '--untracked-files=all'])) throw new Error(`Dirty source checkout: ${origin}`);
  if (git(origin, ['rev-parse', '--is-shallow-repository']) === 'true') throw new Error(`Incomplete source history: ${origin}`);
  const head = git(origin, ['rev-parse', 'HEAD']);
  const tree = git(origin, ['rev-parse', `${head}^{tree}`]);
  return { origin, head, tree };
}
export function resolveSources(hub, { suffix = '' } = {}) {
  if (suffix && !/^--wt-[a-z0-9][a-z0-9-]*$/.test(suffix)) throw new Error('Invalid worktree suffix');
  hub = canonical(hub);
  const root = path.dirname(hub), sources = {};
  for (const repo of REPOS) {
    const candidate = path.join(root, repo + suffix);
    sources[repo] = repo === 'era-hub' ? hub : canonical(suffix && fs.existsSync(candidate) ? candidate : path.join(root, repo));
  }
  return sources;
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (/(?:api.?key|token|secret|password|credential|authorization|email|beacon|hook|device.?id|child.?name|drive.?path|drive.?root)/i.test(key) || /^key$/i.test(key)) continue;
    result[key] = scrub(value[key]);
  }
  return result;
}
function approvedSeed(seedDir, sources) {
  if (!seedDir) throw new Error('An approved test seed directory is required');
  const input = path.resolve(seedDir);
  if (fs.lstatSync(input).isSymbolicLink()) throw new Error('Test seed must not be a symlink');
  seedDir = canonical(input);
  const root = path.dirname(sources['era-hub']);
  for (const live of [path.join(root, 'era-family/data'), path.join(root, 'era-hub/data'), path.join(sources['era-hub'], 'data')]) {
    const physical = fs.existsSync(live) ? canonical(live) : path.resolve(live);
    if (within(seedDir, physical) || within(physical, seedDir)) throw new Error('Live data is forbidden as a test seed');
  }
  if (!fs.statSync(seedDir).isDirectory()) throw new Error('Test seed must be a directory');
  const entries = [];
  function visit(directory, relative = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const local = relative ? relative + '/' + name : name;
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Test seed contains a symlink');
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('Test seed contains an unsupported entry');
      if (stat.isDirectory()) { visit(file, local); continue; }
      if (!SEED_AREAS.has(local.split('/')[0])) continue;
      let bytes = fs.readFileSync(file);
      if (/\.json$/i.test(name)) {
        let value;
        try { value = scrub(JSON.parse(bytes.toString('utf8'))); }
        catch { throw new Error(`Invalid synthetic seed JSON: ${local}`); }
        if (local === 'profile.json') value = { ...value, childName: 'Fixture' };
        bytes = Buffer.from(JSON.stringify(value) + '\n');
      }
      entries.push({ relative: local, bytes });
    }
  }
  visit(seedDir);
  const digest = hash(JSON.stringify(entries.map(entry => [entry.relative, hash(entry.bytes)])));
  return { origin: seedDir, digest, entries };
}
export function freezeSeed({ seedDir, sources, destination }) {
  const seed = approvedSeed(seedDir, sources);
  const output = emptyOutput(destination, [...Object.values(sources), seed.origin]);
  for (const entry of seed.entries) {
    const file = path.join(output, entry.relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, entry.bytes, { mode: 0o400, flag: 'wx' });
  }
  if (approvedSeed(seed.origin, sources).digest !== seed.digest || approvedSeed(output, sources).digest !== seed.digest) throw new Error('Test seed changed while freezing');
  return { path: output, seedDir: output, origin: seed.origin, digest: seed.digest, files: seed.entries.length };
}
export function captureOrigins(sources, { seedDir, suffix = '' } = {}) {
  const origins = {};
  for (const repo of REPOS) {
    if (!sources[repo]) throw new Error(`Missing selected source: ${repo}`);
    origins[repo] = tuple(sources[repo]);
  }
  const seed = approvedSeed(seedDir, sources);
  const fixtures = [];
  const scanner = path.join(path.dirname(origins['era-hub'].origin), 'era-family/tools/era-scan.sh');
  const scannerRequired = tracked(origins['era-hub'].origin, origins['era-hub'].head).includes('tests/era-scan-parity.test.mjs');
  if (fs.existsSync(scanner)) {
    const stat = fs.lstatSync(scanner);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Approved scanner fixture must be a regular file');
    fixtures.push({ relative: 'era-family/tools/era-scan.sh', origin: canonical(scanner), digest: hash(fs.readFileSync(scanner)) });
  } else if (scannerRequired) throw new Error('Required private scanner fixture is missing');
  for (const repo of REPOS) {
    const after = tuple(origins[repo].origin);
    if (after.head !== origins[repo].head || after.tree !== origins[repo].tree) throw new Error(`Source moved while capturing: ${repo}`);
  }
  const identity = { version: 1, hub: origins['era-hub'].origin, suffix, origins,
    seed: { origin: seed.origin, digest: seed.digest }, fixtures };
  return { ...identity, hash: hash(JSON.stringify(identity)) };
}

function tracked(origin, head) {
  return git(origin, ['ls-tree', '-r', '--name-only', head, '--', 'tests']).split('\n').filter(Boolean);
}
export function discoverExpectedSuites(origins) {
  const hub = origins['era-hub'];
  const script = git(hub.origin, ['show', `${hub.head}:tools/era-gate.sh`]);
  const loops = [...script.matchAll(/for\s+repo\s+in\s+([^;\n]+);\s*do/g)]
    .map(match => match[1].trim().split(/\s+/));
  const repositories = loops.find(repos => repos.includes('era-hub') && repos.includes('era-core'));
  if (!repositories || repositories.some(repo => !REPOS.includes(repo))) throw new Error('Unsupported candidate gate collector');
  const destinations = new Map(), suites = [];
  for (const repo of repositories) {
    const source = origins[repo], files = tracked(source.origin, source.head);
    if (!files.length) throw new Error(`Missing required tests directory: ${repo}`);
    const top = new Set(files.map(file => file.split('/')[1]));
    for (const name of top) {
      if (destinations.has(name)) throw new Error(`Collector collision: ${destinations.get(name)} and ${repo}:tests/${name}`);
      destinations.set(name, `${repo}:tests/${name}`);
    }
    for (const file of files) {
      if (file.split('/').length !== 2) continue;
      const basename = path.basename(file);
      if (basename.endsWith('.test.mjs')) suites.push({ id: `${repo}:${file}`, basename, kind: 'modern' });
      else if (LEGACY.includes(basename.slice(0, -3)) && basename.endsWith('.js')) suites.push({ id: `${repo}:${file}`, basename, kind: 'legacy' });
      else if (basename.endsWith('.js')) throw new Error(`Unsupported top-level executable test: ${repo}:${file}`);
    }
  }
  for (const name of LEGACY) {
    if (!suites.some(suite => suite.basename === name + '.js')) throw new Error(`Missing required legacy suite: ${name}.js`);
  }
  if (!suites.some(suite => suite.kind === 'modern')) throw new Error('No modern gate coverage discovered');
  return suites.sort((a, b) => a.id.localeCompare(b.id));
}
function requiredHistory(origin) {
  const objects = new Set();
  for (const file of tracked(origin.origin, origin.head)) {
    if (!/\.(?:mjs|js|sh)$/.test(file)) continue;
    const text = git(origin.origin, ['show', `${origin.head}:${file}`]);
    if (!/\bgit\b/.test(text)) continue;
    for (const match of text.matchAll(/\b[a-f0-9]{7,40}\b/g)) {
      const object = git(origin.origin, ['rev-parse', '--verify', `${match[0]}^{commit}`], { optional: true });
      if (object) objects.add(object);
    }
  }
  return [...objects].sort();
}
export function prepareSnapshot({ hub, suffix = '', workspace, seedDir }) {
  workspace = path.resolve(workspace);
  const sources = resolveSources(hub, { suffix });
  const captured = captureOrigins(sources, { seedDir, suffix });
  const expectedSuites = discoverExpectedSuites(captured.origins);
  emptyOutput(workspace, [...Object.values(sources), captured.seed.origin]);
  const clones = {}, history = {};
  for (const repo of REPOS) {
    const origin = captured.origins[repo], destination = path.join(workspace, repo);
    history[repo] = requiredHistory(origin);
    git(workspace, ['clone', '--quiet', '--shared', '--dissociate', '--no-checkout', '--no-hardlinks', origin.origin, destination]);
    git(destination, ['checkout', '--quiet', '--detach', origin.head]);
    for (const object of history[repo]) {
      if (!git(destination, ['cat-file', '-e', `${object}^{commit}`], { optional: true })) {
        // Empty stdout is also success for cat-file; verify with rev-parse.
        if (!git(destination, ['rev-parse', '--verify', `${object}^{commit}`], { optional: true })) {
          git(destination, ['fetch', '--quiet', origin.origin, object]);
        }
      }
      if (git(destination, ['rev-parse', `${object}^{commit}`]) !== object) throw new Error('Historical object verification failed');
    }
    git(destination, ['fsck', '--full', '--no-dangling']);
    if (fs.existsSync(path.join(destination, '.git/objects/info/alternates'))) throw new Error('Snapshot retained an external object store');
    const checked = tuple(destination);
    if (checked.head !== origin.head || checked.tree !== origin.tree) throw new Error('Snapshot checkout does not match selected source');
    clones[repo] = destination;
    if (suffix) fs.symlinkSync(repo, path.join(workspace, repo + suffix));
  }
  const seed = approvedSeed(captured.seed.origin, sources);
  if (seed.digest !== captured.seed.digest) throw new Error('Test seed moved while preparing');
  const ownedSeed = path.join(workspace, 'era-family/test-data');
  fs.mkdirSync(ownedSeed, { recursive: true, mode: 0o700 });
  for (const entry of seed.entries) {
    const file = path.join(ownedSeed, entry.relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, entry.bytes, { mode: 0o600 });
  }
  for (const fixture of captured.fixtures) {
    const bytes = fs.readFileSync(fixture.origin);
    if (hash(bytes) !== fixture.digest) throw new Error('Approved scanner fixture moved while preparing');
    const file = path.join(workspace, fixture.relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { mode: 0o700 });
  }
  const manifest = { ...captured, workspace, hub: clones['era-hub'], clones, history,
    seedDir: ownedSeed, expectedSuites, environment: { ERA_DATA_DIR: ownedSeed,
      ERA_WT_SUFFIX: suffix, ERA_GAZE_SRC: clones['era-gaze'], ERA_CHAT_CONFIG_DISABLED: '1' } };
  const verified = verifyOrigins(manifest);
  if (!verified.valid) throw new Error(`Inputs moved while preparing snapshot: ${verified.reasons.join('; ')}`);
  return manifest;
}
export function verifyOrigins(manifest) {
  const reasons = [];
  try {
    const sources = Object.fromEntries(REPOS.map(repo => [repo, manifest.origins[repo].origin]));
    const current = captureOrigins(sources, { seedDir: manifest.seed.origin, suffix: manifest.suffix });
    if (current.hash !== manifest.hash) reasons.push('Selected source or test seed changed');
    for (const repo of REPOS) {
      if (!manifest.clones?.[repo]) continue;
      const clone = tuple(manifest.clones[repo]), expected = manifest.origins[repo];
      if (clone.head !== expected.head || clone.tree !== expected.tree) reasons.push(`Snapshot source changed: ${repo}`);
    }
    for (const fixture of manifest.fixtures || []) {
      if (!manifest.workspace) continue;
      const file = path.join(manifest.workspace, fixture.relative);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || hash(fs.readFileSync(file)) !== fixture.digest) reasons.push('Pinned scanner fixture changed');
    }
  } catch (error) { reasons.push(error.message); }
  return { valid: reasons.length === 0, reasons };
}

function ownedFile(file, root) {
  const resolvedRoot = canonical(root), absolute = path.resolve(file);
  if (!within(absolute, resolvedRoot)) throw new Error('Evidence path escapes its job');
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || !within(canonical(absolute), resolvedRoot)) throw new Error('Evidence must be an owned regular file');
  return fs.readFileSync(absolute, 'utf8');
}
function number(text, field) {
  const matches = [...text.matchAll(new RegExp(`^# ${field} (\\d+)\\s*$`, 'gm'))];
  return matches.length === 1 ? Number(matches[0][1]) : null;
}
export function validateGateResults({ manifest, workspace = manifest.workspace, gateExitCode,
  stampsDir, gateLog = path.join(path.dirname(workspace), 'gate.log'), now = Date.now(), maxAgeSeconds = 7200 }) {
  const reasons = [], suites = [], skips = [], stamps = [];
  let summary = null;
  const job = path.dirname(path.resolve(workspace));
  try {
    if (path.resolve(workspace) !== path.resolve(manifest.workspace)) throw new Error('Workspace identity changed');
    const origins = verifyOrigins(manifest);
    reasons.push(...origins.reasons);
    if (gateExitCode !== 0) reasons.push('Candidate gate did not exit successfully');
    const log = ownedFile(gateLog, job);
    const summaries = [...log.matchAll(/^== era-gate: (\d+) passed, (\d+) failed(?: →[^\n]*)? ==$/gm)];
    if (summaries.length !== 1) reasons.push('Exactly one full gate summary is required');
    else {
      summary = summaries[0][0];
      if (Number(summaries[0][1]) !== manifest.expectedSuites.length || Number(summaries[0][2]) !== 0) reasons.push('Full gate summary does not cover every expected suite');
    }
    const expectedLabels = new Set(manifest.expectedSuites.map(suite => suite.kind === 'legacy' ? suite.basename.slice(0, -3) : suite.basename));
    const completed = new Map();
    for (const match of log.matchAll(/^(PASS|FAIL) (\S+)(?:[^\n]*)$/gm)) {
      const [, result, label] = match;
      if (!expectedLabels.has(label)) reasons.push(`Unexpected executed suite: ${label}`);
      completed.set(label, (completed.get(label) || 0) + 1);
      if (result !== 'PASS') reasons.push(`Failed suite: ${label}`);
    }
    for (const suite of manifest.expectedSuites) {
      const label = suite.kind === 'legacy' ? suite.basename.slice(0, -3) : suite.basename;
      if (completed.get(label) !== 1) reasons.push(`Missing or duplicate execution: ${suite.id}`);
      let text;
      try { text = ownedFile(path.join(manifest.hub, 'gate', suite.basename.replace(/\.(?:mjs|js)$/, '.out')), job); }
      catch (error) { reasons.push(`Missing suite output: ${suite.id}: ${error.message}`); continue; }
      if (suite.kind === 'modern') {
        const tests = number(text, 'tests'), pass = number(text, 'pass'), fail = number(text, 'fail');
        const cancelled = number(text, 'cancelled'), skipped = number(text, 'skipped'), todo = number(text, 'todo');
        if (!tests || !pass || fail !== 0 || cancelled !== 0 || skipped !== 0 || todo !== 0 || pass !== tests || /^\s*not ok\b/m.test(text)) {
          reasons.push(`Invalid or incomplete modern output: ${suite.id}`);
        }
        for (const line of text.split('\n').filter(line => /\bSKIP\b/i.test(line))) {
          skips.push({ id: suite.id, line });
          if (/root (?:reads|writes) every|no non-internal IPv4|nothing can reach a hub off loopback/i.test(line)) reasons.push(`Mandatory permission/network coverage skipped: ${suite.id}`);
        }
      } else {
        const matches = [...text.matchAll(/(\d+) passed,\s*(\d+) failed/g)];
        const last = matches.at(-1);
        if (!last || Number(last[1]) < 1 || Number(last[2]) !== 0) reasons.push(`Invalid legacy output: ${suite.id}`);
      }
      suites.push({ ...suite, status: 'pass' });
    }
    const stampRepos = manifest.suffix ? REPOS : ['era-hub'];
    const trees = new Set();
    for (const repo of stampRepos) {
      const origin = manifest.origins[repo];
      if (trees.has(origin.tree)) { reasons.push('Ambiguous colliding source tree stamps'); continue; }
      trees.add(origin.tree);
      const file = path.join(stampsDir, origin.tree);
      let text;
      try { text = ownedFile(file, job); }
      catch (error) { reasons.push(`Missing genuine stamp: ${repo}: ${error.message}`); continue; }
      const field = name => [...text.matchAll(new RegExp(`^${name}=(.*)$`, 'gm'))];
      const head = field('head'), at = field('at'), hub = field('hub'), source = field('repo');
      const stampTime = at.length === 1 && /^\d+$/.test(at[0][1]) ? Number(at[0][1]) : NaN;
      if (text.split('\n')[0] !== summary || head.length !== 1 || head[0][1] !== origin.head ||
        hub.length !== 1 || hub[0][1] !== manifest.hub || /^dirty=/m.test(text) ||
        !Number.isFinite(stampTime) || stampTime > now / 1000 + 30 || now / 1000 - stampTime >= maxAgeSeconds ||
        (repo === 'era-hub' ? source.length !== 0 : source.length !== 1 || source[0][1] !== path.join(workspace, repo + manifest.suffix))) {
        reasons.push(`Stamp does not prove the selected tuple: ${repo}`); continue;
      }
      stamps.push({ repo, tree: origin.tree, path: file, origin: origin.origin, head: origin.head, digest: hash(text), at: stampTime });
    }
  } catch (error) { reasons.push(error.message); }
  return { valid: reasons.length === 0, reasons, summary, suites, stamps, skips };
}
export function promoteStamps(options) {
  const { manifest } = options;
  const destination = path.resolve(options.destination);
  const allowed = path.join(path.dirname(path.resolve(manifest.workspace)), 'exposed-stamps');
  if (destination !== allowed) throw new Error('Stamp destination must be the job-owned exposed-stamps directory');
  const result = validateGateResults(options);
  if (!result.valid) throw new Error(`Invalid gate evidence: ${result.reasons.join('; ')}`);
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error('Stamp destination cannot be a symlink');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const paths = [], created = [];
  try {
    for (const stamp of result.stamps) {
      const bytes = fs.readFileSync(stamp.path);
      if (hash(bytes) !== stamp.digest) throw new Error('Stamp changed during exposure');
      const file = path.join(destination, stamp.tree);
      if (fs.existsSync(file) || fs.lstatSync(destination).isSymbolicLink()) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || hash(fs.readFileSync(file)) !== stamp.digest) throw new Error('Existing stamp destination is not matching owned evidence');
      } else {
        fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
        created.push(file);
      }
      paths.push(file);
    }
    if (!verifyOrigins(manifest).valid) throw new Error('Source inputs changed while exposing stamps');
  } catch (error) {
    for (const file of created) fs.unlinkSync(file);
    throw error;
  }
  return paths;
}
