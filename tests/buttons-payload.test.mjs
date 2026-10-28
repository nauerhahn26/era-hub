// The device button listener ships as SOURCE (button press to ask, design
// 2026-10-27 §4.1; plan T5.1, T5.7). buttons/EraButtons.cs is compiled on the
// device by the hub, exactly as the gaze engine's source is, so the payload
// must carry it; and the payload law stands: no PowerShell file ships, and the
// listener itself never starts PowerShell. Static checks only: the C# is
// compiled for real on the Windows VM (tests-vm/leg-b-update.e2e.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { KEYS } = require('../buttons.js');
const SRC = fs.readFileSync(path.join(HUB, 'buttons', 'EraButtons.cs'), 'utf8');
const PAYLOAD = fs.readFileSync(path.join(HUB, 'tools', 'build-payload.sh'), 'utf8');
// the C# with its comments taken out (a `//` after whitespace; the URL's
// `http://` has none before it): what the compiler sees
const CODE = SRC.replace(/(^|\s)\/\/[^\n]*/g, '$1');

test('build-payload.sh copies buttons/EraButtons.cs into the payload\'s buttons/ folder', () => {
  assert.match(PAYLOAD, /mkdir -p "\$OUT\/buttons"/);
  assert.match(PAYLOAD, /cp "\$HUB\/buttons\/EraButtons\.cs" "\$OUT\/buttons\/EraButtons\.cs"/);
});

test('the payload ships no PowerShell file, and the buttons folder holds only the source', () => {
  const lines = PAYLOAD.split('\n').filter((l) => /^\s*(cp|install|rsync|tar)\b/.test(l));
  assert.deepEqual(lines.filter((l) => /\.ps1\b/i.test(l)), [], 'no .ps1 is copied into the payload');
  const shipped = fs.readdirSync(path.join(HUB, 'buttons'));
  assert.deepEqual(shipped.filter((f) => /\.ps1$/i.test(f)), []);
  assert.ok(shipped.includes('EraButtons.cs'));
});

test('the listener never starts PowerShell or any other program, and writes no files', () => {
  assert.doesNotMatch(SRC, /powershell/i);
  assert.doesNotMatch(CODE, /Process\.Start|ProcessStartInfo|cmd\.exe/);
  assert.doesNotMatch(CODE, /File\.|FileStream|StreamWriter|Registry/);
  assert.doesNotMatch(CODE, /NotifyIcon|\.Show\(|new Form\b|MessageBox/, 'no window, no tray');
});

test('the five keys, their hotkey ids 1-5, MOD_NOREPEAT, and the hub KEYS table agree', () => {
  const names = JSON.parse('[' + /Names = \{([^}]*)\}/.exec(CODE)[1] + ']');
  const actions = JSON.parse('[' + /Actions = \{([^}]*)\}/.exec(CODE)[1] + ']');
  assert.deepEqual(names, ['F13', 'F14', 'Ctrl+Alt+F9', 'Ctrl+Alt+F10', 'Ctrl+Alt+F11']);
  assert.deepEqual(Object.fromEntries(names.map((n, i) => [n, actions[i]])), { ...KEYS });
  assert.match(CODE, /Ids = \{ 1, 2, 3, 4, 5 \}/);
  assert.match(CODE, /Vks = \{ VK_F13, VK_F14, VK_F9, VK_F10, VK_F11 \}/);
  assert.match(CODE, /Mods = \{ 0, 0, MOD_CONTROL \| MOD_ALT, MOD_CONTROL \| MOD_ALT, MOD_CONTROL \| MOD_ALT \}/);
  for (const [vk, code] of [['VK_F9', '0x78'], ['VK_F10', '0x79'], ['VK_F11', '0x7A'], ['VK_F13', '0x7C'], ['VK_F14', '0x7D'],
    ['MOD_ALT', '0x0001'], ['MOD_CONTROL', '0x0002'], ['MOD_NOREPEAT', '0x4000'], ['WM_HOTKEY', '0x0312']])
    assert.match(CODE, new RegExp(`const (?:uint|int) ${vk} = ${code};`), vk);
  assert.match(CODE, /RegisterHotKey\(window\.Handle, Ids\[i\], Mods\[i\] \| MOD_NOREPEAT, Vks\[i\]\)/);
});

test('one loopback POST per press with a 2 s timeout; one registration line; single instance; leaves with the hub', () => {
  assert.match(CODE, /"http:\/\/127\.0\.0\.1:" \+ port \+ "\/buttons\/press"/);
  assert.match(CODE, /req\.Method = "POST";/);
  assert.match(CODE, /req\.ContentType = "application\/json";/);
  assert.match(CODE, /req\.Timeout = 2000;/);
  assert.match(CODE, /\{\\"key\\":\\"" \+ key \+ "\\",\\"action\\":\\"" \+ action \+ "\\"\}/);
  assert.match(CODE, /QueueUserWorkItem/, 'fire and forget, off the message loop');
  assert.equal(CODE.match(/Console\.Out\.WriteLine/g).length, 1, 'exactly one line on stdout');
  assert.match(CODE, /\{\\"registered\\":" \+ JsonList\(registered\) \+ ",\\"failed\\":" \+ JsonList\(failed\) \+ "\}/);
  assert.match(CODE, /new Mutex\(false, "Local\\\\OurEraComms\.Buttons"\)/);
  assert.match(CODE, /WaitOne\(5000\)/);
  assert.match(CODE, /if \(!owned\) return 3;/);
  assert.match(CODE, /hubWatch\.Interval = 2000;/);
  assert.match(CODE, /new IntPtr\(-3\)/, 'a message-only window (HWND_MESSAGE)');
  assert.doesNotMatch(CODE, /\$"|=>/, 'C# 5 for the .NET Framework csc: no interpolation, no lambdas-as-members');
});
