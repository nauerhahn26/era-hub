import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise Settings against the unified device endpoint contract.
function setup(reply, ok = true) {
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, value: '', textContent: '',
      classList: { toggle() {} }, setAttribute() {},
    });
    return elements.get(id);
  };
  const requests = [];
  const context = vm.createContext({ $, ENGINE: 'http://device', Number,
    toast() {},
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok, json: async () => typeof reply === 'function' ? reply(requests.at(-1).body) : reply };
    },
  });
  const html = fs.readFileSync(new URL('../public/settings/index.html', import.meta.url), 'utf8');
  vm.runInContext(html.slice(html.indexOf('let deviceVolumeEnabled ='), html.indexOf('// ---- Pause eye-gaze')), context);
  return { $, context, requests };
}
const echo = body => ({ device: { enabled: body.deviceEnabled, cap: body.deviceCap } });

test('device cap increases above 45, decreases, and saves only to the local engine', async () => {
  const { $, context, requests } = setup(echo);
  context.volcapPaint({ device: { enabled: true, cap: 45 } });
  assert.equal($('deviceVolumeControls').style.display, 'block');
  assert.equal($('deviceVolumeCap').value, 45);
  for (const cap of [65, 25, 100, 0]) {
    $('deviceVolumeCap').valueAsNumber = cap;
    await $('deviceVolumeSave').onclick();
    assert.deepEqual(requests.at(-1), { url: 'http://device/volcap', body: { deviceEnabled: true, deviceCap: cap } });
    assert.match($('deviceVolumeStatus').textContent, new RegExp('On: maximum '+cap+'%'));
  }
});

test('Off persists, adjusting a disabled cap keeps it off, and On reuses the saved cap', async () => {
  const { $, context, requests } = setup(echo);
  context.volcapPaint({ device: { enabled: true, cap: 45 } });
  $('deviceVolumeCap').valueAsNumber = 45;
  await $('deviceVolumeOff').onclick();
  assert.match($('deviceVolumeStatus').textContent, /Off: no speaker limit/);
  $('deviceVolumeCap').valueAsNumber = 75;
  await $('deviceVolumeSave').onclick();
  assert.deepEqual(requests.at(-1).body, { deviceEnabled: false, deviceCap: 75 });
  // Reopen Settings: state comes from the device, never a shared preference.
  context.volcapPaint({ device: { enabled: false, cap: 75 } });
  await $('deviceVolumeOn').onclick();
  assert.deepEqual(requests.at(-1).body, { deviceEnabled: true, deviceCap: 75 });
});

test('invalid percentages and unsuccessful or unconfirmed saves never report success', async () => {
  for (const [reply, ok] of [[{}, false], [{ device: { enabled: true, cap: 45 } }, true]]) {
    const { $, requests } = setup(reply, ok);
    for (const cap of [NaN, -1, 101, 1.5]) {
      $('deviceVolumeCap').valueAsNumber = cap;
      await $('deviceVolumeOn').onclick();
    }
    assert.equal(requests.length, 0);
    $('deviceVolumeCap').valueAsNumber = 25;
    await $('deviceVolumeOn').onclick();
    assert.match($('deviceVolumeStatus').textContent, /Could not save/);
    assert.equal($('deviceVolumeSave').disabled, false);
    assert.equal($('deviceVolumeOff').disabled, false);
  }
});

test('old or unavailable engines cannot offer a misleading control', () => {
  const { $, context } = setup({});
  context.volcapPaint({ installed: true, running: true, cap: 45, integrated: { enabled: false, cap: 55 } });
  assert.equal($('deviceVolumeControls').style.display, 'none');
  assert.match($('deviceVolumeStatus').textContent, /Update or restart/);
  context.volcapPaint(null);
  assert.equal($('deviceVolumeControls').style.display, 'none');
});
