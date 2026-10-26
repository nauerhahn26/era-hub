// Helper contract for vm.nativeDisplay(): what the guest's native-display.exe
// reports must prove Windows itself now runs the requested desktop mode.
// Run: node --test tests-vm/native-display.test.mjs (outside the flat Linux gate,
// like tests-vm/chat-ui-smoke.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_DISPLAY, checkNativeDisplay } from './lib/native-display.mjs';

const mode = (width, height) => ({ width, height, bpp: 32, hz: 64 });
const modes = [mode(640, 480), mode(800, 600), mode(1024, 768), mode(1280, 800), mode(1920, 1080)];
const good = (extra = {}) => JSON.stringify({ ok: true, exitCode: 0, target: { width: 1280, height: 800 }, structSize: 220,
  before: mode(1024, 768), modes, attempts: [{ bpp: 32, hz: 64, fields: 1572864, testCode: 0 }], applyCode: 0, after: mode(1280, 800), ...extra });
const target = { width: 1280, height: 800, exit: '0' };

test('leg B runs on a 1280x800 desktop: the smallest supported Chat viewport and the mode Chat and Games qualified at', () => {
  assert.deepEqual(NATIVE_DISPLAY, { width: 1280, height: 800 });
});

test('a helper report whose Windows readback matches the request is accepted and returned', () => {
  const result = checkNativeDisplay(good(), target);
  assert.deepEqual(result.before, mode(1024, 768));
  assert.deepEqual(result.after, mode(1280, 800));
});

test('re-applying the mode already in force (a preparation ran first) is accepted', () => {
  assert.equal(checkNativeDisplay(good({ before: mode(1280, 800) }), target).after.width, 1280);
});

test('no JSON, a non-zero exit, a helper error or a readback that differs is refused with the reason', () => {
  assert.throws(() => checkNativeDisplay('', target), /no valid JSON.*exit 0/);
  assert.throws(() => checkNativeDisplay(good(), { ...target, exit: '1' }), /exited 1/);
  assert.throws(() => checkNativeDisplay(JSON.stringify({ ok: false, exitCode: 1, error: '1280x800 is not an enumerated mode that passes CDS_TEST; nothing applied', modes: [mode(1024, 768)] }), { ...target, exit: '1' }),
    error => /not an enumerated mode/.test(error.message) && /1024x768/.test(error.message));
  assert.throws(() => checkNativeDisplay(good({ applyCode: -2 }), target), /applyCode -2/);
  assert.throws(() => checkNativeDisplay(good({ after: mode(1024, 768) }), target), /reads back 1024x768.*not 1280x800/);
  assert.throws(() => checkNativeDisplay(good({ target: { width: 1920, height: 1080 } }), target), /asked for 1920x1080/);
});
