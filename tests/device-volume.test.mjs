import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the Settings handlers against the device endpoint contract.
function setup(reply, ok = true) {
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, value: '', textContent: '' });
    return elements.get(id);
  };
  const requests = [];
  const context = vm.createContext({ $, ENGINE: 'http://device', Number,
    document: { querySelectorAll: () => [], querySelector: () => null },
    toast() {}, seg() {},
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok, json: async () => reply };
    }
  });
  const html = fs.readFileSync(new URL('../public/settings/index.html', import.meta.url), 'utf8');
  vm.runInContext(html.slice(html.indexOf('function volcapPaint('), html.indexOf('// ---- Pause eye-gaze')), context);
  return { $, context, requests };
}

test('device limit loads without a legacy watchdog and saves only to the local engine', async () => {
  const state = { installed: false, integrated: { enabled: true, cap: 30 } };
  const { $, context, requests } = setup(state);
  context.volcapPaint(state);
  assert.equal($('deviceVolumeControls').style.display, 'block');
  assert.equal($('deviceVolumeCap').value, 30);
  $('deviceVolumeCap').valueAsNumber = 30;
  await $('deviceVolumeSave').onclick();
  assert.deepEqual(requests, [{ url: 'http://device/volcap', body: { integratedEnabled: true, integratedCap: 30 } }]);
  assert.match($('deviceVolumeStatus').textContent, /Saved on this device: 30%/);
});

test('invalid percentages and unsuccessful saves never report success', async () => {
  const { $, requests } = setup({}, false);
  for (const cap of [NaN, -1, 101, 1.5]) {
    $('deviceVolumeCap').valueAsNumber = cap;
    await $('deviceVolumeSave').onclick();
  }
  assert.equal(requests.length, 0);
  $('deviceVolumeCap').valueAsNumber = 25;
  await $('deviceVolumeSave').onclick();
  assert.match($('deviceVolumeStatus').textContent, /Could not save/);
  assert.equal($('deviceVolumeSave').disabled, false);
});

test('legacy ceiling remains visible and unavailable engines hide the new controls', () => {
  const { $, context } = setup({});
  context.volcapPaint({ installed: true, running: true, cap: 45, integrated: { enabled: false, cap: 55 } });
  assert.equal($('deviceVolumeCap').value, 45);
  assert.match($('deviceVolumeStatus').textContent, /also limits volume to 45%/);
  context.volcapPaint(null);
  assert.equal($('deviceVolumeControls').style.display, 'none');
});
