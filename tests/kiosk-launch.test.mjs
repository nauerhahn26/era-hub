// kiosk-launch.js: the hub relaunches its own kiosk at /chat/?ask=<nonce> when
// a button press finds no Chat page listening (button press to ask, design
// 2026-10-27 §4.2 case 3; plan T1.4, decision 2). start-hub.bat is the only
// other place that launches the kiosk, so the flags and the browser order here
// are DERIVED from the bat's own text (as start-hub-bat.test.mjs reads it): a
// later change to the bat fails this parity test until the hub follows it.
// The hub spawns the browser exe directly: never cmd.exe (a cmd relaunch was
// refused under Defender, "spawn EPERM"), never a .ps1. Off Windows the
// relaunch records {would: args} and resolves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { kioskArgs, findBrowser, createKioskLauncher, BROWSERS } = require('../kiosk-launch.js');

const SH = fs.readFileSync(new URL('../tools/build-payload.sh', import.meta.url), 'utf8');
const start = SH.indexOf('cat > "$OUT/start-hub.bat"');
const bat = SH.slice(start, SH.indexOf('\nBAT\n', start));
const lines = bat.split('\n');
const kioskLine = lines.find(l => l.includes('--kiosk'));
const DIR = 'C:\\Users\\Family\\AppData\\Local\\Our Era Comms';

// cmd's view of the kiosk line's arguments after "%B%": split on spaces outside
// quotes, quotes removed (as the browser's argv receives them), variables
// expanded the way the bat expands them.
function batArgs(open, { port, cdp = '' }) {
  const m = /^start "" "%B%" (.*)$/.exec(kioskLine);
  assert.ok(m, 'the kiosk line is still start "" "%B%" <args>: ' + kioskLine);
  const cdpLine = lines.find(l => /^if defined ERA_QA_CDP set CDP=/.test(l));
  assert.ok(cdpLine, 'the bat still adds the CDP flag only under ERA_QA_CDP');
  const cdpFlag = cdp ? cdpLine.replace(/^if defined ERA_QA_CDP set CDP=/, '').replace(/%ERA_QA_CDP%/g, String(cdp)) : '';
  const expanded = m[1].replace(/%PORT%/g, String(port)).replace(/%OPEN%/g, open).replace(/%~dp0/g, DIR + '\\').replace(/%CDP%/g, cdpFlag);
  const out = []; let cur = '', quoted = false, any = false;
  for (const ch of expanded) {
    if (ch === '"') { quoted = !quoted; any = true; continue; }
    if (ch === ' ' && !quoted) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch; any = true;
  }
  if (cur || any) out.push(cur);
  return out;
}

test('the flags are exactly start-hub.bat\'s kiosk line, in its order', () => {
  for (const open of ['/chat/?ask=0123456789abcdef', '/home/']) {
    assert.deepEqual(kioskArgs(open, { port: 8377, dir: DIR }), batArgs(open, { port: 8377 }), open);
    assert.deepEqual(kioskArgs(open, { port: 8377, dir: DIR + '\\' }), batArgs(open, { port: 8377 }), 'a trailing separator is one separator');
  }
  assert.ok(kioskArgs('/chat/', { port: 8377, dir: DIR }).some(a => a.endsWith('\\data\\kiosk-profile')), 'the kiosk profile: closeKiosk finds it by this marker');
});

test('the DevTools flag rides only when the QA launcher set it, as in the bat', () => {
  assert.deepEqual(kioskArgs('/chat/', { port: 8377, dir: DIR, cdp: '9222' }), batArgs('/chat/', { port: 8377, cdp: '9222' }));
  assert.ok(!kioskArgs('/chat/', { port: 8377, dir: DIR }).some(a => a.includes('remote-debugging')));
  assert.ok(!kioskArgs('/chat/', { port: 8377, dir: DIR, cdp: '92 22 --evil' }).some(a => a.includes('remote-debugging')), 'digits only');
});

test('the browser order is the bat\'s: the last existing "set B=" wins', () => {
  const sets = lines.map(l => /^if exist "([^"]+)" set B=(.+)$/.exec(l)).filter(Boolean);
  assert.ok(sets.length >= 2, 'the bat still probes the browsers with if exist');
  for (const [, probed, set] of sets) assert.equal(probed, set, 'each probe sets the exe it probed');
  assert.deepEqual(BROWSERS, sets.map(s => s[1]).reverse());
  for (let i = 0; i < BROWSERS.length; i++) {
    const present = new Set(BROWSERS.slice(i));
    assert.equal(findBrowser(file => present.has(file)), BROWSERS[i]);
  }
  assert.equal(findBrowser(() => false), null);
});

test('off Windows the relaunch records {would: args} and resolves, touching nothing', async () => {
  let touched = 0;
  const launcher = createKioskLauncher({ port: 8377, dir: DIR, platform: 'linux', spawn: () => { touched++; }, closeKiosk: () => { touched++; },
    settle: () => { touched++; }, exists: () => true });
  const result = await launcher.relaunch('/chat/?ask=0123456789abcdef');
  assert.deepEqual(result, { would: kioskArgs('/chat/?ask=0123456789abcdef', { port: 8377, dir: DIR }) });
  assert.deepEqual(launcher.last(), result);
  assert.equal(touched, 0);
});

test('on Windows: close our kiosk, wait 1 s, spawn the browser exe detached and hidden, then settle it in front', async () => {
  const steps = [];
  const child = { unref: () => steps.push('unref'), on: () => {} };
  const launcher = createKioskLauncher({ port: 8377, dir: DIR, platform: 'win32', exists: file => file === BROWSERS.at(-1),
    closeKiosk: async () => { steps.push('close'); }, wait: async ms => { steps.push('wait ' + ms); },
    spawn: (exe, args, options) => { steps.push({ exe, args, options }); return child; }, settle: async () => { steps.push('settle'); } });
  const result = await launcher.relaunch('/chat/?ask=0123456789abcdef');
  assert.deepEqual(steps.slice(0, 2), ['close', 'wait 1000']);
  const spawned = steps[2];
  assert.equal(spawned.exe, BROWSERS.at(-1));
  assert.deepEqual(spawned.args, kioskArgs('/chat/?ask=0123456789abcdef', { port: 8377, dir: DIR }));
  assert.deepEqual(spawned.options, { detached: true, stdio: 'ignore', windowsHide: true });
  assert.deepEqual(steps.slice(3), ['unref', 'settle']);
  assert.equal(result.ok, true); assert.equal(result.exe, BROWSERS.at(-1));
});

test('on Windows with no browser nothing is closed or spawned', async () => {
  const steps = [];
  const launcher = createKioskLauncher({ port: 8377, dir: DIR, platform: 'win32', exists: () => false,
    closeKiosk: async () => steps.push('close'), wait: async () => steps.push('wait'), spawn: () => steps.push('spawn'), settle: async () => steps.push('settle') });
  assert.deepEqual(await launcher.relaunch('/chat/'), { ok: false, reason: 'no-browser' });
  assert.deepEqual(steps, []);
});

test('a spawn that throws is reported, never thrown', async () => {
  const launcher = createKioskLauncher({ port: 8377, dir: DIR, platform: 'win32', exists: () => true, closeKiosk: async () => {}, wait: async () => {},
    spawn: () => { throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }); }, settle: async () => { throw new Error('never'); } });
  assert.deepEqual(await launcher.relaunch('/chat/'), { ok: false, reason: 'spawn EPERM' });
});

test('the module never goes through cmd.exe or a PowerShell file', () => {
  const src = fs.readFileSync(new URL('../kiosk-launch.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /cmd(\.exe)?['"]/i);
  assert.doesNotMatch(src, /\.ps1/i);
  assert.doesNotMatch(src, /shell:\s*true/);
});
