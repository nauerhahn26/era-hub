// The QA guest's REAL desktop mode, set by native-display.cs (EnumDisplaySettings /
// ChangeDisplaySettings, this boot only) — never browser viewport emulation.
// vm.nativeDisplay() drives it; this module is the pure contract, checked without a
// VM by tests-vm/native-display.test.mjs.
//
// Why: the pristine template boots Windows at 1024x768, smaller than any family
// screen (TD I-13 1920x1080, the tablet 2736x1824) and smaller than Chat's
// smallest supported viewport (tests/chat-symbols.test.mjs: 1280x800 and
// 1600x1000). There "Reactions" is 210 px wide at the 44 px floor in a 208 px
// label box, so leg B's Chat check failed on every run that did not first set the
// mode (10/26: v1.0.21 and v1.0.22 red twice; green at 1280x800 three times the
// same day, which is the mode Chat's and Games' Windows proofs ran at).
import assert from "node:assert/strict";

export const NATIVE_DISPLAY = Object.freeze({ width: 1280, height: 800 });

const size = (m) => (m && Number.isFinite(m.width) && Number.isFinite(m.height) ? `${m.width}x${m.height}` : "?");

/** raw = the helper's JSON text, exit = its process exit code as the guest wrote it.
 *  Returns the parsed report; throws with the helper's own reason otherwise. */
export function checkNativeDisplay(raw, { width, height, exit }) {
  const want = `${width}x${height}`;
  let r;
  try { r = JSON.parse(raw); } catch { r = null; }
  assert.ok(r && typeof r === "object", `native display helper wrote no valid JSON (exit ${String(exit).trim()})`);
  const modes = Array.isArray(r.modes) ? r.modes.map(size).join(", ") : "not listed";
  const why = r.error ? `: ${r.error}` : "";
  assert.equal(String(exit).trim(), "0", `native display helper exited ${String(exit).trim()}${why} (modes Windows offers: ${modes})`);
  assert.ok(r.ok === true && r.exitCode === 0, `native display helper reports failure${why} (modes Windows offers: ${modes})`);
  assert.equal(size(r.target), want, `native display helper asked for ${size(r.target)}, not ${want}`);
  assert.equal(r.applyCode, 0, `native display helper applyCode ${r.applyCode}`);
  assert.equal(size(r.after), want, `Windows reads back ${size(r.after)} after the change, not ${want}`);
  return r;
}
